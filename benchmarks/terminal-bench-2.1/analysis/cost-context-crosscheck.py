"""Cross-check reported cost against the runtime's own per-turn accounting, and
check the final-context formula against the unambiguous prompt_tokens.

Cost: run-report prices tokens itself (model-rates.mjs). The runtime independently
priced every turn while it ran (agent-trace `usage` rows carry costUsd). Two
independent paths over the same run should agree.

Context: `input + cached + cache_write` is the report's formula. It matches
prompt_tokens only when input EXCLUDES cached (Anthropic). For OpenAI runs input
already includes cached, so the sum double-counts.
"""

import glob
import json
import os
import statistics
import sys


def trial_rows(base):
    for trial in sorted(glob.glob(os.path.join(base, "*"))):
        path = os.path.join(trial, "agent", "agent-trace.jsonl")
        if not os.path.isdir(trial) or not os.path.exists(path):
            continue
        runtime_cost = 0.0
        prompt = None
        formula = None
        model = None
        with open(path, encoding="utf8", errors="replace") as handle:
            for line in handle:
                if '"usage' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("kind") == "usage" and row.get("costUsd") is not None:
                    runtime_cost += float(row["costUsd"])
                elif row.get("kind") == "usage_raw" and row.get("prompt_tokens") is not None:
                    model = row.get("model") or model
                    prompt = row["prompt_tokens"]
                    formula = (
                        int(row.get("input_tokens") or 0)
                        + int(row.get("cached_tokens") or 0)
                        + int(row.get("cache_write_tokens") or 0)
                    )
        yield os.path.basename(trial).split("__")[0], model, runtime_cost, prompt, formula


def main():
    base = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else base
    rows = list(trial_rows(base))
    runtime_total = sum(row[2] for row in rows)
    prompts = [row[3] for row in rows if row[3] is not None]
    formulas = [row[4] for row in rows if row[4] is not None]
    models = {row[1] for row in rows if row[1]}
    print(f"== {label}")
    print(f"trials={len(rows)} models={sorted(models)}")
    print(f"runtime-priced cost total = ${runtime_total:.2f}")
    if prompts:
        print(
            "final context: prompt_tokens median=%d | report-formula median=%d | inflation=%.2fx"
            % (
                statistics.median(prompts),
                statistics.median(formulas),
                statistics.median(formulas) / statistics.median(prompts),
            )
        )


if __name__ == "__main__":
    main()
