//! An agent's permission table and the audit of its Browser Use approvals: Node's
//! `human-gate/store.mjs` `agentPermissions`, `setAgentPermission` and `recordAgentApprovalAudit`
//! over the grants file and audit log (`mixdog_tools::policy::FileGrantStore`).

use std::sync::Arc;

use mixdog_core_api::domain::approval::ActionKind;
use mixdog_tools::policy::AuditEntry;
use mixdog_tools::policy::FileGrantStore;
use mixdog_tools::policy::GrantKey;
use mixdog_tools::policy::GrantStore as _;
use mixdog_tools::policy::PermissionMode;
use mixdog_tools::policy::action::kind_name;
use mixdog_tools::policy::action::parse_kind;
use mixdog_tools::policy::grants::ANY_AGENT;
use mixdog_tools::policy::grants::DEV_ALLOW_ALL_DECISION;
use mixdog_tools::policy::grants::NO_WIDEN_MESSAGE;
use mixdog_tools::policy::grants::SESSION_GRANTED_DECISION;
use mixdog_tools::policy::grants::SESSION_REMEMBERED_DECISION;
use serde_json::Value;
use serde_json::json;

use super::AgentsError;

/// `BROWSER_AUDIT_DECISIONS`, in Node's order.
const AUDIT_DECISIONS: [&str; 9] = [
    "approve",
    "deny",
    "granted",
    "remembered",
    SESSION_GRANTED_DECISION,
    SESSION_REMEMBERED_DECISION,
    "run-allowed",
    "blocked",
    DEV_ALLOW_ALL_DECISION,
];

/// The length an agent id may have (`FIELD_LIMIT`).
const FIELD_LIMIT: usize = 200;

/// `PERMISSION_MODES`.
const MODES: [PermissionMode; 3] = [PermissionMode::Ask, PermissionMode::Allow, PermissionMode::Block];

fn refused(message: impl Into<String>) -> AgentsError {
    AgentsError::Refused(message.into())
}

/// `ACTION_KINDS.join(', ')`.
fn kinds() -> String {
    ActionKind::ALL.iter().map(|kind| kind_name(*kind)).collect::<Vec<_>>().join(", ")
}

/// `requiredAgentId`: a non-blank string of at most 200 characters, and not the every-agent key.
fn required_agent_id(value: &Value) -> Result<&str, AgentsError> {
    match value.as_str() {
        Some(id) if !mixdog_js::js_trim(id).is_empty() && mixdog_js::utf16_len(id) <= FIELD_LIMIT && id != ANY_AGENT => Ok(id),
        _ => Err(refused("agent id is invalid")),
    }
}

pub struct AgentPermissions {
    store: Arc<FileGrantStore>,
}

impl AgentPermissions {
    pub fn new(store: Arc<FileGrantStore>) -> Self {
        Self { store }
    }

    /// `agentPermissions`: every action kind with the agent's mode, then one shared row per tool
    /// allowed for every agent.
    pub async fn table(&self, agent_id: &Value) -> Result<Value, AgentsError> {
        self.rows(required_agent_id(agent_id)?).await
    }

    async fn rows(&self, agent: &str) -> Result<Value, AgentsError> {
        let rows = self.store.permissions(agent).await.map_err(|error| refused(error.0))?;
        Ok(Value::Array(
            rows.into_iter()
                .map(|row| {
                    let mut out = json!({ "action": row.action.render(), "mode": row.mode.as_str(), "rememberable": row.rememberable });
                    if row.shared {
                        out["shared"] = json!(true);
                    }
                    out
                })
                .collect(),
        ))
    }

    /// `setAgentPermission`: one row of that table; answers the table. With `no_widen` (a remote
    /// client's call) a change that would lift a block or add an allow is refused.
    pub async fn set(&self, agent_id: &Value, action: &Value, mode: &Value, no_widen: bool) -> Result<Value, AgentsError> {
        let agent = required_agent_id(agent_id)?;
        let key = action.as_str().and_then(GrantKey::parse).ok_or_else(|| refused(format!("action must be one of {}", kinds())))?;
        let mode = mode
            .as_str()
            .and_then(PermissionMode::parse)
            .ok_or_else(|| refused(format!("mode must be one of {}", MODES.map(PermissionMode::as_str).join(", "))))?;
        let name = key.render();
        if mode == PermissionMode::Allow && !key.rememberable() {
            return Err(refused(format!("{name} always asks; it cannot be allowed")));
        }
        // A tool is allowed from its approval card only; here it can only be turned back to asking.
        if key.is_tool() && mode != PermissionMode::Ask {
            return Err(refused(format!("{name} can only be set back to ask")));
        }
        match self.store.set_mode(agent, &key, mode, "", no_widen).await.map_err(|error| refused(error.0))? {
            Ok(_) => self.rows(agent).await,
            Err(_) => Err(refused(NO_WIDEN_MESSAGE)),
        }
    }

    /// `recordAgentApprovalAudit`: audits one Browser Use approval of a bot: the bot, the action
    /// kind and what happened. Never a page address, target or value.
    pub async fn record_audit(&self, agent_id: &Value, action: &Value, decision: &Value) -> Result<Value, AgentsError> {
        let agent = required_agent_id(agent_id)?;
        let kind = action.as_str().filter(|name| parse_kind(name).is_some()).ok_or_else(|| refused(format!("action must be one of {}", kinds())))?;
        let decision = decision
            .as_str()
            .filter(|name| AUDIT_DECISIONS.contains(name))
            .ok_or_else(|| refused(format!("decision must be one of {}", AUDIT_DECISIONS.join(", "))))?;
        let entry = AuditEntry {
            agent_id: agent.to_owned(),
            kind: "browser".into(),
            action: kind.to_owned(),
            tool: "browser".into(),
            decision: decision.to_owned(),
            ..AuditEntry::default()
        };
        self.store.record_audit(entry.limited()).await.map_err(|error| refused(error.0))?;
        Ok(Value::Null)
    }
}
