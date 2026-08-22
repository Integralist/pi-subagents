/**
 * Running one subagent.
 *
 * A subagent is a nested agent session created through the Pi SDK inside the
 * host process — not a separate `pi` process. It gets its own resource loader,
 * its own in-memory transcript, and the agent file's system prompt in place of
 * the host's, so nothing it does reaches the parent's conversation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

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
	signal?: AbortSignal;
	createSession?: SessionFactory;
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
function describeCause(cause: unknown): string {
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
		return await runInChildContext(() => runSubagentUnguarded(opts));
	} catch (error) {
		return {
			status: "failed",
			output: "",
			error: new SubagentError(opts.config.name, error).message,
		};
	}
}

async function runSubagentUnguarded(
	opts: RunSubagentOptions,
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

	const { session } = await createSession({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		model: opts.model ?? ctx.model,
		thinkingLevel: opts.thinkingLevel ?? ctx.thinkingLevel,
		tools: config.tools,
		resourceLoader: loader,
		// The child's transcript stays in memory: a subagent must not write over
		// the session file the parent is using.
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager: SettingsManager.create(ctx.cwd, getAgentDir()),
	});

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
