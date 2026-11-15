import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AbortResult, CommandDTO, EditRequest, RespondRequest } from "../../shared/api.ts";
import { parseAttachmentBlock } from "../../shared/attachments.ts";
import { emptyTranscript, reduceTranscript } from "../../shared/transcript.ts";
import type { Item, SubagentView, TranscriptEvent, TranscriptView, UiResponse } from "../../shared/transcript.ts";
import { api } from "./api.ts";
import { mergePaths } from "./attachments.tsx";
import type { AttachedPath } from "./attachments.tsx";
import { useHub } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import { connectSocket } from "./transport.ts";
import type { HubSocket } from "./transport.ts";
import { transcriptEvent } from "./transcript-schema.ts";
import { Composer, QueueChips, appendParagraphs, useDraft } from "./Composer.tsx";
import { TranscriptItem } from "./TranscriptItems.tsx";
import type { MessageActions } from "./TranscriptItems.tsx";
import "./session.css";

const PAGE_SIZE = 60;
function useSession(sessionId: string) {
	const t = useT().session;
	const { language } = useI18n();
	const [view, setView] = useState(emptyTranscript);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<{ kind: "commands"; message: string } | { kind: "invalidEvent" } | { kind: "capacity"; reason?: string } | null>(null);
	const [commands, setCommands] = useState<CommandDTO[]>([]);
	const [generation, setGeneration] = useState(0);
	const [history, setHistory] = useState<TranscriptView | null>(null);
	const [retryToken, setRetryToken] = useState(0);
	const [blocked, setBlocked] = useState(false);
	useEffect(() => {
		let disposed = false;
		let socket: HubSocket | undefined;
		let retry: number | undefined;
		let attempts = 0;
		let resetReceived = false;
		setView(emptyTranscript()); setHistory(null); setCommands([]); setConnected(false); setBlocked(false); setError(null);
		const connect = () => {
			resetReceived = false;
			socket = connectSocket(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
				open: () => {},
				message: data => {
					if (disposed) return;
					try {
						const event = transcriptEvent.parse(JSON.parse(data));
						if (event.t === "reset") {
							resetReceived = true; attempts = 0; setConnected(true); setError(null); setGeneration(value => value + 1);
							void api<CommandDTO[]>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`).then(value => { if (!disposed) setCommands(value); }).catch(cause => { if (!disposed) setError({ kind: "commands", message: cause instanceof Error ? cause.message : String(cause) }); });
						}
						if (resetReceived) setView(current => reduceTranscript(current, event));
						if (resetReceived && event.t === "request_closed") setHistory(current => current ? reduceTranscript(current, event) : null);
					} catch { setError({ kind: "invalidEvent" }); socket?.close(); }
				},
				close: (code, reason) => {
					if (disposed) return;
					setConnected(false);
					if (code === 4503) { setBlocked(true); setError({ kind: "capacity", reason }); return; }
					retry = window.setTimeout(connect, Math.min(15000, 500 * 2 ** attempts++));
				},
			});
		};
		connect();
		return () => { disposed = true; clearTimeout(retry); socket?.close(); };
	}, [sessionId, retryToken, language]);
	return { view, connected, error: error?.kind === "commands" ? t.commandsError(error.message) : error?.kind === "invalidEvent" ? t.invalidEvent : error?.kind === "capacity" ? error.reason || t.noWorkerSlot : null, commands, generation, history, setHistory, blocked, retry: () => setRetryToken(value => value + 1) };
}

function SubagentPanel({ agents, selected, select, close, sessionId, connected }: { agents: Record<string, SubagentView>; selected: string | null; select: (id: string) => void; close: () => void; sessionId: string; connected: boolean }) {
	const t = useT().session.agents;
	const { format } = useI18n();
	const [text, setText] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now);
	const [nestedLimit, setNestedLimit] = useState(PAGE_SIZE);
	const { noteComposerInput } = useHub();
	const agent = selected ? agents[selected] : undefined;
	useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
	useEffect(() => { setText(""); setError(null); setNestedLimit(PAGE_SIZE); }, [selected]);
	const action = async (name: "steer" | "cancel") => {
		if (!agent || pending) return;
		setPending(true); setError(null);
		try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agent.id)}/${name}`, { method: "POST", body: name === "steer" ? { text } : undefined }); if (name === "steer") setText(""); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setPending(false); }
	};
	return <aside className="subagent-drawer" aria-label={t.title}><header><h3>{t.title} <span className="muted">{format.number(Object.keys(agents).length)}</span></h3><button className="icon-button" aria-label={t.close} onClick={close}>×</button></header><div className="subagent-list">{Object.values(agents).map(sub => <button className={`subagent-row ${selected === sub.id ? "selected" : ""}`} key={sub.id} onClick={() => select(sub.id)}><span className={`status-dot ${sub.status}`} /><span className="grow"><strong>{sub.agent}</strong><small>{sub.task || sub.id}</small><small className="muted">{sub.lastIntent ?? t.status[sub.status]}</small></span><span className="agent-duration">{format.duration(Math.max(0, (sub.endedAt ?? now) - sub.startedAt))}<span>{t.status[sub.status]}</span></span></button>)}</div>{agent ? <><div className="nested-transcript" aria-label={t.transcript(agent.agent)}>{agent.transcript.items.length > nestedLimit && <button className="text-button" onClick={() => setNestedLimit(value => value + PAGE_SIZE)}>{t.showEarlier}</button>}{agent.transcript.items.slice(-nestedLimit).map(item => <TranscriptItem key={item.id} item={item} view={agent.transcript} openAgent={select} />)}{!agent.transcript.items.length && <p className="empty">{t.waiting}</p>}</div><form className="subagent-controls" onSubmit={event => { event.preventDefault(); void action("steer"); }}><textarea aria-label={t.steerLabel(agent.agent)} rows={2} placeholder={t.placeholder} value={text} disabled={agent.status !== "running" || pending || !connected} onChange={event => { setText(event.target.value); noteComposerInput(); }} /><div className="row"><button className="btn small danger" type="button" disabled={agent.status !== "running" || pending || !connected} onClick={() => void action("cancel")}>{t.cancel}</button><span className="spacer" /><button className="btn small primary" disabled={agent.status !== "running" || pending || !connected || !text.trim()}>{t.steer}</button></div>{error && <p className="error-text" role="alert">{error}</p>}</form></> : <p className="empty">{t.select}</p>}</aside>;
}

export function SessionView({ sessionId, focused, main = false, escapeAborts = main, onNewChat }: { sessionId: string; focused: boolean; main?: boolean; escapeAborts?: boolean; onNewChat?: () => void }) {
	const t = useT().session;
	const { format } = useI18n();
	const { view, connected, error, commands, generation, history, setHistory, blocked, retry } = useSession(sessionId);
	const [endId, setEndId] = useState<string | null>(null);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [following, setFollowing] = useState(true);
	const follow = useRef(true);
	const [drawer, setDrawer] = useState(false);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [draft, setDraft] = useDraft(sessionId);
	const [draftPaths, setDraftPaths] = useState<AttachedPath[]>([]);
	const [restored, setRestored] = useState(false);
	const [stopping, setStopping] = useState(false);
	/** Item the run was stopped after; a local "Stopped" marker goes there unless omp's aborted message already shows one. */
	const [stopAnchor, setStopAnchor] = useState<string | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const running = view.status.phase !== "idle";
	const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
	useEffect(() => { setHistory(null); setEndId(null); }, [generation, sessionId]);
	const combined = useMemo(() => {
		if (!history) return view;
		const items = new Map<string, Item>(history.items.map(item => [item.id, item]));
		for (const item of view.items) items.set(item.id, item);
		return { ...view, items: Array.from(items.values()), tools: { ...history.tools, ...view.tools } };
	}, [view, history]);
	const foundEnd = endId === null ? combined.items.length : combined.items.findIndex(item => item.id === endId);
	const end = foundEnd < 0 ? combined.items.length : foundEnd;
	const start = Math.max(0, end - PAGE_SIZE);
	const items = combined.items.slice(start, end);
	const cursor = history ? history.earlierCursor : view.earlierCursor;
	const stopIndex = stopAnchor === null ? -1 : combined.items.findIndex(item => item.id === stopAnchor);
	const stopMarker = stopIndex >= 0 && !combined.items.slice(stopIndex).some(item => item.kind === "assistant" && item.stopReason === "aborted");
	const lastAssistantId = useMemo(() => combined.items.findLast(item => item.kind === "assistant")?.id ?? null, [combined.items]);
	const jump = () => { setEndId(null); follow.current = true; setFollowing(true); requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }); };
	useLayoutEffect(() => { if (follow.current && endId === null && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [view, focused, endId]);
	useEffect(() => { const observer = new ResizeObserver(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }); if (content.current) observer.observe(content.current); return () => observer.disconnect(); }, []);
	const earlier = async () => {
		follow.current = false; setFollowing(false); setActionError(null);
		const boundary = items[0]?.id;
		if (!boundary) return;
		if (start > 0) { setHistory({ ...combined, earlierCursor: cursor }); setEndId(boundary); if (scroll.current) scroll.current.scrollTop = 0; return; }
		if (!cursor) return;
		setLoadingHistory(true);
		try {
			const page = await api<Extract<TranscriptEvent, { t: "prepend" }>>(`${base}/history?before=${encodeURIComponent(cursor)}`);
			setHistory(reduceTranscript({ ...combined, earlierCursor: cursor }, page));
			if (page.items.length) setEndId(boundary);
			if (scroll.current) scroll.current.scrollTop = 0;
		} catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoadingHistory(false); }
	};
	/** Withdrawn or edited messages carry their attachments as a block; the text goes back to the editor and the paths back to chips. */
	const toComposer = useCallback((texts: string[]) => {
		const parsed = texts.map(text => parseAttachmentBlock(text));
		setDraft(current => appendParagraphs(current, parsed.map(item => item.text)));
		setDraftPaths(current => mergePaths(current, parsed.flatMap(item => item.attachments)));
		input.current?.focus();
	}, [setDraft]);
	const lastItemId = view.items.at(-1)?.id ?? null;
	const abort = useCallback(async () => {
		setStopping(true);
		try {
			const result = await api<AbortResult>(`${base}/abort`, { method: "POST" });
			setActionError(null); setStopAnchor(lastItemId);
			if (result.restored.length) { toComposer(result.restored); setRestored(true); }
		}
		catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setStopping(false); }
	}, [base, lastItemId, toComposer]);
	const respond = useCallback(async (requestId: string, response: UiResponse) => { await api(`${base}/respond`, { body: { requestId, response } satisfies RespondRequest }); }, [base]);
	const edit = useCallback(async (itemId: string, text: string, attachments: AttachedPath[]) => { await api(`${base}/edit`, { body: { itemId, text, ...(attachments.length ? { attachments: attachments.map(({ path }) => ({ path })) } : {}) } satisfies EditRequest }); }, [base]);
	const retryTurn = useCallback(async () => {
		try { await api(`${base}/retry`, { method: "POST" }); setActionError(null); }
		catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
	}, [base]);
	const actions = useMemo<MessageActions>(() => ({ running, connected, main, lastAssistantId, edit, retry: retryTurn }), [running, connected, main, lastAssistantId, edit, retryTurn]);
	const openAgent = useCallback((id: string) => { setSelectedAgent(id); setDrawer(true); }, []);
	return <section className="session-view" aria-label={t.label(sessionId)} onKeyDown={event => { if (event.key === "Escape" && escapeAborts && running && !event.nativeEvent.isComposing && !document.querySelector("[data-modal]")) { event.preventDefault(); void abort(); } }}>
		{(running || view.status.phase === "compacting" || !view.status.settled || Object.keys(view.subagents).length > 0) && <div className="session-activity">{(running || view.status.phase === "compacting" || !view.status.settled) && <span className="activity-state"><span className={`phase-indicator ${running ? "spinning" : ""}`} />{view.status.phase === "running" ? t.working : view.status.phase === "compacting" ? t.compacting : t.waitingForAgents}</span>}{Object.keys(view.subagents).length > 0 && <button className={`btn small ${drawer ? "steer-active" : ""}`} aria-expanded={drawer} onClick={() => { setDrawer(value => !value); if (!selectedAgent) setSelectedAgent(Object.keys(view.subagents)[0] ?? null); }}>{t.agents.title} <span className="agent-count">{format.number(Object.keys(view.subagents).length)}</span></button>}{running && <button className="btn small danger" disabled={!connected || stopping} title={escapeAborts ? t.stopEscapeHint : t.stopHint} onClick={() => void abort()}>{t.stop}</button>}</div>}
		{(!connected || error) && <div className="session-connection" role="status">{error ?? t.connecting(sessionId)}{blocked && <button className="btn small" onClick={retry}>{t.retry}</button>}</div>}
		<div className="transcript-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (!element) return; const atBottom = endId === null && element.scrollHeight - element.scrollTop - element.clientHeight < 60; follow.current = atBottom; setFollowing(atBottom); }}><div className="transcript-content" ref={content}>
			{(start > 0 || cursor) && <button className="history-button" disabled={loadingHistory || !connected} onClick={() => void earlier()}>{loadingHistory ? t.loadingHistory : t.earlierMessages}</button>}
			{items.map(item => <Fragment key={item.id}><TranscriptItem item={item} view={combined} respond={connected ? respond : undefined} openAgent={openAgent} actions={actions} />{stopMarker && item.id === stopAnchor && <div className="stopped-marker">{t.message.stopped}</div>}</Fragment>)}
			{connected && !items.length && <div className="session-empty"><span className="brand">{t.emptyTitle}</span><p>{t.emptyDescription}</p></div>}
			{endId !== null && <button className="history-button" onClick={() => { const next = combined.items[end + PAGE_SIZE]; setEndId(next?.id ?? null); if (scroll.current) scroll.current.scrollTop = 0; }}>{t.newerMessages}</button>}
		</div></div>
		<div className="session-bottom">{!following && <button className="jump-latest" onClick={jump}>{t.jumpLatest}</button>}{actionError && <div className="session-error" role="alert">{actionError}</div>}<QueueChips sessionId={sessionId} queue={view.status.queue} connected={connected} edit={text => toComposer([text])} />
			{Object.entries(view.status.statusLine).map(([key, line]) => <div className="extension-status" key={key}>{line}</div>)}{Object.entries(view.status.widgets).map(([key, lines]) => <details className="extension-widget" key={key}><summary>{key}</summary><pre>{lines.join("\n")}</pre></details>)}
			<Composer key={sessionId} sessionId={sessionId} connected={connected} running={running} commands={commands} focused={focused} main={main} input={input} text={draft} setText={setDraft} paths={draftPaths} setPaths={setDraftPaths} note={restored ? t.composer.restored : null} clearNote={() => setRestored(false)} abort={abort} stopping={stopping} escapeAborts={escapeAborts} onNewChat={onNewChat} meta={[view.status.model, view.status.contextPercent !== null ? t.context(format.percent(Math.round(view.status.contextPercent) / 100)) : null].filter(Boolean).join(" · ")} />
		</div>{drawer && <SubagentPanel agents={view.subagents} selected={selectedAgent} select={setSelectedAgent} close={() => setDrawer(false)} sessionId={sessionId} connected={connected} />}
	</section>;
}
