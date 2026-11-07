//! [`ProjectSwitches`] over the project connector policy: the setup actions
//! `read_project_connectors` and `set_project_connector` reach the project's switches through the
//! same object the project surface uses, the set made under the remote no-widen rule.

use async_trait::async_trait;
use mixdog_core_agents::setup::ProjectSwitches;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::connectors::ProjectConnectors;

#[async_trait]
impl ProjectSwitches for ProjectConnectors {
    async fn get(&self, project_path: &str) -> Result<Value, String> {
        ProjectConnectors::get(self, project_path, &CancellationToken::new()).await
    }

    async fn set_enabled(&self, project_path: &str, connector_id: &str, enabled: &Value) -> Result<Value, String> {
        ProjectConnectors::set_enabled(self, project_path, connector_id, enabled, true, &CancellationToken::new()).await
    }
}