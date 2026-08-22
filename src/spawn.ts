/**
 * Starting a subagent, and announcing it when it ends.
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
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageRenderer,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { assignColor } from "./colors.ts";
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

export interface StartSubagentOptions {
	ctx: ExtensionContext;
	config: AgentConfig;
	prompt: string;
	/** The caller's few words about the task, shown in the list. */
	description: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	registry: SubagentRegistry;
	/** Hands out the slots. Past the limit a subagent waits its turn. */
	queue: SubagentQueue;
	sendMessage: SendMessage;
	run?: RunSubagentFn;
	/** Seams for a deterministic test. */
	newId?: () => string;
	now?: () => number;
}

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
	opts: StartSubagentOptions,
	run: RunSubagentFn,
): Promise<void> {
	const { registry, sendMessage } = opts;
	// Everything watching the child session, torn down together when it ends.
	const stopWatching: Array<() => void> = [];

	try {
		const outcome = await run({
			ctx: opts.ctx,
			config: opts.config,
			prompt: opts.prompt,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
			// Deliberately no signal. The tool call that started this subagent is
			// over the moment it returned an id, and its signal aborts with it —
			// handing that signal down would kill every subagent at birth. Stopping
			// one on purpose is Slice 6's job.
			onSession: (session) => {
				// Guarded on its own. This runs inside the runner's crash guard, so a
				// throw here would come back as a failed subagent — the watchers
				// breaking the very work they exist to watch. A run nobody can report
				// the context use of is still a run worth finishing.
				try {
					registry.update(record.id, { session });
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

		registry.update(record.id, { status: outcome.status, outcome });

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
		// Slice 11 makes handles unique — "reviewer", "reviewer-2". Until then the
		// type doubles as the label and the id does the distinguishing.
		handle: config.name,
		type: config.name,
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

const STATUS_MARK: Record<SubagentStatus, string> = {
	queued: "·",
	running: "…",
	completed: "✓",
	failed: "✗",
	stopped: "◼",
};

const STATUS_COLOR: Record<SubagentStatus, ThemeColor> = {
	queued: "muted",
	running: "muted",
	completed: "success",
	failed: "error",
	stopped: "warning",
};

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
