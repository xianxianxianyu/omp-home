import fs from "node:fs";
import path from "node:path";
import type { BranchDTO, BranchesDTO, BranchHold, BranchPhase, Language, Topic } from "../shared/api.ts";
import type { CheckoutSpec } from "../shared/tools.ts";
import { decide, inFlight, parseNewBranch, phase, type LatestTask, type Plan, type RetireReason, type WorktreeFacts, type WorktreeState } from "./core/worktree.ts";
import type { Db } from "./db.ts";
import type { Env } from "./env.ts";
import { errorText, HubError } from "./errors.ts";
import { aheadBehind, canonicalPath, changedFiles, checkouts, freshestBase, git, integratedByContent, isValidBranchName, survey, worktreePath, type RepoSurvey } from "./git.ts";
import { render, type Message } from "./i18n.ts";
import { worktreeMessages as m } from "./i18n-worktree.ts";
import { isOpen, statusText, waitOf, type ApplyResult, type Ledger, type TaskRow } from "./ledger.ts";
import type { Pool } from "./pool.ts";
import type { SettingsStore } from "./settings.ts";
import type { WorkspaceRow, Workspaces } from "./workspaces.ts";

/**
 * The worktree lifecycle: the `worktree` table (the hub's intent per branch) and the only
 * code that changes repositories (worktree add/remove/prune/lock, branch deletes, fetches).
 * Policy is the pure `decide` in core/worktree.ts; this module observes git and the ledger,
 * applies the plan, and serializes every git mutation per repository.
 */

/** A task detail or tool read reuses an observation this young. */
export const LOOK_FRESH_MS = 30_000;
/** Memoized git answers keyed by commit shas; dropped wholesale past this size. */
const MEMO_MAX = 2000;
const FETCH_EVERY_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const STALE_IDLE_MS = 14 * 24 * 60 * 60_000;
const KEEP_REASON = "omp-home: kept";

export interface WorktreeRow {
	id: string;
	workspace_id: string;
	branch: string;
	path: string;
	fork_ref: string;
	fork_sha: string | null;
	state: WorktreeState;
	retire_reason: RetireReason | null;
	retired_sha: string | null;
	retire_error: string | null;
	created_at: number;
	retired_at: number | null;
}

/** Sole writer of `worktree`. Each transition names its from-state in SQL, so a stale caller changes nothing. */
export class Worktrees {
	readonly #db: Db;

	constructor(db: Db) {
		this.#db = db;
	}

	get(id: string): WorktreeRow | undefined {
		return this.#db.get<WorktreeRow>("SELECT * FROM worktree WHERE id = ?", id);
	}

	/** The unretired row of a branch (at most one, by `worktree_branch_live`). */
	live(workspaceId: string, branch: string): WorktreeRow | undefined {
		return this.#db.get<WorktreeRow>("SELECT * FROM worktree WHERE workspace_id = ? AND branch = ? AND state <> 'retired'", workspaceId, branch);
	}

	unretired(workspaceId?: string): WorktreeRow[] {
		return workspaceId
			? this.#db.all<WorktreeRow>("SELECT * FROM worktree WHERE workspace_id = ? AND state <> 'retired' ORDER BY created_at", workspaceId)
			: this.#db.all<WorktreeRow>("SELECT * FROM worktree WHERE state <> 'retired' ORDER BY created_at");
	}

	retired(workspaceId: string, limit: number): WorktreeRow[] {
		return this.#db.all<WorktreeRow>("SELECT * FROM worktree WHERE workspace_id = ? AND state = 'retired' ORDER BY retired_at DESC LIMIT ?", workspaceId, limit);
	}

	/** A new live row. Two branches whose names map to one directory keep apart by the row id. */
	insert(input: { workspaceId: string; branch: string; path: string; forkRef: string; forkSha: string }): WorktreeRow {
		return this.#db.tx(() => {
			const { id } = this.#db.nextId("WT");
			const taken = this.#db.get("SELECT 1 FROM worktree WHERE path = ? AND state <> 'retired'", input.path);
			this.#db.run(
				"INSERT INTO worktree (id, workspace_id, branch, path, fork_ref, fork_sha, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)",
				id,
				input.workspaceId,
				input.branch,
				taken ? `${input.path}-${id.toLowerCase()}` : input.path,
				input.forkRef,
				input.forkSha,
				Date.now(),
			);
			return this.get(id)!;
		});
	}

	/** The human checked the branch out in a worktree of their own; follow it. */
	relocate(id: string, dir: string): void {
		this.#db.run("UPDATE worktree SET path = ? WHERE id = ? AND state = 'live'", dir, id);
	}

	beginRetire(id: string, reason: RetireReason, sha: string | null): boolean {
		return (
			this.#db.run("UPDATE worktree SET state = 'retiring', retire_reason = ?, retired_sha = ?, retire_error = NULL WHERE id = ? AND state = 'live'", reason, sha, id).changes === 1
		);
	}

	/** A step failed in a way only a retry can fix (environment teardown); the row stays retiring. */
	failRetire(id: string, error: string): void {
		this.#db.run("UPDATE worktree SET retire_error = ? WHERE id = ? AND state = 'retiring'", error, id);
	}

	/** Git refused (the worktree changed, the branch moved): the row is live again, with the reason shown. */
	abortRetire(id: string, error: string): void {
		this.#db.run("UPDATE worktree SET state = 'live', retire_reason = NULL, retired_sha = NULL, retire_error = ? WHERE id = ? AND state = 'retiring'", error, id);
	}

	finishRetire(id: string): void {
		this.#db.run("UPDATE worktree SET state = 'retired', retire_error = NULL, retired_at = ? WHERE id = ? AND state = 'retiring'", Date.now(), id);
	}

	clearError(id: string): void {
		this.#db.run("UPDATE worktree SET retire_error = NULL WHERE id = ? AND state = 'live'", id);
	}
}

// ── repository mutations ─────────────────────────────────────────────────────

const queues = new Map<string, Promise<unknown>>();

/** One git mutation at a time per repository, so a worktree add, a removal and a fetch never interleave. */
function serial<T>(root: string, job: () => Promise<T>): Promise<T> {
	const run = (queues.get(root) ?? Promise.resolve()).then(job);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	queues.set(root, tail);
	void tail.then(() => {
		if (queues.get(root) === tail) queues.delete(root);
	});
	return run;
}

async function tipOf(root: string, branch: string): Promise<string | null> {
	return git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => null);
}

/** A detached throwaway checkout (recipe trial runs); returns its HEAD. */
export function addScratchWorktree(root: string, dir: string, rev: string): Promise<string> {
	return serial(root, async () => {
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		await git(root, ["worktree", "add", "--detach", "--", dir, rev], { timeout: 120_000 });
		return git(dir, ["rev-parse", "HEAD"]);
	});
}

/** Remove a throwaway checkout and whatever is left in its directory; repeating it is harmless. */
export function removeScratchWorktree(root: string, dir: string): Promise<void> {
	return serial(root, async () => {
		if ((await checkouts(root)).has(canonicalPath(dir))) await git(root, ["worktree", "remove", "--force", "--", dir], { timeout: 120_000 });
		fs.rmSync(dir, { recursive: true, force: true });
		await git(root, ["worktree", "prune"]);
	});
}

/**
 * Bring the base's remote-tracking ref up to date so merges on the remote are noticed without a
 * pull: only the base, never interactive, bounded. No upstream (or a local one): nothing to do.
 */
async function fetchBase(root: string, base: string): Promise<void> {
	const config = (key: string) => git(root, ["config", "--get", key]).catch(() => "");
	const [remote, merge] = await Promise.all([config(`branch.${base}.remote`), config(`branch.${base}.merge`)]);
	if (!remote || remote === "." || !merge) return;
	await git(root, ["fetch", "--no-tags", "--quiet", remote, merge], {
		timeout: FETCH_TIMEOUT_MS,
		env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
	});
}

// ── the lifecycle ────────────────────────────────────────────────────────────

/** A dispatch's checkout after validation against git; `claim` turns a branch target into a row. */
export type Target =
	| { lane: "main"; spec: CheckoutSpec; where: string }
	| {
			lane: "branch";
			spec: CheckoutSpec;
			branch: string;
			where: string;
			start: { kind: "new"; forkRef: string; forkSha: string } | { kind: "existing"; tip: string; row: string | null };
	  };

interface Look {
	facts: WorktreeFacts;
	plan: Plan;
	/** The target the tip's content was found in. */
	into: string | null;
	ahead: number | null;
	behind: number | null;
	upstreamGone: boolean;
	dirtyFiles: number | null;
	/** Another worktree (the main checkout included) that has the branch checked out. */
	elsewhereAt: string | null;
}

export interface LifecycleDeps {
	db: Db;
	worktrees: Worktrees;
	ledger: Ledger;
	pool: Pool;
	env: Env;
	workspaces: Workspaces;
	settings: SettingsStore;
	/** A ledger change made here, for the hub's shared follow-up (notices, UI topics). */
	applied(taskId: string, r: ApplyResult): void;
	changed(...topics: Topic[]): void;
	log(message: string): void;
}

const latestOf = (t: TaskRow): LatestTask => ({ id: t.id, status: t.status, waitKind: waitOf(t)?.kind ?? null, runOpen: t.run_open === 1, settled: t.settled === 1 });

/**
 * Sole mutator of hub-managed worktrees and branches. Dispatch resolves and claims a branch,
 * the provisioner checks it out, sweeps settle merged tasks and retire what git shows is
 * safe to remove, and the human removes, discards or keeps from the UI.
 */
export class WorktreeLifecycle {
	readonly #d: LifecycleDeps;
	readonly #looks = new Map<string, Look>();
	readonly #lookSigs = new Map<string, string>();
	readonly #checked = new Map<string, number>();
	readonly #fetched = new Map<string, number>();
	/** Content checks are pure in (tip, target): a merged branch is probed once per base move. */
	readonly #content = new Map<string, boolean>();
	readonly #counts = new Map<string, { ahead: number; behind: number }>();
	readonly #sweeps = new Map<string, { running: Promise<void> | null; next: Promise<void> | null }>();
	readonly #pending = new Set<Promise<void>>();

	constructor(deps: LifecycleDeps) {
		this.#d = deps;
	}

	// ── dispatch ─────────────────────────────────────────────────────────────

	/** Validate a checkout against git and the naming policy; writes nothing. */
	async resolve(ws: WorkspaceRow, spec: CheckoutSpec): Promise<Target> {
		const root = ws.repo_path;
		if (spec.lane === "main") {
			if (!spec.edit) return { lane: "main", spec: { lane: "main" }, where: "main checkout, read-only" };
			const current = await git(root, ["branch", "--show-current"]).catch(() => "");
			return { lane: "main", spec: { lane: "main", edit: true }, where: `main checkout${current ? ` (on ${current})` : ""}, editing, no commits` };
		}
		const name = spec.branch.trim();
		const base = spec.base?.trim() || null;
		if (name === ws.default_base) throw new HubError("invalid", m.baseBranch(name));
		if (!(await isValidBranchName(root, name))) throw new HubError("invalid", m.invalidBranch(name));
		const row = this.#d.worktrees.live(ws.id, name);
		const tip = await tipOf(root, name);
		if (!row && !tip) {
			if (!parseNewBranch(name)) throw new HubError("invalid", m.notNewBranch(name));
			const fork = await freshestBase(root, base ?? ws.default_base).catch(() => null);
			if (!fork) throw new HubError("invalid", m.unknownBase(base ?? ws.default_base));
			const from = base ?? ws.default_base;
			return {
				lane: "branch",
				spec: { lane: "branch", branch: name, ...(base ? { base } : {}) },
				branch: name,
				start: { kind: "new", forkRef: fork.ref, forkSha: fork.sha },
				where: `new branch ${name} from ${from}@${fork.sha.slice(0, 7)}${fork.ref !== from ? ` (${fork.ref}, local was behind)` : ""}`,
			};
		}
		if (base && base !== ws.default_base) throw new HubError("invalid", m.baseForExisting(name));
		if (row?.state === "retiring") throw new HubError("conflict", m.branchRetiring(name));
		const latest = row ? this.#refuseOpen(row) : undefined;
		if (!tip) throw new HubError("conflict", m.branchGone(name));
		const s = await survey(root, ws.default_base);
		if ([...s.checkouts.values()].some(c => c.main && c.branch === name)) throw new HubError("conflict", m.branchInMainCheckout(name));
		const into = s.ancestors.get(name) ?? (await this.#contentIn(root, tip, s.targets));
		if (into && tip !== row?.fork_sha && !s.targets.some(t => t.sha === tip)) throw new HubError("conflict", m.branchMerged(name, into));
		return {
			lane: "branch",
			spec: { lane: "branch", branch: name },
			branch: name,
			start: { kind: "existing", tip, row: row?.id ?? null },
			where: row ? `branch ${name} (worktree ${row.id} reused${latest ? ` after ${latest.id}` : ""}; fresh session)` : `existing branch ${name}`,
		};
	}

	/** Inside the dispatch transaction: the branch's live row, new or reused, re-checked against what changed since `resolve`. */
	claim(ws: WorkspaceRow, t: Extract<Target, { lane: "branch" }>): WorktreeRow {
		const row = this.#d.worktrees.live(ws.id, t.branch);
		if (row) {
			if (row.state !== "live") throw new HubError("conflict", m.branchRetiring(t.branch));
			this.#refuseOpen(row);
			return row;
		}
		if (t.start.kind === "existing" && t.start.row) throw new HubError("conflict", m.branchRetiring(t.branch));
		return this.#d.worktrees.insert({
			workspaceId: ws.id,
			branch: t.branch,
			path: worktreePath(ws.repo_path, t.branch, this.#d.settings.get().worktreeRoot),
			forkRef: t.start.kind === "new" ? t.start.forkRef : ws.default_base,
			forkSha: t.start.kind === "new" ? t.start.forkSha : t.start.tip,
		});
	}

	/** A branch takes one task at a time: the latest on it must be closed first. Returns that latest task. */
	#refuseOpen(row: WorktreeRow): TaskRow | undefined {
		const latest = this.#d.ledger.latestOn(row.id);
		if (latest && isOpen(latest.status)) throw new HubError("conflict", m.branchOpen(latest.id, statusText(latest), row.branch));
		return latest;
	}

	/** Provisioning: the worktree exists at the row's path on its branch. Repeating it is harmless. */
	async checkout(id: string): Promise<WorktreeRow> {
		const ws = this.#d.workspaces.must(this.#must(id).workspace_id);
		const root = ws.repo_path;
		return serial(root, async () => {
			const row = this.#must(id);
			if (row.state !== "live") throw new HubError("conflict", m.worktreeRetired(row.id, row.branch));
			const trees = await checkouts(root);
			const own = canonicalPath(row.path);
			const at = fs.existsSync(row.path) ? trees.get(own) : undefined;
			if (at) {
				if (at.branch !== row.branch) throw new HubError("conflict", m.worktreeSwitched(row.path, at.branch, row.branch));
			} else {
				const elsewhere = [...trees].find(([dir, c]) => c.branch === row.branch && dir !== own && fs.existsSync(dir));
				if (elsewhere?.[1].main) throw new HubError("conflict", m.branchInMainCheckout(row.branch));
				if (elsewhere) this.#d.worktrees.relocate(row.id, elsewhere[0]);
				else {
					await git(root, ["worktree", "prune"]);
					fs.mkdirSync(path.dirname(row.path), { recursive: true });
					// The name and fork point were fixed at dispatch, so a retry after a crash creates no second branch.
					const exists = (await tipOf(root, row.branch)) !== null;
					await git(root, exists ? ["worktree", "add", row.path, row.branch] : ["worktree", "add", "-b", row.branch, row.path, row.fork_sha ?? row.fork_ref]);
				}
			}
			if (row.retire_error) this.#d.worktrees.clearError(id);
			return this.#must(id);
		});
	}

	// ── sweeps ───────────────────────────────────────────────────────────────

	/** Startup: finish retirements a crash cut short, give refused ones another try, then sweep. */
	resume(): void {
		for (const row of this.#d.worktrees.unretired()) {
			if (row.state === "retiring") this.#track(this.#finish(row.id));
			else if (row.retire_error) this.#d.worktrees.clearError(row.id);
		}
		this.kick();
	}

	/** Sweep one workspace, or every workspace with unretired rows; fetches the base first when due. */
	kick(workspaceId?: string): void {
		const ids = workspaceId ? [workspaceId] : [...new Set(this.#d.worktrees.unretired().map(r => r.workspace_id))];
		for (const id of ids) this.#track(this.#fetchIfDue(id).then(() => this.#sweep(id)));
	}

	/** Resolves once every sweep, retirement and fetch started so far has finished (tests, shutdown). */
	async idle(): Promise<void> {
		while (this.#pending.size) await Promise.all([...this.#pending]);
	}

	#track(p: Promise<void>): void {
		const tracked = p.catch(err => this.#d.log(`worktrees: ${errorText(err)}`)).finally(() => this.#pending.delete(tracked));
		this.#pending.add(tracked);
	}

	async #fetchIfDue(workspaceId: string): Promise<void> {
		const ws = this.#d.workspaces.get(workspaceId);
		if (!ws || Date.now() - (this.#fetched.get(ws.id) ?? 0) < FETCH_EVERY_MS) return;
		this.#fetched.set(ws.id, Date.now());
		await serial(ws.repo_path, () => fetchBase(ws.repo_path, ws.default_base)).catch(err => this.#d.log(`${ws.id}: fetching ${ws.default_base} failed: ${errorText(err)}`));
	}

	/** One sweep per workspace at a time; a request during a sweep gets one more sweep after it. */
	#sweep(workspaceId: string): Promise<void> {
		let s = this.#sweeps.get(workspaceId);
		if (!s) {
			s = { running: null, next: null };
			this.#sweeps.set(workspaceId, s);
		}
		const slot = s;
		if (!slot.running) {
			slot.running = this.#sweepNow(workspaceId).finally(() => {
				slot.running = null;
			});
			return slot.running;
		}
		slot.next ??= slot.running.then(() => {
			slot.next = null;
			return this.#sweep(workspaceId);
		});
		return slot.next;
	}

	/** Observe every live row, record merges, and start the retirements `decide` allows. Never waits for them. */
	async #sweepNow(workspaceId: string): Promise<void> {
		const ws = this.#d.workspaces.get(workspaceId);
		if (!ws) return;
		const rows = this.#d.worktrees.unretired(ws.id).filter(r => r.state === "live");
		let s: RepoSurvey | null = null;
		let freshSha: string | null = null;
		if (rows.length) {
			try {
				[s, freshSha] = await Promise.all([survey(ws.repo_path, ws.default_base), freshestBase(ws.repo_path, ws.default_base).then(f => f.sha, () => null)]);
			} catch (err) {
				this.#d.log(`${ws.id}: worktree sweep failed: ${errorText(err)}`);
				return;
			}
		}
		for (const row of rows) {
			try {
				let look = await this.#look(ws, row, s!, freshSha);
				// The timeline records every merge the hub acts on; for a task not yet accepted it is the acceptance.
				const mergedTask = look.plan.do === "settle" ? look.plan.task : look.plan.do === "retire" && look.plan.reason === "merged" ? look.facts.latest?.id : undefined;
				if (mergedTask && look.facts.tip && look.into) {
					const r = this.#d.ledger.apply(mergedTask, { kind: "merged", branch: row.branch, into: look.into, sha: look.facts.tip }, "hub", `merged:${row.id}:${look.facts.tip}`);
					this.#d.applied(mergedTask, r);
					if (look.plan.do === "settle") look = await this.#look(ws, this.#must(row.id), s!, freshSha);
				}
				// Nothing left to retire (new commits, the merge undone): an earlier refusal no longer applies.
				if (look.plan.do === "keep" && row.retire_error) this.#d.worktrees.clearError(row.id);
				this.#remember(row.id, look);
				if (look.plan.do === "retire") this.#track(this.#retire(row.id, look.plan.reason, look.facts.tip));
			} catch (err) {
				this.#d.log(`${ws.id}: looking at ${row.id} ${row.branch} failed: ${errorText(err)}`);
			}
		}
		this.#checked.set(ws.id, Date.now());
	}

	async #look(ws: WorkspaceRow, row: WorktreeRow, s: RepoSurvey, freshSha: string | null): Promise<Look> {
		const root = ws.repo_path;
		const tip = s.tips.get(row.branch)?.sha ?? null;
		const into = tip ? (s.ancestors.get(row.branch) ?? (await this.#contentIn(root, tip, s.targets))) : null;
		const own = canonicalPath(row.path);
		// A registration whose directory is gone (deleted outside git) is not a checkout.
		const at = fs.existsSync(row.path) ? s.checkouts.get(own) : undefined;
		const elsewhere = [...s.checkouts].find(([dir, c]) => c.branch === row.branch && dir !== own && fs.existsSync(dir));
		const latest = this.#d.ledger.latestOn(row.id);
		const session = this.#d.pool.liveForWorktree(row.id);
		const facts: WorktreeFacts = {
			state: row.state,
			branch: row.branch,
			forkSha: row.fork_sha,
			tip,
			integrated: into !== null,
			checkout: { present: !!at, branch: at?.branch ?? null, locked: at?.locked ?? false },
			elsewhere: !!elsewhere,
			dirty: false,
			latest: latest ? latestOf(latest) : null,
			sessionBusy: !!session && this.#busy(session.id),
		};
		let plan = decide(facts);
		let dirtyFiles: number | null = null;
		if (plan.do === "retire" && at) {
			dirtyFiles = await changedFiles(row.path);
			facts.dirty = dirtyFiles > 0;
			plan = decide(facts);
		}
		// A refused retirement waits for the human (Remove) or the next hub start instead of retrying every sweep.
		if (plan.do === "retire" && row.retire_error) plan = { do: "hold", why: "error" };
		let counts: { ahead: number; behind: number } | null = null;
		if (tip && freshSha) {
			const key = `${freshSha}:${tip}`;
			counts = this.#counts.get(key) ?? null;
			if (!counts) {
				counts = await aheadBehind(root, freshSha, tip);
				if (this.#counts.size >= MEMO_MAX) this.#counts.clear();
				this.#counts.set(key, counts);
			}
		}
		return {
			facts,
			plan,
			into,
			ahead: counts?.ahead ?? null,
			behind: counts?.behind ?? null,
			upstreamGone: s.tips.get(row.branch)?.upstreamGone ?? false,
			dirtyFiles,
			elsewhereAt: elsewhere?.[0] ?? null,
		};
	}

	/** The first target whose content already has `tip`'s changes (squash, rebase-merge, the same edit by hand). */
	async #contentIn(root: string, tip: string, targets: RepoSurvey["targets"]): Promise<string | null> {
		for (const t of targets) {
			const key = `${tip}:${t.sha}`;
			let found = this.#content.get(key);
			if (found === undefined) {
				found = (await integratedByContent(root, tip, t.sha)) !== null;
				if (this.#content.size >= MEMO_MAX) this.#content.clear();
				this.#content.set(key, found);
			}
			if (found) return t.ref;
		}
		return null;
	}

	#busy(sessionId: string): boolean {
		const state = this.#d.pool.state(sessionId);
		return state === "running" || state === "approval";
	}

	/** Keep the look for views; tell the UI only when what it shows changed. */
	#remember(id: string, look: Look): void {
		this.#looks.set(id, look);
		const sig = JSON.stringify([phase(look.facts, look.plan), look.plan, look.ahead, look.behind, look.upstreamGone, look.facts.checkout, look.dirtyFiles]);
		if (this.#lookSigs.get(id) === sig) return;
		this.#lookSigs.set(id, sig);
		this.#changed(id);
	}

	#changed(id: string): void {
		this.#d.changed("workspaces", ...this.#d.ledger.tasksForWorktree(id).map(t => `task:${t.id}` as const));
	}

	// ── retirement ───────────────────────────────────────────────────────────

	/**
	 * Step 0 in one transaction: re-check what the look saw, mark the row retiring and its session
	 * retired, so no start, prompt or reopen can slip in. Then stop the process and finish.
	 */
	async #retire(id: string, reason: RetireReason, sha: string | null): Promise<void> {
		const session = this.#d.db.tx(() => {
			if (this.#d.worktrees.get(id)?.state !== "live") return undefined;
			const live = this.#d.pool.liveForWorktree(id);
			if (live && this.#busy(live.id)) return undefined;
			const latest = this.#d.ledger.latestOn(id);
			if (latest && (reason === "discarded" ? inFlight(latestOf(latest)) : latest.settled !== 1)) return undefined;
			if (!this.#d.worktrees.beginRetire(id, reason, sha)) return undefined;
			if (live) this.#d.pool.markRetired(live.id);
			return live ?? null;
		});
		// Something moved since the look (a reopen, a new task): the next sweep decides again.
		if (session === undefined) return;
		this.#changed(id);
		if (session) await this.#d.pool.retire(session.id);
		await this.#finish(id);
	}

	/** Steps 2–5: environment, worktree, branch (compare-and-swap on the recorded sha), record. Each looks before it acts. */
	async #finish(id: string): Promise<void> {
		const row = this.#d.worktrees.get(id);
		if (row?.state !== "retiring") return;
		const ws = this.#d.workspaces.must(row.workspace_id);
		try {
			await this.#d.env.teardown(id);
		} catch (err) {
			this.#d.worktrees.failRetire(id, errorText(err));
			this.#changed(id);
			return;
		}
		const outcome = await serial(ws.repo_path, () => this.#removeFromGit(ws.repo_path, row));
		if ("refused" in outcome) {
			this.#d.worktrees.abortRetire(id, render(outcome.refused));
			this.#changed(id);
			return;
		}
		const latest = this.#d.ledger.latestOn(id);
		const r = this.#d.db.tx(() => {
			this.#d.worktrees.finishRetire(id);
			const event = { kind: "worktree_retired", reason: row.retire_reason!, branch: row.branch, sha: row.retired_sha, branchDeleted: outcome.branchDeleted } as const;
			return latest ? this.#d.ledger.apply(latest.id, event, "hub", `retired:${id}`) : null;
		});
		this.#looks.delete(id);
		if (latest && r) this.#d.applied(latest.id, r);
		this.#changed(id);
		this.#d.log(`${ws.id}: retired ${row.id} ${row.branch} (${row.retire_reason}${row.retired_sha ? ` at ${row.retired_sha.slice(0, 8)}` : ""})`);
	}

	async #removeFromGit(root: string, row: WorktreeRow): Promise<{ refused: string | Message } | { branchDeleted: boolean }> {
		const force = row.retire_reason === "discarded";
		const trees = await checkouts(root);
		const own = canonicalPath(row.path);
		const at = fs.existsSync(row.path) ? trees.get(own) : undefined;
		// update-ref would happily delete a branch some other checkout (the main one included) is on.
		const other = [...trees].find(([dir, c]) => c.branch === row.branch && dir !== own && fs.existsSync(dir));
		if (other && row.retire_reason !== "gone") return { refused: m.checkedOutIn(other[0]) };
		if (at) {
			if (!force && at.branch !== row.branch) return { refused: m.checkedOutOn(at.branch) };
			try {
				// Without --force git refuses tracked or untracked changes and locked worktrees; ignored files go.
				await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), row.path]);
			} catch (err) {
				return { refused: errorText(err) };
			}
		} else await git(root, ["worktree", "prune"]);
		if (row.retire_reason === "gone" || !row.retired_sha) return { branchDeleted: false };
		const tip = await tipOf(root, row.branch);
		if (tip !== null && tip !== row.retired_sha) return { refused: m.branchMoved(row.branch) };
		if (tip !== null) {
			try {
				await git(root, ["update-ref", "-d", `refs/heads/${row.branch}`, row.retired_sha]);
			} catch (err) {
				return { refused: errorText(err) };
			}
		}
		await git(root, ["config", "--remove-section", `branch.${row.branch}`]).catch(() => undefined);
		return { branchDeleted: true };
	}

	// ── the human ────────────────────────────────────────────────────────────

	/**
	 * Remove the worktree (forced; the branch stays and the row becomes parked) or, with
	 * `deleteBranch`, discard the branch too. A retirement that stopped on an error is retried.
	 */
	async remove(id: string, deleteBranch: boolean, language: Language = "en"): Promise<BranchDTO> {
		const row = this.#must(id);
		const ws = this.#d.workspaces.must(row.workspace_id);
		if (row.state === "retiring") await this.#finish(id);
		else if (row.state === "live") {
			this.#d.worktrees.clearError(id);
			const latest = this.#d.ledger.latestOn(id);
			if (latest && inFlight(latestOf(latest))) throw new HubError("conflict", m.busy(latest.id, statusText(latest)));
			const session = this.#d.pool.liveForWorktree(id);
			if (session && this.#busy(session.id)) throw new HubError("conflict", m.sessionBusy(session.id));
			const at = (await checkouts(ws.repo_path)).get(canonicalPath(row.path));
			if (at?.locked) throw new HubError("conflict", m.unlockFirst(row.branch));
			if (deleteBranch) {
				await this.#retire(id, "discarded", await tipOf(ws.repo_path, row.branch));
				const after = this.#must(id);
				if (after.state === "live" && after.retire_error) throw new HubError("conflict", after.retire_error);
			} else if (at) {
				if (session) await this.#d.pool.retire(session.id);
				await this.#d.env.teardown(id).catch(err => {
					throw new HubError("conflict", err instanceof HubError ? err.localizedText : errorText(err));
				});
				await serial(ws.repo_path, async () => {
					if ((await checkouts(ws.repo_path)).has(canonicalPath(row.path))) await git(ws.repo_path, ["worktree", "remove", "--force", row.path]);
					await git(ws.repo_path, ["worktree", "prune"]);
				});
			}
		}
		await this.#sweep(ws.id);
		this.#changed(id);
		return this.#dto(ws, this.#must(id), language);
	}

	/** Keep = `git worktree lock`: a git-native pin the sweep never removes. */
	async keep(id: string, keep: boolean, language: Language = "en"): Promise<BranchDTO> {
		const row = this.#must(id);
		if (row.state !== "live") throw new HubError("conflict", m.worktreeRetired(row.id, row.branch));
		const ws = this.#d.workspaces.must(row.workspace_id);
		await serial(ws.repo_path, async () => {
			const at = (await checkouts(ws.repo_path)).get(canonicalPath(row.path));
			if (!at) throw new HubError("conflict", m.notPresent(row.branch));
			if (at.locked === keep) return;
			await git(ws.repo_path, keep ? ["worktree", "lock", "--reason", KEEP_REASON, row.path] : ["worktree", "unlock", row.path]);
		});
		await this.#sweep(ws.id);
		return this.#dto(ws, this.#must(id), language);
	}

	// ── views ────────────────────────────────────────────────────────────────

	/**
	 * A workspace's branches, observed at most `maxAgeMs` ago (default: now). Observing is a sweep,
	 * so a merge noticed here is settled and retired in the background.
	 */
	async branches(workspaceId: string, language: Language = "en", maxAgeMs = 0): Promise<BranchesDTO> {
		const ws = this.#d.workspaces.must(workspaceId);
		await this.#sweepIfStale(ws.id, maxAgeMs);
		const live = this.#d.worktrees
			.unretired(ws.id)
			.map(r => this.#dto(ws, r, language))
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
		return { workspace: ws.id, base: ws.default_base, live, retired: this.#d.worktrees.retired(ws.id, 20).map(r => this.#dto(ws, r, language)), checkedAt: this.#checked.get(ws.id) ?? null };
	}

	/** One branch for a task view; reuses a recent observation. */
	async branch(id: string, language: Language = "en"): Promise<BranchDTO> {
		const row = this.#must(id);
		const ws = this.#d.workspaces.must(row.workspace_id);
		if (row.state === "live") await this.#sweepIfStale(ws.id, LOOK_FRESH_MS);
		return this.#dto(ws, this.#must(id), language);
	}

	/** Git changes are seen by sweeping; a task change on any branch since the last look makes it stale at once. */
	async #sweepIfStale(workspaceId: string, maxAgeMs: number): Promise<void> {
		const checked = this.#checked.get(workspaceId) ?? 0;
		const taskMoved = this.#d.worktrees.unretired(workspaceId).some(r => (this.#d.ledger.latestOn(r.id)?.updated_at ?? 0) >= checked);
		if (taskMoved || Date.now() - checked >= maxAgeMs) await this.#sweep(workspaceId);
	}

	#dto(ws: WorkspaceRow, row: WorktreeRow, language: Language): BranchDTO {
		const tasks = this.#d.ledger.tasksForWorktree(row.id).reverse();
		const latest = tasks[0];
		const look = row.state === "live" ? this.#looks.get(row.id) : undefined;
		const shown: BranchPhase = look
			? phase(look.facts, look.plan)
			: row.state !== "live"
				? row.state
				: latest && inFlight(latestOf(latest))
					? "active"
					: fs.existsSync(row.path)
						? "idle"
						: "parked";
		const hold: BranchHold | null = row.state !== "retired" && row.retire_error ? "error" : look?.plan.do === "hold" ? look.plan.why : null;
		const session = this.#d.pool.liveForWorktree(row.id);
		let detail: Message | string | null = null;
		switch (hold) {
			case "error":
				detail = row.retire_error;
				break;
			case "dirty":
				detail = m.dirtyFiles(look?.dirtyFiles ?? 0);
				break;
			case "switched":
				detail = look?.elsewhereAt ? m.checkedOutIn(look.elsewhereAt) : m.checkedOutOn(look?.facts.checkout.branch ?? null);
				break;
			case "unaccepted":
				detail = latest ? m.notAccepted(latest.id, statusText(latest)) : null;
				break;
			case "busy":
				detail = latest && inFlight(latestOf(latest)) ? m.inFlight(latest.id, statusText(latest)) : session ? m.running(session.id) : null;
				break;
		}
		const lastActivityAt = Math.max(row.created_at, latest?.updated_at ?? 0, row.retired_at ?? 0);
		const retiredEvent = row.state === "retired" && latest ? this.#d.ledger.eventsOf(latest.id, "worktree_retired").at(-1)?.event : undefined;
		return {
			worktreeId: row.id,
			workspace: ws.id,
			branch: row.branch,
			path: row.path,
			base: ws.default_base,
			phase: shown,
			hold,
			holdDetail: detail === null ? null : render(detail, language),
			ahead: look?.ahead ?? null,
			behind: look?.behind ?? null,
			upstreamGone: look?.upstreamGone ?? false,
			kept: look?.facts.checkout.locked ?? false,
			stale: shown === "idle" && Date.now() - lastActivityAt > STALE_IDLE_MS,
			tasks: tasks.slice(0, 5).map(t => ({ id: t.id, title: t.title, status: t.status, settled: t.settled === 1 })),
			lastActivityAt,
			retired:
				row.state === "retired" && row.retire_reason && row.retired_at !== null
					? { reason: row.retire_reason, at: row.retired_at, sha: row.retired_sha, branchDeleted: retiredEvent?.branchDeleted ?? false }
					: null,
		};
	}

	#must(id: string): WorktreeRow {
		const row = this.#d.worktrees.get(id);
		if (!row) throw new HubError("not_found", m.noWorktree(id));
		return row;
	}
}
