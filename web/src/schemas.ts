import { z } from "zod";
import { ACCENTS, DENSITIES, LANGUAGE_SETTINGS, TEXT_SIZES, THEMES, THINKING_LEVELS } from "../../shared/api.ts";
import { commands, historyPage } from "./transcript-schema.ts";

const nullableText = z.string().nullable();
const status = z.enum(["pending", "working", "awaiting", "done", "cancelled"]);
const proc = z.enum(["cold", "starting", "idle", "running", "approval", "stopping"]);
export const fieldError = z.object({ path: z.string(), message: z.string() });
const task = z.object({ id: z.string(), title: z.string(), workspace: z.string(), status, wait: z.object({ kind: z.enum(["question", "blocked", "no_report", "aborted", "error", "approval", "interrupted", "provision_failed"]), text: z.string() }).nullable(), sessionId: nullableText, branch: nullableText, playbook: nullableText, createdAt: z.number(), updatedAt: z.number(), endedAt: z.number().nullable(), progress: z.object({ phase: z.enum(["provisioning", "queued", "starting", "running", "idle", "approval", "cold"]), intent: nullableText, lastEvent: nullableText, since: z.number() }).nullable() });
const main = z.object({ sessionId: nullableText, state: proc, wakesUsed: z.number(), wakesMax: z.number(), paused: z.boolean(), pendingNotices: z.number() });
const state = z.object({ version: z.string(), omp: z.object({ version: nullableText, path: nullableText, managed: z.boolean(), warning: nullableText }), setup: z.object({ done: z.boolean(), homePath: nullableText }), main, pool: z.object({ live: z.number(), cap: z.number() }), inboxOpen: z.number(), openTasks: z.number() });
const session = z.object({ id: z.string(), kind: z.enum(["main", "worker"]), workspace: nullableText, worktreePath: nullableText, branch: nullableText, cwd: z.string(), model: z.string(), state: proc, pid: z.number().nullable(), rssMb: z.number().nullable(), lastActivity: z.number().nullable(), openTask: z.object({ id: z.string(), title: z.string(), status }).nullable(), retired: z.boolean(), createdAt: z.number() });
const workspace = z.object({ id: z.string(), name: z.string(), repoPath: z.string(), defaultBase: z.string(), workerModel: nullableText, notesPath: z.string(), recipePath: z.string(), recipeStatus: z.enum(["missing", "ok", "invalid"]), liveSessions: z.number(), totalSessions: z.number(), openTasks: z.number(), archived: z.boolean() });
const decision = z.object({ id: z.string(), taskId: nullableText, at: z.number(), summary: z.string(), why: z.string(), revert: z.string(), reverts: nullableText, revertRequestedAt: z.number().nullable(), revertedBy: nullableText });
const escalation = z.object({ id: z.string(), taskId: z.string(), taskTitle: z.string(), sessionId: z.string(), reason: z.string(), openedBy: z.enum(["main", "hub"]), openedAt: z.number(), seenAt: z.number().nullable(), resolvedAt: z.number().nullable(), resolution: z.enum(["human_replied", "task_moved", "dismissed"]).nullable() });
const environment = z.object({ worktreeId: z.string(), worktreePath: z.string(), workspace: z.string(), state: z.enum(["preparing", "ready", "failed", "torn_down"]), error: nullableText, vars: z.record(z.string(), z.string()), updatedAt: z.number() });
const service = z.object({ id: z.string(), workspace: z.string(), name: z.string(), kind: z.enum(["external", "run"]), state: z.enum(["down", "starting", "up", "failed"]), pid: z.number().nullable(), checkedAt: z.number().nullable(), error: nullableText, logTail: z.string() });
const lease = z.object({ id: z.number(), kind: z.enum(["port", "db", "account"]), key: z.string(), label: z.string(), holderKind: z.enum(["worktree", "session", "service"]), holderId: z.string(), acquiredAt: z.number(), expiresAt: z.number().nullable() });
const detail = task.extend({ brief: z.string(), envelope: nullableText, checkout: z.discriminatedUnion("kind", [z.object({ kind: z.literal("worktree"), base: z.string().optional(), branch: z.string().optional() }), z.object({ kind: z.literal("continue"), task: z.string(), session: z.enum(["reuse", "fresh"]) }), z.object({ kind: z.literal("readonly") })]), worktreePath: nullableText, related: z.array(z.string()), reports: z.array(z.object({ at: z.number(), status: z.enum(["done", "blocked", "question", "progress"]), summary: z.string(), details: nullableText })), events: z.array(z.object({ id: z.number(), at: z.number(), actor: z.enum(["main", "dispatcher", "worker", "human", "hub"]), kind: z.string(), summary: z.string(), data: z.record(z.string(), z.unknown()) })), decisions: z.array(decision), escalations: z.array(escalation), git: z.object({ dirty: z.boolean(), ahead: z.number(), head: z.string() }).nullable(), env: environment.nullable() });
export const appearance = z.object({ theme: z.enum(THEMES), accent: z.enum(ACCENTS), textSize: z.enum(TEXT_SIZES), density: z.enum(DENSITIES) });
const settings = z.object({ homePath: z.string(), ompPath: nullableText, pstackRoot: nullableText, mainModel: nullableText, mainThinking: z.enum(THINKING_LEVELS), workerModel: nullableText, workerThinking: z.enum(THINKING_LEVELS), dispatcherModel: nullableText, maxLiveWorkers: z.number(), idleEvictMinutes: z.number(), maxAutoWakes: z.number(), portRange: z.tuple([z.number(), z.number()]), worktreeRoot: nullableText, appearance, language: z.enum(LANGUAGE_SETTINGS) });
const modelCatalog = z.object({ models: z.array(z.object({ selector: z.string(), provider: z.string(), id: z.string(), name: z.string(), contextWindow: z.number().nullable(), maxTokens: z.number().nullable(), reasoning: z.boolean(), thinking: z.array(z.enum(THINKING_LEVELS)), input: z.array(z.string()), cost: z.object({ input: z.number(), output: z.number() }).nullable() })), defaultModel: nullableText, fetchedAt: z.number(), error: nullableText });
const recipe = z.object({ workspace: z.string(), path: z.string(), text: z.string(), status: z.enum(["missing", "ok", "invalid"]), errors: z.array(fieldError) });
const repoSuggestion = z.object({ path: z.string(), name: z.string(), source: z.enum(["home", "omp"]), ompSessions: z.number(), lastUsedAt: z.number().nullable(), lastTitle: nullableText, registeredAs: nullableText });
const repoInspection = z.object({
	path: z.string(), root: nullableText, name: z.string(), id: z.string(), registeredAs: nullableText,
	currentBranch: nullableText, defaultBase: nullableText,
	branches: z.array(z.object({ name: z.string(), remote: z.boolean(), current: z.boolean(), lastCommitAt: z.number().nullable() })),
	worktrees: z.array(z.object({ path: z.string(), branch: nullableText, head: z.string() })),
	remoteUrl: nullableText, dirty: z.boolean(),
	omp: z.object({ sessions: z.number(), lastUsedAt: z.number().nullable(), lastTitle: nullableText }),
	stack: z.array(z.string()), commands: z.object({ install: nullableText, test: nullableText, dev: nullableText }),
	recipeDraft: nullableText, hasRecipe: z.boolean(),
});
const topic = z.union([z.enum(["state", "tasks", "sessions", "inbox", "decisions", "workspaces", "resources", "settings"]), z.templateLiteral(["task:", z.string()])]);
export const uiEvent = z.discriminatedUnion("t", [z.object({ t: z.literal("invalidate"), topics: z.array(topic) }), z.object({ t: z.literal("focus"), sessionId: z.string(), escalationId: nullableText, reason: z.string() }), z.object({ t: z.literal("toast"), level: z.enum(["info", "error"]), text: z.string() })]);

export function parseResponse(path: string, data: unknown): unknown {
	const p = new URL(path, location.origin).pathname;
	let schema: z.ZodType;
	if (p === "/api/state" || p === "/api/setup" || p.startsWith("/api/main/")) schema = state;
	else if (p === "/api/setup/preview") schema = z.object({ homePath: z.string(), exists: z.boolean(), isGitRepo: z.boolean(), changes: z.array(z.object({ path: z.string(), action: z.enum(["create", "replace", "backup"]), reason: z.string() })), pstackCandidates: z.array(z.string()) });
	else if (p === "/api/settings") schema = settings;
	else if (p === "/api/models") schema = modelCatalog;
	else if (p === "/api/tasks") schema = z.array(task);
	else if (p.startsWith("/api/tasks/")) schema = detail;
	else if (p === "/api/sessions") schema = z.array(session);
	else if (/^\/api\/sessions\/[^/]+\/commands$/.test(p)) schema = commands;
	else if (/^\/api\/sessions\/[^/]+\/history$/.test(p)) schema = historyPage;
	else if (/^\/api\/sessions\/[^/]+\/(prompt|abort|respond|subagents\/[^/]+\/(steer|cancel))$/.test(p)) schema = z.object({ ok: z.literal(true) });
	else if (p.startsWith("/api/sessions/")) schema = session;
	else if (p === "/api/inbox") schema = z.object({ escalations: z.array(escalation), main });
	else if (p.startsWith("/api/escalations/")) schema = escalation;
	else if (p === "/api/decisions") schema = z.array(decision);
	else if (p.startsWith("/api/decisions/")) schema = decision;
	else if (p === "/api/pick-folder") schema = z.object({ path: nullableText });
	else if (p === "/api/workspaces/suggestions") schema = z.array(repoSuggestion);
	else if (p === "/api/workspaces/inspect") schema = repoInspection;
	else if (p.endsWith("/recipe")) schema = recipe;
	else if (p === "/api/workspaces") schema = Array.isArray(data) ? z.array(workspace) : workspace;
	else if (p.startsWith("/api/workspaces/")) schema = workspace;
	else if (p === "/api/resources") schema = z.object({ services: z.array(service), leases: z.array(lease), environments: z.array(environment) });
	else if (p.startsWith("/api/services/")) schema = service;
	else if (p.startsWith("/api/leases/")) schema = lease;
	else if (p === "/api/search") schema = z.array(z.object({ ref: z.string(), kind: z.enum(["chat", "brief", "report", "run_text", "decision"]), at: z.number(), taskId: nullableText, title: nullableText, excerpt: z.string() }));
	else if (p === "/api/chat") schema = z.array(z.object({ id: z.number(), role: z.enum(["user", "assistant", "notice"]), text: z.string(), at: z.number() }));
	else throw new Error(`Unknown API route: ${p}`);
	return schema.parse(data);
}
