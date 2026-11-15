import type { IncomingHttpHeaders } from "node:http";
import { LANGUAGE_HEADER, type Language } from "../shared/api.ts";

export interface Message {
	readonly en: string;
	readonly zh: string;
}

type Templates = Record<string, (...args: never[]) => string>;
type Translations<E extends Templates> = { [K in keyof E]: (...args: Parameters<E[K]>) => string };
type Messages<E extends Templates> = { [K in keyof E]: (...args: Parameters<E[K]>) => Message };

export function defineMessages<E extends Templates>(en: E, zh: Translations<E>): Messages<E> {
	const english = en as Translations<E>;
	const result = {} as Messages<E>;
	for (const key in en) {
		result[key] = (...args: Parameters<E[typeof key]>) => ({ en: english[key](...args), zh: zh[key](...args) });
	}
	return result;
}

export function render(message: Message | string, language: Language = "en"): string {
	return typeof message === "string" ? message : message[language];
}

export function languageFromHeader(headers: IncomingHttpHeaders): Language {
	return headers[LANGUAGE_HEADER] === "zh" ? "zh" : "en";
}

export function languageFromUrl(url: URL): Language {
	return url.searchParams.get("lang") === "zh" ? "zh" : "en";
}

/** Owned by one hub's UI channel, never used to choose a model-facing language. */
export class LanguageTracker {
	lastSeen: Language = "en";

	observe(language: Language): void {
		this.lastSeen = language;
	}
}

const en = {
	badRequest: () => "bad request",
	chooseRepositoryFolder: () => "Choose a repository folder",
	folderPickerUnsupported: () => "The folder picker is only available on macOS. Enter the folder path instead.",
	folderPickerFailed: () => "Could not open the folder picker. Try again or enter the folder path.",
	forbiddenHost: () => "forbidden host",
	unauthorized: () => "missing or wrong token; open the URL the hub printed at startup",
	noRoute: (method: string, pathname: string) => `no route ${method} ${pathname}`,
	setupRequired: () => "omp-home is not set up yet: choose a home repo first (POST /api/setup)",
	uiNotBuilt: () => "omp-home UI is not built. Run `pnpm build`, then reload.",
	statusFilter: (values: string) => `status must be one of ${values}`,
	chatRecordId: (key: string) => `${key} must be a chat record id`,
	oneChatCursor: () => "pass before or after, not both",
	mainEviction: () => "the main chat is not evicted; use Restart main",
	mainRetirement: () => "retire the main chat with New chat",
	openTask: (session: string, task: string) => `${session} has open task ${task}; close it first`,
	historyCursor: () => "pass before=<id of the first item you hold>",
	serviceAction: (action: string) => `no service action ${action}`,
	leaseId: () => "lease ids are numbers",
	bodyTooLarge: () => "request body too large",
	bodyNotJson: () => "request body is not JSON",
	invalidId: (kind: string, value: string) => `invalid ${kind}: ${value}`,
	noMain: () => "no main chat",
	noSession: (id: string) => `no session ${id}`,
	sessionRetired: (id: string) => `session ${id} is retired`,
	retired: (id: string) => `${id} is retired`,
	workerCapacity: (count: number) => `all ${count} worker slots are busy and none is idle; evict a worker or raise the live cap`,
	startFailed: (id: string, detail: Message | string) => `${id} could not start: ${render(detail)}`,
	cwdMissing: (cwd: string) => `working directory ${cwd} is missing`,
	exitedEarly: (id: string) => `${id} exited before it was ready`,
	stopped: (id: string) => `${id} was stopped`,
	notRunning: (id: string) => `${id} is not running`,
	startTimeout: (id: string, seconds: number) => `${id} did not finish starting within ${seconds}s`,
	busySession: (id: string) => `${id} is running a turn; cancel its task or wait for the turn to end`,
	mainFailed: (count: number, dir: string) => `The main chat exited ${count} times in 5 minutes; automatic restarts stopped. Check ${dir} and use Restart main.`,
	taskSetup: (id: string) => `${id} is still being set up; its brief is delivered first. Send follow-ups after its first report.`,
	taskRetired: (task: string, session: string) => `${task}'s session ${session} has ended (its worktree was removed or a newer task took the branch); dispatch a new task instead`,
	otherTask: (session: string, task: string) => `${session} now works on ${task}; send to ${task} instead`,
	abortRefused: (detail: Message | string) => `omp refused abort: ${render(detail)}`,
	editRunning: (id: string) => `${id} is running a turn; stop it first`,
	rewindBusy: (id: string) => `${id} is already being rewound`,
	rewindCancelled: (id: string) => `an extension in ${id} cancelled the rewind`,
	noMessage: (item: string, session: string) => `no message ${item} in ${session}; reload the session`,
	notYourMessage: (item: string) => `${item} was not sent by you; only your own messages can be edited`,
	nothingToRetry: (id: string) => `${id} has no message of yours to retry`,
	retryImages: () => "the last message has images, which cannot be sent again; edit it and attach them again",
	messageNotInOmp: (id: string) => `omp's history of ${id} no longer has this message; reload the session`,
	answerMismatch: (method: string) => `that answer does not fit a ${method} request`,
	subagentStopped: (id: string) => `subagent ${id} is not running`,
	taskDone: (id: string) => `${id} is already done`,
	taskCancelled: (id: string) => `${id} is cancelled`,
	noWorker: (id: string) => `${id} has no worker session yet`,
	needsAttention: (task: string) => `omp-home · ${task} needs you`,
	hubRestarted: () => "the hub restarted while this run was in progress",
	workerStopped: () => "the hub stopped the worker during a run",
	workerExited: (code: number) => `omp exited unexpectedly (code ${code})`,
	spawnExited: (code: number, detail: Message | string) => `omp exited before connecting to the hub (exit ${code})${render(detail) ? `: ${render(detail)}` : ""}`,
	cancelledDecision: (task: string) => `Cancelled ${task}`,
	resumeDecision: (task: string) => `Dispatch a new task to resume ${task}'s work (the same branch name for code changes)`,
	acceptedDecision: (task: string) => `Accepted ${task} as done`,
	reopenDecision: (task: string) => `home_send ${task} with what is missing to reopen it`,
	cancelledDefault: () => "cancelled by the human",
	answeredDecision: (task: string, text: string) => `Answered ${task}: ${text}`,
	databaseVersion: (version: string | null, supported: string) => `home.db has schema version ${version ?? "none"}; this hub supports ${supported}`,
	sqliteUnsupported: (detail: string) => `This Node build's SQLite lacks FTS5 with the trigram tokenizer (needed for search, including Chinese). Use Node 26+ from nodejs.org. (${detail})`,
};

const idKinds: Record<string, string> = { "workspace id": "仓库 ID", "task id": "任务 ID", "session id": "会话 ID", "worktree id": "工作树 ID", "decision id": "决定 ID", "escalation id": "请示 ID" };

export const messages = defineMessages(en, {
	badRequest: () => "请求无效",
	chooseRepositoryFolder: () => "选择仓库文件夹",
	folderPickerUnsupported: () => "文件夹选择器仅支持 macOS。也可以直接输入文件夹路径。",
	folderPickerFailed: () => "无法打开文件夹选择器。重试或直接输入文件夹路径。",
	forbiddenHost: () => "不允许访问此主机",
	unauthorized: () => "访问令牌缺失或错误；打开中枢启动时显示的链接",
	noRoute: (method, pathname) => `找不到接口 ${method} ${pathname}`,
	setupRequired: () => "omp-home 尚未设置：先选择 home 仓库（POST /api/setup）",
	uiNotBuilt: () => "omp-home 界面尚未构建。运行 `pnpm build`，然后刷新。",
	statusFilter: values => `status 必须是以下值之一：${values}`,
	chatRecordId: key => `${key} 必须是聊天记录 ID`,
	oneChatCursor: () => "before 和 after 只能传入一个",
	mainEviction: () => "不能移出主对话；使用「重启主对话」",
	mainRetirement: () => "使用「新建对话」结束当前主对话",
	openTask: (session, task) => `${session} 仍有未结束的任务 ${task}；先结束该任务`,
	historyCursor: () => "传入 before=<当前第一条记录的 ID>",
	serviceAction: action => `没有服务操作 ${action}`,
	leaseId: () => "租约 ID 必须是数字",
	bodyTooLarge: () => "请求内容过大",
	bodyNotJson: () => "请求内容不是 JSON",
	invalidId: (kind, value) => `${idKinds[kind] ?? kind} 无效：${value}`,
	noMain: () => "没有主对话",
	noSession: id => `找不到会话 ${id}`,
	sessionRetired: id => `会话 ${id} 已结束`,
	retired: id => `${id} 已结束`,
	workerCapacity: count => `${count} 个执行者名额都在使用中，暂无空闲执行者；停止一个执行者，或提高运行数量上限`,
	startFailed: (id, detail) => `${id} 无法启动：${render(detail, "zh")}`,
	cwdMissing: cwd => `工作目录 ${cwd} 不存在`,
	exitedEarly: id => `${id} 在就绪前退出了`,
	stopped: id => `${id} 已停止`,
	notRunning: id => `${id} 未运行`,
	startTimeout: (id, seconds) => `${id} 未能在 ${seconds} 秒内完成启动`,
	busySession: id => `${id} 正在执行一轮任务；取消任务或等待本轮结束`,
	mainFailed: (count, dir) => `主对话在 5 分钟内退出了 ${count} 次，已停止自动重启。检查 ${dir}，然后使用「重启主对话」。`,
	taskSetup: id => `${id} 仍在准备环境，会先发送任务说明。收到首次汇报后再追加消息。`,
	taskRetired: (task, session) => `${task} 的会话 ${session} 已结束（工作树已移除，或分支已交给更新的任务）；改为派发新任务`,
	otherTask: (session, task) => `${session} 正在执行 ${task}；改为发送给 ${task}`,
	abortRefused: detail => `omp 拒绝停止：${render(detail, "zh")}`,
	editRunning: id => `${id} 正在执行一轮任务；先停止`,
	rewindBusy: id => `${id} 正在回退`,
	rewindCancelled: id => `${id} 中的扩展取消了回退`,
	noMessage: (item, session) => `${session} 中没有消息 ${item}；重新加载会话`,
	notYourMessage: item => `${item} 不是你发送的消息；只能编辑自己发送的消息`,
	nothingToRetry: id => `${id} 中没有你发送的消息，无法重试`,
	retryImages: () => "上一条消息带有图片，无法重新发送；编辑这条消息并重新添加图片",
	messageNotInOmp: id => `omp 中 ${id} 的历史已没有这条消息；重新加载会话`,
	answerMismatch: method => `此回答不适用于 ${method} 请求`,
	subagentStopped: id => `子代理 ${id} 未运行`,
	taskDone: id => `${id} 已完成`,
	taskCancelled: id => `${id} 已取消`,
	noWorker: id => `${id} 还没有执行者会话`,
	needsAttention: task => `omp-home · ${task} 待你处理`,
	hubRestarted: () => "本轮执行期间中枢重启了",
	workerStopped: () => "中枢在本轮执行期间停止了执行者",
	workerExited: code => `omp 意外退出（退出码 ${code}）`,
	spawnExited: (code, detail) => `omp 在连接中枢前退出了（退出码 ${code}）${render(detail, "zh") ? `：${render(detail, "zh")}` : ""}`,
	cancelledDecision: task => `已取消 ${task}`,
	resumeDecision: task => `派发新任务继续 ${task} 的工作（代码改动用同一分支名）`,
	acceptedDecision: task => `已将 ${task} 标记为完成`,
	reopenDecision: task => `使用 home_send ${task} 说明尚缺的内容，重新打开任务`,
	cancelledDefault: () => "你取消了任务",
	answeredDecision: (task, text) => `已回复 ${task}：${text}`,
	databaseVersion: (version, supported) => `home.db 的数据库结构版本为 ${version ?? "未设置"}；此中枢支持的版本为 ${supported}`,
	sqliteUnsupported: detail => `此 Node 版本的 SQLite 不支持带 trigram 分词器的 FTS5（搜索功能，包括中文搜索，需要此支持）。使用 nodejs.org 提供的 Node 26 或更新版本。（${detail}）`,
});
