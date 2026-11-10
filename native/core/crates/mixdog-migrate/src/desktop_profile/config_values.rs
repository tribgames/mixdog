//! The profile files that become keys of `<D>/mixdog-config.json` (SPEC §4.11): greeted
//! agents, notification preferences, auto-retention state, the remote activation stamp
//! and the unclassified workspace root. Each value is the desktop's own read model of
//! its file. The staged output is the whole next config file (FORMAT.md §10.4).

use std::path::Path;

use mixdog_store::fsio;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::Target;
use serde_json::Map;
use serde_json::Value;

use super::Staged;
use super::error::ApplyError;
use super::error::Step;
use super::fsx;
use super::jsvalue;
use super::source;
use super::source::Parsed;
use crate::durable;
use crate::error::Blocked;
use crate::framework::ItemContext;

pub(super) const CONFIG_FILE: &str = "mixdog-config.json";

fn schema_violation(detail: &str) -> ApplyError {
    ApplyError::quarantine(QuarantineCode::SchemaViolation, detail)
}

/// `agentGreetingsFileStore.read`: the string ids of `seen`, written back sorted and unique.
pub fn greeted(value: &Value) -> Value {
    let mut ids: Vec<&str> = value
        .get("seen")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids.into_iter().map(Value::from).collect()
}

/// `normalizeRecord` of the auto-retention state; `enabledAt` is absent when the file
/// holds none (the runtime stamps it on first use, as the desktop does).
pub fn retention_state(value: &Value) -> Value {
    let mut state = Map::new();
    if let Some(enabled_at) = value.get("enabledAt").and_then(jsvalue::positive) {
        state.insert("enabledAt".into(), Value::Number(enabled_at.clone()));
    }
    let restored: Map<String, Value> = value
        .get("restored")
        .and_then(jsvalue::object)
        .into_iter()
        .flatten()
        .filter_map(|(id, at)| Some((id.clone(), Value::Number(jsvalue::positive(at)?.clone()))))
        .collect();
    state.insert("restored".into(), Value::Object(restored));
    Value::Object(state)
}

/// The stamp `isRemoteActivated` only tests for presence of.
pub fn remote_activated(value: &Value) -> Result<Value, ApplyError> {
    value
        .get("activatedAt")
        .and_then(jsvalue::positive)
        .map(|at| Value::Number(at.clone()))
        .ok_or_else(|| schema_violation("remote-activated.json has no activatedAt"))
}

const EVENTS: [(&str, bool); 4] = [
    ("finished", true),
    ("question", true),
    ("approval", true),
    ("error", false),
];

fn flag(raw: Option<&Value>, fallback: bool) -> bool {
    raw.and_then(Value::as_bool).unwrap_or(fallback)
}

/// `HH:MM`, `[01]\d|2[0-3]` then `[0-5]\d`.
fn is_clock_time(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && matches!((b[0], b[1]), (b'0' | b'1', _) | (b'2', b'0'..=b'3'))
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit()
}

fn clock(raw: Option<&Value>, fallback: &str) -> String {
    raw.and_then(Value::as_str)
        .filter(|text| is_clock_time(text))
        .unwrap_or(fallback)
        .to_owned()
}

/// `storedPreferences`: each field falls back to the default when missing or invalid.
fn device_preferences(value: &Value) -> Value {
    let stored = jsvalue::object(value);
    let field = |name: &str| stored.and_then(|stored| stored.get(name));
    let events = field("events").and_then(jsvalue::object);
    let quiet = field("quietHours").and_then(jsvalue::object);
    let quiet_field = |name: &str| quiet.and_then(|quiet| quiet.get(name));
    let choice = |raw: Option<&Value>, allowed: &[&str], fallback: &str| {
        raw.and_then(Value::as_str)
            .filter(|text| allowed.contains(text))
            .unwrap_or(fallback)
            .to_owned()
    };
    let events: Map<String, Value> = EVENTS
        .iter()
        .map(|(name, fallback)| {
            let enabled = flag(events.and_then(|events| events.get(*name)), *fallback);
            ((*name).to_owned(), Value::Bool(enabled))
        })
        .collect();
    let mut prefs = Map::new();
    prefs.insert("scope".into(), choice(field("scope"), &["all", "bots", "off"], "all").into());
    prefs.insert("events".into(), Value::Object(events));
    prefs.insert("automaticRuns".into(), flag(field("automaticRuns"), true).into());
    let mut quiet_hours = Map::new();
    quiet_hours.insert("enabled".into(), flag(quiet_field("enabled"), false).into());
    quiet_hours.insert("start".into(), clock(quiet_field("start"), "23:00").into());
    quiet_hours.insert("end".into(), clock(quiet_field("end"), "08:00").into());
    quiet_hours.insert(
        "days".into(),
        choice(quiet_field("days"), &["every", "weekdays", "weekends"], "every").into(),
    );
    quiet_hours.insert("allowWaiting".into(), flag(quiet_field("allowWaiting"), false).into());
    prefs.insert("quietHours".into(), Value::Object(quiet_hours));
    prefs.insert(
        "holdWhileDesktopActive".into(),
        flag(field("holdWhileDesktopActive"), true).into(),
    );
    prefs.insert("taskbarFlash".into(), flag(field("taskbarFlash"), true).into());
    Value::Object(prefs)
}

/// `^[\w.:-]{1,200}$`.
fn is_target_id(text: &str) -> bool {
    (1..=200).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// `storedOverride`: an entry the desktop would drop is dropped.
fn stored_override(value: &Value) -> Option<Value> {
    let entry = jsvalue::object(value)?;
    let target = entry.get("target").and_then(jsvalue::object)?;
    let kind = target.get("kind").and_then(Value::as_str)?;
    let id = target.get("id").and_then(Value::as_str)?;
    if !matches!(kind, "session" | "agent" | "room") || !is_target_id(id) {
        return None;
    }
    let setting = entry.get("setting").and_then(jsvalue::object);
    let mode = setting.and_then(|setting| setting.get("mode")).and_then(Value::as_str)?;
    let setting = match mode {
        "always" => serde_json::json!({ "mode": "always" }),
        "muted" => {
            let until = setting?.get("until")?;
            let valid = until.is_null() || jsvalue::safe_integer(until).is_some_and(|until| until > 0);
            if !valid {
                return None;
            }
            serde_json::json!({ "mode": "muted", "until": until })
        }
        _ => return None,
    };
    Some(serde_json::json!({ "target": { "kind": kind, "id": id }, "setting": setting }))
}

/// `storedDoc` of the notification preferences. Overrides are kept as stored: an
/// expired mute is pruned by the runtime when it reads them, not here.
pub fn notifications(value: &Value) -> Result<Value, ApplyError> {
    let doc = jsvalue::object(value).ok_or_else(|| schema_violation("notification preferences are not an object"))?;
    if doc.get("version").and_then(jsvalue::safe_integer) != Some(1) {
        return Err(schema_violation("the notification preferences are not version 1"));
    }
    let devices: Map<String, Value> = doc
        .get("devices")
        .and_then(jsvalue::object)
        .into_iter()
        .flatten()
        .map(|(id, prefs)| (id.clone(), device_preferences(prefs)))
        .collect();
    let overrides: Vec<Value> = doc
        .get("overrides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(stored_override)
        .collect();
    let migrated_at = doc.get("migratedAt").and_then(jsvalue::safe_integer).unwrap_or(0);
    Ok(serde_json::json!({
        "migratedAt": migrated_at,
        "devices": devices,
        "overrides": overrides,
    }))
}

fn config_key(item: &ManifestItem) -> Result<&str, ApplyError> {
    match &item.target {
        Some(Target::ConfigKey { key }) => Ok(key),
        _ => Err(schema_violation("a config item has no config key target")),
    }
}

/// The value the item writes at its key, and the lone surrogates replaced reading it.
fn config_value(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<(Value, u64)> {
    if item.kind == ItemKind::UnclassifiedWorkspace {
        let path = super::profile_dir(cx)?.join("workspace").join("unclassified");
        let text = path
            .to_str()
            .ok_or_else(|| schema_violation("the unclassified workspace path is not UTF-8"))?;
        return Ok((Value::String(text.to_owned()), 0));
    }
    let bytes = source::read_source(cx, super::single_source(item)?)?;
    let Parsed {
        value,
        replaced_surrogates,
    } = source::parse_json(&bytes)?;
    let converted = match item.kind {
        ItemKind::AgentGreetings => greeted(&value),
        ItemKind::NotificationPreferences => notifications(&value)?,
        ItemKind::RetentionState => retention_state(&value),
        ItemKind::RemoteActivated => remote_activated(&value)?,
        other => return Err(schema_violation(&format!("{other:?} is not a config item"))),
    };
    Ok((converted, replaced_surrogates))
}

/// The current config document; a missing file is the empty document.
fn read_config(data: &Path) -> Result<(Value, Option<String>), ApplyError> {
    let path = data.join(CONFIG_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Value::Object(Map::new()), None));
        }
        Err(error) => return Err(ApplyError::io("read", &path, error)),
    };
    let hash = durable::sha256_hex(&bytes);
    // A config that does not parse is never quarantined: the run stops (SM §11.5).
    let schema = |detail: String| {
        ApplyError::Blocked(Blocked::StoreSchema {
            key: CONFIG_FILE.to_owned(),
            detail,
        })
    };
    let text = std::str::from_utf8(&bytes).map_err(|error| schema(error.to_string()))?;
    // A profile title a phone sent cut inside an emoji is stored by Node with half of it: U+FFFD here.
    let doc: Value = serde_json::from_str(&mixdog_js::json_well_formed_str(text.strip_prefix('\u{feff}').unwrap_or(text)))
        .map_err(|error| schema(error.to_string()))?;
    if !doc.is_object() {
        return Err(schema("the config is not an object".to_owned()));
    }
    Ok((doc, Some(hash)))
}

fn set_path(doc: &mut Value, key: &str, value: Value, path: &Path) -> Result<(), ApplyError> {
    let mut parts = key.split('.').peekable();
    let mut node = doc;
    while let Some(part) = parts.next() {
        let map = node
            .as_object_mut()
            .ok_or_else(|| ApplyError::blocked("write", path, "a config key on the path is not an object"))?;
        if parts.peek().is_none() {
            map.insert(part.to_owned(), value);
            return Ok(());
        }
        node = map.entry(part.to_owned()).or_insert_with(|| Value::Object(Map::new()));
    }
    Ok(())
}

fn get_path<'a>(doc: &'a Value, key: &str) -> Option<&'a Value> {
    key.split('.').try_fold(doc, |node, part| node.get(part))
}

pub(super) fn stage(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<Staged> {
    let data = cx.roots.data.as_path();
    let key = config_key(item)?;
    let (value, replaced_surrogates) = config_value(cx, item)?;
    let (mut doc, _) = read_config(data)?;
    set_path(&mut doc, key, value, &data.join(CONFIG_FILE))?;
    let mut bytes = serde_json::to_vec_pretty(&doc).expect("a value serializes");
    bytes.push(b'\n');
    let path = cx.stage_dir(item.key.as_str()).join(CONFIG_FILE);
    // The config may hold credentials of other features: the replacement is owner-only.
    fsx::write_new(&path, &bytes, true).map_err(|error| ApplyError::io("write", &path, error))?;
    Ok(Staged {
        output_sha256: durable::sha256_hex(&bytes),
        replaced_surrogates,
    })
}

/// Replaces the config with the staged file, unless it already is that file.
pub(super) fn publish(cx: &ItemContext<'_>, item: &ManifestItem, output_sha256: &str) -> Step<()> {
    let data = cx.roots.data.as_path();
    if read_config(data)?.1.as_deref() == Some(output_sha256) {
        return Ok(());
    }
    let staged = cx.stage_dir(item.key.as_str()).join(CONFIG_FILE);
    Ok(durable::durable_rename(&staged, &data.join(CONFIG_FILE))?)
}

/// Removes the item's key again, before its source is quarantined.
pub(super) fn withdraw(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<()> {
    let key = config_key(item)?;
    let (mut doc, hash) = read_config(&cx.roots.data)?;
    if hash.is_none() {
        return Ok(());
    }
    let mut parent = &mut doc;
    let mut parts = key.split('.').peekable();
    while let Some(part) = parts.next() {
        let Some(map) = parent.as_object_mut() else {
            return Ok(());
        };
        if parts.peek().is_none() {
            map.shift_remove(part);
            break;
        }
        let Some(next) = map.get_mut(part) else {
            return Ok(());
        };
        parent = next;
    }
    let mut bytes = serde_json::to_vec_pretty(&doc).expect("a value serializes");
    bytes.push(b'\n');
    // The config may hold credentials: it stays owner-only, as `stage` made it.
    let path = cx.roots.data.join(CONFIG_FILE);
    fsio::publish_file_with(&path, &bytes, fsio::Access::OwnerOnly).map_err(|error| ApplyError::io("write", &path, error.source))
}

pub(super) fn verify(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<Digest> {
    let key = config_key(item)?;
    let (expected, _) = config_value(cx, item)?;
    let (doc, _) = read_config(&cx.roots.data)?;
    if get_path(&doc, key).map(source::canonical_text) != Some(source::canonical_text(&expected)) {
        return Err(ApplyError::quarantine(
            QuarantineCode::DigestMismatch,
            format!("config key {key} differs from the source"),
        ));
    }
    Ok(source::digest_value(&expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    /// A config Node wrote with a profile title a phone sent cut inside an emoji
    /// (`native/core/fixtures/lone-surrogate-files`, record-lone-surrogate-files.mjs): the migration reads the document
    /// Node's `JSON.parse` reads (the half emoji as U+FFFD) instead of stopping the run.
    #[test]
    fn a_config_node_wrote_with_half_an_emoji_is_read_whole() {
        let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
        let cases: Value = json(&std::fs::read_to_string(set.join("cases.json")).unwrap());
        let case = cases.as_array().unwrap().iter().find(|c| c["name"] == "config-profile").unwrap();
        let data = tempfile::tempdir().unwrap();
        std::fs::copy(set.join("config-profile/before").join(CONFIG_FILE), data.path().join(CONFIG_FILE)).unwrap();
        let (doc, hash) = read_config(data.path()).unwrap();
        assert_eq!(doc.to_string(), case["before"][CONFIG_FILE].to_string());
        assert!(hash.is_some());
    }

    #[test]
    fn greeted_is_sorted_unique_strings() {
        assert_eq!(greeted(&json(r#"{"seen":["b","a","b",3]}"#)), json(r#"["a","b"]"#));
        assert_eq!(greeted(&json(r#"{"seen":"x"}"#)), json("[]"));
    }

    #[test]
    fn retention_keeps_only_positive_stamps() {
        let state = retention_state(&json(r#"{"enabledAt":5,"restored":{"a":1,"b":0,"c":"x"}}"#));
        assert_eq!(state, json(r#"{"enabledAt":5,"restored":{"a":1}}"#));
        assert_eq!(retention_state(&json("{}")), json(r#"{"restored":{}}"#));
    }

    #[test]
    fn notification_fields_fall_back_to_the_defaults_one_by_one() {
        let doc = notifications(&json(
            r#"{"version":1,"migratedAt":9,
            "devices":{"pc":{"scope":"bots","events":{"error":true,"finished":"x"},
                             "quietHours":{"start":"25:00","end":"07:30","days":"weekdays"}}},
            "overrides":[{"target":{"kind":"agent","id":"a1"},"setting":{"mode":"muted","until":null}},
                         {"target":{"kind":"agent","id":"bad id"},"setting":{"mode":"always"}},
                         {"target":{"kind":"room","id":"r"},"setting":{"mode":"muted","until":-1}}]}"#,
        ))
        .unwrap();
        let pc = &doc["devices"]["pc"];
        assert_eq!(pc["scope"], "bots");
        assert_eq!(pc["events"], json(r#"{"finished":true,"question":true,"approval":true,"error":true}"#));
        assert_eq!(pc["quietHours"]["start"], "23:00");
        assert_eq!(pc["quietHours"]["end"], "07:30");
        assert_eq!(pc["quietHours"]["days"], "weekdays");
        assert_eq!(pc["taskbarFlash"], true);
        assert_eq!(doc["overrides"].as_array().unwrap().len(), 1);
        assert_eq!(doc["migratedAt"], 9);
    }

    #[test]
    fn notifications_of_another_version_are_a_schema_violation() {
        assert!(notifications(&json(r#"{"version":2}"#)).is_err());
        assert!(notifications(&json("[]")).is_err());
    }

    #[test]
    fn a_device_with_an_empty_id_is_kept() {
        let doc = notifications(&json(r#"{"version":1,"devices":{"":{"scope":"off"}}}"#)).unwrap();
        assert_eq!(doc["devices"][""]["scope"], "off");
    }

    #[test]
    fn config_paths_nest_and_replace() {
        let mut doc = json(r#"{"desktop":{"zoom":1}}"#);
        set_path(&mut doc, "desktop.retentionState", json("{}"), Path::new("c")).unwrap();
        set_path(&mut doc, "agents.greeted", json("[]"), Path::new("c")).unwrap();
        assert_eq!(doc, json(r#"{"desktop":{"zoom":1,"retentionState":{}},"agents":{"greeted":[]}}"#));
        assert_eq!(get_path(&doc, "desktop.zoom"), Some(&json("1")));
        assert!(set_path(&mut doc, "desktop.zoom.x", json("1"), Path::new("c")).is_err());
    }
}
