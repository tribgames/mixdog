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
}
PROFILE_LEAD_PRESET_ID = "terminal-bench-route-profile-lead"


class RouteProfileError(ValueError):
    """A routing profile or its use is invalid."""


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


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

    known_roles = set(PROFILE_ROLES)
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
        if (
            not isinstance(routes, dict)
            or "lead" not in routes
            or not set(routes) <= known_roles
        ):
            missing = ["lead"] if isinstance(routes, dict) and "lead" not in routes else []
            extra = sorted(set(routes) - known_roles) if isinstance(routes, dict) else []
            raise RouteProfileError(
                f"profile {profile_name!r} must define lead and only known roles; "
                f"missing={missing!r}, extra={extra!r}"
            )
        for role in PROFILE_ROLES:
            if role in routes:
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


def build_benchmark_config(
    profile: dict[str, Any], workflow: str = "solo"
) -> dict[str, Any]:
    """Build a deterministic config containing benchmark-owned routing only."""
    validate_profile_document(
        {"schemaVersion": 1, "profiles": {"selected": copy.deepcopy(profile)}}
    )
    selected_workflow = str(workflow or "").strip() or "solo"
    routes = profile["routes"]
    lead_route = copy.deepcopy(routes["lead"])
    providers = {
        route["provider"]
        for route in routes.values()
    }
    if "leadFallback" in profile:
        providers.add(profile["leadFallback"]["provider"])
    provider_config = {
        provider: {
            "enabled": True,
            **({"websocket": True} if provider == "openai-oauth" else {}),
        }
        for provider in sorted(providers)
    }
    return {
        "outputStyle": "simple",
        "agent": {
            "profile": {"language": "en"},
            "providers": provider_config,
            "presets": [
                {
                    "id": PROFILE_LEAD_PRESET_ID,
                    "name": "TERMINAL BENCH ROUTE PROFILE LEAD",
                    "type": "agent",
                    "tools": "full",
                    **copy.deepcopy(lead_route),
                }
            ],
            "default": PROFILE_LEAD_PRESET_ID,
            "workflow": {"active": selected_workflow},
            "workflowRoutes": {"lead": copy.deepcopy(lead_route)},
            "agents": {
                config_key: copy.deepcopy(routes[role])
                for role, config_key in AGENT_CONFIG_KEYS.items()
                if role in routes
            },
            "modelSettings": {
                f"{lead_route['provider']}/{lead_route['model']}": {
                    "effort": lead_route["effort"],
                    "fast": lead_route["fast"],
                }
            },
            "mcpServers": {},
        }
    }


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


def format_resolved_routes(profile_name: str, profile: dict[str, Any]) -> str:
    """Produce stable, audit-friendly resolved-route logging."""
    parts = []
    for role in PROFILE_ROLES:
        if role not in profile["routes"]:
            continue
        route = profile["routes"][role]
        parts.append(
            f"{role}={route['provider']}/{route['model']} "
            f"effort={route['effort']} fast={str(route['fast']).lower()}"
        )
    return f"route-profile {profile_name}: " + "; ".join(parts)
