//! `anthropic-beta` header: one set computed from the features the final
//! request body uses, never from model names.

use super::codec::Flavor;

const INTERLEAVED_THINKING: &str = "interleaved-thinking-2025-05-14";
const OAUTH: &str = "oauth-2025-04-20";
const CONTEXT_MANAGEMENT: &str = "context-management-2025-06-27";
const FAST_MODE: &str = "fast-mode-2026-02-01";
const TOOL_SEARCH: &str = "advanced-tool-use-2025-11-20";
const EFFORT: &str = "effort-2025-11-24";
const SERVER_SIDE_FALLBACK: &str = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_EFFORT: &str = super::effort_updates::BETA;
const THINKING_DISPLAY_UPDATES: &str = "thinking-display-updates-2026-08-18";
/// Turn-scoped mid-conversation system messages (`clear_at`), sent only when the request body carries one.
const TURN_SCOPED_SYSTEM: &str = "mid-conversation-system-clear-at-2026-08-21";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct BetaFeatures {
    pub fast_mode: bool,
    /// The body carries a `defer_loading` tool.
    pub tool_search: bool,
    /// The body carries `fallbacks: "default"`.
    pub server_fallback: bool,
    /// The body carries adaptive thinking with `output_config` effort support.
    pub effort: bool,
    pub thinking_display_updates: bool,
    /// The messages carry a turn-scoped `clear_at` system message.
    pub turn_scoped_system: bool,
    /// The history carries mid-conversation effort updates.
    pub mid_conversation_effort: bool,
}

/// Comma-joined, in the order the features are appended; each name once.
pub(crate) fn beta_header(flavor: Flavor, features: BetaFeatures) -> String {
    let mut names: Vec<&str> = match flavor {
        Flavor::ApiKey => vec![INTERLEAVED_THINKING],
        Flavor::OAuth => vec![OAUTH, INTERLEAVED_THINKING, CONTEXT_MANAGEMENT],
    };
    // The subscription route names it with its base set; the API-key route
    // appends it after the request-feature names.
    let mid = features.mid_conversation_effort;
    if mid && flavor == Flavor::OAuth {
        names.push(MID_CONVERSATION_EFFORT);
    }
    if features.fast_mode {
        names.push(FAST_MODE);
    }
    if features.tool_search {
        names.push(TOOL_SEARCH);
    }
    if features.effort {
        names.push(EFFORT);
    }
    if features.server_fallback {
        names.push(SERVER_SIDE_FALLBACK);
    }
    if features.thinking_display_updates {
        names.push(THINKING_DISPLAY_UPDATES);
    }
    if features.turn_scoped_system {
        names.push(TURN_SCOPED_SYSTEM);
    }
    if mid && flavor == Flavor::ApiKey {
        names.push(MID_CONVERSATION_EFFORT);
    }
    names.join(",")
}
