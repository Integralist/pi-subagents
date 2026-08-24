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

Two gaps remain once such an extension exists. A subagent's character
must be a file somebody wrote first, so a skill wanting "a security
expert" or "a performance analyst" cannot ask for one — it can only
name a persona already on disk, and a skill needing five personas
needs five files before it runs at all.

The second gap is that the main agent cannot see the subagents it
started. It is told of each one finishing separately, and has no way
to ask what is still outstanding, so a skill that must collect
several results before acting has to remember every identifier
itself and ask after each in turn — and silently does less work when
it loses one.

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

The main agent can also supply a subagent's character as it starts
one: a system prompt, the tools it may use, and a short name to
address it by. The main agent chooses that name itself, so asking for
five subagents that each attempt a feature differently produces five
addressable subagents without the user naming any of them. Such a
subagent is not second-class — it appears in the list, it can be
watched and steered, and it can be reached by `@name` and continued
after it finishes.

A character may still come from a Markdown file instead, read from
the project, from the user's own directory, or from the set shipped
with the extension, so that installing the extension offers
something to delegate to before anything has been written.

The main agent can list every subagent in the session in one call, so
it can tell what is still running without asking after each one.

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
1. As a skill author, I want to give a subagent its character when I
   start it, so that I do not have to ship an agent file for every
   persona a skill might want.
1. As a developer, I want the main agent to name the subagents it
   starts, so that asking for five approaches does not make me
   invent five names.
1. As a developer, I want a subagent started from a supplied
   character to be addressable and resumable like any other, so that
   nothing about it is second-class.
1. As the main agent, I want to see every subagent and its status in
   one call, so that I can wait for a set of them to finish without
   losing track of one.
1. As a developer, I want an agent file I write to replace one
   shipped with the extension, so that I can adapt a shipped persona
   without editing the installed package.

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

  Scenario: Waits for a running subagent and answers when it finishes
    Given a running subagent
    When its result is requested
    Then the request does not answer while the subagent works
    And it returns the output as soon as the subagent finishes

  Scenario: Gives up waiting when the turn is abandoned
    Given a running subagent
    And its result has been requested
    When the turn is abandoned
    Then the reply says the subagent is still working

  Scenario: Gives up waiting after its own cap
    Given a running subagent
    When its result is requested
    And the subagent has not finished within the time the request waits
    Then the reply says the subagent is still working

  Scenario: Does not also announce an answer that was waited for
    Given a running subagent whose result has been requested
    When the subagent finishes
    Then its answer is returned to the request
    And no completion notice is delivered for it

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

  Scenario: Offers a prompt without asking for one
    Given a subagent's conversation is shown
    Then a prompt to steer it is on screen
    And the keys it takes are named beside it

  Scenario: Steers from the open view
    Given a subagent's conversation is shown
    When the user types a message and submits it
    Then the message is sent into that subagent's conversation

  Scenario: Shows no prompt for a subagent that has finished
    Given a finished subagent's conversation is shown
    Then no prompt to steer it is on screen

  Scenario: Stays open when the subagent finishes
    Given a subagent's conversation is shown
    When that subagent finishes
    Then its conversation is still shown
    And its final output is visible

Feature: Starting a subagent with a supplied character
  As a skill author
  I want to give a subagent its character when I start it
  So that every persona need not be a file written in advance

  Scenario: Runs from the supplied character
    When the main agent starts a subagent supplying a system prompt
    Then the subagent runs under that system prompt
    And no agent file takes part in the run

  Scenario: Needs no agent file of that name
    Given no agent file named "performance-analyst" exists
    When the main agent starts a subagent named "performance-analyst"
      supplying a system prompt
    Then the subagent starts

  Scenario: Limits it to the tools named
    When the main agent starts a subagent supplying a system prompt
      and a list of tools
    Then the subagent has those tools and no others

  Scenario: Takes the supplied name as its handle
    When the main agent starts a subagent supplying a system prompt
      and the name "security"
    Then the subagent is addressable as "security"

  Scenario: Falls back to the description when no name is supplied
    When the main agent starts a subagent supplying a system prompt
      and a description but no name
    Then the subagent starts
    And it is addressable under a handle derived from its description

  Scenario: Distinguishes subagents given the same name
    When the main agent starts 5 subagents, each supplying a system
      prompt and all supplying the same name
    Then all 5 subagents are addressable under distinct handles

  Scenario: Runs the supplied character under a name an agent file
      already uses
    Given an agent file named "security" exists
    When the main agent starts a subagent named "security" supplying
      a system prompt
    Then the subagent runs under that system prompt
    And it is addressable as "security"
    And the result says an agent file of that name was passed over

  Scenario: Says nothing about agent files when no name is shadowed
    Given no agent file named "security" exists
    When the main agent starts a subagent named "security" supplying
      a system prompt
    Then the result mentions no agent file

  Scenario: Prefers the supplied character to the type named
      alongside it
    When the main agent starts a subagent naming a subagent type and
      supplying a system prompt
    Then the subagent runs under that system prompt
    And it is addressable under the type it named

  Scenario: Gives it a colour from the palette
    When the main agent starts a subagent supplying a system prompt
    Then its row is rendered in a colour from the palette

  Scenario: Refuses to start a subagent from inside a subagent
    Given a running subagent
    When that subagent attempts to start a subagent of its own,
      supplying a system prompt
    Then the call fails
    And no subagent starts

Feature: Continuing a subagent that was given its character
  As a developer
  I want a supplied-character subagent to resume like any other
  So that nothing about it is second-class

  Scenario: Continues under the character it was given
    Given a finished subagent that was started with a supplied
      system prompt
    When the user submits a message addressed to its handle
    Then it continues under that same system prompt and those same
      tools
    And its earlier turns are still in its context

  Scenario: Reads the agent file again when there is one
    Given a finished subagent that was started from an agent file
    And that file's frontmatter has changed since it ran
    When the user submits a message addressed to its handle
    Then it continues under the file's current frontmatter

  Scenario: Refuses when a file-backed agent's file is gone
    Given a finished subagent that was started from an agent file
    And that file has since been deleted
    When the user submits a message addressed to its handle
    Then the reply says there is no agent file of that name
    And the subagent does not run again

Feature: Listing the session's subagents
  As the main agent
  I want to see every subagent in one call
  So that I can wait for a set of them without losing track of one

  Scenario: Lists every subagent and its state
    Given 4 subagents in this session
    When the main agent lists the subagents
    Then all 4 are listed
    And each entry gives its handle, its identifier, its status, and
      its description

  Scenario Outline: Includes subagents in every state
    Given a subagent that is <state>
    When the main agent lists the subagents
    Then that subagent is listed as <state>

    Examples:
      | state     |
      | queued    |
      | running   |
      | completed |
      | failed    |
      | stopped   |

  Scenario: Reports a session with no subagents
    Given no subagents have been started
    When the main agent lists the subagents
    Then the reply says there are none

  Scenario: Changes nothing
    Given 3 running subagents
    When the main agent lists the subagents
    Then all 3 subagents are still running
    And no subagent's conversation has changed

Feature: Discovering agent files
  As a developer
  I want my own agent files to take precedence
  So that I can adapt a shipped persona without editing the package

  Scenario: Prefers the project's agent to the user's own
    Given the user's directory defines an agent named "explore"
    And the project defines an agent named "explore"
    When the main agent is offered the agents for this session
    Then one agent named "explore" is offered
    And it is the project's

  Scenario: Prefers the user's own agent to the shipped one
    Given an agent named "explore" ships with the extension
    And the user's directory defines an agent named "explore"
    When the main agent is offered the agents for this session
    Then one agent named "explore" is offered
    And it is the user's

  Scenario: Offers the shipped agents when none are written
    Given the user's directory defines no agents
    And the project defines no agents
    When the main agent is offered the agents for this session
    Then the agents shipped with the extension are offered

  Scenario: Ignores a malformed file without hiding its siblings
    Given a directory holding one malformed agent file and 2 valid
      ones
    When the main agent is offered the agents for this session
    Then the 2 valid agents are offered
    And no error is raised

  Scenario: Finds the project's agents from a subdirectory
    Given the project defines an agent named "explore"
    And the session's working directory is deep inside the project
    When the main agent is offered the agents for this session
    Then "explore" is offered
```

## Testing Seams

- **Tool boundary** — the `execute()` function of each registered
  tool, called with a fake extension context and a stubbed session
  factory. Covers starting, steering, stopping, collecting, the
  concurrency queue, turn limits, failure containment, and
  persistence. Also covers a supplied character in full — the system
  prompt, the tool restriction, the name and its fallback, the
  collision refusal, the recursion guard — and all of listing.
  Chosen because it is the highest point that carries all
  agent-facing behaviour without needing a real model.
- **Input handler** — the handler Pi calls with submitted prompt text,
  asserting on the routing decision it returns. Covers every `@name`
  case, continuation included: a subagent resuming under a character
  it was given, one resuming under its file's current frontmatter,
  and one whose file has gone. Chosen because mention routing is
  decided entirely here.
- **Subagent list** — the list component constructed with fake
  subagent records and driven with real key escape sequences,
  asserting on rendered rows with colour codes stripped. Covers
  layout, columns, navigation, colours, and context-window display.
  Chosen over a data-only view model because wrong key wiring is the
  most likely fault and only this seam catches it.

Two things also get direct unit tests, being self-contained with
enough edge cases to earn them: fuzzy model-name resolution, and
agent discovery — two tiers, name collisions, malformed files, and
the walk up to the project's agent directory. Discovery's tests
include a pass over the example agents in `examples/`, which is what
catches an example file that fails to parse, names a tool Pi does not
have, or names a model that would refuse the spawn.

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
- **Five tools are registered**: `spawn_subagent`, `steer_subagent`,
  `stop_subagent`, `get_subagent_result`, `list_subagents`. Names are
  self-describing rather than borrowed, because the models in use
  have no prior familiarity with a borrowed convention.
- **Tool parameters follow the established shape**: `subagent_type`,
  `prompt`, `description`, `model`, `thinking`. These are proven and
  cost nothing to adopt.
- **A supplied character is three more parameters on the spawn
  tool**: a system prompt, a list of tools, and a name. All are
  optional, and supplying the system prompt is what makes a subagent
  run without an agent file. A character is not composed from both
  sources: either the file supplies it or the call does, and a
  supplied system prompt is always the one that wins. A subagent type
  named alongside one is read as the subagent's name, never as a
  second source of character.
- **Naming a subagent is the main agent's job, never the user's.**
  The spawn tool's own description directs the main agent to invent a
  short distinct name for each subagent it starts and never to ask
  the user for one. A name that is left out is derived from the
  description instead; a missing name is never grounds for refusal,
  because a refusal invites the main agent to recover by asking the
  user, which is the outcome being avoided. Names collide harmlessly:
  the second subagent to want a taken handle is given a numbered one.
- **A name that an agent file already uses is reported, not
  refused.** The supplied character runs, under the name it was
  given, and the spawn result names the file that was passed over and
  which tier it came from. An agent file is something a person wrote
  and can inspect, so shadowing one silently is what must not happen;
  refusing the call is a heavier answer to that than saying so.

> [!NOTE]
> Amended 2026-08-23, after the first live run. This was a refusal.
> The user asked for a security reviewer, the main agent composed one
> and named it `security`, a project agent file of that name existed,
> and the subagent the user had asked for never started — the
> protection cost the thing it was protecting. The same run showed the
> sibling refusal costing the same way, so naming a type alongside a
> supplied prompt is now the name rather than an error.
- **A subagent's record carries its own character** — prompt, tools,
  model, effort, turn limit — so that continuing one does not depend
  on a file existing. Continuation still prefers a live agent file
  when there is one, so a file-backed subagent resumes under its
  file's current frontmatter rather than the copy it started with;
  the stored character is what a subagent with no file behind it
  resumes under.
- **Where a character came from is recorded alongside it**, as a
  fourth origin beside the project, the user's directory, and the
  set shipped with the extension.
- **`list_subagents` is read-only and adds no state**, reporting each
  subagent's handle, identifier, status, and description from what
  the registry already holds. It exists because the user can see
  this list in the interface and the main agent cannot, so a skill
  collecting several results has no way to ask what is outstanding.
- **Asking for a result waits for it.** A request for a subagent that
  is still working does not answer until the subagent finishes, so a
  main agent with nothing else to do spends one turn rather than one
  turn per question. Three things end a wait: the subagent finishing,
  the turn being abandoned, and a cap the request holds itself to. An
  answer handed back this way is not also announced as a completion
  notice, or the same text reaches the conversation twice.

> [!NOTE]
> Amended 2026-08-23, after the first live run. Reporting "still
> working" and returning was what the specification asked for, and
> what the model did with it was ask again, and again, and again —
> each question re-sending the whole conversation to the provider. The
> notice arriving on its own is still the ordinary path; waiting is
> for the caller that has run out of other work.
- **No neutral agent files are shipped.** A character supplied at
  spawn time already carries its own prompt and tools, so a
  general-purpose file to specialise through the prompt would be a
  second way to do one thing.
- **A supplied character gives up a review step, knowingly.** An
  agent file is written by a person, read before it is used, and
  changed in one place for every subagent that runs from it. A
  character supplied at spawn time is composed by a model, for one
  run, and nobody reads it first. That is the cost of letting a skill
  ask for a persona it did not ship, and it is accepted rather than
  mitigated: the tool restriction is what bounds what such a subagent
  can do, and reporting a shadowed agent file is what keeps a
  reviewed persona from being replaced unnoticed.
- **Tool parameter schemas use plain types and explicit enums only.**
  No union or conditional schema constructs, because model providers
  differ in which schema features they accept.
- **Model names resolve fuzzily** against configured models, so a
  partial name selects a configured model, and an unmatched name
  fails with the list of what is available.
- **Effort level is passed through to the session** and clamped by Pi
  to what the chosen model supports.
- **Subagents may be defined as Markdown files with YAML
  frontmatter**, discovered from two places: the user's own directory
  (`~/.pi/agent/agents/`) and the project (`<project>/.pi/agents/`).
  This format is shared by every existing implementation. Example
  agent definitions live in `examples/` and can be copied into
  either directory.
- **Nearer definitions win a name collision**, the project beating
  the user's directory, so a persona can be adapted by writing a file
  in `.pi/agents/` rather than modifying user-wide agents.

> [!NOTE]
> Updated 2026-08-24. The built-in tier was removed so that installed
> extensions do not introduce standing tool choices that compete with
> personas described dynamically at spawn time. Shipped personas moved
> to `examples/`.
- **Discovery never throws.** It runs before the main agent can offer
  any subagent at all, so one unreadable or malformed file must not
  hide every other agent beside it.
- **Subagents run in the background by default**, reporting
  completion back into the main conversation as a follow-up message
  that triggers a turn.
- **Colours are assigned deterministically** from a fixed palette, so
  a subagent keeps its colour for its whole life.
- **The subagent list captures arrow keys only when the prompt is
  empty**, so ordinary typing is never intercepted. Key *releases* are
  ignored: the list reads the keyboard through an input listener rather
  than as a focused component, and pi filters releases only for the
  latter — so under a terminal running the Kitty keyboard protocol one
  press would otherwise move the selection twice.
- **The open conversation is a constant height** for as long as it is
  open. Pi renders the screen differentially and skips the pass that
  clears uncovered rows while an overlay is up, so a panel that grew
  and shrank with its transcript would leave its taller self behind.
- **The open conversation is drawn as a framed panel with a prompt of
  its own.** Pi's overlays carry no border, and without one the panel
  reads as more of the conversation underneath it; the frame's rails
  carry the subagent's name and the keys, so neither can be pushed
  off screen by the transcript. The prompt is on screen for as long
  as the subagent can be reached, rather than behind a keypress:
  typing goes to it, enter sends, escape clears it and then closes
  the view, and stopping moves to `ctrl+x` so that no key which edits
  a message can also halt the subagent it is being typed to.

> [!NOTE]
> Added 2026-08-23, after the first live run. The panel had neither —
> the user could not tell where the overlay began, and asked whether
> steering was meant to happen through `@handle` from the main prompt.
> It was on `enter`, and nothing on screen said so.
>
> Extended 2026-08-24, after the run that followed. The prompt was
> drawn and still could not be seen: the panel sized itself to the
> terminal while its overlay was told it could have a fraction of one,
> and pi slices an overlay that overruns its height from the bottom —
> taking the prompt and the keys, the last rows drawn. The panel is now
> given the rows its overlay will actually show, from the same constant
> that sizes the overlay, and fills them exactly.

## Out of Scope

- Nested subagents — a subagent starting its own children.
- Scheduled or recurring subagents.
- Git worktree isolation per subagent.
- Persistent per-subagent memory across sessions.
- Scripted or declarative multi-agent workflows.
- An API for other extensions to drive subagents.
- Running subagents as separate processes.
- Subagents surviving the host session's exit.
- Composing a character from both an agent file and a supplied
  prompt — layering, overriding, or inheriting one from the other.
- Letting the main agent choose a subagent's colour.
- A way for the main agent to wait until a named set of subagents has
  finished. Listing them is what this specifies instead.
- Saving a supplied character to an agent file for reuse.

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
- Whether a list row should show a supplied character's opening line
  in place of the description. Another implementation does, and a
  description of three to five words says less about a subagent than
  its first sentence. Assumed no, so that both kinds of subagent read
  alike in the list.
- Whether an unrecognised tool name in a supplied list should refuse
  the spawn. Assumed not: it is dropped with a warning naming it,
  which is what already happens for a tool an agent file names in
  error. Consistency is the only argument either way.
