# Project Instructions

## Domain Language

Canonical domain terms, definitions, and forbidden vocabulary live in
`CONTEXT.md`. Consult it before introducing new terminology or reusing
overloaded words (such as "subagent" vs "child agent", "steer" vs "interrupt",
"stop" vs "cancel").

## Why

`pi-subagents` is a [pi](https://github.com/earendil-works/pi) extension that
delegates tasks to focused, in-process subagents. Each subagent runs as a nested
`AgentSession` with its own system prompt, tools, and context window, allowing
long investigations, parallel reviews, or adversarial checks to complete
without consuming main-conversation tokens.

## What

TypeScript extension running on Node >= 22.19.

- `src/index.ts` — Extension entry point; registers five tools (`spawn_subagent`,
  `get_subagent_result`, `list_subagents`, `steer_subagent`, `stop_subagent`),
  mounts the TUI status list, and sets up `@handle` mention routing.
- `src/runner.ts` — In-process subagent execution via Pi's `createAgentSession`,
  `DefaultResourceLoader` isolation, and child context recursion guards.
- `src/spawn.ts` — Subagent lifecycle, completion notices (`deliverAs: "followUp"`
  with auto-coalesced wakeups), transcript persistence, and session resumption.
- `src/registry.ts` — State store (`SubagentRegistry`) tracking subagent
  records, status transitions, and context-window percentage usage.
- `src/queue.ts` — FIFO concurrency queue enforcing configured slot limits.
- `src/turns.ts` — Turn watcher warning and stopping runaway subagents
  (`DEFAULT_MAX_TURNS = 20`, 3 grace turns).
- `src/control.ts` — Steering and stopping logic for running or queued runs.
- `src/model-resolver.ts` — Candidate model matching and fuzzy query resolution.
- `src/mention.ts` — Handle assignment and leading `@handle` prompt parsing.
- `src/ui/` — Terminal components: `SubagentList`, `SubagentViewer`, `Transcript`.
- `examples/` — Reusable agent templates (explore, review dimensions, scribe).

## How

Development and verification commands (prefer `make` targets):

```bash
make verify     # Run all 4 checks: test, typecheck, lint, load-check
make test       # Run vitest suite once (npx vitest --run)
make watch      # Re-run vitest on change
make typecheck  # TypeScript compiler check (tsc --noEmit)
make lint       # Biome formatting and lint check
make format     # Auto-apply safe Biome fixes
make try        # Launch interactive Pi session with extension loaded
make agents     # Copy examples/*.md into local .pi/agents/
```

### Gotchas & Constraints

- **In-process crash containment:** Subagents run inside the host process. Every
  subagent error must be caught at the runner boundary and recorded on the
  outcome; an unhandled rejection takes down the user's host session.
- **Recursion guard:** Subagents must never spawn subagents. `inChildContext()`
  and `noExtensions: true` enforce this boundary.
- **Default tools:** Subagents without an explicit `tools` allowlist default to
  read-only tools (`read`, `grep`, `find`, `ls`).
- **Main model wakeups:** Completion notices auto-coalesce when multiple
  subagents run concurrently, waking the main model once on batch completion.
