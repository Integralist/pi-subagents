import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { PALETTE } from "../src/colors.ts";
import extension, {
	buildToolDescription,
	configuredLimit,
	createListTool,
	createSpawnTool,
	LIST_TOOL_NAME,
	RESULT_TOOL_NAME,
	SPAWN_TOOL_NAME,
	STEER_TOOL_NAME,
	STOP_TOOL_NAME,
	SUBAGENT_LIST_WIDGET,
} from "../src/index.ts";
import { DEFAULT_CONCURRENCY, SubagentQueue } from "../src/queue.ts";
import { type SubagentRecord, SubagentRegistry } from "../src/registry.ts";
import { runInChildContext, type SubagentOutcome } from "../src/runner.ts";
import type { SendMessage } from "../src/spawn.ts";
import { SubagentList } from "../src/ui/subagent-list.ts";

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
	queue: SubagentQueue;
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
		/** How many subagents may run at once. Generous unless a test says so. */
		limit?: number;
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
	const queue = new SubagentQueue(options.limit ?? 5);
	let issued = 0;
	const tool = createSpawnTool({
		discover,
		run,
		getKnownTools: () =>
			options.knownTools ?? ["read", "bash", "edit", "write"],
		registry,
		queue,
		sendMessage: sendMessage as unknown as SendMessage,
		newId: () => {
			issued += 1;
			return `sub-${issued}`;
		},
	});
	return { tool, run, discover, registry, queue, sendMessage, delivered };
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
	interface MountedWidget {
		key: string;
		content: unknown;
		options?: { placement?: string };
	}

	function register() {
		const registered: ToolDefinition[] = [];
		const renderers: string[] = [];
		const handlers = new Map<string, (event: unknown, c: unknown) => void>();
		const pi = {
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			getAllTools: () => [],
			registerMessageRenderer: (customType: string) =>
				renderers.push(customType),
			sendMessage: vi.fn(),
			on: (event: string, handler: (e: unknown, c: unknown) => void) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;

		extension(pi);

		/** Start a session in `mode` and report what it mounted. */
		const startSession = (mode: string) => {
			const widgets: MountedWidget[] = [];
			const tuiContext = {
				mode,
				ui: {
					setWidget: (
						key: string,
						content: unknown,
						options?: { placement?: string },
					) => widgets.push({ key, content, options }),
					// The list reads the prompt to decide whether an arrow was meant
					// for it or for the cursor.
					getEditorText: () => "",
				},
			};
			handlers.get("session_start")?.({}, tuiContext);
			return widgets;
		};

		return { registered, renderers, handlers, startSession };
	}

	it("registers the spawn tool", () => {
		expect(register().registered.map((t) => t.name)).toContain(SPAWN_TOOL_NAME);
	});

	it("registers the tool that reads a result back", () => {
		expect(register().registered.map((t) => t.name)).toContain(
			RESULT_TOOL_NAME,
		);
	});

	it("registers the tool that redirects a running subagent", () => {
		expect(register().registered.map((t) => t.name)).toContain(STEER_TOOL_NAME);
	});

	it("registers the tool that halts a subagent", () => {
		expect(register().registered.map((t) => t.name)).toContain(STOP_TOOL_NAME);
	});

	it("registers the tool that lists the session's subagents", () => {
		expect(register().registered.map((t) => t.name)).toContain(LIST_TOOL_NAME);
	});

	/**
	 * The specification's decision, quoted: five tools are registered. A sixth
	 * would mean something was registered twice, which pi accepts silently.
	 */
	it("registers exactly the five tools and no more", () => {
		expect(
			register()
				.registered.map((t) => t.name)
				.sort(),
		).toEqual(
			[
				LIST_TOOL_NAME,
				RESULT_TOOL_NAME,
				SPAWN_TOOL_NAME,
				STEER_TOOL_NAME,
				STOP_TOOL_NAME,
			].sort(),
		);
	});

	// Without a renderer the notice shows up as raw text in the transcript.
	it("registers a renderer for the completion notice", () => {
		expect(register().renderers).toContain("subagent-complete");
	});

	describe("the subagent list widget", () => {
		it("mounts below the editor once the session starts", () => {
			const widgets = register().startSession("tui");

			expect(widgets).toHaveLength(1);
			expect(widgets[0]?.key).toBe(SUBAGENT_LIST_WIDGET);
			expect(widgets[0]?.options?.placement).toBe("belowEditor");
		});

		/** Build the mounted widget against a fake terminal and editor. */
		function mount() {
			const widgets = register().startSession("tui");
			const factory = widgets[0]?.content as (
				tui: unknown,
				theme: unknown,
			) => SubagentList;

			const keyListeners: Array<(data: string) => unknown> = [];
			const list = factory(
				{
					requestRender: () => {},
					addInputListener: (listener: (data: string) => unknown) => {
						keyListeners.push(listener);
						return () => keyListeners.splice(0);
					},
				},
				{
					fg: (_c: string, text: string) => text,
					bg: (_c: string, text: string) => text,
				},
			);
			return { list, keyListeners };
		}

		it("builds the list from the theme it is handed", () => {
			const { list } = mount();

			expect(list).toBeInstanceOf(SubagentList);
			expect(list.render(80)).toEqual([]);
			list.dispose();
		});

		/**
		 * Without this the list is drawn but cannot be navigated: it never holds
		 * focus, so an input listener is the only way keys reach it. And the
		 * listener has to go when the widget does, or it keeps taking arrows for a
		 * list that is no longer on screen.
		 */
		it("gives the list the terminal's key presses, and takes them back", () => {
			const { list, keyListeners } = mount();

			expect(keyListeners).toHaveLength(1);

			list.dispose();

			expect(keyListeners).toHaveLength(0);
		});

		/**
		 * The list is a terminal widget. A print, json or rpc run has no editor to
		 * sit below and nothing to redraw, and mounting there would ask pi for a
		 * component it has nowhere to put.
		 */
		it.each(["print", "json", "rpc"])("mounts nothing in %s mode", (mode) => {
			expect(register().startSession(mode)).toEqual([]);
		});
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
		expect(buildToolDescription([])).toMatch(/no agent files/i);
	});

	/**
	 * It used to say the tool "cannot be used yet" without agent files, which
	 * stopped being true the moment a caller could supply a character of its own.
	 */
	it("offers the supplied-character route instead of calling itself unusable", () => {
		const description = buildToolDescription([]);

		expect(description).not.toMatch(/cannot be used/i);
		expect(description).toContain("system_prompt");
	});

	/** The naming rule only works if the tool actually asks for a name. */
	it("tells the caller to name each subagent itself", () => {
		const description = buildToolDescription([agentConfig()]);

		expect(description).toContain("system_prompt");
		expect(description).toMatch(/never ask the user/i);
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
	// The specification's scenario, quoted: the call fails with a message
	// listing the known types, and no subagent starts.
	it("Refuses an unknown subagent type", async () => {
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

	/**
	 * Naming a type in a project that has no agent files is still a refusal —
	 * what changed is that the refusal points at the other route rather than
	 * listing an empty set of known types.
	 */
	it("refuses clearly when no agents are defined at all", async () => {
		const { tool, run } = harness({ agents: [] });

		await expect(
			tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx),
		).rejects.toThrow(/no agent files/i);

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

describe("spawn_subagent turn limit", () => {
	it("lets the caller's turn limit win over the agent file's", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ maxTurns: 4 })],
			hang: true,
		});

		await tool.execute(
			"call-1",
			{ ...VALID_ARGS, max_turns: 9 },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].config.maxTurns).toBe(9);
	});

	it("uses the agent file's limit when the caller names none", async () => {
		const { tool, run } = harness({
			agents: [agentConfig({ maxTurns: 4 })],
			hang: true,
		});

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(run.mock.calls[0]?.[0].config.maxTurns).toBe(4);
	});

	/**
	 * Neither the caller nor the agent file naming a limit leaves the config's
	 * own field unset — the default is applied further in, when the run's turn
	 * watcher is built, so nothing here invents a limit the caller did not ask
	 * for. `spawn.test.ts` covers the default actually biting.
	 */
	it("names no limit on the config when neither names one", async () => {
		const { tool, run } = harness({ hang: true });

		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		expect(run.mock.calls[0]?.[0].config.maxTurns).toBeUndefined();
	});

	it("leaves the turn limit optional in the schema", () => {
		const { tool } = harness();
		const schema = tool.parameters as {
			required?: string[];
			properties: Record<string, unknown>;
		};

		expect(schema.properties.max_turns).toBeDefined();
		expect(schema.required ?? []).not.toContain("max_turns");
	});
});

describe("spawn_subagent under a concurrency limit", () => {
	it("queues a spawn when every slot is taken, and says so", async () => {
		const { tool, run, registry } = harness({ limit: 1, hang: true });
		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		const result = await tool.execute(
			"call-2",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toMatch(/queued/i);
		expect(registry.get("sub-2")?.status).toBe("queued");
		// The first is still the only one actually running.
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports the id of a queued subagent, same as a started one", async () => {
		const { tool } = harness({ limit: 1, hang: true });
		await tool.execute("call-1", VALID_ARGS, undefined, undefined, ctx);

		const result = await tool.execute(
			"call-2",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("sub-2");
		expect((result.details as { id: string }).id).toBe("sub-2");
	});

	it("does not call a subagent queued when it started at once", async () => {
		const { tool } = harness({ hang: true });

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).not.toMatch(/queued/i);
		expect(resultText(result)).toMatch(/started/i);
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

describe("spawn_subagent with a supplied character", () => {
	/** A persona the caller composed, rather than a type it looked up. */
	const INLINE_ARGS = {
		name: "security",
		system_prompt: "You are a security reviewer.",
		prompt: "check the auth path",
		description: "security review",
	};

	// The specification's scenario, quoted.
	it("Runs from the supplied character", async () => {
		// The harness offers "reviewer" and nothing else, so a run under the
		// supplied prompt is a run no agent file took part in.
		const { tool, run } = harness();

		await tool.execute("call-1", INLINE_ARGS, undefined, undefined, ctx);

		const config = run.mock.calls[0]?.[0].config;
		expect(config.systemPrompt).toBe("You are a security reviewer.");
		expect(config.name).toBe("security");
		expect(config.source).toBe("inline");
		expect(config.filePath).toBeUndefined();
	});

	// The specification's scenario, quoted.
	it("Needs no agent file of that name", async () => {
		const { tool, run, registry } = harness({
			agents: [agentConfig({ name: "reviewer" })],
		});

		await tool.execute(
			"call-1",
			{ ...INLINE_ARGS, name: "performance-analyst" },
			undefined,
			undefined,
			ctx,
		);

		expect(run).toHaveBeenCalledOnce();
		expect(registry.get("sub-1")?.handle).toBe("performance-analyst");
	});

	// The specification's scenario, quoted.
	it("Limits it to the tools named", async () => {
		const { tool, run } = harness({ knownTools: ["read", "grep", "bash"] });

		await tool.execute(
			"call-1",
			{ ...INLINE_ARGS, tools: ["read", "grep"] },
			undefined,
			undefined,
			ctx,
		);

		expect(run.mock.calls[0]?.[0].config.tools).toEqual(["read", "grep"]);
	});

	// The specification's scenario, quoted.
	it("Takes the supplied name as its handle", async () => {
		const { tool, registry } = harness();

		await tool.execute("call-1", INLINE_ARGS, undefined, undefined, ctx);

		expect(registry.get("sub-1")?.handle).toBe("security");
	});

	/**
	 * The specification's scenario, quoted. Ugly on purpose: refusing would send
	 * the caller back to the user for a name, which is the thing being avoided.
	 */
	it("Falls back to the description when no name is supplied", async () => {
		const { tool, run, registry } = harness();
		const { name: _unnamed, ...withoutName } = INLINE_ARGS;

		await tool.execute("call-1", withoutName, undefined, undefined, ctx);

		expect(run).toHaveBeenCalledOnce();
		expect(registry.get("sub-1")?.handle).toBe("security-review");
	});

	// The specification's scenario, quoted.
	it("Distinguishes subagents given the same name", async () => {
		const { tool, registry } = harness({ hang: true });

		for (let n = 1; n <= 5; n++) {
			await tool.execute(`call-${n}`, INLINE_ARGS, undefined, undefined, ctx);
		}

		const handles = registry.list().map((record) => record.handle);
		expect(handles).toHaveLength(5);
		expect(new Set(handles).size).toBe(5);
		expect(handles[0]).toBe("security");
	});

	// The specification's scenario, quoted.
	it("Runs the supplied character under a name an agent file already uses", async () => {
		const { tool, run, registry } = harness({
			agents: [agentConfig({ name: "security" })],
		});

		const result = await tool.execute(
			"call-1",
			INLINE_ARGS,
			undefined,
			undefined,
			ctx,
		);

		// The supplied prompt, not the file's: `agentConfig` gives the file
		// "You review code.", so either one being wrong fails this.
		const config = run.mock.calls[0]?.[0].config;
		expect(config.systemPrompt).toBe("You are a security reviewer.");
		expect(config.source).toBe("inline");
		expect(registry.get("sub-1")?.handle).toBe("security");
		// And said so, rather than letting the file be passed over in silence.
		expect(resultText(result)).toMatch(/agent file/i);
	});

	// The specification's scenario, quoted.
	it("Says nothing about agent files when no name is shadowed", async () => {
		const { tool } = harness({ agents: [agentConfig({ name: "reviewer" })] });

		const result = await tool.execute(
			"call-1",
			INLINE_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).not.toMatch(/agent file/i);
	});

	/**
	 * The other half of that, and the one the guard is for: a subagent started
	 * from an agent file is named after the file it came from, so a check that
	 * looked only at the name would tell every file-backed subagent it was
	 * shadowing itself.
	 */
	it("says nothing about agent files when the subagent came from one", async () => {
		const { tool } = harness({ agents: [agentConfig({ name: "reviewer" })] });

		const result = await tool.execute(
			"call-1",
			VALID_ARGS,
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).not.toMatch(/agent file/i);
	});

	// The specification's scenario, quoted.
	it("Prefers the supplied character to the type named alongside it", async () => {
		const { tool, run, registry } = harness({
			agents: [agentConfig({ name: "reviewer" })],
		});
		const { name: _unnamed, ...withoutName } = INLINE_ARGS;

		await tool.execute(
			"call-1",
			{ ...withoutName, subagent_type: "reviewer" },
			undefined,
			undefined,
			ctx,
		);

		const config = run.mock.calls[0]?.[0].config;
		expect(config.systemPrompt).toBe("You are a security reviewer.");
		expect(config.source).toBe("inline");
		// The type stands in for the name it was given instead of, so the handle
		// is the short word rather than one slugged from the description.
		expect(registry.get("sub-1")?.handle).toBe("reviewer");
	});

	it("takes an explicit name over the type when both are given", async () => {
		const { tool, registry } = harness({
			agents: [agentConfig({ name: "reviewer" })],
		});

		await tool.execute(
			"call-1",
			{ ...INLINE_ARGS, subagent_type: "reviewer" },
			undefined,
			undefined,
			ctx,
		);

		expect(registry.get("sub-1")?.handle).toBe("security");
	});

	it("refuses a call that neither names a type nor supplies a character", async () => {
		const { tool, run } = harness();

		await expect(
			tool.execute(
				"call-1",
				{ prompt: "check the auth path", description: "security review" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/subagent_type|system_prompt/);

		expect(run).not.toHaveBeenCalled();
	});

	// The specification's scenario, quoted.
	it("Gives it a colour from the palette", async () => {
		const { tool, registry } = harness();

		await tool.execute("call-1", INLINE_ARGS, undefined, undefined, ctx);

		expect(PALETTE).toContain(registry.get("sub-1")?.color);
	});

	// The specification's scenario, quoted.
	it("Refuses to start a subagent from inside a subagent", async () => {
		const { tool, run } = harness();

		await runInChildContext(async () => {
			await expect(
				tool.execute("call-1", INLINE_ARGS, undefined, undefined, ctx),
			).rejects.toThrow(/subagent/i);
		});

		expect(run).not.toHaveBeenCalled();
	});

	/**
	 * The case that makes the old refusal wrong. A project with no agent files
	 * could not delegate at all; supplying a character is now how it does.
	 */
	it("works in a project with no agent files at all", async () => {
		const { tool, run, registry } = harness({ agents: [] });

		await tool.execute("call-1", INLINE_ARGS, undefined, undefined, ctx);

		expect(run).toHaveBeenCalledOnce();
		expect(registry.get("sub-1")?.handle).toBe("security");
	});
});

describe("list_subagents", () => {
	/**
	 * Records built directly rather than spawned: this tool reads the registry
	 * and nothing else, so a test that has to start subagents to describe a
	 * status would be testing the spawn path over again.
	 */
	function withRecords(
		...records: Array<Partial<SubagentRecord> & { id: string }>
	) {
		const registry = new SubagentRegistry();
		for (const [index, changes] of records.entries()) {
			registry.add({
				handle: `agent-${index + 1}`,
				type: "reviewer",
				config: agentConfig(),
				description: "review agents file",
				status: "running",
				color: "cyan",
				startedAt: 1_000 + index,
				contextPercent: null,
				turns: 0,
				...changes,
			});
		}
		return { tool: createListTool({ registry }), registry };
	}

	// The specification's scenario, quoted.
	it("Lists every subagent and its state", async () => {
		const { tool } = withRecords(
			{ id: "sub-1", handle: "behaviour", description: "behaviour review" },
			{ id: "sub-2", handle: "security", description: "security review" },
			{ id: "sub-3", handle: "reliability", description: "reliability review" },
			{ id: "sub-4", handle: "maintain", description: "maintainability" },
		);

		const text = resultText(
			await tool.execute("call-1", {}, undefined, undefined, ctx),
		);

		// Each entry gives its handle, its identifier, its status, and its
		// description — all four, for all four subagents.
		for (const handle of ["behaviour", "security", "reliability", "maintain"]) {
			expect(text).toContain(handle);
		}
		for (const id of ["sub-1", "sub-2", "sub-3", "sub-4"]) {
			expect(text).toContain(id);
		}
		expect(text).toContain("security review");
		expect(text).toContain("running");
	});

	// The specification's scenario outline, quoted: every state is listed.
	it.each(["queued", "running", "completed", "failed", "stopped"] as const)(
		"Includes subagents in every state: %s",
		async (status) => {
			const { tool } = withRecords({ id: "sub-1", status });

			const text = resultText(
				await tool.execute("call-1", {}, undefined, undefined, ctx),
			);

			expect(text).toContain(status);
			expect(text).toContain("sub-1");
		},
	);

	/**
	 * The specification's scenario, quoted. An empty string would read to the
	 * caller as a call that failed rather than a session with nothing in it.
	 */
	it("Reports a session with no subagents", async () => {
		const { tool } = withRecords();

		const text = resultText(
			await tool.execute("call-1", {}, undefined, undefined, ctx),
		);

		expect(text).toMatch(/no subagents/i);
	});

	// The specification's scenario, quoted.
	it("Changes nothing", async () => {
		const { tool, registry } = withRecords(
			{ id: "sub-1" },
			{ id: "sub-2" },
			{ id: "sub-3" },
		);
		const before = registry.list().map((record) => ({ ...record }));

		await tool.execute("call-1", {}, undefined, undefined, ctx);

		expect(registry.list()).toEqual(before);
		expect(registry.running()).toHaveLength(3);
	});

	/**
	 * The reason this tool exists: one call in place of one call per sibling.
	 * A caller that has to know an id to learn anything is back where it started.
	 */
	it("needs no arguments to answer", async () => {
		const { tool } = withRecords({ id: "sub-1" });

		expect(Object.keys(tool.parameters.properties ?? {})).toEqual([]);
	});
});

describe("configuredLimit", () => {
	/** A throwaway project and agent directory pair. */
	function dirs() {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		return { root, cwd, agentDir };
	}

	function writeSettings(dir: string, settings: unknown) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}

	it("runs five at a time when nothing is configured", () => {
		const { cwd, agentDir } = dirs();

		expect(configuredLimit(cwd, agentDir)).toBe(DEFAULT_CONCURRENCY);
	});

	// The whole point of Task 4.2: the number comes out of pi's settings.json.
	it("reads the limit out of the global settings file", () => {
		const { cwd, agentDir } = dirs();
		writeSettings(agentDir, { theme: "dark", subagents: { limit: 2 } });

		expect(configuredLimit(cwd, agentDir)).toBe(2);
	});

	it("lets a project's settings file win", () => {
		const { cwd, agentDir } = dirs();
		writeSettings(agentDir, { subagents: { limit: 2 } });
		writeSettings(join(cwd, ".pi"), { subagents: { limit: 7 } });

		expect(configuredLimit(cwd, agentDir)).toBe(7);
	});

	// Pi's own loader swallows a parse error and reports empty settings, so
	// this is about the limit rather than about not throwing.
	it("falls back to the default on an unreadable settings file", () => {
		const { cwd, agentDir } = dirs();
		writeFileSync(join(agentDir, "settings.json"), "{ not json at all");

		expect(configuredLimit(cwd, agentDir)).toBe(DEFAULT_CONCURRENCY);
	});

	/**
	 * Pins an assumption rather than our own code: pi reports a settings file it
	 * cannot read as empty settings instead of throwing, which is why nothing
	 * here guards against it. If that ever changes, loading the extension starts
	 * throwing and this test says so first.
	 */
	it("survives an agent directory that is not a directory", () => {
		const { root, cwd } = dirs();
		const notADirectory = join(root, "a-file");
		writeFileSync(notADirectory, "");

		expect(configuredLimit(cwd, notADirectory)).toBe(DEFAULT_CONCURRENCY);
	});
});
