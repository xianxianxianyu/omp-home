import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { FieldError, SettingsDTO, SettingsPatch } from "../../../shared/api.ts";
import { ApiError } from "../api.ts";
import { useHub, useResource } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { Button, ErrorState, Field, Loading, Section, Status } from "../ui.tsx";
import { notificationPermission } from "../native.ts";
import type { NotificationState } from "../native.ts";

type SettingsValues = { [Key in "ompPath" | "pstackRoot" | "worktreeRoot" | "maxLiveWorkers" | "idleEvictMinutes" | "maxAutoWakes" | "portStart" | "portEnd"]: string };

function formValues(settings: SettingsDTO): SettingsValues {
	return {
		ompPath: settings.ompPath ?? "",
		pstackRoot: settings.pstackRoot ?? "",
		maxLiveWorkers: String(settings.maxLiveWorkers),
		idleEvictMinutes: String(settings.idleEvictMinutes),
		maxAutoWakes: String(settings.maxAutoWakes),
		portStart: String(settings.portRange[0]),
		portEnd: String(settings.portRange[1]),
		worktreeRoot: settings.worktreeRoot ?? "",
	};
}

export function SettingsPanel() {
	const t = useT().panels.settings;
	const { data, error, loading, reload } = useResource<SettingsDTO>("settings", "/api/settings");
	return (
		<div className="stack">
			<div className="panel-heading"><div><h2>{t.title}</h2><p className="muted">{t.description}</p></div></div>
			<MainChatSettings />
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data && <SettingsForm settings={data} />}
			<NotificationSettings />
		</div>
	);
}

function MainChatSettings() {
	const catalog = useT();
	const t = catalog.panels.settings;
	const { state, mutate } = useHub();
	const [confirming, setConfirming] = useState(false);
	const [restarting, setRestarting] = useState(false);
	if (!state) return null;
	const main = state.main;

	async function restart() {
		setRestarting(true);
		try { await mutate("/api/main/restart"); setConfirming(false); }
		finally { setRestarting(false); }
	}

	return (
		<Section title={t.mainChat}>
			<div className="card main-chat-settings">
				<div className="row wrap"><h3 className="grow">{main.sessionId ? t.mainSession(main.sessionId) : t.noMainSession}</h3><Status value={main.paused ? "paused" : main.state} /></div>
				<p className="muted">{t.wakes(main.wakesUsed, main.wakesMax)}</p>
				{confirming
					? <div className="inline-confirm" role="group" aria-label={catalog.shell.app.restartTitle}><p>{catalog.shell.app.restartDescription}</p><div className="row"><Button className="danger" disabled={restarting} onClick={() => { void restart(); }}>{catalog.shell.app.restartMain}</Button><Button disabled={restarting} onClick={() => setConfirming(false)}>{catalog.common.keepAsIs}</Button></div></div>
					: <><p className="hint">{t.restartHint}</p><Button disabled={!main.sessionId} onClick={() => setConfirming(true)}>{catalog.shell.app.restartMain}</Button></>}
			</div>
		</Section>
	);
}

function SettingsForm({ settings }: { settings: SettingsDTO }) {
	const t = useT().panels;
	const { format } = useI18n();
	const { mutate, toast } = useHub();
	const [form, setForm] = useState(() => ({ values: formValues(settings), dirty: false }));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errors, setErrors] = useState<FieldError[]>([]);
	const values = form.values;

	useEffect(() => {
		setForm((current) => current.dirty ? current : { values: formValues(settings), dirty: false });
	}, [settings]);

	function change(key: keyof SettingsValues, value: string) {
		setForm((current) => ({ values: { ...current.values, [key]: value }, dirty: true }));
	}

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (saving) return;
		setSaving(true);
		setError(null);
		setErrors([]);
		const patch: SettingsPatch = {
			ompPath: values.ompPath.trim() || null,
			pstackRoot: values.pstackRoot.trim() || null,
			maxLiveWorkers: Number(values.maxLiveWorkers),
			idleEvictMinutes: Number(values.idleEvictMinutes),
			maxAutoWakes: Number(values.maxAutoWakes),
			portRange: [Number(values.portStart), Number(values.portEnd)],
			worktreeRoot: values.worktreeRoot.trim() || null,
		};
		try {
			const saved = await mutate<SettingsDTO>("/api/settings", patch, "PUT");
			setForm({ values: formValues(saved), dirty: false });
			toast(t => t.panels.settings.saved);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : t.settings.saveError);
			if (failure instanceof ApiError) setErrors(failure.errors);
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={(event) => { void save(event); }} className="stack">
			<Section title={t.settings.localPaths}>
				<Field label={t.settings.ompBinary} hint={t.settings.ompHint}><input aria-label={t.settings.ompBinary} value={values.ompPath} onChange={event => change("ompPath", event.target.value)} placeholder={t.settings.managedPath} disabled={saving} /></Field>
				<Field label={t.settings.pstackRoot} hint={t.settings.pstackHint}>
					<input value={values.pstackRoot} onChange={(event) => change("pstackRoot", event.target.value)} placeholder="/path/to/pstack" disabled={saving} />
				</Field>
				<Field label={t.settings.worktreeRoot} hint={t.settings.worktreeHint}>
					<input value={values.worktreeRoot} onChange={(event) => change("worktreeRoot", event.target.value)} placeholder={t.settings.defaultLocation} disabled={saving} />
				</Field>
			</Section>
			<Section title={t.settings.capacity}>
				<div className="two-col">
					<Field label={t.settings.maxWorkers} hint={t.settings.maxWorkersHint(format.number(1), format.number(32))}><input required type="number" min={1} max={32} step={1} value={values.maxLiveWorkers} onChange={(event) => change("maxLiveWorkers", event.target.value)} disabled={saving} /></Field>
					<Field label={t.settings.idleEviction} hint={t.settings.idleEvictionHint(format.number(1), format.number(1440))}><input required type="number" min={1} max={1440} step={1} value={values.idleEvictMinutes} onChange={(event) => change("idleEvictMinutes", event.target.value)} disabled={saving} /></Field>
					<Field label={t.settings.maxWakes} hint={t.settings.maxWakesHint(format.number(0), format.number(20))}><input required type="number" min={0} max={20} step={1} value={values.maxAutoWakes} onChange={(event) => change("maxAutoWakes", event.target.value)} disabled={saving} /></Field>
				</div>
			</Section>
			<Section title={t.settings.ports}>
				<p className="hint">{t.settings.portsHint(format.number(10), format.number(1024, { useGrouping: false }), format.number(65535, { useGrouping: false }))}</p>
				<div className="two-col">
					<Field label={t.settings.firstPort}><input required type="number" min={1024} max={values.portEnd ? Number(values.portEnd) - 9 : 65526} step={1} value={values.portStart} onChange={(event) => change("portStart", event.target.value)} disabled={saving} /></Field>
					<Field label={t.settings.lastPort}><input required type="number" min={values.portStart ? Number(values.portStart) + 9 : 1033} max={65535} step={1} value={values.portEnd} onChange={(event) => change("portEnd", event.target.value)} disabled={saving} /></Field>
				</div>
			</Section>
			{error && <div className="error-box" role="alert"><p>{error}</p>{errors.length > 0 && <ul>{errors.map((item, index) => <li key={`${item.path}:${index}`}><code>{item.path || t.common.settings}</code>: {item.message}</li>)}</ul>}</div>}
			<div className="dialog-actions">
				{form.dirty && <span className="muted" role="status">{t.common.unsaved}</span>}
				<Button disabled={saving || !form.dirty} onClick={() => { setForm({ values: formValues(settings), dirty: false }); setError(null); setErrors([]); }}>{t.common.discard}</Button>
				<Button type="submit" className="primary" disabled={saving || !form.dirty}>{saving ? t.common.saving : t.settings.save}</Button>
			</div>
		</form>
	);
}

function NotificationSettings() {
	const t = useT().panels.notifications;
	const { toast } = useHub();
	const [permission, setPermission] = useState<NotificationState>("default");

	useEffect(() => {
		const update = () => { void notificationPermission().then(setPermission); };
		update();
		window.addEventListener("focus", update);
		return () => window.removeEventListener("focus", update);
	}, []);

	async function requestPermission() {
		try {
			const next = await notificationPermission(true);
			setPermission(next);
			if (next === "granted") toast(t => t.panels.notifications.enabledToast);
			else if (next === "denied") toast(t => t.panels.notifications.blockedToast);
		} catch (error) {
			toast(error instanceof Error ? error.message : t => t.panels.notifications.requestError, "error");
		}
	}

	return (
		<Section title={t.title}>
			<div className="card">
				<div className="row wrap"><h3 className="grow">{t.needsYou}</h3><Status value={permission === "granted" ? "enabled" : permission === "default" ? "not requested" : permission} /></div>
				<p className="muted">{t.description}</p>
				{permission === "unsupported" ? <p className="hint">{t.unsupported}</p> : <>
					<Button onClick={requestPermission} disabled={permission !== "default"}>{permission === "granted" ? t.enabled : permission === "denied" ? t.blocked : t.enable}</Button>
					{permission === "denied" && <p className="hint">{t.allowHint}</p>}
				</>}
			</div>
		</Section>
	);
}
