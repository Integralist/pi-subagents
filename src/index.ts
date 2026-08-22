/**
 * pi-subagents — delegate work to focused subagents that run as nested
 * in-process sessions.
 *
 * Registers four tools, all of which speak in the id that `spawn_subagent`
 * returns. `spawn_subagent` takes the name of an agent defined under
 * `.pi/agents/` and a task for it, and returns that id straight away — the
 * subagent then works in the background and its answer arrives in the
 * conversation on its own. `get_subagent_result` reads that answer back on
 * demand, for a caller that would rather ask than wait to be told.
 * `steer_subagent` redirects one mid-run, and `stop_subagent` halts one while
 * keeping whatever it had worked out.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { steerSubagent, stopSubagent } from "./control.ts";
import { modelLabel, resolveModel } from "./model-resolver.ts";
import { resolveConcurrencyLimit, SubagentQueue } from "./queue.ts";
import { type SubagentRecord, SubagentRegistry } from "./registry.ts";
import { inChildContext, runSubagent } from "./runner.ts";
import {
	COMPLETE_MESSAGE_TYPE,
	describeCompletion,
	type RunSubagentFn,
	renderCompletion,
	type SendMessage,
	startSubagent,
} from "./spawn.ts";
import { DEFAULT_MAX_TURNS } from "./turns.ts";
import { SubagentList } from "./ui/subagent-list.ts";

export const SPAWN_TOOL_NAME = "spawn_subagent";
export const RESULT_TOOL_NAME = "get_subagent_result";
export const STEER_TOOL_NAME = "steer_subagent";
export const STOP_TOOL_NAME = "stop_subagent";

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
	if (agents.length === 0) {
		return [
			"Delegate a task to a focused subagent.",
			"There are no subagents defined for this project, so this tool",
			"cannot be used yet. Define one as a Markdown file with YAML",
			"frontmatter under .pi/agents/.",
		].join(" ");
	}

	const lines = agents.map(
		(agent) => `- ${agent.name}: ${agent.description} (${agent.source})`,
	);
	return [
		"Delegate a task to a focused subagent, which runs on its own and",
		"returns a single answer. Available subagent types:",
		"",
		...lines,
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
): string {
	const parts: string[] = [];

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
			subagent_type: Type.String({
				description: "Name of the subagent to delegate to.",
			}),
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

			const agents = deps.discover(ctx.cwd);
			if (agents.length === 0) {
				throw new Error(
					"There are no subagents defined for this project. Define one as a " +
						"Markdown file with YAML frontmatter under .pi/agents/.",
				);
			}

			const config = agents.find(
				(agent) => agent.name === params.subagent_type,
			);
			if (!config) {
				throw new Error(
					`Unknown subagent type "${params.subagent_type}". ` +
						`Known types: ${agents.map((agent) => agent.name).join(", ")}.`,
				);
			}

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
						text: describeStart(record, unknownTools, choice),
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
			"than starting it over. A subagent that has already finished cannot " +
			"be steered.",
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
			const result = await steerSubagent(record, params.message);
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

export default function (pi: ExtensionAPI): void {
	// One registry for the session, shared by the tool that fills it and the
	// tool that reads it, and one queue holding them all to the limit.
	const registry = new SubagentRegistry();
	const queue = new SubagentQueue(configuredLimit(process.cwd()));

	pi.registerTool(
		createSpawnTool({
			discover: discoverAgents,
			run: runSubagent,
			// Read lazily: other extensions register tools too, and the full set
			// is only settled once the session is running.
			getKnownTools: () => pi.getAllTools().map((tool) => tool.name),
			registry,
			queue,
			// Bound, because it is called later from a background continuation
			// that has no `pi` of its own.
			sendMessage: pi.sendMessage.bind(pi),
		}),
	);

	pi.registerTool(createResultTool({ registry }));
	pi.registerTool(createSteerTool({ registry }));
	pi.registerTool(createStopTool({ registry, queue }));
	pi.registerMessageRenderer(COMPLETE_MESSAGE_TYPE, renderCompletion);

	// The list is a terminal widget, so it is mounted once the session is up and
	// only when there is a terminal to mount it in. `print`, `json` and `rpc`
	// runs have no editor to sit below and nothing to redraw.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}

		ctx.ui.setWidget(
			SUBAGENT_LIST_WIDGET,
			// Built per mount rather than once: the theme arrives here, and a theme
			// change remounts the widget with the new one.
			(tui, theme) =>
				new SubagentList({
					registry,
					theme,
					requestRender: () => tui.requestRender(),
				}),
			{ placement: "belowEditor" },
		);
	});
}
