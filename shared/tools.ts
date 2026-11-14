import { z } from "zod";

/**
 * The one list of omp-home agent tools. The bridge registers these in omp (as JSON
 * Schema) and the hub validates calls against the same zod schemas, so a tool cannot
 * exist on one side only. Handlers live in `server/tools.ts`, typed from this map.
 */

/** Who is calling, derived from the omp process role and the extension's `ctx.agent`. */
export type Audience = "main" | "dispatcher" | "main_sub" | "worker" | "worker_sub";

export interface AgentRef {
	kind: "main" | "sub";
	id: string;
	name: string;
	parentId?: string;
}

export function audienceOf(role: "main" | "worker", agent: AgentRef): Audience {
	if (role === "worker") return agent.kind === "main" ? "worker" : "worker_sub";
	if (agent.kind === "main") return "main";
	return agent.name === "dispatcher" ? "dispatcher" : "main_sub";
}

const checkout = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("worktree"),
			branch: z.string().min(1).max(100).optional().describe("Branch name; default task/<slug of title>."),
			base: z.string().min(1).optional().describe("Base ref; default the workspace's default base."),
		})
		.describe("New worktree and branch, new worker session."),
	z
		.object({
			kind: z.literal("continue"),
			task: z.string().describe("Earlier task id (T-n) whose worktree to continue in."),
			session: z.enum(["reuse", "fresh"]).describe("reuse only when its conversation, uncommitted state or running processes matter."),
		})
		.describe("Same worktree as an earlier task."),
	z.object({ kind: z.literal("readonly") }).describe("Read-only investigation in the workspace's main checkout."),
]);

export const TOOL_SPECS = {
	home_status: {
		audience: ["main", "dispatcher", "main_sub"],
		description:
			"Overview: workspaces, worker pool, open tasks, inbox, automatic wakes left, and the poteto-mode playbook names. Call before routing.",
		params: z.object({}),
	},
	home_search: {
		audience: ["main", "dispatcher", "main_sub"],
		description:
			"Search past main-chat messages, task briefs, worker reports and decisions (works for Chinese). Returns excerpts with refs; read a task with home_task.",
		params: z.object({
			query: z.string().min(1),
			scope: z.enum(["all", "chat", "tasks"]).optional(),
			workspace: z.string().optional(),
			limit: z.number().int().min(1).max(30).optional(),
		}),
	},
	home_task: {
		audience: ["main", "dispatcher", "main_sub"],
		description: "Read one task: brief, status, worktree and session, reports, decisions and the recent timeline.",
		params: z.object({ id: z.string(), events: z.number().int().min(0).max(200).optional() }),
	},
	home_chat: {
		audience: ["main", "dispatcher", "main_sub"],
		description: "Read the lossless main-chat record around a search hit (ref like chat:123), or the latest messages when ref is omitted.",
		params: z.object({ ref: z.string().optional(), before: z.number().int().min(0).max(50).optional(), after: z.number().int().min(0).max(50).optional() }),
	},
	home_dispatch: {
		audience: ["dispatcher"],
		description:
			"Create a task and send it to a worker. The hub prepares the worktree, environment and session and returns immediately. Call exactly once.",
		params: z.object({
			title: z.string().min(2).max(80),
			workspace: z.string(),
			brief: z
				.string()
				.min(120)
				.max(20000)
				.describe("Markdown: goal, background, constraints, acceptance (commands), what to report."),
			checkout,
			playbook: z.string().optional().describe("poteto-mode playbook file stem, e.g. bug-fix, feature, investigation."),
			related: z.array(z.string()).max(10).optional(),
		}),
	},
	home_send: {
		audience: ["main"],
		description:
			"Send a message to a task's worker (answer, correction, next step). Resumes a stopped worker. Answering a worker question or blocker decides on the human's behalf, so pass decision.",
		params: z.object({
			task: z.string(),
			text: z.string().min(1).max(8000),
			mode: z.enum(["next", "now"]).optional().describe("now = steer the running turn; next (default) = after it."),
			decision: z.object({ why: z.string().min(5), revert: z.string().min(5) }).optional(),
		}),
	},
	home_decide: {
		audience: ["main"],
		description: "Record a decision made on the human's behalf (accepting a result, choosing an option) with why and how to revert it.",
		params: z.object({
			task: z.string().optional(),
			decision: z.string().min(3),
			why: z.string().min(5),
			revert: z.string().min(5),
			reverts: z.string().optional().describe("D-n when this decision undoes an earlier one."),
		}),
	},
	home_escalate: {
		audience: ["main"],
		description: "Ask the human: opens the task's live worker terminal beside the chat and adds an Inbox item. Use for irreversible or preference calls.",
		params: z.object({ task: z.string(), reason: z.string().min(5).max(500) }),
	},
	home_close: {
		audience: ["main"],
		description: "Close a task: done (accept the result) or cancelled (abort the worker's run).",
		params: z.object({ task: z.string(), outcome: z.enum(["done", "cancelled"]), reason: z.string().min(3) }),
	},
	home_report: {
		audience: ["worker"],
		description:
			"Report this turn's outcome to the home agent before ending the turn: done, blocked, question (end your turn with the question), or progress.",
		params: z.object({
			status: z.enum(["done", "blocked", "question", "progress"]),
			summary: z.string().min(1).max(2000),
			details: z.string().max(8000).optional().describe("What changed, acceptance commands and their result tail, what is not done."),
		}),
	},
	home_env: {
		audience: ["worker", "worker_sub"],
		description: "This worktree's environment: ports, database URL, services, account pools and test commands. repair:true re-runs the setup.",
		params: z.object({ repair: z.boolean().optional() }),
	},
	home_lease: {
		audience: ["worker", "worker_sub"],
		description: "Lease a test account from a pool (released automatically when your turn ends).",
		params: z.object({ pool: z.string() }),
	},
} as const satisfies Record<string, { audience: readonly Audience[]; description: string; params: z.ZodType }>;

export type ToolName = keyof typeof TOOL_SPECS;
export type ToolParams<K extends ToolName> = z.infer<(typeof TOOL_SPECS)[K]["params"]>;
export type CheckoutSpec = z.infer<typeof checkout>;

/** Built-in omp tools removed per role. */
export const HIDDEN_BUILTINS: Record<"main" | "worker", readonly string[]> = { main: [], worker: ["ask"] };

export function toolsFor(audience: Audience): ToolName[] {
	return (Object.keys(TOOL_SPECS) as ToolName[]).filter(name => (TOOL_SPECS[name].audience as readonly Audience[]).includes(audience));
}
