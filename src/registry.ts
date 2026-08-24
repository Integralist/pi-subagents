/**
 * The record of every subagent this session has launched.
 *
 * One registry lives per extension instance. It is the single place that knows
 * a subagent exists, what it is doing, and how it ended — the tools read it to
 * answer questions about a run, and the list in Slice 8 redraws from it.
 *
 * Nothing here is asynchronous. Records are plain objects and every operation
 * is a map lookup, so a caller on the event loop's critical path — a `turn_end`
 * handler, a keypress — can update the registry without waiting.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { SubagentOutcome } from "./runner.ts";

/**
 * Where a subagent is in its life.
 *
 * `queued` exists for Slice 4: past the concurrency limit a subagent is
 * accepted and recorded but not yet started. The three terminal states mirror
 * `SubagentOutcome.status`, so an outcome maps onto a record without
 * translation.
 */
export type SubagentStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "stopped";

/**
 * The statuses a subagent does not come back from.
 *
 * Owned here because the registry is what decides a record's status means, and
 * three callers ask the same question: the control operations refuse to steer or
 * stop one of these, and the list stops showing them once they have been read.
 */
export const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
	"completed",
	"failed",
	"stopped",
]);

export interface SubagentRecord {
	/** Stable and unique; how tools address this run. */
	id: string;
	/** The human-friendly name — `"explore"`, `"explore-2"`. Slice 11. */
	handle: string;
	/** The agent definition this run came from. */
	type: string;
	/**
	 * The definition this run was started under, kept so that continuing it does
	 * not depend on a file still being there.
	 *
	 * A subagent given its definition when it was started has no file to re-read
	 * and this is the only one it will ever have. A file-backed subagent carries
	 * it too, but a continuation prefers the file — see `route` in `index.ts` for
	 * why a resumed subagent runs under its file's current frontmatter, and why
	 * this is not a fallback for a file that has gone.
	 *
	 * `type` stays alongside it because that is what the model addresses and what
	 * every message names. The two cannot disagree: both are set from one
	 * definition when the record is made, and a file whose `name:` has changed
	 * since is no longer findable under the old one, so it is a different agent
	 * rather than a renamed one.
	 */
	config: AgentConfig;
	/** What the caller asked for, one line, for the list. */
	description: string;
	status: SubagentStatus;
	color: string;
	startedAt: number;
	/**
	 * When this subagent reached a terminal status, stamped by the registry.
	 *
	 * The list uses it to keep a finished subagent on screen for a moment so its
	 * result can be read, then drop it. Absent for anything still going.
	 */
	finishedAt?: number;
	/** Absent until the run actually starts, and while queued. */
	session?: AgentSession;
	/**
	 * Where this subagent's transcript is written, so the conversation can be
	 * continued after it finishes.
	 *
	 * Absent while queued, and absent for a subagent whose session pi never
	 * persisted. The path existing is not a promise that the file does: pi
	 * withholds writing until the child's first assistant reply, so a subagent
	 * that failed before answering names a file that was never created. Anything
	 * reopening this must check.
	 */
	sessionFile?: string;
	/** Absent until the run ends. */
	outcome?: SubagentOutcome;
	/**
	 * Messages to fold into the prompt of a run that has not started yet.
	 *
	 * A subagent waiting for a slot has no session, so there is nothing to steer
	 * — but the user addressing it means the same thing either way, and its task
	 * has not been read yet, so an addition still belongs in it. Read and cleared
	 * by the run as it starts.
	 */
	pending?: string[];
	/**
	 * Why this run was cut short, when the reason is not in the outcome itself.
	 *
	 * A stopped outcome says only that the subagent did not finish. This says
	 * what stopped it — a turn limit here, a user in Slice 6 — so the completion
	 * notice can tell the main model that the answer it is reading is truncated
	 * rather than final.
	 */
	stoppedBecause?: string;
	/**
	 * How much of the context window is used, or null when unknown — which is
	 * the case before the first turn ends and again right after a compaction.
	 * Null is not zero, and the list renders it blank rather than `0%`.
	 */
	contextPercent: number | null;
	turns: number;
	/** Model name or id used by this subagent. */
	model?: string;
	/** Thinking / reasoning effort level used by this subagent. */
	thinkingLevel?: ThinkingLevel;
	/** Whether to trigger a main-model turn when finished, or auto-coalesce. */
	wakeOnFinish?: boolean;
}

/**
 * Everything a caller may change after a record is added — that is, all of
 * it but the id.
 */
export type SubagentRecordChanges = Partial<Omit<SubagentRecord, "id">>;

type ChangeListener = () => void;

export class SubagentRegistry {
	/**
	 * Keyed by id. A `Map` rather than an array because every lookup is by id and
	 * re-adding an id must replace the record rather than duplicate it.
	 */
	readonly #records = new Map<string, SubagentRecord>();
	/** How many callers are waiting on each subagent's answer. See `awaitResult`. */
	readonly #awaited = new Map<string, number>();
	readonly #listeners = new Set<ChangeListener>();
	readonly #now: () => number;

	/** `now` is a seam: a test needs a clock it can move to watch a row expire. */
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	add(record: SubagentRecord): void {
		this.#records.set(record.id, record);
		this.#stampIfFinished(record);
		this.#notify();
	}

	/**
	 * By id, or failing that by handle. Both are unique, and a caller holding
	 * either one should not have to know which it has.
	 */
	get(idOrHandle: string): SubagentRecord | undefined {
		return (
			this.#records.get(idOrHandle) ??
			Array.from(this.#records.values()).find(
				(record) => record.handle === idOrHandle,
			)
		);
	}

	/**
	 * Change a record and tell everyone watching.
	 *
	 * Mutating the object from `get()` directly would work and would notify
	 * nobody, leaving the list showing a status that has already moved on. This
	 * is the only door: every write goes through it, so no write is silent.
	 *
	 * Returns the updated record, or nothing when no such subagent exists.
	 */
	update(
		idOrHandle: string,
		changes: SubagentRecordChanges,
	): SubagentRecord | undefined {
		const record = this.get(idOrHandle);
		if (!record) {
			return undefined;
		}

		Object.assign(record, changes);
		this.#stampIfFinished(record);
		this.#notify();
		return record;
	}

	/**
	 * Note when a subagent finished, the first time it is seen to have done so.
	 *
	 * Here rather than at each call site because every terminal status arrives
	 * through this one door, and a caller that forgot would leave the list unable
	 * to tell a subagent that just finished from one that finished half an hour
	 * ago. Only stamped once: a record whose status is edited again after the
	 * fact — a resumed subagent finishing a second time clears this first — must
	 * not have its clock quietly reset.
	 */
	#stampIfFinished(record: SubagentRecord): void {
		if (
			TERMINAL_STATUSES.has(record.status) &&
			record.finishedAt === undefined
		) {
			record.finishedAt = this.#now();
		}
	}

	/**
	 * Every subagent in launch order, earliest first.
	 *
	 * Sorted by `startedAt` rather than trusting insertion order, so a record
	 * added late — a resumed session in Slice 7 — still lands where it belongs.
	 * `sort` is stable, so subagents launched inside the same millisecond stay in
	 * the order they were added.
	 */
	list(): SubagentRecord[] {
		return Array.from(this.#records.values()).sort(
			(a, b) => a.startedAt - b.startedAt,
		);
	}

	/**
	 * Only what is genuinely running. Queued subagents are excluded: Slice 4
	 * compares this count against the concurrency limit, and counting the queue
	 * would wedge it shut.
	 */
	running(): SubagentRecord[] {
		return this.list().filter((record) => record.status === "running");
	}

	/**
	 * Note that somebody is waiting to be handed this subagent's answer, and
	 * hand back the release.
	 *
	 * Counted rather than flagged: two tool calls may ask about one subagent at
	 * once, and the first to give up must not speak for the second. Kept off the
	 * record on purpose — this is about a call in flight rather than about the
	 * subagent, and putting it on the record would redraw the list every time
	 * somebody asked a question.
	 */
	awaitResult(idOrHandle: string): () => void {
		const record = this.get(idOrHandle);
		if (!record) {
			return () => {};
		}

		const { id } = record;
		this.#awaited.set(id, (this.#awaited.get(id) ?? 0) + 1);

		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const left = (this.#awaited.get(id) ?? 1) - 1;
			if (left > 0) {
				this.#awaited.set(id, left);
			} else {
				this.#awaited.delete(id);
			}
		};
	}

	/**
	 * Whether a caller is waiting to be handed this subagent's answer.
	 *
	 * Read by the run as it ends, to decide whether its answer still needs
	 * announcing: one that is about to be returned as a tool result does not.
	 */
	isAwaited(idOrHandle: string): boolean {
		const record = this.get(idOrHandle);
		return record !== undefined && this.#awaited.has(record.id);
	}

	/** Subscribe to any change. Call the returned function to stop. */
	onChange(listener: ChangeListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * A throwing listener is contained: the UI failing to redraw must not stop
	 * the registry recording what happened, nor rob the listeners after it of
	 * their notification.
	 *
	 * The live `Set` is iterated directly. Copying it first would guard against
	 * a listener unsubscribing mid-notification, but iteration already handles
	 * that — a one-shot subscriber removing itself is visited exactly once.
	 */
	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// A subscriber's problem, not the registry's.
			}
		}
	}
}

/** How a wait can end other than by the subagent finishing. */
export interface WaitOptions {
	/** The turn's signal. An abandoned turn stops waiting for its answer. */
	signal?: AbortSignal;
	/** Milliseconds before the wait gives up. Omitted waits indefinitely. */
	timeoutMs?: number;
}

/**
 * Wait for a subagent to reach a terminal status.
 *
 * This is what a caller asking for a result does instead of asking again and
 * again: one call that settles when there is something to say. A wait cannot
 * outlive what it was waiting for — the subagent finishing ends it, the turn
 * being abandoned ends it, and the cap ends it regardless, so a subagent whose
 * provider has stopped answering cannot hold a turn open forever.
 *
 * Resolves rather than rejects however it ends. The caller reads the record to
 * find out whether there is an answer, which is the same thing it would have
 * done had it never waited at all.
 */
export function whenFinished(
	registry: SubagentRegistry,
	idOrHandle: string,
	options: WaitOptions = {},
): Promise<void> {
	const record = registry.get(idOrHandle);
	if (!record || TERMINAL_STATUSES.has(record.status)) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve) => {
		const release = registry.awaitResult(record.id);
		const stops: Array<() => void> = [];
		let done = false;
		const settle = () => {
			if (done) {
				return;
			}
			done = true;
			for (const stop of stops.splice(0)) {
				stop();
			}
			release();
			resolve();
		};

		stops.push(
			registry.onChange(() => {
				const current = registry.get(record.id);
				if (current && TERMINAL_STATUSES.has(current.status)) {
					settle();
				}
			}),
		);

		const { signal, timeoutMs } = options;
		if (signal) {
			if (signal.aborted) {
				settle();
				return;
			}
			const abandon = () => settle();
			signal.addEventListener("abort", abandon, { once: true });
			stops.push(() => signal.removeEventListener("abort", abandon));
		}

		if (timeoutMs !== undefined) {
			const timer = setTimeout(settle, timeoutMs);
			// The cap is a courtesy to a caller that is still there. Holding node
			// open for it would delay every exit by up to the cap.
			timer.unref?.();
			stops.push(() => clearTimeout(timer));
		}
	});
}

/**
 * The slice of `AgentSession` that context tracking needs.
 *
 * Narrowed to two methods so a test can hand over a stub instead of standing up
 * a real session, and so this module never grows a dependency on the rest of
 * the session surface.
 */
export type ContextUsageSource = Pick<
	AgentSession,
	"subscribe" | "getContextUsage"
>;

/**
 * Read the usage figure, or admit to not knowing it.
 *
 * Three different things mean the same thing to the list — no usage object at
 * all, a null `percent` in the moments after a compaction, and a read that
 * threw. All become null, which renders as a blank. Zero would be a lie: it
 * says the context is empty when the truth is that nobody knows.
 */
function readContextPercent(session: ContextUsageSource): number | null {
	try {
		return session.getContextUsage()?.percent ?? null;
	} catch {
		return null;
	}
}

/**
 * Keep one record's context reading current for as long as its subagent runs.
 *
 * The reading is taken at `turn_end` because that is when the provider has just
 * reported its token usage; sampling at any other event would re-read a figure
 * that has not moved.
 *
 * The listener runs inside the child session's own event dispatch, so it must
 * not throw — an exception here would surface in the host's session rather than
 * in the subagent that caused it. Nothing in it can: reading is guarded, and
 * updating a record that has since gone is a no-op.
 *
 * Returns the session's unsubscribe function, so a caller that finishes with a
 * subagent can stop listening.
 */
export function trackContextUsage(
	session: ContextUsageSource,
	registry: SubagentRegistry,
	idOrHandle: string,
): () => void {
	return session.subscribe((event) => {
		if (event.type !== "turn_end") {
			return;
		}

		registry.update(idOrHandle, {
			contextPercent: readContextPercent(session),
		});
	});
}
