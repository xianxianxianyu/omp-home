import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** omp RPC protocol v1: one JSON object per line on stdio; omp keeps each frame within 1 MiB. */
export const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4096;

export type RpcFrame = Record<string, unknown> & { type: string };

export interface RpcSpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export interface RpcExit {
	code: number | null;
	signal: string | null;
	/** Spawn failure or the tail of stderr, for diagnostics. */
	detail: string;
}

export class RpcError extends Error {
	readonly code: string | null;

	constructor(message: string, code: string | null = null) {
		super(message);
		this.code = code;
	}
}

interface Pending {
	resolve(data: unknown): void;
	reject(err: Error): void;
	timer: NodeJS.Timeout;
}

/**
 * One omp process in `--mode rpc-ui`: JSONL framing on stdio, commands correlated to their
 * `response` by id, everything else handed to `onFrame` in arrival order.
 */
export class RpcClient {
	readonly pid: number;
	/** The `ready` frame: omp accepts commands from here on. Rejects if the process ends first. */
	readonly ready: Promise<RpcFrame>;
	readonly exited: Promise<RpcExit>;
	#child: ChildProcess;
	#onFrame: (frame: RpcFrame) => void;
	#pending = new Map<string, Pending>();
	#seq = 0;
	#buffer = "";
	#discarding = false;
	#stderr = "";
	#ready = false;
	#exit: RpcExit | null = null;

	constructor(spec: RpcSpec, onFrame: (frame: RpcFrame) => void) {
		this.#onFrame = onFrame;
		const ready = Promise.withResolvers<RpcFrame>();
		const exited = Promise.withResolvers<RpcExit>();
		this.ready = ready.promise;
		this.exited = exited.promise;
		this.ready.catch(() => {});
		let spawnError: string | null = null;

		this.#child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
		this.pid = this.#child.pid ?? 0;
		this.#child.stdin!.on("error", () => {});
		this.#child.stderr!.setEncoding("utf8");
		this.#child.stderr!.on("data", (chunk: string) => {
			this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL);
		});
		this.#child.stdout!.setEncoding("utf8");
		this.#child.stdout!.on("data", (chunk: string) => {
			for (const frame of this.#lines(chunk)) {
				if (!this.#ready && frame.type === "ready") {
					this.#ready = true;
					ready.resolve(frame);
					continue;
				}
				this.#dispatch(frame);
			}
		});
		this.#child.on("error", err => {
			spawnError = err.message;
		});
		this.#child.on("close", (code, signal) => {
			const detail = spawnError ?? this.#stderr.trim();
			this.#exit = { code, signal, detail };
			const err = new RpcError(`omp exited (${signal ?? `code ${code}`})${detail ? `: ${detail.slice(-500)}` : ""}`, "exited");
			if (!this.#ready) ready.reject(err);
			for (const p of this.#pending.values()) {
				clearTimeout(p.timer);
				p.reject(err);
			}
			this.#pending.clear();
			exited.resolve(this.#exit);
		});
	}

	get alive(): boolean {
		return this.#exit === null;
	}

	*#lines(chunk: string): Generator<RpcFrame> {
		this.#buffer += chunk;
		let start = 0;
		let nl: number;
		while ((nl = this.#buffer.indexOf("\n", start)) !== -1) {
			const line = this.#buffer.slice(start, nl);
			start = nl + 1;
			if (this.#discarding) {
				this.#discarding = false;
				continue;
			}
			const frame = parseFrame(line);
			if (frame) yield frame;
		}
		this.#buffer = this.#buffer.slice(start);
		// A runaway line (not omp's protocol) must not grow memory without bound.
		if (this.#buffer.length > MAX_FRAME_BYTES * 2) {
			this.#buffer = "";
			this.#discarding = true;
		}
	}

	#dispatch(frame: RpcFrame): void {
		if (frame.type === "response" && typeof frame.id === "string") {
			const pending = this.#pending.get(frame.id);
			if (pending) {
				this.#pending.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.success === true) pending.resolve(frame.data);
				else pending.reject(new RpcError(typeof frame.error === "string" ? frame.error : `${String(frame.command)} failed`, typeof frame.code === "string" ? frame.code : null));
				return;
			}
		}
		this.#onFrame(frame);
	}

	/** Send a command and resolve with its `data` (or reject with the server's error). */
	request(type: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		const id = `h${++this.#seq}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new RpcError(`omp did not answer ${type} within ${timeoutMs / 1000}s`, "timeout"));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		try {
			this.send({ ...params, id, type });
		} catch (err) {
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
		return promise;
	}

	/** Write one non-command frame (e.g. `extension_ui_response`). */
	send(frame: Record<string, unknown>): void {
		if (!this.alive) throw new RpcError("omp is not running", "exited");
		const line = JSON.stringify(frame);
		if (Buffer.byteLength(line, "utf8") + 1 > MAX_FRAME_BYTES) throw new RpcError("message exceeds omp's 1 MiB frame limit", "too_large");
		this.#child.stdin!.write(`${line}\n`);
	}

	/**
	 * Graceful stop: close stdin (omp exits on EOF), then SIGTERM, then SIGKILL. omp reads stdin
	 * only once it is `ready`; startup can take seconds (first launch of a new binary), so a process
	 * that is not ready yet gets SIGTERM at once instead of an EOF it would not see in time.
	 */
	async stop(graceMs: number): Promise<RpcExit> {
		if (this.#exit) return this.#exit;
		this.#child.stdin!.end();
		if (this.#ready && (await settlesWithin(this.exited, graceMs))) return this.exited;
		this.#child.kill("SIGTERM");
		if (await settlesWithin(this.exited, 2000)) return this.exited;
		this.#child.kill("SIGKILL");
		return this.exited;
	}
}

function parseFrame(line: string): RpcFrame | null {
	if (!line.trim()) return null;
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value && typeof value.type === "string") return { ...value, type: value.type };
	} catch {
		// omp writes only JSON to stdout; anything else is noise from a misbehaving child.
	}
	return null;
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	const timeout = sleep(ms).then(() => false);
	return Promise.race([promise.then(() => true), timeout]);
}
