import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_PORT = 4777;
export const DEFAULT_HOME = "/Volumes/NVMe2T/project/home";

/** Install-level config outside the home repo: where the home is, and the UI token. */
export interface HubConfig {
	homePath: string | null;
	token: string;
	port: number;
}

const configSchema = z.object({
	homePath: z.string().nullable(),
	token: z.string().min(16),
	port: z.number().int().min(1).max(65535),
});

export function configDir(): string {
	return process.env.OMP_HOME_CONFIG_DIR ?? path.join(os.homedir(), ".config", "omp-home");
}

export function loadConfig(): HubConfig {
	const file = path.join(configDir(), "config.json");
	let text: string | null = null;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (text === null) {
		const fresh: HubConfig = { homePath: null, token: randomBytes(24).toString("base64url"), port: DEFAULT_PORT };
		saveConfig(fresh);
		return fresh;
	}
	const parsed = configSchema.safeParse(JSON.parse(text));
	if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
	return parsed.data;
}

export function saveConfig(config: HubConfig): void {
	const file = path.join(configDir(), "config.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function writeFileAtomic(file: string, content: string, mode = 0o644): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, content, { mode });
	fs.renameSync(tmp, file);
}

/** Every hub-owned location inside a home repo. `.omp-home/` is gitignored; `repos/` is versioned. */
export interface HomePaths {
	home: string;
	data: string;
	db: string;
	chat: string;
	sessions: string;
	logs: string;
	envLogs: string;
	serviceLogs: string;
	run: string;
	pstackPackage: string;
	backup: string;
	repos: string;
	agents: string;
	overlay(role: "main" | "worker"): string;
}

export function homePaths(home: string): HomePaths {
	const data = path.join(home, ".omp-home");
	const run = path.join(data, "run");
	return {
		home,
		data,
		db: path.join(data, "home.db"),
		chat: path.join(data, "chat"),
		sessions: path.join(data, "sessions"),
		logs: path.join(data, "logs"),
		envLogs: path.join(data, "logs", "env"),
		serviceLogs: path.join(data, "logs", "services"),
		run,
		pstackPackage: path.join(run, "pstack"),
		backup: path.join(data, "backup"),
		repos: path.join(home, "repos"),
		agents: path.join(home, "AGENTS.md"),
		overlay: role => path.join(run, `${role}.yml`),
	};
}
