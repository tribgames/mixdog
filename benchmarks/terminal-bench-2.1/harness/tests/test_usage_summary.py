from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


HARNESS_ROOT = Path(__file__).resolve().parents[1]
COST_REPORT = HARNESS_ROOT / "cost-exact.mjs"


class UsageSummaryTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_cost_report_separates_openai_cache_writes_and_uses_iteration_count(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-cost-report-") as temp:
            run_dir = Path(temp)
            trial_dir = run_dir / "fixture__trial"
            agent_dir = trial_dir / "agent"
            agent_dir.mkdir(parents=True)
            (trial_dir / "result.json").write_text(
                json.dumps(
                    {
                        "verifier_result": {"rewards": {"reward": 1}},
                        "agent_execution": {
                            "started_at": "2026-01-01T00:00:00Z",
                            "finished_at": "2026-01-01T00:00:10Z",
                        },
                    }
                ),
                encoding="utf-8",
            )
            (agent_dir / "session-transcript.json").write_text(
                json.dumps(
                    {
                        "model": "gpt-5.6-sol",
                        "totalCachedReadTokens": 400_000,
                        "totalCacheWriteTokens": 200_000,
                        "totalOutputTokens": 0,
                        "lastContextTokens": 1_000_000,
                        "lastIterationIndex": 7,
                    }
                ),
                encoding="utf-8",
            )
            (agent_dir / "usage.json").write_text(
                json.dumps(
                    {
                        "sessions": [
                            {
                                "models": ["gpt-5.6-sol"],
                                "inputTokens": 1_000_000,
                                "cacheTokens": 400_000,
                                "cacheWriteTokens": 200_000,
                                "outputTokens": 0,
                            }
                        ],
                        "totals": {
                            "inputTokens": 1_000_000,
                            "cacheTokens": 400_000,
                            "cacheWriteTokens": 200_000,
                            "outputTokens": 0,
                        },
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                ["node", str(COST_REPORT), str(run_dir)],
                capture_output=True,
                text=True,
                timeout=10,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("turns= 7", result.stdout)
        self.assertIn("in=400000", result.stdout)
        self.assertIn("$3.45", result.stdout)
        self.assertIn("avg turns=7.0", result.stdout)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_cost_report_does_not_invent_prices_for_unknown_models(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-cost-unknown-") as temp:
            run_dir = Path(temp)
            trial_dir = run_dir / "fixture__trial"
            agent_dir = trial_dir / "agent"
            agent_dir.mkdir(parents=True)
            (trial_dir / "result.json").write_text(
                json.dumps(
                    {
                        "verifier_result": {"rewards": {"reward": 1}},
                        "agent_execution": {
                            "started_at": "2026-01-01T00:00:00Z",
                            "finished_at": "2026-01-01T00:00:10Z",
                        },
                    }
                ),
                encoding="utf-8",
            )
            (agent_dir / "session-transcript.json").write_text(
                json.dumps(
                    {
                        "model": "unknown-model-xyz",
                        "totalCachedReadTokens": 0,
                        "totalCacheWriteTokens": 0,
                        "totalOutputTokens": 1000,
                        "lastContextTokens": 1000,
                        "lastIterationIndex": 1,
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                ["node", str(COST_REPORT), str(run_dir)],
                capture_output=True,
                text=True,
                timeout=10,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("unsupported", result.stdout)
        self.assertNotIn("$", result.stdout)


if __name__ == "__main__":
    unittest.main()
