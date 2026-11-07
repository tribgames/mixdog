//! Config patches: what `saveConfigAndAdopt` writes (`config-lifecycle.mjs`), over `diffConfig`
//! / `applyConfigPatch` (`shared/config-patch.mjs`) and `createConfigPatch` (`config.mjs`).
//!
//! A writer holds the agent config it started from (`before`) and the one it wants (`after`).
//! The patch is only what differs, so a field another writer changed meanwhile survives, and
//! it is applied to the stored agent section inside the one config transaction.
//!
//! `create_config_patch` first projects both sides to their stored form (the part of
//! `buildAgentSaveBuilder` that this module ports, see [`stored_form`]), so defaults and
//! ephemeral values never reach the file.

use serde_json::Map;
use serde_json::Value;

use crate::workflow::presets::normalize_preset;
use crate::workflow::presets::stored_web_search_route;

type Doc = Map<String, Value>;

/// One field edit. `path` addresses a key inside the agent section.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigChange {
    pub path: Vec<String>,
    pub op: ChangeOp,
    /// A seed: written where the field is missing, never over a stored value.
    pub if_absent: bool,
    /// Skipped when the value stored at this path is already set (judged against the section as
    /// it was before the whole patch, so changes sharing a guard stand or fall together).
    pub unless_set: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChangeOp {
    Set(Value),
    Remove,
}

impl ConfigChange {
    pub fn set(path: &[&str], value: Value) -> Self {
        Self { path: path.iter().map(|k| (*k).to_owned()).collect(), op: ChangeOp::Set(value), if_absent: false, unless_set: None }
    }

    pub fn remove(path: &[&str]) -> Self {
        Self { path: path.iter().map(|k| (*k).to_owned()).collect(), op: ChangeOp::Remove, if_absent: false, unless_set: None }
    }
}

/// `isDeepStrictEqual` over parsed JSON: key order is ignored, numbers compare by value.
pub fn js_deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| js_deep_equal(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(key, p)| y.get(key).is_some_and(|q| js_deep_equal(p, q)))
        }
        _ => a == b,
    }
}

/// `diffConfig`: arrays are one setting, object fields are independent edits.
pub fn diff_config(before: &Doc, after: &Doc) -> Vec<ConfigChange> {
    let mut out = Vec::new();
    diff_into(before, after, &mut Vec::new(), &mut out);
    out
}

fn diff_into(before: &Doc, after: &Doc, path: &mut Vec<String>, out: &mut Vec<ConfigChange>) {
    let keys = before.keys().chain(after.keys().filter(|key| !before.contains_key(*key)));
    for key in keys {
        let previous = before.get(key);
        let next = after.get(key);
        if match (previous, next) {
            (Some(p), Some(n)) => js_deep_equal(p, n),
            (None, None) => true,
            _ => false,
        } {
            continue;
        }
        path.push(key.clone());
        match next {
            Some(Value::Object(next_map))
                if matches!(previous, Some(Value::Object(_))) || (previous.is_none() && !next_map.is_empty()) =>
            {
                let empty = Doc::new();
                let previous_map = previous.and_then(Value::as_object).unwrap_or(&empty);
                diff_into(previous_map, next_map, path, out);
            }
            None => out.push(ConfigChange { path: path.clone(), op: ChangeOp::Remove, if_absent: false, unless_set: None }),
            Some(value) => out.push(ConfigChange {
                path: path.clone(),
                op: ChangeOp::Set(value.clone()),
                if_absent: false,
                unless_set: None,
            }),
        }
        path.pop();
    }
}

/// `applyConfigPatch`.
pub fn apply_config_patch(current: &Doc, changes: &[ConfigChange]) -> Doc {
    let mut next = current.clone();
    for change in changes {
        if change.unless_set.as_ref().is_some_and(|guard| is_set(value_at(current, guard))) {
            continue;
        }
        apply_field(&mut next, &change.path, change);
    }
    next
}

fn is_set(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null)) && value != Some(&Value::String(String::new()))
}

fn value_at<'a>(source: &'a Doc, path: &[String]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut value = source.get(first)?;
    for key in rest {
        value = value.as_object()?.get(key)?;
    }
    Some(value)
}

fn apply_field(map: &mut Doc, path: &[String], change: &ConfigChange) {
    let Some((key, rest)) = path.split_first() else { return };
    let removes = matches!(change.op, ChangeOp::Remove);
    if removes && !rest.is_empty() && !map.contains_key(key) {
        return;
    }
    if change.if_absent && rest.is_empty() && map.contains_key(key) {
        return;
    }
    if rest.is_empty() && removes {
        map.shift_remove(key);
    } else if rest.is_empty() {
        if let ChangeOp::Set(value) = &change.op {
            map.insert(key.clone(), value.clone());
        }
    } else {
        // A non-object value on the way is replaced by a fresh object, as `applyField` does.
        let mut child = match map.get(key) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Doc::new(),
        };
        apply_field(&mut child, rest, change);
        map.insert(key.clone(), Value::Object(child));
    }
}

/// The Lead route lives in these two stored keys; a conditional fill writes them only while
/// `default` is still unset on disk.
pub fn guard_lead_fill(changes: Vec<ConfigChange>) -> Vec<ConfigChange> {
    changes
        .into_iter()
        .map(|mut change| {
            if matches!(change.path.first().map(String::as_str), Some("default" | "presets")) {
                change.unless_set = Some(vec!["default".into()]);
            }
            change
        })
        .collect()
}

/// `seedChanges`: a fresh profile's empty `builtins` equals the defaults, so no diff carries it,
/// yet on disk its absence reads as a grandfathered profile. The first write seeds it.
pub fn seed_changes(config: &Doc, changes: &[ConfigChange]) -> Vec<ConfigChange> {
    match config.get("builtins") {
        Some(value) if !changes.iter().any(|c| c.path.first().map(String::as_str) == Some("builtins")) => {
            vec![ConfigChange { path: vec!["builtins".into()], op: ChangeOp::Set(value.clone()), if_absent: true, unless_set: None }]
        }
        _ => Vec::new(),
    }
}

/// `createConfigPatch(before, after)`: the difference of the two stored forms.
pub fn create_config_patch(before: &Doc, after: &Doc) -> Vec<ConfigChange> {
    diff_config(&stored_form(before), &stored_form(after))
}

/// The Lead route the config selects: the preset `default` names by id or name
/// (`findPreset`, case-insensitive), as stored.
pub fn lead_route(agent: &Doc) -> Option<Value> {
    let clean = |value: Option<&Value>| value.map(mixdog_js::value_to_string).filter(|_| !matches!(value, Some(Value::Null))).unwrap_or_default();
    let wanted = mixdog_js::js_trim(&clean(agent.get("default"))).to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    agent.get("presets")?.as_array()?.iter().find(|preset| {
        let same = |key: &str| mixdog_js::js_trim(&clean(preset.get(key))).to_lowercase() == wanted;
        same("id") || same("name")
    }).cloned()
}

const DEFAULT_ORCHESTRATION_MODE: &str = "balanced";
const DEFAULT_HEARTBEAT_INTERVAL_MINUTES: i64 = 60;
const HEARTBEAT_INTERVAL_CHOICES: [i64; 4] = [30, 60, 120, 240];
pub(super) const DEFAULT_DISABLED_ROSTER: [&str; 9] =
    ["worker", "heavy-worker", "reviewer", "advisor", "security", "front-worker", "writer", "maintainer", "explore"];
const PROVIDER_EPHEMERAL_KEYS: [&str; 4] = ["apiKey", "enabled", "baseURL", "credentialProbeUnavailable"];

/// The stored form of an effective agent config: the ported part of `buildAgentSaveBuilder`
/// followed by `stripAgentSectionDefaults`. Provider credentials and probe markers are not
/// stored, route storage is canonical, and every value equal to its default is dropped.
///
/// Sections whose normalisers belong to other owners (profile, skills, extension scopes,
/// the codex catalog migration of saved routes, retired local-provider routes, workflow
/// selection) pass through as given; they cancel out of a patch unless a side changed them.
pub fn stored_form(config: &Doc) -> Doc {
    let mut routes = config.clone();
    super::agent_routes::canonicalize(&mut routes);
    let mut next = Doc::new();
    next.insert("providers".into(), Value::Object(slim_providers(routes.get("providers"))));
    next.insert("mcpServers".into(), config.get("mcpServers").filter(|v| v.is_object()).cloned().unwrap_or_else(|| Value::Object(Doc::new())));
    let presets: Vec<Value> = routes
        .get("presets")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(normalize_preset)
                .filter(|p| p.get("id").and_then(Value::as_str) != Some("workflow-search"))
                .collect()
        })
        .unwrap_or_default();
    next.insert("presets".into(), Value::Array(presets));
    // Node stores the normalised route, `null` when it has none (`normalizeWebSearchRoute`).
    next.insert("webSearchRoute".into(), stored_web_search_route(config.get("webSearchRoute").unwrap_or(&Value::Null)));
    let default = routes.get("default").filter(|v| is_truthy(v)).cloned().unwrap_or(Value::Null);
    next.insert("default".into(), default);
    for key in ["maintenance", "agents"] {
        next.insert(key.into(), routes.get(key).cloned().unwrap_or_else(|| Value::Object(Doc::new())));
    }
    for key in [
        "modelSettings",
        "onboarding",
        "workflow",
        "orchestrationMode",
        "profile",
        "skills",
        "extensionScopes",
        "autoClear",
        "compaction",
        "shell",
        "update",
        "recap",
        "worktree",
        "networkProxy",
        "modules",
        "builtins",
        "instructionFiles",
        "autoEffortBase",
    ] {
        if let Some(value) = config.get(key) {
            // Node stores `config.update || {}`, `onboarding || {}` and `recap || {}`.
            if is_truthy(value) {
                next.insert(key.into(), value.clone());
            } else if matches!(key, "update" | "onboarding" | "recap") {
                next.insert(key.into(), Value::Object(Doc::new()));
            }
        } else if matches!(key, "update" | "onboarding" | "recap" | "modelSettings") {
            next.insert(key.into(), Value::Object(Doc::new()));
        }
    }
    if let Some(plugin) = config.get("pluginMcp").and_then(Value::as_object).filter(|m| !m.is_empty()) {
        next.insert("pluginMcp".into(), Value::Object(plugin.clone()));
    }
    if let Some(dev) = config.get("developer").and_then(Value::as_object) {
        let booleans: Doc = dev.iter().filter(|(_, v)| v.is_boolean()).map(|(k, v)| (k.clone(), v.clone())).collect();
        if !booleans.is_empty() {
            next.insert("developer".into(), Value::Object(booleans));
        }
    }
    let (disabled, enabled) = disabled_delta(routes.get("disabledAgents"));
    if !disabled.is_empty() {
        next.insert("disabledAgents".into(), Value::from(disabled));
    }
    if !enabled.is_empty() {
        next.insert("enabledAgents".into(), Value::from(enabled));
    }
    if config.get("memoryTools").is_some_and(Value::is_object) {
        next.insert("memoryTools".into(), config["memoryTools"].clone());
    }
    if config.get("aiSessionTitles") == Some(&Value::Bool(false)) {
        next.insert("aiSessionTitles".into(), Value::Bool(false));
    }
    if config.get("heartbeat") == Some(&Value::Bool(true)) {
        next.insert("heartbeat".into(), Value::Bool(true));
    }
    let minutes = config
        .get("heartbeatIntervalMinutes")
        .and_then(Value::as_f64)
        .filter(|m| HEARTBEAT_INTERVAL_CHOICES.iter().any(|c| *c as f64 == *m))
        .map_or(DEFAULT_HEARTBEAT_INTERVAL_MINUTES, |m| m as i64);
    if minutes != DEFAULT_HEARTBEAT_INTERVAL_MINUTES {
        next.insert("heartbeatIntervalMinutes".into(), Value::from(minutes));
    }
    if config.get("reactions") == Some(&Value::Bool(false)) {
        next.insert("reactions".into(), Value::Bool(false));
    }
    if config.get("promptCacheWarming") == Some(&Value::Bool(true)) {
        next.insert("promptCacheWarming".into(), Value::Bool(true));
    }
    if let Some(order) = config.get("botOrder").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
        next.insert("botOrder".into(), order.clone());
    }
    if let Some(avatar) = config.get("leadAvatar").filter(|v| v.is_object()) {
        next.insert("leadAvatar".into(), avatar.clone());
    }
    strip_agent_section_defaults(&mut next);
    next
}

/// JS truthiness of a stored value (`config.default || null`, `config.worktree ? … : {}`).
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Providers keep `enabled`, `baseURL` and any unknown subkey; the key and the per-load probe
/// observation are never stored, and neither is an `enabled: false` the probe produced.
fn slim_providers(providers: Option<&Value>) -> Doc {
    let mut out = Doc::new();
    for (name, value) in providers.and_then(Value::as_object).into_iter().flatten() {
        let Some(provider) = value.as_object() else { continue };
        let probe_unavailable = provider.get("credentialProbeUnavailable") == Some(&Value::Bool(true));
        let mut slim = Doc::new();
        if let Some(enabled) = provider.get("enabled").filter(|v| v.is_boolean())
            && !(probe_unavailable && enabled == &Value::Bool(false))
        {
            slim.insert("enabled".into(), enabled.clone());
        }
        if let Some(base) = provider.get("baseURL").filter(|v| is_truthy(v)) {
            slim.insert("baseURL".into(), base.clone());
        }
        for (key, value) in provider {
            if !PROVIDER_EPHEMERAL_KEYS.contains(&key.as_str()) {
                slim.insert(key.clone(), value.clone());
            }
        }
        if !slim.is_empty() {
            out.insert(name.clone(), Value::Object(slim));
        }
    }
    out
}

/// `disabledAgentDelta(disabledAgents)`: what the user turned off beyond the default roster, and
/// the default-off agents they turned on.
fn disabled_delta(effective: Option<&Value>) -> (Vec<String>, Vec<String>) {
    disabled_delta_of(&super::agent_routes::id_list(effective))
}

/// `disabledAgentDelta` over an id list that is already key-normalised, sorted and de-duplicated.
pub(super) fn disabled_delta_of(wanted: &[String]) -> (Vec<String>, Vec<String>) {
    let disabled = wanted.iter().filter(|id| !DEFAULT_DISABLED_ROSTER.contains(&id.as_str())).cloned().collect();
    let mut enabled: Vec<String> =
        DEFAULT_DISABLED_ROSTER.iter().filter(|id| !wanted.iter().any(|w| w == **id)).map(|s| (*s).to_owned()).collect();
    enabled.sort();
    (disabled, enabled)
}

/// `stripAgentSectionDefaults`.
fn strip_agent_section_defaults(next: &mut Doc) {
    if next.get("orchestrationMode").and_then(Value::as_str) == Some(DEFAULT_ORCHESTRATION_MODE) {
        next.shift_remove("orchestrationMode");
    }
    if next.get("workflow").is_some_and(|w| js_deep_equal(w, &serde_json::json!({ "active": "default" }))) {
        next.shift_remove("workflow");
    }
    let worktree_defaults = serde_json::to_value(mixdog_scm::worktree::settings::normalize(&Value::Null)).unwrap_or(Value::Null);
    let sections: [(&str, Value); 6] = [
        ("autoClear", serde_json::json!({ "enabled": true, "minContextPercent": 10 })),
        ("compaction", serde_json::json!({ "auto": true })),
        ("update", serde_json::json!({ "auto": true })),
        ("recap", serde_json::json!({ "enabled": true })),
        ("memoryTools", serde_json::json!({ "enabled": true })),
        ("worktree", worktree_defaults),
    ];
    for (key, defaults) in sections {
        if let Some(value) = next.get(key).cloned() {
            match without_defaults(&value, &defaults) {
                Some(kept) => {
                    next.insert(key.into(), kept);
                }
                None => {
                    next.shift_remove(key);
                }
            }
        }
    }
    if let Some(Value::Object(modules)) = next.get("modules").cloned() {
        let kept: Doc = modules
            .iter()
            .filter_map(|(name, entry)| without_defaults(entry, &serde_json::json!({ "enabled": true })).map(|e| (name.clone(), e)))
            .collect();
        if kept.is_empty() {
            next.shift_remove("modules");
        } else {
            next.insert("modules".into(), Value::Object(kept));
        }
    }
}

/// The copy of `value` without the keys equal to their default; `None` when nothing is left.
fn without_defaults(value: &Value, defaults: &Value) -> Option<Value> {
    let (Value::Object(map), Value::Object(defaults)) = (value, defaults) else { return Some(value.clone()) };
    let kept: Doc = map
        .iter()
        .filter(|(key, v)| !defaults.get(*key).is_some_and(|d| js_deep_equal(v, d)))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
