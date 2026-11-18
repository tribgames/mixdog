//! The canonical document against what Node's reads and saves settle on
//! (`benchmarks/rust-core/recorders/record-config-canonical.mjs`), and the cycles' view of the
//! memory section over it (`benchmarks/rust-core/recorders/record-cycle-config.mjs`).

#[cfg(node_twin)]
use std::sync::Arc;

#[cfg(node_twin)]
use mixdog_services::memory::cycles::CycleConfig;
#[cfg(node_twin)]
use mixdog_services::memory::cycles::config::DocCycleConfig;
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


#[cfg(node_twin)]
const GOLDEN: &str = include_str!("../../../../fixtures/config/canonical/golden.json");
#[cfg(node_twin)]
const CYCLE_GOLDEN: &str = include_str!("../../../../fixtures/tools/memory/cycle-config/golden.json");
#[cfg(node_twin)]
#[test]
fn reads_settle_on_the_document_node_serves() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
    for case in golden["cases"].as_array().expect("cases") {
        assert_eq!(read_config(&case["config"]), case["expected"], "{}", case["name"]);
    }
}
#[cfg(node_twin)]
#[test]
fn canonicalizing_twice_changes_nothing() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
    for case in golden["cases"].as_array().expect("cases") {
        let once = canonicalize(doc_of(&case["config"]));
        assert_eq!(canonicalize(once.clone()), once, "{}", case["name"]);
    }
}
/// The cycles read the memory section through `Config::full()`, which is canonical, so the
/// cycle-config golden (raw files as Node reads them) is replayed over the canonical document.
#[cfg(node_twin)]
#[test]
fn the_cycle_config_matches_node_over_the_canonical_document() {
    let golden: Value = serde_json::from_str(CYCLE_GOLDEN).expect("golden");
    for case in golden["cases"].as_array().expect("cases") {
        let name = &case["name"];
        let doc = Arc::new(canonicalize(doc_of(&case["config"])));
        let vars: std::collections::HashMap<String, String> = case["env"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
            .collect();
        let config = DocCycleConfig::new(Arc::new(move || doc.clone()), Arc::new(move |name| vars.get(name).cloned()));
        assert_eq!(config.memory_section(), case["memory"], "{name}: memory section");
        assert_eq!(config.cycles_enabled(), case["cyclesEnabled"].as_bool().expect("flag"), "{name}: cycles enabled");
        assert_eq!(config.maintenance_preset().unwrap_or(Value::Null), case["preset"], "{name}: maintenance preset");
    }
}
