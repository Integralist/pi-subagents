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
make install     # npm install
make agents      # copy the example agents into .pi/agents
make try         # opens pi with this extension loaded
```

`make try` runs `pi -e ./src/index.ts`, which loads the extension for that
session only and leaves your settings untouched. Ask the main model to
_"use the explore subagent to find where agent discovery happens"_ and watch the
list appear under the prompt.

## Install it for real

`-e` is per-session. To keep the extension across sessions, install this
directory as a package:

```bash
pi install .          # adds it to ~/.pi/agent/settings.json
pi install . -l       # or to this project only, in .pi/settings.json
pi list               # confirm it is there
pi remove .           # undo either of the above
```

pi reads the `pi.extensions` field of `package.json`, so it picks up
`./src/index.ts` on its own. There is no build step: pi loads the TypeScript
sources directly.

Agents are not installed with the package. Copy the examples where a session
will look for them, or write your own:

```bash
make agents                          # this project: .pi/agents/
cp agents/*.md ~/.pi/agent/agents/   # every project
```

## Testing your copy

```bash
make verify
```

That is the four checks this repository holds itself to:

| Target            | What it does                                     |
| ----------------- | ------------------------------------------------ |
| `make test`       | 518 tests under `vitest`                         |
| `make typecheck`  | `tsc --noEmit`                                   |
| `make lint`       | `biome check src test`                           |
| `make load-check` | loads the extension through pi's own jiti loader |

`make load-check` earns its place: vitest resolves imports its own way, so a
green suite does not prove pi can load the extension at all. `make watch` reruns
the tests as you edit, and `make` on its own lists every target.

## Defining a subagent

An agent is a Markdown file with YAML frontmatter. Two directories are read, and
the project's wins on a name collision:

1. `~/.pi/agent/agents/*.md` — yours, in every project
1. `<project>/.pi/agents/*.md` — this checkout's

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

## What the main model can do

Four tools, all addressing a subagent by the id that `spawn_subagent` returns.

| Tool                  | Parameters                                                                    |
| --------------------- | ----------------------------------------------------------------------------- |
| `spawn_subagent`      | `subagent_type`, `prompt`, `description`, `model?`, `thinking?`, `max_turns?` |
| `get_subagent_result` | `id`                                                                          |
| `steer_subagent`      | `id`, `message`                                                               |
| `stop_subagent`       | `id`                                                                          |

`spawn_subagent` returns as soon as the subagent is under way; the answer
arrives in the conversation on its own when it is done, so the main model can
carry on meanwhile. `get_subagent_result` reads that answer back on demand.
`steer_subagent` redirects one mid-run — a subagent still waiting for a slot
takes the message into the task it starts on. `stop_subagent` halts one and
keeps whatever it had worked out.

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
as usual.

Opening a subagent shows its conversation as pi draws its own — markdown, tool
calls, and their output — and follows it as it works. It stays open when the
subagent finishes, which is usually when the answer is worth reading.

| Key      | In the open conversation                             |
| -------- | ---------------------------------------------------- |
| `enter`  | Compose a message to it; `enter` sends, `escape` not |
| `delete` | Stop it                                              |
| `escape` | Close the view                                       |

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
agent file's system prompt, its own transcript file, and no extensions loaded —
which is also what stops it spawning subagents of its own. Its transcript lives
beside your own sessions and is nested under the session that spawned it, so a
finished subagent can be picked back up later. Runs are detached: the tool
returns an id immediately and the answer is delivered into the conversation as a
follow-up when it arrives.

For the terms this project uses — subagent, handle, record, registry, viewer,
wrap-up — see [CONTEXT.md](CONTEXT.md). For the design decisions and why they
were made, see `docs/adr/` and `docs/plans/`.

## Licence

MIT.
