/**
 * One subagent's conversation, opened over the session that spawned it.
 *
 * The list below the prompt says what every subagent is doing; this says what
 * one of them is actually saying. It is shown as a focused overlay, so unlike
 * the list it receives keys directly: enter opens a composer that steers the
 * subagent, delete stops it, and escape closes the view.
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
// The glyph alone carries the status here: the header sits on the selection
// background, and a status colour on top of it reads as a rendering fault
// rather than as information.
import { STATUS_MARK } from "./status.ts";
import { Transcript } from "./transcript.ts";

/** Rows the view keeps for the conversation when the terminal is tiny. */
const MIN_BODY_ROWS = 3;

/**
 * Rows the view leaves to the session underneath.
 *
 * An overlay that filled the terminal would hide the prompt it was opened from,
 * which is disorientating for a view that closes on one key.
 */
const RESERVED_ROWS = 4;

/** What the footer offers, by whether the subagent can still be reached. */
const LIVE_HINTS = "enter steer · del stop · esc close";
const FINISHED_HINTS = "esc close";
const COMPOSING_HINTS = "enter sends · esc abandons";

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
	/** The composer, while one is open. Its presence is the composing state. */
	#composer: Input | undefined;
	/** What the last steer or stop came back with, shown until the next one. */
	#notice: string | undefined;
	/** Whether this view is already listening to the child's session. */
	#subscribed = false;

	constructor(options: SubagentViewerOptions) {
		this.#options = options;
		this.#requestRender =
			options.requestRender ?? (() => options.tui.requestRender());
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
		const footer = this.#footer(width);
		const body = this.#body(width);
		// One row for the header, the footer's own, and the rows left to the
		// session underneath. What is left is the conversation's.
		const budget = Math.max(
			MIN_BODY_ROWS,
			this.#rows() - 1 - footer.length - RESERVED_ROWS,
		);

		// The tail, not the head: a view that follows a working subagent has to
		// show what it just said. Anything older has scrolled off, which is what
		// the transcript on disk is for.
		return [this.#header(width), ...body.slice(-budget), ...footer];
	}

	#rows(): number {
		return this.#options.rows?.() ?? this.#options.tui.terminal.rows;
	}

	/**
	 * The subagent, named the way its row in the list names it, and its status.
	 *
	 * Drawn on the selection background so the view reads as a panel over the
	 * session rather than as more conversation.
	 */
	#header(width: number): string {
		const { record, theme } = this.#options;
		const percent =
			record.contextPercent === null
				? ""
				: ` ${Math.round(record.contextPercent)}%`;
		const heading = `${STATUS_MARK[record.status]} ${record.handle} — ${record.description}${percent}`;
		return theme.bg(
			"selectedBg",
			pad(truncateToWidth(heading, width, "…", false), width),
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
	 * The composer when one is open, and otherwise what the keys do.
	 *
	 * A notice from the last steer or stop sits above either, because the answer
	 * to "did that work" belongs next to where the key was pressed.
	 */
	#footer(width: number): string[] {
		const { record, theme } = this.#options;
		const lines: string[] = [];

		if (this.#notice) {
			lines.push(theme.fg("muted", ` ${this.#notice}`));
		}

		if (this.#composer) {
			// The bar stays, saying what the two keys the composer takes will do.
			// Without it the only way out of a half-typed message is a guess.
			lines.push(theme.bg("selectedBg", pad(` ${COMPOSING_HINTS}`, width)));
			lines.push(...this.#composer.render(width));
			return lines;
		}

		const hints = TERMINAL_STATUSES.has(record.status)
			? FINISHED_HINTS
			: LIVE_HINTS;
		lines.push(theme.bg("selectedBg", pad(` ${hints}`, width)));
		return lines;
	}

	handleInput(data: string): void {
		// The composer owns every key while it is open, including escape and
		// enter, which it reports back through the callbacks set up with it.
		if (this.#composer) {
			this.#composer.handleInput(data);
			this.#requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.#options.close();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.#compose();
			return;
		}

		if (matchesKey(data, Key.delete)) {
			this.#stop();
		}
	}

	/**
	 * Open a composer, or say why there is nothing to say anything to.
	 *
	 * Refusing here rather than on submit means nobody types a message for a
	 * subagent that finished while they were reading it — the message would be
	 * thrown away, which is worse than not asking for it.
	 */
	#compose(): void {
		if (TERMINAL_STATUSES.has(this.#options.record.status)) {
			this.#notice = "It has already finished, so it cannot be steered.";
			this.#requestRender();
			return;
		}

		const composer = new Input();
		// Focus belongs to this view, not to the composer, so the composer is
		// told it has it — that is what makes it draw a cursor.
		composer.focused = true;
		composer.onEscape = () => this.#closeComposer(undefined);
		composer.onSubmit = (value) => this.#submit(value);
		this.#composer = composer;
		this.#notice = undefined;
		this.#requestRender();
	}

	/** An empty message is a cancelled one: there is nothing to send. */
	#submit(value: string): void {
		if (!value.trim()) {
			this.#closeComposer(undefined);
			return;
		}

		this.#closeComposer("Sending…");
		void this.#options.steer(this.#options.record, value).then((result) => {
			this.#report(result, "Sent.");
		});
	}

	#closeComposer(notice: string | undefined): void {
		this.#composer = undefined;
		this.#notice = notice;
		this.#requestRender();
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
