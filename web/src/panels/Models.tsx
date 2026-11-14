import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ModelCatalogDTO, SettingsDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { ModelPicker, ThinkingPicker, useModelCatalog } from "../ModelPicker.tsx";
import { Button, ErrorState, Loading } from "../ui.tsx";

type ModelSettings = Pick<SettingsDTO, "mainModel" | "mainThinking" | "workerModel" | "workerThinking" | "dispatcherModel">;
function modelSettings(settings: SettingsDTO): ModelSettings {
	return { mainModel: settings.mainModel, mainThinking: settings.mainThinking, workerModel: settings.workerModel, workerThinking: settings.workerThinking, dispatcherModel: settings.dispatcherModel };
}

export function ModelsPanel() {
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const catalog = useModelCatalog();
	return <div className="stack">
		<div className="panel-heading"><div><h2>Models</h2><p>Choose from omp’s model catalog.</p></div><Button onClick={catalog.refresh} disabled={catalog.refreshing || catalog.loading}>{catalog.refreshing ? "Refreshing…" : "Refresh"}</Button></div>
		<p className="hint model-spawn-note">Model and thinking changes apply to the next spawn, not to running sessions.</p>
		{catalog.data && <div className="catalog-meta muted">{catalog.data.models.length} models · Updated <time dateTime={new Date(catalog.data.fetchedAt).toISOString()}>{new Date(catalog.data.fetchedAt).toLocaleString()}</time></div>}
		{catalog.error && <ErrorState error={catalog.error} retry={() => { void catalog.refresh(); }} />}
		{catalog.data?.error && <p className="error-box" role="alert">{catalog.data.error}</p>}
		{settings.error && <ErrorState error={settings.error} retry={settings.reload} />}
		{!settings.data ? <Loading /> : <ModelsForm settings={settings.data} catalog={catalog.data} />}
	</div>;
}

function ModelsForm({ settings, catalog }: { settings: SettingsDTO; catalog?: ModelCatalogDTO }) {
	const { mutate, toast } = useHub();
	const [form, setForm] = useState(() => ({ values: modelSettings(settings), dirty: false }));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => { setForm(current => current.dirty ? current : { values: modelSettings(settings), dirty: false }); }, [settings]);
	function change(patch: Partial<ModelSettings>) { setForm(current => ({ values: { ...current.values, ...patch }, dirty: true })); }
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true); setError(null);
		try {
			const saved = await mutate<SettingsDTO>("/api/settings", form.values, "PUT");
			setForm({ values: modelSettings(saved), dirty: false });
			toast("Models saved.");
		} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setSaving(false); }
	}
	return <form className="stack model-settings" onSubmit={event => { void save(event); }}>
		{([
			{ title: "Main chat", model: "mainModel", thinking: "mainThinking", label: "Main model", thinkingLabel: "Main thinking" },
			{ title: "Workers (default)", model: "workerModel", thinking: "workerThinking", label: "Worker model", thinkingLabel: "Worker thinking" },
			{ title: "Dispatcher", model: "dispatcherModel", thinking: null, label: "Dispatcher model", thinkingLabel: "" },
		] as const).map(role => <section className="card model-role" key={role.model}>
			<h3>{role.title}</h3>
			<ModelPicker label={role.label} value={form.values[role.model]} storedValue={settings[role.model]} onChange={selector => change({ [role.model]: selector })} catalog={catalog} disabled={saving} />
			{role.thinking && <ThinkingPicker label={role.thinkingLabel} value={form.values[role.thinking]} model={catalog?.models.find(model => model.selector === form.values[role.model])} onChange={level => { if (role.thinking) change({ [role.thinking]: level }); }} disabled={saving} />}
		</section>)}
		{error && <p className="error-box" role="alert">{error}</p>}
		<div className="dialog-actions">
			{form.dirty && <span className="muted" role="status">Unsaved changes</span>}
			<Button disabled={saving || !form.dirty} onClick={() => { setForm({ values: modelSettings(settings), dirty: false }); setError(null); }}>Discard changes</Button>
			<Button type="submit" className="primary" disabled={saving || !form.dirty}>{saving ? "Saving…" : "Save models"}</Button>
		</div>
	</form>;
}
