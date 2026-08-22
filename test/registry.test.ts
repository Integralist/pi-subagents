import { describe, expect, it, vi } from "vitest";
import {
	type SubagentRecord,
	SubagentRegistry,
	type SubagentStatus,
} from "../src/registry.ts";

/**
 * A record with everything filled in, so each test overrides only the field it
 * is about.
 */
function record(
	id: string,
	overrides: Partial<SubagentRecord> = {},
): SubagentRecord {
	return {
		id,
		handle: id,
		type: "explore",
		description: "look around",
		status: "running",
		color: "cyan",
		startedAt: 1_000,
		contextPercent: null,
		turns: 0,
		...overrides,
	};
}

describe("SubagentRegistry", () => {
	describe("lookup", () => {
		it("finds a record by its id", () => {
			const registry = new SubagentRegistry();
			const added = record("abc123", { handle: "explore" });
			registry.add(added);

			expect(registry.get("abc123")).toBe(added);
		});

		it("finds a record by its handle", () => {
			const registry = new SubagentRegistry();
			const added = record("abc123", { handle: "explore-2" });
			registry.add(added);

			expect(registry.get("explore-2")).toBe(added);
		});

		it("returns nothing for a name it has never seen", () => {
			const registry = new SubagentRegistry();
			registry.add(record("abc123", { handle: "explore" }));

			expect(registry.get("reviewer")).toBeUndefined();
		});

		it("replaces a record added twice under one id", () => {
			const registry = new SubagentRegistry();
			registry.add(record("abc123", { description: "first" }));
			registry.add(record("abc123", { description: "second" }));

			expect(registry.list()).toHaveLength(1);
			expect(registry.get("abc123")?.description).toBe("second");
		});
	});

	describe("listing", () => {
		it("lists in launch order however they were added", () => {
			const registry = new SubagentRegistry();
			registry.add(record("second", { startedAt: 2_000 }));
			registry.add(record("first", { startedAt: 1_000 }));
			registry.add(record("third", { startedAt: 3_000 }));

			expect(registry.list().map((r) => r.id)).toEqual([
				"first",
				"second",
				"third",
			]);
		});

		it("keeps two subagents launched in the same millisecond in add order", () => {
			const registry = new SubagentRegistry();
			registry.add(record("earlier", { startedAt: 1_000 }));
			registry.add(record("later", { startedAt: 1_000 }));

			expect(registry.list().map((r) => r.id)).toEqual(["earlier", "later"]);
		});

		it("counts only subagents actually running, not queued ones", () => {
			const registry = new SubagentRegistry();
			const statuses: SubagentStatus[] = [
				"queued",
				"running",
				"completed",
				"failed",
				"stopped",
			];
			for (const status of statuses) {
				registry.add(record(status, { status }));
			}

			expect(registry.running().map((r) => r.id)).toEqual(["running"]);
		});
	});

	describe("update", () => {
		it("applies only the fields it is given", () => {
			const registry = new SubagentRegistry();
			registry.add(record("abc123", { status: "running", turns: 3 }));

			const updated = registry.update("abc123", { status: "completed" });

			expect(updated?.status).toBe("completed");
			expect(updated?.turns).toBe(3);
			expect(registry.get("abc123")?.status).toBe("completed");
		});

		it("updates a record found by its handle", () => {
			const registry = new SubagentRegistry();
			registry.add(record("abc123", { handle: "explore" }));

			registry.update("explore", { contextPercent: 42 });

			expect(registry.get("abc123")?.contextPercent).toBe(42);
		});

		it("returns nothing for a subagent it does not have", () => {
			const registry = new SubagentRegistry();

			expect(registry.update("ghost", { turns: 1 })).toBeUndefined();
		});
	});

	describe("onChange", () => {
		it("fires when a subagent is added", () => {
			const registry = new SubagentRegistry();
			const listener = vi.fn();
			registry.onChange(listener);

			registry.add(record("abc123"));

			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("fires when a record changes", () => {
			const registry = new SubagentRegistry();
			registry.add(record("abc123"));
			const listener = vi.fn();
			registry.onChange(listener);

			registry.update("abc123", { turns: 1 });

			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("stays quiet when the update matched nothing", () => {
			const registry = new SubagentRegistry();
			const listener = vi.fn();
			registry.onChange(listener);

			registry.update("ghost", { turns: 1 });

			expect(listener).not.toHaveBeenCalled();
		});

		it("stops calling a listener once it unsubscribes", () => {
			const registry = new SubagentRegistry();
			const listener = vi.fn();
			const unsubscribe = registry.onChange(listener);

			registry.add(record("first"));
			unsubscribe();
			registry.add(record("second"));

			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("keeps going when one listener throws", () => {
			const registry = new SubagentRegistry();
			const after = vi.fn();
			registry.onChange(() => {
				throw new Error("bad subscriber");
			});
			registry.onChange(after);

			expect(() => registry.add(record("abc123"))).not.toThrow();
			expect(after).toHaveBeenCalledTimes(1);
		});

		it("lets a listener unsubscribe from inside its own callback", () => {
			const registry = new SubagentRegistry();
			const listener = vi.fn(() => unsubscribe());
			const unsubscribe = registry.onChange(listener);

			registry.add(record("first"));
			registry.add(record("second"));

			expect(listener).toHaveBeenCalledTimes(1);
		});
	});
});
