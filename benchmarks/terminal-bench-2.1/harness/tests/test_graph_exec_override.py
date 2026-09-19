"""Both native tool routes use the bundled executable without changing the task."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from harness.mixdog_agent import _mixdog_exec_command
from harness.src_overlay import GRAPH_BINARY_ENV, GRAPH_MEMBER


class GraphExecOverrideTest(unittest.TestCase):
    def test_bundled_graph_preserves_input_and_never_falls_back(self):
        instruction = "Keep this exact input: 'quotes', `code`, and\nanother line."
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "cli").write_text(
                '#!/bin/sh\nprintf "%s\\n" "${MIXDOG_SEARCH_SERVER_BIN-unset}" '
                '"${MIXDOG_GRAPH_BIN-unset}" "$@"\n',
                encoding="utf-8",
                newline="\n",
            )
            for selected, present in [
                (False, True),
                (True, True),
                (False, False),
                (True, False),
            ]:
                with self.subTest(selected=selected, present=present):
                    with patch.dict(
                        os.environ, {GRAPH_BINARY_ENV: "selected" if selected else ""}
                    ):
                        command = _mixdog_exec_command(
                            instruction, "openai-oauth", "example", label="test"
                        )
                    setup = (
                        "set -eu; mkdir -p /package/bin /package/src; "
                        "cp /fixture/cli /package/bin/cli; chmod 755 /package/bin/cli; "
                        "ln -s /package/bin/cli /usr/local/bin/mixdog; "
                    )
                    if present:
                        setup += f"cp /package/bin/cli /package/{GRAPH_MEMBER}; "
                    result = subprocess.run(
                        [
                            "docker",
                            "run",
                            "--rm",
                            "--platform",
                            "linux/amd64",
                            "-v",
                            f"{root}:/fixture:ro",
                            "debian:bookworm-slim",
                            "bash",
                            "-c",
                            setup + command,
                        ],
                        capture_output=True,
                        text=True,
                    )
                    if not present:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertNotIn(instruction, result.stdout)
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        expected = f"/package/{GRAPH_MEMBER}"
                        self.assertEqual(result.stdout.splitlines()[0], expected)
                        self.assertEqual(result.stdout.splitlines()[1], expected)
                        self.assertTrue(
                            result.stdout.endswith(instruction + "\n"), result.stdout
                        )


if __name__ == "__main__":
    unittest.main()
