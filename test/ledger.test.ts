import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskEvent } from "../server/core/task.ts";
import { Db } from "../server/db.ts";
import { HubError } from "../server/errors.ts";
import { Indexer } from "../server/indexer.ts";
import { describeEvent, Ledger, waitOf } from "../server/ledger.ts";

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
	assert.equal(ledger.lastEventSummary(b.id, "zh"), "等待空闲执行者（已启动 4/4）");
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

test("every timeline event renders in English and Chinese without translating payload text", () => {
	const cases: { event: TaskEvent; en: string; zh: string }[] = [
		{ event: { kind: "created", title: "Raw title", workspace: "deck", checkout: { kind: "worktree" }, playbook: "Raw playbook", related: [] }, en: "created in deck (worktree, playbook Raw playbook)", zh: "已在 deck 创建（工作树，执行方案 Raw playbook）" },
		{ event: { kind: "created", title: "Raw title", workspace: "deck", checkout: { kind: "readonly" }, playbook: null, related: [] }, en: "created in deck (readonly)", zh: "已在 deck 创建（只读）" },
		{ event: { kind: "created", title: "Raw title", workspace: "deck", checkout: { kind: "continue", task: "T-1", session: "reuse" }, playbook: null, related: [] }, en: "created in deck (continue)", zh: "已在 deck 创建（沿用工作树）" },
		{ event: { kind: "checked_out", worktree: "WT-1", branch: "feat/raw", path: "/tmp/Raw" }, en: "worktree WT-1 on feat/raw at /tmp/Raw", zh: "工作树 WT-1，分支 feat/raw，路径 /tmp/Raw" },
		{ event: { kind: "provisioned", session: "W-1", reusedSession: false }, en: "new session W-1", zh: "新建会话 W-1" },
		{ event: { kind: "provisioned", session: "W-1", reusedSession: true }, en: "reusing session W-1", zh: "沿用会话 W-1" },
		{ event: { kind: "provision_failed", step: "env", message: "Raw stderr" }, en: "provisioning failed at env: Raw stderr", zh: "准备环境失败：Raw stderr" },
		{ event: { kind: "provision_retry", text: "Raw guidance" }, en: "provisioning retried", zh: "已重试准备环境" },
		{ event: { kind: "queued_for_capacity", live: 2, cap: 3 }, en: "waiting for a worker slot (2/3 live)", zh: "等待空闲执行者（已启动 2/3）" },
		{ event: { kind: "delivered", outbox: 8, what: "brief" }, en: "brief delivered (outbox #8)", zh: "任务说明已送达（发件箱 #8）" },
		{ event: { kind: "delivered", outbox: 9, what: "message" }, en: "message delivered (outbox #9)", zh: "消息已送达（发件箱 #9）" },
		{ event: { kind: "run_started", seq: 2 }, en: "run 2 started", zh: "第 2 次运行已开始" },
		{ event: { kind: "run_ended", seq: 2, stop: "error", text: "Raw model text", error: "Raw ERROR" }, en: "run 2 ended: error (Raw ERROR)", zh: "第 2 次运行已结束：出错（Raw ERROR）" },
		{ event: { kind: "reported", status: "question", summary: "Raw question?", details: "Raw details" }, en: "report question: Raw question?", zh: "汇报（有疑问）：Raw question?" },
		{ event: { kind: "approval_requested", tool: "bash", summary: "rm /tmp/Raw" }, en: "approval requested for bash: rm /tmp/Raw", zh: "bash 请求审批：rm /tmp/Raw" },
		{ event: { kind: "approval_resolved", approved: true }, en: "approved", zh: "已批准" },
		{ event: { kind: "approval_resolved", approved: false }, en: "denied", zh: "已拒绝" },
		{ event: { kind: "human_input", text: "Raw 用户 text" }, en: "human typed: Raw 用户 text", zh: "你输入了：Raw 用户 text" },
		{ event: { kind: "message_sent", by: "main", text: "Raw model text", mode: "next", decision: "D-1" }, en: "main sent (next) with D-1: Raw model text", zh: "主对话已发送（下轮），关联 D-1：Raw model text" },
		{ event: { kind: "message_sent", by: "human", text: "Raw user text", mode: "now", decision: null }, en: "human sent (now): Raw user text", zh: "你已发送（立即）：Raw user text" },
		{ event: { kind: "process_lost", reason: "Raw reason" }, en: "process lost: Raw reason", zh: "进程已断开：Raw reason" },
		{ event: { kind: "policy_blocked", tool: "bash", reason: "Raw policy", command: "rm /tmp/Raw" }, en: "blocked bash: rm /tmp/Raw", zh: "已拦截 bash：rm /tmp/Raw" },
		{ event: { kind: "escalated", escalation: "E-1", by: "main", reason: "Raw reason" }, en: "E-1 opened by main: Raw reason", zh: "主对话发起了请示 E-1：Raw reason" },
		{ event: { kind: "escalation_closed", escalation: "E-1", resolution: "human_replied" }, en: "E-1 closed: human_replied", zh: "请示 E-1 已结束：你已回复" },
		{ event: { kind: "decided", decision: "D-1", summary: "Raw summary" }, en: "D-1: Raw summary", zh: "D-1：Raw summary" },
		{ event: { kind: "accepted", reason: "Raw reason", decision: null }, en: "accepted as done: Raw reason", zh: "已确认完成：Raw reason" },
		{ event: { kind: "cancelled", by: "human", reason: "Raw reason" }, en: "cancelled by human: Raw reason", zh: "你已取消：Raw reason" },
		{ event: { kind: "cleaned_up" }, en: "environment torn down and worktree removed", zh: "环境已清理，工作树已移除" },
	];
	for (const { event, en, zh } of cases) {
		const stored = JSON.stringify(event);
		assert.equal(describeEvent(event), en);
		assert.equal(describeEvent(event, "en"), en);
		assert.equal(describeEvent(event, "zh"), zh);
		assert.equal(JSON.stringify(event), stored);
	}
});

test("task lastEvent and timeline DTOs localize on each read and retain original event data", () => {
	const { ledger, create } = setup();
	const t = create("localized-timeline");
	const event: TaskEvent = { kind: "human_input", text: "The run failed. 原文 /tmp/Raw" };
	ledger.apply(t.id, event, "human");
	const stored = ledger.events(t.id).at(-1)!;
	assert.equal(ledger.lastEventSummary(t.id), "human typed: The run failed. 原文 /tmp/Raw");
	assert.equal(ledger.lastEventSummary(t.id, "zh"), "你输入了：The run failed. 原文 /tmp/Raw");
	assert.equal(ledger.eventDTO(stored, "zh").summary, "你输入了：The run failed. 原文 /tmp/Raw");
	assert.deepEqual(ledger.eventDTO(stored, "zh").data, event);
	assert.deepEqual(ledger.eventDTO(stored).data, event);
	assert.equal(ledger.events(t.id).at(-1)!.data, stored.data);
	assert.equal(ledger.lastEventSummary("T-999", "zh"), null);
});

test("task wait summaries render bilingually from persisted metadata without mutating rows", () => {
	const { db, ledger, create } = setup();
	const t = create("localized-wait");
	ledger.apply(t.id, { kind: "run_started", seq: 1 }, "worker");
	ledger.apply(t.id, { kind: "reported", status: "progress", summary: "Raw progress /tmp/Foo", details: null }, "worker");
	ledger.apply(t.id, { kind: "run_ended", seq: 1, stop: "completed", text: "Raw final 用户", error: null }, "worker");
	const row = ledger.mustTask(t.id);
	const stored = row.wait;
	const reopened = new Ledger(db);
	assert.deepEqual(reopened.summary(row, null).wait, { kind: "no_report", text: "Progress report: Raw progress /tmp/Foo\n\nFinal text: Raw final 用户" });
	assert.deepEqual(reopened.summary(row, null, "zh").wait, { kind: "no_report", text: "进展汇报：Raw progress /tmp/Foo\n\n最终回复：Raw final 用户" });
	assert.equal(waitOf(row)!.text, "Progress report: Raw progress /tmp/Foo\n\nFinal text: Raw final 用户");
	assert.equal(reopened.mustTask(t.id).wait, stored);

	// Simulate a projection written before translation metadata existed.
	db.run("UPDATE task SET wait = ? WHERE id = ?", JSON.stringify({ kind: "no_report", text: waitOf(row)!.text }), t.id);
	const legacy = reopened.mustTask(t.id);
	assert.deepEqual(reopened.summary(legacy, null, "zh").wait, { kind: "no_report", text: "进展汇报：Raw progress /tmp/Foo\n\n最终回复：Raw final 用户" });
	assert.equal(reopened.mustTask(t.id).wait, legacy.wait);
});

test("legacy raw worker waits are not mistaken for generated fallback text", () => {
	const { ledger, create } = setup();
	for (const [key, event, kind, text] of [
		["raw-final", { kind: "run_ended", seq: 1, stop: "completed", text: "(no final text)", error: null }, "no_report", "(no final text)"],
		["raw-error", { kind: "run_ended", seq: 1, stop: "error", text: "", error: "The run failed." }, "error", "The run failed."],
		["raw-question", { kind: "reported", status: "question", summary: "env: Raw?", details: "The run failed." }, "question", "env: Raw?\n\nThe run failed."],
		["raw-blocked", { kind: "reported", status: "blocked", summary: "The run was aborted.", details: null }, "blocked", "The run was aborted."],
	] as const) {
		const t = create(key);
		ledger.apply(t.id, event, "worker");
		const row = ledger.mustTask(t.id);
		assert.deepEqual(ledger.summary(row, null).wait, { kind, text });
		assert.deepEqual(ledger.summary(row, null, "zh").wait, { kind, text });
	}
});

test("auto-escalation reasons localize from their original source, including legacy rows", () => {
	const { db, ledger, create } = setup();
	const t = create("localized-escalation");
	ledger.apply(t.id, { kind: "provisioned", session: "W-1", reusedSession: false }, "hub");
	const result = ledger.apply(t.id, { kind: "approval_requested", tool: "bash", summary: "dropdb Raw_DB" }, "worker");
	const escalation = result.opened[0]!;
	const event = ledger.events(t.id).at(-1)!;
	assert.equal(escalation.reason, "approval: bash: dropdb Raw_DB");
	assert.equal(ledger.escalationDTO(escalation).reason, "approval: bash: dropdb Raw_DB");
	assert.equal(ledger.escalationDTO(escalation, "zh").reason, "等待审批：bash：dropdb Raw_DB");
	assert.equal(ledger.lastEventSummary(t.id, "zh"), `中枢发起了请示 ${escalation.id}：等待审批：bash：dropdb Raw_DB`);
	assert.deepEqual(ledger.summary(ledger.mustTask(t.id), null, "zh").wait, { kind: "approval", text: "bash：dropdb Raw_DB" });

	const legacy = JSON.parse(event.data) as Extract<TaskEvent, { kind: "escalated" }>;
	delete legacy.reasonMessage;
	db.run("UPDATE task_event SET data = ? WHERE id = ?", JSON.stringify(legacy), event.id);
	assert.equal(ledger.lastEventSummary(t.id, "zh"), `中枢发起了请示 ${escalation.id}：等待审批：bash：dropdb Raw_DB`);
	assert.deepEqual(ledger.eventDTO(ledger.events(t.id).at(-1)!, "zh").data, legacy);
	ledger.apply(t.id, { kind: "approval_resolved", approved: true }, "human");
	ledger.apply(t.id, { kind: "approval_requested", tool: "bash", summary: "Other command" }, "worker");
	assert.equal(new Ledger(db).escalationDTO(ledger.escalation(escalation.id)!, "zh").reason, "等待审批：bash：dropdb Raw_DB");
	assert.equal(ledger.escalation(escalation.id)!.reason, "approval: bash: dropdb Raw_DB");
});

test("model escalation reasons and decision content remain raw, including hub-like wording", () => {
	const { ledger, create } = setup();
	const t = create("raw-decision");
	const escalation = ledger.escalate(t.id, "W-1", "approval: bash: raw reason", "main").escalation;
	assert.equal(ledger.escalationDTO(escalation, "zh").reason, "approval: bash: raw reason");
	const decision = ledger.logDecision({ taskId: t.id, summary: `Cancelled ${t.id}`, why: "Raw reason 用户", revert: "Raw revert /tmp/Keep", reverts: null, dedupeKey: null, actor: "main" });
	const dto = ledger.decisionDTO(decision, "zh");
	assert.equal(dto.summary, `Cancelled ${t.id}`);
	assert.equal(dto.why, "Raw reason 用户");
	assert.equal(dto.revert, "Raw revert /tmp/Keep");
});

test("hub-authored decision and cancellation metadata renders at read time", () => {
	const { db, ledger, create } = setup();
	const t = create("hub-decision");
	const decision = ledger.logDecision({
		taskId: t.id, summary: `Cancelled ${t.id}`, why: "Raw model reason", revert: "Dispatch a new task", reverts: null, dedupeKey: null, actor: "main",
		summaryMessage: { en: `Cancelled ${t.id}`, zh: `已取消 ${t.id}` }, revertMessage: { en: "Dispatch a new task", zh: "派发新任务" },
	});
	assert.equal(ledger.lastEventSummary(t.id), `${decision.id}: Cancelled ${t.id}`);
	assert.equal(ledger.lastEventSummary(t.id, "zh"), `${decision.id}：已取消 ${t.id}`);
	const reopened = new Ledger(db);
	assert.equal(reopened.decisionDTO(decision, "zh").summary, `已取消 ${t.id}`);
	assert.equal(reopened.decisionDTO(decision, "zh").revert, "派发新任务");
	assert.equal(reopened.decisionDTO(decision, "zh").why, "Raw model reason");
	assert.equal(reopened.decisionDTO(decision).summary, `Cancelled ${t.id}`);
	assert.equal(reopened.decision(decision.id)!.revert_plan, "Dispatch a new task");
	ledger.apply(t.id, { kind: "cancelled", by: "human", reason: "cancelled by the human", reasonMessage: { en: "cancelled by the human", zh: "你取消了任务" } }, "human");
	assert.equal(ledger.lastEventSummary(t.id), "cancelled by human: cancelled by the human");
	assert.equal(ledger.lastEventSummary(t.id, "zh"), "你已取消：你取消了任务");
});

test("ledger errors preserve English defaults and carry Chinese messages", () => {
	const { ledger } = setup();
	for (const [call, en, zh] of [
		[() => ledger.mustTask("T-404"), "no task T-404", "找不到任务 T-404"],
		[() => ledger.requestRevert("D-404"), "no decision D-404", "找不到决定 D-404"],
		[() => ledger.markSeen("E-404"), "no escalation E-404", "找不到请示 E-404"],
		[() => ledger.dismiss("E-404"), "no escalation E-404", "找不到请示 E-404"],
		[() => ledger.logDecision({ taskId: null, summary: "Raw", why: "Raw", revert: "Raw", reverts: "D-404", dedupeKey: null, actor: "main" }), "no decision D-404", "找不到决定 D-404"],
	] as const) {
		assert.throws(call, error => {
			assert.ok(error instanceof HubError);
			assert.equal(error.message, en);
			assert.equal(error.localized("en"), en);
			assert.equal(error.localized("zh"), zh);
			return true;
		});
	}
});

test("legacy generated waits recover translations from events rather than matching stored strings", () => {
	const { db, ledger, create } = setup();
	for (const [key, event, en, zh] of [
		["legacy-empty-final", { kind: "run_ended", seq: 1, stop: "completed", text: "", error: null }, "(no final text)", "（无最终回复）"],
		["legacy-empty-error", { kind: "run_ended", seq: 1, stop: "error", text: "", error: null }, "The run failed.", "运行失败。"],
		["legacy-empty-abort", { kind: "run_ended", seq: 1, stop: "aborted", text: "", error: null }, "The run was aborted.", "运行已中止。"],
		["legacy-provision", { kind: "provision_failed", step: "checkout", message: "Raw git stderr" }, "checkout: Raw git stderr", "检出代码：Raw git stderr"],
		["legacy-approval", { kind: "approval_requested", tool: "bash", summary: "Raw command" }, "bash: Raw command", "bash：Raw command"],
	] as const) {
		const t = create(key);
		ledger.apply(t.id, event, "worker");
		const { kind } = waitOf(ledger.mustTask(t.id))!;
		db.run("UPDATE task SET wait = ? WHERE id = ?", JSON.stringify({ kind, text: en }), t.id);
		const row = ledger.mustTask(t.id);
		assert.deepEqual(ledger.summary(row, null).wait, { kind, text: en });
		assert.deepEqual(ledger.summary(row, null, "zh").wait, { kind, text: zh });
		assert.equal(ledger.mustTask(t.id).wait, row.wait);
	}
});
