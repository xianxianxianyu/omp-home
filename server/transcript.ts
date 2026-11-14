import type { CommandDTO } from "../shared/api.ts";
import { NOTICE_MESSAGE } from "../shared/bridge-wire.ts";
import { emptyTranscript, type Block, type Item, type SessionStatus, type SubagentView, type ToolView, type TranscriptEvent, type TranscriptView, type UiRequest, type UiResponse, type Usage } from "../shared/transcript.ts";

/**
 * omp RPC frames → `TranscriptEvent`s. No I/O: the hub feeds frames in arrival order
 * together with the session's current view; the normalizer keeps only what frames
 * do not carry (synthesized message ids, IRC dedupe, run phase).
 */

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
const rec = (v: unknown): Rec | null => (isRec(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] => arr(v).flatMap(s => (typeof s === "string" ? [s] : []));

/** Tool output kept per tool (the tail: errors and results come last). */
export const TOOL_OUTPUT_LIMIT = 32 * 1024;

export function clipOutput(text: string): string {
	if (text.length <= TOOL_OUTPUT_LIMIT) return text;
	return `…[${text.length - TOOL_OUTPUT_LIMIT} earlier characters not shown]\n${text.slice(-TOOL_OUTPUT_LIMIT)}`;
}

/** Text of a message `content`: a string, or the text parts of a block array. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return arr(content)
		.flatMap(part => {
			const p = rec(part);
			return p?.type === "text" && typeof p.text === "string" ? [p.text] : [];
		})
		.join("");
}

function intentOf(args: unknown): string | null {
	return str(rec(args)?.i);
}

function modelName(model: unknown): string | null {
	const m = rec(model);
	return m ? (str(m.id) ?? str(m.name)) : str(model);
}

function usageOf(v: unknown): Usage | null {
	const u = rec(v);
	if (!u) return null;
	return { input: num(u.input) ?? 0, output: num(u.output) ?? 0, cacheRead: num(u.cacheRead) ?? 0, cacheWrite: num(u.cacheWrite) ?? 0, costUsd: num(rec(u.cost)?.total) ?? 0 };
}

interface ToolCall {
	id: string;
	name: string;
	args: unknown;
	intent: string | null;
}

function toolCallOf(part: unknown): ToolCall | null {
	const p = rec(part);
	const id = str(p?.id);
	if (!p || p.type !== "toolCall" || !id) return null;
	return { id, name: str(p.name) ?? "tool", args: p.arguments ?? null, intent: str(p.intent) ?? intentOf(p.arguments) };
}

function assistantBlocks(content: unknown): { blocks: Block[]; calls: ToolCall[] } {
	const blocks: Block[] = [];
	const calls: ToolCall[] = [];
	for (const part of arr(content)) {
		const p = rec(part);
		if (p?.type === "text" && typeof p.text === "string" && p.text) blocks.push({ kind: "text", text: p.text });
		else if (p?.type === "thinking" && typeof p.thinking === "string" && p.thinking) blocks.push({ kind: "thinking", text: p.thinking });
		else {
			const call = toolCallOf(part);
			if (call) {
				blocks.push({ kind: "tool", callId: call.id });
				calls.push(call);
			}
		}
	}
	return { blocks, calls };
}

function newTool(call: ToolCall, at: number): ToolView {
	return { callId: call.id, name: call.name, intent: call.intent, args: call.args, status: "running", output: "", startedAt: at, endedAt: null };
}

type AssistantItem = Extract<Item, { kind: "assistant" }>;

function assistantItem(id: string, message: Rec, at: number, streaming: boolean, blocks: Block[]): AssistantItem {
	const stopReason = str(message.stopReason);
	return {
		kind: "assistant",
		id,
		at: num(message.timestamp) ?? at,
		blocks,
		streaming,
		model: str(message.model),
		stopReason: streaming ? null : stopReason,
		error: str(message.errorMessage),
		usage: streaming ? null : usageOf(message.usage),
	};
}

function userItem(id: string, message: Rec, at: number): Item {
	const images = arr(message.content).filter(p => rec(p)?.type === "image").length;
	return { kind: "user", id, at: num(message.timestamp) ?? at, text: textOf(message.content), images, from: message.attribution === "agent" ? "agent" : "human" };
}

/** IRC custom messages repeat as `irc_message` and as a session message; both map to one item id. */
function ircKey(message: Rec): string | null {
	const details = rec(message.details);
	return str(details?.id);
}

function noticeItem(id: string, message: Rec, at: number): Item | null {
	if (message.display === false) return null;
	const type = str(message.customType) ?? "";
	const details = rec(message.details);
	const at_ = num(message.timestamp) ?? at;
	if (type === NOTICE_MESSAGE) return { kind: "notice", id, at: at_, source: "omp-home", from: null, text: textOf(message.content) };
	if (type.startsWith("irc:")) return { kind: "notice", id, at: at_, source: "irc", from: str(details?.from), text: str(details?.message) ?? textOf(message.content) };
	return { kind: "notice", id, at: at_, source: "custom", from: type || null, text: textOf(message.content) };
}

/** What the session is doing: the intent of its running tool call, else of its most recent one. */
export function currentIntent(view: TranscriptView): string | null {
	let best: ToolView | null = null;
	for (const tool of Object.values(view.tools)) {
		if (!tool.intent) continue;
		const running = tool.status === "running";
		const bestRunning = best?.status === "running";
		if (!best || (running && !bestRunning) || (running === bestRunning && tool.startedAt >= best.startedAt)) best = tool;
	}
	return best?.intent ?? null;
}

/** A dialog the human can answer, or null for fire-and-forget methods. */
export function uiRequestOf(f: Rec): UiRequest | null {
	const title = str(f.title) ?? "";
	switch (f.method) {
		case "select": {
			const options = strings(f.options);
			const details = arr(f.optionDetails);
			return { method: "select", title, options, details: options.map((_, i) => str(rec(details[i])?.description)) };
		}
		case "confirm":
			return { method: "confirm", title, message: str(f.message) ?? "" };
		case "input":
			return { method: "input", title, placeholder: str(f.placeholder), secret: f.secret === true };
		case "editor":
			return { method: "editor", title, prefill: str(f.prefill) ?? "" };
		case "ask":
			return {
				method: "ask",
				questions: arr(f.questions).flatMap(q => {
					const r = rec(q);
					const id = str(r?.id);
					if (!r || !id) return [];
					return [
						{
							id,
							question: str(r.question) ?? "",
							header: str(r.header),
							options: arr(r.options).flatMap(o => {
								const opt = rec(o);
								const label = str(opt?.label);
								return label ? [{ label, description: str(opt?.description) }] : [];
							}),
							multi: r.multi === true,
							recommended: num(r.recommended),
						},
					];
				}),
			};
		default:
			return null;
	}
}

/** Whether a response has the shape the request's method takes (a cancel always fits). */
export function responseFits(request: UiRequest, response: UiResponse): boolean {
	if ("cancelled" in response) return true;
	switch (request.method) {
		case "select":
			return "value" in response && request.options.includes(response.value);
		case "input":
		case "editor":
			return "value" in response;
		case "confirm":
			return "confirmed" in response;
		case "ask":
			return "answers" in response;
	}
}

/** One-line rendering of how a request was answered. */
export function answerText(request: UiRequest, response: UiResponse): string {
	if ("cancelled" in response) return "Cancelled";
	if ("confirmed" in response) return response.confirmed ? "Yes" : "No";
	if ("value" in response) return request.method === "input" && request.secret ? "••••••" : response.value;
	return response.answers.map(a => [...a.selectedOptions, ...(a.customInput ? [a.customInput] : [])].join(", ")).join("; ");
}

export function commandsOf(v: unknown): CommandDTO[] {
	const list = Array.isArray(v) ? v : arr(rec(v)?.commands);
	return list.flatMap(c => {
		const r = rec(c);
		const name = str(r?.name);
		return r && name ? [{ name, description: str(r.description), source: str(r.source) }] : [];
	});
}

/** Status fields carried by a `get_state` response. */
export function statusFromState(data: unknown): Partial<SessionStatus> {
	const s = rec(data);
	if (!s) return {};
	const patch: Partial<SessionStatus> = {
		phase: s.isCompacting === true ? "compacting" : s.isStreaming === true ? "running" : "idle",
		settled: s.isSettled === true,
		model: modelName(s.model),
	};
	const percent = num(rec(s.contextUsage)?.percent);
	if (percent !== null) patch.contextPercent = Math.round(percent * 10) / 10;
	const queue = rec(s.queuedMessages);
	if (queue) patch.queue = { steering: strings(queue.steering), followUp: strings(queue.followUp) };
	return patch;
}

/**
 * A view built from `get_messages_page` messages (chronological). Ids are `h<index>` so
 * they never collide with live `messageId`s; IRC notices share the live dedupe id.
 */
export function historyView(messages: unknown[], now: number): { items: Item[]; tools: Record<string, ToolView> } {
	const items: Item[] = [];
	const tools: Record<string, ToolView> = {};
	messages.forEach((raw, index) => {
		const m = rec(raw);
		if (!m) return;
		const id = `h${index}`;
		const at = num(m.timestamp) ?? now;
		switch (m.role) {
			case "user":
				items.push(userItem(id, m, now));
				return;
			case "assistant": {
				const { blocks, calls } = assistantBlocks(m.content);
				for (const call of calls) tools[call.id] = { ...newTool(call, at), status: "error", endedAt: at };
				items.push(assistantItem(id, m, now, false, blocks));
				return;
			}
			case "toolResult": {
				const callId = str(m.toolCallId);
				const tool = callId ? tools[callId] : undefined;
				if (tool) tools[tool.callId] = { ...tool, status: m.isError === true ? "error" : "done", output: clipOutput(textOf(m.content)), endedAt: at };
				return;
			}
			case "custom": {
				const key = ircKey(m);
				const item = noticeItem(key && str(m.customType)?.startsWith("irc:") ? `irc:${key}` : id, m, now);
				if (item) items.push(item);
				return;
			}
		}
	});
	return { items, tools };
}

export interface Normalized {
	events: TranscriptEvent[];
	toast: { level: "info" | "error"; text: string } | null;
}

function subagentStatus(v: unknown): SubagentView["status"] | null {
	if (v === "started" || v === "running" || v === "pending") return "running";
	if (v === "completed" || v === "failed" || v === "aborted") return v;
	return null;
}

/** Stateful only where frames are not self-describing; one instance per omp process. */
export class Normalizer {
	#seq = 0;
	/** Current message id per scope ("" = the session, otherwise a subagent id), for frames without `messageId`. */
	#current = new Map<string, string>();
	#running = new Map<string, boolean>();
	#irc = new Set<string>();

	frame(view: TranscriptView, f: Rec & { type: string }, now: number): Normalized {
		const none: Normalized = { events: [], toast: null };
		switch (f.type) {
			case "extension_ui_request":
				return this.#uiRequest(view, f, now);
			case "prompt_result": {
				const error = rec(f.error);
				return f.status === "error" ? { events: [], toast: { level: "error", text: `prompt failed: ${str(error?.message) ?? "unknown error"}` } } : none;
			}
			case "extension_error":
				return { events: [], toast: { level: "error", text: `extension ${str(f.event) ?? ""} failed: ${str(f.error) ?? ""}` } };
			case "session_settled":
				return { events: [{ t: "status", patch: { settled: true } }], toast: null };
			case "command_output": {
				const text = str(f.text);
				return text ? { events: [{ t: "item", item: { kind: "notice", id: `out${++this.#seq}`, at: now, source: "custom", from: "omp", text } }], toast: null } : none;
			}
			case "config_update":
				return f.model === undefined ? none : { events: [{ t: "status", patch: { model: modelName(f.model) } }], toast: null };
			case "subagent_lifecycle":
				return { events: this.#lifecycle(view, rec(f.payload), now), toast: null };
			case "subagent_progress":
				return { events: this.#progress(view, rec(f.payload), now), toast: null };
			case "subagent_event": {
				const payload = rec(f.payload);
				const id = str(payload?.id);
				const event = rec(payload?.event);
				if (!id || !event) return none;
				const events: TranscriptEvent[] = view.subagents[id] ? [] : [{ t: "subagent", id, patch: { startedAt: now } }];
				const sub = view.subagents[id]?.transcript ?? emptyTranscript();
				const nested = this.#session(id, sub, event, now);
				for (const ev of nested.events) events.push({ t: "subagent_event", id, event: ev });
				return { events, toast: nested.toast };
			}
			default:
				return this.#session("", view, f, now);
		}
	}

	#uiRequest(view: TranscriptView, f: Rec, now: number): Normalized {
		const none: Normalized = { events: [], toast: null };
		const id = str(f.id);
		switch (f.method) {
			case "notify": {
				const message = str(f.message);
				return message ? { events: [], toast: { level: f.notifyType === "error" ? "error" : "info", text: message } } : none;
			}
			case "cancel": {
				const target = str(f.targetId);
				return target ? { events: [{ t: "request_closed", id: target, answer: "Withdrawn" }], toast: null } : none;
			}
			case "setStatus": {
				const key = str(f.statusKey);
				if (!key) return none;
				const statusLine = { ...view.status.statusLine };
				const text = str(f.statusText);
				if (text) statusLine[key] = text;
				else delete statusLine[key];
				return { events: [{ t: "status", patch: { statusLine } }], toast: null };
			}
			case "setWidget": {
				const key = str(f.widgetKey);
				if (!key) return none;
				const widgets = { ...view.status.widgets };
				const lines = strings(f.widgetLines);
				if (lines.length) widgets[key] = lines;
				else delete widgets[key];
				return { events: [{ t: "status", patch: { widgets } }], toast: null };
			}
		}
		const request = uiRequestOf(f);
		if (!request || !id) return none;
		return { events: [{ t: "item", item: { kind: "request", id, at: now, request, answer: null } }], toast: null };
	}

	#lifecycle(view: TranscriptView, p: Rec | null, now: number): TranscriptEvent[] {
		const id = str(p?.id);
		const status = subagentStatus(p?.status);
		if (!p || !id || !status) return [];
		const patch: Partial<Omit<SubagentView, "transcript" | "id">> = { agent: str(p.agent) ?? view.subagents[id]?.agent ?? "task", status, parentToolCallId: str(p.parentToolCallId) };
		if (!view.subagents[id] || p.status === "started") patch.startedAt = now;
		if (!view.subagents[id]?.task && str(p.description)) patch.task = str(p.description)!;
		if (status !== "running") patch.endedAt = now;
		return [{ t: "subagent", id, patch }];
	}

	#progress(view: TranscriptView, p: Rec | null, now: number): TranscriptEvent[] {
		const progress = rec(p?.progress);
		const id = str(progress?.id);
		if (!p || !progress || !id) return [];
		const patch: Partial<Omit<SubagentView, "transcript" | "id">> = {
			agent: str(p.agent) ?? "task",
			task: str(p.assignment) ?? str(p.task) ?? view.subagents[id]?.task ?? "",
			parentToolCallId: str(p.parentToolCallId),
			lastIntent: str(progress.lastIntent) ?? str(progress.currentToolIntent) ?? view.subagents[id]?.lastIntent ?? null,
		};
		if (!view.subagents[id]) patch.startedAt = now;
		// Lifecycle frames own terminal transitions; progress only fills in a missed start.
		if (!view.subagents[id] && subagentStatus(progress.status) === "running") patch.status = "running";
		return [{ t: "subagent", id, patch }];
	}

	#messageId(scope: string, f: Rec, start: boolean): string {
		const given = str(f.messageId);
		if (given) {
			this.#current.set(scope, given);
			return given;
		}
		const current = this.#current.get(scope);
		if (!start && current) return current;
		const id = `${scope || "m"}#${++this.#seq}`;
		this.#current.set(scope, id);
		return id;
	}

	/** One session event, of the session itself (scope "") or of a subagent (scope = its id). */
	#session(scope: string, view: TranscriptView, f: Rec, now: number): Normalized {
		const none: Normalized = { events: [], toast: null };
		switch (f.type) {
			case "agent_start":
				this.#running.set(scope, true);
				return { events: [{ t: "status", patch: { phase: "running", settled: false } }], toast: null };
			case "agent_end":
				this.#running.set(scope, false);
				return { events: [{ t: "status", patch: { phase: "idle" } }], toast: null };
			case "auto_compaction_start":
			case "manual_compaction_start":
				return { events: [{ t: "status", patch: { phase: "compacting" } }], toast: null };
			case "auto_compaction_end":
			case "manual_compaction_end":
				return { events: [{ t: "status", patch: { phase: this.#running.get(scope) ? "running" : "idle" } }], toast: null };
			case "queue_update":
				return { events: [{ t: "status", patch: { queue: { steering: strings(f.steering), followUp: strings(f.followUp) } } }], toast: null };
			case "notice": {
				const message = str(f.message);
				return message ? { events: [], toast: { level: f.level === "error" ? "error" : "info", text: message } } : none;
			}
			case "irc_message": {
				const message = rec(f.message);
				return { events: message ? this.#custom(message, null, now) : [], toast: null };
			}
			case "message_start":
			case "message_update":
			case "message_end":
				return { events: this.#message(scope, view, f, now), toast: null };
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				return { events: this.#tool(view, f, now), toast: null };
			default:
				return none;
		}
	}

	#custom(message: Rec, messageId: string | null, now: number): TranscriptEvent[] {
		const key = str(message.customType)?.startsWith("irc:") ? ircKey(message) : null;
		if (key) {
			const first = !this.#irc.has(key);
			this.#irc.add(key);
			if (!first) return [];
		}
		const item = noticeItem(key ? `irc:${key}` : (messageId ?? `n${++this.#seq}`), message, now);
		return item ? [{ t: "item", item }] : [];
	}

	#message(scope: string, view: TranscriptView, f: Rec, now: number): TranscriptEvent[] {
		const message = rec(f.message);
		if (!message) return [];
		const role = message.role;
		if (role === "toolResult") return [];
		const id = this.#messageId(scope, f, f.type === "message_start");
		if (role === "user") return f.type === "message_update" ? [] : [{ t: "item", item: userItem(id, message, now) }];
		if (role === "custom") return f.type === "message_update" ? [] : this.#custom(message, id, now);
		if (role !== "assistant") return [];

		if (f.type === "message_start") return [{ t: "item", item: assistantItem(id, message, now, true, []) }];
		if (f.type === "message_end") {
			const { blocks, calls } = assistantBlocks(message.content);
			const events: TranscriptEvent[] = [];
			for (const call of calls) {
				const known = view.tools[call.id];
				if (!known) events.push({ t: "tool", tool: newTool(call, now) });
				else if ((!known.intent && call.intent) || known.args === null) events.push({ t: "tool", tool: { ...known, intent: known.intent ?? call.intent, args: known.args ?? call.args } });
			}
			events.push({ t: "item", item: assistantItem(id, message, now, false, blocks) });
			return events;
		}
		// message_update: stream text/thinking deltas; place tool blocks as their calls appear.
		const ev = rec(f.assistantMessageEvent);
		const index = num(ev?.contentIndex);
		if (!ev || index === null) return [];
		const events: TranscriptEvent[] = [];
		if (!view.items.some(i => i.id === id)) events.push({ t: "item", item: assistantItem(id, message, now, true, []) });
		switch (ev.type) {
			case "text_delta":
			case "thinking_delta": {
				const text = str(ev.delta);
				if (text) events.push({ t: "delta", id, index, kind: ev.type === "text_delta" ? "text" : "thinking", text });
				break;
			}
			case "toolcall_start":
			case "toolcall_end": {
				const call = toolCallOf(ev.type === "toolcall_end" ? ev.toolCall : arr(message.content)[index]);
				if (!call) break;
				const known = view.tools[call.id];
				const tool: ToolView = known ? { ...known, name: call.name, args: ev.type === "toolcall_end" ? call.args : known.args, intent: known.intent ?? call.intent } : { ...newTool(call, now), args: ev.type === "toolcall_end" ? call.args : null };
				events.push({ t: "tool", tool, itemId: id, index });
				break;
			}
		}
		return events;
	}

	#tool(view: TranscriptView, f: Rec, now: number): TranscriptEvent[] {
		const callId = str(f.toolCallId);
		if (!callId) return [];
		const known = view.tools[callId];
		const base: ToolView = known ?? { callId, name: str(f.toolName) ?? "tool", intent: str(f.intent) ?? intentOf(f.args), args: f.args ?? null, status: "running", output: "", startedAt: now, endedAt: null };
		switch (f.type) {
			case "tool_execution_start":
				return [{ t: "tool", tool: { ...base, name: str(f.toolName) ?? base.name, intent: str(f.intent) ?? base.intent ?? intentOf(f.args), args: f.args ?? base.args, status: "running" } }];
			case "tool_execution_update": {
				const output = clipOutput(textOf(rec(f.partialResult)?.content));
				return known ? [{ t: "tool_output", callId, output }] : [{ t: "tool", tool: { ...base, output } }];
			}
			default:
				return [{ t: "tool", tool: { ...base, status: f.isError === true ? "error" : "done", output: clipOutput(textOf(rec(f.result)?.content)), endedAt: now } }];
		}
	}
}
