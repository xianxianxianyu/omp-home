import type { ChatRecordDTO, SearchHit } from "../shared/api.ts";
import { planQuery } from "./core/search.ts";
import type { Db, Param } from "./db.ts";
import type { DecisionRow, TaskRow } from "./ledger.ts";

type DocKind = SearchHit["kind"];

interface DocRow {
	id: number;
	kind: DocKind;
	ref: string;
	task_id: string | null;
	workspace_id: string | null;
	title: string | null;
	at: number;
	text: string;
}

interface ChatRow {
	id: number;
	capture_key: string;
	session_id: string;
	role: ChatRecordDTO["role"];
	text: string;
	raw: string;
	at: number;
}

const SCOPES: Record<"all" | "chat" | "tasks", DocKind[]> = {
	all: ["chat", "brief", "report", "run_text", "decision"],
	chat: ["chat"],
	tasks: ["brief", "report", "run_text", "decision"],
};

/** Sole writer of chat_record (lossless main-chat escrow) and the derived search corpus doc/doc_fts. */
export class Indexer {
	readonly #db: Db;

	constructor(db: Db) {
		this.#db = db;
	}

	capture(sessionId: string, c: { key: string; role: ChatRecordDTO["role"]; text: string; raw: string; at: number }): void {
		this.#db.tx(() => {
			const inserted = this.#db.run(
				"INSERT OR IGNORE INTO chat_record (capture_key, session_id, role, text, raw, at) VALUES (?, ?, ?, ?, ?, ?)",
				c.key,
				sessionId,
				c.role,
				c.text,
				c.raw,
				c.at,
			);
			if (inserted.changes && c.role !== "notice" && c.text.trim()) {
				this.#upsert("chat", `chat:${inserted.id}`, { taskId: null, workspaceId: null, title: c.role, at: c.at, text: c.text });
			}
		});
	}

	#upsert(kind: DocKind, ref: string, d: { taskId: string | null; workspaceId: string | null; title: string | null; at: number; text: string }): void {
		this.#db.run(
			`INSERT INTO doc (kind, ref, task_id, workspace_id, title, at, text) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (kind, ref) DO UPDATE SET task_id = excluded.task_id, workspace_id = excluded.workspace_id, title = excluded.title, at = excluded.at, text = excluded.text`,
			kind,
			ref,
			d.taskId,
			d.workspaceId,
			d.title,
			d.at,
			d.text,
		);
	}

	brief(t: TaskRow): void {
		this.#upsert("brief", t.id, { taskId: t.id, workspaceId: t.workspace_id, title: t.title, at: t.created_at, text: `${t.title}\n${t.brief}` });
	}

	report(t: TaskRow, ref: string, at: number, text: string): void {
		this.#upsert("report", ref, { taskId: t.id, workspaceId: t.workspace_id, title: t.title, at, text });
	}

	runText(t: TaskRow, ref: string, at: number, text: string): void {
		if (text.trim()) this.#upsert("run_text", ref, { taskId: t.id, workspaceId: t.workspace_id, title: t.title, at, text });
	}

	decision(d: DecisionRow, workspaceId: string | null): void {
		this.#upsert("decision", d.id, {
			taskId: d.task_id,
			workspaceId,
			title: d.summary,
			at: d.at,
			text: `${d.summary}\nWhy: ${d.why}\nRevert: ${d.revert_plan}`,
		});
	}

	search(q: string, opts: { scope?: "all" | "chat" | "tasks"; workspace?: string; limit?: number }): SearchHit[] {
		const plan = planQuery(q);
		if (!plan.match && !plan.likes.length) return [];
		const kinds = SCOPES[opts.scope ?? "all"];
		const where = [`d.kind IN (${kinds.map(() => "?").join(",")})`];
		const params: Param[] = [...kinds];
		if (plan.match) {
			where.push("d.id IN (SELECT rowid FROM doc_fts WHERE doc_fts MATCH ?)");
			params.push(plan.match);
		}
		for (const like of plan.likes) {
			where.push("d.text LIKE ? ESCAPE '\\'");
			params.push(like);
		}
		if (opts.workspace) {
			where.push("d.workspace_id = ?");
			params.push(opts.workspace);
		}
		params.push(opts.limit ?? 10);
		const rows = this.#db.all<DocRow>(`SELECT d.* FROM doc d WHERE ${where.join(" AND ")} ORDER BY d.at DESC LIMIT ?`, ...params);
		const terms = q.split(/\s+/).filter(Boolean);
		return rows.map(r => ({ ref: r.ref, kind: r.kind, at: r.at, taskId: r.task_id, title: r.title, excerpt: excerpt(r.text, terms) }));
	}

	/** Pages of the main-chat record, ascending by id; `before`/`after` are exclusive ids. */
	chat(page: { before?: number; after?: number; limit: number }): ChatRecordDTO[] {
		let rows: ChatRow[];
		if (page.before !== undefined) {
			rows = this.#db.all<ChatRow>("SELECT * FROM (SELECT * FROM chat_record WHERE id < ? ORDER BY id DESC LIMIT ?) ORDER BY id", page.before, page.limit);
		} else if (page.after !== undefined) {
			rows = this.#db.all<ChatRow>("SELECT * FROM chat_record WHERE id > ? ORDER BY id LIMIT ?", page.after, page.limit);
		} else {
			rows = this.#db.all<ChatRow>("SELECT * FROM (SELECT * FROM chat_record ORDER BY id DESC LIMIT ?) ORDER BY id", page.limit);
		}
		return rows.map(r => ({ id: r.id, role: r.role, text: r.text, at: r.at }));
	}

	/** The record `id` with `before` records ahead of it and `after` behind it. */
	chatAround(id: number, before: number, after: number): ChatRecordDTO[] {
		const head = this.chat({ before: id + 1, limit: before + 1 });
		return [...head, ...this.chat({ after: id, limit: after })];
	}
}

function excerpt(text: string, terms: string[]): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const lower = flat.toLowerCase();
	const hits = terms.map(t => lower.indexOf(t.toLowerCase())).filter(i => i >= 0);
	const at = hits.length ? Math.min(...hits) : 0;
	const start = Math.max(0, at - 60);
	const end = Math.min(flat.length, at + 180);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
