import { execFile } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoInspection } from "../shared/api.ts";
import { render, type Message } from "./i18n.ts";

const run = promisify(execFile);

export class GitError extends Error {
	readonly localizedText: Message | undefined;

	constructor(message: string | Message) {
		super(render(message));
		this.localizedText = typeof message === "string" ? undefined : message;
	}
}

export interface GitOptions {
	timeout?: number;
	env?: Record<string, string>;
}

const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };

/** Run git and return trimmed stdout; a non-zero exit throws GitError with git's stderr. The one git runner. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
	try {
		const { stdout } = await run("git", args, { cwd, timeout: opts.timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...GIT_ENV, ...opts.env } });
		return stdout.trim();
	} catch (err) {
		const e = err as { stderr?: string; message: string };
		throw new GitError(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`);
	}
}

/** Like `git`, but an exit code git uses for an answer (not a failure) is returned instead of thrown. */
async function gitStatus(cwd: string, args: string[], answers: readonly number[]): Promise<{ code: number; stdout: string }> {
	try {
		const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } });
		return { code: 0, stdout: stdout.trim() };
	} catch (err) {
		const e = err as { code?: unknown; stdout?: string; stderr?: string; message: string };
		if (typeof e.code === "number" && answers.includes(e.code)) return { code: e.code, stdout: (e.stdout ?? "").trim() };
		throw new GitError(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`);
	}
}

/** Absolute top-level directory of the repository containing `dir`. Throws when `dir` is not in a git repo. */
export async function repoRoot(dir: string): Promise<string> {
	return git(dir, ["rev-parse", "--show-toplevel"], { timeout: 5_000 });
}

/** The branch new worktrees fork from: the remote HEAD when known, else the current branch. */
export async function defaultBase(root: string): Promise<string> {
	const remoteHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
	if (remoteHead) return remoteHead.replace(/^origin\//, "");
	return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

type RepoGitInfo = Pick<RepoInspection, "root" | "currentBranch" | "defaultBase" | "branches" | "worktrees" | "remoteUrl" | "dirty">;

export async function inspectGit(dir: string): Promise<RepoGitInfo> {
	const root = await repoRoot(dir).then(p => fsSync.realpathSync(p), () => null);
	const empty: RepoGitInfo = { root, currentBranch: null, defaultBase: null, branches: [], worktrees: [], remoteUrl: null, dirty: false };
	if (!root) return empty;
	const query = (args: string[]) => git(root, args, { timeout: 5_000 }).catch(() => "");
	const [current, remoteHead, refs, worktrees, remote, status] = await Promise.all([
		query(["symbolic-ref", "--quiet", "--short", "HEAD"]),
		query(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
		query(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(committerdate:unix)%09%(symref)", "refs/heads", "refs/remotes"]),
		query(["worktree", "list", "--porcelain", "-z"]),
		query(["remote", "get-url", "origin"]),
		query(["status", "--porcelain"]),
	]);
	const branches: RepoInspection["branches"] = [];
	for (const line of refs.split("\n")) {
		const [ref, timestamp, symref] = line.split("\t");
		if (!ref || symref) continue;
		const isRemote = ref.startsWith("refs/remotes/");
		const name = ref.replace(/^refs\/(?:heads|remotes)\//, "");
		branches.push({ name, remote: isRemote, current: !isRemote && name === current, lastCommitAt: Number(timestamp) ? Number(timestamp) * 1000 : null });
	}
	const locals = new Set(branches.filter(b => !b.remote).map(b => b.name));
	const ordered = branches.filter(b => !b.remote || !locals.has(b.name.slice(b.name.indexOf("/") + 1)))
		.sort((a, b) => Number(a.remote) - Number(b.remote) || Number(b.current) - Number(a.current) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
	const trees: RepoInspection["worktrees"] = [];
	for (const block of worktrees.split("\0\0").slice(1)) {
		const fields = block.split("\0");
		const treePath = fields.find(f => f.startsWith("worktree "))?.slice(9);
		if (!treePath) continue;
		trees.push({ path: treePath, branch: fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18) ?? null, head: fields.find(f => f.startsWith("HEAD "))?.slice(5) ?? "" });
	}
	return {
		root,
		currentBranch: current || null,
		defaultBase: remoteHead.replace(/^origin\//, "") || ["main", "master", "trunk", "develop"].find(b => locals.has(b)) || current || null,
		branches: ordered.slice(0, 50),
		worktrees: trees,
		remoteUrl: remote || null,
		dirty: !!status,
	};
}

/** A path as git lists it: symlinks resolved when the path exists. */
export function canonicalPath(p: string): string {
	try {
		return fsSync.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

export interface Checkout {
	branch: string | null;
	locked: boolean;
	/** The repository's main working tree (first in `git worktree list`). */
	main: boolean;
}

/** Every working tree git knows, keyed by canonical path. */
export async function checkouts(root: string): Promise<Map<string, Checkout>> {
	const out = await git(root, ["worktree", "list", "--porcelain", "-z"]);
	const result = new Map<string, Checkout>();
	for (const block of out.split("\0\0")) {
		const fields = block.split("\0");
		const dir = fields.find(f => f.startsWith("worktree "))?.slice(9);
		if (!dir) continue;
		result.set(canonicalPath(dir), {
			branch: fields.find(f => f.startsWith("branch refs/heads/"))?.slice(18) ?? null,
			locked: fields.some(f => f === "locked" || f.startsWith("locked ")),
			main: result.size === 0,
		});
	}
	return result;
}

export interface RepoSurvey {
	/** Local branches: tip and whether the upstream was deleted (`[gone]` after a prune). */
	tips: Map<string, { sha: string; upstreamGone: boolean }>;
	checkouts: Map<string, Checkout>;
	/** Integration targets that exist: the base branch and its upstream. */
	targets: { ref: string; sha: string }[];
	/** Local branches whose tip is an ancestor of a target, with the first such target's ref. */
	ancestors: Map<string, string>;
}

/** One look at a repository: three git calls plus one per target, independent of the number of branches. */
export async function survey(root: string, base: string): Promise<RepoSurvey> {
	const [refs, trees] = await Promise.all([
		git(root, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream)%09%(upstream:track)", "refs/heads", "refs/remotes"]),
		checkouts(root),
	]);
	const tips = new Map<string, { sha: string; upstreamGone: boolean }>();
	const remotes = new Map<string, string>();
	let upstream: string | null = null;
	for (const line of refs.split("\n")) {
		const [ref, sha, up, track] = line.split("\t");
		if (!ref || !sha) continue;
		if (ref.startsWith("refs/heads/")) {
			const name = ref.slice(11);
			tips.set(name, { sha, upstreamGone: track === "[gone]" });
			if (name === base && up) upstream = up;
		} else remotes.set(ref, sha);
	}
	const targets: { ref: string; sha: string }[] = [];
	const local = tips.get(base);
	if (local) targets.push({ ref: base, sha: local.sha });
	const remote = upstream ?? (local ? null : `refs/remotes/origin/${base}`);
	const remoteSha = remote ? remotes.get(remote) : undefined;
	if (remote && remoteSha && remoteSha !== local?.sha) targets.push({ ref: remote.replace(/^refs\/remotes\//, ""), sha: remoteSha });
	const ancestors = new Map<string, string>();
	for (const t of targets) {
		const merged = await git(root, ["for-each-ref", `--merged=${t.sha}`, "--format=%(refname)", "refs/heads"]);
		for (const ref of merged.split("\n")) if (ref && !ancestors.has(ref.slice(11))) ancestors.set(ref.slice(11), t.ref);
	}
	return { tips, checkouts: trees, targets, ancestors };
}

/** Fixed identity and dates make the synthetic squash commit the same object on every probe. */
const PROBE_COMMIT_ENV = {
	GIT_AUTHOR_NAME: "omp-home",
	GIT_AUTHOR_EMAIL: "omp-home@localhost",
	GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
	GIT_COMMITTER_NAME: "omp-home",
	GIT_COMMITTER_EMAIL: "omp-home@localhost",
	GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

/** Which content check found `tip` in the target: merging changes nothing, or matching patch ids per commit or squashed. */
export type ContentMatch = "tree" | "commits" | "squash" | null;

/**
 * Whether `tip`'s content is already in `target` when ancestry says no (squash, rebase-merge,
 * the same change made by hand). Merging must change nothing; only when that merge conflicts
 * (the base edited the same lines later) fall back to patch ids, per commit and squashed.
 */
export async function integratedByContent(root: string, tip: string, target: string): Promise<ContentMatch> {
	const merged = await gitStatus(root, ["merge-tree", "--write-tree", "--no-messages", target, tip], [1]);
	if (merged.code === 0) return merged.stdout.split("\n")[0] === (await git(root, ["rev-parse", `${target}^{tree}`])) ? "tree" : null;
	const perCommit = await git(root, ["cherry", target, tip]);
	if (perCommit && perCommit.split("\n").every(line => line.startsWith("-"))) return "commits";
	const forkPoint = await gitStatus(root, ["merge-base", target, tip], [1]);
	if (forkPoint.code !== 0) return null;
	const squashed = await git(root, ["commit-tree", `${tip}^{tree}`, "-p", forkPoint.stdout, "-m", "omp-home squash probe"], { env: PROBE_COMMIT_ENV });
	return (await git(root, ["cherry", target, squashed])).startsWith("-") ? "squash" : null;
}

/** How many files have tracked changes or are untracked (ignored files do not count: git removes worktrees with them). */
export async function changedFiles(dir: string): Promise<number> {
	return (await git(dir, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
}

export async function aheadBehind(root: string, base: string, tip: string): Promise<{ ahead: number; behind: number }> {
	const [behind, ahead] = (await git(root, ["rev-list", "--left-right", "--count", `${base}...${tip}`])).split(/\s+/).map(Number);
	return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** Where new work should fork: the base branch, or its upstream when the local branch is strictly behind it. Any other ref resolves as given. */
export async function freshestBase(root: string, base: string): Promise<{ ref: string; sha: string }> {
	const local = await gitStatus(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`], [1]);
	if (local.code !== 0) return { ref: base, sha: await git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) };
	const upstream = await gitStatus(root, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", `${base}@{upstream}`], [1, 128]);
	if (upstream.code !== 0 || !upstream.stdout) return { ref: base, sha: local.stdout };
	const upSha = await git(root, ["rev-parse", "--verify", `${upstream.stdout}^{commit}`]);
	if (upSha === local.stdout) return { ref: base, sha: local.stdout };
	const behind = await gitStatus(root, ["merge-base", "--is-ancestor", local.stdout, upSha], [1]);
	return behind.code === 0 ? { ref: upstream.stdout.replace(/^refs\/remotes\//, ""), sha: upSha } : { ref: base, sha: local.stdout };
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
