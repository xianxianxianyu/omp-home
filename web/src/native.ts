interface NativeNotification {
	isPermissionGranted?: () => Promise<boolean>;
	requestPermission?: () => Promise<string>;
	sendNotification: (options: { title: string; body: string }) => void | Promise<void>;
}
interface NativeTauri {
	notification?: NativeNotification;
	core?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
	event?: { listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
}
declare global { interface Window { __TAURI__?: NativeTauri } }
export type NotificationState = NotificationPermission | "unsupported";

/** The desktop app hands out real paths, so files and folders need no upload there. */
export const nativePaths = () => Boolean(window.__TAURI__?.core);

/** The native open panel: several files, or one folder. Cancelling returns no paths. */
export async function pickPaths(directory: boolean): Promise<string[]> {
	const core = window.__TAURI__?.core;
	if (!core) return [];
	const result = await core.invoke("plugin:dialog|open", { options: directory ? { directory: true } : { multiple: true } });
	return (Array.isArray(result) ? result : [result]).filter((path): path is string => typeof path === "string");
}

export interface NativeDrag { kind: "enter" | "over" | "drop" | "leave"; paths: string[]; x: number; y: number }

/** Tauri intercepts OS file drops before the page sees them and reports them as window events with physical-pixel positions. */
export function listenNativeDrags(handler: (drag: NativeDrag) => void): () => void {
	const events = window.__TAURI__?.event;
	if (!events) return () => {};
	const unlisten = (["enter", "over", "drop", "leave"] as const).map(kind => events.listen(`tauri://drag-${kind}`, ({ payload }) => {
		const data = payload !== null && typeof payload === "object" ? payload as { paths?: unknown; position?: { x?: unknown; y?: unknown } } : {};
		const paths = Array.isArray(data.paths) ? data.paths.filter((path): path is string => typeof path === "string") : [];
		const x = typeof data.position?.x === "number" ? data.position.x / devicePixelRatio : NaN;
		const y = typeof data.position?.y === "number" ? data.position.y / devicePixelRatio : NaN;
		handler({ kind, paths, x, y });
	}));
	return () => { for (const pending of unlisten) void pending.then(stop => stop(), () => {}); };
}

export async function notificationPermission(request = false): Promise<NotificationState> {
	if (typeof window === "undefined") return "unsupported";
	try {
		const native = window.__TAURI__;
		if (native) {
			const plugin = native.notification;
			if (!plugin) return native.core ? "granted" : "unsupported";
			if (!plugin.isPermissionGranted || await plugin.isPermissionGranted()) return "granted";
			if (!request || !plugin.requestPermission) return "default";
			return await plugin.requestPermission() === "granted" ? "granted" : "denied";
		}
		if (!("Notification" in window)) return "unsupported";
		return request ? await Notification.requestPermission() : Notification.permission;
	} catch { return "unsupported"; }
}

export async function notify(title: string, body: string, tag: string, onClick?: () => void): Promise<void> {
	if (typeof window === "undefined") return;
	try {
		const native = window.__TAURI__;
		if (native) {
			if (native.notification) {
				if (await notificationPermission() === "granted") await native.notification.sendNotification({ title, body });
			} else if (native.core) await native.core.invoke("notify", { title, body });
			return;
		}
		if (!document.hidden || await notificationPermission() !== "granted") return;
		const notification = new Notification(title, { body, tag });
		notification.onclick = () => { window.focus(); onClick?.(); notification.close(); };
	} catch { /* Notification permission or platform availability must never interrupt a session. */ }
}
