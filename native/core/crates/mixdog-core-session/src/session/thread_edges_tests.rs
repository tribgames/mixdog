//! Node's roster after each catalog write of each trigger (`fixtures/thread-edges`, recorded from `b6f10295a`), replayed
//! as the writes of the index: the notifications Rust publishes are the roster's changes, and nothing for a roster Node
//! would not have pushed.

use std::collections::BTreeMap;
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

/// `started` / `updated` / `deleted` and the thread, with the row the notification carries.
fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Vec<(String, String, Option<Value>)> {
    let mut out = Vec::new();
    for (id, row) in after {
        match before.get(id) {
            None => out.push(("thread/started".to_owned(), id.clone(), Some(row.clone()))),
            Some(was) if was != row => out.push(("thread/summary/updated".to_owned(), id.clone(), Some(row.clone()))),
            Some(_) => {}
        }
    }
    for id in before.keys().filter(|id| !after.contains_key(*id)) {
        out.push(("thread/deleted".to_owned(), id.clone(), None));
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
    let list = Arc::new(ThreadListService::new(store.clone(), Arc::new(Idle), Arc::new(NoRooms)));
    let publisher = ThreadEdgePublisher::new(list, Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)));

    let mut published = 0;
    for trigger in golden["triggers"].as_array().expect("triggers") {
        let name = trigger["name"].as_str().expect("name");
        let mut roster: BTreeMap<String, Value> = BTreeMap::new();
        let mut seen = String::new();
        for step in trigger["steps"].as_array().expect("steps") {
            let mut header = step["record"].as_object().expect("record").clone();
            header.shift_remove("messages");
            let id = header["id"].as_str().expect("id").to_owned();
            store.upsert(CatalogHead { session: id.clone(), log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
            let written: Vec<RowEdge> = std::mem::take(&mut *edges.0.lock().unwrap());
            for edge in written {
                publisher.publish(edge).await;
            }
            let sent: Vec<Value> = app
                .drain_text()
                .into_iter()
                .filter(|text| text.contains("thread/"))
                .map(|text| serde_json::from_str(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
                .collect();
            let next: BTreeMap<String, Value> = step["roster"].as_array().expect("roster").iter().map(|row| (row["id"].as_str().expect("id").to_owned(), row.clone())).collect();
            // Node pushes the roster only when it changed; its changes are the notifications.
            let want = if step["published"] == true { changes(&roster, &next) } else { Vec::new() };
            roster = next;
            let got: Vec<(String, String)> = sent.iter().map(|frame| (frame["method"].as_str().unwrap_or_default().to_owned(), thread_of(frame))).collect();
            let mut want_kinds: Vec<(String, String)> = want.iter().map(|(method, id, _)| (method.clone(), id.clone())).collect();
            want_kinds.sort();
            let mut got_sorted = got.clone();
            got_sorted.sort();
            assert_eq!(got_sorted, want_kinds, "{name}: after the write of {id}: {seen}");
            seen.push_str(&format!("{id} "));
            for (method, id, node) in &want {
                let Some(node) = node else { continue };
                let frame = sent.iter().find(|f| f["method"] == *method && thread_of(f) == *id).expect("sent");
                let row = &frame["params"]["thread"];
                for field in ["title", "updatedAt", "preview", "messageCount", "cwd"] {
                    assert_eq!(row[field], node[field], "{name}: {method} {id}: {field}");
                }
                published += 1;
            }
        }
    }
    assert!(published >= 10, "the replay compared {published} rows");
}

fn thread_of(frame: &Value) -> String {
    let params = &frame["params"];
    params["thread"]["id"].as_str().or_else(|| params["threadId"].as_str()).unwrap_or_default().to_owned()
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
        assert_eq!(super::thread_edges::roster_row(row, name), case["kept"], "{}", row["id"]);
    }
}
