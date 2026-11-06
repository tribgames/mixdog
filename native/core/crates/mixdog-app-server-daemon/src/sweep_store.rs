//! The production [`SweepStore`]: the idle sweep's close and delete are the session runtime's own
//! guarded admission, not a liveness read of the sweep's.
//!
//! A delete is `SessionDirectory::delete_stored(id, activity, peers, cancel)`: on the session's
//! actor it re-asks, in the one step that closes the thread, that nothing is running or queued,
//! that the activity the pass read has not moved, and that nobody is or ever was attached
//! (`close_unattached`, the same transition an attach needs, so exactly one of the two wins). A
//! session that took work after the sweep's last look answers `Ok(false)` and keeps its row.
//! `is_live` stays what the verdict reads; no mutation relies on it.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use tokio_util::sync::CancellationToken;

use crate::session_sweep::SweepRow;
use crate::session_sweep::SweepStore;

/// What the sweep reads of the session runtime.
#[async_trait]
pub trait GuardedSessions: Send + Sync {
    /// Whether the session is open in this process (`_isSessionLive`): the verdict's input.
    fn is_loaded(&self, id: &str) -> bool;
    /// The guarded delete: `Ok(true)` once the session is gone, `Ok(false)` when its own
    /// admission refused (busy, attached, pending work, activity moved past `activity`, or
    /// `cancel` fired).
    async fn delete(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, String>;
}

#[async_trait]
impl GuardedSessions for SessionDirectory {
    fn is_loaded(&self, id: &str) -> bool {
        self.handle(&ThreadId::from(id)).is_some()
    }

    async fn delete(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, String> {
        self.delete_stored(id, activity, &[], cancel).await.map_err(|error| format!("{error:?}"))
    }
}

/// Every stored session as the sweep reads it, from the catalog.
#[async_trait]
pub trait SweepRows: Send + Sync {
    /// `Err` when the store cannot be read: nothing is swept then.
    async fn rows(&self) -> Result<Vec<SweepRow>, String>;
}

pub struct DirectorySweepStore {
    rows: Arc<dyn SweepRows>,
    sessions: Arc<dyn GuardedSessions>,
    /// The sweep's shutdown: a delete not yet admitted is refused once it fires.
    cancel: CancellationToken,
}

impl DirectorySweepStore {
    pub fn new(rows: Arc<dyn SweepRows>, sessions: Arc<dyn GuardedSessions>, cancel: CancellationToken) -> Self {
        Self { rows, sessions, cancel }
    }
}

#[async_trait]
impl SweepStore for DirectorySweepStore {
    async fn rows(&self) -> Result<Vec<SweepRow>, String> {
        self.rows.rows().await
    }

    /// The runtime has no guarded tombstone-only close yet: `Ctl::Delete`'s admission is the only
    /// one, and it ends in a delete. The close lands nothing (the row is kept) rather than go
    /// around the admission; see the wp-install-3 request.
    async fn close_idle(&self, row: &SweepRow) -> Result<bool, String> {
        tracing::debug!(id = row.id, "idle close waits for a guarded close in the session runtime");
        Ok(false)
    }

    async fn delete(&self, row: &SweepRow) -> Result<bool, String> {
        self.sessions.delete(&row.id, row.activity as f64, &self.cancel).await
    }

    fn is_live(&self, id: &str) -> bool {
        self.sessions.is_loaded(id)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering::SeqCst;

    use super::*;
    use crate::session_sweep::sweep_once;

    const NOW: i64 = 10_000_000_000;

    fn tombstone(id: &str, activity: i64) -> SweepRow {
        let long_ago = NOW - 3 * 24 * 60 * 60 * 1000;
        SweepRow {
            id: id.into(),
            owner: String::new(),
            status: "closed".into(),
            closed: true,
            updated_at: long_ago,
            last_heartbeat_at: 0,
            created_at: long_ago,
            record_mtime: long_ago,
            conversation_count: 2,
            activity,
        }
    }

    struct Rows(Vec<SweepRow>);

    #[async_trait]
    impl SweepRows for Rows {
        async fn rows(&self) -> Result<Vec<SweepRow>, String> {
            Ok(self.0.clone())
        }
    }

    /// A runtime whose admission is one atomic decision: `work` is set by a session starting work
    /// at any time, including after the sweep's last external look (`is_loaded`).
    #[derive(Default)]
    struct Runtime {
        work: AtomicBool,
        looks: AtomicUsize,
        admissions: Mutex<Vec<(String, f64, bool)>>,
    }

    #[async_trait]
    impl GuardedSessions for Runtime {
        fn is_loaded(&self, _: &str) -> bool {
            self.looks.fetch_add(1, SeqCst);
            false
        }

        async fn delete(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, String> {
            self.admissions.lock().unwrap().push((id.into(), activity, cancel.is_cancelled()));
            Ok(!self.work.load(SeqCst))
        }
    }

    fn store(runtime: &Arc<Runtime>, rows: Vec<SweepRow>) -> DirectorySweepStore {
        DirectorySweepStore::new(Arc::new(Rows(rows)), runtime.clone(), CancellationToken::new())
    }

    /// Work that starts after the sweep's last external check (the verdict's single look) still
    /// makes the delete refuse: the admission is the runtime's, and the sweep reads nothing again.
    #[tokio::test]
    async fn work_started_after_the_last_check_makes_the_delete_refuse() {
        let runtime = Arc::new(Runtime::default());
        let store = store(&runtime, vec![tombstone("sess_a", 7)]);
        // The verdict looked (not loaded) and chose a delete; the session then starts work.
        runtime.work.store(true, SeqCst);
        let tally = sweep_once(&store, NOW).await.unwrap();
        assert!(tally.tombstones_cleaned.is_empty());
        assert_eq!(tally.remaining, 1, "the refused session keeps its row");
        assert_eq!(runtime.looks.load(SeqCst), 1, "the sweep looked once, before the admission");
        assert_eq!(*runtime.admissions.lock().unwrap(), [("sess_a".to_owned(), 7.0, false)], "the activity the pass read goes to the admission");
    }

    #[tokio::test]
    async fn an_idle_session_is_admitted_and_deleted() {
        let runtime = Arc::new(Runtime::default());
        let store = store(&runtime, vec![tombstone("sess_a", 7)]);
        let tally = sweep_once(&store, NOW).await.unwrap();
        assert_eq!(tally.tombstones_cleaned, ["sess_a"]);
    }

    #[tokio::test]
    async fn a_sweep_already_shut_down_is_passed_to_the_admission() {
        let runtime = Arc::new(Runtime::default());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let store = DirectorySweepStore::new(Arc::new(Rows(vec![tombstone("sess_a", 1)])), runtime.clone(), cancel);
        sweep_once(&store, NOW).await.unwrap();
        assert!(runtime.admissions.lock().unwrap()[0].2);
    }
}
