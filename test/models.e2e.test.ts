import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { ModelCatalogDTO, SettingsDTO, StateDTO } from "../shared/api.ts";
import { killHubs, sandbox, startHub, until } from "./hub-harness.ts";

after(killHubs);

test("models endpoint maps omp's catalog, caches it and keeps it on refresh errors", { timeout: 60_000 }, async t => {
	const box = sandbox();
	const fixture = path.join(box.tmp, "catalog.json");
	const log = path.join(box.tmp, "catalog.jsonl");
	const hub = await startHub(box.configDir, { FAKE_OMP_CATALOG_FILE: fixture, FAKE_OMP_CATALOG_LOG: log });
	t.after(async () => {
		hub.child.kill("SIGTERM");
		await hub.exited;
		fs.rmSync(box.tmp, { recursive: true, force: true });
	});
	const catalog = async (refresh = false) => {
		const response = await hub.api<ModelCatalogDTO>("GET", `/api/models${refresh ? "?refresh=1" : ""}`);
		assert.equal(response.status, 200, JSON.stringify(response.body));
		return response.body;
	};
	const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { command: string; args: string[]; cwd: string; config: string | null });
	const setFixture = (value: unknown) => fs.writeFileSync(fixture, JSON.stringify(value));
	const startedAt = Date.now();
	const [first, simultaneous] = await Promise.all([catalog(), catalog()]);
	assert.deepEqual(simultaneous, first);
	assert.equal(first.error, null);
	assert.equal(first.defaultModel, "anthropic/claude-test");
	assert.ok(first.fetchedAt >= startedAt && first.fetchedAt <= Date.now());
	assert.deepEqual(first.models, [
		{ selector: "anthropic/claude-test", provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200000, maxTokens: 64000, reasoning: true, thinking: ["low", "high", "xhigh", "max"], input: ["text", "image"], cost: { input: 5, output: 25 } },
		{ selector: "openai-codex/gpt-test", provider: "openai-codex", id: "gpt-test", name: "GPT Test", contextWindow: null, maxTokens: null, reasoning: true, thinking: ["medium", "max"], input: ["text"], cost: null },
		{ selector: "local/plain", provider: "local", id: "plain", name: "Plain", contextWindow: null, maxTokens: null, reasoning: false, thinking: [], input: ["text"], cost: null },
	]);
	assert.deepEqual(calls().map(call => call.command), ["models", "config get modelRoles"]);
	assert.ok(calls().every(call => call.config === null));
	assert.deepEqual(await catalog(), first);
	assert.equal(calls().length, 2);
	assert.deepEqual((await hub.api<SettingsDTO>("GET", "/api/settings")).body.appearance, { theme: "system", accent: "amber", textSize: "default", density: "comfortable" });

	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	const configured = await catalog();
	assert.deepEqual(configured.models, first.models);
	const configuredCalls = calls().slice(2);
	assert.equal(configuredCalls.length, 2);
	assert.ok(configuredCalls.every(call => call.cwd === box.home && call.config === path.join(box.home, ".omp-home/run/worker.yml")));
	assert.deepEqual(configuredCalls.map(call => call.args), [
		["--config", path.join(box.home, ".omp-home/run/worker.yml"), "models", "--json"],
		["--config", path.join(box.home, ".omp-home/run/worker.yml"), "config", "get", "modelRoles", "--json"],
	]);

	const updated = await hub.api<SettingsDTO>("PUT", "/api/settings", { mainModel: "not-in-the-catalog*", mainThinking: "max", workerThinking: "max", appearance: { accent: "rose" } });
	assert.equal(updated.status, 200);
	assert.equal(updated.body.mainModel, "not-in-the-catalog*");
	assert.equal(updated.body.mainThinking, "max");
	assert.equal(updated.body.workerThinking, "max");
	assert.equal(updated.body.appearance.accent, "rose");
	assert.equal((await hub.api("PUT", "/api/settings", { appearance: { theme: "invalid" } })).status, 422);

	for (const command of ["models refresh", "models", "config get modelRoles"]) {
		setFixture({ fail: command });
		const failed = await catalog(true);
		assert.match(failed.error ?? "", /fake catalog failure/);
		assert.deepEqual(failed.models, configured.models);
		assert.equal(failed.defaultModel, configured.defaultModel);
		assert.equal(failed.fetchedAt, configured.fetchedAt);
		const count = calls().length;
		assert.deepEqual(await catalog(), failed);
		assert.equal(calls().length, count);
	}
	for (const value of [{ invalidJson: "models" }, { models: [{ kind: "chat", selector: "broken" }] }]) {
		setFixture(value);
		const invalid = await catalog(true);
		assert.ok(invalid.error);
		assert.deepEqual(invalid.models, configured.models);
		assert.equal(invalid.fetchedAt, configured.fetchedAt);
	}

	setFixture({ defaultModel: "openai-codex/gpt-test:max" });
	const refreshed = await catalog(true);
	assert.equal(refreshed.error, null);
	assert.equal(refreshed.defaultModel, "openai-codex/gpt-test");
	assert.deepEqual(refreshed.models, first.models);
	assert.ok(refreshed.fetchedAt > configured.fetchedAt);
	assert.deepEqual(calls().slice(-3).map(call => call.command), ["models refresh", "models", "config get modelRoles"]);
	assert.ok(calls().slice(-3).every(call => call.cwd === box.home && call.config === path.join(box.home, ".omp-home/run/worker.yml")));
	setFixture({ defaultModel: null });
	assert.equal((await catalog(true)).defaultModel, null);

	assert.equal((await hub.api("PUT", "/api/settings", { ompPath: path.join(box.tmp, "missing-omp") })).status, 200);
	await until("invalid omp path resolved", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.omp.path === null);
	const unavailable = await catalog(true);
	assert.match(unavailable.error ?? "", /not an executable file/);
	assert.deepEqual(unavailable.models, first.models);
});

test("models endpoint returns a recoverable empty catalog when its first query fails", { timeout: 30_000 }, async t => {
	const box = sandbox();
	const fixture = path.join(box.tmp, "catalog.json");
	fs.writeFileSync(fixture, JSON.stringify({ fail: "models" }));
	const hub = await startHub(box.configDir, { FAKE_OMP_CATALOG_FILE: fixture });
	t.after(async () => {
		hub.child.kill("SIGTERM");
		await hub.exited;
		fs.rmSync(box.tmp, { recursive: true, force: true });
	});
	const failed = await hub.api<ModelCatalogDTO>("GET", "/api/models");
	assert.equal(failed.status, 200);
	assert.deepEqual(failed.body.models, []);
	assert.equal(failed.body.defaultModel, null);
	assert.equal(failed.body.fetchedAt, 0);
	assert.match(failed.body.error ?? "", /fake catalog failure/);
	fs.writeFileSync(fixture, JSON.stringify({ defaultModel: "local/plain" }));
	const recovered = await hub.api<ModelCatalogDTO>("GET", "/api/models?refresh=1");
	assert.equal(recovered.status, 200);
	assert.equal(recovered.body.error, null);
	assert.equal(recovered.body.defaultModel, "local/plain");
	assert.equal(recovered.body.models.length, 3);
});
