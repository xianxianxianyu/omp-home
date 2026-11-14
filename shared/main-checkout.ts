/**
 * The human's main checkout is theirs: a worker there (lane "main") may read git but never
 * change it. Guardrail, not containment: the bridge refuses recognized commands and
 * git-guard/pre-commit is the backstop.
 */

const READ_ONLY_GIT: Record<string, true> = {
	status: true, diff: true, log: true, show: true, blame: true, grep: true, "ls-files": true, "ls-tree": true, "rev-parse": true, "rev-list": true,
	"merge-base": true, "cat-file": true, describe: true, shortlog: true, "for-each-ref": true, "show-ref": true,
};
const GIT = /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|--(?:git-dir|work-tree)=\S+\s+|(?:--no-pager|-P)\s+)*([a-z][a-z-]*)([^;&|\n]*)/g;
const LIST_BRANCHES = /^(?:\s+(?:--list|-l|-a|--all|-r|--remotes|-vv?|--verbose|--show-current|--no-color))*\s*$/;

/** Why a shell or eval input may not run in the main checkout, or undefined when every git call in it only reads. */
export function mainCheckoutRefusal(command: string): string | undefined {
	const words = command.replace(/\\\r?\n/g, " ").replace(/["'`,[\]]/g, " ");
	for (const [, sub, args] of words.matchAll(GIT)) {
		if (READ_ONLY_GIT[sub!] === true) continue;
		if (sub === "branch" && LIST_BRANCHES.test(args!)) continue;
		if (sub === "worktree" && /^\s+list\b/.test(args!)) continue;
		return "The main checkout is the human's: git is read-only here (status, diff, log, show and other reads). Leave your edits uncommitted.";
	}
	return undefined;
}
