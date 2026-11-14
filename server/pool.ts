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
import { errorText, HubError } from "./errors.ts";
import { hooksDir } from "./git.ts";
import { PtyProcess, type PtyViewer } from "./pty.ts";
import type { SettingsStore } from "./settings.ts";
import type { Workspaces } from "./workspaces.ts";

const execFileP = promisify(execFile);
const HELLO_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 10_000;
/** A worker must have been idle this long before it can be evicted to make room. */
const MIN_IDLE_FOR_VICTIM_MS = 2 * 60_000;
const MAIN_BACKOFF_MS = [1000, 5000, 30_000];
const MAIN_FAILURE_WINDOW_MS = 5 * 60_000;
const MAIN_FAILURE_LIMIT = 5;

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
}

export interface PoolDeps {
	db: Db;
	paths: HomePaths;
	settings: SettingsStore;
	workspaces: Workspaces;
	repoDir: string;
	ompBin: string;
	bridgeUrl: string;
	envVars(worktreeId: string | null): Record<string, string>;
	hasOpenEscalation(sessionId: string): boolean;
	hadOpenRun(sessionId: string): boolean;
	sendShutdown(sessionId: string): boolean;
	exited(session: SessionRow, info: ExitInfo): void;
	changed(): void;
	mainFailed(message: string): void;
}

interface Live {
	pty: PtyProcess | null;
	token: string;
	incarnation: number;
	proc: Proc;
	running: boolean;
	connected: boolean;
	rssKb: number | null;
	helloTimer: NodeJS.Timeout | undefined;
	detach: Map<PtyViewer, () => void>;
}

/** Sole writer of `session`; owns every omp process (one PTY each) and the admission queue. */
export class Pool {
	readonly #d: PoolDeps;
	readonly #live = new Map<string, Live>();
	readonly #viewers = new Map<string, Set<PtyViewer>>();
	#queue: string[] = [];
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
		if (!row) throw new HubError("not_found", `no session ${id}`);
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
			this.#d.changed();
			return this.must(id);
		});
	}

	// ── live state ───────────────────────────────────────────────────────────

	#entries(): PoolEntry[] {
		return this.#d.db.all<SessionRow>("SELECT * FROM session WHERE retired_at IS NULL").map(s => ({
			id: s.id,
			kind: s.kind,
			proc: this.#live.get(s.id)?.proc ?? { s: "cold" },
			viewers: this.#viewers.get(s.id)?.size ?? 0,
			openEscalation: this.#d.hasOpenEscalation(s.id),
		}));
	}

	state(id: string): ProcState {
		return procState(this.#live.get(id)?.proc ?? { s: "cold" });
	}

	rssMb(id: string): number | null {
		const kb = this.#live.get(id)?.rssKb;
		return kb == null ? null : Math.round(kb / 1024);
	}

	liveWorkerCount(): number {
		return liveWorkers(this.#entries());
	}

	/**
	 * Make a session's process live. Main always spawns; workers go through admission.
	 * The human may exceed the cap by one; beyond that they are told to evict.
	 */
	ensureLive(id: string, opts: { human: boolean }): "live" | "starting" | "queued" {
		const row = this.must(id);
		if (row.retired_at !== null) throw new HubError("conflict", `session ${id} is retired`);
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
			throw new HubError("unavailable", `all ${this.liveWorkerCount()} worker slots are busy and none is idle; evict a worker or raise the live cap`);
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
			if (!row || row.retired_at !== null || (live && live.proc.s !== "stopping")) {
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
		const live: Live = {
			pty: null,
			token: randomBytes(24).toString("hex"),
			incarnation: row.incarnation + 1,
			proc: { s: "starting", pid: 0, since: Date.now() },
			running: false,
			connected: false,
			rssKb: null,
			helloTimer: undefined,
			detach: new Map(),
		};
		this.#live.set(row.id, live);
		this.#d.changed();
		this.#launch(row, live).catch(err => {
			if (this.#live.get(row.id) !== live) return;
			this.#live.delete(row.id);
			this.#d.db.run("UPDATE session SET pid = NULL, last_exit = 'clean' WHERE id = ?", row.id);
			this.#writeViewers(row.id, `\r\n[omp-home] could not start ${row.id}: ${errorText(err)}\r\n`);
			this.#d.exited(this.must(row.id), { intentional: false, wasRunning: false, neverConnected: true, exitCode: -1, incarnation: live.incarnation });
			this.#d.changed();
			if (row.kind === "main") this.#mainCrashed(row.id);
			this.#drainQueue();
		});
	}

	async #launch(row: SessionRow, live: Live): Promise<void> {
		const settings = this.#d.settings.get();
		if (!fs.existsSync(row.cwd)) throw new Error(`working directory ${row.cwd} is missing`);
		let worker: Parameters<typeof launchSpec>[0]["worker"] = null;
		let model: string | null;
		let thinking: string;
		if (row.kind === "worker") {
			const ws = this.#d.workspaces.must(row.workspace_id!);
			worker = { env: this.#d.envVars(row.worktree_id), protectedBranches: [ws.default_base], repoHooks: await hooksDir(row.cwd) };
			model = ws.worker_model ?? settings.workerModel;
			thinking = settings.workerThinking;
		} else {
			model = settings.mainModel;
			thinking = settings.mainThinking;
		}
		if (this.#live.get(row.id) !== live) return;
		fs.mkdirSync(row.session_dir, { recursive: true });
		const baseEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined && !k.startsWith("OMP_HOME_") && !k.startsWith("GIT_CONFIG_")) baseEnv[k] = v;
		}
		const spec = launchSpec({
			bin: this.#d.ompBin,
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
				plugin: path.join(this.#d.repoDir, "omp-plugin", row.kind),
				overlay: this.#d.paths.overlay(row.kind),
				pstackPackage: settings.pstackRoot && fs.existsSync(path.join(this.#d.paths.pstackPackage, "package.json")) ? this.#d.paths.pstackPackage : null,
				gitGuard: path.join(this.#d.repoDir, "git-guard"),
			},
			bridge: { url: this.#d.bridgeUrl, token: live.token },
			baseEnv,
			worker,
		});
		const pty = new PtyProcess(spec);
		live.pty = pty;
		live.proc = { s: "starting", pid: pty.pid, since: Date.now() };
		this.#d.db.run(
			"UPDATE session SET pid = ?, incarnation = ?, model = ?, thinking = ?, last_exit = NULL, last_activity = ? WHERE id = ?",
			pty.pid,
			live.incarnation,
			model ?? "",
			thinking,
			Date.now(),
			row.id,
		);
		for (const viewer of this.#viewers.get(row.id) ?? []) live.detach.set(viewer, pty.attach(viewer));
		live.helloTimer = setTimeout(() => {
			if (this.#live.get(row.id) !== live || live.connected) return;
			this.#writeViewers(row.id, `\r\n[omp-home] ${row.id} did not connect to the hub within ${HELLO_TIMEOUT_MS / 1000}s; stopping it.\r\n`);
			void pty.stop();
		}, HELLO_TIMEOUT_MS);
		this.#d.changed();
		void pty.exited.then(exit => this.#onExit(row.id, live, exit.exitCode));
	}

	#onExit(id: string, live: Live, exitCode: number): void {
		clearTimeout(live.helloTimer);
		if (this.#live.get(id) !== live) return;
		this.#live.delete(id);
		const intentional = live.proc.s === "stopping";
		this.#d.db.run("UPDATE session SET pid = NULL, last_exit = ?, last_activity = ? WHERE id = ?", live.running ? "lost" : "clean", Date.now(), id);
		this.#writeViewers(id, `\r\n[omp-home] ${id} exited (code ${exitCode}).\r\n`);
		const row = this.must(id);
		this.#d.exited(row, { intentional, wasRunning: live.running, neverConnected: !live.connected, exitCode, incarnation: live.incarnation });
		this.#d.changed();
		if (row.kind === "main" && !intentional && !this.#shuttingDown && row.retired_at === null) this.#mainCrashed(id);
		this.#drainQueue();
	}

	#mainCrashed(id: string): void {
		const now = Date.now();
		this.#mainFailures = [...this.#mainFailures.filter(t => now - t < MAIN_FAILURE_WINDOW_MS), now];
		if (this.#mainFailures.length >= MAIN_FAILURE_LIMIT) {
			this.#d.mainFailed(`The main chat exited ${MAIN_FAILURE_LIMIT} times in 5 minutes; automatic restarts stopped. Check ${this.must(id).session_dir} and use Restart main.`);
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
		if (!main) throw new HubError("not_found", "no main chat");
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

	/** Graceful stop: shutdown frame, then SIGTERM, then SIGKILL. Resolves when the process is gone. */
	async stop(id: string, why: "evict" | "retire" | "restart" | "shutdown"): Promise<void> {
		const live = this.#live.get(id);
		if (!live) return;
		if (live.proc.s === "stopping") {
			await live.pty?.exited;
			return;
		}
		if (!live.pty) {
			this.#live.delete(id);
			this.#d.changed();
			return;
		}
		live.proc = { s: "stopping", pid: live.pty.pid, why };
		this.#d.changed();
		if (this.#d.sendShutdown(id)) await Promise.race([live.pty.exited, sleep(SHUTDOWN_GRACE_MS)]);
		await live.pty.stop();
	}

	async evict(id: string): Promise<void> {
		const live = this.#live.get(id);
		if (live?.running) throw new HubError("conflict", `${id} is running a turn; cancel its task or wait for the turn to end`);
		this.#queue = this.#queue.filter(q => q !== id);
		await this.stop(id, "evict");
	}

	async retire(id: string): Promise<void> {
		this.must(id);
		this.#queue = this.#queue.filter(q => q !== id);
		await this.stop(id, "retire");
		this.#d.db.run("UPDATE session SET retired_at = coalesce(retired_at, ?) WHERE id = ?", Date.now(), id);
		this.#d.changed();
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
		clearTimeout(live.helloTimer);
		live.connected = true;
		if (live.proc.s === "starting") {
			const now = Date.now();
			live.proc = { s: "live", pid: live.proc.pid, since: now, run: "idle", approval: false, asyncJobs: 0, lastActivity: now };
		}
		this.#d.db.run("UPDATE session SET omp_session_id = ?, omp_session_file = coalesce(?, omp_session_file) WHERE id = ?", hello.ompSessionId, hello.sessionFile, id);
		this.#d.changed();
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
		this.#d.changed();
	}

	onApproval(id: string, open: boolean): void {
		const live = this.#live.get(id);
		if (live?.proc.s === "live") {
			live.proc = { ...live.proc, approval: open };
			this.#d.changed();
		}
	}

	/** Idle: live, connected, no run and no approval dialog. */
	isIdle(id: string): boolean {
		const live = this.#live.get(id);
		return !!live && live.connected && live.proc.s === "live" && live.proc.run === "idle" && !live.proc.approval;
	}

	// ── terminals ────────────────────────────────────────────────────────────

	/** Follow a session's terminal across restarts. Returns the detach function. */
	watch(id: string, viewer: PtyViewer): () => void {
		let set = this.#viewers.get(id);
		if (!set) this.#viewers.set(id, (set = new Set()));
		set.add(viewer);
		const live = this.#live.get(id);
		if (live?.pty) {
			live.detach.set(viewer, live.pty.attach(viewer));
			live.pty.repaint();
		} else {
			viewer.write(`\r\n[omp-home] ${id} is not running${this.queued(id) ? " (waiting for a worker slot)" : ""}.\r\n`);
		}
		return () => {
			set.delete(viewer);
			this.#live.get(id)?.detach.get(viewer)?.();
			this.#live.get(id)?.detach.delete(viewer);
		};
	}

	input(id: string, data: string): void {
		this.#live.get(id)?.pty?.input(data);
	}

	resize(id: string, cols: number, rows: number): void {
		this.#live.get(id)?.pty?.resize(cols, rows);
	}

	#writeViewers(id: string, text: string): void {
		for (const viewer of this.#viewers.get(id) ?? []) viewer.write(text);
	}

	// ── periodic work ────────────────────────────────────────────────────────

	/** Every 30 s: idle eviction, queued admissions, RSS sampling (display only). */
	async tick(): Promise<void> {
		const idleMs = this.#d.settings.get().idleEvictMinutes * 60_000;
		for (const id of idleVictims(this.#entries(), Date.now(), idleMs)) void this.stop(id, "evict");
		this.#drainQueue();
		const pids = [...this.#live.values()].map(l => l.pty?.pid).filter((p): p is number => !!p);
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
		for (const live of this.#live.values()) if (live.pty) live.rssKb = rss.get(live.pty.pid) ?? null;
		this.#d.changed();
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
