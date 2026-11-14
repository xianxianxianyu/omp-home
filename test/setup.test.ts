import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generatePstackPackage, playbooks } from "../server/pstack.ts";
import { applySetup, previewSetup } from "../server/setup.ts";

const repo = path.resolve(import.meta.dirname, "..");
const templates = path.join(repo, "templates");
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "templates/home/manifest.json"), "utf8")) as { path: string; action: string; heading?: string; source: string }[];
const section = manifest.find(e => e.action === "section")!;
const replaced = manifest.find(e => e.action === "replace")!;

test("setup replaces one markdown section, backs up what it replaces, and is idempotent", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-setup-"));
	const level = /^(#+)/.exec(section.heading!)![1]!;
	fs.writeFileSync(path.join(home, section.path), `# Home\n\n${section.heading}\n\nold workflow\n\n${level} Repos\n\n- /some/repo\n`);
	fs.mkdirSync(path.join(home, replaced.path), { recursive: true });
	fs.writeFileSync(path.join(home, replaced.path, "SKILL.md"), "old skill\n");

	const preview = previewSetup(home, templates);
	assert.ok(preview.changes.some(c => c.path === section.path && c.action === "replace"));
	assert.ok(preview.changes.some(c => c.path === replaced.path && c.action === "replace"));
	assert.ok(preview.changes.some(c => c.action === "backup" && c.path.endsWith(replaced.path)));
	assert.ok(preview.changes.some(c => c.path === ".gitignore" && c.action === "create"));

	applySetup(home, templates, true);
	const agents = fs.readFileSync(path.join(home, section.path), "utf8");
	assert.doesNotMatch(agents, /old workflow/);
	assert.match(agents, /^# Home/);
	assert.match(agents, /- \/some\/repo/);
	assert.ok(agents.includes(fs.readFileSync(path.join(repo, "templates/home", section.source), "utf8").trim()));
	assert.match(fs.readFileSync(path.join(home, ".gitignore"), "utf8"), /^\.omp-home\/$/m);
	const backups = fs.readdirSync(path.join(home, ".omp-home/backup"));
	assert.equal(backups.length, 1);
	assert.equal(fs.readFileSync(path.join(home, ".omp-home/backup", backups[0]!, replaced.path, "SKILL.md"), "utf8"), "old skill\n");
	assert.match(fs.readFileSync(path.join(home, ".omp-home/backup", backups[0]!, section.path), "utf8"), /old workflow/);

	assert.deepEqual(previewSetup(home, templates).changes, []);
	applySetup(home, templates, true);
	assert.equal(fs.readdirSync(path.join(home, ".omp-home/backup")).length, 1);
	assert.equal(fs.readFileSync(path.join(home, section.path), "utf8"), agents);
});

test("without migrateHome only missing files are created", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-setup-"));
	fs.writeFileSync(path.join(home, section.path), "# Mine\n");
	applySetup(home, templates, false);
	assert.equal(fs.readFileSync(path.join(home, section.path), "utf8"), "# Mine\n");
	assert.ok(fs.existsSync(path.join(home, replaced.path)));
	assert.ok(!fs.existsSync(path.join(home, ".omp-home/backup")));
});

test("the pstack package links skills, reduces agent frontmatter and lists playbooks", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-pstack-"));
	fs.mkdirSync(path.join(root, "skills/poteto-mode/playbooks"), { recursive: true });
	fs.writeFileSync(path.join(root, "skills/poteto-mode/SKILL.md"), "# poteto\n");
	for (const p of ["feature", "bug-fix"]) fs.writeFileSync(path.join(root, `skills/poteto-mode/playbooks/${p}.md`), "x");
	fs.mkdirSync(path.join(root, "agents"));
	fs.writeFileSync(path.join(root, "agents/poteto-agent.md"), "---\nname: poteto-agent\ndescription: Delegate\nmodel: inherit\ntools: [Read]\n---\nBody text\n");
	const out = path.join(root, "pkg");
	generatePstackPackage(root, out);
	assert.equal(fs.readlinkSync(path.join(out, "skills")), path.join(root, "skills"));
	assert.equal(fs.readFileSync(path.join(out, "agents/poteto-agent.md"), "utf8"), "---\nname: poteto-agent\ndescription: Delegate\n---\nBody text\n");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")).omp, { extensions: ["./index.ts"] });
	assert.deepEqual(playbooks(root), ["bug-fix", "feature"]);
	generatePstackPackage(null, out);
	assert.ok(!fs.existsSync(out));
});
