import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, type PathStatDTO, type PromptImage } from "../shared/api.ts";
import { parseAttachmentBlock, withAttachmentBlock, type Attachment } from "../shared/attachments.ts";
import { HubError } from "./errors.ts";
import { messages } from "./i18n.ts";

/** How files reach omp: prompt composition, browser uploads, the macOS pasteboard and path kinds. See shared/attachments.ts. */

const run = promisify(execFile);
const MB = 1024 * 1024;
const UPLOAD_LIMIT = 100 * MB;
const UPLOAD_KEEP_DAYS = 30;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GROUP = /^[\w-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** What one prompt sends to omp: the text with its attachment block, and the images. */
export interface OutgoingMessage {
	text: string;
	images: PromptImage[];
}

// Every valid file of these formats starts with its signature, so the extension adds nothing but mislabeled files the provider would reject.
const SIGNATURES: readonly (readonly [PromptImage["mimeType"], (head: Buffer) => boolean])[] = [
	["image/png", head => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
	["image/jpeg", head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff],
	["image/gif", head => /^GIF8[79]a$/.test(head.toString("latin1", 0, 6))],
	["image/webp", head => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP"],
];

async function imageFile(file: string, size: number): Promise<PromptImage | null> {
	const handle = await fs.promises.open(file, "r");
	try {
		const head = Buffer.alloc(12);
		await handle.read(head, 0, head.length, 0);
		const mimeType = SIGNATURES.find(([, matches]) => matches(head))?.[0];
		if (!mimeType) return null;
		const data = Buffer.alloc(size);
		const { bytesRead } = await handle.read(data, 0, size, 0);
		return { data: data.toString("base64", 0, bytesRead), mimeType };
	} finally {
		await handle.close();
	}
}

/**
 * Pasted images first, then image files among the attachments while MAX_PROMPT_IMAGES allows; every attachment, image
 * or not, gets a line in the block so omp can open it with its own tools.
 */
export async function composeMessage(text: string, images: readonly PromptImage[], attachments: readonly Attachment[]): Promise<OutgoingMessage> {
	const items: { path: string; folder: boolean }[] = [];
	const all = [...images];
	for (const { path: file } of attachments) {
		const stat = await fs.promises.stat(file);
		items.push({ path: file, folder: stat.isDirectory() });
		if (stat.isFile() && stat.size <= MAX_PROMPT_IMAGE_BYTES && all.length < MAX_PROMPT_IMAGES) {
			const image = await imageFile(file, stat.size);
			if (image) all.push(image);
		}
	}
	return { text: withAttachmentBlock(text, items), images: all };
}

/**
 * The images a sent message gets again from its attached image files, for a retry (omp's RPC returns no image data);
 * null when those files no longer account for all `count` images it carried, e.g. pasted ones.
 */
export async function reattachedImages(text: string, count: number): Promise<PromptImage[] | null> {
	const { attachments } = parseAttachmentBlock(text);
	try {
		const { images } = await composeMessage("", [], attachments);
		return images.length === count ? images : null;
	} catch {
		return null;
	}
}

export async function pathKinds(paths: readonly string[]): Promise<PathStatDTO> {
	const items = await Promise.all(
		paths.map(async (p): Promise<PathStatDTO["items"][number]> => {
			if (!path.isAbsolute(p)) return { path: p, kind: "missing" };
			const stat = await fs.promises.stat(p).catch(() => null);
			return { path: p, kind: !stat ? "missing" : stat.isDirectory() ? "folder" : "file" };
		}),
	);
	return { items };
}

function dayName(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return typeof value === "string" ? value : undefined;
}

/** The stored file's path parts below its group folder: the relative path (a folder drop) or the file name. */
function uploadParts(req: http.IncomingMessage): string[] {
	const raw = header(req, "x-relative-path") ?? header(req, "x-file-name");
	if (!raw) throw new HubError("invalid", messages.uploadNameMissing());
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new HubError("invalid", messages.uploadPath(raw));
	}
	const parts = decoded.split("/").map(part => part.replace(CONTROL, ""));
	if (parts.some(part => part === "" || part === "." || part === "..")) throw new HubError("invalid", messages.uploadPath(decoded.replace(CONTROL, "")));
	return parts;
}

/** A group keeps the day folder it started in, so a folder dropped across midnight still has one root. */
function groupDir(root: string, group: string | undefined): string {
	if (group !== undefined) {
		if (!GROUP.test(group)) throw new HubError("invalid", messages.uploadGroup());
		const days = fs.existsSync(root) ? fs.readdirSync(root).filter(day => DAY.test(day)) : [];
		const existing = days.map(day => path.join(root, day, group)).find(dir => fs.existsSync(dir));
		if (existing) return existing;
	}
	return path.join(root, dayName(new Date()), group ?? randomUUID());
}

async function receive(req: http.IncomingMessage, out: fs.promises.FileHandle): Promise<void> {
	let size = 0;
	// Leave the request open on overflow: the rest is drained so the client reads the 413 instead of a reset.
	for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > UPLOAD_LIMIT) throw new HubError("too_large", messages.uploadTooLarge(UPLOAD_LIMIT / MB));
		await out.write(chunk);
	}
}

/** POST /api/uploads: stream the raw body to `<root>/<day>/<group>/<relative path>`. */
export async function storeUpload(root: string, req: http.IncomingMessage): Promise<{ path: string; folder?: string }> {
	const parts = uploadParts(req);
	const dir = groupDir(root, header(req, "x-upload-group"));
	if (Number(req.headers["content-length"]) > UPLOAD_LIMIT) throw new HubError("too_large", messages.uploadTooLarge(UPLOAD_LIMIT / MB));
	const file = path.join(dir, ...parts);
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const out = await fs.promises.open(file, "w");
	try {
		await receive(req, out);
	} catch (err) {
		req.resume();
		await out.close();
		await fs.promises.rm(file, { force: true });
		throw err;
	}
	await out.close();
	return parts.length > 1 ? { path: file, folder: path.join(dir, parts[0]!) } : { path: file };
}

/** Startup: day folders of uploads older than UPLOAD_KEEP_DAYS go. */
export function sweepUploads(root: string): void {
	if (!fs.existsSync(root)) return;
	const cutoff = dayName(new Date(Date.now() - UPLOAD_KEEP_DAYS * 24 * 60 * 60 * 1000));
	for (const day of fs.readdirSync(root)) if (DAY.test(day) && day < cutoff) fs.rmSync(path.join(root, day), { recursive: true, force: true });
}

const PASTEBOARD_FILES = `function run(argv) {
	ObjC.import("AppKit");
	const board = argv.length ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard;
	const urls = board.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
	const paths = [];
	for (let i = 0; i < (urls.isNil() ? 0 : urls.count); i++) paths.push(urls.objectAtIndex(i).path.js);
	return JSON.stringify(paths);
}`;

/**
 * File and folder paths on the macOS pasteboard, e.g. copied in Finder: WebKit never hands file URLs to the page.
 * `pasteboard` names another pasteboard than the general one. Never throws: [] on other platforms or on any failure.
 */
export async function clipboardFiles(pasteboard?: string): Promise<{ paths: string[] }> {
	if (process.platform !== "darwin") return { paths: [] };
	try {
		const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", PASTEBOARD_FILES, ...(pasteboard ? [pasteboard] : [])], { timeout: 5000 });
		const parsed: unknown = JSON.parse(stdout);
		return { paths: Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && path.isAbsolute(p)) : [] };
	} catch {
		return { paths: [] };
	}
}
