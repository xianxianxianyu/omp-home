import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { EnvDTO, LeaseDTO, ResourcesDTO, ServiceDTO } from "../shared/api.ts";
import type { HomePaths } from "./config.ts";
import { expand, slugOf, type EnvRecipe, type ServiceSpec, type Vars } from "./core/recipe.ts";
import type { Db } from "./db.ts";
import { errorText, HubError } from "./errors.ts";
import type { WorktreeRow, Worktrees } from "./git.ts";
import type { SettingsStore } from "./settings.ts";
import type { WorkspaceRow, Workspaces } from "./workspaces.ts";

const execFileP = promisify(execFile);

export interface EnvRow {
	worktree_id: string;
	state: EnvDTO["state"];
	recipe_hash: string;
	vars: string;
	error: string | null;
	updated_at: number;
}

export interface ServiceRow {
	id: string;
	workspace_id: string;
	name: string;
	kind: "external" | "run";
	pid: number | null;
	state: ServiceDTO["state"];
	checked_at: number | null;
	error: string | null;
}

export interface LeaseRow {
	id: number;
	kind: LeaseDTO["kind"];
	key: string;
	label: string;
	holder_kind: LeaseDTO["holderKind"];
	holder_id: string;
	acquired_at: number;
	expires_at: number | null;
	released_at: number | null;
}

/** An environment step failed; the message is meant for the agent or human. */
export class EnvError extends Error {}

const SETUP_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 4000;

/**
 * Sole writer of worktree_env, service and lease. Brings a worktree's test environment
 * to what its workspace recipe describes; every step checks observed state first, so
 * re-running after a crash or a recipe edit converges.
 */
export class Env {
	readonly #db: Db;
	readonly #paths: HomePaths;
	readonly #settings: SettingsStore;
	readonly #workspaces: Workspaces;
	readonly #worktrees: Worktrees;
	readonly #changed: () => void;
	readonly #inflight = new Map<string, Promise<unknown>>();
	#portLock: Promise<unknown> = Promise.resolve();

	constructor(db: Db, paths: HomePaths, settings: SettingsStore, workspaces: Workspaces, worktrees: Worktrees, changed: () => void) {
		this.#db = db;
		this.#paths = paths;
		this.#settings = settings;
		this.#workspaces = workspaces;
		this.#worktrees = worktrees;
		this.#changed = changed;
	}

	/** Coalesce concurrent runs of the same job (provisioner + home_env repair, two tasks on one workspace). */
	#once<T>(key: string, job: () => Promise<T>): Promise<T> {
		const running = this.#inflight.get(key);
		if (running) return running as Promise<T>;
		const p = job().finally(() => this.#inflight.delete(key));
		this.#inflight.set(key, p);
		return p;
	}

	envRow(worktreeId: string): EnvRow | undefined {
		return this.#db.get<EnvRow>("SELECT * FROM worktree_env WHERE worktree_id = ?", worktreeId);
	}

	varsOf(worktreeId: string | null): Record<string, string> {
		if (!worktreeId) return {};
		const row = this.envRow(worktreeId);
		return row ? (JSON.parse(row.vars) as Record<string, string>) : {};
	}

	logPath(worktreeId: string): string {
		return path.join(this.#paths.envLogs, `${worktreeId}.log`);
	}

	#setEnv(worktreeId: string, state: EnvRow["state"], hash: string, vars: Record<string, string> | null, error: string | null): void {
		this.#db.run(
			`INSERT INTO worktree_env (worktree_id, state, recipe_hash, vars, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (worktree_id) DO UPDATE SET state = excluded.state, recipe_hash = excluded.recipe_hash,
			   vars = CASE WHEN ? THEN excluded.vars ELSE worktree_env.vars END, error = excluded.error, updated_at = excluded.updated_at`,
			worktreeId,
			state,
			hash,
			JSON.stringify(vars ?? {}),
			error,
			Date.now(),
			vars ? 1 : 0,
		);
		this.#changed();
	}

	ensure(worktreeId: string, opts: { force?: boolean } = {}): Promise<EnvRow> {
		return this.#once(`env:${worktreeId}`, () => this.#ensure(worktreeId, opts.force ?? false));
	}

	async #ensure(worktreeId: string, force: boolean): Promise<EnvRow> {
		const wt = this.#worktrees.get(worktreeId);
		if (!wt || wt.state !== "ready") throw new EnvError(`worktree ${worktreeId} is not present on disk`);
		const ws = this.#workspaces.must(wt.workspace_id);
		const loaded = this.#workspaces.loadRecipe(ws.id);
		if (loaded.status === "missing") {
			this.#setEnv(worktreeId, "ready", "none", {}, null);
			return this.envRow(worktreeId)!;
		}
		if (loaded.status === "invalid") {
			const message = `recipe ${this.#workspaces.recipePath(ws.id)} is invalid: ${loaded.errors.map(e => `${e.path || "(root)"}: ${e.message}`).join("; ")}`;
			this.#setEnv(worktreeId, "failed", "invalid", null, message);
			throw new EnvError(message);
		}
		const { recipe, hash } = loaded;
		const prev = this.envRow(worktreeId);
		this.#setEnv(worktreeId, "preparing", prev?.recipe_hash ?? hash, null, null);
		const log = this.logPath(worktreeId);
		fs.mkdirSync(path.dirname(log), { recursive: true });
		try {
			await this.ensureServices(ws, recipe);
			const vars = await this.#worktreeVars(ws, wt, recipe, true);
			if (recipe.database) await this.#ensureDatabase(ws, wt, recipe, vars, log);
			for (const rel of recipe.copy) {
				const from = path.resolve(ws.repo_path, rel);
				const to = path.resolve(wt.path, rel);
				if (!fs.existsSync(to) && fs.existsSync(from)) {
					fs.mkdirSync(path.dirname(to), { recursive: true });
					fs.cpSync(from, to, { recursive: true });
				}
			}
			const exported = Object.fromEntries(Object.entries(recipe.env).map(([k, v]) => [k, expand(v, vars, "plain")]));
			if (force || prev?.state !== "ready" || prev.recipe_hash !== hash) {
				for (const cmd of recipe.setup) {
					const r = await runShell(expand(cmd, vars, "shell"), { cwd: wt.path, env: { ...process.env, ...exported }, timeoutMs: SETUP_TIMEOUT_MS, log });
					if (r.code !== 0) throw new EnvError(`setup command failed (exit ${r.code}): ${cmd}\n${r.output}`);
				}
			}
			this.#setEnv(worktreeId, "ready", hash, exported, null);
		} catch (err) {
			const message = err instanceof EnvError ? err.message : `environment failed: ${errorText(err)}`;
			this.#setEnv(worktreeId, "failed", hash, null, `${message}\nLog: ${log}`);
			throw new EnvError(`${message}\nLog: ${log}`);
		}
		return this.envRow(worktreeId)!;
	}

	/** Template variables for a worktree. Port leases are acquired when `acquire` is set. */
	async #worktreeVars(ws: WorkspaceRow, wt: WorktreeRow, recipe: EnvRecipe, acquire: boolean): Promise<Vars> {
		const port: Record<string, number> = { ...this.#servicePorts(ws.id) };
		for (const name of recipe.ports) {
			const held = this.#activeLease("worktree", wt.id, "port", name);
			if (held) port[name] = Number(held.key);
			else if (acquire) port[name] = await this.#leasePort("worktree", wt.id, name);
		}
		const vars: Vars = { repo: ws.repo_path, worktree: wt.path, branch: wt.branch, slug: slugOf(wt.branch), port };
		if (recipe.database) {
			const name = expand(recipe.database.name, vars, "plain");
			const template = recipe.database.template;
			vars.db = { name, template, url: expand(recipe.database.url, { ...vars, db: { name, template, url: "" } }, "plain") };
		}
		return vars;
	}

	async #ensureDatabase(ws: WorkspaceRow, wt: WorktreeRow, recipe: EnvRecipe, vars: Vars, log: string): Promise<void> {
		const d = recipe.database!;
		const name = vars.db!.name;
		this.#db.tx(() => {
			if (this.#activeLease("worktree", wt.id, "db", "database")?.key === name) return;
			const other = this.#db.get<LeaseRow>("SELECT * FROM lease WHERE kind = 'db' AND key = ? AND released_at IS NULL", name);
			if (other) throw new EnvError(`database ${name} is already leased by ${other.holder_kind} ${other.holder_id}`);
			this.#db.run("UPDATE lease SET released_at = ? WHERE holder_kind = 'worktree' AND holder_id = ? AND kind = 'db' AND released_at IS NULL", Date.now(), wt.id);
			this.#insertLease("db", name, "database", "worktree", wt.id, null);
		});
		const env = { ...process.env };
		const exists = await runShell(expand(d.exists, vars, "shell"), { cwd: ws.repo_path, env, timeoutMs: COMMAND_TIMEOUT_MS, log });
		if (exists.code === 0) return;
		const clone = await runShell(expand(d.clone, vars, "shell"), { cwd: ws.repo_path, env, timeoutMs: SETUP_TIMEOUT_MS, log });
		if (clone.code !== 0) throw new EnvError(`database clone failed (exit ${clone.code}): ${clone.output}`);
	}

	/** Shared services of a workspace: `check` first, start only what is down. */
	ensureServices(ws: WorkspaceRow, recipe: EnvRecipe): Promise<void> {
		return this.#once(`services:${ws.id}`, async () => {
			for (const [name, spec] of Object.entries(recipe.services)) await this.#ensureService(ws, name, spec);
		});
	}

	#serviceLog(workspaceId: string, name: string): string {
		return path.join(this.#paths.serviceLogs, `${workspaceId}-${name}.log`);
	}

	#setService(ws: WorkspaceRow, name: string, kind: ServiceRow["kind"], state: ServiceRow["state"], pid: number | null, error: string | null): void {
		this.#db.run(
			`INSERT INTO service (id, workspace_id, name, kind, pid, state, checked_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, pid = excluded.pid, state = excluded.state, checked_at = excluded.checked_at, error = excluded.error`,
			`${ws.id}/${name}`,
			ws.id,
			name,
			kind,
			pid,
			state,
			Date.now(),
			error,
		);
		this.#changed();
	}

	async #serviceVars(ws: WorkspaceRow, spec: ServiceSpec): Promise<Vars> {
		const port = this.#servicePorts(ws.id);
		if (spec.kind === "run") {
			for (const p of spec.ports) port[p] ??= await this.#leasePort("service", ws.id, p);
		}
		return { repo: ws.repo_path, port };
	}

	async #ensureService(ws: WorkspaceRow, name: string, spec: ServiceSpec): Promise<ServiceRow> {
		const log = this.#serviceLog(ws.id, name);
		fs.mkdirSync(path.dirname(log), { recursive: true });
		const vars = await this.#serviceVars(ws, spec);
		const check = () => runShell(expand(spec.check, vars, "shell"), { cwd: ws.repo_path, env: { ...process.env }, timeoutMs: 30_000, log });
		const current = this.#db.get<ServiceRow>("SELECT * FROM service WHERE id = ?", `${ws.id}/${name}`);
		if ((await check()).code === 0) {
			this.#setService(ws, name, spec.kind, "up", current?.pid ?? null, null);
			return this.#service(`${ws.id}/${name}`)!;
		}
		this.#setService(ws, name, spec.kind, "starting", current?.pid ?? null, null);
		let pid: number | null = null;
		if (spec.kind === "external") {
			const r = await runShell(expand(spec.start, vars, "shell"), { cwd: ws.repo_path, env: { ...process.env }, timeoutMs: spec.timeoutSec * 1000, log });
			if (r.code !== 0) {
				this.#setService(ws, name, spec.kind, "failed", null, `start failed (exit ${r.code}): ${r.output}`);
				throw new EnvError(`service ${name}: start failed (exit ${r.code}). Log: ${log}`);
			}
		} else {
			const fd = fs.openSync(log, "a");
			const child = spawn("/bin/sh", ["-c", expand(spec.run, vars, "shell")], { cwd: ws.repo_path, env: { ...process.env }, detached: true, stdio: ["ignore", fd, fd] });
			fs.closeSync(fd);
			child.on("error", () => {});
			child.unref();
			pid = child.pid ?? null;
		}
		const deadline = Date.now() + spec.timeoutSec * 1000;
		while (Date.now() < deadline) {
			await sleep(500);
			if ((await check()).code === 0) {
				this.#setService(ws, name, spec.kind, "up", pid, null);
				return this.#service(`${ws.id}/${name}`)!;
			}
		}
		const tail = readTail(log, 1500);
		this.#setService(ws, name, spec.kind, "failed", pid, `check still failing after ${spec.timeoutSec}s`);
		throw new EnvError(`service ${name}: check still failing after ${spec.timeoutSec}s. Log: ${log}\n${tail}`);
	}

	#service(id: string): ServiceRow | undefined {
		return this.#db.get<ServiceRow>("SELECT * FROM service WHERE id = ?", id);
	}

	/** Human-only service actions from the Resources view. */
	async serviceAction(id: string, action: "start" | "stop" | "check"): Promise<ServiceDTO> {
		const row = this.#service(id);
		const workspaceId = row?.workspace_id ?? id.split("/")[0]!;
		const name = row?.name ?? id.split("/").slice(1).join("/");
		const ws = this.#workspaces.must(workspaceId);
		const loaded = this.#workspaces.loadRecipe(ws.id);
		const spec = loaded.status === "ok" ? loaded.recipe.services[name] : undefined;
		if (!spec) throw new HubError("not_found", `service ${id} is not in the ${ws.id} recipe`);
		if (action === "start") {
			await this.#ensureService(ws, name, spec).catch(err => {
				if (!(err instanceof EnvError)) throw err;
			});
		} else if (action === "check") {
			const vars = await this.#serviceVars(ws, spec);
			const r = await runShell(expand(spec.check, vars, "shell"), { cwd: ws.repo_path, env: { ...process.env }, timeoutMs: 30_000, log: this.#serviceLog(ws.id, name) });
			this.#setService(ws, name, spec.kind, r.code === 0 ? "up" : "down", row?.pid ?? null, r.code === 0 ? null : `check failed (exit ${r.code})`);
		} else {
			if (spec.kind === "run") {
				if (row?.pid) killGroup(row.pid);
			} else if (spec.stop) {
				const vars = await this.#serviceVars(ws, spec);
				const r = await runShell(expand(spec.stop, vars, "shell"), { cwd: ws.repo_path, env: { ...process.env }, timeoutMs: spec.timeoutSec * 1000, log: this.#serviceLog(ws.id, name) });
				if (r.code !== 0) throw new HubError("conflict", `stop failed (exit ${r.code}): ${r.output.slice(-500)}`);
			} else {
				throw new HubError("invalid", `service ${id} has no stop command in the recipe`);
			}
			this.#setService(ws, name, spec.kind, "down", null, null);
		}
		return this.serviceDTO(this.#service(id)!);
	}

	async teardown(worktreeId: string): Promise<void> {
		const wt = this.#worktrees.get(worktreeId);
		if (!wt) return;
		const ws = this.#workspaces.must(wt.workspace_id);
		const loaded = this.#workspaces.loadRecipe(ws.id);
		const log = this.logPath(worktreeId);
		fs.mkdirSync(path.dirname(log), { recursive: true });
		if (loaded.status === "ok" && fs.existsSync(wt.path)) {
			const vars = await this.#worktreeVars(ws, wt, loaded.recipe, false);
			const env = { ...process.env, ...this.varsOf(worktreeId) };
			for (const cmd of loaded.recipe.teardown) {
				const r = await runShell(expand(cmd, vars, "shell"), { cwd: wt.path, env, timeoutMs: COMMAND_TIMEOUT_MS, log });
				if (r.code !== 0) throw new HubError("conflict", `teardown command failed (exit ${r.code}): ${cmd}. Log: ${log}`);
			}
			if (loaded.recipe.database && this.#activeLease("worktree", wt.id, "db", "database")) {
				const r = await runShell(expand(loaded.recipe.database.drop, vars, "shell"), { cwd: ws.repo_path, env: { ...process.env }, timeoutMs: COMMAND_TIMEOUT_MS, log });
				if (r.code !== 0) throw new HubError("conflict", `database drop failed (exit ${r.code}). Log: ${log}`);
			}
		}
		this.#db.run("UPDATE lease SET released_at = ? WHERE holder_kind = 'worktree' AND holder_id = ? AND released_at IS NULL", Date.now(), worktreeId);
		if (this.envRow(worktreeId)) this.#setEnv(worktreeId, "torn_down", this.envRow(worktreeId)!.recipe_hash, {}, null);
	}

	// ── leases ───────────────────────────────────────────────────────────────

	#activeLease(holderKind: LeaseRow["holder_kind"], holderId: string, kind: LeaseRow["kind"], label: string): LeaseRow | undefined {
		return this.#db.get<LeaseRow>(
			"SELECT * FROM lease WHERE holder_kind = ? AND holder_id = ? AND kind = ? AND label = ? AND released_at IS NULL",
			holderKind,
			holderId,
			kind,
			label,
		);
	}

	#insertLease(kind: LeaseRow["kind"], key: string, label: string, holderKind: LeaseRow["holder_kind"], holderId: string, expiresAt: number | null): LeaseRow {
		const id = this.#db.run(
			"INSERT INTO lease (kind, key, label, holder_kind, holder_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			kind,
			key,
			label,
			holderKind,
			holderId,
			Date.now(),
			expiresAt,
		).id;
		this.#changed();
		return this.#db.get<LeaseRow>("SELECT * FROM lease WHERE id = ?", id)!;
	}

	#servicePorts(workspaceId: string): Record<string, number> {
		const rows = this.#db.all<LeaseRow>("SELECT * FROM lease WHERE holder_kind = 'service' AND holder_id = ? AND kind = 'port' AND released_at IS NULL", workspaceId);
		return Object.fromEntries(rows.map(r => [r.label, Number(r.key)]));
	}

	/** Allocate a port from settings.portRange that is unleased and not bound right now. Serialized. */
	#leasePort(holderKind: "worktree" | "service", holderId: string, label: string): Promise<number> {
		const job = this.#portLock.then(async () => {
			const held = this.#activeLease(holderKind, holderId, "port", label);
			if (held) return Number(held.key);
			const [lo, hi] = this.#settings.get().portRange;
			const taken = new Set(this.#db.all<{ key: string }>("SELECT key FROM lease WHERE kind = 'port' AND released_at IS NULL").map(r => Number(r.key)));
			for (let port = lo; port <= hi; port++) {
				if (taken.has(port) || !(await portFree(port))) continue;
				this.#insertLease("port", String(port), label, holderKind, holderId, null);
				return port;
			}
			throw new EnvError(`no free port left in ${lo}-${hi}; widen settings.portRange or clean up finished tasks`);
		});
		this.#portLock = job.catch(() => {});
		return job;
	}

	/** One account per pool per session; re-leasing extends the TTL. Secrets are resolved now and never stored. */
	async leaseAccount(sessionId: string, workspaceId: string, pool: string): Promise<{ lease: LeaseRow; item: string; fields: Record<string, string> }> {
		const loaded = this.#workspaces.loadRecipe(workspaceId);
		if (loaded.status !== "ok") throw new HubError("unavailable", `workspace ${workspaceId} has no valid recipe`);
		const spec = loaded.recipe.accounts[pool];
		if (!spec) {
			const known = Object.keys(loaded.recipe.accounts);
			throw new HubError("not_found", `no account pool "${pool}"${known.length ? `; pools: ${known.join(", ")}` : "; the recipe defines none"}`);
		}
		this.releaseExpired();
		const expiresAt = Date.now() + spec.ttlMinutes * 60_000;
		const lease = this.#db.tx(() => {
			const held = this.#activeLease("session", sessionId, "account", pool);
			if (held) {
				this.#db.run("UPDATE lease SET expires_at = ? WHERE id = ?", expiresAt, held.id);
				return this.#db.get<LeaseRow>("SELECT * FROM lease WHERE id = ?", held.id)!;
			}
			for (const item of spec.items) {
				const key = `${workspaceId}/${pool}/${item.id}`;
				if (this.#db.get("SELECT 1 FROM lease WHERE kind = 'account' AND key = ? AND released_at IS NULL", key)) continue;
				return this.#insertLease("account", key, pool, "session", sessionId, expiresAt);
			}
			throw new HubError("unavailable", `all ${spec.items.length} accounts in "${pool}" are leased; try again after a worker's turn ends`);
		});
		const itemId = lease.key.split("/").at(-1)!;
		const item = spec.items.find(i => i.id === itemId)!;
		const fields: Record<string, string> = {};
		for (const [k, v] of Object.entries(item.fields)) {
			if (typeof v === "string") fields[k] = v;
			else if ("env" in v) {
				const value = process.env[v.env];
				if (value === undefined) throw new HubError("unavailable", `account ${itemId}.${k}: environment variable ${v.env} is not set in the hub`);
				fields[k] = value;
			} else {
				fields[k] = await execFileP("security", ["find-generic-password", "-s", v.keychain, "-w"]).then(
					r => r.stdout.replace(/\n$/, ""),
					() => {
						throw new HubError("unavailable", `account ${itemId}.${k}: keychain item "${v.keychain}" not found (security find-generic-password -s ${v.keychain})`);
					},
				);
			}
		}
		return { lease, item: itemId, fields };
	}

	releaseSession(sessionId: string): void {
		const r = this.#db.run("UPDATE lease SET released_at = ? WHERE holder_kind = 'session' AND holder_id = ? AND released_at IS NULL", Date.now(), sessionId);
		if (r.changes) this.#changed();
	}

	release(id: number): LeaseDTO {
		const row = this.#db.get<LeaseRow>("SELECT * FROM lease WHERE id = ?", id);
		if (!row) throw new HubError("not_found", `no lease ${id}`);
		this.#db.run("UPDATE lease SET released_at = coalesce(released_at, ?) WHERE id = ?", Date.now(), id);
		this.#changed();
		return leaseDTO(row);
	}

	releaseExpired(): void {
		const r = this.#db.run("UPDATE lease SET released_at = expires_at WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?", Date.now());
		if (r.changes) this.#changed();
	}

	// ── views ────────────────────────────────────────────────────────────────

	/** What `home_env` tells a worker. */
	describe(ws: WorkspaceRow, wt: WorktreeRow | null): string {
		const loaded = this.#workspaces.loadRecipe(ws.id);
		const lines: string[] = [];
		if (wt) lines.push(`Worktree: ${wt.path} · branch ${wt.branch} (${wt.id})`);
		else lines.push(`Read-only checkout: ${ws.repo_path}`);
		if (loaded.status === "missing") {
			lines.push(`No environment recipe: ${this.#workspaces.recipePath(ws.id)} does not exist. Ask the home agent if this task needs one.`);
			return lines.join("\n");
		}
		if (loaded.status === "invalid") {
			lines.push(`Recipe ${this.#workspaces.recipePath(ws.id)} is invalid: ${loaded.errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
			return lines.join("\n");
		}
		const recipe = loaded.recipe;
		if (wt) {
			const env = this.envRow(wt.id);
			lines.push(`Environment: ${env?.state ?? "not prepared"}${env?.error ? ` — ${env.error}` : ""}`);
			const vars = this.varsOf(wt.id);
			if (Object.keys(vars).length) lines.push(`Env vars (exported at session start): ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(" ")}`);
			const ports = recipe.ports.map(p => `${p}=${this.#activeLease("worktree", wt.id, "port", p)?.key ?? "?"}`);
			if (ports.length) lines.push(`Ports: ${ports.join(" ")}`);
			const db = this.#activeLease("worktree", wt.id, "db", "database");
			if (recipe.database && db) lines.push(`Database: ${db.key} (cloned from ${recipe.database.template})`);
			lines.push(`Setup log: ${this.logPath(wt.id)}`);
		}
		const services = Object.keys(recipe.services).map(name => {
			const s = this.#service(`${ws.id}/${name}`);
			return `${name} ${s?.state ?? "unknown"}`;
		});
		const sharedPorts = Object.entries(this.#servicePorts(ws.id)).map(([k, v]) => `${k}=${v}`);
		if (services.length) lines.push(`Services: ${services.join(" · ")}${sharedPorts.length ? ` · shared ports ${sharedPorts.join(" ")}` : ""}`);
		const pools = Object.entries(recipe.accounts).map(([pool, spec]) => {
			const used = this.#db.get<{ n: number }>("SELECT count(*) AS n FROM lease WHERE kind = 'account' AND label = ? AND key LIKE ? AND released_at IS NULL", pool, `${ws.id}/${pool}/%`)!.n;
			return `${pool} (${spec.items.length - used}/${spec.items.length} free)`;
		});
		if (pools.length) lines.push(`Account pools: ${pools.join(", ")} — lease one with home_lease({pool})`);
		const tests = Object.entries(this.testCommands(ws, wt));
		if (tests.length) lines.push(`Tests: ${tests.map(([k, v]) => `${k}: \`${v}\``).join(" · ")}`);
		return lines.join("\n");
	}

	/** Recipe test commands with variables filled in where this checkout has values. */
	testCommands(ws: WorkspaceRow, wt: WorktreeRow | null): Record<string, string> {
		const loaded = this.#workspaces.loadRecipe(ws.id);
		if (loaded.status !== "ok") return {};
		const recipe = loaded.recipe;
		const port: Record<string, number> = { ...this.#servicePorts(ws.id) };
		const vars: Vars = { repo: ws.repo_path, port };
		if (wt) {
			Object.assign(vars, { worktree: wt.path, branch: wt.branch, slug: slugOf(wt.branch) });
			for (const p of recipe.ports) {
				const held = this.#activeLease("worktree", wt.id, "port", p);
				if (held) port[p] = Number(held.key);
			}
			const db = this.#activeLease("worktree", wt.id, "db", "database");
			if (recipe.database && db) vars.db = { name: db.key, template: recipe.database.template, url: expand(recipe.database.url, { ...vars, db: { name: db.key, template: recipe.database.template, url: "" } }, "plain") };
		}
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(recipe.test)) {
			try {
				out[k] = expand(v, vars, "shell");
			} catch {
				out[k] = v;
			}
		}
		return out;
	}

	recipeSummary(workspaceId: string): { services: string[]; pools: string[] } {
		const loaded = this.#workspaces.loadRecipe(workspaceId);
		if (loaded.status !== "ok") return { services: [], pools: [] };
		return { services: Object.keys(loaded.recipe.services), pools: Object.keys(loaded.recipe.accounts) };
	}

	envDTO(row: EnvRow): EnvDTO | null {
		const wt = this.#worktrees.get(row.worktree_id);
		if (!wt) return null;
		return {
			worktreeId: row.worktree_id,
			worktreePath: wt.path,
			workspace: wt.workspace_id,
			state: row.state,
			error: row.error,
			vars: JSON.parse(row.vars) as Record<string, string>,
			updatedAt: row.updated_at,
		};
	}

	serviceDTO(s: ServiceRow): ServiceDTO {
		return {
			id: s.id,
			workspace: s.workspace_id,
			name: s.name,
			kind: s.kind,
			state: s.state,
			pid: s.pid,
			checkedAt: s.checked_at,
			error: s.error,
			logTail: readTail(this.#serviceLog(s.workspace_id, s.name), OUTPUT_TAIL),
		};
	}

	resources(): ResourcesDTO {
		this.releaseExpired();
		return {
			services: this.#db.all<ServiceRow>("SELECT * FROM service ORDER BY id").map(s => this.serviceDTO(s)),
			leases: this.#db.all<LeaseRow>("SELECT * FROM lease WHERE released_at IS NULL ORDER BY id").map(leaseDTO),
			environments: this.#db
				.all<EnvRow>("SELECT * FROM worktree_env WHERE state <> 'torn_down' ORDER BY updated_at DESC")
				.map(r => this.envDTO(r))
				.filter(e => e !== null),
		};
	}
}

function leaseDTO(l: LeaseRow): LeaseDTO {
	return {
		id: l.id,
		kind: l.kind,
		key: l.key,
		label: l.label,
		holderKind: l.holder_kind,
		holderId: l.holder_id,
		acquiredAt: l.acquired_at,
		expiresAt: l.expires_at,
	};
}

export function readTail(file: string, bytes: number): string {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return "";
	}
	try {
		const size = fs.fstatSync(fd).size;
		const len = Math.min(size, bytes);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, size - len);
		return buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
}

/** Run one shell command; output is appended to `log` and its tail returned. */
export function runShell(cmd: string, o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; log: string }): Promise<{ code: number; output: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
	const log = fs.createWriteStream(o.log, { flags: "a" });
	log.write(`\n[${new Date().toISOString()}] $ ${cmd}\n`);
	let tail = "";
	const child = spawn("/bin/sh", ["-c", cmd], { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
	const onData = (chunk: Buffer) => {
		log.write(chunk);
		tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	const timer = setTimeout(() => {
		tail += `\n[omp-home] timed out after ${Math.round(o.timeoutMs / 1000)}s`;
		if (child.pid) killGroup(child.pid);
	}, o.timeoutMs);
	let done = false;
	const finish = (code: number) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		log.end(`[exit ${code}]\n`);
		resolve({ code, output: tail.trim() });
	};
	child.on("error", () => finish(127));
	child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
	return promise;
}

/** Free when nothing accepts on 127.0.0.1 and the wildcard address can be bound. */
async function portFree(port: number): Promise<boolean> {
	const probe = Promise.withResolvers<boolean>();
	const sock = net.connect({ port, host: "127.0.0.1" });
	sock.once("connect", () => {
		sock.destroy();
		probe.resolve(true);
	});
	sock.once("error", () => probe.resolve(false));
	if (await probe.promise) return false;
	const bind = Promise.withResolvers<boolean>();
	const server = net.createServer();
	server.once("error", () => bind.resolve(false));
	server.listen({ port, exclusive: true }, () => server.close(() => bind.resolve(true)));
	return bind.promise;
}
