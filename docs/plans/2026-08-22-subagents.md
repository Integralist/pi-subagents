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
  "@earendil-works/pi-agent-core": "*",
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

`@earendil-works/pi-agent-core` joined the peers in Task 2.2. It owns
the `ThinkingLevel` that pi's own session and extension surfaces use —
the one including `"off"` — where `pi-ai` exports a narrower type of the
same name.

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

| Layer | Base            | Includes     | Branch          |
| ----- | --------------- | ------------ | --------------- |
| 1     | `main`          | Slices 1–2   | `foundation`    |
| 2     | `foundation`    | Slices 3–7   | `lifecycle`     |
| 3     | `lifecycle`     | Slices 8–10  | `subagent-list` |
| 4     | `subagent-list` | Slices 11–12 | `mentions`      |

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

- [x] **Task 1.4**: Implement `runSubagent()` in `src/runner.ts`.

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

  Everything above verified against 0.84.2. Four corrections landed
  with the implementation:

  - **`signal` cannot be passed through.** `PromptOptions` has no
    abort field, so the caller's signal is wired to `session.abort()`
    via an `abort` listener instead, and an already-aborted signal
    returns before any session is built.
  - **The last assistant message must be found by hand.**
    `_findLastAssistantMessage` is private; the public `session.messages`
    is walked backwards instead. Only `type: "text"` blocks contribute
    to the output, so thinking and tool calls stay out of it.
  - **`stopReason` decides the status**, rather than assuming success.
    `"aborted"` maps to `stopped` and `"error"` to `failed`, carrying
    the model's own `errorMessage` back. A run with no assistant reply
    at all is `failed`, not an empty success.
  - **`session.dispose()` must be called** in a `finally`, or the child
    keeps its agent-event listeners attached.

  > [!NOTE]
  > **`systemPromptOverride` is the right choice, not just a valid
  > one.** The loader also accepts a plain `systemPrompt: string`, but
  > that value is treated as a prompt *source* and passed to
  > `existsSync` (`dist/core/resource-loader.js:16-30`), so an agent
  > whose body happened to look like a path would silently load that
  > file. The override's return value is used verbatim.

  Two caveats from Notes & Caveats did **not** bite at 0.84.2:
  `DefaultResourceLoader`'s option shape matches the plan, and the
  `Model<any>` in `pi-ai` and `pi-ai/compat` are mutually assignable,
  so `createAgentSession`'s model plumbing needs no workaround. Written
  as `Model<Api>` to satisfy Biome's `noExplicitAny` without a
  suppression.

  Added to the signature: `createSession?: SessionFactory`, the
  "stubbed session factory" the specification names as its primary
  testing seam.

- [x] **Task 1.5**: Wrap every run so no subagent failure escapes.

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

  Implemented as an outer `try` around the whole run, so the loader,
  both managers, the session factory, and the prompt are all inside it.
  Two holes left by Task 1.4 are now closed, and neither was in the
  plan:

  - **Teardown could decide the outcome.** A `dispose()` that threw in
    the `finally` replaced a good answer with a failure. It is now
    guarded separately.
  - **`void session.abort()` dropped a promise.** `void` does not
    observe a rejection, and that call runs from an `abort` event
    listener, so a rejecting `abort()` had nowhere to surface but the
    process — the exact crash this task exists to prevent.

  > [!NOTE]
  > **`bindExtensions({ onError })` is not called, and would be inert
  > if it were.** With `noExtensions: true` and no
  > `additionalExtensionPaths`, the child loads zero extensions
  > (`dist/core/resource-loader.js:315-317`), so no extension can raise
  > an error for the listener to receive. The nuance worth remembering:
  > `noExtensions` suppresses only the *settings-configured*
  > extensions; anything in `additionalExtensionPaths` still loads. A
  > future change that passes that option to the child would both need
  > this listener and re-open the recursion hole Task 1.6 guards.

  `SubagentError` takes `agentName`, not the plan's `agentId` — there
  are no subagent ids until the registry in Slice 3. It is constructed
  but never thrown, since this function returns outcomes; it exists to
  give every failure one message shape naming the agent, and to keep
  the original `cause` attached.

  One test seam is worth knowing about: **`unhandledRejection` cannot
  be asserted on under vitest**, which installs its own handler, so a
  test watching for it passes even against the dropped-promise bug.
  The rejection is instead probed with a thenable that records whether
  the caller supplied a rejection callback.

- [x] **Task 1.6**: Add the recursion guard.

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

  Lives in `src/runner.ts` rather than a module of its own: six lines,
  used by the runner and by `index.ts` in Task 1.7. `runSubagent` wraps
  the whole run, so every tool call a child makes is marked too.

  The guard is worth more than "belt and braces". Task 1.5 established
  that `noExtensions: true` suppresses only the *settings-configured*
  extensions — anything in `additionalExtensionPaths` still loads
  (`dist/core/resource-loader.js:315-317`). Today the child passes no
  such paths, so it loads nothing; the day one is passed down, this
  flag is the only thing standing between a subagent and unbounded
  recursion.

  > [!IMPORTANT]
  > **Testing this needs a gate, not a race.** The obvious test — start
  > a wrapped run and a bare sibling concurrently, then check the
  > sibling sees `false` — passes even against a plain module-level
  > boolean, because the child finishes and clears the flag before the
  > sibling looks. Hold the child suspended on a promise the test
  > controls and read the flag while it is genuinely mid-flight. Only
  > that ordering distinguishes `AsyncLocalStorage` from a global.

- [x] **Task 1.7**: Register `spawn_subagent` in `src/index.ts`.

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

  Both `typebox` and `@earendil-works/pi-ai` export **the identical
  `Type` object** (verified by reference equality), so the plan's
  `typebox` import is kept even though Pi's own examples import from
  `pi-ai`. It is the direct source, and it justifies the `typebox`
  peer dependency.

  Three things settled here that earlier tasks deferred:

  - **The child-context refusal** from Task 1.6 now has a reader:
    `execute` throws before doing anything if `inChildContext()`.
  - **Tool-name validation** from Task 1.3, done here rather than at
    discovery because only `pi.getAllTools()` knows the real set, and
    it is read lazily — other extensions register tools too, and the
    full set settles only once the session runs. Unknown names are
    dropped from the allowlist and reported in the result text.
  - **The agent file's `thinking` level is honoured now.** It needs no
    resolution. Its `model` is a *name*, so it waits for
    `resolveModel` in Slice 2.

  > [!NOTE]
  > **A tool reports failure by throwing.** `AgentToolResult` has no
  > `isError` field; Pi's agent loop catches a thrown error from
  > `execute` and converts it to `isError: true` carrying the message
  > (`pi-agent-core/dist/agent-loop.js:472-478`). So the spec's
  > "refuses an unknown subagent type" is a `throw`.

  A deliberate asymmetry: bad arguments (unknown type, no agents
  defined, spawning from a child) **throw**, but a subagent that ran
  and *failed* comes back as an ordinary result with
  `details.status: "failed"`. The delegation worked; the subagent's
  failure is information the main agent should reason about, and
  throwing would also discard whatever partial output it produced.

  Verified beyond the unit tests: the module loads under **Pi's own
  jiti transpiler** and registers `spawn_subagent` with the three
  expected required parameters. That check matters because the
  `.ts`-suffixed imports work under vitest but could have failed under
  a different loader.

  > [!WARNING]
  > **The slice is not demoable yet.** This repository has no
  > `.pi/agents/` directory, so the tool correctly reports that no
  > subagents are defined. The example agent files in the
  > Documentation checklist are what make a live walkthrough possible.
  > Note also that `pi` cannot write `~/.pi/agent/settings.json.lock`
  > under the sandbox used here, so the live check has to run outside
  > it.

- [x] **Task 1.8**: Tests at the tool boundary.

  Build a fake `ExtensionContext` and inject a stubbed session factory.
  Cover: inherits parent model and effort; unknown subagent type is
  refused with the list of known types; a throwing session yields a
  failed outcome; the parent is unaffected.

  Two depths of tool-boundary test, and the distinction matters:

  - `test/index.test.ts` stubs `runSubagent` itself, to test the tool's
    own decisions — which agent, which allowlist, which refusal.
  - `test/tool-boundary.test.ts` wires the **real** runner and stubs
    only the session factory, which is what this task asks for. Its
    `describe` / `it` names quote the specification's scenarios
    verbatim.

  All four required cases are covered, three of them end to end.
  "Leaves sibling subagents working" is included as far as Slice 1
  reaches — two overlapping runs, one failing — with real concurrency
  left to Slice 3.

  > [!IMPORTANT]
  > **The full-stack test found a wording defect the shallow ones could
  > not.** Both the runner and the tool named the agent, so a contained
  > crash read `The "reviewer" subagent failed: subagent "reviewer" failed: no model configured`, while a *provider* error named it only
  > once because the runner did not prefix that path. Fixed by one
  > invariant: **an outcome's `error` always names its agent**, built by
  > a single `failureReason` helper, and the tool reports it verbatim.
  > This changed the Task 1.5 assertion that pinned the old
  > provider-error wording.

### Slice 2: Model and effort overrides with fuzzy name resolution

- **Blocked by**: Slice 1 (needs `spawn_subagent` and `runSubagent`)

- **Delivers**: `spawn_subagent({ model: "flash", thinking: "low" })`
  runs the child on a different model than the parent.

- **Consumes**: `runSubagent(opts: RunSubagentOptions)` from Slice 1.

- **Produces**: `resolveModel()`.

- **Execution**: **`/tasks` candidate.** `resolveModel` is a pure function over
  `ModelRegistry.getAll()`, which is already verified. Fully mechanical.

- [x] **Task 2.1**: Implement fuzzy resolution in `src/model-resolver.ts`.

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

  Four decisions the signature left open:

  - **The not-ok result carries `reason: "unknown" | "ambiguous"`.**
    Without it the caller cannot tell "no such model, here is
    everything" from "'gpt' matches four, here are those four" — and
    `available` means a different set in each case. Distinguishing it
    here beats making every caller infer it.
  - **Ambiguity is terminal at its tier**, not retried against the
    looser ones. Falling through would let a broader query succeed
    where a narrower one failed, which is harder to predict than
    refusing.
  - **Comparisons are case-insensitive and the query is trimmed**,
    including the two "exact" tiers. A caller typing `"Flash"` meant
    `flash`.
  - **Takes a model list, not a `ModelRegistry`.** The signature in this
    task said `registry`, but the caller has to decide *which* models
    are candidates — see Task 2.2 — so a registry is the wrong
    parameter. `resolveModel(models, query)` is a pure function over a
    list, and `modelLabel` is exported alongside it so a caller can map
    a chosen label back to its model.

  > [!NOTE]
  > **The `getAll()` choice was revised in Task 2.2.** It read the whole
  > catalogue, which lists models the user has no access to, so `"flash"`
  > could resolve to something unrunnable. Candidate selection moved to
  > the caller and now prefers the user's scoped set. The note that this
  > was "worth revisiting if it proves confusing" was answered within
  > the same slice.

- [x] **Task 2.2**: Add `model` and `thinking` to the tool schema.

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

  > [!IMPORTANT]
  > **`ThinkingLevel` is not one type — settled here.**
  > `pi-agent-core/dist/types.d.ts:260` includes `"off"`;
  > `pi-ai/dist/types.d.ts:23` does **not**, naming the with-`off`
  > version `ModelThinkingLevel`. Slice 1 imported from `pi-ai`, so
  > `"off"` could not reach a child even though pi accepts it.
  > **Resolved by importing `ThinkingLevel` from `pi-agent-core`** in
  > `src/agents.ts`, `src/runner.ts`, and `src/index.ts`, and adding
  > that package to `peerDependencies` (`"*"`) and `devDependencies`
  > (`0.84.2`). Both pi surfaces this code feeds —
  > `CreateAgentSessionOptions.thinkingLevel` and
  > `ExtensionContext.thinkingLevel` — use that spelling, and pi's own
  > `--thinking` flag offers `off`, so dropping it would have lost a
  > capability pi has. It is a type-only import of a package pi already
  > bundles.

  Precedence, in both directions: **the caller's argument wins over the
  agent file, and naming neither inherits the parent.** Resolution
  happens before the run starts, so a bad model name never fails
  partway into a session.

  Two behaviours beyond the plan's text, added on request once it was
  clear `"flash"` is genuinely ambiguous against a real catalogue.

  **Candidates are the models the user can actually run**, narrowest
  set first: `ctx.scopedModels` (from `enabledModels` or `--models`),
  else `registry.getAvailable()` (configured auth), else
  `registry.getAll()`. Resolving against the full catalogue could
  return a model the user has no access to — the concrete case being a
  catalogue entry that is simply not theirs.

  **An ambiguous name asks the user** through
  `ctx.ui.select(title, options, { signal })`, which pi exposes for
  exactly this. The abort signal is passed so the dialog dies with the
  turn. Measured against a real 10-model `enabledModels`, `"opus"` and
  `"gpt"` are both ambiguous, so this is the common case rather than an
  edge one.

  - **Dismissing the dialog inherits the parent's model.** Chosen
    deliberately over refusing. The tool result then says the subagent
    ran on the current model, so the substitution is visible to the
    main agent rather than silent.
  - **No dialog-capable UI (`ctx.hasUI === false`) still refuses**, with
    the candidates listed. Blocking on a dialog nobody can see would
    hang a `--print` or headless run.
  - **An unknown name refuses rather than prompting.** A name matching
    nothing is a mistake, not a decision, and turning every typo into a
    dialog would train the user to dismiss them.

  This supersedes the earlier "refuses an ambiguous model name" test,
  which is removed; the no-UI refusal covers that path.

  > [!NOTE]
  > **A bare `thinking: off` in an agent file is the string `"off"`, not
  > a boolean.** An earlier note in this plan claimed it had to be
  > quoted, on the YAML 1.1 rule that reads `off`/`on`/`yes`/`no` as
  > booleans. That is wrong here: pi parses with `yaml@2.9.0`, which
  > follows YAML **1.2**, where only `true` and `false` are booleans.
  > Verified against pi's own `parseFrontmatter`. No quoting needed;
  > `thinking: false` *is* a boolean and is still dropped.

### Slice 3: Background execution, registry, and completion notices

- **Blocked by**: Slice 1

- **Delivers**: Spawning returns immediately with an id; the subagent
  works in the background; its result arrives in the conversation when
  it finishes. `get_subagent_result` reads it back on demand.

- **Consumes**: `runSubagent`, `SubagentOutcome` from Slice 1.

- **Produces**: `SubagentRecord`, `SubagentRegistry`, `assignColor()`.

- **Execution**: **Main thread.** Wires into Pi's message delivery and event
  stream; behaviour needs observing, not just reading.

- [x] **Task 3.1**: Define the record and registry in `src/registry.ts`.

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

  export type SubagentRecordChanges = Partial<Omit<SubagentRecord, "id">>;

  export class SubagentRegistry {
    add(record: SubagentRecord): void;
    get(idOrHandle: string): SubagentRecord | undefined;
    update(
      idOrHandle: string,
      changes: SubagentRecordChanges,
    ): SubagentRecord | undefined;
    list(): SubagentRecord[];        // launch order, earliest first
    running(): SubagentRecord[];
    onChange(listener: () => void): () => void;
  }
  ```

  `onChange` is what the UI in Slice 8 subscribes to.

  > [!NOTE]
  > **Delivered with an `update` method the sketch above lacked.** Tasks
  > 3.2 and 3.4 both change a record after it is added — `contextPercent`,
  > `turns`, `status`, `outcome` — and mutating the object returned by
  > `get()` notifies nobody, so the Slice 8 list would render a status
  > that had already moved on. Routing every write through one method
  > makes the notification impossible to forget. `Omit<…, "id">` keeps a
  > record's identity out of reach.
  >
  > Two further decisions, both mutation-tested. `list()` sorts on
  > `startedAt` rather than trusting insertion order, so a record added
  > late — a session resumed in Slice 7 — still lands in launch order;
  > the sort is stable, so subagents launched in the same millisecond
  > keep their add order. `running()` counts only `running`, excluding
  > `queued`, because Slice 4 compares that count against the
  > concurrency limit and counting the queue would wedge it shut.

- [x] **Task 3.2**: Track context-window use per subagent.

  `session.getContextUsage()` returns `ContextUsage | undefined`, where
  `ContextUsage` is
  `{ tokens: number | null, contextWindow: number, percent: number | null }`
  (`dist/core/extensions/types.d.ts:193-199`,
  `dist/core/agent-session.d.ts:616`). Read it on each `turn_end` from
  `session.subscribe()` and store `percent` on the record. `percent` is
  null right after compaction; render a blank rather than `0%`.

  > [!NOTE]
  > **Two corrections to the sketch above, both verified against the
  > installed SDK.** `getContextUsage()` is typed `ContextUsage | undefined`, not `ContextUsage` — so there are three separate ways the
  > figure can be unknown: no usage object, a null `percent`, or a read
  > that threw. `readContextPercent` folds all three to null, because zero
  > would claim an empty context rather than an unknown one.
  >
  > `session.subscribe()` emits the `AgentEvent` spelling of `turn_end`,
  > `{ type, message, toolResults }` (`pi-agent-core/dist/types.d.ts:382`).
  > The `turnIndex` field belongs to the extension bus's separate
  > `TurnEndEvent` (`dist/core/extensions/types.d.ts:556`) and is not
  > available here — Slice 5 will have to count turns itself rather than
  > read an index off this event.
  >
  > Delivered as `trackContextUsage(session, registry, idOrHandle)`,
  > returning the session's own unsubscribe. It takes a
  > `ContextUsageSource` — `Pick<AgentSession, "subscribe" | "getContextUsage">` — so a test supplies a stub rather than a live
  > session. The listener runs inside the child's event dispatch, so
  > nothing in it may throw: the read is guarded, and updating a record
  > that has already gone is a no-op.

- [x] **Task 3.3**: Assign a colour per subagent in `src/colors.ts`.

  ```typescript
  export function assignColor(index: number, configured?: string): string;
  ```

  Frontmatter `color:` wins; otherwise take the next entry from a fixed
  palette by launch index, wrapping when exhausted. Deterministic, so a
  subagent keeps its colour for life.

  > [!NOTE]
  > Delivered with a six-name `PALETTE` exported alongside, so the list in
  > Slice 8 and the tests share one source of truth rather than each
  > carrying a copy. Colour *names* travel on the record, not escape
  > codes — turning a name into a colour is the renderer's job, under
  > whatever theme is loaded. An index past the end of the palette falls
  > back to the first colour rather than handing a renderer an
  > `undefined`, which `noUncheckedIndexedAccess` forces to be handled
  > either way.

- [x] **Task 3.4**: Run detached and notify on completion.

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

  > [!NOTE]
  > **Delivered as `src/spawn.ts`**, a file the plan's table did not list.
  > Detaching a run is neither session-building (`runner.ts`) nor
  > record-keeping (`registry.ts`), and folding it into `index.ts` would
  > have mixed tool schemas with lifecycle orchestration.
  >
  > **`sendMessage` lives on `pi`, not on `ctx`.** The `ExtensionContext`
  > handed to a tool's `execute` has no such method
  > (`dist/core/extensions/types.d.ts`, the `ExtensionContext`
  > interface), so the notifier is captured at registration and bound —
  > it is called later from a background continuation with no `pi` in
  > scope. It returns `void`, not a promise.
  >
  > **The tool call's `AbortSignal` must not reach the run.** The call is
  > over the moment it returns an id, and its signal aborts with it, so
  > passing it down — as Slice 1 correctly did — would now kill every
  > subagent at birth. Stopping one deliberately is Slice 6's. Slice 1's
  > "hands the caller's abort signal to the runner" test is inverted
  > accordingly.
  >
  > **`runSubagent` gained an `onSession` callback.** Task 3.2's
  > `trackContextUsage` had no possible caller until now: the runner
  > builds, prompts and disposes the child session without ever exposing
  > it. `onSession` fires once the session exists and before it is
  > prompted, so tracking is listening from the first turn. Its body is
  > guarded on its own account — it runs inside the runner's crash guard,
  > so an unguarded throw would report a perfectly good run as failed,
  > letting telemetry break the work it exists to watch.
  >
  > **Failure notices are headlined by id alone.** An outcome's `error`
  > already names its agent, so a headline naming it too reproduces the
  > `subagent "reviewer" failed: subagent "reviewer" failed: …` doubling
  > that commit `d78fb0d` removed. A test now pins the name to exactly
  > one occurrence.
  >
  > Handles are still just the agent's type name — Slice 11 makes them
  > unique. Until then the id is what tells two subagents of a kind
  > apart, so every notice carries it.

- [x] **Task 3.5**: Register `get_subagent_result`.

  Parameters: `id: Type.String()`. Returns the full output for a
  finished subagent; for a running one, returns a message saying so
  and no output.

  > [!NOTE]
  > An id that was never issued is refused outright, listing the ids
  > that were — consistent with how an unknown subagent type is handled,
  > and a typo is a mistake rather than a decision. Both tools share one
  > `SubagentRegistry` created in the extension factory. The tool
  > description tells the model its answer will arrive on its own, so
  > this is not turned into a polling loop.

- [x] **Task 3.6**: Tests at the tool boundary.

  Cover: spawn returns an id without waiting; the completion message is
  delivered as a follow-up with `triggerTurn`; result of a finished
  subagent returns its text; result of a running one reports unfinished.

  > [!NOTE]
  > "Without waiting" is tested over a run that never resolves, so a tool
  > that waited would hang the test rather than fail it on a timing
  > coincidence. An earlier version asserted that no notice had been sent
  > by the time `execute` returned; with an instantly-resolving stub that
  > races the microtask queue and tests nothing.
  >
  > Every Slice 1 boundary test that read an answer out of the tool
  > result now awaits the notice instead. Two fakes had to grow
  > `subscribe` and `getContextUsage`, since context tracking attaches to
  > the child the moment it exists.

### Slice 4: Concurrency limit with queueing

- **Blocked by**: Slice 3 (needs the registry and detached runs)

- **Delivers**: Spawning past the limit queues rather than running;
  queued subagents start as slots free.

- **Consumes**: `SubagentRegistry`, `SubagentRecord` from Slice 3.

- **Produces**: `SubagentQueue`.

- **Execution**: **`/tasks` candidate.** Pure queue logic, no SDK surface.

- [x] **Task 4.1**: Implement the queue in `src/queue.ts`.

  ```typescript
  export class SubagentQueue {
    constructor(limit: number) {}
    submit(run: () => Promise<void>): void;
    get queuedCount(): number;
  }
  ```

  FIFO. On a run settling — resolved *or* rejected — start the next.
  Use `finally`, not `then`, or one failure stalls the queue forever.

  Given a limit of 3 and 3 running, when a fourth is submitted, then
  it is queued and `queuedCount` is 1. When one finishes, then the
  queued one starts.

  > [!NOTE]
  > **`submit` takes no `id`.** Nothing in this slice reads one: the
  > queue hands out slots to thunks and never needs to name them, and
  > the caller already holds the record. An unused parameter cannot be
  > tested, which is the tell. Slice 6 should add it back at the moment
  > cancelling a *queued* subagent gives it something to identify.
  >
  > **Slice 6 added it back**, as `submit(id, run)` alongside
  > `cancel(id): boolean`. Stopping a subagent that never got a slot has
  > to reach into the waiting list, and the id is the only handle on it.
  > The queue still knows nothing about subagents — the id is opaque to
  > it, and what it means stays the caller's business.
  >
  > `cancel` frees no slot, because a waiting submission never held one;
  > freeing one would run a subagent over the limit for every
  > cancellation. It reports `false` both for an id it has never seen and
  > for one already running, which is what tells `stopSubagent` to go and
  > abort the session instead. Both are mutation-tested, as is the
  > removal being by id rather than from the front of the queue — the
  > first version of that test cancelled the front entry and so passed
  > against either implementation.
  >
  > Two guarantees the sketch does not mention, both mutation-tested. A
  > limit below one is clamped to one — accepting subagents and starting
  > none of them reads as a hang rather than as a setting. And the
  > `finally` that frees a slot is paired with a `catch`: `finally`
  > alone lets the rejection escape a promise nobody awaits, which is an
  > unhandled rejection and by default takes the host process down.
  >
  > Wiring it up put the status transition in `startSubagent`, not in
  > the queue: a record is born `queued` and its own submitted thunk
  > flips it to `running`. With a slot free the queue calls that thunk
  > synchronously, so nobody ever sees the intermediate state. That is
  > what keeps `queue.ts` free of any subagent vocabulary at all.
  > `startedAt` is still stamped at submission rather than at start, so
  > `list()` stays in the order the user asked rather than reordering
  > itself as slots free.

- [x] **Task 4.2**: Make the limit configurable, defaulting to 5.

  Read from Pi settings, falling back to 5 — matching the point at
  which the list gains a second column, so the default fills exactly
  one column.

  > [!NOTE]
  > **Pi's `Settings` is a closed interface with nowhere to declare an
  > extension's own key**, and neither `ExtensionContext` nor
  > `ExtensionAPI` exposes a settings reader —
  > `registerFlag`/`getFlag` are the only configuration surface offered
  > to extensions. What makes this work anyway: settings are loaded with
  > a plain `JSON.parse` and migrated, with no schema stripping
  > (`dist/core/settings-manager.js`, `loadFromStorage`), so an unknown
  > `subagents.limit` key survives and can be read back off
  > `getProjectSettings()` / `getGlobalSettings()`.
  >
  > Project settings win over global, matching
  > `deepMergeSettings(globalSettings, projectSettings)` everywhere else
  > in pi. A limit that is not a whole number above zero is treated as
  > absent and the next source is tried, so a typo in a project file
  > does not silently veto a perfectly good global one.
  >
  > **No guard around the read.** `SettingsManager.create` routes both
  > loads through `tryLoadFromStorage` and so reports an unreadable or
  > unlockable settings file as empty settings rather than throwing —
  > verified against the installed SDK with an agent directory that is a
  > file, that does not exist, that is `/dev/null`, and that is
  > read-only. A `catch` here would be unreachable, so there is not one;
  > a test pins pi's behaviour, since the code now depends on it.

### Slice 5: Turn limits with a graceful wrap-up

- **Blocked by**: Slice 3

- **Delivers**: A subagent warned at its turn limit returns a usable
  answer; one that ignores the warning is stopped.

- **Consumes**: `SubagentRecord`, and the `turn_end` subscription from
  Task 3.2.

- **Produces**: `watchTurns` in `src/turns.ts`.

- **Execution**: **`/tasks` candidate** once Slice 3 lands — turn counting
  inside an existing subscription is mechanical.

- [x] **Task 5.1**: Count turns and inject the warning.

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

  > [!NOTE]
  > **Delivered as its own subscription in `src/turns.ts`, not inside
  > the existing one.** That instruction predates Task 3.2, which put
  > the `turn_end` subscription in `trackContextUsage` — a function with
  > no business enforcing anything. `session.subscribe()` takes any
  > number of listeners, so `watchTurns` takes its own and the two stay
  > independently testable and independently removable.
  >
  > Turns are counted whether or not there is a limit, since the list
  > shows the count either way.
  >
  > `steer` and `abort` are both promises nobody awaits, called from
  > inside the child's event dispatch, so both go through a helper that
  > swallows the rejection: a warning that cannot be delivered is a lost
  > courtesy, and neither is worth a failed run — or an unhandled
  > rejection in the host process.

- [x] **Task 5.2**: Hard-abort after the grace turns.

  At `maxTurns + graceTurns` call `session.abort()`
  (`dist/core/agent-session.d.ts:433`) and mark the outcome incomplete.
  Grace defaults to 3.

  `maxTurns` resolution order: caller parameter, then frontmatter
  `maxTurns:`, then the default of 30.

  > [!NOTE]
  > **The frontmatter key is `maxTurns:`, not `max_turns:`.** This line
  > said the latter; Task 1.3's own `AgentConfig` sketch and
  > `src/agents.ts` both say the former, and every other frontmatter
  > field is camelCase. Corrected here rather than in the code.
  >
  > **The caller parameter did not exist until now.** The resolution
  > order named three levels and only two were reachable, so
  > `spawn_subagent` gained `max_turns`, following exactly the pattern
  > `model` and `thinking` already set in Task 2.2.
  >
  > **Unlimited-by-default was replaced by a default of 30 during Slice
  > 6**, on the user's decision. As written, this line left an agent file
  > with no `maxTurns:` running until it stopped itself — no runaway
  > protection at all for exactly the agents most likely to need it, and
  > a product decision the specification never states. `DEFAULT_MAX_TURNS = 30` now lives in `src/turns.ts` beside `DEFAULT_GRACE_TURNS`, so
  > every subagent warns at 30 and stops at 33 unless it says otherwise.
  > Thirty sits clear of honest work while still catching a subagent that
  > has stopped making progress; the warn-then-stop shape means one that
  > is merely slow still gets to answer.
  >
  > That made `watchTurns`' `limit` parameter required rather than
  > optional: with `turnLimit()` always returning one, the no-limit
  > branch became unreachable and its test would have been testing dead
  > code. The value is pinned by a test of its own, since it is a product
  > decision rather than an implementation detail.
  >
  > "Marked incomplete" needed somewhere to live. An aborted session
  > already summarises as a `stopped` outcome, but that says only that
  > the subagent did not finish, leaving the main model to read a
  > truncated answer as a final one. `SubagentRecord` gained
  > `stoppedBecause?: string`, written *before* the abort so it is on
  > the record by the time the run settles and the notice is composed,
  > which now reads "was stopped because … Its answer, if any, is
  > incomplete." Slice 6 should reuse the field for a subagent the user
  > stops.

### Slice 6: Steering and stopping

- **Blocked by**: Slice 3

- **Delivers**: `steer_subagent` redirects a running subagent;
  `stop_subagent` halts one and keeps its partial output.

- **Consumes**: `SubagentRegistry.get()`, `SubagentRecord.session`.

- **Produces**: `steerSubagent()`, `stopSubagent()` — reused by the UI
  in Slice 10 and mentions in Slice 11.

- **Execution**: **`/tasks` candidate** once Slice 3 lands — thin wrappers over
  `session.steer()` and `session.abort()`, both verified.

- [x] **Task 6.1**: Implement the two operations in `src/control.ts`.

  ```typescript
  export type ControlResult =
    | { ok: true }
    | { ok: false; reason: string };

  export async function steerSubagent(
    record: SubagentRecord, message: string,
  ): Promise<ControlResult>;

  export async function stopSubagent(
    record: SubagentRecord, deps: ControlDeps,
  ): Promise<ControlResult>;
  ```

  Steering a finished subagent fails with a reason rather than
  throwing — the UI and the mention handler both need to show it.
  Separate functions from the tools, because three callers need them.

  > [!NOTE]
  > **`stopSubagent` takes a second parameter the sketch does not have**,
  > `{ registry, queue }`. Two reasons, both load-bearing. The registry,
  > because `SubagentRecord.stoppedBecause` has to be written and
  > `registry.update()` is documented as the only door — mutating the
  > record directly works and notifies nobody, leaving the Slice 8 list
  > showing a status that has already moved on. The queue, because a
  > subagent that never got a slot is stopped by dropping it from the
  > queue and has no session to abort.
  >
  > **The two cases end differently, and the asymmetry is deliberate.** A
  > *running* subagent gets `stoppedBecause` recorded and its session
  > aborted, and nothing more: the run is in flight and will settle into
  > a stopped outcome of its own, which is what sets the status and sends
  > the notice. Setting the status here would race that, and would mark a
  > subagent stopped that the abort had arrived too late to stop. A
  > *queued* one has no run to settle it, so its status and a
  > `{ status: "stopped", output: "" }` outcome are written here — without
  > the outcome the record reads as still working and
  > `get_subagent_result` would keep saying so for the rest of the
  > session.
  >
  > **`stoppedBecause` is `"you asked it to stop"`**, reusing the field
  > Task 5.2 introduced as that note anticipated. Worded to compose with
  > the notice's existing "was stopped because …" sentence.
  >
  > **Reasons name no subagent.** They are bare clauses — "it has already
  > finished" — because the callers name it differently: a tool by type
  > and id, the Slice 10 list by the row the message sits under. Naming
  > it here too would double it up in one place or the other, which is
  > the mistake commit `d78fb0d` already had to undo once.
  >
  > Three cases the sketch does not mention. An empty or whitespace-only
  > steering message is refused, since a tool argument is a system
  > boundary and a blank steer is noise delivered to a subagent. A record
  > is `running` from the moment it takes a slot, a fraction *before* the
  > run has built its session, so both operations test `record.session`
  > rather than the status — steering into that window would reach for a
  > session that is not there. And the message is delivered exactly as
  > written: trimming it would quietly rewrite one whose indentation was
  > the point.

- [x] **Task 6.2**: Register `steer_subagent` and `stop_subagent`.

  `steer_subagent`: `{ id: Type.String(), message: Type.String() }`.
  `stop_subagent`: `{ id: Type.String() }`.

  > [!NOTE]
  > **A refusal is thrown, not returned as text.** `ControlResult` exists
  > so the *UI* can display a reason, but a tool result the model reads
  > as success would leave it believing it had redirected a subagent that
  > in fact finished a moment earlier. A thrown tool error is the one
  > result it cannot misread. The functions still return rather than
  > throw, because Slice 10 needs them to.
  >
  > **`AgentToolResult` requires `details`**, so these two carry a
  > `ControlDetails` — `{ id, agent, status, description }` — rather than
  > content alone. Read off the record *after* the operation, so a stop
  > that dropped a queued subagent reports it as stopped rather than as
  > it found it. Reusing `SpawnDetails` would have meant a meaningless
  > `unknownTools: []` on every control result.
  >
  > **The "no subagent with id" lookup was extracted** to `requireRecord`
  > now that three tools take an id.
  >
  > **No child-context guard on these two**, unlike `spawn_subagent`.
  > That guard exists because spawning recursively forks the host process
  > without bound; steering a sibling is merely useless, and a subagent
  > cannot obtain an id to try it with.

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
  9\.

- [ ] **Task 10.1**: Build the viewer.

  Subscribe to that subagent's `session.subscribe()` and render its
  conversation, auto-following new content. Escape returns to the list.

- [ ] **Task 10.2**: Steer from the viewer.

  Enter opens a composer; submitting calls `steerSubagent(record, text)`.
  An empty submit or escape returns without sending.

- [ ] **Task 10.3**: Stay open when the subagent finishes.

  The viewer must survive completion so the final output is readable —
  it closes only on escape.

- [ ] **Task 10.4**: Announce a subagent the user stopped from the UI.

  Left open by Slice 6, and only reachable once there is a UI to stop
  one from. `stopSubagent` sends no completion notice: on the tool path
  the model reads the outcome in the tool result, so none is needed.
  Stopping a subagent from the list has no such result, which leaves the
  main model waiting for an answer that will never arrive — it was told
  at spawn that "its result will arrive here when it is done".

  Worst for a *queued* subagent, whose run never starts and so never
  settles; a running one at least settles into a stopped outcome that
  `runAndAnnounce` reports. Wiring `sendMessage` into the UI's stop path
  is the fix. Deliberately not built in Slice 6, where nothing could
  reach it.

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

| File                      | Change                                     |
| ------------------------- | ------------------------------------------ |
| `package.json`            | New — Pi manifest, peer deps, scripts      |
| `tsconfig.json`           | New — TypeScript config                    |
| `biome.json`              | New — lint and format config               |
| `vitest.config.ts`        | New — test config                          |
| `.gitignore`              | New                                        |
| `src/index.ts`            | New — factory, tool and event registration |
| `src/agents.ts`           | New — agent file discovery                 |
| `src/runner.ts`           | New — nested session creation, crash guard |
| `src/registry.ts`         | New — records, status, context tracking    |
| `src/spawn.ts`            | New — detached runs, completion notices    |
| `src/queue.ts`            | New — concurrency limit                    |
| `src/turns.ts`            | New — turn counting, warning, hard stop    |
| `src/control.ts`          | New — steer and stop                       |
| `src/model-resolver.ts`   | New — fuzzy model matching                 |
| `src/colors.ts`           | New — palette assignment                   |
| `src/mention.ts`          | New — `@name` parsing                      |
| `src/ui/layout.ts`        | New — column splitting                     |
| `src/ui/subagent-list.ts` | New — the list and its key handling        |
| `src/ui/viewer.ts`        | New — live conversation view               |
| `test/*.test.ts`          | New — one file per seam plus unit tests    |
| `agents/*.md`             | New — example agent definitions            |
| `README.md`, `CONTEXT.md` | New                                        |

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

| Subagent Role                     | Slices |
| --------------------------------- | ------ |
| Concurrency and turn limits       | 4, 5   |
| Lifecycle control and persistence | 6, 7   |

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
