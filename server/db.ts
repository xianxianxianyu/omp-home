import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { errorText, HubError } from "./errors.ts";
import { messages } from "./i18n.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";
import { resolveResources } from "./resources.ts";

const SCHEMA_FILE = resolveResources().schema;

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
		this.#migrate(file);
	}

	/** A new database gets schema.sql at the latest version; an older one is backed up, then migrated step by step. */
	#migrate(file: string): void {
		const hasMeta = this.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
		if (!hasMeta) {
			this.tx(() => {
				this.raw.exec(fs.readFileSync(SCHEMA_FILE, "utf8"));
				this.setMeta("schema_version", SCHEMA_VERSION);
			});
			return;
		}
		const version = this.meta("schema_version");
		if (version === SCHEMA_VERSION) return;
		const first = MIGRATIONS.findIndex(m => m.from === version);
		if (first === -1) throw new HubError("conflict", messages.databaseVersion(version, SCHEMA_VERSION));
		if (file !== ":memory:") this.raw.exec(`VACUUM INTO '${`${file}.v${version}-${Date.now()}.bak`.replaceAll("'", "''")}'`);
		// Table rebuilds need foreign keys off; the check afterwards proves no reference broke.
		this.raw.exec("PRAGMA foreign_keys = OFF");
		try {
			for (const m of MIGRATIONS.slice(first)) {
				this.tx(() => {
					m.up(this);
					const broken = this.raw.prepare("PRAGMA foreign_key_check").all();
					if (broken.length) throw new Error(`migration from schema ${m.from} broke foreign keys: ${JSON.stringify(broken.slice(0, 5))}`);
					this.setMeta("schema_version", String(Number(m.from) + 1));
				});
			}
		} finally {
			this.raw.exec("PRAGMA foreign_keys = ON");
		}
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
		throw new HubError("unavailable", messages.sqliteUnsupported(errorText(err)));
	}
}
