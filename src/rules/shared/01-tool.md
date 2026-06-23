# Tool Routing

Native tools and shell are NEVER used for IO — search, inspect, read, mutate
files, or web access. Use the Mixdog equivalent. `bash` is the single shell
entry point (PowerShell on Windows); native `Bash`/`PowerShell` are not used.

| Native (forbidden for IO) | → Mixdog |
|---|---|
| `Read` | `read` |
| `Grep` | `grep` |
| `Glob` | `glob` |
| `LS` / dir listing | `list` |
| `Edit` / `NotebookEdit` | `apply_patch` (default editor) or `edit` (small exact substitution) |
| `Write` | `write` (or `apply_patch`) |
| Delete / remove a file | `apply_patch` (`*** Delete File: <path>`) — no native `rm`/unlink |
| `WebSearch` | `search` |
| `WebFetch` | `web_fetch` |
| `Bash`/`PowerShell` (file IO) | ✗ — use the rows above; never `bash mkdir` to prep a path (`write`/`apply_patch` auto-create parent dirs), nor `touch`/`cat` (use `write`/`read`) |
| `Bash`/`PowerShell` (git/build/test/run) | `bash` |
| native `Agent` sub-agent to search / inspect / fetch | ✗ — call Mixdog tools directly; real sub-work goes through `bridge` |

No native equivalent (use as-is): `code_graph`
(`find_symbol`/`search`/`references`/`callers`/`imports`/`dependents`),
`ToolSearch`. Lead progress tracking via `TaskCreate`/`TaskUpdate`/
`TaskList` is allowed.

## Decision order — pick the FIRST that matches the task

1. **External / web / current docs** → `search` → `web_fetch` for bodies.
2. **Past memory / prior decisions / session history** → `recall`. The
   SessionStart inject is a thin excerpt, not the store — what's not visible is
   one cheap recall away.
3. **Read the code, scope unknown / open-ended / tree-wide** → `explore` (not a
   `worker`/`bridge`; never grep-loop it yourself).
4. **Known symbol — a known identifier** → `code_graph` (`find_symbol` exact, `mode:search`
   for a keyword — file-less, use INSTEAD of grepping for a symbol).
5. **Find files by name / type / size / date** → `glob`/`list mode:find`.
6. **Free-text / non-symbol content** (literals, log lines, config keys) → `grep`.
7. **Read a specific known region** → `read`.
8. **Edit** → `apply_patch` (default; large/structural, multi-hunk/multi-file) · `edit`
   (small exact substitution; Lead must `ToolSearch select:edit` first — see Tool
   Use) · `write` (new file or full rewrite of one already read). Batch dependent
   edits into ONE multi-hunk apply_patch. To delete, use `apply_patch`
   (`*** Delete File: <path>`) — no `rm`/`bash rm`.
9. **Shell** (git/build/test/run only) → `bash`.

Retrieval (1–3) picks the SOURCE family first; never default to a `bridge` worker
for a read-only lookup. It is ONE-SHOT but fans out: `recall`/`search` take a query
array; `explore` spawns one per independent area in a batch — all read-only, safe
to run concurrent.

**Anchor down the ladder once scope is known.** A bounded / known-anchor lookup
skips straight to `code_graph`/`grep`. But "the brief names a repo path" is NOT an
anchor — anchor = a named file or symbol; a tree-wide sweep with none is step 3
(`explore`), not grep. Read what you need in ONE turn — batch a file's
windows/`symbol=`s together, don't re-open it across later turns.

## Shortest route — collapse a multi-hop search into ONE call

When the shape is known, do not chain `grep` → `read`:
- keyword / partial-or-unknown symbol name → `code_graph mode:search` (one call,
  file-less) instead of grepping for it.
  Seed it with a SINGLE token, not a prose phrase — multi-word phrases miss and
  waste a call.
- a named symbol / several bodies / a call chain → `code_graph find_symbol`
  (`body:true`, or `symbols:[...]` to batch) instead of N reads.
- all call sites / a call chain → `callers`/`references` UNSCOPED (batch with
  `symbols:[...]`; add `file:` only to narrow a too-large result).
- a whole function → `read symbol=NAME`; the lines around a hit → `grep -C`.
- several free-text patterns at once → ONE `grep` with an array `pattern:[...]`
  (OR-matched ripgrep regexes, ≤20; ≤5 with `multiline`) instead of repeated
  single-pattern greps (`glob` takes an array too; for named/partial symbols use
  `code_graph`, not `grep`).

Reach for the one-shot form before adding a follow-up `read`.

## Modifiers — rules that ride on top of the ladder

- **Exploration budget.** Stop as soon as you can answer the task correctly —
  don't keep searching to confirm a found answer, gather extra examples, or
  polish phrasing. Match depth to the brief's stated thoroughness, not a default
  of exhaustive.
- **Concurrency.** Any calls that don't depend on each other's output go in ONE
  message = one round-trip — read-only probes (`read`/`grep`/`glob`/`code_graph`)
  and `apply_patch` edits to DIFFERENT files alike. Only a true dependency chain
  (grep → read the hit) or same-file edits stay serial; never run independent
  calls one-at-a-time.
- **Lead-only async.** `explore` defaults to `background:true` (handle returns
  now; the merged answer arrives via `dispatch_result`) — LEAD ONLY. Bridge
  workers run `explore` sync (no channel for the async push) but still use it
  over a grep storm. `explore` fans out to read-only hidden `explorer` sub-agents
  (full worker tool schema + worker BP2 for cache parity); `recall`/`search` are
  plain MCP tools.
- **No waiting calls.** Never issue shell calls whose only purpose is waiting,
  spacing, or liveness probing; on a cancelled/empty batch, report the concrete
  failure and rerun only what's needed.
- **Failure circuit-breaker.** Same call failing TWICE with the same error ends
  variant-retrying: stop, diagnose the root cause (read the error detail, inspect
  the target), then switch tool or strategy — don't blind-retry with tweaked args.
- **No self-verification of output.** When the deliverable is code/text returned
  in your answer, emit it directly; never `write` a scratch file or `bash` it to
  compile/run/test your own output.
