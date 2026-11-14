import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useHub } from "./hub.tsx";
import { Button, Confirm, Empty, ErrorState, Loading } from "./ui.tsx";
import { SessionView } from "./SessionView.tsx";
import { Setup } from "./Setup.tsx";
import { Search } from "./Search.tsx";
import { Now, useNowModel } from "./Now.tsx";
import { History } from "./History.tsx";
import { TaskView } from "./TaskView.tsx";
import { SettingsSheet } from "./SettingsSheet.tsx";

export function App() {
	const { state, stateError, reload, toasts, dismissToast } = useHub();
	return <>{!state ? <div className="boot-screen"><div className="brand"><span className="dot" />omp-home</div>{stateError ? <><ErrorState error={stateError} retry={reload} /><p className="hint">Open the link printed by the hub to authorize this browser.</p></> : <Loading />}</div> : !state.setup.done ? <Setup /> : <Workspace />}
		<div className="toast-stack" aria-live="polite">{toasts.map(toast => <div role={toast.level === "error" ? "alert" : "status"} className={`toast ${toast.level === "error" ? "err" : ""}`} key={toast.id}><div className="row"><span className="grow">{toast.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => dismissToast(toast.id)}>×</button></div>{toast.action && <Button className="small" onClick={async () => { await toast.action?.run(); dismissToast(toast.id); }}>{toast.action.label}</Button>}</div>)}</div>
	</>;
}
function Workspace() {
	const { state, connected, views, popView, openSettings, settingsSection, mutate } = useHub();
	const now = useNowModel();
	const [left, setLeft] = useState(() => { const stored = Number(localStorage.getItem("omp-home-split")); return stored >= 25 && stored <= 75 ? stored : 52; });
	const [confirm, setConfirm] = useState<"restart" | "new" | null>(null);
	const search = useRef<HTMLInputElement>(null);
	const split = useRef<HTMLDivElement>(null);
	const active = views.at(-1);
	const collapsed = !active && now.empty;
	useEffect(() => {
		let composing = false;
		let compositionEnded = 0;
		const startComposition = () => { composing = true; };
		const endComposition = () => { composing = false; compositionEnded = performance.now(); };
		const key = (event: KeyboardEvent) => {
			if (event.isComposing || event.keyCode === 229 || composing || performance.now() - compositionEnded < 80 || document.querySelector("[data-modal]")) return;
			if (event.metaKey || event.ctrlKey) {
				if (event.key.toLowerCase() === "k") { event.preventDefault(); event.stopImmediatePropagation(); search.current?.focus(); }
				if (event.key === ",") { event.preventDefault(); event.stopImmediatePropagation(); openSettings(); }
			} else if (event.key === "Escape" && active && !document.querySelector('[data-menu], [aria-controls="search-results"][aria-expanded="true"]')) {
				event.preventDefault(); event.stopImmediatePropagation(); popView();
			}
		};
		window.addEventListener("keydown", key, true);
		window.addEventListener("compositionstart", startComposition, true);
		window.addEventListener("compositionend", endComposition, true);
		return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("compositionstart", startComposition, true); window.removeEventListener("compositionend", endComposition, true); };
	}, [active, popView, openSettings]);
	if (!state) return null;
	const setSplit = (value: number) => { const next = Math.max(25, Math.min(75, value)); setLeft(next); localStorage.setItem("omp-home-split", String(next)); };
	return <div className="app">
		<header className="topbar" data-tauri-drag-region><div className="brand" data-tauri-drag-region><span className="dot" />omp-home</div>{!connected && <span className="pill err">Hub disconnected · reconnecting…</span>}<div className="spacer" data-tauri-drag-region /><Search inputRef={search} /><MoreMenu onRestart={() => setConfirm("restart")} onNewChat={() => setConfirm("new")} /></header>
		<div className={`split ${collapsed ? "right-collapsed" : ""}`} ref={split} style={{ "--left": `${left}%` } as CSSProperties}>
			<section className="pane main-pane" aria-label="Main conversation">{collapsed && <p className="nothing-in-flight">Nothing in flight. Tell main what you want done.</p>}<div className="pane-body">{state.main.sessionId && state.main.state !== "cold" ? <div className="session-wrap"><SessionView key={state.main.sessionId} sessionId={state.main.sessionId} focused main /></div> : <div className="start-main"><Empty title="Your main conversation starts here"><p>Give main a goal. It will route the work, review reports,<br />and bring you in when your judgment is needed.</p><Button className="primary" onClick={() => mutate("/api/main/restart")}>Start main</Button></Empty></div>}</div></section>
			{!collapsed && <><div className="gutter" role="separator" aria-label="Resize chat and work panes" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(left)} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplit(left + (event.key === "ArrowLeft" ? -2 : 2)); } }} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = split.current?.getBoundingClientRect(); if (bounds) setSplit((event.clientX - bounds.left) / bounds.width * 100); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
				<section className="pane workspace-pane" aria-label="Current work">{active?.kind === "task" ? <TaskView key={active.id} id={active.id} /> : active?.kind === "history" ? <History /> : <Now model={now} />}</section></>}
		</div>
		{confirm && <Confirm title={confirm === "new" ? "Start a new main chat?" : "Restart main?"} description={confirm === "new" ? "The current main session will be retired and a fresh conversation will start. Its recorded chat remains searchable. Worker sessions are kept." : "The main process will stop and resume its saved conversation. Any in-flight turn will be interrupted. Worker sessions are kept."} confirmLabel={confirm === "new" ? "Start new chat" : "Restart main"} danger onClose={() => setConfirm(null)} onConfirm={() => mutate(`/api/main/${confirm}`)} />}
		{settingsSection && <SettingsSheet />}
	</div>;
}
function MoreMenu({ onRestart, onNewChat }: { onRestart: () => void; onNewChat: () => void }) {
	const { openHistory, openSettings } = useHub();
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent | KeyboardEvent) => { if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false); };
		document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
		return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
	}, [open]);
	return <div className="more-menu" ref={root}><button className="icon-button more-trigger" aria-label="More" aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>{open && <div className="more-popover" role="menu" data-menu><button role="menuitem" className="more-item" onClick={() => { setOpen(false); openHistory(); }}>History</button><button role="menuitem" className="more-item" onClick={() => { setOpen(false); openSettings(); }}>Settings… <kbd>⌘,</kbd></button><hr /><button role="menuitem" className="more-item" onClick={() => { setOpen(false); onRestart(); }}>Restart main</button><button role="menuitem" className="more-item danger" onClick={() => { setOpen(false); onNewChat(); }}>New chat…</button></div>}</div>;
}
