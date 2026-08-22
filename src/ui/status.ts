/**
 * How a subagent's status looks on screen.
 *
 * One glyph and one theme colour per status, shared by the two things that draw
 * a subagent: the completion notice in the transcript and the list below the
 * prompt. Kept together so a subagent cannot be a `✓` in one place and a `◼` in
 * the other.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { SubagentStatus } from "../registry.ts";

/**
 * Single-width characters only. A glyph two cells wide would push every row's
 * columns out of line by one, and the misalignment is not obvious enough in
 * review to be worth risking.
 */
export const STATUS_MARK: Record<SubagentStatus, string> = {
	queued: "·",
	running: "…",
	completed: "✓",
	failed: "✗",
	stopped: "◼",
};

export const STATUS_COLOR: Record<SubagentStatus, ThemeColor> = {
	queued: "muted",
	running: "muted",
	completed: "success",
	failed: "error",
	stopped: "warning",
};
