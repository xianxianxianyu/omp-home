import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify } from "yaml";

/** poteto-mode playbook names: the file stems under `<pstack>/skills/poteto-mode/playbooks/`. */
export function playbooks(pstackRoot: string | null): string[] {
	if (!pstackRoot) return [];
	try {
		return fs
			.readdirSync(path.join(pstackRoot, "skills", "poteto-mode", "playbooks"))
			.filter(f => f.endsWith(".md"))
			.map(f => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}

/**
 * The omp extension package that loads pstack into every session (`-e <dir>`):
 * `skills/` links to the pstack tree; `agents/` holds copies with omp-compatible
 * frontmatter (name + description only). Regenerated whole each time.
 */
export function generatePstackPackage(pstackRoot: string | null, dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
	if (!pstackRoot) return;
	fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "omp-home-pstack", version: "0.0.0", private: true, omp: { extensions: ["./index.ts"] } }, null, 2)}\n`);
	fs.writeFileSync(path.join(dir, "index.ts"), "export default function () {}\n");
	fs.symlinkSync(path.join(pstackRoot, "skills"), path.join(dir, "skills"));
	let agents: string[] = [];
	try {
		agents = fs.readdirSync(path.join(pstackRoot, "agents")).filter(f => f.endsWith(".md"));
	} catch {
		// pstack without agents
	}
	for (const file of agents) {
		const text = fs.readFileSync(path.join(pstackRoot, "agents", file), "utf8");
		fs.writeFileSync(path.join(dir, "agents", file), reduceFrontmatter(text, file.slice(0, -3)));
	}
}

function reduceFrontmatter(text: string, fallbackName: string): string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	let meta: Record<string, unknown> = {};
	if (m) {
		try {
			const parsed: unknown = parseYaml(m[1]!);
			if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
		} catch {
			// keep defaults
		}
	}
	const body = m ? text.slice(m[0].length) : text;
	const front = {
		name: typeof meta.name === "string" ? meta.name : fallbackName,
		description: typeof meta.description === "string" ? meta.description : `pstack agent ${fallbackName}`,
	};
	return `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}
