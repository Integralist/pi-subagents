# Pi Subagents — Specification

- **Status**: Draft
- **Author**: Integralist
- **Created**: 2026-08-22
- **Language**: TypeScript

## Problem Statement

Pi has no built-in way to delegate work to a focused child agent. A
single session carries every task in one context window, so long
investigations crowd out the work that follows them, and independent
tasks that could run at the same time run one after another.

Two community extensions solve this, but neither fits. One runs each
child as a separate `pi` process, which makes watching and steering a
running child expensive to build. The other runs children in-process
with a rich UI, but bundles scheduling, nested agents, worktrees, and
memory scopes that are not wanted here.

## Solution

An extension that lets the main agent start focused subagents, and
lets the user watch and redirect them while they work.

The main agent starts a subagent with a task, optionally choosing a
model and effort level. Subagents run in the background. A list below
the prompt shows each running subagent, its colour, and how much of
its context window it has used. The user moves through that list with
the arrow keys, opens one, watches it work, and types to redirect it.
Typing `@name` at the main prompt sends a message straight to a named
subagent without spending a turn in the main conversation.

A subagent that fails does not disturb the main session. It becomes a
failed row in the list.

## User Stories

1. As a developer, I want the main agent to delegate a task to a
   focused subagent, so that a long investigation does not consume my
   main context window.
1. As a developer, I want several subagents working at once, so that
   independent tasks finish sooner.
1. As a developer, I want to see every running subagent and its
   context-window use at a glance, so that I know what is happening
   and what is close to its limit.
1. As a developer, I want to open a subagent and watch it work, so
   that I can judge whether it is on the right track.
1. As a developer, I want to redirect a running subagent by typing to
   it, so that I do not have to stop it and start again.
1. As a developer, I want to address a subagent by name from the main
   prompt, so that I can reach it without spending a main-model turn.
1. As a developer, I want a subagent's failure contained, so that a
   crash never takes down my session.
1. As a developer, I want to choose a subagent's model and effort, so
   that cheap work runs on a cheap model.

## Acceptance Criteria

```gherkin
Feature: Starting a subagent
  As a developer
  I want the main agent to delegate work to a focused child
  So that my main context window stays clear

  Scenario: Inherits the parent model and effort by default
    Given the main session runs a model with a medium effort level
    When the main agent starts a subagent without naming a model
    Then the subagent runs the same model at the same effort level

  Scenario: Honours an explicit model and effort
    Given the main session runs a large model
    When the main agent starts a subagent naming a small model
      and a low effort level
    Then the subagent runs the small model at the low effort level

  Scenario: Resolves a partial model name
    Given a model whose full identifier contains "flash" is configured
    When the main agent starts a subagent naming the model "flash"
    Then the subagent runs that configured model

  Scenario: Refuses an unknown model name
    When the main agent starts a subagent naming a model that is not
      configured
    Then the call fails with a message listing the configured models
    And no subagent starts

  Scenario: Refuses an unknown subagent type
    When the main agent starts a subagent of a type that does not exist
    Then the call fails with a message listing the known types
    And no subagent starts

Feature: Limiting how many subagents run at once
  As a developer
  I want a cap on simultaneous subagents
  So that a burst of delegation does not exhaust my rate limit

  Scenario: Runs up to the limit
    Given the concurrency limit is 3
    When the main agent starts 3 subagents
    Then all 3 subagents are running

  Scenario: Queues past the limit
    Given the concurrency limit is 3
    And 3 subagents are running
    When the main agent starts a fourth subagent
    Then the fourth subagent is queued
    And the subagent list shows one queued subagent

  Scenario: Starts a queued subagent when a slot frees
    Given the concurrency limit is 3
    And 3 subagents are running and 1 is queued
    When a running subagent finishes
    Then the queued subagent starts

Feature: Bounding a subagent's run length
  As a developer
  I want a turn limit with a warning before it bites
  So that a confused agent returns a usable answer, not a truncated one

  Scenario: Warns the subagent at its turn limit
    Given a subagent with a turn limit of 5
    When the subagent completes its fifth turn
    Then the subagent receives a message telling it to give its final
      answer now
    And the subagent is still running

  Scenario: Returns the wrap-up answer
    Given a subagent that has been warned to wrap up
    When the subagent gives a final answer on its next turn
    Then the subagent finishes normally
    And its result is that final answer

  Scenario: Stops a subagent that ignores the warning
    Given a subagent with a turn limit of 5 and a grace of 3 turns
    And the subagent has been warned to wrap up
    When the subagent completes its eighth turn without finishing
    Then the subagent is stopped
    And its result is marked as incomplete

Feature: Containing a subagent failure
  As a developer
  I want a subagent crash kept away from my session
  So that my own work is never lost

  Scenario: Reports a failing subagent as failed
    Given a running subagent
    When the subagent throws an error
    Then the subagent is marked as failed in the list
    And the failure reason is available to the main agent

  Scenario: Leaves the main session working
    Given a running subagent
    When the subagent throws an error
    Then the main session is still accepting input

  Scenario: Leaves sibling subagents working
    Given 3 running subagents
    When one subagent throws an error
    Then the other 2 subagents are still running

Feature: Steering, stopping, and collecting
  As a developer
  I want to redirect, halt, and read back from subagents
  So that I stay in control of delegated work

  Scenario: Redirects a running subagent
    Given a running subagent
    When a steering message is sent to it
    Then the message appears in that subagent's conversation
    And the subagent continues from that message

  Scenario: Refuses to steer a finished subagent
    Given a finished subagent
    When a steering message is sent to it
    Then the call fails with a message saying the subagent has finished

  Scenario: Halts a running subagent
    Given a running subagent
    When it is stopped
    Then the subagent is marked as stopped
    And its partial output is available

  Scenario: Returns a finished subagent's output
    Given a finished subagent
    When its result is requested
    Then the full output text is returned

  Scenario: Reports a running subagent as unfinished
    Given a running subagent
    When its result is requested
    Then the reply says the subagent is still running
    And no output text is returned

Feature: Keeping a subagent's conversation
  As a developer
  I want finished subagents kept on disk
  So that I can pick a conversation back up later

  Scenario: Keeps a finished subagent's conversation
    Given a subagent that has finished
    Then its conversation is stored on disk

  Scenario: Continues a stored conversation
    Given a subagent that finished earlier in this session
    When it is started again with a new message
    Then it continues its earlier conversation
    And its earlier turns are still in its context

  Scenario: Starts fresh when the conversation is gone
    Given a subagent whose stored conversation has been deleted
    When it is started again with a new message
    Then a new subagent starts with no earlier context
    And the reply says the earlier conversation was not found

Feature: Addressing a subagent from the main prompt
  As a developer
  I want to type @name to reach a subagent
  So that I do not spend a main-model turn to talk to it

  Scenario Outline: Routes by the subagent's state
    Given a subagent named "explore" that is <state>
    When the user submits "@explore look at the auth path"
    Then the message <outcome>
    And no main-model turn is taken

    Examples:
      | state         | outcome                                    |
      | running       | is sent into its conversation              |
      | queued        | is sent into its conversation              |
      | finished      | resumes it from its stored conversation    |
      | never started | starts it with that message as its task    |

  Scenario: Treats a bare handle as ordinary text
    Given a running subagent named "explore"
    When the user submits "@explore"
    Then the text goes to the main model unchanged

  Scenario: Ignores a mention that is not leading
    Given a running subagent named "explore"
    When the user submits "ask @explore about this"
    Then the text goes to the main model unchanged

  Scenario: Escapes routing with @main
    Given a running subagent named "explore"
    When the user submits "@main @explore is just text"
    Then the text goes to the main model with "@main " removed

  Scenario: Leaves an unknown handle alone
    Given no subagent named "nosuch"
    When the user submits "@nosuch hello"
    Then the text goes to the main model unchanged

Feature: Showing the subagent list
  As a developer
  I want every subagent visible below my prompt
  So that I can see progress without leaving the prompt

  Scenario: Shows each subagent with its context use
    Given 3 running subagents
    Then the list shows 3 rows below the prompt
    And each row shows its subagent's name
    And each row shows its context-window use as a percentage

  Scenario: Gives each subagent its own colour
    Given 3 running subagents
    Then each row is rendered in a different colour

  Scenario Outline: Splits into columns past five subagents
    Given <count> running subagents
    Then the list has <columns> columns
    And the first column has <first> rows

    Examples:
      | count | columns | first |
      |     3 |       1 |     3 |
      |     5 |       1 |     5 |
      |     6 |       2 |     5 |
      |    10 |       2 |     5 |

  Scenario: Enters the list from an empty prompt
    Given 3 running subagents
    And the prompt is empty
    When the user presses the down arrow
    Then the first row is selected

  Scenario: Moves down the list
    Given the first row is selected
    When the user presses the down arrow
    Then the second row is selected

  Scenario: Moves between columns
    Given 10 running subagents
    And the first row of the first column is selected
    When the user presses the right arrow
    Then the first row of the second column is selected

  Scenario: Leaves the list
    Given a row is selected
    When the user presses escape
    Then no row is selected
    And the prompt has focus

  Scenario: Ignores arrows when the prompt has text
    Given 3 running subagents
    And the prompt contains "hello"
    When the user presses the down arrow
    Then no row is selected

  Scenario: Opens a subagent
    Given a row is selected
    When the user presses enter
    Then that subagent's conversation is shown
    And it updates as the subagent works

  Scenario: Steers from the open view
    Given a subagent's conversation is shown
    When the user types a message and submits it
    Then the message is sent into that subagent's conversation

  Scenario: Stays open when the subagent finishes
    Given a subagent's conversation is shown
    When that subagent finishes
    Then its conversation is still shown
    And its final output is visible
```

## Testing Seams

- **Tool boundary** — the `execute()` function of each registered
  tool, called with a fake extension context and a stubbed session
  factory. Covers starting, steering, stopping, collecting, the
  concurrency queue, turn limits, failure containment, and
  persistence. Chosen because it is the highest point that carries all
  agent-facing behaviour without needing a real model.
- **Input handler** — the handler Pi calls with submitted prompt text,
  asserting on the routing decision it returns. Covers every `@name`
  case. Chosen because mention routing is decided entirely here.
- **Subagent list** — the list component constructed with fake
  subagent records and driven with real key escape sequences,
  asserting on rendered rows with colour codes stripped. Covers
  layout, columns, navigation, colours, and context-window display.
  Chosen over a data-only view model because wrong key wiring is the
  most likely fault and only this seam catches it.

Fuzzy model-name resolution also gets direct unit tests; it is
self-contained and has enough edge cases to earn them.

## Implementation Decisions

- **Subagents run inside the host process.** Each is a nested agent
  session created through the Pi SDK, not a separate `pi` process.
  Chosen because steering, live output, context-window readings, and
  model changes are direct calls on a session object, and rebuilding
  them over inter-process channels is the bulk of the alternative's
  cost.
- **Every subagent's execution is wrapped so failures are caught at
  its boundary** and recorded as a failed subagent. No subagent error
  may reach the host session's error handling. This is a requirement,
  not a quality goal, because the in-process choice above is what
  makes it necessary.
- **A recursion guard prevents a subagent from gaining the spawn
  tools.** Nested delegation is out of scope, so a subagent's session
  is built without them.
- **Four tools are registered**: `spawn_subagent`, `steer_subagent`,
  `stop_subagent`, `get_subagent_result`. Names are self-describing
  rather than borrowed, because the models in use have no prior
  familiarity with a borrowed convention.
- **Tool parameters follow the established shape**: `subagent_type`,
  `prompt`, `description`, `model`, `thinking`. These are proven and
  cost nothing to adopt.
- **Tool parameter schemas use plain types and explicit enums only.**
  No union or conditional schema constructs, because model providers
  differ in which schema features they accept.
- **Model names resolve fuzzily** against configured models, so a
  partial name selects a configured model, and an unmatched name
  fails with the list of what is available.
- **Effort level is passed through to the session** and clamped by Pi
  to what the chosen model supports.
- **Subagents are defined as Markdown files with YAML frontmatter**,
  discovered from project and user directories. This format is shared
  by every existing implementation.
- **Subagents run in the background by default**, reporting
  completion back into the main conversation as a follow-up message
  that triggers a turn.
- **Colours are assigned deterministically** from a fixed palette, so
  a subagent keeps its colour for its whole life.
- **The subagent list captures arrow keys only when the prompt is
  empty**, so ordinary typing is never intercepted.

## Out of Scope

- Nested subagents — a subagent starting its own children.
- Scheduled or recurring subagents.
- Git worktree isolation per subagent.
- Persistent per-subagent memory across sessions.
- Scripted or declarative multi-agent workflows.
- An API for other extensions to drive subagents.
- Running subagents as separate processes.
- Subagents surviving the host session's exit.

## Research

- [Pi extensions and subagent implementations](../research/2026-08-22-pi-extensions-and-subagents.md)

## Open Questions

- Live model change on an already-running subagent is wanted but not
  required. It is planned as the last, droppable slice. Whether a
  change applied at the next turn boundary is good enough, or whether
  it needs to interrupt the current turn, is unresolved.
- The default concurrency limit is unset. A starting value of 5 is
  assumed, matching the point at which the list gains a second column.
- Whether stored subagent conversations should appear in Pi's own
  session picker is unresolved. Assumed yes, as a consequence of
  writing them to the normal session directory.
