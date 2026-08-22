import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	STOPPED_BY_USER,
	steerSubagent,
	stopSubagent,
} from "../src/control.ts";
import { SubagentQueue } from "../src/queue.ts";
import {
	type SubagentRecord,
	SubagentRegistry,
	type SubagentStatus,
} from "../src/registry.ts";

/** A session that only does what steering and stopping ask of it. */
function stubSession(
	options: { steerFails?: boolean; abortFails?: boolean } = {},
) {
	const steer = vi.fn(async (_text: string) => {
		if (options.steerFails) throw new Error("nothing to steer");
	});
	const abort = vi.fn(async () => {
		if (options.abortFails) throw new Error("already gone");
	});
	return {
		steer,
		abort,
		// Cast to the full session type because that is what a record's `session`
		// field holds. `ControlSession` documents the two methods these operations
		// actually touch, which is all a stub has to provide.
		session: { steer, abort } as unknown as AgentSession,
	};
}

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "abc123",
		handle: "explore",
		type: "explore",
		description: "look around",
		status: "running",
		color: "cyan",
		startedAt: 1_000,
		contextPercent: null,
		turns: 0,
		...overrides,
	};
}

const TERMINAL: SubagentStatus[] = ["completed", "failed", "stopped"];

let registry: SubagentRegistry;
let queue: SubagentQueue;

beforeEach(() => {
	registry = new SubagentRegistry();
	queue = new SubagentQueue(5);
});

/** Register a record and hand it back, so a test reads it after the fact. */
function tracked(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	const created = record(overrides);
	registry.add(created);
	return created;
}

describe("steerSubagent", () => {
	// The specification's scenario, quoted.
	it("Redirects a running subagent", async () => {
		const stub = stubSession();
		const subject = tracked({ session: stub.session });

		const result = await steerSubagent(subject, "look at the tests instead");

		expect(result).toEqual({ ok: true });
		expect(stub.steer).toHaveBeenCalledWith("look at the tests instead");
	});

	// The specification's scenario, quoted: the call fails with a message
	// saying the subagent has finished.
	it("Refuses to steer a finished subagent", async () => {
		for (const status of TERMINAL) {
			const stub = stubSession();
			const subject = record({ status, session: stub.session });

			const result = await steerSubagent(subject, "carry on");

			expect(result.ok, status).toBe(false);
			expect(result.ok ? "" : result.reason, status).toMatch(/finished/i);
			expect(stub.steer, status).not.toHaveBeenCalled();
		}
	});

	/**
	 * A queued subagent has no session to steer. Saying so beats the alternative
	 * of accepting the message and dropping it, which reads to the caller as a
	 * redirect that quietly never happened.
	 */
	it("refuses to steer a subagent that has not started", async () => {
		const subject = record({ status: "queued", session: undefined });

		const result = await steerSubagent(subject, "carry on");

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/not started/i);
	});

	/**
	 * A record flips to `running` the moment it takes a slot, which is before
	 * the run has built its session. A steer landing in that window has nothing
	 * to steer, and must say so rather than reaching into an absent session.
	 */
	it("refuses to steer a running subagent whose session is not up yet", async () => {
		const subject = record({ status: "running", session: undefined });

		const result = await steerSubagent(subject, "carry on");

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/not started/i);
	});

	it("refuses a message with nothing in it", async () => {
		const stub = stubSession();
		const subject = record({ session: stub.session });

		for (const empty of ["", "   ", "\n\t"]) {
			const result = await steerSubagent(subject, empty);

			expect(result.ok, JSON.stringify(empty)).toBe(false);
			expect(result.ok ? "" : result.reason).toMatch(/empty/i);
		}
		expect(stub.steer).not.toHaveBeenCalled();
	});

	it("delivers the message as written, whitespace and all", async () => {
		const stub = stubSession();
		const subject = record({ session: stub.session });

		await steerSubagent(subject, "  mind the indentation  ");

		expect(stub.steer).toHaveBeenCalledWith("  mind the indentation  ");
	});

	/**
	 * A session can refuse a steer for reasons of its own — a turn that ended
	 * between the lookup and the call. That is a reason to report, not an
	 * exception to throw at a caller who has a message to display.
	 */
	it("reports a steer the session itself refused", async () => {
		const stub = stubSession({ steerFails: true });
		const subject = record({ session: stub.session });

		const result = await steerSubagent(subject, "carry on");

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/nothing to steer/);
	});

	it("never throws, whatever the session does", async () => {
		const exploding = {
			steer: () => {
				throw new Error("threw before returning a promise");
			},
		} as unknown as AgentSession;
		const subject = record({ session: exploding });

		await expect(steerSubagent(subject, "carry on")).resolves.toMatchObject({
			ok: false,
		});
	});
});

describe("stopSubagent", () => {
	// The specification's scenario, quoted.
	it("Halts a running subagent", async () => {
		const stub = stubSession();
		const subject = tracked({ session: stub.session });

		const result = await stopSubagent(subject, { registry, queue });

		expect(result).toEqual({ ok: true });
		expect(stub.abort).toHaveBeenCalledTimes(1);
	});

	/**
	 * Recorded before the abort, so it is already on the record by the time the
	 * run settles and the completion notice is written. Without it the notice
	 * would say only that the subagent was stopped, leaving the main model to
	 * read a truncated answer as a final one.
	 */
	it("says on the record that the user stopped it", async () => {
		const stub = stubSession();
		const subject = tracked({ session: stub.session });

		await stopSubagent(subject, { registry, queue });

		expect(registry.get("abc123")?.stoppedBecause).toBe(STOPPED_BY_USER);
	});

	it("records the reason before it aborts, not after", async () => {
		const seen: Array<string | undefined> = [];
		const session = {
			abort: async () => {
				seen.push(registry.get("abc123")?.stoppedBecause);
			},
		} as unknown as AgentSession;
		const subject = tracked({ session });

		await stopSubagent(subject, { registry, queue });

		expect(seen).toEqual([STOPPED_BY_USER]);
	});

	/**
	 * The run is still in flight and will settle into a stopped outcome of its
	 * own, which is what sets the status and sends the completion notice. Setting
	 * the status here would race that, and would mark a subagent stopped that the
	 * abort had in fact arrived too late to stop.
	 */
	it("leaves a running subagent's status to the run itself", async () => {
		const stub = stubSession();
		const subject = tracked({ session: stub.session });

		await stopSubagent(subject, { registry, queue });

		expect(registry.get("abc123")?.status).toBe("running");
		expect(registry.get("abc123")?.outcome).toBeUndefined();
	});

	it("refuses to stop a subagent that has already finished", async () => {
		for (const status of TERMINAL) {
			const stub = stubSession();
			const subject = record({ status, session: stub.session });

			const result = await stopSubagent(subject, { registry, queue });

			expect(result.ok, status).toBe(false);
			expect(result.ok ? "" : result.reason, status).toMatch(/finished/i);
			expect(stub.abort, status).not.toHaveBeenCalled();
		}
	});

	/**
	 * The mirror of the steering case: a record is `running` from the moment it
	 * takes a slot, which is before the run has built its session. It is off the
	 * queue by then, so neither cancelling nor aborting can reach it.
	 */
	it("refuses to stop a running subagent whose session is not up yet", async () => {
		const subject = tracked({ status: "running", session: undefined });

		const result = await stopSubagent(subject, { registry, queue });

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/starting up/i);
		expect(registry.get("abc123")?.status).toBe("running");
	});

	it("reports an abort the session itself refused", async () => {
		const stub = stubSession({ abortFails: true });
		const subject = tracked({ session: stub.session });

		const result = await stopSubagent(subject, { registry, queue });

		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/already gone/);
	});

	it("never throws, whatever the session does", async () => {
		const exploding = {
			abort: () => {
				throw new Error("threw before returning a promise");
			},
		} as unknown as AgentSession;
		const subject = tracked({ session: exploding });

		await expect(
			stopSubagent(subject, { registry, queue }),
		).resolves.toMatchObject({ ok: false });
	});

	describe("a subagent still waiting for a slot", () => {
		/** Fill the queue, then queue one more behind it. */
		function queued() {
			const blocked = new SubagentQueue(1);
			blocked.submit("holds-the-slot", () => new Promise<void>(() => {}));
			const started = vi.fn();
			const subject = tracked({ id: "waiting", status: "queued" });
			blocked.submit("waiting", async () => {
				started();
			});
			return { queue: blocked, subject, started };
		}

		it("never lets it start", async () => {
			const { queue: blocked, subject, started } = queued();

			const result = await stopSubagent(subject, {
				registry,
				queue: blocked,
			});

			expect(result).toEqual({ ok: true });
			expect(blocked.queuedCount).toBe(0);
			expect(started).not.toHaveBeenCalled();
		});

		/**
		 * Nothing will ever run this subagent, so nothing will ever settle it
		 * either. Unlike the running case, the status and outcome have to be set
		 * here or the record would sit at `queued` for the rest of the session and
		 * `get_subagent_result` would keep reporting it as still working.
		 */
		it("marks it stopped itself, since no run will", async () => {
			const { queue: blocked, subject } = queued();

			await stopSubagent(subject, { registry, queue: blocked });

			const after = registry.get("waiting");
			expect(after?.status).toBe("stopped");
			expect(after?.stoppedBecause).toBe(STOPPED_BY_USER);
			expect(after?.outcome).toEqual({ status: "stopped", output: "" });
		});

		it("tells watchers it changed", async () => {
			const { queue: blocked, subject } = queued();
			const changed = vi.fn();
			registry.onChange(changed);

			await stopSubagent(subject, { registry, queue: blocked });

			expect(changed).toHaveBeenCalled();
		});

		/**
		 * A queued record has no session, so there is nothing to abort — and the
		 * queue is the only thing that could have started it.
		 */
		it("reports a queued subagent the queue has never heard of", async () => {
			const subject = tracked({ id: "ghost", status: "queued" });

			const result = await stopSubagent(subject, { registry, queue });

			expect(result.ok).toBe(false);
			expect(registry.get("ghost")?.status).toBe("queued");
		});
	});
});
