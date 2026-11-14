/**
 * FTS5's trigram tokenizer cannot match terms shorter than 3 characters, which are
 * common in Chinese ("登录"). Longer terms go to MATCH (each quoted, ANDed); shorter
 * ones become LIKE filters over the same rows.
 */
export interface QueryPlan {
	match: string | null;
	likes: string[];
}

export function planQuery(q: string): QueryPlan {
	const terms = q.split(/\s+/).filter(Boolean);
	const long: string[] = [];
	const likes: string[] = [];
	for (const term of terms) {
		if ([...term].length >= 3) long.push(`"${term.replaceAll('"', '""')}"`);
		else likes.push(`%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`);
	}
	return { match: long.length ? long.join(" ") : null, likes };
}
