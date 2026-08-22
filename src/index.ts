/**
 * pi-subagents — delegate work to focused subagents that run as nested
 * in-process sessions.
 *
 * Registers `spawn_subagent`, which the main agent calls with the name of an
 * agent defined under `.pi/agents/` and a task for it.
 */

import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { inChildContext, runSubagent, type SubagentOutcome } from "./runner.ts";

export const SPAWN_TOOL_NAME = "spawn_subagent";

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
		thinkingLevel?: AgentConfig["thinking"];
		signal?: AbortSignal;
	}) => Promise<SubagentOutcome>;
	getKnownTools: () => string[];
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
): string {
	const parts: string[] = [];

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

			const outcome = await deps.run({
				ctx,
				// The agent's own model is a name, and resolving a name to a model
				// arrives with `resolveModel` in Slice 2. Effort needs no
				// resolution, so it is honoured now.
				config: { ...config, tools },
				prompt: params.prompt,
				thinkingLevel: config.thinking,
				signal,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: describeOutcome(config.name, outcome, unknownTools),
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
