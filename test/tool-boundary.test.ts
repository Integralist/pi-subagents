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
import {
	createResultTool,
	createSpawnTool,
	type SpawnDetails,
} from "../src/index.ts";
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
}) {
	const factoryCalls: CreateAgentSessionOptions[] = [];

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
					prompt: vi.fn(async () => {}),
					abort: vi.fn(async () => {}),
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
	const tool = createSpawnTool({
		discover: () => options.agents ?? [agentConfig()],
		run: (opts) => runSubagent({ ...opts, createSession }),
		getKnownTools: () => ["read", "bash", "edit", "write"],
		registry,
		sendMessage: sendMessage as unknown as SendMessage,
		newId: () => options.id ?? "sub-1",
	});
	const resultTool = createResultTool({ registry });

	return {
		tool,
		resultTool,
		factoryCalls,
		createSession,
		registry,
		sendMessage,
		delivered,
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
