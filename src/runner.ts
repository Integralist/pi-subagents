/**
 * Running one subagent.
 *
 * A subagent is a nested agent session created through the Pi SDK inside the
 * host process — not a separate `pi` process. It gets its own resource loader,
 * its own in-memory transcript, and the agent file's system prompt in place of
 * the host's, so nothing it does reaches the parent's conversation.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
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
 * Read an outcome off the finished transcript.
 *
 * The provider's own `stopReason` decides the status, so a subagent that was
 * interrupted is reported as stopped rather than as a short success, and one
 * whose provider errored carries that message back to the caller.
 */
function summariseOutcome(messages: unknown[]): SubagentOutcome {
	const reply = lastAssistantReply(messages);
	if (!reply) {
		return {
			status: "failed",
			output: "",
			error: "the subagent finished without a reply",
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
			error: reply.errorMessage ?? "the subagent's model reported an error",
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

export async function runSubagent(
	opts: RunSubagentOptions,
): Promise<SubagentOutcome> {
	const { ctx, config, prompt, signal } = opts;
	const createSession = opts.createSession ?? createAgentSession;

	// Nothing to do if the caller gave up before we started.
	if (signal?.aborted) {
		return { status: "stopped", output: "" };
	}

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
	// calling `abort()` on it when the caller's signal fires.
	const onAbort = () => void session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.prompt(prompt);
		return summariseOutcome(session.messages);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
