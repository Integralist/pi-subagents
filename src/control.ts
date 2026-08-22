/**
 * Redirecting and halting a subagent that is already under way.
 *
 * Both operations report rather than throw. Three callers need them — the two
 * tools, the list in Slice 10, and the `@name` mentions in Slice 11 — and all
 * three have a message to put on screen, not an exception to handle. "That
 * subagent finished a moment ago" is an ordinary answer to a reasonable
 * request, so it comes back as one.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SubagentQueue } from "./queue.ts";
import {
	type SubagentRecord,
	type SubagentRegistry,
	TERMINAL_STATUSES,
} from "./registry.ts";
import { describeCause } from "./runner.ts";

/**
 * Either it was done, or here is why it was not.
 *
 * The reason is a bare clause — "it has already finished" — with no subagent
 * named in it. Each caller already names the subagent its own way: a tool by
 * type and id, the list by the row the message sits under. Naming it here too
 * would double it up in one place or the other.
 */
export type ControlResult = { ok: true } | { ok: false; reason: string };

/**
 * The slice of `AgentSession` these two operations touch, so a test can hand
 * over a stub instead of standing up a real session.
 */
export type ControlSession = Pick<AgentSession, "steer" | "abort">;

/** What a record's `stoppedBecause` says when the stop was deliberate. */
export const STOPPED_BY_USER = "you asked it to stop";

/** What both operations need to reach a subagent, however far along it is. */
export interface ControlDeps {
	registry: SubagentRegistry;
	queue: SubagentQueue;
}

/**
 * Do something to a session and turn any objection into a reason.
 *
 * Catches a synchronous throw as well as a rejection: a session is free to
 * refuse before it ever returns a promise, and a caller holding a message to
 * display should not have to tell the two apart.
 */
async function attempt(action: () => Promise<void>): Promise<ControlResult> {
	try {
		await action();
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: describeCause(error) };
	}
}

/**
 * Send a subagent a new instruction mid-run.
 *
 * Pi delivers a steering message after the current turn's tool calls and before
 * the next model call, so it lands where the subagent can still act on it.
 */
export async function steerSubagent(
	record: SubagentRecord,
	message: string,
): Promise<ControlResult> {
	if (TERMINAL_STATUSES.has(record.status)) {
		return { ok: false, reason: "it has already finished" };
	}

	if (!message.trim()) {
		return { ok: false, reason: "a steering message cannot be empty" };
	}

	// Not `status === "running"`: a record is running from the moment it takes a
	// slot, which is a fraction before the run has built its session. The session
	// itself is the only honest test of whether there is anything to steer.
	const { session } = record;
	if (!session) {
		return { ok: false, reason: "it has not started yet" };
	}

	// Delivered exactly as written. Trimming would quietly rewrite a message
	// whose indentation was the point.
	return attempt(() => session.steer(message));
}

/**
 * Halt a subagent, keeping whatever it had worked out.
 *
 * Which of two quite different things this means depends on how far along the
 * subagent is, and the difference matters:
 *
 *   - **Waiting for a slot.** Nothing is running it and nothing ever will, so
 *     nothing will settle it either. The record has to be marked here or it
 *     would sit at `queued` for the rest of the session.
 *   - **Running.** The run is in flight and will settle into a stopped outcome
 *     of its own, which is what sets the status and announces it. Setting the
 *     status here would race that — and would mark a subagent stopped that the
 *     abort had in fact arrived too late to stop.
 */
export async function stopSubagent(
	record: SubagentRecord,
	deps: ControlDeps,
): Promise<ControlResult> {
	if (TERMINAL_STATUSES.has(record.status)) {
		return { ok: false, reason: "it has already finished" };
	}

	if (record.status === "queued") {
		if (!deps.queue.cancel(record.id)) {
			return {
				ok: false,
				reason: "it has just taken a slot and is starting up; try again",
			};
		}

		deps.registry.update(record.id, {
			status: "stopped",
			stoppedBecause: STOPPED_BY_USER,
			// Without an outcome the record reads as still working, and
			// `get_subagent_result` would keep saying so.
			outcome: { status: "stopped", output: "" },
		});
		return { ok: true };
	}

	const { session } = record;
	if (!session) {
		return { ok: false, reason: "it is still starting up; try again" };
	}

	// Recorded before the abort, so it is already on the record by the time the
	// run settles and the completion notice is written. Without it the notice
	// would say only that the subagent was stopped, leaving the main model to
	// read a truncated answer as a final one.
	deps.registry.update(record.id, { stoppedBecause: STOPPED_BY_USER });
	return attempt(() => session.abort());
}
