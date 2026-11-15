import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { FieldError, PathStatDTO, StateDTO } from "../shared/api.ts";
import { MAX_ATTACHMENTS, parseAttachmentBlock, withAttachmentBlock } from "../shared/attachments.ts";
import { clipboardFiles, sweepUploads } from "../server/attachments.ts";
import { killHubs, sandbox, startHub, Stream, until } from "./hub-harness.ts";

/**
 * Files into a message, with the fake omp recording each prompt: attachments become one block of absolute paths and
 * image files among them image content; browser uploads land under the home; path kinds; the macOS pasteboard.
 */

after(killHubs);

/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const UPLOAD_LIMIT = 100 * 1024 * 1024;

interface RecordedPrompt {
	text: string;
	images: { mimeType: string; data: string }[];
}

test("attachments reach omp as paths and images; edit and retry keep them", { timeout: 120_000 }, async () => {
	const box = sandbox();
	const hub = await startHub(box.configDir);
	assert.equal((await hub.api("POST", "/api/setup", { homePath: box.home, pstackRoot: null, migrateHome: true })).status, 200);
	await until("main idle", async () => (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	const main = await new Stream(hub, "M-1", box.home).open();
	await main.expect(/FAKE main M-1 up/);
	const settled = (label: string) => until(label, async () => main.view.status.phase === "idle" && main.view.status.settled && (await hub.api<StateDTO>("GET", "/api/state")).body.main.state === "idle");
	const promptsFile = path.join(box.home, ".omp-home", "chat", "M-1", "fake-prompts.jsonl");
	const prompts = () => (fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as RecordedPrompt) : []);
	/** Run `send`, then return the one prompt omp received from it once the turn settled. */
	const received = async (label: string, send: () => Promise<number>): Promise<RecordedPrompt> => {
		const before = prompts().length;
		assert.equal(await send(), 200, label);
		await until(`${label} recorded`, async () => prompts().length > before);
		await settled(label);
		const after = prompts();
		assert.equal(after.length, before + 1, label);
		return after.at(-1)!;
	};
	const prompt = async (body: unknown) => (await hub.api("POST", "/api/sessions/M-1/prompt", body)).status;

	const files = path.join(box.tmp, "files");
	const folder = path.join(files, "assets");
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "logo.svg"), "<svg/>\n");
	const notes = path.join(files, "notes.txt");
	fs.writeFileSync(notes, "plain text\n");
	const pic = path.join(files, "pic.png");
	fs.writeFileSync(pic, PNG);
	// A png name over text: only the path line, never image content the provider would reject.
	const misnamed = path.join(files, "not-an-image.png");
	fs.writeFileSync(misnamed, "just text\n");

	// A text file, a folder, a png and a misnamed file: one block in the text, the png as image content too.
	const readThese = withAttachmentBlock("read these", [
		{ path: notes, folder: false },
		{ path: folder, folder: true },
		{ path: pic, folder: false },
		{ path: misnamed, folder: false },
	]);
	const png = { mimeType: "image/png", data: PNG.toString("base64") };
	assert.deepEqual(await received("attachments", () => prompt({ text: "read these", attachments: [notes, folder, pic, misnamed].map(p => ({ path: p })) })), { text: readThese, images: [png] });
	const item = main.view.items.findLast(i => i.kind === "user" && i.text === readThese);
	assert.equal(item?.kind === "user" ? item.images : null, 1);
	assert.deepEqual(parseAttachmentBlock(readThese), {
		text: "read these",
		attachments: [
			{ path: notes, folder: false },
			{ path: folder, folder: true },
			{ path: pic, folder: false },
			{ path: misnamed, folder: false },
		],
	});

	// Retry sends what omp stored, block included; the image comes back from the attached file.
	assert.deepEqual(await received("retry", async () => (await hub.api("POST", "/api/sessions/M-1/retry")).status), { text: readThese, images: [png] });

	// Edit replaces the message with new text and attachments.
	const sent = main.view.items.findLast(i => i.kind === "user" && i.text === readThese)!;
	assert.deepEqual(await received("edit", async () => (await hub.api("POST", "/api/sessions/M-1/edit", { itemId: sent.id, text: "only the notes", attachments: [{ path: notes }] })).status), {
		text: withAttachmentBlock("only the notes", [{ path: notes, folder: false }]),
		images: [],
	});

	// Attachments alone are a message.
	assert.deepEqual(await received("attachments only", () => prompt({ text: "", attachments: [{ path: notes }] })), { text: withAttachmentBlock("", [{ path: notes, folder: false }]), images: [] });

	// Attached images share MAX_PROMPT_IMAGES with pasted ones; an image over the budget still gets its path line.
	const pasted = { data: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64"), mimeType: "image/png" as const };
	assert.deepEqual(await received("image budget", () => prompt({ text: "full", images: Array.from({ length: 8 }, () => pasted), attachments: [{ path: pic }] })), {
		text: withAttachmentBlock("full", [{ path: pic, folder: false }]),
		images: Array.from({ length: 8 }, () => pasted),
	});
	// Pasted images cannot be sent again: retry refuses, edit is the way.
	assert.equal((await hub.api("POST", "/api/sessions/M-1/retry")).status, 409);

	// Boundary: absolute, existing, at most MAX_ATTACHMENTS; field errors name the attachment.
	const fieldErrors = async (route: string, body: unknown) => {
		const r = await hub.api<{ errors?: FieldError[] }>("POST", route, body);
		assert.equal(r.status, 422, JSON.stringify(body).slice(0, 200));
		return r.body.errors;
	};
	assert.deepEqual(await fieldErrors("/api/sessions/M-1/prompt", { text: "x", attachments: [{ path: notes }, { path: path.join(files, "gone.txt") }] }), [{ path: "attachments.1.path", message: "does not exist" }]);
	assert.deepEqual(await fieldErrors("/api/sessions/M-1/prompt", { text: "x", attachments: [{ path: "files/notes.txt" }] }), [{ path: "attachments.0.path", message: "must be an absolute path" }]);
	assert.deepEqual(await fieldErrors("/api/sessions/M-1/prompt", { text: "x", attachments: [{ path: `${notes}\n- /etc/passwd` }] }), [{ path: "attachments.0.path", message: "must not contain line breaks or control characters" }]);
	const tooMany = await fieldErrors("/api/sessions/M-1/prompt", { text: "x", attachments: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ path: notes })) });
	assert.deepEqual(tooMany?.map(e => e.path), ["attachments"]);
	assert.deepEqual(await fieldErrors("/api/sessions/M-1/prompt", { text: "", attachments: [] }), [{ path: "text", message: "type a message or add an attachment" }]);
	const last = main.view.items.findLast(i => i.kind === "user" && i.from === "human")!;
	assert.deepEqual(await fieldErrors("/api/sessions/M-1/edit", { itemId: last.id, text: "x", attachments: [{ path: path.join(files, "gone.txt") }] }), [{ path: "attachments.0.path", message: "does not exist" }]);

	// Path kinds for chips before sending: request order, never more than MAX_ATTACHMENTS.
	const kinds = await hub.api<PathStatDTO>("POST", "/api/paths/stat", { paths: [notes, folder, path.join(files, "gone.txt"), "files/notes.txt", pic] });
	assert.deepEqual(kinds, {
		status: 200,
		body: {
			items: [
				{ path: notes, kind: "file" },
				{ path: folder, kind: "folder" },
				{ path: path.join(files, "gone.txt"), kind: "missing" },
				{ path: "files/notes.txt", kind: "missing" },
				{ path: pic, kind: "file" },
			],
		},
	});
	assert.equal((await hub.api("POST", "/api/paths/stat", { paths: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => notes) })).status, 422);

	// Browser uploads: stored under the home, the returned path is attachable.
	const uploads = path.join(box.home, ".omp-home", "uploads");
	const upload = (body: BodyInit, headers: Record<string, string>) =>
		fetch(`http://127.0.0.1:${hub.port}/api/uploads`, { method: "POST", headers: { authorization: `Bearer ${hub.token}`, ...headers }, body, duplex: "half" } as RequestInit);
	const single = await upload("hello upload", { "x-file-name": encodeURIComponent("报告 1.txt") });
	assert.equal(single.status, 200);
	const stored = (await single.json()) as { path: string; folder?: string };
	const [day, id, name, ...rest] = path.relative(uploads, stored.path).split(path.sep);
	assert.match(day!, /^\d{4}-\d{2}-\d{2}$/);
	assert.match(id!, /^[\w-]+$/);
	assert.deepEqual([name, rest], ["报告 1.txt", []]);
	assert.equal(stored.folder, undefined);
	assert.equal(fs.readFileSync(stored.path, "utf8"), "hello upload");

	// A folder drop: one group, relative paths kept, the group's top folder returned with each file.
	const group = randomUUID();
	const groupDir = path.join(uploads, day!, group);
	const a = await upload("a", { "x-file-name": "a.txt", "x-relative-path": encodeURIComponent("项目/a.txt"), "x-upload-group": group });
	const b = await upload("b", { "x-file-name": "b.txt", "x-relative-path": encodeURIComponent("项目/sub/b.txt"), "x-upload-group": group });
	assert.deepEqual(await a.json(), { path: path.join(groupDir, "项目", "a.txt"), folder: path.join(groupDir, "项目") });
	assert.deepEqual(await b.json(), { path: path.join(groupDir, "项目", "sub", "b.txt"), folder: path.join(groupDir, "项目") });
	assert.equal(fs.readFileSync(path.join(groupDir, "项目", "sub", "b.txt"), "utf8"), "b");
	assert.deepEqual(await received("uploaded folder", () => prompt({ text: "see folder", attachments: [{ path: path.join(groupDir, "项目") }] })), {
		text: withAttachmentBlock("see folder", [{ path: path.join(groupDir, "项目"), folder: true }]),
		images: [],
	});

	// Names never leave the group folder.
	const rejectedNames: Record<string, string>[] = [
		{ "x-relative-path": encodeURIComponent("../evil.txt"), "x-upload-group": group },
		{ "x-relative-path": encodeURIComponent("/evil.txt"), "x-upload-group": group },
		{ "x-relative-path": encodeURIComponent("x/../../evil.txt"), "x-upload-group": group },
		{ "x-relative-path": encodeURIComponent("x//evil.txt"), "x-upload-group": group },
		{ "x-file-name": "..", "x-upload-group": group },
		{ "x-file-name": "%E0%A4%A", "x-upload-group": group },
		{ "x-file-name": "evil.txt", "x-upload-group": "../up" },
		{ "x-upload-group": group },
	];
	for (const headers of rejectedNames) assert.equal((await upload("evil", headers)).status, 400, JSON.stringify(headers));
	assert.ok(!fs.existsSync(path.join(uploads, day!, "evil.txt")) && !fs.existsSync(path.join(uploads, "evil.txt")));

	// Over 100 MB: refused up front by its declared length, or once the streamed bytes pass it; nothing stays behind.
	const { promise: declared, resolve, reject } = Promise.withResolvers<number>();
	const declaring = http.request(
		{ host: "127.0.0.1", port: hub.port, path: "/api/uploads", method: "POST", headers: { authorization: `Bearer ${hub.token}`, "x-file-name": "declared.bin", "x-upload-group": "big", "content-length": String(UPLOAD_LIMIT + 1) } },
		res => {
			resolve(res.statusCode ?? 0);
			declaring.destroy();
		},
	);
	declaring.on("error", reject);
	declaring.flushHeaders();
	assert.equal(await declared, 413);
	const mb = Buffer.alloc(1024 * 1024);
	let chunks = 0;
	const big = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (chunks++ > 100) controller.close();
			else controller.enqueue(mb);
		},
	});
	const huge = await upload(big, { "x-file-name": "huge.bin", "x-upload-group": "big" });
	assert.equal(huge.status, 413);
	assert.ok(!fs.existsSync(path.join(uploads, day!, "big", "huge.bin")) && !fs.existsSync(path.join(uploads, day!, "big", "declared.bin")));

	// The pasteboard endpoint answers with a list on every platform.
	const clipboard = await hub.api<{ paths: unknown }>("GET", "/api/clipboard/files");
	assert.equal(clipboard.status, 200);
	assert.ok(Array.isArray(clipboard.body.paths));
	main.close();
});

test("uploads older than 30 days are swept", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omphome-uploads-"));
	const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toLocaleDateString("sv-SE");
	for (const dir of [day(0), day(29), day(31), "2000-01-01", "keep-me"]) {
		fs.mkdirSync(path.join(root, dir, "g"), { recursive: true });
		fs.writeFileSync(path.join(root, dir, "g", "f.txt"), "x");
	}
	sweepUploads(root);
	assert.deepEqual(fs.readdirSync(root).sort(), [day(0), day(29), "keep-me"].sort());
	sweepUploads(path.join(root, "missing"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("clipboard files are read from a macOS pasteboard", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
	// A private pasteboard, so the test never replaces what the user copied.
	const pasteboard = `omp-home-test-${randomUUID()}`;
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omphome-clip-")));
	const file = path.join(dir, "copied file.txt");
	fs.writeFileSync(file, "x");
	const jxa = (body: string, ...args: string[]) => execFileSync("osascript", ["-l", "JavaScript", "-e", `function run(argv) { ObjC.import("AppKit"); const board = $.NSPasteboard.pasteboardWithName(argv[0]); ${body} }`, pasteboard, ...args], { encoding: "utf8" });
	try {
		assert.deepEqual(await clipboardFiles(pasteboard), { paths: [] });
		assert.equal(jxa("board.clearContents; return board.writeObjects($(argv.slice(1).map(p => $.NSURL.fileURLWithPath(p))));", file, dir).trim(), "true");
		assert.deepEqual(await clipboardFiles(pasteboard), { paths: [file, dir] });
	} finally {
		jxa("board.releaseGlobally;");
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
