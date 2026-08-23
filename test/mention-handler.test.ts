import type {
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { createMentionHandler, createSpawnTool } from "../src/index.ts";
import { SubagentQueue } from "../src/queue.ts";
import { type SubagentRecord, SubagentRegistry } from "../src/registry.ts";
import type { RunSubagentOptions, SubagentOutcome } from "../src/runner.ts";
import type { SendMessage } from "../src/spawn.ts";
import { startSubagent } from "../src/spawn.ts";

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "explore",
		description: "explores the codebase",
		systemPrompt: "You explore.",
		source: "project",
		filePath: "/tmp/explore.md",
		...overrides,
	};
}

/** A run that hangs, so a subagent stays where the test put it. */
function stubRun() {
	const calls: RunSubagentOptions[] = [];
	const run = vi.fn((opts: RunSubagentOptions) => {
		calls.push(opts);
		return new Promise<SubagentOutcome>(() => {});
	});
	return { run, calls };
}

let registry: SubagentRegistry;
let queue: SubagentQueue;
let run: ReturnType<typeof stubRun>;
let sendMessage: ReturnType<typeof vi.fn>;
let notices: Array<{ text: string; level: string }>;
let agents: AgentConfig[];

beforeEach(() => {
	registry = new SubagentRegistry();
	queue = new SubagentQueue(5);
	run = stubRun();
	sendMessage = vi.fn();
	notices = [];
	agents = [agentConfig()];
});

/**
 * Only what the handler reaches for. `notify` is the whole of its output, so
 * every test reads what it said there.
 */
function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/work",
		hasUI: true,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [], getAll: () => [] },
		signal: undefined,
		ui: {
			notify: (text: string, level = "info") => {
				notices.push({ text, level });
			},
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function handler() {
	return createMentionHandler({
		registry,
		queue,
		sendMessage: sendMessage as unknown as SendMessage,
		discover: () => agents,
		run: run.run,
	});
}

function submit(
	text: string,
	options: { source?: InputEvent["source"]; ctx?: ExtensionContext } = {},
): Promise<InputEventResult> {
	const event: InputEvent = {
		type: "input",
		text,
		source: options.source ?? "interactive",
	};
	return handler()(event, options.ctx ?? context());
}

/** A subagent of the given type, left wherever the caller wants it. */
function spawned(
	changes: Partial<SubagentRecord> = {},
	config = agentConfig(),
): SubagentRecord {
	const record = startSubagent({
		ctx: context(),
		config,
		prompt: "look around",
		description: "look around",
		registry,
		queue,
		sendMessage: sendMessage as unknown as SendMessage,
		run: run.run,
		newId: () => "sub-1",
	});
	if (Object.keys(changes).length > 0) {
		registry.update(record.id, changes);
	}
	return record;
}

/** What the last notice said, for a test that only cares about the words. */
function lastNotice(): string {
	return notices.at(-1)?.text ?? "";
}

describe("the @name handler", () => {
	describe("routing by the subagent's state", () => {
		// The specification's scenario outline, quoted: running.
		it("Routes by the subagent's state: running", async () => {
			const steer = vi.fn(async () => {});
			const record = spawned();
			registry.update(record.id, {
				// biome-ignore lint/suspicious/noExplicitAny: only `steer` is reached.
				session: { steer } as any,
			});

			const result = await submit("@explore look at the auth path");

			// The message is sent into its conversation, and no main-model turn
			// is taken.
			expect(steer).toHaveBeenCalledWith("look at the auth path");
			expect(result).toEqual({ action: "handled" });
		});

		/**
		 * A queued subagent has no session, and its task has not been read yet, so
		 * the message waits with it. Refusing would fail the specification's own
		 * row for a queued subagent.
		 */
		it("Routes by the subagent's state: queued", async () => {
			const record = spawned({ status: "queued", session: undefined });

			const result = await submit("@explore look at the auth path");

			expect(registry.get(record.id)?.pending).toEqual([
				"look at the auth path",
			]);
			expect(result).toEqual({ action: "handled" });
		});

		// The specification's scenario outline, quoted: finished.
		it("Routes by the subagent's state: finished", async () => {
			const record = spawned({
				status: "completed",
				outcome: { status: "completed", output: "nothing odd" },
			});
			run.calls.length = 0;

			const result = await submit("@explore look at the auth path");

			// It resumes from its stored conversation, with the new message as
			// its prompt.
			expect(registry.get(record.id)?.status).not.toBe("completed");
			expect(run.calls[0]?.prompt).toBe("look at the auth path");
			expect(result).toEqual({ action: "handled" });
		});

		// The specification's scenario outline, quoted: never started.
		it("Routes by the subagent's state: never started", async () => {
			const result = await submit("@explore look at the auth path");

			// It starts with that message as its task.
			expect(run.calls[0]?.prompt).toBe("look at the auth path");
			expect(registry.list()).toHaveLength(1);
			expect(result).toEqual({ action: "handled" });
		});

		it("names a subagent it started after the message", async () => {
			await submit("@explore look at the auth path\nand the session path");

			expect(registry.list()[0]?.description).toBe("look at the auth path");
		});

		it("starts a mentioned subagent under its agent file's settings", async () => {
			agents = [agentConfig({ thinking: "high", maxTurns: 3 })];

			await submit("@explore look at the auth path");

			expect(run.calls[0]?.thinkingLevel).toBe("high");
			expect(run.calls[0]?.config.maxTurns).toBe(3);
		});

		it("reaches a numbered handle", async () => {
			spawned({ status: "queued", session: undefined });
			const second = startSubagent({
				ctx: context(),
				config: agentConfig(),
				prompt: "look around",
				description: "look around",
				registry,
				queue,
				sendMessage: sendMessage as unknown as SendMessage,
				run: run.run,
				newId: () => "sub-2",
			});
			registry.update(second.id, { status: "queued", session: undefined });

			await submit("@explore-2 look at the auth path");

			expect(registry.get(second.id)?.pending).toEqual([
				"look at the auth path",
			]);
			expect(registry.get("sub-1")?.pending).toBeUndefined();
		});
	});

	/**
	 * Where a subagent's character came from decides what a continuation runs
	 * under. A file-backed one re-reads its file, so an edit to the frontmatter
	 * takes effect; one given its character at spawn has no file to read, so its
	 * record is the only definition there is.
	 */
	describe("continuing by where the character came from", () => {
		// The specification's scenario, quoted.
		it("Continues under the character it was given", async () => {
			const record = spawned(
				{
					status: "completed",
					outcome: { status: "completed", output: "no findings" },
					sessionFile: __filename,
				},
				agentConfig({
					name: "security",
					source: "inline",
					systemPrompt: "You are a security reviewer.",
					tools: ["read", "grep"],
					filePath: undefined,
				}),
			);
			// Nothing on disk answers to this name, which is the whole point.
			agents = [];
			run.calls.length = 0;

			await submit("@security look at the auth path again");

			expect(run.calls[0]?.config.systemPrompt).toBe(
				"You are a security reviewer.",
			);
			expect(run.calls[0]?.config.tools).toEqual(["read", "grep"]);
			expect(registry.get(record.id)?.status).not.toBe("completed");
			expect(lastNotice()).not.toMatch(/no agent file/i);
		});

		// The specification's scenario, quoted.
		it("Reads the agent file again when there is one", async () => {
			spawned({
				status: "completed",
				outcome: { status: "completed", output: "done" },
				sessionFile: __filename,
			});
			// The file has been edited since the subagent ran.
			agents = [
				agentConfig({
					systemPrompt: "You explore, sceptically.",
					thinking: "high",
				}),
			];
			run.calls.length = 0;

			await submit("@explore look again");

			expect(run.calls[0]?.config.systemPrompt).toBe(
				"You explore, sceptically.",
			);
			expect(run.calls[0]?.thinkingLevel).toBe("high");
		});

		/**
		 * The two halves of the feature, joined.
		 *
		 * Every other test here builds its own record, so each half can be right
		 * while the pair is broken: the spawn tool could stop marking a supplied
		 * character as inline and nothing above would notice. This is the only
		 * test that starts a subagent the way a skill really does and then
		 * reaches it the way a user really does.
		 */
		it("reaches a subagent the spawn tool gave its character", async () => {
			const spawn = createSpawnTool({
				discover: () => agents,
				run: run.run,
				getKnownTools: () => ["read", "grep"],
				registry,
				queue,
				sendMessage: sendMessage as unknown as SendMessage,
				newId: () => "sub-1",
			});
			await spawn.execute(
				"call-1",
				{
					name: "security",
					system_prompt: "You are a security reviewer.",
					tools: ["read", "grep"],
					prompt: "check the auth path",
					description: "security review",
				},
				undefined,
				undefined,
				context(),
			);
			// Finished, so the mention continues it rather than steering it. Nothing
			// on disk is called "security", so only the record can answer.
			registry.update("sub-1", {
				status: "completed",
				outcome: { status: "completed", output: "no findings" },
				sessionFile: __filename,
			});
			run.calls.length = 0;

			await submit("@security and now the session path");

			expect(run.calls[0]?.config.systemPrompt).toBe(
				"You are a security reviewer.",
			);
			expect(run.calls[0]?.config.tools).toEqual(["read", "grep"]);
			expect(lastNotice()).not.toMatch(/no agent file/i);
		});

		/**
		 * The stored definition is not a fallback for a file-backed subagent. Its
		 * file having gone means the agent is gone, and resuming it under the copy
		 * it started with would quietly revive something the user deleted.
		 */
		it("does not fall back to the stored character when a file is expected", async () => {
			spawned({
				status: "completed",
				outcome: { status: "completed", output: "done" },
				sessionFile: __filename,
			});
			agents = [];
			run.calls.length = 0;

			await submit("@explore look again");

			expect(run.calls).toHaveLength(0);
			expect(lastNotice()).toMatch(/no agent file/i);
		});
	});

	describe("text that is not a mention", () => {
		// The specification's scenario, quoted.
		it("Treats a bare handle as ordinary text", async () => {
			spawned();

			expect(await submit("@explore")).toEqual({ action: "continue" });
			expect(run.calls).toHaveLength(1);
		});

		// The specification's scenario, quoted.
		it("Ignores a mention that is not leading", async () => {
			spawned();

			expect(await submit("ask @explore about this")).toEqual({
				action: "continue",
			});
		});

		// The specification's scenario, quoted.
		it("Escapes routing with @main", async () => {
			spawned();

			expect(await submit("@main @explore is just text")).toEqual({
				action: "transform",
				text: "@explore is just text",
			});
		});

		// The specification's scenario, quoted.
		it("Leaves an unknown handle alone", async () => {
			expect(await submit("@nosuch hello")).toEqual({ action: "continue" });
			expect(run.calls).toHaveLength(0);
		});

		it("leaves ordinary text alone", async () => {
			expect(await submit("what is in src/queue.ts?")).toEqual({
				action: "continue",
			});
		});

		/**
		 * An extension composing text has no way to opt out of this routing, and
		 * nothing it sends is a person typing a mention.
		 */
		it("leaves text another extension submitted alone", async () => {
			spawned();

			const result = await submit("@explore look at the auth path", {
				source: "extension",
			});

			expect(result).toEqual({ action: "continue" });
			expect(run.calls).toHaveLength(1);
		});
	});

	describe("when the message cannot be delivered", () => {
		/**
		 * The message is not passed to the main model instead. It was addressed to
		 * a subagent, and a main model answering it would be stranger than being
		 * told it went nowhere.
		 */
		it("says so when the subagent finished between the typing and the send", async () => {
			const record = spawned({
				status: "completed",
				outcome: { status: "completed", output: "done" },
			});
			// A stored conversation that is not there, and an agent file that has
			// gone with it.
			registry.update(record.id, { sessionFile: undefined });
			agents = [];

			const result = await submit("@explore look again");

			expect(result).toEqual({ action: "handled" });
			expect(lastNotice()).toMatch(/no agent file/i);
			expect(notices.at(-1)?.level).toBe("warning");
		});

		it("says so when the session refuses the message", async () => {
			const record = spawned();
			registry.update(record.id, {
				session: {
					steer: async () => {
						throw new Error("its turn ended");
					},
					// biome-ignore lint/suspicious/noExplicitAny: only `steer` is reached.
				} as any,
			});

			await submit("@explore look at the auth path");

			expect(lastNotice()).toMatch(/its turn ended/);
			expect(notices.at(-1)?.level).toBe("warning");
		});

		it("says so when the agent file names a model that does not exist", async () => {
			agents = [agentConfig({ model: "nosuchmodel" })];

			const result = await submit("@explore look at the auth path");

			expect(result).toEqual({ action: "handled" });
			expect(lastNotice()).toMatch(/nosuchmodel/);
			expect(run.calls).toHaveLength(0);
		});

		it("says so when a resumed conversation had to start over", async () => {
			spawned({
				status: "completed",
				outcome: { status: "completed", output: "done" },
				sessionFile: "/tmp/definitely-not-there/session.jsonl",
			});

			await submit("@explore look again");

			expect(lastNotice()).toMatch(/starts fresh/i);
		});
	});

	describe("what it says when the message did get through", () => {
		it("confirms a message sent to a working subagent", async () => {
			const record = spawned();
			registry.update(record.id, {
				// biome-ignore lint/suspicious/noExplicitAny: only `steer` is reached.
				session: { steer: async () => {} } as any,
			});

			await submit("@explore look at the auth path");

			expect(lastNotice()).toMatch(/sent/i);
			expect(notices.at(-1)?.level).toBe("info");
		});

		it("names the subagent it started", async () => {
			await submit("@explore look at the auth path");

			expect(lastNotice()).toContain("explore");
		});

		it("says a finished subagent is being continued", async () => {
			const record = spawned({
				status: "completed",
				outcome: { status: "completed", output: "done" },
			});
			// A transcript that is really there, so this is a continuation rather
			// than a fresh start.
			registry.update(record.id, { sessionFile: __filename });

			await submit("@explore look again");

			expect(lastNotice()).toMatch(/continuing/i);
		});
	});
});
