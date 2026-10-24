import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type SubagentRecord, SubagentRegistry } from "../../src/registry.ts";
import {
	drawBox,
	FlightdeckPane,
	renderRail,
} from "../../src/ui/flightdeck.ts";
import {
	appendLog,
	completeTurn,
	createFlightdeckState,
	type FlightdeckState,
	startTurn,
} from "../../src/ui/flightdeck-state.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "sub-1",
		handle: "explore",
		type: "explore",
		config: {
			name: "explore",
			description: "explores code",
			systemPrompt: "Explore.",
			source: "project",
		},
		description: "Map hooks to state",
		status: "running",
		color: "cyan",
		startedAt: 1_000,
		contextPercent: 25,
		contextTokens: 50_000,
		outputTokens: 1_200,
		turns: 3,
		model: "claude-sonnet-4-5",
		...overrides,
	};
}

describe("FlightdeckPane", () => {
	it("renders main vitals, side-by-side agent cards when they fit, receipt, and session log within width", () => {
		const registry = new SubagentRegistry(() => 16_000);
		registry.add(
			makeRecord({ id: "sub-1", handle: "explore", startedAt: 1_000 }),
		);
		registry.add(
			makeRecord({
				id: "sub-2",
				handle: "reviewer",
				description: "Review README",
				status: "completed",
				startedAt: 2_000,
				finishedAt: 13_000,
			}),
		);

		let state: FlightdeckState = {
			...createFlightdeckState(),
			model: "claude-opus-4-6",
			effort: "medium",
			steps: 7,
			isRunning: false,
			tokens: 667_000,
			contextWindow: 1_000_000,
			contextPercent: 67,
			compactions: 1,
			costUsd: 104,
		};
		state = startTurn(state, 9_000);
		state = { ...state, costUsd: 104.15 };
		state = completeTurn(state, {
			endedAt: 16_000,
			agentsSpawned: 2,
			reason: "answer",
		});
		state = appendLog(state, {
			at: 16_000,
			who: "main",
			text: "write → docs/spec.md",
			kind: "info",
			agentId: null,
		});

		const pane = new FlightdeckPane({
			registry,
			getState: () => state,
			theme: plainTheme,
			placement: "docked",
			rows: () => 40,
			now: () => 16_000,
			railPhase: () => 2,
		});

		const raw = pane.render(66);
		const lines = raw.map(stripTerminalSequences);
		const text = lines.join("\n");

		for (const line of raw) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(66);
		}
		expect(text).toContain("FLIGHTDECK");
		expect(text).toContain("Opus 4.6 · main");
		expect(text).toContain("effort ▮▮▯▯ medium");
		expect(text).toContain("8 req");
		expect(text).toContain("67% 667k/1.0M");
		expect(text).toContain("$104");
		expect(text).toContain("agents · 1 running · 2 total");
		expect(text).toContain("Map hooks to");
		expect(text).toContain("Review README");
		expect(text).toContain("ctx 50k · out 1k · 3 st");
		expect(text).toContain(
			"last turn 7s · 2 subagents · 0 edits · 0 errors · +$0.15",
		);
		expect(text).toContain("session log");
		expect(text).toContain("write → docs/spec.md");
	});

	it("switches to swimlanes when subagent count exceeds card capacity and renders expanded detail", () => {
		const registry = new SubagentRegistry(() => 20_000);
		for (let i = 1; i <= 5; i++) {
			registry.add(
				makeRecord({
					id: `sub-${i}`,
					handle: `agent-${i}`,
					description: `Task number ${i}`,
					status: "completed",
					startedAt: i * 1_000,
					finishedAt: i * 1_000 + 8_000,
					toolCalls: [{ text: "read → src/index.ts", isError: false }],
					outcome: {
						status: "completed",
						output: "All checks passed cleanly.",
					},
				}),
			);
		}

		const state: FlightdeckState = {
			...createFlightdeckState(),
			model: "claude-opus-4-6",
			expandedAgentId: "sub-2",
		};

		const pane = new FlightdeckPane({
			registry,
			getState: () => state,
			theme: plainTheme,
			placement: "docked",
			rows: () => 40,
			now: () => 20_000,
		});

		const raw = pane.render(52);
		for (const line of raw) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(52);
		}
		const text = raw.map(stripTerminalSequences).join("\n");
		expect(text).toContain("agents · 0 running · 5 total");
		expect(text).toContain("1-5 expand");
		expect(text).toContain("1: Task number 1");
		expect(text).toContain("2: Task number 2");
		expect(text).toContain("· read → src/index.ts");
		expect(text).toContain("» All checks passed cleanly.");
	});

	it("renders at most 8 rows in inline mini mode", () => {
		const registry = new SubagentRegistry(() => 10_000);
		for (let i = 1; i <= 4; i++) {
			registry.add(
				makeRecord({
					id: `sub-${i}`,
					handle: `agent-${i}`,
					description: `Mini task ${i}`,
					startedAt: i * 1_000,
				}),
			);
		}
		const state: FlightdeckState = {
			...createFlightdeckState(),
			model: "claude-opus-4-6",
			tokens: 500_000,
			contextWindow: 1_000_000,
			contextPercent: 50,
			costUsd: 12.5,
		};

		const pane = new FlightdeckPane({
			registry,
			getState: () => state,
			theme: plainTheme,
			placement: "inline",
			now: () => 10_000,
		});

		const lines = pane.render(80).map(stripTerminalSequences);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("Opus 4.6");
		expect(lines.join("\n")).toContain("+1 more subagents");
	});

	it("renders side-by-side columns in wide layout", () => {
		const registry = new SubagentRegistry(() => 20_000);
		registry.add(
			makeRecord({
				id: "sub-1",
				handle: "agent-1",
				description: "agent-1 task",
			}),
		);
		const state: FlightdeckState = {
			...createFlightdeckState(),
			model: "claude-sonnet-4-5",
			layout: "wide",
		};
		const pane = new FlightdeckPane({
			registry,
			getState: () => state,
			theme: plainTheme,
			now: () => 20_000,
		});
		const raw = pane.render(120);
		for (const line of raw) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
		const text = raw.map(stripTerminalSequences).join("\n");
		expect(text).toContain("FLIGHTDECK");
		expect(text).toContain("Sonnet 4.5 · main");
		expect(text).toContain("agent-1");
	});

	it("renders active turn elapsed clock when running", () => {
		const registry = new SubagentRegistry(() => 20_000);
		let state: FlightdeckState = {
			...createFlightdeckState(),
			model: "claude-opus-4-6",
		};
		state = startTurn(state, 10_000);
		const pane = new FlightdeckPane({
			registry,
			getState: () => state,
			theme: plainTheme,
			now: () => 25_000,
		});
		const text = pane.render(60).map(stripTerminalSequences).join("\n");
		expect(text).toContain("● running turn 15s");
	});

	it("exports working renderRail and drawBox helpers", () => {
		const rail = renderRail(20, false, 0, plainTheme, [5, 15], false);
		expect(visibleWidth(rail)).toBe(20);
		expect(rail[5]).toBe("┬");
		expect(rail[15]).toBe("┬");

		const mergeRail = renderRail(20, false, 0, plainTheme, [5, 15], true);
		expect(mergeRail[5]).toBe("┴");

		const activeRail = renderRail(30, true, 0, plainTheme, [], false);
		expect(activeRail).toContain("●");
		expect(activeRail).toContain("•");

		const box = drawBox(["hello world"], 20, (s) => s, "title");
		const [topLine = "", midLine = "", bottomLine = ""] = box;
		expect(box).toHaveLength(3);
		expect(visibleWidth(topLine)).toBe(20);
		expect(stripTerminalSequences(topLine)).toContain("title");
		expect(visibleWidth(midLine)).toBe(20);
		expect(visibleWidth(bottomLine)).toBe(20);
	});

	it("respects rows limit when provided", () => {
		const registry = new SubagentRegistry(() => 20_000);
		const state: FlightdeckState = {
			...createFlightdeckState(),
			model: "claude-opus-4-6",
		};
		const pane = new FlightdeckPane({
			registry,
			getState: () => state,
			theme: plainTheme,
			rows: () => 5,
		});
		const lines = pane.render(60);
		expect(lines.length).toBeLessThanOrEqual(5);
	});
});
