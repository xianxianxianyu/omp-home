import { z } from "zod";
import type { FieldError } from "../../shared/api.ts";
import { fieldError, parseResponse } from "./schemas.ts";
import { LANGUAGE_HEADER } from "../../shared/api.ts";
import { getLanguage } from "./i18n/runtime.ts";

const TOKEN_KEY = "omp-home-token";

/** The launcher opens `/?token=…`; keep it for this browser and strip it from the address bar. */
function readToken(): string {
	const url = new URL(location.href);
	const fromUrl = url.searchParams.get("token");
	if (fromUrl) {
		localStorage.setItem(TOKEN_KEY, fromUrl);
		url.searchParams.delete("token");
		history.replaceState(null, "", url);
		return fromUrl;
	}
	return localStorage.getItem(TOKEN_KEY) ?? "";
}

const token = readToken();

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly errors: FieldError[] = [],
	) {
		super(message);
	}
}

async function request<T>(path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }): Promise<T> {
	const res = await fetch(path, { method: init.method, headers: { authorization: `Bearer ${token}`, [LANGUAGE_HEADER]: getLanguage(), ...init.headers }, body: init.body });
	const text = await res.text();
	const data: unknown = text ? JSON.parse(text) : null;
	if (!res.ok) {
		const error = z.object({ error: z.string(), errors: z.array(fieldError).optional() }).safeParse(data);
		throw new ApiError(res.status, error.success ? error.data.error : res.statusText, error.success ? error.data.errors : []);
	}
	return parseResponse(path, data) as T;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	if (init?.body === undefined) return request<T>(path, { method: init?.method ?? "GET" });
	return request<T>(path, { method: init.method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) });
}

/** Stores a browser File on the hub so omp can read it by path; files sharing a `group` land in one folder under their relative paths. */
export function upload(file: File, folder?: { group: string; relativePath: string }): Promise<{ path: string; folder?: string }> {
	return request("/api/uploads", { method: "POST", body: file, headers: {
		"content-type": "application/octet-stream",
		"x-file-name": encodeURIComponent(file.name),
		...(folder ? { "x-upload-group": folder.group, "x-relative-path": encodeURIComponent(folder.relativePath) } : {}),
	} });
}

export function wsUrl(path: string): string {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${location.host}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
