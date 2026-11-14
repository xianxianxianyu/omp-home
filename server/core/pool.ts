import type { ProcState } from "../../shared/api.ts";
import { BRIDGE_ENV } from "../../shared/bridge-wire.ts";

/** Process admission and launch policy. Pure: no I/O. */

export type Proc =
	| { s: "cold" }
	| { s: "starting"; pid: number; since: number }
	| { s: "live"; pid: number; since: number; run: "idle" | "running"; approval: boolean; asyncJobs: number; lastActivity: number }
	| { s: "stopping"; pid: number; why: "evict" | "retire" | "restart" | "shutdown" };

export interface PoolEntry {
	id: string;
	kind: "main" | "worker";
	proc: Proc;
	viewers: number;
	openEscalation: boolean;
}

/** A worker idle long enough is evictable unless something would be lost or someone is watching. */
export function evictable(e: PoolEntry, now: number, minIdleMs: number): boolean {
	return (
		e.kind === "worker" &&
		e.proc.s === "live" &&
		e.proc.run === "idle" &&
		!e.proc.approval &&
		e.proc.asyncJobs === 0 &&
		e.viewers === 0 &&
		!e.openEscalation &&
		now - e.proc.lastActivity >= minIdleMs
	);
}

export type Admission = { kind: "spawn" } | { kind: "evict_then_spawn"; victim: string } | { kind: "queue" };

export function liveWorkers(pool: readonly PoolEntry[]): number {
	return pool.filter(e => e.kind === "worker" && e.proc.s !== "cold").length;
}

/** Workers count against the cap; the human may exceed it by one so they are never blocked by agents. */
export function admit(req: { human: boolean }, pool: readonly PoolEntry[], cap: number, now: number, minIdleMs: number): Admission {
	const live = liveWorkers(pool);
	if (live < cap) return { kind: "spawn" };
	const victim = pool
		.filter(e => evictable(e, now, minIdleMs))
		.sort((a, b) => (a.proc.s === "live" && b.proc.s === "live" ? a.proc.lastActivity - b.proc.lastActivity : 0))[0];
	if (victim) return { kind: "evict_then_spawn", victim: victim.id };
	if (req.human && live < cap + 1) return { kind: "spawn" };
	return { kind: "queue" };
}

export function idleVictims(pool: readonly PoolEntry[], now: number, idleEvictMs: number): string[] {
	return pool.filter(e => evictable(e, now, idleEvictMs)).map(e => e.id);
}

export function procState(p: Proc): ProcState {
	if (p.s === "live") return p.approval ? "approval" : p.run === "running" ? "running" : "idle";
	return p.s;
}

export interface LaunchInput {
	bin: string;
	session: { id: string; kind: "main" | "worker"; cwd: string; sessionDir: string; resumeFile: string | null; model: string | null; thinking: string };
	paths: { plugin: string; overlay: string; pstackPackage: string | null; gitGuard: string };
	bridge: { url: string; token: string };
	baseEnv: Record<string, string>;
	worker: { env: Record<string, string>; protectedBranches: string[]; repoHooks: string } | null;
}

export interface LaunchSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export function launchSpec(i: LaunchInput): LaunchSpec {
	const s = i.session;
	const args = ["--cwd", s.cwd, "--session-dir", s.sessionDir, "--config", i.paths.overlay, "-e", i.paths.plugin];
	if (i.paths.pstackPackage) args.push("-e", i.paths.pstackPackage);
	if (s.model) args.push("--model", s.model);
	args.push("--thinking", s.thinking, "--approval-mode", "yolo", "--no-title");
	if (s.resumeFile) args.push("--resume", s.resumeFile);
	const env: Record<string, string> = {
		...i.baseEnv,
		...(i.worker?.env ?? {}),
		[BRIDGE_ENV.role]: s.kind,
		[BRIDGE_ENV.url]: i.bridge.url,
		[BRIDGE_ENV.token]: i.bridge.token,
		[BRIDGE_ENV.session]: s.id,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};
	if (i.worker) {
		Object.assign(env, {
			[BRIDGE_ENV.protectedBranches]: i.worker.protectedBranches.join(","),
			OMP_HOME_WORKER: "1",
			OMP_HOME_REPO_HOOKS: i.worker.repoHooks,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: i.paths.gitGuard,
		});
	}
	return { command: i.bin, args, cwd: s.cwd, env };
}
