import { execFileSync } from "node:child_process";
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

function objectOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readJsonObject(file: string, comments = false): Record<string, unknown> {
	let text = readText(file);
	if (comments) {
		text = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('"') ? token : " ");
		text = text.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === "," ? "" : token);
	}
	try {
		return objectOf(JSON.parse(text));
	} catch {
		return {};
	}
}

const COPY_FILES = 128;
const COPY_BYTES = 2 * 1024 * 1024;
const COPY_SKIP_DIRECTORIES = ["node_modules", "vendor", "target", "dist", "build", "coverage", ".git", ".next", ".nuxt", ".output", ".venv", "venv", "__pycache__", "Pods", ".gradle", ".yarn", ".pnpm-store"];
const COPY_ENV = [".env.test", ".env.test.local", ".env.local"];

function configPatterns(value: unknown, directories: boolean): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry: unknown) => {
		if (typeof entry !== "string" || !entry.trim() || path.posix.isAbsolute(entry)) return [];
		const normalized = path.posix.normalize(entry).replace(/\/$/, "");
		if (normalized === ".." || normalized.startsWith("../")) return [];
		const pattern = normalized === "." ? "**/*" : normalized;
		return [directories && !/[*?[]/.test(pattern) && !path.posix.extname(pattern) ? `${pattern}/**/*` : pattern];
	});
}

function detectCopy(root: string): RepoInspection["copy"] {
	const configs = ["tsconfig.json", "jsconfig.json"].map(file => {
		const config = readJsonObject(path.join(root, file), true);
		return { include: configPatterns(config.include, true), files: configPatterns(config.files, false), exclude: configPatterns(config.exclude, true) };
	});
	const patterns = [...new Set(configs.flatMap(config => [...config.files, ...config.include]))];
	const env = COPY_ENV.filter(file => fs.existsSync(path.join(root, file)));
	if (!patterns.length && !env.length) return [];
	let ignored: string[];
	try {
		// Positive pathspecs scope discovery to declared inputs; exclusions prune large ignored trees before enumeration.
		ignored = execFileSync("git", [
			"ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--",
			...patterns.map(pattern => `:(top,glob)${pattern}`),
			...env.map(file => `:(top,literal)${file}`),
			...COPY_SKIP_DIRECTORIES.map(dir => `:(top,glob,exclude)**/${dir}/**`),
		], { cwd: root, encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
	} catch {
		return [];
	}
	ignored.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	const copy: RepoInspection["copy"] = [];
	let bytes = 0;
	for (const file of ignored) {
		if (copy.length === COPY_FILES) break;
		if (file.split("/").some(part => COPY_SKIP_DIRECTORIES.includes(part))) continue;
		const why = COPY_ENV.includes(file) ? "env" : configs.some(config =>
			config.files.some(pattern => path.matchesGlob(file, pattern))
			|| (config.include.some(pattern => path.matchesGlob(file, pattern)) && !config.exclude.some(pattern => path.matchesGlob(file, pattern))),
		) ? "tsconfig" : null;
		if (!why) continue;
		try {
			const absolute = path.join(root, file);
			const stat = fs.lstatSync(absolute);
			if (!stat.isFile() || !inside(realPath(absolute), realPath(root)) || bytes + stat.size > COPY_BYTES) continue;
			bytes += stat.size;
			copy.push({ path: file, why });
		} catch {
			// Files can disappear while a generator is updating its output.
		}
	}
	return copy;
}

export function detectCommands(root: string): Pick<RepoInspection, "stack" | "commands" | "tests" | "copy" | "recipeDraft"> {
	const stack: string[] = [];
	const install: string[] = [];
	const unit: string[] = [];
	const tests: RepoInspection["tests"] = {};
	let dev: string | null = null;
	const has = (file: string) => fs.existsSync(path.join(root, file));
	if (has("package.json")) {
		const manifest = readJsonObject(path.join(root, "package.json"));
		const scripts = objectOf(manifest.scripts);
		const hasScript = (name: string) => typeof scripts[name] === "string" && scripts[name].trim().length > 0;
		const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : null;
		const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm" : declared && ["pnpm", "yarn", "npm", "bun"].includes(declared) ? declared : "npm";
		stack.push(manager, "node");
		install.push(manager === "npm"
			? has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm ci --prefer-offline --no-audit --no-fund" : "npm install --prefer-offline --no-audit --no-fund"
			: manager === "pnpm" ? "pnpm install --frozen-lockfile --prefer-offline"
			: manager === "yarn" ? `yarn install ${has(".yarnrc.yml") ? "--immutable" : "--frozen-lockfile"}`
			: "bun install --frozen-lockfile");
		const typecheck = ["typecheck", "type-check", "tsc"].find(hasScript);
		if (typecheck) tests.typecheck = `${manager} run ${typecheck}`;
		else if (has("tsconfig.json") && [manifest.dependencies, manifest.devDependencies].some(dependencies => typeof objectOf(dependencies).typescript === "string")) tests.typecheck = "npx tsc --noEmit";
		if (hasScript("lint")) tests.lint = `CI=1 ${manager} run lint`;
		if (hasScript("test")) unit.push(`${manager} ${manager === "npm" ? "test" : "run test"}${/\bjest\b/.test(String(scripts.test)) ? " -- --ci" : ""}`);
		const coverage = ["test:ci", "test:coverage", "coverage"].find(hasScript);
		if (coverage) tests.coverage = `${manager} run ${coverage}`;
		if (hasScript("dev")) dev = `${manager} run dev`;
	}
	if (has("Cargo.toml")) {
		stack.push("cargo");
		install.push(`cargo fetch${has("Cargo.lock") ? " --locked" : ""}`);
		unit.push("cargo test");
	}
	if (has("go.mod")) {
		stack.push("go");
		install.push("go mod download");
		unit.push("go test ./...");
	}
	if (has("pyproject.toml")) {
		const pyproject = readText(path.join(root, "pyproject.toml"));
		const manager = has("uv.lock") || /\[tool\.uv(?:\.|\])/.test(pyproject) ? "uv" : has("poetry.lock") || /\[tool\.poetry(?:\.|\])/.test(pyproject) ? "poetry" : null;
		stack.push(...(manager ? [manager, "python"] : ["python"]));
		install.push(manager === "uv" ? "uv sync --frozen" : manager === "poetry" ? "poetry install --no-interaction" : "python -m pip install -e .");
		if (/\bpytest\b/.test(pyproject) || has("pytest.ini") || has("conftest.py")) unit.push(manager ? `${manager} run pytest` : "python -m pytest");
	}
	const makefile = ["GNUmakefile", "makefile", "Makefile"].find(has);
	if (makefile && /^(?:test|test[ \t]+[^:\n]+)[ \t]*:/m.test(readText(path.join(root, makefile)))) {
		stack.push("make");
		if (!unit.length) unit.push("make test");
	}
	if (unit.length) tests.unit = unit.join(" && ");
	const full = [tests.typecheck, tests.lint, tests.unit].filter(Boolean).join(" && ");
	if (full) tests.full = full;
	const commands = { install: install.join(" && ") || null, dev };
	const copy = detectCopy(root);
	const draftCopy = copy.filter(file => file.why === "tsconfig").map(file => file.path);
	let recipeDraft: string | null = null;
	if (commands.install || Object.keys(tests).length || dev || draftCopy.length) {
		const draft = stringify({ version: 1, ...(dev ? { ports: ["web"], env: { PORT: "{port.web}" } } : {}), ...(draftCopy.length ? { copy: draftCopy } : {}), ...(commands.install ? { setup: [commands.install] } : {}), ...(Object.keys(tests).length ? { test: tests } : {}) });
		const parsed = parseRecipe(draft);
		if (!parsed.ok) throw new Error(`Detected recipe is invalid: ${JSON.stringify(parsed.errors)}`);
		recipeDraft = draft;
	}
	return { stack, commands, tests, copy, recipeDraft };
}
