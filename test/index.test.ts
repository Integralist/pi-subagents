import type { Api, Model } from "@earendil-works/pi-ai";
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
	RESULT_TOOL_NAME,
	SPAWN_TOOL_NAME,
} from "../src/index.ts";
import { SubagentRegistry } from "../src/registry.ts";
import { runInChildContext, type SubagentOutcome } from "../src/runner.ts";
import type { SendMessage } from "../src/spawn.ts";

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

function fakeModel(provider: string, id: string, name = id): Model<Api> {
	return { provider, id, name } as unknown as Model<Api>;
}

const GEMINI_FLASH = fakeModel(
	"google",
	"gemini-2.5-flash",
	"Gemini 2.5 Flash",
);
const CLAUDE_OPUS = fakeModel(
	"anthropic",
	"claude-opus-4-5",
	"Claude Opus 4.5",
);
/** Two of these, so "gpt" is an ambiguous query. */
const CATALOGUE = [
	GEMINI_FLASH,
	CLAUDE_OPUS,
	fakeModel("openai", "gpt-4"),
	fakeModel("openai", "gpt-4-turbo"),
];

/** Two flash models, so "flash" is ambiguous the way it is for a real user. */
const FLASH_36 = fakeModel(
	"google-vertex",
	"gemini-3.6-flash",
	"Gemini 3.6 Flash",
);
const FLASH_37 = fakeModel(
	"google-vertex",
	"gemini-3.7-flash",
	"Gemini 3.7 Flash",
);

interface ContextOptions {
	/** Resolved from enabledModels / --models. Empty means unscoped. */
	scoped?: Model<Api>[];
	available?: Model<Api>[];
	all?: Model<Api>[];
	hasUI?: boolean;
	/** What the user picks in the dialog; undefined means they dismissed it. */
	pick?: string | undefined;
}

let selectCalls: Array<{
	title: string;
	options: string[];
	signal?: AbortSignal;
}>;

function fakeContext(options: ContextOptions = {}): ExtensionContext {
	return {
		cwd: "/tmp/project",
		hasUI: options.hasUI ?? true,
		scopedModels: (options.scoped ?? []).map((model) => ({ model })),
		modelRegistry: {
			getAvailable: () => options.available ?? [],
			getAll: () => options.all ?? CATALOGUE,
		},
		ui: {
			select: vi.fn(
				async (
					title: string,
					opts: string[],
					dialog?: { signal?: AbortSignal },
				) => {
					selectCalls.push({ title, options: opts, signal: dialog?.signal });
					return options.pick;
				},
			),
		},
	} as unknown as ExtensionContext;
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
	registry: SubagentRegistry;
	sendMessage: ReturnType<typeof vi.fn>;
	/** Resolves once the completion notice has been delivered. */
	delivered: Promise<void>;
}

/**
 * The spawn tool over a stubbed runner.
 *
 * Spawning is detached now, so the answer never reaches the tool result. A
 * test that cares about the answer awaits `delivered` and reads the notice.
 */
function harness(
	options: {
		agents?: AgentConfig[];
		knownTools?: string[];
		outcome?: SubagentOutcome;
		/** A run that never finishes, so waiting on it would hang the test. */
		hang?: boolean;
	} = {},
): Harness {
	const discover = vi.fn(() => options.agents ?? [agentConfig()]);
	const run = vi.fn(
		async (): Promise<SubagentOutcome> =>
			options.hang
				? new Promise<SubagentOutcome>(() => {})
				: (options.outcome ?? { status: "completed", output: "looks fine" }),
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
		discover,
		run,
		getKnownTools: () =>
			options.knownTools ?? ["read", "bash", "edit", "write"],
		registry,
		sendMessage: sendMessage as unknown as SendMessage,
		newId: () => "sub-1",
	});
	return { tool, run, discover, registry, sendMessage, delivered };
}

/** The text of the completion notice the harness captured. */
function noticeText(sendMessage: ReturnType<typeof vi.fn>): string {
	const call = sendMessage.mock.calls[0];
	if (!call) throw new Error("no completion notice was delivered");
	return (call[0] as { content: string }).content;
}

const VALID_ARGS = {
	subagent_type: "reviewer",
	prompt: "review src/agents.ts",
	description: "review agents file",
};

let ctx: ExtensionContext;

beforeEach(() => {
	selectCalls = [];
	ctx = fakeContext();
});

describe("extension registration", () => {
	function register() {
		const registered: ToolDefinition[] = [];
		const renderers: string[] = [];
		const pi = {
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			getAllTools: () => [],
			registerMessageRenderer: (customType: string) =>
				renderers.push(customType),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;

		extension(pi);
		return { registered, renderers };
	}

	it("registers the spawn tool", () => {
		expect(register().registered.map((t) => t.name)).toContain(SPAWN_TOOL_NAME);
	});

	it("registers the tool that reads a result back", () => {
		expect(register().registered.map((t) => t.name)).toContain(
			RESULT_TOOL_NAME,
		);
	});

	// Without a renderer the notice shows up as raw text in the transcript.
	it("registers a renderer for the completion notice", () => {
		expect(register().renderers).toContain("subagent-complete");
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
	// The plan's acceptance criterion for Task 3.4, quoted: spawning returns
	// immediately with an id rather than the answer.
	// Over a run that never finishes: if the tool waited for the subagent, this
	// test would hang rather than fail.
	it("returns an id without waiting for the subagent", async () => {
		const { tool, registry } = harness({ hang: true });

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("sub-1");
		expect(registry.get("sub-1")?.status).toBe("running");
	});

	it("keeps the subagent's output out of the immediate result", async () => {
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

		expect(resultText(result)).not.toContain("found two bugs");
	});

	it("delivers the subagent's output once it finishes", async () => {
		const { tool, sendMessage, delivered } = harness({
			outcome: { status: "completed", output: "found two bugs" },
		});

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);
		await delivered;

		expect(noticeText(sendMessage)).toContain("found two bugs");
	});

	it("records the subagent so the result can be read back", async () => {
		const { tool, registry } = harness();

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect((result.details as { id: string }).id).toBe("sub-1");
		expect(registry.get("sub-1")).toBeDefined();
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

	/**
	 * The opposite of what Slice 1 wanted. The tool call ends the moment it
	 * returns an id, taking its signal with it, so handing that signal to a
	 * background run would abort every subagent immediately.
	 */
	it("keeps the caller's abort signal away from the runner", async () => {
		const { tool, run } = harness();
		const controller = new AbortController();

		await tool.execute("call-1", VALID_ARGS, controller.signal, undefined, ctx);

		expect(run.mock.calls[0]?.[0].signal).toBeUndefined();
	});

	it("keeps running after the tool call that started it is aborted", async () => {
		const { tool, sendMessage, delivered } = harness({
			outcome: { status: "completed", output: "still finished" },
		});
		const controller = new AbortController();

		await tool.execute("call-1", VALID_ARGS, controller.signal, undefined, ctx);
		controller.abort();
		await delivered;

		expect(noticeText(sendMessage)).toContain("still finished");
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

	it("reports a failed subagent in a notice rather than a tool error", async () => {
		const { tool, sendMessage, delivered } = harness({
			outcome: {
				status: "failed",
				output: "",
				error: 'subagent "reviewer" failed: it ran out of road',
			},
		});

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);
		await delivered;

		// The spawn itself succeeded — a rejected execute would have failed this
		// test on the await above — and the subagent is what failed.
		expect((result.details as { status: string }).status).toBe("running");
		expect(noticeText(sendMessage)).toContain("it ran out of road");
	});

	it("reports a stopped subagent with whatever it managed to say", async () => {
		const { tool, sendMessage, delivered } = harness({
			outcome: { status: "stopped", output: "got halfway" },
		});

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);
		await delivered;

		expect(noticeText(sendMessage)).toContain("got halfway");
		expect(noticeText(sendMessage)).toMatch(/stopped/i);
	});
});

describe("spawn_subagent model and effort overrides", () => {
	// The specification's scenario, quoted.
	it("Honours an explicit model and effort", async () => {
		const { tool, run } = harness();

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash", thinking: "low" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].model).toBe(GEMINI_FLASH);
		expect(run.mock.calls[0]?.[0].thinkingLevel).toBe("low");
	});

	// The specification's scenario, quoted.
	it("Resolves a partial model name", async () => {
		const { tool, run } = harness();

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].model).toBe(GEMINI_FLASH);
	});

	// The specification's scenario, quoted.
	it("Refuses an unknown model name", async () => {
		const { tool, run } = harness();

		await expect(
			tool.execute(
				"call-1",
				{ ...VALID_ARGS, model: "nope" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/gemini-2\.5-flash[\s\S]*claude-opus-4-5/);

		// And no subagent starts.
		expect(run).not.toHaveBeenCalled();
	});

	// Ambiguity used to refuse outright. It now asks the user instead, covered
	// by "spawn_subagent ambiguous model selection" below — including the
	// refusal that still applies when no dialog-capable UI exists.

	// The specification's scenario, quoted.
	it("Inherits the parent model and effort by default", async () => {
		const { tool, run } = harness();

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		// Nothing forced, so runSubagent falls back to the parent's own.
		expect(run.mock.calls[0]?.[0].model).toBeUndefined();
		expect(run.mock.calls[0]?.[0].thinkingLevel).toBeUndefined();
	});

	it("lets the caller's model win over the agent file's", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ model: "opus" })],
		});

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].model).toBe(GEMINI_FLASH);
	});

	it("uses the agent file's model when the caller names none", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ model: "opus" })],
		});

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(run.mock.calls[0]?.[0].model).toBe(CLAUDE_OPUS);
	});

	it("lets the caller's effort win over the agent file's", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ thinking: "xhigh" })],
		});

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, thinking: "minimal" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].thinkingLevel).toBe("minimal");
	});

	it("accepts `off` as an effort level, as pi's own flag does", async () => {
		const { tool, run } = harness();

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, thinking: "off" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].thinkingLevel).toBe("off");
	});

	it("refuses an agent file naming a model that is not configured", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ model: "hallucinated-model" })],
		});

		await expect(
			tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx),
		).rejects.toThrow(/hallucinated-model/);

		expect(run).not.toHaveBeenCalled();
	});

	it("offers every thinking level pi defines in the schema", () => {
		const { tool } = harness();
		const schema = tool.parameters as {
			properties: { thinking?: { enum?: string[] } };
		};

		expect(schema.properties.thinking?.enum).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("leaves model and thinking optional in the schema", () => {
		const { tool } = harness();
		const schema = tool.parameters as { required?: string[] };

		expect(schema.required).not.toContain("model");
		expect(schema.required).not.toContain("thinking");
	});
});

/**
 * Which models a query may resolve to. A catalogue holds models a user has no
 * access to, so resolving against all of them would happily pick one that
 * cannot run.
 */
describe("spawn_subagent model candidates", () => {
	it("resolves against the scoped models when scoping is configured", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({
			scoped: [FLASH_37],
			available: [FLASH_36, FLASH_37],
			all: CATALOGUE,
		});

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		// Unambiguous within the scoped set, even though it is not within the
		// wider catalogue.
		expect(run.mock.calls[0]?.[0].model).toBe(FLASH_37);
		expect(selectCalls).toHaveLength(0);
	});

	it("cannot resolve a catalogue model that scoping excludes", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({
			scoped: [FLASH_37],
			all: [...CATALOGUE, fakeModel("nowhere", "made-up-foo-flash")],
		});

		await expect(
			tool.execute(
				"call-1",
				{ ...VALID_ARGS, model: "made-up-foo-flash" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/unknown model/i);

		expect(run).not.toHaveBeenCalled();
	});

	it("falls back to models with configured auth when nothing is scoped", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({
			scoped: [],
			available: [CLAUDE_OPUS],
			all: CATALOGUE,
		});

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "opus" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].model).toBe(CLAUDE_OPUS);
	});

	it("falls back to the whole catalogue when neither is configured", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({ scoped: [], available: [], all: CATALOGUE });

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].model).toBe(GEMINI_FLASH);
	});
});

describe("spawn_subagent ambiguous model selection", () => {
	it("asks the user to choose when a query matches more than one model", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({
			scoped: [FLASH_36, FLASH_37],
			pick: "google-vertex/gemini-3.7-flash",
		});

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		expect(selectCalls).toHaveLength(1);
		expect(selectCalls[0]?.options).toEqual([
			"google-vertex/gemini-3.6-flash",
			"google-vertex/gemini-3.7-flash",
		]);
		// The title names the subagent, so the prompt is not context-free.
		expect(selectCalls[0]?.title).toContain("reviewer");
		expect(run.mock.calls[0]?.[0].model).toBe(FLASH_37);
	});

	it("passes the abort signal so the dialog dies with the turn", async () => {
		const { tool } = harness();
		ctx = fakeContext({
			scoped: [FLASH_36, FLASH_37],
			pick: "google-vertex/gemini-3.6-flash",
		});
		const signal = new AbortController().signal;

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			signal,
			undefined,
			ctx,
		);

		expect(selectCalls[0]?.signal).toBe(signal);
	});

	it("inherits the parent's model when the user dismisses the dialog", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({ scoped: [FLASH_36, FLASH_37], pick: undefined });

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0]?.[0].model).toBeUndefined();
	});

	it("says in the result that it fell back, so the choice is not silent", async () => {
		const { tool } = harness();
		ctx = fakeContext({ scoped: [FLASH_36, FLASH_37], pick: undefined });

		const result = await tool.execute(
			"call-1",
			{ ...VALID_ARGS, model: "flash" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toMatch(/current model|parent/i);
	});

	it("refuses instead of asking when there is no dialog-capable UI", async () => {
		const { tool, run } = harness();
		ctx = fakeContext({ scoped: [FLASH_36, FLASH_37], hasUI: false });

		await expect(
			tool.execute(
				"call-1",
				{ ...VALID_ARGS, model: "flash" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/matches more than one/i);

		// Blocking on a dialog nobody can see would hang a headless run.
		expect(selectCalls).toHaveLength(0);
		expect(run).not.toHaveBeenCalled();
	});

	it("does not ask about an unknown model, only an ambiguous one", async () => {
		const { tool } = harness();
		ctx = fakeContext({ scoped: [FLASH_36, FLASH_37] });

		await expect(
			tool.execute(
				"call-1",
				{ ...VALID_ARGS, model: "totally-absent" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/unknown model/i);

		expect(selectCalls).toHaveLength(0);
	});

	it("asks about an ambiguous model named by the agent file too", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ model: "flash" })],
		});
		ctx = fakeContext({
			scoped: [FLASH_36, FLASH_37],
			pick: "google-vertex/gemini-3.6-flash",
		});

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(selectCalls).toHaveLength(1);
		expect(run.mock.calls[0]?.[0].model).toBe(FLASH_36);
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
