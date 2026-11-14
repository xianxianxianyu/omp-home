import { useState } from "react";
import type { EnvDTO, EscalationDTO, TaskDetail, TaskStatus, TaskSummary, WorkspaceDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Field, Loading, Modal, RelativeTime, Section, Status } from "../ui.tsx";
import { DecisionList } from "./Decisions.tsx";

const taskStatuses: { value: TaskStatus | ""; label: string }[] = [
	{ value: "", label: "All" },
	{ value: "pending", label: "Pending" },
	{ value: "working", label: "Working" },
	{ value: "awaiting", label: "Awaiting" },
	{ value: "done", label: "Done" },
	{ value: "cancelled", label: "Cancelled" },
];

export function TasksPanel() {
	const { openTask, openSession } = useHub();
	const [status, setStatus] = useState<TaskStatus | "">("");
	const [workspace, setWorkspace] = useState("");
	const [query, setQuery] = useState("");
	const params = new URLSearchParams();
	if (status) params.set("status", status);
	if (workspace) params.set("workspace", workspace);
	if (query.trim()) params.set("q", query.trim());
	const filters = params.toString();
	const tasks = useResource<TaskSummary[]>("tasks", `/api/tasks${filters ? `?${filters}` : ""}`);
	const workspaces = useResource<WorkspaceDTO[]>("workspaces", "/api/workspaces");
	const workspaceNames = new Map(workspaces.data?.map(item => [item.id, item.name]));

	return (
		<div className="scroll">
			<div className="panel-heading">
				<div><h2>Tasks</h2><p className="muted">Follow work from the brief to its final report.</p></div>
				{tasks.data && <span className="pill">{tasks.data.length} {tasks.data.length === 1 ? "task" : "tasks"}</span>}
			</div>
			<div className="filters" role="group" aria-label="Filter tasks by status">
				{taskStatuses.map(item => (
					<button
						key={item.value}
						className={`btn small pill${status === item.value ? " primary" : ""}`}
						aria-pressed={status === item.value}
						onClick={() => setStatus(item.value)}
					>
						{item.label}
					</button>
				))}
			</div>
			<div className="filters">
				<Field label="Workspace">
					<select aria-label="Filter tasks by workspace" value={workspace} onChange={event => setWorkspace(event.target.value)}>
						<option value="">All workspaces</option>
						{workspaces.data?.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? " (archived)" : ""}</option>)}
					</select>
				</Field>
				<Field label="Search tasks">
					<input type="search" aria-label="Search tasks" value={query} placeholder="Search task titles and text…" onChange={event => setQuery(event.target.value)} />
				</Field>
				{filters && <Button className="small" onClick={() => { setStatus(""); setWorkspace(""); setQuery(""); }}>Clear filters</Button>}
				{workspaces.loading && !workspaces.data && <span className="muted" role="status">Loading workspaces…</span>}
			</div>
			{workspaces.error && <ErrorState error={workspaces.error} retry={workspaces.reload} />}
			{tasks.error && <ErrorState error={tasks.error} retry={tasks.reload} />}
			{tasks.loading && !tasks.data && <Loading />}
			{tasks.data?.length === 0 && (
				<Empty title={filters ? "No matching tasks" : "No tasks yet"}>
					{filters ? "Try a different search or clear the filters." : "Ask main to investigate or build something. Assigned work will appear here."}
				</Empty>
			)}
			{tasks.data && tasks.data.length > 0 && (
				<div className="table-wrap">
					<table className="grid">
						<thead><tr><th>ID</th><th>Title</th><th>Workspace</th><th>Status</th><th>Worker</th><th>Updated</th></tr></thead>
						<tbody>
							{tasks.data.map(task => (
								<tr key={task.id} onClick={() => openTask(task.id)}>
									<td><code>{task.id}</code></td>
									<td onClick={event => event.stopPropagation()}>
										<button className="link-button" onClick={() => openTask(task.id)}>{task.title}</button>
									</td>
									<td>{workspaceNames.get(task.workspace) ?? task.workspace}</td>
									<td>
										<div className="row wrap">
											<Status value={task.status} />
											{task.wait && <span title={task.wait.text}><Status value={task.wait.kind} /></span>}
										</div>
									</td>
									<td onClick={event => event.stopPropagation()}>
										{task.sessionId ? (
											<Button className="small" title={`Open worker ${task.sessionId}`} onClick={async () => { await openSession(task.sessionId!); }}>
												{task.sessionId}
											</Button>
										) : <span className="dim">Unassigned</span>}
									</td>
									<td><RelativeTime at={task.updatedAt} /></td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function TaskTextAction({ task, kind, onClose }: { task: TaskDetail; kind: "message" | "cancel"; onClose: () => void }) {
	const { mutate, toast } = useHub();
	const [text, setText] = useState("");
	const cancelling = kind === "cancel";

	return (
		<Modal title={cancelling ? `Cancel ${task.id}?` : `Message ${task.sessionId ?? task.id}`} onClose={onClose}>
			<p className="prewrap"><strong>{task.title}</strong></p>
			<p className="muted">
				{cancelling
					? "Confirm that you want to cancel this task. Its branch and worktree are kept; clean them up separately."
					: "Send a message to the worker. This counts as human input and can resume work on the task."}
			</p>
			<Field label={cancelling ? "Cancellation reason" : "Message"} hint={cancelling ? "A reason is required and will be recorded in the task timeline." : "You can also open the worker to talk in its live terminal."}>
				<textarea
					aria-label={cancelling ? "Cancellation reason" : "Message to worker"}
					value={text}
					onChange={event => setText(event.target.value)}
					placeholder={cancelling ? "Why is this task being cancelled?" : "What should the worker do next?"}
					rows={5}
					required
					autoFocus
				/>
			</Field>
			<div className="dialog-actions">
				<Button onClick={onClose}>{cancelling ? "Keep task" : "Back"}</Button>
				<Button
					className={cancelling ? "danger" : "primary"}
					disabled={!text.trim()}
					onClick={async () => {
						await mutate<TaskDetail>(`/api/tasks/${encodeURIComponent(task.id)}/${kind}`, cancelling ? { reason: text.trim() } : { text: text.trim() }, "POST");
						toast(cancelling ? `${task.id} cancelled` : `Message sent to ${task.sessionId ?? task.id}`);
						onClose();
					}}
				>
					{cancelling ? "Cancel task" : "Send message"}
				</Button>
			</div>
		</Modal>
	);
}

function EnvironmentDetails({ env }: { env: EnvDTO | null }) {
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
	if (!env) return <Empty title="No environment">No per-worktree environment has been provisioned for this task.</Empty>;
	const vars = Object.entries(env.vars).sort(([a], [b]) => a.localeCompare(b));

	return (
		<div className="stack">
			<div className="row wrap"><Status value={env.state} /><span className="muted">Updated <RelativeTime at={env.updatedAt} /></span></div>
			{env.error && <div className="error-box prewrap" role="alert">{env.error}</div>}
			{vars.length === 0 ? <p className="muted">No environment variables recorded.</p> : (
				<div className="table-wrap">
					<table className="grid">
						<thead><tr><th>Variable</th><th>Value</th><th>Visibility</th></tr></thead>
						<tbody>
							{vars.map(([name, value]) => (
								<tr key={name}>
									<td><code>{name}</code></td>
									<td><code className="secret prewrap">{revealed.has(name) ? value : "••••••••"}</code></td>
									<td>
										<div className="actions">
											<Button className="small" title={`${revealed.has(name) ? "Hide" : "Reveal"} ${name}`} onClick={() => {
												setRevealed(previous => {
													const next = new Set(previous);
													if (next.has(name)) next.delete(name);
													else next.add(name);
													return next;
												});
											}}>{revealed.has(name) ? "Hide" : "Reveal"}</Button>
											{revealed.has(name) && <CopyButton text={value} />}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

function eventTone(kind: string): string {
	if (/cancel|fail|error|abort|interrupt/i.test(kind)) return "err";
	if (/await|block|question|approval|escalat/i.test(kind)) return "warn";
	if (/done|complet|clos|clean|resolv/i.test(kind)) return "ok";
	return "info";
}

function TaskDialog({ id, onClose }: { id: string; onClose: () => void }) {
	const { openSession, openTask, mutate } = useHub();
	const resource = useResource<TaskDetail>(`task:${id}`, `/api/tasks/${encodeURIComponent(id)}`);
	const [action, setAction] = useState<"message" | "cancel" | "cleanup" | null>(null);
	const task = resource.data;

	return (
		<Modal title={task ? `${task.id} · ${task.title}` : id} onClose={onClose} wide>
			{resource.error && <ErrorState error={resource.error} retry={resource.reload} />}
			{resource.loading && !task && <Loading />}
			{task && (
				<>
					<div className="card">
						<div className="row wrap">
							<Status value={task.status} />
							{task.wait && <Status value={task.wait.kind} />}
							<span className="pill">{task.workspace}</span>
							<span className="muted">Updated <RelativeTime at={task.updatedAt} /></span>
						</div>
						{task.wait && <p className="prewrap">{task.wait.text}</p>}
						<div className="divider" />
						<div className="kv">
							<span className="k">Branch</span><code className="prewrap">{task.branch ?? "No task branch"}</code>
							<span className="k">Worktree</span>
							<div className="row wrap"><code className="prewrap grow">{task.worktreePath ?? "No task worktree"}</code>{task.worktreePath && <CopyButton text={task.worktreePath} />}</div>
							<span className="k">Playbook</span><span className="prewrap">{task.playbook ?? "Not specified"}</span>
							<span className="k">Checkout</span>
							<div>
								{task.checkout.kind === "readonly" ? "Read-only workspace checkout" : task.checkout.kind === "worktree" ? (
									<>New worktree{task.checkout.base ? <> from <code>{task.checkout.base}</code></> : " from the workspace default base"}</>
								) : (
									<>Continue <button className="link-button" onClick={() => { if (task.checkout.kind === "continue") openTask(task.checkout.task); }}>{task.checkout.task}</button> · {task.checkout.session === "reuse" ? "reuse session" : "fresh session"}</>
								)}
							</div>
							{task.git && <><span className="k">Git</span><div className="row wrap"><code>{task.git.head}</code><span className={`pill ${task.git.dirty ? "warn" : "ok"}`}>{task.git.dirty ? "Uncommitted changes" : "Clean"}</span><span className="muted">{task.git.ahead} ahead</span></div></>}
							<span className="k">Created</span><span><RelativeTime at={task.createdAt} /></span>
							{task.related.length > 0 && <><span className="k">Related tasks</span><div className="row wrap">{task.related.map(related => <button key={related} className="link-button" onClick={() => openTask(related)}>{related}</button>)}</div></>}
						</div>
					</div>
					<div className="actions">
						<Button className="primary" disabled={!task.sessionId} onClick={async () => {
							if (task.sessionId) { await openSession(task.sessionId); onClose(); }
						}}>Open worker{task.sessionId ? ` · ${task.sessionId}` : ""}</Button>
						<Button disabled={!task.sessionId} onClick={() => setAction("message")}>Send message</Button>
						<Button className="danger" disabled={task.status === "cancelled" || task.status === "done"} onClick={() => setAction("cancel")}>Cancel</Button>
						<Button className="danger" disabled={task.checkout.kind === "readonly" || (!task.worktreePath && !task.env)} onClick={() => setAction("cleanup")}>Clean up</Button>
					</div>
					<Section title="Brief">
						{task.brief ? <div className="prewrap">{task.brief}</div> : <p className="muted">No brief recorded.</p>}
					</Section>
					<Section title="Reports">
						{task.reports.length === 0 ? <Empty title="No reports yet">Worker reports appear after work begins.</Empty> : [...task.reports].sort((a, b) => b.at - a.at).map((report, index) => (
							<article className="card" key={`${report.at}:${index}`}>
								<div className="row wrap"><Status value={report.status} /><span className="muted"><RelativeTime at={report.at} /></span></div>
								<p className="prewrap"><strong>{report.summary}</strong></p>
								{report.details && <div className="prewrap">{report.details}</div>}
							</article>
						))}
					</Section>
					<Section title="Timeline">
						{task.events.length === 0 ? <Empty title="No events yet" /> : (
							<div className="timeline">
								{[...task.events].sort((a, b) => a.at - b.at || a.id - b.id).map(event => (
									<div className={`ev ${eventTone(event.kind)}`} key={event.id}>
										<div className="prewrap">{event.summary}</div>
										<div className="when">{event.actor} · {event.kind.replaceAll("_", " ")} · <RelativeTime at={event.at} /></div>
										{Object.keys(event.data).length > 0 && <details><summary className="muted">Event data</summary><pre className="prewrap">{JSON.stringify(event.data, null, 2)}</pre></details>}
									</div>
								))}
							</div>
						)}
					</Section>
					<Section title="Decisions"><DecisionList decisions={task.decisions} /></Section>
					<Section title="Escalations">
						{task.escalations.length === 0 ? <Empty title="No escalations">Requests for human attention appear here.</Empty> : [...task.escalations].sort((a, b) => b.openedAt - a.openedAt).map(escalation => (
							<article className="card" key={escalation.id}>
								<div className="row wrap"><strong className="mono">{escalation.id}</strong><Status value={escalation.resolvedAt !== null ? "resolved" : "open"} /><span className="muted">Opened by {escalation.openedBy} · <RelativeTime at={escalation.openedAt} /></span></div>
								<p className="prewrap">{escalation.reason}</p>
								{escalation.seenAt !== null && <p className="muted">Seen <RelativeTime at={escalation.seenAt} /></p>}
								{escalation.resolvedAt !== null && <p className="muted">{escalation.resolution?.replaceAll("_", " ") ?? "Resolved"} · <RelativeTime at={escalation.resolvedAt} /></p>}
								<div className="actions">
									<Button className="small" onClick={async () => {
										await openSession(escalation.sessionId);
										if (escalation.seenAt === null && escalation.resolvedAt === null) await mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/seen`, undefined, "POST");
										onClose();
									}}>Open session</Button>
									{escalation.resolvedAt === null && <Button className="small" onClick={() => mutate<EscalationDTO>(`/api/escalations/${encodeURIComponent(escalation.id)}/dismiss`, undefined, "POST")}>Dismiss</Button>}
								</div>
							</article>
						))}
					</Section>
					<Section title="Environment variables"><EnvironmentDetails env={task.env} /></Section>
					<Section title="Envelope">
						<details><summary>Show worker envelope</summary>{task.envelope ? <pre className="prewrap">{task.envelope}</pre> : <p className="muted">No envelope recorded.</p>}</details>
					</Section>
					{(action === "message" || action === "cancel") && <TaskTextAction task={task} kind={action} onClose={() => setAction(null)} />}
					{action === "cleanup" && (
						<Confirm
							title={`Clean up ${task.id}?`}
							description={`Tear down this task’s environment and remove its worktree${task.worktreePath ? ` at ${task.worktreePath}` : ""}. Uncommitted work may be lost. The branch${task.branch ? ` ${task.branch}` : ""} is kept. This does not merge or delete the branch.`}
							confirmLabel="Tear down and remove worktree"
							danger
							onConfirm={() => mutate<TaskDetail>(`/api/tasks/${encodeURIComponent(task.id)}/cleanup`, undefined, "POST")}
							onClose={() => setAction(null)}
						/>
					)}
				</>
			)}
		</Modal>
	);
}

export function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
	return <TaskDialog key={id} id={id} onClose={onClose} />;
}
