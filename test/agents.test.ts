import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentConfig, discoverAgents } from "../src/agents.ts";

/**
 * `getAgentDir()` reads this environment variable on every call, so setting it
 * per-test isolates discovery from the developer's real `~/.pi/agent`.
 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

let tmpRoot: string;
let userAgentDir: string;
let projectRoot: string;
let projectAgentDir: string;
let savedAgentDirEnv: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));

	userAgentDir = join(tmpRoot, "user-agent-dir", "agents");
	mkdirSync(userAgentDir, { recursive: true });

	projectRoot = join(tmpRoot, "project");
	projectAgentDir = join(projectRoot, ".pi", "agents");
	mkdirSync(projectAgentDir, { recursive: true });

	savedAgentDirEnv = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(tmpRoot, "user-agent-dir");
});

afterEach(() => {
	if (savedAgentDirEnv === undefined) {
		delete process.env[AGENT_DIR_ENV];
	} else {
		process.env[AGENT_DIR_ENV] = savedAgentDirEnv;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAgent(dir: string, fileName: string, contents: string): void {
	writeFileSync(join(dir, fileName), contents, "utf8");
}

function agent(name: string, description = `does ${name} things`): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`;
}

function byName(agents: AgentConfig[]): string[] {
	return agents.map((a) => a.name);
}

describe("discoverAgents", () => {
	// The plan's acceptance criterion for Task 1.3, quoted.
	it("given a directory with two agent files and one malformed, returns two configs and throws nothing", () => {
		writeAgent(projectAgentDir, "reviewer.md", agent("reviewer"));
		writeAgent(projectAgentDir, "tester.md", agent("tester"));
		// Unparseable YAML. Verified to make parseFrontmatter throw YAMLParseError.
		writeAgent(
			projectAgentDir,
			"broken.md",
			"---\nname: [unclosed\n  x: : :\n---\nbody\n",
		);

		const agents = discoverAgents(projectRoot);

		expect(byName(agents)).toEqual(["reviewer", "tester"]);
	});

	it("skips a file missing name or description rather than failing the scan", () => {
		writeAgent(projectAgentDir, "good.md", agent("good"));
		writeAgent(
			projectAgentDir,
			"no-name.md",
			"---\ndescription: nameless\n---\nbody\n",
		);
		writeAgent(
			projectAgentDir,
			"no-desc.md",
			"---\nname: descriptionless\n---\nbody\n",
		);
		writeAgent(
			projectAgentDir,
			"no-frontmatter.md",
			"just a body, no frontmatter\n",
		);

		expect(byName(discoverAgents(projectRoot))).toEqual(["good"]);
	});

	it("lets a project agent override a user agent of the same name", () => {
		writeAgent(userAgentDir, "reviewer.md", agent("reviewer", "the user copy"));
		writeAgent(
			projectAgentDir,
			"reviewer.md",
			agent("reviewer", "the project copy"),
		);

		const agents = discoverAgents(projectRoot);

		expect(agents).toHaveLength(1);
		expect(agents[0]?.description).toBe("the project copy");
		expect(agents[0]?.source).toBe("project");
	});

	it("returns agents from both sources when their names differ", () => {
		writeAgent(userAgentDir, "user-only.md", agent("user-only"));
		writeAgent(projectAgentDir, "project-only.md", agent("project-only"));

		const agents = discoverAgents(projectRoot);

		expect(byName(agents)).toEqual(["project-only", "user-only"]);
		expect(agents.find((a) => a.name === "user-only")?.source).toBe("user");
	});

	it("finds the project agents directory from a nested working directory", () => {
		writeAgent(projectAgentDir, "reviewer.md", agent("reviewer"));
		const nested = join(projectRoot, "src", "deep", "deeper");
		mkdirSync(nested, { recursive: true });

		expect(byName(discoverAgents(nested))).toEqual(["reviewer"]);
	});

	it("returns an empty list when no agent directory exists", () => {
		const bare = join(tmpRoot, "bare");
		mkdirSync(bare, { recursive: true });
		process.env[AGENT_DIR_ENV] = join(tmpRoot, "does-not-exist");

		expect(discoverAgents(bare)).toEqual([]);
	});

	it("ignores files that are not Markdown", () => {
		writeAgent(projectAgentDir, "reviewer.md", agent("reviewer"));
		writeAgent(projectAgentDir, "notes.txt", agent("notes"));
		writeAgent(projectAgentDir, "config.yaml", agent("config"));

		expect(byName(discoverAgents(projectRoot))).toEqual(["reviewer"]);
	});

	it("sorts agents by name so the generated tool description is stable", () => {
		// The file names are numbered so that directory order (which is
		// alphabetical by file name) disagrees with the expected agent order.
		// Naming the files after the agents would let this pass unsorted.
		writeAgent(projectAgentDir, "01-zebra.md", agent("zebra"));
		writeAgent(projectAgentDir, "02-alpha.md", agent("alpha"));
		writeAgent(projectAgentDir, "03-middle.md", agent("middle"));

		expect(byName(discoverAgents(projectRoot))).toEqual([
			"alpha",
			"middle",
			"zebra",
		]);
	});

	it("keeps the body as the system prompt and records the file path", () => {
		writeAgent(projectAgentDir, "reviewer.md", agent("reviewer"));

		const found = discoverAgents(projectRoot)[0];

		expect(found?.systemPrompt).toBe("You are reviewer.");
		expect(found?.filePath).toBe(join(projectAgentDir, "reviewer.md"));
	});
});

describe("discoverAgents frontmatter fields", () => {
	it("accepts a tools list written as a YAML array or a comma-separated string", () => {
		writeAgent(
			projectAgentDir,
			"array.md",
			"---\nname: array\ndescription: d\ntools: [read, bash]\n---\nb\n",
		);
		writeAgent(
			projectAgentDir,
			"string.md",
			"---\nname: string\ndescription: d\ntools: read, bash\n---\nb\n",
		);

		const agents = discoverAgents(projectRoot);

		expect(agents.find((a) => a.name === "array")?.tools).toEqual([
			"read",
			"bash",
		]);
		expect(agents.find((a) => a.name === "string")?.tools).toEqual([
			"read",
			"bash",
		]);
	});

	it("leaves tools undefined when the value is neither a list nor a string", () => {
		writeAgent(
			projectAgentDir,
			"odd.md",
			"---\nname: odd\ndescription: d\ntools: 42\n---\nb\n",
		);

		expect(discoverAgents(projectRoot)[0]?.tools).toBeUndefined();
	});

	it("reads model, colour, and max turns when present", () => {
		writeAgent(
			projectAgentDir,
			"full.md",
			"---\nname: full\ndescription: d\nmodel: opus\ncolor: blue\nmaxTurns: 12\n---\nb\n",
		);

		const found = discoverAgents(projectRoot)[0];

		expect(found?.model).toBe("opus");
		expect(found?.color).toBe("blue");
		expect(found?.maxTurns).toBe(12);
	});

	it("accepts every thinking level Pi defines", () => {
		// Including "off", which pi's own `--thinking` flag accepts.
		for (const level of [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]) {
			writeAgent(
				projectAgentDir,
				`${level}.md`,
				`---\nname: ${level}\ndescription: d\nthinking: "${level}"\n---\nb\n`,
			);
		}

		const agents = discoverAgents(projectRoot);

		expect(agents).toHaveLength(7);
		for (const found of agents) {
			expect(found.thinking).toBe(found.name);
		}
	});

	it("reads an unquoted `thinking: off` as the string it looks like", () => {
		// Pi parses with yaml 2.x, which follows YAML 1.2: only `true` and
		// `false` are booleans. The YAML 1.1 habit of reading off/on/yes/no as
		// booleans does not apply, so no quoting is needed.
		writeAgent(
			projectAgentDir,
			"bare.md",
			"---\nname: bare\ndescription: d\nthinking: off\n---\nb\n",
		);

		expect(discoverAgents(projectRoot)[0]?.thinking).toBe("off");
	});

	it("drops a thinking level given as a real YAML boolean", () => {
		writeAgent(
			projectAgentDir,
			"boolish.md",
			"---\nname: boolish\ndescription: d\nthinking: false\n---\nb\n",
		);

		expect(discoverAgents(projectRoot)[0]?.thinking).toBeUndefined();
	});

	it("drops a thinking level Pi does not define rather than passing it through", () => {
		writeAgent(
			projectAgentDir,
			"bad.md",
			"---\nname: bad\ndescription: d\nthinking: ludicrous\n---\nb\n",
		);

		expect(discoverAgents(projectRoot)[0]?.thinking).toBeUndefined();
	});

	it("drops a max turns value that is not a positive whole number", () => {
		writeAgent(
			projectAgentDir,
			"zero.md",
			"---\nname: zero\ndescription: d\nmaxTurns: 0\n---\nb\n",
		);
		writeAgent(
			projectAgentDir,
			"negative.md",
			"---\nname: negative\ndescription: d\nmaxTurns: -3\n---\nb\n",
		);
		writeAgent(
			projectAgentDir,
			"fraction.md",
			"---\nname: fraction\ndescription: d\nmaxTurns: 2.5\n---\nb\n",
		);
		writeAgent(
			projectAgentDir,
			"text.md",
			"---\nname: text\ndescription: d\nmaxTurns: lots\n---\nb\n",
		);

		for (const found of discoverAgents(projectRoot)) {
			expect(found.maxTurns, found.name).toBeUndefined();
		}
	});
});
