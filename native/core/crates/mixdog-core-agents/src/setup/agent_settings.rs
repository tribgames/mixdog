//! The agent and project-connector setup actions (Node `setup-tool/agent-settings-actions.mjs`
//! and `connector-widen-approval.mjs`): `read_agent_settings`, `read_project_connectors`,
//! `set_agent_permission`, `set_agent_connector`, `set_agent_connector_tool` and
//! `set_project_connector`. Each goes through the same methods the settings surfaces use, made as
//! a remote client's are (`noWiden`): a chat may take authority away, never give an agent more
//! without asking. The one exception is a connector tool's widening, which waits on an approval
//! card only a person answers ([`WidenCards`]).
//!
//! Node's approved change (`withApprovedConnectorToolChange`) is set around a write whose
//! widening check runs later, in the editor's write queue, after the flag is already cleared. So
//! in Node's product an approved widening is checked as a plain no-widen write and is refused with
//! the no-widen message; only an answer that turns out to be a narrowing by then is applied. The
//! golden (`fixtures/desktop/settings/agent-settings-setup-twin.json`) records exactly that, and
//! this owner does the same: it writes with the plain no-widen rule.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_ports::ports::setup_actions::{SetupActions, SetupCall};
use mixdog_mcp::permissions::Permission;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::{AuditEntry, GrantStore};
use serde_json::{Map, Value, json};

use crate::agents::{AgentConnectors, AgentPermissions, AgentsError, NO_WIDEN};

const ACTIONS: &[&str] = &[
    "read_agent_settings",
    "read_project_connectors",
    "set_agent_permission",
    "set_agent_connector",
    "set_agent_connector_tool",
    "set_project_connector",
];

/// A project's connector switches (`getProjectConnectors` / `setProjectConnectorEnabled`).
#[async_trait]
pub trait ProjectSwitches: Send + Sync {
    async fn get(&self, project_path: &str) -> Result<Value, String>;
    /// Made under the remote no-widen rule.
    async fn set_enabled(&self, project_path: &str, connector_id: &str, enabled: &Value) -> Result<Value, String>;
}

/// The card a bot's widening request raises (`requestApproval({ kind: 'connector', .. })`). The
/// implementation fills what the person's surface needs besides these fields (the request's name
/// `setup`, `remember: ['once']`, the asking session and tool call).
#[derive(Clone, Debug, PartialEq)]
pub struct WidenCard {
    pub agent: String,
    /// The connector (not one of its accounts) the card names.
    pub server: String,
    pub tool: String,
    pub from: Permission,
    /// The raw `permission` argument: `null` when none was given.
    pub requested: Value,
    /// Each level above the tool's current one the person can pick.
    pub choices: Vec<Permission>,
    /// The call's own arguments (`action`, `agent`, `name`, `tool`, `permission`).
    pub args: Value,
    pub reason: String,
}

/// The person's answer to a card.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CardAnswer {
    pub approved: bool,
    /// The level they picked.
    pub scope: Option<String>,
    pub timed_out: bool,
    /// `response`: what they pressed (`approve`, `deny`).
    pub response: Option<String>,
    pub device: Option<String>,
}

/// What came of showing a card.
#[derive(Clone, Debug, PartialEq)]
pub enum CardOutcome {
    /// The caller has no approval hook: nobody can be shown a card there.
    NoHook,
    /// The card was shown and settled; `None` is a settlement with no answer.
    Settled(Option<CardAnswer>),
}

/// Shows the card to the person (`requestApproval`).
#[async_trait]
pub trait WidenCards: Send + Sync {
    async fn ask(&self, thread: &mixdog_protocol::ThreadId, card: &WidenCard) -> CardOutcome;
}

pub struct AgentSettingsSetup {
    connectors: Arc<AgentConnectors>,
    permissions: Arc<AgentPermissions>,
    projects: Arc<dyn ProjectSwitches>,
    cards: Arc<dyn WidenCards>,
    audit: Arc<dyn GrantStore>,
}

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "setup".into(), message: message.into() }
}

fn refused(error: AgentsError) -> PortError {
    failed(error.to_string())
}

/// `requireText(value, label)`.
fn require_text(args: &Value, key: &str, label: &str) -> Result<String, PortError> {
    let text = match args.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    };
    if text.is_empty() { Err(failed(format!("{label} is required"))) } else { Ok(text) }
}

fn rank(permission: Permission) -> u8 {
    match permission {
        Permission::Disabled => 0,
        Permission::NeedsApproval => 1,
        Permission::Auto => 2,
    }
}

impl AgentSettingsSetup {
    pub fn new(
        connectors: Arc<AgentConnectors>,
        permissions: Arc<AgentPermissions>,
        projects: Arc<dyn ProjectSwitches>,
        cards: Arc<dyn WidenCards>,
        audit: Arc<dyn GrantStore>,
    ) -> Self {
        Self { connectors, permissions, projects, cards, audit }
    }

    async fn read_agent_settings(&self, args: &Value) -> Result<Value, PortError> {
        let agent = require_text(args, "agent", "agent")?;
        // Node starts the permission read first and the two connector reads throw at once, so a
        // connector failure is the one reported.
        let connectors = self.connectors.list(&agent).await.map_err(refused)?;
        let always = self.connectors.always_allowed(&agent).await.map_err(refused)?;
        let permissions = self.permissions.table(&Value::String(agent.clone())).await.map_err(refused)?;
        Ok(json!({ "agent": agent, "permissions": permissions, "connectors": connectors, "alwaysAllowedTools": always }))
    }

    /// `askToWidenConnectorTool`.
    async fn ask_to_widen(&self, call: &SetupCall<'_>, agent: &str, server: &str, tool: &str) -> Result<Value, PortError> {
        let requested = call.args.get("permission").cloned().unwrap_or(Value::Null);
        let from = self.connectors.tool_permission(agent, server, tool).await.map_err(refused)?;
        let mut receipt = Map::new();
        receipt.insert("agent".into(), agent.into());
        receipt.insert("connector".into(), server.into());
        receipt.insert("tool".into(), tool.into());
        if !requested.is_null() {
            receipt.insert("requested".into(), requested.clone());
        }
        // `${requested}` of an absent argument reads "undefined".
        let requested_text = if call.args.get("permission").is_some() { mixdog_js::value_to_string(&requested) } else { "undefined".to_owned() };
        let asked_rank = requested.as_str().and_then(Permission::parse).map(rank);
        if asked_rank.is_some_and(|asked| rank(from) >= asked) {
            receipt.insert("saved".into(), false.into());
            receipt.insert("permission".into(), from.name().into());
            receipt.insert("note".into(), format!("The tool is already {}; nothing changed.", from.name()).into());
            return Ok(Value::Object(receipt));
        }
        let group = mixdog_mcp::connectors::group_id(server);
        let choices: Vec<Permission> = [Permission::NeedsApproval, Permission::Auto].into_iter().filter(|level| rank(*level) > rank(from)).collect();
        let card = WidenCard {
            agent: agent.to_owned(),
            server: group.clone(),
            tool: tool.to_owned(),
            from,
            requested: requested.clone(),
            choices: choices.clone(),
            args: json!({ "action": "set_agent_connector_tool", "agent": agent, "name": server, "tool": tool, "permission": requested }),
            reason: format!(
                "Bot \"{agent}\" asks to change the permission of {tool} ({group}) from {} to {}.",
                from.name(),
                requested_text
            ),
        };
        // Nobody can be shown a card here: the person makes the change in the desktop app.
        let CardOutcome::Settled(answer) = self.cards.ask(call.thread, &card).await else { return Err(failed(NO_WIDEN)) };
        let level = answer
            .as_ref()
            .filter(|answer| answer.approved)
            .and_then(|answer| answer.scope.as_deref())
            .and_then(Permission::parse)
            .filter(|scope| choices.contains(scope));
        // Audited with the answering device; no grant is ever stored (no action kind).
        let decision = match &answer {
            Some(answer) if answer.timed_out => "timeout".to_owned(),
            Some(answer) => answer.response.clone().filter(|response| !response.is_empty()).unwrap_or_else(|| if answer.approved { "approve" } else { "deny" }.to_owned()),
            None => "deny".to_owned(),
        };
        let target = format!("{}>{}", from.name(), level.map_or_else(|| requested_text.clone(), |level| level.name().to_owned()));
        self.audit
            .record_audit(AuditEntry {
                agent_id: agent.to_owned(),
                kind: "connector".into(),
                tool: format!("{server}/{tool}"),
                target,
                decision,
                device: answer.as_ref().and_then(|answer| answer.device.clone()).unwrap_or_default(),
                ..AuditEntry::default()
            })
            .await
            .map_err(|error| failed(error.0))?;
        let Some(level) = level else {
            let why = if answer.as_ref().is_some_and(|answer| answer.timed_out) { "The approval card timed out" } else { "The user did not approve this change" };
            receipt.insert("saved".into(), false.into());
            receipt.insert("approved".into(), false.into());
            receipt.insert("permission".into(), from.name().into());
            receipt.insert("note".into(), format!("{why}; nothing changed.").into());
            return Ok(Value::Object(receipt));
        };
        self.connectors
            .set_tool_permission(agent, &Value::String(server.to_owned()), &Value::String(tool.to_owned()), &Value::String(level.name().to_owned()), true)
            .await
            .map_err(refused)?;
        receipt.insert("approved".into(), true.into());
        receipt.insert("permission".into(), level.name().into());
        receipt.insert("note".into(), format!("The user approved on the card; {tool} is now {}.", level.name()).into());
        Ok(Value::Object(receipt))
    }

    async fn set_agent_connector_tool(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let args = call.args;
        let agent = require_text(args, "agent", "agent")?;
        let name = require_text(args, "name", "name")?;
        let tool = require_text(args, "tool", "tool")?;
        let permission = args.get("permission").cloned().unwrap_or(Value::Null);
        match self.connectors.set_tool_permission(&agent, &Value::String(name.clone()), &Value::String(tool.clone()), &permission, true).await {
            Ok(_) => {
                let mut out = Map::new();
                out.insert("agent".into(), agent.into());
                out.insert("connector".into(), name.into());
                out.insert("tool".into(), tool.into());
                if args.get("permission").is_some() {
                    out.insert("permission".into(), permission);
                }
                Ok(Value::Object(out))
            }
            Err(AgentsError::Refused(message)) if message == NO_WIDEN => self.ask_to_widen(call, &agent, &name, &tool).await,
            Err(error) => Err(refused(error)),
        }
    }
}

#[async_trait]
impl SetupActions for AgentSettingsSetup {
    fn actions(&self) -> &'static [&'static str] {
        ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let args = call.args;
        match call.action {
            "read_agent_settings" => self.read_agent_settings(args).await,
            "read_project_connectors" => {
                let project_path = require_text(args, "projectPath", "projectPath")?;
                let connectors = self.projects.get(&project_path).await.map_err(failed)?;
                Ok(json!({ "projectPath": project_path, "connectors": connectors }))
            }
            "set_agent_permission" => {
                let agent = require_text(args, "agent", "agent")?;
                let permissions = self
                    .permissions
                    .set(&Value::String(agent.clone()), args.get("actionKind").unwrap_or(&Value::Null), args.get("permissionMode").unwrap_or(&Value::Null), true)
                    .await
                    .map_err(refused)?;
                Ok(json!({ "agent": agent, "permissions": permissions }))
            }
            "set_agent_connector" => {
                let agent = require_text(args, "agent", "agent")?;
                let name = require_text(args, "name", "name")?;
                let connectors = self
                    .connectors
                    .set_enabled(&agent, &Value::String(name), args.get("enabled").unwrap_or(&Value::Null), true)
                    .await
                    .map_err(refused)?;
                Ok(json!({ "agent": agent, "connectors": connectors }))
            }
            "set_agent_connector_tool" => self.set_agent_connector_tool(call).await,
            "set_project_connector" => {
                let project_path = require_text(args, "projectPath", "projectPath")?;
                let name = require_text(args, "name", "name")?;
                let connectors = self.projects.set_enabled(&project_path, &name, args.get("enabled").unwrap_or(&Value::Null)).await.map_err(failed)?;
                Ok(json!({ "projectPath": project_path, "connectors": connectors }))
            }
            other => Err(PortError::Unavailable { capability: format!("setup.{other}"), message: format!("setup {other} is not an agent settings action") }),
        }
    }
}

#[cfg(test)]
mod tests;
