//! The count/age cleanup policy (Node `maintenance.mjs` `selectWorktreeCleanup`, pure): which
//! managed worktrees an automatic cleanup pass removes, least recently used first. The session
//! layer supplies activity and favorites; the manager supplies the inspected rows.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use mixdog_js::locale_compare;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::worktree::manager::Worktrees;
use crate::worktree::reconcile::CleanupRules;
use crate::worktree::reconcile::ReconcileOptions;
use crate::worktree::registry::WorktreeRecord;
use crate::worktree::removal::InUse;
use crate::worktree::removal::RemoveRequest;
use crate::worktree::settings::WorktreeSettings;

/// Worktrees younger than this are never cleaned up automatically.
pub const CLEANUP_MIN_AGE_MS: i64 = 60 * 60_000;
/// At most this many count/age removals per pass.
pub const CLEANUP_MAX_REMOVALS: usize = 20;
const DAY_MS: i64 = 24 * 60 * 60_000;

/// One managed worktree as the policy sees it (an inspected list row, `in_use` added).
#[derive(Clone, Debug, Default)]
pub struct CleanupRow {
    pub id: String,
    pub repo_common_dir: String,
    pub is_snapshot: bool,
    pub state: String,
    pub dirty: u64,
    pub unmerged: u64,
    pub owner_live: bool,
    pub in_use: bool,
    pub owner_session_id: Option<String>,
    pub shared_session_ids: Vec<String>,
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupReason {
    Count,
    Age,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selected {
    pub id: String,
    pub reason: CleanupReason,
    pub last_active_at: i64,
}

pub struct SelectOptions<'a> {
    pub now: i64,
    /// Session id → last conversation turn.
    pub activity: &'a HashMap<String, i64>,
    pub favorite_session_ids: &'a HashSet<String>,
    /// The unverified preview: which candidates are dirty or unmerged is unknown, so any could
    /// fill the excess, and the per-pass cap does not apply.
    pub potential: bool,
    pub repo_common_dir: Option<&'a str>,
    pub max_removals: usize,
}

/// A row's last activity: its newest session's last turn, else its creation.
pub fn row_activity(row: &CleanupRow, activity: &HashMap<String, i64>) -> i64 {
    row.owner_session_id
        .iter()
        .chain(row.shared_session_ids.iter())
        .filter_map(|id| activity.get(id))
        .copied()
        .fold(row.created_at.max(0), i64::max)
}

fn path_key(path: &str) -> String {
    let normal = path.replace('\\', "/");
    let trimmed = normal.trim_end_matches('/');
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed.to_owned() }
}

/// Ready branch worktrees that are clean, merged, not in use, not shared, not a favorite
/// session's and old enough, chosen by the unused-days then max-worktrees limits.
pub fn select_worktree_cleanup(rows: &[CleanupRow], settings: &WorktreeSettings, options: &SelectOptions<'_>) -> Vec<Selected> {
    if !settings.auto_cleanup {
        return Vec::new();
    }
    let managed: Vec<&CleanupRow> = rows.iter().filter(|row| !row.is_snapshot).collect();
    let mut candidates: Vec<(&CleanupRow, i64)> = managed
        .iter()
        .copied()
        .filter(|row| {
            row.state == "ready"
                && row.dirty == 0
                && row.unmerged == 0
                && !row.owner_live
                && !row.in_use
                && row.shared_session_ids.is_empty()
                && !row.owner_session_id.as_ref().is_some_and(|id| options.favorite_session_ids.contains(id))
                && options.now - row.created_at.max(0) >= CLEANUP_MIN_AGE_MS
        })
        .map(|row| (row, row_activity(row, options.activity)))
        .collect();
    candidates.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| locale_compare(&a.0.id, &b.0.id)));
    let mut reasons: HashMap<&str, CleanupReason> = HashMap::new();
    if settings.unused_days > 0 {
        let cutoff = options.now - settings.unused_days as i64 * DAY_MS;
        for (row, active) in &candidates {
            if *active < cutoff {
                reasons.insert(&row.id, CleanupReason::Age);
            }
        }
    }
    if settings.max_worktrees > 0 {
        let mut excess = managed.len() as i64 - settings.max_worktrees as i64;
        for (row, _) in &candidates {
            if excess <= 0 {
                break;
            }
            reasons.entry(&row.id).or_insert(CleanupReason::Count);
            if !options.potential {
                excess -= 1;
            }
        }
    }
    // The limits count every repository; a scoped cleanup drops the others' picks before the cap.
    let scope = options.repo_common_dir.map(path_key);
    let picked = candidates
        .into_iter()
        .filter(|(row, _)| reasons.contains_key(row.id.as_str()) && scope.as_ref().is_none_or(|s| path_key(&row.repo_common_dir) == *s));
    let cap = if options.potential { usize::MAX } else { options.max_removals };
    picked.take(cap).map(|(row, active)| Selected { id: row.id.clone(), reason: reasons[row.id.as_str()], last_active_at: active }).collect()
}

/// What the session layer knows, read at use time (Node reads the session store, the desktop's
/// sidebar and the shell-job records). An unreadable store is an `Err`: it never reads as "no
/// sessions", which would make every worktree look orphaned.
#[async_trait::async_trait]
pub trait SessionSource: Send + Sync {
    /// Ids of every session record in the store, tombstones included.
    async fn stored_session_ids(&self) -> Result<HashSet<String>, ScmFailure>;
    /// Favorite session ids from the attached desktop; `None` when unknown.
    async fn favorites(&self) -> Option<HashSet<String>>;
    /// Archived session ids; `None` when no desktop is attached.
    async fn archived(&self) -> Option<HashSet<String>>;
    /// Last activity and title of the given stored sessions (missing ones left out).
    async fn activity(&self, ids: &[String]) -> HashMap<String, SessionActivity>;
    /// Running background shell jobs; an unreadable record is an `Err` (fail closed).
    async fn running_jobs(&self) -> Result<Vec<ShellJob>, ScmFailure>;
}

#[derive(Clone, Debug, Default)]
pub struct SessionActivity {
    pub last_active_at: Option<i64>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ShellJob {
    pub cwd: Option<String>,
    pub owner_session_id: Option<String>,
}

fn within(folder: &str, path: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let (a, b) = (norm(folder.trim_end_matches(['/', '\\'])), norm(path));
    !path.is_empty() && (b == a || b.starts_with(&format!("{a}/")))
}

struct JobsInUse {
    sessions: Arc<dyn SessionSource>,
    live: HashSet<String>,
    current_live: Arc<dyn Fn() -> HashSet<String> + Send + Sync>,
}

#[async_trait::async_trait]
impl InUse for JobsInUse {
    async fn in_use(&self, record: &WorktreeRecord) -> bool {
        let mut now = self.live.clone();
        now.extend((self.current_live)());
        // An unreadable job record fails closed: the worktree counts as in use.
        let Ok(jobs) = self.sessions.running_jobs().await else { return true };
        now.extend(jobs.iter().filter_map(|job| job.owner_session_id.clone()));
        record.owner_session_id.iter().chain(record.shared_session_ids.iter()).any(|id| now.contains(id))
            || jobs.iter().any(|job| job.cwd.as_deref().is_some_and(|cwd| within(&record.path, cwd)))
    }
}

#[derive(Clone)]
pub struct CleanupOptions {
    pub live: HashSet<String>,
    pub repo_common_dir: Option<String>,
    /// The manual "Clean up now": independent of autoCleanup.
    pub explicit: bool,
    pub now: i64,
    pub settings: Option<WorktreeSettings>,
    pub current_live: Arc<dyn Fn() -> HashSet<String> + Send + Sync>,
    pub final_check_timeout: Option<std::time::Duration>,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            live: HashSet::new(),
            repo_common_dir: None,
            explicit: false,
            now: now_ms(),
            settings: None,
            current_live: Arc::new(HashSet::new),
            final_check_timeout: None,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The count/age limits' selection for one pass (autoCleanup on only).
struct Limits {
    selected: Vec<Selected>,
    favorites: HashSet<String>,
    /// `off`, `applied` or `favorites-unknown`.
    state: &'static str,
}

impl Worktrees {
    /// Managed branch worktrees as the policy sees them. `inspect` runs the per-worktree
    /// dirty/merge checks the removal needs; off, every ready worktree counts as clean and
    /// merged (the preview's optimistic, git-free reading). Unreadable state counts as work to keep.
    async fn cleanup_rows(&self, live: &HashSet<String>, retained: &HashSet<String>, inspect: bool, cancel: &CancellationToken) -> Result<Vec<CleanupRow>, ScmFailure> {
        let mut rows = Vec::new();
        for record in self.all_records(cancel).await? {
            let (owner_live, _, _) = self.retention_of(&record, live, retained, cancel).await?;
            let snapshot = record.extra.get("kind").and_then(|v| v.as_str()) == Some("snapshot");
            let (mut dirty, mut unmerged) = (0u64, 0u64);
            if inspect && !snapshot && record.state == "ready" {
                let checked: Result<(u64, u64), ScmFailure> = async {
                    let (changed, ignored, _) = self.automatic_keep_paths(&record, cancel).await?;
                    Ok(((changed.len() + ignored.len()) as u64, self.checkout_unmerged_count(&record, cancel).await?))
                }
                .await;
                match checked {
                    Ok(pair) => (dirty, unmerged) = pair,
                    Err(ScmFailure::Cancelled) => return Err(ScmFailure::Cancelled),
                    Err(_) => (dirty, unmerged) = (u64::MAX, u64::MAX),
                }
            }
            rows.push(CleanupRow {
                id: record.id.clone(),
                repo_common_dir: record.repo_common_dir.clone(),
                is_snapshot: snapshot,
                state: record.state.clone(),
                dirty,
                unmerged,
                owner_live,
                in_use: false,
                owner_session_id: record.owner_session_id.clone(),
                shared_session_ids: record.shared_session_ids.clone(),
                created_at: record.created_at,
            });
        }
        Ok(rows)
    }

    #[allow(clippy::too_many_arguments)]
    async fn select_limit_cleanup(
        &self,
        sessions: &Arc<dyn SessionSource>,
        settings: &WorktreeSettings,
        live: &mut HashSet<String>,
        jobs: &[ShellJob],
        retained: &HashSet<String>,
        now: i64,
        inspect: bool,
        repo_common_dir: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<Limits, ScmFailure> {
        if !settings.auto_cleanup {
            return Ok(Limits { selected: Vec::new(), favorites: HashSet::new(), state: "off" });
        }
        let Some(favorites) = sessions.favorites().await else {
            return Ok(Limits { selected: Vec::new(), favorites: HashSet::new(), state: "favorites-unknown" });
        };
        let mut selected = Vec::new();
        if settings.max_worktrees > 0 || settings.unused_days > 0 {
            let mut rows = self.cleanup_rows(live, retained, inspect, cancel).await?;
            for (row, record) in rows.iter_mut().zip(self.all_records(cancel).await?) {
                if jobs.iter().any(|job| job.cwd.as_deref().is_some_and(|cwd| within(&record.path, cwd))) {
                    row.in_use = true;
                    live.extend(row.owner_session_id.clone());
                }
            }
            let owners: Vec<String> = rows.iter().flat_map(|r| r.owner_session_id.iter().chain(r.shared_session_ids.iter()).cloned()).collect();
            let activity: HashMap<String, i64> =
                sessions.activity(&owners).await.into_iter().filter_map(|(id, a)| a.last_active_at.map(|at| (id, at))).collect();
            let options = SelectOptions {
                now,
                activity: &activity,
                favorite_session_ids: &favorites,
                potential: !inspect,
                repo_common_dir,
                max_removals: CLEANUP_MAX_REMOVALS,
            };
            selected = select_worktree_cleanup(&rows, settings, &options);
        }
        Ok(Limits { selected, favorites, state: "applied" })
    }

    fn reconcile_options(&self, live: &HashSet<String>, retained: &HashSet<String>, settings: &WorktreeSettings, limits: &Limits, options: &CleanupOptions) -> ReconcileOptions {
        let mut reconcile = ReconcileOptions { live: live.clone(), retained: retained.clone(), repo_common_dir: options.repo_common_dir.clone(), ..ReconcileOptions::default() };
        if settings.auto_cleanup {
            reconcile.rules = CleanupRules {
                selected: limits.selected.iter().map(|s| s.id.clone()).collect(),
                favorites: limits.favorites.clone(),
                min_age_ms: CLEANUP_MIN_AGE_MS,
                now: options.now,
                cleanup_archived: settings.cleanup_archived && limits.state == "applied",
            };
        }
        reconcile
    }

    /// Whether "Clean up now" could act on anything, without its git verification or any
    /// removal: registrations whose folder is gone, unretained or disposable worktrees,
    /// interrupted removals, and with autoCleanup on the limits and archive rules. A candidate
    /// may still be kept when the prune verifies it. `(ids, stale)`.
    pub async fn preview_worktree_cleanup(&self, sessions: &Arc<dyn SessionSource>, options: &CleanupOptions, cancel: &CancellationToken) -> Result<(Vec<String>, Vec<String>), ScmFailure> {
        let settings = match &options.settings {
            Some(settings) => settings.clone(),
            None => self.current_settings().await,
        };
        let retained = sessions.stored_session_ids().await?;
        let mut live = options.live.clone();
        let jobs = sessions.running_jobs().await?;
        live.extend(jobs.iter().filter_map(|job| job.owner_session_id.clone()));
        let limits = self
            .select_limit_cleanup(sessions, &settings, &mut live, &jobs, &retained, options.now, false, options.repo_common_dir.as_deref(), cancel)
            .await?;
        let reconcile = self.reconcile_options(&live, &retained, &settings, &limits, options);
        self.preview_cleanup(&reconcile, cancel).await
    }

    /// The automatic cleanup (daemon startup and the idle pass), and with `explicit` the manual
    /// "Clean up now". Always the bookkeeping reconcile; with autoCleanup on (or `explicit`) the
    /// removal of clean, merged worktrees no stored session retains, and with autoCleanup on
    /// the archive rules and what the count/age limits select. Never removed: dirty or unmerged
    /// work, a live owner, a running job in the folder, a favorite's, one younger than an hour,
    /// a shared one. Unknown favorites skip the limits (`limits: favorites-unknown`).
    pub async fn run_worktree_cleanup(&self, sessions: &Arc<dyn SessionSource>, options: &CleanupOptions, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let settings = match &options.settings {
            Some(settings) => settings.clone(),
            None => self.current_settings().await,
        };
        let retained = sessions.stored_session_ids().await?;
        if !settings.auto_cleanup && !options.explicit {
            let reconcile = ReconcileOptions { live: options.live.clone(), retained, repo_common_dir: options.repo_common_dir.clone(), ..ReconcileOptions::default() };
            let mut report = self.reconcile(&reconcile, cancel).await?.to_json();
            report["selected"] = json!([]);
            return Ok(report);
        }
        let mut live = options.live.clone();
        let jobs = sessions.running_jobs().await?;
        live.extend(jobs.iter().filter_map(|job| job.owner_session_id.clone()));
        let limits = self
            .select_limit_cleanup(sessions, &settings, &mut live, &jobs, &retained, options.now, true, options.repo_common_dir.as_deref(), cancel)
            .await?;
        let mut reconcile = self.reconcile_options(&live, &retained, &settings, &limits, options);
        reconcile.remove_orphans = true;
        reconcile.preserve_branch = !settings.delete_branch;
        reconcile.max_removals = CLEANUP_MAX_REMOVALS;
        reconcile.in_use = Arc::new(JobsInUse { sessions: sessions.clone(), live: live.clone(), current_live: options.current_live.clone() });
        if let Some(timeout) = options.final_check_timeout {
            reconcile.final_check_timeout = timeout;
        }
        let mut report = self.reconcile(&reconcile, cancel).await?.to_json();
        report["selected"] = json!(limits.selected.iter().map(|s| json!({
            "id": s.id,
            "reason": if s.reason == CleanupReason::Age { "age" } else { "count" },
            "lastActiveAt": s.last_active_at,
        })).collect::<Vec<_>>());
        report["limits"] = json!(limits.state);
        Ok(report)
    }

    /// Daemon startup, off the boot path: resume interrupted deletions and creations, release
    /// stale leases, prune stale registrations; with autoCleanup on, also the automatic cleanup.
    /// The editor-recovery descriptors the file host registered (`with_recovery_store`) are
    /// read from the records, so a deletion pending across the restart still waits for them.
    pub async fn reconcile_at_startup(&self, sessions: &Arc<dyn SessionSource>, options: &CleanupOptions, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.run_worktree_cleanup(sessions, options, cancel).await
    }

    /// After sessions were archived (or restored): with autoCleanup and cleanupArchived on, an
    /// archive marks their worktrees disposable (nothing is removed here); a restore always
    /// clears the mark.
    pub async fn set_archived_session_worktrees(&self, session_ids: &HashSet<String>, archived: bool, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        if archived {
            let settings = self.current_settings().await;
            if !settings.auto_cleanup {
                return Ok(json!({ "changed": [], "reason": "auto-cleanup-off" }));
            }
            if !settings.cleanup_archived {
                return Ok(json!({ "changed": [], "reason": "archive-cleanup-off" }));
            }
        }
        Ok(json!({ "changed": self.set_session_worktrees_disposable(session_ids, archived, cancel).await? }))
    }

    /// After a session was deleted: with autoCleanup on, its worktree is marked disposable and
    /// removed when clean and merged (dirty or unmerged work is kept, still disposable, for a
    /// later prune). Off: kept. Its branch stays unless deleteBranch is on. `None`: it had none.
    pub async fn cleanup_deleted_session_worktree(&self, session_id: &str, cancel: &CancellationToken) -> Result<Option<Value>, ScmFailure> {
        let Some(entry) = self
            .all_records(cancel)
            .await?
            .into_iter()
            .find(|r| r.owner_session_id.as_deref() == Some(session_id) && r.extra.get("kind").is_none())
        else {
            return Ok(None);
        };
        let settings = self.current_settings().await;
        if !settings.auto_cleanup {
            return Ok(Some(json!({ "entryId": entry.id, "removed": false, "reason": "auto-cleanup-off" })));
        }
        if entry.state == "ready" {
            self.mark_disposable(&entry.id, true, cancel).await?;
        }
        let request = RemoveRequest { entry_id: entry.id.clone(), automatic: true, preserve_branch: !settings.delete_branch, ..RemoveRequest::default() };
        match self.remove_managed(request, cancel).await {
            Ok(mut result) => {
                result["entryId"] = json!(entry.id);
                Ok(Some(result))
            }
            Err(failure) => match failure.code() {
                Some(code @ ("WORKTREE_DIRTY" | "WORKTREE_BUSY_JOBS" | "WORKTREE_UNMERGED" | "WORKTREE_FILE_RECOVERY")) => {
                    Ok(Some(json!({ "entryId": entry.id, "removed": false, "reason": code })))
                }
                _ => Err(failure),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000 * DAY_MS;

    fn row(id: &str, created_days_ago: i64) -> CleanupRow {
        CleanupRow {
            id: id.into(),
            repo_common_dir: "/r/.git".into(),
            state: "ready".into(),
            created_at: NOW - created_days_ago * DAY_MS,
            ..Default::default()
        }
    }

    fn settings(max: u64, days: u64) -> WorktreeSettings {
        WorktreeSettings { auto_cleanup: true, max_worktrees: max, unused_days: days, ..WorktreeSettings::default() }
    }

    fn pick(rows: &[CleanupRow], s: &WorktreeSettings, potential: bool, scope: Option<&str>) -> Vec<(String, CleanupReason)> {
        let (activity, favorites) = (HashMap::new(), HashSet::new());
        let options = SelectOptions { now: NOW, activity: &activity, favorite_session_ids: &favorites, potential, repo_common_dir: scope, max_removals: 20 };
        select_worktree_cleanup(rows, s, &options).into_iter().map(|p| (p.id, p.reason)).collect()
    }

    #[test]
    fn off_selects_nothing_and_age_then_count_pick_oldest_first() {
        let rows = [row("a", 10), row("b", 5), row("c", 1)];
        let mut off = settings(1, 7);
        off.auto_cleanup = false;
        assert!(pick(&rows, &off, false, None).is_empty());
        // `a` is past 7 unused days; 3 managed against a max of 1 leaves an excess of 2.
        assert_eq!(pick(&rows, &settings(1, 7), false, None), [("a".to_owned(), CleanupReason::Age), ("b".to_owned(), CleanupReason::Count)]);
    }

    #[test]
    fn dirty_unmerged_live_shared_favorite_young_and_snapshot_rows_are_never_picked() {
        let mut dirty = row("dirty", 10);
        dirty.dirty = 1;
        let mut unmerged = row("unmerged", 10);
        unmerged.unmerged = 2;
        let mut live = row("live", 10);
        live.owner_live = true;
        let mut shared = row("shared", 10);
        shared.shared_session_ids = vec!["s".into()];
        let mut favorite = row("favorite", 10);
        favorite.owner_session_id = Some("fav".into());
        let mut young = row("young", 0);
        young.created_at = NOW - 60_000;
        let mut snapshot = row("snap", 10);
        snapshot.is_snapshot = true;
        let rows = [dirty, unmerged, live, shared, favorite, young, snapshot, row("ok", 10)];
        let (activity, favorites) = (HashMap::new(), HashSet::from(["fav".to_owned()]));
        let options = SelectOptions { now: NOW, activity: &activity, favorite_session_ids: &favorites, potential: false, repo_common_dir: None, max_removals: 20 };
        let picked = select_worktree_cleanup(&rows, &settings(0, 1), &options);
        assert_eq!(picked.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["ok"]);
    }

    #[test]
    fn a_scope_drops_other_repositories_before_the_cap_and_potential_uncaps() {
        let mut other = row("other", 20);
        other.repo_common_dir = "/x/.git".into();
        let rows = [other, row("mine", 10)];
        assert_eq!(pick(&rows, &settings(0, 1), false, Some("/r/.git/")).len(), 1);
        let many: Vec<CleanupRow> = (0..25).map(|i| row(&format!("w{i:02}"), 10)).collect();
        assert_eq!(pick(&many, &settings(0, 1), false, None).len(), CLEANUP_MAX_REMOVALS);
        assert_eq!(pick(&many, &settings(0, 1), true, None).len(), 25);
    }

    #[test]
    fn a_session_turn_after_creation_moves_a_rows_activity() {
        let mut r = row("a", 10);
        r.owner_session_id = Some("s".into());
        let activity = HashMap::from([("s".to_owned(), NOW - DAY_MS)]);
        assert_eq!(row_activity(&r, &activity), NOW - DAY_MS);
    }
}
