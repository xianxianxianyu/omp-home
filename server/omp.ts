import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { Language, OmpDTO } from "../shared/api.ts";
import { BRIDGE_ENV } from "../shared/bridge-wire.ts";
import { toolsFor } from "../shared/tools.ts";
import { writeFileAtomic } from "./config.ts";
import { errorMessage, HubError } from "./errors.ts";
import { render, type Message } from "./i18n.ts";
import { runtimeMessages as m } from "./i18n-runtime.ts";
import { RpcClient } from "./rpc.ts";
import { OVERLAY_BASE } from "./settings.ts";

const execFileP = promisify(execFile);
const CHECK_TIMEOUT_MS = 60_000;
/** Searched after PATH: where omp's installer and package managers put it (Finder-launched apps get a minimal PATH). */
const COMMON_DIRS = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

const currentSchema = z.object({ version: z.string().min(1) });

function executable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export async function ompVersion(bin: string): Promise<string | null> {
	const out = await execFileP(bin, ["--version"], { timeout: 15_000 }).then(
		r => r.stdout,
		() => "",
	);
	return /(\d+\.\d+\.\d+[\w.+-]*)/.exec(out)?.[1] ?? null;
}

/**
 * Compatibility self-check without model calls: start `bin` in RPC mode with the main
 * bridge package in a throwaway session dir, against a temporary bridge listener. Passes
 * when omp sends `ready`, the bridge says `hello`, and `get_state` lists main's home_* tools.
 * Returns null on success, else the reason.
 */
export async function selfCheck(bin: string, pluginDir: string, language: Language = "en"): Promise<string | null> {
	const failure = await compatibilityFailure(bin, pluginDir);
	return failure === null ? null : render(failure, language);
}

async function compatibilityFailure(bin: string, pluginDir: string): Promise<string | Message | null> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-check-"));
	const overlay = path.join(tmp, "overlay.yml");
	fs.writeFileSync(overlay, stringify(OVERLAY_BASE));
	const token = randomBytes(24).toString("hex");
	const hello = Promise.withResolvers<void>();
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	wss.on("connection", (ws, req) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.searchParams.get("token") !== token) return ws.close();
		ws.on("message", data => {
			if (/"t"\s*:\s*"hello"/.test(String(data))) hello.resolve();
		});
		ws.send(JSON.stringify({ t: "welcome", session: "M-1" }));
	});
	let rpc: RpcClient | null = null;
	const expired = Promise.withResolvers<never>();
	expired.promise.catch(() => {});
	const timer = setTimeout(() => expired.reject(new HubError("unavailable", m.checkTimeout(CHECK_TIMEOUT_MS / 1000))), CHECK_TIMEOUT_MS);
	const deadline = expired.promise;
	try {
		await once(wss, "listening");
		const address = wss.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("OMP_HOME_")) env[k] = v;
		Object.assign(env, { [BRIDGE_ENV.role]: "main", [BRIDGE_ENV.url]: `ws://127.0.0.1:${port}/bridge`, [BRIDGE_ENV.token]: token, [BRIDGE_ENV.session]: "M-1" });
		const client = new RpcClient(
			{
				command: bin,
				args: ["--mode", "rpc-ui", "--cwd", tmp, "--session-dir", path.join(tmp, "sessions"), "--config", overlay, "-e", path.join(pluginDir, "main"), "--no-title", "--approval-mode", "yolo"],
				cwd: tmp,
				env,
			},
			() => {},
		);
		rpc = client;
		await Promise.race([client.ready, deadline]);
		await Promise.race([hello.promise, client.exited.then(e => Promise.reject(new HubError("unavailable", m.checkExited(e.detail)))), deadline]).catch(err => {
			throw new HubError("unavailable", m.bridgeDisconnected(errorMessage(err)));
		});
		const state = await client.request("get_state");
		const dumped = z.object({ dumpTools: z.array(z.object({ name: z.string() })) }).safeParse(state);
		if (!dumped.success) return m.missingToolList();
		const names = new Set(dumped.data.dumpTools.map(t => t.name));
		const missing = toolsFor("main").filter(t => !names.has(t));
		return missing.length ? m.missingBridgeTools(missing.join(", ")) : null;
	} catch (err) {
		return errorMessage(err);
	} finally {
		clearTimeout(timer);
		await rpc?.stop(2000);
		wss.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

export interface OmpOptions {
	/** `<configDir>`; managed copies live in `<configDir>/omp/<version>/omp`. */
	configDir: string;
	pluginDir: string;
	log(message: string): void;
}

type OmpStatus = Omit<OmpDTO, "warning"> & { warning: string | Message | null };

/**
 * Which omp binary the hub spawns. Order: an explicit path (settings.ompPath; tests use
 * OMP_HOME_OMP_BIN) → the managed copy → omp on PATH / common install dirs. A PATH omp whose
 * version differs from the managed copy is self-checked first: passing copies it in as the
 * new managed copy; failing keeps the previous copy and reports a warning.
 */
export class OmpManager {
	readonly #o: OmpOptions;
	readonly #root: string;
	#status: OmpStatus = { version: null, path: null, managed: false, warning: m.ompUnresolved() };

	constructor(opts: OmpOptions) {
		this.#o = opts;
		this.#root = path.join(opts.configDir, "omp");
	}

	status(language: Language = "en"): OmpDTO {
		return { ...this.#status, warning: this.#status.warning === null ? null : render(this.#status.warning, language) };
	}

	bin(): string {
		if (!this.#status.path) throw new HubError("unavailable", this.#status.warning ?? m.ompNotFound());
		return this.#status.path;
	}

	/** Resolve (and possibly install) the binary. Returns a warning worth showing the human, if any. */
	async resolve(explicit: string | null): Promise<OmpDTO> {
		this.#status = await this.#resolve(explicit ?? process.env.OMP_HOME_OMP_BIN ?? null);
		if (this.#status.warning) this.#o.log(`omp: ${render(this.#status.warning)}`);
		return this.status();
	}

	async #resolve(explicit: string | null): Promise<OmpStatus> {
		if (explicit) {
			if (!executable(explicit)) return { version: null, path: null, managed: false, warning: m.ompNotExecutable(explicit) };
			return { version: await ompVersion(explicit), path: explicit, managed: false, warning: null };
		}
		const managed = this.#current();
		const found = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...COMMON_DIRS].map(dir => path.join(dir, "omp")).find(executable);
		if (!found) {
			if (managed) return { ...managed, managed: true, warning: null };
			return { version: null, path: null, managed: false, warning: m.ompMissing(COMMON_DIRS.join(", ")) };
		}
		const version = await ompVersion(found);
		if (managed && version === managed.version) return { ...managed, managed: true, warning: null };
		const failure = version ? await compatibilityFailure(found, this.#o.pluginDir) : m.ompNoVersion(found);
		if (failure === null) {
			const installed = this.#install(found, version!);
			this.#o.log(`omp: ${found} ${version} passed the compatibility check; using the managed copy ${installed}`);
			return { version, path: installed, managed: true, warning: null };
		}
		const reason = m.ompCheckFailed(version, found, failure);
		if (managed) return { ...managed, managed: true, warning: m.ompKeepingManaged(reason, managed.version) };
		return { version, path: found, managed: false, warning: m.ompUsingUnchecked(reason) };
	}

	#current(): { version: string; path: string } | null {
		try {
			const parsed = currentSchema.safeParse(JSON.parse(fs.readFileSync(path.join(this.#root, "current.json"), "utf8")));
			if (!parsed.success) return null;
			const bin = path.join(this.#root, parsed.data.version, "omp");
			return executable(bin) ? { version: parsed.data.version, path: bin } : null;
		} catch {
			return null;
		}
	}

	/** Copy atomically into `<root>/<version>/omp`, point current.json at it, drop other versions. */
	#install(source: string, version: string): string {
		const dir = path.join(this.#root, version);
		const bin = path.join(dir, "omp");
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${bin}.${process.pid}.tmp`;
		fs.copyFileSync(source, tmp);
		fs.chmodSync(tmp, 0o755);
		fs.renameSync(tmp, bin);
		writeFileAtomic(path.join(this.#root, "current.json"), `${JSON.stringify({ version })}\n`);
		for (const entry of fs.readdirSync(this.#root, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name !== version) fs.rmSync(path.join(this.#root, entry.name), { recursive: true, force: true });
		}
		return bin;
	}
}
