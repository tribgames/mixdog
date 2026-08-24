"""Final-context medians read from the unambiguous field on each side.

`model.request.completed.usage.input_tokens` does NOT mean the same thing across
providers in our own logs: OpenAI reports the FULL prompt there (cached
included), Anthropic reports only the uncached remainder. Summing input+cached
is therefore correct for one and double-counts the other. agent-trace's
`usage_raw.prompt_tokens` is the normalized total and settles it.

Codex publishes the same quantity as final_metrics.extra.last_token_usage
.input_tokens (its cached_input_tokens is a subset of that number).
"""

import glob
import json
import os
import statistics
import sys


def ours(base):
    values = []
    for trial in sorted(glob.glob(os.path.join(base, "*"))):
        path = os.path.join(trial, "agent", "agent-trace.jsonl")
        if not os.path.isdir(trial) or not os.path.exists(path):
            continue
        prompt = inclusive = None
        with open(path, encoding="utf8", errors="replace") as handle:
            for line in handle:
                if '"usage_raw"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("prompt_tokens") is not None:
                    prompt = row["prompt_tokens"]
                    inclusive = (
                        int(row.get("input_tokens") or 0)
                        + int(row.get("cached_tokens") or 0)
                        + int(row.get("cache_write_tokens") or 0)
                    )
        if prompt is not None:
            values.append((os.path.basename(trial).split("__")[0], prompt, inclusive))
    return values


def codex(base):
    values = []
    for trial in sorted(glob.glob(os.path.join(base, "*"))):
        path = os.path.join(trial, "agent", "trajectory.json")
        if not os.path.isdir(trial) or not os.path.exists(path):
            continue
        with open(path, encoding="utf8") as handle:
            metrics = (json.load(handle) or {}).get("final_metrics") or {}
        last = (metrics.get("extra") or {}).get("last_token_usage") or {}
        if last.get("input_tokens") is not None:
            values.append((os.path.basename(trial).split("__")[0], last["input_tokens"]))
    return values


def main():
    our_dir = sys.argv[1] if len(sys.argv) > 1 else glob.glob(
        "benchmarks/terminal-bench-2.1/jobs-full-sol-xhigh-20260823-182305/2026-*"
    )[0]
    base_dir = sys.argv[2] if len(sys.argv) > 2 else (
        "benchmarks/terminal-bench-2.1/jobs-full-codex/2026-08-02__12-19-11"
    )
    mine = ours(our_dir)
    theirs = codex(base_dir)
    prompts = [row[1] for row in mine]
    inflated = [row[2] for row in mine if row[2] is not None]
    base = [row[1] for row in theirs]
    print(f"ours trials={len(prompts)} median={statistics.median(prompts):.0f} "
          f"mean={sum(prompts)/len(prompts):.0f}")
    print(f"ours as-reported (input+cached+write) median={statistics.median(inflated):.0f}")
    print(f"codex trials={len(base)} median={statistics.median(base):.0f} "
          f"mean={sum(base)/len(base):.0f}")
    ratio = 1 - (statistics.median(prompts) / statistics.median(base))
    print(f"corrected reduction vs codex = {ratio * 100:.1f}%")


if __name__ == "__main__":
    main()
