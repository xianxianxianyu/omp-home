import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { homePaths } from "../server/config.ts";
import { Db } from "../server/db.ts";
import { HubError } from "../server/errors.ts";
import { SettingsStore } from "../server/settings.ts";

const appearance = { theme: "system", accent: "amber", textSize: "default", density: "comfortable" };

function store(t: TestContext): { db: Db; settings: SettingsStore } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-settings-"));
	const db = new Db(homePaths(home).db);
	t.after(() => {
		db.close();
		fs.rmSync(home, { recursive: true, force: true });
	});
	return { db, settings: new SettingsStore(db, homePaths(home)) };
}

test("appearance defaults and partial patches persist without resetting other fields", t => {
	const { db, settings } = store(t);
	assert.deepEqual(settings.dto().appearance, appearance);
	assert.deepEqual(settings.update({ appearance: { theme: "dark", accent: "violet" } }).appearance, { ...appearance, theme: "dark", accent: "violet" });
	assert.deepEqual(settings.update({ appearance: { textSize: "large", density: "compact" } }).appearance, { theme: "dark", accent: "violet", textSize: "large", density: "compact" });
	settings.update({ mainModel: "*opus*", workerModel: "future-provider/new-model", dispatcherModel: "fast", mainThinking: "max", workerThinking: "max" });
	const restored = new SettingsStore(db, homePaths(settings.dto().homePath)).get();
	assert.equal(restored.mainThinking, "max");
	assert.equal(restored.workerThinking, "max");
	assert.equal(restored.mainModel, "*opus*");
	assert.equal(restored.workerModel, "future-provider/new-model");
	assert.equal(restored.dispatcherModel, "fast");
	assert.deepEqual(restored.appearance, { theme: "dark", accent: "violet", textSize: "large", density: "compact" });
	assert.deepEqual(settings.update({ appearance: {} }).appearance, restored.appearance);
});

test("stored appearance recovers invalid or missing fields independently", t => {
	const { db, settings } = store(t);
	db.setMeta("settings", JSON.stringify({ mainModel: "custom", appearance: { theme: "sepia", accent: "blue", textSize: null, density: "compact", obsolete: true } }));
	assert.deepEqual(settings.get().appearance, { ...appearance, accent: "blue", density: "compact" });
	assert.equal(settings.get().mainModel, "custom");
	db.setMeta("settings", JSON.stringify({ appearance: { theme: "light" } }));
	assert.deepEqual(settings.get().appearance, { ...appearance, theme: "light" });
	for (const invalid of [null, "dark", [], 42]) {
		db.setMeta("settings", JSON.stringify({ mainModel: "custom", appearance: invalid }));
		assert.deepEqual(settings.get().appearance, appearance);
		assert.equal(settings.get().mainModel, "custom");
	}
	db.setMeta("settings", JSON.stringify({ workerThinking: "max" }));
	assert.deepEqual(settings.get().appearance, appearance);
	assert.equal(settings.get().workerThinking, "max");
});

test("appearance and thinking patch validation rejects invalid values without writing", t => {
	const { db, settings } = store(t);
	settings.update({ appearance: { theme: "dark" } });
	const before = db.meta("settings");
	for (const [key, value] of Object.entries({ theme: "sepia", accent: "cyan", textSize: "huge", density: "dense" })) {
		assert.throws(() => settings.update({ appearance: { [key]: value } }), err => err instanceof HubError && err.status === 422 && err.errors?.[0]?.path === `appearance.${key}`);
		assert.equal(db.meta("settings"), before);
	}
	for (const patch of [{ appearance: null }, { appearance: { unknown: true } }, { mainThinking: "future" }, { workerThinking: "future" }]) {
		assert.throws(() => settings.update(patch), err => err instanceof HubError && err.status === 422);
		assert.equal(db.meta("settings"), before);
	}
});
