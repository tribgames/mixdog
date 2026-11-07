//! `provider_setup` against Node's `providerSetup` (fixtures/provider-setup/golden.json), and the
//! keychain hints the recording host cannot produce.

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use serde_json::Value;

use super::custom_admin::CustomFacts;
use super::provider_setup::KeychainStatus;
use super::provider_setup::SetupOptions;
use super::provider_setup::SetupWorld;
use super::provider_setup::UnsafeStore;
use super::provider_setup::provider_setup;

/// The world as the recorder read it from Node's own modules.
struct Recorded {
    world: Value,
    env: Value,
    local: Value,
    probes: AtomicUsize,
}

fn listed(list: &Value, id: &str) -> bool {
    list.as_array().is_some_and(|items| items.iter().any(|item| item == id))
}

fn id_of(account: &str) -> &str {
    account.strip_prefix("agent.").and_then(|rest| rest.strip_suffix(".apiKey")).unwrap_or_default()
}

impl CustomFacts for Recorded {
    fn env(&self, name: &str) -> Option<String> {
        self.env[name].as_str().map(str::to_owned)
    }
    fn has_stored_secret(&self, account: &str) -> bool {
        listed(&self.world["stored"], id_of(account))
    }
    fn is_fallback_secret(&self, account: &str) -> bool {
        listed(&self.world["fallback"], id_of(account))
    }
    /// The provider recordings hold no custom providers.
    fn custom_key_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
}

impl SetupWorld for Recorded {
    fn resolved_env_name(&self, id: &str) -> Option<String> {
        self.world["resolvedEnv"][id].as_str().map(str::to_owned)
    }
    fn has_agent_api_key(&self, id: &str) -> bool {
        listed(&self.world["keyPresent"], id)
    }
    fn keychain_status(&self) -> KeychainStatus {
        let status = &self.world["keychain"];
        KeychainStatus {
            state: status["state"].as_str().unwrap_or_default().to_owned(),
            fallback: status["fallback"] == true,
            unsafe_store: status.get("unsafeStore").filter(|v| v.is_object()).map(|store| UnsafeStore {
                kind: store["kind"].as_str().unwrap_or_default().to_owned(),
                path: store["path"].as_str().unwrap_or_default().to_owned(),
            }),
        }
    }
    fn oauth_available(&self, id: &str) -> bool {
        listed(&self.world["oauthAvailable"], id)
    }
    fn oauth_describe(&self, id: &str) -> Value {
        self.world["oauthDescribe"][id].clone()
    }
    fn vertex_adc(&self, _project_id: Option<&str>) -> Option<Value> {
        Some(self.world["vertexAdc"].clone()).filter(|adc| !adc.is_null())
    }
    fn probe_vertex_metadata(&self) {
        self.probes.fetch_add(1, Ordering::SeqCst);
    }
    fn vertex_env_location(&self) -> Option<String> {
        self.world["vertexEnvLocation"].as_str().map(str::to_owned)
    }
    fn vertex_key_project(&self) -> Option<String> {
        self.world["vertexKeyProject"].as_str().map(str::to_owned)
    }
    fn local_status(&self) -> Option<Value> {
        // `"throws"` is the status function throwing; no recorded status is the real probe of a
        // host with no local runtime, which reads as an absent runtime.
        Some(self.local.clone()).filter(Value::is_object)
    }
}

#[test]
fn the_rows_equal_nodes_for_every_recorded_scenario() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/provider-setup/golden.json")).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 30);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let world = Recorded {
            world: scenario["world"].clone(),
            env: scenario["env"].clone(),
            local: scenario["local"].clone(),
            probes: AtomicUsize::new(0),
        };
        let options = SetupOptions {
            check_secrets: scenario["options"]["checkSecrets"] != false,
            detect_local: scenario["options"]["detectLocal"] != false,
        };
        let built = provider_setup(&world, &scenario["config"], options);
        // The rows are agent- and UI-visible JSON: key order is part of the contract.
        assert_eq!(serde_json::to_string(&built).unwrap(), serde_json::to_string(&scenario["result"]).unwrap(), "{name}");
    }
}
