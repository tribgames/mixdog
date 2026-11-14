//! `Config` as the compaction settings service's store of the `agent` section.

use async_trait::async_trait;
use mixdog_agent::compact::settings_service::AgentChange;
use mixdog_agent::compact::settings_service::AgentConfigStore;
use mixdog_core_api::CoreError;
use serde_json::Value;

use super::Config;
use super::ConfigError;
use super::patch;
use super::service::core_error;

#[async_trait]
impl AgentConfigStore for Config {
    fn agent(&self) -> serde_json::Map<String, Value> {
        Config::agent(self)
    }

    /// `saveConfigAndAdopt`'s write, inside the transaction: what `change` made of the section is stored as the difference of
    /// the two stored forms (`createConfigPatch`), so a section's defaults are never written.
    async fn update(&self, change: AgentChange) -> Result<(), CoreError> {
        self.update_agent(move |agent| {
            let mut after = agent.clone();
            change(&mut after).map_err(ConfigError::Rejected)?;
            // The runtime holds the grandfathered config (`adoptConfig`, as `settings::save_and_adopt` reads it), so the seed is the
            // stored section's builtins as `withGrandfatheredBuiltins` reads them, written only where the file lacks them.
            let changes = patch::create_config_patch(agent, &after);
            *agent = patch::apply_config_patch(agent, &patch::with_seeds(&crate::tool_modules::with_grandfathered_builtins(agent), changes));
            Ok(())
        })
        .await
        .map(|_| ())
        .map_err(core_error)
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "tests seed and read the config file on the test thread")]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use mixdog_core_api::mock::MockStatePublisher;

    use super::*;
    use crate::config::ConfigLanes;

    async fn open(dir: &tempfile::TempDir) -> (Config, std::path::PathBuf) {
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, br#"{"agent":{"worktree":{"a":1},"autoClear":{"x":1}},"other":true}"#).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) =
            Config::open(path.clone(), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        (config, path)
    }

    #[tokio::test]
    async fn an_update_changes_the_agent_section_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let (config, path) = open(&dir).await;
        let change: AgentChange = Box::new(|agent| {
            agent.insert("autoClear".into(), json!({ "y": 2 }));
            Ok(())
        });
        AgentConfigStore::update(&config, change).await.unwrap();
        let agent = AgentConfigStore::agent(&config);
        assert_eq!(agent["autoClear"], json!({ "y": 2 }));
        assert_eq!(agent["worktree"], json!({ "a": 1 }));
        let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["other"], json!(true));
        // `seedChanges`: the first write seeds the install markers the stored section lacks (a fresh profile's empty set).
        assert_eq!(stored["agent"]["builtins"], json!({}));
    }

    /// Node's stored form (`storedAgentForm`): a whole normalized `autoClear` keeps only what differs from its defaults, and
    /// one equal to them leaves no key.
    #[tokio::test]
    async fn an_update_stores_only_what_differs_from_the_section_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let (config, path) = open(&dir).await;
        let stored = || serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["agent"].clone();
        for (enabled, want) in [(false, Some(json!({ "enabled": false }))), (true, None)] {
            let change: AgentChange = Box::new(move |agent| {
                let section = json!({ "enabled": enabled, "idleMs": null, "custom": false, "providerIdleMs": {}, "minContextPercent": 10 });
                agent.insert("autoClear".into(), section);
                Ok(())
            });
            AgentConfigStore::update(&config, change).await.unwrap();
            assert_eq!(stored().get("autoClear").cloned(), want, "enabled {enabled}");
            assert_eq!(stored()["worktree"], json!({ "a": 1 }));
        }
    }

    #[tokio::test]
    async fn a_rejected_change_writes_nothing_and_keeps_its_error() {
        let dir = tempfile::tempdir().unwrap();
        let (config, path) = open(&dir).await;
        let before = std::fs::read(&path).unwrap();
        let change: AgentChange = Box::new(|agent| {
            agent.insert("autoClear".into(), json!({ "y": 2 }));
            Err(CoreError::InvalidParams { path: "params.input".into(), expected: "a positive number".into() })
        });
        let error = AgentConfigStore::update(&config, change).await.unwrap_err();
        assert!(matches!(
            error,
            CoreError::InvalidParams { ref path, ref expected }
                if &**path == "params.input" && &**expected == "a positive number"
        ));
        assert_eq!(AgentConfigStore::agent(&config)["autoClear"], json!({ "x": 1 }));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
