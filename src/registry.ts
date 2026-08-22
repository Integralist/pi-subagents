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

import type { AgentSession } from "@earendil-works/pi-coding-agent";
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

export interface SubagentRecord {
	/** Stable and unique; how tools address this run. */
	id: string;
	/** The human-friendly name — `"explore"`, `"explore-2"`. Slice 11. */
	handle: string;
	/** The agent definition this run came from. */
	type: string;
	/** What the caller asked for, one line, for the list. */
	description: string;
	status: SubagentStatus;
	color: string;
	startedAt: number;
	/** Absent until the run actually starts, and while queued. */
	session?: AgentSession;
	/** Absent until the run ends. */
	outcome?: SubagentOutcome;
	/**
	 * How much of the context window is used, or null when unknown — which is
	 * the case before the first turn ends and again right after a compaction.
	 * Null is not zero, and the list renders it blank rather than `0%`.
	 */
	contextPercent: number | null;
	turns: number;
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
	readonly #listeners = new Set<ChangeListener>();

	add(record: SubagentRecord): void {
		this.#records.set(record.id, record);
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
		this.#notify();
		return record;
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
