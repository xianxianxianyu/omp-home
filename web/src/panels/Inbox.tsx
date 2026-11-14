import { useState } from "react";
import type { EscalationDTO, InboxDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { Button, Confirm, Empty, ErrorState, Loading, RelativeTime } from "../ui.tsx";

export function InboxPanel() {
	const { data, error, reload } = useResource<InboxDTO>("inbox", "/api/inbox");
	const { mutate, openSession, openTask } = useHub();
	const [dismiss, setDismiss] = useState<EscalationDTO | null>(null);
	if (error) return <ErrorState error={error} retry={reload} />;
	if (!data) return <Loading />;
	const escalations = data.escalations.filter(item => item.resolvedAt === null);
	return <><div className="panel-heading"><div><h1>Inbox</h1><p>Only the decisions that need you.</p></div><span className="pill">{escalations.length} open</span></div>
		<div className={`card main-banner ${data.main.paused ? "attention-card" : ""}`}><div className="row"><span className={`status-dot ${data.main.paused ? "attention" : "idle"}`} /><strong>{data.main.paused ? "Main is waiting for your go-ahead" : "Main receives worker reports first"}</strong></div><p className="muted">{data.main.pendingNotices} pending notice{data.main.pendingNotices === 1 ? "" : "s"} · {data.main.wakesUsed}/{data.main.wakesMax} automatic wakes used</p>{data.main.paused ? <Button className="primary" onClick={() => mutate("/api/main/continue")}>Let main continue</Button> : <div className="hint">Reversible decisions stay with main. Anything else arrives here.</div>}</div>
		{!escalations.length && <Empty title="You're all caught up">Worker questions will arrive here when main needs your input.</Empty>}
		{escalations.map(item => <article className="card escalation-card" key={item.id}><div className="row"><span className="pill warn">Needs you</span><span className="grow" /><span className="dim"><RelativeTime at={item.openedAt} /></span></div><h3><button className="link-button" onClick={() => openTask(item.taskId)}>{item.taskTitle}</button></h3><div className="body">{item.reason}</div><div className="meta"><span className="mono">{item.taskId} · {item.sessionId}</span><span>Opened by {item.openedBy}</span>{item.seenAt && <span>Seen</span>}</div><div className="actions"><Button className="primary" onClick={async () => { await openSession(item.sessionId); await mutate(`/api/escalations/${encodeURIComponent(item.id)}/seen`); }}>Open session</Button><Button onClick={() => setDismiss(item)}>Dismiss</Button></div></article>)}
		{dismiss && <Confirm title="Dismiss this escalation?" description="This clears the inbox item without sending an answer to the worker. You can still open the session from Tasks or Sessions." confirmLabel="Dismiss" onClose={() => setDismiss(null)} onConfirm={() => mutate(`/api/escalations/${encodeURIComponent(dismiss.id)}/dismiss`)} />}
	</>;
}
