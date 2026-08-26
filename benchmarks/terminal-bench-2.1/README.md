# mixdog — Terminal-Bench 2.1 controlled comparisons

Model-matched full runs compare mixdog directly with the native coding harness
for the same model family. Each run covers all 89 tasks with unmodified task
timeouts and resources, scored by the official Harbor verifier.

The Sol run follows the protocol the official leaderboard requires: all 89
tasks repeated five times (`k=5`, 445 trials). The Opus run and both native
baselines are single passes (`k=1`, 89 trials each), where per-task score
differences sit within normal run-to-run variance. The leaderboard is not
accepting community submissions, so these runs are published with their raw
artifacts under `raw-runs/` instead of submitted.

These runs test whether mixdog can match the native harnesses on results
while spending far less to get there. The mixdog side is a strict
**single-model, single-session bench**: one primary model, no sub-agent
delegation, and no helper-model lookups.

## Results

### Claude Opus 5 vs Claude Code

![Terminal-Bench 2.1 comparison of mixdog with Claude Opus 5 and Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

- Score: **79/89 vs 77/89** — +2 tasks
- Speed: **1.15×**
- Final context: **28% smaller** (median tokens at task end, 27.6K vs 38.2K)
- Priced cost: **19% lower** ($104.29 vs $129.21, all 89 tasks)

Every mixdog trial is one Opus 5 session with delegation and helper-model
lookups disabled. The Claude Code baseline uses its standard shipped loop.

### GPT-5.6 Sol xhigh vs Codex CLI

![Terminal-Bench 2.1 comparison of mixdog with GPT-5.6 Sol xhigh and Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- Score: **86.5% (385/445) vs 84.3% (75/89)** — +2.2pp
- Speed: **1.11×**
- Final context: **45% smaller** (median tokens at task end, 18.5K vs 33.5K)
- Priced cost: **42% lower** ($0.641 vs $1.096 per trial)

The mixdog side is a `k=5` run; the Codex CLI baseline is a single `k=1` pass,
so its 89 trials are repeated across the 445 for the paired speed, context, and
cost ratios. Score is compared as a percentage, never as a scaled task count.

Speed is baseline elapsed agent time divided by mixdog elapsed agent time.
Final context is the median context occupancy of each run's last model call,
measured from the session logs of both harnesses.
The mixdog runs use the product `mixdog exec` path as a strict single-model,
single-session bench. The native baselines keep their standard shipped loops.

Baselines are full 89-task runs of each native harness: Claude Code 2.1.220
(`jobs-full-cc-n8`, 77/89 settled) and Codex CLI (`jobs-full-codex`, 75/89).

Neither published run is a zero-retry clean run: the Opus pass settled all 89
tasks with 6 errored trials and 5 infra retries, and the Sol run settled all
445 trials with 9 agent timeouts and no retries.

Cost covers every trial on both sides. The snapshot gap that once dropped
`agent/usage.json` when the agent timeout killed a trial is closed — the
runtime now flushes that file after every model response — so all 445 Sol
trials and all 89 Opus trials carry their own usage snapshot and none is
priced by recovery. `analysis/trace-cost.mjs` still reprices a run from the
raw `agent/agent-trace.jsonl` as an independent cross-check; rows recovered
that way for earlier runs stay archived in
[`analysis/trace-recovered-cost.json`](analysis/trace-recovered-cost.json).

Cost is a token valuation at published API list rates, not an invoice: every
run here authenticates through an OAuth subscription, so the dollar figures
compare what the same work would cost per token, harness against harness.

Anthropic prices cache writes separately and both Opus-side runs record them.
The GPT-5.6 Sol rate card prices them too, but every OpenAI-side response —
ours and Codex's alike — reports `cache_write_tokens: 0` on all 89 tasks, so
neither Sol total is missing a priced component.

## Contents
- `results.md` / `results.json` — per-task outcomes of the published runs
- `presets.json` / `run.ps1` — model presets and the synchronous benchmark runner
- `harness/` — Harbor installed-agent adapter, Lead driver, launcher
- `analysis/` — metric scripts that recompute every published number from raw artifacts
- `analysis/publish-assets.mjs` — regenerates the charts, tables, and cost archive from the run reports
- `analysis/trace-recovered-cost.json` — raw token splits for the timeout trials priced from the agent trace
- `tb21-opus-vs-claude-code.svg` — Opus comparison graph
- `tb21-sol-vs-codex.svg` — Sol comparison graph
- `raw-runs/` — committed verification artifacts for every published run: Harbor
  `result.json`, `config.json` with the pinned task checksum, official verifier
  output, and the usage snapshot each cost figure is priced from
- `analysis/export-raw.mjs` — rebuilds `raw-runs/` from the local run directories
- `jobs-*` — full local run directories, session transcripts included (not committed)

## Reproduce
Everything that defines the published runs is pinned in this directory:
`harness/mixdog_agent.py` (Harbor adapter), `harness/route_profiles.json`
(the exact route configuration), and `harness/run-tb21.ps1` (launcher).
Versions: Claude Code **2.1.220**
(linux-x64 prebaked), Codex CLI **0.146.0**, dataset
`terminal-bench/terminal-bench-2-1` (per-trial `task_checksum` recorded in
each archived `config.json`).

Prereqs: Docker + [Harbor](https://github.com/laude-institute/harbor), and
your own provider auth configured through mixdog on the host.

### mixdog presets
```powershell
cd benchmarks/terminal-bench-2.1
.\run.ps1 -Preset sol-xhigh
.\run.ps1 -Preset grok46-xhigh
.\run.ps1 -Preset opus5-solo

# Full-suite equivalents used for published comparisons
.\run.ps1 -Preset full-opus5-solo
.\run.ps1 -Preset full-sol-xhigh
```
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
# Codex CLI — Harbor's stock codex agent
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent codex -m gpt-5.6-sol --ak reasoning_effort=xhigh `
  -o jobs-codex -n 8 -r 2 -q -y
```

### Publish a new pair of runs
Point `presets.json` → `published` at the new job directories, then:
```powershell
node analysis/publish-assets.mjs
```
That regenerates both comparison charts, `results.md`/`.json`, and
`analysis/trace-recovered-cost.json` straight from each run's `report.json`,
then prints the score, speed, context, and cost figures to quote. It never
edits a README: the prose above is written by hand from that output, which is
also where a `clean=false` run or a lower-bound baseline is flagged.

### Verify the published numbers from the raw artifacts
```powershell
node analysis/results-table.mjs   # regenerates results.md/.json
node analysis/final-context.mjs   # final-context medians for all runs
node harness/cost-exact.mjs jobs-full-opus5-solo-20260825-155233/2026-08-26__00-52-35 cc-baseline-plus.json
node harness/cost-exact.mjs jobs-full-sol-xhigh-k5-20260825-182921/2026-08-26__03-29-24

# Full-run cost: reprice from raw traces and cross-check every snapshot
node analysis/trace-cost.mjs jobs-full-opus5-solo-20260825-155233
node analysis/trace-cost.mjs jobs-full-sol-xhigh-k5-20260825-182921
```

`cc-baseline-plus.json` extends the pinned `cc-baseline.json` with the eight
tasks absent from it, mined from the raw Claude Code trajectories in
`jobs-full-cc-n8/` (extraction validated field-for-field against the pinned
entries on shared tasks); the pinned original is unmodified.

### Claim → raw evidence map
| Claim | Raw artifacts |
|---|---|
| mixdog Opus 5 79/89 (single-model, single-session) | `raw-runs/jobs-full-opus5-solo-20260825-155233/` |
| Claude Code 77/89 | `raw-runs/jobs-full-cc-n8/` |
| mixdog Sol 385/445, `k=5` (single-model, single-session) | `raw-runs/jobs-full-sol-xhigh-k5-20260825-182921/` |
| Codex CLI 75/89 | `raw-runs/jobs-full-codex/` |

Every trial directory under `raw-runs/` archives `result.json` (Harbor verdict),
`config.json` (agent config + task checksum), the official verifier output, and
the usage snapshot — each published metric is recomputable from these files
alone. Full session transcripts stay in the local `jobs-*` directories.
