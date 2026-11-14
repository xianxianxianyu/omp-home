import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

const SCHEMA_VERSION = "1";
const SCHEMA_FILE = path.join(import.meta.dirname, "schema.sql");

export type IdKind = "T" | "W" | "M" | "WT" | "D" | "E";
export type Param = SQLInputValue;

/**
 * The hub's single SQLite connection. Rows are trusted internal data: callers name
 * the row shape they selected. `tx` is re-entrant so owners can compose writes.
 */
export class Db {
	readonly raw: DatabaseSync;
	#depth = 0;
	#statements = new Map<string, StatementSync>();

	constructor(file: string) {
		if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
		this.raw = new DatabaseSync(file);
		this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
		checkTrigram(this.raw);
		this.#migrate();
	}

	#migrate(): void {
		const hasMeta = this.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
		if (!hasMeta) {
			this.tx(() => {
				this.raw.exec(fs.readFileSync(SCHEMA_FILE, "utf8"));
				this.setMeta("schema_version", SCHEMA_VERSION);
			});
			return;
		}
		const version = this.meta("schema_version");
		if (version !== SCHEMA_VERSION) throw new Error(`home.db has schema version ${version ?? "none"}; this hub supports ${SCHEMA_VERSION}`);
	}

	#prepare(sql: string): StatementSync {
		let stmt = this.#statements.get(sql);
		if (!stmt) {
			stmt = this.raw.prepare(sql);
			this.#statements.set(sql, stmt);
		}
		return stmt;
	}

	get<T>(sql: string, ...params: Param[]): T | undefined {
		return this.#prepare(sql).get(...params) as T | undefined;
	}

	all<T>(sql: string, ...params: Param[]): T[] {
		return this.#prepare(sql).all(...params) as T[];
	}

	run(sql: string, ...params: Param[]): { changes: number; id: number } {
		const r = this.#prepare(sql).run(...params);
		return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
	}

	/** Run `fn` in one IMMEDIATE transaction; nested calls join the outer one. */
	tx<T>(fn: () => T): T {
		if (this.#depth > 0) {
			this.#depth++;
			try {
				return fn();
			} finally {
				this.#depth--;
			}
		}
		this.raw.exec("BEGIN IMMEDIATE");
		this.#depth = 1;
		try {
			const result = fn();
			this.raw.exec("COMMIT");
			return result;
		} catch (err) {
			this.raw.exec("ROLLBACK");
			throw err;
		} finally {
			this.#depth = 0;
		}
	}

	meta(key: string): string | null {
		return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
	}

	setMeta(key: string, value: string): void {
		this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	/** Allocate the next display id of a kind ("T-12"); call inside the transaction that inserts the row. */
	nextId(kind: IdKind): { id: string; seq: number } {
		return this.tx(() => {
			const seq = Number(this.meta(`next:${kind}`) ?? "1");
			this.setMeta(`next:${kind}`, String(seq + 1));
			return { id: `${kind}-${seq}`, seq };
		});
	}

	close(): void {
		this.#statements.clear();
		this.raw.close();
	}
}

function checkTrigram(db: DatabaseSync): void {
	try {
		db.exec("CREATE VIRTUAL TABLE temp.trigram_probe USING fts5(x, tokenize = 'trigram'); DROP TABLE temp.trigram_probe;");
	} catch (err) {
		throw new Error(
			`This Node build's SQLite lacks FTS5 with the trigram tokenizer (needed for search, including Chinese). Use Node 26+ from nodejs.org. (${err instanceof Error ? err.message : String(err)})`,
		);
	}
}
