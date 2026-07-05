# mixdog — Terminal-Bench 2.1 Results (self-reported)

**Score: 80/89 = 89.9%** (single run, k=1)

## Setup
- **Agent**: mixdog Lead session — multi-agent orchestration (Lead planner + scoped sub-agents, per-role model routing). Harbor adapter in `harness/`.
- **Primary model**: Claude Fable 5, reasoning effort **HIGH**.
- **Dataset**: `terminal-bench/terminal-bench-2-1` (89 tasks) via Harbor, Docker. Timeouts/resources unmodified.

## Notes
- Measured **once (k=1) due to cost**; the official leaderboard uses k=5 averages.
- 4 tasks refused by the primary model's safety layer were re-run routed to **Claude Opus 4.8 (effort xhigh)** and passed.

## Contents
- `results.md` / `results.json` — per-task outcome + source job
- `harness/` — Harbor installed-agent adapter, Lead driver, launcher
- `harness/mixdog-config.example.json` — the exact per-role routing used for
  this run (Lead: Fable 5 high · explore: Haiku 4.5 · worker: Opus 4.8 medium ·
  heavy-worker: Opus 4.8 high · reviewer: GPT-5.5 high/fast), credentials
  stripped
- `jobs/` — raw Harbor `result.json` + `config.json` for every constituent run

## Reproduce
Prereqs: Docker + [Harbor](https://github.com/laude-institute/harbor), and
your own provider auth under `~/.mixdog/data` (Anthropic OAuth + OpenAI OAuth
for this routing config — run `mixdog` once and use `/providers`). Then merge
`harness/mixdog-config.example.json` into `~/.mixdog/data/mixdog-config.json`
to get the exact routing used for this run.

```powershell
cd benchmarks/terminal-bench-2.1
$env:PYTHONPATH = (Get-Location).Path
harbor run -d terminal-bench/terminal-bench-2-1 `
  --agent-import-path harness.mixdog_agent:MixdogAgent `
  -n 4 -k 5 -o jobs-tb21
```

Or use the launcher (auto-retries infra errors only — agent timeouts and test
failures are never retried):

```powershell
.\harness\run-tb21.ps1 -JobsDir jobs-tb21
```

## Context — official leaderboard (fetched 2026-07-06)
| Rank | Agent | Model | Accuracy |
|---|---|---|---|
| 1 | Codex CLI | GPT-5.5 | 83.4% ± 2.2 |
| 2 | Claude Code | Claude 5 Fable | 83.1% ± 2.0 |
| 3 | Terminus 2 | Claude 5 Fable | 80.4% ± 2.3 |

This run (self-reported, k=1): **89.9%** — same primary model as rank 2/3.
Token/cost telemetry was not captured by Harbor for this run (`cost_usd: null`); the planned k=5 run will report tokens + cost per trial.
