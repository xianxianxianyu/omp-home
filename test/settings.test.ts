import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { homePaths } from "../server/config.ts";
import { Db } from "../server/db.ts";
import { HubError, localizeFieldErrors } from "../server/errors.ts";
import { defaultSettings, SettingsStore } from "../server/settings.ts";

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

function rejection(update: () => unknown): HubError {
	try {
		update();
	} catch (err) {
		if (err instanceof HubError) return err;
		throw err;
	}
	assert.fail("expected a HubError");
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

test("language defaults to system, persists, and rejects unknown values without writing", t => {
	const { db, settings } = store(t);
	assert.equal(defaultSettings().language, "system");
	assert.equal(settings.dto().language, "system");
	assert.equal(settings.update({ language: "zh" }).language, "zh");
	assert.equal(settings.update({ appearance: { theme: "dark" } }).language, "zh");
	assert.equal(new SettingsStore(db, homePaths(settings.dto().homePath)).get().language, "zh");
	assert.equal(settings.update({ language: "en" }).language, "en");
	const before = db.meta("settings");
	for (const language of ["fr", "zh-CN", "", null, 1]) {
		assert.equal(rejection(() => settings.update({ language })).errors?.[0]?.path, "language");
		assert.equal(db.meta("settings"), before);
	}
	db.setMeta("settings", JSON.stringify({ mainModel: "custom", language: "fr" }));
	assert.equal(settings.get().language, "system");
	assert.equal(settings.get().mainModel, "custom");
});

test("settings validation reads English by default and renders Chinese for the UI", t => {
	const { settings } = store(t);
	const err = rejection(() => settings.update({ portRange: [41000, 41001], worktreeRoot: "relative/worktrees" }));
	assert.equal(err.status, 422);
	assert.equal(err.message, "invalid settings");
	assert.equal(err.localized("en"), "invalid settings");
	assert.equal(err.localized("zh"), "设置无效");
	const english = [
		{ path: "portRange", message: "the range needs at least 10 ports" },
		{ path: "worktreeRoot", message: "must be an absolute path" },
	];
	assert.deepEqual(err.errors, english);
	assert.deepEqual(localizeFieldErrors(err.errors!, "en"), english);
	assert.deepEqual(localizeFieldErrors(err.errors!, "zh"), [
		{ path: "portRange", message: "端口范围至少要包含 10 个端口" },
		{ path: "worktreeRoot", message: "必须是绝对路径" },
	]);
});
