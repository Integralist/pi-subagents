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
	Key,
	matchesKey,
	type TuiInputListener,
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
	/**
	 * The prompt's current text.
	 *
	 * Arrow keys are only taken when this is empty, so ordinary typing is never
	 * intercepted. Without it the list takes no arrows at all: there would be no
	 * way to tell an arrow meant for the list from one meant for the cursor, and
	 * stealing the cursor's arrows is the one thing here that would annoy daily.
	 */
	getEditorText?: () => string;
	/**
	 * Subscribe to the terminal's key presses, returning an unsubscribe.
	 *
	 * The list sits below the editor and never holds focus, so `handleInput` is
	 * never called on it — an input listener is the only way keys reach it. Owned
	 * here rather than by the caller so that `dispose` tears down everything this
	 * list attached.
	 */
	addInputListener?: (listener: TuiInputListener) => () => void;
	/**
	 * Open the selected subagent's conversation.
	 *
	 * The returned promise is how the list knows the view has closed: while one
	 * is open every key belongs to it, and the list must take none of them.
	 * Without that, escape would leave the list rather than close the view — the
	 * list's input listener runs before the focused component sees a key.
	 */
	onOpen?: (record: SubagentRecord) => Promise<void> | void;
	/**
	 * Halt the selected subagent.
	 *
	 * Reported nowhere here: a stop that worked shows up as the row's own status
	 * changing, and one that was refused is the caller's to put on screen.
	 */
	onStop?: (record: SubagentRecord) => void;
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
	selected: boolean,
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

	// Padded when a percentage follows, which is what right-aligns it, and when
	// the row is selected, so the highlight is a solid block rather than a
	// ragged one — the eye follows the block. Otherwise there is nothing to push
	// over and the spaces would fill the row to the terminal's last column.
	const description = truncateToWidth(
		record.description,
		room,
		"…",
		percent !== "" || selected,
	);

	const row = [
		theme.fg(STATUS_COLOR[record.status], mark),
		" ",
		colorize(record.color, name),
		" ",
		theme.fg("muted", description),
		percent === "" ? "" : ` ${theme.fg("dim", percent)}`,
	].join("");

	return selected ? theme.bg("selectedBg", row) : row;
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
	readonly #getEditorText: (() => string) | undefined;
	readonly #onOpen:
		| ((record: SubagentRecord) => Promise<void> | void)
		| undefined;
	readonly #onStop: ((record: SubagentRecord) => void) | undefined;
	/** True while an opened subagent's view is on screen and holding the keys. */
	#viewing = false;
	readonly #teardown: Array<() => void> = [];
	/** Records with a redraw already scheduled, so each is only queued once. */
	readonly #expiring = new Set<string>();
	/**
	 * The selected subagent, by id rather than by position.
	 *
	 * A row's position changes as subagents finish and drop out; its identity
	 * does not. An index would quietly come to mean a different subagent.
	 */
	#selectedId: string | undefined;
	/**
	 * The width the list was last drawn at, so navigation can lay the columns out
	 * the same way. Wide enough by default that a key pressed before the first
	 * draw still finds the columns the list is about to show.
	 */
	#lastWidth = 80;

	constructor(options: SubagentListOptions) {
		this.#registry = options.registry;
		this.#theme = options.theme;
		this.#perColumn = options.perColumn ?? ROWS_PER_COLUMN;
		this.#lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
		this.#now = options.now ?? Date.now;
		this.#delay = options.delay ?? laterUnref;
		this.#requestRender = options.requestRender ?? (() => {});
		this.#getEditorText = options.getEditorText;
		this.#onOpen = options.onOpen;
		this.#onStop = options.onStop;

		if (options.requestRender) {
			this.#teardown.push(this.#registry.onChange(() => this.#handleChange()));
		}
		if (options.addInputListener) {
			this.#teardown.push(
				options.addInputListener((data) =>
					// `undefined` rather than `{ consume: false }`: anything the list
					// did not take has to pass through to the editor untouched.
					this.handleKey(data) ? { consume: true } : undefined,
				),
			);
		}
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

	/**
	 * Let go of the registry and the keyboard. Called by pi when the widget goes
	 * away — a listener left attached would keep taking arrows for a list that is
	 * no longer on screen.
	 */
	dispose(): void {
		for (const stop of this.#teardown.splice(0)) {
			stop();
		}
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

	/**
	 * The columns as they would be drawn at `width`, and how wide each one is.
	 *
	 * Shared by drawing and navigating, so the two cannot disagree. A terminal
	 * too narrow for two columns shows one, and `right` must not then move to a
	 * column the user cannot see.
	 */
	#columnsFor(
		records: SubagentRecord[],
		width: number,
	): { columns: SubagentRecord[][]; columnWidth: number } {
		const wanted = layoutColumns(records, this.#perColumn);
		const { count, columnWidth } = fitColumns(width, wanted.length);
		// Re-laid out at the width that actually fits: dropping to fewer columns
		// means more rows per column, not rows quietly going missing.
		const columns =
			count === wanted.length
				? wanted
				: layoutColumns(records, Math.ceil(records.length / count));
		return { columns, columnWidth };
	}

	render(width: number): string[] {
		const records = this.visible();
		if (records.length === 0) {
			return [];
		}

		// Remembered so navigation lays the columns out exactly as they were
		// drawn. The user can only move through what they can see.
		this.#lastWidth = width;
		const { columns, columnWidth } = this.#columnsFor(records, width);

		// One name width across every column, so the whole list lines up rather
		// than each column finding its own alignment.
		const nameColumn = nameWidth(records);
		const selected = this.selectedId;
		const cells = columns.map((column) =>
			column.map((record) =>
				renderRow(
					record,
					this.#theme,
					columnWidth,
					nameColumn,
					record.id === selected,
				),
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

	/**
	 * The selected subagent's id, or nothing when the prompt has focus.
	 *
	 * A selection whose subagent has since left the list reads as no selection:
	 * the row is gone, so there is nothing selected on screen, whatever this was
	 * pointing at.
	 */
	get selectedId(): string | undefined {
		if (this.#selectedId === undefined) {
			return undefined;
		}
		return this.visible().some((record) => record.id === this.#selectedId)
			? this.#selectedId
			: undefined;
	}

	/**
	 * Where the selection sits in the columns as drawn, if it is on screen.
	 */
	#position(
		columns: SubagentRecord[][],
	): { column: number; row: number } | undefined {
		const selected = this.selectedId;
		if (selected === undefined) {
			return undefined;
		}

		for (const [column, records] of columns.entries()) {
			const row = records.findIndex((record) => record.id === selected);
			if (row !== -1) {
				return { column, row };
			}
		}
		return undefined;
	}

	/**
	 * Offer one key press to the list. Returns whether it was taken.
	 *
	 * Anything not taken must reach the editor untouched, which is why this
	 * reports rather than swallowing: a `false` here is the difference between a
	 * working cursor and a prompt that will not let you move through your own
	 * text.
	 */
	handleKey(data: string): boolean {
		// An opened subagent's view holds the keyboard while it is on screen. This
		// list's input listener is consulted before the focused view, so a key
		// taken here would act on the list instead — escape would leave the list
		// and the view would never close.
		if (this.#viewing) {
			return false;
		}

		// Escape is not an arrow, and a user with a half-typed prompt and a
		// selected row still means to leave the list. Only taken when there is a
		// selection to leave: escape means a great many things at a prompt, and
		// swallowing it while the list is idle would take it from all of them.
		if (matchesKey(data, Key.escape)) {
			if (this.selectedId === undefined) {
				return false;
			}
			this.#selectedId = undefined;
			this.#requestRender();
			return true;
		}

		// Every arrow belongs to the cursor unless the prompt is empty. With no
		// way to read the prompt, that cannot be known, so none are taken.
		if (this.#getEditorText?.() !== "") {
			return false;
		}

		const records = this.visible();
		if (records.length === 0) {
			return false;
		}

		// Both keys below act on the selected subagent, and neither is taken
		// without one: enter still submits the prompt, and delete still belongs to
		// the editor, whenever no row is selected.
		const selected = records.find((record) => record.id === this.selectedId);

		if (matchesKey(data, Key.enter)) {
			return selected ? this.#open(selected) : false;
		}

		if (matchesKey(data, Key.delete)) {
			if (!selected || !this.#onStop) {
				return false;
			}
			this.#onStop(selected);
			return true;
		}

		const { columns } = this.#columnsFor(records, this.#lastWidth);
		const at = this.#position(columns);

		if (matchesKey(data, Key.down)) {
			// Entering the list: the first row, wherever the selection had been.
			if (!at) {
				return this.#select(columns[0]?.[0]);
			}
			const column = columns[at.column] ?? [];
			return this.#select(column[Math.min(at.row + 1, column.length - 1)]);
		}

		if (matchesKey(data, Key.up)) {
			if (!at) {
				return false;
			}
			// Up past the first row leaves the list, rather than sticking at the
			// top with escape as the only way back to the prompt.
			if (at.row === 0) {
				this.#selectedId = undefined;
				this.#requestRender();
				return true;
			}
			return this.#select(columns[at.column]?.[at.row - 1]);
		}

		const sideways = matchesKey(data, Key.right)
			? 1
			: matchesKey(data, Key.left)
				? -1
				: 0;
		if (sideways !== 0) {
			// Nothing to cross to, so the arrow is left to the editor rather than
			// taken for a move that cannot happen.
			if (!at || columns.length < 2) {
				return false;
			}
			const target =
				columns[
					Math.min(Math.max(at.column + sideways, 0), columns.length - 1)
				];
			if (!target) {
				return false;
			}
			// Clamped, because the column moved to may be shorter than this one.
			return this.#select(target[Math.min(at.row, target.length - 1)]);
		}

		return false;
	}

	/**
	 * Show the selected subagent's conversation, standing down until it closes.
	 *
	 * The promise the caller returns is the only signal that the view has gone. A
	 * rejection releases the keyboard just as a close does: a view that failed to
	 * open is not on screen, and a list that stayed silent afterwards would be a
	 * list with no navigation and no way to get it back.
	 */
	#open(record: SubagentRecord): boolean {
		if (!this.#onOpen) {
			return false;
		}

		this.#viewing = true;
		try {
			void Promise.resolve(this.#onOpen(record))
				.catch(() => {})
				.finally(() => this.#release());
		} catch {
			this.#release();
		}
		return true;
	}

	#release(): void {
		this.#viewing = false;
		this.#requestRender();
	}

	/** Take a row as the selection, reporting the key as consumed either way. */
	#select(record: SubagentRecord | undefined): boolean {
		if (!record) {
			return false;
		}
		if (record.id !== this.#selectedId) {
			this.#selectedId = record.id;
			this.#requestRender();
		}
		return true;
	}

	/** Nothing is cached, so there is nothing to throw away. */
	invalidate(): void {}
}
