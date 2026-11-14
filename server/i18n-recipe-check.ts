import { defineMessages } from "./i18n.ts";

const en = {
	alreadyRunning: (workspace: string) => `A recipe check is already running for ${workspace}.`,
	invalidRecipe: (workspace: string) => `Save a valid environment recipe for ${workspace} before checking it.`,
	unknownTest: (name: string) => `The recipe has no test named ${name}.`,
	commandFailed: (code: number) => `Command failed (exit ${code}).`,
	interrupted: () => "The hub stopped during this check.",
	cleanupPending: () => "The previous recipe check could not be cleaned up. Restart the hub to retry cleanup before starting another check.",
};

export const recipeCheckMessages = defineMessages(en, {
	alreadyRunning: workspace => `${workspace} 的环境配方正在试跑。`,
	invalidRecipe: workspace => `请先为 ${workspace} 保存有效的环境配方，再试跑。`,
	unknownTest: name => `环境配方中没有名为 ${name} 的检查。`,
	commandFailed: code => `命令失败（退出码 ${code}）。`,
	interrupted: () => "此次试跑期间中枢停止了。",
	cleanupPending: () => "上次配方试跑未能完成清理。请重启中枢以重试清理，再发起新的试跑。",
});
