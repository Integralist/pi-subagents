export type FlightdeckLayout = "auto" | "compact" | "wide" | "mini";

export interface ToolNote {
	text: string;
	isError: boolean;
}

export interface TurnState {
	startedAt: number;
	edits: number;
	errors: number;
	agentsSpawned: number;
	costAtStart: number;
}

export interface TurnReceipt {
	durationMs: number;
	agents: number;
	edits: number;
	errors: number;
	costDelta: number | null;
	reason: "answer" | "error";
}

export interface LogEntry {
	at: number;
	who: string;
	text: string;
	kind: "info" | "done" | "error";
	agentId: string | null;
}

export interface FlightdeckState {
	model: string;
	effort: string;
	steps: number;
	isRunning: boolean;
	tokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	compactions: number;
	costUsd: number;
	turn: TurnState;
	receipt: TurnReceipt | null;
	log: LogEntry[];
	expandedAgentId: string | null;
	layout: FlightdeckLayout;
	resetAfterAt: number;
}

export function createFlightdeckState(): FlightdeckState {
	return {
		model: "",
		effort: "",
		steps: 0,
		isRunning: false,
		tokens: null,
		contextWindow: 0,
		contextPercent: null,
		compactions: 0,
		costUsd: 0,
		turn: {
			startedAt: 0,
			edits: 0,
			errors: 0,
			agentsSpawned: 0,
			costAtStart: 0,
		},
		receipt: null,
		log: [],
		expandedAgentId: null,
		layout: "auto",
		resetAfterAt: 0,
	};
}

export function shorten(s: string, max: number): string {
	if (s.length <= max) return s;
	if (max <= 0) return "";
	if (max === 1) return "…";
	const space = s.lastIndexOf(" ", max - 1);
	if (space > 0) {
		return `${s.slice(0, space)}…`;
	}
	return `${s.slice(0, max - 1)}…`;
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function prettyModel(id: string): string {
	if (!id) return "";
	let name = id;
	if (name.includes("/")) {
		name = name.split("/").pop() ?? name;
	}
	name = name.replace(/^(?:[a-zA-Z0-9_.-]+\.)?anthropic\./, "");

	// Pattern 1: claude-(opus|sonnet|haiku)-(\d+)-(\d+)
	// e.g. claude-opus-4-6, claude-sonnet-4-5-20250929-v1:0
	const m1 = name.match(/claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
	if (m1?.[1] && m1[2] && m1[3]) {
		const family = capitalize(m1[1]);
		return `${family} ${m1[2]}.${m1[3]}`;
	}

	// Pattern 2: claude-(\d+)-(\d+)-(opus|sonnet|haiku)
	// e.g. claude-3-5-sonnet-20241022, claude-3-7-sonnet
	const m2 = name.match(/claude-(\d+)-(\d+)-(opus|sonnet|haiku)/i);
	if (m2?.[1] && m2[2] && m2[3]) {
		const family = capitalize(m2[3]);
		return `${family} ${m2[1]}.${m2[2]}`;
	}

	// Pattern 3: claude-(\d+)-(opus|sonnet|haiku)
	// e.g. claude-3-haiku-20240307
	const m3 = name.match(/claude-(\d+)-(opus|sonnet|haiku)/i);
	if (m3?.[1] && m3[2]) {
		const family = capitalize(m3[2]);
		return `${family} ${m3[1]}`;
	}

	// Pattern 4: (opus|sonnet|haiku)-(\d+)-(\d+)
	const m4 = name.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
	if (m4?.[1] && m4[2] && m4[3]) {
		const family = capitalize(m4[1]);
		return `${family} ${m4[2]}.${m4[3]}`;
	}

	return shorten(name, 22);
}

export function kTokens(n: number): string {
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${m.toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return `${Math.max(0, Math.round(n))}`;
}

export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const remS = s % 60;
	if (m < 60) {
		return remS > 0 ? `${m}m${remS}s` : `${m}m`;
	}
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return remM > 0 ? `${h}h${remM}m` : `${h}h`;
}

export function fmtTimer(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(totalSeconds / 60);
	const s = totalSeconds % 60;
	const sPad = String(s).padStart(2, "0");
	if (m < 60) {
		return `${m}:${sPad}`;
	}
	const h = Math.floor(m / 60);
	const mRem = m % 60;
	return `${h}:${String(mRem).padStart(2, "0")}:${sPad}`;
}

export function fmtClock(ms: number): string {
	if (!ms || ms <= 0) return "--:--:--";
	const d = new Date(ms);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

export function fmtUsd(n: number): string {
	if (n >= 100) {
		return `$${Math.round(n)}`;
	}
	return `$${n.toFixed(2)}`;
}

export function plural(n: number, word: string): string {
	return `${n} ${n === 1 ? word : `${word}s`}`;
}

export function gauge(pct: number, width: number): { on: string; off: string } {
	const clamped = Math.max(0, Math.min(100, pct));
	const onCount = Math.max(
		0,
		Math.min(width, Math.round((clamped / 100) * width)),
	);
	const offCount = Math.max(0, width - onCount);
	return {
		on: "■".repeat(onCount),
		off: "□".repeat(offCount),
	};
}

export function titleLines(
	title: string,
	first: number,
	rest: number,
): [string, string] {
	const clean = title.trim();
	if (clean.length <= first) {
		return [clean, ""];
	}
	const splitIdx = clean.lastIndexOf(" ", first);
	if (splitIdx > 0) {
		const line1 = clean.slice(0, splitIdx);
		const remainder = clean.slice(splitIdx + 1).trim();
		const line2 = shorten(remainder, rest);
		return [line1, line2];
	}
	const line1 = clean.slice(0, first);
	const remainder = clean.slice(first).trim();
	const line2 = shorten(remainder, rest);
	return [line1, line2];
}

export interface LaneGeometry {
	id: string;
	before: number;
	bar: number;
	after: number;
}

export function lanes(
	items: ReadonlyArray<{ id: string; startedAt: number; finishedAt?: number }>,
	now: number,
	width: number,
): LaneGeometry[] {
	if (items.length === 0 || width <= 0) {
		return items.map((it) => ({ id: it.id, before: 0, bar: 0, after: 0 }));
	}

	let earliest = now;
	for (const item of items) {
		if (item.startedAt < earliest) {
			earliest = item.startedAt;
		}
	}

	const total = Math.max(1, now - earliest);

	return items.map((item) => {
		const start = Math.max(earliest, Math.min(now, item.startedAt));
		const end = Math.max(start, Math.min(now, item.finishedAt ?? now));

		const startFrac = (start - earliest) / total;
		const endFrac = (end - earliest) / total;

		const before = Math.min(width, Math.round(startFrac * width));
		const barEnd = Math.min(
			width,
			Math.max(before, Math.round(endFrac * width)),
		);
		let bar = barEnd - before;
		if (bar === 0 && width > 0) {
			bar = 1;
		}
		let after = width - before - bar;
		if (after < 0) {
			bar = Math.max(1, width - before);
			after = Math.max(0, width - before - bar);
		}

		return {
			id: item.id,
			before,
			bar,
			after,
		};
	});
}

function lastTwoPathSegments(p: string): string {
	const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length <= 2) return parts.join("/");
	return parts.slice(-2).join("/");
}

function redactSecrets(text: string): string {
	return text
		.replace(/(?:Bearer\s+)[a-zA-Z0-9_\-.~+/]+=*/gi, "Bearer ***")
		.replace(/(?:sk-[a-zA-Z0-9_-]{8,})/g, "sk-***")
		.replace(/(?:ghp_[a-zA-Z0-9]{8,})/g, "ghp_***")
		.replace(/(?:xox[baprs]-[a-zA-Z0-9-]+)/g, "xox***")
		.replace(/((?:api[_-]?key|token|secret|password|auth)=)[^&\s]+/gi, "$1***");
}

export function describeToolCall(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") {
		return toolName;
	}

	const record = args as Record<string, unknown>;
	let detail: string | undefined;

	if (typeof record.path === "string" && record.path.trim().length > 0) {
		detail = lastTwoPathSegments(record.path.trim());
	} else if (
		typeof record.file_path === "string" &&
		record.file_path.trim().length > 0
	) {
		detail = lastTwoPathSegments(record.file_path.trim());
	} else if (
		typeof record.command === "string" &&
		record.command.trim().length > 0
	) {
		detail = record.command.trim();
	} else if (
		typeof record.pattern === "string" &&
		record.pattern.trim().length > 0
	) {
		detail = record.pattern.trim();
	}

	if (!detail) {
		return toolName;
	}

	return `${toolName} → ${redactSecrets(detail)}`;
}

export function startTurn(
	state: FlightdeckState,
	startedAt: number,
): FlightdeckState {
	return {
		...state,
		isRunning: true,
		turn: {
			startedAt,
			edits: 0,
			errors: 0,
			agentsSpawned: 0,
			costAtStart: state.costUsd,
		},
	};
}

export function recordToolCall(
	state: FlightdeckState,
	event: { isEdit?: boolean; isError?: boolean },
): FlightdeckState {
	return {
		...state,
		turn: {
			...state.turn,
			edits: state.turn.edits + (event.isEdit ? 1 : 0),
			errors: state.turn.errors + (event.isError ? 1 : 0),
		},
	};
}

export interface CompleteTurnOptions {
	endedAt: number;
	agentsSpawned?: number;
	reason?: "answer" | "error";
}

export function completeTurn(
	state: FlightdeckState,
	outcome: CompleteTurnOptions,
): FlightdeckState {
	const durationMs = Math.max(0, outcome.endedAt - state.turn.startedAt);
	const rawDelta = state.costUsd - state.turn.costAtStart;
	const costDelta =
		rawDelta > 0.0001 ? Math.round(rawDelta * 10_000) / 10_000 : null;

	const receipt: TurnReceipt = {
		durationMs,
		agents: outcome.agentsSpawned ?? state.turn.agentsSpawned,
		edits: state.turn.edits,
		errors: state.turn.errors,
		costDelta,
		reason: outcome.reason ?? "answer",
	};

	return {
		...state,
		steps: state.steps + 1,
		isRunning: false,
		receipt,
	};
}

export function appendLog(
	state: FlightdeckState,
	entry: LogEntry,
): FlightdeckState {
	const nextLog = [...state.log, entry];
	return {
		...state,
		log: nextLog.length > 60 ? nextLog.slice(-60) : nextLog,
	};
}

export function resetFlightdeckState(
	state: FlightdeckState,
	now: number,
): FlightdeckState {
	return {
		...state,
		receipt: null,
		log: [],
		expandedAgentId: null,
		resetAfterAt: now,
		turn: {
			startedAt: 0,
			edits: 0,
			errors: 0,
			agentsSpawned: 0,
			costAtStart: state.costUsd,
		},
	};
}
