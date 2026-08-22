import { describe, expect, it } from "vitest";
import { assignColor, colorize, PALETTE } from "../src/colors.ts";

describe("assignColor", () => {
	it("takes the first palette entry for the first subagent", () => {
		expect(assignColor(0)).toBe(PALETTE[0]);
	});

	it("walks the palette as subagents are launched", () => {
		const colors = PALETTE.map((_, index) => assignColor(index));

		expect(colors).toEqual([...PALETTE]);
	});

	it("wraps back to the start once the palette runs out", () => {
		expect(assignColor(PALETTE.length)).toBe(PALETTE[0]);
		expect(assignColor(PALETTE.length + 1)).toBe(PALETTE[1]);
	});

	// A subagent keeps its colour for life, so the same index must never
	// produce a different answer.
	it("gives the same answer for the same index every time", () => {
		expect(assignColor(3)).toBe(assignColor(3));
	});

	// The specification's scenario, quoted.
	it("Honours a colour set in the agent file", () => {
		expect(assignColor(0, "magenta")).toBe("magenta");
	});

	it("prefers the configured colour over the palette at any index", () => {
		expect(assignColor(2, "hotpink")).toBe("hotpink");
	});

	it("ignores a colour that is blank rather than absent", () => {
		expect(assignColor(1, "   ")).toBe(PALETTE[1]);
	});

	it("trims a configured colour", () => {
		expect(assignColor(0, "  cyan  ")).toBe("cyan");
	});

	// Not reachable from a launch index, but indexing off the end must not
	// hand back undefined to something that expects a colour.
	it("falls back to the first colour for an index that makes no sense", () => {
		expect(assignColor(-1)).toBe(PALETTE[0]);
	});
});

describe("colorize", () => {
	it("wraps the text in the named colour and closes it again", () => {
		expect(colorize("cyan", "reviewer")).toBe("\x1b[36mreviewer\x1b[39m");
	});

	// Every palette colour has to render, or the list would show plain rows for
	// subagents that were assigned a colour perfectly correctly.
	it("renders every colour the palette hands out", () => {
		for (const color of PALETTE) {
			expect(colorize(color, "x"), color).not.toBe("x");
		}
	});

	it("gives each palette colour a distinct code", () => {
		const rendered = new Set(PALETTE.map((color) => colorize(color, "x")));

		expect(rendered.size).toBe(PALETTE.length);
	});

	it("closes with a foreground reset rather than a full reset", () => {
		// A full `\x1b[0m` would also clear any bold or background the caller had
		// set around this text.
		expect(colorize("red", "x").endsWith("\x1b[39m")).toBe(true);
	});

	it("takes a colour however it was capitalised or spaced", () => {
		expect(colorize("  CyAn  ", "x")).toBe(colorize("cyan", "x"));
	});

	/**
	 * Falling back to some other colour would be worse than none: two subagents
	 * could silently share one, which is the only thing the colour is for.
	 */
	it("leaves text alone for a colour the terminal does not have", () => {
		for (const unknown of ["hotpink", "#ff00ff", "", "  "]) {
			expect(colorize(unknown, "reviewer"), unknown).toBe("reviewer");
		}
	});
});
