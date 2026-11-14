import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { FieldError, RecipeDTO, ScanCandidate, SettingsDTO, WorkspaceCreate, WorkspaceDTO, WorkspacePatch } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { useHub, useResource } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { getT } from "../i18n/runtime.ts";
import { Button, Confirm, CopyButton, Empty, ErrorState, Field, Loading, Modal, Section, Status } from "../ui.tsx";
import { ModelPicker, useModelCatalog } from "../ModelPicker.tsx";

const RECIPE_EXAMPLE = `# Environment recipe for this workspace.
# Uncomment and adapt only the settings your project needs.
version: 1
# env:
#   NODE_ENV: test
#   PROJECT_DIR: "{worktree}"
# setup:
#   - "cd {worktree} && npm ci"
# teardown:
#   - "echo Cleaning up {branch}"
`;

export function WorkspacesPanel() {
	const t = useT().panels;
	const { format } = useI18n();
	const { data, error, loading, reload } = useResource<WorkspaceDTO[]>("workspaces", "/api/workspaces");
	const { mutate, toast } = useHub();
	const [editor, setEditor] = useState<WorkspaceDTO | "new" | null>(null);
	const [recipe, setRecipe] = useState<WorkspaceDTO | null>(null);
	const [archive, setArchive] = useState<WorkspaceDTO | null>(null);

	return (
		<div className="stack">
			<div className="panel-heading">
				<div><h2>{t.workspaces.title}</h2><p className="muted">{t.workspaces.description}</p></div>
				<Button className="primary" onClick={() => setEditor("new")}>{t.workspaces.add}</Button>
			</div>
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data?.length === 0 && <Empty title={t.workspaces.empty}>{t.workspaces.emptyDescription}</Empty>}
			{data?.map((workspace) => (
				<article className="card" key={workspace.id}>
					<div className="row wrap">
						<h3 className="grow">{workspace.name} <span className="muted mono">{workspace.id}</span></h3>
						{workspace.archived && <Status value="archived" />}
						<span className="row"><span className="muted">{t.common.recipe}</span><Status value={workspace.recipeStatus} /></span>
					</div>
					<div className="row wrap"><code className="prewrap grow">{workspace.repoPath}</code><CopyButton text={workspace.repoPath} /></div>
					<div className="meta">
						<span>{t.workspaces.base} <code>{workspace.defaultBase}</code></span>
						<span>{t.workspaces.sessionCounts(format.number(workspace.liveSessions), format.number(workspace.totalSessions))}</span>
						<span>{t.workspaces.openTasks(workspace.openTasks, format.number(workspace.openTasks))}</span>
						<span>{t.workspaces.worker(workspace.workerModel ?? t.workspaces.settingsDefault)}</span>
					</div>
					<div className="actions">
						<Button className="small" onClick={() => setRecipe(workspace)}>{t.workspaces.environmentRecipe}</Button>
						<Button className="small" onClick={() => setEditor(workspace)}>{t.common.edit}</Button>
						{!workspace.archived && <Button className="small danger" onClick={() => setArchive(workspace)}>{t.workspaces.archive}</Button>}
					</div>
				</article>
			))}
			{editor && <WorkspaceEditor workspace={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} />}
			{recipe && <RecipeEditor workspace={recipe} onClose={() => setRecipe(null)} />}
			{archive && (
				<Confirm
					title={t.workspaces.archiveTitle(archive.name)}
					description={t.workspaces.archiveDescription}
					confirmLabel={t.workspaces.archiveWorkspace}
					danger
					onClose={() => setArchive(null)}
					onConfirm={async () => {
						await mutate(`/api/workspaces/${encodeURIComponent(archive.id)}/archive`);
						toast(t => t.panels.workspaces.archived(archive.name));
						setArchive(null);
					}}
				/>
			)}
		</div>
	);
}

function WorkspaceEditor({ workspace, onClose }: { workspace?: WorkspaceDTO; onClose: () => void }) {
	const t = useT().panels;
	const { format } = useI18n();
	const { mutate, toast } = useHub();
	const catalog = useModelCatalog();
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const [repoPath, setRepoPath] = useState(workspace?.repoPath ?? "");
	const [name, setName] = useState(workspace?.name ?? "");
	const [id, setId] = useState("");
	const [defaultBase, setDefaultBase] = useState(workspace?.defaultBase ?? "");
	const [workerModel, setWorkerModel] = useState(workspace?.workerModel ?? "");
	const [saving, setSaving] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
	const [candidates, setCandidates] = useState<ScanCandidate[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scanning, setScanning] = useState(false);
	const [adding, setAdding] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	const busy = saving || scanning || adding;

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setSaving(true);
		setFormError(null);
		setFieldErrors([]);
		try {
			if (workspace) {
				const patch: WorkspacePatch = { name: name.trim(), defaultBase: defaultBase.trim(), workerModel: workerModel.trim() || null };
				await mutate(`/api/workspaces/${encodeURIComponent(workspace.id)}`, patch, "PATCH");
			} else {
				const body: WorkspaceCreate = {
					repoPath: repoPath.trim(),
					...(name.trim() ? { name: name.trim() } : {}),
					...(id.trim() ? { id: id.trim() } : {}),
					...(defaultBase.trim() ? { defaultBase: defaultBase.trim() } : {}),
					...(workerModel.trim() ? { workerModel: workerModel.trim() } : {}),
				};
				await mutate("/api/workspaces", body);
			}
			toast(t => workspace ? t.panels.workspaces.updated : t.panels.workspaces.added);
			onClose();
		} catch (error) {
			setFormError(error instanceof Error ? error.message : t.workspaces.saveError);
			if (error instanceof ApiError) setFieldErrors(error.errors);
		} finally {
			setSaving(false);
		}
	}

	async function scan() {
		setScanning(true);
		setScanError(null);
		try {
			const found = await mutate<ScanCandidate[]>("/api/workspaces/scan");
			setCandidates(found);
			setSelected(new Set(found.filter((candidate) => candidate.isGitRepo && !candidate.alreadyAdded).map((candidate) => candidate.repoPath)));
		} catch (error) {
			setScanError(error instanceof Error ? error.message : t.workspaces.scanError);
		} finally {
			setScanning(false);
		}
	}

	async function addSelected() {
		setAdding(true);
		setScanError(null);
		let added = 0;
		let failed = 0;
		try {
			for (const candidate of candidates ?? []) {
				if (!selected.has(candidate.repoPath) || candidate.alreadyAdded || !candidate.isGitRepo) continue;
				try {
					await mutate("/api/workspaces", { repoPath: candidate.repoPath, name: candidate.name } satisfies WorkspaceCreate);
					added++;
					setCandidates((current) => current?.map((item) => item.repoPath === candidate.repoPath ? { ...item, alreadyAdded: true } : item) ?? null);
					setSelected((current) => {
						const next = new Set(current);
						next.delete(candidate.repoPath);
						return next;
					});
				} catch {
					failed++;
				}
			}
			if (added) toast((t, format) => t.panels.workspaces.addedCount(added, format.number(added)));
			if (failed) setScanError(t.workspaces.failedCount(failed, format.number(failed)));
		} finally {
			setAdding(false);
		}
	}

	return (
		<Modal title={workspace ? t.workspaces.editTitle(workspace.name) : t.workspaces.add} onClose={onClose}>
			<form onSubmit={(event) => { void save(event); }}>
				{workspace ? (
					<p className="muted prewrap"><code>{workspace.id}</code> · <code>{workspace.repoPath}</code><br />{t.workspaces.immutableIdentity}</p>
				) : (
					<Field label={t.workspaces.repositoryPath} hint={t.workspaces.repositoryHint}>
						<input autoFocus required value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/path/to/repository" disabled={busy} />
					</Field>
				)}
				<div className="two-col">
					<Field label={workspace ? t.workspaces.name : t.workspaces.optionalName} hint={workspace ? undefined : t.workspaces.nameHint}>
						<input autoFocus={!!workspace} required={!!workspace} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
					</Field>
					{!workspace && <Field label={t.workspaces.optionalId} hint={t.workspaces.idHint}><input value={id} onChange={(event) => setId(event.target.value)} disabled={busy} /></Field>}
					<Field label={workspace ? t.workspaces.defaultBase : t.workspaces.optionalBase} hint={t.workspaces.baseHint}>
						<input required={!!workspace} value={defaultBase} onChange={(event) => setDefaultBase(event.target.value)} placeholder={t.workspaces.repositoryDefault} disabled={busy} />
					</Field>
					<ModelPicker label={t.models.workerModel} value={workerModel || null} storedValue={workspace?.workerModel} onChange={selector => setWorkerModel(selector ?? "")} catalog={catalog.data} disabled={busy} defaultLabel={t.workspaces.workersDefault} defaultModel={settings.data?.workerModel ?? catalog.data?.defaultModel} />
				</div>
				<p className="hint">{t.workspaces.workersHint}</p>
				{catalog.error && <ErrorState error={catalog.error} retry={catalog.reload} />}
				{catalog.data?.error && <p className="error-text" role="alert">{catalog.data.error}</p>}
				{formError && <div className="error-box" role="alert"><p>{formError}</p>{fieldErrors.length > 0 && <ul>{fieldErrors.map((error, index) => <li key={`${error.path}:${index}`}><code>{error.path || t.common.workspace}</code>: {error.message}</li>)}</ul>}</div>}
				<div className="dialog-actions">
					<Button onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
					<Button type="submit" className="primary" disabled={busy}>{saving ? t.common.saving : workspace ? t.workspaces.save : t.workspaces.add}</Button>
				</div>
			</form>
			{!workspace && <Section title={t.workspaces.discover}>
				<p className="muted">{t.workspaces.discoverHint}</p>
				<Button onClick={scan} disabled={busy}>{scanning ? t.workspaces.scanning : t.workspaces.scan}</Button>
				{scanError && <p className="error-box" role="alert">{scanError}</p>}
				{candidates?.length === 0 && <Empty title={t.workspaces.noRepositories}>{t.workspaces.noRepositoriesHint}</Empty>}
				{candidates && candidates.length > 0 && <div className="stack">
					{candidates.map((candidate) => <label className="card row" key={candidate.repoPath}>
						<input
							type="checkbox"
							checked={selected.has(candidate.repoPath)}
							disabled={busy || candidate.alreadyAdded || !candidate.isGitRepo}
							onChange={(event) => {
								const checked = event.target.checked;
								setSelected((current) => {
									const next = new Set(current);
									if (checked) next.add(candidate.repoPath); else next.delete(candidate.repoPath);
									return next;
								});
							}}
						/>
						<span className="grow"><strong>{candidate.name}</strong><br /><code className="prewrap muted">{candidate.repoPath}</code></span>
						{candidate.alreadyAdded ? <span className="pill ok">{t.workspaces.candidateAdded}</span> : !candidate.isGitRepo ? <span className="pill warn">{t.workspaces.notGit}</span> : null}
					</label>)}
					<div className="actions"><Button className="primary" disabled={busy || selected.size === 0} onClick={addSelected}>{adding ? t.workspaces.adding : t.workspaces.addSelected(format.number(selected.size))}</Button></div>
				</div>}
			</Section>}
		</Modal>
	);
}


function RecipeEditor({ workspace, onClose }: { workspace: WorkspaceDTO; onClose: () => void }) {
	const t = useT().panels;
	const { mutate, toast } = useHub();
	const [recipe, setRecipe] = useState<RecipeDTO | null>(null);
	const [text, setText] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<Error | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [revision, setRevision] = useState(0);
	const [saving, setSaving] = useState(false);
	const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/recipe`;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		void api<RecipeDTO>(path).then((result) => {
			if (cancelled) return;
			setRecipe(result);
			setText(result.status === "missing" ? RECIPE_EXAMPLE : result.text);
			setErrors(result.errors);
		}).catch((error: unknown) => {
			if (!cancelled) setLoadError(error instanceof Error ? error : new Error(getT().panels.workspaces.recipeLoadError));
		}).finally(() => {
			if (!cancelled) setLoading(false);
		});
		return () => { cancelled = true; };
	}, [path, revision]);

	async function save() {
		setSaving(true);
		setSaveError(null);
		setErrors([]);
		try {
			const result = await mutate<RecipeDTO>(path, { text }, "PUT");
			setRecipe(result);
			setText(result.text);
			setErrors(result.errors);
			toast(t => t.panels.workspaces.recipeSaved);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : t.workspaces.recipeSaveError);
			if (error instanceof ApiError) setErrors(error.errors);
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal title={t.workspaces.recipeTitle(workspace.name)} onClose={onClose} wide>
			{loading ? <Loading /> : loadError ? <ErrorState error={loadError} retry={() => setRevision((current) => current + 1)} /> : recipe && <>
				<div className="row wrap"><code className="prewrap grow muted">{recipe.path}</code><CopyButton text={recipe.path} /><Status value={recipe.status} /></div>
				{recipe.status === "missing" && <p className="hint">{t.workspaces.noRecipeHint}</p>}
				<Field label={t.workspaces.recipeYaml} hint={t.workspaces.recipeHint}>
					<textarea className="code-editor" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={18} disabled={saving} />
				</Field>
				{(saveError || errors.length > 0) && <div className="error-box" role="alert">{saveError && <p>{saveError}</p>}{errors.length > 0 && <ul>{errors.map((error, index) => <li key={`${error.path}:${index}`}><code>{error.path || t.common.recipe}</code>: {error.message}</li>)}</ul>}</div>}
				<div className="dialog-actions"><Button onClick={onClose} disabled={saving}>{t.common.close}</Button><Button className="primary" onClick={save} disabled={saving || (recipe.status !== "missing" && text === recipe.text)}>{saving ? t.common.saving : t.workspaces.saveRecipe}</Button></div>
				<Section title={t.workspaces.recipeHelp}>
					<p className="muted"><code>version: 1</code> — {t.workspaces.recipeVersionHint}</p>
					<dl className="kv">
						<dt className="k"><code>services</code></dt><dd>{t.workspaces.helpServices}</dd>
						<dt className="k"><code>ports</code></dt><dd>{t.workspaces.helpPorts}</dd>
						<dt className="k"><code>database</code></dt><dd>{t.workspaces.helpDatabase}</dd>
						<dt className="k"><code>env</code></dt><dd>{t.workspaces.helpEnv}</dd>
						<dt className="k"><code>copy</code></dt><dd>{t.workspaces.helpCopy}</dd>
						<dt className="k"><code>setup / teardown</code></dt><dd>{t.workspaces.helpSetup}</dd>
						<dt className="k"><code>accounts</code></dt><dd>{t.workspaces.helpAccounts}</dd>
						<dt className="k"><code>test</code></dt><dd>{t.workspaces.helpTest}</dd>
					</dl>
					<p className="hint">{t.workspaces.templateVariables}: <code>{"{repo} {worktree} {branch} {slug} {port.<name>} {db.name} {db.template} {db.url}"}</code></p>
				</Section>
			</>}
		</Modal>
	);
}
