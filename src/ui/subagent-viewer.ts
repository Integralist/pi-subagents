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
import { colorize } from "../colors.ts";
import type { ControlResult } from "../control.ts";
import {
	type SubagentRecord,
	type SubagentRegistry,
	TERMINAL_STATUSES,
} from "../registry.ts";
import { STATUS_MARK } from "./status.ts";
import { formatMeta } from "./subagent-list.ts";
import { Transcript } from "./transcript.ts";

const RULE = "─";

/** What the bottom rail offers, by whether the subagent can still be reached. */
const LIVE_HINTS = "scroll · enter steer · ctrl+x stop · esc close";
const FINISHED_HINTS = "scroll · esc close";

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
	/** Number of lines scrolled up from the bottom. 0 means pinned to the latest output. */
	#scrollOffset = 0;
	/** Number of transcript lines visible in the last render pass. */
	#lastBudget = 0;

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
		const inner = Math.max(1, width - 2);
		const rows = Math.max(1, this.#rows());
		const live = !TERMINAL_STATUSES.has(this.#options.record.status);
		const foot = this.#foot(width, inner, live);
		const body = this.#body(inner);
		// Top divider, bottom divider, and whatever the foot came to.
		const budget = Math.max(0, rows - 2 - foot.length);
		this.#lastBudget = budget;

		// Clamp scroll offset to valid bounds.
		const maxScroll = Math.max(0, body.length - budget);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxScroll);

		const startIndex = Math.max(0, body.length - budget - this.#scrollOffset);
		const endIndex = Math.min(body.length, startIndex + budget);
		const shown = budget === 0 ? [] : body.slice(startIndex, endIndex);

		// Padded to the full budget above the conversation.
		const filler = Array.from({ length: budget - shown.length }, () => "");

		const scrollBadge =
			this.#scrollOffset > 0 ? ` [↑${this.#scrollOffset}]` : "";
		const bottomLabel = (live ? LIVE_HINTS : FINISHED_HINTS) + scrollBadge;

		const lines = [
			this.#header(width),
			...filler,
			...shown,
			...foot,
			this.#divider(bottomLabel, width),
		];

		return lines.length <= rows ? lines : lines.slice(-rows);
	}

	/**
	 * Rows this panel may draw.
	 */
	#rows(): number {
		return this.#options.rows?.() ?? this.#options.tui.terminal.rows;
	}

	/** A horizontal divider with optional inlaid label in the subagent's color. */
	#divider(label: string, width: number): string {
		const { record } = this.#options;
		if (!label) {
			return colorize(record.color, RULE.repeat(Math.max(0, width)));
		}

		const room = Math.max(0, width - 4);
		const inlaid = ` ${truncateToWidth(label, room, "…", false)} `;
		const fill = Math.max(0, width - visibleWidth(inlaid));
		const left = Math.floor(fill / 2);
		const right = fill - left;
		return colorize(
			record.color,
			`${RULE.repeat(left)}${inlaid}${RULE.repeat(right)}`,
		);
	}

	/**
	 * The top banner strip: prominently colored in the subagent's color.
	 */
	#header(width: number): string {
		const { record } = this.#options;
		const meta = formatMeta(record);
		const metaSuffix = meta ? ` (${meta})` : "";
		const mark = STATUS_MARK[record.status];
		const label = ` SUBAGENT: ${mark} ${record.handle} — ${record.description}${metaSuffix} `;
		const room = Math.max(0, width - 4);
		const inlaid = truncateToWidth(label, room, "…", false);
		const fill = Math.max(0, width - visibleWidth(inlaid));
		const left = Math.floor(fill / 2);
		const right = fill - left;
		return colorize(
			record.color,
			`${"━".repeat(left)}${inlaid}${"━".repeat(right)}`,
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
			return [theme.fg("muted", "Waiting for a free slot.")];
		}

		this.#transcript.sync(session.messages, session.state.streamingMessage);
		const lines = this.#transcript.render(width);
		return lines.length > 0 ? lines : [theme.fg("muted", "Nothing said yet.")];
	}

	/**
	 * Everything between the conversation and the bottom rail: the prompt, and
	 * whatever the last steer or stop came back with.
	 */
	#foot(width: number, inner: number, live: boolean): string[] {
		const { theme } = this.#options;
		const rows: string[] = [];

		if (this.#notice) {
			rows.push(theme.fg("muted", this.#notice));
		}

		if (live) {
			rows.push(...this.#input.render(inner));
		}

		return rows.length > 0 ? [this.#divider("", width), ...rows] : rows;
	}

	#pageStep(): number {
		const budget = this.#lastBudget > 0 ? this.#lastBudget : this.#rows() - 4;
		return Math.max(1, Math.floor(budget / 2));
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

		const promptEmpty = !live || this.#input.getValue() === "";

		// PageUp / PageDown always scroll the transcript
		if (matchesKey(data, Key.pageUp)) {
			this.#scrollOffset += this.#pageStep();
			this.#requestRender();
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#pageStep());
			this.#requestRender();
			return;
		}

		// When prompt is empty, navigation & readline keys scroll the transcript
		if (promptEmpty) {
			if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("b"))) {
				this.#scrollOffset += this.#pageStep();
				this.#requestRender();
				return;
			}

			if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.ctrl("f"))) {
				this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#pageStep());
				this.#requestRender();
				return;
			}

			if (matchesKey(data, Key.home)) {
				this.#scrollOffset = Number.MAX_SAFE_INTEGER;
				this.#requestRender();
				return;
			}

			if (matchesKey(data, Key.end)) {
				this.#scrollOffset = 0;
				this.#requestRender();
				return;
			}

			if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("up"))) {
				this.#scrollOffset += 1;
				this.#requestRender();
				return;
			}

			if (matchesKey(data, Key.down) || matchesKey(data, Key.shift("down"))) {
				if (this.#scrollOffset > 0) {
					this.#scrollOffset -= 1;
					this.#requestRender();
				}
				return;
			}
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
		this.#scrollOffset = 0;
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
