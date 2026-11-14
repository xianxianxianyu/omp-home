import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { BRIDGE_PROTOCOL, type BridgeToHub, type HubToBridge } from "../shared/bridge-wire.ts";
import { IdError, parseSessionId } from "../shared/ids.ts";
import type { Ledger } from "./ledger.ts";
import type { Pool, SessionRow } from "./pool.ts";

const agentRef = z.object({ kind: z.enum(["main", "sub"]), id: z.string(), name: z.string(), parentId: z.string().optional() });
const frameSchema: z.ZodType<BridgeToHub> = z.union([
	z.object({ t: z.literal("hello"), v: z.literal(BRIDGE_PROTOCOL), ompSessionId: z.string(), sessionFile: z.string().nullable(), cwd: z.string() }),
	z.object({ t: z.literal("run_start"), seq: z.number().int() }),
	z.object({
		t: z.literal("run_end"),
		seq: z.number().int(),
		stop: z.enum(["completed", "aborted", "error"]),
		text: z.string(),
		error: z.string().optional(),
		asyncJobs: z.number().int().min(0),
	}),
	z.object({ t: z.literal("input"), text: z.string() }),
	z.object({ t: z.literal("capture"), key: z.string(), role: z.enum(["user", "assistant", "notice"]), text: z.string(), raw: z.string(), at: z.number() }),
	z.object({ t: z.literal("approval"), phase: z.literal("requested"), tool: z.string(), summary: z.string() }),
	z.object({ t: z.literal("approval"), phase: z.literal("resolved"), approved: z.boolean() }),
	z.object({ t: z.literal("blocked"), tool: z.string(), reason: z.string(), command: z.string() }),
	z.object({ t: z.literal("delivered"), outboxId: z.number().int() }),
	z.object({ t: z.literal("call"), callId: z.string(), tool: z.string(), params: z.unknown(), agent: agentRef }),
]);

export type CallFrame = Extract<BridgeToHub, { t: "call" }>;
export type CallResult = Extract<HubToBridge, { t: "result" }>;

export interface BridgeDeps {
	pool: Pool;
	ledger: Ledger;
	onFrame(session: SessionRow, frame: Exclude<BridgeToHub, CallFrame>): void;
	onCall(session: SessionRow, frame: CallFrame): Promise<CallResult>;
	log(message: string): void;
}

interface Conn {
	ws: WebSocket;
	/** Outbox rows sent on this connection; a new connection resends whatever is unacked. */
	sent: Set<number>;
}

/** WebSocket endpoint for omp extensions: per-process token auth, frame parsing, outbox delivery. */
export class Bridge {
	readonly #d: BridgeDeps;
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
	readonly #conns = new Map<string, Conn>();

	constructor(deps: BridgeDeps) {
		this.#d = deps;
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
		let sessionId: string;
		try {
			sessionId = parseSessionId(url.searchParams.get("session"));
		} catch (err) {
			if (!(err instanceof IdError)) throw err;
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		if (!this.#d.pool.tokenOk(sessionId, url.searchParams.get("token") ?? "")) {
			socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return;
		}
		this.#wss.handleUpgrade(req, socket, head, ws => this.#accept(sessionId, ws));
	}

	#accept(sessionId: string, ws: WebSocket): void {
		const previous = this.#conns.get(sessionId);
		const conn: Conn = { ws, sent: new Set() };
		this.#conns.set(sessionId, conn);
		previous?.ws.close(4000, "replaced");
		this.#send(conn, { t: "welcome", session: sessionId });
		ws.on("message", data => {
			let frame: BridgeToHub;
			try {
				const parsed = frameSchema.safeParse(JSON.parse(String(data)));
				if (!parsed.success) {
					this.#d.log(`bridge ${sessionId}: rejected frame: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
					return;
				}
				frame = parsed.data;
			} catch {
				this.#d.log(`bridge ${sessionId}: non-JSON frame`);
				return;
			}
			const session = this.#d.pool.session(sessionId);
			if (!session) return;
			if (frame.t === "call") {
				const call = frame;
				void this.#d.onCall(session, call).then(result => this.send(sessionId, result));
				return;
			}
			try {
				this.#d.onFrame(session, frame);
			} catch (err) {
				this.#d.log(`bridge ${sessionId}: ${frame.t} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			}
		});
		ws.on("close", () => {
			if (this.#conns.get(sessionId) !== conn) return;
			this.#conns.delete(sessionId);
			this.#d.pool.onDisconnect(sessionId);
		});
		ws.on("error", () => ws.close());
	}

	#send(conn: Conn, frame: HubToBridge): boolean {
		if (conn.ws.readyState !== conn.ws.OPEN) return false;
		conn.ws.send(JSON.stringify(frame));
		return true;
	}

	send(sessionId: string, frame: HubToBridge): boolean {
		const conn = this.#conns.get(sessionId);
		return !!conn && this.#send(conn, frame);
	}

	isConnected(sessionId: string): boolean {
		return this.#conns.has(sessionId);
	}

	/** Send unacknowledged outbox rows in id order once the session is live (its history is seeded). The extension skips rows it already delivered. */
	flush(sessionId: string): void {
		const conn = this.#conns.get(sessionId);
		if (!conn || !this.#d.pool.isLive(sessionId)) return;
		for (const row of this.#d.ledger.unacked(sessionId)) {
			if (conn.sent.has(row.id)) continue;
			if (!this.#send(conn, { t: "deliver", outboxId: row.id, kind: row.kind, text: row.text, deliver: row.deliver })) return;
			conn.sent.add(row.id);
			this.#d.ledger.markSent(row.id);
		}
	}

	closeAll(): void {
		for (const conn of this.#conns.values()) conn.ws.terminate();
		this.#conns.clear();
		this.#wss.close();
	}
}
