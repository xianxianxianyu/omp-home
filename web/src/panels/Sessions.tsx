import { useState } from "react";
import type { SessionDTO, WorkspaceDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { Button, Confirm, Empty, ErrorState, Loading, RelativeTime, Section, Status } from "../ui.tsx";

function sessionDot(session: SessionDTO): string {
	if (session.retired) return "dead";
	switch (session.state) {
		case "starting":
		case "running": return "running";
		case "idle": return "idle";
		case "approval":
		case "stopping": return "attention";
		case "cold": return "";
	}
}

function SessionTable({ sessions, onRetire }: { sessions: SessionDTO[]; onRetire: (session: SessionDTO) => void }) {
	const { openSession, openTask, mutate } = useHub();

	return (
		<div className="table-wrap">
			<table className="grid sessions-grid">
				<thead>
					<tr><th>Session</th><th>Branch / working directory</th><th>Model</th><th>RSS</th><th>Last activity</th><th>Open task</th><th>Actions</th></tr>
				</thead>
				<tbody>
					{[...sessions].sort((a, b) => Number(a.retired) - Number(b.retired) || (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt)).map(session => (
						<tr key={session.id}>
							<td>
								<div className="row">
									<span className={`status-dot ${sessionDot(session)}`} aria-hidden="true" />
									<strong className="mono">{session.id}</strong>
								</div>
								<Status value={session.retired ? "retired" : session.state} />
								{session.pid !== null && <div className="muted mono">PID {session.pid}</div>}
							</td>
							<td>
								<div className="mono prewrap">{session.branch ?? "No branch"}</div>
								<div className="muted mono prewrap" title={session.cwd}>{session.cwd}</div>
							</td>
							<td><span className="mono prewrap">{session.model || "Default"}</span></td>
							<td>{session.rssMb === null ? <span className="dim">—</span> : `${session.rssMb.toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`}</td>
							<td><RelativeTime at={session.lastActivity} /></td>
							<td>
								{session.openTask ? (
									<>
										<button className="link-button" onClick={() => openTask(session.openTask!.id)}>
											{session.openTask.id} · {session.openTask.title}
										</button>
										<div><Status value={session.openTask.status} /></div>
									</>
								) : <span className="dim">No open task</span>}
							</td>
							<td>
								<div className="actions">
									<Button className="small" disabled={session.retired} onClick={async () => { await openSession(session.id); }}>
										Attach
									</Button>
									<Button
										className="small"
										disabled={session.retired || session.state === "cold" || session.state === "stopping"}
										title="Stop the live process; its saved conversation can be attached again."
										onClick={() => mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(session.id)}/evict`, undefined, "POST")}
									>
										Evict
									</Button>
									<Button className="small danger" disabled={session.retired} onClick={() => onRetire(session)}>
										Retire
									</Button>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function SessionsPanel() {
	const { mutate } = useHub();
	const sessions = useResource<SessionDTO[]>("sessions", "/api/sessions");
	const workspaces = useResource<WorkspaceDTO[]>("workspaces", "/api/workspaces");
	const [retiring, setRetiring] = useState<SessionDTO | null>(null);
	const names = new Map(workspaces.data?.map(workspace => [workspace.id, workspace.name]));
	const main: SessionDTO[] = [];
	const workers = new Map<string | null, SessionDTO[]>();
	for (const session of sessions.data ?? []) {
		if (session.kind === "main") {
			main.push(session);
		} else {
			const group = workers.get(session.workspace);
			if (group) group.push(session);
			else workers.set(session.workspace, [session]);
		}
	}
	const workspaceName = (id: string | null) => id === null ? "Unassigned workspace" : names.get(id) ?? id;

	return (
		<div className="scroll">
			<div className="panel-heading">
				<div>
					<h2>Sessions</h2>
					<p className="muted">Attach to a conversation, or free a live process without losing its history.</p>
				</div>
				{sessions.data && <span className="pill">{sessions.data.filter(session => !session.retired && session.state !== "cold").length} live / {sessions.data.length} total</span>}
			</div>
			{sessions.error && <ErrorState error={sessions.error} retry={sessions.reload} />}
			{workspaces.error && <ErrorState error={workspaces.error} retry={workspaces.reload} />}
			{sessions.loading && !sessions.data && <Loading />}
			{sessions.data?.length === 0 && <Empty title="No sessions yet">Sessions appear when main starts or assigns work to a worker.</Empty>}
			{main.length > 0 && (
				<Section title="Main">
					<SessionTable sessions={main} onRetire={setRetiring} />
				</Section>
			)}
			{[...workers].sort(([a], [b]) => workspaceName(a).localeCompare(workspaceName(b))).map(([workspace, group]) => (
				<Section title={workspaceName(workspace)} key={workspace ?? "unassigned"}>
					<SessionTable sessions={group} onRetire={setRetiring} />
				</Section>
			))}
			{retiring && (
				<Confirm
					title={`Retire ${retiring.id}?`}
					description={`End this ${retiring.kind === "main" ? "main" : "worker"} session and stop its process. It will no longer be available to attach. Task worktrees and branches are kept; clean them up separately.`}
					confirmLabel="Retire session"
					danger
					onConfirm={() => mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(retiring.id)}/retire`, undefined, "POST")}
					onClose={() => setRetiring(null)}
				/>
			)}
		</div>
	);
}
