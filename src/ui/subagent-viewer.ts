/**
 * One subagent's conversation, opened over the session that spawned it.
 *
 * The list below the prompt says what every subagent is doing; this says what
 * one of them is actually saying, and is where it is talked back to. It is
 * shown as a focused overlay, so unlike the list it receives keys directly:
 * they go to the prompt at the foot of the panel, enter sends what is typed
 * there, ctrl+x stops the subagent, and escape clears the prompt and then
 * closes the view.
 *
 * Two things about it are drawn rather than assumed. The frame is one: pi's
 * overlays carry no border of their own, so a panel without one reads as more
 * of the conversation underneath it. The prompt is the other: it is always on
 * screen for a subagent that can still be reached, because steering hidden
 * behind a keypress is steering nobody finds.
 *
 * The view draws from the child's messages rather than from a copy of its own,
 * which is what lets it stay open after the subagent finishes — a disposed
 * session still answers for its transcript, and the final answer is the reason
 * anyone opened the view in the first place.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ControlResult } from "../control.ts";
import {
	type SubagentRecord,
	type SubagentRegistry,
	TERMINAL_STATUSES,
} from "../registry.ts";
import { STATUS_COLOR, STATUS_MARK } from "./status.ts";
import { Transcript } from "./transcript.ts";

/**
 * The frame's glyphs, heavy throughout.
 *
 * Heavy rather than light on purpose: the panel sits over a conversation drawn
 * in the same colours, and a thin rule beside a transcript's own box-drawing is
 * not an edge anyone reads as one.
 */
const FRAME = {
	topLeft: "┏",
	topRight: "┓",
	bottomLeft: "┗",
	bottomRight: "┛",
	side: "┃",
	rule: "━",
	teeLeft: "┣",
	teeRight: "┫",
} as const;

/** Cells a rail spends on corners and on the lead-in rule. */
const RAIL_CHROME = 3;

/** Cells a content row spends on its two sides and their padding. */
const ROW_CHROME = 4;

/** What the bottom rail offers, by whether the subagent can still be reached. */
const LIVE_HINTS = "enter steer · ctrl+x stop · esc close";
const FINISHED_HINTS = "esc close";

export interface SubagentViewerOptions {
	record: SubagentRecord;
	/** Watched so the header follows the subagent's status while it is open. */
	registry: SubagentRegistry;
	theme: Theme;
	/** Handed to the transcript's tool components, and asked for redraws. */
	tui: TUI;
	cwd: string;
	/** Closes the view. In a session this is pi's own `done` callback. */
	close: () => void;
	/**
	 * Sends the composed message. Handed in rather than reached for: steering a
	 * subagent that has not started yet writes to the registry, which the caller
	 * owns.
	 */
	steer: (record: SubagentRecord, message: string) => Promise<ControlResult>;
	/**
	 * Halts the subagent and tells the main model it will get no answer.
	 *
	 * Optional because a view with no way to stop anything is still a working
	 * view; the key then reports that there is nothing it can do.
	 */
	stop?: (record: SubagentRecord) => Promise<ControlResult>;
	/** Rows the view may use. Defaults to the terminal's height. */
	rows?: () => number;
	/** Defaults to asking the TUI. */
	requestRender?: () => void;
}

/** Pad a rendered line out to `width`, counting only what is visible. */
function pad(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

export class SubagentViewer implements Component {
	readonly #options: SubagentViewerOptions;
	readonly #transcript: Transcript;
	readonly #teardown: Array<() => void> = [];
	readonly #requestRender: () => void;
	/**
	 * The prompt, made once and kept.
	 *
	 * Always here, drawn only while the subagent can be reached: a subagent that
	 * finishes mid-message takes its prompt off screen, and rebuilding the input
	 * on every status change would lose what was being typed to a subagent that
	 * is still running.
	 */
	readonly #input = new Input();
	/** What the last steer or stop came back with, shown until the next one. */
	#notice: string | undefined;
	/** Whether this view is already listening to the child's session. */
	#subscribed = false;

	constructor(options: SubagentViewerOptions) {
		this.#options = options;
		this.#requestRender =
			options.requestRender ?? (() => options.tui.requestRender());
		// Focus belongs to this view, not to the input, so the input is told it
		// has it — that is what makes it draw a cursor. Escape never reaches it:
		// this view takes that key first, and what it means depends on whether
		// anything has been typed.
		this.#input.focused = true;
		this.#input.onSubmit = (value) => this.#submit(value);
		this.#transcript = new Transcript({
			tui: options.tui,
			cwd: options.cwd,
			// Read through the record each time: a queued subagent has no session
			// yet, and the one it gets is what knows how its tools are drawn.
			getToolDefinition: (name) =>
				this.#options.record.session?.getToolDefinition(name),
		});

		// The registry reports a status change; the session reports the
		// conversation moving. Both are needed: a queued subagent's session
		// arrives through the registry, and its messages only through the session.
		this.#teardown.push(
			options.registry.onChange(() => {
				this.#watchSession();
				this.#requestRender();
			}),
		);
		this.#watchSession();
	}

	/**
	 * Listen to the child's session, once it has one.
	 *
	 * A subagent opened while it waits for a slot has no session at all, so this
	 * is tried again on every registry change until there is one to watch.
	 */
	#watchSession(): void {
		const { session } = this.#options.record;
		if (this.#subscribed || !session) {
			return;
		}

		this.#subscribed = true;
		// Every event, rather than the few that obviously add content: text
		// arrives on `message_update`, tool calls on `message_end`, results on
		// their own events, and a missed one is a view that has quietly stopped
		// following. Syncing is cheap when nothing has changed.
		this.#teardown.push(session.subscribe(() => this.#requestRender()));
	}

	/** Let go of the registry and the child's session. Called by pi on close. */
	dispose(): void {
		for (const stop of this.#teardown.splice(0)) {
			stop();
		}
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - ROW_CHROME);
		const rows = Math.max(1, this.#rows());
		const live = !TERMINAL_STATUSES.has(this.#options.record.status);
		const foot = this.#foot(width, inner, live);
		const body = this.#body(inner).map((line) => this.#row(line, width));
		// Two rails and whatever the foot came to. What is left is the
		// conversation's. `slice(-0)` returns the whole array rather than none of
		// it, so a budget of zero is taken as the special case it is.
		const budget = Math.max(0, rows - 2 - foot.length);

		// The tail, not the head: a view that follows a working subagent has to
		// show what it just said. Anything older has scrolled off, which is what
		// the transcript on disk is for.
		const shown = budget === 0 ? [] : body.slice(-budget);

		// Padded to the full budget, above the conversation, so the panel is the
		// same height in every frame and what was said last sits against the
		// prompt. A panel that grew and shrank with its transcript left its
		// taller self on screen: pi renders differentially and skips the pass
		// that clears rows nothing covers any more while an overlay is up
		// (`pi-tui/dist/tui-main-screen.js:255`), which is how one panel came to
		// be three stacked title bars.
		const filler = Array.from({ length: budget - shown.length }, () =>
			this.#row("", width),
		);

		const lines = [
			this.#header(width),
			...filler,
			...shown,
			...foot,
			this.#rail(
				FRAME.bottomLeft,
				FRAME.bottomRight,
				live ? LIVE_HINTS : FINISHED_HINTS,
				width,
			),
		];

		// Never taller than the rows given. Pi slices an overlay that overruns
		// its height from the bottom (`pi-tui/dist/tui.js:819`), and the bottom
		// of this panel is the prompt and the keys — so overrunning loses
		// precisely the parts that are worth keeping. Only reachable on a
		// terminal too short for the frame itself, where the end is what is worth
		// keeping for the same reason.
		return lines.length <= rows ? lines : lines.slice(-rows);
	}

	/**
	 * Rows this panel may draw.
	 *
	 * Its overlay's height, not the terminal's: the two are not the same, and
	 * the caller that sizes the overlay is the one that knows. Falling back to
	 * the terminal keeps a viewer built without one — a test's — working.
	 */
	#rows(): number {
		return this.#options.rows?.() ?? this.#options.tui.terminal.rows;
	}

	/**
	 * A rail: two corners, a lead-in rule, whatever is inlaid, and rule to the
	 * end of the row.
	 *
	 * The label is laid into the frame rather than given a row of its own,
	 * because the panel's two most useful lines — which subagent this is, and
	 * what the keys do — are also the two the transcript would push off screen
	 * first if they were content.
	 */
	#rail(left: string, right: string, label: string, width: number): string {
		const { theme } = this.#options;
		const room = Math.max(0, width - RAIL_CHROME - 2);
		const inlaid = label ? ` ${truncateToWidth(label, room, "…", false)} ` : "";
		const fill = FRAME.rule.repeat(
			Math.max(0, width - RAIL_CHROME - visibleWidth(inlaid)),
		);

		return (
			theme.fg("borderAccent", `${left}${FRAME.rule}`) +
			inlaid +
			theme.fg("borderAccent", `${fill}${right}`)
		);
	}

	/** One line of content, held between the frame's sides. */
	#row(line: string, width: number): string {
		const { theme } = this.#options;
		const inner = Math.max(0, width - ROW_CHROME);
		// Only when it would overflow: truncating unconditionally would rewrite
		// the prompt's line, and the cursor is a marker inside it.
		const fitted =
			visibleWidth(line) > inner
				? truncateToWidth(line, inner, "…", false)
				: line;
		const side = theme.fg("borderAccent", FRAME.side);
		return `${side} ${pad(fitted, inner)} ${side}`;
	}

	/**
	 * The top rail: the subagent, named the way its row in the list names it,
	 * and its status.
	 */
	#header(width: number): string {
		const { record, theme } = this.#options;
		const percent =
			record.contextPercent === null
				? ""
				: ` ${Math.round(record.contextPercent)}%`;
		const mark = theme.fg(
			STATUS_COLOR[record.status],
			STATUS_MARK[record.status],
		);
		return this.#rail(
			FRAME.topLeft,
			FRAME.topRight,
			`${mark} ${record.handle} — ${record.description}${percent}`,
			width,
		);
	}

	/**
	 * The conversation, or why there is not one yet.
	 *
	 * A subagent still waiting for a slot has nothing to show and no session to
	 * show it from, which is worth saying rather than leaving as a blank panel.
	 */
	#body(width: number): string[] {
		const { record, theme } = this.#options;
		const { session } = record;
		if (!session) {
			return [theme.fg("muted", " Waiting for a free slot.")];
		}

		this.#transcript.sync(session.messages, session.state.streamingMessage);
		const lines = this.#transcript.render(width);
		return lines.length > 0 ? lines : [theme.fg("muted", " Nothing said yet.")];
	}

	/**
	 * Everything between the conversation and the bottom rail: the prompt, and
	 * whatever the last steer or stop came back with.
	 *
	 * A notice sits directly above the prompt, because the answer to "did that
	 * work" belongs next to where the message was typed. The rule above them
	 * separates the panel's own rows from the subagent's, which otherwise run
	 * together.
	 */
	#foot(width: number, inner: number, live: boolean): string[] {
		const { theme } = this.#options;
		const rows: string[] = [];

		if (this.#notice) {
			rows.push(this.#row(theme.fg("muted", this.#notice), width));
		}

		if (live) {
			rows.push(
				...this.#input.render(inner).map((line) => this.#row(line, width)),
			);
		}

		return rows.length > 0
			? [this.#rail(FRAME.teeLeft, FRAME.teeRight, "", width), ...rows]
			: rows;
	}

	handleInput(data: string): void {
		// Taken before the prompt sees it, and taken whatever is half-typed: a
		// subagent that should be stopped should not have to be stopped twice.
		if (matchesKey(data, Key.ctrl("x"))) {
			this.#stop();
			return;
		}

		const live = !TERMINAL_STATUSES.has(this.#options.record.status);

		if (matchesKey(data, Key.escape)) {
			// A half-typed message goes before the view does. The prompt is always
			// open now, so escape closing outright would throw a message away every
			// time somebody changed their mind about sending it.
			if (live && this.#input.getValue() !== "") {
				this.#input.setValue("");
				this.#requestRender();
				return;
			}
			this.#options.close();
			return;
		}

		// Nothing to type to. A finished subagent's view is for reading, and its
		// keys are the ones the bottom rail names.
		if (!live) {
			return;
		}

		this.#input.handleInput(data);
		this.#requestRender();
	}

	/** An empty message is not one: there is nothing to send. */
	#submit(value: string): void {
		if (!value.trim()) {
			return;
		}

		this.#input.setValue("");
		this.#notice = "Sending…";
		this.#requestRender();
		void this.#options.steer(this.#options.record, value).then((result) => {
			this.#report(result, "Sent.");
		});
	}

	#stop(): void {
		const { stop, record } = this.#options;
		if (!stop) {
			this.#notice = "Stopping is not available here.";
			this.#requestRender();
			return;
		}

		this.#notice = "Stopping…";
		this.#requestRender();
		void stop(record).then((result) => {
			this.#report(result, "Stopped.");
		});
	}

	/** Whatever an operation came back with, put where the key was pressed. */
	#report(result: ControlResult, done: string): void {
		this.#notice = result.ok ? done : `Cannot do that: ${result.reason}.`;
		this.#requestRender();
	}

	/** The transcript's components cache their rendering; drop it. */
	invalidate(): void {
		this.#transcript.invalidate();
	}
}
