import { z } from "zod";
import type { FieldError } from "../../shared/api.ts";
import { fieldError, parseResponse } from "./schemas.ts";

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

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const res = await fetch(path, {
		method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
		headers: { authorization: `Bearer ${token}`, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
		body: init?.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const text = await res.text();
	const data: unknown = text ? JSON.parse(text) : null;
	if (!res.ok) {
		const error = z.object({ error: z.string(), errors: z.array(fieldError).optional() }).safeParse(data);
		throw new ApiError(res.status, error.success ? error.data.error : res.statusText, error.success ? error.data.errors : []);
	}
	return parseResponse(path, data) as T;
}

export function wsUrl(path: string): string {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	return `${proto}://${location.host}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
