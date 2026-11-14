import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { StateDTO, TaskSummary } from "../shared/api.ts";
import { IdError, parseDecisionId, parseEscalationId, parseSessionId, parseTaskId, parseWorkspaceId } from "../shared/ids.ts";
import { DEFAULT_HOME, saveConfig, type HubConfig } from "./config.ts";
import { errorText, fieldErrors, HubError } from "./errors.ts";
import { GitError } from "./git.ts";
import type { Resources } from "./resources.ts";
import { Hub } from "./hub.ts";
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

type Handler = (ctx: { params: string[]; url: URL; body: unknown }) => unknown;
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
	homePath: z.string().refine(p => path.isAbsolute(p), "must be an absolute path"),
	pstackRoot: z.string().nullable(),
	migrateHome: z.boolean(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() });
const textSchema = z.object({ text: z.string().min(1).max(20_000) });
const recipeSchema = z.object({ text: z.string().max(200_000) });
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
	if (!r.success) throw new HubError("unprocessable", r.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), fieldErrors(r.error.issues));
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

/** HTTP + WebSocket front of the hub. Works before setup (no home yet) with the setup routes only. */
export class HubServer {
	readonly #o: ServerOptions;
	readonly #ui = new UiChannel();
	readonly #server: http.Server;
	readonly #wss = new WebSocketServer({ noServer: true });
	readonly #routes: Route[] = [];
	readonly #dist: string;
	readonly #omp: OmpManager;
	#hub: Hub | null = null;
	#port = 0;

	constructor(opts: ServerOptions) {
		this.#o = opts;
		this.#dist = opts.resources.web;
		this.#omp = new OmpManager({ configDir: opts.configDir, pluginDir: opts.resources.plugin, log: opts.log });
		this.#server = http.createServer((req, res) => {
			this.#handle(req, res).catch(err => {
				this.#o.log(`${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("bad request\n");
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
		if (status.warning) this.#ui.send({ t: "toast", level: "error", text: status.warning });
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
		if (!this.#hub) throw new HubError("setup_required", "omp-home is not set up yet: choose a home repo first (POST /api/setup)");
		return this.#hub;
	}

	#tokenOk(token: string | null | undefined): boolean {
		const expected = Buffer.from(this.#o.config.token);
		const got = Buffer.from(token ?? "");
		return got.length === expected.length && timingSafeEqual(got, expected);
	}

	async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const send = (status: number, body: unknown) => {
			const text = JSON.stringify(body);
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(text);
		};
		if (!loopbackHost(req.headers.host)) {
			send(403, { error: "forbidden host" });
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!url.pathname.startsWith("/api/")) {
			this.#static(url.pathname, res);
			return;
		}
		const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
		if (!this.#tokenOk(bearer)) {
			send(401, { error: "missing or wrong token; open the URL the hub printed at startup", code: "unauthorized" });
			return;
		}
		const method = req.method ?? "GET";
		const match = this.#routes.map(r => ({ r, m: r.method === method ? r.pattern.exec(url.pathname) : null })).find(x => x.m);
		if (!match) {
			send(404, { error: `no route ${method} ${url.pathname}`, code: "not_found" });
			return;
		}
		try {
			const body = method === "GET" ? undefined : await readJson(req);
			const params = match.m!.slice(1).map(p => decodeURIComponent(p));
			const result = await match.r.handler({ params, url, body });
			send(200, result);
		} catch (err) {
			if (err instanceof HubError) send(err.status, { error: err.message, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
			else if (err instanceof IdError) send(400, { error: err.message, code: "invalid" });
			else if (err instanceof GitError) send(409, { error: err.message, code: "git" });
			else {
				this.#o.log(`${method} ${url.pathname}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				send(500, { error: errorText(err), code: "internal" });
			}
		}
	}

	#static(pathname: string, res: http.ServerResponse): void {
		const index = path.join(this.#dist, "index.html");
		if (!fs.existsSync(index)) {
			res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
			res.end("omp-home UI is not built. Run `pnpm build`, then reload.\n");
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
		if (url.pathname === "/api/events") {
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
					});
				} catch (err) {
					if (!(err instanceof HubError)) throw err;
					ws.close(STREAM_UNAVAILABLE, Buffer.from(err.message).subarray(0, 120).toString());
					return;
				}
				ws.on("close", detach);
				ws.on("error", () => ws.close());
			});
			return;
		}
		reject("404 Not Found");
	}

	#state(): StateDTO {
		if (this.#hub) return this.#hub.state(this.#o.version);
		const s = defaultSettings();
		return {
			version: this.#o.version,
			setup: { done: false, homePath: this.#o.config.homePath },
			main: { sessionId: null, state: "cold", wakesUsed: 0, wakesMax: s.maxAutoWakes, paused: false, pendingNotices: 0 },
			pool: { live: 0, cap: s.maxLiveWorkers },
			inboxOpen: 0,
			openTasks: 0,
			omp: this.#omp.status(),
		};
	}

	#route(method: string, pattern: string, handler: Handler): void {
		this.#routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:[a-z]+/g, "([^/]+)")}$`), handler });
	}

	#defineRoutes(): void {
		const r = this.#route.bind(this);
		const hub = () => this.#need();
		const uiKey = () => `ui:${randomUUID()}`;

		r("GET", "/api/state", () => this.#state());
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
		r("GET", "/api/setup/preview", ({ url }) => previewSetup(url.searchParams.get("home") || this.#o.config.homePath || DEFAULT_HOME, this.#o.resources.templates));
		r("POST", "/api/setup", async ({ body }) => {
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
			return this.#state();
		});

		r("GET", "/api/tasks", ({ url }) => {
			const h = hub();
			const status = url.searchParams.get("status") || undefined;
			const workspace = url.searchParams.get("workspace") || undefined;
			const q = url.searchParams.get("q")?.trim();
			let ids: string[] | undefined;
			if (q) {
				const hits = new Set(h.indexer.search(q, { scope: "tasks", limit: 200 }).flatMap(hit => (hit.taskId ? [hit.taskId] : [])));
				const needle = q.toLowerCase();
				for (const t of h.ledger.listTasks({ status, workspace })) if (t.id.toLowerCase() === needle || t.title.toLowerCase().includes(needle)) hits.add(t.id);
				ids = [...hits];
			}
			return h.ledger.listTasks({ status, workspace, ids }).map((t): TaskSummary => h.ledger.summary(t, h.branchOf(t.worktree_id)));
		});
		r("GET", "/api/tasks/:id", ({ params }) => hub().taskDetail(parseTaskId(params[0])));
		r("POST", "/api/tasks/:id/cancel", ({ params, body }) => {
			const id = parseTaskId(params[0]);
			hub().cancelTask(id, "human", parse(reasonSchema, body).reason ?? "cancelled by the human", uiKey());
			return hub().taskDetail(id);
		});
		r("POST", "/api/tasks/:id/cleanup", async ({ params }) => {
			const id = parseTaskId(params[0]);
			await hub().cleanupTask(id);
			return hub().taskDetail(id);
		});
		r("POST", "/api/tasks/:id/message", async ({ params, body }) => {
			const id = parseTaskId(params[0]);
			await hub().messageTask(id, parse(textSchema, body).text, uiKey());
			return hub().taskDetail(id);
		});

		r("GET", "/api/chat", ({ url }) => {
			const num = (key: string) => {
				const v = url.searchParams.get(key);
				if (v === null || v === "") return undefined;
				if (!/^\d+$/.test(v)) throw new HubError("invalid", `${key} must be a chat record id`);
				return Number(v);
			};
			const before = num("before");
			const after = num("after");
			if (before !== undefined && after !== undefined) throw new HubError("invalid", "pass before or after, not both");
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
			if (h.pool.must(id).kind === "main") throw new HubError("invalid", "the main chat is not evicted; use Restart main");
			await h.pool.evict(id);
			return h.sessionDTO(h.pool.must(id));
		});
		r("POST", "/api/sessions/:id/retire", async ({ params }) => {
			const h = hub();
			const id = parseSessionId(params[0]);
			const s = h.pool.must(id);
			if (s.kind === "main") throw new HubError("invalid", "retire the main chat with New chat");
			const open = h.ledger.openForSession(id);
			if (open) throw new HubError("conflict", `${id} has open task ${open.id}; close it first`);
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
		r("GET", "/api/sessions/:id/history", ({ params, url }) => {
			const before = url.searchParams.get("before");
			if (!before) throw new HubError("invalid", "pass before=<id of the first item you hold>");
			return hub().history(parseSessionId(params[0]), before);
		});
		r("POST", "/api/sessions/:id/subagents/:agent/steer", async ({ params, body }) => {
			await hub().steerSubagent(parseSessionId(params[0]), params[1]!, parse(textSchema, body).text);
			return { ok: true };
		});
		r("POST", "/api/sessions/:id/subagents/:agent/cancel", async ({ params }) => {
			await hub().cancelSubagent(parseSessionId(params[0]), params[1]!);
			return { ok: true };
		});
		r("POST", "/api/main/restart", async () => {
			await hub().pool.restartMain();
			return this.#state();
		});
		r("POST", "/api/main/new", async () => {
			await hub().newMain();
			return this.#state();
		});
		r("POST", "/api/main/continue", () => {
			hub().continueMain();
			return this.#state();
		});

		r("GET", "/api/inbox", () => hub().inbox());
		r("POST", "/api/escalations/:id/seen", ({ params }) => {
			const h = hub();
			const e = h.ledger.markSeen(parseEscalationId(params[0]));
			h.changed("inbox", "state");
			return h.ledger.escalationDTO(e);
		});
		r("POST", "/api/escalations/:id/dismiss", ({ params }) => {
			const h = hub();
			const e = h.ledger.dismiss(parseEscalationId(params[0]));
			h.changed("inbox", "state", "tasks", `task:${e.task_id}`, "sessions");
			return h.ledger.escalationDTO(e);
		});

		r("GET", "/api/decisions", ({ url }) => {
			const h = hub();
			const task = url.searchParams.get("task");
			return h.ledger.decisions(task ? parseTaskId(task) : undefined).map(d => h.ledger.decisionDTO(d));
		});
		r("POST", "/api/decisions/:id/revert", ({ params }) => hub().revertDecision(parseDecisionId(params[0])));

		r("GET", "/api/workspaces", () => hub().workspaces.list(true).map(w => hub().workspaces.dto(w)));
		r("POST", "/api/workspaces/scan", () => hub().workspaces.scan());
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
		r("GET", "/api/workspaces/:id/recipe", ({ params }) => hub().workspaces.readRecipe(parseWorkspaceId(params[0])));
		r("PUT", "/api/workspaces/:id/recipe", ({ params, body }) => {
			const h = hub();
			const dto = h.workspaces.writeRecipe(parseWorkspaceId(params[0]), parse(recipeSchema, body).text);
			h.changed("workspaces", "resources");
			return dto;
		});

		r("GET", "/api/resources", () => hub().env.resources());
		r("POST", "/api/services/:id/:action", ({ params }) => {
			const action = z.enum(["start", "stop", "check"]).safeParse(params[1]);
			if (!action.success) throw new HubError("not_found", `no service action ${params[1]}`);
			return hub().env.serviceAction(params[0]!, action.data);
		});
		r("POST", "/api/leases/:id/release", ({ params }) => {
			if (!/^\d+$/.test(params[0]!)) throw new HubError("invalid", "lease ids are numbers");
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
		if (size > BODY_LIMIT) throw new HubError("invalid", "request body too large");
		chunks.push(buf);
	}
	if (!size) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HubError("invalid", "request body is not JSON");
	}
}
