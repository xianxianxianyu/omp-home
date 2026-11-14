import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Language, RecipeCheckDTO, WorkspaceDTO } from "../shared/api.ts";
import type { HomePaths } from "./config.ts";
import type { EnvRecipe } from "./core/recipe.ts";
import type { Db } from "./db.ts";
import { Env, EnvError, environmentStep, processStartedAt, runShell, type EnvExecution, type EnvTarget, type ExecutionStep } from "./env.ts";
import { errorText, HubError } from "./errors.ts";
import { worktreePath } from "./git.ts";
import { envMessages } from "./i18n-env.ts";
import { recipeCheckMessages as m } from "./i18n-recipe-check.ts";
import { render } from "./i18n.ts";
import type { SettingsStore } from "./settings.ts";
import type { Workspaces, WorkspaceRow } from "./workspaces.ts";
import { addScratchWorktree, removeScratchWorktree } from "./worktrees.ts";


interface CheckRow {
	workspace_id: string;
	id: string;
	recipe_hash: string;
	recipe: string;
	base: string;
	sha: string;
	path: string;
	state: RecipeCheckDTO["state"];
	started_at: number;
	ended_at: number | null;
	steps: string;
	processes: string;
	cleaned: number;
}

interface CheckRun {
	row: CheckRow;
	steps: ExecutionStep[];
	processes: Record<string, string>;
}

/** Sole writer of recipe_check. A persisted intent precedes every disposable checkout. */
export class RecipeChecks {
	readonly #db: Db;
	readonly #paths: HomePaths;
	readonly #settings: SettingsStore;
	readonly #workspaces: Workspaces;
	readonly #env: Env;
	readonly #changed: () => void;
	readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();

	constructor(db: Db, paths: HomePaths, settings: SettingsStore, workspaces: Workspaces, env: Env, changed: () => void) {
		this.#db = db;
		this.#paths = paths;
		this.#settings = settings;
		this.#workspaces = workspaces;
		this.#env = env;
		this.#changed = changed;
	}

	get(workspaceId: string, language: Language = "en"): RecipeCheckDTO | null {
		this.#workspaces.must(workspaceId);
		const row = this.#db.get<CheckRow>("SELECT * FROM recipe_check WHERE workspace_id = ?", workspaceId);
		if (!row) return null;
		const loaded = this.#workspaces.loadRecipe(workspaceId);
		const steps = JSON.parse(row.steps) as ExecutionStep[];
		return {
			workspace: workspaceId, recipeHash: row.recipe_hash,
			current: loaded.status === "ok" && loaded.hash === row.recipe_hash,
			base: row.base, sha: row.sha, state: row.state, startedAt: row.started_at, endedAt: row.ended_at,
			steps: steps.map(({ outputText, ...step }) => ({ ...step, outputTail: outputText ? render(outputText, language) : step.outputTail })),
		};
	}

	summary(workspaceId: string): WorkspaceDTO["recipeCheck"] {
		const check = this.get(workspaceId);
		return check ? { state: check.state, current: check.current, endedAt: check.endedAt } : null;
	}

	describe(workspaceId: string): string {
		const check = this.get(workspaceId);
		if (!check) return "recipe check never";
		const state = check.current ? check.state : `outdated (last ${check.state})`;
		const failures = check.steps.filter(step => step.state === "failed").map(step => {
			const first = step.outputTail.split(/\r?\n/).find(line => line.trim()) ?? `exit ${step.exitCode ?? "unknown"}`;
			return `${step.kind}/${step.name}: ${first.replace(/\s+/g, " ").slice(0, 240)}`;
		});
		return `recipe check ${state}${failures.length ? ` — ${failures.join("; ")}` : ""}`;
	}

	start(workspaceId: string, test?: string, language: Language = "en"): RecipeCheckDTO {
		const ws = this.#workspaces.must(workspaceId);
		const previous = this.#db.get<CheckRow>("SELECT * FROM recipe_check WHERE workspace_id = ?", workspaceId);
		if (this.#running.has(workspaceId) || previous?.state === "running") throw new HubError("conflict", m.alreadyRunning(workspaceId));
		if (previous && !previous.cleaned) throw new HubError("conflict", m.cleanupPending());
		const loaded = this.#workspaces.loadRecipe(workspaceId);
		if (loaded.status !== "ok") throw new HubError("unprocessable", m.invalidRecipe(workspaceId));
		if (test !== undefined && !Object.hasOwn(loaded.recipe.test, test)) throw new HubError("unprocessable", m.unknownTest(test));
		const token = randomUUID();
		const id = `CHECK-${workspaceId}-${token}`;
		const tests = test !== undefined ? [test] : loaded.recipe.test.full ? ["full"] : Object.keys(loaded.recipe.test);
		const step = (kind: ExecutionStep["kind"], name: string, command: string | null = null): ExecutionStep => ({ kind, name, command, state: "pending", exitCode: null, ms: null, outputTail: "" });
		const recipe = loaded.recipe;
		const steps = [
			step("checkout", "worktree"),
			...Object.entries(recipe.services).map(([name, spec]) => step("services", name, spec.check)),
			step("services", "(ports)"),
			...(recipe.database ? [step("database", "prepare")] : []),
			...recipe.copy.map(rel => step("copy", rel)),
			...recipe.setup.map((command, index) => step("setup", String(index + 1), command)),
			...tests.map(name => step("test", name, recipe.test[name]!)),
			...recipe.teardown.map((command, index) => step("teardown", String(index + 1), command)),
			...(recipe.database ? [step("teardown", "database")] : []),
			step("teardown", "worktree"),
		];
		const row: CheckRow = {
			workspace_id: workspaceId, id, recipe_hash: loaded.hash, recipe: JSON.stringify(recipe), base: ws.default_base, sha: "",
			path: worktreePath(ws.repo_path, `.recipe-check-${token}`, this.#settings.get().worktreeRoot),
			state: "running", started_at: Date.now(), ended_at: null, steps: JSON.stringify(steps), processes: "{}", cleaned: 0,
		};
		this.#db.run(`INSERT INTO recipe_check (workspace_id, id, recipe_hash, recipe, base, sha, path, state, started_at, ended_at, steps, cleaned)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(workspace_id) DO UPDATE SET id=excluded.id, recipe_hash=excluded.recipe_hash, recipe=excluded.recipe, base=excluded.base,
			sha=excluded.sha, path=excluded.path, state=excluded.state, started_at=excluded.started_at, ended_at=excluded.ended_at, steps=excluded.steps, processes='{}', cleaned=0`,
			workspaceId, id, row.recipe_hash, row.recipe, row.base, row.sha, row.path, row.state, row.started_at, row.ended_at, row.steps, row.cleaned);
		const controller = new AbortController();
		const done = Promise.resolve().then(() => this.#run({ row, steps, processes: {} }, ws, recipe, tests, controller.signal)).finally(() => this.#running.delete(workspaceId));
		this.#running.set(workspaceId, { controller, done });
		this.#changed();
		return this.get(workspaceId, language)!;
	}

	async cancel(workspaceId: string, language: Language = "en"): Promise<RecipeCheckDTO | null> {
		this.#workspaces.must(workspaceId);
		const active = this.#running.get(workspaceId);
		active?.controller.abort(new EnvError(envMessages.shellCancelled()));
		await active?.done;
		return this.get(workspaceId, language);
	}

	async stop(): Promise<void> {
		for (const active of this.#running.values()) active.controller.abort(new EnvError(envMessages.shellCancelled()));
		await Promise.all([...this.#running.values()].map(active => active.done));
	}

	#save(run: CheckRun): void {
		const row = run.row;
		row.steps = JSON.stringify(run.steps);
		row.processes = JSON.stringify(run.processes);
		this.#db.run("UPDATE recipe_check SET sha=?, state=?, ended_at=?, steps=?, processes=?, cleaned=? WHERE workspace_id=? AND id=?", row.sha, row.state, row.ended_at, row.steps, row.processes, row.cleaned, row.workspace_id, row.id);
		this.#changed();
	}

	#execution(run: CheckRun, signal?: AbortSignal): EnvExecution {
		return {
			signal, setupTimeoutMs: 20 * 60_000,
			log: path.join(this.#paths.run, "recipe-checks", `${run.row.id}.log`),
			process: (pid, startedAt) => {
				if (startedAt === null) delete run.processes[String(pid)];
				else run.processes[String(pid)] = startedAt;
				this.#save(run);
			},
			step: step => {
				const index = run.steps.findIndex(current => current.kind === step.kind && current.name === step.name);
				if (index === -1) run.steps.push(step);
				else run.steps[index] = step;
				this.#save(run);
			},
		};
	}

	async #run(run: CheckRun, ws: WorkspaceRow, recipe: EnvRecipe, tests: string[], signal: AbortSignal): Promise<void> {
		const execution = this.#execution(run, signal);
		const target: EnvTarget = { id: run.row.id, path: run.row.path, branch: run.row.id };
		let failed = false;
		try {
			await environmentStep(execution, "checkout", "worktree", null, async output => {
				fs.mkdirSync(path.dirname(execution.log!), { recursive: true });
				run.row.sha = await addScratchWorktree(ws.repo_path, target.path, run.row.base).catch(err => {
					throw new EnvError(errorText(err));
				});
				output(`HEAD ${run.row.sha}`);
			});
			const exported = await this.#env.prepare(ws, target, recipe, execution);
			const commands = this.#env.testCommands(ws, target, recipe);
			for (const name of tests) {
				signal.throwIfAborted();
				const command = commands[name]!;
				try {
					await environmentStep(execution, "test", name, command, async output => {
						const result = await runShell(command, { cwd: target.path, env: { ...process.env, ...exported }, timeoutMs: 30 * 60_000, log: execution.log!, signal, onOutput: output, onProcess: execution.process });
						output(result.outputText ?? result.output);
						if (result.code !== 0) throw new EnvError(m.commandFailed(result.code), result.code);
					});
				} catch {
					failed = true;
				}
			}
		} catch {
			failed = true;
		} finally {
			if (!(await this.#cleanup(run, ws, recipe))) failed = true;
			run.row.state = signal.aborted ? "cancelled" : failed ? "failed" : "passed";
			run.row.ended_at = Date.now();
			for (const step of run.steps) if (step.state === "pending") step.state = "skipped";
			this.#save(run);
		}
	}

	async #cleanup(run: CheckRun, ws: WorkspaceRow, recipe: EnvRecipe): Promise<boolean> {
		const execution = this.#execution(run);
		fs.mkdirSync(path.dirname(execution.log!), { recursive: true });
		let ok = true;
		try {
			await environmentStep(execution, "teardown", "environment", null, async () => {
				await stopProcesses(run.processes);
				run.processes = {};
				this.#save(run);
				await this.#env.teardownTarget(ws, { id: run.row.id, path: run.row.path, branch: run.row.id }, recipe, execution);
			});
		} catch {
			ok = false;
		} finally {
			this.#env.releaseTarget(run.row.id);
		}
		try {
			await environmentStep(execution, "teardown", "worktree", null, async () => {
				await stopProcesses(run.processes);
				run.processes = {};
				this.#save(run);
				await removeScratchWorktree(ws.repo_path, run.row.path).catch(err => {
					throw new EnvError(errorText(err));
				});
				run.row.cleaned = 1;
			});
		} catch {
			ok = false;
		}
		return ok;
	}

	async reconcile(): Promise<void> {
		for (const row of this.#db.all<CheckRow>("SELECT * FROM recipe_check WHERE state='running' OR cleaned=0")) {
			const run: CheckRun = { row, steps: JSON.parse(row.steps) as ExecutionStep[], processes: JSON.parse(row.processes) as Record<string, string> };
			for (const step of run.steps) {
				if (step.state === "running") {
					step.state = "failed";
					step.outputText = m.interrupted();
					step.outputTail = step.outputText.en;
				} else if (step.state === "pending") step.state = "skipped";
			}
			await this.#cleanup(run, this.#workspaces.must(row.workspace_id), JSON.parse(row.recipe) as EnvRecipe);
			row.state = "failed";
			row.ended_at = Date.now();
			this.#save(run);
		}
	}
}

/** A reused PID must never let an old check kill an unrelated process group. */
async function stopProcesses(processes: Record<string, string>): Promise<void> {
	const groups = Object.entries(processes).filter(([pid, startedAt]) => processStartedAt(Number(pid)) === startedAt);
	for (const [pid] of groups) {
		try { process.kill(-Number(pid), "SIGTERM"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
	}
	if (groups.length) await sleep(150);
	for (const [pid, startedAt] of groups) {
		const current = processStartedAt(Number(pid));
		if (current !== null && current !== startedAt) continue;
		try { process.kill(-Number(pid), "SIGKILL"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
	}
}
