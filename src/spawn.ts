/**
 * Starting a subagent, continuing one, and announcing it when it ends.
 *
 * Spawning is not a question the caller waits for an answer to. The tool hands
 * back an id straight away and the subagent works on in the background; when it
 * finishes, its answer is delivered into the conversation as a follow-up so the
 * main model reads it as news rather than as a tool result it asked for.
 *
 * Everything after the initial return therefore happens with nobody waiting on
 * it. There is no caller to catch for, so nothing in here may throw.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { assignColor } from "./colors.ts";
import {
	type ControlDeps,
	type ControlResult,
	stopSubagent,
} from "./control.ts";
import { assignHandle } from "./mention.ts";
import type { SubagentQueue } from "./queue.ts";
import {
	type SubagentRecord,
	type SubagentRegistry,
	type SubagentStatus,
	trackContextUsage,
} from "./registry.ts";
import {
	type RunSubagentOptions,
	runSubagent,
	type SubagentOutcome,
} from "./runner.ts";
import { DEFAULT_MAX_TURNS, type TurnLimit, watchTurns } from "./turns.ts";
import { STATUS_COLOR, STATUS_MARK } from "./ui/status.ts";

/** Marks the completion notice, for the renderer and for anything filtering. */
export const COMPLETE_MESSAGE_TYPE = "subagent-complete";

/** What travels with a completion notice, for the UI rather than the model. */
export interface SubagentCompleteDetails {
	id: string;
	handle: string;
	agent: string;
	status: SubagentStatus;
	description: string;
	contextPercent: number | null;
}

/**
 * How a notice reaches the conversation.
 *
 * Typed off `ExtensionAPI` rather than restated, so a change to pi's signature
 * shows up here as a type error instead of a silently wrong call. Only `pi` has
 * this — the `ctx` handed to a tool's `execute` does not.
 */
export type SendMessage = ExtensionAPI["sendMessage"];

/** How a subagent is actually run. Injected so tests need no model. */
export type RunSubagentFn = (
	opts: RunSubagentOptions,
) => Promise<SubagentOutcome>;

/** What starting a subagent and continuing one both need. */
export interface SubagentRunOptions {
	ctx: ExtensionContext;
	config: AgentConfig;
	prompt: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	registry: SubagentRegistry;
	/** Hands out the slots. Past the limit a subagent waits its turn. */
	queue: SubagentQueue;
	sendMessage: SendMessage;
	run?: RunSubagentFn;
	/** Where transcripts are written. Omitted means pi's own default. */
	sessionDir?: string;
}

export interface StartSubagentOptions extends SubagentRunOptions {
	/** The caller's few words about the task, shown in the list. */
	description: string;
	/** Seams for a deterministic test. */
	newId?: () => string;
	now?: () => number;
}

export interface ResumeSubagentOptions extends SubagentRunOptions {
	/**
	 * The finished subagent to continue. Its record is reused rather than
	 * replaced, so the list shows one subagent picking its work back up.
	 *
	 * `config` is the caller's freshly resolved definition, which is what makes a
	 * continuation run under the agent type's current frontmatter rather than the
	 * one in force when it first ran.
	 */
	record: SubagentRecord;
}

/** Either the continuation is under way, or here is why it is not. */
export type ResumeResult =
	| {
			ok: true;
			record: SubagentRecord;
			/**
			 * True when the stored transcript was gone and this is starting over
			 * rather than continuing. The caller is expected to say so.
			 */
			startedFresh: boolean;
	  }
	| { ok: false; reason: string };

/**
 * The notice the main model reads when a subagent finishes.
 *
 * Named by type *and* id. Two subagents of the same type can be running at
 * once, and until Slice 11 hands out distinct handles the id is the only thing
 * telling their notices apart — it is also what `get_subagent_result` wants.
 */
export function describeCompletion(
	record: SubagentRecord,
	outcome: SubagentOutcome,
): string {
	const name = `Subagent "${record.type}" (${record.id})`;
	const parts: string[] = [];

	if (outcome.status === "failed") {
		// Headlined by id alone, and the reason reported verbatim. An outcome's
		// `error` already names its agent, so naming it here too reads as
		// 'Subagent "reviewer" failed. subagent "reviewer" failed: ...' — the
		// doubling that commit d78fb0d removed from the old synchronous result.
		parts.push(`Subagent ${record.id} failed.`);
		parts.push(outcome.error ?? `Subagent "${record.type}" gave no reason.`);
	} else if (outcome.status === "stopped") {
		// Saying why, and saying plainly that the answer is partial. A bare
		// "stopped" leaves the main model to read a truncated answer as a final
		// one, which is the whole point of marking a run incomplete.
		const why = record.stoppedBecause
			? ` because ${record.stoppedBecause}`
			: "";
		parts.push(`${name} was stopped${why}. Its answer, if any, is incomplete.`);
	} else {
		parts.push(`${name} finished.`);
	}

	if (outcome.output) {
		parts.push(outcome.output);
	} else if (outcome.status === "completed") {
		parts.push("It finished without saying anything.");
	}

	return parts.join("\n\n");
}

/**
 * The turn limit for this agent — its own, or the default.
 *
 * Every subagent gets one. An agent file naming no `maxTurns:` would otherwise
 * have no runaway protection whatsoever, which is the case the protection
 * exists for; the warn-then-stop shape means a subagent that is simply taking
 * its time still gets to answer rather than being cut off.
 */
function turnLimit(config: AgentConfig): TurnLimit {
	return { maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS };
}

/**
 * Put a subagent's outcome into the conversation.
 *
 * Delivered as a follow-up rather than as a tool result, so the main model reads
 * it as news that arrived while it was working on something else — which is what
 * it is. `triggerTurn` is what makes it act on the news rather than sit on it
 * until the user next says something.
 */
function announce(
	record: SubagentRecord,
	outcome: SubagentOutcome,
	sendMessage: SendMessage,
): void {
	sendMessage(
		{
			customType: COMPLETE_MESSAGE_TYPE,
			content: describeCompletion(record, outcome),
			display: true,
			details: {
				id: record.id,
				handle: record.handle,
				agent: record.type,
				status: record.status,
				description: record.description,
				contextPercent: record.contextPercent,
			} satisfies SubagentCompleteDetails,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

/**
 * Halt a subagent on the user's behalf, and say so if nobody else will.
 *
 * Stopping through the tool needs no notice: the model is holding the tool call
 * and reads the outcome in its result. Stopping from the list or the open view
 * has no such result, and the model was told at spawn that "its result will
 * arrive here when it is done" — so without a notice it waits for an answer that
 * is never coming.
 *
 * Only a subagent that never started is announced here. A running one settles
 * into a stopped outcome of its own, and `runAndAnnounce` reports that; saying
 * it twice would have the model reading the same stop as two.
 */
export async function stopFromUi(
	record: SubagentRecord,
	deps: ControlDeps,
	sendMessage: SendMessage,
): Promise<ControlResult> {
	const neverStarted = record.status === "queued";
	const result = await stopSubagent(record, deps);
	if (!result.ok || !neverStarted) {
		return result;
	}

	// Read off the record rather than assumed: `stopSubagent` puts an empty
	// stopped outcome on a queued subagent, and that is what the notice is about.
	announce(
		record,
		record.outcome ?? { status: "stopped", output: "" },
		sendMessage,
	);
	return result;
}

/**
 * The task this run should actually start on: the prompt it was given, plus
 * anything said to it while it waited for a slot.
 *
 * Joined with a blank line so the addition reads as its own paragraph rather
 * than running into the end of the original task. Separate messages would be
 * truer to what the user typed, but a run is prompted once, and a message that
 * has to wait for the first turn to be delivered would be read after the work
 * it was meant to change.
 */
function takePending(
	record: SubagentRecord,
	registry: SubagentRegistry,
	prompt: string,
): string {
	const pending = record.pending;
	if (!pending?.length) {
		return prompt;
	}

	registry.update(record.id, { pending: undefined });
	return [prompt, ...pending].join("\n\n");
}

/**
 * Run the subagent and tell the conversation how it went.
 *
 * Runs detached, with nobody awaiting it, so every failure is contained here:
 * `runSubagent` already turns a crashing child into a failed outcome, and the
 * `catch` covers the rest — a registry that has moved on, a session with
 * nowhere to deliver a message. A throw escaping this function would become an
 * unhandled rejection and take the host process with it.
 */
async function runAndAnnounce(
	record: SubagentRecord,
	opts: SubagentRunOptions,
	run: RunSubagentFn,
	resumeFrom?: string,
): Promise<void> {
	const { registry, sendMessage } = opts;
	// Everything watching the child session, torn down together when it ends.
	const stopWatching: Array<() => void> = [];
	// Anything said to this subagent while it waited for a slot joins the task it
	// is about to read. Taken before the first `await`, so nothing can arrive
	// between reading them and clearing them, and cleared so a later run of the
	// same record does not start on them again.
	const prompt = takePending(record, registry, opts.prompt);

	try {
		const outcome = await run({
			ctx: opts.ctx,
			config: opts.config,
			prompt,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
			sessionDir: opts.sessionDir,
			resumeFrom,
			// Deliberately no signal. The tool call that started this subagent is
			// over the moment it returned an id, and its signal aborts with it —
			// handing that signal down would kill every subagent at birth. Stopping
			// one on purpose is Slice 6's job.
			onSession: (session, sessionFile) => {
				// Guarded on its own. This runs inside the runner's crash guard, so a
				// throw here would come back as a failed subagent — the watchers
				// breaking the very work they exist to watch. A run nobody can report
				// the context use of is still a run worth finishing.
				try {
					registry.update(record.id, { session, sessionFile });
					stopWatching.push(
						trackContextUsage(session, registry, record.id),
						watchTurns(session, registry, record.id, turnLimit(opts.config)),
					);
				} catch {
					// The list will show a blank where the percentage would be, and an
					// unlimited subagent runs to its own conclusion.
				}
			},
		});

		// Read before the update, because the update is what wakes a waiting
		// caller: told the answer has landed, it lets go of its claim at once, so
		// asking afterwards would always find nobody waiting.
		const awaited = registry.isAwaited(record.id);
		registry.update(record.id, { status: outcome.status, outcome });

		// A caller waiting on `get_subagent_result` is handed this answer as its
		// tool result. Announcing it as well would put the same text into the
		// conversation twice.
		if (!awaited) {
			announce(record, outcome, sendMessage);
		}
	} catch {
		// Nothing left to tell, and nobody to tell it to. The record already
		// carries whatever was known before this went wrong.
	} finally {
		for (const stop of stopWatching) {
			stop();
		}
	}
}

/**
 * Launch a subagent and return its record at once.
 *
 * The record is registered before the run is submitted, so a caller that reads
 * the registry on the very next line already sees the subagent there — running
 * if a slot was free, queued if every slot was taken.
 *
 * The record starts out `queued` and the submitted thunk flips it to `running`
 * as its first act. With a slot free the queue calls that thunk synchronously,
 * so the common case never shows a `queued` record to anyone. This is also why
 * the queue itself needs to know nothing about subagents: it hands out slots,
 * and what a slot means is entirely the thunk's business.
 */
export function startSubagent(opts: StartSubagentOptions): SubagentRecord {
	const {
		config,
		description,
		registry,
		queue,
		run = runSubagent,
		newId = randomUUID,
		now = Date.now,
	} = opts;

	const record: SubagentRecord = {
		id: newId(),
		// Unique for the session, because `@reviewer` has to have exactly one
		// place to go. A second reviewer is `reviewer-2`.
		handle: assignHandle(
			config.name,
			(candidate) => registry.get(candidate) !== undefined,
		),
		type: config.name,
		config,
		description,
		status: "queued",
		// Counted before the record is added, so the first subagent is index 0.
		color: assignColor(registry.list().length, config.color),
		// Stamped at submission, not at start, so `list()` stays in the order the
		// user asked for subagents rather than the order slots happened to free.
		startedAt: now(),
		contextPercent: null,
		turns: 0,
	};

	registry.add(record);
	queue.submit(record.id, () => {
		registry.update(record.id, { status: "running" });
		return runAndAnnounce(record, opts, run);
	});

	return record;
}

/**
 * Continue a finished subagent's conversation.
 *
 * Detached and queued exactly as a first run is, so the two behave alike: the
 * record goes back to work and its new answer arrives in the conversation on its
 * own. A continuation takes a real slot, or a session already at its limit could
 * be pushed past it by resuming finished subagents.
 *
 * The stored transcript is checked before it is trusted. Pi does not write a
 * session file until the child's first assistant reply, so a subagent that
 * failed before answering names a file that was never created — and the user may
 * simply have deleted it. Either way this reports a fresh start rather than
 * pretending to have continued something.
 */
export function resumeSubagent(opts: ResumeSubagentOptions): ResumeResult {
	const { record, registry, queue, run = runSubagent } = opts;

	if (record.status === "running" || record.status === "queued") {
		// Two runs on one record would race: the second would overwrite the
		// first's status and outcome. Redirecting a live subagent is steering.
		return { ok: false, reason: "it is still working" };
	}

	const stored = record.sessionFile;
	const resumeFrom = stored && existsSync(stored) ? stored : undefined;

	registry.update(record.id, {
		status: "queued",
		// Cleared, or the record reads as finished while it runs again and
		// `get_subagent_result` hands the old answer back as this run's.
		outcome: undefined,
		stoppedBecause: undefined,
		// Cleared so the registry stamps a fresh one when this run ends. Left in
		// place, the list would treat the continuation as having finished at the
		// original time and drop the row the moment it appeared.
		finishedAt: undefined,
		// The new run's turn watcher counts from zero, so the old total would only
		// sit here until the first turn overwrote it.
		turns: 0,
	});

	queue.submit(record.id, () => {
		registry.update(record.id, { status: "running" });
		return runAndAnnounce(record, opts, run, resumeFrom);
	});

	return { ok: true, record, startedFresh: resumeFrom === undefined };
}

/**
 * Draw a completion notice as a compact line rather than a wall of raw text.
 *
 * Returning `undefined` hands the message back to pi's default rendering, which
 * is the right answer for a notice carrying no details — better a plain message
 * than a box with blanks in it.
 */
export const renderCompletion: MessageRenderer<SubagentCompleteDetails> = (
	message,
	_options,
	theme,
): Component | undefined => {
	const details = message.details;
	if (!details) {
		return undefined;
	}

	const heading = theme.fg(
		STATUS_COLOR[details.status],
		theme.bold(
			`${STATUS_MARK[details.status]} ${details.agent} — ${details.description}`,
		),
	);
	const body = typeof message.content === "string" ? message.content : "";

	return new Text(`${heading}\n${theme.fg("muted", body)}`, 1, 0);
};
