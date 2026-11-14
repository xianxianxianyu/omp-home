import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide, parseNewBranch, phase, type LatestTask, type Plan, type WorktreeFacts } from "../server/core/worktree.ts";
import { canonicalPath, changedFiles, freshestBase, integratedByContent, survey, type ContentMatch, type RepoSurvey } from "../server/git.ts";

test("new branch names are <type>/<kebab-slug>", () => {
	for (const ok of ["feat/sleep-share-button", "fix/cart", "docs/readme-pnpm", "chore/a1-b2"]) assert.equal(parseNewBranch(ok), ok);
	for (const bad of ["fix/Cart", "task/t1", "feat/", "feat/a--b", "feat/-a", "feat/a/b", "feature/x", `feat/${"a".repeat(60)}`, "main"]) assert.equal(parseNewBranch(bad), null, bad);
});

const settledTask: LatestTask = { id: "T-1", status: "done", waitKind: null, runOpen: false, settled: true };
const base: WorktreeFacts = {
	state: "live",
	branch: "feat/x",
	forkSha: "f0",
	tip: "a1",
	integrated: true,
	checkout: { present: true, branch: "feat/x", locked: false },
	elsewhere: false,
	dirty: false,
	latest: settledTask,
	sessionBusy: false,
};

test("decide: retire only what git shows is safe, settle a merged task, hold otherwise", () => {
	const cases: [string, Partial<WorktreeFacts>, Plan, string][] = [
		["merged, settled, clean", {}, { do: "retire", reason: "merged" }, "merged"],
		["not integrated", { integrated: false }, { do: "keep" }, "idle"],
		["not integrated, no worktree", { integrated: false, checkout: { present: false, branch: null, locked: false } }, { do: "keep" }, "parked"],
		["no commits since claim", { tip: "f0" }, { do: "retire", reason: "unused" }, "idle"],
		["branch deleted", { tip: null, integrated: false, checkout: { present: false, branch: null, locked: false } }, { do: "retire", reason: "gone" }, "parked"],
		["merged, task reported but not accepted", { latest: { ...settledTask, settled: false } }, { do: "settle", task: "T-1" }, "merged"],
		["unused, task not accepted", { tip: "f0", latest: { ...settledTask, settled: false } }, { do: "hold", why: "unaccepted" }, "idle"],
		["merged while the task works", { latest: { ...settledTask, status: "working", settled: false } }, { do: "hold", why: "busy" }, "active"],
		["merged, setup failed", { latest: { ...settledTask, status: "awaiting", waitKind: "provision_failed", settled: false } }, { do: "hold", why: "busy" }, "active"],
		["merged, run still open after accept", { latest: { ...settledTask, runOpen: true } }, { do: "retire", reason: "merged" }, "active"],
		["merged, session mid-turn", { sessionBusy: true }, { do: "hold", why: "busy" }, "active"],
		["merged, kept", { checkout: { present: true, branch: "feat/x", locked: true } }, { do: "hold", why: "locked" }, "merged"],
		["merged, worktree on another branch", { checkout: { present: true, branch: "other", locked: false } }, { do: "hold", why: "switched" }, "merged"],
		["merged, branch checked out elsewhere", { checkout: { present: false, branch: null, locked: false }, elsewhere: true }, { do: "hold", why: "switched" }, "merged"],
		["merged, uncommitted files", { dirty: true }, { do: "hold", why: "dirty" }, "merged"],
		["merged, no worktree on disk", { checkout: { present: false, branch: null, locked: false } }, { do: "retire", reason: "merged" }, "merged"],
		["retiring rows are resumed, not re-decided", { state: "retiring" }, { do: "keep" }, "retiring"],
	];
	for (const [name, change, plan, shown] of cases) {
		const facts = { ...base, ...change };
		const p = decide(facts);
		assert.deepEqual(p, plan, name);
		assert.equal(phase(facts, p), shown, name);
	}
});

// ── scenarios on real repositories ─────────────────────────────────────────

const ID = ["-c", "user.name=t", "-c", "user.email=t@example.test"];

interface Repo {
	root: string;
	git(...args: string[]): string;
	commit(file: string, text: string, message?: string): string;
}

function repo(dir: string): Repo {
	const git = (...args: string[]) => execFileSync("git", [...ID, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	return {
		root: dir,
		git,
		commit(file, text, message = `edit ${file}`) {
			fs.writeFileSync(path.join(dir, file), text);
			git("add", file);
			git("commit", "-qm", message);
			return git("rev-parse", "HEAD");
		},
	};
}

/** A clone of a bare "origin" with `main` tracking origin/main; returns the clone. */
function setup(): { tmp: string; r: Repo; origin: string } {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omphome-wt-")));
	const origin = path.join(tmp, "origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	const seed = repo(path.join(tmp, "seed"));
	fs.mkdirSync(seed.root);
	seed.git("init", "-q", "-b", "main");
	seed.commit("a.txt", "1\n2\n3\n4\n5\n", "init");
	seed.git("push", "-q", origin, "main");
	execFileSync("git", ["clone", "-q", origin, path.join(tmp, "repo")]);
	return { tmp, r: repo(path.join(tmp, "repo")), origin };
}

/** Branch `name` off main with commits; returns the fork point. */
function branch(r: Repo, name: string, edits: [string, string][]): string {
	const fork = r.git("rev-parse", "main");
	r.git("switch", "-q", "-c", name, "main");
	for (const [file, text] of edits) r.commit(file, text);
	r.git("switch", "-q", "main");
	return fork;
}

/** Observe one branch the way the lifecycle does: ancestry first, content only when ancestry says no. */
async function facts(s: RepoSurvey, root: string, name: string, forkSha: string, dir: string | null): Promise<{ facts: WorktreeFacts; ancestry: boolean; content: ContentMatch }> {
	const tip = s.tips.get(name)?.sha ?? null;
	const ancestry = tip !== null && s.ancestors.has(name);
	let content: ContentMatch = null;
	if (tip && !ancestry) for (const t of s.targets) content ??= await integratedByContent(root, tip, t.sha);
	const at = dir ? s.checkouts.get(canonicalPath(dir)) : undefined;
	const elsewhere = [...s.checkouts].some(([p, c]) => c.branch === name && (!dir || p !== canonicalPath(dir)));
	const f: WorktreeFacts = {
		state: "live",
		branch: name,
		forkSha,
		tip,
		integrated: ancestry || content !== null,
		checkout: { present: !!at, branch: at?.branch ?? null, locked: at?.locked ?? false },
		elsewhere,
		dirty: false,
		latest: settledTask,
		sessionBusy: false,
	};
	if (decide(f).do === "retire" && at) f.dirty = (await changedFiles(dir!)) > 0;
	return { facts: f, ancestry, content };
}

test("scenario matrix on real repositories: ancestry, content, holds", async t => {
	const { tmp, r } = setup();
	const forks = new Map<string, string>();
	const wt = (name: string) => path.join(tmp, "wt", name.replaceAll("/", "-"));

	// fast-forward
	forks.set("feat/ff", branch(r, "feat/ff", [["b.txt", "ff\n"]]));
	r.git("merge", "-q", "--ff-only", "feat/ff");
	// merge commit, base moved on elsewhere
	forks.set("feat/merge", branch(r, "feat/merge", [["c.txt", "merge\n"]]));
	r.commit("z1.txt", "base moves\n");
	r.git("merge", "-q", "--no-ff", "-m", "merge feat/merge", "feat/merge");
	// squash merge, base moved on elsewhere
	forks.set("feat/squash", branch(r, "feat/squash", [["d.txt", "one\n"], ["d.txt", "one\ntwo\n"]]));
	r.commit("z2.txt", "base moves\n");
	r.git("merge", "-q", "--squash", "feat/squash");
	r.git("commit", "-qm", "squash feat/squash");
	// rebase-merge: both commits replayed on the moved base
	forks.set("feat/rebase", branch(r, "feat/rebase", [["e.txt", "one\n"], ["e2.txt", "two\n"]]));
	r.commit("z3.txt", "base moves\n");
	r.git("cherry-pick", "feat/rebase~1", "feat/rebase");
	// squash, then the base edits the same lines again
	forks.set("fix/squash-edited", branch(r, "fix/squash-edited", [["a.txt", "1\nX\n3\n4\n5\n"], ["a.txt", "1\nXY\n3\n4\n5\n"]]));
	r.git("merge", "-q", "--squash", "fix/squash-edited");
	r.git("commit", "-qm", "squash fix/squash-edited");
	r.commit("a.txt", "1\nlater\n3\n4\n5\n", "base edits the same line");
	// rebase-merge, then the base edits the same lines again
	forks.set("fix/rebase-edited", branch(r, "fix/rebase-edited", [["a.txt", "1\nlater\n3\nR\n5\n"], ["a.txt", "1\nlater\n3\nRS\n5\n"]]));
	r.commit("z4.txt", "base moves\n");
	r.git("cherry-pick", "fix/rebase-edited~1", "fix/rebase-edited");
	r.commit("a.txt", "1\nlater\n3\nagain\n5\n", "base edits the same line again");
	// unmerged
	forks.set("feat/open", branch(r, "feat/open", [["f.txt", "not merged\n"]]));
	// empty: claimed at main, no commits
	forks.set("chore/empty", branch(r, "chore/empty", []));
	// gone: worktree removed and branch deleted by the human
	forks.set("feat/gone", branch(r, "feat/gone", [["g.txt", "gone\n"]]));
	r.git("branch", "-qD", "feat/gone");
	// merged but held: dirty, locked, switched (detached)
	for (const name of ["feat/dirty", "feat/locked", "feat/switched"]) {
		forks.set(name, branch(r, name, [[`${name.slice(5)}.txt`, `${name}\n`]]));
		r.git("merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
		r.git("worktree", "add", "-q", wt(name), name);
	}
	fs.writeFileSync(path.join(wt("feat/dirty"), "notes.txt"), "untracked\n");
	r.git("worktree", "lock", "--reason", "omp-home: kept", wt("feat/locked"));
	execFileSync("git", ["switch", "-q", "--detach"], { cwd: wt("feat/switched") });
	// merged only upstream (the human merged on the remote; local main is behind)
	forks.set("feat/upstream", branch(r, "feat/upstream", [["u.txt", "upstream\n"]]));
	r.git("push", "-q", "origin", "main");
	const behindMain = r.git("rev-parse", "main");
	r.git("switch", "-q", "--detach", "main");
	r.git("merge", "-q", "--no-ff", "-m", "merge on the remote", "feat/upstream");
	r.git("push", "-q", "origin", "HEAD:main");
	r.git("switch", "-q", "main");
	r.git("fetch", "-q", "origin");
	assert.equal(r.git("rev-parse", "main"), behindMain, "local main stays behind origin/main");

	const s = await survey(r.root, "main");
	assert.deepEqual(s.targets.map(x => x.ref), ["main", "origin/main"]);
	const expected: [string, boolean, ContentMatch, Plan][] = [
		["feat/ff", true, null, { do: "retire", reason: "merged" }],
		["feat/merge", true, null, { do: "retire", reason: "merged" }],
		["feat/squash", false, "tree", { do: "retire", reason: "merged" }],
		["feat/rebase", false, "tree", { do: "retire", reason: "merged" }],
		["fix/squash-edited", false, "squash", { do: "retire", reason: "merged" }],
		["fix/rebase-edited", false, "commits", { do: "retire", reason: "merged" }],
		["feat/open", false, null, { do: "keep" }],
		["chore/empty", true, null, { do: "retire", reason: "unused" }],
		["feat/gone", false, null, { do: "retire", reason: "gone" }],
		["feat/dirty", true, null, { do: "hold", why: "dirty" }],
		["feat/locked", true, null, { do: "hold", why: "locked" }],
		["feat/switched", true, null, { do: "hold", why: "switched" }],
		["feat/upstream", true, null, { do: "retire", reason: "merged" }],
	];
	const rows: string[] = ["branch | ancestry | content | plan"];
	for (const [name, ancestry, content, plan] of expected) {
		const dir = fs.existsSync(wt(name)) ? wt(name) : null;
		const got = await facts(s, r.root, name, forks.get(name)!, dir);
		const p = decide(got.facts);
		rows.push(`${name} | ${got.ancestry ? "✓" : "✗"} | ${got.content ?? "✗"} | ${p.do}${"reason" in p ? ` ${p.reason}` : "why" in p ? ` ${p.why}` : ""}`);
		assert.equal(got.ancestry, ancestry, `${name}: ancestry`);
		assert.equal(got.content, content, `${name}: content`);
		assert.deepEqual(p, plan, name);
	}
	t.diagnostic(`\n${rows.join("\n")}`);

	assert.deepEqual(await freshestBase(r.root, "main"), { ref: "origin/main", sha: r.git("rev-parse", "origin/main") }, "fork from the upstream when local main is behind");
	r.git("merge", "-q", "--ff-only", "origin/main");
	assert.deepEqual(await freshestBase(r.root, "main"), { ref: "main", sha: r.git("rev-parse", "main") });
	assert.deepEqual(await freshestBase(r.root, "feat/open"), { ref: "feat/open", sha: r.git("rev-parse", "feat/open") });

	// A pruned remote branch shows as [gone]; it is a hint only and never retires anything by itself.
	r.git("push", "-q", "-u", "origin", "feat/open");
	r.git("push", "-q", "origin", "--delete", "feat/open");
	r.git("fetch", "-q", "--prune", "origin");
	const after = await survey(r.root, "main");
	assert.equal(after.tips.get("feat/open")?.upstreamGone, true);
	assert.deepEqual(decide((await facts(after, r.root, "feat/open", forks.get("feat/open")!, null)).facts), { do: "keep" });
	fs.rmSync(tmp, { recursive: true, force: true });
});
