//! The internal agents (`isHiddenAgent`, internal-agents.mjs:175): the roles of
//! `defaults/agents.json` that have no configurable route. Read from the same asset Node reads;
//! when `defaults/` moves into a crate `data/` directory (K1) only the path below changes.

use std::collections::HashSet;

use serde_json::Value;

const AGENTS: &str = include_str!("../../../../../../../src/defaults/agents.json");

/// The `agent` name of every entry of the asset.
pub fn hidden_agents() -> HashSet<String> {
    let raw: Value = serde_json::from_str(AGENTS).unwrap_or(Value::Null);
    raw.get("agents")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(|e| e.get("agent").and_then(Value::as_str)).filter(|name| !name.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::hidden_agents;

    #[test]
    fn the_shipped_internal_agents_are_hidden() {
        let hidden = hidden_agents();
        for name in ["explore-agent", "cycle1-agent", "title-agent"] {
            assert!(hidden.contains(name), "{name}");
        }
        assert!(!hidden.contains("worker"));
    }
}
