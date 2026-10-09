import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	CreateAgentSessionResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createInlineSpawnTool } from "../src/index.ts";
import { SubagentQueue } from "../src/queue.ts";
import { SubagentRegistry } from "../src/registry.ts";
import { runSubagent } from "../src/runner.ts";
import type { SendMessage } from "../src/spawn.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// Exercise the public tool through the real queue, registry and runner. Only
// the provider session is simulated; filesystem side effects are real.
describe("inline model fallback integration", () => {
	it.each([false, true, undefined])(
		"applies allow_model_fallback=%s after an edit followed by provider failure",
		async (allowed) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-fallback-integration-"));
			scratch.push(dir);
			const edited = join(dir, "slice.txt");
			const cheap = {
				provider: "test",
				id: "cheap",
				name: "Cheap",
			} as Model<Api>;
			const premium = {
				provider: "test",
				id: "premium",
				name: "Premium",
			} as Model<Api>;
			const ctx = {
				cwd: dir,
				model: premium,
				thinkingLevel: "xhigh",
				scopedModels: [{ model: cheap }],
				sessionManager: { getSessionFile: () => undefined },
			} as unknown as ExtensionContext;
			const attempts: string[] = [];
			const registry = new SubagentRegistry();
			let delivered!: () => void;
			const completion = new Promise<void>((resolve) => {
				delivered = resolve;
			});
			const tool = createInlineSpawnTool({
				discover: () => [],
				getKnownTools: () => ["read", "write"],
				registry,
				queue: new SubagentQueue(1),
				sendMessage: (() => delivered()) as SendMessage,
				run: (opts) =>
					runSubagent({
						...opts,
						sessionDir: dir,
						createSession: async (options) => {
							const model = options.model;
							if (!model) throw new Error("session started without a model");
							attempts.push(model.id);
							return {
								session: {
									messages: [
										{
											role: "assistant",
											stopReason: "stop",
											content: [{ type: "text", text: "done" }],
										},
									],
									subscribe: () => () => {},
									prompt: async () => {
										if (model === cheap) {
											writeFileSync(edited, "cheap model edit");
											throw new Error("provider disconnected after editing");
										}
									},
									abort: async () => {},
									dispose: () => {},
								},
							} as unknown as CreateAgentSessionResult;
						},
					}),
			});

			await tool.execute(
				"call",
				{
					name: "slice",
					system_prompt: "Implement only the assigned slice.",
					prompt: "implement slice one",
					description: "implement slice one",
					model: "test/cheap",
					thinking: "xhigh",
					allow_model_fallback: allowed,
				},
				undefined,
				undefined,
				ctx,
			);
			await completion;

			const record = registry.list()[0];
			expect(readFileSync(edited, "utf8")).toBe("cheap model edit");
			expect(attempts).toEqual(
				allowed === false ? ["cheap"] : ["cheap", "premium"],
			);
			expect(record?.status).toBe(allowed === false ? "failed" : "completed");
			if (allowed === false) {
				expect(record?.outcome?.error).toContain("provider disconnected");
			} else {
				expect(record?.outcome?.output).toContain("Fell back to test/premium");
			}
		},
	);
});
