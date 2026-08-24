/**
 * Agent discovery.
 *
 * An agent is a Markdown file with YAML frontmatter. Files are read from two
 * places, project overriding user on a name collision:
 *
 *   1. `<agentDir>/agents/*.md` — the user's own agents, shared across projects
 *   2. `<project>/.pi/agents/*.md` — agents belonging to one checkout
 *
 * Nothing here throws. Discovery runs before the main agent can offer any
 * subagent at all, so one unreadable or malformed file must never hide every
 * other agent in the same directory.
 */

import {
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

/**
 * Which tier an agent file came from, or that it came from no file at all.
 *
 * `inline` is load-bearing rather than descriptive: continuing a subagent
 * branches on it to decide whether to re-read a file or trust the definition
 * stored on the record. Nothing in this module produces it — a definition
 * supplied when a subagent is started does.
 */
export type AgentSource = "user" | "project" | "inline";

export interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	color?: string;
	maxTurns?: number;
	wakeOnFinish?: boolean;
	source: AgentSource;
	/** Absent for a definition supplied at spawn time, which has no file. */
	filePath?: string;
}

/**
 * Raw frontmatter as the YAML parser hands it over. Every field is `unknown`
 * because a Markdown file can put anything under any key, so each one is
 * checked before it reaches an `AgentConfig`.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies that constraint.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	color?: unknown;
	maxTurns?: unknown;
};

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	// "off" included: pi accepts it, and its own `--thinking` flag offers it.
	// A bare `off` in YAML is boolean false, so an agent file must quote it.
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Normalise a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * Anything else — a number, a map, a nested list — yields no tools rather than
 * throwing.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const tools = raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: undefined;
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return THINKING_LEVELS.find((level) => level === value);
}

/**
 * A turn limit is only meaningful as a positive whole number. A zero, a
 * fraction, or a word is dropped so the runner falls back to its default
 * rather than inheriting nonsense.
 */
function parseMaxTurns(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function toAgentConfig(
	frontmatter: AgentFrontmatter,
	body: string,
	source: AgentSource,
	filePath: string,
): AgentConfig | undefined {
	const name = parseString(frontmatter.name);
	const description = parseString(frontmatter.description);
	if (!name || !description) {
		return undefined;
	}

	return {
		name,
		description,
		systemPrompt: body.trim(),
		tools: parseToolList(frontmatter.tools),
		model: parseString(frontmatter.model),
		thinking: parseThinkingLevel(frontmatter.thinking),
		color: parseString(frontmatter.color),
		maxTurns: parseMaxTurns(frontmatter.maxTurns),
		source,
		filePath,
	};
}

/**
 * Read one agent file, or nothing at all.
 *
 * `parseFrontmatter` runs a real YAML parser and throws on invalid syntax, so
 * the read and the parse share one guard: a file that cannot be read or cannot
 * be parsed is simply not an agent.
 */
function loadAgentFile(
	filePath: string,
	source: AgentSource,
): AgentConfig | undefined {
	try {
		const content = readFileSync(filePath, "utf8");
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		return toAgentConfig(frontmatter, body, source, filePath);
	} catch {
		return undefined;
	}
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!existsSync(dir)) {
		return [];
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const config = loadAgentFile(join(dir, entry.name), source);
		if (config) {
			agents.push(config);
		}
	}

	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walk up from `cwd` looking for `.pi/agents`, so discovery works the same way
 * from the repository root and from a directory deep inside it.
 */
function findNearestProjectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) {
			return candidate;
		}

		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * Every agent available to this session, the nearest tier winning any name
 * collision, sorted by name so the tool description built from these names
 * does not shuffle between runs.
 */
export function discoverAgents(cwd: string): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();

	for (const config of loadAgentsFromDir(
		join(getAgentDir(), "agents"),
		"user",
	)) {
		byName.set(config.name, config);
	}

	const projectDir = findNearestProjectAgentsDir(cwd);
	if (projectDir) {
		for (const config of loadAgentsFromDir(projectDir, "project")) {
			byName.set(config.name, config);
		}
	}

	return Array.from(byName.values()).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}
