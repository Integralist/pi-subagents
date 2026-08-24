# pi-subagents

A [pi](https://github.com/earendil-works/pi) extension that delegates work to
focused subagents. Each one runs as a nested session inside the same process,
with its own system prompt, its own tools, and its own context window — so a
long investigation costs the main conversation one line instead of ten thousand
tokens.

A list under the prompt shows every subagent and how much of its context it has
used. Arrow keys move through it, enter opens one to watch it work, and typing
`@name` at the prompt sends a message straight to it without spending a
main-model turn.

```txt
… explore   look at the auth path        12%
… reviewer  review src/queue.ts         31%
✓ scribe    document the queue          18%
```

## Requirements

- Node 22.19 or newer
- pi installed and authenticated against at least one model

## Try it in one command

From a clone of this repository:

```bash
make install   # npm install
make try       # opens pi with this extension loaded
```

`make try` runs `pi -e ./src/index.ts`, which loads the extension for that
session only and leaves your settings untouched. Ask the main model to
_"use the explore subagent to find where agent discovery happens"_ and watch the
list appear under the prompt.

## Install it for real

`-e` is per-session. To keep the extension, install it as a package — from the
remote, or from a clone:

```bash
pi install git:github.com/Integralist/pi-subagents      # every project
pi install git:github.com/Integralist/pi-subagents -l   # this project only
pi install .                                            # or from a clone
```

| Command                      | Effect                                          |
| ---------------------------- | ----------------------------------------------- |
| `pi list`                    | Show what is installed, and in which scope      |
| `pi update <source>`         | Pull new commits                                |
| `pi remove <source>`         | Uninstall                                       |
| `pi install <source>@v0.1.0` | Pin a tag, branch or commit; stops auto-updates |

pi reads the `pi.extensions` field of `package.json`, so it picks up
`./src/index.ts` on its own. There is no build step and nothing to vendor: pi's
extension loader resolves `@earendil-works/*` and `typebox` to its own copies,
so an installed extension needs no `node_modules` of its own.

The agents in `examples/` can be copied in — see below.

## Testing your copy

```bash
make verify
```

That is the four checks this repository holds itself to:

| Target            | What it does                                     |
| ----------------- | ------------------------------------------------ |
| `make test`       | 587 tests under `vitest`                         |
| `make typecheck`  | `tsc --noEmit`                                   |
| `make lint`       | `biome check src test`                           |
| `make load-check` | loads the extension through pi's own jiti loader |

`make load-check` earns its place: vitest resolves imports its own way, so a
green suite does not prove pi can load the extension at all. `make watch` reruns
the tests as you edit, and `make` on its own lists every target.

## Example agents

Nine example agent files live in `examples/` as starting points. Discovery
reads two directories, project overriding user on a name collision:

1. `~/.pi/agent/agents/*.md` — yours, in every project
1. `<project>/.pi/agents/*.md` — this checkout's

To use the examples in your project, copy them into `.pi/agents/`:

```bash
make agents   # copies examples/*.md into .pi/agents/ (keeps existing files)
```

Or copy one into `~/.pi/agent/agents/` to make it available across every
project.

| Agent             | For                                                      |
| ----------------- | -------------------------------------------------------- |
| `explore`         | Reading around the codebase and reporting back           |
| `reviewer`        | A single-reviewer pass over a change, answering in prose |
| `scribe`          | Writing or revising documentation                        |
| `behaviour`       | Code review: intended behaviour, regressions, tests      |
| `security`        | Code review: trust boundaries, injection, abuse          |
| `reliability`     | Code review: correctness, concurrency, error paths       |
| `maintainability` | Code review: conventions, readability, API shape         |
| `plan-adherence`  | Code review: the change against the plan it implements   |
| `verifier`        | Trying to refute a finding, so only real ones survive    |

The last six are shaped for a dimension-split code review: each stays inside one
dimension, is read-only (`tools: [read, grep, find, ls]` — no `bash`, so nothing
can change state or comment on a pull request), and answers in the findings JSON
that a review skill expects. See "Running a dimension-split review" below.

## Defining a subagent

An agent is a Markdown file with YAML frontmatter, in one of the two
directories above. A subagent can also be described in the spawn call rather
than written down — see "Subagents with no file behind them" below.

```markdown
---
name: explore
description: Reads around the codebase and reports what it found
tools: [read, grep, find, ls, bash]
color: cyan
thinking: high
maxTurns: 20
# model: haiku
---

You are a read-only explorer. Answer the question you were asked, cite
`path/to/file.ts:42` for every claim, and say what you did not check.
```

The body is the subagent's system prompt. It replaces pi's rather than
adding to it.

| Field         | Required | Meaning                                                      |
| ------------- | -------- | ------------------------------------------------------------ |
| `name`        | yes      | How the main model names it, and the basis of its `@handle`  |
| `description` | yes      | What the main model reads when choosing whether to delegate  |
| `tools`       | no       | Allowlist of pi tool names. Omitted means pi's defaults      |
| `model`       | no       | Partial names work (`haiku`). Omitted inherits the session's |
| `thinking`    | no       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`    |
| `color`       | no       | Terminal colour for its row. Omitted takes the next in turn  |
| `maxTurns`    | no       | Turns before it is told to wrap up. Defaults to 30           |

A file missing `name` or `description` is not an agent and is skipped, along
with anything that fails to parse — one bad file never hides the rest.

> [!NOTE]
> A `tools:` entry pi does not have is dropped, and the spawn result says which.
> Quote `"off"` if you want that thinking level: a bare `off` is boolean
> `false` in YAML.

## Subagents with no file behind them

A file is one way to define a subagent. The other is to describe one in the
spawn call itself, which is what a skill does when it wants "a security expert"
or "a performance analyst" and has no file to point at.

```txt
spawn_subagent(
  name: "security",
  system_prompt: "You are the Security and Abuse Resistance reviewer...",
  tools: ["read", "grep", "find", "ls"],
  prompt: "Review the diff at $TMPDIR/review.diff ...",
  description: "Security and abuse review",
)
```

That subagent is not second-class. It gets a row and a colour, it can be
watched and steered, and `@security` reaches it and continues it after it
finishes — its record carries its own definition, so nothing has to exist on
disk for it to come back.

Three rules are worth knowing:

- **The main model picks the name, never you.** The tool asks it for a short
  distinct name per subagent, so "spin up five subagents that each try this a
  different way" produces five addressable subagents without you naming any.
  A call that omits `name` gets a handle derived from `description` —
  `@security-and-abuse-review` — because refusing would send the model back to
  you for a name.
- **A name an agent file already uses is reported, not refused.** The supplied
  character runs, and the spawn result says which file it was named over and
  which tier that file came from — a prompt a model composed cannot shadow a
  persona you wrote and read *quietly*, which is the part that matters.
- **A supplied `system_prompt` always wins.** It is the character whatever else
  the call carries; a `subagent_type` named alongside one is read as the
  subagent's name, not as a second source of character.

> [!NOTE]
> A file is reviewable and reusable; a supplied character is neither — nobody
> reads it before it runs. `tools` is what bounds one, so a reviewer that must
> not change anything should say so.

## What the main model can do

Five tools. Four address one subagent by the id that `spawn_subagent` returns;
`list_subagents` addresses none.

| Tool                  | Parameters                                     |
| --------------------- | ---------------------------------------------- |
| `spawn_subagent`      | `prompt`, `description`, and one of the routes |
| `get_subagent_result` | `id`                                           |
| `list_subagents`      | none                                           |
| `steer_subagent`      | `id`, `message`                                |
| `stop_subagent`       | `id`                                           |

The two routes into `spawn_subagent` are `subagent_type`, naming an agent file,
or `system_prompt` with an optional `name` and `tools`. Supplying a
`system_prompt` takes the second route whatever else is given. `model`,
`thinking` and `max_turns` are optional either way, and each overrides whatever
an agent file set.

`spawn_subagent` returns as soon as the subagent is under way; the answer
arrives in the conversation on its own when it is done, so the main model can
carry on meanwhile. `get_subagent_result` reads that answer back on demand, and
waits for it when the subagent is still working — one call rather than a loop
of "is it done yet", each of which would cost a whole turn. It gives up if the
turn is abandoned, and after ten minutes regardless; the answer still arrives on
its own afterwards. An answer handed to a waiting call is not announced twice.
`steer_subagent` redirects one mid-run — a subagent still waiting for a slot
takes the message into the task it starts on. `stop_subagent` halts one and
keeps whatever it had worked out.

`list_subagents` reports all of them at once:

```txt
4 subagents in this session:

- behaviour (a1f2c3d4) — completed — Behaviour and tests review
- security (b3c4e5f6) — running — Security and abuse review
- reliability (c5d6a7b8) — completed — Reliability review
- maintainability (d7e8f9a0) — queued — Maintainability review
```

It exists because each subagent announces itself separately, so a skill that
must read several results together would otherwise have to remember every id
and ask after each one — and would quietly do less work if it lost one. You can
see this list below the prompt; this is how the main model sees it.

A subagent cannot spawn subagents of its own, and a subagent that crashes
becomes a failed row in the list rather than a failed session.

## The list, and its keys

The list appears under the prompt whenever a subagent is running, and a finished
row stays for ten seconds so its result can be read. Five rows fill a column
before a second one starts.

| Key      | At the prompt                                     |
| -------- | ------------------------------------------------- |
| `↓`      | Enter the list, then move down it                 |
| `↑`      | Move up, and off the top row back to the prompt   |
| `←` `→`  | Move between columns, when there is more than one |
| `enter`  | Open the selected subagent's conversation         |
| `delete` | Stop the selected subagent                        |
| `escape` | Leave the list                                    |

Arrow keys only reach the list when the prompt is empty, so ordinary typing and
cursor movement are never intercepted. With text in the prompt, enter submits it
as usual. Each press moves one row, including under terminals that report key
releases as well as presses.

Opening a subagent shows its conversation as pi draws its own — markdown, tool
calls, and their output — inside a framed full-terminal view, and follows it as
it works. It stays open when the subagent finishes, which is usually when the
answer is worth reading.

The view's rails carry what explains it: the subagent's name, status and context
use along the top, the keys and scroll position along the bottom. A prompt sits
at its foot for as long as the subagent can still be reached — there is nothing
to press to get one, and it goes when the subagent finishes.

| Key                   | In the open conversation                             |
| --------------------- | ---------------------------------------------------- |
| `↑` `↓` `pgup` `pgdn` | Scroll transcript history                            |
| `home` `end`          | Jump to top / bottom of transcript                   |
| type                  | Goes to the prompt; `enter` sends it to the subagent |
| `ctrl+x`              | Stop it                                              |
| `escape`              | Clear the prompt, then close the view                |

## Talking to a subagent directly

Every subagent has a handle: its agent name, lowercased, and numbered on a
collision — `explore`, then `explore-2`. Typing `@handle` and a message at the
prompt sends it there instead of to the main model, which costs neither a turn
nor any main-model context.

| What you type                 | What happens                                    |
| ----------------------------- | ----------------------------------------------- |
| `@explore look at auth`       | Reaches `explore` whatever state it is in       |
| `@explore`                    | Ordinary text — a handle alone is not a message |
| `ask @explore about this`     | Ordinary text — only a leading mention routes   |
| `@main @explore is just text` | Reaches the main model, `@main` stripped        |
| `@nosuch hello`               | Ordinary text — no such handle                  |

Where the message lands depends on how far along that subagent is: one at work
is steered, one still queued takes it into the task it starts on, one that has
finished continues from its stored conversation, and a name with no subagent
behind it yet starts one with your message as its task. A confirmation — or the
reason it could not be delivered — appears as a notification.

## Running a dimension-split review

A code-review skill that splits a review across dimensions — behaviour,
security, reliability, maintainability, plan adherence — has everything it needs
here. The six review agents in `examples/` are ready-to-use roles (copied into
`.pi/agents/` or `~/.pi/agent/agents/`), or the skill can carry its own roles as
`system_prompt` and use no files at all.

The flow, once the skill has gathered the diff once into a temp file:

1. The main model spawns one subagent per dimension, passing the paths rather
   than the diff itself, so the diff is tokenized once instead of five times:

   ```txt
   spawn_subagent(
     subagent_type="security",
     description="security review",
     prompt="Review the diff at $TMPDIR/code-review.diff against the
             context at $TMPDIR/review-context.md.
             FILE_LIST: src/queue.ts, src/spawn.ts")
   ```

1. Four dimensions, or five with a plan, run at once — the default concurrency
   limit is 5, so nothing queues. A lower limit still works: the extra ones
   start as slots free.

1. Each answer arrives in the conversation on its own when that subagent
   finishes, waking the main model once per dimension. `list_subagents` is how
   it tells whether the rest are still working before it moves on to
   verification — one call, rather than `get_subagent_result` per dimension and
   a partial review if it loses an id.

1. The verification wave spawns `verifier` subagents, one per finding or a batch
   each. Past five they queue, which is exactly the batching a capped platform
   would do by hand.

Because handles come from agent names, each dimension is addressable while it
works and after it finishes:

```txt
@security you skipped src/auth.ts — the token check moved, look again
@maintainability which peer file did you cite for the naming claim?
```

A mention to a subagent that has finished continues its stored conversation, so
it still has the diff, the context and its own findings in view. Verifiers are
`@verifier`, `@verifier-2`, `@verifier-3` in spawn order.

Two things to know. Each dimension agent is read-only by construction — its
`tools:` list has no `bash`, so it cannot comment on a pull request or change a
file even if asked. And each returns the findings JSON as its final message,
which is what `get_subagent_result` hands back verbatim.

## Settings

One setting, in `~/.pi/agent/settings.json` or a project's `.pi/settings.json`:

```json
{
  "subagents": {
    "limit": 5
  }
}
```

That is how many subagents run at once. Past the limit they queue and start on
their own as slots free. The default is 5, which is also what fills exactly one
column of the list.

## How it works, in one paragraph

A subagent is a real pi `AgentSession` built inside the host process, with the
system prompt it was given — from an agent file or from the spawn call — its own
transcript file, and no extensions loaded, which is also what stops it spawning
subagents of its own. Its transcript lives
beside your own sessions and is nested under the session that spawned it, so a
finished subagent can be picked back up later. Runs are detached: the tool
returns an id immediately and the answer is delivered into the conversation as a
follow-up when it arrives.

For the terms this project uses — subagent, handle, record, registry, viewer,
wrap-up — see [CONTEXT.md](CONTEXT.md). For the design decisions and why they
were made, see `docs/adr/` and `docs/plans/`.

## Licence

MIT.
