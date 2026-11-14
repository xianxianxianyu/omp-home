#!/usr/bin/env node
/**
 * Stand-in for `omp --mode rpc-ui` (select with OMP_HOME_OMP_BIN): JSONL RPC on stdio plus the
 * omp-home bridge WebSocket, no model. Messages persist in `<session-dir>/fake-session.jsonl`
 * and come back through `get_messages_page` after `--resume`.
 *
 * Human prompts (RPC `prompt`): main echoes, except these markers in the text
 *   [fake:ask]              a select dialog; the turn answers "PICKED <value>"
 *   [fake:hang]             the turn runs until `abort`
 *   [fake:subagent]         a `task` subagent "Pinger" runs to completion with its own events
 *   [fake:subagent-hang]    a detached subagent "Sleeper" runs until `cancel_subagent` (takes `steer_subagent`)
 * Agent actions (what main's model would do) are lines appended to `<session-dir>/fake-agent.txt`:
 *   /dispatch <json>        home_dispatch as a fresh dispatcher subagent
 *   /call <tool> <json>     any tool as the main agent
 * Each runs as a turn ending in an assistant line "RESULT ok|err ...".
 * Worker role: every prompt runs one turn that calls home_report, shaped by markers
 * [fake:question] [fake:noreport] [fake:hang] (until abort) [fake:env] (home_env + home_lease)
 * [fake:intents] (tools "Step one" for 1.2 s, then "Step two" for 1.5 s, before reporting).
 * FAKE_OMP_START_DELAY_MS: like real omp's slow first launch, nothing is read or written until then.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { toolsFor } from "../shared/tools.ts";

type Json = Record<string, unknown>;

const { values } = parseArgs({
	options: {
		version: { type: "boolean" },
		mode: { type: "string" },
		cwd: { type: "string" },
		"session-dir": { type: "string" },
		config: { type: "string" },
		extension: { type: "string", short: "e", multiple: true },
		model: { type: "string" },
		thinking: { type: "string" },
		"approval-mode": { type: "string" },
		"no-title": { type: "boolean" },
		resume: { type: "string" },
	},
	strict: true,
});
if (values.version) {
	process.stdout.write("omp/0.0.0-fake\n");
	process.exit(0);
}

const role = process.env.OMP_HOME_ROLE === "worker" ? "worker" : "main";
const session = process.env.OMP_HOME_SESSION!;
const sessionDir = values["session-dir"]!;
fs.mkdirSync(sessionDir, { recursive: true });
const stateFile = path.join(sessionDir, "fake-state.json");
const state: { ompSessionId: string; delivered: number[]; agentOffset: number } = {
	ompSessionId: randomUUID(),
	delivered: [],
	agentOffset: 0,
	...(fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as object) : {}),
};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
save();
const historyFile = path.join(sessionDir, "fake-session.jsonl");
const agentFile = path.join(sessionDir, "fake-agent.txt");
const history: Json[] = fs.existsSync(historyFile)
	? fs
			.readFileSync(historyFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Json)
	: [];

const startDelay = Number(process.env.FAKE_OMP_START_DELAY_MS ?? 0);
if (startDelay) await sleep(startDelay);

const out = (frame: Json) => process.stdout.write(`${JSON.stringify(frame)}\n`);
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });
out({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "fake", statusText: `FAKE ${role} ${session} up resume=${values.resume ? "yes" : "no"} model=${values.model ?? "default"}` });

let ws: WebSocket | null = null;
let seq = 0;
let msgSeq = 0;
let dispatchers = 0;
let running = false;
let turns: Promise<void> = Promise.resolve();
let abortRun: (() => void) | null = null;
const results = new Map<string, (frame: Json) => void>();
const dialogs = new Map<string, (answer: string) => void>();
const subagents = new Map<string, { steer(text: string): void; cancel(): void }>();
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } };
const MAIN_AGENT = { kind: "main" as const, id: "main", name: "main" };

function send(frame: Json): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function call(tool: string, params: unknown, agent: { kind: "main" | "sub"; id: string; name: string }): Promise<Json> {
	const callId = randomUUID();
	const { promise, resolve } = Promise.withResolvers<Json>();
	results.set(callId, resolve);
	send({ t: "call", callId, tool, params, agent });
	return promise;
}

function capture(kind: "user" | "assistant" | "notice", text: string): void {
	if (role === "main") send({ t: "capture", key: randomUUID(), role: kind, text, raw: JSON.stringify({ role: kind, text }), at: Date.now() });
}

/** A session event, or (with `sub`) the same event of a subagent: no messageId, wrapped in subagent_event. */
function emit(event: Json, sub: string | null): void {
	if (sub) {
		const { messageId: _, ...nested } = event;
		out({ type: "subagent_event", payload: { id: sub, event: nested } });
	} else out(event);
}

function message(msg: Json, sub: string | null = null): void {
	const messageId = `msg-${++msgSeq}`;
	emit({ type: "message_start", message: msg, messageId }, sub);
	emit({ type: "message_end", message: msg, messageId }, sub);
	if (!sub) {
		history.push(msg);
		fs.appendFileSync(historyFile, `${JSON.stringify(msg)}\n`);
	}
}

function user(text: string, attribution: "user" | "agent" = "user", sub: string | null = null): void {
	message({ role: "user", content: [{ type: "text", text }], attribution, timestamp: Date.now() }, sub);
	if (!sub) capture("user", text);
}

function assistant(text: string, stopReason = "stop", sub: string | null = null): void {
	const messageId = `msg-${++msgSeq}`;
	const base = { role: "assistant", content: [], model: "fake-model", usage: USAGE, stopReason, timestamp: Date.now() };
	emit({ type: "message_start", message: base, messageId }, sub);
	emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 }, message: base, messageId }, sub);
	const half = Math.ceil(text.length / 2);
	for (const delta of [text.slice(0, half), text.slice(half)]) {
		if (delta) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta }, message: base, messageId }, sub);
	}
	const final = { ...base, content: [{ type: "text", text }] };
	emit({ type: "message_end", message: final, messageId }, sub);
	if (!sub) {
		history.push(final);
		fs.appendFileSync(historyFile, `${JSON.stringify(final)}\n`);
		capture("assistant", text);
	}
}

/** One tool call as omp shows it: assistant toolCall, execution start/end, tool result message. */
async function toolCall(name: string, args: Json, run: () => Promise<{ text: string; isError: boolean }>, sub: string | null = null, intent = `Calling ${name}`): Promise<{ text: string; isError: boolean }> {
	const id = randomUUID();
	const block = { type: "toolCall", id, name, arguments: args, intent };
	const messageId = `msg-${++msgSeq}`;
	const msg = { role: "assistant", content: [block], model: "fake-model", usage: USAGE, stopReason: "toolUse", timestamp: Date.now() };
	emit({ type: "message_start", message: { ...msg, content: [] }, messageId }, sub);
	emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 }, message: msg, messageId }, sub);
	emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: block }, message: msg, messageId }, sub);
	emit({ type: "message_end", message: msg, messageId }, sub);
	if (!sub) {
		history.push(msg);
		fs.appendFileSync(historyFile, `${JSON.stringify(msg)}\n`);
	}
	emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args, intent }, sub);
	const result = await run();
	emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: result.text }] }, isError: result.isError }, sub);
	message({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: result.text }], isError: result.isError, timestamp: Date.now() }, sub);
	return result;
}

function hubTool(tool: string, params: unknown, agent: { kind: "main" | "sub"; id: string; name: string }): () => Promise<{ text: string; isError: boolean }> {
	return async () => {
		const r = await call(tool, params, agent);
		return r.ok ? { text: String(r.text), isError: false } : { text: `[${String(r.code)}] ${String(r.message)}`, isError: true };
	};
}

/** One top-level run; runs are sequential like omp follow-ups. */
function turn(body: (signal: AbortSignal) => Promise<{ stop: "completed" | "aborted"; text: string }>): void {
	turns = turns.then(async () => {
		const n = ++seq;
		const controller = new AbortController();
		abortRun = () => controller.abort();
		running = true;
		send({ t: "run_start", seq: n });
		out({ type: "agent_start" });
		out({ type: "turn_start" });
		const { stop, text } = await body(controller.signal);
		abortRun = null;
		running = false;
		out({ type: "turn_end" });
		out({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
		send({ t: "run_end", seq: n, stop, text, asyncJobs: 0 });
		out({ type: "session_settled" });
	});
}

function untilAborted(signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted) resolve();
	signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

function dialog(request: Json): Promise<string> {
	const id = randomUUID().slice(0, 16);
	const { promise, resolve } = Promise.withResolvers<string>();
	dialogs.set(id, resolve);
	out({ type: "extension_ui_request", id, ...request });
	return promise;
}

function startSubagent(id: string, task: string, parentToolCallId: string): void {
	out({ type: "subagent_lifecycle", payload: { id, agent: "sonic", agentSource: "bundled", parentToolCallId, status: "started", index: 0, detached: true } });
	out({ type: "subagent_progress", payload: { index: 0, agent: "sonic", agentSource: "bundled", task, assignment: task, parentToolCallId, progress: { id, status: "running", lastIntent: `Working on ${id}` } } });
	emit({ type: "agent_start" }, id);
	user(task, "agent", id);
}

function endSubagent(id: string, status: "completed" | "aborted", parentToolCallId: string): void {
	emit({ type: "agent_end", messages: [], isTerminal: true, yielded: true }, id);
	out({ type: "subagent_lifecycle", payload: { id, agent: "sonic", agentSource: "bundled", parentToolCallId, status, index: 0, detached: true } });
}

function workerTurn(prompt: string): void {
	turn(async signal => {
		user(prompt);
		if (prompt.includes("[fake:hang]")) {
			await toolCall("bash", { command: "sleep infinity" }, async () => {
				await untilAborted(signal);
				return { text: "aborted", isError: true };
			}, null, "Waiting for the human");
			assistant("aborted while hanging", "aborted");
			return { stop: "aborted", text: "aborted while hanging" };
		}
		if (prompt.includes("[fake:noreport]")) {
			assistant("finished without a report");
			return { stop: "completed", text: "finished without a report" };
		}
		if (prompt.includes("[fake:intents]")) {
			for (const [intent, ms] of [["Step one", 1200], ["Step two", 1500]] as const) {
				await toolCall("bash", { command: "true" }, async () => {
					await sleep(ms);
					return { text: "ok", isError: false };
				}, null, intent);
			}
		}
		let probe = "";
		if (prompt.includes("[fake:env]")) {
			const env = await toolCall("home_env", {}, hubTool("home_env", {}, MAIN_AGENT));
			const lease = await toolCall("home_lease", { pool: "testers" }, hubTool("home_lease", { pool: "testers" }, MAIN_AGENT));
			probe = `\nENV ${env.text}\nLEASE ${lease.text}`;
		}
		const question = prompt.includes("[fake:question]") && !prompt.includes("message from the home agent");
		const report = question
			? { status: "question", summary: "Keep the legacy column? A keep one release, B drop now" }
			: { status: "done", summary: `fake done in ${path.basename(process.cwd())}`, details: `PORT=${process.env.PORT ?? ""} BRANCH=${process.env.TASK_BRANCH ?? ""} hooks=${process.env.GIT_CONFIG_VALUE_0 ?? ""}${probe}` };
		await toolCall("home_report", report, hubTool("home_report", report, MAIN_AGENT));
		const text = question ? "Question: keep the legacy column?" : "All done.";
		assistant(text);
		return { stop: "completed", text };
	});
}

function mainPrompt(text: string): void {
	turn(async signal => {
		user(text);
		if (text.includes("[fake:ask]")) {
			const answer = await dialog({ method: "select", title: "Pick a color", options: ["Red", "Blue"] });
			assistant(`PICKED ${answer}`);
			return { stop: "completed", text: `PICKED ${answer}` };
		}
		if (text.includes("[fake:hang]")) {
			await untilAborted(signal);
			assistant("aborted while hanging", "aborted");
			return { stop: "aborted", text: "aborted while hanging" };
		}
		if (text.includes("[fake:subagent-hang]")) {
			await toolCall("task", { tasks: [{ name: "Sleeper" }] }, async () => {
				const parent = "task-sleeper";
				startSubagent("Sleeper", "Sleep until cancelled.", parent);
				subagents.set("Sleeper", {
					steer: steer => user(steer, "user", "Sleeper"),
					cancel: () => {
						subagents.delete("Sleeper");
						endSubagent("Sleeper", "aborted", parent);
					},
				});
				return { text: "Running background task Sleeper...", isError: false };
			});
			assistant("SUBAGENT running");
			return { stop: "completed", text: "SUBAGENT running" };
		}
		if (text.includes("[fake:subagent]")) {
			await toolCall("task", { tasks: [{ name: "Pinger" }] }, async () => {
				const parent = "task-pinger";
				startSubagent("Pinger", "Write hello-irc to agent://Main, then reply PINGED.", parent);
				await toolCall("write", { path: "agent://Main", content: "hello-irc" }, async () => ({ text: "Delivered to Main.", isError: false }), "Pinger");
				assistant("PINGED", "stop", "Pinger");
				endSubagent("Pinger", "completed", parent);
				return { text: "Pinger completed: PINGED", isError: false };
			});
			assistant("SUBAGENT done");
			return { stop: "completed", text: "SUBAGENT done" };
		}
		if (signal.aborted) return { stop: "aborted", text: "" };
		assistant(`echo: ${text}`);
		return { stop: "completed", text: `echo: ${text}` };
	});
}

/** What main's model would do: tool calls whose outcome ends the turn as "RESULT ...". */
function agentAction(line: string): void {
	const dispatch = /^\/dispatch\s+(.+)$/.exec(line);
	const tool = /^\/call\s+(\S+)\s+(.+)$/.exec(line);
	if (!dispatch && !tool) return;
	turn(async () => {
		const name = dispatch ? "home_dispatch" : tool![1]!;
		const params = JSON.parse(dispatch ? dispatch[1]! : tool![2]!) as Json;
		const agent = dispatch ? { kind: "sub" as const, id: `dispatcher-${process.pid}-${++dispatchers}`, name: "dispatcher" } : MAIN_AGENT;
		let r: Json = {};
		await toolCall(name, params, async () => {
			r = await call(name, params, agent);
			return { text: String(r.text ?? r.message), isError: !r.ok };
		});
		const text = `RESULT ${r.ok ? "ok" : `err ${String(r.code)}`} ${String(r.text ?? r.message).split("\n")[0]}`;
		assistant(text);
		return { stop: "completed", text };
	});
}

function pollAgentFile(): void {
	if (!fs.existsSync(agentFile)) return;
	const content = fs.readFileSync(agentFile);
	if (content.length <= state.agentOffset) return;
	const fresh = content.subarray(state.agentOffset).toString("utf8");
	const complete = fresh.lastIndexOf("\n");
	if (complete < 0) return;
	state.agentOffset += Buffer.byteLength(fresh.slice(0, complete + 1));
	save();
	for (const line of fresh.slice(0, complete).split("\n")) if (line.trim()) agentAction(line.trim());
}

function deliver(frame: Json): void {
	const outboxId = Number(frame.outboxId);
	const text = String(frame.text);
	const fresh = !state.delivered.includes(outboxId);
	if (fresh) {
		state.delivered.push(outboxId);
		save();
	}
	send({ t: "delivered", outboxId });
	if (!fresh) return;
	if (frame.kind === "notice") {
		message({ role: "custom", customType: "omp-home.notice", content: text, display: true, timestamp: Date.now() });
		capture("notice", text);
		if (frame.deliver === "wake") {
			turn(async () => {
				assistant("Handled the omp-home updates.");
				return { stop: "completed", text: "Handled the omp-home updates." };
			});
		}
		return;
	}
	if (role === "worker") workerTurn(text);
	else {
		turn(async () => {
			user(text);
			assistant("ok");
			return { stop: "completed", text: "ok" };
		});
	}
}

function respond(id: unknown, command: string, data?: unknown): void {
	out({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
}

function fail(id: unknown, command: string, error: string): void {
	out({ type: "response", id, command, success: false, error });
}

function command(frame: Json): void {
	const id = frame.id;
	const type = String(frame.type);
	switch (type) {
		case "set_subagent_subscription":
			return respond(id, type, { level: frame.level });
		case "set_ask_dialog":
			return respond(id, type, { enabled: frame.enabled });
		case "get_available_commands":
			return respond(id, type, { commands: [{ name: "fake-help", description: "What the fake understands", source: "builtin" }] });
		case "get_messages_page": {
			const offset = Number(frame.cursor ?? 0);
			const limit = Number(frame.limit ?? 256);
			const next = offset + limit;
			return respond(id, type, { messages: history.slice(offset, next), totalMessages: history.length, ...(next < history.length ? { nextCursor: String(next) } : {}) });
		}
		case "get_state":
			return respond(id, type, {
				model: { id: values.model ?? "fake-model", provider: "fake" },
				thinkingLevel: values.thinking ?? "high",
				isStreaming: running,
				isCompacting: false,
				isSettled: !running,
				sessionId: state.ompSessionId,
				sessionFile: historyFile,
				messageCount: history.length,
				queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
				contextUsage: { tokens: 1500, contextWindow: 100_000, percent: 1.5 },
				dumpTools: toolsFor(role).map(name => ({ name, description: name })),
			});
		case "prompt":
			respond(id, type, { agentInvoked: true });
			return role === "worker" ? workerTurn(String(frame.message)) : mainPrompt(String(frame.message));
		case "abort":
			abortRun?.();
			return respond(id, type);
		case "steer_subagent": {
			const sub = subagents.get(String(frame.subagentId));
			if (!sub) return fail(id, type, `subagent ${String(frame.subagentId)} is not running`);
			sub.steer(String(frame.message));
			return respond(id, type);
		}
		case "cancel_subagent": {
			const sub = subagents.get(String(frame.subagentId));
			sub?.cancel();
			return respond(id, type, { cancelled: !!sub });
		}
		case "extension_ui_response": {
			const answer = typeof frame.value === "string" ? frame.value : frame.cancelled === true ? "(cancelled)" : String(frame.confirmed);
			dialogs.get(String(id))?.(answer);
			dialogs.delete(String(id));
			return;
		}
		default:
			return fail(id, type, `Unknown command: ${type}`);
	}
}

function connect(): void {
	const url = new URL(process.env.OMP_HOME_URL!);
	url.searchParams.set("session", session);
	url.searchParams.set("token", process.env.OMP_HOME_TOKEN!);
	const sock = new WebSocket(url);
	ws = sock;
	sock.addEventListener("open", () => {
		send({ t: "hello", v: 1, ompSessionId: state.ompSessionId, sessionFile: historyFile, cwd: process.cwd() });
	});
	sock.addEventListener("message", event => {
		const frame = JSON.parse(String(event.data)) as Json;
		if (frame.t === "deliver") deliver(frame);
		else if (frame.t === "result") results.get(String(frame.callId))?.(frame);
	});
	sock.addEventListener("close", () => {
		if (ws === sock) setTimeout(connect, 300);
	});
	sock.addEventListener("error", () => {});
}

readline
	.createInterface({ input: process.stdin })
	.on("line", line => {
		if (line.trim()) command(JSON.parse(line) as Json);
	})
	.on("close", () => process.exit(0));

setInterval(pollAgentFile, 50);
connect();
