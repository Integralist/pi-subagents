import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { PALETTE } from "../src/colors.ts";
import { SubagentQueue } from "../src/queue.ts";
import { type SubagentRecord, SubagentRegistry } from "../src/registry.ts";
import type { RunSubagentOptions, SubagentOutcome } from "../src/runner.ts";
import {
	COMPLETE_MESSAGE_TYPE,
	type RunSubagentFn,
	renderCompletion,
	resumeSubagent,
	type SendMessage,
	type SubagentCompleteDetails,
	startSubagent,
	stopFromUi,
} from "../src/spawn.ts";
import { DEFAULT_MAX_TURNS, WRAP_UP_MESSAGE } from "../src/turns.ts";

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
		description: "reviews code for defects",
		systemPrompt: "You review code.",
		source: "project",
		filePath: "/tmp/reviewer.md",
		...overrides,
	};
}

const ctx = { cwd: "/tmp/project" } as unknown as ExtensionContext;

/** A promise a test settles by hand, so a run finishes exactly when asked. */
function deferred<T>() {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

/** A run that hangs until the test finishes it. */
function stubRun() {
	const calls: RunSubagentOptions[] = [];
	const gate = deferred<SubagentOutcome>();
	const run = vi.fn((opts: RunSubagentOptions) => {
		calls.push(opts);
		return gate.promise;
	});
	return { run, calls, finish: gate.settle };
}

interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
	details: SubagentCompleteDetails;
}

interface SentOptions {
	deliverAs?: string;
	triggerTurn?: boolean;
}

/**
 * A `sendMessage` a test can await rather than poll for. Typed by what this
 * extension actually sends, so the recorded calls come back structured; the
 * cast at the call site is what reconciles that with pi's generic signature.
 */
function stubSend() {
	const arrived = deferred<void>();
	const sendMessage = vi.fn((_message: SentMessage, _options?: SentOptions) => {
		arrived.settle();
	});
	return { sendMessage, delivered: arrived.promise };
}

/**
 * The parts of a child session that handover touches.
 *
 * More than one watcher subscribes — context use and turns — so each gets its
 * own unsubscribe, and a test can assert that every subscription was undone
 * without having to know how many there are.
 */
function stubSession() {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
	const session = {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			const unsubscribe = vi.fn();
			unsubscribes.push(unsubscribe);
			return unsubscribe;
		},
		getContextUsage: () => ({
			tokens: 1_000,
			contextWindow: 200_000,
			percent: 12,
		}),
		steer: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	};
	return {
		session,
		steer: session.steer,
		abort: session.abort,
		unsubscribes,
		endTurn: (times = 1) => {
			const event = { type: "turn_end" } as unknown as AgentSessionEvent;
			for (let i = 0; i < times; i++) {
				for (const listener of listeners) listener(event);
			}
		},
	};
}

interface StartOptions {
	config?: AgentConfig;
	registry?: SubagentRegistry;
	id?: string;
	queue?: SubagentQueue;
}

function start(
	run: ReturnType<typeof stubRun>,
	send: ReturnType<typeof stubSend>,
	options: StartOptions = {},
) {
	const registry = options.registry ?? new SubagentRegistry();
	const record = startSubagent({
		ctx,
		config: options.config ?? agentConfig(),
		prompt: "review src/agents.ts",
		description: "review agents file",
		registry,
		queue: options.queue ?? new SubagentQueue(5),
		sendMessage: send.sendMessage as unknown as SendMessage,
		run: run.run,
		newId: () => options.id ?? "abc123",
		now: () => 1_000,
	});
	return { record, registry };
}

/** The message the notifier delivered, as the conversation would receive it. */
function delivered(send: ReturnType<typeof stubSend>) {
	const call = send.sendMessage.mock.calls[0];
	if (!call) throw new Error("no message was sent");
	return { message: call[0], options: call[1] ?? {} };
}

/** Let the queue hand its slot on, however many ticks that takes. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let run: ReturnType<typeof stubRun>;
let send: ReturnType<typeof stubSend>;

beforeEach(() => {
	run = stubRun();
	send = stubSend();
});

describe("startSubagent", () => {
	// The plan's acceptance criterion for Task 3.4, quoted: spawning returns
	// immediately with an id.
	it("returns a running record before the subagent has done anything", () => {
		const { record } = start(run, send);

		expect(record.id).toBe("abc123");
		expect(record.status).toBe("running");
		expect(send.sendMessage).not.toHaveBeenCalled();
	});

	it("registers the subagent so it can be found straight away", () => {
		const { record, registry } = start(run, send);

		expect(registry.get("abc123")).toBe(record);
		expect(registry.running()).toHaveLength(1);
	});

	/**
	 * The record is what a continuation reads when there is no agent file to
	 * re-read, so the definition has to be on it rather than looked up again.
	 */
	it("keeps the definition it was started under on the record", () => {
		const config = agentConfig({
			systemPrompt: "You review code narrowly.",
			tools: ["read", "grep"],
		});

		const { record } = start(run, send, { config });

		expect(record.config).toEqual(config);
	});

	/**
	 * A message sent to a subagent still waiting for a slot has nowhere to go
	 * until the run starts, so it joins the task the run starts on. Its own
	 * paragraph, rather than running into the end of the original task.
	 */
	describe("messages that arrived while it waited", () => {
		/**
		 * A subagent past the limit, with the message it was sent while it waited,
		 * and the slot freed so its run starts.
		 */
		async function waitedWith(...pending: string[]) {
			const queue = new SubagentQueue(1);
			const blocking = stubRun();
			const { registry } = start(blocking, send, { queue, id: "first" });
			const waiting = start(run, send, {
				queue,
				id: "second",
				registry,
			});
			if (pending.length > 0) {
				registry.update(waiting.record.id, { pending });
			}

			blocking.finish({ status: "completed", output: "done" });
			await settle();
			return { registry, record: waiting.record };
		}

		it("starts on the task with what it was sent", async () => {
			await waitedWith("and check the tests");

			expect(run.calls[0]?.prompt).toBe(
				"review src/agents.ts\n\nand check the tests",
			);
		});

		it("keeps them in the order they were sent", async () => {
			await waitedWith("first thing", "second thing");

			expect(run.calls[0]?.prompt).toBe(
				"review src/agents.ts\n\nfirst thing\n\nsecond thing",
			);
		});

		it("leaves the task alone when nothing was sent", async () => {
			await waitedWith();

			expect(run.calls[0]?.prompt).toBe("review src/agents.ts");
		});

		/** Or resuming the same record later would start on them a second time. */
		it("forgets them once the run has them", async () => {
			const { registry, record } = await waitedWith("and check the tests");

			expect(registry.get(record.id)?.pending).toBeUndefined();
		});
	});

	/**
	 * The handle is what `@name` addresses, so it has to be unique for the
	 * session: a message to `@reviewer` must have exactly one place to go.
	 */
	describe("handles", () => {
		it("gives the first subagent of a type the bare name", () => {
			expect(start(run, send).record.handle).toBe("reviewer");
		});

		it("numbers the next subagent of the same type", () => {
			const first = start(run, send);
			const second = start(stubRun(), send, {
				registry: first.registry,
				id: "def456",
			});

			expect(first.record.handle).toBe("reviewer");
			expect(second.record.handle).toBe("reviewer-2");
		});

		it("makes a multi-word agent name addressable", () => {
			const { record } = start(run, send, {
				config: agentConfig({ name: "Code Reviewer" }),
			});

			expect(record.handle).toBe("code-reviewer");
		});

		/**
		 * The record is reused rather than replaced, so the handle someone has
		 * been typing goes on reaching the same subagent.
		 */
		it("keeps the handle when a subagent is resumed", () => {
			const { record, registry } = start(run, send);
			const handle = record.handle;
			registry.update(record.id, {
				status: "completed",
				outcome: { status: "completed", output: "done" },
			});

			resumeSubagent({
				ctx,
				config: agentConfig(),
				prompt: "carry on",
				record,
				registry,
				queue: new SubagentQueue(5),
				sendMessage: send.sendMessage as unknown as SendMessage,
				run: stubRun().run,
			});

			expect(record.handle).toBe(handle);
		});
	});

	it("starts the run without waiting for it", () => {
		start(run, send);

		expect(run.run).toHaveBeenCalledTimes(1);
		expect(run.calls[0]?.prompt).toBe("review src/agents.ts");
		expect(run.calls[0]?.config.name).toBe("reviewer");
	});

	/**
	 * The tool call is over the instant it returns an id, and its signal aborts
	 * with it. Handing that signal to the run would kill every subagent at birth.
	 */
	it("gives the run no abort signal to die by", () => {
		start(run, send);

		expect(run.calls[0]?.signal).toBeUndefined();
	});

	it("takes the next palette colour per subagent launched", () => {
		const registry = new SubagentRegistry();
		const first = start(run, send, { registry, id: "first" }).record;
		const second = start(stubRun(), stubSend(), {
			registry,
			id: "second",
		}).record;

		expect(first.color).toBe(PALETTE[0]);
		expect(second.color).toBe(PALETTE[1]);
	});

	it("lets the agent file's colour win", () => {
		const { record } = start(run, send, {
			config: agentConfig({ color: "hotpink" }),
		});

		expect(record.color).toBe("hotpink");
	});
});

describe("startSubagent under a concurrency limit", () => {
	// The plan's acceptance criterion for Slice 4, seen from the caller's side.
	it("records a subagent past the limit as queued, not running", () => {
		const queue = new SubagentQueue(1);
		const registry = new SubagentRegistry();
		start(run, send, { queue, registry, id: "first" });
		const second = stubRun();

		const record = start(second, stubSend(), {
			queue,
			registry,
			id: "second",
		}).record;

		expect(record.status).toBe("queued");
		expect(second.run).not.toHaveBeenCalled();
		expect(registry.running().map((r) => r.id)).toEqual(["first"]);
	});

	it("starts a queued subagent when a slot frees", async () => {
		const queue = new SubagentQueue(1);
		const registry = new SubagentRegistry();
		start(run, send, { queue, registry, id: "first" });
		const second = stubRun();
		start(second, stubSend(), { queue, registry, id: "second" });

		run.finish({ status: "completed", output: "done" });
		await send.delivered;
		// The notice goes out inside the run; the slot frees a turn later, when
		// the queue sees that run settle.
		await new Promise((resolve) => setImmediate(resolve));

		expect(second.run).toHaveBeenCalledTimes(1);
		expect(registry.get("second")?.status).toBe("running");
	});

	/**
	 * `startedAt` is stamped when the user asks, not when a slot frees, so the
	 * list stays in the order they asked rather than jumping about as subagents
	 * are let through.
	 */
	it("keeps a queued subagent in the order it was asked for", () => {
		const queue = new SubagentQueue(1);
		const registry = new SubagentRegistry();
		start(run, send, { queue, registry, id: "first" });
		start(stubRun(), stubSend(), { queue, registry, id: "second" });

		expect(registry.list().map((r) => r.id)).toEqual(["first", "second"]);
	});
});

describe("startSubagent completion", () => {
	it("records the outcome against the subagent", async () => {
		const { registry } = start(run, send);

		run.finish({ status: "completed", output: "looks fine" });
		await send.delivered;

		const record = registry.get("abc123");
		expect(record?.status).toBe("completed");
		expect(record?.outcome).toEqual({
			status: "completed",
			output: "looks fine",
		});
		expect(registry.running()).toHaveLength(0);
	});

	// The plan's acceptance criterion for Task 3.4, quoted: the result arrives
	// in the conversation and the main model reasons about it.
	it("delivers the result as a follow-up that triggers a turn", async () => {
		start(run, send);

		run.finish({ status: "completed", output: "looks fine" });
		await send.delivered;

		const { message, options } = delivered(send);
		expect(message.customType).toBe(COMPLETE_MESSAGE_TYPE);
		expect(message.display).toBe(true);
		expect(options.deliverAs).toBe("followUp");
		expect(options.triggerTurn).toBe(true);
	});

	it("carries the subagent's answer in the message", async () => {
		start(run, send);

		run.finish({ status: "completed", output: "looks fine" });
		await send.delivered;

		expect(delivered(send).message.content).toContain("looks fine");
		expect(delivered(send).message.content).toContain("reviewer");
	});

	it("names the subagent by id so two of a kind stay apart", async () => {
		start(run, send);

		run.finish({ status: "completed", output: "looks fine" });
		await send.delivered;

		expect(delivered(send).message.content).toContain("abc123");
	});

	it("reports a failure with the reason the runner gave", async () => {
		start(run, send);

		run.finish({
			status: "failed",
			output: "",
			error: 'subagent "reviewer" failed: the model errored',
		});
		await send.delivered;

		const { message } = delivered(send);
		expect(message.content).toContain("the model errored");
		expect(message.details.status).toBe("failed");
	});

	// The runner's reason names the agent already. Saying it again in the
	// headline is the doubling commit d78fb0d removed once before.
	it("names the failing agent exactly once", async () => {
		start(run, send);

		run.finish({
			status: "failed",
			output: "",
			error: 'subagent "reviewer" failed: the model errored',
		});
		await send.delivered;

		const content = delivered(send).message.content;
		expect(content.match(/reviewer/g) ?? []).toHaveLength(1);
	});

	it("says plainly when a subagent was stopped", async () => {
		start(run, send);

		run.finish({ status: "stopped", output: "got halfway" });
		await send.delivered;

		expect(delivered(send).message.content).toContain("stopped");
		expect(delivered(send).message.content).toContain("got halfway");
	});

	/**
	 * The specification's "its result is marked as incomplete". A bare "stopped"
	 * leaves the main model reading a truncated answer as a final one.
	 */
	it("says why a subagent was stopped and that its answer is partial", async () => {
		const { registry } = start(run, send);
		registry.update("abc123", {
			stoppedBecause: "it passed its turn limit without finishing",
		});

		run.finish({ status: "stopped", output: "got halfway" });
		await send.delivered;

		const content = delivered(send).message.content;
		expect(content).toContain("passed its turn limit");
		expect(content).toMatch(/incomplete/i);
		expect(content).toContain("got halfway");
	});

	it("says so when a subagent finished without answering", async () => {
		start(run, send);

		run.finish({ status: "completed", output: "" });
		await send.delivered;

		expect(delivered(send).message.content).toContain(
			"without saying anything",
		);
	});

	it("attaches the details the UI needs", async () => {
		start(run, send);

		run.finish({ status: "completed", output: "looks fine" });
		await send.delivered;

		expect(delivered(send).message.details).toEqual({
			id: "abc123",
			handle: "reviewer",
			agent: "reviewer",
			status: "completed",
			description: "review agents file",
			contextPercent: null,
		});
	});

	/**
	 * The notice is delivered from a background continuation with no caller to
	 * catch for it, so a failure to deliver must not become an unhandled
	 * rejection — and the record must still say what happened.
	 */
	it("still records the outcome when the notice cannot be delivered", async () => {
		const failing = vi.fn(() => {
			throw new Error("no session to send to");
		});
		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config: agentConfig(),
			prompt: "review src/agents.ts",
			description: "review agents file",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: failing as unknown as SendMessage,
			run: run.run,
			newId: () => "abc123",
			now: () => 1_000,
		});

		run.finish({ status: "completed", output: "looks fine" });
		await vi.waitFor(() => expect(failing).toHaveBeenCalled());

		expect(registry.get("abc123")?.status).toBe("completed");
	});
});

/**
 * Nobody awaits the background run, so a rejection escaping it has no catch
 * anywhere above it. Node reports that as an unhandled rejection, which by
 * default takes the whole host process — the user's session — down with it.
 */
describe("startSubagent turn limits", () => {
	/** A run that hands its session over and then never finishes. */
	function runWith(stub: ReturnType<typeof stubSession>) {
		return vi.fn((opts: RunSubagentOptions) => {
			opts.onSession?.(stub.session as never, "/tmp/sessions/abc123.jsonl");
			return new Promise<SubagentOutcome>(() => {});
		});
	}

	function launch(config: AgentConfig, stub: ReturnType<typeof stubSession>) {
		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config,
			prompt: "review",
			description: "review",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: runWith(stub),
			newId: () => "abc123",
			now: () => 1_000,
		});
		return registry;
	}

	// The path is how a finished conversation is found again, and only the runner
	// knows it.
	it("records where the subagent's transcript is being written", () => {
		const stub = stubSession();
		const registry = launch(agentConfig(), stub);

		expect(registry.get("abc123")?.sessionFile).toBe(
			"/tmp/sessions/abc123.jsonl",
		);
	});

	it("counts the subagent's turns onto its record", () => {
		const stub = stubSession();
		const registry = launch(agentConfig(), stub);

		stub.endTurn(3);

		expect(registry.get("abc123")?.turns).toBe(3);
	});

	it("holds a subagent to the limit its agent file sets", async () => {
		const stub = stubSession();
		launch(agentConfig({ maxTurns: 2 }), stub);

		stub.endTurn(2);
		await new Promise((resolve) => setImmediate(resolve));

		expect(stub.steer).toHaveBeenCalledTimes(1);
	});

	/**
	 * The warning is a warning, not a stop. A subagent that takes it and answers
	 * finishes normally, and the answer it gave is its result.
	 */
	// The specification's scenario, quoted.
	it("Returns the wrap-up answer", async () => {
		const stub = stubSession();
		const gate = deferred<SubagentOutcome>();
		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config: agentConfig({ maxTurns: 2 }),
			prompt: "review",
			description: "review",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: vi.fn((opts: RunSubagentOptions) => {
				opts.onSession?.(stub.session as never, undefined);
				return gate.promise;
			}),
			newId: () => "abc123",
			now: () => 1_000,
		});

		// The limit is reached, so it is told to wrap up.
		stub.endTurn(2);
		await settle();
		expect(stub.steer).toHaveBeenCalledTimes(1);

		// And it does, on its next turn.
		gate.settle({ status: "completed", output: "the queue is fine" });
		await send.delivered;

		expect(stub.abort).not.toHaveBeenCalled();
		expect(registry.get("abc123")?.status).toBe("completed");
		expect(delivered(send).message.content).toContain("the queue is fine");
	});

	it("stops one that runs past the limit and its grace", async () => {
		const stub = stubSession();
		const registry = launch(agentConfig({ maxTurns: 2 }), stub);

		stub.endTurn(5);
		await new Promise((resolve) => setImmediate(resolve));

		expect(stub.abort).toHaveBeenCalledTimes(1);
		expect(registry.get("abc123")?.stoppedBecause).toMatch(/turn limit/i);
	});

	/**
	 * An agent file naming no limit still gets one. Without this an agent
	 * written before there was a limit to write down would have no runaway
	 * protection at all, which is the one case the protection is for.
	 */
	it("falls back to the default limit when the agent file sets none", async () => {
		const stub = stubSession();
		launch(agentConfig(), stub);

		stub.endTurn(DEFAULT_MAX_TURNS);
		await new Promise((resolve) => setImmediate(resolve));

		expect(stub.steer).toHaveBeenCalledWith(WRAP_UP_MESSAGE);
	});

	it("leaves a subagent alone right up to the default limit", async () => {
		const stub = stubSession();
		const registry = launch(agentConfig(), stub);

		stub.endTurn(DEFAULT_MAX_TURNS - 1);
		await new Promise((resolve) => setImmediate(resolve));

		expect(stub.steer).not.toHaveBeenCalled();
		expect(stub.abort).not.toHaveBeenCalled();
		expect(registry.get("abc123")?.turns).toBe(DEFAULT_MAX_TURNS - 1);
	});

	// The agent file's own limit must still win over the default, or setting
	// `maxTurns:` would do nothing.
	it("prefers the agent file's limit to the default", async () => {
		const stub = stubSession();
		launch(agentConfig({ maxTurns: 2 }), stub);

		stub.endTurn(2);
		await new Promise((resolve) => setImmediate(resolve));

		expect(stub.steer).toHaveBeenCalledTimes(1);
		expect(DEFAULT_MAX_TURNS).toBeGreaterThan(2);
	});
});

describe("startSubagent when delivery fails", () => {
	it("leaves no unhandled rejection behind", async () => {
		const rejections: unknown[] = [];
		const record = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", record);

		try {
			const failing = vi.fn(() => {
				throw new Error("no session to send to");
			});
			startSubagent({
				ctx,
				config: agentConfig(),
				prompt: "review",
				description: "review",
				registry: new SubagentRegistry(),
				queue: new SubagentQueue(5),
				sendMessage: failing as unknown as SendMessage,
				run: run.run,
				newId: () => "abc123",
				now: () => 1_000,
			});

			run.finish({ status: "completed", output: "looks fine" });
			await vi.waitFor(() => expect(failing).toHaveBeenCalled());
			// Node decides a rejection is unhandled once the microtask queue has
			// drained, so give it two turns of the loop to say so.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", record);
		}
	});
});

describe("startSubagent context tracking", () => {
	it("keeps the record's session so it can be steered later", () => {
		const stub = stubSession();
		const tracking = stubRun();
		tracking.run.mockImplementation((opts: RunSubagentOptions) => {
			opts.onSession?.(stub.session as never, undefined);
			return new Promise<SubagentOutcome>(() => {});
		});

		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config: agentConfig(),
			prompt: "review",
			description: "review",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: tracking.run,
			newId: () => "abc123",
			now: () => 1_000,
		});

		expect(registry.get("abc123")?.session).toBe(stub.session);
	});

	it("follows the subagent's context use as it works", () => {
		const stub = stubSession();
		const tracking = stubRun();
		tracking.run.mockImplementation((opts: RunSubagentOptions) => {
			opts.onSession?.(stub.session as never, undefined);
			return new Promise<SubagentOutcome>(() => {});
		});

		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config: agentConfig(),
			prompt: "review",
			description: "review",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: tracking.run,
			newId: () => "abc123",
			now: () => 1_000,
		});
		stub.endTurn();

		expect(registry.get("abc123")?.contextPercent).toBe(12);
	});

	// Tracking is an observer. A session it cannot attach to costs the reading,
	// not the run.
	it("finishes the run even when it cannot be tracked", async () => {
		const untrackable = {} as never;
		const gate = deferred<SubagentOutcome>();
		const runner = vi.fn((opts: RunSubagentOptions) => {
			opts.onSession?.(untrackable, undefined);
			return gate.promise;
		});

		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config: agentConfig(),
			prompt: "review",
			description: "review",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: runner,
			newId: () => "abc123",
			now: () => 1_000,
		});
		gate.settle({ status: "completed", output: "looks fine" });
		await send.delivered;

		expect(registry.get("abc123")?.status).toBe("completed");
		expect(delivered(send).message.content).toContain("looks fine");
		expect(registry.get("abc123")?.contextPercent).toBeNull();
	});

	it("stops listening once the subagent is done", async () => {
		const stub = stubSession();
		const gate = deferred<SubagentOutcome>();
		const tracking = vi.fn((opts: RunSubagentOptions) => {
			opts.onSession?.(stub.session as never, undefined);
			return gate.promise;
		});

		const registry = new SubagentRegistry();
		startSubagent({
			ctx,
			config: agentConfig(),
			prompt: "review",
			description: "review",
			registry,
			queue: new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: tracking,
			newId: () => "abc123",
			now: () => 1_000,
		});
		gate.settle({ status: "completed", output: "done" });
		await send.delivered;

		expect(stub.unsubscribes).not.toHaveLength(0);
		expect(
			stub.unsubscribes.every((stop) => stop.mock.calls.length === 1),
		).toBe(true);
	});
});

/** A theme that colours nothing, so assertions read the text and not escapes. */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderCompletion>[2];

function completionMessage(
	details: SubagentCompleteDetails | undefined,
	content = 'Subagent "reviewer" (abc123) finished.\n\nlooks fine',
) {
	return {
		role: "custom" as const,
		customType: COMPLETE_MESSAGE_TYPE,
		content,
		display: true,
		details,
		timestamp: 0,
	};
}

const DETAILS: SubagentCompleteDetails = {
	id: "abc123",
	handle: "reviewer",
	agent: "reviewer",
	status: "completed",
	description: "review agents file",
	contextPercent: 12,
};

describe("renderCompletion", () => {
	it("heads the notice with the agent and what it was asked to do", () => {
		const component = renderCompletion(
			completionMessage(DETAILS),
			{ expanded: false, outputPad: 0 },
			plainTheme,
		);

		const lines = component?.render(80).join("\n") ?? "";
		expect(lines).toContain("reviewer");
		expect(lines).toContain("review agents file");
		expect(lines).not.toContain("looks fine");
	});

	it("shows the full message body when expanded", () => {
		const component = renderCompletion(
			completionMessage(DETAILS),
			{ expanded: true, outputPad: 0 },
			plainTheme,
		);

		const lines = component?.render(80).join("\n") ?? "";
		expect(lines).toContain("reviewer");
		expect(lines).toContain("review agents file");
		expect(lines).toContain("looks fine");
	});

	it("marks a failure differently from a success", () => {
		const ok = renderCompletion(
			completionMessage(DETAILS),
			{} as never,
			plainTheme,
		)?.render(80)[0];
		const bad = renderCompletion(
			completionMessage({ ...DETAILS, status: "failed" }),
			{} as never,
			plainTheme,
		)?.render(80)[0];

		expect(ok).not.toEqual(bad);
	});

	// Better pi's plain rendering than a box with blanks in it.
	it("stands aside for a notice carrying no details", () => {
		expect(
			renderCompletion(completionMessage(undefined), {} as never, plainTheme),
		).toBeUndefined();
	});
});

describe("resumeSubagent", () => {
	/** A finished subagent, with a transcript at `sessionFile` if given one. */
	function finished(sessionFile?: string): {
		registry: SubagentRegistry;
		record: SubagentRecord;
	} {
		const registry = new SubagentRegistry();
		const record: SubagentRecord = {
			id: "abc123",
			handle: "reviewer",
			type: "reviewer",
			config: agentConfig(),
			description: "review agents file",
			status: "completed",
			color: "cyan",
			startedAt: 1_000,
			contextPercent: 12,
			turns: 7,
			outcome: { status: "completed", output: "the earlier answer" },
			sessionFile,
		};
		registry.add(record);
		return { registry, record };
	}

	/** A file that really is on disk, so `existsSync` says so. */
	function storedTranscript(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-resume-"));
		const file = join(dir, "abc123.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc123"}\n');
		return file;
	}

	function resume(
		registry: SubagentRegistry,
		record: SubagentRecord,
		overrides: {
			config?: AgentConfig;
			run?: RunSubagentFn;
			queue?: SubagentQueue;
		} = {},
	) {
		return resumeSubagent({
			ctx,
			record,
			config: overrides.config ?? agentConfig(),
			prompt: "and what about runner.ts?",
			registry,
			queue: overrides.queue ?? new SubagentQueue(5),
			sendMessage: send.sendMessage as unknown as SendMessage,
			run: overrides.run ?? stubRun().run,
		});
	}

	// The specification's scenario, quoted: it continues its earlier
	// conversation.
	it("Continues a stored conversation", () => {
		const file = storedTranscript();
		const { registry, record } = finished(file);
		const run = stubRun();

		const result = resume(registry, record, { run: run.run });

		expect(result.ok && result.startedFresh).toBe(false);
		expect(run.calls[0]?.resumeFrom).toBe(file);
	});

	/**
	 * The spec calls this out: a transcript the user has deleted must be reported
	 * and started over, not failed silently. It is not a rare case — pi withholds
	 * the file until the child's first assistant reply, so a subagent that failed
	 * before answering names a file that never existed.
	 */
	// The specification's scenario, quoted: a new subagent starts with no
	// earlier context, and the reply says the earlier conversation was not found.
	it("Starts fresh when the conversation is gone", () => {
		const { registry, record } = finished(
			"/tmp/pi-subagents-never-written.jsonl",
		);
		const run = stubRun();

		const result = resume(registry, record, { run: run.run });

		expect(result.ok && result.startedFresh).toBe(true);
		expect(run.calls[0]?.resumeFrom).toBeUndefined();
	});

	it("starts fresh when the subagent never had a transcript at all", () => {
		const { registry, record } = finished(undefined);
		const run = stubRun();

		const result = resume(registry, record, { run: run.run });

		expect(result.ok && result.startedFresh).toBe(true);
		expect(run.calls[0]?.resumeFrom).toBeUndefined();
	});

	it("puts the same record back to work rather than making a second one", () => {
		const { registry, record } = finished(storedTranscript());

		const result = resume(registry, record);

		expect(result.ok && result.record).toBe(record);
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("abc123")?.status).toBe("running");
	});

	/**
	 * Left in place, the previous outcome would make the record read as finished
	 * while it is running again, and `get_subagent_result` would hand back the
	 * old answer as though it were this run's.
	 */
	it("clears the previous answer", () => {
		const { registry, record } = finished(storedTranscript());

		resume(registry, record);

		expect(registry.get("abc123")?.outcome).toBeUndefined();
	});

	it("clears why it stopped last time", () => {
		const { registry, record } = finished(storedTranscript());
		registry.update("abc123", {
			status: "stopped",
			stoppedBecause: "you asked it to stop",
		});

		resume(registry, record);

		expect(registry.get("abc123")?.stoppedBecause).toBeUndefined();
	});

	// The new run's turn watcher counts from zero, so the old total would only
	// sit on the record until the first turn overwrote it.
	it("resets the turn count for the new run", () => {
		const { registry, record } = finished(storedTranscript());

		resume(registry, record);

		expect(registry.get("abc123")?.turns).toBe(0);
	});

	/**
	 * The plan's point: a continuation runs under the type's current frontmatter,
	 * not the one in force at first run. The caller re-resolves the definition and
	 * this must pass that one through rather than anything remembered.
	 */
	it("runs under the definition it is given, not the original", () => {
		const { registry, record } = finished(storedTranscript());
		const run = stubRun();
		const rewritten = agentConfig({
			systemPrompt: "You review code very differently now.",
			maxTurns: 4,
		});

		resume(registry, record, { config: rewritten, run: run.run });

		expect(run.calls[0]?.config.systemPrompt).toBe(
			"You review code very differently now.",
		);
		expect(run.calls[0]?.config.maxTurns).toBe(4);
	});

	it("announces the continuation's answer when it finishes", async () => {
		const { registry, record } = finished(storedTranscript());
		const run = stubRun();

		resume(registry, record, { run: run.run });
		run.finish({ status: "completed", output: "runner.ts runs one subagent" });
		await send.delivered;

		expect(registry.get("abc123")?.status).toBe("completed");
		expect(send.sendMessage.mock.calls[0]?.[0].content).toContain(
			"runner.ts runs one subagent",
		);
	});

	// A continuation is a real run and takes a real slot, or a session at its
	// limit could be pushed past it by resuming finished subagents.
	it("waits its turn like any other run", () => {
		const { registry, record } = finished(storedTranscript());
		const queue = new SubagentQueue(1);
		queue.submit("already-running", () => new Promise<void>(() => {}));
		const run = stubRun();

		const result = resume(registry, record, { queue, run: run.run });

		expect(result.ok && result.record.status).toBe("queued");
		expect(run.run).not.toHaveBeenCalled();
	});

	/**
	 * Resuming something already under way would put two runs on one record,
	 * with the second overwriting the first's status and outcome. Redirecting a
	 * running subagent is what steering is for.
	 */
	it("refuses a subagent that has not finished", () => {
		for (const status of ["running", "queued"] as const) {
			const { registry, record } = finished(storedTranscript());
			registry.update("abc123", { status });
			const run = stubRun();

			const result = resume(registry, record, { run: run.run });

			expect(result.ok, status).toBe(false);
			expect(result.ok ? "" : result.reason, status).toMatch(/still/i);
			expect(run.run, status).not.toHaveBeenCalled();
		}
	});
});

/**
 * Stopping a subagent from the list or the open view.
 *
 * The tool path needs no notice — the model is holding the tool call and reads
 * the outcome in its result. The UI has no such result, and the model was
 * promised an answer at spawn, so the gap this closes is a main model waiting
 * for something that is never coming.
 */
describe("stopFromUi", () => {
	/** A subagent past the limit, with a run holding the only slot. */
	function queued() {
		const queue = new SubagentQueue(1);
		const running = start(run, send, { queue, id: "running" });
		const waiting = start(stubRun(), send, {
			queue,
			id: "waiting",
			registry: running.registry,
		});
		return { queue, registry: running.registry, record: waiting.record };
	}

	/** A subagent already under way, with a session to abort. */
	function underWay() {
		const registry = new SubagentRegistry();
		const abort = vi.fn(async () => {});
		const record: SubagentRecord = {
			id: "abc123",
			handle: "reviewer",
			type: "reviewer",
			config: agentConfig(),
			description: "review agents file",
			status: "running",
			color: "cyan",
			startedAt: 1_000,
			contextPercent: null,
			turns: 0,
			session: {
				abort,
				steer: vi.fn(async () => {}),
			} as unknown as SubagentRecord["session"],
		};
		registry.add(record);
		return { registry, record, abort, queue: new SubagentQueue(5) };
	}

	it("stops a subagent that never started", async () => {
		const { queue, registry, record } = queued();
		expect(record.status).toBe("queued");

		const result = await stopFromUi(
			record,
			{ registry, queue },
			send.sendMessage as unknown as SendMessage,
		);

		expect(result.ok).toBe(true);
		expect(registry.get("waiting")?.status).toBe("stopped");
	});

	/**
	 * A queued subagent's run never starts, so nothing else will ever settle it
	 * — this notice is the only thing that tells the main model to stop waiting.
	 */
	it("tells the conversation a queued subagent will not answer", async () => {
		const { queue, registry, record } = queued();

		await stopFromUi(
			record,
			{ registry, queue },
			send.sendMessage as unknown as SendMessage,
		);

		const { message, options } = delivered(send);
		expect(message.customType).toBe(COMPLETE_MESSAGE_TYPE);
		expect(message.content).toMatch(/stopped/i);
		expect(message.content).toMatch(/incomplete/i);
		expect(message.details.id).toBe("waiting");
		// News that arrived, not an answer that was asked for.
		expect(options.deliverAs).toBe("followUp");
		expect(options.triggerTurn).toBe(true);
	});

	/**
	 * A queued subagent that has just been handed a slot cannot be dropped from
	 * the queue any more, so the stop is refused — and a notice sent anyway would
	 * tell the main model to stop waiting for a subagent still working.
	 */
	it("says nothing when a queued subagent could not be dropped", async () => {
		const registry = new SubagentRegistry();
		const record: SubagentRecord = {
			id: "abc123",
			handle: "reviewer",
			type: "reviewer",
			config: agentConfig(),
			description: "review agents file",
			status: "queued",
			color: "cyan",
			startedAt: 1_000,
			contextPercent: null,
			turns: 0,
		};
		registry.add(record);

		// Never submitted, so the queue has nothing of that id to cancel — which
		// is what a subagent that has just taken its slot looks like.
		const result = await stopFromUi(
			record,
			{ registry, queue: new SubagentQueue(5) },
			send.sendMessage as unknown as SendMessage,
		);

		expect(result.ok).toBe(false);
		expect(send.sendMessage).not.toHaveBeenCalled();
	});

	/**
	 * A running subagent's own run settles into a stopped outcome and announces
	 * it. Saying so here as well would have the model reading one stop as two.
	 */
	it("leaves a running subagent's notice to its own run", async () => {
		const { registry, record, abort, queue } = underWay();

		const result = await stopFromUi(
			record,
			{ registry, queue },
			send.sendMessage as unknown as SendMessage,
		);

		expect(result.ok).toBe(true);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(send.sendMessage).not.toHaveBeenCalled();
	});

	it("says nothing when the stop was refused", async () => {
		const { registry, record, queue } = underWay();
		registry.update(record.id, { status: "completed" });

		const result = await stopFromUi(
			record,
			{ registry, queue },
			send.sendMessage as unknown as SendMessage,
		);

		expect(result.ok).toBe(false);
		expect(send.sendMessage).not.toHaveBeenCalled();
	});
});
