//! The backfill source against `fixtures/session-search-backfill/golden.json`
//! (`record-session-search-backfill.mjs`): the store files real Node wrote, and what Node's
//! backfill reads of them. Here the same files are migrated (the product drivers and the
//! store's own index projector) and read through [`StoredSearchSessions`]: the same sessions,
//! each stamped, read with Node's agent-only verdict, and giving the search rows Node's
//! `sessionSearchRows` gives.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_services::memory::session_search::db::search_rows;
use mixdog_services::memory::session_search::ingest::StoredSessions;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;

use super::StoredSearchSessions;
use crate::session::SessionDirectory;
use crate::session::SessionLanes;
use crate::session::StoreThreads;
use crate::session::testing::Rig;
use crate::session::thread_state::SessionThreads;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/session-search-backfill/golden.json")).expect("golden.json")
}

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// The recorded sessions carry no attachment, so the migration reads no document.
struct NoDocuments;

#[async_trait::async_trait]
impl DocumentText for NoDocuments {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        unreachable!("no office document is recorded ({filename})")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("no PDF is recorded")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("no PDF is recorded")
    }
}

/// The golden's Node store files (`golden["files"]`: name → text of the store dir) migrated into
/// a fresh data dir, and the thread store over it.
pub(crate) async fn migrated(golden: &Value) -> (tempfile::TempDir, Arc<StoreThreads>, SessionLanes) {
    let dir = tempfile::tempdir().expect("temp dir");
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    let files: Vec<(PathBuf, String)> = golden["files"]
        .as_object()
        .expect("files")
        .iter()
        .map(|(name, text)| (roots.data.join("sessions").join(name), text.as_str().expect("file text").to_owned()))
        .chain([(roots.home.join("projects.json"), "{}".to_owned())])
        .collect();
    let tokens = mixdog_rt::testing::tokens();
    tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| {
            for (path, text) in &files {
                mixdog_statefile::append_file(lane, path, text.as_bytes()).expect("a Node store file");
            }
        })
        .expect("lane")
        .await
        .expect("job ran");
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("migrated");
    let data = roots.data.clone();
    let index = tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &data)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
    let threads = StoreThreads::over_data_dir(&roots.data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io)
        .await
        .expect("thread store");
    let lanes = SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
    (dir, Arc::new(threads), lanes)
}

/// Node's `sessionSearchRows` shape of the rows a transcript gives.
fn rows_of(session_id: &str, messages: &[Value]) -> Value {
    search_rows(session_id, messages)
        .into_iter()
        .map(|row| {
            json!({
                "sourceRef": row.source_ref,
                "sessionId": row.session_id,
                "ordinal": row.ordinal,
                "role": row.role,
                "ts": row.ts,
                "content": row.content,
            })
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_backfill_reads_what_node_reads_of_the_same_records() {
    let golden = golden();
    let (_dir, threads, lanes) = migrated(&golden).await;
    let stored = StoredSearchSessions::new(threads, lanes);
    let recorded = golden["sessions"].as_array().expect("sessions");

    // Both list in the OS's order of the store dir; the set is what must agree.
    let mut ids = stored.session_ids().await.expect("listing");
    ids.sort();
    let mut want: Vec<String> = recorded.iter().map(|s| s["id"].as_str().expect("id").to_owned()).collect();
    want.sort();
    assert_eq!(ids, want);

    for session in recorded {
        let id = session["id"].as_str().expect("id");
        let stamp = stored.record_stamp(id).await;
        assert_eq!(stamp.is_some(), session["stamped"] == true, "{id}");
        assert_eq!(stored.record_stamp(id).await, stamp, "{id}: an unchanged record keeps its stamp");
        let read = stored.read(id).await;
        assert_eq!(read.as_ref().map(|s| s.id.as_str()), session["read"].as_str(), "{id}");
        let Some(read) = read else { continue };
        assert_eq!(Value::Bool(read.agent_only), session["agentOnly"], "{id}");
        assert_eq!(rows_of(&read.id, &read.messages), session["rows"], "{id}");
    }

    assert!(stored.record_stamp("sess_missing").await.is_none());
    assert!(stored.read("sess_missing").await.is_none());
}

/// A record that changes gets a new stamp (Node: a save changes the file-stat stamp), and a
/// session carrying the delete mark leaves the listing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_changed_record_is_stamped_anew_and_a_deleted_one_is_not_listed() {
    let golden = golden();
    assert!(golden["stampChangesOnSave"].as_bool().expect("recorded"), "Node's save changes the stamp");
    let (_dir, threads, lanes) = migrated(&golden).await;
    let stored = StoredSearchSessions::new(threads.clone(), lanes);
    let before = stored.record_stamp("sess_plain").await.expect("stamped");

    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(threads.clone())));
    let set = [("title".to_owned(), json!("Heron survey"))].into_iter().collect();
    SessionThreads::new(directory).patch_header(&ThreadId::from("sess_plain"), set, Vec::new()).await.expect("patched");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let now = stored.record_stamp("sess_plain").await;
        if now.as_ref() != Some(&before) {
            assert!(now.is_some(), "the changed record is still stamped");
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "the stamp never moved");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    threads.index().mark_deleted("sess_child").await.expect("delete mark");
    let ids = stored.session_ids().await.expect("listing");
    assert!(!ids.iter().any(|id| id == "sess_child"), "{ids:?}");
    assert!(ids.iter().any(|id| id == "sess_plain"), "{ids:?}");
}
