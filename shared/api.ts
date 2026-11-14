/**
 * HTTP + WebSocket contract between the hub and the web UI. The UI imports only this
 * file (and ids.ts); hub internals and wire types stay private.
 *
 * Auth: `Authorization: Bearer <install token>` on HTTP; `?token=` on WebSockets.
 * Errors: non-2xx with `{ error: string, code?: string, errors?: FieldError[] }`.
 *
 * Routes (all JSON):
 *   GET  /api/state                         → StateDTO
 *   GET  /api/settings                      → SettingsDTO
 *   PUT  /api/settings        SettingsPatch → SettingsDTO
 *   POST /api/setup           SetupRequest  → StateDTO           (first run; idempotent)
 *   GET  /api/setup/preview   ?home=<path>  → SetupPreview
 *   GET  /api/tasks           ?status&workspace&q → TaskSummary[]
 *   GET  /api/tasks/:id                     → TaskDetail
 *   POST /api/tasks/:id/cancel  {reason}    → TaskDetail
 *   POST /api/tasks/:id/cleanup             → TaskDetail         (human only: env teardown, worktree removal, branch kept)
 *   POST /api/tasks/:id/message {text}      → TaskDetail         (human message to the worker, counts as human input)
 *   GET  /api/chat            ?before&after&limit → ChatRecordDTO[]  (before/after: exclusive chat_record ids; limit default 50, max 200;
 *                                                   ascending by id; no before/after → newest; before+after both → error 400)
 *   GET  /api/search          ?q&scope      → SearchHit[]
 *   GET  /api/sessions                      → SessionDTO[]
 *   POST /api/sessions/:id/attach           → SessionDTO         (start if cold; may exceed the cap by one)
 *   POST /api/sessions/:id/evict            → SessionDTO
 *   POST /api/sessions/:id/retire           → SessionDTO
 *   POST /api/sessions/:id/prompt  PromptRequest → { ok: true }  (start if cold; main-chat prompts count as human input)
 *   POST /api/sessions/:id/abort            → { ok: true }
 *   POST /api/sessions/:id/respond RespondRequest → { ok: true }  (answer a pending `request` item)
 *   GET  /api/sessions/:id/commands         → CommandDTO[]      (slash commands for the composer)
 *   GET  /api/sessions/:id/history ?before=<cursor> → TranscriptEvent of kind "prepend"
 *   POST /api/sessions/:id/subagents/:agentId/steer {text} → { ok: true }
 *   POST /api/sessions/:id/subagents/:agentId/cancel      → { ok: true }
 *   POST /api/main/restart                  → StateDTO
 *   POST /api/main/new                      → StateDTO           (retire the main chat, start a fresh one)
 *   POST /api/main/continue                 → StateDTO           (human "let main continue": resets the wake budget)
 *   GET  /api/inbox                         → InboxDTO
 *   POST /api/escalations/:id/seen          → EscalationDTO
 *   POST /api/escalations/:id/dismiss       → EscalationDTO
 *   GET  /api/decisions       ?task         → DecisionDTO[]
 *   POST /api/decisions/:id/revert          → DecisionDTO
 *   GET  /api/workspaces                    → WorkspaceDTO[]
 *   POST /api/workspaces      WorkspaceCreate → WorkspaceDTO
 *   PATCH /api/workspaces/:id WorkspacePatch → WorkspaceDTO
 *   POST /api/workspaces/:id/archive        → WorkspaceDTO
 *   GET  /api/workspaces/:id/recipe         → RecipeDTO
 *   PUT  /api/workspaces/:id/recipe {text}  → RecipeDTO          (422 with errors when invalid)
 *   POST /api/workspaces/scan               → ScanCandidate[]    (repo paths named in the home AGENTS.md)
 *   GET  /api/resources                     → ResourcesDTO
 *   POST /api/services/:id/start | /stop | /check → ServiceDTO
 *   POST /api/leases/:id/release            → LeaseDTO
 *
 * WebSockets:
 *   /api/events   server → client JSON UiEvent; the client re-fetches the named topics over HTTP.
 *   /api/sessions/:id/stream  server → client JSON TranscriptEvent (`reset` first, then increments); starts the session if cold.
 */
import type { UiResponse } from "./transcript.ts";
import type { CheckoutSpec } from "./tools.ts";

export type TaskStatus = "pending" | "working" | "awaiting" | "done" | "cancelled";
export type WaitKind = "question" | "blocked" | "no_report" | "aborted" | "error" | "approval" | "interrupted" | "provision_failed";
export type ProcState = "cold" | "starting" | "idle" | "running" | "approval" | "stopping";
export type Actor = "main" | "dispatcher" | "worker" | "human" | "hub";

export interface FieldError {
	path: string;
	message: string;
}

export interface TaskSummary {
	id: string;
	title: string;
	workspace: string;
	status: TaskStatus;
	wait: { kind: WaitKind; text: string } | null;
	sessionId: string | null;
	branch: string | null;
	playbook: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface TaskEventDTO {
	id: number;
	at: number;
	actor: Actor;
	kind: string;
	/** One-line human-readable rendering of the event. */
	summary: string;
	data: Record<string, unknown>;
}

export interface ReportDTO {
	at: number;
	status: "done" | "blocked" | "question" | "progress";
	summary: string;
	details: string | null;
}

export interface TaskDetail extends TaskSummary {
	brief: string;
	envelope: string | null;
	checkout: CheckoutSpec;
	worktreePath: string | null;
	related: string[];
	reports: ReportDTO[];
	events: TaskEventDTO[];
	decisions: DecisionDTO[];
	escalations: EscalationDTO[];
	git: { dirty: boolean; ahead: number; head: string } | null;
	env: EnvDTO | null;
}

export interface SessionDTO {
	id: string;
	kind: "main" | "worker";
	workspace: string | null;
	worktreePath: string | null;
	branch: string | null;
	cwd: string;
	model: string;
	state: ProcState;
	pid: number | null;
	rssMb: number | null;
	lastActivity: number | null;
	openTask: { id: string; title: string; status: TaskStatus } | null;
	retired: boolean;
	createdAt: number;
}

export interface WorkspaceDTO {
	id: string;
	name: string;
	repoPath: string;
	defaultBase: string;
	workerModel: string | null;
	notesPath: string;
	recipePath: string;
	recipeStatus: "missing" | "ok" | "invalid";
	liveSessions: number;
	totalSessions: number;
	openTasks: number;
	archived: boolean;
}

export interface WorkspaceCreate {
	repoPath: string;
	name?: string;
	id?: string;
	defaultBase?: string;
	workerModel?: string | null;
}

export type WorkspacePatch = Partial<Pick<WorkspaceDTO, "name" | "defaultBase" | "workerModel">>;

export interface ScanCandidate {
	repoPath: string;
	name: string;
	alreadyAdded: boolean;
	isGitRepo: boolean;
}

export interface RecipeDTO {
	workspace: string;
	path: string;
	text: string;
	status: "missing" | "ok" | "invalid";
	errors: FieldError[];
}

export interface DecisionDTO {
	id: string;
	taskId: string | null;
	at: number;
	summary: string;
	why: string;
	revert: string;
	reverts: string | null;
	revertRequestedAt: number | null;
	revertedBy: string | null;
}

export interface EscalationDTO {
	id: string;
	taskId: string;
	taskTitle: string;
	sessionId: string;
	reason: string;
	openedBy: "main" | "hub";
	openedAt: number;
	seenAt: number | null;
	resolvedAt: number | null;
	resolution: "human_replied" | "task_moved" | "dismissed" | null;
}

export interface InboxDTO {
	escalations: EscalationDTO[];
	main: MainDTO;
}

export interface EnvDTO {
	worktreeId: string;
	worktreePath: string;
	workspace: string;
	state: "preparing" | "ready" | "failed" | "torn_down";
	error: string | null;
	vars: Record<string, string>;
	updatedAt: number;
}

export interface ServiceDTO {
	id: string;
	workspace: string;
	name: string;
	kind: "external" | "run";
	state: "down" | "starting" | "up" | "failed";
	pid: number | null;
	checkedAt: number | null;
	error: string | null;
	logTail: string;
}

export interface LeaseDTO {
	id: number;
	kind: "port" | "db" | "account";
	key: string;
	label: string;
	holderKind: "worktree" | "session" | "service";
	holderId: string;
	acquiredAt: number;
	expiresAt: number | null;
}

export interface ResourcesDTO {
	services: ServiceDTO[];
	leases: LeaseDTO[];
	environments: EnvDTO[];
}

export interface MainDTO {
	sessionId: string | null;
	state: ProcState;
	wakesUsed: number;
	wakesMax: number;
	/** Urgent notices were delivered without waking main because the budget ran out. */
	paused: boolean;
	pendingNotices: number;
}

/** The omp binary the hub spawns. */
export interface OmpDTO {
	version: string | null;
	path: string | null;
	/** The hub-managed copy under <configDir>/omp/<version>/omp (not the user's PATH binary). */
	managed: boolean;
	/** omp missing, or the PATH omp failed the compatibility self-check and an older managed copy stays in use. */
	warning: string | null;
}

export interface StateDTO {
	version: string;
	setup: { done: boolean; homePath: string | null };
	main: MainDTO;
	pool: { live: number; cap: number };
	inboxOpen: number;
	openTasks: number;
	omp: OmpDTO;
}

export interface SettingsDTO {
	homePath: string;
	pstackRoot: string | null;
	mainModel: string | null;
	mainThinking: string;
	workerModel: string | null;
	workerThinking: string;
	dispatcherModel: string | null;
	maxLiveWorkers: number;
	idleEvictMinutes: number;
	maxAutoWakes: number;
	portRange: [number, number];
	worktreeRoot: string | null;
	/** Explicit omp binary; null = managed copy, else PATH. */
	ompPath: string | null;
}

export type SettingsPatch = Partial<Omit<SettingsDTO, "homePath">>;

export interface SetupPreview {
	homePath: string;
	exists: boolean;
	isGitRepo: boolean;
	/** Files setup will create or replace in the home repo, with a short reason each. */
	changes: { path: string; action: "create" | "replace" | "backup"; reason: string }[];
	pstackCandidates: string[];
}

export interface SetupRequest {
	homePath: string;
	pstackRoot: string | null;
	migrateHome: boolean;
}

export interface SearchHit {
	ref: string;
	kind: "chat" | "brief" | "report" | "run_text" | "decision";
	at: number;
	taskId: string | null;
	title: string | null;
	excerpt: string;
}

export interface ChatRecordDTO {
	id: number;
	role: "user" | "assistant" | "notice";
	text: string;
	at: number;
}

export type Topic = "state" | "tasks" | "sessions" | "inbox" | "decisions" | "workspaces" | "resources" | "settings" | `task:${string}`;

export type UiEvent =
	| { t: "invalidate"; topics: Topic[] }
	| { t: "focus"; sessionId: string; escalationId: string | null; reason: string }
	| { t: "toast"; level: "info" | "error"; text: string };

export interface PromptRequest {
	text: string;
	/** auto: start a turn when idle, otherwise follow up after the current one. steer: inject into the running turn. */
	mode?: "auto" | "steer" | "followUp";
}

export interface RespondRequest {
	requestId: string;
	response: UiResponse;
}

export interface CommandDTO {
	name: string;
	description: string | null;
	source: string | null;
}
