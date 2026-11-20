//! The tools a delegated agent's session sees differently from the Lead (Node `bindAgentOwner`,
//! `tools/builtin/builtin-tools.mjs`): `git` without the worktree operations only the Lead host runs,
//! and `task` with the agent's wait default. Every other tool is itself.
//!
//! The tools carry their agent definition ([`Tool::agent_spec`]: the embedded `git.agent.json` and
//! `task.agent.json`), and the turns an agent runs are sent it through `ToolSet::spec_of`. This is the
//! header side: the definitions an agent-owned thread holds in its `tools` and catalogs.

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_core_api::domain::tool::Tool;
use serde_json::Value;

/// The pool's `git` or `task` has no agent definition (`Tool::agent_spec`): a delegated agent's session
/// would be sent the Lead's text, so the pool is refused instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariantError {
    pub tool: &'static str,
}

impl std::fmt::Display for VariantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the {} tool has no definition for delegated agents (Tool::agent_spec)", self.tool)
    }
}

impl std::error::Error for VariantError {}

impl From<VariantError> for String {
    fn from(error: VariantError) -> Self {
        error.to_string()
    }
}

/// The tools Node's `bindAgentOwner` rebuilds for an agent.
const AGENT_VARIANT_TOOLS: [&str; 2] = ["git", "task"];

/// Every `git` and `task` of the pool has its agent definition: checked when a pool is taken, so a
/// tool that lost it fails the composition, not a delegated agent's turn. A pool without them passes.
pub fn check_pool(pool: &[Arc<dyn Tool>]) -> Result<(), VariantError> {
    for tool in pool {
        if let Some(name) = AGENT_VARIANT_TOOLS.iter().find(|name| tool.spec().name == **name)
            && tool.agent_spec().is_none()
        {
            return Err(VariantError { tool: name });
        }
    }
    Ok(())
}

/// The agent definition of every pool tool that has one, by tool name.
pub fn agent_definitions(pool: &[Arc<dyn Tool>]) -> HashMap<String, Value> {
    pool.iter().filter_map(|tool| tool.agent_spec().map(|agent| (tool.spec().name.clone(), agent.definition()))).collect()
}

/// `bindAgentOwner` over definitions: a tool with an agent definition is that one, any other is itself.
pub fn bind_agent_docs(docs: Vec<Value>, agent: &HashMap<String, Value>) -> Vec<Value> {
    docs.into_iter().map(|doc| doc.get("name").and_then(Value::as_str).and_then(|name| agent.get(name)).cloned().unwrap_or(doc)).collect()
}

#[cfg(test)]
mod tests {}
