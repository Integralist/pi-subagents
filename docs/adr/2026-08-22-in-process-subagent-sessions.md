# Run subagents as in-process sessions

- **Status**: Accepted
- **Date**: 2026-08-22
- **Deciders**: Integralist

## Context

Pi has no built-in subagent primitive. Both existing community
extensions build delegation on the ordinary extension API, and they
choose opposite strategies for where a child agent runs
([research](../research/2026-08-22-pi-extensions-and-subagents.md)).

The feature set for this extension
([spec](../specifications/2026-08-22-subagents.md)) is dominated by
watching and interacting with running children rather than by
starting them: a live list carrying each subagent's context-window
use, arrow-key navigation into a live conversation view, mid-run
steering by typing, and retargeting a running subagent's model.
Starting a child is roughly equal work under either strategy; every
one of those observation and interaction features is not.

Pi exposes the operations these features need as direct methods on a
session object: `session.steer(text)`
(`pi-coding-agent/dist/core/agent-session.d.ts:371`),
`session.subscribe(listener)` (`:276`), `session.abort()` (`:433`),
and `session.getContextUsage()` (`:616`), the last returning
`{ tokens, contextWindow, percent }`
(`dist/core/extensions/types.d.ts:193-199`) — the readout the list
needs, already computed.

## Decision

We will run each subagent as a nested `AgentSession` created through
`createAgentSession()` inside the host `pi` process.

Every subagent's execution will be wrapped in a catch boundary that
converts any failure into a failed subagent record. No subagent error
may reach the host session's error handling. This is a requirement of
the decision, not a separate quality goal.

## Options Considered

- **Nested in-process sessions (chosen)** — every feature on the list
  is a direct call on an object we hold. The reference implementation
  using this approach ships the full feature set, plus scheduling and
  nested agents, in 39 source files
  (`tintinweb-pi-subagents/src/agent-runner.ts:709-940`).
- **A `pi` subprocess per subagent** — the approach taken by the
  official example (`pi-coding-agent/examples/extensions/subagent/`)
  and by `nicobailon/pi-subagents`. Rejected because each interaction
  feature becomes a bespoke inter-process protocol. Steering alone
  needs a message file, a capability token, and an acknowledgement
  directory — three environment variables and code on both sides
  (`nicobailon-pi-subagents/src/runs/shared/pi-args.ts:106-135`). It
  also pays full `pi` startup latency per child. Its real advantage,
  crash isolation, is addressed here by the mandatory catch boundary.

## Consequences

Easier: live context-window percentages, steering, stopping,
navigation, and live model changes all become small amounts of code.
No serialisation format, no file channels, no process supervision.

Harder: subagents share the host process, so an uncaught error in a
child is the user's session. The catch boundary is load-bearing —
treat any path that can throw past it as a bug, not a rough edge.
Memory scales with concurrent subagents inside one process, which
informs the concurrency cap.

New constraint: the extension depends on SDK internals that are not
a stable public API. `DefaultResourceLoader`'s option shape and
`createAgentSession`'s model plumbing both changed during the 0.80.x
series, and the reference implementation carries a workaround for the
latter (`tintinweb-pi-subagents/src/agent-runner.ts:910-927`). Pin
the Pi dev dependency and expect to revisit on upgrade.

Ruled out for now: subagents that outlive the host session, and
subagents running untrusted or destructive code under OS-level
isolation. Both would force a return to the subprocess model.

## Source

- [Implementation plan](../plans/2026-08-22-subagents.md)
- [Specification](../specifications/2026-08-22-subagents.md)
