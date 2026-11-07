//! The thread settings methods that change a conversation's workflow, orchestration mode and
//! output style, and the desktop context switch: `thread/setWorkflow`,
//! `thread/setOrchestrationMode`, `thread/setOutputStyle`, `thread/switchContext`.
//!
//! Node: `setWorkflow` (`workflow-agents-api/workflow-packs.mjs`), `setOrchestrationMode` and
//! `setOutputStyle` (`workflow-agents-api/style-and-mode.mjs`) and `switchContext`
//! (`lifecycle/session-switch/context-switch.mjs`). The configured value is written here, through
//! the same config path as the `config/` methods; what the choice does to the thread's session
//! (`switchSessionWorkflow`, `switchSessionOrchestrationMode`, `settingsReachCurrentSession`, the
//! context switch itself) is [`SessionSwitches`] and [`ContextSwitch`], the session owner's.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::WorkflowConfig;
use super::ids::ORCHESTRATION_MODES;
use super::ids::truthy;
use super::ids::wanted_workflow_id;
use super::pack::load_pack;
use super::pack::workflow_summary;
use crate::config::output_style::OutputStyles;
use mixdog_app_protocol::v2::params::ThreadSetOrchestrationModeParams;
use mixdog_app_protocol::v2::params::ThreadSetOutputStyleParams;
use mixdog_app_protocol::v2::params::ThreadSetWorkflowParams;
use mixdog_app_protocol::v2::params::ThreadSwitchContextParams;

pub const SET_WORKFLOW: &str = "thread/setWorkflow";
pub const SET_ORCHESTRATION_MODE: &str = "thread/setOrchestrationMode";
pub const SET_OUTPUT_STYLE: &str = "thread/setOutputStyle";
pub const SWITCH_CONTEXT: &str = "thread/switchContext";

const DOMAIN: &str = "thread";

/// What a choice does to the thread's own session. `thread` is empty for a request naming no
/// thread (Node's runtime with no open session).
#[async_trait]
pub trait SessionSwitches: Send + Sync {
    /// `settingsReachCurrentSession()`: no session, or one without a conversation, rebuilt at
    /// its next turn.
    async fn settings_reach(&self, thread: &str) -> bool;
    /// `switchSessionWorkflow(id)`: `None` without a conversation (the configured workflow then
    /// applies), else `{ appliedToCurrentSession, [deferred], workflow, workflowSwitch }`.
    async fn switch_workflow(&self, thread: &str, workflow_id: &str) -> Result<Option<Value>, String>;
    /// `switchSessionOrchestrationMode(mode)`: `None` without a conversation, else
    /// `{ appliedToCurrentSession, [deferred], mode, orchestrationModeSwitch }`.
    async fn switch_orchestration_mode(&self, thread: &str, mode: &str) -> Result<Option<Value>, String>;
}

/// `switchContext({ cwd, desktopSession, forResume })` of the runtime: leave the open session for
/// a new desktop context. A failure is the sentence Node threw.
#[async_trait]
pub trait ContextSwitch: Send + Sync {
    async fn switch_context(&self, thread: &str, cwd: Option<String>, desktop_session: Option<Value>, for_resume: bool) -> Result<(), String>;
}

pub struct ThreadSettings {
    pub workflow: Arc<WorkflowConfig>,
    pub styles: OutputStyles,
    pub switches: Arc<dyn SessionSwitches>,
    pub context: Arc<dyn ContextSwitch>,
    pub ops: OpScopes,
}

fn thread_of(thread: &Option<mixdog_core_api::ids::ThreadId>) -> String {
    thread.as_ref().map(|t| t.as_str().to_owned()).unwrap_or_default()
}

fn session_scope(options: &Option<Value>) -> bool {
    options.as_ref().and_then(|o| o.get("scope")).and_then(Value::as_str) == Some("session")
}

impl ThreadSettings {
    async fn set_workflow(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadSetWorkflowParams = decode(req)?;
        let thread = thread_of(&params.thread_id);
        let id = wanted_workflow_id(&params.workflow_id);
        let paths = self.workflow.paths.clone();
        let wanted = id.clone();
        let pack = load_pack(&paths, &wanted).filter(|pack| pack.id == id);
        let Some(pack) = pack else {
            return Err(failed(DOMAIN, format!("workflow \"{}\" not found", params.workflow_id)));
        };
        if session_scope(&params.options)
            && let Some(Value::Object(switched)) = self.switches.switch_workflow(&thread, &id).await.map_err(|m| failed(DOMAIN, m))?
        {
            // `{ ...switched.workflow, ...switched }`
            let mut merged = match switched.get("workflow") {
                Some(Value::Object(workflow)) => workflow.clone(),
                _ => Map::new(),
            };
            merged.extend(switched);
            return Ok(Value::Object(merged));
        }
        let before = self.workflow.config.agent();
        let mut after = before.clone();
        let mut section = match after.get("workflow") {
            Some(Value::Object(section)) => section.clone(),
            _ => Map::new(),
        };
        section.insert("active".into(), json!(id));
        after.insert("workflow".into(), Value::Object(section));
        self.workflow.save(&before, &after).await?;
        // `workflowSummary(pack)`: its default `hasAgents`.
        let mut summary = workflow_summary(Some(&pack), true);
        summary.insert("appliedToCurrentSession".into(), json!(self.switches.settings_reach(&thread).await));
        Ok(Value::Object(summary))
    }

    async fn set_orchestration_mode(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadSetOrchestrationModeParams = decode(req)?;
        let thread = thread_of(&params.thread_id);
        if !ORCHESTRATION_MODES.contains(&params.mode.as_str()) {
            return Err(failed(DOMAIN, format!("orchestration mode must be one of {}", ORCHESTRATION_MODES.join(", "))));
        }
        if session_scope(&params.options)
            && let Some(switched) = self.switches.switch_orchestration_mode(&thread, &params.mode).await.map_err(|m| failed(DOMAIN, m))?
        {
            return Ok(switched);
        }
        let before = self.workflow.config.agent();
        let mut after = before.clone();
        after.insert("orchestrationMode".into(), json!(params.mode));
        self.workflow.save(&before, &after).await?;
        Ok(json!({ "mode": params.mode, "appliedToCurrentSession": self.switches.settings_reach(&thread).await }))
    }

    async fn set_output_style(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadSetOutputStyleParams = decode(req)?;
        let thread = thread_of(&params.thread_id);
        let mut status = self.styles.set(&params.value).await.map_err(|e| failed(DOMAIN, e.to_string()))?;
        status["appliedToCurrentSession"] = json!(self.switches.settings_reach(&thread).await);
        Ok(status)
    }

    async fn switch_context(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadSwitchContextParams = decode(req)?;
        let thread = thread_of(&params.thread_id);
        let input = params.input.unwrap_or(Value::Null);
        let cwd = match input.get("cwd") {
            Some(Value::String(cwd)) => Some(cwd.clone()),
            _ => None,
        };
        // `typeof desktopSession === 'object'`: an array too, `null` no.
        let desktop = input.get("desktopSession").filter(|d| d.is_object() || d.is_array()).cloned();
        let for_resume = truthy(input.get("forResume"));
        self.context.switch_context(&thread, cwd, desktop, for_resume).await.map_err(|m| failed(DOMAIN, m))?;
        Ok(Value::Bool(true))
    }
}

#[async_trait]
impl DomainService for ThreadSettings {
    fn methods(&self) -> &'static [&'static str] {
        &[SET_WORKFLOW, SET_ORCHESTRATION_MODE, SET_OUTPUT_STYLE, SWITCH_CONTEXT]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        // The results are small, so a duplicate always finds its recorded outcome.
        let stored = || async { Ok(Value::Null) };
        match req.method.as_str() {
            SET_WORKFLOW => self.ops.run(&req, None, || self.set_workflow(&req), stored).await,
            SET_ORCHESTRATION_MODE => self.ops.run(&req, None, || self.set_orchestration_mode(&req), stored).await,
            SET_OUTPUT_STYLE => self.ops.run(&req, None, || self.set_output_style(&req), stored).await,
            SWITCH_CONTEXT => self.ops.run(&req, None, || self.switch_context(&req), stored).await,
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
