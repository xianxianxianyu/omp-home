import { defineMessages, type Message } from "./i18n.ts";

/** Hub-authored validation and setup text shown in the UI: settings, setup preview, workspaces and env recipes. */
const en = {
	invalidSettings: () => "invalid settings",
	notPstackRoot: () => "not a pstack root: skills/poteto-mode/SKILL.md is missing",
	portRangeTooSmall: () => "the range needs at least 10 ports",
	absolutePath: () => "must be an absolute path",

	homeNotAbsolute: () => "home path must be absolute",
	gitignoreReason: (line: string) => `add ${line}: hub database, transcripts and logs stay out of git`,
	sectionReason: (heading: string, reason: Message) => `section "${heading}": ${reason.en}`,
	backupPath: (path: string) => `.omp-home/backup/<setup time>/${path}`,
	backupReason: (path: string) => `previous ${path}`,

	noWorkspace: (id: string, known: readonly string[]) => `no workspace "${id}"${known.length ? `; known: ${known.join(", ")}` : ""}`,
	invalidWorkspace: () => "invalid workspace",
	invalidWorkspacePatch: () => "invalid workspace patch",
	pathMissing: (path: string) => `${path} does not exist`,
	doesNotExist: () => "does not exist",
	notInGitRepo: (path: string) => `${path} is not inside a git repository`,
	notGitRepo: () => "not a git repository",
	repoTaken: (root: string, id: string) => `${root} is already workspace "${id}"`,
	workspaceIdTaken: (id: string) => `workspace id "${id}" is taken`,
	workspaceOpenTasks: (id: string, count: number) => `workspace "${id}" has ${count} open ${count === 1 ? "task; close it" : "tasks; close them"} first`,
	invalidRecipe: () => "invalid recipe",

	recipeName: () => "use letters, digits, - and _",
	envVarName: () => "environment variable names only",
	yamlFailed: (detail: string) => `YAML: ${detail}`,
	yamlSyntax: (line: number | undefined, detail: string) => `${line ? `line ${line}: ` : ""}${detail}`,
	duplicateKey: (line: number | undefined, key: string | undefined) =>
		`${line ? `line ${line}: ` : ""}duplicate key${key ? ` "${key}"` : ""}; each key may appear only once (delete one of them)`,
	duplicatePort: (name: string) => `port name "${name}" is declared twice`,
	unknownVariable: (name: string, available: string) => `unknown variable {${name}}; available here: ${available}`,
	variableUnavailable: (key: string) => `{${key}} is not available in this context`,
};

export const validationMessages = defineMessages(en, {
	invalidSettings: () => "设置无效",
	notPstackRoot: () => "不是 pstack 根目录：缺少 skills/poteto-mode/SKILL.md",
	portRangeTooSmall: () => "端口范围至少要包含 10 个端口",
	absolutePath: () => "必须是绝对路径",

	homeNotAbsolute: () => "home 仓库路径必须是绝对路径",
	gitignoreReason: line => `添加 ${line}：中枢数据库、会话记录和日志不纳入 git`,
	sectionReason: (heading, reason) => `「${heading}」一节：${reason.zh}`,
	backupPath: path => `.omp-home/backup/<初始化时间>/${path}`,
	backupReason: path => `原有的 ${path}`,

	noWorkspace: (id, known) => `没有仓库「${id}」${known.length ? `；已有：${known.join("、")}` : ""}`,
	invalidWorkspace: () => "仓库信息无效",
	invalidWorkspacePatch: () => "仓库修改无效",
	pathMissing: path => `${path} 不存在`,
	doesNotExist: () => "不存在",
	notInGitRepo: path => `${path} 不在 git 仓库内`,
	notGitRepo: () => "不是 git 仓库",
	repoTaken: (root, id) => `${root} 已是仓库「${id}」`,
	workspaceIdTaken: id => `仓库 ID「${id}」已被占用`,
	workspaceOpenTasks: (id, count) => `仓库「${id}」还有 ${count} 个未结束的任务，结束后再归档`,
	invalidRecipe: () => "环境配方无效",

	recipeName: () => "只能使用字母、数字、- 和 _",
	envVarName: () => "只能使用环境变量名",
	yamlFailed: detail => `YAML 解析失败：${detail}`,
	yamlSyntax: (line, detail) => `${line ? `第 ${line} 行：` : ""}${detail}`,
	duplicateKey: (line, key) => `${line ? `第 ${line} 行：` : ""}${key ? `键「${key}」` : "键"}重复；每个键只能出现一次（删掉其中一个）`,
	duplicatePort: name => `端口名「${name}」声明了两次`,
	unknownVariable: (name, available) => `未知变量 {${name}}；此处可用：${available}`,
	variableUnavailable: key => `{${key}} 在此处不可用`,
});

/**
 * Setup preview reasons for templates/home/manifest.json, keyed by entry path. The manifest's own `reason` is the
 * fallback for entries missing here; the template files themselves are model-facing and stay untranslated.
 */
const manifestReasons = defineMessages(
	{
		"AGENTS.md": () => "Switches to the omp-home workflow: the main chat routes work, workers use worktrees, decisions can be reverted. The rest of the repo list stays.",
		".agents/skills/repo-worktree": () => "The hub manages every worktree; the old mw_worktree and manual scripts are removed.",
		".agents/skills/task-brief": () => "The dispatcher fills in the brief read-only and dispatches it once; the main chat no longer writes briefs.",
		".agents/skills/test-env": () => "Test environments move to repos/<workspace>.env.yaml; the hub manages services, ports, databases and account leases.",
		"repos/_example.env.yaml": () => "A complete example environment recipe; an existing file is never overwritten.",
	},
	{
		"AGENTS.md": () => "改为 omp-home 的工作方式：主对话分派工作，执行者在工作树中干活，决定可以撤回。其余仓库清单保留。",
		".agents/skills/repo-worktree": () => "工作树统一交给中枢管理，移除旧的 mw_worktree 和手工脚本。",
		".agents/skills/task-brief": () => "调度器以只读方式补全任务说明后一次派发，主对话不再撰写任务说明。",
		".agents/skills/test-env": () => "测试环境改用 repos/<workspace>.env.yaml，由中枢管理服务、端口、数据库和账号租约。",
		"repos/_example.env.yaml": () => "提供完整的环境配方示例，不覆盖已有文件。",
	},
);
const reasonsByPath = new Map<string, () => Message>(Object.entries(manifestReasons));

export function manifestReason(path: string): Message | undefined {
	return reasonsByPath.get(path)?.();
}

/** zod `refine` params: fieldErrors renders the issue from `params.message` in either language. */
export function localizedCheck(message: Message): { error: string; params: { message: Message } } {
	return { error: message.en, params: { message } };
}
