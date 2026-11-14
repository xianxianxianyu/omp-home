import { useState } from "react";
import type { SessionDTO, WorkspaceDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
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
	const t = useT().panels;
	const { format } = useI18n();
	const { openSession, openTask, mutate } = useHub();

	return (
		<div className="table-wrap">
			<table className="grid sessions-grid">
				<thead>
					<tr><th>{t.sessions.session}</th><th>{t.sessions.branchDirectory}</th><th>{t.sessions.model}</th><th>{t.sessions.memory}</th><th>{t.sessions.lastActivity}</th><th>{t.sessions.openTask}</th><th>{t.common.actions}</th></tr>
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
								{session.pid !== null && <div className="muted mono">{t.common.pid} {format.number(session.pid, { useGrouping: false })}</div>}
							</td>
							<td>
								<div className="mono prewrap">{session.branch ?? t.sessions.noBranch}</div>
								<div className="muted mono prewrap" title={session.cwd}>{session.cwd}</div>
							</td>
							<td><span className="mono prewrap">{session.model || t.common.default}</span></td>
							<td>{session.rssMb === null ? <span className="dim">—</span> : t.sessions.memoryValue(format.number(session.rssMb, { maximumFractionDigits: 1 }))}</td>
							<td><RelativeTime at={session.lastActivity} /></td>
							<td>
								{session.openTask ? (
									<>
										<button className="link-button" onClick={() => openTask(session.openTask!.id)}>
											{session.openTask.id} · {session.openTask.title}
										</button>
										<div><Status value={session.openTask.status} /></div>
									</>
								) : <span className="dim">{t.sessions.noTask}</span>}
							</td>
							<td>
								<div className="actions">
									<Button className="small" disabled={session.retired} onClick={async () => { await openSession(session.id); }}>
										{t.sessions.attach}
									</Button>
									<Button
										className="small"
										disabled={session.retired || session.state === "cold" || session.state === "stopping"}
										title={t.sessions.evictHint}
										onClick={() => mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(session.id)}/evict`, undefined, "POST")}
									>
										{t.sessions.evict}
									</Button>
									<Button className="small danger" disabled={session.retired} onClick={() => onRetire(session)}>
										{t.sessions.retire}
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
	const t = useT().panels;
	const { format } = useI18n();
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
	const workspaceName = (id: string | null) => id === null ? t.sessions.unassigned : names.get(id) ?? id;

	return (
		<div className="scroll">
			<div className="panel-heading">
				<div>
					<h2>{t.sessions.title}</h2>
					<p className="muted">{t.sessions.description}</p>
				</div>
				{sessions.data && <span className="pill">{t.sessions.counts(format.number(sessions.data.filter(session => !session.retired && session.state !== "cold").length), format.number(sessions.data.length))}</span>}
			</div>
			{sessions.error && <ErrorState error={sessions.error} retry={sessions.reload} />}
			{workspaces.error && <ErrorState error={workspaces.error} retry={workspaces.reload} />}
			{sessions.loading && !sessions.data && <Loading />}
			{sessions.data?.length === 0 && <Empty title={t.sessions.empty}>{t.sessions.emptyDescription}</Empty>}
			{main.length > 0 && (
				<Section title={t.common.main}>
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
					title={t.sessions.retireTitle(retiring.id)}
					description={t.sessions.retireDescription(retiring.kind === "main" ? t.common.main : t.common.worker)}
					confirmLabel={t.sessions.retireSession}
					danger
					onConfirm={() => mutate<SessionDTO>(`/api/sessions/${encodeURIComponent(retiring.id)}/retire`, undefined, "POST")}
					onClose={() => setRetiring(null)}
				/>
			)}
		</div>
	);
}
