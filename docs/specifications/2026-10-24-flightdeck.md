# Flightdeck — Specification

- **Status:** Draft
- **Author:** Integralist
- **Created:** 2026-10-24
- **Language:** TypeScript

## Problem Statement

When a session delegates work across several subagents, the list below the
prompt shows only each active or recently finished subagent's handle, short
description, model, and context use. Once a finished row expires after ten
seconds, its visual trace leaves the screen, and the developer has no live
view of how subagents overlapped in time, what the main model's own context
and cost look like alongside them, what the last main turn accomplished, or
how session events unfolded in order.

Opening the subagent viewer answers what a single subagent is saying, but it
replaces the main conversation with a full-screen transcript. A developer who
wants an ambient dashboard beside the conversation—while keeping the list
below the prompt free for quick arrow-key selection and steering—has no way to
dock one.

## Solution

Add a `/flightdeck` command that opens a live dashboard modelled on
[claude-flightdeck](https://github.com/scasella/claude-flightdeck/tree/f9c3c5230775109de4bd08c5c7a42112a6a2a885).

In fullscreen mode (`ViewportTUI`), Flightdeck docks as a split pane to the
right of the main conversation using an `HStack`, so the conversation and editor
reflow cleanly into the left column without any text being covered. In regular
terminal mode, Flightdeck renders as a compact inline summary of at most eight
rows above the prompt editor.

The dashboard draws four Pi-native panels connected by rails that animate while
the main model or any subagent is running and rest as dim lines when idle:

1. **Main** — the main model name, running or idle state, effort gauge
   (`▮▯`), main-loop request count, context gauge (`■□`) with percentage and
   token window, compaction count (`⟲`), and cumulative session cost (`$`).
2. **Agents** — subagents from the registry drawn as side-by-side cards while
   they fit (showing handle, description, agent type and model, context and
   output tokens, turn count, status glyph, and elapsed clock), switching to
   swimlanes on a shared time axis when the count exceeds available card slots.
   Pressing `1`–`9` while the pane is focused expands or collapses a subagent's
   detail box (full description, last three tool calls, and the start of its
   output).
3. **Receipt** — the running main turn's elapsed clock, or the last completed
   turn's duration, subagent count, file edits, tool errors, and cost delta.
4. **Session log** — a rolling timestamped log of prompts, subagent spawns and
   completions, file edits, and tool errors.

Opening Flightdeck leaves the subagent list below the prompt visible by default
so the user can still select rows with the arrow keys, open the subagent viewer,
and steer subagents. The user can hide the Flightdeck pane with
`/flightdeck hide` (or `/flightdeck close`), hide only the bottom subagent list
with `/flightdeck hide-list`, restore the bottom list with
`/flightdeck show-list`, clear recorded turn/log/subagent display state with
`/flightdeck reset`, or override layout mode with
`/flightdeck layout auto|compact|wide|mini`.

## User Stories

1. As a developer running fullscreen Pi, I want `/flightdeck` to open a docked
   side pane beside my conversation, so that I can watch main-model vitals,
   subagents, turn receipts, and session events without covering transcript
   lines.
2. As a developer running regular scrollback mode, I want `/flightdeck` to
   render a compact inline summary above the prompt, so that I still get live
   vitals when fullscreen split panes are unavailable.
3. As a developer, I want the subagent list below the prompt to stay visible by
   default when `/flightdeck` opens, so that I can still use arrow keys and
   `Enter` to open a subagent's viewer and steer it.
4. As a developer who only wants the side pane on screen, I want
   `/flightdeck hide-list` (and `/flightdeck show-list`) to hide or restore the
   subagent list below the prompt while keeping the Flightdeck pane open.
5. As a developer, I want `/flightdeck hide` to close the Flightdeck pane and
   restore the full-width conversation.
6. As a developer delegating to subagents, I want a few subagents drawn as
   side-by-side cards and larger batches drawn as time-axis swimlanes, so that
   both detail and parallel timing are easy to scan.
7. As a developer, I want to expand a subagent card or lane to inspect its full
   description, recent tool calls, and opening answer without leaving the
   conversation.

## Acceptance Criteria

```gherkin
Feature: Opening and hiding the Flightdeck pane
  As a developer
  I want to control the Flightdeck pane and the bottom subagent list from /flightdeck
  So that I can choose between split-pane + list, split-pane alone, or no dashboard

  Scenario: Opens docked split pane in fullscreen mode while keeping the list below the prompt
    Given the session is in fullscreen TUI mode
    And the subagent list below the prompt is visible
    When the user runs "/flightdeck"
    Then the Flightdeck pane is mounted to the right of the main conversation in a horizontal split
    And the main conversation reflows to the remaining left width
    And the subagent list below the prompt remains visible

  Scenario: Opens inline mini summary in regular TUI mode
    Given the session is in regular TUI mode
    When the user runs "/flightdeck"
    Then the Flightdeck mini summary is mounted above the prompt editor
    And it renders at most 8 rows
    And the subagent list below the prompt remains visible

  Scenario: Hides the Flightdeck pane
    Given the Flightdeck pane is open
    When the user runs "/flightdeck hide"
    Then the Flightdeck pane is removed from the screen
    And the main conversation returns to full terminal width

  Scenario: Hides only the subagent list below the prompt
    Given the Flightdeck pane is open
    And the subagent list below the prompt is visible
    When the user runs "/flightdeck hide-list"
    Then the Flightdeck pane remains open
    And the subagent list below the prompt is hidden

  Scenario: Restores the subagent list below the prompt
    Given the Flightdeck pane is open
    And the subagent list below the prompt was hidden with "/flightdeck hide-list"
    When the user runs "/flightdeck show-list"
    Then the Flightdeck pane remains open
    And the subagent list below the prompt is visible again

Feature: Rendering the main, agents, receipt, and session log panels
  As a developer
  I want Flightdeck to reflect real session and subagent events
  So that every number and status on the dashboard is trustworthy

  Scenario: Shows main model vitals
    Given the Flightdeck pane is open
    And the main model has completed 3 requests at medium effort with 45% context use and 1 compaction
    When the Flightdeck pane renders
    Then the main panel shows the model name, idle or working state, medium effort gauge, 3 requests, 45% context gauge, 1 compaction, and session cost

  Scenario: Renders subagents as cards when they fit
    Given the Flightdeck pane is 66 columns wide
    And 2 subagents have been spawned
    When the Flightdeck pane renders
    Then the agents panel renders 2 side-by-side cards with fan-out and merge rails
    And each card shows the subagent's handle, description, type, token metrics, turn count, status glyph, and elapsed time

  Scenario: Switches subagents to swimlanes when cards no longer fit
    Given the Flightdeck pane is 50 columns wide
    And 5 subagents have been spawned
    When the Flightdeck pane renders
    Then the agents panel renders 5 horizontal swimlanes on a shared time axis
    And each lane shows its status glyph, numbered handle/description, proportional time bar, and elapsed duration

  Scenario: Expands a subagent card or lane
    Given the Flightdeck pane is open with 3 subagents
    When the user selects subagent 2 for expansion
    Then an expanded detail box appears beneath the agents panel
    And it shows subagent 2's full description, up to 3 recent tool calls, and the start of its output

  Scenario: Shows running turn and completed turn receipt
    Given the Flightdeck pane is open
    When a main-model turn finishes in 7 seconds with 2 subagents, 1 file edit, 0 errors, and $0.15 added cost
    Then the receipt panel shows "last turn 7s · 2 subagents · 1 edit · 0 errors · +$0.15"

  Scenario: Records session log entries in chronological order
    Given the Flightdeck pane is open
    When the user submits a prompt, a subagent spawns and finishes, and the main model edits a file
    Then the session log panel lists timestamped entries for the prompt, the spawn, the completion, and the edit

  Scenario: Resets transient dashboard history while keeping cumulative vitals
    Given the Flightdeck pane has recorded subagent lanes, a turn receipt, and session log entries
    And the session has accumulated cost and compactions
    When the user runs "/flightdeck reset"
    Then the Flightdeck agents view, turn receipt, and session log are cleared
    And the main panel retains the session's cumulative cost and compaction count
```

## Behavioural Delta

- **Baseline:** `docs/specifications/2026-08-22-subagents.md` at `37e9c2a02873bd9733971bd529f12e53d9d40112`

### ADDED

```gherkin
  Scenario: Controlling the subagent list alongside Flightdeck
    Given a running subagent
    And the Flightdeck pane is open
    When the user runs "/flightdeck hide-list"
    Then the subagent list below the prompt renders no rows
    And the Flightdeck pane continues showing the running subagent
```

## Testing Seams

- **Flightdeck state reducer** — pure functions mapping Pi session events
  (`turn_start`, `turn_end`, `tool_execution_start`, `tool_execution_end`,
  `session_before_compact`) and `SubagentRegistry` records into the dashboard
  state model (vitals, cards/swimlanes geometry, turn receipt, and log rows).
  Chosen so time-axis math, token formatting, and receipt accounting are tested
  deterministically with a fake clock.
- **Flightdeck pane component** — constructed with a state snapshot, fake clock,
  and terminal width, asserting on rendered lines (with ANSI codes stripped or
  inspected). Covers card-to-swimlane switching thresholds, wide two-column
  layout (`>= 110` pane columns), compact single-column layout, mini 8-row
  layout, and subagent expansion.
- **Command and mount controller** — exercises `/flightdeck` subcommands
  (`open`, `hide`/`close`, `hide-list`, `show-list`, `reset`, `layout`) against
  a fake `ViewportTUI` / `ExtensionUIContext`, verifying that fullscreen mode
  wraps `layoutRoot` in an `HStack`, regular mode mounts the `aboveEditor`
  widget, `hide` restores the original `layoutRoot`, and `hide-list` suppresses
  `SubagentList` without disposing the registry.

## Implementation Decisions

- **Fullscreen split uses `ViewportTUI.setLayoutRoot`.** When `isViewportTUI(tui)`
  is true, Flightdeck captures the host's existing `layoutRoot` and replaces it
  with an `HStack` holding the chat viewport on the left (`grow: 1`) and the
  Flightdeck pane on the right (fixed or percentage width, minimum 36 columns,
  auto-hiding when terminal width is under 100 columns). Closing Flightdeck
  restores the original `layoutRoot`.
- **Regular mode uses `ctx.ui.setWidget` with `placement: "aboveEditor"`.**
  Because regular terminal mode owns scrollback and has no `ViewportTUI` root,
  Flightdeck renders its 8-row mini layout above the prompt editor.
- **TUI mode switches rebind cleanly.** If the user toggles between fullscreen
  and regular mode while Flightdeck is open, Flightdeck unmounts from the old
  surface and mounts in the corresponding mode on the new surface.
- **The bottom `SubagentList` remains visible by default.** `SubagentList` gains
  an `isHidden` predicate controlled by `/flightdeck hide-list` and
  `/flightdeck show-list`. When hidden, `SubagentList.render()` returns `[]` and
  ignores arrow keys, while `/flightdeck` stays open.
- **Pi-native panel set (Option A).** Flightdeck includes `main`, `agents`,
  `receipt`, and `log`. Claude Code-only panels (`architect` advisor consults
  and `gate` permission classifier verdicts) and subscription rate-limit windows
  (`5h` / `7d`) are omitted because Pi does not expose those primitives.
- **Subagent tool calls and token metrics come from child `AgentSession`
  subscriptions.** As each subagent runs, Flightdeck records its latest context
  and output token counts and its last three tool call summaries onto the
  dashboard state so cards and expanded views stay live without polling files.
- **Animated rails use a single unref'd timer only while work is active.** When
  the main model is streaming or any subagent has status `running`, a `110ms`
  timer advances the rail packet phase (`●•`) and elapsed clocks; when both are
  idle, the timer stops so an idle terminal does zero background redraws.

## Out of Scope

- Claude Code `ARCHITECT` advisor timeline and `GATE` permission classifier
  panels.
- Subscription rate-limit reset gauges (`5h` and `7d` windows).
- Graphical desktop/web SVG swimlanes (Pi's TUI is terminal-only).
- Persisting Flightdeck log history across separate Pi sessions.

## Living Specifications

- [`docs/specifications/2026-08-22-subagents.md`](./2026-08-22-subagents.md) —
  subagent lifecycle, registry, bottom subagent list, and viewer behaviour.

## Research

- [claude-flightdeck reference implementation](https://github.com/scasella/claude-flightdeck/tree/f9c3c5230775109de4bd08c5c7a42112a6a2a885)

## Open Questions

- Default width of the docked fullscreen split pane: 38% of terminal width
  (clamped to 42–68 columns in single-column mode, or up to 110+ columns when
  `/flightdeck layout wide` is chosen) is assumed.
- Keyboard shortcut to focus the Flightdeck pane or toggle subagent expansion
  (`1`–`9`) without stealing keys from the prompt editor: routing `/flightdeck expand <1-9>` alongside empty-prompt or shortcut-based focus is assumed.
