//! Node's `session` tool answers replayed whole: `fixtures/session-tool-control/golden.json`
//! (`record-session-tool-control.mjs`) holds, per scenario, the caller's record, the call, the
//! catalog, archived flags, live work and transcripts Node read, and the text Node answered (or
//! the error it threw). The real `SessionTool` over the real `DirectorySessionPort` reads the same
//! data through the port's seams and must answer the same text, byte for byte, in recorded order.

use mixdog_app_protocol::v2::thread::ThreadItemsListResponse;
use mixdog_store::sqlite::lead::activity_of;
use mixdog_store::sqlite::lead::decode_catalog_cursor;
use mixdog_store::sqlite::lead::encode_catalog_cursor;
use mixdog_tools::orch::session::SessionTool;

use super::super::session_control::ListedRow;
use super::super::session_control::ListingPage;
use super::super::session_control::LiveSources;
use super::super::session_control::SessionListing;
use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/session-tool-control/golden.json")).expect("golden")
}

/// The scenario's catalog, in the order the store lists it.
#[derive(Default)]
pub(super) struct Fixture {
    rows: Vec<ListedRow>,
    live: LiveSources,
}

impl Fixture {
    fn of(scenario: &Value) -> Self {
        let archived = scenario["archived"].as_object().expect("archived");
        let rows = scenario["catalog"]
            .as_array()
            .expect("catalog")
            .iter()
            .map(|row| ListedRow { row: row.as_object().expect("row").clone(), archived: archived.contains_key(row["id"].as_str().expect("id")) })
            .collect();
        let ids = |key: &str| scenario["live"][key].as_array().expect("ids").iter().map(|id| id.as_str().expect("id").to_owned()).collect();
        let live = LiveSources {
            working: ids("working"),
            agent_working: ids("agentWorking"),
            pool: scenario["live"]["pool"].as_array().expect("pool").clone(),
            now: scenario["live"]["now"].as_i64().expect("now"),
        };
        Self { rows, live }
    }
}

#[async_trait]
impl SessionListing for Fixture {
    async fn page(&self, limit: usize, cursor: Option<&str>) -> Result<ListingPage, String> {
        let after = decode_catalog_cursor(cursor).map_err(|error| error.to_string())?;
        let rest: Vec<&ListedRow> = self
            .rows
            .iter()
            .filter(|listed| {
                after.as_ref().is_none_or(|after| {
                    let activity = activity_of(&listed.row);
                    let id = listed.row["id"].as_str().expect("id");
                    activity < after.activity || (activity == after.activity && id > after.id.as_str())
                })
            })
            .collect();
        let rows: Vec<ListedRow> = rest.iter().take(limit).map(|listed| (*listed).clone()).collect();
        let next_cursor = (rest.len() > rows.len()).then(|| rows.last().map(|last| encode_catalog_cursor(&last.row))).flatten();
        Ok(ListingPage { rows, next_cursor })
    }

    async fn row(&self, id: &str) -> Result<Option<ListedRow>, String> {
        Ok(self.rows.iter().find(|listed| listed.row["id"] == id).cloned())
    }

    async fn live_sources(&self) -> Result<LiveSources, String> {
        Ok(self.live.clone())
    }
}

/// The scenario's transcripts as the session directory's items (each Node row through the
/// store's own row conversion), answered newest first in pages as `thread/items/list` does.
struct Transcripts(Map<String, Value>);

#[async_trait]
impl ThreadRequests for Transcripts {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        assert_eq!(method, "thread/items/list");
        assert_eq!(params["sortDirection"], "desc");
        let items: Vec<mixdog_protocol::ThreadItem> = self.0[thread.as_str()]
            .as_array()
            .expect("transcript")
            .iter()
            .map(|row| mixdog_core_session::session::live_end(row.as_object().expect("row").clone(), "turn_1"))
            .collect();
        let end = match params.get("cursor").and_then(Value::as_str) {
            Some(cursor) => items.iter().position(|item| item.id().as_str() == cursor).expect("cursor row"),
            None => items.len(),
        };
        let start = end.saturating_sub(params["limit"].as_u64().expect("limit") as usize);
        let data = items[start..end].to_vec();
        let has_older = start > 0;
        let next_cursor = has_older.then(|| data[0].id().as_str().to_owned());
        Ok(serde_json::to_value(ThreadItemsListResponse { data, has_older, has_newer: end < items.len(), next_cursor, backwards_cursor: None }).expect("page"))
    }

    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        unreachable!("list and read never interrupt")
    }
}

/// The real `SessionTool` over the real port, for `caller` and the sessions `known`, reading the
/// catalog from `listing` and transcripts through `requests`.
fn session_tool(caller: Map<String, Value>, known: &[String], bots: &[&'static str], listing: Arc<dyn SessionListing>, requests: Arc<dyn ThreadRequests>) -> SessionTool {
    let threads = Arc::new(Threads::default());
    threads.0.lock().expect("threads").insert(caller["id"].as_str().expect("caller id").to_owned(), caller);
    for id in known {
        threads.0.lock().expect("threads").entry(id.clone()).or_insert_with(|| Map::from_iter([("id".to_owned(), json!(id))]));
    }
    let callers = || Arc::new(ThreadCallers::new(threads.clone(), HeartbeatSessions::new(), UnattendedRunRegistry::new(Arc::new(NoStamps))));
    let port = DirectorySessionPort::new(SessionPortParts {
        callers: callers(),
        threads: threads.clone(),
        requests,
        titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
        ai_titles: Arc::new(Titles(true)),
        projects: Arc::new(NoProjects),
        bots: Arc::new(Bots(bots.to_vec())),
        suggestions: Arc::new(Suggested::default()),
        listing,
        io: mixdog_rt::testing::tokens().interactive_io,
    });
    SessionTool::new(Arc::new(port), callers())
}

async fn call(tool: &SessionTool, caller: &str, args: Value) -> (bool, String) {
    let ctx = ToolContext { thread_id: ThreadId::from(caller), tool: "session".into(), ..ctx() };
    match tool.call(&ctx, args).await {
        Ok(out) => match &out.parts[..] {
            [ToolPart::Text(text)] => (true, text.clone()),
            other => panic!("{other:?}"),
        },
        Err(error) => (false, error.message_for_model),
    }
}

async fn answer(scenario: &Value, bots: &[&'static str]) -> (bool, String) {
    let caller = scenario["caller"].as_object().expect("caller").clone();
    let caller_id = caller["id"].as_str().expect("caller id").to_owned();
    let transcripts = scenario["transcripts"].as_object().expect("transcripts").clone();
    let known: Vec<String> = transcripts.keys().cloned().collect();
    let tool = session_tool(caller, &known, bots, Arc::new(Fixture::of(scenario)), Arc::new(Transcripts(transcripts)));
    call(&tool, &caller_id, scenario["args"].clone()).await
}

async fn replay(prefix: &str) {
    let golden = golden();
    let bots: Vec<&'static str> = golden["bots"].as_array().expect("bots").iter().map(|b| &*b["id"].as_str().expect("bot id").to_owned().leak()).collect();
    let mut replayed = 0;
    for scenario in golden["scenarios"].as_array().expect("scenarios").iter().filter(|s| s["name"].as_str().expect("name").starts_with(prefix)) {
        let name = scenario["name"].as_str().expect("name");
        let (ok, text) = answer(scenario, &bots).await;
        assert_eq!((ok, text.as_str()), (scenario["expected"]["ok"].as_bool().expect("ok"), scenario["expected"]["text"].as_str().expect("text")), "{name}");
        replayed += 1;
    }
    assert!(replayed > 0, "no {prefix} scenario recorded");
}

#[tokio::test]
async fn session_list_answers_as_node() {
    replay("list-").await;
}

#[tokio::test]
async fn session_read_answers_as_node() {
    replay("read-").await;
}

fn lead_caller() -> Map<String, Value> {
    Map::from_iter([("id".to_owned(), json!("sess_lead1")), ("sourceType".to_owned(), json!("lead"))])
}

/// A list that arrives before the catalog is bound answers what Node answers without a session
/// service, and the read beside it is unaffected (it never reads the catalog).
#[tokio::test]
async fn a_list_before_the_catalog_is_bound_answers_without_a_session_service() {
    let transcripts = golden()["scenarios"][0]["transcripts"].as_object().expect("transcripts").clone();
    let known: Vec<String> = transcripts.keys().cloned().collect();
    let tool = session_tool(lead_caller(), &known, &[], Arc::new(super::super::session_control::LateListing::default()), Arc::new(Transcripts(transcripts)));
    assert_eq!(call(&tool, "sess_lead1", json!({ "action": "list" })).await, (false, "session: session service is unavailable".to_owned()));
    let (ok, text) = call(&tool, "sess_lead1", json!({ "action": "read", "session_id": "sess_home_ann" })).await;
    assert!(ok, "{text}");
}

/// A session of `rows` assistant rows, paged newest first as `thread/items/list` pages; counts
/// the rows it hands out, and holds its first page until `release` is notified.
struct LongSession {
    rows: usize,
    served: std::sync::atomic::AtomicUsize,
    release: tokio::sync::Notify,
}

#[async_trait]
impl ThreadRequests for LongSession {
    async fn request(&self, _: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        assert_eq!(method, "thread/items/list");
        if params.get("cursor").is_none() {
            self.release.notified().await;
        }
        let end = params.get("cursor").and_then(Value::as_str).map_or(self.rows, |cursor| cursor[1..].parse().expect("cursor row"));
        let start = end.saturating_sub(params["limit"].as_u64().expect("limit") as usize);
        let data: Vec<mixdog_protocol::ThreadItem> = (start..end)
            .map(|i| mixdog_core_session::session::live_end(Map::from_iter([("kind".to_owned(), json!("assistant")), ("id".to_owned(), json!(format!("r{i}"))), ("text".to_owned(), json!(format!("row {i}")))]), "turn_1"))
            .collect();
        self.served.fetch_add(data.len(), std::sync::atomic::Ordering::SeqCst);
        let next_cursor = (start > 0).then(|| format!("r{start}"));
        Ok(serde_json::to_value(ThreadItemsListResponse { data, has_older: start > 0, has_newer: end < self.rows, next_cursor, backwards_cursor: None }).expect("page"))
    }

    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        unreachable!("a read never interrupts")
    }
}

/// A read of a very long session asks for its window only (the rows it shows and one more to
/// know older ones exist), never the whole log; and while that read waits on the session, a list
/// through the same tool completes: the port holds nothing across the read that other calls need.
#[tokio::test]
async fn a_read_of_a_long_session_pages_its_window_and_holds_nothing_other_calls_wait_on() {
    let long = Arc::new(LongSession { rows: 1_000_000, served: Default::default(), release: tokio::sync::Notify::new() });
    let scenario = golden()["scenarios"][0].clone();
    let tool = session_tool(lead_caller(), &["sess_long".to_owned()], &[], Arc::new(Fixture::of(&scenario)), long.clone());
    let read = call(&tool, "sess_lead1", json!({ "action": "read", "session_id": "sess_long", "offset": 40, "limit": 10 }));
    let list_then_release = async {
        let listed = call(&tool, "sess_lead1", json!({ "action": "list", "limit": 1 })).await;
        long.release.notify_one();
        listed
    };
    let ((read_ok, read_text), (list_ok, _)) = tokio::time::timeout(std::time::Duration::from_secs(10), async { tokio::join!(read, list_then_release) })
        .await
        .expect("the list completed while the read waited");
    assert!(read_ok && list_ok, "{read_text}");
    let read: Value = serde_json::from_str(&read_text).expect("read json");
    assert_eq!((read["items"][0]["id"].clone(), read["items"][0]["offset"].clone()), (json!("r999950"), json!(49)));
    assert_eq!(long.served.load(std::sync::atomic::Ordering::SeqCst), 51);
}
