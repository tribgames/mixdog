# mixdog — Terminal-Bench 2.1 controlled comparisons

Primary-model-matched full runs compare mixdog directly with the native
coding harness for the same model family. Each run covers all 89 tasks with
unmodified task timeouts and resources. Results are self-reported single runs
(`k=1`, 2026-08), not leaderboard submissions.

These runs test whether mixdog can match the native harnesses on results
while spending far less to get there. The mixdog side is a strict
**single-model, single-session bench**: one primary model, no sub-agent
delegation, and no helper-model lookups. Single runs (`k=1`) mean per-task
score differences sit within normal run-to-run variance; the efficiency gap
is consistent across both pairs.

## Results

### Claude Opus 5 vs Claude Code

![Terminal-Bench 2.1 comparison of mixdog with Claude Opus 5 and Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

- Score: **78/89 vs 77/89** — within single-run noise
- Speed: **1.43×**
- Final context: **40% smaller** (median tokens at task end, 22.8K vs 38.2K)
- Priced cost: **29% lower**

Every mixdog trial is one Opus 5 session with delegation and helper-model
lookups disabled. The Claude Code baseline uses its standard shipped loop.

### GPT-5.6 Sol xhigh vs Codex CLI

![Terminal-Bench 2.1 comparison of mixdog with GPT-5.6 Sol xhigh and Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- Score: **75/89 vs 75/89** — tie
- Speed: **1.27×**
- Final context: **47% smaller** (median tokens at task end, 17.7K vs 33.5K)
- Priced cost: **at least 39.7% lower**

Speed is baseline elapsed agent time divided by mixdog elapsed agent time.
Final context is the median context occupancy of each run's last model call,
measured from the session logs of both harnesses.
The mixdog runs use the product `mixdog exec` path as a strict single-model,
single-session bench. The native baselines keep their standard shipped loops.

Baselines are full 89-task runs of each native harness: Claude Code 2.1.220
(`jobs-full-cc-n8`, 77/89 settled) and Codex CLI (`jobs-full-codex`, 75/89).

Anthropic cost includes measured cache writes. The archived Codex run did not
retain `cache_write_tokens`, so its recorded **$97.54** is a lower bound.

## Contents
- `results.md` / `results.json` — per-task outcomes of the published runs
- `presets.json` / `run.ps1` — model presets and the synchronous benchmark runner
- `harness/` — Harbor installed-agent adapter, Lead driver, launcher
- `analysis/` — metric scripts that recompute every published number from raw artifacts
- `tb21-opus-vs-claude-code.svg` — Opus comparison graph
- `tb21-sol-vs-codex.svg` — Sol comparison graph
- `jobs-*` — raw Harbor `result.json`, agent logs, and usage snapshots

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

### Verify the published numbers from the raw artifacts
```powershell
node analysis/results-table.mjs   # regenerates results.md/.json
node analysis/final-context.mjs   # final-context medians for all runs
node harness/cost-exact.mjs jobs-full-opus5-clean-20260804-042235/2026-08-04__04-22-48 cc-baseline-plus.json
node harness/cost-exact.mjs jobs-full-solxhigh-clean-20260804-042235/2026-08-04__06-40-38
```

`cc-baseline-plus.json` extends the pinned `cc-baseline.json` with the eight
tasks absent from it, mined from the raw Claude Code trajectories in
`jobs-full-cc-n8/` (extraction validated field-for-field against the pinned
entries on shared tasks); the pinned original is unmodified.

### Claim → raw evidence map
| Claim | Raw artifacts |
|---|---|
| mixdog Opus 5 78/89 (single-model, single-session) | `jobs-full-opus5-clean-20260804-042235/` |
| Claude Code 77/89 | `jobs-full-cc-n8/` (`full-run-cc-n8-status.txt`: settled=89 pass=77) |
| mixdog Sol 75/89 (single-model, single-session) | `jobs-full-solxhigh-clean-20260804-042235/` |
| Codex CLI 75/89 | `jobs-full-codex/` |

Every trial directory archives `result.json` (verifier reward),
`config.json` (agent config + task checksum), the full agent session logs,
and usage snapshots — each published metric is recomputable from these files
alone.
