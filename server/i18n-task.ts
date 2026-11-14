import type { WaitKind } from "../shared/api.ts";
import type { StopReason } from "../shared/bridge-wire.ts";
import type { CheckoutSpec } from "../shared/tools.ts";
import type { EscalationResolution, ProvisionStep, ReportStatus } from "./core/task.ts";
import { defineMessages, type Message, render } from "./i18n.ts";

const checkoutKinds: Record<CheckoutSpec["kind"], string> = { worktree: "工作树", continue: "沿用工作树", readonly: "只读" };
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
	created: (workspace: string, checkout: CheckoutSpec["kind"], playbook: string | null) => `created in ${workspace} (${checkout}${playbook ? `, playbook ${playbook}` : ""})`,
	checkedOut: (worktree: string, branch: string, path: string) => `worktree ${worktree} on ${branch} at ${path}`,
	provisioned: (session: string, reused: boolean) => `${reused ? "reusing" : "new"} session ${session}`,
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
	cleanedUp: () => "environment torn down and worktree removed",
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
	created: (workspace, checkout, playbook) => `已在 ${workspace} 创建（${checkoutKinds[checkout]}${playbook ? `，执行方案 ${playbook}` : ""}）`,
	checkedOut: (worktree, branch, path) => `工作树 ${worktree}，分支 ${branch}，路径 ${path}`,
	provisioned: (session, reused) => `${reused ? "沿用" : "新建"}会话 ${session}`,
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
	cleanedUp: () => "环境已清理，工作树已移除",
	waitAborted: () => "运行已中止。",
	waitFailed: () => "运行失败。",
	waitNoFinal: () => "（无最终回复）",
	waitProgress: (summary, text) => `进展汇报：${summary}\n\n最终回复：${render(text, "zh")}`,
	waitProvision: (step, detail) => `${provisionSteps[step]}：${render(detail, "zh")}`,
	waitApproval: (tool, summary) => `${tool}：${summary}`,
	autoEscalation: (kind, text) => `${waitKinds[kind]}：${render(text, "zh")}`,
});
