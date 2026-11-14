import { useState } from "react";
import type { FormEvent } from "react";
import { parseDocument } from "yaml";
import type { FieldError, RepoInspection, RepoSuggestion, SettingsDTO, WorkspaceCreate, WorkspaceDTO } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { useHub, useResource } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { ModelPicker, useModelCatalog } from "../ModelPicker.tsx";
import { RecipeSummary, readRecipeSummary } from "../RecipeSummary.tsx";
import { Button, Empty, ErrorState, Field, Loading, Section, useNow } from "../ui.tsx";

export function AddRepository({ onClose, onAdded, onOpen }: { onClose: () => void; onAdded: (workspace: WorkspaceDTO) => void; onOpen: (id: string) => void }) {
	const t = useT().panels.workspaces;
	const [path, setPath] = useState<string | null>(null);
	return <div className="stack add-repository">
		<div className="panel-heading"><div><h2>{t.add}</h2><p>{t.chooseHint}</p></div><Button onClick={onClose}>{t.backToWorkspaces}</Button></div>
		<ol className="repo-steps" aria-label={t.add}>
			<li aria-current={path === null ? "step" : undefined}><span>1</span>{t.chooseStep}</li>
			<li aria-current={path !== null ? "step" : undefined}><span>2</span>{t.reviewStep}</li>
		</ol>
		{path === null ? <RepositoryChoices onChoose={setPath} /> : <InspectRepository key={path} path={path} onBack={() => setPath(null)} onAdded={onAdded} onOpen={onOpen} />}
	</div>;
}

function RepositoryChoices({ onChoose }: { onChoose: (path: string) => void }) {
	const t = useT().panels.workspaces;
	const suggestions = useResource<RepoSuggestion[]>("workspaces", "/api/workspaces/suggestions");
	const [manual, setManual] = useState(false);
	const [path, setPath] = useState("");
	const [picking, setPicking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function pick() {
		setPicking(true);
		setError(null);
		try {
			const options = { title: t.chooseFolderTitle, ...(path.trim() ? { defaultPath: path.trim() } : {}) };
			const chosen: unknown = window.__TAURI__?.core
				? await window.__TAURI__.core.invoke("plugin:dialog|open", { options: { ...options, directory: true, multiple: false } })
				: (await api<{ path: string | null }>("/api/pick-folder", { body: options })).path;
			if (typeof chosen === "string") onChoose(chosen);
			else if (chosen !== null) throw new Error(t.pickError);
		} catch (error) { setError(error instanceof Error ? error.message : t.pickError); }
		finally { setPicking(false); }
	}
	return <div className="stack repo-choose">
		<div className="repo-folder-choice"><Button className="primary choose-folder" onClick={pick} disabled={picking}>{t.chooseFolder}</Button><p className="hint">{t.folderHint}</p></div>
		{error && <p className="error-box" role="alert">{error}</p>}
		<Section title={t.suggestions}>
			<p className="muted">{t.suggestionsHint}</p>
			{suggestions.loading && !suggestions.data && <Loading />}
			{suggestions.error && <ErrorState error={suggestions.error} retry={suggestions.reload} />}
			{suggestions.data?.length === 0 && <Empty title={t.noRepositories}>{t.noRepositoriesHint}</Empty>}
			<div className="repo-suggestions">{suggestions.data?.map(suggestion => <button type="button" className="repo-suggestion" data-repo-path={suggestion.path} key={suggestion.path} disabled={picking || suggestion.registeredAs !== null} onClick={() => onChoose(suggestion.path)}>
				<span className="repo-suggestion-main"><strong>{suggestion.name}</strong><code>{suggestion.path}</code><OmpActivity sessions={suggestion.ompSessions} lastUsedAt={suggestion.lastUsedAt} lastTitle={suggestion.lastTitle} /></span>
				<span className="repo-suggestion-badges"><span className="pill">{t.sources[suggestion.source]}</span>{suggestion.registeredAs && <span className="pill ok">{t.candidateAdded}</span>}</span>
			</button>)}</div>
		</Section>
		{!manual ? <button type="button" className="link-button enter-repo-path" disabled={picking} onClick={() => setManual(true)}>{t.enterPath}</button> : <form className="repo-manual-path" onSubmit={event => { event.preventDefault(); if (path.trim()) onChoose(path.trim()); }}>
			<Field label={t.repositoryPath} hint={t.repositoryHint}><input autoFocus required value={path} onChange={event => setPath(event.target.value)} disabled={picking} placeholder="/path/to/repository" /></Field>
			<Button type="submit" disabled={picking || !path.trim()}>{t.reviewFolder}</Button>
		</form>}
	</div>;
}

function InspectRepository({ path, onBack, onAdded, onOpen }: { path: string; onBack: () => void; onAdded: (workspace: WorkspaceDTO) => void; onOpen: (id: string) => void }) {
	const t = useT().panels.workspaces;
	const inspection = useResource<RepoInspection>("workspaces", `/api/workspaces/inspect?path=${encodeURIComponent(path)}`);
	if (inspection.error) return <div className="stack"><ErrorState error={inspection.error} retry={inspection.reload} /><Button onClick={onBack}>{t.chooseAnother}</Button></div>;
	if (!inspection.data) return <div className="repo-inspecting" role="status" aria-busy="true"><p><span className="spinner" /> {t.inspecting}</p><code className="prewrap">{path}</code><div className="repo-skeleton" /><div className="repo-skeleton" /><div className="repo-skeleton" /><Button onClick={onBack}>{t.chooseAnother}</Button></div>;
	const repo = inspection.data;
	if (!repo.root) return <div className="card repo-not-git"><h3>{t.notGit}</h3><code className="prewrap">{path}</code><p className="muted">{t.notGitHint}</p><Button className="primary" onClick={onBack}>{t.chooseAnother}</Button></div>;
	if (repo.registeredAs) return <div className="card repo-already-added"><h3>{t.alreadyRegistered}</h3><code className="prewrap">{repo.root}</code><p className="muted">{t.alreadyRegisteredHint}</p><div className="actions"><Button onClick={onBack}>{t.chooseAnother}</Button><Button className="primary" onClick={() => onOpen(repo.registeredAs!)}>{t.openRepository}</Button></div></div>;
	return <RepositoryReview repo={repo} onBack={onBack} onAdded={onAdded} />;
}

export function BranchPicker({ branches, value, onChange, disabled }: { branches: RepoInspection["branches"]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
	const t = useT().panels.workspaces;
	return <Field label={t.defaultBase} hint={branches.length ? t.baseHint : t.noBranches}>
		<select aria-label={t.defaultBase} value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
			{!value && <option value="">{t.repositoryDefault}</option>}
			{value && !branches.some(branch => branch.name === value) && <option value={value}>{value}</option>}
			{branches.map(branch => <option key={branch.name} value={branch.name}>{branch.remote ? t.remoteBranch(branch.name) : branch.name}</option>)}
		</select>
	</Field>;
}

function OmpActivity({ sessions, lastUsedAt, lastTitle }: RepoInspection["omp"]) {
	const t = useT().panels.workspaces;
	const { format } = useI18n();
	const now = useNow();
	return <span className="repo-activity muted">{t.ompActivity(sessions, format.number(sessions), lastUsedAt === null ? null : format.relativeTime(lastUsedAt, now), lastTitle)}</span>;
}

function RepositoryReview({ repo, onBack, onAdded }: { repo: RepoInspection; onBack: () => void; onAdded: (workspace: WorkspaceDTO) => void }) {
	const t = useT().panels;
	const { mutate, toast } = useHub();
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const catalog = useModelCatalog();
	const [name, setName] = useState(repo.name);
	const [base, setBase] = useState(repo.defaultBase ?? "");
	const [workerModel, setWorkerModel] = useState<string | null>(null);
	const [recipe, setRecipe] = useState(repo.recipeDraft ?? "");
	const canCreateRecipe = !repo.hasRecipe && repo.recipeDraft !== null;
	const [createRecipe, setCreateRecipe] = useState(canCreateRecipe);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
	const root = repo.root!;
	const worktreeParent = settings.data?.worktreeRoot ?? root.slice(0, root.lastIndexOf("/"));
	const worktreePath = `${worktreeParent.replace(/\/$/, "")}/${root.split("/").at(-1)}.worktrees`;
	function toggleCopy(path: string, checked: boolean) {
		const summary = readRecipeSummary(recipe);
		if (!summary) return;
		const document = parseDocument(recipe);
		document.set("copy", checked ? [...summary.copy, path] : summary.copy.filter(file => file !== path));
		setRecipe(document.toString());
	}
	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (saving) return;
		setSaving(true); setError(null); setFieldErrors([]);
		try {
			const body: WorkspaceCreate = { repoPath: root, id: repo.id, name: name.trim(), ...(base ? { defaultBase: base } : {}), workerModel, ...(createRecipe && canCreateRecipe ? { recipe } : {}) };
			const workspace = await mutate<WorkspaceDTO>("/api/workspaces", body);
			toast(t => t.panels.workspaces.added);
			if (workspace.recipeStatus === "ok") {
				try { await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/recipe/check`, { method: "POST" }); }
				catch (error) { toast(t => t.panels.workspaces.checkStartError(error instanceof Error ? error.message : String(error)), "error"); }
			}
			onAdded(workspace);
		} catch (error) { setError(error instanceof Error ? error.message : t.workspaces.saveError); if (error instanceof ApiError) setFieldErrors(error.errors); }
		finally { setSaving(false); }
	}
	return <form className="stack repo-review" onSubmit={event => { void save(event); }}>
		<div className="repo-detected"><code className="prewrap">{root}</code>{repo.remoteUrl && <span className="muted prewrap">{repo.remoteUrl}</span>}<div className="row wrap" aria-label={t.workspaces.detectedStack}>{repo.stack.map(stack => <span className="pill" key={stack}>{stack}</span>)}</div></div>
		<div className="two-col">
			<Field label={t.workspaces.name}><input autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={saving} /></Field>
			<BranchPicker branches={repo.branches} value={base} onChange={setBase} disabled={saving} />
			<ModelPicker label={t.models.workerModel} value={workerModel} onChange={setWorkerModel} catalog={catalog.data} disabled={saving} defaultLabel={t.workspaces.workersDefault} defaultModel={settings.data?.workerModel ?? catalog.data?.defaultModel} />
		</div>
		{catalog.error && <ErrorState error={catalog.error} retry={catalog.reload} />}
		{catalog.data?.error && <p className="error-text" role="alert">{catalog.data.error}</p>}
		{settings.error && <ErrorState error={settings.error} retry={settings.reload} />}
		<div className="repo-facts card">
			<h3>{t.workspaces.existingActivity}</h3>
			<OmpActivity {...repo.omp} />
			{repo.worktrees.length ? <ul className="repo-worktrees">{repo.worktrees.map(worktree => <li key={worktree.path}><code>{worktree.branch ?? t.workspaces.detachedHead}</code><code className="muted">{worktree.path}</code></li>)}</ul> : <p className="muted">{t.workspaces.noWorktrees}</p>}
			{settings.data && <p className="hint">{t.workspaces.ownWorktrees}<br /><code>{worktreePath}</code></p>}
			{repo.dirty && <p className="repo-dirty">{t.workspaces.dirtyHint}</p>}
		</div>
		<div className="repo-recipe card">
			<label className="row"><input type="checkbox" checked={createRecipe} disabled={saving || !canCreateRecipe} onChange={event => setCreateRecipe(event.target.checked)} /><strong>{t.workspaces.createRecipe}</strong></label>
			{!canCreateRecipe && <p className="hint">{repo.hasRecipe ? t.workspaces.recipeExists : t.workspaces.noRecipeDraft}</p>}
			{repo.commands.dev && <p className="hint">{t.workspaces.devCommand}: <code>{repo.commands.dev}</code></p>}
			{repo.recipeDraft !== null && <><RecipeSummary text={recipe} detectedCopy={repo.copy} onCopyChange={canCreateRecipe ? toggleCopy : undefined} disabled={saving || !createRecipe} /><details className="repo-yaml"><summary>{t.workspaces.showYaml}</summary><Field label={t.workspaces.recipeYaml} hint={t.workspaces.recipeHint}><textarea className="code-editor" rows={10} value={recipe} onChange={event => setRecipe(event.target.value)} disabled={saving || !createRecipe} spellCheck={false} autoCapitalize="off" autoCorrect="off" /></Field></details></>}
			{(createRecipe || repo.hasRecipe) && <p className="hint">{t.workspaces.autoCheckHint}</p>}
		</div>
		{error && <div className="error-box" role="alert"><p>{error}</p>{fieldErrors.length > 0 && <ul>{fieldErrors.map((field, index) => <li key={index}><code>{field.path}</code>: {field.message}</li>)}</ul>}</div>}
		<div className="dialog-actions repo-review-actions"><Button onClick={onBack} disabled={saving}>{t.workspaces.chooseAnother}</Button><Button type="submit" className="primary" disabled={saving || !name.trim() || (createRecipe && !recipe.trim())}>{saving ? t.workspaces.adding : t.workspaces.add}</Button></div>
	</form>;
}
