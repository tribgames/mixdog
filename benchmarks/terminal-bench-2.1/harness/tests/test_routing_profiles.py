from __future__ import annotations

import ast
import asyncio
import copy
import hashlib
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
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
    STATIC_SRC_OVERLAY_FILES,
    SrcOverlayError,
    build_src_snapshot,
    collect_src_overlay_files,
    discover_git_src_files,
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
    "[Headless bench run: no user is present. Standing pre-approval covers this entire task - never draft a plan and wait for approval, never ask questions or end a turn waiting for a reply; decide and proceed until the task is verified complete or provably blocked. All other workflow rules, including delegation and review, apply unchanged.]\n\n"
)
OVERLAY_APPLIER = HARNESS_ROOT / "src_overlay_apply.mjs"


def completed_git(stdout: bytes) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], 0, stdout, b"")


def snapshot_git_results(
    porcelain_before: bytes, modes: bytes = b"", porcelain_after: bytes | None = None
) -> list[subprocess.CompletedProcess]:
    return [
        completed_git(porcelain_before),
        completed_git(modes),
        completed_git(
            porcelain_before if porcelain_after is None else porcelain_after
        ),
        completed_git(modes),
    ]


def write_staging(
    root: Path, files: list[tuple[str, bytes, int]]
) -> Path:
    staging = root / "staging"
    files_root = staging / "files"
    files_root.mkdir(parents=True)
    entries = []
    for index, (relative, content, mode) in enumerate(files):
        target = files_root.joinpath(*relative.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        entries.append(
            {
                "index": index,
                "path": relative,
                "mode": mode,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        )
    (staging / "manifest.json").write_text(
        json.dumps({"schemaVersion": 2, "files": entries}),
        encoding="utf-8",
    )
    return staging


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
                "fable-high",
            },
        )
        profile = load_route_profile("fable-xhigh")
        self.assertEqual(tuple(profile["routes"]), PROFILE_ROLES)
        self.assertEqual(
            profile["leadFallback"],
            {
                "provider": "openai-oauth",
                "model": "gpt-5.6-sol",
                "effort": "xhigh",
                "fast": True,
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
        opus_profile = load_route_profile("opus-xhigh")
        self.assertEqual(
            opus_profile,
            {
                "leadFallback": {
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-sol",
                    "effort": "xhigh",
                    "fast": True,
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
                    "provider": "openai-oauth",
                    "model": "gpt-5.6-sol",
                    "effort": "xhigh",
                    "fast": True,
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
        config = build_benchmark_config(profile, "solo-review")
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
        self.assertEqual(agent["workflow"], {"active": "solo-review"})
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

    def test_bench_overlay_includes_mandatory_lead_brief_contract(self) -> None:
        self.assertIn("rules/lead/lead-brief.md", STATIC_SRC_OVERLAY_FILES)

    def test_bench_overlay_includes_solo_review_workflow(self) -> None:
        self.assertIn(
            "workflows/solo-review/WORKFLOW.md", STATIC_SRC_OVERLAY_FILES
        )

    def test_solo_review_workflow_is_discovered_and_normalized(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        script = r"""
import { resolve } from 'node:path';
import {
  createWorkflowHelpers,
  normalizeWorkflowId,
} from './src/session-runtime/workflow.mjs';
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
const pack = helpers.listWorkflowPacks().find(({ id }) => id === 'solo-review');
console.log(JSON.stringify({
  normalized: normalizeWorkflowId(' Solo Review '),
  pack: pack && { id: pack.id, name: pack.name, agents: pack.agents },
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
                "normalized": "solo-review",
                "pack": {
                    "id": "solo-review",
                    "name": "Solo Review",
                    "agents": ["reviewer"],
                },
            },
        )


class SrcOverlayTests(unittest.TestCase):
    def test_modified_untracked_union_snapshot_is_deduplicated_and_sorted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-test-") as temp:
            repo_src = Path(temp, "src")
            for relative in ("z-static.mjs", "shared.mjs", "a-new.mjs"):
                path = repo_src / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(relative, encoding="utf-8")
            porcelain = b" M src/shared.mjs\0?? src/a-new.mjs\0"
            completed = subprocess.CompletedProcess([], 0, porcelain, b"")
            with mock.patch("harness.src_overlay.subprocess.run", return_value=completed):
                overlay = collect_src_overlay_files(
                    ("z-static.mjs", "shared.mjs", "shared.mjs"), repo_src
                )
        self.assertEqual(overlay, ("a-new.mjs", "shared.mjs", "z-static.mjs"))

    def test_snapshot_freezes_exact_bytes_size_and_sha256(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-test-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            (repo_src / "changed.mjs").write_bytes(b"frozen bytes\n")
            porcelain = b" M src/changed.mjs\0"
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(porcelain),
            ):
                snapshot = build_src_snapshot(
                    (), repo_src, root / "snapshot"
                )
            (repo_src / "changed.mjs").write_bytes(b"later mutation\n")
            loaded = load_src_snapshot(snapshot.root)
            self.assertEqual([entry.path for entry in loaded.entries], ["changed.mjs"])
            entry = loaded.entries[0]
            self.assertEqual(entry.size, len(b"frozen bytes\n"))
            self.assertEqual(
                entry.sha256,
                "23d238dee01bfbb2ae59b9d21cce89282f89977ecf5f696f0da80f522cb17a8c",
            )
            self.assertEqual(snapshot.file_path(entry).read_bytes(), b"frozen bytes\n")

    def test_exported_snapshot_supports_concurrent_read_only_loads(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-concurrent-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            reviewer = repo_src / "agents" / "reviewer" / "AGENT.md"
            reviewer.parent.mkdir(parents=True)
            reviewer.write_bytes(b"shared immutable reviewer snapshot\n")
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(b""),
            ):
                snapshot = build_src_snapshot(
                    ("agents/reviewer/AGENT.md",), repo_src, root / "snapshot"
                )

            with ThreadPoolExecutor(max_workers=8) as executor:
                loaded = list(
                    executor.map(
                        lambda _: load_src_snapshot(snapshot.root),
                        range(32),
                    )
                )

            self.assertTrue(
                all(
                    item.entries == snapshot.entries
                    and item.root == snapshot.root
                    for item in loaded
                )
            )

    def test_snapshot_load_accepts_same_file_with_different_permission_metadata(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-identity-") as temp:
            root = Path(temp)
            staging = write_staging(
                root, [("agents/reviewer/AGENT.md", b"reviewer\n", 0o644)]
            )
            target = staging / "files" / "agents" / "reviewer" / "AGENT.md"
            actual = os.lstat(target)
            permissions = actual.st_mode & 0o777
            different_permissions = 0o444 if permissions != 0o444 else 0o644
            pathname_info = types.SimpleNamespace(
                st_mode=(actual.st_mode & ~0o777) | different_permissions,
                st_dev=actual.st_dev,
                st_ino=actual.st_ino,
            )

            with mock.patch(
                "harness.src_overlay.os.lstat", return_value=pathname_info
            ):
                loaded = load_src_snapshot(staging)

            self.assertEqual(
                [entry.path for entry in loaded.entries],
                ["agents/reviewer/AGENT.md"],
            )

    def test_snapshot_load_rejects_changed_device_or_inode(self) -> None:
        for changed_field in ("st_dev", "st_ino"):
            with self.subTest(changed_field=changed_field), tempfile.TemporaryDirectory(
                prefix="mixdog-overlay-identity-"
            ) as temp:
                root = Path(temp)
                staging = write_staging(root, [("reviewer.md", b"reviewer\n", 0o644)])
                target = staging / "files" / "reviewer.md"
                actual = os.lstat(target)
                pathname_info = types.SimpleNamespace(
                    st_mode=actual.st_mode,
                    st_dev=actual.st_dev + (changed_field == "st_dev"),
                    st_ino=actual.st_ino + (changed_field == "st_ino"),
                )

                with mock.patch(
                    "harness.src_overlay.os.lstat", return_value=pathname_info
                ):
                    with self.assertRaisesRegex(
                        SrcOverlayError, "changed during snapshot"
                    ):
                        load_src_snapshot(staging)

    def test_path_escape_and_non_src_git_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-test-") as temp:
            repo_src = Path(temp, "src")
            repo_src.mkdir()
            with self.assertRaisesRegex(SrcOverlayError, "escapes"):
                collect_src_overlay_files(("../secret",), repo_src)
            completed = subprocess.CompletedProcess(
                [], 0, b"?? mixdog-config.json\0", b""
            )
            with mock.patch("harness.src_overlay.subprocess.run", return_value=completed):
                with self.assertRaisesRegex(SrcOverlayError, "non-src"):
                    discover_git_src_files(Path(temp))

    def test_rename_copy_delete_and_unmerged_statuses_fail_closed(self) -> None:
        cases = {
            b"R  src/new.mjs\0src/old.mjs\0": "rename/copy",
            b"C  src/copy.mjs\0src/original.mjs\0": "rename/copy",
            b" D src/deleted.mjs\0": "deleted",
            b"UU src/conflict.mjs\0": "unmerged",
            b"AA src/conflict.mjs\0": "unmerged",
        }
        for porcelain, message in cases.items():
            completed = subprocess.CompletedProcess([], 0, porcelain, b"")
            with self.subTest(porcelain=porcelain), mock.patch(
                "harness.src_overlay.subprocess.run", return_value=completed
            ):
                with self.assertRaisesRegex(SrcOverlayError, message):
                    discover_git_src_files(Path("repo"))

    def test_malformed_porcelain_records_fail_closed(self) -> None:
        cases = (
            b" M src/truncated.mjs",
            b"M\0",
            b"ZZ src/invalid.mjs\0",
            b"   src/no-status.mjs\0",
        )
        for porcelain in cases:
            completed = subprocess.CompletedProcess([], 0, porcelain, b"")
            with self.subTest(porcelain=porcelain), mock.patch(
                "harness.src_overlay.subprocess.run", return_value=completed
            ):
                with self.assertRaisesRegex(SrcOverlayError, "truncated|malformed|invalid"):
                    discover_git_src_files(Path("repo"))

    def test_source_symlink_swap_during_snapshot_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-race-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            source = repo_src / "changed.mjs"
            source.write_bytes(b"safe")
            secret = root / "secret"
            secret.write_bytes(b"must-not-snapshot")
            completed = subprocess.CompletedProcess([], 0, b"", b"")
            real_open = os.open
            swapped = False

            def raced_open(path, flags):
                nonlocal swapped
                if Path(path) == source and not swapped:
                    swapped = True
                    source.unlink()
                    source.symlink_to(secret)
                return real_open(path, flags)

            with (
                mock.patch(
                    "harness.src_overlay.subprocess.run",
                    side_effect=[completed, completed],
                ),
                mock.patch("harness.src_overlay.os.open", side_effect=raced_open),
            ):
                with self.assertRaisesRegex(
                    SrcOverlayError, "safely open|changed during snapshot"
                ):
                    build_src_snapshot(
                        ("changed.mjs",), repo_src, root / "snapshot"
                    )

    def test_git_unavailable_and_failure_are_closed(self) -> None:
        with mock.patch(
            "harness.src_overlay.subprocess.run",
            side_effect=FileNotFoundError("git missing"),
        ):
            with self.assertRaisesRegex(SrcOverlayError, "cannot discover"):
                discover_git_src_files(Path("repo"))

    def test_path_set_race_after_copy_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-path-race-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            (repo_src / "one.mjs").write_bytes(b"one")
            before = b" M src/one.mjs\0"
            after = before + b"?? src/new.mjs\0"
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(before, porcelain_after=after),
            ):
                with self.assertRaisesRegex(SrcOverlayError, "path set changed"):
                    build_src_snapshot((), repo_src, root / "snapshot")

    def test_executable_mode_is_manifested_and_type_changes_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-mode-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            source = repo_src / "tool.mjs"
            source.write_bytes(b"tool")
            source.chmod(0o755)
            porcelain = b" M src/tool.mjs\0"
            modes = b"100755 deadbeef 0\tsrc/tool.mjs\0"
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(porcelain, modes),
            ):
                snapshot = build_src_snapshot((), repo_src, root / "snapshot")
            self.assertEqual(snapshot.entries[0].mode, 0o755)
            self.assertEqual(
                json.loads(snapshot.manifest_path.read_text(encoding="utf-8"))[
                    "files"
                ][0]["mode"],
                0o755,
            )

        type_change = completed_git(b" T src/type-change.mjs\0")
        with mock.patch(
            "harness.src_overlay.subprocess.run", return_value=type_change
        ):
            with self.assertRaisesRegex(SrcOverlayError, "type change"):
                discover_git_src_files(Path("repo"))

    def test_manifest_index_uses_utf8_order_for_supplementary_unicode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-unicode-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            names = ("\ue000.mjs", "\U00010000.mjs")
            for name in names:
                (repo_src / name).write_text(name, encoding="utf-8")
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(b""),
            ):
                snapshot = build_src_snapshot(names[::-1], repo_src, root / "snapshot")
            self.assertEqual(
                [(entry.index, entry.path) for entry in snapshot.entries],
                [(0, "\ue000.mjs"), (1, "\U00010000.mjs")],
            )
        completed = subprocess.CompletedProcess([], 128, b"", b"not a repository")
        with mock.patch("harness.src_overlay.subprocess.run", return_value=completed):
            with self.assertRaisesRegex(SrcOverlayError, "not a repository"):
                discover_git_src_files(Path("repo"))

    def test_current_working_tree_parity(self) -> None:
        repo_root = BENCH_ROOT.parents[1]
        discovered = set(discover_git_src_files(repo_root))
        changed = subprocess.run(
            [
                "git",
                "diff",
                "--name-only",
                "-z",
                "--diff-filter=ACMRTUXB",
                "HEAD",
                "--",
                "src/",
            ],
            cwd=repo_root,
            check=True,
            capture_output=True,
        ).stdout
        untracked = subprocess.run(
            [
                "git",
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                "src/",
            ],
            cwd=repo_root,
            check=True,
            capture_output=True,
        ).stdout
        expected = {
            os.fsdecode(path)[len("src/") :]
            for path in (changed + untracked).split(b"\0")
            if path
        }
        expected.discard("workflows/bench/WORKFLOW.md")
        self.assertEqual(discovered, expected)


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
        self.assertIn(f"mixdog@{repository_version}", commands[1])
        self.assertIn("mixdog@fixture", commands[3])

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

    def test_explicit_solo_review_workflow_preserves_headless_mandate(self) -> None:
        module = self.load_adapter_module()
        child_env = asyncio.run(
            self.capture_lead_env(
                module,
                None,
                {"BASE_SENTINEL": "preserved"},
                workflow="solo-review",
            )
        )

        self.assertEqual(child_env["MIXDOG_WORKFLOW"], "solo-review")
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

            async def inject_src_overlay(environment):
                return None

            agent.exec_as_root = exec_as_root
            agent._inject_src_overlay = inject_src_overlay

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

    def test_src_overlay_uploads_exact_deterministic_relative_paths(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-upload-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            relative_paths = ("nested/beta.mjs", "alpha.mjs")
            for relative in relative_paths:
                path = repo_src / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(relative, encoding="utf-8")

            uploads = []
            events = []

            class Environment:
                async def upload_file(self, source, destination):
                    uploads.append((Path(source), destination))
                    events.append(("upload", destination))

            agent = module.MixdogAgent.__new__(module.MixdogAgent)

            async def exec_as_root(environment, *, command, env=None):
                events.append(("command", command))

            agent.exec_as_root = exec_as_root
            porcelain = b" M src/alpha.mjs\0?? src/nested/beta.mjs\0"
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(porcelain),
            ):
                snapshot = build_src_snapshot(
                    ("alpha.mjs",), repo_src, root / "snapshot"
                )
            with (
                mock.patch.dict(os.environ, {SNAPSHOT_ENV: str(snapshot.root)}),
                mock.patch.object(module, "SRC_OVERLAY_FILES", ("alpha.mjs",)),
            ):
                asyncio.run(agent._inject_src_overlay(Environment()))

        staging = f"{module.CONTAINER_DATA_DIR}/src-overlay"
        self.assertEqual(
            uploads,
            [
                (snapshot.manifest_path, f"{staging}/manifest.json"),
                (
                    module.HOST_SRC_OVERLAY_APPLIER,
                    module.CONTAINER_SRC_OVERLAY_APPLIER,
                ),
                (
                    snapshot.root / "files" / "alpha.mjs",
                    f"{staging}/files/alpha.mjs",
                ),
                (
                    snapshot.root / "files" / "nested" / "beta.mjs",
                    f"{staging}/files/nested/beta.mjs",
                ),
            ],
        )
        commands = [value for kind, value in events if kind == "command"]
        self.assertFalse(any("find " in command for command in commands))
        apply_index = next(
            index
            for index, event in enumerate(events)
            if event[0] == "command" and "src_overlay_apply.mjs" in event[1]
        )
        self.assertLess(
            max(index for index, event in enumerate(events) if event[0] == "upload"),
            apply_index,
        )
        self.assertEqual(
            [event for event in events[apply_index + 1 :] if event[0] == "upload"],
            [],
        )

    def test_src_overlay_upload_failure_never_applies_partial_staging(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-upload-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            for relative in ("first.mjs", "second.mjs"):
                (repo_src / relative).write_text(relative, encoding="utf-8")

            commands = []
            upload_count = 0

            class Environment:
                async def upload_file(self, source, destination):
                    nonlocal upload_count
                    upload_count += 1
                    if upload_count == 2:
                        raise OSError("incomplete upload")

            agent = module.MixdogAgent.__new__(module.MixdogAgent)

            async def exec_as_root(environment, *, command, env=None):
                commands.append(command)

            agent.exec_as_root = exec_as_root
            completed = subprocess.CompletedProcess([], 0, b"", b"")
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(b""),
            ):
                snapshot = build_src_snapshot(
                    ("second.mjs", "first.mjs"), repo_src, root / "snapshot"
                )
            with (
                mock.patch.dict(os.environ, {SNAPSHOT_ENV: str(snapshot.root)}),
                mock.patch.object(
                    module, "SRC_OVERLAY_FILES", ("first.mjs", "second.mjs")
                ),
            ):
                with self.assertRaisesRegex(OSError, "incomplete upload"):
                    asyncio.run(agent._inject_src_overlay(Environment()))

        self.assertEqual(upload_count, 2)
        self.assertFalse(any("src overlay applied" in command for command in commands))

    def test_container_verifies_exact_staging_before_applying_any_target(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-stage-") as temp:
            root = Path(temp)
            staging = write_staging(
                root,
                [
                    ("first.mjs", b"expected", 0o644),
                    ("second.mjs", b"second", 0o644),
                ],
            )
            (staging / "files" / "unexpected.mjs").write_bytes(b"unexpected")
            package_src = root / "package" / "src"
            package_src.mkdir(parents=True)
            (package_src / "first.mjs").write_bytes(b"original")
            result = subprocess.run(
                [
                    "node",
                    str(OVERLAY_APPLIER),
                    "--staging",
                    str(staging),
                    "--src",
                    str(package_src),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            first_after = (package_src / "first.mjs").read_bytes()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("path/count mismatch", result.stderr)
        self.assertEqual(first_after, b"original")
        self.assertNotIn("find", OVERLAY_APPLIER.read_text(encoding="utf-8"))

    def test_container_rejects_staging_hash_mismatch_before_apply(self) -> None:
        if shutil.which("node") is None:
            self.skipTest("Node.js is not installed")
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-stage-") as temp:
            root = Path(temp)
            staging = write_staging(
                root,
                [
                    ("first.mjs", b"expected", 0o644),
                    ("second.mjs", b"second", 0o644),
                ],
            )
            (staging / "files" / "second.mjs").write_bytes(b"tampered")
            package_src = root / "package" / "src"
            package_src.mkdir(parents=True)
            (package_src / "first.mjs").write_bytes(b"original")
            result = subprocess.run(
                [
                    "node",
                    str(OVERLAY_APPLIER),
                    "--staging",
                    str(staging),
                    "--src",
                    str(package_src),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            first_after = (package_src / "first.mjs").read_bytes()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("content mismatch: second.mjs", result.stderr)
        self.assertEqual(first_after, b"original")

    def test_apply_failure_is_nonzero_and_propagates_before_agent_run(self) -> None:
        module = self.load_adapter_module()
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-apply-") as temp:
            root = Path(temp)
            repo_src = root / "src"
            repo_src.mkdir()
            (repo_src / "one.mjs").write_bytes(b"one")
            completed = subprocess.CompletedProcess([], 0, b"", b"")
            with mock.patch(
                "harness.src_overlay.subprocess.run",
                side_effect=snapshot_git_results(b""),
            ):
                snapshot = build_src_snapshot(
                    ("one.mjs",), repo_src, root / "snapshot"
                )

            class Environment:
                async def upload_file(self, source, destination):
                    return None

            agent = module.MixdogAgent.__new__(module.MixdogAgent)
            agent.model_name = None
            agent._route_profile_name = None
            agent._route_profile = None
            agent._mode = "lead"
            agent._provider = None
            agent._effort = None
            agent._workflow = "default"
            commands = []
            agent_commands = []

            async def exec_as_root(environment, *, command, env=None):
                commands.append(command)
                if "src_overlay_apply.mjs" in command:
                    raise RuntimeError("apply command failed with exit 1")

            async def exec_as_agent(environment, *, command, env=None):
                agent_commands.append(command)

            agent.exec_as_root = exec_as_root
            agent.exec_as_agent = exec_as_agent
            agent._inject_credentials = lambda environment: agent._inject_src_overlay(
                environment
            )
            with (
                mock.patch.dict(os.environ, {SNAPSHOT_ENV: str(snapshot.root)}),
                mock.patch.object(module, "SRC_OVERLAY_FILES", ("one.mjs",)),
            ):
                with self.assertRaisesRegex(RuntimeError, "exit 1"):
                    asyncio.run(agent.run("must not run", Environment(), None))
        self.assertIn("src_overlay_apply.mjs", commands[-1])
        self.assertEqual(agent_commands, [])


class SrcOverlayFilesystemIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("node") is None:
            raise unittest.SkipTest("Node.js is not installed")

    def run_apply(
        self,
        staging: Path,
        src: Path,
        *,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            "node",
            str(OVERLAY_APPLIER),
            "--staging",
            str(staging),
            "--src",
            str(src),
        ]
        env = dict(os.environ)
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            command,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )

    def test_symlink_target_ancestor_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-fs-") as temp:
            root = Path(temp)
            src = root / "package" / "src"
            outside = root / "outside"
            src.mkdir(parents=True)
            outside.mkdir()
            try:
                (src / "nested").symlink_to(outside, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"symlinks unavailable: {exc}")
            staging = write_staging(
                root, [("nested/file.mjs", b"replacement", 0o644)]
            )
            result = self.run_apply(staging, src)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr)
            self.assertFalse((outside / "file.mjs").exists())

    def test_symlink_destination_and_directory_destination_are_rejected(self) -> None:
        for destination_type in ("symlink", "directory"):
            with self.subTest(destination_type=destination_type), tempfile.TemporaryDirectory(
                prefix="mixdog-overlay-fs-"
            ) as temp:
                root = Path(temp)
                src = root / "package" / "src"
                src.mkdir(parents=True)
                outside = root / "outside.mjs"
                outside.write_bytes(b"outside")
                target = src / "target.mjs"
                if destination_type == "symlink":
                    try:
                        target.symlink_to(outside)
                    except OSError as exc:
                        self.skipTest(f"symlinks unavailable: {exc}")
                else:
                    target.mkdir()
                staging = write_staging(
                    root, [("target.mjs", b"replacement", 0o644)]
                )
                result = self.run_apply(staging, src)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    "symlink" if destination_type == "symlink" else "destination",
                    result.stderr,
                )
                self.assertEqual(outside.read_bytes(), b"outside")

    def test_hardlinked_destination_is_unlinked_and_recreated_single_link(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-fs-") as temp:
            root = Path(temp)
            src = root / "package" / "src"
            src.mkdir(parents=True)
            outside = root / "outside.mjs"
            outside.write_bytes(b"preserved")
            os.link(outside, src / "target.mjs")
            staging = write_staging(
                root, [("target.mjs", b"replacement", 0o644)]
            )
            result = self.run_apply(staging, src)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(outside.read_bytes(), b"preserved")
            self.assertEqual((src / "target.mjs").read_bytes(), b"replacement")
            self.assertEqual(os.lstat(src / "target.mjs").st_nlink, 1)

    def test_manifest_index_handles_supplementary_unicode_without_node_sort(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-fs-") as temp:
            root = Path(temp)
            src = root / "package" / "src"
            src.mkdir(parents=True)
            staging = write_staging(
                root,
                [
                    ("\ue000.mjs", b"bmp", 0o644),
                    ("\U00010000.mjs", b"supplementary", 0o644),
                ],
            )
            result = self.run_apply(staging, src)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((src / "\ue000.mjs").read_bytes(), b"bmp")
            self.assertEqual(
                (src / "\U00010000.mjs").read_bytes(), b"supplementary"
            )

    @unittest.skipIf(os.name == "nt", "Windows does not preserve POSIX executable mode")
    def test_executable_mode_is_applied_exactly(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-fs-") as temp:
            root = Path(temp)
            src = root / "package" / "src"
            src.mkdir(parents=True)
            staging = write_staging(root, [("tool.mjs", b"tool", 0o755)])
            result = self.run_apply(staging, src)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.lstat(src / "tool.mjs").st_mode & 0o777, 0o755)

    def test_direct_apply_leaves_no_journal_backup_or_work_residue(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-fs-") as temp:
            root = Path(temp)
            src = root / "package" / "src"
            src.mkdir(parents=True)
            staging = write_staging(
                root, [("nested/target.mjs", b"replacement", 0o644)]
            )
            result = self.run_apply(staging, src)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                sorted(path.name for path in src.parent.iterdir()), ["src"]
            )

    @unittest.skipIf(os.name == "nt", "Windows does not expose exact POSIX directory mode")
    def test_restrictive_umask_cannot_change_created_directory_modes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-umask-") as temp:
            root = Path(temp)
            src = root / "package" / "src"
            src.mkdir(parents=True, mode=0o755)
            src.chmod(0o755)
            staging = write_staging(
                root, [("new/deep/file.mjs", b"replacement", 0o644)]
            )
            result = self.run_apply(
                staging,
                src,
                extra_env={"MIXDOG_OVERLAY_TEST_UMASK": "0077"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.lstat(src / "new").st_mode & 0o777, 0o755)
            self.assertEqual(os.lstat(src / "new" / "deep").st_mode & 0o777, 0o755)
            self.assertTrue(os.access(src / "new" / "deep", os.R_OK | os.W_OK | os.X_OK))

    @unittest.skipUnless(
        os.environ.get("MIXDOG_RUN_CONTAINER_PROBE") == "1",
        "set MIXDOG_RUN_CONTAINER_PROBE=1 for disposable Linux probe",
    )
    def test_linux_disposable_container_symlink_and_mode_probe(self) -> None:
        docker = shutil.which("docker")
        if docker is None:
            self.skipTest("Docker is unavailable")
        with tempfile.TemporaryDirectory(prefix="mixdog-overlay-container-") as temp:
            root = Path(temp)
            staging = write_staging(
                root, [("nested/tool.mjs", b"tool", 0o755)]
            )
            (root / "package" / "src").mkdir(parents=True)
            command = (
                "set -eu; "
                "node /harness/src_overlay_apply.mjs "
                "--staging /probe/staging --src /probe/package/src; "
                "test \"$(stat -c %a /probe/package/src/nested)\" = 755; "
                "test \"$(stat -c %a /probe/package/src/nested/tool.mjs)\" = 755; "
                "mkdir -p /probe/package2/src /probe/outside; "
                "ln -s /probe/outside /probe/package2/src/nested; "
                "if node /harness/src_overlay_apply.mjs "
                "--staging /probe/staging --src /probe/package2/src; then exit 9; fi"
            )
            result = subprocess.run(
                [
                    docker,
                    "run",
                    "--rm",
                    "-v",
                    f"{root}:/probe",
                    "-v",
                    f"{HARNESS_ROOT}:/harness:ro",
                    "node:22-alpine",
                    "sh",
                    "-c",
                    command,
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


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
            "refusal-restart: API refusal "
            "(sess=late-fallback-primary); exiting 86 so Harbor retries a fresh trial",
            result.stdout,
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
        self.assertIn("refusal-gate: sid=double-refusal-1 refused=true", result.stdout)

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
            "refusal-restart: API refusal "
            "(sess=stub-session-1); exiting 86 so Harbor retries a fresh trial",
            result.stdout,
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
            "refusal-gate: sid=empty-resume-after-refusal refused=true",
            result.stdout,
        )
        self.assertIn("refusal-restart:", result.stdout)

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
                expected = (
                    "API refusal"
                    if gate == "refusal"
                    else "tiny final public response"
                )
                self.assertIn(f"refusal-restart: {expected}", result.stdout)
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

    def test_solo_review_dry_run_plumbs_explicit_workflow(self) -> None:
        result = self.run_launcher(
            "-Workflow", "solo-review", "-RouteProfile", "fable-xhigh"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], EXPECTED_AUDIT_LINE)
        self.assertIn("--ak workflow=solo-review", result.stdout)
        self.assertIn("--ak route_profile=fable-xhigh", result.stdout)

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
