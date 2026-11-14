import { BRANCH_TYPES } from "../shared/tools.ts";
import { defineMessages } from "./i18n.ts";

const en = {
	notNewBranch: (name: string) => `"${name}" is not a new-branch name: use <${BRANCH_TYPES.join("|")}>/<kebab-slug>, e.g. "fix/cart-discount"`,
	invalidBranch: (name: string) => `"${name}" is not a valid branch name`,
	baseBranch: (name: string) => `${name} is the base branch; code changes need their own branch`,
	baseForExisting: (name: string) => `base applies only to new branches; ${name} already exists`,
	unknownBase: (base: string) => `base ${base} does not exist in the repository`,
	branchOpen: (task: string, status: string, branch: string) => `${task} is open (${status}) on ${branch}: home_send ${task}, or close it first`,
	branchMerged: (branch: string, base: string) => `${branch} is already merged into ${base}; start a new branch`,
	branchRetiring: (branch: string) => `${branch} is being removed; start a new branch`,
	branchGone: (branch: string) => `${branch} was deleted outside omp-home; start a new branch`,
	branchInMainCheckout: (branch: string) => `${branch} is checked out in the main checkout; the human switches it away first, or use a new branch`,
	worktreeSwitched: (dir: string, actual: string | null, expected: string) => `${dir} is a worktree on ${actual ?? "detached HEAD"}, not ${expected}`,
	noWorktree: (id: string) => `no worktree ${id}`,
	worktreeRetired: (id: string, branch: string) => `worktree ${id} (${branch}) was retired`,
	busy: (task: string, status: string) => `${task} is still ${status} on this branch; wait for it or cancel it first`,
	sessionBusy: (session: string) => `${session} is running a turn; wait for it to finish`,
	unlockFirst: (branch: string) => `${branch} is kept; turn off Keep first`,
	notPresent: (branch: string) => `${branch} has no worktree on disk`,
	dirtyFiles: (count: number) => `${count} uncommitted ${count === 1 ? "file" : "files"}`,
	checkedOutOn: (branch: string | null) => (branch ? `checked out on ${branch}` : "detached HEAD"),
	checkedOutIn: (dir: string) => `checked out in ${dir}`,
	notAccepted: (task: string, status: string) => `${task} is ${status}, not accepted`,
	inFlight: (task: string, status: string) => `${task} is ${status}`,
	running: (session: string) => `${session} is running a turn`,
	branchMoved: (branch: string) => `${branch} got new commits while it was being removed`,
};

const states: Record<string, string> = { pending: "排队中", working: "进行中", done: "已完成", cancelled: "已取消" };
const zhStatus = (status: string) => states[status] ?? (status.startsWith("awaiting") ? "等待处理" : status);

export const worktreeMessages = defineMessages(en, {
	notNewBranch: name => `「${name}」不是新分支名：使用 <${BRANCH_TYPES.join("|")}>/<kebab-slug>，例如 "fix/cart-discount"`,
	invalidBranch: name => `「${name}」不是有效的分支名`,
	baseBranch: name => `${name} 是基准分支；代码改动需要自己的分支`,
	baseForExisting: name => `base 只用于新分支；${name} 已存在`,
	unknownBase: base => `仓库中没有基准 ${base}`,
	branchOpen: (task, status, branch) => `${task} 仍在 ${branch} 上（${zhStatus(status)}）：用 home_send ${task}，或先关闭它`,
	branchMerged: (branch, base) => `${branch} 已合并到 ${base}；请开新分支`,
	branchRetiring: branch => `${branch} 正在移除；请开新分支`,
	branchGone: branch => `${branch} 已在 omp-home 之外删除；请开新分支`,
	branchInMainCheckout: branch => `${branch} 正检出在主目录中；先由你切换到其他分支，或使用新分支`,
	worktreeSwitched: (dir, actual, expected) => `${dir} 是${actual === null ? "处于分离 HEAD 状态" : `位于分支 ${actual}`}的工作树，并非位于分支 ${expected}`,
	noWorktree: id => `找不到工作树 ${id}`,
	worktreeRetired: (id, branch) => `工作树 ${id}（${branch}）已回收`,
	busy: (task, status) => `${task} 仍在此分支上（${zhStatus(status)}）；等它结束或先取消`,
	sessionBusy: session => `${session} 正在执行一轮任务；等本轮结束`,
	unlockFirst: branch => `${branch} 已保留；先关闭「保留」`,
	notPresent: branch => `${branch} 在磁盘上没有工作树`,
	dirtyFiles: count => `${count} 个未提交的文件`,
	checkedOutOn: branch => (branch ? `已切换到 ${branch}` : "处于分离 HEAD 状态"),
	checkedOutIn: dir => `检出在 ${dir}`,
	notAccepted: (task, status) => `${task} ${zhStatus(status)}，尚未验收`,
	inFlight: (task, status) => `${task} ${zhStatus(status)}`,
	running: session => `${session} 正在执行`,
	branchMoved: branch => `移除期间 ${branch} 有了新提交`,
});
