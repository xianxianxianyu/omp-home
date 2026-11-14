import type { CheckoutSpec } from "../shared/tools.ts";
import { renderEnvelope, type ProvisionStep } from "./core/task.ts";
import type { Db } from "./db.ts";
import { EnvError, type Env } from "./env.ts";
import { errorText } from "./errors.ts";
import { ensureWorktree, isValidBranchName, worktreePath, type WorktreeRow, type Worktrees } from "./git.ts";
import type { Ledger, TaskRow } from "./ledger.ts";
import type { Pool, SessionRow } from "./pool.ts";
import type { SettingsStore } from "./settings.ts";
import type { WorkspaceRow, Workspaces } from "./workspaces.ts";

class ProvisionError extends Error {
	readonly step: ProvisionStep;

	constructor(step: ProvisionStep, message: string) {
		super(message);
		this.step = step;
	}
}

export interface ProvisionerDeps {
	db: Db;
	ledger: Ledger;
	workspaces: Workspaces;
	worktrees: Worktrees;
	env: Env;
	pool: Pool;
	settings: SettingsStore;
	flush(sessionId: string): void;
	changed(taskId: string): void;
	log(message: string): void;
}

/** Default branch: `task/<slug of title>-<seq>`; titles without ASCII words become `task/t<seq>`. */
export function defaultBranch(title: string, seq: number): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug ? `task/${slug}-${seq}` : `task/t${seq}`;
}

/**
 * Reconcile loop for pending tasks: checkout → environment → session → live process →
 * brief in the outbox. Each step reads what already exists first, so a re-run after a
 * crash or a retry continues where the last run stopped.
 */
export class Provisioner {
	readonly #d: ProvisionerDeps;
	readonly #busy = new Set<string>();
	#again = false;
	#running: Promise<void> | null = null;

	constructor(deps: ProvisionerDeps) {
		this.#d = deps;
	}

	kick(): void {
		if (this.#running) {
			this.#again = true;
			return;
		}
		this.#running = this.#loop().finally(() => {
			this.#running = null;
		});
	}

	/** Resolves once every kick so far has been processed (tests and shutdown). */
	async idle(): Promise<void> {
		while (this.#running) await this.#running;
	}

	async #loop(): Promise<void> {
		do {
			this.#again = false;
			const pending = this.#d.ledger.listTasks({ status: "pending" }).filter(t => !this.#busy.has(t.id));
			await Promise.all(pending.map(t => this.#provision(t)));
		} while (this.#again);
	}

	async #provision(task: TaskRow): Promise<void> {
		this.#busy.add(task.id);
		try {
			await this.#steps(task);
		} catch (err) {
			const step = err instanceof ProvisionError ? err.step : err instanceof EnvError ? "env" : "session";
			if (!(err instanceof ProvisionError) && !(err instanceof EnvError)) this.#d.log(`provision ${task.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			this.#d.ledger.apply(task.id, { kind: "provision_failed", step, message: errorText(err) }, "hub");
		} finally {
			this.#busy.delete(task.id);
			this.#d.changed(task.id);
		}
	}

	async #steps(task: TaskRow): Promise<void> {
		const ws = this.#d.workspaces.must(task.workspace_id);
		const checkout = JSON.parse(task.checkout) as CheckoutSpec;
		const continued = checkout.kind === "continue" ? this.#d.ledger.mustTask(checkout.task) : null;

		const worktree = await this.#checkout(task, ws, checkout, continued);
		if (worktree) {
			this.#d.ledger.apply(task.id, { kind: "checked_out", worktree: worktree.id, path: worktree.path, branch: worktree.branch }, "hub", `checkout:${task.id}`);
			this.#d.changed(task.id);
			await this.#d.env.ensure(worktree.id);
		}
		else {
			const recipe = this.#d.workspaces.loadRecipe(ws.id);
			if (recipe.status === "ok") await this.#d.env.ensureServices(ws, recipe.recipe);
		}
		// Cancelled while the checkout or environment was being prepared: stop before a session exists.
		if (this.#d.ledger.mustTask(task.id).status !== "pending") return;
		const session = await this.#session(this.#d.ledger.mustTask(task.id), ws, checkout, worktree, continued);
		if (this.#d.ledger.mustTask(task.id).status !== "pending") return;
		if (this.#d.pool.ensureLive(session.id, { human: false }) === "queued") {
			this.#d.ledger.apply(
				task.id,
				{ kind: "queued_for_capacity", live: this.#d.pool.liveWorkerCount(), cap: this.#d.settings.get().maxLiveWorkers },
				"hub",
				`queued:${task.id}:${session.id}`,
			);
		}
		if (!this.#d.ledger.outboxByKey(`brief:${task.id}`)) {
			const envelope = renderEnvelope({
				task: { id: task.id, title: task.title, playbook: task.playbook, continues: continued?.id ?? null },
				where: {
					workspace: ws.id,
					path: worktree?.path ?? ws.repo_path,
					branch: worktree?.branch ?? null,
					base: worktree?.base ?? null,
					readonly: checkout.kind === "readonly",
					protectedBranches: [ws.default_base],
				},
				env: { vars: this.#d.env.varsOf(worktree?.id ?? null), ...this.#d.env.recipeSummary(ws.id), test: this.#d.env.testCommands(ws, worktree) },
				pstack: this.#d.settings.get().pstackRoot !== null,
			});
			const notes = this.#d.ledger
				.eventsOf(task.id, "provision_retry")
				.map(e => e.event.text)
				.filter(Boolean);
			const text = [envelope, "---", task.brief, ...notes.map(n => `\n---\nFrom the home agent (sent while setup was failing):\n${n}`)].join("\n");
			this.#d.db.tx(() => {
				this.#d.ledger.setEnvelope(task.id, envelope);
				this.#d.ledger.enqueue({ sessionId: session.id, taskId: task.id, kind: "prompt", deliver: "next", text, dedupeKey: `brief:${task.id}` });
			});
		}
		this.#d.flush(session.id);
	}

	async #checkout(task: TaskRow, ws: WorkspaceRow, checkout: CheckoutSpec, continued: TaskRow | null): Promise<WorktreeRow | null> {
		if (checkout.kind === "readonly") return null;
		if (checkout.kind === "continue") {
			if (!continued!.worktree_id) return null;
			const wt = this.#d.worktrees.get(continued!.worktree_id)!;
			if (wt.state !== "ready") throw new ProvisionError("checkout", `${continued!.id}'s worktree ${wt.path} is ${wt.state}`);
			return wt;
		}
		if (task.worktree_id) {
			const wt = this.#d.worktrees.get(task.worktree_id)!;
			if (wt.state !== "ready") throw new ProvisionError("checkout", `worktree ${wt.path} is ${wt.state}`);
			return wt;
		}
		const branch = checkout.branch ?? defaultBranch(task.title, task.seq);
		if (!(await isValidBranchName(ws.repo_path, branch))) throw new ProvisionError("checkout", `"${branch}" is not a valid branch name`);
		const base = checkout.base ?? ws.default_base;
		const existing = this.#d.worktrees.live(ws.id, branch);
		if (existing) {
			const owner = this.#d.ledger.tasksForWorktree(existing.id).find(t => t.id !== task.id);
			if (owner) throw new ProvisionError("checkout", `branch ${branch} already has worktree ${existing.path} (task ${owner.id}); dispatch with checkout {kind:"continue", task:"${owner.id}"} instead`);
		}
		const dir = existing?.path ?? worktreePath(ws.repo_path, branch, this.#d.settings.get().worktreeRoot);
		try {
			await ensureWorktree(ws.repo_path, dir, branch, base);
		} catch (err) {
			throw new ProvisionError("checkout", errorText(err));
		}
		return this.#d.worktrees.record({ workspaceId: ws.id, path: dir, branch, base });
	}

	async #session(task: TaskRow, ws: WorkspaceRow, checkout: CheckoutSpec, worktree: WorktreeRow | null, continued: TaskRow | null): Promise<SessionRow> {
		if (task.session_id) return this.#d.pool.must(task.session_id);
		let reuse: SessionRow | null = null;
		if (checkout.kind === "continue" && checkout.session === "reuse" && continued?.session_id) {
			const s = this.#d.pool.must(continued.session_id);
			if (s.retired_at === null) reuse = s;
		}
		let adopt: SessionRow | null = null;
		if (!reuse && worktree) {
			const current = this.#d.pool.liveForWorktree(worktree.id);
			if (current) {
				const open = this.#d.ledger.openForSession(current.id);
				if (open && open.id !== task.id) throw new ProvisionError("session", `${current.id} in this worktree still has open task ${open.id}; close it first`);
				if (checkout.kind === "continue") await this.#d.pool.retire(current.id);
				else adopt = current;
			}
		}
		return this.#d.db.tx(() => {
			const session = reuse ?? adopt ?? this.#d.pool.create({ kind: "worker", workspaceId: ws.id, worktreeId: worktree?.id ?? null, cwd: worktree?.path ?? ws.repo_path });
			this.#d.ledger.apply(task.id, { kind: "provisioned", session: session.id, reusedSession: !!reuse }, "hub", `provisioned:${task.id}`);
			return session;
		});
	}
}
