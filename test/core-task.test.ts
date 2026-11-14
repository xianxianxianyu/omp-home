import assert from "node:assert/strict";
import { test } from "node:test";
import { escalationResolution, foldTask, INITIAL, NOTICE_POLICY, noticeFor, progressPhase, renderEnvelope, type TaskEvent, type TaskState, waitText } from "../server/core/task.ts";

/** Replay events from a fresh task; returns the final state and the notice each event produced. */
function replay(events: TaskEvent[], from: TaskState = INITIAL): { state: TaskState; notices: (string | null)[] } {
	let state = from;
	const notices: (string | null)[] = [];
	for (const e of events) {
		const next = foldTask(state, e);
		notices.push(noticeFor(state, next, e));
		state = next;
	}
	return { state, notices };
}

const run = (seq: number): TaskEvent => ({ kind: "run_started", seq });
const end = (seq: number, stop: "completed" | "aborted" | "error" = "completed", text = "final words"): TaskEvent => ({ kind: "run_ended", seq, stop, text, error: stop === "error" ? "boom" : null });
const report = (status: "done" | "blocked" | "question" | "progress", summary = `${status} summary`): TaskEvent => ({ kind: "reported", status, summary, details: null });
const delivered: TaskEvent = { kind: "delivered", outbox: 1, what: "brief" };

test("a report filed during the run is applied when the run ends, with one notice", () => {
	const { state, notices } = replay([delivered, run(1), report("done"), end(1)]);
	assert.deepEqual(state, { status: { s: "done" }, runOpen: false, runReport: null, settled: false });
	assert.deepEqual(notices, [null, null, null, "done"]);
});

test("question and blocked reports wait with the worker's summary", () => {
	const q = replay([delivered, run(1), report("question", "A or B?"), end(1)]);
	assert.deepEqual(q.state.status, { s: "awaiting", wait: { kind: "question", text: "A or B?" } });
	assert.equal(q.notices.at(-1), "question");
	const b = replay([delivered, run(1), report("blocked", "no creds"), end(1)]);
	assert.deepEqual(b.state.status, { s: "awaiting", wait: { kind: "blocked", text: "no creds" } });
	assert.equal(NOTICE_POLICY.question.priority, "urgent");
});

test("a run without a report waits as no_report with the final text; aborts and errors are distinct", () => {
	assert.deepEqual(replay([delivered, run(1), end(1, "completed", "I stopped here")]).state.status, { s: "awaiting", wait: { kind: "no_report", text: "I stopped here" } });
	assert.deepEqual(replay([delivered, run(1), end(1, "aborted")]).state.status.s, "awaiting");
	assert.equal(replay([delivered, run(1), end(1, "aborted")]).notices.at(-1), "stopped");
	const err = replay([delivered, run(1), end(1, "error")]);
	assert.deepEqual(err.state.status, { s: "awaiting", wait: { kind: "error", text: "boom" } });
	assert.equal(err.notices.at(-1), "error");
});

test("progress mid-run is an info notice; the run end still needs an outcome", () => {
	const { state, notices } = replay([delivered, run(1), report("progress", "half way"), end(1, "completed", "pausing")]);
	assert.deepEqual(notices, [null, null, "progress", "stopped"]);
	assert.equal(state.status.s, "awaiting");
	assert.match(state.status.s === "awaiting" ? state.status.wait.text : "", /half way[\s\S]*pausing/);
	assert.equal(NOTICE_POLICY.progress.priority, "info");
});

test("a late report after the run ended applies immediately", () => {
	const waiting = replay([delivered, run(1), end(1)]).state;
	const { state, notices } = replay([report("done")], waiting);
	assert.equal(state.status.s, "done");
	assert.deepEqual(notices, ["done"]);
});

test("human input and a new run reopen a done task; cancelled stays cancelled through a run end", () => {
	const done = replay([delivered, run(1), report("done"), end(1)]).state;
	assert.equal(foldTask(done, { kind: "human_input", text: "one more thing" }).status.s, "working");
	assert.equal(foldTask(done, run(2)).status.s, "working");
	assert.equal(foldTask(done, { kind: "message_sent", by: "main", text: "fix x", mode: "next", decision: null }).status.s, "working");
	const cancelled = replay([delivered, run(1), { kind: "cancelled", by: "main", reason: "obsolete" }, end(1, "aborted")]);
	assert.equal(cancelled.state.status.s, "cancelled");
	assert.deepEqual(cancelled.notices, [null, null, null, null]);
});

test("accepting a task mid-run is not undone by the run ending", () => {
	const { state } = replay([delivered, run(1), { kind: "accepted", reason: "good enough", decision: "D-1" }, end(1)]);
	assert.equal(state.status.s, "done");
});

test("settled is event-ordered: closing settles, any later run, message or human input unsettles", () => {
	const accepted: TaskEvent = { kind: "accepted", reason: "good", decision: "D-1" };
	const reported = replay([delivered, run(1), report("done"), end(1)]);
	assert.equal(reported.state.settled, false, "a worker's done report is not acceptance");
	const closed = replay([accepted], reported.state).state;
	assert.equal(closed.settled, true);
	assert.equal(replay([{ kind: "decided", decision: "D-2", summary: "x" }, { kind: "escalation_closed", escalation: "E-1", resolution: "task_moved" }], closed).state.settled, true, "events that do not reopen keep it settled");
	assert.equal(foldTask(closed, report("done")).settled, true, "a late done report on a closed task keeps it settled");
	for (const reopen of [run(2), { kind: "human_input", text: "more" }, { kind: "message_sent", by: "main", text: "fix", mode: "next", decision: null }] as TaskEvent[]) {
		assert.equal(foldTask(closed, reopen).settled, false, reopen.kind);
	}
	assert.equal(replay([accepted, run(2), report("done"), end(2)], reported.state).state.settled, false, "reported done again after a reopen waits for acceptance again");
	assert.equal(replay([{ kind: "cancelled", by: "main", reason: "no" }]).state.settled, true);
	assert.equal(replay([{ kind: "provision_failed", step: "checkout", message: "x" }]).state.settled, false);
});

test("a merge by the human closes the task as done and settled with an info notice; a cancelled task stays cancelled", () => {
	const merged: TaskEvent = { kind: "merged", branch: "feat/x", into: "origin/main", sha: "abc" };
	const done = replay([delivered, run(1), report("done"), end(1), merged]);
	assert.deepEqual([done.state.status.s, done.state.settled, done.notices.at(-1)], ["done", true, "merged"]);
	assert.deepEqual(NOTICE_POLICY.merged, { priority: "info", autoEscalate: false });
	const waiting = replay([delivered, run(1), report("question"), end(1), merged]);
	assert.deepEqual([waiting.state.status.s, waiting.state.settled, waiting.notices.at(-1)], ["done", true, "merged"]);
	const cancelled = replay([{ kind: "cancelled", by: "main", reason: "no" }, merged]);
	assert.deepEqual([cancelled.state.status.s, cancelled.state.settled], ["cancelled", true]);
	assert.equal(escalationResolution(merged), "task_moved");
	assert.equal(escalationResolution({ kind: "worktree_retired", reason: "merged", branch: "feat/x", sha: "abc", branchDeleted: true }), "task_moved");
});

test("process loss interrupts working and approval states only", () => {
	const lost: TaskEvent = { kind: "process_lost", reason: "hub restarted" };
	const working = replay([delivered, run(1), lost]);
	assert.deepEqual(working.state.status, { s: "awaiting", wait: { kind: "interrupted", text: "hub restarted" } });
	assert.equal(working.notices.at(-1), "interrupted");
	const question = replay([delivered, run(1), report("question"), end(1), lost]);
	assert.equal(question.state.status.s === "awaiting" && question.state.status.wait.kind, "question");
	assert.equal(question.notices.at(-1), null);
	const approval = replay([delivered, run(1), { kind: "approval_requested", tool: "bash", summary: "rm -rf build" }, lost]);
	assert.equal(approval.state.status.s === "awaiting" && approval.state.status.wait.kind, "interrupted");
});

test("approval waits are auto-escalated info notices and resolve back to working", () => {
	const { state, notices } = replay([delivered, run(1), { kind: "approval_requested", tool: "bash", summary: "git reset --hard" }]);
	assert.equal(state.status.s, "awaiting");
	if (state.status.s === "awaiting") {
		assert.equal(state.status.wait.kind, "approval");
		assert.equal(waitText(state.status.wait), "bash: git reset --hard");
		assert.equal(waitText(state.status.wait, "zh"), "bash：git reset --hard");
	}
	assert.equal(notices.at(-1), "approval");
	assert.deepEqual(NOTICE_POLICY.approval, { priority: "info", autoEscalate: true });
	assert.equal(foldTask(state, { kind: "approval_resolved", approved: true }).status.s, "working");
});

test("provisioning failures wait and a retry returns the task to pending", () => {
	const failed = replay([{ kind: "provision_failed", step: "env", message: "setup exited 1" }]);
	assert.equal(failed.state.status.s, "awaiting");
	if (failed.state.status.s === "awaiting") {
		assert.equal(failed.state.status.wait.kind, "provision_failed");
		assert.equal(waitText(failed.state.status.wait), "env: setup exited 1");
		assert.equal(waitText(failed.state.status.wait, "zh"), "准备环境：setup exited 1");
	}
	assert.equal(failed.notices[0], "provision_failed");
	assert.equal(foldTask(failed.state, { kind: "provision_retry", text: "fixed the recipe" }).status.s, "pending");
});

test("escalations resolve as human_replied on human action and task_moved otherwise", () => {
	assert.equal(escalationResolution({ kind: "human_input", text: "yes" }), "human_replied");
	assert.equal(escalationResolution({ kind: "approval_resolved", approved: false }), "human_replied");
	assert.equal(escalationResolution({ kind: "message_sent", by: "main", text: "x", mode: "next", decision: null }), "task_moved");
	assert.equal(escalationResolution({ kind: "message_sent", by: "human", text: "x", mode: "next", decision: null }), "human_replied");
	assert.equal(escalationResolution({ kind: "cancelled", by: "human", reason: "x" }), "task_moved");
	assert.equal(escalationResolution(run(1)), null);
});

test("the envelope names the lane, env, playbook skills and the rules", () => {
	const text = renderEnvelope({
		task: { id: "T-45", title: "Fix login timeout", playbook: "bug-fix", earlier: ["T-31", "T-40"] },
		where: { workspace: "deckhand", path: "/r/deckhand.worktrees/fix-login", branch: "fix/login", base: "main", lane: "branch", protectedBranches: ["main"] },
		env: { vars: { PORT: "41023" }, services: ["postgres"], pools: ["staging-users"], test: { e2e: "pnpm test:e2e" } },
		pstack: true,
	});
	assert.match(text, /^\[omp-home task T-45 · Fix login timeout\]/);
	assert.match(text, /branch fix\/login \(base main\)/);
	assert.match(text, /Commit your work on this branch/);
	assert.match(text, /PORT=41023/);
	assert.match(text, /home_lease\(\{pool:"staging-users"\}\)/);
	assert.match(text, /skill:\/\/pstack-omp, then skill:\/\/poteto-mode and skill:\/\/poteto-mode\/playbooks\/bug-fix\.md/);
	assert.match(text, /no git push/);
	assert.match(text, /home_report\(\{status:"question"\}\)/);
	assert.match(text, /Earlier on this branch: T-31, T-40 \(their commits are here\)/);
	const main = (lane: "main" | "main_edit") =>
		renderEnvelope({
			task: { id: "T-1", title: "Look", playbook: null, earlier: [] },
			where: { workspace: "w", path: "/r/w", branch: null, base: null, lane, protectedBranches: ["main"] },
			env: { vars: {}, services: [], pools: [], test: {} },
			pstack: false,
		});
	assert.match(main("main"), /main checkout \/r\/w · read-only investigation/);
	assert.doesNotMatch(main("main"), /poteto-mode|Earlier on this branch|Commit your work/);
	assert.match(main("main_edit"), /you may edit files; leave them uncommitted for the human\. Git is read-only here/);
	assert.match(main("main_edit"), /Rules: git is read-only in the main checkout/);
});

test("in-flight phase: provisioning without a session, queued for a slot, else the worker's process state; none once closed", () => {
	assert.equal(progressPhase("pending", null), "provisioning");
	assert.equal(progressPhase("awaiting", null), "provisioning", "a failed setup is still in the provisioning pipeline");
	assert.equal(progressPhase("pending", { queued: true, state: "cold" }), "queued");
	assert.equal(progressPhase("working", { queued: true, state: "stopping" }), "queued");
	assert.equal(progressPhase("pending", { queued: false, state: "starting" }), "starting");
	assert.equal(progressPhase("working", { queued: false, state: "running" }), "running");
	assert.equal(progressPhase("awaiting", { queued: false, state: "approval" }), "approval");
	assert.equal(progressPhase("awaiting", { queued: false, state: "idle" }), "idle");
	assert.equal(progressPhase("working", { queued: false, state: "stopping" }), "cold");
	assert.equal(progressPhase("awaiting", { queued: false, state: "cold" }), "cold");
	assert.equal(progressPhase("done", { queued: false, state: "running" }), null);
	assert.equal(progressPhase("cancelled", null), null);
});

test("generated run waits render bilingually while the stored default stays English", () => {
	const cases: { events: TaskEvent[]; en: string; zh: string }[] = [
		{ events: [run(1), { kind: "run_ended", seq: 1, stop: "aborted", text: "", error: null }], en: "The run was aborted.", zh: "运行已中止。" },
		{ events: [run(1), { kind: "run_ended", seq: 1, stop: "error", text: "", error: null }], en: "The run failed.", zh: "运行失败。" },
		{ events: [run(1), end(1, "completed", "")], en: "(no final text)", zh: "（无最终回复）" },
		{ events: [run(1), report("progress", "Keep Raw /tmp/Foo"), end(1, "completed", "Need API_KEY")], en: "Progress report: Keep Raw /tmp/Foo\n\nFinal text: Need API_KEY", zh: "进展汇报：Keep Raw /tmp/Foo\n\n最终回复：Need API_KEY" },
		{ events: [run(1), report("progress", "half way"), end(1, "completed", "")], en: "Progress report: half way\n\nFinal text: (no final text)", zh: "进展汇报：half way\n\n最终回复：（无最终回复）" },
	];
	for (const { events, en, zh } of cases) {
		const { state } = replay(events);
		assert.equal(state.status.s, "awaiting");
		if (state.status.s !== "awaiting") continue;
		assert.equal(state.status.wait.text, en);
		assert.equal(waitText(state.status.wait), en);
		assert.equal(waitText(state.status.wait, "en"), en);
		assert.equal(waitText(state.status.wait, "zh"), zh);
	}
});

test("raw reports, model text and errors are not translated even when they resemble hub wording", () => {
	const cases: { events: TaskEvent[]; text: string }[] = [
		{ events: [{ kind: "reported", status: "question", summary: "The run failed.", details: "Progress report: raw user text" }], text: "The run failed.\n\nProgress report: raw user text" },
		{ events: [report("blocked", "env: missing API_KEY")], text: "env: missing API_KEY" },
		{ events: [run(1), end(1, "completed", "(no final text)")], text: "(no final text)" },
		{ events: [run(1), end(1, "aborted", "The run was aborted.")], text: "The run was aborted." },
		{ events: [run(1), { kind: "run_ended", seq: 1, stop: "error", text: "", error: "The run failed." }], text: "The run failed." },
		{ events: [run(1), { kind: "run_ended", seq: 1, stop: "error", text: "raw model error", error: null }], text: "raw model error" },
		{ events: [run(1), { kind: "run_ended", seq: 1, stop: "error", text: "ignored", error: "" }], text: "" },
		{ events: [run(1), { kind: "process_lost", reason: "hub restarted" }], text: "hub restarted" },
	];
	for (const { events, text } of cases) {
		const { state } = replay(events);
		assert.equal(state.status.s, "awaiting");
		if (state.status.s !== "awaiting") continue;
		assert.equal(waitText(state.status.wait), text);
		assert.equal(waitText(state.status.wait, "zh"), text);
	}
});

test("hub reason metadata translates without changing its English model-facing text", () => {
	const lost = replay([run(1), { kind: "process_lost", reason: "hub restarted", reasonMessage: { en: "hub restarted", zh: "中枢已重启" } }]);
	const failed = replay([{ kind: "provision_failed", step: "session", message: "could not start: raw stderr", messageText: { en: "could not start: raw stderr", zh: "无法启动：raw stderr" } }]);
	for (const [state, en, zh] of [
		[lost.state, "hub restarted", "中枢已重启"],
		[failed.state, "session: could not start: raw stderr", "启动会话：无法启动：raw stderr"],
	] as const) {
		assert.equal(state.status.s, "awaiting");
		if (state.status.s !== "awaiting") continue;
		assert.equal(waitText(state.status.wait), en);
		assert.equal(waitText(state.status.wait, "zh"), zh);
	}
});
