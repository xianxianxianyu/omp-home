import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { emptyTranscript, reduceTranscript, type Item, type TranscriptEvent, type TranscriptView } from "../shared/transcript.ts";

/** Shared harness for hub end-to-end tests: a temp git repo, the hub as a child process, session streams. */

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

function spawnHub(configDir: string, env: Record<string, string>): ChildProcess {
	return spawn(process.execPath, [path.join(repoDir, "server/main.ts"), "--port", "0", "--no-open"], {
		env: { ...process.env, HOME: path.join(configDir, "user-home"), PI_CODING_AGENT_DIR: path.join(configDir, "agent"), ...env, OMP_HOME_CONFIG_DIR: configDir, OMP_HOME_OMP_BIN: path.join(repoDir, "test/fake-omp.ts") },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Run a hub to completion (e.g. a second instance that must refuse to start). */
export async function runHub(configDir: string): Promise<{ code: number | null; stdout: string }> {
	const child = spawnHub(configDir, {});
	hubs.push(child);
	let stdout = "";
	child.stdout!.on("data", d => (stdout += String(d)));
	const [code] = (await once(child, "exit")) as [number | null];
	return { code, stdout };
}

export async function startHub(configDir: string, env: Record<string, string> = {}): Promise<Hub> {
	const child = spawnHub(configDir, env);
	hubs.push(child);
	let stderr = "";
	child.stderr!.on("data", d => (stderr += String(d)));
	const exited = once(child, "exit").then(([code]) => code as number | null);
	const { promise, resolve, reject } = Promise.withResolvers<{ port: number; token: string }>();
	let stdout = "";
	child.stdout!.on("data", d => {
		stdout += String(d);
		const m = /^omp-home ready http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)$/m.exec(stdout);
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

function itemText(item: Item): string {
	switch (item.kind) {
		case "user":
		case "notice":
			return item.text;
		case "assistant":
			return item.streaming ? "" : item.blocks.flatMap(b => (b.kind === "text" ? [b.text] : [])).join("");
		case "request":
			return "title" in item.request ? item.request.title : "ask";
	}
}

/**
 * A UI on WS /api/sessions/:id/stream: folds every event into `view` like the web UI, and logs
 * finished items, status-line changes and answers into `out` for `expect`.
 */
export class Stream {
	readonly ws: WebSocket;
	readonly events: TranscriptEvent[] = [];
	view: TranscriptView = emptyTranscript();
	out = "";
	closed: { code: number; reason: string } | null = null;
	readonly #hub: Hub;
	readonly #session: string;
	readonly #sessionDir: string;

	/** `home` locates the fake omp's agent script for `agent()`. */
	constructor(hub: Hub, session: string, home: string) {
		this.#hub = hub;
		this.#session = session;
		this.#sessionDir = path.join(home, ".omp-home", session.startsWith("M-") ? "chat" : "sessions", session);
		this.ws = new WebSocket(`ws://127.0.0.1:${hub.port}/api/sessions/${session}/stream?token=${hub.token}`);
		this.ws.on("message", d => {
			const ev = JSON.parse(String(d)) as TranscriptEvent;
			this.events.push(ev);
			this.view = reduceTranscript(this.view, ev);
			if (ev.t === "reset") this.out += `${[...ev.view.items.map(itemText), ...Object.values(ev.view.status.statusLine)].join("\n")}\n`;
			else if (ev.t === "item" && itemText(ev.item)) this.out += `${itemText(ev.item)}\n`;
			else if (ev.t === "status" && ev.patch.statusLine) this.out += `${Object.values(ev.patch.statusLine).join("\n")}\n`;
			else if (ev.t === "request_closed") this.out += `answered ${ev.answer}\n`;
		});
		this.ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason) }));
	}

	async open(): Promise<this> {
		if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, "open");
		return this;
	}

	/** The human types into the session's composer. */
	async prompt(text: string, mode?: "auto" | "steer" | "followUp"): Promise<void> {
		const r = await this.#hub.api("POST", `/api/sessions/${this.#session}/prompt`, { text, ...(mode ? { mode } : {}) });
		if (r.status !== 200) throw new Error(`prompt failed: ${r.status} ${JSON.stringify(r.body)}`);
	}

	/** The session's agent acts on its own (fake omp: `/dispatch …`, `/call <tool> …`); not human input. */
	agent(line: string): void {
		fs.appendFileSync(path.join(this.#sessionDir, "fake-agent.txt"), `${line}\n`);
	}

	/** Wait for output matching `re` after offset `from` of `out`. */
	expect(re: RegExp, from = 0, timeoutMs = 20_000): Promise<string> {
		return until(`stream output ${re}`, async () => re.exec(this.out.slice(from))?.[0], timeoutMs);
	}

	close(): void {
		this.ws.close();
	}
}
