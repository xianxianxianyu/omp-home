import type { BranchHold, BranchPhase, TaskStatus, WaitKind } from "../../shared/api.ts";
import { BRANCH_TYPES } from "../../shared/tools.ts";

/**
 * The only place worktree lifecycle policy lives. Pure: the caller observes git and the
 * ledger, `decide` says what to do, `phase` says what to show. Only the hub's intent
 * (`live → retiring → retired`) is stored; everything here is derived on each look.
 */

export type WorktreeState = "live" | "retiring" | "retired";
export type RetireReason = "merged" | "unused" | "gone" | "discarded";

export interface LatestTask {
	id: string;
	status: TaskStatus;
	waitKind: WaitKind | null;
	runOpen: boolean;
	settled: boolean;
}

export interface WorktreeFacts {
	state: WorktreeState;
	branch: string;
	/** Branch tip when the row was claimed; null only for rows migrated from before the lifecycle. */
	forkSha: string | null;
	/** refs/heads/<branch>; null when the branch does not exist. */
	tip: string | null;
	/** The tip's content is in the base or its upstream. */
	integrated: boolean;
	/** The worktree at the row's path, as git lists it. */
	checkout: { present: boolean; branch: string | null; locked: boolean };
	/** The branch is checked out in a worktree other than the row's (the main checkout included). */
	elsewhere: boolean;
	dirty: boolean;
	latest: LatestTask | null;
	/** The worker process is running a turn or showing an approval dialog. */
	sessionBusy: boolean;
}

export type Plan =
	| { do: "keep" }
	| { do: "settle"; task: string }
	| { do: "hold"; why: BranchHold }
	| { do: "retire"; reason: Exclude<RetireReason, "discarded"> };

export const inFlight = (t: LatestTask): boolean =>
	t.status === "pending" || t.status === "working" || t.runOpen || t.waitKind === "provision_failed";

/** Why a live branch could be retired, before holds: gone (no ref), unused (integrated, no commits since claim), merged. */
export function retireReason(f: Pick<WorktreeFacts, "tip" | "integrated" | "forkSha">): Exclude<RetireReason, "discarded"> | null {
	if (f.tip === null) return "gone";
	if (!f.integrated) return null;
	return f.tip === f.forkSha ? "unused" : "merged";
}

export function decide(f: WorktreeFacts): Plan {
	// Retiring rows are resumed step by step, never re-decided.
	if (f.state !== "live") return { do: "keep" };
	const reason = retireReason(f);
	if (!reason) return { do: "keep" };
	const t = f.latest;
	if (t && !t.settled) {
		if (inFlight(t)) return { do: "hold", why: "busy" };
		// A merge by the human is acceptance; an unused or vanished branch waits for main to close its task.
		return reason === "merged" ? { do: "settle", task: t.id } : { do: "hold", why: "unaccepted" };
	}
	if (f.sessionBusy) return { do: "hold", why: "busy" };
	if (f.checkout.present && f.checkout.locked) return { do: "hold", why: "locked" };
	// Detached, on another branch, or the branch checked out somewhere else: removing would orphan work.
	if (f.elsewhere || (f.checkout.present && f.checkout.branch !== f.branch)) return { do: "hold", why: "switched" };
	if (f.checkout.present && f.dirty) return { do: "hold", why: "dirty" };
	return { do: "retire", reason };
}

export function phase(f: WorktreeFacts, p: Plan): BranchPhase {
	if (f.state !== "live") return f.state;
	if ((f.latest && inFlight(f.latest)) || (p.do === "hold" && p.why === "busy")) return "active";
	if (retireReason(f) === "merged") return "merged";
	return f.checkout.present ? "idle" : "parked";
}

const NEW_BRANCH = new RegExp(`^(?:${BRANCH_TYPES.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`);
const NEW_BRANCH_MAX = 60;

/** A name for a branch that does not exist yet: `<type>/<kebab-slug>`, or null. */
export function parseNewBranch(name: string): string | null {
	return name.length <= NEW_BRANCH_MAX && NEW_BRANCH.test(name) ? name : null;
}
