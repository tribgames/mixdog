# Mixdog — Terminal-Bench 2.1 controlled comparisons

Model-matched full runs compare Mixdog directly with the native coding harness
for the same model family. Each run covers all 89 tasks with unmodified task
timeouts and resources, scored by the official Harbor verifier.

The Sol comparison runs the protocol the official leaderboard requires on
both sides: all 89 tasks repeated five times (`k=5`, 445 trials) for Mixdog
and for the Codex CLI baseline alike. The Opus run and the Claude Code
baseline are single passes (`k=1`, 89 trials each), where per-task score
differences sit within normal run-to-run variance. The leaderboard is not
accepting community submissions, so these runs are published with their raw
artifacts under `records/<harness>/<model>/<date>/` instead of submitted.

These runs test whether Mixdog can match the native harnesses on results
while spending far less to get there. The Mixdog side is a strict
**single-model, single-session bench**: one primary model, no sub-agent
delegation, and no helper-model lookups.

## Bench log

Newest first. `k=1` runs are logged here and do not replace the `k=5`
results below.

| Date | Model | Mixdog vs baseline | Score | Cost | Final context | Time / trial | Records |
|---|---|---|---|---|---|---|---|
| 2026-10-15 | GPT-6.1 Sol xhigh, `k=1` | Mixdog vs Codex CLI | 77 vs 78 /89 | **$9.01 vs $19.83 (−55%)** | **10.8K vs 33.6K (−68%)** | 344s vs 380s | [mixdog](records/mixdog/gpt-6.1-sol/2026-10-15/) · [codex](records/codex/gpt-6.1-sol/2026-10-15/) |

Both sides ran with web search on; Mixdog's figures include its web-search
sessions, repriced from traces ([`trace-cost.mjs`](analysis/trace-cost.mjs)):
this run's usage snapshots and archived `report.json` predate the fix that
counts those sessions and sum to $7.46, and the six tasks that searched are
listed with their trace accounting under `mismatched` in
[`records/trace-recovered-cost.json`](records/trace-recovered-cost.json).

**2026-10-15 changes**

| Change | Details |
|---|---|
| Effort judge active | Auto effort now runs on OpenAI OAuth routes: the judge picks each turn's effort and re-judges after every tool result (see below). It had been skipped on `openai-oauth`, which handed it a bare model id with no effort ladder; it now reads the catalog row ([`autoEffortModel`](../../src/runtime/agent/orchestrator/providers/effort-configuration.mjs)) |
| Web search unblocked | The baseline harnesses ship with web search on; this bench used to block Mixdog's. The [harness](harness/mixdog_agent.py) now passes `--web-search` |
| GPT-6.1 Sol rates | $2 input / $0.10 cached / $10 output per M tokens; Codex `cost_usd` fits with zero residual ([`model-rates.mjs`](analysis/model-rates.mjs)) |

**Effort judge** ([details](../../docs/auto-reasoning-effort.md))

| | |
|---|---|
| Model | EmbeddingGemma 2 encoder (18 of 24 layers) fine-tuned with a four-level head, 4-bit ONNX, ~150 MB, CPU only, no network |
| Decision | Reads the request, or the step (task, plan, up to three tool calls and results), and moves from `medium` to `low` / `high` / `xhigh` by expected cost, penalising under-calls more |
| Accuracy | 78.5% exact level agreement vs 72.7% for Jev 1.13 on 12,029 held-out items; half the two-level misses (0.6% vs 1.4%) |
| In this run | 825 judgments: 591 `medium`, 127 `high`, 105 `low`, 2 `xhigh`; the route's fixed `xhigh` applies only when the judge is off |

Notes: the run used an uncommitted tree from before the contract digest change, so its archived contract still lists web search as disabled (10 tools; the run had 11 including `load_tool`), and its `preset-run.json` comparison block was added after the run to pair it with Codex. Cyber-policy refusals (`vulnerable-secret`, `break-filter-js-from-html`) vary between runs; two QEMU tasks hit Debian mirror 404s.

## Results

### Claude Opus 5 vs Claude Code

![Terminal-Bench 2.1 comparison of Mixdog with Claude Opus 5 and Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/design/promo/tb21-opus-vs-claude-code.svg)

- Score: **79/89 vs 77/89** — +2 tasks
- Priced cost: **19% lower** ($104.29 vs $129.21, all 89 tasks)
- Final context: **28% smaller** (median tokens at task end, 27.6K vs 38.2K)
- Speed: **1.16×** (full-trial wall time, 610s vs 708s per trial)

Every Mixdog trial is one Opus 5 session with delegation and helper-model
lookups disabled. The Claude Code baseline uses its standard shipped loop.

### GPT-5.6 Sol xhigh vs Codex CLI

![Terminal-Bench 2.1 comparison of Mixdog with GPT-5.6 Sol xhigh and Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/design/promo/tb21-sol-vs-codex.svg)

- Total tokens: **63% fewer** (156.5M vs 421.4M, input including cached plus output)
- Score: **86.5% (385/445) vs 86.1% (383/445)** — +2 trials at `k=5` both sides
- Pass@5: **96.6% vs 95.5%** (86/89 vs 85/89 tasks solved at least once)
- Priced cost: **39% lower** ($0.476 vs $0.782 per trial at current list rates)
- Initial context: **67% smaller** (median input tokens of the first request, 4.7K vs 14.4K)
- Model requests: **33% fewer** (6,266 vs 9,284 across 445 trials)
- Final context: **46% smaller** (median tokens at task end, 18.5K vs 34.3K)
- Speed: matched — **415s vs 437s** full-trial wall time per trial

Both sides are full `k=5` runs: 445 Mixdog trials paired against 445 Codex CLI
trials. Pairing is per task — each side's five trials are ordered pass-first
and matched index for index, which keeps the outcome counts deterministic and
equal to the per-task overlap.

Speed is wall clock for the whole trial — environment build, agent setup, the
agent itself, verifier, teardown — baseline over Mixdog, read from the same
Harbor timestamps on both sides. The agent-phase-only ratio is also recorded
in each run's `report.json`.
Final context is the median context occupancy of each run's
last model call, measured from the session logs of both harnesses.
Initial context is the median input of each trial's first model request —
system instructions, tool descriptions, and the task prompt — read from the
same session logs.
The Mixdog runs use the product `mixdog exec` path as a strict single-model,
single-session bench. The native baselines keep their standard shipped loops.

Baselines are full runs of each native harness: Claude Code 2.1.220
(`jobs-full-cc-n8`, 77/89, `k=1`) and Codex CLI 0.151.0
(`jobs-full-codex-k5-20260831-050151`, 383/445, `k=5`). The earlier `k=1`
Codex CLI 0.146.0 run (`jobs-full-codex`, 75/89) stays archived: it anchored
the previous published comparison and validates the pre-cut Sol price card.

Neither published Mixdog run is a zero-retry clean run: the Opus pass settled
all 89 tasks with 6 errored trials and 5 infra retries, and the Sol run
settled all 445 trials with 9 agent timeouts and no retries. The Codex `k=5`
baseline settled all 445 trials with 7 agent timeouts and no retries.

Cost covers every trial on both sides. The snapshot gap that once dropped
`agent/usage.json` when the agent timeout killed a trial is closed — the
runtime now flushes that file after every model response — so all 445 Sol
trials and all 89 Opus trials carry their own usage snapshot and none is
priced by recovery. `analysis/trace-cost.mjs` still reprices a run from the
raw `agent/agent-trace.jsonl` as an independent cross-check; rows recovered
that way for earlier runs stay archived in
[`records/trace-recovered-cost.json`](records/trace-recovered-cost.json).

Cost is a token valuation at published API list rates, not an invoice: every
run here authenticates through an OAuth subscription, so the dollar figures
compare what the same work would cost per token, harness against harness.
Both Sol totals use the current GPT-5.6 Sol card — $4 input, $0.40 cached,
$5 cache write (1.25× input), $20 output per million tokens. OpenAI cut the
Sol list price in August 2026; the card is validated against Harbor's own
`cost_usd`, which fits the pre-cut 5/0.5/30 card with zero residual on the
2026-08-02 Codex run and the current 4/0.4/20 card with zero residual on all
445 trials of the 2026-08-31 run. Mixdog trials are priced from their usage
snapshots on that same card ($211.71 total); the Codex baseline's
Harbor-reported `cost_usd` ($347.89 total) is that card by construction.

Anthropic prices cache writes separately and both Opus-side runs record them.
The GPT-5.6 Sol rate card prices them too, but every OpenAI-side response —
ours and Codex's alike — reports `cache_write_tokens: 0` on every task, so
neither Sol total is missing a priced component.

## Contents
The directory is split into how to run, what runs, and what was recorded.

**How to run** — commands under "Reproduce" below
- `run.ps1` — the synchronous benchmark runner
- `presets.json` — model presets, the published runs, and the pinned baselines
- `preset-history.json` — archived runs registered for preset comparisons

**What runs**
- `harness/` — Harbor installed-agent adapter, Lead driver, launcher
- `analysis/` — metric scripts that recompute every published number from raw artifacts
  - `verify-source-commit.mjs` — re-derives each run's contract digests from the source commit and compares them to what the run recorded
  - `publish-assets.mjs` — regenerates the tables and cost archive from the run reports and prints the figures to quote
  - `export-raw.mjs` — files a local run under `records/` and adds its `records/index.json` entry

**What was recorded** — `records/`
- `<harness>/<model>/<date>[-k5]/` and `index.json` — committed verification
  artifacts for every published run (see "Results layout" below), including the
  external DeepSeek V4.1 Flash run from PR #43 (Mixdog vs DSH,
  `records/mixdog/deepseek-v4.1-flash/2026-10-12/` and `records/dsh/deepseek-v4.1-flash/2026-10-12/`): Harbor
  `result.json`, `config.json` with the pinned task checksum, official verifier
  output, and the usage snapshot each cost figure is priced from; runs made
  after provenance capture also archive `runtime-provenance.json` and the
  per-file `runtime-manifest.json`
- `results.md` / `results.json` — per-task outcomes of the published runs
- `source-provenance.json` — the source commit each published Mixdog run executed
- `first-context.json` — first-request medians read from the local session logs
- `trace-recovered-cost.json` — raw token splits for the timeout trials priced from the agent trace
- `baselines/` — the pinned Claude Code cost baseline (`cc-baseline.json`) and its extension (`cc-baseline-plus.json`)

Local only: `jobs-*` — full local run directories, session transcripts included (not committed).

The comparison graphs are promo material and live in `design/promo/`.

## Reproduce
Everything that defines the published runs is pinned in this directory:
`harness/mixdog_agent.py` (Harbor adapter), `harness/route_profiles.json`
(the exact route configuration), and `harness/run-tb21.ps1` (launcher).
Versions: Claude Code **2.1.220**
(linux-x64 prebaked), Codex CLI **0.151.0** for the `k=5` baseline
(**0.146.0** for the archived `k=1` run), dataset
`terminal-bench/terminal-bench-2-1` (per-trial `task_checksum` recorded in
each archived `config.json`).

Both Mixdog runs install the published npm package **0.9.150** as a dependency
shell and overlay the local source tree on top of it, so the package version
alone does not name the code that ran. That source is commit **`09eea819`**,
pinned in `records/source-provenance.json` and checkable with
`node analysis/verify-source-commit.mjs`: it extracts the commit into a clean
tree, recomputes the rules, prompt-surface, and tool-contract digests there
with that commit's own `analysis/contract-hash.mjs`, and compares them to the
digests archived with each run. Both runs executed from the working tree that
became that commit about 45 minutes later. Those digests cover the complete
model-facing contract — 18 rule files, the tool schemas, and the delivered
prompt surface — not every byte of `src/`. Runs made after this was added
record the commit, whether the tree matched it, and the sha256 of the uploaded
runtime bundle directly in `runtime-provenance.json`, with a per-file
`runtime-manifest.json` alongside it.

Prereqs: Docker + [Harbor](https://github.com/laude-institute/harbor), and
your own provider auth configured through Mixdog on the host.

### Mixdog presets
```powershell
cd benchmarks/terminal-bench-2.1
.\run.ps1 -Preset sol-xhigh
.\run.ps1 -Preset grok46-xhigh
.\run.ps1 -Preset opus5-solo

# Full-suite equivalents used for published comparisons (fixed effort)
.\run.ps1 -Preset full-opus5-solo -EffortJudge off
.\run.ps1 -Preset full-sol-xhigh -EffortJudge off

# Bench log 2026-10-15: GPT-6.1 Sol xhigh, Auto effort (steps), web search on,
# paired with the pinned Codex CLI run (codex-gpt61-sol)
.\run.ps1 -Preset full-sol61
```

### Effort judge
Every preset runs with the product's default Auto effort: a local effort
judge picks the effort of each turn and re-judges after every tool result.
`-EffortJudge` switches it for any preset:

| `-EffortJudge` | Effect |
|---|---|
| `steps` (default) | the judge picks each turn's effort and re-judges after every tool result, as the product does (needs a step-trained judge) |
| `on` | the judge picks each turn's effort only |
| `off` | fixed effort from the route profile, as in the published runs |

The judge runs from `mixdog-prebake/effort-judge-bundle.tar`, built once from
the release that `src/runtime/effort-judge/model-manifest.json` names (files
downloaded from the Mixdog GitHub release and sha256-checked). The first real
run builds it automatically (at `MIXDOG_TB_EFFORT_JUDGE_BUNDLE` when set);
the manual command stays available:
```powershell
.\harness\build-effort-judge-bundle.ps1
```
Before launching, the runner checks that the bundle exists, holds that
release (step-trained for `steps`), and matches its stamp digest. A real run
rebuilds a missing or stale bundle with that script, re-verifies it, and stops
with the rebuild hint if the build fails. `-DryRun` never builds: it prints a
notice that the bundle is missing/stale and continues with the expected command. The judge mode and release are part of the preset
fingerprint (`off` leaves it unchanged), and every trial records its
decisions in `agent/effort-decisions.jsonl`. `run.ps1` and `run-tb21.ps1`
pass the mode to the Harbor adapter as `--ak effort_judge=<mode>`; launching
`harness.mixdog_agent:MixdogAgent` directly defaults to the same `steps`, so
add `--ak effort_judge=off` for a fixed-effort run there.
Each preset pins its task suite, complete model route, concurrency, and repeat
count. The runner auto-retries infra errors only — agent timeouts and verifier
failures are never retried. At completion it synchronously writes
`report.json` / `report.md`, prints the score, time, tokens, and reduction
metrics, ranks the run against clean equal-score runs with the exact same
preset fingerprint (including explicitly verified archived runs), reports the
largest per-task timing regression, then returns immediately. Full Sol and Opus presets also
pair every completed task with the pinned Codex CLI and Claude Code runs,
respectively, reporting score flips, speed, tokens, priced cost, and final
context. `-DryRun` prints the resolved preset, routes, and exact Harbor command
without launching anything.

Read a live run without starting a watcher or changing its state:
```powershell
.\run.ps1 -Preset full-sol-xhigh -Status
.\run.ps1 -JobsDir jobs-full-sol-xhigh-YYYYMMDD-HHmmss -Status
```
Status returns an immediate snapshot and uses settled shared tasks for a
provisional pair comparison. The completion report replaces it with the full
89-task comparison.
Benchmark runs also retain the session transcript and reduction trace under
each Harbor trial's `agent/` directory, so final-context and reduction metrics
remain reproducible.

### Baselines (native harnesses)
```powershell
$env:PYTHONPATH = (Get-Location).Path
# Claude Code — prebaked pinned binary + host OAuth token
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.claude_code_prebaked:ClaudeCodePrebaked `
  -m claude-opus-5 --ak reasoning_effort=high `
  --agent-setup-timeout-multiplier 4 -o jobs-cc -n 8 -r 2 -q -y
# Codex CLI — Harbor's stock codex agent, k=5
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent codex -m gpt-5.6-sol --ak reasoning_effort=xhigh `
  -o jobs-codex -n 8 -k 5 -r 2 -q -y
# Codex CLI 0.162.1 — GPT-6.1 Sol xhigh, k=1 (bench log 2026-10-15);
# CODEX_FORCE_AUTH_JSON=1 hands the host's ChatGPT login to the container
$env:CODEX_FORCE_AUTH_JSON = "1"
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent codex -m gpt-6.1-sol --ak reasoning_effort=xhigh `
  -o jobs-codex-sol61-xhigh-full -n 8 -k 1 -r 2 `
  --retry-exclude AgentTimeoutError --retry-exclude VerifierOutputParseError `
  --retry-exclude RewardFileEmptyError -q -y
```

### Publish a new pair of runs
Point `presets.json` → `published` at the new job directories, then:
```powershell
node analysis/publish-assets.mjs
```
That regenerates `records/results.md`/`.json` and
`records/trace-recovered-cost.json` straight from each run's `report.json`,
then prints the score, speed, context, and cost figures to quote. It never
edits a README or draws a chart: the prose above and the graphs in
`design/promo/` are made by hand from that output, which is also where a
`clean=false` run or a lower-bound baseline is flagged.

A `k=1` run that does not replace a published pair goes in the
[Bench log](#bench-log) instead: export it with `analysis/export-raw.mjs`, pair
it through the preset's `compareTo` baseline, and add one row (newest first)
with that run's changes and notes. The root README's *Latest run* row points
at the newest entry.

### Verify the published numbers from the raw artifacts
Run from `benchmarks/terminal-bench-2.1`. These work from the committed
committed export alone (a full local `jobs-*` copy is used instead when present):
```powershell
node analysis/verify-source-commit.mjs  # each published run ↔ the source commit it ran
node analysis/results-table.mjs   # regenerates records/results.md/.json
node harness/cost-exact.mjs jobs-full-opus5-solo-20260825-155233/2026-08-26__00-52-35 records/baselines/cc-baseline-plus.json
node harness/cost-exact.mjs jobs-full-sol-xhigh-k5-20260825-182921/2026-08-26__03-29-24
```
These read session logs and traces, which the committed export does not archive, so
they need the full local `jobs-*` directories and stop with an error without them:
```powershell
node analysis/final-context.mjs   # final-context medians for all runs
node analysis/first-context.mjs   # first-request medians
# Full-run cost: reprice from raw traces and cross-check every snapshot
node analysis/trace-cost.mjs jobs-full-opus5-solo-20260825-155233
node analysis/trace-cost.mjs jobs-full-sol-xhigh-k5-20260825-182921
```

`records/baselines/cc-baseline-plus.json` extends the pinned `cc-baseline.json` with the eight
tasks absent from it, mined from the raw Claude Code trajectories in
`jobs-full-cc-n8/` (extraction validated field-for-field against the pinned
entries on shared tasks); the pinned original is unmodified.

### Results layout
Published results are filed under `records/`:

```
records/<harness>/<model>/<YYYY-MM-DD>[-k5]/
```

Every harness sits at the same level.

- `<harness>`: `mixdog`, `claude-code`, `codex`, `dsh`, ...
- `<model>`: the model the harness drove (`claude-opus-5`, `gpt-5.6-sol`, ...).
- `<YYYY-MM-DD>[-k5]`: the run start date (the date in the run id when it has
  one), plus `-k5` when the run used k=5 attempts.

`records/index.json` lists every result with `jobsDir` (the run's original jobs
directory name, as used by `presets.json` and the analysis tools), `path`
(relative to `records/`), `model`, `date`, `harness`, `harnessVersion` when
known, `k`, `score` (passed/total) and `source` (`mixdog` or an external PR).
Tools resolve a `jobsDir` (optionally followed by a sub-run such as
`jobs-full-cc-n8/2026-08-02__19-20-02`) through this index; a full local
`jobs-*` directory takes precedence when present.

To add a result, put it under `records/<harness>/<model>/<date>[-k5]/` and add a
`records/index.json` entry with the fields above, keeping `jobsDir` stable. For a local
Mixdog run, `node benchmarks/terminal-bench-2.1/analysis/export-raw.mjs` (from the repo root, with the jobs
directory listed in its `RUNS`) exports it and adds or updates the entry.
External submissions keep their internal layout (see
`records/mixdog/deepseek-v4.1-flash/2026-10-12/`) and use `"source": "external PR #N"`.

### Claim → raw evidence map
| Claim | Raw artifacts |
|---|---|
| Mixdog Opus 5 79/89 (single-model, single-session) | `records/mixdog/claude-opus-5/2026-08-25/` |
| Claude Code 77/89 | `records/claude-code/claude-opus-5/2026-08-02/` |
| Mixdog Sol 385/445, `k=5` (single-model, single-session) | `records/mixdog/gpt-5.6-sol/2026-08-25-k5/` |
| Codex CLI 383/445, `k=5` | `records/codex/gpt-5.6-sol/2026-08-31-k5/` |
| Codex CLI 75/89, archived `k=1` | `records/codex/gpt-5.6-sol/2026-08-02/` |
| DeepSeek V4.1 Flash, Mixdog 68/89 vs DSH 64/88 (external, PR #43) | `records/mixdog/deepseek-v4.1-flash/2026-10-12/`, `records/dsh/deepseek-v4.1-flash/2026-10-12/` |

Every trial directory under each result folder archives `result.json` (Harbor verdict),
`config.json` (agent config + task checksum), the official verifier output, and
the usage snapshot — scores, verifier results, and priced cost are
recomputable from these files alone. Figures read from session logs or traces
need the local `jobs-*` directories: the final-context medians
(`analysis/final-context.mjs`, pinned for the baselines in `presets.json`), the
first-request medians (pinned in `records/first-context.json`), and the
trace-priced timeout trials (`analysis/trace-cost.mjs`, archived in
`records/trace-recovered-cost.json`). Full session transcripts stay in the
local `jobs-*` directories.
