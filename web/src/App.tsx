import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SessionDTO } from "../../shared/api.ts";
import { PANELS, useHub, useResource } from "./hub.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Loading, Status } from "./ui.tsx";
import { SessionView } from "./SessionView.tsx";
import { Setup } from "./Setup.tsx";
import { Search } from "./Search.tsx";
import { InboxPanel } from "./panels/Inbox.tsx";
import { TasksPanel, TaskDrawer } from "./panels/Tasks.tsx";
import { SessionsPanel } from "./panels/Sessions.tsx";
import { WorkspacesPanel } from "./panels/Workspaces.tsx";
import { DecisionsPanel } from "./panels/Decisions.tsx";
import { ResourcesPanel } from "./panels/Resources.tsx";
import { SettingsPanel } from "./panels/Settings.tsx";

export function App() {
	const { state, stateError, reload, toasts, dismissToast } = useHub();
	return <>{!state ? <div className="boot-screen"><div className="brand"><span className="dot" />omp-home</div>{stateError ? <><ErrorState error={stateError} retry={reload} /><p className="hint">Open the link printed by the hub to authorize this browser.</p></> : <Loading />}</div> : !state.setup.done ? <Setup /> : <Workspace />}
		<div className="toast-stack" aria-live="polite">{toasts.map(toast => <div role={toast.level === "error" ? "alert" : "status"} className={`toast ${toast.level === "error" ? "err" : ""}`} key={toast.id}><div className="row"><span className="grow">{toast.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => dismissToast(toast.id)}>×</button></div>{toast.action && <Button className="small" onClick={async () => { await toast.action?.run(); dismissToast(toast.id); }}>{toast.action.label}</Button>}</div>)}</div>
	</>;
}
function Workspace() {
	const { state, connected, active, setActive, tabs, closeTab, taskId, closeTask, mutate } = useHub();
	const sessions = useResource<SessionDTO[]>("sessions", "/api/sessions");
	const [left, setLeft] = useState(() => {
		const stored = Number(localStorage.getItem("omp-home-split"));
		return stored >= 25 && stored <= 75 ? stored : 48;
	});
	const [confirm, setConfirm] = useState<"restart" | "new" | null>(null);
	const search = useRef<HTMLInputElement>(null);
	const split = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || document.querySelector("[data-modal]")) return;
			if (event.key.toLowerCase() === "k") { event.preventDefault(); event.stopImmediatePropagation(); search.current?.focus(); }
			const index = Number(event.key) - 1;
			if (index >= 0 && index < PANELS.length && Number.isInteger(index)) { event.preventDefault(); event.stopImmediatePropagation(); setActive(PANELS[index]); }
		};
		window.addEventListener("keydown", key, true);
		return () => window.removeEventListener("keydown", key, true);
	}, [setActive]);
	useEffect(() => {
		split.current?.querySelector<HTMLElement>('.tabs [aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [active, tabs.length]);
	if (!state) return null;
	const setSplit = (value: number) => { const next = Math.max(25, Math.min(75, value)); setLeft(next); localStorage.setItem("omp-home-split", String(next)); };
	const panel = active === "Inbox" ? <InboxPanel /> : active === "Tasks" ? <TasksPanel /> : active === "Sessions" ? <SessionsPanel /> : active === "Workspaces" ? <WorkspacesPanel /> : active === "Decisions" ? <DecisionsPanel /> : active === "Resources" ? <ResourcesPanel /> : active === "Settings" ? <SettingsPanel /> : null;
	return <div className="app">
		<header className="topbar" data-tauri-drag-region>
			<div className="brand" data-tauri-drag-region><span className="dot" />omp-home</div>
			{state.main.paused && <><span className="pill warn" title={`${state.main.pendingNotices} worker update(s) are waiting`}>Main paused</span><Button className="small" onClick={() => mutate("/api/main/continue")}>Let main continue</Button></>}
			{!connected && <span className="pill err">Hub disconnected · reconnecting…</span>}
			{state.omp.warning && <span className="pill warn" title={state.omp.warning}>omp check failed</span>}
			<div className="spacer" data-tauri-drag-region />
			<Search inputRef={search} />
			<MoreMenu onRestart={() => setConfirm("restart")} onNewChat={() => setConfirm("new")} />
		</header>
		<div className="split" ref={split} style={{ "--left": `${left}%` } as CSSProperties}>
			<section className="pane main-pane" aria-label="Main conversation"><div className="pane-body">{state.main.sessionId && state.main.state !== "cold" ? <div className="session-wrap"><SessionView key={state.main.sessionId} sessionId={state.main.sessionId} focused main /></div> : <div className="start-main"><Empty title="Your main conversation starts here"><p>Give main a goal. It will route the work, review reports,<br />and bring you in when your judgment is needed.</p><Button className="primary" onClick={() => mutate("/api/main/restart")}>Start main</Button></Empty></div>}</div></section>
			<div className="gutter" role="separator" aria-label="Resize chat and workspace panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(left)} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplit(left + (event.key === "ArrowLeft" ? -2 : 2)); } }} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = split.current?.getBoundingClientRect(); if (bounds) setSplit((event.clientX - bounds.left) / bounds.width * 100); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
			<section className="pane workspace-pane" aria-label="Workspace control"><nav className="tabs" aria-label="Workspace panels and sessions">{PANELS.map((name, index) => <button className={`tab ${active === name ? "active" : ""}`} key={name} aria-current={active === name ? "page" : undefined} title={`${name} · ⌘/Ctrl ${index + 1}`} onClick={() => setActive(name)}>{name}{name === "Inbox" && state.inboxOpen > 0 && <span className="badge">{state.inboxOpen}</span>}{name === "Sessions" && state.pool.live > 0 && <span className="count" title={`${state.pool.live} live worker(s) of ${state.pool.cap}`}>{state.pool.live}</span>}</button>)}{tabs.length > 0 && <span className="tab-sep" />}{tabs.map(saved => {
				const session = sessions.data?.find(item => item.id === saved.id) ?? saved;
				const label = `${session.id} · ${session.workspace ?? "worker"} · ${session.openTask?.title ?? "Session"}`;
				const short = session.openTask?.title ?? `${session.id} · ${session.workspace ?? "worker"}`;
				return <div className={`worker-tab ${active === session.id ? "active" : ""}`} key={session.id}><button className={`tab ${active === session.id ? "active" : ""}`} title={label} aria-current={active === session.id ? "page" : undefined} onClick={() => setActive(session.id)}><span className={`status-dot ${session.state === "approval" ? "attention" : session.state}`} /><span className="session-tab-label">{short}</span></button><button className="close-tab" aria-label={`Close ${session.id} tab`} title="Close tab (session keeps running)" onClick={() => closeTab(session.id)}>×</button></div>;
			})}</nav><div className="pane-body">{panel && <div className="scroll" key={active}>{panel}</div>}{tabs.map(session => <div className={`session-wrap ${active !== session.id ? "hidden" : ""}`} aria-hidden={active !== session.id} key={session.id}><SessionView sessionId={session.id} focused={active === session.id} /></div>)}</div></section>
		</div>{confirm && <Confirm title={confirm === "new" ? "Start a new main chat?" : "Restart main?"} description={confirm === "new" ? "The current main session will be retired and a fresh conversation will start. Its recorded chat remains searchable. Worker sessions are kept." : "The main process will stop and resume its saved conversation. Any in-flight turn will be interrupted. Worker sessions are kept."} confirmLabel={confirm === "new" ? "Start new chat" : "Restart main"} danger onClose={() => setConfirm(null)} onConfirm={() => mutate(`/api/main/${confirm}`)} />}{taskId && <TaskDrawer id={taskId} onClose={closeTask} />}
	</div>;
}

/** Low-frequency details and main-chat lifecycle actions, kept out of the always-visible chrome. */
function MoreMenu({ onRestart, onNewChat }: { onRestart: () => void; onNewChat: () => void }) {
	const { state } = useHub();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent | KeyboardEvent) => {
			if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", close);
		return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
	}, [open]);
	if (!state) return null;
	return <div className="more-menu" ref={root}>
		<button className="icon-button more-trigger" aria-label="More" aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>
		{open && <div className="more-popover" role="menu">
			<div className="more-section">
				<div className="kv"><span className="k">Main</span><span><Status value={state.main.state} /></span><span className="k">Auto wakes</span><span>{state.main.wakesUsed} / {state.main.wakesMax}</span><span className="k">Live workers</span><span>{state.pool.live} / {state.pool.cap}</span><span className="k">omp</span><span className="mono">{state.omp.version ?? "missing"}{state.omp.managed ? " · managed" : ""}</span><span className="k">Version</span><span className="mono">{state.version}</span></div>
				<div className="more-home"><span className="mono muted" title={state.setup.homePath ?? ""}>{state.setup.homePath}</span>{state.setup.homePath && <CopyButton text={state.setup.homePath} />}</div>
			</div>
			<button role="menuitem" className="more-item" onClick={() => { setOpen(false); onRestart(); }}>Restart main</button>
			<button role="menuitem" className="more-item danger" onClick={() => { setOpen(false); onNewChat(); }}>New chat…</button>
		</div>}
	</div>;
}
