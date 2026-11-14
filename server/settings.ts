import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import type { SettingsDTO } from "../shared/api.ts";
import { writeFileAtomic, type HomePaths } from "./config.ts";
import type { Db } from "./db.ts";
import { fieldErrors, HubError } from "./errors.ts";

export const DEFAULT_PSTACK_ROOT = "/Volumes/NVMe2T/project/opensource/cursor-plugins/harness/pstack/claude-code";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type Settings = Omit<SettingsDTO, "homePath">;

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
	};
}

const model = z.string().trim().min(1).nullable();
const fields = {
	pstackRoot: z
		.string()
		.nullable()
		.refine(v => v === null || isPstackRoot(v), "not a pstack root: skills/poteto-mode/SKILL.md is missing"),
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
		.refine(([lo, hi]) => hi - lo >= 9, "the range needs at least 10 ports"),
	worktreeRoot: z
		.string()
		.nullable()
		.refine(v => v === null || path.isAbsolute(v), "must be an absolute path"),
};
const patchSchema = z.strictObject(fields).partial();
const storedSchema = z.object(fields).partial();

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
		if (!parsed.success) throw new HubError("unprocessable", "invalid settings", fieldErrors(parsed.error.issues));
		const next = { ...this.get(), ...parsed.data };
		this.#db.setMeta("settings", JSON.stringify(next));
		this.writeOverlays();
		return next;
	}

	/** omp `--config` overlays per role; they affect the next spawn. */
	writeOverlays(): void {
		const s = this.get();
		fs.mkdirSync(this.#paths.run, { recursive: true });
		const main: Record<string, unknown> = {
			startup: { setupWizard: false },
			compaction: { experimentalContextManagement: true },
		};
		if (s.dispatcherModel) main.task = { agentModelOverrides: { dispatcher: s.dispatcherModel } };
		writeFileAtomic(this.#paths.overlay("main"), stringify(main));
		writeFileAtomic(this.#paths.overlay("worker"), stringify({ startup: { setupWizard: false } }));
	}
}
