import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { FieldError, SettingsDTO, SettingsPatch } from "../../../shared/api.ts";
import { ApiError } from "../api.ts";
import { useHub, useResource } from "../hub.tsx";
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
	const { data, error, loading, reload } = useResource<SettingsDTO>("settings", "/api/settings");
	return (
		<div className="stack">
			<div className="panel-heading"><div><h2>General</h2><p className="muted">Configure worker capacity and local paths.</p></div></div>
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data && <SettingsForm settings={data} />}
			<NotificationSettings />
		</div>
	);
}

function SettingsForm({ settings }: { settings: SettingsDTO }) {
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
			toast("Settings saved.");
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save settings.");
			if (failure instanceof ApiError) setErrors(failure.errors);
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={(event) => { void save(event); }} className="stack">
			<Section title="Local paths">
				<Field label="omp binary" hint="Explicit omp executable. Leave empty to use managed omp or PATH."><input aria-label="omp binary" value={values.ompPath} onChange={event => change("ompPath", event.target.value)} placeholder="Managed / PATH" disabled={saving} /></Field>
				<Field label="pstack root" hint="Path to your pstack skills. Leave blank to disable pstack integration.">
					<input value={values.pstackRoot} onChange={(event) => change("pstackRoot", event.target.value)} placeholder="/path/to/pstack" disabled={saving} />
				</Field>
				<Field label="Worktree root" hint="Leave blank to use the default worktree location.">
					<input value={values.worktreeRoot} onChange={(event) => change("worktreeRoot", event.target.value)} placeholder="Default location" disabled={saving} />
				</Field>
			</Section>
			<Section title="Worker capacity and wake budget">
				<div className="two-col">
					<Field label="Maximum live workers" hint="Maximum worker processes kept live in the pool (1–32)."><input required type="number" min={1} max={32} step={1} value={values.maxLiveWorkers} onChange={(event) => change("maxLiveWorkers", event.target.value)} disabled={saving} /></Field>
					<Field label="Idle eviction (minutes)" hint="How long an idle worker remains live before eviction (1–1440 minutes)."><input required type="number" min={1} max={1440} step={1} value={values.idleEvictMinutes} onChange={(event) => change("idleEvictMinutes", event.target.value)} disabled={saving} /></Field>
					<Field label="Maximum automatic wakes" hint="Hub-triggered main wakes between human inputs (0–20); further notices wait for your approval."><input required type="number" min={0} max={20} step={1} value={values.maxAutoWakes} onChange={(event) => change("maxAutoWakes", event.target.value)} disabled={saving} /></Field>
				</div>
			</Section>
			<Section title="Port allocation">
				<p className="hint">Inclusive range for worktree port reservations: at least 10 ports, between 1024 and 65535.</p>
				<div className="two-col">
					<Field label="First port"><input required type="number" min={1024} max={values.portEnd ? Number(values.portEnd) - 9 : 65526} step={1} value={values.portStart} onChange={(event) => change("portStart", event.target.value)} disabled={saving} /></Field>
					<Field label="Last port"><input required type="number" min={values.portStart ? Number(values.portStart) + 9 : 1033} max={65535} step={1} value={values.portEnd} onChange={(event) => change("portEnd", event.target.value)} disabled={saving} /></Field>
				</div>
			</Section>
			{error && <div className="error-box" role="alert"><p>{error}</p>{errors.length > 0 && <ul>{errors.map((item, index) => <li key={`${item.path}:${index}`}><code>{item.path || "settings"}</code>: {item.message}</li>)}</ul>}</div>}
			<div className="dialog-actions">
				{form.dirty && <span className="muted" role="status">Unsaved changes</span>}
				<Button disabled={saving || !form.dirty} onClick={() => { setForm({ values: formValues(settings), dirty: false }); setError(null); setErrors([]); }}>Discard changes</Button>
				<Button type="submit" className="primary" disabled={saving || !form.dirty}>{saving ? "Saving…" : "Save settings"}</Button>
			</div>
		</form>
	);
}

function NotificationSettings() {
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
			if (next === "granted") toast("Desktop notifications enabled");
			else if (next === "denied") toast("Notifications are blocked. You can enable them in your browser’s site settings.");
		} catch (error) {
			toast(error instanceof Error ? error.message : "Could not request notification permission.", "error");
		}
	}

	return (
		<Section title="Desktop notifications">
			<div className="card">
				<div className="row wrap"><h3 className="grow">When a worker needs you</h3><Status value={permission === "granted" ? "enabled" : permission === "default" ? "not requested" : permission} /></div>
				<p className="muted">Get a desktop notification when a worker needs you or main pauses. Browser notifications appear while this page is hidden.</p>
				{permission === "unsupported" ? <p className="hint">This browser does not support desktop notifications.</p> : <>
					<Button onClick={requestPermission} disabled={permission !== "default"}>{permission === "granted" ? "Notifications enabled" : permission === "denied" ? "Notifications blocked" : "Enable notifications"}</Button>
					{permission === "denied" && <p className="hint">Allow notifications for this site in your browser settings, then return to this page.</p>}
				</>}
			</div>
		</Section>
	);
}
