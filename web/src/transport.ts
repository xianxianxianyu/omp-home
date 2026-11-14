import { wsUrl } from "./api.ts";
import { getLanguage } from "./i18n/runtime.ts";

export interface SocketHandlers {
	open: () => void;
	message: (data: string) => void;
	close: (code?: number, reason?: string) => void;
}
export interface HubSocket {
	readonly readyState: number;
	send: (data: string) => void;
	close: () => void;
}
type SocketFactory = (path: string, handlers: SocketHandlers) => HubSocket;
let mockFactory: SocketFactory | undefined;
export function installSocketFactory(factory: SocketFactory) { mockFactory = factory; }
export function connectSocket(path: string, handlers: SocketHandlers): HubSocket {
	if (mockFactory) return mockFactory(path, handlers);
	const localizedPath = `${path}${path.includes("?") ? "&" : "?"}lang=${getLanguage()}`;
	const socket = new WebSocket(wsUrl(localizedPath));
	socket.onopen = handlers.open;
	socket.onmessage = event => {
		if (typeof event.data === "string") handlers.message(event.data);
	};
	socket.onclose = event => handlers.close(event.code, event.reason);
	return socket;
}
