import { useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, PROMPT_IMAGE_TYPES } from "../../shared/api.ts";
import type { CommandDTO, PromptImage, PromptRequest } from "../../shared/api.ts";
import type { SessionStatus } from "../../shared/transcript.ts";
import { api } from "./api.ts";
import { useHub } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";

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

interface Attachment { id: number; name: string; mimeType: PromptImage["mimeType"]; url: string }
function readDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(file.name));
		reader.onerror = () => reject(reader.error ?? new Error(file.name));
		reader.readAsDataURL(file);
	});
}

export function Composer({ sessionId, connected, running, commands, focused, main, input, text, setText, note, clearNote, abort, stopping, meta, escapeAborts, onNewChat }: { sessionId: string; connected: boolean; running: boolean; commands: CommandDTO[]; focused: boolean; main: boolean; input: RefObject<HTMLTextAreaElement | null>; text: string; setText: Dispatch<SetStateAction<string>>; note: string | null; clearNote: () => void; abort: () => Promise<void>; stopping: boolean; meta: string; escapeAborts: boolean; onNewChat?: () => void }) {
	const catalog = useT();
	const t = catalog.session.composer;
	const shell = catalog.shell.app;
	const { format } = useI18n();
	const { noteComposerInput } = useHub();
	const [images, setImages] = useState<Attachment[]>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState(false);
	const [dragging, setDragging] = useState(false);
	const files = useRef<HTMLInputElement>(null);
	const nextImage = useRef(0);
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
	const hasContent = text.trim() !== "" || images.length > 0;
	const canSend = connected && !pending && hasContent;
	useEffect(() => { if (focused && !main) input.current?.focus(); }, [focused, main, input]);
	useEffect(() => { const focus = () => { if (main) input.current?.focus(); }; window.addEventListener("focus-main", focus); return () => window.removeEventListener("focus-main", focus); }, [main, input]);
	const attach = async (list: File[]) => {
		if (!list.length) return;
		const limit = `${format.number(MAX_PROMPT_IMAGE_BYTES / 1024 / 1024)} MB`;
		const accepted: { file: File; mimeType: PromptImage["mimeType"] }[] = [];
		let problem: string | null = null;
		for (const file of list) {
			const mimeType = PROMPT_IMAGE_TYPES.find(value => value === file.type);
			if (!mimeType) problem = t.imageType;
			else if (file.size > MAX_PROMPT_IMAGE_BYTES) problem = t.imageTooLarge(file.name, limit);
			else accepted.push({ file, mimeType });
		}
		const room = Math.max(0, MAX_PROMPT_IMAGES - images.length);
		if (accepted.length > room) problem = t.tooManyImages(format.number(MAX_PROMPT_IMAGES));
		const added: Attachment[] = [];
		for (const { file, mimeType } of accepted.slice(0, room)) {
			try { added.push({ id: ++nextImage.current, name: file.name, mimeType, url: await readDataUrl(file) }); }
			catch { problem = t.imageReadError(file.name); }
		}
		if (added.length) setImages(current => [...current, ...added].slice(0, MAX_PROMPT_IMAGES));
		setError(problem);
	};
	const send = async (mode: "auto" | "steer") => {
		if (!canSend || composing.current) return;
		const sent = { text, images };
		const body: PromptRequest = { text, mode: running ? mode : "auto", ...(images.length ? { images: images.map(image => ({ data: image.url.slice(image.url.indexOf(",") + 1), mimeType: image.mimeType })) } : {}) };
		// Clear right away so typing can continue; a failed send puts the message back ahead of anything typed since.
		setPending(true); setError(null); clearNote(); setText(""); setImages([]); setMenuDismissed(false);
		if (text.trim()) localStorage.setItem(lastSentKey(sessionId), text);
		try { await api(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { body }); }
		catch (cause) {
			setText(current => appendParagraphs(sent.text, [current]));
			setImages(current => [...sent.images, ...current].slice(0, MAX_PROMPT_IMAGES));
			setError(cause instanceof Error ? cause.message : String(cause));
		}
		finally { setPending(false); }
	};
	const chooseCommand = (command: CommandDTO) => { setText(`/${command.name} `); setMenuDismissed(false); input.current?.focus(); noteComposerInput(); };
	return <div className={`composer ${dragging ? "dragging" : ""}`} onDragOver={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDragging(false); }} onDrop={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDragging(false); void attach([...event.dataTransfer.files]); }}>
		{menuOpen && <div className="command-menu" role="listbox" aria-label={t.slashCommands}>{matches.map((command, index) => <button role="option" aria-selected={index === selected} key={command.name} className={index === selected ? "selected" : ""} onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command)}><strong>/{command.name}</strong><span>{command.description ?? command.source}</span></button>)}</div>}
		{images.length > 0 && <div className="composer-images">{images.map(image => <figure className="composer-image" key={image.id}><img src={image.url} alt={image.name} /><button type="button" aria-label={t.removeImage(image.name)} title={t.removeImage(image.name)} onClick={() => setImages(current => current.filter(item => item.id !== image.id))}>×</button></figure>)}</div>}
		<textarea ref={input} aria-label={t.messageLabel(sessionId)} placeholder={running ? t.runningPlaceholder : t.placeholder} value={text} rows={2} onChange={event => { setText(event.target.value); setSelected(0); setMenuDismissed(false); clearNote(); noteComposerInput(); }} onCompositionStart={() => { composing.current = true; noteComposerInput(); }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = performance.now(); }} onPaste={event => {
			const pasted = [...event.clipboardData.files].filter(file => file.type.startsWith("image/"));
			if (!pasted.length || event.clipboardData.types.includes("text/plain")) return;
			event.preventDefault(); void attach(pasted);
		}} onKeyDown={event => {
			if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (menuOpen) setMenuDismissed(true); else if (running && escapeAborts) void abort(); return; }
			if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSelected(index => (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); return; }
			if (menuOpen && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) { if (performance.now() - compositionEnded.current < 80) return; event.preventDefault(); chooseCommand(matches[selected] ?? matches[0]); return; }
			if (event.key === "ArrowUp" && !text && !images.length && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
				const last = localStorage.getItem(lastSentKey(sessionId));
				if (last) { event.preventDefault(); setText(last); }
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (performance.now() - compositionEnded.current >= 80) void send(event.metaKey || event.ctrlKey ? "steer" : "auto"); }
		}} />
		<div className="composer-actions">
			<button type="button" className="icon-button composer-attach" aria-label={t.attach} title={t.attachHint} onClick={() => files.current?.click()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg></button>
			<input ref={files} type="file" accept={PROMPT_IMAGE_TYPES.join(",")} multiple hidden onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ""; }} />
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
	const chips = (["steering", "followUp"] as const).flatMap(kind => shown[kind].map((text, index) => ({ kind, text, key: `${kind}-${index}-${text}` })));
	return <>
		{chips.length > 0 && <ul className="queue-chips" aria-label={t.label}>{chips.map(({ kind, text, key }) => <li key={key} className={`queue-chip ${kind}`} title={text}>
			<span className="queue-kind">{kind === "steering" ? t.steering : t.followUp}</span>
			<span className="queue-text">{text}</span>
			<button type="button" className="queue-action" disabled={!connected} title={t.editHint} onClick={() => void run("edit", kind, text)}>{t.edit}</button>
			{kind === "followUp" && <button type="button" className="queue-action" disabled={!connected} title={t.sendNowHint} onClick={() => void run("promote", kind, text)}>{t.sendNow}</button>}
			<button type="button" className="queue-action queue-remove" disabled={!connected} aria-label={t.remove} title={t.remove} onClick={() => void run("remove", kind, text)}>×</button>
		</li>)}</ul>}
		{error && <div className="queue-error error-text" role="alert">{error}</div>}
	</>;
}
