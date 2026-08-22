/**
 * The name a subagent answers to, and how a message reaches it.
 *
 * Two halves of one idea. A subagent is given a handle when it starts —
 * `explore`, then `explore-2` for the next of that type — and the user reaches
 * it by typing that handle after an `@` at the main prompt. Handing out handles
 * and reading them back have to agree on what a handle may look like, so they
 * live together.
 *
 * Nothing here touches a registry or a session: `assignHandle` is told what is
 * taken and `parseMention` is told what is known. That keeps both pure, which
 * matters because the specification pins their behaviour case by case.
 */

/**
 * The handle that means "not a subagent at all".
 *
 * Reserved rather than merely unused: `@main hello` is how someone sends the
 * main model text that happens to start with a mention, so no subagent may ever
 * be reachable under that name.
 */
export const MAIN_HANDLE = "main";

/** What a name with nothing usable in it becomes, so it is still addressable. */
const FALLBACK_HANDLE = "agent";

/**
 * A handle a person can type: lowercase, no spaces, no punctuation to escape.
 *
 * An agent's `name:` is free text — "Code Reviewer" is a perfectly good one —
 * and a handle with a space in it could never be addressed, because the space
 * is what separates a mention from its message.
 */
function toHandle(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? FALLBACK_HANDLE : slug;
}

/**
 * A handle for a new subagent of this type, distinct from every handle already
 * out there.
 *
 * The first of a type gets the bare name and the next gets `-2`, which reads
 * the way people count: "explore" and "explore-2", not "explore-1". A handle
 * has to be unique for the whole session, because a message addressed to
 * `@explore` must have exactly one place to go.
 */
export function assignHandle(
	name: string,
	isTaken: (handle: string) => boolean,
): string {
	const base = toHandle(name);
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? base : `${base}-${n}`;
		// `main` is never handed out, so an agent actually called "main" starts
		// at `main-2` rather than at a handle nothing could ever reach.
		if (candidate !== MAIN_HANDLE && !isTaken(candidate)) {
			return candidate;
		}
	}
}

export type Mention =
	/** Send `message` to the subagent called `handle`. */
	| { kind: "route"; handle: string; message: string }
	/** Not for a subagent. `text` is what the main model should be given. */
	| { kind: "passthrough"; text: string };

/**
 * A leading `@handle` and everything after it.
 *
 * `\S+` rather than the handle's own shape, because what counts as a handle is
 * settled by asking, not by matching — a stricter pattern here would only be a
 * second, quietly diverging definition of the same thing. Any whitespace
 * separates, newline included, so a pasted multi-line message routes.
 *
 * Whether there is a message at all is left to the caller below rather than
 * required here. Both spellings work, and having one rule in one place is worth
 * more than a pattern that reads as if it enforced everything.
 */
const MENTION = /^@(\S+)\s*([\s\S]*)$/;

/**
 * Decide where submitted text is going.
 *
 * Deliberately narrow. Only a leading mention routes — `ask @explore about
 * this` is a sentence about a subagent, not a message to one — and a bare
 * handle with nothing after it is left alone, because a handle on its own is
 * not a message and the main model may well have been the intended reader.
 */
export function parseMention(
	text: string,
	known: (handle: string) => boolean,
): Mention {
	// A stray space before the mention does not change what was meant.
	const match = MENTION.exec(text.trimStart());
	// A handle with nothing after it is not a message to anyone: `@explore` on
	// its own is a word the main model was probably meant to read.
	if (!match?.[1] || !match[2]) {
		return { kind: "passthrough", text };
	}

	// Lowercased, because handles are: someone who types `@Explore` means the
	// subagent they can see in the list.
	const handle = match[1].toLowerCase();
	const message = match[2];

	// The escape. What follows is passed on as written and not looked at again,
	// so `@main @explore is just text` reaches the main model intact.
	if (handle === MAIN_HANDLE) {
		return { kind: "passthrough", text: message };
	}

	// An unknown handle is almost certainly an ordinary sentence — an email
	// address, a GitHub username — so the text goes on untouched rather than
	// being refused.
	return known(handle)
		? { kind: "route", handle, message }
		: { kind: "passthrough", text };
}
