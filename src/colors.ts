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
 * rather than to be pretty. Names rather than escape codes: the record travels
 * to the list in Slice 8, which is where a name becomes a colour under whatever
 * theme is loaded.
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
