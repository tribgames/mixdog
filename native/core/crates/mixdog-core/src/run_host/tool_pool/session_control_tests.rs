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
use super::super::session_control::LiveWork;
use super::super::session_control::SessionListing;
use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/session-tool-control/golden.json")).expect("golden")
}

/// The scenario's catalog, in the order the store lists it.
#[derive(Default)]
pub(super) struct Fixture {
    rows: Vec<ListedRow>,
    live: LiveWork,
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
        let live = LiveWork {
            own: scenario["live"]["own"].as_array().expect("own").iter().map(|e| (e[0].as_str().expect("id").to_owned(), e[1].as_i64().expect("at"))).collect(),
            agents: scenario["live"]["agents"].as_array().expect("agents").iter().map(|id| id.as_str().expect("id").to_owned()).collect(),
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

    fn live(&self) -> LiveWork {
        self.live.clone()
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

async fn answer(scenario: &Value, bots: &[&'static str]) -> (bool, String) {
    let caller = scenario["caller"].as_object().expect("caller").clone();
    let caller_id = caller["id"].as_str().expect("caller id").to_owned();
    let threads = Arc::new(Threads::default());
    threads.0.lock().expect("threads").insert(caller_id.clone(), caller);
    let transcripts = scenario["transcripts"].as_object().expect("transcripts").clone();
    for id in transcripts.keys() {
        threads.0.lock().expect("threads").entry(id.clone()).or_insert_with(|| Map::from_iter([("id".to_owned(), json!(id))]));
    }
    let callers = || Arc::new(ThreadCallers::new(threads.clone(), HeartbeatSessions::new(), UnattendedRunRegistry::new(Arc::new(NoStamps))));
    let port = DirectorySessionPort::new(SessionPortParts {
        callers: callers(),
        threads: threads.clone(),
        requests: Arc::new(Transcripts(transcripts)),
        titles: Arc::new(mixdog_core_session::session::session_title::StoredTitles::new(threads.clone(), Arc::new(Messages), Arc::new(Now))),
        ai_titles: Arc::new(Titles(true)),
        projects: Arc::new(NoProjects),
        bots: Arc::new(Bots(bots.to_vec())),
        suggestions: Arc::new(Suggested::default()),
        listing: Arc::new(Fixture::of(scenario)),
        io: mixdog_rt::testing::tokens().interactive_io,
    });
    let tool = SessionTool::new(Arc::new(port), callers());
    let ctx = ToolContext { thread_id: ThreadId::from(caller_id.as_str()), tool: "session".into(), ..ctx() };
    match tool.call(&ctx, scenario["args"].clone()).await {
        Ok(out) => match &out.parts[..] {
            [ToolPart::Text(text)] => (true, text.clone()),
            other => panic!("{other:?}"),
        },
        Err(error) => (false, error.message_for_model),
    }
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
