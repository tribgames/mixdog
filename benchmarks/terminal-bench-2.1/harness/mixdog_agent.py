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
import hashlib
import subprocess
import tempfile
import time
from pathlib import Path

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from .routing_profiles import (
    build_benchmark_config,
    format_resolved_routes,
    load_route_profile,
    reject_profile_conflicts,
)
from .src_overlay import (
    SNAPSHOT_ENV,
    load_src_snapshot,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
# The npm install is only a dependency shell — the src overlay replaces the
# whole source tree — so always install the latest published package instead
# of the local (possibly unpublished) package.json version.
DEFAULT_MIXDOG_VERSION = "latest"
# Terminal-Bench always boots a benchmark-owned route profile and the stock
# default workflow unless an explicit workflow is selected.

# Where the OAuth credentials file lands inside the container. Also used as
# MIXDOG_DATA_DIR so mixdog's default credential path resolves to the same file
# and any config writes stay in a writable, self-contained directory.
CONTAINER_DATA_DIR = "/opt/mixdog"
CONTAINER_CREDS_PATH = f"{CONTAINER_DATA_DIR}/anthropic-oauth-credentials.json"
# Full-Lead-session driver, uploaded next to the creds and run with node.
CONTAINER_LEAD_DRIVER = f"{CONTAINER_DATA_DIR}/lead_driver.mjs"
HOST_LEAD_DRIVER = Path(__file__).with_name("lead_driver.mjs")
FALLBACK_RETRY_EXIT_CODE = 86
FALLBACK_STATE_ENV = "MIXDOG_TB_FALLBACK_STATE_DIR"
# Every trial receives the same full local src archive captured before Harbor.
_REPO_SRC = _REPO_ROOT / "src"
PRISTINE_CONTRACT = json.loads(
    (_REPO_SRC / "runtime/shared/pristine-execution-contract.json").read_text(
        encoding="utf-8"
    )
)
PRISTINE_GUARD_ENV = PRISTINE_CONTRACT["guardEnv"]
CONTAINER_SRC_SNAPSHOT = f"{CONTAINER_DATA_DIR}/src-snapshot.tar"
# CC-prebaked parity for our own dependency shell: harness/prebake.ps1 bakes
# node + the global mixdog install tree (bin links + /usr/lib/node_modules)
# into this host tar ONCE; install() then uploads and extracts it in seconds
# instead of re-running NodeSource + `npm install -g` in every container.
# Missing cache or non-glibc (apk) images fall back to the stock path — task
# environments are never modified either way (agent deps only).
PREBAKE_TAR_ENV = "MIXDOG_TB_PREBAKE_TAR"
DEFAULT_PREBAKE_TAR = (
    Path(__file__).resolve().parents[1] / "mixdog-prebake" / "mixdog-node-prebake.tar.gz"
)
CONTAINER_PREBAKE_TAR = "/opt/mixdog-node-prebake.tar.gz"
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

# Exact allow-list for provider material. Host config and behavioral state are
# never read, globbed, merged, or copied.
PROVIDER_CREDENTIAL_FILES = {
    provider: entry["credentialFile"]
    for provider, entry in PRISTINE_CONTRACT["oauthProviders"].items()
}
PROVIDER_MODEL_CATALOG_FILES = {
    provider: entry["modelCatalogFile"]
    for provider, entry in PRISTINE_CONTRACT["oauthProviders"].items()
}
PERSONAL_STATE_AUDIT_NAME = "personal-state-audit.json"
CONTAINER_PERSONAL_STATE_AUDIT = f"/logs/agent/{PERSONAL_STATE_AUDIT_NAME}"
UV_BOOTSTRAP_ATTEMPTS = 3


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


def _collect_provider_files(providers: set[str]) -> dict[str, Path]:
    """Collect exact credential/catalog files for selected route providers."""
    data_dir = _host_data_dir()
    files: dict[str, Path] = {}
    unsupported = sorted(set(providers) - set(PROVIDER_CREDENTIAL_FILES))
    if unsupported:
        raise RuntimeError(
            "pristine benchmark credential injection does not support provider(s): "
            + ", ".join(unsupported)
        )
    for provider in sorted(providers):
        credential_name = PROVIDER_CREDENTIAL_FILES[provider]
        credential_path = (
            _host_credentials_path()
            if provider == "anthropic-oauth"
            else data_dir / credential_name
        )
        if not credential_path.is_file():
            raise RuntimeError(
                f"required {provider} credentials are unavailable; sign in on the host"
            )
        files[credential_name] = credential_path
        catalog_name = PROVIDER_MODEL_CATALOG_FILES[provider]
        catalog_path = data_dir / catalog_name
        if catalog_path.is_file():
            files[catalog_name] = catalog_path
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
        for private_path in (host_creds, snapshot_path):
            detail = detail.replace(str(private_path), "<credential-file>")
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


def _uv_provision_command(
    home: str = "/root", curl_command: str = "curl"
) -> str:
    """Best-effort pinned uv bootstrap plus portable, bounded curl policy."""
    uv_bin = f"{home}/.local/bin"
    curlrc = f"{home}/.curlrc"
    env_file = f"{uv_bin}/env"
    quoted_bin = shlex.quote(uv_bin)
    quoted_curlrc = shlex.quote(curlrc)
    quoted_env = shlex.quote(env_file)
    quoted_curl = shlex.quote(curl_command)
    return (
        "set -u; "
        f"mkdir -p {quoted_bin}; "
        f"printf '%s\n' 'retry = 5' 'retry-delay = 2' "
        f"'retry-max-time = 120' 'connect-timeout = 20' > {quoted_curlrc}; "
        f"if {quoted_curl} --retry-all-errors --version >/dev/null 2>&1; then "
        f"printf '%s\n' 'retry-all-errors' >> {quoted_curlrc}; "
        "fi; "
        f"printf '%s\n' 'export PATH=\"{uv_bin}:$PATH\"' > {quoted_env}; "
        f"chmod 0644 {quoted_curlrc} {quoted_env} 2>/dev/null || true; "
        f"if [ \"$({quoted_bin}/uv --version 2>/dev/null || true)\" = 'uv 0.9.5' ] "
        f"&& [ \"$({quoted_bin}/uvx --version 2>/dev/null || true)\" = 'uvx 0.9.5' ]; then "
        "echo 'uv 0.9.5 already available'; "
        "else "
        "provisioned=0; attempt=1; "
        f"while [ \"$attempt\" -le {UV_BOOTSTRAP_ATTEMPTS} ]; do "
        "installer=$(mktemp 2>/dev/null || true); "
        "if [ -n \"$installer\" ] && "
        f"{quoted_curl} -fsSL --retry 0 --connect-timeout 20 "
        "https://astral.sh/uv/0.9.5/install.sh -o \"$installer\" && "
        f"UV_INSTALL_DIR={quoted_bin} sh \"$installer\" && "
        f"[ \"$({quoted_bin}/uv --version 2>/dev/null || true)\" = 'uv 0.9.5' ] "
        f"&& [ \"$({quoted_bin}/uvx --version 2>/dev/null || true)\" = 'uvx 0.9.5' ]; then "
        "provisioned=1; rm -f \"$installer\"; "
        "echo 'uv 0.9.5 provisioned'; break; "
        "fi; "
        "if [ -n \"$installer\" ]; then rm -f \"$installer\"; fi; "
        f"if [ \"$({quoted_bin}/uv --version 2>/dev/null || true)\" != 'uv 0.9.5' ]; "
        f"then rm -f {quoted_bin}/uv; fi; "
        f"if [ \"$({quoted_bin}/uvx --version 2>/dev/null || true)\" != 'uvx 0.9.5' ]; "
        f"then rm -f {quoted_bin}/uvx; fi; "
        f"if [ \"$attempt\" -lt {UV_BOOTSTRAP_ATTEMPTS} ]; then sleep 1; fi; "
        "attempt=$((attempt + 1)); "
        "done; "
        "if [ \"$provisioned\" -ne 1 ]; then "
        "echo 'warning: uv 0.9.5 pre-provisioning unavailable; verifier may retry bootstrap' >&2; "
        "fi; "
        "fi; "
        "exit 0"
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
        # Bench runs use the stock default workflow; the prompt-level mandate
        # bypasses only waiting for interactive approval.
        self._workflow = workflow or "default"
        # None => use the configured route provider; e.g.
        # --ak provider=anthropic-oauth.
        self._provider = provider
        # None => use the configured route effort; e.g. --ak effort=xhigh.
        self._effort = effort
        # A selected profile is rendered into a benchmark-owned minimal config.
        # Host config is never read.
        self._route_profile_name = route_profile
        self._route_profile = (
            load_route_profile(route_profile) if route_profile else None
        )
        # Host-side Anthropic preflight overlapped with container install.
        self._anthropic_preflight_task = None
        self._anthropic_preflight_dir = None
        self._anthropic_snapshot_path = None
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "mixdog"

    def get_version_command(self) -> str | None:
        return "mixdog --help >/dev/null 2>&1 && echo mixdog-" + self._mixdog_version

    def _required_providers(self) -> set[str]:
        routes = self._route_profile["routes"]
        if self._mode == "worker":
            return {routes["worker"]["provider"]}
        required = {route["provider"] for route in routes.values()}
        fallback = self._route_profile.get("leadFallback")
        if fallback:
            required.add(fallback["provider"])
        return required

    def _start_anthropic_preflight(self) -> None:
        """Kick the host-side lease refresh so it overlaps container install."""
        if self._route_profile is None or self._anthropic_preflight_task is not None:
            return
        if "anthropic-oauth" not in self._required_providers():
            return
        self._anthropic_preflight_dir = tempfile.TemporaryDirectory(
            prefix="mixdog-tb-anthropic-lease-"
        )
        self._anthropic_snapshot_path = (
            Path(self._anthropic_preflight_dir.name)
            / "anthropic-oauth-credentials.json"
        )
        self._anthropic_preflight_task = asyncio.create_task(
            asyncio.to_thread(
                _run_anthropic_preflight,
                _host_credentials_path(),
                self._anthropic_snapshot_path,
            )
        )
        # Retrieve a failure quietly if run() never consumes the task.
        self._anthropic_preflight_task.add_done_callback(
            lambda task: task.exception() if not task.cancelled() else None
        )

    async def install(self, environment: BaseEnvironment) -> None:
        self._start_anthropic_preflight()
        timings = {}

        async def _timed(label, coro):
            started = time.monotonic()
            result = await coro
            timings[label] = time.monotonic() - started
            return result
        prebake_tar = Path(
            os.environ.get(PREBAKE_TAR_ENV, "") or DEFAULT_PREBAKE_TAR
        )
        if prebake_tar.is_file():
            # apt (glibc) images take the fast path; apk/yum fall through to
            # the stock installer below (the tar targets debian layout).
            probe = await self.exec_as_root(
                environment, command="command -v apt-get >/dev/null 2>&1 && echo apt || true"
            )
            if "apt" in (getattr(probe, "stdout", "") or ""):
                async def _stage_leg():
                    await environment.upload_file(prebake_tar, CONTAINER_PREBAKE_TAR)
                    return await self.exec_as_root(
                        environment,
                        command=(
                            "set -eu; "
                            f"tar -C / -xzf {CONTAINER_PREBAKE_TAR}; "
                            f"rm -f {CONTAINER_PREBAKE_TAR}; "
                            # Prebaked dep-layer compile cache lives OUTSIDE
                            # /opt/mixdog (which _inject_credentials recreates);
                            # agent-user warmup/driver must be able to append.
                            "mkdir -p /opt/mixdog-v8-cache; "
                            "chmod -R a+rwX /opt/mixdog-v8-cache; "
                            # Static curl + CA bundle from the tar replace the
                            # old parallel apt leg (18-20s network critical
                            # path on curl-less images). Additive only: the
                            # image's own curl/certs always win.
                            "if ! command -v curl >/dev/null 2>&1 && [ -x /opt/static-curl/curl ]; then "
                            "install -m 0755 /opt/static-curl/curl /usr/local/bin/curl; fi; "
                            "if [ ! -s /etc/ssl/certs/ca-certificates.crt ] && [ -s /opt/static-curl/ca-certificates.crt ]; then "
                            "mkdir -p /etc/ssl/certs; "
                            "cp /opt/static-curl/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt; fi; "
                            "timeout --version | grep -q 'GNU coreutils'; node --version; "
                            "mixdog --help >/dev/null 2>&1 && echo 'mixdog installed (prebaked)'; "
                            "for dep in rg node timeout tar grep; do "
                            "command -v \"$dep\" >/dev/null 2>&1 || { echo \"tool-dep missing: $dep\" >&2; exit 1; }; "
                            "done; echo 'tool-dep preflight ok: rg node timeout tar grep'; "
                            "if command -v curl >/dev/null 2>&1 && [ -s /etc/ssl/certs/ca-certificates.crt ]; then "
                            "echo CURL_READY; else echo CURL_MISSING; fi"
                        ),
                    )

                stage_result = await _timed("stage", _stage_leg())
                if "CURL_MISSING" in (getattr(stage_result, "stdout", "") or ""):
                    # Old tar without the static bundle: uniform network
                    # fallback (no task conditionals).
                    await _timed("apt-fallback", self.exec_as_root(
                        environment,
                        command=(
                            "set -eu; apt-get update && "
                            "apt-get install -y curl ca-certificates"
                        ),
                        env={"DEBIAN_FRONTEND": "noninteractive"},
                    ))
                # uv 0.9.5 rides the prebake tar (root/.local/bin), so this
                # hits the "already available" fast path (~1s, no network);
                # older tars without uv fall back to the bounded download.
                await _timed("uv", self.exec_as_root(
                    environment,
                    command=_uv_provision_command(),
                ))
                print(
                    "[setup-timing] "
                    + " ".join(f"{k}={v:.1f}s" for k, v in timings.items()),
                    flush=True,
                )
                return
        # System deps + Node.js >= 22 (root). NodeSource for apt; distro pkg for apk/yum.
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y curl ca-certificates coreutils ripgrep && "
                "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && "
                "  apt-get install -y nodejs; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache curl bash coreutils nodejs npm ripgrep; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && "
                "  yum install -y nodejs coreutils && (yum install -y ripgrep || true); "
                "else "
                "  echo 'No known package manager (apt/apk/yum)' >&2; exit 1; "
                "fi; "
                "timeout --version | grep -q 'GNU coreutils'; node --version; "
                # Tool-dependency preflight: every external binary a builtin
                # tool shells out to must exist NOW, or setup fails loudly —
                # a missing binary must never surface as silent per-turn tool
                # errors (the ripgrep incident).
                "for dep in rg node timeout tar grep; do "
                "command -v \"$dep\" >/dev/null 2>&1 || { echo \"tool-dep missing: $dep\" >&2; exit 1; }; "
                "done; echo 'tool-dep preflight ok: rg node timeout tar grep'"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # Some official verifiers bootstrap their pinned uv with curl at grading
        # time.  Make curl's DNS/all-error recovery bounded, and install the same
        # uv version up front so a transient GitHub failure cannot turn into a
        # later "uvx: command not found" reward.
        await self.exec_as_root(
            environment,
            command=_uv_provision_command(),
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
        if self._route_profile is None:
            raise RuntimeError(
                "Terminal-Bench pristine mode requires a selected route_profile"
            )
        routes = self._route_profile["routes"]
        if self._mode == "worker":
            required_providers = {routes["worker"]["provider"]}
        else:
            required_providers = {
                route["provider"] for route in routes.values()
            }
            fallback = self._route_profile.get("leadFallback")
            if fallback:
                required_providers.add(fallback["provider"])
        boot_files = _collect_provider_files(required_providers)
        credential_snapshot_dir = None
        generated_dir = tempfile.TemporaryDirectory(prefix="mixdog-tb-pristine-")
        timings = {}
        try:
            if "anthropic-oauth" in required_providers:
                # Started during install(); only the residual wait shows here.
                self._start_anthropic_preflight()
                wait_started = time.monotonic()
                await self._anthropic_preflight_task
                timings["preflight-wait"] = time.monotonic() - wait_started
                # Never distribute the mutable host file. Every trial receives
                # the owner-only snapshot written inside the serialized lease.
                credential_snapshot_dir = self._anthropic_preflight_dir
                boot_files["anthropic-oauth-credentials.json"] = (
                    self._anthropic_snapshot_path
                )
                self._anthropic_preflight_task = None
                self._anthropic_preflight_dir = None

            generated_root = Path(generated_dir.name)
            generated_config = generated_root / "mixdog-config.json"
            config = build_benchmark_config(
                self._route_profile, self._workflow
            )
            config_bytes = (
                json.dumps(config, indent=2, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            generated_config.write_bytes(config_bytes)
            credential_count = sum(
                name in PROVIDER_CREDENTIAL_FILES.values()
                for name in boot_files
            )
            catalog_count = sum(
                name in PROVIDER_MODEL_CATALOG_FILES.values()
                for name in boot_files
            )
            audit = {
                "schemaVersion": 1,
                "mode": "terminal-bench-pristine",
                "routeProfile": self._route_profile_name,
                "workflow": self._workflow,
                "configSha256": hashlib.sha256(config_bytes).hexdigest(),
                "providerIds": sorted(required_providers),
                "injectedCredentialFileCount": credential_count,
                "injectedModelCatalogFileCount": catalog_count,
                "personalState": {
                    "hostConfigRead": False,
                    **{
                        name: 0
                        for name in PRISTINE_CONTRACT["personalStateCounters"]
                    },
                },
                "featuresEnabled": {
                    name: False
                    for name in PRISTINE_CONTRACT["disabledFeatures"]
                },
            }
            generated_audit = generated_root / PERSONAL_STATE_AUDIT_NAME
            generated_audit.write_text(
                json.dumps(audit, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            await self.exec_as_root(
                environment,
                command=(
                    f"rm -rf {CONTAINER_DATA_DIR} && "
                    f"mkdir -p {CONTAINER_DATA_DIR} /logs/agent"
                ),
            )
            upload_files = {"mixdog-config.json": generated_config, **boot_files}
            # docker cp each file — token bytes never appear in a shell command/log.
            # Every docker-cp leg is independent; run them concurrently with
            # the src-snapshot upload to shorten the serial pre-driver window.
            snapshot = self._load_src_snapshot()
            uploads_started = time.monotonic()
            await asyncio.gather(
                *(
                    environment.upload_file(
                        host_path, f"{CONTAINER_DATA_DIR}/{name}"
                    )
                    for name, host_path in upload_files.items()
                ),
                environment.upload_file(
                    generated_audit, CONTAINER_PERSONAL_STATE_AUDIT
                ),
                environment.upload_file(
                    snapshot.archive_path, CONTAINER_SRC_SNAPSHOT
                ),
            )
            timings["uploads"] = time.monotonic() - uploads_started
            print(
                format_resolved_routes(
                    self._route_profile_name, self._route_profile
                ),
                flush=True,
            )
            print(
                "personal-state-audit v1 personal-files=0 host-config=0 "
                "mcp=0 skills=0 core-memory=0 channels=0 "
                f"credentials={credential_count} catalogs={catalog_count}",
                flush=True,
            )
        finally:
            generated_dir.cleanup()
            if credential_snapshot_dir is not None:
                credential_snapshot_dir.cleanup()
        swap_started = time.monotonic()
        await self._inject_src_snapshot(environment, upload=False)
        timings["swap+warmup"] = time.monotonic() - swap_started
        # Own/secure the copied setup so the user mixdog can read it; OAuth
        # refresh is explicitly forbidden below. default_user None => root.
        user = getattr(environment, "default_user", None)
        if user is not None:
            await self.exec_as_root(
                environment,
                command=(
                    f"chown -R {shlex.quote(str(user))} "
                    f"{CONTAINER_DATA_DIR} /logs/agent"
                ),
            )
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 700 {CONTAINER_DATA_DIR} && "
                f"chmod 600 {CONTAINER_DATA_DIR}/*-credentials.json "
                f"{CONTAINER_DATA_DIR}/*-oauth.json 2>/dev/null || true"
            ),
        )
        print(
            "[predriver-timing] "
            + " ".join(f"{k}={v:.1f}s" for k, v in timings.items()),
            flush=True,
        )

    @staticmethod
    def _load_src_snapshot():
        # The launcher captures this once before Harbor creates any trials.
        snapshot_path = os.environ.get(SNAPSHOT_ENV)
        if not snapshot_path:
            raise RuntimeError(
                f"{SNAPSHOT_ENV} is required; run Terminal-Bench through run-tb21.ps1"
            )
        return load_src_snapshot(Path(snapshot_path))

    async def _inject_src_snapshot(
        self, environment: BaseEnvironment, upload: bool = True
    ) -> None:
        if upload:
            snapshot = self._load_src_snapshot()
            await environment.upload_file(
                snapshot.archive_path, CONTAINER_SRC_SNAPSHOT
            )
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                'PACKAGE="$(npm root -g)/mixdog"; '
                'STAGING="$PACKAGE/.src-local-snapshot"; '
                'BACKUP="$PACKAGE/.src-installed-backup"; '
                'cleanup_src_swap() { '
                'rm -rf "$STAGING"; '
                'if [ -e "$BACKUP" ]; then '
                'if [ ! -e "$PACKAGE/src" ]; then mv "$BACKUP" "$PACKAGE/src"; '
                'else rm -rf "$BACKUP"; fi; fi; }; '
                'trap cleanup_src_swap EXIT; '
                "trap 'exit 1' HUP INT TERM; "
                'if [ -e "$BACKUP" ]; then '
                'if [ ! -e "$PACKAGE/src" ]; then mv "$BACKUP" "$PACKAGE/src"; '
                'else rm -rf "$BACKUP"; fi; fi; '
                'rm -rf "$STAGING"; mkdir -p "$STAGING"; '
                f"tar -xf {shlex.quote(CONTAINER_SRC_SNAPSHOT)} -C \"$STAGING\"; "
                'test -d "$STAGING/src"; '
                'mv "$PACKAGE/src" "$BACKUP"; '
                'if ! mv "$STAGING/src" "$PACKAGE/src"; then '
                'mv "$BACKUP" "$PACKAGE/src"; exit 1; fi; '
                'rm -rf "$BACKUP" "$STAGING"; '
                'trap - EXIT HUP INT TERM; '
                'echo "full local src snapshot installed"'
            ),
        )
        # Warm the V8 module compile cache for the runtime's import graph so
        # the driver's cold boot (~25s of module compilation in-container) is
        # paid once before the driver boots. The driver run exports the same
        # NODE_COMPILE_CACHE and reuses the cache. Import only — no runtime is
        # created, no credentials are touched.
        await self.exec_as_agent(
            environment,
            command=(
                "set -u; export NODE_COMPILE_CACHE=/opt/mixdog-v8-cache; "
                'export MIXDOG_SRC="$(npm root -g)/mixdog/src"; '
                "timeout 120s node --input-type=module -e "
                "'const { pathToFileURL } = await import(\"node:url\"); "
                'await import(pathToFileURL(process.env.MIXDOG_SRC + "/mixdog-session-runtime.mjs"));\' '
                ">/dev/null 2>&1 && echo 'v8 cache warmed' || echo 'v8 cache warmup skipped'"
            ),
        )

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
            **PRISTINE_GUARD_ENV,
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
            # Pristine benchmark boundary: no project/config MCP, no skill
            # discovery/seeding/tool surface, no personal core-memory boot, and
            # no channel startup.
            # Bench-only decision cadence: cap explicit sync shell timeouts at
            # 2 min (blocking window), so promote-on-timeout delivers the
            # partial-output decision point early. Uniform time policy — no
            # task-specific heuristics; product default stays 10 min.
            "BASH_MAX_TIMEOUT_MS": "120000",
            # Network-stall recovery layering (2026-08-03 v3 postmortem: the
            # old STALL_TIMEOUT_S=300 collapsed the provider semantic idle to
            # 135s and beheaded LIVE silent-thinking streams — regex-chess /
            # circuit-fibsqrt died deterministically at 4x~138s). The PROVIDER
            # layer now owns fast detection/recovery: byte-level first byte at
            # 120s, semantic idle fixed at 300s (silent effort-mode thinking
            # is live generation, not a wedge), and a stall that exposed
            # nothing is re-issued NON-STREAMING (waits for the full body, up
            # to 420s below). Agent and driver watchdogs are pure backstops
            # and must sit ABOVE the compound provider window
            # (300s stream + 420s non-stream = 720s):
            #   provider 120/300+420 < agent abort 780 < driver 840 < Harbor.
            "STALL_TIMEOUT_S": "780",
            "MIXDOG_NONSTREAM_TOTAL_TIMEOUT_MS": "420000",
            # Wedged-socket first byte: provider aborts at 120s and retries.
            # The agent-level requesting-stage backstop must exceed the 420s
            # non-streaming wait so a slow silent body surfaces as a
            # retryable transport timeout, not an agent kill.
            "MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS": "120000",
            "MIXDOG_STALL_FIRST_BYTE_ABORT_S": "450",
            # Driver stall guard (lead_driver STALL_MS): last resort only —
            # every runtime layer recovers first; a driver stall still
            # invalidates the attempt for a fresh Harbor trial.
            "MIXDOG_STALL_MS": "840000",
            # BP4 messages-tail cache TTL pinned to 1h: bench turns routinely
            # gap >5m (long thinking / 900s tools), so a 5m tail would expire
            # between requests and re-write the whole context. The uncached
            # double-billing was the ANCHOR lag, fixed in
            # applyAnthropicCacheMarkers (true-tip candidate), not the TTL.
            "MIXDOG_CACHE_MESSAGES_TTL": "1h",
        }
        fallback_route = (
            self._route_profile.get("leadFallback")
            if self._route_profile is not None
            else None
        )
        fallback_marker = (
            self._fallback_marker_path(environment, fallback_route)
            if fallback_route is not None
            else None
        )
        use_fallback = fallback_marker is not None and fallback_marker.is_file()
        try:
            if self._mode == "worker":
                await self._run_worker(
                    environment,
                    instruction,
                    model,
                    base_env,
                    worker_route=self._route_profile["routes"]["worker"],
                )
            else:
                try:
                    await self._run_lead(
                        environment,
                        instruction,
                        model,
                        base_env,
                        lead_route=fallback_route if use_fallback else None,
                    )
                except Exception as exc:
                    if (
                        fallback_marker is not None
                        and self._is_retry_exit(exc)
                        and not use_fallback
                    ):
                        self._create_fallback_marker(fallback_marker)
                    raise
                else:
                    if fallback_marker is not None:
                        fallback_marker.unlink(missing_ok=True)
        finally:
            # Best-effort even when the run raised or hit AgentTimeout: the
            # driver mirrors /logs/agent/usage.json every 30s, so the last
            # snapshot survives a kill and keeps the trial's token stats
            # complete (observed: timeout-but-PASSED trials losing usage).
            # Shield so an in-flight outer cancellation cannot strand the
            # container exec mid-write; any failure here stays silent.
            try:
                await asyncio.shield(
                    self._populate_usage_context(environment, context)
                )
            except BaseException:
                pass

    @staticmethod
    def _is_retry_exit(exc: Exception) -> bool:
        return isinstance(exc, NonZeroAgentExitCodeError) and str(exc).startswith(
            f"Command failed (exit {FALLBACK_RETRY_EXIT_CODE}):"
        )

    @staticmethod
    def _fallback_marker_path(environment, route: dict) -> Path:
        session_id = str(getattr(environment, "session_id", "") or "").strip()
        if not session_id:
            raise RuntimeError(
                "Harbor environment has no session_id for fallback-attempt state"
            )
        root_value = os.environ.get(FALLBACK_STATE_ENV)
        root = (
            Path(root_value)
            if root_value
            else Path(tempfile.gettempdir()) / f"mixdog-tb-fallback-{os.getpid()}"
        )
        identity = json.dumps(
            {"sessionId": session_id, "route": route},
            sort_keys=True,
            separators=(",", ":"),
        )
        name = hashlib.sha256(identity.encode("utf-8")).hexdigest() + ".retry"
        return root / name

    @staticmethod
    def _create_fallback_marker(marker: Path) -> None:
        marker.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(
                marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
        except FileExistsError:
            return
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("fallback\n")

    async def _populate_usage_context(self, environment, context) -> None:
        """Best-effort copy of the driver's aggregate usage into Harbor."""
        try:
            result = await environment.exec(
                command="cat /logs/agent/usage.json"
            )
            if getattr(result, "return_code", 1) != 0:
                return
            document = json.loads(getattr(result, "stdout", "") or "")
            totals = document.get("totals")
            if not isinstance(totals, dict):
                return
            fields = (
                ("n_input_tokens", "inputTokens"),
                ("n_cache_tokens", "cacheTokens"),
                ("n_output_tokens", "outputTokens"),
            )
            model_fields = getattr(type(context), "model_fields", {})
            for target, source in fields:
                if hasattr(context, target) or target in model_fields:
                    setattr(context, target, max(0, int(totals.get(source, 0) or 0)))
        except Exception:
            # Older Harbor schemas, missing snapshots, and container read
            # failures are all intentionally non-fatal.
            return

    async def _run_worker(
        self, environment, instruction, model, base_env, *, worker_route=None
    ):
        # A selected profile owns the direct-worker route just as it owns every
        # Lead-spawned role route.
        provider = (
            worker_route["provider"]
            if worker_route is not None
            else self._provider or "anthropic-oauth"
        )
        model = (
            worker_route["model"]
            if worker_route is not None
            else model or "claude-sonnet-4-5"
        )
        route_args = ""
        if worker_route is not None:
            route_args = (
                f" --effort {shlex.quote(worker_route['effort'])}"
                + (" --fast" if worker_route["fast"] else "")
            )
        escaped_instruction = shlex.quote(instruction)
        worker_pipeline = (
            "mkdir -p /logs/agent; "
            f"mixdog --provider {shlex.quote(provider)} --model {shlex.quote(model)}"
            f"{route_args} "
            f"worker {escaped_instruction} "
            "2>&1 | tee /logs/agent/mixdog.txt"
        )
        await self.exec_as_agent(
            environment,
            command=_bounded_process_command(worker_pipeline, "worker"),
            env=base_env,
        )

    async def _run_lead(
        self, environment, instruction, model, base_env, *, lead_route=None
    ):
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
            # CC-parity: the raw task instruction only. The old headless
            # mandate prefix proved unnecessary (2026-08-03 no-mandate probe:
            # pass parity, no approval stall, no cost delta) — the lead treats
            # the imperative task text as the approved plan on its own.
            "MIXDOG_PROMPT": instruction,
        }
        # Only set overrides when explicitly requested; otherwise the driver
        # boots the user's configured route + active workflow.
        if lead_route is not None:
            run_env["MIXDOG_PROVIDER"] = lead_route["provider"]
            run_env["MIXDOG_MODEL"] = lead_route["model"]
            run_env["MIXDOG_EFFORT"] = lead_route["effort"]
            run_env["MIXDOG_FAST"] = "1" if lead_route["fast"] else "0"
        elif model:
            run_env["MIXDOG_MODEL"] = model
        if lead_route is None and self._provider:
            run_env["MIXDOG_PROVIDER"] = self._provider
        if lead_route is None and self._effort:
            run_env["MIXDOG_EFFORT"] = self._effort
        if self._workflow:
            run_env["MIXDOG_WORKFLOW"] = self._workflow
        lead_pipeline = (
            "mkdir -p /logs/agent; "
            "export NODE_COMPILE_CACHE=/opt/mixdog-v8-cache; "
            'export MIXDOG_SRC="$(npm root -g)/mixdog/src"; '
            f"node {CONTAINER_LEAD_DRIVER} "
            "2>&1 | tee /logs/agent/mixdog.txt"
        )
        await self.exec_as_agent(
            environment,
            command=_bounded_process_command(lead_pipeline, "lead"),
            env=run_env,
        )
