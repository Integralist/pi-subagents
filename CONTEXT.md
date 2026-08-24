# Context

The words this project uses, and what each one means in the code. One name per
idea: where a term appears here, it is the term used in identifiers, comments,
tests and messages.

## The domain

**Subagent** — a nested pi `AgentSession` created inside the host process, with
an agent file's system prompt in place of pi's own. Not a process, not a thread,
and never "child agent" or "worker". The thing it does is *delegation*; a
subagent is what the work is delegated to.

**Agent file** — the Markdown file with YAML frontmatter that defines a kind of
subagent: `.pi/agents/explore.md`. Its parsed form is an `AgentConfig`. The
`name` in its frontmatter is the **agent type**, which is what the main model
names when it delegates. An agent file is a definition; a subagent is a run of
one.

**Tier** — one of the two directories agent files are read from, in order:
**user** (`~/.pi/agent/agents/`) and **project** (`<project>/.pi/agents/`).
The project tier wins a name collision, so a project file replaces a user one.
A record's `source` names the tier its agent file came from.

**Main model** — the model in the user's own conversation, as distinct from a
subagent's. Its conversation is the **main conversation**, and `@main` is the
reserved handle that addresses it. Never "parent agent" for the model, though
the session that spawned a subagent is fairly called its **parent session**.

## Identity

**Record** (`SubagentRecord`) — everything known about one subagent: its id,
handle, type, description, status, colour, turn count, context use, and outcome.
The record is the subagent as far as the rest of the code is concerned; the
session is an implementation detail hanging off it.

**Registry** (`SubagentRegistry`) — the one place that knows a subagent exists.
Every write goes through `update()`, which notifies watchers; mutating a record
found with `get()` works and notifies nobody, which is the bug the door exists to
prevent.

**Id** — a UUID, assigned at spawn. What the *tools* speak in, because it is
stable and unambiguous, and what the main model is given.

**Handle** — the human name for the same subagent: the agent type lowercased and
slugged, numbered from `-2` on a collision. `explore`, `explore-2`,
`code-reviewer`. What the *user* speaks in — the list, the open conversation, and
`@handle` at the prompt. `main` is reserved and never handed out.

**Description** — the few words about the task that appear on the subagent's row.
Supplied by the main model when it delegates, or the first line of the message
when a subagent is started by a mention.

## A subagent's life

**Status** — one of `queued`, `running`, `completed`, `failed`, `stopped`. The
last three are **terminal**: a subagent does not come back from them, though a
terminal one can be *resumed*, which puts it back to `queued`.

**Queued** — accepted and recorded, but waiting for a slot. **Slot** is what the
**queue** hands out, one per concurrently running subagent, up to the
**concurrency limit**.

**Outcome** (`SubagentOutcome`) — how a run ended, read off the finished
transcript: a status, the output text, and a reason when it failed. The record's
status mirrors it.

**Completion notice** — the message delivered into the main conversation when a
subagent finishes, so its answer arrives as news rather than as something the
main model had to ask for. Delivered as a follow-up.

## Doing things to a subagent

**Spawn** — start a new subagent from an agent file. **Resume** — put a finished
one back to work from its stored transcript, keeping its record and its handle.
A resume whose stored transcript has gone **starts fresh**, and says so.

**Steer** — send a message to a subagent that is already under way, landing after
its current turn and before its next model call. Not "interrupt", which sounds
like stopping, and not "prompt", which is what the *first* message is called. A
message steered at a subagent that has not started yet waits on its record as
**pending** and joins the task it starts on.

**Stop** — halt a subagent, keeping whatever it had worked out. Its output is
then **incomplete**, which the notice says out loud. Distinct from *failing*,
which is a subagent that broke rather than one that was cut short.

**Wrap-up** — the message a subagent gets on reaching its **turn limit**, telling
it to give its final answer now. It then has **grace turns** to do so before it
is stopped. The point of the warning is that a confused subagent returns a usable
answer instead of a truncated one.

## On screen

**The list** — the rows under the prompt, one per subagent worth showing:
everything not yet finished, plus anything that finished recently enough to still
be read. It **lingers** a finished row rather than dropping it at once. Five rows
to a **column**, and a narrow terminal gets one tall column instead of several
useless ones.

**Selection** — the row the arrow keys are on, held as an id rather than a
position, because rows move as subagents come and go.

**Viewer** (`SubagentViewer`) — the panel that opens over the session showing one
subagent's conversation, and the **composer** is the single-line input it opens
for steering. The conversation itself is a **transcript**, drawn with pi's own
message components so it reads exactly like the session around it.

**Context use** — how much of its context window a subagent has consumed, as a
percentage. `null` means nobody knows yet, which the list draws as a blank rather
than as `0%`.

## Addressing

**Mention** — a leading `@handle` followed by a message. It **routes** to that
subagent; anything else is a **passthrough** and reaches the main model
untouched. A leading `@main` is the **escape**: it strips itself, and the space
after it, and passes the rest through — which is how text that opens with a
mention reaches the main model.

## Words this project avoids

| Not this       | This                   | Why                                          |
| -------------- | ---------------------- | -------------------------------------------- |
| child agent    | subagent               | One name for the thing, everywhere           |
| task, job      | subagent, run          | Both mean too many other things              |
| kill, cancel   | stop                   | The user's word, and it keeps partial output |
| interrupt      | steer                  | Steering does not end the run                |
| worker, thread | subagent               | It is a session, not a unit of execution     |
| agent          | subagent \| agent file | "Agent" alone hides which one is meant       |
