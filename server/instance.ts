import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./config.ts";

/** Exit code when another hub already serves this config dir (EX_TEMPFAIL). */
export const ALREADY_RUNNING_EXIT = 75;

const lockSchema = z.object({ pid: z.number().int(), url: z.string().nullable() });
export type LockInfo = z.infer<typeof lockSchema>;

export type LockResult = { held: true; lock: HubLock } | { held: false; other: LockInfo };

/** `<configDir>/hub.lock`: one hub per config dir. A lock whose pid is not a live hub is stale and taken over. */
export class HubLock {
	readonly file: string;

	private constructor(file: string) {
		this.file = file;
	}

	static acquire(configDir: string): LockResult {
		fs.mkdirSync(configDir, { recursive: true });
		const file = path.join(configDir, "hub.lock");
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const fd = fs.openSync(file, "wx", 0o600);
				fs.writeSync(fd, JSON.stringify({ pid: process.pid, url: null } satisfies LockInfo));
				fs.closeSync(fd);
				return { held: true, lock: new HubLock(file) };
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
			const other = readLock(file);
			if (other && other.pid !== process.pid && isHub(other.pid)) return { held: false, other };
			// Stale (dead pid, a reused pid, or unreadable): remove it and race for a fresh exclusive create.
			fs.rmSync(file, { force: true });
		}
		throw new Error(`could not take ${file}; another hub keeps replacing it`);
	}

	/** The current holder, if any (used to wait for a starting hub's URL). */
	static peek(configDir: string): LockInfo | null {
		return readLock(path.join(configDir, "hub.lock"));
	}

	/** Record the URL once listening, so a second launch can point at this hub. */
	publish(url: string): void {
		writeFileAtomic(this.file, JSON.stringify({ pid: process.pid, url } satisfies LockInfo), 0o600);
	}

	release(): void {
		if (readLock(this.file)?.pid === process.pid) fs.rmSync(this.file, { force: true });
	}
}

function readLock(file: string): LockInfo | null {
	try {
		const parsed = lockSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Alive and running a hub entry point (a recycled pid belongs to some other program). */
function isHub(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	try {
		const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
		return /hub\.mjs|server\/main\.ts/.test(command);
	} catch {
		return false;
	}
}

/**
 * Apps launched from Finder get launchd's minimal environment. Adopt the user's login-shell
 * environment (PATH, toolchains, API keys) once at startup; it then reaches omp children and
 * recipe commands through `process.env`. The hub's own OMP_HOME_* settings are kept.
 */
export function adoptLoginEnv(log: (message: string) => void): void {
	const shell = process.env.SHELL || "/bin/zsh";
	const marker = `__omp_home_env_${randomBytes(6).toString("hex")}__`;
	const r = spawnSync(shell, ["-l", "-i", "-c", `printf '\\n%s\\n' ${marker}; "$OMP_HOME_NODE" -p 'JSON.stringify(process.env)'`], {
		env: { ...process.env, OMP_HOME_NODE: process.execPath },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	const json = r.stdout?.split(`\n${marker}\n`)[1]?.trim();
	const parsed = json ? z.record(z.string(), z.string()).safeParse(safeJson(json)) : null;
	if (!parsed?.success) {
		log(`login environment: ${shell} -lic failed (${r.error?.message ?? `exit ${r.status}`}); keeping the launch environment`);
		return;
	}
	for (const [key, value] of Object.entries(parsed.data)) {
		if (!key.startsWith("OMP_HOME_")) process.env[key] = value;
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
