import type { CheckoutSpec } from "../shared/tools.ts";
import { renderEnvelope, type ProvisionStep } from "./core/task.ts";
import type { Db } from "./db.ts";
import { EnvError, type Env } from "./env.ts";
import { errorText, HubError } from "./errors.ts";
import { GitError } from "./git.ts";
import { envMessages } from "./i18n-env.ts";
import { render, type Message } from "./i18n.ts";
import type { Ledger, TaskRow } from "./ledger.ts";
import type { Pool, SessionRow } from "./pool.ts";
import type { SettingsStore } from "./settings.ts";
import type { WorkspaceRow, Workspaces } from "./workspaces.ts";
import type { WorktreeLifecycle, WorktreeRow } from "./worktrees.ts";

class ProvisionError extends Error {
	readonly step: ProvisionStep;
	readonly localizedText: Message | undefined;

	constructor(step: ProvisionStep, message: string | Message) {
		super(render(message));
		this.step = step;
		this.localizedText = typeof message === "string" ? undefined : message;
	}
}

export interface ProvisionerDeps {
	db: Db;
	ledger: Ledger;
	workspaces: Workspaces;
	lifecycle: WorktreeLifecycle;
	env: Env;
	pool: Pool;
	settings: SettingsStore;
	flush(sessionId: string): void;
	changed(taskId: string): void;
	log(message: string): void;
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
			const messageText = err instanceof ProvisionError || err instanceof EnvError || err instanceof GitError || err instanceof HubError ? err.localizedText : undefined;
			this.#d.ledger.apply(task.id, { kind: "provision_failed", step, message: errorText(err), ...(messageText && typeof messageText !== "string" ? { messageText } : {}) }, "hub");
		} finally {
			this.#busy.delete(task.id);
			this.#d.changed(task.id);
		}
	}

	async #steps(task: TaskRow): Promise<void> {
		const ws = this.#d.workspaces.must(task.workspace_id);
		const checkout = JSON.parse(task.checkout) as CheckoutSpec;
		let worktree: WorktreeRow | null = null;
		if (task.worktree_id) {
			try {
				worktree = await this.#d.lifecycle.checkout(task.worktree_id);
			} catch (err) {
				throw new ProvisionError("checkout", err instanceof GitError || err instanceof HubError ? (err.localizedText ?? err.message) : errorText(err));
			}
			this.#d.ledger.apply(task.id, { kind: "checked_out", worktree: worktree.id, path: worktree.path, branch: worktree.branch }, "hub", `checkout:${task.id}`);
			this.#d.changed(task.id);
			await this.#d.env.ensure(worktree.id);
		} else {
			const recipe = this.#d.workspaces.loadRecipe(ws.id);
			if (recipe.status === "ok") await this.#d.env.ensureServices(ws, recipe.recipe);
		}
		// Cancelled while the checkout or environment was being prepared: stop before a session exists.
		if (this.#d.ledger.mustTask(task.id).status !== "pending") return;
		const session = await this.#session(this.#d.ledger.mustTask(task.id), ws, worktree);
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
				task: {
					id: task.id,
					title: task.title,
					playbook: task.playbook,
					earlier: worktree ? this.#d.ledger.tasksForWorktree(worktree.id).filter(t => t.seq < task.seq).map(t => t.id) : [],
				},
				where: {
					workspace: ws.id,
					path: worktree?.path ?? ws.repo_path,
					branch: worktree?.branch ?? null,
					base: worktree?.fork_ref ?? null,
					lane: worktree ? "branch" : checkout.lane === "main" && checkout.edit ? "main_edit" : "main",
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

	/** Every task gets a fresh session; an older one on the same worktree (its task closed) is retired first. */
	async #session(task: TaskRow, ws: WorkspaceRow, worktree: WorktreeRow | null): Promise<SessionRow> {
		if (task.session_id) return this.#d.pool.must(task.session_id);
		const current = worktree ? this.#d.pool.liveForWorktree(worktree.id) : undefined;
		if (current) {
			const open = this.#d.ledger.openForSession(current.id);
			if (open && open.id !== task.id) throw new ProvisionError("session", envMessages.sessionHasOpenTask(current.id, open.id));
			await this.#d.pool.retire(current.id);
		}
		return this.#d.db.tx(() => {
			const session = this.#d.pool.create({ kind: "worker", workspaceId: ws.id, worktreeId: worktree?.id ?? null, cwd: worktree?.path ?? ws.repo_path });
			this.#d.ledger.apply(task.id, { kind: "provisioned", session: session.id }, "hub", `provisioned:${task.id}`);
			return session;
		});
	}
}
