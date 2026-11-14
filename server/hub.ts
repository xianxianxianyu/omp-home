import { execFile } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { CommandDTO, DecisionDTO, EscalationDTO, InboxDTO, Language, PromptRequest, SessionDTO, StateDTO, TaskDetail, TaskProgress, TaskSummary, Topic } from "../shared/api.ts";
import type { BridgeToHub } from "../shared/bridge-wire.ts";
import type { CheckoutSpec } from "../shared/tools.ts";
import type { TranscriptEvent, UiResponse } from "../shared/transcript.ts";
import { Bridge, type CallFrame, type CallResult } from "./bridge.ts";
import { homePaths, type HomePaths } from "./config.ts";
import { progressPhase } from "./core/task.ts";
import { Db } from "./db.ts";
import { Env } from "./env.ts";
import { errorMessage, errorText, HubError } from "./errors.ts";
import { messages, render, type Message } from "./i18n.ts";
import { Indexer } from "./indexer.ts";
import { Ledger, waitOf, type ApplyResult, type DecisionRow, type EscalationRow, type TaskRow } from "./ledger.ts";
import { Notifier } from "./notify.ts";
import type { OmpManager } from "./omp.ts";
import { Pool, type ExitInfo, type SessionRow } from "./pool.ts";
import { ProgressWatch } from "./progress-watch.ts";
import { Provisioner } from "./provisioner.ts";
import { RecipeChecks } from "./recipe-check.ts";
import type { Resources } from "./resources.ts";
import { RpcError, type RpcFrame } from "./rpc.ts";
import { SessionViews } from "./session-views.ts";
import { generatePstackPackage } from "./pstack.ts";
import { SettingsStore } from "./settings.ts";
import { createTools } from "./tools.ts";
import { answerEvent, responseFits } from "./transcript.ts";
import type { UiChannel } from "./ui.ts";
import { Workspaces, type WorkspaceRow } from "./workspaces.ts";
import { WorktreeLifecycle, Worktrees } from "./worktrees.ts";

export interface HubOptions {
	home: string;
	resources: Resources;
	omp: OmpManager;
	port: number;
	ui: UiChannel;
	log(message: string): void;
}

const TICK_MS = 30_000;
const SWEEP_MS = 5 * 60_000;

/**
 * Composition root for one home: owns every module and is the one place where a
 * bridge event or a cross-owner action is routed to the owners it touches.
 */
export class Hub {
	readonly home: string;
	readonly paths: HomePaths;
	readonly db: Db;
	readonly settings: SettingsStore;
	readonly ledger: Ledger;
	readonly indexer: Indexer;
	readonly workspaces: Workspaces;
	readonly worktrees: Worktrees;
	readonly lifecycle: WorktreeLifecycle;
	readonly env: Env;
	readonly recipeChecks: RecipeChecks;
	readonly pool: Pool;
	readonly bridge: Bridge;
	readonly notifier: Notifier;
	readonly provisioner: Provisioner;
	readonly views: SessionViews;
	readonly omp: OmpManager;
	readonly #progress = new ProgressWatch(taskId => this.changed("tasks", `task:${taskId}`));
	readonly #ui: UiChannel;
	readonly #log: (message: string) => void;
	readonly #callTool: (session: SessionRow, frame: CallFrame) => Promise<CallResult>;
	#tick: NodeJS.Timeout | undefined;
	#sweepTimer: NodeJS.Timeout | undefined;
	#stopping = false;

	constructor(opts: HubOptions) {
		this.home = opts.home;
		this.paths = homePaths(opts.home);
		this.#ui = opts.ui;
		this.#log = opts.log;
		this.omp = opts.omp;
		this.views = new SessionViews((id, level, text) => this.#ui.toast(level, `${id}: ${render(text, this.#ui.language.lastSeen)}`));
		this.db = new Db(this.paths.db);
		this.settings = new SettingsStore(this.db, this.paths);
		this.ledger = new Ledger(this.db);
		this.indexer = new Indexer(this.db);
		this.workspaces = new Workspaces(this.db, this.paths, () => this.settings.get().worktreeRoot, id => this.recipeChecks.summary(id));
		this.worktrees = new Worktrees(this.db);
		this.env = new Env(this.db, this.paths, this.settings, this.workspaces, this.worktrees, () => this.changed("resources"));
		this.recipeChecks = new RecipeChecks(this.db, this.paths, this.settings, this.workspaces, this.env, () => this.changed("workspaces", "resources"));
		this.pool = new Pool({
			db: this.db,
			paths: this.paths,
			settings: this.settings,
			workspaces: this.workspaces,
			resources: opts.resources,
			ompBin: () => this.omp.bin(),
			bridgeUrl: `ws://127.0.0.1:${opts.port}/bridge`,
			envVars: wt => this.env.varsOf(wt),
			hasOpenEscalation: id => !!this.db.get("SELECT 1 FROM escalation WHERE session_id = ? AND resolved_at IS NULL", id),
			hadOpenRun: id => this.ledger.latestForSession(id)?.run_open === 1,
			viewers: id => this.views.subscribers(id),
			seeded: (id, seed) => this.views.seed(id, seed),
			frame: (id, frame) => this.#onRpcFrame(id, frame),
			ready: id => {
				this.bridge.flush(id);
				if (this.pool.currentMain()?.id === id) this.notifier.evaluate();
			},
			log: this.#log,
			exited: (session, info) => this.#onExit(session, info),
			changed: () => {
				this.changed("sessions", "state");
				this.#watchOpenTasks();
			},
			mainFailed: message => {
				this.#ui.toast("error", message);
				this.changed("state", "inbox");
			},
		});
		this.lifecycle = new WorktreeLifecycle({
			db: this.db,
			worktrees: this.worktrees,
			ledger: this.ledger,
			pool: this.pool,
			env: this.env,
			workspaces: this.workspaces,
			settings: this.settings,
			applied: (taskId, r) => this.afterApply(taskId, r),
			changed: (...topics) => this.changed(...topics),
			log: this.#log,
		});
		this.#callTool = createTools(this);
		this.bridge = new Bridge({
			pool: this.pool,
			ledger: this.ledger,
			onFrame: (session, frame) => this.#onFrame(session, frame),
			onCall: (session, frame) => this.#callTool(session, frame),
			log: this.#log,
		});
		this.notifier = new Notifier({ ledger: this.ledger, pool: this.pool, bridge: this.bridge, settings: this.settings, changed: () => this.changed("state", "inbox") });
		this.provisioner = new Provisioner({
			db: this.db,
			ledger: this.ledger,
			workspaces: this.workspaces,
			lifecycle: this.lifecycle,
			env: this.env,
			pool: this.pool,
			settings: this.settings,
			flush: id => this.bridge.flush(id),
			changed: taskId => {
				this.notifier.evaluate();
				this.changed("tasks", `task:${taskId}`, "state", "sessions");
			},
			log: this.#log,
		});
	}

	/** Startup reconciliation, in order; each step is idempotent. Then start the main chat. */
	async start(): Promise<void> {
		this.settings.writeOverlays();
		generatePstackPackage(this.settings.get().pstackRoot, this.paths.pstackPackage);
		await this.pool.reconcile();
		for (const task of this.ledger.runningTasks()) {
			if (!task.session_id) continue;
			const session = this.pool.must(task.session_id);
			const reasonMessage = messages.hubRestarted();
			const r = this.ledger.apply(task.id, { kind: "process_lost", reason: reasonMessage.en, reasonMessage }, "hub", `lost:${session.id}:${session.incarnation}`);
			this.afterApply(task.id, r);
		}
		this.db.run("UPDATE lease SET released_at = ? WHERE holder_kind = 'session' AND released_at IS NULL", Date.now());
		this.env.releaseExpired();
		await this.recipeChecks.reconcile();
		const main = this.pool.currentMain() ?? this.pool.create({ kind: "main", workspaceId: null, worktreeId: null, cwd: this.home });
		this.pool.ensureLive(main.id, { human: false });
		for (const { session_id } of this.db.all<{ session_id: string }>(
			"SELECT DISTINCT o.session_id FROM outbox o JOIN session s ON s.id = o.session_id WHERE o.acked_at IS NULL AND s.retired_at IS NULL AND s.kind = 'worker'",
		)) {
			this.pool.ensureLive(session_id, { human: false });
		}
		this.provisioner.kick();
		this.lifecycle.resume();
		this.#sweepTimer = setInterval(() => this.lifecycle.kick(), SWEEP_MS);
		this.notifier.evaluate();
		this.#tick = setInterval(() => {
			this.env.releaseExpired();
			this.notifier.evaluate();
			void this.pool.tick().catch(err => this.#log(`pool tick: ${errorText(err)}`));
		}, TICK_MS);
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		clearInterval(this.#tick);
		clearInterval(this.#sweepTimer);
		this.notifier.stop();
		this.#progress.stop();
		await Promise.race([Promise.all([this.provisioner.idle(), this.lifecycle.idle()]), sleep(5000)]);
		await Promise.all([this.recipeChecks.stop(), this.pool.stopAll()]);
		this.bridge.closeAll();
		this.db.close();
	}

	changed(...topics: Topic[]): void {
		this.#ui.invalidate(...topics);
	}

	log(message: string): void {
		this.#log(message);
	}

	// ── bridge events: the one place "event X → owners A, B" ────────────────

	#onFrame(session: SessionRow, frame: Exclude<BridgeToHub, CallFrame>): void {
		const id = session.id;
		const isMain = session.kind === "main";
		const task = isMain ? undefined : this.ledger.latestForSession(id);
		switch (frame.t) {
			case "hello":
				this.pool.onHello(id, frame);
				return;
			case "run_start":
				this.pool.onRun(id, "start");
				if (isMain) this.notifier.mainRunChanged();
				else if (task) this.afterApply(task.id, this.ledger.apply(task.id, { kind: "run_started", seq: frame.seq }, "worker", `runstart:${id}:${this.pool.must(id).incarnation}:${frame.seq}`));
				return;
			case "run_end": {
				this.pool.onRun(id, "end", frame.asyncJobs);
				if (!isMain) {
					this.env.releaseSession(id);
					if (task) {
						const key = `run:${id}:${this.pool.must(id).incarnation}:${frame.seq}`;
						const r = this.ledger.apply(task.id, { kind: "run_ended", seq: frame.seq, stop: frame.stop, text: frame.text, error: frame.error ?? null }, "worker", key);
						if (r.applied) this.indexer.runText(task, `${task.id}#${key}`, Date.now(), frame.text);
						this.afterApply(task.id, r);
					}
					this.bridge.flush(id);
					this.notifier.evaluate();
				} else {
					this.notifier.mainRunChanged();
				}
				return;
			}
			case "input":
				this.#humanInput(session, frame.text);
				return;
			case "capture":
				if (isMain) {
					this.indexer.capture(id, frame);
				}
				return;
			case "approval":
				this.pool.onApproval(id, frame.phase === "requested");
				if (task) {
					const event = frame.phase === "requested" ? { kind: "approval_requested" as const, tool: frame.tool, summary: frame.summary } : { kind: "approval_resolved" as const, approved: frame.approved };
					this.afterApply(task.id, this.ledger.apply(task.id, event, frame.phase === "requested" ? "worker" : "human"));
				}
				return;
			case "blocked":
				if (task) this.afterApply(task.id, this.ledger.apply(task.id, { kind: "policy_blocked", tool: frame.tool, reason: frame.reason, command: frame.command }, "hub"));
				return;
			case "delivered": {
				const acked = this.ledger.ack(frame.outboxId, id);
				if (!acked) return;
				if (acked.result && acked.row.task_id) this.afterApply(acked.row.task_id, acked.result);
				if (acked.row.deliver === "wake") this.notifier.wakeAcked();
				if (acked.row.kind === "notice") {
					this.notifier.evaluate();
					this.changed("state", "inbox");
				}
				return;
			}
		}
	}

	/** RPC frames feed the session's view; a finished run also refreshes model and context usage. */
	#onRpcFrame(id: string, frame: RpcFrame): void {
		this.views.frame(id, frame);
		if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") {
			const task = this.ledger.openForSession(id);
			if (task) this.#progress.observe(task.id, this.progressOf(task));
		}
		if (frame.type === "agent_end" || frame.type === "model_changed") {
			void this.pool
				.client(id)
				.then(rpc => rpc.request("get_state"))
				.then(state => this.views.state(id, state))
				.catch(err => this.#log(`${id}: get_state failed: ${errorText(err)}`));
		}
	}

	/** The human talked to a session: main resets its wake budget; a worker's task reopens and its escalation closes. */
	#humanInput(session: SessionRow, text: string): void {
		if (session.kind === "main") {
			this.ledger.noteHumanInput();
			this.changed("state", "inbox");
			this.notifier.evaluate();
			return;
		}
		const task = this.ledger.latestForSession(session.id);
		if (task) this.afterApply(task.id, this.ledger.apply(task.id, { kind: "human_input", text }, "human"));
	}

	#onExit(session: SessionRow, info: ExitInfo): void {
		this.views.ended(session.id);
		this.env.releaseSession(session.id);
		if (session.kind === "main") {
			this.notifier.evaluate();
			return;
		}
		if (this.#stopping) return;
		const task = this.ledger.latestForSession(session.id);
		if (!task) return;
		if (info.neverConnected && task.status === "pending") {
			const messageText = messages.spawnExited(info.exitCode, info.detailText ?? info.detail.slice(-1500));
			const r = this.ledger.apply(
				task.id,
				{ kind: "provision_failed", step: "session", message: messageText.en, messageText },
				"hub",
				`spawnfail:${session.id}:${info.incarnation}`,
			);
			this.afterApply(task.id, r);
			return;
		}
		if (!info.intentional || info.wasRunning) {
			const reasonMessage = info.intentional ? messages.workerStopped() : messages.workerExited(info.exitCode);
			this.afterApply(task.id, this.ledger.apply(task.id, { kind: "process_lost", reason: reasonMessage.en, reasonMessage }, "hub", `lost:${session.id}:${info.incarnation}`));
		}
	}

	/** Side effects every ledger change shares: focus escalations the hub opened, re-run notices, refresh UIs. */
	afterApply(taskId: string, r: ApplyResult): void {
		if (!r.applied) return;
		for (const e of r.opened) this.#focus(e);
		if (r.notices.length) this.notifier.evaluate();
		this.changed("tasks", `task:${taskId}`, "state", "inbox", "sessions");
		const task = this.ledger.mustTask(taskId);
		this.#progress.observe(taskId, this.progressOf(task));
		// A task that just settled may let the hub retire its branch.
		if (r.after.settled && !r.before.settled && task.worktree_id) this.lifecycle.kick(task.workspace_id);
	}

	/** A process state changed somewhere: open tasks whose worker phase moved refresh the in-flight list. */
	#watchOpenTasks(): void {
		const open = this.ledger.listTasks({ status: "open" });
		this.#progress.retain(new Set(open.map(t => t.id)));
		for (const task of open) this.#progress.observe(task.id, this.progressOf(task));
	}

	#focus(e: EscalationRow): boolean {
		let started = true;
		try {
			this.pool.ensureLive(e.session_id, { human: true });
		} catch (err) {
			if (!(err instanceof HubError)) throw err;
			started = false;
		}
		const language = this.#ui.language.lastSeen;
		const reason = this.ledger.escalationDTO(e, language).reason;
		this.#ui.send({ t: "focus", sessionId: e.session_id, escalationId: e.id, reason });
		if (this.#ui.clients === 0) {
			const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ").slice(0, 200)}"`;
			execFile("osascript", ["-e", `display notification ${quote(reason)} with title ${quote(render(messages.needsAttention(e.task_id), language))}`], () => {});
		}
		this.changed("inbox", "state", "sessions");
		return started;
	}

	// ── cross-owner actions (tools and HTTP share these) ────────────────────

	/** home_dispatch: check the checkout against git, then claim the branch and create the task in one transaction. */
	async dispatchTask(input: {
		title: string;
		workspace: WorkspaceRow;
		checkout: CheckoutSpec;
		playbook: string | null;
		brief: string;
		related: string[];
		dispatchKey: string;
	}): Promise<{ task: TaskRow; created: boolean; where: string }> {
		const existing = this.ledger.dispatched(input.dispatchKey);
		if (existing) return { task: existing, created: false, where: "" };
		const ws = input.workspace;
		const target = await this.lifecycle.resolve(ws, input.checkout);
		const { task, created } = this.db.tx(() => {
			const again = this.ledger.dispatched(input.dispatchKey);
			if (again) return { task: again, created: false };
			const wt = target.lane === "branch" ? this.lifecycle.claim(ws, target) : null;
			return this.ledger.createTask({
				title: input.title,
				workspaceId: ws.id,
				checkout: target.spec,
				worktreeId: wt?.id ?? null,
				playbook: input.playbook,
				brief: input.brief,
				related: input.related,
				dispatchKey: input.dispatchKey,
				actor: "dispatcher",
			});
		});
		if (created) {
			this.indexer.brief(task);
			this.provisioner.kick();
			this.changed("tasks", `task:${task.id}`, "state", "workspaces");
		}
		return { task, created, where: target.where };
	}

	/** home_send: one outbox prompt to the task's worker, resuming it if cold. */
	sendToTask(input: { taskId: string; text: string; mode: "next" | "now"; decision: { why: string; revert: string } | null; dedupe: string }): { text: string; decision: string | null } {
		const task = this.ledger.mustTask(input.taskId);
		if (task.status === "cancelled") {
			const branch = this.branchOf(task.worktree_id);
			throw new HubError("conflict", `${task.id} is cancelled; dispatch a new task${branch ? ` on branch ${branch}` : ""} to pick it up`);
		}
		const wait = waitOf(task);
		if ((wait?.kind === "question" || wait?.kind === "blocked") && !input.decision) {
			throw new HubError("invalid", `${task.id} is waiting on a worker ${wait.kind}; answering decides on the human's behalf. Pass decision {why, revert}, or home_escalate.`);
		}
		const session = this.#taskSession(task, input.text, "main", input.dedupe);
		if (!session) return { text: `${task.id} had failed setup; retrying it now. Your text is appended to its brief.`, decision: null };
		const { logged, result } = this.db.tx(() => {
			let decision: DecisionRow | null = null;
			if (input.decision) {
				const firstLine = input.text.split("\n")[0]!.slice(0, 120);
				const summaryMessage = messages.answeredDecision(task.id, firstLine);
				decision = this.ledger.logDecision({
					taskId: task.id,
					summary: summaryMessage.en,
					summaryMessage,
					why: input.decision.why,
					revert: input.decision.revert,
					reverts: null,
					dedupeKey: `${input.dedupe}:decision`,
					actor: "main",
				});
			}
			const result = this.ledger.apply(task.id, { kind: "message_sent", by: "main", text: input.text, mode: input.mode, decision: decision?.id ?? null }, "main", input.dedupe);
			const text = `[omp-home · message from the home agent about ${task.id}]\n${input.text}`;
			this.ledger.enqueue({ sessionId: session.id, taskId: task.id, kind: "prompt", deliver: input.mode, text, dedupeKey: input.dedupe });
			return { logged: decision, result };
		});
		if (logged) this.indexer.decision(logged, task.workspace_id);
		this.afterApply(task.id, result);
		const live = this.pool.ensureLive(session.id, { human: false });
		this.bridge.flush(session.id);
		this.changed("decisions", "sessions");
		const where = live === "live" ? (this.pool.isIdle(session.id) ? "idle; turn started" : "running; delivered after the current turn") : live === "starting" ? "starting" : "waiting for a worker slot";
		return { text: `Queued to ${session.id} (${where})${logged ? ` · decision ${logged.id} logged` : ""}.`, decision: logged?.id ?? null };
	}

	/** The human's message to a task (Tasks panel): a prompt to its worker session. */
	async messageTask(taskId: string, text: string, dedupe: string): Promise<void> {
		const task = this.ledger.mustTask(taskId);
		const session = this.#taskSession(task, text, "human", dedupe);
		if (session) await this.prompt(session.id, text, "auto");
	}

	/**
	 * The live session a message to `task` goes to, or null when the task failed setup and
	 * the message instead retried provisioning (appended to its brief).
	 */
	#taskSession(task: TaskRow, text: string, by: "main" | "human", dedupe: string): SessionRow | null {
		if (!task.session_id) {
			if (waitOf(task)?.kind !== "provision_failed") throw new HubError("unavailable", messages.taskSetup(task.id));
			this.afterApply(task.id, this.ledger.apply(task.id, { kind: "provision_retry", text }, by, dedupe));
			this.provisioner.kick();
			return null;
		}
		const session = this.pool.must(task.session_id);
		if (!this.pool.admits(session)) throw new HubError("conflict", messages.taskRetired(task.id, session.id));
		const other = this.ledger.openForSession(session.id);
		if (other && other.id !== task.id) throw new HubError("conflict", messages.otherTask(session.id, other.id));
		return session;
	}

	// ── sessions: what the UI does to one omp session ────────────────────────

	/**
	 * A UI prompt: starts a cold session (human admission). It counts as human input before it is
	 * sent, so the task is reopened (unsettled) before anything else can retire its worktree.
	 */
	async prompt(id: string, text: string, mode: NonNullable<PromptRequest["mode"]>): Promise<void> {
		const session = this.#activeSession(id);
		this.pool.ensureLive(id, { human: true });
		this.#humanInput(session, text);
		// streamingBehavior only applies while a run streams; when idle the prompt starts a turn.
		await this.#command(id, "prompt", { message: text, streamingBehavior: mode === "steer" ? "steer" : "followUp" });
	}

	async abort(id: string): Promise<void> {
		this.pool.must(id);
		await this.pool.abort(id).catch(err => {
			throw err instanceof RpcError ? new HubError("conflict", messages.abortRefused(errorMessage(err))) : err;
		});
	}

	async respond(id: string, requestId: string, response: UiResponse): Promise<void> {
		const request = this.views.openRequest(id, requestId);
		if (!responseFits(request, response)) throw new HubError("invalid", messages.answerMismatch(request.method));
		const rpc = await this.pool.client(id);
		rpc.send({ type: "extension_ui_response", id: requestId, ...response });
		this.views.apply(id, answerEvent(requestId, request, response));
	}

	commands(id: string): CommandDTO[] {
		this.pool.must(id);
		return this.views.commands(id);
	}

	history(id: string, before: string, language: Language = "en"): Extract<TranscriptEvent, { t: "prepend" }> {
		this.pool.must(id);
		return this.views.history(id, before, language);
	}

	async steerSubagent(id: string, agentId: string, text: string): Promise<void> {
		await this.#command(id, "steer_subagent", { subagentId: agentId, message: text });
	}

	async cancelSubagent(id: string, agentId: string): Promise<void> {
		const cancelled = await this.#command(id, "cancel_subagent", { subagentId: agentId });
		if (cancelled !== true && !(typeof cancelled === "object" && cancelled !== null && "cancelled" in cancelled && cancelled.cancelled === true)) {
			throw new HubError("conflict", messages.subagentStopped(agentId));
		}
	}

	/**
	 * WS stream: start the session if cold (human admission), then `reset` and increments. A retired
	 * session is read-only: its transcript is shown, no process starts. Throws HubError when no slot is free.
	 */
	stream(id: string, send: (ev: TranscriptEvent) => void, language: Language = "en"): () => void {
		if (this.pool.admits(this.pool.must(id))) this.pool.ensureLive(id, { human: true });
		return this.views.subscribe(id, send, language);
	}

	#activeSession(id: string): SessionRow {
		const session = this.pool.must(id);
		if (!this.pool.admits(session)) throw new HubError("conflict", messages.retired(id));
		return session;
	}

	/** One RPC command to a running session; omp's refusals become 409s with omp's message. */
	async #command(id: string, type: string, params: Record<string, unknown>): Promise<unknown> {
		this.#activeSession(id);
		const rpc = await this.pool.client(id);
		try {
			return await rpc.request(type, params);
		} catch (err) {
			if (err instanceof RpcError) throw new HubError("conflict", { en: `omp: ${errorText(err)}`, zh: `omp: ${errorText(err, "zh")}` });
			throw err;
		}
	}

	cancelTask(taskId: string, by: "main" | "human", reason: string, dedupe: string, reasonMessage?: Message): DecisionRow | null {
		const task = this.ledger.mustTask(taskId);
		if (task.status === "cancelled") return null;
		if (task.status === "done" && by === "main") throw new HubError("conflict", messages.taskDone(task.id));
		const { logged, r } = this.db.tx(() => {
			let decision: DecisionRow | null = null;
			if (by === "main") {
				const summaryMessage = messages.cancelledDecision(task.id);
				const revertMessage = messages.resumeDecision(task.id);
				decision = this.ledger.logDecision({
					taskId: task.id,
					summary: summaryMessage.en,
					summaryMessage,
					why: reason,
					revert: revertMessage.en,
					revertMessage,
					reverts: null,
					dedupeKey: `${dedupe}:decision`,
					actor: "main",
				});
			}
			this.ledger.dropPrompts(task.id);
			return { logged: decision, r: this.ledger.apply(task.id, { kind: "cancelled", by, reason, ...(reasonMessage ? { reasonMessage } : {}) }, by, dedupe) };
		});
		if (task.session_id) void this.pool.abort(task.session_id).catch(err => this.#log(`${task.session_id}: abort failed: ${errorText(err)}`));
		if (logged) this.indexer.decision(logged, task.workspace_id);
		this.afterApply(task.id, r);
		this.changed("decisions");
		return logged;
	}

	acceptTask(taskId: string, reason: string, dedupe: string): DecisionRow {
		const task = this.ledger.mustTask(taskId);
		if (task.status === "cancelled") throw new HubError("conflict", messages.taskCancelled(task.id));
		const { d, r } = this.db.tx(() => {
			const summaryMessage = messages.acceptedDecision(task.id);
			const revertMessage = messages.reopenDecision(task.id);
			const d = this.ledger.logDecision({
				taskId: task.id,
				summary: summaryMessage.en,
				summaryMessage,
				why: reason,
				revert: revertMessage.en,
				revertMessage,
				reverts: null,
				dedupeKey: `${dedupe}:decision`,
				actor: "main",
			});
			return { d, r: this.ledger.apply(task.id, { kind: "accepted", reason, decision: d.id }, "main", dedupe) };
		});
		this.indexer.decision(d, task.workspace_id);
		this.afterApply(task.id, r);
		this.changed("decisions");
		return d;
	}

	escalate(taskId: string, reason: string, by: "main" | "hub"): { escalation: EscalationRow; created: boolean; started: boolean } {
		const task = this.ledger.mustTask(taskId);
		if (!task.session_id) throw new HubError("conflict", messages.noWorker(task.id));
		const { escalation, created } = this.ledger.escalate(task.id, task.session_id, reason, by);
		const started = this.#focus(escalation);
		this.changed("tasks", `task:${task.id}`);
		return { escalation, created, started };
	}

	/** Human asks main to undo a decision: a prompt to main, and the wake budget resets. */
	revertDecision(id: string, language: Language = "en"): DecisionDTO {
		const d = this.ledger.requestRevert(id);
		const main = this.#requireMain();
		this.ledger.noteHumanInput();
		this.ledger.enqueue({
			sessionId: main.id,
			taskId: null,
			kind: "prompt",
			deliver: "next",
			text: `[omp-home · the human asks to revert ${d.id}]\nDecision: ${d.summary}${d.task_id ? ` (task ${d.task_id})` : ""}\nWhy it was made: ${d.why}\nRevert plan: ${d.revert_plan}\nCarry out the revert plan, then record it with home_decide({ ..., reverts: "${d.id}" }).`,
			dedupeKey: `revert:${d.id}`,
		});
		this.pool.ensureLive(main.id, { human: true });
		this.bridge.flush(main.id);
		this.changed("decisions", "state", "inbox");
		return this.ledger.decisionDTO(d, language);
	}

	/** Retire the main chat and start a fresh one; unacknowledged notices move to the new chat. */
	async newMain(): Promise<void> {
		const old = this.pool.currentMain();
		await this.pool.newMain(this.home);
		if (old) this.ledger.requeueNotices(old.id);
		this.notifier.evaluate();
		this.changed("state", "sessions", "inbox");
	}

	continueMain(): void {
		const main = this.#requireMain();
		this.ledger.noteHumanInput();
		this.ledger.enqueue({
			sessionId: main.id,
			taskId: null,
			kind: "prompt",
			deliver: "next",
			text: "[omp-home · the human says: continue] Your automatic wake budget is reset. Handle the pending omp-home updates (home_status shows open tasks).",
			dedupeKey: `continue:${Date.now()}`,
		});
		this.pool.ensureLive(main.id, { human: true });
		this.bridge.flush(main.id);
		this.notifier.evaluate();
		this.changed("state", "inbox");
	}

	#requireMain(): SessionRow {
		const main = this.pool.currentMain();
		if (!main) throw new HubError("unavailable", messages.noMain());
		return main;
	}

	// ── views ────────────────────────────────────────────────────────────────

	/** Live progress of an open task: its phase, what its worker is doing, and since when. Null once closed. */
	progressOf(t: TaskRow, language: Language = "en"): TaskProgress | null {
		const session = t.session_id ? { queued: this.pool.queued(t.session_id), state: this.pool.state(t.session_id) } : null;
		const phase = progressPhase(t.status, session);
		if (!phase) return null;
		const since =
			phase === "provisioning"
				? this.ledger.lastEventAt(t.id, ["created", "provision_retry"])
				: phase === "queued"
					? this.ledger.lastEventAt(t.id, ["queued_for_capacity"])
					: this.pool.stateSince(t.session_id!);
		return { phase, intent: t.session_id ? this.views.intent(t.session_id) : null, lastEvent: this.ledger.lastEventSummary(t.id, language), since: since ?? t.updated_at };
	}

	taskSummary(t: TaskRow, language: Language = "en"): TaskSummary {
		return { ...this.ledger.summary(t, this.branchOf(t.worktree_id), language), progress: this.progressOf(t, language) };
	}

	branchOf(worktreeId: string | null): string | null {
		return worktreeId ? (this.worktrees.get(worktreeId)?.branch ?? null) : null;
	}

	async taskDetail(id: string, events = 200, language: Language = "en"): Promise<TaskDetail> {
		const t = this.ledger.mustTask(id);
		const wt = t.worktree_id ? (this.worktrees.get(t.worktree_id) ?? null) : null;
		const worktree = wt ? await this.lifecycle.branch(wt.id, language) : null;
		const envRow = wt ? this.env.envRow(wt.id) : undefined;
		return {
			...this.ledger.summary(t, wt?.branch ?? null, language),
			progress: this.progressOf(t, language),
			brief: t.brief,
			envelope: t.envelope,
			checkout: JSON.parse(t.checkout) as CheckoutSpec,
			worktreePath: wt?.state === "live" && fs.existsSync(wt.path) ? wt.path : null,
			related: this.ledger.related(t.id),
			reports: this.ledger.reports(t.id),
			events: this.ledger.events(t.id, events).map(e => this.ledger.eventDTO(e, language)),
			decisions: this.ledger.decisions(t.id).map(d => this.ledger.decisionDTO(d, language)),
			escalations: this.ledger.escalations({ taskId: t.id }).map(e => this.ledger.escalationDTO(e, language)),
			worktree,
			env: envRow ? this.env.envDTO(envRow, language) : null,
		};
	}

	sessionDTO(row: SessionRow): SessionDTO {
		const wt = row.worktree_id ? this.worktrees.get(row.worktree_id) : undefined;
		const open = this.ledger.openForSession(row.id);
		return {
			id: row.id,
			kind: row.kind,
			workspace: row.workspace_id,
			worktreePath: wt?.path ?? null,
			branch: wt?.branch ?? null,
			cwd: row.cwd,
			model: row.model || "default",
			state: this.pool.state(row.id),
			pid: row.pid,
			rssMb: this.pool.rssMb(row.id),
			lastActivity: row.last_activity,
			openTask: open ? { id: open.id, title: open.title, status: open.status } : null,
			retired: row.retired_at !== null,
			createdAt: row.created_at,
		};
	}

	inbox(language: Language = "en"): InboxDTO {
		const escalations: EscalationDTO[] = this.ledger.escalations({ open: true }).map(e => this.ledger.escalationDTO(e, language));
		return { escalations, main: this.notifier.main() };
	}

	state(version: string, language: Language = "en"): StateDTO {
		return {
			version,
			setup: { done: true, homePath: this.home },
			main: this.notifier.main(),
			pool: { live: this.pool.liveWorkerCount(), cap: this.settings.get().maxLiveWorkers },
			inboxOpen: this.ledger.escalations({ open: true }).length,
			openTasks: this.ledger.listTasks({ status: "open" }).length,
			omp: this.omp.status(language),
		};
	}
}
