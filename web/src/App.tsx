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
import { useI18n, useT } from "./i18n/index.tsx";

export function App() {
	const catalog = useT();
	const t = catalog.shell;
	const { format } = useI18n();
	const { state, stateError, reload, toasts, dismissToast } = useHub();
	return <>{!state ? <div className="boot-screen"><div className="brand"><span className="dot" />omp-home</div>{stateError ? <><ErrorState error={stateError} retry={reload} /><p className="hint">{t.app.authorizeBrowser}</p></> : <Loading />}</div> : !state.setup.done ? <Setup /> : <Workspace />}
		<div className="toast-stack" aria-live="polite">{toasts.map(toast => <div role={toast.level === "error" ? "alert" : "status"} className={`toast ${toast.level === "error" ? "err" : ""}`} key={toast.id}><div className="row"><span className="grow">{typeof toast.text === "function" ? toast.text(catalog, format) : toast.text}</span><button className="icon-button" aria-label={t.app.dismissNotification} onClick={() => dismissToast(toast.id)}>×</button></div>{toast.action && <Button className="small" onClick={async () => { await toast.action?.run(); dismissToast(toast.id); }}>{typeof toast.action.label === "function" ? toast.action.label(catalog, format) : toast.action.label}</Button>}</div>)}</div>
	</>;
}
function Workspace() {
	const t = useT().shell;
	const { state, connected, views, popView, openSettings, openHistory, settingsSection, mutate } = useHub();
	const now = useNowModel();
	const [left, setLeft] = useState(() => { const stored = Number(localStorage.getItem("omp-home-split")); return stored >= 25 && stored <= 75 ? stored : 52; });
	const [confirmNewChat, setConfirmNewChat] = useState(false);
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
		<header className="topbar" data-tauri-drag-region><div className="brand" data-tauri-drag-region><span className="dot" />omp-home</div>{!connected && <span className="pill err">{t.app.disconnected}</span>}<div className="spacer" data-tauri-drag-region /><Search inputRef={search} /><button type="button" className="icon-button settings-trigger" aria-label={t.settings} title={`${t.settings} (⌘,)`} onClick={() => openSettings()}>⚙</button></header>
		<div className={`split ${collapsed ? "right-collapsed" : ""}`} ref={split} style={{ "--left": `${left}%` } as CSSProperties}>
			<section className="pane main-pane" aria-label={t.app.mainConversation}>{collapsed && <p className="nothing-in-flight">{t.nothingInFlight}<button type="button" className="link-button" onClick={openHistory}>{t.history}</button></p>}<div className="pane-body">{state.main.sessionId && state.main.state !== "cold" ? <div className="session-wrap"><SessionView key={state.main.sessionId} sessionId={state.main.sessionId} focused main onNewChat={() => setConfirmNewChat(true)} /></div> : <div className="start-main"><Empty title={t.app.mainStartsHere}><p>{t.app.mainIntro}<br />{t.app.mainJudgment}</p><Button className="primary" onClick={() => mutate("/api/main/restart")}>{t.app.startMain}</Button></Empty></div>}</div></section>
			{!collapsed && <><div className="gutter" role="separator" aria-label={t.app.resizePanes} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(left)} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplit(left + (event.key === "ArrowLeft" ? -2 : 2)); } }} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = split.current?.getBoundingClientRect(); if (bounds) setSplit((event.clientX - bounds.left) / bounds.width * 100); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
				<section className="pane workspace-pane" aria-label={t.app.currentWork}>{active?.kind === "task" ? <TaskView key={active.id} id={active.id} /> : active?.kind === "history" ? <History /> : <Now model={now} />}</section></>}
		</div>
		{confirmNewChat && <Confirm title={t.app.newChatTitle} description={t.app.newChatDescription} confirmLabel={t.app.startNewChat} danger onClose={() => setConfirmNewChat(false)} onConfirm={() => mutate("/api/main/new")} />}
		{settingsSection && <SettingsSheet />}
	</div>;
}
