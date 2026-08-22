import { describe, expect, it } from "vitest";
import { layoutColumns, ROWS_PER_COLUMN } from "../../src/ui/layout.ts";

/** Stand-ins for records; layout neither reads nor cares what these are. */
const items = (count: number) =>
	Array.from({ length: count }, (_, i) => `item-${i}`);

describe("layoutColumns", () => {
	/**
	 * The specification's Scenario Outline, quoted exactly: count, columns, and
	 * the size of the first column.
	 */
	it.each([
		{ count: 3, columns: 1, first: 3 },
		{ count: 5, columns: 1, first: 5 },
		{ count: 6, columns: 2, first: 5 },
		{ count: 10, columns: 2, first: 5 },
	])(
		"Splits into columns past five subagents: $count → $columns column(s), first has $first",
		({ count, columns, first }) => {
			const laid = layoutColumns(items(count), ROWS_PER_COLUMN);

			expect(laid).toHaveLength(columns);
			expect(laid[0]).toHaveLength(first);
		},
	);

	it("fills five per column before starting another", () => {
		expect(ROWS_PER_COLUMN).toBe(5);
	});

	it("keeps every item, in order, reading down each column", () => {
		expect(layoutColumns(items(7), 5)).toEqual([
			["item-0", "item-1", "item-2", "item-3", "item-4"],
			["item-5", "item-6"],
		]);
	});

	// An empty list is no columns rather than one empty column: the list has
	// nothing to draw, and a caller should not have to look inside to find out.
	it("gives no columns at all for nothing", () => {
		expect(layoutColumns([], 5)).toEqual([]);
	});

	it("spills into a third column and beyond", () => {
		const laid = layoutColumns(items(11), 5);

		expect(laid).toHaveLength(3);
		expect(laid.map((column) => column.length)).toEqual([5, 5, 1]);
	});

	it("puts each item in its own column when only one fits", () => {
		expect(layoutColumns(items(3), 1)).toEqual([
			["item-0"],
			["item-1"],
			["item-2"],
		]);
	});

	/**
	 * A column holding no rows could never be filled, so chunking by it would
	 * loop forever. Clamping to one keeps the pathological caller making
	 * progress rather than hanging the render.
	 */
	it.each([0, -3, 0.5, Number.NaN])(
		"treats a column size of %p as one row per column",
		(nonsense) => {
			expect(layoutColumns(items(2), nonsense)).toEqual([
				["item-0"],
				["item-1"],
			]);
		},
	);
});
