import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import type { RepoInspection, RepoSuggestion } from "../shared/api.ts";
import type { HomePaths } from "./config.ts";
import { parseRecipe } from "./core/recipe.ts";
import { repoRoot, worktreePath } from "./git.ts";

const HEADER_BYTES = 4096;
const HEADERS_PER_DIRECTORY = 4;

function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function inside(dir: string, parent: string): boolean {
	const relative = path.relative(parent, dir);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function realPath(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

export async function discoverRepositories(paths: HomePaths, worktreeRoot: string | null, registeredPaths: string[]): Promise<RepoSuggestion[]> {
	const home = realPath(paths.home);
	const excluded = [paths.data, ...(worktreeRoot ? [worktreeRoot] : registeredPaths.map(repo => path.dirname(worktreePath(repo, "branch", null))))].map(realPath);
	const roots = new Map<string, Promise<string | null>>();
	const result = new Map<string, RepoSuggestion>();
	const rootOf = (cwd: string): Promise<string | null> => {
		const dir = realPath(cwd);
		let pending = roots.get(dir);
		if (!pending) {
			pending = (async () => {
				if (excluded.some(p => inside(dir, p))) return null;
				const root = await repoRoot(dir).then(realPath, () => null);
				return root && root !== home && !excluded.some(p => inside(root, p)) ? root : null;
			})();
			roots.set(dir, pending);
		}
		return pending;
	};
	const add = (root: string, source: RepoSuggestion["source"], count: number, lastUsedAt: number | null, lastTitle: string | null) => {
		const previous = result.get(root);
		if (previous) {
			previous.ompSessions += count;
			if (source === "home") previous.source = "home";
			if ((lastUsedAt ?? 0) > (previous.lastUsedAt ?? 0)) {
				previous.lastUsedAt = lastUsedAt;
				previous.lastTitle = lastTitle;
			}
		} else {
			result.set(root, { path: root, name: path.basename(root), source, ompSessions: count, lastUsedAt, lastTitle, registeredAs: null });
		}
	};
	const candidates = new Set(Array.from(readText(paths.agents).matchAll(/(?:^|[\s`'"(\[<:：])(\/[^\s`'"()\[\]<>,;，。、]+)/g), m => m[1]!.replace(/[.:)/]+$/, "")));
	for (const candidate of candidates) {
		const root = await rootOf(candidate);
		if (root) add(root, "home", 0, null, null);
	}
	const store = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "sessions");
	let directories: fs.Dirent[];
	try {
		directories = fs.readdirSync(store, { withFileTypes: true }).filter(d => d.isDirectory());
	} catch {
		return [...result.values()];
	}
	const scanDirectory = async (directory: fs.Dirent): Promise<void> => {
		const dir = path.join(store, directory.name);
		let files: { file: string; modified: number }[];
		try {
			files = fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith(".jsonl")).flatMap(f => {
				const file = path.join(dir, f.name);
				try {
					return [{ file, modified: fs.statSync(file).mtimeMs }];
				} catch {
					return [];
				}
			}).sort((a, b) => b.modified - a.modified);
		} catch {
			return;
		}
		for (const file of files.slice(0, HEADERS_PER_DIRECTORY)) {
			let fd: number | undefined;
			let text: string;
			try {
				fd = fs.openSync(file.file, "r");
				const buffer = Buffer.allocUnsafe(HEADER_BYTES);
				text = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, HEADER_BYTES, 0));
			} catch {
				continue;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
			let cwd: string | null = null;
			let title: string | null = null;
			for (const line of text.split("\n").slice(0, 2)) {
				try {
					const header: unknown = JSON.parse(line);
					if (!header || typeof header !== "object") continue;
					if ("type" in header && header.type === "title" && "title" in header && typeof header.title === "string") title = header.title;
					if ("type" in header && header.type === "session" && "cwd" in header && typeof header.cwd === "string" && path.isAbsolute(header.cwd)) cwd = header.cwd;
				} catch {
					// An in-progress or oversized header must not hide the other sessions.
				}
			}
			if (!cwd) continue;
			const root = await rootOf(cwd);
			if (!root) continue;
			// Directory names lose cwd information; headers identify the cwd, filenames supply the count.
			add(root, "omp", files.length, file.modified, title);
			return;
		}
	};
	for (let i = 0; i < directories.length; i += 8) await Promise.all(directories.slice(i, i + 8).map(scanDirectory));
	return [...result.values()];
}

export function detectCommands(root: string): Pick<RepoInspection, "stack" | "commands" | "recipeDraft"> {
	const stack: string[] = [];
	const install: string[] = [];
	const test: string[] = [];
	let dev: string | null = null;
	const has = (file: string) => fs.existsSync(path.join(root, file));
	if (has("package.json")) {
		let manifest: { scripts?: Record<string, unknown>; packageManager?: string } = {};
		try {
			const value: unknown = JSON.parse(readText(path.join(root, "package.json")));
			if (value && typeof value === "object") {
				if ("scripts" in value && value.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts)) manifest.scripts = value.scripts as Record<string, unknown>;
				if ("packageManager" in value && typeof value.packageManager === "string") manifest.packageManager = value.packageManager;
			}
		} catch {
			// Invalid manifests cannot provide script names, but their lockfile still identifies the toolchain.
		}
		const declared = manifest.packageManager?.split("@")[0];
		const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm" : declared && ["pnpm", "yarn", "npm", "bun"].includes(declared) ? declared : "npm";
		stack.push(manager, "node");
		install.push(`${manager} install`);
		if (typeof manifest.scripts?.test === "string" && manifest.scripts.test.trim()) test.push(`${manager} ${manager === "npm" ? "test" : "run test"}`);
		if (typeof manifest.scripts?.dev === "string" && manifest.scripts.dev.trim()) dev = `${manager} run dev`;
	}
	if (has("Cargo.toml")) {
		stack.push("cargo");
		install.push("cargo fetch");
		test.push("cargo test");
	}
	if (has("go.mod")) {
		stack.push("go");
		install.push("go mod download");
		test.push("go test ./...");
	}
	if (has("pyproject.toml")) {
		const pyproject = readText(path.join(root, "pyproject.toml"));
		const manager = has("uv.lock") || /\[tool\.uv(?:\.|\])/.test(pyproject) ? "uv" : has("poetry.lock") || /\[tool\.poetry(?:\.|\])/.test(pyproject) ? "poetry" : null;
		stack.push(...(manager ? [manager, "python"] : ["python"]));
		install.push(manager === "uv" ? "uv sync" : manager === "poetry" ? "poetry install" : "python -m pip install -e .");
		if (/\bpytest\b/.test(pyproject) || has("pytest.ini") || has("conftest.py")) test.push(manager ? `${manager} run pytest` : "python -m pytest");
	}
	const makefile = ["GNUmakefile", "makefile", "Makefile"].find(has);
	if (makefile && /^(?:test|test[ \t]+[^:\n]+)[ \t]*:/m.test(readText(path.join(root, makefile)))) {
		stack.push("make");
		if (!test.length) test.push("make test");
	}
	const commands = { install: install.join(" && ") || null, test: test.join(" && ") || null, dev };
	let recipeDraft: string | null = null;
	if (commands.install || commands.test || commands.dev) {
		const draft = stringify({ version: 1, ...(dev ? { ports: ["web"], env: { PORT: "{port.web}" } } : {}), ...(commands.install ? { setup: [commands.install] } : {}), ...(commands.test ? { test: { full: commands.test } } : {}) });
		const parsed = parseRecipe(draft);
		if (!parsed.ok) throw new Error(`Detected recipe is invalid: ${JSON.stringify(parsed.errors)}`);
		recipeDraft = draft;
	}
	return { stack, commands, recipeDraft };
}
