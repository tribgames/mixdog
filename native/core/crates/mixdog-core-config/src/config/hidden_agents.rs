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

/// `getHiddenAgent(name).stallCap.idleSeconds`: the internal agent's own idle budget in seconds,
/// when it names a positive one (`resolveAgentStallThresholds` reads `> 0`).
pub fn hidden_agent_stall_cap_idle_seconds(name: &str) -> Option<i64> {
    let raw: Value = serde_json::from_str(AGENTS).unwrap_or(Value::Null);
    let entry = raw.get("agents")?.as_array()?.iter().rev().find(|e| e.get("agent").and_then(Value::as_str) == Some(name))?;
    let seconds = entry.get("stallCap")?.get("idleSeconds")?.as_f64()?;
    (seconds > 0.0).then_some(seconds as i64)
}

/// The `systemFile` of each internal agent, as the same asset Node reads (`readFileSync(join(root, systemFile))`).
/// A test asserts every `systemFile` of `agents.json` is listed here.
const SYSTEM_FILES: [(&str, &str); 2] = [
    ("rules/agent/40-cycle1-agent.md", include_str!("../../../../../../src/rules/agent/40-cycle1-agent.md")),
    ("rules/agent/43-title-agent.md", include_str!("../../../../../../src/rules/agent/43-title-agent.md")),
];

/// `clean(value)`: the trimmed text.
fn clean(text: &str) -> &str {
    mixdog_js::js_trim(text)
}

/// `parseMarkdownFrontmatter`: `^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)` then
/// `^([A-Za-z0-9_-]+):\s*(.*?)\s*$` per line, the value without one leading and one trailing quote.
fn frontmatter(markdown: &str) -> Vec<(String, String)> {
    let Some(rest) = markdown.strip_prefix("---") else { return Vec::new() };
    let rest = rest.trim_start_matches([' ', '\t']);
    let Some(rest) = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')) else { return Vec::new() };
    // The shortest block followed by a line that holds only `---`; the first line cannot close it,
    // because the closing fence needs the newline of the line before.
    let mut end = None;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if offset > 0 && bare.trim_end_matches([' ', '\t']) == "---" {
            end = Some(offset);
            break;
        }
        offset += line.len();
    }
    let Some(end) = end else { return Vec::new() };
    let block = rest[..end].trim_end_matches(['\r', '\n']);
    let unquote = |value: &str| -> String {
        let value = clean(value);
        let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
        clean(value.strip_suffix(['\'', '"']).unwrap_or(value)).to_owned()
    };
    block
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            (!key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).then(|| (key.to_owned(), unquote(value)))
        })
        .collect()
}

/// `normalizeAgentPermissionOrNone`: `None` for no value, the canonical name of an alias, else `none`.
fn permission(raw: &str) -> Option<&'static str> {
    let raw = clean(raw);
    if raw.is_empty() {
        return None;
    }
    Some(match raw.to_lowercase().as_str() {
        "none" => "none",
        "readonly" | "read-only" | "read" => "read",
        "write" | "readwrite" | "read_write" | "read-write" => "read-write",
        "mcp" => "mcp",
        "full" => "full",
        _ => "none",
    })
}

/// `getHiddenAgent(name)`: the entry of `defaults/agents.json` with the `permission`,
/// `toolSchemaProfile`, `kind`, `slot` and `maintKey` of its `systemFile` frontmatter over it; `None`
/// for a name that is not an internal agent. The last entry of a name wins, as Node's map does.
pub fn hidden_agent(name: &str) -> Option<Value> {
    if name.is_empty() {
        return None;
    }
    let raw: Value = serde_json::from_str(AGENTS).unwrap_or(Value::Null);
    let entry = raw.get("agents")?.as_array()?.iter().rev().find(|e| e.get("agent").and_then(Value::as_str) == Some(name))?;
    let mut merged = entry.as_object()?.clone();
    let file = entry.get("systemFile").and_then(Value::as_str).map(clean).unwrap_or_default();
    let meta = SYSTEM_FILES.iter().find(|(path, _)| *path == file).map(|(_, text)| frontmatter(text)).unwrap_or_default();
    let field = |key: &str| meta.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    if let Some(permission) = field("permission").and_then(permission) {
        merged.insert("permission".into(), Value::String(permission.into()));
    }
    for key in ["toolSchemaProfile", "kind", "slot", "maintKey"] {
        if let Some(value) = field(key).filter(|v| !v.is_empty()) {
            merged.insert(key.into(), Value::String(value.into()));
        }
    }
    Some(Value::Object(merged))
}
#[cfg(test)]
mod tests {
    use super::{hidden_agent_stall_cap_idle_seconds, hidden_agent_traits, hidden_agents};

    #[test]
    fn the_stall_caps_are_what_node_read_off_the_internal_agents() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/agent-watchdog/golden.json")).unwrap();
        let caps = golden["stallCaps"].as_object().unwrap();
        assert!(!caps.is_empty());
        for (name, recorded) in caps {
            assert_eq!(hidden_agent_stall_cap_idle_seconds(name), recorded.as_i64(), "{name}");
        }
    }

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

    #[test]
    fn a_hidden_agent_is_what_node_merged_from_the_asset_and_the_frontmatter() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/agent-world/golden.json")).unwrap();
        for case in golden["hiddenAgents"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let want = (!case["agent"].is_null()).then(|| case["agent"].clone());
            assert_eq!(super::hidden_agent(name), want, "{name}");
        }
    }

    #[test]
    fn every_system_file_of_the_asset_is_embedded() {
        let raw: serde_json::Value = serde_json::from_str(super::AGENTS).unwrap();
        for entry in raw["agents"].as_array().unwrap() {
            if let Some(file) = entry.get("systemFile").and_then(serde_json::Value::as_str) {
                assert!(super::SYSTEM_FILES.iter().any(|(path, _)| *path == file), "{file} is not embedded");
            }
        }
    }

    #[test]
    fn frontmatter_reads_keys_unquotes_values_and_ignores_the_rest() {
        let meta = super::frontmatter("---\npermission: \"read\"  \nkind: 'maintenance'\nnot a pair\nx-y_1: a: b\n---\nbody: no\n");
        assert_eq!(meta, [("permission".into(), "read".into()), ("kind".into(), "maintenance".into()), ("x-y_1".into(), "a: b".into())]);
        assert!(super::frontmatter("no fence\n---\nkind: x\n---\n").is_empty());
        assert_eq!(super::permission("Read-Only"), Some("read"));
        assert_eq!(super::permission("bogus"), Some("none"));
        assert_eq!(super::permission("  "), None);
    }}
