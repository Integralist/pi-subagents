/**
 * Turning a model name a caller typed into a model pi can run.
 *
 * Callers name models loosely — "flash", "opus", "gpt-4" — so resolution tries
 * progressively looser matches. It never guesses: a query matching several
 * models is refused with those candidates listed, because silently picking one
 * of four would run the subagent on a model nobody chose.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
	return model.provider ? `${model.provider}/${model.id}` : model.id;
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

/** A subagent can run only physical models; virtual entries need their router. */
export function isPhysicalModel(model: Model<Api>): boolean {
	return model.api !== "pi-virtual";
}

export interface PhysicalSettings {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

/** Plain accepted settings, not a subscription to the main model's routing. */
export interface ResolvedSubagentSettings extends PhysicalSettings {
	explicitModel: boolean;
	fallback?: PhysicalSettings;
}

const PHYSICAL_MODEL_REQUIRED =
	"The main model's physical target is unknown. Choose an explicit physical model for this subagent.";

/** Selection wins for physical models; virtual effort is never physical evidence. */
function physicalMainSettings(
	ctx: ExtensionContext,
): PhysicalSettings | undefined {
	if (!ctx.model) return undefined;
	if (isPhysicalModel(ctx.model)) {
		return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
	}

	// Both methods are public on the native host. Structural guards also keep
	// physical-only hosts usable without assuming any native virtual-state API.
	if (
		typeof ctx.sessionManager?.getBranch !== "function" ||
		typeof ctx.modelRegistry?.find !== "function"
	)
		return undefined;
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message.role !== "assistant")
			continue;
		const message = entry.message;
		if (!["stop", "length", "toolUse"].includes(message.stopReason)) continue;
		if (message.api === "pi-virtual") continue;
		const model = ctx.modelRegistry.find(message.provider, message.model);
		if (!model || !isPhysicalModel(model)) return undefined;
		const effort = (message as { thinkingLevel?: unknown }).thinkingLevel;
		const thinkingLevel =
			typeof effort === "string" &&
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
				effort,
			)
				? (effort as ThinkingLevel)
				: undefined;
		return { model, thinkingLevel };
	}
	return undefined;
}

/** Resolve overrides independently and retain the strict explicit-model gate. */
export function resolveSubagentSettings(
	ctx: ExtensionContext,
	model?: Model<Api>,
	thinkingLevel?: ThinkingLevel,
	allowModelFallback = true,
): ResolvedSubagentSettings {
	if (!allowModelFallback && !model) {
		throw new Error(
			"An explicit model is required when model fallback is disabled.",
		);
	}
	if (model && !isPhysicalModel(model)) {
		throw new Error(
			"Subagents require an explicit physical model, not a virtual model.",
		);
	}
	const parent = physicalMainSettings(ctx);
	const physical = model ?? parent?.model;
	if (!physical) throw new Error(PHYSICAL_MODEL_REQUIRED);
	return {
		model: physical,
		thinkingLevel: thinkingLevel ?? parent?.thinkingLevel,
		explicitModel: model !== undefined,
		fallback: parent
			? {
					model: parent.model,
					thinkingLevel: thinkingLevel ?? parent.thinkingLevel,
				}
			: undefined,
	};
}
