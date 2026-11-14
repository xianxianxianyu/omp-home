import type { CommandDTO, Language } from "../shared/api.ts";
import { emptyStatus, emptyTranscript, MAX_ITEMS, reduceTranscript, type Item, type ToolView, type TranscriptEvent, type TranscriptView, type UiRequest } from "../shared/transcript.ts";
import { HubError } from "./errors.ts";
import { render, type Message } from "./i18n.ts";
import { runtimeMessages as m } from "./i18n-runtime.ts";
import type { RpcFrame } from "./rpc.ts";
import { commandsOf, currentIntent, historyView, localizedEvent, localizedView, Normalizer, statusFromState } from "./transcript.ts";

/** Items per `history?before=` page. */
const HISTORY_PAGE = 100;
/** Finished subagents kept in a session's view (their transcripts are omp's subagent session files). */
const FINISHED_SUBAGENTS = 20;

type Subscriber = (ev: TranscriptEvent) => void;
type Prepend = Extract<TranscriptEvent, { t: "prepend" }>;

export interface SessionSeed {
	messages: unknown[];
	commands: unknown;
	state: unknown;
}

interface Entry {
	view: TranscriptView;
	/** Items that left the bounded view, oldest first, with their tools: served by `history`. */
	older: Item[];
	olderTools: Record<string, ToolView>;
	normalizer: Normalizer;
	subscribers: Set<Subscriber>;
	commands: CommandDTO[];
}

function toolIds(items: readonly Item[]): string[] {
	return items.flatMap(i => (i.kind === "assistant" ? i.blocks.flatMap(b => (b.kind === "tool" ? [b.callId] : [])) : []));
}

/**
 * The live `TranscriptView` of every session the hub has run, its paging history and
 * its stream subscribers. Each event is folded with the same `reduceTranscript` the UI
 * uses, then broadcast, so every subscriber holds the hub's view.
 */
export class SessionViews {
	readonly #entries = new Map<string, Entry>();
	readonly #toast: (sessionId: string, level: "info" | "error", text: string | Message) => void;

	constructor(toast: (sessionId: string, level: "info" | "error", text: string | Message) => void) {
		this.#toast = toast;
	}

	#entry(id: string): Entry {
		let e = this.#entries.get(id);
		if (!e) {
			e = { view: emptyTranscript(), older: [], olderTools: {}, normalizer: new Normalizer(), subscribers: new Set(), commands: [] };
			this.#entries.set(id, e);
		}
		return e;
	}

	view(id: string, language: Language = "en"): TranscriptView {
		return localizedView(this.#entry(id).view, language);
	}

	/** Stream subscription: `reset` now, then every increment. Returns the unsubscribe function. */
	subscribe(id: string, send: Subscriber, language: Language = "en"): () => void {
		const e = this.#entry(id);
		const subscriber: Subscriber = event => send(localizedEvent(event, language));
		e.subscribers.add(subscriber);
		subscriber({ t: "reset", view: e.view });
		return () => e.subscribers.delete(subscriber);
	}

	/** The session's current tool intent; null when it has no view in this hub. */
	intent(id: string): string | null {
		const e = this.#entries.get(id);
		return e ? currentIntent(e.view) : null;
	}

	subscribers(id: string): number {
		return this.#entries.get(id)?.subscribers.size ?? 0;
	}

	/** A new omp process is up: rebuild the view from its stored history and state. */
	seed(id: string, seed: SessionSeed): void {
		const e = this.#entry(id);
		const { items, tools } = historyView(seed.messages, Date.now());
		const live = items.slice(-MAX_ITEMS);
		e.older = items.slice(0, items.length - live.length);
		const liveTools = new Set(toolIds(live));
		e.olderTools = {};
		const viewTools: Record<string, ToolView> = {};
		for (const [callId, tool] of Object.entries(tools)) {
			if (liveTools.has(callId)) viewTools[callId] = tool;
			else e.olderTools[callId] = tool;
		}
		e.normalizer = new Normalizer();
		e.commands = commandsOf(seed.commands);
		this.#broadcast(e, {
			t: "reset",
			view: { items: live, tools: viewTools, subagents: {}, status: { ...emptyStatus(), ...statusFromState(seed.state) }, earlierCursor: e.older.length ? live[0]!.id : null },
		});
	}

	frame(id: string, frame: RpcFrame): void {
		const e = this.#entry(id);
		if (frame.type === "available_commands_update") {
			e.commands = commandsOf(frame.commands);
			return;
		}
		const out = e.normalizer.frame(e.view, frame, Date.now());
		for (const ev of out.events) this.#broadcast(e, ev);
		if (out.toast) this.#toast(id, out.toast.level, out.toast.text);
	}

	/** Fold a `get_state` response (model, context, queue) into the status. */
	state(id: string, data: unknown): void {
		this.#broadcast(this.#entry(id), { t: "status", patch: statusFromState(data) });
	}

	apply(id: string, ev: TranscriptEvent): void {
		this.#broadcast(this.#entry(id), ev);
	}

	/** The process ended: nothing can answer its dialogs or finish its streams. */
	ended(id: string): void {
		const e = this.#entries.get(id);
		if (!e) return;
		for (const item of e.view.items) {
			if (item.kind === "request" && item.answer === null) this.#broadcast(e, { t: "request_closed", id: item.id, answer: render(m.answer("session_ended")), answerKind: "session_ended" });
			if (item.kind === "assistant" && item.streaming) this.#broadcast(e, { t: "item", item: { ...item, streaming: false } });
		}
		this.#broadcast(e, { t: "status", patch: { phase: "idle", settled: true, queue: { steering: [], followUp: [] } } });
	}

	/** The open dialog `requestId`, or a HubError for unknown and already answered ones. */
	openRequest(id: string, requestId: string): UiRequest {
		const item = this.#entries.get(id)?.view.items.find(i => i.id === requestId);
		if (!item || item.kind !== "request") throw new HubError("not_found", m.noRequest(requestId, id));
		if (item.answer !== null) throw new HubError("conflict", m.requestAnswered(requestId, item.answerKind ? m.answer(item.answerKind) : item.answer));
		return item.request;
	}

	commands(id: string): CommandDTO[] {
		return this.#entries.get(id)?.commands ?? [];
	}

	/** The page of items before `before` (an item id the client holds). */
	history(id: string, before: string, language: Language = "en"): Prepend {
		const e = this.#entry(id);
		const all = [...e.older, ...e.view.items];
		const at = all.findIndex(i => i.id === before);
		if (at < 0) throw new HubError("not_found", m.historyCursor(before));
		const start = Math.max(0, at - HISTORY_PAGE);
		const items = all.slice(start, at);
		const tools: Record<string, ToolView> = {};
		for (const callId of toolIds(items)) {
			const tool = e.olderTools[callId] ?? e.view.tools[callId];
			if (tool) tools[callId] = tool;
		}
		return localizedEvent({ t: "prepend", items, tools, earlierCursor: start > 0 ? items[0]!.id : null }, language);
	}

	forget(id: string): void {
		this.#entries.delete(id);
	}

	#broadcast(e: Entry, ev: TranscriptEvent): void {
		const before = e.view.items;
		e.view = reduceTranscript(e.view, ev);
		if (ev.t === "item") this.#retireDropped(e, before);
		else if (ev.t === "subagent" && ev.patch.status && ev.patch.status !== "running") this.#capSubagents(e);
		for (const send of e.subscribers) send(ev);
	}

	/** Items the bound dropped from the view (and their tools) move to the paging history. */
	#retireDropped(e: Entry, before: readonly Item[]): void {
		const first = e.view.items[0];
		if (!first || !before.length || before[0]!.id === first.id) return;
		const dropped = before.slice(0, Math.max(0, before.findIndex(i => i.id === first.id)));
		if (!dropped.length) return;
		e.older.push(...dropped);
		const tools = { ...e.view.tools };
		for (const callId of toolIds(dropped)) {
			const tool = tools[callId];
			if (!tool) continue;
			e.olderTools[callId] = tool;
			delete tools[callId];
		}
		e.view = { ...e.view, tools };
	}

	#capSubagents(e: Entry): void {
		const finished = Object.values(e.view.subagents)
			.filter(s => s.status !== "running")
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		if (finished.length <= FINISHED_SUBAGENTS) return;
		const subagents = { ...e.view.subagents };
		for (const s of finished.slice(0, finished.length - FINISHED_SUBAGENTS)) delete subagents[s.id];
		e.view = { ...e.view, subagents };
	}
}
