# mixdog — Terminal-Bench 2.1 controlled comparisons

Two primary-model-matched full runs compare mixdog directly with the native
coding harness for the same model family. Each run covers all 89 tasks with
unmodified task timeouts and resources. Results are self-reported single runs
(`k=1`, 2026-08), not leaderboard submissions.

Together the runs show mixdog matching or beating the harnesses that hold the
current Terminal-Bench 2.1 leaderboard #1 and #2 spots — on score, while
running 1.27–1.43× faster at 29–40% lower priced cost with the same model and
reasoning level.

## Results

### Claude Opus 5 vs Claude Code

![Terminal-Bench 2.1 comparison of mixdog with Claude Opus 5 and Claude Code](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-opus-vs-claude-code.svg)

- Score: **78/89 vs 77/89** — mixdog ahead by one task
- Speed: **1.43×**
- Final context: **40% smaller** (median tokens at task end, 22.8K vs 38.2K)
- Priced cost: **29% lower**

### GPT-5.6 Sol xhigh vs Codex CLI

![Terminal-Bench 2.1 comparison of mixdog with GPT-5.6 Sol xhigh and Codex CLI](https://raw.githubusercontent.com/tribgames/mixdog/main/benchmarks/terminal-bench-2.1/tb21-sol-vs-codex.svg)

- Score: **75/89 vs 75/89**
- Speed: **1.27×**
- Final context: **47% smaller** (median tokens at task end, 17.7K vs 33.5K)
- Priced cost: **at least 39.7% lower**

Speed is baseline elapsed agent time divided by mixdog elapsed agent time.
Final context is the median context occupancy of each run's last model call,
measured from the session logs of both harnesses.
Every run is the harness's standard single-agent loop: the mixdog side uses
the Solo workflow with no sub-agent delegation, routing only scoped Explorer
lookups to a smaller model. These are product-as-shipped comparisons rather
than stripped-harness A/Bs: Claude Code's own built-in Explore subagent runs
Haiku 4.5 by default in the 2.1.x baseline, so the Opus comparison is
helper-for-helper parity; Codex CLI ships no equivalent helper, and the
Sol-led mixdog run used GPT-5.6 Luna for that scoped Explorer work. The Sol
score tie contains eight unique task wins on each side.

Baselines are full 89-task runs of each native harness: Claude Code 2.1.220
(`jobs-full-cc-n8`, 77/89 settled) and Codex CLI (`jobs-full-codex`, 75/89).

Anthropic cost includes measured cache writes. The archived OpenAI runs did not
retain `cache_write_tokens`; at 2026-08 list prices, mixdog is bounded at
**$54.50–$58.84**, while Codex's recorded **$97.54** is a lower bound.

## Contents
- `results.md` / `results.json` — per-task outcomes of the two 2026-08-04 clean runs
- `harness/` — Harbor installed-agent adapter, Lead driver, launcher
- `analysis/` — metric scripts that recompute every published number from raw artifacts
- `tb21-opus-vs-claude-code.svg` — Opus comparison graph
- `tb21-sol-vs-codex.svg` — Sol comparison graph
- `jobs-*` — raw Harbor `result.json`, agent logs, and usage snapshots

## Reproduce
Everything that defines the four published runs is pinned in this directory:
`harness/mixdog_agent.py` (Harbor adapter), `harness/lead_driver.mjs` (Lead
loop driver), `harness/route_profiles.json` (the exact per-role routes used),
and `harness/run-tb21.ps1` (launcher). Versions: Claude Code **2.1.220**
(linux-x64 prebaked), Codex CLI **0.146.0**, dataset
`terminal-bench/terminal-bench-2-1` (per-trial `task_checksum` recorded in
each archived `config.json`).

Prereqs: Docker + [Harbor](https://github.com/laude-institute/harbor), and
your own provider auth configured through mixdog on the host.

### mixdog (the two published runs)
```powershell
cd benchmarks/terminal-bench-2.1
.\harness\run-tb21.ps1 -JobsDir jobs-opus5 -Concurrent 8 `
  -RouteProfile opus5-solo -Workflow solo-bench
.\harness\run-tb21.ps1 -JobsDir jobs-sol -Concurrent 8 `
  -RouteProfile sol-xhigh -Workflow solo-bench
```
The launcher auto-retries infra errors only — agent timeouts and verifier
failures are never retried. `-DryRun` prints the resolved routes and the
exact Harbor command without launching anything.

### Baselines (native harnesses)
```powershell
$env:PYTHONPATH = (Get-Location).Path
# Claude Code — prebaked pinned binary + host OAuth token (see full-run-cc-n8.ps1)
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
node analysis/results-table.mjs   # regenerates results.md/.json (78/89, 75/89)
node analysis/final-context.mjs   # final-context medians for all four runs
node harness/cost-exact.mjs jobs-full-opus5-clean-20260804-042235 cc-baseline.json  # cost/speed
```

### Claim → raw evidence map
| Claim | Raw artifacts |
|---|---|
| mixdog Opus 5 78/89 | `jobs-full-opus5-clean-20260804-042235/` |
| Claude Code 77/89 | `jobs-full-cc-n8/` (`full-run-cc-n8-status.txt`: settled=89 pass=77) |
| mixdog Sol 75/89 | `jobs-full-solxhigh-clean-20260804-042235/` |
| Codex CLI 75/89 | `jobs-full-codex/` |

Every trial directory archives `result.json` (verifier reward),
`config.json` (agent config + task checksum), the full agent session logs,
and usage snapshots — each published metric is recomputable from these files
alone.
