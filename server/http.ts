import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { Language, StateDTO } from "../shared/api.ts";
import { IdError, parseDecisionId, parseEscalationId, parseSessionId, parseTaskId, parseWorkspaceId } from "../shared/ids.ts";
import { DEFAULT_HOME, saveConfig, type HubConfig } from "./config.ts";
import { errorText, fieldErrors, HubError, localizeFieldErrors } from "./errors.ts";
import { pickFolder } from "./folder-picker.ts";
import { GitError } from "./git.ts";
import type { Resources } from "./resources.ts";
import { Hub } from "./hub.ts";
import { languageFromHeader, languageFromUrl, messages, render } from "./i18n.ts";
import { localizedCheck, validationMessages } from "./i18n-validation.ts";
import { ModelCatalog } from "./models.ts";
import { OmpManager } from "./omp.ts";
import { generatePstackPackage } from "./pstack.ts";
import { defaultSettings } from "./settings.ts";
import { applySetup, previewSetup } from "./setup.ts";
import { UiChannel } from "./ui.ts";

export interface ServerOptions {
	config: HubConfig;
	configDir: string;
	resources: Resources;
	version: string;
	log(message: string): void;
}

type Handler = (ctx: { params: string[]; url: URL; body: unknown; language: Language }) => unknown;
interface Route {
	method: string;
	pattern: RegExp;
	handler: Handler;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".map": "application/json",
	".txt": "text/plain; charset=utf-8",
};

const BODY_LIMIT = 4 * 1024 * 1024;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

const setupSchema = z.strictObject({
	homePath: z.string().refine(p => path.isAbsolute(p), localizedCheck(validationMessages.absolutePath())),
	pstackRoot: z.string().nullable(),
	migrateHome: z.boolean(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() });
const textSchema = z.object({ text: z.string().min(1).max(20_000) });
const recipeSchema = z.object({ text: z.string().max(200_000) });
const inspectSchema = z.object({ path: z.string().min(1).refine(p => path.isAbsolute(p), localizedCheck(validationMessages.absolutePath())) });
const pickFolderSchema = z.strictObject({
	title: z.string().max(200).optional(),
	defaultPath: z.string().refine(p => path.isAbsolute(p), localizedCheck(validationMessages.absolutePath())).optional(),
});
const taskStatusFilter = z.enum(["pending", "working", "awaiting", "done", "cancelled", "open", "closed"]);
const promptSchema = z.strictObject({ text: z.string().min(1).max(20_000), mode: z.enum(["auto", "steer", "followUp"]).optional() });
const respondSchema = z.strictObject({
	requestId: z.string().min(1),
	response: z.union([
		z.strictObject({ value: z.string().max(200_000) }),
		z.strictObject({ confirmed: z.boolean() }),
		z.strictObject({ answers: z.array(z.strictObject({ id: z.string(), selectedOptions: z.array(z.string()), customInput: z.string().optional() })) }),
		z.strictObject({ cancelled: z.literal(true) }),
	]),
});
/** WS close code when a session cannot be started for a stream (no free worker slot); the reason says why. */
const STREAM_UNAVAILABLE = 4503;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
	const r = schema.safeParse(body ?? {});
	if (!r.success) {
		const errors = fieldErrors(r.error.issues);
		const summary = (language: Language) => localizeFieldErrors(errors, language).map(e => `${e.path || "body"}: ${e.message}`).join("; ");
		throw new HubError("unprocessable", { en: summary("en"), zh: summary("zh") }, errors);
	}
	return r.data;
}

/** Loopback check by Host hostname (DNS-rebinding defence); any port so a dev proxy can forward. */
function loopbackHost(header: string | undefined): boolean {
	if (!header) return false;
	try {
		return LOOPBACK.includes(new URL(`http://${header}`).hostname);
	} catch {
		return false;
	}
}

/** HTTP + WebSocket front of the hub. Setup, defaults and the omp catalog work before a home is configured. */
export class HubServer {
	readonly #o: ServerOptions;
	readonly #ui = new UiChannel();
	readonly #server: http.Server;
	readonly #wss = new WebSocketServer({ noServer: true });
	readonly #routes: Route[] = [];
	readonly #dist: string;
	readonly #omp: OmpManager;
	readonly #models: ModelCatalog;
	#hub: Hub | null = null;
	#port = 0;

	constructor(opts: ServerOptions) {
		this.#o = opts;
		this.#dist = opts.resources.web;
		this.#omp = new OmpManager({ configDir: opts.configDir, pluginDir: opts.resources.plugin, log: opts.log });
		this.#models = new ModelCatalog(() => ({ bin: this.#omp.bin(), cwd: this.#hub?.home, overlay: this.#hub?.paths.overlay("worker") }));
		this.#server = http.createServer((req, res) => {
			this.#handle(req, res).catch(err => {
				this.#o.log(`${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end(`${render(messages.badRequest(), languageFromHeader(req.headers))}\n`);
			});
		});
		this.#server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
		this.#defineRoutes();
	}

	get hub(): Hub | null {
		return this.#hub;
	}

	async listen(port: number): Promise<number> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#server.once("error", reject);
		this.#server.listen(port, "127.0.0.1", () => resolve());
		await promise;
		const addr = this.#server.address();
		this.#port = typeof addr === "object" && addr ? addr.port : port;
		return this.#port;
	}

	/** Resolve omp, open the configured home (if any) and start its main chat. */
	async boot(): Promise<void> {
		const home = this.#o.config.homePath;
		if (!home || !fs.existsSync(home)) {
			await this.#resolveOmp(null);
			return;
		}
		const hub = this.#newHub(home);
		this.#hub = hub;
		await this.#resolveOmp(hub.settings.get().ompPath);
		await hub.start();
		this.#ui.invalidate("state", "settings");
	}

	#newHub(home: string): Hub {
		return new Hub({ home, resources: this.#o.resources, omp: this.#omp, port: this.#port, ui: this.#ui, log: this.#o.log });
	}

	async #resolveOmp(explicit: string | null): Promise<void> {
		const status = await this.#omp.resolve(explicit);
		if (status.warning) this.#ui.toast("error", this.#omp.status(this.#ui.language.lastSeen).warning!);
		this.#ui.invalidate("state");
	}

	/** Shutdown: drop UI sockets at once (a connected window must not hold the hub open), stop omp, close HTTP. */
	async close(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#server.close(() => resolve());
		this.#ui.close();
		for (const ws of this.#wss.clients) ws.terminate();
		this.#server.closeAllConnections();
		await this.#hub?.stop();
		this.#hub = null;
		this.#server.closeAllConnections();
		await promise;
	}

	#need(): Hub {
		if (!this.#hub) throw new HubError("setup_required", messages.setupRequired());
		return this.#hub;
	}

	#tokenOk(token: string | null | undefined): boolean {
		const expected = Buffer.from(this.#o.config.token);
		const got = Buffer.from(token ?? "");
		return got.length === expected.length && timingSafeEqual(got, expected);
	}

	async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const language = languageFromHeader(req.headers);
		const send = (status: number, body: unknown) => {
			const text = JSON.stringify(body);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(text);
		};
		if (!loopbackHost(req.headers.host)) {
			send(403, { error: render(messages.forbiddenHost(), language) });
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!url.pathname.startsWith("/api/")) {
			this.#static(url.pathname, res, language);
			return;
		}
		const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
		if (!this.#tokenOk(bearer)) {
			send(401, { error: render(messages.unauthorized(), language), code: "unauthorized" });
			return;
		}
		this.#ui.language.observe(language);
		const method = req.method ?? "GET";
		const match = this.#routes.map(r => ({ r, m: r.method === method ? r.pattern.exec(url.pathname) : null })).find(x => x.m);
		if (!match) {
			send(404, { error: render(messages.noRoute(method, url.pathname), language), code: "not_found" });
			return;
		}
		try {
			const body = method === "GET" ? undefined : await readJson(req);
			const params = match.m!.slice(1).map(p => decodeURIComponent(p));
			const result = await match.r.handler({ params, url, body, language });
			send(200, result);
		} catch (err) {
			if (err instanceof HubError) send(err.status, { error: err.localized(language), code: err.code, ...(err.errors ? { errors: localizeFieldErrors(err.errors, language) } : {}) });
			else if (err instanceof IdError) {
				const match = /^invalid (.+?): (.*)$/.exec(err.message);
				send(400, { error: match ? render(messages.invalidId(match[1]!, match[2]!), language) : err.message, code: "invalid" });
			}
			else if (err instanceof GitError) send(409, { error: render(err.localizedText ?? err.message, language), code: "git" });
			else {
				this.#o.log(`${method} ${url.pathname}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				send(500, { error: errorText(err, language), code: "internal" });
			}
		}
	}

	#static(pathname: string, res: http.ServerResponse, language: Language): void {
		const index = path.join(this.#dist, "index.html");
		if (!fs.existsSync(index)) {
			res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
			res.end(`${render(messages.uiNotBuilt(), language)}\n`);
			return;
		}
		let file = path.join(this.#dist, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ""));
		if (!file.startsWith(this.#dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = index;
		const immutable = file !== index && file.includes(`${path.sep}assets${path.sep}`);
		res.writeHead(200, {
			"content-type": MIME[path.extname(file)] ?? "application/octet-stream",
			"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		});
		fs.createReadStream(file).pipe(res);
	}

	#upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
		const reject = (status: string): void => {
			socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
		};
		if (!loopbackHost(req.headers.host)) return reject("403 Forbidden");
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/bridge") {
			if (!this.#hub) return reject("503 Service Unavailable");
			this.#hub.bridge.handleUpgrade(req, socket, head, url);
			return;
		}
		const origin = req.headers.origin;
		if (origin && !loopbackHost(URL.canParse(origin) ? new URL(origin).host : undefined)) return reject("403 Forbidden");
		if (!this.#tokenOk(url.searchParams.get("token"))) return reject("401 Unauthorized");
		const language = languageFromUrl(url);
		if (url.pathname === "/api/events") {
			this.#ui.language.observe(language);
			this.#wss.handleUpgrade(req, socket, head, ws => this.#ui.add(ws));
			return;
		}
		const stream = /^\/api\/sessions\/([^/]+)\/stream$/.exec(url.pathname);
		if (stream && this.#hub) {
			const hub = this.#hub;
			let id: string;
			try {
				id = parseSessionId(decodeURIComponent(stream[1]!));
				hub.pool.must(id);
			} catch {
				return reject("404 Not Found");
			}
			this.#wss.handleUpgrade(req, socket, head, ws => {
				let detach: () => void;
				try {
					detach = hub.stream(id, ev => {
						if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
					}, language);
				} catch (err) {
					if (!(err instanceof HubError)) throw err;
					ws.close(STREAM_UNAVAILABLE, Buffer.from(err.localized(language)).subarray(0, 120).toString());
					return;
				}
				ws.on("close", detach);
				ws.on("error", () => ws.close());
			});
			return;
		}
		reject("404 Not Found");
	}

	#state(language: Language = "en"): StateDTO {
		if (this.#hub) return this.#hub.state(this.#o.version, language);
		const s = defaultSettings();
		return {
			version: this.#o.version,
			setup: { done: false, homePath: this.#o.config.homePath },
			main: { sessionId: null, state: "cold", wakesUsed: 0, wakesMax: s.maxAutoWakes, paused: false, pendingNotices: 0 },
			pool: { live: 0, cap: s.maxLiveWorkers },
			inboxOpen: 0,
			openTasks: 0,
			omp: this.#omp.status(language),
		};
	}

	#route(method: string, pattern: string, handler: Handler): void {
		this.#routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:[a-z]+/g, "([^/]+)")}$`), handler });
	}

	#defineRoutes(): void {
		const r = this.#route.bind(this);
		const hub = () => this.#need();
		const uiKey = () => `ui:${randomUUID()}`;

		r("GET", "/api/state", ({ language }) => this.#state(language));
		r("GET", "/api/models", ({ url, language }) => this.#models.get(url.searchParams.get("refresh") === "1", language));
		r("GET", "/api/settings", () => this.#hub?.settings.dto() ?? { homePath: this.#o.config.homePath ?? DEFAULT_HOME, ...defaultSettings() });
		r("PUT", "/api/settings", ({ body }) => {
			const h = hub();
			const before = h.settings.get();
			const next = h.settings.update(body);
			if (next.pstackRoot !== before.pstackRoot) generatePstackPackage(next.pstackRoot, h.paths.pstackPackage);
			if (next.ompPath !== before.ompPath) void this.#resolveOmp(next.ompPath).catch(err => this.#o.log(`omp: ${errorText(err)}`));
			h.changed("settings", "state");
			h.notifier.evaluate();
			void h.pool.tick();
			return h.settings.dto();
		});
		r("GET", "/api/setup/preview", ({ url, language }) => previewSetup(url.searchParams.get("home") || this.#o.config.homePath || DEFAULT_HOME, this.#o.resources.templates, language));
		r("POST", "/api/setup", async ({ body, language }) => {
			const req = parse(setupSchema, body);
			const home = path.resolve(req.homePath);
			applySetup(home, this.#o.resources.templates, req.migrateHome);
			if (this.#hub && this.#hub.home !== home) {
				await this.#hub.stop();
				this.#hub = null;
			}
			this.#o.config.homePath = home;
			saveConfig(this.#o.config);
			if (this.#hub) {
				this.#hub.settings.update({ pstackRoot: req.pstackRoot });
				generatePstackPackage(req.pstackRoot, this.#hub.paths.pstackPackage);
			} else {
				const h = this.#newHub(home);
				try {
					h.settings.update({ pstackRoot: req.pstackRoot });
				} catch (err) {
					h.db.close();
					throw err;
				}
				this.#hub = h;
				await this.#resolveOmp(h.settings.get().ompPath);
				await h.start();
			}
			this.#ui.invalidate("state", "settings", "sessions");
			return this.#state(language);
		});

		r("GET", "/api/tasks", ({ url, language }) => {
			const h = hub();
			const rawStatus = url.searchParams.get("status");
			const parsed = rawStatus ? taskStatusFilter.safeParse(rawStatus) : null;
			if (parsed && !parsed.success) throw new HubError("invalid", messages.statusFilter(taskStatusFilter.options.join(", ")));
			const status = parsed?.data;
			const workspace = url.searchParams.get("workspace") || undefined;
			const q = url.searchParams.get("q")?.trim();
			let ids: string[] | undefined;
			if (q) {
				const hits = new Set(h.indexer.search(q, { scope: "tasks", limit: 200 }).flatMap(hit => (hit.taskId ? [hit.taskId] : [])));
				const needle = q.toLowerCase();
				for (const t of h.ledger.listTasks({ status, workspace })) if (t.id.toLowerCase() === needle || t.title.toLowerCase().includes(needle)) hits.add(t.id);
				ids = [...hits];
			}
			return h.ledger.listTasks({ status, workspace, ids }).map(t => h.taskSummary(t, language));
		});
		r("GET", "/api/tasks/:id", ({ params, language }) => hub().taskDetail(parseTaskId(params[0]), 200, language));
		r("POST", "/api/tasks/:id/cancel", ({ params, body, language }) => {
			const id = parseTaskId(params[0]);
			const reason = parse(reasonSchema, body).reason;
			hub().cancelTask(id, "human", reason ?? messages.cancelledDefault().en, uiKey(), reason === undefined ? messages.cancelledDefault() : undefined);
			return hub().taskDetail(id, 200, language);
		});
		r("POST", "/api/tasks/:id/cleanup", async ({ params, language }) => {
			const id = parseTaskId(params[0]);
			await hub().cleanupTask(id);
			return hub().taskDetail(id, 200, language);
		});
		r("POST", "/api/tasks/:id/message", async ({ params, body, language }) => {
			const id = parseTaskId(params[0]);
			await hub().messageTask(id, parse(textSchema, body).text, uiKey());
			return hub().taskDetail(id, 200, language);
		});

		r("GET", "/api/chat", ({ url }) => {
			const num = (key: string) => {
				const v = url.searchParams.get(key);
				if (v === null || v === "") return undefined;
				if (!/^\d+$/.test(v)) throw new HubError("invalid", messages.chatRecordId(key));
				return Number(v);
			};
			const before = num("before");
			const after = num("after");
			if (before !== undefined && after !== undefined) throw new HubError("invalid", messages.oneChatCursor());
			const limit = Math.min(200, Math.max(1, num("limit") ?? 50));
			return hub().indexer.chat({ before, after, limit });
		});
		r("GET", "/api/search", ({ url }) => {
			const q = url.searchParams.get("q")?.trim() ?? "";
			const scope = z.enum(["all", "chat", "tasks"]).catch("all").parse(url.searchParams.get("scope") ?? "all");
			return q ? hub().indexer.search(q, { scope, limit: 50 }) : [];
		});

		r("GET", "/api/sessions", () => hub().pool.list().map(s => hub().sessionDTO(s)));
		r("POST", "/api/sessions/:id/attach", ({ params }) => {
			const h = hub();
			const id = parseSessionId(params[0]);
			h.pool.ensureLive(id, { human: true });
			return h.sessionDTO(h.pool.must(id));
		});
		r("POST", "/api/sessions/:id/evict", async ({ params }) => {
			const h = hub();
			const id = parseSessionId(params[0]);
			if (h.pool.must(id).kind === "main") throw new HubError("invalid", messages.mainEviction());
			await h.pool.evict(id);
			return h.sessionDTO(h.pool.must(id));
		});
		r("POST", "/api/sessions/:id/retire", async ({ params }) => {
			const h = hub();
			const id = parseSessionId(params[0]);
			const s = h.pool.must(id);
			if (s.kind === "main") throw new HubError("invalid", messages.mainRetirement());
			const open = h.ledger.openForSession(id);
			if (open) throw new HubError("conflict", messages.openTask(id, open.id));
			await h.pool.retire(id);
			return h.sessionDTO(h.pool.must(id));
		});
		r("POST", "/api/sessions/:id/prompt", async ({ params, body }) => {
			const p = parse(promptSchema, body);
			await hub().prompt(parseSessionId(params[0]), p.text, p.mode ?? "auto");
			return { ok: true };
		});
		r("POST", "/api/sessions/:id/abort", async ({ params }) => {
			await hub().abort(parseSessionId(params[0]));
			return { ok: true };
		});
		r("POST", "/api/sessions/:id/respond", async ({ params, body }) => {
			const p = parse(respondSchema, body);
			await hub().respond(parseSessionId(params[0]), p.requestId, p.response);
			return { ok: true };
		});
		r("GET", "/api/sessions/:id/commands", ({ params }) => hub().commands(parseSessionId(params[0])));
		r("GET", "/api/sessions/:id/history", ({ params, url, language }) => {
			const before = url.searchParams.get("before");
			if (!before) throw new HubError("invalid", messages.historyCursor());
			return hub().history(parseSessionId(params[0]), before, language);
		});
		r("POST", "/api/sessions/:id/subagents/:agent/steer", async ({ params, body }) => {
			await hub().steerSubagent(parseSessionId(params[0]), params[1]!, parse(textSchema, body).text);
			return { ok: true };
		});
		r("POST", "/api/sessions/:id/subagents/:agent/cancel", async ({ params }) => {
			await hub().cancelSubagent(parseSessionId(params[0]), params[1]!);
			return { ok: true };
		});
		r("POST", "/api/main/restart", async ({ language }) => {
			await hub().pool.restartMain();
			return this.#state(language);
		});
		r("POST", "/api/main/new", async ({ language }) => {
			await hub().newMain();
			return this.#state(language);
		});
		r("POST", "/api/main/continue", ({ language }) => {
			hub().continueMain();
			return this.#state(language);
		});

		r("GET", "/api/inbox", ({ language }) => hub().inbox(language));
		r("POST", "/api/escalations/:id/seen", ({ params, language }) => {
			const h = hub();
			const e = h.ledger.markSeen(parseEscalationId(params[0]));
			h.changed("inbox", "state");
			return h.ledger.escalationDTO(e, language);
		});
		r("POST", "/api/escalations/:id/dismiss", ({ params, language }) => {
			const h = hub();
			const e = h.ledger.dismiss(parseEscalationId(params[0]));
			h.changed("inbox", "state", "tasks", `task:${e.task_id}`, "sessions");
			return h.ledger.escalationDTO(e, language);
		});

		r("GET", "/api/decisions", ({ url, language }) => {
			const h = hub();
			const task = url.searchParams.get("task");
			return h.ledger.decisions(task ? parseTaskId(task) : undefined).map(d => h.ledger.decisionDTO(d, language));
		});
		r("POST", "/api/decisions/:id/revert", ({ params, language }) => hub().revertDecision(parseDecisionId(params[0]), language));

		r("GET", "/api/workspaces", () => hub().workspaces.list(true).map(w => hub().workspaces.dto(w)));
		r("GET", "/api/workspaces/suggestions", () => hub().workspaces.suggestions());
		r("GET", "/api/workspaces/inspect", ({ url }) => hub().workspaces.inspect(parse(inspectSchema, { path: url.searchParams.get("path") }).path));
		r("POST", "/api/pick-folder", ({ body, language }) => pickFolder(parse(pickFolderSchema, body), language));
		r("POST", "/api/workspaces", async ({ body }) => {
			const h = hub();
			const w = await h.workspaces.create(body);
			h.changed("workspaces", "state");
			return h.workspaces.dto(w);
		});
		r("PATCH", "/api/workspaces/:id", ({ params, body }) => {
			const h = hub();
			const w = h.workspaces.patch(parseWorkspaceId(params[0]), body);
			h.changed("workspaces");
			return h.workspaces.dto(w);
		});
		r("POST", "/api/workspaces/:id/archive", ({ params }) => {
			const h = hub();
			const w = h.workspaces.archive(parseWorkspaceId(params[0]));
			h.changed("workspaces", "state");
			return h.workspaces.dto(w);
		});
		r("GET", "/api/workspaces/:id/recipe", ({ params, language }) => hub().workspaces.readRecipe(parseWorkspaceId(params[0]), language));
		r("PUT", "/api/workspaces/:id/recipe", ({ params, body, language }) => {
			const h = hub();
			const dto = h.workspaces.writeRecipe(parseWorkspaceId(params[0]), parse(recipeSchema, body).text, language);
			h.changed("workspaces", "resources");
			return dto;
		});

		r("GET", "/api/resources", ({ language }) => hub().env.resources(language));
		r("POST", "/api/services/:id/:action", ({ params, language }) => {
			const action = z.enum(["start", "stop", "check"]).safeParse(params[1]);
			if (!action.success) throw new HubError("not_found", messages.serviceAction(params[1]!));
			return hub().env.serviceAction(params[0]!, action.data, language);
		});
		r("POST", "/api/leases/:id/release", ({ params }) => {
			if (!/^\d+$/.test(params[0]!)) throw new HubError("invalid", messages.leaseId());
			return hub().env.release(Number(params[0]));
		});
	}
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > BODY_LIMIT) throw new HubError("invalid", messages.bodyTooLarge());
		chunks.push(buf);
	}
	if (!size) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HubError("invalid", messages.bodyNotJson());
	}
}
