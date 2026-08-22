/**
 * The tool boundary, wired end to end.
 *
 * These exercise `spawn_subagent` and `get_subagent_result` through the real
 * `runSubagent`, `startSubagent` and registry, stubbing only the session
 * factory and the delivery of the completion notice. The specification names
 * this the highest seam that carries all agent-facing behaviour without needing
 * a real model, and the `it` names below quote its scenarios.
 *
 * Spawning is detached, so a subagent's answer never appears in the tool
 * result. A test that wants the answer awaits `delivered` and reads the notice,
 * or asks `get_subagent_result` for it.
 */

import type {
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { STOPPED_BY_USER } from "../src/control.ts";
import {
	type ControlDetails,
	createResultTool,
	createSpawnTool,
	createSteerTool,
	createStopTool,
	type SpawnDetails,
} from "../src/index.ts";
import { SubagentQueue } from "../src/queue.ts";
import { SubagentRegistry } from "../src/registry.ts";
import { runSubagent } from "../src/runner.ts";
import type { SendMessage } from "../src/spawn.ts";

const PARENT_MODEL = { id: "parent-model" };

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
		description: "reviews code",
		systemPrompt: "You review code.",
		source: "project",
		filePath: "/tmp/reviewer.md",
		...overrides,
	};
}

function parentContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		model: PARENT_MODEL,
		thinkingLevel: "high",
	} as unknown as ExtensionContext;
}

function assistant(text: string, stopReason = "stop", errorMessage?: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
}

function resultText(result: { content: Array<{ type: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * Build the tool over the real runner, with only the session stubbed.
 *
 * `sessionFactory` stands in for `createAgentSession`; passing one that throws
 * is how a crashing subagent is simulated without a model.
 */
function toolOverRealRunner(options: {
	agents?: AgentConfig[];
	reply?: unknown[];
	failWith?: Error;
	id?: string;
	/** Ids handed out in order, for a test that needs more than one subagent. */
	ids?: string[];
	limit?: number;
	/**
	 * Leave the child's `prompt` unresolved, so the subagent stays running for a
	 * test that wants to steer or stop it. Such a test must not await
	 * `delivered`: nothing will ever settle the run.
	 */
	hangPrompt?: boolean;
}) {
	const factoryCalls: CreateAgentSessionOptions[] = [];

	// Hoisted out of the factory so a test can assert on what the child was
	// asked to do after the tool call that asked it has returned.
	const steer = vi.fn(async (_text: string) => {});
	const abort = vi.fn(async () => {});

	const createSession = vi.fn(
		async (
			opts: CreateAgentSessionOptions,
		): Promise<CreateAgentSessionResult> => {
			factoryCalls.push(opts);
			if (options.failWith) {
				throw options.failWith;
			}
			return {
				session: {
					messages: options.reply ?? [assistant("looks fine")],
					prompt: options.hangPrompt
						? vi.fn(() => new Promise<void>(() => {}))
						: vi.fn(async () => {}),
					steer,
					abort,
					dispose: vi.fn(),
					// Context tracking subscribes to the child the moment it exists.
					subscribe: vi.fn(() => vi.fn()),
					getContextUsage: () => ({
						tokens: 1_000,
						contextWindow: 200_000,
						percent: 12,
					}),
				},
			} as unknown as CreateAgentSessionResult;
		},
	);

	let arrived!: () => void;
	const delivered = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const sendMessage = vi.fn((_message: unknown, _options?: unknown) => {
		arrived();
	});

	const registry = new SubagentRegistry();
	const queue = new SubagentQueue(options.limit ?? 5);
	const handedOut = [...(options.ids ?? [])];
	const tool = createSpawnTool({
		discover: () => options.agents ?? [agentConfig()],
		run: (opts) => runSubagent({ ...opts, createSession }),
		getKnownTools: () => ["read", "bash", "edit", "write"],
		registry,
		queue,
		sendMessage: sendMessage as unknown as SendMessage,
		newId: () => handedOut.shift() ?? options.id ?? "sub-1",
	});
	const resultTool = createResultTool({ registry });
	const steerTool = createSteerTool({ registry });
	const stopTool = createStopTool({ registry, queue });

	return {
		tool,
		resultTool,
		steerTool,
		stopTool,
		factoryCalls,
		createSession,
		registry,
		queue,
		sendMessage,
		delivered,
		steer,
		abort,
	};
}

/** The text of the completion notice, as the conversation would receive it. */
function noticeText(sendMessage: ReturnType<typeof vi.fn>): string {
	const call = sendMessage.mock.calls[0];
	if (!call) throw new Error("no completion notice was delivered");
	return (call[0] as { content: string }).content;
}

const ARGS = {
	subagent_type: "reviewer",
	prompt: "review src/agents.ts",
	description: "review agents file",
};

let ctx: ExtensionContext;

beforeEach(() => {
	ctx = parentContext();
});

describe("Feature: Starting a subagent", () => {
	it("Inherits the parent model and effort by default", async () => {
		const { tool, factoryCalls, delivered } = toolOverRealRunner({});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		// Detached: what the run asked the SDK for is only settled once its
		// completion notice has gone out.
		await delivered;

		expect(factoryCalls).toHaveLength(1);
		expect(factoryCalls[0]?.model).toBe(PARENT_MODEL);
		expect(factoryCalls[0]?.thinkingLevel).toBe("high");
	});

	it("gives the child the agent's system prompt, not the parent's", async () => {
		const { tool, factoryCalls, delivered } = toolOverRealRunner({
			agents: [agentConfig({ systemPrompt: "You are a picky reviewer." })],
		});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;

		expect(factoryCalls[0]?.resourceLoader?.getSystemPrompt()).toBe(
			"You are a picky reviewer.",
		);
	});

	it("delivers the subagent's answer when it finishes", async () => {
		const { tool, sendMessage, delivered, registry } = toolOverRealRunner({
			reply: [assistant("two defects found")],
		});

		const result = await tool.execute(
			"call-1",
			ARGS,
			undefined,
			undefined,
			ctx,
		);
		await delivered;

		// The spawn reports only that a subagent is under way.
		expect((result.details as SpawnDetails).status).toBe("running");
		expect(noticeText(sendMessage)).toContain("two defects found");
		expect(registry.get("sub-1")?.status).toBe("completed");
	});
});

describe("Feature: Reading a subagent result back", () => {
	// The plan's acceptance criterion for Task 3.5, quoted.
	it("returns the full output for a finished subagent", async () => {
		const { tool, resultTool, delivered } = toolOverRealRunner({
			reply: [assistant("two defects found")],
		});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;
		const result = await resultTool.execute(
			"call-2",
			{ id: "sub-1" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("two defects found");
	});

	// The plan's acceptance criterion for Task 3.5, quoted.
	it("says a running subagent has no result yet", async () => {
		const hanging = vi.fn(
			() => new Promise<never>(() => {}),
		) as unknown as () => Promise<never>;
		const registry = new SubagentRegistry();
		const spawn = createSpawnTool({
			discover: () => [agentConfig()],
			run: hanging,
			getKnownTools: () => ["read"],
			registry,
			queue: new SubagentQueue(5),
			sendMessage: vi.fn() as unknown as SendMessage,
			newId: () => "sub-1",
		});
		const resultTool = createResultTool({ registry });

		await spawn.execute("call-1", ARGS, undefined, undefined, ctx);
		const result = await resultTool.execute(
			"call-2",
			{ id: "sub-1" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toMatch(/still working/i);
		expect(resultText(result)).not.toMatch(/finished/i);
	});

	it("refuses an id it has never issued", async () => {
		const { resultTool } = toolOverRealRunner({});

		await expect(
			resultTool.execute("call-1", { id: "nope" }, undefined, undefined, ctx),
		).rejects.toThrow(/no subagent with id/i);
	});
});

describe("Feature: Steering, stopping, and collecting", () => {
	/** Spawn one subagent and leave it running, so it can be steered. */
	async function running(
		options: Parameters<typeof toolOverRealRunner>[0] = {},
	) {
		const harness = toolOverRealRunner({ ...options, hangPrompt: true });
		await harness.tool.execute("call-1", ARGS, undefined, undefined, ctx);
		// The run is detached, so the child session exists a tick after the tool
		// call returned. Steering before then has nothing to reach.
		await new Promise((resolve) => setImmediate(resolve));
		return harness;
	}

	// The specification's scenario, quoted.
	it("Redirects a running subagent", async () => {
		const { steerTool, steer } = await running();

		const result = await steerTool.execute(
			"call-2",
			{ id: "sub-1", message: "check the tests too" },
			undefined,
			undefined,
			ctx,
		);

		// The message appears in that subagent's conversation.
		expect(steer).toHaveBeenCalledWith("check the tests too");
		// And the subagent continues from that message.
		expect(resultText(result)).toMatch(/carries on/i);
	});

	// The specification's scenario, quoted.
	it("Refuses to steer a finished subagent", async () => {
		const { tool, steerTool, steer, delivered } = toolOverRealRunner({});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;

		await expect(
			steerTool.execute(
				"call-2",
				{ id: "sub-1", message: "one more thing" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/already finished/i);
		expect(steer).not.toHaveBeenCalled();
	});

	// The specification's scenario, quoted.
	it("Halts a running subagent", async () => {
		const { stopTool, abort, registry } = await running();

		const result = await stopTool.execute(
			"call-2",
			{ id: "sub-1" },
			undefined,
			undefined,
			ctx,
		);

		expect(abort).toHaveBeenCalledTimes(1);
		expect(registry.get("sub-1")?.stoppedBecause).toBe(STOPPED_BY_USER);
		// And its partial output is available.
		expect(resultText(result)).toMatch(/kept/i);
	});

	/**
	 * The mirror of refusing to steer one. A stop that quietly succeeded would
	 * leave the model believing it had halted work that in fact already finished
	 * and reported an answer.
	 */
	it("refuses to stop a subagent that has already finished", async () => {
		const { tool, stopTool, abort, delivered } = toolOverRealRunner({});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;

		await expect(
			stopTool.execute("call-2", { id: "sub-1" }, undefined, undefined, ctx),
		).rejects.toThrow(/already finished/i);
		expect(abort).not.toHaveBeenCalled();
	});

	it("refuses to steer or stop an id it has never issued", async () => {
		const { steerTool, stopTool } = toolOverRealRunner({});

		await expect(
			steerTool.execute(
				"call-1",
				{ id: "nope", message: "hello" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/no subagent with id/i);
		await expect(
			stopTool.execute("call-2", { id: "nope" }, undefined, undefined, ctx),
		).rejects.toThrow(/no subagent with id/i);
	});

	describe("stopping a subagent that never got a slot", () => {
		/** One subagent holding the only slot, and a second queued behind it. */
		async function queued() {
			const harness = toolOverRealRunner({
				limit: 1,
				ids: ["sub-1", "sub-2"],
				hangPrompt: true,
			});
			await harness.tool.execute("call-1", ARGS, undefined, undefined, ctx);
			await harness.tool.execute("call-2", ARGS, undefined, undefined, ctx);
			await new Promise((resolve) => setImmediate(resolve));
			return harness;
		}

		it("marks it stopped without ever starting it", async () => {
			const { stopTool, registry, createSession } = await queued();
			expect(registry.get("sub-2")?.status).toBe("queued");
			const sessionsBefore = createSession.mock.calls.length;

			await stopTool.execute(
				"call-3",
				{ id: "sub-2" },
				undefined,
				undefined,
				ctx,
			);
			await new Promise((resolve) => setImmediate(resolve));

			expect(registry.get("sub-2")?.status).toBe("stopped");
			// No session was ever built for it, so it never spent a token.
			expect(createSession.mock.calls).toHaveLength(sessionsBefore);
		});

		/**
		 * The details are read off the record after the operation, so they report
		 * what the stop actually did rather than the state it found.
		 */
		it("reports the dropped subagent as stopped in its details", async () => {
			const { stopTool } = await queued();

			const result = await stopTool.execute(
				"call-3",
				{ id: "sub-2" },
				undefined,
				undefined,
				ctx,
			);

			expect((result.details as ControlDetails).status).toBe("stopped");
		});

		it("leaves the subagent holding the slot alone", async () => {
			const { stopTool, registry, abort } = await queued();

			await stopTool.execute(
				"call-3",
				{ id: "sub-2" },
				undefined,
				undefined,
				ctx,
			);

			expect(registry.get("sub-1")?.status).toBe("running");
			expect(abort).not.toHaveBeenCalled();
		});

		/**
		 * Nothing will ever settle a subagent that never ran, so the record has to
		 * carry an outcome or `get_subagent_result` would report it as still
		 * working for the rest of the session.
		 */
		it("reports it as stopped rather than still working", async () => {
			const { stopTool, resultTool } = await queued();

			await stopTool.execute(
				"call-3",
				{ id: "sub-2" },
				undefined,
				undefined,
				ctx,
			);
			const result = await resultTool.execute(
				"call-4",
				{ id: "sub-2" },
				undefined,
				undefined,
				ctx,
			);

			expect(resultText(result)).not.toMatch(/still working/i);
			expect(resultText(result)).toMatch(/stopped/i);
			expect(resultText(result)).toMatch(/incomplete/i);
		});
	});
});

describe("Feature: Containing a subagent failure", () => {
	it("Reports a failing subagent as failed", async () => {
		const { tool, sendMessage, delivered, registry } = toolOverRealRunner({
			failWith: new Error("no model configured"),
		});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;

		expect(registry.get("sub-1")?.status).toBe("failed");
		// And the failure reason reaches the main agent.
		expect(noticeText(sendMessage)).toContain("no model configured");
	});

	it("names the failing agent exactly once in the reported reason", async () => {
		const { tool, sendMessage, delivered } = toolOverRealRunner({
			failWith: new Error("no model configured"),
		});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;
		const text = noticeText(sendMessage);

		// The runner names the agent and so did the tool, which read as
		// 'The "reviewer" subagent failed: subagent "reviewer" failed: ...'.
		expect(text.match(/reviewer/g) ?? []).toHaveLength(1);
	});

	it("names the agent when the failure came from the provider instead", async () => {
		const { tool, sendMessage, delivered } = toolOverRealRunner({
			reply: [assistant("", "error", "the provider refused")],
		});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;
		const text = noticeText(sendMessage);

		expect(text).toContain("the provider refused");
		expect(text).toContain("reviewer");
	});

	it("Leaves the main session working", async () => {
		const failing = toolOverRealRunner({
			failWith: new Error("subagent exploded"),
		});

		await failing.tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await failing.delivered;

		// The parent's own context is untouched: same model, same effort.
		expect(ctx.model).toBe(PARENT_MODEL);
		expect(ctx.thinkingLevel).toBe("high");

		// And it still accepts input — a second delegation works normally.
		const healthy = toolOverRealRunner({ reply: [assistant("second answer")] });
		await healthy.tool.execute("call-2", ARGS, undefined, undefined, ctx);
		await healthy.delivered;

		expect(noticeText(healthy.sendMessage)).toContain("second answer");
	});

	it("Leaves sibling subagents working", async () => {
		// Slice 3 owns real concurrency; this checks the containment claim holds
		// when two runs overlap, which is all Slice 1 can already do.
		const failing = toolOverRealRunner({ failWith: new Error("one exploded") });
		const healthy = toolOverRealRunner({ reply: [assistant("still here")] });

		await Promise.all([
			failing.tool.execute("call-1", ARGS, undefined, undefined, ctx),
			healthy.tool.execute("call-2", ARGS, undefined, undefined, ctx),
		]);
		await Promise.all([failing.delivered, healthy.delivered]);

		expect(failing.registry.get("sub-1")?.status).toBe("failed");
		expect(healthy.registry.get("sub-1")?.status).toBe("completed");
		expect(noticeText(healthy.sendMessage)).toContain("still here");
	});

	it("keeps the child's transcript out of the parent's session", async () => {
		const { tool, factoryCalls, delivered } = toolOverRealRunner({});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);
		await delivered;

		// The child was given its own in-memory manager rather than the
		// parent's, so nothing it said can land in the parent's session file.
		const manager = factoryCalls[0]?.sessionManager;
		expect(manager).toBeDefined();
		expect(manager?.getSessionFile()).toBeUndefined();
	});
});
