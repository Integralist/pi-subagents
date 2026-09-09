# Name the tools for readers without priors

- **Status**: Accepted
- **Date**: 2026-08-22
- **Deciders**: Integralist
- **Amended by**:
  [List subagents rather than wait for them](2026-08-23-list-subagents-rather-than-wait.md)
  (four registered tools becomes five) and
  [Let a subagent's persona be supplied at spawn time](2026-08-23-personas-supplied-at-spawn.md)
  (the parameter shape below gains `system_prompt`, `tools`, and
  `name`)

## Context

The extension registers tools the main agent calls to start and
control subagents. Their names and parameter descriptions occupy the
model's context on every turn, so naming affects both call
reliability and token cost.

A widely-copied convention exists: Claude Code's `Agent`,
`steer_subagent`, and `get_subagent_result`. One reference
implementation adopts it deliberately, describing itself as bringing
"Claude Code-style" subagents to Pi and citing "same tool names,
calling conventions, and UI patterns" as a feature
(`tintinweb-pi-subagents/README.md`). The value of that convention is
that models already familiar with it need less instruction.

That value is conditional on the models in use. The primary models
for this project are GPT and Gemini, which carry no particular prior
for a tool named `Agent`. `Agent` is also a generic name with real
collision potential — Pi assigns numeric suffixes when two extensions
register the same command name
(`pi-coding-agent/docs/extensions.md`), and a vague tool name invites
exactly that.

An earlier argument for the borrowed convention — that it is required
for `@name` mention routing — does not hold. Mention routing is
implemented in Pi's `input` event handler
(`dist/core/extensions/types.d.ts:900`), which intercepts submitted
text before any tool is involved.

## Decision

We will name the tools `spawn_subagent`, `steer_subagent`,
`stop_subagent`, and `get_subagent_result` — a consistent
`verb_subagent` shape that is self-describing to a model with no
prior exposure.

We will keep the established *parameter* shape: `subagent_type`,
`prompt`, `description`, `model`, `thinking`. Parameter conventions
are proven and cost nothing to adopt.

Tool parameter schemas will use plain types and explicit enums only,
avoiding union and conditional constructs, because model providers
differ in which JSON Schema features they accept.

### Amendment: separate spawn contracts

Amended 2026-08-31. The self-describing rule still stands, but the
single `spawn_subagent` name and parameter decision is superseded. The
current six tools are `spawn_named_subagent`, `spawn_inline_subagent`,
`steer_subagent`, `stop_subagent`, `get_subagent_result`, and
`list_subagents`.

Named spawn exposes only `subagent_type`, `prompt`, and `description`.
Inline spawn exposes a caller-defined character and its execution
settings. Separate schemas were chosen after the flat schema caused a
model to populate optional execution fields while launching an agent
file. Keeping a generic compatibility alias would preserve that
ambiguity, so `spawn_subagent` is removed intentionally.

This alternative was not evaluated in the original options below. The
original comparison considered one multiplexed lifecycle tool against
several lifecycle tools, not two spawn tools distinguished by character
source.

## Options Considered

- **Self-describing `verb_subagent` names (chosen)** — reads
  correctly to any model, no collision risk, consistent shape across
  four tools. Costs slightly longer descriptions than a borrowed
  convention would need for a Claude model.
- **Claude Code-compatible names** — free familiarity, but only for
  Claude models, which are not the primary target here. Leaves the
  collision risk of a tool named `Agent` with no compensating benefit.
- **One multiplexed tool with an `action` parameter** — the approach
  in `nicobailon-pi-subagents/src/extension/schemas.ts:255-330`.
  Occupies one slot in the tool list rather than four, but carries a
  very large schema and pushes validation into runtime branching.
  Rejected as harder for a model with no priors, which is the case we
  are optimising for.

## Consequences

Easier: the tool surface is legible to any model without in-context
teaching, and the names will not collide with another extension's.

Harder: users arriving from Claude Code will not find `Agent`. The
README should name the mapping explicitly.

Constraint: the plain-schema rule applies to every future tool
parameter. A parameter that genuinely needs a union must be expressed
as separate fields or a string enum instead.

## Source

- [Implementation plan](../plans/2026-08-22-subagents.md)
- [Specification](../specifications/2026-08-22-subagents.md)
