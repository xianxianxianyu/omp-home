/**
 * Rendered view of one omp session, shared by the hub (which keeps the live view per
 * session) and the UI (which folds the same events). The hub turns omp RPC frames into
 * `TranscriptEvent`s in `server/transcript.ts`; nothing outside the hub sees RPC frames.
 *
 * Stream: WS `/api/sessions/:id/stream` sends a `reset` first, then incremental events.
 */

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export type Block = { kind: "text"; text: string } | { kind: "thinking"; text: string } | { kind: "tool"; callId: string };

export interface ToolView {
	callId: string;
	name: string;
	/** omp's one-line intent for the call ("Listing directory"). */
	intent: string | null;
	args: unknown;
	status: "running" | "done" | "error";
	/** Latest output text: streamed partial while running, final result text after. */
	output: string;
	startedAt: number;
	endedAt: number | null;
}

export type UiRequest =
	| { method: "select"; title: string; options: string[]; details: (string | null)[] }
	| { method: "confirm"; title: string; message: string }
	| { method: "input"; title: string; placeholder: string | null; secret: boolean }
	| { method: "editor"; title: string; prefill: string }
	| {
			method: "ask";
			questions: { id: string; question: string; header: string | null; options: { label: string; description: string | null }[]; multi: boolean; recommended: number | null }[];
	  };

export type UiResponse =
	| { value: string }
	| { confirmed: boolean }
	| { answers: { id: string; selectedOptions: string[]; customInput?: string }[] }
	| { cancelled: true };

export type Item =
	| { kind: "user"; id: string; at: number; text: string; images: number; from: "human" | "agent" }
	| {
			kind: "assistant";
			id: string;
			at: number;
			blocks: Block[];
			streaming: boolean;
			model: string | null;
			stopReason: string | null;
			error: string | null;
			usage: Usage | null;
	  }
	/** Injected records: omp-home notices, IRC messages from other agents, other extension messages. */
	| { kind: "notice"; id: string; at: number; source: "omp-home" | "irc" | "custom"; from: string | null; text: string }
	/** A dialog omp is waiting on (tool approval, ask tool, extension prompt). `answer` is set once handled. */
	| { kind: "request"; id: string; at: number; request: UiRequest; answer: string | null };

export interface SubagentView {
	id: string;
	agent: string;
	task: string;
	status: "running" | "completed" | "failed" | "aborted";
	parentToolCallId: string | null;
	lastIntent: string | null;
	startedAt: number;
	endedAt: number | null;
	transcript: TranscriptView;
}

export interface SessionStatus {
	phase: "idle" | "running" | "compacting";
	/** No run, queued message or background job can wake the session. */
	settled: boolean;
	queue: { steering: string[]; followUp: string[] };
	model: string | null;
	contextPercent: number | null;
	/** Extension status line entries and widgets (`setStatus` / `setWidget`), by key. */
	statusLine: Record<string, string>;
	widgets: Record<string, string[]>;
}

export interface TranscriptView {
	items: Item[];
	tools: Record<string, ToolView>;
	subagents: Record<string, SubagentView>;
	status: SessionStatus;
	/** Older history exists before `items[0]`; fetch with GET /api/sessions/:id/history?before=<cursor>. */
	earlierCursor: string | null;
}

export type TranscriptEvent =
	| { t: "reset"; view: TranscriptView }
	| { t: "prepend"; items: Item[]; tools: Record<string, ToolView>; earlierCursor: string | null }
	/** Insert or replace an item by id. */
	| { t: "item"; item: Item }
	/** Append streamed text to block `index` of assistant item `id`, creating the block when missing. */
	| { t: "delta"; id: string; index: number; kind: "text" | "thinking"; text: string }
	/** Insert or replace a tool by callId; when `itemId` is given the assistant item gets a tool block at `index`. */
	| { t: "tool"; tool: ToolView; itemId?: string; index?: number }
	| { t: "tool_output"; callId: string; output: string }
	| { t: "request_closed"; id: string; answer: string }
	| { t: "status"; patch: Partial<SessionStatus> }
	| { t: "subagent"; id: string; patch: Partial<Omit<SubagentView, "transcript" | "id">> }
	| { t: "subagent_event"; id: string; event: TranscriptEvent };

export const MAX_ITEMS = 400;

export function emptyStatus(): SessionStatus {
	return { phase: "idle", settled: true, queue: { steering: [], followUp: [] }, model: null, contextPercent: null, statusLine: {}, widgets: {} };
}

export function emptyTranscript(): TranscriptView {
	return { items: [], tools: {}, subagents: {}, status: emptyStatus(), earlierCursor: null };
}

function upsert(items: Item[], item: Item): Item[] {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i]!.id === item.id) {
			const next = items.slice();
			next[i] = item;
			return next;
		}
	}
	return [...items, item];
}

function mapItem(items: Item[], id: string, fn: (item: Item) => Item): Item[] {
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i]!.id === id) {
			const next = items.slice();
			next[i] = fn(items[i]!);
			return next;
		}
	}
	return items;
}

/** Keep the live window bounded; dropped items stay reachable through history paging. */
function bound(view: TranscriptView): TranscriptView {
	if (view.items.length <= MAX_ITEMS) return view;
	const dropped = view.items.length - MAX_ITEMS;
	return { ...view, items: view.items.slice(dropped), earlierCursor: view.items[dropped]!.id };
}

function placeBlock(blocks: Block[], index: number, block: Block): Block[] {
	const next = blocks.slice();
	while (next.length < index) next.push({ kind: "text", text: "" });
	next[index] = block;
	return next;
}

/** Pure fold of one event into a view. Unknown targets (an item or subagent never seen) are ignored. */
export function reduceTranscript(view: TranscriptView, ev: TranscriptEvent): TranscriptView {
	switch (ev.t) {
		case "reset":
			return ev.view;
		case "prepend":
			return { ...view, items: [...ev.items, ...view.items], tools: { ...ev.tools, ...view.tools }, earlierCursor: ev.earlierCursor };
		case "item":
			return bound({ ...view, items: upsert(view.items, ev.item) });
		case "delta":
			return {
				...view,
				items: mapItem(view.items, ev.id, item => {
					if (item.kind !== "assistant") return item;
					const current = item.blocks[ev.index];
					const block: Block = current && current.kind === ev.kind ? { kind: ev.kind, text: current.text + ev.text } : { kind: ev.kind, text: ev.text };
					return { ...item, blocks: placeBlock(item.blocks, ev.index, block) };
				}),
			};
		case "tool": {
			const tools = { ...view.tools, [ev.tool.callId]: ev.tool };
			const itemId = ev.itemId;
			if (itemId === undefined || ev.index === undefined) return { ...view, tools };
			const index = ev.index;
			return {
				...view,
				tools,
				items: mapItem(view.items, itemId, item => (item.kind === "assistant" ? { ...item, blocks: placeBlock(item.blocks, index, { kind: "tool", callId: ev.tool.callId }) } : item)),
			};
		}
		case "tool_output": {
			const tool = view.tools[ev.callId];
			return tool ? { ...view, tools: { ...view.tools, [ev.callId]: { ...tool, output: ev.output } } } : view;
		}
		case "request_closed":
			return { ...view, items: mapItem(view.items, ev.id, item => (item.kind === "request" ? { ...item, answer: ev.answer } : item)) };
		case "status":
			return { ...view, status: { ...view.status, ...ev.patch } };
		case "subagent": {
			const current = view.subagents[ev.id];
			const base: SubagentView = current ?? {
				id: ev.id,
				agent: ev.patch.agent ?? "task",
				task: ev.patch.task ?? "",
				status: "running",
				parentToolCallId: null,
				lastIntent: null,
				startedAt: ev.patch.startedAt ?? 0,
				endedAt: null,
				transcript: emptyTranscript(),
			};
			return { ...view, subagents: { ...view.subagents, [ev.id]: { ...base, ...ev.patch } } };
		}
		case "subagent_event": {
			const sub = view.subagents[ev.id];
			if (!sub) return view;
			return { ...view, subagents: { ...view.subagents, [ev.id]: { ...sub, transcript: reduceTranscript(sub.transcript, ev.event) } } };
		}
	}
}

/** Text the UI shows for an assistant item when collapsed or searched. */
export function assistantText(item: Extract<Item, { kind: "assistant" }>): string {
	return item.blocks.flatMap(b => (b.kind === "text" ? [b.text] : [])).join("");
}
