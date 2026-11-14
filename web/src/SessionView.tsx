import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandDTO, PromptRequest, RespondRequest } from "../../shared/api.ts";
import { emptyTranscript, reduceTranscript } from "../../shared/transcript.ts";
import type { Item, SubagentView, TranscriptEvent, TranscriptView, UiResponse } from "../../shared/transcript.ts";
import { api } from "./api.ts";
import { useHub } from "./hub.tsx";
import { connectSocket } from "./transport.ts";
import type { HubSocket } from "./transport.ts";
import { transcriptEvent } from "./transcript-schema.ts";
import { TranscriptItem } from "./TranscriptItems.tsx";
import "./session.css";

const PAGE_SIZE = 60;
function useSession(sessionId: string) {
	const [view, setView] = useState(emptyTranscript);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
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
							void api<CommandDTO[]>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`).then(value => { if (!disposed) setCommands(value); }).catch(cause => { if (!disposed) setError(`Commands: ${cause instanceof Error ? cause.message : String(cause)}`); });
						}
						if (resetReceived) setView(current => reduceTranscript(current, event));
						if (resetReceived && event.t === "request_closed") setHistory(current => current ? reduceTranscript(current, event) : null);
					} catch { setError("Invalid session event. Reconnecting for a fresh transcript…"); socket?.close(); }
				},
				close: (code, reason) => {
					if (disposed) return;
					setConnected(false);
					if (code === 4503) { setBlocked(true); setError(reason || "No worker slot is available. Retry when capacity is free."); return; }
					retry = window.setTimeout(connect, Math.min(15000, 500 * 2 ** attempts++));
				},
			});
		};
		connect();
		return () => { disposed = true; clearTimeout(retry); socket?.close(); };
	}, [sessionId, retryToken]);
	return { view, connected, error, commands, generation, history, setHistory, blocked, retry: () => setRetryToken(value => value + 1) };
}

function Composer({ sessionId, connected, running, commands, focused, main, abort, meta }: { sessionId: string; connected: boolean; running: boolean; commands: CommandDTO[]; focused: boolean; main: boolean; abort: () => Promise<void>; meta: string }) {
	const { noteComposerInput } = useHub();
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"auto" | "steer">("auto");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const compositionEnded = useRef(0);
	const query = text.match(/^\/([^\s]*)$/)?.[1].toLowerCase();
	const matches = query === undefined ? [] : commands.filter(command => {
		let index = 0;
		for (const char of `${command.name} ${command.description ?? ""}`.toLowerCase()) if (char === query[index]) index++;
		return index === query.length;
	}).slice(0, 8);
	const menuOpen = matches.length > 0 && !menuDismissed;
	useEffect(() => { if (focused && !main) input.current?.focus(); }, [focused, main]);
	useEffect(() => { const focus = () => { if (main) input.current?.focus(); }; window.addEventListener("focus-main", focus); return () => window.removeEventListener("focus-main", focus); }, [main]);
	const send = async () => {
		if (!text.trim() || pending || !connected || composing.current) return;
		setPending(true); setError(null);
		try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { body: { text, mode: running ? mode : "auto" } satisfies PromptRequest }); setText(""); setMenuDismissed(false); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setPending(false); }
	};
	const chooseCommand = (command: CommandDTO) => { setText(`/${command.name} `); setMenuDismissed(false); input.current?.focus(); noteComposerInput(); };
	return <div className="composer">
		{menuOpen && <div className="command-menu" role="listbox" aria-label="Slash commands">{matches.map((command, index) => <button role="option" aria-selected={index === selected} key={command.name} className={index === selected ? "selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)}><strong>/{command.name}</strong><span>{command.description ?? command.source}</span></button>)}</div>}
		<textarea ref={input} aria-label={`${sessionId} message`} placeholder={running && mode === "steer" ? "调整正在进行的工作…" : "给 omp 一个目标，或输入 / 查看命令…"} value={text} rows={2} disabled={pending} onChange={event => { setText(event.target.value); setSelected(0); setMenuDismissed(false); noteComposerInput(); }} onCompositionStart={() => { composing.current = true; noteComposerInput(); }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = performance.now(); }} onKeyDown={event => {
			if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (menuOpen) setMenuDismissed(true); else if (running) void abort(); return; }
			if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelected(index => (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); return; }
			if (menuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { if (performance.now() - compositionEnded.current < 80) return; event.preventDefault(); chooseCommand(matches[selected] ?? matches[0]); return; }
			if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (performance.now() - compositionEnded.current >= 80) void send(); }
		}} />
		<div className="composer-actions"><span className="composer-meta mono" title="Enter 发送 · Shift+Enter 换行">{meta}</span><span className="spacer" />{running && <button className={`btn small ${mode === "steer" ? "steer-active" : ""}`} aria-pressed={mode === "steer"} title="Steer injects into the current turn; follow-up waits until it ends" onClick={() => setMode(value => value === "auto" ? "steer" : "auto")}>{mode === "steer" ? "Steer ↗" : "Follow-up"}</button>}<button className="btn primary small" disabled={!connected || pending || !text.trim()} onClick={() => void send()}>{pending ? "Sending…" : "Send ↑"}</button></div>
		{error && <div className="error-text" role="alert">{error}</div>}
	</div>;
}

function SubagentPanel({ agents, selected, select, close, sessionId, connected }: { agents: Record<string, SubagentView>; selected: string | null; select: (id: string) => void; close: () => void; sessionId: string; connected: boolean }) {
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
	return <aside className="subagent-drawer" aria-label="Subagents"><header><h3>Subagents <span className="muted">{Object.keys(agents).length}</span></h3><button className="icon-button" aria-label="Close subagents" onClick={close}>×</button></header><div className="subagent-list">{Object.values(agents).map(sub => <button className={`subagent-row ${selected === sub.id ? "selected" : ""}`} key={sub.id} onClick={() => select(sub.id)}><span className={`status-dot ${sub.status}`} /><span className="grow"><strong>{sub.agent}</strong><small>{sub.task || sub.id}</small><small className="muted">{sub.lastIntent ?? sub.status}</small></span><span className="agent-duration">{Math.max(0, Math.round(((sub.endedAt ?? now) - sub.startedAt) / 1000))}s<span>{sub.status}</span></span></button>)}</div>{agent ? <><div className="nested-transcript" aria-label={`${agent.agent} transcript`}>{agent.transcript.items.length > nestedLimit && <button className="text-button" onClick={() => setNestedLimit(value => value + PAGE_SIZE)}>Show earlier</button>}{agent.transcript.items.slice(-nestedLimit).map(item => <TranscriptItem key={item.id} item={item} view={agent.transcript} openAgent={select} />)}{!agent.transcript.items.length && <p className="empty">Waiting for the agent’s first message…</p>}</div><form className="subagent-controls" onSubmit={event => { event.preventDefault(); void action("steer"); }}><textarea aria-label={`Steer ${agent.agent}`} rows={2} placeholder="给子 agent 补充方向…" value={text} disabled={agent.status !== "running" || pending || !connected} onChange={event => { setText(event.target.value); noteComposerInput(); }} /><div className="row"><button className="btn small danger" type="button" disabled={agent.status !== "running" || pending || !connected} onClick={() => void action("cancel")}>Cancel agent</button><span className="spacer" /><button className="btn small primary" disabled={agent.status !== "running" || pending || !connected || !text.trim()}>Steer</button></div>{error && <p className="error-text" role="alert">{error}</p>}</form></> : <p className="empty">Select an agent to follow its work.</p>}</aside>;
}

export function SessionView({ sessionId, focused, main = false }: { sessionId: string; focused: boolean; main?: boolean }) {
	const { view, connected, error, commands, generation, history, setHistory, blocked, retry } = useSession(sessionId);
	const [endId, setEndId] = useState<string | null>(null);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [following, setFollowing] = useState(true);
	const follow = useRef(true);
	const [drawer, setDrawer] = useState(false);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
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
	const abort = useCallback(async () => {
		try { await api(`${base}/abort`, { method: "POST" }); setActionError(null); }
		catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
	}, [base]);
	const respond = useCallback(async (requestId: string, response: UiResponse) => { await api(`${base}/respond`, { body: { requestId, response } satisfies RespondRequest }); }, [base]);
	const openAgent = useCallback((id: string) => { setSelectedAgent(id); setDrawer(true); }, []);
	return <section className="session-view" aria-label={`${sessionId} session`} onKeyDown={event => { if (event.key === "Escape" && running && !event.nativeEvent.isComposing && !document.querySelector("[data-modal]")) { event.preventDefault(); void abort(); } }}>
		{(running || view.status.phase === "compacting" || !view.status.settled || Object.keys(view.subagents).length > 0) && <div className="session-activity">{(running || view.status.phase === "compacting" || !view.status.settled) && <span className="activity-state"><span className={`phase-indicator ${running ? "spinning" : ""}`} />{view.status.phase === "running" ? "Working" : view.status.phase === "compacting" ? "Compacting" : "Waiting for agents"}</span>}{Object.keys(view.subagents).length > 0 && <button className={`btn small ${drawer ? "steer-active" : ""}`} aria-expanded={drawer} onClick={() => { setDrawer(value => !value); if (!selectedAgent) setSelectedAgent(Object.keys(view.subagents)[0] ?? null); }}>Subagents <span className="agent-count">{Object.keys(view.subagents).length}</span></button>}{running && <button className="btn small danger" disabled={!connected} title="Stop the current turn (Esc)" onClick={() => void abort()}>Stop</button>}</div>}
		{(!connected || error) && <div className="session-connection" role="status">{error ?? `Connecting to ${sessionId}… waiting for a fresh transcript.`}{blocked && <button className="btn small" onClick={retry}>Retry</button>}</div>}
		<div className="transcript-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (!element) return; const atBottom = endId === null && element.scrollHeight - element.scrollTop - element.clientHeight < 60; follow.current = atBottom; setFollowing(atBottom); }}><div className="transcript-content" ref={content}>
			{(start > 0 || cursor) && <button className="history-button" disabled={loadingHistory || !connected} onClick={() => void earlier()}>{loadingHistory ? "Loading history…" : "↑ Show earlier messages"}</button>}
			{items.map(item => <TranscriptItem key={item.id} item={item} view={combined} respond={connected ? respond : undefined} openAgent={openAgent} />)}
			{connected && !items.length && <div className="session-empty"><span className="brand">A little clarity. A lot of possibility.</span><p>告诉 omp 你想完成什么。任务、思考和进展都会留在这里。</p></div>}
			{endId !== null && <button className="history-button" onClick={() => { const next = combined.items[end + PAGE_SIZE]; setEndId(next?.id ?? null); if (scroll.current) scroll.current.scrollTop = 0; }}>Show newer messages ↓</button>}
		</div></div>
		{!following && <button className="jump-latest" onClick={jump}>↓ Jump to latest</button>}
		<div className="session-bottom">{actionError && <div className="session-error" role="alert">{actionError}</div>}{(view.status.queue.steering.length > 0 || view.status.queue.followUp.length > 0) && <div className="queue-chips">{(["steering", "followUp"] as const).flatMap(kind => view.status.queue[kind].map((text, index) => <span key={`${kind}-${index}`} title={text} className={`queue-chip ${kind}`}>{kind === "steering" ? "Steer" : "Queued"} · {text}</span>))}</div>}
			{Object.entries(view.status.statusLine).map(([key, line]) => <div className="extension-status" key={key}>{line}</div>)}{Object.entries(view.status.widgets).map(([key, lines]) => <details className="extension-widget" key={key}><summary>{key}</summary><pre>{lines.join("\n")}</pre></details>)}
			<Composer key={sessionId} sessionId={sessionId} connected={connected} running={running} commands={commands} focused={focused} main={main} abort={abort} meta={[view.status.model, view.status.contextPercent !== null ? `context ${Math.round(view.status.contextPercent)}%` : null].filter(Boolean).join(" · ")} />
		</div>{drawer && <SubagentPanel agents={view.subagents} selected={selectedAgent} select={setSelectedAgent} close={() => setDrawer(false)} sessionId={sessionId} connected={connected} />}
	</section>;
}
