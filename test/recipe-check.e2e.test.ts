import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { RecipeCheckDTO, ResourcesDTO, ServiceDTO, StateDTO, WorkspaceDTO } from "../shared/api.ts";
import { killHubs, sandbox, startHub, Stream, until, type Hub, type Sandbox } from "./hub-harness.ts";

/**
 * Recipe trial runs through the HTTP API on a real hub: a throwaway worktree at the default base gets the ignored
 * files the recipe copies, runs setup and the selected tests with the worker's env, and is always torn down with the
 * recipe it started with — after success, failure, a mid-run recipe edit, cancel mid-setup and a hub crash (reconciled
 * at startup). Workspace services outlive the trial. Results reach main via home_status.
 */

after(killHubs);

const CHECK = "/api/workspaces/deckhand/recipe/check";

/** A tiny shell recipe; `services` is a YAML flow mapping. */
function recipe(o: { services?: string; setup?: string[]; teardown?: string[]; test: Record<string, string> }): string {
	return [
		"version: 1",
		...(o.services ? [`services: ${o.services}`] : []),
		"ports: [web]",
		'env: { PORT: "{port.web}" }',
		"copy: [local.env]",
		`setup: [${(o.setup ?? []).map(c => JSON.stringify(c)).join(", ")}]`,
		`teardown: [${(o.teardown ?? []).map(c => JSON.stringify(c)).join(", ")}]`,
		`test: { ${Object.entries(o.test).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`,
		"",
	].join("\n");
}

/** Sandbox repo with a committed .gitignore and an ignored local.env only the main checkout has; hub set up with workspace deckhand. */
async function prepare(): Promise<{ box: Sandbox; worktreeRoot: string; hub: Hub }> {
	const box = sandbox();
	fs.writeFileSync(path.join(box.gitRepo, ".gitignore"), "local.env\n");
	box.git("add", ".gitignore");
	box.git("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "ignore local.env");
	fs.writeFileSync(path.join(box.gitRepo, "local.env"), "TOKEN=from-main-checkout\n");
	const worktreeRoot = path.join(box.tmp, "worktrees");
	fs.mkdirSync(worktreeRoot);
	const hub = await startHub(box.configDir);
	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	await until("main idle", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	assert.equal((await hub.api("PUT", "/api/settings", { worktreeRoot })).status, 200);
	assert.equal((await hub.api("POST", "/api/workspaces", { repoPath: box.gitRepo })).status, 200);
	return { box, worktreeRoot, hub };
}

const check = async (hub: Hub) => (await hub.api<RecipeCheckDTO | null>("GET", CHECK)).body;
const workspace = async (hub: Hub) => (await hub.api<WorkspaceDTO[]>("GET", "/api/workspaces")).body.find(w => w.id === "deckhand")!;
const putRecipe = async (hub: Hub, text: string) => assert.equal((await hub.api("PUT", "/api/workspaces/deckhand/recipe", { text })).status, 200);
const trialLeases = async (hub: Hub) => (await hub.api<ResourcesDTO>("GET", "/api/resources")).body.leases.filter(l => l.holderId.startsWith("CHECK-deckhand-"));
const testSteps = (c: RecipeCheckDTO) => c.steps.filter(s => s.kind === "test").map(s => s.name).sort();

/** Worktrees git knows besides the main checkout. */
function trialWorktrees(box: Sandbox): string[] {
	return box
		.git("worktree", "list", "--porcelain")
		.split("\n")
		.flatMap(line => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : []))
		.filter(p => p !== box.gitRepo);
}

function assertTrialDir(worktreeRoot: string, dir: string): void {
	assert.ok(dir.startsWith(`${worktreeRoot}${path.sep}`) && path.basename(dir).startsWith(".recipe-check-"), dir);
}

/** Start a check and wait for it to finish. */
async function run(hub: Hub, body: unknown = {}): Promise<{ started: RecipeCheckDTO; done: RecipeCheckDTO }> {
	const res = await hub.api<RecipeCheckDTO>("POST", CHECK, body);
	assert.equal(res.status, 200, JSON.stringify(res.body));
	const started = res.body;
	assert.equal(started.state, "running");
	const done = await until("recipe check finished", async () => {
		const c = await check(hub);
		return c !== null && c.startedAt === started.startedAt && c.state !== "running" && c;
	});
	return { started, done };
}

test("recipe check: trial run, failing test tail, outdated after edit, test selection, home_status, mid-run edit", { timeout: 120_000 }, async t => {
	const { box, worktreeRoot, hub } = await prepare();
	let servicePid: number | null = null;
	t.after(async () => {
		if (servicePid !== null) {
			try {
				process.kill(-servicePid, "SIGKILL");
			} catch {
				// already stopped
			}
		}
		hub.child.kill("SIGTERM");
		await hub.exited;
		fs.rmSync(box.tmp, { recursive: true, force: true });
	});

	// Never run; without a recipe there is nothing to try.
	assert.deepEqual(await hub.api("GET", CHECK), { status: 200, body: null });
	assert.equal((await workspace(hub)).recipeCheck, null);
	assert.equal((await hub.api("POST", CHECK, {})).status, 422);

	// Copy, setup and test pass in a throwaway worktree that is gone afterwards.
	const trialPathFile = path.join(box.tmp, "trial-path");
	await putRecipe(
		hub,
		recipe({
			setup: [`pwd > ${trialPathFile}`, "echo built > .setup-marker"],
			test: { unit: 'grep -q TOKEN=from-main-checkout local.env && grep -q built .setup-marker && test -n "$PORT" && echo unit-ok' },
		}),
	);
	const { started, done: passed } = await run(hub);
	assert.deepEqual([started.workspace, started.base, started.current, started.endedAt], ["deckhand", "main", true, null]);
	assert.equal(passed.state, "passed", JSON.stringify(passed.steps));
	assert.equal(passed.sha, box.git("rev-parse", "main"));
	assert.ok(passed.endedAt !== null && passed.endedAt >= passed.startedAt);
	assert.deepEqual(
		passed.steps.filter(s => ["checkout", "copy", "setup", "test"].includes(s.kind)).map(s => (s.kind === "checkout" ? [s.kind, s.state] : [s.kind, s.name, s.state])),
		[["checkout", "passed"], ["copy", "local.env", "passed"], ["setup", "1", "passed"], ["setup", "2", "passed"], ["test", "unit", "passed"]],
	);
	assert.ok(passed.steps.every(s => s.state === "passed" || s.state === "skipped"), JSON.stringify(passed.steps));
	const unit = passed.steps.find(s => s.kind === "test")!;
	assert.equal(unit.exitCode, 0);
	assert.match(unit.outputTail, /unit-ok/);
	const trialPath = fs.readFileSync(trialPathFile, "utf8").trim();
	assertTrialDir(worktreeRoot, trialPath);
	assert.equal(fs.existsSync(trialPath), false);
	assert.deepEqual(trialWorktrees(box), []);
	assert.deepEqual(await trialLeases(hub), []);
	assert.equal(fs.existsSync(path.join(box.gitRepo, ".setup-marker")), false, "setup ran in the trial, not the main checkout");
	assert.deepEqual(await check(hub), passed);
	assert.deepEqual((await workspace(hub)).recipeCheck, { state: "passed", current: true, endedAt: passed.endedAt });

	// Editing the recipe makes the last run outdated.
	await putRecipe(hub, recipe({ test: { unit: 'echo "expected 2, got 3" >&2; exit 3' } }));
	assert.equal((await check(hub))?.current, false);
	assert.deepEqual((await workspace(hub)).recipeCheck, { state: "passed", current: false, endedAt: passed.endedAt });

	// A failing test: exit code and output tail recorded, trial still torn down.
	const { done: failed } = await run(hub);
	assert.deepEqual([failed.state, failed.current], ["failed", true]);
	const broken = failed.steps.find(s => s.kind === "test" && s.name === "unit")!;
	assert.deepEqual([broken.state, broken.exitCode], ["failed", 3]);
	assert.match(broken.outputTail, /expected 2, got 3/);
	assert.deepEqual(trialWorktrees(box), []);
	assert.deepEqual(await trialLeases(hub), []);
	assert.deepEqual((await workspace(hub)).recipeCheck, { state: "failed", current: true, endedAt: failed.endedAt });

	// Main sees the baseline failure on the workspace's home_status line.
	const main = await new Stream(hub, "M-1", box.home).open();
	main.agent("/call home_status {}");
	const status = await until("home_status result", async () => Object.values(main.view.tools).find(tool => tool.name === "home_status" && tool.status === "done"));
	main.close();
	const line = status.output.split("\n").find(l => l.startsWith("- deckhand: "));
	assert.ok(line, status.output);
	assert.match(line, / · recipe ok · .*failed/);
	assert.ok(line.includes("unit") && line.includes("expected 2, got 3"), line);

	// Test selection: every entry without `full` (all run even after the first fails), only `full` when present, or the one named.
	await putRecipe(hub, recipe({ test: { lint: "echo lint-broke; exit 4", unit: "echo unit-ran" } }));
	const every = (await run(hub)).done;
	assert.equal(every.state, "failed");
	assert.deepEqual(every.steps.filter(s => s.kind === "test").map(s => [s.name, s.state, s.exitCode]), [["lint", "failed", 4], ["unit", "passed", 0]]);
	assert.match(every.steps.find(s => s.kind === "test" && s.name === "unit")!.outputTail, /unit-ran/);
	const named = (await run(hub, { test: "unit" })).done;
	assert.deepEqual([named.state, testSteps(named)], ["passed", ["unit"]]);
	assert.match(named.steps.find(s => s.kind === "test")!.outputTail, /unit-ran/);
	await putRecipe(hub, recipe({ test: { full: "echo full-ran", unit: "echo unit-ran" } }));
	const full = (await run(hub)).done;
	assert.deepEqual([full.state, testSteps(full)], ["passed", ["full"]]);
	for (const body of [{ test: "nope" }, { test: "" }, { test: 1 }, { test: "unit", extra: true }]) {
		assert.equal((await hub.api("POST", CHECK, body)).status, 422, JSON.stringify(body));
	}
	assert.deepEqual(await check(hub), full);

	// Editing the recipe mid-run: the run finishes with the recipe it started with, teardown included; the workspace's shared service stays up.
	const gate = path.join(box.tmp, "gate");
	const upFile = path.join(box.tmp, "keeper.up");
	const teardownLog = path.join(box.tmp, "teardown.log");
	const keeper = `{ keeper: { kind: run, run: ${JSON.stringify(`touch ${upFile}; exec sleep 300`)}, check: ${JSON.stringify(`test -f ${upFile}`)}, ports: [svc] } }`;
	await putRecipe(hub, recipe({ services: keeper, setup: [`while [ ! -f ${gate} ]; do sleep 0.1; done`], teardown: [`echo snapshot >> ${teardownLog}`], test: { unit: "echo started-recipe" } }));
	assert.equal((await hub.api("POST", CHECK, {})).status, 200);
	await until("setup waiting on the gate", async () => (await check(hub))?.steps.find(s => s.kind === "setup")?.state === "running");
	assert.deepEqual((await hub.api<ResourcesDTO>("GET", "/api/resources")).body.environments, [], "a trial is not a worktree environment");
	await putRecipe(hub, recipe({ services: keeper, teardown: [`echo edited >> ${teardownLog}`], test: { other: "echo edited-recipe" } }));
	fs.writeFileSync(gate, "");
	const snapshot = await until("gated check finished", async () => {
		const c = await check(hub);
		return c?.state !== "running" && c;
	});
	assert.deepEqual([snapshot.state, snapshot.current, testSteps(snapshot)], ["passed", false, ["unit"]]);
	assert.match(snapshot.steps.find(s => s.kind === "test")!.outputTail, /started-recipe/);
	assert.equal(fs.readFileSync(teardownLog, "utf8"), "snapshot\n");
	assert.equal(snapshot.steps.find(s => s.kind === "services" && s.name === "keeper")?.state, "passed");
	const resources = (await hub.api<ResourcesDTO>("GET", "/api/resources")).body;
	const service = resources.services.find(s => s.id === "deckhand/keeper");
	assert.ok(service?.state === "up" && service.pid !== null, JSON.stringify(resources.services));
	servicePid = service.pid;
	process.kill(servicePid, 0);
	assert.deepEqual(resources.leases.filter(l => l.holderKind === "service").map(l => [l.holderId, l.label]), [["deckhand", "svc"]]);
	assert.deepEqual(resources.leases.filter(l => l.holderId.startsWith("CHECK-")), []);
	assert.deepEqual(trialWorktrees(box), []);
	assert.equal((await hub.api<ServiceDTO>("POST", `/api/services/${encodeURIComponent("deckhand/keeper")}/stop`)).body.state, "down");
});

test("recipe check: one run at a time, cancel mid-setup and crash leftovers are cleaned up", { timeout: 120_000 }, async t => {
	const prepared = await prepare();
	const { box, worktreeRoot } = prepared;
	let hub = prepared.hub;
	const orphans: number[] = [];
	t.after(async () => {
		for (const pid of orphans) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		hub.child.kill("SIGTERM");
		await hub.exited;
		fs.rmSync(box.tmp, { recursive: true, force: true });
	});
	const pidFile = path.join(box.tmp, "setup.pid");
	const setupPid = async () => Number(await until("setup running", async () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim()));
	await putRecipe(hub, recipe({ setup: [`echo $$ > ${pidFile}; exec sleep 60`], test: { unit: "true" } }));

	// A second start while one runs is refused.
	assert.equal((await hub.api("POST", CHECK, {})).status, 200);
	const second = await hub.api<{ code: string }>("POST", CHECK, {});
	assert.deepEqual([second.status, second.body.code], [409, "conflict"]);

	// Mid-setup: the trial worktree exists with the copied file and holds its port lease.
	const pid = await setupPid();
	const running = (await check(hub))!;
	assert.equal(running.state, "running");
	assert.equal(running.steps.find(s => s.kind === "setup")?.state, "running");
	assert.deepEqual((await workspace(hub)).recipeCheck, { state: "running", current: true, endedAt: null });
	const [trial, ...extra] = trialWorktrees(box);
	assert.deepEqual(extra, []);
	assert.ok(trial);
	assertTrialDir(worktreeRoot, trial);
	assert.ok(fs.existsSync(path.join(trial, "local.env")), "copy ran before setup");
	assert.deepEqual((await trialLeases(hub)).map(l => [l.kind, l.label, l.holderKind]), [["port", "web", "worktree"]]);

	// Cancel returns once the setup process is gone and the trial is torn down.
	const cancelled = await hub.api<RecipeCheckDTO>("POST", `${CHECK}/cancel`);
	assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
	assert.equal(cancelled.body.state, "cancelled");
	assert.notEqual(cancelled.body.endedAt, null);
	assert.ok(cancelled.body.steps.every(s => s.state !== "running"), JSON.stringify(cancelled.body.steps));
	assert.notEqual(cancelled.body.steps.find(s => s.kind === "test")?.state, "passed");
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	assert.equal(fs.existsSync(trial), false);
	assert.deepEqual(trialWorktrees(box), []);
	assert.deepEqual(await trialLeases(hub), []);
	assert.deepEqual(await check(hub), cancelled.body);

	// Hub crash mid-setup: the restarted hub fails the run and removes the leftover worktree and leases before it is ready.
	fs.rmSync(pidFile);
	assert.equal((await hub.api("POST", CHECK, {})).status, 200);
	const orphan = await setupPid();
	orphans.push(orphan);
	const [leftover] = trialWorktrees(box);
	assert.ok(leftover);
	assert.equal((await trialLeases(hub)).length, 1);
	hub.child.kill("SIGKILL");
	await hub.exited;
	hub = await startHub(box.configDir);
	const reconciled = (await check(hub))!;
	assert.equal(reconciled.state, "failed");
	assert.notEqual(reconciled.endedAt, null);
	assert.ok(reconciled.steps.every(s => s.state !== "running"), JSON.stringify(reconciled.steps));
	await until("orphaned setup process stopped", async () => {
		try {
			process.kill(orphan, 0);
			return false;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ESRCH";
		}
	}, 5_000);
	assert.equal(fs.existsSync(leftover), false);
	assert.deepEqual(trialWorktrees(box), []);
	assert.deepEqual(await trialLeases(hub), []);
	assert.equal((await workspace(hub)).recipeCheck?.state, "failed");

	// Nothing stale blocks the next run.
	await putRecipe(hub, recipe({ test: { unit: "true" } }));
	assert.equal((await run(hub)).done.state, "passed");
});
