import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

/** Shared harness for hub end-to-end tests: a temp git repo, the hub as a child process, terminals. */

export const repoDir = path.resolve(import.meta.dirname, "..");
const hubs: ChildProcess[] = [];

export interface Sandbox {
	tmp: string;
	configDir: string;
	home: string;
	gitRepo: string;
	git(...args: string[]): string;
}

/** A temp dir with a one-commit git repo named `deckhand` on branch main. */
export function sandbox(): Sandbox {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omphome-e2e-")));
	const gitRepo = path.join(tmp, "deckhand");
	fs.mkdirSync(gitRepo);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: gitRepo, encoding: "utf8" }).trim();
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(gitRepo, "README.md"), "deckhand\n");
	git("add", ".");
	git("-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "init");
	return { tmp, configDir: path.join(tmp, "config"), home: path.join(tmp, "home"), gitRepo, git };
}

export function killHubs(): void {
	for (const h of hubs) if (h.exitCode === null) h.kill("SIGKILL");
}

export interface Hub {
	child: ChildProcess;
	port: number;
	token: string;
	exited: Promise<number | null>;
	api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }>;
}

export async function startHub(configDir: string, env: Record<string, string> = {}): Promise<Hub> {
	const child = spawn(process.execPath, [path.join(repoDir, "server/main.ts"), "--port", "0", "--no-open"], {
		env: { ...process.env, ...env, OMP_HOME_CONFIG_DIR: configDir, OMP_HOME_OMP_BIN: path.join(repoDir, "test/fake-omp.ts") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	hubs.push(child);
	let stderr = "";
	child.stderr!.on("data", d => (stderr += String(d)));
	const exited = once(child, "exit").then(([code]) => code as number | null);
	const { promise, resolve, reject } = Promise.withResolvers<{ port: number; token: string }>();
	let stdout = "";
	child.stdout!.on("data", d => {
		stdout += String(d);
		const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/.exec(stdout);
		if (m) resolve({ port: Number(m[1]), token: decodeURIComponent(m[2]!) });
	});
	void exited.then(code => reject(new Error(`hub exited (${code}) before listening:\n${stderr}`)));
	const { port, token } = await promise;
	return {
		child,
		port,
		token,
		exited,
		async api<T>(method: string, route: string, body?: unknown) {
			const res = await fetch(`http://127.0.0.1:${port}${route}`, {
				method,
				headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: res.status, body: (await res.json()) as T };
		},
	};
}

export async function until<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const v = await probe();
			if (v) return v;
		} catch (err) {
			last = err;
		}
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

/** A viewer on /api/term/:session that can type into the session's TUI. */
export class Term {
	readonly ws: WebSocket;
	out = "";

	constructor(hub: Hub, session: string) {
		this.ws = new WebSocket(`ws://127.0.0.1:${hub.port}/api/term/${session}?token=${hub.token}`);
		this.ws.on("message", d => (this.out += String(d)));
	}

	async open(): Promise<this> {
		if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, "open");
		return this;
	}

	type(line: string): void {
		this.ws.send(JSON.stringify({ type: "input", data: `${line}\r` }));
	}

	/** Wait for output matching `re` after offset `from` of `out`. */
	expect(re: RegExp, from = 0, timeoutMs = 20_000): Promise<string> {
		return until(`terminal output ${re}`, async () => re.exec(this.out.slice(from))?.[0], timeoutMs);
	}
}
