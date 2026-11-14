import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ChatRecordDTO, DecisionDTO, EscalationDTO, ModelCatalogDTO, RecipeCheckDTO, RecipeCheckStep, RecipeDTO, RepoInspection, RepoSuggestion, ResourcesDTO, SearchHit, SessionDTO, SettingsDTO, SetupPreview, StateDTO, TaskDetail, Topic, UiEvent, WorkspaceDTO } from "../../shared/api.ts";
import { installSocketFactory } from "./transport.ts";
import type { SocketHandlers } from "./transport.ts";
import { createMockSessions } from "./mock-sessions.ts";
import { getT } from "./i18n/runtime.ts";
import { readRecipeSummary } from "./RecipeSummary.tsx";

export function installMock() {
const now = Date.now();
const home = "/tmp/omp-home-demo/home";
const root = "/tmp/omp-home-demo";
const subscribers = new Set<SocketHandlers>();
const main: StateDTO["main"] = { sessionId: "M-1", state: "idle", wakesUsed: 2, wakesMax: 3, paused: false, pendingNotices: 1 };
let setupDone = new URLSearchParams(location.search).get("setup") !== "1";
let settings: SettingsDTO = { homePath: home, ompPath: null, pstackRoot: `${root}/pstack`, mainModel: "openai-codex/gpt-6-astra", mainThinking: "high", workerModel: "anthropic/claude-opus-5-5", workerThinking: "high", dispatcherModel: null, maxLiveWorkers: 4, idleEvictMinutes: 20, maxAutoWakes: 3, portRange: [4100, 4199], worktreeRoot: `${home}/worktrees`, appearance: { theme: "system", accent: "amber", textSize: "default", density: "comfortable" }, language: "system" };
const catalog: ModelCatalogDTO = {
	defaultModel: "anthropic/claude-opus-5-5", fetchedAt: now, error: null,
	models: [
		{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ["low", "medium", "high", "xhigh", "max"], input: ["text", "image"], cost: { input: 5, output: 25 } },
		{ selector: "anthropic/claude-sonnet-4-6", provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 1000000, maxTokens: 64000, reasoning: true, thinking: ["low", "medium", "high"], input: ["text", "image"], cost: { input: 3, output: 15 } },
		{ selector: "anthropic/claude-haiku-3", provider: "anthropic", id: "claude-haiku-3", name: "Claude Haiku 3", contextWindow: 200000, maxTokens: 4096, reasoning: false, thinking: [], input: ["text", "image"], cost: { input: 0.25, output: 1.25 } },
		{ selector: "openai-codex/gpt-6-astra", provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinking: ["low", "medium", "high", "xhigh"], input: ["text", "image"], cost: { input: 5, output: 30 } },
		{ selector: "openai-codex/gpt-5.3-codex", provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 400000, maxTokens: 128000, reasoning: true, thinking: ["low", "medium", "high", "xhigh"], input: ["text", "image"], cost: { input: 1.75, output: 14 } },
	],
};
const workspaces: WorkspaceDTO[] = ["atlas", "console"].map((id, index) => ({ id, name: index ? "Console" : "Atlas", repoPath: `${root}/${id}`, defaultBase: "main", workerModel: null, notesPath: `${home}/repos/${id}.md`, recipePath: `${home}/repos/${id}.env.yaml`, recipeStatus: index ? "missing" : "ok", recipeCheck: null, liveSessions: 1, totalSessions: 1, openTasks: index ? 1 : 3, archived: false }));
const detectedTests = { typecheck: "pnpm run typecheck", lint: "CI=1 pnpm run lint", unit: "pnpm test -- --ci", coverage: "pnpm run test:ci", full: "pnpm run typecheck && CI=1 pnpm run lint && pnpm test -- --ci" };
const recipeDraft = 'version: 1\ncopy: [expo-env.d.ts, .expo/types/router.d.ts]\nports: [web]\nenv:\n  PORT: "{port.web}"\nsetup:\n  - pnpm install --frozen-lockfile\ntest:\n' + Object.entries(detectedTests).map(([name, command]) => `  ${name}: ${command}\n`).join("");
function inspectRepo(path: string): RepoInspection {
	const name = path.split("/").filter(Boolean).at(-1) ?? "repository";
	const workspace = workspaces.find(item => item.repoPath === path);
	const isGit = name !== "documents";
	return {
		path, root: isGit ? path : null, name, id: workspace?.id ?? name, registeredAs: workspace?.id ?? null,
		currentBranch: isGit ? "feature/search" : null, defaultBase: isGit ? "main" : null,
		branches: isGit ? [
			{ name: "feature/search", remote: false, current: true, lastCommitAt: now - 3600000 },
			{ name: "main", remote: false, current: false, lastCommitAt: now - 86400000 },
			{ name: "origin/release", remote: true, current: false, lastCommitAt: now - 172800000 },
		] : [],
		worktrees: isGit ? [{ path: `${root}/${name}-preview`, branch: "preview/layout", head: "a1b2c3d4" }] : [],
		remoteUrl: isGit ? `git@github.com:demo/${name}.git` : null, dirty: isGit,
		omp: { sessions: isGit ? 8 : 0, lastUsedAt: isGit ? now - 3 * 86400000 : null, lastTitle: isGit ? "Refine the search experience" : null },
		stack: isGit ? ["pnpm", "node", "TypeScript"] : [],
		commands: { install: isGit ? "pnpm install --frozen-lockfile" : null, dev: isGit ? "pnpm dev" : null },
		tests: isGit ? detectedTests : {},
		copy: isGit ? [{ path: "expo-env.d.ts", why: "tsconfig" }, { path: ".expo/types/router.d.ts", why: "tsconfig" }, { path: ".env.local", why: "env" }] : [],
		recipeDraft: isGit ? recipes.get(workspace?.id ?? "")?.text || recipeDraft : null,
		hasRecipe: workspace?.recipeStatus === "ok",
	};
}
const escalation: EscalationDTO = { id: "E-3", taskId: "T-12", taskTitle: "Choose the account migration strategy", sessionId: "W-12", reason: "The account migration removes a legacy column. I need your approval before changing the data contract.", openedBy: "main", openedAt: now - 180000, seenAt: null, resolvedAt: null, resolution: null };
const decisions: DecisionDTO[] = [{ id: "D-7", taskId: "T-11", at: now - 420000, summary: "Keep the search index local to each worktree", why: "Isolation makes parallel tests deterministic and avoids shared writes.", revert: "Point SEARCH_DB at the shared development index and restart the service.", reverts: null, revertRequestedAt: null, revertedBy: null }, { id: "D-6", taskId: "T-9", at: now - 3600000, summary: "Use the existing retry policy for transient reads", why: "The established boundary already distinguishes transient errors.", revert: "Revert commit a1b2c3d on task/search-timeouts.", reverts: null, revertRequestedAt: null, revertedBy: null }];
const tasks: TaskDetail[] = [
	{ id: "T-14", title: "Document the workspace onboarding flow", workspace: "console", status: "pending", sessionId: null, wait: null },
	{ id: "T-11", title: "Make search indexing incremental", workspace: "atlas", status: "working", sessionId: "W-11", wait: null },
	{ id: "T-12", title: escalation.taskTitle, workspace: "console", status: "awaiting", sessionId: "W-12", wait: { kind: "approval", text: "Confirm the account migration strategy." } },
	{ id: "T-9", title: "Fix search timeout handling", workspace: "atlas", status: "done", sessionId: "W-11", wait: null },
	{ id: "T-8", title: "Replace the existing logging framework", workspace: "console", status: "cancelled", sessionId: null, wait: null },
	{ id: "T-13", title: "校验导入数据的边界条件", workspace: "atlas", status: "awaiting", sessionId: null, wait: { kind: "provision_failed", text: "Preview database could not start: port 5432 is already in use. Review the environment before continuing." } },
].map((item, index): TaskDetail => {
	const branch = item.status === "pending" ? null : `task/${item.id.toLowerCase()}-${item.workspace}`;
	const path = branch ? `${home}/worktrees/${item.workspace}/${item.id}` : null;
	const closed = item.status === "done" || item.status === "cancelled";
	const progress: TaskDetail["progress"] = closed ? null : {
		phase: item.id === "T-14" ? "queued" : item.id === "T-12" ? "approval" : item.id === "T-13" ? "cold" : "running",
		intent: item.id === "T-11" ? "Tracing changed-file ownership" : null,
		lastEvent: item.id === "T-14" ? "Waiting for an available worker slot" : item.wait?.text ?? "Worker started the implementation",
		since: now - (index + 1) * 60000,
	};
	return {
		...item, status: item.status as TaskDetail["status"], wait: item.wait as TaskDetail["wait"], branch, playbook: item.id === "T-14" ? "docs" : "feature",
		createdAt: now - (index + 1) * 3600000, updatedAt: now - (index + 1) * 60000,
		endedAt: item.status === "done" ? now - 180000 : item.status === "cancelled" ? now - 172800000 : null, progress,
		brief: `## Goal\n${item.title}.\n\n## Constraints\nKeep work isolated. Do not publish changes or modify production data.\n\n## Acceptance\nRun focused tests and report the observed results.`,
		envelope: `Task: ${item.id}\nWorkspace: ${item.workspace}\nAudience: worker\nPolicy: work locally; report to main first.`,
		checkout: { kind: "worktree" }, worktreePath: path, related: [],
		reports: item.status === "pending" ? [] : [{ at: now - 240000, status: item.status === "done" ? "done" : item.status === "awaiting" ? "question" : "progress", summary: item.status === "done" ? "Fixed the timeout boundary; focused tests pass." : "Reviewed the implementation and narrowed the change.", details: "No external services or production data were changed." }],
		events: [{ id: index * 3 + 1, at: now - (index + 1) * 3600000, actor: "dispatcher", kind: "created", summary: "Task dispatched by main", data: {} }, ...(item.status === "pending" ? [] : [{ id: index * 3 + 2, at: now - 300000, actor: "worker" as const, kind: item.wait?.kind ?? item.status, summary: item.wait?.text ?? "Worker started the implementation", data: {} }])],
		decisions: decisions.filter(decision => decision.taskId === item.id), escalations: item.id === escalation.taskId ? [escalation] : [],
		git: path ? { dirty: item.status === "working", ahead: item.status === "done" ? 1 : 0, head: "a1b2c3d" } : null,
		env: path ? { worktreeId: `WT-${index + 1}`, worktreePath: path, workspace: item.workspace, state: item.id === "T-13" ? "failed" : "ready", error: item.id === "T-13" ? item.wait?.text ?? null : null, vars: { NODE_ENV: "test", DATABASE_URL: `postgres://local:demo-secret@127.0.0.1:5432/${item.workspace}_test`, PORT: String(4100 + index) }, updatedAt: now - 300000 } : null,
	};
});
if (new URLSearchParams(location.search).get("scene") === "empty") {
	for (const task of tasks) { task.status = "done"; task.wait = null; task.progress = null; task.endedAt = now - 172800000; }
	escalation.resolvedAt = now; escalation.resolution = "task_moved";
}
const sessions: SessionDTO[] = [{ id: "M-1", kind: "main", workspace: null, worktreePath: null, branch: "main", cwd: home, model: settings.mainModel!, state: "idle", pid: 42310, rssMb: 182.4, lastActivity: now - 30000, openTask: null, retired: false, createdAt: now - 7200000 }, ...["W-11", "W-12"].map((id, index): SessionDTO => {
	const task = tasks.find(task => task.sessionId === id)!;
	return { id, kind: "worker", workspace: task.workspace, worktreePath: task.worktreePath, branch: task.branch, cwd: task.worktreePath!, model: settings.workerModel!, state: index ? "approval" : "running", pid: 42311 + index, rssMb: index ? 146.8 : 211.2, lastActivity: now - (index + 1) * 45000, openTask: { id: task.id, title: task.title, status: task.status }, retired: false, createdAt: now - 3600000 };
})];
const resources: ResourcesDTO = { services: [{ id: "S-1", workspace: "atlas", name: "postgres", kind: "external", state: "up", pid: null, checkedAt: now - 30000, error: null, logTail: "[health] 127.0.0.1:5432 accepting connections\n[health] database ready" }, { id: "S-2", workspace: "console", name: "preview", kind: "run", state: "down", pid: null, checkedAt: now - 60000, error: null, logTail: "Preview service stopped cleanly." }], leases: [{ id: 1, kind: "port", key: "4101", label: "Atlas development server", holderKind: "worktree", holderId: "WT-2", acquiredAt: now - 3600000, expiresAt: now + 3600000 }, { id: 2, kind: "db", key: "atlas_t11", label: "Isolated test database", holderKind: "worktree", holderId: "WT-2", acquiredAt: now - 3600000, expiresAt: null }], environments: tasks.flatMap(task => task.env ? [task.env] : []) };
const recipes = new Map<string, RecipeDTO>(workspaces.map(workspace => [workspace.id, { workspace: workspace.id, path: workspace.recipePath, text: workspace.recipeStatus === "ok" ? recipeDraft : "", status: workspace.recipeStatus, errors: [] }]));
const recipeChecks = new Map<string, RecipeCheckDTO>();
const checkSources = new Map<string, string>();
function publishCheck(workspace: WorkspaceDTO, check: RecipeCheckDTO) {
	check.current = checkSources.get(workspace.id) === recipes.get(workspace.id)?.text;
	workspace.recipeCheck = { state: check.state, current: check.current, endedAt: check.endedAt };
	invalidate(["workspaces"]);
}
function startCheck(workspace: WorkspaceDTO, test: string) {
	const recipe = recipes.get(workspace.id);
	const summary = readRecipeSummary(recipe?.text ?? "");
	if (!recipe || recipe.status !== "ok" || !summary) return response({ error: getT().panels.workspaces.recipeLoadError }, 422);
	if (recipeChecks.get(workspace.id)?.state === "running") return response({ error: getT().panels.workspaces.checkStates.running }, 409);
	if (test && !(test in summary.test)) return response({ error: getT().panels.workspaces.checkActionError }, 422);
	const step = (kind: RecipeCheckStep["kind"], name: string, command: string | null = null): RecipeCheckStep => ({ kind, name, command, state: "pending", exitCode: null, ms: null, outputTail: "" });
	const tests = test ? [[test, summary.test[test]]] : summary.test.full ? [["full", summary.test.full]] : Object.entries(summary.test);
	const check: RecipeCheckDTO = {
		workspace: workspace.id, recipeHash: `mock-${Date.now()}`, current: true, base: workspace.defaultBase, sha: "a1b2c3d4e5f67890",
		state: "running", startedAt: Date.now(), endedAt: null,
		steps: [step("checkout", workspace.defaultBase), ...summary.copy.map(file => step("copy", file)), ...summary.setup.map((command, index) => step("setup", String(index + 1), command)), ...tests.map(([name, command]) => step("test", name, command)), step("teardown", "worktree")],
	};
	check.steps[0].state = "running";
	recipeChecks.set(workspace.id, check); checkSources.set(workspace.id, recipe.text); publishCheck(workspace, check);
	let index = 0;
	const advance = () => {
		if (check.state !== "running") return;
		const current = check.steps[index];
		const failed = workspace.id === "atlas" && current.kind === "test" && (current.name === "lint" || current.name === "full");
		current.state = failed ? "failed" : "passed"; current.ms = 650; current.exitCode = current.command ? failed ? 1 : 0 : null;
		current.outputTail = failed ? "src/search.ts:42:7  error  'query' is assigned a value but never used  @typescript-eslint/no-unused-vars\n✖ 1 problem (1 error, 0 warnings)\nCommand failed with exit code 1." : current.kind === "test" ? "All checks passed.\nTests: 24 passed, 24 total." : current.kind === "setup" ? "Dependencies installed from the lockfile." : current.kind === "teardown" ? "Temporary worktree removed. No leases remain." : "";
		if (failed) {
			for (const remaining of check.steps.slice(index + 1, -1)) remaining.state = "skipped";
			index = check.steps.length - 1;
		} else index++;
		if (index === check.steps.length) { check.state = check.steps.some(item => item.state === "failed") ? "failed" : "passed"; check.endedAt = Date.now(); }
		else { check.steps[index].state = "running"; window.setTimeout(advance, 650); }
		publishCheck(workspace, check);
	};
	window.setTimeout(advance, 650);
	return response(check, 202);
}
const chat: ChatRecordDTO[] = [{ id: 1, role: "user", at: now - 900000, text: "Let's improve search in Atlas and review the account migration in Console. Keep the work isolated." }, { id: 2, role: "assistant", at: now - 840000, text: "I'll route those to separate workers. I'll review their reports first and bring you in for the migration decision." }, { id: 3, role: "notice", at: now - 180000, text: "W-12 reported a schema migration that needs human approval." }, { id: 4, role: "assistant", at: now - 120000, text: "The incremental search work is progressing. The account migration changes a data contract; I've opened it in your inbox." }];
function emit(event: UiEvent) { subscribers.forEach(subscriber => subscriber.message(JSON.stringify(event))); }
function invalidate(topics: Topic[]) { queueMicrotask(() => emit({ t: "invalidate", topics })); }
function state(): StateDTO { return { version: "mock", omp: { version: "18.20.0", path: "/Applications/omp-home.app/Contents/Resources/omp", managed: true, warning: null }, setup: { done: setupDone, homePath: setupDone ? settings.homePath : null }, main, pool: { live: sessions.filter(session => session.kind === "worker" && session.state !== "cold" && !session.retired).length, cap: settings.maxLiveWorkers }, inboxOpen: escalation.resolvedAt === null ? 1 : 0, openTasks: tasks.filter(task => task.status !== "done" && task.status !== "cancelled").length }; }
const bodySchema = z.record(z.string(), z.unknown());
const text = (body: Record<string, unknown>, key: string, fallback = "") => typeof body[key] === "string" ? body[key] : fallback;
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
const sessionMock = createMockSessions((command, sessionId) => {
	if (command === "/focus") { escalation.resolvedAt = null; escalation.resolution = null; emit({ t: "focus", sessionId: "W-12", escalationId: escalation.id, reason: escalation.reason }); invalidate(["inbox", "state"]); }
	else if (command === "/pause") { main.paused = true; main.wakesUsed = main.wakesMax; invalidate(["state", "inbox"]); }
	else if (command === "/dispatch") {
		const task = tasks.find(task => task.id === "T-14")!;
		task.status = "pending"; task.endedAt = null; task.progress = { phase: "queued", intent: null, lastEvent: "Waiting for an available worker slot", since: Date.now() };
		invalidate(["tasks", "state"]);
	}
	else {
		chat.push({ id: chat.length + 1, role: "user", at: Date.now(), text: command });
		if (sessionId === escalation.sessionId) {
			escalation.resolvedAt = Date.now(); escalation.resolution = "human_replied";
			const task = tasks.find(task => task.id === escalation.taskId)!;
			task.status = "working"; task.wait = null; task.progress = { phase: "running", intent: "Following migration guidance", lastEvent: command, since: Date.now() };
			invalidate(["inbox", "state", "tasks", `task:${task.id}`]);
		}
	}
});
const intents = ["Reading changed-file ownership", "Verifying incremental index updates", "Reviewing search test evidence"];
let intentIndex = 0;
window.setInterval(() => {
	const task = tasks.find(task => task.id === "T-11");
	if (task?.progress?.phase === "running") { task.progress.intent = intents[intentIndex++ % intents.length]; invalidate(["tasks", `task:${task.id}`]); }
}, 8000);

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
		if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
		try {
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? bodySchema.parse(JSON.parse(init.body)) : {};
			const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			const [, route, id, action] = parts;
			if (route === "state") return response(state());
			if (route === "setup") {
				if (id === "preview") { const homePath = url.searchParams.get("home") ?? home; return response({ homePath, exists: true, isGitRepo: true, changes: [{ path: "AGENTS.md", action: "backup", reason: "Preserve your current instructions before migration." }, { path: "AGENTS.md", action: "replace", reason: "Add the main chat workflow and workspace registry." }, { path: "repos/", action: "create", reason: "Store workspace notes and environment recipes." }], pstackCandidates: [`${root}/pstack`] } satisfies SetupPreview); }
				settings.homePath = text(body, "homePath", home); settings.pstackRoot = body.pstackRoot === null ? null : text(body, "pstackRoot"); setupDone = true; invalidate(["state", "settings"]); return response(state());
			}
			if (route === "models") { if (url.searchParams.get("refresh") === "1") catalog.fetchedAt = Date.now(); return response(catalog); }
			if (route === "pick-folder") return response({ path: `${root}/website` });
			if (route === "settings") {
				if (method === "PUT") {
					const nextAppearance = body.appearance === undefined ? settings.appearance : { ...settings.appearance, ...bodySchema.parse(body.appearance) };
					settings = { ...settings, ...body, appearance: nextAppearance } as SettingsDTO;
					main.wakesMax = settings.maxAutoWakes; invalidate(["settings", "state"]);
				}
				return response(settings);
			}
			if (route === "main") { main.state = "idle"; main.paused = false; main.wakesUsed = 0; main.pendingNotices = 0; if (id === "new") { const old = sessions.find(session => session.id === main.sessionId); if (old) { old.retired = true; old.state = "cold"; } main.sessionId = `M-${sessions.length + 1}`; sessions.unshift({ ...sessions[0], id: main.sessionId, state: "idle", retired: false, createdAt: Date.now() }); } invalidate(["state", "sessions", "inbox"]); return response(state()); }
			if (route === "inbox") return response({ main, escalations: escalation.resolvedAt === null ? [escalation] : [] });
			if (route === "escalations") { if (action === "seen") escalation.seenAt = Date.now(); else { escalation.resolvedAt = Date.now(); escalation.resolution = "dismissed"; } invalidate(["inbox", "state", "task:T-12"]); return response(escalation); }
			if (route === "tasks") {
				if (!id) {
					const status = url.searchParams.get("status");
					return response(tasks.filter(task => (!status || (status === "open" ? task.status !== "done" && task.status !== "cancelled" : status === "closed" ? task.status === "done" || task.status === "cancelled" : task.status === status)) && (!url.searchParams.get("workspace") || task.workspace === url.searchParams.get("workspace")) && (!url.searchParams.get("q") || `${task.title} ${task.id} ${task.brief}`.toLowerCase().includes(url.searchParams.get("q")!.toLowerCase()))));
				}
				const task = tasks.find(task => task.id === id); if (!task) return response({ error: "Task not found" }, 404);
				if (method === "POST") {
					if (action === "cancel") { task.status = "cancelled"; task.wait = null; task.progress = null; task.endedAt = Date.now(); if (task.id === escalation.taskId) { escalation.resolvedAt = Date.now(); escalation.resolution = "task_moved"; } }
					if (action === "message") { task.status = "working"; task.wait = null; task.endedAt = null; task.progress = { phase: "running", intent: "Following human guidance", lastEvent: text(body, "text"), since: Date.now() }; if (task.id === escalation.taskId) { escalation.resolvedAt = Date.now(); escalation.resolution = "human_replied"; } }
					if (action === "cleanup") { task.worktreePath = null; if (task.env) task.env.state = "torn_down"; }
					task.updatedAt = Date.now(); task.events.push({ id: Date.now(), at: Date.now(), actor: "human", kind: action ?? "message", summary: text(body, "text") || text(body, "reason") || "Environment torn down; worktree removed; branch retained.", data: body });
					invalidate(["tasks", `task:${id}`, "resources", "state", "inbox"]);
				}
				return response(task);
			}
			if (route === "sessions" && id && action && ["prompt", "abort", "respond", "commands", "history", "subagents"].includes(action)) {
				const result = sessionMock.request(id, action, body, parts, url.searchParams.get("before"));
				if (action === "respond" && id === escalation.sessionId) {
					escalation.resolvedAt = Date.now(); escalation.resolution = "human_replied";
					const task = tasks.find(task => task.id === escalation.taskId)!;
					task.status = "working"; task.wait = null; task.progress = { phase: "running", intent: "Continuing the migration review", lastEvent: "Approval answered", since: Date.now() };
					invalidate(["tasks", `task:${task.id}`, "inbox", "state"]);
				}
				return response(result);
			}
			if (route === "sessions") {
				if (!id) return response(sessions);
				const session = sessions.find(item => item.id === id);
				if (!session) return response({ error: "Session not found" }, 404);
				if (action === "attach") session.state = session.state === "cold" ? "idle" : session.state;
				else { session.state = "cold"; session.pid = null; if (action === "retire") session.retired = true; }
				if (session.kind === "main") main.state = session.state;
				for (const task of tasks) if (task.sessionId === id && task.progress) task.progress = { ...task.progress, phase: session.state === "cold" ? "cold" : session.state === "approval" ? "approval" : session.state === "running" ? "running" : "idle", since: Date.now() };
				invalidate(["sessions", "state", "workspaces", "tasks"]); return response(session);
			}
			if (route === "decisions") { if (!id) return response(decisions.filter(item => !url.searchParams.get("task") || item.taskId === url.searchParams.get("task"))); const decision = decisions.find(item => item.id === id); if (!decision) return response({ error: "Decision not found" }, 404); decision.revertRequestedAt = Date.now(); invalidate(["decisions", ...(decision.taskId ? [`task:${decision.taskId}` as Topic] : [])]); return response(decision); }
			if (route === "workspaces") {
				if (id === "suggestions") return response([
					{ path: `${root}/website`, name: "website", source: "omp" as const, ompSessions: 8, lastUsedAt: now - 3 * 86400000, lastTitle: "Refine the search experience", registeredAs: null },
					{ path: `${root}/notes`, name: "notes", source: "home" as const, ompSessions: 0, lastUsedAt: null, lastTitle: null, registeredAs: null },
					{ path: `${root}/atlas`, name: "Atlas", source: "omp" as const, ompSessions: 24, lastUsedAt: now - 3600000, lastTitle: "Incremental search indexing", registeredAs: "atlas" },
				].map(suggestion => ({ ...suggestion, registeredAs: workspaces.find(workspace => workspace.repoPath === suggestion.path)?.id ?? null })) satisfies RepoSuggestion[]);
				if (id === "inspect") return response(inspectRepo(url.searchParams.get("path") ?? ""));
				if (!id && method === "GET") return response(workspaces);
				if (!id) {
					const repoPath = text(body, "repoPath");
					const workspaceId = text(body, "id") || repoPath.split("/").filter(Boolean).at(-1) || "workspace";
					if (workspaces.some(item => item.id === workspaceId || item.repoPath === repoPath)) return response({ error: getT().panels.workspaces.alreadyRegistered }, 409);
					const yaml = text(body, "recipe");
					if (yaml) {
						try { const parsed: unknown = parseYaml(yaml); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); }
						catch { return response({ error: getT().panels.workspaces.recipeSaveError }, 422); }
					}
					const workspace: WorkspaceDTO = { id: workspaceId, name: text(body, "name", workspaceId), repoPath, defaultBase: text(body, "defaultBase", "main"), workerModel: body.workerModel === null ? null : text(body, "workerModel") || null, notesPath: `${home}/repos/${workspaceId}.md`, recipePath: `${home}/repos/${workspaceId}.env.yaml`, recipeStatus: yaml ? "ok" : "missing", recipeCheck: null, liveSessions: 0, totalSessions: 0, openTasks: 0, archived: false };
					if (yaml) recipes.set(workspaceId, { workspace: workspaceId, path: workspace.recipePath, text: yaml, status: "ok", errors: [] });
					workspaces.push(workspace); invalidate(["workspaces"]); return response(workspace);
				}
				const workspace = workspaces.find(item => item.id === id); if (!workspace) return response({ error: "Workspace not found" }, 404);
				if (action === "recipe") {
					if (parts[4] === "check") {
						const check = recipeChecks.get(id);
						if (parts[5] === "cancel" && method === "POST") {
							if (!check) return response({ error: getT().panels.workspaces.checkActionError }, 404);
							if (check.state === "running") {
								check.state = "cancelled"; check.endedAt = Date.now();
								for (const step of check.steps) {
									if (step.state === "running" || step.state === "pending") step.state = "skipped";
									if (step.kind === "teardown") { step.state = "passed"; step.ms = 100; step.outputTail = "Temporary worktree removed after cancellation."; }
								}
								publishCheck(workspace, check);
							}
							return response(check);
						}
						if (method === "POST") return startCheck(workspace, text(body, "test"));
						return response(check ?? null);
					}
					const recipe = recipes.get(id) ?? { workspace: id, path: workspace.recipePath, text: "", status: "missing", errors: [] };
					if (method === "PUT") {
						const yaml = text(body, "text");
						try { const parsed: unknown = parseYaml(yaml); if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error(getT().panels.workspaces.recipeSaveError); }
						catch (error) { return response({ error: getT().panels.workspaces.recipeSaveError, errors: [{ path: "recipe", message: error instanceof Error ? error.message : String(error) }] }, 422); }
						recipe.text = yaml; recipe.status = "ok"; workspace.recipeStatus = "ok"; recipes.set(id, recipe);
						const check = recipeChecks.get(id); if (check) publishCheck(workspace, check);
						invalidate(["workspaces"]);
					}
					return response(recipe);
				}
				if (action === "archive") workspace.archived = true;
				if (method === "PATCH") { workspace.name = text(body, "name", workspace.name); workspace.defaultBase = text(body, "defaultBase", workspace.defaultBase); if ("workerModel" in body) workspace.workerModel = body.workerModel === null ? null : text(body, "workerModel"); }
				invalidate(["workspaces"]); return response(workspace);
			}
			if (route === "resources") return response(resources);
			if (route === "services") { const service = resources.services.find(item => item.id === id); if (!service) return response({ error: "Service not found" }, 404); if (action === "start") { service.state = "up"; service.pid = 43900; } if (action === "stop") { service.state = "down"; service.pid = null; } service.checkedAt = Date.now(); service.logTail += `\n[${action}] ${service.state}`; invalidate(["resources"]); return response(service); }
			if (route === "leases") { const index = resources.leases.findIndex(item => item.id === Number(id)); if (index < 0) return response({ error: "Lease not found" }, 404); const [lease] = resources.leases.splice(index, 1); invalidate(["resources"]); return response(lease); }
			if (route === "chat") { const before = Number(url.searchParams.get("before") ?? Infinity); const after = Number(url.searchParams.get("after") ?? -Infinity); const limit = Number(url.searchParams.get("limit") ?? 50); const rows = chat.filter(item => item.id < before && item.id > after); return response(url.searchParams.has("after") ? rows.slice(0, limit) : rows.slice(-limit)); }
			if (route === "search") { const q = (url.searchParams.get("q") ?? "").toLowerCase(); const hits: SearchHit[] = [...tasks.map(task => ({ ref: task.id, kind: "brief" as const, at: task.updatedAt, taskId: task.id, title: task.title, excerpt: task.brief })), ...chat.map(item => ({ ref: `chat:${item.id}`, kind: "chat" as const, at: item.at, taskId: null, title: "Main chat", excerpt: item.text }))]; return response(hits.filter(hit => `${hit.title} ${hit.excerpt}`.toLowerCase().includes(q))); }
			return response({ error: `Mock route not implemented: ${method} ${url.pathname}` }, 404);
		} catch (error) { return response({ error: error instanceof Error ? error.message : String(error) }, 400); }
	};
	installSocketFactory((path, handlers) => {
		if (path !== "/api/events") {
			const match = path.match(/^\/api\/sessions\/([^/]+)\/stream$/);
			if (!match) throw new Error(`Unknown mock stream: ${path}`);
			return sessionMock.connect(decodeURIComponent(match[1]), handlers);
		}
		let readyState = 0;
		const timer = window.setTimeout(() => { readyState = 1; subscribers.add(handlers); handlers.open(); }, 40);
		return { get readyState() { return readyState; }, send() { throw new Error("Hub events are server-to-client only"); }, close() { readyState = 3; clearTimeout(timer); subscribers.delete(handlers); handlers.close(); } };
	});
}
