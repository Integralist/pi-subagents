/** Offline public SDK sessions: default transport and injected seams are separate. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createInlineSpawnTool,
	createMentionHandler,
	createNamedSpawnTool,
} from "../src/index.ts";
import { SubagentQueue } from "../src/queue.ts";
import { SubagentRegistry } from "../src/registry.ts";
import { inChildContext, runSubagent } from "../src/runner.ts";

const cleanups = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const config = {
	name: "explore",
	description: "Inspect",
	source: "project",
	filePath: "/unused/explore.md",
	systemPrompt: "Inspect only.",
	tools: ["read"],
};
const inlineArgs = {
	name: "inline",
	system_prompt: "Inspect only.",
	prompt: "Inspect",
	description: "Inspect",
};
const pair = (options) => [options.model?.id, options.thinkingLevel];

async function fixture({
	known = true,
	fail = false,
	definition = {},
	seed,
	physical = false,
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-native-subagents-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const makeRuntime = async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		// Never consult ambient credentials or transports when checking availability.
		for (const provider of runtime.getProviders())
			runtime.registerNativeProvider({
				...provider,
				auth: {
					apiKey: { name: "Offline only", resolve: async () => undefined },
				},
				getModels: () => [],
				getAllModels: () => [],
				refreshModels: undefined,
			});
		const fake = fauxProvider({
			provider: "synthetic-physical",
			models: [
				{ id: "physical-A", reasoning: true },
				{ id: "physical-B", reasoning: true },
				{ id: "override-C", reasoning: true },
				{ id: "no-thinking", reasoning: false },
			],
			tokensPerSecond: 1_000_000,
		});
		for (const model of fake.models)
			if (model.reasoning)
				model.thinkingLevelMap = {
					off: "off",
					low: "low",
					high: "high",
					xhigh: "xhigh",
					medium: "medium",
				};
		runtime.registerNativeProvider(fake.provider);
		await runtime.refresh({ allowNetwork: false });
		return { runtime, fake };
	};
	const main = await makeRuntime();
	const child = await makeRuntime();
	const model = (id) => main.runtime.getModel("synthetic-physical", id);
	let routes = 0;
	main.runtime.registerVirtualModel({
		provider: "synthetic-physical",
		id: "route",
		name: "Synthetic router, not Auto",
		thinkingLevels: ["low", "high"],
		route: () => {
			routes++;
			return {
				model: model("physical-A"),
				thinkingLevel: "xhigh",
				state: { arbitrary: { phase: 42 } },
			};
		},
	});
	const manager = SessionManager.inMemory(dir);
	const message = (id, level = "xhigh", stopReason = "stop") => ({
		...fauxAssistantMessage("seed", { stopReason }),
		provider: "synthetic-physical",
		api: main.fake.api,
		model: id,
		thinkingLevel: level,
	});
	if (seed) seed(manager, message);
	else if (known) manager.appendMessage(message("physical-A"));
	const registry = new SubagentRegistry();
	const queue = new SubagentQueue(1);
	const attempts = [];
	const childSessions = [];
	const dispatches = [];
	child.fake.setResponses(
		Array(30).fill((_context, options, _state, selected) => {
			dispatches.push([selected.id, options?.reasoning]);
			return fauxAssistantMessage("faux subagent", {
				stopReason: fail && selected.id === "override-C" ? "error" : "stop",
				...(fail && selected.id === "override-C"
					? { errorMessage: "native synthetic failure" }
					: {}),
			});
		}),
	);
	const run = (opts) =>
		runSubagent({
			...opts,
			sessionDir: dir,
			createSession: async (options) => {
				expect(inChildContext()).toBe(true);
				attempts.push(options);
				expect(options.model?.api).not.toBe("pi-virtual");
				expect(options.model).toBeDefined();
				const loaded = options.resourceLoader.getExtensions();
				expect(loaded.errors).toEqual([]);
				expect(loaded.extensions).toEqual([]);
				expect(
					child.runtime.getModels().some((m) => m.api === "pi-virtual"),
				).toBe(false);
				const result = await createAgentSession({
					...options,
					modelRuntime: child.runtime,
					settingsManager: SettingsManager.inMemory({
						compaction: { enabled: false },
						retry: { enabled: false },
						cacheWarming: "off",
					}),
				});
				childSessions.push(result.session);
				expect(result.session.getActiveToolNames()).toEqual(options.tools);
				expect(result.session.getActiveToolNames()).not.toContain(
					"spawn_inline_subagent",
				);
				return result;
			},
		});
	const notices = [];
	const deps = {
		discover: () => [{ ...config, ...definition }],
		run,
		registry,
		queue,
		getKnownTools: () => ["read"],
		sendMessage: () => {},
	};
	let ctx;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			(pi) => {
				pi.registerTool(createInlineSpawnTool(deps));
				pi.registerTool(createNamedSpawnTool(deps));
				pi.on("input", createMentionHandler(deps));
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
	});
	await loader.reload();
	const { session: parent } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: main.runtime,
		model: model(physical ? "physical-B" : "route"),
		thinkingLevel: "low",
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
		tools: ["spawn_inline_subagent", "spawn_named_subagent"],
	});
	cleanups.push(() => parent.dispose());
	await parent.bindExtensions({
		mode: "print",
		uiContext: { notify: (text) => notices.push(text) },
	});
	const toolCtx = Object.assign(Object.create(ctx), {
		tools: [],
		executeTool: async () => {
			throw new Error("No nested tools in direct-call fixture");
		},
	});
	const spawn = (extra) =>
		parent
			.getToolDefinition("spawn_inline_subagent")
			.execute(
				"call",
				{ ...inlineArgs, ...extra },
				undefined,
				undefined,
				toolCtx,
			);
	const finish = async () =>
		vi.waitFor(() =>
			expect(
				registry
					.list()
					.every((record) =>
						["completed", "failed", "stopped"].includes(record.status),
					),
			).toBe(true),
		);
	return {
		parent,
		manager,
		main,
		child,
		ctx,
		attempts,
		dispatches,
		childSessions,
		registry,
		queue,
		spawn,
		finish,
		model,
		notices,
		routes: () => routes,
	};
}

describe.skipIf(
	typeof ModelRuntime.prototype.registerVirtualModel !== "function",
)(
	"native public caller and extension-free session proof (injected createSession)",
	() => {
		it.each(["spawn_inline_subagent", "spawn_named_subagent"])(
			"%s runs through the native tool caller after a routed response",
			async (name) => {
				const h = await fixture({ known: false });
				h.main.fake.setResponses([
					fauxAssistantMessage(
						fauxToolCall(
							name,
							name === "spawn_inline_subagent"
								? inlineArgs
								: {
										subagent_type: "explore",
										prompt: "Inspect",
										description: "Inspect",
									},
						),
					),
					fauxAssistantMessage("main finished"),
				]);
				await h.parent.prompt("delegate");
				await h.finish();
				expect(h.attempts.map(pair)).toEqual([["physical-A", "xhigh"]]);
				expect(h.dispatches).toEqual([["physical-A", "xhigh"]]);
				expect(h.parent.model.id).toBe("route");
				expect(h.parent.thinkingLevel).toBe("low");
				expect(h.registry.list()[0]).toMatchObject({
					model: "physical-A",
					thinkingLevel: "xhigh",
					status: "completed",
				});
				expect(
					h.childSessions[0].messages.some(
						(m) => m.role === "assistant" && m.model === "physical-A",
					),
				).toBe(true);
			},
		);

		it("retains canonical restored context and only reads successful evidence on the active branch", async () => {
			const h = await fixture({
				seed: (manager, message) => {
					const active = manager.appendMessage(message("physical-A"));
					manager.appendMessage(message("physical-B", "high"));
					manager.branch(active);
					manager.appendMessage(message("physical-B", "high", "error"));
					manager.appendMessage(message("physical-B", "high", "aborted"));
					manager.appendCustomEntry("pi.virtual-model-state", {
						provider: "synthetic-physical",
						modelId: "route",
						state: { physicalModel: "physical-B", thinkingLevel: "low" },
					});
				},
			});
			expect(
				h.parent.messages.some(
					(m) => m.role === "assistant" && m.model === "physical-A",
				),
			).toBe(true);
			await h.spawn();
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([["physical-A", "xhigh"]]);
			expect(h.routes()).toBe(0);
		});

		it("selected physical settings win with no virtual extension or router installed in the subagent", async () => {
			const h = await fixture({ physical: true });
			await h.spawn();
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([["physical-B", "low"]]);
			expect(h.dispatches).toEqual([["physical-B", "low"]]);
			expect(h.routes()).toBe(0);
		});

		it.each([undefined, "off"])(
			"unknown virtual inheritance refuses but independent explicit settings succeed (%s)",
			async (thinking) => {
				const h = await fixture({ known: false });
				const refused = await h.spawn({ thinking });
				expect(JSON.stringify(refused.content)).toMatch(
					/explicit physical model/i,
				);
				expect(h.registry.list()).toHaveLength(0);
				expect(h.attempts).toHaveLength(0);
				await h.spawn({
					model: "synthetic-physical/override-C",
					thinking,
					allow_model_fallback: false,
				});
				await h.finish();
				expect(h.attempts.map(pair)).toEqual([["override-C", thinking]]);
				expect(h.registry.list()[0]).toMatchObject({
					model: "override-C",
					thinkingLevel: thinking ?? "medium",
					status: "completed",
				});
				expect(h.dispatches).toEqual([
					["override-C", thinking === "off" ? undefined : "medium"],
				]);
			},
		);

		it.each([true, false])(
			"runtime failure preserves strict fallback policy %s at the native provider boundary",
			async (allowed) => {
				const h = await fixture({ fail: true });
				await h.spawn({ model: "override-C", allow_model_fallback: allowed });
				await h.finish();
				expect(h.attempts.map(pair)).toEqual(
					allowed
						? [
								["override-C", "xhigh"],
								["physical-A", "xhigh"],
							]
						: [["override-C", "xhigh"]],
				);
				expect(h.dispatches).toEqual(
					allowed
						? [
								["override-C", "xhigh"],
								["physical-A", "xhigh"],
							]
						: [["override-C", "xhigh"]],
				);
				expect(h.registry.list()[0]).toMatchObject({
					model: allowed ? "physical-A" : "override-C",
					thinkingLevel: "xhigh",
					status: allowed ? "completed" : "failed",
				});
				if (allowed)
					expect(h.registry.list()[0].outcome.output).toContain(
						"Fell back to synthetic-physical/physical-A",
					);
				else
					expect(h.registry.list()[0].outcome.error).toContain(
						"native synthetic failure",
					);
			},
		);

		it("unknown physical fallback keeps the original native failure and does not dispatch a router", async () => {
			const h = await fixture({ known: false, fail: true });
			await h.spawn({ model: "override-C" });
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([["override-C", undefined]]);
			expect(h.registry.list()[0].outcome.error).toMatch(
				/native synthetic failure[\s\S]*explicit physical model/i,
			);
			expect(h.routes()).toBe(0);
		});

		it("records actual SDK effort clamping, not the requested override", async () => {
			const h = await fixture();
			await h.spawn({
				model: "no-thinking",
				thinking: "xhigh",
				allow_model_fallback: false,
			});
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([["no-thinking", "xhigh"]]);
			expect(h.registry.list()[0]).toMatchObject({
				model: "no-thinking",
				thinkingLevel: "off",
				status: "completed",
			});
			expect(h.dispatches).toEqual([["no-thinking", undefined]]);
		});

		it("freezes inherited startup, runtime fallback and mention resume before queued main-selection changes", async () => {
			const h = await fixture({ fail: true });
			let release;
			h.queue.submit(
				"block",
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			await h.spawn({ model: "override-C" });
			await h.parent.setModel(h.model("physical-B"), { persist: false });
			h.parent.setThinkingLevel("high", { persist: false });
			release();
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([
				["override-C", "xhigh"],
				["physical-A", "xhigh"],
			]);
			// Inline settings remain explicit on resume; the physical fallback is newly captured.
			const record = h.registry.list()[0];
			h.queue.submit(
				"block-2",
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			await h.parent.prompt(`@${record.handle} continue`);
			await h.parent.setModel(h.model("physical-A"), { persist: false });
			h.parent.setThinkingLevel("off", { persist: false });
			release();
			await h.finish();
			expect(h.attempts.slice(2).map(pair)).toEqual([
				["override-C", "high"],
				["physical-B", "high"],
			]);
			expect(record).toMatchObject({
				model: "physical-B",
				thinkingLevel: "high",
				status: "completed",
			});
			expect(
				h.childSessions
					.at(-1)
					.messages.filter((m) => m.role === "user")
					.map((m) =>
						typeof m.content === "string"
							? m.content
							: m.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join(""),
					),
			).toContain("continue");
			expect(h.parent.model.id).toBe("physical-A");
			expect(h.routes()).toBe(0);
		});

		it("mention startup uses the same physical pair without asking the router", async () => {
			const h = await fixture();
			await h.parent.prompt("@explore inspect");
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([["physical-A", "xhigh"]]);
			expect(h.routes()).toBe(0);
		});
		it("captures native virtual inheritance before both queued startup and mention resume", async () => {
			const h = await fixture();
			let release;
			h.queue.submit(
				"block",
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			await h.spawn();
			expect(h.registry.list()[0]).toMatchObject({
				status: "queued",
				model: "physical-A",
				thinkingLevel: "xhigh",
			});
			await h.parent.setModel(h.model("physical-B"), { persist: false });
			h.parent.setThinkingLevel("high", { persist: false });
			release();
			await h.finish();
			await h.parent.setModel(h.model("route"), { persist: false });
			h.parent.setThinkingLevel("low", { persist: false });
			h.queue.submit(
				"block-2",
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			await h.parent.prompt("@inline continue");
			await h.parent.setModel(h.model("physical-B"), { persist: false });
			h.parent.setThinkingLevel("off", { persist: false });
			release();
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([
				["physical-A", "xhigh"],
				["physical-A", "xhigh"],
			]);
			expect(h.registry.list()[0]).toMatchObject({
				model: "physical-A",
				thinkingLevel: "xhigh",
				status: "completed",
			});
			expect(h.parent.model.id).toBe("physical-B");
			expect(h.parent.thinkingLevel).toBe("off");
			expect(h.routes()).toBe(0);
		});

		it("preserves an effort-only override and refuses an explicit virtual model in a mixed provider", async () => {
			const h = await fixture();
			const refusal = await h.spawn({ model: "synthetic-physical/route" });
			expect(JSON.stringify(refusal.content)).toMatch(
				/explicit physical model/i,
			);
			expect(h.registry.list()).toHaveLength(0);
			await h.spawn({ thinking: "high" });
			await h.finish();
			expect(h.attempts.map(pair)).toEqual([["physical-A", "high"]]);
			expect(h.dispatches).toEqual([["physical-A", "high"]]);
		});
	},
);

/** A real parent extension registers the only usable transport and owns its auth. */
async function defaultFixture({
	virtual = false,
	known = true,
	oauth = false,
	fail = false,
	modelHeaders = false,
	headerOnly = false,
	unconfigured = false,
	authFailure = false,
	collision = false,
	scoped = false,
} = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-default-subagents-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	cleanups.push(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	});
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
	);
	const credentials = new InMemoryCredentialStore();
	const providerId = "parent-extension-only";
	await credentials.modify(providerId, async () =>
		oauth
			? {
					type: "oauth",
					access: "parent-token",
					refresh: "unused",
					expires: Date.now() + 3_600_000,
				}
			: {
					type: "api_key",
					key: "parent-token",
					env: { MODEL_TENANT: "tenant-1" },
				},
	);
	if (modelHeaders)
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					[providerId]: {
						headers: { "X-Provider": "configured" },
						modelOverrides: Object.fromEntries(
							["physical-A", "physical-B", "override-C"].map((id) => [
								id,
								{
									headers: {
										Authorization: `Bearer model-${id}`,
										"X-Model-Tenant": authFailure
											? "$PI_SUBAGENTS_MISSING_TEST_VAR"
											: unconfigured
												? "header-only-tenant"
												: "$MODEL_TENANT",
									},
								},
							]),
						),
					},
				},
			}),
		);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryModelsStore(),
		modelsPath: modelHeaders ? join(dir, "models.json") : null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	for (const provider of runtime.getProviders())
		runtime.registerNativeProvider({
			id: provider.id,
			name: provider.name,
			auth: { apiKey: { name: "Offline", resolve: async () => undefined } },
			getModels: () => [],
			getAllModels: () => [],
			stream: () => {
				throw new Error("No ambient transport allowed");
			},
			streamSimple: () => {
				throw new Error("No ambient transport allowed");
			},
		});
	const fake = fauxProvider({
		provider: providerId,
		tokensPerSecond: 1_000_000,
		models: [
			{ id: "physical-A", reasoning: true },
			{ id: "physical-B", reasoning: true },
			{ id: "override-C", reasoning: true },
		],
	});
	if (collision)
		fake.models.push({
			...fake.models[2],
			id: "override-C-backend",
			name: "unrelated-router/override-C backend",
		});
	const override = fail
		? fauxProvider({
				provider: "other-parent-extension",
				models: [{ id: "override-C", reasoning: true }],
				tokensPerSecond: 1_000_000,
			})
		: undefined;
	if (override)
		await credentials.modify(override.provider.id, async () => ({
			type: "api_key",
			key: "parent-token",
		}));
	for (const model of [...fake.models, ...(override?.models ?? [])])
		model.thinkingLevelMap = {
			off: "off",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		};
	const requestAuth = (token, env) => ({
		auth: {
			apiKey: token,
			headers: { "X-Parent-Auth": "delegated" },
			baseUrl: "http://localhost:0/parent",
		},
		env: { PARENT_ONLY: "yes", ...(modelHeaders ? env : {}) },
	});
	const provider = {
		...fake.provider,
		auth: oauth
			? {
					oauth: {
						name: "Parent OAuth",
						login: async () => {
							throw new Error("No login in tests");
						},
						refresh: async () => {
							throw new Error("No OAuth network in tests");
						},
						toAuth: async (credential) => requestAuth(credential.access).auth,
					},
				}
			: {
					apiKey: {
						name: "Parent credential required",
						resolve: async ({ credential }) =>
							unconfigured
								? undefined
								: headerOnly
									? requestAuth(undefined, credential?.env)
									: credential?.key
										? requestAuth(credential.key, credential.env)
										: undefined,
					},
				},
	};
	const registry = new SubagentRegistry();
	const queue = new SubagentQueue(1);
	const deps = {
		discover: () => [config],
		run: (opts) => run(opts),
		registry,
		queue,
		getKnownTools: () => ["read"],
		sendMessage: () => {},
	};
	let ctx;
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			(pi) => {
				pi.registerProvider(provider);
				pi.registerTool(createInlineSpawnTool(deps));
				if (override)
					pi.registerProvider({ ...override.provider, auth: provider.auth });
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
	});
	await loader.reload();
	const manager = SessionManager.inMemory(dir);
	const { session: parent } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: runtime,
		model: fake.models[1],
		thinkingLevel: "low",
		scopedModels: scoped
			? [{ model: scoped === "prefix" ? fake.models.at(-1) : fake.models[2] }]
			: [],
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
		tools: ["spawn_inline_subagent"],
	});
	cleanups.push(() => parent.dispose());
	await parent.bindExtensions({ mode: "print" });
	const model = (id) => ctx.modelRegistry.find(providerId, id);
	let routes = 0;
	if (virtual) {
		runtime.registerVirtualModel({
			provider: providerId,
			id: "route",
			name: "Not Auto",
			thinkingLevels: ["low"],
			route: () => {
				routes++;
				return { model: model("physical-B"), thinkingLevel: "low" };
			},
		});
		await parent.setModel(model("route"), { persist: false });
		if (known)
			manager.appendMessage({
				...fauxAssistantMessage("prior physical response"),
				provider: providerId,
				api: fake.api,
				model: "physical-A",
				thinkingLevel: "xhigh",
			});
	}
	if (collision)
		runtime.registerVirtualModel({
			provider: "unrelated-router",
			id: "override-C",
			name: "Unrelated virtual collision",
			thinkingLevels: ["low"],
			route: () => {
				routes++;
				return { model: model("physical-B"), thinkingLevel: "low" };
			},
		});
	const dispatches = [];
	for (const target of [fake, ...(override ? [override] : [])])
		target.setResponses(
			Array(20).fill((_context, options, _state, selected) => {
				dispatches.push({
					provider: selected.provider,
					id: selected.id,
					api: selected.api,
					reasoning: options?.reasoning,
					apiKey: options?.apiKey,
					headers: options?.headers,
					env: options?.env,
					baseUrl: selected.baseUrl,
				});
				if (
					modelHeaders &&
					(options?.headers?.Authorization !== `Bearer model-${selected.id}` ||
						!options?.headers?.["X-Model-Tenant"])
				)
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "missing selected model auth/tenant headers",
					});
				return fauxAssistantMessage(
					"default transport reply",
					fail && selected.id === "override-C"
						? { stopReason: "error", errorMessage: "default synthetic failure" }
						: {},
				);
			}),
		);
	const children = [];
	const run = (extra = {}) =>
		runSubagent({
			ctx,
			config,
			prompt: "Inspect",
			sessionDir: dir,
			...extra,
			// No createSession: this is the unmodified production SDK factory path.
			onSession: (session, sessionFile) => {
				expect(inChildContext()).toBe(true);
				children.push(session);
				expect(session.model.api).not.toBe("pi-virtual");
				expect(session.resourceLoader.getExtensions()).toMatchObject({
					extensions: [],
					errors: [],
				});
				expect(session.getActiveToolNames()).toEqual(["read"]);
				return extra.onSession?.(session, sessionFile);
			},
		});
	const toolCtx = Object.assign(Object.create(ctx), {
		tools: [],
		executeTool: async () => {
			throw new Error("No nested tools");
		},
	});
	const spawn = (extra) =>
		parent
			.getToolDefinition("spawn_inline_subagent")
			.execute(
				"call",
				{ ...inlineArgs, tools: ["read"], ...extra },
				undefined,
				undefined,
				toolCtx,
			);
	const finish = () =>
		vi.waitFor(() =>
			expect(
				registry
					.list()
					.every((record) =>
						["completed", "failed", "stopped"].includes(record.status),
					),
			).toBe(true),
		);
	return {
		ctx,
		registry,
		spawn,
		finish,
		rotateAuth: (key, tenant) =>
			credentials.modify(providerId, async () => ({
				type: "api_key",
				key,
				env: { MODEL_TENANT: tenant },
			})),
		parent,
		runtime,
		model,
		overrideModel: () =>
			ctx.modelRegistry.find(override.provider.id, "override-C"),
		run,
		dispatches,
		children,
		routes: () => routes,
	};
}

const nativeVirtual =
	typeof ModelRuntime.prototype.registerVirtualModel === "function";
describe("production-default runner physical transport (no createSession injection)", () => {
	it.each([false, true])(
		"preserves chosen model headers, provider auth/base URL/env and fresh request resolution (header-only=%s)",
		async (headerOnly) => {
			const h = await defaultFixture({ modelHeaders: true, headerOnly });
			const selected = h.model("physical-B");
			expect(selected.headers?.["X-Model-Tenant"]).toBeUndefined();
			const expected = (token, tenant) =>
				expect.objectContaining({
					provider: "parent-extension-only",
					id: "physical-B",
					api: selected.api,
					apiKey: headerOnly ? undefined : token,
					headers: expect.objectContaining({
						"X-Parent-Auth": "delegated",
						"X-Provider": "configured",
						Authorization: "Bearer model-physical-B",
						"X-Model-Tenant": tenant,
					}),
					env: { PARENT_ONLY: "yes", MODEL_TENANT: tenant },
					baseUrl: "http://localhost:0/parent",
				});
			// Positive control uses the public parent request path, not a mock auth value.
			expect(
				await h.ctx.modelRegistry.complete(selected, { messages: [] }),
			).toMatchObject({ stopReason: "stop" });
			expect(h.dispatches).toEqual([expected("parent-token", "tenant-1")]);
			const auth = vi.spyOn(h.ctx.modelRegistry, "getApiKeyAndHeaders");
			const result = await h.run();
			expect(result, result.error).toEqual({
				status: "completed",
				output: "default transport reply",
			});
			expect(h.dispatches).toEqual([
				expected("parent-token", "tenant-1"),
				expected("parent-token", "tenant-1"),
			]);
			await h.rotateAuth("rotated-parent-token", "tenant-2");
			const child = h.children[0].modelRuntime;
			expect(
				await child.completeSimple(selected, { messages: [] }),
			).toMatchObject({ stopReason: "stop" });
			expect(h.dispatches).toEqual([
				expected("parent-token", "tenant-1"),
				expected("parent-token", "tenant-1"),
				expected("rotated-parent-token", "tenant-2"),
			]);
			expect(auth).toHaveBeenCalledWith(selected);
			expect(
				auth.mock.calls.map(([model]) => [model.provider, model.id, model.api]),
			).toEqual(
				Array(auth.mock.calls.length).fill([
					selected.provider,
					selected.id,
					selected.api,
				]),
			);
			expect(
				child.getModels().map((model) => [model.provider, model.id, model.api]),
			).toEqual([[selected.provider, selected.id, selected.api]]);
			expect(h.children).toHaveLength(1);
			expect(h.parent.model.id).toBe("physical-B");
			expect(h.parent.thinkingLevel).toBe("low");
		},
	);

	it("preserves successful header-only resolution when provider auth is absent", async () => {
		const h = await defaultFixture({ modelHeaders: true, unconfigured: true });
		const selected = h.model("physical-B");
		expect(
			await h.ctx.modelRegistry.getProviderAuth(selected.provider),
		).toBeUndefined();
		expect(
			await h.ctx.modelRegistry.getApiKeyAndHeaders(selected),
		).toMatchObject({
			ok: true,
			headers: expect.objectContaining({
				"X-Model-Tenant": "header-only-tenant",
			}),
		});
		const result = await h.run();
		expect(result, result.error).toEqual({
			status: "completed",
			output: "default transport reply",
		});
		expect(h.dispatches).toEqual([
			expect.objectContaining({
				provider: selected.provider,
				id: selected.id,
				api: selected.api,
				apiKey: undefined,
				env: undefined,
				baseUrl: "http://localhost:0",
				headers: expect.objectContaining({
					"X-Provider": "configured",
					Authorization: "Bearer model-physical-B",
					"X-Model-Tenant": "header-only-tenant",
				}),
			}),
		]);
		expect(h.children).toHaveLength(1);
		expect(h.parent.model.id).toBe("physical-B");
		expect(h.parent.thinkingLevel).toBe("low");
	});

	it("returns failed on model-specific auth resolution failure without default child dispatch", async () => {
		expect(process.env.PI_SUBAGENTS_MISSING_TEST_VAR).toBeUndefined();
		const h = await defaultFixture({ modelHeaders: true, authFailure: true });
		const selected = h.model("physical-B");
		const resolution = await h.ctx.modelRegistry.getApiKeyAndHeaders(selected);
		expect(resolution).toMatchObject({
			ok: false,
			error: expect.stringContaining("PI_SUBAGENTS_MISSING_TEST_VAR"),
		});
		const auth = vi.spyOn(h.ctx.modelRegistry, "getApiKeyAndHeaders");
		const result = await h.run({
			model: selected,
			config: { ...config, allowModelFallback: false },
		});
		expect(result).toMatchObject({
			status: "failed",
			error: expect.stringContaining("PI_SUBAGENTS_MISSING_TEST_VAR"),
		});
		expect(auth).toHaveBeenCalledWith(selected);
		expect(h.children).toHaveLength(1);
		expect(
			h.children[0].messages.filter((message) => message.role === "assistant"),
		).toEqual([]);
		expect(h.dispatches).toHaveLength(0);
		expect(h.parent.model.id).toBe("physical-B");
		expect(h.parent.thinkingLevel).toBe("low");
	});

	it
		.skipIf(!nativeVirtual)
		.each(["override-C", "parent-extension-only/override-C"])(
		"default native caller pins scoped physical %s despite an unrelated virtual ID",
		async (query) => {
			const h = await defaultFixture({
				virtual: true,
				known: false,
				collision: true,
				scoped: true,
			});
			const result = await h.spawn({
				model: query,
				thinking: "high",
				allow_model_fallback: false,
			});
			expect(result.details.id, JSON.stringify(result.content)).not.toBe("");
			await h.finish();
			expect(h.registry.list()).toHaveLength(1);
			expect(
				h.registry.list()[0],
				h.registry.list()[0]?.outcome?.error,
			).toMatchObject({
				model: "override-C",
				thinkingLevel: "high",
				status: "completed",
			});
			expect(h.dispatches.map((d) => [d.provider, d.id, d.reasoning])).toEqual([
				["parent-extension-only", "override-C", "high"],
			]);
			expect(h.children).toHaveLength(1);
			expect(
				h.children[0].modelRuntime.getModels().map((model) => model.id),
			).toEqual(["override-C"]);
			expect(h.routes()).toBe(0);
			expect(h.parent.model.id).toBe("route");
			expect(h.parent.thinkingLevel).toBe("low");
		},
	);

	it.skipIf(!nativeVirtual).each(["unrelated-router/override-C", "route"])(
		"default native caller refuses virtual %s before any record, child or fuzzy physical dispatch",
		async (query) => {
			const h = await defaultFixture({
				virtual: true,
				collision: true,
				scoped: query.includes("/") ? "prefix" : true,
			});
			const result = await h.spawn({ model: query, thinking: "high" });
			expect(JSON.stringify(result.content)).toMatch(
				/explicit physical model.*virtual model/i,
			);
			expect(h.registry.list()).toHaveLength(0);
			expect(h.children).toHaveLength(0);
			expect(h.dispatches).toHaveLength(0);
			expect(h.routes()).toBe(0);
			expect(h.parent.model.id).toBe("route");
			expect(h.parent.thinkingLevel).toBe("low");
		},
	);

	it.each([false, true])(
		"inherits a parent-extension-only physical provider and delegates stored auth (OAuth=%s)",
		async (oauth) => {
			const h = await defaultFixture({ oauth });
			const result = await h.run();
			expect(result, result.error).toEqual({
				status: "completed",
				output: "default transport reply",
			});
			expect(h.dispatches).toEqual([
				expect.objectContaining({
					provider: "parent-extension-only",
					id: "physical-B",
					reasoning: "low",
					apiKey: "parent-token",
					headers: expect.objectContaining({ "X-Parent-Auth": "delegated" }),
					baseUrl: "http://localhost:0/parent",
					...(!oauth ? { env: { PARENT_ONLY: "yes" } } : {}),
				}),
			]);
			expect(h.children[0].messages.at(-1)).toMatchObject({
				role: "assistant",
				provider: "parent-extension-only",
				model: "physical-B",
				stopReason: "stop",
			});
			expect(h.parent.model.id).toBe("physical-B");
			expect(h.parent.thinkingLevel).toBe("low");
		},
	);

	it("limits the child catalog, availability and both stream entrypoints to the chosen physical identity/API", async () => {
		const h = await defaultFixture();
		expect((await h.run()).status).toBe("completed");
		const child = h.children[0].modelRuntime;
		expect(child.getModels().map((m) => m.id)).toEqual(["physical-B"]);
		if (child.getAllModels)
			expect(child.getAllModels().map((m) => m.id)).toEqual(["physical-B"]);
		expect((await child.getAvailable()).map((m) => m.id)).toEqual([
			"physical-B",
		]);
		for (const selected of [
			{ ...h.model("physical-B"), id: "override-C" },
			{ ...h.model("physical-B"), api: "different-api" },
		]) {
			for (const complete of ["complete", "completeSimple"])
				expect(await child[complete](selected, { messages: [] })).toMatchObject(
					{
						stopReason: "error",
						errorMessage: expect.stringMatching(/chosen physical model/i),
					},
				);
		}
		expect(h.dispatches).toHaveLength(1);
	});

	it("missing public parent transport fails actionably before session/provider work", async () => {
		const h = await defaultFixture();
		const result = await h.run({
			model: { ...h.model("physical-B"), provider: "missing-parent-provider" },
			config: { ...config, allowModelFallback: false },
		});
		expect(result).toMatchObject({
			status: "failed",
			error: expect.stringMatching(
				/configured parent provider.*missing-parent-provider/i,
			),
		});
		expect(h.children).toHaveLength(0);
		expect(h.dispatches).toHaveLength(0);
	});

	it.each([true, false])(
		"default physical failure honors captured fallback policy %s",
		async (allowed) => {
			const h = await defaultFixture({ fail: true });
			const result = await h.run({
				model: h.overrideModel(),
				thinkingLevel: "high",
				config: { ...config, allowModelFallback: allowed },
			});
			expect(h.dispatches.map((d) => [d.id, d.reasoning])).toEqual(
				allowed
					? [
							["override-C", "high"],
							["physical-B", "high"],
						]
					: [["override-C", "high"]],
			);
			expect(h.dispatches.map((d) => d.provider)).toEqual(
				allowed
					? ["other-parent-extension", "parent-extension-only"]
					: ["other-parent-extension"],
			);
			expect(
				h.children.map((child) =>
					child.modelRuntime.getModels().map((m) => m.provider),
				),
			).toEqual(
				allowed
					? [["other-parent-extension"], ["parent-extension-only"]]
					: [["other-parent-extension"]],
			);
			expect(result.status).toBe(allowed ? "completed" : "failed");
			expect(allowed ? result.output : result.error).toContain(
				allowed
					? "Fell back to parent-extension-only/physical-B"
					: "default synthetic failure",
			);
		},
	);

	it.skipIf(!nativeVirtual)(
		"inherits the successful physical response from a mixed physical/virtual provider without copying its router",
		async () => {
			const h = await defaultFixture({ virtual: true });
			const result = await h.run();
			expect(result, result.error).toEqual({
				status: "completed",
				output: "default transport reply",
			});
			expect(h.dispatches.map((d) => [d.id, d.reasoning])).toEqual([
				["physical-A", "xhigh"],
			]);
			expect(h.children[0].modelRuntime.getModels().map((m) => m.id)).toEqual([
				"physical-A",
			]);
			expect(
				h.children[0].modelRuntime.getModel("parent-extension-only", "route"),
			).toBeUndefined();
			expect(h.routes()).toBe(0);
			expect(h.parent.model.id).toBe("route");
			expect(h.parent.thinkingLevel).toBe("low");
		},
	);

	it.skipIf(!nativeVirtual)(
		"refuses unknown inheritance but permits independent explicit model/effort without routing",
		async () => {
			const h = await defaultFixture({ virtual: true, known: false });
			expect(await h.run()).toMatchObject({
				status: "failed",
				error: expect.stringMatching(/explicit physical model/i),
			});
			expect(h.dispatches).toHaveLength(0);
			expect(
				await h.run({
					model: h.model("override-C"),
					thinkingLevel: "off",
					config: { ...config, allowModelFallback: false },
				}),
			).toEqual({ status: "completed", output: "default transport reply" });
			expect(h.dispatches.map((d) => [d.id, d.reasoning])).toEqual([
				["override-C", undefined],
			]);
			expect(h.routes()).toBe(0);
		},
	);

	it.skipIf(!nativeVirtual)(
		"keeps the accepted pair pinned across later parent selection changes",
		async () => {
			const h = await defaultFixture({ virtual: true });
			const { resolveSubagentSettings } = await import(
				"../src/model-resolver.ts"
			);
			const resolved = resolveSubagentSettings(h.ctx);
			await h.parent.setModel(h.model("physical-B"), { persist: false });
			h.parent.setThinkingLevel("off", { persist: false });
			expect((await h.run({ resolved })).status).toBe("completed");
			expect(h.dispatches.map((d) => [d.id, d.reasoning])).toEqual([
				["physical-A", "xhigh"],
			]);
			expect(h.parent.model.id).toBe("physical-B");
			expect(h.parent.thinkingLevel).toBe("off");
			expect(h.routes()).toBe(0);
		},
	);
});
