//! Plugin manifests, the plugin registry, the MCP servers plugins declare and the user's
//! per-server intents (T §4 config sources). Reading touches the filesystem, so every reader
//! takes an [`InLane`] proof of the maintenance lane; the parsing helpers are pure.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::js_trim;
use mixdog_js::js_object_keys as ordered_keys;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;

use crate::plugin_admin::truthy;
use crate::plugin_servers::declared_mcp_transport;

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

/// The code Node's `readFileSync` error carries for a read that failed.
fn error_code(lane: &InLane<MaintenanceIo>, path: &Path, error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    if mixdog_statefile::metadata(lane, path).is_ok_and(|meta| meta.is_dir()) {
        return "EISDIR";
    }
    match error.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::NotADirectory => "ENOTDIR",
        _ => "EIO",
    }
}

/// `jsonErrorMessage(error)` (`plugin-mcp.mjs`): a JSON parse failure as a location only, since the
/// engine's message may quote the offending source text, which can hold credentials. The location is
/// read out of V8's message, so the text must be the message V8 raises.
fn json_error_message(message: &str) -> String {
    static LINE_COLUMN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"line (\d+) column (\d+)").expect("a fixed pattern"));
    static POSITION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"position (\d+)").expect("a fixed pattern"));
    static END: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)end of (JSON|data) input").expect("a fixed pattern"));
    if let Some(found) = LINE_COLUMN.captures(message) {
        return format!("invalid JSON at line {} column {}", &found[1], &found[2]);
    }
    if let Some(found) = POSITION.captures(message) {
        return format!("invalid JSON at position {}", &found[1]);
    }
    if END.is_match(message) { "invalid JSON: unexpected end of input".to_owned() } else { "invalid JSON".to_owned() }
}

/// `readJsonFile(path, errors)`: the parsed file, or the message Node records for it.
fn read_json(lane: &InLane<MaintenanceIo>, path: &Path) -> Result<Value, String> {
    let read = mixdog_statefile::read_content(path);
    let bytes = match read {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err("cannot read file (ENOENT)".to_owned()),
        Err(error) => return Err(format!("cannot read file ({})", error_code(lane, path, &error))),
    };
    let text = String::from_utf8_lossy(&bytes);
    mixdog_js::json_parse(&text).map_err(|_| {
        let message = mixdog_js::v8_json_parse_error(&text).unwrap_or_else(|| unreachable!("the parser refused a text V8 accepts"));
        json_error_message(&message)
    })
}
/// The first manifest that parses to a truthy value (`readJsonSafe`, so a JSON array or string
/// counts and ends the search) with its format; a plugin without one is an empty manifest.
pub fn manifest(lane: &InLane<MaintenanceIo>, root: &Path) -> (PluginFormat, Value) {
    for file in MANIFEST_FILES {
        if let Ok(value) = read_json(lane, &root.join(file))
            && truthy(&value)
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
pub fn read_registry(lane: &InLane<MaintenanceIo>, data_dir: &Path) -> Vec<RegisteredPlugin> {
    let Ok(registry) = read_json(lane, &data_dir.join("plugins").join("registry.json")) else {
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
    let Some(map) = entry.as_object() else {
        return Some("server entry must be an object".to_owned());
    };
    let non_empty = |key: &str| map.get(key).and_then(Value::as_str).is_some_and(|s| !js_trim(s).is_empty());
    match declared_mcp_transport(map) {
        None => Some("\"type\" must be one of stdio, http, streamable-http, sse, ws".to_owned()),
        Some(kind) if kind == "stdio" => (!non_empty("command")).then(|| "stdio server requires \"command\"".to_owned()),
        Some(kind) => (!non_empty("url")).then(|| format!("{kind} server requires \"url\"")),
    }
}

struct Collector<'a> {
    lane: &'a InLane<MaintenanceIo>,
    /// In the order the keys were first declared; a later declaration of a key replaces it in place.
    servers: Vec<DeclaredServer>,
    errors: Vec<DeclarationError>,
}

impl Collector<'_> {
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
        for key in ordered_keys(map) {
            let config = &map[key];
            match server_problem(config) {
                Some(problem) => self.error(source, Some(key), problem),
                None => {
                    let server = DeclaredServer { key: key.clone(), config: config.clone(), source: source.to_path_buf() };
                    match self.servers.iter_mut().find(|s| s.key == *key) {
                        Some(existing) => *existing = server,
                        None => self.servers.push(server),
                    }
                }
            }
        }
    }

    fn load_file(&mut self, path: &Path) {
        match read_json(self.lane, path) {
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
    let mut collector = Collector { lane, servers: Vec::new(), errors: Vec::new() };
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
        // Joined by component, as Node joins `rel.split('/')`, so the separators are the host's own.
        let path = file.split('/').fold(root.to_path_buf(), |path, part| path.join(part));
        // The file found is the one read, whatever the later manifests hold; one that cannot be
        // read or parsed is reported and declares nothing.
        let doc = match read_json(lane, &path) {
            Ok(doc) => doc,
            Err(message) => {
                collector.error(&path, None, message);
                Value::Null
            }
        };
        match doc.as_object().and_then(|object| object.get("mcpServers")) {
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
    PluginMcpDeclarations { format, servers: collector.servers, errors: collector.errors }
}

/// The user's intent for one plugin-declared server is stored apart from the declaration as
/// `pluginMcp[pluginId][declaredKey]`: `enabled`, a kept `alias`, the `INTENT_MAP_FIELDS` merged
/// over the declared maps, and the `INTENT_VALUE_FIELDS` replacing the declared values.
pub const INTENT_MAP_FIELDS: [&str; 3] = ["env", "headers", "env_http_headers"];
pub const INTENT_VALUE_FIELDS: [&str; 13] = [
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

fn normalize_intent(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut out = Map::new();
    // `enabled: true` is kept too: it turns on a server declared `enabled: false`.
    if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
        out.insert("enabled".to_owned(), Value::Bool(enabled));
    }
    if let Some(alias) = object.get("alias").and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty()) {
        out.insert("alias".to_owned(), Value::String(alias.to_owned()));
    }
    for field in INTENT_MAP_FIELDS {
        let Some(map) = object.get(field).and_then(Value::as_object) else { continue };
        let kept: Map<String, Value> = ordered_keys(map)
            .into_iter()
            .filter(|key| !map[*key].is_null())
            .map(|key| (key.clone(), map[key].clone()))
            .collect();
        if !kept.is_empty() {
            out.insert(field.to_owned(), Value::Object(kept));
        }
    }
    for field in INTENT_VALUE_FIELDS {
        if let Some(v) = object.get(field).filter(|v| !v.is_null()) {
            out.insert(field.to_owned(), v.clone());
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// `{ pluginId: { declaredKey: intent } }` with empty records dropped, in the order a JavaScript
/// object lists them.
pub fn normalize_intents(value: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(plugins) = value.as_object() else { return out };
    for plugin in ordered_keys(plugins) {
        let id = js_trim(plugin);
        let Some(servers) = plugins[plugin].as_object().filter(|_| !id.is_empty()) else { continue };
        let kept: Map<String, Value> = ordered_keys(servers)
            .into_iter()
            .filter(|key| !key.is_empty())
            .filter_map(|key| Some((key.clone(), normalize_intent(&servers[key])?)))
            .collect();
        if !kept.is_empty() {
            out.insert(id.to_owned(), Value::Object(kept));
        }
    }
    out
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
    fn intents_keep_only_what_a_plugin_server_override_applies() {
        let intents = normalize_intents(&json!({
            "p": {"s": {"enabled": false, "env": {"A": "2", "B": null}, "url": "https://x", "junk": 1}, "empty": {}},
            " ": {"s": {"enabled": true}}
        }));
        assert_eq!(intents.len(), 1);
        assert_eq!(intents["p"], json!({"s": {"enabled": false, "env": {"A": "2"}, "url": "https://x"}}));
    }
}
