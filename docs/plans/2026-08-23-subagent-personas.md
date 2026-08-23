# Subagent Personas and Listing

- **Status**: Planning
- **Author**: Integralist
- **Created**: 2026-08-23
- **Language**: TypeScript

## Summary

A skill can ask for a subagent with a character of its own — "a security
expert", "a performance analyst" — instead of naming an agent file that
somebody wrote first. The main agent supplies a system prompt, the tools
the subagent may use, and a short name it invents itself, and gets back a
subagent that behaves like any other: it appears in the list, it can be
watched and steered, and it can be reached by `@name` and continued after
it finishes. Alongside it, `list_subagents` lets the main agent see every
subagent in one call, so a skill collecting several results can tell what
is still outstanding.

## Specification

Acceptance criteria and scope:
[Pi Subagents](../specifications/2026-08-22-subagents.md). The four
features added on 2026-08-23 are the ones this plan implements:
"Starting a subagent with a supplied character", "Continuing a subagent
that was given its character", "Listing the session's subagents", and
"Discovering agent files".

## Research

- [Pi extensions and subagent implementations](../research/2026-08-22-pi-extensions-and-subagents.md)

## Prerequisites & Dependencies

None. No new runtime or test dependency: the suite is `vitest`, and the
spec's Gherkin is documentation rather than an executable suite — there
is no BDD runner in this project and this plan does not introduce one,
matching [the closed plan](2026-08-22-subagents.md).

One tool needs recreating before Slice 1. `mutate.py` is gone: the old
session's scratchpad
(`/private/tmp/claude-501/-Users-mmcdonnell-code-pi-subagents/24661d66-…/scratchpad/`)
holds no `.py` file, and the closed plan records its findings but not its
source. Rewrite it as roughly 90 lines taking a JSON list of
`{name, file, old, new, test_file, expect_failing}`: apply each
substitution, run `npx vitest --run <test_file>`, assert the named test
fails, restore the file. It found a hollow test in every slice of the
closed plan, including three in Slice 10.

## Pull Request Delivery

- **Mode:** Direct to trunk

Trunk-only is the standing choice, so there are no PR layers. Each slice
is one commit on `main`, made at the end of the turn that implements it.

| Layer | Base   | Includes           | Branch |
| ----- | ------ | ------------------ | ------ |
| 1     | `main` | Slices 1–4, 1 each | `main` |

## Implementation

### Slice 1: A subagent's record carries its own character

- **Blocked by**: None — can start immediately

- **Delivers**: A subagent whose record holds its own definition, so
  `@handle` continuation no longer depends on an agent file existing. A
  record marked as inline resumes under the definition stored on it; a
  file-backed record still resumes under its file's *current*
  frontmatter; a file-backed record whose file has gone is still
  refused. Demoable at the input handler with a hand-built record — no
  spawn-tool change is needed to observe it.

- **Consumes**: None

- **Produces**:

  - `AgentSource` gains `"inline"` — `src/agents.ts`
  - `AgentConfig.filePath` becomes optional: `filePath?: string`
  - `SubagentRecord.config: AgentConfig` — `src/registry.ts`

- [x] **Task 1.1**: Add `"inline"` to `AgentSource` and make `filePath`
  optional.

  `filePath` is read nowhere in `src/` outside `agents.ts` itself — only
  by `test/agents.test.ts:173` and `test/agents.test.ts:278`, both
  file-tier tests — so making it optional costs nothing and is honest
  about an inline character having no file.

  ```typescript
  /** Which tier an agent definition came from, or that it came from none. */
  export type AgentSource = "builtin" | "user" | "project" | "inline";

  export interface AgentConfig {
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[];
    model?: string;
    thinking?: ThinkingLevel;
    color?: string;
    maxTurns?: number;
    source: AgentSource;
    /** Absent for a character supplied at spawn time, which has no file. */
    filePath?: string;
  }
  ```

- [x] **Task 1.2**: Store the resolved definition on the record.

  `startSubagent` already receives the full `AgentConfig`
  (`src/spawn.ts:346-355`), so this is one field in the record literal
  at `src/spawn.ts:357-375`.

  Keep `type: string` alongside it rather than replacing every
  `record.type` with `record.config.name`. `type` is what the model
  addresses and what every message names — `describeCompletion`
  (`src/spawn.ts:133`), `describeStart` (`src/index.ts:240`),
  `SubagentCompleteDetails.agent` — and rewriting some thirty sites is a
  wide mechanical refactor this slice does not need. The two cannot
  diverge: both are set from one source at creation, and a file whose
  `name:` has since changed is not findable by the old name, so it is a
  different agent rather than a renamed one.

  ```typescript
  // src/registry.ts
  export interface SubagentRecord {
    id: string;
    handle: string;
    /** The agent definition this run came from. */
    type: string;
    /**
     * The definition this run was started under, stored so continuing it
     * does not depend on a file existing.
     *
     * A subagent given its character at spawn time has no file to re-read,
     * and this is the only definition it will ever have. A file-backed one
     * carries it too, but continuation prefers the file — see `route` in
     * `index.ts` for why a resumed subagent runs under current frontmatter.
     */
    config: AgentConfig;
    description: string;
    // … unchanged
  }
  ```

  ```typescript
  // src/spawn.ts, inside startSubagent
  const record: SubagentRecord = {
    id: newId(),
    handle: assignHandle(
      config.name,
      (candidate) => registry.get(candidate) !== undefined,
    ),
    type: config.name,
    config,
    description,
    status: "queued",
    color: assignColor(registry.list().length, config.color),
    startedAt: now(),
    contextPercent: null,
    turns: 0,
  };
  ```

- [x] **Task 1.3**: Resolve a continuation's definition by where its
  character came from.

  `route` currently re-reads the agent file by `record.type` and refuses
  when there is none (`src/index.ts:725-731`). That refusal is correct
  for a file-backed subagent and wrong for an inline one, and the spec
  pins both. Branch on `record.config.source`, not on whether a file
  happens to be found — falling back to the stored copy whenever the
  lookup misses would silently resurrect a deleted agent under a stale
  definition.

  ```typescript
  // src/index.ts, inside route()
  // A subagent given its character at spawn has no file to re-read, so its
  // record holds the only definition there is. One started from a file
  // resumes under that file as it is now, so a changed `model:` or prompt
  // takes effect — and its file having gone is a refusal, not a reason to
  // fall back to the copy it started with.
  const config =
    record?.config.source === "inline"
      ? record.config
      : record
        ? agents.find((agent) => agent.name === record.type)
        : agentForHandle(agents, handle);
  if (!config) {
    say(`There is no agent file for "${handle}" any more.`, "warning");
    return;
  }
  ```

  `resumeSubagent` itself needs no change: it takes `config` from its
  caller (`src/spawn.ts:97-107`), and `route` is its only call site
  (`src/index.ts:757`).

- [x] **Task 1.4**: Tests, at the input handler and the tool boundary.

  `test/mention-handler.test.ts` already builds fake `AgentConfig` and
  record fixtures (`test/mention-handler.test.ts:21`), so an inline
  record is a fixture change rather than new machinery.

  - Given a finished record whose `config.source` is `"inline"` and no
    agent file of that name, when a message is addressed to its handle,
    then it resumes under the stored system prompt and tools.
  - Given a finished record whose `config.source` is `"project"` and
    whose file's frontmatter has changed since it ran, when a message is
    addressed to its handle, then it resumes under the file's current
    definition, not the stored one.
  - Given a finished record whose `config.source` is `"project"` and
    whose file is gone, when a message is addressed to its handle, then
    the reply says there is no agent file of that name and no run
    starts.
  - Given `startSubagent` called with a config, then the record it
    returns carries that config.

  > [!NOTE]
  > Three tests were written, not four. The third case above already
  > existed as "says so when the subagent finished between the typing
  > and the send" (`test/mention-handler.test.ts:284`), which sets
  > `agents = []` against a `"project"` record and asserts the notice
  > matches `/no agent file/i`. A fourth test was added anyway, under a
  > name that says what the rule is rather than what the symptom is —
  > "does not fall back to the stored character when a file is
  > expected" — because that is the rule a future change is most likely
  > to break.
  >
  > Only two of the four went red: the inline resume and the record
  > carrying its config. The two file-backed cases passed the moment
  > they were written, since re-reading the file and refusing when it
  > is gone is what the code already did. They are regression guards,
  > and both earn their place — mutation 4 below is caught by one of
  > them and nothing else.

- [x] **Task 1.5**: Give the record fixtures a `config`.

  Not foreseen, and the one thing in this slice that touched files the
  plan did not name. `config` being required breaks six test files that
  build `SubagentRecord` literals directly — `test/control.test.ts:36`,
  `test/registry.test.ts:22`, `test/turns.test.ts:14`,
  `test/ui/subagent-list.test.ts:47`,
  `test/ui/subagent-viewer.test.ts:111`, and three inline records in
  `test/spawn.test.ts`.

  Every test still passed: `vitest` transpiles through esbuild and does
  not typecheck, so this surfaced only under `npx tsc --noEmit`. Worth
  carrying into Slices 2 and 3 — a green suite is not evidence that the
  types agree.

- [x] **Task 1.6**: Mutation-test the slice.

  | Mutation                                          | Test that must fail            |
  | ------------------------------------------------- | ------------------------------ |
  | `source === "inline"` → `source !== "inline"`     | inline resume                  |
  | Drop `config` from the record literal             | `startSubagent` carries config |
  | `?? record.config` appended to the file lookup    | file-is-gone refusal           |
  | Return the stored config for a `"project"` record | current-frontmatter resume     |

  > [!NOTE]
  > All four caught; no hollow test, which is the first time
  > `mutate.py` has found nothing in this project.
  >
  > It had to be rewritten first, as the Prerequisites section
  > expected. The rewrite checks each mutation twice — once unmutated,
  > to prove the named test exists and passes, then once mutated, where
  > it must fail. Without the first run a `-t` filter matching no test
  > at all exits non-zero and reads as a mutation caught, which is the
  > one way this script can lie.

### Slice 2: A character supplied at spawn time

- **Blocked by**: Slice 1 (a record with no file behind it is
  unresumable until it carries its own definition, and `"inline"` is the
  source value this slice sets)

- **Delivers**: `spawn_subagent` starts a subagent from a supplied system
  prompt, tool list, and name, with no agent file involved. Reachable by
  `@name`, coloured from the palette, and refused when its name would
  shadow an agent file.

- **Consumes**: `AgentSource`'s `"inline"`, `AgentConfig.filePath?`,
  `SubagentRecord.config` — all from Slice 1

- **Produces**: No new exported signature. `buildToolDescription`
  (`src/index.ts:190`) changes behaviour for an empty agent list.

- [ ] **Task 2.1**: Add the three parameters, and make `subagent_type`
  optional.

  `subagent_type` is required today (`src/index.ts:288`). A supplied
  character has no type to name, so it becomes optional, and the two
  ways of starting a subagent are made mutually exclusive at runtime
  rather than in the schema — the plain-types constraint from
  [the tool-naming ADR](../adr/2026-08-22-self-describing-tool-names.md)
  rules out expressing this as a schema union.

  ```typescript
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Name of the subagent to delegate to, from the list above. " +
        "Omit it when supplying system_prompt instead.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "A short one-word name for this subagent, becoming the handle " +
        "the user types after @ to reach it. Choose it yourself, a " +
        "distinct one for each subagent you start, and never ask the " +
        "user for one. Only read alongside system_prompt.",
    }),
  ),
  system_prompt: Type.Optional(
    Type.String({
      description:
        "Instructions defining this subagent's character, used instead " +
        "of an agent file. Supply this when no listed subagent type " +
        "fits the work; the subagent runs under it and nothing else.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "The tools this subagent may use, by name. Defaults to the " +
        "session's own tools. Only read alongside system_prompt.",
    }),
  ),
  ```

- [ ] **Task 2.2**: Resolve the definition from whichever route the call
  took.

  Four cases, each with its own refusal. The collision check is what
  keeps a reviewed persona reviewed: an agent file is something a person
  wrote and can inspect, and a model-composed prompt running under that
  same name would shadow it silently.

  ```typescript
  // src/index.ts, replacing the lookup at src/index.ts:333-349

  /**
   * The fields of the spawn tool's parameters that choosing a definition
   * depends on. Declared structurally rather than derived from the schema:
   * the schema is inline in `defineTool`, so there is no named type to take
   * a `Static<>` of without lifting it out.
   */
  type SpawnRoute = {
    subagent_type?: string;
    name?: string;
    system_prompt?: string;
    tools?: string[];
    description: string;
  };

  function resolveSpawnConfig(
    params: SpawnRoute,
    agents: AgentConfig[],
  ): AgentConfig {
    const supplied = params.system_prompt?.trim();
    const type = params.subagent_type?.trim();

    if (supplied && type) {
      throw new Error(
        "A subagent takes its character from an agent file or from " +
          "system_prompt, not both. Drop subagent_type to use the " +
          "prompt you supplied, or drop system_prompt to use the file.",
      );
    }

    if (!supplied) {
      if (!type) {
        throw new Error(
          "Name a subagent_type from the list, or supply a " +
            "system_prompt describing the subagent you want.",
        );
      }
      const config = agents.find((agent) => agent.name === type);
      if (!config) {
        throw new Error(
          `Unknown subagent type "${type}". ` +
            `Known types: ${agents.map((agent) => agent.name).join(", ")}.`,
        );
      }
      return config;
    }

    // The name is the handle's source, and `assignHandle` slugs whatever it
    // is given, so a name left out can fall back to the description without
    // slugging anything here. A description is 3-5 words, so the handle it
    // yields is ugly rather than unusable — which is the point: a missing
    // name must never refuse the call, or the model recovers by asking the
    // user, which is what this feature exists to avoid.
    const name = params.name?.trim() || params.description;
    const shadowed = agents.find((agent) => agent.name === name);
    if (shadowed) {
      throw new Error(
        `"${name}" is already an agent file (${shadowed.source}). ` +
          "Either name it as subagent_type without a system_prompt, or " +
          "choose a different name for the subagent you are describing.",
      );
    }

    return {
      name,
      description: params.description,
      systemPrompt: supplied,
      tools: params.tools,
      source: "inline",
    };
  }
  ```

  Nothing downstream needs changing for colour or turn limits: an inline
  config names no `color:`, so `assignColor` falls to the palette
  (`src/colors.ts:40-50`), and it names no `maxTurns`, so `turnLimit`
  falls to `DEFAULT_MAX_TURNS` (`src/spawn.ts:172-174`). Both are
  covered by a test rather than by new code.

- [ ] **Task 2.3**: Stop claiming the tool is unusable without agent
  files.

  `buildToolDescription([])` currently says the tool "cannot be used
  yet" (`src/index.ts:191-198`), and `execute` throws when no agents
  exist (`src/index.ts:334-339`). Both become false the moment a
  character can be supplied, so a project with no agent files is now the
  inline path's plain case rather than an error. Delete the throw, and
  give the description the naming directive in both branches.

- [ ] **Task 2.4**: Tests at the tool boundary.

  Ten cases, from the spec's "Starting a subagent with a supplied
  character" feature, plus the two refusals the schema cannot express:

  - runs under the supplied prompt, with no agent file consulted
  - starts when no agent file of that name exists
  - has the tools named and no others
  - takes the supplied name as its handle
  - falls back to a description-derived handle when no name is given
  - five subagents given the same name get distinct handles
  - refuses a name an agent file already uses, and starts nothing
  - refuses when both `subagent_type` and `system_prompt` are given
  - refuses when neither is given
  - takes a palette colour
  - the recursion guard still refuses, with `system_prompt` supplied
  - works in a project with no agent files at all

- [ ] **Task 2.5**: Mutation-test the slice.

  | Mutation                                                            | Test that must fail      |
  | ------------------------------------------------------------------- | ------------------------ |
  | Remove the collision check                                          | refuses a shadowing name |
  | `params.name?.trim() \|\| params.description` → `params.name ?? ""` | description fallback     |
  | `source: "inline"` → `source: "project"`                            | Slice 1's inline resume  |
  | Drop `tools` from the returned config                               | tools restriction        |
  | Allow both routes together                                          | refuses both-given       |

### Slice 3: `list_subagents`

- **Blocked by**: None — reads only what the registry already holds.
  Sequenced third because it shares `src/index.ts` with Slice 2, not
  because it depends on it; it can be resequenced first if preferred.

- **Delivers**: The main agent sees every subagent in the session with
  its handle, id, status, and description in one call.

- **Consumes**: Nothing from Slice 1 or 2

- **Produces**: `LIST_TOOL_NAME`, `createListTool(deps)` —
  `src/index.ts`

- [ ] **Task 3.1**: Register a fifth tool.

  Read-only and stateless: everything it reports is already on the
  record, and `SubagentRegistry.list()` returns launch order
  (`src/registry.ts:197-201`), which is the order the user asked for
  subagents in and so the order to print.

  ```typescript
  export const LIST_TOOL_NAME = "list_subagents";

  export function createListTool(deps: { registry: SubagentRegistry }) {
    return defineTool({
      name: LIST_TOOL_NAME,
      label: "List Subagents",
      description:
        "Every subagent started in this session, with its status. Read " +
        `this rather than calling ${RESULT_TOOL_NAME} on each id in turn ` +
        "when several subagents were started together and their results " +
        "are meant to be read as a set.",
      parameters: Type.Object({}),

      async execute() {
        const records = deps.registry.list();
        // … render, see Task 3.2
      },
    });
  }
  ```

  Register it beside the others at `src/index.ts:801-804`, and correct
  the module doc comment at `src/index.ts:5`, which says four tools.

- [ ] **Task 3.2**: Render the list, and the empty case.

  ```txt
  4 subagents in this session:

  - behaviour (a1f2…) — completed — Behaviour and tests review
  - security (b3c4…) — running — Security and abuse review
  - reliability (c5d6…) — completed — Reliability review
  - maintainability (d7e8…) — queued — Maintainability review
  ```

  With none started, say so plainly rather than returning an empty
  string, which a model reads as a failed call.

- [ ] **Task 3.3**: Tests at the tool boundary.

  - lists every subagent, each entry giving handle, id, status and
    description
  - a subagent in each of the five statuses is listed as that status
    (`queued`, `running`, `completed`, `failed`, `stopped` —
    `src/registry.ts:24-29`)
  - reports a session with no subagents
  - changes nothing: statuses and conversations are untouched afterwards

- [ ] **Task 3.4**: Mutation-test the slice.

  | Mutation                             | Test that must fail  |
  | ------------------------------------ | -------------------- |
  | Filter out `TERMINAL_STATUSES`       | every-status listing |
  | Return handles only, no id or status | full-entry listing   |
  | Return `""` when the list is empty   | empty-session reply  |

### Slice 4: Discovery coverage, documentation, and the decision record

- **Blocked by**: Slices 1–3 (documents what they land)

- **Delivers**: The spec's discovery scenarios traced to tests, a README
  describing both ways to start a subagent, and an ADR for the decision
  that a persona need not come from a file a person wrote.

- **Consumes**: Everything above

- **Produces**: Nothing

- [ ] **Task 4.1**: Trace the discovery scenarios to existing tests, and
  add nothing that already holds.

  The spec's "Discovering agent files" feature documents behaviour that
  shipped in Slice 1 of the closed plan and was widened at `16ceed7`. It
  is already covered in full — this task is a mapping check, not new
  tests:

  | Scenario                                             | Test                      |
  | ---------------------------------------------------- | ------------------------- |
  | Prefers the project's agent to the user's own        | `test/agents.test.ts:107` |
  | Prefers the user's own agent to the shipped one      | `test/agents.test.ts:197` |
  | Offers the shipped agents when none are written      | `test/agents.test.ts:184` |
  | Ignores a malformed file without hiding its siblings | `test/agents.test.ts:71`  |
  | Finds the project's agents from a subdirectory       | `test/agents.test.ts:132` |

  Add a test only if reading one shows it asserts something narrower
  than its scenario. Keep the suite over the real shipped `agents/`
  directory (`test/agents.test.ts:246-299`) passing — it is what catches
  a shipped file that fails to parse, names a tool pi does not have, or
  names a model that would refuse the spawn.

- [ ] **Task 4.2**: Update the README.

  Both ways to start a subagent, the three discovery tiers and their
  precedence, `list_subagents`, and the Claude Code mapping the ADR
  asked for — now including `name` and `system_prompt` against Claude
  Code's `Agent` parameters.

- [x] **Task 4.3**: Extract the ADRs.

  Done when this plan was written, not after the code: both record
  decisions the user took in conversation, and neither depends on how
  the implementation turns out.

  - [Let a subagent's persona be supplied at spawn time](../adr/2026-08-23-personas-supplied-at-spawn.md)
    — with the three rejected alternatives, and the review step given
    up knowingly.
  - [List subagents rather than wait for them](../adr/2026-08-23-list-subagents-rather-than-wait.md)
    — with `wait_for`, notice batching, and doing nothing rejected.

  Both are recorded as amendments on
  [the tool-naming ADR](../adr/2026-08-22-self-describing-tool-names.md),
  whose "four tools" decision becomes five and whose plain-schema
  constraint this work honours by expressing the two spawn routes as
  separate optional fields with a runtime refusal.

  What is left for this task is a check, once the slices have landed:
  re-read both ADRs against the code and correct any consequence that
  turned out differently.

### Documentation

- [ ] Update `README.md` for the spawn tool's new parameters,
  `list_subagents`, and the discovery tiers (Task 4.2)
- [x] Add the ADRs under `docs/adr/` (Task 4.3 — done up front)
- [ ] Correct this plan in place, as a `> [!NOTE]` under each task,
  in the same commit as that task's code

### Verification

- [ ] `make verify` — tests, `tsc --noEmit`, `biome check`, and the load
  through pi's own jiti loader (`Makefile:36`)
- [ ] All spec acceptance criteria hold, via `make test`
- [ ] `mutate.py` reports every listed mutation caught, per slice
- [ ] A load check through a real pi invocation:
  `pi -p "…" -e ./src/index.ts --session-dir "$TMPDIR/pi-check"`. From
  a sandbox this reaches the model check and stops at "No API key
  found", which is as far as it goes and still proves the extension
  loads and registers.
- [ ] `make try` — the interactive walkthrough, which needs a human at a
  terminal. Spawn an inline persona, confirm its row and colour, reach
  it with `@name`, and continue it after it finishes. This is the
  outstanding verification item from the closed plan too.

## File Changes

| File                           | Change                                                   |
| ------------------------------ | -------------------------------------------------------- |
| `src/agents.ts`                | `"inline"` source; optional `filePath`                   |
| `src/registry.ts`              | `SubagentRecord.config`                                  |
| `src/spawn.ts`                 | The record stores its config                             |
| `src/index.ts`                 | Spawn parameters, `resolveSpawnConfig`, `createListTool` |
| `test/mention-handler.test.ts` | Continuation by character origin                         |
| `test/spawn.test.ts`           | The record carries its config                            |
| `test/index.test.ts`           | Inline spawn, refusals, listing                          |
| `test/tool-boundary.test.ts`   | Inline spawn at the tool boundary                        |
| `test/agents.test.ts`          | Only if a traced scenario proves thin                    |
| 5 other test files             | A `config` on each record fixture (Task 1.5)             |
| `README.md`                    | Both spawn routes; `list_subagents`                      |
| `docs/adr/2026-08-23-*.md`     | Two ADRs, already written                                |

## Parallel Execution

Not applicable. Slices 2 and 3 both edit `src/index.ts`, and Slice 4
documents all three, so this is a sequential chain worked in the main
thread — one slice per turn, one commit at the end of each.

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

## Notes & Caveats

- **An empty parameter schema is the one provider risk here.**
  `list_subagents` takes no arguments, so its schema is
  `Type.Object({})`, and providers differ in what they accept — which is
  the same concern that produced the plain-schema rule. The load check
  will not catch it; only a real call will. If a provider rejects it,
  add one optional `status` string filter rather than inventing a
  required parameter.
- **`type` and `config.name` are deliberately both on the record.**
  Task 1.2 states the reasoning. The alternative — dropping `type` and
  reading `config.name` everywhere — is a wide mechanical refactor
  across roughly thirty sites, and expand–contract on a field this
  small would cost more than it returns.
- **A description-derived handle is meant to be ugly.** It exists so
  that a missing `name` never refuses the call, because a refusal
  invites the main agent to ask the user what to call things, which is
  the outcome the feature exists to prevent. `@behaviour-and-tests-review`
  working is the success case, not a defect.
- **No `general` or `general-readonly` agent files.** Decided against:
  an inline character carries its own prompt and tools, so a neutral
  file to specialise through the prompt would be a second way to do one
  thing.
- **Running `code-review --plan` over the 21 commits on `main`** is
  wanted and out of scope here. It would be the first real exercise of
  the six shipped review agents, and is better done once this plan
  lands than against a moving tree.
- Traps carried forward from the closed plan: the agent sandbox cannot
  write `~/.pi/agent`, so a real `pi` run needs `--session-dir`; shell
  heredocs hang, so author scripts with the Write tool and then run
  them; `vitest` swallows `console.log`, so write rendered output to a
  file and read it back; pi's message components read the *global*
  theme and throw until `initTheme()` has run, so every UI test calls it
  in `beforeAll`; a test reaching the real runner must pass a
  `sessionDir` or it writes to the user's real
  `~/.pi/agent/sessions` and fails `EPERM`; `rm -rf` is blocked by
  policy, so delete named paths and then `rmdir`.
