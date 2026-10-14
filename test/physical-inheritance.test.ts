import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import {
	createInlineSpawnTool,
	createMentionHandler,
	createNamedSpawnTool,
} from "../src/index.ts";
import { SubagentQueue } from "../src/queue.ts";
import { SubagentRegistry } from "../src/registry.ts";
import { runSubagent } from "../src/runner.ts";
import { resumeSubagent, type SendMessage } from "../src/spawn.ts";
import { toolContext } from "./tool-context.ts";

const physical = (id: string, api = "test"): Model<Api> =>
	({ provider: "mixed", id, name: id, api }) as Model<Api>;
const A = physical("physical-A");
const B = physical("physical-B");
const C = physical("override-C");
const V = physical("route", "pi-virtual");
const config: AgentConfig = {
	name: "explore",
	description: "Explore",
	systemPrompt: "Inspect only.",
	source: "project",
	filePath: "/unused/explore.md",
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function reply(
	model = A,
	thinkingLevel: string | undefined = "xhigh",
	stopReason = "stop",
) {
	return {
		type: "message",
		message: {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			thinkingLevel,
			stopReason,
		},
	};
}

function harness(
	options: {
		branch?: unknown[];
		selected?: Model<Api>;
		catalog?: Model<Api>[];
		scoped?: Model<Api>[];
		available?: Model<Api>[];
		pick?: string;
		limit?: number;
		fail?: string;
		definition?: Partial<AgentConfig>;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-physical-"));
	dirs.push(dir);
	const catalog = options.catalog ?? [A, B, C, V];
	const notices: string[] = [];
	const select = vi.fn(
		async (_title: string, _options: string[]) => options.pick,
	);
	const ctx = toolContext({
		cwd: dir,
		model: options.selected ?? V,
		thinkingLevel: "low",
		scopedModels: (options.scoped ?? []).map((model) => ({ model })),
		modelRegistry: {
			getAll: () => catalog,
			getAvailable: () => options.available ?? catalog,
			find: (provider: string, id: string) =>
				catalog.find((m) => m.provider === provider && m.id === id),
		},
		sessionManager: {
			getSessionFile: () => undefined,
			getBranch: () => options.branch ?? [reply()],
		},
		hasUI: true,
		ui: { select, notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionContext);
	const registry = new SubagentRegistry();
	const queue = new SubagentQueue(options.limit ?? 1);
	const calls: CreateAgentSessionOptions[] = [];
	const run = vi.fn((opts: Parameters<typeof runSubagent>[0]) =>
		runSubagent({
			...opts,
			sessionDir: dir,
			createSession: async (settings) => {
				calls.push(settings);
				if (settings.model?.id === options.fail)
					throw new Error("synthetic provider failure");
				return {
					session: {
						model: settings.model,
						thinkingLevel: settings.thinkingLevel,
						messages: [
							{
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "done" }],
							},
						],
						prompt: async () => {},
						dispose: () => {},
						abort: async () => {},
						subscribe: () => () => {},
						getContextUsage: () => undefined,
					},
				} as unknown as CreateAgentSessionResult;
			},
		}),
	);
	const deps = {
		discover: () => [{ ...config, ...options.definition }],
		getKnownTools: () => ["read"],
		registry,
		queue,
		run,
		sendMessage: vi.fn() as SendMessage,
	};
	const inline = createInlineSpawnTool(deps);
	const named = createNamedSpawnTool(deps);
	const mention = createMentionHandler(deps);
	const spawn = (extra: Record<string, unknown> = {}) =>
		inline.execute(
			"call",
			{
				name: "inline",
				system_prompt: "Inspect.",
				prompt: "Inspect.",
				description: "Inspect",
				...extra,
			},
			undefined,
			undefined,
			ctx,
		);
	const finish = async () => {
		await vi.waitFor(() =>
			expect(
				registry
					.list()
					.every((r) => r.status === "completed" || r.status === "failed"),
			).toBe(true),
		);
	};
	return {
		ctx,
		registry,
		queue,
		calls,
		run,
		deps,
		spawn,
		named,
		mention,
		finish,
		notices,
		select,
	};
}
const text = (result: { content: Array<{ type: string }> }) =>
	JSON.stringify(result.content);
const pair = (call: CreateAgentSessionOptions | undefined) => [
	call?.model?.id,
	call?.thinkingLevel,
];

describe("physical inheritance through public subagent callers", () => {
	it.each(["inline", "named", "mention"])(
		"resolves synthetic virtual %s startup from successful branch metadata",
		async (kind) => {
			const h = harness();
			if (kind === "inline") await h.spawn();
			else if (kind === "named")
				await h.named.execute(
					"call",
					{
						subagent_type: "explore",
						prompt: "Inspect",
						description: "Inspect",
					},
					undefined,
					undefined,
					h.ctx,
				);
			else
				await h.mention(
					{ type: "input", text: "@explore Inspect", source: "interactive" },
					h.ctx,
				);
			await h.finish();
			expect(h.calls).toHaveLength(1);
			expect(pair(h.calls[0])).toEqual([A.id, "xhigh"]);
			expect(h.registry.list()[0]).toMatchObject({
				model: A.id,
				thinkingLevel: "xhigh",
			});
			expect(h.ctx.model).toBe(V);
			expect(h.ctx.thinkingLevel).toBe("low");
		},
	);

	it("uses a selected physical pair instead of older response metadata", async () => {
		const h = harness({ selected: B });
		await h.spawn();
		await h.finish();
		expect(pair(h.calls[0])).toEqual([B.id, "low"]);
	});

	it("ignores failed, aborted and opaque router-state entries", async () => {
		const h = harness({
			branch: [
				reply(),
				reply(B, "high", "error"),
				reply(B, "medium", "aborted"),
				{
					type: "custom",
					customType: "pi.virtual-model-state",
					data: { physicalModel: B, thinkingLevel: "low" },
				},
			],
		});
		await h.spawn();
		await h.finish();
		expect(pair(h.calls[0])).toEqual([A.id, "xhigh"]);
	});

	it.each(
		[
			[],
			[reply(B, "high", "error")],
			[reply(B, "high", "aborted")],
			[reply(V)],
			[reply(physical("deleted"))],
			[reply(), reply(physical("deleted"))],
		].map((branch) => ({ branch })),
	)(
		"refuses unknown physical inheritance before accepting a record (%j)",
		async ({ branch }) => {
			const h = harness({ branch });
			const result = await h.spawn({ thinking: "high" });
			expect(text(result)).toMatch(/explicit physical model/i);
			expect(h.registry.list()).toHaveLength(0);
			expect(h.run).not.toHaveBeenCalled();
		},
	);

	it("does not use absent selection as an SDK default-model escape", async () => {
		const h = harness();
		h.ctx.model = undefined;
		const result = await h.spawn();
		expect(text(result)).toMatch(/explicit physical model/i);
		expect(h.calls).toHaveLength(0);
		expect(h.registry.list()).toHaveLength(0);
	});

	it.each([undefined, "off", "high"])(
		"preserves independent explicit effort %s with an unknown virtual main pair",
		async (thinking) => {
			const h = harness({ branch: [] });
			await h.spawn({
				model: "mixed/override-C",
				thinking,
				allow_model_fallback: false,
			});
			await h.finish();
			expect(pair(h.calls[0])).toEqual([C.id, thinking]);
		},
	);

	it("inherits response effort independently of an explicit physical model", async () => {
		const h = harness();
		await h.spawn({ model: "override-C" });
		await h.finish();
		expect(pair(h.calls[0])).toEqual([C.id, "xhigh"]);
	});

	it("does not borrow virtual effort when the successful message has none", async () => {
		const h = harness({
			branch: [
				{
					...reply(),
					message: { ...reply().message, thinkingLevel: undefined },
				},
			],
		});
		await h.spawn();
		await h.finish();
		expect(pair(h.calls[0])).toEqual([A.id, undefined]);
	});

	it.each(["scope", "available", "catalog"])(
		"filters mixed-provider virtual candidates without widening %s precedence",
		async (tier) => {
			const h = harness({
				scoped: tier === "scope" ? [V] : [],
				available: tier === "available" ? [V] : [],
				catalog: tier === "catalog" ? [V] : [A, V],
			});
			const result = await h.spawn({
				model: "route",
				allow_model_fallback: false,
			});
			expect(text(result)).toMatch(/not available|physical model/i);
			expect(h.registry.list()).toHaveLength(0);
			expect(h.select).not.toHaveBeenCalled();
		},
	);

	it("refuses an explicit virtual target even when ordinary fallback is enabled", async () => {
		const h = harness();
		const result = await h.spawn({ model: "mixed/route" });
		expect(text(result)).toMatch(/explicit physical model/i);
		expect(h.registry.list()).toHaveLength(0);
		expect(h.run).not.toHaveBeenCalled();
	});

	it.each(["branch", "lookup"])(
		"unknown native evidence without public %s access never defaults a model",
		async (absent) => {
			const h = harness();
			if (absent === "branch")
				h.ctx.sessionManager.getBranch = undefined as never;
			else h.ctx.modelRegistry.find = undefined as never;
			const result = await h.spawn();
			expect(text(result)).toMatch(/explicit physical model/i);
			expect(h.run).not.toHaveBeenCalled();
		},
	);

	it.each(["inline", "named"])(
		"lets the scoped physical bare ID win over another provider's virtual ID (%s)",
		async (kind) => {
			const unrelated = { ...V, provider: "unrelated-router", id: C.id };
			const h = harness({
				catalog: [A, C, V, unrelated],
				scoped: [C],
				definition: {
					model: C.id,
					thinking: "high",
					allowModelFallback: false,
				},
			});
			const result =
				kind === "inline"
					? await h.spawn({
							model: C.id,
							thinking: "high",
							allow_model_fallback: false,
						})
					: await h.named.execute(
							"call",
							{
								subagent_type: "explore",
								prompt: "Inspect",
								description: "Inspect",
							},
							undefined,
							undefined,
							h.ctx,
						);
			expect(text(result)).not.toContain("Refusal:");
			await h.finish();
			expect(h.calls.map(pair)).toEqual([[C.id, "high"]]);
			expect(h.calls[0]?.model?.provider).toBe(C.provider);
			expect(h.registry.list()).toHaveLength(1);
			expect(h.select).not.toHaveBeenCalled();
			expect(h.ctx.model).toBe(V);
			expect(h.ctx.thinkingLevel).toBe("low");
		},
	);

	it("refuses a qualified virtual target before fuzzy physical matching", async () => {
		const unrelated = { ...V, provider: "unrelated-router", id: C.id };
		const prefix = {
			...C,
			id: `${C.id}-backend`,
			name: `unrelated-router/${C.id} backend`,
		};
		const h = harness({ catalog: [A, prefix, V, unrelated], scoped: [prefix] });
		const result = await h.spawn({ model: `unrelated-router/${C.id}` });
		expect(text(result)).toMatch(/explicit physical model.*virtual model/i);
		expect(h.calls).toHaveLength(0);
		expect(h.registry.list()).toHaveLength(0);
		expect(h.select).not.toHaveBeenCalled();
	});

	it("refuses a bare virtual-only ID instead of falling back to known physical inheritance", async () => {
		const unrelated = { ...V, provider: "unrelated-router", id: C.id };
		const h = harness({ catalog: [A, V, unrelated], scoped: [A] });
		const result = await h.spawn({ model: C.id });
		expect(text(result)).toMatch(/explicit physical model.*virtual model/i);
		expect(h.calls).toHaveLength(0);
		expect(h.registry.list()).toHaveLength(0);
	});

	it("uses only physical options for an ambiguous dialog", async () => {
		const h = harness({ catalog: [A, B, V], pick: "mixed/physical-B" });
		await h.spawn({ model: "physical" });
		await h.finish();
		expect(h.select.mock.calls[0]?.[1]).toEqual([
			"mixed/physical-A",
			"mixed/physical-B",
		]);
		expect(pair(h.calls[0])).toEqual([B.id, "xhigh"]);
	});

	it.each(["unknown", "dismissed"])(
		"startup %s fallback names and uses the physical pair",
		async (mode) => {
			const h = harness();
			const result = await h.spawn({
				model: mode === "unknown" ? "missing" : "physical",
			});
			await h.finish();
			expect(pair(h.calls[0])).toEqual([A.id, "xhigh"]);
			expect(text(result)).toContain("mixed/physical-A");
			expect(text(result)).not.toContain("mixed/route");
		},
	);

	it.each([undefined, "off"])(
		"runtime fallback retries the captured physical pair with effort %s",
		async (thinking) => {
			const h = harness({ fail: C.id });
			await h.spawn({ model: C.id, thinking });
			await h.finish();
			expect(h.calls.map(pair)).toEqual([
				[C.id, thinking ?? "xhigh"],
				[A.id, thinking ?? "xhigh"],
			]);
			expect(h.registry.list()[0]).toMatchObject({
				model: A.id,
				thinkingLevel: thinking ?? "xhigh",
			});
			expect(h.registry.list()[0]?.outcome?.output).toContain(
				"Fell back to mixed/physical-A",
			);
		},
	);

	it("strict missing-model provenance cannot be satisfied by captured inheritance", async () => {
		const h = harness();
		const result = await h.spawn({ allow_model_fallback: false });
		expect(text(result)).toMatch(/explicit model.*fallback is disabled/i);
		expect(h.registry.list()).toHaveLength(0);
	});

	it("unknown fallback retains the original failure without retrying the virtual selection", async () => {
		const h = harness({ branch: [], fail: C.id });
		await h.spawn({ model: C.id });
		await h.finish();
		expect(h.calls.map(pair)).toEqual([[C.id, undefined]]);
		expect(h.registry.list()[0]?.outcome?.error).toMatch(
			/synthetic provider failure[\s\S]*explicit physical model/i,
		);
	});

	it.each(["physical", "virtual"])(
		"freezes the accepted %s pair while queued, for startup and resume",
		async (selected) => {
			const h = harness({ selected: selected === "physical" ? A : V });
			let release!: () => void;
			h.queue.submit(
				"block",
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			await h.spawn();
			const record = h.registry.list()[0];
			expect(record).toMatchObject({
				status: "queued",
				model: A.id,
				thinkingLevel: selected === "physical" ? "low" : "xhigh",
			});
			h.ctx.model = B;
			h.ctx.thinkingLevel = "high";
			release();
			await h.finish();
			expect(pair(h.calls[0])).toEqual([
				A.id,
				selected === "physical" ? "low" : "xhigh",
			]);
			if (!record) throw new Error("missing accepted record");
			h.queue.submit(
				"block-2",
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			const result = resumeSubagent({
				...h.deps,
				ctx: h.ctx,
				config: record.config,
				record,
				prompt: "continue",
			});
			expect(result).toMatchObject({ ok: true, startedFresh: true });
			h.ctx.model = A;
			h.ctx.thinkingLevel = "off";
			release();
			await h.finish();
			expect(pair(h.calls[1])).toEqual([B.id, "high"]);
			expect(record).toMatchObject({ model: B.id, thinkingLevel: "high" });
		},
	);

	it("defends the direct runner boundary before loader or session work", async () => {
		const h = harness({ branch: [] });
		const createSession = vi.fn();
		const result = await runSubagent({
			ctx: h.ctx,
			config,
			prompt: "inspect",
			createSession,
		});
		expect(result).toMatchObject({ status: "failed" });
		expect(result.error).toMatch(/explicit physical model/i);
		expect(createSession).not.toHaveBeenCalled();
	});
});
