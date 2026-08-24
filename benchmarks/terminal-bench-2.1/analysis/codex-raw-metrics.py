"""Per-trial context and model-call counts for a Codex baseline run, read from
its own raw artifacts.

The pinned `finalContextMedianTokens` in presets.json is a run-wide constant, so
a pair comparison against it silently compares different task sets. Codex writes
everything needed per trial:

  trajectory.json  final_metrics.extra.last_token_usage.input_tokens
                   -> prompt size of the LAST model call = final context
  rollout-*.jsonl  one `token_count` event per model response
                   -> provider requests, the same unit our own runs report
                      (final_metrics.total_steps counts trajectory steps, which
                      is NOT that unit and must not be compared to it)
"""

import glob
import json
import os
import statistics
import sys


def scan(base):
    rows = []
    for trial in sorted(glob.glob(os.path.join(base, "*"))):
        if not os.path.isdir(trial):
            continue
        path = os.path.join(trial, "agent", "trajectory.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf8") as handle:
            metrics = (json.load(handle) or {}).get("final_metrics") or {}
        last = (metrics.get("extra") or {}).get("last_token_usage") or {}
        calls = 0
        for rollout in glob.glob(
            os.path.join(trial, "agent", "sessions", "**", "rollout-*.jsonl"),
            recursive=True,
        ):
            with open(rollout, encoding="utf8", errors="replace") as handle:
                calls += sum(1 for line in handle if '"token_count"' in line)
        rows.append({
            "task": os.path.basename(trial).split("__")[0],
            "steps": metrics.get("total_steps"),
            "calls": calls,
            "context": last.get("input_tokens"),
            "cached": last.get("cached_input_tokens"),
        })
    return rows


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else (
        "benchmarks/terminal-bench-2.1/jobs-full-codex/2026-08-02__12-19-11"
    )
    rows = scan(base)
    contexts = [row["context"] for row in rows if isinstance(row["context"], int)]
    steps = [row["steps"] for row in rows if isinstance(row["steps"], int)]
    calls = [row["calls"] for row in rows if row["calls"]]
    print(f"trials={len(rows)} with_context={len(contexts)} with_calls={len(calls)}")
    if contexts:
        print(
            "final_context median=%d mean=%d min=%d max=%d"
            % (
                statistics.median(contexts),
                sum(contexts) / len(contexts),
                min(contexts),
                max(contexts),
            )
        )
    print(f"total_steps_sum={sum(steps)} model_calls_sum={sum(calls)}")
    print(json.dumps(rows[:5], indent=2))


if __name__ == "__main__":
    main()
