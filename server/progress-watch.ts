import type { TaskProgress } from "../shared/api.ts";

/** Intent changes of one task publish at most this often; phase changes publish at once. */
export const INTENT_THROTTLE_MS = 1000;

/**
 * Decides when the in-flight task list must refetch. `observe` is called with a task's current
 * progress whenever it may have changed; `publish(taskId)` fires when its phase or intent did.
 */
export class ProgressWatch {
	readonly #publish: (taskId: string) => void;
	readonly #now: () => number;
	readonly #seen = new Map<string, Pick<TaskProgress, "phase" | "intent">>();
	readonly #publishedAt = new Map<string, number>();
	readonly #pending = new Map<string, NodeJS.Timeout>();

	constructor(publish: (taskId: string) => void, now: () => number = Date.now) {
		this.#publish = publish;
		this.#now = now;
	}

	observe(taskId: string, progress: Pick<TaskProgress, "phase" | "intent"> | null): void {
		const seen = this.#seen.get(taskId);
		if (!progress) {
			// Closing is a task event; the ledger change already invalidated the list.
			this.#forget(taskId);
			return;
		}
		if (seen && seen.phase === progress.phase && seen.intent === progress.intent) return;
		this.#seen.set(taskId, { phase: progress.phase, intent: progress.intent });
		const wait = (this.#publishedAt.get(taskId) ?? -Infinity) + INTENT_THROTTLE_MS - this.#now();
		if (!seen || seen.phase !== progress.phase || wait <= 0) {
			this.#fire(taskId);
			return;
		}
		if (this.#pending.has(taskId)) return;
		this.#pending.set(
			taskId,
			setTimeout(() => this.#fire(taskId), wait),
		);
	}

	/** Keep only these tasks (the open ones); the rest are forgotten. */
	retain(taskIds: ReadonlySet<string>): void {
		for (const id of this.#seen.keys()) if (!taskIds.has(id)) this.#forget(id);
	}

	stop(): void {
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
	}

	#fire(taskId: string): void {
		clearTimeout(this.#pending.get(taskId));
		this.#pending.delete(taskId);
		this.#publishedAt.set(taskId, this.#now());
		this.#publish(taskId);
	}

	#forget(taskId: string): void {
		clearTimeout(this.#pending.get(taskId));
		this.#pending.delete(taskId);
		this.#seen.delete(taskId);
		this.#publishedAt.delete(taskId);
	}
}
