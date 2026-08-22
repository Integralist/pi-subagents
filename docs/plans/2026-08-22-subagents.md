# Pi Subagents — Implementation Plan

- **Status**: Planning
- **Author**: Integralist
- **Created**: 2026-08-22
- **Language**: TypeScript

## Summary

Build a Pi extension that lets the main agent delegate work to focused
subagents running as nested in-process sessions, and lets the user
watch and redirect them from a navigable list below the prompt.
Delivered as twelve vertical slices, each demoable on its own, with
the riskiest feature (live model change on a running subagent) last
and droppable.

## Specification

Acceptance criteria and scope:
[Pi Subagents](../specifications/2026-08-22-subagents.md).

## Research

- [Pi extensions and subagent implementations](../research/2026-08-22-pi-extensions-and-subagents.md)

## Prerequisites & Dependencies

Pi runtime, as peer dependencies — the extension loads inside the host
`pi` process and must bind to the host's copies, never its own. Pi
bundles these and requires a `"*"` range, not a floor
(`pi-coding-agent/docs/packages.md`, "Dependencies"):

```json
"peerDependencies": {
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*",
  "typebox": "*"
}
```

> [!IMPORTANT]
> **`typebox` is a bundled peer, not a runtime dependency.** Pi's own
> `dependencies` pin `typebox@1.3.7`, and `packages.md` names it
> alongside the `@earendil-works/*` packages as something to declare as
> a peer and never bundle. Declaring it in `dependencies` would install
> a second copy whose `Type` symbols fail Pi's schema identity checks.
> The same list also includes `@earendil-works/pi-agent-core`; add it
> as a peer only once something here imports it.

Third-party runtime dependencies — none so far — belong in
`dependencies`. Pi package installation uses production installs
(`npm install --omit=dev`), so anything needed at runtime must not sit
in `devDependencies` (`pi-coding-agent/docs/extensions.md:150`).

Dev dependencies, pinned exactly so the toolchain typechecks against
what Pi actually loads: `vitest@4.1.11`, `@biomejs/biome@2.5.10`,
`typescript@7.0.2`, `@types/node@24.13.3` (24.x to match the Node 24
runtime, not the 26.x latest), `typebox@1.3.7`, and the three Pi
packages at `0.84.2`.

> [!IMPORTANT]
> **No Cucumber.js.** The spec's Gherkin is the definition of done, but
> it will be implemented as ordinary `vitest` tests whose `describe` /
> `it` names quote the scenario names verbatim. Adding a second test
> runner with regex step definitions to a three-seam extension creates
> an artifact that duplicates the tests and drifts from them. This is a
> deliberate departure from the default BDD wiring; revisit only if the
> scenario count grows past what test names can carry.

Verified against `@earendil-works/pi-coding-agent` **0.84.2** as
installed at
`$(dirname $(dirname $(readlink -f $(which pi))))`.

## Pull Request Delivery

- **Mode:** Stack (proposed — awaiting confirmation)

| Layer | Base          | Includes      | Branch          |
| ----- | ------------- | ------------- | --------------- |
| 1     | `main`        | Slices 1–2    | `foundation`    |
| 2     | `foundation`  | Slices 3–7    | `lifecycle`     |
| 3     | `lifecycle`   | Slices 8–10   | `subagent-list` |
| 4     | `subagent-list` | Slices 11–12 | `mentions`     |

Each layer builds, typechecks, and passes its own tests. Layer 1 gives
a working single delegation; Layer 2 gives background execution and
full lifecycle control; Layer 3 gives the UI; Layer 4 gives mention
routing plus the optional model swap.

## Execution Strategy

> [!IMPORTANT]
> Read this before starting any slice. It decides *who* executes each
> one, and getting it wrong wastes work.

This plan is written against a Pi SDK that has been **read but not
run**. Several behaviours are cited from type definitions rather than
observed: the exact option shape `DefaultResourceLoader` accepts at
0.84.2, whether `bindExtensions()` must be called before a child's
tool allowlist takes effect, and how `SessionManager` persistence
options behave. Two of these are already flagged in Notes & Caveats as
version-sensitive.

That has a direct consequence for how the work is handed out.

- **Do not crystallise this whole plan into a `/tasks` document yet.**
  A mechanical task document carries verbatim implementation code. For
  slices whose SDK behaviour is still unverified, that code would be
  confident and wrong, handed to an executor with no capacity to
  notice. Every slice carries an `- **Execution**:` line saying which
  mode it belongs in.
- **Run the discovery slices in the main thread.** Slices 1, 3, and 7
  touch unverified SDK surface. Expect to correct this plan as reality
  lands, and do correct it — a later `/tasks` pass depends on it being
  true.
- **Run `/tasks` for the mechanical slices once discovery has landed.**
  Slices 2, 4, 5, 6, and the pure functions inside 8 and 11
  (`layoutColumns`, `parseMention`) are pure logic with the spec's own
  tables as their test cases. That is where a cheap executor earns its
  keep — pay for exploration once, hand over the result.
- **Keep the UI slices in the main thread regardless.** Slices 8.2–8.4,
  9, and 10 are work you iterate on by looking at it. A sealed executor
  cannot tell you the navigation feels wrong, and will plough ahead
  while objections pile up.

## Implementation

### Slice 1: Repo scaffold and one subagent, start to finish

- **Blocked by**: None — can start immediately
- **Delivers**: The main agent delegates a task to a named subagent and
  receives its answer. Blocking, one at a time, no UI.
- **Consumes**: None
- **Produces**: `AgentConfig`, `discoverAgents()`, `runSubagent()`,
  `SubagentOutcome`, `SubagentError`, the `spawn_subagent` tool.
- **Execution**: **Main thread.** Discovery work — the Pi SDK's runtime
  behaviour is read but unverified. Expect to correct this plan as reality
  lands.

- [x] **Task 1.1**: Initialise the repository.

  ```bash
  cd /Users/mmcdonnell/code/pi-subagents
  git init
  git remote add origin git@github.com:Integralist/pi-subagents.git
  ```

  Add `.gitignore` covering `node_modules/`, `dist/`, `*.log`.

- [x] **Task 1.2**: Create `package.json` declaring the Pi manifest.

  ```json
  {
    "name": "@integralist/pi-subagents",
    "version": "0.1.0",
    "type": "module",
    "pi": { "extensions": ["./src/index.ts"] }
  }
  ```

  The manifest points at TypeScript source — Pi transpiles extensions
  on load, so no build step is needed for the extension to run. Add
  `tsconfig.json`, `biome.json`, and `vitest.config.ts`.

- [x] **Task 1.3**: Implement agent discovery in `src/agents.ts`.

  Markdown files with YAML frontmatter, read from `.pi/agents/*.md`
  (project) and `<agentDir>/agents/*.md` (user), project overriding
  user on name collision. Use Pi's own parser rather than adding a
  YAML dependency:

  ```typescript
  import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter }
    from "@earendil-works/pi-coding-agent";

  export interface AgentConfig {
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[];
    model?: string;
    thinking?: ThinkingLevel;
    color?: string;
    maxTurns?: number;
    source: "user" | "project";
    filePath: string;
  }

  export function discoverAgents(cwd: string): AgentConfig[];
  ```

  A file missing `name` or `description` is skipped, not thrown on —
  one bad file must not hide every other agent.

  Given a directory with two agent files and one malformed, when
  discovery runs, then two configs are returned and no error is thrown.

  > [!IMPORTANT]
  > **`parseFrontmatter` throws — the guard has to wrap the parse, not
  > just the field checks.** Malformed YAML raises `YAMLParseError`, so
  > checking `name` and `description` afterwards is too late. Pi's own
  > `examples/extensions/subagent/agents.ts` parses unguarded and
  > therefore loses a whole directory to one bad file; do not copy it
  > verbatim.

  Two refinements landed with the implementation:

  - **Project discovery walks up from `cwd`** looking for
    `.pi/agents`, matching Pi's example, so a subagent can be started
    from a directory deep inside the checkout.
  - **Results are sorted by name.** Task 1.7 builds the tool
    description from these names, and unsorted `Map` order would let it
    shuffle between runs.

  Tool-name validation from Notes & Caveats is **deferred to Task
  1.7**. Discovery cannot see Pi's registered tool names — that list
  only exists once the extension holds an `ExtensionAPI` — and
  hardcoding the built-ins here would rot on every Pi upgrade.

- [ ] **Task 1.4**: Implement `runSubagent()` in `src/runner.ts`.

  ```typescript
  import { createAgentSession, DefaultResourceLoader, SessionManager,
           SettingsManager } from "@earendil-works/pi-coding-agent";

  export interface RunSubagentOptions {
    ctx: ExtensionContext;
    config: AgentConfig;
    prompt: string;
    model?: Model<any>;
    thinkingLevel?: ThinkingLevel;
    signal?: AbortSignal;
  }

  export interface SubagentOutcome {
    status: "completed" | "failed" | "stopped";
    output: string;
    error?: string;
  }

  export async function runSubagent(
    opts: RunSubagentOptions,
  ): Promise<SubagentOutcome>;
  ```

  Build the loader with the agent's system prompt overriding the
  default, and everything the child does not need switched off:

  ```typescript
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,          // also the recursion guard — see 1.6
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => config.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    model: model ?? ctx.model,
    thinkingLevel: thinkingLevel ?? ctx.thinkingLevel,
    tools: config.tools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.create(ctx.cwd, getAgentDir()),
  });
  await session.prompt(prompt);
  ```

  `session.prompt(text, options?)` returns `Promise<void>`
  (`dist/core/agent-session.d.ts:355`); the output is read off the
  session's messages once it resolves.

  Given the parent runs model M at effort E, when a subagent starts
  with neither specified, then the child session is created with M
  and E.

- [ ] **Task 1.5**: Wrap every run so no subagent failure escapes.

  ```typescript
  export class SubagentError extends Error {
    constructor(readonly agentId: string, cause: unknown) { /* ... */ }
  }
  ```

  `runSubagent` catches everything — thrown errors, rejected promises,
  and errors surfaced through `session.bindExtensions({ onError })` —
  and returns `{ status: "failed", error }`. It never rethrows. This
  is the requirement that makes the in-process choice safe; treat a
  path that can throw past this boundary as a bug.

  Given a session factory that throws, when a subagent runs, then the
  outcome is `failed` with the error message and nothing propagates.

- [ ] **Task 1.6**: Add the recursion guard.

  `noExtensions: true` on the child's loader (Task 1.4) means the
  child never loads this extension, so it cannot gain the spawn tools.
  Add an `AsyncLocalStorage` flag as a second, explicit guard so the
  intent survives a future change that re-enables child extensions:

  ```typescript
  import { AsyncLocalStorage } from "node:async_hooks";
  const childContext = new AsyncLocalStorage<boolean>();
  export const inChildContext = () => childContext.getStore() === true;
  export const runInChildContext = <T>(fn: () => Promise<T>) =>
    childContext.run(true, fn);
  ```

  Async-context-local rather than a module global, so concurrent
  spawns in Slice 3 do not see each other's flag.

- [ ] **Task 1.7**: Register `spawn_subagent` in `src/index.ts`.

  ```typescript
  import { Type } from "typebox";

  export default function (pi: ExtensionAPI) {
    pi.registerTool({
      name: "spawn_subagent",
      label: "Spawn Subagent",
      description: /* built from discovered agent names */,
      parameters: Type.Object({
        subagent_type: Type.String({ description: "..." }),
        prompt: Type.String({ description: "..." }),
        description: Type.String({ description: "3-5 words, shown in UI" }),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) { /* ... */ },
    });
  }
  ```

  Plain types and explicit enums only — no `anyOf` or conditional
  schema constructs, per the spec's provider-compatibility decision.

- [ ] **Task 1.8**: Tests at the tool boundary.

  Build a fake `ExtensionContext` and inject a stubbed session factory.
  Cover: inherits parent model and effort; unknown subagent type is
  refused with the list of known types; a throwing session yields a
  failed outcome; the parent is unaffected.

### Slice 2: Model and effort overrides with fuzzy name resolution

- **Blocked by**: Slice 1 (needs `spawn_subagent` and `runSubagent`)
- **Delivers**: `spawn_subagent({ model: "flash", thinking: "low" })`
  runs the child on a different model than the parent.
- **Consumes**: `runSubagent(opts: RunSubagentOptions)` from Slice 1.
- **Produces**: `resolveModel()`.
- **Execution**: **`/tasks` candidate.** `resolveModel` is a pure function over
  `ModelRegistry.getAll()`, which is already verified. Fully mechanical.

- [ ] **Task 2.1**: Implement fuzzy resolution in `src/model-resolver.ts`.

  ```typescript
  export type ResolveModelResult =
    | { ok: true; model: Model<any> }
    | { ok: false; available: string[] };

  export function resolveModel(
    registry: ModelRegistry,
    query: string,
  ): ResolveModelResult;
  ```

  `registry.getAll(): Model<Api>[]`
  (`dist/core/model-registry.d.ts:26`) is the candidate source. Match
  in order: exact `provider/id`, exact `id`, unique case-insensitive
  substring of `id`, unique substring of display name. An ambiguous
  match fails with the candidates listed, so `"gpt"` matching four
  models is an error rather than an arbitrary pick.

  Given models `gemini-2.5-flash` and `claude-opus-4-5`, when
  resolving `"flash"`, then `gemini-2.5-flash` is returned.
  Given the same, when resolving `"nope"`, then the result is not-ok
  with both names listed.

- [ ] **Task 2.2**: Add `model` and `thinking` to the tool schema.

  ```typescript
  model: Type.Optional(Type.String({
    description: "Model for this subagent. Partial names work "
      + "(e.g. 'flash'). Defaults to the current model.",
  })),
  thinking: Type.Optional(Type.String({
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    description: "Effort level. Defaults to the current level.",
  })),
  ```

  A plain `enum` on a string, not a union type — Pi's `ThinkingLevel`
  is `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`
  (`pi-agent-core/dist/types.d.ts:260`). Pi clamps the level to the
  model's real capabilities, so no validation is needed here.

  Frontmatter `model:` applies when the caller gives none; the caller
  wins when both are present.

### Slice 3: Background execution, registry, and completion notices

- **Blocked by**: Slice 1
- **Delivers**: Spawning returns immediately with an id; the subagent
  works in the background; its result arrives in the conversation when
  it finishes. `get_subagent_result` reads it back on demand.
- **Consumes**: `runSubagent`, `SubagentOutcome` from Slice 1.
- **Produces**: `SubagentRecord`, `SubagentRegistry`, `assignColor()`.
- **Execution**: **Main thread.** Wires into Pi's message delivery and event
  stream; behaviour needs observing, not just reading.

- [ ] **Task 3.1**: Define the record and registry in `src/registry.ts`.

  ```typescript
  export type SubagentStatus =
    | "queued" | "running" | "completed" | "failed" | "stopped";

  export interface SubagentRecord {
    id: string;
    handle: string;          // "explore", "explore-2" — Slice 11
    type: string;
    description: string;
    status: SubagentStatus;
    color: string;
    startedAt: number;
    session?: AgentSession;
    outcome?: SubagentOutcome;
    contextPercent: number | null;
    turns: number;
  }

  export class SubagentRegistry {
    add(record: SubagentRecord): void;
    get(idOrHandle: string): SubagentRecord | undefined;
    list(): SubagentRecord[];        // launch order, earliest first
    running(): SubagentRecord[];
    onChange(listener: () => void): () => void;
  }
  ```

  `onChange` is what the UI in Slice 8 subscribes to.

- [ ] **Task 3.2**: Track context-window use per subagent.

  `session.getContextUsage()` returns
  `{ tokens: number | null, contextWindow: number, percent: number | null }`
  (`dist/core/extensions/types.d.ts:193-199`,
  `dist/core/agent-session.d.ts:616`). Read it on each `turn_end` from
  `session.subscribe()` and store `percent` on the record. `percent` is
  null right after compaction; render a blank rather than `0%`.

- [ ] **Task 3.3**: Assign a colour per subagent in `src/colors.ts`.

  ```typescript
  export function assignColor(index: number, configured?: string): string;
  ```

  Frontmatter `color:` wins; otherwise take the next entry from a fixed
  palette by launch index, wrapping when exhausted. Deterministic, so a
  subagent keeps its colour for life.

- [ ] **Task 3.4**: Run detached and notify on completion.

  `execute()` starts the run without awaiting it and returns the id.
  On completion, deliver the result as a follow-up that triggers a
  turn, so the main model reasons about it:

  ```typescript
  pi.sendMessage({
    customType: "subagent-complete",
    content: `Subagent ${record.handle} finished:\n\n${output}`,
    display: true,
    details: { id: record.id, status, usage },
  }, { deliverAs: "followUp", triggerTurn: true });
  ```

  Register a matching `pi.registerMessageRenderer("subagent-complete", …)`
  so it renders as a compact themed box rather than raw text.

- [ ] **Task 3.5**: Register `get_subagent_result`.

  Parameters: `id: Type.String()`. Returns the full output for a
  finished subagent; for a running one, returns a message saying so
  and no output.

- [ ] **Task 3.6**: Tests at the tool boundary.

  Cover: spawn returns an id without waiting; the completion message is
  delivered as a follow-up with `triggerTurn`; result of a finished
  subagent returns its text; result of a running one reports unfinished.

### Slice 4: Concurrency limit with queueing

- **Blocked by**: Slice 3 (needs the registry and detached runs)
- **Delivers**: Spawning past the limit queues rather than running;
  queued subagents start as slots free.
- **Consumes**: `SubagentRegistry`, `SubagentRecord` from Slice 3.
- **Produces**: `SubagentQueue`.
- **Execution**: **`/tasks` candidate.** Pure queue logic, no SDK surface.

- [ ] **Task 4.1**: Implement the queue in `src/queue.ts`.

  ```typescript
  export class SubagentQueue {
    constructor(private limit: number) {}
    submit(id: string, run: () => Promise<void>): void;
    get queuedCount(): number;
  }
  ```

  FIFO. On a run settling — resolved *or* rejected — start the next.
  Use `finally`, not `then`, or one failure stalls the queue forever.

  Given a limit of 3 and 3 running, when a fourth is submitted, then
  it is queued and `queuedCount` is 1. When one finishes, then the
  queued one starts.

- [ ] **Task 4.2**: Make the limit configurable, defaulting to 5.

  Read from Pi settings, falling back to 5 — matching the point at
  which the list gains a second column, so the default fills exactly
  one column.

### Slice 5: Turn limits with a graceful wrap-up

- **Blocked by**: Slice 3
- **Delivers**: A subagent warned at its turn limit returns a usable
  answer; one that ignores the warning is stopped.
- **Consumes**: `SubagentRecord`, and the `turn_end` subscription from
  Task 3.2.
- **Produces**: Turn-counting behaviour inside `runSubagent`.
- **Execution**: **`/tasks` candidate** once Slice 3 lands — turn counting
  inside an existing subscription is mechanical.

- [ ] **Task 5.1**: Count turns and inject the warning.

  In the existing `session.subscribe()` handler, on `turn_end`
  increment the record's turn count. At `maxTurns`, steer once:

  ```typescript
  await session.steer(
    "You have reached your turn limit. Wrap up immediately — "
    + "give your final answer now.",
  );
  ```

  `session.steer(text, images?)` returns `Promise<void>`
  (`dist/core/agent-session.d.ts:371`). Guard with a `warned` flag so
  it fires exactly once.

- [ ] **Task 5.2**: Hard-abort after the grace turns.

  At `maxTurns + graceTurns` call `session.abort()`
  (`dist/core/agent-session.d.ts:433`) and mark the outcome incomplete.
  Grace defaults to 3.

  `maxTurns` resolution order: caller parameter, then frontmatter
  `max_turns:`, then unlimited.

### Slice 6: Steering and stopping

- **Blocked by**: Slice 3
- **Delivers**: `steer_subagent` redirects a running subagent;
  `stop_subagent` halts one and keeps its partial output.
- **Consumes**: `SubagentRegistry.get()`, `SubagentRecord.session`.
- **Produces**: `steerSubagent()`, `stopSubagent()` — reused by the UI
  in Slice 10 and mentions in Slice 11.
- **Execution**: **`/tasks` candidate** once Slice 3 lands — thin wrappers over
  `session.steer()` and `session.abort()`, both verified.

- [ ] **Task 6.1**: Implement the two operations in `src/control.ts`.

  ```typescript
  export type ControlResult =
    | { ok: true }
    | { ok: false; reason: string };

  export async function steerSubagent(
    record: SubagentRecord, message: string,
  ): Promise<ControlResult>;

  export async function stopSubagent(
    record: SubagentRecord,
  ): Promise<ControlResult>;
  ```

  Steering a finished subagent fails with a reason rather than
  throwing — the UI and the mention handler both need to show it.
  Separate functions from the tools, because three callers need them.

- [ ] **Task 6.2**: Register `steer_subagent` and `stop_subagent`.

  `steer_subagent`: `{ id: Type.String(), message: Type.String() }`.
  `stop_subagent`: `{ id: Type.String() }`.

### Slice 7: Session persistence and resume

- **Blocked by**: Slice 3
- **Delivers**: A finished subagent's conversation survives on disk and
  can be continued.
- **Consumes**: `runSubagent`, `SubagentRecord`.
- **Produces**: `resumeSubagent()`, `SubagentRecord.sessionFile`.
- **Execution**: **Main thread.** `SessionManager` persistence options are
  version-sensitive; verify against the installed Pi before committing.

- [ ] **Task 7.1**: Persist instead of running in memory.

  Replace `SessionManager.inMemory(cwd)` from Task 1.4 with:

  ```typescript
  SessionManager.create(ctx.cwd, sessionDir, {
    parentSession: ctx.sessionManager?.getSessionFile?.(),
  })
  ```

  `parentSession` nests the subagent under its spawner in Pi's own
  `/resume` picker. Store the resulting file path on the record.

- [ ] **Task 7.2**: Implement resume.

  ```typescript
  export async function resumeSubagent(
    record: SubagentRecord, message: string,
  ): Promise<SubagentOutcome>;
  ```

  Reopen with `SessionManager.open(record.sessionFile, sessionDir)`.
  A record whose file has since been deleted must report that and
  start fresh, not fail silently — the spec calls this out.

  The agent's *definition* is re-resolved at resume, so a continuation
  runs under the type's current frontmatter, not the one in force at
  first run.

### Slice 8: The subagent list

- **Blocked by**: Slice 3 (needs records with colour, status, context %)
- **Delivers**: A live list below the prompt showing every subagent,
  its colour, and its context-window use, in columns past five.
- **Consumes**: `SubagentRegistry.list()`, `onChange()`.
- **Produces**: `SubagentList` component, `layoutColumns()`.
- **Execution**: **Split.** Task 8.1 (`layoutColumns`) is a `/tasks` candidate —
  pure, with the spec's Examples table as its cases. Tasks 8.2–8.4 are main
  thread: you will want to look at the rendering and adjust it.

- [ ] **Task 8.1**: Implement column layout in `src/ui/layout.ts`.

  ```typescript
  export function layoutColumns<T>(items: T[], perColumn: number): T[][];
  ```

  Pure and separately testable. Five per column: 3 items → one column
  of 3; 6 → two columns of 5 and 1; 10 → two of 5. Matches the spec's
  Examples table exactly.

- [ ] **Task 8.2**: Build the component in `src/ui/subagent-list.ts`.

  Render with `@earendil-works/pi-tui` primitives (`Text`, `Container`).
  Each row: status glyph, coloured name, description, context percent.
  Blank rather than `0%` when `percent` is null. A `N queued` row when
  the queue is non-empty.

- [ ] **Task 8.3**: Mount it below the editor and keep it live.

  Subscribe to `registry.onChange()` and re-render. Finished subagents
  linger briefly before dropping out, so a result is readable.

- [ ] **Task 8.4**: Tests driving the rendered output.

  Construct with fake records, render, strip ANSI, assert on rows.
  Cover the Examples table from the spec's column-splitting scenario,
  the context-percent column, and distinct colours per row.

### Slice 9: Navigating the list

- **Blocked by**: Slice 8
- **Delivers**: Arrow keys move a selection through the list and across
  columns; escape returns to the prompt; typing is never intercepted.
- **Consumes**: `SubagentList` from Slice 8.
- **Produces**: Selection state and key handling on `SubagentList`.
- **Execution**: **Main thread.** Key wiring you will iterate on. A sealed
  executor cannot tell you the navigation feels wrong.

- [ ] **Task 9.1**: Handle keys.

  Escape sequences, as used by the reference implementation's tests
  (`tintinweb-pi-subagents/test/fleet-list.test.ts:10-16`):

  ```typescript
  const UP = "\x1b[A", DOWN = "\x1b[B";
  const RIGHT = "\x1b[C", LEFT = "\x1b[D";
  const ENTER = "\r", ESC = "\x1b";
  ```

  Down at an empty prompt enters the list. Up past the first row
  leaves it. Left/right move between columns, clamping to the last row
  when the target column is shorter.

- [ ] **Task 9.2**: Capture arrows only at an empty prompt.

  With any text in the editor, arrows do ordinary cursor movement. This
  is the one behaviour that will annoy daily if it is wrong, so test it
  directly.

- [ ] **Task 9.3**: Key-driven tests.

  Feed sequences, assert the selected row after each. Cover entering,
  moving, crossing columns, leaving via escape, and the non-empty
  prompt case.

### Slice 10: Opening a subagent and steering it there

- **Blocked by**: Slice 9 (selection), Slice 6 (`steerSubagent`)
- **Delivers**: Enter opens a live view of the selected subagent;
  typing there redirects it.
- **Consumes**: `steerSubagent()` from Slice 6, selection from Slice 9.
- **Produces**: `SubagentViewer` component.
- **Execution**: **Main thread.** Visual and interactive; same reason as Slice
  9.

- [ ] **Task 10.1**: Build the viewer.

  Subscribe to that subagent's `session.subscribe()` and render its
  conversation, auto-following new content. Escape returns to the list.

- [ ] **Task 10.2**: Steer from the viewer.

  Enter opens a composer; submitting calls `steerSubagent(record, text)`.
  An empty submit or escape returns without sending.

- [ ] **Task 10.3**: Stay open when the subagent finishes.

  The viewer must survive completion so the final output is readable —
  it closes only on escape.

### Slice 11: Addressing a subagent by name

- **Blocked by**: Slice 7 (resume), Slice 6 (steering)
- **Delivers**: `@explore look at auth` reaches that subagent whatever
  state it is in, with no main-model turn.
- **Consumes**: `steerSubagent`, `resumeSubagent`, `SubagentRegistry.get`.
- **Produces**: `parseMention()`, the `input` handler.
- **Execution**: **Split.** Task 11.2 (`parseMention`) is a `/tasks` candidate —
  pure, and the spec's routing table is its test cases verbatim. Tasks 11.1 and
  11.3 are main thread.

- [ ] **Task 11.1**: Assign handles.

  Lowercased type, numbered on collision: `explore`, `explore-2`.
  `main` is reserved. Assigned at spawn, stored on the record.

- [ ] **Task 11.2**: Parse mentions in `src/mention.ts`.

  ```typescript
  export type Mention =
    | { kind: "route"; handle: string; message: string }
    | { kind: "passthrough"; text: string };

  export function parseMention(
    text: string, known: (h: string) => boolean,
  ): Mention;
  ```

  Deliberately narrow, matching the spec's table: only a *leading*
  mention routes; a bare handle with no message does not; `@main `
  strips and passes through; an unknown handle passes through
  untouched. Pure, so every row of that table is a direct unit test.

- [ ] **Task 11.3**: Wire the `input` event.

  ```typescript
  pi.on("input", async (event, ctx) => {
    const mention = parseMention(event.text, h => registry.get(h) !== undefined);
    if (mention.kind === "passthrough") return { action: "continue" };
    // route by record status, then:
    return { action: "handled" };
  });
  ```

  `{ action: "handled" }` is what keeps the main model out of it.
  Dispatch by status: running or queued → steer; finished → resume;
  never started → spawn with the message as its task.

  Guard against re-entry: text this extension submits itself must not
  be re-parsed as a mention.

### Slice 12: Live model change (droppable)

- **Blocked by**: Slice 6 (control functions), Slice 2 (`resolveModel`)
- **Delivers**: Retargeting a running subagent's model; takes effect at
  its next turn boundary.
- **Consumes**: `resolveModel()` from Slice 2, `SubagentRecord.session`.
- **Produces**: Nothing later slices depend on.
- **Execution**: **Main thread.** Riskiest slice, and droppable. Needs judgement
  about whether the runtime cooperates.

- [ ] **Task 12.1**: Change the model between turns.

  Store a pending model on the record; apply it in the `turn_end`
  handler before the next turn begins. Mid-turn change is not safely
  possible and is not attempted.

- [ ] **Task 12.2**: Expose it from the viewer and a slash command.

  `/subagent-model <handle> <model>`, and a key in the Slice 10 viewer
  for the selected subagent. Both route through `resolveModel()`, so
  partial names behave as they do at spawn.

> [!NOTE]
> Drop this slice if it fights the runtime. Nothing else depends on it,
> and the user has confirmed that spawn-time selection covers the common
> case.

### Documentation

- [ ] Write `README.md`: install, the four tools, agent file format,
  the list and its keys, `@name` routing, settings.
- [ ] Write `CONTEXT.md` recording the ubiquitous language — subagent,
  handle, record, registry, the subagent list, viewer, steer, wrap-up.
- [ ] Add example agent definitions under `agents/`.

### Verification

- [ ] `npx vitest run` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npx biome check src/ test/` passes.
- [ ] Load into a real session with `pi -e ./src/index.ts` and walk
  each acceptance scenario by hand — spawn several subagents, watch
  the list split into two columns past five, navigate it, open one,
  steer it, stop another, and address one with `@name`.
- [ ] All spec acceptance criteria hold, each scenario matched by a
  `vitest` test quoting its name.

## File Changes

| File                        | Change                                        |
| --------------------------- | --------------------------------------------- |
| `package.json`              | New — Pi manifest, peer deps, scripts         |
| `tsconfig.json`             | New — TypeScript config                       |
| `biome.json`                | New — lint and format config                  |
| `vitest.config.ts`          | New — test config                             |
| `.gitignore`                | New                                           |
| `src/index.ts`              | New — factory, tool and event registration    |
| `src/agents.ts`             | New — agent file discovery                    |
| `src/runner.ts`             | New — nested session creation, crash guard    |
| `src/registry.ts`           | New — records, status, context tracking       |
| `src/queue.ts`              | New — concurrency limit                       |
| `src/control.ts`            | New — steer and stop                          |
| `src/model-resolver.ts`     | New — fuzzy model matching                    |
| `src/colors.ts`             | New — palette assignment                      |
| `src/mention.ts`            | New — `@name` parsing                         |
| `src/ui/layout.ts`          | New — column splitting                        |
| `src/ui/subagent-list.ts`   | New — the list and its key handling           |
| `src/ui/viewer.ts`          | New — live conversation view                  |
| `test/*.test.ts`            | New — one file per seam plus unit tests       |
| `agents/*.md`               | New — example agent definitions               |
| `README.md`, `CONTEXT.md`   | New                                           |

## Parallel Execution

> [!IMPORTANT]
> Only delegate a slice to a fire-and-forget subagent if it is
> independent, well-specified, touches files no other slice touches,
> and won't need interactive steering. A sealed subagent can't be
> redirected mid-flight — it ploughs ahead while objections pile up.
> Work you expect to iterate on belongs in the main thread or a
> chat-able teammate. For editing work that still benefits from
> parallel scanning, prefer a two-phase split: a read-only subagent
> returns a proposed-change list, then the main thread applies edits
> with the user able to veto each one.

Most of this is sequential. Slices 1 and 2 establish types every later
slice consumes, and Slices 8–10 are UI work you will want to look at
and adjust as it appears — that belongs in the main thread.

One genuine fan-out exists. After Slice 3 lands, four slices touch
disjoint files and share no unresolved blocker:

| Subagent Role                          | Slices  |
| -------------------------------------- | ------- |
| Concurrency and turn limits            | 4, 5    |
| Lifecycle control and persistence      | 6, 7    |

Both are well-specified, file-disjoint, and unlikely to need steering.
Everything else runs in the main thread.

## Notes & Caveats

- **The in-process choice makes Task 1.5 load-bearing.** Subagents
  share the host process, so an uncaught error in a child is your
  session. Every path into a child session must be inside that catch.
- **Two internals are version-sensitive.** `DefaultResourceLoader`'s
  option shape and `createAgentSession`'s model plumbing both changed
  in the 0.80.x series — the reference implementation carries a
  workaround for the second
  (`tintinweb-pi-subagents/src/agent-runner.ts:910-927`). Pin the Pi
  dev dependency and expect to revisit these on upgrade.
- **Pi activates only its default built-in tools on the first turn.**
  An agent's `tools:` allowlist may need re-deriving after
  `bindExtensions()`; the reference implementation does exactly this
  (`tintinweb-pi-subagents/src/agent-runner.ts:960-974`). Watch for it
  in Slice 1 if a child appears to ignore its tool list.
- **A bad `tools:` entry fails silently upstream.** Pi accepts an
  unknown tool name into the allowlist then drops it at registration
  with no signal. Validate against the known built-ins at discovery
  and warn.
- **Open question carried from the spec**: the default concurrency
  limit is assumed to be 5, matching one full column.
- **Two ADRs record the decisions behind this plan**:
  [in-process subagent sessions](../adr/2026-08-22-in-process-subagent-sessions.md)
  and
  [self-describing tool names](../adr/2026-08-22-self-describing-tool-names.md).
