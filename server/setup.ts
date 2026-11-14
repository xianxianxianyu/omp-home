import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SetupPreview } from "../shared/api.ts";
import { homePaths } from "./config.ts";
import { HubError } from "./errors.ts";
import { DEFAULT_PSTACK_ROOT, isPstackRoot } from "./settings.ts";

const entrySchema = z.object({
	path: z.string().min(1),
	source: z.string().min(1),
	action: z.enum(["create", "replace", "section"]),
	reason: z.string(),
	heading: z.string().optional(),
});
type Entry = z.infer<typeof entrySchema>;
type Change = SetupPreview["changes"][number];

const GITIGNORE_LINE = ".omp-home/";

function templatesDir(repoDir: string): string {
	return path.join(repoDir, "templates", "home");
}

function readManifest(repoDir: string): Entry[] {
	const file = path.join(templatesDir(repoDir), "manifest.json");
	if (!fs.existsSync(file)) return [];
	const parsed = z.array(entrySchema).safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
	if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
	for (const e of parsed.data) {
		if (path.isAbsolute(e.path) || e.path.split(/[\\/]/).includes("..")) throw new Error(`${file}: entry path must stay inside the home repo: ${e.path}`);
		if (e.action === "section" && !e.heading) throw new Error(`${file}: section entry ${e.path} needs a heading`);
	}
	return parsed.data;
}

/** True when `a` and `b` have the same files with the same bytes (files or directory trees). */
function sameTree(a: string, b: string): boolean {
	const sa = fs.statSync(a, { throwIfNoEntry: false });
	const sb = fs.statSync(b, { throwIfNoEntry: false });
	if (!sa || !sb || sa.isDirectory() !== sb.isDirectory()) return false;
	if (!sa.isDirectory()) return fs.readFileSync(a).equals(fs.readFileSync(b));
	const la = fs.readdirSync(a).sort();
	const lb = fs.readdirSync(b).sort();
	return la.length === lb.length && la.every((name, i) => name === lb[i] && sameTree(path.join(a, name), path.join(b, name)));
}

/** Locate the markdown block starting at the line equal to `heading` up to the next heading of the same or higher level. */
function findSection(lines: string[], heading: string): { start: number; end: number } | null {
	const level = /^(#+)/.exec(heading)?.[1]?.length ?? 1;
	let inFence = false;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence) continue;
		if (start < 0) {
			if (line.trimEnd() === heading.trimEnd()) start = i;
			continue;
		}
		const m = /^(#+)\s/.exec(line);
		if (m && m[1]!.length <= level) return { start, end: i };
	}
	return start < 0 ? null : { start, end: lines.length };
}

function applySection(current: string, heading: string, section: string): string {
	const lines = current.split("\n");
	const block = section.trimEnd().split("\n");
	const found = findSection(lines, heading);
	if (!found) return `${current.trimEnd()}\n\n${block.join("\n")}\n`;
	const after = lines.slice(found.end);
	return [...lines.slice(0, found.start), ...block, ...(after.length && after[0] !== "" ? [""] : []), ...after].join("\n");
}

function sectionUpToDate(current: string, heading: string, section: string): boolean {
	const lines = current.split("\n");
	const found = findSection(lines, heading);
	return !!found && lines.slice(found.start, found.end).join("\n").trimEnd() === section.trimEnd();
}

function gitignoreNeedsLine(home: string): boolean {
	const file = path.join(home, ".gitignore");
	if (!fs.existsSync(file)) return true;
	return !fs
		.readFileSync(file, "utf8")
		.split("\n")
		.some(l => [".omp-home", ".omp-home/", "/.omp-home", "/.omp-home/"].includes(l.trim()));
}

interface Plan {
	entry: Entry;
	effect: "create" | "replace" | "none";
}

function plan(home: string, repoDir: string): Plan[] {
	return readManifest(repoDir).map(entry => {
		const target = path.join(home, entry.path);
		const source = path.join(templatesDir(repoDir), entry.source);
		const exists = fs.existsSync(target);
		if (!exists) return { entry, effect: "create" };
		if (entry.action === "create") return { entry, effect: "none" };
		if (entry.action === "replace") return { entry, effect: sameTree(source, target) ? "none" : "replace" };
		const upToDate = sectionUpToDate(fs.readFileSync(target, "utf8"), entry.heading!, fs.readFileSync(source, "utf8"));
		return { entry, effect: upToDate ? "none" : "replace" };
	});
}

export function pstackCandidates(home: string): string[] {
	const guesses = [DEFAULT_PSTACK_ROOT, path.resolve(home, "..", "opensource", "cursor-plugins", "harness", "pstack", "claude-code")];
	return [...new Set(guesses)].filter(isPstackRoot);
}

export function previewSetup(homeInput: string, repoDir: string): SetupPreview {
	if (!path.isAbsolute(homeInput)) throw new HubError("invalid", "home path must be absolute");
	const home = path.resolve(homeInput);
	const exists = fs.existsSync(home);
	let isGitRepo = false;
	if (exists) {
		try {
			isGitRepo = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: home, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true";
		} catch {
			isGitRepo = false;
		}
	}
	const changes: Change[] = [];
	if (gitignoreNeedsLine(home)) {
		changes.push({ path: ".gitignore", action: fs.existsSync(path.join(home, ".gitignore")) ? "replace" : "create", reason: `add ${GITIGNORE_LINE}: hub database, transcripts and logs stay out of git` });
	}
	for (const { entry, effect } of plan(home, repoDir)) {
		if (effect === "none") continue;
		const reason = entry.action === "section" ? `section "${entry.heading}": ${entry.reason}` : entry.reason;
		changes.push({ path: entry.path, action: effect, reason });
		if (effect === "replace") changes.push({ path: `.omp-home/backup/<setup time>/${entry.path}`, action: "backup", reason: `previous ${entry.path}` });
	}
	return { homePath: home, exists, isGitRepo, changes, pstackCandidates: pstackCandidates(home) };
}

/**
 * Create the home layout and apply the template manifest. Idempotent: up-to-date
 * entries are skipped. Replacing (only when `migrate` is set) moves the old file or
 * directory to `.omp-home/backup/<timestamp>/` first.
 */
export function applySetup(home: string, repoDir: string, migrate: boolean): void {
	const paths = homePaths(home);
	for (const dir of [home, paths.data, paths.chat, paths.sessions, paths.envLogs, paths.serviceLogs, paths.run, paths.repos]) fs.mkdirSync(dir, { recursive: true });
	if (gitignoreNeedsLine(home)) {
		const file = path.join(home, ".gitignore");
		const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${GITIGNORE_LINE}\n`);
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	for (const { entry, effect } of plan(home, repoDir)) {
		if (effect === "none" || (effect === "replace" && !migrate)) continue;
		const target = path.join(home, entry.path);
		const source = path.join(templatesDir(repoDir), entry.source);
		if (effect === "replace") {
			const backup = path.join(paths.backup, stamp, entry.path);
			fs.mkdirSync(path.dirname(backup), { recursive: true });
			if (entry.action === "section") fs.copyFileSync(target, backup);
			else fs.renameSync(target, backup);
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		if (entry.action === "section" && fs.existsSync(target)) {
			fs.writeFileSync(target, applySection(fs.readFileSync(target, "utf8"), entry.heading!, fs.readFileSync(source, "utf8")));
		} else {
			fs.cpSync(source, target, { recursive: true });
		}
	}
}
