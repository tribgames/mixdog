// Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]
//! Scripted-provider tests of the run loop. Each test replays a provider
//! script and compares the transcript and the requests the loop built with the
//! Node loop's behaviour for the same script.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::AgentError;
use mixdog_agent::Run;
use mixdog_agent::RunCarry;
use mixdog_agent::RunConfig;
use mixdog_agent::RunOutput;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::env::*;
use mixdog_agent::limits::TurnLimits;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::message::ToolKind;
use mixdog_agent::tools::ToolEnv;
use mixdog_agent::tools::ToolSet;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockCodec;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::mock::MockRetryDecider;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolApprovalDecision;
use mixdog_protocol::TurnId;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[path = "loop_node_cases.rs"]
mod loop_node_cases;

#[path = "eager_node_cases.rs"]
mod eager_node_cases;

#[path = "ids_node_cases.rs"]
mod ids_node_cases;

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

enum Step {
    Event(StreamEvent),
    Fail(ProviderError),
    Hang,
    /// The stream goes on once the count reaches the number: a response still streaming while the calls it handed over run.
    Until(tokio::sync::watch::Receiver<usize>, usize, &'static str),
    /// The response is still waiting for the wire until the future ends.
    Wire(std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>, &'static str),
    /// The wire's terminal event is in (`ModelStream::on_wire_left`) and the stream works on the ledger's write until the
    /// future ends.
    Ledger(std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>, &'static str),
}

#[allow(clippy::large_enum_variant)]
enum Attempt {
    Stream(Vec<Step>),
    Reject(ProviderError),
}

/// The stream, and the count of completed tool calls it has handed to the core.
struct ScriptedStream(VecDeque<Step>, Option<Arc<dyn Fn() + Send + Sync>>, Arc<std::sync::atomic::AtomicU64>);

#[async_trait]
impl ModelStream for ScriptedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            return match self.0.pop_front() {
                None => None,
                Some(Step::Event(event)) => {
                    if matches!(event, StreamEvent::ToolCallDone(_)) {
                        self.2.fetch_add(1, Ordering::SeqCst);
                    }
                    Some(Ok(event))
                }
                Some(Step::Fail(error)) => Some(Err(error)),
                Some(Step::Hang) => std::future::pending().await,
                Some(Step::Until(mut count, at, what)) => {
                    let reached = tokio::time::timeout(Duration::from_secs(30), count.wait_for(|n| *n >= at)).await;
                    assert!(reached.is_ok(), "the stream waited 30 s for {what}");
                    continue;
                }
                Some(Step::Wire(wait, what)) => {
                    assert!(tokio::time::timeout(Duration::from_secs(30), wait).await.is_ok(), "the stream waited 30 s for {what}");
                    continue;
                }
                Some(Step::Ledger(wait, what)) => {
                    if let Some(left) = &self.1 {
                        left();
                    }
                    assert!(tokio::time::timeout(Duration::from_secs(30), wait).await.is_ok(), "the ledger waited 30 s for {what}");
                    continue;
                }
            };
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        self.1 = Some(left);
    }
}

struct Scripted {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<Attempt>>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
    /// Every `settle_send` the loop made, in order.
    settled: Mutex<Vec<(String, mixdog_core_api::domain::provider::SendEnd)>>,
    /// Completed tool calls the streams handed to the core.
    calls_handed: Arc<std::sync::atomic::AtomicU64>,
    /// The display stages the provider declares (`send_stages`), and whether its attempt raises `requesting` itself.
    stages: mixdog_core_api::domain::provider::SendStages,
    raises_requesting: bool,
    /// An attempt that raised `requesting` holds its response until this resolves (the run's observer saw the stage).
    hold: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// The log each request is appended to as it arrives, where the sends of other senders (a summary route) are too.
    order: Option<Arc<SendLog>>,
    /// Every `release_send` the loop made (what its guard lets go with no runtime).
    released: Mutex<Vec<String>>,
}

/// One send as it was received: whether it is a summary request, and its messages as (role, text).
type Sent = (bool, Vec<(String, String)>);

/// Every send of a scenario in the order it arrived, whoever sent it.
#[derive(Default)]
struct SendLog(Mutex<Vec<Sent>>);

impl Scripted {
    fn new(script: Vec<Attempt>) -> Arc<Self> {
        Self::with_policy(script, RetryPolicy::codex_default())
    }

    /// A provider that raises `requesting` as `stages` declares, and from inside its attempt when `raises_requesting`.
    fn staged(script: Vec<Attempt>, stages: mixdog_core_api::domain::provider::SendStages, raises_requesting: bool) -> Arc<Self> {
        Arc::new(Self { stages, raises_requesting, ..Arc::into_inner(Self::new(script)).expect("one owner") })
    }

    fn with_policy(script: Vec<Attempt>, policy: RetryPolicy) -> Arc<Self> {
        Arc::new(Self {
            stages: Default::default(),
            raises_requesting: false,
            hold: Mutex::new(None),
            id: ProviderId::from("scripted"),
            policy,
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
            settled: Mutex::new(Vec::new()),
            calls_handed: Arc::default(),
            order: None,
            released: Mutex::new(Vec::new()),
        })
    }

    fn settled(&self) -> Vec<(String, mixdog_core_api::domain::provider::SendEnd)> {
        self.settled.lock().unwrap().clone()
    }

    fn groups(&self) -> Vec<Option<String>> {
        self.requests().iter().map(|r| r.options.send_group.clone()).collect()
    }

    fn requests(&self) -> Vec<Arc<ModelRequest>> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl ProviderAdapter for Scripted {
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
    fn send_stages(&self, _model: &str) -> mixdog_core_api::domain::provider::SendStages {
        self.stages
    }
    async fn attempt(
        &self,
        request: Arc<ModelRequest>,
    ) -> Result<Box<dyn ModelStream>, ProviderError> {
        if self.raises_requesting {
            request.options.send_identity.raise_requesting_once();
            let held = self.hold.lock().unwrap().take();
            if let Some(seen) = held {
                let seen = tokio::time::timeout(Duration::from_secs(30), seen).await;
                assert!(seen.is_ok(), "the attempt waited 30 s for the run to be told `requesting` while it still held the response");
            }
        }
        if let Some(log) = &self.order {
            let messages = request.messages.iter().map(|m| (wire_role(&AgentMessage::new(m.clone())).to_owned(), AgentMessage::new(m.clone()).text())).collect();
            log.0.lock().unwrap().push((false, messages));
        }
        self.requests.lock().unwrap().push(request);
        match self.script.lock().unwrap().pop_front() {
            Some(Attempt::Stream(steps)) => Ok(Box::new(ScriptedStream(steps.into(), None, self.calls_handed.clone()))),
            Some(Attempt::Reject(error)) => Err(error),
            None => panic!("provider script exhausted"),
        }
    }
    async fn settle_send(&self, group: &str, end: mixdog_core_api::domain::provider::SendEnd) {
        self.settled.lock().unwrap().push((group.to_owned(), end));
    }
    fn release_send(&self, group: &str) {
        self.released.lock().unwrap().push(group.to_owned());
    }
}

fn text(s: &str) -> Step {
    Step::Event(StreamEvent::TextDelta(s.into()))
}

fn done(stop: StopReason) -> Step {
    Step::Event(StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None })
}

fn call(id: &str, name: &str, args: JsonValue) -> Step {
    Step::Event(StreamEvent::ToolCallDone(ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: args,
        native_type: None,
    }))
}

fn turn(steps: Vec<Step>) -> Attempt {
    Attempt::Stream(steps)
}

// ---------------------------------------------------------------------------
// Host doubles
// ---------------------------------------------------------------------------

struct FixedClock(AtomicI64);
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

struct HalfJitter;
impl JitterSource for HalfJitter {
    fn draw(&self) -> f64 {
        0.5
    }
}

/// Records each wait; with a hold, a wait ends only when the test lets it ([`HeldTimer`]).
#[derive(Default)]
struct RecordedWait(Mutex<Vec<Duration>>, Option<Arc<HeldTimer>>);
#[async_trait]
impl RetryWait for RecordedWait {
    async fn wait(&self, delay: Duration) {
        self.0.lock().unwrap().push(delay);
        if let Some(held) = &self.1 {
            held.waiting.notify_one();
            held.elapse.notified().await;
        }
    }
}

/// The host's timer under the test's hand: a wait announces itself and its time passes when the test says so.
#[derive(Default)]
struct HeldTimer {
    waiting: tokio::sync::Notify,
    elapse: tokio::sync::Notify,
}

#[derive(Default)]
struct Steer(Mutex<Vec<(DrainStage, SteerEntry)>>);
impl Steer {
    fn push(&self, stage: DrainStage, text: &str) {
        self.0.lock().unwrap().push((
            stage,
            SteerEntry {
                content: Content::Text(text.into()),
                text: None,
                ids: vec!["q1".into()],
                submitted_at: None,
                message_id: None,
                mode: SteerMode::Prompt,
                execution: None,
            },
        ));
    }
}
#[async_trait]
impl SteerSource for Steer {
    async fn drain(&self, request: DrainRequest) -> Vec<SteerEntry> {
        let mut queue = self.0.lock().unwrap();
        let (taken, kept): (Vec<_>, Vec<_>) =
            queue.drain(..).partition(|(stage, _)| *stage == request.stage);
        *queue = kept;
        taken.into_iter().map(|(_, entry)| entry).collect()
    }
}

struct Observer {
    events: Mutex<Vec<RunEvent>>,
    retract: Retracted,
    /// Told when the first `requesting` stage arrives.
    requesting: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Holds a permit once an early notice has arrived since the last wait.
    early_arrived: tokio::sync::Notify,
}
impl Observer {
    fn new(retract: Retracted) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
            retract,
            requesting: Mutex::new(None),
            early_arrived: tokio::sync::Notify::new(),
        })
    }
    /// Resolves when the observer is given its first `requesting` stage.
    fn on_requesting(&self) -> tokio::sync::oneshot::Receiver<()> {
        let (told, seen) = tokio::sync::oneshot::channel();
        *self.requesting.lock().unwrap() = Some(told);
        seen
    }
    fn events(&self) -> Vec<RunEvent> {
        self.events.lock().unwrap().clone()
    }
}
impl RunObserver for Observer {
    fn event(&self, event: RunEvent) {
        if matches!(event, RunEvent::Stage(Stage::Requesting))
            && let Some(told) = self.requesting.lock().unwrap().take()
        {
            let _ = told.send(());
        }
        let early = matches!(event, RunEvent::EarlyResult(_));
        self.events.lock().unwrap().push(event);
        if early {
            self.early_arrived.notify_one();
        }
    }
    fn can_retract(&self) -> bool {
        true
    }
    fn retract_text(&self, _retraction: TextRetraction) -> Retracted {
        self.retract
    }
}

#[derive(Default)]
struct Sink {
    committed: Mutex<Vec<AgentMessage>>,
    replaced: Mutex<Vec<(Vec<AgentMessage>, Rewrite)>>,
    ids: AtomicU64,
    /// Storage that never acks.
    stalled: std::sync::atomic::AtomicBool,
    /// A store that cannot classify a message: every commit is refused.
    refused: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl TranscriptSink for Sink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, mixdog_agent::env::CommitError> {
        if self.refused.load(Ordering::Relaxed) {
            return Err(mixdog_agent::env::CommitError::StoreUnavailable);
        }
        let mut committed = self.committed.lock().unwrap();
        committed.push(message.clone());
        Ok(Ticket(committed.len() as u64))
    }
    fn replace(&self, messages: &[AgentMessage], rewrite: &Rewrite) {
        self.replaced.lock().unwrap().push((messages.to_vec(), rewrite.clone()));
    }
    fn message_id(&self) -> String {
        format!("m{}", self.ids.fetch_add(1, Ordering::Relaxed) + 1)
    }
    async fn durable(&self, _ticket: Ticket) {
        if self.stalled.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
    }
}

/// Estimates 100 tokens per message; compaction keeps a summary and the tail.
#[derive(Default)]
struct Compactor100 {
    requests: Mutex<Vec<(usize, CompactTrigger)>>,
    /// The agent cache tail expired.
    cache_expired: bool,
    /// Tool-result media arms a pass.
    request_media: bool,
    /// The pass finds no token reduction.
    skip: bool,
    /// The pass fails.
    fail: bool,
    /// The clock this pass moves, and by how much.
    takes: Option<(Arc<FixedClock>, i64)>,
    /// The attachment preflight rewrites a user message reading "attached" to "referenced".
    preflight: bool,
}
#[async_trait]
impl Compactor for Compactor100 {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        messages.len() as u64 * 100
    }
    async fn preflight_attachments(&self, messages: &[AgentMessage]) -> Option<mixdog_agent::compact::fresh::Preflight> {
        let attached = Content::Text("attached".into());
        if !self.preflight || !messages.iter().any(|m| m.message.content == attached) {
            return None;
        }
        let next = messages
            .iter()
            .map(|m| if m.message.content == attached { AgentMessage::user("referenced") } else { m.clone() })
            .collect();
        Some(mixdog_agent::compact::fresh::Preflight { messages: next, referenced_messages: 1, inline_tokens_before: 1, budget_tokens: 0 })
    }
    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        request.messages.len() > 2
    }
    fn cache_expired(&self) -> bool {
        self.cache_expired
    }
    fn request_media(&self, _: &[AgentMessage]) -> bool {
        self.request_media
    }
    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.requests
            .lock()
            .unwrap()
            .push((request.messages.len(), request.trigger.clone()));
        if let Some((clock, ms)) = &self.takes {
            clock.0.fetch_add(*ms, Ordering::Relaxed);
        }
        if self.fail {
            return Err(CompactError::Failed("boom".into()));
        }
        let mut kept = vec![AgentMessage::user("[summary]")];
        kept.push(request.messages.last().unwrap().clone());
        Ok(CompactOutput {
            messages: kept,
            usage: None,
            dropped_count: (request.messages.len() - 1) as u64,
            dropped: Some(Dropped { message_ids: vec!["gone".into()], call_ids: vec!["call-gone".into()] }),
            skipped: self.skip,
            pipeline_ms: 0.0,
            summary_ms: None,
        })
    }
}

struct Echo(ToolSpec);
impl Echo {
    fn tool() -> Arc<dyn Tool> {
        Arc::new(Self(ToolSpec {
            name: "echo".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "echo".into(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations {
                read_only_hint: Some(true),
                idempotent_hint: Some(true),
                ..ToolAnnotations::default()
            },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }))
    }
}
#[async_trait]
impl Tool for Echo {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput {
            parts: vec![ToolPart::Text(format!("echo:{args}"))],
            ..ToolOutput::default()
        })
    }
}

/// `echo` whose result carries `meta.complete`, as `code_graph` marks a partial answer.
struct Marked(bool);
#[async_trait]
impl Tool for Marked {
    fn spec(&self) -> &ToolSpec {
        static SPEC: std::sync::OnceLock<ToolSpec> = std::sync::OnceLock::new();
        SPEC.get_or_init(|| Echo::tool().spec().clone())
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput {
            parts: vec![ToolPart::Text("body".into())],
            meta: Some(json!({ "complete": self.0 })),
            ..ToolOutput::default()
        })
    }
}

/// Records what the loop admits to the tool-result cache.
#[derive(Default)]
struct Stored(Mutex<Vec<String>>);
#[async_trait]
impl ResultReuse for Stored {
    async fn lookup(&self, _call: &ToolCall, _touch: bool) -> Option<Reused> {
        None
    }
    async fn store(&self, _call: &ToolCall, content: &str, _tool_use_id: &str, _output: &ToolOutput) {
        self.0.lock().unwrap().push(content.to_owned());
    }
    async fn after_call(&self, _call: &ToolCall, _failed: bool) {}
}

#[tokio::test]
async fn a_partial_result_is_never_admitted_to_the_cache() {
    for (complete, stored) in [(true, vec!["body".to_owned()]), (false, Vec::new())] {
        let reuse = Arc::new(Stored::default());
        let mut h = Harness::new(vec![
            turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        h.reuse = Some(reuse.clone());
        finish(h.run(config(), vec![Arc::new(Marked(complete))], vec![AgentMessage::user("go")])).await;
        assert_eq!(*reuse.0.lock().unwrap(), stored, "complete = {complete}");
    }
}

/// `edit` of one file kept in memory, answering as the str-replace adapter does: a unique anchor is replaced, one found more than
/// once is refused as ambiguous unless the call says how many remain (`editOccurrence`), when the first is taken. It counts the
/// runs that ended.
struct AnchoredFile {
    spec: ToolSpec,
    text: Mutex<String>,
    runs: Mutex<Vec<(String, Option<u32>)>>,
    ended: tokio::sync::watch::Sender<usize>,
}

impl AnchoredFile {
    fn new(text: &str) -> Arc<Self> {
        let spec = ToolSpec {
            name: "edit".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "edit".into(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Arc::new(Self { spec, text: Mutex::new(text.into()), runs: Mutex::default(), ended: tokio::sync::watch::Sender::new(0) })
    }
}

#[async_trait]
impl Tool for AnchoredFile {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let (old, new) = (args["old_string"].as_str().unwrap(), args["new_string"].as_str().unwrap());
        let expected = ctx.options.edit_occurrence.map(|o| o.expected);
        self.runs.lock().unwrap().push((ctx.call_id.as_str().to_owned(), expected));
        let outcome = {
            let mut text = self.text.lock().unwrap();
            let found = text.matches(old).count() as u32;
            if found == 1 || (found >= 2 && expected == Some(found)) {
                *text = text.replacen(old, new, 1);
                Ok(ToolOutput { parts: vec![ToolPart::Text("Updated a.txt (1 replacement)".into())], ..ToolOutput::default() })
            } else if found == 0 {
                Err(ToolError::new(ToolErrorCode::NotFound { target: old.into() }, "Error: old_string not found"))
            } else {
                Err(ToolError::new(ToolErrorCode::Conflict { matches: found }, format!("Error: edit failed (old_string found {found} times)")))
            }
        };
        self.ended.send_modify(|n| *n += 1);
        outcome
    }
}

/// `createEagerBarriers` (`eager-dispatch/barriers.mjs:81,96`) lets a same-file edit go when the edit before it settles, an
/// ambiguous one included; its batch-group retry (`retryAmbiguousEdit`) comes when the batch reaches it, here after the response
/// ended, so the edit behind it has already run against the file as the first run left it.
#[tokio::test]
async fn an_edit_behind_an_ambiguous_streamed_edit_runs_before_the_group_retry() {
    let file = AnchoredFile::new("same\nsame\n");
    let edit = |id: &str, new: &str| call(id, "edit", json!({ "file_path": "a.txt", "old_string": "same", "new_string": new }));
    let h = Harness::new(vec![
        turn(vec![
            edit("x1", "one"),
            edit("x2", "two"),
            Step::Until(file.ended.subscribe(), 2, "both streamed edits to end"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![file.clone()], vec![AgentMessage::user("go")])).await;
    let runs = file.runs.lock().unwrap().clone();
    let want: Vec<(String, Option<u32>)> = vec![("x1".into(), None), ("x2".into(), None), ("x1".into(), Some(2)), ("x2".into(), None)];
    assert_eq!(runs, want);
    assert_eq!(*file.text.lock().unwrap(), "one\ntwo\n");
}

/// Releases the held edits, then ends once `id` reached the settle gate.
fn release_until_at_gate(hold: &Arc<mixdog_agent::test_hooks::EditHold>, id: &'static str) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    let (hold, mut at) = (Arc::clone(hold), hold.at_gate());
    Box::pin(async move {
        hold.release();
        let _ = at.wait_for(|seen| seen.iter().any(|(seen, _)| seen == id)).await;
    })
}

/// One `next` waits on the wire, then the response's end arrives and the same `next` goes on to the ledger's write of the
/// completed row (`agent-trace-run` scenario 2): an ambiguous streamed edit settling during the write finds the gate the
/// wire wait opened closed, so it is acted on once the batch is at it and its group retry runs before the edit behind it.
#[tokio::test]
async fn an_ambiguous_edit_settling_in_the_ledger_write_after_a_wait_on_the_wire_finds_the_batch_at_it() {
    let file = AnchoredFile::new("same\nsame\n");
    let hold = Arc::new(mixdog_agent::test_hooks::hold_edits("ledger-phase.txt", &["x1"]));
    let edit = |id: &str, new: &str| call(id, "edit", json!({ "file_path": "ledger-phase.txt", "old_string": "same", "new_string": new }));
    let h = Harness::new(vec![
        turn(vec![
            edit("x1", "one"),
            edit("x2", "two"),
            Step::Until(hold.parked(), 1, "x1 parked before its run"),
            Step::Ledger(release_until_at_gate(&hold, "x1"), "x1 at the settle gate"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![file.clone()], vec![AgentMessage::user("go")])).await;
    assert_eq!(hold.at_gate().borrow().first().cloned(), Some(("x1".to_owned(), false)));
    let runs = file.runs.lock().unwrap().clone();
    let want: Vec<(String, Option<u32>)> = vec![("x1".into(), None), ("x1".into(), Some(2)), ("x2".into(), None)];
    assert_eq!(runs, want);
    assert_eq!(*file.text.lock().unwrap(), "one\ntwo\n");
}

/// The same `next`, with the settlement while it still waits on the wire: the gate is open, the edit behind goes first and
/// the group retry runs after it, as in Node.
#[tokio::test]
async fn an_ambiguous_edit_settling_in_the_wire_wait_before_the_ledger_write_lets_the_edit_behind_it_go() {
    let file = AnchoredFile::new("same\nsame\n");
    let hold = Arc::new(mixdog_agent::test_hooks::hold_edits("wire-phase.txt", &["x1"]));
    let edit = |id: &str, new: &str| call(id, "edit", json!({ "file_path": "wire-phase.txt", "old_string": "same", "new_string": new }));
    let ended = file.ended.subscribe();
    let h = Harness::new(vec![
        turn(vec![
            edit("x1", "one"),
            edit("x2", "two"),
            Step::Until(hold.parked(), 1, "x1 parked before its run"),
            Step::Wire(release_until_at_gate(&hold, "x1"), "x1 at the settle gate"),
            Step::Until(ended, 2, "x2's run to end"),
            Step::Ledger(Box::pin(async {}), "nothing"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![file.clone()], vec![AgentMessage::user("go")])).await;
    assert_eq!(hold.at_gate().borrow().first().cloned(), Some(("x1".to_owned(), true)));
    let runs = file.runs.lock().unwrap().clone();
    let want: Vec<(String, Option<u32>)> = vec![("x1".into(), None), ("x2".into(), None), ("x1".into(), Some(2)), ("x2".into(), None)];
    assert_eq!(runs, want);
    assert_eq!(*file.text.lock().unwrap(), "one\ntwo\n");
}

/// Releases the held edits once the group retry either queued behind a place still held or ran (`ended` runs ended): the
/// retry that a free file lets through first runs before the held edits, the one queued behind them after.
async fn release_after_the_retry(hold: &mixdog_agent::test_hooks::EditHold, file: &AnchoredFile, ended: usize) {
    let (mut waiting, mut runs) = (hold.retries_waiting(), file.ended.subscribe());
    tokio::select! {
        _ = waiting.wait_for(|ids| !ids.is_empty()) => {}
        _ = runs.wait_for(|n| *n >= ended) => {}
    }
    hold.release();
}

/// Runs `run` while `release` frees the held edits; one deadline for both.
async fn finish_with(run: Run, release: impl std::future::Future<Output = ()>) {
    let both = async { tokio::join!(finish(run), release) };
    assert!(tokio::time::timeout(Duration::from_secs(30), both).await.is_ok(), "the run did not end within 30 s");
}

/// The edit an ambiguous streamed edit's settlement lets go holds its place at the file from that settlement on (Node's
/// single thread runs it before anything else reaches the file): parked before its first poll while the response completes
/// and the batch reaches the group retry, it still runs before the retry.
#[tokio::test]
async fn an_edit_let_go_by_a_settlement_runs_before_a_retry_the_batch_reaches_while_it_is_parked() {
    let file = AnchoredFile::new("same\nsame\n");
    let hold = mixdog_agent::test_hooks::hold_edits("gate-one.txt", &["x2"]);
    let edit = |id: &str, new: &str| call(id, "edit", json!({ "file_path": "gate-one.txt", "old_string": "same", "new_string": new }));
    let h = Harness::new(vec![
        turn(vec![edit("x1", "one"), edit("x2", "two"), Step::Until(hold.parked(), 1, "x2 parked before its run"), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish_with(h.run(config(), vec![file.clone()], vec![AgentMessage::user("go")]), release_after_the_retry(&hold, &file, 2)).await;
    let runs = file.runs.lock().unwrap().clone();
    let want: Vec<(String, Option<u32>)> = vec![("x1".into(), None), ("x2".into(), None), ("x1".into(), Some(2)), ("x2".into(), None)];
    assert_eq!(runs, want);
    assert_eq!(*file.text.lock().unwrap(), "one\ntwo\n");
}

/// Two edits behind an ambiguous one: the second is let go by the first's settlement, the third by the second's, so a retry
/// the batch reaches between the two settlements queues behind the second and ahead of the third, as in Node.
#[tokio::test]
async fn a_retry_reached_between_two_settlements_runs_between_the_edits_they_let_go() {
    let file = AnchoredFile::new("same\nsame\nsame\n");
    let hold = mixdog_agent::test_hooks::hold_edits("gate-two.txt", &["x2"]);
    let edit = |id: &str, new: &str| call(id, "edit", json!({ "file_path": "gate-two.txt", "old_string": "same", "new_string": new }));
    let h = Harness::new(vec![
        turn(vec![
            edit("x1", "one"),
            edit("x2", "two"),
            edit("x3", "three"),
            Step::Until(hold.parked(), 1, "x2 parked before its run"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish_with(h.run(config(), vec![file.clone()], vec![AgentMessage::user("go")]), release_after_the_retry(&hold, &file, 2)).await;
    let runs = file.runs.lock().unwrap().clone();
    let want: Vec<(String, Option<u32>)> = vec![
        ("x1".into(), None),
        ("x2".into(), None),
        ("x1".into(), Some(3)),
        ("x3".into(), None),
        ("x2".into(), Some(2)),
        ("x3".into(), None),
    ];
    assert_eq!(runs, want);
    assert_eq!(*file.text.lock().unwrap(), "one\ntwo\nthree\n");
}

/// `echo` whose result carries the given `meta`, as `apply_patch` carries `uiDiff`.
struct WithMeta(JsonValue);
#[async_trait]
impl Tool for WithMeta {
    fn spec(&self) -> &ToolSpec {
        static SPEC: std::sync::OnceLock<ToolSpec> = std::sync::OnceLock::new();
        SPEC.get_or_init(|| Echo::tool().spec().clone())
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text("body".into())], meta: Some(self.0.clone()), ..ToolOutput::default() })
    }
}

/// `echo` that calls the turn's completion hook it finds in its call options.
struct Notifying;
#[async_trait]
impl Tool for Notifying {
    fn spec(&self) -> &ToolSpec {
        static SPEC: std::sync::OnceLock<ToolSpec> = std::sync::OnceLock::new();
        SPEC.get_or_init(|| Echo::tool().spec().clone())
    }
    async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        let delivered = ctx.options.notify.as_ref().map(|n| n.deliver("done", &json!({"status": "completed"})));
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("{delivered:?}"))], ..ToolOutput::default() })
    }
}

/// Node passes the worker turn's `notifyFn` in every tool call's options; a turn without one
/// leaves the options empty.
#[tokio::test]
async fn the_turns_notify_hook_reaches_each_tool_call_s_options() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    for hook in [true, false] {
        let h = Harness::new(vec![
            turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        let mut tool_env = h.tool_env();
        if hook {
            let seen = seen.clone();
            tool_env.notify = Some(mixdog_core_api::domain::tool::ToolNotify(Arc::new(move |text: &str, meta: &JsonValue| {
                seen.lock().unwrap().push((text.to_owned(), meta.clone()));
                true
            })));
        }
        let run = Run::new(
            h.run_env(),
            h.cancel.clone(),
            h.provider.clone(),
            ToolSet::with_builtins(vec![Arc::new(Notifying)], vec!["echo".to_owned()]),
            tool_env,
            config(),
            vec![AgentMessage::user("go")],
            RunCarry::default(),
        );
        let output = finish(run).await;
        let want = if hook { "tool#c1(Normal):Some(true)" } else { "tool#c1(Normal):None" };
        assert_eq!(dump(&output.transcript)[2], want);
    }
    assert_eq!(*seen.lock().unwrap(), vec![("done".to_owned(), json!({"status": "completed"}))]);
}

#[tokio::test]
async fn a_tool_results_ui_diff_rides_its_message_as_a_string_and_stays_off_the_wire() {
    for (meta, want) in [
        (json!({ "uiDiff": "@@ -1 +1 @@" }), Some("@@ -1 +1 @@")),
        (json!({ "uiDiff": 7 }), None),
        (json!({ "other": "x" }), None),
    ] {
        let h = Harness::new(vec![
            turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        let out = finish(h.run(config(), vec![Arc::new(WithMeta(meta.clone()))], vec![AgentMessage::user("go")])).await;
        let result = out.transcript.iter().find(|m| m.tool_call_id() == Some("c1")).expect("tool result");
        assert_eq!(result.ui_diff.as_deref(), want, "{meta}");
        assert_eq!(result.text(), "body");
        assert!(out.transcript.iter().filter(|m| m.tool_call_id() != Some("c1")).all(|m| m.ui_diff.is_none()));
    }
}

/// A loading tool (named `name`) that answers `text`, as `Skill` answers with a native tool-search payload.
struct Loader(ToolSpec, String);
#[async_trait]
impl Tool for Loader {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(self.1.clone())], ..ToolOutput::default() })
    }
}

/// `finalizeBatchResults` turns a loading tool's result that carries `nativeToolSearch` into the
/// message's `native_tool_search` and keeps its summary as the text; the next request carries
/// both (`fixtures/native-tool-search/golden.json`, the recorded Node results).
#[tokio::test]
async fn a_loading_tools_native_search_payload_rides_its_message_to_the_next_request() {
    let golden: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/native-tool-search/golden.json")).unwrap();
    let mut ran = 0;
    for case in golden["parse"].as_array().unwrap().iter().filter(|case| case["toolName"] != "read") {
        let mut spec = Echo::tool().spec().clone();
        spec.name = case["toolName"].as_str().unwrap().to_owned();
        let h = Harness::new(vec![
            turn(vec![call("c1", &spec.name, json!({})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        let loader = Arc::new(Loader(spec, case["result"].as_str().unwrap().to_owned()));
        let out = finish(h.run(config(), vec![loader], vec![AgentMessage::user("go")])).await;
        let result = out.transcript.iter().find(|m| m.tool_call_id() == Some("c1")).expect("tool result");
        let want = Some(case["parsed"].clone()).filter(|parsed| !parsed.is_null());
        assert_eq!(result.message.native_tool_search, want, "{}", case["name"]);
        assert_eq!(result.text(), case["content"].as_str().unwrap(), "{}", case["name"]);
        let sent = h.provider.requests();
        let wire = sent[1].messages.iter().find(|m| m.tool_call_id.as_deref() == Some("c1")).expect("sent tool result");
        assert_eq!(wire.native_tool_search, want, "{}: sent", case["name"]);
        ran += 1;
    }
    assert_eq!(ran, 16);
}

/// Never finishes on its own; ends when its token is cancelled.
struct Hang(ToolSpec);
impl Hang {
    fn tool() -> Arc<dyn Tool> {
        let Echo(mut spec) = Echo(Echo::tool().spec().clone());
        spec.name = "hang".into();
        Arc::new(Self(spec))
    }
}
#[async_trait]
impl Tool for Hang {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        ctx.cancel.cancelled().await;
        Err(ToolError::new(ToolErrorCode::Cancelled, "Cancelled"))
    }
}

struct AskFirst;
#[async_trait]
impl ToolGate for AskFirst {
    async fn check_call(&self, _call_id: &str, call: &GateCall) -> GateDecision {
        GateDecision::Ask(Box::new(GateAsk {
            reason: "needs a person".into(),
            ask: ApprovalAsk {
                kind: ApprovalKind::Tool,
                call_id: None,
                tool: Some(call.name.clone()),
                action_kind: None,
                reason: Some("needs a person".into()),
                payload: call.args.clone(),
                remember: Vec::new(),
                expires_after: None,
            },
            call: None,
        }))
    }
}

struct Harness {
    provider: Arc<Scripted>,
    steer: Arc<Steer>,
    observer: Arc<Observer>,
    sink: Arc<Sink>,
    waiter: Arc<RecordedWait>,
    approvals: Arc<MockApprovalGate>,
    gate: Arc<dyn ToolGate>,
    compactor: Option<Arc<Compactor100>>,
    /// The product's own compactor, where a test compacts for real instead of through `Compactor100`.
    real_compactor: Option<Arc<dyn Compactor>>,
    tail: Option<Arc<dyn TailReminder>>,
    side: Option<Arc<dyn mixdog_agent::env::SendTap>>,
    reuse: Option<Arc<dyn ResultReuse>>,
    route: Option<Arc<dyn RouteFallback>>,
    mcp: Option<Arc<dyn mixdog_agent::env::McpCatalog>>,
    failures: Option<Arc<dyn mixdog_agent::env::ToolFailureLog>>,
    artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    cancel: CancellationToken,
    clock: Arc<FixedClock>,
    /// A working directory and the file service holding it, where a test runs a real file tool over files.
    sandbox: Option<(mixdog_core_api::domain::common::AbsPath, Arc<MockFileService>)>,
    /// A real adapter and the decider that judges its failures, in place of the scripted provider.
    real: Option<(Arc<dyn ProviderAdapter>, Arc<dyn mixdog_core_api::domain::retry::RetryDecider>)>,
}

/// The calls the loop reported to the host's failure log.
#[derive(Default)]
struct FailureLog(Mutex<Vec<mixdog_agent::env::FailedCall>>);

impl mixdog_agent::env::ToolFailureLog for FailureLog {
    fn failed(&self, call: mixdog_agent::env::FailedCall) {
        self.0.lock().unwrap().push(call);
    }

    fn stall_abort(&self, _ctx: serde_json::Map<String, serde_json::Value>) {
        panic!("the agent loop never records a watchdog stop: its host's watchdog does");
    }
}

impl Harness {
    fn new(script: Vec<Attempt>) -> Self {
        Self {
            provider: Scripted::new(script),
            steer: Arc::new(Steer::default()),
            observer: Observer::new(Retracted::Withdrawn),
            sink: Arc::new(Sink::default()),
            waiter: Arc::new(RecordedWait::default()),
            approvals: Arc::new(MockApprovalGate::default()),
            gate: Arc::new(AllowAll),
            compactor: None,
            real_compactor: None,
            tail: None,
            side: None,
            reuse: None,
            route: None,
            mcp: None,
            failures: None,
            artifacts: None,
            cancel: CancellationToken::new(),
            clock: Arc::new(FixedClock(AtomicI64::new(1_000))),
            sandbox: None,
            real: None,
        }
    }

    fn with_adapter(provider: Arc<dyn ProviderAdapter>) -> Self {
        Self { real: Some((provider, Arc::new(mixdog_ai::retry::StandardRetryDecider))), ..Self::new(Vec::new()) }
    }

    fn with_policy(script: Vec<Attempt>, policy: RetryPolicy) -> Self {
        Self { provider: Scripted::with_policy(script, policy), ..Self::new(Vec::new()) }
    }

    fn with_tail(mut self, context: mixdog_agent::tail_rules::TailContext) -> Self {
        self.tail = Some(Arc::new(mixdog_agent::tail_rules::RuleTailReminder { context }));
        self
    }

    fn run(&self, config: RunConfig, tools: Vec<Arc<dyn Tool>>, messages: Vec<AgentMessage>) -> Run {
        let names = tools.iter().map(|t| t.spec().name.clone()).collect();
        self.run_with_builtins(config, tools, names, messages)
    }

    fn run_env(&self) -> RunEnv {
        RunEnv {
            clock: self.clock.clone(),
            jitter: Arc::new(HalfJitter),
            waiter: self.waiter.clone(),
            decider: self.real.as_ref().map_or_else(|| Arc::new(MockRetryDecider) as Arc<dyn mixdog_core_api::domain::retry::RetryDecider>, |(_, decider)| decider.clone()),
            steer: self.steer.clone(),
            observer: self.observer.clone(),
            sink: self.sink.clone(),
            gate: Arc::clone(&self.gate),
            guards: Arc::new(NoGuards),
            compactor: self.compactor.clone().map(|c| c as Arc<dyn Compactor>).or_else(|| self.real_compactor.clone()),
            route: self.route.clone(),
            skills: None,
            hooks: None,
            reuse: self.reuse.clone(),
            reactions: None,
            tail: self.tail.clone(),
            mcp: self.mcp.clone(),
            side: self.side.clone(),
            step_judge: None,
            artifacts: self.artifacts.clone(),
            images: None,
            failures: self.failures.clone(),
        }
    }

    fn tool_env(&self) -> ToolEnv {
        let tokens = mixdog_rt::testing::tokens();
        ToolEnv {
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            cwd: self.sandbox.as_ref().map_or_else(|| mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).unwrap(), |(cwd, _)| cwd.clone()),
            surface: SurfaceKind::Lead,
            io: ToolIo {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
            },
            approvals: self.approvals.clone(),
            files: self.sandbox.as_ref().map_or_else(|| Arc::new(MockFileService::default()), |(_, files)| files.clone()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            deadline_of: None,
            notify: None,
            review: None,
        }
    }

    fn run_with_builtins(
        &self,
        config: RunConfig,
        tools: Vec<Arc<dyn Tool>>,
        builtins: Vec<String>,
        messages: Vec<AgentMessage>,
    ) -> Run {
        let env = self.run_env();
        let tool_env = self.tool_env();
        Run::new(
            env,
            self.cancel.clone(),
            self.real.as_ref().map_or_else(|| self.provider.clone() as Arc<dyn ProviderAdapter>, |(provider, _)| provider.clone()),
            ToolSet::with_builtins(tools, builtins),
            tool_env,
            config,
            messages,
            RunCarry::default(),
        )
    }
}

fn config() -> RunConfig {
    RunConfig::new(ThreadId::from("t"), TurnId::from("r"), "m")
}

/// One line per message: role, source, calls or call id, text.
fn dump(messages: &[AgentMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|m| {
            let role = format!("{:?}", m.role()).to_lowercase();
            let source = m.source.map(|s| format!("<{s:?}>")).unwrap_or_default();
            let calls: Vec<String> = m.tool_calls().iter().map(|c| format!("{}#{}", c.name, c.id)).collect();
            let id = m.tool_call_id().map(|i| format!("#{i}")).unwrap_or_default();
            let kind = m.tool_kind.map(|k| format!("({k:?})")).unwrap_or_default();
            let calls = if calls.is_empty() { String::new() } else { format!("[{}]", calls.join(",")) };
            format!("{role}{source}{id}{kind}{calls}:{}", m.text())
        })
        .collect()
}

fn wire_dump(request: &ModelRequest) -> Vec<String> {
    request
        .messages
        .iter()
        .map(|m| match &m.content {
            Content::Text(t) => format!("{:?}:{t}", m.role),
            Content::Parts(_) => format!("{:?}:<parts>", m.role),
        })
        .collect()
}

async fn finish(run: Run) -> RunOutput {
    match run.run().await {
        Ok(output) => output,
        Err(failure) => panic!("run failed: {}", failure.error),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_round_then_final_text() {
    let h = Harness::new(vec![
        turn(vec![
            text("looking"),
            call("c1", "echo", json!({"a": 1})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("all done"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "all done");
    assert_eq!(output.iterations, 2);
    assert_eq!(output.tool_calls_total, 1);
    assert_eq!(
        dump(&output.transcript),
        [
            "user:go",
            "assistant[echo#c1]:looking",
            "tool#c1(Normal):echo:{\"a\":1}",
        ]
    );
    let second = &h.provider.requests()[1];
    assert_eq!(wire_dump(second), ["User:go", "Assistant:looking", "Tool:echo:{\"a\":1}"]);
    // the assistant turn with calls and each result reached the sink in order
    assert_eq!(h.sink.committed.lock().unwrap().len(), 2);
}

/// The host's request hook runs before every provider attempt of the turn, once per request.
#[tokio::test]
async fn the_request_hook_runs_before_each_provider_attempt() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let begun = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut config = config();
    let counter = begun.clone();
    config.request_begin = Some(Arc::new(move || {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    finish(h.run(config, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(h.provider.requests().len(), 2);
    assert_eq!(begun.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn provider_state_is_sent_updated_by_the_provider_and_handed_back() {
    use mixdog_core_api::domain::provider::ProviderState;
    // An empty reported state means "clear"; it is still a reported change.
    let h = Harness::new(vec![
        turn(vec![
            Step::Event(StreamEvent::ProviderState(ProviderState::default())),
            call("c1", "echo", json!({})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.options.provider_state = None;
    let output = finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let requests = h.provider.requests();
    assert_eq!(requests[0].options.provider_state, None);
    assert_eq!(requests[1].options.provider_state, Some(ProviderState::default()));
    assert_eq!(output.provider_state, Some(ProviderState::default()));

    // No report: nothing to save.
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.provider_state, None);
}

/// What Node's `agentLoop` calls the observer's callbacks with when the provider raises a notice among the other
/// things a send reports (`fixtures/wire-anthropic-gemini/observer.json`, recorded by
/// `benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs`): the whole ordered stream, notices included,
/// compared with every event the run loop gave its observer. An event with no Node callback to compare with is
/// rendered as what it is, so it shows as a difference instead of being left out.
#[tokio::test]
async fn the_observer_stream_of_a_provider_notice_is_nodes_whole() {
    let recording: JsonValue = serde_json::from_str(include_str!("../../../../fixtures/wire-anthropic-gemini/observer.json")).expect("observer.json");
    let mut differences = Vec::new();
    for scenario in recording["scenarios"].as_array().expect("scenarios") {
        let id = scenario["id"].as_str().expect("id");
        let mut steps = Vec::new();
        let mut notices = Vec::new();
        let mut refusal = None;
        for step in scenario["steps"].as_array().expect("steps") {
            match step[0].as_str().expect("kind") {
                "notice" => {
                    let warn = step[1] == "warn";
                    let message = step[2].as_str().expect("message").to_owned();
                    steps.push(Step::Event(StreamEvent::Notice { message: message.clone(), warn }));
                    notices.push((message, warn));
                }
                "text" => steps.push(text(step[1].as_str().expect("text"))),
                "fail" => {
                    // The adapter hands the notices it raised before the failure over with it.
                    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted);
                    error.status = step[1].as_u64().map(|s| s as u16);
                    error.message = step[2].as_str().expect("message").to_owned();
                    error.notices = std::mem::take(&mut notices);
                    refusal = Some(error);
                }
                other => panic!("{other}"),
            }
        }
        let script = vec![match refusal {
            Some(error) => Attempt::Reject(error),
            None => {
                steps.push(done(StopReason::EndTurn));
                turn(steps)
            }
        }];
        // The two equesting of the send are the provider's own stages (preparing): Node's admission scheduler and its
        // adapter raise them.
        let stages = mixdog_core_api::domain::provider::SendStages { preparing: 2, ..Default::default() };
        let h = Harness { provider: Scripted::staged(script, stages, false), ..Harness::new(Vec::new()) };
        let ended = h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run().await;
        let mut stream: Vec<JsonValue> = Vec::new();
        for event in h.observer.events() {
            stream.extend(callbacks_of(event));
        }
        // Events of the loop's own with no callback in this recording: the turn's effort when the run starts (Node's
        // `runtime.turnEffort` is a getter the client reads, not a callback), the two `Stage(Requesting)` of the send (Node's
        // admission scheduler and provider adapter raise them, and the recording's scripted `send` is neither),
        // `Stage(Streaming)` when the stream opens, and the send's `Usage` when it ends (Node's loop keeps its usage in the
        // result and makes no `onUsage` call). They are part of the compared stream at their place, so any other event,
        // or one of them anywhere else, is a difference.
        let mut node: Vec<JsonValue> = scenario["observed"].as_array().expect("observed").clone();
        node.insert(0, json!(["no Node callback", "TurnEffort(None)"]));
        for _ in 0..2 {
            node.insert(2, json!(["no Node callback", "Stage(Requesting)"]));
        }
        if scenario["outcome"]["content"].is_string() {
            node.insert(4, json!(["no Node callback", "Stage(Streaming)"]));
            node.push(json!(["no Node callback", "Usage"]));
        }
        if JsonValue::Array(stream.clone()) != JsonValue::Array(node.clone()) {
            differences.push(format!("{id}: observer stream: Node {} / Rust {}", JsonValue::Array(node), JsonValue::Array(stream)));
        }
        if ended.is_err() != scenario["outcome"]["error"].is_string() {
            differences.push(format!("{id}: outcome: Node {} / Rust failed: {}", scenario["outcome"], ended.is_err()));
        }
    }
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.join("\n"));
}

/// The Node callback(s) one run event is: a text delta is the provider's `onStreamDelta('text')` then `onTextDelta`
/// (`StreamEvent::progress_kind`), a notice is `onStageChange('notice', { tone, message })`.
fn callbacks_of(event: RunEvent) -> Vec<JsonValue> {
    match event {
        RunEvent::TextDelta(text) => vec![json!(["onStreamDelta", "text"]), json!(["onTextDelta", text])],
        RunEvent::Stage(Stage::Notice { message, tone }) => vec![json!(["onStageChange", "notice", { "tone": tone.as_str(), "message": message }])],
        RunEvent::Usage { .. } => vec![json!(["no Node callback", "Usage"])],
        RunEvent::ProviderSendStarted => vec![json!(["onProviderSendStarted"])],
        other => vec![json!(["no Node callback", format!("{other:?}")])],
    }
}

#[tokio::test]
async fn steering_enters_after_the_tool_batch_and_before_the_next_request() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.steer.push(DrainStage::PreSend, "  also check b ");
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(
        dump(&output.transcript),
        [
            "user:go",
            "assistant[echo#c1]:",
            "tool#c1(Normal):echo:{}",
            "user<Steering>:also check b",
        ]
    );
    let second = &h.provider.requests()[1];
    let last = second.messages.last().unwrap();
    assert_eq!(last.source, Some(MessageSource::Steering));
    let injected = h
        .observer
        .events()
        .into_iter()
        .find_map(|e| match e {
            RunEvent::SteerInjected(s) => Some(s),
            _ => None,
        })
        .expect("steer event");
    assert_eq!(injected.ids, ["q1"]);
    assert_eq!(injected.message_id, "m1");
}

#[tokio::test]
async fn terminal_steering_keeps_the_ended_answer_and_resumes() {
    let h = Harness::new(vec![
        turn(vec![text("first"), done(StopReason::EndTurn)]),
        turn(vec![text("second"), done(StopReason::EndTurn)]),
    ]);
    h.steer.push(DrainStage::Terminal, "one more thing");
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(
        dump(&output.transcript),
        ["user:go", "assistant:first", "user<Steering>:one more thing"]
    );
    // the caller gets every segment, history keeps the terminal one
    assert_eq!(output.response.content, "first\n\nsecond");
    assert_eq!(output.response.history_text(), "second");
}

#[tokio::test]
async fn output_limit_ladder_escalates_once_then_resumes_then_ends() {
    let cut = |t: &str| turn(vec![text(t), done(StopReason::MaxTokens)]);
    let h = Harness::new(vec![
        cut("aa"),
        cut("bb"),
        turn(vec![text("cc"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.escalated_max_output_tokens = Some(8_000);
    let output = finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    let requests = h.provider.requests();
    assert_eq!(requests[0].options.max_output_tokens_override, None);
    // first cut: same transcript, higher limit, nothing appended
    assert_eq!(requests[1].options.max_output_tokens_override, Some(8_000));
    assert_eq!(wire_dump(&requests[1]), ["User:go"]);
    // second cut: partial kept, resume prompt appended, no override
    assert_eq!(requests[2].options.max_output_tokens_override, None);
    assert_eq!(requests[2].messages.len(), 3);
    assert_eq!(
        dump(&output.transcript),
        [
            "user:go",
            "assistant:bb",
            "user<MaxOutputRecovery>:[mixdog-runtime] Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where you left off, and break the remaining work into smaller pieces."
        ]
    );
    assert_eq!(output.response.content, "bbcc");
    assert_eq!(output.response.history_text(), "cc");
}

#[tokio::test]
async fn output_limit_ladder_ends_with_the_visible_notice() {
    let cut = |t: &str| turn(vec![text(t), done(StopReason::MaxTokens)]);
    let h = Harness::new(vec![cut("a"), cut("b"), cut("c"), cut("d")]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.max_output_recovery_attempts, Some(3));
    assert!(output.response.content.ends_with(
        "d\n\n[mixdog-runtime] The model hit its output limit and the response stayed truncated after 3 recovery attempts."
    ));
    assert_eq!(output.termination, Some(mixdog_agent::response::Termination::Truncated));
}

#[tokio::test]
async fn empty_turns_are_nudged_three_times_then_end_empty() {
    let empty = || turn(vec![done(StopReason::EndTurn)]);
    let h = Harness::new(vec![empty(), empty(), empty(), empty()]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.termination, Some(mixdog_agent::response::Termination::Empty));
    let dumped = dump(&output.transcript);
    assert_eq!(dumped.len(), 4);
    assert_eq!(
        dumped[3],
        "user:[mixdog-runtime] Empty response (3/3). Return final text, or use tools only for required evidence still missing."
    );
}

#[tokio::test]
async fn a_transient_failure_is_retried_through_the_decider_and_the_host_wait() {
    let reset = ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous);
    let h = Harness::new(vec![
        Attempt::Reject(reset),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "ok");
    // request row: exponential 200 ms, symmetric jitter drawn at 0.5 → unchanged
    assert_eq!(*h.waiter.0.lock().unwrap(), [Duration::from_millis(200)]);
    let reconnecting = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::Reconnecting { attempt, max, .. }) => Some((attempt, max)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(reconnecting, [(1, 4)]);
    assert_eq!(h.provider.requests().len(), 2);
}

/// The provider's own `requesting` stages (`onStageChange('requesting')`) reach the run's observer where the provider
/// raises them: once before a send's first attempt, before every attempt, or from inside an attempt.
#[tokio::test]
async fn the_loop_raises_the_requesting_stage_where_the_provider_does() {
    use mixdog_core_api::domain::provider::SendStages;
    let stage_order = |stages: SendStages, raises_requesting: bool| async move {
        let reset = ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous);
        let script = vec![Attempt::Reject(reset), turn(vec![text("ok"), done(StopReason::EndTurn)])];
        let h = Harness { provider: Scripted::staged(script, stages, raises_requesting), ..Harness::new(Vec::new()) };
        finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
        h.observer
            .events()
            .into_iter()
            .filter_map(|e| match e {
                RunEvent::Stage(Stage::Requesting) => Some("requesting"),
                RunEvent::Stage(Stage::Reconnecting { .. }) => Some("reconnecting"),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let plain = SendStages::default();
    assert_eq!(stage_order(plain, false).await, ["reconnecting"], "a provider that raises none");
    assert_eq!(stage_order(SendStages { preparing: 1, ..plain }, false).await, ["requesting", "reconnecting"], "once before the first attempt");
    assert_eq!(stage_order(SendStages { each_attempt: true, ..plain }, false).await, ["requesting", "reconnecting", "requesting"], "before every attempt");
    assert_eq!(stage_order(plain, true).await, ["requesting", "reconnecting"], "raised from inside the attempt, once");
}

/// The stage is delivered when the request goes out: an attempt that raised `requesting` and is still holding its
/// response (the API route reads the first output before it returns) has already shown it to the run's observer, which
/// starts the liveness clock then and not when the attempt ends.
#[tokio::test]
async fn requesting_reaches_the_run_while_the_attempt_still_holds_the_response() {
    let script = vec![turn(vec![text("ok"), done(StopReason::EndTurn)])];
    let h = Harness { provider: Scripted::staged(script, Default::default(), true), ..Harness::new(Vec::new()) };
    *h.provider.hold.lock().unwrap() = Some(h.observer.on_requesting());
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
}

/// A stream issued again after it opened (a mid-stream retry) raises the provider's once-per-ladder `requesting` again,
/// as Node's stream loop does for each issue (anthropic.mjs:300); a refused request's retry does not.
#[tokio::test]
async fn a_reissued_stream_raises_requesting_again() {
    let stages = |script: Vec<Attempt>| async move {
        let h = Harness { provider: Scripted::staged(script, Default::default(), true), ..Harness::new(Vec::new()) };
        finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
        h.observer
            .events()
            .into_iter()
            .filter_map(|e| match e {
                RunEvent::Stage(Stage::Requesting) => Some("requesting"),
                RunEvent::Stage(Stage::Reconnecting { .. }) => Some("reconnecting"),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let reset = || ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous);
    let ok = || turn(vec![text("ok"), done(StopReason::EndTurn)]);
    assert_eq!(stages(vec![Attempt::Stream(vec![Step::Fail(reset())]), ok()]).await, ["requesting", "reconnecting", "requesting"]);
    assert_eq!(stages(vec![Attempt::Reject(reset()), ok()]).await, ["requesting", "reconnecting"]);
}

/// The transport fault Node's provider error ended in: the last link of the recorded cause chain
/// (`connect_errors.json`, `ended.chain`), which is what the provider's classifier reads.
fn recorded_fault(ended: &JsonValue) -> TransportFault {
    let last = ended["chain"].as_array().unwrap().last().unwrap();
    match (last["code"].as_str(), last["message"].as_str().unwrap()) {
        (Some("ECONNREFUSED"), _) => TransportFault::Connect { os_code: None },
        (Some("ENOTFOUND"), _) => TransportFault::Dns,
        (Some("ECONNRESET"), _) => TransportFault::Reset,
        (Some("TRUNCATED_STREAM"), _) => TransportFault::TruncatedStream,
        (None, "bad port") => TransportFault::Io { os_code: None },
        other => panic!("an unrecorded terminal error {other:?}"),
    }
}

/// Replays one case of `golden/connect_errors.json`: a send Node's real `OpenAICompatProvider.send` and `sendWithRecovery`
/// (`connect-errors/record.mjs`) failed every time, before the first byte or after the headers (`after_headers`: the stream
/// starts and is cut). The provider answers the recorded terminal error each time; the run must make as many attempts as
/// Node did, wait as long between them (provider ladder, then the loop's own wait, each lap), show the same reconnect
/// stages, replay as often as Node's loop did, and end with the error Node's loop ended with: its text, its fault, and
/// whether it is a connect failure (the class `providerRecoveryEnded`, `send-with-recovery.mjs:190`, keeps waiting out).
/// Returns the reconnect stages and the replays the recording shows.
async fn replay_connect_case(name: &str, after_headers: bool) -> (Vec<(u32, u32)>, usize) {
    let golden: JsonValue =
        serde_json::from_str(&std::fs::read_to_string(golden_dir().join("connect-errors/golden/connect_errors.json")).unwrap()).unwrap();
    let case = &golden["cases"][name];
    let ended = &case["ended"];
    assert_eq!(ended["kind"], "threw", "{name}");
    let fault = recorded_fault(ended);
    let mut error = ProviderError::transport(
        fault.clone(),
        if after_headers { DeliveryState::Accepted } else { DeliveryState::NotSent },
    );
    error.message = ended["message"].as_str().unwrap().to_owned();
    let laps = case["laps"].as_array().unwrap();
    let attempts: usize = laps.iter().map(|lap| lap["providerWaitsMs"].as_array().unwrap().len() + 1).sum();
    let script = |error: &ProviderError| if after_headers { turn(vec![Step::Fail(error.clone())]) } else { Attempt::Reject(error.clone()) };
    let h = Harness::with_policy(
        (0..attempts).map(|_| script(&error)).collect(),
        mixdog_ai::providers::compat::retry::unprofiled(),
    );
    let failure = h
        .run(config(), vec![], vec![AgentMessage::user("go")])
        .run()
        .await
        .expect_err("the send fails as Node's did");
    let AgentError::Provider(ended_with) = &failure.error else { panic!("{name}: not a provider error: {:?}", failure.error) };
    assert_eq!(ended_with.message, error.message, "{name}: message");
    assert_eq!(ended_with.transport, Some(fault.clone()), "{name}: fault");
    assert_eq!(ended["connectFailure"], matches!(fault, TransportFault::Connect { .. } | TransportFault::Dns), "{name}: connect failure");
    assert_eq!(h.provider.requests().len(), attempts, "{name}: attempts");
    let mut waits = Vec::new();
    let mut shown = Vec::new();
    for lap in laps {
        waits.extend(lap["providerWaitsMs"].as_array().unwrap().iter().map(|ms| Duration::from_millis(ms.as_u64().unwrap())));
        if let Some(ms) = lap["loopWaitMs"].as_u64() {
            waits.push(Duration::from_millis(ms));
            shown.push((lap["shown"]["attempt"].as_u64().unwrap() as u32, lap["shown"]["max"].as_u64().unwrap() as u32));
        }
    }
    assert_eq!(*h.waiter.0.lock().unwrap(), waits, "{name}: waits");
    let loop_stages = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::Reconnecting { attempt, max, .. }) if max > 4 => Some((attempt, max)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(loop_stages, shown, "{name}: reconnect stages");
    let replays = laps.iter().filter(|lap| lap["verdict"] == "retry_transport").count();
    assert_eq!(loop_stages.len(), replays, "{name}: replays");
    (loop_stages, replays)
}

#[tokio::test]
async fn an_unreachable_network_is_retried_on_the_outage_ladder_then_fails_as_nodes_loop_does() {
    for name in ["refused", "dns"] {
        let (stages, replays) = replay_connect_case(name, false).await;
        assert!(replays > 0 && stages.len() == replays, "{name}: the outage ladder replays");
    }
}

#[tokio::test]
async fn a_reset_or_a_refused_port_before_any_header_is_not_replayed_by_the_loop() {
    for name in ["reset", "badPort"] {
        let (stages, replays) = replay_connect_case(name, false).await;
        assert_eq!((stages.len(), replays), (0, 0), "{name}");
    }
}

/// Repeated post-header cuts spend what Node's did: the provider's one ladder (five attempts), and no loop replay, since
/// the exhausted ladder of a cut stream is final (`providerRecoveryEnded`: not a connect failure, not an unavailable server).
#[tokio::test]
async fn repeated_cuts_after_the_headers_spend_one_provider_ladder_and_are_not_replayed() {
    let (stages, replays) = replay_connect_case("cutRole", true).await;
    assert_eq!((stages.len(), replays), (0, 0));
}
/// The handshake headers the WebSocket client library adds below the dial; every other header is the product's.
const LIBRARY_HEADERS: [&str; 6] = ["sec-websocket-version", "sec-websocket-key", "sec-websocket-extensions", "connection", "upgrade", "host"];

/// An upgrade request as the comparison reads it: header names lower-cased, the library's headers left out, the
/// per-request random id (the recording holds the marker `<random:hex32>`) required to be 32 hex digits.
fn upgrade(method: &str, target: &str, headers: Vec<(String, String)>) -> JsonValue {
    let headers: Vec<JsonValue> = headers
        .into_iter()
        .map(|(name, value)| (name.to_lowercase(), value))
        .filter(|(name, _)| !LIBRARY_HEADERS.contains(&name.as_str()))
        .map(|(name, value)| {
            if name == "x-client-request-id" && value != "<random:hex32>" {
                assert!(value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()), "the request id is 32 hex digits");
                return json!([name, "<random:hex32>"]);
            }
            json!([name, value])
        })
        .collect();
    json!({"upgrade": {"method": method, "target": target, "headers": headers}})
}

fn wire_of(wire: &[mixdog_ai::providers::openai::scripted::Wire]) -> Vec<JsonValue> {
    use mixdog_ai::providers::openai::scripted::Wire;
    wire.iter()
        .map(|w| match w {
            Wire::Upgrade { method, target, headers } => upgrade(method, target, headers.clone()),
            Wire::Frame(text) => json!({"frame": text}),
        })
        .collect()
}

/// What Node's server saw from the client: the upgrade requests and the request frames, in the order recorded.
/// The other events (the server's answers, which the script feeds, and the socket and telemetry events) are the ones the
/// manifest declares as not compared.
fn node_wire(events: &[JsonValue]) -> Vec<JsonValue> {
    let mut seen = Vec::new();
    for e in events {
        match (e["event"].as_str().unwrap(), e["dir"].as_str()) {
            ("upgrade-request", _) => seen.push(upgrade(
                e["method"].as_str().unwrap(),
                e["target"].as_str().unwrap(),
                e["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect(),
            )),
            ("frame", Some("client->server")) => seen.push(json!({"frame": e["text"]})),
            _ => {}
        }
    }
    seen
}

/// Node's recordings of a WebSocket outage (`provider-openai-ws-send-attempts`, the `outage` cases: handshake resets,
/// stuck upgrades, refusals and stream drops in every order, each sent by the public OpenAI provider): the real OpenAI
/// adapter over a scripted dial, driven by the real agent loop and retry decider, puts on the wire what Node's send did
/// (every upgrade request and every request frame, whole and in the recorded order) and surfaces the error Node's send
/// surfaced, worded as the user reads it. The server side of each recording is the script; the manifest declares what a
/// replay leaves out.
#[tokio::test(start_paused = true)]
async fn an_outage_surfaces_the_error_nodes_websocket_send_surfaced() {
    const RECORDING: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/provider-openai-ws-send-attempts/cases.json");
    let recording: JsonValue = serde_json::from_str(&RECORDING).unwrap();
    let mut replayed = 0;
    for case in recording["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let Some(attempts) = case["input"]["attempts"].as_array() else { continue };
        let mut script = Vec::new();
        for attempt in attempts {
            match &attempt["upgrade"] {
                JsonValue::String(kind) if kind == "reset" => script.push(mixdog_ai::providers::openai::scripted::Dialed::Reset),
                JsonValue::String(_) => script.extend((0..5).map(|_| mixdog_ai::providers::openai::scripted::Dialed::Stuck)),
                JsonValue::Object(refusal) => script.push(mixdog_ai::providers::openai::scripted::Dialed::Rejected {
                    status: refusal["status"].as_u64().unwrap() as u16,
                    body: refusal["body"].as_str().unwrap().to_owned(),
                }),
                _ => {
                    let close = &attempt["close"];
                    let (code, reason) = match close[0].as_u64() {
                        Some(code) => (code as u16, close[1].as_str().unwrap().to_owned()),
                        None => (1006, String::new()),
                    };
                    let frames = attempt["frames"].as_array().unwrap().iter().map(|frame| frame.to_string()).collect();
                    script.push(mixdog_ai::providers::openai::scripted::Dialed::Socket { frames, close: (code, reason) });
                }
            }
        }
        // Past the recorded attempts every upgrade is left unanswered, as in the recording.
        script.extend((0..40).map(|_| mixdog_ai::providers::openai::scripted::Dialed::Stuck));
        let dial = mixdog_ai::providers::openai::scripted::ScriptedDial::with(script);
        let h = Harness::with_adapter(mixdog_ai::providers::openai::scripted::adapter(dial.clone(), mixdog_rt::testing::tokens().cpu_bulk, mixdog_ai::providers::openai::switch::TransportMode::WsDelta));
        let request = &case["input"]["request"];
        let model = request["model"].as_str().unwrap();
        let message = request["messages"][0]["content"].as_str().unwrap();
        let mut run_config = RunConfig::new(ThreadId::from("t"), TurnId::from("r"), model);
        run_config.options.session_id = Some(case["input"]["sessionId"].as_str().unwrap().into());
        let failure = h
            .run(run_config, vec![], vec![AgentMessage::user(message)])
            .run()
            .await
            .expect_err("the outage ends in a failure");
        let AgentError::Provider(error) = failure.error else { panic!("{id}: a provider error") };

        let node = &case["result"]["error"];
        let events = case["result"]["events"].as_array().unwrap();
        let node_message = node["message"].as_str().unwrap();
        if node_message.starts_with("OpenAI OAuth WS closed before response.completed") {
            assert_eq!(error.message, node_message, "{id}: the error that surfaced");
        } else if node["code"] == "EWSACQUIRETIMEOUT" {
            assert_eq!(error.code.as_deref(), Some("EWSACQUIRETIMEOUT"), "{id}: the error that surfaced");
        } else if node["code"] == "ECONNRESET" {
            assert_eq!(error.transport, Some(TransportFault::Reset), "{id}: the error that surfaced");
        } else {
            assert_eq!(error.status.map(u64::from), node["props"]["httpStatus"].as_u64(), "{id}: the error that surfaced");
        }
        // The requests and frames in recorded order, compared whole.
        let (sent, seen) = (wire_of(&dial.wire()), node_wire(events));
        if sent != seen {
            let at = sent.iter().zip(&seen).position(|(a, b)| a != b).unwrap_or(sent.len().min(seen.len()));
            panic!(
                "{id}: what reached the server differs at event {at} (the replay sent {}, Node's server saw {}):\n  replay: {:?}\n  node:   {:?}",
                sent.len(),
                seen.len(),
                sent.get(at),
                seen.get(at)
            );
        }
        // What the user reads. Node's text is the same with the first failure's cause dropped, so the cause is no part of it.
        let text = mixdog_ai::service::error_text::present_error_text(
            &mixdog_ai::service::error_text::ErrorView::from(&*error),
            &mixdog_ai::service::error_text::PresentOptions::default(),
        );
        assert_eq!(case["result"]["presented"], case["result"]["presentedWithoutCause"], "{id}: the cause changes nothing the user reads");
        assert_eq!(text, case["result"]["presented"].as_str().unwrap(), "{id}: the text the user reads");
        replayed += 1;
    }
    assert_eq!(replayed, 11, "every recorded outage");
}

#[tokio::test]
async fn a_deterministic_refusal_surfaces_without_a_wait() {
    let h = Harness::new(vec![Attempt::Reject(ProviderError::new(
        ErrorKind::Auth,
        DeliveryState::Accepted,
    ))]);
    let failure = h
        .run(config(), vec![], vec![AgentMessage::user("go")])
        .run()
        .await
        .expect_err("auth surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert!(h.waiter.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn parsed_tool_calls_survive_a_cut_stream() {
    let cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    let h = Harness::new(vec![
        turn(vec![text("x"), call("c1", "echo", json!({})), Step::Fail(cut)]),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(
        dump(&output.transcript),
        ["user:go", "assistant[echo#c1]:x", "tool#c1(Normal):echo:{}"]
    );
    assert!(h.waiter.0.lock().unwrap().is_empty(), "continued, not replayed");
}

/// A cut WebSocket stream keeps the replay envelope of the items it had finished (`partialProviderReplay`), and the
/// recovered assistant turn carries it, so the next request replays it. The turn is compared with what Node's
/// `sendWithRecovery` returned for the same cut (`golden/stream_progress.json`, "a cutoff after finished items",
/// `recovered`): its text, its call ids and its replay items.
#[tokio::test]
async fn a_cut_stream_s_partial_replay_is_kept_on_the_recovered_message() {
    let golden: JsonValue =
        serde_json::from_str(&std::fs::read_to_string(golden_dir().join("compact/golden/stream_progress.json")).unwrap()).unwrap();
    let node = golden["decoders"]["responses"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|s| s.get("recovered"))
        .expect("a recorded recovery");
    assert_eq!(node["action"], "proceed");
    let content = node["content"].as_str().unwrap();
    let node_calls: Vec<&str> = node["toolCalls"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
    let mut cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    cut.partial_replay = Some(Box::new(mixdog_core_api::domain::provider::ProviderReplay {
        owner: ProviderId::from("scripted"),
        items: node["providerReplay"]["items"].clone(),
    }));
    let h = Harness::new(vec![
        turn(vec![text(content), call(node_calls[0], "echo", json!({})), Step::Fail(cut)]),
        turn(vec![text("fin"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let recovered = output.transcript.iter().find(|m| m.text() == content).expect("the recovered assistant message");
    let calls: Vec<&str> = recovered.tool_calls().iter().map(|c| c.id.as_str()).collect();
    assert_eq!(calls, node_calls);
    let kept: Vec<&JsonValue> = recovered.message.provider_replay().iter().map(|r| &r.items).collect();
    assert_eq!(kept, [&node["providerReplay"]["items"]]);
}
#[tokio::test]
async fn turn_limits_answer_extra_calls_unrun_and_forbid_tools_after_the_notice() {
    let h = Harness::new(vec![
        turn(vec![
            call("c1", "echo", json!({"n": 1})),
            call("c2", "echo", json!({"n": 2})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("wrap"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.limits = Some(TurnLimits {
        max_tool_calls: Some(1),
        ..TurnLimits::default()
    });
    let output = finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let dumped = dump(&output.transcript);
    assert_eq!(dumped[2], "tool#c1(Normal):echo:{\"n\":1}");
    assert_eq!(
        dumped[3],
        "tool#c2(Error):[turn-limit] This turn has reached its tool-call or time limit; this call was not run. Reply now without tools."
    );
    assert!(dumped[4].starts_with("user<TurnLimit>:[mixdog-runtime] This turn has reached"));
    let requests = h.provider.requests();
    assert_eq!(requests[0].options.tool_choice, None);
    assert_eq!(requests[1].options.tool_choice.as_deref(), Some("none"));
}

#[tokio::test]
async fn identical_read_only_calls_in_one_turn_run_once() {
    let h = Harness::new(vec![
        turn(vec![
            call("c1", "echo", json!({"p": "x"})),
            call("c2", "echo", json!({"p": "x"})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("k"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let dumped = dump(&output.transcript);
    assert_eq!(dumped[2], "tool#c1(Normal):echo:{\"p\":\"x\"}");
    assert!(dumped[3].starts_with("tool#c2(Skipped):[intra-turn-dedup] identical read-only `echo` call"));
    assert!(dumped[3].contains("tool_use_id=c1"));
}

/// Counts the new read epochs the loop announces to the tool-result cache (`resetReadStateAfterCompaction`).
#[derive(Default)]
struct Epochs(std::sync::atomic::AtomicUsize);
#[async_trait]
impl ResultReuse for Epochs {
    async fn lookup(&self, _call: &ToolCall, _touch: bool) -> Option<Reused> {
        None
    }
    async fn store(&self, _call: &ToolCall, _content: &str, _tool_use_id: &str, _output: &ToolOutput) {}
    async fn after_call(&self, _call: &ToolCall, _failed: bool) {}
    fn after_compaction(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tokio::test]
async fn a_compaction_that_replaces_the_transcript_starts_a_new_read_epoch_and_one_that_does_not_keeps_it() {
    for (skip, epochs) in [(false, 1), (true, 0)] {
        let reuse = Arc::new(Epochs::default());
        let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        h.compactor = Some(Arc::new(Compactor100 { skip, ..Default::default() }));
        h.reuse = Some(reuse.clone());
        let mut cfg = config();
        cfg.compact = Some(compact_settings());
        let mut messages: Vec<AgentMessage> = (0..10).map(|i| AgentMessage::user(format!("m{i}"))).collect();
        messages.push(AgentMessage::user("latest"));
        finish(h.run(cfg, vec![], messages)).await;
        assert_eq!(reuse.0.load(std::sync::atomic::Ordering::SeqCst), epochs, "skip = {skip}");
    }
}

#[tokio::test]
async fn compaction_runs_at_the_request_boundary_and_resets_the_epoch() {
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 {
        requests: Mutex::new(Vec::new()),
        ..Default::default()
    }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings {
        auto: true,
        context_window: Some(1_000),
        token_calibration: 1.0,
        ..CompactSettings::default()
    });
    // 11 messages × 100 estimated tokens + 0 reserve ≥ the 1,000-token trigger
    let mut messages: Vec<AgentMessage> = (0..10).map(|i| AgentMessage::user(format!("m{i}"))).collect();
    messages.push(AgentMessage::user("latest"));
    let output = finish(h.run(cfg, vec![], messages)).await;
    let compactor = h.compactor.as_ref().unwrap();
    assert_eq!(*compactor.requests.lock().unwrap(), [(11, CompactTrigger::Auto)]);
    assert_eq!(wire_dump(&h.provider.requests()[0]), ["User:[summary]", "User:latest"]);
    assert_eq!(output.iterations, 1);
    // The sink is told what the pass took out, as the compactor reported it (10 of 11 left).
    let replaced = h.sink.replaced.lock().unwrap();
    assert_eq!(replaced.len(), 1);
    assert_eq!(
        replaced[0].1,
        Rewrite { dropped_count: 10, dropped: Some(Dropped { message_ids: vec!["gone".into()], call_ids: vec!["call-gone".into()] }) }
    );
    drop(replaced);
    let compact_events: Vec<_> = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Compact(c) => Some((c.status.changed(), c.before_messages, c.after_messages)),
            _ => None,
        })
        .collect();
    assert_eq!(compact_events, [(true, 11, 2)]);
}

fn compact_settings() -> CompactSettings {
    CompactSettings { auto: true, context_window: Some(1_000), token_calibration: 1.0, ..CompactSettings::default() }
}

fn eleven_messages() -> Vec<AgentMessage> {
    let mut messages: Vec<AgentMessage> = (0..10).map(|i| AgentMessage::user(format!("m{i}"))).collect();
    messages.push(AgentMessage::user("latest"));
    messages
}

fn compact_marker(h: &Harness) -> Vec<CompactEvent> {
    h.observer.events().into_iter().filter_map(|e| if let RunEvent::Compact(c) = e { Some(c) } else { None }).collect()
}

#[tokio::test]
async fn the_compact_marker_carries_the_passes_duration_after_tokens_and_status() {
    // Compacted: the pass's own duration, and the estimate of the new transcript (2 × 100).
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { takes: Some((h.clock.clone(), 1_200)), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    finish(h.run(cfg, vec![], eleven_messages())).await;
    let events = compact_marker(&h);
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].status, events[0].duration_ms), (CompactStatus::Compacted, 1_200));
    assert_eq!(events[0].after_tokens, 200);

    // Failed: the pressure the pass started from stands for the after count.
    let mut h = Harness::new(vec![]);
    h.compactor = Some(Arc::new(Compactor100 { fail: true, takes: Some((h.clock.clone(), 300)), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    assert!(h.run(cfg, vec![], eleven_messages()).run().await.is_err());
    let events = compact_marker(&h);
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].status, events[0].duration_ms), (CompactStatus::Failed, 300));
    assert_eq!(events[0].after_tokens, events[0].pressure_tokens);

    // Skipped (no token reduction): nothing is adopted and, as in Node, no marker is shown.
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { skip: true, ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    finish(h.run(cfg, vec![], eleven_messages())).await;
    assert!(compact_marker(&h).is_empty());
    assert!(h.sink.replaced.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_marker_before_count_is_the_providers_last_measured_context_not_the_passes_pressure() {
    // The session's last measured context differs from the pass's own pressure (11 × 100).
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100::default()));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { last_context_tokens: Some(777), ..compact_settings() });
    finish(h.run(cfg, vec![], eleven_messages())).await;
    let events = compact_marker(&h);
    assert_eq!((events[0].before_tokens, events[0].pressure_tokens), (777, 1_100));

    // No reading: the pass's pressure stands in.
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100::default()));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    finish(h.run(cfg, vec![], eleven_messages())).await;
    assert_eq!(compact_marker(&h)[0].before_tokens, 1_100);
}

#[tokio::test]
async fn a_calls_usage_event_carries_what_nodes_usage_delta_needs() {
    let reported = mixdog_core_api::domain::provider::Usage { input_tokens: 120, output_tokens: 30, raw: Some(json!({ "output_tokens_details": { "reasoning_tokens": 9 } })), ..Default::default() };
    let h = Harness::new(vec![
        turn(vec![Step::Event(StreamEvent::Usage(reported)), call("c1", "echo", json!({})), call("c2", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![Step::Event(StreamEvent::Usage(mixdog_core_api::domain::provider::Usage { input_tokens: 5, ..Default::default() })), text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let deltas: Vec<UsageDelta> = h.observer.events().into_iter().filter_map(|e| if let RunEvent::Usage { delta, .. } = e { Some(delta) } else { None }).collect();
    assert_eq!(deltas.len(), 2);
    assert_eq!((deltas[0].delta_tool_calls, deltas[0].delta_prompt), (2, 120));
    assert_eq!(deltas[0].requested_model, deltas[0].model);
    // The raw provider usage names the reasoning tokens; a reply that names none reports none.
    assert_eq!((deltas[0].reasoning_tokens, deltas[0].reasoning_tokens_complete), (Some(9), true));
    assert_eq!((deltas[1].reasoning_tokens, deltas[1].reasoning_tokens_complete), (None, false));
    assert_eq!(deltas[1].delta_tool_calls, 0);
    let sent: Vec<&str> = deltas[0].send_tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(sent, ["echo"]);
}

#[tokio::test]
async fn a_usage_event_reports_the_ledgers_time_and_each_reasoning_figure_as_nodes_does() {
    let usage = |reasoning, raw| mixdog_core_api::domain::provider::Usage { input_tokens: 10, reasoning_tokens: reasoning, raw, ..Default::default() };
    let timed = |ms| Step::Event(StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: Some(ms) });
    let h = Harness::new(vec![
        // A reported zero stays 0 and wins over the raw usage; the ledger's time is used.
        turn(vec![Step::Event(StreamEvent::Usage(usage(Some(0), Some(json!({ "thinking_tokens": 7 }))))), call("c1", "echo", json!({})), timed(750)]),
        // A missing figure falls back to the raw usage; an untimed send falls back to the loop's clock.
        turn(vec![Step::Event(StreamEvent::Usage(usage(None, Some(json!({ "thoughtsTokenCount": 4 }))))), call("c2", "echo", json!({})), done(StopReason::ToolUse)]),
        // A reported figure is a count even when 0, so none and a raw zero differ from missing.
        turn(vec![Step::Event(StreamEvent::Usage(usage(None, Some(json!({ "thinking_tokens": 0 }))))), text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let deltas: Vec<UsageDelta> = h.observer.events().into_iter().filter_map(|e| if let RunEvent::Usage { delta, .. } = e { Some(delta) } else { None }).collect();
    assert_eq!(deltas.len(), 3);
    assert_eq!((deltas[0].reasoning_tokens, deltas[0].reasoning_tokens_complete, deltas[0].request_ms), (Some(0), true, 750));
    assert_eq!((deltas[1].reasoning_tokens, deltas[1].reasoning_tokens_complete, deltas[1].request_ms), (Some(4), true, 0));
    assert_eq!((deltas[2].reasoning_tokens, deltas[2].reasoning_tokens_complete), (Some(0), true));
}

#[tokio::test]
async fn a_context_overflow_compacts_reactively_and_replays_once() {
    let mut h = Harness::new(vec![
        Attempt::Reject(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::Accepted)),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.compactor = Some(Arc::new(Compactor100 {
        requests: Mutex::new(Vec::new()),
        ..Default::default()
    }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings {
        auto: true,
        context_window: Some(100_000),
        token_calibration: 1.0,
        ..CompactSettings::default()
    });
    let messages = vec![
        AgentMessage::user("a"),
        AgentMessage::assistant("b", Vec::new()),
        AgentMessage::user("c"),
    ];
    let output = finish(h.run(cfg, vec![], messages)).await;
    assert_eq!(output.response.content, "ok");
    let compactor = h.compactor.as_ref().unwrap();
    assert_eq!(*compactor.requests.lock().unwrap(), [(3, CompactTrigger::Reactive)]);
    assert_eq!(wire_dump(&h.provider.requests()[1]), ["User:[summary]", "User:c"]);
}

#[tokio::test]
async fn a_second_overflow_surfaces_with_the_overflow_text() {
    let overflow = || Attempt::Reject(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::Accepted));
    let mut h = Harness::new(vec![overflow(), overflow()]);
    h.compactor = Some(Arc::new(Compactor100 {
        requests: Mutex::new(Vec::new()),
        ..Default::default()
    }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings {
        auto: true,
        context_window: Some(100_000),
        token_calibration: 1.0,
        ..CompactSettings::default()
    });
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b"), AgentMessage::user("c")];
    let failure = h.run(cfg, vec![], messages).run().await.expect_err("overflow");
    assert!(
        failure
            .error
            .to_string()
            .starts_with("agent context overflow (scripted/m, stage=send): latest turn cannot fit target context budget=100000")
    );
}

#[tokio::test]
async fn a_boundary_without_a_window_leaves_the_overflow_budget_and_window_unknown() {
    // Node: `{provider, compactBoundaryTokens: 10000}` has no `sessionRef.contextWindow`, so the
    // send-stage overflow carries `budgetTokens: sessionRef.contextWindow` as null.
    let overflow = || Attempt::Reject(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::Accepted));
    let mut h = Harness::new(vec![overflow(), overflow()]);
    h.compactor = Some(Arc::new(Compactor100 { requests: Mutex::new(Vec::new()), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings {
        auto: true,
        explicit_boundary: Some(10_000),
        token_calibration: 1.0,
        ..CompactSettings::default()
    });
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b"), AgentMessage::user("c")];
    let failure = h.run(cfg, vec![], messages).run().await.expect_err("overflow");
    let text = failure.error.to_string();
    assert!(text.contains("stage=send"), "{text}");
    assert!(text.contains("budget=unknown"), "{text}");
    assert!(text.contains("contextWindow=unknown"), "{text}");
}

#[tokio::test]
async fn abort_while_the_provider_is_silent_returns_at_once() {
    let h = Harness::new(vec![turn(vec![text("par"), Step::Hang])]);
    let run = h.run(config(), vec![], vec![AgentMessage::user("go")]);
    let cancel = h.cancel.clone();
    let task = tokio::spawn(run.run());
    // wait until the partial text was relayed, then cancel
    while !h
        .observer
        .events()
        .iter()
        .any(|e| matches!(e, RunEvent::TextDelta(_)))
    {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    let failure = task.await.unwrap().expect_err("aborted");
    assert!(matches!(failure.error, AgentError::Aborted));
    assert_eq!(dump(&failure.transcript), ["user:go"]);
}

#[tokio::test]
async fn abort_does_not_wait_for_stalled_storage() {
    // First model call: waits for the user entry's ack, selecting on the token.
    let h = Harness::new(vec![]);
    h.sink.stalled.store(true, Ordering::Relaxed);
    let mut cfg = config();
    cfg.first_request_after = Some(Ticket(1));
    let task = tokio::spawn(h.run(cfg, vec![], vec![AgentMessage::user("go")]).run());
    tokio::task::yield_now().await;
    let started = std::time::Instant::now();
    h.cancel.cancel();
    let failure = task.await.unwrap().expect_err("aborted");
    assert!(started.elapsed() < Duration::from_millis(50), "abort bound (RL G3)");
    assert!(matches!(failure.error, AgentError::Aborted));
    assert!(h.provider.requests().is_empty(), "no request before the ack");

    // The assistant item that carries tool calls: tools start only after its ack.
    let h = Harness::new(vec![turn(vec![
        call("c1", "echo", json!({})),
        done(StopReason::ToolUse),
    ])]);
    h.sink.stalled.store(true, Ordering::Relaxed);
    let task = tokio::spawn(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run());
    while h.sink.committed.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    let started = std::time::Instant::now();
    h.cancel.cancel();
    let failure = task.await.unwrap().expect_err("aborted");
    assert!(started.elapsed() < Duration::from_millis(50), "abort bound (RL G3)");
    assert_eq!(dump(&failure.transcript), ["user:go", "assistant[echo#c1]:"]);
}

/// A sink that logs, in order, each commit and each durability wait with how many requests had been sent then.
struct OrderedSink {
    provider: Arc<Scripted>,
    tickets: AtomicU64,
    log: Mutex<Vec<(&'static str, u64, usize)>>,
}
#[async_trait]
impl TranscriptSink for OrderedSink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, mixdog_agent::env::CommitError> {
        let n = self.tickets.fetch_add(1, Ordering::SeqCst) + 1;
        let what = if message.tool_call_id().is_some() { "commit tool result" } else { "commit" };
        self.log.lock().unwrap().push((what, n, self.provider.requests().len()));
        Ok(Ticket(n))
    }
    fn replace(&self, _: &[AgentMessage], _: &Rewrite) {}
    fn message_id(&self) -> String {
        format!("m{}", self.tickets.load(Ordering::SeqCst) + 1)
    }
    async fn durable(&self, ticket: Ticket) {
        self.log.lock().unwrap().push(("durable", ticket.0, self.provider.requests().len()));
    }
    async fn drafted(&self) {
        self.log.lock().unwrap().push(("drafted", 0, self.provider.requests().len()));
    }
}

/// Each request leaves only after the sink stored what the run drafted, the mark of that send among it: a process killed
/// with the request on the wire then recovers knowing it was sent (the tool result it ended with keeps `sentRequestTail`),
/// where a request that left first is recovered as a turn still in its tool run. Fails without the wait in
/// `Run::send_attempts` (`send.rs`).
#[tokio::test]
async fn each_request_leaves_after_the_mark_of_its_send_is_stored() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let sink = Arc::new(OrderedSink { provider: h.provider.clone(), tickets: AtomicU64::new(0), log: Mutex::new(Vec::new()) });
    let mut env = h.run_env();
    env.sink = sink.clone();
    let run = Run::new(env, h.cancel.clone(), h.provider.clone(), ToolSet::with_builtins(vec![Echo::tool()], vec!["echo".into()]), h.tool_env(), config(), vec![AgentMessage::user("go")], RunCarry::default());
    finish(run).await;
    assert_eq!(h.provider.requests().len(), 2);
    let log = sink.log.lock().unwrap().clone();
    let waited: Vec<usize> = log.iter().filter(|(what, ..)| *what == "drafted").map(|&(_, _, sent)| sent).collect();
    assert_eq!(waited, [0, 1], "one wait before each request, with only the earlier requests sent: {log:?}");
}

/// The request after a tool batch leaves only once the tool result it carries is durable: Node appends each turn row
/// synchronously (`appendFileSync`, `turn-checkpoint-journal.mjs:503`) before its next request, so a process killed with
/// that request on the wire restarts holding the result; a core that sent first would restart without it and resume with
/// a cancelled call instead. Fails without `Run::drive`'s wait on the last pushed ticket (`run.rs`).
#[tokio::test]
async fn the_request_after_a_tool_batch_waits_until_its_tool_result_is_durable() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let sink = Arc::new(OrderedSink { provider: h.provider.clone(), tickets: AtomicU64::new(0), log: Mutex::new(Vec::new()) });
    let mut env = h.run_env();
    env.sink = sink.clone();
    let run = Run::new(env, h.cancel.clone(), h.provider.clone(), ToolSet::with_builtins(vec![Echo::tool()], vec!["echo".into()]), h.tool_env(), config(), vec![AgentMessage::user("go")], RunCarry::default());
    finish(run).await;
    assert_eq!(h.provider.requests().len(), 2);
    let log = sink.log.lock().unwrap().clone();
    let &(_, result, sent) = log.iter().find(|(what, ..)| *what == "commit tool result").expect("the tool result is committed");
    assert_eq!(sent, 1, "the tool result is committed after the first request: {log:?}");
    assert!(
        log.iter().any(|&(what, ticket, sent)| what == "durable" && ticket >= result && sent == 1),
        "the second request left before the tool result it carries was durable: {log:?}"
    );
}

/// A gate that never answers for the streamed call no listed call consumed.
struct HangingGate {
    entered: std::sync::atomic::AtomicBool,
    released: Arc<std::sync::atomic::AtomicBool>,
}
struct SetOnDrop(Arc<std::sync::atomic::AtomicBool>);
impl Drop for SetOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
#[async_trait]
impl ToolGate for HangingGate {
    async fn check_call(&self, _call_id: &str, call: &GateCall) -> GateDecision {
        if call.args.get("orphan") != Some(&json!(true)) {
            return GateDecision::Allow;
        }
        let _held = SetOnDrop(self.released.clone());
        self.entered.store(true, Ordering::SeqCst);
        std::future::pending().await
    }
}

/// An eager run the batch left to finish (the provider returned another call in its place) is detached, so its
/// preparation must end with the turn's cancellation: a gate that never answers cannot hold the run's environment.
#[tokio::test(start_paused = true)]
async fn a_detached_eager_run_ends_with_the_turns_cancellation() {
    let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let gate = Arc::new(HangingGate { entered: std::sync::atomic::AtomicBool::new(false), released: released.clone() });
    let mut h = Harness::new(vec![
        turn(vec![
            call("orph", "echo", json!({"orphan": true})),
            Step::Event(StreamEvent::ReturnedCalls(vec![ToolCall { id: "c2".into(), name: "echo".into(), arguments: json!({}), native_type: None }])),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("done"), done(StopReason::EndTurn)]),
    ]);
    h.gate = gate.clone();
    // The run finishes normally with the orphan still held in the gate.
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "done");
    assert_eq!(dump(&output.transcript), ["user:go", "assistant[echo#c2]:", "tool#c2(Normal):echo:{}"]);
    assert!(gate.entered.load(Ordering::SeqCst), "the orphan reached the gate");
    assert!(!released.load(Ordering::SeqCst), "not cancelled: it is left to finish, as in Node");
    h.cancel.cancel();
    while !released.load(Ordering::SeqCst) {
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
    }
}

/// A commit the store refuses fails the run with its typed error; nothing is added to the context.
#[tokio::test]
async fn a_refused_commit_fails_the_run_with_the_commit_error() {
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)])]);
    h.sink.refused.store(true, Ordering::Relaxed);
    let failure = h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run().await.expect_err("the commit was refused");
    assert!(matches!(failure.error, AgentError::Commit(mixdog_agent::env::CommitError::StoreUnavailable)), "{:?}", failure.error);
    assert_eq!(dump(&failure.transcript), ["user:go"]);
    assert!(h.sink.committed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn abort_during_a_tool_cancels_its_token_and_keeps_finished_results() {
    let h = Harness::new(vec![turn(vec![
        call("c1", "echo", json!({})),
        call("c2", "hang", json!({})),
        done(StopReason::ToolUse),
    ])]);
    let run = h.run(config(), vec![Echo::tool(), Hang::tool()], vec![AgentMessage::user("go")]);
    let cancel = h.cancel.clone();
    let sink = h.sink.clone();
    let task = tokio::spawn(run.run());
    // the assistant turn is committed, then the echo result once it finished
    while sink.committed.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    tokio::task::yield_now().await;
    cancel.cancel();
    let failure = task.await.unwrap().expect_err("aborted");
    assert!(matches!(failure.error, AgentError::Aborted));
    let dumped = dump(&failure.transcript);
    assert_eq!(dumped[1], "assistant[echo#c1,hang#c2]:");
    // c2 never answered: the interruption closes it as Cancelled
    let closed = mixdog_agent::interrupt::finalize_interrupted_turn(mixdog_agent::interrupt::Interrupted {
        transcript: failure.transcript,
        current_user_text: "go".into(),
        response_started: true,
        partial_assistant: String::new(),
        partial_reasoning: String::new(),
        observed_tool_calls: Vec::new(),
        observed_tool_results: Vec::new(),
        phase: mixdog_agent::interrupt::Phase::Tools,
        reason: mixdog_agent::interrupt::AbortReason::UserCancel,
    });
    let tail = dump(&closed.transcript);
    assert_eq!(
        &tail[tail.len() - 2..],
        ["tool#c2(Error):Cancelled", "user:[Request interrupted by user for tool use]"]
    );
}

#[tokio::test]
async fn a_denied_approval_answers_the_call_without_running_it() {
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"x": 1})), done(StopReason::ToolUse)]),
        turn(vec![text("understood"), done(StopReason::EndTurn)]),
    ]);
    h.gate = Arc::new(AskFirst);
    h.approvals.script.lock().unwrap().push_back(ApprovalResolution::Decided {
        decision: ToolApprovalDecision {
            approved: false,
            reason: Some("Not now.".into()),
            answers: None,
            reply: None,
            response: None,
            edited_args: None,
            remember: None,
            scope: None,
        },
        device: "desk".into(),
        connection_kind: mixdog_protocol::ConnectionKind::Desktop,
        at: 0,
    });
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(
        dump(&output.transcript)[2],
        "tool#c1(Error):Error: tool \"echo\" was not approved: Not now. Do not retry it or reach the same result another way; report it."
    );
    let waits: Vec<bool> = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::ApprovalWait { waiting }) => Some(waiting),
            _ => None,
        })
        .collect();
    assert_eq!(waits, [true, false]);
    assert_eq!(h.approvals.asks.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn pause_turn_continues_in_the_same_turn() {
    let h = Harness::new(vec![
        turn(vec![text("part"), done(StopReason::Other("pause_turn".into()))]),
        turn(vec![text("rest"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.provider_continuations, 1);
    assert_eq!(dump(&output.transcript), ["user:go", "assistant:part"]);
    assert_eq!(output.response.content, "part\n\nrest");
}

#[tokio::test]
async fn refusal_gets_one_recovery_prompt_then_ends() {
    let refuse = || turn(vec![done(StopReason::Refusal)]);
    let h = Harness::new(vec![refuse(), refuse()]);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.termination, Some(mixdog_agent::response::Termination::Refusal));
    let dumped = dump(&output.transcript);
    assert_eq!(dumped.len(), 2);
    assert!(dumped[1].starts_with("user<RefusalRecovery>:[mixdog-runtime] The previous completion was refused"));
    let _ = (Source::Steering, ToolKind::Normal);
}

// ---------------------------------------------------------------------------
// Golden transcripts recorded from the Node loop (fixtures/agent/record.mjs)
// ---------------------------------------------------------------------------

struct Boom(ToolSpec);
impl Boom {
    fn tool() -> Arc<dyn Tool> {
        Arc::new(Self(ToolSpec {
            name: "boom".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "Always fails.".into(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }))
    }
}
#[async_trait]
impl Tool for Boom {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Err(ToolError::new(ToolErrorCode::Io { os_code: None }, "Error: boom"))
    }
}

fn stop_of(text: &str) -> StopReason {
    match text {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "length" | "max_tokens" | "MAX_TOKENS" => StopReason::MaxTokens,
        "refusal" => StopReason::Refusal,
        other => StopReason::Other(other.to_owned()),
    }
}

fn source_name(source: Source) -> &'static str {
    match source {
        Source::Steering => "steering",
        Source::TaskNotification => "task-notification",
        Source::TurnLimit => "turn-limit",
        Source::MaxOutputRecovery => "max-output-recovery",
        Source::StreamCutRecovery => "stream-cut-recovery",
        Source::RefusalRecovery => "refusal-recovery",
        Source::ContentFilterRecovery => "content-filter-recovery",
        Source::Hook => "hook",
        Source::Skill => "skill",
        Source::Import => "import",
        Source::CompactSummary => "compact-summary",
        Source::CompactContext => "compact-context",
        Source::ActiveTurnContinuation => "compact-active-turn-continuation",
        Source::CompactExecutionRecovery => "compact-execution-recovery",
        Source::CompactExecutionText => "compact-execution-text",
        Source::GoalContinuation => "goal-continuation",
        Source::GoalCloseout => "goal-closeout",
        Source::ScheduleResult => "schedule-result",
        Source::ContextAck => "context-ack",
        Source::CompactSkillWindow => "compact-skill-window",
        Source::CompactSkillReload => "compact-skill-reload",
        Source::CompactSkillRestore => "compact-skill-restore",
        Source::SkillContext => "skill-context",
        Source::SkillSelection => "skill-selection",
        Source::SkillUpdateNotice => "skill-update-notice",
        Source::HeldRequest => "held-request",
        Source::AgentRoom => "agent-room",
    }
}

fn kind_name(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Normal => "normal",
        ToolKind::CacheHit => "cache-hit",
        ToolKind::Error => "error",
        ToolKind::Skipped => "skipped",
    }
}

fn normalized(message: &AgentMessage) -> JsonValue {
    json!({
        "role": format!("{:?}", message.role()).to_lowercase(),
        "content": message.text(),
        "source": message.source.map(source_name),
        "attempt": message.attempt,
        "toolCalls": message.tool_calls().iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect::<Vec<_>>(),
        "toolCallId": message.tool_call_id(),
        "toolKind": message.tool_kind.map(kind_name),
        "turnReminder": message.turn_reminder,
    })
}

fn golden_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent")
}

async fn replay(scenario: &JsonValue) -> (JsonValue, JsonValue, JsonValue, JsonValue) {
    let entries = scenario["script"].as_array().unwrap();
    let copies = if scenario["repeatLast"].as_bool() == Some(true) { 8 } else { 1 };
    let mut script = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let n = if i + 1 == entries.len() { copies } else { 1 };
        for _ in 0..n {
            // A send Node's provider throws as Gemini does for a cut function call: the decoder's transient `malformed_function_call`.
            if entry["throw"] == "malformed_function_call" {
                let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
                error.code = Some("malformed_function_call".into());
                script.push(Attempt::Reject(error));
                continue;
            }
            let mut steps = Vec::new();
            let content = entry["content"].as_str().unwrap_or("");
            // A reply that names its deltas streams them one by one (their join is its content).
            if let Some(deltas) = entry["deltas"].as_array() {
                steps.extend(deltas.iter().map(|d| text(d.as_str().unwrap())));
            } else if !content.is_empty() {
                steps.push(text(content));
            }
            for c in entry["toolCalls"].as_array().into_iter().flatten() {
                steps.push(call(c["id"].as_str().unwrap(), c["name"].as_str().unwrap(), c["arguments"].clone()));
            }
            steps.push(done(stop_of(entry["stopReason"].as_str().unwrap_or("end_turn"))));
            script.push(turn(steps));
        }
    }
    let h = Harness::new(script);
    for (stage, queue) in scenario["steer"].as_object().into_iter().flatten() {
        let stage = if stage == "terminal" { DrainStage::Terminal } else { DrainStage::PreSend };
        for entry in queue.as_array().unwrap() {
            h.steer.push(stage, entry.as_str().unwrap());
        }
    }
    let mut cfg = config();
    let h = match scenario["model"].as_str() {
        Some(model) => {
            cfg.model = model.to_owned();
            let language = scenario["language"].as_object().map(|l| mixdog_agent::tail_rules::TailLanguage {
                id: l["id"].as_str().unwrap().to_owned(),
                name: l["name"].as_str().unwrap().to_owned(),
            });
            h.with_tail(mixdog_agent::tail_rules::TailContext {
                provider: scenario["provider"].as_str().unwrap().to_owned(),
                language,
                role: mixdog_agent::tail_rules::TailRole::Lead,
            })
        }
        None => h,
    };
    cfg.escalated_max_output_tokens = scenario["escalated"].as_u64().map(|v| v as u32);
    if let Some(limit) = scenario["limits"]["maxToolCalls"].as_u64() {
        cfg.limits = Some(TurnLimits { max_tool_calls: Some(limit), ..TurnLimits::default() });
    }
    let messages: Vec<AgentMessage> = scenario["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| AgentMessage::user(m["content"].as_str().unwrap()))
        .collect();
    let run = h.run_with_builtins(cfg, vec![Echo::tool(), Boom::tool()], vec!["read".into()], messages);
    let output = finish(run).await;
    let transcript: Vec<JsonValue> = output.transcript.iter().map(normalized).collect();
    let termination = output.termination.map(|t| format!("{t:?}").to_lowercase());
    let result = json!({
        "content": output.response.content,
        "historyContent": output.response.history_content,
        "reportContent": output.response.report_content,
        "terminationReason": termination,
        "iterations": output.iterations,
        "toolCallsTotal": output.tool_calls_total,
        "maxOutputRecoveryAttempts": output.response.max_output_recovery_attempts,
        "providerContinuations": output.provider_continuations,
    });
    let requests: Vec<JsonValue> = h
        .provider
        .requests()
        .iter()
        .map(|r| {
            json!({
                "override": r.options.max_output_tokens_override,
                "toolChoice": r.options.tool_choice,
                "messages": r.messages.iter().map(|m| json!({
                    "role": format!("{:?}", m.role).to_lowercase(),
                    "content": match &m.content { Content::Text(t) => t.clone(), Content::Parts(_) => String::new() },
                    "toolCallId": m.tool_call_id,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    // What the turn's text-delta hook was handed, in order (compared when the scenario records it). The run's other events
    // (stage, tool calls, usage, ...) have no Node recording: the recorder installs no hook for them (agent set manifest,
    // exclusions "run events other than the text deltas").
    let deltas: Vec<JsonValue> = h.observer.events().into_iter().filter_map(|e| if let RunEvent::TextDelta(chunk) = e { Some(json!(chunk)) } else { None }).collect();
    (JsonValue::Array(transcript), result, JsonValue::Array(requests), JsonValue::Array(deltas))
}

#[tokio::test]
async fn rust_loop_matches_the_recorded_node_transcripts() {
    let dir = golden_dir();
    let mut names: Vec<String> = std::fs::read_dir(dir.join("scenarios"))
        .expect("scenarios recorded by fixtures/agent/record.mjs")
        .map(|e| e.unwrap().path().file_stem().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert!(!names.is_empty());
    for name in names {
        let scenario: JsonValue =
            serde_json::from_str(&std::fs::read_to_string(dir.join(format!("scenarios/{name}.json"))).unwrap()).unwrap();
        let golden: JsonValue =
            serde_json::from_str(&std::fs::read_to_string(dir.join(format!("golden/{name}.json"))).unwrap()).unwrap();
        let (transcript, result, requests, deltas) = replay(&scenario).await;
        assert_eq!(transcript, golden["messages"], "{name}: transcript");
        assert_eq!(result, golden["result"], "{name}: result");
        assert_eq!(requests, golden["requests"], "{name}: requests");
        if scenario["captureDeltas"] == true {
            assert_eq!(deltas, golden["deltas"], "{name}: text deltas");
        }
    }
}

fn rejection(kind: ErrorKind, code: Option<&str>) -> Attempt {
    let mut error = ProviderError::new(kind, DeliveryState::Accepted);
    error.code = code.map(str::to_owned);
    error.status = Some(400);
    error.message = "bad   request".into();
    Attempt::Reject(error)
}

struct Refs;

#[async_trait]
impl mixdog_agent::attachments::AttachmentText for Refs {
    async fn text_of(&self, part: &mixdog_core_api::domain::provider::ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        use mixdog_core_api::domain::provider::BinarySource;
        use mixdog_core_api::domain::provider::ContentPart;
        Ok(match part {
            ContentPart::File { source: BinarySource::AttachmentRef(r), filename, .. } if r == "text-ref" => {
                Some(format!("<file name=\"{}\">\nbody\n</file>", filename.as_deref().unwrap_or("")))
            }
            _ => None,
        })
    }
}

#[tokio::test]
async fn a_stored_text_reference_reaches_the_request_as_its_text_and_stays_a_reference_in_history() {
    use mixdog_core_api::domain::provider::BinarySource;
    use mixdog_core_api::domain::provider::ContentPart;
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    use mixdog_core_api::domain::provider::TextAttachment;
    let reference = |r: &str, text: Option<TextAttachment>| ContentPart::File {
        source: BinarySource::AttachmentRef(r.into()),
        mime_type: "text/markdown".into(),
        filename: Some("notes.md".into()),
        text,
    };
    let text_ref = reference("text-ref", Some(TextAttachment { kind: Some("file".into()) }));
    let image_ref = reference("image-ref", None);
    let prompt = AgentMessage::user_content(Content::Parts(vec![
        ContentPart::Text("see".into(), None),
        text_ref,
        image_ref.clone(),
    ]));
    let mut cfg = config();
    cfg.attachments = Some(Arc::new(Refs));
    let output = finish(h.run(cfg, vec![], vec![prompt])).await;
    let sent = &h.provider.requests()[0].messages[0].content;
    assert_eq!(
        sent,
        &Content::Parts(vec![
            ContentPart::Text("see".into(), None),
            ContentPart::Text("<file name=\"notes.md\">\nbody\n</file>".into(), None),
            image_ref,
        ])
    );
    assert!(matches!(&output.transcript[0].message.content, Content::Parts(p) if matches!(p[1], ContentPart::File { .. })));
}

#[tokio::test]
async fn a_rejected_image_is_stripped_from_the_latest_turn_and_replayed_once() {
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::ImageSource;
    let h = Harness::new(vec![
        rejection(ErrorKind::ImageRejected, None),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let prompt = AgentMessage::user_content(Content::Parts(vec![
        ContentPart::Text("look".into(), None),
        ContentPart::Image(ImageSource::Url("u".into())),
    ]));
    let output = finish(h.run(config(), vec![], vec![prompt])).await;
    assert_eq!(output.response.content, "ok");
    let requests = h.provider.requests();
    assert!(matches!(&requests[0].messages[0].content, Content::Parts(p) if p.len() == 2 && matches!(p[1], ContentPart::Image(_))));
    assert_eq!(
        requests[1].messages[0].content,
        Content::Parts(vec![
            ContentPart::Text("look".into(), None),
            ContentPart::Text(mixdog_agent::recovery_placeholder().into(), None),
        ])
    );
    // the stored transcript keeps the image
    assert!(matches!(&output.transcript[0].message.content, Content::Parts(p) if matches!(p[1], ContentPart::Image(_))));
}

/// Node's agent loop (`sendWithRecovery` → `retryWithImageStrip`, `settleImageStrip`) over each case of
/// `fixtures/session-gaps/image-strip.json` (`record-session-gaps.mjs`): the run loop is sent what Node's provider was
/// sent at every attempt, ends as Node's did, leaves the transcript Node left (a healed image is gone from it, a
/// request-local strip is not), and the text-only next turn over that transcript is sent what Node's was.
#[tokio::test]
async fn a_rejected_image_is_recovered_as_nodes_agent_loop_recovers_it() {
    use mixdog_core_api::domain::provider::BinarySource;
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::Role;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-gaps/image-strip.json");
    let recorded: JsonValue = serde_json::from_slice(&std::fs::read(path).expect("the recording")).expect("json");
    let content_of = |value: &JsonValue| match value {
        JsonValue::String(text) => Content::Text(text.clone()),
        JsonValue::Array(parts) => Content::Parts(
            parts
                .iter()
                .map(|p| match p["type"].as_str() {
                    Some("text") => ContentPart::Text(p["text"].as_str().expect("text").into(), None),
                    Some("image") => ContentPart::File {
                        source: BinarySource::AttachmentRef(p["attachmentRef"].as_str().expect("ref").into()),
                        mime_type: p["mimeType"].as_str().expect("mimeType").into(),
                        filename: p["filename"].as_str().map(str::to_owned),
                        text: None,
                    },
                    other => panic!("part {other:?}"),
                })
                .collect(),
        ),
        other => panic!("content {other}"),
    };
    let message_of = |row: &JsonValue| match row["role"].as_str().expect("role") {
        "user" => AgentMessage::user_content(content_of(&row["content"])),
        "assistant" => {
            let calls = row["toolCalls"]
                .as_array()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|c| ToolCall {
                            id: c["id"].as_str().expect("id").into(),
                            name: c["name"].as_str().expect("name").into(),
                            arguments: c["arguments"].clone(),
                            native_type: None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            AgentMessage::assistant(row["content"].as_str().expect("text"), calls)
        }
        "tool" => AgentMessage::tool_result(row["toolCallId"].as_str().expect("id"), content_of(&row["content"]), ToolKind::Normal),
        other => panic!("role {other}"),
    };
    let content_row = |content: &Content| match content {
        Content::Text(text) => json!(text),
        Content::Parts(parts) => JsonValue::Array(
            parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text(text, _) => json!({ "type": "text", "text": text }),
                    ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, filename, .. } => {
                        let mut row = json!({ "type": "image", "attachmentRef": r, "mimeType": mime_type });
                        if let Some(name) = filename {
                            row["filename"] = json!(name);
                        }
                        row
                    }
                    other => panic!("part {other:?}"),
                })
                .collect(),
        ),
    };
    let sent_row = |m: &Message| {
        let mut row = json!({ "role": format!("{:?}", m.role).to_lowercase(), "content": content_row(&m.content) });
        if !m.tool_calls.is_empty() {
            row["toolCalls"] =
                m.tool_calls.iter().map(|c| json!({ "id": c.id, "name": c.name, "arguments": c.arguments })).collect();
        }
        if let Some(id) = &m.tool_call_id {
            row["toolCallId"] = json!(id);
        }
        row
    };
    let sent = |h: &Harness| -> Vec<JsonValue> {
        h.provider.requests().iter().map(|r| r.messages.iter().map(sent_row).collect()).collect()
    };
    // A recorded value whole (`lib/exact.mjs`): plain JSON, an object's keys compared as a set.
    let whole = |v: &JsonValue| mixdog_testkit::exact::Exact::decode(v).and_then(|e| e.to_plain()).expect("a plain recorded value");
    // The error the turn ended with as Node's loop throws it (the provider's own error): name, message, status, code,
    // and its `streamOutcome` (`providers/lib/stream-outcome.mjs`), every field of it built from the core's error:
    // the stream's `Exposure` (its three facts), the transport fault that ended it and the fact that an error is no
    // terminal event, put through Node's own derivations (`_signalsOf`, `deriveStreamOutcome`: `continuation`,
    // `visibleOutput`, `observedOutput`, `sideEffectDispatched`, `replayUnsafe`, `replaySafe`, `successEligible`).
    // The core keeps no provider name and no transport label on an error: `provider` is null and `transport` is
    // 'unknown' as for an error that carries neither. The counts are what the core's stream delivered before it failed
    // (`seen`: the characters of its text deltas as JS counts them, and the tool calls it completed), a call counting
    // as dispatched when the error's exposure says one was.
    let seen: std::cell::RefCell<(String, u64)> = std::cell::RefCell::new((String::new(), 0));
    let stream_outcome = |e: &ProviderError| {
        let truncated = e.transport == Some(TransportFault::TruncatedStream);
        let stalled = matches!(e.transport, Some(TransportFault::KeepaliveExpired { .. }));
        let (text, dispatched, pending) = (e.exposure.text_emitted, e.exposure.tool_dispatched, e.exposure.tool_input_cut);
        let (reasoning, ambiguous, aborted, terminal) = (false, false, false, false);
        let (chars, calls) = (seen.borrow().0.encode_utf16().count() as u64, seen.borrow().1);
        let started = text || dispatched || chars > 0 || calls > 0;
        let continuation = !terminal && (truncated || stalled || started);
        let visible = text || reasoning;
        let observed = visible || chars > 0 || calls > 0 || dispatched;
        let unsafe_replay = visible || dispatched || ambiguous;
        json!({
            "version": 1, "provider": null, "transport": "unknown",
            "terminalObserved": terminal, "continuation": continuation, "declaredContinuation": false,
            "textEmitted": text, "textObservedChars": chars, "reasoningEmitted": reasoning,
            "toolCallsStarted": dispatched || calls > 0, "toolCallsComplete": calls, "toolCallsDispatched": if dispatched { calls } else { 0 },
            "dispatchAmbiguous": ambiguous, "pendingToolInput": pending, "userAbort": aborted,
            "stallObserved": stalled, "truncatedStream": truncated,
            "visibleOutput": visible, "observedOutput": observed, "sideEffectDispatched": dispatched,
            "replayUnsafe": unsafe_replay, "replaySafe": !unsafe_replay && !aborted,
            "successEligible": terminal && !continuation && !pending,
        })
    };
    let error_row = |error: &mixdog_agent::AgentError| match error {
        mixdog_agent::AgentError::Provider(e) => {
            let mut props = json!({ "httpStatus": e.status });
            if let Some(code) = &e.code {
                props["code"] = json!(code);
            }
            let outcome = stream_outcome(e);
            // What the provider's stream tracker put on the error (`partialContent`, `partialToolCalls`,
            // `toolCallsDispatched`: the stream's text and completed calls) and what `stampStreamOutcome` then marks on it.
            let (partial, calls) = seen.borrow().clone();
            if !partial.is_empty() {
                props["partialContent"] = json!(partial);
            }
            if calls > 0 {
                props["partialToolCalls"] = (1..=calls).map(|i| json!({ "id": format!("call_{i}"), "name": "read" })).collect();
                props["toolCallsDispatched"] = outcome["toolCallsDispatched"].clone();
            }
            let marks = [("textEmitted", &["liveTextEmitted", "emittedText"][..]), ("toolCallsStarted", &["partialToolCall"]), ("sideEffectDispatched", &["emittedToolCall", "toolCallEmitted"]), ("replayUnsafe", &["unsafeToRetry"])];
            for (fact, keys) in marks {
                if outcome[fact] == json!(true) {
                    for key in keys {
                        props[*key] = json!(true);
                    }
                }
            }
            props["streamOutcome"] = outcome;
            json!({ "name": "Error", "message": e.message, "props": props })
        }
        other => panic!("{other:?}"),
    };
    let node_error = |v: &JsonValue| {
        let mut props = v["props"].clone();
        if let Some(code) = v.get("code") {
            props["code"] = code.clone();
        }
        json!({ "name": v["name"], "message": v["message"], "props": props })
    };
    let attempt_of = |step: &JsonValue| match (&step["error"], &step["reply"]) {
        (JsonValue::Object(e), _) => {
            let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
            error.status = e.get("status").and_then(JsonValue::as_u64).map(|s| s as u16);
            error.code = e.get("code").and_then(JsonValue::as_str).map(str::to_owned);
            // The image a preparation refusal names (Node's non-enumerable `failingImageData`).
            // The provider's preparation decoded and hashed it where it refused it.
            error.failing_image = e.get("failingImageData").and_then(JsonValue::as_str).map(|data| {
                use base64::Engine as _;
                use sha2::Digest as _;
                let sha256 = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .ok()
                    .map(|bytes| sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>().into());
                Box::new(mixdog_core_api::domain::provider::FailingImage { data: data.into(), sha256 })
            });
            error.message = e["message"].as_str().expect("message").into();
            match step.get("partial") {
                // The stream gives its text and completes its calls, then fails.
                Some(partial) => {
                    let mut steps = vec![text(partial["text"].as_str().expect("text"))];
                    steps.extend((1..=partial["calls"].as_u64().expect("calls")).map(|i| call(&format!("call_{i}"), "read", json!({}))));
                    // The stream's exposure: what it had shown and handed over when it failed.
                    error.exposure.text_emitted = true;
                    error.exposure.tool_dispatched = true;
                    steps.push(Step::Fail(error));
                    Attempt::Stream(steps)
                }
                None => Attempt::Reject(error),
            }
        }
        (_, JsonValue::String(reply)) => turn(vec![text(reply), done(StopReason::EndTurn)]),
        other => panic!("step {other:?}"),
    };
    let cases = recorded["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 11);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let messages: Vec<AgentMessage> = case["messages"].as_array().expect("messages").iter().map(message_of).collect();
        let first = &case["first"];
        let attempts: Vec<Attempt> = case["script"].as_array().expect("script").iter().map(attempt_of).collect();
        let h = Harness::new(attempts);
        let ended = h.run(config(), vec![], messages).run().await;
        // What the core took from the stream before it failed: the text of the deltas it emitted to its observer and the
        // completed calls the stream handed it. The recording's counts (the error's `partialContent`, `partialToolCalls`)
        // are what the error row is compared with.
        let emitted: String = h.observer.events().into_iter().filter_map(|e| if let RunEvent::TextDelta(t) = e { Some(t) } else { None }).collect();
        *seen.borrow_mut() = (emitted, h.provider.calls_handed.load(Ordering::SeqCst));
        let (result, error, mut transcript) = match ended {
            Ok(output) => (Some(output.response.content), JsonValue::Null, output.transcript),
            Err(failure) => (None, error_row(&failure.error), failure.transcript),
        };
        let recorded_sends: Vec<JsonValue> = first["sends"].as_array().expect("sends").iter().map(whole).collect();
        assert_eq!(sent(&h), recorded_sends, "{name}: what the provider was sent");
        assert_eq!(result.as_deref(), first["result"].as_str(), "{name}: how the turn ended");
        let recorded_error = if first["error"].is_null() { JsonValue::Null } else { node_error(&first["error"]) };
        assert_eq!(error, recorded_error, "{name}: the error the turn ended with");
        let kept: Vec<JsonValue> = transcript.iter().map(|m| sent_row(&m.message)).collect();
        assert_eq!(JsonValue::Array(kept), whole(&first["transcript"]), "{name}: the transcript the turn left");

        transcript.push(AgentMessage::user("next turn"));
        let next = Harness::new(vec![turn(vec![text("still usable"), done(StopReason::EndTurn)])]);
        let output = finish(next.run(config(), vec![], transcript)).await;
        assert_eq!(output.response.content, case["next"]["result"].as_str().expect("next result"), "{name}");
        let next_sends: Vec<JsonValue> = case["next"]["sends"].as_array().expect("sends").iter().map(whole).collect();
        assert_eq!(sent(&next), next_sends, "{name}: the next turn's request");
        assert_eq!(case["next"]["error"], JsonValue::Null, "{name}: the next turn ended");
        let next_kept: Vec<JsonValue> = output.transcript.iter().map(|m| sent_row(&m.message)).collect();
        assert_eq!(JsonValue::Array(next_kept), whole(&case["next"]["transcript"]), "{name}: the transcript the next turn left");
    }
}


/// The `traceCacheBreak` records the loop hands its host.
#[derive(Default)]
struct CacheBreaks(Mutex<Vec<serde_json::Map<String, JsonValue>>>);

impl ToolFailureLog for CacheBreaks {
    fn failed(&self, _call: FailedCall) {}

    fn stall_abort(&self, _ctx: serde_json::Map<String, JsonValue>) {
        panic!("the agent loop never records a watchdog stop");
    }

    fn cache_break(&self, record: serde_json::Map<String, JsonValue>) {
        self.0.lock().unwrap().push(record);
    }
}

/// `fixtures/cache-break` (record-cache-break.mjs): Node's loop over a provider that refuses the turn's image once and
/// answers the replay traces one intentional `image_strip_nonpersistent_rebaseline` cache break; the loop's record makes
/// the same trace line and stderr line, after the same requests.
#[tokio::test]
async fn an_image_strip_replay_traces_the_cache_break_node_traces() {
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::ImageSource;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cache-break/golden.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let node = &golden["loop"];
    let mut h = Harness::new(Vec::new());
    h.provider = Arc::new(Scripted {
        id: ProviderId::from(node["provider"].as_str().unwrap()),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(vec![rejection(ErrorKind::ImageRejected, None), turn(vec![text("ok"), done(StopReason::EndTurn)])].into()),
        requests: Mutex::new(Vec::new()),
        settled: Mutex::new(Vec::new()),
        calls_handed: Arc::default(),
        order: None,
        released: Mutex::new(Vec::new()),
        stages: Default::default(),
        raises_requesting: false,
        hold: Mutex::new(None),
    });
    let breaks = Arc::new(CacheBreaks::default());
    h.failures = Some(breaks.clone());
    let config = RunConfig::new(ThreadId::from(node["session"].as_str().unwrap()), TurnId::from("r"), node["model"].as_str().unwrap());
    let system = AgentMessage::new(mixdog_core_api::domain::provider::Message::new(
        mixdog_core_api::domain::provider::Role::System,
        Content::Text("Stable instructions.".into()),
    ));
    let prompt = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("look".into(), None), ContentPart::Image(ImageSource::Url("u".into()))]));
    finish(h.run(config, vec![], vec![system, prompt])).await;

    let images = |request: &ModelRequest| {
        request.messages.iter().map(|m| match &m.content {
            Content::Parts(parts) => parts.iter().filter(|p| matches!(p, ContentPart::Image(_))).count(),
            _ => 0,
        }).sum::<usize>()
    };
    let requests: Vec<JsonValue> = h.provider.requests().iter().map(|r| json!({ "messages": r.messages.len(), "images": images(&**r) })).collect();
    assert_eq!(JsonValue::Array(requests), node["requests"], "the refused send and its replay");
    let records = breaks.0.lock().unwrap().clone();
    let now = golden["now"].as_i64().unwrap();
    let rows: Vec<String> = records
        .iter()
        .map(|record| mixdog_trace::stringify(&JsonValue::Object(mixdog_trace::build_row(&mixdog_trace::cache_break_trace_record(record), now))))
        .collect();
    assert_eq!(json!(rows), node["rows"], "the trace rows");
    let lines: Vec<String> = records.iter().map(mixdog_trace::cache_break_line).collect();
    assert_eq!(json!(lines), node["stderr"], "the stderr lines");
}

fn cache_break_golden() -> JsonValue {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cache-break/golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Each distinct digest named by its order of appearance: the core digests its own wire values, not Node's JSON, so a break
/// is compared by which requests its digests name, not by their bytes.
#[derive(Default)]
struct Digests(Vec<String>);

impl Digests {
    fn label(&mut self, digest: &str) -> String {
        let at = self.0.iter().position(|d| d == digest).unwrap_or_else(|| {
            self.0.push(digest.to_owned());
            self.0.len() - 1
        });
        format!("<digest {at}>")
    }

    /// A trace row with its payload's digests labelled.
    fn row(&mut self, row: &str) -> String {
        let mut row: JsonValue = serde_json::from_str(row).unwrap();
        if let Some(payload) = row.get_mut("payload").and_then(JsonValue::as_object_mut) {
            for key in ["previous_hash", "next_hash", "previous_request_prefix_hash", "next_request_prefix_hash"] {
                if let Some(JsonValue::String(digest)) = payload.get(key).cloned() {
                    payload.insert(key.into(), json!(self.label(&digest)));
                }
            }
        }
        serde_json::to_string(&row).unwrap()
    }

    /// A stderr line with its `previousHash`/`nextHash` labelled.
    fn line(&mut self, line: &str) -> String {
        let mut out = String::new();
        let mut rest = line;
        while let Some(at) = ["previousHash=\"", "nextHash=\""].iter().filter_map(|key| rest.find(key).map(|i| (i, key.len()))).min() {
            let (start, len) = at;
            out.push_str(&rest[..start + len]);
            rest = &rest[start + len..];
            let end = rest.find('"').unwrap();
            out.push_str(&self.label(&rest[..end]));
            rest = &rest[end..];
        }
        out.push_str(rest);
        out
    }
}

/// `fixtures/cache-break` `turns` (record-cache-break.mjs): one Anthropic session through six turns of the loop, each answered
/// with the recorded usage, its record carrying between turns what the host saves of the run's carry (and the send time the
/// usage change saves): the usage-detected `actual_cache_miss`, the `model_changed` and `tool_schema_changed` request breaks
/// and the `manual_compaction` break a compaction between turns tags are the rows and stderr lines Node traced, turn by turn.
#[tokio::test]
async fn a_sessions_turns_trace_the_cache_breaks_node_traces() {
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_core_api::domain::provider::Usage;
    let golden = cache_break_golden();
    let node = &golden["turns"];
    let now = golden["now"].as_i64().unwrap();
    let thread = node["session"].as_str().unwrap();
    let assistant = |text: &str| AgentMessage::new(Message::new(Role::Assistant, Content::Text(text.into())));
    let mut header = serde_json::Map::new();
    header.insert("providerCacheOpts".into(), json!({ "cacheStrategy": node["cacheStrategy"] }));
    let mut messages = vec![AgentMessage::new(Message::new(Role::System, Content::Text(node["system"].as_str().unwrap().into())))];
    let mut guard = None;
    let (mut ours, mut theirs) = (Digests::default(), Digests::default());
    for step in node["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        if step["compact"] == true {
            // What the manual compaction left: a rewritten transcript, and the intent the host's assembly takes from the record.
            messages.truncate(1);
            messages.push(AgentMessage::user("Summary of the earlier turns."));
            messages.push(assistant("Noted."));
        }
        messages.push(AgentMessage::user(step["prompt"].as_str().unwrap()));
        let usage = &step["usage"];
        let count = |key: &str| usage[key].as_u64().unwrap();
        let reported = Usage { input_tokens: count("inputTokens"), output_tokens: count("outputTokens"), cache_read_tokens: count("cachedTokens"), cache_write_tokens: count("cacheWriteTokens"), ..Default::default() };
        let answer = step["answer"].as_str().unwrap();
        let mut h = Harness::new(Vec::new());
        h.provider = Arc::new(Scripted {
            id: ProviderId::from(node["provider"].as_str().unwrap()),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(vec![turn(vec![Step::Event(StreamEvent::Usage(reported)), text(answer), done(StopReason::EndTurn)])].into()),
            requests: Mutex::new(Vec::new()),
            settled: Mutex::new(Vec::new()),
            calls_handed: Arc::default(),
            order: None,
            released: Mutex::new(Vec::new()),
            stages: Default::default(),
            raises_requesting: false,
            hold: Mutex::new(None),
        });
        let breaks = Arc::new(CacheBreaks::default());
        h.failures = Some(breaks.clone());
        let mut config = RunConfig::new(ThreadId::from(thread), TurnId::from("r"), step["model"].as_str().unwrap());
        if step["compact"] == true {
            config.cache_break_intent = Some("manual_compaction".into());
        }
        let tools: Vec<Arc<dyn Tool>> = if step["tools"].as_array().unwrap().is_empty() { Vec::new() } else { vec![Echo::tool()] };
        let names = tools.iter().map(|t| t.spec().name.clone()).collect();
        let carry = RunCarry { prefix_guard: guard.take(), ..RunCarry::from_saved(&header) };
        let run = Run::new(h.run_env(), h.cancel.clone(), h.provider.clone(), ToolSet::with_builtins(tools, names), h.tool_env(), config, messages.clone(), carry);
        let output = finish(run).await;
        // The host saves the run's carry with the record; the usage change saves the send's time (`lastProviderSendAt`).
        header.extend(output.carry.to_saved());
        header.insert("lastProviderSendAt".into(), json!(h.clock.0.load(Ordering::SeqCst)));
        guard = output.carry.prefix_guard.clone();
        messages.push(assistant(answer));

        let records = breaks.0.lock().unwrap().clone();
        let rows: Vec<String> = records.iter().map(|record| ours.row(&mixdog_trace::stringify(&JsonValue::Object(mixdog_trace::build_row(&mixdog_trace::cache_break_trace_record(record), now))))).collect();
        let want: Vec<String> = step["rows"].as_array().unwrap().iter().map(|row| theirs.row(row.as_str().unwrap())).collect();
        assert_eq!(rows, want, "{name}: the trace rows");
        let lines: Vec<String> = records.iter().map(|record| ours.line(&mixdog_trace::cache_break_line(record))).collect();
        let want: Vec<String> = step["stderr"].as_array().unwrap().iter().map(|line| theirs.line(line.as_str().unwrap())).collect();
        assert_eq!(lines, want, "{name}: the stderr lines");
        assert_eq!(header.get("lastProviderCachedPrefixTokens").cloned().unwrap_or(JsonValue::Null), step["record"]["lastProviderCachedPrefixTokens"], "{name}: the record's cache read plus write");
    }
}

/// `fixtures/cache-break` `routes` (record-cache-break.mjs): Node's loop over sessions whose turns change what the guard
/// compares: a history that shrank and a prefix that was rewritten (each an unexpected break Node traces and then refuses
/// with `ProviderPrefixMutationError`, before anything is sent), a session routed to another provider (`provider_changed`)
/// and a native tool added (`native_tool_schema_changed`). Each step is a real turn of the loop over the transcript the step
/// names, the session's guard carried from the last send that settled, as the loop keeps it: the rows, the stderr lines, what
/// reached the provider and the refusal are Node's. `deferred_body_compaction` and `request_properties_changed` have no
/// product path, and the compactions are not recorded through a real compaction; the manifest's `exclusions` name each.
#[tokio::test]
async fn real_turns_trace_and_refuse_the_breaks_node_does() {
    use mixdog_core_api::domain::provider::HostedTool;
    use mixdog_core_api::domain::provider::HostedWebSearch;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_core_api::domain::provider::Usage;
    let golden = cache_break_golden();
    let now = golden["now"].as_i64().unwrap();
    let mut refused = 0;
    for scenario in golden["routes"].as_array().unwrap() {
        let (mut ours, mut theirs) = (Digests::default(), Digests::default());
        let mut guard = None;
        for step in scenario["steps"].as_array().unwrap() {
            let name = format!("{}: {}", scenario["name"].as_str().unwrap(), step["name"].as_str().unwrap());
            let messages: Vec<AgentMessage> = step["convo"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    let text = row[1].as_str().unwrap();
                    match row[0].as_str().unwrap() {
                        "system" => AgentMessage::new(Message::new(Role::System, Content::Text(text.into()))),
                        "assistant" => AgentMessage::new(Message::new(Role::Assistant, Content::Text(text.into()))),
                        _ => AgentMessage::user(text),
                    }
                })
                .collect();
            let reported = Usage { input_tokens: 10, output_tokens: 2, ..Default::default() };
            let mut h = Harness::new(Vec::new());
            h.provider = Arc::new(Scripted {
                id: ProviderId::from(step["provider"].as_str().unwrap()),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(vec![turn(vec![Step::Event(StreamEvent::Usage(reported)), text("answer"), done(StopReason::EndTurn)])].into()),
                requests: Mutex::new(Vec::new()),
                settled: Mutex::new(Vec::new()),
                calls_handed: Arc::default(),
                order: None,
                released: Mutex::new(Vec::new()),
                stages: Default::default(),
                raises_requesting: false,
                hold: Mutex::new(None),
            });
            let breaks = Arc::new(CacheBreaks::default());
            h.failures = Some(breaks.clone());
            let mut config = RunConfig::new(ThreadId::from(scenario["session"].as_str().unwrap()), TurnId::from("r"), scenario["model"].as_str().unwrap());
            config.options.hosted_tools = step["nativeTools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| HostedTool::WebSearch(HostedWebSearch { tool_type: tool["type"].as_str().unwrap().into(), allowed_domains: Vec::new(), user_location: None, max_uses: None, context_size: None, include_sources: false }))
                .collect();
            let carry = RunCarry { prefix_guard: guard.clone(), ..RunCarry::from_saved(&serde_json::Map::new()) };
            let run = Run::new(h.run_env(), h.cancel.clone(), h.provider.clone(), ToolSet::with_builtins(Vec::new(), Vec::new()), h.tool_env(), config, messages, carry);
            match (run.run().await, step["thrown"].is_null()) {
                (Ok(output), true) => guard = output.carry.prefix_guard.clone(),
                (Err(failure), false) => {
                    let AgentError::PrefixMutation(message) = &failure.error else { panic!("{name}: refused as {:?}", failure.error) };
                    assert_eq!(message, step["thrown"]["message"].as_str().unwrap(), "{name}: the refusal");
                    refused += 1;
                }
                (Ok(_), false) => panic!("{name}: Node refused ({}), the core sent", step["thrown"]),
                (Err(failure), true) => panic!("{name}: Node sent, the core failed: {}", failure.error),
            }
            assert_eq!(h.provider.requests().len() as u64, step["sent"].as_u64().unwrap(), "{name}: what reached the provider");
            let records = breaks.0.lock().unwrap().clone();
            let rows: Vec<String> = records.iter().map(|record| ours.row(&mixdog_trace::stringify(&JsonValue::Object(mixdog_trace::build_row(&mixdog_trace::cache_break_trace_record(record), now))))).collect();
            let want: Vec<String> = step["rows"].as_array().unwrap().iter().map(|row| theirs.row(row.as_str().unwrap())).collect();
            assert_eq!(rows, want, "{name}: the trace rows");
            let lines: Vec<String> = records.iter().map(|record| ours.line(&mixdog_trace::cache_break_line(record))).collect();
            let want: Vec<String> = step["stderr"].as_array().unwrap().iter().map(|line| theirs.line(line.as_str().unwrap())).collect();
            assert_eq!(lines, want, "{name}: the stderr lines");
        }
    }
    assert_eq!(refused, 2, "a shrunk history and a rewritten prefix");
}

/// What the compaction replays summarize with: one fixed text, the calls counted.
struct FixedSummary {
    text: String,
    calls: std::sync::atomic::AtomicUsize,
    /// Each request is appended here as it arrives: the instructions as the system message, the prompt as the user's.
    log: Arc<SendLog>,
}

#[async_trait]
impl mixdog_agent::compact::summary_run::SummarySender for FixedSummary {
    async fn send(
        &self,
        system: &str,
        prompt: &str,
        _call: &mixdog_agent::compact::summary_run::SummaryCall,
    ) -> Result<mixdog_agent::compact::summary_run::SummaryResponse, mixdog_agent::compact::summary_run::SummaryFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.log.0.lock().unwrap().push((true, vec![("system".to_owned(), system.to_owned()), ("user".to_owned(), prompt.to_owned())]));
        Ok(mixdog_agent::compact::summary_run::SummaryResponse {
            text: self.text.clone(),
            tool_call: false,
            usage: Some(mixdog_core_api::domain::provider::Usage { input_tokens: 10, output_tokens: 2, cache_write_tokens: 100, ..Default::default() }),
        })
    }
}

/// The conversation's own model is the only summary route (`summaryMode: session`).
struct OwnRoute {
    sender: Arc<FixedSummary>,
    model: String,
    window: u64,
    calibration: f64,
}

#[async_trait]
impl mixdog_agent::compact::summary_run::RouteResolver for OwnRoute {
    async fn resolve(
        &self,
        step: mixdog_agent::compact::summary_run::RouteStep,
    ) -> Result<Option<mixdog_agent::compact::summary_run::SummaryRoute>, mixdog_agent::compact::summary_run::SummaryFailure> {
        use mixdog_agent::compact::summary_run::RouteStep;
        Ok((step == RouteStep::Session).then(|| mixdog_agent::compact::summary_run::SummaryRoute {
            step,
            provider_name: "anthropic".into(),
            model: self.model.clone(),
            context_window: self.window,
            calibration: self.calibration,
            fast: false,
            effort: None,
            sender: self.sender.clone(),
        }))
    }
}

/// A forked summary is never available: the pipeline sends the isolated request, as Node's does for a session that has no warm cache.
struct NoFork;
#[async_trait]
impl mixdog_agent::compact::summary_run::ForkSource for NoFork {
    fn warm(&self) -> bool {
        false
    }
    fn request(&self) -> Option<mixdog_agent::compact::summary_run::ForkRequest> {
        None
    }
    async fn send(
        &self,
        _route: &mixdog_agent::compact::summary_run::SummaryRoute,
    ) -> Result<mixdog_agent::compact::summary_run::SummaryResponse, mixdog_agent::compact::summary_run::SummaryFailure> {
        panic!("a session without a warm request forks nothing")
    }
}

/// A transcript of plain text: a media part is a failure of the replay.
struct PlainText;
impl mixdog_agent::compact::estimate::MediaMeter for PlainText {
    fn part(&self, part: &mixdog_core_api::domain::provider::ContentPart) -> mixdog_agent::compact::estimate::PartMeter {
        panic!("media part in a text-only replay: {part:?}")
    }
}
impl mixdog_agent::compact::pressure::ImageIdentities for PlainText {
    fn images(&self, _: &AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
        Vec::new()
    }
}
impl mixdog_agent::compact::triggers::ToolMediaMeter for PlainText {
    fn bytes(&self, _: &Content, _: bool) -> u64 {
        0
    }
    fn count(&self, _: &Content, _: bool) -> u64 {
        0
    }
}

/// A user's session: no agent cache tail to expire.
impl mixdog_agent::compact::triggers::CacheWarmLedger for PlainText {
    fn last_use_at(&self) -> u64 {
        0
    }
    fn route_use_at(&self) -> Option<u64> {
        None
    }
}
impl mixdog_agent::compact::triggers::CacheTail for PlainText {
    fn agent_owner(&self) -> bool {
        false
    }
    fn five_minute_tail(&self) -> bool {
        false
    }
    fn last_provider_send_at(&self) -> u64 {
        0
    }
    fn now_ms(&self) -> u64 {
        0
    }
}

fn wire_role(message: &AgentMessage) -> &'static str {
    use mixdog_core_api::domain::provider::Role;
    match message.role() {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        other => panic!("a role the recording has none of: {other:?}"),
    }
}

/// `fixtures/cache-break` `compactions` (record-cache-break.mjs): a session whose transcript is compacted for real, then the
/// send that follows it. The core's own compactor (`FreshCompactor`, over a summary route that answers one fixed text, the only
/// replaced part) rewrites the transcript, and the loop's trace rows, stderr lines, sends and final transcript are Node's:
/// - `manual`: three settled turns, a forced compaction (the budget the forced plan asks for) that parks the intent
///   `manual_compaction`, then the next turn's first send tagged by it;
/// - `automatic`: the turn whose transcript crosses the window is compacted by the loop's own pre-send pass, which tags the
///   send itself (`automatic_compaction`); the summary requests it made are Node's count.
/// `post_turn_compaction` has no product path (the manifest's exclusion names Node's lines).
#[tokio::test]
async fn real_compactions_trace_the_cache_breaks_node_traces() {
    use mixdog_agent::compact::compactor::{FreshCompactor, FreshParts, SessionCompactor, TriggerSeams};
    use mixdog_agent::compact::estimate::MessageMeter;
    use mixdog_agent::compact::pressure::{Route, StatusInput, TranscriptSigner, forced_target_budget};
    use mixdog_agent::compact::summary_run::SummaryMode;
    use mixdog_agent::compact::tool_schema::RequestTools;
    use mixdog_core_api::domain::provider::{Message, Role, Usage};

    let golden = cache_break_golden();
    let now = golden["now"].as_i64().unwrap();
    let mut compared = 0;
    for scenario in golden["compactions"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let session = scenario["header"].as_object().unwrap();
        let (provider, model) = (session["provider"].as_str().unwrap(), session["model"].as_str().unwrap());
        let window = session["contextWindow"].as_u64().unwrap();
        let calibration = scenario["tokenCalibration"].as_f64().unwrap();
        let auto = session["compaction"]["auto"] == true;
        let settings = CompactSettings { auto: true, context_window: Some(window), token_calibration: calibration, ..CompactSettings::default() };
        let log = Arc::new(SendLog::default());
        let summary = Arc::new(FixedSummary { text: scenario["summaryText"].as_str().unwrap().into(), calls: Default::default(), log: log.clone() });
        let plain = Arc::new(PlainText);
        let compactor = FreshCompactor::for_session(SessionCompactor {
            settings: settings.clone(),
            parts: Arc::new(FreshParts {
                media: plain.clone(),
                replay_owner: crate::compact_support::replay_owner(),
                rows: Arc::new(crate::compact_support::Rows),
                archive: Arc::new(crate::compact_support::PreviewArchive { session: session["id"].as_str().unwrap().into() }),
                attachments: Arc::new(crate::compact_support::NoAttachments),
                redactor: Arc::new(crate::compact_support::NoRedaction),
                blobs: Arc::new(crate::compact_support::NoBlobs),
            }),
            triggers: TriggerSeams { tool_media: plain.clone(), native_pdf: false, cache: plain.clone() },
            fork: Arc::new(NoFork),
            resolver: Arc::new(OwnRoute { sender: summary.clone(), model: model.into(), window, calibration }),
            summary_mode: SummaryMode::Session,
            conversation_threshold_tokens: session["compaction"]["conversationThresholdTokens"].as_u64(),
        })
        .expect("a compactor");

        let mut header = serde_json::Map::new();
        header.insert("providerCacheOpts".into(), session["providerCacheOpts"].clone());
        let mut messages = vec![AgentMessage::new(Message::new(Role::System, Content::Text(scenario["system"].as_str().unwrap().into())))];
        let mut guard = None;
        let (mut ours, mut theirs) = (Digests::default(), Digests::default());
        for step in scenario["steps"].as_array().unwrap() {
            let step_name = format!("{name}: {}", step["name"].as_str().unwrap());
            let mut config = RunConfig::new(ThreadId::from(session["id"].as_str().unwrap()), TurnId::from("r"), model);
            if let Some(compaction) = scenario["compaction"].as_object().filter(|_| step["name"] == "after") {
                // The forced pass: the budget its plan asks for over the session as the recorder had it, then the compaction itself.
                let owner = crate::compact_support::replay_owner();
                let meter = MessageMeter { media: &*plain, replay_owner: &owner };
                let rows = crate::compact_support::Rows;
                let signer = TranscriptSigner { meter: &meter, images: &*plain, rows: &rows };
                let status = StatusInput {
                    session,
                    route: Route { provider, model, context_window: JsonValue::Null },
                    cwd: JsonValue::Null,
                    mode: JsonValue::Null,
                    messages: &messages,
                    active: true,
                    request_tools: RequestTools { native: &[], defined: &[] },
                    session_tools: RequestTools { native: &[], defined: &[] },
                    tool_breakdown: &JsonValue::Null,
                    agent_mode: false,
                    meter: &meter,
                    signer: &signer,
                };
                let budget = forced_target_budget(&status).expect("a window") as u64;
                let request = CompactRequest { messages: &messages[1..], budget_tokens: budget, trigger: CompactTrigger::Auto, require_reduction: false, reference_latest_attachments: false, active_turn: false, latest_user_prefix: "" };
                let compacted = compactor.compact(request).await.expect("the compaction");
                assert!(!compacted.skipped, "{step_name}: the pass changed the transcript");
                messages.truncate(1);
                messages.extend(compacted.messages);
                assert_eq!(summary.calls.load(Ordering::SeqCst) as u64, compaction["summaryRequests"].as_u64().unwrap(), "{step_name}: the summary requests of the forced pass");
                summary.calls.store(0, Ordering::SeqCst);
                // The intent the core's own manual compaction parks is checked where that path runs (`mixdog-core`
                // `manual_compaction`); the loop is handed it here, as the session header hands it on.
                config.cache_break_intent = compaction["pending"].as_str().map(str::to_owned);
            }
            messages.push(AgentMessage::user(step["prompt"].as_str().unwrap()));
            let answer = step["answer"].as_str().unwrap();
            let reported = Usage { input_tokens: 10, output_tokens: 2, cache_write_tokens: 100, ..Default::default() };
            let mut h = Harness::new(Vec::new());
            h.provider = Arc::new(Scripted {
                id: ProviderId::from(provider),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(vec![turn(vec![Step::Event(StreamEvent::Usage(reported)), text(answer), done(StopReason::EndTurn)])].into()),
                requests: Mutex::new(Vec::new()),
                settled: Mutex::new(Vec::new()),
                calls_handed: Arc::default(),
                order: Some(log.clone()),
                released: Mutex::new(Vec::new()),
                stages: Default::default(),
                raises_requesting: false,
                hold: Mutex::new(None),
            });
            let breaks = Arc::new(CacheBreaks::default());
            h.failures = Some(breaks.clone());
            if auto {
                h.real_compactor = Some(compactor.clone());
                config.compact = Some(settings.clone());
            }
            let carry = RunCarry { prefix_guard: guard.take(), ..RunCarry::from_saved(&header) };
            let run = Run::new(h.run_env(), h.cancel.clone(), h.provider.clone(), ToolSet::with_builtins(Vec::new(), Vec::new()), h.tool_env(), config, messages.clone(), carry);
            let output = finish(run).await;
            header.extend(output.carry.to_saved());
            header.insert("lastProviderSendAt".into(), json!(h.clock.0.load(Ordering::SeqCst)));
            guard = output.carry.prefix_guard.clone();
            messages = output.transcript;
            if messages.last().is_none_or(|m| m.role() != Role::Assistant) {
                messages.push(AgentMessage::assistant(answer, Vec::new()));
            }

            summary.calls.store(0, Ordering::SeqCst);
            let records = breaks.0.lock().unwrap().clone();
            let rows: Vec<String> = records.iter().map(|record| ours.row(&mixdog_trace::stringify(&JsonValue::Object(mixdog_trace::build_row(&mixdog_trace::cache_break_trace_record(record), now))))).collect();
            let want: Vec<String> = step["rows"].as_array().unwrap().iter().map(|row| theirs.row(row.as_str().unwrap())).collect();
            assert_eq!(rows, want, "{step_name}: the trace rows");
            let lines: Vec<String> = records.iter().map(|record| ours.line(&mixdog_trace::cache_break_line(record))).collect();
            let want: Vec<String> = step["stderr"].as_array().unwrap().iter().map(|line| theirs.line(line.as_str().unwrap())).collect();
            assert_eq!(lines, want, "{step_name}: the stderr lines");
        }
        let transcript: Vec<(String, String)> = messages.iter().map(|m| (wire_role(m).to_owned(), m.text())).collect();
        let want: Vec<(String, String)> = scenario["transcript"].as_array().unwrap().iter().map(|m| (m["role"].as_str().unwrap().to_owned(), m["content"].as_str().unwrap().to_owned())).collect();
        assert_eq!(transcript, want, "{name}: the transcript the compaction and the turns left");
        // Every send of the scenario, summary requests and turns, whole and in the order the provider received them.
        let want: Vec<Sent> = scenario["sends"]
            .as_array()
            .unwrap()
            .iter()
            .map(|send| (send["summary"].as_bool().unwrap(), send["messages"].as_array().unwrap().iter().map(|m| (m["role"].as_str().unwrap().to_owned(), m["content"].as_str().unwrap().to_owned())).collect()))
            .collect();
        assert_eq!(*log.0.lock().unwrap(), want, "{name}: the sends, in the order they arrived");
        compared += 1;
    }
    assert_eq!(compared, 2, "a manual and an automatic compaction");
}

/// `fixtures/cache-break` `guard`: the comparison over Node's own request fingerprints tells each break Node told, with the
/// same details. The comparison alone: the loop's use of it is `real_turns_trace_and_refuse_the_breaks_node_does`.
#[test]
fn the_prefix_guard_tells_every_break_node_tells() {
    use mixdog_agent::prefix_guard::GuardOptions;
    use mixdog_agent::prefix_guard::Snapshot;
    let golden = cache_break_golden();
    let snapshot = |value: &JsonValue| Snapshot {
        message_hashes: value["messageHashes"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_owned()).collect(),
        request_prefix_hash: value["requestPrefixHash"].as_str().unwrap().into(),
        provider: value["provider"].as_str().unwrap().into(),
        model: value["model"].as_str().unwrap().into(),
        tool_schema_hash: value["toolSchemaHash"].as_str().unwrap().into(),
        native_tool_schema_hash: value["nativeToolSchemaHash"].as_str().unwrap().into(),
    };
    for case in golden["guard"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let options = &case["options"];
        let told = mixdog_agent::prefix_guard::compare(
            Some(&snapshot(&case["previous"])),
            &snapshot(&case["next"]),
            &GuardOptions { provider: options["provider"].as_str().unwrap(), model: options["model"].as_str().unwrap(), intent: options["cacheBreakIntent"].as_str(), mutation_source: options["mutationSource"].as_str() },
        );
        let want: Vec<JsonValue> = case["breaks"].as_array().unwrap().clone();
        assert_eq!(told.map(JsonValue::Object).into_iter().collect::<Vec<_>>(), want, "{name}");
        assert_eq!(case["thrown"].is_null(), want.first().is_none_or(|b| b["classification"] != "unexpected"), "{name}: Node refuses exactly the unexpected breaks");
    }
}

/// `fixtures/cache-break` `guard` (the deferred-tool cases): an Anthropic request's fingerprint leaves a deferred tool out of
/// its prefix, any other provider's keeps it; whether the prefix moved is what Node's comparison found.
#[test]
fn a_deferred_tool_moves_the_request_prefix_where_node_says() {
    use mixdog_core_api::domain::provider::ToolDefinition;
    let golden = cache_break_golden();
    let tool = |name: &str, deferred: bool| ToolDefinition { name: name.into(), description: format!("{name}."), input_schema: json!({ "type": "object" }), defer_loading: deferred, freeform: None };
    for name in ["a deferred tool on anthropic", "a deferred tool elsewhere"] {
        let case = golden["guard"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        let provider = case["options"]["provider"].as_str().unwrap();
        let before = mixdog_agent::prefix_guard::snapshot::<JsonValue>(&[], &[tool("a", false)], &[], provider, "m1");
        let after = mixdog_agent::prefix_guard::snapshot::<JsonValue>(&[], &[tool("a", false), tool("d", true)], &[], provider, "m1");
        assert_eq!(before.request_prefix_hash == after.request_prefix_hash, case["previous"]["requestPrefixHash"] == case["next"]["requestPrefixHash"], "{name}");
    }
}

/// `fixtures/cache-break` `prefix`, `seeded`: the Anthropic request fingerprints the cache-miss row names its moved blocks from:
/// the persisted fingerprint of every body, the changes from the body before, and a restarted process's seed.
#[test]
fn the_anthropic_prefix_fingerprints_are_nodes() {
    use mixdog_ai::providers::anthropic::prefix_trace;
    let golden = cache_break_golden();
    // The recording's session ids, kept apart from any other test's by a suffix.
    let ours = |session: &str| format!("{session}:run_loop");
    for case in golden["prefix"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let session = ours(case["session"].as_str().unwrap());
        prefix_trace::record(Some(&session), prefix_trace::fingerprint(case["body"].as_object().unwrap()));
        assert_eq!(prefix_trace::latest_persistable(&session).unwrap_or(JsonValue::Null), case["persisted"], "{name}: the persisted fingerprint");
        assert_eq!(prefix_trace::changes(&session).map_or(JsonValue::Null, JsonValue::Object), case["changes"], "{name}: the changes");
    }
    let seeded = &golden["seeded"];
    let session = ours("sess_prefix_seeded");
    prefix_trace::seed(&session, Some(&seeded["from"]));
    prefix_trace::seed(&session, Some(&golden["prefix"][3]["persisted"]));
    assert_eq!(prefix_trace::changes(&session).map_or(JsonValue::Null, JsonValue::Object), seeded["changesBefore"], "a seed alone");
    prefix_trace::record(Some(&session), prefix_trace::fingerprint(seeded["body"].as_object().unwrap()));
    assert_eq!(prefix_trace::changes(&session).map_or(JsonValue::Null, JsonValue::Object), seeded["changes"], "the request after a seed");
}

#[tokio::test]
async fn a_retried_send_keeps_one_group_and_settles_nothing_on_success() {
    let h = Harness::new(vec![overloaded(), overloaded(), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    let groups = h.provider.groups();
    assert_eq!(groups.len(), 3);
    assert!(groups[0].is_some() && groups.iter().all(|g| *g == groups[0]), "{groups:?}");
    // The provider's own accounting folds the group into one row with `attempts` on success.
    assert!(h.provider.settled().is_empty());
}

#[tokio::test]
async fn a_request_changing_replay_settles_the_old_group_and_starts_a_new_one() {
    use mixdog_core_api::domain::provider::SendEnd;
    let h = Harness::new(vec![
        rejection(ErrorKind::ReplayRejected, None),
        overloaded(),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let mut assistant = AgentMessage::assistant("t", Vec::new());
    assistant.message.assistant_blocks = Some(json!([{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "t"}]));
    finish(h.run(config(), vec![], vec![AgentMessage::user("a"), assistant, AgentMessage::user("b")])).await;
    let groups = h.provider.groups();
    assert_eq!(groups.len(), 3);
    assert_ne!(groups[0], groups[1]);
    assert_eq!(groups[1], groups[2], "the decider's retry keeps the group");
    assert_eq!(h.provider.settled(), [(groups[0].clone().unwrap(), SendEnd::Surfaced)]);
}

#[tokio::test]
async fn a_surfaced_failure_settles_its_group_before_the_error_returns() {
    use mixdog_core_api::domain::provider::SendEnd;
    let h = Harness::new(vec![rejection(ErrorKind::InvalidRequest, None)]);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("surfaced");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    let groups = h.provider.groups();
    assert_eq!(h.provider.settled(), [(groups[0].clone().unwrap(), SendEnd::Surfaced)]);
}

#[tokio::test]
async fn an_aborted_turn_leaves_no_open_group() {
    use mixdog_core_api::domain::provider::SendEnd;
    let h = Harness::new(vec![turn(vec![text("a"), Step::Hang])]);
    let cancel = h.cancel.clone();
    let task = tokio::spawn(h.run(config(), vec![], vec![AgentMessage::user("go")]).run());
    while h.provider.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    cancel.cancel();
    let failure = task.await.unwrap().expect_err("aborted");
    assert!(matches!(failure.error, AgentError::Aborted));
    let groups = h.provider.groups();
    assert_eq!(h.provider.settled(), [(groups[0].clone().unwrap(), SendEnd::Cancelled)]);
}

#[tokio::test]
async fn a_dropped_turn_settles_its_group_as_cancelled() {
    use mixdog_core_api::domain::provider::SendEnd;
    let h = Harness::new(vec![turn(vec![text("a"), Step::Hang])]);
    let task = tokio::spawn(h.run(config(), vec![], vec![AgentMessage::user("go")]).run());
    while h.provider.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    task.abort();
    let _ = task.await;
    while h.provider.settled().is_empty() {
        tokio::task::yield_now().await;
    }
    let groups = h.provider.groups();
    assert_eq!(h.provider.settled(), [(groups[0].clone().unwrap(), SendEnd::Cancelled)]);
}

/// The turn's future is dropped where no Tokio runtime is entered: the group's hold on what other sends wait for is let go
/// by the guard itself, which needs no runtime.
#[test]
fn a_turn_dropped_outside_a_runtime_lets_go_of_its_group() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let h = Harness::new(vec![turn(vec![text("a"), Step::Hang])]);
    let mut run = Box::pin(h.run(config(), vec![], vec![AgentMessage::user("go")]).run());
    runtime.block_on(async {
        while h.provider.requests().is_empty() {
            std::future::poll_fn(|cx| {
                let _ = std::future::Future::poll(run.as_mut(), cx);
                std::task::Poll::Ready(())
            })
            .await;
            tokio::task::yield_now().await;
        }
    });
    assert!(h.provider.released.lock().unwrap().is_empty(), "the send is still in flight");
    drop(run);
    let groups = h.provider.groups();
    assert_eq!(*h.provider.released.lock().unwrap(), [groups[0].clone().unwrap()]);
}

#[tokio::test]
async fn a_rejected_replay_is_dropped_from_the_newest_assistant_turn() {
    let h = Harness::new(vec![
        rejection(ErrorKind::ReplayRejected, None),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let mut assistant = AgentMessage::assistant("t", Vec::new());
    assistant.message.assistant_blocks = Some(json!([
        {"type": "thinking", "thinking": "x"},
        {"type": "text", "text": "t"},
    ]));
    let messages = vec![AgentMessage::user("a"), assistant, AgentMessage::user("b")];
    let output = finish(h.run(config(), vec![], messages)).await;
    assert_eq!(
        output.transcript[1].message.assistant_blocks,
        Some(json!([{"type": "text", "text": "t"}]))
    );
    assert_eq!(h.provider.requests().len(), 2);
    let replaced = h.sink.replaced.lock().unwrap();
    assert_eq!(replaced.len(), 1, "the repair is persisted");
    assert_eq!(replaced[0].1, Rewrite::default(), "a repair drops nothing");
}

#[tokio::test]
async fn a_rejected_tool_schema_drops_the_tool_and_refuses_later_calls() {
    let Attempt::Reject(mut schema) = rejection(ErrorKind::ToolSchemaRejected, None) else {
        unreachable!()
    };
    schema.rejected_tool = Some("echo".into());
    let h = Harness::new(vec![
        Attempt::Reject(schema),
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let requests = h.provider.requests();
    assert_eq!(requests[0].tools.len(), 1);
    assert!(requests[1].tools.is_empty());
    assert!(dump(&output.transcript)[2].starts_with(
        "tool#c1(Error):Error: tool \"echo\" is unavailable with the current model: the provider rejected its input schema at / (the provider rejected it with HTTP 400: bad request)"
    ));
}

struct RecordingEffort {
    provider: Arc<Scripted>,
    seen: Mutex<Vec<Option<mixdog_agent::effort::EffortProjection>>>,
}
#[async_trait]
impl mixdog_agent::effort::EffortAdapter for RecordingEffort {
    async fn attempt_with(
        &self,
        request: Arc<ModelRequest>,
        effort: Option<mixdog_agent::effort::EffortProjection>,
    ) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.seen.lock().unwrap().push(effort);
        self.provider.attempt(request).await
    }
}

#[tokio::test]
async fn each_request_carries_the_effort_projection_of_its_transcript() {
    use mixdog_agent::effort::EffortMode;
    use mixdog_agent::effort::EffortRoute;
    use mixdog_agent::effort::EffortSnapshot;
    use mixdog_agent::effort::EffortWiring;
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
    let snap = |effort: &str| EffortSnapshot {
        provider: "openai".into(),
        model: "gpt-6-1".into(),
        mode: EffortMode::Responses,
        initial_effort: "low".into(),
        effort: effort.into(),
    };
    let mut first = AgentMessage::user("earlier");
    first.effort = Some(snap("low"));
    let mut second = AgentMessage::user("go");
    second.effort = Some(snap("high"));
    let messages = vec![first, AgentMessage::assistant("a", Vec::new()), second];
    let mut cfg = config();
    cfg.effort = Some(EffortWiring {
        route: EffortRoute {
            provider: "openai".into(),
            model: "gpt-6.1".into(),
            mode: Some(EffortMode::Responses),
            allowed: ["low", "medium", "high"].map(String::from).to_vec(),
            seed: None,
            wire: Arc::new(|e| Some(e.to_owned())),
        },
        adapter: adapter.clone(),
    });
    finish(h.run(cfg, vec![Echo::tool()], messages)).await;
    let seen = adapter.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    for projection in &seen {
        let projection = projection.as_ref().expect("projection");
        assert_eq!(projection.initial_effort, "low");
        assert_eq!(projection.updates.iter().collect::<Vec<_>>(), [(&2, &"high".to_owned())]);
    }
}

/// Resolves only when the test releases it, and says when it was entered.
struct GatedJudge {
    entered: std::sync::atomic::AtomicBool,
    gate: tokio::sync::Notify,
}
#[async_trait]
impl mixdog_agent::step_effort::StepEffortJudge for GatedJudge {
    async fn judge(&self, input: mixdog_agent::step_effort::StepInput) -> Option<mixdog_agent::step_effort::StepResult> {
        assert_eq!(input.request, "do it");
        assert_eq!(input.step, 1);
        assert_eq!(input.calls[0].name, "echo");
        assert!(input.calls[0].result.starts_with("echo:"));
        self.entered.store(true, Ordering::SeqCst);
        self.gate.notified().await;
        Some(mixdog_agent::step_effort::StepResult { level: None, effort: Some("high".into()) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_next_request_waits_for_the_step_judgment_and_carries_it() {
    use mixdog_agent::effort::EffortMode;
    use mixdog_agent::effort::EffortRoute;
    use mixdog_agent::effort::EffortSnapshot;
    use mixdog_agent::effort::EffortWiring;
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"i": 1})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let timer = Arc::new(HeldTimer::default());
    h.waiter = Arc::new(RecordedWait(Mutex::default(), Some(timer.clone())));
    let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
    let seed = EffortSnapshot {
        provider: "openai".into(),
        model: "gpt-6-1".into(),
        mode: EffortMode::Responses,
        initial_effort: "low".into(),
        effort: "low".into(),
    };
    let mut cfg = config();
    cfg.effort = Some(EffortWiring {
        route: EffortRoute {
            provider: "openai".into(),
            model: "gpt-6.1".into(),
            mode: Some(EffortMode::Responses),
            allowed: ["low", "high"].map(String::from).to_vec(),
            seed: Some(seed),
            wire: Arc::new(|e| Some(e.to_owned())),
        },
        adapter: adapter.clone(),
    });
    cfg.step_auto_effort = Some(mixdog_agent::step_effort::StepAutoEffort { request: "do it".into(), base: "low".into() });
    let judge = Arc::new(GatedJudge { entered: Default::default(), gate: tokio::sync::Notify::new() });
    let mut run = h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("do it")]);
    run.set_step_judge(judge.clone());
    let task = tokio::spawn(run.run());
    mixdog_rt::time::timeout(Duration::from_secs(30), timer.waiting.notified()).await.expect("the next request waits out the step grace");
    // The judge is held and the grace has not passed: the second request must not have been sent.
    assert_eq!(h.provider.requests().len(), 1);
    // The judgment resolves inside the grace, whose time never passes.
    judge.gate.notify_one();
    let output = mixdog_rt::time::timeout(Duration::from_secs(30), task).await.expect("the run ends once judged").unwrap().expect("run");
    assert_eq!(h.provider.requests().len(), 2);
    let seen = adapter.seen.lock().unwrap().clone();
    assert!(seen[0].as_ref().is_some_and(|p| p.updates.is_empty()), "the first request has nothing to update");
    let second = seen[1].as_ref().expect("the judged effort is on the very next request");
    assert_eq!(second.updates.iter().collect::<Vec<_>>(), [(&2, &"high".to_owned())]);
    assert_eq!(output.transcript[2].effort.as_ref().map(|s| s.effort.as_str()), Some("high"));
}

/// Sends through the provider, keeping what the run had published as the turn's effort when each request went out,
/// and the effort the request itself carries (`RequestOptions.effort`, Anthropic's `output_config.effort`).
struct SampledEffort {
    provider: Arc<Scripted>,
    observer: Arc<Observer>,
    at_sends: Mutex<Vec<serde_json::Value>>,
}
#[async_trait]
impl mixdog_agent::effort::EffortAdapter for SampledEffort {
    async fn attempt_with(
        &self,
        request: Arc<ModelRequest>,
        _: Option<mixdog_agent::effort::EffortProjection>,
    ) -> Result<Box<dyn ModelStream>, ProviderError> {
        let published = self.observer.events().into_iter().filter_map(|e| match e { RunEvent::TurnEffort(effort) => Some(effort), _ => None }).last().flatten();
        self.at_sends.lock().unwrap().push(json!({ "turnEffort": published, "requestEffort": request.options.effort }));
        self.provider.attempt(request).await
    }
}

/// The judge model's answer as the turn-effort recording scripted it (`judgeTurn` answering `JUDGE.step`): the core's
/// judge resolves it through its own ladder.
struct RecordedProbs(Vec<f64>);
#[async_trait]
impl mixdog_services::effort_judge::judge::StepProbs for RecordedProbs {
    async fn probs(&self, _: mixdog_agent::step_effort::StepInput) -> Result<Vec<f64>, mixdog_services::effort_judge::error::JudgeError> {
        Ok(self.0.clone())
    }
}

/// `fixtures/turn-effort/*.json` (`record-turn-effort.mjs`): Node's exec turn over its real runtime, a tool call and a
/// final reply on an Anthropic route that takes effort updates, with `runtime.turnEffort` read while each request was in
/// flight and after the turn settled. The route's effort fixed (`high`), absent, and Auto at `medium` with a step judged
/// after the tool call. The same turn here runs the loop with the route's effort wiring and the step judgment the
/// recording's judge gave; what the run published last before each request, and last of all, is what Node's getter
/// answered then. (The judge's distribution to effort is the step-ladder recording's; the judge here answers the effort.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_turn_effort_published_is_the_one_node_answered_at_each_request_and_after_settling() {
    use mixdog_agent::effort::{EffortMode, EffortRoute, EffortSnapshot, EffortWiring};
    for name in ["fixed", "none", "auto-step"] {
        let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/../../fixtures/turn-effort/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap();
        assert_eq!(recorded["code"], 0, "{name}");
        let effort = recorded["route"]["effort"].as_str().map(str::to_owned);
        let model = recorded["route"]["model"].as_str().unwrap().to_owned();
        let auto = recorded["autoEffort"] == "on";
        let mut h = Harness::new(vec![
            turn(vec![text("reading"), call("c1", "echo", json!({"path": "a.txt"})), done(StopReason::ToolUse)]),
            turn(vec![text("all done"), done(StopReason::EndTurn)]),
        ]);
        // Node awaited the step's judgment before the next request: here the grace's time never passes, so the judgment
        // is what the request waits for.
        h.waiter = Arc::new(RecordedWait(Mutex::default(), Some(Arc::new(HeldTimer::default()))));
        let adapter = Arc::new(SampledEffort { provider: h.provider.clone(), observer: h.observer.clone(), at_sends: Mutex::new(Vec::new()) });
        let mut cfg = config();
        // The route's effort as the host puts it on the turn's requests (`assemble.rs`, the header's `effort`).
        cfg.options.effort = effort.clone();
        // The turn's snapshot `prepareTurnEffortConfiguration` stamps: none without an effort on the route.
        cfg.effort = Some(EffortWiring {
            route: EffortRoute {
                provider: "anthropic".into(),
                model: model.clone(),
                mode: Some(EffortMode::Anthropic),
                allowed: ["low", "medium", "high"].map(String::from).to_vec(),
                seed: effort.clone().map(|e| EffortSnapshot { provider: "anthropic".into(), model: model.clone(), mode: EffortMode::Anthropic, initial_effort: e.clone(), effort: e }),
                wire: Arc::new(|e| Some(e.to_owned())),
            },
            adapter: adapter.clone(),
        });
        let sends = recorded["sends"].as_array().unwrap();
        let mut run = if auto {
            // The judge model's answers are the recording's script: the turn's distribution sets the base on the route's
            // ladder (`resolveAutoEffort` at turn start), the step's goes to the core's judge over the same ladder.
            let options = mixdog_ai::effort::effort_options_for("anthropic", &json!({ "id": model, "reasoningLevels": ["low", "medium", "high"], "customReasoning": true }), None);
            let probs = |kind: &str| recorded["judge"][kind].as_array().unwrap().iter().map(|p| p.as_f64().unwrap()).collect::<Vec<f64>>();
            let base = mixdog_services::effort_judge::ladder::resolve_auto_effort(effort.as_deref().unwrap(), &options, &probs("turn")).expect("the route's effort is on its ladder").effort.to_owned();
            cfg.step_auto_effort = Some(mixdog_agent::step_effort::StepAutoEffort { request: recorded["prompt"].as_str().unwrap().into(), base: base.clone() });
            let mut run = h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user(recorded["prompt"].as_str().unwrap())]);
            let ladder = Arc::new(mixdog_services::effort_judge::AutoLadder { base, options });
            run.set_step_judge(Arc::new(mixdog_services::effort_judge::EffortJudge::over(Arc::new(RecordedProbs(probs("step"))), ladder)));
            run
        } else {
            h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user(recorded["prompt"].as_str().unwrap())])
        };
        run.run().await.expect("run");
        assert_eq!(h.provider.requests().len(), sends.len(), "{name}");
        // The published value in force at each request and the effort the request carried, then at the end.
        let current = h.observer.events().into_iter().filter_map(|e| match e { RunEvent::TurnEffort(effort) => Some(effort), _ => None }).last().flatten();
        let node: Vec<_> = sends.iter().map(|send| json!({ "turnEffort": send["turnEffort"], "requestEffort": send["requestEffort"] })).collect();
        assert_eq!(*adapter.at_sends.lock().unwrap(), node, "{name}: at each request");
        // What a client saw is compared through the session actor (`mixdog-core` `run_host::factory` tests,
        // `the_actor_publishes_the_turn_effort_sequence_node_published`).
        assert_eq!(json!(current), recorded["settled"]["turnEffort"], "{name}: after the turn settled");
    }
}

/// Never answers.
struct SilentJudge;
#[async_trait]
impl mixdog_agent::step_effort::StepEffortJudge for SilentJudge {
    async fn judge(&self, _input: mixdog_agent::step_effort::StepInput) -> Option<mixdog_agent::step_effort::StepResult> {
        std::future::pending().await
    }
}

#[tokio::test]
async fn a_step_judge_that_never_answers_holds_the_next_request_for_the_grace_only() {
    use mixdog_agent::effort::EffortMode;
    use mixdog_agent::effort::EffortRoute;
    use mixdog_agent::effort::EffortSnapshot;
    use mixdog_agent::effort::EffortWiring;
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"i": 1})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let timer = Arc::new(HeldTimer::default());
    h.waiter = Arc::new(RecordedWait(Mutex::default(), Some(timer.clone())));
    let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
    let seed = EffortSnapshot {
        provider: "openai".into(),
        model: "gpt-6-1".into(),
        mode: EffortMode::Responses,
        initial_effort: "low".into(),
        effort: "low".into(),
    };
    let mut cfg = config();
    cfg.effort = Some(EffortWiring {
        route: EffortRoute {
            provider: "openai".into(),
            model: "gpt-6.1".into(),
            mode: Some(EffortMode::Responses),
            allowed: ["low", "high"].map(String::from).to_vec(),
            seed: Some(seed),
            wire: Arc::new(|e| Some(e.to_owned())),
        },
        adapter: adapter.clone(),
    });
    cfg.step_auto_effort = Some(mixdog_agent::step_effort::StepAutoEffort { request: "do it".into(), base: "low".into() });
    let mut run = h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("do it")]);
    run.set_step_judge(Arc::new(SilentJudge));
    let task = tokio::spawn(run.run());
    mixdog_rt::time::timeout(Duration::from_secs(30), timer.waiting.notified()).await.expect("the next request waits out the step grace");
    assert_eq!(*h.waiter.0.lock().unwrap(), [mixdog_agent::step_effort::STEP_EFFORT_GRACE]);
    assert_eq!(h.provider.requests().len(), 1, "held while the grace has not passed");
    // The grace passes; the judge still has not answered.
    timer.elapse.notify_one();
    let output = mixdog_rt::time::timeout(Duration::from_secs(30), task).await.expect("the request goes out once the grace has passed").unwrap().expect("run");
    assert_eq!(h.provider.requests().len(), 2);
    assert!(output.transcript[2].effort.is_none(), "an unanswered step stays at the effort in force");
}
struct Artifacts(Mutex<Vec<String>>);
#[async_trait]
impl mixdog_agent::offload::ArtifactStore for Artifacts {
    async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        self.0.lock().unwrap().push(content.to_owned());
        Some(mixdog_agent::offload::Artifact { display_path: "/art/r.txt".into(), path: "/art/r.txt".into(), lines: 1, sha256: "cd".repeat(32) })
    }
    async fn preview(&self, _content: &str) -> Option<mixdog_agent::offload::Artifact> {
        Some(mixdog_agent::offload::Artifact { display_path: "/art/r.txt".into(), path: "/art/r.txt".into(), lines: 1, sha256: "cd".repeat(32) })
    }
}

struct BigTool(ToolSpec);
#[async_trait]
impl Tool for BigTool {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text("g".repeat(30_000))], ..ToolOutput::default() })
    }
}

#[tokio::test]
async fn an_oversized_result_is_stored_and_replaced_by_a_pointer_in_the_transcript() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "grep", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let mut spec = Echo::tool().spec().clone();
    spec.name = "grep".into();
    let artifacts = Arc::new(Artifacts(Mutex::new(Vec::new())));
    let mut run = h.run(config(), vec![Arc::new(BigTool(spec))], vec![AgentMessage::user("go")]);
    run.set_artifact_store(artifacts.clone());
    let output = finish(run).await;
    let result = output.transcript[2].text();
    assert!(result.starts_with("[tool output offloaded: grep → /art/r.txt (29 KB, 1 lines)]"), "{}", &result[..80]);
    assert_eq!(artifacts.0.lock().unwrap()[0].len(), 30_000);
}
/// `preflightAttachments` runs before every send whether or not automatic compaction is on, and
/// its rewrite is the transcript a retried turn starts from (issue #150).
#[tokio::test]
async fn the_attachment_preflight_rewrites_the_transcript_with_compaction_off() {
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { preflight: true, ..Default::default() }));
    let mut cfg = config();
    cfg.compact = None;
    // A continuation anchored on the inline prefix: the rewrite must not be skipped by it.
    cfg.options.provider_state = Some(mixdog_core_api::domain::provider::ProviderState::default());
    let output = finish(h.run(cfg, vec![], vec![AgentMessage::user("attached")])).await;
    let request = &h.provider.requests()[0];
    assert_eq!(request.options.provider_state, None, "preflight clears the continuation");
    assert_eq!(output.provider_state, None);
    assert!(request.messages.iter().any(|m| m.content == Content::Text("referenced".into())));
    assert!(!request.messages.iter().any(|m| m.content == Content::Text("attached".into())));
    assert_eq!(output.transcript[0].message.content, Content::Text("referenced".into()));
    let replaced = h.sink.replaced.lock().unwrap();
    assert_eq!(replaced.len(), 1, "the rewrite is persisted once");
    assert_eq!(replaced[0].0[0].message.content, Content::Text("referenced".into()));
    assert_eq!(replaced[0].1, Rewrite::default());
}

/// Far below the pressure trigger, an expired cache tail compacts with its own trigger kind.
#[tokio::test]
async fn an_expired_cache_tail_arms_a_cache_expired_compaction() {
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { cache_expired: true, ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: true, context_window: Some(100_000), token_calibration: 1.0, ..CompactSettings::default() });
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b"), AgentMessage::user("c")];
    finish(h.run(cfg, vec![], messages)).await;
    assert_eq!(*h.compactor.as_ref().unwrap().requests.lock().unwrap(), [(3, CompactTrigger::CacheExpired)]);
}

/// Media pressure compacts without requiring the transcript to shrink.
#[tokio::test]
async fn request_media_arms_a_compaction_that_need_not_reduce() {
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { request_media: true, ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: true, context_window: Some(100_000), token_calibration: 1.0, ..CompactSettings::default() });
    // Two messages: reduces would refuse, but media pressure skips that check.
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b")];
    finish(h.run(cfg, vec![], messages)).await;
    assert_eq!(*h.compactor.as_ref().unwrap().requests.lock().unwrap(), [(2, CompactTrigger::Auto)]);
}

#[tokio::test]
async fn a_one_shot_call_retries_through_the_decider_keeps_its_cap_and_sends_rows_unwrapped() {
    use mixdog_agent::one_shot::CallShape;
    use mixdog_agent::one_shot::OneShot;
    use mixdog_agent::one_shot::OneShotCall;
    let mut transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    transient.message = "blip".into();
    let h = Harness::new(vec![
        Attempt::Reject(transient),
        turn(vec![text("SUMMARY"), done(StopReason::EndTurn)]),
    ]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let call = OneShotCall { model: "m".into(), max_output_tokens: 4096, fast: true, shape: CallShape::compaction() };
    // a prompt that the loop would wrap as a synthetic row goes out as written
    let prompt = "[mixdog-runtime] not a real runtime row";
    let out = one.call_prompt(&call, "sys", prompt).await.expect("one shot");
    assert_eq!(out.text, "SUMMARY");
    assert!(!out.tool_call);
    let requests = h.provider.requests();
    assert_eq!(requests.len(), 2, "one retry through the decider");
    for r in &requests {
        assert_eq!(wire_dump(r), vec!["System:sys".to_owned(), format!("User:{prompt}")]);
        assert!(r.tools.is_empty());
        assert_eq!(r.options.max_output_tokens_override, Some(4096), "the cap survives the retry");
        assert_eq!(r.options.effort.as_deref(), Some("low"));
        assert_eq!(r.options.request_kind.as_deref(), Some("compaction"));
        assert!(r.options.fast);
    }
    assert_eq!(h.waiter.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_cancelled_one_shot_call_is_an_aborted_summary_failure() {
    use mixdog_agent::compact::summary_run::SummaryCall;
    use mixdog_agent::compact::summary_run::SummaryFailure;
    use mixdog_agent::compact::summary_run::SummarySender;
    use mixdog_agent::one_shot::CallShape;
    use mixdog_agent::one_shot::OneShot;
    let h = Harness::new(vec![turn(vec![text("par"), Step::Hang])]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let call = SummaryCall { model: "m".into(), max_output_tokens: 4096, fast: false, shape: CallShape::compaction() };
    let task = tokio::spawn(async move { one.send("sys", "prompt", &call).await });
    while h.provider.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    h.cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(SummaryFailure::Aborted)));
}

fn overloaded() -> Attempt {
    let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::NotSent);
    error.status = Some(529);
    error.message = "overloaded".into();
    Attempt::Reject(error)
}

fn shaped(model: &str, shape: mixdog_agent::one_shot::CallShape) -> mixdog_agent::one_shot::OneShotCall {
    mixdog_agent::one_shot::OneShotCall { model: model.into(), max_output_tokens: 400, fast: false, shape }
}

/// The compaction summary keeps Node's values: kind `compaction`, effort `low`, the provider's own
/// cache policy, and an overload retried like any transient failure.
#[tokio::test]
async fn a_compaction_call_keeps_its_kind_effort_cache_and_retries_an_overload() {
    use mixdog_agent::one_shot::{CallShape, OneShot};
    let h = Harness::new(vec![overloaded(), turn(vec![text("SUMMARY"), done(StopReason::EndTurn)])]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let out = one.call_prompt(&shaped("m", CallShape::compaction()), "sys", "p").await.expect("retried");
    assert_eq!(out.text, "SUMMARY");
    let requests = h.provider.requests();
    assert_eq!(requests.len(), 2, "the 529 is retried");
    for r in &requests {
        assert_eq!(r.options.request_kind.as_deref(), Some("compaction"));
        assert_eq!(r.options.effort.as_deref(), Some("low"));
        assert_eq!(r.options.model_parameters, None, "the route's cache policy is left alone");
    }
}

/// The room supervisor's step: the route's own effort (`low` when it names none), no request kind,
/// no prompt cache, and an overload surfaces at once with no wait.
#[tokio::test]
async fn a_room_supervisor_call_sends_the_routes_effort_without_kind_or_cache_and_surfaces_an_overload() {
    use mixdog_agent::one_shot::{CallShape, OneShot};
    let mut parameters = serde_json::Map::new();
    parameters.insert("temperature".into(), json!(0.2));
    parameters.insert("cacheStrategy".into(), json!({ "messages": "1h" }));
    for (route_effort, want) in [(Some(" high "), "high"), (Some("  "), "low"), (None, "low")] {
        let h = Harness::new(vec![turn(vec![text("{}"), done(StopReason::EndTurn)])]);
        let options = mixdog_core_api::domain::provider::RequestOptions { model_parameters: Some(JsonValue::Object(parameters.clone())), ..Default::default() };
        let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone()).with_options(options);
        one.call_prompt(&shaped("m", CallShape::room_supervisor(route_effort)), "sys", "p").await.expect("answered");
        let sent = h.provider.requests();
        assert_eq!(sent[0].options.effort.as_deref(), Some(want));
        assert_eq!(sent[0].options.request_kind, None);
        assert_eq!(
            sent[0].options.model_parameters,
            Some(json!({
                "temperature": 0.2,
                "cacheStrategy": { "tools": "none", "system": "none", "tier3": "none", "messages": "none" },
            }))
        );
    }
    let h = Harness::new(vec![overloaded(), turn(vec![text("never"), done(StopReason::EndTurn)])]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let failure = one.call_prompt(&shaped("m", CallShape::room_supervisor(None)), "sys", "p").await.expect_err("surfaced");
    assert!(matches!(failure, AgentError::Provider(ref e) if e.status == Some(529)), "{failure:?}");
    assert_eq!(h.provider.requests().len(), 1, "no retry of a 529");
    assert!(h.waiter.0.lock().unwrap().is_empty(), "and no wait");
}

// ---- the model fallback decision ---------------------------------------------------------------

/// A route fallback that plays one decision and records what it was asked.
struct PlayRoute {
    decision: Mutex<Option<RouteDecision>>,
    asked: Mutex<Vec<(ErrorKind, Option<mixdog_core_api::domain::provider::Usage>)>>,
    segments: Vec<UsageSegment>,
    current: Mutex<Option<(String, String)>>,
}
impl PlayRoute {
    fn new(decision: RouteDecision, segments: Vec<UsageSegment>) -> Arc<Self> {
        Arc::new(Self { decision: Mutex::new(Some(decision)), asked: Mutex::default(), segments, current: Mutex::default() })
    }
}
#[async_trait]
impl RouteFallback for PlayRoute {
    async fn advance(&self, error: ProviderError, last_usage: Option<&mixdog_core_api::domain::provider::Usage>) -> RouteDecision {
        self.asked.lock().unwrap().push((error.kind, last_usage.cloned()));
        self.decision.lock().unwrap().take().expect("one failure, one decision")
    }
    fn usage_segments(&self, _total: &mixdog_core_api::domain::provider::Usage, current: (&str, &str)) -> Vec<UsageSegment> {
        *self.current.lock().unwrap() = Some((current.0.to_owned(), current.1.to_owned()));
        self.segments.clone()
    }
}

fn refused() -> Attempt {
    Attempt::Reject(ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted))
}

#[tokio::test]
async fn a_switch_strips_provider_replay_and_continues_on_the_next_model() {
    let mut earlier = AgentMessage::assistant("earlier answer", Vec::new());
    earlier.message.thinking_blocks = Some(json!([{ "type": "thinking", "thinking": "private", "signature": "sig" }]));
    let next = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let segments = vec![UsageSegment { provider: "a".into(), model: "m1".into(), usage: Default::default() }];
    let route = PlayRoute::new(
        RouteDecision::Switch(RouteSwitch { provider: next.clone(), model: "m2".into(), notice: "m1 refused — switched to m2.".into(), effort: None, text_only: None }),
        segments.clone(),
    );
    let mut h = Harness::new(vec![refused()]);
    h.route = Some(route.clone());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("first"), earlier, AgentMessage::user("go")])).await;
    // The next provider got the conversation without the first one's reasoning envelopes.
    let sent = next.requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(h.provider.requests().len(), 1);
    assert!(output.transcript.iter().all(|m| m.message.thinking_blocks.is_none()), "replay stripped from the live messages");
    assert!(sent[0].messages.iter().all(|m| m.thinking_blocks.is_none()), "and from the request");
    assert_eq!(output.transcript.iter().find(|m| m.text() == "earlier answer").map(|m| m.text()), Some("earlier answer".to_owned()));
    // The loop told the hop the error and the running usage (none yet), and read the segments at the end.
    assert_eq!(*route.asked.lock().unwrap(), [(ErrorKind::Auth, None)]);
    assert_eq!(output.usage_segments, segments);
    assert_eq!(route.current.lock().unwrap().as_ref().map(|c| c.1.as_str()), Some("m2"));
    let events = h.observer.events();
    assert!(events.iter().any(|e| matches!(e, RunEvent::Stage(Stage::ModelFallback { model }) if model == "m2")));
    assert!(events.iter().any(|e| matches!(e, RunEvent::Stage(Stage::Notice { message, tone: Tone::Info }) if message == "m1 refused — switched to m2.")));
}

#[tokio::test]
async fn a_surface_decision_ends_the_ask_with_the_error_it_carries() {
    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted);
    error.message = "first failed\nEvery model in the fallback chain failed — a/m1: first failed; b/m2: second failed".into();
    let route = PlayRoute::new(
        RouteDecision::Surface(Box::new(ChainSurface { error, attempts: vec![json!({ "provider": "a" })], stopped_before: None })),
        Vec::new(),
    );
    let mut h = Harness::new(vec![refused()]);
    h.route = Some(route);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the chain ran out");
    let AgentError::Provider(surfaced) = &failure.error else { panic!("{:?}", failure.error) };
    assert_eq!(surfaced.kind, ErrorKind::Auth);
    assert_eq!(failure.error.to_string(), "first failed\nEvery model in the fallback chain failed — a/m1: first failed; b/m2: second failed");
}

#[tokio::test]
async fn a_failed_hop_replaces_the_providers_error_with_its_own_text() {
    let route = PlayRoute::new(RouteDecision::Fail("Provider \"gone\" not available".into()), Vec::new());
    let mut h = Harness::new(vec![refused()]);
    h.route = Some(route);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the hop failed");
    assert!(matches!(&failure.error, AgentError::RouteFailed(text) if text == "Provider \"gone\" not available"));
    assert_eq!(failure.error.to_string(), "Provider \"gone\" not available");
}

// ---- the agent lane's slot ---------------------------------------------------------------------

/// Records what the loop sends through the slot: whether each yielded request succeeded.
#[derive(Default)]
struct Slot(Mutex<Vec<bool>>);
#[async_trait]
impl Yielder for Slot {
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, _: Option<&mixdog_agent::cancel::Cancel>) -> Result<(), String> {
        let ok = task.await;
        self.0.lock().unwrap().push(ok);
        Ok(())
    }
}

/// A slot with none free: the request ends, and the wait to take the slot back lasts until the
/// cancel it is handed fires, then reads that cancel's text (`runYielded`'s signal).
struct Cancelled(Arc<tokio::sync::Notify>);
#[async_trait]
impl Yielder for Cancelled {
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, cancel: Option<&mixdog_agent::cancel::Cancel>) -> Result<(), String> {
        task.await;
        self.0.notify_one();
        let cancel = cancel.expect("the loop hands its signal to the wait");
        cancel.cancelled().await;
        Err(cancel.reason())
    }
}

#[tokio::test]
async fn each_provider_request_runs_with_the_slot_handed_back() {
    let slot = Arc::new(Slot::default());
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.slot = Some(slot.clone());
    finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(*slot.0.lock().unwrap(), [true, true], "one yield per request, tool work outside it");
}

#[tokio::test]
async fn a_refused_request_is_reported_to_the_slot_as_failed() {
    let slot = Arc::new(Slot::default());
    let h = Harness::new(vec![refused()]);
    let mut cfg = config();
    cfg.slot = Some(slot.clone());
    let failure = h.run(cfg, vec![], vec![AgentMessage::user("go")]).run().await.expect_err("auth surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(*slot.0.lock().unwrap(), [false]);
}

#[tokio::test]
async fn a_cancelled_reacquisition_ends_the_ask_with_the_cancels_text() {
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut cfg = config();
    let waiting = Arc::new(tokio::sync::Notify::new());
    cfg.slot = Some(Arc::new(Cancelled(waiting.clone())));
    let cancel = h.cancel.clone();
    let task = tokio::spawn(h.run(cfg, vec![], vec![AgentMessage::user("go")]).run());
    // The request is done and the loop is waiting to take its slot back: only now does the turn end.
    waiting.notified().await;
    cancel.cancel();
    let failure = task.await.unwrap().expect_err("the slot was not taken back");
    assert!(matches!(&failure.error, AgentError::Admission(text) if text == mixdog_agent::cancel::ABORTED), "{:?}", failure.error);
}

/// The text of a turn cancelled while it waits to take its slot back is the reason its source
/// aborted the session's controller with (Node's provider-request signal), not a bare abort.
#[tokio::test]
async fn a_turn_cancelled_in_the_slot_wait_reads_its_sources_reason() {
    use mixdog_agent::cancel::{
        AGENT_TASK_CANCEL, CLI_ABORT, PARENT_ABORTED, abort_session_turn_reason, close_session_reason, runtime_abort_reason,
    };
    let cases = [
        ("job cancel", close_session_reason("sess_w1", AGENT_TASK_CANCEL), "Session \"sess_w1\" closed: closeSession (reason=agent-task-cancel)"),
        ("user stop", runtime_abort_reason("sess_w1", CLI_ABORT), "Session \"sess_w1\" closed: runtime abort (reason=cli-abort)"),
        ("user stop (manager)", abort_session_turn_reason("sess_w1", "user-cancel"), "Session \"sess_w1\" closed: abortSessionTurn (reason=user-cancel)"),
        ("session close", close_session_reason("sess_w1", "cli-agent-close"), "Session \"sess_w1\" closed: closeSession (reason=cli-agent-close)"),
        ("parent signal", PARENT_ABORTED.to_owned(), "parent signal aborted"),
    ];
    for (source, reason, want) in cases {
        let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let mut cfg = config();
        let waiting = Arc::new(tokio::sync::Notify::new());
        cfg.slot = Some(Arc::new(Cancelled(waiting.clone())));
        let signal = mixdog_agent::cancel::Cancel::from_token(&h.cancel);
        cfg.signal = Some(signal.clone());
        let task = tokio::spawn(h.run(cfg, vec![], vec![AgentMessage::user("go")]).run());
        waiting.notified().await;
        signal.abort(&reason);
        let failure = task.await.unwrap().expect_err("the slot was not taken back");
        assert!(matches!(&failure.error, AgentError::Admission(text) if text == want), "{source}: {:?}", failure.error);
    }
}
/// The side-question capture of each logical send: opened with the request, settled with its reply.
#[derive(Default)]
struct SideLog(Mutex<Vec<String>>);

struct SideTicket(Arc<SideLog>);

struct SideTap(Arc<SideLog>);

impl mixdog_agent::env::SendTap for SideTap {
    fn begin(&self, request: &mixdog_core_api::domain::provider::ModelRequest) -> Box<dyn mixdog_agent::env::SendTicket> {
        self.0.0.lock().unwrap().push(format!("begin:{}", request.messages.len()));
        Box::new(SideTicket(self.0.clone()))
    }
}

impl mixdog_agent::env::SendTicket for SideTicket {
    fn settle(self: Box<Self>, response: &mixdog_agent::response::ModelResponse) {
        self.0.0.lock().unwrap().push(format!("settle:{}", response.content));
    }

    fn discard(self: Box<Self>) {
        self.0.0.lock().unwrap().push("discard".to_owned());
    }
}

#[tokio::test]
async fn each_send_is_captured_with_its_request_and_settled_with_its_reply() {
    let log = Arc::new(SideLog::default());
    let mut h = Harness::new(vec![
        turn(vec![text("first"), done(StopReason::EndTurn)]),
        turn(vec![text("second"), done(StopReason::EndTurn)]),
    ]);
    h.side = Some(Arc::new(SideTap(log.clone())));
    h.steer.push(DrainStage::Terminal, "one more thing");
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(*log.0.lock().unwrap(), ["begin:1", "settle:first", "begin:3", "settle:second"]);
}
struct CountMcp(AtomicU64);

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for CountMcp {
    async fn refresh(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The session's tools as each request boundary finds them, one set per request.
struct SwapMcp(std::sync::Mutex<std::collections::VecDeque<mixdog_agent::tools::ToolSet>>);

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for SwapMcp {
    async fn refresh(&self) {}

    async fn tools(&self) -> Result<Option<mixdog_agent::tools::ToolSet>, String> {
        Ok(self.0.lock().unwrap().pop_front())
    }
}

/// `adoptDynamicToolChanges`: the second request keeps the eager `echo` it started with and adopts the changed
/// definition of the MCP tool.
#[tokio::test]
async fn a_changed_mcp_definition_reaches_the_next_request_and_an_eager_one_does_not() {
    let echo = Echo::tool();
    let described = |name: &str, description: &str| -> Arc<dyn Tool> { Arc::new(Echo(ToolSpec { name: name.into(), description: description.into(), ..echo.spec().clone() })) };
    let set = |echo_text: &str, ping_text: &str| mixdog_agent::tools::ToolSet::new(vec![described("echo", echo_text), described("mcp__srv__ping", ping_text)]);
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("done"), done(StopReason::EndTurn)]),
    ]);
    h.mcp = Some(Arc::new(SwapMcp(std::sync::Mutex::new([set("echo", "ping v1"), set("echo changed", "ping v2")].into()))));
    finish(h.run(config(), vec![echo.clone(), described("mcp__srv__ping", "ping v1")], vec![AgentMessage::user("go")])).await;
    let sent: Vec<Vec<(String, String)>> = h.provider.requests().iter().map(|r| r.tools.iter().map(|t| (t.name.clone(), t.description.clone())).collect()).collect();
    let pair = |name: &str, text: &str| (name.to_owned(), text.to_owned());
    assert_eq!(sent[0], [pair("echo", "echo"), pair("mcp__srv__ping", "ping v1")]);
    assert_eq!(sent[1], [pair("echo", "echo"), pair("mcp__srv__ping", "ping v2")]);
}

/// The deferred snapshot of the session adds a discovered catalog tool.
struct SnapshotMcp;

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for SnapshotMcp {
    async fn refresh(&self) {}

    async fn snapshot(&self, mut tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, messages: &[AgentMessage]) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        assert!(!messages.is_empty(), "the snapshot reads the transcript the request is built from");
        tools.push(mixdog_core_api::domain::provider::ToolDefinition { name: "office".into(), description: "Create a document.".into(), input_schema: json!({"type": "object"}), defer_loading: true, freeform: None });
        Ok(tools)
    }
}

/// `snapshotProviderRequestTools` runs at the request boundary: what it adds to the candidate list is sent marked
/// `defer_loading`, after the eager tools.
#[tokio::test]
async fn the_request_carries_the_deferred_snapshot() {
    let mut h = Harness::new(vec![turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.mcp = Some(Arc::new(SnapshotMcp));
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let sent: Vec<(String, bool)> = h.provider.requests()[0].tools.iter().map(|t| (t.name.clone(), t.defer_loading)).collect();
    assert_eq!(sent, [("echo".to_owned(), false), ("office".to_owned(), true)]);
}

/// What throws inside Node's `prepareProviderRequest` fails the request, with the error's own text.
struct FailingMcp;

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for FailingMcp {
    async fn refresh(&self) {}

    async fn snapshot(&self, _: Vec<mixdog_core_api::domain::provider::ToolDefinition>, _: &[AgentMessage]) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        Err("provider tool snapshot: selected tool identity mismatch".into())
    }
}

#[tokio::test]
async fn a_failed_tool_snapshot_fails_the_request() {
    let mut h = Harness::new(vec![turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.mcp = Some(Arc::new(FailingMcp));
    let failure = h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run().await.expect_err("the snapshot threw");
    assert!(matches!(&failure.error, AgentError::RequestTools(text) if text == "provider tool snapshot: selected tool identity mismatch"), "{:?}", failure.error);
    assert!(h.provider.requests().is_empty(), "nothing was sent");
}

fn system_message(text: &str) -> AgentMessage {
    use mixdog_core_api::domain::provider::{Content, Message, Role};
    AgentMessage::new(Message::new(Role::System, Content::Text(text.to_owned())))
}

/// Migrates at the first boundary only. A migration after a send settled would rewrite the prefix the loop's guard holds
/// (`request-boundary.mjs:68-76` leaves the loop's `prefixGuardState` as it is), which the guard refuses outside a compaction.
struct MigrateMcp(AtomicU64);

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for MigrateMcp {
    async fn refresh(&self) {}

    async fn migrate(&self, messages: &[AgentMessage]) -> Result<Option<Vec<AgentMessage>>, String> {
        let boundary = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert!(messages.iter().any(|m| m.role() == mixdog_core_api::domain::provider::Role::System), "the transcript the request is built from carries its system prompt");
        Ok((boundary == 0).then(|| vec![system_message("migrated rules")]))
    }
}

/// `migrateToolExposureAtBoundary` runs at every request boundary (`request-boundary.mjs:67`); a migration replaces the
/// working transcript's system prompt, and the provider state of the old surface is not sent again.
#[tokio::test]
async fn the_exposure_migration_runs_at_every_request_boundary() {
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("done"), done(StopReason::EndTurn)]),
    ]);
    let boundaries = Arc::new(MigrateMcp(AtomicU64::new(0)));
    h.mcp = Some(boundaries.clone());
    finish(h.run(config(), vec![Echo::tool()], vec![system_message("old rules"), AgentMessage::user("go")])).await;
    assert_eq!(boundaries.0.load(std::sync::atomic::Ordering::SeqCst), 2);
    let sent = h.provider.requests();
    let first_system = |request: &mixdog_core_api::domain::provider::ModelRequest| request.messages.iter().find(|m| m.role == mixdog_core_api::domain::provider::Role::System).map(|m| format!("{:?}", m.content));
    assert!(first_system(&sent[0]).unwrap().contains("migrated rules"), "the first request is built from the migrated prompt");
    assert!(first_system(&sent[1]).unwrap().contains("migrated rules"));
}

/// Node refreshes the session's MCP catalog once per request (`request-boundary.mjs:77`), at the start of
/// every tool call (`call-prep.mjs:70`) and, for an MCP call, again once its gate has passed (`tool-exec.mjs:114`):
/// two requests, one plain and one MCP call make 1 + (1) + (1 + 1) + 1.
#[tokio::test]
async fn the_mcp_catalog_is_refreshed_where_node_refreshes_it() {
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({})), call("c2", "mcp__srv__ping", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("done"), done(StopReason::EndTurn)]),
    ]);
    let counter = Arc::new(CountMcp(AtomicU64::new(0)));
    h.mcp = Some(counter.clone());
    let echo = Echo::tool();
    let ping: Arc<dyn Tool> = Arc::new(Echo(ToolSpec { name: "mcp__srv__ping".into(), ..echo.spec().clone() }));
    finish(h.run(config(), vec![echo, ping], vec![AgentMessage::user("go")])).await;
    assert_eq!(counter.0.load(std::sync::atomic::Ordering::SeqCst), 5);
}

// ---------------------------------------------------------------------------
// Text-leaked tool calls: what the loop dispatches, returns and stores, against the Node loop
// (`fixtures/agent/leaked-toolcall/record.mjs`: the real agent loop over the route's real decoder)
// ---------------------------------------------------------------------------

/// The core's real `read` tool, observed: which call ids it ran for and when each finished. The `failing` scenario's
/// forced failure (the recorder's `beforeToolExecution` throwing `boom`) replaces the run.
struct Reader {
    real: Arc<dyn Tool>,
    ran: Mutex<Vec<String>>,
    finished: tokio::sync::Semaphore,
    fail: bool,
}
#[async_trait]
impl Tool for Reader {
    fn spec(&self) -> &ToolSpec {
        self.real.spec()
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        self.ran.lock().unwrap().push(ctx.call_id.as_str().to_owned());
        let outcome = if self.fail {
            Err(ToolError::new(ToolErrorCode::Internal { incident_id: "boom".into() }, "Error: boom"))
        } else {
            self.real.call(ctx, args).await
        };
        self.finished.add_permits(1);
        outcome
    }
}

/// The recorder's sandbox: a directory holding `a.txt` (`record.mjs` `loopCwd`), and where the recorder names its root
/// in what it writes, `<ROOT>`.
async fn leak_sandbox() -> (mixdog_core_api::domain::common::AbsPath, Arc<MockFileService>) {
    use mixdog_core_api::domain::fs::{FileService, WritePrecondition, WriteRequest};
    let root = mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir().join("mixdog-leaked-toolcall").join("sandbox")).unwrap();
    let files = Arc::new(MockFileService::default());
    let tokens = mixdog_rt::testing::tokens();
    files.create_dir(tokens.durability_io, root.clone(), true).await.unwrap();
    let path = mixdog_core_api::domain::common::AbsPath::new(root.as_path().join("a.txt")).unwrap();
    files
        .write(tokens.durability_io, WriteRequest { path, content: b"hello probe\n".to_vec(), precondition: WritePrecondition::Unconditional })
        .await
        .unwrap();
    (root, files)
}

/// `rooted` of the recorder: the sandbox root, in its native and forward-slash spellings, is written `<ROOT>`.
fn rooted(text: &str, root: &mixdog_core_api::domain::common::AbsPath) -> String {
    let native = root.as_path().to_string_lossy().into_owned();
    text.replace(&native, "<ROOT>").replace(&native.replace('\\', "/"), "<ROOT>")
}

struct LeakCtx;
impl mixdog_ai::providers::openai::config::WireContext for LeakCtx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
}

/// The events Rust's decoder of `route` yields for the wire Node's decoder was fed, one unit per wire event.
fn leaked_events(route: &str, scenario: &JsonValue) -> (Vec<StreamEvent>, Option<ProviderError>) {
    use mixdog_ai::providers::openai::decoder::{Framing, ResponsesDecoder};
    let known: std::collections::HashSet<String> =
        scenario["known"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_owned()).collect();
    let wire = scenario["wire"].as_array().unwrap();
    let responses = |framing, compat: bool| {
        let decoder = ResponsesDecoder::new(framing, Arc::new(LeakCtx), ProviderId::from("openai")).with_known_tools(known.clone());
        let mut decoder = if compat { decoder.compat_events() } else { decoder };
        let units: Vec<Vec<u8>> = wire
            .iter()
            .map(|e| match framing {
                Framing::WebSocket => e.to_string().into_bytes(),
                Framing::Sse => format!("data: {e}\n\n").into_bytes(),
            })
            .collect();
        drain(&mut decoder, units)
    };
    match route {
        "responses-ws" => responses(Framing::WebSocket, false),
        "responses-sse" => responses(Framing::Sse, false),
        "responses-compat" => responses(Framing::Sse, true),
        "chat" => {
            use mixdog_ai::providers::compat::chat::ChatDecoder;
            use mixdog_ai::providers::compat::profile::{CompatProfile, CredentialKind};
            let profile = CompatProfile::plain("groq", "https://api.groq.com/v1", CredentialKind::StaticKey { reauth_on_401: false });
            // The recorder's `providerName`.
            let mut decoder = ChatDecoder::new(profile, ProviderId::from("custom")).with_known_tools(known);
            drain(&mut decoder, wire.iter().map(|e| format!("data: {e}\n\n").into_bytes()).collect())
        }
        "gemini" => {
            use mixdog_ai::providers::google::decode::{DecodeDialect, GeminiDecoder, UsageStyle};
            use mixdog_ai::providers::google::error::ErrorDialect;
            let mut decoder = GeminiDecoder::new(DecodeDialect {
                owner: ProviderId::from("gemini"),
                envelope: false,
                usage: UsageStyle::Inclusive,
                errors: ErrorDialect::gemini("Gemini REST streamGenerateContent"),
            })
            .with_known_tools(known);
            drain(&mut decoder, wire.iter().map(|e| format!("data: {e}\r\n\r\n").into_bytes()).collect())
        }
        "cursor" => {
            use mixdog_ai::providers::cursor::decoder::CursorDecoder;
            use mixdog_ai::providers::cursor::request::BlobStore;
            let mut decoder = CursorDecoder::new(BlobStore::default(), Vec::new(), None).with_known_tools(known);
            let units = wire
                .iter()
                .map(|e| {
                    let bytes: Vec<u8> = e
                        .as_str()
                        .unwrap()
                        .as_bytes()
                        .chunks(2)
                        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                        .collect();
                    mixdog_ai::providers::connect::frame::encode(&bytes, 0)
                })
                .collect();
            drain(&mut decoder, units)
        }
        "anthropic" => {
            // The decoder type is crate-private; the codec hands it out through the public `WireCodec::decoder`, with the
            // tools the request body offers.
            use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor, ModelCaps};
            use mixdog_core_api::domain::provider::{Message, RequestOptions, Role, ToolDefinition};
            let caps = |model: &str| {
                (model == "claude-sonnet-4-6").then(|| ModelCaps {
                    adaptive_thinking: true,
                    manual_thinking: false,
                    ladder_stated: false,
                    effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                    max_output_tokens: Some(16384),
                    fast_mode: false,
                    context_window: None,
                    thinking_display_updates: false,
                })
            };
            let codec = AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(Arc::new(caps)));
            let tools = known
                .iter()
                .map(|name| ToolDefinition {
                    name: name.clone(),
                    description: "read a file".into(),
                    input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
                    defer_loading: false,
                    freeform: None,
                })
                .collect();
            let request = ModelRequest {
                model: "claude-sonnet-4-6".into(),
                messages: vec![Message::new(Role::User, Content::Text("go".into()))],
                tools,
                options: RequestOptions::default(),
            };
            let mut decoder = codec.decoder(&request);
            let units = wire.iter().map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()).into_bytes()).collect();
            drain(&mut *decoder, units)
        }
        other => panic!("route {other}"),
    }
}

/// The events the decoder yields, and the failure that ended the stream (a decoder that owes events to its failure hands
/// them out first, as `DecodedStream` reads it).
fn drain(decoder: &mut dyn mixdog_core_api::domain::provider::WireDecoder, units: Vec<Vec<u8>>) -> (Vec<StreamEvent>, Option<ProviderError>) {
    let mut events = Vec::new();
    for unit in units {
        match decoder.feed(&unit) {
            Ok(more) => events.extend(more),
            Err(error) => return (events, Some(error)),
        }
    }
    match decoder.finish() {
        Ok(more) => {
            let owes_failure = !more.is_empty() && !decoder.terminal_seen();
            events.extend(more);
            if owes_failure { (events, decoder.finish().err()) } else { (events, None) }
        }
        Err(error) => (events, Some(error)),
    }
}

/// A minted id is recorded as `<prefix>_leaked_*`.
fn id_shape(id: &str) -> String {
    match id.find("_leaked_") {
        Some(at) if !id.starts_with("gemini_") => format!("{}*", &id[..at + "_leaked_".len()]),
        _ => id.to_owned(),
    }
}

/// A gate that denies every call with a fixed text.
struct DenyAll(String);
#[async_trait]
impl ToolGate for DenyAll {
    async fn check_call(&self, _call_id: &str, _call: &GateCall) -> GateDecision {
        GateDecision::Deny(self.0.clone())
    }
}

#[tokio::test]
async fn the_loop_stores_and_runs_what_node_s_loop_does_for_a_leaked_call() {
    let golden: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/leaked-toolcall/golden/leaked_toolcall.json")).unwrap();
    let mut compared = 0;
    for scenario in golden["scenarios"].as_array().unwrap() {
        let route = scenario["route"].as_str().unwrap();
        let Some(stored) = scenario.get("stored") else { continue };
        let label = format!("{route} / {}", scenario["name"]);
        let (events, failure) = leaked_events(route, scenario);
        let real_read = mixdog_tools::fs::ReadTool::new(None, None).with_state(Arc::new(mixdog_tools::fs::ReadState::new(None)));
        let reader = Arc::new(Reader {
            real: Arc::new(real_read),
            ran: Mutex::new(Vec::new()),
            finished: tokio::sync::Semaphore::new(0),
            fail: scenario["failing"] == true,
        });
        let mut steps: Vec<Step> = events.into_iter().map(Step::Event).collect();
        // A turn Node's send rejected (`normalizeCompatChatResponse`) reaches the loop as the error the decoder fails with.
        if let Some(error) = &failure {
            steps.push(Step::Fail(error.clone()));
        }
        let mut h = Harness::new(vec![turn(steps), turn(vec![text("final"), done(StopReason::EndTurn)])]);
        let (root, files) = leak_sandbox().await;
        h.sandbox = Some((root.clone(), files));
        // A denying gate answers with the text Node's PreToolUse deny produced; the tool never runs.
        let denying = scenario["denying"] == true;
        // A tool the executor does not have is answered with text too, and never runs.
        let unknown = scenario["name"].as_str().unwrap().contains("the executor does not have");
        if denying {
            let recorded = stored["early"][0]["content"].as_str().unwrap().to_owned();
            h.gate = Arc::new(DenyAll(recorded));
        }
        let tool: Arc<dyn Tool> = reader.clone();
        if let Some(want_error) = stored.get("turnError") {
            let failed = h.run(config(), vec![tool], vec![AgentMessage::user("go")]).run().await.expect_err(&label);
            let AgentError::Provider(error) = &failed.error else { panic!("{label}: not a provider error: {:?}", failed.error) };
            assert_eq!(error.message, want_error.as_str().unwrap(), "{label}: the error the turn ends with");
            assert_eq!(h.provider.requests().len() as u64, stored["sends"].as_u64().unwrap(), "{label}: the send is not retried");
            assert!(reader.ran.lock().unwrap().is_empty(), "{label}: no call ran");
            let stored_assistants = failed.transcript.iter().filter(|m| m.role() == mixdog_core_api::domain::provider::Role::Assistant).count();
            assert_eq!(stored_assistants, stored["messages"].as_array().unwrap().len(), "{label}: nothing stored for the cut turn");
            compared += 1;
            continue;
        }
        let output = finish(h.run(config(), vec![tool], vec![AgentMessage::user("go")])).await;
        // A call no listed call consumed is left to finish, as in Node: wait for every run Node saw.
        let expected = if denying || unknown { 0 } else { stored["early"].as_array().unwrap().len() };
        let _ = reader.finished.acquire_many(expected as u32).await.unwrap();

        let assistants: Vec<&AgentMessage> = output.transcript.iter().filter(|m| m.role() == mixdog_core_api::domain::provider::Role::Assistant).collect();
        let want = stored["messages"].as_array().unwrap();
        assert_eq!(assistants.len(), want.len(), "{label}: assistant messages");
        for (message, want) in assistants.iter().zip(want) {
            assert_eq!(message.text(), want["content"].as_str().unwrap(), "{label}: content");
            let got: Vec<JsonValue> = message
                .tool_calls()
                .iter()
                .map(|c| json!({"id": id_shape(&c.id), "name": c.name, "arguments": c.arguments}))
                .collect();
            assert_eq!(JsonValue::Array(got), want.get("toolCalls").cloned().unwrap_or_else(|| json!([])), "{label}: stored calls");
            // Node keeps `thinkingBlocks` on the message; Rust holds them there on a turn without a block replay and
            // inside the replay otherwise.
            if let Some(want_blocks) = want.get("thinkingBlocks") {
                let from_replay: Vec<JsonValue> = message
                    .message
                    .provider_replay()
                    .iter()
                    .filter_map(|replay| replay.items.as_array())
                    .flatten()
                    .filter(|b| matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking")))
                    .cloned()
                    .collect();
                let got_blocks = match &message.message.thinking_blocks {
                    Some(blocks) => blocks.clone(),
                    None => JsonValue::Array(from_replay),
                };
                assert_eq!(&got_blocks, want_blocks, "{label}: thinking blocks");
            }
        }
        let results: Vec<&AgentMessage> = output.transcript.iter().filter(|m| m.role() == mixdog_core_api::domain::provider::Role::Tool).collect();
        let want_results = stored["toolResults"].as_array().unwrap();
        assert_eq!(results.len(), want_results.len(), "{label}: tool results");
        // Where several calls read `a.txt`, which one the real tool answers with the file's lines and which with its dedup stub
        // (`[file unchanged`) follows the order the runs reached the file: Node ran the streamed call before the batch's, this
        // loop starts a native call as its event arrives. Those bodies are not compared (manifest); every other body is.
        let several_runs = stored["executed"].as_array().unwrap().len() > 1;
        let body_comparable = |body: &str| !several_runs || !(body.starts_with("[file unchanged") || body.starts_with("[lines 1-1]"));
        for (message, want) in results.iter().zip(want_results) {
            assert_eq!(id_shape(message.tool_call_id().unwrap()), want["toolCallId"].as_str().unwrap(), "{label}: result id");
            if body_comparable(want["content"].as_str().unwrap()) {
                assert_eq!(rooted(&message.text(), &root), want["content"].as_str().unwrap(), "{label}: result body");
            }
        }
        // The UI's early notices (`__earlyNotify`): one per call that ran a tool, whichever path started it, whether or not
        // any listed call consumed it; sent the instant the call settles, so wait for every one Node sent.
        let want_early = stored["early"].as_array().unwrap();
        let early = || -> Vec<(String, String, bool)> {
            h.observer
                .events()
                .into_iter()
                .filter_map(|event| match event {
                    RunEvent::EarlyResult(message) => {
                        Some((id_shape(message.tool_call_id().unwrap_or_default()), rooted(&message.text(), &root), message.tool_kind == Some(ToolKind::Error)))
                    }
                    _ => None,
                })
                .collect()
        };
        while early().len() < want_early.len() {
            let arrived = tokio::time::timeout(Duration::from_secs(30), h.observer.early_arrived.notified()).await;
            assert!(arrived.is_ok(), "{label}: waited 30 s for early notice {} of {}", early().len() + 1, want_early.len());
        }
        let mut got_early = early();
        got_early.sort();
        let mut want_early_sorted: Vec<(String, bool)> =
            want_early.iter().map(|e| (e["toolCallId"].as_str().unwrap().to_owned(), e["isError"].as_bool().unwrap())).collect();
        want_early_sorted.sort();
        assert_eq!(got_early.iter().map(|(id, _, err)| (id.clone(), *err)).collect::<Vec<_>>(), want_early_sorted, "{label}: early notices");
        if scenario["failing"] == true {
            // A failed run still tells the UI, with the executor's own text (one `Error: ` prefix, as recorded).
            for (_, content, is_error) in &got_early {
                assert!(*is_error, "{label}: early notice is an error");
                assert_eq!(content, want_early[0]["content"].as_str().unwrap(), "{label}: early notice text");
            }
            for (message, want) in results.iter().zip(want_results) {
                assert_eq!(message.text(), want["content"].as_str().unwrap(), "{label}: stored error text");
            }
        }
        if denying || unknown {
            // Node returns a gate denial (or the unknown-tool text) as text: its early notice is a normal result carrying the denial.
            for (_, content, is_error) in &got_early {
                assert!(!*is_error, "{label}: a returned text is not an error notice");
                assert_eq!(content, want_early[0]["content"].as_str().unwrap(), "{label}: denial text");
            }
            for (message, want) in results.iter().zip(want_results) {
                assert_eq!(message.text(), want["content"].as_str().unwrap(), "{label}: stored denial text");
            }
        }
        // Minted ids share one shape, so the bodies are compared per id as sorted lists.
        let mut early_ids: Vec<&str> = want_early.iter().map(|e| e["toolCallId"].as_str().unwrap()).collect();
        early_ids.dedup();
        for id in early_ids {
            let mut want_bodies: Vec<&str> = want_early.iter().filter(|e| e["toolCallId"] == id).map(|e| e["content"].as_str().unwrap()).collect();
            let mut got_bodies: Vec<&str> = got_early.iter().filter(|(got_id, _, _)| got_id == id).map(|(_, body, _)| body.as_str()).collect();
            want_bodies.sort();
            got_bodies.sort();
            if want_bodies.iter().all(|body| body_comparable(body)) {
                assert_eq!(got_bodies, want_bodies, "{label}: early notice bodies of {id}");
            }
        }
        let mut ran: Vec<String> = reader.ran.lock().unwrap().iter().map(|id| id_shape(id)).collect();
        ran.sort();
        ran.dedup();
        let want_ran: Vec<String> = stored["executed"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
        if !(denying || unknown) {
            assert_eq!(ran, want_ran, "{label}: the ids a tool ran for");
        }
        compared += 1;
    }
    assert!(compared > 100, "scenarios compared: {compared}");
}
/// The request snapshot builds its request with `assemble_request`, the function the loop's own send builds through
/// (`Run::build_request`): for a model with a tail reminder the two are the same request, reminder included.
#[tokio::test]
async fn the_request_a_run_sends_is_what_the_shared_assembly_gives_for_a_model_with_a_reminder() {
    let tail_context = || mixdog_agent::tail_rules::TailContext {
        provider: "anthropic-oauth".into(),
        language: Some(mixdog_agent::tail_rules::TailLanguage { id: "ko".into(), name: "Korean".into() }),
        role: mixdog_agent::tail_rules::TailRole::Lead,
    };
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]).with_tail(tail_context());
    let mut cfg = config();
    cfg.model = "claude-opus-5-5".into();
    let messages = vec![AgentMessage::user("hi")];
    let run = h.run(cfg.clone(), vec![Echo::tool()], messages.clone());
    finish(run).await;
    let sent = h.provider.requests()[0].clone();
    let tail = mixdog_agent::tail_rules::RuleTailReminder { context: tail_context() };
    let (assembled, reminder) = mixdog_agent::assemble_request(
        &cfg.model,
        sent.options.clone(),
        mixdog_agent::project::project_for_wire(&messages),
        Some(&tail),
        ToolSet::with_builtins(vec![Echo::tool()], vec!["echo".into()]).definitions(),
    );
    assert_eq!(reminder.as_deref(), Some("<system-reminder>Write all user-facing text in Korean.</system-reminder>"));
    assert_eq!(format!("{:?}", sent.messages), format!("{:?}", assembled.messages), "the sent messages, tail reminder last");
    assert_eq!(format!("{:?}", sent.tools), format!("{:?}", assembled.tools));
    assert_eq!(sent.model, assembled.model);
}

/// A gate whose surface refuses `blocked` before any call is dispatched.
struct BlockedSurface;
#[async_trait]
impl ToolGate for BlockedSurface {
    async fn check_call(&self, _call_id: &str, _call: &GateCall) -> GateDecision {
        GateDecision::Allow
    }
    fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
        (call.name == "blocked").then(|| "Error: tool \"blocked\" is not available in this session.".to_owned())
    }
}

/// Three refused calls leave the fourth waiting on outcomes that are only recorded after the decision pass; it is
/// decided again once they are, instead of the batch ending without its result.
#[tokio::test]
async fn a_call_waiting_on_refused_earlier_calls_is_decided_again_and_runs() {
    let mut h = Harness::new(vec![
        turn(vec![
            call("c1", "blocked", json!({"n": 1})),
            call("c2", "blocked", json!({"n": 2})),
            call("c3", "blocked", json!({"n": 3})),
            call("c4", "echo", json!({"n": 4})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.gate = Arc::new(BlockedSurface);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let refusal = "Error: tool \"blocked\" is not available in this session.";
    assert_eq!(
        dump(&output.transcript)[2..],
        [
            format!("tool#c1(Error):{refusal}"),
            format!("tool#c2(Error):{refusal}"),
            format!("tool#c3(Error):{refusal}"),
            "tool#c4(Normal):echo:{\"n\":4}".to_owned(),
        ]
    );
}

/// Answers `Error: …` as a normal return, as the delegated-agent and skill tools do.
struct ErrorText(ToolSpec);
#[async_trait]
impl Tool for ErrorText {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text("Error: agent: unknown type \"x\"".into())], ..ToolOutput::default() })
    }
}

/// The failure log gets the executed calls that ended as an error: a tool that failed, a tool that returned `Error: …`
/// text; not a call that returned normally, and not a call the surface refused before dispatch.
#[tokio::test]
async fn the_failure_log_gets_the_executed_calls_that_ended_as_errors() {
    let mut h = Harness::new(vec![
        turn(vec![
            call("c1", "boom", json!({})),
            call("c2", "echo", json!({"n": 2})),
            call("c3", "agent", json!({})),
            call("c4", "blocked", json!({})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.gate = Arc::new(BlockedSurface);
    let log = Arc::new(FailureLog::default());
    h.failures = Some(log.clone());
    let mut agent = Echo(Echo::tool().spec().clone());
    agent.0.name = "agent".into();
    finish(h.run(config(), vec![Boom::tool(), Echo::tool(), Arc::new(ErrorText(agent.0))], vec![AgentMessage::user("go")])).await;
    let seen: Vec<(String, String)> = log.0.lock().unwrap().iter().map(|c| (c.tool_name.clone(), c.result_text.clone())).collect();
    assert_eq!(
        seen,
        [("boom".to_owned(), "Error: boom".to_owned()), ("agent".to_owned(), "Error: agent: unknown type \"x\"".to_owned())]
    );
}

/// Answers `Error: ` and 100,000 more characters as a normal return.
struct LongErrorText(ToolSpec);
#[async_trait]
impl Tool for LongErrorText {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("Error: {}", "x".repeat(100_000)))], ..ToolOutput::default() })
    }
}

/// An artifact store whose writes land.
struct Persisting;
#[async_trait]
impl mixdog_agent::offload::ArtifactStore for Persisting {
    async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        self.preview(content).await
    }
    async fn preview(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        Some(mixdog_agent::offload::Artifact { display_path: "/art/x.txt".into(), path: "/art/x.txt".into(), lines: content.split('\n').count(), sha256: "ab".repeat(32) })
    }
}

/// A returned error is an error call by the tool's own return (`execute-call.mjs:17-20`), so the offload that replaces its
/// text with a pointer does not take its failure row away: the row holds the offloaded result the transcript holds
/// (`finalize.mjs:238`), and the transcript keeps the error kind. The Node recording of this case is the tool-failures
/// scenario "a returned error that is offloaded".
#[tokio::test]
async fn an_offloaded_returned_error_keeps_its_failure_row() {
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "big", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let log = Arc::new(FailureLog::default());
    h.failures = Some(log.clone());
    h.artifacts = Some(Arc::new(Persisting));
    let mut big = Echo(Echo::tool().spec().clone());
    big.0.name = "big".into();
    let output = finish(h.run(config(), vec![Arc::new(LongErrorText(big.0))], vec![AgentMessage::user("go")])).await;
    let result = &output.transcript[2];
    assert!(result.text().starts_with("[tool output offloaded: big → /art/x.txt"), "{}", result.text());
    assert_eq!(result.tool_kind, Some(ToolKind::Error));
    let seen: Vec<String> = log.0.lock().unwrap().iter().map(|c| c.result_text.clone()).collect();
    assert_eq!(seen, [result.text()]);
}

/// Every step of a call's post-processing as one sequence: its failure row and its cache write.
#[derive(Default)]
struct Steps(Mutex<Vec<String>>);
impl mixdog_agent::env::ToolFailureLog for Steps {
    fn failed(&self, call: mixdog_agent::env::FailedCall) {
        self.0.lock().unwrap().push(format!("failed {}", call.tool_name));
    }
    fn stall_abort(&self, _ctx: serde_json::Map<String, serde_json::Value>) {
        panic!("the agent loop never records a watchdog stop");
    }
}
#[async_trait]
impl ResultReuse for Steps {
    async fn lookup(&self, _call: &ToolCall, _touch: bool) -> Option<Reused> {
        None
    }
    async fn store(&self, call: &ToolCall, _content: &str, _tool_use_id: &str, _output: &ToolOutput) {
        self.0.lock().unwrap().push(format!("stored {}", call.id));
    }
    async fn after_call(&self, _call: &ToolCall, _failed: bool) {}
}

/// `postProcessCompleted` (`finalize.mjs:170-177`) runs per call in call order: a call's failure row and its cache write
/// come before the next call's, and an error call is not cached (`writeCaches` takes only a normal result, `:262-266`).
#[tokio::test]
async fn each_calls_failure_row_and_cache_write_come_in_call_order() {
    let mut h = Harness::new(vec![
        turn(vec![
            call("c1", "echo", json!({"n": 1})),
            call("c2", "agent", json!({})),
            call("c3", "echo", json!({"n": 3})),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let steps = Arc::new(Steps::default());
    h.reuse = Some(steps.clone());
    h.failures = Some(steps.clone());
    let mut agent = Echo(Echo::tool().spec().clone());
    agent.0.name = "agent".into();
    finish(h.run(config(), vec![Echo::tool(), Arc::new(ErrorText(agent.0))], vec![AgentMessage::user("go")])).await;
    assert_eq!(*steps.0.lock().unwrap(), ["stored c1", "failed agent", "stored c3"]);
}

/// A call whose arguments the provider could not parse is answered with the retry notice and never dispatched.
#[tokio::test]
async fn a_call_with_unparseable_arguments_is_answered_with_the_retry_notice_and_not_run() {
    let h = Harness::new(vec![
        turn(vec![
            call(
                "c1",
                "echo",
                json!({"__invalidToolArgs": true, "__rawArguments": "{\"a\":", "__parseError": "Unexpected end of JSON input"}),
            ),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(
        dump(&output.transcript)[2],
        "tool#c1(Error):The arguments provided to `echo` are invalid JSON and could not be parsed: Unexpected end of JSON input. Re-issue this tool call with valid JSON arguments."
    );
}

/// The switch tool of a batch: it lands the Project switch only once told to, then says it has.
struct SwitchTool {
    spec: ToolSpec,
    live: Arc<Mutex<mixdog_core_api::domain::common::AbsPath>>,
    go: Arc<tokio::sync::Notify>,
    landed: tokio::sync::watch::Sender<bool>,
}
#[async_trait]
impl Tool for SwitchTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        self.go.notified().await;
        *self.live.lock().unwrap() = mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir().join("b")).unwrap();
        self.landed.send_replace(true);
        Ok(ToolOutput { parts: vec![ToolPart::Text("switched".into())], ..ToolOutput::default() })
    }
}

/// Names the folder it ran in.
struct WhereTool(ToolSpec, Arc<Mutex<Vec<std::path::PathBuf>>>);
#[async_trait]
impl Tool for WhereTool {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        self.1.lock().unwrap().push(ctx.cwd.as_path().to_path_buf());
        Ok(ToolOutput { parts: vec![ToolPart::Text("here".into())], ..ToolOutput::default() })
    }
}

/// The reuse lookup of the second call's admission lets the first call's switch land, and does not answer before it has.
struct LandsTheSwitch {
    go: Arc<tokio::sync::Notify>,
    landed: tokio::sync::watch::Receiver<bool>,
}
#[async_trait]
impl ResultReuse for LandsTheSwitch {
    async fn lookup(&self, _call: &ToolCall, touch: bool) -> Option<Reused> {
        if !touch {
            self.go.notify_one();
            let _ = self.landed.clone().wait_for(|landed| *landed).await;
        }
        None
    }
    async fn store(&self, _call: &ToolCall, _content: &str, _tool_use_id: &str, _output: &ToolOutput) {}
    async fn after_call(&self, _call: &ToolCall, _failed: bool) {}
}

/// Node starts the calls of a batch in order (`startEagerRun`) and prepares each from the folder the session holds as it starts,
/// before the `session` call's own steps have let its switch land (recorded: `switch-project-turn-cases`, "the switch and the
/// file are one batch"). A call that follows the switch in its batch therefore runs in the folder the batch began in, even when
/// the switch lands while that call's admission is still awaiting.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_after_a_switch_in_one_batch_runs_in_the_folder_the_batch_began_in() {
    let a = mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir().join("a")).unwrap();
    let live = Arc::new(Mutex::new(a.clone()));
    let (go, (landed_tx, landed_rx)) = (Arc::new(tokio::sync::Notify::new()), tokio::sync::watch::channel(false));
    let mut switch_spec = Echo::tool().spec().clone();
    switch_spec.name = "switch".into();
    switch_spec.annotations = ToolAnnotations::default();
    let mut probe_spec = Echo::tool().spec().clone();
    probe_spec.name = "probe".into();
    let ran = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "switch", json!({})), call("c2", "probe", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.reuse = Some(Arc::new(LandsTheSwitch { go: go.clone(), landed: landed_rx }));
    let mut cfg = config();
    cfg.live_cwd = Some(Arc::new({
        let live = live.clone();
        move || Some(live.lock().unwrap().clone())
    }));
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(SwitchTool { spec: switch_spec, live: live.clone(), go, landed: landed_tx }), Arc::new(WhereTool(probe_spec, ran.clone()))];
    finish(h.run(cfg, tools, vec![AgentMessage::user("go")])).await;
    assert_eq!(*ran.lock().unwrap(), [a.as_path().to_path_buf()]);
}
