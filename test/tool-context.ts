import type {
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** The host's actual execute context, on both tested SDK versions. */
export type ToolContext = Parameters<ToolDefinition["execute"]>[4];

export function toolContext(ctx: ExtensionContext): ToolContext {
	const context = {
		...ctx,
		tools: [],
		executeTool: async () => {
			throw new Error("Nested tools are not enabled in this fixture.");
		},
	};
	return context;
}
