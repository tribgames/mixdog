//! The production [`WorkflowSurface`]: the four prompt-side answers of a mid-conversation
//! workflow or orchestration-mode switch, over the pieces of this module.
//!
//! - `target` = `activeWorkflowContext(configForSession(config, id, mode), dir)` with
//!   `leadPartsFor(session, leadPromptParts)`;
//! - `live_denied_tools` = `liveDeniedTools(session, summary)` over the live feature gates;
//! - `internal_tools` =`modelStandaloneTools()` as the session's workflow gates it;
//! - `orchestration_instructions` = `orchestrationInstructions(mode)`.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_config::config::Config;
use mixdog_core_config::tool_modules::with_grandfathered_builtins;
use mixdog_core_config::workflow::WorkflowPaths;
use mixdog_core_config::workflow::ids::active_workflow_id;
use mixdog_core_config::workflow::ids::configured_orchestration_mode;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_session::session::session_options::header_profile_allowlist;
use mixdog_core_session::session::session_options::header_tool_profile;
use mixdog_core_session::session::session_options::model_tool_allowlist;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_core_session::session::thread_switches::WorkflowSurface;
use mixdog_core_session::session::thread_switches::WorkflowTarget;
use mixdog_rt::InteractiveIo;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::catalog::LeadPrompt;
use super::context::WorkflowPacks;
use super::denials::FeatureProbes;
use super::denials::feature_disallowed_tools;
use super::denials::live_denied_tools;
use super::instructions::OrchestrationTexts;
use crate::run_host::tool_pool::model_surface::SurfaceInputs;
use crate::run_host::tool_pool::model_surface::model_internal_tools;

/// `MIXDOG_FEATURE_*` lookups; the process environment in production.
pub type FeatureEnv = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What the surface is built from.
pub struct SurfaceParts {
    /// The lane the pack, mode-text and Mixy-name reads run on.
    pub lane: InteractiveIo,
    /// The install root (shipped `workflows/`, `orchestration/`) and the data dir (the user's).
    pub paths: WorkflowPaths,
    /// The live config (`getConfig()`).
    pub config: Config,
    /// The one agent catalog of the daemon.
    pub agents: Arc<AgentDefinitions>,
    /// Desktop bridges and git on PATH.
    pub probes: Arc<dyn FeatureProbes>,
    pub env: FeatureEnv,
    /// The runtime's tool profile (`rt.toolProfile`).
    pub tool_profile: ToolProfile,
    /// The runtime's standalone tools (`standaloneTools`), in their order.
    pub standalone: Vec<Arc<dyn Tool>>,
    /// The names of the delegation tools (`agentToolNames`).
    pub agent_tools: Vec<String>,
}

pub struct RunWorkflowSurface {
    packs: WorkflowPacks,
    lead: LeadPrompt,
    texts: OrchestrationTexts,
    agents: Arc<AgentDefinitions>,
    config: Config,
    probes: Arc<dyn FeatureProbes>,
    env: FeatureEnv,
    tool_profile: ToolProfile,
    standalone: Vec<Arc<dyn Tool>>,
    agent_tools: HashSet<String>,
}

impl RunWorkflowSurface {
    pub fn new(parts: SurfaceParts) -> Self {
        let texts = OrchestrationTexts::new(parts.lane, parts.paths.root.clone(), parts.paths.data.clone());
        Self {
            packs: WorkflowPacks::new(parts.lane, parts.paths.clone()),
            lead: LeadPrompt::new(parts.agents.clone(), texts.clone(), parts.lane, parts.paths.data.clone()),
            texts,
            agents: parts.agents,
            config: parts.config,
            probes: parts.probes,
            env: parts.env,
            tool_profile: parts.tool_profile,
            standalone: parts.standalone,
            agent_tools: parts.agent_tools.into_iter().collect(),
        }
    }

    /// `configForSession(config, workflowId, mode)`; without a mode, `configForWorkflow`.
    fn config_for(&self, workflow_id: &str, mode: Option<&str>) -> Map<String, Value> {
        let mut doc = self.config.agent();
        if !workflow_id.is_empty() {
            let mut section = doc.get("workflow").and_then(Value::as_object).cloned().unwrap_or_default();
            section.insert("active".into(), json!(workflow_id));
            doc.insert("workflow".into(), Value::Object(section));
        }
        if let Some(mode) = mode {
            doc.insert("orchestrationMode".into(), json!(mode));
        }
        doc
    }

    /// `delegatableAgentIds(config, dir)`: a scan that cannot run is a typed failure.
    async fn delegatable(&self) -> Result<usize, SurfaceFailure> {
        self.agents
            .delegatable_agent_ids()
            .await
            .map(|ids| ids.len())
            .map_err(|error| SurfaceFailure(format!("the delegatable agents could not be listed: {error}")))
    }

    /// `getFeatureDisallowedTools()`: the gates over the config as the runtime holds it (builtins
    /// stamped) and the machine as it is now, under the profile of `session` when it was started under
    /// a narrowed one (Node runs a headless or heartbeat session in a runtime of that profile; the
    /// daemon's runtime is interactive).
    pub async fn feature_denied(&self, session: Option<&Header>) -> Result<Vec<String>, SurfaceFailure> {
        let facts = self.probes.read().await?;
        let config = with_grandfathered_builtins(&self.config.agent());
        let profile = session.and_then(header_tool_profile).unwrap_or(self.tool_profile);
        Ok(feature_disallowed_tools(&config, &facts, &*self.env, profile))
    }

    /// `modelStandaloneTools()` for `session` with `features` as the denied gates.
    pub async fn gated_tools(&self, session: &Header, features: &[String]) -> Result<Vec<Arc<dyn Tool>>, SurfaceFailure> {
        // The agent count is read only while no session exists (`workflowAllowsAgents`); the
        // header of a switch always carries its id.
        let identified = ["id", "workflow", "orchestrationMode"].iter().any(|key| truthy(session.get(*key)));
        let delegatable = if identified { 0 } else { self.delegatable().await? };
        let agent_tools: HashSet<&str> = self.agent_tools.iter().map(String::as_str).collect();
        // A thread's own profile is the one it was started under (the daemon's runtime is interactive).
        let inputs = SurfaceInputs {
            session: Some(session),
            profile_allowed: header_profile_allowlist(session).or_else(|| model_tool_allowlist(self.tool_profile)),
            feature_denied: features,
            delegatable_agents: &|| delegatable,
        };
        Ok(model_internal_tools(&self.standalone, &agent_tools, &inputs))
    }
}

#[async_trait]
impl WorkflowSurface for RunWorkflowSurface {
    async fn target(&self, session: &Header, workflow_id: &str, mode: Option<&str>) -> Result<WorkflowTarget, SurfaceFailure> {
        let doc = self.config_for(workflow_id, mode);
        let orchestration_mode = configured_orchestration_mode(&doc);
        let active = self.packs.active(&active_workflow_id(&doc), self.delegatable().await? > 0).await?;
        let parts = self.lead.lead_parts_for(&orchestration_mode, session).await?;
        Ok(WorkflowTarget {
            summary: active.summary,
            orchestration_mode,
            pack_context: active.pack_context,
            orchestration_context: parts.orchestration_context,
            agent_catalog_context: parts.agent_catalog_context,
            contact_catalog_context: parts.contact_catalog_context,
        })
    }

    async fn live_denied_tools(&self, session: &Header, summary: &Value) -> Result<Vec<String>, SurfaceFailure> {
        live_denied_tools(session, summary, &self.feature_denied(Some(session)).await?)
    }

    async fn internal_tools(&self, session: &Header) -> Result<Vec<Value>, SurfaceFailure> {
        let features = self.feature_denied(Some(session)).await?;
        Ok(self.gated_tools(session, &features).await?.iter().map(|tool| tool.spec().definition()).collect())
    }

    async fn orchestration_instructions(&self, mode: &str) -> Result<String, SurfaceFailure> {
        self.texts.orchestration_instructions(mode).await
    }
}
