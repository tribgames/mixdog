//! The definition setup actions of the agent kind (`create_definition`, `save_definition`,
//! `delete_definition`, `read_definition`, `restore_definition`): Node's
//! `setup-tool/extended-actions.mjs` handlers and `agent-settings-actions.mjs`
//! `restore_definition`, over the one source the loader reads, [`AgentDefinitions`]. The
//! dispatcher has already checked the caller scope and the agent-editor rule and wraps the answer
//! in the receipt. Workflow and skill definitions belong to their own owners: a call naming
//! another kind goes to [`OtherDefinitions`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SetupActions;
use super::SetupCall;
use super::SetupCallers;
use crate::agents::AgentDefinitions;
use crate::agents::AgentsError;
use crate::workflow::ids::clean;
use crate::workflow::ids::has_own;
use crate::workflow::ids::js_string;
use crate::workflow::ids::truthy;

const ACTIONS: &[&str] = &["create_definition", "save_definition", "delete_definition", "read_definition", "restore_definition"];
/// `MIXY_AGENT_ID`.
const MIXY_AGENT_ID: &str = "lead";
/// The keys of `SETUP_EXTENDED_PROPERTIES.definition`, in order: what an edit keeps of the stored
/// definition.
const DEFINITION_KEYS: [&str; 8] = ["id", "originalName", "name", "description", "body", "kind", "whenToUse", "toolDependencies"];

/// The workflow and skill kinds of the same actions.
#[async_trait]
pub trait OtherDefinitions: Send + Sync {
    /// Runs the action for a `definitionKind` other than `agent`; the message of a failure.
    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, String>;
}

pub struct DefinitionSetup {
    agents: Arc<AgentDefinitions>,
    callers: Arc<dyn SetupCallers>,
    others: Option<Arc<dyn OtherDefinitions>>,
}

impl DefinitionSetup {
    pub fn new(agents: Arc<AgentDefinitions>, callers: Arc<dyn SetupCallers>) -> Self {
        Self { agents, callers, others: None }
    }

    /// The owner of the workflow and skill kinds.
    #[must_use]
    pub fn with_others(mut self, others: Arc<dyn OtherDefinitions>) -> Self {
        self.others = Some(others);
        self
    }

    async fn read(&self, name: &str) -> Result<Value, String> {
        self.agents.get(name).await.map_err(|error| error.to_string())
    }

    /// `createdAgentKind`: the one given, else a bot when Mixy's agent-mode chat creates it.
    async fn created_kind(&self, input: &Map<String, Value>, call: &SetupCall<'_>) -> Value {
        if let Some(kind) = input.get("kind") {
            return kind.clone();
        }
        let from_mixy = self.callers.agent_mode(call.thread).await
            && self.callers.acting_agent(call.thread).await.is_ok_and(|agent| agent == MIXY_AGENT_ID);
        json!(if from_mixy { "bot" } else { "agent" })
    }

    /// `saveDefinition` for an agent.
    async fn save(&self, call: &SetupCall<'_>) -> Result<Value, String> {
        let creating = call.action == "create_definition";
        let input = call.args.get("definition").and_then(Value::as_object).cloned().unwrap_or_default();
        if let Some(unexpected) = input.keys().find(|key| !["id", "name", "description", "body", "kind"].contains(&key.as_str())) {
            return Err(format!("{unexpected} is not a agent definition field"));
        }
        let identity = [input.get("originalName"), input.get("id"), input.get("name")].into_iter().find(|v| truthy(*v)).flatten();
        if !creating && clean(identity).is_empty() {
            return Err("An existing definition identity is required".into());
        }
        let mut next = Map::new();
        let current = if creating { None } else { Some(self.read(&identity.map(js_string).unwrap_or_default()).await?) };
        if let Some(current) = &current {
            for key in DEFINITION_KEYS {
                if let Some(value) = current.get(key) {
                    next.insert(key.into(), value.clone());
                }
            }
        }
        let stored = next.clone();
        next.extend(input.clone());
        if !truthy(next.get("body")) || crate::workflow::ids::clean(next.get("body")).is_empty() {
            return Err("definition.body must not be empty".into());
        }
        if creating && truthy(input.get("id")) {
            let wanted = input.get("id").cloned().unwrap_or_default();
            let rows = self.agents.rows().await.map_err(|error| error.to_string())?;
            if rows.iter().any(|row| json!(row.id) == wanted) {
                return Err(format!("agent \"{}\" already exists", js_string(&wanted)));
            }
        }
        if creating {
            let kind = self.created_kind(&input, call).await;
            next.insert("kind".into(), kind);
            return self.agents.save(&next).await.map_err(|error| error.to_string());
        }
        // The stored kind is kept as it is; an edit naming one is refused by the editor.
        let mut edit = stored;
        edit.extend(input.clone());
        edit.shift_remove("kind");
        if has_own(&Value::Object(input.clone()), "kind") {
            edit.insert("kind".into(), input["kind"].clone());
        }
        let id = current.as_ref().and_then(|c| c.get("id")).cloned().unwrap_or_default();
        edit.insert("id".into(), id);
        self.agents.save(&edit).await.map_err(|error| error.to_string())
    }

    async fn delete(&self, call: &SetupCall<'_>) -> Result<Value, String> {
        let name = text_arg(call.args, "name");
        self.read(&name).await?;
        let mut result = self.agents.delete(&name).await.map_err(|error: AgentsError| error.to_string())?;
        result["recovery"] = json!(
            "A custom agent or bot is archived with its chat; its schedules and webhooks are paused and hidden, unchanged. The user can restore it, routines included, from Sessions → Archived, or delete it there for good, which deletes its routines too. A built-in override reverts to its built-in definition."
        );
        Ok(result)
    }

    async fn restore(&self, call: &SetupCall<'_>) -> Result<Value, String> {
        let name = clean(call.args.get("name"));
        if name.is_empty() {
            return Err("name is required".into());
        }
        self.agents.restore(&name).await.map_err(|error| error.to_string())?;
        Ok(json!({ "restored": name, "note": "Its chat is back, and its routines run again as they were." }))
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;

/// `args.<key>` as the editor receives it: the text, `undefined` when absent.
fn text_arg(args: &Value, key: &str) -> String {
    args.get(key).map_or_else(|| "undefined".into(), js_string)
}

#[async_trait]
impl SetupActions for DefinitionSetup {
    fn actions(&self) -> &'static [&'static str] {
        ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let failed = |message: String| PortError::Failed { capability: "setup".into(), message };
        let kind = call.args.get("definitionKind").and_then(Value::as_str).unwrap_or_default();
        if call.action == "restore_definition" && kind != "agent" {
            return Err(failed("Only an archived agent or bot can be restored; a deleted workflow is gone".into()));
        }
        if kind != "agent" {
            let Some(others) = &self.others else {
                return Err(failed(format!("{kind} definitions are not available here")));
            };
            return others.run(call).await.map_err(failed);
        }
        match call.action {
            "read_definition" => self.read(&text_arg(call.args, "name")).await,
            "create_definition" | "save_definition" => self.save(call).await,
            "delete_definition" => self.delete(call).await,
            _ => self.restore(call).await,
        }
        .map_err(failed)
    }
}
