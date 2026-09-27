/**
 * pi-subagents — delegate work to focused subagents that run as nested
 * in-process sessions.
 *
 * Registers six tools. `spawn_named_subagent` launches an agent file exactly
 * as configured, while `spawn_inline_subagent` launches a caller-defined
 * character. Both return an id straight away; the subagent then works in the
 * background and its answer arrives in the conversation on its own.
 * `get_subagent_result` reads that answer back on demand, waiting when the
 * subagent is still working. `steer_subagent` redirects one mid-run, and
 * `stop_subagent` halts one while keeping whatever it had worked out.
 *
 * `list_subagents` is the exception, taking no id: it reports every subagent in
 * the session, for a caller holding several at once that needs to know which
 * are still going.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type InputEvent,
	type InputEventResult,
	SettingsManager,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Editor,
	Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { steerSubagent, stopSubagent } from "./control.ts";
import { assignHandle, parseMention } from "./mention.ts";
import { modelLabel, resolveModel } from "./model-resolver.ts";
import { resolveConcurrencyLimit, SubagentQueue } from "./queue.ts";
import {
	type SubagentRecord,
	SubagentRegistry,
	TERMINAL_STATUSES,
	whenFinished,
} from "./registry.ts";
import { describeCause, inChildContext, runSubagent } from "./runner.ts";
import {
	COMPLETE_MESSAGE_TYPE,
	describeCompletion,
	describeOutstanding,
	drawSubagentLine,
	type RunSubagentFn,
	renderCompletion,
	resumeSubagent,
	type SendMessage,
	startSubagent,
	stopFromUi,
} from "./spawn.ts";
import { DEFAULT_MAX_TURNS } from "./turns.ts";
import { SubagentList } from "./ui/subagent-list.ts";
import { SubagentViewer } from "./ui/subagent-viewer.ts";

export const NAMED_SPAWN_TOOL_NAME = "spawn_named_subagent";
export const INLINE_SPAWN_TOOL_NAME = "spawn_inline_subagent";
export const RESULT_TOOL_NAME = "get_subagent_result";
export const STEER_TOOL_NAME = "steer_subagent";
export const STOP_TOOL_NAME = "stop_subagent";
export const LIST_TOOL_NAME = "list_subagents";

/**
 * How long one `get_subagent_result` call waits before it gives up.
 *
 * Long enough that an ordinary subagent is answered inside one call, short
 * enough that a subagent whose provider has stopped answering does not hold a
 * turn open all afternoon. Giving up is not losing the answer: the notice still
 * arrives when the subagent finishes.
 */
const MAX_WAIT_MS = 10 * 60_000;

/** Identifies the list widget to pi, so remounting replaces it rather than
 * stacking a second copy below the first. */
export const SUBAGENT_LIST_WIDGET = "pi-subagents:list";

/**
 * Every effort level pi accepts, `off` included. A plain string `enum` rather
 * than a union type, per the specification's provider-compatibility decision.
 */
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/** What the listing tool reports back, for the UI rather than the model. */
export interface ListDetails {
	subagents: Array<{
		id: string;
		handle: string;
		agent: string;
		status: SubagentRecord["status"];
		description: string;
	}>;
}

/** What the tool reports back for logs and for the subagent list. */
export interface SpawnDetails {
	/** How anything else refers to this subagent afterwards. */
	id: string;
	agent: string;
	status: SubagentRecord["status"];
	description: string;
	/** Tool names the agent asked for that pi does not have. */
	unknownTools: string[];
}

/**
 * Collaborators, injectable so the tool can be exercised at its own boundary —
 * the seam the specification names — without a model or a real session.
 */
export interface SpawnToolDeps {
	discover: (cwd: string) => AgentConfig[];
	run: RunSubagentFn;
	getKnownTools: () => string[];
	/** Where launched subagents are recorded, shared with the result tool. */
	registry: SubagentRegistry;
	/** Hands out the slots, so a busy session queues rather than piles up. */
	queue: SubagentQueue;
	sendMessage: SendMessage;
	/** Seam for a deterministic test. */
	newId?: () => string;
}

/**
 * Which models a query may resolve to, narrowest set first.
 *
 * A catalogue lists models the user has no access to, so resolving against all
 * of them would cheerfully pick one that cannot run. Scoping — `enabledModels`
 * in settings, or `--models` — is the user's own statement of what they use, so
 * it wins. Configured auth is the next best proxy. The full catalogue is a last
 * resort for a session with neither.
 */
function candidateModels(ctx: ExtensionContext): readonly Model<Api>[] {
	if (ctx.scopedModels.length > 0) {
		return ctx.scopedModels.map((scoped) => scoped.model);
	}

	const available = ctx.modelRegistry.getAvailable();
	return available.length > 0 ? available : ctx.modelRegistry.getAll();
}

interface ModelChoice {
	model?: Model<Api>;
	/** Set when an ambiguous query was dismissed or an unavailable model fell back. */
	fellBack: boolean;
	fallbackReason?: string;
}

/**
 * Pick the model for this run.
 *
 * Naming no model means inheriting the parent's, so `undefined` is a valid
 * answer rather than a failure. An ambiguous name is a question for the user,
 * not a guess: `"flash"` matching two Gemini releases is exactly the case where
 * a human should choose. An unknown name falls back to the parent's verified
 * model with a note, rather than halting execution.
 */
async function chooseModel(
	ctx: ExtensionContext,
	agentName: string,
	requested: string | undefined,
	signal: AbortSignal | undefined,
): Promise<ModelChoice> {
	const query = requested?.trim();
	if (!query) {
		return { fellBack: false };
	}

	const candidates = candidateModels(ctx);
	const resolved = resolveModel(candidates, query);
	if (resolved.ok) {
		return { model: resolved.model, fellBack: false };
	}

	if (resolved.reason === "unknown") {
		const availableList =
			resolved.available.length > 0
				? ` Available models: ${resolved.available.join(", ")}.`
				: "";
		return {
			model: undefined,
			fellBack: true,
			fallbackReason: `Model "${query}" is not available.${availableList}`,
		};
	}

	// Ambiguous. Ask, when there is someone to ask: blocking on a dialog in a
	// headless or print-mode run would hang it with nothing on screen.
	if (!ctx.hasUI) {
		throw new Error(
			`Model "${query}" matches more than one available model: ` +
				`${resolved.available.join(", ")}. Name one of them exactly.`,
		);
	}

	const picked = await ctx.ui.select(
		`Which model should the "${agentName}" subagent use?`,
		resolved.available,
		{ signal },
	);
	if (picked === undefined) {
		return { fellBack: true };
	}

	return {
		model: candidates.find((model) => modelLabel(model) === picked),
		fellBack: false,
	};
}

/**
 * The `description` the model reads when choosing whether to delegate. Built at
 * registration from the agents present then, so it names real agents rather
 * than describing an abstract capability.
 */
function buildNamedToolDescription(agents: AgentConfig[]): string {
	if (agents.length === 0) {
		return (
			"Launch a saved subagent exactly as configured in its agent file. " +
			"No agent files are defined for this project."
		);
	}

	return [
		"Launch a saved subagent exactly as configured in its agent file. " +
			"Available subagent types:",
		"",
		...agents.map(
			(agent) => `- ${agent.name}: ${agent.description} (${agent.source})`,
		),
	].join("\n");
}

/**
 * Drop tool names pi does not have.
 *
 * Pi accepts an unknown name into a session's allowlist and then drops it at
 * registration without a word, so an agent asking for a misspelled tool would
 * quietly end up with none of the tools it named. Filtering here means the
 * agent gets what it asked for and the caller is told what was ignored.
 */
function checkToolNames(
	requested: string[] | undefined,
	known: string[],
): { tools: string[] | undefined; unknownTools: string[] } {
	if (!requested) {
		return { tools: undefined, unknownTools: [] };
	}

	const knownSet = new Set(known);
	const tools = requested.filter((name) => knownSet.has(name));
	const unknownTools = requested.filter((name) => !knownSet.has(name));
	return { tools: tools.length > 0 ? tools : undefined, unknownTools };
}

/** Resolve only an agent file; named spawn has no inline route. */
function resolveNamedConfig(
	subagentType: string,
	agents: AgentConfig[],
): AgentConfig {
	const type = subagentType.trim();
	if (!type) {
		throw new Error("subagent_type must not be blank.");
	}

	const config = agents.find((agent) => agent.name === type);
	if (config) {
		return config;
	}

	throw new Error(
		agents.length === 0
			? "No agent files are defined for this project, so there is no " +
					`subagent type "${type}".`
			: `Unknown subagent type "${type}". ` +
					`Known types: ${agents.map((agent) => agent.name).join(", ")}.`,
	);
}

/** Build only a caller-defined character; inline spawn has no file route. */
function resolveInlineConfig(params: {
	name: string;
	system_prompt: string;
	description: string;
	tools?: string[];
	max_turns?: number;
}): AgentConfig {
	const name = params.name.trim();
	if (!name) {
		throw new Error("name must not be blank.");
	}

	const systemPrompt = params.system_prompt.trim();
	if (!systemPrompt) {
		throw new Error("system_prompt must not be blank.");
	}

	return {
		name,
		description: params.description,
		systemPrompt,
		tools: params.tools,
		maxTurns: params.max_turns,
		source: "inline",
	};
}

/**
 * The agent file a supplied character is about to be named over, if there is
 * one.
 *
 * Shadowing was a refusal until live use showed the cost: the main agent was
 * asked for a security reviewer, composed one, named it `security`, and the
 * subagent never started because a file of that name existed. The character the
 * user asked for now wins and the file is passed over — but silently passing
 * over a persona somebody wrote and read is the thing the refusal was
 * protecting, so the caller is told.
 */
function shadowedFile(
	config: AgentConfig,
	agents: AgentConfig[],
): AgentConfig | undefined {
	return config.source === "inline"
		? agents.find((agent) => agent.name === config.name)
		: undefined;
}

/**
 * What the model is told the instant a subagent is under way.
 *
 * Everything knowable at launch belongs here rather than in the completion
 * notice: a warning that arrives with the answer, minutes later, has missed
 * its moment. The answer itself is not here, because there is not one yet.
 */
function describeStart(
	record: SubagentRecord,
	unknownTools: string[],
	choice: ModelChoice,
	shadowed: AgentConfig | undefined,
	ctx: ExtensionContext,
): string {
	const parts: string[] = [];

	if (shadowed) {
		// The source is worth naming: which of the three tiers holds the file is
		// what tells the caller whether it is one the user wrote.
		parts.push(
			`Note: a ${shadowed.source} agent file is also named ` +
				`"${shadowed.name}". This subagent runs under the system_prompt you ` +
				"supplied, not that file.",
		);
	}

	if (choice.fellBack) {
		// Dismissing the dialog or requesting an unavailable model leaves the
		// parent's model in play. Saying so keeps that from being an invisible
		// decision.
		const parentLabel = ctx.model ? ` (${modelLabel(ctx.model)})` : "";
		parts.push(
			choice.fallbackReason
				? `Note: ${choice.fallbackReason} Falling back to the current model${parentLabel}.`
				: `No model was chosen for this subagent, so it is running on the current model${parentLabel}.`,
		);
	}

	if (unknownTools.length > 0) {
		parts.push(
			`Warning: subagent "${record.type}" asks for unknown tool(s) ` +
				`${unknownTools.join(", ")}; they were ignored.`,
		);
	}

	// Queued rather than started is worth saying: it explains a subagent that
	// has not begun, and it tells the model that launching more will not make
	// this one go any faster.
	parts.push(
		record.status === "queued"
			? `Subagent "${record.type}" is queued with id ${record.id}, waiting ` +
					"for one of the running subagents to finish. It will start on its " +
					"own, and its result will arrive here when it is done."
			: `Subagent "${record.type}" started with id ${record.id}. It runs in ` +
					"the background and its result will arrive here on its own, so " +
					"carry on with other work. With none left to do, call " +
					`${RESULT_TOOL_NAME} with that id once: it waits for the answer ` +
					"and hands it back.",
	);

	return parts.join("\n\n");
}

const NAMED_SPAWN_KEYS = new Set(["subagent_type", "prompt", "description"]);
const INLINE_SPAWN_KEYS = new Set([
	"name",
	"system_prompt",
	"prompt",
	"description",
	"tools",
	"model",
	"thinking",
	"max_turns",
	"wake_on_finish",
]);

/** Input keys a direct caller supplied outside one tool's public contract. */
function unexpectedKeys(
	params: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): string[] {
	return Object.keys(params)
		.filter((key) => !allowed.has(key))
		.sort();
}

/** A configuration refusal reported as a normal tool result. */
function spawnRefusal(
	agent: string,
	description: string | undefined,
	cause: unknown,
) {
	return {
		content: [
			{ type: "text" as const, text: `Refusal: ${describeCause(cause)}` },
		],
		details: {
			id: "",
			agent,
			status: "failed",
			description: description || "configuration error",
			unknownTools: [],
		} satisfies SpawnDetails,
	};
}

/** Render a spawn result under the tool that produced it. */
function renderSpawnResult(
	result: { content: Array<{ type: string }>; details?: unknown },
	options: ToolRenderResultOptions,
	theme: Theme,
	fallback: string,
): Component {
	const details = result.details as SpawnDetails | undefined;
	const summary =
		details?.status === "failed"
			? `${details?.agent || fallback} — configuration error`
			: `${details?.agent || "subagent"} (${details?.id || ""}) — ${details?.status || "started"}`;
	return compactResult(result, options, theme, summary);
}

/** Launch an agent file without exposing character or execution overrides. */
export function createNamedSpawnTool(deps: SpawnToolDeps) {
	return defineTool({
		name: NAMED_SPAWN_TOOL_NAME,
		label: "Spawn Named Subagent",
		description: buildNamedToolDescription(deps.discover(process.cwd())),
		parameters: Type.Object(
			{
				subagent_type: Type.String({
					description: "Saved subagent type from the available agent files.",
				}),
				prompt: Type.String({
					description: "Self-contained task instructions for the subagent.",
				}),
				description: Type.String({
					description: "3-5 words describing the task, shown in the UI.",
				}),
			},
			{ additionalProperties: false },
		),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (inChildContext()) {
				throw new Error(
					"A subagent cannot spawn further subagents. Do the work directly.",
				);
			}

			const extra = unexpectedKeys(
				params as Record<string, unknown>,
				NAMED_SPAWN_KEYS,
			);
			if (extra.length > 0) {
				return spawnRefusal(
					params.subagent_type || NAMED_SPAWN_TOOL_NAME,
					params.description,
					`Unexpected field(s): ${extra.join(", ")}. Allowed fields: ` +
						"subagent_type, prompt, description.",
				);
			}

			let config: AgentConfig;
			try {
				config = resolveNamedConfig(
					params.subagent_type,
					deps.discover(ctx.cwd),
				);
			} catch (error) {
				return spawnRefusal(
					params.subagent_type || NAMED_SPAWN_TOOL_NAME,
					params.description,
					error,
				);
			}

			const { tools, unknownTools } = checkToolNames(
				config.tools,
				deps.getKnownTools(),
			);

			let choice: ModelChoice;
			try {
				choice = await chooseModel(ctx, config.name, config.model, signal);
			} catch (error) {
				return spawnRefusal(config.name, params.description, error);
			}

			const namedConfig: AgentConfig = {
				...config,
				tools,
				wakeOnFinish: undefined,
			};
			const record = startSubagent({
				ctx,
				config: namedConfig,
				prompt: params.prompt,
				description: params.description,
				model: choice.model,
				thinkingLevel: config.thinking,
				registry: deps.registry,
				queue: deps.queue,
				sendMessage: deps.sendMessage,
				run: deps.run,
				...(deps.newId ? { newId: deps.newId } : {}),
			});

			return {
				content: [
					{
						type: "text" as const,
						text: describeStart(record, unknownTools, choice, undefined, ctx),
					},
				],
				details: {
					id: record.id,
					agent: config.name,
					status: record.status,
					description: params.description,
					unknownTools,
				} satisfies SpawnDetails,
			};
		},

		renderResult: (result, options, theme) =>
			renderSpawnResult(result, options, theme, NAMED_SPAWN_TOOL_NAME),
	});
}

/** Launch a character defined completely by the caller. */
export function createInlineSpawnTool(deps: SpawnToolDeps) {
	return defineTool({
		name: INLINE_SPAWN_TOOL_NAME,
		label: "Spawn Inline Subagent",
		description:
			"Launch a caller-defined subagent. Supply its complete character and a " +
			"short distinct name yourself; never ask the user to invent the name.",
		parameters: Type.Object(
			{
				name: Type.String({
					description:
						"Short distinct name for the subagent. Choose it yourself; never ask the user.",
				}),
				system_prompt: Type.String({
					description:
						"Complete instructions defining the subagent's character.",
				}),
				prompt: Type.String({
					description: "Self-contained task instructions for the subagent.",
				}),
				description: Type.String({
					description: "3-5 words describing the task, shown in the UI.",
				}),
				tools: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Tools this subagent may use. Defaults to read-only tools (read, grep, find, ls).",
					}),
				),
				model: Type.Optional(
					Type.String({
						description:
							"Model name/id to use. Defaults to the current session model. Leave unset unless a specific alternative model is required.",
					}),
				),
				thinking: Type.Optional(
					Type.String({
						enum: [...THINKING_LEVELS],
						description: "Effort level. Defaults to the current level.",
					}),
				),
				max_turns: Type.Optional(
					Type.Integer({
						minimum: 1,
						description: `Turns before forced wrap-up. Defaults to ${DEFAULT_MAX_TURNS}.`,
					}),
				),
				wake_on_finish: Type.Optional(
					Type.Boolean({
						description:
							"Whether to trigger a main-model turn when finished. Defaults to automatic batch wakeup.",
					}),
				),
			},
			{ additionalProperties: false },
		),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (inChildContext()) {
				throw new Error(
					"A subagent cannot spawn further subagents. Do the work directly.",
				);
			}

			const extra = unexpectedKeys(
				params as Record<string, unknown>,
				INLINE_SPAWN_KEYS,
			);
			if (extra.length > 0) {
				return spawnRefusal(
					params.name || INLINE_SPAWN_TOOL_NAME,
					params.description,
					`Unexpected field(s): ${extra.join(", ")}. Allowed fields: ` +
						Array.from(INLINE_SPAWN_KEYS).join(", ") +
						".",
				);
			}

			let config: AgentConfig;
			try {
				config = resolveInlineConfig(params);
			} catch (error) {
				return spawnRefusal(
					params.name || INLINE_SPAWN_TOOL_NAME,
					params.description,
					error,
				);
			}

			const { tools, unknownTools } = checkToolNames(
				config.tools,
				deps.getKnownTools(),
			);

			let choice: ModelChoice;
			try {
				choice = await chooseModel(ctx, config.name, params.model, signal);
			} catch (error) {
				return spawnRefusal(config.name, params.description, error);
			}

			const agents = deps.discover(ctx.cwd);
			const inlineConfig = { ...config, tools };
			const record = startSubagent({
				ctx,
				config: inlineConfig,
				prompt: params.prompt,
				description: params.description,
				model: choice.model,
				thinkingLevel: params.thinking as ThinkingLevel | undefined,
				wakeOnFinish: params.wake_on_finish,
				registry: deps.registry,
				queue: deps.queue,
				sendMessage: deps.sendMessage,
				run: deps.run,
				...(deps.newId ? { newId: deps.newId } : {}),
			});

			return {
				content: [
					{
						type: "text" as const,
						text: describeStart(
							record,
							unknownTools,
							choice,
							shadowedFile(config, agents),
							ctx,
						),
					},
				],
				details: {
					id: record.id,
					agent: config.name,
					status: record.status,
					description: params.description,
					unknownTools,
				} satisfies SpawnDetails,
			};
		},

		renderResult: (result, options, theme) =>
			renderSpawnResult(result, options, theme, INLINE_SPAWN_TOOL_NAME),
	});
}

/**
 * The record for an id the model supplied, or a refusal that says what it could
 * have asked for instead.
 *
 * Three tools take an id, and a model that has lost track of one is better off
 * with the live ids than with a bare "not found".
 */
function requireRecord(registry: SubagentRegistry, id: string): SubagentRecord {
	const record = registry.get(id);
	if (record) {
		return record;
	}

	const known = registry.list();
	throw new Error(
		`No subagent with id "${id}". ` +
			(known.length > 0
				? `Known ids: ${known.map((r) => r.id).join(", ")}.`
				: "No subagents have been started in this session."),
	);
}

/** Names a subagent the way a tool result should: type and id together. */
function nameOf(record: SubagentRecord): string {
	return `subagent "${record.type}" (${record.id})`;
}

/**
 * What a steer or a stop reports back, for logs and for the list.
 *
 * Read off the record after the operation, so a stop that dropped a queued
 * subagent reports it as stopped rather than as it was a moment before.
 */
export interface ControlDetails {
	id: string;
	agent: string;
	status: SubagentRecord["status"];
	description: string;
}

function controlDetails(record: SubagentRecord): ControlDetails {
	return {
		id: record.id,
		agent: record.type,
		status: record.status,
		description: record.description,
	};
}

/**
 * Reading a subagent's answer back on demand, waiting for it if it is not
 * there yet.
 *
 * The answer arrives on its own when the subagent finishes, so this exists for
 * the model that wants it sooner, or that has been handed an id and no longer
 * has the notice in view.
 *
 * Waiting rather than reporting "not yet" is what the first live run bought:
 * a model with nothing else to do asked the same question every turn, and each
 * of those turns re-sent the whole conversation to the provider. One call that
 * settles when there is something to say costs one turn instead of ten.
 */
export function createResultTool(deps: {
	registry: SubagentRegistry;
	/** How long one call waits before giving up. */
	waitMs?: number;
	/** How often the wait checks whether the user has typed. */
	pollMs?: number;
}) {
	return defineTool({
		name: RESULT_TOOL_NAME,
		label: "Get Subagent Result",
		description:
			"Read the result of a subagent started by either spawn tool, by the " +
			"id it returned. Waits if still working. Call once per id.",
		parameters: Type.Object({
			id: Type.String({
				description: "The id returned by a subagent spawn tool.",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const record = requireRecord(deps.registry, params.id);

			if (!record.outcome) {
				await whenFinished(deps.registry, record.id, {
					signal,
					timeoutMs: deps.waitMs ?? MAX_WAIT_MS,
					// pi holds what the user types until this call returns, so the
					// wait gives way to them rather than keeping them unread.
					interrupted: () => ctx.hasPendingMessages(),
					...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
				});
			}

			// Read after the wait, not before: the record is updated in place, so
			// this is the answer that arrived while this call was holding.
			const text = [
				record.outcome
					? describeCompletion(record, record.outcome)
					: stillWorking(record, ctx.hasPendingMessages()),
				describeOutstanding(deps.registry, record.id),
			].join("\n\n");

			return {
				content: [{ type: "text" as const, text }],
				details: {
					id: record.id,
					agent: record.type,
					status: record.status,
					description: record.description,
					unknownTools: [],
				} satisfies SpawnDetails,
			};
		},

		// Drawn without pi's padded box, and drawn not at all when a row has
		// nothing to add: a long review waits many times over, and each wait as
		// a box filled the scrollback with statuses the list below the prompt
		// was already showing. pi drops a self-drawn row that draws no lines.
		renderShell: "self",
		renderCall: () => new Container(),
		renderResult: (result, options, theme) => {
			// Cast as the spawn tools' renderer does: taking `ctx` in `execute`
			// loses the inference that typed `details` here.
			const details = result.details as SpawnDetails | undefined;
			const text = textOf(result);
			// A call that failed outright carries no details, and hiding it would
			// hide the only sign that anything went wrong.
			if (!details?.status) {
				return new Text(text, 1, 0);
			}
			if (!TERMINAL_STATUSES.has(details.status)) {
				return new Container();
			}
			return drawSubagentLine(details, text, options.expanded, theme);
		},
	});
}

/** The text a tool result carries, as the model reads it. */
function textOf(result: { content: Array<{ type: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => {
			return block.type === "text";
		})
		.map((block) => block.text)
		.join("\n");
}

/**
 * Why a wait ended without an answer, so the main model knows what to do next.
 *
 * A wait the user interrupted is not a subagent running late: telling the model
 * "has not finished within the time this call waits" would have it wait again
 * rather than read the message it was interrupted for.
 */
function stillWorking(record: SubagentRecord, userTyped: boolean): string {
	const name = `Subagent "${record.type}" (${record.id}) is still working`;
	return userTyped
		? `${name}. Stopped waiting because the user sent a message: answer ` +
				"it first. The result will arrive here on its own when it finishes."
		: `${name}, and has not finished within the time this call waits. Its ` +
				"result will arrive here on its own when it does.";
}

/**
 * A tool result drawn as one muted line, and in full only when the user opens
 * it.
 *
 * These two tools are asked the same question repeatedly by a model waiting on
 * subagents, and each answer redrawn in full turns the conversation into a wall
 * of statuses nobody is reading. The text the model receives is untouched —
 * this is only how it is shown.
 */
function compactResult(
	result: { content: Array<{ type: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
	summary: string,
): Component {
	return new Text(
		options.expanded ? textOf(result) : theme.fg("muted", summary),
		1,
		0,
	);
}

/**
 * Every subagent in the session, as one line each.
 *
 * The order is the registry's own, which is launch order — the order the caller
 * asked for these subagents rather than the order slots happened to free, so a
 * caller reading the list back recognises what it started.
 */
function describeList(records: SubagentRecord[]): string {
	if (records.length === 0) {
		return (
			"No subagents have been started in this session. Start one with " +
			`${NAMED_SPAWN_TOOL_NAME} or ${INLINE_SPAWN_TOOL_NAME}.`
		);
	}

	const lines = records.map(
		(record) =>
			`- ${record.handle} (${record.id}) — ${record.status} — ` +
			record.description,
	);
	const count =
		records.length === 1 ? "1 subagent" : `${records.length} subagents`;
	return [`${count} in this session:`, "", ...lines].join("\n");
}

/**
 * What every subagent is doing, in one call.
 *
 * Exists because the user can see this list in the interface and the model
 * cannot. Without it, a caller that started several subagents together can only
 * learn about them one id at a time through `get_subagent_result`, and only for
 * as long as it still remembers every id — so a lost id becomes a quietly
 * partial answer rather than a failure.
 *
 * Reads the registry and writes nothing. There is no state here to get wrong.
 */
export function createListTool(deps: { registry: SubagentRegistry }) {
	return defineTool({
		name: LIST_TOOL_NAME,
		label: "List Subagents",
		description: "Every subagent started in this session, with its status.",
		// No parameters: a caller that had to know an id to learn anything would
		// be back where it started.
		parameters: Type.Object({}),

		async execute() {
			const records = deps.registry.list();

			return {
				content: [{ type: "text" as const, text: describeList(records) }],
				details: {
					subagents: records.map((record) => ({
						id: record.id,
						handle: record.handle,
						agent: record.type,
						status: record.status,
						description: record.description,
					})),
				} satisfies ListDetails,
			};
		},

		renderResult: (result, options, theme) =>
			compactResult(result, options, theme, summariseList(result.details)),
	});
}

/**
 * The list as one line: how many subagents, and how many are in each state.
 *
 * Counts rather than names, because the names are in the list under the prompt
 * already — what a reader wants from a repeated call is whether anything has
 * moved since the last one.
 */
function summariseList(details: ListDetails | undefined): string {
	const subagents = details?.subagents ?? [];
	if (subagents.length === 0) {
		return "no subagents";
	}

	const counts = new Map<string, number>();
	for (const subagent of subagents) {
		counts.set(subagent.status, (counts.get(subagent.status) ?? 0) + 1);
	}

	const states = Array.from(counts, ([status, count]) => `${count} ${status}`);
	const total =
		subagents.length === 1 ? "1 subagent" : `${subagents.length} subagents`;
	return [total, ...states].join(" · ");
}

/**
 * Redirecting a subagent that is already working.
 *
 * A refusal is thrown rather than returned as text. The model must not be left
 * believing it has redirected a subagent that in fact finished a moment before
 * the message arrived, and a tool error is the one result it cannot read as
 * success.
 */
export function createSteerTool(deps: { registry: SubagentRegistry }) {
	return defineTool({
		name: STEER_TOOL_NAME,
		label: "Steer Subagent",
		description: `Redirect a running subagent by id. Instruction lands before its next model call.`,
		parameters: Type.Object({
			id: Type.String({
				description: "The id returned by a subagent spawn tool.",
			}),
			message: Type.String({
				description: "The new self-contained instruction for the subagent.",
			}),
		}),

		async execute(_toolCallId, params) {
			const record = requireRecord(deps.registry, params.id);
			const result = await steerSubagent(record, params.message, deps);
			if (!result.ok) {
				throw new Error(`Cannot steer ${nameOf(record)}: ${result.reason}.`);
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Steered ${nameOf(record)}. It carries on from that message; ` +
							"its result will arrive here when it finishes.",
					},
				],
				details: controlDetails(record),
			};
		},
	});
}

/**
 * Halting a subagent, whether it is running or still waiting for a slot.
 *
 * The queue is needed as well as the registry: a subagent that never got a slot
 * is stopped by dropping it from the queue, and there is no session to abort.
 */
export function createStopTool(deps: {
	registry: SubagentRegistry;
	queue: SubagentQueue;
}) {
	return defineTool({
		name: STOP_TOOL_NAME,
		label: "Stop Subagent",
		description: `Halt a subagent by id. Partial results are preserved.`,
		parameters: Type.Object({
			id: Type.String({
				description: "The id returned by a subagent spawn tool.",
			}),
		}),

		async execute(_toolCallId, params) {
			const record = requireRecord(deps.registry, params.id);
			const result = await stopSubagent(record, deps);
			if (!result.ok) {
				throw new Error(`Cannot stop ${nameOf(record)}: ${result.reason}.`);
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Stopped ${nameOf(record)}. Anything it had worked out is ` +
							`kept — call ${RESULT_TOOL_NAME} with its id to read it.`,
					},
				],
				details: controlDetails(record),
			};
		},
	});
}

/**
 * How many subagents this session runs at once.
 *
 * Read once, at registration. A limit that changed under a running queue would
 * leave subagents already through the gate uncounted against it, and settings
 * are not something a user edits mid-turn.
 *
 * Unguarded on purpose. `SettingsManager.create` reports a settings file it
 * cannot read or lock as empty settings rather than throwing — both loads go
 * through `tryLoadFromStorage` — so a hostile agent directory already arrives
 * here as "nothing configured", and a `catch` of our own would only be
 * unreachable.
 */
export function configuredLimit(
	cwd: string,
	agentDir: string = getAgentDir(),
): number {
	const settings = SettingsManager.create(cwd, agentDir);
	return resolveConcurrencyLimit(
		settings.getProjectSettings(),
		settings.getGlobalSettings(),
	);
}

/** What the `@name` handler needs to reach a subagent however far along it is. */
export interface MentionHandlerDeps {
	registry: SubagentRegistry;
	queue: SubagentQueue;
	sendMessage: SendMessage;
	discover: (cwd: string) => AgentConfig[];
	/** How a run happens. Injected so a test needs no model. */
	run?: RunSubagentFn;
}

/** The agent definition a handle names, for a subagent not yet started. */
function agentForHandle(
	agents: AgentConfig[],
	handle: string,
): AgentConfig | undefined {
	return agents.find(
		(agent) => assignHandle(agent.name, () => false) === handle,
	);
}

/**
 * Route `@name` at the main prompt straight to that subagent.
 *
 * The point is that talking to a subagent costs no main-model turn and no main
 * context: pi is told the input was `handled`, so nothing about the message or
 * the reply passes through the main conversation at all. That is also why every
 * outcome is reported with `ctx.ui.notify` rather than as a message — a message
 * would spend the context this exists to save.
 *
 * Dispatch is by how far along the subagent is, which is the specification's own
 * table: still going means steer it, finished means continue it, and a name that
 * belongs to an agent file with no subagent behind it yet means start one with
 * this message as its task.
 */
export function createMentionHandler(deps: MentionHandlerDeps) {
	return async (
		event: InputEvent,
		ctx: ExtensionContext,
	): Promise<InputEventResult> => {
		// Text an extension submitted is not a person typing a mention, and an
		// extension has no way to opt out of another's routing. Ours arrives as a
		// custom message rather than as input, so this guards the general case
		// rather than a loop of our own making.
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const agents = deps.discover(ctx.cwd);
		const mention = parseMention(
			event.text,
			(handle) =>
				deps.registry.get(handle) !== undefined ||
				agentForHandle(agents, handle) !== undefined,
		);

		if (mention.kind === "passthrough") {
			// Only `@main ` rewrites anything, and then only by stripping itself.
			return mention.text === event.text
				? { action: "continue" }
				: { action: "transform", text: mention.text };
		}

		await route(mention.handle, mention.message, agents, ctx, deps);
		return { action: "handled" };
	};
}

/**
 * Deliver one mention, and say what became of it.
 *
 * Nothing here throws: this runs inside pi's input dispatch, where an exception
 * would surface as an extension error over a prompt the user has already lost.
 * A refusal is reported and the message is not delivered — sending it to the
 * main model instead would be a stranger outcome than being told it went
 * nowhere.
 */
async function route(
	handle: string,
	message: string,
	agents: AgentConfig[],
	ctx: ExtensionContext,
	deps: MentionHandlerDeps,
): Promise<void> {
	const say = (text: string, level: "info" | "warning" = "info") =>
		ctx.ui.notify(text, level);
	const record = deps.registry.get(handle);

	// Still going: this is steering, exactly as the tool does it.
	if (record && !TERMINAL_STATUSES.has(record.status)) {
		const result = await steerSubagent(record, message, deps);
		say(
			result.ok
				? `Sent to "${handle}".`
				: `Cannot reach "${handle}": ${result.reason}.`,
			result.ok ? "info" : "warning",
		);
		return;
	}

	// A subagent given its definition when it was started has no file to read, so
	// its record holds the only one there is.
	//
	// Everything else is freshly read, so a continuation runs under the agent
	// file as it is now — and so a file that has since been deleted is noticed
	// rather than guessed at. Deliberately branched on where the definition came
	// from rather than on whether a file happens to be found: falling back to the
	// record whenever the lookup missed would resume a deleted agent under the
	// copy it started with, which is the opposite of noticing.
	const config =
		record?.config.source === "inline"
			? record.config
			: record
				? agents.find((agent) => agent.name === record.type)
				: agentForHandle(agents, handle);
	if (!config) {
		say(`There is no agent file for "${handle}" any more.`, "warning");
		return;
	}

	// The same resolution the tool does, so a mention and a tool call start the
	// same subagent. An unusable `model:` refuses the message rather than
	// quietly running the subagent on something else.
	let choice: ModelChoice;
	try {
		choice = await chooseModel(ctx, config.name, config.model, ctx.signal);
	} catch (error) {
		say(`Cannot start "${handle}": ${describeCause(error)}`, "warning");
		return;
	}
	if (choice.fellBack && choice.fallbackReason) {
		say(`Cannot start "${handle}": ${choice.fallbackReason}`, "warning");
		return;
	}

	const options = {
		ctx,
		config: config,
		prompt: message,
		model: choice.model,
		thinkingLevel: config.thinking,
		registry: deps.registry,
		queue: deps.queue,
		sendMessage: deps.sendMessage,
		...(deps.run ? { run: deps.run } : {}),
	};

	if (record) {
		const result = resumeSubagent({ ...options, record });
		if (!result.ok) {
			say(`Cannot reach "${handle}": ${result.reason}.`, "warning");
			return;
		}
		say(
			result.startedFresh
				? `"${handle}" had no stored conversation, so it starts fresh.`
				: `Continuing "${handle}".`,
		);
		return;
	}

	const started = startSubagent({
		...options,
		// The message doubles as the row's description; only its first line, so a
		// pasted message does not turn the list into a paragraph.
		description: message.split("\n")[0]?.trim() ?? message,
	});
	say(`Started "${started.handle}".`);
}

export default function (pi: ExtensionAPI): void {
	// One registry for the session, shared by the tool that fills it and the
	// tool that reads it, and one queue holding them all to the limit.
	const registry = new SubagentRegistry();
	const queue = new SubagentQueue(configuredLimit(process.cwd()));
	// Bound once, because it is called from background continuations and from the
	// UI, neither of which has a `pi` of its own.
	const sendMessage: SendMessage = pi.sendMessage.bind(pi);

	const spawnDeps: SpawnToolDeps = {
		discover: discoverAgents,
		run: runSubagent,
		// Read lazily: other extensions register tools too, and the full set is
		// only settled once the session is running.
		getKnownTools: () => pi.getAllTools().map((tool) => tool.name),
		registry,
		queue,
		sendMessage,
	};
	pi.registerTool(createNamedSpawnTool(spawnDeps));
	pi.registerTool(createInlineSpawnTool(spawnDeps));

	pi.registerTool(createResultTool({ registry }));
	pi.registerTool(createListTool({ registry }));
	pi.registerTool(createSteerTool({ registry }));
	pi.registerTool(createStopTool({ registry, queue }));
	pi.registerMessageRenderer(COMPLETE_MESSAGE_TYPE, renderCompletion);

	// `@name` at the prompt reaches a subagent without a main-model turn.
	pi.on(
		"input",
		createMentionHandler({
			registry,
			queue,
			sendMessage,
			discover: discoverAgents,
		}),
	);

	// The list is a terminal widget, so it is mounted once the session is up and
	// only when there is a terminal to mount it in. `print`, `json` and `rpc`
	// runs have no editor to sit below and nothing to redraw.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		let viewerOpen = false;

		/**
		 * Show one subagent's conversation in a full TUI view, until it is closed.
		 *
		 * `ctx.ui.custom` hands the view the keyboard and resolves when the view
		 * calls the `done` it was given, which is what the list waits on before it
		 * starts taking keys again.
		 */
		const openViewer = async (record: SubagentRecord): Promise<void> => {
			viewerOpen = true;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						tui.requestRender(true);
						return new SubagentViewer({
							record,
							registry,
							theme,
							tui,
							cwd: ctx.cwd,
							// Read each time rather than captured, so a terminal resized
							// while the panel is open resizes the panel with it.
							rows: () => Math.max(8, tui.terminal.rows - 1),
							close: () => {
								tui.requestRender(true);
								done();
							},
							steer: (steering, message) =>
								steerSubagent(steering, message, { registry }),
							stop: (stopping) =>
								stopFromUi(stopping, { registry, queue }, sendMessage),
						});
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "top-left",
							width: "100%",
							maxHeight: "100%",
							margin: 0,
						},
					},
				);
			} finally {
				viewerOpen = false;
			}
		};

		ctx.ui.setWidget(
			SUBAGENT_LIST_WIDGET,
			// Built per mount rather than once: the theme arrives here, and a theme
			// change remounts the widget with the new one.
			(tui, theme) =>
				new SubagentList({
					registry,
					theme,
					isViewerOpen: () => viewerOpen,
					requestRender: () => tui.requestRender(),
					// The list never holds focus, so an input listener is the only way
					// arrow keys reach it. It reads the prompt to decide whether an
					// arrow was meant for the list or for the cursor.
					addInputListener: (listener) => tui.addInputListener(listener),
					isEditorFocused: () => {
						if (tui.hasOverlay?.()) {
							return false;
						}
						const getFocused = (
							tui as { getFocusedComponent?: () => Component | null }
						).getFocusedComponent;
						const focused = getFocused ? getFocused.call(tui) : undefined;
						if (!focused) {
							return false;
						}
						if (focused instanceof Editor) {
							return true;
						}
						if (ctx.ui.getEditorComponent?.()) {
							const name = focused.constructor?.name ?? "";
							return (
								!name.includes("Selector") &&
								!name.includes("Dialog") &&
								!name.includes("Modal") &&
								!name.includes("Viewer") &&
								!name.startsWith("Extension")
							);
						}
						return false;
					},
					getEditorText: () => ctx.ui.getEditorText(),
					onOpen: openViewer,
					// A stop that worked shows in the row's own status. A refusal has
					// nowhere to appear in a list of rows, so it is said out loud.
					onStop: (record) => {
						void stopFromUi(record, { registry, queue }, sendMessage).then(
							(result) => {
								if (!result.ok) {
									ctx.ui.notify(
										`Cannot stop "${record.handle}": ${result.reason}.`,
										"warning",
									);
								}
							},
						);
					},
				}),
			{ placement: "belowEditor" },
		);
	});
}
