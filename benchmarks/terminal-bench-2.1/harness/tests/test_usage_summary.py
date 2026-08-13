from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


HARNESS_ROOT = Path(__file__).resolve().parents[1]
LEAD_DRIVER = HARNESS_ROOT / "lead_driver.mjs"
COST_REPORT = HARNESS_ROOT / "cost-exact.mjs"


class UsageSummaryTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_two_session_summary_includes_roles_models_usage_and_tools(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-usage-summary-") as temp:
            data_dir = Path(temp)
            sessions_dir = data_dir / "sessions"
            sessions_dir.mkdir()
            (sessions_dir / "sess-lead.json").write_text(
                json.dumps(
                    {
                        "id": "sess-lead",
                        "agent": "lead",
                        "model": "claude-fable-5",
                        "totalInputTokens": 100,
                        "totalCachedReadTokens": 40,
                        "totalOutputTokens": 25,
                        "lastContextTokens": 12345,
                        "lastIterationIndex": 7,
                        "messages": [
                            {"role": "tool", "toolCallId": "one"},
                            {"role": "tool", "toolCallId": "two"},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            (sessions_dir / "sess-review.json").write_text(
                json.dumps(
                    {
                        "id": "sess-review",
                        "agent": "reviewer",
                        "model": "gpt-5.6-sol",
                        "messages": [{"role": "assistant", "content": "done"}],
                    }
                ),
                encoding="utf-8",
            )
            # The driver's container log paths are env-overridable, so this
            # unit test stays host-safe without rewriting the source.
            transcript_path = data_dir / "session-transcript.json"
            result = subprocess.run(
                ["node", str(LEAD_DRIVER)],
                env={
                    **os.environ,
                    "MIXDOG_DATA_DIR": str(data_dir),
                    "MIXDOG_USAGE_SUMMARY_ONLY": "1",
                    "MIXDOG_LEAD_SESSION_ID": "sess-lead",
                    "MIXDOG_USAGE_LOG": str(data_dir / "usage.json"),
                    "MIXDOG_SESSION_TRANSCRIPT_LOG": str(transcript_path),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads((data_dir / "usage.json").read_text(encoding="utf-8"))
            transcript = json.loads(transcript_path.read_text(encoding="utf-8"))

        self.assertEqual(
            summary["sessions"],
            [
                {
                    "sessionId": "sess-lead",
                    "agentRole": "lead",
                    "models": ["claude-fable-5"],
                    "inputTokens": 100,
                    "cacheTokens": 40,
                    "cacheWriteTokens": 0,
                    "outputTokens": 25,
                    "toolCallCountApprox": 2,
                },
                {
                    "sessionId": "sess-review",
                    "agentRole": "reviewer",
                    "models": ["gpt-5.6-sol"],
                    "inputTokens": 0,
                    "cacheTokens": 0,
                    "cacheWriteTokens": 0,
                    "outputTokens": 0,
                    "toolCallCountApprox": 0,
                },
            ],
        )
        self.assertEqual(
            summary["totals"],
            {
                "inputTokens": 100,
                "cacheTokens": 40,
                "cacheWriteTokens": 0,
                "outputTokens": 25,
                "toolCallCountApprox": 2,
            },
        )
        self.assertEqual(transcript["lastContextTokens"], 12345)
        self.assertEqual(transcript["lastIterationIndex"], 7)

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


if __name__ == "__main__":
    unittest.main()
