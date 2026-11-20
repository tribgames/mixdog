//! The session host's behaviours over a real thread store: a transcript read in pages, a conversation inherited into another thread, and
//! a core running over one data directory.
#![allow(clippy::disallowed_methods, reason = "test setup: temp directories")]

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

use async_trait::async_trait;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_core::run_host::inheritance_fit::HostInheritanceFit;
use mixdog_core::run_host::inheritance_fit::MeasuredThreads;
use mixdog_core::run_host::inheritance_fit::RouteWindows;
use mixdog_core::run_host::run_seams::ConfigRunSeams;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_run::run_host::session_context_meta::ContextMeta;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::StoreThreads;
use mixdog_core_session::session::ThreadStore;
use mixdog_core_session::session::testing::CallCounted;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::transcript::RecordTranscript;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// A session of 300 assistant rows `c0`..`c299`, each `row <id> ` fifty
/// times, stored as the thread's conversation.
async fn paged_session(directory: &SessionDirectory, extra: &[&str]) {
    let id = ThreadId::from("sess_page_host");
    directory.create_with_id(id.clone(), Header::new(), json!({})).await.expect("created");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let text = |row: &str| format!("row {row} ").repeat(50);
    let messages: Vec<Value> = (0..300)
        .map(|n| format!("c{n}"))
        .chain(extra.iter().map(|row| (*row).to_owned()))
        .map(|row| json!({ "role": "assistant", "content": text(&row) }))
        .collect();
    let append =
        CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") };
    handle.request(append).await.expect("the conversation is stored");
}

/// One `thread/items/list` page of the paged session: the raw items and the rows the client folds them into.
async fn page(directory: &SessionDirectory, limit: u32, cursor: Option<&Value>) -> (Vec<Value>, Value) {
    let mut params = json!({ "threadId": "sess_page_host", "limit": limit, "byteBudget": 1_000_000 });
    if let Some(cursor) = cursor {
        params["cursor"] = cursor.clone();
    }
    let page = call(directory, "thread/items/list", params).await.expect("the page");
    (page["data"].as_array().expect("data").clone(), page)
}

fn folded(items: &[Value]) -> Vec<Value> {
    without_ids(&items.iter().map(row_of).collect::<Vec<_>>())
}

async fn paged_directory(extra: &[&str]) -> (tempfile::TempDir, Arc<SessionDirectory>) {
    let (dir, directory, _) = counted_paged_directory(extra).await;
    (dir, directory)
}

/// The paged session over a store whose calls can be held (`CallCounted::hold`).
async fn counted_paged_directory(extra: &[&str]) -> (tempfile::TempDir, Arc<SessionDirectory>, Arc<CallCounted>) {
    let dir = tempfile::tempdir().expect("dir");
    let rig = Rig::new();
    rig.clock.0.store(1_800_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let store = CallCounted::new(real_store(&dir.path().join("data")).await);
    let seams = run_seams(dir.path()).await;
    let directory = inheriting_directory(&rig, store.clone(), seams).await;
    paged_session(&directory, extra).await;
    (dir, directory, store)
}

struct NoEvidence;

#[async_trait]
impl AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

/// The process's run seams over an empty saved configuration (the recorder ran with none).
async fn run_seams(dir: &std::path::Path) -> Arc<ConfigRunSeams> {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) =
        Config::open(dir.join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("config");
    let agents = AgentDefinitions::new(
        dir,
        dir,
        tokens.interactive_io,
        AgentRoutes::new(config.clone(), dir),
        Arc::new(NoEvidence),
        Arc::new(|| Value::Null),
        dir.join("workspace"),
    );
    Arc::new(ConfigRunSeams::new(config, Arc::new(agents), dir.to_path_buf(), dir.to_path_buf(), Arc::new(|_| None)))
}

/// A carry into an existing heir measures the heir session itself: no route windows are read.
struct NoWindows;

impl RouteWindows for NoWindows {
    fn window(&self, _: &str, _: &str, _: &Value) -> Option<ContextMeta> {
        None
    }
}

/// The conversations are text only.
struct TextOnly;

impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        match part {
            ContentPart::Text(text, _) => PartMeter { text: text.clone(), tokens: 0 },
            other => panic!("a media part in a text-only recording: {other:?}"),
        }
    }
}

/// The measured threads of the directory (`DirectoryThreads` of the composition): the heir's live header; its tools are the
/// heir's (`tools: []`); the meter is the text-only conversation's.
#[derive(Default)]
struct HeirThreads(OnceLock<Weak<SessionDirectory>>);

#[async_trait]
impl MeasuredThreads for HeirThreads {
    async fn header(&self, thread: &ThreadId) -> Option<Header> {
        let directory = self.0.get()?.upgrade()?;
        Some(directory.handle(thread)?.live_header().header().as_ref().clone())
    }
    async fn tools(&self, _: &ThreadId) -> Vec<ToolDefinition> {
        Vec::new()
    }
    async fn media(&self, _: &ThreadId, _: &[Value]) -> Option<Arc<dyn MediaMeter>> {
        Some(Arc::new(TextOnly))
    }
}

/// The real thread store over `data` (`StoreThreads::over_data_dir`, the session index beside it).
async fn real_store(data: &std::path::Path) -> Arc<StoreThreads> {
    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let ownership = Arc::new(mixdog_core_api::domain::mock::MockOwnership::default());
    Arc::new(StoreThreads::over_data_dir(data, index, ownership, tokens.maintenance_io).await.expect("the thread store"))
}

/// A session directory over the real store at `data` with the stored-record transcript and the host's inheritance fit.
async fn inheriting_directory(rig: &Rig, store: Arc<dyn ThreadStore>, seams: Arc<ConfigRunSeams>) -> Arc<SessionDirectory> {
    let threads = Arc::new(HeirThreads::default());
    let mut deps = rig.deps_parts(store);
    deps.transcript = Arc::new(RecordTranscript::new());
    deps.inherit = Arc::new(HostInheritanceFit::new(Arc::new(NoWindows), seams, threads.clone()));
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let _ = threads.0.set(Arc::downgrade(&directory));
    directory
}

fn header_of(session: &Value, keys: &[&str]) -> Header {
    keys.iter().filter_map(|key| session.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect()
}

async fn call(directory: &SessionDirectory, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let op = params.get("opId").and_then(Value::as_str).map(OpId::from);
    match directory.request(CoreRequest { method: Method(method), params, op, ctx: CallContext::internal("test") }).await? {
        Reply::Value(value) => Ok(value),
        Reply::Subscribe(subscribed) => Ok(subscribed.result),
    }
}

/// A session of the recording as a stored thread: its route and windows on the header, its non-system messages as its rows.
async fn stored_session(directory: &SessionDirectory, session: &Value) {
    let id = ThreadId::from(session["id"].as_str().expect("id"));
    let keys = ["provider", "model", "contextWindow", "compactBoundaryTokens", "compaction"];
    directory.create_with_id(id.clone(), header_of(session, &keys), json!({})).await.expect("created");
    let rows: Vec<Value> = session["messages"].as_array().expect("messages").iter().filter(|m| m["role"] != "system").cloned().collect();
    if !rows.is_empty() {
        let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        let append =
            CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": rows }), op: None, ctx: CallContext::internal("test") };
        handle.request(append).await.expect("the conversation is stored");
    }
}

/// The thread's model messages (`thread/modelMessages/list`).
async fn model_messages(directory: &SessionDirectory, id: &str) -> Value {
    call(directory, "thread/modelMessages/list", json!({ "threadId": id, "start": 0 })).await.expect("model messages")["messages"].clone()
}

/// `rowOf` of `packages/protocol-client/src/rows.ts` for the items these recordings hold: a user message, an assistant message and
/// a status row, with `meta.ext` applied last.
fn row_of(item: &Value) -> Value {
    let m = &item["meta"];
    let mut row = Map::new();
    let present = |row: &mut Map<String, Value>, key: &str, value: &Value| {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
            row.insert(key.to_owned(), json!(text));
        }
    };
    let route = |row: &mut Map<String, Value>| {
        for key in ["modelId", "model", "provider", "agent"] {
            present(row, key, &m[key]);
        }
    };
    let at = |row: &mut Map<String, Value>| {
        if m["at"].is_number() {
            row.insert("at".into(), m["at"].clone());
        }
    };
    match item["type"].as_str() {
        Some("userMessage") => {
            row.insert("kind".into(), json!("user"));
            let submission = item["clientSubmissionId"].as_str().filter(|id| !id.is_empty());
            row.insert("id".into(), submission.map_or_else(|| item["id"].clone(), |id| json!(id)));
            let parts = item["content"].as_array().cloned().unwrap_or_default();
            let text: String = parts.iter().filter(|p| p["type"] == "text" || p["type"] == "pastedText").filter_map(|p| p["text"].as_str()).collect();
            row.insert("text".into(), json!(text));
            present(&mut row, "messageId", &m["messageId"]);
            at(&mut row);
            route(&mut row);
        }
        Some("agentMessage") => {
            row.insert("kind".into(), json!("assistant"));
            row.insert("id".into(), item["id"].clone());
            row.insert("text".into(), json!(item["text"].as_str().unwrap_or_default()));
            present(&mut row, "messageId", &m["messageId"]);
            at(&mut row);
            route(&mut row);
        }
        Some("statusRow") => {
            row.insert("kind".into(), item["kind"].clone());
            row.insert("id".into(), item["id"].clone());
            present(&mut row, "label", &m["label"]);
            present(&mut row, "detail", &m["detail"]);
            route(&mut row);
            at(&mut row);
        }
        other => panic!("an item these recordings do not hold: {other:?} {item}"),
    }
    if let Some(ext) = m["ext"].as_object() {
        row.extend(ext.clone());
    }
    Value::Object(row)
}

/// The heir's transcript rows (`thread/items/list`, newest page), each as the client folds it; `limit` as Node's `itemLimit`.
async fn rows(directory: &SessionDirectory, id: &str, limit: Option<u32>) -> Vec<Value> {
    let mut params = json!({ "threadId": id });
    if let Some(limit) = limit {
        params["limit"] = json!(limit);
    }
    let page = call(directory, "thread/items/list", params).await.expect("items");
    page["data"].as_array().expect("data").iter().map(row_of).collect()
}

/// A row's id is the core's own (an item id of its record), where a restore numbers rows by message position
/// (`hist_<session>_<message>_<part>`): the ids are compared as the same row's, everything else whole (manifest
/// `replay.normalised.rowIds`).
fn without_ids(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut row = row.as_object().expect("row").clone();
            row.shift_remove("id");
            Value::Object(row)
        })
        .collect()
}

fn texts(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|row| row["text"].as_str().expect("text").split(' ').nth(1).expect("a row label").to_owned()).collect()
}

fn labels(range: std::ops::Range<u32>) -> Vec<String> {
    range.map(|n| format!("c{n}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_newest_rows_come_first_and_an_older_page_reveals_only_the_rows_before_the_cursor() {
    let (_dir, directory) = paged_directory(&[]).await;
    let (held, opened) = page(&directory, 32, None).await;
    assert_eq!(texts(&folded(&held)), labels(268..300), "the newest 32 rows");
    let older = opened["nextCursor"].clone();
    assert!(older.is_string(), "the opening page names its older rows: {opened}");
    let (revealed, answer) = page(&directory, 64, Some(&older)).await;
    assert_eq!(texts(&folded(&revealed)), labels(204..268), "only the 64 rows before the oldest held one");
    assert_eq!(answer["hasOlder"], json!(true), "older rows remain");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_grew_between_reads_answers_the_window_in_full_with_the_new_rows_last() {
    let (_dir, directory) = paged_directory(&[]).await;
    let (_, _) = page(&directory, 32, None).await;
    let handle = directory.open_handle(&ThreadId::from("sess_page_host"), &CallContext::internal("test")).await.expect("open");
    let messages = vec![json!({ "role": "assistant", "content": "row n0 ".repeat(50) }), json!({ "role": "assistant", "content": "row n1 ".repeat(50) })];
    let append =
        CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") };
    handle.request(append).await.expect("the rows are stored");
    let (window, answer) = page(&directory, 96, None).await;
    let mut want = labels(206..300);
    want.extend(["n0".to_owned(), "n1".to_owned()]);
    assert_eq!(texts(&folded(&window)), want, "the newest 96 rows, the appended ones last");
    assert_eq!(answer["hasOlder"], json!(true));
}

async fn session_over(dir: &std::path::Path) -> (Rig, Arc<StoreThreads>, Arc<ConfigRunSeams>, Arc<SessionDirectory>) {
    let rig = Rig::new();
    rig.clock.0.store(1_800_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let store = real_store(&dir.join("data")).await;
    let seams = run_seams(dir).await;
    let directory = inheriting_directory(&rig, store.clone(), seams.clone()).await;
    (rig, store, seams, directory)
}

fn conversation(id: &str, route: (&str, &str), window: u32, messages: Value) -> Value {
    json!({ "id": id, "provider": route.0, "model": route.1, "contextWindow": window, "compactBoundaryTokens": window, "compaction": { "auto": true }, "messages": messages })
}

fn pairs(messages: &Value) -> Vec<(String, String)> {
    messages.as_array().unwrap().iter().map(|m| (m["role"].as_str().unwrap().to_owned(), m["content"].as_str().unwrap().to_owned())).collect()
}

const SOURCE_ROUTE: (&str, &str) = ("anthropic-oauth", "claude-fable-5-1");
const HEIR_ROUTE: (&str, &str) = ("openai-oauth", "gpt-6-astra");

/// `carry_into` (`session/inheritance.rs`): the heir keeps its route and takes the source's non-system rows; `fit_rows` records the boundary in
/// `meta.sessionInheritances` of the last carried row, and `boundary_rows` (`transcript_rows.rs`) restores it as a `Session inherited` status row
/// after that row; `fit_rows` answers `messages` as the rows carried.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_inherits_a_conversation_into_an_existing_one_and_keeps_it_after_a_reopen() {
    let dir = tempfile::tempdir().expect("dir");
    let (rig, store, seams, directory) = session_over(dir.path()).await;
    let messages = json!([
        { "role": "user", "content": "Continue my work." },
        { "role": "assistant", "content": "Previous answer.", "meta": { "transcript": { "provider": "anthropic-oauth", "modelId": "claude-fable-5-1" } } },
    ]);
    stored_session(&directory, &conversation("source", SOURCE_ROUTE, 200_000, messages.clone())).await;
    stored_session(&directory, &conversation("heir", HEIR_ROUTE, 200_000, json!([]))).await;
    let answer = call(&directory, "thread/fork", json!({ "threadId": "source", "intoThreadId": "heir", "opId": "op-inherit" })).await.expect("inherited");
    assert_eq!(answer["thread"]["id"], json!("heir"));
    assert_eq!(answer["thread"]["forkedFromId"], json!("source"));
    assert_eq!(answer["messages"], json!(2), "the two messages of the conversation");
    assert_eq!((answer["provider"].clone(), answer["model"].clone()), (json!("openai-oauth"), json!("gpt-6-astra")), "the heir keeps its own route");
    assert_eq!(model_messages(&directory, "source").await, messages, "the source keeps its conversation as it was");
    assert_eq!(pairs(&model_messages(&directory, "heir").await), pairs(&messages), "the heir holds the source's conversation");
    let live = rows(&directory, "heir", None).await;
    let boundary = live.last().expect("rows");
    assert_eq!(
        (boundary["kind"].clone(), boundary["label"].clone()),
        (json!("statusdone"), json!("Session inherited")),
        "the inheritance is shown as a boundary row last"
    );
    assert_eq!(texts_of_kind(&live), ["Continue my work.", "Previous answer."]);
    let reopened = inheriting_directory(&rig, store, seams).await;
    assert_eq!(rows(&reopened, "heir", None).await, live, "a restarted core shows the same rows");
}

fn texts_of_kind(rows: &[Value]) -> Vec<String> {
    rows.iter().filter_map(|row| row["text"].as_str().map(str::to_owned)).collect()
}

/// `plan_carry`: a conversation whose `used` reaches the heir's `limit` is compacted, and when no compaction comes of it (the rig's compactor answers no
/// rows) refused with `fit_message`. `limit` is `CompactPolicy::trigger_tokens` of the heir's header: boundary min(1000, 1000) = 1000, target 1000 (the
/// 4,000 floor is capped at the boundary), so the trigger stays at the boundary. `used` is `(estimate + request reserve) * calibration` with the
/// estimate at least a quarter of the text's length: the 10,000-character message is at least 2,500 tokens, above 1,000.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conversation_the_heir_cannot_hold_is_refused_and_leaves_the_heir_empty() {
    let dir = tempfile::tempdir().expect("dir");
    let (_rig, _store, _seams, directory) = session_over(dir.path()).await;
    let long = "Too large for this heir. ".repeat(400);
    stored_session(&directory, &conversation("source", SOURCE_ROUTE, 200_000, json!([{ "role": "user", "content": long }]))).await;
    stored_session(&directory, &conversation("heir", ("openai", "small"), 1000, json!([]))).await;
    let refused = call(&directory, "thread/fork", json!({ "threadId": "source", "intoThreadId": "heir", "opId": "op-inherit" })).await;
    let Err(CoreError::DomainError { message, .. }) = refused else { panic!("the inheritance is refused: {refused:?}") };
    let message = message.map(|m| m.to_string()).unwrap_or_default();
    assert!(
        message.starts_with("inheritFrom: the full conversation needs ") && message.ends_with(" tokens but openai/small allows 1000 before compaction"),
        "{message}"
    );
    assert_eq!(model_messages(&directory, "heir").await, json!([]), "the heir holds no message");
    assert!(rows(&directory, "heir", None).await.is_empty(), "and shows no row");
    let stored = directory.stored_header(&ThreadId::from("heir")).await.expect("the heir");
    assert_eq!(stored.get("inheritedFromSessionId"), None, "nothing of the inheritance was saved");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_core_over_one_data_directory_writes_its_config_and_snapshots_there_and_nowhere_else() {
    let (first, second) = (tempfile::tempdir().expect("first"), tempfile::tempdir().expect("second"));
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let publisher = || Arc::new(mixdog_core_api::mock::MockStatePublisher::default());
    let (running_first, _) = Config::open(crate::compose_flip::config_file(first.path()), publisher(), lanes).await.expect("the first config");
    let (config, _) = Config::open(crate::compose_flip::config_file(second.path()), publisher(), lanes).await.expect("the second config");
    config
        .update(|doc| {
            doc.insert("retarget-probe".into(), json!({ "ok": true }));
            Ok(())
        })
        .await
        .expect("the section is written");
    assert_eq!(config.full().get("retarget-probe"), Some(&json!({ "ok": true })));
    assert!(second.path().join("mixdog-config.json").exists());
    assert!(!first.path().join("mixdog-config.json").exists(), "nothing is written into the other directory");
    let review = mixdog_core_review::turn_review::testing::review_at(second.path());
    let turn = json!({ "baselineTree": "abc", "root": second.path().to_string_lossy() });
    review.store().save_turn_snapshot_record("retarget-session", turn.as_object().expect("turn")).await;
    assert!(second.path().join("turn-snapshots").exists());
    assert!(!first.path().join("turn-snapshots").exists());
    assert!(running_first.full().get("retarget-probe").is_none());
}
