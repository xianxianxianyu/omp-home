import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PathStatDTO } from "../../shared/api.ts";
import { MAX_ATTACHMENTS } from "../../shared/attachments.ts";
import { api, upload } from "./api.ts";
import { useHub } from "./hub.tsx";
import { useT } from "./i18n/index.tsx";
import { listenNativeDrags } from "./native.ts";
import type { NativeDrag } from "./native.ts";

/** An attachment in the UI: the path omp receives, and whether it is a folder (shown with a folder icon, "(folder)" in the block). */
export interface AttachedPath { path: string; folder: boolean }
export const MAX_FOLDER_FILES = 500;
export const MAX_FOLDER_BYTES = 200 * 1024 * 1024;

export const basename = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) || path;

/** Current paths first, then new ones not already attached, up to MAX_ATTACHMENTS. */
export function mergePaths(current: AttachedPath[], added: AttachedPath[]): AttachedPath[] {
	const merged = [...current];
	for (const item of added) if (!merged.some(existing => existing.path === item.path)) merged.push(item);
	return merged.slice(0, MAX_ATTACHMENTS);
}

/** Paths whose kind the source did not report (desktop drops, Finder clipboard); missing ones are returned by name. */
export async function statPaths(paths: string[]): Promise<{ found: AttachedPath[]; missing: string[] }> {
	if (!paths.length) return { found: [], missing: [] };
	const { items } = await api<PathStatDTO>("/api/paths/stat", { body: { paths } });
	return {
		found: items.filter(item => item.kind !== "missing").map(item => ({ path: item.path, folder: item.kind === "folder" })),
		missing: items.filter(item => item.kind === "missing").map(item => basename(item.path)),
	};
}

export interface PickedFolder { name: string; files: { file: File; relativePath: string }[]; tooLarge: boolean }

// Chrome does not expose the FileSystem*Entry constructors, so instanceof cannot tell entries apart.
const isDirectory = (entry: FileSystemEntry | null): entry is FileSystemDirectoryEntry => entry?.isDirectory === true;
const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;

/** A drop's items are readable only during the event, so take the files and folder handles synchronously. */
export function snapshotDrop(transfer: DataTransfer): { files: File[]; directories: FileSystemDirectoryEntry[] } {
	const files: File[] = [];
	const directories: FileSystemDirectoryEntry[] = [];
	for (const item of transfer.items) {
		if (item.kind !== "file") continue;
		const entry = item.webkitGetAsEntry();
		if (isDirectory(entry)) directories.push(entry);
		else { const file = item.getAsFile(); if (file) files.push(file); }
	}
	return { files, directories };
}

/** Reads a dropped folder recursively, stopping as soon as it exceeds the upload caps. */
export async function readDirectory(root: FileSystemDirectoryEntry): Promise<PickedFolder> {
	const folder: PickedFolder = { name: root.name, files: [], tooLarge: false };
	let bytes = 0;
	const walk = async (directory: FileSystemDirectoryEntry): Promise<void> => {
		const reader = directory.createReader();
		for (;;) {
			const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (!batch.length) return;
			for (const entry of batch) {
				if (folder.tooLarge) return;
				if (isDirectory(entry)) await walk(entry);
				else if (isFile(entry)) {
					const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
					bytes += file.size;
					folder.files.push({ file, relativePath: entry.fullPath.replace(/^\/+/, "") });
					folder.tooLarge = folder.files.length > MAX_FOLDER_FILES || bytes > MAX_FOLDER_BYTES;
				}
			}
		}
	};
	await walk(root);
	return folder;
}

/** `<input webkitdirectory>` lists one folder's files with paths relative to its parent. */
export function foldersFromInput(files: File[]): PickedFolder[] {
	const folders = new Map<string, PickedFolder>();
	for (const file of files) {
		const relativePath = file.webkitRelativePath || file.name;
		const name = relativePath.split("/")[0];
		const folder = folders.get(name) ?? { name, files: [], tooLarge: false };
		folder.files.push({ file, relativePath });
		folders.set(name, folder);
	}
	for (const folder of folders.values()) folder.tooLarge = folder.files.length > MAX_FOLDER_FILES || folder.files.reduce((sum, item) => sum + item.file.size, 0) > MAX_FOLDER_BYTES;
	return [...folders.values()];
}

/** Uploads one folder as a single upload group and returns the folder's path on the hub. */
export async function uploadFolder(folder: PickedFolder, progress: (done: number) => void): Promise<string> {
	const group = crypto.randomUUID();
	let path: string | undefined;
	let next = 0;
	let done = 0;
	const worker = async () => {
		while (next < folder.files.length) {
			const { file, relativePath } = folder.files[next++];
			const result = await upload(file, { group, relativePath });
			path ??= result.folder;
			progress(++done);
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, folder.files.length) }, worker));
	if (!path) throw new Error(`/api/uploads returned no folder for ${folder.name}`);
	return path;
}

interface DropTarget { element: HTMLElement; main: boolean; over: (value: boolean) => void; drop: (paths: string[]) => void }
const dropTargets = new Set<DropTarget>();
let hovered: DropTarget | undefined;
let stopListening: (() => void) | null = null;

/** The composer under the pointer or in the session pane under it; else the focused composer; else main's. */
function dropTarget(x: number, y: number): DropTarget | undefined {
	const hit = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
	const scope = hit?.closest(".composer") ?? hit?.closest(".session-view")?.querySelector(".composer");
	const targets = [...dropTargets];
	return targets.find(target => target.element === scope) ?? targets.find(target => target.element.contains(document.activeElement)) ?? targets.find(target => target.main) ?? targets[0];
}
function routeNativeDrag(drag: NativeDrag) {
	const next = drag.kind === "leave" ? undefined : dropTarget(drag.x, drag.y);
	if (next !== hovered) { hovered?.over(false); next?.over(true); hovered = next; }
	if (drag.kind === "drop") { next?.over(false); hovered = undefined; if (drag.paths.length) next?.drop(drag.paths); }
}

/** Registers a composer for desktop file drops; true while a drag would land on it. */
export function useNativeDrop(element: RefObject<HTMLElement | null>, main: boolean, drop: (paths: string[]) => void): boolean {
	const [over, setOver] = useState(false);
	const latest = useRef(drop);
	useEffect(() => { latest.current = drop; });
	useEffect(() => {
		const node = element.current;
		if (!node || !window.__TAURI__?.event) return;
		const target: DropTarget = { element: node, main, over: setOver, drop: paths => latest.current(paths) };
		dropTargets.add(target);
		stopListening ??= listenNativeDrags(routeNativeDrag);
		return () => {
			dropTargets.delete(target);
			if (hovered === target) hovered = undefined;
			if (!dropTargets.size) { stopListening?.(); stopListening = null; }
		};
	}, [element, main]);
	return over;
}

function PathIcon({ folder }: { folder: boolean }) {
	return <svg className="attachment-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		{folder ? <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /> : <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>}
	</svg>;
}

/** Attached paths that can still be removed: in the composer and in the message editor. */
export function PathChips({ items, remove }: { items: AttachedPath[]; remove: (path: string) => void }) {
	const t = useT().session.composer;
	if (!items.length) return null;
	return <ul className="attachment-chips" aria-label={t.attachments}>{items.map(item => <li key={item.path} className={`attachment-chip ${item.folder ? "folder" : "file"}`} title={item.path} data-path={item.path}>
		<PathIcon folder={item.folder} /><span className="attachment-name">{basename(item.path)}</span>
		<button type="button" className="attachment-remove" aria-label={t.removeAttachment(basename(item.path))} title={t.removeAttachment(basename(item.path))} onClick={() => remove(item.path)}>×</button>
	</li>)}</ul>;
}

/** Paths of a sent message; clicking one copies it. */
export function SentPathChips({ items }: { items: AttachedPath[] }) {
	const t = useT().session.composer;
	const { toast } = useHub();
	const copy = async (path: string) => {
		try { await navigator.clipboard.writeText(path); toast(catalog => catalog.session.composer.pathCopied(basename(path))); }
		catch (cause) { toast(cause instanceof Error ? cause.message : catalog => catalog.common.clipboardError, "error"); }
	};
	return <ul className="attachment-chips sent" aria-label={t.attachments}>{items.map(item => <li key={item.path}>
		<button type="button" className={`attachment-chip ${item.folder ? "folder" : "file"}`} title={item.path} aria-label={t.copyPath(item.path)} data-path={item.path} onClick={() => void copy(item.path)}><PathIcon folder={item.folder} /><span className="attachment-name">{basename(item.path)}</span></button>
	</li>)}</ul>;
}
