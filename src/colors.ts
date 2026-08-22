/**
 * Giving each subagent a colour.
 *
 * The colour is how a reader tells one subagent from another at a glance —
 * in the list, and against the line of output a subagent produced. It is
 * therefore assigned once and never changes: a subagent that shifted from
 * green to blue partway through a session would be a different subagent as
 * far as anyone reading the screen is concerned.
 */

/**
 * The colours handed out in order, in the absence of a stated preference.
 *
 * Six terminal colour names, chosen to stay distinguishable from each other
 * rather than to be pretty. Names rather than escape codes: the record carries a
 * name and `colorize` turns it into one, which keeps escape codes out of the
 * registry and out of every test that reads a record.
 */
export const PALETTE = [
	"cyan",
	"green",
	"yellow",
	"magenta",
	"blue",
	"red",
] as const;

/**
 * The colour for the subagent launched at `index`.
 *
 * A `color:` in the agent's frontmatter wins outright — someone who named a
 * colour meant it. Otherwise the palette is walked in launch order and wraps
 * when it runs out, so the seventh subagent shares the first one's colour. That
 * is a deliberate collision rather than a failure: past six concurrent
 * subagents, colour has stopped being the thing telling them apart.
 *
 * Deterministic in both branches, which is what lets a caller recompute a
 * subagent's colour instead of having to store it.
 */
export function assignColor(index: number, configured?: string): string {
	const named = configured?.trim();
	if (named) {
		return named;
	}

	// An index off the end of the palette — negative, fractional, whatever a
	// caller manages to pass — falls back to the first colour rather than
	// handing back an undefined that a renderer would have to cope with.
	return PALETTE[index % PALETTE.length] ?? PALETTE[0];
}

/**
 * The standard terminal colours, by the names an agent file may use.
 *
 * Foreground codes 30–37 and their bright forms 90–97. Deliberately the
 * terminal's own sixteen rather than any fixed hex: the emulator resolves these
 * against the user's colour scheme, so a subagent's `cyan` is whatever cyan that
 * user has chosen. `theme.fg()` is no help here — it takes pi's *semantic*
 * colour names ("accent", "error", "muted"), not colours.
 */
const ANSI_FOREGROUND: Record<string, number> = {
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	gray: 90,
	grey: 90,
	brightred: 91,
	brightgreen: 92,
	brightyellow: 93,
	brightblue: 94,
	brightmagenta: 95,
	brightcyan: 96,
	brightwhite: 97,
};

/**
 * Wrap `text` in `color`, or hand it back untouched.
 *
 * A name that is not one of the terminal's own renders plain. Falling back to
 * some *other* colour would be worse than none: two subagents could silently end
 * up sharing one, which defeats the only thing the colour is for. An agent file
 * asking for `color: hotpink` therefore gets an uncoloured row — see the plan's
 * note on validating `color:` at discovery instead.
 */
export function colorize(color: string, text: string): string {
	const code = ANSI_FOREGROUND[color.trim().toLowerCase()];
	return code === undefined ? text : `\x1b[${code}m${text}\x1b[39m`;
}
