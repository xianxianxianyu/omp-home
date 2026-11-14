import type { ProcState, TaskProgress, TaskStatus, WaitKind } from "../../shared/api.ts";
import type { StopReason } from "../../shared/bridge-wire.ts";
import type { CheckoutSpec } from "../../shared/tools.ts";

/** The only place task status changes are decided. Pure: no I/O. */

export type ReportStatus = "done" | "blocked" | "question" | "progress";
export interface Report {
	status: ReportStatus;
	summary: string;
	details: string | null;
}
export interface Wait {
	kind: WaitKind;
	text: string;
}
export type Status = { s: "pending" } | { s: "working" } | { s: "awaiting"; wait: Wait } | { s: "done" } | { s: "cancelled" };
export interface TaskState {
	status: Status;
	runOpen: boolean;
	/** The report filed during the open run; applied when the run ends. */
	runReport: Report | null;
}
export type ProvisionStep = "checkout" | "env" | "session";
export type EscalationResolution = "human_replied" | "task_moved" | "dismissed";

export type TaskEvent =
	| { kind: "created"; title: string; workspace: string; checkout: CheckoutSpec; playbook: string | null; related: string[] }
	| { kind: "checked_out"; worktree: string; path: string; branch: string }
	| { kind: "provisioned"; session: string; reusedSession: boolean }
	| { kind: "provision_failed"; step: ProvisionStep; message: string }
	| { kind: "provision_retry"; text: string }
	| { kind: "queued_for_capacity"; live: number; cap: number }
	| { kind: "delivered"; outbox: number; what: "brief" | "message" }
	| { kind: "run_started"; seq: number }
	| { kind: "run_ended"; seq: number; stop: StopReason; text: string; error: string | null }
	| { kind: "reported"; status: ReportStatus; summary: string; details: string | null }
	| { kind: "approval_requested"; tool: string; summary: string }
	| { kind: "approval_resolved"; approved: boolean }
	| { kind: "human_input"; text: string }
	| { kind: "message_sent"; by: "main" | "human"; text: string; mode: "next" | "now"; decision: string | null }
	| { kind: "process_lost"; reason: string }
	| { kind: "policy_blocked"; tool: string; reason: string; command: string }
	| { kind: "escalated"; escalation: string; by: "main" | "hub"; reason: string }
	| { kind: "escalation_closed"; escalation: string; resolution: EscalationResolution }
	| { kind: "decided"; decision: string; summary: string }
	| { kind: "accepted"; reason: string; decision: string | null }
	| { kind: "cancelled"; by: "main" | "human"; reason: string }
	| { kind: "cleaned_up" };

export type TaskEventKind = TaskEvent["kind"];

export const INITIAL: TaskState = { status: { s: "pending" }, runOpen: false, runReport: null };
const WORKING: Status = { s: "working" };
const awaiting = (kind: WaitKind, text: string): Status => ({ s: "awaiting", wait: { kind, text } });
const isTerminal = (s: Status) => s.s === "done" || s.s === "cancelled";
const isWaiting = (s: Status, kind: WaitKind) => s.s === "awaiting" && s.wait.kind === kind;

function applyReport(r: Report | null): Status | null {
	if (!r) return null;
	if (r.status === "done") return { s: "done" };
	if (r.status === "progress") return null;
	return awaiting(r.status, r.details ? `${r.summary}\n\n${r.details}` : r.summary);
}

function stopStatus(e: Extract<TaskEvent, { kind: "run_ended" }>, progress: Report | null): Status {
	if (e.stop === "aborted") return awaiting("aborted", e.text || "The run was aborted.");
	if (e.stop === "error") return awaiting("error", e.error ?? (e.text || "The run failed."));
	const final = e.text || "(no final text)";
	return awaiting("no_report", progress ? `Progress report: ${progress.summary}\n\nFinal text: ${final}` : final);
}

export function foldTask(t: TaskState, e: TaskEvent): TaskState {
	switch (e.kind) {
		case "created":
			return INITIAL;
		case "provision_failed":
			return t.status.s === "pending" ? { ...t, status: awaiting("provision_failed", `${e.step}: ${e.message}`) } : t;
		case "provision_retry":
			return isWaiting(t.status, "provision_failed") ? { ...t, status: { s: "pending" } } : t;
		case "delivered":
			return t.status.s === "pending" ? { ...t, status: WORKING } : t;
		case "run_started":
			return { status: t.status.s === "cancelled" ? t.status : WORKING, runOpen: true, runReport: null };
		case "reported": {
			const report: Report = { status: e.status, summary: e.summary, details: e.details };
			if (t.runOpen) return { ...t, runReport: report };
			if (t.status.s === "cancelled") return t;
			return { ...t, status: applyReport(report) ?? t.status };
		}
		case "run_ended":
			if (isTerminal(t.status)) return { ...t, runOpen: false, runReport: null };
			return { status: applyReport(t.runReport) ?? stopStatus(e, t.runReport), runOpen: false, runReport: null };
		case "approval_requested":
			return isTerminal(t.status) ? t : { ...t, status: awaiting("approval", `${e.tool}: ${e.summary}`) };
		case "approval_resolved":
			return isWaiting(t.status, "approval") ? { ...t, status: WORKING } : t;
		case "human_input":
			return t.status.s === "pending" ? t : { ...t, status: WORKING };
		case "message_sent":
			return t.status.s === "pending" ? t : { ...t, status: WORKING };
		case "process_lost":
			if (t.status.s === "working" || isWaiting(t.status, "approval")) return { status: awaiting("interrupted", e.reason), runOpen: false, runReport: null };
			return { ...t, runOpen: false, runReport: null };
		case "accepted":
			return { ...t, status: { s: "done" } };
		case "cancelled":
			return { ...t, status: { s: "cancelled" } };
		default:
			return t;
	}
}

export type NoticeKind =
	| "done"
	| "question"
	| "blocked"
	| "stopped"
	| "error"
	| "interrupted"
	| "provision_failed"
	| "approval"
	| "progress"
	| "queued"
	| "human_replied"
	| "policy_blocked"
	| "cancelled";
export type Priority = "urgent" | "normal" | "info";

/** One table for every notice: how loud it is, and whether the hub escalates it to the human itself. */
export const NOTICE_POLICY: Record<NoticeKind, { priority: Priority; autoEscalate: boolean }> = {
	done: { priority: "normal", autoEscalate: false },
	question: { priority: "urgent", autoEscalate: false },
	blocked: { priority: "urgent", autoEscalate: false },
	stopped: { priority: "urgent", autoEscalate: false },
	error: { priority: "urgent", autoEscalate: false },
	interrupted: { priority: "urgent", autoEscalate: false },
	provision_failed: { priority: "urgent", autoEscalate: false },
	// Main cannot approve tool calls in a worker TUI: the human is asked directly, main is told.
	approval: { priority: "info", autoEscalate: true },
	progress: { priority: "info", autoEscalate: false },
	queued: { priority: "info", autoEscalate: false },
	human_replied: { priority: "info", autoEscalate: false },
	policy_blocked: { priority: "info", autoEscalate: false },
	cancelled: { priority: "info", autoEscalate: false },
};

const WAIT_NOTICE: Record<WaitKind, NoticeKind> = {
	question: "question",
	blocked: "blocked",
	no_report: "stopped",
	aborted: "stopped",
	error: "error",
	approval: "approval",
	interrupted: "interrupted",
	provision_failed: "provision_failed",
};

export function noticeFor(before: TaskState, after: TaskState, e: TaskEvent): NoticeKind | null {
	switch (e.kind) {
		case "accepted":
			return null;
		case "cancelled":
			return e.by === "human" ? "cancelled" : null;
		case "queued_for_capacity":
			return "queued";
		case "policy_blocked":
			return "policy_blocked";
		case "escalation_closed":
			return e.resolution === "human_replied" ? "human_replied" : null;
		case "reported":
			if (e.status === "progress" && after.runOpen) return "progress";
			break;
	}
	if (after.status.s === "done" && before.status.s !== "done") return "done";
	if (after.status.s === "awaiting") {
		const prev = before.status.s === "awaiting" ? before.status.wait : null;
		if (!prev || prev.kind !== after.status.wait.kind || prev.text !== after.status.wait.text) return WAIT_NOTICE[after.status.wait.kind];
	}
	return null;
}

/** Escalations close themselves when the task moves on; this says how. */
export function escalationResolution(e: TaskEvent): EscalationResolution | null {
	switch (e.kind) {
		case "human_input":
		case "approval_resolved":
			return "human_replied";
		case "message_sent":
			return e.by === "human" ? "human_replied" : "task_moved";
		case "accepted":
		case "cancelled":
		case "cleaned_up":
			return "task_moved";
		default:
			return null;
	}
}

export interface EnvelopeInput {
	task: { id: string; title: string; playbook: string | null; continues: string | null };
	where: { workspace: string; path: string; branch: string | null; base: string | null; readonly: boolean; protectedBranches: string[] };
	env: { vars: Record<string, string>; services: string[]; pools: string[]; test: Record<string, string> };
	pstack: boolean;
}

/** The hub-written header of a worker's first prompt (followed by `---` and the brief): facts the dispatcher does not know. */
export function renderEnvelope(i: EnvelopeInput): string {
	const lines = [`[omp-home task ${i.task.id} · ${i.task.title}]`];
	if (i.where.readonly) {
		lines.push(`Where: ${i.where.workspace} · main checkout ${i.where.path} · read-only investigation: do not edit, commit or switch branches here.`);
	} else {
		lines.push(`Where: ${i.where.workspace} · ${i.where.path} · branch ${i.where.branch ?? "(detached)"}${i.where.base ? ` (base ${i.where.base})` : ""}`);
	}
	if (i.task.continues) lines.push(`Continues: ${i.task.continues} in the same worktree; its commits and files are already here.`);
	const env = Object.entries(i.env.vars).map(([k, v]) => `${k}=${v}`);
	const envParts = [
		env.length ? env.join(" ") : "none",
		i.env.services.length ? `services: ${i.env.services.join(", ")}` : null,
		i.env.pools.length ? `accounts: ${i.env.pools.map(p => `home_lease({pool:"${p}"})`).join(", ")}` : null,
	].filter(Boolean);
	lines.push(`Env (already exported in your shell): ${envParts.join(" · ")} · details: home_env({})`);
	const tests = Object.entries(i.env.test);
	if (tests.length) lines.push(`Tests: ${tests.map(([k, v]) => `${k} \`${v}\``).join(" · ")}`);
	if (i.pstack) {
		lines.push(
			i.task.playbook
				? `Workflow: read skill://pstack-omp, then skill://poteto-mode and skill://poteto-mode/playbooks/${i.task.playbook}.md, and run that playbook.`
				: "Workflow: read skill://pstack-omp, then skill://poteto-mode, and follow it.",
		);
	} else {
		lines.push("Workflow: read skill://pstack-omp and skill://home-worker first.");
	}
	const protectedList = i.where.protectedBranches.length ? i.where.protectedBranches.join(", ") : "the base branch";
	lines.push(
		`Rules: no git push, no merge into protected branches (${protectedList}), no branch deletion; these are blocked. No interactive questions: call home_report({status:"question"}) and end your turn with the question.`,
		"Report: call home_report before ending each turn (done | blocked | question | progress).",
	);
	return lines.join("\n");
}

const PROC_PHASE: Record<ProcState, TaskProgress["phase"]> = { cold: "cold", starting: "starting", idle: "idle", running: "running", approval: "approval", stopping: "cold" };

/**
 * The in-flight phase of an open task (null once closed): provisioning until it has a worker
 * session, queued while that session waits for a pool slot, otherwise the session's process state.
 */
export function progressPhase(status: TaskStatus, session: { queued: boolean; state: ProcState } | null): TaskProgress["phase"] | null {
	if (status === "done" || status === "cancelled") return null;
	if (!session) return "provisioning";
	return session.queued ? "queued" : PROC_PHASE[session.state];
}
