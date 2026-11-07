//! The production [`SweepStore`]: the idle sweep's close and delete are the session runtime's own
//! guarded admission, not a liveness read of the sweep's.
//!
//! A delete is `SessionDirectory::delete_stored(id, activity, peers, cancel)`: on the session's
//! actor it re-asks, in the one step that closes the thread, that nothing is running or queued,
//! that the activity the pass read has not moved, and that nobody is or ever was attached
//! (`close_unattached`, the same transition an attach needs, so exactly one of the two wins). A
//! session that took work after the sweep's last look answers `Ok(false)` and keeps its row.
//! `is_live` stays what the verdict reads; no mutation relies on it.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::sqlite::listing::RecordStamp;
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
    /// The guarded tombstone-only close (`idle-sweep`), admitted as the delete is: `Ok(true)`
    /// once the tombstone landed, `Ok(false)` when the admission refused.
    async fn close(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, String>;
    /// `isHistoricalAutomaticClosure` of the stored record: a named session an automatic close
    /// (`idle-sweep`, `terminal-reap`) tombstoned. Node never deletes one. Asked only of a
    /// closed row about to be deleted, so the header is read for those alone.
    async fn automatic_closure(&self, id: &str) -> Result<bool, String>;
}

/// `isHistoricalAutomaticClosure(session)` (`historical-session-closure.mjs`).
pub fn is_historical_automatic_closure(header: &serde_json::Map<String, serde_json::Value>) -> bool {
    let text = |key: &str| header.get(key).and_then(serde_json::Value::as_str);
    text("owner").is_some_and(|owner| !owner.is_empty())
        && (header.get("closed") == Some(&serde_json::Value::Bool(true)) || text("status") == Some("closed"))
        && matches!(text("closedReason"), Some("idle-sweep" | "terminal-reap"))
}

#[async_trait]
impl GuardedSessions for SessionDirectory {
    fn is_loaded(&self, id: &str) -> bool {
        self.handle(&ThreadId::from(id)).is_some()
    }

    async fn automatic_closure(&self, id: &str) -> Result<bool, String> {
        let header = self.try_stored_header(&ThreadId::from(id)).await.map_err(|error| format!("{error:?}"))?;
        Ok(header.is_some_and(|header| is_historical_automatic_closure(&header)))
    }

    async fn close(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, String> {
        self.close_stored(id, activity, cancel).await.map_err(|error| format!("{error:?}"))
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

/// [`SweepRows`] from the catalog's one session listing (`SqliteStore::sweep_sessions`): no
/// session file is read again; only each newest log file is `stat`ed.
pub struct CatalogSweepRows {
    store: Arc<SqliteStore>,
    /// `<data>/sessions`.
    sessions: PathBuf,
}

impl CatalogSweepRows {
    pub fn new(store: Arc<SqliteStore>, sessions: PathBuf) -> Self {
        Self { store, sessions }
    }
}

#[async_trait]
impl SweepRows for CatalogSweepRows {
    /// A session whose log file is gone (Node: `_queueSessionSummaryRemoval`) or cannot be
    /// `stat`ed (Node: `remaining++`) is left out: it is not swept this pass.
    async fn rows(&self) -> Result<Vec<SweepRow>, String> {
        let listed = self.store.sweep_sessions(self.sessions.clone()).await.map_err(|error| error.to_string())?;
        Ok(listed
            .into_iter()
            .filter_map(|s| {
                let record_mtime = match s.record {
                    RecordStamp::At(at) => at,
                    RecordStamp::Absent => return None,
                    RecordStamp::Unreadable(why) => {
                        tracing::warn!(id = s.id, "idle sweep leaves a session whose record cannot be read: {why}");
                        return None;
                    }
                };
                Some(SweepRow {
                    id: s.id,
                    owner: s.owner,
                    status: s.status,
                    closed: s.closed,
                    updated_at: s.updated_at,
                    last_heartbeat_at: s.last_heartbeat_at,
                    created_at: s.created_at,
                    record_mtime,
                    conversation_count: s.message_count,
                    activity: s.activity,
                })
            })
            .collect())
    }
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

    /// `markSessionClosed(id, 'idle-sweep', ..)` through the session runtime's guarded close
    /// (`SessionDirectory::close_stored`): the same admission as the delete's.
    async fn close_idle(&self, row: &SweepRow) -> Result<bool, String> {
        self.sessions.close(&row.id, row.activity as f64, &self.cancel).await
    }

    async fn delete(&self, row: &SweepRow) -> Result<bool, String> {
        // Node's `sweepRow` leaves such a record as it is (`remaining++`) before any tombstone delete.
        if (row.closed || row.status == "closed") && self.sessions.automatic_closure(&row.id).await? {
            return Ok(false);
        }
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
        /// Sessions whose record is a historical automatic closure.
        automatic: Mutex<std::collections::HashSet<String>>,
        closes: Mutex<Vec<(String, f64, bool)>>,
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

        async fn close(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, String> {
            self.closes.lock().unwrap().push((id.into(), activity, cancel.is_cancelled()));
            Ok(!self.work.load(SeqCst))
        }

        async fn automatic_closure(&self, id: &str) -> Result<bool, String> {
            Ok(self.automatic.lock().unwrap().contains(id))
        }
    }

    fn idle_ownerless(id: &str, activity: i64) -> SweepRow {
        let at = NOW - 6 * 60 * 1000;
        SweepRow { status: "idle".into(), closed: false, updated_at: at, created_at: at, record_mtime: at, activity, ..tombstone(id, activity) }
    }

    /// An idle ownerless session is closed through the runtime's guarded close with the activity the
    /// pass read; one the admission refuses keeps its row.
    #[tokio::test]
    async fn an_idle_close_goes_through_the_runtimes_guarded_close() {
        let runtime = Arc::new(Runtime::default());
        let tally = sweep_once(&store(&runtime, vec![idle_ownerless("sess_a", 9)]), NOW).await.unwrap();
        assert_eq!(tally.cleaned, ["sess_a"]);
        assert_eq!(*runtime.closes.lock().unwrap(), [("sess_a".to_owned(), 9.0, false)]);
        assert!(runtime.admissions.lock().unwrap().is_empty(), "a close is not a delete");
        let busy = Arc::new(Runtime::default());
        busy.work.store(true, SeqCst);
        let tally = sweep_once(&store(&busy, vec![idle_ownerless("sess_a", 9)]), NOW).await.unwrap();
        assert!(tally.cleaned.is_empty());
        assert_eq!(tally.remaining, 1);
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

    /// The historical automatic closure is Node's `isHistoricalAutomaticClosure`.
    #[test]
    fn a_named_session_an_automatic_close_tombstoned_is_historical() {
        let header = |v: serde_json::Value| v.as_object().unwrap().clone();
        let closed = |owner: serde_json::Value, reason: &str| header(serde_json::json!({"owner": owner, "closed": true, "closedReason": reason}));
        assert!(is_historical_automatic_closure(&closed("cli".into(), "idle-sweep")));
        assert!(is_historical_automatic_closure(&closed("cli".into(), "terminal-reap")));
        assert!(!is_historical_automatic_closure(&closed("cli".into(), "desktop-session-delete")));
        assert!(!is_historical_automatic_closure(&closed("".into(), "idle-sweep")), "an ownerless legacy closure is not historical");
        assert!(!is_historical_automatic_closure(&header(serde_json::json!({"owner": "cli", "closedReason": "idle-sweep"}))), "open");
        assert!(is_historical_automatic_closure(&header(serde_json::json!({"owner": "cli", "status": "closed", "closedReason": "idle-sweep"}))));
    }

    #[tokio::test]
    async fn a_historical_closure_is_kept_not_deleted() {
        let runtime = Arc::new(Runtime::default());
        runtime.automatic.lock().unwrap().insert("sess_a".into());
        let store = store(&runtime, vec![tombstone("sess_a", 7), tombstone("sess_b", 7)]);
        let tally = sweep_once(&store, NOW).await.unwrap();
        assert_eq!(tally.tombstones_cleaned, ["sess_b"]);
        assert_eq!(tally.remaining, 1);
        assert_eq!(runtime.admissions.lock().unwrap().len(), 1, "the kept one never reaches the admission");
    }

    /// The golden sweeps of Node's `sweepStaleSessions` (`fixtures/idle-sweep/golden.json`) over rows
    /// that came out of a real catalog: headers upserted into the index, each log file's mtime set,
    /// read back by `CatalogSweepRows`. Only the sessions a catalog row can reproduce are fed: a
    /// record with no `owner` lists as `'user'` (the summary row Node's own `effectiveFields` falls
    /// back to), and the catalog holds no messages here, so a conversation is a closed or an empty one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn golden_sweeps_hold_over_rows_read_from_the_catalog() {
        use mixdog_rt::CancellationToken;
        use mixdog_rt::LaneToken;
        use mixdog_rt::testing::tokens;
        use mixdog_store::summary::CatalogHead;

        struct Fixed {
            live: Vec<String>,
            vetoed: Vec<String>,
        }
        #[async_trait]
        impl GuardedSessions for Fixed {
            fn is_loaded(&self, id: &str) -> bool {
                self.live.iter().any(|l| l == id)
            }
            async fn delete(&self, id: &str, _: f64, _: &CancellationToken) -> Result<bool, String> {
                Ok(!self.vetoed.iter().any(|v| v == id))
            }
            async fn close(&self, id: &str, _: f64, _: &CancellationToken) -> Result<bool, String> {
                Ok(!self.vetoed.iter().any(|v| v == id))
            }
            async fn automatic_closure(&self, _: &str) -> Result<bool, String> {
                Ok(false)
            }
        }

        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/idle-sweep/golden.json")).unwrap();
        let ids = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        for (name, scenario) in golden["scenarios"].as_object().unwrap() {
            let rows: Vec<&serde_json::Value> =
                scenario["rows"].as_array().unwrap().iter().filter(|r| (r["closed"] == true || r["conversation"] == 0) && (r["closed"] == true || r["owner"] != "")).collect();
            if rows.is_empty() {
                continue;
            }
            let tmp = tempfile::tempdir().unwrap();
            let data = tmp.path().to_path_buf();
            let (tx, rx) = std::sync::mpsc::channel();
            let open = data.clone();
            let _job = tokens()
                .maintenance_io
                .submit(&CancellationToken::new(), move |lane| {
                    let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &open));
                })
                .unwrap();
            let index = Arc::new(rx.recv().unwrap().unwrap());
            for r in &rows {
                let id = r["id"].as_str().unwrap();
                let at = now - r["ageMs"].as_i64().unwrap();
                let mut header = serde_json::json!({"id": id, "createdAt": at, "updatedAt": at, "status": r["status"]});
                if r["owner"] != "" {
                    header["owner"] = r["owner"].clone();
                }
                if r["closed"] == true {
                    header["closed"] = true.into();
                }
                let dir = data.join("sessions").join(id);
                std::fs::create_dir_all(&dir).unwrap();
                let log = dir.join(mixdog_store::log::log_name(0));
                std::fs::write(&log, b"log").unwrap();
                std::fs::File::options().write(true).open(&log).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at as u64)).unwrap();
                let head = CatalogHead { session: id.into(), log_id: "L".into(), base_session: None, header: header.as_object().unwrap().clone() };
                index.upsert(head, mixdog_store::sqlite::DirtyMark::Clear).await.unwrap();
            }
            let fed: Vec<String> = rows.iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect();
            let sessions = Fixed { live: ids(&scenario["live"]), vetoed: ids(&scenario["vetoed"]) };
            let store = DirectorySweepStore::new(Arc::new(CatalogSweepRows::new(index, data.join("sessions"))), Arc::new(sessions), CancellationToken::new());
            let tally = sweep_once(&store, now).await.unwrap();
            let only = |want: &serde_json::Value| ids(want).into_iter().filter(|id| fed.contains(id)).collect::<Vec<_>>();
            let sorted = |mut v: Vec<String>| {
                v.sort();
                v
            };
            assert_eq!(sorted(tally.cleaned), only(&scenario["cleaned"]), "{name}: closed");
            assert_eq!(sorted(tally.tombstones_cleaned), only(&scenario["tombstonesCleaned"]), "{name}: tombstones");
            assert_eq!(sorted(tally.open_pruned), only(&scenario["openPruned"]), "{name}: pruned");
        }
    }
}
