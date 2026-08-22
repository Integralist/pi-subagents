/**
 * Bounding how long a subagent runs.
 *
 * A subagent that has lost the thread does not stop; it keeps taking turns,
 * spending tokens on work nobody asked for. The cure is not a hard cut-off,
 * which throws away whatever it had worked out — it is a warning first, so the
 * subagent can say what it knows, and a stop only for one that ignores the
 * warning.
 *
 * Turns are counted whether or not there is a limit, because the list shows the
 * count either way.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SubagentRegistry } from "./registry.ts";

/** Turns a warned subagent gets to finish in before it is stopped. */
export const DEFAULT_GRACE_TURNS = 3;

/**
 * What a subagent is told when it reaches its limit.
 *
 * Steering is delivered after the current turn's tool calls and before the next
 * model call, so this lands where the subagent can still act on it.
 */
export const WRAP_UP_MESSAGE =
	"You have reached your turn limit. Wrap up immediately — " +
	"give your final answer now.";

export interface TurnLimit {
	/** The turn on which the subagent is warned to wrap up. */
	maxTurns: number;
	/** Turns allowed after the warning. Defaults to three. */
	graceTurns?: number;
}

/**
 * The slice of `AgentSession` turn watching needs, so a test can supply a stub.
 */
export type TurnLimitSession = Pick<
	AgentSession,
	"subscribe" | "steer" | "abort"
>;

/**
 * Do something to the session without letting it come back.
 *
 * Both `steer` and `abort` return promises, and this runs inside the child's
 * own event dispatch where nothing awaits them. An escaping rejection would
 * surface in the host process rather than in the subagent that caused it, and
 * neither is worth a failed run: a warning that cannot be delivered is a lost
 * courtesy, and an abort that fails was almost certainly a session already on
 * its way out.
 */
function attempt(action: () => Promise<void>): void {
	try {
		void action().catch(() => {});
	} catch {
		// Threw before it even returned a promise.
	}
}

/**
 * Count a subagent's turns, and hold it to its limit if it has one.
 *
 * Returns the session's unsubscribe function.
 *
 * Warning and stopping each happen exactly once. Without the guards a subagent
 * past its limit would be steered on every subsequent turn, which is both
 * noise and a way to keep it alive rather than wind it down.
 */
export function watchTurns(
	session: TurnLimitSession,
	registry: SubagentRegistry,
	idOrHandle: string,
	limit?: TurnLimit,
): () => void {
	let turns = 0;
	let warned = false;
	let stopped = false;

	return session.subscribe((event) => {
		if (event.type !== "turn_end") {
			return;
		}

		turns += 1;
		registry.update(idOrHandle, { turns });

		if (!limit) {
			return;
		}

		const graceTurns = limit.graceTurns ?? DEFAULT_GRACE_TURNS;

		if (!stopped && turns >= limit.maxTurns + graceTurns) {
			stopped = true;
			// Recorded before the abort, so it is already on the record by the time
			// the run settles and the completion notice is written. Without it the
			// notice would say only that the subagent was stopped, leaving the main
			// model to treat a truncated answer as a final one.
			registry.update(idOrHandle, {
				stoppedBecause: "it passed its turn limit without finishing",
			});
			attempt(() => session.abort());
			return;
		}

		if (!warned && turns >= limit.maxTurns) {
			warned = true;
			attempt(() => session.steer(WRAP_UP_MESSAGE));
		}
	});
}
