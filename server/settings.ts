import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { ACCENTS, DENSITIES, LANGUAGE_SETTINGS, TEXT_SIZES, THEMES, THINKING_LEVELS, type AppearanceDTO, type LanguageSetting, type SettingsDTO } from "../shared/api.ts";
import { writeFileAtomic, type HomePaths } from "./config.ts";
import type { Db } from "./db.ts";
import { fieldErrors, HubError } from "./errors.ts";
import { localizedCheck, validationMessages as m } from "./i18n-validation.ts";

export const DEFAULT_PSTACK_ROOT = "/Volumes/NVMe2T/project/opensource/cursor-plugins/harness/pstack/claude-code";
/** omp config every hub-spawned omp gets (also the compatibility self-check). */
export const OVERLAY_BASE = { startup: { setupWizard: false }, update: { auto: false } };

export type Settings = Omit<SettingsDTO, "homePath">;
const DEFAULT_APPEARANCE: AppearanceDTO = { theme: "system", accent: "amber", textSize: "default", density: "comfortable" };
const DEFAULT_LANGUAGE: LanguageSetting = "system";

export function isPstackRoot(dir: string): boolean {
	return fs.existsSync(path.join(dir, "skills", "poteto-mode", "SKILL.md"));
}

export function defaultSettings(): Settings {
	return {
		pstackRoot: isPstackRoot(DEFAULT_PSTACK_ROOT) ? DEFAULT_PSTACK_ROOT : null,
		mainModel: null,
		mainThinking: "high",
		workerModel: null,
		workerThinking: "high",
		dispatcherModel: null,
		maxLiveWorkers: 4,
		idleEvictMinutes: 20,
		maxAutoWakes: 3,
		portRange: [41000, 41999],
		worktreeRoot: null,
		ompPath: null,
		appearance: { ...DEFAULT_APPEARANCE },
		language: DEFAULT_LANGUAGE,
	};
}

const model = z.string().trim().min(1).nullable();
const appearanceFields = {
	theme: z.enum(THEMES),
	accent: z.enum(ACCENTS),
	textSize: z.enum(TEXT_SIZES),
	density: z.enum(DENSITIES),
};
const fields = {
	pstackRoot: z
		.string()
		.nullable()
		.refine(v => v === null || isPstackRoot(v), localizedCheck(m.notPstackRoot())),
	mainModel: model,
	mainThinking: z.enum(THINKING_LEVELS),
	workerModel: model,
	workerThinking: z.enum(THINKING_LEVELS),
	dispatcherModel: model,
	maxLiveWorkers: z.number().int().min(1).max(32),
	idleEvictMinutes: z.number().int().min(1).max(1440),
	maxAutoWakes: z.number().int().min(0).max(20),
	portRange: z
		.tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
		.refine(([lo, hi]) => hi - lo >= 9, localizedCheck(m.portRangeTooSmall())),
	worktreeRoot: z
		.string()
		.nullable()
		.refine(v => v === null || path.isAbsolute(v), localizedCheck(m.absolutePath())),
	ompPath: z
		.string()
		.nullable()
		.refine(v => v === null || path.isAbsolute(v), localizedCheck(m.absolutePath())),
};
const language = z.enum(LANGUAGE_SETTINGS);
const patchSchema = z.strictObject({ ...fields, appearance: z.strictObject(appearanceFields).partial(), language }).partial();
const storedSchema = z.object({
	...fields,
	appearance: z.object({
		theme: appearanceFields.theme.catch(DEFAULT_APPEARANCE.theme),
		accent: appearanceFields.accent.catch(DEFAULT_APPEARANCE.accent),
		textSize: appearanceFields.textSize.catch(DEFAULT_APPEARANCE.textSize),
		density: appearanceFields.density.catch(DEFAULT_APPEARANCE.density),
	}).catch({ ...DEFAULT_APPEARANCE }),
	language: language.catch(DEFAULT_LANGUAGE),
}).partial();

/** Settings live in meta('settings'); overlays derived from them are rewritten on every change. */
export class SettingsStore {
	readonly #db: Db;
	readonly #paths: HomePaths;

	constructor(db: Db, paths: HomePaths) {
		this.#db = db;
		this.#paths = paths;
	}

	get(): Settings {
		const raw = this.#db.meta("settings");
		const stored = raw ? storedSchema.safeParse(JSON.parse(raw)) : null;
		return { ...defaultSettings(), ...(stored?.success ? stored.data : {}) };
	}

	dto(): SettingsDTO {
		return { homePath: this.#paths.home, ...this.get() };
	}

	update(patch: unknown): Settings {
		const parsed = patchSchema.safeParse(patch);
		if (!parsed.success) throw new HubError("unprocessable", m.invalidSettings(), fieldErrors(parsed.error.issues));
		const current = this.get();
		const next = { ...current, ...parsed.data, appearance: { ...current.appearance, ...parsed.data.appearance } };
		this.#db.setMeta("settings", JSON.stringify(next));
		this.writeOverlays();
		return next;
	}

	/** omp `--config` overlays per role; they affect the next spawn. The hub pins omp versions, so omp never updates itself. */
	writeOverlays(): void {
		const s = this.get();
		fs.mkdirSync(this.#paths.run, { recursive: true });
		const main: Record<string, unknown> = {
			...OVERLAY_BASE,
			compaction: { experimentalContextManagement: true },
		};
		if (s.dispatcherModel) main.task = { agentModelOverrides: { dispatcher: s.dispatcherModel } };
		writeFileAtomic(this.#paths.overlay("main"), stringify(main));
		writeFileAtomic(this.#paths.overlay("worker"), stringify(OVERLAY_BASE));
	}
}
