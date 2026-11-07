//! The `websearch` and `onboarding` domains of the setup tool's `status` (`SETUP_STATUS_READERS`
//! of `setup-tool/executor.mjs`): the workflow owner's two getters, shaped as Node prints them.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::domain_settings::DomainCalls;
use super::settings::truthy;
use super::status::StatusReader;

/// What the workflow owner answers: the web-search route and the onboarding status.
#[async_trait]
pub trait WorkflowFacts: Send + Sync {
    /// `getWebSearchRoute()`.
    fn web_search_route(&self) -> Result<Value, PortError>;
    /// `getOnboardingStatus()`.
    fn onboarding(&self) -> Result<Value, PortError>;
    /// `listWorkflows()`.
    async fn workflows(&self) -> Result<Value, PortError>;
}

pub struct WorkflowStatus {
    facts: Arc<dyn WorkflowFacts>,
    domains: Arc<dyn DomainCalls>,
}

impl WorkflowStatus {
    pub fn new(facts: Arc<dyn WorkflowFacts>, domains: Arc<dyn DomainCalls>) -> Self {
        Self { facts, domains }
    }
}

fn refused(error: CoreError) -> PortError {
    PortError::Failed { capability: "setup".into(), message: format!("{error:?}") }
}

#[async_trait]
impl StatusReader for WorkflowStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["websearch", "onboarding", "workflow"]
    }

    async fn read(&self, domain: &str, _detail: bool, _thread: &ThreadId) -> Result<Value, PortError> {
        match domain {
            "websearch" => {
                let route = self.facts.web_search_route()?;
                let route = if truthy(Some(&route)) { route } else { Value::Null };
                let tools = self.domains.call("config/getToolModuleSettings", json!({})).await.map_err(refused)?;
                let enabled = tools.get("webSearch").and_then(|search| search.get("enabled")) != Some(&Value::Bool(false));
                Ok(json!({ "route": route, "enabled": enabled }))
            }
            "onboarding" => {
                let status = self.facts.onboarding()?;
                Ok(Value::Object(if truthy(Some(&status)) { status.as_object().cloned().unwrap_or_default() } else { Map::new() }))
            }
            "workflow" => {
                let rows = self.facts.workflows().await?;
                Ok(json!({ "workflows": if truthy(Some(&rows)) { rows } else { Value::Array(Vec::new()) } }))
            }
            other => Err(PortError::Unavailable { capability: format!("setup.status.{other}"), message: format!("{other} is not a workflow status domain") }),
        }
    }
}