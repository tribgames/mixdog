//! Project scopes of skills, MCP servers and plugins (`config.extensionScopes`). Everything is
//! installed machine-wide; a scope only decides which sessions see an extension: an entry lists
//! the project roots it is limited to, and a session whose cwd is inside one of them gets it.
//! No entry means global.

use std::collections::BTreeMap;
use std::path::Path;

use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::utf16_len;
use serde_json::Value;

use crate::skills::Skill;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopeKind {
    Skills,
    Mcp,
    Plugins,
}

impl ScopeKind {
    fn key(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Mcp => "mcp",
            Self::Plugins => "plugins",
        }
    }
}

/// An absolute path without a trailing separator (a drive root stays whole).
fn normalize_root(value: &str) -> Option<String> {
    let text = js_trim(value);
    if text.is_empty() {
        return None;
    }
    let mut path = std::path::absolute(text).ok()?.to_string_lossy().into_owned();
    while utf16_len(&path) > 3 && (path.ends_with(std::path::MAIN_SEPARATOR) || path.ends_with('/')) {
        path.pop();
    }
    Some(path)
}

fn comparable(path: &str) -> String {
    let unified: String = path.chars().map(|c| if c == '/' || c == '\\' { std::path::MAIN_SEPARATOR } else { c }).collect();
    if cfg!(windows) { unified.to_lowercase() } else { unified }
}

/// Whether `cwd` is one of the roots or sits below one of them (an empty list matches all).
pub fn within_projects(cwd: &Path, roots: &[String]) -> bool {
    if roots.is_empty() {
        return true;
    }
    let Some(here) = normalize_root(&cwd.to_string_lossy()) else { return false };
    let target = comparable(&here);
    roots.iter().filter_map(|root| normalize_root(root)).any(|root| {
        let base = comparable(&root);
        if target == base {
            return true;
        }
        let prefix = if base.ends_with(std::path::MAIN_SEPARATOR) { base } else { format!("{base}{}", std::path::MAIN_SEPARATOR) };
        target.starts_with(&prefix)
    })
}

/// The persisted scope map: `{ skills: {name: [root…]}, mcp: {…}, plugins: {…} }`.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct ExtensionScopes {
    maps: BTreeMap<&'static str, BTreeMap<String, Vec<String>>>,
}

impl ExtensionScopes {
    pub fn from_config(value: &Value) -> Self {
        let mut maps = BTreeMap::new();
        for kind in [ScopeKind::Skills, ScopeKind::Mcp, ScopeKind::Plugins] {
            let mut map = BTreeMap::new();
            for (name, roots) in value.get(kind.key()).and_then(Value::as_object).into_iter().flatten() {
                let name = js_trim(name);
                let list: Vec<&Value> = match roots {
                    Value::Array(items) => items.iter().collect(),
                    Value::Null => Vec::new(),
                    single => vec![single],
                };
                let mut seen = std::collections::BTreeSet::new();
                let mut kept: Vec<String> = list
                    .into_iter()
                    .filter_map(Value::as_str)
                    .filter_map(normalize_root)
                    .filter(|root| seen.insert(comparable(root)))
                    .collect();
                kept.sort_by(|a, b| locale_compare(a, b));
                // An empty list is the same as no entry: global.
                if !name.is_empty() && !kept.is_empty() {
                    map.insert(name.to_owned(), kept);
                }
            }
            maps.insert(kind.key(), map);
        }
        Self { maps }
    }

    /// The project roots an entry is limited to, or `None` when it is global.
    pub fn projects(&self, kind: ScopeKind, name: &str) -> Option<&[String]> {
        self.maps.get(kind.key())?.get(js_trim(name)).map(Vec::as_slice)
    }

    pub fn allowed_for_cwd(&self, kind: ScopeKind, name: &str, cwd: &Path) -> bool {
        self.projects(kind, name).is_none_or(|roots| within_projects(cwd, roots))
    }

    /// A skill is visible when neither its own scope nor its plugin's excludes `cwd`.
    pub fn skill_allowed_for_cwd(&self, skill: &Skill, cwd: &Path) -> bool {
        if !self.allowed_for_cwd(ScopeKind::Skills, &skill.name, cwd) {
            return false;
        }
        skill.plugin.as_deref().is_none_or(|id| self.allowed_for_cwd(ScopeKind::Plugins, id, cwd))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_session_inside_a_root_sees_the_extension_and_others_do_not() {
        let root = std::env::temp_dir().join("proj-a");
        let scopes = ExtensionScopes::from_config(&json!({"skills": {"deploy": [root.to_string_lossy()]}, "mcp": {"x": []}}));
        assert!(scopes.allowed_for_cwd(ScopeKind::Skills, "deploy", &root.join("src")));
        assert!(scopes.allowed_for_cwd(ScopeKind::Skills, "deploy", &root));
        assert!(!scopes.allowed_for_cwd(ScopeKind::Skills, "deploy", &std::env::temp_dir().join("proj-ab")));
        assert!(scopes.allowed_for_cwd(ScopeKind::Skills, "other", Path::new("/anywhere")));
        assert!(scopes.allowed_for_cwd(ScopeKind::Mcp, "x", Path::new("/anywhere")));
    }
}
