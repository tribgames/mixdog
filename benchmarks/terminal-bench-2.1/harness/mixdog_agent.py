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

import json
import os
import shlex
import asyncio
import subprocess
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .routing_profiles import (
    format_resolved_routes,
    load_route_profile,
    merge_route_profile,
    refusal_fallback_env,
    reject_profile_conflicts,
)
from .src_overlay import (
    SNAPSHOT_ENV,
    STATIC_SRC_OVERLAY_FILES,
    build_src_snapshot,
    load_src_snapshot,
)

# Version of mixdog to install from npm when a local tarball is not supplied.
DEFAULT_MIXDOG_VERSION = "0.9.40"
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
# Bench workflow pack (repo copy of the CURRENT Default tuned for headless
# autonomy: approval gate removed). Uploaded into the container data dir,
# where user packs override the built-in pack shipped in the npm package —
# so the run always uses the repo's current tuning. Missing file => the
# built-in pack from the installed mixdog version applies.
HOST_BENCH_WORKFLOW = (
    Path(__file__).resolve().parents[3] / "src" / "workflows" / "bench" / "WORKFLOW.md"
)
CONTAINER_BENCH_WORKFLOW = f"{CONTAINER_DATA_DIR}/workflows/bench/WORKFLOW.md"

# Repo-src overlay: the static compatibility manifest is unioned with every
# Git modified/untracked src file, then copied over the npm-installed package.
# Paths are relative to src/ and to <npm root -g>/mixdog/src/.
_REPO_SRC = Path(__file__).resolve().parents[3] / "src"
SRC_OVERLAY_FILES = STATIC_SRC_OVERLAY_FILES
HOST_SRC_OVERLAY_APPLIER = Path(__file__).with_name("src_overlay_apply.mjs")
CONTAINER_SRC_OVERLAY_APPLIER = f"{CONTAINER_DATA_DIR}/src_overlay_apply.mjs"
HOST_ANTHROPIC_PREFLIGHT = Path(__file__).with_name("anthropic_oauth_preflight.mjs")
BENCH_DRIVER_DEADLINE_MS = 180 * 60 * 1000
ANTHROPIC_REFRESH_SKEW_MS = 5 * 60 * 1000
PROCESS_KILL_GRACE_S = 30
LEAD_CLEANUP_GRACE_S = 60
LEASE_STARTUP_CLEANUP_MARGIN_MS = 55 * 60 * 1000
# Preflight precedes uploads/runtime boot. The lease covers the complete 3h
# driver deadline, provider refresh skew, and 55m of startup/cleanup margin.
ANTHROPIC_CREDENTIAL_LEASE_MS = (
    BENCH_DRIVER_DEADLINE_MS
    + ANTHROPIC_REFRESH_SKEW_MS
    + LEASE_STARTUP_CLEANUP_MARGIN_MS
)
PROCESS_RUN_DEADLINE_S = (
    ANTHROPIC_CREDENTIAL_LEASE_MS
    - ANTHROPIC_REFRESH_SKEW_MS
    - LEASE_STARTUP_CLEANUP_MARGIN_MS
    - PROCESS_KILL_GRACE_S * 1000
) // 1000
LEAD_INNER_DEADLINE_MS = (
    PROCESS_RUN_DEADLINE_S - LEAD_CLEANUP_GRACE_S
) * 1000

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


def _run_anthropic_preflight(host_creds: Path, snapshot_path: Path) -> None:
    """Refresh only on the host, under the provider's cross-process lease lock."""
    env = {
        **os.environ,
        "ANTHROPIC_OAUTH_CREDENTIALS_PATH": str(host_creds),
    }
    result = subprocess.run(
        [
            "node",
            str(HOST_ANTHROPIC_PREFLIGHT),
            "--output",
            str(snapshot_path),
            "--minimum-validity-ms",
            str(ANTHROPIC_CREDENTIAL_LEASE_MS),
        ],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or "preflight process exited without diagnostics").strip()
        raise RuntimeError(detail)
    if not snapshot_path.is_file():
        raise RuntimeError(
            "Anthropic OAuth host preflight succeeded without writing a credential snapshot."
        )


def _bounded_process_command(
    payload: str,
    label: str,
    *,
    deadline_s: int = PROCESS_RUN_DEADLINE_S,
    kill_grace_s: int = PROCESS_KILL_GRACE_S,
) -> str:
    """GNU-timeout process-group boundary shared by Lead and direct Worker."""
    safe_label = label.replace("'", "")
    return (
        "set -u; "
        "if ! timeout --version 2>&1 | grep -q 'GNU coreutils'; then "
        f"echo 'mixdog {safe_label}: GNU coreutils timeout is required' >&2; "
        "exit 125; fi; "
        "status=0; "
        f"timeout --signal=TERM --kill-after={kill_grace_s}s {deadline_s}s "
        f"bash -o pipefail -c {shlex.quote(payload)} || status=$?; "
        'if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then '
        f"echo 'mixdog {safe_label}: whole-process deadline exceeded after "
        f"{deadline_s}s; process group terminated before OAuth lease expiry' >&2; "
        "exit 124; "
        'fi; exit "$status"'
    )


class MixdogAgent(BaseInstalledAgent):
    """Installed-agent adapter for the mixdog headless ``worker`` role."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        *args,
        mixdog_version: str | None = None,
        mode: str | None = None,
        workflow: str | None = None,
        provider: str | None = None,
        effort: str | None = None,
        route_profile: str | None = None,
        **kwargs,
    ):
        route_profile = (route_profile or "").strip() or None
        reject_profile_conflicts(
            route_profile, provider=provider, effort=effort
        )
        # Accept mixdog_version via agents[].kwargs; default to the pinned release.
        self._mixdog_version = mixdog_version or DEFAULT_MIXDOG_VERSION
        # mode: "lead" (full session runtime + agent fan-out, default) or
        # "worker" (single headless role). Selectable via --ak mode=worker.
        self._mode = (mode or "lead").strip().lower()
        # Default to the bench workflow (headless-autonomous Default). Pass
        # --ak workflow=default to run the configured gated workflow instead.
        self._workflow = workflow or "bench"
        # None => use the configured route provider; e.g.
        # --ak provider=anthropic-oauth.
        self._provider = provider
        # None => use the configured route effort; e.g. --ak effort=xhigh.
        self._effort = effort
        # A profile is merged into a generated copy of the host config. The host
        # file is never opened for writing.
        self._route_profile_name = route_profile
        self._route_profile = (
            load_route_profile(route_profile) if route_profile else None
        )
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
                "  apt-get update && apt-get install -y curl ca-certificates coreutils && "
                "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && "
                "  apt-get install -y nodejs; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache curl bash coreutils nodejs npm; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && "
                "  yum install -y nodejs coreutils; "
                "else "
                "  echo 'No known package manager (apt/apk/yum)' >&2; exit 1; "
                "fi; "
                "timeout --version | grep -q 'GNU coreutils'; node --version"
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
        host_creds = _host_credentials_path()
        if not host_creds.is_file():
            raise RuntimeError(
                f"mixdog OAuth credentials not found at {host_creds}. "
                "Sign in on the host (mixdog /providers) or set "
                "ANTHROPIC_OAUTH_CREDENTIALS_PATH."
            )
        credential_snapshot_dir = tempfile.TemporaryDirectory(
            prefix="mixdog-tb-anthropic-lease-"
        )
        credential_snapshot = (
            Path(credential_snapshot_dir.name) / "anthropic-oauth-credentials.json"
        )
        try:
            await asyncio.to_thread(
                _run_anthropic_preflight, host_creds, credential_snapshot
            )
        except Exception:
            credential_snapshot_dir.cleanup()
            raise
        boot_files = _collect_boot_files()
        # Never distribute the mutable host file. Every trial receives the
        # exact owner-only snapshot written inside the serialized host lease.
        boot_files["anthropic-oauth-credentials.json"] = credential_snapshot
        if "mixdog-config.json" not in boot_files:
            credential_snapshot_dir.cleanup()
            raise RuntimeError(
                f"mixdog-config.json not found in {_host_data_dir()}; cannot boot "
                "the user's configured setup."
            )
        await self.exec_as_root(environment, command=f"mkdir -p {CONTAINER_DATA_DIR}")
        # Generate a benchmark-only config copy before docker cp. Other boot
        # files still upload directly; no host setup file is ever modified.
        generated_dir = None
        try:
            if self._route_profile is not None:
                host_config_path = boot_files["mixdog-config.json"]
                try:
                    host_config = json.loads(host_config_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    raise RuntimeError(
                        f"cannot read host mixdog config {host_config_path}: {exc}"
                    ) from exc
                merged_config = merge_route_profile(host_config, self._route_profile)
                generated_dir = tempfile.TemporaryDirectory(
                    prefix="mixdog-tb-route-"
                )
                generated_config = Path(generated_dir.name) / "mixdog-config.json"
                generated_config.write_text(
                    json.dumps(merged_config, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
                boot_files = {**boot_files, "mixdog-config.json": generated_config}
                print(
                    format_resolved_routes(
                        self._route_profile_name, self._route_profile
                    ),
                    flush=True,
                )
            # docker cp each file — token bytes never appear in a shell command/log.
            for name, host_path in boot_files.items():
                await environment.upload_file(
                    host_path, f"{CONTAINER_DATA_DIR}/{name}"
                )
        finally:
            if generated_dir is not None:
                generated_dir.cleanup()
            credential_snapshot_dir.cleanup()
        # Bench workflow pack override (see HOST_BENCH_WORKFLOW note above).
        if HOST_BENCH_WORKFLOW.is_file():
            await self.exec_as_root(
                environment,
                command=f"mkdir -p {CONTAINER_DATA_DIR}/workflows/bench",
            )
            await environment.upload_file(HOST_BENCH_WORKFLOW, CONTAINER_BENCH_WORKFLOW)
        await self._inject_src_overlay(environment)
        # Own/secure the copied setup so the user mixdog can read it; OAuth
        # refresh is explicitly forbidden below. default_user None => root.
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

    async def _inject_src_overlay(self, environment: BaseEnvironment) -> None:
        # The launcher supplies a frozen pre-Harbor snapshot. Direct adapter
        # use builds the same snapshot synchronously before the first await.
        owned_snapshot = None
        snapshot_root = os.environ.get(SNAPSHOT_ENV)
        try:
            if snapshot_root:
                snapshot = load_src_snapshot(Path(snapshot_root))
            else:
                owned_snapshot = tempfile.TemporaryDirectory(
                    prefix="mixdog-tb-src-overlay-"
                )
                root = Path(owned_snapshot.name) / "snapshot"
                snapshot = build_src_snapshot(SRC_OVERLAY_FILES, _REPO_SRC, root)
            snapshot_paths = {entry.path for entry in snapshot.entries}
            missing_static = set(SRC_OVERLAY_FILES) - snapshot_paths
            if missing_static:
                raise RuntimeError(
                    "src snapshot omits static compatibility files: "
                    + ", ".join(sorted(missing_static))
                )
            staging = f"{CONTAINER_DATA_DIR}/src-overlay"
            await self.exec_as_root(
                environment,
                command=(
                    f"rm -rf {shlex.quote(staging)} && "
                    f"mkdir -p {shlex.quote(staging + '/files')}"
                ),
            )
            await environment.upload_file(
                snapshot.manifest_path, f"{staging}/manifest.json"
            )
            await environment.upload_file(
                HOST_SRC_OVERLAY_APPLIER, CONTAINER_SRC_OVERLAY_APPLIER
            )
            for entry in snapshot.entries:
                dest = f"{staging}/files/{entry.path}"
                await self.exec_as_root(
                    environment,
                    command=f"mkdir -p {shlex.quote(dest.rsplit('/', 1)[0])}",
                )
                await environment.upload_file(snapshot.file_path(entry), dest)
            await self.exec_as_root(
                environment,
                command=(
                    "set -eu; "
                    'SRC="$(npm root -g)/mixdog/src"; '
                    f"node {shlex.quote(CONTAINER_SRC_OVERLAY_APPLIER)} "
                    f"--staging {shlex.quote(staging)} --src \"$SRC\"; "
                    'echo "src overlay applied"'
                ),
            )
        finally:
            if owned_snapshot is not None:
                owned_snapshot.cleanup()

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Optional Harbor -m override; None => configured route applies.
        model = self.model_name
        reject_profile_conflicts(self._route_profile_name, model=model)
        await self._inject_credentials(environment)

        base_env = {
            "ANTHROPIC_OAUTH_CREDENTIALS_PATH": CONTAINER_CREDS_PATH,
            "MIXDOG_DATA_DIR": CONTAINER_DATA_DIR,
            # Non-interactive: never open a browser / onboarding from the container.
            "CI": "1",
            # The host preflight above is the sole Anthropic refresh owner.
            # Containers receive a bounded-lifetime snapshot and fail clearly
            # instead of consuming its single-use rotating refresh token.
            "MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED": "1",
            "MIXDOG_DRIVER_DEADLINE_MS": str(LEAD_INNER_DEADLINE_MS),
            # Credential-agnostic boot: model catalogs come from uploaded
            # caches and no unrelated provider is touched at startup.
            "MIXDOG_DISABLE_PROVIDER_WARMUP": "1",
            "MIXDOG_DISABLE_MODEL_PREFETCH": "1",
            "MIXDOG_DISABLE_MODEL_CATALOG_WARMUP": "1",
            # Bench-only decision cadence: cap explicit sync shell timeouts at
            # 2 min (blocking window), so promote-on-timeout delivers the
            # partial-output decision point early. Uniform time policy — no
            # task-specific heuristics; product default stays 10 min.
            "BASH_MAX_TIMEOUT_MS": "120000",
            # Network-stall recovery ordering: the runtime must abort+retry a
            # hung provider request BEFORE the lead_driver outer stall guard
            # (360s) fires, so recovery happens inside the session instead of
            # burning driver stall-retries (observed: regex-chess exhausted
            # 2 driver retries at 6min each and died to AgentTimeout).
            # Runtime session stall abort: 600s -> 300s.
            "STALL_TIMEOUT_S": "300",
            # Wedged-socket first byte: abort at 120s (reasoning deltas count
            # as progress, so long XHIGH thinks are not affected).
            "MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS": "120000",
            "MIXDOG_STALL_FIRST_BYTE_ABORT_S": "150",
        }
        if self._mode == "worker":
            await self._run_worker(environment, instruction, model, base_env)
        else:
            await self._run_lead(environment, instruction, model, base_env)

    async def _run_worker(self, environment, instruction, model, base_env):
        # Worker path still needs an explicit route; fall back to a sane model.
        model = model or "claude-sonnet-4-5"
        escaped_instruction = shlex.quote(instruction)
        worker_pipeline = (
            "mkdir -p /logs/agent; "
            f"mixdog --provider anthropic-oauth --model {shlex.quote(model)} "
            f"worker {escaped_instruction} "
            "2>&1 | tee /logs/agent/mixdog.txt"
        )
        await self.exec_as_agent(
            environment,
            command=_bounded_process_command(worker_pipeline, "worker"),
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
            # Raw task instruction, no prepended mandate: the bench workflow
            # pack already grants standing pre-approval / no-questions, and the
            # old EXECUTION_MANDATE ("execute end-to-end ... just do it")
            # suppressed the workflow's delegate-by-default (observed: zero
            # agent-tool delegations across all runs; fix-git smoke confirmed).
            "MIXDOG_PROMPT": instruction,
        }
        # A route profile owns its refusal fallback. Inject it only into the
        # disposable container's Lead-driver process; product/host defaults
        # and the copied host source config remain untouched.
        if self._route_profile is not None:
            run_env.update(refusal_fallback_env(self._route_profile))
        # Only set overrides when explicitly requested; otherwise the driver
        # boots the user's configured route + active workflow.
        if model:
            run_env["MIXDOG_MODEL"] = model
        if self._provider:
            run_env["MIXDOG_PROVIDER"] = self._provider
        if self._effort:
            run_env["MIXDOG_EFFORT"] = self._effort
        if self._workflow:
            run_env["MIXDOG_WORKFLOW"] = self._workflow
        lead_pipeline = (
            "mkdir -p /logs/agent; "
            'export MIXDOG_SRC="$(npm root -g)/mixdog/src"; '
            f"node {CONTAINER_LEAD_DRIVER} "
            "2>&1 | tee /logs/agent/mixdog.txt"
        )
        await self.exec_as_agent(
            environment,
            command=_bounded_process_command(lead_pipeline, "lead"),
            env=run_env,
        )
