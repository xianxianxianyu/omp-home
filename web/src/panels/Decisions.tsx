import { useState } from "react";
import type { DecisionDTO } from "../../../shared/api.ts";
import { useHub } from "../hub.tsx";
import { Button, Confirm, Empty, RelativeTime, Status } from "../ui.tsx";

export function DecisionList({ decisions }: { decisions: DecisionDTO[] }) {
	const { openTask, mutate } = useHub();
	const [reverting, setReverting] = useState<DecisionDTO | null>(null);

	if (decisions.length === 0) {
		return <Empty title="No decisions yet">Decisions and their revert plans will appear here.</Empty>;
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
							<span className="pill">Reverted by {decision.revertedBy}</span>
						) : decision.revertRequestedAt !== null ? (
							<Status value="revert requested" />
						) : <span className="pill ok">Recorded</span>}
						{decision.reverts && <span className="pill info">Reverts {decision.reverts}</span>}
					</div>
					<p className="prewrap"><strong>{decision.summary}</strong></p>
					<div className="kv">
						<span className="k">Why</span>
						<div className="prewrap">{decision.why || "No rationale recorded."}</div>
						<span className="k">Revert plan</span>
						<div className="prewrap">{decision.revert || "No revert plan recorded."}</div>
					</div>
					<div className="actions">
						{decision.revertRequestedAt !== null && !decision.revertedBy && (
							<span className="muted">Requested <RelativeTime at={decision.revertRequestedAt} /></span>
						)}
						<Button
							className="small danger"
							disabled={decision.revertedBy !== null || decision.revertRequestedAt !== null}
							onClick={() => setReverting(decision)}
						>
							Revert
						</Button>
					</div>
				</article>
			))}
			{reverting && (
				<Confirm
					title={`Revert ${reverting.id}?`}
					description={`Request a revert of “${reverting.summary}”. Main will be notified to carry out the recorded revert plan; this does not immediately undo changes.`}
					confirmLabel="Request revert"
					danger
					onConfirm={() => mutate<DecisionDTO>(`/api/decisions/${encodeURIComponent(reverting.id)}/revert`, undefined, "POST")}
					onClose={() => setReverting(null)}
				/>
			)}
		</>
	);
}

