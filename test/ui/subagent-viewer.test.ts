import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlResult } from "../../src/control.ts";
import { type SubagentRecord, SubagentRegistry } from "../../src/registry.ts";
import { SubagentViewer } from "../../src/ui/subagent-viewer.ts";

/** Pi's message components read the global theme; see `transcript.test.ts`. */
beforeAll(() => {
	initTheme("dark");
});

const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";

const WIDTH = 60;
/** Tall enough that nothing is cut off unless a test asks for a short view. */
const ROWS = 40;

/**
 * A theme that colours nothing, so an assertion about what the view says is not
 * also an assertion about the palette. Pi's own components inside the transcript
 * still colour their own output, which every assertion strips.
 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const fakeTui = { requestRender: () => {} } as unknown as TUI;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: 2,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

/**
 * A stand-in for the child's session: the messages it holds, whatever reply is
 * still arriving, and the listeners watching it.
 */
class FakeSession {
	messages: AgentMessage[] = [];
	streaming: AgentMessage | undefined;
	readonly listeners = new Set<() => void>();

	get state() {
		return { streamingMessage: this.streaming };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getToolDefinition(): undefined {
		return undefined;
	}

	/** What pi does when the conversation moves on. */
	emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	asSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}

let registry: SubagentRegistry;
let session: FakeSession;
let closed: number;
let renders: number;

beforeEach(() => {
	registry = new SubagentRegistry(() => 1_000);
	session = new FakeSession();
	closed = 0;
	renders = 0;
});

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	const added: SubagentRecord = {
		id: "abc123",
		handle: "reviewer",
		type: "reviewer",
		config: {
			name: "reviewer",
			description: "reviews code for defects",
			systemPrompt: "You review code.",
			source: "project",
		},
		description: "review the queue",
		status: "running",
		color: "cyan",
		startedAt: 1_000,
		contextPercent: 12,
		turns: 0,
		session: session.asSession(),
		...overrides,
	};
	registry.add(added);
	return added;
}

function viewer(
	options: {
		record?: SubagentRecord;
		steer?: (r: SubagentRecord, message: string) => Promise<ControlResult>;
		stop?: ((r: SubagentRecord) => Promise<ControlResult>) | undefined;
		rows?: number;
		withStop?: boolean;
	} = {},
): SubagentViewer {
	return new SubagentViewer({
		record: options.record ?? record(),
		registry,
		theme: plainTheme,
		tui: fakeTui,
		cwd: "/work",
		close: () => {
			closed++;
		},
		steer: options.steer ?? (async () => ({ ok: true })),
		stop:
			options.withStop === false
				? undefined
				: (options.stop ?? (async () => ({ ok: true }))),
		rows: () => options.rows ?? ROWS,
		requestRender: () => {
			renders++;
		},
	});
}

/** Rendered lines with every escape sequence removed. */
function plain(subject: SubagentViewer, width = WIDTH): string[] {
	return subject.render(width).map(stripTerminalSequences);
}

function text(subject: SubagentViewer, width = WIDTH): string {
	return plain(subject, width).join("\n");
}

/** Type a message into an open composer. */
function type(subject: SubagentViewer, message: string): void {
	for (const character of message) {
		subject.handleInput(character);
	}
}

/** Let the promise a key press started settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("SubagentViewer", () => {
	describe("the open conversation", () => {
		// The specification's scenario, quoted.
		it("Opens a subagent", () => {
			session.messages = [user("review the queue"), assistant("No race here.")];

			const drawn = text(viewer());

			// That subagent's conversation is shown.
			expect(drawn).toContain("review the queue");
			expect(drawn).toContain("No race here.");
		});

		it("names the subagent and how much context it has used", () => {
			const drawn = plain(viewer())[0] ?? "";

			expect(drawn).toContain("reviewer");
			expect(drawn).toContain("review the queue");
			expect(drawn).toContain("12%");
		});

		it("shows a reply as it arrives", () => {
			session.streaming = assistant("Reading the queue");

			expect(text(viewer())).toContain("Reading the queue");
		});

		/** "And it updates as the subagent works". */
		it("follows the conversation as the subagent works", () => {
			const subject = viewer();
			expect(text(subject)).not.toContain("No race here.");

			session.messages = [assistant("No race here.")];
			session.emit();

			expect(renders).toBeGreaterThan(0);
			expect(text(subject)).toContain("No race here.");
		});

		it("redraws when the subagent's status changes", () => {
			const open = record();
			viewer({ record: open });
			renders = 0;

			registry.update(open.id, { status: "completed" });

			expect(renders).toBeGreaterThan(0);
		});

		/**
		 * A subagent past the concurrency limit has no session to read, and a blank
		 * panel would look like a subagent that had gone quiet.
		 */
		it("says a queued subagent has not started", () => {
			const queued = record({ status: "queued", session: undefined });

			expect(text(viewer({ record: queued }))).toContain("Waiting for a free");
		});

		/**
		 * The session a queued subagent gets has to be listened to as well as
		 * read. Reading it is enough to draw what is there now — only the
		 * subscription keeps the view following what comes next.
		 */
		it("picks up and follows the session a queued subagent is given", () => {
			const queued = record({ status: "queued", session: undefined });
			const subject = viewer({ record: queued });

			session.messages = [assistant("Starting on it.")];
			registry.update(queued.id, {
				status: "running",
				session: session.asSession(),
			});
			expect(text(subject)).toContain("Starting on it.");

			renders = 0;
			session.emit();

			expect(renders).toBeGreaterThan(0);
		});

		it("says so when a running subagent has said nothing yet", () => {
			expect(text(viewer())).toContain("Nothing said yet.");
		});

		/**
		 * The view follows a working subagent, so the newest lines are the ones
		 * worth the room. Anything older is in the transcript on disk.
		 */
		it("shows the end of a long conversation, not the start", () => {
			session.messages = Array.from({ length: 30 }, (_, i) =>
				assistant(`reply number ${i}`),
			);

			const drawn = text(viewer({ rows: 12 }));

			expect(drawn).toContain("reply number 29");
			expect(drawn).not.toContain("reply number 0");
		});

		it("keeps within the rows it was given", () => {
			session.messages = Array.from({ length: 30 }, (_, i) =>
				assistant(`reply number ${i}`),
			);

			expect(plain(viewer({ rows: 12 })).length).toBeLessThanOrEqual(12);
		});
	});

	describe("closing", () => {
		it("closes on escape", () => {
			viewer().handleInput(ESC);

			expect(closed).toBe(1);
		});

		it("stays open on any other key", () => {
			const subject = viewer();

			subject.handleInput(UP);

			expect(closed).toBe(0);
		});

		// The specification's scenario, quoted.
		it("Stays open when the subagent finishes", () => {
			const open = record();
			const subject = viewer({ record: open });
			session.messages = [user("review the queue")];

			session.messages.push(assistant("No race here."));
			registry.update(open.id, { status: "completed" });
			session.emit();

			// Its conversation is still shown, and its final output is visible.
			expect(closed).toBe(0);
			expect(text(subject)).toContain("No race here.");
		});

		it("lets go of the session and the registry when it closes", () => {
			const subject = viewer();
			subject.dispose();
			renders = 0;

			session.emit();
			registry.update("abc123", { status: "completed" });

			expect(renders).toBe(0);
			expect(session.listeners.size).toBe(0);
		});
	});

	describe("steering", () => {
		// The specification's scenario, quoted.
		it("Steers from the open view", async () => {
			const steer = vi.fn(
				async (_record: SubagentRecord, _message: string) =>
					({ ok: true }) as ControlResult,
			);
			const subject = viewer({ steer });

			subject.handleInput(ENTER);
			type(subject, "check the tests too");
			subject.handleInput(ENTER);
			await settle();

			// The message is sent into that subagent's conversation.
			expect(steer).toHaveBeenCalledTimes(1);
			expect(steer.mock.calls[0]?.[1]).toBe("check the tests too");
		});

		it("opens a composer on enter", () => {
			const subject = viewer();

			subject.handleInput(ENTER);
			type(subject, "hello");

			expect(text(subject)).toContain("> hello");
		});

		/** The composer takes escape, so the only way out has to be on screen. */
		it("says how to send and how to abandon while composing", () => {
			const subject = viewer();

			subject.handleInput(ENTER);

			expect(text(subject)).toContain("esc abandons");
		});

		it("closes the composer once the message is sent", async () => {
			const subject = viewer();

			subject.handleInput(ENTER);
			type(subject, "hello");
			subject.handleInput(ENTER);
			await settle();

			expect(text(subject)).not.toContain("> hello");
			expect(text(subject)).toContain("Sent.");
		});

		it("sends nothing when the message is empty", async () => {
			const steer = vi.fn(async () => ({ ok: true }) as ControlResult);
			const subject = viewer({ steer });

			subject.handleInput(ENTER);
			subject.handleInput(ENTER);
			await settle();

			expect(steer).not.toHaveBeenCalled();
			expect(text(subject)).toContain("enter steer");
		});

		/** Whitespace is not a message, and a subagent must not be sent one. */
		it("sends nothing when the message is only spaces", async () => {
			const steer = vi.fn(async () => ({ ok: true }) as ControlResult);
			const subject = viewer({ steer });

			subject.handleInput(ENTER);
			type(subject, "   ");
			subject.handleInput(ENTER);
			await settle();

			expect(steer).not.toHaveBeenCalled();
		});

		/**
		 * Escape belongs to the composer while one is open. Closing the whole view
		 * would throw away a half-typed message along with the view.
		 */
		it("abandons the message on escape, keeping the view open", async () => {
			const steer = vi.fn(async () => ({ ok: true }) as ControlResult);
			const subject = viewer({ steer });

			subject.handleInput(ENTER);
			type(subject, "never mind");
			subject.handleInput(ESC);
			await settle();

			expect(steer).not.toHaveBeenCalled();
			expect(closed).toBe(0);
			expect(text(subject)).not.toContain("never mind");
		});

		it("reports a refused message rather than losing it silently", async () => {
			const subject = viewer({
				steer: async () => ({ ok: false, reason: "it has already finished" }),
			});

			subject.handleInput(ENTER);
			type(subject, "one more thing");
			subject.handleInput(ENTER);
			await settle();

			expect(text(subject)).toContain("it has already finished");
		});

		/**
		 * Refused before the composer opens, not after it is submitted: nobody
		 * should type a message for a subagent that has already finished.
		 */
		it("will not open a composer for a subagent that has finished", () => {
			const done = record({ status: "completed" });
			const subject = viewer({ record: done });

			subject.handleInput(ENTER);
			type(subject, "hello");

			expect(text(subject)).not.toContain("> hello");
			expect(text(subject)).toContain("cannot be steered");
		});

		it("offers no steering for a subagent that has finished", () => {
			const done = record({ status: "completed" });

			const drawn = text(viewer({ record: done }));

			expect(drawn).toContain("esc close");
			expect(drawn).not.toContain("enter steer");
		});
	});

	describe("stopping", () => {
		it("stops the subagent on delete", async () => {
			const stop = vi.fn(async () => ({ ok: true }) as ControlResult);
			const open = record();
			const subject = viewer({ record: open, stop });

			subject.handleInput(DELETE);
			await settle();

			expect(stop).toHaveBeenCalledWith(open);
			expect(text(subject)).toContain("Stopped.");
		});

		it("reports a stop that was refused", async () => {
			const subject = viewer({
				stop: async () => ({ ok: false, reason: "it has already finished" }),
			});

			subject.handleInput(DELETE);
			await settle();

			expect(text(subject)).toContain("it has already finished");
		});

		/** Delete edits the message while a composer is open, and nothing else. */
		it("does not stop the subagent while a message is being typed", async () => {
			const stop = vi.fn(async () => ({ ok: true }) as ControlResult);
			const subject = viewer({ stop });

			subject.handleInput(ENTER);
			type(subject, "hello");
			subject.handleInput(DELETE);
			await settle();

			expect(stop).not.toHaveBeenCalled();
		});
	});
});
