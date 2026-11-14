import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { EscalationDTO, InboxDTO, SettingsDTO, SetupPreview, TaskDetail, TaskSummary } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { Button, Confirm, ErrorState, Loading, RelativeTime, useNow } from "./ui.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import "./now.css";

type Attention =
	| { kind: "escalation"; id: string; at: number; escalation: EscalationDTO }
	| { kind: "provision"; id: string; at: number; task: TaskSummary }
	| { kind: "paused"; id: string; at: number }
	| { kind: "warning"; id: string; at: number; text: string }
	/** Newer home skills/instructions ship with an app update; applying them backs up what they replace. */
	| { kind: "home"; id: string; at: number; preview: SetupPreview };
export interface NowModel {
	attention: Attention[];
	inFlight: TaskSummary[];
	finished: TaskSummary[];
	empty: boolean;
	loading: boolean;
	errors: { error: Error; retry: () => void }[];
	dismissFinished: (ids: string[]) => void;
}
const FINISHED_KEY = "omp-home-dismissed-finished";

export function useNowModel(): NowModel {
	const { state } = useHub();
	const inbox = useResource<InboxDTO>("inbox", "/api/inbox");
	const tasks = useResource<TaskSummary[]>("tasks", "/api/tasks?status=open");
	const closed = useResource<TaskSummary[]>("tasks", "/api/tasks?status=closed");
	const home = useResource<SetupPreview>("settings", `/api/setup/preview?home=${encodeURIComponent(state?.setup.homePath ?? "")}`);
	const homeChanges = home.data?.changes.filter(change => change.action !== "backup") ?? [];
	const now = useNow();
	const [dismissed, setDismissed] = useState<string[]>(() => {
		try { return z.array(z.string()).parse(JSON.parse(localStorage.getItem(FINISHED_KEY) ?? "[]")); }
		catch { return []; }
	});
	const attention = useMemo<Attention[]>(() => [
		...(inbox.data?.escalations.filter(item => item.resolvedAt === null).map(escalation => ({ kind: "escalation" as const, id: escalation.id, at: escalation.openedAt, escalation })) ?? []),
		...(tasks.data?.filter(task => task.wait?.kind === "provision_failed").map(task => ({ kind: "provision" as const, id: `provision:${task.id}`, at: task.updatedAt, task })) ?? []),
		...(state?.main.paused ? [{ kind: "paused" as const, id: "main-paused", at: Date.now() }] : []),
		...(state?.omp.warning ? [{ kind: "warning" as const, id: "omp-warning", at: Date.now(), text: state.omp.warning }] : []),
		...(home.data && homeChanges.length ? [{ kind: "home" as const, id: "home-templates", at: 0, preview: home.data }] : []),
	].sort((a, b) => b.at - a.at), [inbox.data, tasks.data, state?.main.paused, state?.omp.warning, home.data, homeChanges.length]);
	const finished = (closed.data ?? []).filter(task => task.endedAt !== null && task.endedAt >= now - 86400000 && !dismissed.includes(task.id)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	const errors = [inbox, tasks, closed].flatMap(resource => resource.error ? [{ error: resource.error, retry: resource.reload }] : []);
	const loading = [inbox, tasks, closed].some(resource => !resource.data && resource.loading);
	// A task that needs the human is shown once, as its attention card.
	const needsHuman = new Set(attention.flatMap(item => item.kind === "escalation" ? [item.escalation.taskId] : item.kind === "provision" ? [item.task.id] : []));
	const inFlight = (tasks.data ?? []).filter(task => !needsHuman.has(task.id));
	return {
		attention, inFlight, finished, loading, errors,
		empty: !loading && !errors.length && !attention.length && !inFlight.length && !finished.length,
		dismissFinished: ids => setDismissed(current => { const next = [...new Set([...current, ...ids])]; localStorage.setItem(FINISHED_KEY, JSON.stringify(next)); return next; }),
	};
}

function AttentionCards({ items }: { items: Attention[] }) {
	const t = useT().shell;
	const { format } = useI18n();
	const { openTask, openSettings, mutate } = useHub();
	const [visible, setVisible] = useState(items);
	const [dismiss, setDismiss] = useState<EscalationDTO | null>(null);
	const activeIds = new Set(items.map(item => item.id));
	useEffect(() => {
		setVisible(previous => [...items, ...previous.filter(item => !items.some(active => active.id === item.id))]);
		const timer = window.setTimeout(() => setVisible(items), 180);
		return () => clearTimeout(timer);
	}, [items]);
	if (!visible.length) return null;
	return <section className="now-section attention-section" aria-label={t.now.attention}><h2>{t.now.needsAttention} <span>{format.number(items.length)}</span></h2>{visible.map(item => <article className={`attention-item ${activeIds.has(item.id) ? "" : "leaving"}`} key={item.id} data-attention={item.id} data-task={item.kind === "escalation" ? item.escalation.taskId : item.kind === "provision" ? item.task.id : undefined}>
		{item.kind === "escalation" ? <><div className="attention-meta">{item.escalation.taskId} · {item.escalation.sessionId}<RelativeTime at={item.at} /></div><h3>{item.escalation.taskTitle}</h3><p>{item.escalation.reason}</p><div className="row"><Button className="small primary" onClick={async () => { openTask(item.escalation.taskId); await mutate(`/api/escalations/${encodeURIComponent(item.escalation.id)}/seen`); }}>{t.open}</Button><Button className="small" onClick={() => setDismiss(item.escalation)}>{t.dismiss}</Button></div></>
		: item.kind === "provision" ? <><div className="attention-meta">{t.now.environmentNeedsHelp}<RelativeTime at={item.at} /></div><h3>{item.task.title}</h3><p>{item.task.wait?.text}</p><Button className="small" onClick={() => openTask(item.task.id)}>{t.open}</Button></>
		: item.kind === "paused" ? <><h3>{t.now.mainWaiting}</h3><p>{t.now.wakeBudgetUsed}</p><Button className="small primary" onClick={() => mutate("/api/main/continue")}>{t.now.continueMain}</Button></>
		: item.kind === "home" ? <HomeUpdate preview={item.preview} />
		: <><h3>{t.now.ompNeedsAttention}</h3><p>{item.text}</p><Button className="small" onClick={() => openSettings("About")}>{t.now.openSettings}</Button></>}
	</article>)}{dismiss && <Confirm title={t.now.dismissTitle} description={t.now.dismissDescription} confirmLabel={t.dismiss} onClose={() => setDismiss(null)} onConfirm={() => mutate(`/api/escalations/${encodeURIComponent(dismiss.id)}/dismiss`)} />}</section>;
}

function FinishedBranchNote({ task }: { task: TaskSummary }) {
	const t = useT().branches;
	const { data } = useResource<TaskDetail>(`task:${task.id}`, `/api/tasks/${encodeURIComponent(task.id)}`);
	return data?.worktree?.retired?.reason === "merged" ? <small className="finished-branch-note">{t.mergedCleaned}</small> : null;
}

export function Now({ model }: { model: NowModel }) {
	const t = useT().shell;
	const { format } = useI18n();
	const { openTask, openHistory, mutate } = useHub();
	const [stop, setStop] = useState<TaskSummary | null>(null);
	const now = useNow();
	return <div className="now-view" aria-label={t.now.title}>
		<header className="now-heading"><h1>{t.now.title}</h1><span>{t.now.description}</span></header>
		{model.errors.map(({ error, retry }, index) => <ErrorState key={index} error={error} retry={retry} />)}
		{model.loading && <Loading />}
		<AttentionCards items={model.attention} />
		{model.inFlight.length > 0 && <section className="now-section" aria-label={t.now.inFlight}><h2>{t.now.inFlight} <span>{format.number(model.inFlight.length)}</span></h2><div className="in-flight-list">{model.inFlight.map(task => {
			const elapsed = format.duration(Math.max(0, now - (task.progress?.since ?? task.createdAt)));
			return <article className={`in-flight-card ${task.status} ${task.progress?.phase ?? ""}`} key={task.id} data-task={task.id}>
				<button className="task-card-main" onClick={() => openTask(task.id)}><span className={`status-dot ${task.progress?.phase === "approval" ? "attention" : task.progress?.phase ?? "cold"}`} /><div className="grow"><h3>{task.title}</h3><div className="task-card-meta"><span>{task.workspace}</span>{task.branch && <span className="mono" title={task.branch}>{task.branch}</span>}{task.playbook && <span className="playbook-chip">{task.playbook}</span>}</div><div className="task-progress-line"><span className="phase-label">{task.progress ? t.now.phases[task.progress.phase] : task.wait ? t.now.waiting : t.now.pending}</span><span className="elapsed">{elapsed}</span></div><p>{task.wait?.text ?? task.progress?.intent ?? task.progress?.lastEvent ?? t.now.waitingForUpdate}</p></div></button>
				{task.sessionId && task.progress?.phase !== "cold" && <details className="task-card-menu"><summary aria-label={t.now.taskActions(task.title)}>⋯</summary><button onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setStop(task); }}>{t.stopWorker}</button></details>}
			</article>;
		})}</div></section>}
		{model.finished.length > 0 && <section className="now-section finished-section" aria-label={t.now.finished}><h2>{t.now.finished} <button className="text-button" onClick={() => model.dismissFinished(model.finished.map(task => task.id))}>{t.now.clear}</button></h2>{model.finished.map(task => <div className="finished-row" key={task.id}><button className="finished-task" onClick={() => openTask(task.id)}><span className={task.status === "done" ? "finished-check" : "muted"}>{task.status === "done" ? "✓" : "−"}</span><span>{task.title}{task.branch && <FinishedBranchNote task={task} />}</span><RelativeTime at={task.endedAt} /></button><button className="icon-button" aria-label={t.now.dismissFinished(task.title)} onClick={() => model.dismissFinished([task.id])}>×</button></div>)}</section>}
		{model.empty && <p className="nothing-in-flight">{t.nothingInFlight}</p>}
		<button type="button" className="history-link" onClick={openHistory}><span>{t.history}</span><span className="muted">{t.now.allHistory}</span><span aria-hidden="true">→</span></button>
		{stop && <Confirm title={t.now.stopTitle(stop.sessionId!)} description={t.now.stopDescription} confirmLabel={t.stopWorker} danger onClose={() => setStop(null)} onConfirm={() => mutate(`/api/sessions/${encodeURIComponent(stop.sessionId!)}/evict`)} />}
	</div>;
}

function HomeUpdate({ preview }: { preview: SetupPreview }) {
	const t = useT().shell.now.homeUpdate;
	const { mutate } = useHub();
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const [confirming, setConfirming] = useState(false);
	const changes = preview.changes.filter(change => change.action !== "backup");
	return <>
		<h3>{t.title}</h3>
		<p>{t.body(changes.length)}</p>
		<Button className="small primary" disabled={!settings.data} onClick={() => setConfirming(true)}>{t.review}</Button>
		{confirming && settings.data && <Confirm
			title={t.confirmTitle}
			description={<><p>{t.confirmBody}</p><ul className="home-update-changes">{changes.map(change => <li key={change.path}><code>{change.path}</code> {change.reason}</li>)}</ul></>}
			confirmLabel={t.apply}
			onClose={() => setConfirming(false)}
			onConfirm={() => mutate("/api/setup", { homePath: preview.homePath, pstackRoot: settings.data!.pstackRoot, migrateHome: true })}
		/>}
	</>;
}
