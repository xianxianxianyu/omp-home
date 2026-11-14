import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import type { BranchDTO, BranchesDTO, SessionDTO, StateDTO, TaskDetail } from "../shared/api.ts";
import { killHubs, sandbox, startHub, Stream, until } from "./hub-harness.ts";

/**
 * The worktree lifecycle end to end on a temp repository with the fake omp: a branch-lane task
 * commits, is accepted, the human squash-merges it, and the sweep records the merge and retires
 * worktree, branch (compare-and-swap on the recorded sha) and session; a retired session's
 * transcript stays readable without starting it. One unsettled task edits the main checkout at a
 * time, and git there is read-only. A merge the human has not accepted settles its task, and a
 * merged worktree with uncommitted files, or kept (locked), is held until it is clean and unpinned.
 */

after(killHubs);

const BRIEF = "Goal: exercise the worktree lifecycle with the fake omp. Background: none. Constraints: none. Acceptance: the fake reports done. Report: what changed.";
const ID = ["-c", "user.name=human", "-c", "user.email=h@example.test"];

test("lifecycle: merge retires worktree, branch and session; one main-lane editor; dirty merged worktrees are held", { timeout: 180_000 }, async () => {
	const box = sandbox();
	const hub = await startHub(box.configDir);
	const task = async (id: string) => (await hub.api<TaskDetail>("GET", `/api/tasks/${id}`)).body;
	const sessions = async () => (await hub.api<SessionDTO[]>("GET", "/api/sessions")).body;
	const branches = async () => (await hub.api<BranchesDTO>("GET", "/api/workspaces/deckhand/branches")).body;
	const send = (title: string, checkout: unknown, marker = "") => `/dispatch ${JSON.stringify({ title, workspace: "deckhand", brief: `${BRIEF} ${marker}`, checkout })}`;
	const done = (id: string) =>
		until(`${id} done`, async () => {
			const t = await task(id);
			return t.status === "done" && t;
		});

	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	await until("main idle", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	assert.equal((await hub.api("POST", "/api/workspaces", { repoPath: box.gitRepo })).status, 200);
	const main = await new Stream(hub, "M-1", box.home).open();

	// Naming policy: new branches are <type>/<kebab-slug>; the base branch is not a lane.
	let mark = main.out.length;
	main.agent(send("Bad name", { lane: "branch", branch: "Share Button" }));
	await main.expect(/RESULT err invalid "Share Button" is not a valid branch name/, mark);
	mark = main.out.length;
	main.agent(send("Bad name", { lane: "branch", branch: "task/share" }));
	await main.expect(/RESULT err invalid "task\/share" is not a new-branch name: use <feat\|fix\|refactor\|perf\|test\|docs\|chore>\/<kebab-slug>/, mark);
	mark = main.out.length;
	main.agent(send("On main", { lane: "branch", branch: "main" }));
	await main.expect(/RESULT err invalid main is the base branch; code changes need their own branch/, mark);

	// T-1: a branch-lane worker commits on its branch; main accepts it.
	mark = main.out.length;
	main.agent(send("Add a share button", { lane: "branch", branch: "feat/share-button" }, "[fake:commit]"));
	await main.expect(/RESULT ok T-1 pending · deckhand · new branch feat\/share-button from main@/, mark);
	const t1 = await done("T-1");
	assert.match(t1.reports[0]!.details!, /COMMIT ok/);
	assert.deepEqual([t1.worktree?.phase, t1.worktree?.hold, t1.worktree?.ahead, t1.worktree?.behind], ["idle", null, 1, 0]);
	const tip = box.git("rev-parse", "feat/share-button");
	assert.equal(box.git("log", "-1", "--format=%s", tip), "add W-1.txt");
	mark = main.out.length;
	main.agent(`/call home_close ${JSON.stringify({ task: "T-1", outcome: "done", reason: "the commit adds the button" })}`);
	await main.expect(/RESULT ok T-1 closed as done/, mark);

	// T-2 edits the main checkout: uncommitted, and git refuses a commit there (pre-commit backstop).
	mark = main.out.length;
	main.agent(send("Fix the README", { lane: "main", edit: true }, "[fake:edit]"));
	await main.expect(/RESULT ok T-2 pending · deckhand · main checkout \(on main\), editing, no commits/, mark);
	const t2 = await done("T-2");
	assert.match(t2.reports[0]!.details!, /COMMIT refused: omp-home: this is the human's main checkout; git is read-only here/);
	assert.match(t2.envelope!, /you may edit files; leave them uncommitted for the human/);
	assert.equal(fs.readFileSync(path.join(box.gitRepo, "W-2.md"), "utf8"), "written by W-2\n");
	assert.equal(t2.worktree, null);
	// A second editor of the same main checkout is refused until T-2 is accepted; read-only research is not.
	mark = main.out.length;
	main.agent(send("Fix the CHANGELOG", { lane: "main", edit: true }));
	await main.expect(/RESULT err conflict T-2 is editing deckhand's main checkout \(done\): home_send T-2 to add this, or wait until it is accepted/, mark);
	mark = main.out.length;
	main.agent(`/call home_close ${JSON.stringify({ task: "T-2", outcome: "done", reason: "README reads right" })}`);
	await main.expect(/RESULT ok T-2 closed as done/, mark);
	fs.rmSync(path.join(box.gitRepo, "W-2.md"));

	// The human squash-merges T-1 into main; the next look records the merge and retires everything.
	box.git("merge", "-q", "--squash", "feat/share-button");
	box.git(...ID, "commit", "-qm", "Share button (squashed)");
	assert.throws(() => box.git("merge-base", "--is-ancestor", tip, "main"), "squash: the tip is not an ancestor of main");
	const listed = await branches();
	assert.ok(listed.live.some(b => b.branch === "feat/share-button") || listed.retired.some(b => b.branch === "feat/share-button"));
	const retired = await until("T-1's branch retired", async () => {
		const t = await task("T-1");
		return t.worktree?.phase === "retired" && t;
	});
	assert.deepEqual(retired.worktree!.retired, { reason: "merged", at: retired.worktree!.retired!.at, sha: tip, branchDeleted: true });
	const kinds = retired.events.map(e => e.kind);
	assert.ok(kinds.indexOf("merged") < kinds.indexOf("worktree_retired"), kinds.join(" "));
	assert.match(retired.events.find(e => e.kind === "merged")!.summary, new RegExp(`feat/share-button merged into main by the human \\(${tip.slice(0, 8)}\\)`));
	assert.equal(retired.worktreePath, null);
	assert.equal(box.git("branch", "--list", "feat/share-button"), "", "branch deleted");
	assert.throws(() => box.git("config", "--get-regexp", "^branch\\.feat/share-button\\."), "branch config removed");
	assert.ok(!fs.existsSync(path.join(box.tmp, "deckhand.worktrees", "feat-share-button")), "worktree removed");
	assert.ok(!box.git("worktree", "list").includes("feat-share-button"));
	assert.ok((await sessions()).find(s => s.id === "W-1")!.retired);
	assert.ok((await branches()).retired.some(b => b.branch === "feat/share-button" && b.retired?.reason === "merged"));

	// A retired session: its transcript is readable, nothing starts it again.
	const w1 = await new Stream(hub, "W-1", box.home).open();
	await w1.expect(/\[omp-home task T-1 · Add a share button\][\s\S]*All done\./);
	assert.equal(w1.closed, null);
	assert.deepEqual(
		(await sessions()).filter(s => s.id === "W-1").map(s => [s.state, s.pid]),
		[["cold", null]],
	);
	assert.equal((await hub.api("POST", "/api/sessions/W-1/prompt", { text: "more please" })).status, 409);
	assert.equal((await hub.api("POST", "/api/sessions/W-1/attach")).status, 409);
	w1.close();
	// The merged branch's name is free again, as a new branch.
	mark = main.out.length;
	main.agent(send("Polish the share button", { lane: "branch", branch: "feat/share-button" }));
	await main.expect(/RESULT ok T-3 pending · deckhand · new branch feat\/share-button from main@/, mark);
	await done("T-3");
	mark = main.out.length;
	main.agent(`/call home_close ${JSON.stringify({ task: "T-3", outcome: "done", reason: "nothing left to change" })}`);
	await main.expect(/RESULT ok T-3 closed as done/, mark);
	await until("a branch without commits is retired as unused once its task is closed", async () => (await task("T-3")).worktree?.retired?.reason === "unused");

	// T-4 is merged without being accepted: the merge settles it. Uncommitted files hold the worktree.
	mark = main.out.length;
	main.agent(send("Fix the flaky thing", { lane: "branch", branch: "fix/flaky-thing" }, "[fake:commit]"));
	await main.expect(/RESULT ok T-4 pending/, mark);
	const t4 = await done("T-4");
	const dir = t4.worktreePath!;
	fs.writeFileSync(path.join(dir, "scratch.txt"), "not committed\n");
	box.git(...ID, "merge", "-q", "--no-ff", "-m", "Merge fix/flaky-thing", "fix/flaky-thing");
	await branches();
	const held = await until("T-4 merged and held", async () => {
		const t = await task("T-4");
		return t.worktree?.hold === "dirty" && t;
	});
	assert.equal(held.status, "done");
	assert.ok(held.events.some(e => e.kind === "merged"), "the merge settled the task");
	assert.deepEqual([held.worktree!.phase, held.worktree!.holdDetail], ["merged", "1 uncommitted file"]);
	assert.ok(fs.existsSync(path.join(dir, "scratch.txt")));
	assert.equal(box.git("branch", "--list", "--format=%(refname:short)", "fix/flaky-thing"), "fix/flaky-thing");
	assert.equal((await sessions()).find(s => s.id === t4.sessionId)!.retired, false);
	// Main sees the same in one line per branch.
	const toolOutput = (name: string, re: RegExp) => until(`${name} output ${re}`, async () => Object.values(main.view.tools).find(t => t.name === name && re.test(t.output ?? "")));
	main.agent(`/call home_status {}`);
	await toolOutput("home_status", /\n {2}- branch fix\/flaky-thing · merged \(held: dirty, 1 uncommitted file\) · 0 ahead\/1 behind main · T-4 done ✓\n/);
	main.agent(`/call home_task ${JSON.stringify({ id: "T-4" })}`);
	await toolOutput("home_task", /\nBranch: fix\/flaky-thing · merged \(held: dirty, 1 uncommitted file\) · 0 ahead\/1 behind main · T-4 done ✓\n/);
	// Keep pins it (git worktree lock): clean or not, the hub leaves it, and Remove asks to unpin first.
	const wt4 = held.worktree!.worktreeId;
	const kept = await hub.api<BranchDTO>("POST", `/api/worktrees/${wt4}/keep`, { keep: true });
	assert.deepEqual([kept.status, kept.body.kept, kept.body.hold], [200, true, "locked"]);
	assert.match(box.git("worktree", "list", "--porcelain"), /locked omp-home: kept/);
	fs.rmSync(path.join(dir, "scratch.txt"));
	assert.deepEqual((await branches()).live.find(b => b.worktreeId === wt4)?.hold, "locked");
	assert.equal((await hub.api("POST", `/api/worktrees/${wt4}/remove`, { deleteBranch: true })).status, 409);
	// Unpinned and clean: the next look retires it.
	const unkept = await hub.api<BranchDTO>("POST", `/api/worktrees/${wt4}/keep`, { keep: false });
	assert.equal(unkept.body.kept, false);
	await until("T-4 retired once clean and unpinned", async () => (await task("T-4")).worktree?.retired?.reason === "merged");
	assert.ok(!fs.existsSync(dir));
	assert.equal(box.git("branch", "--list", "fix/flaky-thing"), "");

	main.close();
	hub.child.kill("SIGTERM");
	assert.equal(await hub.exited, 0);
});
