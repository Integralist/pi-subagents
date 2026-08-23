/**
 * pi-subagents — delegate work to focused subagents that run as nested
 * in-process sessions.
 *
 * Registers five tools, four of which speak in the id that `spawn_subagent`
 * returns. `spawn_subagent` takes a task and either the name of an agent
 * defined under `.pi/agents/` or a character to run under, and returns that id
 * straight away — the subagent then works in the background and its answer
 * arrives in the conversation on its own. `get_subagent_result` reads that
 * answer back on demand, for a caller that would rather ask than wait to be
 * told. `steer_subagent` redirects one mid-run, and `stop_subagent` halts one
 * while keeping whatever it had worked out.
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
} from "@earendil-works/pi-coding-agent";
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
} from "./registry.ts";
import { describeCause, inChildContext, runSubagent } from "./runner.ts";
import {
	COMPLETE_MESSAGE_TYPE,
	describeCompletion,
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

export const SPAWN_TOOL_NAME = "spawn_subagent";
export const RESULT_TOOL_NAME = "get_subagent_result";
export const STEER_TOOL_NAME = "steer_subagent";
export const STOP_TOOL_NAME = "stop_subagent";
export const LIST_TOOL_NAME = "list_subagents";

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
	/** Set when an ambiguous query was dismissed and the parent's model stands. */
	fellBack: boolean;
}

/**
 * Pick the model for this run.
 *
 * Naming no model means inheriting the parent's, so `undefined` is a valid
 * answer rather than a failure. An ambiguous name is a question for the user,
 * not a guess: `"flash"` matching two Gemini releases is exactly the case where
 * a human should choose. An unknown name is refused instead, because a name
 * matching nothing is a mistake rather than a decision, and turning every typo
 * into a dialog would train the user to dismiss them.
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
		throw new Error(
			`Unknown model "${query}". Available models: ` +
				`${resolved.available.join(", ")}.`,
		);
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
export function buildToolDescription(agents: AgentConfig[]): string {
	// How to name a subagent, wherever its character comes from. Stated in both
	// branches because the naming rule is what keeps the user out of it, and a
	// caller reading only the empty-project text would never see it.
	const naming = [
		"",
		"To delegate to a character no agent file describes, supply",
		"system_prompt with its instructions, a short one-word name, and",
		"optionally tools to limit what it may use. Invent the name yourself —",
		"a distinct one for each subagent you start — and never ask the user",
		"for one.",
	];

	if (agents.length === 0) {
		return [
			"Delegate a task to a focused subagent, which runs on its own and",
			"returns a single answer. No agent files are defined for this",
			"project, so every subagent here is one you describe yourself.",
			...naming,
		].join("\n");
	}

	const lines = agents.map(
		(agent) => `- ${agent.name}: ${agent.description} (${agent.source})`,
	);
	return [
		"Delegate a task to a focused subagent, which runs on its own and",
		"returns a single answer. Available subagent types:",
		"",
		...lines,
		...naming,
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

/**
 * The spawn parameters that choosing a definition depends on.
 *
 * Declared structurally rather than taken from the schema: the schema is inline
 * in `defineTool`, so there is no named type to derive from without lifting it
 * out, and only these five fields matter here.
 */
interface SpawnRoute {
	subagent_type?: string;
	system_prompt?: string;
	name?: string;
	tools?: string[];
	description: string;
}

/**
 * The definition a spawn call asks for, by whichever of the two routes it took.
 *
 * A supplied `system_prompt` is the character, whatever else the call carries.
 * An agent file is what a call with no prompt of its own falls back to — by the
 * type it named, and only then. The plain-schema rule leaves no way to say "one
 * of these" in the schema, and a refusal in its place cost the user the
 * subagent they had asked for: see `shadowedFile` for what is said instead.
 */
export function resolveSpawnConfig(
	params: SpawnRoute,
	agents: AgentConfig[],
): AgentConfig {
	const supplied = params.system_prompt?.trim();
	const type = params.subagent_type?.trim();

	if (!supplied) {
		if (!type) {
			throw new Error(
				"Name a subagent_type from the list, or supply a system_prompt " +
					"describing the subagent you want.",
			);
		}

		const config = agents.find((agent) => agent.name === type);
		if (!config) {
			// "Known types: ." is no help to a project that has none, and the way
			// out of that case is the other route rather than a different name.
			throw new Error(
				agents.length === 0
					? "No agent files are defined for this project, so there is no " +
							`subagent type "${type}". Supply a system_prompt describing ` +
							"the subagent you want instead."
					: `Unknown subagent type "${type}". ` +
							`Known types: ${agents.map((agent) => agent.name).join(", ")}.`,
			);
		}
		return config;
	}

	// `assignHandle` slugs whatever it is given, so a name left out can fall
	// back to the description without slugging anything here. A type named
	// alongside a prompt comes first, being the short word the description is
	// not: a caller that filled in both fields still said what to call this.
	// The handle a description yields is ugly — three to five words — and that
	// is the point: refusing would send the caller back to the user for a name,
	// which is the one outcome this route exists to avoid.
	const name = params.name?.trim() || type || params.description;

	return {
		name,
		description: params.description,
		systemPrompt: supplied,
		tools: params.tools,
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
		// Dismissing the dialog leaves the parent's model in play. Saying so keeps
		// that from being an invisible decision.
		parts.push(
			"No model was chosen for this subagent, so it is running on the " +
				"current model.",
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
					"the background and its result will arrive here on its own. Carry " +
					`on with other work; call ${RESULT_TOOL_NAME} with that id to read ` +
					"the result before then.",
	);

	return parts.join("\n\n");
}

export function createSpawnTool(deps: SpawnToolDeps) {
	return defineTool({
		name: SPAWN_TOOL_NAME,
		label: "Spawn Subagent",
		description: buildToolDescription(deps.discover(process.cwd())),
		// Plain types and explicit fields only — no `anyOf` or conditional schema
		// constructs, per the specification's provider-compatibility decision.
		parameters: Type.Object({
			subagent_type: Type.Optional(
				Type.String({
					description:
						"Name of the subagent to delegate to, from the list above. " +
						"Omit it when supplying system_prompt instead: a supplied " +
						"system_prompt is always what the subagent runs under, and a " +
						"type named alongside one is read only as its name.",
				}),
			),
			system_prompt: Type.Optional(
				Type.String({
					description:
						"Instructions defining this subagent's character, used instead " +
						"of an agent file. Supply this when no listed subagent type " +
						"fits the work; the subagent runs under it and nothing else.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"A short one-word name for this subagent, which becomes the " +
						"handle the user types after @ to reach it. Choose it " +
						"yourself — a distinct one for each subagent you start — and " +
						"never ask the user for one. Only read alongside " +
						"system_prompt.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"The tools this subagent may use, by name. Defaults to the " +
						"session's own tools. Only read alongside system_prompt.",
				}),
			),
			prompt: Type.String({
				description:
					"The task for the subagent. It cannot see this conversation, so " +
					"the prompt must be self-contained.",
			}),
			description: Type.String({
				description: "3-5 words describing the task, shown in the UI.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"Model for this subagent. Partial names work (e.g. 'flash'). " +
						"Defaults to the current model.",
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
					description:
						"Turns before the subagent is told to wrap up. Defaults to " +
						`whatever its agent file sets, or ${DEFAULT_MAX_TURNS}.`,
				}),
			),
		}),

		// `signal` is still read — the model dialog must die with the turn — but it
		// is deliberately not handed to the run itself. See `startSubagent`.
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// A subagent must not spawn subagents; that would fork the host
			// process without bound.
			if (inChildContext()) {
				throw new Error(
					"A subagent cannot spawn further subagents. Do the work directly.",
				);
			}

			// No guard on an empty agent list: a project with no agent files can
			// still delegate by supplying a character, and `resolveSpawnConfig`
			// refuses a call that does neither.
			const agents = deps.discover(ctx.cwd);
			const config = resolveSpawnConfig(params, agents);

			const { tools, unknownTools } = checkToolNames(
				config.tools,
				deps.getKnownTools(),
			);

			// Resolved before the run starts, so an unusable model name refuses
			// the call instead of failing partway into a session.
			const choice = await chooseModel(
				ctx,
				config.name,
				params.model ?? config.model,
				signal,
			);

			// Not awaited: the subagent is launched and the call is over. Its answer
			// comes back as a message of its own when there is one.
			const record = startSubagent({
				ctx,
				// The caller's turn limit wins; the agent file's applies otherwise;
				// naming neither leaves the subagent unlimited.
				config: {
					...config,
					tools,
					maxTurns: params.max_turns ?? config.maxTurns,
				},
				prompt: params.prompt,
				description: params.description,
				model: choice.model,
				// The caller's choice wins; the agent file's applies otherwise;
				// naming neither inherits the parent's.
				thinkingLevel: (params.thinking as ThinkingLevel) ?? config.thinking,
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
 * Reading a subagent's answer back on demand.
 *
 * The answer arrives on its own when the subagent finishes, so this exists for
 * the model that wants it sooner, or that has been handed an id and no longer
 * has the notice in view.
 */
export function createResultTool(deps: { registry: SubagentRegistry }) {
	return defineTool({
		name: RESULT_TOOL_NAME,
		label: "Get Subagent Result",
		description:
			"Read the result of a subagent started with " +
			`${SPAWN_TOOL_NAME}, by the id that returned. A subagent still ` +
			"working has no result yet; its answer arrives on its own when it " +
			"finishes, so there is no need to poll for it.",
		parameters: Type.Object({
			id: Type.String({
				description: `The id ${SPAWN_TOOL_NAME} returned.`,
			}),
		}),

		async execute(_toolCallId, params) {
			const record = requireRecord(deps.registry, params.id);

			const text = record.outcome
				? describeCompletion(record, record.outcome)
				: `Subagent "${record.type}" (${record.id}) is still working. ` +
					"Its result will arrive here when it finishes.";

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
	});
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
			"No subagents have been started in this session. " +
			`Start one with ${SPAWN_TOOL_NAME}.`
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
		description:
			"Every subagent started in this session, with its status. Read this " +
			`rather than calling ${RESULT_TOOL_NAME} on each id in turn when ` +
			"several subagents were started together and their results are meant " +
			"to be read as a set.",
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
	});
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
		description:
			`Redirect a running subagent, by the id ${SPAWN_TOOL_NAME} returned. ` +
			"The message lands after the subagent's current turn and before its " +
			"next model call, so it changes what the subagent does next rather " +
			"than starting it over. A subagent still waiting for a slot takes the " +
			"message into the task it starts on. A subagent that has already " +
			"finished cannot be steered.",
		parameters: Type.Object({
			id: Type.String({
				description: `The id ${SPAWN_TOOL_NAME} returned.`,
			}),
			message: Type.String({
				description:
					"The new instruction. The subagent cannot see this conversation, " +
					"so the message must be self-contained.",
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
		description:
			`Halt a subagent, by the id ${SPAWN_TOOL_NAME} returned. Whatever it ` +
			`had worked out is kept, and ${RESULT_TOOL_NAME} will return it, ` +
			"marked as incomplete. A subagent that has not started yet is " +
			"dropped before it does. Use this for work that is no longer wanted " +
			"— a subagent that is merely slow will finish on its own.",
		parameters: Type.Object({
			id: Type.String({
				description: `The id ${SPAWN_TOOL_NAME} returned.`,
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

	pi.registerTool(
		createSpawnTool({
			discover: discoverAgents,
			run: runSubagent,
			// Read lazily: other extensions register tools too, and the full set
			// is only settled once the session is running.
			getKnownTools: () => pi.getAllTools().map((tool) => tool.name),
			registry,
			queue,
			sendMessage,
		}),
	);

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

		/**
		 * Show one subagent's conversation over the session, until it is closed.
		 *
		 * `ctx.ui.custom` hands the view the keyboard and resolves when the view
		 * calls the `done` it was given, which is what the list waits on before it
		 * starts taking keys again.
		 */
		const openViewer = (record: SubagentRecord): Promise<void> =>
			ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new SubagentViewer({
						record,
						registry,
						theme,
						tui,
						cwd: ctx.cwd,
						close: () => done(),
						steer: (steering, message) =>
							steerSubagent(steering, message, { registry }),
						stop: (stopping) =>
							stopFromUi(stopping, { registry, queue }, sendMessage),
					}),
				{
					overlay: true,
					// Wide enough for a transcript to read as prose, and short enough
					// that the session it belongs to stays visible around it.
					overlayOptions: { width: "90%", maxHeight: "85%" },
				},
			);

		ctx.ui.setWidget(
			SUBAGENT_LIST_WIDGET,
			// Built per mount rather than once: the theme arrives here, and a theme
			// change remounts the widget with the new one.
			(tui, theme) =>
				new SubagentList({
					registry,
					theme,
					requestRender: () => tui.requestRender(),
					// The list never holds focus, so an input listener is the only way
					// arrow keys reach it. It reads the prompt to decide whether an
					// arrow was meant for the list or for the cursor.
					addInputListener: (listener) => tui.addInputListener(listener),
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
