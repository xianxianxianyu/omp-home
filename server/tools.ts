import { setTimeout as sleep } from "node:timers/promises";
import type { BranchDTO } from "../shared/api.ts";
import { IdError, parseDecisionId, parseTaskId } from "../shared/ids.ts";
import { audienceOf, TOOL_SPECS, type Audience, type AgentRef, type ToolName, type ToolParams } from "../shared/tools.ts";
import type { CallFrame, CallResult } from "./bridge.ts";
import { EnvError } from "./env.ts";
import { errorText, HubError } from "./errors.ts";
import type { Hub } from "./hub.ts";
import { statusText } from "./ledger.ts";
import type { SessionRow } from "./pool.ts";
import { playbooks } from "./pstack.ts";
import { LOOK_FRESH_MS } from "./worktrees.ts";

export interface CallContext {
	session: SessionRow;
	audience: Audience;
	agent: AgentRef;
	callId: string;
}

interface ToolResult {
	text: string;
	details?: unknown;
}

type Handler<K extends ToolName> = (p: ToolParams<K>, c: CallContext) => ToolResult | Promise<ToolResult>;

const REPAIR_WAIT_MS = 45_000;

function taskId(raw: string): string {
	try {
		return parseTaskId(raw.trim());
	} catch (err) {
		if (err instanceof IdError) throw new HubError("invalid", `${err.message}; task ids look like T-12`);
		throw err;
	}
}

function quoteWorker(task: string, text: string): string {
	return `<worker-report task="${task}">${text.replaceAll("<", "&lt;")}</worker-report>`;
}

const fmtTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** One line per branch for home_status / home_task: phase, why it is held, distance from the base, its latest task. */
function branchLine(b: BranchDTO): string {
	const hold = b.hold ? ` (held: ${b.hold}${b.holdDetail ? `, ${b.holdDetail}` : ""})` : "";
	const distance = b.ahead !== null && b.behind !== null ? ` · ${b.ahead} ahead/${b.behind} behind ${b.base}` : "";
	const flags = `${b.kept ? " · kept" : ""}${b.upstreamGone ? " · remote deleted" : ""}${b.stale ? " · stale" : ""}`;
	const latest = b.tasks[0];
	return `${b.branch} · ${b.phase}${hold}${distance}${flags}${latest ? ` · ${latest.id} ${latest.status}${latest.settled ? " ✓" : ""}` : ""}`;
}

/** Handlers for every tool in shared/tools.ts; audience and params are checked before a handler runs. */
export function createTools(hub: Hub): (session: SessionRow, frame: CallFrame) => Promise<CallResult> {
	const h: { [K in ToolName]: Handler<K> } = {
		async home_status() {
			const workspaces = hub.workspaces.list().map(w => hub.workspaces.dto(w));
			const branches = new Map(await Promise.all(workspaces.map(async w => [w.id, (await hub.lifecycle.branches(w.id, "en", LOOK_FRESH_MS)).live] as const)));
			const open = hub.ledger.listTasks({ status: "open" });
			const main = hub.notifier.main();
			const books = playbooks(hub.settings.get().pstackRoot);
			const lines = [
				"Workspaces:",
				...(workspaces.length
					? workspaces.flatMap(w => [
							`- ${w.id}: ${w.repoPath} · base ${w.defaultBase} · sessions ${w.liveSessions} live / ${w.totalSessions} · ${w.openTasks} open task(s) · recipe ${w.recipeStatus} · ${hub.recipeChecks.describe(w.id)}`,
							...(branches.get(w.id) ?? []).map(b => `  - branch ${branchLine(b)}`),
						])
					: ["- none registered (the human adds them in the Workspaces view)"]),
				`Pool: ${hub.pool.liveWorkerCount()}/${hub.settings.get().maxLiveWorkers} live workers`,
				"Open tasks:",
				...(open.length ? open.map(t => `- ${t.id} [${statusText(t)}] ${t.title} (${t.workspace_id}${t.session_id ? `, ${t.session_id}` : ""})`) : ["- none"]),
				`Inbox: ${hub.ledger.escalations({ open: true }).length} open escalation(s)`,
				`Auto-wakes left: ${Math.max(0, main.wakesMax - main.wakesUsed)}/${main.wakesMax}${main.paused ? " (paused: waiting for the human)" : ""}`,
				`Playbooks: ${books.length ? books.join(", ") : "none (pstack not configured)"}`,
			];
			return { text: lines.join("\n"), details: { workspaces, openTasks: open.map(t => hub.taskSummary(t)), main, playbooks: books } };
		},

		home_search(p) {
			const hits = hub.indexer.search(p.query, { scope: p.scope, workspace: p.workspace, limit: p.limit });
			if (!hits.length) return { text: `No matches for "${p.query}".`, details: { hits } };
			const lines = hits.map(hit => {
				const head = `${hit.ref} · ${hit.kind} · ${fmtTime(hit.at)}${hit.taskId ? ` · ${hit.taskId}` : ""}${hit.title ? ` · ${hit.title}` : ""}`;
				const body = (hit.kind === "report" || hit.kind === "run_text") && hit.taskId ? quoteWorker(hit.taskId, hit.excerpt) : hit.excerpt;
				return `${head}\n  ${body}`;
			});
			return { text: `${lines.join("\n")}\nRead a task with home_task({ id }); chat context with home_chat({ ref }).`, details: { hits } };
		},

		async home_task(p) {
			const d = await hub.taskDetail(taskId(p.id), p.events ?? 20);
			const lines = [
				`${d.id} ${d.title} · ${d.workspace} · ${d.wait ? `awaiting ${d.wait.kind}` : d.status}${d.playbook ? ` · playbook ${d.playbook}` : ""}`,
				`Checkout: ${JSON.stringify(d.checkout)}${d.worktreePath ? ` · ${d.worktreePath}` : ""}`,
				`Session: ${d.sessionId ?? "none yet"}`,
			];
			if (d.worktree) lines.push(`Branch: ${branchLine(d.worktree)}`);
			if (d.related.length) lines.push(`Related: ${d.related.join(", ")}`);
			if (d.env) lines.push(`Env: ${d.env.state}${d.env.error ? ` (${d.env.error.split("\n")[0]})` : ""}`);
			if (d.wait) lines.push(`Waiting: ${d.wait.kind}`, quoteWorker(d.id, d.wait.text));
			lines.push("Brief:", d.brief);
			if (d.reports.length) {
				lines.push("Reports:");
				for (const r of d.reports.slice(-5)) lines.push(`- ${fmtTime(r.at)} ${r.status}`, quoteWorker(d.id, r.details ? `${r.summary}\n${r.details}` : r.summary));
			}
			if (d.decisions.length) lines.push("Decisions:", ...d.decisions.map(x => `- ${x.id}: ${x.summary} (why: ${x.why}; revert: ${x.revert})`));
			const openEsc = d.escalations.filter(e => e.resolvedAt === null);
			if (openEsc.length) lines.push(`Open escalation: ${openEsc.map(e => `${e.id} ${e.reason}`).join("; ")}`);
			lines.push("Recent timeline:", ...d.events.map(e => `- ${fmtTime(e.at)} ${e.actor}: ${e.actor === "worker" ? quoteWorker(d.id, e.summary) : e.summary}`));
			return { text: lines.join("\n"), details: d };
		},

		home_chat(p) {
			let records;
			if (p.ref) {
				const m = /^chat:(\d+)$/.exec(p.ref.trim());
				if (!m) throw new HubError("invalid", `chat refs look like chat:123 (from home_search), got ${p.ref}`);
				records = hub.indexer.chatAround(Number(m[1]), p.before ?? 5, p.after ?? 5);
			} else {
				records = hub.indexer.chat({ limit: 20 });
			}
			if (!records.length) return { text: "No chat records.", details: { records } };
			return {
				text: records.map(r => `chat:${r.id} · ${fmtTime(r.at)} · ${r.role}\n${r.text}`).join("\n\n"),
				details: { records },
			};
		},

		async home_dispatch(p, c) {
			const ws = hub.workspaces.must(p.workspace.trim());
			if (ws.archived_at !== null) throw new HubError("invalid", `workspace ${ws.id} is archived`);
			let playbook: string | null = null;
			if (p.playbook) {
				const known = playbooks(hub.settings.get().pstackRoot);
				if (!known.length) throw new HubError("invalid", "pstack is not configured, so there are no playbooks; omit playbook");
				if (!known.includes(p.playbook)) throw new HubError("invalid", `unknown playbook "${p.playbook}". Known: ${known.join(", ")}`);
				playbook = p.playbook;
			}
			const related = [...new Set((p.related ?? []).map(taskId))];
			for (const r of related) hub.ledger.mustTask(r);
			const dispatchKey = `${c.session.omp_session_id ?? c.session.id}/${c.agent.id}`;
			const { task, created, where } = await hub.dispatchTask({ title: p.title, workspace: ws, checkout: p.checkout, playbook, brief: p.brief, related, dispatchKey });
			if (!created) return { text: `Already dispatched ${task.id} (${task.title}) from this dispatcher; use home_send for follow-ups.`, details: { taskId: task.id } };
			return {
				text: `${task.id} pending · ${ws.id} · ${where}${playbook ? ` · playbook ${playbook}` : ""}\nThe hub prepares the checkout, environment and a fresh session now; the home agent is notified when the worker reports. Do not call home_dispatch again.`,
				details: { taskId: task.id },
			};
		},

		home_send(p, c) {
			const r = hub.sendToTask({ taskId: taskId(p.task), text: p.text, mode: p.mode ?? "next", decision: p.decision ?? null, dedupe: `call:${c.callId}` });
			return { text: r.text, details: { taskId: p.task, decision: r.decision } };
		},

		home_decide(p, c) {
			const task = p.task ? hub.ledger.mustTask(taskId(p.task)) : null;
			let reverts: string | null = null;
			if (p.reverts) {
				try {
					reverts = parseDecisionId(p.reverts.trim());
				} catch (err) {
					if (err instanceof IdError) throw new HubError("invalid", `${err.message}; decision ids look like D-3`);
					throw err;
				}
			}
			const d = hub.ledger.logDecision({ taskId: task?.id ?? null, summary: p.decision, why: p.why, revert: p.revert, reverts, dedupeKey: `call:${c.callId}`, actor: "main" });
			hub.indexer.decision(d, task?.workspace_id ?? null);
			hub.changed("decisions", task ? `task:${task.id}` : "tasks");
			return { text: `${d.id} recorded${task ? ` for ${task.id}` : ""}${reverts ? ` (reverts ${reverts})` : ""}.`, details: { decision: d.id } };
		},

		home_escalate(p) {
			const { escalation, created, started } = hub.escalate(taskId(p.task), p.reason, "main");
			return {
				text: `${escalation.id} ${created ? "opened" : "already open"} · ${escalation.session_id} shown to the human${started ? "" : " (its worker could not start now: every slot is busy)"}. The human answers in that terminal; you get a notice when they do.`,
				details: { escalation: escalation.id },
			};
		},

		home_close(p, c) {
			const id = taskId(p.task);
			if (p.outcome === "done") {
				const d = hub.acceptTask(id, p.reason, `call:${c.callId}`);
				return { text: `${id} closed as done · ${d.id} logged.`, details: { decision: d.id } };
			}
			const d = hub.cancelTask(id, "main", p.reason, `call:${c.callId}`);
			return { text: `${id} cancelled; the worker's run was aborted${d ? ` · ${d.id} logged` : ""}.`, details: { decision: d?.id ?? null } };
		},

		home_report(p, c) {
			const task = hub.ledger.latestForSession(c.session.id);
			if (!task) throw new HubError("not_found", "this session has no task");
			const r = hub.ledger.apply(task.id, { kind: "reported", status: p.status, summary: p.summary, details: p.details ?? null }, "worker", `call:${c.callId}`);
			hub.indexer.report(task, `${task.id}#${c.callId}`, Date.now(), p.details ? `${p.summary}\n${p.details}` : p.summary);
			hub.afterApply(task.id, r);
			const text = p.status === "progress" ? `Progress recorded for ${task.id}. Continue working, and report again before ending the turn.` : `Recorded for ${task.id} (${p.status}). End your turn now.`;
			return { text };
		},

		async home_env(p, c) {
			const ws = hub.workspaces.must(c.session.workspace_id!);
			const wt = c.session.worktree_id ? (hub.worktrees.get(c.session.worktree_id) ?? null) : null;
			let note = "";
			if (p.repair) {
				const recipe = hub.workspaces.loadRecipe(ws.id);
				const job = wt ? hub.env.ensure(wt.id, { force: true }) : recipe.status === "ok" ? hub.env.ensureServices(ws, recipe.recipe) : Promise.resolve();
				const outcome = await Promise.race([
					job.then(
						() => "Repair finished.",
						err => `Repair failed: ${err instanceof EnvError ? err.message : errorText(err)}`,
					),
					sleep(REPAIR_WAIT_MS, "Repair is still running; call home_env({}) again in a minute.", { ref: false }),
				]);
				note = `${outcome}\nValues exported at session start do not change in your shell; use the values below and restart your servers if they changed.\n`;
			}
			return { text: `${note}${hub.env.describe(ws, wt)}` };
		},

		async home_lease(p, c) {
			const r = await hub.env.leaseAccount(c.session.id, c.session.workspace_id!, p.pool);
			const fields = Object.entries(r.fields).map(([k, v]) => `  ${k}: ${v}`);
			return {
				text: `Leased ${r.item} from ${p.pool} until ${fmtTime(r.lease.expires_at!)} UTC (released automatically when this turn ends):\n${fields.join("\n")}`,
				details: { lease: r.lease.id, item: r.item },
			};
		},
	};

	return async (session, frame) => {
		const fail = (code: string, message: string): CallResult => ({ t: "result", callId: frame.callId, ok: false, code, message });
		if (!(frame.tool in TOOL_SPECS)) return fail("invalid", `unknown tool ${frame.tool}`);
		const name = frame.tool as ToolName;
		const spec = TOOL_SPECS[name];
		const audience = audienceOf(session.kind, frame.agent);
		if (!(spec.audience as readonly Audience[]).includes(audience)) {
			if (name === "home_dispatch") return fail("forbidden", 'home_dispatch is only callable by the dispatcher subagent. Spawn task({ agent: "dispatcher", … }).');
			return fail("forbidden", `${name} is not available to ${audience} (allowed: ${spec.audience.join(", ")})`);
		}
		const parsed = spec.params.safeParse(frame.params);
		if (!parsed.success) return fail("invalid", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
		try {
			const handler = h[name] as (p: unknown, c: CallContext) => ToolResult | Promise<ToolResult>;
			const result = await handler(parsed.data, { session, audience, agent: frame.agent, callId: frame.callId });
			return { t: "result", callId: frame.callId, ok: true, text: result.text, details: result.details };
		} catch (err) {
			if (err instanceof HubError) return fail(err.code, err.message);
			if (err instanceof IdError) return fail("invalid", err.message);
			hub.log(`tool ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			return fail("internal", errorText(err));
		}
	};
}
