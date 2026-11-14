import type { Actor, DecisionDTO, EscalationDTO, ReportDTO, TaskEventDTO, TaskStatus, TaskSummary } from "../shared/api.ts";
import type { CheckoutSpec } from "../shared/tools.ts";
import type { BatchItem } from "./core/notices.ts";
import {
	escalationResolution,
	foldTask,
	NOTICE_POLICY,
	noticeFor,
	type NoticeKind,
	type Priority,
	type Report,
	type Status,
	type TaskEvent,
	type TaskState,
	type Wait,
} from "./core/task.ts";
import type { Db } from "./db.ts";
import { HubError } from "./errors.ts";

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

export function stateOf(row: TaskRow): TaskState {
	const wait = row.wait ? (JSON.parse(row.wait) as Wait) : null;
	const status: Status = row.status === "awaiting" && wait ? { s: "awaiting", wait } : ({ s: row.status } as Status);
	return { status, runOpen: row.run_open === 1, runReport: row.run_report ? (JSON.parse(row.run_report) as Report) : null };
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
		if (!row) throw new HubError("not_found", `no task ${id}`);
		return row;
	}

	createTask(input: {
		title: string;
		workspaceId: string;
		checkout: CheckoutSpec;
		playbook: string | null;
		brief: string;
		related: string[];
		dispatchKey: string;
		actor: Actor;
	}): { task: TaskRow; created: boolean } {
		return this.#db.tx(() => {
			const existing = this.#db.get<TaskRow>("SELECT * FROM task WHERE dispatch_key = ?", input.dispatchKey);
			if (existing) return { task: existing, created: false };
			const { id, seq } = this.#db.nextId("T");
			const now = this.#now();
			this.#db.run(
				`INSERT INTO task (id, seq, title, workspace_id, checkout, playbook, brief, status, dispatch_key, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
				id,
				seq,
				input.title,
				input.workspaceId,
				JSON.stringify(input.checkout),
				input.playbook,
				input.brief,
				input.dispatchKey,
				now,
				now,
			);
			for (const other of input.related) {
				this.#db.run("INSERT OR IGNORE INTO task_link (task_id, other_id, kind) VALUES (?, ?, 'related')", id, other);
			}
			if (input.checkout.kind === "continue") {
				this.#db.run("INSERT OR REPLACE INTO task_link (task_id, other_id, kind) VALUES (?, ?, 'continues')", id, input.checkout.task);
			}
			this.#append(id, { kind: "created", title: input.title, workspace: input.workspaceId, checkout: input.checkout, playbook: input.playbook, related: input.related }, input.actor, null);
			return { task: this.mustTask(id), created: true };
		});
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
		this.#db.run(
			`UPDATE task SET status = ?, wait = ?, run_open = ?, run_report = ?, updated_at = ?, ended_at = ?,
			   worktree_id = coalesce(?, worktree_id), session_id = coalesce(?, session_id)
			 WHERE id = ?`,
			after.status.s,
			after.status.s === "awaiting" ? JSON.stringify(after.status.wait) : null,
			after.runOpen ? 1 : 0,
			after.runReport ? JSON.stringify(after.runReport) : null,
			now,
			terminal ? (row.ended_at ?? now) : null,
			event.kind === "checked_out" ? event.worktree : null,
			event.kind === "provisioned" ? event.session : null,
			taskId,
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
			const reason = after.status.s === "awaiting" ? `${after.status.wait.kind}: ${after.status.wait.text}` : notice;
			result.opened.push(this.#insertEscalation(taskId, session, reason, "hub"));
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

	tasksForWorktree(worktreeId: string): TaskRow[] {
		return this.#db.all<TaskRow>("SELECT * FROM task WHERE worktree_id = ? ORDER BY seq", worktreeId);
	}

	related(taskId: string): string[] {
		return this.#db
			.all<{ id: string }>("SELECT other_id AS id FROM task_link WHERE task_id = ? UNION SELECT task_id FROM task_link WHERE other_id = ?", taskId, taskId)
			.map(r => r.id);
	}

	/** Everything of a TaskSummary the ledger knows; live progress comes from the hub. */
	summary(row: TaskRow, branch: string | null): Omit<TaskSummary, "progress"> {
		return {
			id: row.id,
			title: row.title,
			workspace: row.workspace_id,
			status: row.status,
			wait: waitOf(row),
			sessionId: row.session_id,
			branch,
			playbook: row.playbook,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			endedAt: row.ended_at,
		};
	}

	/** One-line rendering of the task's latest event. */
	lastEventSummary(taskId: string): string | null {
		const e = this.#db.get<EventRow>("SELECT * FROM task_event WHERE task_id = ? ORDER BY id DESC LIMIT 1", taskId);
		return e ? describeEvent(JSON.parse(e.data) as TaskEvent) : null;
	}

	/** When the latest event of one of `kinds` happened. */
	lastEventAt(taskId: string, kinds: readonly TaskEvent["kind"][]): number | null {
		return this.#db.get<{ at: number }>(`SELECT at FROM task_event WHERE task_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`, taskId, ...kinds)?.at ?? null;
	}

	reports(taskId: string): ReportDTO[] {
		return this.eventsOf(taskId, "reported").map(({ at, event }) => ({ at, status: event.status, summary: event.summary, details: event.details }));
	}

	eventDTO(e: EventRow): TaskEventDTO {
		const data = JSON.parse(e.data) as TaskEvent;
		return { id: e.id, at: e.at, actor: e.actor, kind: e.kind, summary: describeEvent(data), data: data as unknown as Record<string, unknown> };
	}

	// ── decisions ────────────────────────────────────────────────────────────

	logDecision(input: { taskId: string | null; summary: string; why: string; revert: string; reverts: string | null; dedupeKey: string | null; actor: Actor }): DecisionRow {
		return this.#db.tx(() => {
			if (input.dedupeKey) {
				const existing = this.#db.get<DecisionRow>("SELECT * FROM decision WHERE dedupe_key = ?", input.dedupeKey);
				if (existing) return existing;
			}
			if (input.reverts && !this.decision(input.reverts)) throw new HubError("not_found", `no decision ${input.reverts}`);
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
			if (input.taskId) this.#append(input.taskId, { kind: "decided", decision: id, summary: input.summary }, input.actor, null);
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
		if (!d) throw new HubError("not_found", `no decision ${id}`);
		this.#db.run("UPDATE decision SET revert_requested_at = coalesce(revert_requested_at, ?) WHERE id = ?", this.#now(), id);
		return this.decision(id)!;
	}

	decisionDTO(d: DecisionRow): DecisionDTO {
		const revertedBy = this.#db.get<{ id: string }>("SELECT id FROM decision WHERE reverts = ? ORDER BY at LIMIT 1", d.id)?.id ?? null;
		return {
			id: d.id,
			taskId: d.task_id,
			at: d.at,
			summary: d.summary,
			why: d.why,
			revert: d.revert_plan,
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

	#insertEscalation(taskId: string, sessionId: string, reason: string, by: "main" | "hub"): EscalationRow {
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
		this.#append(taskId, { kind: "escalated", escalation: id, by, reason }, by, null);
		return this.escalation(id)!;
	}

	markSeen(id: string): EscalationRow {
		const e = this.escalation(id);
		if (!e) throw new HubError("not_found", `no escalation ${id}`);
		this.#db.run("UPDATE escalation SET seen_at = coalesce(seen_at, ?) WHERE id = ?", this.#now(), id);
		return this.escalation(id)!;
	}

	dismiss(id: string): EscalationRow {
		return this.#db.tx(() => {
			const e = this.escalation(id);
			if (!e) throw new HubError("not_found", `no escalation ${id}`);
			if (e.resolved_at === null) {
				this.#db.run("UPDATE escalation SET resolved_at = ?, resolution = 'dismissed' WHERE id = ?", this.#now(), id);
				this.#append(e.task_id, { kind: "escalation_closed", escalation: id, resolution: "dismissed" }, "human", null);
			}
			return this.escalation(id)!;
		});
	}

	escalationDTO(e: EscalationRow): EscalationDTO {
		return {
			id: e.id,
			taskId: e.task_id,
			taskTitle: this.task(e.task_id)?.title ?? "",
			sessionId: e.session_id,
			reason: e.reason,
			openedBy: e.opened_by,
			openedAt: e.opened_at,
			seenAt: e.seen_at,
			resolvedAt: e.resolved_at,
			resolution: e.resolution,
		};
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
			let workerText: string | null = null;
			// Hub-written waits (interrupted, provision_failed) are rendered inline; the rest quote worker text.
			if (wait && wait.kind !== "interrupted" && wait.kind !== "provision_failed") workerText = wait.text;
			else if (t.status === "done" || kinds.includes("progress")) {
				const report = this.reports(taskId).at(-1);
				if (report) workerText = report.details ? `${report.summary}\n${report.details}` : report.summary;
			}
			return {
				task: { id: t.id, title: t.title, workspace: t.workspace_id, session: t.session_id, status: t.status, wait },
				kinds: [...new Set(kinds)],
				workerText,
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
export function describeEvent(e: TaskEvent): string {
	switch (e.kind) {
		case "created":
			return `created in ${e.workspace} (${e.checkout.kind}${e.playbook ? `, playbook ${e.playbook}` : ""})`;
		case "checked_out":
			return `worktree ${e.worktree} on ${e.branch} at ${e.path}`;
		case "provisioned":
			return `${e.reusedSession ? "reusing" : "new"} session ${e.session}`;
		case "provision_failed":
			return `provisioning failed at ${e.step}: ${e.message}`;
		case "provision_retry":
			return "provisioning retried";
		case "queued_for_capacity":
			return `waiting for a worker slot (${e.live}/${e.cap} live)`;
		case "delivered":
			return `${e.what} delivered (outbox #${e.outbox})`;
		case "run_started":
			return `run ${e.seq} started`;
		case "run_ended":
			return `run ${e.seq} ended: ${e.stop}${e.error ? ` (${e.error})` : ""}`;
		case "reported":
			return `report ${e.status}: ${e.summary}`;
		case "approval_requested":
			return `approval requested for ${e.tool}: ${e.summary}`;
		case "approval_resolved":
			return e.approved ? "approved" : "denied";
		case "human_input":
			return `human typed: ${e.text}`;
		case "message_sent":
			return `${e.by} sent (${e.mode})${e.decision ? ` with ${e.decision}` : ""}: ${e.text}`;
		case "process_lost":
			return `process lost: ${e.reason}`;
		case "policy_blocked":
			return `blocked ${e.tool}: ${e.command}`;
		case "escalated":
			return `${e.escalation} opened by ${e.by}: ${e.reason}`;
		case "escalation_closed":
			return `${e.escalation} closed: ${e.resolution}`;
		case "decided":
			return `${e.decision}: ${e.summary}`;
		case "accepted":
			return `accepted as done: ${e.reason}`;
		case "cancelled":
			return `cancelled by ${e.by}: ${e.reason}`;
		case "cleaned_up":
			return "environment torn down and worktree removed";
	}
}
