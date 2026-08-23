import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTE } from "../../src/colors.ts";
import { type SubagentRecord, SubagentRegistry } from "../../src/registry.ts";
import { ROWS_PER_COLUMN } from "../../src/ui/layout.ts";
import { DEFAULT_LINGER_MS, SubagentList } from "../../src/ui/subagent-list.ts";

/**
 * Stands in for whatever `theme.bg("selectedBg", …)` emits. A real escape
 * sequence, so it does not count towards a row's visible width.
 */
const SELECTED_BG = "\x1b[7m";

/**
 * A theme that colours nothing, so an assertion about layout is not also an
 * assertion about the palette. The colour tests build their own. `bg` is the
 * exception: the selection has to be visible for a test to point at it.
 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `${SELECTED_BG}${text}\x1b[27m`,
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
		config: {
			name: "reviewer",
			description: "reviews code for defects",
			systemPrompt: "You review code.",
			source: "project",
		},
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
	options: {
		perColumn?: number;
		lingerMs?: number;
		theme?: Theme;
		editorText?: () => string;
		onOpen?: (record: SubagentRecord) => Promise<void> | void;
		onStop?: (record: SubagentRecord) => void;
	} = {},
) {
	return new SubagentList({
		registry,
		theme: options.theme ?? plainTheme,
		perColumn: options.perColumn,
		lingerMs: options.lingerMs,
		now: () => clock,
		getEditorText: options.editorText,
		onOpen: options.onOpen,
		onStop: options.onStop,
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

		describe("the keyboard", () => {
			/** A list wired to a fake terminal, with its key listener captured. */
			function wired() {
				const listeners: Array<(data: string) => unknown> = [];
				let removed = 0;
				const subject = new SubagentList({
					registry,
					theme: plainTheme,
					now: () => clock,
					getEditorText: () => "",
					addInputListener: (listener) => {
						listeners.push(listener);
						return () => {
							removed += 1;
						};
					},
				});
				return {
					subject,
					send: (data: string) => listeners[0]?.(data),
					removed: () => removed,
				};
			}

			it("takes the keys it uses, and only those", () => {
				addRunning(3);
				const { subject, send } = wired();

				// Consumed, so pi does not also hand it to the editor.
				expect(send("\x1b[B")).toEqual({ consume: true });
				expect(subject.selectedId).toBe("sub-0");
			});

			/**
			 * `undefined` rather than `{ consume: false }`: everything the list did
			 * not take has to reach the editor untouched.
			 */
			it("passes a key it does not use straight through", () => {
				addRunning(3);
				const { send } = wired();

				expect(send("h")).toBeUndefined();
			});

			// A listener left attached would keep taking arrows for a list that is
			// no longer on screen.
			it("lets go of the keyboard when disposed", () => {
				const { subject, removed } = wired();

				subject.dispose();

				expect(removed()).toBe(1);
			});

			it("takes no keys at all when nothing subscribed it", () => {
				addRunning(3);
				const subject = new SubagentList({
					registry,
					theme: plainTheme,
					getEditorText: () => "",
				});

				// Still drivable directly, which is what the navigation tests do.
				expect(subject.handleKey("\x1b[B")).toBe(true);
			});
		});
	});
});

/**
 * Navigating the list.
 *
 * Keys are fed as the raw sequences a terminal sends, matching the reference
 * implementation's own tests, and the assertions are on which subagent ends up
 * selected rather than on any index — a row's position changes as subagents come
 * and go, but its identity does not.
 */
describe("SubagentList navigation", () => {
	const UP = "\x1b[A";
	const DOWN = "\x1b[B";
	const RIGHT = "\x1b[C";
	const LEFT = "\x1b[D";
	const ESC = "\x1b";
	const ENTER = "\r";
	const DELETE = "\x1b[3~";

	/** A list over `count` running subagents, at an empty prompt by default. */
	function nav(count: number, text = "") {
		addRunning(count);
		return list({ editorText: () => text });
	}

	/** Let the promise a key press started settle, however it was chained. */
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	/** Feed each key in turn and report what the list did with the last one. */
	function press(subject: SubagentList, ...keys: string[]): boolean {
		let consumed = false;
		for (const key of keys) {
			consumed = subject.handleKey(key);
		}
		return consumed;
	}

	describe("entering and leaving", () => {
		// The specification's scenario, quoted.
		it("Enters the list from an empty prompt", () => {
			const subject = nav(3);

			press(subject, DOWN);

			expect(subject.selectedId).toBe("sub-0");
		});

		it("consumes the key that entered the list", () => {
			expect(press(nav(3), DOWN)).toBe(true);
		});

		// The specification's scenario, quoted.
		it("Leaves the list", () => {
			const subject = nav(3);
			press(subject, DOWN, DOWN);

			// Then no row is selected.
			expect(press(subject, ESC)).toBe(true);
			expect(subject.selectedId).toBeUndefined();
		});

		/**
		 * Escape means a great many things at a prompt. Swallowing it when the
		 * list is not in use would take it away from everything else that wants
		 * it.
		 */
		it("leaves escape alone when no row is selected", () => {
			expect(press(nav(3), ESC)).toBe(false);
		});

		// The plan's rule: up past the first row leaves the list, rather than
		// sticking there with no way back to the prompt but escape.
		it("leaves the list when it goes up past the first row", () => {
			const subject = nav(3);
			press(subject, DOWN);

			expect(press(subject, UP)).toBe(true);
			expect(subject.selectedId).toBeUndefined();
		});

		it("ignores up when the list has not been entered", () => {
			const subject = nav(3);

			expect(press(subject, UP)).toBe(false);
			expect(subject.selectedId).toBeUndefined();
		});

		it("has nothing to enter when there are no subagents", () => {
			const subject = list({ editorText: () => "" });

			expect(press(subject, DOWN)).toBe(false);
			expect(subject.selectedId).toBeUndefined();
		});
	});

	describe("moving within a column", () => {
		// The specification's scenario, quoted.
		it("Moves down the list", () => {
			const subject = nav(3);
			press(subject, DOWN);

			press(subject, DOWN);

			expect(subject.selectedId).toBe("sub-1");
		});

		it("moves back up", () => {
			const subject = nav(3);
			press(subject, DOWN, DOWN, DOWN);
			expect(subject.selectedId).toBe("sub-2");

			press(subject, UP);

			expect(subject.selectedId).toBe("sub-1");
		});

		// Stopping at the bottom, rather than wrapping to the top or falling into
		// the next column: a list that jumps somewhere unexpected on a held key
		// is worse than one that stops.
		it("stops at the last row of the column", () => {
			const subject = nav(3);

			press(subject, DOWN, DOWN, DOWN, DOWN, DOWN);

			expect(subject.selectedId).toBe("sub-2");
		});

		it("keeps consuming down at the bottom, rather than letting it through", () => {
			const subject = nav(3);
			press(subject, DOWN, DOWN, DOWN);

			expect(press(subject, DOWN)).toBe(true);
		});
	});

	describe("moving between columns", () => {
		// The specification's scenario, quoted. Ten subagents is two columns.
		it("Moves between columns", () => {
			const subject = nav(10);
			subject.render(200);
			press(subject, DOWN);
			expect(subject.selectedId).toBe("sub-0");

			press(subject, RIGHT);

			expect(subject.selectedId).toBe("sub-5");
		});

		it("comes back to the first column", () => {
			const subject = nav(10);
			subject.render(200);
			press(subject, DOWN, RIGHT);

			press(subject, LEFT);

			expect(subject.selectedId).toBe("sub-0");
		});

		it("keeps its row when it changes column", () => {
			const subject = nav(10);
			subject.render(200);
			press(subject, DOWN, DOWN, DOWN);
			expect(subject.selectedId).toBe("sub-2");

			press(subject, RIGHT);

			expect(subject.selectedId).toBe("sub-7");
		});

		/**
		 * The plan's rule. Six subagents means a second column of one, so row
		 * three of the first column has no counterpart to move to.
		 */
		it("clamps to the last row when the target column is shorter", () => {
			const subject = nav(6);
			subject.render(200);
			press(subject, DOWN, DOWN, DOWN);
			expect(subject.selectedId).toBe("sub-2");

			press(subject, RIGHT);

			expect(subject.selectedId).toBe("sub-5");
		});

		/**
		 * Stopping at the edge, and still taking the key. Letting it fall through
		 * would move the editor's cursor instead, which is not what someone
		 * navigating a list means by pressing right.
		 */
		it("stays put at the last column, and keeps the key", () => {
			const subject = nav(6);
			subject.render(200);
			press(subject, DOWN, RIGHT);

			expect(press(subject, RIGHT)).toBe(true);
			expect(subject.selectedId).toBe("sub-5");
		});

		it("stays put at the first column, and keeps the key", () => {
			const subject = nav(6);
			subject.render(200);
			press(subject, DOWN);

			expect(press(subject, LEFT)).toBe(true);
			expect(subject.selectedId).toBe("sub-0");
		});

		// One column means nothing to cross to, and the arrows should not be
		// taken from the editor for a move that cannot happen.
		it("leaves sideways arrows alone when there is only one column", () => {
			const subject = nav(3);
			press(subject, DOWN);

			expect(press(subject, RIGHT)).toBe(false);
			expect(press(subject, LEFT)).toBe(false);
			expect(subject.selectedId).toBe("sub-0");
		});

		/**
		 * Navigation has to agree with what was drawn. A terminal too narrow for
		 * two columns shows one, so right must not move to a column the user
		 * cannot see.
		 */
		it("navigates the columns it actually drew, not the ones it wanted", () => {
			const subject = nav(10);
			subject.render(30);
			press(subject, DOWN);

			expect(press(subject, RIGHT)).toBe(false);
			expect(subject.selectedId).toBe("sub-0");
		});
	});

	describe("when the prompt has text", () => {
		// The specification's scenario, quoted.
		it("Ignores arrows when the prompt has text", () => {
			const subject = nav(3, "hello");

			expect(press(subject, DOWN)).toBe(false);
			expect(subject.selectedId).toBeUndefined();
		});

		/**
		 * The one behaviour that would annoy daily if it were wrong: with text in
		 * the editor, every arrow belongs to the cursor.
		 */
		it.each([
			["down", "\x1b[B"],
			["up", "\x1b[A"],
			["right", "\x1b[C"],
			["left", "\x1b[D"],
		])("leaves %s to the cursor", (_name, key) => {
			let text = "";
			addRunning(6);
			const subject = list({ editorText: () => text });
			subject.render(200);
			// Enter the list at an empty prompt, then start typing.
			subject.handleKey("\x1b[B");
			expect(subject.selectedId).toBe("sub-0");
			text = "hello";

			expect(subject.handleKey(key)).toBe(false);
			expect(subject.selectedId).toBe("sub-0");
		});

		// Escape is not an arrow. Leaving the list is exactly what a user with a
		// half-typed prompt and a selected row wants.
		it("still leaves the list on escape", () => {
			let text = "";
			addRunning(3);
			const subject = list({ editorText: () => text });
			subject.handleKey("\x1b[B");
			text = "hello";

			expect(subject.handleKey("\x1b")).toBe(true);
			expect(subject.selectedId).toBeUndefined();
		});

		// Without a way to read the prompt there is no way to know an arrow was
		// meant for the cursor, so the list must not take it.
		it("takes no arrows at all when it cannot read the prompt", () => {
			addRunning(3);
			const subject = list();

			expect(subject.handleKey("\x1b[B")).toBe(false);
			expect(subject.selectedId).toBeUndefined();
		});

		/**
		 * Spaces are text. Someone part-way through typing has a cursor to move,
		 * and guessing that they did not mean it would take the arrow anyway.
		 */
		it.each(["   ", "\t", " a "])(
			"treats a prompt of %o as text, not as empty",
			(text) => {
				const subject = nav(3, text);

				expect(press(subject, DOWN)).toBe(false);
				expect(subject.selectedId).toBeUndefined();
			},
		);
	});

	describe("keys it has no business taking", () => {
		it.each([
			["a printable character", "h"],
			["a control character", "\x03"],
			["tab", "\t"],
		])("leaves %s alone", (_name, key) => {
			const subject = nav(3);
			press(subject, DOWN);

			expect(subject.handleKey(key)).toBe(false);
		});

		/**
		 * A list with nothing to open must not swallow enter: the prompt's own
		 * enter is how a session is driven, and a list is not worth breaking it
		 * for.
		 */
		it.each([
			["enter", "\r"],
			["delete", "\x1b[3~"],
		])("leaves %s alone with nothing wired to it", (_name, key) => {
			const subject = nav(3);
			press(subject, DOWN);

			expect(subject.handleKey(key)).toBe(false);
		});
	});

	describe("opening a subagent", () => {
		/** Held open until the test closes it, the way a real view is. */
		function opening() {
			let close = () => {};
			const closed = new Promise<void>((resolve) => {
				close = resolve;
			});
			const onOpen = vi.fn((_record: SubagentRecord) => closed);
			return { onOpen, close };
		}

		// The specification's scenario, quoted.
		it("Opens a subagent", () => {
			const { onOpen } = opening();
			addRunning(3);
			const subject = list({ editorText: () => "", onOpen });
			press(subject, DOWN, DOWN);

			expect(press(subject, ENTER)).toBe(true);

			// That subagent's conversation is shown.
			expect(onOpen).toHaveBeenCalledTimes(1);
			expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ id: "sub-1" });
		});

		it("opens nothing when no row is selected", () => {
			const { onOpen } = opening();
			addRunning(3);
			const subject = list({ editorText: () => "", onOpen });

			expect(press(subject, ENTER)).toBe(false);
			expect(onOpen).not.toHaveBeenCalled();
		});

		/** With text in the prompt, enter submits it. */
		it("opens nothing when the prompt has text", () => {
			const { onOpen } = opening();
			addRunning(3);
			const subject = list({ editorText: () => "", onOpen });
			press(subject, DOWN);

			const typing = list({ editorText: () => "hello", onOpen });
			expect(press(typing, ENTER)).toBe(false);
			expect(subject.selectedId).toBe("sub-0");
			expect(onOpen).not.toHaveBeenCalled();
		});

		/**
		 * The view holds the keyboard while it is on screen, and this list is
		 * asked about every key first. Taking escape here would leave the list
		 * instead of closing the view, which would leave no way to close it.
		 */
		it("takes no keys while the view is open", () => {
			const { onOpen } = opening();
			addRunning(3);
			const subject = list({ editorText: () => "", onOpen });
			press(subject, DOWN, ENTER);

			expect(press(subject, DOWN)).toBe(false);
			expect(press(subject, ESC)).toBe(false);
			expect(subject.selectedId).toBe("sub-0");
		});

		it("takes keys again once the view closes", async () => {
			const { onOpen, close } = opening();
			addRunning(3);
			const subject = list({ editorText: () => "", onOpen });
			press(subject, DOWN, ENTER);

			close();
			await settle();

			expect(press(subject, DOWN)).toBe(true);
			expect(subject.selectedId).toBe("sub-1");
		});

		/** A view that failed to open is not on screen, so nor is it holding keys. */
		it("takes keys again when the view fails to open", async () => {
			addRunning(3);
			const subject = list({
				editorText: () => "",
				onOpen: () => Promise.reject(new Error("no terminal")),
			});
			press(subject, DOWN, ENTER);

			await settle();

			expect(press(subject, DOWN)).toBe(true);
		});
	});

	describe("stopping a subagent", () => {
		it("stops the selected subagent on delete", () => {
			const onStop = vi.fn();
			addRunning(3);
			const subject = list({ editorText: () => "", onStop });
			press(subject, DOWN, DOWN);

			expect(press(subject, DELETE)).toBe(true);
			expect(onStop.mock.calls[0]?.[0]).toMatchObject({ id: "sub-1" });
		});

		it("stops nothing when no row is selected", () => {
			const onStop = vi.fn();
			addRunning(3);
			const subject = list({ editorText: () => "", onStop });

			expect(press(subject, DELETE)).toBe(false);
			expect(onStop).not.toHaveBeenCalled();
		});

		it("stops nothing when the prompt has text", () => {
			const onStop = vi.fn();
			addRunning(3);
			const subject = list({ editorText: () => "hello", onStop });

			expect(press(subject, DELETE)).toBe(false);
			expect(onStop).not.toHaveBeenCalled();
		});
	});

	describe("a selection whose subagent goes away", () => {
		it("forgets a subagent that has left the list", () => {
			const subject = nav(2);
			press(subject, DOWN, DOWN);
			expect(subject.selectedId).toBe("sub-1");

			registry.update("sub-1", { status: "completed" });
			clock = NOW + DEFAULT_LINGER_MS;

			expect(subject.selectedId).toBeUndefined();
		});

		// The row is gone, so down should start again from the top rather than
		// resuming from a position that no longer exists.
		it("starts again from the top after the selection disappears", () => {
			const subject = nav(2);
			press(subject, DOWN, DOWN);
			registry.update("sub-1", { status: "completed" });
			clock = NOW + DEFAULT_LINGER_MS;

			press(subject, DOWN);

			expect(subject.selectedId).toBe("sub-0");
		});
	});

	describe("showing the selection", () => {
		it("marks the selected row and only that row", () => {
			const subject = nav(3);
			subject.render(80);
			press(subject, DOWN, DOWN);

			const lines = subject.render(80);

			expect(lines[1]).toContain(SELECTED_BG);
			expect(lines[0]).not.toContain(SELECTED_BG);
			expect(lines[2]).not.toContain(SELECTED_BG);
		});

		it("marks nothing when nothing is selected", () => {
			const subject = nav(3);

			for (const line of subject.render(80)) {
				expect(line).not.toContain(SELECTED_BG);
			}
		});

		it("moves the mark with the selection", () => {
			const subject = nav(3);
			press(subject, DOWN, DOWN, DOWN);

			const lines = subject.render(80);

			expect(lines[2]).toContain(SELECTED_BG);
			expect(lines[1]).not.toContain(SELECTED_BG);
		});

		/**
		 * A ragged highlight is worse than none: the eye follows the block, so it
		 * has to be the full width of the column.
		 *
		 * The subagent deliberately has no context reading. A row *with* a
		 * percentage is padded anyway to right-align it, so it would pass this
		 * whether selection padded it or not.
		 */
		it("highlights the whole width of the row", () => {
			registry.add(record({ contextPercent: null }));
			const subject = list({ editorText: () => "" });
			press(subject, "\x1b[B");

			const line = subject.render(80)[0] ?? "";

			expect(subject.selectedId).toBe("abc123");
			expect(visibleWidth(line)).toBe(80);
		});
	});
});
