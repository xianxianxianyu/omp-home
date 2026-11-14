import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { admit, evictable, idleVictims, launchSpec, type PoolEntry } from "../server/core/pool.ts";
import { expand, parseRecipe } from "../server/core/recipe.ts";
import { planQuery } from "../server/core/search.ts";
import { HubError, localizeFieldErrors } from "../server/errors.ts";

const repo = path.resolve(import.meta.dirname, "..");

test("the shipped example recipe parses", () => {
	const r = parseRecipe(fs.readFileSync(path.join(repo, "templates/home/repos/_example.env.yaml"), "utf8"));
	assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
	assert.deepEqual(r.recipe.ports, ["web", "api"]);
	assert.equal(r.recipe.accounts["staging-users"]!.ttlMinutes, 30);
});

test("unknown variables, worktree variables in shared services and unknown keys are errors", () => {
	const unknownVar = parseRecipe('version: 1\nports: [web]\nenv: { URL: "http://127.0.0.1:{port.wbe}" }\n');
	assert.ok(!unknownVar.ok);
	assert.equal(unknownVar.errors[0]!.path, "env.URL");
	assert.match(unknownVar.errors[0]!.message, /\{port\.wbe\}/);

	const scoped = parseRecipe("version: 1\nports: [web]\nservices:\n  api: { kind: run, run: 'serve {worktree}', check: 'true' }\n");
	assert.ok(!scoped.ok);
	assert.equal(scoped.errors[0]!.path, "services.api.run");

	const typo = parseRecipe("version: 1\nsetpu: [x]\n");
	assert.ok(!typo.ok);

	const noDb = parseRecipe('version: 1\nenv: { DATABASE_URL: "{db.url}" }\n');
	assert.ok(!noDb.ok);

	const badYaml = parseRecipe("version: 1\nports: [web\n");
	assert.ok(!badYaml.ok);
	assert.match(badYaml.errors[0]!.message, /^line 3: /);

	// The editor prefill already has `version: 1`; pasting a recipe below it duplicates the key.
	const pastedBelowExample = parseRecipe("# example\nversion: 1\n# env:\nversion: 1\nports: [web]\n");
	assert.ok(!pastedBelowExample.ok);
	assert.deepEqual(pastedBelowExample.errors, [{ path: "version", message: 'line 4: duplicate key "version"; each key may appear only once (delete one of them)' }]);
});

test("recipe errors read English for models and render in Chinese for the UI", () => {
	const cases: [string, { path: string; en: string; zh: string }][] = [
		[
			'version: 1\nports: [web]\nenv: { URL: "http://127.0.0.1:{port.wbe}" }\n',
			{
				path: "env.URL",
				en: "unknown variable {port.wbe}; available here: {repo} {worktree} {branch} {slug} {port.web}",
				zh: "未知变量 {port.wbe}；此处可用：{repo} {worktree} {branch} {slug} {port.web}",
			},
		],
		["version: 1\nports: [-web]\n", { path: "ports.0", en: "use letters, digits, - and _", zh: "只能使用字母、数字、- 和 _" }],
		["version: 1\nports: [web, web]\n", { path: "ports", en: 'port name "web" is declared twice', zh: "端口名「web」声明了两次" }],
		[
			"version: 1\nversion: 1\n",
			{ path: "version", en: 'line 2: duplicate key "version"; each key may appear only once (delete one of them)', zh: "第 2 行：键「version」重复；每个键只能出现一次（删掉其中一个）" },
		],
	];
	for (const [text, { path: field, en, zh }] of cases) {
		const r = parseRecipe(text);
		assert.ok(!r.ok, text);
		assert.deepEqual(r.errors, [{ path: field, message: en }]);
		assert.deepEqual(localizeFieldErrors(r.errors, "en"), [{ path: field, message: en }]);
		assert.deepEqual(localizeFieldErrors(r.errors, "zh"), [{ path: field, message: zh }]);
	}
	const badYaml = parseRecipe("version: 1\nports: [web\n");
	assert.ok(!badYaml.ok);
	assert.match(localizeFieldErrors(badYaml.errors, "zh")[0]!.message, /^第 3 行：/);
});

test("shell variables pass through; expansion single-quotes values in shell mode", () => {
	const r = parseRecipe('version: 1\nports: [web]\nsetup: ["echo ${HOME} {branch} > out-{port.web}"]\n');
	assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
	const vars = { repo: "/r", worktree: "/w", branch: "it's/x", slug: "its_x", port: { web: 41001 } };
	assert.equal(expand(r.recipe.setup[0]!, vars, "shell"), "echo ${HOME} 'it'\\''s/x' > out-'41001'");
	assert.equal(expand("{branch}:{port.web}", vars, "plain"), "it's/x:41001");
	assert.throws(() => expand("{db.name}", vars, "plain"), err => err instanceof HubError && err.message === "{db.name} is not available in this context" && err.localized("zh") === "{db.name} 在此处不可用");
});

test("search planning sends 3+ character terms to FTS and shorter ones to LIKE", () => {
	assert.deepEqual(planQuery("登录超时 ui bug"), { match: '"登录超时" "bug"', likes: ["%ui%"] });
	assert.deepEqual(planQuery("登录"), { match: null, likes: ["%登录%"] });
	assert.deepEqual(planQuery('say "hi" 1%'), { match: '"say" """hi"""', likes: ["%1\\%%"] });
	assert.deepEqual(planQuery("   "), { match: null, likes: [] });
});

const live = (id: string, lastActivity: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
	id,
	kind: "worker",
	proc: { s: "live", pid: 1, since: 0, run: "idle", approval: false, asyncJobs: 0, lastActivity },
	viewers: 0,
	openEscalation: false,
	...extra,
});

test("admission: spawn under the cap, evict the least recently active idle worker, humans may exceed by one", () => {
	const now = 1_000_000;
	const min = 120_000;
	assert.deepEqual(admit({ human: false }, [live("W-1", 0)], 2, now, min), { kind: "spawn" });
	assert.deepEqual(admit({ human: false }, [live("W-1", now - 200_000), live("W-2", now - 500_000)], 2, now, min), { kind: "evict_then_spawn", victim: "W-2" });
	const busy = [live("W-1", now - 10), live("W-2", now - 10)];
	assert.deepEqual(admit({ human: false }, busy, 2, now, min), { kind: "queue" });
	assert.deepEqual(admit({ human: true }, busy, 2, now, min), { kind: "spawn" });
	assert.deepEqual(admit({ human: true }, [...busy, live("W-3", now - 10)], 2, now, min), { kind: "queue" });
	const main: PoolEntry = { ...live("M-1", 0), kind: "main" };
	assert.deepEqual(admit({ human: false }, [main, live("W-1", now)], 2, now, min), { kind: "spawn" });
});

test("workers with viewers, escalations, async jobs or open runs are never evicted", () => {
	const now = 10_000_000;
	const old = now - 3_600_000;
	assert.ok(evictable(live("W-1", old), now, 60_000));
	assert.ok(!evictable(live("W-1", old, { viewers: 1 }), now, 60_000));
	assert.ok(!evictable(live("W-1", old, { openEscalation: true }), now, 60_000));
	assert.ok(!evictable({ ...live("W-1", old), proc: { s: "live", pid: 1, since: 0, run: "idle", approval: false, asyncJobs: 2, lastActivity: old } }, now, 60_000));
	assert.ok(!evictable({ ...live("W-1", old), proc: { s: "live", pid: 1, since: 0, run: "running", approval: false, asyncJobs: 0, lastActivity: old } }, now, 60_000));
	assert.deepEqual(idleVictims([live("W-1", old), live("W-2", now - 1000)], now, 60_000), ["W-1"]);
});

test("launch spec: resume, optional model and pstack, worker git guard env", () => {
	const spec = launchSpec({
		bin: "omp",
		session: { id: "W-3", kind: "worker", cwd: "/wt", sessionDir: "/h/.omp-home/sessions/W-3", resumeFile: "/h/s.jsonl", model: null, thinking: "max" },
		paths: { plugin: "/app/omp-plugin/worker", overlay: "/h/.omp-home/run/worker.yml", pstackPackage: "/h/.omp-home/run/pstack", gitGuard: "/app/git-guard" },
		bridge: { url: "ws://127.0.0.1:4777/bridge", token: "tok" },
		baseEnv: { PATH: "/bin", OMP_HOME_ROLE: "spoofed" },
		worker: { env: { PORT: "41000", OMP_HOME_TOKEN: "spoofed" }, protectedBranches: ["main"], repoHooks: "/repo/.git/hooks", mainCheckout: false },
	});
	assert.deepEqual(spec.args, [
		"--mode", "rpc-ui", "--cwd", "/wt", "--session-dir", "/h/.omp-home/sessions/W-3", "--config", "/h/.omp-home/run/worker.yml",
		"-e", "/app/omp-plugin/worker", "-e", "/h/.omp-home/run/pstack",
		"--thinking", "max", "--approval-mode", "yolo", "--no-title", "--resume", "/h/s.jsonl",
	]);
	assert.equal(spec.env.OMP_HOME_ROLE, "worker");
	assert.equal(spec.env.OMP_HOME_TOKEN, "tok");
	assert.equal(spec.env.PORT, "41000");
	assert.equal(spec.env.OMP_HOME_PROTECTED, "main");
	assert.equal(spec.env.GIT_CONFIG_VALUE_0, "/app/git-guard");
	assert.equal(spec.env.OMP_HOME_REPO_HOOKS, "/repo/.git/hooks");
	assert.equal(spec.env.OMP_HOME_MAIN_CHECKOUT, undefined, "a branch worktree may commit");
	const inMain = launchSpec({
		bin: "omp",
		session: { id: "W-4", kind: "worker", cwd: "/repo", sessionDir: "/h/.omp-home/sessions/W-4", resumeFile: null, model: null, thinking: "max" },
		paths: { plugin: "/app/omp-plugin/worker", overlay: "/h/.omp-home/run/worker.yml", pstackPackage: null, gitGuard: "/app/git-guard" },
		bridge: { url: "ws://x/bridge", token: "t" },
		baseEnv: { OMP_HOME_MAIN_CHECKOUT: "0" },
		worker: { env: {}, protectedBranches: ["main"], repoHooks: "/repo/.git/hooks", mainCheckout: true },
	});
	assert.equal(inMain.env.OMP_HOME_MAIN_CHECKOUT, "1", "the main checkout's git is read-only for its worker");
	const main = launchSpec({
		bin: "omp",
		session: { id: "M-1", kind: "main", cwd: "/h", sessionDir: "/h/.omp-home/chat/M-1", resumeFile: null, model: "opus", thinking: "max" },
		paths: { plugin: "/app/omp-plugin/main", overlay: "/h/.omp-home/run/main.yml", pstackPackage: null, gitGuard: "/app/git-guard" },
		bridge: { url: "ws://x/bridge", token: "t" },
		baseEnv: {},
		worker: null,
	});
	assert.ok(main.args.includes("--model") && !main.args.includes("--resume"));
	assert.equal(main.args[main.args.indexOf("--thinking") + 1], "max");
	assert.equal(main.env.GIT_CONFIG_COUNT, undefined);
});
