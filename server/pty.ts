import { spawn, type IPty } from "@lydell/node-pty";

/** Bytes of terminal output kept per process so a reattaching viewer sees recent screen state. */
const SCROLLBACK_LIMIT = 2 * 1024 * 1024;

export interface PtySpec {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

export interface PtyViewer {
	write(data: string): void;
}

export interface PtyExit {
	exitCode: number;
	signal?: number;
}

/**
 * One live terminal process. Output is fanned out to every attached viewer and
 * retained (bounded) so a viewer attaching later can replay the screen.
 */
export class PtyProcess {
	readonly pid: number;
	#pty: IPty;
	#chunks: string[] = [];
	#size = 0;
	#viewers = new Set<PtyViewer>();
	#cols = 140;
	#rows = 45;
	readonly exited: Promise<PtyExit>;

	constructor(spec: PtySpec) {
		this.#pty = spawn(spec.command, spec.args, {
			name: "xterm-256color",
			cols: this.#cols,
			rows: this.#rows,
			cwd: spec.cwd,
			env: spec.env,
		});
		this.pid = this.#pty.pid;
		const { promise, resolve } = Promise.withResolvers<PtyExit>();
		this.exited = promise;
		this.#pty.onExit(e => resolve({ exitCode: e.exitCode, signal: e.signal }));
		this.#pty.onData(data => {
			this.#chunks.push(data);
			this.#size += data.length;
			while (this.#size > SCROLLBACK_LIMIT && this.#chunks.length > 1) this.#size -= this.#chunks.shift()!.length;
			for (const viewer of this.#viewers) viewer.write(data);
		});
	}

	/** Attach a viewer; it immediately receives the retained scrollback. Returns the detach function. */
	attach(viewer: PtyViewer): () => void {
		this.#viewers.add(viewer);
		if (this.#chunks.length) viewer.write(this.#chunks.join(""));
		return () => this.#viewers.delete(viewer);
	}

	input(data: string): void {
		this.#pty.write(data);
	}

	resize(cols: number, rows: number): void {
		if (cols < 20 || rows < 5 || (cols === this.#cols && rows === this.#rows)) return;
		this.#cols = cols;
		this.#rows = rows;
		this.#pty.resize(cols, rows);
	}

	/** Force a full-screen repaint (a fresh viewer has no screen state): shrink by one column, then restore. */
	repaint(): void {
		const resize = (cols: number) => {
			try {
				this.#pty.resize(cols, this.#rows);
			} catch {
				// the process already exited
			}
		};
		resize(this.#cols - 1);
		setTimeout(() => resize(this.#cols), 80);
	}

	/** Ask the process to exit; escalate to SIGKILL if it ignores SIGTERM. */
	async stop(graceMs = 4000): Promise<PtyExit> {
		const kill = (signal: string) => {
			try {
				this.#pty.kill(signal);
			} catch {
				// already exited
			}
		};
		kill("SIGTERM");
		const timer = setTimeout(() => kill("SIGKILL"), graceMs);
		const exit = await this.exited;
		clearTimeout(timer);
		return exit;
	}
}
