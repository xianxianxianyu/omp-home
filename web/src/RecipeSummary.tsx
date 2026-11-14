import { useMemo } from "react";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { useT } from "./i18n/index.tsx";

// This is a preview, not recipe validation; the hub owns the full recipe contract.
const summaryShape = z.object({
	setup: z.array(z.string()).default([]),
	teardown: z.array(z.string()).default([]),
	test: z.record(z.string(), z.string()).default({}),
	ports: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).default({}),
});

export function RecipeSummary({ text }: { text: string }) {
	const t = useT().panels.workspaces;
	const summary = useMemo(() => {
		try { return summaryShape.safeParse(parseYaml(text) as unknown); }
		catch { return null; }
	}, [text]);
	if (!summary?.success) return <p className="hint">{t.summaryUnavailable}</p>;
	const { setup, teardown, test, ports, env } = summary.data;
	const portVars = new Set(ports.flatMap(port => Object.entries(env).filter(([, value]) => value === `{port.${port}}`).map(([key]) => key)));
	return <div className="recipe-summary">
		<h4>{t.recipeSummary}</h4>
		{setup.length + teardown.length + Object.keys(test).length + ports.length + Object.keys(env).length === 0 ? <p className="muted">{t.noRecipeCommands}</p> : <dl>
			{setup.length > 0 && <><dt>{t.setupCommands}</dt><dd>{setup.map((command, index) => <code key={index}>{command}</code>)}</dd></>}
			{Object.keys(test).length > 0 && <><dt>{t.testCommands}</dt><dd>{Object.entries(test).map(([name, command]) => <code key={name}>{name}: {command}</code>)}</dd></>}
			{ports.length > 0 && <><dt>{t.recipePorts}</dt><dd>{ports.map(port => <code key={port}>{port}{Object.entries(env).filter(([, value]) => value === `{port.${port}}`).map(([key]) => ` → ${key}`).join("")}</code>)}</dd></>}
			{Object.keys(env).some(key => !portVars.has(key)) && <><dt>{t.recipeEnv}</dt><dd>{Object.entries(env).filter(([key]) => !portVars.has(key)).map(([key, value]) => <code key={key}>{key} = {value}</code>)}</dd></>}
			{teardown.length > 0 && <><dt>{t.teardownCommands}</dt><dd>{teardown.map((command, index) => <code key={index}>{command}</code>)}</dd></>}
		</dl>}
	</div>;
}
