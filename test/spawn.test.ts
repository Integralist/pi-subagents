import type {
	AgentSessionEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { PALETTE } from "../src/colors.ts";
import { SubagentQueue } from "../src/queue.ts";
import { SubagentRegistry } from "../src/registry.ts";
import type { RunSubagentOptions, SubagentOutcome } from "../src/runner.ts";
import {
	COMPLETE_MESSAGE_TYPE,
	renderCompletion,
	type SendMessage,
	type SubagentCompleteDetails,
	startSubagent,
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
			opts.onSession?.(stub.session as never);
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
			opts.onSession?.(stub.session as never);
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
			opts.onSession?.(stub.session as never);
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
			opts.onSession?.(untrackable);
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
			opts.onSession?.(stub.session as never);
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
			{} as never,
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
