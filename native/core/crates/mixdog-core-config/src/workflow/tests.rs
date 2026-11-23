//! The workflow sections push the values of the actions and only what changed, over the real `Config` and the real op scopes, with
//! no pack on disk.

#![allow(clippy::disallowed_methods, reason = "test setup: seeds config files on the test thread")]

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::WorkflowConfig;
use super::WorkflowHost;
use super::WorkflowPaths;
use super::ids::Doc;
use crate::config::Config;
use crate::config::ConfigLanes;
use mixdog_core_base::support::testing::scopes;

struct Host {
    main: Mutex<Value>,
    custom_agents: Vec<String>,
    capable: bool,
    adopted: Mutex<Vec<Value>>,
}

#[async_trait]
impl WorkflowHost for Host {
    fn main_route(&self) -> Value {
        self.main.lock().unwrap().clone()
    }
    async fn adopt_lead_route(&self, selection: Value) {
        // The session resolves the selection into the live route (`modelParameters` included).
        let mut route = selection.clone();
        route.as_object_mut().unwrap().entry("modelParameters").or_insert(json!({}));
        *self.main.lock().unwrap() = route;
        self.adopted.lock().unwrap().push(selection);
    }
    async fn custom_agent_ids(&self) -> Vec<String> {
        self.custom_agents.clone()
    }
    fn provider_available(&self, _provider: &str) -> bool {
        true
    }
    fn agent_provider(&self, provider: &str) -> bool {
        provider == "acp-antigravity"
    }
    fn require_local_provider_management(&self) -> Result<(), String> {
        Ok(())
    }
    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn after_credential_change(&self) {}
    async fn ensure_providers_ready(&self, _providers: Doc) -> Result<(), String> {
        Ok(())
    }
    async fn lookup_model_meta(&self, _provider: &str, _model: &str) -> Option<Value> {
        None
    }
    fn web_search_capable(&self, _provider: &str, _meta: Option<&Value>) -> bool {
        self.capable
    }
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        false
    }
    fn web_search_route_saved(&self, _route: &Value) {}
}

fn doc(value: Value) -> Doc {
    value.as_object().unwrap().clone()
}

fn host() -> Host {
    Host { main: Mutex::new(json!({})), custom_agents: Vec::new(), capable: false, adopted: Mutex::default() }
}

#[test]
fn a_completion_stores_the_lead_route_and_the_agent_routes_it_was_sent() {
    let before = doc(json!({ "agents": { "maintainer": { "provider": "openai", "model": "old" }, "explore": { "provider": "openai", "model": "keep" } } }));
    let payload = json!({
        "workflowRoutes": { "lead": { "provider": "openai", "model": "gpt-5" }, "agent": { "provider": "openai", "model": "w" }, "memory": null },
        "agentRoutes": { "explore": null, "unlisted": { "provider": "openai", "model": "x" } },
    });
    let done = super::onboarding::completed(&before, &payload, &json!({}), &[], "2026-01-01T00:00:00Z").unwrap();
    assert_eq!(done.lead.as_ref().unwrap()["model"], "gpt-5");
    assert_eq!(done.after["default"], "workflow-lead");
    let presets = done.after["presets"].as_array().unwrap();
    assert_eq!(presets.len(), 1);
    assert_eq!(presets[0]["id"], "workflow-lead");
    let agents = done.after["agents"].as_object().unwrap();
    assert_eq!(agents.keys().collect::<Vec<_>>(), ["worker"], "memory and explore were cleared, an unlisted agent was ignored");
    assert_eq!(agents["worker"]["model"], "w");
    assert_eq!(done.after["onboarding"]["completed"], true);
    assert_eq!(done.after["onboarding"]["completedAt"], "2026-01-01T00:00:00Z");
}

#[test]
fn a_completion_adopts_a_sent_default_route_and_a_custom_agent_may_be_routed() {
    let payload = json!({ "defaultRoute": { "provider": "openai", "model": "gpt-5" }, "agentRoutes": { "mine": { "provider": "openai", "model": "m" } } });
    let done = super::onboarding::completed(&Doc::new(), &payload, &json!({}), &["mine".to_owned()], "now").unwrap();
    assert_eq!(done.lead.as_ref().unwrap()["model"], "gpt-5");
    assert_eq!(done.after["default"], "workflow-lead");
    assert_eq!(done.after["agents"]["mine"]["model"], "m");
    assert!(super::onboarding::completed(&Doc::new(), &Value::Null, &json!({}), &[], "now").is_err());
}

#[test]
fn model_preferences_are_stored_per_model_and_a_custom_provider_keeps_its_visibility_in_its_overrides() {
    let host = host();
    let plain = doc(json!({ "modelSettings": { "openai/gone": { "favorite": true } } }));
    let changes = json!([{ "model": "a", "hidden": true, "favorite": true }, { "model": "gone", "favorite": false }]);
    let saved = super::prefs::prepare(&plain, &json!("openai"), &changes, &host).unwrap();
    assert_eq!(saved.after["modelSettings"], json!({ "openai/a": { "hidden": true, "favorite": true } }));
    assert_eq!(saved.result, json!({ "provider": "openai", "changed": 2, "customCatalogChanged": false }));
    assert!(!saved.custom_catalog_changed);

    let id = "custom-12345678-1234-1234-1234-123456789abc";
    let custom = doc(json!({ "providers": { id: { "type": "custom", "name": "P" } } }));
    let changes = json!([{ "model": "m", "hidden": true, "favorite": true }]);
    let saved = super::prefs::prepare(&custom, &json!(id), &changes, &host).unwrap();
    assert_eq!(saved.after["modelSettings"], json!({ format!("{id}/m"): { "favorite": true } }));
    assert_eq!(saved.after["providers"][id]["modelOverrides"], json!({ "m": { "hidden": true } }));
    assert_eq!((saved.after["providers"][id]["type"].clone(), saved.after["providers"][id]["enabled"].clone()), (json!("custom"), json!(true)));
    assert!(saved.custom_catalog_changed);
    assert!(super::prefs::prepare(&plain, &json!("nope"), &json!([]), &host).is_err());

    // An outside agent's models keep their marks as a provider's do, though the provider config holds no entry of it.
    let changes = json!([{ "model": "gemini-3.8-flash", "favorite": true }, { "model": "gpt-oss-120b-medium", "hidden": true }]);
    let saved = super::prefs::prepare(&plain, &json!("acp-antigravity"), &changes, &host).unwrap();
    assert_eq!(saved.after["modelSettings"]["acp-antigravity/gemini-3.8-flash"], json!({ "favorite": true }));
    assert_eq!(saved.after["modelSettings"]["acp-antigravity/gpt-oss-120b-medium"], json!({ "hidden": true }));
    assert_eq!(saved.after.get("providers"), None);
}

/// The pushed sections hold what the session actions return (`listPresets`, `getWebSearchRoute`, `listWorkflows`,
/// `getOnboardingStatus`), and a pass pushes only the one whose value changed.
#[tokio::test]
async fn the_sections_push_the_values_of_the_actions_and_only_what_changed() {
    use mixdog_core_api::state::SectionChange;
    use mixdog_protocol::SectionName;

    let dir = tempfile::tempdir().unwrap();
    let (root, data) = (dir.path().join("root"), dir.path().join("data"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("cfg").join("mixdog-config.json");
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    std::fs::write(&config_path, serde_json::to_vec(&crate::config::agent_routes::stored_file_of(&json!({}))).unwrap()).unwrap();
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let host = Arc::new(Host { main: Mutex::new(json!({})), custom_agents: Vec::new(), capable: false, adopted: Mutex::default() });
    let service = WorkflowConfig::new(config.clone(), WorkflowPaths { root, data }, host, scopes(dir.path(), "config").await, &tokens);
    let publisher = MockStatePublisher::default();
    let mut last = [None, None, None, None];

    super::sections::push_changed(&service, &publisher, &mut last).await;
    let first = publisher.published();
    let sections: Vec<(SectionName, Option<String>)> = first.iter().map(|(section, key, _)| (*section, key.clone())).collect();
    assert_eq!(
        sections,
        [(SectionName::Presets, None), (SectionName::WebSearch, None), (SectionName::Workflows, None), (SectionName::Config, Some("onboarding".to_owned())),]
    );
    let pushed = |change: &SectionChange| match change {
        SectionChange::Set(bytes) => serde_json::from_slice::<Value>(bytes).unwrap(),
        other => panic!("{other:?}"),
    };
    assert_eq!(pushed(&first[0].2), service.list_presets());
    assert_eq!(pushed(&first[1].2), service.web_search_route().unwrap());
    assert_eq!(pushed(&first[2].2), service.list_workflows().await.unwrap());
    assert_eq!(pushed(&first[3].2), service.onboarding_status().await.unwrap());
    assert!(pushed(&first[3].2).get("workflowRoutes").is_some(), "the status carries the route summary");

    super::sections::push_changed(&service, &publisher, &mut last).await;
    assert_eq!(publisher.published().len(), 4, "nothing changed, nothing is pushed");

    config
        .update_agent(|doc| {
            doc.insert("presets".into(), json!([{ "id": "mine", "provider": "openai", "model": "gpt-5" }]));
            Ok(())
        })
        .await
        .unwrap();
    super::sections::push_changed(&service, &publisher, &mut last).await;
    let after = publisher.published();
    assert!(after.len() > 4 && after[4].0 == SectionName::Presets, "a changed config pushes the presets again");
    assert!(pushed(&after[4].2).as_array().unwrap().iter().any(|preset| preset["id"] == "mine"));
}
