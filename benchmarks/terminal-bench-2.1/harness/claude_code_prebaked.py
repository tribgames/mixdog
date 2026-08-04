"""Claude Code agent variant: prebaked binary upload instead of per-container
download.

The stock Harbor claude-code agent downloads a ~275MB native binary from
downloads.claude.ai inside EVERY trial container (then runs its installer).
At n=8 that saturates the uplink, trips AgentSetupTimeoutError, and burns
~6-8 minutes of fixed cost per trial. This subclass uploads a host-cached
linux-x64 binary via docker cp (seconds, no network) and skips the installer:
the standalone binary is the complete CLI.

Host cache: ``cc-bin/claude-linux-x64`` under the bench root, overridable via
``CC_PREBAKED_BINARY``. The launcher script downloads it once when missing.

Alpine (musl) images cannot run the glibc binary; those fall back to the
parent npm install path, same as stock.
"""

import os
from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment

HOST_BINARY_ENV = "CC_PREBAKED_BINARY"
DEFAULT_HOST_BINARY = (
    Path(__file__).resolve().parents[1] / "cc-bin" / "claude-linux-x64"
)
CONTAINER_BINARY = "/usr/local/bin/claude"


class ClaudeCodePrebaked(ClaudeCode):
    @staticmethod
    def name() -> str:
        return "claude-code-prebaked"

    async def install(self, environment: BaseEnvironment) -> None:
        host_binary = Path(os.environ.get(HOST_BINARY_ENV, "") or DEFAULT_HOST_BINARY)
        if not host_binary.is_file():
            raise FileNotFoundError(
                f"prebaked claude binary missing: {host_binary} — download it "
                "once on the host (see full-run-cc-n8.ps1) or set "
                f"{HOST_BINARY_ENV}"
            )
        # Alpine/musl cannot run the glibc binary — use the stock npm path.
        probe = await self.exec_as_root(environment, command="command -v apk || true")
        if "apk" in (getattr(probe, "stdout", "") or ""):
            await super().install(environment)
            return
        # System deps (parent parity): procps for node-tree-kill, curl/bash for
        # task tooling. No claude download happens here.
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get &> /dev/null; then"
                "  apt-get update && apt-get install -y curl procps;"
                " elif command -v yum &> /dev/null; then"
                "  yum install -y curl procps-ng;"
                " else"
                '  echo "Warning: no known package manager; assuming deps present" >&2;'
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await environment.upload_file(host_binary, CONTAINER_BINARY)
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 755 {CONTAINER_BINARY} && "
                # Parent's run/version commands prepend ~/.local/bin to PATH;
                # keep a symlink there so both resolution orders agree.
                "mkdir -p ~/.local/bin && "
                f"ln -sf {CONTAINER_BINARY} ~/.local/bin/claude && "
                "claude --version"
            ),
        )
