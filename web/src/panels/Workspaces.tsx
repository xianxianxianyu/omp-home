import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { FieldError, RecipeDTO, RepoInspection, SettingsDTO, WorkspaceDTO, WorkspacePatch } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { useHub, useResource } from "../hub.tsx";
import { useI18n, useT } from "../i18n/index.tsx";
import { getT } from "../i18n/runtime.ts";
import { Button, Confirm, CopyButton, Empty, ErrorState, Field, Loading, Modal, Section, Status } from "../ui.tsx";
import { ModelPicker, useModelCatalog } from "../ModelPicker.tsx";

import { AddRepository, BranchPicker } from "./AddRepository.tsx";
import { RecipeSummary } from "../RecipeSummary.tsx";
import { RecipeCheck } from "../RecipeCheck.tsx";

export function WorkspacesPanel() {
	const t = useT().panels;
	const { format } = useI18n();
	const { data, error, loading, reload } = useResource<WorkspaceDTO[]>("workspaces", "/api/workspaces");
	const { mutate, toast } = useHub();
	const [editor, setEditor] = useState<WorkspaceDTO | null>(null);
	const [adding, setAdding] = useState(false);
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const highlightedRow = useRef<HTMLElement>(null);
	const [recipe, setRecipe] = useState<WorkspaceDTO | null>(null);
	const [archive, setArchive] = useState<WorkspaceDTO | null>(null);
	useEffect(() => { highlightedRow.current?.scrollIntoView({ block: "nearest" }); }, [highlighted, data]);

	if (adding) return <AddRepository onClose={() => setAdding(false)} onAdded={workspace => { setAdding(false); setHighlighted(workspace.id); reload(); }} onOpen={id => { setAdding(false); setHighlighted(id); setEditor(data?.find(workspace => workspace.id === id) ?? null); }} />;

	return (
		<div className="stack">
			<div className="panel-heading">
				<div><h2>{t.workspaces.title}</h2><p className="muted">{t.workspaces.description}</p></div>
				<Button className="primary add-repository-trigger" onClick={() => setAdding(true)}>{t.workspaces.add}</Button>
			</div>
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data?.length === 0 && <Empty title={t.workspaces.empty}>{t.workspaces.emptyDescription}</Empty>}
			{data?.map((workspace) => (
				<article className={`card workspace-row${highlighted === workspace.id ? " highlighted" : ""}`} data-workspace={workspace.id} ref={highlighted === workspace.id ? highlightedRow : undefined} key={workspace.id}>
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
					<RecipeCheck workspace={workspace} />
				</article>
			))}
			{editor && <WorkspaceEditor workspace={editor} onClose={() => setEditor(null)} />}
			{recipe && <RecipeEditor workspace={data?.find(workspace => workspace.id === recipe.id) ?? recipe} onClose={() => setRecipe(null)} />}
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

function WorkspaceEditor({ workspace, onClose }: { workspace: WorkspaceDTO; onClose: () => void }) {
	const t = useT().panels;
	const { mutate, toast } = useHub();
	const catalog = useModelCatalog();
	const settings = useResource<SettingsDTO>("settings", "/api/settings");
	const inspection = useResource<RepoInspection>("workspaces", `/api/workspaces/inspect?path=${encodeURIComponent(workspace.repoPath)}`);
	const [name, setName] = useState(workspace.name);
	const [defaultBase, setDefaultBase] = useState(workspace.defaultBase);
	const [workerModel, setWorkerModel] = useState(workspace.workerModel);
	const [saving, setSaving] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (saving) return;
		setSaving(true);
		setFormError(null);
		setFieldErrors([]);
		try {
			const patch: WorkspacePatch = { name: name.trim(), defaultBase, workerModel };
			await mutate(`/api/workspaces/${encodeURIComponent(workspace.id)}`, patch, "PATCH");
			toast(t => t.panels.workspaces.updated);
			onClose();
		} catch (error) {
			setFormError(error instanceof Error ? error.message : t.workspaces.saveError);
			if (error instanceof ApiError) setFieldErrors(error.errors);
		} finally { setSaving(false); }
	}

	return <Modal title={t.workspaces.editTitle(workspace.name)} onClose={onClose}>
		<form onSubmit={event => { void save(event); }}>
			<p className="muted prewrap"><code>{workspace.id}</code> · <code>{workspace.repoPath}</code><br />{t.workspaces.immutableIdentity}</p>
			<div className="two-col">
				<Field label={t.workspaces.name}><input autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={saving} /></Field>
				<BranchPicker branches={inspection.data?.branches ?? []} value={defaultBase} onChange={setDefaultBase} disabled={saving || !inspection.data} />
				<ModelPicker label={t.models.workerModel} value={workerModel} storedValue={workspace.workerModel} onChange={setWorkerModel} catalog={catalog.data} disabled={saving} defaultLabel={t.workspaces.workersDefault} defaultModel={settings.data?.workerModel ?? catalog.data?.defaultModel} />
			</div>
			<p className="hint">{t.workspaces.workersHint}</p>
			{inspection.error && <ErrorState error={inspection.error} retry={inspection.reload} />}
			{catalog.error && <ErrorState error={catalog.error} retry={catalog.reload} />}
			{catalog.data?.error && <p className="error-text" role="alert">{catalog.data.error}</p>}
			{formError && <div className="error-box" role="alert"><p>{formError}</p>{fieldErrors.length > 0 && <ul>{fieldErrors.map((error, index) => <li key={`${error.path}:${index}`}><code>{error.path || t.common.workspace}</code>: {error.message}</li>)}</ul>}</div>}
			<div className="dialog-actions"><Button onClick={onClose} disabled={saving}>{t.common.cancel}</Button><Button type="submit" className="primary" disabled={saving}>{saving ? t.common.saving : t.workspaces.save}</Button></div>
		</form>
	</Modal>;
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
	const [offerCheck, setOfferCheck] = useState(false);
	const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/recipe`;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		void api<RecipeDTO>(path).then((result) => {
			if (cancelled) return;
			setRecipe(result);
			setText(result.status === "missing" ? getT().panels.workspaces.recipeExample : result.text);
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
			setOfferCheck(text !== recipe?.text);
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
				<RecipeSummary text={text} />
				<Field label={t.workspaces.recipeYaml} hint={t.workspaces.recipeHint}>
					<textarea className="code-editor" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={18} disabled={saving} />
				</Field>
				{(saveError || errors.length > 0) && <div className="error-box" role="alert">{saveError && <p>{saveError}</p>}{errors.length > 0 && <ul>{errors.map((error, index) => <li key={`${error.path}:${index}`}><code>{error.path || t.common.recipe}</code>: {error.message}</li>)}</ul>}</div>}
				<div className="dialog-actions"><Button onClick={onClose} disabled={saving}>{t.common.close}</Button><Button className="primary" onClick={save} disabled={saving || (recipe.status !== "missing" && text === recipe.text)}>{saving ? t.common.saving : t.workspaces.saveRecipe}</Button></div>
				<RecipeCheck workspace={workspace} disabled={saving || text !== recipe.text} offer={offerCheck && text === recipe.text} onStarted={() => setOfferCheck(false)} />
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
