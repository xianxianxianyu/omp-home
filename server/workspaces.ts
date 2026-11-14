import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Language, RecipeDTO, RepoInspection, RepoSuggestion, WorkspaceDTO } from "../shared/api.ts";
import { IdError, parseWorkspaceId, slugify } from "../shared/ids.ts";
import { writeFileAtomic, type HomePaths } from "./config.ts";
import { parseRecipe, type EnvRecipe } from "./core/recipe.ts";
import type { Db } from "./db.ts";
import { fieldErrors, HubError, localizedField, localizeFieldErrors } from "./errors.ts";
import { defaultBase, inspectGit, repoRoot } from "./git.ts";
import { messages } from "./i18n.ts";
import { validationMessages as m } from "./i18n-validation.ts";
import { detectCommands, discoverRepositories } from "./repo-discovery.ts";

export interface WorkspaceRow {
	id: string;
	name: string;
	repo_path: string;
	default_base: string;
	worker_model: string | null;
	created_at: number;
	archived_at: number | null;
}

/** Invalid-recipe errors carry English messages for model-facing callers; localizeFieldErrors renders them for the UI. */
export type LoadedRecipe =
	| { status: "missing" }
	| { status: "invalid"; errors: RecipeDTO["errors"] }
	| { status: "ok"; recipe: EnvRecipe; hash: string };

const createSchema = z.strictObject({
	repoPath: z.string().min(1),
	name: z.string().trim().min(1).max(80).optional(),
	id: z.string().optional(),
	defaultBase: z.string().trim().min(1).optional(),
	workerModel: z.string().trim().min(1).nullable().optional(),
	recipe: z.string().max(200_000).optional(),
});
const patchSchema = z.strictObject({
	name: z.string().trim().min(1).max(80).optional(),
	defaultBase: z.string().trim().min(1).optional(),
	workerModel: z.string().trim().min(1).nullable().optional(),
});

/** Sole writer of `workspace`; owns the recipe and notes files under `<home>/repos/`. */
export class Workspaces {
	readonly #db: Db;
	readonly #paths: HomePaths;
	readonly #worktreeRoot: () => string | null;
	#discovery: { expiresAt: number; worktreeRoot: string | null; pending: Promise<RepoSuggestion[]> } | undefined;

	constructor(db: Db, paths: HomePaths, worktreeRoot: () => string | null) {
		this.#db = db;
		this.#paths = paths;
		this.#worktreeRoot = worktreeRoot;
	}

	get(id: string): WorkspaceRow | undefined {
		return this.#db.get<WorkspaceRow>("SELECT * FROM workspace WHERE id = ?", id);
	}

	must(id: string): WorkspaceRow {
		const row = this.get(id);
		if (!row) throw new HubError("not_found", m.noWorkspace(id, this.list().map(w => w.id)));
		return row;
	}

	list(includeArchived = false): WorkspaceRow[] {
		return this.#db.all<WorkspaceRow>(`SELECT * FROM workspace ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY id`);
	}

	async create(body: unknown): Promise<WorkspaceRow> {
		const parsed = createSchema.safeParse(body);
		if (!parsed.success) throw new HubError("unprocessable", m.invalidWorkspace(), fieldErrors(parsed.error.issues));
		const input = parsed.data;
		if (input.recipe !== undefined) {
			const recipe = parseRecipe(input.recipe);
			if (!recipe.ok) {
				for (const error of recipe.errors) error.path = "recipe";
				throw new HubError("unprocessable", m.invalidRecipe(), recipe.errors);
			}
		}
		const resolved = path.resolve(input.repoPath);
		if (!fs.existsSync(resolved)) throw new HubError("unprocessable", m.pathMissing(resolved), [localizedField("repoPath", m.doesNotExist())]);
		let root: string;
		try {
			root = fs.realpathSync(await repoRoot(resolved));
		} catch {
			throw new HubError("unprocessable", m.notInGitRepo(resolved), [localizedField("repoPath", m.notGitRepo())]);
		}
		const taken = this.#db.get<WorkspaceRow>("SELECT * FROM workspace WHERE repo_path = ?", root);
		if (taken) throw new HubError("conflict", m.repoTaken(root, taken.id));
		const name = input.name ?? path.basename(root);
		let id: string;
		if (input.id !== undefined) {
			try {
				id = parseWorkspaceId(input.id);
			} catch (err) {
				if (!(err instanceof IdError)) throw err;
				const invalid = messages.invalidId("workspace id", JSON.stringify(input.id));
				throw new HubError("unprocessable", invalid, [localizedField("id", invalid)]);
			}
			if (this.get(id)) throw new HubError("conflict", m.workspaceIdTaken(id));
		} else {
			id = this.#availableId(name);
		}
		const base = input.defaultBase ?? (await defaultBase(root));
		this.#db.run(
			"INSERT INTO workspace (id, name, repo_path, default_base, worker_model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			id,
			name,
			root,
			base,
			input.workerModel ?? null,
			Date.now(),
		);
		if (input.recipe !== undefined) {
			fs.mkdirSync(this.#paths.repos, { recursive: true });
			writeFileAtomic(this.recipePath(id), input.recipe.endsWith("\n") ? input.recipe : `${input.recipe}\n`, 0o644, false);
		}
		const notes = this.notesPath(id);
		if (!fs.existsSync(notes)) {
			fs.mkdirSync(path.dirname(notes), { recursive: true });
			fs.writeFileSync(notes, `# ${name}\n\nRepo: ${root}\nDefault base: ${base}\n\nConventions, pitfalls and how to test go here; the dispatcher reads this file.\n`);
		}
		return this.must(id);
	}

	patch(id: string, body: unknown): WorkspaceRow {
		this.must(id);
		const parsed = patchSchema.safeParse(body);
		if (!parsed.success) throw new HubError("unprocessable", m.invalidWorkspacePatch(), fieldErrors(parsed.error.issues));
		const p = parsed.data;
		if (p.name !== undefined) this.#db.run("UPDATE workspace SET name = ? WHERE id = ?", p.name, id);
		if (p.defaultBase !== undefined) this.#db.run("UPDATE workspace SET default_base = ? WHERE id = ?", p.defaultBase, id);
		if (p.workerModel !== undefined) this.#db.run("UPDATE workspace SET worker_model = ? WHERE id = ?", p.workerModel, id);
		return this.must(id);
	}

	archive(id: string): WorkspaceRow {
		this.must(id);
		const open = this.#db.get<{ n: number }>("SELECT count(*) AS n FROM task WHERE workspace_id = ? AND status NOT IN ('done','cancelled')", id)!.n;
		if (open) throw new HubError("conflict", m.workspaceOpenTasks(id, open));
		this.#db.run("UPDATE workspace SET archived_at = coalesce(archived_at, ?) WHERE id = ?", Date.now(), id);
		return this.must(id);
	}

	recipePath(id: string): string {
		return path.join(this.#paths.repos, `${id}.env.yaml`);
	}

	notesPath(id: string): string {
		return path.join(this.#paths.repos, `${id}.md`);
	}

	loadRecipe(id: string): LoadedRecipe {
		let text: string;
		try {
			text = fs.readFileSync(this.recipePath(id), "utf8");
		} catch {
			return { status: "missing" };
		}
		const r = parseRecipe(text);
		return r.ok ? { status: "ok", recipe: r.recipe, hash: r.hash } : { status: "invalid", errors: r.errors };
	}

	readRecipe(id: string, language: Language = "en"): RecipeDTO {
		this.must(id);
		const file = this.recipePath(id);
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const loaded = this.loadRecipe(id);
		return { workspace: id, path: file, text, status: loaded.status, errors: loaded.status === "invalid" ? localizeFieldErrors(loaded.errors, language) : [] };
	}

	/** Validated, atomic write; an invalid recipe is rejected with field errors and not written. */
	writeRecipe(id: string, text: string, language: Language = "en"): RecipeDTO {
		this.must(id);
		const r = parseRecipe(text);
		if (!r.ok) throw new HubError("unprocessable", m.invalidRecipe(), r.errors);
		const file = this.recipePath(id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomic(file, text.endsWith("\n") ? text : `${text}\n`);
		return this.readRecipe(id, language);
	}

	dto(w: WorkspaceRow): WorkspaceDTO {
		const sessions = this.#db.get<{ total: number; live: number }>(
			"SELECT count(*) AS total, coalesce(sum(pid IS NOT NULL), 0) AS live FROM session WHERE workspace_id = ? AND retired_at IS NULL",
			w.id,
		)!;
		const open = this.#db.get<{ n: number }>("SELECT count(*) AS n FROM task WHERE workspace_id = ? AND status NOT IN ('done','cancelled')", w.id)!.n;
		return {
			id: w.id,
			name: w.name,
			repoPath: w.repo_path,
			defaultBase: w.default_base,
			workerModel: w.worker_model,
			notesPath: this.notesPath(w.id),
			recipePath: this.recipePath(w.id),
			recipeStatus: this.loadRecipe(w.id).status,
			liveSessions: sessions.live,
			totalSessions: sessions.total,
			openTasks: open,
			archived: w.archived_at !== null,
		};
	}

	#availableId(name: string): string {
		const base = slugify(name);
		let id = base;
		for (let n = 2; this.get(id); n++) id = `${base.slice(0, 36)}-${n}`;
		return id;
	}

	#repositories(): Promise<RepoSuggestion[]> {
		const worktreeRoot = this.#worktreeRoot();
		if (!this.#discovery || this.#discovery.expiresAt <= Date.now() || this.#discovery.worktreeRoot !== worktreeRoot) {
			const pending = discoverRepositories(this.#paths, worktreeRoot, this.list(true).map(w => w.repo_path));
			this.#discovery = { expiresAt: Date.now() + 30_000, worktreeRoot, pending };
			void pending.catch(() => {
				if (this.#discovery?.pending === pending) this.#discovery = undefined;
			});
		}
		return this.#discovery.pending;
	}

	async suggestions(): Promise<RepoSuggestion[]> {
		const registered = new Map(this.list(true).map(w => [w.repo_path, w.id]));
		return (await this.#repositories()).map(repo => ({ ...repo, registeredAs: registered.get(repo.path) ?? null }))
			.sort((a, b) => Number(a.registeredAs !== null) - Number(b.registeredAs !== null) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
	}

	async inspect(dir: string): Promise<RepoInspection> {
		const chosen = path.resolve(dir);
		const git = await inspectGit(chosen);
		const registered = git.root ? this.list(true).find(w => w.repo_path === git.root) : undefined;
		const name = path.basename(git.root ?? chosen);
		const id = registered?.id ?? this.#availableId(name);
		const detected = detectCommands(git.root ?? chosen);
		const existing = this.recipePath(id);
		const hasRecipe = fs.existsSync(existing);
		const repo = git.root ? (await this.#repositories()).find(r => r.path === git.root) : undefined;
		return {
			path: chosen,
			...git,
			name,
			id,
			registeredAs: registered?.id ?? null,
			omp: { sessions: repo?.ompSessions ?? 0, lastUsedAt: repo?.lastUsedAt ?? null, lastTitle: repo?.lastTitle ?? null },
			...detected,
			recipeDraft: hasRecipe ? fs.readFileSync(existing, "utf8") : detected.recipeDraft,
			hasRecipe,
		};
	}
}
