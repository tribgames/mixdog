"""Codex baseline variant with the native web_search tool hard-disabled.

Fairness contract: the mixdog bench surface runs with MIXDOG_FEATURE_WEB_SEARCH
off (matching the product headless surface), but the stock Harbor Codex
agent ships the Responses ``web_search`` tool enabled — the 2026-08-02 full run
used it 50 times across 14 tasks, including lookups of the benchmark's own
test files.

POSTMORTEM (2026-08-11 fair run): the first revision passed
``-c tools.web_search=false``, which codex ACCEPTS but silently DISCARDS —
``ConfigToml.tools.web_search`` is a WebSearchToolConfig struct (context_size/
allowed_domains/location) and its untagged deserializer maps a bare boolean to
``None`` for backward compatibility (config_toml.rs
deserialize_optional_web_search_tool_config). With no explicit mode, codex fell
back to the requirements default ``WebSearchMode::Cached`` and still ran 54 web
searches across 15 tasks. The real kill switch is the TOP-LEVEL
``web_search = "disabled"`` (WebSearchMode: disabled|cached|indexed|live),
which resolve_web_search_mode prefers over every feature flag and which
disables both the hosted and the standalone web_search tool paths
(hosted_spec.rs returns None for Disabled).

Override with ``--ak web_search=live`` if search parity is ever wanted.
"""

from harbor.agents.installed.base import CliFlag
from harbor.agents.installed.codex import Codex


class CodexNoSearch(Codex):
    CLI_FLAGS = Codex.CLI_FLAGS + [
        CliFlag(
            "web_search",
            cli="-c",
            type="str",
            default="disabled",
            format="-c web_search={value}",
        ),
    ]
