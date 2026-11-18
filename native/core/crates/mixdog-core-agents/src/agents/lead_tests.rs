//! Mixy's identity through `LeadService`: her persona and way-of-working files, her created flag and her appearance.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;
use serde_json::Value;
use serde_json::json;

use super::lead::LeadAppearance;
use super::lead_service::LeadService;
use super::*;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

struct Quiet;

#[async_trait]
impl AgentEvidence for Quiet {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

#[derive(Default)]
struct Published(AtomicUsize);

#[async_trait]
impl AgentEffects for Published {
    async fn agents_changed(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
    async fn delete_owned_routines(&self, _: &str) -> Result<OwnedRoutines, String> {
        Ok(OwnedRoutines::default())
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    service: LeadService,
    published: Arc<Published>,
    data: std::path::PathBuf,
    n: std::sync::atomic::AtomicU64,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("mixdog-config.json");
    std::fs::write(&config_path, "{}").unwrap();
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let (shipped, data, state) = (dir.path().join("shipped"), dir.path().join("data"), dir.path().join("state"));
    for folder in [&shipped, &data, &state] {
        std::fs::create_dir_all(folder).unwrap();
    }
    let published = Arc::new(Published::default());
    let agents = AgentDefinitions::new(
        &shipped,
        &data,
        tokens.interactive_io,
        AgentRoutes::new(config.clone(), &data),
        Arc::new(Quiet),
        Arc::new(|| Value::Null),
        state.join("task"),
    )
    .with_writes(tokens.durability_io, published.clone(), Arc::new(String::new));
    let service = LeadService::new(Arc::new(agents), LeadAppearance::new(config), scopes(&state, "agent").await);
    Rig { _dir: dir, service, published, data, n: 1.into() }
}

impl Rig {
    async fn send(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let n = self.n.fetch_add(1, Ordering::SeqCst);
        value(&self.service, request(method, with_op(params, n), Some(n))).await
    }

    async fn get(&self, method: &'static str) -> Value {
        value(&self.service, request(method, json!({}), None)).await.unwrap()
    }

    fn lead(&self, file: &str) -> Option<Vec<u8>> {
        std::fs::read(self.data.join("agents/lead").join(file)).ok()
    }
}

fn message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_ref().map(ToString::to_string).unwrap_or_default(),
        other => other.to_string(),
    }
}

#[tokio::test]
async fn saving_the_persona_writes_the_text_and_an_empty_one_removes_the_file() {
    let rig = rig().await;
    assert_eq!(rig.send("agent/saveLeadPersona", json!({ "text": "  Warm and brief.  " })).await.unwrap(), json!("Warm and brief."));
    assert_eq!(rig.lead("PERSONA.md").unwrap(), b"Warm and brief.\n");
    assert_eq!(rig.get("agent/getLeadPersona").await, json!("Warm and brief."));
    assert_eq!(rig.published.0.load(Ordering::SeqCst), 1, "her threads take it from their next turn");
    assert_eq!(rig.send("agent/saveLeadPersona", json!({ "text": "" })).await.unwrap(), json!(""));
    assert!(rig.lead("PERSONA.md").is_none());
    assert_eq!(rig.get("agent/getLeadPersona").await, json!(""));
}

#[tokio::test]
async fn the_way_of_working_has_its_own_file_and_a_text_over_256_kb_is_refused() {
    let rig = rig().await;
    assert_eq!(rig.send("agent/saveLeadAgentBody", json!({ "text": "Be careful" })).await.unwrap(), json!("Be careful"));
    assert_eq!(rig.lead("AGENT.md").unwrap(), b"Be careful\n");
    assert!(rig.lead("PERSONA.md").is_none());
    let refused = rig.send("agent/saveLeadAgentBody", json!({ "text": "x".repeat(256 * 1024 + 1) })).await.unwrap_err();
    assert_eq!(message(&refused), "AGENT.md is larger than 256 KB");
}

#[tokio::test]
async fn the_arguments_are_judged_as_sent_a_number_is_a_persona_and_a_string_is_no_boolean() {
    let rig = rig().await;
    assert_eq!(rig.send("agent/saveLeadPersona", json!({ "text": 42 })).await.unwrap(), json!("42"));
    assert_eq!(rig.lead("PERSONA.md").unwrap(), b"42\n");
    for created in [json!("true"), json!(1), Value::Null] {
        let refused = rig.send("agent/setLeadCreated", json!({ "created": created })).await.unwrap_err();
        assert_eq!(message(&refused), "created must be a boolean");
    }
    assert!(rig.lead("agent.json").is_none());
    rig.send("agent/setLeadCreated", json!({ "created": true, "description": 7 })).await.unwrap();
    let manifest: Value = serde_json::from_slice(&rig.lead("agent.json").unwrap()).unwrap();
    assert_eq!(manifest, json!({ "created": true, "description": "7" }));
}

#[tokio::test]
async fn the_identity_keeps_a_name_up_to_64_characters_and_an_empty_name_goes_back_to_the_default() {
    let rig = rig().await;
    let status = rig.send("agent/saveLeadIdentity", json!({ "payload": { "name": "  Mixy\nPrime " } })).await.unwrap();
    assert_eq!(status["name"], "Mixy Prime");
    let refused = rig.send("agent/saveLeadIdentity", json!({ "payload": { "name": "n".repeat(65) } })).await.unwrap_err();
    assert_eq!(message(&refused), "name must be 64 characters or fewer");
    let status = rig.send("agent/saveLeadIdentity", json!({ "payload": { "name": "" } })).await.unwrap();
    assert_eq!(status["name"], "");
}

#[tokio::test]
async fn the_lead_appearance_keeps_only_a_mascot_and_null_restores_the_default() {
    let rig = rig().await;
    assert_eq!(rig.get("agent/getLeadAppearance").await, json!({ "avatar": null }));
    let mascot = json!({ "kind": "mascot", "species": "corgi", "color": "#5b9bff" });
    let set = rig.send("agent/setLeadAppearance", json!({ "avatar": mascot })).await.unwrap();
    assert_eq!(set["avatar"]["kind"], "mascot");
    assert_eq!(rig.get("agent/getLeadAppearance").await["avatar"]["species"], "corgi");
    let refused = rig.send("agent/setLeadAppearance", json!({ "avatar": { "kind": "image" } })).await.unwrap_err();
    assert_eq!(message(&refused), "usage: setLeadAppearance(a mascot appearance or null)");
    assert_eq!(rig.send("agent/setLeadAppearance", json!({ "avatar": null })).await.unwrap(), json!({ "avatar": null }));
}
