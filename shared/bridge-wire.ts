/**
 * Private hub ⇄ omp-extension protocol. Import only from `server/bridge.ts` and
 * `omp-plugin/bridge.ts`. JSON text frames over WebSocket
 * `ws://127.0.0.1:<port>/bridge?session=<SessionId>&token=<per-process token>`.
 */
import type { AgentRef } from "./tools.ts";

export const BRIDGE_PROTOCOL = 1;

/** Environment variables the hub sets on every omp process it spawns. */
export const BRIDGE_ENV = {
	role: "OMP_HOME_ROLE", // "main" | "worker"
	url: "OMP_HOME_URL", // ws://127.0.0.1:<port>/bridge
	token: "OMP_HOME_TOKEN",
	session: "OMP_HOME_SESSION", // SessionId
	protectedBranches: "OMP_HOME_PROTECTED", // comma-separated branch names workers may not merge into
} as const;

export type StopReason = "completed" | "aborted" | "error";

export type BridgeToHub =
	| { t: "hello"; v: typeof BRIDGE_PROTOCOL; ompSessionId: string; sessionFile: string | null; cwd: string }
	/** A top-level agent run started (`agent_start`). */
	| { t: "run_start"; seq: number }
	/** A top-level agent run ended (`agent_end`). `text` is the final assistant text. */
	| { t: "run_end"; seq: number; stop: StopReason; text: string; error?: string; asyncJobs: number }
	/** The human submitted input in this TUI (`input` event, interactive source). */
	| { t: "input"; text: string }
	/** Lossless capture of one finished message (main role only): `message_end`. */
	| { t: "capture"; key: string; role: "user" | "assistant" | "notice"; text: string; raw: string; at: number }
	| { t: "approval"; phase: "requested"; tool: string; summary: string }
	| { t: "approval"; phase: "resolved"; approved: boolean }
	/** A tool call the bridge blocked by policy (recorded on the task timeline). */
	| { t: "blocked"; tool: string; reason: string; command: string }
	| { t: "delivered"; outboxId: number }
	| { t: "call"; callId: string; tool: string; params: unknown; agent: AgentRef };

export type HubToBridge =
	| { t: "welcome"; session: string }
	| {
			t: "deliver";
			outboxId: number;
			kind: "prompt" | "notice";
			text: string;
			/** next: follow-up after the current run (or start one if idle); now: steer; wake: notice that starts a turn; context: notice without a turn. */
			deliver: "next" | "now" | "wake" | "context";
	  }
	| { t: "result"; callId: string; ok: true; text: string; details?: unknown }
	| { t: "result"; callId: string; ok: false; code: string; message: string }
	| { t: "abort" }
	| { t: "shutdown" };

/** Custom entry type the bridge appends after delivering an outbox row, so redelivery after a restart is skipped. */
export const DELIVERED_ENTRY = "omp-home.delivered";
/** Custom message type for hub notices injected into the main chat. */
export const NOTICE_MESSAGE = "omp-home.notice";
