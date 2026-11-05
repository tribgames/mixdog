//! Project scopes of skills, MCP servers and plugins (`config.extensionScopes`). Everything is
//! installed machine-wide; a scope only decides which sessions see an extension: an entry lists
//! the project roots it is limited to, and a session whose cwd is inside one of them gets it.
//! No entry means global.

use std::path::Path;

use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Value;

use crate::skills::Skill;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopeKind {
    Skills,
    Mcp,
    Plugins,
}

impl ScopeKind {
    fn parse(text: &str) -> Option<Self> {
        [Self::Skills, Self::Mcp, Self::Plugins].into_iter().find(|k| k.key() == text)
    }

    fn key(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Mcp => "mcp",
            Self::Plugins => "plugins",
        }
    }
}

/// `path.resolve(text)`: absolute, with `.` and `..` folded away.
pub(crate) fn resolve_path(text: &str) -> Option<String> {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for component in std::path::absolute(text).ok()?.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out.to_string_lossy().into_owned())
}

/// An absolute path without a trailing separator (a drive root stays whole).
fn normalize_root(value: &str) -> Option<String> {
    let text = js_trim(value);
    if text.is_empty() {
        return None;
    }
    let mut path = resolve_path(text)?;
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

/// `normalizeRootList`: each item is stringified, resolved, de-duplicated and sorted.
fn normalize_root_list(value: &Value) -> Vec<String> {
    let list: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        single => vec![single],
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut kept: Vec<String> = list
        .into_iter()
        .filter(|item| !item.is_null())
        .filter_map(|item| normalize_root(&value_to_string(item)))
        .filter(|root| seen.insert(comparable(root)))
        .collect();
    kept.sort_by(|a, b| locale_compare(a, b));
    kept
}

/// Sets `name` in an entry list: an existing entry keeps its place, a new one goes last.
fn put(entries: &mut Vec<(String, Vec<String>)>, name: &str, roots: Vec<String>) {
    match entries.iter_mut().find(|(n, _)| n == name) {
        Some(entry) => entry.1 = roots,
        None => entries.push((name.to_owned(), roots)),
    }
}

/// Why a scope change was refused (the messages are Node's).
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum ScopeError {
    #[error("extension scope kind must be one of skills, mcp, plugins")]
    BadKind,
    #[error("MCP servers are switched off per project in Project settings (setProjectConnectorEnabled)")]
    McpNotScopable,
    #[error("extension name is required")]
    NameRequired,
    #[error("plugin not registered: {0}")]
    PluginNotRegistered(String),
}

/// A validated scope change: the new config and the kind whose status the caller answers.
#[derive(Clone, PartialEq, Debug)]
pub struct ScopeChange {
    pub kind: ScopeKind,
    pub config: Value,
}

fn clean(value: &Value) -> String {
    if value.is_null() { String::new() } else { js_trim(&value_to_string(value)).to_owned() }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `setExtensionScope` up to persisting: validates `kind` and `name`, resolves a plugin's
/// registry id from the status rows `plugins`, and returns the config with that entry set
/// (`projects` null or empty makes it global). The caller saves it, announces the kind and answers
/// that kind's status.
pub fn plan_extension_scope(
    config: &Value,
    kind: &Value,
    name: &Value,
    projects: &Value,
    plugins: &[Value],
) -> Result<ScopeChange, ScopeError> {
    let kind = ScopeKind::parse(&clean(kind)).ok_or(ScopeError::BadKind)?;
    if kind == ScopeKind::Mcp {
        return Err(ScopeError::McpNotScopable);
    }
    let mut key = clean(name);
    if key.is_empty() {
        return Err(ScopeError::NameRequired);
    }
    if kind == ScopeKind::Plugins {
        let row = plugins
            .iter()
            .find(|row| ["id", "name", "title"].iter().any(|f| clean(row.get(*f).unwrap_or(&Value::Null)) == key))
            .ok_or_else(|| ScopeError::PluginNotRegistered(key.clone()))?;
        let id = row.get("id").filter(|v| truthy(v)).or_else(|| row.get("name")).unwrap_or(&Value::Null);
        key = clean(id);
    }
    // `setExtensionScope` hands the list through: an array as is, null as none, a single value
    // as a one-item list.
    let roots = match projects {
        Value::Null => Vec::new(),
        other => normalize_root_list(other),
    };
    let mut scopes = ExtensionScopes::from_config(config.get("extensionScopes").unwrap_or(&Value::Null));
    scopes.set(kind, &key, roots);
    let mut next = config.as_object().cloned().unwrap_or_default();
    next.insert("extensionScopes".into(), scopes.to_config());
    Ok(ScopeChange { kind, config: Value::Object(next) })
}

/// The persisted scope map: `{ skills: {name: [root…]}, mcp: {…}, plugins: {…} }`, entries in
/// the order they were written.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct ExtensionScopes {
    maps: [Vec<(String, Vec<String>)>; 3],
}

impl ExtensionScopes {
    pub fn from_config(value: &Value) -> Self {
        let mut scopes = Self::default();
        for kind in [ScopeKind::Skills, ScopeKind::Mcp, ScopeKind::Plugins] {
            for (name, roots) in value.get(kind.key()).and_then(Value::as_object).into_iter().flatten() {
                let name = js_trim(name);
                let kept = normalize_root_list(roots);
                // An empty list is the same as no entry: global.
                if !name.is_empty() && !kept.is_empty() {
                    put(&mut scopes.maps[kind as usize], name, kept);
                }
            }
        }
        scopes
    }

    /// Replaces one entry; no roots removes it (global).
    pub fn set(&mut self, kind: ScopeKind, name: &str, roots: Vec<String>) {
        let entries = &mut self.maps[kind as usize];
        if roots.is_empty() {
            entries.retain(|(n, _)| n != name);
        } else {
            put(entries, name, roots);
        }
    }

    /// The JSON object as Node writes it: integer-like names first in ascending order, then the
    /// rest in insertion order.
    pub fn to_config(&self) -> Value {
        let mut out = serde_json::Map::new();
        for kind in [ScopeKind::Skills, ScopeKind::Mcp, ScopeKind::Plugins] {
            let index = |name: &str| {
                let canonical = name == "0" || (!name.starts_with('0') && !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()));
                if canonical { name.parse::<u32>().ok().filter(|n| *n != u32::MAX) } else { None }
            };
            let entries = &self.maps[kind as usize];
            let mut ordered: Vec<&(String, Vec<String>)> = entries.iter().collect();
            ordered.sort_by_key(|(name, _)| index(name).map_or((1, 0), |n| (0, n)));
            let map: serde_json::Map<String, Value> =
                ordered.into_iter().map(|(name, roots)| (name.clone(), Value::from(roots.clone()))).collect();
            out.insert(kind.key().to_owned(), Value::Object(map));
        }
        Value::Object(out)
    }

    /// The project roots an entry is limited to, or `None` when it is global.
    pub fn projects(&self, kind: ScopeKind, name: &str) -> Option<&[String]> {
        let name = js_trim(name);
        self.maps[kind as usize].iter().find(|(n, _)| n == name).map(|(_, roots)| roots.as_slice())
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
