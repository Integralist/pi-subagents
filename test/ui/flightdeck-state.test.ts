import { describe, expect, it } from "vitest";
import {
	appendLog,
	completeTurn,
	createFlightdeckState,
	describeToolCall,
	fmtClock,
	fmtDuration,
	fmtTimer,
	fmtUsd,
	gauge,
	kTokens,
	lanes,
	plural,
	prettyModel,
	recordToolCall,
	resetFlightdeckState,
	shorten,
	startTurn,
	titleLines,
} from "../../src/ui/flightdeck-state.ts";

describe("flightdeck-state", () => {
	it("formats models, tokens, timers, durations, clocks, and gauges", () => {
		expect(prettyModel("anthropic/claude-opus-4-6")).toBe("Opus 4.6");
		expect(prettyModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"Sonnet 4.5",
		);
		expect(prettyModel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
		expect(prettyModel("claude-3-haiku-20240307")).toBe("Haiku 3");
		expect(prettyModel("gpt-4o")).toBe("gpt-4o");
		expect(prettyModel("meta-llama/llama-3.1-405b-instruct-fp8")).toBe(
			"llama-3.1-405b-instru…",
		);
		expect(prettyModel("")).toBe("");

		expect(kTokens(500)).toBe("500");
		expect(kTokens(667_400)).toBe("667k");
		expect(kTokens(1_000_000)).toBe("1.0M");
		expect(kTokens(1_500_000)).toBe("1.5M");

		expect(fmtDuration(0)).toBe("0s");
		expect(fmtDuration(7_200)).toBe("7s");
		expect(fmtDuration(60_000)).toBe("1m");
		expect(fmtDuration(75_000)).toBe("1m15s");
		expect(fmtDuration(3_665_000)).toBe("1h1m");

		expect(fmtTimer(0)).toBe("0:00");
		expect(fmtTimer(15_900)).toBe("0:15");
		expect(fmtTimer(75_000)).toBe("1:15");
		expect(fmtTimer(3_665_000)).toBe("1:01:05");

		expect(fmtUsd(0)).toBe("$0.00");
		expect(fmtUsd(0.154)).toBe("$0.15");
		expect(fmtUsd(104.2)).toBe("$104");

		expect(gauge(0, 10)).toEqual({ on: "", off: "□□□□□□□□□□" });
		expect(gauge(67, 10)).toEqual({ on: "■■■■■■■", off: "□□□" });
		expect(gauge(100, 10)).toEqual({ on: "■■■■■■■■■■", off: "" });

		expect(titleLines("Review README and docs for drift", 14, 16)).toEqual([
			"Review README",
			"and docs for…",
		]);
		expect(titleLines("Short title", 14, 16)).toEqual(["Short title", ""]);
		expect(titleLines("Supercalifragilisticexpialidocious", 10, 10)).toEqual([
			"Supercalif",
			"ragilisti…",
		]);

		expect(fmtClock(0)).toBe("--:--:--");
		expect(fmtClock(-1)).toBe("--:--:--");
		expect(fmtClock(new Date(2026, 9, 24, 14, 30, 45).getTime())).toMatch(
			/\d{2}:\d{2}:\d{2}/,
		);

		expect(plural(0, "edit")).toBe("0 edits");
		expect(plural(1, "edit")).toBe("1 edit");
		expect(plural(2, "edit")).toBe("2 edits");

		expect(shorten("short", 10)).toBe("short");
		expect(shorten("hello world", 8)).toBe("hello…");
		expect(shorten("unbreakableword", 8)).toBe("unbreak…");
		expect(shorten("abc", 0)).toBe("");
		expect(shorten("abc", 1)).toBe("…");
	});

	it("computes proportional swimlane bars across a shared time axis", () => {
		const geo = lanes(
			[
				{ id: "a", startedAt: 1_000, finishedAt: 6_000 },
				{ id: "b", startedAt: 6_000, finishedAt: 11_000 },
			],
			11_000,
			20,
		);

		expect(geo[0]).toEqual({ id: "a", before: 0, bar: 10, after: 10 });
		expect(geo[1]).toEqual({ id: "b", before: 10, bar: 10, after: 0 });

		// Running task without finishedAt uses now
		const runningGeo = lanes([{ id: "r", startedAt: 1_000 }], 5_000, 20);
		expect(runningGeo[0]).toEqual({ id: "r", before: 0, bar: 20, after: 0 });

		// Empty items
		expect(lanes([], 5_000, 20)).toEqual([]);

		// Zero width
		expect(lanes([{ id: "a", startedAt: 1_000 }], 5_000, 0)).toEqual([
			{ id: "a", before: 0, bar: 0, after: 0 },
		]);
	});

	it("describes tool calls with path truncation, arg extraction, and secret redaction", () => {
		expect(describeToolCall("edit", { path: "src/ui/flightdeck.ts" })).toBe(
			"edit → ui/flightdeck.ts",
		);
		expect(describeToolCall("read", { file_path: "/a/b/c/d.ts" })).toBe(
			"read → c/d.ts",
		);
		expect(describeToolCall("bash", { command: "npm test" })).toBe(
			"bash → npm test",
		);
		expect(describeToolCall("grep", { pattern: "lanes" })).toBe("grep → lanes");
		expect(
			describeToolCall("bash", {
				command:
					"curl -H 'Authorization: Bearer mysecrettoken123' https://api.com",
			}),
		).toBe("bash → curl -H 'Authorization: Bearer ***' https://api.com");
		expect(
			describeToolCall("bash", {
				command: "echo sk-abcdefghijklmnopqrstuvwx",
			}),
		).toBe("bash → echo sk-***");
		expect(
			describeToolCall("bash", {
				command: "export OPENAI_API_KEY=secret-token-here",
			}),
		).toBe("bash → export OPENAI_API_KEY=***");
		expect(describeToolCall("custom", null)).toBe("custom");
		expect(describeToolCall("custom", {})).toBe("custom");
	});

	it("tracks turns, tool edits/errors, receipts, logs, and reset boundaries", () => {
		let state = createFlightdeckState();
		state = { ...state, costUsd: 1.0, compactions: 2 };
		state = startTurn(state, 10_000);
		state = recordToolCall(state, { isEdit: true, isError: false });
		state = recordToolCall(state, { isEdit: false, isError: true });
		state = { ...state, costUsd: 1.15 };
		state = completeTurn(state, {
			endedAt: 17_000,
			agentsSpawned: 2,
			reason: "answer",
		});
		state = appendLog(state, {
			at: 17_000,
			who: "main",
			text: describeToolCall("edit", { path: "src/index.ts" }),
			kind: "info",
			agentId: null,
		});

		expect(state.steps).toBe(1);
		expect(state.receipt).toEqual({
			durationMs: 7_000,
			agents: 2,
			edits: 1,
			errors: 1,
			costDelta: 0.15,
			reason: "answer",
		});
		expect(state.log).toHaveLength(1);
		expect(state.log[0]?.text).toBe("edit → src/index.ts");

		const reset = resetFlightdeckState(state, 20_000);
		expect(reset.receipt).toBeNull();
		expect(reset.log).toEqual([]);
		expect(reset.resetAfterAt).toBe(20_000);
		expect(reset.costUsd).toBe(1.15);
		expect(reset.compactions).toBe(2);
	});

	it("caps session log at 60 entries", () => {
		let state = createFlightdeckState();
		for (let i = 0; i < 75; i++) {
			state = appendLog(state, {
				at: i * 1_000,
				who: "main",
				text: `step ${i}`,
				kind: "info",
				agentId: null,
			});
		}
		expect(state.log).toHaveLength(60);
		expect(state.log[0]?.text).toBe("step 15");
		expect(state.log[59]?.text).toBe("step 74");
	});
});
