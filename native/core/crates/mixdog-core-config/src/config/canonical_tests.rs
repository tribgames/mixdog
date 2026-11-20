//! The canonical document: the retired discord channel key is dropped.

use serde_json::Value;

use super::super::Doc;
use super::canonicalize;

fn doc_of(value: &Value) -> Doc {
    value.as_object().cloned().unwrap_or_default()
}

/// `readConfig()`: the canonical document without the root generated marker.
fn read_config(raw: &Value) -> Value {
    let mut doc = canonicalize(doc_of(raw));
    doc.shift_remove("_generated");
    Value::Object(doc)
}

/// The Discord channel no longer exists: an old file's `channels.discord` (token included) is dropped on read, so the next
/// save does not write it back and nothing reads it.
#[test]
fn the_retired_discord_channel_key_is_dropped() {
    let raw = serde_json::json!({ "channels": { "discord": { "token": "x" }, "webhook": { "port": 3333 } } });
    assert_eq!(read_config(&raw), serde_json::json!({ "channels": { "webhook": { "port": 3333 } } }));
}
