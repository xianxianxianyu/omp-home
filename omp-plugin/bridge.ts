import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";
import { z } from "zod";
import { BRIDGE_ENV, BRIDGE_PROTOCOL, DELIVERED_ENTRY, NOTICE_MESSAGE, type BridgeToHub, type HubToBridge } from "../shared/bridge-wire.ts";
import { mainCheckoutRefusal } from "../shared/main-checkout.ts";
import { audienceOf, HIDDEN_BUILTINS, TOOL_SPECS, toolsFor, type Audience, type ToolName } from "../shared/tools.ts";

const incoming = z.union([
	z.object({ t: z.literal("welcome"), session: z.string() }),
	z.object({ t: z.literal("deliver"), outboxId: z.number().int().positive(), kind: z.enum(["prompt", "notice"]), text: z.string(), deliver: z.enum(["next", "now", "wake", "context"]) }),
	z.object({ t: z.literal("result"), callId: z.string(), ok: z.literal(true), text: z.string(), details: z.unknown().optional() }),
	z.object({ t: z.literal("result"), callId: z.string(), ok: z.literal(false), code: z.string(), message: z.string() }),
	z.object({ t: z.literal("abort") }),
	z.object({ t: z.literal("shutdown") }),
]);

type Result = Extract<HubToBridge, { t: "result" }>;
type Pending = { resolve: (value: Result) => void; reject: (error: Error) => void };

// Factories are rebound for subagents, but their tools share the top-level connection.
let transport: { send: (frame: BridgeToHub) => void; removeCall: (id: string) => void } | undefined;
const pending = new Map<string, Pending>();

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => {
		if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
		return [part.text];
	}).join("");
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

// Guardrails, not containment: arbitrary code can construct or disguise these commands.
async function forbidden(command: string, cwd: string, pi: ExtensionAPI, protectedBranches: readonly string[], mainCheckout: boolean): Promise<string | undefined> {
	const words = command.replace(/\\\r?\n/g, " ").replace(/["'`,\[\]]/g, " ");
	if (mainCheckout) {
		const refused = mainCheckoutRefusal(command);
		if (refused) return refused;
	}
	const git = /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|--(?:git-dir|work-tree)=\S+\s+)*(push|branch|merge|rebase|reset|tag|update-ref)\b([^;&|\n]*)/g;
	for (const match of words.matchAll(git)) {
		const [, operation, args] = match;
		if (operation === "push") return "Pushing (including remote deletion) is the human's decision.";
		if ((operation === "branch" || operation === "tag" || operation === "update-ref") && /(?:^|\s)(?:--delete(?:\s|$)|-[a-zA-Z]*[dD][a-zA-Z]*(?:\s|$))/.test(args)) return "Deleting branches, tags or refs is the human's decision.";
		if (operation === "reset" && /(?:^|\s)--hard(?:\s|$)/.test(args) && /(?:^|\s)(?:refs\/remotes\/)?origin\//.test(args)) return "Hard-resetting to a remote ref is the human's decision.";
		if (operation === "merge" || operation === "rebase") {
			if (/^\s*--(?:abort|continue|skip|quit)\s*$/.test(args)) continue;
			const directory = /\bgit\s+-C\s+(\S+)/.exec(match[0])?.[1];
			const branch = await pi.exec("git", ["-C", directory ? resolve(cwd, directory) : cwd, "branch", "--show-current"]);
			const refs = args.split(/\s+|=/).map(ref => ref.replace(/^(?:refs\/heads\/|refs\/remotes\/)?(?:origin\/)?/, ""));
			if (protectedBranches.includes(branch.stdout.trim()) || refs.some(ref => protectedBranches.includes(ref)) || protectedBranches.some(ref => new RegExp(`\\b(?:checkout|switch)\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|[;&|]|$)`).test(words))) return "Merging or rebasing on or into a protected branch requires the human.";
		}
	}
	if (/\bgh\s+(?:--repo\s+\S+\s+|-R\s+\S+\s+)*pr\s+(?:merge|create)\b/.test(words)) return "Creating or merging a PR is the human's decision.";
	return undefined;
}

export default function bridge(pi: ExtensionAPI) {
	const role = z.enum(["main", "worker"]).parse(process.env[BRIDGE_ENV.role]);
	const audiences: readonly Audience[] = role === "main" ? ["main", "dispatcher", "main_sub"] : ["worker", "worker_sub"];
	const protectedBranches = (process.env[BRIDGE_ENV.protectedBranches] ?? "").split(",").map(branch => branch.trim()).filter(Boolean);
	const mainCheckout = process.env[BRIDGE_ENV.mainCheckout] === "1";
	let owner: ExtensionContext | undefined;
	let socket: WebSocket | undefined;
	let reconnect: NodeJS.Timeout | undefined;
	let closed = false;
	let backoff = 250;
	let seq = 0;
	let deliveries = Promise.resolve();
	const queue: BridgeToHub[] = [];
	const warn = (message: string) => owner?.ui.notify(`omp-home: ${message}`, "error");
	const send = (frame: BridgeToHub) => {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(frame));
			return;
		}
		if (queue.length === 512) {
			warn("hub disconnected; outgoing buffer is full. Restore the hub before continuing.");
			throw new Error("omp-home hub unreachable");
		}
		queue.push(frame);
	};

	for (const name of Object.keys(TOOL_SPECS) as ToolName[]) {
		const spec = TOOL_SPECS[name];
		if (!(spec.audience as readonly Audience[]).some(audience => audiences.includes(audience))) continue;
		pi.registerTool({
			name,
			label: name,
			description: spec.description,
			parameters: pi.typebox.Type.Unsafe(z.toJSONSchema(spec.params)),
			loadMode: "essential",
			async execute(callId, params, signal, _onUpdate, ctx) {
				if (!toolsFor(audienceOf(role, ctx.agent)).includes(name)) throw new Error("This omp-home tool is not available to this agent.");
				const parsed = spec.params.parse(params);
				if (!transport) throw new Error("omp-home hub unreachable");
				const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Result>();
				const finish = (error?: Error, value?: Result) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					pending.delete(callId);
					transport?.removeCall(callId);
					if (error) reject(error);
					else if (value) resolveResult(value);
				};
				const timer = setTimeout(() => finish(new Error("omp-home hub unreachable")), 60_000);
				const abort = () => finish(new Error("omp-home call aborted"));
				pending.set(callId, { resolve: value => finish(undefined, value), reject: error => finish(error) });
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				else {
					try { transport.send({ t: "call", callId, tool: name, params: parsed, agent: ctx.agent }); }
					catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
				}
				const result = await promise;
				if (!result.ok) throw new Error(`[${result.code}] ${result.message}`);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		});
	}

	async function receive(frame: HubToBridge, ctx: ExtensionContext) {
		switch (frame.t) {
			case "welcome": return;
			case "result": pending.get(frame.callId)?.resolve(frame); return;
			case "abort": await ctx.abort(); return;
			case "shutdown":
				closed = true;
				if (typeof ctx.shutdown === "function") ctx.shutdown();
				else process.kill(process.pid, "SIGTERM");
				return;
			case "deliver": {
				const delivered = ctx.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === DELIVERED_ENTRY && record(entry.data).outboxId === frame.outboxId);
				if (!delivered) {
					if (frame.kind === "prompt") {
						if (frame.deliver === "now") pi.sendUserMessage(frame.text, { deliverAs: "steer" });
						else if (ctx.isIdle()) pi.sendUserMessage(frame.text);
						else pi.sendUserMessage(frame.text, { deliverAs: "followUp" });
					} else {
						pi.sendMessage({ customType: NOTICE_MESSAGE, content: frame.text, display: true }, frame.deliver === "wake" ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" });
					}
					pi.appendEntry(DELIVERED_ENTRY, { outboxId: frame.outboxId });
				}
				send({ t: "delivered", outboxId: frame.outboxId });
			}
		}
	}

	function connect(ctx: ExtensionContext) {
		if (closed) return;
		const url = new URL(z.string().min(1).parse(process.env[BRIDGE_ENV.url]));
		url.searchParams.set("session", z.string().min(1).parse(process.env[BRIDGE_ENV.session]));
		url.searchParams.set("token", z.string().min(1).parse(process.env[BRIDGE_ENV.token]));
		const ws = new WebSocket(url);
		socket = ws;
		ws.addEventListener("open", () => {
			backoff = 250;
			ws.send(JSON.stringify({ t: "hello", v: BRIDGE_PROTOCOL, ompSessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null, cwd: ctx.cwd } satisfies BridgeToHub));
			for (const frame of queue.splice(0)) send(frame);
		});
		ws.addEventListener("message", event => {
			let frame: HubToBridge;
			try { frame = incoming.parse(JSON.parse(String(event.data))); }
			catch (error) { warn(`invalid hub frame: ${String(error)}`); return; }
			if (frame.t === "deliver") {
				deliveries = deliveries.then(() => receive(frame, ctx)).catch(error => warn(String(error)));
			} else void receive(frame, ctx).catch(error => warn(String(error)));
		});
		ws.addEventListener("error", () => ws.close());
		ws.addEventListener("close", () => {
			if (socket === ws) socket = undefined;
			if (closed) return;
			reconnect = ctx.setTimeout(() => connect(ctx), backoff);
			backoff = Math.min(backoff * 2, 10_000);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const allowed = new Set(toolsFor(audienceOf(role, ctx.agent)));
		await pi.setActiveTools(pi.getActiveTools().filter(name => !HIDDEN_BUILTINS[role].includes(name) && (!(name in TOOL_SPECS) || allowed.has(name as ToolName))));
		if (ctx.agent.kind !== "main") return;
		owner = ctx;
		closed = false;
		transport = { send, removeCall: id => { const index = queue.findIndex(frame => frame.t === "call" && frame.callId === id); if (index !== -1) queue.splice(index, 1); } };
		connect(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		closed = true;
		if (reconnect) ctx.clearTimer(reconnect);
		socket?.close();
		transport = undefined;
		for (const request of pending.values()) request.reject(new Error("omp-home hub unreachable"));
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind === "main") send({ t: "run_start", seq: ++seq });
	});
	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.willContinue) return;
		const last = event.messages.findLast(message => message.role === "assistant");
		const reason = last?.stopReason;
		const stop = reason === "aborted" ? "aborted" : reason === "stop" || reason === "toolUse" ? "completed" : "error";
		send({ t: "run_end", seq, stop, text: textOf(last?.content), ...(stop === "error" ? { error: last?.errorMessage ?? `omp stopped: ${reason ?? "no assistant message"}` } : {}), asyncJobs: ctx.getAsyncJobSnapshot()?.running.length ?? 0 });
	});
	pi.on("input", (event, ctx) => {
		if (ctx.agent.kind === "main" && event.source === "interactive") send({ t: "input", text: event.text });
	});
	pi.on("message_end", (event, ctx) => {
		if (role !== "main" || ctx.agent.kind !== "main") return;
		const message = record(event.message);
		const messageRole = message.role === "user" || message.role === "assistant" ? message.role : message.customType === NOTICE_MESSAGE ? "notice" : undefined;
		if (!messageRole) return;
		const raw = JSON.stringify(event.message);
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
		const branch = ctx.sessionManager.getBranch();
		const recordedIndex = branch.findIndex(entry => entry.type === "message" && entry.message.timestamp === timestamp && JSON.stringify(entry.message) === raw);
		const key = `${ctx.sessionManager.getSessionId()}:${timestamp}:${messageRole}:${recordedIndex < 0 ? branch.length : recordedIndex}`;
		send({ t: "capture", key, role: messageRole, text: textOf(message.content), raw, at: timestamp });
	});
	pi.on("tool_approval_requested", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const approval = record(event);
		send({ t: "approval", phase: "requested", tool: String(approval.toolName ?? "tool"), summary: typeof approval.reason === "string" ? approval.reason : JSON.stringify(approval.input ?? approval) });
	});
	pi.on("tool_approval_resolved", (event, ctx) => {
		if (ctx.agent.kind === "main") send({ t: "approval", phase: "resolved", approved: record(event).approved === true });
	});
	pi.on("tool_call", async (event, ctx) => {
		if (role !== "worker" || (event.toolName !== "bash" && event.toolName !== "eval")) return;
		const input = record(event.input);
		const command = event.toolName === "bash" ? input.command : input.code;
		if (typeof command !== "string") return;
		const reason = await forbidden(command, typeof input.cwd === "string" ? resolve(ctx.cwd, input.cwd) : ctx.cwd, pi, protectedBranches, mainCheckout);
		if (!reason) return;
		const explanation = `${reason} Call home_report({status:"question", summary:..., details:...}) instead, then end the turn. Subagents must return the question to their parent worker.`;
		try { transport?.send({ t: "blocked", tool: event.toolName, command, reason: explanation }); }
		catch (error) { ctx.ui.notify(String(error), "error"); }
		return { block: true, reason: explanation };
	});
}
