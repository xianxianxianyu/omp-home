import { useState } from "react";
import type { BranchDTO, BranchesDTO } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import { Button, Confirm, ErrorState, Loading, RelativeTime } from "./ui.tsx";
import "./branches.css";

export function BranchBlock({ branch, showTasks = true }: { branch: BranchDTO; showTasks?: boolean }) {
	const t = useT().branches;
	const { format } = useI18n();
	const { mutate, openTask, toast } = useHub();
	const [action, setAction] = useState<"remove" | "discard" | null>(null);
	const [pinning, setPinning] = useState(false);
	const retiring = branch.phase === "retiring" || branch.phase === "retired";
	const busy = branch.phase === "active" || branch.hold === "busy";
	const blocked = retiring || busy || branch.kept;
	const blockedReason = branch.kept ? t.unlockFirst : busy ? t.busy : undefined;
	const retired = branch.retired;
	return <article className="branch-block" data-worktree={branch.worktreeId} data-phase={branch.phase}>
		<div className="branch-heading"><code title={branch.branch}>{branch.branch}</code><span className={`pill branch-phase ${branch.phase === "active" ? "info" : branch.phase === "merged" ? "ok" : branch.phase === "retiring" ? "warn" : ""}`}>{t.phases[branch.phase]}</span></div>
		{branch.hold && <p className="branch-hold">{t.holds[branch.hold]}{branch.holdDetail && <span className="muted"> {branch.holdDetail}</span>}</p>}
		{retired ? <div className="branch-facts"><span>{t.reasons[retired.reason]}</span><RelativeTime at={retired.at} />{!retired.branchDeleted && <span>{t.branchKept}</span>}{retired.sha && <code title={`${t.sha}: ${retired.sha}`}>{retired.sha}</code>}</div> : <div className="branch-facts">
			<span>{t.comparison(branch.ahead === null ? "—" : format.number(branch.ahead), branch.behind === null ? "—" : format.number(branch.behind), branch.base)}</span>
			{branch.stale && <span className="branch-hint">{t.stale}</span>}{branch.upstreamGone && <span className="branch-hint">{t.remoteDeleted}</span>}
		</div>}
		{showTasks && branch.tasks.length > 0 && <div className="branch-tasks">{branch.tasks.map(task => <button type="button" className="branch-task" key={task.id} title={task.title} onClick={() => openTask(task.id)}><span>{task.id}</span><span className="branch-task-title">{task.title}</span>{task.settled && <span aria-hidden="true">✓</span>}</button>)}</div>}
		{!retired && <div className="branch-actions">
			<button type="button" className="btn small keep-toggle" aria-label={t.keepLabel(branch.branch)} aria-pressed={branch.kept} aria-busy={pinning} disabled={pinning || retiring || branch.phase === "parked"} onClick={async () => {
				setPinning(true);
				try { await mutate<BranchDTO>(`/api/worktrees/${encodeURIComponent(branch.worktreeId)}/keep`, { keep: !branch.kept }); }
				catch { /* The hub surfaces mutation errors. */ }
				finally { setPinning(false); }
			}}><span className="keep-indicator" aria-hidden="true">{branch.kept ? "✓" : "+"}</span>{t.keep}</button>
			{branch.phase !== "parked" && <Button className="small remove-worktree" title={blockedReason} disabled={blocked} onClick={() => setAction("remove")}>{t.remove}</Button>}
			<Button className="small danger discard-branch" title={blockedReason} disabled={blocked} onClick={() => setAction("discard")}>{t.discard}</Button>
		</div>}
		{action && <Confirm title={action === "discard" ? t.discardTitle(branch.branch) : t.removeTitle(branch.branch)} description={<><p>{action === "discard" ? t.discardDescription(branch.base) : t.removeDescription(branch.branch)}</p><code className="prewrap">{branch.path}</code></>} confirmLabel={action === "discard" ? t.discardConfirm : t.remove} danger onClose={() => setAction(null)} onConfirm={async () => {
			await mutate<BranchDTO>(`/api/worktrees/${encodeURIComponent(branch.worktreeId)}/remove`, { deleteBranch: action === "discard" });
			toast(catalog => action === "discard" ? catalog.branches.discarded(branch.branch) : catalog.branches.removed(branch.branch));
		}} />}
	</article>;
}

function BranchList({ workspace }: { workspace: string }) {
	const t = useT().branches;
	const { format } = useI18n();
	const resource = useResource<BranchesDTO>("workspaces", `/api/workspaces/${encodeURIComponent(workspace)}/branches`);
	return <div className="branch-list">
		{resource.error && <ErrorState error={resource.error} retry={resource.reload} />}
		{resource.loading && !resource.data && <Loading />}
		{resource.data && <>
			{resource.data.live.length ? resource.data.live.map(branch => <BranchBlock branch={branch} key={branch.worktreeId} />) : <p className="muted">{t.empty}</p>}
			<details className="branch-history"><summary>{t.history} <span className="muted">{format.number(resource.data.retired.length)}</span></summary>{resource.data.retired.length ? resource.data.retired.map(branch => <BranchBlock branch={branch} key={branch.worktreeId} />) : <p className="muted">{t.noHistory}</p>}</details>
		</>}
	</div>;
}

export function WorkspaceBranches({ workspace }: { workspace: string }) {
	const t = useT().branches;
	const [expanded, setExpanded] = useState(false);
	return <details className="workspace-branches" onToggle={event => setExpanded(event.currentTarget.open)}><summary>{t.title}</summary>{expanded && <BranchList workspace={workspace} />}</details>;
}
