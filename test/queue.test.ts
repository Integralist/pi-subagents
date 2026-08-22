import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CONCURRENCY,
	resolveConcurrencyLimit,
	SubagentQueue,
} from "../src/queue.ts";

/** A run the test starts and finishes by hand. */
function job() {
	let settle!: () => void;
	let fail!: (reason: unknown) => void;
	const promise = new Promise<void>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const run = vi.fn(() => promise);
	return { run, finish: settle, reject: fail };
}

/** Let the microtask queue drain, so a settled run has been noticed. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("SubagentQueue", () => {
	it("starts a run at once when there is room", () => {
		const queue = new SubagentQueue(2);
		const first = job();

		queue.submit("first", first.run);

		expect(first.run).toHaveBeenCalledTimes(1);
		expect(queue.queuedCount).toBe(0);
	});

	it("runs up to the limit at the same time", () => {
		const queue = new SubagentQueue(2);
		const jobs = [job(), job()];

		jobs.forEach((j, i) => {
			queue.submit(`job-${i}`, j.run);
		});

		expect(jobs.every((j) => j.run.mock.calls.length === 1)).toBe(true);
		expect(queue.queuedCount).toBe(0);
	});

	// The plan's acceptance criterion for Task 4.1, quoted.
	it("queues a fourth submission against a limit of 3", async () => {
		const queue = new SubagentQueue(3);
		const running = [job(), job(), job()];
		running.forEach((j, i) => {
			queue.submit(`running-${i}`, j.run);
		});
		const fourth = job();

		queue.submit("fourth", fourth.run);

		expect(fourth.run).not.toHaveBeenCalled();
		expect(queue.queuedCount).toBe(1);

		running[0]?.finish();
		await settled();

		expect(fourth.run).toHaveBeenCalledTimes(1);
		expect(queue.queuedCount).toBe(0);
	});

	it("hands out slots in the order they were asked for", async () => {
		const queue = new SubagentQueue(1);
		const started: string[] = [];
		const first = job();
		queue.submit("first", first.run);

		const waiting = ["second", "third", "fourth"].map((name) => {
			const j = job();
			queue.submit(name, () => {
				started.push(name);
				return j.run();
			});
			return j;
		});

		first.finish();
		await settled();
		waiting[0]?.finish();
		await settled();
		waiting[1]?.finish();
		await settled();

		expect(started).toEqual(["second", "third", "fourth"]);
	});

	/**
	 * The plan's warning, made a test: freeing the slot in `then` rather than
	 * `finally` means one failed subagent stalls every subagent behind it.
	 */
	it("frees the slot when a run fails rather than finishes", async () => {
		const queue = new SubagentQueue(1);
		const failing = job();
		queue.submit("failing", failing.run);
		const next = job();
		queue.submit("next", next.run);

		failing.reject(new Error("that subagent exploded"));
		await settled();

		expect(next.run).toHaveBeenCalledTimes(1);
	});

	it("leaves no unhandled rejection behind when a run fails", async () => {
		const rejections: unknown[] = [];
		const seen = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", seen);

		try {
			const queue = new SubagentQueue(1);
			const failing = job();
			queue.submit("failing", failing.run);

			failing.reject(new Error("that subagent exploded"));
			await settled();
			await settled();

			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", seen);
		}
	});

	it("frees the slot when a run throws before it even starts", async () => {
		const queue = new SubagentQueue(1);
		queue.submit("throwing", () => {
			throw new Error("could not start");
		});
		const next = job();

		queue.submit("next", next.run);
		await settled();

		expect(next.run).toHaveBeenCalledTimes(1);
	});

	it("counts everything still waiting", () => {
		const queue = new SubagentQueue(1);
		queue.submit("a", job().run);
		queue.submit("b", job().run);
		queue.submit("c", job().run);

		expect(queue.queuedCount).toBe(2);
	});

	// A limit of zero would accept subagents and start none of them, which
	// reads as a hang rather than as a setting.
	it("runs one at a time rather than none on a nonsensical limit", () => {
		const queue = new SubagentQueue(0);
		const first = job();

		queue.submit("first", first.run);

		expect(first.run).toHaveBeenCalledTimes(1);
		expect(queue.queuedCount).toBe(0);
	});

	it("does not start a second run on a nonsensical limit", () => {
		const queue = new SubagentQueue(-3);
		queue.submit("first", job().run);
		const second = job();

		queue.submit("second", second.run);

		expect(second.run).not.toHaveBeenCalled();
	});
});

describe("SubagentQueue.cancel", () => {
	it("never runs a submission cancelled while it waited", async () => {
		const queue = new SubagentQueue(1);
		const running = job();
		queue.submit("running", running.run);
		const waiting = job();
		queue.submit("waiting", waiting.run);

		expect(queue.cancel("waiting")).toBe(true);
		expect(queue.queuedCount).toBe(0);

		// The slot it was waiting for comes free, and still nothing runs it.
		running.finish();
		await settled();

		expect(waiting.run).not.toHaveBeenCalled();
	});

	// The doomed submission is deliberately *not* at the front of the queue, so
	// an implementation that drops the first entry it finds fails this rather
	// than passing by coincidence.
	it("takes only the submission it was asked for", async () => {
		const queue = new SubagentQueue(1);
		const running = job();
		queue.submit("running", running.run);
		const spared = job();
		const doomed = job();
		queue.submit("spared", spared.run);
		queue.submit("doomed", doomed.run);

		queue.cancel("doomed");
		running.finish();
		await settled();
		spared.finish();
		await settled();

		expect(spared.run).toHaveBeenCalledTimes(1);
		expect(doomed.run).not.toHaveBeenCalled();
	});

	/**
	 * A run already under way is past the queue's reach: its slot is taken and
	 * only the run itself can end it. Reporting `false` is what tells a caller
	 * to go and stop the session instead.
	 */
	it("reports a run that has already started as not cancellable", () => {
		const queue = new SubagentQueue(1);
		const running = job();
		queue.submit("running", running.run);

		expect(queue.cancel("running")).toBe(false);
	});

	it("leaves a running submission running", async () => {
		const queue = new SubagentQueue(1);
		const running = job();
		queue.submit("running", running.run);
		const next = job();
		queue.submit("next", next.run);

		queue.cancel("running");

		// Its slot is still held, so nothing behind it has moved up.
		expect(next.run).not.toHaveBeenCalled();

		running.finish();
		await settled();

		expect(next.run).toHaveBeenCalledTimes(1);
	});

	it("reports an id it has never seen as not cancellable", () => {
		const queue = new SubagentQueue(1);
		queue.submit("known", job().run);

		expect(queue.cancel("never-heard-of-it")).toBe(false);
	});

	/**
	 * Cancelling something that never held a slot must not hand one out, or the
	 * queue would run one more than its limit for every cancellation.
	 */
	it("does not free a slot the cancelled submission never held", async () => {
		const queue = new SubagentQueue(1);
		const running = job();
		queue.submit("running", running.run);
		const first = job();
		const second = job();
		queue.submit("first", first.run);
		queue.submit("second", second.run);

		queue.cancel("first");
		await settled();

		expect(second.run).not.toHaveBeenCalled();
	});
});

/** Settings as pi hands them over: plain JSON, unknown keys and all. */
function withLimit(limit: unknown) {
	return { theme: "dark", subagents: { limit } };
}

describe("resolveConcurrencyLimit", () => {
	it("runs five at a time when nobody has said otherwise", () => {
		expect(resolveConcurrencyLimit({}, {})).toBe(DEFAULT_CONCURRENCY);
		expect(DEFAULT_CONCURRENCY).toBe(5);
	});

	it("takes the limit from settings", () => {
		expect(resolveConcurrencyLimit({}, withLimit(3))).toBe(3);
	});

	// Pi merges project settings over global ones, and so does this.
	it("lets a project's limit win over the global one", () => {
		expect(resolveConcurrencyLimit(withLimit(2), withLimit(9))).toBe(2);
	});

	it("falls back to the global limit when the project sets none", () => {
		expect(resolveConcurrencyLimit({}, withLimit(9))).toBe(9);
	});

	it("copes with settings that are missing altogether", () => {
		expect(resolveConcurrencyLimit(undefined, null)).toBe(DEFAULT_CONCURRENCY);
	});

	/**
	 * A limit that is not a whole number above zero is a mistake, and the
	 * default is a better answer to a mistake than a silent 1 — which is what
	 * the queue itself would clamp a zero to.
	 */
	it("ignores a limit that is not a whole number above zero", () => {
		for (const nonsense of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(resolveConcurrencyLimit({}, withLimit(nonsense))).toBe(
				DEFAULT_CONCURRENCY,
			);
		}
	});

	it("ignores a limit that is not a number at all", () => {
		for (const nonsense of ["3", true, null, {}, []]) {
			expect(resolveConcurrencyLimit({}, withLimit(nonsense))).toBe(
				DEFAULT_CONCURRENCY,
			);
		}
	});

	it("ignores a subagents key that is not an object", () => {
		expect(resolveConcurrencyLimit({}, { subagents: 3 })).toBe(
			DEFAULT_CONCURRENCY,
		);
	});

	// A project that spells it wrong should not quietly disable the global one.
	it("passes over a source whose limit is nonsense", () => {
		expect(resolveConcurrencyLimit(withLimit("lots"), withLimit(4))).toBe(4);
	});
});
