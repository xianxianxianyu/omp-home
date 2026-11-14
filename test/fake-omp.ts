#!/usr/bin/env node
/**
 * Stand-in for `omp` (select with OMP_HOME_OMP_BIN) that speaks the bridge protocol
 * without a model, so hub tests can drive real processes in real PTYs.
 *
 * Main role: lines typed into its terminal are human input, except
 *   /dispatch <json>         home_dispatch as a fresh dispatcher subagent
 *   /call <tool> <json>      any tool as the main agent
 * Notices are captured and acknowledged; wakes run a short turn.
 * Worker role: every prompt runs one turn that calls home_report, shaped by markers
 * in the prompt: [fake:question] [fake:noreport] [fake:hang] (never ends until abort)
 * [fake:env] (calls home_env and home_lease({pool:"testers"}) and reports what they said).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

type Frame = Record<string, unknown> & { t: string };

const { values } = parseArgs({
	options: {
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

const role = process.env.OMP_HOME_ROLE;
const session = process.env.OMP_HOME_SESSION!;
const sessionDir = values["session-dir"]!;
fs.mkdirSync(sessionDir, { recursive: true });
const stateFile = path.join(sessionDir, "fake-state.json");
const state: { ompSessionId: string; delivered: number[] } = fs.existsSync(stateFile)
	? JSON.parse(fs.readFileSync(stateFile, "utf8"))
	: { ompSessionId: randomUUID(), delivered: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
save();
const sessionFile = path.join(sessionDir, "fake-session.jsonl");
fs.appendFileSync(sessionFile, "");

const print = (line: string) => process.stdout.write(`${line}\r\n`);
print(`FAKE ${role} ${session} up resume=${values.resume ? "yes" : "no"} model=${values.model ?? "default"}`);

let ws: WebSocket | null = null;
let seq = 0;
let dispatchers = 0;
let turns: Promise<void> = Promise.resolve();
let abortRun: (() => void) | null = null;
const results = new Map<string, (frame: Frame) => void>();

function send(frame: Frame): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function call(tool: string, params: unknown, agent: { kind: "main" | "sub"; id: string; name: string }): Promise<Frame> {
	const callId = randomUUID();
	const { promise, resolve } = Promise.withResolvers<Frame>();
	results.set(callId, resolve);
	send({ t: "call", callId, tool, params, agent });
	return promise;
}

const MAIN_AGENT = { kind: "main" as const, id: "main", name: "main" };

function capture(roleName: "user" | "assistant" | "notice", text: string): void {
	if (role === "main") send({ t: "capture", key: randomUUID(), role: roleName, text, raw: JSON.stringify({ role: roleName, text }), at: Date.now() });
}

/** One top-level run; runs are sequential like omp follow-ups. */
function turn(body: (signal: AbortSignal) => Promise<{ stop: "completed" | "aborted"; text: string }>): void {
	turns = turns.then(async () => {
		const n = ++seq;
		const controller = new AbortController();
		abortRun = () => controller.abort();
		send({ t: "run_start", seq: n });
		const { stop, text } = await body(controller.signal);
		abortRun = null;
		send({ t: "run_end", seq: n, stop, text, asyncJobs: 0 });
	});
}

function workerTurn(prompt: string): void {
	turn(async signal => {
		if (prompt.includes("[fake:hang]")) {
			print("WORKER hanging");
			const { promise, resolve } = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			return { stop: "aborted", text: "aborted while hanging" };
		}
		if (prompt.includes("[fake:noreport]")) return { stop: "completed", text: "finished without a report" };
		let probe = "";
		if (prompt.includes("[fake:env]")) {
			const env = await call("home_env", {}, MAIN_AGENT);
			const lease = await call("home_lease", { pool: "testers" }, MAIN_AGENT);
			probe = `\nENV ${String(env.text ?? env.message)}\nLEASE ${String(lease.text ?? lease.message)}`;
		}
		const question = prompt.includes("[fake:question]") && !prompt.includes("message from the home agent");
		const result = await call(
			"home_report",
			question
				? { status: "question", summary: "Keep the legacy column? A keep one release, B drop now" }
				: { status: "done", summary: `fake done in ${path.basename(process.cwd())}`, details: `PORT=${process.env.PORT ?? ""} BRANCH=${process.env.TASK_BRANCH ?? ""} hooks=${process.env.GIT_CONFIG_VALUE_0 ?? ""}${probe}` },
			MAIN_AGENT,
		);
		print(`REPORT ${result.ok ? "ok" : "err"} ${String(result.text ?? result.message)}`);
		return { stop: "completed", text: question ? "Question: keep the legacy column?" : "All done." };
	});
}

function deliver(frame: Frame): void {
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
		print(`NOTICE ${frame.deliver} ${text.split("\n")[0]}`);
		capture("notice", text);
		if (frame.deliver === "wake") {
			turn(async () => {
				capture("assistant", "Handled the omp-home updates.");
				return { stop: "completed", text: "Handled the omp-home updates." };
			});
		}
		return;
	}
	print(`PROMPT ${text.split("\n")[0]}`);
	if (role === "worker") workerTurn(text);
	else {
		turn(async () => {
			capture("user", text);
			capture("assistant", "ok");
			return { stop: "completed", text: "ok" };
		});
	}
}

function connect(): void {
	const url = new URL(process.env.OMP_HOME_URL!);
	url.searchParams.set("session", session);
	url.searchParams.set("token", process.env.OMP_HOME_TOKEN!);
	const sock = new WebSocket(url);
	ws = sock;
	sock.addEventListener("open", () => {
		send({ t: "hello", v: 1, ompSessionId: state.ompSessionId, sessionFile, cwd: process.cwd() });
	});
	sock.addEventListener("message", event => {
		const frame = JSON.parse(String(event.data)) as Frame;
		if (frame.t === "deliver") deliver(frame);
		else if (frame.t === "result") results.get(String(frame.callId))?.(frame);
		else if (frame.t === "abort") abortRun?.();
		else if (frame.t === "shutdown") process.exit(0);
	});
	sock.addEventListener("close", () => {
		if (ws === sock) setTimeout(connect, 300);
	});
	sock.addEventListener("error", () => {});
}

readline.createInterface({ input: process.stdin }).on("line", line => {
	const trimmed = line.trim();
	if (!trimmed) return;
	const dispatch = /^\/dispatch\s+(.+)$/.exec(trimmed);
	const tool = /^\/call\s+(\S+)\s+(.+)$/.exec(trimmed);
	if (role === "main" && dispatch) {
		const agent = { kind: "sub" as const, id: `dispatcher-${process.pid}-${++dispatchers}`, name: "dispatcher" };
		void call("home_dispatch", JSON.parse(dispatch[1]!), agent).then(r => print(`RESULT ${r.ok ? "ok" : `err ${String(r.code)}`} ${String(r.text ?? r.message).split("\n")[0]}`));
		return;
	}
	if (role === "main" && tool) {
		void call(tool[1]!, JSON.parse(tool[2]!), MAIN_AGENT).then(r => print(`RESULT ${r.ok ? "ok" : `err ${String(r.code)}`} ${String(r.text ?? r.message).split("\n")[0]}`));
		return;
	}
	send({ t: "input", text: trimmed });
	if (role === "worker") workerTurn(trimmed);
	else {
		turn(async () => {
			capture("user", trimmed);
			capture("assistant", `echo: ${trimmed}`);
			return { stop: "completed", text: `echo: ${trimmed}` };
		});
	}
});

connect();
