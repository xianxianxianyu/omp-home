import { useMemo, useState } from "react";
import type { RecipeCheckDTO, RecipeDTO, WorkspaceDTO } from "../../shared/api.ts";
import { useHub, useResource } from "./hub.tsx";
import { useI18n, useT } from "./i18n/index.tsx";
import { readRecipeSummary } from "./RecipeSummary.tsx";
import { Button, ErrorState } from "./ui.tsx";

export function RecipeCheck({ workspace, disabled = false, offer = false, onStarted }: { workspace: WorkspaceDTO; disabled?: boolean; offer?: boolean; onStarted?: () => void }) {
	const t = useT().panels.workspaces;
	const { format } = useI18n();
	const { mutate } = useHub();
	const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/recipe`;
	const recipe = useResource<RecipeDTO>("workspaces", path);
	const check = useResource<RecipeCheckDTO | null>("workspaces", `${path}/check`);
	const [pending, setPending] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const tests = useMemo(() => Object.keys(readRecipeSummary(recipe.data?.text ?? "")?.test ?? {}), [recipe.data?.text]);
	const result = check.data;
	const summary = result ?? workspace.recipeCheck;
	const running = summary?.state === "running";
	const status = !summary ? "unchecked" : !summary.current ? "outdated" : summary.state;
	const unavailable = disabled || pending || running || recipe.data?.status !== "ok" || check.data === undefined || Boolean(check.error || recipe.error);

	async function run(test?: string) {
		setPending(true); setActionError(null);
		try {
			await mutate<RecipeCheckDTO>(`${path}/check`, test ? { test } : {});
			check.reload();
			onStarted?.();
		} catch (error) { setActionError(error instanceof Error ? error.message : t.checkActionError); }
		finally { setPending(false); }
	}
	async function cancel() {
		setPending(true); setActionError(null);
		try { await mutate<RecipeCheckDTO>(`${path}/check/cancel`); check.reload(); }
		catch (error) { setActionError(error instanceof Error ? error.message : t.checkActionError); }
		finally { setPending(false); }
	}

	return <section className="recipe-check" data-check-state={status} aria-label={t.trialRun}>
		<div className="row wrap recipe-check-actions">
			<span className={`pill ${status === "passed" ? "ok" : status === "failed" ? "err" : status === "running" ? "info" : ""}`} role="status">{t.checkStates[status]}</span>
			{running ? <Button className="small cancel-recipe-check" onClick={cancel} disabled={pending}>{t.cancelCheck}</Button> : <Button className={`small try-recipe${offer ? " primary" : ""}`} onClick={() => run()} disabled={unavailable}>{offer ? t.tryRecipeNow : t.tryRecipe}</Button>}
			{tests.length > 0 && <select className="recipe-test-menu" aria-label={t.runOneCheck} value="" disabled={unavailable} onChange={event => { void run(event.target.value); }}>
				<option value="" disabled>{t.runOneCheck}</option>
				{tests.map(test => <option key={test} value={test}>{t.runOnly(test)}</option>)}
			</select>}
		</div>
		{offer && <p className="hint">{t.savedCheckHint}</p>}
		{disabled && <p className="hint">{t.saveBeforeCheck}</p>}
		{recipe.error && <ErrorState error={recipe.error} retry={recipe.reload} />}
		{check.error && <ErrorState error={check.error} retry={check.reload} />}
		{actionError && <p className="error-text" role="alert">{actionError}</p>}
		{result && <details className="recipe-check-details" key={result.startedAt} open>
			<summary>{t.checkDetails} <code>{result.base}</code> · <code>{result.sha.slice(0, 8)}</code>{result.endedAt !== null && <span className="muted"> · {format.duration(result.endedAt - result.startedAt)}</span>}</summary>
			<p className="hint">{t.checkScope(result.base)}</p>
			{result.state === "failed" && <p className="recipe-check-baseline" role="note">{t.checkBaseline(result.base)}</p>}
			<ol className="recipe-check-steps">
				{result.steps.map((step, index) => <li key={`${index}:${step.kind}:${step.name}`} data-step-state={step.state} data-step-name={step.name}>
					<div className="row wrap"><span className={`recipe-step-state ${step.state}`}>{t.checkStepStates[step.state]}</span><strong>{t.checkKinds[step.kind]}</strong><code className="grow">{step.name}</code>{step.ms !== null && <span className="muted">{format.duration(step.ms)}</span>}{step.exitCode !== null && <span className={step.exitCode === 0 ? "muted" : "error-text"}>{t.exitCode(format.number(step.exitCode))}</span>}</div>
					{step.command && <code className="recipe-check-command">{step.command}</code>}
					{step.outputTail && <details className="recipe-check-output" open={step.state === "failed"}><summary>{t.outputTail}</summary><pre>{step.outputTail}</pre></details>}
				</li>)}
			</ol>
		</details>}
	</section>;
}
