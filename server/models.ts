import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { THINKING_LEVELS, type ModelCatalogDTO, type ModelDTO } from "../shared/api.ts";
import { errorText } from "./errors.ts";

const execFileP = promisify(execFile);
const thinkingSchema = z.enum(THINKING_LEVELS);
const catalogSchema = z.object({ models: z.array(z.object({ kind: z.string() }).passthrough()) });
const modelSchema = z.object({
	selector: z.string(),
	provider: z.string(),
	id: z.string(),
	name: z.string(),
	contextWindow: z.number().nullish(),
	maxTokens: z.number().nullish(),
	reasoning: z.boolean().default(false),
	thinking: z.array(z.string()).default([]),
	input: z.array(z.string()).default([]),
	cost: z.object({ input: z.number(), output: z.number() }).nullish(),
});
const rolesSchema = z.object({ value: z.object({ default: z.string().nullish() }).nullish() });

interface ModelSource {
	bin: string;
	cwd?: string;
	overlay?: string;
}

interface Cache {
	key: string;
	value: ModelCatalogDTO | null;
	pending: Promise<ModelCatalogDTO> | null;
}

const EMPTY_CATALOG: ModelCatalogDTO = { models: [], defaultModel: null, fetchedAt: 0, error: null };

/** Catalog commands use the same resolved binary and worker overlay as sessions, without starting a session. */
export class ModelCatalog {
	readonly #source: () => ModelSource;
	#cache: Cache | null = null;

	constructor(source: () => ModelSource) {
		this.#source = source;
	}

	async get(refresh = false): Promise<ModelCatalogDTO> {
		let source: ModelSource;
		try {
			source = this.#source();
		} catch (err) {
			return { ...(this.#cache?.value ?? EMPTY_CATALOG), error: errorText(err) };
		}
		const previous = this.#cache?.value;
		const key = JSON.stringify(source);
		if (this.#cache?.key !== key) this.#cache = { key, value: null, pending: null };
		const cache = this.#cache;
		if (!refresh) {
			if (cache.pending) return cache.pending;
			if (cache.value) return cache.value;
		}
		// Refresh mutates omp's provider cache, so it must finish before the next catalog command.
		const request = (cache.pending ?? Promise.resolve()).then(async () => {
			try {
				const run = (args: string[], timeout: number) => execFileP(source.bin, [...(source.overlay ? ["--config", source.overlay] : []), ...args], {
					cwd: source.cwd,
					timeout,
					maxBuffer: 16 * 1024 * 1024,
				});
				if (refresh) await run(["models", "refresh"], 90_000);
				const listed = await run(["models", "--json"], 30_000);
				const configured = await run(["config", "get", "modelRoles", "--json"], 30_000);
				const models: ModelDTO[] = catalogSchema.parse(JSON.parse(listed.stdout)).models.filter(model => model.kind === "chat").map(raw => {
					const model = modelSchema.parse(raw);
					return {
						...model,
						contextWindow: model.contextWindow ?? null,
						maxTokens: model.maxTokens ?? null,
						thinking: model.reasoning ? THINKING_LEVELS.filter(level => level !== "off" && model.thinking.includes(level)) : [],
						cost: model.cost ?? null,
					};
				});
				let defaultModel = rolesSchema.parse(JSON.parse(configured.stdout)).value?.default ?? null;
				if (defaultModel) {
					const colon = defaultModel.lastIndexOf(":");
					if (colon !== -1 && thinkingSchema.safeParse(defaultModel.slice(colon + 1)).success) defaultModel = defaultModel.slice(0, colon);
				}
				cache.value = { models, defaultModel, fetchedAt: Date.now(), error: null };
			} catch (err) {
				cache.value = { ...(cache.value ?? previous ?? EMPTY_CATALOG), error: errorText(err) };
			}
			return cache.value;
		}).finally(() => {
			if (cache.pending === request) cache.pending = null;
		});
		cache.pending = request;
		return request;
	}
}
