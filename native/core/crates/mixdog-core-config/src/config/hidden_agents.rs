//! The internal agents (`isHiddenAgent`, internal-agents.mjs:175): the roles of
//! `defaults/agents.json` that have no configurable route. Read from the same asset Node reads;
//! when `defaults/` moves into a crate `data/` directory (K1) only the path below changes.

use std::collections::HashSet;

use serde_json::Value;

const AGENTS: &str = include_str!("../../../../../../src/defaults/agents.json");

/// The `agent` name of every entry of the asset.
pub fn hidden_agents() -> HashSet<String> {
    let raw: Value = serde_json::from_str(AGENTS).unwrap_or(Value::Null);
    raw.get("agents")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(|e| e.get("agent").and_then(Value::as_str)).filter(|name| !name.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `getHiddenAgent(name)`'s `kind` and `toolSchemaProfile`: `None` for a name that is not an
/// internal agent, `Some((kind, profile))` otherwise (either `None` when the entry has none).
pub fn hidden_agent_traits(name: &str) -> Option<(Option<String>, Option<String>)> {
    let raw: Value = serde_json::from_str(AGENTS).unwrap_or(Value::Null);
    let entry = raw.get("agents")?.as_array()?.iter().rev().find(|e| e.get("agent").and_then(Value::as_str) == Some(name))?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    Some((text("kind"), text("toolSchemaProfile")))
}

#[cfg(test)]
mod tests {
    use super::{hidden_agent_traits, hidden_agents};

    #[test]
    fn the_traits_of_an_internal_agent_are_its_kind_and_profile() {
        assert_eq!(hidden_agent_traits("title-agent"), Some((Some("maintenance".into()), Some("none".into()))));
        assert_eq!(hidden_agent_traits("worker"), None);
    }

    #[test]
    fn the_shipped_internal_agents_are_hidden() {
        let hidden = hidden_agents();
        for name in ["explore-agent", "cycle1-agent", "title-agent"] {
            assert!(hidden.contains(name), "{name}");
        }
        assert!(!hidden.contains("worker"));
    }
}
