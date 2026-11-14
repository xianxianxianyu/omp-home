import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ChatRecordDTO, DecisionDTO, EscalationDTO, RecipeDTO, ResourcesDTO, SearchHit, SessionDTO, SettingsDTO, SetupPreview, StateDTO, TaskDetail, Topic, UiEvent, WorkspaceDTO } from "../../shared/api.ts";
import { installSocketFactory } from "./transport.ts";
import type { SocketHandlers } from "./transport.ts";
import { createMockSessions } from "./mock-sessions.ts";

export function installMock() {
const now = Date.now();
const home = "/Volumes/NVMe2T/project/home";
const root = "/Volumes/NVMe2T/project";
const subscribers = new Set<SocketHandlers>();
const main: StateDTO["main"] = { sessionId: "M-1", state: "idle", wakesUsed: 2, wakesMax: 3, paused: false, pendingNotices: 1 };
let setupDone = new URLSearchParams(location.search).get("setup") !== "1";
let settings: SettingsDTO = { homePath: home, ompPath: null, pstackRoot: `${root}/pstack`, mainModel: "openai-codex/gpt-6-astra", mainThinking: "high", workerModel: "anthropic/claude-opus-5-5", workerThinking: "high", dispatcherModel: null, maxLiveWorkers: 4, idleEvictMinutes: 20, maxAutoWakes: 3, portRange: [4100, 4199], worktreeRoot: `${home}/worktrees` };
const workspaces: WorkspaceDTO[] = ["atlas", "console"].map((id, index) => ({ id, name: index ? "Console" : "Atlas", repoPath: `${root}/${id}`, defaultBase: "main", workerModel: null, notesPath: `${home}/repos/${id}.md`, recipePath: `${home}/repos/${id}.env.yaml`, recipeStatus: index ? "missing" : "ok", liveSessions: 1, totalSessions: 1, openTasks: index ? 1 : 3, archived: false }));
const escalation: EscalationDTO = { id: "E-3", taskId: "T-12", taskTitle: "Choose the account migration strategy", sessionId: "W-12", reason: "The account migration removes a legacy column. I need your approval before changing the data contract.", openedBy: "main", openedAt: now - 180000, seenAt: null, resolvedAt: null, resolution: null };
const decisions: DecisionDTO[] = [{ id: "D-7", taskId: "T-11", at: now - 420000, summary: "Keep the search index local to each worktree", why: "Isolation makes parallel tests deterministic and avoids shared writes.", revert: "Point SEARCH_DB at the shared development index and restart the service.", reverts: null, revertRequestedAt: null, revertedBy: null }, { id: "D-6", taskId: "T-9", at: now - 3600000, summary: "Use the existing retry policy for transient reads", why: "The established boundary already distinguishes transient errors.", revert: "Revert commit a1b2c3d on task/search-timeouts.", reverts: null, revertRequestedAt: null, revertedBy: null }];
const tasks: TaskDetail[] = [
	{ id: "T-14", title: "Document the workspace onboarding flow", workspace: "console", status: "pending", sessionId: null, wait: null },
	{ id: "T-11", title: "Make search indexing incremental", workspace: "atlas", status: "working", sessionId: "W-11", wait: null },
	{ id: "T-12", title: escalation.taskTitle, workspace: "console", status: "awaiting", sessionId: "W-12", wait: { kind: "approval", text: "Confirm the account migration strategy." } },
	{ id: "T-9", title: "Fix search timeout handling", workspace: "atlas", status: "done", sessionId: "W-11", wait: null },
	{ id: "T-8", title: "Replace the existing logging framework", workspace: "console", status: "cancelled", sessionId: null, wait: null },
	{ id: "T-13", title: "校验导入数据的边界条件", workspace: "atlas", status: "awaiting", sessionId: null, wait: { kind: "interrupted", text: "The hub restarted during the last turn. Review before resuming." } },
].map((item, index) => {
	const branch = item.status === "pending" ? null : `task/${item.id.toLowerCase()}-${item.workspace}`;
	const path = branch ? `${home}/worktrees/${item.workspace}/${item.id}` : null;
	return { ...item, status: item.status as TaskDetail["status"], wait: item.wait as TaskDetail["wait"], branch, playbook: "feature", createdAt: now - (index + 1) * 3600000, updatedAt: now - (index + 1) * 60000, brief: `## Goal\n${item.title}.\n\n## Background\nKeep behavior consistent with the existing workspace conventions. The main session has reviewed the scope and isolated this work in its own git worktree.\n\n## Constraints\nDo not publish changes or modify production data. Preserve the existing public API.\n\n## Acceptance\nRun the focused tests, report the observed results, and explain any remaining decisions.`, envelope: `Task: ${item.id}\nWorkspace: ${item.workspace}\nAudience: worker\nPolicy: work locally; report to main first.`, checkout: { kind: "worktree" }, worktreePath: path, related: [], reports: item.status === "pending" ? [] : [{ at: now - 240000, status: item.status === "done" ? "done" : item.status === "awaiting" ? "question" : "progress", summary: item.status === "done" ? "Fixed the timeout boundary; focused tests pass." : "Reviewed the existing implementation and narrowed the change.", details: "The implementation follows the existing error boundary. No external services or production data were changed." }], events: [{ id: index * 3 + 1, at: now - (index + 1) * 3600000, actor: "dispatcher", kind: "created", summary: "Task dispatched by main", data: {} }, ...(item.status === "pending" ? [] : [{ id: index * 3 + 2, at: now - 300000, actor: "worker" as const, kind: item.status === "awaiting" ? "awaiting" : "working", summary: item.status === "awaiting" ? "Worker needs a decision before continuing" : "Worker started the implementation", data: {} }])], decisions: decisions.filter(decision => decision.taskId === item.id), escalations: item.id === escalation.taskId ? [escalation] : [], git: path ? { dirty: item.status === "working", ahead: item.status === "done" ? 1 : 0, head: "a1b2c3d" } : null, env: path ? { worktreeId: `WT-${index + 1}`, worktreePath: path, workspace: item.workspace, state: "ready", error: null, vars: { NODE_ENV: "test", DATABASE_URL: `postgres://local:demo-secret@127.0.0.1:5432/${item.workspace}_test`, PORT: String(4100 + index) }, updatedAt: now - 300000 } : null };
});
const sessions: SessionDTO[] = [{ id: "M-1", kind: "main", workspace: null, worktreePath: null, branch: "main", cwd: home, model: settings.mainModel!, state: "idle", pid: 42310, rssMb: 182.4, lastActivity: now - 30000, openTask: null, retired: false, createdAt: now - 7200000 }, ...["W-11", "W-12"].map((id, index): SessionDTO => {
	const task = tasks.find(task => task.sessionId === id)!;
	return { id, kind: "worker", workspace: task.workspace, worktreePath: task.worktreePath, branch: task.branch, cwd: task.worktreePath!, model: settings.workerModel!, state: index ? "approval" : "running", pid: 42311 + index, rssMb: index ? 146.8 : 211.2, lastActivity: now - (index + 1) * 45000, openTask: { id: task.id, title: task.title, status: task.status }, retired: false, createdAt: now - 3600000 };
})];
const resources: ResourcesDTO = { services: [{ id: "S-1", workspace: "atlas", name: "postgres", kind: "external", state: "up", pid: null, checkedAt: now - 30000, error: null, logTail: "[health] 127.0.0.1:5432 accepting connections\n[health] database ready" }, { id: "S-2", workspace: "console", name: "preview", kind: "run", state: "down", pid: null, checkedAt: now - 60000, error: null, logTail: "Preview service stopped cleanly." }], leases: [{ id: 1, kind: "port", key: "4101", label: "Atlas development server", holderKind: "worktree", holderId: "WT-2", acquiredAt: now - 3600000, expiresAt: now + 3600000 }, { id: 2, kind: "db", key: "atlas_t11", label: "Isolated test database", holderKind: "worktree", holderId: "WT-2", acquiredAt: now - 3600000, expiresAt: null }], environments: tasks.flatMap(task => task.env ? [task.env] : []) };
const recipes = new Map<string, RecipeDTO>(workspaces.map(workspace => [workspace.id, { workspace: workspace.id, path: workspace.recipePath, text: workspace.recipeStatus === "ok" ? 'version: 1\nenv:\n  NODE_ENV: test\n  PROJECT_DIR: "{worktree}"\nsetup:\n  - "npm ci"\nteardown:\n  - "echo Environment released"\n' : "", status: workspace.recipeStatus, errors: [] }]));
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
	else { chat.push({ id: chat.length + 1, role: "user", at: Date.now(), text: command }); if (sessionId === escalation.sessionId) { escalation.resolvedAt = Date.now(); escalation.resolution = "human_replied"; invalidate(["inbox", "state"]); } }
});

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
			if (route === "settings") { if (method === "PUT") { settings = { ...settings, ...body } as SettingsDTO; main.wakesMax = settings.maxAutoWakes; invalidate(["settings", "state"]); } return response(settings); }
			if (route === "main") { main.state = "idle"; main.paused = false; main.wakesUsed = 0; main.pendingNotices = 0; if (id === "new") { const old = sessions.find(session => session.id === main.sessionId); if (old) { old.retired = true; old.state = "cold"; } main.sessionId = `M-${sessions.length + 1}`; sessions.unshift({ ...sessions[0], id: main.sessionId, state: "idle", retired: false, createdAt: Date.now() }); } invalidate(["state", "sessions", "inbox"]); return response(state()); }
			if (route === "inbox") return response({ main, escalations: escalation.resolvedAt === null ? [escalation] : [] });
			if (route === "escalations") { if (action === "seen") escalation.seenAt = Date.now(); else { escalation.resolvedAt = Date.now(); escalation.resolution = "dismissed"; } invalidate(["inbox", "state", "task:T-12"]); return response(escalation); }
			if (route === "tasks") {
				if (!id) return response(tasks.filter(task => (!url.searchParams.get("status") || task.status === url.searchParams.get("status")) && (!url.searchParams.get("workspace") || task.workspace === url.searchParams.get("workspace")) && (!url.searchParams.get("q") || `${task.title} ${task.id} ${task.brief}`.toLowerCase().includes(url.searchParams.get("q")!.toLowerCase()))));
				const task = tasks.find(task => task.id === id); if (!task) return response({ error: "Task not found" }, 404);
				if (method === "POST") {
					if (action === "cancel") { task.status = "cancelled"; task.wait = null; }
					if (action === "message") { task.status = "working"; task.wait = null; if (task.id === escalation.taskId) { escalation.resolvedAt = Date.now(); escalation.resolution = "human_replied"; } }
					if (action === "cleanup") { task.worktreePath = null; if (task.env) task.env.state = "torn_down"; }
					task.updatedAt = Date.now(); task.events.push({ id: Date.now(), at: Date.now(), actor: "human", kind: action ?? "message", summary: text(body, "text") || text(body, "reason") || "Environment torn down; worktree removed; branch retained.", data: body });
					invalidate(["tasks", `task:${id}`, "resources", "state", "inbox"]);
				}
				return response(task);
			}
			if (route === "sessions" && id && action && ["prompt", "abort", "respond", "commands", "history", "subagents"].includes(action)) return response(sessionMock.request(id, action, body, parts, url.searchParams.get("before")));
			if (route === "sessions") { if (!id) return response(sessions); const session = sessions.find(item => item.id === id); if (!session) return response({ error: "Session not found" }, 404); if (action === "attach") session.state = session.state === "cold" ? "idle" : session.state; else { session.state = "cold"; session.pid = null; if (action === "retire") session.retired = true; } if (session.kind === "main") main.state = session.state; invalidate(["sessions", "state", "workspaces"]); return response(session); }
			if (route === "decisions") { if (!id) return response(decisions.filter(item => !url.searchParams.get("task") || item.taskId === url.searchParams.get("task"))); const decision = decisions.find(item => item.id === id); if (!decision) return response({ error: "Decision not found" }, 404); decision.revertRequestedAt = Date.now(); invalidate(["decisions", ...(decision.taskId ? [`task:${decision.taskId}` as Topic] : [])]); return response(decision); }
			if (route === "workspaces") {
				if (id === "scan") return response(["atlas", "console", "notes", "website"].map(name => ({ name, repoPath: `${root}/${name}`, alreadyAdded: workspaces.some(item => item.repoPath === `${root}/${name}`), isGitRepo: true })));
				if (!id && method === "GET") return response(workspaces);
				if (!id) { const repoPath = text(body, "repoPath"); const workspaceId = text(body, "id") || repoPath.split("/").filter(Boolean).at(-1) || "workspace"; if (workspaces.some(item => item.id === workspaceId)) return response({ error: "Workspace already exists" }, 409); const workspace: WorkspaceDTO = { id: workspaceId, name: text(body, "name", workspaceId), repoPath, defaultBase: text(body, "defaultBase", "main"), workerModel: body.workerModel === null ? null : text(body, "workerModel") || null, notesPath: `${home}/repos/${workspaceId}.md`, recipePath: `${home}/repos/${workspaceId}.env.yaml`, recipeStatus: "missing", liveSessions: 0, totalSessions: 0, openTasks: 0, archived: false }; workspaces.push(workspace); invalidate(["workspaces"]); return response(workspace); }
				const workspace = workspaces.find(item => item.id === id); if (!workspace) return response({ error: "Workspace not found" }, 404);
				if (action === "recipe") {
					const recipe = recipes.get(id) ?? { workspace: id, path: workspace.recipePath, text: "", status: "missing", errors: [] };
					if (method === "PUT") { const yaml = text(body, "text"); try { const parsed: unknown = parseYaml(yaml); if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("Recipe must be a YAML mapping."); } catch (error) { return response({ error: "Invalid environment recipe", errors: [{ path: "recipe", message: error instanceof Error ? error.message : String(error) }] }, 422); } recipe.text = yaml; recipe.status = "ok"; workspace.recipeStatus = "ok"; recipes.set(id, recipe); invalidate(["workspaces"]); } return response(recipe);
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
