import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Language } from "../shared/api.ts";
import { HubError } from "./errors.ts";
import { messages, render } from "./i18n.ts";

const run = promisify(execFile);

export async function pickFolder(options: { title?: string; defaultPath?: string }, language: Language): Promise<{ path: string | null }> {
	if (process.platform !== "darwin") throw new HubError("not_implemented", messages.folderPickerUnsupported());
	const prompt = JSON.stringify(options.title ?? render(messages.chooseRepositoryFolder(), language));
	const location = options.defaultPath ? ` default location (POSIX file ${JSON.stringify(options.defaultPath)})` : "";
	try {
		const { stdout } = await run("osascript", ["-e", "activate", "-e", "with timeout of 3600 seconds", "-e", `POSIX path of (choose folder with prompt ${prompt}${location})`, "-e", "end timeout"], { timeout: 0 });
		return { path: path.resolve(stdout.replace(/\r?\n$/, "")) };
	} catch (err) {
		const error = err as { code?: number; stderr?: string };
		if (error.code === 1 && /\(-128\)/.test(error.stderr ?? "")) return { path: null };
		throw new HubError("unavailable", messages.folderPickerFailed());
	}
}
