import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { RepoInspection, RepoSuggestion, WorkspaceDTO } from "../shared/api.ts";
import { parseRecipe } from "../server/core/recipe.ts";
import { detectCommands } from "../server/repo-discovery.ts";
import { sandbox, startHub } from "./hub-harness.ts";

function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: dir });
}

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [file, text] of Object.entries(files)) {
		const absolute = path.join(root, file);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, text);
	}
}

function session(store: string, directory: string, cwd: string, title: string, modified: number, count = 1): void {
	const dir = path.join(store, "sessions", directory);
	fs.mkdirSync(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		const file = path.join(dir, `${i}.jsonl`);
		fs.writeFileSync(file, `${JSON.stringify({ type: "title", title, updatedAt: new Date(modified).toISOString() })}\n${JSON.stringify({ type: "session", cwd, timestamp: new Date(modified).toISOString() })}\n${"x".repeat(16_000)}\n`);
		fs.utimesSync(file, (modified - i * 1000) / 1000, (modified - i * 1000) / 1000);
	}
}

test("repository API discovers sessions, inspects choices and creates a validated recipe", { timeout: 60_000 }, async t => {
	const box = sandbox();
	const store = path.join(box.tmp, "agent");
	const worktrees = path.join(box.tmp, "worktrees");
	const extra = path.join(worktrees, "deckhand", "side");
	const second = path.join(box.tmp, "other", "deckhand");
	const recent = path.join(box.tmp, "recent");
	initRepo(second);
	initRepo(recent);
	fs.mkdirSync(worktrees);
	box.git("checkout", "-qb", "feature");
	box.git("worktree", "add", "-qb", "side", extra, "main");
	fs.mkdirSync(path.join(box.gitRepo, "src"));
	fs.writeFileSync(path.join(box.gitRepo, "package.json"), JSON.stringify({ scripts: { test: "node --test", dev: "vite" } }));
	fs.writeFileSync(path.join(box.gitRepo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	const now = Date.UTC(2026, 10, 14, 12);
	session(store, "lossy-name-not-a-path", path.join(box.gitRepo, "src"), "Latest deckhand session", now, 250);
	session(store, "another-cwd-same-root", box.gitRepo, "Older session", now - 120_000, 2);
	session(store, "recent-project", recent, "Recent work", now - 60_000);
	session(store, "missing-project", path.join(box.tmp, "gone"), "Missing", now + 60_000);
	session(store, "hub-worktree", extra, "Hub worker", now + 120_000);
	session(store, "home", box.home, "Home", now);
	const hub = await startHub(box.configDir, { PI_CODING_AGENT_DIR: store });
	t.after(async () => {
		hub.child.kill("SIGTERM");
		await hub.exited;
		fs.rmSync(box.tmp, { recursive: true, force: true });
	});
	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	assert.equal((await hub.api("PUT", "/api/settings", { worktreeRoot: worktrees })).status, 200);
	fs.writeFileSync(path.join(box.home, "AGENTS.md"), [box.gitRepo, second, box.home, extra, path.join(box.tmp, "missing")].join("\n"));
	const inspected = await hub.api<RepoInspection>("GET", `/api/workspaces/inspect?path=${encodeURIComponent(path.join(box.gitRepo, "src"))}`);
	assert.equal(inspected.status, 200);
	const repo = inspected.body;
	assert.equal(repo.path, path.join(box.gitRepo, "src"));
	assert.equal(repo.root, box.gitRepo);
	assert.equal(repo.id, "deckhand");
	assert.equal(repo.currentBranch, "feature");
	assert.equal(repo.defaultBase, "main");
	assert.deepEqual(repo.branches.map(b => b.name).sort(), ["feature", "main", "side"]);
	assert.equal(repo.branches[0]?.name, "feature");
	assert.equal(repo.branches[0]?.current, true);
	assert.ok(repo.branches.every(b => !b.remote && typeof b.lastCommitAt === "number"));
	assert.deepEqual(repo.worktrees, [{ path: extra, branch: "side", head: box.git("rev-parse", "HEAD") }]);
	assert.equal(repo.remoteUrl, null);
	assert.equal(repo.dirty, true);
	assert.equal(repo.registeredAs, null);
	assert.equal(repo.hasRecipe, false);
	assert.deepEqual(repo.omp, { sessions: 252, lastUsedAt: now, lastTitle: "Latest deckhand session" });
	assert.deepEqual(repo.stack, ["pnpm", "node"]);
	assert.deepEqual(repo.commands, { install: "pnpm install --frozen-lockfile --prefer-offline", dev: "pnpm run dev" });
	assert.deepEqual(repo.tests, { unit: "pnpm run test", full: "pnpm run test" });
	assert.deepEqual(repo.copy, []);
	assert.ok(repo.recipeDraft);
	const recipe = parseRecipe(repo.recipeDraft);
	assert.ok(recipe.ok);
	assert.deepEqual(recipe.recipe.setup, ["pnpm install --frozen-lockfile --prefer-offline"]);
	assert.deepEqual(recipe.recipe.test, { unit: "pnpm run test", full: "pnpm run test" });
	assert.deepEqual(recipe.recipe.ports, ["web"]);
	assert.deepEqual(recipe.recipe.env, { PORT: "{port.web}" });

	const bad = await hub.api<{ errors: { path: string }[] }>("POST", "/api/workspaces", { repoPath: box.gitRepo, recipe: "version: 1\nenv: { PORT: '{port.missing}' }\n" });
	assert.equal(bad.status, 422);
	assert.ok(bad.body.errors.every(e => e.path === "recipe"));
	assert.deepEqual((await hub.api<WorkspaceDTO[]>("GET", "/api/workspaces")).body, []);
	assert.equal(fs.existsSync(path.join(box.home, "repos", "deckhand.env.yaml")), false);
	const created = await hub.api<WorkspaceDTO>("POST", "/api/workspaces", { repoPath: repo.root, defaultBase: repo.defaultBase, recipe: repo.recipeDraft });
	assert.equal(created.status, 200);
	assert.equal(created.body.recipeStatus, "ok");
	assert.equal(fs.readFileSync(created.body.recipePath, "utf8"), repo.recipeDraft);

	const suggestions = await hub.api<RepoSuggestion[]>("GET", "/api/workspaces/suggestions");
	assert.equal(suggestions.status, 200);
	assert.deepEqual(suggestions.body.map(s => s.path), [recent, second, box.gitRepo]);
	assert.deepEqual(suggestions.body[2], { path: box.gitRepo, name: "deckhand", source: "home", ompSessions: 252, lastUsedAt: now, lastTitle: "Latest deckhand session", registeredAs: "deckhand" });
	assert.equal(suggestions.body[0]?.source, "omp");
	assert.equal(suggestions.body[1]?.ompSessions, 0);
	fs.rmSync(path.join(store, "sessions"), { recursive: true });
	assert.deepEqual((await hub.api<RepoSuggestion[]>("GET", "/api/workspaces/suggestions")).body, suggestions.body);
	assert.equal((await hub.api("POST", "/api/workspaces/scan")).status, 404);
	assert.equal((await hub.api("GET", "/api/workspaces/inspect")).status, 422);

	const again = (await hub.api<RepoInspection>("GET", `/api/workspaces/inspect?path=${encodeURIComponent(box.gitRepo)}`)).body;
	assert.equal(again.registeredAs, "deckhand");
	assert.equal(again.hasRecipe, true);
	assert.equal(again.recipeDraft, repo.recipeDraft);
	const other = (await hub.api<RepoInspection>("GET", `/api/workspaces/inspect?path=${encodeURIComponent(second)}`)).body;
	assert.equal(other.id, "deckhand-2");
	const existingRecipe = "version: 1\nsetup: [echo preserved]\n";
	fs.writeFileSync(path.join(box.home, "repos", "deckhand-2.env.yaml"), existingRecipe);
	const preserved = await hub.api<WorkspaceDTO>("POST", "/api/workspaces", { repoPath: second, recipe: repo.recipeDraft });
	assert.equal(preserved.status, 200);
	assert.equal(fs.readFileSync(preserved.body.recipePath, "utf8"), existingRecipe);
	const notGit = (await hub.api<RepoInspection>("GET", `/api/workspaces/inspect?path=${encodeURIComponent(store)}`)).body;
	assert.equal(notGit.root, null);
	assert.equal(notGit.currentBranch, null);
	assert.equal(notGit.defaultBase, null);
	assert.equal(notGit.remoteUrl, null);
	assert.equal(notGit.dirty, false);
	assert.deepEqual(notGit.branches, []);
	assert.deepEqual(notGit.worktrees, []);
	assert.deepEqual(notGit.stack, []);
	assert.equal(notGit.recipeDraft, null);
});

test("command detection covers lockfiles and native toolchains without running project code", t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	const cases = [
		{ files: { "package.json": '{"scripts":{"test":"test","dev":"dev"}}', "yarn.lock": "" }, stack: ["yarn", "node"], install: "yarn install --frozen-lockfile", test: "yarn run test", dev: "yarn run dev" },
		{ files: { "package.json": '{"scripts":{"test":"test"}}', "yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules" }, stack: ["yarn", "node"], install: "yarn install --immutable", test: "yarn run test", dev: null },
		{ files: { "package.json": '{"scripts":{"test":"test"}}', "package-lock.json": "{}" }, stack: ["npm", "node"], install: "npm ci --prefer-offline --no-audit --no-fund", test: "npm test", dev: null },
		{ files: { "package.json": '{"scripts":{"test":"test"}}', "npm-shrinkwrap.json": "{}" }, stack: ["npm", "node"], install: "npm ci --prefer-offline --no-audit --no-fund", test: "npm test", dev: null },
		{ files: { "package.json": '{}' }, stack: ["npm", "node"], install: "npm install --prefer-offline --no-audit --no-fund", test: null, dev: null },
		{ files: { "package.json": '{}', "bun.lock": "{}" }, stack: ["bun", "node"], install: "bun install --frozen-lockfile", test: null, dev: null },
		{ files: { "package.json": '{"scripts":{"test":"bun test"}}', "bun.lockb": "" }, stack: ["bun", "node"], install: "bun install --frozen-lockfile", test: "bun run test", dev: null },
		{ files: { "package.json": '{"scripts":{"test":"node --test"}}', "pnpm-lock.yaml": "" }, stack: ["pnpm", "node"], install: "pnpm install --frozen-lockfile --prefer-offline", test: "pnpm run test", dev: null },
		{ files: { "package.json": "not json", "pnpm-lock.yaml": "" }, stack: ["pnpm", "node"], install: "pnpm install --frozen-lockfile --prefer-offline", test: null, dev: null },
		{ files: { "Cargo.toml": '[package]\nname = "fixture"' }, stack: ["cargo"], install: "cargo fetch", test: "cargo test", dev: null },
		{ files: { "Cargo.toml": '[package]\nname = "fixture"', "Cargo.lock": "version = 4" }, stack: ["cargo"], install: "cargo fetch --locked", test: "cargo test", dev: null },
		{ files: { "go.mod": "module fixture" }, stack: ["go"], install: "go mod download", test: "go test ./...", dev: null },
		{ files: { "pyproject.toml": '[project]\ndependencies = ["pytest"]', "uv.lock": "" }, stack: ["uv", "python"], install: "uv sync --frozen", test: "uv run pytest", dev: null },
		{ files: { "pyproject.toml": '[tool.poetry]\n[tool.poetry.group.test.dependencies]\npytest = "*"', "poetry.lock": "" }, stack: ["poetry", "python"], install: "poetry install --no-interaction", test: "poetry run pytest", dev: null },
		{ files: { "pyproject.toml": '[project]\nname = "fixture"' }, stack: ["python"], install: "python -m pip install -e .", test: null, dev: null },
		{ files: { "Makefile": "test:\n\techo tested\n" }, stack: ["make"], install: null, test: "make test", dev: null },
	];
	for (const [i, fixture] of cases.entries()) {
		const dir = path.join(box.tmp, String(i));
		fs.mkdirSync(dir);
		for (const [file, text] of Object.entries(fixture.files)) if (text !== undefined) fs.writeFileSync(path.join(dir, file), text);
		const result = detectCommands(dir);
		assert.deepEqual(result.stack, fixture.stack, String(i));
		assert.deepEqual(result.commands, { install: fixture.install, dev: fixture.dev }, String(i));
		assert.deepEqual(result.tests, fixture.test ? { unit: fixture.test, full: fixture.test } : {}, String(i));
		assert.deepEqual(result.copy, []);
		assert.ok(result.recipeDraft);
		const parsed = parseRecipe(result.recipeDraft);
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.recipe.setup, fixture.install ? [fixture.install] : []);
		assert.deepEqual(parsed.recipe.test, fixture.test ? { unit: fixture.test, full: fixture.test } : {});
	}
});

test("Rootique draft preserves generated declarations and the target setup and checks", t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	writeFiles(box.gitRepo, {
		"package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "expo lint", test: "jest", "test:ci": "jest --ci --runInBand --coverage" }, devDependencies: { typescript: "~6.0.3", jest: "^29.7.0" } }),
		"package-lock.json": "{}",
		"tsconfig.json": JSON.stringify({ include: ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"], exclude: ["node_modules", "supabase/functions"] }),
		".gitignore": "expo-env.d.ts\n.expo/\nnode_modules/\n.env*\nsupabase/functions/generated.ts\n",
		"expo-env.d.ts": '/// <reference types="expo/types" />\n',
		".expo/types/router.d.ts": 'declare module "expo-router" {}\n',
		".expo/dev/devices.json": "{}",
		"node_modules/library/index.d.ts": "export {};\n",
		"supabase/functions/generated.ts": "export {};\n",
		".env.test": "TEST_SECRET=not-for-the-draft\n",
		".env.test.local": "LOCAL_TEST_SECRET=not-for-the-draft\n",
		".env.local": "LOCAL_SECRET=not-for-the-draft\n",
		".env.production": "PRODUCTION_SECRET=not-for-the-draft\n",
		"untracked.ts": "export {};\n",
	});
	const result = detectCommands(box.gitRepo);
	assert.deepEqual(result.commands, { install: "npm ci --prefer-offline --no-audit --no-fund", dev: null });
	assert.deepEqual(result.copy.filter(file => file.why === "tsconfig"), [
		{ path: "expo-env.d.ts", why: "tsconfig" },
		{ path: ".expo/types/router.d.ts", why: "tsconfig" },
	]);
	assert.deepEqual(result.copy.filter(file => file.why === "env").map(file => file.path).sort(), [".env.local", ".env.test", ".env.test.local"]);
	const expectedTests = {
		typecheck: "npm run typecheck",
		lint: "CI=1 npm run lint",
		unit: "npm test -- --ci",
		coverage: "npm run test:ci",
		full: "npm run typecheck && CI=1 npm run lint && npm test -- --ci",
	};
	assert.deepEqual(result.tests, expectedTests);
	assert.ok(result.recipeDraft);
	const parsed = parseRecipe(result.recipeDraft);
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.recipe.copy, ["expo-env.d.ts", ".expo/types/router.d.ts"]);
	assert.deepEqual(parsed.recipe.setup, ["npm ci --prefer-offline --no-audit --no-fund"]);
	assert.deepEqual(parsed.recipe.test, expectedTests);
	assert.deepEqual(parsed.recipe.ports, []);
	assert.deepEqual(parsed.recipe.env, {});
	assert.doesNotMatch(result.recipeDraft, /SECRET|\.env/);
});

test("Node check selection prefers scripts and combines only fast checks in order", t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	const cases: { scripts: Record<string, string>; typescript?: "dependencies" | "devDependencies"; config?: string; tests: Record<string, string> }[] = [
		{
			scripts: { typecheck: "one", "type-check": "two", tsc: "three", lint: "eslint", test: "jest", "test:ci": "one", "test:coverage": "two", coverage: "three" },
			tests: { typecheck: "pnpm run typecheck", lint: "CI=1 pnpm run lint", unit: "pnpm run test -- --ci", coverage: "pnpm run test:ci", full: "pnpm run typecheck && CI=1 pnpm run lint && pnpm run test -- --ci" },
		},
		{ scripts: { "type-check": "tsc", tsc: "tsc", test: "node --test", "test:coverage": "coverage" }, tests: { typecheck: "pnpm run type-check", unit: "pnpm run test", coverage: "pnpm run test:coverage", full: "pnpm run type-check && pnpm run test" } },
		{ scripts: { tsc: "tsc", coverage: "coverage" }, tests: { typecheck: "pnpm run tsc", coverage: "pnpm run coverage", full: "pnpm run tsc" } },
		{ scripts: { typecheck: " ", lint: "", test: " " }, typescript: "devDependencies", config: "tsconfig.json", tests: { typecheck: "npx tsc --noEmit", full: "npx tsc --noEmit" } },
		{ scripts: {}, typescript: "dependencies", config: "tsconfig.json", tests: { typecheck: "npx tsc --noEmit", full: "npx tsc --noEmit" } },
		{ scripts: {}, config: "tsconfig.json", tests: {} },
		{ scripts: {}, typescript: "devDependencies", tests: {} },
		{ scripts: {}, typescript: "devDependencies", config: "jsconfig.json", tests: {} },
		{ scripts: { coverage: "coverage" }, tests: { coverage: "pnpm run coverage" } },
	];
	for (const [i, fixture] of cases.entries()) {
		const root = path.join(box.tmp, `checks-${i}`);
		writeFiles(root, {
			"package.json": JSON.stringify({ scripts: fixture.scripts, ...(fixture.typescript ? { [fixture.typescript]: { typescript: "*" } } : {}) }),
			"pnpm-lock.yaml": "",
			...(fixture.config ? { [fixture.config]: "{}" } : {}),
		});
		const result = detectCommands(root);
		assert.deepEqual(result.tests, fixture.tests, String(i));
		assert.ok(result.recipeDraft);
		const parsed = parseRecipe(result.recipeDraft);
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.recipe.test, fixture.tests, String(i));
	}
});

test("ignored config inputs respect JSONC, exclusions, tracked files and dependency trees", t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	writeFiles(box.gitRepo, {
		"jsconfig.json": `{
			// Declaration paths are local inputs, not a script to execute.
			"compilerOptions": { "baseUrl": "https://example.test/*keep*/" },
			"include": ["generated/**/*.js", "types", "node_modules/**/*.js", "nested/**/*.js",],
			"files": ["explicit.d.ts", "generated/excluded/explicit.js", "../outside.d.ts"],
			"exclude": ["generated/excluded",],
		}`,
		".gitignore": "generated/\ntypes/\nexplicit.d.ts\nnode_modules/\nnested/\n.env*\n",
		"explicit.d.ts": "export {};\n",
		"generated/client.js": "export {};\n",
		"generated/excluded/skip.js": "export {};\n",
		"generated/excluded/explicit.js": "export {};\n",
		"generated/tracked.js": "export {};\n",
		"types/client.d.ts": "export {};\n",
		"node_modules/dep/index.js": "export {};\n",
		"nested/node_modules/dep/index.js": "export {};\n",
		"nested/dist/output.js": "export {};\n",
		"nested/build/output.js": "export {};\n",
		"nested/target/output.js": "export {};\n",
		".env.test": "SECRET=never-read\n",
		".env.production": "SECRET=never-read\n",
	});
	box.git("add", "-f", "generated/tracked.js");
	const outside = path.join(box.tmp, "outside.d.ts");
	fs.writeFileSync(outside, "export {};\n");
	fs.symlinkSync(outside, path.join(box.gitRepo, "types", "outside.d.ts"));
	const result = detectCommands(box.gitRepo);
	assert.deepEqual(result.copy, [
		{ path: ".env.test", why: "env" },
		{ path: "explicit.d.ts", why: "tsconfig" },
		{ path: "generated/client.js", why: "tsconfig" },
		{ path: "types/client.d.ts", why: "tsconfig" },
		{ path: "generated/excluded/explicit.js", why: "tsconfig" },
	]);
	assert.ok(result.recipeDraft);
	const parsed = parseRecipe(result.recipeDraft);
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.recipe.copy, ["explicit.d.ts", "generated/client.js", "types/client.d.ts", "generated/excluded/explicit.js"]);
	assert.deepEqual(parsed.recipe.setup, []);
	assert.deepEqual(parsed.recipe.test, {});
});

test("copy suggestions are bounded and env-only inputs never enter a draft", t => {
	const box = sandbox();
	t.after(() => fs.rmSync(box.tmp, { recursive: true, force: true }));
	writeFiles(box.gitRepo, {
		".gitignore": ".env*\ngenerated/\n",
		".env.local": "SECRET=never-read\n",
	});
	const envOnly = detectCommands(box.gitRepo);
	assert.deepEqual(envOnly.copy, [{ path: ".env.local", why: "env" }]);
	assert.equal(envOnly.recipeDraft, null);
	writeFiles(box.gitRepo, {
		"tsconfig.json": '{"include":["generated/**/*.d.ts"]}',
		"generated/000-large.d.ts": " ".repeat(2 * 1024 * 1024 + 1),
		"generated/001-a.d.ts": " ".repeat(1024 * 1024),
		"generated/002-b.d.ts": " ".repeat(1024 * 1024),
		"generated/003-small.d.ts": "export {};\n",
	});
	const byteLimited = detectCommands(box.gitRepo);
	assert.deepEqual(byteLimited.copy.map(file => file.path), [".env.local", "generated/001-a.d.ts", "generated/003-small.d.ts"]);
	for (const file of ["000-large.d.ts", "001-a.d.ts", "002-b.d.ts"]) fs.rmSync(path.join(box.gitRepo, "generated", file));
	for (let i = 0; i < 140; i++) fs.writeFileSync(path.join(box.gitRepo, "generated", `${String(i).padStart(3, "0")}.d.ts`), "export {};\n");
	const countLimited = detectCommands(box.gitRepo);
	assert.equal(countLimited.copy.length, 128);
	assert.ok(countLimited.recipeDraft);
	const parsed = parseRecipe(countLimited.recipeDraft);
	assert.ok(parsed.ok);
	assert.equal(parsed.recipe.copy.length, 127);
	assert.ok(parsed.recipe.copy.every(file => file.startsWith("generated/")));
});

test("folder picker returns a selection, cancellation and localized errors", { timeout: 30_000 }, async t => {
	const box = sandbox();
	const bin = path.join(box.tmp, "bin");
	const argsFile = path.join(box.tmp, "picker-args.json");
	fs.mkdirSync(bin);
	const executable = path.join(bin, "osascript");
	fs.writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(${JSON.stringify(`${box.gitRepo}/`)});\n`, { mode: 0o755 });
	const hub = await startHub(box.configDir, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });
	t.after(async () => {
		hub.child.kill("SIGTERM");
		await hub.exited;
		fs.rmSync(box.tmp, { recursive: true, force: true });
	});
	const call = () => fetch(`http://127.0.0.1:${hub.port}/api/pick-folder`, { method: "POST", headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json", "x-omp-home-language": "zh" }, body: JSON.stringify({ defaultPath: box.gitRepo }) });
	const selected = await call();
	if (process.platform !== "darwin") {
		assert.equal(selected.status, 501);
		assert.match(await selected.text(), /仅支持 macOS/);
		return;
	}
	assert.equal(selected.status, 200);
	assert.deepEqual(await selected.json(), { path: box.gitRepo });
	const args: string[] = JSON.parse(fs.readFileSync(argsFile, "utf8"));
	assert.ok(args.includes("activate"));
	assert.ok(args.some(a => a.includes("选择仓库文件夹") && a.includes(`default location (POSIX file ${JSON.stringify(box.gitRepo)})`)));
	fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error('User canceled. (-128)'); process.exit(1);\n`);
	assert.deepEqual(await (await call()).json(), { path: null });
	fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error('Permission denied'); process.exit(1);\n`);
	const failed = await call();
	assert.equal(failed.status, 503);
	assert.match(await failed.text(), /无法打开文件夹选择器/);
});
