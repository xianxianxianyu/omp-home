import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatRecordDTO, SearchHit } from "../../shared/api.ts";
import { api } from "./api.ts";
import { useHub } from "./hub.tsx";
import { Button, Empty, Loading, Modal, RelativeTime } from "./ui.tsx";

export function Search({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
	const { openTask } = useHub();
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [view, setView] = useState<SearchHit | null>(null);
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let current = true;
		setHits([]); setSelected(0); setError(null);
		if (!query.trim()) { setLoading(false); return; }
		setLoading(true);
		const timer = window.setTimeout(() => {
			api<SearchHit[]>(`/api/search?q=${encodeURIComponent(query.trim())}`).then(result => { if (current) setHits(result); }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (current) setLoading(false); });
		}, 200);
		return () => { current = false; clearTimeout(timer); };
	}, [query]);
	useEffect(() => {
		const click = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
		document.addEventListener("pointerdown", click);
		return () => document.removeEventListener("pointerdown", click);
	}, []);
	function choose(hit: SearchHit) {
		setOpen(false);
		if (hit.taskId) openTask(hit.taskId); else setView(hit);
	}
	const expanded = open && Boolean(query.trim());
	return <><div className="global-search" ref={container}><span className="search-icon" aria-hidden="true">⌕</span><input ref={inputRef} className="search" placeholder="Search everything…" aria-label="Global search" role="combobox" aria-expanded={expanded} aria-controls="search-results" aria-activedescendant={expanded && hits.length ? `search-hit-${selected}` : undefined} autoComplete="off" value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }} onKeyDown={event => {
		if (event.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
		if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setSelected(index => Math.min(hits.length - 1, index + 1)); }
		if (event.key === "ArrowUp") { event.preventDefault(); setSelected(index => Math.max(0, index - 1)); }
		if (event.key === "Enter" && expanded && hits[selected]) { event.preventDefault(); choose(hits[selected]); }
	}} /><kbd>⌘ K</kbd>{expanded && <div className="search-results" id="search-results" role="listbox">{loading ? <Loading /> : error ? <p className="error-text">{error}</p> : !hits.length ? <Empty title="No matches">Try a task title, report, or phrase from chat.</Empty> : hits.map((hit, index) => <button className={`search-hit ${index === selected ? "selected" : ""}`} id={`search-hit-${index}`} role="option" aria-selected={index === selected} key={`${hit.kind}:${hit.ref}`} onMouseEnter={() => setSelected(index)} onClick={() => choose(hit)}><div className="row"><span className="pill">{hit.kind.replaceAll("_", " ")}</span><strong>{hit.title ?? "Main chat"}</strong><span className="grow" /><span className="dim"><RelativeTime at={hit.at} /></span></div><p>{hit.excerpt}</p></button>)}</div>}</div>{view && <ChatViewer hit={view} onClose={() => setView(null)} />}</>;
}
function ChatViewer({ hit, onClose }: { hit: SearchHit; onClose: () => void }) {
	const [records, setRecords] = useState<ChatRecordDTO[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [before, setBefore] = useState<number | null>(null);
	const [loading, setLoading] = useState(false);
	const match = /^chat:(\d+)$/.exec(hit.ref);
	const id = match ? Number(match[1]) : null;
	useEffect(() => {
		if (hit.kind !== "chat") return;
		if (id === null) { setError("The search result has an invalid chat reference."); return; }
		let current = true;
		setLoading(true); setError(null);
		const request = before === null
			? Promise.all([api<ChatRecordDTO[]>(`/api/chat?before=${id + 1}&limit=10`), api<ChatRecordDTO[]>(`/api/chat?after=${id}&limit=10`)]).then(pages => pages.flat())
			: api<ChatRecordDTO[]>(`/api/chat?before=${before}&limit=20`);
		request.then(result => { if (current) setRecords(result.sort((a, b) => a.id - b.id)); }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (current) setLoading(false); });
		return () => { current = false; };
	}, [before, id, hit.kind]);
	return <Modal title={hit.kind === "chat" ? "Main chat · search context" : hit.title ?? "Search result"} onClose={onClose} wide><div className="card search-context"><div className="eyebrow">MATCH · <RelativeTime at={hit.at} /></div><p className="prewrap">{hit.excerpt}</p></div>{error && <p className="error-text" role="alert">{error}</p>}{loading && <Loading />}{records && <><div className="row"><span className="section-title grow">Recorded conversation · {before === null ? "around this match" : "earlier context"}</span><Button className="small" disabled={!records.length || loading} onClick={() => setBefore(records[0].id)}>Older messages</Button>{before !== null && <Button className="small" onClick={() => setBefore(null)}>Back to match</Button>}</div>{records.length ? records.map(record => <article className={`card chat-record ${record.id === id ? "highlight" : ""}`} key={record.id}><div className="meta"><strong>{record.role}</strong><RelativeTime at={record.at} /><code>#{record.id}</code></div><div className="body">{record.text}</div></article>) : <Empty title="No earlier records" />}</>}</Modal>;
}
