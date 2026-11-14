import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { HubServer } from "./http.ts";

/** Entry: `node server/main.ts [--port N] [--no-open]`. */
const { values } = parseArgs({
	options: { port: { type: "string" }, "no-open": { type: "boolean", default: false } },
	strict: true,
});

const repoDir = path.resolve(import.meta.dirname, "..");
const version = (JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
const config = loadConfig();
const port = values.port ? Number(values.port) : config.port;
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port ${values.port}`);

const log = (message: string) => process.stderr.write(`[omp-home ${new Date().toISOString()}] ${message}\n`);
const server = new HubServer({ config, repoDir, ompBin: process.env.OMP_HOME_OMP_BIN ?? "omp", version, log });
const bound = await server.listen(port);
await server.boot();

const url = `http://127.0.0.1:${bound}/?token=${encodeURIComponent(config.token)}`;
process.stdout.write(`omp-home ${version} listening on ${url}\n${config.homePath ? `home: ${config.homePath}` : "first run: open the URL to choose the home repo"}\n`);
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
