import { useEffect, useRef, useState } from "react";
import type { EnvDTO, EscalationDTO, SessionDTO, TaskDetail, TaskEventDTO } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { SessionView } from "./SessionView.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Field, Loading, Modal, RelativeTime, Section, Status } from "./ui.tsx";
import { DecisionList } from "./panels/Decisions.tsx";
import "./task-view.css";

function CancelTask({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
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
			toast(`${task.id} cancelled`);
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal title={`Cancel ${task.id}?`} onClose={() => { if (!busy) onClose(); }}>
			<form onSubmit={event => { event.preventDefault(); void cancel(); }}>
				<p className="prewrap"><strong>{task.title}</strong></p>
				<p className="muted">Cancel this task and stop its current work. Its branch and worktree are kept; clean them up separately.</p>
				<Field label="Cancellation reason" hint="A reason is required and will be recorded in the task timeline.">
					<textarea aria-label="Cancellation reason" value={reason} onChange={event => setReason(event.target.value)} placeholder="Why is this task being cancelled?" rows={5} required autoFocus disabled={busy} />
				</Field>
				{error && <p className="error-text" role="alert">{error}</p>}
				<div className="dialog-actions">
					<Button disabled={busy} onClick={onClose}>Keep task</Button>
					<Button type="submit" className="danger" disabled={busy || !reason.trim()}>{busy ? "Cancelling…" : "Cancel task"}</Button>
				</div>
			</form>
		</Modal>
	);
}

function TaskActions({ task }: { task: TaskDetail }) {
	const { mutate, toast } = useHub();
	const [open, setOpen] = useState(false);
	const [action, setAction] = useState<"cancel" | "cleanup" | "evict" | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const closed = task.status === "done" || task.status === "cancelled";
	const canCleanup = closed && task.checkout.kind !== "readonly" && Boolean(task.worktreePath || (task.env && task.env.state !== "torn_down"));
	const sessionId = task.sessionId;
	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);
	const choose = (next: "cancel" | "cleanup" | "evict") => { setOpen(false); setAction(next); };
	return (
		<div className="more-menu task-actions" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
			<button className="icon-button more-trigger" aria-label="Task actions" aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>
			{open && <div className="more-popover task-action-popover" role="group" aria-label="Task actions" data-menu>
				<button className="more-item" disabled={!task.worktreePath} onClick={async () => {
					if (!task.worktreePath) return;
					setOpen(false);
					try { await navigator.clipboard.writeText(task.worktreePath); toast("Worktree path copied"); }
					catch (cause) { toast(cause instanceof Error ? cause.message : "Could not access the clipboard", "error"); }
				}}>Copy worktree path</button>
				<button className="more-item danger" disabled={closed} onClick={() => choose("cancel")}>Cancel task…</button>
				<button className="more-item danger" disabled={!canCleanup} title={!closed ? "Finish or cancel this task before cleaning up." : !canCleanup ? "No task worktree or environment to clean up." : undefined} onClick={() => choose("cleanup")}>Clean up…</button>
				<button className="more-item danger" disabled={!sessionId} onClick={() => choose("evict")}>Stop worker…</button>
			</div>}
			{action === "cancel" && !closed && <CancelTask task={task} onClose={() => setAction(null)} />}
			{action === "cleanup" && canCleanup && <Confirm
				title={`Clean up ${task.id}?`}
				description={`Tear down this task’s environment and remove its worktree${task.worktreePath ? ` at ${task.worktreePath}` : ""}. Uncommitted work may be lost. The branch${task.branch ? ` ${task.branch}` : ""} is kept. This does not merge or delete the branch. Its worker session will be retired.`}
				confirmLabel="Tear down and remove worktree"
				danger
				onConfirm={async () => {
					await mutate<TaskDetail>(`/api/tasks/${encodeURIComponent(task.id)}/cleanup`, undefined, "POST");
					toast(`${task.id} cleaned up`);
				}}
				onClose={() => setAction(null)}
			/>}
			{action === "evict" && sessionId && <Confirm
				title={`Stop worker ${sessionId}?`}
				description="Stop the live worker process without cancelling its task or deleting its saved conversation, branch, or worktree. It can resume when you send another message or reopen its session. A worker running a turn must finish or have its task cancelled first."
				confirmLabel="Stop worker"
				danger
				onConfirm={async () => {
					await mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(sessionId)}/evict`, undefined, "POST");
					toast(`${sessionId} stopped`);
				}}
				onClose={() => setAction(null)}
			/>}
		</div>
	);
}

function EnvironmentDetails({ env }: { env: EnvDTO | null }) {
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
	if (!env) return <p className="muted">No per-worktree environment has been provisioned.</p>;
	const vars = Object.entries(env.vars).sort(([a], [b]) => a.localeCompare(b));
	return (
		<div className="stack">
			<div className="row wrap"><Status value={env.state} /><span className="muted">Updated <RelativeTime at={env.updatedAt} /></span></div>
			{env.error && <div className="error-box prewrap" role="alert">{env.error}</div>}
			{vars.length === 0 ? <p className="muted">No environment variables recorded.</p> : <div className="table-wrap">
				<table className="grid">
					<thead><tr><th>Variable</th><th>Value</th><th>Visibility</th></tr></thead>
					<tbody>{vars.map(([name, value]) => <tr key={name}>
						<td><code>{name}</code></td>
						<td><code className="secret prewrap">{revealed.has(name) ? value : "••••••••"}</code></td>
						<td><div className="actions">
							<Button className="small" title={`${revealed.has(name) ? "Hide" : "Reveal"} ${name}`} onClick={() => setRevealed(previous => {
								const next = new Set(previous);
								if (next.has(name)) next.delete(name);
								else next.add(name);
								return next;
							})}>{revealed.has(name) ? "Hide" : "Reveal"}</Button>
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
	if (events.length === 0) return <p className="muted">No events recorded yet.</p>;
	return <div className="timeline">{[...events].sort((a, b) => a.at - b.at || a.id - b.id).map(event => <div className={`ev ${eventTone(event.kind)}`} key={event.id}>
		<div className="prewrap">{event.summary}</div>
		<div className="when">{event.actor} · {event.kind.replaceAll("_", " ")} · <RelativeTime at={event.at} /></div>
		{Object.keys(event.data).length > 0 && <details><summary className="muted">Event data</summary><pre className="prewrap">{JSON.stringify(event.data, null, 2)}</pre></details>}
	</div>)}</div>;
}

function TaskContent({ task }: { task: TaskDetail }) {
	const { popView, openTask, openSession, mutate } = useHub();
	const closed = task.status === "done" || task.status === "cancelled";
	const checkout = task.checkout;
	const failed = task.wait?.kind === "provision_failed" || task.wait?.kind === "error" || task.env?.state === "failed";
	return <>
		<header className="task-view-header">
			<button className="icon-button task-back" aria-label="Back" title="Back · Esc" onClick={popView}>←</button>
			<div className="task-view-heading">
				<h2 title={task.title}>{task.title}</h2>
				<div className="task-view-meta"><span>{task.id} · {task.workspace}</span>{task.branch && <code title={task.branch}>{task.branch}</code>}</div>
				{task.worktreePath && <div className="task-view-path mono" title={task.worktreePath}>{task.worktreePath}</div>}
			</div>
			<Status value={task.status} />
			<TaskActions key={task.id} task={task} />
		</header>
		{(task.wait || task.env?.error) && <div className={`task-wait${failed ? " error" : ""}`} role={failed ? "alert" : "status"}>
			{task.wait && <><Status value={task.wait.kind} /><p className="prewrap">{task.wait.text}</p></>}
			{task.env?.error && task.env.error !== task.wait?.text && <p className="prewrap">{task.env.error}</p>}
		</div>}
		<details className="task-details">
			<summary>Details</summary>
			<div className="task-details-body">
				<Section title="Brief">{task.brief ? <div className="prewrap">{task.brief}</div> : <p className="muted">No brief recorded.</p>}</Section>
				<Section title="Context">
					<div className="kv">
						<span className="k">Playbook</span><span className="prewrap">{task.playbook ?? "Not specified"}</span>
						<span className="k">Checkout</span><div>{checkout.kind === "readonly" ? "Read-only workspace checkout" : checkout.kind === "worktree" ? <>
							New worktree{checkout.base ? <> from <code>{checkout.base}</code></> : " from the workspace default base"}
						</> : <>Continue <button className="link-button" onClick={() => openTask(checkout.task)}>{checkout.task}</button> · {checkout.session === "reuse" ? "reuse session" : "fresh session"}</>}</div>
						{task.git && <><span className="k">Git</span><div className="row wrap"><code>{task.git.head}</code><span className={`pill ${task.git.dirty ? "warn" : "ok"}`}>{task.git.dirty ? "Uncommitted changes" : "Clean"}</span><span className="muted">{task.git.ahead} ahead</span></div></>}
						<span className="k">Created</span><span><RelativeTime at={task.createdAt} /></span>
						<span className="k">Updated</span><span><RelativeTime at={task.updatedAt} /></span>
						{task.endedAt !== null && <><span className="k">Ended</span><span><RelativeTime at={task.endedAt} /></span></>}
						{task.related.length > 0 && <><span className="k">Related tasks</span><div className="row wrap">{task.related.map(related => <button key={related} className="link-button" onClick={() => openTask(related)}>{related}</button>)}</div></>}
					</div>
				</Section>
				{task.reports.length > 0 && <Section title="Reports">{[...task.reports].sort((a, b) => b.at - a.at).map((report, index) => <article className="card" key={`${report.at}:${index}`}>
					<div className="row wrap"><Status value={report.status} /><span className="muted"><RelativeTime at={report.at} /></span></div>
					<p className="prewrap"><strong>{report.summary}</strong></p>
					{report.details && <div className="prewrap">{report.details}</div>}
				</article>)}</Section>}
				{task.sessionId && <Section title="Timeline"><TaskTimeline events={task.events} /></Section>}
				<Section title="Decisions"><DecisionList decisions={task.decisions} /></Section>
				{task.escalations.length > 0 && <Section title="Escalations">{[...task.escalations].sort((a, b) => b.openedAt - a.openedAt).map(escalation => <article className="card" key={escalation.id}>
					<div className="row wrap"><strong className="mono">{escalation.id}</strong><Status value={escalation.resolvedAt !== null ? "resolved" : "open"} /><span className="muted">Opened by {escalation.openedBy} · <RelativeTime at={escalation.openedAt} /></span></div>
					<p className="prewrap">{escalation.reason}</p>
					{escalation.seenAt !== null && <p className="muted">Seen <RelativeTime at={escalation.seenAt} /></p>}
					{escalation.resolvedAt !== null && <p className="muted">{escalation.resolution?.replaceAll("_", " ") ?? "Resolved"} · <RelativeTime at={escalation.resolvedAt} /></p>}
					<div className="actions">
						{escalation.sessionId !== task.sessionId ? <Button className="small" onClick={async () => {
							await openSession(escalation.sessionId);
							if (escalation.seenAt === null && escalation.resolvedAt === null) await mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/seen`, undefined, "POST");
						}}>Open related session</Button> : escalation.seenAt === null && escalation.resolvedAt === null && <Button className="small" onClick={() => mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/seen`, undefined, "POST")}>Mark seen</Button>}
						{escalation.resolvedAt === null && <Button className="small" onClick={() => mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/dismiss`, undefined, "POST")}>Dismiss</Button>}
					</div>
				</article>)}</Section>}
				<Section title="Environment"><EnvironmentDetails env={task.env} /></Section>
				{task.envelope && <details><summary>Worker envelope</summary><pre className="prewrap">{task.envelope}</pre></details>}
			</div>
		</details>
		{task.sessionId ? <div className="task-worker"><SessionView key={task.sessionId} sessionId={task.sessionId} focused /></div> : <div className="task-provisioning">
			<Section title={closed ? "Task timeline" : "Provisioning timeline"}>
				<p className="muted" role="status">{closed ? "This task closed without a worker session." : task.wait ? "No worker session has been assigned yet." : task.progress?.intent ?? task.progress?.lastEvent ?? (task.progress?.phase === "queued" ? "Waiting for an available worker slot." : "Preparing the task’s checkout and environment. Its worker conversation will appear here when ready.")}</p>
				<TaskTimeline events={task.events} />
			</Section>
		</div>}
	</>;
}

export function TaskView({ id }: { id: string }) {
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
		{resource.data ? <TaskContent key={id} task={resource.data} /> : <header className="task-view-header"><button className="icon-button task-back" aria-label="Back" title="Back · Esc" onClick={popView}>←</button><h2>{id}</h2></header>}
		{resource.error && <div className="task-load-error"><ErrorState error={resource.error} retry={resource.reload} /></div>}
		{resource.loading && !resource.data && <Loading />}
		{!resource.loading && !resource.data && !resource.error && <Empty title="Task not found" />}
	</div>;
}
