import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import type { ResourcesDTO, SessionDTO, StateDTO, TaskDetail } from "../shared/api.ts";
import { killHubs, sandbox, startHub, Term, until } from "./hub-harness.ts";

/**
 * Hub flows beyond the happy path, with the fake omp: services, account leases and
 * home_env in a read-only checkout; queueing at the live cap; cancel (abort);
 * continue with session reuse; cleanup; provisioning failure and retry via home_send;
 * decision revert; main restart and new chat.
 */

after(killHubs);

const BRIEF = "Goal: exercise hub flows with the fake omp. Background: none. Constraints: none. Acceptance: the fake reports done. Report: what changed and how.";
const SERVICE_RUN = `node -e "require('http').createServer((q, s) => s.end('ok')).listen(+process.argv[1])" {port.svc}`;
const SERVICE_CHECK = `node -e "fetch('http://127.0.0.1:' + process.argv[1]).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" {port.svc}`;
const recipe = (setup: string) =>
	[
		"version: 1",
		"services:",
		`  echo-svc: { kind: run, run: ${JSON.stringify(SERVICE_RUN)}, check: ${JSON.stringify(SERVICE_CHECK)}, ports: [svc], timeoutSec: 15 }`,
		"ports: [web]",
		'env: { PORT: "{port.web}" }',
		`setup: [${JSON.stringify(setup)}]`,
		"accounts:",
		"  testers: { ttlMinutes: 5, items: [ { id: alice, fields: { user: alice@example.test, password: { env: OMP_E2E_PASSWORD } } } ] }",
		"",
	].join("\n");

test("hub flows: env, leases, queue, cancel, continue, cleanup, retry, revert, main lifecycle", { timeout: 180_000 }, async () => {
	const box = sandbox();
	const hub = await startHub(box.configDir, { OMP_E2E_PASSWORD: "s3cret" });
	const task = async (id: string) => (await hub.api<TaskDetail>("GET", `/api/tasks/${id}`)).body;
	const sessions = async () => (await hub.api<SessionDTO[]>("GET", "/api/sessions")).body;
	const resources = async () => (await hub.api<ResourcesDTO>("GET", "/api/resources")).body;
	const send = (title: string, checkout: unknown, marker = "") => `/dispatch ${JSON.stringify({ title, workspace: "deckhand", brief: `${BRIEF} ${marker}`, checkout })}`;

	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	await until("main idle", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	assert.equal((await hub.api("POST", "/api/workspaces", { repoPath: box.gitRepo })).status, 200);
	assert.equal((await hub.api("PUT", "/api/workspaces/deckhand/recipe", { text: recipe("echo ok") })).status, 200);
	const capped = await hub.api<{ maxLiveWorkers: number }>("PUT", "/api/settings", { maxLiveWorkers: 1 });
	assert.equal(capped.body.maxLiveWorkers, 1);
	assert.equal((await hub.api("PUT", "/api/settings", { maxLiveWorkers: 0 })).status, 422);
	const main = await new Term(hub, "M-1").open();

	// T-1: read-only checkout; shared service started; home_env and home_lease from the worker.
	main.type(send("Read only look", { kind: "readonly" }, "[fake:env]"));
	const t1 = await until("T-1 done", async () => {
		const t = await task("T-1");
		return t.status === "done" && t;
	});
	assert.equal(t1.worktreePath, null);
	const details = t1.reports[0]!.details!;
	assert.match(details, /ENV Read-only checkout: /);
	assert.match(details, /Services: echo-svc up/);
	assert.match(details, /LEASE Leased alice from testers .*\n {2}user: alice@example\.test\n {2}password: s3cret/);
	const res = await resources();
	assert.equal(res.services.find(s => s.id === "deckhand/echo-svc")?.state, "up");
	assert.ok(!res.leases.some(l => l.kind === "account"), "account lease released at run end");
	const servicePid = res.services[0]!.pid!;

	// T-2 needs a slot while W-1 is live at cap 1: queued until W-1 is evicted.
	main.type(send("Hang in worktree", { kind: "worktree", branch: "feat/hang" }, "[fake:hang]"));
	await until("T-2 queued", async () => (await task("T-2")).events.some(e => e.kind === "queued_for_capacity"));
	assert.equal((await task("T-2")).status, "pending");
	assert.equal((await hub.api("POST", "/api/sessions/W-1/evict")).status, 200);
	await until("T-2 running", async () => (await task("T-2")).events.some(e => e.kind === "run_started"));
	assert.equal((await sessions()).find(s => s.id === "W-1")!.state, "cold");

	// Human cancel aborts the run; the task stays cancelled after the aborted run ends.
	const cancelled = await hub.api<TaskDetail>("POST", "/api/tasks/T-2/cancel", { reason: "wrong approach" });
	assert.equal(cancelled.body.status, "cancelled");
	await until("aborted run end", async () => (await task("T-2")).events.some(e => e.kind === "run_ended" && e.summary.includes("aborted")));
	assert.equal((await task("T-2")).status, "cancelled");

	// T-3 continues T-2's worktree in the same session.
	main.type(send("Continue it", { kind: "continue", task: "T-2", session: "reuse" }));
	const t3 = await until("T-3 done", async () => {
		const t = await task("T-3");
		return t.status === "done" && t;
	});
	const t2 = await task("T-2");
	assert.equal(t3.sessionId, t2.sessionId);
	assert.equal(t3.worktreePath, t2.worktreePath);
	assert.equal(t3.branch, "feat/hang");
	assert.ok(t3.related.includes("T-2"));
	assert.match(t3.envelope!, /Continues: T-2/);

	// Cleanup: session retired, env torn down, worktree removed, branch kept.
	const cleaned = await hub.api<TaskDetail>("POST", "/api/tasks/T-2/cleanup");
	assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
	assert.ok(!fs.existsSync(t2.worktreePath!));
	assert.equal(box.git("branch", "--list", "feat/hang"), "feat/hang");
	assert.ok((await sessions()).find(s => s.id === t2.sessionId)!.retired);
	assert.ok(!(await resources()).leases.some(l => l.holderKind === "worktree"));
	assert.equal((await hub.api("POST", "/api/tasks/T-3/cleanup")).status, 200, "cleanup of an already removed worktree is a no-op");

	// T-4: setup fails → provision_failed; fix the recipe and retry through home_send.
	assert.equal((await hub.api("PUT", "/api/workspaces/deckhand/recipe", { text: recipe("echo broken >&2; exit 3") })).status, 200);
	main.type(send("Needs setup", { kind: "worktree" }));
	const failed = await until("T-4 provision_failed", async () => {
		const t = await task("T-4");
		return t.wait?.kind === "provision_failed" && t;
	});
	assert.match(failed.wait!.text, /env: setup command failed \(exit 3\)[\s\S]*broken/);
	assert.equal(failed.env?.state, "failed");
	assert.equal((await hub.api("PUT", "/api/workspaces/deckhand/recipe", { text: recipe("echo fixed > .setup-ok") })).status, 200);
	let mark = main.out.length;
	main.type(`/call home_send ${JSON.stringify({ task: "T-4", text: "Recipe fixed; go ahead." })}`);
	await main.expect(/RESULT ok T-4 had failed setup; retrying it now/, mark);
	const t4 = await until("T-4 done", async () => {
		const t = await task("T-4");
		return t.status === "done" && t;
	});
	assert.ok(fs.existsSync(`${t4.worktreePath}/.setup-ok`));
	assert.equal(t4.env?.state, "ready");

	// A decision revert reaches main as a prompt and resets the wake budget.
	mark = main.out.length;
	main.type(`/call home_decide ${JSON.stringify({ task: "T-4", decision: "Keep the old column", why: "reversible for now", revert: "drop it in a migration" })}`);
	await main.expect(/RESULT ok D-1 recorded for T-4/, mark);
	mark = main.out.length;
	const reverted = await hub.api<{ revertRequestedAt: number | null }>("POST", "/api/decisions/D-1/revert");
	assert.ok(reverted.body.revertRequestedAt);
	await main.expect(/PROMPT \[omp-home · the human asks to revert D-1\]/, mark);

	// The shared service keeps running across tasks; the human can stop it.
	const stopped = await hub.api<{ state: string }>("POST", `/api/services/${encodeURIComponent("deckhand/echo-svc")}/stop`);
	assert.equal(stopped.body.state, "down");
	await until("service process gone", async () => {
		try {
			process.kill(servicePid, 0);
			return false;
		} catch {
			return true;
		}
	});

	// Main restart resumes the same session; New chat retires it and starts M-2.
	const before = (await sessions()).find(s => s.id === "M-1")!.pid;
	mark = main.out.length;
	assert.equal((await hub.api("POST", "/api/main/restart")).status, 200);
	await main.expect(/FAKE main M-1 up resume=yes/, mark);
	assert.notEqual((await sessions()).find(s => s.id === "M-1")!.pid, before);
	const fresh = await hub.api<StateDTO>("POST", "/api/main/new");
	assert.equal(fresh.body.main.sessionId, "M-2");
	await until("M-2 idle", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	assert.ok((await sessions()).find(s => s.id === "M-1")!.retired);
	main.ws.close();

	hub.child.kill("SIGTERM");
	assert.equal(await hub.exited, 0);
});
