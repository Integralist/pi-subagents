import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import extension, {
	buildToolDescription,
	createSpawnTool,
	SPAWN_TOOL_NAME,
} from "../src/index.ts";
import { runInChildContext, type SubagentOutcome } from "../src/runner.ts";

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

function fakeContext(): ExtensionContext {
	return { cwd: "/tmp/project" } as unknown as ExtensionContext;
}

/** Text content joined out of a tool result, the way the model would read it. */
function resultText(result: { content: Array<{ type: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}

interface Harness {
	tool: ToolDefinition;
	run: ReturnType<typeof vi.fn>;
	discover: ReturnType<typeof vi.fn>;
}

function harness(
	options: {
		agents?: AgentConfig[];
		knownTools?: string[];
		outcome?: SubagentOutcome;
	} = {},
): Harness {
	const discover = vi.fn(() => options.agents ?? [agentConfig()]);
	const run = vi.fn(
		async (): Promise<SubagentOutcome> =>
			options.outcome ?? { status: "completed", output: "looks fine" },
	);
	const tool = createSpawnTool({
		discover,
		run,
		getKnownTools: () =>
			options.knownTools ?? ["read", "bash", "edit", "write"],
	});
	return { tool, run, discover };
}

const VALID_ARGS = {
	subagent_type: "reviewer",
	prompt: "review src/agents.ts",
	description: "review agents file",
};

let ctx: ExtensionContext;

beforeEach(() => {
	ctx = fakeContext();
});

describe("extension registration", () => {
	it("registers the spawn tool", () => {
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			getAllTools: () => [],
		} as unknown as ExtensionAPI;

		extension(pi);

		expect(registered.map((t) => t.name)).toContain(SPAWN_TOOL_NAME);
	});
});

describe("buildToolDescription", () => {
	it("names every available agent with its description", () => {
		const description = buildToolDescription([
			agentConfig({ name: "reviewer", description: "reviews code" }),
			agentConfig({ name: "tester", description: "writes tests" }),
		]);

		expect(description).toContain("reviewer");
		expect(description).toContain("reviews code");
		expect(description).toContain("tester");
		expect(description).toContain("writes tests");
	});

	it("says so plainly when no agents are defined", () => {
		expect(buildToolDescription([])).toMatch(/no .*agents/i);
	});
});

describe("spawn_subagent", () => {
	it("returns the subagent's output as the tool result", async () => {
		const { tool } = harness({
			outcome: { status: "completed", output: "found two bugs" },
		});

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("found two bugs");
	});

	it("passes the prompt and the named agent through to the runner", async () => {
		const { tool, run } = harness();

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(run).toHaveBeenCalledOnce();
		const opts = run.mock.calls[0]?.[0];
		expect(opts.prompt).toBe("review src/agents.ts");
		expect(opts.config.name).toBe("reviewer");
		expect(opts.ctx).toBe(ctx);
	});

	it("discovers agents from the session's working directory", async () => {
		const { tool, discover } = harness();

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(discover).toHaveBeenCalledWith("/tmp/project");
	});

	it("hands the caller's abort signal to the runner", async () => {
		const { tool, run } = harness();
		const signal = new AbortController().signal;

		await tool.execute("call-1", VALID_ARGS, signal, undefined, ctx);

		expect(run.mock.calls[0]?.[0].signal).toBe(signal);
	});

	it("honours a thinking level set in the agent file", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ thinking: "xhigh" })],
		});

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(run.mock.calls[0]?.[0].thinkingLevel).toBe("xhigh");
	});

	// The specification's scenario, quoted.
	it("refuses an unknown subagent type with a message listing the known types", async () => {
		const { tool, run } = harness({
			agents: [
				agentConfig({ name: "reviewer" }),
				agentConfig({ name: "tester" }),
			],
		});

		await expect(
			tool.execute(
				"call-1",
				{ ...VALID_ARGS, subagent_type: "nonexistent" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/reviewer.*tester|tester.*reviewer/s);

		// And no subagent starts.
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses clearly when no agents are defined at all", async () => {
		const { tool, run } = harness({ agents: [] });

		await expect(
			tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx),
		).rejects.toThrow(/no .*agents/i);

		expect(run).not.toHaveBeenCalled();
	});

	it("refuses to spawn from inside a subagent", async () => {
		const { tool, run } = harness();

		await runInChildContext(async () => {
			await expect(
				tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx),
			).rejects.toThrow(/subagent/i);
		});

		expect(run).not.toHaveBeenCalled();
	});

	it("reports a failed subagent as a result rather than a tool error", async () => {
		// The delegation itself worked; the subagent's failure is information the
		// main agent should be able to reason about, not a malfunction.
		const { tool } = harness({
			outcome: {
				status: "failed",
				output: "",
				error: "the provider refused",
			},
		});

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("the provider refused");
		expect((result.details as { status: string }).status).toBe("failed");
	});

	it("reports a stopped subagent with whatever it managed to say", async () => {
		const { tool } = harness({
			outcome: { status: "stopped", output: "got halfway" },
		});

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("got halfway");
		expect((result.details as { status: string }).status).toBe("stopped");
	});
});

describe("spawn_subagent tool allowlist validation", () => {
	it("drops a tool name pi does not know and says which", async () => {
		// Pi accepts an unknown name into the allowlist then silently drops it at
		// registration, so an agent asking for a misspelled tool would quietly
		// get no tools rather than the ones it named.
		const { tool, run } = harness({
			agents: [agentConfig({ tools: ["read", "nonexistent-tool"] })],
			knownTools: ["read", "bash"],
		});

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].config.tools).toEqual(["read"]);
		expect(resultText(result)).toContain("nonexistent-tool");
	});

	it("leaves a fully valid allowlist untouched and warns about nothing", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ tools: ["read", "bash"] })],
			knownTools: ["read", "bash", "edit"],
		});

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].config.tools).toEqual(["read", "bash"]);
		expect(resultText(result)).not.toMatch(/unknown tool/i);
	});

	it("passes no allowlist through when the agent named none", async () => {
		const { tool, run } = harness({ agents: [agentConfig()] });

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(run.mock.calls[0]?.[0].config.tools).toBeUndefined();
	});
});
