from __future__ import annotations

import ast
import asyncio
import copy
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
    merge_route_profile,
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
    "debugger=openai-oauth/gpt-5.6-sol effort=max fast=true; "
    "explorer=openai-oauth/gpt-5.6-luna effort=low fast=true"
)
HEADLESS_BENCH_MANDATE = (
    "[Headless bench run: no user is present. The user has pre-approved every stage of this task in advance - treat each plan, decision, and step as already approved, ask nothing, never end a turn waiting for a reply, and carry the task through to verified completion or a provable block. All other workflow rules, including delegation and review, apply unchanged.]\n\n"
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
  explorer: 'explore',
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
        validated = validate_profile_document(self.document)
        self.assertEqual(
            set(validated["profiles"]),
            {
                "opus-xhigh",
                "sol-xhigh",
                "fable-xhigh",
                "fable-opus-heavy-xhigh",
                "fable-sol-heavy-opus-reviewer-xhigh",
                "fable-opus-heavy-sol-reviewer-xhigh",
                "fable-high",
                "fable-sol-workers-xhigh",
                "fable-opus-workers-xhigh",
            },
        )
        profile = load_route_profile("fable-xhigh")
        self.assertEqual(tuple(profile["routes"]), PROFILE_ROLES)
        self.assertEqual(
            profile["leadFallback"],
            {
                "provider": "anthropic-oauth",
                "model": "claude-opus-4-8",
                "effort": "xhigh",
                "fast": False,
            },
        )
        self.assertEqual(
            profile["routes"],
            {
                "lead": {
                    "provider": "anthropic-oauth",
                    "model": "claude-fable-5",
                    "effort": "xhigh",
                    "fast": False,
                },
                "worker": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-terra",
                    "effort": "high",
                    "fast": True,
                },
                "heavy-worker": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-sol",
                    "effort": "xhigh",
                    "fast": True,
                },
                "reviewer": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-sol",
                    "effort": "xhigh",
                    "fast": True,
                },
                "debugger": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-sol",
                    "effort": "max",
                    "fast": True,
                },
                "explorer": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-luna",
                    "effort": "low",
                    "fast": True,
                },
            },
        )
        fable_opus_heavy_profile = load_route_profile("fable-opus-heavy-xhigh")
        self.assertEqual(
            fable_opus_heavy_profile,
            {
                **profile,
                "routes": {
                    **profile["routes"],
                    "heavy-worker": {
                        "provider": "anthropic-oauth",
                        "model": "claude-opus-4-8",
                        "effort": "xhigh",
                        "fast": False,
                    },
                },
            },
        )
        fable_sol_heavy_opus_reviewer_profile = load_route_profile(
            "fable-sol-heavy-opus-reviewer-xhigh"
        )
        self.assertEqual(
            fable_sol_heavy_opus_reviewer_profile,
            {
                **profile,
                "routes": {
                    **profile["routes"],
                    "reviewer": {
                        "provider": "anthropic-oauth",
                        "model": "claude-opus-4-8",
                        "effort": "xhigh",
                        "fast": False,
                    },
                },
            },
        )
        fable_opus_heavy_sol_reviewer_profile = load_route_profile(
            "fable-opus-heavy-sol-reviewer-xhigh"
        )
        self.assertEqual(
            fable_opus_heavy_sol_reviewer_profile,
            {
                **profile,
                "routes": {
                    **profile["routes"],
                    "heavy-worker": {
                        "provider": "anthropic-oauth",
                        "model": "claude-opus-4-8",
                        "effort": "xhigh",
                        "fast": False,
                    },
                },
            },
        )
        opus_profile = load_route_profile("opus-xhigh")
        self.assertEqual(
            opus_profile,
            {
                "leadFallback": {
                    "provider": "anthropic-oauth",
                    "model": "claude-opus-4-8",
                    "effort": "xhigh",
                    "fast": False,
                },
                "routes": {
                    "lead": {
                        "provider": "anthropic-oauth",
                        "model": "claude-opus-4-8",
                        "effort": "xhigh",
                        "fast": False,
                    },
                    "worker": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-terra",
                        "effort": "high",
                        "fast": True,
                    },
                    "heavy-worker": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    },
                    "reviewer": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    },
                    "debugger": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "max",
                        "fast": True,
                    },
                    "explorer": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-luna",
                        "effort": "low",
                        "fast": True,
                    },
                },
            },
        )
        fable_high_profile = load_route_profile("fable-high")
        self.assertEqual(
            fable_high_profile,
            {
                "leadFallback": {
                    "provider": "anthropic-oauth",
                    "model": "claude-opus-4-8",
                    "effort": "xhigh",
                    "fast": False,
                },
                "routes": {
                    "lead": {
                        "provider": "anthropic-oauth",
                        "model": "claude-fable-5",
                        "effort": "high",
                        "fast": False,
                    },
                    "worker": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-terra",
                        "effort": "high",
                        "fast": True,
                    },
                    "heavy-worker": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "high",
                        "fast": True,
                    },
                    "reviewer": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    },
                    "debugger": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "max",
                        "fast": True,
                    },
                    "explorer": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-luna",
                        "effort": "low",
                        "fast": True,
                    },
                },
            },
        )
        fable_sol_workers_profile = load_route_profile("fable-sol-workers-xhigh")
        self.assertEqual(
            fable_sol_workers_profile,
            {
                **profile,
                "routes": {
                    **profile["routes"],
                    "worker": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    },
                    "heavy-worker": {
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    },
                },
            },
        )
        fable_opus_workers_profile = load_route_profile("fable-opus-workers-xhigh")
        self.assertEqual(
            fable_opus_workers_profile,
            {
                **profile,
                "routes": {
                    **profile["routes"],
                    "worker": {
                        "provider": "anthropic-oauth",
                        "model": "claude-opus-4-8",
                        "effort": "xhigh",
                        "fast": False,
                    },
                    "heavy-worker": {
                        "provider": "anthropic-oauth",
                        "model": "claude-opus-4-8",
                        "effort": "xhigh",
                        "fast": False,
                    },
                },
            },
        )
        # The two Worker-model comparison profiles differ ONLY in the worker
        # and heavy-worker routes; every other route stays identical, and each
        # profile drives its worker and heavy-worker with the same model.
        self.assertEqual(
            {
                role: fable_sol_workers_profile["routes"][role]
                for role in PROFILE_ROLES
                if role not in ("worker", "heavy-worker")
            },
            {
                role: fable_opus_workers_profile["routes"][role]
                for role in PROFILE_ROLES
                if role not in ("worker", "heavy-worker")
            },
        )
        self.assertEqual(
            fable_sol_workers_profile["routes"]["worker"],
            fable_sol_workers_profile["routes"]["heavy-worker"],
        )
        self.assertEqual(
            fable_opus_workers_profile["routes"]["worker"],
            fable_opus_workers_profile["routes"]["heavy-worker"],
        )
        sol_profile = load_route_profile("sol-xhigh")
        self.assertEqual(tuple(sol_profile["routes"]), PROFILE_ROLES)
        self.assertNotIn("leadFallback", sol_profile)
        self.assertEqual(
            sol_profile["routes"],
            {
                **opus_profile["routes"],
                "lead": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-sol",
                    "effort": "xhigh",
                    "fast": True,
                },
            },
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
        del missing_role["profiles"]["fable-xhigh"]["routes"]["reviewer"]
        cases.append(missing_role)
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

    def test_merge_replaces_exact_role_routes_without_mutating_host(self) -> None:
        host = {
            "agent": {
                "workflowRoutes": {
                    "lead": {"provider": "old", "model": "old", "extra": "stale"},
                    "memory": {"provider": "keep", "model": "keep"},
                },
                "agents": {
                    "worker": {"provider": "old", "model": "old"},
                    "maintenance": {"provider": "keep", "model": "keep"},
                },
                "presets": [
                    {
                        "id": "host-lead",
                        "name": "HOST LEAD",
                        "provider": "host-provider",
                        "model": "host-model",
                        "effort": "high",
                        "fast": True,
                        "tools": "full",
                        "custom": "preserve",
                    },
                    {
                        "id": "unrelated",
                        "name": "UNRELATED",
                        "provider": "keep",
                        "model": "keep",
                    },
                ],
                "default": "host-lead",
                "modelSettings": {
                    "anthropic-oauth/claude-fable-5": {
                        "effort": "high",
                        "fast": True,
                        "temperature": 0.2,
                    },
                    "keep/keep": {"effort": "low"},
                },
            },
            "unrelated": {"keep": True},
        }
        original = copy.deepcopy(host)
        profile = load_route_profile("fable-xhigh")
        merged = merge_route_profile(host, profile)

        self.assertEqual(host, original)
        self.assertEqual(merged["agent"]["workflowRoutes"]["lead"], profile["routes"]["lead"])
        self.assertEqual(
            merged["agent"]["workflowRoutes"]["memory"],
            original["agent"]["workflowRoutes"]["memory"],
        )
        role_keys = {
            "worker": "worker",
            "heavy-worker": "heavy-worker",
            "reviewer": "reviewer",
            "debugger": "debugger",
            "explorer": "explore",
        }
        for role, key in role_keys.items():
            self.assertEqual(merged["agent"]["agents"][key], profile["routes"][role])
        self.assertEqual(
            merged["agent"]["agents"]["maintenance"],
            original["agent"]["agents"]["maintenance"],
        )
        self.assertEqual(merged["agent"]["default"], "host-lead")
        self.assertEqual(
            {
                key: merged["agent"]["presets"][0][key]
                for key in ("provider", "model", "effort", "fast")
            },
            profile["routes"]["lead"],
        )
        self.assertEqual(merged["agent"]["presets"][0]["custom"], "preserve")
        self.assertEqual(
            merged["agent"]["presets"][1], original["agent"]["presets"][1]
        )
        self.assertEqual(
            merged["agent"]["modelSettings"]["anthropic-oauth/claude-fable-5"],
            {"effort": "xhigh", "fast": False, "temperature": 0.2},
        )
        self.assertEqual(
            merged["agent"]["modelSettings"]["keep/keep"],
            original["agent"]["modelSettings"]["keep/keep"],
        )
        self.assertEqual(merged["unrelated"], original["unrelated"])

    def test_benchmark_config_contains_only_profile_routes_and_workflow(self) -> None:
        profile = load_route_profile("fable-xhigh")
        config = build_benchmark_config(profile, "default")
        agent = config["agent"]

        self.assertEqual(set(config), {"agent"})
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
            },
        )
        self.assertEqual(agent["workflow"], {"active": "default"})
        self.assertEqual(agent["mcpServers"], {})
        self.assertEqual(agent["workflowRoutes"], {"lead": profile["routes"]["lead"]})
        self.assertNotIn("memory", agent["workflowRoutes"])
        self.assertEqual(
            set(agent["providers"]), {"anthropic-oauth", "openai-oauth"}
        )
        serialized = json.dumps(config)
        for personal_key in (
            "profile",
            "plugins",
            "channels",
            "sessions",
            "memory",
            "outputStyle",
        ):
            self.assertNotIn(f'"{personal_key}"', serialized)

    def test_real_runtime_helpers_resolve_merged_lead_and_agent_routes(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        host = {
            "agent": {
                "providers": {
                    "anthropic-oauth": {"enabled": True},
                    "openai-oauth": {"enabled": True},
                },
                "presets": [
                    {
                        "id": "host-lead",
                        "name": "HOST LEAD",
                        "provider": "openai-oauth",
                        "model": "host-lead-model",
                        "effort": "high",
                        "fast": True,
                        "tools": "full",
                    },
                    {
                        "id": "unrelated",
                        "name": "UNRELATED",
                        "provider": "keep",
                        "model": "keep",
                    },
                ],
                "default": "host-lead",
                "workflowRoutes": {
                    "lead": {
                        "provider": "openai-oauth",
                        "model": "host-lead-model",
                        "effort": "high",
                        "fast": True,
                    },
                    "memory": {"provider": "keep", "model": "keep"},
                },
                "agents": {
                    role: {"provider": "host", "model": "host"}
                    for role in ("explore", "worker", "heavy-worker", "reviewer", "debugger")
                },
                "modelSettings": {
                    "anthropic-oauth/claude-fable-5": {
                        "effort": "high",
                        "fast": True,
                    }
                },
            }
        }
        profile = load_route_profile("fable-xhigh")
        merged = merge_route_profile(host, profile)
        self.assertEqual(host["agent"]["presets"][0]["model"], "host-lead-model")

        resolved = resolve_with_real_runtime(merged)
        self.assertEqual(resolved["runtimeLead"], profile["routes"]["lead"])
        self.assertEqual(resolved["defaultPreset"], profile["routes"]["lead"])
        self.assertEqual(resolved["workflowLead"], profile["routes"]["lead"])
        self.assertEqual(resolved["agents"], {
            role: profile["routes"][role]
            for role in ("worker", "heavy-worker", "reviewer", "debugger", "explorer")
        })

    def test_case_variant_id_name_collision_uses_runtime_first_match(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        host = {
            "agent": {
                "default": "HOST-LEAD",
                "presets": [
                    {
                        "id": "alias-before-id",
                        "name": "host-lead",
                        "provider": "stale",
                        "model": "stale-name-match",
                    },
                    {
                        "id": "HoSt-LeAd",
                        "name": "later-id-match",
                        "provider": "keep",
                        "model": "keep",
                    },
                ],
            }
        }
        original = copy.deepcopy(host)
        profile = load_route_profile("fable-xhigh")
        merged = merge_route_profile(host, profile)

        self.assertEqual(host, original)
        self.assertEqual(merged["agent"]["default"], "HOST-LEAD")
        self.assertEqual(merged["agent"]["presets"][0]["model"], "claude-fable-5")
        self.assertEqual(merged["agent"]["presets"][1], original["agent"]["presets"][1])
        resolved = resolve_with_real_runtime(merged)
        self.assertEqual(resolved["runtimeLead"], profile["routes"]["lead"])

    def test_unresolved_default_reuses_first_fallback_alias_without_shadowing(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        host = {
            "agent": {
                "default": "missing-host-default",
                "presets": [
                    {
                        "id": "stale-alias",
                        "name": "TERMINAL-BENCH-ROUTE-PROFILE-LEAD",
                        "provider": "stale",
                        "model": "stale-shadow",
                    },
                    {
                        "id": "Terminal-Bench-Route-Profile-Lead",
                        "name": "later-id-match",
                        "provider": "keep",
                        "model": "keep",
                    },
                ],
            }
        }
        original = copy.deepcopy(host)
        profile = load_route_profile("fable-xhigh")
        merged = merge_route_profile(host, profile)

        self.assertEqual(host, original)
        self.assertEqual(
            merged["agent"]["default"], "terminal-bench-route-profile-lead"
        )
        self.assertEqual(len(merged["agent"]["presets"]), 2)
        self.assertEqual(merged["agent"]["presets"][0]["model"], "claude-fable-5")
        self.assertEqual(merged["agent"]["presets"][1], original["agent"]["presets"][1])
        resolved = resolve_with_real_runtime(merged)
        self.assertEqual(resolved["runtimeLead"], profile["routes"]["lead"])

    def test_audit_log_is_stable_and_complete(self) -> None:
        line = format_resolved_routes("fable-xhigh", load_route_profile("fable-xhigh"))
        self.assertEqual(line, EXPECTED_AUDIT_LINE)

    def test_python_sources_parse(self) -> None:
        for path in (
            HARNESS_ROOT / "routing_profiles.py",
            HARNESS_ROOT / "mixdog_agent.py",
        ):
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

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
            snapshot = build_src_snapshot(repo_src, root / "snapshot.tar")

            (repo_src / "modified.mjs").write_bytes(b"later mutation")
            (repo_src / "untracked-addition.mjs").unlink()
            (repo_src / "later-addition.mjs").write_bytes(b"too late")

            loaded = load_src_snapshot(snapshot.archive_path)
            extracted = self.extract(loaded, root / "extracted")
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
            snapshot = build_src_snapshot(repo_src, root / "snapshot.tar")

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
                build_src_snapshot(repo_src, root / "rejected.tar")

    @unittest.skipIf(os.name == "nt", "Windows does not preserve POSIX execute bits")
    def test_snapshot_preserves_executable_mode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-mode-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            executable = repo_src / "tool.mjs"
            executable.write_bytes(b"#!/usr/bin/env node\n")
            executable.chmod(0o755)
            snapshot = build_src_snapshot(repo_src, root / "snapshot.tar")
            extracted = self.extract(snapshot, root / "extracted")
            self.assertEqual(os.lstat(extracted / "tool.mjs").st_mode & 0o777, 0o755)

    def test_windows_uses_git_only_for_tracked_modes_not_file_selection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-src-windows-mode-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            (root / ".git").mkdir()
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
                snapshot = build_src_snapshot(repo_src, root / "snapshot.tar")

            with tarfile.open(snapshot.archive_path, "r:") as archive:
                members = {member.name: member for member in archive.getmembers()}
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

    def test_adapter_defaults_to_stock_workflow_with_headless_mandate(self) -> None:
        module = self.load_adapter_module()
        agent = module.MixdogAgent()

        self.assertEqual(agent._workflow, "default")
        self.assertEqual(module.HEADLESS_BENCH_MANDATE, HEADLESS_BENCH_MANDATE)

    def test_installer_uses_repository_version_unless_explicitly_overridden(self) -> None:
        module = self.load_adapter_module()
        repository_version = json.loads(
            (REPO_ROOT / "package.json").read_text(encoding="utf-8")
        )["version"]
        commands = []

        async def exec_as_root(environment, *, command, env=None):
            commands.append(command)

        default_agent = module.MixdogAgent()
        override_agent = module.MixdogAgent(mixdog_version="fixture")
        default_agent.exec_as_root = exec_as_root
        override_agent.exec_as_root = exec_as_root
        asyncio.run(default_agent.install(object()))
        asyncio.run(override_agent.install(object()))

        self.assertEqual(default_agent._mixdog_version, repository_version)
        self.assertEqual(override_agent._mixdog_version, "fixture")
        npm_commands = [
            command for command in commands if "npm install -g" in command
        ]
        self.assertEqual(len(npm_commands), 2)
        self.assertIn(f"mixdog@{repository_version}", npm_commands[0])
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

    def test_default_workflow_preserves_headless_mandate(self) -> None:
        module = self.load_adapter_module()
        child_env = asyncio.run(
            self.capture_lead_env(
                module,
                None,
                {"BASE_SENTINEL": "preserved"},
            )
        )

        self.assertEqual(child_env["MIXDOG_WORKFLOW"], "default")
        self.assertEqual(
            child_env["MIXDOG_PROMPT"], HEADLESS_BENCH_MANDATE + "adapter task"
        )

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

    def test_retry_attempt_selects_fallback_and_success_clears_marker(self) -> None:
        module = self.load_adapter_module()
        fallback = {
            "provider": "openai-oauth",
            "model": "gpt-5.6-sol",
            "effort": "xhigh",
            "fast": True,
        }
        with tempfile.TemporaryDirectory(prefix="mixdog-fallback-state-") as temp:
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
            with mock.patch.dict(
                os.environ, {module.FALLBACK_STATE_ENV: temp}, clear=False
            ):
                with self.assertRaisesRegex(
                    module.NonZeroAgentExitCodeError, "exit 86"
                ):
                    asyncio.run(agent.run("task", Environment(), None))
                markers = list(Path(temp).glob("*.retry"))
                self.assertEqual(len(markers), 1)
                asyncio.run(agent.run("task", Environment(), None))
                self.assertEqual(list(Path(temp).glob("*.retry")), [])

        self.assertEqual(calls, [None, fallback])

    def test_retry_marker_requires_anchored_harbor_exit_exception(self) -> None:
        module = self.load_adapter_module()
        self.assertFalse(
            module.MixdogAgent._is_retry_exit(
                RuntimeError("diagnostic mentions Command failed (exit 86): nested")
            )
        )
        self.assertFalse(
            module.MixdogAgent._is_retry_exit(
                module.NonZeroAgentExitCodeError(
                    "Command failed (exit 186): unrelated"
                )
            )
        )
        self.assertTrue(
            module.MixdogAgent._is_retry_exit(
                module.NonZeroAgentExitCodeError(
                    "Command failed (exit 86): exact"
                )
            )
        )

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
            with (
                mock.patch.object(Trial, "create", side_effect=create_trial),
                mock.patch.dict(
                    os.environ,
                    {module.FALLBACK_STATE_ENV: str(state_root)},
                    clear=False,
                ),
            ):
                result = await queue._execute_trial_with_retries(config)
            return result, routes, trial_objects, starting_budgets

        with tempfile.TemporaryDirectory(prefix="mixdog-real-queue-") as temp:
            root = Path(temp)
            success = asyncio.run(
                exercise_queue(root / "success", "queue-success", 1, 2)
            )
            result, routes, trials, budgets = success
            self.assertIsNone(result.exception_info)
            self.assertEqual(routes, [None, fallback])
            self.assertEqual(len({id(trial) for trial in trials}), 2)
            self.assertEqual(budgets, [100, 100])
            self.assertEqual(list((root / "success").glob("*.retry")), [])

            exhausted = asyncio.run(
                exercise_queue(root / "exhausted", "queue-exhausted", 99, 2)
            )
            result, routes, trials, budgets = exhausted
            self.assertEqual(
                result.exception_info.exception_type,
                "NonZeroAgentExitCodeError",
            )
            self.assertEqual(routes, [None, fallback, fallback])
            self.assertEqual(len(trials), 3)
            self.assertEqual(budgets, [100, 100, 100])
            self.assertEqual(
                len(list((root / "exhausted").glob("*.retry"))), 1
            )

    def test_run_forbids_anthropic_refresh_without_serializing_trials(self) -> None:
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
        asyncio.run(agent.run("task", Environment(), None))

        self.assertEqual(
            captured[0]["MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED"], "1"
        )
        self.assertEqual(
            captured[0]["MIXDOG_DRIVER_DEADLINE_MS"],
            str(module.LEAD_INNER_DEADLINE_MS),
        )
        self.assertEqual(captured[0]["MIXDOG_DISABLE_MCP"], "1")
        self.assertEqual(captured[0]["MIXDOG_DISABLE_SKILLS"], "1")
        self.assertEqual(captured[0]["MIXDOG_BOOT_CORE_MEMORY"], "0")
        self.assertEqual(captured[0]["MIXDOG_DISABLE_CHANNEL_START"], "1")
        self.assertEqual(
            {
                key: captured[0][key]
                for key in module.PRISTINE_GUARD_ENV
            },
            module.PRISTINE_GUARD_ENV,
        )
        approved = set(module.PRISTINE_CONTRACT["approvedExecutionEnv"])
        guarded = set(module.PRISTINE_GUARD_ENV)
        auth = {"ANTHROPIC_OAUTH_CREDENTIALS_PATH"}
        boundary = {"MIXDOG_DATA_DIR", "MIXDOG_HOME"}
        self.assertTrue(
            {
                key
                for key in captured[0]
                if key.startswith("MIXDOG_")
            }
            <= approved | guarded | auth | boundary
        )

    def test_injection_is_allowlisted_and_emits_non_secret_pristine_audit(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-credential-inject-") as temp:
            data = Path(temp)
            host_credentials = data / "anthropic-oauth-credentials.json"
            host_bytes = b'{"claudeAiOauth":{"accessToken":"host-fixture"}}'
            snapshot_bytes = b'{"claudeAiOauth":{"accessToken":"snapshot-fixture"}}'
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

            async def inject_src_snapshot(environment):
                return None

            agent.exec_as_root = exec_as_root
            agent._inject_src_snapshot = inject_src_snapshot

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
                "fixture instruction",
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
            "mixdog --provider openai-oauth --model gpt-worker --effort high --fast worker",
            command,
        )
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
        asyncio.run(agent.install(object()))

        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[1], module._uv_provision_command())

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
            timeout=15,
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
            agent._run_lead(Environment(), "fixture", None, {"BASE": "value"})
        )

        command, run_env = captured[0]
        self.assertIn(
            f"timeout --signal=TERM --kill-after={module.PROCESS_KILL_GRACE_S}s "
            f"{module.PROCESS_RUN_DEADLINE_S}s",
            command,
        )
        self.assertIn("GNU coreutils", command)
        self.assertIn("node /opt/mixdog/lead_driver.mjs", command)
        self.assertEqual(run_env["MIXDOG_PROMPT"], HEADLESS_BENCH_MANDATE + "fixture")
        self.assertEqual(run_env["MIXDOG_WORKFLOW"], "default")

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
            snapshot = build_src_snapshot(repo_src, root / "snapshot.tar")
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
        self.assertIn("trap cleanup_src_swap EXIT", commands[0])
        self.assertIn("trap 'exit 1' HUP INT TERM", commands[0])
        self.assertIn('mv "$PACKAGE/src" "$BACKUP"', commands[0])
        self.assertIn('mv "$STAGING/src" "$PACKAGE/src"', commands[0])
        self.assertIn('mv "$BACKUP" "$PACKAGE/src"', commands[0])
        self.assertIn('rm -rf "$BACKUP" "$STAGING"', commands[0])
        self.assertNotIn('rm -rf "$PACKAGE/src"', commands[0])
        self.assertNotIn("manifest", commands[0])
        self.assertNotIn("src_overlay_apply", commands[0])


class LeadDriverBehaviorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._prior_context_utils_url = os.environ.get("MIXDOG_CONTEXT_UTILS_URL")
        os.environ["MIXDOG_CONTEXT_UTILS_URL"] = (
            REPO_ROOT
            / "src"
            / "runtime"
            / "agent"
            / "orchestrator"
            / "session"
            / "context-utils.mjs"
        ).as_uri()

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._prior_context_utils_url is None:
            os.environ.pop("MIXDOG_CONTEXT_UTILS_URL", None)
        else:
            os.environ["MIXDOG_CONTEXT_UTILS_URL"] = cls._prior_context_utils_url

    def test_driver_deadline_bounds_the_initial_turn(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")

        runtime_stub = """
import { writeFileSync } from 'node:fs';
let rejectAsk = null;
export async function createMixdogSessionRuntime() {
  return {
    sessionId: 'deadline-session',
    session: { id: 'deadline-session', tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {
      if (rejectAsk) rejectAsk(new Error('stub aborted'));
    },
    async close() {
      writeFileSync(process.env.MIXDOG_DATA_DIR + '/deadline-closed', 'closed');
    },
    ask() {
      return new Promise((resolve, reject) => { rejectAsk = reject; });
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-lead-deadline-test-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROVIDER": "anthropic-oauth",
                    "MIXDOG_MODEL": "claude-fixture",
                    "MIXDOG_PROMPT": "never completes",
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "50",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            self.assertEqual((data / "deadline-closed").read_text(), "closed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "run deadline exceeded during model ask after 50ms", result.stderr
        )

    def test_driver_rejects_before_start_when_deadline_is_exhausted(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
import { writeFileSync } from 'node:fs';
export async function createMixdogSessionRuntime() {
  writeFileSync(process.env.MIXDOG_DATA_DIR + '/runtime-started', 'unexpected');
  throw new Error('runtime must not start');
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-lead-prestart-test-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROVIDER": "anthropic-oauth",
                    "MIXDOG_MODEL": "claude-fixture",
                    "MIXDOG_PROMPT": "must not start",
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "0",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            self.assertFalse((data / "runtime-started").exists())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run deadline exceeded before primary session", result.stderr)

    def test_driver_exits_86_after_late_lead_refusal(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
import { readFileSync, writeFileSync } from 'node:fs';
const countPath = process.env.MIXDOG_DATA_DIR + '/runtime-count';
export async function createMixdogSessionRuntime() {
  let count = 0;
  try { count = Number(readFileSync(countPath, 'utf8')); } catch {}
  count += 1;
  writeFileSync(countPath, String(count));
  return {
    sessionId: 'late-fallback-primary',
    session: { id: 'late-fallback-primary', tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async ask() {
      process.stderr.write('[session] empty-final persisted sessionId=late-fallback-primary detail=fixture stopReason=refusal\\n');
      return { result: { text: '' } };
    },
    async close() {
      await new Promise((resolve) => setTimeout(resolve, 75));
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-late-fallback-test-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            audit_path = root / "refusal-brief-audit.json"
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROVIDER": "anthropic-oauth",
                    "MIXDOG_MODEL": "claude-primary",
                    "MIXDOG_PROMPT": "refuse",
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "40",
                    "MIXDOG_BRIEF_AUDIT_LOG": str(audit_path),
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            self.assertEqual((data / "runtime-count").read_text(), "1")
            self.assertTrue(audit_path.exists())
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertIn(
            "lead_driver: lead session late-fallback-primary terminated on API refusal",
            result.stderr,
        )

    def test_driver_never_relaunches_refused_lead_in_process(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
import { mkdirSync, writeFileSync } from 'node:fs';
let runtimeCount = 0;
export async function createMixdogSessionRuntime({ provider, model }) {
  const count = ++runtimeCount;
  const sessionId = `fallback-session-${count}`;
  mkdirSync(process.env.MIXDOG_DATA_DIR + '/sessions', { recursive: true });
  const route = { provider, model };
  const persist = () => writeFileSync(
    process.env.MIXDOG_DATA_DIR + `/sessions/${sessionId}.json`,
    JSON.stringify({ id: sessionId, model, route, messages: [] }),
  );
  persist();
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort(effort) { route.effort = effort; persist(); },
    async setFast(fast) { route.fast = fast; persist(); },
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask() {
      if (count === 1) {
        process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`);
        return { result: { text: '' } };
      }
      return { result: { text: 'fallback completed' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-refusal-fallback-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(runtime_stub, encoding="utf-8")
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROVIDER": "anthropic-oauth",
                    "MIXDOG_MODEL": "claude-primary",
                    "MIXDOG_PROMPT": "fallback task",
                    "MIXDOG_LEAD_FALLBACK": json.dumps({
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    }),
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "-1",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            primary_session = json.loads(
                (data / "sessions" / "fallback-session-1.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                primary_session["route"],
                {
                    "provider": "anthropic-oauth",
                    "model": "claude-primary",
                },
            )
            self.assertFalse(
                (data / "sessions" / "fallback-session-2.json").exists()
            )
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertNotIn("refusal-fallback:", result.stdout)

    def test_driver_exits_86_when_fallback_also_refuses(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
let runtimeCount = 0;
export async function createMixdogSessionRuntime() {
  const sessionId = `double-refusal-${++runtimeCount}`;
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask() {
      process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`);
      return { result: { text: '' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-double-refusal-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(runtime_stub, encoding="utf-8")
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROMPT": "double refusal",
                    "MIXDOG_LEAD_FALLBACK": json.dumps({
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    }),
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "-1",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertIn(
            "lead_driver: lead session double-refusal-1 terminated on API refusal",
            result.stderr,
        )

    def test_driver_exits_86_when_fallback_starts_after_deadline(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
export async function createMixdogSessionRuntime() {
  const sessionId = 'deadline-refusal-primary';
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask() {
      process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`);
      return { result: { text: '' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-fallback-deadline-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(runtime_stub, encoding="utf-8")
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROMPT": "deadline refusal",
                    "MIXDOG_LEAD_FALLBACK": json.dumps({
                        "provider": "openai-oauth",
                        "model": "gpt-5.6-sol",
                        "effort": "xhigh",
                        "fast": True,
                    }),
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "20",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertNotIn("refusal fallback", result.stderr)

    def test_driver_exits_86_for_lead_refusal_with_streamed_narration(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")

        runtime_stub = """
import { writeFileSync } from 'node:fs';
let runtimeCount = 0;
const dataDir = process.env.MIXDOG_DATA_DIR;
export async function createMixdogSessionRuntime() {
  const sessionId = `stub-session-${++runtimeCount}`;
  writeFileSync(dataDir + '/runtime-count', String(runtimeCount));
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask(_message, { onTextDelta }) {
      onTextDelta('interim narration');
      process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`);
      return { result: { text: '' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"

        with tempfile.TemporaryDirectory(prefix="mixdog-lead-driver-test-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            env = {
                **os.environ,
                "MIXDOG_SRC": str(src),
                "MIXDOG_DATA_DIR": str(data),
                "MIXDOG_PROVIDER": "anthropic-oauth",
                "MIXDOG_MODEL": "claude-fable-5",
                "MIXDOG_PROMPT": "stub task",
                "MIXDOG_BOOT_JITTER_MS": "0",
                "MIXDOG_DRIVER_DEADLINE_MS": "100",
            }
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )

            self.assertEqual((data / "runtime-count").read_text(), "1")
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertIn(
            "lead_driver: lead session stub-session-1 terminated on API refusal",
            result.stderr,
        )

    def test_driver_keeps_refusal_then_successful_resume(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")

        runtime_stub = """
let notify = null;
let asks = 0;
export async function createMixdogSessionRuntime() {
  const sessionId = 'resume-after-refusal';
  let activeSessionId = '';
  return {
    get sessionId() { return activeSessionId; },
    get session() { return activeSessionId ? { id: activeSessionId, tools: [] } : undefined; },
    onNotification(callback) { notify = callback; },
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask() {
      asks += 1;
      if (asks === 1) {
        process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`);
        notify();
        return { result: { text: '' } };
      }
      activeSessionId = sessionId;
      return { result: { text: 'resume completed' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-resume-after-refusal-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROVIDER": "anthropic-oauth",
                    "MIXDOG_MODEL": "claude-fixture",
                    "MIXDOG_PROMPT": "resume after refusal",
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "100",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("refusal-restart:", result.stdout)
        self.assertIn("resume completed", result.stdout)

    def test_driver_exits_86_after_refusal_and_empty_resume(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")

        runtime_stub = """
let notify = null;
let asks = 0;
export async function createMixdogSessionRuntime() {
  const sessionId = 'empty-resume-after-refusal';
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification(callback) { notify = callback; },
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask() {
      asks += 1;
      if (asks === 1) {
        process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`);
        notify();
      }
      return { result: { text: '' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-empty-resume-refusal-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROVIDER": "anthropic-oauth",
                    "MIXDOG_MODEL": "claude-fixture",
                    "MIXDOG_PROMPT": "empty resume after refusal",
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "100",
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertIn(
            "lead_driver: lead session empty-resume-after-refusal "
            "terminated on API refusal",
            result.stderr,
        )

    def test_tiny_finals_retry_but_substantive_final_succeeds(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
export async function createMixdogSessionRuntime() {
  const sessionId = 'final-size-fixture';
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask() { return { result: { text: process.env.FIXTURE_FINAL } }; },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-final-size-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            results = {}
            for final in ("R", "!", "OK", "ordinary substantive final"):
                results[final] = subprocess.run(
                    ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                    cwd=BENCH_ROOT,
                    env={
                        **os.environ,
                        "MIXDOG_SRC": str(src),
                        "MIXDOG_DATA_DIR": str(data),
                        "MIXDOG_PROMPT": "fixture",
                        "MIXDOG_BOOT_JITTER_MS": "0",
                        "MIXDOG_DRIVER_DEADLINE_MS": "-1",
                        "FIXTURE_FINAL": final,
                    },
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=5,
                )
        for final in ("R", "!", "OK"):
            self.assertEqual(results[final].returncode, 86, results[final].stderr)
            self.assertIn("tiny final public response", results[final].stdout)
        self.assertEqual(
            results["ordinary substantive final"].returncode,
            0,
            results["ordinary substantive final"].stderr,
        )

    def test_close_hang_or_reject_cannot_mask_final_outcome(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
export async function createMixdogSessionRuntime() {
  const sessionId = `close-${process.env.FIXTURE_GATE}-${process.env.FIXTURE_CLOSE}`;
  return {
    sessionId,
    session: { id: sessionId, tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    close() {
      if (process.env.FIXTURE_CLOSE === 'reject') {
        return Promise.reject(new Error('fixture close rejected'));
      }
      return new Promise(() => {});
    },
    async ask() {
      if (process.env.FIXTURE_GATE === 'refusal') {
        process.stderr.write(
          `[session] empty-final persisted sessionId=${sessionId} detail=fixture stopReason=refusal\\n`
        );
        return { result: { text: '' } };
      }
      if (process.env.FIXTURE_GATE === 'tiny') {
        return { result: { text: 'OK' } };
      }
      return { result: { text: 'ordinary substantive final' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-close-outcome-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            results = {}
            for gate in ("refusal", "tiny", "substantive"):
                for close_behavior in ("hang", "reject"):
                    results[(gate, close_behavior)] = subprocess.run(
                        ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                        cwd=BENCH_ROOT,
                        env={
                            **os.environ,
                            "MIXDOG_SRC": str(src),
                            "MIXDOG_DATA_DIR": str(data),
                            "MIXDOG_PROMPT": "fixture",
                            "MIXDOG_BOOT_JITTER_MS": "0",
                            "MIXDOG_DRIVER_DEADLINE_MS": "-1",
                            "MIXDOG_CLOSE_GRACE_MS": "5",
                            "FIXTURE_GATE": gate,
                            "FIXTURE_CLOSE": close_behavior,
                        },
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        timeout=5,
                    )

        for gate in ("refusal", "tiny"):
            for close_behavior in ("hang", "reject"):
                result = results[(gate, close_behavior)]
                self.assertEqual(result.returncode, 86, result.stderr)
                if gate == "refusal":
                    self.assertIn(
                        "lead_driver: lead session "
                        f"close-refusal-{close_behavior} terminated on API refusal",
                        result.stderr,
                    )
                else:
                    self.assertIn(
                        "refusal-restart: tiny final public response",
                        result.stdout,
                    )
        for close_behavior in ("hang", "reject"):
            result = results[("substantive", close_behavior)]
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("ordinary substantive final", result.stdout)

    def test_driver_stall_exits_for_fresh_retry_without_second_runtime(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = """
import { readFileSync, writeFileSync } from 'node:fs';
const countPath = process.env.MIXDOG_DATA_DIR + '/runtime-count';
let rejectAsk;
let holdOpen;
export async function createMixdogSessionRuntime() {
  let count = 0;
  try { count = Number(readFileSync(countPath, 'utf8')); } catch {}
  writeFileSync(countPath, String(count + 1));
  return {
    sessionId: 'stall-fixture',
    session: { id: 'stall-fixture', tools: [] },
    onNotification() {},
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() { return false; },
    close() {
      clearInterval(holdOpen);
      return new Promise(() => {});
    },
    ask() {
      holdOpen = setInterval(() => {}, 1000);
      return new Promise((_resolve, reject) => { rejectAsk = reject; });
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        with tempfile.TemporaryDirectory(prefix="mixdog-stall-") as temp:
            root = Path(temp)
            src = root / "src"
            data = root / "data"
            (src / "session-runtime").mkdir(parents=True)
            data.mkdir()
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            audit_path = root / "stall-brief-audit.json"
            result = subprocess.run(
                ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                cwd=BENCH_ROOT,
                env={
                    **os.environ,
                    "MIXDOG_SRC": str(src),
                    "MIXDOG_DATA_DIR": str(data),
                    "MIXDOG_PROMPT": "stall",
                    "MIXDOG_BOOT_JITTER_MS": "0",
                    "MIXDOG_DRIVER_DEADLINE_MS": "-1",
                    "MIXDOG_STALL_MS": "1",
                    "MIXDOG_STALL_POLL_MS": "5",
                    "MIXDOG_STALL_CLOSE_GRACE_MS": "5",
                    "MIXDOG_BRIEF_AUDIT_LOG": str(audit_path),
                },
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=5,
            )
            self.assertEqual((data / "runtime-count").read_text(), "1")
            self.assertTrue(audit_path.exists())
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertIn("stalled turn is refusal-equivalent", result.stderr)

    def test_brief_audit_reports_structural_findings_without_failing(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        runtime_stub = r"""
const leadId = 'brief-audit-lead';
const clean = process.env.FIXTURE_AUDIT === 'clean';
const dirtyCalls = [
  { agent: 'worker', tag: 'impl', prompt: 'Task: shared-secret-task\nVerify: secret-command' },
  { agent: 'review', tag: 'review', prompt: '', message: 'Task: shared-secret-task\nDeliver: secret-review' },
  { agent: 'debugger', tag: 'debug', prompt: 'Anchors: secret-debug' },
  { agent: 'heavy', tag: 'heavy', cwd: 'worker', file: 'briefs/heavy.txt' },
  { agent: 'explorer', tag: 'scan', prompt: 'Task: secret-scan\nAnchors: Worker→Debugger→Reviewer' },
  { agent: 'worker', tag: 'no-brief' },
];
const cleanCalls = [
  { agent: 'review', tag: 'review-a', prompt: 'Task: secret-clean-review' },
  { agent: 'reviewer', tag: 'review-b', prompt: 'Task: secret-clean-review' },
];
const calls = clean ? cleanCalls : dirtyCalls;
const resumedCalls = clean
  ? [{ agent: 'reviewer', tag: 'review-a', message: 'Task: secret-clean-followup' }]
  : [{ agent: 'worker', tag: 'impl', message: 'Task: secret-resumed-impl' }];
const lead = {
  id: leadId,
  cwd: process.env.FIXTURE_CWD,
  tools: [{ name: 'agent' }],
  messages: [],
};
export async function createMixdogSessionRuntime() {
  let notify = () => {};
  let askCount = 0;
  return {
    sessionId: leadId,
    session: lead,
    cwd: process.env.FIXTURE_CWD,
    onNotification(callback) { notify = callback; },
    async setWorkflow() {},
    async setEffort() {},
    async setFast() {},
    agentStatus() { return { agentJobs: [] }; },
    abort() {},
    async close() {},
    async ask(_message, options) {
      const batch = askCount === 0 ? calls : resumedCalls;
      const runtimeCalls = batch.map((call, index) => ({
        id: `call-${askCount}-${index}`,
        name: 'agent',
        arguments: { type: 'spawn', ...call },
      }));
      await options.onToolCall?.(0, runtimeCalls);
      for (const call of runtimeCalls) {
        call.arguments.prompt = 'Task: post-event-compacted-brief';
        delete call.arguments.message;
        delete call.arguments.file;
      }
      askCount += 1;
      if (askCount === 1) queueMicrotask(() => notify());
      return { result: { text: 'ordinary substantive final' } };
    },
  };
}
"""
        workflow_stub = "export const normalizeWorkflowId = (value) => value;\n"
        results = {}
        with tempfile.TemporaryDirectory(prefix="mixdog-brief-audit-") as temp:
            root = Path(temp)
            src = root / "src"
            (src / "session-runtime").mkdir(parents=True)
            (src / "mixdog-session-runtime.mjs").write_text(
                runtime_stub, encoding="utf-8"
            )
            (src / "session-runtime" / "workflow.mjs").write_text(
                workflow_stub, encoding="utf-8"
            )
            for fixture in ("clean", "findings"):
                data = root / fixture
                data.mkdir()
                file_brief = (
                    "Task: secret-heavy-file\n"
                    "Deliver: secret-file-delivery\n"
                )
                (data / "worker" / "briefs").mkdir(parents=True)
                (data / "worker" / "briefs" / "heavy.txt").write_bytes(
                    file_brief.encode()
                )
                audit_path = root / f"{fixture}-brief-audit.json"
                result = subprocess.run(
                    ["node", str(HARNESS_ROOT / "lead_driver.mjs")],
                    cwd=BENCH_ROOT,
                    env={
                        **os.environ,
                        "MIXDOG_SRC": str(src),
                        "MIXDOG_DATA_DIR": str(data),
                        "MIXDOG_PROMPT": "fixture",
                        "MIXDOG_BOOT_JITTER_MS": "0",
                        "MIXDOG_DRIVER_DEADLINE_MS": "3000",
                        "MIXDOG_BRIEF_AUDIT_LOG": str(audit_path),
                        "FIXTURE_AUDIT": fixture,
                        "FIXTURE_CWD": str(data),
                    },
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=5,
                )
                results[fixture] = (result, json.loads(audit_path.read_text()))

        clean_result, clean_audit = results["clean"]
        self.assertEqual(clean_result.returncode, 0, clean_result.stderr)
        self.assertEqual(clean_audit["schemaVersion"], 1)
        self.assertEqual(clean_audit["findingCount"], 0)
        self.assertEqual(clean_audit["leadAgentCallCount"], 3)
        self.assertEqual(
            [call["tag"] for call in clean_audit["calls"]].count("review-a"), 2
        )
        self.assertTrue(
            all(len(call["callPromptSha256"]) == 64 for call in clean_audit["calls"])
        )

        findings_result, findings_audit = results["findings"]
        self.assertEqual(findings_result.returncode, 0, findings_result.stderr)
        self.assertEqual(
            findings_audit["issueCounts"],
            {
                "task_omission": 1,
                "verify_prescription": 1,
                "legacy_role_lineage": 1,
                "cross_role_task_reuse": 2,
            },
        )
        self.assertEqual(findings_audit["findingCount"], 5)
        self.assertEqual(findings_audit["leadAgentCallCount"], 6)
        self.assertNotIn(
            "no-brief", [call["tag"] for call in findings_audit["calls"]]
        )
        self.assertEqual(
            [call["tag"] for call in findings_audit["calls"]].count("impl"), 2
        )
        heavy_call = next(
            call for call in findings_audit["calls"] if call["tag"] == "heavy"
        )
        self.assertEqual(
            heavy_call["callPromptSha256"],
            __import__("hashlib").sha256(file_brief.encode()).hexdigest(),
        )
        self.assertIn("brief-audit v1 calls=6 findings=5", findings_result.stdout)
        serialized = json.dumps(findings_audit) + findings_result.stdout
        for raw_brief_fragment in (
            "shared-secret-task",
            "secret-command",
            "secret-review",
            "secret-debug",
            "secret-heavy",
            "secret-file-delivery",
            "secret-scan",
            "secret-resumed-impl",
            "post-event-compacted-brief",
        ):
            self.assertNotIn(raw_brief_fragment, serialized)


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
            timeout=30,
        )

    def test_profile_dry_run_generates_auditable_command(self) -> None:
        result = self.run_launcher("-RouteProfile", "fable-xhigh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], EXPECTED_AUDIT_LINE)
        self.assertIn("--ak route_profile=fable-xhigh", result.stdout)
        self.assertNotIn("workflow=", result.stdout)

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
                    "@mkdir \"%MIXDOG_TB_FALLBACK_STATE_DIR%\"\n"
                    f"@echo %MIXDOG_TB_SRC_SNAPSHOT%>\"{capture}\"\n"
                    f"@echo %MIXDOG_TB_FALLBACK_STATE_DIR%>>\"{capture}\"\n"
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
                    '"$MIXDOG_TB_FALLBACK_STATE_DIR"\n'
                    f'printf "%s\\n%s\\n" "$MIXDOG_TB_SRC_SNAPSHOT" '
                    f'"$MIXDOG_TB_FALLBACK_STATE_DIR" > "{capture}"\n'
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
