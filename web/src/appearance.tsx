import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AppearanceDTO, SettingsDTO } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { appearance as appearanceSchema } from "./schemas.ts";

const HINT_KEY = "omp-home-appearance";
const DEFAULT_APPEARANCE: AppearanceDTO = { theme: "system", accent: "amber", textSize: "default", density: "comfortable" };
function readHint(): AppearanceDTO {
	try { return appearanceSchema.parse(JSON.parse(localStorage.getItem(HINT_KEY) ?? "null")); }
	catch { return DEFAULT_APPEARANCE; }
}
function applyAppearance(appearance: AppearanceDTO) {
	const root = document.documentElement;
	root.dataset.theme = appearance.theme;
	root.dataset.accent = appearance.accent;
	root.dataset.textSize = appearance.textSize;
	root.dataset.density = appearance.density;
	root.dataset.colorScheme = appearance.theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : appearance.theme;
	try { localStorage.setItem(HINT_KEY, JSON.stringify(appearance)); } catch { /* The hub remains authoritative when browser storage is unavailable. */ }
}

interface AppearanceState {
	appearance: AppearanceDTO;
	ready: boolean;
	saving: boolean;
	error: string | null;
	update: (patch: Partial<AppearanceDTO>) => void;
}
const AppearanceContext = createContext<AppearanceState | null>(null);
export function useAppearance() {
	const value = useContext(AppearanceContext);
	if (!value) throw new Error("AppearanceProvider is required");
	return value;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const { mutate } = useHub();
	const [appearance, setAppearance] = useState(readHint);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmed = useRef(appearance);
	const pending = useRef<Partial<AppearanceDTO>>({});
	const running = useRef(false);
	useLayoutEffect(() => {
		if (settings.data && !settings.loading && !running.current) {
			confirmed.current = settings.data.appearance;
			setAppearance(settings.data.appearance);
		}
	}, [settings.data, settings.loading]);
	useLayoutEffect(() => {
		applyAppearance(appearance);
		if (appearance.theme !== "system") return;
		const media = matchMedia("(prefers-color-scheme: light)");
		const updateScheme = () => applyAppearance(appearance);
		media.addEventListener("change", updateScheme);
		return () => media.removeEventListener("change", updateScheme);
	}, [appearance]);

	function update(patch: Partial<AppearanceDTO>) {
		pending.current = { ...pending.current, ...patch };
		setAppearance(current => ({ ...current, ...patch }));
		setError(null);
		if (running.current) return;
		running.current = true;
		setSaving(true);
		// A single writer survives the sheet closing and preserves the latest choice during rapid changes.
		void (async () => {
			while (Object.keys(pending.current).length) {
				const patch = pending.current;
				pending.current = {};
				try {
					const saved = await mutate<SettingsDTO>("/api/settings", { appearance: patch }, "PUT");
					confirmed.current = saved.appearance;
				} catch (error) { setError(error instanceof Error ? error.message : String(error)); }
				setAppearance({ ...confirmed.current, ...pending.current });
			}
			running.current = false;
			setSaving(false);
			settings.reload();
		})();
	}
	return <AppearanceContext.Provider value={{ appearance, ready: !!settings.data, saving, error: error ?? settings.error?.message ?? null, update }}>{children}</AppearanceContext.Provider>;
}
