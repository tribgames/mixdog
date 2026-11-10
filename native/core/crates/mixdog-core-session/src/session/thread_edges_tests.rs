//! Node's roster after each catalog write of each trigger (`fixtures/thread-edges`, recorded from `b6f10295a`), replayed
//! as the writes of the index: the notifications Rust publishes are the roster's changes, and nothing for a roster Node
//! would not have pushed.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::FeedSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockLimits;
use mixdog_store::sqlite::DirtyMark;
use mixdog_store::sqlite::RowEdge;
use mixdog_store::sqlite::RowSink;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::summary::CatalogHead;
use serde_json::Value;

use super::thread_edges::ThreadEdgePublisher;
use super::thread_list::ThreadListService;

/// Collects the edges the writer reports; the test publishes them after the write's acknowledgement, in order.
#[derive(Default)]
struct Collect(Mutex<Vec<RowEdge>>);
impl RowSink for Collect {
    fn written(&self, edge: RowEdge) {
        self.0.lock().unwrap().push(edge);
    }
}

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/thread-edges/golden.json")).expect("golden json")
}

/// The host's task workspace lookup, answering what Node's lookup answered at the step (`lookup` of the recording): the resolved
/// path, or its failure.
#[derive(Default)]
struct Workspace(Mutex<Option<String>>);
#[async_trait::async_trait]
impl super::TaskWorkspace for Workspace {
    async fn path(&self) -> Result<String, String> {
        self.0.lock().unwrap().clone().ok_or_else(|| "the task workspace could not be resolved".to_owned())
    }
}

struct NoRooms;
#[async_trait::async_trait]
impl super::thread_list::ListRooms for NoRooms {
    async fn with_rooms(&self, rows: Vec<mixdog_protocol::ThreadSummary>) -> Result<Vec<mixdog_protocol::ThreadSummary>, String> {
        Ok(rows)
    }
    async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
        Ok(Vec::new())
    }
}

struct Idle;
impl super::thread_list::ListOverlay for Idle {
    fn of(&self, _: &ThreadId) -> super::thread_list::RowOverlay {
        super::thread_list::RowOverlay::default()
    }
}

/// Node's complete roster row as the protocol's `ThreadSummary`: the same fields under their protocol names
/// (`inheritedFromSessionId` is `forkedFromId`).
fn thread_of_row(row: &Value) -> Value {
    let mut out = row.as_object().expect("roster row").clone();
    if let Some(from) = out.shift_remove("inheritedFromSessionId") {
        out.insert("forkedFromId".into(), from);
    }
    Value::Object(out)
}

/// What Rust must publish for one roster change, in the order Node's roster holds the rows (changed and new rows by roster position,
/// then the rows that left): `(method, params)` with the complete params.
fn changes(before: &[Value], after: &[Value]) -> Vec<(String, Value)> {
    let held = |roster: &[Value], id: &Value| roster.iter().find(|row| row["id"] == *id).cloned();
    let mut out = Vec::new();
    for row in after {
        match held(before, &row["id"]) {
            None => out.push(("thread/started".to_owned(), serde_json::json!({ "thread": thread_of_row(row) }))),
            Some(was) if was != *row => out.push(("thread/summary/updated".to_owned(), serde_json::json!({ "thread": thread_of_row(row) }))),
            Some(_) => {}
        }
    }
    for row in before.iter().filter(|row| held(after, &row["id"]).is_none()) {
        out.push(("thread/deleted".to_owned(), serde_json::json!({ "threadId": row["id"] })));
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_notifications_are_the_changes_of_nodes_roster_for_every_trigger() {
    let golden = golden();
    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let store = Arc::new(
        mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index"),
    );
    let edges = Arc::new(Collect::default());
    store.observe_rows(edges.clone()).expect("sink");

    let limits = MockLimits::default();
    let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
    let app = MockConnection::new(ConnectionId(1), limits);
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
    mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
    // What the subscription itself sent is not part of what the writes announce.
    drop(app.drain_text());
    let section = Arc::new(mixdog_core_base::state::SectionFeedState::new(feed));

    let mut published = 0;
    for trigger in golden["triggers"].as_array().expect("triggers") {
        let name = trigger["name"].as_str().expect("name");
        // A host that has resolved nothing yet, as Node's `canonicalTaskWorkspace` starts.
        let workspace = Arc::new(Workspace::default());
        let list = Arc::new(ThreadListService::new(store.clone(), Arc::new(Idle), Arc::new(NoRooms), workspace.clone()));
        let publisher = ThreadEdgePublisher::new(list.clone(), section.clone(), workspace.clone());
        let mut roster: Vec<Value> = Vec::new();
        let mut seen = String::new();
        for step in trigger["steps"].as_array().expect("steps") {
            let mut header = step["record"].as_object().expect("record").clone();
            header.shift_remove("messages");
            let id = header["id"].as_str().expect("id").to_owned();
            // The lookup of the task workspace Node made for this catalog refresh: its path, or its failure.
            let lookup = &step["lookup"];
            *workspace.0.lock().unwrap() = if lookup["ok"] == true { Some(lookup["path"].as_str().expect("resolved path").to_owned()) } else { None };
            store.upsert(CatalogHead { session: id.clone(), log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
            let written: Vec<RowEdge> = std::mem::take(&mut *edges.0.lock().unwrap());
            for edge in written {
                publisher.publish(edge).await;
            }
            let sent: Vec<(String, Value)> = app
                .drain_text()
                .into_iter()
                .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
                .map(|frame| (frame["method"].as_str().unwrap_or_default().to_owned(), frame["params"].clone()))
                .collect();
            let next = step["roster"].as_array().expect("roster").clone();
            // Node pushes the roster only when its canonical JSON changed; its changes are the notifications, whole and in order.
            let want = if step["published"] == true { changes(&roster, &next) } else { Vec::new() };
            roster = next;
            assert_eq!(sent, want, "{name}: after the write of {id}: {seen}");
            seen.push_str(&format!("{id} "));
            published += want.len();
        }
    }
    assert!(published >= 10, "the replay compared {published} notifications");
    // The lookups that failed after one succeeded, and a host whose lookup never succeeded, are both in the recording.
    let lookups = |trigger: &Value| trigger["steps"].as_array().unwrap().iter().map(|step| step["lookup"]["ok"] == true).collect::<Vec<_>>();
    let all: Vec<Vec<bool>> = golden["triggers"].as_array().unwrap().iter().map(lookups).collect();
    assert!(all.iter().any(|steps| steps.windows(2).any(|pair| pair[0] && !pair[1])), "a lookup that fails after one succeeded");
    assert!(all.iter().any(|steps| steps.iter().all(|ok| !ok)), "a lookup that never succeeds");
}

/// `compactedSessionTitle` on handoffs of every shape, each against Node's answer, and the roster's preview title (compacted first, then
/// generated) that decides whether a row with only a preview is kept.
#[test]
fn the_compacted_title_is_nodes_for_every_handoff_shape() {
    let golden = golden();
    let cases = golden["compacted"].as_array().expect("compacted cases");
    assert!(cases.len() >= 15);
    for case in cases {
        let input = case["input"].as_str().expect("input");
        assert_eq!(mixdog_store::title::compacted_session_title(input), case["title"].as_str().expect("title"), "{input:?}");
    }
    assert!(cases.iter().any(|case| case["title"] == "Recover this task"));
}

/// The roster's own gate (`desktopSessionSummaries`, `desktop-state.ts:144-246`) on list rows: a cwd with a NUL, a project with no
/// path, a conversation that is only a cli-resume, and the rest of the rule, each against what Node kept.
#[test]
fn the_roster_gate_keeps_the_rows_node_kept() {
    let golden = golden();
    let cases = golden["gate"].as_array().expect("gate cases");
    assert!(cases.len() >= 28);
    // The cases that only a user's name, or the task workspace, could move: Node's answers differ with the name, not the folder.
    let kept = |id: &str| cases.iter().find(|case| case["row"]["id"] == id).expect(id)["kept"].as_bool().unwrap();
    assert!(!kept("g_meaningless_title") && kept("g_meaningless_title_renamed") && kept("g_renamed_untitled") && !kept("g_renamed_blank"));
    assert!(kept("g_legacy_in_task_workspace") && kept("g_legacy_outside_task_workspace"));
    assert_eq!(kept("g_legacy_in_task_workspace_untitled"), kept("g_legacy_outside_task_workspace_untitled"));
    for case in cases {
        let row = case["row"].as_object().expect("row");
        let name = case["names"][row["id"].as_str().expect("id")].as_str();
        let workspace = case["taskWorkspace"].as_str().unwrap_or_default();
        assert_eq!(super::thread_edges::roster_row(row, name, workspace), case["kept"], "{}", row["id"]);
    }
}

/// The index, the feed and the edge publisher over one store, with the task workspace lookup answering `workspace` (`None`: it fails).
struct Wired {
    store: Arc<SqliteStore>,
    edges: Arc<super::thread_edges::ThreadEdges>,
    app: MockConnection,
    _data: tempfile::TempDir,
}

async fn wired(workspace: Option<String>) -> Wired {
    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let store = Arc::new(
        mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index"),
    );
    let limits = MockLimits::default();
    let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
    let app = MockConnection::new(ConnectionId(1), limits);
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
    mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
    // What the subscription itself sent is not part of what the writes announce.
    drop(app.drain_text());
    let workspace = Arc::new(Workspace(Mutex::new(workspace)));
    let list = Arc::new(ThreadListService::new(store.clone(), Arc::new(Idle), Arc::new(NoRooms), workspace.clone()));
    let edges = super::thread_edges::ThreadEdges::start(ThreadEdgePublisher::new(list, Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)), workspace));
    store.observe_rows(edges.clone()).expect("sink");
    Wired { store, edges, app, _data: data }
}

/// How long a fence may take before the test calls it hung (a failure bound, not a wait the test relies on).
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// The first write of Node's `schedule` trigger, written through the real index.
async fn write_first_schedule_row(wired: &Wired, step: &Value) -> String {
    let mut header = step["record"].as_object().expect("record").clone();
    header.shift_remove("messages");
    let id = header["id"].as_str().expect("id").to_owned();
    wired.store.upsert(CatalogHead { session: id.clone(), log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
    id
}

fn schedule_step(golden: &Value) -> Value {
    golden["triggers"].as_array().unwrap().iter().find(|t| t["name"] == "schedule").expect("trigger")["steps"][0].clone()
}

/// A room call waits for `settled`: the edges written before it are published when it returns (Node publishes the catalog before
/// `createAgentRoom` answers). What the feed has been sent by then is the whole of Node's recorded notifications for the write
/// (`changes` of the recorded roster), compared whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_returns_after_the_written_rows_are_announced() {
    let golden = golden();
    let step = schedule_step(&golden);
    assert!(step["published"] == true && step["lookup"]["ok"] == true);
    let wired = wired(Some(step["lookup"]["path"].as_str().expect("path").to_owned())).await;
    write_first_schedule_row(&wired, &step).await;
    tokio::time::timeout(DEADLINE, wired.edges.settled()).await.expect("settled answered within the deadline").expect("the rows were announced");
    let sent: Vec<(String, Value)> = wired
        .app
        .drain_text()
        .into_iter()
        .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
        .map(|frame| (frame["method"].as_str().unwrap_or_default().to_owned(), frame["params"].clone()))
        .collect();
    let want = changes(&[], step["roster"].as_array().expect("roster"));
    assert!(!want.is_empty());
    assert_eq!(sent, want, "the feed at the moment settled answered");
}

/// A write whose task workspace lookup fails is held back (Node's refresh rejects and publishes nothing): `settled` says so instead
/// of reporting the rows announced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_says_when_the_written_rows_are_held_back() {
    let golden = golden();
    let wired = wired(None).await;
    write_first_schedule_row(&wired, &schedule_step(&golden)).await;
    let error = tokio::time::timeout(DEADLINE, wired.edges.settled()).await.expect("settled answered within the deadline").expect_err("the rows are held back");
    assert!(error.contains("held back"), "{error}");
    assert!(wired.app.drain_text().is_empty(), "nothing is announced while the lookup fails");
}