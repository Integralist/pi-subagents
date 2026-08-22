import { describe, expect, it } from "vitest";
import { assignHandle, MAIN_HANDLE, parseMention } from "../src/mention.ts";

/** A session where `taken` handles are already out there. */
function handle(name: string, ...taken: string[]): string {
	const inUse = new Set(taken);
	return assignHandle(name, (candidate) => inUse.has(candidate));
}

describe("assignHandle", () => {
	it("hands the first of a type the bare name", () => {
		expect(handle("explore")).toBe("explore");
	});

	/** "explore" and "explore-2" reads the way people count. */
	it("numbers the next of the same type from two", () => {
		expect(handle("explore", "explore")).toBe("explore-2");
		expect(handle("explore", "explore", "explore-2")).toBe("explore-3");
	});

	it("lowercases a name so the handle is what the list shows", () => {
		expect(handle("Explore")).toBe("explore");
	});

	/**
	 * A handle with a space in it could never be addressed: the space is what
	 * separates a mention from its message.
	 */
	it("makes a multi-word name addressable", () => {
		expect(handle("Code Reviewer")).toBe("code-reviewer");
	});

	it("drops punctuation rather than leaving it to be escaped", () => {
		expect(handle("docs/writer (v2)")).toBe("docs-writer-v2");
	});

	it("leaves no leading or trailing dash", () => {
		expect(handle("--explore--")).toBe("explore");
	});

	/** Still addressable, which a handle of "" would not be. */
	it("falls back to a usable handle when a name has nothing in it", () => {
		expect(handle("!!!")).toBe("agent");
	});

	/**
	 * `@main` is how someone escapes routing, so no subagent may be reachable
	 * under it — an agent really called "main" starts at `main-2`.
	 */
	it("never hands out the reserved handle", () => {
		expect(handle(MAIN_HANDLE)).toBe("main-2");
	});

	it("keeps a handle that only collides after slugging distinct", () => {
		expect(handle("Code Reviewer", "code-reviewer")).toBe("code-reviewer-2");
	});
});

/** Every handle these tests know about. */
const KNOWN = new Set(["explore", "explore-2", "code-reviewer"]);
const known = (handle: string) => KNOWN.has(handle);

function parse(text: string) {
	return parseMention(text, known);
}

describe("parseMention", () => {
	// The specification's scenario, quoted.
	it("Routes by the subagent's state", () => {
		expect(parse("@explore look at the auth path")).toEqual({
			kind: "route",
			handle: "explore",
			message: "look at the auth path",
		});
	});

	it("routes to a numbered handle", () => {
		expect(parse("@explore-2 and you look at the tests")).toMatchObject({
			kind: "route",
			handle: "explore-2",
		});
	});

	it("takes the handle as typed however it is capitalised", () => {
		expect(parse("@Explore look at the auth path")).toMatchObject({
			kind: "route",
			handle: "explore",
		});
	});

	/** A stray space before the mention does not change what was meant. */
	it("routes a mention with a space in front of it", () => {
		expect(parse(" @explore look at the auth path")).toMatchObject({
			kind: "route",
			handle: "explore",
			message: "look at the auth path",
		});
	});

	/** A pasted message runs onto the next line and still means the same thing. */
	it("routes a message that starts on the next line", () => {
		expect(parse("@explore\nlook at the auth path")).toMatchObject({
			kind: "route",
			message: "look at the auth path",
		});
	});

	/**
	 * Delivered as written. A message whose indentation was the point must not
	 * be quietly reformatted on the way.
	 */
	it("keeps the message as it was typed", () => {
		expect(parse("@explore   two  spaces  inside ")).toMatchObject({
			message: "two  spaces  inside ",
		});
	});

	// The specification's scenario, quoted.
	it("Treats a bare handle as ordinary text", () => {
		expect(parse("@explore")).toEqual({
			kind: "passthrough",
			text: "@explore",
		});
	});

	// The specification's scenario, quoted.
	it("Ignores a mention that is not leading", () => {
		expect(parse("ask @explore about this")).toEqual({
			kind: "passthrough",
			text: "ask @explore about this",
		});
	});

	// The specification's scenario, quoted.
	it("Escapes routing with @main", () => {
		expect(parse("@main @explore is just text")).toEqual({
			kind: "passthrough",
			text: "@explore is just text",
		});
	});

	/**
	 * Still just a handle. The pattern requires whitespace after the handle, so
	 * this is the one shape where the emptiness check is what refuses it rather
	 * than the pattern itself.
	 */
	it("treats a handle followed by nothing but spaces as ordinary text", () => {
		expect(parse("@explore   ")).toEqual({
			kind: "passthrough",
			text: "@explore   ",
		});
	});

	/** Nothing follows it, so there is nothing to escape and nothing to strip. */
	it("leaves a bare @main alone", () => {
		expect(parse("@main")).toEqual({ kind: "passthrough", text: "@main" });
	});

	// The specification's scenario, quoted.
	it("Leaves an unknown handle alone", () => {
		expect(parse("@nosuch hello")).toEqual({
			kind: "passthrough",
			text: "@nosuch hello",
		});
	});

	/**
	 * The reason unknown handles pass through rather than being refused: an
	 * email address at the start of a line is not a mention.
	 */
	it("leaves ordinary text that opens with an at-sign alone", () => {
		expect(parse("@someone@example.com is the contact")).toMatchObject({
			kind: "passthrough",
		});
	});

	it("leaves text with no mention in it alone", () => {
		expect(parse("what is in src/queue.ts?")).toEqual({
			kind: "passthrough",
			text: "what is in src/queue.ts?",
		});
	});

	it("leaves an empty prompt alone", () => {
		expect(parse("")).toEqual({ kind: "passthrough", text: "" });
	});
});
