import { LANGUAGE_SETTINGS, resolveLanguage } from "../../../shared/api.ts";
import type { Language, LanguageSetting } from "../../../shared/api.ts";
import { en } from "./en.ts";
import { zh } from "./zh.ts";
import type { CatalogShape } from "./types.ts";

const HINT_KEY = "omp-home-language";
export const LANGUAGE_CHANGED = "omp-home-languagechange";
export type Catalog = CatalogShape<typeof en>;
export function readLanguageHint(): LanguageSetting {
	try {
		const hint = localStorage.getItem(HINT_KEY);
		return LANGUAGE_SETTINGS.find(setting => setting === hint) ?? "system";
	} catch { return "system"; }
}
let language = resolveLanguage(readLanguageHint(), navigator.languages);
export function getLanguage(): Language { return language; }
export function catalogFor(value: Language): Catalog { return value === "zh" ? zh : en; }
export function getT(): Catalog { return catalogFor(language); }
export function applyLanguage(setting: LanguageSetting, resolved: Language) {
	const changed = language !== resolved;
	language = resolved;
	document.documentElement.lang = language;
	document.title = getT().common.pageTitle;
	document.querySelector('meta[name="description"]')?.setAttribute("content", getT().common.pageDescription);
	try { localStorage.setItem(HINT_KEY, setting); } catch { /* The hub remains authoritative when browser storage is unavailable. */ }
	if (changed) window.dispatchEvent(new Event(LANGUAGE_CHANGED));
}
export interface LocaleFormat {
	number: (value: number, options?: Intl.NumberFormatOptions) => string;
	percent: (value: number) => string;
	currency: (value: number) => string;
	date: (at: number) => string;
	dateTime: (at: number) => string;
	list: (items: readonly string[]) => string;
	relativeTime: (at: number, now?: number) => string;
	duration: (milliseconds: number) => string;
}
export type LocalizedText = string | ((t: Catalog, format: LocaleFormat) => string);
export function createFormat(value: Language): LocaleFormat {
	const locale = value === "zh" ? "zh-CN" : "en-US";
	const numbers = new Intl.NumberFormat(locale);
	const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
	const dateTimes = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
	const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const lists = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
	const t = catalogFor(value);
	return {
		number: (number: number, options?: Intl.NumberFormatOptions) => options ? new Intl.NumberFormat(locale, options).format(number) : numbers.format(number),
		percent: (number: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(number),
		currency: (number: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(number),
		date: (at: number) => dates.format(at),
		dateTime: (at: number) => dateTimes.format(at),
		list: (items: readonly string[]) => lists.format(items),
		relativeTime: (at: number, now = Date.now()) => {
			const seconds = Math.round((at - now) / 1000);
			if (Math.abs(seconds) < 60) return t.common.justNow;
			const [size, unit]: [number, Intl.RelativeTimeFormatUnit] = Math.abs(seconds) < 3600 ? [60, "minute"] : Math.abs(seconds) < 86400 ? [3600, "hour"] : [86400, "day"];
			return relative.format(Math.trunc(seconds / size), unit).replace(/(\d)(?=[\u4e00-\u9fff])/g, "$1 ");
		},
		duration: (milliseconds: number) => {
			const seconds = Math.max(0, Math.floor(milliseconds / 1000));
			const hours = Math.floor(seconds / 3600);
			const minutes = Math.floor(seconds % 3600 / 60);
			const parts: string[] = [];
			if (hours) parts.push(t.common.duration.hours(numbers.format(hours)));
			if (minutes) parts.push(t.common.duration.minutes(numbers.format(minutes)));
			if (seconds % 60 || !parts.length) parts.push(t.common.duration.seconds(numbers.format(seconds % 60)));
			return parts.join(" ");
		},
	};
}
const formats = { en: createFormat("en"), zh: createFormat("zh") };
export function getFormat() { return formats[language]; }
export function formatFor(value: Language) { return formats[value]; }
