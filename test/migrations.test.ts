import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Db } from "../server/db.ts";
import { SCHEMA_VERSION } from "../server/migrations.ts";

const V1_SCHEMA = path.join(import.meta.dirname, "fixtures", "schema-v1.sql");

/** Columns and indexes of every table: what a migrated database must share with a new one. */
function structure(db: DatabaseSync): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_fts%' ORDER BY name").all() as { name: string }[];
	for (const { name } of tables) {
		const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(c => ({ ...c }));
		const indexes = (db.prepare(`PRAGMA index_list(${name})`).all() as { name: string; unique: number; partial: number }[])
			.filter(i => !i.name.startsWith("sqlite_autoindex"))
			.map(i => ({ name: i.name, unique: i.unique, partial: i.partial, columns: db.prepare(`PRAGMA index_xinfo(${i.name})`).all().map(c => ({ ...c })) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		out[name] = { columns, indexes };
	}
	return out;
}

test("v1 databases are backed up and migrated to the lifecycle schema with their meaning kept", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-migrate-"));
	const file = path.join(dir, "home.db");
	const old = new DatabaseSync(file);
	old.exec(fs.readFileSync(V1_SCHEMA, "utf8"));
	const run = (sql: string, ...params: (string | number | null)[]) => old.prepare(sql).run(...params);
	run("INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('settings', ?), ('next:WT', '4')", JSON.stringify({ worktreeRoot: path.join(dir, "trees") }));
	run("INSERT INTO workspace (id, name, repo_path, default_base, created_at) VALUES ('deck', 'deck', '/r/deck', 'main', 1)");
	for (const [id, branch, state] of [["WT-1", "task/t1", "ready"], ["WT-2", "task/b-2", "missing"], ["WT-3", "feat/c", "removed"]] as const) {
		run("INSERT INTO worktree (id, workspace_id, path, branch, base, state, created_at, removed_at) VALUES (?, 'deck', ?, ?, 'main', ?, 1, ?)", id, `/r/deck.worktrees/${branch.replace("/", "-")}`, branch, state, state === "removed" ? 5 : null);
	}
	run("INSERT INTO session (id, kind, workspace_id, worktree_id, cwd, session_dir, model, thinking, created_at) VALUES ('W-1', 'worker', 'deck', 'WT-1', '/r', '/s/W-1', '', 'high', 1)");
	const tasks: [string, number, string, unknown, string | null, string, unknown[]][] = [
		["T-1", 1, "修复购物车", { kind: "worktree" }, "WT-1", "done", [{ kind: "provisioned", session: "W-1", reusedSession: false }, { kind: "accepted", reason: "ok", decision: null }]],
		["T-2", 2, "Continue it", { kind: "continue", task: "T-1", session: "reuse" }, "WT-1", "done", [{ kind: "provisioned", session: "W-1", reusedSession: true }, { kind: "reported", status: "done", summary: "s", details: null }]],
		["T-3", 3, "Look around", { kind: "readonly" }, null, "done", [{ kind: "accepted", reason: "ok", decision: null }]],
		["T-4", 4, "Cleaned", { kind: "worktree", branch: "feat/c", base: "main" }, "WT-3", "done", [{ kind: "accepted", reason: "ok", decision: null }, { kind: "cleaned_up" }]],
		["T-5", 5, "Not set up yet", { kind: "worktree", branch: "feat/new" }, null, "pending", []],
		["T-6", 6, "Never ran", { kind: "worktree" }, null, "cancelled", [{ kind: "cancelled", by: "main", reason: "no" }]],
		["T-7", 7, "Reopened", { kind: "worktree" }, "WT-2", "working", [{ kind: "accepted", reason: "ok", decision: null }, { kind: "message_sent", by: "main", text: "more", mode: "next", decision: null }]],
	];
	for (const [id, seq, title, checkout, wt, status, events] of tasks) {
		run(
			"INSERT INTO task (id, seq, title, workspace_id, checkout, brief, worktree_id, status, dispatch_key, created_at, updated_at, ended_at) VALUES (?, ?, ?, 'deck', ?, 'b', ?, ?, ?, 1, 1, ?)",
			id, seq, title, JSON.stringify(checkout), wt, status, `k${seq}`, status === "done" || status === "cancelled" ? 2 : null,
		);
		for (const e of [{ kind: "created", title, workspace: "deck", checkout, playbook: null, related: [] }, ...events]) {
			run("INSERT INTO task_event (task_id, at, actor, kind, data) VALUES (?, 1, 'hub', ?, ?)", id, (e as { kind: string }).kind, JSON.stringify(e));
		}
	}
	run("INSERT INTO task_link (task_id, other_id, kind) VALUES ('T-2', 'T-1', 'continues'), ('T-3', 'T-1', 'related')");
	old.close();

	const db = new Db(file);
	assert.equal(db.meta("schema_version"), SCHEMA_VERSION);
	assert.ok(fs.readdirSync(dir).some(f => /^home\.db\.v1-\d+\.bak$/.test(f)), "backup before migrating");

	assert.deepEqual(db.all<Record<string, unknown>>("SELECT id, branch, state, retire_reason, fork_ref, fork_sha, retired_at FROM worktree ORDER BY id").map(r => ({ ...r })), [
		{ id: "WT-1", branch: "task/t1", state: "live", retire_reason: null, fork_ref: "main", fork_sha: null, retired_at: null },
		{ id: "WT-2", branch: "task/b-2", state: "live", retire_reason: null, fork_ref: "main", fork_sha: null, retired_at: null },
		{ id: "WT-3", branch: "feat/c", state: "retired", retire_reason: "discarded", fork_ref: "main", fork_sha: null, retired_at: 5 },
		{ id: "WT-4", branch: "feat/new", state: "live", retire_reason: null, fork_ref: "main", fork_sha: null, retired_at: null },
	]);
	assert.equal(db.get<{ path: string }>("SELECT path FROM worktree WHERE id = 'WT-4'")!.path, path.join(dir, "trees", "deck.worktrees", "feat-new"));
	const rows = db.all<{ id: string; checkout: string; worktree_id: string | null; settled: number }>("SELECT id, checkout, worktree_id, settled FROM task ORDER BY seq");
	assert.deepEqual(rows.map(r => [r.id, JSON.parse(r.checkout), r.worktree_id, r.settled]), [
		["T-1", { lane: "branch", branch: "task/t1" }, "WT-1", 1],
		["T-2", { lane: "branch", branch: "task/t1" }, "WT-1", 0],
		["T-3", { lane: "main" }, null, 1],
		["T-4", { lane: "branch", branch: "feat/c", base: "main" }, "WT-3", 1],
		["T-5", { lane: "branch", branch: "feat/new" }, "WT-4", 0],
		["T-6", { lane: "branch", branch: "task/never-ran-6" }, null, 1],
		["T-7", { lane: "branch", branch: "task/b-2" }, "WT-2", 0],
	]);
	const created = JSON.parse(db.get<{ data: string }>("SELECT data FROM task_event WHERE task_id = 'T-5' AND kind = 'created'")!.data);
	assert.deepEqual([created.checkout, created.worktree], [{ lane: "branch", branch: "feat/new" }, "WT-4"]);
	assert.deepEqual(JSON.parse(db.get<{ data: string }>("SELECT data FROM task_event WHERE task_id = 'T-4' AND kind = 'worktree_retired'")!.data), {
		kind: "worktree_retired", reason: "discarded", branch: "feat/c", sha: null, branchDeleted: false,
	});
	assert.equal(db.get("SELECT 1 FROM task_event WHERE kind = 'cleaned_up'"), undefined);
	assert.deepEqual(JSON.parse(db.get<{ data: string }>("SELECT data FROM task_event WHERE task_id = 'T-2' AND kind = 'provisioned'")!.data), { kind: "provisioned", session: "W-1" });
	assert.deepEqual(db.all<Record<string, unknown>>("SELECT * FROM task_link").map(r => ({ ...r })), [{ task_id: "T-3", other_id: "T-1" }]);

	const fresh = new Db(":memory:");
	assert.deepEqual(structure(db.raw), structure(fresh.raw), "a migrated database has exactly the schema of a new one");
	db.close();
	fresh.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("one unsettled task edits a workspace's main checkout at a time", () => {
	const db = new Db(":memory:");
	db.run("INSERT INTO workspace (id, name, repo_path, default_base, created_at) VALUES ('deck', 'deck', '/r/deck', 'main', 1)");
	const insert = (id: string, seq: number, settled: number, checkout: unknown) =>
		db.run("INSERT INTO task (id, seq, title, workspace_id, checkout, brief, status, dispatch_key, created_at, updated_at, settled) VALUES (?, ?, 't', 'deck', ?, 'b', 'pending', ?, 1, 1, ?)", id, seq, JSON.stringify(checkout), id, settled);
	insert("T-1", 1, 0, { lane: "main", edit: true });
	insert("T-2", 2, 0, { lane: "main" });
	insert("T-3", 3, 1, { lane: "main", edit: true });
	assert.throws(() => insert("T-4", 4, 0, { lane: "main", edit: true }), /UNIQUE constraint failed: task\.workspace_id/);
	assert.throws(() => db.run("UPDATE task SET settled = 0 WHERE id = 'T-3'"), /UNIQUE/);
	db.close();
});
