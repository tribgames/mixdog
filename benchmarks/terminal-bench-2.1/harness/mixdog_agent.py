"""Harbor installed-agent adapter that runs mixdog headless inside the task container.

Run with (from ``benchmarks/terminal-bench-2.1``, so this module is importable):

    PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2-1 \\
        --agent-import-path harness.mixdog_agent:MixdogAgent \\
        --model claude-sonnet-4-5 -t <task-id>

install():
  - installs Node.js >= 22 + mixdog (npm) into the container
  - copies the host's Anthropic OAuth credentials file into the container via
    ``environment.upload_file`` (docker cp) so the token never appears in a
    shell command or Harbor's debug logs.

run():
  - invokes ``mixdog --provider anthropic-oauth --model <model> worker <instruction>``
    with ANTHROPIC_OAUTH_CREDENTIALS_PATH / MIXDOG_DATA_DIR pointed at the
    injected credentials, teeing output to /logs/agent/mixdog.txt.
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Version of mixdog to install from npm when a local tarball is not supplied.
DEFAULT_MIXDOG_VERSION = "0.9.18"
# No hard-coded model/workflow defaults: with neither a Harbor -m override nor
# an explicit kwarg, the runtime boots the user's configured route + active
# workflow from the copied mixdog-config.json.

# Prepended to the instruction on the Lead path. Default-workflow Lead pauses
# for user plan-approval; a headless bench has no user, so Lead would propose a
# plan / ask a question and end the turn (observed: fix-git ended with "Shall I
# merge...?" after 22s, no work). This grants standing pre-approval so Lead
# executes end-to-end instead of halting for confirmation.
EXECUTION_MANDATE = (
    "Benchmark context: this is an automated evaluation trial from the "
    "public terminal-bench 2.1 suite, executed by the Harbor runner inside "
    "an isolated, disposable Docker container. Every file, dataset, and "
    "service involved is a local synthetic fixture created for this task; "
    "nothing touches real users, networks of record, or production systems. "
    "An automated verifier scores the container afterward.\n\n"
    "Headless benchmark run: no user is available to answer questions or "
    "approve plans. You have full pre-approval to act. Execute the task "
    "end-to-end without asking, verify your work, and finish. Never end the "
    "turn with a question, a plan awaiting approval, or a proposed next step "
    "\u2014 just do it.\n\n"
)

# Where the OAuth credentials file lands inside the container. Also used as
# MIXDOG_DATA_DIR so mixdog's default credential path resolves to the same file
# and any config writes stay in a writable, self-contained directory.
CONTAINER_DATA_DIR = "/opt/mixdog"
CONTAINER_CREDS_PATH = f"{CONTAINER_DATA_DIR}/anthropic-oauth-credentials.json"
# Full-Lead-session driver, uploaded next to the creds and run with node.
CONTAINER_LEAD_DRIVER = f"{CONTAINER_DATA_DIR}/lead_driver.mjs"
HOST_LEAD_DRIVER = Path(__file__).with_name("lead_driver.mjs")

# Boot files copied from the host data dir into the container so the in-container
# runtime uses the user's REAL daily setup. mixdog-config.json defines the route
# + active workflow + sub-agent routing; the glob'd files carry the provider
# credentials (anthropic/openai/grok oauth) and model catalogs those routes need.
# All are transferred via docker cp (upload_file) — never through shell args/logs.
BOOT_FILE_NAMES = ["mixdog-config.json"]
BOOT_FILE_GLOBS = [
    "*-credentials.json",   # anthropic-oauth-credentials.json, ...
    "*-oauth.json",         # openai-oauth.json, grok-oauth.json
    "*-models.json",        # per-provider model caches (incl. *-oauth-models.json)
    "litellm-catalog.json",
    "modelsdev-catalog.json",
]


def _host_data_dir() -> Path:
    """Resolve the host mixdog data dir (mirrors src/lib/plugin-paths.cjs):
      MIXDOG_DATA_DIR | (MIXDOG_HOME | ~/.mixdog)/data
    """
    data_dir = os.environ.get("MIXDOG_DATA_DIR")
    if not data_dir:
        home = os.environ.get("MIXDOG_HOME") or str(Path.home() / ".mixdog")
        data_dir = str(Path(home) / "data")
    return Path(data_dir)


def _host_credentials_path() -> Path:
    """Resolve the host Anthropic OAuth credentials file (override or default)."""
    override = os.environ.get("ANTHROPIC_OAUTH_CREDENTIALS_PATH")
    if override:
        return Path(override)
    return _host_data_dir() / "anthropic-oauth-credentials.json"


def _collect_boot_files() -> dict[str, Path]:
    """{container_filename: host_path} for config + provider creds + model caches."""
    data_dir = _host_data_dir()
    files: dict[str, Path] = {}
    for name in BOOT_FILE_NAMES:
        p = data_dir / name
        if p.is_file():
            files[name] = p
    for pattern in BOOT_FILE_GLOBS:
        for p in sorted(data_dir.glob(pattern)):
            if p.is_file():
                files[p.name] = p
    # Honor an explicit creds-path override even if it lives outside data_dir.
    override = os.environ.get("ANTHROPIC_OAUTH_CREDENTIALS_PATH")
    if override and Path(override).is_file():
        files["anthropic-oauth-credentials.json"] = Path(override)
    return files


class MixdogAgent(BaseInstalledAgent):
    """Installed-agent adapter for the mixdog headless ``worker`` role."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        *args,
        mixdog_version: str | None = None,
        mode: str | None = None,
        workflow: str | None = None,
        effort: str | None = None,
        **kwargs,
    ):
        # Accept mixdog_version via agents[].kwargs; default to the pinned release.
        self._mixdog_version = mixdog_version or DEFAULT_MIXDOG_VERSION
        # mode: "lead" (full session runtime + agent fan-out, default) or
        # "worker" (single headless role). Selectable via --ak mode=worker.
        self._mode = (mode or "lead").strip().lower()
        # None => use the configured active workflow from mixdog-config.json.
        self._workflow = workflow
        # None => use the configured route effort; e.g. --ak effort=xhigh.
        self._effort = effort
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "mixdog"

    def get_version_command(self) -> str | None:
        return "mixdog --help >/dev/null 2>&1 && echo mixdog-" + self._mixdog_version

    async def install(self, environment: BaseEnvironment) -> None:
        # System deps + Node.js >= 22 (root). NodeSource for apt; distro pkg for apk/yum.
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y curl ca-certificates && "
                "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && "
                "  apt-get install -y nodejs; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache curl bash nodejs npm; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && "
                "  yum install -y nodejs; "
                "else "
                "  echo 'No known package manager (apt/apk/yum)' >&2; exit 1; "
                "fi; "
                "node --version"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # Install mixdog globally (root). --ignore-scripts avoids the package's
        # prepack/TUI build; the headless worker path does not need the TUI bundle.
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"npm install -g --ignore-scripts mixdog@{self._mixdog_version}; "
                "mixdog --help >/dev/null 2>&1 && echo 'mixdog installed'"
            ),
        )

    async def _inject_credentials(self, environment: BaseEnvironment) -> None:
        boot_files = _collect_boot_files()
        host_creds = _host_credentials_path()
        if not host_creds.is_file():
            raise RuntimeError(
                f"mixdog OAuth credentials not found at {host_creds}. "
                "Sign in on the host (mixdog /providers) or set "
                "ANTHROPIC_OAUTH_CREDENTIALS_PATH."
            )
        if "mixdog-config.json" not in boot_files:
            raise RuntimeError(
                f"mixdog-config.json not found in {_host_data_dir()}; cannot boot "
                "the user's configured setup."
            )
        await self.exec_as_root(environment, command=f"mkdir -p {CONTAINER_DATA_DIR}")
        # docker cp each file — token bytes never appear in a shell command/log.
        for name, host_path in boot_files.items():
            await environment.upload_file(host_path, f"{CONTAINER_DATA_DIR}/{name}")
        # Own/secure the copied setup so the user mixdog runs as can read + write
        # it (token refresh); default_user is None => container root.
        user = getattr(environment, "default_user", None)
        if user is not None:
            await self.exec_as_root(
                environment,
                command=f"chown -R {shlex.quote(str(user))} {CONTAINER_DATA_DIR}",
            )
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 700 {CONTAINER_DATA_DIR} && "
                f"chmod 600 {CONTAINER_DATA_DIR}/*-credentials.json "
                f"{CONTAINER_DATA_DIR}/*-oauth.json 2>/dev/null || true"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._inject_credentials(environment)

        # Optional Harbor -m override; None => configured route applies.
        model = self.model_name
        base_env = {
            "ANTHROPIC_OAUTH_CREDENTIALS_PATH": CONTAINER_CREDS_PATH,
            "MIXDOG_DATA_DIR": CONTAINER_DATA_DIR,
            # Non-interactive: never open a browser / onboarding from the container.
            "CI": "1",
        }
        if self._mode == "worker":
            await self._run_worker(environment, instruction, model, base_env)
        else:
            await self._run_lead(environment, instruction, model, base_env)

    async def _run_worker(self, environment, instruction, model, base_env):
        # Worker path still needs an explicit route; fall back to a sane model.
        model = model or "claude-sonnet-4-5"
        escaped_instruction = shlex.quote(instruction)
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p /logs/agent; "
                f"mixdog --provider anthropic-oauth --model {shlex.quote(model)} "
                f"worker {escaped_instruction} "
                "2>&1 | tee /logs/agent/mixdog.txt"
            ),
            env=base_env,
        )

    async def _run_lead(self, environment, instruction, model, base_env):
        # Upload the Lead-session driver, then run it against the globally
        # installed package (src under `npm root -g`/mixdog). Prompt/provider/
        # model/workflow travel via env so the instruction needs no quoting.
        await self.exec_as_root(
            environment, command=f"mkdir -p {CONTAINER_DATA_DIR}"
        )
        await environment.upload_file(HOST_LEAD_DRIVER, CONTAINER_LEAD_DRIVER)
        user = getattr(environment, "default_user", None)
        if user is not None:
            await self.exec_as_root(
                environment,
                command=f"chown {shlex.quote(str(user))} {CONTAINER_LEAD_DRIVER}",
            )
        run_env = {
            **base_env,
            # Grant standing execution pre-approval so headless Lead does not
            # halt for plan-approval (no user exists to approve).
            "MIXDOG_PROMPT": EXECUTION_MANDATE + instruction,
        }
        # Only set overrides when explicitly requested; otherwise the driver
        # boots the user's configured route + active workflow.
        if model:
            run_env["MIXDOG_MODEL"] = model
        if self._effort:
            run_env["MIXDOG_EFFORT"] = self._effort
        if self._workflow:
            run_env["MIXDOG_WORKFLOW"] = self._workflow
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p /logs/agent; "
                'export MIXDOG_SRC="$(npm root -g)/mixdog/src"; '
                f"node {CONTAINER_LEAD_DRIVER} "
                "2>&1 | tee /logs/agent/mixdog.txt"
            ),
            env=run_env,
        )
