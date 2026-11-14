import { useState } from "react";
import type { DecisionDTO, TaskSummary, WorkspaceDTO } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { DecisionList } from "./panels/Decisions.tsx";
import { Empty, ErrorState, Loading, RelativeTime, Status } from "./ui.tsx";
import { useT } from "./i18n/index.tsx";

export function History() {
	const t = useT().shell;
	const { popView, openTask } = useHub();
	const [filter, setFilter] = useState<"closed" | "done" | "cancelled" | "decisions">("closed");
	const [query, setQuery] = useState("");
	const [workspace, setWorkspace] = useState("");
	const tasks = useResource<TaskSummary[]>("tasks", "/api/tasks?status=closed");
	const allTasks = useResource<TaskSummary[]>("tasks", "/api/tasks");
	const decisions = useResource<DecisionDTO[]>("decisions", "/api/decisions");
	const workspaces = useResource<WorkspaceDTO[]>("workspaces", "/api/workspaces");
	const needle = query.trim().toLowerCase();
	const visibleTasks = (tasks.data ?? []).filter(task => (filter === "closed" || task.status === filter) && (!workspace || task.workspace === workspace) && `${task.id} ${task.title} ${task.branch ?? ""}`.toLowerCase().includes(needle)).sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
	const visibleDecisions = (decisions.data ?? []).filter(decision => (!workspace || allTasks.data?.some(task => task.id === decision.taskId && task.workspace === workspace)) && `${decision.id} ${decision.taskId ?? ""} ${decision.summary} ${decision.why}`.toLowerCase().includes(needle));
	const resource = filter === "decisions" ? decisions : tasks;
	return <section className="history-view" aria-label={t.history}><header className="pushed-heading"><button className="icon-button back-button" aria-label={t.back} onClick={popView}>‹</button><div><h1>{t.history}</h1><p>{t.past.description}</p></div></header><div className="history-body">
		<div className="history-filters"><input className="search" aria-label={t.past.searchLabel} placeholder={t.past.searchPlaceholder} value={query} onChange={event => setQuery(event.target.value)} /><select aria-label={t.past.filter} value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="closed">{t.past.allFinished}</option><option value="done">{t.past.done}</option><option value="cancelled">{t.past.cancelled}</option><option value="decisions">{t.past.decisions}</option></select><select aria-label={t.past.workspace} value={workspace} onChange={event => setWorkspace(event.target.value)}><option value="">{t.past.allWorkspaces}</option>{workspaces.data?.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
		{resource.error && <ErrorState error={resource.error} retry={resource.reload} />}{workspaces.error && <ErrorState error={workspaces.error} retry={workspaces.reload} />}{filter === "decisions" && workspace && allTasks.error && <ErrorState error={allTasks.error} retry={allTasks.reload} />}
		{resource.loading && !resource.data ? <Loading /> : filter === "decisions" ? <DecisionList decisions={visibleDecisions} /> : visibleTasks.length ? <div className="history-list">{visibleTasks.map(task => <button className="history-row" key={task.id} onClick={() => openTask(task.id)}><div className="grow"><h3>{task.title}</h3><span className="muted">{task.id} · {task.workspace}</span></div><Status value={task.status} /><RelativeTime at={task.endedAt} /><span className="history-chevron">›</span></button>)}</div> : <Empty title={t.past.noMatches}>{t.past.emptyDescription}</Empty>}
	</div></section>;
}
