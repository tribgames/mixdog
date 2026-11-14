//! [`SessionSource`] over the stored sessions: what the worktree maintenance reads of the session
//! layer (Node `worktrees/maintenance.mjs`: `storedSessionIds`, `storedFavoriteSessionIds`,
//! `storedArchivedSessionIds`, `storedSessionActivity`, `runningShellJobs`).
//!
//! - The ids are the store folder's listing, the session folders not carrying the delete mark
//!   (a closed session's record stays listed). A folder that cannot be listed is Node's own
//!   readdir text, never "no sessions".
//! - Favorites and archives are the desktop's marks, which are the session's own header here
//!   (`favoriteAt`, `archivedAt`, positive when set: [`sidebar_flag`]); the core always hosts
//!   them, so they are never "unknown". A session whose record cannot be read carries none.
//! - Activity is `subAgentActivityAt` of the header (`0` reads as none) and its `title || name`;
//!   an absent or unreadable session is left out.
//! - The running jobs are the background shells this process's task registry holds; a running
//!   shell without a folder refuses the listing as Node's strict reader does. Node's
//!   `runningShellJobs` reads the job records instead (`listShellJobRecords`, the non-terminal
//!   ones), so it also counts a record another live process keeps running, and one a gone
//!   runtime left running until the start-up pass ends it. This reads neither: a gone runtime's
//!   record ends as failed at the next start (`ExecRuntime::reconcile_lost_jobs`, a pass beside
//!   the start, not before it).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::maintenance::SessionActivity;
use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_scm::worktree::maintenance::ShellJob;
use mixdog_spawn::tasks::TaskRegistry;
use mixdog_spawn::tasks::TaskRow;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::worktree_consumers::listing_failure;
use super::worktree_state::plain;
use crate::session::delete::sidebar_flag;
use crate::session::search_backfill::StoredSearchSessions;
use crate::session::sub_agent_retention::activity_at;

/// The worktree maintenance's view of the stored sessions and the running shells.
pub struct StoredWorktreeSessions {
    stored: Arc<StoredSearchSessions>,
    tasks: Arc<TaskRegistry>,
}

impl StoredWorktreeSessions {
    /// Over the store view the search backfill and [`StoredConsumers`](super::StoredConsumers)
    /// already share (one listing, one header read) and the shell runtime's task registry
    /// (`ShellControl::tasks()`).
    pub fn new(stored: Arc<StoredSearchSessions>, tasks: Arc<TaskRegistry>) -> Self {
        Self { stored, tasks }
    }

    async fn marked(&self, key: &str) -> Result<HashSet<String>, ScmFailure> {
        let mut marked = HashSet::new();
        for id in self.stored_session_ids().await? {
            if self.stored.header(&id).await.is_some_and(|header| sidebar_flag(&header, key)) {
                marked.insert(id);
            }
        }
        Ok(marked)
    }
}

/// `doc.title || doc.name || null`.
fn title_of(header: &Header) -> Option<String> {
    ["title", "name"]
        .iter()
        .filter_map(|key| header.get(*key).and_then(Value::as_str))
        .find(|text| !text.is_empty())
        .map(str::to_owned)
}

#[async_trait]
impl SessionSource for StoredWorktreeSessions {
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure> {
        let listed = self.stored.listed().await.map_err(|error| listing_failure(error, self.stored.sessions_dir()))?;
        Ok(listed.into_iter().collect())
    }

    async fn favorites(&self) -> Option<HashSet<String>> {
        self.marked("favoriteAt").await.ok()
    }

    async fn archived(&self) -> Option<HashSet<String>> {
        self.marked("archivedAt").await.ok()
    }

    async fn activity(&self, ids: &[String]) -> HashMap<String, SessionActivity> {
        let mut out = HashMap::new();
        for id in ids.iter().collect::<HashSet<_>>() {
            if let Some(header) = self.stored.header(id).await {
                let at = activity_at(&header);
                out.insert(id.clone(), SessionActivity { last_active_at: (at > 0.0).then_some(at as i64), title: title_of(&header) });
            }
        }
        out
    }

    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure> {
        // Every one, not the desktop strip's newest 60 (`host_state`): Node's records are all of them.
        self.tasks
            .list()
            .into_iter()
            .filter(TaskRow::reserves_folder)
            .map(|job| {
                if job.cwd.is_empty() {
                    return Err(plain(format!("Cannot inspect shell job {}.", job.task_id)));
                }
                Ok(ShellJob { cwd: Some(job.cwd), owner_session_id: job.owner })
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "worktree_sessions_tests.rs"]
mod tests;
