"""Reference-client baseline: xAI's ``grok`` CLI as a Harbor installed agent.

Purpose: put the reference client and our agent on the SAME task set so cache,
timing and outcome numbers compare directly instead of across harnesses.

Fairness matches the mixdog bench surface: web search off, cross-session memory
off, no host config read, and the container receives only the credentials file.

install():
  - installs curl/ripgrep/git, then the CLI via the vendor install script
  - uploads the host ``~/.grok/auth.json`` through ``upload_file`` (docker cp)
    so the token never appears in a shell command or Harbor's debug log

run():
  - ``grok -p <instruction>`` in headless mode with permissions bypassed,
    teeing stdout to /logs/agent/grok.txt and diagnostics to grok.stderr
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Staging path for the uploaded credentials. install() moves it into the agent
# user's ~/.grok, whose absolute path is only known inside the container.
CONTAINER_AUTH_STAGE = "/tmp/grok-auth.json"
DEFAULT_MODEL = "grok-4.6"


def _host_auth_path() -> Path:
    explicit = os.environ.get("GROK_AUTH_PATH", "").strip()
    return Path(explicit) if explicit else Path.home() / ".grok" / "auth.json"


class GrokCli(BaseInstalledAgent):
    """Installed-agent adapter for xAI's ``grok`` CLI."""

    SUPPORTS_ATIF = False

    def __init__(self, *args, effort: str | None = None, **kwargs) -> None:
        self._effort = (effort or "").strip() or None
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "grok-cli"

    def get_version_command(self) -> str | None:
        return 'PATH="$HOME/.grok/bin:$PATH"; grok --version'

    def parse_version(self, stdout: str) -> str:
        for line in stdout.strip().splitlines():
            if line.strip():
                return line.strip()
        return "unknown"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get >/dev/null 2>&1; then"
                "  apt-get update && apt-get install -y curl ca-certificates ripgrep git;"
                " elif command -v apk >/dev/null 2>&1; then"
                "  apk add --no-cache curl ca-certificates ripgrep git bash;"
                " else"
                '  echo "warning: no known package manager; assuming curl exists" >&2;'
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -eu; curl -fsSL https://x.ai/cli/install.sh | bash; "
                'PATH="$HOME/.grok/bin:$PATH"; grok --version'
            ),
        )
        auth = _host_auth_path()
        if not auth.is_file():
            raise RuntimeError(
                f"grok credentials not found at {auth}; run `grok login` on the "
                "host first or point GROK_AUTH_PATH at the file"
            )
        await environment.upload_file(auth, CONTAINER_AUTH_STAGE)
        await self.exec_as_agent(
            environment,
            command=(
                "set -eu; mkdir -p \"$HOME/.grok\"; "
                f"cp {CONTAINER_AUTH_STAGE} \"$HOME/.grok/auth.json\"; "
                f"chmod 600 \"$HOME/.grok/auth.json\"; rm -f {CONTAINER_AUTH_STAGE}"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        argv = [
            "grok",
            "-p",
            instruction,
            # Send the prompt as given; the task text is already the contract.
            "--verbatim",
            "--output-format",
            "json",
            "--permission-mode",
            "bypassPermissions",
            # Fairness with the mixdog bench surface, which runs with search
            # and cross-session memory disabled.
            "--disable-web-search",
            "--no-memory",
            "-m",
            self.model_name or DEFAULT_MODEL,
        ]
        if self._effort:
            argv += ["--reasoning-effort", self._effort]
        rendered = " ".join(shlex.quote(arg) for arg in argv)
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p /logs/agent; "
                'PATH="$HOME/.grok/bin:$PATH"; '
                f"{rendered} "
                "2> >(tee /logs/agent/grok.stderr >&2) | tee /logs/agent/grok.txt"
            ),
        )
