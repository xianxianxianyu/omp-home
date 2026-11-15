import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, Dispatch, RefObject, SetStateAction } from "react";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, PROMPT_IMAGE_TYPES } from "../../shared/api.ts";
import type { CommandDTO, PromptImage, PromptRequest } from "../../shared/api.ts";
import { MAX_ATTACHMENTS, parseAttachmentBlock } from "../../shared/attachments.ts";
import type { SessionStatus } from "../../shared/transcript.ts";
import { api, upload } from "./api.ts";
import { MAX_FOLDER_BYTES, MAX_FOLDER_FILES, PathChips, foldersFromInput, mergePaths, readDirectory, snapshotDrop, statPaths, uploadFolder, useNativeDrop } from "./attachments.tsx";
import type { AttachedPath, PickedFolder } from "./attachments.tsx";
import { useHub } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import { nativePaths, pickPaths } from "./native.ts";

const draftKey = (sessionId: string) => `omp-home-draft:${sessionId}`;
const lastSentKey = (sessionId: string) => `omp-home-last-sent:${sessionId}`;

/** Composer text for one session, kept in this browser until it is sent. */
export function useDraft(sessionId: string) {
	const [text, setText] = useState(() => localStorage.getItem(draftKey(sessionId)) ?? "");
	useEffect(() => {
		if (text) localStorage.setItem(draftKey(sessionId), text);
		else localStorage.removeItem(draftKey(sessionId));
	}, [sessionId, text]);
	return [text, setText] as const;
}

/** Returned or withdrawn messages go after what is already typed, one paragraph each, so nothing is overwritten. */
export function appendParagraphs(draft: string, texts: string[]): string {
	return [draft, ...texts].filter(text => text.trim()).join("\n\n");
}

interface ImageAttachment { id: number; name: string; mimeType: PromptImage["mimeType"]; url: string }
interface Upload { id: number; name: string; folder: boolean; done: number; total: number }
function readDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(file.name));
		reader.onerror = () => reject(reader.error ?? new Error(file.name));
		reader.readAsDataURL(file);
	});
}
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function Composer({ sessionId, connected, running, commands, focused, main, input, text, setText, paths, setPaths, note, clearNote, abort, stopping, meta, escapeAborts, onNewChat }: { sessionId: string; connected: boolean; running: boolean; commands: CommandDTO[]; focused: boolean; main: boolean; input: RefObject<HTMLTextAreaElement | null>; text: string; setText: Dispatch<SetStateAction<string>>; paths: AttachedPath[]; setPaths: Dispatch<SetStateAction<AttachedPath[]>>; note: string | null; clearNote: () => void; abort: () => Promise<void>; stopping: boolean; meta: string; escapeAborts: boolean; onNewChat?: () => void }) {
	const catalog = useT();
	const t = catalog.session.composer;
	const shell = catalog.shell.app;
	const { format } = useI18n();
	const { noteComposerInput } = useHub();
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [busy, setBusy] = useState(0);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState(false);
	const [attachMenu, setAttachMenu] = useState(false);
	const [dragging, setDragging] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const attachRoot = useRef<HTMLDivElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const nextId = useRef(0);
	/** Attachment work awaits uploads and lookups; room and duplicates are checked against what is attached by then. */
	const latest = useRef({ images, paths });
	useEffect(() => { latest.current = { images, paths }; });
	const composing = useRef(false);
	const compositionEnded = useRef(0);
	const query = text.match(/^\/([^\s]*)$/)?.[1].toLowerCase();
	const matches = query === undefined ? [] : commands.flatMap(command => {
		if (command.name.toLowerCase().startsWith(query)) return [{ command, score: 0 }];
		for (const [score, value] of [command.name, command.description ?? ""].entries()) {
			let index = 0;
			for (const char of value.toLowerCase()) if (char === query[index]) index++;
			if (index === query.length) return [{ command, score: score + 1 }];
		}
		return [];
	}).sort((a, b) => a.score - b.score).slice(0, 8).map(match => match.command);
	const menuOpen = matches.length > 0 && !menuDismissed;
	const hasContent = text.trim() !== "" || images.length > 0 || paths.length > 0;
	const canSend = connected && !pending && busy === 0 && hasContent;
	useEffect(() => { if (focused && !main) input.current?.focus(); }, [focused, main, input]);
	useEffect(() => { const focus = () => { if (main) input.current?.focus(); }; window.addEventListener("focus-main", focus); return () => window.removeEventListener("focus-main", focus); }, [main, input]);
	useEffect(() => {
		if (!attachMenu) return;
		const close = (event: MouseEvent) => { if (event.target instanceof Node && !attachRoot.current?.contains(event.target)) setAttachMenu(false); };
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [attachMenu]);
	const tooMany = () => t.tooManyFiles(format.number(MAX_ATTACHMENTS));
	/** Runs one attachment job; Send waits for it, and its outcome replaces the composer error. */
	const run = (work: () => Promise<string | null>) => void (async () => {
		setBusy(count => count + 1);
		try { setError(await work()); }
		catch (cause) { setError(errorText(cause)); }
		finally { setBusy(count => count - 1); }
	})();
	const addPaths = (added: AttachedPath[]): string | null => {
		const attached = latest.current.paths;
		const fresh = new Set(added.map(item => item.path).filter(path => !attached.some(item => item.path === path)));
		setPaths(current => mergePaths(current, added));
		return attached.length + fresh.size > MAX_ATTACHMENTS ? tooMany() : null;
	};
	/** Desktop drops and Finder copies carry bare paths; the hub says which are folders and which no longer exist. */
	const addPathsByKind = async (list: string[]): Promise<string | null> => {
		const attached = latest.current.paths;
		const fresh = [...new Set(list)].filter(path => !attached.some(item => item.path === path));
		const room = Math.max(0, MAX_ATTACHMENTS - attached.length);
		const { found, missing } = await statPaths(fresh.slice(0, room));
		setPaths(current => mergePaths(current, found));
		return missing.length ? t.missing(format.list(missing)) : fresh.length > room ? tooMany() : null;
	};
	const trackUpload = async (item: Omit<Upload, "id" | "done">, work: (progress: (done: number) => void) => Promise<void>) => {
		const id = ++nextId.current;
		setUploads(current => [...current, { ...item, id, done: 0 }]);
		try { await work(done => setUploads(current => current.map(upload => upload.id === id ? { ...upload, done } : upload))); }
		finally { setUploads(current => current.filter(upload => upload.id !== id)); }
	};
	/** Images that fit are sent as bytes; with `uploadRest`, other files go to the hub and are attached by path. */
	const addFiles = async (list: File[], uploadRest: boolean): Promise<string | null> => {
		const limit = `${format.number(MAX_PROMPT_IMAGE_BYTES / 1024 / 1024)} MB`;
		let problem: string | null = null;
		let room = Math.max(0, MAX_PROMPT_IMAGES - latest.current.images.length);
		const added: ImageAttachment[] = [];
		const rest: File[] = [];
		for (const file of list) {
			const mimeType = PROMPT_IMAGE_TYPES.find(value => value === file.type);
			if (mimeType && file.size <= MAX_PROMPT_IMAGE_BYTES && room > 0) {
				room--;
				try { added.push({ id: ++nextId.current, name: file.name, mimeType, url: await readDataUrl(file) }); }
				catch { problem = t.imageReadError(file.name); }
			} else if (uploadRest) rest.push(file);
			else problem = !mimeType ? t.imageType : file.size > MAX_PROMPT_IMAGE_BYTES ? t.imageTooLarge(file.name, limit) : t.tooManyImages(format.number(MAX_PROMPT_IMAGES));
		}
		if (added.length) setImages(current => [...current, ...added].slice(0, MAX_PROMPT_IMAGES));
		for (const file of rest) {
			if (latest.current.paths.length >= MAX_ATTACHMENTS) return tooMany();
			try { await trackUpload({ name: file.name, folder: false, total: 1 }, async () => { const { path } = await upload(file); problem = addPaths([{ path, folder: false }]) ?? problem; }); }
			catch (cause) { problem = t.uploadError(file.name, errorText(cause)); }
		}
		return problem;
	};
	const addFolders = async (folders: PickedFolder[]): Promise<string | null> => {
		let problem: string | null = null;
		for (const folder of folders) {
			if (folder.tooLarge) { problem = t.folderTooLarge(folder.name, format.number(MAX_FOLDER_FILES), `${format.number(MAX_FOLDER_BYTES / 1024 / 1024)} MB`); continue; }
			if (!folder.files.length) { problem = t.folderEmpty(folder.name); continue; }
			if (latest.current.paths.length >= MAX_ATTACHMENTS) return tooMany();
			try { await trackUpload({ name: folder.name, folder: true, total: folder.files.length }, async progress => { problem = addPaths([{ path: await uploadFolder(folder, progress), folder: true }]) ?? problem; }); }
			catch (cause) { problem = t.uploadError(folder.name, errorText(cause)); }
		}
		return problem;
	};
	const nativeOver = useNativeDrop(root, main, list => { input.current?.focus(); run(() => addPathsByKind(list)); });
	const drop = (transfer: DataTransfer) => {
		const { files, directories } = snapshotDrop(transfer);
		input.current?.focus();
		run(async () => {
			const filesProblem = await addFiles(files, true);
			return await addFolders(await Promise.all(directories.map(readDirectory))) ?? filesProblem;
		});
	};
	const pick = (directory: boolean) => {
		setAttachMenu(false);
		if (!nativePaths()) { (directory ? folderInput : fileInput).current?.click(); return; }
		run(async () => {
			let picked: string[];
			try { picked = await pickPaths(directory); }
			catch (cause) { return t.pickError(errorText(cause)); }
			input.current?.focus();
			return addPaths(picked.map(path => ({ path, folder: directory })));
		});
	};
	const insertText = (value: string) => {
		const element = input.current;
		const start = element?.selectionStart ?? Number.MAX_SAFE_INTEGER;
		const end = element?.selectionEnd ?? start;
		setText(current => current.slice(0, start) + value + current.slice(end));
		clearNote(); noteComposerInput();
		requestAnimationFrame(() => element?.setSelectionRange(start + value.length, start + value.length));
	};
	/** Finder copies reach the page as an icon image plus the file name, so the hub's pasteboard paths win; otherwise paste the text and attach the images. */
	const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const data = event.clipboardData;
		const files = [...data.files];
		if (!files.length && !data.types.includes("Files")) return;
		event.preventDefault();
		const pasted = data.getData("text/plain");
		run(async () => {
			const copied = await api<{ paths: string[] }>("/api/clipboard/files").then(result => result.paths, () => []);
			if (copied.length) return addPathsByKind(copied);
			if (pasted) insertText(pasted);
			return files.length ? addFiles(files, false) : null;
		});
	};
	const send = async (mode: "auto" | "steer") => {
		if (!canSend || composing.current) return;
		const sent = { text, images, paths };
		const body: PromptRequest = {
			text, mode: running ? mode : "auto",
			...(images.length ? { images: images.map(image => ({ data: image.url.slice(image.url.indexOf(",") + 1), mimeType: image.mimeType })) } : {}),
			...(paths.length ? { attachments: paths.map(({ path }) => ({ path })) } : {}),
		};
		// Clear right away so typing can continue; a failed send puts the message back ahead of anything typed since.
		setPending(true); setError(null); clearNote(); setText(""); setImages([]); setPaths([]); setMenuDismissed(false);
		if (text.trim()) localStorage.setItem(lastSentKey(sessionId), text);
		try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { body }); }
		catch (cause) {
			setText(current => appendParagraphs(sent.text, [current]));
			setImages(current => [...sent.images, ...current].slice(0, MAX_PROMPT_IMAGES));
			setPaths(current => mergePaths(sent.paths, current));
			setError(errorText(cause));
		}
		finally { setPending(false); }
	};
	const chooseCommand = (command: CommandDTO) => { setText(`/${command.name} `); setMenuDismissed(false); input.current?.focus(); noteComposerInput(); };
	return <div ref={root} className={`composer ${dragging || nativeOver ? "dragging" : ""}`} onDragOver={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); }} onDrop={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDragging(false); drop(event.dataTransfer); }}>
		{(dragging || nativeOver) && <div className="composer-drop" aria-hidden="true">{t.dropHere}</div>}
		{menuOpen && <div className="command-menu" role="listbox" aria-label={t.slashCommands}>{matches.map((command, index) => <button role="option" aria-selected={index === selected} key={command.name} className={index === selected ? "selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)}><strong>/{command.name}</strong><span>{command.description ?? command.source}</span></button>)}</div>}
		{images.length > 0 && <div className="composer-images">{images.map(image => <figure className="composer-image" key={image.id}><img src={image.url} alt={image.name} /><button type="button" aria-label={t.removeAttachment(image.name)} title={t.removeAttachment(image.name)} onClick={() => setImages(current => current.filter(item => item.id !== image.id))}>×</button></figure>)}</div>}
		<PathChips items={paths} remove={path => setPaths(current => current.filter(item => item.path !== path))} />
		<textarea ref={input} aria-label={t.messageLabel(sessionId)} placeholder={running ? t.runningPlaceholder : t.placeholder} value={text} rows={2} onChange={event => { setText(event.target.value); setSelected(0); setMenuDismissed(false); clearNote(); noteComposerInput(); }} onCompositionStart={() => { composing.current = true; noteComposerInput(); }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = performance.now(); }} onPaste={paste} onKeyDown={event => {
			if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (menuOpen) setMenuDismissed(true); else if (running && escapeAborts) void abort(); return; }
			if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelected(index => (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); return; }
			if (menuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { if (performance.now() - compositionEnded.current < 80) return; event.preventDefault(); chooseCommand(matches[selected] ?? matches[0]); return; }
			if (event.key === "ArrowUp" && !text && !images.length && !paths.length && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
				const last = localStorage.getItem(lastSentKey(sessionId));
				if (last) { event.preventDefault(); setText(last); }
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (performance.now() - compositionEnded.current >= 80) void send(event.metaKey || event.ctrlKey ? "steer" : "auto"); }
		}} />
		<div className="composer-actions">
			{/* Escape here closes the menu instead of stopping the turn or leaving the task view; data-menu tells the app-level handler. */}
			<div className="more-menu composer-attach-menu" ref={attachRoot} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAttachMenu(false); }} onKeyDown={event => { if (event.key === "Escape" && attachMenu) { event.preventDefault(); event.stopPropagation(); setAttachMenu(false); attachRoot.current?.querySelector("button")?.focus(); } }}>
				<button type="button" className="icon-button composer-attach" aria-label={t.attach} title={t.attachHint} aria-haspopup="menu" aria-expanded={attachMenu} onClick={() => setAttachMenu(value => !value)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg></button>
				{attachMenu && <div className="more-popover composer-attach-popover" role="menu" aria-label={t.attach} data-menu>
					<button type="button" role="menuitem" className="more-item" onClick={() => pick(false)}>{t.attachFiles}</button>
					<button type="button" role="menuitem" className="more-item" onClick={() => pick(true)}>{t.attachFolder}</button>
				</div>}
			</div>
			<input ref={fileInput} type="file" multiple hidden onChange={event => { const list = [...(event.target.files ?? [])]; event.target.value = ""; input.current?.focus(); run(() => addFiles(list, true)); }} />
			<input ref={element => { folderInput.current = element; if (element) element.webkitdirectory = true; }} type="file" hidden onChange={event => { const list = [...(event.target.files ?? [])]; event.target.value = ""; input.current?.focus(); run(() => addFolders(foldersFromInput(list))); }} />
			<span className="composer-meta mono" title={running ? t.runningKeyboardHint : t.keyboardHint}>{meta}</span>
			{onNewChat && <button type="button" className="link-button composer-new-chat" title={shell.newChatHint} onClick={onNewChat}>{shell.newChat}</button>}
			<span className="spacer" />
			{running && !hasContent
				? <button type="button" className="btn small composer-stop" disabled={!connected || stopping} title={escapeAborts ? catalog.session.stopEscapeHint : catalog.session.stopHint} onClick={() => void abort()}>{stopping ? t.stopping : t.stop}</button>
				: <>
					{running && <button type="button" className="btn small composer-send-now" disabled={!canSend} title={t.sendNowHint} onClick={() => void send("steer")}>{t.sendNow}</button>}
					<button type="button" className="btn primary small" disabled={!canSend} title={running ? t.queueHint : undefined} onClick={() => void send("auto")}>{pending ? t.sending : running ? t.queue : t.send}</button>
				</>}
		</div>
		{uploads.map(item => <div className="composer-note composer-upload" role="status" key={item.id}>{item.folder ? t.uploadingFolder(item.name, format.number(item.done), format.number(item.total)) : t.uploadingFile(item.name)}</div>)}
		{note && <div className="composer-note" role="status">{note}</div>}
		{error && <div className="error-text" role="alert">{error}</div>}
	</div>;
}

type QueueKind = keyof SessionStatus["queue"];
interface QueueOp { id: number; kind: "remove" | "promote"; queue: QueueKind; text: string; base: SessionStatus["queue"]; settled: boolean }

/** The server queue with this view's changes applied: pending ones, and settled ones until the server sends a queue that already reflects them. */
function visibleQueue(queue: SessionStatus["queue"], ops: QueueOp[]): SessionStatus["queue"] {
	const next = { steering: [...queue.steering], followUp: [...queue.followUp] };
	for (const op of ops) {
		if (op.settled && op.base !== queue) continue;
		const index = next[op.queue].indexOf(op.text);
		if (index < 0) continue;
		next[op.queue].splice(index, 1);
		if (op.kind === "promote") next.steering.push(op.text);
	}
	return next;
}

export function QueueChips({ sessionId, queue, connected, edit }: { sessionId: string; queue: SessionStatus["queue"]; connected: boolean; edit: (text: string) => void }) {
	const t = useT().session.queue;
	const { format } = useI18n();
	const [ops, setOps] = useState<QueueOp[]>([]);
	const [error, setError] = useState<string | null>(null);
	const nextOp = useRef(0);
	useEffect(() => setOps(current => current.some(op => op.settled && op.base !== queue) ? current.filter(op => !op.settled || op.base === queue) : current), [queue]);
	const run = async (action: "edit" | "remove" | "promote", kind: QueueKind, text: string) => {
		const id = ++nextOp.current;
		const base = `/api/sessions/${encodeURIComponent(sessionId)}/queue`;
		setError(null);
		setOps(current => [...current, { id, kind: action === "promote" ? "promote" : "remove", queue: kind, text, base: queue, settled: false }]);
		try {
			const done = action === "promote"
				? (await api<{ promoted: boolean }>(`${base}/promote`, { body: { message: text } })).promoted
				: (await api<{ removed: boolean }>(`${base}/remove`, { body: { message: text, queue: kind } })).removed;
			if (!done) { setOps(current => current.filter(op => op.id !== id)); setError(t.gone); return; }
			setOps(current => current.map(op => op.id === id ? { ...op, settled: true } : op));
			if (action === "edit") edit(text);
		} catch (cause) {
			setOps(current => current.filter(op => op.id !== id));
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const shown = visibleQueue(queue, ops);
	const chips = (["steering", "followUp"] as const).flatMap(kind => shown[kind].map((text, index) => ({ kind, text, key: `${kind}-${index}-${text}`, parsed: parseAttachmentBlock(text) })));
	return <>
		{chips.length > 0 && <ul className="queue-chips" aria-label={t.label}>{chips.map(({ kind, text, key, parsed }) => <li key={key} className={`queue-chip ${kind}`} title={[parsed.text, ...parsed.attachments.map(item => item.path)].join("\n")}>
			<span className="queue-kind">{kind === "steering" ? t.steering : t.followUp}</span>
			<span className="queue-text">{parsed.text}</span>
			{parsed.attachments.length > 0 && <span className="queue-files">{t.files(parsed.attachments.length, format.number(parsed.attachments.length))}</span>}
			<button type="button" className="queue-action" disabled={!connected} title={t.editHint} onClick={() => void run("edit", kind, text)}>{t.edit}</button>
			{kind === "followUp" && <button type="button" className="queue-action" disabled={!connected} title={t.sendNowHint} onClick={() => void run("promote", kind, text)}>{t.sendNow}</button>}
			<button type="button" className="queue-action queue-remove" disabled={!connected} aria-label={t.remove} title={t.remove} onClick={() => void run("remove", kind, text)}>×</button>
		</li>)}</ul>}
		{error && <div className="queue-error error-text" role="alert">{error}</div>}
	</>;
}
