"""Validated Terminal-Bench routing profiles and config overlay helpers."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


PROFILE_PATH = Path(__file__).with_name("route_profiles.json")
PROFILE_ROLES = (
    "lead",
    "worker",
    "heavy-worker",
    "reviewer",
    "debugger",
    "explorer",
)
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
ROUTE_FIELDS = {"provider", "model", "effort", "fast"}
PROFILE_REQUIRED_FIELDS = {"routes"}
PROFILE_OPTIONAL_FIELDS = {"leadFallback"}
AGENT_CONFIG_KEYS = {
    "worker": "worker",
    "heavy-worker": "heavy-worker",
    "reviewer": "reviewer",
    "debugger": "debugger",
    "explorer": "explore",
}
PROFILE_LEAD_PRESET_ID = "terminal-bench-route-profile-lead"


class RouteProfileError(ValueError):
    """A routing profile or its use is invalid."""


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _runtime_preset_index(presets: list[Any], selector: Any) -> int | None:
    """Mirror session-runtime/config-helpers.mjs findPreset() semantics."""
    def clean(value: Any) -> str:
        return str("" if value is None else value).strip().lower()

    wanted = clean(selector)
    if not wanted:
        return None
    for index, preset in enumerate(presets):
        if not isinstance(preset, dict):
            continue
        preset_id = clean(preset.get("id"))
        preset_name = clean(preset.get("name"))
        if preset_id == wanted or preset_name == wanted:
            return index
    return None


def _validate_route(profile_name: str, route_name: str, route: Any) -> None:
    if not isinstance(route, dict) or set(route) != ROUTE_FIELDS:
        raise RouteProfileError(
            f"profile {profile_name!r} route {route_name!r} must define exactly "
            "provider, model, effort, and fast"
        )
    if not _nonempty_string(route["provider"]) or not _nonempty_string(route["model"]):
        raise RouteProfileError(
            f"profile {profile_name!r} route {route_name!r} needs provider and model"
        )
    if route["effort"] not in EFFORTS:
        raise RouteProfileError(
            f"profile {profile_name!r} route {route_name!r} has invalid effort "
            f"{route['effort']!r}"
        )
    if type(route["fast"]) is not bool:
        raise RouteProfileError(
            f"profile {profile_name!r} route {route_name!r} fast must be boolean"
        )


def validate_profile_document(document: Any) -> dict[str, Any]:
    """Validate and return a routing-profile document."""
    if not isinstance(document, dict):
        raise RouteProfileError("routing profile document must be an object")
    if set(document) != {"schemaVersion", "profiles"}:
        raise RouteProfileError(
            "routing profile document must contain only schemaVersion and profiles"
        )
    if type(document["schemaVersion"]) is not int or document["schemaVersion"] != 1:
        raise RouteProfileError(
            f"unsupported routing profile schemaVersion: {document['schemaVersion']!r}"
        )
    profiles = document["profiles"]
    if not isinstance(profiles, dict) or not profiles:
        raise RouteProfileError("routing profile document needs a non-empty profiles object")

    expected_roles = set(PROFILE_ROLES)
    for profile_name, profile in profiles.items():
        if not _nonempty_string(profile_name):
            raise RouteProfileError("routing profile names must be non-empty strings")
        profile_fields = set(profile) if isinstance(profile, dict) else set()
        if (
            not isinstance(profile, dict)
            or not PROFILE_REQUIRED_FIELDS <= profile_fields
            or profile_fields - PROFILE_REQUIRED_FIELDS - PROFILE_OPTIONAL_FIELDS
        ):
            raise RouteProfileError(
                f"profile {profile_name!r} must contain routes and optionally leadFallback"
            )
        if "leadFallback" in profile:
            _validate_route(profile_name, "leadFallback", profile["leadFallback"])
        routes = profile["routes"]
        if not isinstance(routes, dict) or set(routes) != expected_roles:
            missing = sorted(expected_roles - set(routes)) if isinstance(routes, dict) else []
            extra = sorted(set(routes) - expected_roles) if isinstance(routes, dict) else []
            raise RouteProfileError(
                f"profile {profile_name!r} must define exactly {list(PROFILE_ROLES)!r}; "
                f"missing={missing!r}, extra={extra!r}"
            )
        for role in PROFILE_ROLES:
            _validate_route(profile_name, role, routes[role])
    return document


def load_route_profile(
    profile_name: str, profile_path: Path = PROFILE_PATH
) -> dict[str, Any]:
    """Load one named profile from the harness single source."""
    try:
        document = json.loads(profile_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RouteProfileError(f"cannot load routing profiles from {profile_path}: {exc}") from exc
    profiles = validate_profile_document(document)["profiles"]
    if profile_name not in profiles:
        available = ", ".join(sorted(profiles))
        raise RouteProfileError(
            f"unknown routing profile {profile_name!r}; available: {available}"
        )
    return copy.deepcopy(profiles[profile_name])


def reject_profile_conflicts(
    profile_name: str | None,
    *,
    provider: str | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> None:
    """Reject ambiguous profile plus explicit Lead-route overrides."""
    if profile_name and any(
        isinstance(value, str) and bool(value.strip())
        for value in (provider, model, effort)
    ):
        raise RouteProfileError(
            "route_profile cannot be combined with provider, model, or effort overrides"
        )


def merge_route_profile(
    host_config: Any, profile: dict[str, Any]
) -> dict[str, Any]:
    """Return a copied config with only the six benchmark routes replaced."""
    if not isinstance(host_config, dict):
        raise RouteProfileError("host mixdog config must be an object")
    agent = host_config.get("agent")
    if not isinstance(agent, dict):
        raise RouteProfileError("host mixdog config has no agent object")

    merged = copy.deepcopy(host_config)
    merged_agent = merged["agent"]
    workflow_routes = merged_agent.get("workflowRoutes")
    if not isinstance(workflow_routes, dict):
        workflow_routes = {}
        merged_agent["workflowRoutes"] = workflow_routes
    agent_routes = merged_agent.get("agents")
    if not isinstance(agent_routes, dict):
        agent_routes = {}
        merged_agent["agents"] = agent_routes

    routes = profile["routes"]
    lead_route = copy.deepcopy(routes["lead"])
    workflow_routes["lead"] = copy.deepcopy(lead_route)

    # Runtime startup resolves config.default before workflow routing. Update
    # that referenced preset in place (preserving its identity/metadata and all
    # unrelated presets); if the host has no resolvable default, add one stable
    # benchmark preset and point default at it.
    presets = merged_agent.get("presets")
    if not isinstance(presets, list):
        presets = []
        merged_agent["presets"] = presets
    original_default = merged_agent.get("default")
    default_index = _runtime_preset_index(presets, original_default)
    if default_index is None:
        # Resolve the fallback with the same first-match id-or-name semantics
        # as startup. Reusing that first match prevents an earlier stale alias
        # from shadowing a newly appended profile preset.
        default_index = _runtime_preset_index(presets, PROFILE_LEAD_PRESET_ID)
        merged_agent["default"] = PROFILE_LEAD_PRESET_ID
    if default_index is None:
        presets.append(
            {
                "id": PROFILE_LEAD_PRESET_ID,
                "name": "TERMINAL BENCH ROUTE PROFILE LEAD",
                "type": "agent",
                "tools": "full",
                **lead_route,
            }
        )
        default_index = len(presets) - 1
    else:
        presets[default_index] = {**presets[default_index], **lead_route}
    # A resolved host selector is intentionally retained byte-for-byte. Turning
    # a name selector into the selected preset's id can make an earlier preset
    # whose name equals that id shadow the preset startup originally selected.

    # Saved model settings override preset effort/fast in the real startup
    # resolver, so pin those authoritative values for the profiled Lead model.
    model_settings = merged_agent.get("modelSettings")
    if not isinstance(model_settings, dict):
        model_settings = {}
        merged_agent["modelSettings"] = model_settings
    lead_settings_key = f"{lead_route['provider']}/{lead_route['model']}"
    existing_lead_settings = model_settings.get(lead_settings_key)
    if not isinstance(existing_lead_settings, dict):
        existing_lead_settings = {}
    model_settings[lead_settings_key] = {
        **existing_lead_settings,
        "effort": lead_route["effort"],
        "fast": lead_route["fast"],
    }

    for role, config_key in AGENT_CONFIG_KEYS.items():
        agent_routes[config_key] = copy.deepcopy(routes[role])
    return merged


def format_resolved_routes(profile_name: str, profile: dict[str, Any]) -> str:
    """Produce stable, audit-friendly resolved-route logging."""
    parts = []
    for role in PROFILE_ROLES:
        route = profile["routes"][role]
        parts.append(
            f"{role}={route['provider']}/{route['model']} "
            f"effort={route['effort']} fast={str(route['fast']).lower()}"
        )
    return f"route-profile {profile_name}: " + "; ".join(parts)
