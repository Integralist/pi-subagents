/**
 * Turning a model name a caller typed into a model pi can run.
 *
 * Callers name models loosely — "flash", "opus", "gpt-4" — so resolution tries
 * progressively looser matches. It never guesses: a query matching several
 * models is refused with those candidates listed, because silently picking one
 * of four would run the subagent on a model nobody chose.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

export type ResolveModelResult =
	| { ok: true; model: Model<Api> }
	| {
			ok: false;
			/**
			 * `unknown` — nothing matched, and `available` lists every configured
			 * model. `ambiguous` — several matched, and `available` lists just
			 * those. The two need different messages, so they are distinguished
			 * here rather than left for the caller to guess.
			 */
			reason: "unknown" | "ambiguous";
			available: string[];
	  };

/** How a model is named back to the caller: unambiguous, and copy-pasteable. */
export function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The match tiers, tightest first. Each is tried in turn; the first tier with
 * any match decides the outcome, whether that is a single model or a refusal.
 *
 * Deliberately terminal: an ambiguous id substring is not retried against
 * display names. Falling through would let a broader query succeed where a
 * narrower one failed, which is harder to predict than simply refusing.
 */
const TIERS: ReadonlyArray<(model: Model<Api>, query: string) => boolean> = [
	(model, query) => modelLabel(model).toLowerCase() === query,
	(model, query) => model.id.toLowerCase() === query,
	(model, query) => model.id.toLowerCase().includes(query),
	(model, query) => model.name.toLowerCase().includes(query),
];

/**
 * Resolve against an explicit list rather than a registry, so the caller
 * decides which models are even candidates — the scoped set a user configured,
 * say, rather than every model in the catalogue.
 */
export function resolveModel(
	models: readonly Model<Api>[],
	query: string,
): ResolveModelResult {
	const needle = query.trim().toLowerCase();

	if (needle !== "") {
		for (const matches of TIERS) {
			const hits = models.filter((model) => matches(model, needle));
			if (hits.length === 1 && hits[0]) {
				return { ok: true, model: hits[0] };
			}
			if (hits.length > 1) {
				return {
					ok: false,
					reason: "ambiguous",
					available: hits.map(modelLabel),
				};
			}
		}
	}

	return { ok: false, reason: "unknown", available: models.map(modelLabel) };
}
