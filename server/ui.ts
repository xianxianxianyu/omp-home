import type { WebSocket } from "ws";
import type { Topic, UiEvent } from "../shared/api.ts";

/** Broadcast channel to connected UIs. Invalidations are coalesced briefly; the UI refetches over HTTP. */
export class UiChannel {
	readonly #clients = new Set<WebSocket>();
	readonly #pending = new Set<Topic>();
	#timer: NodeJS.Timeout | undefined;

	add(ws: WebSocket): void {
		this.#clients.add(ws);
		ws.on("close", () => this.#clients.delete(ws));
		ws.on("error", () => ws.close());
	}

	get clients(): number {
		return this.#clients.size;
	}

	invalidate(...topics: Topic[]): void {
		for (const t of topics) this.#pending.add(t);
		this.#timer ??= setTimeout(() => {
			this.#timer = undefined;
			const batch = [...this.#pending];
			this.#pending.clear();
			if (batch.length) this.send({ t: "invalidate", topics: batch });
		}, 50);
	}

	send(event: UiEvent): void {
		const text = JSON.stringify(event);
		for (const ws of this.#clients) if (ws.readyState === ws.OPEN) ws.send(text);
	}

	close(): void {
		clearTimeout(this.#timer);
		for (const ws of this.#clients) ws.close(1001, "hub stopping");
		this.#clients.clear();
	}
}
