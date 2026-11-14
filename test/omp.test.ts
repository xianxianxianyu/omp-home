import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { OmpManager, selfCheck } from "../server/omp.ts";

/**
 * omp resolution and the compatibility self-check, with test/fake-omp.ts (RPC + bridge, no
 * model) standing in for a compatible omp and a shell script for an incompatible one.
 */

const repo = path.resolve(import.meta.dirname, "..");
const fake = path.join(repo, "test", "fake-omp.ts");
const pluginDir = path.join(repo, "omp-plugin");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-omp-"));
const savedPath = process.env.PATH;
after(() => {
	process.env.PATH = savedPath;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A PATH whose first entry holds `omp`; node stays reachable for the fake's shebang. */
function binDir(name: string, omp: (file: string) => void): string {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	omp(path.join(dir, "omp"));
	return [dir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
}

test("self-check: ready, bridge hello and the main tools in get_state pass; a non-RPC binary fails", { timeout: 60_000 }, async () => {
	assert.equal(await selfCheck(fake, pluginDir), null);
	const failure = await selfCheck("/bin/echo", pluginDir);
	assert.match(failure ?? "", /omp exited/);
});

test("a passing PATH omp becomes the managed copy; a failing newer one keeps it with a warning", { timeout: 60_000 }, async () => {
	const configDir = path.join(tmp, "config");
	const logs: string[] = [];
	const omp = new OmpManager({ configDir, pluginDir, log: m => logs.push(m) });

	process.env.PATH = binDir("good", file => fs.symlinkSync(fake, file));
	const good = await omp.resolve(null);
	const managed = path.join(configDir, "omp", "0.0.0-fake", "omp");
	assert.deepEqual(good, { version: "0.0.0-fake", path: managed, managed: true, warning: null });
	assert.ok(fs.statSync(managed).mode & 0o111);
	assert.equal(omp.bin(), managed);

	process.env.PATH = binDir("broken", file => fs.writeFileSync(file, '#!/bin/sh\n[ "$1" = --version ] && echo omp/0.0.1-broken && exit 0\nexit 3\n', { mode: 0o755 }));
	const kept = await omp.resolve(null);
	assert.equal(kept.path, managed);
	assert.equal(kept.version, "0.0.0-fake");
	assert.match(kept.warning ?? "", /omp 0\.0\.1-broken at .* failed the omp-home compatibility check: .*Still using omp 0\.0\.0-fake/);
	assert.ok(!fs.existsSync(path.join(configDir, "omp", "0.0.1-broken")));

	// Same version as the managed copy: no new check, no copy.
	process.env.PATH = [path.join(tmp, "good"), path.dirname(process.execPath)].join(path.delimiter);
	assert.deepEqual(await omp.resolve(null), good);

	// An explicit path is used as given.
	assert.deepEqual(await omp.resolve(fake), { version: "0.0.0-fake", path: fake, managed: false, warning: null });
	assert.match((await omp.resolve("/nonexistent/omp")).warning ?? "", /not an executable file/);
	assert.throws(() => omp.bin(), /not an executable file/);
});
