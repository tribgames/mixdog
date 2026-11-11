//! A turn's save failing, or its process dying, against the Node recording `fixtures/turn-durability`
//! (`record-turn-durability.mjs`, `b6f10295a`, exact manifest).
//!
//! Node ran a real `askSession` turn with a scripted provider and, per case, made the session log's writes fail from the
//! answer on (`save-failure`, the same process going on), or killed its process at one point between the first request
//! and the turn's completion record, then read the session in a new process as a desktop or phone read does. This drives
//! the real Rust stack the same way: the session actor over the run host's factory (the loop, the scripted provider, a
//! `read` tool) over the real store, with the store's barrier hook (`mixdog-store` `crash-hook`): the save failure as writes
//! the disk stops half way (and a rollback that fails), and each crash in a child process that exits at the point Node was
//! killed; the next process opens the thread (the recovery at open) and reads it twice.
//!
//! Compared per step, whole: the items a client is shown (`thread/read`, the snapshot desktop and phone render, each Node
//! row as the wire item Rust holds for it, see `wire_of`), the model context on disk (`thread/modelMessages/list` against
//! Node's durable `messages`), whether the thread is busy (Node's `stage`), the refusal of a turn (code and text), and the
//! requests sent. Node's `system` messages are left out of the messages compared: they are the request's assembled
//! prompt, which Rust assembles per request and does not keep in the session.
#![allow(clippy::disallowed_methods, reason = "replay setup: the recording, the child process and its files")]

use std::collections::VecDeque;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_store::fsio::AppendStep;
use mixdog_store::schema::record::RunPhase;

use super::*;

const GOLDEN: &str = include_str!("../../../../fixtures/turn-durability/golden.json");
const CRASHED: i32 = 77;
const READ_TEXT: &str = "[lines 1-1]\nFILE-SENTINEL\n[lines 1-1 of 1]";

type OnSend = Arc<dyn Fn(usize) -> Pin<Box<dyn Future<Output = Play> + Send>> + Send + Sync>;

/// One response: its events, then the end of the stream, or a stream that never ends (the process dies on it).
struct Play {
    events: VecDeque<StreamEvent>,
    hang: bool,
}

#[async_trait]
impl ModelStream for Play {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if let Some(event) = self.events.pop_front() {
            return Some(Ok(event));
        }
        if self.hang {
            std::future::pending::<()>().await;
        }
        None
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

struct Stub {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    sends: AtomicUsize,
    on_send: OnSend,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
}

#[async_trait]
impl ProviderAdapter for Stub {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        lock(&self.requests).push(request);
        let n = self.sends.fetch_add(1, Ordering::SeqCst) + 1;
        SENDS.store(n, Ordering::SeqCst);
        Ok(Box::new((self.on_send)(n).await))
    }
}

fn stub(on_send: OnSend) -> Arc<Stub> {
    Arc::new(Stub {
        id: ProviderId::from("durability-stub"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        sends: AtomicUsize::new(0),
        on_send,
        requests: Mutex::new(Vec::new()),
    })
}

fn answer(text: &str) -> Play {
    Play { events: VecDeque::from([StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]), hang: false }
}

/// The `read` the recording's tool round called; it answers what Node's `read` answered for the case's file.
struct ReadStub(ToolSpec);

#[async_trait]
impl Tool for ReadStub {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(READ_TEXT.into())], ..ToolOutput::default() })
    }
}

fn read_tool() -> Arc<dyn Tool> {
    Arc::new(ReadStub(ToolSpec {
        name: "read".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "read".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }))
}

/// The recording's clock: the run's process at `1_800_000_000_000`, the next one ten minutes later.
struct At(i64);
impl Clock for At {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

struct Timed(Parts, i64);

#[async_trait]
impl RunParts for Timed {
    async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        self.0.reconcile_turn(thread, header, conversation).await
    }
    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let mut assembled = self.0.assemble(input).await?;
        assembled.clock = Arc::new(At(self.1));
        Ok(assembled)
    }
}

const RUN_AT: i64 = 1_800_000_000_000;
const REOPEN_AT: i64 = 1_800_000_600_000;

/// A session stack over `store` with the run host's factory over `provider`, at `now`.
fn stack(rig: &Rig, store: Arc<dyn mixdog_core_session::session::ThreadStore>, provider: Arc<Stub>, workspace: &Path, now: i64) -> SessionDirectory {
    rig.clock.0.store(now as u64, Ordering::SeqCst);
    let mut deps = rig.deps_parts(store);
    deps.transcript = Arc::new(mixdog_core_session::session::transcript::RecordTranscript::new());
    let parts = Parts { provider, workspace: workspace.to_path_buf(), more: vec![read_tool()], settle: None };
    deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Timed(parts, now))));
    SessionDirectory::new(Arc::new(deps))
}

async fn start(directory: &SessionDirectory, workspace: &Path) -> Arc<mixdog_core_session::session::SessionHandle> {
    start_with(directory, json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.to_string_lossy() })).await
}

/// The session record's route (`createSession({ provider: 'durability-stub', model: 'stub-model' })`), which an heir's
/// inheritance boundary names. The rig's route seam seats none; it is set after the turn, whose rows Node's recording stamps
/// with no route.
async fn route(handle: &mixdog_core_session::session::SessionHandle) {
    let set = json!({ "provider": "durability-stub", "model": "stub-model" });
    let patch = CoreRequest {
        method: Method("thread/header/patch"),
        params: json!({ "threadId": ThreadHandle::id(handle).as_str(), "set": set, "unset": [] }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    handle.request(patch).await.expect("thread/header/patch");
}

async fn start_with(directory: &SessionDirectory, params: Value) -> Arc<mixdog_core_session::session::SessionHandle> {
    let reply = directory
        .request(request("thread/start", params, "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    directory.handle(&id).expect("loaded")
}

async fn ask(handle: &mixdog_core_session::session::SessionHandle, prompt: &str, op: &str) -> Result<Reply, mixdog_core_api::CoreError> {
    handle.request(request("turn/start", json!({ "threadId": ThreadHandle::id(handle).as_str(), "opId": op, "input": { "prompt": prompt } }), op)).await
}

/// What a client is shown and what is on disk: the snapshot (`thread/read`) and the stored model context.
async fn observe(directory: &SessionDirectory, handle: &mixdog_core_session::session::SessionHandle) -> Value {
    let read = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": ThreadHandle::id(handle).as_str() }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(read) = handle.request(read).await.expect("thread/read") else { panic!("thread/read answers a value") };
    let messages = CoreRequest { method: Method("thread/modelMessages/list"), params: json!({ "threadId": ThreadHandle::id(handle).as_str(), "start": 0 }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(messages) = directory.request(messages).await.expect("thread/modelMessages/list") else { panic!("a value") };
    json!({ "items": read["items"], "state": read["state"], "disk": messages["messages"] })
}

/// Waits until `probe` holds, woken by each step of the thread's actor.
async fn until(handle: &mixdog_core_session::session::SessionHandle, what: &str, mut probe: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let stepped = handle.stepped().notified();
            tokio::pin!(stepped);
            stepped.as_mut().enable();
            if probe().await {
                return;
            }
            stepped.await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never reached: {what}"));
}

fn busy(view: &Value) -> bool {
    view["state"]["runtime"]["busy"] == true
}

// ---- the crash child ---------------------------------------------------------------------------------------------------------

static CASE: std::sync::OnceLock<(String, std::path::PathBuf)> = std::sync::OnceLock::new();
/// The requests the child sent; written beside its data when it is killed.
static SENDS: AtomicUsize = AtomicUsize::new(0);
/// The run's start is synced (`crash-before-output` dies on it).
static STARTED: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// What the hook saw synced: the run's start, a tool row, and the run's drafted text.
static SEEN: Mutex<(bool, bool, String)> = Mutex::new((false, false, String::new()));

fn has_run(records: &[Record], phase: RunPhase) -> bool {
    records.iter().any(|record| matches!(record, Record::Run(run) if run.phase == phase))
}

fn has_role(records: &[Record], role: &str) -> bool {
    records.iter().any(|record| matches!(record, Record::Item(item) if item.role.as_ref().is_some_and(|r| r.as_str() == role)))
}

fn drafts(records: &[Record]) -> impl Iterator<Item = &Value> {
    records.iter().filter_map(|record| match record {
        Record::Draft(draft) => match &draft.body {
            Slot::Inline(body) => Some(body),
            Slot::Blob(_) => None,
        },
        _ => None,
    })
}

/// The disk refuses writes (`save-failure`): each barrier's write stops half way with `EIO: injected`.
static DISK_FAILS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Rollbacks still to fail: the first failed write's rollback fails too, so that batch's outcome is unknown until the next
/// barrier truncates it.
static ROLLBACKS_FAILING: AtomicUsize = AtomicUsize::new(0);
/// Every step of every barrier, in order, with its records' kinds: what the save-failure replay shows of the writer.
static STEPS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The store's barrier hook of this process, installed once: the save failure, or a crash child's kill points.
fn install_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| mixdog_store::fsio::set_append_hook(hook));
}

fn hook(step: AppendStep, records: &[Record]) -> std::io::Result<()> {
    if CASE.get().is_some() {
        return crash_hook(step, records);
    }
    let fails = DISK_FAILS.load(Ordering::SeqCst);
    let fault = match step {
        AppendStep::Write if fails => Some("EIO: injected"),
        AppendStep::Truncate if ROLLBACKS_FAILING.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() => Some("EIO: rollback injected"),
        _ => None,
    };
    lock(&STEPS).push(format!("{step:?}{}", if fault.is_some() { " fails" } else { "" }));
    fault.map_or(Ok(()), |fault| Err(std::io::Error::other(fault)))
}

/// `crash-sealed-unsaved`: from the seal on, every save of the session fails (`EIO: injected`), as Node's session saves
/// failed after its checkpoint journal held the sealed answer; the one log keeps the seal and nothing after it.
static SESSION_SAVES_FAIL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Node's kill points as the boundaries of the session log's barriers.
fn crash_hook(step: AppendStep, records: &[Record]) -> std::io::Result<()> {
    let Some((case, _)) = CASE.get() else { return Ok(()) };
    let case = case.as_str();
    let die = || kill(&format!("{step:?}"));
    lock(&STEPS).push(format!(
        "{step:?} {}",
        records.iter().map(|record| format!("{record:?}").chars().take(45).collect::<String>()).collect::<Vec<_>>().join(" + ")
    ));
    match step {
        AppendStep::Write => match case {
            // The finished message and its seal were not written: what streamed of it is the draft's.
            "crash-answer-streamed" if has_role(records, "assistant") || drafts(records).any(|body| body.get("sealed").is_some()) => die(),
            // Once the seal is on disk the session's saves fail; the process dies once the turn has ended (`crash_child`).
            "crash-sealed-unsaved" | "resume-held" if SESSION_SAVES_FAIL.load(Ordering::SeqCst) => return Err(std::io::Error::other("EIO: injected")),
            _ => {}
        },
        AppendStep::Synced => {
            let mut seen = lock(&SEEN);
            if has_run(records, RunPhase::Started) {
                seen.0 = true;
                STARTED.notify_one();
            }
            seen.1 |= has_role(records, "tool");
            for body in drafts(records) {
                seen.2.push_str(body.get("text").and_then(Value::as_str).unwrap_or_default());
            }
            let follow_up_on_wire = seen.1 && drafts(records).any(|body| body.get("tools") == Some(&Value::Bool(false)));
            match case {
                "crash-mid-stream" if seen.2 == "partial streamed answer" => die(),
                "crash-tool-wire" if follow_up_on_wire => die(),
                "crash-saved-uncleared" if has_run(records, RunPhase::Completed) => die(),
                "crash-sealed-unsaved" | "resume-held" if drafts(records).any(|body| body.get("sealed").is_some()) => {
                    assert!(!has_role(records, "assistant"), "the seal is written before the answer's row");
                    SESSION_SAVES_FAIL.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
        }
        AppendStep::Sync | AppendStep::Truncate => {}
    }
    Ok(())
}

/// The process dies where Node's was killed, after writing how many requests it sent.
fn kill(at: &str) -> ! {
    let (case, dir) = CASE.get().expect("a crash child");
    std::fs::write(dir.join("sends"), SENDS.load(Ordering::SeqCst).to_string()).unwrap();
    eprintln!("[turn-durability] {case}: killed at {at}");
    std::process::exit(CRASHED)
}

/// The first process of a crash case, run by `crashes_replay_as_node_recovers` with `TD_CASE` set: runs the turn until the hook
/// kills it. Without `TD_CASE` (a test run of its own) it does nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_child() {
    let (Ok(case), Ok(dir)) = (std::env::var("TD_CASE"), std::env::var("TD_DIR")) else { return };
    let dir = std::path::PathBuf::from(dir);
    CASE.set((case.clone(), dir.clone())).unwrap();
    install_hook();
    let on_send: OnSend = match case.as_str() {
        // Killed with the first request on the wire, once the turn's start is on disk.
        "crash-before-output" => Arc::new(|_| {
            Box::pin(async {
                tokio::time::timeout(Duration::from_secs(30), STARTED.notified()).await.expect("the turn's start is synced");
                kill("the first request")
            })
        }),
        "crash-mid-stream" => Arc::new(|_| Box::pin(async { Play { events: VecDeque::from([StreamEvent::TextDelta("partial ".into()), StreamEvent::TextDelta("streamed answer".into())]), hang: true } })),
        "crash-tool-wire" => Arc::new(|n| {
            Box::pin(async move {
                if n == 1 {
                    Play {
                        events: VecDeque::from([
                            StreamEvent::TextDelta("reading".into()),
                            StreamEvent::ToolCallDone(ToolCall { id: "call_read".into(), name: "read".into(), arguments: json!({ "path": "x.txt" }), native_type: None }),
                            StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                        ]),
                        hang: false,
                    }
                } else {
                    Play { events: VecDeque::new(), hang: true }
                }
            })
        }),
        "crash-answer-streamed" | "crash-saved-uncleared" | "crash-sealed-unsaved" | "resume-held" => Arc::new(|_| Box::pin(async { answer("answer") })),
        other => panic!("unknown case {other}"),
    };
    let rig = Rig::new();
    let store = real_store(&dir.join("data")).await;
    let workspace = dir.join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    let directory = stack(&rig, store, stub(on_send), &workspace, RUN_AT);
    let handle = start(&directory, &workspace).await;
    std::fs::write(dir.join("id"), ThreadHandle::id(&*handle).as_str()).unwrap();
    ask(&handle, "do the task", "op-1").await.expect("turn/start");
    // Node's `settleThenKill`: the turn ended with its terminal save failed, then the process dies.
    if case == "crash-sealed-unsaved" || case == "resume-held" {
        until(&handle, "the sealed turn ends", async || SESSION_SAVES_FAIL.load(Ordering::SeqCst) && !handle.turn_busy()).await;
        // A second client resuming the held thread in the owning process is served the thread's one view (`thread/resume`
        // subscribes to the cell `thread/read` reads).
        if case == "resume-held" {
            std::fs::write(dir.join("resumed.json"), observe(&directory, &handle).await.to_string()).unwrap();
        }
        kill("the turn's end");
    }
    let _ = tokio::time::timeout(Duration::from_secs(60), std::future::pending::<()>()).await;
    panic!("{case}: the case's kill point was not reached within 60 s; sends {}; barrier steps:\n{}", SENDS.load(Ordering::SeqCst), lock(&STEPS).join("\n"));
}

async fn real_store(data: &Path) -> Arc<dyn mixdog_core_session::session::ThreadStore> {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;

    std::fs::create_dir_all(data).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root))
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
    Arc::new(mixdog_core_session::session::StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"))
}

/// The next process: opens the thread (the recovery at open) and reads it, once settled.
async fn reopen(dir: &Path) -> Value {
    let id = ThreadId::from(std::fs::read_to_string(dir.join("id")).unwrap());
    let rig = Rig::new();
    let store = real_store(&dir.join("data")).await;
    let never: OnSend = Arc::new(|_| Box::pin(async { panic!("a reopened thread asks the provider nothing") }));
    let directory = stack(&rig, store, stub(never), &dir.join("work"), REOPEN_AT);
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("reopened");
    until(&handle, "the recovery at open", async || handle.recovered()).await;
    observe(&directory, &handle).await
}

// ---- the comparison ----------------------------------------------------------------------------------------------------------

fn cases() -> Vec<Value> {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    golden["cases"].as_array().unwrap().clone()
}

/// A minted id: a message, item, history row or session id, or a UUID (an attempt, a turn).
fn is_minted(text: &str) -> bool {
    let uuid = text.len() == 36 && text.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() });
    uuid || ["msg_", "itm_", "hist_", "sess_"].iter().any(|prefix| text.starts_with(prefix))
}

/// Each minted id, wherever it stands (also inside a text, as the session id in an error), as `<id:N>`, N its first appearance:
/// the two sides mint their own, and what is compared is which values are the same id.
fn named(value: &Value, seen: &mut Vec<String>) -> Value {
    match value {
        Value::String(text) => {
            let words: Vec<String> = text
                .split(' ')
                .map(|word| {
                    let core = word.trim_end_matches(':');
                    if !is_minted(core) {
                        return word.to_owned();
                    }
                    let at = seen.iter().position(|id| id == core).unwrap_or_else(|| {
                        seen.push(core.to_owned());
                        seen.len() - 1
                    });
                    format!("<id:{at}>{}", &word[core.len()..])
                })
                .collect();
            Value::String(words.join(" "))
        }
        Value::Array(values) => Value::Array(values.iter().map(|value| named(value, seen)).collect()),
        // Keys in one order: member order is not part of a JSON object.
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), named(&map[key], seen))).collect())
        }
        other => other.clone(),
    }
}

/// A Node display row without its own id; `finalAssistantId` names the position of the row it points at.
fn node_rows(items: &Value) -> Vec<Value> {
    let rows = items.as_array().unwrap();
    rows.iter()
        .map(|row| {
            let mut row = row.as_object().unwrap().clone();
            row.shift_remove("id");
            // The tool card's open/closed state is the client's (`expanded`), not the session's.
            row.shift_remove("expanded");
            if let Some(target) = row.get("finalAssistantId").cloned() {
                row.insert("finalAssistantId".into(), json!(rows.iter().position(|other| other["id"] == target)));
            }
            Value::Object(row)
        })
        .collect()
}

/// The Node display row a client builds from a wire item (`packages/protocol-client/src/rows.ts`), in the fields Node's row has.
fn rust_rows(items: &Value) -> Vec<Value> {
    let items = items.as_array().unwrap();
    let pick = |item: &Value, keys: &[&str]| keys.iter().find_map(|key| item.pointer(key).filter(|value| !value.is_null()).cloned());
    items
        .iter()
        .map(|item| {
            let mut row = serde_json::Map::new();
            let mut put = |key: &str, value: Option<Value>| {
                if let Some(value) = value {
                    row.insert(key.to_owned(), value);
                }
            };
            match item["type"].as_str().unwrap() {
                "userMessage" => {
                    put("kind", Some(json!("user")));
                    put("text", item.get("displayText").cloned());
                    put("messageId", pick(item, &["/meta/messageId", "/meta/ext/messageId"]));
                    put("at", pick(item, &["/meta/at", "/meta/ext/at"]));
                }
                "agentMessage" => {
                    put("kind", Some(json!("assistant")));
                    put("text", item.get("text").cloned());
                    put("messageId", pick(item, &["/meta/messageId", "/meta/ext/messageId"]));
                    put("at", pick(item, &["/meta/at", "/meta/ext/at"]));
                }
                "toolCall" => {
                    let run = &item["run"];
                    put("kind", Some(json!("tool")));
                    put("name", item.get("name").cloned());
                    put("args", item.get("input").cloned());
                    put("count", run.get("count").cloned());
                    put("completedCount", run.get("completedCount").cloned());
                    put("at", pick(item, &["/meta/at", "/meta/ext/at"]));
                    put("startedAt", run.get("startedAt").cloned());
                    put("completedAt", run.get("completedAt").cloned());
                    put("callId", run.get("callId").cloned());
                    put("result", run.get("result").cloned());
                    put("isError", Some(run.get("isError").cloned().unwrap_or(json!(false))));
                    for key in ["errorCount", "callErrorCount", "exitErrorCount"] {
                        put(key, Some(run.get(key).cloned().unwrap_or(json!(0))));
                    }
                }
                "turnEnd" => {
                    put("kind", Some(json!("turndone")));
                    put("status", item.get("status").cloned());
                    put("elapsedMs", item.get("elapsedMs").cloned());
                    put("verb", item.get("verb").cloned());
                    put("attemptId", pick(item, &["/meta/ext/attemptId"]));
                    put("finalAssistantId", item.get("finalAssistantId").filter(|id| !id.is_null()).map(|target| json!(items.iter().position(|other| other["id"] == *target))));
                    put("at", pick(item, &["/meta/at", "/meta/ext/at"]));
                    put("messageId", pick(item, &["/meta/messageId", "/meta/ext/messageId"]));
                }
                "statusRow" => {
                    put("kind", item.get("kind").cloned());
                    put("status", pick(item, &["/meta/ext/status"]));
                    put("label", pick(item, &["/meta/label"]));
                    put("detail", pick(item, &["/meta/detail"]));
                    put("provider", pick(item, &["/meta/provider", "/meta/ext/provider"]));
                    put("modelId", pick(item, &["/meta/modelId", "/meta/model", "/meta/ext/modelId"]));
                    put("at", pick(item, &["/meta/at", "/meta/ext/at"]));
                }
                other => panic!("an item Node's rows have no kind for: {other}"),
            }
            Value::Object(row)
        })
        .collect()
}

/// Node's durable messages, the request's assembled system prompt left out (Rust assembles it per request and keeps none).
fn node_disk(messages: &Value) -> Vec<Value> {
    messages.as_array().unwrap().iter().filter(|message| message["role"] != "system").cloned().collect()
}

/// The stored model context, without what Rust's `turn/start` stamps on the input row beyond Node's
/// `persistedUserTranscriptMetadata` (its `checkpointId`, `device` and `completionVerb`, and the completion's `checkpointId`), which
/// this change does not touch.
fn rust_disk(messages: &Value) -> Vec<Value> {
    messages
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            let mut message = message.clone();
            // The cancel line's typed fact (`row_facts`), which Node reads from its text (`isTranscriptCancelledStatusText`).
            if let Some(meta) = message.get_mut("meta").and_then(Value::as_object_mut) {
                meta.shift_remove("turnEnd");
                if meta.is_empty() {
                    message.as_object_mut().unwrap().shift_remove("meta");
                }
            }
            if let Some(transcript) = message.pointer_mut("/meta/transcript").and_then(Value::as_object_mut) {
                for key in ["checkpointId", "device", "completionVerb"] {
                    transcript.shift_remove(key);
                }
                if let Some(completion) = transcript.get_mut("completion").and_then(Value::as_object_mut) {
                    completion.shift_remove("checkpointId");
                }
            }
            message
        })
        .collect()
}

/// One step as compared: the rows a client shows, the stored model context, whether the thread is busy.
fn node_step(step: &Value) -> Value {
    let mut seen = Vec::new();
    let rows = named(&json!(node_rows(&step["view"]["items"])), &mut seen);
    let disk = named(&json!(node_disk(&step["disk"]["messages"])), &mut seen);
    json!({ "rows": rows, "disk": disk, "busy": !step["stage"].is_null() })
}

fn rust_step(view: &Value) -> Value {
    let mut seen = Vec::new();
    let rows = named(&json!(rust_rows(&view["items"])), &mut seen);
    let disk = named(&json!(rust_disk(&view["disk"])), &mut seen);
    json!({ "rows": rows, "disk": disk, "busy": busy(view) })
}

fn same(case: &str, step: &Value, got: Value) {
    let mut want = node_step(step);
    // In the process that ran the turn, Node shows its live end row (`turnDoneItem`, `tui/session/turn.mjs:577`), which names
    // no message; the recorder's view is the stored-transcript projection, whose end row takes the answer's `messageId`. An
    // heir ran no turn: it shows its carried rows restored, end rows with their `messageId`.
    let label = step["step"].as_str().unwrap_or_default();
    if label != "reopened" && label != "read again" && !label.ends_with("(heir)") {
        for row in want["rows"].as_array_mut().unwrap() {
            if row["kind"] == "turndone" {
                row.as_object_mut().unwrap().shift_remove("messageId");
            }
        }
    }
    if got != want {
        let diff = format!("{case} / {}:\n got {}\nwant {}", step["step"], serde_json::to_string(&got).unwrap(), serde_json::to_string(&want).unwrap());
        lock(&DIFFS).push(diff);
    }
}

/// The steps that differ, reported together at the end of a replay.
static DIFFS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn no_diffs() {
    let diffs = std::mem::take(&mut *lock(&DIFFS));
    assert!(diffs.is_empty(), "{}", diffs.join("\n\n"));
}

// ---- the replays -------------------------------------------------------------------------------------------------------------

/// The save failure in one process over the real store: from the answer on, every barrier's write stops half way (the store's
/// barrier hook) and is rolled back, the first rollback failing too (an unknown outcome, truncated by the next barrier); the next
/// turn is refused while they fail, and runs once they land, each record written once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_save_replays_as_node_keeps_the_turn() {
    held_save("save-failure").await;
}

/// `save-failure-tool-rounds`: the saves fail from the first request on while the turn runs two tool rounds; nothing is
/// dropped or refused inside the running turn (Node holds the session whole, `turn-durability.mjs:15`), every record is held
/// and written once when the saves land.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn work_that_goes_on_while_saves_fail_is_held_whole() {
    held_save("save-failure-tool-rounds").await;
}

/// The plays of a held case's first turn; the first request makes the disk refuse writes (`save-failure` also fails the first
/// rollback: an unknown outcome).
fn held_plays(case: &str) -> OnSend {
    let rounds = case == "save-failure-tool-rounds";
    let rollback = case == "save-failure";
    Arc::new(move |n| {
        if n == 1 {
            if rollback {
                ROLLBACKS_FAILING.store(1, Ordering::SeqCst);
            }
            DISK_FAILS.store(true, Ordering::SeqCst);
        }
        let round = |text: &str, id: &str, path: &str| Play {
            events: VecDeque::from([
                StreamEvent::TextDelta(text.into()),
                StreamEvent::ToolCallDone(ToolCall { id: id.into(), name: "read".into(), arguments: json!({ "path": path }), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ]),
            hang: false,
        };
        let play = match n {
            1 if rounds => round("reading", "call_read", "x.txt"),
            2 if rounds => round("reading again", "call_read2", "y.txt"),
            _ => answer("answer"),
        };
        Box::pin(async move { play })
    })
}

fn rows_of(step: &Value) -> usize {
    step["view"]["items"].as_array().unwrap().len()
}

async fn held_save(name: &str) {
    let case = cases().into_iter().find(|case| case["name"] == name).unwrap();
    let steps = case["steps"].as_array().unwrap();
    install_hook();
    let rig = Rig::new();
    let provider = stub(held_plays(name));
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let store = real_store(data.path()).await;
    let directory = stack(&rig, store, provider.clone(), workspace.path(), RUN_AT);
    let handle = start(&directory, workspace.path()).await;
    let settled = |view: &Value, rows: usize| !busy(view) && view["items"].as_array().is_some_and(|items| items.len() == rows);

    ask(&handle, "first task", "op-1").await.expect("turn/start");
    // Settled, not only shown as ended: the next turn is otherwise queued behind its settlement.
    until(&handle, "the first turn settles", async || !handle.turn_busy() && settled(&observe(&directory, &handle).await, rows_of(&steps[0]))).await;
    same(name, &steps[0], rust_step(&observe(&directory, &handle).await));

    let refused = ask(&handle, "second task", "op-2").await.expect_err("refused while the first turn is not saved");
    let mixdog_core_api::CoreError::DomainError { code, message, .. } = &refused else { panic!("{refused:?}") };
    let mut seen = Vec::new();
    let got = named(&json!({ "code": code, "message": message }), &mut seen);
    let mut seen = Vec::new();
    let want = named(&json!({ "code": steps[1]["code"], "message": steps[1]["message"] }), &mut seen);
    assert_eq!(got, want, "the refusal");
    assert_eq!(provider.sends.load(Ordering::SeqCst), steps[1]["sends"].as_u64().unwrap() as usize, "the refused turn asks nothing");
    same(name, &steps[1], rust_step(&observe(&directory, &handle).await));

    DISK_FAILS.store(false, Ordering::SeqCst);
    ask(&handle, "second task", "op-3").await.expect("turn/start");
    until(&handle, "the second turn ends", async || settled(&observe(&directory, &handle).await, rows_of(&steps[2]))).await;
    assert_eq!(provider.sends.load(Ordering::SeqCst), steps[2]["sends"].as_u64().unwrap() as usize);
    same(name, &steps[2], rust_step(&observe(&directory, &handle).await));
    no_diffs();
    if name != "save-failure" {
        return;
    }
    // The writer went through each fault: a half write rolled back, a rollback that failed (truncated by the next barrier
    // before it wrote), half writes rolled back while the disk refused, then the held records written once (the stored
    // context above has each message once).
    let steps = lock(&STEPS).clone();
    let first = steps.iter().position(|step| step == "Write fails").expect("a write failed");
    assert_eq!(steps[first..first + 3], ["Write fails", "Truncate fails", "Truncate"], "the unknown outcome is truncated by the next barrier: {steps:?}");
    assert!(steps.iter().rev().take_while(|step| !step.ends_with("fails")).any(|step| step == "Synced"), "the held records landed: {steps:?}");
}

/// `fork-held`: a turn held by a failed save, forked (`thread/fork`, the desktop's `inheritSession`) while the saves fail and
/// after they recover; the heir as shown and as stored, and the source, compared after each.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_turn_forks_as_node_forks_it() {
    let name = "fork-held";
    let case = cases().into_iter().find(|case| case["name"] == name).unwrap();
    let steps = case["steps"].as_array().unwrap();
    install_hook();
    let rig = Rig::new();
    let provider = stub(held_plays(name));
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let store = real_store(data.path()).await;
    let directory = stack(&rig, store, provider.clone(), workspace.path(), RUN_AT);
    let handle = start(&directory, workspace.path()).await;
    ask(&handle, "first task", "op-1").await.expect("turn/start");
    until(&handle, "the first turn settles", async || {
        let view = observe(&directory, &handle).await;
        !handle.turn_busy() && !busy(&view) && view["items"].as_array().is_some_and(|items| items.len() == rows_of(&steps[0]))
    })
    .await;
    same(name, &steps[0], rust_step(&observe(&directory, &handle).await));
    route(&handle).await;
    for (n, step) in steps[1..].iter().enumerate() {
        if n == 1 {
            DISK_FAILS.store(false, Ordering::SeqCst);
        }
        let op = format!("op-fork-{n}");
        let forked = handle.request(request("thread/fork", json!({ "threadId": ThreadHandle::id(&*handle).as_str(), "opId": op }), &op)).await;
        let label = step["step"].as_str().unwrap();
        match forked {
            Ok(Reply::Value(reply)) => {
                let (got, want) = (json!({ "forked": true, "messages": reply["messages"] }), json!({ "forked": step["forked"], "messages": step["messages"] }));
                if got != want {
                    lock(&DIFFS).push(format!("{name} / {label}:\n got {got}\nwant {want}"));
                }
                let heir = ThreadId::from(reply["thread"]["id"].as_str().expect("the heir's id"));
                let heir = directory.open_handle(&heir, &CallContext::internal("test")).await.expect("the heir");
                let mut shown = step["heir"].clone();
                shown["step"] = json!(format!("{label} (heir)"));
                shown["view"]["items"] = step["heir"]["live"]["items"].clone();
                same(name, &shown, rust_step(&observe(&directory, &heir).await));
            }
            Ok(_) => panic!("{label}: thread/fork answers a value"),
            Err(error) => {
                let mut seen = Vec::new();
                let got = named(&json!({ "forked": false, "message": error.to_string() }), &mut seen);
                let mut seen = Vec::new();
                let want = named(&json!({ "forked": step["forked"], "message": step["message"] }), &mut seen);
                if got != want {
                    lock(&DIFFS).push(format!("{name} / {label}:\n got {got}\nwant {want}"));
                }
            }
        }
        let mut source = step["source"].clone();
        source["step"] = json!(format!("{label} (source)"));
        same(name, &source, rust_step(&observe(&directory, &handle).await));
    }
    no_diffs();
}

/// Each crash point: the child process runs the turn until the store's crash hook kills it, then the thread is opened (the
/// recovery at open) and read, and opened and read again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crashes_replay_as_node_recovers() {
    let child = format!("{}::crash_child", module_path!().trim_start_matches("mixdog_core::"));
    let only = std::env::var("TD_ONLY").ok();
    for case in cases().into_iter().filter(|case| case["crash"] == true) {
        let name = case["name"].as_str().unwrap().to_owned();
        if only.as_ref().is_some_and(|only| *only != name) {
            continue;
        }
        let steps = case["steps"].as_array().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &child, "--nocapture", "--test-threads=1"])
            .env("TD_CASE", &name)
            .env("TD_DIR", dir.path())
            .status()
            .expect("the child runs");
        assert_eq!(status.code(), Some(CRASHED), "{name}: the child was not killed at its point");
        let killed = steps.iter().position(|step| step["step"] == "killed").unwrap();
        // Steps before the kill are what a client was shown in the owning process (`resume-held`: the live session it resumed).
        for step in &steps[..killed] {
            let resumed: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("resumed.json")).unwrap()).unwrap();
            let mut shown = step.clone();
            shown["view"]["items"] = step["live"]["items"].clone();
            same(&name, &shown, rust_step(&resumed));
        }
        let sends: usize = std::fs::read_to_string(dir.path().join("sends")).unwrap().parse().unwrap();
        assert_eq!(sends, steps[killed]["sends"].as_u64().unwrap() as usize, "{name}: the requests sent before the kill");
        same(&name, &steps[killed + 1], rust_step(&reopen(dir.path()).await));
        same(&name, &steps[killed + 2], rust_step(&reopen(dir.path()).await));
    }
    no_diffs();
}
