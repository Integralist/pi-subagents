import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SubagentRecord, SubagentRegistry } from "../src/registry.ts";
import {
	DEFAULT_GRACE_TURNS,
	DEFAULT_MAX_TURNS,
	type TurnLimit,
	type TurnLimitSession,
	WRAP_UP_MESSAGE,
	watchTurns,
} from "../src/turns.ts";

function record(id: string): SubagentRecord {
	return {
		id,
		handle: id,
		type: "explore",
		description: "look around",
		status: "running",
		color: "cyan",
		startedAt: 1_000,
		contextPercent: null,
		turns: 0,
	};
}

/** A session that only does what turn watching asks of it. */
function stubSession(
	options: { steerFails?: boolean; abortFails?: boolean } = {},
) {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const unsubscribe = vi.fn();
	const steer = vi.fn(async (_text: string) => {
		if (options.steerFails) throw new Error("nothing to steer");
	});
	const abort = vi.fn(async () => {
		if (options.abortFails) throw new Error("already gone");
	});

	const session = {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return unsubscribe;
		},
		steer,
		abort,
	} as unknown as TurnLimitSession;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		session,
		steer,
		abort,
		unsubscribe,
		endTurn: (times = 1) => {
			for (let i = 0; i < times; i++) {
				emit({ type: "turn_end" } as unknown as AgentSessionEvent);
			}
		},
		emit,
	};
}

/** Give a guarded promise inside the listener a chance to settle. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

let registry: SubagentRegistry;

beforeEach(() => {
	registry = new SubagentRegistry();
	registry.add(record("abc123"));
});

/** A limit set far enough out that it never bites during a test. */
const ROOMY: TurnLimit = { maxTurns: 1_000 };

describe("watchTurns", () => {
	it("counts each turn onto the record", () => {
		const stub = stubSession();
		watchTurns(stub.session, registry, "abc123", ROOMY);

		stub.endTurn(3);

		expect(registry.get("abc123")?.turns).toBe(3);
	});

	it("counts nothing for events that are not a turn ending", () => {
		const stub = stubSession();
		watchTurns(stub.session, registry, "abc123", ROOMY);

		stub.emit({ type: "turn_start" } as unknown as AgentSessionEvent);

		expect(registry.get("abc123")?.turns).toBe(0);
	});

	it("hands back the session's own unsubscribe", () => {
		const stub = stubSession();

		watchTurns(stub.session, registry, "abc123", ROOMY)();

		expect(stub.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("does nothing for a subagent that is no longer registered", () => {
		const stub = stubSession();
		watchTurns(stub.session, new SubagentRegistry(), "vanished", ROOMY);

		expect(() => stub.endTurn()).not.toThrow();
	});

	it("leaves a subagent well short of its limit alone", async () => {
		const stub = stubSession();
		watchTurns(stub.session, registry, "abc123", { maxTurns: 50 });

		stub.endTurn(49);
		await settled();

		expect(registry.get("abc123")?.turns).toBe(49);
		expect(stub.steer).not.toHaveBeenCalled();
		expect(stub.abort).not.toHaveBeenCalled();
	});

	describe("at the turn limit", () => {
		// The specification's scenario, quoted.
		it("Warns the subagent at its turn limit", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", { maxTurns: 5 });

			stub.endTurn(5);
			await settled();

			expect(stub.steer).toHaveBeenCalledTimes(1);
			expect(stub.steer.mock.calls[0]?.[0]).toBe(WRAP_UP_MESSAGE);
			// And the subagent is still running.
			expect(stub.abort).not.toHaveBeenCalled();
			expect(registry.get("abc123")?.status).toBe("running");
		});

		it("tells it to give its final answer now", () => {
			expect(WRAP_UP_MESSAGE).toMatch(/final answer/i);
			expect(WRAP_UP_MESSAGE).toMatch(/turn limit/i);
		});

		it("says nothing before the limit is reached", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", { maxTurns: 5 });

			stub.endTurn(4);
			await settled();

			expect(stub.steer).not.toHaveBeenCalled();
		});

		it("warns exactly once, however many turns follow", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", { maxTurns: 5 });

			stub.endTurn(7);
			await settled();

			expect(stub.steer).toHaveBeenCalledTimes(1);
		});

		// A steer is a courtesy. Failing to deliver it must not cost the run.
		it("carries on when the warning cannot be delivered", async () => {
			const stub = stubSession({ steerFails: true });
			watchTurns(stub.session, registry, "abc123", { maxTurns: 5 });

			expect(() => stub.endTurn(5)).not.toThrow();
			await settled();

			expect(registry.get("abc123")?.turns).toBe(5);
		});
	});

	describe("past the grace turns", () => {
		// The specification's scenario, quoted.
		it("Stops a subagent that ignores the warning", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", {
				maxTurns: 5,
				graceTurns: 3,
			});

			stub.endTurn(8);
			await settled();

			expect(stub.abort).toHaveBeenCalledTimes(1);
			// And its result is marked as incomplete.
			expect(registry.get("abc123")?.stoppedBecause).toMatch(/turn limit/i);
		});

		it("leaves it alone on the turn before the grace runs out", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", {
				maxTurns: 5,
				graceTurns: 3,
			});

			stub.endTurn(7);
			await settled();

			expect(stub.abort).not.toHaveBeenCalled();
		});

		it("allows three grace turns when none is stated", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", { maxTurns: 5 });

			stub.endTurn(7);
			await settled();
			expect(stub.abort).not.toHaveBeenCalled();

			stub.endTurn(1);
			await settled();
			expect(stub.abort).toHaveBeenCalledTimes(1);
			expect(DEFAULT_GRACE_TURNS).toBe(3);
		});

		it("honours a grace of its own", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", {
				maxTurns: 2,
				graceTurns: 1,
			});

			stub.endTurn(3);
			await settled();

			expect(stub.abort).toHaveBeenCalledTimes(1);
		});

		it("stops it only once, however many turns follow", async () => {
			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", {
				maxTurns: 1,
				graceTurns: 1,
			});

			stub.endTurn(6);
			await settled();

			expect(stub.abort).toHaveBeenCalledTimes(1);
		});

		it("carries on when the abort itself fails", async () => {
			const stub = stubSession({ abortFails: true });
			watchTurns(stub.session, registry, "abc123", {
				maxTurns: 1,
				graceTurns: 1,
			});

			expect(() => stub.endTurn(2)).not.toThrow();
			await settled();

			expect(registry.get("abc123")?.turns).toBe(2);
		});

		/**
		 * The listener runs inside the child's event dispatch, and steering and
		 * aborting are both promises nobody awaits. A rejection escaping either
		 * would surface in the host process rather than in the subagent.
		 *
		 * The failing session here is hand-rolled rather than a `vi.fn`, and that
		 * matters: vitest records the settled result of an async mock, which means
		 * it attaches its own handler and the rejection is never unhandled. Against
		 * a mock this test passes whether or not the guard exists.
		 */
		it("leaves no unhandled rejection behind", async () => {
			const rejections: unknown[] = [];
			const seen = (reason: unknown) => {
				rejections.push(reason);
			};
			process.on("unhandledRejection", seen);

			try {
				let fire!: (event: AgentSessionEvent) => void;
				const failing = {
					subscribe: (listener: (event: AgentSessionEvent) => void) => {
						fire = listener;
						return () => {};
					},
					steer: async () => {
						throw new Error("nothing to steer");
					},
					abort: async () => {
						throw new Error("already gone");
					},
				} as unknown as TurnLimitSession;

				watchTurns(failing, registry, "abc123", {
					maxTurns: 1,
					graceTurns: 1,
				});
				const turnEnd = { type: "turn_end" } as unknown as AgentSessionEvent;
				fire(turnEnd);
				fire(turnEnd);

				// Node decides a rejection is unhandled a tick after the microtask
				// queue drains; give it room either side of that.
				await settled();
				await new Promise((resolve) => setTimeout(resolve, 10));
				await settled();

				expect(rejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", seen);
			}
		});
	});

	/**
	 * The default is a product decision rather than an implementation detail, so
	 * it is pinned here: changing it should mean changing this line deliberately,
	 * not discovering later that subagents are being cut off sooner.
	 */
	describe("the default limit", () => {
		it("warns at thirty turns and stops three after that", async () => {
			expect(DEFAULT_MAX_TURNS).toBe(30);

			const stub = stubSession();
			watchTurns(stub.session, registry, "abc123", {
				maxTurns: DEFAULT_MAX_TURNS,
			});

			stub.endTurn(DEFAULT_MAX_TURNS);
			await settled();
			expect(stub.steer).toHaveBeenCalledTimes(1);
			expect(stub.abort).not.toHaveBeenCalled();

			stub.endTurn(DEFAULT_GRACE_TURNS);
			await settled();
			expect(stub.abort).toHaveBeenCalledTimes(1);
		});
	});
});
