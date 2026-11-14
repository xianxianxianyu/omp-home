import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * Only the lifecycle module changes repositories: every git call that adds, removes, locks or
 * prunes a worktree, deletes a ref or fetches lives in server/worktrees.ts. Tests and their
 * fixtures build repositories however they like.
 */

const root = path.resolve(import.meta.dirname, "..");
const OWNER = "server/worktrees.ts";
/** Argument lists (`git(root, ["worktree", "add", …])`) and shell strings (`git -C x worktree add …`); comments do not count. */
const MUTATIONS = [
	/[[,]\s*["'`]worktree["'`]\s*,\s*["'`](?:add|remove|prune|lock|unlock|move|repair)["'`]/,
	/[[,]\s*["'`]update-ref["'`]\s*[,\]]/,
	/[[,]\s*["'`]branch["'`]\s*,\s*["'`]-[dD]["'`]/,
	/[[,]\s*["'`]fetch["'`]\s*[,\]]/,
	/\bgit\s+(?:-C\s+\S+\s+)?(?:worktree\s+(?:add|remove|prune|lock|unlock|move)|update-ref|branch\s+-[dD]|fetch\s)/,
];
const COMMENT = /^\s*(?:\/\/|\/?\*)/;

function sources(dir: string): string[] {
	return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "dist" || entry.name === "node_modules" ? [] : sources(rel);
		return /\.(?:ts|mjs|js)$/.test(entry.name) ? [rel] : [];
	});
}

test("repository-mutating git commands live only in the lifecycle module", () => {
	const files = ["server", "shared", "omp-plugin", "scripts"].flatMap(sources);
	assert.ok(files.includes(OWNER));
	const found = files.flatMap(file =>
		fs
			.readFileSync(path.join(root, file), "utf8")
			.split("\n")
			.flatMap((line, i) => (!COMMENT.test(line) && MUTATIONS.some(re => re.test(line)) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
	);
	assert.deepEqual(
		found.filter(hit => !hit.startsWith(`${OWNER}:`)),
		[],
	);
	// The lifecycle deletes branches by compare-and-swap (update-ref), never with branch -D.
	for (const re of [MUTATIONS[0]!, MUTATIONS[1]!, MUTATIONS[3]!]) assert.ok(found.some(hit => re.test(hit)), `the lifecycle module itself still matches ${re}`);
});
