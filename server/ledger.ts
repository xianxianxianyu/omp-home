import type { Actor, DecisionDTO, EscalationDTO, Language, ReportDTO, TaskEventDTO, TaskStatus, TaskSummary } from "../shared/api.ts";
import type { CheckoutSpec } from "../shared/tools.ts";
import type { BatchItem } from "./core/notices.ts";
import {
	escalationResolution,
	foldTask,
	INITIAL,
	NOTICE_POLICY,
	noticeFor,
	type NoticeKind,
	type Priority,
	type Report,
	type Status,
	type TaskEvent,
	type TaskState,
	type Wait,
	waitText,
} from "./core/task.ts";
import type { Db } from "./db.ts";
import { HubError } from "./errors.ts";
import { taskMessages } from "./i18n-task.ts";
import { type Message, render } from "./i18n.ts";

export interface TaskRow {
	id: string;
	seq: number;
	title: string;
	workspace_id: string;
	checkout: string;
	playbook: string | null;
	brief: string;
	envelope: string | null;
	worktree_id: string | null;
	session_id: string | null;
	status: TaskStatus;
	wait: string | null;
	run_open: number;
	run_report: string | null;
	dispatch_key: string;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
	settled: number;
}

export interface EventRow {
	id: number;
	task_id: string;
	at: number;
	actor: Actor;
	kind: string;
	data: string;
	dedupe_key: string | null;
}

export interface DecisionRow {
	id: string;
	task_id: string | null;
	at: number;
	summary: string;
	why: string;
	revert_plan: string;
	reverts: string | null;
	revert_requested_at: number | null;
	dedupe_key: string | null;
}

export interface EscalationRow {
	id: string;
	task_id: string;
	session_id: string;
	reason: string;
	opened_by: "main" | "hub";
	opened_at: number;
	seen_at: number | null;
	resolved_at: number | null;
	resolution: "human_replied" | "task_moved" | "dismissed" | null;
}

export interface OutboxRow {
	id: number;
	session_id: string;
	task_id: string | null;
	kind: "prompt" | "notice";
	deliver: "next" | "now" | "wake" | "context";
	text: string;
	created_at: number;
	sent_at: number | null;
	acked_at: number | null;
	dedupe_key: string | null;
}

export interface NoticeRow {
	id: number;
	task_id: string;
	event_id: number;
	kind: NoticeKind;
	priority: Priority;
	created_at: number;
	outbox_id: number | null;
}

export interface ApplyResult {
	applied: boolean;
	before: TaskState;
	after: TaskState;
	notices: NoticeKind[];
	/** Escalations the hub opened on its own (NOTICE_POLICY.autoEscalate) during this apply. */
	opened: EscalationRow[];
}

export const isOpen = (status: TaskStatus) => status !== "done" && status !== "cancelled";

/** "awaiting question", or the plain status. */
export function statusText(t: TaskRow): string {
	const wait = waitOf(t);
	return wait ? `awaiting ${wait.kind}` : t.status;
}

export function stateOf(row: TaskRow): TaskState {
	const wait = row.wait ? (JSON.parse(row.wait) as Wait) : null;
	const status: Status = row.status === "awaiting" && wait ? { s: "awaiting", wait } : ({ s: row.status } as Status);
	return { status, runOpen: row.run_open === 1, runReport: row.run_report ? (JSON.parse(row.run_report) as Report) : null, settled: row.settled === 1 };
}

export function waitOf(row: TaskRow): Wait | null {
	return row.wait ? (JSON.parse(row.wait) as Wait) : null;
}

/**
 * Sole writer of task, task_event, task_link, decision, escalation, notice and outbox.
 * `apply` appends an event, folds it through core/task.ts, updates the projection and
 * records notices and escalation changes in one transaction; a dedupe key makes it idempotent.
 */
export class Ledger {
	readonly #db: Db;
	readonly #now: () => number;

	constructor(db: Db, now: () => number = Date.now) {
		this.#db = db;
		this.#now = now;
	}

	// ── tasks ────────────────────────────────────────────────────────────────

	task(id: string): TaskRow | undefined {
		return this.#db.get<TaskRow>("SELECT * FROM task WHERE id = ?", id);
	}

	mustTask(id: string): TaskRow {
		const row = this.task(id);
		if (!row) throw new HubError("not_found", taskMessages.noTask(id));
		return row;
	}

	/** A new task; lane branch tasks name the worktree claimed in the same transaction. */
	createTask(input: {
		title: string;
		workspaceId: string;
		checkout: CheckoutSpec;
		worktreeId: string | null;
		playbook: string | null;
		brief: string;
		related: string[];
		dispatchKey: string;
		actor: Actor;
	}): { task: TaskRow; created: boolean } {
		return this.#db.tx(() => {
			const existing = this.dispatched(input.dispatchKey);
			if (existing) return { task: existing, created: false };
			const { id, seq } = this.#db.nextId("T");
			const now = this.#now();
			this.#guardEditor(input.workspaceId, () =>
				this.#db.run(
					`INSERT INTO task (id, seq, title, workspace_id, checkout, playbook, brief, worktree_id, status, dispatch_key, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
					id,
					seq,
					input.title,
					input.workspaceId,
					JSON.stringify(input.checkout),
					input.playbook,
					input.brief,
					input.worktreeId,
					input.dispatchKey,
					now,
					now,
				),
			);
			for (const other of input.related) {
				this.#db.run("INSERT OR IGNORE INTO task_link (task_id, other_id) VALUES (?, ?)", id, other);
			}
			this.#append(
				id,
				{ kind: "created", title: input.title, workspace: input.workspaceId, checkout: input.checkout, playbook: input.playbook, related: input.related, worktree: input.worktreeId },
				input.actor,
				null,
			);
			return { task: this.mustTask(id), created: true };
		});
	}

	/** The task a dispatcher spawn already created: one dispatch per spawn. */
	dispatched(dispatchKey: string): TaskRow | undefined {
		return this.#db.get<TaskRow>("SELECT * FROM task WHERE dispatch_key = ?", dispatchKey);
	}

	/** The unsettled task editing a workspace's main checkout, if any. */
	mainEditor(workspaceId: string): TaskRow | undefined {
		return this.#db.get<TaskRow>("SELECT * FROM task WHERE workspace_id = ? AND settled = 0 AND json_extract(checkout, '$.edit') = 1", workspaceId);
	}

	/** The partial unique index `task_one_main_editor` speaks SQLite; callers get a conflict naming the editor. */
	#guardEditor<T>(workspaceId: string, write: () => T): T {
		try {
			return write();
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("UNIQUE constraint failed: task.workspace_id")) throw err;
			const editor = this.mainEditor(workspaceId);
			throw new HubError("conflict", taskMessages.mainEditorBusy(editor?.id ?? "?", workspaceId, editor ? statusText(editor) : "open"));
		}
	}

	apply(taskId: string, event: TaskEvent, actor: Actor, dedupeKey: string | null = null): ApplyResult {
		return this.#db.tx(() => {
			if (dedupeKey && this.#db.get("SELECT 1 FROM task_event WHERE dedupe_key = ?", dedupeKey)) {
				const state = stateOf(this.mustTask(taskId));
				return { applied: false, before: state, after: state, notices: [], opened: [] };
			}
			return this.#append(taskId, event, actor, dedupeKey);
		});
	}

	#append(taskId: string, event: TaskEvent, actor: Actor, dedupeKey: string | null): ApplyResult {
		const row = this.mustTask(taskId);
		const before = stateOf(row);
		const after = foldTask(before, event);
		const now = this.#now();
		const eventId = this.#db.run(
			"INSERT INTO task_event (task_id, at, actor, kind, data, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)",
			taskId,
			now,
			actor,
			event.kind,
			JSON.stringify(event),
			dedupeKey,
		).id;
		const terminal = after.status.s === "done" || after.status.s === "cancelled";
		this.#guardEditor(row.workspace_id, () =>
			this.#db.run(
				`UPDATE task SET status = ?, wait = ?, run_open = ?, run_report = ?, settled = ?, updated_at = ?, ended_at = ?,
				   session_id = coalesce(?, session_id)
				 WHERE id = ?`,
				after.status.s,
				after.status.s === "awaiting" ? JSON.stringify(after.status.wait) : null,
				after.runOpen ? 1 : 0,
				after.runReport ? JSON.stringify(after.runReport) : null,
				after.settled ? 1 : 0,
				now,
				terminal ? (row.ended_at ?? now) : null,
				event.kind === "provisioned" ? event.session : null,
				taskId,
			),
		);
		const result: ApplyResult = { applied: true, before, after, notices: [], opened: [] };
		const notice = noticeFor(before, after, event);
		if (notice) {
			this.#db.run(
				"INSERT INTO notice (task_id, event_id, kind, priority, created_at) VALUES (?, ?, ?, ?, ?)",
				taskId,
				eventId,
				notice,
				NOTICE_POLICY[notice].priority,
				now,
			);
			result.notices.push(notice);
		}
		if (event.kind === "escalated" || event.kind === "escalation_closed") return result;

		const open = this.openEscalation(taskId);
		const leftWaiting = before.status.s === "awaiting" && after.status.s !== "awaiting";
		const resolution = escalationResolution(event) ?? (leftWaiting ? "task_moved" : null);
		if (open && resolution) {
			this.#db.run("UPDATE escalation SET resolved_at = ?, resolution = ? WHERE id = ?", now, resolution, open.id);
			const nested = this.#append(taskId, { kind: "escalation_closed", escalation: open.id, resolution }, "hub", null);
			result.notices.push(...nested.notices);
		}
		const session = this.mustTask(taskId).session_id;
		if (notice && NOTICE_POLICY[notice].autoEscalate && session && !this.openEscalation(taskId)) {
			const reasonMessage = after.status.s === "awaiting" ? taskMessages.autoEscalation(after.status.wait.kind, after.status.wait.message ?? after.status.wait.text) : undefined;
			result.opened.push(this.#insertEscalation(taskId, session, reasonMessage?.en ?? notice, "hub", reasonMessage));
		}
		return result;
	}

	listTasks(filter: { status?: TaskStatus | "open" | "closed"; workspace?: string; ids?: string[] } = {}): TaskRow[] {
		const where: string[] = [];
		const params: string[] = [];
		if (filter.status === "open") where.push("status NOT IN ('done','cancelled')");
		else if (filter.status === "closed") where.push("status IN ('done','cancelled')");
		else if (filter.status) {
			where.push("status = ?");
			params.push(filter.status);
		}
		if (filter.workspace) {
			where.push("workspace_id = ?");
			params.push(filter.workspace);
		}
		if (filter.ids) {
			if (!filter.ids.length) return [];
			where.push(`id IN (${filter.ids.map(() => "?").join(",")})`);
			params.push(...filter.ids);
		}
		return this.#db.all<TaskRow>(`SELECT * FROM task ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 500`, ...params);
	}

	/** A session's turns belong to its latest task. */
	latestForSession(sessionId: string): TaskRow | undefined {
		return this.#db.get<TaskRow>("SELECT * FROM task WHERE session_id = ? ORDER BY seq DESC LIMIT 1", sessionId);
	}

	openForSession(sessionId: string): TaskRow | undefined {
		return this.#db.get<TaskRow>("SELECT * FROM task WHERE session_id = ? AND status NOT IN ('done','cancelled')", sessionId);
	}

	/** Tasks whose run cannot survive a hub restart (every omp process ends with the hub). */
	runningTasks(): TaskRow[] {
		return this.#db
			.all<TaskRow>("SELECT * FROM task WHERE status IN ('working','awaiting')")
			.filter(t => t.status === "working" || t.run_open === 1 || waitOf(t)?.kind === "approval");
	}

	setEnvelope(taskId: string, envelope: string): void {
		this.#db.run("UPDATE task SET envelope = ? WHERE id = ?", envelope, taskId);
	}

	events(taskId: string, limit = 200): EventRow[] {
		return this.#db.all<EventRow>("SELECT * FROM (SELECT * FROM task_event WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id", taskId, limit);
	}

	/** Events of one kind with their typed payload (event data is written only by this module). */
	eventsOf<K extends TaskEvent["kind"]>(taskId: string, kind: K): { id: number; at: number; event: Extract<TaskEvent, { kind: K }> }[] {
		return this.#db
			.all<EventRow>("SELECT * FROM task_event WHERE task_id = ? AND kind = ? ORDER BY id", taskId, kind)
			.map(e => ({ id: e.id, at: e.at, event: JSON.parse(e.data) as Extract<TaskEvent, { kind: K }> }));
	}

	/** Every task on a worktree's branch, oldest first. */
	tasksForWorktree(worktreeId: string): TaskRow[] {
		return this.#db.all<TaskRow>("SELECT * FROM task WHERE worktree_id = ? ORDER BY seq", worktreeId);
	}

	/** The latest task on a worktree: the only one that can have a session, and the one whose state gates retirement. */
	latestOn(worktreeId: string): TaskRow | undefined {
		return this.#db.get<TaskRow>("SELECT * FROM task WHERE worktree_id = ? ORDER BY seq DESC LIMIT 1", worktreeId);
	}

	related(taskId: string): string[] {
		return this.#db
			.all<{ id: string }>("SELECT other_id AS id FROM task_link WHERE task_id = ? UNION SELECT task_id FROM task_link WHERE other_id = ?", taskId, taskId)
			.map(r => r.id);
	}

	/** Everything of a TaskSummary the ledger knows; live progress comes from the hub. */
	summary(row: TaskRow, branch: string | null, language: Language = "en"): Omit<TaskSummary, "progress"> {
		return {
			id: row.id,
			title: row.title,
			workspace: row.workspace_id,
			status: row.status,
			wait: this.#waitSummary(row, language),
			sessionId: row.session_id,
			branch,
			playbook: row.playbook,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			endedAt: row.ended_at,
		};
	}

	#waitSummary(row: TaskRow, language: Language): TaskSummary["wait"] {
		let wait = waitOf(row);
		if (!wait) return null;
		if (language !== "en" && !wait.message && wait.kind !== "question" && wait.kind !== "blocked") {
			// Older projections have only English text. Replay their source events rather than
			// guessing from text that could equally have been written by the worker.
			let state = INITIAL;
			for (const event of this.#db.all<EventRow>("SELECT * FROM task_event WHERE task_id = ? ORDER BY id", row.id)) {
				state = foldTask(state, JSON.parse(event.data) as TaskEvent);
			}
			if (state.status.s === "awaiting" && state.status.wait.kind === wait.kind && state.status.wait.text === wait.text) wait = state.status.wait;
		}
		return { kind: wait.kind, text: waitText(wait, language) };
	}

	/** One-line rendering of the task's latest event. */
	lastEventSummary(taskId: string, language: Language = "en"): string | null {
		const e = this.#db.get<EventRow>("SELECT * FROM task_event WHERE task_id = ? ORDER BY id DESC LIMIT 1", taskId);
		return e ? this.#eventSummary(e, JSON.parse(e.data) as TaskEvent, language) : null;
	}

	/** When the latest event of one of `kinds` happened. */
	lastEventAt(taskId: string, kinds: readonly TaskEvent["kind"][]): number | null {
		return this.#db.get<{ at: number }>(`SELECT at FROM task_event WHERE task_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`, taskId, ...kinds)?.at ?? null;
	}

	reports(taskId: string): ReportDTO[] {
		return this.eventsOf(taskId, "reported").map(({ at, event }) => ({ at, status: event.status, summary: event.summary, details: event.details }));
	}

	eventDTO(e: EventRow, language: Language = "en"): TaskEventDTO {
		const data = JSON.parse(e.data) as TaskEvent;
		return { id: e.id, at: e.at, actor: e.actor, kind: e.kind, summary: this.#eventSummary(e, data, language), data: data as unknown as Record<string, unknown> };
	}

	#eventSummary(row: EventRow, event: TaskEvent, language: Language): string {
		if (event.kind === "escalated" && language !== "en") {
			const reasonMessage = this.#escalationMessage(row, event);
			if (reasonMessage) return describeEvent({ ...event, reasonMessage }, language);
		}
		return describeEvent(event, language);
	}

	// ── decisions ────────────────────────────────────────────────────────────

	logDecision(input: {
		taskId: string | null; summary: string; why: string; revert: string; reverts: string | null; dedupeKey: string | null; actor: Actor;
	} & ({ summaryMessage?: never; revertMessage?: never } | { taskId: string; summaryMessage?: Message; revertMessage?: Message })): DecisionRow {
		return this.#db.tx(() => {
			if (input.dedupeKey) {
				const existing = this.#db.get<DecisionRow>("SELECT * FROM decision WHERE dedupe_key = ?", input.dedupeKey);
				if (existing) return existing;
			}
			if (input.reverts && !this.decision(input.reverts)) throw new HubError("not_found", taskMessages.noDecision(input.reverts));
			const { id } = this.#db.nextId("D");
			this.#db.run(
				"INSERT INTO decision (id, task_id, at, summary, why, revert_plan, reverts, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				input.taskId,
				this.#now(),
				input.summary,
				input.why,
				input.revert,
				input.reverts,
				input.dedupeKey,
			);
			if (input.taskId) this.#append(input.taskId, {
				kind: "decided", decision: id, summary: input.summary,
				...(input.summaryMessage ? { summaryMessage: input.summaryMessage } : {}),
				...(input.revertMessage ? { revertMessage: input.revertMessage } : {}),
			}, input.actor, null);
			return this.decision(id)!;
		});
	}

	decision(id: string): DecisionRow | undefined {
		return this.#db.get<DecisionRow>("SELECT * FROM decision WHERE id = ?", id);
	}

	decisions(taskId?: string): DecisionRow[] {
		return taskId
			? this.#db.all<DecisionRow>("SELECT * FROM decision WHERE task_id = ? ORDER BY at DESC, id DESC", taskId)
			: this.#db.all<DecisionRow>("SELECT * FROM decision ORDER BY at DESC, id DESC LIMIT 500");
	}

	requestRevert(id: string): DecisionRow {
		const d = this.decision(id);
		if (!d) throw new HubError("not_found", taskMessages.noDecision(id));
		this.#db.run("UPDATE decision SET revert_requested_at = coalesce(revert_requested_at, ?) WHERE id = ?", this.#now(), id);
		return this.decision(id)!;
	}

	decisionDTO(d: DecisionRow, language: Language = "en"): DecisionDTO {
		const revertedBy = this.#db.get<{ id: string }>("SELECT id FROM decision WHERE reverts = ? ORDER BY at LIMIT 1", d.id)?.id ?? null;
		const event = language !== "en" && d.task_id ? this.#db.get<EventRow>(
			"SELECT * FROM task_event WHERE task_id = ? AND kind = 'decided' AND json_extract(data, '$.decision') = ? LIMIT 1", d.task_id, d.id,
		) : undefined;
		const metadata = event ? JSON.parse(event.data) as Extract<TaskEvent, { kind: "decided" }> : undefined;
		return {
			id: d.id,
			taskId: d.task_id,
			at: d.at,
			summary: render(metadata?.summaryMessage ?? d.summary, language),
			why: d.why,
			revert: render(metadata?.revertMessage ?? d.revert_plan, language),
			reverts: d.reverts,
			revertRequestedAt: d.revert_requested_at,
			revertedBy,
		};
	}

	// ── escalations ──────────────────────────────────────────────────────────

	openEscalation(taskId: string): EscalationRow | undefined {
		return this.#db.get<EscalationRow>("SELECT * FROM escalation WHERE task_id = ? AND resolved_at IS NULL", taskId);
	}

	escalation(id: string): EscalationRow | undefined {
		return this.#db.get<EscalationRow>("SELECT * FROM escalation WHERE id = ?", id);
	}

	escalations(filter: { taskId?: string; open?: boolean }): EscalationRow[] {
		if (filter.taskId) return this.#db.all<EscalationRow>("SELECT * FROM escalation WHERE task_id = ? ORDER BY opened_at DESC", filter.taskId);
		if (filter.open) return this.#db.all<EscalationRow>("SELECT * FROM escalation WHERE resolved_at IS NULL ORDER BY opened_at DESC");
		return this.#db.all<EscalationRow>("SELECT * FROM escalation ORDER BY opened_at DESC LIMIT 200");
	}

	/** One open escalation per task: a second request returns the open one. */
	escalate(taskId: string, sessionId: string, reason: string, by: "main" | "hub"): { escalation: EscalationRow; created: boolean } {
		return this.#db.tx(() => {
			const open = this.openEscalation(taskId);
			if (open) return { escalation: open, created: false };
			return { escalation: this.#insertEscalation(taskId, sessionId, reason, by), created: true };
		});
	}

	#insertEscalation(taskId: string, sessionId: string, reason: string, by: "main" | "hub", reasonMessage?: Message): EscalationRow {
		const { id } = this.#db.nextId("E");
		this.#db.run(
			"INSERT INTO escalation (id, task_id, session_id, reason, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)",
			id,
			taskId,
			sessionId,
			reason,
			by,
			this.#now(),
		);
		this.#append(taskId, { kind: "escalated", escalation: id, by, reason, ...(reasonMessage ? { reasonMessage } : {}) }, by, null);
		return this.escalation(id)!;
	}

	markSeen(id: string): EscalationRow {
		const e = this.escalation(id);
		if (!e) throw new HubError("not_found", taskMessages.noEscalation(id));
		this.#db.run("UPDATE escalation SET seen_at = coalesce(seen_at, ?) WHERE id = ?", this.#now(), id);
		return this.escalation(id)!;
	}

	dismiss(id: string): EscalationRow {
		return this.#db.tx(() => {
			const e = this.escalation(id);
			if (!e) throw new HubError("not_found", taskMessages.noEscalation(id));
			if (e.resolved_at === null) {
				this.#db.run("UPDATE escalation SET resolved_at = ?, resolution = 'dismissed' WHERE id = ?", this.#now(), id);
				this.#append(e.task_id, { kind: "escalation_closed", escalation: id, resolution: "dismissed" }, "human", null);
			}
			return this.escalation(id)!;
		});
	}

	escalationDTO(e: EscalationRow, language: Language = "en"): EscalationDTO {
		const event = language !== "en" && e.opened_by === "hub" ? this.#db.get<EventRow>(
			"SELECT * FROM task_event WHERE task_id = ? AND kind = 'escalated' AND json_extract(data, '$.escalation') = ? LIMIT 1", e.task_id, e.id,
		) : undefined;
		const message = event ? this.#escalationMessage(event, JSON.parse(event.data) as Extract<TaskEvent, { kind: "escalated" }>) : undefined;
		return {
			id: e.id,
			taskId: e.task_id,
			taskTitle: this.task(e.task_id)?.title ?? "",
			sessionId: e.session_id,
			reason: render(message ?? e.reason, language),
			openedBy: e.opened_by,
			openedAt: e.opened_at,
			seenAt: e.seen_at,
			resolvedAt: e.resolved_at,
			resolution: e.resolution,
		};
	}

	#escalationMessage(row: EventRow, event: Extract<TaskEvent, { kind: "escalated" }>): Message | undefined {
		if (event.by !== "hub") return undefined;
		if (event.reasonMessage) return event.reasonMessage;
		// Before metadata was recorded, only approval requests were auto-escalated.
		// Require the original source event and exact generated reason, never a text prefix.
		const source = this.#db.get<EventRow>("SELECT * FROM task_event WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT 1", row.task_id, row.id);
		if (!source) return undefined;
		const data = JSON.parse(source.data) as TaskEvent;
		if (data.kind !== "approval_requested") return undefined;
		const message = taskMessages.autoEscalation("approval", taskMessages.waitApproval(data.tool, data.summary));
		return message.en === event.reason ? message : undefined;
	}

	// ── outbox ───────────────────────────────────────────────────────────────

	/** The only path for text into an omp session. Returns the existing row for a repeated dedupe key. */
	enqueue(input: { sessionId: string; taskId: string | null; kind: "prompt" | "notice"; deliver: OutboxRow["deliver"]; text: string; dedupeKey: string | null }): OutboxRow {
		return this.#db.tx(() => {
			if (input.dedupeKey) {
				const existing = this.#db.get<OutboxRow>("SELECT * FROM outbox WHERE dedupe_key = ?", input.dedupeKey);
				if (existing) return existing;
			}
			const id = this.#db.run(
				"INSERT INTO outbox (session_id, task_id, kind, deliver, text, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
				input.sessionId,
				input.taskId,
				input.kind,
				input.deliver,
				input.text,
				this.#now(),
				input.dedupeKey,
			).id;
			return this.#db.get<OutboxRow>("SELECT * FROM outbox WHERE id = ?", id)!;
		});
	}

	outboxByKey(dedupeKey: string): OutboxRow | undefined {
		return this.#db.get<OutboxRow>("SELECT * FROM outbox WHERE dedupe_key = ?", dedupeKey);
	}

	/** A cancelled task's undelivered prompts must not start new runs. */
	dropPrompts(taskId: string): void {
		this.#db.run("UPDATE outbox SET acked_at = ? WHERE task_id = ? AND kind = 'prompt' AND acked_at IS NULL", this.#now(), taskId);
	}

	unacked(sessionId: string): OutboxRow[] {
		return this.#db.all<OutboxRow>("SELECT * FROM outbox WHERE session_id = ? AND acked_at IS NULL ORDER BY id", sessionId);
	}

	markSent(id: number): void {
		this.#db.run("UPDATE outbox SET sent_at = coalesce(sent_at, ?) WHERE id = ?", this.#now(), id);
	}

	/** The bridge confirmed delivery. A delivered prompt moves its task to working. */
	ack(outboxId: number, sessionId: string): { row: OutboxRow; result: ApplyResult | null } | null {
		return this.#db.tx(() => {
			const row = this.#db.get<OutboxRow>("SELECT * FROM outbox WHERE id = ? AND session_id = ?", outboxId, sessionId);
			if (!row) return null;
			this.#db.run("UPDATE outbox SET acked_at = coalesce(acked_at, ?), sent_at = coalesce(sent_at, ?) WHERE id = ?", this.#now(), this.#now(), outboxId);
			const result =
				row.kind === "prompt" && row.task_id
					? this.apply(row.task_id, { kind: "delivered", outbox: row.id, what: row.dedupe_key?.startsWith("brief:") ? "brief" : "message" }, "hub", `delivered:${row.id}`)
					: null;
			return { row, result };
		});
	}

	// ── notices and the wake budget ──────────────────────────────────────────

	pendingNotices(): NoticeRow[] {
		return this.#db.all<NoticeRow>("SELECT * FROM notice WHERE outbox_id IS NULL ORDER BY id");
	}

	/** Group pending notices per task with the task's current state. */
	batchItems(notices: NoticeRow[]): BatchItem[] {
		const byTask = new Map<string, NoticeKind[]>();
		for (const n of notices) byTask.set(n.task_id, [...(byTask.get(n.task_id) ?? []), n.kind]);
		return [...byTask].map(([taskId, kinds]) => {
			const t = this.mustTask(taskId);
			const wait = waitOf(t);
			const merged = kinds.includes("merged") ? this.eventsOf(taskId, "merged").at(-1)?.event : undefined;
			let workerText: string | null = null;
			// Hub-written waits (interrupted, provision_failed) are rendered inline; the rest quote worker text.
			if (wait && wait.kind !== "interrupted" && wait.kind !== "provision_failed") workerText = wait.text;
			else if (!merged && (t.status === "done" || kinds.includes("progress"))) {
				const report = this.reports(taskId).at(-1);
				if (report) workerText = report.details ? `${report.summary}\n${report.details}` : report.summary;
			}
			return {
				task: { id: t.id, title: t.title, workspace: t.workspace_id, session: t.session_id, status: t.status, wait },
				kinds: [...new Set(kinds)],
				workerText,
				hubNote: merged ? `${merged.branch} merged into ${merged.into} by the human; the hub removes its worktree and branch. No action needed.` : null,
			};
		});
	}

	/** Attach pending notices to one outbox row in a single transaction. */
	enqueueBatch(mainSession: string, ids: number[], mode: "wake" | "context", text: string): OutboxRow {
		return this.#db.tx(() => {
			const row = this.enqueue({ sessionId: mainSession, taskId: null, kind: "notice", deliver: mode, text, dedupeKey: `batch:${ids[0]}-${ids.at(-1)}:${ids.length}` });
			for (const id of ids) this.#db.run("UPDATE notice SET outbox_id = ? WHERE id = ? AND outbox_id IS NULL", row.id, id);
			return row;
		});
	}

	/** Notices sent to a main chat that never acknowledged them go back to pending (for the next main). */
	requeueNotices(sessionId: string): void {
		this.#db.run(
			"UPDATE notice SET outbox_id = NULL WHERE outbox_id IN (SELECT id FROM outbox WHERE session_id = ? AND kind = 'notice' AND acked_at IS NULL)",
			sessionId,
		);
	}

	humanInputAt(): number {
		return Number(this.#db.meta("human_input_at") ?? "0");
	}

	noteHumanInput(): void {
		this.#db.setMeta("human_input_at", String(this.#now()));
	}

	/** Derived wake budget: hub wakes delivered since the human last spoke. */
	wakesSinceHuman(mainSession: string): number {
		return this.#db.get<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE session_id = ? AND deliver = 'wake' AND sent_at > ?", mainSession, this.humanInputAt())!.n;
	}

	notifyInFlight(mainSession: string): boolean {
		return !!this.#db.get("SELECT 1 FROM outbox WHERE session_id = ? AND kind = 'notice' AND acked_at IS NULL", mainSession);
	}

	/** Urgent or normal notices went in as context because the wake budget ran out. */
	paused(mainSession: string): boolean {
		return !!this.#db.get(
			`SELECT 1 FROM notice n JOIN outbox o ON o.id = n.outbox_id
			 WHERE o.session_id = ? AND o.deliver = 'context' AND n.priority <> 'info' AND o.created_at > ?`,
			mainSession,
			this.humanInputAt(),
		);
	}
}

/** One-line rendering for timelines. */
export function describeEvent(e: TaskEvent, language: Language = "en"): string {
	let message: Message;
	switch (e.kind) {
		case "created":
			message = taskMessages.created(e.workspace, e.checkout, e.playbook);
			break;
		case "checked_out":
			message = taskMessages.checkedOut(e.worktree, e.branch, e.path);
			break;
		case "provisioned":
			message = taskMessages.provisioned(e.session);
			break;
		case "provision_failed":
			message = taskMessages.provisionFailed(e.step, e.messageText ?? e.message);
			break;
		case "provision_retry":
			message = taskMessages.provisionRetry();
			break;
		case "queued_for_capacity":
			message = taskMessages.queued(e.live, e.cap);
			break;
		case "delivered":
			message = taskMessages.delivered(e.what, e.outbox);
			break;
		case "run_started":
			message = taskMessages.runStarted(e.seq);
			break;
		case "run_ended":
			message = taskMessages.runEnded(e.seq, e.stop, e.error);
			break;
		case "reported":
			message = taskMessages.reported(e.status, e.summary);
			break;
		case "approval_requested":
			message = taskMessages.approvalRequested(e.tool, e.summary);
			break;
		case "approval_resolved":
			message = taskMessages.approvalResolved(e.approved);
			break;
		case "human_input":
			message = taskMessages.humanInput(e.text);
			break;
		case "message_sent":
			message = taskMessages.messageSent(e.by, e.mode, e.decision, e.text);
			break;
		case "process_lost":
			message = taskMessages.processLost(e.reasonMessage ?? e.reason);
			break;
		case "policy_blocked":
			message = taskMessages.policyBlocked(e.tool, e.command);
			break;
		case "escalated":
			message = taskMessages.escalated(e.escalation, e.by, e.by === "hub" ? e.reasonMessage ?? e.reason : e.reason);
			break;
		case "escalation_closed":
			message = taskMessages.escalationClosed(e.escalation, e.resolution);
			break;
		case "decided":
			message = taskMessages.decided(e.decision, e.summaryMessage ?? e.summary);
			break;
		case "accepted":
			message = taskMessages.accepted(e.reason);
			break;
		case "cancelled":
			message = taskMessages.cancelled(e.by, e.reasonMessage ?? e.reason);
			break;
		case "merged":
			message = taskMessages.merged(e.branch, e.into, e.sha);
			break;
		case "worktree_retired":
			message = taskMessages.worktreeRetired(e.reason, e.branch, e.sha, e.branchDeleted);
			break;
	}
	return render(message, language);
}
