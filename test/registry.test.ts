import type {
	AgentSessionEvent,
	ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type ContextUsageSource,
	type SubagentRecord,
	SubagentRegistry,
	type SubagentStatus,
	trackContextUsage,
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
		config: {
			name: "explore",
			description: "explores the codebase",
			systemPrompt: "You explore.",
			source: "project",
		},
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

/** The one event that matters, shaped as `session.subscribe()` emits it. */
function turnEnd(): AgentSessionEvent {
	return {
		type: "turn_end",
		message: { role: "assistant", content: [] },
		toolResults: [],
	} as unknown as AgentSessionEvent;
}

function turnStart(): AgentSessionEvent {
	return { type: "turn_start" } as unknown as AgentSessionEvent;
}

function usage(percent: number | null): ContextUsage {
	return {
		tokens: percent === null ? null : 1_000,
		contextWindow: 200_000,
		percent,
	};
}

/**
 * A session that only does what tracking asks of it: hand out a subscription
 * and report usage. `emit` stands in for the agent finishing a turn.
 */
function stubSession(readUsage: () => ContextUsage | undefined) {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const unsubscribe = vi.fn();
	const getContextUsage = vi.fn(readUsage);

	const session = {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return unsubscribe;
		},
		getContextUsage,
	} as unknown as ContextUsageSource;

	return {
		session,
		getContextUsage,
		unsubscribe,
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

function registryWith(id: string): SubagentRegistry {
	const registry = new SubagentRegistry();
	registry.add(record(id));
	return registry;
}

describe("trackContextUsage", () => {
	it("stores the percentage each time a turn ends", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => usage(37));
		trackContextUsage(stub.session, registry, "abc123");

		stub.emit(turnEnd());

		expect(registry.get("abc123")?.contextPercent).toBe(37);
	});

	it("ignores every event that is not a turn ending", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => usage(37));
		trackContextUsage(stub.session, registry, "abc123");

		stub.emit(turnStart());

		expect(stub.getContextUsage).not.toHaveBeenCalled();
		expect(registry.get("abc123")?.contextPercent).toBeNull();
	});

	// Null is not zero: the list renders a blank instead of a misleading "0%".
	it("keeps a null percentage null after a compaction", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => usage(null));
		trackContextUsage(stub.session, registry, "abc123");
		registry.update("abc123", { contextPercent: 80 });

		stub.emit(turnEnd());

		expect(registry.get("abc123")?.contextPercent).toBeNull();
	});

	// `getContextUsage()` is typed `ContextUsage | undefined`.
	it("treats no usage at all as unknown rather than zero", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => undefined);
		trackContextUsage(stub.session, registry, "abc123");
		registry.update("abc123", { contextPercent: 80 });

		stub.emit(turnEnd());

		expect(registry.get("abc123")?.contextPercent).toBeNull();
	});

	it("hands back the session's own unsubscribe", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => usage(37));

		const stop = trackContextUsage(stub.session, registry, "abc123");
		stop();

		expect(stub.unsubscribe).toHaveBeenCalledTimes(1);
	});

	// This listener runs inside the child's event dispatch, so a throw here
	// would surface in the host session rather than in the subagent.
	it("swallows a failure to read usage instead of breaking the turn", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => {
			throw new Error("no usage for you");
		});
		trackContextUsage(stub.session, registry, "abc123");

		expect(() => stub.emit(turnEnd())).not.toThrow();
		expect(registry.get("abc123")?.contextPercent).toBeNull();
	});

	it("does nothing when the subagent is no longer registered", () => {
		const registry = new SubagentRegistry();
		const stub = stubSession(() => usage(37));
		trackContextUsage(stub.session, registry, "vanished");

		expect(() => stub.emit(turnEnd())).not.toThrow();
	});

	it("tells the registry's watchers that the record moved", () => {
		const registry = registryWith("abc123");
		const stub = stubSession(() => usage(37));
		trackContextUsage(stub.session, registry, "abc123");
		const listener = vi.fn();
		registry.onChange(listener);

		stub.emit(turnEnd());

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
