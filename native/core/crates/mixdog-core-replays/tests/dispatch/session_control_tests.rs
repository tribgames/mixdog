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

use mixdog_core::run_host::tool_pool::session_bots::BotSources;
use mixdog_core::run_host::tool_pool::session_bots::LateBotSources;
use mixdog_core::run_host::tool_pool::session_control::ListedRow;
use mixdog_core::run_host::tool_pool::session_control::ListingPage;
use mixdog_core::run_host::tool_pool::session_control::LiveSources;
use mixdog_core::run_host::tool_pool::session_control::SessionListing;
use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-tool-control/golden.json")).expect("golden")
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

/// What bot status reads besides the catalog, as Node's recorder stood it in (the scenario's
/// `bots`): the bots, watches, held requests and routines (or the automation store's failure)
/// as given, the approval cards of `approvals`, Mixy's name and the clock.
struct BotRecords(Value);

#[async_trait]
impl BotSources for BotRecords {
    async fn bots(&self) -> Result<Vec<Value>, String> {
        Ok(self.0["list"].as_array().expect("bots").clone())
    }
    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        Ok(self.0["watches"].as_array().expect("watches").clone())
    }
    async fn held(&self) -> Result<Vec<Value>, String> {
        Ok(self.0["held"].as_array().expect("held").clone())
    }
    async fn routines(&self) -> Result<Vec<Value>, String> {
        match self.0["routinesError"].as_str() {
            Some(error) => Err(error.to_owned()),
            None => Ok(self.0["routines"].as_array().expect("routines").clone()),
        }
    }
    async fn mixy_name(&self) -> Result<String, String> {
        Ok(self.0["mixy"].as_str().expect("mixy").to_owned())
    }
    fn awaiting_approval(&self, session_id: &str) -> bool {
        self.0["approvals"].as_array().expect("approvals").iter().any(|id| id == session_id)
    }
    fn now_ms(&self) -> i64 {
        self.0["now"].as_i64().expect("now")
    }
}

/// The scenario's transcripts as the session directory's items (each Node row through the
/// store's own row conversion), answered newest first in pages as `thread/items/list` does.
/// The compactions scheduled through it are kept, in order (`pendingCompactSessionIds`).
struct Transcripts(Map<String, Value>, Mutex<Vec<String>>);

#[async_trait]
impl ThreadRequests for Transcripts {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        if method == "thread/compact/schedule" {
            self.1.lock().expect("scheduled").push(thread.as_str().to_owned());
            return Ok(json!({}));
        }
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

    fn compact_after_turn(&self, _: &ThreadId) -> Result<(), CoreError> {
        unreachable!("the session tool schedules a compaction through `thread/compact/schedule`")
    }

    async fn transcript(&self, _: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, CoreError> {
        unreachable!("the session tool reads transcripts through `thread/items/list`")
    }

    async fn submit(&self, _: &ThreadId, _: &Value, _: &str, _: u32, _: &[String], _: Option<&str>) -> Result<bool, CoreError> {
        unreachable!("the session tool sends through the send world")
    }

    async fn start(&self, _: Value) -> Result<Value, CoreError> {
        unreachable!("the session tool creates through the send world")
    }

    fn turn_state(&self, _: &ThreadId) -> (u32, Vec<String>) {
        unreachable!("the session tool reads a turn's chain through the send world")
    }

    async fn set_caller_cwd(&self, _: &ThreadId, _: &str) -> Result<String, CoreError> {
        unreachable!("these scenarios make no `session set-project` call")
    }

    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        unreachable!("list and read never interrupt")
    }
}

/// The real `SessionTool` over the real port, for `caller` and the sessions `known`, reading the
/// catalog from `listing` and transcripts through `requests`.
fn session_tool(caller: Map<String, Value>, known: &[String], bots: &[&'static str], listing: Arc<dyn SessionListing>, requests: Arc<dyn ThreadRequests>, bot_sources: Arc<dyn BotSources>) -> SessionTool {
    let threads = Arc::new(Threads::default());
    threads.0.lock().expect("threads").insert(caller["id"].as_str().expect("caller id").to_owned(), caller);
    for id in known {
        threads.0.lock().expect("threads").entry(id.clone()).or_insert_with(|| Map::from_iter([("id".to_owned(), json!(id))]));
    }
    tool_over(threads, bots, listing, requests, Arc::default(), bot_sources)
}

/// The real `SessionTool` over the real port, its threads read and patched through `threads`.
fn tool_over(
    threads: Arc<dyn ThreadState>,
    bots: &[&'static str],
    listing: Arc<dyn SessionListing>,
    requests: Arc<dyn ThreadRequests>,
    send: Arc<mixdog_core::run_host::tool_pool::session_send::LateSend>,
    bot_sources: Arc<dyn BotSources>,
) -> SessionTool {
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
        catalog: Arc::new(NoCatalog),
        world: Arc::new(NoBotWorld),
        quota: mixdog_core_session::session::testing::Rig::new().quota.clone(),
        clock: Arc::new(Now),
        listing,
        send,
        bot_sources,
        io: mixdog_rt::testing::tokens().interactive_io,
    });
    SessionTool::new(Arc::new(port), callers())
}

async fn call(tool: &SessionTool, caller: &str, args: Value) -> (bool, String) {
    call_on(tool, caller, SurfaceKind::Lead, args).await
}

async fn call_on(tool: &SessionTool, caller: &str, surface: SurfaceKind, args: Value) -> (bool, String) {
    let ctx = ToolContext { thread_id: ThreadId::from(caller), tool: "session".into(), surface, ..ctx() };
    match tool.call(&ctx, args).await {
        Ok(out) => match &out.parts[..] {
            [ToolPart::Text(text)] => (true, text.clone()),
            other => panic!("{other:?}"),
        },
        Err(error) => (false, error.message_for_model),
    }
}

/// The scenario's answer and the compactions it left scheduled. Without a session service
/// (`noService`) the catalog is the unbound `LateListing`; a caller other than the record
/// (`callerSessionId`) is a worker of the Lead's runtime.
async fn answer(scenario: &Value, bots: &[&'static str]) -> (bool, String, Vec<String>) {
    let caller = scenario["caller"].as_object().expect("caller").clone();
    let caller_id = scenario["callerSessionId"].as_str().unwrap_or_else(|| caller["id"].as_str().expect("caller id")).to_owned();
    let surface = if scenario["callerSessionId"].is_string() { SurfaceKind::Agent } else { SurfaceKind::Lead };
    let transcripts = scenario["transcripts"].as_object().expect("transcripts").clone();
    let known: Vec<String> = transcripts.keys().cloned().collect();
    let listing: Arc<dyn SessionListing> = if scenario["noService"] == true { Arc::new(mixdog_core::run_host::tool_pool::session_control::LateListing::default()) } else { Arc::new(Fixture::of(scenario)) };
    let requests = Arc::new(Transcripts(transcripts, Mutex::default()));
    let bot_sources: Arc<dyn BotSources> = match scenario.get("bots") {
        Some(data) => Arc::new(BotRecords(data.clone())),
        None => Arc::new(LateBotSources::default()),
    };
    let tool = session_tool(caller, &known, bots, listing, requests.clone(), bot_sources);
    let (ok, text) = call_on(&tool, &caller_id, surface, scenario["args"].clone()).await;
    let scheduled = requests.1.lock().expect("scheduled").clone();
    (ok, text, scheduled)
}

async fn replay(prefix: &str) {
    let golden = golden();
    let bots: Vec<&'static str> = golden["bots"].as_array().expect("bots").iter().map(|b| &*b["id"].as_str().expect("bot id").to_owned().leak()).collect();
    let mut replayed = 0;
    for scenario in golden["scenarios"].as_array().expect("scenarios").iter().filter(|s| s["name"].as_str().expect("name").starts_with(prefix)) {
        let name = scenario["name"].as_str().expect("name");
        let (ok, text, scheduled) = answer(scenario, &bots).await;
        let expected = &scenario["expected"];
        assert_eq!((ok, text.as_str()), (expected["ok"].as_bool().expect("ok"), expected["text"].as_str().expect("text")), "{name}");
        assert_eq!(json!(scheduled), expected["pendingCompact"], "{name}: the compactions left scheduled");
        replayed += 1;
    }
    assert!(replayed > 0, "no {prefix} scenario recorded");
}

#[tokio::test]
async fn session_compact_answers_as_node() {
    replay("compact-").await;
}

/// `session action=fork` over the real session directory: the caller's session holds the scenario's conversation, the
/// heir's compaction budget is known (Node's route has a window) and its fit is not measured (Node's conversation fits),
/// and the compactor answers the scenario's rows or fails. The answer is Node's, byte for byte, with the heir's minted id
/// in place of the one Node minted; the heir holds the conversation Node's heir holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_fork_answers_as_node() {
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_core_session::session::thread_state::SessionThreads;
    let golden = golden();
    let mut replayed = 0;
    for scenario in golden["scenarios"].as_array().expect("scenarios").iter().filter(|s| s["name"].as_str().expect("name").starts_with("fork-")) {
        let name = scenario["name"].as_str().expect("name");
        let rig = Rig::new();
        // The catalog lists the sessions (a delete removes only a listed one, `isAvailableSession`).
        rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let caller = &scenario["caller"];
        let source = ThreadId::from(caller["id"].as_str().expect("caller id"));
        let header = json!({ "cwd": "/ws", "provider": "fork-model", "model": "fake-model", "title": "Source title", "sourceType": caller["sourceType"] });
        directory.create_with_id(source.clone(), header.as_object().cloned().expect("header"), json!({})).await.expect("create the source");
        let conversation = scenario["fork"]["conversation"].clone();
        if conversation.as_array().is_some_and(|rows| !rows.is_empty()) {
            ThreadRequests::request(&*directory, &source, "thread/inheritedRows/append", json!({ "messages": conversation })).await.expect("the conversation");
        }
        *rig.inherit.budget.lock().expect("budget") = Some(100_000);
        let compactor = &scenario["fork"]["compactor"];
        if compactor["throws"].is_string() {
            rig.compaction.heir_fails.store(true, std::sync::atomic::Ordering::SeqCst);
        } else {
            *rig.compaction.heir_rows.lock().expect("rows") = Some(compactor["rows"].as_array().expect("rows").clone());
        }
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let tool = tool_over(threads, &[], Arc::new(Fixture::default()), directory.clone(), Arc::default(), Arc::new(LateBotSources::default()));
        let caller_id = scenario["callerSessionId"].as_str().unwrap_or(source.as_str()).to_owned();
        let surface = if scenario["callerSessionId"].is_string() { SurfaceKind::Agent } else { SurfaceKind::Lead };
        let (ok, mut text) = call_on(&tool, &caller_id, surface, scenario["args"].clone()).await;
        let expected = &scenario["expected"];
        if let Some(heir) = expected.get("heir") {
            let minted: Value = serde_json::from_str(&text).unwrap_or_else(|_| panic!("{name}: {text}"));
            let minted = minted["sessionId"].as_str().expect("the heir's id").to_owned();
            assert_ne!(minted, source.as_str(), "{name}: the heir is a new session");
            let rows = ThreadRequests::request(&*directory, &ThreadId::from(minted.as_str()), "thread/messages/read", json!({ "threadId": minted })).await.expect("the heir's rows");
            let held: Vec<Value> = rows["messages"].as_array().expect("messages").iter().filter(|m| m["role"] != "system").map(|m| json!({ "role": m["role"], "content": m["content"] })).collect();
            assert_eq!(json!(held), heir["conversation"], "{name}: what the heir holds");
            text = text.replace(&minted, heir["id"].as_str().expect("heir id"));
        }
        assert_eq!((ok, text.as_str()), (expected["ok"].as_bool().expect("ok"), expected["text"].as_str().expect("text")), "{name}");
        // A refused fork leaves no session behind: Node persists the cold heir only after its carry (the core's heir exists while it is
        // measured, marked as being copied, and goes with the refusal).
        if !ok {
            assert_eq!(directory.loaded_ids(), [source.clone()], "{name}: a refused fork leaves only the source");
        }
        replayed += 1;
    }
    assert!(replayed > 0, "no fork- scenario recorded");
}

// --- send -------------------------------------------------------------------------------------------

/// `atask_<uuid>`, a send's minted id, as the recording names it: `atask_<send>`.
fn masked(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("atask_") {
        let (head, tail) = rest.split_at(at + "atask_".len());
        out.push_str(head);
        let uuid = tail.get(..36).filter(|id| id.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }));
        match uuid {
            Some(id) => {
                out.push_str("<send>");
                rest = &tail[id.len()..];
            }
            None => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

fn masked_value(value: &Value) -> Value {
    serde_json::from_str(&masked(&value.to_string())).expect("json")
}

/// The bot's home and the durable watches (`watches`, `deliver`), keeping what they are given as
/// Node's recorder keeps it; a scenario's `send.watch` makes the watch store refuse. Woken on each
/// report and each dropped record of work.
#[derive(Default)]
struct HomeRecords {
    refuse: Option<mixdog_services::bots::delivery::queue::WatchError>,
    watches: Mutex<Vec<Value>>,
    unwatched: Mutex<Vec<Value>>,
    owned: Mutex<Vec<Value>>,
    disowned: Mutex<Vec<Value>>,
    delivered: Mutex<Vec<(String, String)>>,
    settled: tokio::sync::Notify,
}

/// A process token and time as the recording names them.
fn stamped(mut record: Value) -> Value {
    record["owner"] = json!("<process>");
    record["at"] = json!("<now>");
    masked_value(&record)
}

#[async_trait]
impl mixdog_services::task_reports::host::HomeQueue for HomeRecords {
    async fn enqueue_task(&self, agent_id: &str, report: &mixdog_services::bots::delivery::home::TaskReport) -> Result<(), String> {
        self.delivered.lock().expect("delivered").push((agent_id.to_owned(), masked(&format!("{report:?}"))));
        self.settled.notify_one();
        Ok(())
    }
    async fn disown(&self, _: &str) -> Result<(), String> {
        unreachable!("only a re-attached watch disowns one run")
    }
    async fn watches(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn owned(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn watch(&self, watch: Value) -> Result<(), mixdog_services::bots::delivery::queue::WatchError> {
        if let Some(refused) = &self.refuse {
            return Err(refused.clone());
        }
        self.watches.lock().expect("watches").push(stamped(watch));
        Ok(())
    }
    async fn unwatch(&self, run_id: &str) -> Result<(), String> {
        self.unwatched.lock().expect("unwatched").push(json!(masked(run_id)));
        Ok(())
    }
    async fn own(&self, work: Value) -> Result<(), String> {
        self.owned.lock().expect("owned").push(stamped(work));
        Ok(())
    }
    async fn disown_all(&self, run_ids: Vec<String>) -> Result<(), String> {
        self.disowned.lock().expect("disowned").push(masked_value(&json!(run_ids)));
        self.settled.notify_one();
        Ok(())
    }
    /// Node's recorder keeps no watch follows (`follow: async () => {}`).
    async fn follow(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Node's recorder: no agent work is pending for a task session.
struct NothingPending;

#[async_trait]
impl mixdog_services::task_reports::host::AgentRegistry for NothingPending {
    async fn owed_results(&self, _: &str) -> Vec<mixdog_services::task_reports::chain::Owed> {
        Vec::new()
    }
    fn in_flight(&self) -> mixdog_services::task_reports::host::InFlight {
        Default::default()
    }
    fn agent_task_owners(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn agent_tasks(&self) -> Vec<mixdog_services::task_reports::chain::AgentTask> {
        Vec::new()
    }
    async fn stored_workers(&self, _: &HashSet<String>) -> Vec<Value> {
        Vec::new()
    }
    async fn settle_restart_failures(&self) -> Result<(), String> {
        Ok(())
    }
}

struct Named(Vec<Value>);

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_send::AgentNames for Named {
    async fn name(&self, agent_id: &str) -> String {
        self.0.iter().find(|bot| bot["id"] == agent_id).and_then(|bot| bot["name"].as_str()).unwrap_or(agent_id).to_owned()
    }
}

struct Rows(Vec<Value>);

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_send::ModelRows for Rows {
    async fn rows(&self) -> Result<Vec<Value>, String> {
        Ok(self.0.clone())
    }
}

/// `configureSession({ action: 'setEffort', args })` as Node's recorder keeps it.
#[derive(Default)]
struct Efforts(Mutex<Vec<Value>>);

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_send::SessionEffort for Efforts {
    async fn set_effort(&self, thread: &ThreadId, level: Option<&str>) -> Result<(), String> {
        self.0.lock().expect("efforts").push(json!({ "sessionId": thread.as_str(), "action": "setEffort", "args": [level, { "sessionOnly": true }] }));
        Ok(())
    }
}

struct NoRebind;

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_send::Rebind for NoRebind {
    async fn rebind(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// What create reads of the process, stood in as Node's recorder stands it in (`golden.create`
/// and the scenario's `create`): the session it creates is a real one in the directory under the
/// recorded id, watched from its creation; the worktree requests and deletions are kept as given.
struct CreateRecords {
    directory: Arc<mixdog_core_session::session::SessionDirectory>,
    golden: Value,
    scenario: Value,
    created: Mutex<Vec<Value>>,
    configured: Mutex<Vec<Value>>,
    watched: Mutex<Option<(Arc<dyn mixdog_services::task_reports::follow::RuntimeView>, tokio::sync::mpsc::UnboundedReceiver<()>)>>,
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_create::CreateHost for CreateRecords {
    /// The registry document Node's `listProjects` read (`golden.projectsFile`), read by the core's own registry
    /// (`Registry::list`, as the daemon's `RegistryProjects` reads it).
    async fn projects(&self) -> Vec<mixdog_tools::orch::session::ProjectRow> {
        let dir = tempfile::tempdir().expect("registry dir");
        let path = dir.path().join("projects.json");
        std::fs::write(&path, serde_json::to_vec(&self.golden["projectsFile"]).expect("registry document")).expect("registry written");
        let registry = Arc::new(mixdog_store::registry::Registry::new(path));
        let entries = mixdog_core_base::support::on_lane(mixdog_rt::testing::tokens().maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| registry.list(lane)).await.expect("registry read");
        entries.into_iter().map(|entry| mixdog_tools::orch::session::ProjectRow { name: entry.name, path: entry.path }).collect()
    }
    async fn codex_route(&self, route: Value) -> Value {
        let models = self.golden["codexCatalog"]["models"].as_array().cloned().unwrap_or_default();
        // Node's `codexModelSuccessor` reads `Date.now()`; the recorded retirement lies in the past of both runs.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after the epoch").as_millis() as i64;
        mixdog_core_config::config::migrate_codex_route_over(&route, &models, now)
    }
    async fn directory(&self, path: &str) -> Option<String> {
        std::path::Path::new(path).is_dir().then(|| path.to_owned())
    }
    async fn new_task_default(&self) -> Option<String> {
        self.scenario["newTaskDefault"].as_str().map(str::to_owned)
    }
    async fn presets(&self) -> Vec<Value> {
        Vec::new()
    }
    async fn lead_route(&self) -> Result<Option<Value>, String> {
        Ok(match self.scenario.get("lead") {
            None => Some(self.golden["lead"].clone()),
            Some(Value::Null) => None,
            Some(lead) => Some(lead.clone()),
        })
    }
    async fn catalog_page(&self, _: usize, cursor: Option<String>) -> Result<(Vec<Value>, Option<String>), String> {
        let rows = if cursor.is_some() { Vec::new() } else { self.scenario["catalog"].as_array().cloned().unwrap_or_default() };
        Ok((rows, None))
    }
    async fn create_session(&self, params: Value) -> Result<String, String> {
        self.created.lock().expect("created").push(masked_value(&params));
        let id = ThreadId::from(self.golden["sessionId"].as_str().expect("created id"));
        let mut header = Map::new();
        for key in ["provider", "model", "effort", "autoEffort", "fast"] {
            if let Some(value) = params.get(key) {
                header.insert(key.into(), value.clone());
            }
        }
        header.insert("cwd".into(), json!("/ws"));
        header.insert("taskOrigin".into(), params["sessionProfile"]["taskOrigin"].clone());
        self.directory.create_with_id(id.clone(), header, json!({})).await.map_err(|e| format!("{e:?}"))?;
        let runtime = self.directory.report_runtime(&id).await.map_err(|e| format!("{e:?}"))?;
        let changes = runtime.subscribe();
        *self.watched.lock().expect("watched") = Some((runtime, changes));
        Ok(id.as_str().to_owned())
    }
    async fn request_worktree(&self, session_id: &str, input: Value) -> Result<Value, mixdog_core::run_host::tool_pool::session_create::CreateFailure> {
        self.configured.lock().expect("configured").push(masked_value(&json!({ "sessionId": session_id, "action": "requestWorktree", "args": [input] })));
        let outcome = &self.golden["worktree"][self.scenario["worktree"].as_str().expect("a worktree outcome")];
        if let Some(value) = outcome.get("value") {
            return Ok(value.clone());
        }
        Err(mixdog_core::run_host::tool_pool::session_create::CreateFailure {
            code: outcome["code"].as_str().map(str::to_owned),
            message: outcome["message"].as_str().expect("message").to_owned(),
            details: outcome.get("details").cloned(),
        })
    }
    async fn delete_session(&self, session_id: &str) -> Result<Value, String> {
        self.configured.lock().expect("configured").push(json!({ "sessionId": session_id, "action": "deleteSession", "args": [session_id] }));
        match self.scenario["drop"].as_str() {
            Some("fails") => Err(self.golden["dropFailure"].as_str().expect("drop failure").to_owned()),
            Some("refused") => Ok(json!(false)),
            _ => Ok(json!(true)),
        }
    }
}

/// `session action=send` over the real session directory, the real report host and the real send
/// path (`TaskSends`, `DirectorySubmit`): the target sessions hold the recorded records, a turn
/// ends with the recorded answer, and the stores Node's recorder stood in are stood in the same
/// way. The answer is Node's (its minted send id named as recorded); the turns submitted carry
/// Node's prompt and transcript meta; the effort set, the watches, the records of quiet work and the
/// reports delivered are Node's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_send_answers_as_node() {
    replay_sends("send-").await;
}

/// A chain of sends: every step replays as a send above; here each derived step's caller is the turn
/// the core's runtime starts from what the earlier step recorded (`TurnState::stamp` over the
/// submission's transcript meta; for a report, over the wake's `{ hop: send_depth(report) }`; for a
/// turn the user starts, over none), and that turn's hop and bot chain are the ones Node stamped.
#[test]
fn a_chain_of_sends_carries_its_hop_as_node() {
    use mixdog_core_session::session::delegation::TurnState;
    let golden = golden();
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    let mut checked = 0;
    for scenario in scenarios.iter().filter(|s| s.get("derive").is_some()) {
        let (name, derive) = (scenario["name"].as_str().expect("name"), &scenario["derive"]);
        let earlier = &scenarios.iter().find(|s| s["name"] == derive["from"]).unwrap_or_else(|| panic!("{name}: no earlier step"))["expected"]["send"];
        let meta = match derive["by"].as_str().expect("by") {
            "turn" => Some(
                earlier["submitted"].as_array().expect("submitted").iter().find(|s| s["sessionId"] == derive["session"]).unwrap_or_else(|| panic!("{name}: no submission"))["options"]["transcriptMeta"].clone(),
            ),
            "report" => {
                let depth = mixdog_services::bots::delivery::queue::send_depth(earlier["delivered"].as_array().expect("delivered").last().map(|d| &d["report"]));
                (depth > 0.0).then(|| json!({ "hop": depth as u32 }))
            }
            "fresh" => None,
            other => panic!("{name}: derivation {other}"),
        };
        let turn = TurnState::default();
        turn.stamp(meta.as_ref());
        let caller = &scenario["caller"];
        assert_eq!((json!(turn.hop()), json!(turn.bots())), (caller["turnHop"].clone(), caller["turnBotChain"].clone()), "{name}: the turn its caller is in");
        checked += 1;
    }
    assert!(checked > 0, "no derived chain step recorded");
}

/// `session action=create` over the same send path as [`session_send_answers_as_node`], its
/// process reads stood in by [`CreateRecords`]: the answer, the session it created (its route,
/// place and task origin), the worktree requests and deletions, the brief's turn and the reports
/// ("Started" first) are Node's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_create_answers_as_node() {
    replay_sends("create-").await;
}

/// The sessions' intake as the send path submits through it, each submission kept as Node's recorder
/// keeps `submitSession({ sessionId, prompt, options })`: `options.id` is the send's id when the sender
/// follows the turn (Node passes an id only with `onSettled`), `mode` is a prompt's, and `transcriptMeta`
/// is the sender's meta with the chain's hop and bots (`chainedOrigin`'s transcript meta).
struct Submits {
    inner: mixdog_core::run_host::tool_pool::session_send::DirectorySubmit,
    seen: Mutex<Vec<Value>>,
}

#[async_trait]
impl mixdog_services::task_reports::send::TurnSubmit for Submits {
    async fn submit(
        &self,
        session_id: &str,
        content: Value,
        id: &str,
        submission: mixdog_services::task_reports::send::Submission,
    ) -> Result<Option<tokio::sync::oneshot::Receiver<mixdog_services::task_reports::send::TurnEnd>>, String> {
        let mut meta = submission.meta.clone();
        if submission.hop > 0 {
            meta.insert("hop".into(), json!(submission.hop));
        }
        if !submission.bot_chain.is_empty() {
            meta.insert("botChain".into(), json!(submission.bot_chain));
        }
        let mut options = Map::new();
        if submission.settled {
            options.insert("id".into(), masked_value(&json!(id)));
        }
        options.insert("mode".into(), json!("prompt"));
        options.insert("transcriptMeta".into(), Value::Object(meta));
        self.seen.lock().expect("submits").push(json!({ "sessionId": session_id, "prompt": content, "options": options, "reports": submission.settled }));
        self.inner.submit(session_id, content, id, submission).await
    }
}

/// The room Node's recorder stands in (`golden.room`): its record, labels and display names, a fixed
/// clock and ids `n1`, `n2`, ...; what a message into it does is kept as the recorder keeps it
/// (`seen.room`, in order).
struct RecordedRoom {
    golden: Value,
    seen: Arc<Mutex<Vec<Value>>>,
    last_at: Mutex<i64>,
    ids: std::sync::atomic::AtomicU32,
}

#[async_trait]
impl mixdog_core_rooms::rooms::room_ask::AskRoom for RecordedRoom {
    fn name(&self) -> String {
        self.golden["name"].as_str().expect("room name").to_owned()
    }
    fn members(&self) -> Vec<String> {
        self.golden["members"].as_array().expect("members").iter().map(|m| m.as_str().expect("member").to_owned()).collect()
    }
    async fn labels(&self) -> Result<std::collections::HashMap<String, mixdog_core_rooms::rooms::turn_host::MemberLabel>, String> {
        Ok(self.golden["labels"]
            .as_object()
            .expect("labels")
            .iter()
            .map(|(id, label)| {
                let text = |key: &str| label[key].as_str().unwrap_or_default().to_owned();
                (id.clone(), mixdog_core_rooms::rooms::turn_host::MemberLabel { id: text("id"), name: text("name"), route: label["route"].clone(), description: text("description"), disabled: label["disabled"] == true })
            })
            .collect())
    }
    async fn display_name(&self, agent_id: &str) -> Option<String> {
        self.golden["names"][agent_id].as_str().map(str::to_owned)
    }
    async fn member_session(&self, member: &mixdog_core_rooms::rooms::turn_host::MemberLabel) -> Result<String, String> {
        let room = self.golden["id"].as_str().expect("room id");
        self.seen.lock().expect("room").push(json!(["memberSession", room, member.id]));
        Ok(mixdog_core_base::rooms::ids::room_member_session_id(room, &member.id).expect("member session"))
    }
    async fn post(&self, rows: Vec<Value>) -> Result<(), String> {
        self.seen.lock().expect("room").push(json!(["post", self.golden["id"], rows]));
        Ok(())
    }
    fn set_last_at(&self, at: i64) {
        *self.last_at.lock().expect("last at") = at;
    }
    async fn persist(&self) -> Result<(), String> {
        let at = *self.last_at.lock().expect("last at");
        self.seen.lock().expect("room").push(json!(["persist", { "lastAt": at }]));
        Ok(())
    }
    fn republish_catalog(&self) {
        self.seen.lock().expect("room").push(json!(["republishCatalog"]));
    }
    fn now(&self) -> i64 {
        self.golden["now"].as_i64().expect("room now")
    }
    fn new_id(&self) -> String {
        format!("n{}", self.ids.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1)
    }
}

struct RecordedRooms(Arc<RecordedRoom>);

impl mixdog_core_rooms::rooms::room_ask::AskRooms for RecordedRooms {
    fn room(&self, room_id: &str) -> Result<Arc<dyn mixdog_core_rooms::rooms::room_ask::AskRoom>, String> {
        if self.0.golden["id"] == room_id { Ok(self.0.clone()) } else { Err("This room no longer exists.".into()) }
    }
}

/// The recorder's scheduler: no stop is pending; a routed call's member turn ends done with the
/// recorded answer after the route returns.
struct RecordedScheduler {
    seen: Arc<Mutex<Vec<Value>>>,
    answer: String,
}

struct NotStopped;

impl mixdog_core_rooms::rooms::room_ask::Intake for NotStopped {
    fn stopped(&self) -> bool {
        false
    }
}

impl mixdog_core_rooms::rooms::room_ask::AskScheduler for RecordedScheduler {
    fn intake(&self, _: &str) -> Box<dyn mixdog_core_rooms::rooms::room_ask::Intake> {
        Box::new(NotStopped)
    }
    fn route(&self, room_id: &str, request: mixdog_core_rooms::rooms::calls::Request) {
        let calls: Vec<Value> = request
            .calls
            .iter()
            .map(|call| {
                let mut view = Map::new();
                view.insert("agentId".into(), json!(call.agent_id));
                view.insert("askedBy".into(), json!(call.asked_by));
                if !call.id.is_empty() {
                    view.insert("id".into(), json!(call.id));
                }
                if call.hop > 0 {
                    view.insert("hop".into(), json!(call.hop));
                }
                if call.on_settled.is_some() {
                    view.insert("onSettled".into(), json!(true));
                }
                if call.follow.is_some() {
                    view.insert("follow".into(), json!(true));
                }
                Value::Object(view)
            })
            .collect();
        self.seen.lock().expect("room").push(json!(["route", room_id, { "to": request.to, "everyone": request.everyone, "waiting": request.waiting, "only": request.only, "calls": calls }]));
        let answer = self.answer.clone();
        drop(mixdog_rt::spawn("recorded-room-turn", mixdog_rt::TaskClass::Work, async move {
            for call in request.calls {
                call.settle_with(&mixdog_core_rooms::rooms::calls::Settled { status: "done".into(), error: None, content: Some(answer.clone()) });
            }
        }));
    }
}

/// A room host that relays nothing: no relay runs in a send.
struct NoRelay;

#[async_trait]
impl mixdog_services::bots::delivery::env::RoomRelay for NoRelay {
    async fn relay(&self, _: &str, _: &str, _: mixdog_services::bots::live::WakeOptions, _: mixdog_services::bots::delivery::env::WakeFollow) -> Result<Option<mixdog_services::bots::live::WakeTurn>, String> {
        unreachable!("no relay runs in a send")
    }
}

async fn replay_sends(prefix: &str) {
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_core_session::session::thread_state::SessionThreads;
    use mixdog_services::bots::delivery::queue::WatchError;
    use mixdog_services::task_reports::host::TaskReportHost;
    use mixdog_services::task_reports::send::TaskSends;
    let golden = golden();
    let send = &golden["send"];
    let final_text = send["final"].as_str().expect("final").to_owned();
    let mut replayed = 0;
    for scenario in golden["scenarios"].as_array().expect("scenarios").iter().filter(|s| s["name"].as_str().expect("name").starts_with(prefix)) {
        let name = scenario["name"].as_str().expect("name");
        let rig = Rig::new();
        let answer = final_text.clone();
        // A turn that stops for the user's approval first (the recorded `toolApproval`), then ends with the answer.
        let approval = scenario["send"]["approval"].as_str().map(str::to_owned);
        let asks = approval.is_some();
        rig.set_script(Arc::new(move |run| {
            let content = answer.clone();
            Box::pin(async move {
                if asks {
                    use mixdog_core_api::domain::approval::ApprovalGate;
                    run.port.input_durable().await.expect("input durable");
                    let _decided = run
                        .port
                        .request(mixdog_core_api::domain::approval::ApprovalAsk {
                            kind: mixdog_core_api::domain::approval::ApprovalKind::UserInput,
                            call_id: None,
                            tool: Some("ask_user".into()),
                            action_kind: None,
                            reason: None,
                            payload: json!({ "questions": [{ "question": "May I?" }] }),
                            remember: Vec::new(),
                            expires_after: None,
                        })
                        .await;
                }
                mixdog_core_session::session::RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult { content, ..Default::default() }))
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let caller = scenario["caller"].as_object().expect("caller").clone();
        let caller_id = caller["id"].as_str().expect("caller id").to_owned();
        // The stored sessions: the recorded targets, and the caller's record over its own.
        let mut records: Map<String, Value> = send["targets"].as_object().expect("targets").clone();
        let mut own = records.get(&caller_id).and_then(Value::as_object).cloned().unwrap_or_default();
        for (key, value) in &caller {
            if !matches!(key.as_str(), "turnHop" | "turnBotChain") {
                own.insert(key.clone(), value.clone());
            }
        }
        records.insert(caller_id.clone(), Value::Object(own));
        for (id, record) in &records {
            let mut header = record.as_object().expect("record").clone();
            header.shift_remove("id");
            header.shift_remove("messages");
            header.insert("cwd".into(), json!("/ws"));
            directory.create_with_id(ThreadId::from(id.as_str()), header, json!({})).await.unwrap_or_else(|e| panic!("{name}: create {id}: {e:?}"));
        }
        let refuse = match scenario["send"]["watch"].as_str() {
            Some("cap") => Some(WatchError::Cap("watch cap".into())),
            Some("fails") => Some(WatchError::Failed("the watch store is unavailable".into())),
            _ => None,
        };
        let home = Arc::new(HomeRecords { refuse, ..HomeRecords::default() });
        let data = tempfile::tempdir().expect("data dir");
        let queue = Arc::new(mixdog_core_session::session::pending_read::PendingQueue::new(
            directory.clone(),
            Arc::new(mixdog_core_session::session::delivered::DeliveredCompletions::new(rig.clock.clone())),
        ));
        let host = TaskReportHost::new(
            home.clone(),
            Arc::new(mixdog_core::run_host::task_report_store::DirectoryReportSessions {
                directory: directory.clone(),
                queue,
                completions: Arc::new(mixdog_core_session::session::agent_registry::flow::SessionCompletions::new(directory.clone())),
                lane: mixdog_rt::testing::tokens().durability_io,
                data_dir: data.path().to_path_buf(),
                scopes: Vec::new(),
            }),
            Arc::new(NothingPending),
            Arc::new(mixdog_services::task_reports::host::BotWork::new(Arc::new(|_: &str| {}))),
            Arc::new(mixdog_services::bots::delivery::env::SleepRetry),
        );
        let submits = Arc::new(Submits { inner: mixdog_core::run_host::tool_pool::session_send::DirectorySubmit(directory.clone()), seen: Mutex::default() });
        let tasks = TaskSends::with_timing(
            host,
            submits.clone(),
            "process".into(),
            Arc::new(|| 0),
            std::time::Duration::ZERO,
            mixdog_services::task_reports::follow::FINAL_POLL,
            Vec::new(),
        );
        let (turn_hop, turn_bots) = (
            caller.get("turnHop").and_then(Value::as_u64).map_or(0, |hop| hop as u32),
            caller.get("turnBotChain").and_then(Value::as_array).map(|bots| bots.iter().map(|b| b.as_str().expect("bot").to_owned()).collect::<Vec<_>>()).unwrap_or_default(),
        );
        let (record, turn_of) = (Value::Object(caller.clone()), caller_id.clone());
        let record_of = caller_id.clone();
        let efforts = Arc::new(Efforts::default());
        let create = Arc::new(CreateRecords {
            directory: directory.clone(),
            golden: golden["create"].clone(),
            scenario: scenario.get("create").cloned().unwrap_or(Value::Null),
            created: Mutex::default(),
            configured: Mutex::default(),
            watched: Mutex::default(),
        });
        // The desktop room host Node's recorder registered for a room scenario (none for `room.host: false`).
        let rooms = Arc::new(mixdog_core_rooms::rooms::room_hosts::RoomHostRegistry::default());
        let room_seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let _room_host = scenario.get("room").filter(|room| room["host"] != false).map(|_| {
            let room = Arc::new(RecordedRoom { golden: golden["room"].clone(), seen: room_seen.clone(), last_at: Mutex::new(0), ids: Default::default() });
            let asks = mixdog_core_rooms::rooms::room_ask::RoomAsks::new(
                Arc::new(RecordedRooms(room)),
                Arc::new(RecordedScheduler { seen: room_seen.clone(), answer: final_text.clone() }),
                mixdog_core_rooms::rooms::ready::RoomsReady::prepared(),
            );
            rooms.register_host(Arc::new(NoRelay), Some(Arc::new(asks)))
        });
        let late = Arc::new(mixdog_core::run_host::tool_pool::session_send::LateSend::default());
        late.bind(Arc::new(mixdog_core::run_host::tool_pool::session_send::SessionSend {
            rooms: rooms.clone(),
            directory: directory.clone(),
            tasks,
            chains: mixdog_core::run_host::tool_pool::session_send::CallerChains {
                record: Arc::new(move |id: &str| (id == record_of).then(|| record.clone())),
                turn: Arc::new(move |id: &str| if id == turn_of { (turn_hop, turn_bots.clone()) } else { (0, Vec::new()) }),
            },
            names: Arc::new(Named(golden["bots"].as_array().expect("bots").clone())),
            catalog: Arc::new(Rows(send["modelRows"].as_array().expect("rows").clone())),
            effort: efforts.clone(),
            rebind: Arc::new(NoRebind),
            create: create.clone(),
        }))
        .expect("bind");
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let bots: Vec<&'static str> = golden["bots"].as_array().expect("bots").iter().map(|b| &*b["id"].as_str().expect("bot id").to_owned().leak()).collect();
        let tool = tool_over(threads, &bots, Arc::new(Fixture::default()), directory.clone(), late, Arc::new(LateBotSources::default()));
        let expected = &scenario["expected"];
        let recorded = &expected["send"];
        // Each submitted turn is watched to its end before its rows are read (a created session from its creation).
        let created_id = golden["create"]["sessionId"].as_str().expect("created id");
        let mut runtimes = Vec::new();
        for submitted in recorded["submitted"].as_array().expect("submitted") {
            let target = ThreadId::from(submitted["sessionId"].as_str().expect("target"));
            if target.as_str() == created_id {
                continue;
            }
            let runtime = directory.report_runtime(&target).await.expect("the target's runtime");
            let changes = runtime.subscribe();
            runtimes.push((target, runtime, changes));
        }
        // Node's caller works in `C:/proj` (`callerCwd`).
        let cwd = AbsPath::new("C:/proj").unwrap_or_else(|| AbsPath::new(std::env::temp_dir()).expect("absolute"));
        let ctx = ToolContext { thread_id: ThreadId::from(caller_id.as_str()), tool: "session".into(), surface: SurfaceKind::Lead, cwd, ..ctx() };
        let (ok, text) = match tool.call(&ctx, scenario["args"].clone()).await {
            Ok(out) => match &out.parts[..] {
                [ToolPart::Text(text)] => (true, text.clone()),
                other => panic!("{other:?}"),
            },
            Err(error) => (false, error.message_for_model),
        };
        assert_eq!((ok, masked(&text).as_str()), (expected["ok"].as_bool().expect("ok"), expected["text"].as_str().expect("text")), "{name}");
        if let Some(created) = recorded.get("created") {
            assert_eq!(json!(*create.created.lock().expect("created")), *created, "{name}: the session created");
            assert_eq!(json!(*create.configured.lock().expect("configured")), recorded["configured"], "{name}: the worktree asked of it");
            if let Some((runtime, changes)) = create.watched.lock().expect("watched").take()
                && recorded["submitted"].as_array().is_some_and(|s| !s.is_empty())
            {
                runtimes.push((ThreadId::from(created_id), runtime, changes));
            }
        }
        // The approval the sent turn waits on: answered as recorded, or left waiting; the core's minted id is
        // named by the recording's (`send.approvalId`).
        let mut approval_named = None;
        if let Some(approval) = approval.as_deref() {
            let (target, _, _) = runtimes.first().expect("the approving target");
            let target = target.clone();
            let handle = directory.handle(&target).expect("the target's handle");
            let shown = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let stepped = handle.stepped().notified();
                    tokio::pin!(stepped);
                    stepped.as_mut().enable();
                    if let Some(shown) = directory.member_approval(&target) {
                        return shown;
                    }
                    stepped.await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{name}: the sent turn did not stop for its approval within 10s"));
            let id = mixdog_js::value_to_string(&shown["id"]);
            approval_named = Some((format!("{}_{id}_blocked", target.as_str()), format!("{}_{}_blocked", target.as_str(), send["approvalId"].as_str().expect("approval id"))));
            if approval != "waiting" {
                // The report of the wait goes out before the answer clears it.
                tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    while home.delivered.lock().expect("delivered").is_empty() {
                        home.settled.notified().await;
                    }
                })
                .await
                .unwrap_or_else(|_| panic!("{name}: the approval wait was not reported within 10s"));
                let answered = directory
                    .answer_member_approval(
                        &target,
                        &id,
                        mixdog_core_api::ids::ConnectionId(1),
                        "desktop".into(),
                        mixdog_protocol::ConnectionKind::Desktop,
                        mixdog_protocol::Origin::Local,
                        json!({ "approved": approval == "approved" }),
                    )
                    .await
                    .expect("answered");
                assert!(answered, "{name}: the approval is answered");
            }
        }
        let ends: Vec<_> = if approval.as_deref() == Some("waiting") { Vec::new() } else { runtimes };
        for ((target, runtime, mut changes), submitted) in ends.into_iter().zip(recorded["submitted"].as_array().expect("submitted")) {
            // The turn's start and its end, each one change.
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                let mut seen = 0;
                loop {
                    if changes.recv().await.is_none() {
                        panic!("{name}: the runtime of {target:?} closed before the turn sent to it ended");
                    }
                    seen += 1;
                    if seen >= 2 && !runtime.busy() && runtime.queued_ids().is_empty() {
                        break;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{name}: the turn sent to {target:?} did not end within 10s"));
            let messages = directory.session_messages(&target).await.expect("read").expect("the target's messages");
            let users: Vec<&Value> = messages.iter().filter(|m| m["role"] == "user").collect();
            assert_eq!(users.len(), 1, "{name}: one turn in {target:?}");
            assert_eq!(users[0]["content"], submitted["prompt"], "{name}: the prompt {target:?} took");
            for (key, value) in submitted["options"]["transcriptMeta"].as_object().expect("transcript meta") {
                assert_eq!(users[0]["meta"]["transcript"][key], *value, "{name}: the stored turn in {target:?} carries the submission's {key}");
            }
        }
        // Every submission, whole, as Node's session service was given it.
        assert_eq!(json!(*submits.seen.lock().expect("submits")), recorded["submitted"], "{name}: the submissions");
        // A reporting turn's end is delivered (or, reporting nothing, its record dropped) after the turn settles.
        let reports = |records: &HomeRecords| records.delivered.lock().expect("delivered").len() + records.disowned.lock().expect("disowned").len();
        let owed = recorded["delivered"].as_array().expect("delivered").len() + recorded["disowned"].as_array().expect("disowned").len();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while reports(&home) < owed {
                home.settled.notified().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{name}: the send's end was not reported within 10s"));
        assert_eq!(json!(*efforts.0.lock().expect("efforts")), recorded["effort"], "{name}: the effort set");
        assert_eq!(json!(*home.watches.lock().expect("watches")), recorded["watches"], "{name}: the watches");
        assert_eq!(json!(*home.unwatched.lock().expect("unwatched")), recorded["unwatched"], "{name}: the dropped watches");
        assert_eq!(json!(*home.owned.lock().expect("owned")), recorded["owned"], "{name}: the records of quiet work");
        assert_eq!(json!(*home.disowned.lock().expect("disowned")), recorded["disowned"], "{name}: the dropped records");
        let delivered: Vec<(String, String)> = recorded["delivered"]
            .as_array()
            .expect("delivered")
            .iter()
            .map(|d| (d["agentId"].as_str().expect("agent").to_owned(), format!("{:?}", mixdog_services::task_reports::host::report_of(&d["report"]))))
            .collect();
        let reported: Vec<(String, String)> = home
            .delivered
            .lock()
            .expect("delivered")
            .iter()
            .map(|(agent, report)| (agent.clone(), approval_named.as_ref().map_or_else(|| report.clone(), |(minted, named)| report.replace(minted, named))))
            .collect();
        assert_eq!(reported, delivered, "{name}: the reports");
        // What a message into a room stored there and showed its clients: the rows posted, the member sessions, the
        // request routed to the member, the room's save and the catalog republished.
        if let Some(room) = recorded.get("room") {
            assert_eq!(masked_value(&json!(*room_seen.lock().expect("room"))), *room, "{name}: the room");
        }
        replayed += 1;
    }
    assert!(replayed > 0, "no send- scenario recorded");
}

#[tokio::test]
async fn session_list_answers_as_node() {
    replay("list-").await;
}

#[tokio::test]
async fn session_read_answers_as_node() {
    replay("read-").await;
}

/// `session action=bots` over the scenario's catalog and [`BotRecords`]: the overview, one bot's
/// detail, each scope and each refusal are Node's, byte for byte.
#[tokio::test]
async fn session_bots_answers_as_node() {
    replay("bots-").await;
}

/// A session of `rows` assistant rows (`r<i>` / `row <i>`, as the recorder generates them), paged newest first as `thread/items/list` pages; counts
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
            tokio::time::timeout(std::time::Duration::from_secs(10), self.release.notified())
                .await
                .expect("the list beside the read released its first page within 10s");
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

    fn compact_after_turn(&self, _: &ThreadId) -> Result<(), CoreError> {
        unreachable!("the session tool schedules a compaction through `thread/compact/schedule`")
    }

    async fn transcript(&self, _: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, CoreError> {
        unreachable!("the session tool reads transcripts through `thread/items/list`")
    }

    async fn submit(&self, _: &ThreadId, _: &Value, _: &str, _: u32, _: &[String], _: Option<&str>) -> Result<bool, CoreError> {
        unreachable!("the session tool sends through the send world")
    }

    async fn start(&self, _: Value) -> Result<Value, CoreError> {
        unreachable!("the session tool creates through the send world")
    }

    fn turn_state(&self, _: &ThreadId) -> (u32, Vec<String>) {
        unreachable!("the session tool reads a turn's chain through the send world")
    }

    async fn set_caller_cwd(&self, _: &ThreadId, _: &str) -> Result<String, CoreError> {
        unreachable!("these scenarios make no `session set-project` call")
    }

    fn interrupt(&self, _: &ThreadId) -> Result<bool, CoreError> {
        unreachable!("a read never interrupts")
    }
}

/// The recorded read of one window of a million-row session (`longread-window`): it answers what
/// Node answered, asks for its window only (the rows it shows and one more to know older ones
/// exist), never the whole log; and while that read waits on the session, a list through the
/// same tool completes: the port holds nothing across the read that other calls need.
#[tokio::test]
async fn a_read_of_a_long_session_pages_its_window_and_holds_nothing_other_calls_wait_on() {
    let golden = golden();
    let scenario = golden["scenarios"].as_array().expect("scenarios").iter().find(|s| s["name"] == "longread-window").expect("longread-window").clone();
    let (args, rows) = (scenario["args"].clone(), scenario["generated"]["sess_long"].as_u64().expect("rows") as usize);
    let long = Arc::new(LongSession { rows, served: Default::default(), release: tokio::sync::Notify::new() });
    let caller = scenario["caller"].as_object().expect("caller").clone();
    let caller_id = caller["id"].as_str().expect("caller id").to_owned();
    let tool = session_tool(caller, &["sess_long".to_owned()], &[], Arc::new(Fixture::of(&scenario)), long.clone(), Arc::new(LateBotSources::default()));
    let read = call(&tool, &caller_id, args.clone());
    let list_then_release = async {
        let listed = call(&tool, &caller_id, json!({ "action": "list", "limit": 1 })).await;
        long.release.notify_one();
        listed
    };
    let ((read_ok, read_text), (list_ok, _)) = tokio::time::timeout(std::time::Duration::from_secs(10), async { tokio::join!(read, list_then_release) })
        .await
        .expect("the list completed while the read waited");
    assert!(list_ok);
    assert_eq!((read_ok, read_text.as_str()), (scenario["expected"]["ok"].as_bool().expect("ok"), scenario["expected"]["text"].as_str().expect("text")));
    let window = args["offset"].as_u64().expect("offset") + args["limit"].as_u64().expect("limit") + 1;
    assert_eq!(long.served.load(std::sync::atomic::Ordering::SeqCst) as u64, window);
}
