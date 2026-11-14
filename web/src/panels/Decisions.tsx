import { useState } from "react";
import type { DecisionDTO } from "../../../shared/api.ts";
import { useHub } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { Button, Confirm, Empty, RelativeTime, Status, useNow } from "../ui.tsx";

export function DecisionList({ decisions }: { decisions: DecisionDTO[] }) {
	const t = useT().panels.decisions;
	const { format } = useI18n();
	const now = useNow();
	const { openTask, mutate } = useHub();
	const [reverting, setReverting] = useState<DecisionDTO | null>(null);

	if (decisions.length === 0) {
		return <Empty title={t.empty}>{t.emptyDescription}</Empty>;
	}

	return (
		<>
			{[...decisions].sort((a, b) => b.at - a.at).map(decision => (
				<article className="card" key={decision.id}>
					<div className="row wrap">
						<strong className="mono">{decision.id}</strong>
						{decision.taskId && (
							<button className="link-button" onClick={() => openTask(decision.taskId!)}>
								{decision.taskId}
							</button>
						)}
						<span className="muted"><RelativeTime at={decision.at} /></span>
						{decision.revertedBy ? (
							<span className="pill">{t.revertedBy(decision.revertedBy)}</span>
						) : decision.revertRequestedAt !== null ? (
							<Status value="revert requested" />
						) : <span className="pill ok">{t.recorded}</span>}
						{decision.reverts && <span className="pill info">{t.reverts(decision.reverts)}</span>}
					</div>
					<p className="prewrap"><strong>{decision.summary}</strong></p>
					<div className="kv">
						<span className="k">{t.why}</span>
						<div className="prewrap">{decision.why || t.noRationale}</div>
						<span className="k">{t.revertPlan}</span>
						<div className="prewrap">{decision.revert || t.noRevertPlan}</div>
					</div>
					<div className="actions">
						{decision.revertRequestedAt !== null && !decision.revertedBy && (
							<span className="muted">{t.requested(format.relativeTime(decision.revertRequestedAt, now))}</span>
						)}
						<Button
							className="small danger"
							disabled={decision.revertedBy !== null || decision.revertRequestedAt !== null}
							onClick={() => setReverting(decision)}
						>
							{t.revert}
						</Button>
					</div>
				</article>
			))}
			{reverting && (
				<Confirm
					title={t.revertTitle(reverting.id)}
					description={t.revertDescription(reverting.summary)}
					confirmLabel={t.requestRevert}
					danger
					onConfirm={() => mutate<DecisionDTO>(`/api/decisions/${encodeURIComponent(reverting.id)}/revert`, undefined, "POST")}
					onClose={() => setReverting(null)}
				/>
			)}
		</>
	);
}

