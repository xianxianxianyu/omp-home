import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { resolveLanguage } from "../../../shared/api.ts";
import type { Language, LanguageSetting, SettingsDTO } from "../../../shared/api.ts";
import { useHub, useResource } from "../hub.tsx";
import { applyLanguage, catalogFor, formatFor, readLanguageHint } from "./runtime.ts";
import type { LocaleFormat } from "./runtime.ts";

interface I18nState {
	language: Language;
	setting: LanguageSetting;
	ready: boolean;
	saving: boolean;
	error: string | null;
	update: (setting: LanguageSetting) => void;
	format: LocaleFormat;
}
const I18nContext = createContext<I18nState | null>(null);
export function useI18n() {
	const value = useContext(I18nContext);
	if (!value) throw new Error("I18nProvider is required");
	return value;
}
export function useT() { return catalogFor(useI18n().language); }

export function I18nProvider({ children }: { children: ReactNode }) {
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const { mutate } = useHub();
	const [setting, setSetting] = useState(readLanguageHint);
	const [preferred, setPreferred] = useState(() => navigator.languages);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmed = useRef(setting);
	const pending = useRef<LanguageSetting | undefined>(undefined);
	const running = useRef(false);
	const nativeLanguage = useRef<Language | null>(null);
	const language = resolveLanguage(setting, preferred);
	useEffect(() => {
		const changed = () => setPreferred([...navigator.languages]);
		window.addEventListener("languagechange", changed);
		return () => window.removeEventListener("languagechange", changed);
	}, []);
	useLayoutEffect(() => {
		if (settings.data && !settings.loading && !running.current) {
			confirmed.current = settings.data.language;
			setSetting(settings.data.language);
		}
	}, [settings.data, settings.loading]);
	useLayoutEffect(() => {
		applyLanguage(setting, language);
		if (window.__TAURI__?.core && nativeLanguage.current !== language) {
			nativeLanguage.current = language;
			void window.__TAURI__.core.invoke("set_language", { language }).catch(error => setError(error instanceof Error ? error.message : String(error)));
		}
	}, [setting, language]);
	function update(next: LanguageSetting) {
		pending.current = next;
		setSetting(next);
		applyLanguage(next, resolveLanguage(next, navigator.languages));
		setError(null);
		if (running.current) return;
		running.current = true;
		setSaving(true);
		void (async () => {
			while (pending.current !== undefined) {
				const next = pending.current;
				pending.current = undefined;
				try {
					const saved = await mutate<SettingsDTO>("/api/settings", { language: next }, "PUT");
					confirmed.current = saved.language;
				} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
				setSetting(pending.current ?? confirmed.current);
			}
			running.current = false;
			setSaving(false);
			settings.reload();
		})();
	}
	return <I18nContext.Provider value={{ language, setting, ready: !!settings.data, saving, error: error ?? settings.error?.message ?? null, update, format: formatFor(language) }}>{children}</I18nContext.Provider>;
}
