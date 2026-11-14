import fs from "node:fs";
import path from "node:path";

/** Read-only files the hub ships with: in the repo checkout, or the bundled `resources/` directory. */
export interface Resources {
	schema: string;
	/** Built UI (`index.html` + assets). */
	web: string;
	/** Directory holding the omp extension packages `main/` and `worker/`. */
	plugin: string;
	gitGuard: string;
	/** Directory holding `home/` (the home-repo migration). */
	templates: string;
}

/**
 * `OMP_HOME_RESOURCES` wins; a bundled hub (`dist/hub/hub.mjs`) finds `resources/` beside
 * itself; otherwise this is the repo checkout.
 */
export function resolveResources(): Resources {
	const explicit = process.env.OMP_HOME_RESOURCES;
	const beside = path.join(import.meta.dirname, "resources");
	const root = explicit ? path.resolve(explicit) : fs.existsSync(path.join(beside, "schema.sql")) ? beside : null;
	if (root) {
		return {
			schema: path.join(root, "schema.sql"),
			web: path.join(root, "web", "dist"),
			plugin: path.join(root, "omp-plugin"),
			gitGuard: path.join(root, "git-guard"),
			templates: path.join(root, "templates"),
		};
	}
	const repo = path.resolve(import.meta.dirname, "..");
	return {
		schema: path.join(repo, "server", "schema.sql"),
		web: path.join(repo, "web", "dist"),
		plugin: path.join(repo, "omp-plugin"),
		gitGuard: path.join(repo, "git-guard"),
		templates: path.join(repo, "templates"),
	};
}
