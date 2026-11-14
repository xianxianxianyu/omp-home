import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RecipeDTO, ScanCandidate, WorkspaceDTO } from "../shared/api.ts";
import { IdError, parseWorkspaceId, slugify } from "../shared/ids.ts";
import { writeFileAtomic, type HomePaths } from "./config.ts";
import { parseRecipe, type EnvRecipe } from "./core/recipe.ts";
import type { Db } from "./db.ts";
import { fieldErrors, HubError } from "./errors.ts";
import { defaultBase, repoRoot } from "./git.ts";

export interface WorkspaceRow {
	id: string;
	name: string;
	repo_path: string;
	default_base: string;
	worker_model: string | null;
	created_at: number;
	archived_at: number | null;
}

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

	constructor(db: Db, paths: HomePaths) {
		this.#db = db;
		this.#paths = paths;
	}

	get(id: string): WorkspaceRow | undefined {
		return this.#db.get<WorkspaceRow>("SELECT * FROM workspace WHERE id = ?", id);
	}

	must(id: string): WorkspaceRow {
		const row = this.get(id);
		if (!row) {
			const known = this.list().map(w => w.id);
			throw new HubError("not_found", `no workspace "${id}"${known.length ? `; known: ${known.join(", ")}` : ""}`);
		}
		return row;
	}

	list(includeArchived = false): WorkspaceRow[] {
		return this.#db.all<WorkspaceRow>(`SELECT * FROM workspace ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY id`);
	}

	async create(body: unknown): Promise<WorkspaceRow> {
		const parsed = createSchema.safeParse(body);
		if (!parsed.success) throw new HubError("unprocessable", "invalid workspace", fieldErrors(parsed.error.issues));
		const input = parsed.data;
		const resolved = path.resolve(input.repoPath);
		if (!fs.existsSync(resolved)) throw new HubError("unprocessable", `${resolved} does not exist`, [{ path: "repoPath", message: "does not exist" }]);
		let root: string;
		try {
			root = fs.realpathSync(await repoRoot(resolved));
		} catch {
			throw new HubError("unprocessable", `${resolved} is not inside a git repository`, [{ path: "repoPath", message: "not a git repository" }]);
		}
		const taken = this.#db.get<WorkspaceRow>("SELECT * FROM workspace WHERE repo_path = ?", root);
		if (taken) throw new HubError("conflict", `${root} is already workspace "${taken.id}"`);
		const name = input.name ?? path.basename(root);
		let id: string;
		if (input.id !== undefined) {
			try {
				id = parseWorkspaceId(input.id);
			} catch (err) {
				if (err instanceof IdError) throw new HubError("unprocessable", err.message, [{ path: "id", message: err.message }]);
				throw err;
			}
			if (this.get(id)) throw new HubError("conflict", `workspace id "${id}" is taken`);
		} else {
			const base = slugify(name);
			id = base;
			for (let n = 2; this.get(id); n++) id = `${base.slice(0, 36)}-${n}`;
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
		if (!parsed.success) throw new HubError("unprocessable", "invalid workspace patch", fieldErrors(parsed.error.issues));
		const p = parsed.data;
		if (p.name !== undefined) this.#db.run("UPDATE workspace SET name = ? WHERE id = ?", p.name, id);
		if (p.defaultBase !== undefined) this.#db.run("UPDATE workspace SET default_base = ? WHERE id = ?", p.defaultBase, id);
		if (p.workerModel !== undefined) this.#db.run("UPDATE workspace SET worker_model = ? WHERE id = ?", p.workerModel, id);
		return this.must(id);
	}

	archive(id: string): WorkspaceRow {
		this.must(id);
		const open = this.#db.get<{ n: number }>("SELECT count(*) AS n FROM task WHERE workspace_id = ? AND status NOT IN ('done','cancelled')", id)!.n;
		if (open) throw new HubError("conflict", `workspace "${id}" has ${open} open task(s); close them first`);
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

	readRecipe(id: string): RecipeDTO {
		this.must(id);
		const file = this.recipePath(id);
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		const loaded = this.loadRecipe(id);
		return { workspace: id, path: file, text, status: loaded.status, errors: loaded.status === "invalid" ? loaded.errors : [] };
	}

	/** Validated, atomic write; an invalid recipe is rejected with field errors and not written. */
	writeRecipe(id: string, text: string): RecipeDTO {
		this.must(id);
		const r = parseRecipe(text);
		if (!r.ok) throw new HubError("unprocessable", "invalid recipe", r.errors);
		const file = this.recipePath(id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomic(file, text.endsWith("\n") ? text : `${text}\n`);
		return this.readRecipe(id);
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

	/** Absolute directories named in the home AGENTS.md, as workspace candidates. */
	async scan(): Promise<ScanCandidate[]> {
		let text: string;
		try {
			text = fs.readFileSync(this.#paths.agents, "utf8");
		} catch {
			return [];
		}
		const seen = new Set<string>();
		const out: ScanCandidate[] = [];
		for (const m of text.matchAll(/(?:^|[\s`'"(\[<:：])(\/[^\s`'"()\[\]<>,;，。、]+)/g)) {
			const candidate = m[1]!.replace(/[.:)/]+$/, "");
			if (seen.has(candidate) || candidate.startsWith(this.#paths.data)) continue;
			seen.add(candidate);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(candidate);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;
			const real = fs.realpathSync(candidate);
			const isGitRepo = await repoRoot(real).then(
				root => fs.realpathSync(root) === real,
				() => false,
			);
			const alreadyAdded = !!this.#db.get("SELECT 1 FROM workspace WHERE repo_path = ?", real);
			out.push({ repoPath: real, name: path.basename(real), alreadyAdded, isGitRepo });
		}
		return out;
	}
}
