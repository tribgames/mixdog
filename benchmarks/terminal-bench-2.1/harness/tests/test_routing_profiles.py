from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


BENCH_ROOT = Path(__file__).resolve().parents[2]
HARNESS_ROOT = BENCH_ROOT / "harness"
REPO_ROOT = BENCH_ROOT.parents[1]
sys.path.insert(0, str(BENCH_ROOT))

from harness.routing_profiles import (  # noqa: E402
    PROFILE_PATH,
    PROFILE_ROLES,
    RouteProfileError,
    build_benchmark_config,
    format_resolved_routes,
    load_route_profile,
    reject_profile_conflicts,
    validate_profile_document,
)
from harness.src_overlay import (  # noqa: E402
    SNAPSHOT_ENV,
    SrcOverlayError,
    build_src_snapshot,
    load_src_snapshot,
)

EXPECTED_AUDIT_LINE = (
    "route-profile fable-xhigh: "
    "lead=anthropic-oauth/claude-fable-5 effort=xhigh fast=false; "
    "worker=openai-oauth/gpt-5.6-terra effort=high fast=true; "
    "heavy-worker=openai-oauth/gpt-5.6-sol effort=xhigh fast=true; "
    "reviewer=openai-oauth/gpt-5.6-sol effort=xhigh fast=true; "
    "debugger=openai-oauth/gpt-5.6-sol effort=xhigh fast=true"
)
def resolve_with_real_runtime(config: dict) -> dict:
    repo_root = BENCH_ROOT.parents[1]
    config_uri = (repo_root / "src/runtime/agent/orchestrator/config.mjs").as_uri()
    helpers_uri = (repo_root / "src/session-runtime/config-helpers.mjs").as_uri()
    workflow_uri = (repo_root / "src/session-runtime/workflow.mjs").as_uri()
    agent_helpers_uri = (repo_root / "src/standalone/agent-tool/helpers.mjs").as_uri()
    script = f"""
import {{ loadConfig, getDefaultPreset }} from {json.dumps(config_uri)};
import {{
  findPreset, makeResolveDefaultProvider, makeResolveRoute
}} from {json.dumps(helpers_uri)};
import {{ createWorkflowRouteHelpers }} from {json.dumps(workflow_uri)};
import {{ normalizeAgentRoute }} from {json.dumps(agent_helpers_uri)};
const config = loadConfig({{ secrets: false }});
const resolveDefaultProvider = makeResolveDefaultProvider(() => true);
const resolveRoute = makeResolveRoute(resolveDefaultProvider);
const runtimeLead = resolveRoute(config, {{}});
const workflowHelpers = createWorkflowRouteHelpers({{
  resolveDefaultProvider,
  findPreset,
}});
const cleanRoute = (route) => ({{
  provider: route?.provider,
  model: route?.model,
  effort: route?.effort,
  fast: route?.fast === true,
}});
const agentKeys = {{
  worker: 'worker',
  'heavy-worker': 'heavy-worker',
  reviewer: 'reviewer',
  debugger: 'debugger',
}};
const agents = Object.fromEntries(Object.entries(agentKeys).map(
  ([role, key]) => [role, cleanRoute(normalizeAgentRoute(config.agents?.[key]))]
));
process.stdout.write(JSON.stringify({{
  runtimeLead: cleanRoute(runtimeLead),
  defaultPreset: cleanRoute(getDefaultPreset(config)),
  workflowLead: cleanRoute(workflowHelpers.summarizeWorkflowRoutes(config).lead),
  agents,
}}));
"""
    with tempfile.TemporaryDirectory(prefix="mixdog-route-runtime-test-") as data_dir:
        Path(data_dir, "mixdog-config.json").write_text(
            json.dumps(config), encoding="utf-8"
        )
        env = {**os.environ, "MIXDOG_DATA_DIR": data_dir}
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=repo_root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class RoutingProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.document = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))

    def test_profile_schema_and_exact_routes(self) -> None:
        validate_profile_document(self.document)
        profile = load_route_profile('fable-xhigh')
        self.assertEqual(tuple(profile['routes']), PROFILE_ROLES)
        self.assertEqual(
            profile['leadFallback'],
            {
                'provider': 'anthropic-oauth',
                'model': 'claude-opus-4-8',
                'effort': 'xhigh',
                'fast': False,
            },
        )
        self.assertEqual(
            profile['routes'],
            {
                'lead': {
                    'provider': 'anthropic-oauth',
                    'model': 'claude-fable-5',
                    'effort': 'xhigh',
                    'fast': False,
                },
                'worker': {
                    'provider': 'openai-oauth',
                    'model': 'gpt-5.6-terra',
                    'effort': 'high',
                    'fast': True,
                },
                'heavy-worker': {
                    'provider': 'openai-oauth',
                    'model': 'gpt-5.6-sol',
                    'effort': 'xhigh',
                    'fast': True,
                },
                'reviewer': {
                    'provider': 'openai-oauth',
                    'model': 'gpt-5.6-sol',
                    'effort': 'xhigh',
                    'fast': True,
                },
                'debugger': {
                    'provider': 'openai-oauth',
                    'model': 'gpt-5.6-sol',
                    'effort': 'xhigh',
                    'fast': True,
                },
            },
        )
        sol_profile = load_route_profile('sol-xhigh')
        self.assertEqual(tuple(sol_profile['routes']), ('lead',))
        self.assertNotIn('leadFallback', sol_profile)
        self.assertEqual(
            sol_profile['routes'],
            {
                'lead': {
                    'provider': 'openai-oauth',
                    'model': 'gpt-5.6-sol',
                    'effort': 'xhigh',
                    'fast': True,
                },
            },
        )
        for profile_name in (
            'sol-xhigh',
            'sol-xhigh-nofast',
            'grok46-xhigh',
            'grok46-high',
            'opus5-solo',
            'grokbuild',
        ):
            with self.subTest(profile=profile_name):
                self.assertEqual(
                    tuple(load_route_profile(profile_name)['routes']), ('lead',)
                )
        sol_workers = load_route_profile('fable-sol-workers-xhigh')
        opus_workers = load_route_profile('fable-opus-workers-xhigh')
        shared = {
            role: sol_workers['routes'][role]
            for role in PROFILE_ROLES
            if role not in ('worker', 'heavy-worker')
        }
        self.assertEqual(
            shared,
            {
                role: opus_workers['routes'][role]
                for role in PROFILE_ROLES
                if role not in ('worker', 'heavy-worker')
            },
        )
        self.assertEqual(
            sol_workers['routes']['worker'],
            sol_workers['routes']['heavy-worker'],
        )
        self.assertEqual(
            opus_workers['routes']['worker'],
            opus_workers['routes']['heavy-worker'],
        )
        self.assertNotEqual(
            sol_workers['routes']['worker'],
            opus_workers['routes']['worker'],
        )

    def test_schema_rejects_malformed_documents(self) -> None:
        cases = []
        wrong_version = copy.deepcopy(self.document)
        wrong_version["schemaVersion"] = 2
        cases.append(wrong_version)
        boolean_version = copy.deepcopy(self.document)
        boolean_version["schemaVersion"] = True
        cases.append(boolean_version)
        missing_role = copy.deepcopy(self.document)
        del missing_role["profiles"]["fable-xhigh"]["routes"]["lead"]
        cases.append(missing_role)
        unknown_role = copy.deepcopy(self.document)
        unknown_role["profiles"]["sol-xhigh"]["routes"]["unknown"] = copy.deepcopy(
            unknown_role["profiles"]["sol-xhigh"]["routes"]["lead"]
        )
        cases.append(unknown_role)
        invalid_effort = copy.deepcopy(self.document)
        invalid_effort["profiles"]["fable-xhigh"]["routes"]["lead"]["effort"] = "ultra"
        cases.append(invalid_effort)
        non_boolean_fast = copy.deepcopy(self.document)
        non_boolean_fast["profiles"]["fable-xhigh"]["routes"]["worker"]["fast"] = "true"
        cases.append(non_boolean_fast)
        invalid_fallback = copy.deepcopy(self.document)
        invalid_fallback["profiles"]["fable-xhigh"]["leadFallback"]["fast"] = "true"
        cases.append(invalid_fallback)
        for malformed in cases:
            with self.subTest(malformed=malformed), self.assertRaises(RouteProfileError):
                validate_profile_document(malformed)

    def test_unknown_profile_and_explicit_override_conflicts(self) -> None:
        with self.assertRaisesRegex(RouteProfileError, "unknown routing profile"):
            load_route_profile("does-not-exist")
        for override in (
            {"provider": "openai-oauth"},
            {"model": "gpt-5.6-sol"},
            {"effort": "xhigh"},
        ):
            with self.subTest(override=override), self.assertRaisesRegex(
                RouteProfileError, "cannot be combined"
            ):
                reject_profile_conflicts("fable-xhigh", **override)
        reject_profile_conflicts(None, provider="openai-oauth", model="gpt-5.6-sol")

    def test_benchmark_config_contains_only_profile_routes_and_workflow(self) -> None:
        profile = load_route_profile("fable-xhigh")
        config = build_benchmark_config(profile)
        agent = config["agent"]

        self.assertEqual(set(config), {"agent", "outputStyle"})
        self.assertEqual(
            set(agent),
            {
                "providers",
                "presets",
                "default",
                "workflow",
                "workflowRoutes",
                "agents",
                "modelSettings",
                "mcpServers",
                "profile",
            },
        )
        self.assertEqual(config["outputStyle"], "simple")
        self.assertEqual(agent["profile"], {"language": "en"})
        self.assertEqual(agent["workflow"], {"active": "headless"})
        self.assertEqual(agent["mcpServers"], {})
        self.assertEqual(agent["workflowRoutes"], {"lead": profile["routes"]["lead"]})
        self.assertNotIn("memory", agent["workflowRoutes"])
        self.assertEqual(
            set(agent["providers"]), {"anthropic-oauth", "openai-oauth"}
        )
        serialized = json.dumps(config)
        for personal_key in (
            "plugins",
            "channels",
            "sessions",
            "memory",
        ):
            self.assertNotIn(f'"{personal_key}"', serialized)

    def test_lead_only_profile_omits_subagent_routes(self) -> None:
        profile = load_route_profile("sol-xhigh-nofast")
        config = build_benchmark_config(profile, "default")
        self.assertEqual(config["agent"]["agents"], {})
        self.assertEqual(
            format_resolved_routes("sol-xhigh-nofast", profile),
            "route-profile sol-xhigh-nofast: "
            "lead=openai-oauth/gpt-5.6-sol effort=xhigh fast=false",
        )

    def test_real_runtime_helpers_resolve_benchmark_config(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        profile = load_route_profile("fable-xhigh")
        config = build_benchmark_config(profile, "solo")
        resolved = resolve_with_real_runtime(config)
        self.assertEqual(resolved["runtimeLead"], profile["routes"]["lead"])
        self.assertEqual(resolved["defaultPreset"], profile["routes"]["lead"])
        self.assertEqual(resolved["workflowLead"], profile["routes"]["lead"])
        self.assertEqual(resolved["agents"], {
            role: profile["routes"][role]
            for role in ("worker", "heavy-worker", "reviewer", "debugger")
        })

    def test_audit_log_is_stable_and_complete(self) -> None:
        line = format_resolved_routes("fable-xhigh", load_route_profile("fable-xhigh"))
        self.assertEqual(line, EXPECTED_AUDIT_LINE)

    def test_solo_review_workflow_is_not_discovered_or_accepted(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        script = r"""
import { resolve } from 'node:path';
import { createWorkflowHelpers } from './src/session-runtime/workflow.mjs';
import { createWorkflowAgentsApi } from './src/session-runtime/workflow-agents-api.mjs';
function readMarkdownDocument(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^"(.*)"$/, '$1');
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2].trim() };
}
const helpers = createWorkflowHelpers({
  rootDir: resolve('src'),
  dataDir: resolve('.nonexistent-workflow-test-data'),
  readMarkdownDocument,
  normalizeAgentPermissionOrNone: (value) => value,
});
const discovered = helpers.listWorkflowPacks().some(({ id }) => id === 'solo-review');
let saved = false;
const api = createWorkflowAgentsApi({
  getConfig: () => ({ workflow: { active: 'default' } }),
  cfgMod: { getPluginData: () => resolve('.nonexistent-workflow-test-data') },
  STANDALONE_DATA_DIR: resolve('.nonexistent-workflow-test-data'),
  loadWorkflowPack: helpers.loadWorkflowPack,
  saveConfigAndAdopt: () => { saved = true; },
  workflowSummary: helpers.workflowSummary,
});
let rejected = '';
try {
  await api.setWorkflow('solo-review');
} catch (error) {
  rejected = error.message;
}
console.log(JSON.stringify({
  discovered,
  rejected,
  saved,
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "discovered": False,
                "rejected": 'workflow "solo-review" not found',
                "saved": False,
            },
        )


class SrcSnapshotTests(unittest.TestCase):
    @staticmethod
    def build(repo_src: Path, output: Path):
        spawn = output.parent / "mixdog-spawn"
        spawn.write_bytes(b"current native spawn")
        spawn.chmod(0o755)
        return build_src_snapshot(repo_src, output, spawn)

    @staticmethod
    def extract(snapshot, destination: Path) -> Path:
        with tarfile.open(snapshot.archive_path, "r:") as archive:
            archive.extractall(destination)
        return destination / "src"

    def test_snapshot_captures_the_complete_local_tree_and_is_immutable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-snapshot-") as temp:
            root = Path(temp)
            repo_src = root / "repo" / "src"
            (repo_src / "committed").mkdir(parents=True)
            (repo_src / "empty-local-directory").mkdir()
            (repo_src / "committed" / "unchanged.mjs").write_bytes(b"committed")
            (repo_src / "modified.mjs").write_bytes(b"local modification")
            (repo_src / "untracked-addition.mjs").write_bytes(b"local addition")
            snapshot = self.build(repo_src, root / "snapshot.tar")

            (repo_src / "modified.mjs").write_bytes(b"later mutation")
            (repo_src / "untracked-addition.mjs").unlink()
            (repo_src / "later-addition.mjs").write_bytes(b"too late")

            loaded = load_src_snapshot(snapshot.archive_path)
            extracted = self.extract(loaded, root / "extracted")
            self.assertEqual(
                (root / "extracted" / "native-tools" / "mixdog-spawn").read_bytes(),
                b"current native spawn",
            )
            self.assertEqual(
                {
                    path.relative_to(extracted).as_posix(): path.read_bytes()
                    for path in extracted.rglob("*")
                    if path.is_file()
                },
                {
                    "committed/unchanged.mjs": b"committed",
                    "modified.mjs": b"local modification",
                    "untracked-addition.mjs": b"local addition",
                },
            )
            self.assertFalse((extracted / "locally-deleted.mjs").exists())
            self.assertFalse((extracted / "later-addition.mjs").exists())
            self.assertTrue((extracted / "empty-local-directory").is_dir())
            self.assertTrue(snapshot.archive_path.is_file())

    def test_whole_tree_replacement_removes_stale_installed_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-replace-") as temp:
            root = Path(temp)
            repo_src = root / "repo" / "src"
            repo_src.mkdir(parents=True)
            (repo_src / "kept.mjs").write_bytes(b"exact local bytes")
            snapshot = self.build(repo_src, root / "snapshot.tar")

            package_src = root / "package" / "src"
            package_src.mkdir(parents=True)
            (package_src / "kept.mjs").write_bytes(b"stale installed bytes")
            (package_src / "locally-deleted.mjs").write_bytes(b"must disappear")
            staging = root / "staging"
            extracted = self.extract(snapshot, staging)
            shutil.rmtree(package_src)
            extracted.replace(package_src)

            self.assertEqual((package_src / "kept.mjs").read_bytes(), b"exact local bytes")
            self.assertFalse((package_src / "locally-deleted.mjs").exists())

    def test_snapshot_rejects_unsafe_and_non_regular_archive_members(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-snapshot-") as temp:
            root = Path(temp)
            unsafe = root / "unsafe.tar"
            with tarfile.open(unsafe, "w") as archive:
                info = tarfile.TarInfo("../escape.mjs")
                info.size = 0
                archive.addfile(info)
            with self.assertRaisesRegex(SrcOverlayError, "escapes|outside|unsafe"):
                load_src_snapshot(unsafe)

            linked = root / "linked.tar"
            with tarfile.open(linked, "w") as archive:
                src_info = tarfile.TarInfo("src")
                src_info.type = tarfile.DIRTYPE
                archive.addfile(src_info)
                link_info = tarfile.TarInfo("src/link.mjs")
                link_info.type = tarfile.SYMTYPE
                link_info.linkname = "../outside.mjs"
                archive.addfile(link_info)
            with self.assertRaisesRegex(SrcOverlayError, "unsupported"):
                load_src_snapshot(linked)

    def test_snapshot_rejects_local_symlinks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-snapshot-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            outside = root / "outside.mjs"
            outside.write_bytes(b"outside")
            try:
                (repo_src / "linked.mjs").symlink_to(outside)
            except OSError as exc:
                self.skipTest(f"symlinks unavailable: {exc}")
            with self.assertRaisesRegex(SrcOverlayError, "symlink"):
                self.build(repo_src, root / "rejected.tar")

    @unittest.skipIf(os.name == "nt", "Windows does not preserve POSIX execute bits")
    def test_snapshot_preserves_executable_mode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-mode-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            executable = repo_src / "tool.mjs"
            executable.write_bytes(b"#!/usr/bin/env node\n")
            executable.chmod(0o755)
            snapshot = self.build(repo_src, root / "snapshot.tar")
            extracted = self.extract(snapshot, root / "extracted")
            self.assertEqual(os.lstat(extracted / "tool.mjs").st_mode & 0o777, 0o755)

    def test_windows_uses_git_only_for_tracked_modes_not_file_selection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-windows-mode-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            (root / ".git").mkdir()
            (repo_src / "cli.mjs").write_bytes(b"#!/usr/bin/env node\n")
            (repo_src / "tracked-tool.mjs").write_bytes(b"tracked")
            (repo_src / "untracked-local.mjs").write_bytes(b"untracked")
            git_result = subprocess.CompletedProcess(
                [],
                0,
                (
                    b"100755 deadbeef 0\tsrc/tracked-tool.mjs\0"
                    b"100644 deadbeef 0\tsrc/locally-deleted.mjs\0"
                ),
                b"",
            )
            with (
                mock.patch("harness.src_overlay.os.name", "nt"),
                mock.patch(
                    "harness.src_overlay.subprocess.run", return_value=git_result
                ) as git,
            ):
                snapshot = self.build(repo_src, root / "snapshot.tar")

            with tarfile.open(snapshot.archive_path, "r:") as archive:
                members = {member.name: member for member in archive.getmembers()}
            self.assertEqual(members["src/cli.mjs"].mode, 0o755)
            self.assertEqual(members["src/tracked-tool.mjs"].mode, 0o755)
            self.assertEqual(members["src/untracked-local.mjs"].mode, 0o644)
            self.assertNotIn("src/locally-deleted.mjs", members)
            self.assertEqual(git.call_count, 1)
            self.assertIn("ls-files", git.call_args.args[0])


class AdapterRunEnvironmentTests(unittest.TestCase):
    @staticmethod
    def load_adapter_module():
        module_names = (
            "harbor",
            "harbor.agents",
            "harbor.agents.installed",
            "harbor.agents.installed.base",
            "harbor.environments",
            "harbor.environments.base",
            "harbor.models",
            "harbor.models.agent",
            "harbor.models.agent.context",
        )
        stubs = {name: types.ModuleType(name) for name in module_names}
        for name in module_names:
            if name not in {
                "harbor.agents.installed.base",
                "harbor.environments.base",
                "harbor.models.agent.context",
            }:
                stubs[name].__path__ = []

        class BaseInstalledAgent:
            pass

        class NonZeroAgentExitCodeError(RuntimeError):
            pass

        stubs["harbor.agents.installed.base"].BaseInstalledAgent = BaseInstalledAgent
        stubs[
            "harbor.agents.installed.base"
        ].NonZeroAgentExitCodeError = NonZeroAgentExitCodeError
        stubs["harbor.agents.installed.base"].with_prompt_template = lambda func: func
        stubs["harbor.environments.base"].BaseEnvironment = object
        stubs["harbor.models.agent.context"].AgentContext = object

        module_name = "harness.mixdog_agent"
        sys.modules.pop(module_name, None)
        with mock.patch.dict(sys.modules, stubs):
            module = importlib.import_module(module_name)
        sys.modules.pop(module_name, None)
        return module

    def test_adapter_fixes_workflow_to_headless(self) -> None:
        module = self.load_adapter_module()
        agent = module.MixdogAgent(workflow="solo")

        self.assertEqual(agent._workflow, "headless")
        self.assertFalse(hasattr(module, "HEADLESS_BENCH_MANDATE"))

    def test_version_probe_reads_package_metadata_without_booting_cli(self) -> None:
        module = self.load_adapter_module()
        command = module.MixdogAgent().get_version_command()

        self.assertIn("package.json", command)
        self.assertIn("fs.realpathSync", command)
        self.assertNotIn("mixdog --help", command)

    def test_installer_pins_package_version_unless_explicitly_overridden(self) -> None:
        module = self.load_adapter_module()
        commands = []
        pinned = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["version"]

        async def exec_as_root(environment, *, command, env=None):
            commands.append(command)

        default_agent = module.MixdogAgent()
        override_agent = module.MixdogAgent(mixdog_version="fixture")
        default_agent.exec_as_root = exec_as_root
        override_agent.exec_as_root = exec_as_root
        asyncio.run(default_agent.install(object()))
        asyncio.run(override_agent.install(object()))

        self.assertEqual(default_agent._mixdog_version, pinned)
        self.assertNotEqual(pinned.lower(), "latest")
        self.assertEqual(override_agent._mixdog_version, "fixture")
        npm_commands = [
            command for command in commands if "npm install -g" in command
        ]
        self.assertEqual(len(npm_commands), 2)
        self.assertIn(f"mixdog@{pinned}", npm_commands[0])
        self.assertIn("mixdog@fixture", npm_commands[1])

    @staticmethod
    async def capture_lead_env(module, profile, base_env, workflow="default"):
        captured = []

        class Environment:
            default_user = None

            async def upload_file(self, source, destination):
                return None

        agent = module.MixdogAgent(workflow=workflow)
        agent._route_profile = profile
        agent._provider = None
        agent._effort = None
        async def exec_as_root(environment, *, command, env=None):
            return None

        async def exec_as_agent(environment, *, command, env=None):
            captured.append(copy.deepcopy(env))

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        await agent._run_lead(Environment(), "adapter task", None, base_env)
        return captured[0]

    def test_headless_exec_uses_product_usage_contract(self) -> None:
        module = self.load_adapter_module()
        child_env = asyncio.run(
            self.capture_lead_env(
                module,
                None,
                {
                    "BASE_SENTINEL": "preserved",
                    "MIXDOG_USAGE_LOG": "/logs/agent/usage.json",
                },
            )
        )

        self.assertEqual(child_env["MIXDOG_USAGE_LOG"], "/logs/agent/usage.json")
        self.assertNotIn("MIXDOG_WORKFLOW", child_env)
        self.assertNotIn("MIXDOG_PROMPT", child_env)

    def test_profile_fallback_is_not_inlined_into_primary_attempt(self) -> None:
        module = self.load_adapter_module()
        fallback = {
            "provider": "openai-oauth",
            "model": "gpt-5.6-sol",
            "effort": "xhigh",
            "fast": True,
        }
        with_fallback = asyncio.run(
            self.capture_lead_env(
                module,
                {"routes": {}, "leadFallback": fallback},
                {"BASE_SENTINEL": "preserved"},
            )
        )
        without_fallback = asyncio.run(
            self.capture_lead_env(
                module,
                {"routes": {}},
                {"BASE_SENTINEL": "preserved"},
            )
        )

        self.assertNotIn("MIXDOG_LEAD_FALLBACK", with_fallback)
        self.assertNotIn("MIXDOG_LEAD_FALLBACK", without_fallback)

    def test_retry_attempt_keeps_configured_lead_route(self) -> None:
        module = self.load_adapter_module()
        fallback = {
            "provider": "openai-oauth",
            "model": "gpt-5.6-sol",
            "effort": "xhigh",
            "fast": True,
        }

        class Environment:
            session_id = "collision-safe-trial__AbC123"

        agent = module.MixdogAgent.__new__(module.MixdogAgent)
        agent.model_name = None
        agent._route_profile_name = "fixture"
        agent._route_profile = {"routes": {}, "leadFallback": fallback}
        agent._mode = "lead"
        calls = []

        async def inject(environment):
            return None

        async def run_lead(
            environment, instruction, model, base_env, *, lead_route=None
        ):
            calls.append(copy.deepcopy(lead_route))
            if len(calls) == 1:
                raise module.NonZeroAgentExitCodeError(
                    "Command failed (exit 86): fixture"
                )

        agent._inject_credentials = inject
        agent._run_lead = run_lead
        agent._populate_usage_context = mock.AsyncMock()
        with self.assertRaisesRegex(
            module.NonZeroAgentExitCodeError, "exit 86"
        ):
            asyncio.run(agent.run("task", Environment(), None))
        asyncio.run(agent.run("task", Environment(), None))
        self.assertEqual(calls, [None, None])

    def test_real_harbor_retry_queue_recreates_attempts_and_honors_exhaustion(
        self,
    ) -> None:
        try:
            from harbor.models.job.config import RetryConfig
            from harbor.trial.queue import TrialQueue
            from harbor.trial.trial import Trial
        except ImportError as exc:
            if os.environ.get("MIXDOG_HARBOR_QUEUE_CHILD") == "1":
                self.fail(f"Harbor tool interpreter cannot import its package: {exc}")
            uv_roots = (
                Path.home() / "AppData" / "Roaming" / "uv" / "tools" / "harbor",
                Path.home() / ".local" / "share" / "uv" / "tools" / "harbor",
                Path.home()
                / "Library"
                / "Application Support"
                / "uv"
                / "tools"
                / "harbor",
            )
            interpreters = [
                candidate
                for root in uv_roots
                for candidate in (
                    root / "Scripts" / "python.exe",
                    root / "bin" / "python",
                )
                if candidate.is_file()
            ]
            if not interpreters:
                self.skipTest("installed Harbor unavailable")
            child = subprocess.run(
                [
                    str(interpreters[0]),
                    "-m",
                    "unittest",
                    (
                        "harness.tests.test_routing_profiles."
                        "AdapterRunEnvironmentTests."
                        "test_real_harbor_retry_queue_recreates_attempts_and_honors_exhaustion"
                    ),
                ],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "PYTHONPATH": str(BENCH_ROOT),
                    "MIXDOG_HARBOR_QUEUE_CHILD": "1",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
            return

        module = self.load_adapter_module()
        fallback = {
            "provider": "openai-oauth",
            "model": "gpt-5.6-sol",
            "effort": "xhigh",
            "fast": True,
        }

        async def exercise_queue(state_root, session_id, failures, max_retries):
            routes = []
            trial_objects = []
            starting_budgets = []

            class Environment:
                default_user = None

                def __init__(self):
                    self.session_id = session_id

            class FakeTrial:
                def __init__(self, config, attempt):
                    self.paths = types.SimpleNamespace(
                        trial_dir=Path(state_root) / "deleted-trial-dir"
                    )
                    self.paths.trial_dir.mkdir(parents=True, exist_ok=True)
                    self.config = config
                    self.attempt = attempt
                    self.budget = 100

                def add_hook(self, event, hook):
                    return None

                async def run(self):
                    starting_budgets.append(self.budget)
                    agent = module.MixdogAgent.__new__(module.MixdogAgent)
                    agent.model_name = None
                    agent._route_profile_name = "fixture"
                    agent._route_profile = {
                        "routes": {},
                        "leadFallback": fallback,
                    }
                    agent._mode = "lead"
                    agent._provider = None
                    agent._effort = None
                    agent._workflow = "default"
                    agent._inject_credentials = mock.AsyncMock()
                    agent._populate_usage_context = mock.AsyncMock()

                    async def run_lead(
                        environment,
                        instruction,
                        model,
                        base_env,
                        *,
                        lead_route=None,
                    ):
                        routes.append(copy.deepcopy(lead_route))
                        self.budget = 0
                        if self.attempt < failures:
                            raise module.NonZeroAgentExitCodeError(
                                "Command failed (exit 86): queue fixture"
                            )

                    agent._run_lead = run_lead
                    try:
                        await agent.run("queue task", Environment(), None)
                    except module.NonZeroAgentExitCodeError as exc:
                        return types.SimpleNamespace(
                            exception_info=types.SimpleNamespace(
                                exception_type=type(exc).__name__
                            )
                        )
                    return types.SimpleNamespace(exception_info=None)

            async def create_trial(config):
                trial = FakeTrial(config, len(trial_objects))
                trial_objects.append(trial)
                return trial

            queue = TrialQueue(
                n_concurrent=1,
                retry_config=RetryConfig(
                    max_retries=max_retries,
                    min_wait_sec=0,
                    max_wait_sec=0,
                ),
            )
            config = types.SimpleNamespace(trial_name=session_id)
            with mock.patch.object(Trial, "create", side_effect=create_trial):
                result = await queue._execute_trial_with_retries(config)
            return result, routes, trial_objects, starting_budgets

        with tempfile.TemporaryDirectory(prefix="mixdog-real-queue-") as temp:
            root = Path(temp)
            success = asyncio.run(
                exercise_queue(root / "success", "queue-success", 1, 2)
            )
            result, routes, trials, budgets = success
            self.assertIsNone(result.exception_info)
            self.assertEqual(routes, [None, None])
            self.assertEqual(len({id(trial) for trial in trials}), 2)
            self.assertEqual(budgets, [100, 100])

            exhausted = asyncio.run(
                exercise_queue(root / "exhausted", "queue-exhausted", 99, 2)
            )
            result, routes, trials, budgets = exhausted
            self.assertEqual(
                result.exception_info.exception_type,
                "NonZeroAgentExitCodeError",
            )
            self.assertEqual(routes, [None, None, None])
            self.assertEqual(len(trials), 3)
            self.assertEqual(budgets, [100, 100, 100])

    def test_run_only_sets_credential_and_log_environment(self) -> None:
        module = self.load_adapter_module()

        class Environment:
            session_id = "refresh-test"

        agent = module.MixdogAgent.__new__(module.MixdogAgent)
        agent.model_name = None
        agent._route_profile_name = None
        agent._route_profile = None
        agent._mode = "lead"
        captured = []

        async def inject(environment):
            return None

        async def run_lead(
            environment, instruction, model, base_env, *, lead_route=None
        ):
            captured.append(base_env)

        agent._inject_credentials = inject
        agent._run_lead = run_lead
        with mock.patch.dict(
            os.environ,
            {
                "MIXDOG_OAI_TRANSPORT": "ws-delta",
                "MIXDOG_OPENAI_OAUTH_WS_WARMUP": "1",
                "MIXDOG_OAI_CODEX_WIRE_PARITY": "1",
                "MIXDOG_OAI_WS_DUMP_DIR": "/tmp/wire-dump",
            },
            clear=False,
        ):
            asyncio.run(agent.run("task", Environment(), None))

        self.assertEqual(
            captured[0]["MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED"], "1"
        )
        self.assertEqual(captured[0]["MIXDOG_USAGE_LOG"], "/logs/agent/usage.json")
        self.assertEqual(
            captured[0]["MIXDOG_SESSION_TRANSCRIPT_LOG"],
            "/logs/agent/session-transcript.json",
        )
        self.assertEqual(
            captured[0]["MIXDOG_AGENT_TRACE_PATH"],
            "/logs/agent/agent-trace.jsonl",
        )
        for key in (
            *module.PRISTINE_GUARD_ENV,
            "CI",
            "BASH_MAX_TIMEOUT_MS",
            "STALL_TIMEOUT_S",
            "MIXDOG_DISABLE_PROVIDER_WARMUP",
            "MIXDOG_DISABLE_MODEL_PREFETCH",
            "MIXDOG_DISABLE_MODEL_CATALOG_WARMUP",
            "MIXDOG_NONSTREAM_TOTAL_TIMEOUT_MS",
            "MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS",
            "MIXDOG_STALL_FIRST_BYTE_ABORT_S",
            "MIXDOG_CACHE_MESSAGES_TTL",
            "MIXDOG_OAI_TRANSPORT",
            "MIXDOG_OPENAI_OAUTH_WS_WARMUP",
            "MIXDOG_OAI_CODEX_WIRE_PARITY",
            "MIXDOG_OAI_WS_DUMP_DIR",
        ):
            self.assertNotIn(key, captured[0])

    def test_injection_is_allowlisted_and_emits_non_secret_pristine_audit(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-credential-inject-") as temp:
            data = Path(temp)
            host_credentials = data / "anthropic-oauth-credentials.json"
            host_bytes = b'{"claudeAiOauth":{"accessToken":"host-fixture"}}'
            snapshot_bytes = b'{"claudeAiOauth":{"accessToken":"snapshot-fixture"}}'
            src_snapshot = data / "src-snapshot.tar"
            src_snapshot.write_bytes(b"src-snapshot-fixture")
            host_credentials.write_bytes(host_bytes)
            (data / "openai-oauth.json").write_text(
                '{"access_token":"openai-fixture"}', encoding="utf-8"
            )
            (data / "anthropic-oauth-models.json").write_text(
                '{"models":[]}', encoding="utf-8"
            )
            (data / "openai-oauth-models.json").write_text(
                '{"models":[]}', encoding="utf-8"
            )
            personal_files = {
                "mixdog-config.json": '{"hostSecret":"must-not-copy"}',
                "grok-oauth.json": '{"access_token":"unselected"}',
                "profile.json": '{"title":"personal"}',
                "plugins/registry.json": '{"plugins":[]}',
                "sessions/personal.json": '{"messages":[]}',
                "memory/core.json": '{"memory":"personal"}',
                "channels/discord.json": '{"token":"personal"}',
            }
            for relative, content in personal_files.items():
                path = data / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            uploads = {}
            preflight_calls = []

            class Environment:
                default_user = None

                async def upload_file(self, source, destination):
                    uploads[destination] = Path(source).read_bytes()

            agent = module.MixdogAgent.__new__(module.MixdogAgent)
            agent._route_profile_name = "fable-xhigh"
            agent._route_profile = load_route_profile("fable-xhigh")
            agent._workflow = "default"
            agent._mode = "lead"

            async def exec_as_root(environment, *, command, env=None):
                return None

            async def inject_src_snapshot(environment, upload=True):
                return None

            agent.exec_as_root = exec_as_root
            agent._inject_src_snapshot = inject_src_snapshot
            agent._load_src_snapshot = lambda: types.SimpleNamespace(
                archive_path=src_snapshot
            )

            def fake_preflight(source, snapshot):
                preflight_calls.append(source)
                snapshot.write_bytes(snapshot_bytes)

            with (
                mock.patch.dict(
                    os.environ,
                    {
                        "MIXDOG_DATA_DIR": str(data),
                        "ANTHROPIC_OAUTH_CREDENTIALS_PATH": str(host_credentials),
                    },
                    clear=False,
                ),
                mock.patch.object(
                    module, "_run_anthropic_preflight", side_effect=fake_preflight
                ),
            ):
                asyncio.run(agent._inject_credentials(Environment()))

            self.assertEqual(preflight_calls, [host_credentials])
            self.assertEqual(
                uploads[module.CONTAINER_CREDS_PATH], snapshot_bytes
            )
            self.assertEqual(host_credentials.read_bytes(), host_bytes)
            uploaded_names = {
                Path(destination).name for destination in uploads
            }
            self.assertEqual(
                uploaded_names,
                {
                    "mixdog-config.json",
                    "anthropic-oauth-credentials.json",
                    "openai-oauth.json",
                    "anthropic-oauth-models.json",
                    "openai-oauth-models.json",
                    module.PERSONAL_STATE_AUDIT_NAME,
                    "src-snapshot.tar",
                },
            )
            generated_config = json.loads(
                uploads[f"{module.CONTAINER_DATA_DIR}/mixdog-config.json"]
            )
            self.assertEqual(
                generated_config,
                build_benchmark_config(agent._route_profile, "default"),
            )
            self.assertNotIn("must-not-copy", json.dumps(generated_config))
            audit = json.loads(
                uploads[module.CONTAINER_PERSONAL_STATE_AUDIT]
            )
            self.assertEqual(audit["personalState"]["behavioralStateFilesCopied"], 0)
            self.assertFalse(audit["personalState"]["hostConfigRead"])
            self.assertTrue(
                all(value is False for value in audit["featuresEnabled"].values())
            )
            serialized_audit = json.dumps(audit)
            for secret in ("host-fixture", "snapshot-fixture", "openai-fixture"):
                self.assertNotIn(secret, serialized_audit)

    def test_worker_command_enforces_lease_derived_whole_run_timeout(self) -> None:
        module = self.load_adapter_module()
        captured = []
        agent = module.MixdogAgent.__new__(module.MixdogAgent)

        async def exec_as_agent(environment, *, command, env=None):
            captured.append((command, env))

        agent.exec_as_agent = exec_as_agent
        base_env = {"SENTINEL": "preserved"}
        worker_route = {
            "provider": "openai-oauth",
            "model": "gpt-worker",
            "effort": "high",
            "fast": True,
        }
        asyncio.run(
            agent._run_worker(
                object(),
                "- fixture instruction",
                "fixture-model",
                base_env,
                worker_route=worker_route,
            )
        )

        command, child_env = captured[0]
        self.assertIn(
            f"timeout --signal=TERM --kill-after={module.PROCESS_KILL_GRACE_S}s "
            f"{module.PROCESS_RUN_DEADLINE_S}s",
            command,
        )
        self.assertIn("GNU coreutils", command)
        self.assertIn("bash -o pipefail -c", command)
        self.assertIn("whole-process deadline exceeded", command)
        self.assertIn("process group terminated before OAuth lease expiry", command)
        self.assertIn('exit "$status"', command)
        self.assertIn(
            "mixdog exec --json --provider openai-oauth --model gpt-worker --effort high --fast",
            command,
        )
        self.assertLess(command.index("-- "), command.index("- fixture instruction"))
        self.assertIn("/logs/agent/mixdog.stderr", command)
        self.assertEqual(child_env, base_env)

    def test_usage_totals_populate_supported_harbor_context_fields(self) -> None:
        module = self.load_adapter_module()
        agent = module.MixdogAgent.__new__(module.MixdogAgent)

        class Result:
            return_code = 0
            stdout = json.dumps(
                {
                    "totals": {
                        "inputTokens": 123,
                        "cacheTokens": 45,
                        "outputTokens": 67,
                    }
                }
            )

        class Environment:
            async def exec(self, *, command):
                self.command = command
                return Result()

        class Context:
            n_input_tokens = None
            n_cache_tokens = None
            n_output_tokens = None

        environment = Environment()
        context = Context()
        asyncio.run(agent._populate_usage_context(environment, context))
        self.assertEqual(environment.command, "cat /logs/agent/usage.json")
        self.assertEqual(
            (context.n_input_tokens, context.n_cache_tokens, context.n_output_tokens),
            (123, 45, 67),
        )

    def test_installer_guarantees_gnu_timeout_on_every_package_manager_path(self) -> None:
        module = self.load_adapter_module()
        commands = []
        agent = module.MixdogAgent.__new__(module.MixdogAgent)
        agent._mixdog_version = "fixture"

        async def exec_as_root(environment, *, command, env=None):
            commands.append(command)

        agent.exec_as_root = exec_as_root
        with mock.patch.object(module, "DEFAULT_PREBAKE_TAR", Path("__missing_prebake__")):
            asyncio.run(agent.install(object()))

        dependency_command = commands[0]
        self.assertIn("apt-get install -y curl ca-certificates coreutils", dependency_command)
        self.assertIn("apk add --no-cache curl bash coreutils", dependency_command)
        self.assertIn("yum install -y nodejs coreutils", dependency_command)
        self.assertIn("timeout --version | grep -q 'GNU coreutils'", dependency_command)

    def test_installer_runs_uv_provisioning_as_a_separate_best_effort_step(self) -> None:
        module = self.load_adapter_module()
        commands = []
        agent = module.MixdogAgent.__new__(module.MixdogAgent)
        agent._mixdog_version = "fixture"

        async def exec_as_root(environment, *, command, env=None):
            commands.append(command)

        agent.exec_as_root = exec_as_root
        with mock.patch.object(module, "DEFAULT_PREBAKE_TAR", Path("__missing_prebake__")):
            asyncio.run(agent.install(object()))

        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[1], module._uv_provision_command())

    def test_prebake_fast_path_skips_redundant_uv_provision_exec(self) -> None:
        module = self.load_adapter_module()
        commands = []

        class Environment:
            async def upload_file(self, source, destination):
                return None

        async def exec_as_root(environment, *, command, env=None):
            commands.append(command)
            if "command -v apt-get" in command:
                return types.SimpleNamespace(stdout="apt\n")
            if "MIXDOG_PREBAKE_UV_READY" in command:
                return types.SimpleNamespace(
                    stdout="MIXDOG_PREBAKE_UV_READY\nCURL_READY\n"
                )
            return types.SimpleNamespace(stdout="")

        with tempfile.TemporaryDirectory(prefix="mixdog-prebake-fast-path-") as temp:
            tar_path = Path(temp) / "mixdog-node-prebake.tar.gz"
            tar_path.touch()
            tar_path.with_name("mixdog-node-prebake.tar.zst").touch()
            tar_path.with_name("zstd-amd64").touch()
            agent = module.MixdogAgent.__new__(module.MixdogAgent)
            agent._mixdog_version = "fixture"
            agent.exec_as_root = exec_as_root
            with mock.patch.object(module, "DEFAULT_PREBAKE_TAR", tar_path):
                asyncio.run(agent.install(Environment()))

        self.assertFalse(
            any(command == module._uv_provision_command() for command in commands)
        )
        self.assertTrue(
            any("MIXDOG_PREBAKE_UV_READY" in command for command in commands)
        )
        self.assertTrue(
            any("prebake mixdog version" in command for command in commands)
        )

    def _run_uv_provision_fixture(
        self,
        *,
        retry_all_errors: bool,
        failures_before_success: int,
        existing_uv: bool = False,
        matching_uvx: bool = True,
    ):
        shell_candidates = [
            shutil.which("bash"),
            shutil.which("sh"),
            str(Path(os.environ.get("ProgramFiles", "")) / "Git" / "bin" / "bash.exe"),
            str(
                Path(os.environ.get("LOCALAPPDATA", ""))
                / "Programs"
                / "Git"
                / "bin"
                / "bash.exe"
            ),
        ]
        shell = None
        for candidate in dict.fromkeys(shell_candidates):
            if not candidate or not Path(candidate).is_file():
                continue
            probe = subprocess.run(
                [candidate, "-c", "exit 0"],
                capture_output=True,
                timeout=5,
            )
            if probe.returncode == 0:
                shell = candidate
                break
        if shell is None:
            self.skipTest("working POSIX shell unavailable")
        module = self.load_adapter_module()
        temp = tempfile.TemporaryDirectory(prefix="mixdog-uv-provision-")
        root = Path(temp.name)
        home = root / "home"
        uv_bin = home / ".local" / "bin"
        fake_bin = root / "fake-bin"
        fake_bin.mkdir(parents=True)
        log = root / "curl.log"
        curl = fake_bin / "curl"
        curl.write_text(
            """#!/bin/sh
if [ "$1 $2" = "--retry-all-errors --version" ]; then
  if [ "$SUPPORT_RETRY_ALL" = "1" ]; then echo "curl fixture"; exit 0; fi
  exit 2
fi
printf '%s\n' "$*" >> "$CURL_LOG"
count=0
if [ -f "$CURL_COUNT" ]; then count=$(cat "$CURL_COUNT"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$CURL_COUNT"
if [ "$CURL_FAILURES" -lt 0 ] || [ "$count" -le "$CURL_FAILURES" ]; then exit 6; fi
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output=$1; break; fi
  shift
done
cat > "$output" <<'INSTALLER'
#!/bin/sh
mkdir -p "$UV_INSTALL_DIR"
printf '%s\n' '#!/bin/sh' "echo 'uv 0.9.5'" > "$UV_INSTALL_DIR/uv"
printf '%s\n' '#!/bin/sh' "echo 'uvx 0.9.5'" > "$UV_INSTALL_DIR/uvx"
chmod +x "$UV_INSTALL_DIR/uv" "$UV_INSTALL_DIR/uvx"
INSTALLER
""",
            encoding="utf-8",
        )
        curl.chmod(0o755)
        if existing_uv:
            uv_bin.mkdir(parents=True)
            (uv_bin / "uv").write_text(
                "#!/bin/sh\necho 'uv 0.9.5'\n", encoding="utf-8"
            )
            (uv_bin / "uvx").write_text(
                "#!/bin/sh\necho 'uvx 0.9.5'\n"
                if matching_uvx
                else "#!/bin/sh\necho 'uvx 0.8.0'\n",
                encoding="utf-8",
            )
            (uv_bin / "uv").chmod(0o755)
            (uv_bin / "uvx").chmod(0o755)
        result = subprocess.run(
            [
                shell,
                "-e",
                "-c",
                module._uv_provision_command(
                    home.as_posix(), curl.as_posix()
                ),
            ],
            env={
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ.get("PATH", ""),
                "SUPPORT_RETRY_ALL": "1" if retry_all_errors else "0",
                "CURL_FAILURES": str(failures_before_success),
                "CURL_LOG": str(log),
                "CURL_COUNT": str(root / "curl.count"),
            },
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        return temp, home, log, result

    def test_uv_provision_network_failure_is_nonfatal(self) -> None:
        temp, home, log, result = self._run_uv_provision_fixture(
            retry_all_errors=True, failures_before_success=-1
        )
        with temp:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("pre-provisioning unavailable", result.stderr)
            self.assertFalse((home / ".local" / "bin" / "uv").exists())
            self.assertEqual(
                len(log.read_text(encoding="utf-8").splitlines()),
                self.load_adapter_module().UV_BOOTSTRAP_ATTEMPTS,
            )
            self.assertIn(
                "retry-all-errors",
                (home / ".curlrc").read_text(encoding="utf-8"),
            )

    def test_uv_provision_old_curl_retries_transient_nonzero_and_recovers(self) -> None:
        temp, home, log, result = self._run_uv_provision_fixture(
            retry_all_errors=False, failures_before_success=2
        )
        with temp:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(
                "retry-all-errors",
                (home / ".curlrc").read_text(encoding="utf-8"),
            )
            self.assertNotIn(
                "--retry-all-errors", log.read_text(encoding="utf-8")
            )
            self.assertEqual(len(log.read_text(encoding="utf-8").splitlines()), 3)
            self.assertEqual(
                (home / ".local" / "bin" / "uv").read_text(encoding="utf-8"),
                "#!/bin/sh\necho 'uv 0.9.5'\n",
            )
            self.assertEqual(
                (home / ".local" / "bin" / "uvx").read_text(encoding="utf-8"),
                "#!/bin/sh\necho 'uvx 0.9.5'\n",
            )

    def test_uv_provision_rejects_stale_uvx_as_offline_installation(self) -> None:
        temp, home, log, result = self._run_uv_provision_fixture(
            retry_all_errors=False,
            failures_before_success=-1,
            existing_uv=True,
            matching_uvx=False,
        )
        with temp:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("already available", result.stdout)
            self.assertNotIn("provisioned", result.stdout)
            self.assertEqual(
                len(log.read_text(encoding="utf-8").splitlines()),
                self.load_adapter_module().UV_BOOTSTRAP_ATTEMPTS,
            )
            self.assertFalse((home / ".local" / "bin" / "uvx").exists())

    def test_uv_provision_reuses_correct_installation_offline(self) -> None:
        temp, home, log, result = self._run_uv_provision_fixture(
            retry_all_errors=True,
            failures_before_success=-1,
            existing_uv=True,
        )
        with temp:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("already available", result.stdout)
            self.assertFalse(log.exists(), "offline reuse must not request installer")
            self.assertEqual(
                (home / ".local" / "bin" / "uv").read_text(encoding="utf-8"),
                "#!/bin/sh\necho 'uv 0.9.5'\n",
            )

    def test_lead_command_uses_the_same_os_process_group_boundary(self) -> None:
        module = self.load_adapter_module()
        captured = []

        class Environment:
            default_user = None

            async def upload_file(self, source, destination):
                return None

        agent = module.MixdogAgent.__new__(module.MixdogAgent)
        agent._route_profile = None
        agent._provider = None
        agent._effort = None
        agent._workflow = "default"

        async def exec_as_root(environment, *, command, env=None):
            return None

        async def exec_as_agent(environment, *, command, env=None):
            captured.append((command, env))

        agent.exec_as_root = exec_as_root
        agent.exec_as_agent = exec_as_agent
        asyncio.run(
            agent._run_lead(Environment(), "- fixture", None, {"BASE": "value"})
        )

        command, run_env = captured[0]
        self.assertIn(
            f"timeout --signal=TERM --kill-after={module.PROCESS_KILL_GRACE_S}s "
            f"{module.PROCESS_RUN_DEADLINE_S}s",
            command,
        )
        self.assertIn("GNU coreutils", command)
        self.assertIn("mixdog exec --json --provider anthropic-oauth", command)
        self.assertIn("--model claude-sonnet-4-5", command)
        self.assertIn("/logs/agent/mixdog.stderr", command)
        self.assertNotIn("termination_reason", command)
        self.assertNotIn("exit(86)", command)
        self.assertLess(command.index("-- "), command.index("- fixture"))
        self.assertNotIn("MIXDOG_PROMPT", run_env)
        self.assertNotIn("MIXDOG_WORKFLOW", run_env)

    @unittest.skipUnless(
        os.environ.get("MIXDOG_RUN_CONTAINER_PROBE") == "1",
        "set MIXDOG_RUN_CONTAINER_PROBE=1 for disposable Linux probe",
    )
    def test_alpine_gnu_timeout_kills_lead_setup_and_worker_process_trees(self) -> None:
        docker = shutil.which("docker")
        if docker is None:
            self.skipTest("Docker is unavailable")
        module = self.load_adapter_module()
        lead_command = module._bounded_process_command(
            "bash -c 'sleep 300 & echo $! > /tmp/lead-setup-child.pid; wait'",
            "lead",
            deadline_s=1,
            kill_grace_s=1,
        )
        worker_command = module._bounded_process_command(
            "bash -c 'sleep 300 & echo $! > /tmp/worker-child.pid; wait'",
            "worker",
            deadline_s=1,
            kill_grace_s=1,
        )
        busybox_command = module._bounded_process_command(
            "true", "busybox-probe", deadline_s=1, kill_grace_s=1
        )
        script = (
            "set -eu; apk add --no-cache bash coreutils >/dev/null; "
            "mkdir -p /tmp/busybox-bin; "
            "ln -s /bin/busybox /tmp/busybox-bin/timeout; set +e; "
            f"(PATH=/tmp/busybox-bin:/usr/bin:/bin; {busybox_command}); "
            "busybox_status=$?; "
            f"({lead_command}); lead_status=$?; "
            f"({worker_command}); worker_status=$?; set -e; "
            'test "$busybox_status" -eq 125; '
            'test "$lead_status" -eq 124; test "$worker_status" -eq 124; '
            "sleep 0.2; "
            'lead_pid="$(cat /tmp/lead-setup-child.pid)"; '
            'worker_pid="$(cat /tmp/worker-child.pid)"; '
            'if kill -0 "$lead_pid" 2>/dev/null; then exit 91; fi; '
            'if kill -0 "$worker_pid" 2>/dev/null; then exit 92; fi'
        )
        result = subprocess.run(
            [docker, "run", "--rm", "alpine:3.20", "sh", "-c", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_src_snapshot_uploads_once_and_replaces_installed_src_whole(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-src-upload-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            (repo_src / "kept.mjs").write_bytes(b"local")
            spawn = root / "mixdog-spawn"
            spawn.write_bytes(b"current native spawn")
            spawn.chmod(0o755)
            snapshot = build_src_snapshot(repo_src, root / "snapshot.tar", spawn)
            uploads = []
            commands = []

            class Environment:
                async def upload_file(self, source, destination):
                    uploads.append((Path(source), destination))

            agent = module.MixdogAgent.__new__(module.MixdogAgent)

            async def exec_as_root(environment, *, command, env=None):
                commands.append(command)

            agent.exec_as_root = exec_as_root
            with mock.patch.dict(os.environ, {SNAPSHOT_ENV: str(snapshot.archive_path)}):
                asyncio.run(agent._inject_src_snapshot(Environment()))

        self.assertEqual(
            uploads,
            [(snapshot.archive_path, module.CONTAINER_SRC_SNAPSHOT)],
        )
        self.assertEqual(len(commands), 1)
        self.assertIn('readlink -f "$(command -v mixdog)"', commands[0])
        self.assertNotIn("npm root -g", commands[0])
        self.assertIn("trap cleanup_runtime_swap EXIT", commands[0])
        self.assertIn("trap 'exit 1' HUP INT TERM", commands[0])
        self.assertIn('mv "$PACKAGE/src" "$BACKUP"', commands[0])
        self.assertIn('mv "$STAGING/src" "$PACKAGE/src"', commands[0])
        self.assertIn('mv "$BACKUP" "$PACKAGE/src"', commands[0])
        self.assertIn('"$STAGING/native-tools/mixdog-spawn"', commands[0])
        self.assertIn("trackedForeground promoteTask cancelOwner", commands[0])
        self.assertIn('rm -rf "$BACKUP" "$STAGING"', commands[0])
        self.assertIn(
            'rm -rf "$PACKAGE/src"; mv "$BACKUP" "$PACKAGE/src"',
            commands[0],
        )
        self.assertNotIn("manifest", commands[0])
        self.assertNotIn("src_overlay_apply", commands[0])

    def test_harness_snapshot_file_is_digest_pinned(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-harness-snapshot-") as temp:
            root = Path(temp)
            artifact = root / "anthropic_oauth_preflight.mjs"
            artifact.write_bytes(b"const frozen = true;\n")
            manifest = {
                artifact.name: hashlib.sha256(artifact.read_bytes()).hexdigest()
            }
            with mock.patch.dict(
                os.environ,
                {
                    module.HARNESS_SNAPSHOT_ENV: str(root),
                    module.HARNESS_SNAPSHOT_MANIFEST_ENV: json.dumps(manifest),
                },
                clear=False,
            ):
                self.assertEqual(module._harness_snapshot_file(artifact.name), artifact)
                artifact.write_bytes(b"const mutated = true;\n")
                with self.assertRaisesRegex(RuntimeError, "digest mismatch"):
                    module._harness_snapshot_file(artifact.name)


class LauncherDryRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.powershell = shutil.which("pwsh") or shutil.which("powershell")
        if cls.powershell is None:
            raise unittest.SkipTest("PowerShell is not installed")
        cls.script = HARNESS_ROOT / "run-tb21.ps1"

    def run_launcher(
        self, *args: str, script: Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                self.powershell,
                "-NoProfile",
                "-NonInteractive",
                "-File",
                str(script or self.script),
                "-JobsDir",
                "route-profile-dry-run",
                "-DryRun",
                *args,
            ],
            cwd=BENCH_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def test_profile_dry_run_generates_auditable_command(self) -> None:
        result = self.run_launcher("-RouteProfile", "fable-xhigh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], EXPECTED_AUDIT_LINE)
        self.assertIn("--ak route_profile=fable-xhigh", result.stdout)
        self.assertNotIn("--ak workflow=", result.stdout)
        self.assertNotIn("--verifier-env", result.stdout)

    def test_launcher_rejects_unknown_profile_and_conflicts(self) -> None:
        unknown = self.run_launcher("-RouteProfile", "unknown")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("Unknown RouteProfile", unknown.stderr)
        conflict = self.run_launcher(
            "-RouteProfile",
            "fable-xhigh",
            "-Provider",
            "openai-oauth",
            "-Model",
            "gpt-5.6-sol",
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("cannot be combined", conflict.stderr)

    def test_launcher_fully_validates_selected_profile_before_preflight(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-launcher-validation-") as temp:
            harness = Path(temp) / "harness"
            harness.mkdir()
            script = harness / "run-tb21.ps1"
            shutil.copy2(self.script, script)
            shutil.copy2(HARNESS_ROOT / "routing_profiles.py", harness)
            malformed = copy.deepcopy(
                json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
            )
            malformed["profiles"]["fable-high"]["routes"]["worker"]["fast"] = "true"
            (harness / "route_profiles.json").write_text(
                json.dumps(malformed), encoding="utf-8"
            )

            result = self.run_launcher(
                "-RouteProfile", "fable-high", script=script
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fast must be boolean", result.stderr)
        self.assertNotIn("Terminal-Bench src overlay preflight", result.stderr)

    def test_launcher_propagates_native_harbor_exit_and_cleans_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-launcher-native-") as temp:
            root = Path(temp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            capture = root / "state-paths.txt"
            if os.name == "nt":
                (bin_dir / "python.cmd").write_text(
                    "@exit /b 0\n", encoding="utf-8"
                )
                (bin_dir / "harbor.cmd").write_text(
                    "@mkdir \"%MIXDOG_TB_SRC_SNAPSHOT%\"\n"
                    f"@echo %MIXDOG_TB_SRC_SNAPSHOT%>\"{capture}\"\n"
                    f"@echo %MIXDOG_TB_HARNESS_SNAPSHOT%>>\"{capture}\"\n"
                    "@exit /b 37\n",
                    encoding="utf-8",
                )
            else:
                (bin_dir / "python").write_text(
                    "#!/bin/sh\nexit 0\n", encoding="utf-8"
                )
                (bin_dir / "harbor").write_text(
                    "#!/bin/sh\n"
                    'mkdir -p "$MIXDOG_TB_SRC_SNAPSHOT" '
                    '"$MIXDOG_TB_HARNESS_SNAPSHOT"\n'
                    f'printf "%s\\n%s\\n" "$MIXDOG_TB_SRC_SNAPSHOT" '
                    f'"$MIXDOG_TB_HARNESS_SNAPSHOT" > "{capture}"\n'
                    "exit 37\n",
                    encoding="utf-8",
                )
                (bin_dir / "python").chmod(0o755)
                (bin_dir / "harbor").chmod(0o755)

            result = subprocess.run(
                [
                    self.powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(self.script),
                    "-JobsDir",
                    "native-exit-fixture",
                ],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            state_paths = [
                Path(line.strip())
                for line in capture.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertEqual(len(state_paths), 2)
        self.assertTrue(all(not path.exists() for path in state_paths))


if __name__ == "__main__":
    unittest.main()
