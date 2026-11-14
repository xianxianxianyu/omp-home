/**
 * Branded identifiers. Parse once at boundaries (tool params, HTTP params, wire
 * frames) with the `parse*` helpers; trust the brand everywhere inside.
 */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkspaceId = Brand<string, "WorkspaceId">; // slug: [a-z0-9][a-z0-9-]{0,39}
export type TaskId = Brand<string, "TaskId">; // "T-45"
export type SessionId = Brand<string, "SessionId">; // "M-1" | "W-12"
export type WorktreeId = Brand<string, "WorktreeId">; // "WT-7"
export type DecisionId = Brand<string, "DecisionId">; // "D-17"
export type EscalationId = Brand<string, "EscalationId">; // "E-5"
export type Playbook = Brand<string, "Playbook">; // file stem under poteto-mode/playbooks

export class IdError extends Error {}

function check<T>(pattern: RegExp, kind: string, value: unknown): T {
	if (typeof value !== "string" || !pattern.test(value)) throw new IdError(`invalid ${kind}: ${JSON.stringify(value)}`);
	return value as T;
}

export const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const parseWorkspaceId = (v: unknown) => check<WorkspaceId>(WORKSPACE_ID_PATTERN, "workspace id", v);
export const parseTaskId = (v: unknown) => check<TaskId>(/^T-\d+$/, "task id", v);
export const parseSessionId = (v: unknown) => check<SessionId>(/^[MW]-\d+$/, "session id", v);
export const parseWorktreeId = (v: unknown) => check<WorktreeId>(/^WT-\d+$/, "worktree id", v);
export const parseDecisionId = (v: unknown) => check<DecisionId>(/^D-\d+$/, "decision id", v);
export const parseEscalationId = (v: unknown) => check<EscalationId>(/^E-\d+$/, "escalation id", v);

/** Turn a display name or path basename into a workspace id. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "workspace";
}
