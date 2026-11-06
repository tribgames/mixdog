//! `Config` as the compaction settings service's store of the `agent` section.

use async_trait::async_trait;
use mixdog_agent::compact::settings_service::AgentChange;
use mixdog_agent::compact::settings_service::AgentConfigStore;
use mixdog_core_api::CoreError;
use serde_json::Value;

use super::Config;
use super::ConfigError;
use super::service::core_error;

#[async_trait]
impl AgentConfigStore for Config {
    fn agent(&self) -> serde_json::Map<String, Value> {
        Config::agent(self)
    }

    async fn update(&self, change: AgentChange) -> Result<(), CoreError> {
        self.update_agent(move |doc| change(doc).map_err(ConfigError::Rejected))
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
