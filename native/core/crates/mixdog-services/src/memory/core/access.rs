//! Who may read and write which core-memory pool. Pools: common memory
//! (project and agent NULL), a project's, and an agent's own (agent set,
//! project NULL).
//!
//! The caller arrives as `memory_caller` `{kind, agentId}`, resolved by the
//! session runtime from the calling session; the model never supplies it. A
//! call without one is the host acting for the user.
//!   - common/project memory: every caller reads it; only a conversation with
//!     the user (the host, a human session, an agent's home thread) changes it;
//!   - an agent's memory: that agent alone reads and writes it; the host and
//!     human sessions may also list and delete it.

use mixdog_js::{js_trim};
use serde_json::Value;

use crate::memory::error::{MemoryError, Result};

const MAX_AGENT_ID_LENGTH: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerKind {
    Host,
    Human,
    Agent,
    RoomMember,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryCaller {
    pub kind: CallerKind,
    pub agent_id: String,
    pub interactive: bool,
}

/// A normalized agent id: `[a-z0-9][a-z0-9.-]*`, at most 200 characters.
pub fn valid_agent_id(value: &str) -> Option<&str> {
    let id = js_trim(value);
    let mut chars = id.chars();
    let first = chars.next()?;
    let lead_ok = first.is_ascii_lowercase() || first.is_ascii_digit();
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    (lead_ok && rest_ok && id.len() <= MAX_AGENT_ID_LENGTH).then_some(id)
}

impl MemoryCaller {
    pub fn host() -> Self {
        Self { kind: CallerKind::Host, agent_id: String::new(), interactive: true }
    }

    /// The caller of a `memory_caller` value; an unrecognised one is an
    /// unattended run without an agent (fail closed).
    pub fn from_value(value: Option<&Value>) -> Self {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Self::host();
        };
        let kind = match value.get("kind").and_then(Value::as_str) {
            Some("host") => return Self::host(),
            Some("human") => CallerKind::Human,
            Some("agent") => CallerKind::Agent,
            Some("room-member") => CallerKind::RoomMember,
            _ => CallerKind::Headless,
        };
        let agent_id = value
            .get("agentId")
            .and_then(Value::as_str)
            .and_then(valid_agent_id)
            .unwrap_or_default()
            .to_owned();
        if kind == CallerKind::Agent && agent_id.is_empty() {
            return Self { kind: CallerKind::Headless, agent_id, interactive: false };
        }
        let interactive = matches!(kind, CallerKind::Human | CallerKind::Agent);
        Self { kind, agent_id, interactive }
    }

    fn may_manage_agents(&self) -> bool {
        matches!(self.kind, CallerKind::Host | CallerKind::Human)
    }

    /// Errors unless the caller may read agent `agent_id`'s pool (none: common/project).
    pub fn assert_read(&self, agent_id: Option<&str>) -> Result<()> {
        match agent_id {
            Some(id) if self.agent_id != id && !self.may_manage_agents() => Err(MemoryError::rejected(format!(
                "the memory of agent \"{id}\" is readable only by that agent"
            ))),
            _ => Ok(()),
        }
    }

    /// Errors unless the caller may `op` ("add" | "edit" | "delete") an entry of `pool`.
    pub fn assert_write(&self, op: &str, pool: &Pool<'_>) -> Result<()> {
        if let Some(agent_id) = pool.agent_id {
            if self.agent_id == agent_id || (op == "delete" && self.may_manage_agents()) {
                return Ok(());
            }
            return Err(MemoryError::rejected(format!(
                "memory {op} refused: the memory of agent \"{agent_id}\" is written only by that agent"
            )));
        }
        if self.interactive {
            return Ok(());
        }
        let which = match pool.project_id {
            Some(project) if !project.is_empty() => format!("project memory \"{project}\""),
            _ => "common memory".to_owned(),
        };
        Err(MemoryError::rejected(format!(
            "memory {op} refused: {which} changes only in a conversation with the user; an unattended run writes only its own agent memory (agent_id \"self\")"
        )))
    }
}

/// A core-memory pool: a project (None = common), or one agent's own.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pool<'a> {
    pub project_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
}

impl Pool<'_> {
    pub fn label(&self) -> String {
        match self.agent_id {
            Some(agent) => format!("agent={agent}"),
            None => format!("project={}", self.project_id.unwrap_or("COMMON")),
        }
    }
}
