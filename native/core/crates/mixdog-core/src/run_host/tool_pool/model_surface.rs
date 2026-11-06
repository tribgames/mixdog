//! The standalone tools the model is offered (`session-runtime/tool-surface.mjs`
//! `modelStandaloneTools` and `workflowAllowsAgents`): the profile's allowlist, the `agent` tool
//! hidden where the workflow does not delegate, the Lead-only control tools withheld from a
//! delegated worker, and the tools a setting switched off.

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_core_api::domain::tool::Tool;
use mixdog_store::agent_mode::session_mode_of;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::surface::AGENT_DENIED_TOOLS;
use serde_json::Value;

use mixdog_core_config::workflow::ids::truthy;

/// What the surface reads of the running runtime and its session.
pub struct SurfaceInputs<'a> {
    /// The live session's record; `None` before the first session exists.
    pub session: Option<&'a Header>,
    /// The model tools the runtime's profile allows (`modelToolSchemaAllowlist`); `None` for the
    /// interactive profile.
    pub profile_allowed: Option<&'a [&'a str]>,
    /// The tools a setting switches off (`getFeatureDisallowedTools`).
    pub feature_denied: &'a [String],
    /// The delegatable agents the config names, read only while no session exists.
    pub delegatable_agents: &'a dyn Fn() -> usize,
}

/// `workflowDisallowsAgentTool(workflow, { agentMode })`.
fn workflow_disallows_agent_tool(workflow: &Value, agent_mode: bool) -> bool {
    if !workflow.is_object() {
        return false;
    }
    if agent_mode && workflow.get("delegatesAgents") == Some(&Value::Bool(false)) {
        return true;
    }
    workflow.get("agentsConfigured") == Some(&Value::Bool(true)) && workflow.get("agents").and_then(Value::as_array).is_some_and(Vec::is_empty)
}

/// `promptWorkflowOf(session)`: the workflow its prompt was built with.
fn prompt_workflow(session: &Header) -> Option<&Value> {
    session
        .get("workflowOverlay")
        .and_then(|overlay| overlay.get("prompt"))
        .filter(|prompt| truthy(Some(prompt)))
        .or_else(|| session.get("workflow").filter(|workflow| truthy(Some(workflow))))
}

/// `workflowAllowsAgents()`.
pub fn workflow_allows_agents(inputs: &SurfaceInputs<'_>) -> bool {
    let empty = Header::new();
    let session = inputs.session.unwrap_or(&empty);
    let agent_mode = session_mode_of(session) == "agent";
    if truthy(session.get("id")) || truthy(session.get("workflow")) || truthy(session.get("orchestrationMode")) {
        return !prompt_workflow(session).is_some_and(|workflow| workflow_disallows_agent_tool(workflow, agent_mode));
    }
    !agent_mode || (inputs.delegatable_agents)() > 0
}

/// `modelStandaloneTools()`: `standalone` in its order, `agent_tools` the names of the delegation
/// tools.
pub fn model_standalone_tools(standalone: &[Arc<dyn Tool>], agent_tools: &HashSet<&str>, inputs: &SurfaceInputs<'_>) -> Vec<Arc<dyn Tool>> {
    let name = |tool: &Arc<dyn Tool>| tool.spec().name.clone();
    let agent_owned = inputs
        .session
        .is_some_and(|s| s.get("owner").and_then(Value::as_str) == Some("agent") || s.get("visibility").and_then(Value::as_str) == Some("agent-only"));
    let hide_agent_tool = agent_owned || !workflow_allows_agents(inputs);
    let allowed_by_profile = |tool: &Arc<dyn Tool>| {
        inputs.profile_allowed.is_none_or(|allowed| {
            let key = mixdog_js::js_trim(&name(tool)).to_lowercase();
            allowed.iter().any(|a| a.to_lowercase() == key)
        })
    };
    let denied: HashSet<&str> = inputs.feature_denied.iter().map(String::as_str).collect();
    standalone
        .iter()
        .filter(|tool| allowed_by_profile(tool))
        .filter(|tool| !hide_agent_tool || !agent_tools.contains(name(tool).as_str()))
        .filter(|tool| !agent_owned || !AGENT_DENIED_TOOLS.contains(&name(tool).to_lowercase().as_str()))
        .filter(|tool| !denied.contains(name(tool).as_str()))
        .cloned()
        .collect()
}
