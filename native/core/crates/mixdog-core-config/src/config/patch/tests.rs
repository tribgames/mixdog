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

#[allow(dead_code)]
fn _keep(_: Arc<()>) {}

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

#[tokio::test]
async fn a_web_search_fallback_speed_edit_survives_a_config_reload() {
    let dir = tempfile::tempdir().unwrap();
    let config = open(&dir, json!({})).await;
    let before = config.agent();
    let mut first = before.clone();
    let primary = json!({"provider": "openai", "model": "m", "fast": true, "modelParameters": {"serviceTier": "ultrafast"}});
    let mut chain = primary.clone();
    chain["fallbacks"] = json!([{"provider": "openai-oauth", "model": "n", "fast": false}]);
    first.insert("webSearchRoute".into(), chain);
    config.save_agent_config(&before, &first, false).await.unwrap();

    let mut edited = first.clone();
    edited.get_mut("webSearchRoute").unwrap()["fallbacks"][0] =
        json!({"provider": "openai-oauth", "model": "n", "fast": true, "modelParameters": {"serviceTier": "priority"}});
    config.save_agent_config(&first, &edited, false).await.unwrap();
    let loaded = config.reload_full_config().await.unwrap();
    assert_eq!(loaded["webSearchRoute"], edited["webSearchRoute"]);
}


