import assert from "node:assert/strict";
import { test } from "node:test";
import { Db } from "../server/db.ts";
import { Indexer } from "../server/indexer.ts";
import { Ledger } from "../server/ledger.ts";

function setup() {
	const db = new Db(":memory:");
	const now = Date.now();
	db.run("INSERT INTO workspace (id, name, repo_path, default_base, created_at) VALUES ('deck', 'deck', '/r/deck', 'main', ?)", now);
	for (const [id, kind] of [
		["M-1", "main"],
		["W-1", "worker"],
	] as const) {
		db.run(
			"INSERT INTO session (id, kind, workspace_id, cwd, session_dir, model, thinking, created_at) VALUES (?, ?, ?, '/r', ?, '', 'high', ?)",
			id,
			kind,
			kind === "main" ? null : "deck",
			`/s/${id}`,
			now,
		);
	}
	const ledger = new Ledger(db);
	const create = (key: string) =>
		ledger.createTask({ title: "Fix it", workspaceId: "deck", checkout: { kind: "worktree" }, playbook: null, brief: "brief", related: [], dispatchKey: key, actor: "dispatcher" }).task;
	return { db, ledger, create };
}

test("createTask is idempotent per dispatcher spawn", () => {
	const { ledger } = setup();
	const input = { title: "A", workspaceId: "deck", checkout: { kind: "readonly" as const }, playbook: null, brief: "b", related: [], dispatchKey: "omp/agent-1", actor: "dispatcher" as const };
	const first = ledger.createTask(input);
	const again = ledger.createTask(input);
	assert.equal(first.created, true);
	assert.equal(again.created, false);
	assert.equal(again.task.id, first.task.id);
	assert.equal(ledger.createTask({ ...input, dispatchKey: "omp/agent-2" }).task.id, "T-2");
});

test("dispatch → delivery ack → run → report → done, with one pending notice", () => {
	const { ledger, create } = setup();
	const t = create("k1");
	ledger.apply(t.id, { kind: "provisioned", session: "W-1", reusedSession: false }, "hub", `provisioned:${t.id}`);
	const brief = ledger.enqueue({ sessionId: "W-1", taskId: t.id, kind: "prompt", deliver: "next", text: "brief", dedupeKey: `brief:${t.id}` });
	assert.equal(ledger.enqueue({ sessionId: "W-1", taskId: t.id, kind: "prompt", deliver: "next", text: "brief", dedupeKey: `brief:${t.id}` }).id, brief.id);
	ledger.ack(brief.id, "W-1");
	assert.equal(ledger.mustTask(t.id).status, "working");
	assert.equal(ledger.unacked("W-1").length, 0);
	ledger.apply(t.id, { kind: "run_started", seq: 1 }, "worker", "runstart:W-1:1:1");
	ledger.apply(t.id, { kind: "reported", status: "done", summary: "fixed", details: null }, "worker", "call:c1");
	assert.equal(ledger.mustTask(t.id).run_open, 1);
	const end = ledger.apply(t.id, { kind: "run_ended", seq: 1, stop: "completed", text: "ok", error: null }, "worker", "run:W-1:1:1");
	assert.deepEqual(end.notices, ["done"]);
	const replayed = ledger.apply(t.id, { kind: "run_ended", seq: 1, stop: "completed", text: "ok", error: null }, "worker", "run:W-1:1:1");
	assert.equal(replayed.applied, false);
	const row = ledger.mustTask(t.id);
	assert.equal(row.status, "done");
	assert.ok(row.ended_at);
	assert.deepEqual(ledger.pendingNotices().map(n => [n.kind, n.priority]), [["done", "normal"]]);
	assert.deepEqual(ledger.reports(t.id).map(r => r.summary), ["fixed"]);
});

test("one open task per session is enforced by the schema", () => {
	const { ledger, create } = setup();
	const a = create("a");
	const b = create("b");
	ledger.apply(a.id, { kind: "provisioned", session: "W-1", reusedSession: false }, "hub");
	assert.throws(() => ledger.apply(b.id, { kind: "provisioned", session: "W-1", reusedSession: true }, "hub"), /UNIQUE/);
	assert.equal(ledger.mustTask(b.id).session_id, null);
});

test("the wake budget is derived from wakes sent since the human last spoke; context batches with urgent notices pause main", () => {
	const { ledger, create, db } = setup();
	const t = create("k");
	ledger.apply(t.id, { kind: "provisioned", session: "W-1", reusedSession: false }, "hub");
	const urgent = () => {
		ledger.apply(t.id, { kind: "provision_failed", step: "env", message: `x${Math.random()}` }, "hub");
		ledger.apply(t.id, { kind: "provision_retry", text: "" }, "hub");
		return ledger.pendingNotices().map(n => n.id);
	};
	db.setMeta("human_input_at", String(Date.now() - 60_000));
	for (let i = 0; i < 3; i++) {
		const batch = ledger.enqueueBatch("M-1", urgent(), "wake", `batch ${i}`);
		ledger.markSent(batch.id);
		ledger.ack(batch.id, "M-1");
	}
	assert.equal(ledger.wakesSinceHuman("M-1"), 3);
	assert.equal(ledger.paused("M-1"), false);
	const ctx = ledger.enqueueBatch("M-1", urgent(), "context", "late");
	assert.equal(ledger.notifyInFlight("M-1"), true);
	ledger.markSent(ctx.id);
	ledger.ack(ctx.id, "M-1");
	assert.equal(ledger.paused("M-1"), true);
	assert.equal(ledger.pendingNotices().length, 0);
	db.setMeta("human_input_at", String(Date.now() + 1));
	assert.equal(ledger.wakesSinceHuman("M-1"), 0);
	assert.equal(ledger.paused("M-1"), false);
});

test("an approval request opens a hub escalation; the human resolving it closes it with an info notice", () => {
	const { ledger, create } = setup();
	const t = create("k");
	ledger.apply(t.id, { kind: "provisioned", session: "W-1", reusedSession: false }, "hub");
	ledger.apply(t.id, { kind: "delivered", outbox: 1, what: "brief" }, "hub");
	ledger.apply(t.id, { kind: "run_started", seq: 1 }, "worker");
	const r = ledger.apply(t.id, { kind: "approval_requested", tool: "bash", summary: "dropdb x" }, "worker");
	assert.equal(r.opened.length, 1);
	assert.equal(r.opened[0]!.opened_by, "hub");
	assert.deepEqual(r.notices, ["approval"]);
	const resolved = ledger.apply(t.id, { kind: "approval_resolved", approved: true }, "human");
	assert.deepEqual(resolved.notices, ["human_replied"]);
	const e = ledger.escalation(r.opened[0]!.id)!;
	assert.equal(e.resolution, "human_replied");
	assert.equal(ledger.mustTask(t.id).status, "working");
});

test("main's escalation is idempotent per task and closes when the human types in the worker", () => {
	const { ledger, create } = setup();
	const t = create("k");
	ledger.apply(t.id, { kind: "provisioned", session: "W-1", reusedSession: false }, "hub");
	const first = ledger.escalate(t.id, "W-1", "irreversible: drop S3 prefix", "main");
	const second = ledger.escalate(t.id, "W-1", "again", "main");
	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(second.escalation.id, first.escalation.id);
	ledger.apply(t.id, { kind: "human_input", text: "go ahead" }, "human");
	assert.equal(ledger.escalation(first.escalation.id)!.resolution, "human_replied");
	assert.equal(ledger.openEscalation(t.id), undefined);
});

test("decisions are deduplicated by tool call and record reverts", () => {
	const { ledger, create } = setup();
	const t = create("k");
	const d1 = ledger.logDecision({ taskId: t.id, summary: "Pick A", why: "reversible", revert: "send B", reverts: null, dedupeKey: "call:1", actor: "main" });
	assert.equal(ledger.logDecision({ taskId: t.id, summary: "Pick A", why: "reversible", revert: "send B", reverts: null, dedupeKey: "call:1", actor: "main" }).id, d1.id);
	const d2 = ledger.logDecision({ taskId: null, summary: "Undo A", why: "human asked", revert: "redo A", reverts: d1.id, dedupeKey: "call:2", actor: "main" });
	assert.equal(ledger.decisionDTO(d1).revertedBy, d2.id);
	assert.throws(() => ledger.logDecision({ taskId: null, summary: "x", why: "xxxxx", revert: "xxxxx", reverts: "D-99", dedupeKey: null, actor: "main" }), /no decision D-99/);
	assert.deepEqual(ledger.eventsOf(t.id, "decided").map(e => e.event.decision), [d1.id]);
});

test("search finds Chinese text with short and long terms, and chat pages are exclusive and ascending", () => {
	const { db, ledger, create } = setup();
	const indexer = new Indexer(db);
	const t = ledger.createTask({ title: "修复登录超时", workspaceId: "deck", checkout: { kind: "readonly" }, playbook: null, brief: "token 刷新竞态导致登录超时", related: [], dispatchKey: "z", actor: "dispatcher" }).task;
	indexer.brief(t);
	indexer.brief(create("other"));
	for (let i = 1; i <= 5; i++) indexer.capture("M-1", { key: `k${i}`, role: i % 2 ? "user" : "assistant", text: `消息 ${i} 登录`, raw: "{}", at: i });
	indexer.capture("M-1", { key: "k1", role: "user", text: "duplicate", raw: "{}", at: 9 });
	assert.deepEqual(indexer.search("登录超时", { scope: "tasks" }).map(h => h.taskId), [t.id]);
	assert.deepEqual(indexer.search("登录", { scope: "tasks" }).map(h => h.taskId), [t.id]);
	assert.equal(indexer.search("登录", { scope: "chat" }).length, 5);
	assert.match(indexer.search("竞态", { scope: "all" })[0]!.excerpt, /竞态/);
	assert.deepEqual(indexer.chat({ limit: 2 }).map(r => r.id), [4, 5]);
	assert.deepEqual(indexer.chat({ before: 4, limit: 2 }).map(r => r.id), [2, 3]);
	assert.deepEqual(indexer.chat({ after: 4, limit: 10 }).map(r => r.id), [5]);
	assert.deepEqual(indexer.chatAround(3, 1, 1).map(r => r.id), [2, 3, 4]);
});

test("open and closed task lists, endedAt, and the latest event for the in-flight list", () => {
	let clock = 1_000;
	const db = new Db(":memory:");
	db.run("INSERT INTO workspace (id, name, repo_path, default_base, created_at) VALUES ('deck', 'deck', '/r/deck', 'main', 0)");
	const ledger = new Ledger(db, () => clock);
	const create = (key: string) =>
		ledger.createTask({ title: key, workspaceId: "deck", checkout: { kind: "readonly" }, playbook: null, brief: "b", related: [], dispatchKey: key, actor: "dispatcher" }).task;
	const a = create("a");
	const b = create("b");
	const c = create("c");
	clock = 2_000;
	ledger.apply(b.id, { kind: "queued_for_capacity", live: 4, cap: 4 }, "hub");
	clock = 3_000;
	ledger.apply(c.id, { kind: "cancelled", by: "human", reason: "no" }, "human");
	ledger.apply(a.id, { kind: "accepted", reason: "fine", decision: null }, "main");

	const ids = (status: "open" | "closed") => ledger.listTasks({ status }).map(t => t.id).sort();
	assert.deepEqual(ids("open"), [b.id]);
	assert.deepEqual(ids("closed"), [a.id, c.id]);
	assert.deepEqual(ledger.listTasks({ status: "pending" }).map(t => t.id), [b.id]);

	assert.equal(ledger.summary(ledger.mustTask(b.id), null).endedAt, null);
	assert.equal(ledger.summary(ledger.mustTask(c.id), null).endedAt, 3_000);
	assert.equal(ledger.lastEventSummary(b.id), "waiting for a worker slot (4/4 live)");
	assert.equal(ledger.lastEventAt(b.id, ["queued_for_capacity"]), 2_000);
	assert.equal(ledger.lastEventAt(b.id, ["created", "provision_retry"]), 1_000);
	assert.equal(ledger.lastEventAt(b.id, ["provision_retry"]), null);

	// Reopening a finished task clears endedAt.
	clock = 4_000;
	ledger.apply(a.id, { kind: "message_sent", by: "human", text: "one more thing", mode: "next", decision: null }, "human");
	assert.equal(ledger.mustTask(a.id).status, "working");
	assert.equal(ledger.summary(ledger.mustTask(a.id), null).endedAt, null);
	assert.deepEqual(ids("open"), [a.id, b.id]);
});

