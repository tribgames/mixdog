//! Plugin manifests, the plugin registry, the MCP servers plugins declare and the user's
//! per-server intents (T §4 config sources). Reading touches the filesystem, so every reader
//! takes an [`InLane`] proof of the maintenance lane; the parsing helpers are pure.

use std::collections::BTreeMap;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::js_trim;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;

use crate::config::ConfigError;
use crate::config::transport_kind;

/// Manifest files in precedence order.
pub const MANIFEST_FILES: [&str; 3] = [".codex-plugin/plugin.json", "plugin.json", ".claude-plugin/plugin.json"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PluginFormat {
    Codex,
    Mixdog,
    Claude,
    None,
}

fn format_of(manifest_file: &str) -> PluginFormat {
    match manifest_file {
        ".codex-plugin/plugin.json" => PluginFormat::Codex,
        "plugin.json" => PluginFormat::Mixdog,
        _ => PluginFormat::Claude,
    }
}

/// `root` joined with `relative`, refusing absolute paths and anything that leaves `root`.
pub fn resolve_contained(root: &Path, relative: &str) -> Option<PathBuf> {
    let trimmed = js_trim(relative);
    if trimmed.is_empty() || Path::new(trimmed).is_absolute() || trimmed.starts_with(['/', '\\']) {
        return None;
    }
    let mut out = root.to_path_buf();
    let mut depth = 0usize;
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => {
                out.push(part);
                depth += 1;
            }
            Component::ParentDir => {
                depth = depth.checked_sub(1)?;
                out.pop();
            }
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(out)
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| match e.raw_os_error() {
        Some(code) => format!("cannot read file (os error {code})"),
        None => "cannot read file".to_owned(),
    })?;
    serde_json::from_str(&text).map_err(|e| {
        if e.is_eof() {
            "invalid JSON: unexpected end of input".to_owned()
        } else {
            // Location only: the offending text may hold credentials.
            format!("invalid JSON at line {} column {}", e.line(), e.column())
        }
    })
}

/// The first readable manifest with its format; a plugin without one is an empty manifest.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn manifest(_lane: &InLane<MaintenanceIo>, root: &Path) -> (PluginFormat, Value) {
    for file in MANIFEST_FILES {
        if let Ok(value) = read_json(&root.join(file))
            && value.is_object()
        {
            return (format_of(file), value);
        }
    }
    (PluginFormat::None, Value::Object(Map::new()))
}

/// Skill roots a plugin contributes: `<root>/skills/` plus the manifest `skills` path or list.
pub fn skills_roots(lane: &InLane<MaintenanceIo>, root: &Path) -> Vec<PathBuf> {
    let (_, manifest) = manifest(lane, root);
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut add = |relative: &str| {
        if let Some(path) = resolve_contained(root, relative)
            && !roots.contains(&path)
        {
            roots.push(path);
        }
    };
    add("./skills/");
    match manifest.get("skills") {
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).for_each(&mut add),
        Some(Value::String(one)) => add(one),
        _ => {}
    }
    roots
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RegisteredPlugin {
    pub id: String,
    pub root: PathBuf,
    pub enabled: bool,
}

/// `<data>/plugins/registry.json`; entries whose root is missing are skipped.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn read_registry(_lane: &InLane<MaintenanceIo>, data_dir: &Path) -> Vec<RegisteredPlugin> {
    let Ok(registry) = read_json(&data_dir.join("plugins").join("registry.json")) else {
        return Vec::new();
    };
    registry
        .get("plugins")
        .and_then(Value::as_array)
        .map(|plugins| {
            plugins
                .iter()
                .filter_map(|entry| {
                    let root = PathBuf::from(entry.get("root")?.as_str()?);
                    if !root.exists() {
                        return None;
                    }
                    let id = ["id", "name"]
                        .iter()
                        .find_map(|k| entry.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                        .unwrap_or_default()
                        .to_owned();
                    Some(RegisteredPlugin {
                        id,
                        root,
                        enabled: entry.get("enabled").and_then(Value::as_bool) != Some(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, PartialEq, Debug)]
pub struct DeclaredServer {
    pub key: String,
    pub config: Value,
    pub source: PathBuf,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeclarationError {
    pub source: PathBuf,
    pub key: Option<String>,
    pub message: String,
}

#[derive(Clone, PartialEq, Debug)]
pub struct PluginMcpDeclarations {
    pub format: PluginFormat,
    pub servers: Vec<DeclaredServer>,
    pub errors: Vec<DeclarationError>,
}

/// Why a declared entry cannot be launched; names fields and types, never a configured value.
fn server_problem(entry: &Value) -> Option<String> {
    if !entry.is_object() {
        return Some("server entry must be an object".to_owned());
    }
    let non_empty = |key: &str| entry.get(key).and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty());
    match transport_kind(entry) {
        Err(ConfigError::UnknownType) => Some(ConfigError::UnknownType.to_string()),
        Err(_) => None,
        Ok(crate::config::TransportKind::Stdio) => (!non_empty("command")).then(|| "stdio server requires \"command\"".to_owned()),
        Ok(kind) => {
            let label = match kind {
                crate::config::TransportKind::Sse => "sse",
                crate::config::TransportKind::WebSocket => "ws",
                _ => "http",
            };
            (!non_empty("url")).then(|| format!("{label} server requires \"url\""))
        }
    }
}

struct Collector {
    servers: BTreeMap<String, DeclaredServer>,
    errors: Vec<DeclarationError>,
}

impl Collector {
    fn error(&mut self, source: &Path, key: Option<&str>, message: impl Into<String>) {
        self.errors.push(DeclarationError {
            source: source.to_path_buf(),
            key: key.map(str::to_owned),
            message: message.into(),
        });
    }

    /// A `{ mcpServers: {...} }` wrapper or a bare server map -> the server map.
    fn server_map<'a>(&mut self, doc: &'a Value, source: &Path, where_: &str) -> Option<&'a Map<String, Value>> {
        let Some(object) = doc.as_object() else {
            self.error(source, None, format!("{where_}MCP declaration must be an object"));
            return None;
        };
        match object.get("mcpServers") {
            None => Some(object),
            Some(Value::Object(map)) => Some(map),
            Some(_) => {
                self.error(source, None, format!("{where_}\"mcpServers\" must be an object"));
                None
            }
        }
    }

    fn add_all(&mut self, map: &Map<String, Value>, source: &Path) {
        for (key, config) in map {
            match server_problem(config) {
                Some(problem) => self.error(source, Some(key), problem),
                None => {
                    self.servers.insert(
                        key.clone(),
                        DeclaredServer { key: key.clone(), config: config.clone(), source: source.to_path_buf() },
                    );
                }
            }
        }
    }

    fn load_file(&mut self, path: &Path) {
        match read_json(path) {
            Ok(doc) => {
                if let Some(map) = self.server_map(&doc, path, "") {
                    self.add_all(map, path);
                }
            }
            Err(message) => self.error(path, None, message),
        }
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
    fn load_declared_path(&mut self, root: &Path, relative: &Value, manifest: &Path, where_: &str) {
        let Some(text) = relative.as_str().filter(|s| !js_trim(s).is_empty()) else {
            self.error(manifest, None, format!("{where_}MCP path must be a non-empty string"));
            return;
        };
        let contained = resolve_contained(root, text);
        let Some(path) = contained.filter(|_| !text.split(['/', '\\']).any(|part| part == "..")) else {
            self.error(manifest, None, format!("{where_}MCP path must be relative and stay inside the plugin root"));
            return;
        };
        if !path.exists() {
            self.error(manifest, None, format!("{where_}MCP file not found"));
            return;
        }
        self.load_file(&path);
    }
}

/// What a plugin declares for MCP: `<root>/.mcp.json` first, then the manifest `mcpServers`
/// (a path, an inline object, or a list mixing both). Later sources override earlier ones by
/// key. Never fails for plugin content; errors carry locations and field names, never values.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn load_declarations(lane: &InLane<MaintenanceIo>, root: &Path) -> PluginMcpDeclarations {
    let mut collector = Collector { servers: BTreeMap::new(), errors: Vec::new() };
    let found = MANIFEST_FILES.iter().find(|f| root.join(f).exists()).copied();
    let mcp_json = root.join(".mcp.json");
    let has_mcp_json = mcp_json.exists();
    let format = match found {
        Some(file) => format_of(file),
        None if has_mcp_json => PluginFormat::Claude,
        None => PluginFormat::None,
    };
    if has_mcp_json {
        collector.load_file(&mcp_json);
    }
    if let Some(file) = found {
        let path = root.join(file);
        let (_, doc) = manifest(lane, root);
        match doc.get("mcpServers") {
            None => {}
            Some(Value::String(_)) => collector.load_declared_path(root, &doc["mcpServers"], &path, "\"mcpServers\": "),
            Some(Value::Array(members)) => {
                for (index, member) in members.iter().enumerate() {
                    let where_ = format!("\"mcpServers\"[{index}]: ");
                    if member.is_object() {
                        if let Some(map) = collector.server_map(member, &path, &where_) {
                            collector.add_all(map, &path);
                        }
                    } else {
                        collector.load_declared_path(root, member, &path, &where_);
                    }
                }
            }
            Some(inline @ Value::Object(_)) => {
                if let Some(map) = collector.server_map(inline, &path, "") {
                    collector.add_all(map, &path);
                }
            }
            Some(_) => collector.error(&path, None, "\"mcpServers\" must be a path, a list, or an object"),
        }
    }
    PluginMcpDeclarations { format, servers: collector.servers.into_values().collect(), errors: collector.errors }
}

/// The user's intent for one plugin-declared server: stored apart from the declaration as
/// `pluginMcp[pluginId][declaredKey]`.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct ServerIntent {
    pub enabled: Option<bool>,
    pub alias: Option<String>,
    /// `env`, `headers`, `env_http_headers`: merged over the declared map.
    pub maps: BTreeMap<String, Map<String, Value>>,
    /// `command`, `args`, `url`, `bearer_token_env_var`, `env_vars` and the timeout spellings:
    /// replace the declared value.
    pub values: Map<String, Value>,
}

const INTENT_MAP_FIELDS: [&str; 3] = ["env", "headers", "env_http_headers"];
const INTENT_VALUE_FIELDS: [&str; 13] = [
    "command",
    "args",
    "url",
    "bearer_token_env_var",
    "env_vars",
    "startupTimeoutMs",
    "startup_timeout_ms",
    "startupTimeoutSec",
    "startup_timeout_sec",
    "timeoutMs",
    "timeout_ms",
    "callTimeoutMs",
    "call_timeout_ms",
];

fn normalize_intent(value: &Value) -> Option<ServerIntent> {
    let object = value.as_object()?;
    let mut intent = ServerIntent {
        enabled: object.get("enabled").and_then(Value::as_bool),
        alias: object
            .get("alias")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        ..ServerIntent::default()
    };
    for field in INTENT_MAP_FIELDS {
        if let Some(map) = object.get(field).and_then(Value::as_object) {
            let kept: Map<String, Value> =
                map.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect();
            if !kept.is_empty() {
                intent.maps.insert(field.to_owned(), kept);
            }
        }
    }
    for field in INTENT_VALUE_FIELDS {
        if let Some(v) = object.get(field).filter(|v| !v.is_null()) {
            intent.values.insert(field.to_owned(), v.clone());
        }
    }
    let empty = intent.enabled.is_none() && intent.alias.is_none() && intent.maps.is_empty() && intent.values.is_empty();
    (!empty).then_some(intent)
}

/// `{ pluginId: { declaredKey: intent } }` with empty records dropped.
pub fn normalize_intents(value: &Value) -> BTreeMap<String, BTreeMap<String, ServerIntent>> {
    let mut out = BTreeMap::new();
    let Some(plugins) = value.as_object() else { return out };
    for (plugin, servers) in plugins {
        let id = js_trim(plugin);
        let Some(servers) = servers.as_object().filter(|_| !id.is_empty()) else { continue };
        let kept: BTreeMap<String, ServerIntent> = servers
            .iter()
            .filter(|(key, _)| !key.is_empty())
            .filter_map(|(key, intent)| Some((key.clone(), normalize_intent(intent)?)))
            .collect();
        if !kept.is_empty() {
            out.insert(id.to_owned(), kept);
        }
    }
    out
}

/// A declared entry with the user's intent layered over it (`enabled` included).
pub fn apply_intent(declared: &Value, intent: &ServerIntent) -> Value {
    let mut entry = declared.as_object().cloned().unwrap_or_default();
    if let Some(enabled) = intent.enabled {
        entry.insert("enabled".to_owned(), Value::Bool(enabled));
    }
    for (field, overrides) in &intent.maps {
        let mut merged = entry.get(field).and_then(Value::as_object).cloned().unwrap_or_default();
        merged.extend(overrides.clone());
        entry.insert(field.clone(), Value::Object(merged));
    }
    for (field, value) in &intent.values {
        entry.insert(field.clone(), value.clone());
    }
    Value::Object(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn containment_refuses_escape_and_absolute_paths() {
        let root = Path::new("/plug");
        assert_eq!(resolve_contained(root, "./skills/"), Some(PathBuf::from("/plug/skills")));
        assert_eq!(resolve_contained(root, "a/../b"), Some(PathBuf::from("/plug/b")));
        assert_eq!(resolve_contained(root, "../x"), None);
        assert_eq!(resolve_contained(root, "/etc"), None);
        assert_eq!(resolve_contained(root, " "), None);
    }

    #[test]
    fn intent_layers_over_declaration() {
        let intents = normalize_intents(&json!({
            "p": {"s": {"enabled": false, "env": {"A": "2", "B": null}, "url": "https://x", "junk": 1}, "empty": {}},
            " ": {"s": {"enabled": true}}
        }));
        let intent = &intents["p"]["s"];
        assert_eq!(intents["p"].len(), 1);
        let merged = apply_intent(&json!({"command": "c", "env": {"A": "1", "C": "3"}}), intent);
        assert_eq!(merged["enabled"], json!(false));
        assert_eq!(merged["env"], json!({"A": "2", "C": "3"}));
        assert_eq!(merged["url"], json!("https://x"));
    }
}
