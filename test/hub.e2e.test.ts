import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import type { ChatRecordDTO, CommandDTO, InboxDTO, SessionDTO, StateDTO, TaskDetail, TaskSummary, UiEvent } from "../shared/api.ts";
import type { TranscriptEvent } from "../shared/transcript.ts";
import { killHubs, repoDir, runHub, sandbox, startHub, Stream, until } from "./hub-harness.ts";

/**
 * The hub as a real process with test/fake-omp.ts standing in for omp (RPC on stdio + bridge):
 * single instance lock, session stream (reset, deltas, dialogs, abort, subagents), dispatch →
 * worktree → env → worker session → brief → report → notice batches to main (wake, then
 * context once the budget is spent) → human message to a worker → restart reconciliation
 * and resumed transcripts.
 */

after(killHubs);

const BRIEF = "Goal: exercise the hub end to end with the fake omp. Background: none. Constraints: none. Acceptance: report done with PORT. Report: what changed.";
const dispatch = (title: string, marker = "") => `/dispatch ${JSON.stringify({ title, workspace: "deckhand", brief: `${BRIEF} ${marker}`, checkout: { kind: "worktree" } })}`;

test("hub end to end with a fake omp", { timeout: 180_000 }, async () => {
	const { tmp, configDir, home, gitRepo } = sandbox();
	let hub = await startHub(configDir);
	const state = async () => (await hub.api<StateDTO>("GET", "/api/state")).body;
	const task = async (id: string) => (await hub.api<TaskDetail>("GET", `/api/tasks/${id}`)).body;
	const notices = async () => (await hub.api<ChatRecordDTO[]>("GET", "/api/chat?limit=200")).body.filter(r => r.role === "notice");

	// Auth, first run, static UI and setup.
	assert.equal((await fetch(`http://127.0.0.1:${hub.port}/api/state`)).status, 401);
	const rebound = http.get({ host: "127.0.0.1", port: hub.port, path: "/api/state", headers: { host: "evil.example", authorization: `Bearer ${hub.token}` } });
	const [rebindRes] = (await once(rebound, "response")) as [http.IncomingMessage];
	rebindRes.resume();
	assert.equal(rebindRes.statusCode, 403);
	assert.equal((await fetch(`http://127.0.0.1:${hub.port}/tasks/T-1`)).headers.get("content-type")?.split(";")[0], fs.existsSync(path.join(repoDir, "web/dist/index.html")) ? "text/html" : "text/plain");
	assert.equal((await state()).setup.done, false);
	assert.deepEqual((await state()).omp, { version: "0.0.0-fake", path: path.join(repoDir, "test/fake-omp.ts"), managed: false, warning: null });

	// One hub per config dir: a second launch points at the running one.
	const second = await runHub(configDir);
	assert.equal(second.code, 75);
	assert.match(second.stdout, new RegExp(`^omp-home already running http://127\\.0\\.0\\.1:${hub.port}/\\?token=`, "m"));

	const preview = await hub.api<{ changes: { path: string }[] }>("GET", `/api/setup/preview?home=${encodeURIComponent(home)}`);
	assert.ok(preview.body.changes.some(c => c.path === ".gitignore"));
	const setup = await hub.api<StateDTO>("POST", "/api/setup", { homePath: home, pstackRoot: null, migrateHome: true });
	assert.equal(setup.status, 200, JSON.stringify(setup.body));
	assert.ok(fs.readFileSync(path.join(home, ".gitignore"), "utf8").includes(".omp-home/"));
	await until("main idle", async () => (await state()).main.state === "idle");

	const ws = await hub.api<{ id: string }>("POST", "/api/workspaces", { repoPath: gitRepo });
	assert.equal(ws.status, 200, JSON.stringify(ws.body));
	assert.equal(ws.body.id, "deckhand");
	const bad = await hub.api<{ errors: { path: string }[] }>("PUT", "/api/workspaces/deckhand/recipe", { text: "version: 1\nenv: { X: '{port.nope}' }\n" });
	assert.equal(bad.status, 422);
	assert.equal(bad.body.errors[0]!.path, "env.X");
	const recipe = 'version: 1\nports: [web]\nenv: { PORT: "{port.web}", TASK_BRANCH: "{branch}" }\nsetup: ["echo ready > .env-ready"]\ntest: { unit: "npm test -- --port {port.web}" }\n';
	assert.equal((await hub.api("PUT", "/api/workspaces/deckhand/recipe", { text: recipe })).status, 200);

	const events: UiEvent[] = [];
	const ui = new WebSocket(`ws://127.0.0.1:${hub.port}/api/events?token=${hub.token}`);
	ui.on("message", d => events.push(JSON.parse(String(d)) as UiEvent));
	const main = await new Stream(hub, "M-1", home).open();
	await main.expect(/FAKE main M-1 up resume=no/);
	assert.equal(main.events[0]?.t, "reset");

	// The stream: a prompt arrives as items, the reply streams as deltas first.
	let mark = main.out.length;
	await main.prompt("hello there");
	await main.expect(/hello there\necho: hello there/, mark);
	assert.ok(main.events.some(e => e.t === "delta" && e.text.length > 0));
	assert.equal(main.view.status.model, "fake-model");
	assert.equal(main.view.status.contextPercent, 1.5);
	await until("main settled", async () => main.view.status.phase === "idle" && main.view.status.settled);
	assert.deepEqual((await hub.api<CommandDTO[]>("GET", "/api/sessions/M-1/commands")).body, [{ name: "fake-help", description: "What the fake understands", source: "builtin" }]);
	const firstId = main.view.items[0]!.id;
	assert.deepEqual((await hub.api<TranscriptEvent>("GET", `/api/sessions/M-1/history?before=${firstId}`)).body, { t: "prepend", items: [], tools: {}, earlierCursor: null });
	assert.equal((await hub.api("GET", "/api/sessions/M-1/history?before=nope")).status, 404);
	assert.equal((await hub.api("POST", "/api/sessions/M-1/prompt", { text: "" })).status, 422);

	// A dialog becomes a request item; the answer must fit it and closes it once.
	mark = main.out.length;
	await main.prompt("[fake:ask] pick a color");
	const request = await until("open request", async () => main.view.items.find(i => i.kind === "request" && i.answer === null));
	assert.equal((await hub.api("POST", "/api/sessions/M-1/respond", { requestId: request.id, response: { value: "Green" } })).status, 400);
	assert.equal((await hub.api("POST", "/api/sessions/M-1/respond", { requestId: request.id, response: { value: "Blue" } })).status, 200);
	await main.expect(/answered Blue[\s\S]*PICKED Blue/, mark);
	assert.equal((await hub.api("POST", "/api/sessions/M-1/respond", { requestId: request.id, response: { value: "Red" } })).status, 409);

	// Abort ends a running turn.
	mark = main.out.length;
	await main.prompt("[fake:hang] wait for me");
	await until("main running", async () => main.view.status.phase === "running");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/abort")).status, 200);
	await main.expect(/aborted while hanging/, mark);
	await until("main idle again", async () => (await state()).main.state === "idle");

	// Subagents get their own transcripts; a running one takes steer and cancel.
	await main.prompt("[fake:subagent] ping main");
	const pinger = await until("Pinger completed", async () => main.view.subagents.Pinger?.status === "completed" && main.view.subagents.Pinger);
	assert.equal(pinger.parentToolCallId, "task-pinger");
	assert.deepEqual(
		pinger.transcript.items.map(i => i.kind),
		["user", "assistant", "assistant"],
	);
	assert.deepEqual(Object.values(pinger.transcript.tools).map(t => [t.name, t.status, t.output]), [["write", "done", "Delivered to Main."]]);
	await main.prompt("[fake:subagent-hang] sleep");
	await until("Sleeper running", async () => main.view.subagents.Sleeper?.status === "running");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/subagents/Sleeper/steer", { text: "wake up" })).status, 200);
	await until("steer reaches the subagent", async () => main.view.subagents.Sleeper?.transcript.items.some(i => i.kind === "user" && i.text === "wake up"));
	assert.equal((await hub.api("POST", "/api/sessions/M-1/subagents/Sleeper/cancel")).status, 200);
	await until("Sleeper aborted", async () => main.view.subagents.Sleeper?.status === "aborted");
	assert.equal((await hub.api("POST", "/api/sessions/M-1/subagents/Sleeper/cancel")).status, 409);
	await until("main idle after subagents", async () => (await state()).main.state === "idle");

	// Main itself may not dispatch.
	mark = main.out.length;
	main.agent(`/call home_dispatch ${JSON.stringify({ title: "nope", workspace: "deckhand", brief: BRIEF, checkout: { kind: "readonly" } })}`);
	await main.expect(/RESULT err forbidden home_dispatch is only callable by the dispatcher/, mark);

	// T-1: worktree, env, session, brief, report → done → wake 1.
	mark = main.out.length;
	main.agent(dispatch("First task"));
	await main.expect(/RESULT ok T-1 pending · deckhand · new worktree/, mark);
	const t1 = await until("T-1 done", async () => {
		const t = await task("T-1");
		return t.status === "done" && t;
	});
	assert.equal(t1.branch, "task/first-task-1");
	assert.equal(t1.worktreePath, path.join(tmp, "deckhand.worktrees", "task-first-task-1"));
	assert.ok(fs.existsSync(path.join(t1.worktreePath!, ".env-ready")), "recipe setup ran in the worktree");
	const port = Number(t1.env!.vars.PORT);
	assert.ok(port >= 41000 && port <= 41999);
	assert.match(t1.reports[0]!.details!, new RegExp(`PORT=${port} BRANCH=task/first-task-1 hooks=${repoDir}/git-guard`));
	assert.match(t1.envelope!, /^\[omp-home task T-1 · First task\]/);
	assert.match(t1.envelope!, /Tests: unit `npm test -- --port '\d+'`/);
	assert.deepEqual(
		t1.events.map(e => e.kind),
		["created", "checked_out", "provisioned", "delivered", "run_started", "reported", "run_ended"],
	);
	await until("wake 1", async () => (await state()).main.wakesUsed === 1);
	const first = await until("notice for T-1", async () => (await notices()).find(n => n.text.includes("T-1 First task")));
	assert.match(first.text, /<worker-report task="T-1">fake done/);
	assert.match(first.text, /Auto-wakes left: 2/);

	// T-2 asks a question → wake 2; answering without a decision is refused.
	main.agent(dispatch("Second task", "[fake:question]"));
	await until("T-2 question", async () => (await task("T-2")).wait?.kind === "question");
	await until("wake 2", async () => (await state()).main.wakesUsed === 2);
	mark = main.out.length;
	main.agent(`/call home_send ${JSON.stringify({ task: "T-2", text: "Use A." })}`);
	await main.expect(/RESULT err invalid T-2 is waiting on a worker question/, mark);
	mark = main.out.length;
	main.agent(`/call home_send ${JSON.stringify({ task: "T-2", text: "Use A.", decision: { why: "reversible choice", revert: "send B instead" } })}`);
	await main.expect(/RESULT ok Queued to W-2 .*decision D-1 logged/, mark);
	await until("T-2 done", async () => (await task("T-2")).status === "done");
	const decisions = (await hub.api<{ id: string; summary: string }[]>("GET", "/api/decisions?task=T-2")).body;
	assert.deepEqual(decisions.map(d => d.id), ["D-1"]);
	await until("wake 3", async () => (await state()).main.wakesUsed === 3);

	// T-3: the budget is spent, so its notice goes in as context and main shows paused.
	main.agent(dispatch("Third task"));
	await until("T-3 done", async () => (await task("T-3")).status === "done");
	const late = await until("context notice for T-3", async () => (await notices()).find(n => n.text.includes("T-3 Third task")), 25_000);
	assert.match(late.text, /did not start a turn/);
	await main.expect(/\[omp-home · 1 update[^\n]*\nT-3 Third task[\s\S]*did not start a turn/);
	const paused = await until("paused", async () => {
		const s = await state();
		return s.main.paused && s;
	});
	assert.equal(paused.main.wakesUsed, 3);
	await hub.api("POST", "/api/main/continue");
	const resumed = await state();
	assert.equal(resumed.main.paused, false);
	assert.equal(resumed.main.wakesUsed, 0);

	// Search reaches briefs and reports.
	const hits = (await hub.api<{ taskId: string | null }[]>("GET", "/api/search?q=exercise&scope=tasks")).body;
	assert.ok(hits.some(h => h.taskId === "T-3"));

	// T-4 hangs mid-run. The in-flight list shows it provisioning (setup takes a second), then running
	// with what the worker is doing; escalation focuses its session.
	assert.equal((await hub.api("PUT", "/api/workspaces/deckhand/recipe", { text: recipe.replace("setup: [", 'setup: ["sleep 1", ') })).status, 200);
	const inFlight = async () => (await hub.api<TaskSummary[]>("GET", "/api/tasks?status=open")).body.find(t => t.id === "T-4");
	main.agent(dispatch("Hanging task", "[fake:hang]"));
	const provisioning = await until("T-4 in flight", async () => (await inFlight())?.progress);
	assert.equal(provisioning.phase, "provisioning");
	assert.equal(provisioning.intent, null);
	const running = await until("T-4 running with an intent", async () => {
		const p = (await inFlight())?.progress;
		return p?.phase === "running" && p.intent === "Waiting for the human" && p;
	});
	assert.ok(running.since > provisioning.since);
	assert.ok(running.lastEvent);
	assert.equal((await inFlight())?.endedAt, null);
	await until("T-4 running", async () => (await task("T-4")).events.some(e => e.kind === "run_started"));
	mark = main.out.length;
	main.agent(`/call home_escalate ${JSON.stringify({ task: "T-4", reason: "needs the human to choose" })}`);
	await main.expect(/RESULT ok E-1 opened · W-4 shown to the human/, mark);
	await until("focus event", async () => events.find(e => e.t === "focus" && e.sessionId === "W-4"));
	assert.equal((await hub.api<{ escalations: unknown[] }>("GET", "/api/inbox")).body.escalations.length, 1);
	const w4 = (await hub.api<SessionDTO[]>("GET", "/api/sessions")).body.find(s => s.id === "W-4")!;
	assert.equal(w4.state, "running");

	// The human answers in the worker's session: that is human input, which closes the escalation.
	const worker = await new Stream(hub, "W-4", home).open();
	await worker.expect(/\[omp-home task T-4 · Hanging task\]/);
	const messaged = await hub.api<TaskDetail>("POST", "/api/tasks/T-4/message", { text: "Pick the first option." });
	assert.equal(messaged.status, 200, JSON.stringify(messaged.body));
	assert.ok(messaged.body.events.some(e => e.kind === "human_input"));
	assert.equal((await hub.api<InboxDTO>("GET", "/api/inbox")).body.escalations.length, 0);
	assert.equal(messaged.body.escalations[0]?.resolution, "human_replied");
	worker.close();
	ui.close();
	main.close();

	// Crash the hub; on restart the cut run is flagged interrupted and main resumes its session.
	hub.child.kill("SIGKILL");
	await hub.exited;
	hub = await startHub(configDir);
	assert.equal((await state()).setup.done, true);
	const t4 = await until("T-4 interrupted", async () => {
		const t = await task("T-4");
		return t.wait?.kind === "interrupted" && t;
	});
	assert.match(t4.wait!.text, /hub restarted/);
	assert.deepEqual([t4.progress?.phase, t4.progress?.intent], ["cold", null]);
	const sessions = (await hub.api<SessionDTO[]>("GET", "/api/sessions")).body;
	assert.deepEqual(
		sessions.filter(s => s.kind === "worker").map(s => [s.id, s.state, s.pid]),
		[
			["W-4", "cold", null],
			["W-3", "cold", null],
			["W-2", "cold", null],
			["W-1", "cold", null],
		],
	);
	await until("old worker gone", async () => {
		try {
			process.kill(w4.pid!, 0);
			return false;
		} catch {
			return true;
		}
	});
	const main2 = await new Stream(hub, "M-1", home).open();
	await main2.expect(/FAKE main M-1 up resume=yes/);
	await main2.expect(/echo: hello there/);
	await until("interrupted notice reaches main", async () => (await notices()).some(n => n.text.includes("T-4 Hanging task") && n.text.includes("interrupted")), 25_000);
	main2.close();

	// Streaming a cold worker starts it and shows its resumed transcript.
	const w1 = await new Stream(hub, "W-1", home).open();
	await w1.expect(/\[omp-home task T-1 · First task\][\s\S]*All done\./);
	await w1.expect(/FAKE worker W-1 up resume=yes/);
	assert.equal((await hub.api<SessionDTO[]>("GET", "/api/sessions")).body.find(s => s.id === "W-1")!.state, "idle");
	w1.close();

	// Closing a task ends its progress and moves it from the open to the closed list.
	const closed = await hub.api<TaskDetail>("POST", "/api/tasks/T-4/cancel", { reason: "testing is over" });
	assert.equal(closed.body.progress, null);
	assert.ok(closed.body.endedAt);
	assert.deepEqual((await hub.api<TaskSummary[]>("GET", "/api/tasks?status=open")).body, []);
	const finished = (await hub.api<TaskSummary[]>("GET", "/api/tasks?status=closed")).body;
	assert.deepEqual(finished.map(t => [t.id, t.progress]).sort(), [["T-1", null], ["T-2", null], ["T-3", null], ["T-4", null]]);
	assert.ok(finished.every(t => t.endedAt !== null && t.endedAt >= t.createdAt));
	assert.equal((await hub.api("GET", "/api/tasks?status=nope")).status, 400);

	// Graceful stop ends every omp process, promptly even while a UI is connected.
	const watcher = await new Stream(hub, "M-1", home).open();
	const events2 = new WebSocket(`ws://127.0.0.1:${hub.port}/api/events?token=${hub.token}`);
	await once(events2, "open");
	const stopAt = Date.now();
	hub.child.kill("SIGTERM");
	assert.equal(await hub.exited, 0);
	assert.ok(Date.now() - stopAt < 5000, `shutdown took ${Date.now() - stopAt} ms`);
	await until("stream closed", async () => watcher.closed);
});
