import type { CheckoutSpec } from "../shared/tools.ts";
import { foldTask, INITIAL, type TaskEvent } from "./core/task.ts";
import type { Db } from "./db.ts";
import { worktreePath } from "./git.ts";

/**
 * Ordered schema migrations: `up` turns version `from` into the next one inside one
 * transaction with foreign keys off. A new database is created from schema.sql at the
 * latest version directly, so each step only has to handle data that existed back then.
 */
export const MIGRATIONS: readonly { from: string; up(db: Db): void }[] = [
	{
		from: "1",
		up(db) {
			db.raw.exec(`CREATE TABLE recipe_check (
				workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
				id TEXT NOT NULL UNIQUE,
				recipe_hash TEXT NOT NULL,
				recipe TEXT NOT NULL,
				base TEXT NOT NULL,
				sha TEXT NOT NULL,
				path TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('running','passed','failed','cancelled')),
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				steps TEXT NOT NULL,
				processes TEXT NOT NULL DEFAULT '{}',
				cleaned INTEGER NOT NULL DEFAULT 0 CHECK (cleaned IN (0,1))
			) STRICT`);
		},
	},
	{ from: "2", up: worktreeLifecycle },
];

export const SCHEMA_VERSION = String(MIGRATIONS.length + 1);

/** v2 worktree checkout kinds, before the branch/main lanes. */
type V2Checkout = { kind: "worktree"; branch?: string; base?: string } | { kind: "continue"; task: string; session: "reuse" | "fresh" } | { kind: "readonly" };

interface V2Worktree {
	id: string;
	workspace_id: string;
	path: string;
	branch: string;
	base: string;
	state: "ready" | "missing" | "removed";
	created_at: number;
	removed_at: number | null;
}

interface V2Task {
	id: string;
	seq: number;
	title: string;
	workspace_id: string;
	checkout: string;
	worktree_id: string | null;
	status: string;
}

/** The v2 default branch name for a task dispatched without one (frozen here; v3 requires a name). */
function v2DefaultBranch(title: string, seq: number): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug ? `task/${slug}-${seq}` : `task/t${seq}`;
}

/**
 * v2 → v3: worktree rows store only the hub's intent (live/retiring/retired), checkouts
 * become lanes, `settled` is projected by refolding every task's events, `cleaned_up`
 * becomes `worktree_retired`, and `continues` links go (earlier work on a branch is the
 * tasks on its worktree).
 */
function worktreeLifecycle(db: Db): void {
	const worktrees = db.all<V2Worktree>("SELECT * FROM worktree");
	db.raw.exec(`CREATE TABLE worktree_v3 (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL REFERENCES workspace(id),
		branch TEXT NOT NULL,
		path TEXT NOT NULL,
		fork_ref TEXT NOT NULL,
		fork_sha TEXT,
		state TEXT NOT NULL CHECK (state IN ('live','retiring','retired')),
		retire_reason TEXT CHECK (retire_reason IN ('merged','unused','gone','discarded')),
		retired_sha TEXT,
		retire_error TEXT,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		CHECK ((state = 'live') = (retire_reason IS NULL)),
		CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
		UNIQUE (id, workspace_id)
	) STRICT`);
	for (const w of worktrees) {
		const removed = w.state === "removed";
		db.run(
			`INSERT INTO worktree_v3 (id, workspace_id, branch, path, fork_ref, fork_sha, state, retire_reason, retired_sha, created_at, retired_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
			w.id,
			w.workspace_id,
			w.branch,
			w.path,
			w.base,
			removed ? "retired" : "live",
			removed ? "discarded" : null,
			w.created_at,
			removed ? (w.removed_at ?? w.created_at) : null,
		);
	}
	db.raw.exec(`DROP TABLE worktree;
		ALTER TABLE worktree_v3 RENAME TO worktree;
		CREATE UNIQUE INDEX worktree_branch_live ON worktree(workspace_id, branch) WHERE state <> 'retired';
		CREATE UNIQUE INDEX worktree_path_live ON worktree(path) WHERE state <> 'retired';
		ALTER TABLE task ADD COLUMN settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0,1));
		CREATE INDEX task_by_worktree ON task(worktree_id, seq);
		CREATE TABLE task_link_v3 (
			task_id TEXT NOT NULL REFERENCES task(id),
			other_id TEXT NOT NULL REFERENCES task(id),
			PRIMARY KEY (task_id, other_id)
		) STRICT;
		INSERT INTO task_link_v3 (task_id, other_id) SELECT task_id, other_id FROM task_link WHERE kind = 'related';
		DROP TABLE task_link;
		ALTER TABLE task_link_v3 RENAME TO task_link;
		UPDATE task_event SET data = json_remove(data, '$.reusedSession') WHERE kind = 'provisioned';`);

	const branchOf = new Map(worktrees.map(w => [w.id, w]));
	const tasks = db.all<V2Task>("SELECT id, seq, title, workspace_id, checkout, worktree_id, status FROM task ORDER BY seq");
	const byId = new Map(tasks.map(t => [t.id, t]));
	// Written by SettingsStore (validated on save); only the worktree root matters here.
	const settings: { worktreeRoot?: string | null } = JSON.parse(db.meta("settings") ?? "{}");
	const worktreeRoot = settings.worktreeRoot ?? null;
	for (const t of tasks) {
		const old = JSON.parse(t.checkout) as V2Checkout;
		let worktreeId = t.worktree_id;
		let checkout: CheckoutSpec;
		if (old.kind === "readonly") checkout = { lane: "main" };
		else {
			const source = old.kind === "continue" ? byId.get(old.task) : t;
			const wt = (worktreeId ?? source?.worktree_id) ? branchOf.get((worktreeId ?? source?.worktree_id)!) : undefined;
			const named = old.kind === "worktree" ? (old.branch ?? v2DefaultBranch(t.title, t.seq)) : null;
			if (!wt && !named) checkout = { lane: "main" };
			else checkout = { lane: "branch", branch: wt?.branch ?? named!, ...(old.kind === "worktree" && old.base ? { base: old.base } : {}) };
			// Open branch tasks that never got their worktree need the claim v3 makes at dispatch.
			if (checkout.lane === "branch" && !worktreeId && t.status !== "done" && t.status !== "cancelled") worktreeId = claimV2(db, t, checkout.branch, old.kind === "worktree" ? old.base : undefined, worktreeRoot);
		}
		let state = INITIAL;
		for (const e of db.all<{ id: number; kind: string; data: string }>("SELECT id, kind, data FROM task_event WHERE task_id = ? ORDER BY id", t.id)) {
			let event = JSON.parse(e.data) as TaskEvent | { kind: "cleaned_up" };
			if (event.kind === "cleaned_up") {
				const wt = worktreeId ? branchOf.get(worktreeId) : undefined;
				event = { kind: "worktree_retired", reason: "discarded", branch: wt?.branch ?? "", sha: null, branchDeleted: false };
				db.run("UPDATE task_event SET kind = 'worktree_retired', data = ? WHERE id = ?", JSON.stringify(event), e.id);
			} else if (event.kind === "created") {
				event = { ...event, checkout, worktree: worktreeId };
				db.run("UPDATE task_event SET data = ? WHERE id = ?", JSON.stringify(event), e.id);
			}
			state = foldTask(state, event);
		}
		db.run("UPDATE task SET checkout = ?, worktree_id = ?, settled = ? WHERE id = ?", JSON.stringify(checkout), worktreeId, state.settled ? 1 : 0, t.id);
	}
	db.raw.exec("CREATE UNIQUE INDEX task_one_main_editor ON task(workspace_id) WHERE settled = 0 AND json_extract(checkout, '$.edit') = 1");
}

/** A live row for an open v2 task's branch (an existing live row for it is shared). */
function claimV2(db: Db, t: V2Task, branch: string, base: string | undefined, worktreeRoot: string | null): string {
	const live = db.get<{ id: string }>("SELECT id FROM worktree WHERE workspace_id = ? AND branch = ? AND state <> 'retired'", t.workspace_id, branch);
	if (live) return live.id;
	const ws = db.get<{ repo_path: string; default_base: string }>("SELECT repo_path, default_base FROM workspace WHERE id = ?", t.workspace_id)!;
	const { id } = db.nextId("WT");
	db.run(
		"INSERT INTO worktree (id, workspace_id, branch, path, fork_ref, fork_sha, state, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'live', ?)",
		id,
		t.workspace_id,
		branch,
		worktreePath(ws.repo_path, branch, worktreeRoot),
		base ?? ws.default_base,
		Date.now(),
	);
	return id;
}
