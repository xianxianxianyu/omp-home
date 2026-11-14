import { wsUrl } from "./api.ts";

export interface SocketHandlers {
	open: () => void;
	message: (data: string) => void;
	close: () => void;
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
	const socket = new WebSocket(wsUrl(path));
	socket.onopen = handlers.open;
	socket.onmessage = event => {
		if (typeof event.data === "string") handlers.message(event.data);
	};
	socket.onclose = handlers.close;
	return socket;
}
