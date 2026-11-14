import { useEffect, useRef, useState } from "react";
import type { SetupPreview } from "../../shared/api.ts";
import { api } from "./api.ts";
import { useHub } from "./hub.tsx";
import { useT } from "./i18n/index.tsx";
import { Button, Field, Loading, Status } from "./ui.tsx";

export function Setup() {
	const t = useT().panels.setup;
	const { mutate, toast, reload } = useHub();
	const [home, setHome] = useState("/Volumes/NVMe2T/project/home");
	const [preview, setPreview] = useState<SetupPreview | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pstack, setPstack] = useState("none");
	const [custom, setCustom] = useState("");
	const [migrate, setMigrate] = useState(true);
	const [starting, setStarting] = useState(false);
	const request = useRef(0);
	async function loadPreview(path: string) {
		const id = ++request.current;
		setLoading(true); setError(null); setPreview(null);
		try {
			const result = await api<SetupPreview>(`/api/setup/preview?home=${encodeURIComponent(path)}`);
			if (id !== request.current) return;
			setPreview(result); setPstack(result.pstackCandidates[0] ?? "none");
		} catch (error) {
			if (id === request.current) { const text = error instanceof Error ? error.message : String(error); setError(text); toast(text, "error"); }
		} finally { if (id === request.current) setLoading(false); }
	}
	useEffect(() => { void loadPreview(home); return () => { request.current++; }; }, []);
	return <main className="setup-shell"><div className="setup"><div className="brand"><span className="dot" />omp-home</div><div className="setup-intro"><span className="eyebrow">{t.eyebrow}</span><h1>{t.title}</h1><p>{t.description}</p></div>
		<form onSubmit={event => { event.preventDefault(); void loadPreview(home); }}><Field label={t.homeRepository} hint={t.homeHint}><div className="row"><input className="grow" required value={home} onChange={event => { setHome(event.target.value); setPreview(null); request.current++; setLoading(false); }} placeholder="/path/to/home" /><Button type="submit" disabled={loading || !home.trim()}>{t.review}</Button></div></Field></form>
		{loading && <Loading />}{error && <p className="error-text" role="alert">{error}</p>}
		{preview && <><div className="row wrap"><Status value={preview.exists ? "exists" : "will create"} /><Status value={preview.isGitRepo ? "git repository" : "not a git repository"} /></div><h2 className="section-title">{t.changes}</h2><div className="setup-changes">{preview.changes.length ? preview.changes.map((change, index) => <div className="change" key={`${change.path}:${index}`}><span className={`pill ${change.action === "replace" ? "warn" : "info"}`}>{t.actions[change.action]}</span><div><code>{change.path}</code><div className="hint">{change.reason}</div></div></div>) : <p className="muted">{t.upToDate}</p>}</div>
		<Field label={t.pstackSkills} hint={t.pstackHint}><select value={pstack} onChange={event => setPstack(event.target.value)}><option value="none">{t.noPstack}</option>{preview.pstackCandidates.map(path => <option key={path} value={path}>{path}</option>)}<option value="custom">{t.customPath}</option></select></Field>{pstack === "custom" && <Field label={t.customRoot}><input value={custom} onChange={event => setCustom(event.target.value)} placeholder="/path/to/pstack" /></Field>}
		<label className="check-row"><input type="checkbox" checked={migrate} onChange={event => setMigrate(event.target.checked)} />{t.migrate}</label>
		<div className="dialog-actions"><span className="hint grow">{t.localFirst}</span><Button className="primary" disabled={starting || (pstack === "custom" && !custom.trim())} onClick={async () => { setStarting(true); try { await mutate("/api/setup", { homePath: preview.homePath, pstackRoot: pstack === "none" ? null : pstack === "custom" ? custom.trim() : pstack, migrateHome: migrate }); reload(); } finally { setStarting(false); } }}>{t.start}</Button></div></>}
	</div></main>;
}
