#!/usr/bin/env node
/**
 * Builds the self-contained hub the desktop app ships:
 *   dist/hub/hub.mjs            server/main.ts with every dependency inlined (run by the bundled Node)
 *   dist/hub/resources/         schema.sql, web/dist, omp-plugin/{main,worker,dist/bridge.js}, git-guard, templates
 *   omp-plugin/dist/bridge.js   the bridge extension with zod and shared/* inlined, so omp's Bun loads it without node_modules
 * Run: node scripts/build-hub.mjs   (also builds the UI)
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const vitePkg = require.resolve("vite/package.json");
// rolldown is vite's bundler; resolve it through vite instead of a second direct dependency.
const { build } = await import(pathToFileURL(createRequire(vitePkg).resolve("rolldown")).href);
const { build: viteBuild } = await import(pathToFileURL(require.resolve("vite")).href);

const out = path.join(root, "dist", "hub");
const resources = path.join(out, "resources");
const bridgeOut = path.join(root, "omp-plugin", "dist", "bridge.js");

await viteBuild({ root: path.join(root, "web"), logLevel: "warn" });

fs.rmSync(out, { recursive: true, force: true });
await build({
	input: path.join(root, "server", "main.ts"),
	platform: "node",
	logLevel: "warn",
	output: { file: path.join(out, "hub.mjs"), format: "esm", codeSplitting: false },
});
await build({
	input: path.join(root, "omp-plugin", "bridge.ts"),
	platform: "node",
	external: [/^@oh-my-pi\//],
	logLevel: "warn",
	output: { file: bridgeOut, format: "esm", codeSplitting: false },
});

const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(resources, to), { recursive: true });
copy("server/schema.sql", "schema.sql");
copy("web/dist", "web/dist");
for (const role of ["main", "worker"]) copy(`omp-plugin/${role}`, `omp-plugin/${role}`);
copy("omp-plugin/dist/bridge.js", "omp-plugin/dist/bridge.js");
copy("git-guard", "git-guard");
copy("templates", "templates");

const size = file => `${(fs.statSync(file).size / 1024).toFixed(0)} KiB`;
process.stdout.write(`hub ${path.relative(root, path.join(out, "hub.mjs"))} (${size(path.join(out, "hub.mjs"))}), bridge ${path.relative(root, bridgeOut)} (${size(bridgeOut)}), resources ${path.relative(root, resources)}\n`);
