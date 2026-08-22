/**
 * A subagent's conversation, drawn with pi's own message components.
 *
 * The point of reusing `UserMessageComponent`, `AssistantMessageComponent` and
 * `ToolExecutionComponent` rather than formatting the transcript here is that an
 * open subagent then reads exactly like the session around it: the same markdown,
 * the same tool renderers, the same collapsing. A hand-rolled transcript would
 * drift from pi's the first time either changed.
 *
 * The components are rebuilt from the child's messages rather than accumulated
 * as events arrive. Messages are the truth — a viewer opened halfway through a
 * run, or after it finished, has no events to replay and must draw what is
 * already there.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export interface TranscriptOptions {
	/**
	 * Needed by `ToolExecutionComponent`, which asks for a redraw when it
	 * converts an image and when its result arrives.
	 */
	tui: TUI;
	/** Paths in tool renderers are shown relative to this. */
	cwd: string;
	/**
	 * How the tool that produced a call is drawn.
	 *
	 * The child session's own `getToolDefinition` is what a caller passes, so a
	 * tool renders the way it does in the session that ran it. Without one every
	 * call falls back to pi's generic rendering, which names the tool and its
	 * arguments — less, but never wrong.
	 */
	getToolDefinition?: (name: string) => ToolDefinition | undefined;
}

/** An assistant message, narrowed off the wider `AgentMessage` union. */
function isAssistant(message: AgentMessage): message is AssistantMessage {
	return (
		(message as { role?: unknown }).role === "assistant" &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

/**
 * The text of a user message.
 *
 * Pi allows either a bare string or content blocks, and a subagent's first
 * prompt arrives as the former while a steering message may arrive as either.
 * Images are dropped: the viewer is a transcript, not a gallery.
 */
function userText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/** The tool calls an assistant message made, in the order it made them. */
function toolCalls(
	message: AssistantMessage,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	return message.content.filter(
		(
			block,
		): block is {
			type: "toolCall";
			id: string;
			name: string;
			arguments: Record<string, unknown>;
		} => block.type === "toolCall",
	);
}

/**
 * A subagent's conversation as components, kept in step with its messages.
 *
 * Held as a class because the components are the cache: rebuilding them on every
 * keystroke of a streaming reply would re-parse the whole transcript's markdown
 * for each token. Instead the finished messages are rebuilt only when there is a
 * new one, and the reply still arriving is a single component updated in place —
 * which is what `AssistantMessageComponent.updateContent` exists for.
 */
export class Transcript {
	readonly #options: TranscriptOptions;
	#components: Component[] = [];
	/**
	 * How many messages the components were built from. Negative so the first
	 * `sync` always builds, including for a conversation with no messages yet.
	 */
	#count = -1;
	/** The reply still arriving, drawn after everything already said. */
	#live: AssistantMessageComponent | undefined;

	constructor(options: TranscriptOptions) {
		this.#options = options;
	}

	/**
	 * Bring the components in line with the child's messages.
	 *
	 * `streaming` is pi's partial assistant message — the reply being written as
	 * it is written. It moves into `messages` when it completes, so it is dropped
	 * here the moment pi stops reporting one, rather than left to draw the last
	 * reply twice.
	 */
	sync(messages: readonly AgentMessage[], streaming?: AgentMessage): void {
		if (messages.length !== this.#count) {
			this.#components = this.#build(messages);
			this.#count = messages.length;
		}

		if (streaming && isAssistant(streaming)) {
			// Thinking is hidden: a subagent's reasoning is not what someone opening
			// its conversation came to read, and it dwarfs everything else.
			this.#live ??= new AssistantMessageComponent(undefined, true);
			this.#live.updateContent(streaming, true);
			return;
		}

		this.#live = undefined;
	}

	/**
	 * Throw the components away, so the next `sync` builds them again.
	 *
	 * Pi calls this when the theme changes. The components hold rendered lines
	 * in the old colours, and only a rebuild is sure to be rid of them.
	 */
	invalidate(): void {
		this.#count = -1;
		this.#live = undefined;
	}

	/** Every line of the conversation, in order. */
	render(width: number): string[] {
		const components = this.#live
			? [...this.#components, this.#live]
			: this.#components;
		return components.flatMap((component) => component.render(width));
	}

	/**
	 * One component per message, with each tool call drawn as its own block and
	 * its result attached to it.
	 *
	 * A result whose call is not in the transcript is dropped rather than drawn
	 * on its own. That happens to a conversation resumed from a compacted or
	 * truncated file, where the reply that made the call has gone.
	 */
	#build(messages: readonly AgentMessage[]): Component[] {
		const { tui, cwd, getToolDefinition } = this.#options;
		const components: Component[] = [];
		const executions = new Map<string, ToolExecutionComponent>();

		for (const message of messages) {
			const role = (message as { role?: unknown }).role;

			if (role === "user") {
				components.push(new UserMessageComponent(userText(message)));
				continue;
			}

			if (isAssistant(message)) {
				components.push(new AssistantMessageComponent(message, true));
				for (const call of toolCalls(message)) {
					const execution = new ToolExecutionComponent(
						call.name,
						call.id,
						call.arguments,
						undefined,
						getToolDefinition?.(call.name),
						tui,
						cwd,
					);
					executions.set(call.id, execution);
					components.push(execution);
				}
				continue;
			}

			if (role === "toolResult") {
				const result = message as {
					toolCallId: string;
					content: Array<{ type: string; text?: string }>;
					details?: unknown;
					isError: boolean;
				};
				executions.get(result.toolCallId)?.updateResult({
					content: result.content,
					details: result.details,
					isError: result.isError,
				});
			}
		}

		return components;
	}
}
