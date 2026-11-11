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

use mixdog_store::draft_file::DraftStep;
use mixdog_store::fsio::AppendStep;
use mixdog_store::schema::record::RunPhase;

use super::*;

const CRASHED: i32 = 77;
const READ_TEXT: &str = "[lines 1-1]\nFILE-SENTINEL\n[lines 1-1 of 1]";

type OnSend = Arc<dyn Fn(usize) -> Pin<Box<dyn Future<Output = Play> + Send>> + Send + Sync>;

/// One response: its events, then the end of the stream, or a stream that never ends (the process dies on it).
struct Play {
    events: VecDeque<StreamEvent>,
    hang: bool,
    /// Events sent while the stream is open (`crash-sensitive`: after the value is marked).
    more: Option<tokio::sync::mpsc::UnboundedReceiver<StreamEvent>>,
}

#[async_trait]
impl ModelStream for Play {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if let Some(event) = self.events.pop_front() {
            return Some(Ok(event));
        }
        if let Some(more) = self.more.as_mut()
            && let Some(event) = more.recv().await
        {
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
        lock(&REQUESTS).push(user_texts(&request));
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

/// The usage every Node send reports (`USAGE`, the recorder child).
fn reported_usage() -> StreamEvent {
    StreamEvent::Usage(mixdog_core_api::domain::provider::Usage { input_tokens: 10, output_tokens: 2, ..Default::default() })
}

fn answer(text: &str) -> Play {
    Play { events: VecDeque::from([StreamEvent::TextDelta(text.into()), reported_usage(), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]), hang: false, more: None }
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

/// A crash child's session clock: its sleeps (the usage write's 150 ms debounce) are virtual, as the recorder child's timers
/// are, and run out only when [`advance_held`] moves the clock (Node's `advance`), however slow this machine's syncs are.
struct Held(Arc<dyn mixdog_core_session::session::Clock>);
/// The virtual time and the sleeps waiting on it: (due, wake).
static HELD_SLEEPS: Mutex<(u64, Vec<(u64, tokio::sync::oneshot::Sender<()>)>)> = Mutex::new((0, Vec::new()));
impl mixdog_core_session::session::Clock for Held {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
    fn sleep(&self, after: Duration) -> futures::future::BoxFuture<'static, ()> {
        let (wake, woken) = tokio::sync::oneshot::channel();
        let mut held = lock(&HELD_SLEEPS);
        let due = held.0 + after.as_millis() as u64;
        held.1.push((due, wake));
        Box::pin(async move {
            let _ = woken.await;
        })
    }
}

/// Moves the crash child's virtual clock on by `ms`: the sleeps due by then run out.
fn advance_held(ms: u64) {
    let mut held = lock(&HELD_SLEEPS);
    held.0 += ms;
    let now = held.0;
    let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut held.1).into_iter().partition(|(at, _)| *at <= now);
    held.1 = waiting;
    for (_, wake) in due {
        let _ = wake.send(());
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
fn stack(rig: &Rig, store: Arc<dyn mixdog_core_session::session::ThreadStore>, provider: Arc<Stub>, workspace: &Path, now: i64) -> Arc<SessionDirectory> {
    rig.clock.0.store(now as u64, Ordering::SeqCst);
    let mut deps = rig.deps_parts(store);
    if CASE.get().is_some() {
        deps.clock = Arc::new(Held(deps.clock.clone()));
    }
    let route = Arc::new(DraftRoute::default());
    deps.new_route = route.clone();
    deps.new_tools = Arc::new(LeadRecord(now));
    deps.transcript = Arc::new(mixdog_core_session::session::transcript::RecordTranscript::new());
    let parts = Parts { provider, workspace: workspace.to_path_buf(), more: vec![read_tool()], settle: None };
    deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Timed(parts, now))));
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    *route.directory.lock().unwrap() = Arc::downgrade(&directory);
    directory
}

/// The route seam as the route service is to `thread/start` (`new_route.rs`): the draft's provider and model are the
/// created thread's header inside `thread/start`, before it returns and before any turn (Node: `createSession({ provider, model })`).
/// The seat writes the adopted route's fields as the route service's seat does: through the thread's header.
#[derive(Default)]
struct DraftRoute {
    picked: std::sync::Mutex<serde_json::Map<String, Value>>,
    directory: std::sync::Mutex<std::sync::Weak<SessionDirectory>>,
}

#[async_trait]
impl mixdog_core_session::session::NewThreadRoute for DraftRoute {
    async fn adopt(&self, _: &ThreadId, pick: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
        let pick = pick.ok_or("the recording's session names its route")?;
        let route: serde_json::Map<String, Value> = ["provider", "model"].iter().map(|key| ((*key).to_owned(), pick.get(*key).cloned().unwrap_or(Value::Null))).collect();
        *self.picked.lock().unwrap() = route.clone();
        Ok(route)
    }

    async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, Value>, String> {
        Err("the recording starts no control thread".into())
    }

    async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
        let directory = self.directory.lock().unwrap().upgrade().ok_or("the directory is gone")?;
        let handle = directory.handle(thread).ok_or("the created thread is loaded")?;
        let set = Value::Object(self.picked.lock().unwrap().clone());
        let seat = CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": thread.as_str(), "set": set, "unset": [] }), op: None, ctx: CallContext::internal("route") };
        handle.request(seat).await.map(|_| ()).map_err(|error| error.to_string())
    }
}

/// The tool seam as the surface host is to `thread/start` for this part of its work: `buildSessionRecord`'s fields
/// (`write_lead_record`, `surface_host.rs`), the usage books at zero among them.
struct LeadRecord(i64);

#[async_trait]
impl mixdog_core_session::session::NewThreadTools for LeadRecord {
    async fn seed(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Result<mixdog_store::schema::record::Header, String> {
        let mut header = header.clone();
        mixdog_core_session::session::session_options::write_lead_record(&mut header, self.0, std::process::id());
        Ok(header)
    }
}

/// A session created with the recording's route (`createSession({ provider: 'durability-stub', model: 'stub-model' })`).
async fn start(directory: &SessionDirectory, workspace: &Path) -> Arc<mixdog_core_session::session::SessionHandle> {
    let route = json!({ "provider": "durability-stub", "model": "stub-model" });
    start_with(directory, json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.to_string_lossy(), "draft": { "route": route } })).await
}

/// The usage books Node's recording reads from the durable record (`USAGE_BOOKS`, the recorder child): the acked header's.
const USAGE_BOOKS: [&str; 17] = [
    "totalInputTokens", "totalOutputTokens", "totalToolCalls", "tokensCumulative", "totalCachedReadTokens", "totalCacheWriteTokens",
    "totalUncachedInputTokens", "usageReadout", "lastInputTokens", "lastOutputTokens", "lastCachedReadTokens", "lastCacheWriteTokens",
    "lastUncachedInputTokens", "lastContextTokens", "usageMetricsTurnId", "reasoningUsage", "lastIterationIndex",
];

/// The usage books of the header as the log on disk holds it (Node: `readDurableSessionRecord`, never the live copy).
async fn usage_of(directory: &SessionDirectory, handle: &mixdog_core_session::session::SessionHandle) -> Value {
    let store = directory.deps().store.clone();
    let id = ThreadHandle::id(handle).clone();
    let header = mixdog_rt::LaneToken::submit(mixdog_rt::testing::tokens().interactive_io, &mixdog_rt::CancellationToken::new(), move |lane| store.read_header(lane, &id))
        .expect("lane")
        .await
        .expect("job ran")
        .expect("the stored header");
    Value::Object(USAGE_BOOKS.iter().map(|key| ((*key).to_owned(), header.get(*key).cloned().unwrap_or(Value::Null))).collect())
}

/// A second client resuming the thread (`thread/resume`, the desktop's `setVisibleSessions`): the response, then the snapshot
/// its subscription is sent; with the disk and the usage books.
async fn resumed(directory: &SessionDirectory, handle: &mixdog_core_session::session::SessionHandle) -> Value {
    use mixdog_core_api::FeedSource;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::sink::ConnectionSink;
    let id = ThreadHandle::id(handle).as_str().to_owned();
    // The daemon routes `thread/resume` to the thread's handle (`ThreadHandle::request`), as a client's call reaches it.
    let reply = handle.request(request("thread/resume", json!({ "threadId": id, "window": { "lastItems": 100 } }), "op-resume")).await.expect("thread/resume");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/resume subscribes") };
    let connection = MockConnection::new(mixdog_core_api::ids::ConnectionId(7), MockLimits::default());
    let source: Arc<dyn FeedSource> = subscribe.feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, "resume".into(), subscribe.window, subscribe.resume_from, &connection).expect("attach");
    connection.send_control_release(bytes::Bytes::from(subscribe.result.to_string()), attached.release).expect("release");
    let frame_of = |text: &String| serde_json::from_str::<Value>(text.split_once(':').expect("a rendered frame").1).expect("a JSON frame");
    let frames = tokio::time::timeout(Duration::from_secs(30), connection.drain_text_until(|texts| texts.iter().any(|text| frame_of(text)["method"] == "thread/snapshot")))
        .await
        .expect("the resumed client is sent its snapshot within 30 s");
    let snapshot = frames.iter().map(frame_of).find(|frame| frame["method"] == "thread/snapshot").expect("the snapshot")["params"].clone();
    assert_eq!(snapshot["thread"], subscribe.result["thread"], "the response and the snapshot name the same thread");
    let messages = CoreRequest { method: Method("thread/modelMessages/list"), params: json!({ "threadId": id, "start": 0 }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(messages) = directory.request(messages).await.expect("thread/modelMessages/list") else { panic!("a value") };
    json!({ "items": snapshot["items"], "state": snapshot["state"], "disk": messages["messages"], "usage": usage_of(directory, handle).await, "checkpoint": checkpoint_of(&id), "stage": handle.runtime_stage() })
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
    json!({ "items": read["items"], "state": read["state"], "disk": messages["messages"], "usage": usage_of(directory, handle).await, "checkpoint": checkpoint_of(ThreadHandle::id(handle).as_str()), "stage": handle.runtime_stage() })
}

/// Node's `result` (what `askSession` returned, the answer): what a client is given as the turn's answer, the item its
/// last end row names (`finalAssistantId`).
fn turn_result(view: &Value) -> Value {
    let items = view["items"].as_array().unwrap();
    let end = items.iter().rev().find(|item| item["type"] == "turnEnd").expect("the turn's end row");
    items.iter().find(|item| item["id"] == end["finalAssistantId"]).map_or(Value::Null, |item| item["text"].clone())
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
/// What the hooks saw durable: the run's start, a tool row, the run's drafted text, and a draft back out of its tool phase.
static SEEN: Mutex<(bool, bool, String, bool)> = Mutex::new((false, false, String::new(), false));

fn has_run(records: &[Record], phase: RunPhase) -> bool {
    records.iter().any(|record| matches!(record, Record::Run(run) if run.phase == phase))
}

fn has_role(records: &[Record], role: &str) -> bool {
    records.iter().any(|record| matches!(record, Record::Item(item) if item.role.as_ref().is_some_and(|r| r.as_str() == role)))
}


/// `crash-sensitive`: the value the turn streams, then marks sensitive (the recording's `SECRET`).
const SECRET: &str = "731905";
/// The streamed value is in the run's draft file.
static SECRET_DRAFTED: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// Where the stream's later events go (`crash-sensitive`).
static MORE: Mutex<Option<tokio::sync::mpsc::UnboundedSender<StreamEvent>>> = Mutex::new(None);

/// The queue cases: a request is on the wire (the first, then the one that took the queued prompts).
static ON_WIRE: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// The queue cases: the first request answers once the prompts are queued.
static RELEASE: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// The text of each user message of every request this process sent, in order (Node's `requests`): what the model was given.
static REQUESTS: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());

fn user_texts(request: &ModelRequest) -> Vec<String> {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::Role;
    request
        .messages
        .iter()
        .filter(|message| message.role == Role::User)
        .map(|message| match &message.content {
            Content::Text(text) => text.clone(),
            Content::Parts(parts) => parts.iter().filter_map(|part| if let ContentPart::Text(text, _) = part { Some(text.as_str()) } else { None }).collect(),
        })
        .collect()
}

/// A desktop submit (`turn/start` with its `clientSubmissionId`).
async fn submit(handle: &mixdog_core_session::session::SessionHandle, prompt: &str, submission: &str) {
    let op = format!("op-{submission}");
    let params = json!({ "threadId": ThreadHandle::id(handle).as_str(), "opId": op, "input": { "prompt": prompt, "options": { "clientSubmissionId": submission } } });
    handle.request(request("turn/start", params, &op)).await.unwrap_or_else(|error| panic!("{submission}: {error:?}"));
}

/// The queued rows a client is shown (the snapshot's `state.queued`).
fn queued_of(view: &Value) -> Vec<Value> {
    view["state"]["queued"].as_array().cloned().unwrap_or_default()
}

/// [`observe`] with the requests sent so far (the queue cases).
async fn queue_observe(directory: &SessionDirectory, handle: &mixdog_core_session::session::SessionHandle) -> Value {
    let mut view = observe(directory, handle).await;
    view["requests"] = json!(lock(&REQUESTS).clone());
    view
}

/// A step of the owning process, compared by the parent once the child is dead.
fn write_step(dir: &Path, label: &str, view: Value) {
    std::fs::write(dir.join(format!("step-{label}.json")), view.to_string()).unwrap();
}

/// Whether any file under `data` holds the value.
fn secret_on_disk(data: &Path) -> bool {
    fn walk(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() { walk(&path) } else { std::fs::read(&path).unwrap().windows(SECRET.len()).any(|w| w == SECRET.as_bytes()) }
        })
    }
    walk(data)
}

/// The disk refuses writes (`save-failure`): each barrier's write stops half way with `EIO: injected`.
static DISK_FAILS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Rollbacks still to fail: the first failed write's rollback fails too, so that batch's outcome is unknown until the next
/// barrier truncates it.
static ROLLBACKS_FAILING: AtomicUsize = AtomicUsize::new(0);
/// Every step of every barrier, in order, with its records' kinds: what the save-failure replay shows of the writer.
static STEPS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The store's barrier and draft hooks of this process, installed once: the save failure, or a crash child's kill points.
fn install_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        mixdog_store::fsio::set_append_hook(hook);
        mixdog_store::draft_file::set_draft_hook(draft_hook);
    });
}

/// Node's kill points on its checkpoint journal, as the steps of the run's draft file.
fn draft_hook(step: DraftStep, _rid: &str, body: Option<&Value>) -> std::io::Result<()> {
    let Some((case, _)) = CASE.get() else { return Ok(()) };
    let case = case.as_str();
    let body = body.cloned().unwrap_or(Value::Null);
    let sealed = body.get("sealed").is_some();
    let text = body.get("text").and_then(Value::as_str).unwrap_or_default();
    match step {
        // The finished message and its seal were not written: what streamed of it is the draft's.
        DraftStep::Append | DraftStep::Replace if case == "crash-answer-streamed" && sealed => kill(&format!("draft {step:?}")),
        // The value is in the draft: the turn's driver marks it (`crash_child`).
        DraftStep::Appended if case == "crash-sensitive" && text.contains(SECRET) => {
            // The value is in the draft file just written: whether a file holds it before the mark.
            let (_, dir) = CASE.get().expect("a crash child");
            std::fs::write(dir.join("secret-before"), secret_on_disk(&dir.join("data")).to_string()).unwrap();
            SECRET_DRAFTED.notify_one();
        }
        // What streamed after the mark is in the redacted draft: the process dies.
        DraftStep::Appended | DraftStep::Replaced if case == "crash-sensitive" && text.contains("entered.") => kill(&format!("draft {step:?}")),
        DraftStep::Appended => {
            let mut seen = lock(&SEEN);
            seen.2.push_str(body.get("text").and_then(Value::as_str).unwrap_or_default());
            seen.3 |= body.get("tools") == Some(&Value::Bool(false));
            match case {
                "crash-mid-stream" if seen.2 == "partial streamed answer" => kill("draft Appended"),
                "crash-tool-wire" if seen.1 && seen.3 => kill("draft Appended"),
                // Once the seal is on disk the session's saves fail; the process dies once the turn has ended (`crash_child`).
                "crash-sealed-unsaved" | "resume-held" if sealed => SESSION_SAVES_FAIL.store(true, Ordering::SeqCst),
                _ => {}
            }
        }
        _ => {}
    }
    Ok(())
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
            // The turn's first write (its input row and the run's start), before it writes.
            "crash-before-write" if has_run(records, RunPhase::Started) || has_role(records, "user") => die(),
            // The finished message was not written: what streamed of it is the draft's.
            "crash-answer-streamed" if has_role(records, "assistant") => die(),
            // From the seal on the session's saves fail (`draft_hook`); the answer's row comes after its seal.
            "crash-sealed-unsaved" | "resume-held" if SESSION_SAVES_FAIL.load(Ordering::SeqCst) => return Err(std::io::Error::other("EIO: injected")),
            "crash-sealed-unsaved" | "resume-held" => assert!(!has_role(records, "assistant"), "the answer's row is written before its seal"),
            _ => {}
        },
        AppendStep::Synced => {
            let mut seen = lock(&SEEN);
            if has_run(records, RunPhase::Started) {
                seen.0 = true;
                STARTED.notify_one();
            }
            seen.1 |= has_role(records, "tool");
            match case {
                "crash-tool-wire" if seen.1 && seen.3 => die(),
                "crash-saved-uncleared" if has_run(records, RunPhase::Completed) => die(),
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
    // Only `crash-sensitive` compares it; the other cases kill on a write, with the log's file locked against this read.
    let held = case == "crash-sensitive" && secret_on_disk(&dir.join("data"));
    std::fs::write(dir.join("secret"), held.to_string()).unwrap();
    std::fs::write(dir.join("sends"), SENDS.load(Ordering::SeqCst).to_string()).unwrap();
    eprintln!("[turn-durability] {case}: killed at {at}");
    kill_self()
}

/// Ends this process the way a kill does (Node's recording: SIGKILL): no unwinding, no exit handler, no flush. Not `abort`: on
/// Windows that is a fail-fast that starts Windows Error Reporting.
fn kill_self() -> ! {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A process the product started (a `git` of its workspace reads) outlives a killed parent on Windows; ending the tree
        // by this process's id leaves nothing behind the run (the files the kill is observed through are written already).
        let _ = std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &std::process::id().to_string()]).creation_flags(0x0800_0000).status();
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        use windows_sys::Win32::System::Threading::TerminateProcess;
        // SAFETY: the pseudo-handle of this process is always valid.
        unsafe { TerminateProcess(GetCurrentProcess(), CRASHED as u32) };
    }
    #[cfg(unix)]
    // SAFETY: signals this process.
    unsafe {
        libc::kill(libc::getpid(), libc::SIGKILL);
    }
    std::process::abort()
}

/// The first process of a crash case, run by `crashes_replay_as_node_recovers` with `TD_CASE` set: runs the turn until the hook
/// kills it. Without `TD_CASE` (a test run of its own) it does nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_child() {
    let (Ok(case), Ok(dir)) = (std::env::var("TD_CASE"), std::env::var("TD_DIR")) else { return };
    let dir = std::path::PathBuf::from(dir);
    // `a_child_past_its_deadline_is_killed_and_named`: a child that never ends by itself.
    if case == "deadline-probe" {
        // A process the child started, which only the tree's end reaches (`a_child_past_its_deadline_is_killed_and_named`).
        if std::env::var("TD_GRANDCHILD").is_err() {
            let log = std::fs::File::create(dir.join("grandchild.log")).expect("the grandchild's log");
            let mut grandchild = std::process::Command::new(std::env::current_exe().unwrap());
            grandchild
                .args(["--exact", &format!("{}::crash_child", module_path!().trim_start_matches("mixdog_core::")), "--nocapture", "--test-threads=1"])
                .env("TD_CASE", &case)
                .env("TD_DIR", &dir)
                .env("TD_GRANDCHILD", "1")
                .stdin(std::process::Stdio::null())
                .stdout(log.try_clone().expect("the grandchild's log"))
                .stderr(log);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                grandchild.creation_flags(0x0800_0000);
            }
            let started = grandchild.spawn().expect("the grandchild runs");
            std::fs::write(dir.join("grandchild"), started.id().to_string()).unwrap();
        }
        std::future::pending::<()>().await;
    }
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
        "crash-mid-stream" => Arc::new(|_| Box::pin(async { Play { events: VecDeque::from([StreamEvent::TextDelta("partial ".into()), StreamEvent::TextDelta("streamed answer".into())]), hang: true, more: None } })),
        "crash-tool-wire" => Arc::new(|n| {
            Box::pin(async move {
                if n == 1 {
                    Play {
                        events: VecDeque::from([
                            StreamEvent::TextDelta("reading".into()),
                            StreamEvent::ToolCallDone(ToolCall { id: "call_read".into(), name: "read".into(), arguments: json!({ "path": "x.txt" }), native_type: None }),
                            reported_usage(), StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                        ]),
                        hang: false, more: None,
                    }
                } else {
                    Play { events: VecDeque::new(), hang: true, more: None }
                }
            })
        }),
        "crash-answer-streamed" | "crash-saved-uncleared" | "crash-sealed-unsaved" | "resume-held" => Arc::new(|_| Box::pin(async { answer("answer") })),
        // The first request waits for the queued prompts, then answers; the request that took them hangs (`while-take`, the
        // process dies on it) or answers.
        "crash-queued-before-take" | "crash-queued-while-take" | "crash-queued-after-take" => {
            let hangs = case == "crash-queued-while-take";
            Arc::new(move |n| {
                Box::pin(async move {
                    if n == 1 {
                        ON_WIRE.notify_one();
                        tokio::time::timeout(Duration::from_secs(30), RELEASE.notified()).await.expect("the prompts are queued");
                        return answer("answer");
                    }
                    if hangs {
                        // Node's scripted `send` never returns: the request stays on the wire with no response begun.
                        ON_WIRE.notify_one();
                        return std::future::pending().await;
                    }
                    answer("answer to the queued")
                })
            })
        }
        // The request can go out before the turn's first write lands (the write is on the io lane): it waits there until the
        // hook kills the process at that write.
        "crash-before-write" => Arc::new(|_| Box::pin(std::future::pending())),
        "crash-sensitive" => Arc::new(|_| {
            Box::pin(async {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                *lock(&MORE) = Some(tx);
                Play { events: VecDeque::from([StreamEvent::TextDelta(format!("the code is {SECRET}, "))]), hang: true, more: Some(rx) }
            })
        }),
        other => panic!("unknown case {other}"),
    };
    let rig = Rig::new();
    let store = real_store(&dir.join("data")).await;
    let workspace = dir.join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    let directory = stack(&rig, store, stub(on_send), &workspace, RUN_AT);
    let handle = start(&directory, &workspace).await;
    std::fs::write(dir.join("id"), ThreadHandle::id(&*handle).as_str()).unwrap();
    if case.starts_with("crash-queued-") {
        // Node's desktop submits (`clientSubmissionId`): the turn, then two prompts queued while its request is on the wire.
        submit(&handle, "do the task", "sub-0").await;
        tokio::time::timeout(Duration::from_secs(30), ON_WIRE.notified()).await.expect("the first request is on the wire");
        for (submission, prompt) in [("sub-1", "first queued"), ("sub-2", "second queued")] {
            submit(&handle, prompt, submission).await;
        }
        until(&handle, "the queued prompts are shown", async || queued_of(&observe(&directory, &handle).await).len() == 2).await;
        write_step(&dir, "queued", queue_observe(&directory, &handle).await);
        if case == "crash-queued-before-take" {
            kill("queued");
        }
        RELEASE.notify_one();
        if case == "crash-queued-while-take" {
            tokio::time::timeout(Duration::from_secs(30), ON_WIRE.notified()).await.expect("the request that took them is on the wire");
            // Node's view after its mirror's drop settled (`flushTuiSteeringPersist`): the queue's dequeue is durable.
            until(&handle, "the taken prompts leave the queue", async || queued_of(&observe(&directory, &handle).await).is_empty()).await;
            // Node's `advance(150)`: the first request's usage debounce runs out and its write lands before the kill.
            advance_held(150);
            until(&handle, "the first request's usage is written", async || usage_of(&directory, &handle).await["lastContextTokens"] == json!(10)).await;
            write_step(&dir, "taken", queue_observe(&directory, &handle).await);
            kill("taken");
        }
        until(&handle, "the turn that took them settles", async || {
            let view = observe(&directory, &handle).await;
            !handle.turn_busy() && !busy(&view) && queued_of(&view).is_empty() && SENDS.load(Ordering::SeqCst) == 2
        })
        .await;
        // Killed once the run's draft is gone (Node's checkpoint cleared): the third kill point of a draft's life, after the
        // draft written (`crash-mid-stream`) and the end record durable (`crash-saved-uncleared`).
        until(&handle, "the turn's draft goes", async || !has_draft_file(&dir.join("data"))).await;
        write_step(&dir, "answered", queue_observe(&directory, &handle).await);
        kill("answered");
    }
    ask(&handle, "do the task", "op-1").await.expect("turn/start");
    // The value is in the draft; it is marked sensitive (a browser fill, as the recording's), then the stream goes on.
    if case == "crash-sensitive" {
        tokio::time::timeout(Duration::from_secs(30), SECRET_DRAFTED.notified()).await.expect("the value is drafted");
        rig.sensitive.remember(ThreadHandle::id(&*handle).as_str(), &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "ref": "p1-s1-e3", "text": SECRET, "sensitive": true } } })]);
        lock(&MORE).as_ref().expect("the stream is open").send(StreamEvent::TextDelta("entered.".into())).unwrap();
    }
    // Node's `settleThenKill`: the turn ended with its terminal save failed, then the process dies.
    if case == "crash-sealed-unsaved" || case == "resume-held" {
        until(&handle, "the sealed turn ends", async || SESSION_SAVES_FAIL.load(Ordering::SeqCst) && !handle.turn_busy()).await;
        // A second client resumes the held thread in the owning process: what its `thread/resume` sends it.
        if case == "resume-held" {
            std::fs::write(dir.join("resumed.json"), resumed(&directory, &handle).await.to_string()).unwrap();
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
    *lock(&DATA_DIR) = Some(data.to_path_buf());
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
    // Node's recovery removes the checkpoint (`clearTurnCheckpoint`): the draft goes once the recovered end is saved.
    until(&handle, "the recovered run's draft goes", async || !has_draft_file(&dir.join("data"))).await;
    observe(&directory, &handle).await
}

/// The queue cases' next process: the session as opened (Node's read and the restore of its mirror), then as a client's
/// `thread/resume` drained what it restored (Node's resume, `session-api/lifecycle/resume.mjs:72`).
async fn reopen_queued(dir: &Path) -> (Value, Value) {
    let id = ThreadId::from(std::fs::read_to_string(dir.join("id")).unwrap());
    let rig = Rig::new();
    let store = real_store(&dir.join("data")).await;
    let after: OnSend = Arc::new(|_| Box::pin(async { answer("answer after restart") }));
    let directory = stack(&rig, store, stub(after), &dir.join("work"), REOPEN_AT);
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("reopened");
    until(&handle, "the recovery at open", async || handle.recovered()).await;
    until(&handle, "the recovered run's draft goes", async || !has_draft_file(&dir.join("data"))).await;
    lock(&REQUESTS).clear();
    let reopened = queue_observe(&directory, &handle).await;
    let resume = request("thread/resume", json!({ "threadId": id.as_str(), "window": { "lastItems": 100 } }), "op-resume");
    handle.request(resume).await.expect("thread/resume");
    let queued = queued_of(&reopened).len();
    until(&handle, "the restored queue drains", async || {
        let view = observe(&directory, &handle).await;
        !handle.turn_busy() && !busy(&view) && queued_of(&view).is_empty() && (queued == 0 || !lock(&REQUESTS).is_empty())
    })
    .await;
    (reopened, queue_observe(&directory, &handle).await)
}

/// The data dir of the store last opened in this process: where [`checkpoint_of`] looks.
static DATA_DIR: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

/// Node's `checkpoint` as Rust keeps it: thread `id`'s run drafts under the data dir (`null` for none), `sealed` when one holds
/// the turn's final reply (the checkpoint's seal).
fn checkpoint_of(id: &str) -> Value {
    checkpoint_in(&lock(&DATA_DIR).clone().expect("a store is open"), id)
}

/// [`checkpoint_of`] for the data dir `data`: what a dead process left on disk.
fn checkpoint_in(data: &Path, id: &str) -> Value {
    fn drafts(dir: &Path, id: &str, out: &mut Vec<Value>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                drafts(&path, id, out);
            } else if path.to_string_lossy().contains(id) && path.file_name().and_then(|n| n.to_str()).and_then(mixdog_store::draft_file::rid_of).is_some() {
                let text = std::fs::read_to_string(&path).unwrap();
                out.extend(text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()));
                out.push(Value::Null);
            }
        }
    }
    let mut bodies = Vec::new();
    drafts(data, id, &mut bodies);
    if bodies.is_empty() {
        return Value::Null;
    }
    json!({ "sealed": bodies.iter().any(|body| body.get("sealed").is_some()) })
}

/// Whether a run's draft file is under `data`.
fn has_draft_file(data: &Path) -> bool {
    fn walk(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() { walk(&path) } else { path.file_name().and_then(|n| n.to_str()).and_then(mixdog_store::draft_file::rid_of).is_some() }
        })
    }
    walk(data)
}

// ---- the comparison ----------------------------------------------------------------------------------------------------------

fn cases() -> Vec<Value> {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/turn-durability/golden.json")).unwrap();
    golden["cases"].as_array().unwrap().clone()
}

/// What the manifest's `exclusions` may name: each line is `<key>: <reason>`. The comparison drops or translates a thing only
/// while its key is listed; without the line the thing is compared as recorded (and the replay fails where the two sides differ).
/// `result`, `refusal-class` and `requests` are lines that state how a value is read, not a drop.
const EXCLUSION_KEYS: [&str; 19] = [
    "minted-ids", "row-id", "view-messages", "system-message", "rust-disk-stamps", "end-row-message-id", "checkpoint-seal", "queued-stamps", "taken-disk",
    "saved-uncleared-presence", "secret-before-mark", "secret-files", "busy", "result", "refusal-class", "live-view", "queued-rows", "spool", "requests",
];

/// Whether the manifest's exclusions list `key`.
fn excluded(key: &str) -> bool {
    static LISTED: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    assert!(EXCLUSION_KEYS.contains(&key), "{key} is not an exclusion the replay knows");
    LISTED
        .get_or_init(|| {
            let manifest: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/turn-durability/MANIFEST.json")).unwrap();
            manifest["exclusions"]
                .as_array()
                .expect("the manifest's exclusions")
                .iter()
                .map(|line| {
                    let line = line.as_str().expect("an exclusion line");
                    let (listed, reason) = line.split_once(": ").unwrap_or_else(|| panic!("an exclusion is `<key>: <reason>`: {line}"));
                    assert!(
                        EXCLUSION_KEYS.contains(&listed) && !reason.trim().is_empty(),
                        "the manifest lists an exclusion the replay does not read, or one without its reason: {line}"
                    );
                    listed.to_owned()
                })
                .collect()
        })
        .iter()
        .any(|listed| listed == key)
}

/// [`named`] while the manifest excludes minted ids, else the value as it is.
fn ids(value: &Value, seen: &mut Vec<String>) -> Value {
    if excluded("minted-ids") { named(value, seen) } else { value.clone() }
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
            if excluded("row-id") {
                row.shift_remove("id");
                // The tool card's open/closed state is the client's (`expanded`), not the session's.
                row.shift_remove("expanded");
                if let Some(target) = row.get("finalAssistantId").cloned() {
                    row.insert("finalAssistantId".into(), json!(rows.iter().position(|other| other["id"] == target)));
                }
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
                    // `userMessageRow` (`rows.ts`): a steering message (`details.source`) is the row `steered`.
                    put("steered", item.pointer("/details/steered").filter(|steered| *steered == &json!(true)).cloned());
                    for key in ["modelId", "model", "provider"] {
                        put(key, pick(item, &[&format!("/meta/{key}"), &format!("/meta/ext/{key}")]));
                    }
                }
                "agentMessage" => {
                    put("kind", Some(json!("assistant")));
                    put("text", item.get("text").cloned());
                    put("messageId", pick(item, &["/meta/messageId", "/meta/ext/messageId"]));
                    put("at", pick(item, &["/meta/at", "/meta/ext/at"]));
                    for key in ["modelId", "model", "provider"] {
                        put(key, pick(item, &[&format!("/meta/{key}"), &format!("/meta/ext/{key}")]));
                    }
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
    messages.as_array().unwrap().iter().filter(|message| !(excluded("system-message") && message["role"] == "system")).cloned().collect()
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
            if !excluded("rust-disk-stamps") {
                return message;
            }
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

/// Node's recorded checkpoint as compared: null, or (`checkpoint-seal`) its seal alone, its `turnMessages` (the turn's messages
/// it copies) being compared as the rows and the disk.
fn node_checkpoint(checkpoint: &Value) -> Value {
    if checkpoint.is_null() || !excluded("checkpoint-seal") { checkpoint.clone() } else { json!({ "sealed": checkpoint["sealed"] }) }
}

/// The queue's rows as compared (`queued-rows`: id, text, mode and priority, Node's id being the submission's).
fn queued_rows(rows: &[Value], submission_key: &str) -> Value {
    if excluded("queued-rows") { json!(rows.iter().map(|row| queued_row(row, &row[submission_key])).collect::<Vec<_>>()) } else { json!(rows) }
}

/// One step as compared: the rows a client shows, the stored model context, the runtime's stage.
fn node_step(step: &Value) -> Value {
    let mut seen = Vec::new();
    let rows = ids(&json!(node_rows(&step["view"]["items"])), &mut seen);
    let disk = ids(&json!(node_disk(&step["disk"]["messages"])), &mut seen);
    let mut out = json!({ "rows": rows, "disk": disk, "usage": step["disk"]["usage"], "stage": step["stage"] });
    if excluded("busy") {
        out["busy"] = json!(!step["stage"].is_null());
    }
    if !excluded("view-messages") {
        out["messages"] = step["view"]["messages"].clone();
    }
    if let Some(result) = step.get("result") {
        out["result"] = result.clone();
    }
    if let Some(checkpoint) = step.get("checkpoint") {
        out["checkpoint"] = node_checkpoint(checkpoint);
    }
    // The queue cases: the queue the user is shown (the desktop's projection of it) and what each request gave the model.
    if let Some(queued) = step.get("queued").and_then(Value::as_array) {
        out["queued"] = queued_rows(queued, "id");
        out["requests"] = step["requests"].clone();
        if !excluded("spool") {
            out["spool"] = step["spool"].clone();
        }
    }
    out
}

/// `view` with the turn's answer, for a step that records Node's `result`.
fn with_result(mut view: Value, step: &Value) -> Value {
    if step.get("result").is_some() {
        view["result"] = turn_result(&view);
    }
    view
}

/// A queued row as compared: Node's id is the submission's, which Rust's row carries as `clientSubmissionId` (its own `id`
/// being the queue entry's).
fn queued_row(row: &Value, submission: &Value) -> Value {
    json!({ "id": submission, "text": row["text"], "mode": row["mode"], "priority": row["priority"] })
}

fn rust_step(view: &Value) -> Value {
    let mut seen = Vec::new();
    let rows = ids(&json!(rust_rows(&view["items"])), &mut seen);
    let disk = ids(&json!(rust_disk(&view["disk"])), &mut seen);
    let mut out = json!({ "rows": rows, "disk": disk, "usage": view["usage"], "stage": view["stage"], "busy": busy(view) });
    for key in ["result", "checkpoint"] {
        if let Some(value) = view.get(key) {
            out[key] = value.clone();
        }
    }
    if let Some(requests) = view.get("requests") {
        out["queued"] = queued_rows(&queued_of(view), "clientSubmissionId");
        out["requests"] = requests.clone();
    }
    out
}

/// A queue case's step without what the two sides do not share (each listed in the manifest's exclusions; unlisted, it stays):
/// - `queued-stamps`: Node's `checkpointId` is Rust's `clientSubmissionId`, and Rust's rows and stored meta also carry model,
///   modelId and provider, which Node's TUI queue flow stamps on none (outside this change);
/// - `taken-disk`, at `taken`: the owning process's stored disk: Node's lags the running turn (its checkpoint holds the turn),
///   Rust's log holds it as it goes.
fn queue_comparable(step: &mut Value, label: &str) {
    if excluded("queued-stamps") {
        for row in step["rows"].as_array_mut().unwrap() {
            for key in ["checkpointId", "model", "modelId", "provider"] {
                row.as_object_mut().unwrap().shift_remove(key);
            }
        }
        for message in step["disk"].as_array_mut().unwrap() {
            if let Some(transcript) = message.pointer_mut("/meta/transcript").and_then(Value::as_object_mut) {
                for key in ["checkpointId", "clientSubmissionId", "model", "modelId", "provider"] {
                    transcript.shift_remove(key);
                }
                if let Some(completion) = transcript.get_mut("completion").and_then(Value::as_object_mut) {
                    completion.shift_remove("checkpointId");
                }
            }
        }
    }
    if label == "taken" && excluded("taken-disk") {
        step["disk"] = json!([]);
    }
    // The turn this process ran after the restart: Node shows its live end row, which names no message (as `same` drops it).
    if label == "drained" && excluded("end-row-message-id") {
        for row in step["rows"].as_array_mut().unwrap().iter_mut().filter(|row| row["kind"] == "turndone") {
            row.as_object_mut().unwrap().shift_remove("messageId");
        }
    }
}

fn same(case: &str, step: &Value, got: Value) {
    let mut want = node_step(step);
    // In the process that ran the turn, Node shows its live end row (`turnDoneItem`, `tui/session/turn.mjs:577`), which names
    // no message; the recorder's view is the stored-transcript projection, whose end row takes the answer's `messageId`. An
    // heir ran no turn: it shows its carried rows restored, end rows with their `messageId`.
    let label = step["step"].as_str().unwrap_or_default();
    if excluded("end-row-message-id") && label != "reopened" && label != "read again" && !label.ends_with("(heir)") {
        for row in want["rows"].as_array_mut().unwrap() {
            if row["kind"] == "turndone" {
                row.as_object_mut().unwrap().shift_remove("messageId");
            }
        }
    }
    let mut got = got;
    if case.starts_with("crash-queued-") {
        queue_comparable(&mut got, label);
        queue_comparable(&mut want, label);
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
                reported_usage(), StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ]),
            hang: false, more: None,
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
    same(name, &steps[0], rust_step(&with_result(observe(&directory, &handle).await, &steps[0])));

    let refused = ask(&handle, "second task", "op-2").await.expect_err("refused while the first turn is not saved");
    let mixdog_core_api::CoreError::DomainError { code, message, .. } = &refused else { panic!("{refused:?}") };
    let mut seen = Vec::new();
    let got = ids(&json!({ "code": code, "message": message }), &mut seen);
    let mut seen = Vec::new();
    let want = ids(&json!({ "code": steps[1]["code"], "message": steps[1]["message"] }), &mut seen);
    assert_eq!(got, want, "the refusal");
    assert_eq!(provider.sends.load(Ordering::SeqCst), steps[1]["sends"].as_u64().unwrap() as usize, "the refused turn asks nothing");
    same(name, &steps[1], rust_step(&observe(&directory, &handle).await));

    DISK_FAILS.store(false, Ordering::SeqCst);
    ask(&handle, "second task", "op-3").await.expect("turn/start");
    until(&handle, "the second turn ends", async || settled(&observe(&directory, &handle).await, rows_of(&steps[2]))).await;
    assert_eq!(provider.sends.load(Ordering::SeqCst), steps[2]["sends"].as_u64().unwrap() as usize);
    same(name, &steps[2], rust_step(&with_result(observe(&directory, &handle).await, &steps[2])));
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
                if excluded("live-view") {
                    shown["view"]["items"] = step["heir"]["live"]["items"].clone();
                }
                same(name, &shown, rust_step(&observe(&directory, &heir).await));
            }
            Ok(_) => panic!("{label}: thread/fork answers a value"),
            Err(error) => {
                let mut seen = Vec::new();
                let got = ids(&json!({ "forked": false, "message": error.to_string() }), &mut seen);
                let mut seen = Vec::new();
                let want = ids(&json!({ "forked": step["forked"], "message": step["message"] }), &mut seen);
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

/// How long `taskkill` may take to end a crash child's tree.
const END_TREE_DEADLINE: Duration = Duration::from_secs(20);

/// A crash child that ends, with everything it started, on every exit path of its owner: its tree is ended when it is dropped
/// still running (a panic, an assertion), and at its deadline.
struct Crashed(tokio::process::Child);

impl std::ops::Deref for Crashed {
    type Target = tokio::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Crashed {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Crashed {
    /// Ends the child and every process it started, by its id. `taskkill` is given [`END_TREE_DEADLINE`] and its result is
    /// checked: the error names the case and the process that may still be alive.
    fn end_tree(&self, name: &str) -> Result<(), String> {
        self.0.id().map_or(Ok(()), |pid| end_tree_of(name, pid))
    }
}

fn end_tree_of(name: &str, pid: u32) -> Result<(), String> {
    {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut taskkill = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000)
                .spawn()
                .map_err(|error| format!("{name}: taskkill did not start; the crash child {pid} is still alive: {error}"))?;
            use std::os::windows::io::AsRawHandle;
            let limit = u32::try_from(END_TREE_DEADLINE.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: the handle is the running `taskkill`'s, owned here for the length of the call.
            let ended = unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(taskkill.as_raw_handle() as _, limit) } == 0;
            if !ended {
                // A `taskkill` that is itself stuck is ended and reaped here: nothing this call started outlives it.
                let killed = taskkill.kill();
                let reaped = taskkill.wait();
                return Err(format!(
                    "{name}: taskkill did not return within {} s and was ended (kill: {killed:?}, exit: {reaped:?}); the crash child {pid} and its processes may still be alive",
                    END_TREE_DEADLINE.as_secs()
                ));
            }
            match taskkill.wait() {
                Ok(status) if status.success() => Ok(()),
                Ok(status) => Err(format!("{name}: taskkill ended with {status}; the crash child {pid} and its processes may still be alive")),
                Err(error) => Err(format!("{name}: taskkill's status was not read ({error}); the crash child {pid} and its processes may still be alive")),
            }
        }
        #[cfg(unix)]
        {
            // SAFETY: signals the child's own process group (it is spawned as the leader of one).
            if unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } != 0 {
                return Err(format!("{name}: the crash child's process group {pid} was not signalled: {}", std::io::Error::last_os_error()));
            }
            Ok(())
        }
    }
}

/// A tree that cannot be ended is an error naming the case and the process, not a silent pass.
#[test]
fn a_tree_that_taskkill_cannot_end_is_named() {
    // No process has this id.
    let error = end_tree_of("tree-probe", 0x7fff_fff0).expect_err("nothing to end");
    assert!(error.starts_with("tree-probe: ") && error.contains(&0x7fff_fff0u32.to_string()), "{error}");
}

impl Drop for Crashed {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None))
            && let Err(error) = self.end_tree("a crash child dropped while running")
        {
            eprintln!("{error}");
        }
    }
}

/// A crash child running case `name` in `dir` (this test binary, `crash_child` alone).
fn spawn_child(name: &str, dir: &Path) -> Crashed {
    let child = format!("{}::crash_child", module_path!().trim_start_matches("mixdog_core::"));
    // Its output goes to a file in `dir`, not the runner's pipe: a process it started and the kill left behind would hold the
    // pipe open and the runner would wait on it.
    let log = std::fs::File::create(dir.join("child.log")).expect("the child's log");
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &child, "--nocapture", "--test-threads=1"])
        .env("TD_CASE", name)
        .env("TD_DIR", dir)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().expect("the child's log"))
        .stderr(log)
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    Crashed(command.spawn().expect("the child runs"))
}

/// The child's exit within `deadline`; past it the child and its tree are ended and the error names the case.
async fn wait_child(name: &str, process: &mut Crashed, deadline: Duration) -> Result<std::process::ExitStatus, String> {
    match tokio::time::timeout(deadline, process.wait()).await {
        Ok(status) => Ok(status.expect("the child's status")),
        Err(_) => {
            process.end_tree(name)?;
            let pid = process.id().unwrap_or_default();
            tokio::time::timeout(Duration::from_secs(30), process.wait())
                .await
                .map_err(|_| format!("{name}: the crash child {pid} was still alive 30 s after its tree was ended"))?
                .expect("the child's status");
            Err(format!("{name}: the crash child did not end within {} s", deadline.as_secs()))
        }
    }
}

/// A child that never reaches its kill point is killed at the parent's deadline, and the failure names its case.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_child_past_its_deadline_is_killed_and_named() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = spawn_child("deadline-probe", dir.path());
    let expired = wait_child("deadline-probe", &mut process, Duration::from_secs(5)).await.expect_err("the probe never ends by itself");
    assert_eq!(expired, "deadline-probe: the crash child did not end within 5 s");
    assert!(process.try_wait().expect("the child's status").is_some(), "the child is dead");
    // The process the child started is gone with it (written before the child waits, so it is there once the child ran).
    let grandchild: u32 = std::fs::read_to_string(dir.path().join("grandchild")).expect("the child started a process").parse().unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let listed = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {grandchild}"), "/NH"]).creation_flags(0x0800_0000).output().expect("tasklist runs");
        assert!(!String::from_utf8_lossy(&listed.stdout).contains(&grandchild.to_string()), "the child's process {grandchild} is gone with it");
    }
    #[cfg(unix)]
    // SAFETY: signal 0 only tests that the process exists.
    assert!(unsafe { libc::kill(grandchild as i32, 0) } != 0, "the child's process {grandchild} is gone with it");
}

/// Each crash point: the child process runs the turn until the store's crash hook kills it, then the thread is opened (the
/// recovery at open) and read, and opened and read again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crashes_replay_as_node_recovers() {
    crash_replays(|name| !name.starts_with("crash-queued-")).await;
}

/// The queue cases: prompts queued while a turn's request is on the wire, killed before the turn takes them, while the request
/// that took them is on the wire, and after it answered (the draft file removed).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_prompts_replay_as_node_keeps_them_across_a_kill() {
    crash_replays(|name| name.starts_with("crash-queued-")).await;
}

async fn crash_replays(wanted: fn(&str) -> bool) {
    let only = std::env::var("TD_ONLY").ok();
    for case in cases().into_iter().filter(|case| case["crash"] == true) {
        let name = case["name"].as_str().unwrap().to_owned();
        if !wanted(&name) || only.as_ref().is_some_and(|only| *only != name) {
            continue;
        }
        let steps = case["steps"].as_array().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut process = spawn_child(&name, dir.path());
        // The child's own 60 s bound starts only once its turn runs: this one covers its start too.
        let status = wait_child(&name, &mut process, Duration::from_secs(120)).await.unwrap_or_else(|expired| panic!("{expired}"));
        assert!(!status.success(), "{name}: the child ended normally");
        // Written just before the kill: the child died at its point, not elsewhere.
        assert!(
            dir.path().join("sends").exists(),
            "{name}: the child was not killed at its point ({status}); its output:\n{}",
            std::fs::read_to_string(dir.path().join("child.log")).unwrap_or_default()
        );
        let killed = steps.iter().position(|step| step["step"] == "killed").unwrap();
        // Steps before the kill are what a client was shown in the owning process (`resume-held`: the live session it resumed).
        // The queue cases: each step the owning process wrote before it died.
        let queued = name.starts_with("crash-queued-");
        for step in &steps[..killed] {
            if queued {
                let file = dir.path().join(format!("step-{}.json", step["step"].as_str().unwrap()));
                let seen: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap_or_else(|_| panic!("{name}: no {}", file.display()))).unwrap();
                same(&name, step, rust_step(&seen));
                continue;
            }
            let resumed: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("resumed.json")).unwrap()).unwrap();
            let mut shown = step.clone();
            if excluded("live-view") {
                shown["view"]["items"] = step["live"]["items"].clone();
            }
            same(&name, &shown, rust_step(&resumed));
        }
        let sends: usize = std::fs::read_to_string(dir.path().join("sends")).unwrap().parse().unwrap();
        assert_eq!(sends, steps[killed]["sends"].as_u64().unwrap() as usize, "{name}: the requests sent before the kill");
        // Whether a file of the data holds the value marked sensitive (`crash-sensitive`): at the kill and after each open.
        let secret = |step: &Value| {
            step.get("secretFiles").map(|files| {
                assert!(excluded("secret-files"), "the recording names the data files; only whether one holds the value is compared, which the manifest must list");
                !files.as_array().unwrap().is_empty()
            })
        };
        let at_kill: bool = std::fs::read_to_string(dir.path().join("secret")).unwrap().parse().unwrap();
        if let Some(want) = secret(&steps[killed]) {
            assert_eq!(at_kill, want, "{name}: a file holds the value at the kill");
        }
        // Before the mark the value was in the draft file (so the redaction is what removed it).
        if let Some(files) = steps[killed].get("secretFilesBeforeMark") {
            assert!(excluded("secret-before-mark"), "{name}: only whether a file held the value is compared, which the manifest must list");
            let before: bool = std::fs::read_to_string(dir.path().join("secret-before")).unwrap().parse().unwrap();
            assert_eq!(before, !files.as_array().unwrap().is_empty(), "{name}: a file holds the value before the mark");
        }
        // The draft file the dead process left, which the next open recovers from: present while the run is not ended, and
        // also when its end is durable and the file not yet removed (`crash-mid-stream`, `crash-saved-uncleared`).
        let id = std::fs::read_to_string(dir.path().join("id")).unwrap();
        let left = checkpoint_in(&dir.path().join("data"), &id);
        if let Some(want) = steps[killed].get("checkpoint") {
            assert_eq!(left, node_checkpoint(want), "{name}: the draft file left at the kill");
        }
        // `crash-saved-uncleared`: only that the file is left is recorded (its seal depends on Node's async journal flush).
        if let Some(present) = steps[killed].get("checkpointPresent") {
            assert!(excluded("saved-uncleared-presence"), "{name}: the recording holds only that the draft file is left, which the manifest must list");
            assert_eq!(!left.is_null(), present.as_bool().unwrap(), "{name}: the draft file left at the kill");
        }
        if queued {
            let (reopened, drained) = reopen_queued(dir.path()).await;
            same(&name, &steps[killed + 1], rust_step(&reopened));
            same(&name, &steps[killed + 2], rust_step(&drained));
            continue;
        }
        for step in &steps[killed + 1..killed + 3] {
            same(&name, step, rust_step(&reopen(dir.path()).await));
            if let Some(want) = secret(step) {
                assert_eq!(secret_on_disk(&dir.path().join("data")), want, "{name} / {}: a file holds the value", step["step"]);
            }
        }
    }
    no_diffs();
}
