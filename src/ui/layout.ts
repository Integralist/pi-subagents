/**
 * Arranging the subagent list into columns.
 *
 * Kept apart from the component that draws it because the arithmetic is the part
 * with edge cases — the specification pins it with a table of counts — and none
 * of it needs a terminal to test.
 */

/**
 * Rows in a column before the list starts another.
 *
 * Five, matching `DEFAULT_CONCURRENCY`: a session running the default number of
 * subagents at once fills exactly one column.
 */
export const ROWS_PER_COLUMN = 5;

/**
 * Chunk `items` into columns of at most `perColumn`, filling each before
 * starting the next.
 *
 * Reading order is down the first column and then down the second, which is why
 * this chunks rather than dealing round-robin: a reader scanning for the
 * subagent they launched first should find it at the top left.
 *
 * An empty list gives no columns, not one empty column — the list has nothing to
 * draw, and saying so here saves every caller looking inside to find out.
 */
export function layoutColumns<T>(items: T[], perColumn: number): T[][] {
	// A column with no room in it could never be filled, so the loop below would
	// never advance. Anything that is not a whole number of rows becomes one.
	const size = Number.isInteger(perColumn) && perColumn > 0 ? perColumn : 1;

	const columns: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		columns.push(items.slice(start, start + size));
	}
	return columns;
}
