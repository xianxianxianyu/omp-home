import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { configDir, loadConfig, saveConfig } from "./config.ts";
import { HubServer } from "./http.ts";
import { adoptLoginEnv, ALREADY_RUNNING_EXIT, HubLock } from "./instance.ts";
import { resolveResources } from "./resources.ts";

/**
 * Entry: `node server/main.ts [--port N] [--no-open]` (bundled: `node hub.mjs`).
 * Env: OMP_HOME_CONFIG_DIR, OMP_HOME_RESOURCES, OMP_HOME_LOGIN_ENV=1, OMP_HOME_OMP_BIN (tests).
 * stdout carries exactly one machine-readable line: `omp-home ready <url>` once serving, or
 * `omp-home already running <url>` with exit code 75 when another hub holds this config dir.
 */
const { values } = parseArgs({
	options: { port: { type: "string" }, "no-open": { type: "boolean", default: false } },
	strict: true,
});
const requestedPort = values.port === undefined ? null : Number(values.port);
if (requestedPort !== null && (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)) throw new Error(`invalid --port ${values.port}`);

const log = (message: string) => process.stderr.write(`[omp-home ${new Date().toISOString()}] ${message}\n`);
if (process.env.OMP_HOME_LOGIN_ENV === "1") adoptLoginEnv(log);

const dir = configDir();
const taken = HubLock.acquire(dir);
if (!taken.held) {
	let other = taken.other;
	for (let i = 0; i < 100 && other.url === null; i++) {
		await sleep(100);
		other = HubLock.peek(dir) ?? other;
	}
	process.stdout.write(`omp-home already running ${other.url ?? `(pid ${other.pid}, still starting)`}\n`);
	process.exit(ALREADY_RUNNING_EXIT);
}
const lock = taken.lock;
process.on("exit", () => lock.release());

const config = loadConfig();
const server = new HubServer({ config, configDir: dir, resources: resolveResources(), version: pkg.version, log });
let port: number;
if (requestedPort !== null) {
	port = await server.listen(requestedPort);
} else {
	try {
		port = await server.listen(config.port);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
		port = await server.listen(0);
		log(`port ${config.port} is in use; using ${port} from now on`);
		config.port = port;
		saveConfig(config);
	}
}
const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(config.token)}`;
lock.publish(url);
await server.boot();

process.stdout.write(`omp-home ${pkg.version} listening on ${url}\n${config.homePath ? `home: ${config.homePath}` : "first run: open the URL to choose the home repo"}\nomp-home ready ${url}\n`);
if (!values["no-open"] && process.platform === "darwin") execFile("open", [url], () => {});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	log(`${signal}: stopping omp sessions`);
	const force = setTimeout(() => process.exit(1), 30_000);
	force.unref();
	await server.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
