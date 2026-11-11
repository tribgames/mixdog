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
        if let Some(name) = AGENT_VARIANT_TOOLS.iter().find(|name| tool.spec().name == **name) {
            if tool.agent_spec().is_none() {
                return Err(VariantError { tool: name });
            }
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
mod tests {
    use async_trait::async_trait;
    use mixdog_core_api::domain::tool::ToolAnnotations;
    use mixdog_core_api::domain::tool::ToolContext;
    use mixdog_core_api::domain::tool::ToolOutcome;
    use mixdog_core_api::domain::tool::ToolOutput;
    use mixdog_core_api::domain::tool::ToolSpec;

    use super::*;

    /// A tool with the Lead's definition and, where Node's `bindAgentOwner` rebuilds it, the agent's.
    struct Stub {
        lead: ToolSpec,
        agent: Option<ToolSpec>,
    }

    #[async_trait]
    impl Tool for Stub {
        fn spec(&self) -> &ToolSpec {
            &self.lead
        }
        fn agent_spec(&self) -> Option<&ToolSpec> {
            self.agent.as_ref()
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput::default())
        }
    }

    fn spec(view: &Value) -> ToolSpec {
        ToolSpec {
            name: view["name"].as_str().expect("name").into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: view["description"].as_str().unwrap_or_default().into(),
            input_schema: view["inputSchema"].clone(),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }
    }

    fn golden() -> Value {
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent-tool-variants/golden.json")).expect("golden")
    }

    /// Node's `bindAgentOwner` over every built-in tool (`fixtures/agent-tool-variants`): the pool's
    /// agent definitions are exactly the tools Node rebuilds, and binding the Lead's definitions gives
    /// the agent text (description and schema, key order included); the others are themselves.
    #[test]
    fn the_agent_definitions_bind_as_nodes_bind_agent_owner_does() {
        let golden = golden();
        let cases = golden["tools"].as_array().expect("tools");
        let pool: Vec<Arc<dyn Tool>> = cases
            .iter()
            .map(|case| Arc::new(Stub { lead: spec(&case["lead"]), agent: (!case["same"].as_bool().expect("same")).then(|| spec(&case["agent"])) }) as Arc<dyn Tool>)
            .collect();
        let agent = agent_definitions(&pool);
        let mut rebuilt: Vec<&str> = agent.keys().map(String::as_str).collect();
        rebuilt.sort_unstable();
        assert_eq!(rebuilt, ["git", "task"], "only git and task are rebuilt");
        let leads: Vec<Value> = pool.iter().map(|tool| tool.spec().definition()).collect();
        let bound = bind_agent_docs(leads, &agent);
        for (case, doc) in cases.iter().zip(&bound) {
            let name = case["lead"]["name"].as_str().expect("name");
            assert_eq!(doc["name"], name);
            assert_eq!(doc["description"], case["agent"]["description"], "{name}: description");
            assert_eq!(doc["inputSchema"].to_string(), case["agent"]["inputSchema"].to_string(), "{name}: schema");
        }
    }

    /// A pool whose `git` or `task` has no agent definition is refused with the tool named; a pool
    /// that has both, or neither, passes.
    #[test]
    fn a_pool_whose_git_or_task_lost_its_agent_definition_is_refused() {
        let golden = golden();
        let build = |without: &str| -> Vec<Arc<dyn Tool>> {
            golden["tools"]
                .as_array()
                .expect("tools")
                .iter()
                .map(|case| {
                    let name = case["lead"]["name"].as_str().expect("name");
                    let agent = (!case["same"].as_bool().expect("same") && name != without).then(|| spec(&case["agent"]));
                    Arc::new(Stub { lead: spec(&case["lead"]), agent }) as Arc<dyn Tool>
                })
                .collect()
        };
        assert_eq!(check_pool(&build("")), Ok(()));
        assert_eq!(check_pool(&[]), Ok(()));
        assert_eq!(check_pool(&build("git")), Err(VariantError { tool: "git" }));
        assert_eq!(check_pool(&build("task")), Err(VariantError { tool: "task" }));
        assert_eq!(check_pool(&build("task")).unwrap_err().to_string(), "the task tool has no definition for delegated agents (Tool::agent_spec)");
    }
}