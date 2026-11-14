import { useMemo } from "react";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RepoInspection } from "../../shared/api.ts";
import { useT } from "./i18n/index.tsx";

// This is a preview, not recipe validation; the hub owns the full recipe contract.
const summaryShape = z.object({
	copy: z.array(z.string()).default([]),
	setup: z.array(z.string()).default([]),
	teardown: z.array(z.string()).default([]),
	test: z.record(z.string(), z.string()).default({}),
	ports: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).default({}),
});

export function readRecipeSummary(text: string) {
	try {
		const result = summaryShape.safeParse(parseYaml(text) as unknown);
		return result.success ? result.data : null;
	} catch { return null; }
}

export function RecipeSummary({ text, detectedCopy = [], onCopyChange, disabled }: { text: string; detectedCopy?: RepoInspection["copy"]; onCopyChange?: (path: string, checked: boolean) => void; disabled?: boolean }) {
	const t = useT().panels.workspaces;
	const summary = useMemo(() => readRecipeSummary(text), [text]);
	if (!summary) return <p className="hint">{t.summaryUnavailable}</p>;
	const { copy, setup, teardown, test, ports, env } = summary;
	const portVars = new Set(ports.flatMap(port => Object.entries(env).filter(([, value]) => value === `{port.${port}}`).map(([key]) => key)));
	return <div className="recipe-summary">
		<h4>{t.recipeSummary}</h4>
		{copy.length + setup.length + teardown.length + Object.keys(test).length + ports.length + Object.keys(env).length === 0 ? <p className="muted">{t.noRecipeCommands}</p> : <dl>
			{copy.length > 0 && <><dt>{t.copyFiles}</dt><dd>{copy.map(path => <span key={path}><code>{path}</code>{detectedCopy.some(file => file.path === path && file.why === "tsconfig") && <span className="muted"> — {t.copyTsconfig}</span>}</span>)}</dd></>}
			{setup.length > 0 && <><dt>{t.setupCommands}</dt><dd>{setup.map((command, index) => <code key={index}>{command}</code>)}</dd></>}
			{Object.keys(test).length > 0 && <><dt>{t.testCommands}</dt><dd>{Object.entries(test).map(([name, command]) => <code key={name}>{name}: {command}</code>)}</dd></>}
			{ports.length > 0 && <><dt>{t.recipePorts}</dt><dd>{ports.map(port => <code key={port}>{port}{Object.entries(env).filter(([, value]) => value === `{port.${port}}`).map(([key]) => ` → ${key}`).join("")}</code>)}</dd></>}
			{Object.keys(env).some(key => !portVars.has(key)) && <><dt>{t.recipeEnv}</dt><dd>{Object.entries(env).filter(([key]) => !portVars.has(key)).map(([key, value]) => <code key={key}>{key} = {value}</code>)}</dd></>}
			{teardown.length > 0 && <><dt>{t.teardownCommands}</dt><dd>{teardown.map((command, index) => <code key={index}>{command}</code>)}</dd></>}
		</dl>}
		{onCopyChange && detectedCopy.filter(file => file.why === "env").map(file => <label className="repo-copy-option" key={file.path}>
			<input type="checkbox" checked={copy.includes(file.path)} disabled={disabled} onChange={event => onCopyChange(file.path, event.target.checked)} />
			<span>{t.copyEnv(file.path)}</span>
		</label>)}
	</div>;
}
