//! The managed-worktree list (Node `manager.mjs` `listManagedWorktrees` and `maintenance.mjs`
//! `listWorktreesWithRetention`): every registry record with who keeps it, and for the
//! Settings → Worktrees list its dirty/unmerged counts, folder size, owner title, archive flag,
//! last activity and the reason the automatic cleanup would take it.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::repo::on_lane;
use crate::worktree::maintenance::CleanupReason;
use crate::worktree::maintenance::CleanupRow;
use crate::worktree::maintenance::SelectOptions;
use crate::worktree::maintenance::SessionSource;
use crate::worktree::maintenance::ShellJob;
use crate::worktree::maintenance::row_activity;
use crate::worktree::maintenance::select_worktree_cleanup;
use crate::worktree::maintenance::within;
use crate::worktree::manager::Worktrees;
use crate::worktree::manager::entry_json;
use crate::worktree::manager::is_snapshot;

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn owners_of(row: &Value) -> Vec<String> {
    let shared = row.get("sharedSessionIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
    text(row, "ownerSessionId").into_iter().chain(shared.map(str::to_owned)).filter(|id| !id.is_empty()).collect()
}

/// The policy's view of a listed row; a count that could not be read is work to keep.
fn cleanup_row(row: &Value) -> CleanupRow {
    let count = |key: &str| match row.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(u64::MAX),
        Some(Value::Null) => u64::MAX,
        _ => 0,
    };
    CleanupRow {
        id: text(row, "id").unwrap_or_default(),
        repo_common_dir: text(row, "repoCommonDir").unwrap_or_default(),
        is_snapshot: row.get("kind").and_then(Value::as_str) == Some("snapshot"),
        state: text(row, "state").unwrap_or_default(),
        dirty: count("dirty"),
        unmerged: count("unmerged"),
        owner_live: row.get("ownerLive") == Some(&Value::Bool(true)),
        in_use: false,
        owner_session_id: text(row, "ownerSessionId"),
        shared_session_ids: row
            .get("sharedSessionIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        created_at: row.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
    }
}

/// What the count/age limits are chosen over: the listed rows, who is live and what runs.
struct Listed<'a> {
    rows: &'a [Value],
    jobs: &'a [ShellJob],
    activity: &'a HashMap<String, i64>,
    now: i64,
}

impl Worktrees {
    /// Every managed worktree with who keeps it: `retained` (its session is in `retained`),
    /// `ownerLive`, and `removable`. `inspect` adds, for a ready branch worktree, `dirty`,
    /// `ignored` and `unmerged` (`null` when unreadable); `size` adds `sizeBytes` and
    /// `sizeComplete`.
    pub async fn list_managed(
        &self,
        live: &HashSet<String>,
        retained: &HashSet<String>,
        inspect: bool,
        size: bool,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>, ScmFailure> {
        let mut rows = Vec::new();
        for stored in self.all_records(cancel).await? {
            let mut record = stored;
            record.branch = self.checked_out_branch_of(&record, cancel).await?;
            let (owner_live, is_retained, removable) = self.retention_of(&record, live, retained, cancel).await?;
            let mut row = entry_json(&record);
            row["sharedSessionIds"] = json!(record.shared_session_ids);
            row["retained"] = json!(is_retained);
            row["ownerLive"] = json!(owner_live);
            row["removable"] = json!(removable);
            if inspect && !is_snapshot(&record) && record.state == "ready" {
                let counts: Result<(usize, usize, u64), ScmFailure> = async {
                    let (changed, ignored, _) = self.automatic_keep_paths(&record, cancel).await?;
                    Ok((changed.len() + ignored.len(), ignored.len(), self.checkout_unmerged_count(&record, cancel).await?))
                }
                .await;
                match counts {
                    Ok((dirty, ignored, unmerged)) => {
                        row["dirty"] = json!(dirty);
                        row["ignored"] = json!(ignored);
                        row["unmerged"] = json!(unmerged);
                    }
                    Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                    Err(_) => {
                        row["dirty"] = Value::Null;
                        row["ignored"] = Value::Null;
                        row["unmerged"] = Value::Null;
                    }
                }
            }
            if size {
                let path = PathBuf::from(&record.path);
                let probe = path.clone();
                let present = on_lane(self.scm().lane, cancel, move || probe.exists()).await?;
                let measured = if present { Some(self.cached_folder_bytes(&path, cancel).await?) } else { None };
                row["sizeBytes"] = json!(measured.map(|m| m.bytes));
                row["sizeComplete"] = json!(measured.is_none_or(|m| m.complete));
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// The count/age limits' choice over already listed rows (uncapped), as the list shows it.
    async fn listed_cleanup_reasons(&self, sessions: &Arc<dyn SessionSource>, listed: &Listed<'_>) -> HashMap<String, CleanupReason> {
        let settings = self.current_settings().await;
        if !settings.auto_cleanup {
            return HashMap::new();
        }
        let Some(favorites) = sessions.favorites().await else { return HashMap::new() };
        if settings.max_worktrees == 0 && settings.unused_days == 0 {
            return HashMap::new();
        }
        let mut policy_rows: Vec<CleanupRow> = listed.rows.iter().map(cleanup_row).collect();
        for (policy, row) in policy_rows.iter_mut().zip(listed.rows) {
            let path = text(row, "path").unwrap_or_default();
            if listed.jobs.iter().any(|job| job.cwd.as_deref().is_some_and(|cwd| within(&path, cwd))) {
                policy.in_use = true;
            }
        }
        let options = SelectOptions {
            now: listed.now,
            activity: listed.activity,
            favorite_session_ids: &favorites,
            potential: false,
            repo_common_dir: None,
            max_removals: usize::MAX,
        };
        select_worktree_cleanup(&policy_rows, &settings, &options).into_iter().map(|picked| (picked.id, picked.reason)).collect()
    }

    /// The manual list: every managed worktree with its retention. `details` adds what the
    /// worktree list shows (counts, size, owner title, archive flag, `lastActiveAt` and
    /// `cleanupReason`). Snapshots are included; the caller drops them for the desktop list.
    pub async fn list_with_retention(
        &self,
        sessions: &Arc<dyn SessionSource>,
        live: &HashSet<String>,
        details: bool,
        now: i64,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>, ScmFailure> {
        let retained = sessions.stored_session_ids().await?;
        if !details {
            return self.list_managed(live, &retained, false, false, cancel).await;
        }
        // An unreadable job record stops the cleanup itself (fail closed), so no limit applies then.
        let jobs = sessions.running_jobs().await.ok();
        let mut live = live.clone();
        live.extend(jobs.iter().flatten().filter_map(|job| job.owner_session_id.clone()));
        let rows = self.list_managed(&live, &retained, true, true, cancel).await?;
        let owners: Vec<String> = rows.iter().flat_map(owners_of).collect();
        let activity = sessions.activity(&owners).await;
        let archived = sessions.archived().await.unwrap_or_default();
        let last_active: HashMap<String, i64> = activity.iter().filter_map(|(id, a)| a.last_active_at.map(|at| (id.clone(), at))).collect();
        let reasons = match &jobs {
            Some(jobs) => self.listed_cleanup_reasons(sessions, &Listed { rows: &rows, jobs, activity: &last_active, now }).await,
            None => HashMap::new(),
        };
        Ok(rows
            .into_iter()
            .map(|mut row| {
                let owner = text(&row, "ownerSessionId");
                let title = owner.as_ref().and_then(|id| activity.get(id)).and_then(|a| a.title.clone()).filter(|title| !title.is_empty());
                let last = row_activity(&cleanup_row(&row), &last_active);
                row["ownerTitle"] = json!(title);
                row["ownerArchived"] = json!(owner.as_ref().is_some_and(|id| archived.contains(id)));
                row["lastActiveAt"] = if last == 0 { Value::Null } else { json!(last) };
                row["cleanupReason"] = match text(&row, "id").and_then(|id| reasons.get(&id).copied()) {
                    Some(CleanupReason::Age) => json!("age"),
                    Some(CleanupReason::Count) => json!("count"),
                    None => Value::Null,
                };
                row
            })
            .collect())
    }
}

/// The rows of the desktop list: read-only snapshots (no branch) stay out of it.
pub fn without_snapshots(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter().filter(|row| row.get("kind").and_then(Value::as_str) != Some("snapshot")).collect()
}
