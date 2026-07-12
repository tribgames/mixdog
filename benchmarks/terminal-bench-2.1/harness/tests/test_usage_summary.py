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
            # The driver writes its fixed container path; map that path through
            # a tiny source rewrite so this unit test remains host-safe.
            test_driver = data_dir / "lead_driver.mjs"
            test_driver.write_text(
                LEAD_DRIVER.read_text(encoding="utf-8").replace(
                    "const USAGE_LOG = '/logs/agent/usage.json';",
                    f"const USAGE_LOG = {json.dumps(str(data_dir / 'usage.json'))};",
                ).replace(
                    "mkdirSync('/logs/agent', { recursive: true });",
                    f"mkdirSync({json.dumps(str(data_dir))}, {{ recursive: true }});",
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                ["node", str(test_driver)],
                env={
                    **os.environ,
                    "MIXDOG_DATA_DIR": str(data_dir),
                    "MIXDOG_USAGE_SUMMARY_ONLY": "1",
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads((data_dir / "usage.json").read_text(encoding="utf-8"))

        self.assertEqual(
            summary["sessions"],
            [
                {
                    "sessionId": "sess-lead",
                    "agentRole": "lead",
                    "models": ["claude-fable-5"],
                    "inputTokens": 100,
                    "cacheTokens": 40,
                    "outputTokens": 25,
                    "toolCallCountApprox": 2,
                },
                {
                    "sessionId": "sess-review",
                    "agentRole": "reviewer",
                    "models": ["gpt-5.6-sol"],
                    "inputTokens": 0,
                    "cacheTokens": 0,
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
                "outputTokens": 25,
                "toolCallCountApprox": 2,
            },
        )


if __name__ == "__main__":
    unittest.main()
