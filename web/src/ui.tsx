import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHub } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";

export function Button({ children, onClick, className = "", disabled, type = "button", title }: { children: ReactNode; onClick?: () => void | Promise<unknown>; className?: string; disabled?: boolean; type?: "button" | "submit"; title?: string }) {
	const [busy, setBusy] = useState(false);
	return <button type={type} className={`btn ${className}`} title={title} disabled={disabled || busy} aria-busy={busy} onClick={async () => {
		if (!onClick) return;
		setBusy(true);
		try { await onClick(); } catch { /* Mutation errors are surfaced by the hub. */ } finally { setBusy(false); }
	}}>{busy && <span className="spinner" aria-hidden="true" />}{children}</button>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
	return <div className="empty"><div className="empty-mark" aria-hidden="true">—</div><h3>{title}</h3>{children && <div>{children}</div>}</div>;
}
export function Loading() { const t = useT().common; return <div className="loading" role="status"><span className="spinner" /> {t.loading}</div>; }
export function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
	const t = useT().common;
	return <div className="error-box" role="alert"><strong>{t.loadError}</strong><p>{error.message}</p><Button onClick={retry}>{t.tryAgain}</Button></div>;
}
export function Status({ value }: { value: string }) {
	const t = useT().common;
	const tone = /^(done|idle|up|ready|ok)$/.test(value) ? "ok" : /^(awaiting|approval|paused|question|blocked|missing|starting|preparing)$/.test(value) ? "warn" : /^(failed|error|invalid|interrupted|provision_failed)$/.test(value) ? "err" : /^(working|running)$/.test(value) ? "info" : "";
	return <span className={`pill ${tone}`}>{t.status[value as keyof typeof t.status] ?? value}</span>;
}
export function useNow() {
	const [now, setNow] = useState(Date.now);
	useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
	return now;
}
export function RelativeTime({ at }: { at: number | null }) {
	const now = useNow();
	const t = useT().common;
	const { format } = useI18n();
	if (at === null) return <span className="dim">{t.never}</span>;
	return <time title={format.dateTime(at)} dateTime={new Date(at).toISOString()}>{format.relativeTime(at, now)}</time>;
}
export function Modal({ title, onClose, children, wide, className = "", headerActions }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; headerActions?: ReactNode }) {
	const t = useT().common;
	const id = useId();
	const dialog = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const root = dialog.current;
		if (!root) return;
		const focusables = () => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
		(focusables()[0] ?? root).focus();
		const key = (event: KeyboardEvent) => {
			if ([...document.querySelectorAll("[data-modal]")].at(-1) !== root) return;
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
			if (event.key === "Tab") {
				const items = focusables();
				const first = items[0] ?? root;
				const last = items.at(-1) ?? root;
				if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
				else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
			}
		};
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
	}, []);
	return createPortal(<div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div data-modal ref={dialog} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className={`dialog ${wide ? "wide" : ""} ${className}`}><header className="dialog-head"><h2 id={id}>{title}</h2><div className="row">{headerActions}<button className="icon-button" onClick={onClose} aria-label={t.closeDialog}>×</button></div></header>{children}</div></div>, document.body);
}
export function Confirm({ title, description, confirmLabel, danger = false, onConfirm, onClose }: { title: string; description: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<unknown>; onClose: () => void }) {
	const t = useT().common;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return <Modal title={title} onClose={() => { if (!busy) onClose(); }}><div className="confirm-description">{description}</div>{error && <p className="error-text" role="alert">{error}</p>}<div className="dialog-actions"><Button disabled={busy} onClick={onClose}>{t.keepAsIs}</Button><Button disabled={busy} className={danger ? "danger" : "primary"} onClick={async () => { setBusy(true); setError(null); try { await onConfirm(); onClose(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}>{confirmLabel ?? t.confirm}</Button></div></Modal>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
	return <div className="field"><label><span className="field-label">{label}</span>{children}</label>{hint && <div className="hint">{hint}</div>}</div>;
}
export function Section({ title, children }: { title: string; children: ReactNode }) { return <section><h3 className="section-title">{title}</h3>{children}</section>; }
export function CopyButton({ text }: { text: string }) {
	const t = useT().common;
	const { toast } = useHub();
	return <Button className="small" title={t.copyToClipboard} onClick={async () => { try { await navigator.clipboard.writeText(text); toast(t => t.common.copied); } catch (error) { toast(error instanceof Error ? error.message : t => t.common.clipboardError, "error"); } }}>{t.copy}</Button>;
}
