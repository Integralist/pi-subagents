/**
 * Holding subagents back so a session does not run all of them at once.
 *
 * Subagents share the host process and the user's rate limit, so ten launched
 * together is worse than ten launched five at a time: they contend, and the
 * screen fills with work nobody is reading. The queue is FIFO and knows nothing
 * about subagents — it hands out slots to thunks under an opaque id, and the
 * caller decides what a slot is for and what the id means.
 */

type Run = () => Promise<void>;

/** A submission that has not been given a slot yet. */
interface Waiting {
	id: string;
	run: Run;
}

export class SubagentQueue {
	readonly #limit: number;
	readonly #waiting: Waiting[] = [];
	#running = 0;

	/**
	 * A limit below one would accept subagents and start none of them, which a
	 * user reads as a hang rather than as a setting. One is the smallest limit
	 * that still makes progress.
	 */
	constructor(limit: number) {
		this.#limit = Math.max(1, Math.floor(limit));
	}

	/** How many are waiting for a slot. Excludes those already running. */
	get queuedCount(): number {
		return this.#waiting.length;
	}

	/**
	 * Take a slot now, or join the back of the queue.
	 *
	 * Returns immediately either way. The caller finds out which happened by
	 * whether its thunk has been called, not from here.
	 *
	 * The id is the queue's only handle on a submission, and exists so a caller
	 * can `cancel` one it has changed its mind about.
	 */
	submit(id: string, run: Run): void {
		this.#waiting.push({ id, run });
		this.#pump();
	}

	/**
	 * Drop a submission that has not started, reporting whether there was one.
	 *
	 * `false` covers both an id that never existed and one whose run is already
	 * under way — the queue cannot reach into a run it has already started, and
	 * a caller reading `false` knows to stop the work itself instead.
	 *
	 * No slot is freed, because a waiting submission never held one. Freeing one
	 * here would let the queue run a subagent over its limit for every
	 * cancellation.
	 */
	cancel(id: string): boolean {
		const index = this.#waiting.findIndex((entry) => entry.id === id);
		if (index === -1) {
			return false;
		}

		this.#waiting.splice(index, 1);
		return true;
	}

	/** Fill every free slot from the front of the queue. */
	#pump(): void {
		while (this.#running < this.#limit) {
			const next = this.#waiting.shift();
			if (!next) {
				return;
			}
			this.#running += 1;
			void this.#settle(next.run);
		}
	}

	/**
	 * Run one, and free its slot however it ends.
	 *
	 * `finally` rather than a `then`: a subagent that fails has still finished,
	 * and freeing the slot only on success would let one failure stall every
	 * subagent behind it for the rest of the session. The `catch` is what keeps
	 * that failure from becoming an unhandled rejection — nobody awaits this.
	 *
	 * `run()` is called inside the `try`, so a thunk that throws before
	 * returning a promise frees its slot too.
	 */
	async #settle(run: Run): Promise<void> {
		try {
			await run();
		} catch {
			// Whatever went wrong belongs to the caller's thunk, which is expected
			// to have reported it already. The queue only cares that it is over.
		} finally {
			this.#running -= 1;
			this.#pump();
		}
	}
}

/**
 * How many subagents run at once when nobody has said otherwise.
 *
 * Five is the point at which the Slice 8 list gains a second column, so the
 * default fills exactly one.
 */
export const DEFAULT_CONCURRENCY = 5;

/**
 * Read `subagents.limit` out of one settings object, or nothing.
 *
 * Pi loads `settings.json` with a plain `JSON.parse` and migrates it; there is
 * no schema that strips what it does not recognise
 * (`dist/core/settings-manager.js`, `loadFromStorage`). An unknown key like
 * this one therefore survives, which is what makes the setting readable at all
 * — `Settings` itself is a closed interface with nowhere to declare it.
 *
 * Anything that is not a whole number above zero is treated as absent. The
 * queue would clamp a zero to one, and silently running one subagent at a time
 * is a worse answer to a typo than the default is.
 */
function readLimit(source: unknown): number | undefined {
	if (typeof source !== "object" || source === null) {
		return undefined;
	}

	const { subagents } = source as { subagents?: unknown };
	if (typeof subagents !== "object" || subagents === null) {
		return undefined;
	}

	const { limit } = subagents as { limit?: unknown };
	return typeof limit === "number" && Number.isInteger(limit) && limit > 0
		? limit
		: undefined;
}

/**
 * The concurrency limit, from the first source that states a usable one.
 *
 * Sources are given in precedence order — project settings before global ones,
 * matching how pi merges the two everywhere else
 * (`deepMergeSettings(globalSettings, projectSettings)`). A source whose limit
 * is nonsense is passed over rather than allowed to veto the next one.
 */
export function resolveConcurrencyLimit(...sources: unknown[]): number {
	for (const source of sources) {
		const limit = readLimit(source);
		if (limit !== undefined) {
			return limit;
		}
	}
	return DEFAULT_CONCURRENCY;
}
