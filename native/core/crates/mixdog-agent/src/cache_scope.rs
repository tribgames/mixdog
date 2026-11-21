//! The `shared` prompt cache scope: a request whose calls are each
//! a new session and share one prefix is keyed on that prefix, not on its session, so a
//! key-prefix provider does not scatter the identical prefix across a fresh server-side lane
//! per call.
//!
//! Two callers take it: the explorer and the one-shot maintenance roles, which session
//! lifecycle and title completion send through.

/// The scope value every key-prefix provider reads (`RequestOptions.prompt_cache_scope`).
pub const SHARED: &str = "shared";

/// The declarative `kind: "maintenance"` plus
/// `toolSchemaProfile: "none"` pair of a hidden agent (`defaults/agents.json`), not role names.
pub fn is_one_shot_maintenance(kind: Option<&str>, tool_schema_profile: Option<&str>) -> bool {
    kind == Some("maintenance") && tool_schema_profile == Some("none")
}

/// The scope a hidden agent's requests carry.
pub fn one_shot_scope(kind: Option<&str>, tool_schema_profile: Option<&str>) -> Option<String> {
    is_one_shot_maintenance(kind, tool_schema_profile).then(|| SHARED.to_owned())
}

/// The breakpoints of a session-less loop whose system prompt and tool schemas are the same bytes on every
/// call (the explorers). Its readers are the parallel explorers of a fan-out and the next calls minutes
/// later, so the prefix is written once on the 5m tier and no 1h write is paid; only an explicit-breakpoint
/// provider has a strategy to state.
pub fn shared_prefix_strategy(provider: &str) -> Option<serde_json::Value> {
    matches!(provider, "anthropic" | "anthropic-oauth").then(|| serde_json::json!({ "tools": "none", "system": "5m", "tier3": "none", "messages": "5m" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_prefix_strategy_is_stated_for_explicit_breakpoint_providers_only() {
        let strategy = serde_json::json!({ "tools": "none", "system": "5m", "tier3": "none", "messages": "5m" });
        assert_eq!(shared_prefix_strategy("anthropic-oauth"), Some(strategy.clone()));
        assert_eq!(shared_prefix_strategy("anthropic"), Some(strategy));
        assert_eq!(shared_prefix_strategy("openai-oauth"), None);
    }

    #[test]
    fn only_the_maintenance_none_pair_is_shared() {
        assert_eq!(one_shot_scope(Some("maintenance"), Some("none")).as_deref(), Some("shared"));
        assert_eq!(one_shot_scope(Some("maintenance"), None), None);
        assert_eq!(one_shot_scope(Some("maintenance"), Some("full")), None);
        assert_eq!(one_shot_scope(Some("worker"), Some("none")), None);
        assert_eq!(one_shot_scope(None, None), None);
    }

    /// The shipped roles (`src/defaults/agents.json`): exactly the two one-shot maintenance
    /// roles qualify; the explorer takes the scope on its own path.
    #[test]
    fn the_shipped_roles_that_qualify_are_the_lifecycle_and_title_agents() {
        #[allow(clippy::disallowed_methods)] // test fixture loading
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../src/defaults/agents.json")).unwrap();
        let roles: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let shared: Vec<&str> = roles["agents"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| is_one_shot_maintenance(r["kind"].as_str(), r["toolSchemaProfile"].as_str()))
            .map(|r| r["agent"].as_str().unwrap())
            .collect();
        assert_eq!(shared, ["cycle1-agent", "title-agent"]);
    }
}
