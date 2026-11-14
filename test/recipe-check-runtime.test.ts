import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { homePaths } from "../server/config.ts";
import { Db } from "../server/db.ts";
import { Env, runShell } from "../server/env.ts";
import { RecipeChecks } from "../server/recipe-check.ts";
import { SettingsStore } from "../server/settings.ts";
import { Workspaces } from "../server/workspaces.ts";
import { Worktrees } from "../server/worktrees.ts";
import { sandbox, until } from "./hub-harness.ts";

test("recipe trial uses real service, port, database and exported test environment paths without worker rows", { timeout: 20_000 }, async t => {
	const box = sandbox();
	const paths = homePaths(box.home);
	const db = new Db(":memory:");
	const settings = new SettingsStore(db, paths);
	const workspaces = new Workspaces(db, paths, () => null);
	const env = new Env(db, paths, settings, workspaces, new Worktrees(db), () => {});
	const checks = new RecipeChecks(db, paths, settings, workspaces, env, () => {});
	t.after(async () => { await checks.stop(); db.close(); fs.rmSync(box.tmp, { recursive: true, force: true }); });
	await workspaces.create({ id: "deckhand", repoPath: box.gitRepo, recipe: stringify({
		version: 1,
		services: { fixture: { kind: "external", check: "test -f {repo}/service-ready", start: "touch {repo}/service-ready" } },
		ports: ["http"],
		database: { template: "empty", name: "trial_db_{slug}", url: "local:{db.name}", exists: "test -f {repo}/{db.name}", clone: "touch {repo}/{db.name}", drop: "rm {repo}/{db.name}" },
		env: { TRIAL_URL: "{db.url}", TRIAL_PORT: "{port.http}" },
		setup: ["printf '%s' \"$TRIAL_URL\" > setup-url; test \"$TRIAL_PORT\" = {port.http}"],
		test: { unit: "test \"$(cat setup-url)\" = {db.url} && test -f {repo}/{db.name} && test -f {repo}/service-ready && printf 'real environment verified\\n'" },
		teardown: ["printf '%s' \"$TRIAL_URL\" > {repo}/teardown-url"],
	}) });
	checks.start("deckhand");
	const result = await until("real recipe completed", async () => { const value = checks.get("deckhand"); return value?.state !== "running" && value; });
	assert.equal(result.state, "passed", JSON.stringify(result.steps));
	assert.match(result.steps.find(step => step.kind === "test")!.outputTail, /real environment verified/);
	const database = fs.readFileSync(path.join(box.gitRepo, "teardown-url"), "utf8").replace(/^local:/, "");
	assert.match(database, /^trial_db_check_deckhand_/);
	assert.equal(fs.existsSync(path.join(box.gitRepo, database)), false);
	assert.equal(fs.existsSync(path.join(box.gitRepo, "service-ready")), true, "workspace services remain shared, like worker teardown");
	assert.deepEqual(env.resources().leases, []);
	assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM worktree")!.n, 0);
	assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM worktree_env")!.n, 0);
	const logs = fs.readdirSync(path.join(paths.run, "recipe-checks"));
	assert.equal(logs.length, 1);
	const log = fs.readFileSync(path.join(paths.run, "recipe-checks", logs[0]!), "utf8");
	assert.match(log, /real environment verified/);
	assert.deepEqual(result.steps.filter(step => step.name === "worktree").map(step => [step.kind, step.state]), [["checkout", "passed"], ["teardown", "passed"]]);
	assert.equal(box.git("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).length, 1, "the trial checkout is gone");
});

test("shell timeouts kill stubborn process groups and preserve a nonzero exit code", { timeout: 10_000 }, async t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	const result = await runShell("trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done", { cwd: box.gitRepo, env: { ...process.env }, log: path.join(box.tmp, "timeout.log"), timeoutMs: 100 });
	assert.equal(result.code, 124);
	assert.match(result.output, /ready/);
	assert.match(result.output, /timed out/);
	assert.match(result.outputText!.zh, /超时/);
});

test("shell cancellation terminates the running process rather than merely detaching the observer", { timeout: 10_000 }, async t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	const controller = new AbortController();
	const result = await runShell("printf '%s\\n' \"$$\"; sleep 60", { cwd: box.gitRepo, env: { ...process.env }, log: path.join(box.tmp, "cancel.log"), timeoutMs: 30_000, signal: controller.signal, onOutput: tail => { if (/^\d+/.test(typeof tail === "string" ? tail : tail.en)) controller.abort(); } });
	assert.equal(result.code, 130);
	assert.match(result.output, /cancelled/);
	const pid = Number(result.output.split("\n")[0]);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
