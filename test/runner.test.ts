import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import {
	inChildContext,
	runInChildContext,
	runSubagent,
	SubagentError,
} from "../src/runner.ts";

/**
 * A stand-in for one assistant reply. Only the fields `runSubagent` reads are
 * present, so these objects are cast into place rather than fully built.
 */
interface FakeAssistantMessage {
	role: "assistant";
	content: Array<{ type: string; text?: string; thinking?: string }>;
	stopReason: string;
	errorMessage?: string;
}

function assistant(
	text: string,
	stopReason = "stop",
	errorMessage?: string,
): FakeAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
}

interface FakeSession {
	messages: unknown[];
	prompt: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

/**
 * Build a session factory that records the options it was handed, so a test can
 * assert on what `runSubagent` asked Pi for without a real model.
 */
function stubFactory(
	options: {
		reply?: unknown[];
		onPrompt?: (session: FakeSession) => Promise<void> | void;
	} = {},
) {
	const calls: CreateAgentSessionOptions[] = [];
	const session: FakeSession = {
		messages: options.reply ?? [assistant("done")],
		prompt: vi.fn(async () => {
			await options.onPrompt?.(session);
		}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(),
	};

	const createSession = vi.fn(
		async (
			opts: CreateAgentSessionOptions,
		): Promise<CreateAgentSessionResult> => {
			calls.push(opts);
			return { session } as unknown as CreateAgentSessionResult;
		},
	);

	return { calls, session, createSession };
}

const PARENT_MODEL = { id: "parent-model" };

/**
 * Somewhere disposable for subagent transcripts to land.
 *
 * Every test that lets the runner build a session manager must pass one of
 * these as `sessionDir`. Without it pi computes its own default and the test
 * writes into the user's real `~/.pi/agent/sessions`.
 */
function tempSessionDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-sessions-"));
}

/** A parent whose session file is at `file`, or which has none (in-memory). */
function parentSessionManager(file?: string) {
	return { getSessionFile: () => file };
}

function fakeContext(
	overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
	return {
		cwd: process.cwd(),
		model: PARENT_MODEL,
		thinkingLevel: "high",
		// Pi types this non-optional, and the runner reads it to nest a subagent
		// under whoever spawned it.
		sessionManager: parentSessionManager("/tmp/parent-session.jsonl"),
		...overrides,
	} as unknown as ExtensionContext;
}

let config: AgentConfig;
let sessionDir: string;

beforeEach(() => {
	config = {
		name: "reviewer",
		description: "reviews code",
		systemPrompt: "You review code carefully.",
		source: "project",
		filePath: "/tmp/reviewer.md",
	};
	sessionDir = tempSessionDir();
});

/**
 * `runSubagent` with somewhere harmless to write.
 *
 * Every run now builds a persistent session manager, and one with no
 * `sessionDir` creates — and `mkdirSync`s — the user's real session directory.
 * Going through here keeps the whole suite out of `~/.pi`. A test that cares
 * about the directory passes its own and this leaves it alone.
 */
function run(options: Parameters<typeof runSubagent>[0]) {
	return runSubagent({ sessionDir, ...options });
}

describe("runSubagent", () => {
	// The plan's acceptance criterion for Task 1.4, quoted.
	it("given the parent runs model M at effort E, starts a subagent with neither specified using M and E", async () => {
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.model).toBe(PARENT_MODEL);
		expect(stub.calls[0]?.thinkingLevel).toBe("high");
	});

	it("prefers an explicit model and effort over the parent's", async () => {
		const stub = stubFactory();
		const ownModel = { id: "own-model" } as never;

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			model: ownModel,
			thinkingLevel: "low",
			createSession: stub.createSession,
		});

		expect(stub.calls[0]?.model).toBe(ownModel);
		expect(stub.calls[0]?.thinkingLevel).toBe("low");
	});

	it("returns the last assistant message as the output", async () => {
		const stub = stubFactory({
			reply: [assistant("first answer"), assistant("final answer")],
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("completed");
		expect(outcome.output).toBe("final answer");
		expect(outcome.error).toBeUndefined();
	});

	it("keeps only text blocks out of a reply, dropping thinking and tool calls", async () => {
		const stub = stubFactory({
			reply: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden reasoning" },
						{ type: "text", text: "visible answer" },
						{ type: "toolCall", text: "should not appear" },
					],
					stopReason: "stop",
				},
			],
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.output).toBe("visible answer");
	});

	it("reports a reply that stopped with an error as failed", async () => {
		const stub = stubFactory({
			reply: [assistant("partial", "error", "the provider refused")],
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("failed");
		// Every outcome error names its agent, whatever the cause, so a caller
		// can report it verbatim without prefixing.
		expect(outcome.error).toContain("the provider refused");
		expect(outcome.error).toContain("reviewer");
	});

	it("reports an aborted reply as stopped", async () => {
		const stub = stubFactory({
			reply: [assistant("half an answer", "aborted")],
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("stopped");
		expect(outcome.output).toBe("half an answer");
	});

	it("reports a run that produced no assistant reply as failed", async () => {
		const stub = stubFactory({ reply: [] });

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.output).toBe("");
		expect(outcome.error).toMatch(/reply/i);
	});

	it("passes the agent's own tool allowlist to the child session", async () => {
		const stub = stubFactory();
		config.tools = ["read", "grep"];

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(stub.calls[0]?.tools).toEqual(["read", "grep"]);
	});

	it("gives the child a loader whose system prompt is the agent's own", async () => {
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		const loader = stub.calls[0]?.resourceLoader;
		expect(loader?.getSystemPrompt()).toBe("You review code carefully.");
		// A subagent must not inherit the parent's appended project context.
		expect(loader?.getAppendSystemPrompt()).toEqual([]);
	});

	/**
	 * Slice 7 replaced the in-memory session this test used to assert on. The
	 * requirement it was protecting has not changed — a subagent must not write
	 * over the parent's transcript — but it is now met by giving the child a file
	 * of its own rather than by giving it no file at all.
	 */
	it("keeps the child's transcript in a file of its own, not the parent's", async () => {
		const stub = stubFactory();
		const sessionDir = tempSessionDir();

		await run({
			ctx: fakeContext({
				sessionManager: parentSessionManager(
					"/tmp/parent-session.jsonl",
				) as unknown as ExtensionContext["sessionManager"],
			}),
			config,
			prompt: "review this",
			sessionDir,
			createSession: stub.createSession,
		});

		const manager = stub.calls[0]?.sessionManager;
		expect(manager).toBeInstanceOf(SessionManager);
		expect(manager?.isPersisted()).toBe(true);
		expect(manager?.getSessionFile()).not.toBe("/tmp/parent-session.jsonl");
		expect(manager?.getSessionFile()).toContain(sessionDir);
	});

	// `parentSession` is what nests a subagent under its spawner in pi's own
	// /resume picker, rather than leaving it loose among real sessions.
	it("nests the child under the session that spawned it", async () => {
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			sessionDir: tempSessionDir(),
			createSession: stub.createSession,
		});

		expect(stub.calls[0]?.sessionManager?.getHeader()?.parentSession).toBe(
			"/tmp/parent-session.jsonl",
		);
	});

	// A parent running in memory has no file to be nested under, and naming it
	// as a parent anyway would write a dangling path into the child's header.
	it("names no parent when the spawning session has no file", async () => {
		const stub = stubFactory();

		await run({
			ctx: fakeContext({
				sessionManager:
					parentSessionManager() as unknown as ExtensionContext["sessionManager"],
			}),
			config,
			prompt: "review this",
			sessionDir: tempSessionDir(),
			createSession: stub.createSession,
		});

		expect(
			stub.calls[0]?.sessionManager?.getHeader()?.parentSession,
		).toBeUndefined();
	});

	it("disposes the child session once the run finishes", async () => {
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(stub.session.dispose).toHaveBeenCalledOnce();
	});

	it("disposes the child session even when the prompt throws", async () => {
		const stub = stubFactory();
		stub.session.prompt.mockRejectedValueOnce(new Error("model exploded"));

		// Task 1.5 requires this to be contained rather than rethrown.
		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("failed");
		expect(stub.session.dispose).toHaveBeenCalledOnce();
	});

	it("aborts the child session when the caller's signal fires mid-run", async () => {
		const controller = new AbortController();
		const stub = stubFactory({
			reply: [assistant("interrupted", "aborted")],
			onPrompt: () => {
				controller.abort();
			},
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			signal: controller.signal,
			createSession: stub.createSession,
		});

		expect(stub.session.abort).toHaveBeenCalledOnce();
		expect(outcome.status).toBe("stopped");
	});

	it("does not start a session at all when the signal is already aborted", async () => {
		const stub = stubFactory();

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			signal: AbortSignal.abort(),
			createSession: stub.createSession,
		});

		expect(stub.createSession).not.toHaveBeenCalled();
		expect(outcome.status).toBe("stopped");
	});
});

/**
 * Containment. Subagents share the host process, so an error that escapes
 * `runSubagent` is the user's own session going down. Every one of these
 * asserts that nothing propagates.
 */
describe("runSubagent failure containment", () => {
	// The plan's acceptance criterion for Task 1.5, quoted.
	it("given a session factory that throws, reports failed with the error message and propagates nothing", async () => {
		const createSession = vi.fn(async () => {
			throw new Error("no model configured");
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession,
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("no model configured");
		expect(outcome.output).toBe("");
	});

	it("names the agent in the failure so one bad agent is identifiable", async () => {
		const createSession = vi.fn(async () => {
			throw new Error("boom");
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession,
		});

		expect(outcome.error).toContain("reviewer");
	});

	it("contains a thrown value that is not an Error at all", async () => {
		const createSession = vi.fn(async () => {
			// Nothing stops a dependency throwing a string or undefined.
			throw "just a string";
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession,
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("just a string");
	});

	it("contains a dispose that throws, without losing the run's outcome", async () => {
		const stub = stubFactory({ reply: [assistant("the answer")] });
		stub.session.dispose.mockImplementation(() => {
			throw new Error("dispose exploded");
		});

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		// The run succeeded; a broken teardown must not turn it into a failure.
		expect(outcome.status).toBe("completed");
		expect(outcome.output).toBe("the answer");
	});

	it("observes the rejection of an abort instead of dropping the promise", async () => {
		// `abort()` is called from an event listener, so a rejection it leaves
		// unobserved has nowhere to surface but the process. Watching for
		// `unhandledRejection` cannot prove this — the test runner installs its
		// own handler — so `abort()` returns a thenable that records whether the
		// caller supplied a rejection callback at all. Dropping the promise never
		// calls `then`; awaiting or catching it does.
		let rejectionObserved = false;
		const recordingThenable = {
			// biome-ignore lint/suspicious/noThenProperty: a deliberate thenable — being treated as a promise is the whole point of the probe
			then(_onFulfilled?: unknown, onRejected?: unknown) {
				if (typeof onRejected === "function") {
					rejectionObserved = true;
				}
				return Promise.resolve();
			},
		};

		const controller = new AbortController();
		const stub = stubFactory({
			reply: [assistant("interrupted", "aborted")],
			onPrompt: () => {
				controller.abort();
			},
		});
		stub.session.abort.mockReturnValue(recordingThenable);

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			signal: controller.signal,
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("stopped");
		expect(rejectionObserved).toBe(true);
	});
});

/**
 * The recursion guard. A subagent that could spawn subagents would fork the
 * host process without bound, so the flag must be set for everything a child
 * does and clear for everything else.
 */
describe("child context", () => {
	it("is not a child context by default", () => {
		expect(inChildContext()).toBe(false);
	});

	it("is a child context inside a wrapped run", async () => {
		const seen = await runInChildContext(async () => inChildContext());

		expect(seen).toBe(true);
	});

	it("stays set across an await inside a wrapped run", async () => {
		const seen = await runInChildContext(async () => {
			await new Promise((resolve) => setImmediate(resolve));
			return inChildContext();
		});

		expect(seen).toBe(true);
	});

	it("is clear again once the wrapped run finishes", async () => {
		await runInChildContext(async () => undefined);

		expect(inChildContext()).toBe(false);
	});

	it("is clear again even when the wrapped run throws", async () => {
		await expect(
			runInChildContext(async () => {
				throw new Error("child blew up");
			}),
		).rejects.toThrow("child blew up");

		expect(inChildContext()).toBe(false);
	});

	it("does not leak into work running concurrently beside it", async () => {
		// Slice 3 runs several subagents at once. A sibling operation that is not
		// itself a child must not inherit the flag from one that is.
		//
		// The child is held mid-flight on a gate so the sibling reads the flag
		// while the child is genuinely still running. Without the gate, the child
		// finishes and clears the flag before the sibling looks, and a plain
		// module-level boolean would pass this test despite leaking.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const childRun = runInChildContext(async () => {
			await gate;
			return inChildContext();
		});

		const siblingSaw = inChildContext();
		release();

		expect(await childRun).toBe(true);
		expect(siblingSaw).toBe(false);
	});
});

describe("runSubagent recursion guard", () => {
	it("runs the child session inside a child context", async () => {
		let duringPrompt: boolean | undefined;
		let duringFactory: boolean | undefined;
		const stub = stubFactory({
			onPrompt: () => {
				duringPrompt = inChildContext();
			},
		});
		const createSession = vi.fn(async (opts) => {
			duringFactory = inChildContext();
			return stub.createSession(opts);
		});

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession,
		});

		expect(duringFactory).toBe(true);
		expect(duringPrompt).toBe(true);
	});

	it("leaves the parent out of the child context once the run is over", async () => {
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(inChildContext()).toBe(false);
	});
});

describe("runSubagent session handover", () => {
	// Nothing outside the runner can otherwise reach the child's session: the
	// runner builds it, prompts it and disposes it. Context tracking and, later,
	// steering both need a reference to it.
	it("hands the child's session to the caller", async () => {
		const stub = stubFactory();
		const seen: unknown[] = [];

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
			onSession: (session) => seen.push(session),
		});

		expect(seen).toEqual([stub.session]);
	});

	// Tracking must be listening before the first turn, or it misses it.
	it("hands it over before the session is prompted", async () => {
		const order: string[] = [];
		const stub = stubFactory({
			onPrompt: () => {
				order.push("prompt");
			},
		});

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
			onSession: () => order.push("onSession"),
		});

		expect(order).toEqual(["onSession", "prompt"]);
	});

	// It runs inside the crash guard, so a caller that throws here costs the
	// run rather than the host session.
	it("contains a handover that throws", async () => {
		const stub = stubFactory();

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
			onSession: () => {
				throw new Error("tracking blew up");
			},
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("tracking blew up");
	});

	it("says nothing when the caller does not ask for the session", async () => {
		const stub = stubFactory();

		const outcome = await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			createSession: stub.createSession,
		});

		expect(outcome.status).toBe("completed");
	});

	// The record needs the path to be able to reopen the conversation later, and
	// only the runner knows it — it builds the session manager.
	it("hands over the file the child's transcript is being written to", async () => {
		const stub = stubFactory();
		const sessionDir = tempSessionDir();
		const seen: Array<string | undefined> = [];

		await run({
			ctx: fakeContext(),
			config,
			prompt: "review this",
			sessionDir,
			createSession: stub.createSession,
			onSession: (_session, sessionFile) => seen.push(sessionFile),
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(stub.calls[0]?.sessionManager?.getSessionFile());
		expect(seen[0]).toContain(sessionDir);
	});
});

describe("runSubagent resuming a stored conversation", () => {
	/**
	 * A session file on disk with one exchange already in it.
	 *
	 * The assistant reply is not decoration. Pi withholds the file until an
	 * assistant message exists — `_persist` returns early and only marks the
	 * session unflushed — so a user message alone leaves nothing on disk and
	 * `existsSync` would be false.
	 */
	function storedConversation(dir: string) {
		const earlier = SessionManager.create(process.cwd(), dir);
		earlier.appendMessage({
			role: "user",
			content: "what does agents.ts do?",
			timestamp: Date.now(),
		});
		earlier.appendMessage(
			assistant("it discovers agent files") as unknown as Parameters<
				typeof earlier.appendMessage
			>[0],
		);
		const file = earlier.getSessionFile();
		if (!file) throw new Error("the stored session was not given a file");
		if (!existsSync(file)) {
			throw new Error(`the stored session was never written: ${file}`);
		}
		return file;
	}

	// The specification's scenario, quoted: it continues its earlier
	// conversation, and its earlier turns are still in its context.
	it("Continues a stored conversation", async () => {
		const sessionDir = tempSessionDir();
		const file = storedConversation(sessionDir);
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "and what about runner.ts?",
			sessionDir,
			resumeFrom: file,
			createSession: stub.createSession,
		});

		const manager = stub.calls[0]?.sessionManager;
		expect(manager?.getSessionFile()).toBe(file);
		expect(JSON.stringify(manager?.getEntries())).toContain(
			"what does agents.ts do?",
		);
	});

	it("appends to the stored file rather than starting a second one", async () => {
		const sessionDir = tempSessionDir();
		const file = storedConversation(sessionDir);
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "and now?",
			sessionDir,
			resumeFrom: file,
			createSession: stub.createSession,
		});

		expect(readdirSync(sessionDir)).toHaveLength(1);
	});

	/**
	 * `SessionManager.open` does not object to a path that is not there — it
	 * quietly starts an empty session at it. A resume pointed at a transcript the
	 * user has since deleted would therefore look like it had continued something
	 * when it had not, so the runner refuses to reopen a file that is gone and
	 * starts a fresh session instead.
	 */
	it("starts a new session when the stored conversation is gone", async () => {
		const sessionDir = tempSessionDir();
		const missing = join(sessionDir, "deleted-since.jsonl");
		const stub = stubFactory();

		await run({
			ctx: fakeContext(),
			config,
			prompt: "carry on",
			sessionDir,
			resumeFrom: missing,
			createSession: stub.createSession,
		});

		const manager = stub.calls[0]?.sessionManager;
		expect(manager?.getSessionFile()).not.toBe(missing);
		expect(manager?.isPersisted()).toBe(true);
	});
});

describe("SubagentError", () => {
	it("records which agent failed and keeps the original cause", () => {
		const cause = new Error("underlying");
		const error = new SubagentError("reviewer", cause);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("SubagentError");
		expect(error.agentName).toBe("reviewer");
		expect(error.cause).toBe(cause);
		expect(error.message).toContain("reviewer");
		expect(error.message).toContain("underlying");
	});
});
