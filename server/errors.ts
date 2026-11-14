import type { FieldError } from "../shared/api.ts";

export type HubErrorCode = "invalid" | "not_found" | "conflict" | "forbidden" | "unavailable" | "unprocessable" | "setup_required";

const STATUS: Record<HubErrorCode, number> = {
	invalid: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	setup_required: 409,
	unprocessable: 422,
	unavailable: 503,
};

/** An expected failure with a caller-facing message: HTTP error body, or a failed tool result. */
export class HubError extends Error {
	readonly code: HubErrorCode;
	readonly errors: FieldError[] | undefined;

	constructor(code: HubErrorCode, message: string, errors?: FieldError[]) {
		super(message);
		this.code = code;
		this.errors = errors;
	}

	get status(): number {
		return STATUS[this.code];
	}
}

export function fieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldError[] {
	return issues.map(issue => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
