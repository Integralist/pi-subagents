import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { PALETTE } from "../../src/colors.ts";
import { type SubagentRecord, SubagentRegistry } from "../../src/registry.ts";
import { ROWS_PER_COLUMN } from "../../src/ui/layout.ts";
import { DEFAULT_LINGER_MS, SubagentList } from "../../src/ui/subagent-list.ts";

/**
 * A theme that colours nothing, so an assertion about layout is not also an
 * assertion about the palette. The colour tests build their own.
 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/**
 * A theme that really emits escape codes, the way pi's does. Needed by any test
 * where the difference matters — a real `fg` seals padding inside the colour,
 * out of `trimEnd`'s reach.
 */
const ansiTheme = {
	fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`,
	bold: (text: string) => text,
} as unknown as Theme;

const NOW = 1_000_000;

let registry: SubagentRegistry;
let clock: number;

beforeEach(() => {
	clock = NOW;
	registry = new SubagentRegistry(() => clock);
});

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "abc123",
		handle: "reviewer",
		type: "reviewer",
		description: "review agents file",
		status: "running",
		color: "cyan",
		startedAt: 1_000,
		contextPercent: 12,
		turns: 0,
		...overrides,
	};
}

/** Register `count` running subagents, each distinguishable from the others. */
function addRunning(count: number): SubagentRecord[] {
	return Array.from({ length: count }, (_, i) => {
		const added = record({
			id: `sub-${i}`,
			handle: `agent${i}`,
			description: `task ${i}`,
			color: PALETTE[i % PALETTE.length] ?? "cyan",
			// Launch order, so `list()` returns them in the order asked for.
			startedAt: 1_000 + i,
		});
		registry.add(added);
		return added;
	});
}

function list(
	options: { perColumn?: number; lingerMs?: number; theme?: Theme } = {},
) {
	return new SubagentList({
		registry,
		theme: options.theme ?? plainTheme,
		perColumn: options.perColumn,
		lingerMs: options.lingerMs,
		now: () => clock,
	});
}

/** Rendered lines with every escape sequence removed. */
function plain(subject: SubagentList, width = 80): string[] {
	return subject.render(width).map(stripTerminalSequences);
}

describe("SubagentList", () => {
	// The specification's scenario, quoted.
	it("Shows each subagent with its context use", () => {
		addRunning(3);

		const lines = plain(list());

		// The list shows 3 rows below the prompt.
		expect(lines).toHaveLength(3);
		// And each row shows its subagent's name.
		expect(lines[0]).toContain("agent0");
		expect(lines[1]).toContain("agent1");
		expect(lines[2]).toContain("agent2");
		// And each row shows its context-window use as a percentage.
		for (const line of lines) {
			expect(line).toContain("12%");
		}
	});

	it("shows what each subagent was asked to do", () => {
		addRunning(2);

		expect(plain(list())[0]).toContain("task 0");
	});

	it("draws nothing at all when there are no subagents", () => {
		expect(list().render(80)).toEqual([]);
	});

	/**
	 * Null is not zero. Before the first turn ends, and again just after a
	 * compaction, nobody knows the figure — and `0%` would claim an empty context
	 * window rather than an unknown one.
	 */
	it("leaves the percentage blank rather than showing 0%", () => {
		registry.add(record({ contextPercent: null }));

		const line = plain(list())[0] ?? "";

		expect(line).toContain("reviewer");
		expect(line).not.toContain("%");
		expect(line).not.toContain("0");
	});

	it("rounds a fractional percentage", () => {
		registry.add(record({ contextPercent: 12.6 }));

		expect(plain(list())[0]).toContain("13%");
	});

	/**
	 * Ragged left edges are what make a list of short rows hard to scan, which is
	 * the whole reason the list exists.
	 */
	describe("alignment", () => {
		function withHandles(...handles: string[]) {
			handles.forEach((handle, i) => {
				registry.add(
					record({
						id: `sub-${i}`,
						handle,
						description: "a task",
						startedAt: 1_000 + i,
					}),
				);
			});
			return plain(list());
		}

		it("starts every description in the same column", () => {
			const lines = withHandles("reviewer", "docs", "x");

			const starts = lines.map((line) => line.indexOf("a task"));
			expect(new Set(starts).size).toBe(1);
			expect(starts[0]).toBeGreaterThan(0);
		});

		it("pads the name column to the widest name, not to a fixed width", () => {
			const short = withHandles("ab", "cd");

			expect(short[0]?.indexOf("a task")).toBe("_ ab ".length);
		});

		// One subagent with a very long name must not spend every other row's
		// width on whitespace.
		it("truncates a name too long to align around", () => {
			const lines = withHandles("a-really-very-long-agent-name", "docs");

			expect(lines[0]).toContain("…");
			expect(lines[0]?.indexOf("a task")).toBeLessThan(20);
			expect(lines[1]?.indexOf("a task")).toBe(lines[0]?.indexOf("a task"));
		});

		/**
		 * The padding exists to push the percentage to the right edge. With no
		 * percentage there is nothing to push, and the spaces would fill the row
		 * out to the terminal's last column for no reason.
		 *
		 * This has to run against a theme that really emits escape codes. A real
		 * `fg` seals the padding *inside* the colour, where `render`'s `trimEnd`
		 * cannot reach it — against the identity theme the rest of these tests
		 * use, the padding is trimmed away and the assertion passes either way.
		 */
		it("leaves no trailing padding on a row with no percentage", () => {
			registry.add(record({ contextPercent: null }));

			const line = list({ theme: ansiTheme }).render(80)[0] ?? "";

			expect(visibleWidth(line)).toBeLessThan(80);
		});

		it("still right-aligns the percentages that are there", () => {
			registry.add(record({ id: "a", handle: "one", contextPercent: 5 }));
			registry.add(
				record({
					id: "b",
					handle: "two",
					description: "a much longer task description",
					contextPercent: 100,
					startedAt: 1_001,
				}),
			);

			const lines = plain(list(), 60);

			expect(lines[0]?.endsWith("5%")).toBe(true);
			expect(lines[1]?.endsWith("100%")).toBe(true);
			expect(lines[0]).toHaveLength(60);
			expect(lines[1]).toHaveLength(60);
		});
	});

	it("marks each status with its own glyph", () => {
		const marks = new Map([
			["running", "…"],
			["completed", "✓"],
			["failed", "✗"],
			["stopped", "◼"],
			["queued", "·"],
		]);

		for (const [status, mark] of marks) {
			clock = NOW;
			registry = new SubagentRegistry(() => clock);
			registry.add(record({ status: status as SubagentRecord["status"] }));

			expect(plain(list())[0], status).toContain(mark);
		}
	});

	describe("columns", () => {
		/**
		 * The specification's Scenario Outline, driven through the rendered output
		 * rather than through `layoutColumns` — the point is that the rows really
		 * do end up beside each other on screen.
		 */
		it.each([
			{ count: 3, lines: 3 },
			{ count: 5, lines: 5 },
			{ count: 6, lines: 5 },
			{ count: 10, lines: 5 },
			{ count: 11, lines: 5 },
		])(
			"Splits into columns past five subagents: $count subagents render $lines lines",
			({ count, lines }) => {
				addRunning(count);

				expect(plain(list(), 200)).toHaveLength(lines);
			},
		);

		it("puts the sixth subagent beside the first, not under the fifth", () => {
			addRunning(6);

			const lines = plain(list(), 200);

			// Reading order is down the first column, so the sixth starts the
			// second column and shares a line with the first.
			expect(lines[0]).toContain("agent0");
			expect(lines[0]).toContain("agent5");
			expect(lines[1]).not.toContain("agent5");
		});

		it("leaves the short column short rather than padding it with rows", () => {
			addRunning(6);

			const lines = plain(list(), 200);

			expect(lines[1]).toContain("agent1");
			// Nothing from the second column on the second line: it had one row.
			expect(lines[1]?.match(/agent/g)).toHaveLength(1);
		});

		it("keeps every subagent when it drops to fewer columns to fit", () => {
			addRunning(10);

			// Too narrow for two columns, so all ten must still appear somewhere.
			const lines = plain(list(), 30);

			const shown = lines.join("\n");
			for (let i = 0; i < 10; i++) {
				expect(shown, `agent${i}`).toContain(`agent${i}`);
			}
		});

		it("never runs a line past the width it was given", () => {
			addRunning(10);

			for (const width of [20, 30, 40, 80, 200]) {
				for (const line of list().render(width)) {
					expect(
						stripTerminalSequences(line).length,
						`${width}`,
					).toBeLessThanOrEqual(width);
				}
			}
		});

		it("fills five per column by default", () => {
			addRunning(6);

			expect(plain(list(), 200)).toHaveLength(ROWS_PER_COLUMN);
		});
	});

	describe("colour", () => {
		// The specification's scenario, quoted.
		it("Gives each subagent its own colour", () => {
			addRunning(3);

			const lines = list().render(80);

			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape is the point
			const foreground = /\[3\dm/;
			const codes = lines.map((line) => line.match(foreground)?.[0]);
			expect(new Set(codes).size).toBe(3);
			expect(codes.every(Boolean)).toBe(true);
		});

		it("colours the name, not the whole row", () => {
			registry.add(
				record({ color: "cyan", description: "review agents file" }),
			);

			const line = list().render(80)[0] ?? "";

			// The colour opens immediately before the name and closes after it.
			expect(line).toContain("\x1b[36mreviewer\x1b[39m");
		});

		it("leaves a row uncoloured when its colour is not one the terminal has", () => {
			registry.add(record({ color: "hotpink" }));

			expect(list().render(80)[0]).toContain("reviewer");
			expect(list().render(80)[0]).not.toContain("\x1b[3");
		});
	});

	describe("a finished subagent", () => {
		function finish(status: SubagentRecord["status"] = "completed") {
			registry.add(record({ status: "running" }));
			registry.update("abc123", { status });
		}

		it("stays on screen for a moment so its result can be read", () => {
			finish();

			clock = NOW + DEFAULT_LINGER_MS - 1;

			expect(plain(list())[0]).toContain("reviewer");
		});

		it("drops out once it has had its moment", () => {
			finish();

			clock = NOW + DEFAULT_LINGER_MS;

			expect(list().render(80)).toEqual([]);
		});

		it.each(["completed", "failed", "stopped"] as const)(
			"expires whether it %s",
			(status) => {
				finish(status);

				clock = NOW + DEFAULT_LINGER_MS;

				expect(list().render(80)).toEqual([]);
			},
		);

		it("keeps a running subagent however long it takes", () => {
			addRunning(1);

			clock = NOW + DEFAULT_LINGER_MS * 100;

			expect(plain(list())[0]).toContain("agent0");
		});

		it("leaves the subagents still working in place", () => {
			addRunning(2);
			registry.update("sub-0", { status: "completed" });

			clock = NOW + DEFAULT_LINGER_MS;
			const lines = plain(list());

			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("agent1");
		});

		/**
		 * The registry stamps a record that arrives already finished, so a session
		 * that mounts the list late still measures the linger from a real time
		 * rather than showing the row forever.
		 */
		it("stamps one that was already finished when it was registered", () => {
			registry.add(record({ status: "completed" }));
			expect(registry.get("abc123")?.finishedAt).toBe(NOW);

			clock = NOW + DEFAULT_LINGER_MS;

			expect(list().render(80)).toEqual([]);
		});

		// A continuation is working again, so its row belongs on screen — the
		// original finish time must not still be counting against it.
		it("comes back when it is resumed", () => {
			finish();
			clock = NOW + DEFAULT_LINGER_MS * 2;
			registry.update("abc123", {
				status: "running",
				finishedAt: undefined,
			});

			expect(plain(list())[0]).toContain("reviewer");
		});
	});

	describe("keeping itself current", () => {
		/** A list wired for liveness, with the redraws and timers recorded. */
		function live(options: { lingerMs?: number } = {}) {
			const redraws: number[] = [];
			const timers: Array<{ ms: number; fire: () => void }> = [];
			const subject = new SubagentList({
				registry,
				theme: plainTheme,
				lingerMs: options.lingerMs,
				now: () => clock,
				requestRender: () => redraws.push(clock),
				delay: (fn, ms) => timers.push({ ms, fire: fn }),
			});
			return { subject, redraws, timers };
		}

		it("redraws when a subagent is added", () => {
			const { redraws } = live();

			addRunning(1);

			expect(redraws).toHaveLength(1);
		});

		it("redraws when a subagent's status changes", () => {
			addRunning(1);
			const { redraws } = live();

			registry.update("sub-0", { status: "completed" });

			expect(redraws).toHaveLength(1);
		});

		it("stops redrawing once disposed", () => {
			const { subject, redraws } = live();

			subject.dispose();
			addRunning(1);

			expect(redraws).toEqual([]);
		});

		/**
		 * A finished row leaves on a clock, not on anything the registry will
		 * report. Without this the last finished subagent in a quiet session would
		 * sit on screen until something unrelated happened.
		 */
		it("schedules the redraw that drops a finished row", () => {
			addRunning(1);
			const { timers } = live({ lingerMs: 5_000 });

			registry.update("sub-0", { status: "completed" });

			expect(timers).toHaveLength(1);
			expect(timers[0]?.ms).toBe(5_000);
		});

		it("asks for exactly one redraw per finished subagent", () => {
			addRunning(1);
			const { timers } = live({ lingerMs: 5_000 });

			registry.update("sub-0", { status: "completed" });
			registry.update("sub-0", { contextPercent: 44 });
			registry.update("sub-0", { turns: 3 });

			expect(timers).toHaveLength(1);
		});

		it("redraws when that timer fires, so the row can go", () => {
			addRunning(1);
			const { redraws, timers } = live({ lingerMs: 5_000 });
			registry.update("sub-0", { status: "completed" });

			clock = NOW + 5_000;
			timers[0]?.fire();

			expect(redraws).toHaveLength(2);
			expect(registry.get("sub-0")?.status).toBe("completed");
		});

		it("schedules nothing for a subagent still working", () => {
			const { timers } = live();

			addRunning(3);

			expect(timers).toEqual([]);
		});

		// Its row is already gone, so there is nothing left to redraw for.
		it("schedules nothing for a row whose moment has already passed", () => {
			addRunning(1);
			registry.update("sub-0", { status: "completed" });
			const { timers } = live({ lingerMs: 5_000 });

			clock = NOW + 5_000;
			registry.update("sub-0", { turns: 1 });

			expect(timers).toEqual([]);
		});

		// It only waits out what is left, or a row that finished long ago would
		// get a full fresh linger every time anything else changed.
		it("waits only the time the row has left", () => {
			addRunning(2);
			registry.update("sub-0", { status: "completed" });
			const { timers } = live({ lingerMs: 5_000 });

			clock = NOW + 4_000;
			registry.update("sub-1", { turns: 1 });

			expect(timers[0]?.ms).toBe(1_000);
		});

		it("does not subscribe at all when nobody wants redraws", () => {
			const subject = new SubagentList({ registry, theme: plainTheme });

			// Nothing to unsubscribe, and disposing must still be safe.
			expect(() => subject.dispose()).not.toThrow();
			expect(() => addRunning(1)).not.toThrow();
			expect(plain(subject)).toHaveLength(1);
		});
	});
});
