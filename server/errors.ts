import { z } from "zod";
import type { FieldError, Language } from "../shared/api.ts";
import { render, type Message } from "./i18n.ts";

export type HubErrorCode = "invalid" | "not_found" | "conflict" | "forbidden" | "too_large" | "unavailable" | "unprocessable" | "setup_required" | "not_implemented";

const STATUS: Record<HubErrorCode, number> = {
	invalid: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	setup_required: 409,
	too_large: 413,
	unprocessable: 422,
	not_implemented: 501,
	unavailable: 503,
};

/** An expected failure with a caller-facing message: HTTP error body, or a failed tool result. */
export class HubError extends Error {
	readonly code: HubErrorCode;
	readonly errors: FieldError[] | undefined;
	readonly localizedText: Message | string;

	constructor(code: HubErrorCode, message: string | Message, errors?: FieldError[]) {
		super(render(message));
		this.code = code;
		this.errors = errors;
		this.localizedText = message;
	}

	localized(language: Language): string {
		return render(this.localizedText, language);
	}

	get status(): number {
		return STATUS[this.code];
	}
}

const fieldMessages = new WeakMap<FieldError, Message>();
const chineseError = z.locales.zhCN().localeError;

export function localizedField(path: string, message: Message): FieldError {
	const field = { path, message: message.en };
	fieldMessages.set(field, message);
	return field;
}

export function localizeFieldErrors(errors: readonly FieldError[], language: Language): FieldError[] {
	return errors.map(field => ({ path: field.path, message: render(fieldMessages.get(field) ?? field.message, language) }));
}

export function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
	return issues.map(issue => {
		const custom: unknown = issue.code === "custom" ? issue.params?.message : undefined;
		const translated = chineseError(issue as z.core.$ZodRawIssue);
		const zh = typeof translated === "string" ? translated : translated?.message ?? issue.message;
		const message = custom && typeof custom === "object" && "en" in custom && "zh" in custom && typeof custom.en === "string" && typeof custom.zh === "string"
			? { en: custom.en, zh: custom.zh }
			: { en: issue.message, zh };
		return localizedField(issue.path.map(String).join("."), message);
	});
}

export function errorMessage(err: unknown): Message | string {
	if (err instanceof Error && "localizedText" in err) {
		const value = err.localizedText;
		if (typeof value === "string") return value;
		if (value && typeof value === "object" && "en" in value && "zh" in value && typeof value.en === "string" && typeof value.zh === "string") return { en: value.en, zh: value.zh };
	}
	return err instanceof Error ? err.message : String(err);
}

export function errorText(err: unknown, language: Language = "en"): string {
	return render(errorMessage(err), language);
}
