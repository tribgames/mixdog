//! The definition setup actions of the agent kind (`create_definition`, `save_definition`,
//! `delete_definition`, `read_definition`, `restore_definition`): Node's
//! `setup-tool/extended-actions.mjs` handlers and `agent-settings-actions.mjs`
//! `restore_definition`, over the one source the loader reads, [`AgentDefinitions`]. The
//! dispatcher has already checked the caller scope and the agent-editor rule and wraps the answer
//! in the receipt. The workflow and skill kinds of the same actions run over their services
//! (`config/*WorkflowPack`, `skills/*`), so one implementation serves all three.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::DomainService;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_core_ports::ports::setup_actions::SetupCallers;
use crate::agents::AgentDefinitions;
use crate::agents::AgentsError;
use mixdog_core_config::workflow::ids::clean;
use mixdog_core_config::workflow::ids::has_own;
use mixdog_core_config::workflow::ids::js_string;
use mixdog_core_config::workflow::ids::truthy;

const ACTIONS: &[&str] = &["create_definition", "save_definition", "delete_definition", "read_definition", "restore_definition"];
/// `MIXY_AGENT_ID`.
const MIXY_AGENT_ID: &str = "lead";
/// The keys of `SETUP_EXTENDED_PROPERTIES.definition`, in order: what an edit keeps of the stored
/// definition.
const DEFINITION_KEYS: [&str; 8] = ["id", "originalName", "name", "description", "body", "kind", "whenToUse", "toolDependencies"];

/// The message of a failed call, as Node's `Error.message`.
fn message_of(error: CoreError) -> String {
    match error {
        CoreError::DomainError { message: Some(message), .. } => message.to_string(),
        other => other.to_string(),
    }
}

/// `rt.<method>(..)` over a service: its answer, or the message of its failure.
async fn service_call(service: &dyn DomainService, method: &'static str, params: Value) -> Result<Value, String> {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("setup") };
    match service.call(request).await.map_err(message_of)? {
        Reply::Value(value) => Ok(value),
        _ => Err(format!("{method} did not answer a value")),
    }
}

/// The three kinds of definition one set of actions edits: agents (this crate's
/// [`AgentDefinitions`]), workflow packs (the workflow service) and skills (the skills service).
pub struct DefinitionSetup {
    agents: Arc<AgentDefinitions>,
    callers: Arc<dyn SetupCallers>,
    workflow: Arc<dyn DomainService>,
    skills: Arc<dyn DomainService>,
}

impl DefinitionSetup {
    pub fn new(
        agents: Arc<AgentDefinitions>,
        callers: Arc<dyn SetupCallers>,
        workflow: Arc<dyn DomainService>,
        skills: Arc<dyn DomainService>,
    ) -> Self {
        Self { agents, callers, workflow, skills }
    }

    /// `readDefinition(rt, kind, name)`.
    async fn read_kind(&self, kind: &str, name: &str) -> Result<Value, String> {
        match kind {
            "workflow" => service_call(self.workflow.as_ref(), "config/getWorkflowPack", json!({ "workflowId": name })).await,
            "agent" => self.read(name).await,
            _ => {
                // skillContent already returns the SKILL.md body without frontmatter; the
                // frontmatter fields come from the catalog row.
                let resource = service_call(self.skills.as_ref(), "skills/skillContent", json!({ "name": name })).await?;
                let status = service_call(self.skills.as_ref(), "skills/skillsStatus", json!({})).await?;
                let row = status["skills"].as_array().and_then(|rows| rows.iter().find(|row| row["name"] == name)).cloned().unwrap_or(json!({}));
                let text = |key: &str| row.get(key).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!(""));
                Ok(json!({
                    "name": name,
                    "originalName": name,
                    "description": text("description"),
                    "whenToUse": text("whenToUse"),
                    "body": resource["content"],
                    "toolDependencies": row.get("toolDependencies").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!([])),
                    "editable": row["editable"] == true,
                }))
            }
        }
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

    /// `saveDefinition(rt, args, context)`.
    async fn save(&self, kind: &str, call: &SetupCall<'_>) -> Result<Value, String> {
        let creating = call.action == "create_definition";
        let input = call.args.get("definition").and_then(Value::as_object).cloned().unwrap_or_default();
        let allowed: &[&str] = match kind {
            "skill" => &["originalName", "name", "description", "body", "whenToUse", "toolDependencies"],
            "agent" => &["id", "name", "description", "body", "kind"],
            _ => &["id", "name", "description", "body"],
        };
        if let Some(unexpected) = input.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(format!("{unexpected} is not a {kind} definition field"));
        }
        let identity = [input.get("originalName"), input.get("id"), input.get("name")].into_iter().find(|v| truthy(*v)).flatten();
        if !creating && clean(identity).is_empty() {
            return Err("An existing definition identity is required".into());
        }
        let mut next = Map::new();
        let current = if creating { None } else { Some(self.read_kind(kind, &identity.map(js_string).unwrap_or_default()).await?) };
        if kind == "skill" && !creating && current.as_ref().is_some_and(|c| c["editable"] != true) {
            // Built-in and plugin skills keep their document; like the Skills editor, only their
            // tool dependencies are user-editable (null restores them).
            let current = current.unwrap_or_default();
            let edits: Vec<&String> = input.keys().filter(|key| *key != "originalName" && *key != "name").collect();
            let renamed = input.contains_key("name") && input["name"] != current["name"];
            if edits.len() != 1 || edits[0].as_str() != "toolDependencies" || renamed {
                return Err("Built-in and plugin skills accept only toolDependencies edits".into());
            }
            let params = json!({ "input": {
                "originalName": current["originalName"],
                "dependenciesOnly": true,
                "toolDependencies": input["toolDependencies"],
            } });
            return service_call(self.skills.as_ref(), "skills/saveSkill", params).await;
        }
        if let Some(current) = &current {
            for key in DEFINITION_KEYS {
                if let Some(value) = current.get(key) {
                    next.insert(key.into(), value.clone());
                }
            }
        }
        let stored = next.clone();
        next.extend(input.clone());
        if !truthy(next.get("body")) || mixdog_core_config::workflow::ids::clean(next.get("body")).is_empty() {
            return Err("definition.body must not be empty".into());
        }
        if kind == "workflow" {
            let (method, payload) = if creating {
                ("config/createWorkflow", Value::Object(next))
            } else {
                let mut payload = next;
                payload.insert("id".into(), current.as_ref().map(|c| c["id"].clone()).unwrap_or_default());
                ("config/saveWorkflowPack", Value::Object(payload))
            };
            return service_call(self.workflow.as_ref(), method, json!({ "payload": payload })).await;
        }
        if kind == "skill" {
            return if creating {
                service_call(self.skills.as_ref(), "skills/addSkill", json!({ "input": next })).await
            } else {
                next.insert("originalName".into(), current.as_ref().map(|c| c["originalName"].clone()).unwrap_or_default());
                service_call(self.skills.as_ref(), "skills/saveSkill", json!({ "input": next })).await
            };
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

    async fn delete(&self, kind: &str, call: &SetupCall<'_>) -> Result<Value, String> {
        if kind == "skill" {
            return Err("Skill deletion is not supported; use set_disabled_skills".into());
        }
        let name = text_arg(call.args, "name");
        self.read_kind(kind, &name).await?;
        let (mut result, recovery) = if kind == "workflow" {
            (
                service_call(self.workflow.as_ref(), "config/deleteWorkflow", json!({ "workflowId": name })).await?,
                "User-authored definition files are deleted. A built-in override may revert to its built-in definition.",
            )
        } else {
            (
                self.agents.delete(&name).await.map_err(|error: AgentsError| error.to_string())?,
                "A custom agent or bot is archived with its chat; its schedules and webhooks are paused and hidden, unchanged. The user can restore it, routines included, from Sessions → Archived, or delete it there for good, which deletes its routines too. A built-in override reverts to its built-in definition.",
            )
        };
        result["recovery"] = json!(recovery);
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
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod kinds;

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
        // The editor reads the name as `String(value ?? '')`: only an absent or null name is no id;
        // a number, boolean, array or object is its JavaScript text.
        if kind == "agent" && matches!(call.action, "read_definition" | "delete_definition") && call.args.get("name").is_none_or(Value::is_null) {
            return Err(failed(format!("unknown agent \"{}\"", text_arg(call.args, "name"))));
        }
        match call.action {
            "read_definition" => self.read_kind(kind, &text_arg(call.args, "name")).await,
            "create_definition" | "save_definition" => self.save(kind, call).await,
            "delete_definition" => self.delete(kind, call).await,
            _ => self.restore(call).await,
        }
        .map_err(failed)
    }
}
