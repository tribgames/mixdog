use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::json;

use super::*;
use crate::config::Applied;
use crate::config::Config;
use crate::config::ConfigLanes;

fn doc(value: &Value) -> Doc {
    value.as_object().cloned().unwrap_or_default()
}

fn change_of(value: &Value) -> ConfigChange {
    let path = value["path"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_owned()).collect();
    ConfigChange {
        path,
        op: if value.get("remove").is_some() { ChangeOp::Remove } else { ChangeOp::Set(value["value"].clone()) },
        if_absent: value.get("ifAbsent").is_some(),
        unless_set: value
            .get("unlessSet")
            .map(|g| g.as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_owned()).collect()),
    }
}

fn json_of(change: &ConfigChange) -> Value {
    let mut out = json!({ "path": change.path });
    match &change.op {
        ChangeOp::Set(value) => out["value"] = value.clone(),
        ChangeOp::Remove => out["remove"] = Value::Bool(true),
    }
    out
}

/// Equal as JSON values; numbers by value, so `1` and `1.0` agree as they do in JS.
fn same(a: &Value, b: &Value) -> bool {
    js_deep_equal(a, b)
}

#[test]
fn diff_and_apply_match_the_recorded_node_patch() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/config-patch-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 200);
    for (index, entry) in entries.iter().enumerate() {
        let changes = diff_config(&doc(&entry["before"]), &doc(&entry["after"]));
        // The fixture's objects are key-sorted, so the order of independent edits is compared
        // as a set; each edit is unique by path.
        let by_path = |list: &mut Vec<Value>| list.sort_by_key(|c| c["path"].to_string());
        let mut got: Vec<Value> = changes.iter().map(json_of).collect();
        let mut want = entry["changes"].as_array().unwrap().clone();
        by_path(&mut got);
        by_path(&mut want);
        assert!(same(&Value::Array(got), &Value::Array(want)), "entry {index}: diff {changes:?} vs {}", entry["changes"]);
        let applied = apply_config_patch(&doc(&entry["other"]), &changes);
        assert!(same(&Value::Object(applied), &entry["appliedToOther"]), "entry {index}: apply");
        let guarded: Vec<ConfigChange> = entry["guarded"].as_array().unwrap().iter().map(change_of).collect();
        let applied = apply_config_patch(&doc(&entry["other"]), &guarded);
        assert!(same(&Value::Object(applied), &entry["guardedOnOther"]), "entry {index}: guarded apply");
    }
}

#[test]
fn a_lead_fill_is_guarded_and_seeds_only_where_absent() {
    let changes = guard_lead_fill(vec![
        ConfigChange::set(&["default"], json!("p")),
        ConfigChange::set(&["presets"], json!([{ "id": "p" }])),
        ConfigChange::set(&["agents", "worker"], json!({})),
    ]);
    assert_eq!(changes[0].unless_set, Some(vec!["default".into()]));
    assert_eq!(changes[1].unless_set, Some(vec!["default".into()]));
    assert_eq!(changes[2].unless_set, None);
    let kept = apply_config_patch(&doc(&json!({ "default": "other" })), &changes);
    assert_eq!(kept["default"], "other");
    assert!(kept.get("presets").is_none(), "the guard holds for the whole fill");
    let seeds = seed_changes(&doc(&json!({ "builtins": {} })), &[]);
    assert_eq!(apply_config_patch(&doc(&json!({ "builtins": { "git": {} } })), &seeds)["builtins"], json!({ "git": {} }));
    assert_eq!(apply_config_patch(&doc(&json!({})), &seeds)["builtins"], json!({}));
}

#[test]
fn the_stored_form_drops_defaults_and_credentials() {
    let effective = doc(&json!({
        "providers": { "openai": { "apiKey": "sk", "enabled": true, "baseURL": "", "extra": 1 }, "p2": { "credentialProbeUnavailable": true, "enabled": false } },
        "reactions": true, "heartbeat": false, "heartbeatIntervalMinutes": 60, "aiSessionTitles": true,
        "recap": { "enabled": true }, "modules": { "git": { "enabled": true }, "office": { "enabled": false } },
        "orchestrationMode": "balanced", "workflow": { "active": "default" },
        "agents": { "worker": { "provider": "x" } }, "disabledAgents": ["worker", "advisor", "reviewer", "custom"],
    }));
    let stored = stored_form(&effective);
    assert_eq!(stored["providers"], json!({ "openai": { "enabled": true, "extra": 1 } }));
    for key in ["reactions", "heartbeat", "heartbeatIntervalMinutes", "aiSessionTitles", "orchestrationMode", "workflow"] {
        assert!(stored.get(key).is_none(), "{key}");
    }
    assert!(stored.get("recap").is_none(), "an all-default section is stored as nothing");
    assert_eq!(stored["modules"], json!({ "office": { "enabled": false } }));
    assert_eq!(stored["agents"], json!({}), "an incomplete route is not stored");
    assert_eq!(stored["disabledAgents"], json!(["custom"]));
    assert_eq!(stored["enabledAgents"], json!(["explore", "front-worker", "heavy-worker", "maintainer", "security", "writer"]));
}

async fn open(dir: &tempfile::TempDir, agent: Value) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": agent, "desktop": { "zoom": 1 } })).unwrap()).unwrap();
    Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap().0
}

#[tokio::test]
async fn a_save_keeps_what_another_writer_changed_meanwhile() {
    let dir = tempfile::tempdir().unwrap();
    let config = open(&dir, json!({ "default": "a", "agents": {} })).await;
    let before = config.agent();
    let mut after = before.clone();
    after.insert("reactions".into(), json!(false));
    // Another writer edits a different field after `before` was taken.
    config.update_agent(|agent| { agent.insert("heartbeat".into(), json!(true)); Ok(()) }).await.unwrap();
    let applied = config.save_agent_config(&before, &after, false).await.unwrap();
    assert!(!applied.changed.is_empty());
    let agent = config.agent();
    assert_eq!(agent["reactions"], json!(false));
    assert_eq!(agent["heartbeat"], json!(true), "the other writer's field survives");
    assert_eq!(config.get("desktop").unwrap(), json!({ "zoom": 1 }));
    // A save with no difference writes nothing.
    let applied = config.save_agent_config(&agent, &agent, false).await.unwrap();
    assert_eq!(applied, Applied::default());
}

#[tokio::test]
async fn a_conditional_lead_fill_loses_to_a_route_already_stored() {
    let dir = tempfile::tempdir().unwrap();
    let config = open(&dir, json!({ "default": "theirs", "presets": [{ "id": "theirs", "provider": "x", "model": "m1" }] })).await;
    let before = Doc::new();
    let after = doc(&json!({ "default": "mine", "presets": [{ "id": "mine", "provider": "y", "model": "m2" }] }));
    config.save_agent_config(&before, &after, true).await.unwrap();
    assert_eq!(config.agent()["default"], "theirs");
    let filled = json!({ "provider": "y", "model": "m2" });
    let winner = config.confirm_lead_fill(&filled).await.unwrap().unwrap();
    assert_eq!(winner["model"], "m1");
    let own = json!({ "provider": "x", "model": "m1" });
    assert_eq!(config.confirm_lead_fill(&own).await.unwrap(), None, "the file's route is the fill itself");
    // With nothing stored the fill stands.
    let empty = tempfile::tempdir().unwrap();
    let config = open(&empty, json!({})).await;
    config.save_agent_config(&Doc::new(), &after, true).await.unwrap();
    assert_eq!(config.agent()["default"], "mine");
    assert_eq!(config.confirm_lead_fill(&filled).await.unwrap(), None);
}

#[tokio::test]
async fn reload_full_config_reads_an_external_edit() {
    let dir = tempfile::tempdir().unwrap();
    let config = open(&dir, json!({ "default": "a" })).await;
    std::fs::write(dir.path().join("mixdog-config.json"), br#"{"agent":{"default":"b"}}"#).unwrap();
    assert_eq!(config.agent()["default"], "a");
    assert_eq!(config.reload_full_config().await.unwrap()["default"], "b");
}

#[allow(dead_code)]
fn _keep(_: Arc<()>) {}
