import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { HubServer } from "../server/http.ts";
import { languageFromHeader, languageFromUrl, LanguageTracker, messages } from "../server/i18n.ts";
import { resolveResources } from "../server/resources.ts";
import { LANGUAGE_HEADER, type FieldError, type SettingsDTO, type UiEvent } from "../shared/api.ts";
import { until } from "./hub-harness.ts";

test("language selection accepts only the resolved en/zh contract", () => {
	for (const [input, expected] of [[undefined, "en"], ["en", "en"], ["zh", "zh"], ["zh-CN", "en"], ["ZH", "en"], ["system", "en"], ["fr", "en"], ["", "en"]] as const) {
		assert.equal(languageFromHeader(input === undefined ? {} : { [LANGUAGE_HEADER]: input }), expected);
		assert.equal(languageFromUrl(new URL(`http://localhost/api/events${input === undefined ? "" : `?lang=${input}`}`)), expected);
	}
	assert.equal(languageFromHeader({ [LANGUAGE_HEADER]: ["zh", "en"] }), "en");
	const first = new LanguageTracker();
	const second = new LanguageTracker();
	first.observe("zh");
	assert.equal(first.lastSeen, "zh");
	assert.equal(second.lastSeen, "en");
});

test("HTTP errors and fields localize per request; sockets and requests choose pushed toast language", { timeout: 60_000 }, async t => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-i18n-"));
	const configDir = path.join(tmp, "config");
	const previousConfig = process.env.OMP_HOME_CONFIG_DIR;
	const previousOmp = process.env.OMP_HOME_OMP_BIN;
	process.env.OMP_HOME_CONFIG_DIR = configDir;
	process.env.OMP_HOME_OMP_BIN = path.resolve(import.meta.dirname, "fake-omp.ts");
	const server = new HubServer({ config: { homePath: null, token: "i18n-test-access-token", port: 4777 }, configDir, resources: resolveResources(), version: "test", log: () => {} });
	t.after(async () => {
		await server.close();
		if (previousConfig === undefined) delete process.env.OMP_HOME_CONFIG_DIR;
		else process.env.OMP_HOME_CONFIG_DIR = previousConfig;
		if (previousOmp === undefined) delete process.env.OMP_HOME_OMP_BIN;
		else process.env.OMP_HOME_OMP_BIN = previousOmp;
		fs.rmSync(tmp, { recursive: true, force: true });
	});
	const port = await server.listen(0);
	const request = async <T>(route: string, language?: string, body?: unknown): Promise<{ status: number; body: T }> => {
		const response = await fetch(`http://127.0.0.1:${port}${route}`, {
			method: body === undefined ? "GET" : route === "/api/settings" ? "PUT" : "POST",
			headers: { authorization: "Bearer i18n-test-access-token", ...(language === undefined ? {} : { [LANGUAGE_HEADER]: language }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: await response.json() as T };
	};
	assert.equal((await request<SettingsDTO>("/api/settings")).body.language, "system");
	for (const language of ["en", "zh"] as const) {
		const missing = await request<{ error: string; code: string }>("/api/tasks", language);
		assert.equal(missing.status, 409);
		assert.equal(missing.body.code, "setup_required");
		assert.equal(missing.body.error, language === "en" ? "omp-home is not set up yet: choose a home repo first (POST /api/setup)" : "omp-home 尚未设置：先选择 home 仓库（POST /api/setup）");
		const bad = await request<{ error: string; errors: FieldError[] }>("/api/setup", language, { homePath: "relative", pstackRoot: null, migrateHome: false });
		assert.equal(bad.status, 422);
		assert.deepEqual(bad.body.errors, [{ path: "homePath", message: language === "en" ? "must be an absolute path" : "必须是绝对路径" }]);
		assert.equal(bad.body.error, `homePath: ${language === "en" ? "must be an absolute path" : "必须是绝对路径"}`);
	}
	for (const fallback of [undefined, "de", "system", "zh-CN"]) {
		assert.equal((await request<{ error: string }>("/api/tasks", fallback)).body.error, messages.setupRequired().en);
	}
	assert.equal((await request("/api/setup", "en", { homePath: path.join(tmp, "home"), pstackRoot: null, migrateHome: true })).status, 200);
	assert.equal((await request<SettingsDTO>("/api/settings", "zh", { language: "zh" })).body.language, "zh");
	assert.equal((await request<SettingsDTO>("/api/settings", "en")).body.language, "zh");
	const invalid = await request<{ errors: FieldError[] }>("/api/settings", "zh", { language: "fr" });
	assert.equal(invalid.status, 422);
	assert.equal(invalid.body.errors[0]?.path, "language");
	assert.match(invalid.body.errors[0]?.message ?? "", /\p{Script=Han}/u);

	const events: UiEvent[] = [];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=i18n-test-access-token&lang=zh`);
	socket.on("message", data => events.push(JSON.parse(String(data)) as UiEvent));
	await once(socket, "open");
	const raw = "raw omp detail — keep EXACT";
	server.hub!.views.frame("M-1", { type: "prompt_result", status: "error", error: { message: raw } });
	const chineseToast = await until("Chinese pushed toast", async () => events.find(e => e.t === "toast" && e.text.includes(raw)));
	assert.ok(chineseToast.t === "toast");
	assert.match(chineseToast.text, /\p{Script=Han}/u);
	assert.ok(chineseToast.text.endsWith(raw));

	events.length = 0;
	await request("/api/settings", "en");
	server.hub!.views.frame("M-1", { type: "prompt_result", status: "error", error: { message: raw } });
	const englishToast = await until("English pushed toast", async () => events.find(e => e.t === "toast" && e.text.includes(raw)));
	assert.ok(englishToast.t === "toast");
	assert.equal(englishToast.text, `M-1: prompt failed: ${raw}`);

	events.length = 0;
	const fallback = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=i18n-test-access-token&lang=fr`);
	await once(fallback, "open");
	server.hub!.views.frame("M-1", { type: "prompt_result", status: "error", error: { message: raw } });
	const fallbackToast = await until("Socket fallback toast", async () => events.find(e => e.t === "toast" && e.text.includes(raw)));
	assert.ok(fallbackToast.t === "toast");
	assert.equal(fallbackToast.text, `M-1: prompt failed: ${raw}`);
	fallback.close();
	socket.close();
});
