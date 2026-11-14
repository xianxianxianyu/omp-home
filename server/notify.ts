import type { MainDTO } from "../shared/api.ts";
import type { Bridge } from "./bridge.ts";
import { decideDelivery, NOTICE_TIMING, renderBatch } from "./core/notices.ts";
import type { Ledger } from "./ledger.ts";
import type { Pool } from "./pool.ts";
import type { SettingsStore } from "./settings.ts";

/** After a wake is acknowledged, main counts as busy until its turn starts (or this long passes). */
const TURN_START_GRACE_MS = 5000;

/** Turns pending notices into batches for the main chat; decisions come from core/notices.ts only. */
export class Notifier {
	readonly #ledger: Ledger;
	readonly #pool: Pool;
	readonly #bridge: Bridge;
	readonly #settings: SettingsStore;
	readonly #changed: () => void;
	#timer: NodeJS.Timeout | undefined;
	#wakeAckedAt = 0;

	constructor(deps: { ledger: Ledger; pool: Pool; bridge: Bridge; settings: SettingsStore; changed: () => void }) {
		this.#ledger = deps.ledger;
		this.#pool = deps.pool;
		this.#bridge = deps.bridge;
		this.#settings = deps.settings;
		this.#changed = deps.changed;
	}

	wakeAcked(): void {
		this.#wakeAckedAt = Date.now();
		this.#schedule(this.#wakeAckedAt + TURN_START_GRACE_MS);
	}

	mainRunChanged(): void {
		this.#wakeAckedAt = 0;
		this.evaluate();
	}

	#schedule(at: number): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.evaluate(), Math.max(0, at - Date.now()) + 5);
	}

	evaluate(): void {
		const main = this.#pool.currentMain();
		if (!main) return;
		const now = Date.now();
		const pending = this.#ledger.pendingNotices();
		const turnStarting = now - this.#wakeAckedAt < TURN_START_GRACE_MS;
		const mainState = !this.#bridge.isConnected(main.id) ? "offline" : this.#pool.isIdle(main.id) && !turnStarting ? "idle" : "busy";
		const maxAutoWakes = this.#settings.get().maxAutoWakes;
		const wakesSinceHuman = this.#ledger.wakesSinceHuman(main.id);
		const decision = decideDelivery(
			{
				now,
				main: mainState,
				inFlight: this.#ledger.notifyInFlight(main.id),
				wakesSinceHuman,
				pending: pending.map(n => ({ id: n.id, priority: n.priority, at: n.created_at })),
			},
			{ maxAutoWakes, ...NOTICE_TIMING },
		);
		if (decision.kind === "wait") {
			this.#schedule(decision.until);
			return;
		}
		if (decision.kind === "none") return;
		const chosen = pending.filter(n => decision.ids.includes(n.id));
		const text = renderBatch(this.#ledger.batchItems(chosen), {
			mode: decision.mode,
			wakesLeft: Math.max(0, maxAutoWakes - wakesSinceHuman - (decision.mode === "wake" ? 1 : 0)),
			urgent: chosen.some(n => n.priority !== "info"),
		});
		this.#ledger.enqueueBatch(main.id, decision.ids, decision.mode, text);
		this.#bridge.flush(main.id);
		this.#changed();
	}

	main(): MainDTO {
		const main = this.#pool.currentMain();
		const wakesMax = this.#settings.get().maxAutoWakes;
		if (!main) return { sessionId: null, state: "cold", wakesUsed: 0, wakesMax, paused: false, pendingNotices: this.#ledger.pendingNotices().length };
		return {
			sessionId: main.id,
			state: this.#pool.state(main.id),
			wakesUsed: this.#ledger.wakesSinceHuman(main.id),
			wakesMax,
			paused: this.#ledger.paused(main.id),
			pendingNotices: this.#ledger.pendingNotices().length,
		};
	}

	stop(): void {
		clearTimeout(this.#timer);
	}
}
