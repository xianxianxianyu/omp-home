import { createHash } from "node:crypto";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import type { FieldError } from "../../shared/api.ts";
import { fieldErrors, HubError, localizedField } from "../errors.ts";
import { localizedCheck, validationMessages as m } from "../i18n-validation.ts";

/**
 * Boundary parser for `<home>/repos/<workspace>.env.yaml`. Templates use `{var}`;
 * `${SHELL_VAR}` is left to the shell. Unknown variables are parse errors, checked
 * per field because shared services cannot see per-worktree values.
 */

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const name = z.string().refine(v => NAME.test(v), localizedCheck(m.recipeName()));
const command = z.string().min(1);

const externalService = z.strictObject({
	kind: z.literal("external"),
	check: command,
	start: command,
	stop: command.optional(),
	timeoutSec: z.number().int().min(1).max(3600).default(30),
});
const runService = z.strictObject({
	kind: z.literal("run"),
	run: command,
	check: command,
	ports: z.array(name).default([]),
	timeoutSec: z.number().int().min(1).max(3600).default(15),
});
const secretField = z.union([z.string(), z.strictObject({ keychain: z.string().min(1) }), z.strictObject({ env: z.string().min(1) })]);

const recipeSchema = z.strictObject({
	version: z.literal(1),
	services: z.record(name, z.discriminatedUnion("kind", [externalService, runService])).default({}),
	ports: z.array(name).default([]),
	database: z
		.strictObject({
			template: z.string().min(1),
			name: command,
			exists: command,
			clone: command,
			drop: command,
			url: command,
			refreshTemplate: command.optional(),
		})
		.optional(),
	env: z.record(z.string().refine(v => ENV_NAME.test(v), localizedCheck(m.envVarName())), z.string()).default({}),
	copy: z.array(z.string().min(1)).default([]),
	setup: z.array(command).default([]),
	teardown: z.array(command).default([]),
	accounts: z
		.record(
			name,
			z.strictObject({
				ttlMinutes: z.number().int().min(1).max(24 * 60).default(30),
				items: z.array(z.strictObject({ id: name, fields: z.record(z.string(), secretField) })).min(1),
			}),
		)
		.default({}),
	test: z.record(z.string(), command).default({}),
});

export type EnvRecipe = z.infer<typeof recipeSchema>;
export type ServiceSpec = EnvRecipe["services"][string];
export type SecretField = z.infer<typeof secretField>;
/** Errors carry English messages; localizeFieldErrors renders them for the UI. */
export type RecipeResult = { ok: true; recipe: EnvRecipe; hash: string } | { ok: false; errors: FieldError[] };

const VAR = /(?<!\$)\{([a-z][a-z0-9_.-]*)\}/g;

export function parseRecipe(text: string): RecipeResult {
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (err) {
		return { ok: false, errors: [yamlError(err, text)] };
	}
	const parsed = recipeSchema.safeParse(doc ?? {});
	if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error.issues) };
	const recipe = parsed.data;
	const errors = checkVariables(recipe);
	if (errors.length) return { ok: false, errors };
	const portNames = [...recipe.ports, ...servicePorts(recipe)];
	const dup = portNames.find((p, i) => portNames.indexOf(p) !== i);
	if (dup) return { ok: false, errors: [localizedField("ports", m.duplicatePort(dup))] };
	return { ok: true, recipe, hash: createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 16) };
}

/** The yaml library's messages embed a source excerpt; reduce them to "line N: what is wrong". */
function yamlError(err: unknown, text: string): FieldError {
	if (!(err instanceof YAMLParseError)) return localizedField("", m.yamlFailed(err instanceof Error ? err.message : String(err)));
	const line = err.linePos?.[0].line;
	if (err.code === "DUPLICATE_KEY") {
		const key = line ? /^\s*([^:#\s][^:]*):/.exec(text.split("\n")[line - 1] ?? "")?.[1]?.trim() : undefined;
		return localizedField(key ?? "", m.duplicateKey(line, key));
	}
	return localizedField("", m.yamlSyntax(line, err.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "")));
}

export function servicePorts(recipe: EnvRecipe): string[] {
	return Object.values(recipe.services).flatMap(s => (s.kind === "run" ? s.ports : []));
}

function checkVariables(recipe: EnvRecipe): FieldError[] {
	const shared = ["repo", ...servicePorts(recipe).map(p => `port.${p}`)];
	const worktree = [...shared, "worktree", "branch", "slug", ...recipe.ports.map(p => `port.${p}`)];
	const db = recipe.database ? ["db.name", "db.template"] : [];
	const full = [...worktree, ...db, ...(recipe.database ? ["db.url"] : [])];
	const fields: [string, string, string[]][] = [];
	for (const [svc, spec] of Object.entries(recipe.services)) {
		const base = `services.${svc}`;
		if (spec.kind === "external") {
			fields.push([`${base}.check`, spec.check, shared], [`${base}.start`, spec.start, shared]);
			if (spec.stop) fields.push([`${base}.stop`, spec.stop, shared]);
		} else {
			fields.push([`${base}.run`, spec.run, shared], [`${base}.check`, spec.check, shared]);
		}
	}
	if (recipe.database) {
		const d = recipe.database;
		fields.push(["database.name", d.name, worktree]);
		for (const key of ["exists", "clone", "drop", "url"] as const) fields.push([`database.${key}`, d[key], [...worktree, ...db]]);
		if (d.refreshTemplate) fields.push(["database.refreshTemplate", d.refreshTemplate, [...shared, "db.template"]]);
	}
	for (const [k, v] of Object.entries(recipe.env)) fields.push([`env.${k}`, v, full]);
	recipe.setup.forEach((c, i) => fields.push([`setup.${i}`, c, full]));
	recipe.teardown.forEach((c, i) => fields.push([`teardown.${i}`, c, full]));
	for (const [k, v] of Object.entries(recipe.test)) fields.push([`test.${k}`, v, full]);

	const errors: FieldError[] = [];
	for (const [path, text, allowed] of fields) {
		for (const [, variable] of text.matchAll(VAR)) {
			if (!allowed.includes(variable!)) errors.push(localizedField(path, m.unknownVariable(variable!, allowed.map(a => `{${a}}`).join(" "))));
		}
	}
	return errors;
}

export interface Vars {
	repo: string;
	worktree?: string;
	branch?: string;
	slug?: string;
	port: Record<string, number>;
	db?: { name: string; template: string; url: string };
}

/** Substitute `{var}`s. Shell mode single-quotes each value so it stays one word. */
export function expand(template: string, vars: Vars, mode: "shell" | "plain"): string {
	return template.replace(VAR, (_whole, key: string) => {
		const value = lookup(vars, key);
		if (value === undefined) throw new HubError("unprocessable", m.variableUnavailable(key));
		return mode === "shell" ? `'${value.replaceAll("'", `'\\''`)}'` : value;
	});
}

function lookup(vars: Vars, key: string): string | undefined {
	if (key.startsWith("port.")) {
		const port = vars.port[key.slice(5)];
		return port === undefined ? undefined : String(port);
	}
	switch (key) {
		case "repo":
			return vars.repo;
		case "worktree":
			return vars.worktree;
		case "branch":
			return vars.branch;
		case "slug":
			return vars.slug;
		case "db.name":
			return vars.db?.name;
		case "db.template":
			return vars.db?.template;
		case "db.url":
			return vars.db?.url;
		default:
			return undefined;
	}
}

/** Branch → identifier-safe slug for database names and the like. */
export function slugOf(branch: string): string {
	return branch.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "wt";
}
