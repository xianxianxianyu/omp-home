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
 *   GET  /api/models          ?refresh=1    → ModelCatalogDTO    (omp's chat models for the configured omp; refresh re-queries providers)
 *   POST /api/setup           SetupRequest  → StateDTO           (first run; idempotent)
 *   GET  /api/setup/preview   ?home=<path>  → SetupPreview
 *   GET  /api/tasks           ?status&workspace&q → TaskSummary[]  (status=open: pending|working|awaiting; status=closed: done|cancelled)
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
 *   GET  /api/workspaces/:id/recipe/check   → RecipeCheckDTO | null   (latest trial run of the recipe)
 *   POST /api/workspaces/:id/recipe/check {test?} → RecipeCheckDTO   (start a trial run; 409 while one runs; test = one test entry name)
 *   POST /api/workspaces/:id/recipe/check/cancel → RecipeCheckDTO
 *   GET  /api/workspaces/suggestions        → RepoSuggestion[]   (repos named in the home AGENTS.md + git repos you used omp in, newest first)
 *   GET  /api/workspaces/inspect ?path      → RepoInspection     (any folder; resolves to the git root; never writes)
 *   POST /api/pick-folder     {title?, defaultPath?} → { path: string | null }  (macOS folder chooser run by the hub; null = cancelled.
 *                                                      The desktop app uses its native dialog instead.)
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
	endedAt: number | null;
	/** Live progress of the task's worker, for the in-flight list. Null once the task is closed. */
	progress: TaskProgress | null;
}

export interface TaskProgress {
	/** queued: waiting for a pool slot; cold: worker stopped (resumes on demand). */
	phase: "provisioning" | "queued" | "starting" | "running" | "idle" | "approval" | "cold";
	/** Intent of the tool call the worker is running now, else of its most recent one. */
	intent: string | null;
	/** One-line rendering of the latest task event. */
	lastEvent: string | null;
	/** When the current phase began (ms). */
	since: number;
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
	/** Latest recipe trial run, summarised for lists; null = never run. */
	recipeCheck: { state: RecipeCheckDTO["state"]; current: boolean; endedAt: number | null } | null;
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
	/** Environment recipe YAML to write when the workspace has none yet (e.g. RepoInspection.recipeDraft, possibly edited). */
	recipe?: string;
}

export type WorkspacePatch = Partial<Pick<WorkspaceDTO, "name" | "defaultBase" | "workerModel">>;

export interface RepoSuggestion {
	/** Git root. */
	path: string;
	name: string;
	source: "home" | "omp";
	/** Your own omp sessions whose cwd is inside this repo (from omp's session store); 0 for home-only entries. */
	ompSessions: number;
	lastUsedAt: number | null;
	/** Title of the most recent of those sessions, when omp recorded one. */
	lastTitle: string | null;
	/** Workspace id when already registered. */
	registeredAs: string | null;
}

export interface RepoInspection {
	/** The folder as chosen. */
	path: string;
	/** Git root containing it; null when it is not inside a git repository. */
	root: string | null;
	/** Suggested workspace name (root folder name) and id (slug, unique among workspaces). */
	name: string;
	id: string;
	registeredAs: string | null;
	currentBranch: string | null;
	/** Detected default base: origin/HEAD, else main/master/trunk/develop that exists, else the current branch. */
	defaultBase: string | null;
	/** Local branches first (current first), then remote-only ones as "origin/x"; newest commit first within each group; at most 50. */
	branches: { name: string; remote: boolean; current: boolean; lastCommitAt: number | null }[];
	/** `git worktree list` minus the main checkout. */
	worktrees: { path: string; branch: string | null; head: string }[];
	remoteUrl: string | null;
	dirty: boolean;
	omp: { sessions: number; lastUsedAt: number | null; lastTitle: string | null };
	/** Detected toolchain, e.g. ["pnpm", "node"], ["cargo"], ["uv", "python"]. */
	stack: string[];
	/** Detected commands, used for the recipe draft. install is lockfile-strict (npm ci, pnpm --frozen-lockfile, …). */
	commands: { install: string | null; dev: string | null };
	/** Detected checks keyed like recipe `test` entries (typecheck, lint, unit, coverage, full); full chains the fast checks in order. */
	tests: Record<string, string>;
	/** Git-ignored files present in the main checkout that a fresh worktree needs (recipe `copy`), e.g. generated type declarations the tsconfig includes. */
	copy: { path: string; why: "tsconfig" | "env" }[];
	/** A valid environment recipe YAML derived from the above (null when nothing was detected); the repo's existing recipe wins if one exists. */
	recipeDraft: string | null;
	/** True when <home>/repos/<id>.env.yaml already exists for the suggested id. */
	hasRecipe: boolean;
}

/**
 * A trial run of a workspace's recipe in a throwaway worktree at the default base: the same checkout, copy, setup, services
 * and test commands a worker gets, then torn down. A failure here is the base's baseline, not a task's fault.
 */
export interface RecipeCheckDTO {
	workspace: string;
	recipeHash: string;
	/** False once the recipe file changed after this run. */
	current: boolean;
	base: string;
	sha: string;
	state: "running" | "passed" | "failed" | "cancelled";
	startedAt: number;
	endedAt: number | null;
	steps: RecipeCheckStep[];
}

export interface RecipeCheckStep {
	kind: "checkout" | "copy" | "setup" | "services" | "database" | "test" | "teardown";
	/** Test entry name for kind "test"; otherwise a short label (file, service or command index). */
	name: string;
	command: string | null;
	state: "pending" | "running" | "passed" | "failed" | "skipped";
	exitCode: number | null;
	ms: number | null;
	/** Last ~4 KB of output. */
	outputTail: string;
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

/** omp's thinking levels, lowest to highest. A model accepts "off" plus the levels in its ModelDTO.thinking. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THEMES = ["system", "dark", "light"] as const;
export const ACCENTS = ["amber", "blue", "green", "violet", "rose", "graphite"] as const;
export const TEXT_SIZES = ["small", "default", "large"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;

/** UI languages. "system" resolves on the client from the OS/browser language list. */
export const LANGUAGES = ["en", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_SETTINGS = ["system", ...LANGUAGES] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];
/**
 * The client's resolved language, sent on every API request (and as `?lang=` on the events socket). The hub answers
 * human-facing text it authors (errors, field messages, summaries) in it and remembers the last one for pushed toasts.
 * Text written for models (prompts, tool results) stays English.
 */
export const LANGUAGE_HEADER = "x-omp-home-language";

/** The first zh* or en* tag in the user's preference list decides; English otherwise. */
export function resolveLanguage(setting: LanguageSetting, preferred: readonly string[]): Language {
	if (setting !== "system") return setting;
	const first = preferred.map(tag => tag.toLowerCase()).find(tag => tag.startsWith("zh") || tag.startsWith("en"));
	return first?.startsWith("zh") ? "zh" : "en";
}

/** How the UI looks. Stored with the hub settings: the app's page origin changes every launch, so localStorage cannot hold it. */
export interface AppearanceDTO {
	theme: (typeof THEMES)[number];
	accent: (typeof ACCENTS)[number];
	textSize: (typeof TEXT_SIZES)[number];
	density: (typeof DENSITIES)[number];
}

export interface SettingsDTO {
	homePath: string;
	pstackRoot: string | null;
	/** omp model selectors ("provider/id"); null = omp's own default (ModelCatalogDTO.defaultModel). */
	mainModel: string | null;
	mainThinking: ThinkingLevel;
	workerModel: string | null;
	workerThinking: ThinkingLevel;
	dispatcherModel: string | null;
	maxLiveWorkers: number;
	idleEvictMinutes: number;
	maxAutoWakes: number;
	portRange: [number, number];
	worktreeRoot: string | null;
	/** Explicit omp binary; null = managed copy, else PATH. */
	ompPath: string | null;
	appearance: AppearanceDTO;
	language: LanguageSetting;
}

export type SettingsPatch = Partial<Omit<SettingsDTO, "homePath" | "appearance">> & { appearance?: Partial<AppearanceDTO> };

/** One entry of `omp models --json` (chat kind). */
export interface ModelDTO {
	/** What omp's --model takes and what settings store: "provider/id". */
	selector: string;
	provider: string;
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	/** Thinking levels the model supports besides "off"; empty when it has no reasoning. */
	thinking: ThinkingLevel[];
	input: string[];
	/** USD per million tokens; null when omp has no pricing. */
	cost: { input: number; output: number } | null;
}

export interface ModelCatalogDTO {
	models: ModelDTO[];
	/** omp's `modelRoles.default` (selector, thinking suffix stripped), used when a role's model is null. */
	defaultModel: string | null;
	fetchedAt: number;
	/** Set when omp could not list models (omp missing, provider error); models may then be empty. */
	error: string | null;
}

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
