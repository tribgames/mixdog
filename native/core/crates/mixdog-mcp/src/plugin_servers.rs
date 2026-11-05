//! The effective MCP server set (Node `session-runtime/mcp-glue/plugin-servers.mjs`): the user's
//! configured servers plus the servers every registered plugin declares, with the adoption of
//! copies an earlier enable action made, and the config edits that keep that adoption.
//!
//! Pure over JSON values. Objects keep the order Node lists them in (`ordered_keys`), so the
//! results compare byte for byte with the recorded Node output.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;

use mixdog_js::js_object_keys as ordered_keys;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha1::Digest;
use sha1::Sha1;

use crate::plugin_admin::clean;
use crate::plugin_admin::truthy;
use crate::plugins::DeclaredServer;
use crate::plugins::INTENT_MAP_FIELDS;
use crate::plugins::INTENT_VALUE_FIELDS;
use crate::plugins::PluginFormat;
use crate::plugins::PluginMcpDeclarations;
use crate::plugins::normalize_intents;
use crate::scopes::resolve_path;

/// Tool names are `mcp__<server>__<tool>` and providers cap a tool name at 64 characters of
/// `[A-Za-z0-9_-]`; a short hyphenated server name leaves the tool its room and can never contain
/// the `__` delimiter.
pub const PLUGIN_MCP_NAME_MAX: usize = 32;
const LEGACY_ENV_KEYS: [&str; 2] = ["MIXDOG_PLUGIN_ROOT", "MIXDOG_PLUGIN_DATA"];
const ROOT_NAMES: [&str; 4] = ["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT", "MIXDOG_PLUGIN_ROOT"];
const DATA_NAMES: [&str; 3] = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "MIXDOG_PLUGIN_DATA"];
const PLACEHOLDER_FIELDS: [&str; 6] = ["command", "args", "env", "url", "headers", "cwd"];

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// Rebuilds `map` with its keys in the order a JavaScript object lists them.
fn js_ordered(map: Map<String, Value>) -> Map<String, Value> {
    ordered_keys(&map).into_iter().map(|key| (key.clone(), map[key].clone())).collect()
}

/// `{...target, ...source}` for plain objects: an existing key keeps its place.
fn assign(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
}

fn truthy_or<'a>(first: &'a Value, second: &'a Value) -> &'a Value {
    if truthy(first) { first } else { second }
}

// ---- names ----

/// Lowercased text with every run of characters `keep` rejects turned into one `-`, and the
/// ends trimmed of `-`.
fn dashed(text: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.to_lowercase().chars() {
        if keep(c) {
            if gap {
                out.push('-');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    // A run at either end is dropped by the trim, a `-` that is itself kept is trimmed too.
    out.trim_matches('-').to_owned()
}

fn slug(value: &str) -> String {
    dashed(value, |c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn short_hash(text: &str, length: usize) -> String {
    let digest = Sha1::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..length].to_owned()
}

fn with_suffix(name: &str, suffix: &str) -> String {
    let room = PLUGIN_MCP_NAME_MAX.saturating_sub(suffix.len() + 1);
    let head: String = name.chars().take(room).collect();
    format!("{}-{suffix}", head.trim_end_matches('-'))
}

/// Name of one plugin server: the registry id (without its source hash) and the declared key, the
/// key dropped when it repeats the plugin. Never depends on how many servers the plugin declares.
pub fn plugin_mcp_server_base_name(plugin_id: &str, key: &str) -> String {
    let bytes = plugin_id.as_bytes();
    let hashed = bytes.len() >= 9 && bytes[bytes.len() - 9] == b'-' && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_hexdigit);
    let stem = slug(if hashed { &plugin_id[..plugin_id.len() - 9] } else { plugin_id });
    let stem = if stem.is_empty() { "plugin".to_owned() } else { stem };
    let leaf = slug(key);
    let leaf = if leaf.is_empty() { "mcp".to_owned() } else { leaf };
    let name = if leaf == stem { format!("plugin-{stem}") } else { format!("plugin-{stem}-{leaf}") };
    if name.len() <= PLUGIN_MCP_NAME_MAX { name } else { with_suffix(&name, &short_hash(&format!("{plugin_id}\0{key}"), 8)) }
}

fn disambiguated_name(base: &str, plugin_id: &str, key: &str, taken: &HashMap<String, Option<String>>) -> String {
    let suffix = short_hash(&format!("{plugin_id}\0{key}"), 6);
    let mut name = with_suffix(base, &suffix);
    let mut n = 2;
    while taken.contains_key(&name) {
        name = with_suffix(base, &format!("{suffix}{n}"));
        n += 1;
    }
    name
}

/// The name an earlier enable action gave a plugin's server copy.
fn legacy_server_name(plugin: &Value) -> String {
    let name = clean(truthy_or(field(plugin, "name"), truthy_or(field(plugin, "title"), &json!("plugin"))));
    let base = dashed(&name, |c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    if base.is_empty() { "plugin-mcp".to_owned() } else { format!("plugin-{base}") }
}

// ---- paths (the host's own path rules, as Node's `path` module) ----

fn is_absolute(path: &str) -> bool {
    Path::new(path).is_absolute() || (cfg!(windows) && path.starts_with(['/', '\\']))
}

fn resolve_against(root: &str, relative: &str) -> String {
    let joined = if is_absolute(relative) { relative.to_owned() } else { format!("{root}{}{relative}", std::path::MAIN_SEPARATOR) };
    resolve_path(&joined).unwrap_or(joined)
}

fn comparable_path(path: &Value) -> String {
    let text = clean(path);
    if text.is_empty() {
        return String::new();
    }
    let resolved = resolve_path(&text).unwrap_or(text);
    let mut unified = String::new();
    let mut separator = false;
    for c in resolved.chars() {
        if c == '/' || c == '\\' {
            if !separator {
                unified.push('/');
            }
            separator = true;
        } else {
            separator = false;
            unified.push(c);
        }
    }
    if unified.ends_with('/') {
        unified.pop();
    }
    if cfg!(windows) { unified.to_lowercase() } else { unified }
}

// ---- transports ----

/// Transport a declared server asks for, inferred the way the MCP client does when `type` is
/// absent: `transport: "http"` or a `url` -> http, else stdio. None for an unrecognised type.
pub fn declared_mcp_transport(config: &Map<String, Value>) -> Option<String> {
    match config.get("type") {
        Some(t) if !t.is_null() && t != "" => {
            let lower = t.as_str()?.to_lowercase();
            if lower == "streamablehttp" {
                return Some("streamable-http".to_owned());
            }
            ["stdio", "http", "streamable-http", "sse", "ws"].contains(&lower.as_str()).then_some(lower)
        }
        _ => {
            if config.get("transport").is_some_and(|t| t == "http") || (!config.contains_key("command") && config.contains_key("url")) {
                Some("http".to_owned())
            } else {
                Some("stdio".to_owned())
            }
        }
    }
}

fn comparable_transport(config: &Map<String, Value>) -> Option<String> {
    declared_mcp_transport(config).map(|t| if t == "streamable-http" { "http".to_owned() } else { t })
}

// ---- plugin placeholders (Node `mcp/plugin-placeholders.mjs`) ----

fn normalize_slashes(path: &str) -> String {
    if cfg!(windows) { path.replace('\\', "/") } else { path.to_owned() }
}

fn substitute_text(text: &str, replacements: &HashMap<&str, String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let hit = tail[2..].find('}').and_then(|end| replacements.get(&tail[2..2 + end]).map(|value| (end, value)));
        match hit {
            Some((end, value)) => {
                out.push_str(value);
                rest = &tail[end + 3..];
            }
            None => {
                out.push_str("${");
                rest = &tail[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn substitute(value: &Value, replacements: &HashMap<&str, String>) -> Value {
    match value {
        Value::String(text) => Value::String(substitute_text(text, replacements)),
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, replacements)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), substitute(v, replacements))).collect()),
        other => other.clone(),
    }
}

/// `config` with plugin root/data placeholders replaced in command, args, env, url, headers and
/// cwd. A placeholder whose directory is not supplied is left as written.
pub fn resolve_plugin_placeholders(config: &Map<String, Value>, root: &str, data: &str) -> Map<String, Value> {
    let mut replacements = HashMap::new();
    if !root.is_empty() {
        for name in ROOT_NAMES {
            replacements.insert(name, normalize_slashes(root));
        }
    }
    if !data.is_empty() {
        for name in DATA_NAMES {
            replacements.insert(name, normalize_slashes(data));
        }
    }
    let mut out = config.clone();
    for name in PLACEHOLDER_FIELDS {
        if let Some(value) = out.get(name) {
            let replaced = substitute(value, &replacements);
            out.insert(name.to_owned(), replaced);
        }
    }
    out
}

/// Environment variables a plugin-owned server process receives (raw paths).
pub fn plugin_server_env(root: &str, data: &str) -> Map<String, Value> {
    let mut env = Map::new();
    if !root.is_empty() {
        for name in ["CLAUDE_PLUGIN_ROOT", "MIXDOG_PLUGIN_ROOT", "PLUGIN_ROOT"] {
            env.insert(name.to_owned(), json!(root));
        }
    }
    if !data.is_empty() {
        for name in ["CLAUDE_PLUGIN_DATA", "MIXDOG_PLUGIN_DATA", "PLUGIN_DATA"] {
            env.insert(name.to_owned(), json!(data));
        }
    }
    env
}

// ---- declarations ----

/// One registered plugin and what it declares for MCP.
pub struct Declared {
    pub plugin: Value,
    pub missing: bool,
    pub format: &'static str,
    pub servers: Vec<DeclaredServer>,
    pub errors: Vec<Value>,
}

fn format_name(format: PluginFormat) -> &'static str {
    match format {
        PluginFormat::Codex => "codex",
        PluginFormat::Mixdog => "mixdog",
        PluginFormat::Claude => "claude",
        PluginFormat::None => "none",
    }
}

/// What each registered plugin (those with an id) declares; `load` reads one root's declarations.
pub fn declarations_of(plugins: &[Value], load: &dyn Fn(&Path) -> PluginMcpDeclarations) -> Vec<Declared> {
    plugins
        .iter()
        .filter(|plugin| !clean(field(plugin, "id")).is_empty())
        .map(|plugin| {
            let root = clean(field(plugin, "root"));
            if root.is_empty() || field(plugin, "exists") == &Value::Bool(false) {
                return Declared {
                    plugin: plugin.clone(),
                    missing: true,
                    format: "none",
                    servers: Vec::new(),
                    errors: vec![json!({"message": format!("plugin root not found: {root}")})],
                };
            }
            let loaded = load(Path::new(&root));
            let errors = loaded
                .errors
                .iter()
                .map(|e| {
                    let mut entry = Map::new();
                    entry.insert("source".to_owned(), json!(e.source.to_string_lossy()));
                    if let Some(key) = &e.key {
                        entry.insert("key".to_owned(), json!(key));
                    }
                    entry.insert("message".to_owned(), json!(e.message));
                    Value::Object(entry)
                })
                .collect();
            Declared { plugin: plugin.clone(), missing: false, format: format_name(loaded.format), servers: loaded.servers, errors }
        })
        .collect()
}

// ---- copy adoption ----

fn deep_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_equal(Some(p), Some(q))),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| deep_equal(Some(v), y.get(k)))
            }
            _ => a == b,
        },
        _ => false,
    }
}

/// How an earlier enable action rewrote a declaration before copying it.
fn legacy_copy_form(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("${CLAUDE_PLUGIN_ROOT}", root).replace("${CODEX_PLUGIN_ROOT}", root)),
        Value::Array(items) => Value::Array(items.iter().map(|v| legacy_copy_form(v, root)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), legacy_copy_form(v, root))).collect()),
        other => other.clone(),
    }
}

fn same_transport(copy: &Map<String, Value>, declared: &Value, root: &str) -> bool {
    let form = legacy_copy_form(declared, root);
    ["command", "args", "url"].iter().all(|f| deep_equal(copy.get(*f), form.get(*f)))
}

fn plain_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// What the user changed in a copy relative to the declaration it was made from: the overrides
/// when every change is something a plugin server override applies, else the reason the copy is
/// left as configured (so nothing is ever dropped). Values the earlier enable action generated
/// itself (plugin env markers, the forced cwd, enable flags) are not changes.
fn copy_overrides(copy: &Map<String, Value>, declared: &Value, root: &str) -> Result<Map<String, Value>, String> {
    let form_value = legacy_copy_form(declared, root);
    let form = form_value.as_object().cloned().unwrap_or_default();
    let mut out = Map::new();
    let mut kept: Vec<&str> = Vec::new();
    let mut fields: Vec<&String> = ordered_keys(copy);
    for key in ordered_keys(&form) {
        if !fields.contains(&key) {
            fields.push(key);
        }
    }
    for name in fields {
        let name = name.as_str();
        if name == "enabled" || name == "_mixdogPluginDisabled" {
            continue;
        }
        if name == "type" || name == "transport" {
            if comparable_transport(copy) != comparable_transport(&form) {
                kept.push(name);
            }
            continue;
        }
        if name == "cwd" {
            let declared_cwd = form.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("");
            let generated = if declared_cwd.is_empty() {
                root.to_owned()
            } else if is_absolute(declared_cwd) {
                declared_cwd.to_owned()
            } else {
                resolve_against(root, declared_cwd)
            };
            if let Some(copy_cwd) = copy.get("cwd") {
                if comparable_path(copy_cwd) != comparable_path(&json!(generated)) {
                    kept.push(name);
                }
            }
            continue;
        }
        if INTENT_MAP_FIELDS.contains(&name) {
            let empty = Map::new();
            let copy_map = plain_object(copy.get(name)).unwrap_or(&empty);
            let declared_map = plain_object(form.get(name)).unwrap_or(&empty);
            if copy.get(name).is_some() && plain_object(copy.get(name)).is_none() || declared_map.keys().any(|k| !copy_map.contains_key(k)) {
                kept.push(name);
            }
            let mut added = Map::new();
            for entry in ordered_keys(copy_map) {
                if name == "env" && LEGACY_ENV_KEYS.contains(&entry.as_str()) {
                    continue;
                }
                if !deep_equal(copy_map.get(entry), declared_map.get(entry)) {
                    added.insert(entry.clone(), copy_map[entry].clone());
                }
            }
            if !added.is_empty() {
                out.insert(name.to_owned(), Value::Object(added));
            }
            continue;
        }
        if deep_equal(copy.get(name), form.get(name)) {
            continue;
        }
        match copy.get(name) {
            Some(value) if INTENT_VALUE_FIELDS.contains(&name) => {
                out.insert(name.to_owned(), value.clone());
            }
            _ => kept.push(name),
        }
    }
    if kept.is_empty() {
        return Ok(out);
    }
    let mut seen = HashSet::new();
    let list: Vec<String> = kept.iter().filter(|f| seen.insert(**f)).map(|f| format!("\"{f}\"")).collect();
    Err(format!("its {} differ from the plugin declaration in a way a plugin server override cannot keep", list.join(", ")))
}

/// The declared key a copy stands for, or the reason it cannot be told apart.
fn copy_key(name: &str, copy: &Map<String, Value>, plugin: &Value, declared: &Declared) -> Result<String, String> {
    let base = legacy_server_name(plugin);
    let keys: Vec<&String> = declared.servers.iter().map(|s| &s.key).collect();
    if keys.is_empty() {
        return Err("the plugin declares no MCP servers".to_owned());
    }
    if name == base {
        if keys.len() == 1 {
            return Ok(keys[0].clone());
        }
        let root = value_to_string(field(plugin, "root"));
        let matches: Vec<&DeclaredServer> = declared.servers.iter().filter(|s| same_transport(copy, &s.config, &root)).collect();
        return match matches.as_slice() {
            [one] => Ok(one.key.clone()),
            _ => Err("it matches none or several declared servers".to_owned()),
        };
    }
    if let Some(key) = name.strip_prefix(&format!("{base}--")) {
        return if keys.iter().any(|k| k.as_str() == key) { Ok(key.to_owned()) } else { Err(format!("the plugin no longer declares \"{key}\"")) };
    }
    Err(format!("its name does not follow the plugin's naming ({base})"))
}

struct Adoption {
    removed: Vec<String>,
    intents: Map<String, Value>,
    warnings: Vec<(String, String)>,
    /// Copies of a registered plugin that cannot be adopted: left as configured (their own
    /// transport is honored) but still bound to the plugin's lifecycle. Name -> (plugin, key).
    owned: HashMap<String, (usize, String)>,
}

/// Adoption of server copies made by the earlier enable action. A copy is adopted only when its
/// `env.MIXDOG_PLUGIN_ROOT` is a registered plugin's root AND its name follows that plugin's
/// earlier naming; it then leaves `mcpServers` and its name, disabled state and user-added
/// connection values become that server's intent. Everything else stays untouched with a warning.
/// Idempotent: an already-adopted config yields an empty plan.
fn plan_copy_adoption(user: &Map<String, Value>, intents: &Map<String, Value>, declared: &[Declared]) -> Adoption {
    // A present declaration wins over a missing one sharing its root, in any order.
    let mut by_root: HashMap<String, usize> = HashMap::new();
    for (index, d) in declared.iter().enumerate() {
        let root = comparable_path(field(&d.plugin, "root"));
        if !d.missing || !by_root.contains_key(&root) {
            by_root.insert(root, index);
        }
    }
    let mut next = intents.clone();
    let mut plan = Adoption { removed: Vec::new(), intents: Map::new(), warnings: Vec::new(), owned: HashMap::new() };
    for name in ordered_keys(user) {
        let Some(copy) = user[name].as_object() else { continue };
        let marker = plain_object(copy.get("env")).and_then(|env| env.get("MIXDOG_PLUGIN_ROOT")).map(clean).unwrap_or_default();
        if marker.is_empty() {
            continue;
        }
        let mut leave = |reason: String| {
            plan.warnings.push((name.clone(), format!("\"{name}\" looks like a plugin MCP copy but was left as configured: {reason}")));
        };
        let Some(&owner_index) = by_root.get(&comparable_path(&json!(marker))) else {
            leave(format!("no registered plugin has root {marker}"));
            continue;
        };
        let owner = &declared[owner_index];
        // A registered plugin whose directory is gone still owns its copies, so its disablement and
        // project scopes keep applying; nothing is adopted.
        if owner.missing {
            plan.owned.insert(name.clone(), (owner_index, name.clone()));
            leave(format!("plugin root {marker} is missing"));
            continue;
        }
        let found = copy_key(name, copy, &owner.plugin, owner);
        plan.owned.insert(name.clone(), (owner_index, found.clone().unwrap_or_else(|_| name.clone())));
        let key = match found {
            Ok(key) => key,
            Err(reason) => {
                leave(reason);
                continue;
            }
        };
        let id = value_to_string(field(&owner.plugin, "id"));
        let stored = next.get(&id).and_then(|servers| servers.get(&key)).cloned();
        if let Some(alias) = stored.as_ref().and_then(|s| s.get("alias")).filter(|a| truthy(a) && a.as_str() != Some(name.as_str())) {
            leave(format!("plugin server \"{key}\" already keeps the name \"{}\"", value_to_string(alias)));
            continue;
        }
        let declaration = &owner.servers.iter().find(|s| s.key == key).map(|s| s.config.clone()).unwrap_or(Value::Null);
        let root = value_to_string(field(&owner.plugin, "root"));
        let overrides = match copy_overrides(copy, declaration, &root) {
            Ok(overrides) => overrides,
            Err(reason) => {
                leave(reason);
                continue;
            }
        };
        let disabled = copy.get("enabled") == Some(&Value::Bool(false))
            || (copy.get("_mixdogPluginDisabled") == Some(&Value::Bool(true)) && field(&owner.plugin, "enabled") != &Value::Bool(false));
        let declared_on = declaration.get("enabled") != Some(&Value::Bool(false));
        let mut intent = Map::new();
        intent.insert("alias".to_owned(), json!(name));
        if disabled == declared_on {
            intent.insert("enabled".to_owned(), Value::Bool(!disabled));
        }
        assign(&mut intent, &overrides);
        if let Some(Value::Object(stored)) = &stored {
            assign(&mut intent, stored);
        }
        let mut servers = next.get(&id).and_then(Value::as_object).cloned().unwrap_or_default();
        servers.insert(key, Value::Object(intent));
        next.insert(id, Value::Object(js_ordered(servers)));
        plan.removed.push(name.clone());
        plan.owned.remove(name);
    }
    plan.intents = js_ordered(next);
    plan
}

// ---- naming ----

struct Slot {
    declared: usize,
    server: usize,
    id: String,
}

struct Names {
    slots: Vec<Slot>,
    names: Vec<String>,
    warnings: HashMap<usize, Vec<String>>,
    /// Slots running under a generated collision name that is not yet kept.
    unpinned: HashSet<usize>,
}

fn kept_alias<'a>(intents: &'a Map<String, Value>, id: &str, key: &str) -> Option<&'a Value> {
    intents.get(id)?.get(key)?.get("alias")
}

/// Names for every declared server: configured servers keep theirs, then kept aliases, then
/// generated names in registry order; a later claimant of a taken name gets a deterministic suffix
/// and a warning.
fn assign_names(user_names: &[String], declared: &[Declared], intents: &Map<String, Value>) -> Names {
    let mut claimed_by: HashMap<String, Option<String>> = user_names.iter().map(|n| (n.clone(), None)).collect();
    let slots: Vec<Slot> = declared
        .iter()
        .enumerate()
        .flat_map(|(d, decl)| {
            let id = value_to_string(field(&decl.plugin, "id"));
            (0..decl.servers.len()).map(move |server| Slot { declared: d, server, id: id.clone() })
        })
        .collect();
    let key_of = |slot: &Slot| declared[slot.declared].servers[slot.server].key.clone();
    let mut names: Vec<Option<String>> = vec![None; slots.len()];
    let mut warnings: HashMap<usize, Vec<String>> = HashMap::new();
    let mut unpinned = HashSet::new();
    let conflict = |claimed_by: &HashMap<String, Option<String>>, wanted: &str| match &claimed_by[wanted] {
        None => "a configured MCP server".to_owned(),
        Some(holder) => format!("plugin \"{holder}\""),
    };
    for (index, slot) in slots.iter().enumerate() {
        let Some(alias) = kept_alias(intents, &slot.id, &key_of(slot)).filter(|a| truthy(a)) else { continue };
        let alias = value_to_string(alias);
        if claimed_by.contains_key(&alias) {
            warnings.insert(index, vec![format!("kept name \"{alias}\" is taken by {}", conflict(&claimed_by, &alias))]);
        } else {
            claimed_by.insert(alias.clone(), Some(slot.id.clone()));
            names[index] = Some(alias);
        }
    }
    for (index, slot) in slots.iter().enumerate() {
        if names[index].is_some() {
            continue;
        }
        let key = key_of(slot);
        let base = plugin_mcp_server_base_name(&slot.id, &key);
        if !claimed_by.contains_key(&base) {
            claimed_by.insert(base.clone(), Some(slot.id.clone()));
            names[index] = Some(base);
            continue;
        }
        let name = disambiguated_name(&base, &slot.id, &key, &claimed_by);
        warnings.entry(index).or_default().push(format!("name \"{base}\" is taken by {}; using \"{name}\"", conflict(&claimed_by, &base)));
        claimed_by.insert(name.clone(), Some(slot.id.clone()));
        names[index] = Some(name);
        if !kept_alias(intents, &slot.id, &key).is_some_and(truthy) {
            unpinned.insert(index);
        }
    }
    // A kept name standing in for a generated one that someone else holds still reports the conflict.
    for (index, slot) in slots.iter().enumerate() {
        let key = key_of(slot);
        let name = names[index].clone().unwrap_or_default();
        let base = plugin_mcp_server_base_name(&slot.id, &key);
        if warnings.contains_key(&index) || name == base || !claimed_by.contains_key(&base) || claimed_by[&base].as_deref() == Some(slot.id.as_str()) {
            continue;
        }
        if kept_alias(intents, &slot.id, &key).is_some_and(|a| value_to_string(a) == name) {
            warnings.insert(index, vec![format!("name \"{base}\" is taken by {}; keeping \"{name}\"", conflict(&claimed_by, &base))]);
        }
    }
    Names { names: names.into_iter().map(Option::unwrap_or_default).collect(), slots, warnings, unpinned }
}

// ---- resolving ----

fn with_intent_overrides(config: &Map<String, Value>, intent: Option<&Value>) -> Map<String, Value> {
    let mut out = config.clone();
    let Some(intent) = intent.and_then(Value::as_object) else { return out };
    for name in INTENT_MAP_FIELDS {
        if let Some(extra) = intent.get(name).filter(|v| truthy(v)) {
            let mut merged = plain_object(out.get(name)).cloned().unwrap_or_default();
            if let Some(extra) = extra.as_object() {
                assign(&mut merged, extra);
            }
            out.insert(name.to_owned(), Value::Object(merged));
        }
    }
    for name in INTENT_VALUE_FIELDS {
        if let Some(value) = intent.get(name) {
            out.insert(name.to_owned(), value.clone());
        }
    }
    out
}

/// Launchable config of one plugin server for a runtime whose session cwd is `cwd`.
fn resolve_server_config(plugin: &Value, format: &str, server: &DeclaredServer, intent: Option<&Value>, cwd: &str, data_dir: &str) -> Map<String, Value> {
    let root = clean(field(plugin, "root"));
    let id = value_to_string(field(plugin, "id"));
    let data = if data_dir.is_empty() {
        String::new()
    } else {
        let joined = format!("{data_dir}{sep}plugins{sep}data{sep}{id}", sep = std::path::MAIN_SEPARATOR);
        resolve_path(&joined).unwrap_or(joined)
    };
    let mut declared = server.config.as_object().cloned().unwrap_or_default();
    declared.shift_remove("enabled");
    let mut cfg = resolve_plugin_placeholders(&with_intent_overrides(&declared, intent), &root, &data);
    let mut cwd_dependent = false;
    if declared_mcp_transport(&cfg).as_deref() == Some("stdio") {
        let declared_cwd = cfg.get("cwd").and_then(Value::as_str).map(|s| js_trim(s).to_owned()).unwrap_or_default();
        if !declared_cwd.is_empty() {
            let value = if is_absolute(&declared_cwd) || declared_cwd.starts_with("${") { declared_cwd } else { resolve_against(&root, &declared_cwd) };
            cfg.insert("cwd".to_owned(), json!(value));
        } else if format == "mixdog" {
            cfg.insert("cwd".to_owned(), json!(root));
        } else {
            cwd_dependent = true;
            if cwd.is_empty() {
                cfg.shift_remove("cwd");
            } else {
                cfg.insert("cwd".to_owned(), json!(cwd));
            }
        }
        let mut env = plugin_server_env(&root, &data);
        if let Some(own) = plain_object(cfg.get("env")) {
            assign(&mut env, own);
        }
        cfg.insert("env".to_owned(), Value::Object(env));
    }
    cfg.insert("_mixdogStrictEnv".to_owned(), json!(true));
    cfg.insert("_mixdogRootsFollowScope".to_owned(), json!(true));
    cfg.insert(
        "_mixdogPlugin".to_owned(),
        json!({
            "id": field(plugin, "id"), "key": server.key, "format": format, "root": root,
            "source": server.source.to_string_lossy(), "data": data, "cwdDependent": cwd_dependent,
        }),
    );
    cfg
}

/// The effective MCP server set and where each entry came from.
pub struct Catalog {
    pub servers: Map<String, Value>,
    pub sources: Map<String, Value>,
    pub entries: Map<String, Value>,
    pub plugins: Map<String, Value>,
    pub warnings: Vec<Value>,
    /// The copies adopted into plugin intent: their names and the intents after adoption.
    pub adoption: Option<(Vec<String>, Map<String, Value>)>,
}

impl Catalog {
    /// The JSON form Node returns.
    pub fn to_value(&self) -> Value {
        json!({
            "servers": self.servers, "sources": self.sources, "entries": self.entries,
            "plugins": self.plugins, "warnings": self.warnings,
            "adoption": self.adoption.as_ref().map(|(removed, intents)| json!({"removed": removed, "intents": intents})),
        })
    }
}

/// The effective MCP server set: the user's configured servers plus the servers every registered
/// plugin declares (disabled ones included, `enabled: false`). `declared` is `declarations_of` the
/// registry list in registration order.
pub fn resolve_mcp_server_catalog(config: &Value, declared: &[Declared], cwd: &str, data_dir: &str) -> Catalog {
    let empty = Map::new();
    let configured = plain_object(config.get("mcpServers")).unwrap_or(&empty);
    let adoption = plan_copy_adoption(configured, &normalize_intents(field(config, "pluginMcp")), declared);
    let removed: HashSet<&String> = adoption.removed.iter().collect();
    let mut servers = Map::new();
    let mut sources = Map::new();
    let mut entries = Map::new();
    let mut warnings: Vec<Value> = adoption.warnings.iter().map(|(name, message)| json!({"name": name, "message": message})).collect();
    for name in ordered_keys(configured) {
        if removed.contains(name) {
            continue;
        }
        let cfg = &configured[name];
        let entry_warnings: Vec<&String> = adoption.warnings.iter().filter(|(n, _)| n == name).map(|(_, m)| m).collect();
        sources.insert(name.clone(), json!("config"));
        let Some((index, key)) = adoption.owned.get(name) else {
            let mut server = cfg.as_object().cloned().unwrap_or_default();
            if cfg.get("_mixdogPluginDisabled") == Some(&Value::Bool(true)) {
                server.insert("enabled".to_owned(), json!(false));
            }
            servers.insert(name.clone(), Value::Object(server));
            entries.insert(name.clone(), json!({"owner": null, "warnings": entry_warnings}));
            continue;
        };
        let owner = &declared[*index];
        let plugin = &owner.plugin;
        let plugin_enabled = field(plugin, "enabled") != &Value::Bool(false);
        let server_enabled = !(cfg.get("enabled") == Some(&Value::Bool(false)) || (cfg.get("_mixdogPluginDisabled") == Some(&Value::Bool(true)) && plugin_enabled));
        let marker = json!({
            "id": field(plugin, "id"), "key": key, "format": owner.format, "root": clean(field(plugin, "root")),
            "source": "config", "data": "", "cwdDependent": false,
        });
        let mut server = cfg.as_object().cloned().unwrap_or_default();
        server.insert("enabled".to_owned(), json!(plugin_enabled && server_enabled));
        server.insert("_mixdogPlugin".to_owned(), marker.clone());
        servers.insert(name.clone(), Value::Object(server));
        let display = truthy_or(&json!(clean(field(plugin, "name"))), field(plugin, "id")).clone();
        let mut entry_owner = Map::new();
        entry_owner.insert("kind".to_owned(), json!("plugin"));
        assign(&mut entry_owner, marker.as_object().unwrap_or(&empty));
        entry_owner.insert("name".to_owned(), display);
        entries.insert(
            name.clone(),
            json!({
                "owner": entry_owner, "pluginEnabled": plugin_enabled, "serverEnabled": server_enabled,
                "declaredEnabled": true, "warnings": entry_warnings,
            }),
        );
    }
    let servers_in_order = js_ordered(std::mem::take(&mut servers));
    let user_names: Vec<String> = servers_in_order.keys().cloned().collect();
    servers = servers_in_order;
    let named = assign_names(&user_names, declared, &adoption.intents);
    let mut plugin_rows = Map::new();
    for d in declared {
        let id = value_to_string(field(&d.plugin, "id"));
        let name = truthy_or(&json!(clean(field(&d.plugin, "name"))), field(&d.plugin, "id")).clone();
        let mut row = Map::new();
        row.insert("id".to_owned(), field(&d.plugin, "id").clone());
        row.insert("name".to_owned(), name);
        row.insert("enabled".to_owned(), json!(field(&d.plugin, "enabled") != &Value::Bool(false)));
        row.insert("format".to_owned(), json!(d.format));
        row.insert("errors".to_owned(), Value::Array(d.errors.clone()));
        row.insert("servers".to_owned(), json!([]));
        if d.missing {
            row.insert("missing".to_owned(), json!(true));
        }
        plugin_rows.insert(id, Value::Object(row));
    }
    for (index, slot) in named.slots.iter().enumerate() {
        let d = &declared[slot.declared];
        let server = &d.servers[slot.server];
        let name = &named.names[index];
        let intent = adoption.intents.get(&slot.id).and_then(|servers| servers.get(&server.key));
        let plugin_enabled = field(&d.plugin, "enabled") != &Value::Bool(false);
        // A declaration may ship a server off by default; the user's intent wins.
        let declared_enabled = server.config.get("enabled") != Some(&Value::Bool(false));
        let server_enabled = intent.and_then(|i| i.get("enabled")).and_then(Value::as_bool).unwrap_or(declared_enabled);
        let mut cfg = resolve_server_config(&d.plugin, d.format, server, intent, cwd, data_dir);
        cfg.insert("enabled".to_owned(), json!(plugin_enabled && server_enabled));
        let mut owner = Map::new();
        owner.insert("kind".to_owned(), json!("plugin"));
        assign(&mut owner, cfg["_mixdogPlugin"].as_object().unwrap_or(&empty));
        owner.insert("name".to_owned(), plugin_rows[&slot.id]["name"].clone());
        servers.insert(name.clone(), Value::Object(cfg));
        sources.insert(name.clone(), json!("plugin"));
        let slot_warnings = named.warnings.get(&index).cloned().unwrap_or_default();
        let mut entry = Map::new();
        entry.insert("owner".to_owned(), Value::Object(owner));
        entry.insert("pluginEnabled".to_owned(), json!(plugin_enabled));
        entry.insert("serverEnabled".to_owned(), json!(server_enabled));
        entry.insert("declaredEnabled".to_owned(), json!(declared_enabled));
        if named.unpinned.contains(&index) {
            entry.insert("unpinned".to_owned(), json!(true));
        }
        entry.insert("warnings".to_owned(), json!(slot_warnings));
        entries.insert(name.clone(), Value::Object(entry));
        for message in &slot_warnings {
            warnings.push(json!({"name": name, "plugin": field(&d.plugin, "id"), "message": message}));
        }
        if let Some(Value::Array(list)) = plugin_rows.get_mut(&slot.id).and_then(|row| row.get_mut("servers")) {
            list.push(json!(name));
        }
    }
    Catalog {
        servers: js_ordered(servers),
        sources: js_ordered(sources),
        entries: js_ordered(entries),
        plugins: js_ordered(plugin_rows),
        warnings,
        adoption: (!adoption.removed.is_empty()).then(|| (adoption.removed, adoption.intents)),
    }
}

// ---- config edits ----

fn with_key(config: &Value, edits: Vec<(&str, Value)>) -> Value {
    let mut next = config.as_object().cloned().unwrap_or_default();
    for (key, value) in edits {
        next.insert(key.to_owned(), value);
    }
    Value::Object(next)
}

/// `config` with adopted copies removed from `mcpServers` and their intent recorded.
pub fn with_adopted_copies(config: &Value, adoption: Option<&(Vec<String>, Map<String, Value>)>) -> Value {
    let Some((removed, intents)) = adoption else { return config.clone() };
    let mut servers = plain_object(config.get("mcpServers")).cloned().unwrap_or_default();
    for name in removed {
        servers.shift_remove(name);
    }
    with_key(config, vec![("mcpServers", Value::Object(servers)), ("pluginMcp", Value::Object(intents.clone()))])
}

/// `config` (already carrying `catalog`'s adoption) with every plugin server that runs under a
/// generated collision name keeping that name, so it does not flip back (changing its tool names
/// and name-keyed scopes) once the conflicting server goes away.
pub fn with_pinned_collision_names(config: &Value, catalog: &Catalog) -> Value {
    let mut next = config.clone();
    for name in ordered_keys(&catalog.entries) {
        let entry = &catalog.entries[name];
        let Some(owner) = entry.get("owner").filter(|o| o.is_object()) else { continue };
        if entry.get("unpinned").is_none_or(|u| !truthy(u)) {
            continue;
        }
        let id = value_to_string(field(owner, "id"));
        let key = value_to_string(field(owner, "key"));
        next = with_plugin_server_intent(&next, &id, &key, |mut intent| {
            intent.insert("alias".to_owned(), json!(name));
            intent
        });
    }
    next
}

/// `config` with one plugin server's intent replaced by `update(intent)`.
pub fn with_plugin_server_intent(config: &Value, plugin_id: &str, key: &str, update: impl FnOnce(Map<String, Value>) -> Map<String, Value>) -> Value {
    let mut intents = normalize_intents(field(config, "pluginMcp"));
    let mut servers = plain_object(intents.get(plugin_id)).cloned().unwrap_or_default();
    let current = plain_object(servers.get(key)).cloned().unwrap_or_default();
    let candidate = json!({ plugin_id: { key: update(current) } });
    let next = normalize_intents(&candidate).get(plugin_id).and_then(|s| s.get(key)).cloned();
    match next {
        Some(next) => {
            servers.insert(key.to_owned(), next);
        }
        None => {
            servers.shift_remove(key);
        }
    }
    if servers.is_empty() {
        intents.shift_remove(plugin_id);
    } else {
        intents.insert(plugin_id.to_owned(), Value::Object(js_ordered(servers)));
    }
    with_key(config, vec![("pluginMcp", Value::Object(js_ordered(intents)))])
}

/// `config` without any intent recorded for `plugin_id`.
pub fn without_plugin_intents(config: &Value, plugin_id: &str) -> Value {
    let mut intents = normalize_intents(field(config, "pluginMcp"));
    if !intents.contains_key(plugin_id) {
        return config.clone();
    }
    intents.shift_remove(plugin_id);
    with_key(config, vec![("pluginMcp", Value::Object(intents))])
}
