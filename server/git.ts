import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "./db.ts";

const run = promisify(execFile);

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
		return stdout.trim();
	} catch (err) {
		const e = err as { stderr?: string; message: string };
		throw new GitError(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`);
	}
}

/** Absolute top-level directory of the repository containing `dir`. Throws when `dir` is not in a git repo. */
export async function repoRoot(dir: string): Promise<string> {
	return git(dir, ["rev-parse", "--show-toplevel"]);
}

/** The branch new worktrees fork from: the remote HEAD when known, else the current branch. */
export async function defaultBase(root: string): Promise<string> {
	const remoteHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
	if (remoteHead) return remoteHead.replace(/^origin\//, "");
	return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export interface WorktreeInfo {
	path: string;
	branch: string | null;
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
	const out = await git(root, ["worktree", "list", "--porcelain"]);
	const result: WorktreeInfo[] = [];
	for (const block of out.split("\n\n")) {
		const wt = /^worktree (.+)$/m.exec(block)?.[1];
		if (!wt) continue;
		const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
		result.push({ path: wt, branch });
	}
	return result;
}

/**
 * Ensure a worktree for `branch` exists at `dir`. Idempotent: an existing worktree
 * on the same branch is reused; a branch that already exists is checked out
 * instead of recreated.
 */
export async function ensureWorktree(root: string, dir: string, branch: string, base: string): Promise<void> {
	const target = await fs.realpath(dir).catch(() => path.resolve(dir));
	const existing = (await listWorktrees(root)).find(w => path.resolve(w.path) === target);
	if (existing) {
		if (existing.branch !== branch) throw new GitError(`${dir} is a worktree on ${existing.branch ?? "detached HEAD"}, not ${branch}`);
		return;
	}
	await fs.mkdir(path.dirname(dir), { recursive: true });
	const branchExists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
	await git(root, branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base]);
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
	await git(root, ["worktree", "remove", "--force", dir]);
}

export interface WorktreeStatus {
	dirty: boolean;
	ahead: number;
	head: string;
}

export async function worktreeStatus(dir: string, base: string): Promise<WorktreeStatus> {
	const [porcelain, head, ahead] = await Promise.all([
		git(dir, ["status", "--porcelain"]),
		git(dir, ["rev-parse", "--short", "HEAD"]),
		git(dir, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "0"),
	]);
	return { dirty: porcelain.length > 0, ahead: Number(ahead) || 0, head };
}

/** Absolute hooks directory git would use in `cwd` (respects core.hooksPath); computed before the worker override. */
export async function hooksDir(cwd: string): Promise<string> {
	return path.resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "hooks"]));
}

export async function isValidBranchName(root: string, branch: string): Promise<boolean> {
	return git(root, ["check-ref-format", "--branch", branch]).then(
		() => true,
		() => false,
	);
}

/** `<root ?? dirname(repo)>/<repo basename>.worktrees/<branch with / replaced by ->`. */
export function worktreePath(repo: string, branch: string, worktreeRoot: string | null): string {
	return path.join(worktreeRoot ?? path.dirname(repo), `${path.basename(repo)}.worktrees`, branch.replaceAll("/", "-"));
}

export interface WorktreeRow {
	id: string;
	workspace_id: string;
	path: string;
	branch: string;
	base: string;
	state: "ready" | "missing" | "removed";
	created_at: number;
	removed_at: number | null;
}

/** Sole writer of the `worktree` table (rows mirror `git worktree` state). */
export class Worktrees {
	readonly #db: Db;

	constructor(db: Db) {
		this.#db = db;
	}

	get(id: string): WorktreeRow | undefined {
		return this.#db.get<WorktreeRow>("SELECT * FROM worktree WHERE id = ?", id);
	}

	live(workspaceId: string, branch: string): WorktreeRow | undefined {
		return this.#db.get<WorktreeRow>("SELECT * FROM worktree WHERE workspace_id = ? AND branch = ? AND state <> 'removed'", workspaceId, branch);
	}

	/** Record a worktree that exists on disk; an existing live row for the branch is reused. */
	record(input: { workspaceId: string; path: string; branch: string; base: string }): WorktreeRow {
		return this.#db.tx(() => {
			const existing = this.live(input.workspaceId, input.branch);
			if (existing) {
				if (existing.state !== "ready") this.#db.run("UPDATE worktree SET state = 'ready' WHERE id = ?", existing.id);
				return this.get(existing.id)!;
			}
			const { id } = this.#db.nextId("WT");
			this.#db.run(
				"INSERT INTO worktree (id, workspace_id, path, branch, base, state, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?)",
				id,
				input.workspaceId,
				input.path,
				input.branch,
				input.base,
				Date.now(),
			);
			return this.get(id)!;
		});
	}

	markRemoved(id: string): void {
		this.#db.run("UPDATE worktree SET state = 'removed', removed_at = coalesce(removed_at, ?) WHERE id = ?", Date.now(), id);
	}

	/** Startup: rows whose directory vanished become `missing`; reappeared ones `ready`. */
	reconcile(): void {
		for (const wt of this.#db.all<WorktreeRow>("SELECT * FROM worktree WHERE state <> 'removed'")) {
			const present = fsSync.existsSync(wt.path);
			if (present !== (wt.state === "ready")) this.#db.run("UPDATE worktree SET state = ? WHERE id = ?", present ? "ready" : "missing", wt.id);
		}
	}
}
