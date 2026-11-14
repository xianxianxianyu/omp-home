import type { WaitKind } from "../shared/api.ts";
import type { StopReason } from "../shared/bridge-wire.ts";
import type { CheckoutSpec } from "../shared/tools.ts";
import type { EscalationResolution, ProvisionStep, ReportStatus } from "./core/task.ts";
import type { RetireReason } from "./core/worktree.ts";
import { defineMessages, type Message, render } from "./i18n.ts";

const retireReasons: Record<RetireReason, string> = { merged: "已合并", unused: "未使用", gone: "分支已删除", discarded: "已丢弃" };
const provisionSteps: Record<ProvisionStep, string> = { checkout: "检出代码", env: "准备环境", session: "启动会话" };
const stopReasons: Record<StopReason, string> = { completed: "已完成", aborted: "已中止", error: "出错" };
const reportStatuses: Record<ReportStatus, string> = { done: "已完成", blocked: "受阻", question: "有疑问", progress: "进展" };
const actors = { main: "主对话", human: "你", hub: "中枢" } as const;
const messageModes = { next: "下轮", now: "立即" } as const;
const resolutions: Record<EscalationResolution, string> = { human_replied: "你已回复", task_moved: "任务已继续", dismissed: "已忽略" };
const waitKinds: Record<WaitKind, string> = {
	question: "有疑问",
	blocked: "受阻",
	no_report: "未提交汇报",
	aborted: "已中止",
	error: "出错",
	approval: "等待审批",
	interrupted: "已中断",
	provision_failed: "准备环境失败",
};

const en = {
	noTask: (id: string) => `no task ${id}`,
	noDecision: (id: string) => `no decision ${id}`,
	noEscalation: (id: string) => `no escalation ${id}`,
	mainEditorBusy: (task: string, workspace: string, status: string) =>
		`${task} is editing ${workspace}'s main checkout (${status}): home_send ${task} to add this, or wait until it is accepted`,
	created: (workspace: string, checkout: CheckoutSpec, playbook: string | null) =>
		`created in ${workspace} (${checkout.lane === "branch" ? `branch ${checkout.branch}` : checkout.edit ? "main checkout, editing" : "main checkout, read-only"}${playbook ? `, playbook ${playbook}` : ""})`,
	checkedOut: (worktree: string, branch: string, path: string) => `worktree ${worktree} on ${branch} at ${path}`,
	provisioned: (session: string) => `worker session ${session}`,
	provisionFailed: (step: ProvisionStep, detail: string | Message) => `provisioning failed at ${step}: ${render(detail)}`,
	provisionRetry: () => "provisioning retried",
	queued: (live: number, cap: number) => `waiting for a worker slot (${live}/${cap} live)`,
	delivered: (what: "brief" | "message", outbox: number) => `${what} delivered (outbox #${outbox})`,
	runStarted: (seq: number) => `run ${seq} started`,
	runEnded: (seq: number, stop: StopReason, error: string | null) => `run ${seq} ended: ${stop}${error ? ` (${error})` : ""}`,
	reported: (status: ReportStatus, summary: string) => `report ${status}: ${summary}`,
	approvalRequested: (tool: string, summary: string) => `approval requested for ${tool}: ${summary}`,
	approvalResolved: (approved: boolean) => approved ? "approved" : "denied",
	humanInput: (text: string) => `human typed: ${text}`,
	messageSent: (by: "main" | "human", mode: "next" | "now", decision: string | null, text: string) => `${by} sent (${mode})${decision ? ` with ${decision}` : ""}: ${text}`,
	processLost: (reason: string | Message) => `process lost: ${render(reason)}`,
	policyBlocked: (tool: string, command: string) => `blocked ${tool}: ${command}`,
	escalated: (id: string, by: "main" | "hub", reason: string | Message) => `${id} opened by ${by}: ${render(reason)}`,
	escalationClosed: (id: string, resolution: EscalationResolution) => `${id} closed: ${resolution}`,
	decided: (id: string, summary: string | Message) => `${id}: ${render(summary)}`,
	accepted: (reason: string) => `accepted as done: ${reason}`,
	cancelled: (by: "main" | "human", reason: string | Message) => `cancelled by ${by}: ${render(reason)}`,
	merged: (branch: string, into: string, sha: string) => `${branch} merged into ${into} by the human (${sha.slice(0, 8)}): accepted`,
	worktreeRetired: (reason: RetireReason, branch: string, sha: string | null, branchDeleted: boolean) =>
		`worktree removed (${reason}); branch ${branch} ${branchDeleted ? `deleted${sha ? ` at ${sha.slice(0, 8)}` : ""}` : reason === "gone" ? "was already deleted" : "kept"}`,
	waitAborted: () => "The run was aborted.",
	waitFailed: () => "The run failed.",
	waitNoFinal: () => "(no final text)",
	waitProgress: (summary: string, text: string | Message) => `Progress report: ${summary}\n\nFinal text: ${render(text)}`,
	waitProvision: (step: ProvisionStep, detail: string | Message) => `${step}: ${render(detail)}`,
	waitApproval: (tool: string, summary: string) => `${tool}: ${summary}`,
	autoEscalation: (kind: WaitKind, text: string | Message) => `${kind}: ${render(text)}`,
};

export const taskMessages = defineMessages(en, {
	noTask: id => `找不到任务 ${id}`,
	noDecision: id => `找不到决定 ${id}`,
	noEscalation: id => `找不到请示 ${id}`,
	mainEditorBusy: (task, workspace) => `${task} 正在编辑 ${workspace} 的主检出目录，同一时间只能有一个编辑任务；等 ${task} 验收后再试`,
	created: (workspace, checkout, playbook) =>
		`已在 ${workspace} 创建（${checkout.lane === "branch" ? `分支 ${checkout.branch}` : checkout.edit ? "主检出目录，可编辑" : "主检出目录，只读"}${playbook ? `，执行方案 ${playbook}` : ""}）`,
	checkedOut: (worktree, branch, path) => `工作树 ${worktree}，分支 ${branch}，路径 ${path}`,
	provisioned: session => `执行者会话 ${session}`,
	provisionFailed: (step, detail) => `${provisionSteps[step]}失败：${render(detail, "zh")}`,
	provisionRetry: () => "已重试准备环境",
	queued: (live, cap) => `等待空闲执行者（已启动 ${live}/${cap}）`,
	delivered: (what, outbox) => `${what === "brief" ? "任务说明" : "消息"}已送达（发件箱 #${outbox}）`,
	runStarted: seq => `第 ${seq} 次运行已开始`,
	runEnded: (seq, stop, error) => `第 ${seq} 次运行已结束：${stopReasons[stop]}${error ? `（${error}）` : ""}`,
	reported: (status, summary) => `汇报（${reportStatuses[status]}）：${summary}`,
	approvalRequested: (tool, summary) => `${tool} 请求审批：${summary}`,
	approvalResolved: approved => approved ? "已批准" : "已拒绝",
	humanInput: text => `你输入了：${text}`,
	messageSent: (by, mode, decision, text) => `${actors[by]}已发送（${messageModes[mode]}）${decision ? `，关联 ${decision}` : ""}：${text}`,
	processLost: reason => `进程已断开：${render(reason, "zh")}`,
	policyBlocked: (tool, command) => `已拦截 ${tool}：${command}`,
	escalated: (id, by, reason) => `${actors[by]}发起了请示 ${id}：${render(reason, "zh")}`,
	escalationClosed: (id, resolution) => `请示 ${id} 已结束：${resolutions[resolution]}`,
	decided: (id, summary) => `${id}：${render(summary, "zh")}`,
	accepted: reason => `已确认完成：${reason}`,
	cancelled: (by, reason) => `${actors[by]}已取消：${render(reason, "zh")}`,
	merged: (branch, into, sha) => `你已将 ${branch} 合并到 ${into}（${sha.slice(0, 8)}），视为验收`,
	worktreeRetired: (reason, branch, sha, branchDeleted) =>
		`工作树已移除（${retireReasons[reason]}）；分支 ${branch} ${branchDeleted ? `已删除${sha ? `，删除前位于 ${sha.slice(0, 8)}` : ""}` : reason === "gone" ? "此前已被删除" : "已保留"}`,
	waitAborted: () => "运行已中止。",
	waitFailed: () => "运行失败。",
	waitNoFinal: () => "（无最终回复）",
	waitProgress: (summary, text) => `进展汇报：${summary}\n\n最终回复：${render(text, "zh")}`,
	waitProvision: (step, detail) => `${provisionSteps[step]}：${render(detail, "zh")}`,
	waitApproval: (tool, summary) => `${tool}：${summary}`,
	autoEscalation: (kind, text) => `${waitKinds[kind]}：${render(text, "zh")}`,
});
