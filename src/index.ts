/**
 * pi-subagents — delegate work to focused subagents that run as nested
 * in-process sessions.
 *
 * Registers `spawn_subagent`, which the main agent calls with the name of an
 * agent defined under `.pi/agents/` and a task for it.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { modelLabel, resolveModel } from "./model-resolver.ts";
import { inChildContext, runSubagent, type SubagentOutcome } from "./runner.ts";

export const SPAWN_TOOL_NAME = "spawn_subagent";

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

/** What the tool reports back for logs and, from Slice 3, the subagent list. */
export interface SpawnDetails {
	agent: string;
	status: SubagentOutcome["status"];
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
	run: (opts: {
		ctx: ExtensionContext;
		config: AgentConfig;
		prompt: string;
		model?: Model<Api>;
		thinkingLevel?: ThinkingLevel;
		signal?: AbortSignal;
	}) => Promise<SubagentOutcome>;
	getKnownTools: () => string[];
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

/** Render an outcome as text for the model. */
function describeOutcome(
	agentName: string,
	outcome: SubagentOutcome,
	unknownTools: string[],
	choice: ModelChoice,
): string {
	const parts: string[] = [];

	if (choice.fellBack) {
		// Dismissing the dialog leaves the parent's model in play. Saying so keeps
		// that from being an invisible decision.
		parts.push(
			"No model was chosen for this subagent, so it ran on the current " +
				"model.",
		);
	}

	if (unknownTools.length > 0) {
		parts.push(
			`Warning: subagent "${agentName}" asks for unknown tool(s) ` +
				`${unknownTools.join(", ")}; they were ignored.`,
		);
	}

	if (outcome.status === "failed") {
		// Reported verbatim: an outcome's `error` already names its agent, so
		// prefixing here would say "reviewer" twice.
		parts.push(
			outcome.error ??
				`The "${agentName}" subagent failed for no stated reason.`,
		);
	} else if (outcome.status === "stopped") {
		parts.push(`The "${agentName}" subagent was stopped before finishing.`);
	}

	if (outcome.output) {
		parts.push(outcome.output);
	} else if (outcome.status === "completed") {
		parts.push(`The "${agentName}" subagent finished without saying anything.`);
	}

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
		}),

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

			const outcome = await deps.run({
				ctx,
				config: { ...config, tools },
				prompt: params.prompt,
				model: choice.model,
				// The caller's choice wins; the agent file's applies otherwise;
				// naming neither inherits the parent's.
				thinkingLevel: (params.thinking as ThinkingLevel) ?? config.thinking,
				signal,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: describeOutcome(config.name, outcome, unknownTools, choice),
					},
				],
				details: {
					agent: config.name,
					status: outcome.status,
					description: params.description,
					unknownTools,
				} satisfies SpawnDetails,
			};
		},
	});
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool(
		createSpawnTool({
			discover: discoverAgents,
			run: runSubagent,
			// Read lazily: other extensions register tools too, and the full set
			// is only settled once the session is running.
			getKnownTools: () => pi.getAllTools().map((tool) => tool.name),
		}),
	);
}
