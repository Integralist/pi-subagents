/**
 * Running one subagent.
 *
 * A subagent is a nested agent session created through the Pi SDK inside the
 * host process — not a separate `pi` process. It gets its own resource loader,
 * its own in-memory transcript, and the agent file's system prompt in place of
 * the host's, so nothing it does reaches the parent's conversation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import {
	isPhysicalModel,
	modelLabel,
	type PhysicalSettings,
	type ResolvedSubagentSettings,
	resolveSubagentSettings,
} from "./model-resolver.ts";

/** Default read-only tools assigned when no explicit allowlist is given. */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * Marks everything a subagent does, so the spawn tools can refuse to run there.
 *
 * A subagent that could spawn subagents would fork the host process without
 * bound. The child's loader already sets `noExtensions`, which stops it loading
 * this extension and so stops it seeing the tools at all — but that flag is
 * narrower than it looks. It suppresses only the settings-configured
 * extensions; anything in `additionalExtensionPaths` still loads
 * (`dist/core/resource-loader.js:315-317`). This flag states the intent
 * directly, so it survives a change that starts passing that option down.
 *
 * Async-context-local rather than a module-level boolean: Slice 3 runs several
 * subagents at once, and a sibling operation must not inherit a flag set by
 * whichever child happens to be running beside it.
 */
const childContext = new AsyncLocalStorage<boolean>();

/** Whether the caller is running inside a subagent. */
export const inChildContext = (): boolean => childContext.getStore() === true;

/** Run `fn` marked as subagent work, including everything it awaits. */
export const runInChildContext = <T>(fn: () => Promise<T>): Promise<T> =>
	childContext.run(true, fn);

/**
 * How a session gets made. Real runs use Pi's `createAgentSession`; tests pass
 * a stub, which is the seam the specification names for tool-boundary tests.
 */
export type SessionFactory = (
	options: CreateAgentSessionOptions,
) => Promise<CreateAgentSessionResult>;

export interface RunSubagentOptions {
	ctx: ExtensionContext;
	config: AgentConfig;
	prompt: string;
	/**
	 * Overrides the parent's model. Omitted means inherit.
	 *
	 * Pi spells this `Model<any>`; `Model<Api>` is the same set of models named
	 * without `any`, and the two are mutually assignable.
	 */
	model?: Model<Api>;
	/** Overrides the parent's reasoning effort. Omitted means inherit. */
	thinkingLevel?: ThinkingLevel;
	/** Captured before queue submission, including override provenance. */
	resolved?: ResolvedSubagentSettings;
	signal?: AbortSignal;
	createSession?: SessionFactory;
	/**
	 * A transcript to carry on from, instead of starting a new one.
	 *
	 * A path that is no longer there is treated as no path at all — see
	 * `buildSessionManager` for why that is not the same as trusting pi.
	 */
	resumeFrom?: string;
	/**
	 * Where a new transcript is written. Omitted means pi's own default,
	 * `~/.pi/agent/sessions/<encoded-cwd>/`, which is what production wants.
	 *
	 * Present so a test can point transcripts at a temporary directory:
	 * `getDefaultSessionDir` is not exported from the package root, so there is
	 * no way to compute the default and then redirect it.
	 */
	sessionDir?: string;
	/**
	 * Handed the child's session once it exists and before it is prompted, along
	 * with the file its transcript is being written to.
	 *
	 * The runner builds the session, prompts it and disposes it, so without this
	 * nothing outside can reach it. Context tracking needs it from the first
	 * turn, steering needs it for the life of the run, and the session file is
	 * what lets the record reopen the conversation afterwards. Called inside the
	 * crash guard: a callback that throws costs this run, not the host.
	 */
	onSession?: (session: AgentSession, sessionFile: string | undefined) => void;
}

export interface SubagentOutcome {
	status: "completed" | "failed" | "stopped";
	output: string;
	error?: string;
}

/**
 * A subagent run that ended in a thrown error rather than a reply.
 *
 * Constructed but deliberately never thrown: `runSubagent` returns outcomes, so
 * this exists to give every failure one message shape that names the agent, and
 * to keep the original cause attached for a caller that wants to log it.
 */
export class SubagentError extends Error {
	constructor(
		readonly agentName: string,
		cause: unknown,
	) {
		super(failureReason(agentName, describeCause(cause)), { cause });
		this.name = "SubagentError";
	}
}

/**
 * Turn an unknown thrown value into something readable. A dependency is free to
 * throw a string, or `undefined`, and that must still produce a usable message
 * rather than "[object Object]".
 */
export function describeCause(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	if (typeof cause === "string") {
		return cause;
	}
	try {
		return JSON.stringify(cause) ?? String(cause);
	} catch {
		return String(cause);
	}
}

/**
 * The shape of an assistant reply this module reads. Pi types the transcript as
 * a union of message kinds; only these fields are needed to decide an outcome,
 * so the union is narrowed structurally rather than by importing the full type
 * from `pi-agent-core`.
 */
interface AssistantReply {
	role: "assistant";
	content: unknown[];
	stopReason?: string;
	errorMessage?: string;
}

function isAssistantReply(message: unknown): message is AssistantReply {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "assistant" &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

/**
 * Join the text blocks of a reply. Thinking blocks and tool calls are dropped:
 * the caller asked the subagent a question and wants its answer, not its
 * reasoning or its working.
 */
function replyText(reply: AssistantReply): string {
	return reply.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function lastAssistantReply(messages: unknown[]): AssistantReply | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantReply(message)) {
			return message;
		}
	}
	return undefined;
}

/**
 * The one shape a failure reason takes.
 *
 * Every `error` on an outcome names its agent, whatever the cause — a thrown
 * error, a provider error, or an empty reply. Callers can then report the
 * reason verbatim instead of prefixing it themselves, which is what produced
 * `The "reviewer" subagent failed: subagent "reviewer" failed: ...`.
 */
function failureReason(agentName: string, reason: string): string {
	return `subagent "${agentName}" failed: ${reason}`;
}

/**
 * Read an outcome off the finished transcript.
 *
 * The provider's own `stopReason` decides the status, so a subagent that was
 * interrupted is reported as stopped rather than as a short success, and one
 * whose provider errored carries that message back to the caller.
 */
function summariseOutcome(
	agentName: string,
	messages: unknown[],
): SubagentOutcome {
	const reply = lastAssistantReply(messages);
	if (!reply) {
		return {
			status: "failed",
			output: "",
			error: failureReason(agentName, "it finished without a reply"),
		};
	}

	const output = replyText(reply);

	if (reply.stopReason === "aborted") {
		return { status: "stopped", output };
	}
	if (reply.stopReason === "error") {
		return {
			status: "failed",
			output,
			error: failureReason(
				agentName,
				reply.errorMessage ?? "its model reported an error",
			),
		};
	}
	return { status: "completed", output };
}

/**
 * Build the child's resource loader.
 *
 * `systemPromptOverride` rather than the plainer `systemPrompt` option: that
 * option is treated as a prompt *source* and gets passed to `existsSync`, so an
 * agent whose body happened to look like a path would silently load that file
 * instead. The override's return value is used verbatim.
 *
 * Everything the child has no use for is switched off. `noExtensions` also
 * serves as the recursion guard — a subagent cannot load this extension, so it
 * cannot spawn subagents of its own.
 */
function buildLoader(cwd: string, config: AgentConfig): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => config.systemPrompt,
		appendSystemPromptOverride: () => [],
	});
}

/**
 * The transcript this run writes to: the stored one, or a new one.
 *
 * A subagent gets a file of its own rather than the in-memory session it used
 * to have, so a finished conversation survives to be continued. `parentSession`
 * nests it under whoever spawned it in pi's own `/resume` picker instead of
 * leaving it loose among the user's real sessions.
 *
 * A parent running in memory has no file to be nested under, and its
 * `undefined` is passed straight through: pi leaves the key out of the header
 * rather than recording a dangling parent, so guarding it here would be a
 * branch with nothing behind it. A test pins that behaviour, since this now
 * depends on it.
 *
 * **A stored path that no longer exists is not reopened.**
 * `SessionManager.open` does not object to a missing file — `loadEntriesFromFile`
 * returns nothing for one and `_setSessionFile` then quietly starts a new
 * session at that path. Resuming a transcript the user has deleted would
 * therefore look like it had continued something when it had not. Checking
 * first is what turns that into an honest fresh start.
 */
function buildSessionManager(
	ctx: ExtensionContext,
	opts: RunSubagentOptions,
): SessionManager {
	if (opts.resumeFrom && existsSync(opts.resumeFrom)) {
		return SessionManager.open(opts.resumeFrom, opts.sessionDir);
	}

	return SessionManager.create(ctx.cwd, opts.sessionDir, {
		parentSession: ctx.sessionManager?.getSessionFile(),
	});
}

/**
 * Run a subagent, containing every failure.
 *
 * This is the boundary that makes running subagents in the host process safe:
 * a child that throws must come back as a failed outcome, never as an exception
 * in the user's own session. Treat any path that can throw past here as a bug.
 */
export async function runSubagent(
	opts: RunSubagentOptions,
): Promise<SubagentOutcome> {
	try {
		// Inside the child context, so anything the child session does — every
		// tool call it makes included — is marked as subagent work.
		return await runInChildContext(() => runSubagentWithFallback(opts));
	} catch (error) {
		return {
			status: "failed",
			output: "",
			error: new SubagentError(opts.config.name, error).message,
		};
	}
}

async function runSubagentWithFallback(
	opts: RunSubagentOptions,
): Promise<SubagentOutcome> {
	if (opts.signal?.aborted) return { status: "stopped", output: "" };
	const settings =
		opts.resolved ??
		resolveSubagentSettings(
			opts.ctx,
			opts.model,
			opts.thinkingLevel ?? opts.config.thinking,
			opts.config.allowModelFallback,
		);
	if (opts.config.allowModelFallback === false && !settings.explicitModel) {
		throw new Error(
			"An explicit model is required when model fallback is disabled.",
		);
	}
	const ownModel = settings.model;
	const fallback = settings.fallback;
	const canFallback =
		opts.config.allowModelFallback !== false &&
		settings.explicitModel &&
		fallback &&
		(ownModel.provider !== fallback.model.provider ||
			ownModel.id !== fallback.model.id);
	if (!canFallback || !fallback) {
		let outcome: SubagentOutcome;
		try {
			outcome = await runSubagentUnguarded(opts, settings);
		} catch (error) {
			if (fallback || opts.config.allowModelFallback === false) throw error;
			throw new Error(
				`${describeCause(error)} Choose an explicit physical model; the main model's physical fallback is unknown.`,
			);
		}
		if (
			outcome.status === "failed" &&
			opts.config.allowModelFallback !== false &&
			!fallback
		) {
			return {
				...outcome,
				error: `${outcome.error} Choose an explicit physical model; the main model's physical fallback is unknown.`,
			};
		}
		return outcome;
	}

	let firstError: string | undefined;
	try {
		const outcome = await runSubagentUnguarded(opts, settings);
		if (outcome.status !== "failed" || opts.signal?.aborted) {
			return outcome;
		}
		firstError = outcome.error;
	} catch (error) {
		if (opts.signal?.aborted) {
			return { status: "stopped", output: "" };
		}
		firstError = describeCause(error);
	}

	// Retry once on the physical pair accepted with this run, never a router.
	const fallbackOutcome = await runSubagentUnguarded(opts, fallback);

	const failedModel = modelLabel(ownModel);
	const fallbackModel = modelLabel(fallback.model);
	const prefix = `subagent "${opts.config.name}" failed: `;
	const cleanReason = firstError?.startsWith(prefix)
		? firstError.slice(prefix.length)
		: firstError;
	const reason = cleanReason ? `: ${cleanReason}` : "";

	if (fallbackOutcome.status === "completed") {
		const note = `Note: Model "${failedModel}" failed${reason}. Fell back to ${fallbackModel}.\n\n`;
		return {
			...fallbackOutcome,
			output: note + fallbackOutcome.output,
		};
	}

	if (fallbackOutcome.status === "failed") {
		return {
			status: "failed",
			output: fallbackOutcome.output,
			error: failureReason(
				opts.config.name,
				`model "${failedModel}" failed${reason}, and fallback to ${fallbackModel} also failed: ${fallbackOutcome.error ?? "unknown error"}`,
			),
		};
	}

	return fallbackOutcome;
}

/** Pin only the chosen public physical transport, never the parent's router. */
async function createSubagentRuntime(
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<ModelRuntime> {
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!isPhysicalModel(model) || !provider) {
		throw new Error(
			`No configured parent provider for subagent model ${modelLabel(model)}. Choose an explicit physical model with a configured parent provider.`,
		);
	}
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	// No default catalogs, ambient auth or paid transport can escape the pin.
	for (const builtin of runtime.getProviders()) {
		const disabled = {
			id: builtin.id,
			name: builtin.name,
			auth: {
				apiKey: {
					name: "Unavailable in subagents",
					resolve: async () => undefined,
				},
			},
			getModels: () => [],
			getAllModels: () => [],
			stream: () => {
				throw new Error("Default providers are unavailable in subagents.");
			},
			streamSimple: () => {
				throw new Error("Default providers are unavailable in subagents.");
			},
		};
		runtime.registerNativeProvider(disabled);
	}
	const assertChosen = (candidate: Model<Api>) => {
		if (
			!isPhysicalModel(candidate) ||
			candidate.provider !== model.provider ||
			candidate.id !== model.id ||
			candidate.api !== model.api
		) {
			throw new Error("Subagents can stream only their chosen physical model.");
		}
	};
	const physicalProvider = {
		...provider,
		// Parent-owned credentials/headers/OAuth stay behind its public auth API.
		auth: {
			apiKey: {
				name: "Parent session",
				resolve: async () => {
					const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!resolved.ok) {
						throw new Error(
							`Cannot resolve parent authentication for ${modelLabel(model)}: ${resolved.error}`,
						);
					}
					return {
						auth: {
							apiKey: resolved.apiKey,
							headers: resolved.headers,
							...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
						},
						env: resolved.env,
					};
				},
			},
		},
		getModels: () => [model],
		getAllModels: () => [model],
		refreshModels: undefined,
		filterModels: () => [model],
		filterAllModels: () => [model],
		stream: ((candidate, context, options) => {
			assertChosen(candidate);
			return provider.stream(candidate, context, options);
		}) as typeof provider.stream,
		streamSimple: ((candidate, context, options) => {
			assertChosen(candidate);
			return provider.streamSimple(candidate, context, options);
		}) as typeof provider.streamSimple,
	};
	runtime.registerNativeProvider(physicalProvider);
	return runtime;
}

async function runSubagentUnguarded(
	opts: RunSubagentOptions,
	settings: PhysicalSettings,
): Promise<SubagentOutcome> {
	const { ctx, config, prompt, signal } = opts;
	const createSession = opts.createSession ?? createAgentSession;

	// Nothing to do if the caller gave up before we started.
	if (signal?.aborted) {
		return { status: "stopped", output: "" };
	}

	// Inside the guard: building the loader reads the filesystem and resolves
	// packages, and either can fail before a session exists at all.
	const loader = buildLoader(ctx.cwd, config);
	await loader.reload();

	// Built before the session, so its file is known even if session creation
	// fails, and so `onSession` can report the path alongside the session.
	const sessionManager = buildSessionManager(ctx, opts);

	// An explicit factory owns its transport; preserve that public injection seam.
	const modelRuntime = opts.createSession
		? undefined
		: await createSubagentRuntime(ctx, settings.model);
	const { session } = await createSession({
		...(modelRuntime ? { modelRuntime } : {}),
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		model: settings.model,
		thinkingLevel: settings.thinkingLevel,
		tools: config.tools ?? [...DEFAULT_SUBAGENT_TOOLS],
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.create(ctx.cwd, getAgentDir()),
	});

	opts.onSession?.(session, sessionManager.getSessionFile());

	// `PromptOptions` carries no abort signal, so stopping the child means
	// calling `abort()` on it when the caller's signal fires. The rejection
	// handler is not optional: this runs from an event listener, so a rejected
	// `abort()` has nowhere to surface but the process itself.
	const onAbort = () => {
		void Promise.resolve(session.abort()).catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.prompt(prompt);
		return summariseOutcome(config.name, session.messages);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// Teardown must not decide the outcome. A `dispose()` that throws would
		// otherwise replace a perfectly good answer with a failure.
		try {
			session.dispose();
		} catch {
			// Nothing useful to do: the run is already over.
		}
	}
}
