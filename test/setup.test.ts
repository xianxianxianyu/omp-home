import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { manifestReason } from "../server/i18n-validation.ts";
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

test("setup preview reasons render in the requested language; English stays the default", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-setup-"));
	fs.writeFileSync(path.join(home, section.path), `# Home\n\n${section.heading}\n\nold workflow\n`);
	fs.mkdirSync(path.join(home, replaced.path), { recursive: true });
	fs.writeFileSync(path.join(home, replaced.path, "SKILL.md"), "old skill\n");

	const en = previewSetup(home, templates);
	const zh = previewSetup(home, templates, "zh");
	assert.deepEqual(previewSetup(home, templates, "en"), en);
	assert.deepEqual(zh.changes.map(c => c.action), en.changes.map(c => c.action));
	assert.equal(en.changes.length, manifest.length + 3, "every manifest entry, .gitignore and two backups");

	const reason = (preview: typeof en, file: string) => preview.changes.find(c => c.path === file)!.reason;
	assert.equal(reason(en, ".gitignore"), "add .omp-home/: hub database, transcripts and logs stay out of git");
	assert.equal(reason(zh, ".gitignore"), "添加 .omp-home/：中枢数据库、会话记录和日志不纳入 git");
	assert.equal(reason(en, "repos/_example.env.yaml"), "A complete example environment recipe; an existing file is never overwritten.");
	assert.equal(reason(zh, "repos/_example.env.yaml"), "提供完整的环境配方示例，不覆盖已有文件。");
	assert.ok(reason(en, section.path).startsWith(`section "${section.heading}": `));
	assert.ok(reason(zh, section.path).startsWith(`「${section.heading}」一节：`));
	assert.equal(reason(en, `.omp-home/backup/<setup time>/${replaced.path}`), `previous ${replaced.path}`);
	assert.equal(reason(zh, `.omp-home/backup/<初始化时间>/${replaced.path}`), `原有的 ${replaced.path}`);

	const han = /\p{Script=Han}/u;
	for (const change of en.changes) assert.doesNotMatch(change.reason.replace(section.heading!, ""), han, change.path);
	for (const change of zh.changes) assert.match(change.reason, han, change.path);
	for (const entry of manifest) assert.ok(manifestReason(entry.path), `${entry.path} needs an en/zh setup reason`);
});
