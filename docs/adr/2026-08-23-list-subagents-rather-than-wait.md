# List subagents rather than wait for them

- **Status**: Accepted
- **Date**: 2026-08-23
- **Deciders**: Integralist

## Context

A finished subagent delivers its answer into the conversation as a
follow-up with `triggerTurn: true` (`src/spawn.ts:203`), which is what
makes the main model act on the news rather than sit on it. Each
subagent does this for itself, so five subagents started together wake
the main model five times.

Some work needs them read as a set. The `code-review` skill spawns one
reviewer per dimension and collects every result before it spawns its
verifiers. On the first wakeup the main model is told about one
subagent and nothing else. The only way it can learn about the others
is to call `get_subagent_result` on each id in turn and read back
"still working" (`src/index.ts:484`) — and only if it still remembers
every id it was given. Four reviewers cost six such calls, and a lost
id silently degrades the review to three dimensions rather than
failing.

The information exists. Every record carries its handle, status, and
description (`src/registry.ts:44-52`), and the user can see all of it
in the list widget below the prompt
(`src/index.ts:59`). The main model is the one party that cannot.

## Decision

We will register a fifth tool, `list_subagents`, reporting every
subagent in the session with its handle, identifier, status, and
description. It is read-only and adds no state to the record.

## Options Considered

- **A `list_subagents` tool (chosen)** — the smallest change that
  removes the failure mode. One call per wakeup replaces one call per
  sibling, and the registry rather than the model's memory becomes the
  source of truth for what was started, so a dimension cannot be lost.
  Useful beyond the collecting case: it closes the gap between what
  the user can see and what the model can.
- **A `wait_for` parameter naming ids to wait on** — the nicest shape
  for the skill, which would be woken once, when the set is complete.
  Rejected on cost: a tool call that deliberately does not return has
  to agree with the concurrency queue (what if a slot never frees?),
  with the turn limit, and with cancellation. It trades a small
  read-only tool for a blocking one with several ways to hang.

  > [!NOTE]
  > Half-reversed 2026-08-23, after the first live run. Waiting is now
  > what `get_subagent_result` does for one id: a subagent still
  > working holds the call until it finishes. The rejection reasoning
  > was about the failure modes of a call that does not return, and
  > those are answered rather than avoided — the turn's own signal ends
  > a wait, a ten-minute cap ends one regardless, and a wait that ends
  > early is a tool result saying the subagent is still working, which
  > is exactly what the call used to return immediately. What is *not*
  > reversed is `wait_for` itself: no parameter names a set of ids, and
  > waiting on several still means waiting on them one at a time or
  > reading `list_subagents`.
- **Batching the completion notices** — hold a finished subagent's
  notice briefly to see whether others land, then deliver one message.
  Rejected because it is a timing guess: two finishing together and
  two not still wakes the model twice, and it leaves the model unable
  to *ask* what is outstanding, which is the actual gap.
- **Leaving it alone** — the model checks siblings one at a time and
  the skill absorbs it. Rejected because the wasted calls are the
  lesser problem; a lost id producing a quietly partial review is the
  real one, and no amount of care in the skill fixes it without a way
  to enumerate.

## Consequences

Easier: a skill can tell what is outstanding in one call, and can be
written to check the list rather than to remember ids.

Unchanged: the wake count. Five subagents still wake the main model
five times. This decision addresses what the model can *know* on each
wakeup, not how often it is woken — batching was the option that would
have addressed that, and it was rejected.

> [!NOTE]
> Amended 2026-08-23. The wake count is now four in that example, and
> fewer still in the case this was written for: a subagent whose answer
> is handed to a waiting `get_subagent_result` call is not announced as
> well, because the model has already been given it. The wakeups that
> remain are the ones nobody asked for, which is what a wakeup is for.

This amends the [tool-naming ADR](2026-08-22-self-describing-tool-names.md),
whose decision was four registered tools. It is now five, under the
same self-describing `verb_subagent` shape, and the module comment
naming four (`src/index.ts:5`) must be corrected with it.

New risk: `list_subagents` takes no arguments, so its parameter schema
is an empty object, and providers differ in what they accept — the
same concern that produced the plain-schema rule in the first place.
Loading the extension will not surface it; only a real call will. If a
provider rejects it, add one optional `status` filter rather than
inventing a required parameter.

> [!NOTE]
> Implemented 2026-08-23, and the risk stands unresolved — no real
> provider call has been made yet. A test now asserts the schema has no
> properties, so a parameter cannot creep in unnoticed; that guards the
> decision, not the compatibility. The first live run is what settles
> it.

## Source

- [Implementation plan](../plans/2026-08-23-subagent-personas.md)
- [Specification](../specifications/2026-08-22-subagents.md)
