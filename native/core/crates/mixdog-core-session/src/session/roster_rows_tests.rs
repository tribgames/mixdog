//! The roster over sessions the b6f10295a product itself wrote (`benchmarks/rust-core/recorders/record-roster-rows.mjs` ->
//! `fixtures/roster-rows`): Node's own session code made the data directory (a plain session, a compacted one, a legacy record,
//! an archived, a favorite, a read one, an agent's worker session, a deleted agent's home, forks, a stray and a worktree session)
//! and the desktop's own metadata the profile; the desktop's roster projection answered over them (`answers.json`). The core
//! migrates the profile into the stored sessions, opens the directory through its real store and lists it: every row it answers is
//! Node's row, whole, under the protocol's one rename (`inheritedFromSessionId` is `forkedFromId`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use serde_json::Value;
use serde_json::json;

use super::recorded_145_tests::Idle;
use super::recorded_145_tests::NoDocuments;
use super::recorded_145_tests::NoRooms;
use super::recorded_145_tests::StoreProjector;
use super::recorded_145_tests::threads_over;
use super::thread_list::LIST;
use super::thread_list::ListOverlay;
use super::thread_list::RowOverlay;
use super::thread_list::ThreadListService;

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
    let dir = tempfile::tempdir().expect("scratch dir");
    let home = dir.path().join(".mixdog");
    copy_tree(&fixture().join(".mixdog"), &home);
    let profile = dir.path().join("profile");
    copy_tree(&fixture().join("profile"), &profile);
    let roots = MigrationRoots { data: home.join("data"), home, profile: Some(profile) };
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("the migration of the recorded data completes");
    (dir, roots)
}

/// The task workspace the recording's host had.
struct Tasks(String);

#[async_trait::async_trait]
impl super::TaskWorkspace for Tasks {
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

/// Node's roster row under the protocol's name for the fork source.
fn on_the_wire(row: &Value) -> Value {
    let mut out = row.as_object().expect("roster row").clone();
    if let Some(from) = out.shift_remove("inheritedFromSessionId") {
        out.insert("forkedFromId".into(), from);
    }
    Value::Object(out)
}

async fn listed(roots: &MigrationRoots, live: Vec<(String, Value)>, tasks: &str) -> Vec<Value> {
    let threads = threads_over(&roots.data).await;
    let list = ThreadListService::new(Arc::new(threads.index().clone()), Arc::new(Live(live)), Arc::new(NoRooms), Arc::new(Tasks(tasks.to_owned())));
    let answer = value(&list, request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list");
    answer["data"].as_array().expect("data").clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_roster_over_stored_sessions_is_nodes_roster_row_for_row() {
    let (_dir, roots) = migrated().await;
    let answers = answers();
    let got = listed(&roots, Vec::new(), answers["taskWorkspace"].as_str().expect("task workspace")).await;
    let want: Vec<Value> = answers["roster"].as_array().expect("roster").iter().map(on_the_wire).collect();
    let ids = |rows: &[Value]| rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(&got), ids(&want), "the same sessions in the same order");
    for (got, want) in got.iter().zip(&want) {
        assert_eq!(got, want, "row of {}", want["id"]);
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
        let got = listed(&roots, vec![(id.clone(), case["live"].clone())], answers["taskWorkspace"].as_str().expect("task workspace")).await;
        let row = got.iter().find(|row| row["id"] == id.as_str()).expect("the row is listed");
        assert_eq!(row, &on_the_wire(&case["row"]), "row of {id} with {}", case["live"]);
    }
}
