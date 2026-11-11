//! Node's K1 recordings of the session host replayed against the pieces the daemon composes:
//! `fixtures/data-dir-retarget-cases` (`record-data-dir-retarget-cases.mjs`) and `fixtures/session-inheritance-cases`
//! (`record-session-inheritance-cases.mjs`), both of `b6f10295a`.
//!
//! What is compared is what a client can observe of the core: the configuration file and turn snapshots of the data directory
//! the core runs over; for an inheritance, the `thread/fork` answer or refusal, the heir's model messages
//! (`thread/modelMessages/list`) and its transcript rows (`thread/items/list`, live and read back from the store by a directory
//! opened again), each row as the shipped client folds it (`packages/protocol-client/src/rows.ts` `rowOf`).
#![allow(clippy::disallowed_methods, reason = "test setup: temp directories and the recorded fixtures")]

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
use mixdog_testkit::exact::Exact;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn recorded(set: &str) -> Exact {
    let text = match set {
        "data-dir-retarget-cases" => mixdog_testkit::fixture!("../../fixtures/data-dir-retarget-cases/golden.json"),
        "session-inheritance-cases" => mixdog_testkit::fixture!("../../fixtures/session-inheritance-cases/golden.json"),
        "session-host-transcript-page-cases" => mixdog_testkit::fixture!("../../fixtures/session-host-transcript-page-cases/golden.json"),
        other => panic!("no recording {other}"),
    };
    Exact::decode(&serde_json::from_str::<Value>(text).expect("golden.json")).expect("exact")
}

fn observed(set: &str, name: &str) -> Exact {
    let golden = recorded(set);
    let found = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == name).cloned();
    found.unwrap_or_else(|| panic!("{set}: no recorded case {name:?}")).get("observed").clone()
}

fn plain(value: &Exact) -> Value {
    value.to_plain().expect("a plain recorded value")
}

// ---- session-host-transcript-page -------------------------------------------------------------------------------------

/// The recorded session of `record-session-host-transcript-page-cases.mjs`: 300 assistant rows `c0`..`c299`, each `row <id> ` fifty
/// times, stored as the thread's conversation.
async fn paged_session(directory: &SessionDirectory, extra: &[&str]) {
    let id = ThreadId::from("sess_page_host");
    directory.create_with_id(id.clone(), Header::new(), json!({})).await.expect("created");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let text = |row: &str| format!("row {row} ").repeat(50);
    let messages: Vec<Value> = (0..300).map(|n| format!("c{n}")).chain(extra.iter().map(|row| (*row).to_owned())).map(|row| json!({ "role": "assistant", "content": text(&row) })).collect();
    let append = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") };
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

/// The recorded rows of this set, their text as a stored message restores: the recorder handed its scripted rows to the host
/// untrimmed, where a stored assistant message restores as its trimmed text in Node (`restoredAssistantTranscriptItems`,
/// `transcript-restore/restore.mjs`) as in the core (manifest `replay.normalised.rowText`).
fn recorded_page_rows(rows: &Exact) -> Vec<Value> {
    recorded_rows(rows)
        .into_iter()
        .map(|mut row| {
            if let Some(text) = row["text"].as_str() {
                row["text"] = json!(text.trim());
            }
            row
        })
        .collect()
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

/// Case "an older page crosses the daemon hop as the revealed rows only, and the host keeps its held copy": the client holds the newest
/// 32 rows (`heldBeforePage`); its older page (cursor: the oldest held row, 64 rows) answers only the 64 revealed rows (the recorded
/// `page.items`), and the held rows with them make the recorded 96-row window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_older_page_answers_only_the_revealed_rows_as_node_recorded() {
    let observed = observed("session-host-transcript-page-cases", "an older page crosses the daemon hop as the revealed rows only, and the host keeps its held copy");
    let (_dir, directory) = paged_directory(&[]).await;
    let (held, opened) = page(&directory, 32, None).await;
    assert_rows(&folded(&held), &recorded_page_rows(observed.get("heldBeforePage")), "the held rows");
    let read = &observed.get("reads").as_array()[0];
    let recorded_page = read.get("result").get("page");
    // The older page reads before the oldest held row: the opening page's onward cursor (its direction is older).
    let older = opened["nextCursor"].clone();
    assert!(older.is_string(), "the opening page names its older rows: {opened}");
    let (revealed, answer) = page(&directory, 64, Some(&older)).await;
    assert_rows(&folded(&revealed), &recorded_page_rows(recorded_page.get("items")), "the revealed rows");
    assert_eq!(answer["hasOlder"], json!(plain(recorded_page.get("state"))["transcriptHasOlder"]), "older rows remain");
    let window: Vec<Value> = revealed.iter().chain(held.iter()).cloned().collect();
    assert_rows(&folded(&window), &recorded_page_rows(observed.get("snapshot").get("items")), "the window the client holds");
}

/// Appends assistant rows to the open paged session the way the session's rows are written (`thread/inheritedRows/append`).
async fn append_page_rows(directory: &SessionDirectory, rows: &[&str]) {
    let handle = directory.open_handle(&ThreadId::from("sess_page_host"), &CallContext::internal("test")).await.expect("open");
    let messages: Vec<Value> = rows.iter().map(|row| json!({ "role": "assistant", "content": format!("row {row} ").repeat(50) })).collect();
    let append = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") };
    handle.request(append).await.expect("the rows are stored");
}

/// The rows after the newest held row (`sortDirection: asc` from its id): what the live feed adds to the client's window.
async fn newer_than(directory: &SessionDirectory, held: &[Value]) -> Vec<Value> {
    let last = held.last().expect("held rows")["id"].clone();
    let params = json!({ "threadId": "sess_page_host", "limit": 64, "byteBudget": 1_000_000, "cursor": last, "sortDirection": "asc" });
    call(directory, "thread/items/list", params).await.expect("the newer rows")["data"].as_array().expect("data").clone()
}

/// Case "a session that changed between reads answers the page in full": the client holds the newest 32 rows (`heldBeforePage`); two
/// rows are appended (the recorded `appendedRows`, the change between the opening read and the page read); the older page (64 rows) and
/// the rows after its newest held row are then read, and the window the client displays is the 98 rows they make (the two the older
/// page reveals beyond Node's 96, then Node's recorded `snapshot.items`). Node's host answered the page in full, the newest 96 rows; the
/// client that sees the tail move replaces its window by that same read (`transcript-history.test.mjs`, the pager's own detection), and
/// every row of both windows is compared with the recorded ones.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_changed_between_reads_shows_the_recorded_window_as_node_recorded() {
    let name = "a session that changed between reads answers the page in full";
    let observed = observed("session-host-transcript-page-cases", name);
    let older_page = self::observed("session-host-transcript-page-cases", "an older page crosses the daemon hop as the revealed rows only, and the host keeps its held copy");
    let (_dir, directory) = paged_directory(&[]).await;
    let (held, opened) = page(&directory, 32, None).await;
    assert_rows(&folded(&held), &recorded_page_rows(older_page.get("heldBeforePage")), &format!("{name}: the held rows"));
    let appended: Vec<String> = plain(observed.get("appendedRows")).as_array().expect("appended rows").iter().map(|row| row.as_str().expect("row").to_owned()).collect();
    append_page_rows(&directory, &appended.iter().map(String::as_str).collect::<Vec<_>>()).await;
    let (revealed, _) = page(&directory, 64, Some(&opened["nextCursor"])).await;
    let newer = newer_than(&directory, &held).await;
    assert_eq!(newer.len(), appended.len(), "{name}: the appended rows follow the newest held row");
    let displayed: Vec<Value> = revealed.iter().chain(held.iter()).chain(newer.iter()).cloned().collect();
    // The 98 rows on screen: the two older rows beyond Node's window, then the recorded 96.
    let recorded_older = recorded_page_rows(older_page.get("reads").as_array()[0].get("result").get("page").get("items"));
    let snapshot = observed.get("snapshot");
    let expected: Vec<Value> = recorded_older[..2].iter().cloned().chain(recorded_page_rows(snapshot.get("items"))).collect();
    assert_rows(&folded(&displayed), &expected, &format!("{name}: the 98 rows displayed"));
    // The replacing read: the newest 96 rows, Node's full answer whole.
    let (window, answer) = page(&directory, 96, None).await;
    assert_rows(&folded(&window), &recorded_page_rows(snapshot.get("items")), &format!("{name}: the window"));
    assert_eq!(answer["hasOlder"], json!(plain(snapshot)["transcriptHasOlder"]), "{name}: older rows remain");
}

/// Case "held rows that move while the page is in flight fall back to a full read": the page read is in flight (held before it reaches the
/// store) and the client's held rows move (the recorder dropped the first held row from the host's own copy; the core is not involved), the
/// read then answers the recorded page (the 64 rows before the oldest held row, Node's `reads[0].page.items`), and the full read the
/// client falls back to answers the recorded window whole (`reads[1].full`: the newest 96 rows and `transcriptHasOlder`). The
/// detection and the fallback are the client's pager (`transcript-history.test.mjs`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn held_rows_that_move_during_a_page_read_fall_back_to_a_full_read_as_node_recorded() {
    let name = "held rows that move while the page is in flight fall back to a full read";
    let observed = observed("session-host-transcript-page-cases", name);
    let reads = observed.get("reads").as_array();
    let (_dir, directory, store) = counted_paged_directory(&[]).await;
    let (mut held, opened) = page(&directory, 32, None).await;
    let mut in_flight = store.hold("history_rows");
    let reader = {
        let (directory, cursor) = (directory.clone(), opened["nextCursor"].clone());
        tokio::spawn(async move { page(&directory, 64, Some(&cursor)).await })
    };
    in_flight.entered("history_rows").await;
    // The recorded movement: the held copy loses its first row while the read is in flight.
    held.remove(0);
    in_flight.release();
    let (revealed, _) = reader.await.expect("the page read finished");
    assert_rows(&folded(&revealed), &recorded_page_rows(reads[0].get("result").get("page").get("items")), &format!("{name}: the page the read answered"));
    let (window, answer) = page(&directory, 96, None).await;
    let full = reads[1].get("result").get("full");
    assert_rows(&folded(&window), &recorded_page_rows(full.get("items")), &format!("{name}: the full read"));
    assert_eq!(answer["hasOlder"], json!(plain(full)["transcriptHasOlder"]), "{name}: older rows remain");
    assert_rows(&folded(&window), &recorded_page_rows(observed.get("snapshot").get("items")), &format!("{name}: the snapshot"));
    assert_eq!(held.len(), 31, "{name}: the client's held copy moved");
}
// ---- data-dir-retarget ------------------------------------------------------------------------------------------------

/// Case "config and turn snapshot records follow a runtime MIXDOG_DATA_DIR retarget". Node read `MIXDOG_DATA_DIR` at each call,
/// so a process whose variable moved from a first directory to a second wrote only into the second. The core is composed over
/// one data directory (`compose_flip::config_file`, `TurnReview::over_scm`): the core started over the second directory writes
/// the section into `<second>/mixdog-config.json` (Node's whole file text) and its turn snapshot under `<second>/turn-snapshots`,
/// and nothing into the first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_config_and_turn_snapshots_follow_the_data_directory_as_node_recorded() {
    let observed = observed("data-dir-retarget-cases", "config and turn snapshot records follow a runtime MIXDOG_DATA_DIR retarget");
    let (first, second) = (tempfile::tempdir().expect("first"), tempfile::tempdir().expect("second"));
    let rel = |path: &std::path::Path| {
        let text = path.to_string_lossy().replace(&*first.path().to_string_lossy(), "<first>").replace(&*second.path().to_string_lossy(), "<second>");
        text.replace('\\', "/")
    };
    let after_first = rel(&crate::compose_flip::config_file(first.path()));
    let after_second = rel(&crate::compose_flip::config_file(second.path()));
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    // The instance over the first directory is running (and stays so to the end) while the second is used: the first directory
    // stays untouched. Node's single process moved its variable; the core has one directory per composed instance, and the
    // instance of the second directory is the one that now takes the writes (manifest `replay.retarget`).
    let (running_first, _) = Config::open(crate::compose_flip::config_file(first.path()), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes)
        .await
        .expect("the config of the first directory");
    let (config, _) = Config::open(crate::compose_flip::config_file(second.path()), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes)
        .await
        .expect("the config of the second directory");
    config
        .update(|doc| {
            doc.insert("retarget-probe".into(), json!({ "ok": true }));
            Ok(())
        })
        .await
        .expect("the section is written");
    let read_back = config.full().get("retarget-probe").cloned().unwrap_or(Value::Null);
    let file_text = std::fs::read_to_string(second.path().join("mixdog-config.json")).expect("the second directory's config file");
    let review = mixdog_core_review::turn_review::testing::review_at(second.path());
    let turn = json!({ "baselineTree": "abc", "root": second.path().to_string_lossy() });
    let saved = review.store().save_turn_snapshot_record("retarget-session", turn.as_object().expect("turn")).await;
    let rust = json!({
        "configPathAfterFirst": after_first,
        "configPathAfterSecond": after_second,
        "config": {
            "secondHasFile": second.path().join("mixdog-config.json").exists(),
            "firstHasFile": first.path().join("mixdog-config.json").exists(),
            "readBack": read_back,
            "fileText": file_text,
        },
        "snapshot": {
            "saved": saved,
            "secondHasDir": second.path().join("turn-snapshots").exists(),
            "firstHasDir": first.path().join("turn-snapshots").exists(),
        },
    });
    assert_eq!(Exact::plain(&rust), observed);
    assert!(running_first.full().get("retarget-probe").is_none(), "the running first instance never saw the second directory's section");
}

// ---- session-inheritance ----------------------------------------------------------------------------------------------

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
    let (config, _) = Config::open(dir.join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("config");
    let agents = AgentDefinitions::new(dir, dir, tokens.interactive_io, AgentRoutes::new(config.clone(), dir), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.join("workspace"));
    Arc::new(ConfigRunSeams::new(config, Arc::new(agents), dir.to_path_buf(), dir.to_path_buf(), Arc::new(|_| None)))
}

/// A carry into an existing heir measures the heir session itself: no route windows are read.
struct NoWindows;

impl RouteWindows for NoWindows {
    fn window(&self, _: &str, _: &str, _: &Value) -> Option<ContextMeta> {
        None
    }
}

/// The recorded conversations are text only.
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
/// recorded heir's (`tools: []`); the meter is the text-only conversation's.
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
        let append = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": rows }), op: None, ctx: CallContext::internal("test") };
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

/// A row's id is the core's own (an item id of its record), where Node's restore numbered rows by message position
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

fn recorded_rows(rows: &Exact) -> Vec<Value> {
    without_ids(plain(rows).as_array().expect("rows"))
}

/// The core's rows, compared with recorded ones as the recording encodes values (a number is a JS number); the first row that
/// differs is named.
fn assert_rows(rust: &[Value], recorded: &[Value], what: &str) {
    let rust: Vec<Value> = rust.iter().map(|row| plain(&Exact::plain(row))).collect();
    if let Some(at) = (0..rust.len().max(recorded.len())).find(|&n| rust.get(n) != recorded.get(n)) {
        panic!("{what}: {} rows, recorded {}; row {at} differs:\n  core: {:?}\n  node: {:?}", rust.len(), recorded.len(), rust.get(at), recorded.get(at));
    }
}

/// Case "successful inheritance restores its boundary": `inheritFrom` of a two-message conversation into an empty heir on another
/// provider, through `thread/fork` into the existing heir. The answer, the heir's model messages and its rows (with the inheritance
/// boundary row), live and read back by a directory opened again over the same store, are Node's; the source keeps its conversation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_successful_inheritance_restores_its_boundary_as_node_recorded() {
    let observed = observed("session-inheritance-cases", "successful inheritance restores its boundary");
    let (source, target) = (plain(observed.get("source")), plain(observed.get("targetBefore")));
    let dir = tempfile::tempdir().expect("dir");
    let rig = Rig::new();
    rig.clock.0.store(1_800_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let store = real_store(&dir.path().join("data")).await;
    let seams = run_seams(dir.path()).await;
    let directory = inheriting_directory(&rig, store.clone(), seams.clone()).await;
    stored_session(&directory, &source).await;
    stored_session(&directory, &target).await;
    let answer = call(&directory, "thread/fork", json!({ "threadId": "source", "intoThreadId": "heir", "opId": "op-inherit" })).await.expect("inherited");
    // `thread/fork` answers the heir's summary: its id, and the source it inherited from (`forkedFromId`).
    let result = json!({
        "sessionId": answer["thread"]["id"],
        "sourceSessionId": answer["thread"]["forkedFromId"],
        "messages": answer["messages"],
        "provider": answer["provider"],
        "model": answer["model"],
    });
    assert_eq!(Exact::plain(&result), *observed.get("inheritFromResult"), "the answer");
    let recorded_source: Vec<Value> = plain(observed.get("sourceAfter"))["messages"].as_array().expect("messages").clone();
    assert_eq!(model_messages(&directory, "source").await, json!(recorded_source), "the source keeps its conversation");
    // Node's heir holds its own system block first (`targetBefore`), which an inheritance leaves as it was (it carries only the
    // source's conversation, `inheritable`); the core keeps no system block in a thread's stored messages (the run builds it per
    // request), so the recorded blocks are shown unchanged and the conversation after them is compared whole (manifest
    // `replay.normalised.systemBlock`).
    let recorded_target = plain(observed.get("targetMessages"));
    let (recorded_system, target_messages): (Vec<Value>, Vec<Value>) = recorded_target.as_array().expect("messages").iter().cloned().partition(|m| m["role"] == "system");
    let before_system: Vec<Value> = target.get("messages").and_then(Value::as_array).expect("messages").clone();
    assert_eq!(recorded_system, before_system, "the heir's system block is the one it had before");
    assert_eq!(&recorded_target.as_array().expect("messages")[..recorded_system.len()], &recorded_system[..], "the system block stays first");
    assert_eq!(Exact::plain(&model_messages(&directory, "heir").await), Exact::plain(&json!(target_messages)), "the heir's model messages");
    let restored = observed.get("restored");
    assert_rows(&without_ids(&rows(&directory, "heir", None).await), &recorded_rows(restored.get("live").get("items")), "the live rows");
    assert_rows(&without_ids(&rows(&directory, "heir", Some(1)).await), &recorded_rows(restored.get("live").get("itemLimit1")), "the live newest row");
    // Read back from the store by a directory of its own: what a restarted core shows.
    let reopened = inheriting_directory(&rig, store, seams).await;
    assert_rows(&without_ids(&rows(&reopened, "heir", None).await), &recorded_rows(restored.get("persisted").get("items")), "the stored rows");
    assert_rows(&without_ids(&rows(&reopened, "heir", Some(1)).await), &recorded_rows(restored.get("persisted").get("itemLimit1")), "the stored newest row");
}

/// Case "rejected inheritance does not persist or display a successful boundary": a conversation the small heir cannot hold before
/// compaction is refused with Node's measured sentence; the heir holds no message and shows no row, also read back from the store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_inheritance_persists_and_shows_nothing_as_node_recorded() {
    let observed = observed("session-inheritance-cases", "rejected inheritance does not persist or display a successful boundary");
    let (source, target) = (plain(observed.get("sourceSession")), plain(observed.get("target")));
    let dir = tempfile::tempdir().expect("dir");
    let rig = Rig::new();
    rig.clock.0.store(1_800_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let store = real_store(&dir.path().join("data")).await;
    let seams = run_seams(dir.path()).await;
    let directory = inheriting_directory(&rig, store.clone(), seams.clone()).await;
    stored_session(&directory, &source).await;
    stored_session(&directory, &target).await;
    let refused = call(&directory, "thread/fork", json!({ "threadId": "source", "intoThreadId": "heir", "opId": "op-inherit" })).await;
    let outcome = match refused {
        Err(CoreError::DomainError { message, .. }) => json!({ "rejected": { "name": "Error", "message": message } }),
        other => panic!("the inheritance is refused: {other:?}"),
    };
    let recorded = match observed.get("outcome").get("rejected") {
        Exact::Error { name, message, .. } => json!({ "rejected": { "name": name, "message": message } }),
        other => panic!("a recorded rejection: {other:?}"),
    };
    assert_eq!(outcome, recorded, "the refusal");
    assert_eq!(Exact::plain(&model_messages(&directory, "heir").await), *observed.get("targetMessagesAfter"), "the heir's model messages");
    assert_eq!(Exact::plain(&json!(rows(&directory, "heir", None).await)), *observed.get("restoredAfter"), "the heir's rows");
    let stored = directory.stored_header(&ThreadId::from("heir")).await.expect("the heir");
    assert_eq!((stored.get("inheritedFromSessionId"), observed.get("saved").as_bool()), (None, false), "nothing of the inheritance was saved");
    let reopened = inheriting_directory(&rig, store, seams).await;
    assert_eq!(Exact::plain(&json!(rows(&reopened, "heir", None).await)), *observed.get("restoredAfter"), "the heir's stored rows");
}
