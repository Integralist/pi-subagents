import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveModel } from "../src/model-resolver.ts";

/** Only the three fields resolution reads, cast into place. */
function model(provider: string, id: string, name = id): Model<Api> {
	return { provider, id, name } as unknown as Model<Api>;
}

function registryOf(...models: Model<Api>[]): ModelRegistry {
	return { getAll: () => models } as unknown as ModelRegistry;
}

const GEMINI_FLASH = model("google", "gemini-2.5-flash", "Gemini 2.5 Flash");
const CLAUDE_OPUS = model("anthropic", "claude-opus-4-5", "Claude Opus 4.5");

describe("resolveModel", () => {
	it("matches an exact provider/id", () => {
		const result = resolveModel(
			registryOf(GEMINI_FLASH, CLAUDE_OPUS),
			"google/gemini-2.5-flash",
		);

		expect(result).toEqual({ ok: true, model: GEMINI_FLASH });
	});

	it("matches an exact id without its provider", () => {
		const result = resolveModel(
			registryOf(GEMINI_FLASH, CLAUDE_OPUS),
			"claude-opus-4-5",
		);

		expect(result).toEqual({ ok: true, model: CLAUDE_OPUS });
	});

	// The specification's scenario, quoted.
	it("Resolves a partial model name", () => {
		const result = resolveModel(registryOf(GEMINI_FLASH, CLAUDE_OPUS), "flash");

		expect(result).toEqual({ ok: true, model: GEMINI_FLASH });
	});

	// The specification's scenario, quoted.
	it("Refuses an unknown model name", () => {
		const result = resolveModel(registryOf(GEMINI_FLASH, CLAUDE_OPUS), "nope");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("unknown");
		// The message the caller builds must list the configured models.
		expect(result.available).toEqual([
			"google/gemini-2.5-flash",
			"anthropic/claude-opus-4-5",
		]);
	});

	it("matches a unique substring of the display name", () => {
		// "Opus 4.5" appears in the display name but not in the id, which is
		// dash-separated.
		const result = resolveModel(
			registryOf(GEMINI_FLASH, CLAUDE_OPUS),
			"Opus 4.5",
		);

		expect(result).toEqual({ ok: true, model: CLAUDE_OPUS });
	});

	it("ignores case throughout", () => {
		const result = resolveModel(registryOf(GEMINI_FLASH, CLAUDE_OPUS), "FLASH");

		expect(result).toEqual({ ok: true, model: GEMINI_FLASH });
	});

	it("ignores surrounding whitespace", () => {
		const result = resolveModel(
			registryOf(GEMINI_FLASH, CLAUDE_OPUS),
			"  flash  ",
		);

		expect(result).toEqual({ ok: true, model: GEMINI_FLASH });
	});

	it("refuses an empty query rather than picking something", () => {
		const result = resolveModel(registryOf(GEMINI_FLASH, CLAUDE_OPUS), "   ");

		expect(result.ok).toBe(false);
	});

	it("refuses an empty registry", () => {
		const result = resolveModel(registryOf(), "flash");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.available).toEqual([]);
	});
});

describe("resolveModel ambiguity", () => {
	it("refuses an ambiguous substring rather than picking arbitrarily", () => {
		const four = [
			model("openai", "gpt-4"),
			model("openai", "gpt-4-turbo"),
			model("openai", "gpt-4o"),
			model("openai", "gpt-5"),
		];

		const result = resolveModel(registryOf(...four), "gpt");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("ambiguous");
		// Lists only the candidates that matched, not the whole registry.
		expect(result.available).toHaveLength(4);
	});

	it("lists only the matching candidates when ambiguous", () => {
		const result = resolveModel(
			registryOf(
				model("openai", "gpt-4"),
				model("openai", "gpt-4-turbo"),
				GEMINI_FLASH,
			),
			"gpt",
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.available).toEqual(["openai/gpt-4", "openai/gpt-4-turbo"]);
	});

	it("prefers an exact id over a longer model that merely contains it", () => {
		const result = resolveModel(
			registryOf(model("openai", "gpt-4"), model("openai", "gpt-4-turbo")),
			"gpt-4",
		);

		expect(result).toEqual({ ok: true, model: model("openai", "gpt-4") });
	});

	it("refuses a bare id that two providers both offer", () => {
		const result = resolveModel(
			registryOf(model("openai", "gpt-4"), model("azure", "gpt-4")),
			"gpt-4",
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("ambiguous");
		expect(result.available).toEqual(["openai/gpt-4", "azure/gpt-4"]);
	});

	it("resolves that same id once the provider is named", () => {
		const azure = model("azure", "gpt-4");
		const result = resolveModel(
			registryOf(model("openai", "gpt-4"), azure),
			"azure/gpt-4",
		);

		expect(result).toEqual({ ok: true, model: azure });
	});

	it("does not fall through to display names when the id match was ambiguous", () => {
		// "turbo" is ambiguous across ids but would be unique in the display
		// names. Falling through would make a broader query succeed where a
		// narrower one failed, which is harder to predict than refusing.
		const result = resolveModel(
			registryOf(
				model("openai", "gpt-4-turbo", "GPT-4 Turbo"),
				model("openai", "gpt-3-turbo", "Legacy Three"),
			),
			"turbo",
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("ambiguous");
	});
});
