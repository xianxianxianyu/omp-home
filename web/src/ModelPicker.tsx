import { useId, useState } from "react";
import { THINKING_LEVELS } from "../../shared/api.ts";
import type { ModelCatalogDTO, ModelDTO, ThinkingLevel } from "../../shared/api.ts";
import { api } from "./api.ts";
import { useResource } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import { Field } from "./ui.tsx";

export function useModelCatalog() {
	const resource = useResource<ModelCatalogDTO>("settings", "/api/models");
	const [refreshing, setRefreshing] = useState(false);
	const [refreshError, setRefreshError] = useState<Error | null>(null);
	async function refresh() {
		setRefreshing(true);
		setRefreshError(null);
		try { await api<ModelCatalogDTO>("/api/models?refresh=1"); resource.reload(); }
		catch (error) { setRefreshError(error instanceof Error ? error : new Error(String(error))); }
		finally { setRefreshing(false); }
	}
	return { ...resource, error: refreshError ?? resource.error, refreshing, refresh };
}

const MODEL_PRICE_FORMAT = { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 8 } as const;

export function ModelPicker({ label, value, storedValue, onChange, catalog, disabled = false, defaultLabel, defaultModel = catalog?.defaultModel }: {
	label: string; value: string | null; storedValue?: string | null; onChange: (selector: string | null) => void;
	catalog?: ModelCatalogDTO; disabled?: boolean; defaultLabel?: string; defaultModel?: string | null;
}) {
	const t = useT().panels.picker;
	const { format } = useI18n();
	const id = useId();
	const [search, setSearch] = useState("");
	const models = catalog?.models ?? [];
	const query = search.trim().toLocaleLowerCase();
	const visible = models.filter(model => `${model.name} ${model.selector}`.toLocaleLowerCase().includes(query) || model.selector === value);
	const providers = [...new Set(visible.map(model => model.provider))].sort();
	const missing = [...new Set([value, storedValue].filter((selector): selector is string => !!selector && !models.some(model => model.selector === selector)))];
	const matchCount = query ? models.filter(model => `${model.name} ${model.selector}`.toLocaleLowerCase().includes(query)).length : 0;
	function modelDetails(model: ModelDTO) {
		const size = model.contextWindow === null ? t.contextUnknown : t.context(format.number(model.contextWindow, { notation: "compact", maximumFractionDigits: 1 }));
		return `${size} · ${model.cost ? t.pricing(format.number(model.cost.input, MODEL_PRICE_FORMAT), format.number(model.cost.output, MODEL_PRICE_FORMAT)) : t.pricingUnavailable}`;
	}
	return <div className="model-picker field">
		<label htmlFor={id}><span className="field-label">{label}</span></label>
		<input type="search" aria-label={t.search(label)} placeholder={t.searchPlaceholder} value={search} onChange={event => setSearch(event.target.value)} disabled={disabled} />
		<select id={id} aria-label={label} value={value ?? ""} onChange={event => onChange(event.target.value || null)} disabled={disabled}>
			<option value="">{defaultLabel ?? t.ompDefault} · {defaultModel ?? t.resolvedByOmp}</option>
			{missing.map(selector => <option key={selector} value={selector}>{selector} · {t.missing}</option>)}
			{providers.map(provider => <optgroup key={provider} label={provider}>{visible.filter(model => model.provider === provider).map(model => <option key={model.selector} value={model.selector}>{model.name} · {modelDetails(model)}</option>)}</optgroup>)}
		</select>
		{query && <span className="hint">{t.matches(matchCount, format.number(matchCount))}</span>}
	</div>;
}

export function ThinkingPicker({ label, value, model, onChange, disabled = false }: { label: string; value: ThinkingLevel; model?: ModelDTO; onChange: (level: ThinkingLevel) => void; disabled?: boolean }) {
	const t = useT().panels.picker;
	const levels = model ? THINKING_LEVELS.filter(level => level === "off" || model.thinking.includes(level)) : THINKING_LEVELS;
	const unsupported = !levels.includes(value);
	return <Field label={label} hint={model && !model.reasoning ? t.noReasoning : unsupported ? t.unsupportedLevel(t.thinking[value]) : undefined}>
		<select aria-label={label} value={value} onChange={event => { const level = THINKING_LEVELS.find(level => level === event.target.value); if (level) onChange(level); }} disabled={disabled || (model !== undefined && !model.reasoning)}>
			{levels.map(level => <option key={level} value={level}>{t.thinking[level]}</option>)}
			{unsupported && <option value={value}>{t.unsupported(t.thinking[value])}</option>}
		</select>
	</Field>;
}
