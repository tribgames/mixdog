# Benchmarks

| Benchmark | What it measures | How to run | Records |
|---|---|---|---|
| [`terminal-bench-2.1/`](terminal-bench-2.1/) | Mixdog against the native harnesses (Claude Code, Codex CLI) on all 89 Terminal-Bench 2.1 tasks, same model on both sides | [Reproduce](terminal-bench-2.1/README.md#reproduce) | [`terminal-bench-2.1/records/`](terminal-bench-2.1/records/) |
| [`token-lang/`](token-lang/) | Input-token inflation of ten languages against English, per model | `node benchmarks/token-lang/measure.mjs`, then `node benchmarks/token-lang/chart.mjs` | [`token-lang/results/`](token-lang/results/) |

Each benchmark keeps the same split: its README or script header says how to
run it, the harness and tools sit next to it, and results go into its records
folder.

## Adding a Terminal-Bench result

Results accumulate under `terminal-bench-2.1/records/<harness>/<model>/<date>[-k5]/`,
one folder per run, each listed in `terminal-bench-2.1/records/index.json`.
For a local Mixdog run, add its `jobs-*` directory to `RUNS` in
`terminal-bench-2.1/analysis/export-raw.mjs` and run it from the repo root:

```powershell
node benchmarks/terminal-bench-2.1/analysis/export-raw.mjs
```

It copies the verification files into the right folder and adds or updates the
index entry. Other results go in by hand under the same layout; see
[Results layout](terminal-bench-2.1/README.md#results-layout).
