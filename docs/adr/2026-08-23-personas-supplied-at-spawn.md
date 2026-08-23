# Let a subagent's persona be supplied at spawn time

- **Status**: Accepted
- **Date**: 2026-08-23
- **Deciders**: Integralist

## Context

A subagent's character comes from a Markdown file with YAML
frontmatter, discovered across three tiers — the set shipped with the
extension, the user's own directory, and the project (`src/agents.ts:4-15`).
`spawn_subagent` requires `subagent_type` to name one of those files
(`src/index.ts:288`) and refuses a name it cannot find
(`src/index.ts:344-349`).

Skills want a subagent with a character of its own: "a security
expert", "a performance analyst". Under a file-only rule every such
persona must be a file somebody wrote first, so a skill wanting five
of them needs five files shipped before it runs at all
([spec](../specifications/2026-08-22-subagents.md)).

Three constraints bear on how this can be added.

The record is the first. Continuing a subagent re-resolves its
definition from disk by `record.type` and refuses when there is no
file (`src/index.ts:725-731`), and `SubagentRecord` carries only that
type string (`src/registry.ts:44-50`). A subagent with no file behind
it would therefore be unreachable by `@handle` and unresumable —
which would make exactly the subagents this feature creates
second-class.

The schema is the second. The
[tool-naming ADR](2026-08-22-self-describing-tool-names.md) constrains
every future parameter to plain types and explicit enums, because
model providers differ in which JSON Schema features they accept. Two
mutually exclusive ways to start a subagent cannot be expressed as a
schema union.

Naming is the third, and it is a product requirement rather than a
technical one. The user's words: "I don't want naming these agents to
be the user's problem." Asking for five subagents that each attempt a
feature differently must produce five addressable subagents without
the user inventing five names.

## Decision

We will add three optional parameters to `spawn_subagent` —
`system_prompt`, `tools`, and `name`. Supplying `system_prompt` starts
a subagent that runs under it and nothing else, with no agent file
involved. `subagent_type` becomes optional, and the two routes are
made mutually exclusive by a runtime refusal rather than by the
schema.

A subagent's record will carry its own definition, so continuing one
does not depend on a file existing. Continuation will still prefer a
live agent file when there is one, so a file-backed subagent resumes
under its file's current frontmatter rather than the copy it started
with.

Naming a subagent is the main agent's job. The spawn tool's own
description directs it to invent a short distinct name for each
subagent it starts and never to ask the user for one. A name left out
falls back to a name derived from the description; a missing name is
never grounds for refusal.

A supplied name that matches an existing agent file is refused,
naming both routes so the caller can pick one.

> [!NOTE]
> Amended 2026-08-23, after the first live run, and this paragraph no
> longer holds. Asked for three reviewers, the main agent composed a
> security persona, named it `security`, and the call was refused
> because `.pi/agents/security.md` exists — so the user got two
> reviewers and an error where the one they had asked for by name
> should have been. The supplied character now wins and the spawn
> result names the file it shadowed, along with the tier that file came
> from. The mutual-exclusion refusal goes with it: `subagent_type`
> supplied alongside `system_prompt` is now read as the subagent's
> name, because it is a short word where the fallback is a slugged
> description, and because refusing cost a round trip for a call whose
> intent was never in doubt. That is not the silent substitution the
> fourth option below was rejected for: a `subagent_type` that names a
> real file is by definition a name that shadows one, so the result
> says the file was passed over.

We will not ship neutral `general` or `general-readonly` agent files.

## Options Considered

- **A persona supplied at spawn, named by its own field (chosen)** —
  the only option that lets a skill ask for a character it did not
  ship. A separate `name` field mirrors the shape of Claude Code's
  `Agent` tool, where the model supplies a short name alongside a
  longer description. Costs two name-ish fields on the tool where
  either may be blank.
- **Neutral `general` and `general-readonly` agent files, specialised
  entirely through the prompt** — agreed to first, then rejected. Once
  a supplied persona carries its own `tools` list, a neutral file adds
  nothing but a second way to do one thing: a skill wanting a
  read-only reviewer passes `tools: [read, grep, find, ls]` and is
  done.
- **Derive the handle from the description, adding no naming field** —
  the cheapest schema, and rejected on evidence. It cannot turn
  "Security and abuse review" into `@security`; it produces
  `@security-and-abuse-review`. A screenshot of Claude Code showed the
  short form is what the model produces when the schema asks it for
  one, so the intelligence was already available and only needed a
  field to put it in.
- **Reuse `subagent_type` for the short name, dual-purpose** — a file
  lookup when `system_prompt` is absent, an arbitrary label when it is
  present. One field instead of two, and no change to handle
  derivation, since the handle is already slugged from that field.
  Rejected because it overloads a field whose description promises a
  type that exists, and a model that supplies both would silently get
  the inline prompt instead of the file it named.

## Consequences

Easier: a skill can ask for any persona it can describe, and needs no
files of its own. A project with no agent files at all can now
delegate, so `buildToolDescription` must stop saying the tool cannot
be used yet and the matching refusal in `execute` must go.

> [!NOTE]
> Implemented 2026-08-23. That refusal moved rather than went. Naming a
> `subagent_type` in a project with no agent files is still an error —
> what changed is that it now says so and points at `system_prompt`.
> Deleting the guard outright left the call falling through to a
> generic "unknown type" message listing an empty set of known types,
> which is worse than what it replaced.

Harder, and accepted rather than mitigated: a supplied persona gives
up a review step. An agent file is written by a person, read before it
is used, and changed in one place for every subagent that runs from
it. A persona supplied at spawn is composed by a model, for one run,
and nobody reads it first. Two things bound it — the `tools`
parameter limits what such a subagent can do, and a shadowed agent
file is named in the spawn result, so a reviewed persona is never
replaced unnoticed. Neither restores the review.

New constraint: `AgentSource` gains a fourth value, `"inline"`, and it
is load-bearing rather than descriptive. Continuation branches on it
to decide whether to re-read a file or trust the record, so anything
that sets it wrongly makes a file-backed subagent resume under a
stale definition, or an inline one refuse to resume at all.

A handle derived from a description is deliberately ugly.
`@behaviour-and-tests-review` working is the success case: the
alternative is refusing the call, and a refusal invites the main agent
to recover by asking the user what to call things — the one outcome
this decision exists to prevent.

## Source

- [Implementation plan](../plans/2026-08-23-subagent-personas.md)
- [Specification](../specifications/2026-08-22-subagents.md)
