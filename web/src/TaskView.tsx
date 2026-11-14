import { useEffect, useRef, useState } from "react";
import type { EnvDTO, EscalationDTO, SessionDTO, TaskDetail, TaskEventDTO } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import { SessionView } from "./SessionView.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Field, Loading, Modal, RelativeTime, Section, Status } from "./ui.tsx";
import { DecisionList } from "./panels/Decisions.tsx";
import { BranchBlock } from "./Branches.tsx";
import "./task-view.css";

function CancelTask({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
	const t = useT().session.task;
	const { mutate, toast } = useHub();
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cancel = async () => {
		if (busy || !reason.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await mutate<TaskDetail>(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { reason: reason.trim() }, "POST");
			toast(t => t.session.task.cancelled(task.id));
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal title={t.cancelTitle(task.id)} onClose={() => { if (!busy) onClose(); }}>
			<form onSubmit={event => { event.preventDefault(); void cancel(); }}>
				<p className="prewrap"><strong>{task.title}</strong></p>
				<p className="muted">{t.cancelDescription}</p>
				<Field label={t.cancelReason} hint={t.cancelReasonHint}>
					<textarea aria-label={t.cancelReason} value={reason} onChange={event => setReason(event.target.value)} placeholder={t.cancelPlaceholder} rows={5} required autoFocus disabled={busy} />
				</Field>
				{error && <p className="error-text" role="alert">{error}</p>}
				<div className="dialog-actions">
					<Button disabled={busy} onClick={onClose}>{t.keep}</Button>
					<Button type="submit" className="danger" disabled={busy || !reason.trim()}>{busy ? t.cancelling : t.cancel}</Button>
				</div>
			</form>
		</Modal>
	);
}

function TaskActions({ task }: { task: TaskDetail }) {
	const t = useT().session.task;
	const { mutate, toast } = useHub();
	const [open, setOpen] = useState(false);
	const [action, setAction] = useState<"cancel" | "evict" | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const closed = task.status === "done" || task.status === "cancelled";
	const sessionId = task.sessionId;
	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);
	const choose = (next: "cancel" | "evict") => { setOpen(false); setAction(next); };
	return (
		<div className="more-menu task-actions" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
			<button className="icon-button more-trigger" aria-label={t.actions} aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>
			{open && <div className="more-popover task-action-popover" role="group" aria-label={t.actions} data-menu>
				<button className="more-item" disabled={!task.worktreePath} onClick={async () => {
					if (!task.worktreePath) return;
					setOpen(false);
					try { await navigator.clipboard.writeText(task.worktreePath); toast(t => t.session.task.pathCopied); }
					catch (cause) { toast(cause instanceof Error ? cause.message : t => t.session.task.clipboardError, "error"); }
				}}>{t.copyPath}</button>
				<button className="more-item danger" disabled={closed} onClick={() => choose("cancel")}>{t.cancelMenu}</button>
				<button className="more-item danger" disabled={!sessionId} onClick={() => choose("evict")}>{t.stopWorkerMenu}</button>
			</div>}
			{action === "cancel" && !closed && <CancelTask task={task} onClose={() => setAction(null)} />}
			{action === "evict" && sessionId && <Confirm
				title={t.stopWorkerTitle(sessionId)}
				description={t.stopWorkerDescription}
				confirmLabel={t.stopWorker}
				danger
				onConfirm={async () => {
					await mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(sessionId)}/evict`, undefined, "POST");
					toast(t => t.session.task.stopped(sessionId));
				}}
				onClose={() => setAction(null)}
			/>}
		</div>
	);
}

function EnvironmentDetails({ env }: { env: EnvDTO | null }) {
	const t = useT().session.task;
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
	if (!env) return <p className="muted">{t.noEnvironment}</p>;
	const vars = Object.entries(env.vars).sort(([a], [b]) => a.localeCompare(b));
	return (
		<div className="stack">
			<div className="row wrap"><Status value={env.state} /><span className="muted">{t.updated} <RelativeTime at={env.updatedAt} /></span></div>
			{env.error && <div className="error-box prewrap" role="alert">{env.error}</div>}
			{vars.length === 0 ? <p className="muted">{t.noVariables}</p> : <div className="table-wrap">
				<table className="grid">
					<thead><tr><th>{t.variable}</th><th>{t.value}</th><th>{t.visibility}</th></tr></thead>
					<tbody>{vars.map(([name, value]) => <tr key={name}>
						<td><code>{name}</code></td>
						<td><code className="secret prewrap">{revealed.has(name) ? value : "••••••••"}</code></td>
						<td><div className="actions">
							<Button className="small" title={revealed.has(name) ? t.hideVariable(name) : t.revealVariable(name)} onClick={() => setRevealed(previous => {
								const next = new Set(previous);
								if (next.has(name)) next.delete(name);
								else next.add(name);
								return next;
							})}>{revealed.has(name) ? t.hide : t.reveal}</Button>
							{revealed.has(name) && <CopyButton text={value} />}
						</div></td>
					</tr>)}</tbody>
				</table>
			</div>}
		</div>
	);
}

function eventTone(kind: string): string {
	if (/cancel|fail|error|abort|interrupt/i.test(kind)) return "err";
	if (/await|block|question|approval|escalat/i.test(kind)) return "warn";
	if (/done|complet|clos|clean|resolv/i.test(kind)) return "ok";
	return "info";
}

function TaskTimeline({ events }: { events: TaskEventDTO[] }) {
	const t = useT().session;
	if (events.length === 0) return <p className="muted">{t.task.noEvents}</p>;
	return <div className="timeline">{[...events].sort((a, b) => a.at - b.at || a.id - b.id).map(event => <div className={`ev ${eventTone(event.kind)}`} key={event.id}>
		<div className="prewrap">{event.summary}</div>
		<div className="when">{t.actors[event.actor]} · {Object.hasOwn(t.events, event.kind) ? t.events[event.kind as keyof typeof t.events] : event.kind} · <RelativeTime at={event.at} /></div>
		{Object.keys(event.data).length > 0 && <details><summary className="muted">{t.task.eventData}</summary><pre className="prewrap">{JSON.stringify(event.data, null, 2)}</pre></details>}
	</div>)}</div>;
}

function TaskContent({ task }: { task: TaskDetail }) {
	const { task: t, actors } = useT().session;
	const { popView, openTask, openSession, mutate } = useHub();
	const closed = task.status === "done" || task.status === "cancelled";
	const checkout = task.checkout;
	const failed = task.wait?.kind === "provision_failed" || task.wait?.kind === "error" || task.env?.state === "failed";
	return <>
		<header className="task-view-header">
			<button className="icon-button task-back" aria-label={t.back} title={t.backHint} onClick={popView}>←</button>
			<div className="task-view-heading">
				<h2 title={task.title}>{task.title}</h2>
				<div className="task-view-meta"><span>{task.id} · {task.workspace}</span>{task.branch && <code title={task.branch}>{task.branch}</code>}</div>
				{task.worktreePath && <div className="task-view-path mono" title={task.worktreePath}>{task.worktreePath}</div>}
			</div>
			<Status value={task.status} />
			<TaskActions key={task.id} task={task} />
		</header>
		{task.worktree ? <div className="task-branch"><BranchBlock branch={task.worktree} showTasks={false} /></div> : checkout.lane === "main" && <p className="task-main-checkout">{checkout.edit ? t.mainEditing : t.mainReadonly}</p>}
		{(task.wait || task.env?.error) && <div className={`task-wait${failed ? " error" : ""}`} role={failed ? "alert" : "status"}>
			{task.wait && <><Status value={task.wait.kind} /><p className="prewrap">{task.wait.text}</p></>}
			{task.env?.error && task.env.error !== task.wait?.text && <p className="prewrap">{task.env.error}</p>}
		</div>}
		<details className="task-details">
			<summary>{t.details}</summary>
			<div className="task-details-body">
				<Section title={t.brief}>{task.brief ? <div className="prewrap">{task.brief}</div> : <p className="muted">{t.noBrief}</p>}</Section>
				<Section title={t.context}>
					<div className="kv">
						<span className="k">{t.playbook}</span><span className="prewrap">{task.playbook ?? t.notSpecified}</span>
						<span className="k">{t.checkout}</span><div>{checkout.lane === "main" ? checkout.edit ? t.mainEditing : t.mainReadonly : <code>{checkout.branch}</code>}</div>
						<span className="k">{t.created}</span><span><RelativeTime at={task.createdAt} /></span>
						<span className="k">{t.updated}</span><span><RelativeTime at={task.updatedAt} /></span>
						{task.endedAt !== null && <><span className="k">{t.ended}</span><span><RelativeTime at={task.endedAt} /></span></>}
						{task.related.length > 0 && <><span className="k">{t.related}</span><div className="row wrap">{task.related.map(related => <button key={related} className="link-button" onClick={() => openTask(related)}>{related}</button>)}</div></>}
					</div>
				</Section>
				{task.reports.length > 0 && <Section title={t.reports}>{[...task.reports].sort((a, b) => b.at - a.at).map((report, index) => <article className="card" key={`${report.at}:${index}`}>
					<div className="row wrap"><Status value={report.status} /><span className="muted"><RelativeTime at={report.at} /></span></div>
					<p className="prewrap"><strong>{report.summary}</strong></p>
					{report.details && <div className="prewrap">{report.details}</div>}
				</article>)}</Section>}
				{task.sessionId && <Section title={t.timeline}><TaskTimeline events={task.events} /></Section>}
				<Section title={t.decisions}><DecisionList decisions={task.decisions} /></Section>
				{task.escalations.length > 0 && <Section title={t.escalations}>{[...task.escalations].sort((a, b) => b.openedAt - a.openedAt).map(escalation => <article className="card" key={escalation.id}>
					<div className="row wrap"><strong className="mono">{escalation.id}</strong><Status value={escalation.resolvedAt !== null ? "resolved" : "open"} /><span className="muted">{t.openedBy(actors[escalation.openedBy])} · <RelativeTime at={escalation.openedAt} /></span></div>
					<p className="prewrap">{escalation.reason}</p>
					{escalation.seenAt !== null && <p className="muted">{t.seen} <RelativeTime at={escalation.seenAt} /></p>}
					{escalation.resolvedAt !== null && <p className="muted">{escalation.resolution ? t.resolutions[escalation.resolution] : t.resolved} · <RelativeTime at={escalation.resolvedAt} /></p>}
					<div className="actions">
						{escalation.sessionId !== task.sessionId ? <Button className="small" onClick={async () => {
							await openSession(escalation.sessionId);
							if (escalation.seenAt === null && escalation.resolvedAt === null) await mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/seen`, undefined, "POST");
						}}>{t.openRelatedSession}</Button> : escalation.seenAt === null && escalation.resolvedAt === null && <Button className="small" onClick={() => mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/seen`, undefined, "POST")}>{t.markSeen}</Button>}
						{escalation.resolvedAt === null && <Button className="small" onClick={() => mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/dismiss`, undefined, "POST")}>{t.dismiss}</Button>}
					</div>
				</article>)}</Section>}
				<Section title={t.environment}><EnvironmentDetails env={task.env} /></Section>
				{task.envelope && <details><summary>{t.workerEnvelope}</summary><pre className="prewrap">{task.envelope}</pre></details>}
			</div>
		</details>
		{task.sessionId ? <div className="task-worker"><SessionView key={task.sessionId} sessionId={task.sessionId} focused /></div> : <div className="task-provisioning">
			<Section title={closed ? t.taskTimeline : t.provisioningTimeline}>
				<p className="muted" role="status">{closed ? t.closedWithoutSession : task.wait ? t.noSessionYet : task.progress?.intent ?? task.progress?.lastEvent ?? (task.progress?.phase === "queued" ? t.waitingForWorker : t.preparing)}</p>
				<TaskTimeline events={task.events} />
			</Section>
		</div>}
	</>;
}

export function TaskView({ id }: { id: string }) {
	const t = useT().session.task;
	const { popView } = useHub();
	const resource = useResource<TaskDetail>(`task:${id}`, `/api/tasks/${encodeURIComponent(id)}`);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const focus = (event: Event) => {
			if (event instanceof CustomEvent && event.detail === id) {
				(root.current?.querySelector<HTMLTextAreaElement>(".composer textarea") ?? root.current)?.focus();
			}
		};
		window.addEventListener("focus-task", focus);
		return () => window.removeEventListener("focus-task", focus);
	}, [id]);
	return <div className="task-view" ref={root} tabIndex={-1}>
		{resource.data ? <TaskContent key={id} task={resource.data} /> : <header className="task-view-header"><button className="icon-button task-back" aria-label={t.back} title={t.backHint} onClick={popView}>←</button><h2>{id}</h2></header>}
		{resource.error && <div className="task-load-error"><ErrorState error={resource.error} retry={resource.reload} /></div>}
		{resource.loading && !resource.data && <Loading />}
		{!resource.loading && !resource.data && !resource.error && <Empty title={t.notFound} />}
	</div>;
}
