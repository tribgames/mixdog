//! `Config` as the network-proxy service's store: `networkProxy` and `providers` of the `agent`
//! section.

use async_trait::async_trait;
use mixdog_ai::service::network_proxy::NetworkProxyStore;
use serde_json::Value;

use super::Config;

#[async_trait]
impl NetworkProxyStore for Config {
    fn network_proxy(&self) -> Value {
        self.agent().get("networkProxy").cloned().unwrap_or(Value::Null)
    }

    fn providers(&self) -> Value {
        self.agent().get("providers").cloned().unwrap_or(Value::Null)
    }

    /// One `update_agent` transaction, which resolves once the file is written.
    async fn save_network_proxy(&self, value: Value) -> Result<(), String> {
        self.update_agent(move |doc| {
            doc.insert("networkProxy".into(), value);
            Ok(())
        })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_core_api::mock::MockStatePublisher;
    use serde_json::json;

    use super::*;
    use crate::config::ConfigLanes;

    #[tokio::test]
    async fn a_save_stores_the_proxy_and_keeps_the_rest_of_the_agent_section() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixdog-config.json");
        std::fs::write(&path, br#"{"agent":{"providers":{"openai":{"x":1}},"worktree":{"a":1}}}"#).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) =
            Config::open(path.clone(), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        assert_eq!(NetworkProxyStore::network_proxy(&config), Value::Null);
        config.save_network_proxy(json!({ "mode": "off" })).await.unwrap();
        assert_eq!(NetworkProxyStore::network_proxy(&config), json!({ "mode": "off" }));
        assert_eq!(NetworkProxyStore::providers(&config), json!({ "openai": { "x": 1 } }));
        let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["agent"]["networkProxy"], json!({ "mode": "off" }));
        assert_eq!(stored["agent"]["worktree"], json!({ "a": 1 }));
    }
}
