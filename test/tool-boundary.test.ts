/**
 * The tool boundary, wired end to end.
 *
 * These exercise `spawn_subagent` through the real `runSubagent`, stubbing only
 * the session factory. The specification names this the highest seam that
 * carries all agent-facing behaviour without needing a real model, and the
 * `it` names below quote its scenarios.
 */

import type {
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { createSpawnTool, type SpawnDetails } from "../src/index.ts";
import { runSubagent } from "../src/runner.ts";

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
				},
			} as unknown as CreateAgentSessionResult;
		},
	);

	const tool = createSpawnTool({
		discover: () => options.agents ?? [agentConfig()],
		run: (opts) => runSubagent({ ...opts, createSession }),
		getKnownTools: () => ["read", "bash", "edit", "write"],
	});

	return { tool, factoryCalls, createSession };
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
		const { tool, factoryCalls } = toolOverRealRunner({});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);

		expect(factoryCalls).toHaveLength(1);
		expect(factoryCalls[0]?.model).toBe(PARENT_MODEL);
		expect(factoryCalls[0]?.thinkingLevel).toBe("high");
	});

	it("gives the child the agent's system prompt, not the parent's", async () => {
		const { tool, factoryCalls } = toolOverRealRunner({
			agents: [agentConfig({ systemPrompt: "You are a picky reviewer." })],
		});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);

		expect(factoryCalls[0]?.resourceLoader?.getSystemPrompt()).toBe(
			"You are a picky reviewer.",
		);
	});

	it("returns the subagent's answer to the caller", async () => {
		const { tool } = toolOverRealRunner({
			reply: [assistant("two defects found")],
		});

		const result = await tool.execute(
			"call-1",
			ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("two defects found");
		expect((result.details as SpawnDetails).status).toBe("completed");
	});
});

describe("Feature: Containing a subagent failure", () => {
	it("Reports a failing subagent as failed", async () => {
		const { tool } = toolOverRealRunner({
			failWith: new Error("no model configured"),
		});

		const result = await tool.execute(
			"call-1",
			ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect((result.details as SpawnDetails).status).toBe("failed");
		// And the failure reason is available to the main agent.
		expect(resultText(result)).toContain("no model configured");
	});

	it("names the failing agent exactly once in the reported reason", async () => {
		const { tool } = toolOverRealRunner({
			failWith: new Error("no model configured"),
		});

		const result = await tool.execute(
			"call-1",
			ARGS,
			undefined,
			undefined,
			ctx,
		);
		const text = resultText(result);

		// The runner names the agent and so did the tool, which read as
		// 'The "reviewer" subagent failed: subagent "reviewer" failed: ...'.
		expect(text.match(/reviewer/g) ?? []).toHaveLength(1);
	});

	it("names the agent when the failure came from the provider instead", async () => {
		const { tool } = toolOverRealRunner({
			reply: [assistant("", "error", "the provider refused")],
		});

		const result = await tool.execute(
			"call-1",
			ARGS,
			undefined,
			undefined,
			ctx,
		);
		const text = resultText(result);

		expect(text).toContain("the provider refused");
		expect(text).toContain("reviewer");
	});

	it("Leaves the main session working", async () => {
		const failing = toolOverRealRunner({
			failWith: new Error("subagent exploded"),
		});

		await failing.tool.execute("call-1", ARGS, undefined, undefined, ctx);

		// The parent's own context is untouched: same model, same effort.
		expect(ctx.model).toBe(PARENT_MODEL);
		expect(ctx.thinkingLevel).toBe("high");

		// And it still accepts input — a second delegation works normally.
		const healthy = toolOverRealRunner({ reply: [assistant("second answer")] });
		const result = await healthy.tool.execute(
			"call-2",
			ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("second answer");
	});

	it("Leaves sibling subagents working", async () => {
		// Slice 3 owns real concurrency; this checks the containment claim holds
		// when two runs overlap, which is all Slice 1 can already do.
		const failing = toolOverRealRunner({ failWith: new Error("one exploded") });
		const healthy = toolOverRealRunner({ reply: [assistant("still here")] });

		const [failed, survived] = await Promise.all([
			failing.tool.execute("call-1", ARGS, undefined, undefined, ctx),
			healthy.tool.execute("call-2", ARGS, undefined, undefined, ctx),
		]);

		expect((failed.details as SpawnDetails).status).toBe("failed");
		expect((survived.details as SpawnDetails).status).toBe("completed");
		expect(resultText(survived)).toContain("still here");
	});

	it("keeps the child's transcript out of the parent's session", async () => {
		const { tool, factoryCalls } = toolOverRealRunner({});

		await tool.execute("call-1", ARGS, undefined, undefined, ctx);

		// The child was given its own in-memory manager rather than the
		// parent's, so nothing it said can land in the parent's session file.
		const manager = factoryCalls[0]?.sessionManager;
		expect(manager).toBeDefined();
		expect(manager?.getSessionFile()).toBeUndefined();
	});
});
