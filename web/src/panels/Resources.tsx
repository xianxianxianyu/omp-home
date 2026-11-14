import { Fragment, useState } from "react";
import type { LeaseDTO, ResourcesDTO, ServiceDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Loading, RelativeTime, Section, Status, useNow } from "../ui.tsx";

function LeaseExpiry({ expiresAt, now }: { expiresAt: number | null; now: number }) {
	if (expiresAt === null) return <span className="muted">No expiry</span>;
	const remaining = expiresAt - now;
	const minutes = Math.ceil(remaining / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	const label = remaining <= 0 ? "Expired" : days > 0 ? `${days}d ${hours % 24}h left` : hours > 0 ? `${hours}h ${minutes % 60}m left` : minutes > 1 ? `${minutes}m left` : "Less than 1m left";
	return <time dateTime={new Date(expiresAt).toISOString()} title={new Date(expiresAt).toLocaleString()} className={remaining <= 0 ? "error-text" : undefined}>{label}</time>;
}

export function ResourcesPanel() {
	const { data, error, loading, reload } = useResource<ResourcesDTO>("resources", "/api/resources");
	const { mutate, toast } = useHub();
	const now = useNow();
	const [release, setRelease] = useState<LeaseDTO | null>(null);
	const [stop, setStop] = useState<ServiceDTO | null>(null);

	return (
		<div className="stack">
			<div className="panel-heading">
				<div><h2>Resources</h2><p className="muted">Services, reservations, and worktree environments.</p></div>
				<Button onClick={reload} disabled={loading}>Refresh</Button>
			</div>
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data && <>
				<Section title={`Services · ${data.services.length}`}>
					{data.services.length === 0 ? <Empty title="No services">Services declared in workspace recipes appear here when provisioned.</Empty> : <div className="table-wrap">
						<table className="grid">
							<thead><tr><th scope="col">Workspace / service</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col">PID</th><th scope="col">Checked</th><th scope="col">Error</th><th scope="col">Actions</th></tr></thead>
							<tbody>{data.services.map((service) => <Fragment key={service.id}>
								<tr>
									<td><strong>{service.name}</strong><div className="muted mono">{service.workspace}</div></td>
									<td>{service.kind === "external" ? "External" : "Managed"}</td>
									<td><Status value={service.state} /></td>
									<td className="mono">{service.pid ?? "—"}</td>
									<td>{service.checkedAt === null ? <span className="muted">Never</span> : <RelativeTime at={service.checkedAt} />}</td>
									<td className="prewrap error-text">{service.error ?? "—"}</td>
									<td><div className="actions">
										<Button className="small" disabled={service.state === "up" || service.state === "starting"} title={`Start ${service.name}`} onClick={() => mutate(`/api/services/${encodeURIComponent(service.id)}/start`)}>Start</Button>
										<Button className="small danger" disabled={service.state === "down"} title={`Stop ${service.name}`} onClick={() => setStop(service)}>Stop</Button>
										<Button className="small" title={`Check ${service.name}`} onClick={() => mutate(`/api/services/${encodeURIComponent(service.id)}/check`)}>Check</Button>
									</div></td>
								</tr>
								<tr><td colSpan={7}><details><summary>Log tail · {service.name}</summary><pre className="prewrap mono">{service.logTail || "No log output recorded."}</pre></details></td></tr>
							</Fragment>)}</tbody>
						</table>
					</div>}
				</Section>
				<Section title={`Leases · ${data.leases.length}`}>
					{data.leases.length === 0 ? <Empty title="No active leases">Reserved ports, databases, and test accounts appear here.</Empty> : <div className="table-wrap">
						<table className="grid">
							<thead><tr><th scope="col">Kind</th><th scope="col">Key</th><th scope="col">Label</th><th scope="col">Holder</th><th scope="col">Expires</th><th scope="col">Actions</th></tr></thead>
							<tbody>{data.leases.map((lease) => <tr key={lease.id}>
								<td><Status value={lease.kind} /></td>
								<td><code className="prewrap">{lease.key}</code></td>
								<td>{lease.label || "—"}</td>
								<td><code className="prewrap">{lease.holderId}</code><div className="muted">{lease.holderKind}</div></td>
								<td><LeaseExpiry expiresAt={lease.expiresAt} now={now} /></td>
								<td><Button className="small danger" title={`Release ${lease.kind} ${lease.key}`} onClick={() => setRelease(lease)}>Release</Button></td>
							</tr>)}</tbody>
						</table>
					</div>}
				</Section>
				<Section title={`Environments · ${data.environments.length}`}>
					{data.environments.length === 0 ? <Empty title="No worktree environments">Environments appear when tasks provision a worktree.</Empty> : <div className="table-wrap">
						<table className="grid">
							<thead><tr><th scope="col">Worktree path</th><th scope="col">Workspace</th><th scope="col">State</th><th scope="col">Error</th></tr></thead>
							<tbody>{data.environments.map((environment) => <tr key={environment.worktreeId}>
								<td><div className="row"><code className="prewrap grow">{environment.worktreePath}</code><CopyButton text={environment.worktreePath} /></div><div className="muted"><RelativeTime at={environment.updatedAt} /></div></td>
								<td className="mono">{environment.workspace}</td>
								<td><Status value={environment.state} /></td>
								<td className="prewrap error-text">{environment.error ?? "—"}</td>
							</tr>)}</tbody>
						</table>
					</div>}
				</Section>
			</>}
			{stop && <Confirm
				title={`Stop ${stop.name}?`}
				description={`Stop the service in ${stop.workspace}. Tasks using it may fail or lose their connection until it is started again.`}
				confirmLabel="Stop service"
				danger
				onClose={() => setStop(null)}
				onConfirm={async () => {
					await mutate(`/api/services/${encodeURIComponent(stop.id)}/stop`);
					toast(`${stop.name} stopped`);
					setStop(null);
				}}
			/>}
			{release && <Confirm
				title={`Release ${release.kind} lease?`}
				description={`Release “${release.key}” held by ${release.holderKind} ${release.holderId}. Only release it if the holder no longer needs it; an active holder could conflict with another allocation.`}
				confirmLabel="Release lease"
				danger
				onClose={() => setRelease(null)}
				onConfirm={async () => {
					await mutate(`/api/leases/${encodeURIComponent(String(release.id))}/release`);
					toast("Lease released");
					setRelease(null);
				}}
			/>}
		</div>
	);
}
