import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProcState } from "../shared/api.ts";
import type { HomePaths } from "./config.ts";
import { admit, idleVictims, launchSpec, liveWorkers, procState, type PoolEntry, type Proc } from "./core/pool.ts";
import type { Db } from "./db.ts";
import { errorMessage, errorText, HubError } from "./errors.ts";
import { hooksDir } from "./git.ts";
import { messages, type Message } from "./i18n.ts";
import type { Resources } from "./resources.ts";
import { RpcClient, RpcError, type RpcExit, type RpcFrame } from "./rpc.ts";
import type { SessionSeed } from "./session-views.ts";
import type { SettingsStore } from "./settings.ts";
import type { Workspaces } from "./workspaces.ts";

const execFileP = promisify(execFile);
const HELLO_TIMEOUT_MS = 60_000;
/** EOF → exit wait before SIGTERM; a hub stop (all sessions in parallel) must finish well inside the desktop shell's 10 s. */
const SHUTDOWN_GRACE_MS = 3000;
/** A worker must have been idle this long before it can be evicted to make room. */
const MIN_IDLE_FOR_VICTIM_MS = 2 * 60_000;
const MAIN_BACKOFF_MS = [1000, 5000, 30_000];
const MAIN_FAILURE_WINDOW_MS = 5 * 60_000;
const MAIN_FAILURE_LIMIT = 5;
/** Messages per `get_messages_page`: small pages, because protocol v1 shortens strings until a frame fits 1 MiB. */
const HISTORY_PAGE = 32;

export interface SessionRow {
	id: string;
	kind: "main" | "worker";
	workspace_id: string | null;
	worktree_id: string | null;
	cwd: string;
	session_dir: string;
	omp_session_id: string | null;
	omp_session_file: string | null;
	model: string;
	thinking: string;
	incarnation: number;
	pid: number | null;
	last_exit: "clean" | "lost" | null;
	last_activity: number | null;
	created_at: number;
	retired_at: number | null;
}

export interface ExitInfo {
	intentional: boolean;
	/** A run (or approval dialog) was open when the process ended. */
	wasRunning: boolean;
	/** The bridge never said hello: the spawn itself failed. */
	neverConnected: boolean;
	exitCode: number;
	incarnation: number;
	/** Why: spawn error or the tail of omp's stderr. */
	detail: string;
	detailText?: Message | string;
}

export interface PoolDeps {
	db: Db;
	paths: HomePaths;
	settings: SettingsStore;
	workspaces: Workspaces;
	resources: Resources;
	/** The omp binary to spawn now (it can change when a managed copy is installed). */
	ompBin(): string;
	bridgeUrl: string;
	envVars(worktreeId: string | null): Record<string, string>;
	hasOpenEscalation(sessionId: string): boolean;
	hadOpenRun(sessionId: string): boolean;
	/** UIs streaming this session; watched sessions are never evicted. */
	viewers(sessionId: string): number;
	/** A new process published its stored history; precedes every `frame` of that process. */
	seeded(sessionId: string, seed: SessionSeed): void;
	frame(sessionId: string, frame: RpcFrame): void;
	/** Live: bridge connected and RPC set up (also after a bridge reconnect). */
	ready(sessionId: string): void;
	exited(session: SessionRow, info: ExitInfo): void;
	changed(): void;
	mainFailed(message: Message): void;
	log(message: string): void;
}

interface Live {
	rpc: RpcClient | null;
	token: string;
	incarnation: number;
	proc: Proc;
	running: boolean;
	/** The bridge extension said hello. */
	connected: boolean;
	/** RPC set up and history seeded. */
	initialized: boolean;
	/** Frames that arrive while the history is being seeded; replayed right after the seed. */
	backlog: RpcFrame[] | null;
	client: PromiseWithResolvers<RpcClient>;
	rssKb: number | null;
	helloTimer: NodeJS.Timeout | undefined;
}

/** Sole writer of `session`; owns every omp process (`omp --mode rpc-ui` on stdio pipes) and the admission queue. */
export class Pool {
	readonly #d: PoolDeps;
	readonly #live = new Map<string, Live>();
	#queue: string[] = [];
	/** When each session's ProcState last changed (this hub's lifetime only). */
	readonly #stateSince = new Map<string, { state: ProcState; at: number }>();
	#mainFailures: number[] = [];
	#restartTimer: NodeJS.Timeout | undefined;
	#shuttingDown = false;

	constructor(deps: PoolDeps) {
		this.#d = deps;
	}

	// ── rows ─────────────────────────────────────────────────────────────────

	session(id: string): SessionRow | undefined {
		return this.#d.db.get<SessionRow>("SELECT * FROM session WHERE id = ?", id);
	}

	must(id: string): SessionRow {
		const row = this.session(id);
		if (!row) throw new HubError("not_found", messages.noSession(id));
		return row;
	}

	list(): SessionRow[] {
		return this.#d.db.all<SessionRow>("SELECT * FROM session ORDER BY retired_at IS NOT NULL, created_at DESC");
	}

	currentMain(): SessionRow | undefined {
		return this.#d.db.get<SessionRow>("SELECT * FROM session WHERE kind = 'main' AND retired_at IS NULL");
	}

	liveForWorktree(worktreeId: string): SessionRow | undefined {
		return this.#d.db.get<SessionRow>("SELECT * FROM session WHERE worktree_id = ? AND retired_at IS NULL", worktreeId);
	}

	create(input: { kind: "main" | "worker"; workspaceId: string | null; worktreeId: string | null; cwd: string }): SessionRow {
		return this.#d.db.tx(() => {
			const { id } = this.#d.db.nextId(input.kind === "main" ? "M" : "W");
			const dir = path.join(input.kind === "main" ? this.#d.paths.chat : this.#d.paths.sessions, id);
			const s = this.#d.settings.get();
			this.#d.db.run(
				`INSERT INTO session (id, kind, workspace_id, worktree_id, cwd, session_dir, model, thinking, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				input.kind,
				input.workspaceId,
				input.worktreeId,
				input.cwd,
				dir,
				(input.kind === "main" ? s.mainModel : s.workerModel) ?? "",
				input.kind === "main" ? s.mainThinking : s.workerThinking,
				Date.now(),
			);
			this.#changed();
			return this.must(id);
		});
	}

	// ── live state ───────────────────────────────────────────────────────────

	#entries(): PoolEntry[] {
		return this.#d.db.all<SessionRow>("SELECT * FROM session WHERE retired_at IS NULL").map(s => ({
			id: s.id,
			kind: s.kind,
			proc: this.#live.get(s.id)?.proc ?? { s: "cold" },
			viewers: this.#d.viewers(s.id),
			openEscalation: this.#d.hasOpenEscalation(s.id),
		}));
	}

	state(id: string): ProcState {
		return procState(this.#live.get(id)?.proc ?? { s: "cold" });
	}

	/** When the session entered its current state; null when it has not changed since the hub started. */
	stateSince(id: string): number | null {
		const mark = this.#stateSince.get(id);
		return mark && mark.state === this.state(id) ? mark.at : null;
	}

	/** Every process state change ends here: stamp what changed, then tell the hub. */
	#changed(): void {
		const now = Date.now();
		for (const [id, mark] of this.#stateSince) if (!this.#live.has(id) && mark.state !== "cold") this.#stateSince.set(id, { state: "cold", at: now });
		for (const id of this.#live.keys()) {
			const state = this.state(id);
			if (this.#stateSince.get(id)?.state !== state) this.#stateSince.set(id, { state, at: now });
		}
		this.#d.changed();
	}

	rssMb(id: string): number | null {
		const kb = this.#live.get(id)?.rssKb;
		return kb == null ? null : Math.round(kb / 1024);
	}

	liveWorkerCount(): number {
		return liveWorkers(this.#entries());
	}

	/** The one admission gate: every start, prompt, reopen and queue drain asks it. A retired session never runs again. */
	admits(row: SessionRow): boolean {
		return row.retired_at === null;
	}

	/**
	 * Make a session's process live. Main always spawns; workers go through admission.
	 * The human may exceed the cap by one; beyond that they are told to evict.
	 */
	ensureLive(id: string, opts: { human: boolean }): "live" | "starting" | "queued" {
		const row = this.must(id);
		if (!this.admits(row)) throw new HubError("conflict", messages.sessionRetired(id));
		const live = this.#live.get(id);
		if (live) {
			if (live.proc.s === "stopping") {
				this.#enqueue(id, true);
				return "starting";
			}
			return live.proc.s === "live" ? "live" : "starting";
		}
		if (row.kind === "main") {
			this.#spawn(row);
			return "starting";
		}
		const decision = admit(opts, this.#entries(), this.#d.settings.get().maxLiveWorkers, Date.now(), MIN_IDLE_FOR_VICTIM_MS);
		if (decision.kind === "spawn") {
			this.#queue = this.#queue.filter(q => q !== id);
			this.#spawn(row);
			return "starting";
		}
		if (decision.kind === "evict_then_spawn") {
			this.#enqueue(id, true);
			void this.stop(decision.victim, "evict");
			return "starting";
		}
		if (opts.human) {
			throw new HubError("unavailable", messages.workerCapacity(this.liveWorkerCount()));
		}
		this.#enqueue(id, false);
		return "queued";
	}

	#enqueue(id: string, front: boolean): void {
		this.#queue = this.#queue.filter(q => q !== id);
		if (front) this.#queue.unshift(id);
		else this.#queue.push(id);
	}

	#drainQueue(): void {
		while (this.#queue.length) {
			const id = this.#queue[0]!;
			const row = this.session(id);
			const live = this.#live.get(id);
			if (!row || !this.admits(row) || (live && live.proc.s !== "stopping")) {
				this.#queue.shift();
				continue;
			}
			if (live) return;
			if (row.kind === "main") {
				this.#queue.shift();
				this.#spawn(row);
				continue;
			}
			const decision = admit({ human: false }, this.#entries(), this.#d.settings.get().maxLiveWorkers, Date.now(), MIN_IDLE_FOR_VICTIM_MS);
			if (decision.kind === "queue") return;
			if (decision.kind === "evict_then_spawn") {
				void this.stop(decision.victim, "evict");
				return;
			}
			this.#queue.shift();
			this.#spawn(row);
		}
	}

	queued(id: string): boolean {
		return this.#queue.includes(id);
	}

	#spawn(row: SessionRow): void {
		const client = Promise.withResolvers<RpcClient>();
		client.promise.catch(() => {});
		const live: Live = {
			rpc: null,
			token: randomBytes(24).toString("hex"),
			incarnation: row.incarnation + 1,
			proc: { s: "starting", pid: 0, since: Date.now() },
			running: false,
			connected: false,
			initialized: false,
			backlog: [],
			client,
			rssKb: null,
			helloTimer: undefined,
		};
		this.#live.set(row.id, live);
		this.#changed();
		this.#launch(row, live).catch(err => {
			if (this.#live.get(row.id) !== live) return;
			this.#live.delete(row.id);
			live.client.reject(new HubError("unavailable", messages.startFailed(row.id, errorMessage(err))));
			this.#d.log(`${row.id}: could not start omp: ${errorText(err)}`);
			this.#d.db.run("UPDATE session SET pid = NULL, last_exit = 'clean' WHERE id = ?", row.id);
			this.#d.exited(this.must(row.id), { intentional: false, wasRunning: false, neverConnected: true, exitCode: -1, incarnation: live.incarnation, detail: errorText(err), detailText: errorMessage(err) });
			this.#changed();
			if (row.kind === "main") this.#mainCrashed(row.id);
			this.#drainQueue();
		});
	}

	async #launch(row: SessionRow, live: Live): Promise<void> {
		const settings = this.#d.settings.get();
		if (!fs.existsSync(row.cwd)) throw new HubError("unavailable", messages.cwdMissing(row.cwd));
		let worker: Parameters<typeof launchSpec>[0]["worker"] = null;
		let model: string | null;
		let thinking: string;
		if (row.kind === "worker") {
			const ws = this.#d.workspaces.must(row.workspace_id!);
			worker = { env: this.#d.envVars(row.worktree_id), protectedBranches: [ws.default_base], repoHooks: await hooksDir(row.cwd), mainCheckout: row.worktree_id === null };
			model = ws.worker_model ?? settings.workerModel;
			thinking = settings.workerThinking;
		} else {
			model = settings.mainModel;
			thinking = settings.mainThinking;
		}
		if (this.#live.get(row.id) !== live) return;
		// Retired while the launch awaited: the gate holds here too.
		if (!this.admits(this.must(row.id))) return void this.stop(row.id, "retire");
		fs.mkdirSync(row.session_dir, { recursive: true });
		const baseEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined && !k.startsWith("OMP_HOME_") && !k.startsWith("GIT_CONFIG_")) baseEnv[k] = v;
		}
		const spec = launchSpec({
			bin: this.#d.ompBin(),
			session: {
				id: row.id,
				kind: row.kind,
				cwd: row.cwd,
				sessionDir: row.session_dir,
				resumeFile: row.omp_session_file && fs.existsSync(row.omp_session_file) ? row.omp_session_file : null,
				model,
				thinking,
			},
			paths: {
				plugin: path.join(this.#d.resources.plugin, row.kind),
				overlay: this.#d.paths.overlay(row.kind),
				pstackPackage: settings.pstackRoot && fs.existsSync(path.join(this.#d.paths.pstackPackage, "package.json")) ? this.#d.paths.pstackPackage : null,
				gitGuard: this.#d.resources.gitGuard,
			},
			bridge: { url: this.#d.bridgeUrl, token: live.token },
			baseEnv,
			worker,
		});
		const rpc = new RpcClient(spec, frame => {
			if (this.#live.get(row.id) !== live) return;
			if (live.backlog) live.backlog.push(frame);
			else this.#d.frame(row.id, frame);
		});
		live.rpc = rpc;
		live.proc = { s: "starting", pid: rpc.pid, since: Date.now() };
		this.#d.db.run(
			"UPDATE session SET pid = ?, incarnation = ?, model = ?, thinking = ?, last_exit = NULL, last_activity = ? WHERE id = ?",
			rpc.pid,
			live.incarnation,
			model ?? "",
			thinking,
			Date.now(),
			row.id,
		);
		live.helloTimer = setTimeout(() => {
			if (this.#live.get(row.id) !== live || (live.connected && live.initialized)) return;
			this.#d.log(`${row.id}: omp did not ${live.initialized ? "connect to the hub" : "finish RPC setup"} within ${HELLO_TIMEOUT_MS / 1000}s; stopping it`);
			void rpc.stop(SHUTDOWN_GRACE_MS);
		}, HELLO_TIMEOUT_MS);
		this.#changed();
		void rpc.exited.then(exit => this.#onExit(row.id, live, exit));
		void this.#initialize(row.id, live, rpc);
	}

	/** After `ready`: subscribe to subagent events, enable ask dialogs, seed history, then replay the backlog. */
	async #initialize(id: string, live: Live, rpc: RpcClient): Promise<void> {
		try {
			await rpc.ready;
			await rpc.request("set_subagent_subscription", { level: "events" });
			await rpc.request("set_ask_dialog", { enabled: true });
			const messages = await this.#history(id, rpc);
			const commands = await rpc.request("get_available_commands");
			const state = await rpc.request("get_state");
			if (this.#live.get(id) !== live) return;
			this.#d.seeded(id, { messages, commands, state });
			const backlog = live.backlog ?? [];
			live.backlog = null;
			for (const frame of backlog) this.#d.frame(id, frame);
			live.initialized = true;
			live.client.resolve(rpc);
			this.#settle(id, live);
		} catch (err) {
			if (this.#live.get(id) !== live || !rpc.alive) return;
			this.#d.log(`${id}: omp RPC setup failed: ${errorText(err)}; stopping it`);
			void rpc.stop(SHUTDOWN_GRACE_MS);
		}
	}

	/** Every stored message, oldest first. A run that already started refuses paging; keep what we have. */
	async #history(id: string, rpc: RpcClient): Promise<unknown[]> {
		const messages: unknown[] = [];
		let cursor: string | null = null;
		do {
			let page: unknown;
			try {
				page = await rpc.request("get_messages_page", cursor ? { cursor, limit: HISTORY_PAGE } : { limit: HISTORY_PAGE });
			} catch (err) {
				if (!(err instanceof RpcError) || err.code !== "session_busy") throw err;
				this.#d.log(`${id}: history paging refused while a run is active; showing ${messages.length} messages`);
				return messages;
			}
			const r = typeof page === "object" && page !== null ? page : {};
			if ("messages" in r && Array.isArray(r.messages)) messages.push(...r.messages);
			cursor = "nextCursor" in r && typeof r.nextCursor === "string" ? r.nextCursor : null;
		} while (cursor);
		return messages;
	}

	/** Live once both the bridge and RPC are up; every later bridge hello re-announces readiness. */
	#settle(id: string, live: Live): void {
		if (!live.connected || !live.initialized) return;
		clearTimeout(live.helloTimer);
		if (live.proc.s === "starting") {
			const now = Date.now();
			live.proc = { s: "live", pid: live.proc.pid, since: now, run: "idle", approval: false, asyncJobs: 0, lastActivity: now };
			this.#changed();
		}
		if (live.proc.s === "live") this.#d.ready(id);
	}

	#onExit(id: string, live: Live, exit: RpcExit): void {
		clearTimeout(live.helloTimer);
		live.client.reject(new HubError("unavailable", messages.exitedEarly(id)));
		if (this.#live.get(id) !== live) return;
		this.#live.delete(id);
		const intentional = live.proc.s === "stopping";
		const exitCode = exit.code ?? -1;
		this.#d.db.run("UPDATE session SET pid = NULL, last_exit = ?, last_activity = ? WHERE id = ?", live.running ? "lost" : "clean", Date.now(), id);
		if (!intentional) this.#d.log(`${id}: omp exited (${exit.signal ?? `code ${exitCode}`})${exit.detail ? `: ${exit.detail.slice(-1000)}` : ""}`);
		const row = this.must(id);
		this.#d.exited(row, { intentional, wasRunning: live.running, neverConnected: !live.connected, exitCode, incarnation: live.incarnation, detail: exit.detail });
		this.#changed();
		if (row.kind === "main" && !intentional && !this.#shuttingDown && row.retired_at === null) this.#mainCrashed(id);
		this.#drainQueue();
	}

	#mainCrashed(id: string): void {
		const now = Date.now();
		this.#mainFailures = [...this.#mainFailures.filter(t => now - t < MAIN_FAILURE_WINDOW_MS), now];
		if (this.#mainFailures.length >= MAIN_FAILURE_LIMIT) {
			this.#d.mainFailed(messages.mainFailed(MAIN_FAILURE_LIMIT, this.must(id).session_dir));
			return;
		}
		const delay = MAIN_BACKOFF_MS[Math.min(this.#mainFailures.length - 1, MAIN_BACKOFF_MS.length - 1)]!;
		clearTimeout(this.#restartTimer);
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			if (this.#shuttingDown || this.currentMain()?.id !== id || this.#live.has(id)) return;
			this.ensureLive(id, { human: false });
		}, delay);
	}

	/** Human restart of the main chat: clears the failure history. */
	async restartMain(): Promise<SessionRow> {
		const main = this.currentMain();
		if (!main) throw new HubError("not_found", messages.noMain());
		this.#mainFailures = [];
		await this.stop(main.id, "restart");
		this.ensureLive(main.id, { human: true });
		return main;
	}

	async newMain(home: string): Promise<SessionRow> {
		const old = this.currentMain();
		if (old) await this.retire(old.id);
		this.#mainFailures = [];
		const main = this.create({ kind: "main", workspaceId: null, worktreeId: null, cwd: home });
		this.ensureLive(main.id, { human: true });
		return main;
	}

	/** Graceful stop: close omp's stdin, then SIGTERM, then SIGKILL. Resolves when the process is gone. */
	async stop(id: string, why: "evict" | "retire" | "restart" | "shutdown"): Promise<void> {
		const live = this.#live.get(id);
		if (!live) return;
		if (live.proc.s === "stopping") {
			await live.rpc?.exited;
			return;
		}
		if (!live.rpc) {
			this.#live.delete(id);
			live.client.reject(new HubError("unavailable", messages.stopped(id)));
			this.#changed();
			return;
		}
		live.proc = { s: "stopping", pid: live.rpc.pid, why };
		this.#changed();
		await live.rpc.stop(SHUTDOWN_GRACE_MS);
	}

	/** The RPC client of a live (or starting) session, once it is set up. */
	async client(id: string): Promise<RpcClient> {
		const live = this.#live.get(id);
		if (!live || live.proc.s === "stopping") throw new HubError("unavailable", messages.notRunning(id));
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(() => timeout.reject(new HubError("unavailable", messages.startTimeout(id, HELLO_TIMEOUT_MS / 1000))), HELLO_TIMEOUT_MS);
		try {
			return await Promise.race([live.client.promise, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Abort the running turn, if the session is up. */
	async abort(id: string): Promise<void> {
		const live = this.#live.get(id);
		if (live?.initialized && live.rpc?.alive) await live.rpc.request("abort");
	}

	async evict(id: string): Promise<void> {
		const live = this.#live.get(id);
		if (live?.running) throw new HubError("conflict", messages.busySession(id));
		this.#queue = this.#queue.filter(q => q !== id);
		await this.stop(id, "evict");
	}

	/** Retired from now on: synchronous, so the caller's transaction closes every start path before the process stops. */
	markRetired(id: string): void {
		this.#queue = this.#queue.filter(q => q !== id);
		this.#d.db.run("UPDATE session SET retired_at = coalesce(retired_at, ?) WHERE id = ?", Date.now(), id);
		this.#changed();
	}

	async retire(id: string): Promise<void> {
		this.must(id);
		this.markRetired(id);
		await this.stop(id, "retire");
	}

	async stopAll(): Promise<void> {
		this.#shuttingDown = true;
		clearTimeout(this.#restartTimer);
		await Promise.all([...this.#live.keys()].map(id => this.stop(id, "shutdown")));
	}

	// ── bridge events ────────────────────────────────────────────────────────

	tokenOk(id: string, token: string): boolean {
		const expected = this.#live.get(id)?.token;
		if (!expected || expected.length !== token.length) return false;
		return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
	}

	onHello(id: string, hello: { ompSessionId: string; sessionFile: string | null }): void {
		const live = this.#live.get(id);
		if (!live) return;
		live.connected = true;
		this.#d.db.run("UPDATE session SET omp_session_id = ?, omp_session_file = coalesce(?, omp_session_file) WHERE id = ?", hello.ompSessionId, hello.sessionFile, id);
		this.#changed();
		this.#settle(id, live);
	}

	onDisconnect(id: string): void {
		const live = this.#live.get(id);
		if (live) live.connected = false;
	}

	onRun(id: string, phase: "start" | "end", asyncJobs = 0): void {
		const live = this.#live.get(id);
		if (!live) return;
		const now = Date.now();
		live.running = phase === "start";
		if (live.proc.s === "live") live.proc = { ...live.proc, run: phase === "start" ? "running" : "idle", asyncJobs, lastActivity: now, approval: false };
		this.#d.db.run("UPDATE session SET last_activity = ? WHERE id = ?", now, id);
		this.#changed();
	}

	onApproval(id: string, open: boolean): void {
		const live = this.#live.get(id);
		if (live?.proc.s === "live") {
			live.proc = { ...live.proc, approval: open };
			this.#changed();
		}
	}

	/** Bridge connected and RPC set up: outbox rows may be delivered. */
	isLive(id: string): boolean {
		return this.#live.get(id)?.proc.s === "live";
	}

	/** Idle: live, connected, no run and no approval dialog. */
	isIdle(id: string): boolean {
		const live = this.#live.get(id);
		return !!live && live.connected && live.proc.s === "live" && live.proc.run === "idle" && !live.proc.approval;
	}

	// ── periodic work ────────────────────────────────────────────────────────

	/** Every 30 s: idle eviction, queued admissions, RSS sampling (display only). */
	async tick(): Promise<void> {
		const idleMs = this.#d.settings.get().idleEvictMinutes * 60_000;
		for (const id of idleVictims(this.#entries(), Date.now(), idleMs)) void this.stop(id, "evict");
		this.#drainQueue();
		const pids = [...this.#live.values()].map(l => l.rpc?.pid).filter((p): p is number => !!p);
		if (!pids.length) return;
		const out = await execFileP("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]).then(
			r => r.stdout,
			() => "",
		);
		const rss = new Map(
			out
				.trim()
				.split("\n")
				.map(l => l.trim().split(/\s+/).map(Number))
				.filter(p => p.length === 2)
				.map(([pid, kb]) => [pid!, kb!]),
		);
		for (const live of this.#live.values()) if (live.rpc) live.rssKb = rss.get(live.rpc.pid) ?? null;
		this.#changed();
	}

	/**
	 * Startup: every omp process from a previous hub is orphaned or dead. Kill
	 * survivors that are ours (command line names our session dir) and clear pids.
	 */
	async reconcile(): Promise<void> {
		for (const row of this.#d.db.all<SessionRow>("SELECT * FROM session WHERE pid IS NOT NULL")) {
			const pid = row.pid!;
			const command = await execFileP("ps", ["-o", "command=", "-p", String(pid)]).then(
				r => r.stdout,
				() => "",
			);
			if (command.includes(row.session_dir)) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// gone already
				}
				for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
				if (alive(pid)) process.kill(pid, "SIGKILL");
			}
			this.#d.db.run("UPDATE session SET pid = NULL, last_exit = ? WHERE id = ?", this.#d.hadOpenRun(row.id) ? "lost" : "clean", row.id);
		}
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
