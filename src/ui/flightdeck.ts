import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentRecord, SubagentRegistry } from "../registry.ts";
import {
	type FlightdeckState,
	fmtClock,
	fmtDuration,
	fmtTimer,
	fmtUsd,
	gauge,
	kTokens,
	lanes,
	plural,
	prettyModel,
	titleLines,
} from "./flightdeck-state.ts";
import { STATUS_COLOR, STATUS_MARK } from "./status.ts";

export interface FlightdeckPaneOptions {
	registry: SubagentRegistry;
	getState: () => FlightdeckState;
	theme: Theme;
	placement?: "docked" | "inline";
	rows?: () => number;
	now?: () => number;
	railPhase?: () => number;
}

/** Pad a rendered cell out to `width`, counting visible terminal width. */
function padCell(cell: string, width: number): string {
	return cell + " ".repeat(Math.max(0, width - visibleWidth(cell)));
}

/**
 * Draw a rounded border box around `lines`.
 *
 * Each line is truncated and padded to `width - 2` so every returned line
 * has a visible width of exactly `width`.
 */
export function drawBox(
	lines: string[],
	width: number,
	borderColor: (s: string) => string = (s) => s,
	title?: string,
): string[] {
	if (width <= 0) return [];
	if (width === 1) return lines.map(() => borderColor("│"));
	if (width === 2) {
		return [
			borderColor("╭╮"),
			...lines.map(() => borderColor("││")),
			borderColor("╰╯"),
		];
	}

	const innerW = width - 2;
	let top: string;
	if (title && visibleWidth(title) + 5 <= width) {
		const fill = width - 5 - visibleWidth(title);
		top = borderColor("╭─ ") + title + borderColor(` ${"─".repeat(fill)}╮`);
	} else {
		top = borderColor(`╭${"─".repeat(innerW)}╮`);
	}
	const bottom = borderColor(`╰${"─".repeat(innerW)}╯`);

	const mid = lines.map((line) => {
		const truncated = truncateToWidth(line, innerW);
		return borderColor("│") + padCell(truncated, innerW) + borderColor("│");
	});

	return [top, ...mid, bottom];
}

/**
 * Draw a horizontal rail (`─`) with branch marks (`┬` or `┴`) and optional
 * moving packets (`●`, `•`) animated by `phase`.
 */
export function renderRail(
	width: number,
	active: boolean,
	phase: number,
	theme: Theme,
	marks: number[],
	isMerge: boolean,
): string {
	if (width <= 0) return "";
	const junctionChar = isMerge ? "┴" : "┬";
	const markSet = new Set(marks);

	const chars: string[] = [];
	for (let i = 0; i < width; i++) {
		if (markSet.has(i)) {
			chars.push(theme.fg("dim", junctionChar));
			continue;
		}
		if (active) {
			const mod = (((i - phase) % 24) + 24) % 24;
			if (mod === 0) {
				chars.push(theme.fg("accent", "●"));
				continue;
			}
			if (mod === 1) {
				chars.push(theme.fg("dim", "•"));
				continue;
			}
		}
		chars.push(theme.fg("dim", "─"));
	}
	return chars.join("");
}

function effortGauge(effort: string): string {
	switch (effort.toLowerCase()) {
		case "low":
			return "▮▯▯▯";
		case "medium":
			return "▮▮▯▯";
		case "high":
			return "▮▮▮▯";
		case "max":
			return "▮▮▮▮";
		default:
			return "▯▯▯▯";
	}
}

function renderMainPanel(
	state: FlightdeckState,
	w: number,
	theme: Theme,
): string[] {
	const modelName = prettyModel(state.model) || "model";
	const leftTitle = `${modelName} · main`;
	const statusText = state.isRunning
		? theme.fg("success", "● working")
		: theme.fg("muted", "○ idle");
	const line1Space = Math.max(
		1,
		w - 2 - visibleWidth(leftTitle) - visibleWidth(statusText),
	);
	const line1 = `${theme.bold(leftTitle)}${" ".repeat(line1Space)}${statusText}`;

	const effortG = effortGauge(state.effort);
	const effortPart = state.effort
		? `effort ${effortG} ${state.effort}`
		: "effort ▯▯▯▯ off";
	const stepsPart = `${state.steps} req`;
	const line2 = `${theme.fg("muted", effortPart)}   ${theme.fg("muted", stepsPart)}`;

	const pct =
		state.contextPercent != null ? Math.round(state.contextPercent) : 0;
	const g = gauge(pct, 10);
	const gaugeStr = `${theme.fg("accent", g.on)}${theme.fg("dim", g.off)}`;
	const tokensStr = kTokens(state.tokens ?? 0);
	const windowStr = kTokens(state.contextWindow || 200_000);
	const compactStr = state.compactions > 0 ? ` ⟲${state.compactions}` : "";
	const leftVitals = `ctx ${gaugeStr} ${pct}% ${tokensStr}/${windowStr}${compactStr}`;

	const costStr = state.costUsd > 0 ? fmtUsd(state.costUsd) : "";
	const rightCost = costStr ? theme.fg("accent", costStr) : "";
	const line3Space = Math.max(
		1,
		w - 2 - visibleWidth(leftVitals) - visibleWidth(rightCost),
	);
	const line3 = `${leftVitals}${" ".repeat(line3Space)}${rightCost}`;

	return drawBox([line1, line2, line3], w, (s) => theme.fg("muted", s));
}

function renderAgentsPanel(
	state: FlightdeckState,
	agents: SubagentRecord[],
	w: number,
	now: number,
	active: boolean,
	phase: number,
	theme: Theme,
): string[] {
	const runningCount = agents.filter((a) => a.status === "running").length;
	const totalCount = agents.length;
	const leftHeader = `agents · ${runningCount} running · ${totalCount} total`;

	const maxCards = Math.min(3, Math.floor((w + 1) / 21));
	const useSwimlanes = agents.length > maxCards;

	const shownCount = useSwimlanes
		? Math.min(6, agents.length)
		: Math.min(maxCards, agents.length);
	const rightHeader =
		shownCount > 1
			? `1-${shownCount} expand`
			: shownCount === 1
				? "1 expand"
				: "";

	const headerSpace = Math.max(
		1,
		w - visibleWidth(leftHeader) - visibleWidth(rightHeader),
	);
	const headerLine = `${theme.bold(leftHeader)}${" ".repeat(headerSpace)}${theme.fg("dim", rightHeader)}`;

	const result: string[] = [truncateToWidth(headerLine, w)];

	if (agents.length === 0) {
		result.push(renderRail(w, active, phase, theme, [], false));
		result.push(theme.fg("muted", "  (no subagents)"));
		return result;
	}

	if (!useSwimlanes) {
		// Side-by-side cards
		const cardCount = agents.length;
		const totalGutters = cardCount - 1;
		const cardW = Math.floor((w - totalGutters) / cardCount);
		const marks = agents.map((_, i) => Math.floor(i * (cardW + 1) + cardW / 2));

		result.push(renderRail(w, active, phase, theme, marks, false));

		const renderedCards = agents.map((rec, i) => {
			const idx = i + 1;
			const first = Math.max(12, Math.min(16, cardW - 8));
			const rest = Math.max(14, Math.min(18, cardW - 6));
			const [t1, t2] = titleLines(rec.description, first, rest);

			const line1 = ` ${idx}: ${t1}`;
			const line2 = t2 ? `   ${t2}` : "";
			const line3 = ` ${rec.type}`;
			const ctxK = kTokens(rec.contextTokens ?? 0);
			const outK = kTokens(rec.outputTokens ?? 0);
			const turns = rec.turns ?? 0;
			const line4 = ` ctx ${ctxK} · out ${outK} · ${turns} st`;

			const dur = Math.max(0, (rec.finishedAt ?? now) - rec.startedAt);
			const glyph = STATUS_MARK[rec.status] ?? "·";
			const line5 = ` ${glyph} ${rec.status} ${fmtDuration(dur)}`;

			return drawBox([line1, line2, line3, line4, line5], cardW, (s) =>
				theme.fg("muted", s),
			);
		});

		// Zip card rows together
		const numCardRows = renderedCards[0]?.length ?? 0;
		for (let r = 0; r < numCardRows; r++) {
			const row = renderedCards.map((c) => c[r] ?? "").join(" ");
			result.push(padCell(truncateToWidth(row, w), w));
		}

		result.push(renderRail(w, active, phase, theme, marks, true));
	} else {
		// Swimlanes
		const shown = agents.slice(-6);
		result.push(renderRail(w, active, phase, theme, [], false));

		const labelW = Math.max(16, Math.min(22, Math.floor(w * 0.4)));
		const durSample = " 00m00s";
		const durW = durSample.length;
		const barW = Math.max(6, w - 2 - labelW - 1 - durW - 1);

		const laneGeoms = lanes(
			shown.map((a) => ({
				id: a.id,
				startedAt: a.startedAt,
				finishedAt: a.finishedAt,
			})),
			now,
			barW,
		);

		shown.forEach((rec, idx) => {
			const i = idx + 1;
			const glyph = STATUS_MARK[rec.status] ?? "·";
			const coloredGlyph = theme.fg(STATUS_COLOR[rec.status] ?? "muted", glyph);
			const label = `${i}: ${rec.description}`;
			const paddedLabel = padCell(truncateToWidth(label, labelW), labelW);

			const geom = laneGeoms[idx] ?? {
				id: rec.id,
				before: 0,
				bar: barW,
				after: 0,
			};
			const barStr = `${theme.fg("dim", "·".repeat(geom.before))}${theme.fg(STATUS_COLOR[rec.status] ?? "accent", "━".repeat(geom.bar))}${theme.fg("dim", "·".repeat(geom.after))}`;

			const dur = Math.max(0, (rec.finishedAt ?? now) - rec.startedAt);
			const durStr = fmtDuration(dur);
			const paddedDur = durStr.padStart(durW);

			const line = `${coloredGlyph} ${paddedLabel} ${barStr} ${paddedDur}`;
			result.push(padCell(truncateToWidth(line, w), w));
		});

		// Expanded subagent detail box if state.expandedAgentId matches
		const expanded = state.expandedAgentId
			? agents.find(
					(a) =>
						a.id === state.expandedAgentId ||
						a.handle === state.expandedAgentId,
				)
			: undefined;

		if (expanded) {
			const detailLines: string[] = [expanded.description];
			if (expanded.toolCalls && expanded.toolCalls.length > 0) {
				for (const tc of expanded.toolCalls) {
					detailLines.push(`· ${tc.text}`);
				}
			}
			if (expanded.outcome?.output) {
				const firstLine = expanded.outcome.output.split("\n")[0]?.trim();
				if (firstLine) {
					detailLines.push(`» ${firstLine}`);
				}
			}
			const detailBox = drawBox(detailLines, w, (s) => theme.fg("muted", s));
			result.push(...detailBox);
		}

		result.push(renderRail(w, active, phase, theme, [], true));
	}

	return result;
}

function renderReceiptPanel(
	state: FlightdeckState,
	w: number,
	now: number,
	theme: Theme,
): string[] {
	if (state.isRunning) {
		const elapsed = Math.max(0, now - state.turn.startedAt);
		const dur = fmtDuration(elapsed);
		const timer = fmtTimer(elapsed);
		const text = `● running turn ${dur} (${timer})`;
		return drawBox([text], w, (s) => theme.fg("muted", s));
	}
	if (state.receipt) {
		const mark = state.receipt.reason === "error" ? "✗" : "✓";
		const dur = fmtDuration(state.receipt.durationMs);
		const agentsStr = plural(state.receipt.agents, "subagent");
		const editsStr = plural(state.receipt.edits, "edit");
		const errorsStr = plural(state.receipt.errors, "error");
		const costStr =
			state.receipt.costDelta != null && state.receipt.costDelta > 0
				? ` · +${fmtUsd(state.receipt.costDelta)}`
				: "";
		const text = `${mark} last turn ${dur} · ${agentsStr} · ${editsStr} · ${errorsStr}${costStr}`;
		return drawBox([text], w, (s) => theme.fg("muted", s));
	}
	return [];
}

function renderLogPanel(
	state: FlightdeckState,
	w: number,
	theme: Theme,
): string[] {
	const entries = state.log.slice(-8);
	const lines =
		entries.length > 0
			? entries.map((entry) => {
					const timeStr = theme.fg("dim", fmtClock(entry.at));
					const whoStr = theme.fg("muted", entry.who);
					let textStr = entry.text;
					if (entry.kind === "error") {
						textStr = theme.fg("error", entry.text);
					} else if (entry.kind === "done") {
						textStr = theme.fg("success", entry.text);
					}
					return `${timeStr} ${whoStr} ${textStr}`;
				})
			: [theme.fg("muted", "  (no session events)")];

	return drawBox(lines, w, (s) => theme.fg("muted", s), "session log");
}

function renderMini(
	state: FlightdeckState,
	agents: SubagentRecord[],
	w: number,
	now: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Row 1: Vitals
	const model = prettyModel(state.model) || "main";
	const status = state.isRunning ? "working" : "idle";
	const pct =
		state.contextPercent != null ? Math.round(state.contextPercent) : 0;
	const tokens = kTokens(state.tokens ?? 0);
	const windowK = kTokens(state.contextWindow || 200_000);
	const cost = state.costUsd > 0 ? `   ${fmtUsd(state.costUsd)}` : "";
	const vitals = `${theme.bold(model)} · ${status}   ctx ${pct}% ${tokens}/${windowK}${cost}`;
	lines.push(padCell(truncateToWidth(vitals, w), w));

	// Rows 2..4: Up to 3 subagents
	const maxAgents = 3;
	const shown = agents.slice(0, maxAgents);
	for (const rec of shown) {
		const glyph = STATUS_MARK[rec.status] ?? "·";
		const dur = Math.max(0, (rec.finishedAt ?? now) - rec.startedAt);
		const agentLine = `${glyph} ${rec.handle} · ${rec.description} (${fmtDuration(dur)})`;
		lines.push(padCell(truncateToWidth(agentLine, w), w));
	}

	// Overflow row
	const overflow = agents.length - maxAgents;
	if (overflow > 0) {
		const overflowLine = `+${overflow} more subagents`;
		lines.push(padCell(truncateToWidth(theme.fg("dim", overflowLine), w), w));
	}

	// Last-turn receipt row
	if (state.receipt) {
		const dur = fmtDuration(state.receipt.durationMs);
		const costDelta =
			state.receipt.costDelta != null && state.receipt.costDelta > 0
				? ` · +${fmtUsd(state.receipt.costDelta)}`
				: "";
		const receiptLine = `last turn ${dur} · ${plural(state.receipt.agents, "subagent")} · ${plural(state.receipt.edits, "edit")}${costDelta}`;
		lines.push(padCell(truncateToWidth(theme.fg("muted", receiptLine), w), w));
	} else if (state.isRunning) {
		const dur = fmtDuration(Math.max(0, now - state.turn.startedAt));
		const runningLine = `turn running ${dur}`;
		lines.push(padCell(truncateToWidth(theme.fg("muted", runningLine), w), w));
	}

	return lines.slice(0, 8);
}

function renderWide(
	state: FlightdeckState,
	agents: SubagentRecord[],
	w: number,
	now: number,
	active: boolean,
	phase: number,
	theme: Theme,
): string[] {
	const leftW = Math.max(36, Math.min(48, Math.floor((w - 1) * 0.4)));
	const rightW = w - leftW - 1;

	// Header line across full width
	const headerTitle = theme.bold("FLIGHTDECK");
	const headerClock = theme.fg("muted", fmtClock(now));
	const headerSpace = Math.max(
		1,
		w - visibleWidth(headerTitle) - visibleWidth(headerClock),
	);
	const headerLine = `${headerTitle}${" ".repeat(headerSpace)}${headerClock}`;

	// Left column: main panel
	const leftCol = renderMainPanel(state, leftW, theme);

	// Right column: agents panel + receipt panel
	const agentsCol = renderAgentsPanel(
		state,
		agents,
		rightW,
		now,
		active,
		phase,
		theme,
	);
	const receiptCol = renderReceiptPanel(state, rightW, now, theme);
	const rightCol = [...agentsCol, ...receiptCol];

	// Join left and right columns side-by-side
	const maxRows = Math.max(leftCol.length, rightCol.length);
	const joinedRows: string[] = [];
	for (let r = 0; r < maxRows; r++) {
		const leftLine = leftCol[r] ?? " ".repeat(leftW);
		const rightLine = rightCol[r] ?? " ".repeat(rightW);
		const fullLine = `${padCell(leftLine, leftW)} ${padCell(rightLine, rightW)}`;
		joinedRows.push(padCell(truncateToWidth(fullLine, w), w));
	}

	// Log panel full width
	const logCol = renderLogPanel(state, w, theme);

	return [
		padCell(truncateToWidth(headerLine, w), w),
		...joinedRows,
		renderRail(w, active, phase, theme, [], false),
		...logCol,
	];
}

function renderDocked(
	state: FlightdeckState,
	agents: SubagentRecord[],
	w: number,
	now: number,
	active: boolean,
	phase: number,
	theme: Theme,
): string[] {
	const headerTitle = theme.bold("FLIGHTDECK");
	const headerClock = theme.fg("muted", fmtClock(now));
	const headerSpace = Math.max(
		1,
		w - visibleWidth(headerTitle) - visibleWidth(headerClock),
	);
	const headerLine = `${headerTitle}${" ".repeat(headerSpace)}${headerClock}`;

	const mainBox = renderMainPanel(state, w, theme);
	const agentsBox = renderAgentsPanel(
		state,
		agents,
		w,
		now,
		active,
		phase,
		theme,
	);
	const receiptBox = renderReceiptPanel(state, w, now, theme);
	const logBox = renderLogPanel(state, w, theme);

	return [
		padCell(truncateToWidth(headerLine, w), w),
		...mainBox,
		...agentsBox,
		...receiptBox,
		...logBox,
	];
}

export class FlightdeckPane implements Component {
	readonly #registry: SubagentRegistry;
	readonly #getState: () => FlightdeckState;
	readonly #theme: Theme;
	readonly #placement: "docked" | "inline";
	readonly #rows: (() => number) | undefined;
	readonly #now: (() => number) | undefined;
	readonly #railPhase: (() => number) | undefined;

	constructor(options: FlightdeckPaneOptions) {
		this.#registry = options.registry;
		this.#getState = options.getState;
		this.#theme = options.theme;
		this.#placement = options.placement ?? "docked";
		this.#rows = options.rows;
		this.#now = options.now;
		this.#railPhase = options.railPhase;
	}

	render(width: number): string[] {
		const state = this.#getState();
		const now = this.#now ? this.#now() : Date.now();
		const phase = this.#railPhase ? this.#railPhase() : 0;
		const agents = this.#registry
			.list()
			.filter((a) => a.startedAt >= state.resetAfterAt);
		const active =
			state.isRunning || agents.some((a) => a.status === "running");

		const isMini =
			state.layout === "mini" ||
			(state.layout === "auto" && this.#placement === "inline");
		if (isMini) {
			return renderMini(state, agents, width, now, this.#theme);
		}

		const isWide =
			state.layout === "wide" || (state.layout === "auto" && width >= 110);
		const innerW = Math.max(1, width - 2);
		const rawLines = isWide
			? renderWide(state, agents, innerW, now, active, phase, this.#theme)
			: renderDocked(state, agents, innerW, now, active, phase, this.#theme);

		let lines = rawLines;
		if (this.#rows) {
			const maxR = this.#rows();
			if (maxR > 0) {
				lines = rawLines.slice(0, maxR);
				while (lines.length < maxR) {
					lines.push(" ".repeat(innerW));
				}
			}
		}
		const leftBorder = `${this.#theme.fg("muted", "│")} `;
		return lines.map((line) => truncateToWidth(`${leftBorder}${line}`, width));
	}

	invalidate(): void {}
}
