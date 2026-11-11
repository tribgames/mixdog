//! The roster over sessions the b6f10295a product itself wrote (`benchmarks/rust-core/recorders/record-roster-rows.mjs` ->
//! `fixtures/roster-rows`): Node's own session code made the data directory (a plain session, a compacted one, a legacy record,
//! an archived, a favorite, a read one, an agent's worker session, a deleted agent's home, forks, a stray and a worktree session)
//! and the desktop's own metadata and room records the profile; two rooms were made through the desktop's room creation, one
//! whose log stays in the catalog and one whose log is gone. The desktop's `sessionCatalog` answered over it all (`answers.json`).
//! The core migrates the profile into the stored sessions and room records, opens the directory through its real store, thread
//! list and room list, and every row it answers is Node's row, whole, under the protocol's one rename (`inheritedFromSessionId` is
//! `forkedFromId`). Node's JSON is compared as recorded: no row is read into a Rust type first.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
use mixdog_core_rooms::rooms::records::Rooms;
use mixdog_core_rooms::rooms::service::RoomRunner;
use mixdog_core_rooms::rooms::store::StateRoomStore;
use mixdog_core_session::session::StoreThreads;
use mixdog_core_session::session::TaskWorkspace;
use mixdog_core_session::session::thread_list::LIST;
use mixdog_core_session::session::thread_list::ListOverlay;
use mixdog_core_session::session::thread_list::RowOverlay;
use mixdog_core_session::session::thread_list::ThreadListService;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::room_list::RoomListRows;

struct NoDocuments;

#[async_trait]
impl DocumentText for NoDocuments {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        panic!("the recorded data has no office part, yet {filename} was extracted")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/roster-rows")
}

fn answers() -> Value {
    serde_json::from_slice(&durable::read(&fixture().join("answers.json")).expect("answers.json")).expect("answers parse")
}

fn copy_tree(from: &Path, to: &Path) {
    for rel in durable::walk_files(from).expect("walk the recording") {
        let target = to.join(&rel);
        durable::create_dir_all(target.parent().expect("a file has a parent")).expect("dir");
        durable::write_synced(&target, &durable::read(&from.join(&rel)).expect("read")).expect("copy");
    }
}

/// The recording copied to a scratch directory and migrated with its desktop profile, as the core does at its first start.
async fn migrated() -> (tempfile::TempDir, MigrationRoots) {
    migrated_from(&fixture()).await
}

/// A recorded `.mixdog` (and its desktop `profile`, when the recording has one) copied to a scratch directory and migrated, as
/// the core does at its first start.
pub(super) async fn migrated_from(recording: &Path) -> (tempfile::TempDir, MigrationRoots) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let home = dir.path().join(".mixdog");
    copy_tree(&recording.join(".mixdog"), &home);
    let profile = recording.join("profile").exists().then(|| {
        let profile = dir.path().join("profile");
        copy_tree(&recording.join("profile"), &profile);
        profile
    });
    let roots = MigrationRoots { data: home.join("data"), home, profile };
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("the migration of the recorded data completes");
    (dir, roots)
}

/// The task workspace the recording's host had.
struct Tasks(String);

#[async_trait]
impl TaskWorkspace for Tasks {
    async fn path(&self) -> Result<String, String> {
        Ok(self.0.clone())
    }
}

/// What is live in the daemon about the sessions: the flags the recording laid on a row before the desktop projected it.
struct Live(Vec<(String, Value)>);

impl ListOverlay for Live {
    fn of(&self, thread: &ThreadId) -> RowOverlay {
        let Some((_, live)) = self.0.iter().find(|(id, _)| id == thread.as_str()) else { return RowOverlay::default() };
        RowOverlay {
            working: live["working"].as_bool(),
            agent_working: live["agentWorking"].as_bool(),
            awaiting_approval: live["awaitingApproval"].as_bool(),
            awaiting_question: live["awaitingQuestion"].as_bool(),
            handed_by: live["handedBy"].as_array().map(|ids| ids.iter().map(|id| id.as_str().expect("agent id").to_owned()).collect()),
        }
    }
}

/// The agent definitions the recording's host listed (the room records name their members by id).
struct Names(HashMap<String, String>);

#[async_trait]
impl MemberNames for Names {
    async fn names(&self) -> HashMap<String, String> {
        self.0.clone()
    }
}

struct Idle;

#[async_trait]
impl RoomRunner for Idle {
    fn is_running(&self, _: &str) -> bool {
        false
    }
    fn stop(&self, _: &str) {}
    async fn start(&self, _: &str, _: Vec<String>) -> Result<(), mixdog_core_rooms::rooms::RoomError> {
        unreachable!("no room speaks while the roster is listed")
    }
    fn cancel_owed_to(&self, _: &str, _: &[String]) {}
}

/// Node's roster row under the protocol's name for the fork source.
fn on_the_wire(row: &Value) -> Value {
    let mut out = row.as_object().expect("roster row").clone();
    if let Some(from) = out.shift_remove("inheritedFromSessionId") {
        out.insert("forkedFromId".into(), from);
    }
    Value::Object(out)
}

/// The migrated directory's index and thread store, as the core opens them.
pub(super) async fn opened(roots: &MigrationRoots) -> (mixdog_store::sqlite::SqliteStore, Arc<StoreThreads>) {
    let tokens = mixdog_rt::testing::tokens();
    let root = roots.data.clone();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let threads = StoreThreads::over_data_dir(&roots.data, index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store");
    (index, Arc::new(threads))
}

/// `thread/list` over the migrated directory: the real store, the real room records and the real room list.
async fn listed(roots: &MigrationRoots, live: Vec<(String, Value)>, answers: &Value) -> Vec<Value> {
    let (index, threads) = opened(roots).await;
    listed_over(roots, index, threads, live, answers).await
}

/// `thread/list` over an opened index; the list follows the thread store's writes.
async fn listed_over(
    roots: &MigrationRoots,
    index: mixdog_store::sqlite::SqliteStore,
    threads: Arc<StoreThreads>,
    live: Vec<(String, Value)>,
    answers: &Value,
) -> Vec<Value> {
    let tokens = mixdog_rt::testing::tokens();
    let (state, _)= mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &roots.data.join("state").join("core.sqlite")).expect("core state");
    let rooms = Arc::new(Rooms::new(StateRoomStore::new(state)));
    let names: HashMap<String, String> =
        answers["agents"].as_array().expect("agents").iter().map(|a| (a["id"].as_str().expect("id").to_owned(), a["label"].as_str().expect("label").to_owned())).collect();
    let room_rows = RoomListRows::new(rooms, Arc::new(Idle), Arc::new(Names(names)));
    let tasks = answers["taskWorkspace"].as_str().expect("task workspace").to_owned();
    let list = ThreadListService::new(Arc::new(index), Arc::new(Live(live)), Arc::new(room_rows), Arc::new(Tasks(tasks)));
    list.fence(threads);
    let answer = value(&list, request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list");
    answer["data"].as_array().expect("data").clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_roster_over_stored_sessions_and_rooms_is_nodes_roster_row_for_row() {
    let (_dir, roots) = migrated().await;
    let answers = answers();
    let got = listed(&roots, Vec::new(), &answers).await;
    let want: Vec<Value> = answers["roster"].as_array().expect("roster").iter().map(on_the_wire).collect();
    assert!(want.iter().any(|row| row["id"] == answers["ids"]["unlistedRoom"]), "the recording holds a room whose log has no row");
    assert!(want.iter().any(|row| row["id"] == answers["ids"]["listedRoom"]), "the recording holds a room whose log is listed");
    let ids = |rows: &[Value]| rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(&got), ids(&want), "the same sessions in the same order");
    // Node lists a legacy json session straight off its file, which leaves the row without `compactCount` (its compaction record
    // is not decoded there: `store-summary-catalog.mjs:272`); the migrated session is a log whose row carries its record's own.
    let legacy = answers["ids"]["old"].as_str().expect("legacy id");
    let record: Value = serde_json::from_slice(&std::fs::read(fixture().join(format!(".mixdog/data/sessions/{legacy}.json"))).expect("the legacy file")).expect("json");
    for (got, want) in got.iter().zip(&want) {
        let mut want = want.clone();
        if want["id"] == legacy {
            assert!(want.get("compactCount").is_none(), "Node's row of the legacy file carries no compactCount");
            want["compactCount"] = record["compaction"]["compactCount"].clone();
        }
        assert_eq!(got, &want, "row of {}", want["id"]);
    }
}

/// The marks the core itself writes list as Node's rows: a deleted bot's home retired (`agent-home-sessions.ts:192-193` archives
/// and retires it through `setArchived`/`setRetired`) and a thread archived, each written through the rooms' session port
/// (`DirectorySessions`, the production `SessionOps`) over the recorded session with the migrated mark taken off first. Node's
/// recorded rows of `ids.home` (retired) and `ids.archived` (archived) are the expectation, whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_archive_and_retire_marks_the_core_writes_list_as_nodes_rows() {
    use mixdog_core_ports::ports::threads::ThreadState;
    use mixdog_core_rooms::rooms::sessions::SessionOps;

    let (_dir, roots) = migrated().await;
    let answers = answers();
    let (index, threads) = opened(&roots).await;
    let rig = mixdog_core_session::session::testing::Rig::new();
    let directory = Arc::new(mixdog_core_session::session::SessionDirectory::new(Arc::new(rig.deps_parts(threads.clone()))));
    let state = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
    let sessions = super::directory_sessions::DirectorySessions::new(directory, state.clone());
    let home = answers["ids"]["home"].as_str().expect("home id");
    let archived = answers["ids"]["archived"].as_str().expect("archived id");
    for (id, mark) in [(home, "retiredAt"), (archived, "archivedAt")] {
        state.patch_header(&ThreadId::from(id), serde_json::Map::new(), vec![mark.to_owned()]).await.expect("the migrated mark taken off");
    }
    assert!(!sessions.is_retired(home).await.expect("is_retired"), "the home is not retired before the deletion");
    sessions.set_retired(home, true).await.expect("retire");
    sessions.set_archived(archived, true).await.expect("archive");
    assert!(sessions.is_retired(home).await.expect("is_retired"), "the home reads as retired after it");
    let got = listed_over(&roots, index, threads, Vec::new(), &answers).await;
    for id in [home, archived] {
        let want = answers["roster"].as_array().expect("roster").iter().find(|row| row["id"] == id).map(on_the_wire).expect("Node's row");
        assert_eq!(got.iter().find(|row| row["id"] == id), Some(&want), "row of {id}");
    }
}

/// The live flags (`working`, `agentWorking`, an approval or question waiting, the bots a thread's work was handed by) laid on a
/// row, as the daemon lays them before the desktop projects the roster.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rows_live_flags_are_nodes() {
    let (_dir, roots) = migrated().await;
    let answers = answers();
    for case in answers["overlays"].as_array().expect("overlays") {
        let id = case["id"].as_str().expect("id").to_owned();
        let got = listed(&roots, vec![(id.clone(), case["live"].clone())], &answers).await;
        let row = got.iter().find(|row| row["id"] == id.as_str()).expect("the row is listed");
        assert_eq!(row, &on_the_wire(&case["row"]), "row of {id} with {}", case["live"]);
    }
}
