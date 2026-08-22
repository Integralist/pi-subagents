import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	initTheme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Transcript, type TranscriptOptions } from "../../src/ui/transcript.ts";

/**
 * Pi's own message components read the global theme — for a message background,
 * for the hidden-thinking label — and throw until one is installed. Every test
 * here therefore renders in real colour and strips the escapes back out, which
 * is what the list tests do with their own theme.
 */
beforeAll(() => {
	initTheme("dark");
});

/** `ToolExecutionComponent` asks for a redraw; nothing here needs to see one. */
const fakeTui = { requestRender: () => {} } as unknown as TUI;

const WIDTH = 60;

function transcript(options: Partial<TranscriptOptions> = {}): Transcript {
	return new Transcript({ tui: fakeTui, cwd: "/work", ...options });
}

function lines(
	subject: Transcript,
	messages: AgentMessage[],
	streaming?: AgentMessage,
): string[] {
	subject.sync(messages, streaming);
	return subject.render(WIDTH).map(stripTerminalSequences);
}

/** What pi hands back for a prompt, whose content is a bare string. */
function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

function toolResult(
	toolCallId: string,
	text: string,
	isError = false,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}

describe("Transcript", () => {
	it("shows the task the subagent was given", () => {
		const drawn = lines(transcript(), [user("review src/queue.ts for races")]);

		expect(drawn.join("\n")).toContain("review src/queue.ts for races");
	});

	/** A steering message arrives as content blocks rather than a bare string. */
	it("shows a message sent as content blocks", () => {
		const steer = {
			role: "user",
			content: [{ type: "text", text: "look at the tests too" }],
			timestamp: 1,
		} as AgentMessage;

		expect(lines(transcript(), [steer]).join("\n")).toContain(
			"look at the tests too",
		);
	});

	it("shows the subagent's reply", () => {
		const drawn = lines(transcript(), [
			assistant([{ type: "text", text: "The slot counter is not the race." }]),
		]);

		expect(drawn.join("\n")).toContain("The slot counter is not the race.");
	});

	/**
	 * Reasoning is not what someone opening a subagent came to read, and it
	 * dwarfs the answer. The label stays so a long silence is explained.
	 */
	it("hides the subagent's reasoning", () => {
		const drawn = lines(transcript(), [
			assistant([
				{ type: "thinking", thinking: "maybe the counter is off by one" },
				{ type: "text", text: "No race here." },
			]),
		]).join("\n");

		expect(drawn).not.toContain("off by one");
		expect(drawn).toContain("Thinking");
		expect(drawn).toContain("No race here.");
	});

	it("draws every tool call the subagent made", () => {
		const drawn = lines(transcript(), [
			assistant(
				[
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { file_path: "src/queue.ts" },
					},
					{
						type: "toolCall",
						id: "call-2",
						name: "grep",
						arguments: { pattern: "submit" },
					},
				],
				"toolUse",
			),
		]).join("\n");

		expect(drawn).toContain("read");
		expect(drawn).toContain("src/queue.ts");
		expect(drawn).toContain("grep");
		expect(drawn).toContain("submit");
	});

	/**
	 * A failed tool call is the one result pi shows without being expanded, which
	 * is what makes this the honest test that results reach their call at all.
	 */
	it("shows a failed tool call's error against its call", () => {
		const drawn = lines(transcript(), [
			assistant(
				[
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { file_path: "src/nope.ts" },
					},
				],
				"toolUse",
			),
			toolResult("call-1", "no such file: src/nope.ts", true),
		]).join("\n");

		expect(drawn).toContain("no such file: src/nope.ts");
	});

	/**
	 * A conversation resumed from a truncated transcript can hold a result whose
	 * call has gone. Drawing it on its own would be a block with no heading.
	 */
	it("drops a result whose call is not in the conversation", () => {
		const drawn = lines(transcript(), [
			toolResult("call-gone", "no such file: src/nope.ts", true),
		]);

		expect(drawn).toEqual([]);
	});

	it("uses the child session's own renderer for a tool", () => {
		const getToolDefinition = vi.fn(
			(_name: string): ToolDefinition | undefined => undefined,
		);

		lines(transcript({ getToolDefinition }), [
			assistant(
				[
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { file_path: "src/queue.ts" },
					},
				],
				"toolUse",
			),
		]);

		expect(getToolDefinition).toHaveBeenCalledWith("read");
	});

	describe("a reply still arriving", () => {
		it("is drawn as it is written", () => {
			const drawn = lines(
				transcript(),
				[user("review src/queue.ts")],
				assistant([{ type: "text", text: "Reading the queue" }], "pending"),
			).join("\n");

			expect(drawn).toContain("review src/queue.ts");
			// After what has already been said, not before it: the reply being
			// written is the newest thing in the conversation.
			expect(drawn.indexOf("Reading the queue")).toBeGreaterThan(
				drawn.indexOf("review src/queue.ts"),
			);
		});

		/**
		 * The partial reply moves into the message list when it completes. Left in
		 * place as well, the finished reply would be drawn twice.
		 */
		it("is drawn once when it completes", () => {
			const subject = transcript();
			const reply = assistant([{ type: "text", text: "No race here." }]);
			lines(subject, [user("review it")], reply);

			const drawn = lines(subject, [user("review it"), reply]).join("\n");

			expect(drawn.match(/No race here\./g)).toHaveLength(1);
		});

		/**
		 * The whole reason the finished messages are cached: a streaming reply
		 * arrives token by token, and rebuilding the transcript for each one would
		 * re-parse every message's markdown.
		 */
		it("does not rebuild the messages already drawn", () => {
			const getToolDefinition = vi.fn(
				(_name: string): ToolDefinition | undefined => undefined,
			);
			const subject = transcript({ getToolDefinition });
			const done = assistant(
				[
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { file_path: "src/queue.ts" },
					},
				],
				"toolUse",
			);
			lines(subject, [done]);
			expect(getToolDefinition).toHaveBeenCalledTimes(1);

			lines(
				subject,
				[done],
				assistant([{ type: "text", text: "stil" }], "pending"),
			);
			lines(
				subject,
				[done],
				assistant([{ type: "text", text: "still" }], "pending"),
			);

			expect(getToolDefinition).toHaveBeenCalledTimes(1);
		});
	});

	it("picks up a message that has since arrived", () => {
		const subject = transcript();
		const first = user("review it");
		lines(subject, [first]);

		const drawn = lines(subject, [
			first,
			assistant([{ type: "text", text: "No race here." }]),
		]).join("\n");

		expect(drawn).toContain("No race here.");
	});
});
