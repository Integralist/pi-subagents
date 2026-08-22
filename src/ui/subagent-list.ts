/**
 * The list of subagents, drawn below the prompt.
 *
 * The point of this list is that a subagent's progress is visible without
 * leaving the prompt: what is running, what it was asked for, and how much of
 * its context window it has eaten. It redraws from the registry, so it never
 * holds a second copy of the truth — a status the registry has moved on from
 * cannot linger here.
 *
 * `render` is deliberately free of side effects. Everything it needs to decide
 * what to show is already on the records, which is what lets a test move a clock
 * and re-render rather than wait.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { colorize } from "../colors.ts";
import {
	type SubagentRecord,
	type SubagentRegistry,
	TERMINAL_STATUSES,
} from "../registry.ts";
import { layoutColumns, ROWS_PER_COLUMN } from "./layout.ts";
import { STATUS_COLOR, STATUS_MARK } from "./status.ts";

/**
 * How long a finished subagent stays on screen.
 *
 * Long enough to read a result that arrived while looking elsewhere, short
 * enough that a busy session's list is about work still in progress. A finished
 * subagent is not lost when its row goes: the answer is in the transcript, and
 * `get_subagent_result` still has it.
 */
export const DEFAULT_LINGER_MS = 10_000;

/** Blank columns between one column of rows and the next. */
const GUTTER = 2;

/**
 * Narrowest a column may be before the list gives up on columns.
 *
 * Below this a row is all truncation and no information, so a narrow terminal
 * gets one tall column instead of several useless ones.
 */
const MIN_COLUMN_WIDTH = 24;

export interface SubagentListOptions {
	registry: SubagentRegistry;
	theme: Theme;
	/**
	 * Ask the host to redraw.
	 *
	 * Given this, the list subscribes to the registry and keeps itself current.
	 * Omitting it leaves a list that only draws when asked, which is all a test
	 * about layout needs.
	 */
	requestRender?: () => void;
	/** Rows per column. Defaults to the five the specification pins. */
	perColumn?: number;
	/** How long a finished subagent's row stays. */
	lingerMs?: number;
	/** Seams for a deterministic test. */
	now?: () => number;
	delay?: (fn: () => void, ms: number) => void;
}

/**
 * `setTimeout` that cannot hold the process open on its own.
 *
 * The redraw a lingering row needs is a courtesy, not work: if pi is shutting
 * down there is nothing left to draw, and an outstanding timer that kept node
 * alive for it would delay every exit by up to the linger.
 */
function laterUnref(fn: () => void, ms: number): void {
	const timer = setTimeout(fn, ms);
	timer.unref?.();
}

/**
 * Widest a name column gets before names are truncated instead.
 *
 * One subagent with a long name would otherwise push every description across
 * the column, spending the row's width on whitespace beside the short names.
 */
const MAX_NAME_WIDTH = 16;

/**
 * How wide the name column should be for these rows.
 *
 * Names are padded to a common width so every description starts in the same
 * place. Ragged left edges are what makes a list of short rows hard to scan,
 * which is the whole reason the list exists.
 */
function nameWidth(records: SubagentRecord[]): number {
	const widest = Math.max(
		...records.map((record) => visibleWidth(record.handle)),
	);
	return Math.min(widest, MAX_NAME_WIDTH);
}

/**
 * One row: status glyph, the subagent's name in its own colour, what it was
 * asked to do, and its context use.
 *
 * Padding is worked out from the plain text and applied to the coloured text,
 * so the escape codes never enter the arithmetic. The percentage is pinned to
 * the right of the column and the description gives up whatever room it needs.
 */
function renderRow(
	record: SubagentRecord,
	theme: Theme,
	width: number,
	nameColumn: number,
): string {
	const mark = STATUS_MARK[record.status];
	const name = truncateToWidth(record.handle, nameColumn, "…", true);
	// Null is not zero: nobody knows the figure yet, so the column stays blank
	// rather than claiming an empty context window.
	const percent =
		record.contextPercent === null
			? ""
			: `${Math.round(record.contextPercent)}%`;

	// mark, space, name, space — then the description, then the percentage
	// preceded by its own space when there is one.
	const used = visibleWidth(mark) + 1 + visibleWidth(name) + 1;
	const tail = percent === "" ? 0 : visibleWidth(percent) + 1;
	const room = Math.max(0, width - used - tail);

	// Padded only when a percentage follows, which is what right-aligns it.
	// Without one there is nothing to push over, and the trailing spaces would
	// fill the row to the terminal's last column for no reason.
	const description = truncateToWidth(
		record.description,
		room,
		"…",
		percent !== "",
	);

	return [
		theme.fg(STATUS_COLOR[record.status], mark),
		" ",
		colorize(record.color, name),
		" ",
		theme.fg("muted", description),
		percent === "" ? "" : ` ${theme.fg("dim", percent)}`,
	].join("");
}

/** Pad a rendered cell out to `width`, counting only what is visible. */
function padCell(cell: string, width: number): string {
	return cell + " ".repeat(Math.max(0, width - visibleWidth(cell)));
}

/**
 * How many columns `width` has room for, and how wide each one is.
 *
 * A column narrower than `MIN_COLUMN_WIDTH` is worse than a longer list, so the
 * count is reduced until each column has room to say something.
 */
function fitColumns(
	width: number,
	wanted: number,
): { count: number; columnWidth: number } {
	for (let count = wanted; count > 1; count--) {
		const columnWidth = Math.floor((width - GUTTER * (count - 1)) / count);
		if (columnWidth >= MIN_COLUMN_WIDTH) {
			return { count, columnWidth };
		}
	}
	return { count: 1, columnWidth: Math.max(1, width) };
}

export class SubagentList implements Component {
	readonly #registry: SubagentRegistry;
	readonly #theme: Theme;
	readonly #perColumn: number;
	readonly #lingerMs: number;
	readonly #now: () => number;
	readonly #delay: (fn: () => void, ms: number) => void;
	readonly #requestRender: () => void;
	readonly #unsubscribe: (() => void) | undefined;
	/** Records with a redraw already scheduled, so each is only queued once. */
	readonly #expiring = new Set<string>();

	constructor(options: SubagentListOptions) {
		this.#registry = options.registry;
		this.#theme = options.theme;
		this.#perColumn = options.perColumn ?? ROWS_PER_COLUMN;
		this.#lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
		this.#now = options.now ?? Date.now;
		this.#delay = options.delay ?? laterUnref;
		this.#requestRender = options.requestRender ?? (() => {});
		this.#unsubscribe = options.requestRender
			? this.#registry.onChange(() => this.#handleChange())
			: undefined;
	}

	/**
	 * Redraw now, and again when the oldest lingering row is due to leave.
	 *
	 * The second part is what makes a finished subagent actually disappear. Its
	 * row expires on a clock rather than on anything the registry will report, so
	 * without a scheduled redraw the last finished subagent in a quiet session
	 * would sit there until something unrelated happened.
	 */
	#handleChange(): void {
		this.#requestRender();

		const now = this.#now();
		for (const record of this.#registry.list()) {
			if (record.finishedAt === undefined || this.#expiring.has(record.id)) {
				continue;
			}

			const remaining = record.finishedAt + this.#lingerMs - now;
			if (remaining <= 0) {
				continue;
			}

			this.#expiring.add(record.id);
			this.#delay(() => {
				this.#expiring.delete(record.id);
				this.#requestRender();
			}, remaining);
		}
	}

	/** Stop watching the registry. Called by pi when the widget goes away. */
	dispose(): void {
		this.#unsubscribe?.();
	}

	/**
	 * The subagents worth showing: everything still going, plus anything that
	 * finished recently enough to still be worth reading.
	 *
	 * `finishedAt` is always set on a terminal record — the registry stamps it as
	 * the status changes, and on `add` for one that arrives already finished — so
	 * the fallback here is only what satisfies the optional type. Treating a
	 * missing stamp as long ago rather than as just now is the safer of the two:
	 * a stale row is worse than a missing one.
	 */
	visible(): SubagentRecord[] {
		const now = this.#now();
		return this.#registry
			.list()
			.filter(
				(record) =>
					!TERMINAL_STATUSES.has(record.status) ||
					now - (record.finishedAt ?? 0) < this.#lingerMs,
			);
	}

	render(width: number): string[] {
		const records = this.visible();
		if (records.length === 0) {
			return [];
		}

		const wanted = layoutColumns(records, this.#perColumn);
		const { count, columnWidth } = fitColumns(width, wanted.length);
		// Re-laid out at the width that actually fits: dropping to fewer columns
		// means more rows per column, not rows quietly going missing.
		const columns =
			count === wanted.length
				? wanted
				: layoutColumns(records, Math.ceil(records.length / count));

		// One name width across every column, so the whole list lines up rather
		// than each column finding its own alignment.
		const nameColumn = nameWidth(records);
		const cells = columns.map((column) =>
			column.map((record) =>
				renderRow(record, this.#theme, columnWidth, nameColumn),
			),
		);
		const height = Math.max(...cells.map((column) => column.length));

		const lines: string[] = [];
		for (let row = 0; row < height; row++) {
			const line = cells
				.map((column, index) => {
					const cell = column[row] ?? "";
					// The last column needs no padding — nothing follows it, and
					// trailing spaces only make a line wrap on a narrow terminal.
					return index === cells.length - 1 ? cell : padCell(cell, columnWidth);
				})
				.join(" ".repeat(GUTTER));
			lines.push(line.trimEnd());
		}
		return lines;
	}

	/** Nothing is cached, so there is nothing to throw away. */
	invalidate(): void {}
}
