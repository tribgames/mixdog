# Tool-calling bench notes

Last updated: 2026-07-02

## Current policy assumptions

- `read` public schema follows a windowed read surface: `path` plus optional `offset`/`limit`.
- `line`/`context` are not exposed in the `read` schema. Internal compatibility may still normalize path line suffixes such as `file#L10`.
- `read` accepts real arrays for batched files/regions. JSON-stringified arrays are not recommended in the schema, but the runtime guard now losslessly recovers them to avoid a wasted retry turn.
- For lookup-heavy work, prefer:
  - `code_graph` for symbols, callers, references, imports/dependents, and code flow.
  - `grep output_mode:"content_with_context"` for exact text matches when the returned context can answer the question.
  - `read` only after a known file or precise region is anchored.
- Hook behavior is observer/bypass by default. With no project/data/plugin/env hook config and no legacy rules, `beforeTool()` returns `null` and tools execute normally. Hook deny only exists for configured custom hooks/rules.

## What changed in this round

- Tool-routing guidance was tightened in `src/rules/shared/01-tool.md`.
  - Batch independent lookups.
  - Route symbol/flow questions to `code_graph`.
  - Use `grep content_with_context` to avoid unnecessary follow-up `read`.
- `read` schema/guard was aligned around `offset`/`limit`.
  - `src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs`
  - `src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs`
  - `scripts/tool-smoke.mjs`
- `read` guard now applies the same shape coercion used by the executor so a provider that sends `path` as a JSON-stringified array can still execute as one batched read.
- `grep` now has `content_with_context` in the guarded schema path and smoke coverage for the schema guidance.
- `code_graph` descriptions were clarified so symbol/flow lookup is steered away from repeated grep sweeps.
- Provider/tool-call and stream/stall related checks were expanded in the current worktree; see the commit diff for exact file-level changes.

## Bench observations

Latest live run:

```powershell
node scripts/bench-run.mjs --tasks scripts/_bench-cwc.json --round cwc5 --save .bench-cwc5.json
```

Result summary:

- `cwc5`: 3/3 tasks complete.
- Group average vs `cwc4`:
  - `wall_ms`: `56904.7` -> `49585` (`-12.9%`)
  - `turns`: `21` -> `15` (`-28.6%`)
  - `tool_calls`: `53` -> `31.7` (`-40.2%`)
  - `prompt_growth`: `17587.3` -> `12479.7` (`-29.0%`)
- Main improvement:
  - `cwc-cacheusage`: `104091ms / 38 turns / 90 tools` -> `56004ms / 16 turns / 31 tools`.
- Remaining bench caveat:
  - `cwc-hookflow` regressed in this run, but that task is about a hypothetical/custom hook-deny trace. It should not be interpreted as an active hook failure in a clean install.

## Hook-flow clarification

Default clean state checked locally:

- No project hook config under `C:\Project\mixdog\.mixdog\...`
- No data hook config under `~/.mixdog/data/...`
- `MIXDOG_HOOKS_FILE` unset
- `hooks.status()` reports no config sources, no rules, and observer mode.

Actual default behavior:

1. `src/mixdog-session-runtime.mjs` attaches `beforeToolHook` to sessions.
2. `src/standalone/hook-bus.mjs` records lifecycle/tool events.
3. If no configured hook/rule matches, `beforeTool()` returns `null`.
4. `src/runtime/agent/orchestrator/session/loop.mjs` only returns `Error: tool "... " denied by hook...` when a configured custom hook/rule returns `deny`/`block`.

Follow-up recommendation:

- Rename or rewrite `cwc-hookflow` so it first verifies the default bypass policy, then separately documents the optional custom-hook deny path.
- Consider making hook status wording more explicit, e.g. `observer/bypass` when there are no configured hooks or rules.

## Verification run during this round

```powershell
node scripts/tool-smoke.mjs
node scripts/bench-run.mjs --tasks scripts/_bench-cwc.json --round cwc5 --save .bench-cwc5.json
```

Both completed successfully.
