import { Fragment, useState } from "react";
import type { LeaseDTO, ResourcesDTO, ServiceDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Loading, RelativeTime, Section, Status, useNow } from "../ui.tsx";

function LeaseExpiry({ expiresAt, now }: { expiresAt: number | null; now: number }) {
	const t = useT().panels.resources;
	const { format } = useI18n();
	if (expiresAt === null) return <span className="muted">{t.noExpiry}</span>;
	const remaining = expiresAt - now;
	const minutes = Math.ceil(remaining / 60_000);
	const label = remaining <= 0 ? t.expired : minutes > 1 ? t.remaining(format.duration(minutes * 60_000)) : t.lessThanMinute;
	return <time dateTime={new Date(expiresAt).toISOString()} title={format.dateTime(expiresAt)} className={remaining <= 0 ? "error-text" : undefined}>{label}</time>;
}

export function ResourcesPanel() {
	const t = useT().panels;
	const { format } = useI18n();
	const { data, error, loading, reload } = useResource<ResourcesDTO>("resources", "/api/resources");
	const { mutate, toast } = useHub();
	const now = useNow();
	const [release, setRelease] = useState<LeaseDTO | null>(null);
	const [stop, setStop] = useState<ServiceDTO | null>(null);

	return (
		<div className="stack">
			<div className="panel-heading">
				<div><h2>{t.resources.title}</h2><p className="muted">{t.resources.description}</p></div>
				<Button onClick={reload} disabled={loading}>{t.common.refresh}</Button>
			</div>
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data && <>
				<Section title={t.resources.services(format.number(data.services.length))}>
					{data.services.length === 0 ? <Empty title={t.resources.noServices}>{t.resources.noServicesDescription}</Empty> : <div className="table-wrap">
						<table className="grid">
							<thead><tr><th scope="col">{t.resources.workspaceService}</th><th scope="col">{t.common.kind}</th><th scope="col">{t.common.state}</th><th scope="col">{t.common.pid}</th><th scope="col">{t.resources.checked}</th><th scope="col">{t.common.error}</th><th scope="col">{t.common.actions}</th></tr></thead>
							<tbody>{data.services.map((service) => <Fragment key={service.id}>
								<tr>
									<td><strong>{service.name}</strong><div className="muted mono">{service.workspace}</div></td>
									<td>{service.kind === "external" ? t.resources.external : t.resources.managed}</td>
									<td><Status value={service.state} /></td>
									<td className="mono">{service.pid === null ? "—" : format.number(service.pid, { useGrouping: false })}</td>
									<td>{service.checkedAt === null ? <span className="muted">{t.common.never}</span> : <RelativeTime at={service.checkedAt} />}</td>
									<td className="prewrap error-text">{service.error ?? "—"}</td>
									<td><div className="actions">
										<Button className="small" disabled={service.state === "up" || service.state === "starting"} title={t.resources.start(service.name)} onClick={() => mutate(`/api/services/${encodeURIComponent(service.id)}/start`)}>{t.common.start}</Button>
										<Button className="small danger" disabled={service.state === "down"} title={t.resources.stop(service.name)} onClick={() => setStop(service)}>{t.common.stop}</Button>
										<Button className="small" title={t.resources.check(service.name)} onClick={() => mutate(`/api/services/${encodeURIComponent(service.id)}/check`)}>{t.common.check}</Button>
									</div></td>
								</tr>
								<tr><td colSpan={7}><details><summary>{t.resources.logTail(service.name)}</summary><pre className="prewrap mono">{service.logTail || t.resources.noLog}</pre></details></td></tr>
							</Fragment>)}</tbody>
						</table>
					</div>}
				</Section>
				<Section title={t.resources.leases(format.number(data.leases.length))}>
					{data.leases.length === 0 ? <Empty title={t.resources.noLeases}>{t.resources.noLeasesDescription}</Empty> : <div className="table-wrap">
						<table className="grid">
							<thead><tr><th scope="col">{t.common.kind}</th><th scope="col">{t.resources.key}</th><th scope="col">{t.resources.label}</th><th scope="col">{t.resources.holder}</th><th scope="col">{t.resources.expires}</th><th scope="col">{t.common.actions}</th></tr></thead>
							<tbody>{data.leases.map((lease) => <tr key={lease.id}>
								<td><Status value={lease.kind} /></td>
								<td><code className="prewrap">{lease.key}</code></td>
								<td>{lease.label || "—"}</td>
								<td><code className="prewrap">{lease.holderId}</code><div className="muted">{t.resources.holderKinds[lease.holderKind]}</div></td>
								<td><LeaseExpiry expiresAt={lease.expiresAt} now={now} /></td>
								<td><Button className="small danger" title={t.resources.releaseLabel(t.resources.leaseKinds[lease.kind], lease.key)} onClick={() => setRelease(lease)}>{t.resources.release}</Button></td>
							</tr>)}</tbody>
						</table>
					</div>}
				</Section>
				<Section title={t.resources.environments(format.number(data.environments.length))}>
					{data.environments.length === 0 ? <Empty title={t.resources.noEnvironments}>{t.resources.noEnvironmentsDescription}</Empty> : <div className="table-wrap">
						<table className="grid">
							<thead><tr><th scope="col">{t.resources.worktreePath}</th><th scope="col">{t.common.workspace}</th><th scope="col">{t.common.state}</th><th scope="col">{t.common.error}</th></tr></thead>
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
				title={t.resources.stopTitle(stop.name)}
				description={t.resources.stopDescription(stop.workspace)}
				confirmLabel={t.resources.stopService}
				danger
				onClose={() => setStop(null)}
				onConfirm={async () => {
					await mutate(`/api/services/${encodeURIComponent(stop.id)}/stop`);
					toast(t => t.panels.resources.stopped(stop.name));
					setStop(null);
				}}
			/>}
			{release && <Confirm
				title={t.resources.releaseTitle(t.resources.leaseKinds[release.kind])}
				description={t.resources.releaseDescription(release.key, t.resources.holderKinds[release.holderKind], release.holderId)}
				confirmLabel={t.resources.releaseLease}
				danger
				onClose={() => setRelease(null)}
				onConfirm={async () => {
					await mutate(`/api/leases/${encodeURIComponent(String(release.id))}/release`);
					toast(t => t.panels.resources.released);
					setRelease(null);
				}}
			/>}
		</div>
	);
}
