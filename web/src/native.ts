interface NativeNotification {
	isPermissionGranted?: () => Promise<boolean>;
	requestPermission?: () => Promise<string>;
	sendNotification: (options: { title: string; body: string }) => void | Promise<void>;
}
interface NativeTauri {
	notification?: NativeNotification;
	core?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
}
declare global { interface Window { __TAURI__?: NativeTauri } }
export type NotificationState = NotificationPermission | "unsupported";

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
