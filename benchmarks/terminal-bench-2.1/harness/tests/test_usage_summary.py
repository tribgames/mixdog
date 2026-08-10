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


if __name__ == "__main__":
    unittest.main()
