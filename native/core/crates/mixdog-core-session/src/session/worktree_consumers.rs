//! Node's `storedWorkspaceConsumers` (`worktrees/maintenance.mjs`): the stored sessions a
//! destructive folder action must consider, read from the same store the session-search
//! backfill reads ([`StoredSearchSessions`]: one listing, one header read; no second scan).
//!
//! Every stored session is read; one whose record cannot be read refuses the whole listing
//! ("Cannot inspect session <id>; no workspace was removed.") so an unreadable store never reads
//! as "no consumers". A closed session (`closed === true`) is not a consumer. `active` is
//! `isSessionActive` of a stored session no live runtime speaks for: its `status` in
//! `ACTIVE_STAGES` (`activity-guards.mjs`), compared lower-cased.

use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_base::support::FsFailure;
use mixdog_core_base::support::FsStep;
use mixdog_core_base::support::io_failure;
use mixdog_scm::error::ScmFailure;
use mixdog_store::schema::record::Header;

use crate::session::search_backfill::StoredSearchSessions;
use super::worktree_host::LiveSession;
use super::worktree_state::plain;

const ACTIVE_STAGES: [&str; 6] = ["connecting", "requesting", "streaming", "tool_running", "running", "cancelling"];

/// The stored-consumers listing over the thread store.
pub struct StoredConsumers {
    stored: Arc<StoredSearchSessions>,
}

impl StoredConsumers {
    pub fn new(stored: Arc<StoredSearchSessions>) -> Self {
        Self { stored }
    }

    pub async fn list(&self) -> Result<Vec<LiveSession>, ScmFailure> {
        let ids = self.stored.listed().await.map_err(|error| listing_failure(error, self.stored.sessions_dir()))?;
        let mut consumers = Vec::new();
        for id in ids {
            let Some(header) = self.stored.header(&id).await else {
                return Err(plain(format!("Cannot inspect session {id}; no workspace was removed.")));
            };
            if header.get("closed").and_then(serde_json::Value::as_bool) == Some(true) {
                continue;
            }
            consumers.push(consumer(id, &header));
        }
        Ok(consumers)
    }
}

/// readdir of the store folder failed: Node's own text (<CODE>: <description>, scandir '<dir>').
pub(super) fn listing_failure(error: std::io::Error, dir: &std::path::Path) -> ScmFailure {
    match io_failure("session", &FsFailure { error, step: FsStep::Scandir(dir.to_owned()) }) {
        CoreError::DomainError { message: Some(message), .. } => plain(message.to_string()),
        other => unreachable!("io_failure answers a domain error with a message: {other:?}"),
    }
}

fn consumer(id: String, header: &Header) -> LiveSession {
    let text = |key: &str| header.get(key).and_then(serde_json::Value::as_str);
    LiveSession {
        id,
        cwd: text("cwd").filter(|cwd| !cwd.is_empty()).map(str::to_owned),
        active: text("status").is_some_and(|status| ACTIVE_STAGES.contains(&status.to_lowercase().as_str())),
        closed: false,
        owner_session_id: text("ownerSessionId").map(str::to_owned),
        parent_session_id: text("parentSessionId").map(str::to_owned),
    }
}

#[cfg(test)]
#[path = "worktree_consumers_tests.rs"]
mod tests;