# Flightdeck — Task List

- **Status:** Complete
- **Author:** Integralist
- **Created:** 2026-10-24
- **Language:** TypeScript
- **Source:** [`docs/specifications/2026-10-24-flightdeck.md`](../specifications/2026-10-24-flightdeck.md)

## Summary

Add a `/flightdeck` command to `pi-subagents` that docks a live dashboard split
pane beside the fullscreen conversation (and an 8-row inline summary in regular
mode). Developers get a real-time view of main-model vitals, subagent cards or
time-axis swimlanes, last-turn receipts, and session events while keeping the
subagent list below the prompt open by default and independently controllable
with `/flightdeck hide-list` and `/flightdeck show-list`.

## Context for the executor

Existing code the tasks build on (verified — do not re-explore):

- `src/ui/subagent-list.ts:52` — `SubagentListOptions` defines `isViewerOpen?: () => boolean`; `SubagentList.render` (`src/ui/subagent-list.ts:397`) and `SubagentList.handleKey` (`src/ui/subagent-list.ts:448`) return early when `this.#isViewerOpen?.()` is true.
- `src/registry.ts:43` — `SubagentRecord` stores subagent state; `trackContextUsage` (`src/registry.ts:479`) subscribes to a child `AgentSession` and updates `contextPercent` on `turn_end`.
- `src/spawn.ts:368` — `onSession` callback inside `runAndAnnounce` attaches `trackContextUsage` and `watchTurns` to the child `session`.
- `src/index.ts:1388` — default extension factory registers tools, message renderer, `input` mention handler, and the `session_start` TUI handler (`src/index.ts:1418`) that mounts `SUBAGENT_LIST_WIDGET` (`src/index.ts:75`).
- `test/ui/subagent-list.test.ts:18` — `plainTheme` and `list()` helper pattern for deterministic TUI component tests with `stripTerminalSequences` and `visibleWidth`.
- `test/index.test.ts:2195` — `session_start` widget mount tests using `vi.fn()` stubs on `ExtensionAPI` and `ExtensionContext`.

Conventions and gotchas:

- Run tests with `npx vitest --run <test-file>` and full checks with `make verify` (`test`, `typecheck`, `lint`, `load-check`).
- Biome enforces tab indentation and double quotes across `src/` and `test/`. Run `make format` if Biome reports formatting drift.
- Never allow a listener or UI callback to throw into the host session; guard child session reads with `try / catch` exactly as `readContextPercent` (`src/registry.ts:456`) does.
- Any timer created for UI animation must call `timer.unref?.()` so it cannot hold the Node process open on exit (`src/ui/subagent-list.ts:127`).

## Tasks

### Task 1: Support hiding and restoring the bottom subagent list via `isHidden`

Add an `isHidden?: () => boolean` option to `SubagentListOptions` so `/flightdeck hide-list` and `/flightdeck show-list` can hide or restore the bottom subagent list without closing the viewer or disposing the widget.

- **Location:** `src/ui/subagent-list.ts`, `test/ui/subagent-list.test.ts`

**Test (red)** — add to `test/ui/subagent-list.test.ts`:

```typescript
	it("hides rows and ignores keys when isHidden returns true", () => {
		addRunning(2);
		let hidden = true;
		const opened: SubagentRecord[] = [];
		const subject = new SubagentList({
			registry,
			theme: plainTheme,
			now: () => clock,
			getEditorText: () => "",
			isEditorFocused: () => true,
			isHidden: () => hidden,
			onOpen: (rec) => {
				opened.push(rec);
			},
		});

		expect(subject.render(80)).toEqual([]);
		expect(subject.handleKey("\x1b[B")).toBe(false);
		expect(subject.handleKey("\r")).toBe(false);
		expect(opened).toHaveLength(0);

		hidden = false;
		expect(subject.render(80).filter(Boolean)).toHaveLength(2);
		expect(subject.handleKey("\x1b[B")).toBe(true);
	});
```

Run `npx vitest --run test/ui/subagent-list.test.ts`; it fails because `isHidden` is not handled by `SubagentList.render` or `SubagentList.handleKey`, so `subject.render(80)` returns 4 lines instead of `[]`.

**Implementation (green)** — in `src/ui/subagent-list.ts`:

1. Add `isHidden?: () => boolean;` to `SubagentListOptions` alongside `isViewerOpen` (`src/ui/subagent-list.ts:81`).
2. Store `readonly #isHidden: (() => boolean) | undefined;` on `SubagentList` (`src/ui/subagent-list.ts:254`) and initialize `this.#isHidden = options.isHidden;` in the constructor (`src/ui/subagent-list.ts:281`).
3. In `render(width: number)` (`src/ui/subagent-list.ts:397`) and `handleKey(data: string)` (`src/ui/subagent-list.ts:448`), treat `this.#isHidden?.()` the same as `this.#isViewerOpen?.()`: return `[]` from `render` and `false` from `handleKey` when either returns `true`.

**Verify:** `npx vitest --run test/ui/subagent-list.test.ts` passes with all tests green.

- [x] Task 1 complete

### Task 2: Add pure Flightdeck state model, formatting, and swimlane math

Create `src/ui/flightdeck-state.ts` with pure data types, formatting helpers, swimlane geometry (`lanes`), and state reducers for main vitals, turn receipts, and session log entries, modeled on `claude-flightdeck`'s `hooks/core.ts`.

- **Location:** `src/ui/flightdeck-state.ts`, `test/ui/flightdeck-state.test.ts`

**Stub** — create `src/ui/flightdeck-state.ts`:

```typescript
export type FlightdeckLayout = "auto" | "compact" | "wide" | "mini";

export interface ToolNote {
	text: string;
	isError: boolean;
}

export interface TurnState {
	startedAt: number;
	edits: number;
	errors: number;
	agentsSpawned: number;
	costAtStart: number;
}

export interface TurnReceipt {
	durationMs: number;
	agents: number;
	edits: number;
	errors: number;
	costDelta: number | null;
	reason: "answer" | "error";
}

export interface LogEntry {
	at: number;
	who: string;
	text: string;
	kind: "info" | "done" | "error";
	agentId: string | null;
}

export interface FlightdeckState {
	model: string;
	effort: string;
	steps: number;
	isRunning: boolean;
	tokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	compactions: number;
	costUsd: number;
	turn: TurnState;
	receipt: TurnReceipt | null;
	log: LogEntry[];
	expandedAgentId: string | null;
	layout: FlightdeckLayout;
	resetAfterAt: number;
}

export function createFlightdeckState(): FlightdeckState {
	throw new Error("not implemented");
}
```

**Test (red)** — create `test/ui/flightdeck-state.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	appendLog,
	completeTurn,
	createFlightdeckState,
	describeToolCall,
	fmtClock,
	fmtDuration,
	fmtTimer,
	fmtUsd,
	gauge,
	kTokens,
	lanes,
	prettyModel,
	recordToolCall,
	resetFlightdeckState,
	startTurn,
	titleLines,
} from "../../src/ui/flightdeck-state.ts";

describe("flightdeck-state", () => {
	it("formats models, tokens, timers, durations, clocks, and gauges", () => {
		expect(prettyModel("anthropic/claude-opus-4-6")).toBe("Opus 4.6");
		expect(prettyModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"Sonnet 4.5",
		);
		expect(kTokens(667_400)).toBe("667k");
		expect(kTokens(1_000_000)).toBe("1.0M");
		expect(fmtDuration(7_200)).toBe("7s");
		expect(fmtDuration(75_000)).toBe("1m15s");
		expect(fmtTimer(15_900)).toBe("0:15");
		expect(fmtUsd(0.154)).toBe("$0.15");
		expect(fmtUsd(104.2)).toBe("$104");
		expect(gauge(67, 10)).toEqual({ on: "■■■■■■■", off: "□□□" });
		expect(titleLines("Review README and docs for drift", 14, 16)).toEqual([
			"Review README",
			"and docs for…",
		]);
		expect(fmtClock(0)).toBe("--:--:--");
	});

	it("computes proportional swimlane bars across a shared time axis", () => {
		const geo = lanes(
			[
				{ id: "a", startedAt: 1_000, finishedAt: 6_000 },
				{ id: "b", startedAt: 6_000, finishedAt: 11_000 },
			],
			11_000,
			20,
		);

		expect(geo[0]).toEqual({ id: "a", before: 0, bar: 10, after: 10 });
		expect(geo[1]).toEqual({ id: "b", before: 10, bar: 10, after: 0 });
	});

	it("tracks turns, tool edits/errors, receipts, logs, and reset boundaries", () => {
		let state = createFlightdeckState();
		state = { ...state, costUsd: 1.0, compactions: 2 };
		state = startTurn(state, 10_000);
		state = recordToolCall(state, { isEdit: true, isError: false });
		state = recordToolCall(state, { isEdit: false, isError: true });
		state = { ...state, costUsd: 1.15 };
		state = completeTurn(state, {
			endedAt: 17_000,
			agentsSpawned: 2,
			reason: "answer",
		});
		state = appendLog(state, {
			at: 17_000,
			who: "main",
			text: describeToolCall("edit", { path: "src/index.ts" }),
			kind: "info",
			agentId: null,
		});

		expect(state.steps).toBe(1);
		expect(state.receipt).toEqual({
			durationMs: 7_000,
			agents: 2,
			edits: 1,
			errors: 1,
			costDelta: 0.15,
			reason: "answer",
		});
		expect(state.log).toHaveLength(1);
		expect(state.log[0]?.text).toBe("edit → src/index.ts");

		const reset = resetFlightdeckState(state, 20_000);
		expect(reset.receipt).toBeNull();
		expect(reset.log).toEqual([]);
		expect(reset.resetAfterAt).toBe(20_000);
		expect(reset.costUsd).toBe(1.15);
		expect(reset.compactions).toBe(2);
	});
});
```

Run `npx vitest --run test/ui/flightdeck-state.test.ts`; it fails because the helper exports are missing or throw `"not implemented"`.

**Implementation (green)** — in `src/ui/flightdeck-state.ts`:

Implement the pure functions:

- `createFlightdeckState(): FlightdeckState` returning zeroed defaults (`model: ""`, `effort: ""`, `steps: 0`, `isRunning: false`, `tokens: null`, `contextWindow: 0`, `contextPercent: null`, `compactions: 0`, `costUsd: 0`, `turn: { startedAt: 0, edits: 0, errors: 0, agentsSpawned: 0, costAtStart: 0 }`, `receipt: null`, `log: []`, `expandedAgentId: null`, `layout: "auto"`, `resetAfterAt: 0`).
- `prettyModel(id: string): string` extracting `Opus X.Y`, `Sonnet X.Y`, `Haiku X.Y` from Claude model IDs (stripping provider prefixes like `anthropic/` or `us.anthropic.`), or truncating other model IDs to 22 chars with `shorten`.
- `shorten(s: string, max: number): string`, `kTokens(n: number): string`, `fmtDuration(ms: number): string`, `fmtTimer(ms: number): string`, `fmtClock(ms: number): string`, `fmtUsd(n: number): string`, `plural(n: number, word: string): string`.
- `gauge(pct: number, width: number): { on: string; off: string }` using `"■"` for filled cells and `"□"` for empty cells.
- `titleLines(title: string, first: number, rest: number): [string, string]` splitting at the last space within `first` characters and shortening the remainder to `rest`.
- `lanes(items: ReadonlyArray<{ id: string; startedAt: number; finishedAt?: number }>, now: number, width: number)` computing `{ id, before, bar, after }` across `width` columns from the earliest `startedAt` to `now`.
- `describeToolCall(toolName: string, args: unknown): string` extracting `path`, `file_path`, `command`, or `pattern` from `args` (keeping the last two path segments for paths) and redacting tokens/secrets.
- `startTurn(state, startedAt)`, `recordToolCall(state, { isEdit, isError })`, `completeTurn(state, { endedAt, agentsSpawned, reason })`, `appendLog(state, entry)` (capping `log` at 60 entries), and `resetFlightdeckState(state, now)` (clearing `receipt`, `log`, `expandedAgentId`, and setting `resetAfterAt: now` while preserving `costUsd` and `compactions`).

**Verify:** `npx vitest --run test/ui/flightdeck-state.test.ts` passes.

- [x] Task 2 complete

### Task 3: Track subagent token counts and recent tool calls on `SubagentRecord`

Extend `SubagentRecord` and `trackContextUsage` in `src/registry.ts` so each subagent record carries live `contextTokens`, `outputTokens`, and its last three `toolCalls` (`ToolNote[]`) for Flightdeck cards and expanded views.

- **Location:** `src/registry.ts`, `src/spawn.ts`, `test/registry.test.ts`

**Test (red)** — add to `test/registry.test.ts`:

```typescript
	it("tracks contextTokens, outputTokens, and last 3 tool calls from child session events", () => {
		const registry = new SubagentRegistry();
		registry.add(
			makeRecord({
				id: "sub-metrics",
				handle: "explore",
			}),
		);

		let listener: ((event: unknown) => void) | undefined;
		const session = {
			subscribe: (fn: (event: unknown) => void) => {
				listener = fn;
				return () => {};
			},
			getContextUsage: () => ({
				tokens: 14_200,
				contextWindow: 200_000,
				percent: 7.1,
			}),
		};

		trackContextUsage(session as never, registry, "sub-metrics");

		for (let i = 1; i <= 4; i++) {
			listener?.({
				type: "tool_execution_end",
				toolName: "read",
				args: { path: `src/file-${i}.ts` },
				isError: i === 4,
			});
		}
		listener?.({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { output: 350 },
			},
		});
		listener?.({ type: "turn_end" });

		const updated = registry.get("sub-metrics");
		expect(updated?.contextPercent).toBe(7.1);
		expect(updated?.contextTokens).toBe(14_200);
		expect(updated?.outputTokens).toBe(350);
		expect(updated?.toolCalls).toEqual([
			{ text: "read → src/file-2.ts", isError: false },
			{ text: "read → src/file-3.ts", isError: false },
			{ text: "read → src/file-4.ts", isError: true },
		]);
	});
```

Run `npx vitest --run test/registry.test.ts`; it fails because `contextTokens`, `outputTokens`, and `toolCalls` are not updated by `trackContextUsage`.

**Implementation (green)** — in `src/registry.ts` and `src/spawn.ts`:

1. In `src/registry.ts:43`, add optional fields to `SubagentRecord`:
   ```typescript
   contextTokens?: number | null;
   outputTokens?: number;
   toolCalls?: ToolNote[];
   ```
   (import `type { ToolNote }` and `describeToolCall` from `./ui/flightdeck-state.ts`).
2. In `src/registry.ts:479` (`trackContextUsage`), handle three event types inside the `session.subscribe` callback (guarded by `try / catch` so it never throws):
   - `tool_execution_end` (or `tool_result`): extract `toolName` and `args`/`input` and `isError`, append `{ text: describeToolCall(toolName, args), isError: Boolean(isError) }` to `record.toolCalls`, keeping the last 3 items (`.slice(-3)`), and call `registry.update(idOrHandle, { toolCalls })`.
   - `message_end`: if the message role is `"assistant"` and carries `usage.output` or `usage.outputTokens` (a positive number), add it to `(record.outputTokens ?? 0)` via `registry.update`.
   - `turn_end`: read `session.getContextUsage()` and update both `contextPercent: usage?.percent ?? null` and `contextTokens: usage?.tokens ?? null`.

**Verify:** `npx vitest --run test/registry.test.ts` passes.

- [x] Task 3 complete

### Task 4: Build `FlightdeckPane` component (docked cards/swimlanes, rails, receipt, log, and mini view)

Create `src/ui/flightdeck.ts` implementing the `FlightdeckPane` TUI `Component` that renders the Flightdeck header, legend, animated or resting rails (`─`, `┬`, `┴`, `●`, `•`), `main` box, `agents` cards or swimlanes, expanded subagent box, `receipt` box, `session log` box, and the 8-row `mini` inline layout.

- **Location:** `src/ui/flightdeck.ts`, `test/ui/flightdeck.test.ts`

**Stub** — create `src/ui/flightdeck.ts`:

```typescript
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { SubagentRegistry } from "../registry.ts";
import type { FlightdeckState } from "./flightdeck-state.ts";

export interface FlightdeckPaneOptions {
	registry: SubagentRegistry;
	getState: () => FlightdeckState;
	theme: Theme;
	placement?: "docked" | "inline";
	rows?: () => number;
	now?: () => number;
	railPhase?: () => number;
}

export class FlightdeckPane implements Component {
	constructor(_options: FlightdeckPaneOptions) {}
	render(_width: number): string[] {
		return [];
	}
	invalidate(): void {}
}
```

**Test (red)** — create `test/ui/flightdeck.test.ts`:

```typescript
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type SubagentRecord, SubagentRegistry } from "../../src/registry.ts";
import { FlightdeckPane } from "../../src/ui/flightdeck.ts";
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
		registry.add(makeRecord({ id: "sub-1", handle: "explore", startedAt: 1_000 }));
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
			steps: 8,
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
		expect(text).toContain("last turn 7s · 2 subagents · 0 edits · 0 errors · +$0.15");
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
					outcome: { status: "completed", output: "All checks passed cleanly." },
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

		const text = pane.render(52).map(stripTerminalSequences).join("\n");
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
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("Opus 4.6");
		expect(lines.join("\n")).toContain("+1 more subagents");
	});
});
```

Run `npx vitest --run test/ui/flightdeck.test.ts`; it fails because `FlightdeckPane.render` returns `[]`.

**Implementation (green)** — in `src/ui/flightdeck.ts`:

1. Implement a rounded box helper `drawBox(lines: string[], width: number, borderColor: (s: string) => string): string[]` using `╭─╮`, `│`, `╰─╯` and `truncateToWidth` / `visibleWidth` from `@earendil-works/pi-tui` (following `src/ui/subagent-list.ts:212` `padCell` so every line is\<= `width`).
2. Implement `renderRail(width: number, active: boolean, phase: number, theme: Theme, marks: number[], isMerge: boolean): string` drawing `─` with `┬` (or `┴` when `isMerge` is true) at `marks`, and superimposing moving `●` and `•` packets every 24 cells when `active` is true.
3. Filter subagents from `registry.list()` to those with `startedAt >= state.resetAfterAt`.
4. Render the four panels:
   - `mainPanel(w)`: rounded box with `{prettyModel(state.model)} · main` on the left and `● working` / `○ idle` on the right; `effort ▮▮▯▯ {effort}   {steps} req`; `ctx {gauge} {pct}% {kTokens(tokens)}/{kTokens(window)}` (plus `⟲{compactions}` when `> 0`); and `{fmtUsd(costUsd)}` when `> 0`.
   - `agentsPanel(w)`: header `agents · {running} running · {total} total` and `1-{shown} expand`. Fit up to `Math.min(3, Math.floor((w + 1) / 21))` side-by-side cards (each card is a rounded box of `cardW` columns showing `{i}: {titleLine1}`, `{titleLine2}`, `{type}`, `ctx {kTokens} · out {kTokens} · {turns} st`, and `{glyph} {status} {timer}`, wrapped in fan-out and merge rails). When `cards.length > fit`, render up to 6 recent subagents as horizontal swimlanes using `lanes(shown, now, barW)` with `·` for `before`/`after` and `━` for `bar`. If `state.expandedAgentId` matches a subagent, render a single-border detail box beneath `agentsPanel` with its full `description`, `toolCalls`, and `outcome?.output` first line (`» ...`).
   - `receiptPanel(w)`: rounded box showing active turn clock when `state.isRunning`, or `✓/✗ last turn {fmtDuration} · {plural(agents, "subagent")} · {plural(edits, "edit")} · {plural(errors, "error")}{costDelta ? ` · +${fmtUsd(costDelta)}` : ""}` when `state.receipt` is present.
   - `logPanel(w)`: rounded box titled `session log` showing the last 4–8 `state.log` entries formatted as `{HH:MM:SS} {who} {text}`.
5. Support `isMini` (`state.layout === "mini" || (state.layout === "auto" && placement === "inline")`) rendering at most 8 rows (vitals line, up to 3 subagent rows, `+N more subagents` overflow line, and last-turn receipt line).
6. Support `isWide` (`state.layout === "wide" || (state.layout === "auto" && width >= 110)`) placing `main` on the left column and `agents` + `receipt` on the right column using side-by-side line joining, with `logPanel` spanning the full width below.

**Verify:** `npx vitest --run test/ui/flightdeck.test.ts` passes.

- [x] Task 4 complete

### Task 5: Wire `/flightdeck` command, fullscreen `HStack` split, and session lifecycle hooks in `src/index.ts`

Register the `/flightdeck` command (`open`, `hide`/`close`, `hide-list`, `show-list`, `reset`, `layout`, `expand`), subscribe Flightdeck state to Pi lifecycle hooks (`turn_start`, `turn_end`, `tool_execution_end`, `session_before_compact`) and `SubagentRegistry`, and mount the docked `HStack` split in fullscreen mode (`isViewportTUI`) or the inline `aboveEditor` widget in regular mode.

- **Location:** `src/index.ts`, `test/index.test.ts`

**Test (red)** — add to `test/index.test.ts`:

```typescript
	describe("/flightdeck command and split-pane mounting", () => {
		it("docks beside the fullscreen layoutRoot in an HStack, keeps bottom list visible by default, and supports hide-list, show-list, and hide", async () => {
			const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
			const commands = new Map<
				string,
				{
					description: string;
					handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
				}
			>();
			const widgets = new Map<
				string,
				{ factory: unknown; options?: { placement?: string } }
			>();

			const pi = {
				registerTool: vi.fn(),
				registerMessageRenderer: vi.fn(),
				registerCommand: vi.fn((name: string, cmd: never) => {
					commands.set(name, cmd);
				}),
				on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				}),
				sendMessage: vi.fn(),
				getAllTools: () => [],
			} as unknown as ExtensionAPI;

			extension(pi);
			expect(commands.has("flightdeck")).toBe(true);

			const originalRoot: Component = {
				render: (w: number) => [`chat-${w}`],
				invalidate: () => {},
			};
			let currentRoot: Component | undefined = originalRoot;
			const fakeTui = {
				[VIEWPORT_TUI]: true,
				mode: "fullscreen",
				terminal: { rows: 40, columns: 140 },
				get layoutRoot() {
					return currentRoot;
				},
				setLayoutRoot: vi.fn((root: Component | undefined) => {
					currentRoot = root;
				}),
				requestRender: vi.fn(),
				addInputListener: vi.fn(() => () => {}),
				hasOverlay: () => false,
				getFocusedComponent: () => null,
			};

			const plainTheme = {
				fg: (_c: string, t: string) => t,
				bg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			} as unknown as Theme;

			let mountedList: Component | undefined;
			const ctx = {
				mode: "tui",
				cwd: "/tmp/project",
				model: { provider: "anthropic", id: "claude-opus-4-6", name: "Opus 4.6" },
				thinkingLevel: "medium",
				getContextUsage: () => ({
					tokens: 50_000,
					contextWindow: 200_000,
					percent: 25,
				}),
				ui: {
					notify: vi.fn(),
					getEditorText: () => "",
					setWidget: vi.fn(
						(
							key: string,
							factory: ((tui: never, theme: Theme) => Component) | undefined,
							options?: { placement?: string },
						) => {
							if (!factory) {
								widgets.delete(key);
								return;
							}
							widgets.set(key, { factory, options });
							const comp = factory(fakeTui as never, plainTheme);
							if (key === SUBAGENT_LIST_WIDGET) {
								mountedList = comp;
							}
						},
					),
				},
			} as unknown as ExtensionContext;

			for (const fn of handlers.get("session_start") ?? []) {
				await fn({}, ctx);
			}
			expect(mountedList).toBeDefined();

			const cmd = commands.get("flightdeck")!;
			await cmd.handler("", ctx);

			// Fullscreen mode wraps originalRoot in an HStack via setLayoutRoot
			expect(fakeTui.setLayoutRoot).toHaveBeenCalled();
			expect(currentRoot).not.toBe(originalRoot);
			const splitLines = currentRoot!.render(140).map(stripTerminalSequences);
			expect(splitLines.join("\n")).toContain("FLIGHTDECK");
			expect(splitLines.join("\n")).toContain("Opus 4.6 · main");

			// Bottom list is still visible by default, and hides on /flightdeck hide-list
			await cmd.handler("hide-list", ctx);
			expect(mountedList!.render(80)).toEqual([]);

			await cmd.handler("show-list", ctx);
			// Restored (empty only because 0 subagents, so check hide restores originalRoot)
			await cmd.handler("hide", ctx);
			expect(currentRoot).toBe(originalRoot);
		});
	});
```

(Import `VIEWPORT_TUI`, `type Component`, and `stripTerminalSequences` from `@earendil-works/pi-tui` at the top of `test/index.test.ts`.)

Run `npx vitest --run test/index.test.ts`; it fails because `pi.registerCommand("flightdeck", ...)` is not registered yet.

**Implementation (green)** — in `src/index.ts`:

1. Export `export const FLIGHTDECK_WIDGET = "pi-subagents:flightdeck";`.
2. In the default extension factory (`src/index.ts:1388`), create the session's `FlightdeckState` (`createFlightdeckState()`), a `let listHidden = false` flag, a `let flightdeckOpen = false` flag, and references to the captured `tui`, `theme`, and original `layoutRoot`.
3. Subscribe to Pi events on `pi`:
   - `turn_start`: sync `model` (`ctx.model?.id`), `effort` (`ctx.thinkingLevel`), `tokens`/`contextWindow`/`contextPercent` (`ctx.getContextUsage()`), mark `startTurn(state, Date.now())`, and start the unref'd `110ms` animation timer if Flightdeck is open.
   - `tool_execution_end`: record tool edits (`edit`, `write`) and errors via `recordToolCall`, and append edits/errors to the session log via `appendLog`.
   - `turn_end`: read assistant message usage cost if present on `event`, update `ctx.getContextUsage()`, call `completeTurn`, and stop the animation timer when idle and no subagents are running.
   - `session_before_compact`: increment `state.compactions`.
   - Also subscribe to `registry.onChange` to log new subagent spawns and terminal transitions into `state.log` and start/stop the animation timer while `registry.running().length > 0`.
4. Pass `isHidden: () => listHidden` into `new SubagentList({ ... })` in `session_start` (`src/index.ts:1474`), and capture `tui` and `theme` from the widget factory callback so `/flightdeck` can mount into `tui` on demand.
5. Register `pi.registerCommand("flightdeck", { description: "Open or configure the Flightdeck dashboard", handler: async (args, ctx) => ... })`:
   - `""` or `"open"`: set `flightdeckOpen = true`. If `isViewportTUI(tui)` is true, save `originalLayoutRoot = (tui as ViewportTUI & { layoutRoot?: Component }).layoutRoot` (if not already wrapped) and call `tui.setLayoutRoot(new HStack([{ component: originalLayoutRoot, grow: 1 }, { component: flightdeckPane, basis: 56, minSize: 36, maxSize: 68, visible: (vp) => vp.width >= 100 }], { gap: 1 }))`. Otherwise (regular mode), mount `ctx.ui.setWidget(FLIGHTDECK_WIDGET, (_t, th) => new FlightdeckPane({ ..., theme: th, placement: "inline" }), { placement: "aboveEditor" })`.
   - `"hide"` or `"close"`: set `flightdeckOpen = false`, restore `tui.setLayoutRoot(originalLayoutRoot)` if wrapped, clear `ctx.ui.setWidget(FLIGHTDECK_WIDGET, undefined)`, and request a render.
   - `"hide-list"`: set `listHidden = true` and request a render.
   - `"show-list"`: set `listHidden = false` and request a render.
   - `"reset"`: set `state = resetFlightdeckState(state, Date.now())` and request a render.
   - `"layout <auto|compact|wide|mini>"`: update `state.layout` and request a render.
   - `"expand <1-9>"` (or `1`–`9`): toggle `state.expandedAgentId` for the Nth visible subagent in Flightdeck.

**Verify:** Run `make verify` in `../pi-subagents` (`test`, `typecheck`, `lint`, `load-check`) and confirm all four checks pass with zero errors.

- [x] Task 5 complete
