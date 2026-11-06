//! `CallerFacts` over the session layer: the facts about the thread a tool call belongs to,
//! read where Node reads them.
//!
//! - heartbeat: `isHeartbeatSession(sessionId)` (`shared/routine-trigger.mjs:97`), the in-process
//!   mark on the thread, never a stored field.
//! - unattended: `scheduleCallerScope(session).unattended === true`
//!   (`session-runtime/services/schedule-access.mjs:55`), which [`ThreadCallers::scope`] ports.
//! - user available: whether the call carries an approval hook (`callerCtx.toolApprovalHook`,
//!   `ask-user-tool.mjs:243`), which a session with no approval surface does not.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::session_options::approval_implicit;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::ports::CallerFacts;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::RunKind;
use serde_json::Value;

use crate::run_host::compaction_world::is_agent_owner;
use crate::run_host::mcp_seams::UnattendedRuns;
use crate::run_host::settings::HeartbeatMarks;

/// `sourceType` values of a session a person drives (`INTERACTIVE_SOURCE_TYPES`).
const INTERACTIVE_SOURCE_TYPES: [&str; 3] = ["", "lead", "cli"];

pub struct ThreadCallers {
    threads: Arc<dyn ThreadState>,
    marks: Arc<dyn HeartbeatMarks>,
    runs: Arc<dyn UnattendedRuns>,
}

/// `text(value)`'s truthiness of a record field: JS-truthy.
fn set(header: &Header, key: &str) -> bool {
    truthy(header.get(key))
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).unwrap_or("")
}

impl ThreadCallers {
    pub fn new(threads: Arc<dyn ThreadState>, marks: Arc<dyn HeartbeatMarks>, runs: Arc<dyn UnattendedRuns>) -> Self {
        Self { threads, marks, runs }
    }

    /// The thread's record; `None` for a thread that does not exist.
    pub async fn header(&self, thread: &ThreadId) -> Result<Option<Header>, PortError> {
        match self.threads.header(thread).await {
            Ok(header) => Ok(Some(header)),
            Err(PortError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// `provenanceScope(session, id)`: the scope by the session's id and record alone.
    fn provenance(&self, header: &Header, id: &str) -> CallerScope {
        if room_member_of_session(id).is_some() {
            return CallerScope::RoomMember;
        }
        if let Some(home) = agent_id_of_home_session(id) {
            return if home == MIXY_AGENT_ID { CallerScope::Human } else { CallerScope::Agent { agent_id: home, unattended: false } };
        }
        // Mixy's hidden heartbeat session: her own scope, as her chat's routine turns get.
        if self.marks.is_heartbeat(id) {
            return CallerScope::Agent { agent_id: MIXY_AGENT_ID.to_owned(), unattended: false };
        }
        let source = if set(header, "sourceType") { mixdog_js::value_to_string(&header["sourceType"]).to_lowercase() } else { String::new() };
        let headless = id.is_empty()
            || is_agent_owner(header)
            || set(header, "parentSessionId")
            || (set(header, "ownerSessionId") && text(header, "ownerSessionId") != id)
            || !INTERACTIVE_SOURCE_TYPES.contains(&source.as_str());
        if headless { CallerScope::Headless } else { CallerScope::Human }
    }

    /// `scheduleCallerScope(session)`: `Human`, an agent's, a room member's or `Headless`; an
    /// unattended run only ever narrows it. A thread with no record is a background run.
    pub async fn scope(&self, thread: &ThreadId) -> CallerScope {
        // A record that cannot be read is a background run, as a caller that cannot be resolved.
        let Ok(Some(header)) = self.header(thread).await else {
            return CallerScope::Headless;
        };
        let scope = self.provenance(&header, thread.as_str());
        let Some(run) = self.runs.run_of(thread).await else {
            return scope;
        };
        if matches!(scope, CallerScope::Headless | CallerScope::RoomMember) {
            return scope;
        }
        if run.kind == RunKind::Room {
            return CallerScope::RoomMember;
        }
        match &scope {
            CallerScope::Agent { agent_id, .. } if *agent_id != run.agent_id => CallerScope::Headless,
            _ if run.agent_id.is_empty() => CallerScope::Headless,
            _ => CallerScope::Agent { agent_id: run.agent_id, unattended: true },
        }
    }
}

#[async_trait]
impl CallerFacts for ThreadCallers {
    async fn is_heartbeat(&self, thread: &ThreadId) -> bool {
        self.marks.is_heartbeat(thread.as_str())
    }

    async fn is_unattended(&self, thread: &ThreadId) -> bool {
        matches!(self.scope(thread).await, CallerScope::Agent { unattended: true, .. })
    }

    /// The turn carries an approval hook unless the session has no approval surface
    /// (`approvalMode: "implicit"`: Node's headless runtime has no `toolApprovalHook`).
    async fn user_available(&self, thread: &ThreadId) -> bool {
        matches!(self.header(thread).await, Ok(Some(header)) if !approval_implicit(&header))
    }
}
