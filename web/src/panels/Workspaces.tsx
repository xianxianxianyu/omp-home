import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { FieldError, RecipeDTO, ScanCandidate, WorkspaceCreate, WorkspaceDTO, WorkspacePatch } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { useHub, useResource } from "../hub.tsx";
import { Button, Confirm, CopyButton, Empty, ErrorState, Field, Loading, Modal, Section, Status } from "../ui.tsx";

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
	const { data, error, loading, reload } = useResource<WorkspaceDTO[]>("workspaces", "/api/workspaces");
	const { mutate, toast } = useHub();
	const [editor, setEditor] = useState<WorkspaceDTO | "new" | null>(null);
	const [recipe, setRecipe] = useState<WorkspaceDTO | null>(null);
	const [archive, setArchive] = useState<WorkspaceDTO | null>(null);

	return (
		<div className="stack">
			<div className="panel-heading">
				<div><h2>Workspaces</h2><p className="muted">Repositories, worker defaults, and per-worktree environments.</p></div>
				<Button className="primary" onClick={() => setEditor("new")}>Add workspace</Button>
			</div>
			{error && <ErrorState error={error} retry={reload} />}
			{loading && !data && <Loading />}
			{data?.length === 0 && <Empty title="No workspaces yet">Add a repository path, or discover repositories from your home AGENTS.md.</Empty>}
			{data?.map((workspace) => (
				<article className="card" key={workspace.id}>
					<div className="row wrap">
						<h3 className="grow">{workspace.name} <span className="muted mono">{workspace.id}</span></h3>
						{workspace.archived && <Status value="archived" />}
						<span className="row"><span className="muted">Recipe</span><Status value={workspace.recipeStatus} /></span>
					</div>
					<div className="row wrap"><code className="prewrap grow">{workspace.repoPath}</code><CopyButton text={workspace.repoPath} /></div>
					<div className="meta">
						<span>Base <code>{workspace.defaultBase}</code></span>
						<span>{workspace.liveSessions} live / {workspace.totalSessions} total sessions</span>
						<span>{workspace.openTasks} open {workspace.openTasks === 1 ? "task" : "tasks"}</span>
						<span>Worker: {workspace.workerModel ?? "Settings default"}</span>
					</div>
					<div className="actions">
						<Button className="small" onClick={() => setRecipe(workspace)}>Environment recipe</Button>
						<Button className="small" onClick={() => setEditor(workspace)}>Edit</Button>
						{!workspace.archived && <Button className="small danger" onClick={() => setArchive(workspace)}>Archive</Button>}
					</div>
				</article>
			))}
			{editor && <WorkspaceEditor workspace={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} />}
			{recipe && <RecipeEditor workspace={recipe} onClose={() => setRecipe(null)} />}
			{archive && (
				<Confirm
					title={`Archive ${archive.name}?`}
					description="Archive this workspace so it is no longer available for new work. Its repository and existing records are kept."
					confirmLabel="Archive workspace"
					danger
					onClose={() => setArchive(null)}
					onConfirm={async () => {
						await mutate(`/api/workspaces/${encodeURIComponent(archive.id)}/archive`);
						toast(`${archive.name} archived`);
						setArchive(null);
					}}
				/>
			)}
		</div>
	);
}

function WorkspaceEditor({ workspace, onClose }: { workspace?: WorkspaceDTO; onClose: () => void }) {
	const { mutate, toast } = useHub();
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
			toast(workspace ? "Workspace updated" : "Workspace added");
			onClose();
		} catch (error) {
			setFormError(error instanceof Error ? error.message : "Could not save workspace.");
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
			setScanError(error instanceof Error ? error.message : "Could not scan home AGENTS.md.");
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
			if (added) toast(`Added ${added} ${added === 1 ? "workspace" : "workspaces"}`);
			if (failed) setScanError(`${failed} ${failed === 1 ? "repository could" : "repositories could"} not be added. Successful additions are marked below; the remaining selections are kept.`);
		} finally {
			setAdding(false);
		}
	}

	return (
		<Modal title={workspace ? `Edit ${workspace.name}` : "Add workspace"} onClose={onClose}>
			<form onSubmit={(event) => { void save(event); }}>
				{workspace ? (
					<p className="muted prewrap"><code>{workspace.id}</code> · <code>{workspace.repoPath}</code><br />Workspace identity and repository path cannot be changed.</p>
				) : (
					<Field label="Repository path" hint="An existing local Git repository.">
						<input autoFocus required value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="/path/to/repository" disabled={busy} />
					</Field>
				)}
				<div className="two-col">
					<Field label={workspace ? "Name" : "Name (optional)"} hint={workspace ? undefined : "Defaults to the repository name."}>
						<input autoFocus={!!workspace} required={!!workspace} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
					</Field>
					{!workspace && <Field label="ID (optional)" hint="Leave blank to generate an identifier."><input value={id} onChange={(event) => setId(event.target.value)} disabled={busy} /></Field>}
					<Field label={workspace ? "Default base" : "Default base (optional)"} hint="Base branch used for new worktrees.">
						<input required={!!workspace} value={defaultBase} onChange={(event) => setDefaultBase(event.target.value)} placeholder="Repository default" disabled={busy} />
					</Field>
					<Field label="Worker model (optional)" hint="Leave blank to use the model in Settings.">
						<input value={workerModel} onChange={(event) => setWorkerModel(event.target.value)} placeholder="provider/model" disabled={busy} />
					</Field>
				</div>
				{formError && <div className="error-box" role="alert"><p>{formError}</p>{fieldErrors.length > 0 && <ul>{fieldErrors.map((error, index) => <li key={`${error.path}:${index}`}><code>{error.path || "workspace"}</code>: {error.message}</li>)}</ul>}</div>}
				<div className="dialog-actions">
					<Button onClick={onClose} disabled={busy}>Cancel</Button>
					<Button type="submit" className="primary" disabled={busy}>{saving ? "Saving…" : workspace ? "Save changes" : "Add workspace"}</Button>
				</div>
			</form>
			{!workspace && <Section title="Discover repositories">
				<p className="muted">Scan the home AGENTS.md for repository paths, then add several at once.</p>
				<Button onClick={scan} disabled={busy}>{scanning ? "Scanning…" : "Scan home AGENTS.md"}</Button>
				{scanError && <p className="error-box" role="alert">{scanError}</p>}
				{candidates?.length === 0 && <Empty title="No repositories found">Add repository paths to your home AGENTS.md, or enter a path above.</Empty>}
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
						{candidate.alreadyAdded ? <span className="pill ok">Added</span> : !candidate.isGitRepo ? <span className="pill warn">Not a Git repository</span> : null}
					</label>)}
					<div className="actions"><Button className="primary" disabled={busy || selected.size === 0} onClick={addSelected}>{adding ? "Adding…" : `Add selected (${selected.size})`}</Button></div>
				</div>}
			</Section>}
		</Modal>
	);
}


function RecipeEditor({ workspace, onClose }: { workspace: WorkspaceDTO; onClose: () => void }) {
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
			if (!cancelled) setLoadError(error instanceof Error ? error : new Error("Could not load recipe."));
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
			toast("Environment recipe saved");
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Could not save recipe.");
			if (error instanceof ApiError) setErrors(error.errors);
		} finally {
			setSaving(false);
		}
	}

	return (
		<Modal title={`${workspace.name} · Environment recipe`} onClose={onClose} wide>
			{loading ? <Loading /> : loadError ? <ErrorState error={loadError} retry={() => setRevision((current) => current + 1)} /> : recipe && <>
				<div className="row wrap"><code className="prewrap grow muted">{recipe.path}</code><CopyButton text={recipe.path} /><Status value={recipe.status} /></div>
				{recipe.status === "missing" && <p className="hint">No recipe yet. The commented example below is a starting point; uncomment and customize the pieces you need.</p>}
				<Field label="Recipe YAML" hint="Recipes apply when a worktree environment is provisioned; saving does not rebuild existing environments.">
					<textarea className="code-editor" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={18} disabled={saving} />
				</Field>
				{(saveError || errors.length > 0) && <div className="error-box" role="alert">{saveError && <p>{saveError}</p>}{errors.length > 0 && <ul>{errors.map((error, index) => <li key={`${error.path}:${index}`}><code>{error.path || "recipe"}</code>: {error.message}</li>)}</ul>}</div>}
				<div className="dialog-actions"><Button onClick={onClose} disabled={saving}>Close</Button><Button className="primary" onClick={save} disabled={saving || (recipe.status !== "missing" && text === recipe.text)}>{saving ? "Saving…" : "Save recipe"}</Button></div>
				<Section title="Recipe help">
					<p className="muted"><code>version: 1</code> is required; all other keys are optional. Commands run locally; review them before saving.</p>
					<dl className="kv">
						<dt className="k"><code>services</code></dt><dd>Shared services used by the workspace.</dd>
						<dt className="k"><code>ports</code></dt><dd>Named ports reserved for a worktree.</dd>
						<dt className="k"><code>database</code></dt><dd>Per-worktree database provisioning.</dd>
						<dt className="k"><code>env</code></dt><dd>Environment variables for workers and commands.</dd>
						<dt className="k"><code>copy</code></dt><dd>Files copied into a new worktree.</dd>
						<dt className="k"><code>setup / teardown</code></dt><dd>Commands to prepare and clean up an environment.</dd>
						<dt className="k"><code>accounts</code></dt><dd>Test account reservations.</dd>
						<dt className="k"><code>test</code></dt><dd>Project test instructions.</dd>
					</dl>
					<p className="hint">Template variables: <code>{"{repo} {worktree} {branch} {slug} {port.<name>} {db.name} {db.template} {db.url}"}</code></p>
				</Section>
			</>}
		</Modal>
	);
}
