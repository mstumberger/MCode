# Dynamic Model Routing by Work Type - Design

Date: 2026-11-03
Status: Approved for implementation (autonomous session; user requested brainstorm + PR in one shot)

## Problem

A session today runs on exactly one user-selected model (`ModelSelection`). Every
non-main-line model call - plan-mode turns, compaction summaries, session/goal titles,
goal completion verification - either inherits the session model or (titles only) has a
dedicated `titleGeneration.modelSelection`. Users who pair a strong primary model with a
fast, cheap "flash"-tier model have no way to say "do the light work on flash".

The retired `modelSmall`/`smallModel` config keys (dropped when provider/model config
moved to the Registry) confirm the demand; nothing replaced them for task-based routing.

## Goals

- Route **plan-mode turns** to a configured model (flash-tier) while plan mode is active.
- Route **utility sidecars** (compaction summary, session/goal titles, goal completion
  verification) to a configured model when they have no explicit selection of their own.
- Explicit user intent always wins: per-submission `intent.modelSelection` and execution
  selections (highspeed/off-peak) are never overridden by routing.
- Misconfigured routing targets degrade gracefully: fall back to the session model with a
  `warn` log; never block a turn.
- One owner: the runtime resolves routing. Hosts only supply config.

## Non-goals (follow-ups)

- Heuristic per-request complexity classification (auto-pick flash vs primary).
- Desktop settings UI and `zcode-protocol` session/create params for routing.
- Routing for subagents (`builtInModelSelectionOverrides` already covers them), memory
  extraction (inherits the turn model by design), steering, or `workspace.generateText`
  (caller-supplied selection).

## Approaches considered

1. **Heuristic auto-routing** - classify each request by complexity and pick the model
   automatically. Rejected: unpredictable quality, no user control, untestable magic;
   every existing selection path in this codebase is explicit.
2. **Host-side orchestration** - the desktop sends a per-submission
   `intent.modelSelection` whenever plan mode is active. Rejected as primary: scatters
   policy across hosts, CLI/TUI gets nothing, cold resume diverges from live behavior.
3. **Role-based routing config resolved by the runtime** (chosen) - a small
   `modelRouting` config with two roles (`planMode`, `utility`); the runtime resolves
   them at the existing model-admission seams. Mirrors the established
   `titleGeneration.modelSelection` and `builtInModelSelectionOverrides` patterns.

## Design

### Config shape

```ts
// AgentRuntimeConfig (core) - also accepted in config.json and RuntimeConfigPatch
modelRouting?: {
  planMode?: ModelSelection; // turns executed while plan mode is enabled
  utility?: ModelSelection;  // summarization/classification sidecars
};
```

Role names are provider-neutral ("utility", not "flash"): the tier is the user's choice;
the role only says *what kind of work* runs on it.

Surfaces (precedence, highest first):
1. `ZCodeAppOptions.runtimeConfig.modelRouting` (embedders; spread into
   `AgentRuntimeConfig` by `resolveAppRuntimeConfig`)
2. `modelRouting` key in the user config file (adapters schema -> ConfigManager ->
   `resolveAppRuntimeConfig` merge) - works for CLI and desktop, both spawn the same
   agent process that loads the config file.

### Turn admission (plan mode)

`turn.ts` computes `admittedModelSelection` before the first `await`. New resolution for
the default (no explicit selection) arm:

```
explicit intent.modelSelection
  > execution selection (highspeed / rewind)
  > plan routing (plan state active && modelRouting.planMode set)
  > session selection
```

Plan state at admission = `resolveExecutionState({ mode: intent?.mode, planEnabled:
intent?.planEnabled }, readRuntimeExecutionState(runtime)).planEnabled`. This covers both
"session already in plan mode" and "this submission enters plan mode" (the submission's
plan flag is applied later, in `applySubmissionExecutionState`, so admission must consult
the intent explicitly).

Model creation fallback: if the turn model fails to create and the selection came from
plan routing, recreate with the session selection, log `warn`
(`model.routing.plan_mode.creation_fallback`), and continue the turn. Creation failure of
the session model itself keeps today's error path.

### Utility sidecars

New helper in core (`runtime/helpers/model-routing.ts`):

- `resolveUtilityModelSelection(runtime)` = `modelRouting.utility ?? session selection`.
- `createUtilityRuntimeModel(runtime)` = try `modelRouting.utility`; on creation error
  fall back to the session selection with a `warn` log. Same polarity as plan routing.

Call sites:

| Call site | Before | After |
| --- | --- | --- |
| `compact-active.ts` summary | session selection | `options.model ?? createUtilityRuntimeModel` |
| `title-generation-sidecar.ts` | `titleGeneration.modelSelection ?? (off-peak rules) ?? session` | `titleGeneration.modelSelection ?? (off-peak rules) ?? modelRouting.utility ?? session` |
| `target-completion-verification.ts` | session selection | `createUtilityRuntimeModel` |

Off-peak invariants are untouched: titles that belong to an idle execution keep using the
execution binding; the utility role slots in only where the session selection is used
today.

### Persistence and observability

Routing is config-only; nothing is persisted per session. Each fallback logs `warn` with
the configured target and the error. Model request events already record the effective
`providerId`/`modelId`, so routed requests are visible in existing telemetry unchanged.

## Testing

- Core unit tests (`createTestAgentRuntime`):
  - plan routing applies when plan mode is active; not when disabled;
  - explicit submission selection beats plan routing;
  - the submission that enables plan mode is routed (admission-time intent check);
  - unresolvable `planMode` target falls back to session model (turn still succeeds);
  - compact summary and completion verification use `utility` when set;
  - title precedence keeps `titleGeneration.modelSelection` and off-peak bindings above
    `utility`.
- Adapters config tests: config file `modelRouting` parses into the runtime patch;
  invalid entries are ignored exactly like other optional config.

## Follow-ups (not in this PR)

- `zcode-protocol` session/create param + desktop settings UI picker for the two roles.
- CLI flags (`--plan-model`, `--utility-model`).
- Consider a `memoryExtraction` role after observing utility-model summary quality.
