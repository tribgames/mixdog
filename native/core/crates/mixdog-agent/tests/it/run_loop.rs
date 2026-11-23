// Tests are not lane code.
#![allow(clippy::disallowed_methods)]
//! Tests of the run loop and one-shot calls using a scripted provider.

use std::collections::VecDeque;
use std::path::Path;
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
use mixdog_core_api::domain::tool::FollowUpMessage;
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

#[path = "stream_cut_cases.rs"]
mod stream_cut_cases;

#[path = "stream_cut_burst_cases.rs"]
mod stream_cut_burst_cases;

#[path = "loop_behaviours.rs"]
mod loop_behaviours;

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

enum Step {
    Event(StreamEvent),
    Fail(ProviderError),
    Hang,
    /// The open stream raises a stage the way an adapter does from inside `next` (a resumed WebSocket's retry): a name and
    /// its payload.
    Raise(&'static str, Option<serde_json::Value>),
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
struct ScriptedStream(
    VecDeque<Step>,
    Option<Arc<dyn Fn() + Send + Sync>>,
    Arc<std::sync::atomic::AtomicU64>,
    Option<mixdog_core_api::domain::provider::SendIdentity>,
);

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
                Some(Step::Raise(stage, payload)) => {
                    let identity = self.3.as_ref().expect("a stream that raises stages is built with its send identity");
                    match payload {
                        Some(payload) => identity.raise_stage_with(stage, payload),
                        None => identity.raise_stage(stage),
                    }
                    tokio::task::yield_now().await;
                    continue;
                }
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
    /// Display stages with a payload the attempt raises from inside itself.
    raised: Mutex<Vec<(&'static str, serde_json::Value)>>,
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
            raised: Mutex::new(Vec::new()),
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
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if self.raises_requesting {
            request.options.send_identity.raise_requesting_once();
            let held = self.hold.lock().unwrap().take();
            if let Some(seen) = held {
                let seen = tokio::time::timeout(Duration::from_secs(30), seen).await;
                assert!(seen.is_ok(), "the attempt waited 30 s for the run to be told `requesting` while it still held the response");
            }
        }
        for (stage, payload) in std::mem::take(&mut *self.raised.lock().unwrap()) {
            request.options.send_identity.raise_stage_with(stage, payload);
        }
        if let Some(log) = &self.order {
            let messages =
                request.messages.iter().map(|m| (wire_role(&AgentMessage::new(m.clone())).to_owned(), AgentMessage::new(m.clone()).text())).collect();
            log.0.lock().unwrap().push((false, messages));
        }
        let identity = request.options.send_identity.clone();
        self.requests.lock().unwrap().push(request);
        match self.script.lock().unwrap().pop_front() {
            Some(Attempt::Stream(steps)) => Ok(Box::new(ScriptedStream(steps.into(), None, self.calls_handed.clone(), Some(identity)))),
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
    Step::Event(StreamEvent::ToolCallDone(ToolCall { id: id.into(), name: name.into(), arguments: args, native_type: None }))
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
                originals_missing: 0,
                transcript_meta: None,
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
        let (taken, kept): (Vec<_>, Vec<_>) = queue.drain(..).partition(|(stage, _)| *stage == request.stage);
        *queue = kept;
        taken.into_iter().map(|(_, entry)| entry).collect()
    }
}

struct Observer {
    events: Mutex<Vec<RunEvent>>,
    retract: Retracted,
    reset_channel: bool,
    /// Told when the first `requesting` stage arrives.
    requesting: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Holds a permit once an early notice has arrived since the last wait.
    early_arrived: tokio::sync::Notify,
    /// The calls whose settlement was told as that of a run the batch does not take the result of.
    superseded: Mutex<Vec<String>>,
    /// What the batch said of the result to keep for a call it ran again: the call and the result's text.
    replaced: Mutex<Vec<(String, Option<String>)>>,
}
impl Observer {
    fn new(retract: Retracted) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
            retract,
            reset_channel: true,
            requesting: Mutex::new(None),
            early_arrived: tokio::sync::Notify::new(),
            superseded: Mutex::default(),
            replaced: Mutex::default(),
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
    fn early_result_superseded(&self, _generation: u64, message: AgentMessage) {
        self.superseded.lock().unwrap().extend(message.tool_call_id().map(str::to_owned));
        self.event(RunEvent::EarlyResult(message));
    }
    fn early_result_replaced(&self, _generation: u64, call_id: &str, result: Option<AgentMessage>) {
        self.replaced.lock().unwrap().push((call_id.to_owned(), result.map(|message| message.text())));
    }
    fn can_retract(&self) -> bool {
        self.reset_channel
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
    /// The save of every rewrite fails.
    unstored: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl TranscriptSink for Sink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, mixdog_agent::env::CommitError> {
        if self.refused.load(Ordering::Relaxed) {
            return Err(mixdog_agent::env::CommitError::StoreUnavailable(mixdog_agent::compact::blob_reads::StoreUnavailable(
                mixdog_agent::compact::blob_reads::LaneFault::ShutDown,
            )));
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
    async fn replaced(&self) -> bool {
        !self.unstored.load(Ordering::Relaxed)
    }
}

/// Estimates 100 tokens per message; compaction keeps a summary and the tail.
#[derive(Default)]
struct Compactor100 {
    requests: Mutex<Vec<(usize, CompactTrigger)>>,
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
    /// The pass wrote a summary that took this long; its answer reported no usage.
    summary_ms: Option<f64>,
    /// The usage the pass's summary sender reported, and whether that sender's input leaves the cache out.
    summary_usage: Option<(mixdog_core_api::domain::provider::Usage, bool)>,
    /// The session's provider reading of every request.
    session_reading: Option<u64>,
    /// The session's header carries `contextPressureUnanchoredAfterRestart`, whatever the run sends.
    session_unanchored: bool,
    /// The session's header carries `compaction.singleShotConsumed`.
    session_single_shot_consumed: bool,
    /// The session's last actual prompt size and the transcript length its anchor covers.
    session_last_reading: Option<(u64, usize)>,
    /// The pass keeps the transcript's system messages ahead of its summary, as the product's does.
    keeps_system: bool,
}
#[async_trait]
impl Compactor for Compactor100 {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        messages.len() as u64 * 100
    }
    async fn session_pressure(&self, _: &[AgentMessage], _: &[mixdog_core_api::domain::provider::ToolDefinition]) -> SessionPressure {
        SessionPressure {
            tokens: self.session_reading,
            unanchored: self.session_unanchored,
            single_shot_consumed: self.session_single_shot_consumed,
            reading: self.session_last_reading.map(|(tokens, _)| tokens),
            reading_count: self.session_last_reading.map(|(_, count)| count),
        }
    }
    async fn preflight_attachments(&self, messages: &[AgentMessage]) -> Option<mixdog_agent::compact::fresh::Preflight> {
        let attached = Content::Text("attached".into());
        if !self.preflight || !messages.iter().any(|m| m.message.content == attached) {
            return None;
        }
        let next = messages.iter().map(|m| if m.message.content == attached { AgentMessage::user("referenced") } else { m.clone() }).collect();
        Some(mixdog_agent::compact::fresh::Preflight { messages: next, referenced_messages: 1, inline_tokens_before: 1, budget_tokens: 0 })
    }
    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        request.messages.len() > 2
    }
    fn request_media(&self, _: &[AgentMessage]) -> bool {
        self.request_media
    }
    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.requests.lock().unwrap().push((request.messages.len(), request.trigger.clone()));
        if let Some((clock, ms)) = &self.takes {
            clock.0.fetch_add(*ms, Ordering::Relaxed);
        }
        if self.fail {
            return Err(CompactError::Failed("boom".into()));
        }
        let system = request.messages.iter().take_while(|m| self.keeps_system && m.role() == mixdog_core_api::domain::provider::Role::System);
        let mut kept: Vec<AgentMessage> = system.cloned().collect();
        kept.push(AgentMessage::user("[summary]"));
        kept.push(request.messages.last().unwrap().clone());
        Ok(CompactOutput {
            messages: kept,
            usage: self.summary_usage.as_ref().map(|(usage, _)| usage.clone()),
            input_excludes_cache: self.summary_usage.as_ref().is_some_and(|(_, excludes)| *excludes),
            dropped_count: (request.messages.len() - 1) as u64,
            dropped: Some(Dropped { message_ids: vec!["gone".into()], call_ids: vec!["call-gone".into()] }),
            skipped: self.skip,
            pipeline_ms: 0.0,
            summary_ms: self.summary_ms,
            summary_route: None,
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
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
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
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("echo:{args}"))], ..ToolOutput::default() })
    }
}

/// `echo` whose result carries `meta.complete`, as `code_graph` marks a partial answer.
struct Marked(bool, bool);
#[async_trait]
impl Tool for Marked {
    fn spec(&self) -> &ToolSpec {
        static SPEC: std::sync::OnceLock<ToolSpec> = std::sync::OnceLock::new();
        SPEC.get_or_init(|| Echo::tool().spec().clone())
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput {
            parts: if self.1 {
                vec![ToolPart::Text("body".into()), ToolPart::Document { mime: "application/pdf".into(), data: vec![1] }]
            } else {
                vec![ToolPart::Text("body".into())]
            },
            meta: Some(json!({ "complete": self.0 })),
            ..ToolOutput::default()
        })
    }
}

/// Records what the loop admits to the tool-result cache.
#[derive(Default)]
struct Stored(Arc<Mutex<Vec<String>>>);
#[async_trait]
impl ResultReuse for Stored {
    async fn lookup(&self, _call: &ToolCall, _cwd: &Path, _touch: bool) -> Option<Reused> {
        None
    }
    async fn prepare(&self, _call: &ToolCall, _cwd: &Path) -> Option<Box<dyn ReuseWrite>> {
        Some(Box::new(Stored(self.0.clone())))
    }
}
#[async_trait]
impl ReuseWrite for Stored {
    async fn store(self: Box<Self>, content: &str, _output: &ToolOutput) {
        self.0.lock().unwrap().push(content.to_owned());
    }
}

#[tokio::test]
async fn cache_admission_keeps_text_but_not_partial_or_structured_results() {
    for (complete, rich, stored) in [(true, false, vec!["body"]), (false, false, vec![]), (true, true, vec![])] {
        let reuse = Arc::new(Stored::default());
        let mut h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        h.reuse = Some(reuse.clone());
        finish(h.run(config(), vec![Arc::new(Marked(complete, rich))], vec![AgentMessage::user("go")])).await;
        assert_eq!(*reuse.0.lock().unwrap(), stored, "complete = {complete}, rich = {rich}");
    }
}

#[derive(Default)]
struct WarmResults {
    lookups: std::sync::atomic::AtomicUsize,
    pointer: bool,
}
#[async_trait]
impl ResultReuse for WarmResults {
    async fn has_candidate(&self, call: &ToolCall, _cwd: &Path) -> bool {
        matches!(call.name.as_str(), "read" | "list")
    }
    async fn lookup(&self, call: &ToolCall, _cwd: &Path, _touch: bool) -> Option<Reused> {
        let (kind, content) = match call.name.as_str() {
            "read" if self.pointer => (ReuseKind::Read, "[tool output offloaded: read → /art/r.txt (29 KB, 1 lines)]\npreview"),
            "read" => (ReuseKind::Read, "source body"),
            "list" => (ReuseKind::Scoped, "listing body"),
            _ => return None,
        };
        self.lookups.fetch_add(1, Ordering::SeqCst);
        Some(Reused { kind, content: content.into(), first_tool_use_id: format!("prior-{}", call.name), explicit_success: false })
    }
}

#[derive(Default)]
struct ReuseEvents(Mutex<Vec<String>>);
impl ToolFailureLog for ReuseEvents {
    fn failed(&self, call: FailedCall) {
        panic!("unexpected failure: {}", call.tool_name);
    }
    fn stall_abort(&self, _: serde_json::Map<String, JsonValue>) {}
    fn tool(&self, call: TracedCall) {
        assert!(call.tool_args.is_null() && call.result.is_null());
        assert!(call.execution_intervals.is_empty());
        self.0.lock().unwrap().push(format!("{} {}", call.tool_call_id, call.result_kind));
    }
}

#[tokio::test]
async fn the_loop_keeps_recoverable_bodies_and_traces_cross_turn_scoped_hits() {
    let mut h = Harness::new(vec![
        turn(vec![call("r", "read", json!({"path": "a"})), call("l", "list", json!({"path": "."})), done(StopReason::ToolUse)]),
        turn(vec![call("again", "list", json!({"path": "."})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.reuse = Some(Arc::new(WarmResults::default()));
    let trace = Arc::new(ReuseEvents::default());
    h.failures = Some(trace.clone());
    let named = |name: &str| -> Arc<dyn Tool> {
        let mut spec = Echo::tool().spec().clone();
        spec.name = name.into();
        Arc::new(Echo(spec))
    };
    let out = finish(h.run(config(), vec![named("read"), named("list")], vec![AgentMessage::user("go")])).await;
    let rows = dump(&out.transcript);
    assert!(rows.iter().any(|row| row == "tool#r(CacheHit):source body"));
    assert!(rows.iter().any(|row| row == "tool#l(CacheHit):listing body"));
    assert!(rows.iter().any(|row| row == "tool#again(CacheHit):listing body"));
    let requests = h.provider.requests();
    let live = |id: &str| requests[1].messages.iter().find(|m| m.tool_call_id.as_deref() == Some(id)).unwrap();
    let result = out.transcript.iter().find(|m| m.tool_call_id() == Some("l")).unwrap();
    let stored = mixdog_agent::message_row::row_of(result);
    let replayed = mixdog_agent::message_row::message_of(&stored).unwrap();
    assert_eq!(stored["content"], "listing body", "recovery keeps the complete hit");
    let source = live("l").scoped_cache_source.as_ref().unwrap();
    assert_eq!(source.call_id, "prior-list");
    assert_eq!(replayed.wire().scoped_cache_source.as_ref(), Some(source));
    assert!(live("r").scoped_cache_source.is_none(), "explicit reads still deliver their body");
    assert_eq!(*trace.0.lock().unwrap(), ["r cache-hit", "l scoped-cache-hit", "again scoped-cache-hit"]);
}

struct RewriteWarmRead;

#[async_trait]
impl ToolGate for RewriteWarmRead {
    async fn check_call(&self, _: &str, call: &GateCall) -> GateDecision {
        let mut rewritten = call.clone();
        rewritten.args = json!({"path": "other.txt"});
        GateDecision::Rewrite(rewritten)
    }
}

#[tokio::test]
async fn warm_results_cannot_bypass_policy_rewrites_or_denied_approval() {
    let run = |gate: Arc<dyn ToolGate>| {
        let mut h = Harness::new(vec![
            turn(vec![call("read-it", "read", json!({"path": "a.txt"})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        let reuse = Arc::new(WarmResults::default());
        h.reuse = Some(reuse.clone());
        h.gate = gate;
        let mut spec = Echo::tool().spec().clone();
        spec.name = "read".into();
        (h, Arc::new(Echo(spec)) as Arc<dyn Tool>, reuse)
    };
    let (h, tool, reuse) = run(Arc::new(RewriteWarmRead));
    let out = finish(h.run(config(), vec![tool], vec![AgentMessage::user("go")])).await;
    assert!(dump(&out.transcript).iter().any(|r| r == r#"tool#read-it(Normal):echo:{"path":"other.txt"}"#));
    assert_eq!(reuse.lookups.load(Ordering::SeqCst), 0, "rewritten calls never validate the original");

    for approved in [false, true] {
        let (h, tool, reuse) = run(Arc::new(AskFirst));
        h.approvals.script.lock().unwrap().push_back(ApprovalResolution::Decided {
            decision: ToolApprovalDecision {
                approved,
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
        let out = finish(h.run(config(), vec![tool], vec![AgentMessage::user("go")])).await;
        assert_eq!(h.approvals.asks.lock().unwrap().len(), 1);
        assert_eq!(reuse.lookups.load(Ordering::SeqCst), usize::from(approved));
        let rows = dump(&out.transcript);
        if approved {
            assert!(rows.iter().any(|r| r == "tool#read-it(CacheHit):source body"));
        } else {
            assert!(rows.iter().any(|r| r.starts_with("tool#read-it(Error):Error: tool \"read\" was not approved: Not now.")));
        }
    }
}

#[derive(Default)]
struct RefuseRead(Mutex<Vec<String>>);
#[async_trait]
impl ToolHooks for RefuseRead {
    async fn after_tool(&self, _: &str, _: &GateCall, body: &str) -> Option<String> {
        self.0.lock().unwrap().push(body.to_owned());
        Some("Error: permission denied by the post-tool hook".into())
    }
}

#[tokio::test]
async fn post_tool_refusals_have_the_fresh_error_status_and_hooks_never_receive_previews() {
    for (reuse, full_body) in [
        (None, r#"echo:{"path":"a"}"#),
        (Some(WarmResults::default()), "source body"),
        (Some(WarmResults { pointer: true, ..WarmResults::default() }), r#"echo:{"path":"a"}"#),
    ] {
        let mut h = Harness::new(vec![
            turn(vec![call("r", "read", json!({"path": "a"})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        h.reuse = reuse.map(|reuse| Arc::new(reuse) as Arc<dyn ResultReuse>);
        let hooks = Arc::new(RefuseRead::default());
        h.hooks = Some(hooks.clone());
        let mut spec = Echo::tool().spec().clone();
        spec.name = "read".into();
        let out = finish(h.run(config(), vec![Arc::new(Echo(spec))], vec![AgentMessage::user("go")])).await;
        assert_eq!(*hooks.0.lock().unwrap(), [full_body]);
        let result = out.transcript.iter().find(|m| m.tool_call_id() == Some("r")).unwrap();
        assert_eq!(result.tool_kind, Some(ToolKind::Error));
        let requests = h.provider.requests();
        let sent = requests[1].messages.iter().find(|m| m.tool_call_id.as_deref() == Some("r")).unwrap();
        assert!(sent.is_error);
    }
}

struct OrderedWorkspace {
    changed: std::sync::atomic::AtomicBool,
    allow_change: tokio::sync::Notify,
    lookups: Mutex<Vec<bool>>,
}

#[async_trait]
impl ResultReuse for OrderedWorkspace {
    async fn lookup(&self, call: &ToolCall, _cwd: &Path, _touch: bool) -> Option<Reused> {
        if call.name == "list" {
            self.lookups.lock().unwrap().push(self.changed.load(Ordering::Acquire));
        }
        None
    }
}

struct WorkspaceTool(ToolSpec, Arc<OrderedWorkspace>);
#[async_trait]
impl Tool for WorkspaceTool {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
        let body = if self.0.name == "shell" {
            self.1.allow_change.notified().await;
            self.1.changed.store(true, Ordering::Release);
            "wrote files"
        } else if self.1.changed.load(Ordering::Acquire) {
            "after the write"
        } else {
            "before the write"
        };
        Ok(ToolOutput { parts: vec![ToolPart::Text(body.into())], ..ToolOutput::default() })
    }
}

#[tokio::test]
async fn a_scoped_call_after_a_streamed_shell_waits_for_the_mutation_before_lookup_and_execution() {
    let workspace = Arc::new(OrderedWorkspace { changed: false.into(), allow_change: tokio::sync::Notify::new(), lookups: Mutex::new(Vec::new()) });
    let release = workspace.clone();
    let mut h = Harness::new(vec![
        turn(vec![
            call("w", "shell", json!({"command": "change files"})),
            call("l", "list", json!({})),
            Step::Wire(
                Box::pin(async move {
                    release.allow_change.notify_one();
                }),
                "release the write after streaming both calls",
            ),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.reuse = Some(workspace.clone());
    let mut shell = Echo::tool().spec().clone();
    shell.name = "shell".into();
    shell.annotations = ToolAnnotations::default();
    let mut list = Echo::tool().spec().clone();
    list.name = "list".into();
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(WorkspaceTool(shell, workspace.clone())), Arc::new(WorkspaceTool(list, workspace.clone()))];
    let out = finish(h.run(config(), tools, vec![AgentMessage::user("go")])).await;
    assert!(dump(&out.transcript).iter().any(|row| row == "tool#l(Normal):after the write"));
    assert!(!workspace.lookups.lock().unwrap().is_empty());
    assert!(workspace.lookups.lock().unwrap().iter().all(|changed| *changed));
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
        turn(vec![edit("x1", "one"), edit("x2", "two"), Step::Until(file.ended.subscribe(), 2, "both streamed edits to end"), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![file.clone()], vec![AgentMessage::user("go")])).await;
    let runs = file.runs.lock().unwrap().clone();
    let want: Vec<(String, Option<u32>)> = vec![("x1".into(), None), ("x2".into(), None), ("x1".into(), Some(2)), ("x2".into(), None)];
    assert_eq!(runs, want);
    assert_eq!(*file.text.lock().unwrap(), "one\ntwo\n");
}

/// A read whose first run waits to be released and whose later runs answer at once; it counts the runs started and ended.
struct HeldOnce {
    spec: ToolSpec,
    started: tokio::sync::watch::Sender<usize>,
    ended: tokio::sync::watch::Sender<usize>,
    release: tokio::sync::Notify,
}

impl HeldOnce {
    fn new() -> Arc<Self> {
        let spec = ToolSpec {
            name: "peek".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "peek".into(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Arc::new(Self { spec, started: tokio::sync::watch::Sender::new(0), ended: tokio::sync::watch::Sender::new(0), release: tokio::sync::Notify::new() })
    }
}

#[async_trait]
impl Tool for HeldOnce {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
        let mut run = 0;
        self.started.send_modify(|n| {
            *n += 1;
            run = *n;
        });
        if run == 1 {
            self.release.notified().await;
        }
        self.ended.send_modify(|n| *n += 1);
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("peeked {run}"))], ..ToolOutput::default() })
    }
}

/// A read streamed behind an edit starts as it streams and is run again once the edit is in; the batch takes the second
/// run's result and lets the first go on. The result to keep for the call is the one of its last run: the batch takes
/// back what the first run may have told as the second starts and tells the second's as it ends, and the first run's
/// end, whenever it comes, is told as that of a run whose result is not taken.
#[tokio::test]
async fn a_read_run_again_behind_an_edit_keeps_the_result_of_its_last_run() {
    let file = AnchoredFile::new("same\n");
    let peek = HeldOnce::new();
    let h = Harness::new(vec![
        turn(vec![
            call("e1", "edit", json!({ "file_path": "a.txt", "old_string": "same", "new_string": "one" })),
            call("r1", "peek", json!({})),
            Step::Until(peek.started.subscribe(), 1, "the streamed read to start"),
            done(StopReason::ToolUse),
        ]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let out = finish(h.run(config(), vec![file.clone(), peek.clone()], vec![AgentMessage::user("go")])).await;
    let rows = dump(&out.transcript);
    assert!(rows.iter().any(|row| row == "tool#r1(Normal):peeked 2"), "the batch took the second run's result: {rows:?}");
    assert_eq!(
        *h.observer.replaced.lock().unwrap(),
        [("r1".to_owned(), None), ("r1".to_owned(), Some("peeked 2".to_owned()))],
        "the first run's result is taken back, then the second's is the one kept"
    );
    assert!(h.observer.superseded.lock().unwrap().is_empty(), "the first run has not ended");
    peek.release.notify_one();
    let mut ended = peek.ended.subscribe();
    tokio::time::timeout(Duration::from_secs(30), ended.wait_for(|n| *n >= 2)).await.expect("the first run ends once released").expect("the tool lives");
    let told = || h.observer.superseded.lock().unwrap().clone();
    for _ in 0..200 {
        if !told().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(told(), ["r1"], "the first run's end is told as a run whose result is not the call's");
    assert_eq!(h.observer.replaced.lock().unwrap().len(), 2, "and replaces nothing");
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
    let want: Vec<(String, Option<u32>)> =
        vec![("x1".into(), None), ("x2".into(), None), ("x1".into(), Some(3)), ("x3".into(), None), ("x2".into(), Some(2)), ("x3".into(), None)];
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
        let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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
    for (meta, want) in [(json!({ "uiDiff": "@@ -1 +1 @@" }), Some("@@ -1 +1 @@")), (json!({ "uiDiff": 7 }), None), (json!({ "other": "x" }), None)] {
        let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let out = finish(h.run(config(), vec![Arc::new(WithMeta(meta.clone()))], vec![AgentMessage::user("go")])).await;
        let result = out.transcript.iter().find(|m| m.tool_call_id() == Some("c1")).expect("tool result");
        assert_eq!(result.ui_diff.as_deref(), want, "{meta}");
        assert_eq!(result.text(), "body");
        assert!(out.transcript.iter().filter(|m| m.tool_call_id() != Some("c1")).all(|m| m.ui_diff.is_none()));
    }
}

/// A result whose meta is a tool meta (a `code`) is the message's `toolMeta` and the stored row's: the visualize owner
/// reaches the chat card. Other metas are not, and none of it is wire text.
#[tokio::test]
async fn a_tool_results_tool_meta_rides_its_message_and_its_stored_row() {
    let owner = json!({ "code": "visualize_owner", "missing": [], "ownerSessionId": "sess_lead1x" });
    for (meta, want) in [(owner.clone(), Some(owner.clone())), (json!({ "uiDiff": "d" }), None), (json!({ "code": "" }), None)] {
        let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let out = finish(h.run(config(), vec![Arc::new(WithMeta(meta.clone()))], vec![AgentMessage::user("go")])).await;
        let result = out.transcript.iter().find(|m| m.tool_call_id() == Some("c1")).expect("tool result");
        assert_eq!(result.tool_meta, want, "{meta}");
        assert_eq!(result.text(), "body");
        assert_eq!(mixdog_agent::message_row::row_of(result).get("toolMeta").cloned(), want, "{meta}");
        assert!(out.transcript.iter().filter(|m| m.tool_call_id() != Some("c1")).all(|m| m.tool_meta.is_none()));
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
    hooks: Option<Arc<dyn ToolHooks>>,
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
        turn(vec![text("looking"), call("c1", "echo", json!({"a": 1})), done(StopReason::ToolUse)]),
        turn(vec![text("all done"), done(StopReason::EndTurn)]),
    ]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "all done");
    assert_eq!(output.iterations, 2);
    assert_eq!(output.tool_calls_total, 1);
    assert_eq!(dump(&output.transcript), ["user:go", "assistant[echo#c1]:looking", "tool#c1(Normal):echo:{\"a\":1}",]);
    let second = &h.provider.requests()[1];
    assert_eq!(wire_dump(second), ["User:go", "Assistant:looking", "Tool:echo:{\"a\":1}"]);
    // the assistant turn with calls and each result reached the sink in order
    assert_eq!(h.sink.committed.lock().unwrap().len(), 2);
}

/// A cache owner the scripted provider never asks: its refusals come from the script.
struct NoBook;

impl mixdog_core_api::domain::cache_tail::TailGate for NoBook {
    fn admit<'a>(
        &'a self,
        _: mixdog_core_api::domain::cache_tail::Admission<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = mixdog_core_api::domain::cache_tail::Verdict> + Send + 'a>> {
        unreachable!("the scripted provider asks no gate")
    }
    fn settle(&self, _: &mixdog_core_api::domain::cache_tail::Permit, _: Option<mixdog_core_api::domain::cache_tail::Counters>) {}
    fn claim(&self, _: mixdog_core_api::domain::cache_tail::ColdRequest) -> mixdog_core_api::domain::cache_tail::Claim {
        unreachable!("no rewrite is offered")
    }
    fn resolve(&self, _: u64, _: mixdog_core_api::domain::cache_tail::Resolution) -> Option<mixdog_core_api::domain::cache_tail::Unreduced> {
        None
    }
    fn rebuilt(&self) -> u64 {
        unreachable!("the run compacts nothing")
    }
    fn snapshot(&self) -> Option<serde_json::Value> {
        None
    }
    fn generation(&self) -> u64 {
        unreachable!("the run reads the generation of the history it holds, never the gate's")
    }
    fn wait_for(&self, _: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        unreachable!("no rewrite is waited for")
    }
}

/// The store's history after a rewrite the run did not make, at that history's generation; counts its reloads.
struct Rewritten(Mutex<u32>);

#[async_trait]
impl StoredHistory for Rewritten {
    async fn reload(&self) -> Result<(Vec<AgentMessage>, u64), String> {
        *self.0.lock().unwrap() += 1;
        Ok((vec![AgentMessage::user("compacted: go")], 3))
    }
}

/// A request the cache owner refuses as stale (its transcript predates a rewrite this run did not make) is never stamped
/// again and resent: the run goes on from the history the store holds, with that history's generation on its request.
#[tokio::test]
async fn a_stale_request_goes_on_from_the_stored_history_at_its_generation() {
    use mixdog_core_api::domain::cache_tail::{TailGateHandle, TailRefusal};
    let h = Harness::new(vec![Attempt::Reject(ProviderError::tail_refused(TailRefusal::Stale)), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let history = Arc::new(Rewritten(Mutex::new(0)));
    let mut config = config();
    config.options.tail_gate = Some(TailGateHandle(Arc::new(NoBook)));
    config.options.tail_generation = Some(1);
    let retired = serde_json::from_value(serde_json::json!({
        "compatResponses": { "previousResponseId": "resp_retired", "store": true, "seenMessageCount": 1 }
    }))
    .unwrap();
    config.options.provider_state = Some(retired);
    config.history = Some(history.clone());
    let output = finish(h.run(config, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "ok");
    assert_eq!(*history.0.lock().unwrap(), 1, "reloaded once");
    let requests = h.provider.requests();
    assert_eq!((wire_dump(&requests[0]), requests[0].options.tail_generation), (vec!["User:go".to_owned()], Some(1)));
    assert_eq!(
        (wire_dump(&requests[1]), requests[1].options.tail_generation),
        (vec!["User:compacted: go".to_owned()], Some(3)),
        "the stored history, at its own generation"
    );
    assert!(requests[0].options.provider_state.is_some());
    assert!(requests[1].options.provider_state.is_none(), "the rebuilt history cannot reuse an anchor into the retired transcript");
}

/// A Stop hook that blocks the stop `blocks` times, asked with each `stop_hook_active`.
struct StopHook {
    blocks: usize,
    reason: &'static str,
    asked: Mutex<Vec<bool>>,
    /// What the loop made of each verdict (`stop_settled`): `true` where the turn went on.
    settled: Mutex<Vec<bool>>,
}

impl StopHook {
    fn new(blocks: usize, reason: &'static str) -> Self {
        Self { blocks, reason, asked: Mutex::new(Vec::new()), settled: Mutex::new(Vec::new()) }
    }
}

#[async_trait]
impl ToolHooks for StopHook {
    async fn on_stop(&self, stop_hook_active: bool) -> StopVerdict {
        let mut asked = self.asked.lock().unwrap();
        asked.push(stop_hook_active);
        if asked.len() <= self.blocks { StopVerdict::Continue(self.reason.to_owned()) } else { StopVerdict::Proceed }
    }

    fn stop_settled(&self, continued: bool) {
        self.settled.lock().unwrap().push(continued);
    }
}

/// A Stop hook's block continues the turn (owner-approved difference from Node, B-5): the answer is kept, the reason
/// reaches the model as a hook note, and the next ask says `stop_hook_active`.
#[tokio::test]
async fn a_stop_block_continues_the_turn_with_its_reason() {
    let mut h = Harness::new(vec![turn(vec![text("first"), done(StopReason::EndTurn)]), turn(vec![text("second"), done(StopReason::EndTurn)])]);
    let hook = Arc::new(StopHook::new(1, "run the tests"));
    h.hooks = Some(hook.clone());
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.iterations, 2);
    assert_eq!(*hook.asked.lock().unwrap(), [false, true]);
    assert_eq!(*hook.settled.lock().unwrap(), [true, false]);
    let second = wire_dump(&h.provider.requests()[1]);
    assert_eq!(second[..2], ["User:go", "Assistant:first"]);
    assert!(second[2].contains("Stop hook: run the tests"), "{second:?}");
}

/// A hook that never stops blocking is cut off after eight continuations, with a warning.
#[tokio::test]
async fn stop_continuations_are_capped_per_turn() {
    let mut h = Harness::new((0..10).map(|n| turn(vec![text(&format!("t{n}")), done(StopReason::EndTurn)])).collect());
    let hook = Arc::new(StopHook::new(usize::MAX, "again"));
    h.hooks = Some(hook.clone());
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.iterations, 9);
    assert_eq!(hook.asked.lock().unwrap().len(), 9);
    // The ninth block is past the cap: the loop ends the turn and tells the hooks so.
    let settled = hook.settled.lock().unwrap().clone();
    assert_eq!((settled.len(), settled[..8].iter().all(|c| *c), settled[8]), (9, true, false));
    let warned = h.observer.events().iter().any(|e| matches!(e, RunEvent::Stage(Stage::Notice { tone: Tone::Warn, message }) if message.contains("Stop hook")));
    assert!(warned);
}

/// A turn that ends where it cannot go on (here a second refusal) still asks the Stop hooks once;
/// their block is ignored with a warning and the turn ends (B-5: every completed turn fires Stop).
#[tokio::test]
async fn a_turn_ending_on_a_refusal_asks_the_stop_hooks_once_and_ignores_a_block() {
    let mut h = Harness::new(vec![turn(vec![text("no"), done(StopReason::Refusal)]), turn(vec![text("still no"), done(StopReason::Refusal)])]);
    let hook = Arc::new(StopHook::new(usize::MAX, "go on"));
    h.hooks = Some(hook.clone());
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.iterations, 2);
    assert_eq!(*hook.asked.lock().unwrap(), [false]);
    assert_eq!(*hook.settled.lock().unwrap(), [false], "a block of a turn that cannot go on ends it");
    let warned =
        h.observer.events().iter().any(|e| matches!(e, RunEvent::Stage(Stage::Notice { tone: Tone::Warn, message }) if message.contains("cannot go on")));
    assert!(warned);
}

/// The host's request hook runs before every provider attempt of the turn, once per request.
#[tokio::test]
async fn the_request_hook_runs_before_each_provider_attempt() {
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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
        turn(vec![Step::Event(StreamEvent::ProviderState(ProviderState::default())), call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
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

#[tokio::test]
async fn steering_enters_after_the_tool_batch_and_before_the_next_request() {
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.steer.push(DrainStage::PreSend, "  also check b ");
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(dump(&output.transcript), ["user:go", "assistant[echo#c1]:", "tool#c1(Normal):echo:{}", "user<Steering>:also check b",]);
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
    // The second id of the run: the assistant message that called the tool took the first.
    assert_eq!(injected.message_id, "m2");
    assert_eq!(output.transcript[1].message_id.as_deref(), Some("m1"), "the message the run keeps has the id its row is stored under");
}

#[tokio::test]
async fn terminal_steering_keeps_the_ended_answer_and_resumes() {
    let h = Harness::new(vec![turn(vec![text("first"), done(StopReason::EndTurn)]), turn(vec![text("second"), done(StopReason::EndTurn)])]);
    h.steer.push(DrainStage::Terminal, "one more thing");
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(dump(&output.transcript), ["user:go", "assistant:first", "user<Steering>:one more thing"]);
    // the caller gets every segment, history keeps the terminal one
    assert_eq!(output.response.content, "first\n\nsecond");
    assert_eq!(output.response.history_text(), "second");
}

#[tokio::test]
async fn output_limit_ladder_escalates_once_then_resumes_then_ends() {
    let cut = |t: &str| turn(vec![text(t), done(StopReason::MaxTokens)]);
    let h = Harness::new(vec![cut("aa"), cut("bb"), turn(vec![text("cc"), done(StopReason::EndTurn)])]);
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
    assert!(
        output.response.content.ends_with("d\n\n[mixdog-runtime] The model hit its output limit and the response stayed truncated after 3 recovery attempts.")
    );
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
    assert_eq!(dumped[3], "user:[mixdog-runtime] Empty response (3/3). Return final text, or use tools only for required evidence still missing.");
}

#[tokio::test]
async fn a_transient_failure_is_retried_through_the_decider_and_the_host_wait() {
    let reset = ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous);
    let h = Harness::new(vec![Attempt::Reject(reset), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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

#[tokio::test]
async fn a_deterministic_refusal_surfaces_without_a_wait() {
    let h = Harness::new(vec![Attempt::Reject(ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted))]);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("auth surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert!(h.waiter.0.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn websocket_connection_limit_and_handshake_share_one_budget_in_agent_and_fork() {
    use mixdog_ai::providers::openai::scripted::{self, Dialed, ScriptedDial, Wire};
    use mixdog_ai::providers::openai::switch::TransportMode;

    for fork in [false, true] {
        let limit = || Dialed::Socket {
            frames: vec![
                r#"{"type":"response.created","response":{"id":"expired"}}"#.into(),
                r#"{"type":"error","status":400,"error":{"code":"websocket_connection_limit_reached"}}"#.into(),
            ],
            close: (1000, String::new()),
        };
        let dial = ScriptedDial::with(vec![
            Dialed::Rejected { status: 503, body: "{}".into() },
            limit(),
            Dialed::Socket { frames: vec![], close: (1011, "interrupted".into()) },
            Dialed::Rejected { status: 502, body: "{}".into() },
            limit(),
            limit(),
        ]);
        let provider = scripted::adapter(dial.clone(), mixdog_rt::testing::tokens().cpu_bulk, TransportMode::WsDelta);
        let error = if fork {
            let mut request = ModelRequest {
                model: "m".into(),
                messages: vec![mixdog_core_api::domain::provider::Message::new(
                    mixdog_core_api::domain::provider::Role::User,
                    mixdog_core_api::domain::provider::Content::Text("go".into()),
                )],
                tools: vec![],
                options: Default::default(),
            };
            request.options.transport_scope = Some("t#compact:fork".into());
            mixdog_agent::fork::send_forked(&provider, request, &CancellationToken::new()).await.unwrap_err()
        } else {
            let h = Harness::with_adapter(provider);
            let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("one spent budget");
            let AgentError::Provider(error) = failure.error else { panic!("a provider failure") };
            assert!(h.waiter.0.lock().unwrap().is_empty(), "no second retry ladder in the agent");
            *error
        };
        assert_eq!(error.code.as_deref(), Some("websocket_connection_limit_reached"));
        assert!(error.recovery_exhausted);
        assert_eq!(error.should_retry, Some(false));
        assert_eq!(
            dial.wire().iter().filter(|event| matches!(event, Wire::Upgrade { .. })).count(),
            6,
            "one initial exchange plus five retries, shared across both failure phases"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn websocket_connection_limit_continues_the_agent_without_consulting_fallback() {
    use mixdog_ai::providers::openai::scripted::{self, Dialed, ScriptedDial, Wire};
    use mixdog_ai::providers::openai::switch::TransportMode;

    let dial = ScriptedDial::with(vec![
        Dialed::Rejected { status: 503, body: "{}".into() },
        Dialed::Socket {
            frames: vec![r#"{"type":"error","status":400,"error":{"code":"websocket_connection_limit_reached"}}"#.into()],
            close: (1000, String::new()),
        },
        Dialed::Socket {
            frames: vec![r#"{"type":"response.completed","response":{"id":"continued","status":"completed","output":[{"type":"message","id":"msg","role":"assistant","content":[{"type":"output_text","text":"continued"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}"#.into()],
            close: (1000, String::new()),
        },
    ]);
    let route = PlayRoute::new(RouteDecision::Fail("fallback must not be entered".into()), Vec::new());
    let mut h = Harness::with_adapter(scripted::adapter(dial.clone(), mixdog_rt::testing::tokens().cpu_bulk, TransportMode::WsDelta));
    h.route = Some(route.clone());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "continued");
    assert!(route.asked.lock().unwrap().is_empty());
    assert!(h.waiter.0.lock().unwrap().is_empty(), "the provider owns the backoff; the agent adds no second wait");
    assert_eq!(dial.wire().iter().filter(|event| matches!(event, Wire::Upgrade { .. })).count(), 3);
}

#[tokio::test]
async fn parsed_tool_calls_survive_a_cut_stream() {
    let cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    let h = Harness::new(vec![turn(vec![text("x"), call("c1", "echo", json!({})), Step::Fail(cut)]), turn(vec![text("fin"), done(StopReason::EndTurn)])]);
    let output = finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(dump(&output.transcript), ["user:go", "assistant[echo#c1]:x", "tool#c1(Normal):echo:{}"]);
    assert!(h.waiter.0.lock().unwrap().is_empty(), "continued, not replayed");
}

fn idle_stall(text_emitted: bool) -> ProviderError {
    let mut stall = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    stall.code = Some("ESTREAMSTALL".into());
    stall.timed_out = true;
    stall.timeout_phase = Some(mixdog_core_api::domain::provider::StreamTimeoutPhase::Idle);
    stall.exposure.text_emitted = text_emitted;
    stall
}

/// A stalled stream is a cut stream (`isStreamCut` reads `stallObserved`): text already shown to an owner that cannot
/// withdraw it is kept and continued, not failed with a timeout.
#[tokio::test]
async fn a_stalled_stream_after_shown_text_continues_from_the_shown_text() {
    let mut h = Harness::new(vec![turn(vec![text("part"), Step::Fail(idle_stall(true))]), turn(vec![text(" rest"), done(StopReason::EndTurn)])]);
    h.observer = Observer::new(Retracted::Refused);
    Arc::get_mut(&mut h.observer).unwrap().reset_channel = false;
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert!(output.response.content.starts_with("part"), "{}", output.response.content);
}

/// A stall is not "server unavailable": once the provider's rows are spent the loop does not add recovery laps.
#[tokio::test(start_paused = true)]
async fn a_spent_stall_ladder_surfaces_without_recovery_laps() {
    let h = Harness::new((0..6).map(|_| turn(vec![Step::Fail(idle_stall(false))])).collect());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the stall surfaces");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert!(h.waiter.0.lock().unwrap().iter().all(|wait| *wait < Duration::from_secs(15)), "no 15 s recovery lap");
}

/// `stopAfterRepeated529`: the repeated-overload stop is the provider's verdict that recovery is over, so the loop adds
/// no recovery lap after it and the send surfaces.
#[tokio::test(start_paused = true)]
async fn repeated_overloads_under_the_stop_rule_surface_without_a_recovery_lap() {
    let mut policy = RetryPolicy::codex_default();
    policy.overload.fallback_after = Some(3);
    policy.overload.stop_after_repeated = true;
    let overloaded = || {
        let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
        error.status = Some(529);
        Attempt::Reject(error)
    };
    let script = vec![overloaded(), overloaded(), overloaded(), turn(vec![text("late"), done(StopReason::EndTurn)])];
    let (h, provider) = judged(script, policy);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the send ends on the third overload");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(provider.requests().len(), 3);
}

/// A `notice` the provider raises from inside its attempt (the model it moved to) reaches the run's observer as a
/// transcript notice.
#[tokio::test]
async fn a_notice_raised_inside_an_attempt_reaches_the_observer_as_a_notice() {
    let provider = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let payload = serde_json::json!({ "tone": "info", "message": "claude-a is no longer offered — continuing on claude-b" });
    provider.raised.lock().unwrap().push(("notice", payload));
    let h = Harness { provider, ..Harness::new(Vec::new()) };
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    let seen: Vec<_> = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::Notice { message, tone }) => Some((message, tone)),
            _ => None,
        })
        .collect();
    assert_eq!(seen, vec![("claude-a is no longer offered — continuing on claude-b".to_owned(), Tone::Info)]);
}

/// The count belongs to the logical send: a send that returns a recovered partial turn (a completed call, then a cut)
/// ends it, and the next request's one overload is the first, not the third.
#[tokio::test(start_paused = true)]
async fn a_recovered_partial_turn_ends_the_overload_count_of_its_send() {
    let mut policy = RetryPolicy::codex_default();
    policy.overload.fallback_after = Some(3);
    policy.overload.stop_after_repeated = true;
    let overloaded = || {
        let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
        error.status = Some(529);
        error
    };
    let script = vec![
        Attempt::Reject(overloaded()),
        Attempt::Reject(overloaded()),
        turn(vec![call("c1", "echo", json!({})), Step::Fail(truncated())]),
        Attempt::Reject(overloaded()),
        turn(vec![text("done"), done(StopReason::EndTurn)]),
    ];
    let (h, provider) = judged(script, policy);
    finish(h.run(config(), vec![Arc::new(Marked(true, false))], vec![AgentMessage::user("go")])).await;
    assert_eq!(provider.requests().len(), 5, "the next request's overload is retried, not counted as the third");
}

/// The response head a provider reports from inside its attempt (`onStreamDelta('transport')`) reaches the run as
/// transport health, which is what moves the agent watchdog from its first-transport window to its first-output one.
#[tokio::test]
async fn a_transport_mark_raised_inside_an_attempt_reaches_the_observer_as_transport_health() {
    let provider = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    provider.raised.lock().unwrap().push(("transport", serde_json::Value::Null));
    let h = Harness { provider, ..Harness::new(Vec::new()) };
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    let events = h.observer.events();
    assert_eq!(events.iter().filter(|e| matches!(e, RunEvent::Transport)).count(), 1);
    assert!(!events.iter().any(|e| matches!(e, RunEvent::Stage(Stage::WaitingOnProvider))), "a transport mark is no keepalive stage");
}

/// A stage the provider raises while its stream is open (a resumed WebSocket's retry, an attempt's start) reaches the run when it
/// is raised, before the output that follows it, not at the end of the stream; so does the transport mark.
#[tokio::test]
async fn stages_raised_inside_an_open_stream_reach_the_observer_before_its_output() {
    let payload = json!({ "attempt": 1, "max": 2, "waitMs": 1500, "message": "Connection interrupted · retry 1/2 in 1.5s" });
    let h = Harness::new(vec![turn(vec![
        Step::Raise("reconnecting", Some(payload.clone())),
        Step::Raise("requesting", None),
        Step::Raise("transport", None),
        text("ok"),
        done(StopReason::EndTurn),
    ])]);
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    let events = h.observer.events();
    let at = |wanted: &dyn Fn(&RunEvent) -> bool| events.iter().position(wanted).expect("the event was observed");
    let reconnecting = at(&|e| matches!(e, RunEvent::Stage(Stage::Reconnecting { payload: Some(p), attempt: 1, max: 2, .. }) if *p == payload));
    let requesting = at(&|e| matches!(e, RunEvent::Stage(Stage::Requesting)));
    let transport = at(&|e| matches!(e, RunEvent::Transport));
    let text_at = at(&|e| matches!(e, RunEvent::TextDelta(_)));
    assert!(reconnecting < text_at && requesting < text_at && transport < text_at, "{events:?}");
}

/// One counter of consecutive overloads serves the refusals of the request and the errors of the stream
/// (`createAnthropicOverloadTracker`): two refused requests and an overload in the stream are the third.
#[tokio::test(start_paused = true)]
async fn overloads_of_the_request_and_of_the_stream_share_one_counter() {
    let mut policy = RetryPolicy::codex_default();
    policy.overload.fallback_after = Some(3);
    policy.overload.stop_after_repeated = true;
    let overloaded = || {
        let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::Accepted);
        error.status = Some(529);
        error
    };
    let script = vec![
        Attempt::Reject(overloaded()),
        Attempt::Reject(overloaded()),
        turn(vec![Step::Fail(overloaded())]),
        turn(vec![text("late"), done(StopReason::EndTurn)]),
    ];
    let (h, provider) = judged(script, policy);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the stream's overload is the third");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(provider.requests().len(), 3, "no fourth request goes out");
}

/// Reasoning already delivered to the surface cannot be regenerated behind the user's back either.
#[tokio::test(start_paused = true)]
async fn a_stall_after_reasoning_is_not_replayed_if_the_owner_refuses_the_reset() {
    let h = {
        let mut h = Harness::new(vec![
            turn(vec![Step::Event(StreamEvent::ReasoningDelta("thinking".into())), Step::Fail(idle_stall(true))]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        h.observer = Observer::new(Retracted::Refused);
        h
    };
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("reasoning is still visible");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(h.provider.requests().len(), 1);
}
#[tokio::test]
async fn turn_limits_answer_extra_calls_unrun_and_forbid_tools_after_the_notice() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"n": 1})), call("c2", "echo", json!({"n": 2})), done(StopReason::ToolUse)]),
        turn(vec![text("wrap"), done(StopReason::EndTurn)]),
    ]);
    let mut cfg = config();
    cfg.limits = Some(TurnLimits { max_tool_calls: Some(1), ..TurnLimits::default() });
    let output = finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let dumped = dump(&output.transcript);
    assert_eq!(dumped[2], "tool#c1(Normal):echo:{\"n\":1}");
    assert_eq!(dumped[3], "tool#c2(Error):[turn-limit] This turn has reached its tool-call or time limit; this call was not run. Reply now without tools.");
    assert!(dumped[4].starts_with("user<TurnLimit>:[mixdog-runtime] This turn has reached"));
    let requests = h.provider.requests();
    assert_eq!(requests[0].options.tool_choice, None);
    assert_eq!(requests[1].options.tool_choice.as_deref(), Some("none"));
}

#[tokio::test]
async fn identical_read_only_calls_in_one_turn_run_once() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"p": "x"})), call("c2", "echo", json!({"p": "x"})), done(StopReason::ToolUse)]),
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
    async fn lookup(&self, _call: &ToolCall, _cwd: &Path, _touch: bool) -> Option<Reused> {
        None
    }
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
    h.compactor = Some(Arc::new(Compactor100 { requests: Mutex::new(Vec::new()), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: true, context_window: Some(1_000), token_calibration: 1.0, ..CompactSettings::default() });
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
        Rewrite { dropped_count: 10, dropped: Some(Dropped { message_ids: vec!["gone".into()], call_ids: vec!["call-gone".into()] }), compaction: true }
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

/// `runFreshContextCompact` (`fresh-context.mjs`): a pass that wrote a summary is the session's (`session-local`) whether or
/// not the summary's answer reported usage; only a pass with no summary is the rules'.
#[tokio::test]
async fn the_passes_handoff_source_is_the_written_summary_not_its_usage() {
    for (summary_ms, source) in [(Some(5.0), "session-local"), (None, "rules")] {
        let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        h.compactor = Some(Arc::new(Compactor100 { summary_ms, ..Default::default() }));
        let mut cfg = config();
        cfg.compact = Some(compact_settings());
        finish(h.run(cfg, vec![], eleven_messages())).await;
        let sources: Vec<&str> = h
            .observer
            .events()
            .into_iter()
            .filter_map(|e| match e {
                RunEvent::CompactPass(pass) => match pass.stage {
                    PassStage::Done { handoff_source, .. } => Some(handoff_source),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(sources, [source], "summary_ms {summary_ms:?}");
    }
}

/// The summary may be sent by another adapter than the conversation's (a Maintainer route): its usage is reported with
/// the convention of the adapter that sent it, whichever way the conversation's own adapter reads its input.
#[tokio::test]
async fn a_summary_sent_by_another_adapter_reports_its_usage_by_that_adapters_convention() {
    for excludes in [true, false] {
        let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 5, cache_read_tokens: 1000, ..Default::default() };
        h.compactor = Some(Arc::new(Compactor100 { summary_ms: Some(5.0), summary_usage: Some((usage, excludes)), ..Default::default() }));
        let mut cfg = config();
        cfg.compact = Some(compact_settings());
        finish(h.run(cfg, vec![], eleven_messages())).await;
        let reported: Vec<bool> = h
            .observer
            .events()
            .into_iter()
            .filter_map(|e| match e {
                RunEvent::CompactUsage { input_excludes_cache, .. } => Some(input_excludes_cache),
                _ => None,
            })
            .collect();
        assert_eq!(reported, [excludes]);
    }
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

fn three_messages() -> Vec<AgentMessage> {
    vec![AgentMessage::user("a"), AgentMessage::assistant("b", Vec::new()), AgentMessage::user("c")]
}

fn send_pressures(h: &Harness) -> Vec<u64> {
    h.observer.events().into_iter().filter_map(|e| if let RunEvent::ContextPressure { used_tokens, .. } = e { Some(used_tokens) } else { None }).collect()
}

/// `resolveContextTokensWithSource` over `session.contextPressureBaseline*`: a run's first send has measured nothing, so
/// the session's provider reading prices it. A transcript the estimate puts under the trigger (3 × 100) compacts when
/// the provider measured it over.
#[tokio::test]
async fn a_runs_first_send_is_priced_from_the_sessions_provider_reading() {
    let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { session_reading: Some(1_050), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    finish(h.run(cfg, vec![], three_messages())).await;
    let events = compact_marker(&h);
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].status, events[0].pressure_tokens), (CompactStatus::Compacted, 1_050));
    assert_eq!(wire_dump(&h.provider.requests()[0]), ["User:[summary]", "User:c"]);
}

/// Once a send of the run measured the transcript, the run's own reading prices the next send (600 measured, plus the
/// tool result after the reply it paid for), not the session's.
#[tokio::test]
async fn the_runs_own_reading_prices_the_sends_after_its_first() {
    let measured = mixdog_core_api::domain::provider::Usage { input_tokens: 600, ..Default::default() };
    let mut h = Harness::new(vec![
        turn(vec![Step::Event(StreamEvent::Usage(measured)), call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.compactor = Some(Arc::new(Compactor100 { session_reading: Some(900), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    finish(h.run(cfg, vec![Echo::tool()], three_messages())).await;
    assert_eq!(send_pressures(&h), [900, 700]);
    assert!(compact_marker(&h).is_empty());
}

/// `shouldCompactForSession` on a session marked `contextPressureUnanchoredAfterRestart`: neither its reading (1 200) nor
/// the estimate (11 × 100) over the trigger arms a proactive pass before a provider send re-anchors it.
#[tokio::test]
async fn an_unanchored_sessions_pressure_arms_no_proactive_pass() {
    for reading in [Some(1_200), None] {
        let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        h.compactor = Some(Arc::new(Compactor100 { session_reading: reading, session_unanchored: true, ..Default::default() }));
        let mut cfg = config();
        cfg.compact = Some(compact_settings());
        finish(h.run(cfg, vec![], eleven_messages())).await;
        assert!(compact_marker(&h).is_empty(), "{reading:?}");
        assert_eq!(h.provider.requests()[0].messages.len(), 11, "{reading:?}");
        if let Some(reading) = reading {
            assert_eq!(send_pressures(&h), [reading]);
        }
    }
}

/// `shouldCompactForSession`: a one-shot policy (a reserve at the trigger) that already took its pass arms no more.
#[tokio::test]
async fn a_consumed_single_shot_policy_arms_no_proactive_pass() {
    for consumed in [false, true] {
        let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        h.compactor = Some(Arc::new(Compactor100 { session_single_shot_consumed: consumed, ..Default::default() }));
        let mut cfg = config();
        cfg.compact = Some(CompactSettings { configured_reserve_tokens: 2_000, ..compact_settings() });
        finish(h.run(cfg, vec![], eleven_messages())).await;
        assert_eq!(compact_marker(&h).is_empty(), consumed, "{consumed}");
    }
}

/// `providerReadingBelowTrigger`: a transcript the provider measured under the trigger and nothing was appended to is not
/// compacted on the estimate (11 × 100) of the same transcript; one message more is.
#[tokio::test]
async fn a_provider_reading_below_the_trigger_outranks_the_estimate_of_the_same_transcript() {
    for count in [11, 10] {
        let mut h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        h.compactor = Some(Arc::new(Compactor100 { session_last_reading: Some((500, count)), ..Default::default() }));
        let mut cfg = config();
        cfg.compact = Some(compact_settings());
        finish(h.run(cfg, vec![], eleven_messages())).await;
        assert_eq!(compact_marker(&h).is_empty(), count == 11, "{count}");
    }
}

/// A send the run measured re-anchors the session (`recordProviderContextBaseline` drops the mark) while its header may
/// still show the mark: once the preflight voided the run's own reading, the estimate over the trigger (14 × 100)
/// compacts.
#[tokio::test]
async fn a_send_the_run_measured_lifts_the_unanchored_mark() {
    let measured = mixdog_core_api::domain::provider::Usage { input_tokens: 900, ..Default::default() };
    let mut h = Harness::new(vec![
        turn(vec![Step::Event(StreamEvent::Usage(measured)), call("c1", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.compactor = Some(Arc::new(Compactor100 { preflight: true, session_unanchored: true, ..Default::default() }));
    // Steering after the tool batch reads "attached": the preflight rewrites it, which voids the run's own reading.
    h.steer.push(DrainStage::PreSend, "attached");
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    finish(h.run(cfg, vec![Echo::tool()], eleven_messages())).await;
    let requests = h.provider.requests();
    assert_eq!(requests[0].messages.len(), 11, "the mark holds the first send");
    assert_eq!(*h.compactor.as_ref().unwrap().requests.lock().unwrap(), [(14, CompactTrigger::Auto)]);
    assert_eq!(wire_dump(&requests[1]), ["User:[summary]", "User:referenced"]);
}

#[tokio::test]
async fn a_calls_usage_event_carries_what_nodes_usage_delta_needs() {
    let reported = mixdog_core_api::domain::provider::Usage {
        input_tokens: 120,
        output_tokens: 30,
        raw: Some(json!({ "output_tokens_details": { "reasoning_tokens": 9 } })),
        ..Default::default()
    };
    let h = Harness::new(vec![
        turn(vec![Step::Event(StreamEvent::Usage(reported)), call("c1", "echo", json!({})), call("c2", "echo", json!({})), done(StopReason::ToolUse)]),
        turn(vec![
            Step::Event(StreamEvent::Usage(mixdog_core_api::domain::provider::Usage { input_tokens: 5, ..Default::default() })),
            text("ok"),
            done(StopReason::EndTurn),
        ]),
    ]);
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let deltas: Vec<UsageDelta> =
        h.observer.events().into_iter().filter_map(|e| if let RunEvent::Usage { delta, .. } = e { Some(delta) } else { None }).collect();
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
        turn(vec![
            Step::Event(StreamEvent::Usage(usage(None, Some(json!({ "thoughtsTokenCount": 4 }))))),
            call("c2", "echo", json!({})),
            done(StopReason::ToolUse),
        ]),
        // A reported figure is a count even when 0, so none and a raw zero differ from missing.
        turn(vec![Step::Event(StreamEvent::Usage(usage(None, Some(json!({ "thinking_tokens": 0 }))))), text("ok"), done(StopReason::EndTurn)]),
    ]);
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let deltas: Vec<UsageDelta> =
        h.observer.events().into_iter().filter_map(|e| if let RunEvent::Usage { delta, .. } = e { Some(delta) } else { None }).collect();
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
    h.compactor = Some(Arc::new(Compactor100 { requests: Mutex::new(Vec::new()), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: true, context_window: Some(100_000), token_calibration: 1.0, ..CompactSettings::default() });
    let messages = vec![AgentMessage::user("a"), AgentMessage::assistant("b", Vec::new()), AgentMessage::user("c")];
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
    h.compactor = Some(Arc::new(Compactor100 { requests: Mutex::new(Vec::new()), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: true, context_window: Some(100_000), token_calibration: 1.0, ..CompactSettings::default() });
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b"), AgentMessage::user("c")];
    let failure = h.run(cfg, vec![], messages).run().await.expect_err("overflow");
    assert!(failure.error.to_string().starts_with("agent context overflow (scripted/m, stage=send): latest turn cannot fit target context budget=100000"));
}

#[tokio::test]
async fn a_compacted_context_does_not_reuse_the_old_prompt_on_an_overflow_retry() {
    let mut h = Harness::new(vec![
        Attempt::Reject(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::Accepted)),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.compactor = Some(Arc::new(Compactor100::default()));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { last_context_tokens: Some(777), ..compact_settings() });
    finish(h.run(cfg, vec![], eleven_messages())).await;
    let events = compact_marker(&h);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].before_tokens, 777);
    assert_eq!(events[1].trigger, CompactTrigger::Reactive);
    assert_eq!(events[1].before_tokens, events[1].pressure_tokens);
    assert_eq!(events[1].before_tokens, 1_000);
}

#[tokio::test]
async fn a_boundary_without_a_window_leaves_the_overflow_budget_and_window_unknown() {
    // Node: `{provider, compactBoundaryTokens: 10000}` has no `sessionRef.contextWindow`, so the
    // send-stage overflow carries `budgetTokens: sessionRef.contextWindow` as null.
    let overflow = || Attempt::Reject(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::Accepted));
    let mut h = Harness::new(vec![overflow(), overflow()]);
    h.compactor = Some(Arc::new(Compactor100 { requests: Mutex::new(Vec::new()), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: true, explicit_boundary: Some(10_000), token_calibration: 1.0, ..CompactSettings::default() });
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b"), AgentMessage::user("c")];
    let failure = h.run(cfg, vec![], messages).run().await.expect_err("overflow");
    let text = failure.error.to_string();
    assert!(text.contains("stage=send"), "{text}");
    assert!(text.contains("budget=unknown"), "{text}");
    assert!(text.contains("contextWindow=unknown"), "{text}");
}

#[tokio::test]
async fn automatic_compaction_off_still_states_the_window_of_a_send_overflow() {
    // Node's `recoverContextOverflow` states `sessionRef.contextWindow` as the window and the budget
    // with automatic compaction off too; the reserve is the off policy's (none), and nothing compacts.
    let overflow = || Attempt::Reject(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::Accepted));
    let mut h = Harness::new(vec![overflow()]);
    h.compactor = Some(Arc::new(Compactor100 { requests: Mutex::new(Vec::new()), ..Default::default() }));
    let mut cfg = config();
    cfg.compact = Some(CompactSettings { auto: false, context_window: Some(50_000), token_calibration: 1.0, ..CompactSettings::default() });
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b"), AgentMessage::user("c")];
    let failure = h.run(cfg, vec![], messages).run().await.expect_err("overflow");
    let text = failure.error.to_string();
    assert!(text.contains("stage=send"), "{text}");
    assert!(text.contains("budget=50000 reserve=unknown contextWindow=50000"), "{text}");
    assert!(h.compactor.as_ref().unwrap().requests.lock().unwrap().is_empty(), "automatic compaction is off");
}

#[tokio::test]
async fn abort_while_the_provider_is_silent_returns_at_once() {
    let h = Harness::new(vec![turn(vec![text("par"), Step::Hang])]);
    let run = h.run(config(), vec![], vec![AgentMessage::user("go")]);
    let cancel = h.cancel.clone();
    let task = tokio::spawn(run.run());
    // wait until the partial text was relayed, then cancel
    while !h.observer.events().iter().any(|e| matches!(e, RunEvent::TextDelta(_))) {
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
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)])]);
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

#[tokio::test]
async fn each_request_leaves_after_the_mark_of_its_send_is_stored() {
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let sink = Arc::new(OrderedSink { provider: h.provider.clone(), tickets: AtomicU64::new(0), log: Mutex::new(Vec::new()) });
    let mut env = h.run_env();
    env.sink = sink.clone();
    let run = Run::new(
        env,
        h.cancel.clone(),
        h.provider.clone(),
        ToolSet::with_builtins(vec![Echo::tool()], vec!["echo".into()]),
        h.tool_env(),
        config(),
        vec![AgentMessage::user("go")],
        RunCarry::default(),
    );
    finish(run).await;
    assert_eq!(h.provider.requests().len(), 2);
    let log = sink.log.lock().unwrap().clone();
    let waited: Vec<usize> = log.iter().filter(|(what, ..)| *what == "drafted").map(|&(_, _, sent)| sent).collect();
    assert_eq!(waited, [0, 1], "one wait before each request, with only the earlier requests sent: {log:?}");
}

/// Node appends each turn row synchronously (`appendFileSync`, `turn-checkpoint-journal.mjs:503`) before its next request.
#[tokio::test]
async fn the_request_after_a_tool_batch_waits_until_its_tool_result_is_durable() {
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let sink = Arc::new(OrderedSink { provider: h.provider.clone(), tickets: AtomicU64::new(0), log: Mutex::new(Vec::new()) });
    let mut env = h.run_env();
    env.sink = sink.clone();
    let run = Run::new(
        env,
        h.cancel.clone(),
        h.provider.clone(),
        ToolSet::with_builtins(vec![Echo::tool()], vec!["echo".into()]),
        h.tool_env(),
        config(),
        vec![AgentMessage::user("go")],
        RunCarry::default(),
    );
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
    assert!(matches!(failure.error, AgentError::Commit(mixdog_agent::env::CommitError::StoreUnavailable(_))), "{:?}", failure.error);
    assert_eq!(dump(&failure.transcript), ["user:go"]);
    assert!(h.sink.committed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn abort_during_a_tool_cancels_its_token_and_keeps_finished_results() {
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), call("c2", "hang", json!({})), done(StopReason::ToolUse)])]);
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
    assert_eq!(&tail[tail.len() - 2..], ["tool#c2(Error):Cancelled", "user:[Request interrupted by user for tool use]"]);
}

/// A call of a parallel batch that finishes while an earlier one still runs is told finished at once, and its row still waits for
/// its place in call order: nothing is committed past the running call.
#[tokio::test]
async fn a_finished_call_is_told_at_once_while_an_earlier_call_runs_and_rows_keep_call_order() {
    let h = Harness::new(vec![turn(vec![call("c1", "hang", json!({})), call("c2", "echo", json!({})), done(StopReason::ToolUse)])]);
    let run = h.run(config(), vec![Echo::tool(), Hang::tool()], vec![AgentMessage::user("go")]);
    let task = tokio::spawn(run.run());
    let told = |id: &str| h.observer.events().iter().any(|e| matches!(e, RunEvent::EarlyResult(m) if m.tool_call_id() == Some(id)));
    while !told("c2") {
        let arrived = tokio::time::timeout(Duration::from_secs(30), h.observer.early_arrived.notified()).await;
        assert!(arrived.is_ok(), "c2 finished while c1 runs and was not told");
    }
    assert!(!told("c1"), "c1 is still running");
    let committed: Vec<Option<String>> = h.sink.committed.lock().unwrap().iter().map(|m| m.tool_call_id().map(str::to_owned)).collect();
    assert!(!committed.iter().any(|id| id.as_deref() == Some("c2")), "c2's row waits for c1's: {committed:?}");
    h.cancel.cancel();
    assert!(matches!(task.await.unwrap().expect_err("aborted").error, AgentError::Aborted));
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
    let h = Harness::new(vec![turn(vec![text("part"), done(StopReason::Other("pause_turn".into()))]), turn(vec![text("rest"), done(StopReason::EndTurn)])]);
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
    let prompt = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("see".into(), None), text_ref, image_ref.clone()]));
    let mut cfg = config();
    cfg.attachments = Some(Arc::new(Refs));
    let output = finish(h.run(cfg, vec![], vec![prompt])).await;
    let sent = &h.provider.requests()[0].messages[0].content;
    assert_eq!(
        sent,
        &Content::Parts(vec![ContentPart::Text("see".into(), None), ContentPart::Text("<file name=\"notes.md\">\nbody\n</file>".into(), None), image_ref,])
    );
    assert!(matches!(&output.transcript[0].message.content, Content::Parts(p) if matches!(p[1], ContentPart::File { .. })));
}

#[tokio::test]
async fn an_image_the_person_chose_to_continue_without_leaves_the_request_and_stays_in_the_transcript() {
    use mixdog_core_api::domain::image_overlay::ImageOverlay;
    use mixdog_core_api::domain::image_overlay::PartKey;
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::ImageSource;
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut prompt = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("look".into(), None), ContentPart::Image(ImageSource::Url("u".into()))]));
    prompt.message_id = Some("m0".into());
    let mut overlay = ImageOverlay::default();
    overlay.omit(PartKey { message_id: "m0".into(), part: 1 });
    let mut cfg = config();
    cfg.image_overlay = Some(Arc::new(move || Ok(overlay.clone())));
    let output = finish(h.run(cfg, vec![], vec![prompt])).await;
    let requests = h.provider.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].messages[0].content, Content::Parts(vec![ContentPart::Text("look".into(), None)]));
    assert!(
        matches!(&output.transcript[0].message.content, Content::Parts(p) if p.len() == 2 && matches!(p[1], ContentPart::Image(_))),
        "the transcript keeps the original"
    );
}

#[tokio::test]
async fn image_choices_that_cannot_be_read_refuse_the_send_before_anything_is_sent() {
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut cfg = config();
    cfg.image_overlay = Some(Arc::new(|| Err("the file is damaged".to_owned())));
    let failure = h.run(cfg, vec![], vec![AgentMessage::user("go")]).run().await.expect_err("refused");
    let AgentError::Provider(error) = &failure.error else { panic!("a provider-shaped refusal: {:?}", failure.error) };
    assert_eq!(error.delivery, DeliveryState::NotSent);
    assert!(error.message.starts_with("Nothing was sent.") && error.message.contains("Start again from your last message"), "{}", error.message);
    assert!(!error.message.contains("damaged"), "the reader's own wording stays out of the sentence: {}", error.message);
    assert!(h.provider.requests().is_empty());
}

#[tokio::test]
async fn a_message_recorded_without_an_id_is_sent_under_the_id_its_image_choices_use() {
    let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut cfg = config();
    cfg.image_overlay = Some(Arc::new(|| Ok(mixdog_core_api::domain::image_overlay::ImageOverlay::default())));
    let _ = finish(h.run(cfg, vec![], vec![AgentMessage::user("go")])).await;
    let requests = h.provider.requests();
    let ids: Vec<Option<String>> = requests[0].messages.iter().map(|m| m.message_id.clone()).collect();
    assert!(ids.contains(&Some(mixdog_core_api::domain::image_overlay::stable_message_id(None, 0))), "{ids:?}");
}

#[tokio::test]
async fn an_image_the_provider_rejects_is_never_removed_and_replayed_the_failure_surfaces_with_one_send() {
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::ImageSource;
    let h = Harness::new(vec![rejection(ErrorKind::ImageRejected, None), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let prompt = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("look".into(), None), ContentPart::Image(ImageSource::Url("u".into()))]));
    let failure = h.run(config(), vec![], vec![prompt]).run().await.expect_err("the provider's rejection surfaces");
    let AgentError::Provider(error) = &failure.error else { panic!("a provider failure: {:?}", failure.error) };
    assert_eq!(error.kind, ErrorKind::ImageRejected);
    // No second request with the image removed or replaced by text.
    let requests = h.provider.requests();
    assert_eq!(requests.len(), 1);
    assert!(matches!(&requests[0].messages[0].content, Content::Parts(p) if p.len() == 2 && matches!(p[1], ContentPart::Image(_))));
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

fn wire_role(message: &AgentMessage) -> &'static str {
    use mixdog_core_api::domain::provider::Role;
    match message.role() {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        other => panic!("a role the recording has none of: {other:?}"),
    }
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
    let h = Harness::new(vec![rejection(ErrorKind::ReplayRejected, None), overloaded(), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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
    let h = Harness::new(vec![rejection(ErrorKind::ReplayRejected, None), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut assistant = AgentMessage::assistant("t", Vec::new());
    assistant.message.assistant_blocks = Some(json!([
        {"type": "thinking", "thinking": "x"},
        {"type": "text", "text": "t"},
    ]));
    let messages = vec![AgentMessage::user("a"), assistant, AgentMessage::user("b")];
    let output = finish(h.run(config(), vec![], messages)).await;
    assert_eq!(output.transcript[1].message.assistant_blocks, Some(json!([{"type": "text", "text": "t"}])));
    assert_eq!(h.provider.requests().len(), 2);
    let replaced = h.sink.replaced.lock().unwrap();
    assert_eq!(replaced.len(), 1, "the repair is persisted");
    assert_eq!(replaced[0].1, Rewrite::default(), "a repair drops nothing");
}

#[tokio::test]
async fn a_rejected_tool_schema_drops_the_tool_and_refuses_later_calls() {
    let Attempt::Reject(mut schema) = rejection(ErrorKind::ToolSchemaRejected, None) else { unreachable!() };
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
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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

/// A Messages route's request carries its projection itself, so a fork, a side question or a cache warm of the saved request
/// lowers the history as the turn did; a Responses route's request carries none (its adapter takes it with each attempt).
#[tokio::test]
async fn a_messages_request_carries_its_effort_projection_and_a_responses_one_does_not() {
    use mixdog_agent::effort::EffortMode;
    use mixdog_agent::effort::EffortRoute;
    use mixdog_agent::effort::EffortSnapshot;
    use mixdog_agent::effort::EffortWiring;
    for (provider, mode, carried) in [("anthropic-oauth", EffortMode::Anthropic, true), ("anthropic", EffortMode::Anthropic, true), ("openai", EffortMode::Responses, false)] {
        let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
        let snap =
            |effort: &str| EffortSnapshot { provider: provider.into(), model: "claude-opus-5-5".into(), mode, initial_effort: "low".into(), effort: effort.into() };
        let mut first = AgentMessage::user("earlier");
        first.effort = Some(snap("low"));
        let mut second = AgentMessage::user("go");
        second.effort = Some(snap("high"));
        let mut cfg = config();
        // The turn runs at the effort judged for it; the conversation began at another.
        cfg.options.effort = Some("high".into());
        cfg.effort = Some(EffortWiring {
            route: EffortRoute {
                provider: provider.into(),
                model: "claude-opus-5.5".into(),
                mode: Some(mode),
                allowed: ["low", "medium", "high"].map(String::from).to_vec(),
                seed: Some(snap("high")),
                wire: Arc::new(|e| Some(e.to_owned())),
            },
            adapter: adapter.clone(),
        });
        finish(h.run(cfg, vec![Echo::tool()], vec![first, AgentMessage::assistant("a", Vec::new()), second])).await;
        let expected = mixdog_core_api::domain::provider::EffortProjection { initial_effort: "low".into(), updates: [(2, "high".to_owned())].into() };
        let requests = h.provider.requests();
        assert_eq!(requests.len(), 2, "{provider}");
        for request in &requests {
            assert_eq!(request.options.effort_projection, carried.then(|| expected.clone()), "{provider}");
        }
        assert_eq!(adapter.seen.lock().unwrap().len(), 2, "the adapter is handed the projection on either wire");
    }
}

/// Two turns of one session on an Anthropic route, the second judged at another effort, each run through the loop and
/// its request encoded by the Messages codec: the later body keeps every byte of the earlier one, up to its end, and the
/// change rides as a control message before the turn's user message.
#[tokio::test]
async fn an_effort_change_between_two_turns_keeps_every_byte_the_earlier_request_sent() {
    use mixdog_agent::effort::EffortMode;
    use mixdog_agent::effort::EffortRoute;
    use mixdog_agent::effort::EffortSnapshot;
    use mixdog_agent::effort::EffortWiring;
    use mixdog_ai::providers::anthropic::AnthropicCodec;
    use mixdog_ai::providers::anthropic::AnthropicConfig;
    use mixdog_ai::providers::anthropic::Flavor;
    use mixdog_ai::providers::anthropic::ModelCaps;
    use mixdog_core_api::domain::provider::WireCodec;
    const MODEL: &str = "claude-opus-5-5";
    fn snap(provider: &str, effort: &str) -> EffortSnapshot {
        EffortSnapshot { provider: provider.into(), model: MODEL.into(), mode: EffortMode::Anthropic, initial_effort: "low".into(), effort: effort.into() }
    }
    fn stamped(provider: &str, text: &str, effort: &str) -> AgentMessage {
        let mut message = AgentMessage::user(text);
        message.effort = Some(snap(provider, effort));
        message
    }
    /// One turn of the session at `effort`, over `messages`: the request the loop sent.
    async fn sent(provider: &str, effort: &str, messages: Vec<AgentMessage>) -> ModelRequest {
        let h = Harness::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
        let mut cfg = config();
        cfg.options.effort = Some(effort.into());
        cfg.effort = Some(EffortWiring {
            route: EffortRoute {
                provider: provider.into(),
                model: MODEL.into(),
                mode: Some(EffortMode::Anthropic),
                allowed: ["low", "medium", "high"].map(String::from).to_vec(),
                seed: Some(snap(provider, effort)),
                wire: Arc::new(|e| Some(e.to_owned())),
            },
            adapter,
        });
        finish(h.run(cfg, Vec::new(), messages)).await;
        let mut request = (*h.provider.requests().pop().expect("the turn's request")).clone();
        request.model = MODEL.into();
        request
    }
    for (provider, flavor) in [("anthropic", Flavor::ApiKey), ("anthropic-oauth", Flavor::OAuth)] {
        let first = sent(provider, "low", vec![stamped(provider, "q1", "low")]).await;
        let history = vec![stamped(provider, "q1", "low"), AgentMessage::assistant("ok", Vec::new()), stamped(provider, "q2", "high")];
        let second = sent(provider, "high", history).await;
        let caps = ModelCaps {
            adaptive_thinking: true,
            effort_levels: ["low", "medium", "high"].map(String::from).to_vec(),
            max_output_tokens: Some(16384),
            ..ModelCaps::default()
        };
        let codec = AnthropicCodec::new(flavor, AnthropicConfig::new(Arc::new(move |_: &str| Some(caps.clone()))));
        let body = |request: &ModelRequest| -> serde_json::Value {
            let mut body: serde_json::Value = serde_json::from_slice(&codec.encode(request).expect("encodes").body).expect("a JSON body");
            // The cache reads the bytes without their breakpoints.
            for block in body["messages"].as_array_mut().expect("messages").iter_mut().filter_map(|m| m["content"].as_array_mut()).flatten() {
                block.as_object_mut().expect("a block").shift_remove("cache_control");
            }
            body
        };
        let (earlier, later) = (body(&first), body(&second));
        let frame = |body: &serde_json::Value| {
            let mut frame = body.clone();
            frame.as_object_mut().expect("a body").shift_remove("messages");
            frame
        };
        assert_eq!(frame(&earlier), frame(&later), "{provider}: nothing ahead of the messages moves with the effort");
        assert_eq!(later["output_config"]["effort"], "low", "{provider}: the conversation's first effort stays at the top");
        let (was, now) = (earlier["messages"].to_string(), later["messages"].to_string());
        assert!(now.starts_with(was.strip_suffix(']').expect("an array")), "{provider}: {was} is not a prefix of {now}");
        let messages = later["messages"].as_array().expect("messages");
        let roles: Vec<&str> = messages.iter().map(|m| m["role"].as_str().expect("a role")).collect();
        assert_eq!(roles, ["user", "assistant", "system", "user"], "{provider}");
        assert_eq!(messages[2], json!({ "role": "system", "content": [], "output_config": { "effort": "high" } }), "{provider}");
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
    let mut h =
        Harness::new(vec![turn(vec![call("c1", "echo", json!({"i": 1})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let timer = Arc::new(HeldTimer::default());
    h.waiter = Arc::new(RecordedWait(Mutex::default(), Some(timer.clone())));
    let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
    let seed =
        EffortSnapshot { provider: "openai".into(), model: "gpt-6-1".into(), mode: EffortMode::Responses, initial_effort: "low".into(), effort: "low".into() };
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
    let mut h =
        Harness::new(vec![turn(vec![call("c1", "echo", json!({"i": 1})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let timer = Arc::new(HeldTimer::default());
    h.waiter = Arc::new(RecordedWait(Mutex::default(), Some(timer.clone())));
    let adapter = Arc::new(RecordingEffort { provider: h.provider.clone(), seen: Mutex::new(Vec::new()) });
    let seed =
        EffortSnapshot { provider: "openai".into(), model: "gpt-6-1".into(), mode: EffortMode::Responses, initial_effort: "low".into(), effort: "low".into() };
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
    let mut h = Harness::new(vec![turn(vec![call("c1", "grep", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let mut spec = Echo::tool().spec().clone();
    spec.name = "grep".into();
    let artifacts = Arc::new(Artifacts(Mutex::new(Vec::new())));
    let reuse = Arc::new(Stored::default());
    h.reuse = Some(reuse.clone());
    let mut run = h.run(config(), vec![Arc::new(BigTool(spec))], vec![AgentMessage::user("go")]);
    run.set_artifact_store(artifacts.clone());
    let output = finish(run).await;
    let result = output.transcript[2].text();
    assert!(result.starts_with("[tool output offloaded: grep → /art/r.txt (29 KB, 1 lines)]"), "{}", &result[..80]);
    assert_eq!(artifacts.0.lock().unwrap()[0].len(), 30_000);
    assert!(reuse.0.lock().unwrap().is_empty(), "the transcript preview is not a full result");
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
    let h = Harness::new(vec![Attempt::Reject(transient), turn(vec![text("SUMMARY"), done(StopReason::EndTurn)])]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let call = OneShotCall { model: "m".into(), max_output_tokens: Some(4096), fast: true, shape: CallShape::compaction() };
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
    let call = SummaryCall { model: "m".into(), max_output_tokens: Some(4096), fast: false, shape: CallShape::compaction() };
    let task = tokio::spawn(async move { one.send("sys", "prompt", &call).await });
    while h.provider.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    h.cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(SummaryFailure::Aborted)));
}

/// A summary call runs on a task of its own, never polled inside the run that asked for it: stacked on a lead's compaction, its
/// second send path overflowed a dev build's 2 MiB worker stack. A caller that stops waiting ends it, leaving nothing running.
#[tokio::test]
async fn a_summary_call_runs_on_a_task_of_its_own_and_ends_with_its_caller() {
    use mixdog_agent::compact::summary_run::SummaryCall;
    use mixdog_agent::compact::summary_run::SummarySender;
    use mixdog_agent::one_shot::CallShape;
    use mixdog_agent::one_shot::OneShot;
    /// The task each retry wait of the call runs on.
    #[derive(Default)]
    struct TaskOfWait(Mutex<Vec<Option<tokio::task::Id>>>);
    #[async_trait]
    impl RetryWait for TaskOfWait {
        async fn wait(&self, _delay: Duration) {
            self.0.lock().unwrap().push(tokio::task::try_id());
        }
    }
    let mut transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    transient.message = "blip".into();
    let h = Harness::new(vec![Attempt::Reject(transient), turn(vec![text("par"), Step::Hang])]);
    let waits = Arc::new(TaskOfWait::default());
    let mut env = h.run_env();
    env.waiter = waits.clone();
    let tool_env = h.tool_env();
    let before = Arc::strong_count(&h.provider);
    let one = OneShot::new(&env, tool_env, h.provider.clone(), h.cancel.clone());
    let call = SummaryCall { model: "m".into(), max_output_tokens: None, fast: false, shape: CallShape::compaction() };
    let caller = tokio::spawn(async move { one.send("sys", "prompt", &call).await });
    let caller_task = caller.id();
    let reached = tokio::time::timeout(Duration::from_secs(5), async {
        while h.provider.requests().len() < 2 && !caller.is_finished() {
            tokio::task::yield_now().await;
        }
    });
    assert!(reached.await.is_ok(), "no second request within 5 s");
    if caller.is_finished() {
        match caller.await {
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            ended => panic!("the call ended before its second request: {:?}", ended.map(|sent| sent.map(|response| response.text))),
        }
    }
    let waited_on = waits.0.lock().unwrap().clone();
    assert_eq!(waited_on.len(), 1, "one retry wait");
    assert!(waited_on[0].is_some_and(|task| task != caller_task), "the call ran on its caller's task {caller_task}: {waited_on:?}");
    caller.abort();
    assert!(caller.await.is_err_and(|error| error.is_cancelled()));
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&h.provider) > before {
            tokio::task::yield_now().await;
        }
    });
    assert!(ended.await.is_ok(), "the call still holds its provider after its caller was dropped");
}

fn overloaded() -> Attempt {
    let mut error = ProviderError::new(ErrorKind::Overloaded, DeliveryState::NotSent);
    error.status = Some(529);
    error.message = "overloaded".into();
    Attempt::Reject(error)
}

fn shaped(model: &str, shape: mixdog_agent::one_shot::CallShape) -> mixdog_agent::one_shot::OneShotCall {
    mixdog_agent::one_shot::OneShotCall { model: model.into(), max_output_tokens: Some(400), fast: false, shape }
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

/// A hop leaves the left model's continuation state and its spent one-shot recoveries behind (`route-fallback.mjs`).
#[tokio::test]
async fn a_switch_drops_the_left_providers_state_and_renews_its_one_shot_recoveries() {
    let mut state = mixdog_core_api::domain::provider::ProviderState::default();
    state.rest.insert("slot".into(), json!({ "id": "resp_1" }));
    let next = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let route = PlayRoute::new(
        RouteDecision::Switch(RouteSwitch {
            provider: next.clone(),
            model: "m2".into(),
            notice: "m1 refused — switched to m2.".into(),
            request: Default::default(),
            effort: None,
            text_only: None,
        }),
        Vec::new(),
    );
    let mut h = Harness::new(vec![turn(vec![
        Step::Event(StreamEvent::ProviderState(state)),
        Step::Fail(ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted)),
    ])]);
    h.route = Some(route);
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    let sent = next.requests();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].options.provider_state.is_none(), "the left provider's continuation state is not carried to the next");
}

#[tokio::test]
async fn a_surface_decision_ends_the_ask_with_the_error_it_carries() {
    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted);
    error.message = "first failed\nEvery model in the fallback chain failed — a/m1: first failed; b/m2: second failed".into();
    let route =
        PlayRoute::new(RouteDecision::Surface(Box::new(ChainSurface { error, attempts: vec![json!({ "provider": "a" })], stopped_before: None })), Vec::new());
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
    let h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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
    use mixdog_agent::cancel::{AGENT_TASK_CANCEL, CLI_ABORT, PARENT_ABORTED, abort_session_turn_reason, close_session_reason, runtime_abort_reason};
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
    let mut h = Harness::new(vec![turn(vec![text("first"), done(StopReason::EndTurn)]), turn(vec![text("second"), done(StopReason::EndTurn)])]);
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
    let described = |name: &str, description: &str| -> Arc<dyn Tool> {
        Arc::new(Echo(ToolSpec { name: name.into(), description: description.into(), ..echo.spec().clone() }))
    };
    let set = |echo_text: &str, ping_text: &str| mixdog_agent::tools::ToolSet::new(vec![described("echo", echo_text), described("mcp__srv__ping", ping_text)]);
    let mut h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.mcp = Some(Arc::new(SwapMcp(std::sync::Mutex::new([set("echo", "ping v1"), set("echo changed", "ping v2")].into()))));
    finish(h.run(config(), vec![echo.clone(), described("mcp__srv__ping", "ping v1")], vec![AgentMessage::user("go")])).await;
    let sent: Vec<Vec<(String, String)>> =
        h.provider.requests().iter().map(|r| r.tools.iter().map(|t| (t.name.clone(), t.description.clone())).collect()).collect();
    let pair = |name: &str, text: &str| (name.to_owned(), text.to_owned());
    assert_eq!(sent[0], [pair("echo", "echo"), pair("mcp__srv__ping", "ping v1")]);
    assert_eq!(sent[1], [pair("echo", "echo"), pair("mcp__srv__ping", "ping v2")]);
}

/// The deferred snapshot of the session adds a discovered catalog tool.
struct SnapshotMcp;

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for SnapshotMcp {
    async fn refresh(&self) {}

    async fn snapshot(
        &self,
        mut tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        messages: &[AgentMessage],
    ) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        assert!(!messages.is_empty(), "the snapshot reads the transcript the request is built from");
        tools.push(mixdog_core_api::domain::provider::ToolDefinition {
            name: "office".into(),
            description: "Create a document.".into(),
            input_schema: json!({"type": "object"}),
            defer_loading: true,
            freeform: None,
        });
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

    async fn snapshot(
        &self,
        _: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
        _: &[AgentMessage],
    ) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        Err("provider tool snapshot: selected tool identity mismatch".into())
    }
}

#[tokio::test]
async fn a_failed_tool_snapshot_fails_the_request() {
    let mut h = Harness::new(vec![turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.mcp = Some(Arc::new(FailingMcp));
    let failure = h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")]).run().await.expect_err("the snapshot threw");
    assert!(
        matches!(&failure.error, AgentError::RequestTools(text) if text == "provider tool snapshot: selected tool identity mismatch"),
        "{:?}",
        failure.error
    );
    assert!(h.provider.requests().is_empty(), "nothing was sent");
}

fn system_message(text: &str) -> AgentMessage {
    use mixdog_core_api::domain::provider::{Content, Message, Role};
    AgentMessage::new(Message::new(Role::System, Content::Text(text.to_owned().into())))
}

/// Migrates at the first boundary, before the loop has a settled request of its own.
struct MigrateMcp(AtomicU64);

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for MigrateMcp {
    async fn refresh(&self) {}

    async fn migrate(&self, messages: &[AgentMessage]) -> Result<Option<Vec<AgentMessage>>, String> {
        let boundary = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert!(
            messages.iter().any(|m| m.role() == mixdog_core_api::domain::provider::Role::System),
            "the transcript the request is built from carries its system prompt"
        );
        Ok((boundary == 0).then(|| vec![system_message("migrated rules")]))
    }
}

/// `migrateToolExposureAtBoundary` runs at every request boundary (`request-boundary.mjs:67`); a migration replaces the
/// working transcript's system prompt, and the provider state of the old surface is not sent again.
#[tokio::test]
async fn the_exposure_migration_runs_at_every_request_boundary() {
    let mut h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("done"), done(StopReason::EndTurn)])]);
    let boundaries = Arc::new(MigrateMcp(AtomicU64::new(0)));
    h.mcp = Some(boundaries.clone());
    finish(h.run(config(), vec![Echo::tool()], vec![system_message("old rules"), AgentMessage::user("go")])).await;
    assert_eq!(boundaries.0.load(std::sync::atomic::Ordering::SeqCst), 2);
    let sent = h.provider.requests();
    let first_system = |request: &mixdog_core_api::domain::provider::ModelRequest| {
        request.messages.iter().find(|m| m.role == mixdog_core_api::domain::provider::Role::System).map(|m| format!("{:?}", m.content))
    };
    assert!(first_system(&sent[0]).unwrap().contains("migrated rules"), "the first request is built from the migrated prompt");
    assert!(first_system(&sent[1]).unwrap().contains("migrated rules"));
}

/// Folds the prompt whenever a rewritten transcript asks, and counts how often it was asked.
#[derive(Default)]
struct FoldMcp {
    folds: AtomicU64,
}

impl FoldMcp {
    fn folds(&self) -> u64 {
        self.folds.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for FoldMcp {
    async fn refresh(&self) {}

    async fn fold_compacted(&self) -> Result<Option<Vec<AgentMessage>>, String> {
        let made = self.folds.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        Ok(Some(vec![system_message(&format!("folded rules {made}"))]))
    }
}

/// The prompt fold a compaction owes lands in the request that follows the compaction, which writes the conversation anew
/// anyway: that request carries the rebuilt system text with the compacted history, the fold is asked for once, and the
/// turn's next request keeps every message the folded one sent.
#[tokio::test]
async fn a_compactions_prompt_fold_lands_in_the_request_that_follows_it() {
    let mut h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100::default()));
    let folds = Arc::new(FoldMcp::default());
    h.mcp = Some(folds.clone());
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    let mut messages = vec![system_message("old rules")];
    messages.extend(eleven_messages());
    finish(h.run(cfg, vec![Echo::tool()], messages)).await;
    assert_eq!(compact_marker(&h).len(), 1, "one compaction, before the turn's first request");
    assert_eq!(folds.folds(), 1, "one fold, with the compaction");
    let sent = h.provider.requests();
    assert_eq!(sent.len(), 2);
    assert_eq!(wire_dump(&sent[0]), ["System:folded rules 1", "User:[summary]", "User:latest"], "the compacted history goes out under the folded prompt");
    let (first, second) = (wire_dump(&sent[0]), wire_dump(&sent[1]));
    assert_eq!(second[..first.len()], first[..], "the next request keeps what the folded one sent");
}

/// A run with no compaction asks for no fold: a prompt is never rebuilt under a cache the turn holds.
#[tokio::test]
async fn a_turn_that_compacts_nothing_folds_nothing() {
    let mut h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("done"), done(StopReason::EndTurn)])]);
    let folds = Arc::new(FoldMcp::default());
    h.mcp = Some(folds.clone());
    finish(h.run(config(), vec![Echo::tool()], vec![system_message("old rules"), AgentMessage::user("go")])).await;
    assert_eq!(folds.folds(), 0);
    assert!(h.provider.requests().iter().all(|request| wire_dump(request)[0] == "System:old rules"));
}

/// Its fold cannot be made.
struct FailingFoldMcp;

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for FailingFoldMcp {
    async fn refresh(&self) {}

    async fn fold_compacted(&self) -> Result<Option<Vec<AgentMessage>>, String> {
        Err("the prompt could not be composed".to_owned())
    }
}

/// A fold that fails after the compaction was adopted fails the turn with the compaction's own record out: the rewrite
/// reached the store, and the pass ended as a changed one, which is what the session counts the compaction and resets
/// its reading by.
#[tokio::test]
async fn a_fold_that_fails_after_a_compaction_leaves_the_compactions_record() {
    let mut h = Harness::new(vec![turn(vec![text("never"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100::default()));
    h.mcp = Some(Arc::new(FailingFoldMcp));
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    let mut messages = vec![system_message("old rules")];
    messages.extend(eleven_messages());
    let failure = h.run(cfg, vec![Echo::tool()], messages).run().await.expect_err("the fold failed");
    assert!(matches!(&failure.error, AgentError::RequestTools(text) if text.contains("could not be composed")), "{:?}", failure.error);
    assert!(h.provider.requests().is_empty(), "nothing is sent under the prompt the fold did not rebuild");
    let replaced = h.sink.replaced.lock().unwrap();
    assert_eq!(replaced.iter().filter(|(_, rewrite)| rewrite.compaction).count(), 1, "the compacted history is the store's");
    let events = h.observer.events();
    let ended_changed = |event: &RunEvent| {
        matches!(event, RunEvent::CompactPass(pass) if matches!(pass.stage, mixdog_agent::env::PassStage::Done { changed: true, .. }))
    };
    assert_eq!(events.iter().filter(|event| ended_changed(event)).count(), 1, "the pass ends as a changed one");
    let marked = compact_marker(&h);
    assert_eq!(marked.len(), 1);
    assert!(matches!(marked[0].status, mixdog_agent::env::CompactStatus::Compacted));
}

/// A compaction whose save failed is not folded: the store still holds the old history under the old prompt, so no fold
/// is asked for, and the turn goes on from the compacted transcript it holds, under the prompt it held before.
#[tokio::test]
async fn a_compaction_the_store_did_not_take_is_not_folded() {
    let mut h = Harness::new(vec![turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100 { keeps_system: true, ..Default::default() }));
    let folds = Arc::new(FoldMcp::default());
    h.mcp = Some(folds.clone());
    h.sink.unstored.store(true, Ordering::Relaxed);
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    let mut messages = vec![system_message("old rules")];
    messages.extend(eleven_messages());
    finish(h.run(cfg, vec![Echo::tool()], messages)).await;
    assert_eq!(compact_marker(&h).len(), 1);
    assert_eq!(folds.folds(), 0, "no fold is asked for on a history the store does not hold");
    assert_eq!(wire_dump(&h.provider.requests()[0]), ["System:old rules", "User:[summary]", "User:latest"]);
}

/// The store's history after a compaction another actor made: its summary, then the rows this run appended since that
/// compaction's snapshot, one of them with thinking signed over the history that left.
struct AppendedSince;

#[async_trait]
impl StoredHistory for AppendedSince {
    async fn reload(&self) -> Result<(Vec<AgentMessage>, u64), String> {
        let signed = json!({
            "role": "assistant", "content": "step",
            "thinkingBlocks": [{ "type": "thinking", "thinking": "t", "signature": "sig" }],
        });
        let signed = mixdog_agent::message_row::message_of_owned(signed).map_err(|(error, _)| error)?;
        Ok((vec![AgentMessage::user("compacted: go"), signed, AgentMessage::user("more")], 3))
    }
}

/// A stale request reloads a history compacted elsewhere, inside the send loop. The request that follows carries that
/// compaction's fold, asked for once, and none of the thinking the appended rows held under the old history; the
/// unbound rows are written, as a silent rewrite and no compaction.
#[tokio::test]
async fn a_reloaded_history_is_sent_folded_with_the_thinking_of_its_appended_rows_unbound() {
    use mixdog_core_api::domain::cache_tail::{TailGateHandle, TailRefusal};
    let mut h = Harness::new(vec![Attempt::Reject(ProviderError::tail_refused(TailRefusal::Stale)), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let folds = Arc::new(FoldMcp::default());
    h.mcp = Some(folds.clone());
    let mut config = config();
    config.options.tail_gate = Some(TailGateHandle(Arc::new(NoBook)));
    config.options.tail_generation = Some(1);
    config.history = Some(Arc::new(AppendedSince));
    finish(h.run(config, vec![Echo::tool()], vec![system_message("old rules"), AgentMessage::user("go")])).await;
    assert_eq!(folds.folds(), 1, "one fold, with the reloaded history");
    let sent = h.provider.requests();
    assert_eq!(wire_dump(&sent[0])[0], "System:old rules");
    assert_eq!(wire_dump(&sent[1]), ["System:folded rules 1", "User:compacted: go", "Assistant:step", "User:more"]);
    assert!(sent[1].messages.iter().all(|message| message.thinking_blocks.is_none()), "no thinking signed over the history that left");
    let replaced = h.sink.replaced.lock().unwrap();
    assert_eq!(replaced.len(), 1, "the unbound rows are stored");
    assert!(!replaced[0].1.compaction, "as a silent rewrite: the compaction is the other actor's");
    assert!(replaced[0].0.iter().all(|message| message.message.thinking_blocks.is_none()));
}

/// A cache owner that offers this run the rewrite of its expired history.
struct OwnsRewrite;

impl mixdog_core_api::domain::cache_tail::TailGate for OwnsRewrite {
    fn admit<'a>(
        &'a self,
        _: mixdog_core_api::domain::cache_tail::Admission<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = mixdog_core_api::domain::cache_tail::Verdict> + Send + 'a>> {
        unreachable!("the scripted provider asks no gate")
    }
    fn settle(&self, _: &mixdog_core_api::domain::cache_tail::Permit, _: Option<mixdog_core_api::domain::cache_tail::Counters>) {}
    fn claim(&self, _: mixdog_core_api::domain::cache_tail::ColdRequest) -> mixdog_core_api::domain::cache_tail::Claim {
        mixdog_core_api::domain::cache_tail::Claim::Owner
    }
    fn resolve(&self, _: u64, _: mixdog_core_api::domain::cache_tail::Resolution) -> Option<mixdog_core_api::domain::cache_tail::Unreduced> {
        None
    }
    fn rebuilt(&self) -> u64 {
        2
    }
    fn snapshot(&self) -> Option<serde_json::Value> {
        None
    }
    fn generation(&self) -> u64 {
        2
    }
    fn wait_for(&self, _: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        unreachable!("the run owns the rewrite")
    }
}

/// The rewrite of an expired history is made inside the send loop: its fold lands in the request that follows it, once.
#[tokio::test]
async fn the_rewrite_of_an_expired_history_is_sent_under_its_fold() {
    use mixdog_core_api::domain::cache_tail::{Cold, ColdRequest, TailGateHandle, TailRefusal};
    let expired = TailRefusal::Rebuild(ColdRequest { ticket: 1, cold: Cold::Expired });
    let mut h = Harness::new(vec![Attempt::Reject(ProviderError::tail_refused(expired)), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    h.compactor = Some(Arc::new(Compactor100::default()));
    let folds = Arc::new(FoldMcp::default());
    h.mcp = Some(folds.clone());
    let mut cfg = config();
    cfg.compact = Some(compact_settings());
    cfg.options.tail_gate = Some(TailGateHandle(Arc::new(OwnsRewrite)));
    cfg.options.tail_generation = Some(1);
    let messages = vec![system_message("old rules"), AgentMessage::user("m0"), AgentMessage::user("m1"), AgentMessage::user("latest")];
    finish(h.run(cfg, vec![Echo::tool()], messages)).await;
    assert_eq!(compact_marker(&h).len(), 1, "one compaction, after the refused request");
    assert_eq!(folds.folds(), 1, "one fold, with it");
    let sent = h.provider.requests();
    assert_eq!(wire_dump(&sent[0])[0], "System:old rules", "the refused request was built before the rewrite");
    assert_eq!(wire_dump(&sent[1])[..2], ["System:folded rules 1", "User:[summary]"]);
}

/// Migrates at the second boundary only: after the first send settled, so the loop holds a guard of the old system prompt.
struct MigrateAfterSendMcp(AtomicU64);

#[async_trait::async_trait]
impl mixdog_agent::env::McpCatalog for MigrateAfterSendMcp {
    async fn refresh(&self) {}

    async fn migrate(&self, _: &[AgentMessage]) -> Result<Option<Vec<AgentMessage>>, String> {
        let boundary = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok((boundary == 1).then(|| vec![system_message("migrated rules")]))
    }
}

/// A migration that rewrites the system prompt after a send settled clears the loop's kept prefix guard with the provider state
/// (`markToolSurfaceMigrated`), so the next send is accepted: its system message is compared with nothing, not with the old one
/// (the migration's intent is no compaction intent, so the guard would call it a rewritten prefix).
#[tokio::test]
async fn a_migration_after_a_send_that_rewrites_the_system_prompt_is_not_a_prefix_mutation() {
    let mut h = Harness::new(vec![turn(vec![call("c1", "echo", json!({})), done(StopReason::ToolUse)]), turn(vec![text("done"), done(StopReason::EndTurn)])]);
    h.mcp = Some(Arc::new(MigrateAfterSendMcp(AtomicU64::new(0))));
    let output = finish(h.run(config(), vec![Echo::tool()], vec![system_message("old rules"), AgentMessage::user("go")])).await;
    let sent = h.provider.requests();
    let system = |request: &mixdog_core_api::domain::provider::ModelRequest| {
        request.messages.iter().find(|m| m.role == mixdog_core_api::domain::provider::Role::System).map(|m| format!("{:?}", m.content)).unwrap_or_default()
    };
    assert!(system(&sent[0]).contains("old rules") && system(&sent[1]).contains("migrated rules"), "the second request carries the migrated prompt");
    assert!(output.carry.prefix_guard.is_some(), "the accepted send is the guard's new baseline");
}

/// The session's MCP catalog is refreshed once per request, at the start of every tool call and, for an MCP call, again once
/// its gate has passed: two requests, one plain and one MCP call make 1 + (1) + (1 + 1) + 1.
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

// Expected values: `fixtures/agent/leaked-toolcall/record.mjs` (the real agent loop over the route's real decoder).

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
    assert_eq!(seen, [("boom".to_owned(), "Error: boom".to_owned()), ("agent".to_owned(), "Error: agent: unknown type \"x\"".to_owned())]);
}

/// Answers `Error: …` text the tool itself declares a success (an MCP result without `isError`).
struct ExplicitSuccessText(ToolSpec);
#[async_trait]
impl Tool for ExplicitSuccessText {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text("Error: not a failure".into())], explicit_success: true, ..ToolOutput::default() })
    }
}

/// `classifyToolReturn`: a tool's own `explicitSuccess` keeps text that starts `Error:` a normal result: not an error to
/// the provider, nothing in the failure log.
#[tokio::test]
async fn an_explicit_success_is_not_classified_by_its_wording() {
    let mut h = Harness::new(vec![turn(vec![call("c1", "agent", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let log = Arc::new(FailureLog::default());
    h.failures = Some(log.clone());
    let mut agent = Echo(Echo::tool().spec().clone());
    agent.0.name = "agent".into();
    let output = finish(h.run(config(), vec![Arc::new(ExplicitSuccessText(agent.0))], vec![AgentMessage::user("go")])).await;
    assert_eq!(dump(&output.transcript)[2..3], ["tool#c1(Normal):Error: not a failure".to_owned()]);
    assert!(log.0.lock().unwrap().is_empty());
}

/// Answers `loaded` with the follow-up body `BODY` and an empty follow-up, as `Skill` answers.
struct SkillBody(ToolSpec);
#[async_trait]
impl Tool for SkillBody {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        let follow_up = |text: &str| FollowUpMessage { text: text.into(), meta: None };
        Ok(ToolOutput { parts: vec![ToolPart::Text("loaded".into())], follow_up_messages: vec![follow_up("BODY"), follow_up("  ")], ..ToolOutput::default() })
    }
}

/// `flushNewMessages` and `isValidNewMessage`: two Skill calls of one batch that inject the same body add it once, and
/// an empty follow-up adds no message.
#[tokio::test]
async fn a_skill_body_already_in_the_messages_is_not_added_again() {
    let h = Harness::new(vec![
        turn(vec![call("c1", "skill", json!({"n": 1})), call("c2", "skill", json!({"n": 2})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    let mut skill = Echo(Echo::tool().spec().clone());
    skill.0.name = "skill".into();
    let output = finish(h.run(config(), vec![Arc::new(SkillBody(skill.0))], vec![AgentMessage::user("go")])).await;
    let injected: Vec<String> = output.transcript.iter().filter(|m| m.source == Some(Source::Skill)).map(AgentMessage::text).collect();
    assert_eq!(injected, ["BODY".to_owned()]);
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
        Some(mixdog_agent::offload::Artifact {
            display_path: "/art/x.txt".into(),
            path: "/art/x.txt".into(),
            lines: content.split('\n').count(),
            sha256: "ab".repeat(32),
        })
    }
}

/// Node: `execute-call.mjs:17-20`, `finalize.mjs:238`; recorded as the tool-failures scenario "a returned error that is offloaded".
#[tokio::test]
async fn an_offloaded_returned_error_keeps_its_failure_row() {
    let mut h = Harness::new(vec![turn(vec![call("c1", "big", json!({})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
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
    // The message the turn sent is the one the next turn reads back from its stored row: a result whose kind became an
    // error says so itself, or the next request's prefix differs from the sent one and the prefix guard refuses the turn
    // (`Session state changed unexpectedly.`).
    assert!(result.message.is_error, "a returned error is an error message");
    let stored = mixdog_agent::message_row::message_of(&mixdog_agent::message_row::row_of(result)).unwrap();
    assert_eq!(format!("{:?}", stored.message), format!("{:?}", result.message));
}

/// Every step of a call's post-processing as one sequence: its failure row and its cache write.
#[derive(Default)]
struct Steps(Arc<Mutex<Vec<String>>>);
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
    async fn lookup(&self, _call: &ToolCall, _cwd: &Path, _touch: bool) -> Option<Reused> {
        None
    }
    async fn prepare(&self, call: &ToolCall, _cwd: &Path) -> Option<Box<dyn ReuseWrite>> {
        Some(Box::new(StepWrite(self.0.clone(), call.id.clone())))
    }
}

struct StepWrite(Arc<Mutex<Vec<String>>>, String);
#[async_trait]
impl ReuseWrite for StepWrite {
    async fn store(self: Box<Self>, _content: &str, _output: &ToolOutput) {
        self.0.lock().unwrap().push(format!("stored {}", self.1));
    }
}

/// `postProcessCompleted` (`finalize.mjs:170-177`) runs per call in call order: a call's failure row and its cache write
/// come before the next call's, and an error call is not cached (`writeCaches` takes only a normal result, `:262-266`).
#[tokio::test]
async fn each_calls_failure_row_and_cache_write_come_in_call_order() {
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"n": 1})), call("c2", "agent", json!({})), call("c3", "echo", json!({"n": 3})), done(StopReason::ToolUse)]),
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

/// The sends the loop reported to the host's trace.
#[derive(Default)]
struct Sends(Mutex<Vec<ProviderSend>>);
impl mixdog_agent::env::ToolFailureLog for Sends {
    fn failed(&self, _call: mixdog_agent::env::FailedCall) {}
    fn stall_abort(&self, _ctx: serde_json::Map<String, serde_json::Value>) {
        panic!("the agent loop never records a watchdog stop");
    }
    fn provider_send(&self, send: ProviderSend) {
        self.0.lock().unwrap().push(send);
    }
}

/// `traceProviderSend` (`settleSendResult`): every completed send reports its iteration, the transcript's length then, and
/// from the second send on the time since the run's tool batch ended (on a still clock every span is 0).
#[tokio::test]
async fn every_completed_send_reports_its_loop_timing() {
    let mut h =
        Harness::new(vec![turn(vec![call("c1", "echo", json!({"n": 1})), done(StopReason::ToolUse)]), turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let sends = Arc::new(Sends::default());
    h.failures = Some(sends.clone());
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    let sent = |iteration, tool_resume_ms, message_count| ProviderSend { iteration, send_ms: 0, pre_send_ms: 0, tool_resume_ms, message_count };
    assert_eq!(*sends.0.lock().unwrap(), [sent(1, None, 1), sent(2, Some(0), 3)]);
}

/// A stream step that moves the run's clock on by `ms`: the response took that long on the wire.
fn elapse(clock: &Arc<FixedClock>, ms: i64) -> Step {
    let clock = Arc::clone(clock);
    let wire: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(async move {
        clock.0.fetch_add(ms, Ordering::Relaxed);
    });
    Step::Wire(wire, "the clock")
}

/// Node: a retry on the provider's own ladder stays inside `provider.send`; `beginIteration` and `sendProviderRequest` restart `iterT0` and `sendStartedAt`.
#[tokio::test]
async fn a_replayed_sends_loop_row_times_the_round_that_settled_it() {
    let clock = Arc::new(FixedClock(AtomicI64::new(1_000)));
    let mut schema = ProviderError::new(ErrorKind::ToolSchemaRejected, DeliveryState::Accepted);
    schema.status = Some(400);
    schema.message = "bad request".into();
    schema.rejected_tool = Some("echo".into());
    let mut h = Harness {
        clock: clock.clone(),
        ..Harness::new(vec![
            turn(vec![elapse(&clock, 3), Step::Fail(ProviderError::transport(TransportFault::Reset, DeliveryState::Ambiguous))]),
            turn(vec![elapse(&clock, 4), call("c1", "echo", json!({"n": 1})), done(StopReason::ToolUse)]),
            turn(vec![elapse(&clock, 6), Step::Fail(schema)]),
            turn(vec![elapse(&clock, 5), text("ok"), done(StopReason::EndTurn)]),
        ])
    };
    let sends = Arc::new(Sends::default());
    h.failures = Some(sends.clone());
    finish(h.run(config(), vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(h.provider.requests().len(), 4);
    assert_eq!(
        *sends.0.lock().unwrap(),
        [
            // Both attempts of the first send, from the iteration's start.
            ProviderSend { iteration: 1, send_ms: 7, pre_send_ms: 0, tool_resume_ms: None, message_count: 1 },
            // The rebuilt round alone: it began when the refused one ended, 6 ms after the tool batch.
            ProviderSend { iteration: 2, send_ms: 5, pre_send_ms: 0, tool_resume_ms: Some(6), message_count: 3 },
        ]
    );
}

/// A call whose arguments the provider could not parse is answered with the retry notice and never dispatched.
#[tokio::test]
async fn a_call_with_unparseable_arguments_is_answered_with_the_retry_notice_and_not_run() {
    let h = Harness::new(vec![
        turn(vec![
            call("c1", "echo", json!({"__invalidToolArgs": true, "__rawArguments": "{\"a\":", "__parseError": "Unexpected end of JSON input"})),
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

/// The membership check of the second call's admission lets the first call's switch land.
struct LandsTheSwitch {
    go: Arc<tokio::sync::Notify>,
    landed: tokio::sync::watch::Receiver<bool>,
    captured: Arc<Mutex<Vec<std::path::PathBuf>>>,
}
#[async_trait]
impl ResultReuse for LandsTheSwitch {
    async fn has_candidate(&self, _call: &ToolCall, _cwd: &Path) -> bool {
        self.go.notify_one();
        let _ = self.landed.clone().wait_for(|landed| *landed).await;
        false
    }
    async fn lookup(&self, _call: &ToolCall, _cwd: &Path, _touch: bool) -> Option<Reused> {
        None
    }
    async fn prepare(&self, call: &ToolCall, cwd: &Path) -> Option<Box<dyn ReuseWrite>> {
        if call.name == "probe" {
            self.captured.lock().unwrap().push(cwd.to_path_buf());
        }
        None
    }
}

/// Node: `startEagerRun` prepares each call from the folder the session holds as it starts (recorded: `switch-project-turn-cases`, "the switch and the file are one batch").
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
    let captured = Arc::new(Mutex::new(Vec::new()));
    let mut h = Harness::new(vec![
        turn(vec![call("c1", "switch", json!({})), call("c2", "probe", json!({})), done(StopReason::ToolUse)]),
        turn(vec![call("c3", "probe", json!({})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
    h.reuse = Some(Arc::new(LandsTheSwitch { go: go.clone(), landed: landed_rx, captured: captured.clone() }));
    let mut cfg = config();
    cfg.live_cwd = Some(Arc::new({
        let live = live.clone();
        move || Some(live.lock().unwrap().clone())
    }));
    let tools: Vec<Arc<dyn Tool>> =
        vec![Arc::new(SwitchTool { spec: switch_spec, live: live.clone(), go, landed: landed_tx }), Arc::new(WhereTool(probe_spec, ran.clone()))];
    finish(h.run(cfg, tools, vec![AgentMessage::user("go")])).await;
    let projects = [a.as_path().to_path_buf(), live.lock().unwrap().as_path().to_path_buf()];
    assert_ne!(projects[0], projects[1]);
    assert_eq!(*ran.lock().unwrap(), projects);
    assert_eq!(*captured.lock().unwrap(), projects);
}

// ---------------------------------------------------------------------------
// Provider recoveries the loop drives: the content-filter replay and the provider's own re-issue of a send
// ---------------------------------------------------------------------------

/// A `content_filter` refusal as the Responses decoders type it (`markContentFilter`: code `content_filter`, a policy
/// refusal).
fn content_filtered() -> Attempt {
    let mut error = ProviderError::new(ErrorKind::Policy, DeliveryState::Accepted);
    error.code = Some("content_filter".into());
    error.message = "OpenAI response.incomplete: content_filter".into();
    Attempt::Reject(error)
}

/// A harness over `Scripted` judged by the production decider, under `policy`.
fn judged(script: Vec<Attempt>, policy: RetryPolicy) -> (Harness, Arc<Scripted>) {
    let provider = Scripted::with_policy(script, policy);
    (Harness::with_adapter(provider.clone()), provider)
}

/// B-11 (a decided difference from Node): a server that stays unavailable is sent to once on the request row's ladder
/// (4 retries), then once per recovery lap on 15, 30 and 60 s, and the stages count the whole run as one n/N.
#[tokio::test]
async fn a_persistent_5xx_sends_once_per_recovery_lap_and_counts_one_run() {
    let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    error.status = Some(503);
    error.message = "unavailable".into();
    let h = Harness::with_policy((0..8).map(|_| Attempt::Reject(error.clone())).collect(), RetryPolicy::codex_default());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the outage surfaces");
    assert!(matches!(&failure.error, AgentError::Provider(e) if e.status == Some(503)), "{}", failure.error);
    assert_eq!(h.provider.requests().len(), 8, "1 send + 4 retries + 3 recovery laps of one send");
    let waits = h.waiter.0.lock().unwrap().clone();
    assert_eq!(waits.len(), 7);
    assert_eq!(waits[4..], [Duration::from_secs(15), Duration::from_secs(30), Duration::from_secs(60)]);
    let stages: Vec<(u32, u32)> = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::Reconnecting { attempt, max, .. }) => Some((attempt, max)),
            _ => None,
        })
        .collect();
    assert_eq!(stages, (1..=7).map(|n| (n, 7)).collect::<Vec<_>>());
}

/// `isReplayableContentFilter` + `contentFilterNotice` (`send-with-recovery.mjs:352-366, 464-475`): on a provider that
/// opted in, a content-filter stop is replayed after the transport ladder's wait with the guidance notice appended
/// once, and the notice is part of the transcript under the `content-filter-recovery` source.
#[tokio::test]
async fn a_content_filter_stop_is_replayed_with_the_guidance_notice_on_an_opted_in_provider() {
    let mut policy = RetryPolicy::codex_default();
    policy.content_filter_retryable = true;
    let (h, provider) = judged(vec![content_filtered(), content_filtered(), turn(vec![text("ok"), done(StopReason::EndTurn)])], policy);
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    const NOTICE: &str = "[mixdog-runtime] The previous response was stopped by the provider content filter before it completed. Continue the task, but rephrase or avoid the content that likely triggered the filter; do not repeat it verbatim.";
    let requests = provider.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(wire_dump(&requests[0]), ["User:go"]);
    // `appendRecoveryNotice`: a repeated stop keeps the single notice already at the tail.
    let second = wire_dump(&requests[1]);
    assert_eq!(second.len(), 2);
    assert!(second[1].starts_with("User:") && second[1].contains(NOTICE), "{second:?}");
    assert_eq!(wire_dump(&requests[2]), wire_dump(&requests[1]));
    let notices: Vec<&AgentMessage> = output.transcript.iter().filter(|m| m.source == Some(Source::ContentFilterRecovery)).collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].text(), NOTICE);
    // `TRANSPORT_RETRY_BACKOFF_MS`: 5 s, then 15 s (the jitter's midpoint sample adds nothing).
    assert_eq!(*h.waiter.0.lock().unwrap(), [Duration::from_secs(5), Duration::from_secs(15)]);
    let stages: Vec<(u32, u32)> = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Stage(Stage::Reconnecting { attempt, max, .. }) => Some((attempt, max)),
            _ => None,
        })
        .collect();
    assert_eq!(stages, [(1, 3), (2, 3)], "attempt n of TRANSPORT_RETRY_MAX");
}

/// The replay is bounded by `TRANSPORT_RETRY_MAX` (3), and a provider that did not opt in surfaces the stop at once.
#[tokio::test]
async fn a_content_filter_stop_surfaces_past_the_transport_budget_and_without_the_opt_in() {
    let mut policy = RetryPolicy::codex_default();
    policy.content_filter_retryable = true;
    let (h, provider) = judged((0..4).map(|_| content_filtered()).collect(), policy);
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the budget is spent");
    assert!(matches!(&failure.error, AgentError::Provider(e) if e.code.as_deref() == Some("content_filter")));
    assert_eq!(provider.requests().len(), 4, "the first send and three replays");

    let (h, provider) = judged(vec![content_filtered()], RetryPolicy::codex_default());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("no opt-in");
    assert!(matches!(failure.error, AgentError::Provider(_)));
    assert_eq!(provider.requests().len(), 1);
    assert!(h.waiter.0.lock().unwrap().is_empty());
}

/// A provider with a re-issue of its own (`ProviderAdapter::recover_spent`), scripted: `cut` answers a stream that
/// died after output was shown, `spent` a ladder that ended.
struct Reissuing {
    inner: Arc<Scripted>,
    cut: bool,
    spent: bool,
    reissues: Mutex<VecDeque<Attempt>>,
    reissued: Mutex<Vec<Arc<ModelRequest>>>,
}

impl Reissuing {
    fn new(script: Vec<Attempt>, reissues: Vec<Attempt>, cut: bool, spent: bool) -> Arc<Self> {
        Arc::new(Self { inner: Scripted::new(script), cut, spent, reissues: Mutex::new(reissues.into()), reissued: Mutex::default() })
    }
}

#[async_trait]
impl ProviderAdapter for Reissuing {
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.inner.attempt(request).await
    }
    fn recovers_cut(&self, _request: &ModelRequest, failure: &ProviderError) -> bool {
        self.cut && failure.exposure.text_emitted
    }
    fn recovers_spent(&self, _request: &ModelRequest, _failure: &ProviderError) -> bool {
        self.spent
    }
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.reissued.lock().unwrap().push(request);
        match self.reissues.lock().unwrap().pop_front() {
            Some(Attempt::Stream(steps)) => Ok(Box::new(ScriptedStream(steps.into(), None, Arc::default(), None))),
            Some(Attempt::Reject(error)) => Err(error),
            None => panic!("re-issue script exhausted"),
        }
    }
    async fn settle_send(&self, group: &str, end: mixdog_core_api::domain::provider::SendEnd) {
        self.inner.settle_send(group, end).await;
    }
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }
}

fn whole(text: &str) -> Attempt {
    turn(vec![Step::Event(StreamEvent::FinalContent(text.into())), done(StopReason::EndTurn)])
}

fn truncated() -> ProviderError {
    ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted)
}

/// `decideStreamError` -> `recoverNonStreaming` (anthropic-midstream-recovery.mjs:176-178, anthropic-recovery-guards.mjs):
/// a stream that dies after text was shown is answered by the provider's re-issue once the owner withdrew the text, in
/// place of another streaming attempt, with no wait.
#[tokio::test]
async fn a_stream_that_dies_after_shown_text_is_reissued_by_the_provider_once_the_text_is_withdrawn() {
    let provider = Reissuing::new(vec![turn(vec![text("par"), Step::Fail(truncated())])], vec![whole("whole answer")], true, false);
    let h = Harness::with_adapter(provider.clone());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "whole answer");
    assert_eq!(provider.inner.requests().len(), 1, "no second streaming attempt");
    let reissued = provider.reissued.lock().unwrap().clone();
    assert_eq!(reissued.len(), 1);
    assert_eq!(wire_dump(&reissued[0]), wire_dump(&provider.inner.requests()[0]), "the same request");
    assert_eq!(reissued[0].options.send_group, provider.inner.requests()[0].options.send_group, "one logical send");
    assert!(h.waiter.0.lock().unwrap().is_empty(), "the re-issue follows at once");
}

/// No acknowledgement, no re-issue (`refuseReplay`): the failure takes the loop's ordinary path, and a provider without
/// the re-issue is retried as a stream.
#[tokio::test]
async fn a_dead_stream_is_not_reissued_without_the_withdrawal_or_by_a_provider_that_has_none() {
    let provider = Reissuing::new(vec![turn(vec![text("par"), Step::Fail(truncated())])], vec![], true, false);
    let mut h = Harness::with_adapter(provider.clone());
    h.observer = Observer::new(Retracted::Refused);
    let _ = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await;
    assert!(provider.reissued.lock().unwrap().is_empty());

    let provider =
        Reissuing::new(vec![turn(vec![text("par"), Step::Fail(truncated())]), turn(vec![text("again"), done(StopReason::EndTurn)])], vec![], false, false);
    let h = Harness::with_adapter(provider.clone());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "again");
    assert!(provider.reissued.lock().unwrap().is_empty());
    assert_eq!(provider.inner.requests().len(), 2);
}

/// A refusal the ladder does not retry (`x-should-retry: false`).
fn final_503(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    error.status = Some(503);
    error.should_retry = Some(false);
    error.message = message.into();
    error
}

/// `recoverCompatNonStreaming` (openai-compat-chat-send.mjs:227-236): when the provider's ladder ends, its re-issue
/// runs once; its answer is the turn.
#[tokio::test]
async fn a_send_whose_ladder_ended_is_reissued_once_and_its_answer_is_the_turn() {
    let provider = Reissuing::new(vec![Attempt::Reject(final_503("ladder"))], vec![whole("recovered")], false, true);
    let h = Harness::with_adapter(provider.clone());
    let output = finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "recovered");
    assert_eq!((provider.inner.requests().len(), provider.reissued.lock().unwrap().len()), (1, 1));
}

/// A first-byte timeout past the policy's retries is the provider's terminal verdict (`providerRecoveryTerminal`): the
/// send ends there with the two requests it made, and the non-streaming re-issue that an ordinary exhaustion still gets
/// once is never made (`canFallbackNonStreaming`).
#[tokio::test]
async fn a_terminal_first_byte_verdict_ends_the_send_without_the_non_streaming_reissue() {
    let first_byte = |terminal: bool| {
        let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Ambiguous);
        error.timed_out = true;
        error.timeout_phase = Some(mixdog_core_api::domain::provider::StreamTimeoutPhase::Headers);
        error.message = "first byte timed out".into();
        error.recovery_exhausted = terminal;
        error.recovery_terminal = terminal;
        error.should_retry = terminal.then_some(false);
        Attempt::Reject(error)
    };
    let provider = Reissuing::new(vec![first_byte(false), first_byte(true)], vec![whole("recovered")], false, true);
    let h = Harness::with_adapter(provider.clone());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("the terminal timeout surfaces");
    assert!(matches!(&failure.error, AgentError::Provider(e) if e.recovery_terminal), "{}", failure.error);
    assert_eq!((provider.inner.requests().len(), provider.reissued.lock().unwrap().len()), (2, 0), "two sends, no re-issue");
}

/// `if (!recovered) throw streamErr`: a re-issue that fails too is dropped and the ladder's own failure surfaces.
#[tokio::test]
async fn a_failed_reissue_surfaces_the_ladders_failure() {
    let provider = Reissuing::new(vec![Attempt::Reject(final_503("ladder"))], vec![Attempt::Reject(final_503("re-issue"))], false, true);
    let h = Harness::with_adapter(provider.clone());
    let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("both failed");
    assert!(matches!(&failure.error, AgentError::Provider(e) if e.message == "ladder"), "{}", failure.error);
    assert_eq!((provider.inner.requests().len(), provider.reissued.lock().unwrap().len()), (1, 1), "the re-issue runs once");
}

#[tokio::test]
async fn a_terminal_unary_refusal_replaces_the_cut_stream_error_without_losing_usage() {
    use mixdog_ai::admission::{Admission, LaneKey};
    use mixdog_ai::broker::{AttemptSink, ModelBroker, SendError, SendRequest};
    use mixdog_core_api::domain::provider::Usage;

    #[derive(Default)]
    struct Bills(Vec<(Usage, Option<String>)>);
    impl AttemptSink for Bills {
        fn event(&mut self, event: StreamEvent) {
            assert!(matches!(event, StreamEvent::Usage(_)), "unexpected output: {event:?}");
        }
        fn discard(&mut self) {}
        fn abandoned(&mut self, usage: &Usage, model: Option<&str>) {
            self.0.push((usage.clone(), model.map(str::to_owned)));
        }
    }

    for (kind, status, unary_input) in [(ErrorKind::Policy, None, Some(13)), (ErrorKind::Permission, Some(403), None)] {
        let stream_usage = Usage { input_tokens: 11, ..Usage::default() };
        let mut cut = truncated();
        cut.should_retry = Some(false);
        cut.partial_usage = Some(Box::new(stream_usage.clone()));
        cut.partial_model = Some("served-model".into());
        let mut unary = ProviderError::new(kind, DeliveryState::Accepted);
        unary.status = status;
        unary.recovery_terminal = true;
        unary.partial_usage = unary_input.map(|input_tokens| Box::new(Usage { input_tokens, ..Usage::default() }));
        let provider = || {
            Reissuing::new(
                vec![turn(vec![Step::Event(StreamEvent::Usage(stream_usage.clone())), Step::Fail(cut.clone())])],
                vec![Attempt::Reject(unary.clone())],
                false,
                true,
            )
        };
        let check = |error: &ProviderError| {
            assert_eq!((error.kind, error.status, error.transport.as_ref()), (kind, status, None));
            assert_eq!(error.partial_usage.as_deref().map(|usage| usage.input_tokens), unary_input);
        };

        let agent = provider();
        let h = Harness::with_adapter(agent.clone());
        let failure = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await.expect_err("unary refused");
        let AgentError::Provider(error) = &failure.error else { panic!("{}", failure.error) };
        check(error);
        assert_eq!((agent.inner.requests().len(), agent.reissued.lock().unwrap().len()), (1, 1));

        let remote = provider();
        let admission = Arc::new(Admission::new());
        let lane = admission.lane(&LaneKey::new("scripted".into(), "default"), Default::default());
        let broker = ModelBroker::new(admission, Arc::new(mixdog_ai::retry::StandardRetryDecider));
        let mut request = (*agent.inner.requests()[0]).clone();
        request.options.send_group = None;
        let request = SendRequest { request: Arc::new(request), lane, admission: Default::default() };
        let mut bills = Bills::default();
        let failure = broker.send(remote.as_ref(), request, &mut bills, &CancellationToken::new()).await.expect_err("unary refused");
        let SendError::Provider(error) = &failure else { panic!("{failure:?}") };
        check(error);
        assert_eq!(bills.0, [(stream_usage, Some("served-model".into()))]);
        assert_eq!((remote.inner.requests().len(), remote.reissued.lock().unwrap().len()), (1, 1));
    }
}

#[tokio::test]
async fn a_summary_cut_by_a_broken_stream_is_not_an_answer_and_a_later_attempt_is() {
    use mixdog_agent::compact::summary_run::SummaryCall;
    use mixdog_agent::compact::summary_run::SummaryFailure;
    use mixdog_agent::compact::summary_run::SummarySender;
    use mixdog_agent::one_shot::CallShape;
    use mixdog_agent::one_shot::OneShot;
    let call = SummaryCall { model: "m".into(), max_output_tokens: None, fast: false, shape: CallShape::compaction() };
    // text, then the stream dies on every attempt: a one-shot call withdraws the cut text and replays it on the provider's
    // ladder (every attempt cut again here), so the script covers the whole ladder and the compaction still has no summary
    let h = Harness::new((0..40).map(|_| turn(vec![text("## Goal\n- par"), Step::Fail(truncated())])).collect());
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let lost = one.send("sys", "prompt", &call).await;
    assert!(matches!(lost, Err(SummaryFailure::Failed(_))), "a cut summary is never stored: {:?}", lost.map(|r| r.text));
    // the same cut followed by a successful attempt: the whole answer is the summary
    let h = Harness::new(vec![turn(vec![text("## Goal\n- par"), Step::Fail(truncated())]), turn(vec![text("whole summary"), done(StopReason::EndTurn)])]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let kept = one.send("sys", "prompt", &call).await.expect("the later attempt");
    assert_eq!(kept.text, "whole summary");
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
            hooks: None,
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
            decider: self
                .real
                .as_ref()
                .map_or_else(|| Arc::new(MockRetryDecider) as Arc<dyn mixdog_core_api::domain::retry::RetryDecider>, |(_, decider)| decider.clone()),
            steer: self.steer.clone(),
            observer: self.observer.clone(),
            sink: self.sink.clone(),
            gate: Arc::clone(&self.gate),
            guards: Arc::new(NoGuards),
            compactor: self.compactor.clone().map(|c| c as Arc<dyn Compactor>).or_else(|| self.real_compactor.clone()),
            route: self.route.clone(),
            skills: None,
            hooks: self.hooks.clone(),
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
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: self.approvals.clone(),
            files: self.sandbox.as_ref().map_or_else(|| Arc::new(MockFileService::default()), |(_, files)| files.clone()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            deadline_of: None,
            notify: None,
            review: None,
        }
    }

    fn run_with_builtins(&self, config: RunConfig, tools: Vec<Arc<dyn Tool>>, builtins: Vec<String>, messages: Vec<AgentMessage>) -> Run {
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
#[tokio::test(start_paused = true)]
async fn websocket_close_1000_uses_owner_retraction_without_refilling_the_send_budget() {
    use mixdog_ai::providers::openai::scripted::{self, Dialed, ScriptedDial, Wire};
    use mixdog_ai::providers::openai::switch::TransportMode;

    for (reasoning, reset_channel, ack, failures, succeeds, waits) in [
        (false, true, Retracted::Withdrawn, 1, true, 1),
        (false, true, Retracted::Refused, 1, false, 0),
        (false, false, Retracted::Refused, 1, true, 0),
        (true, false, Retracted::Refused, 1, true, 1),
        (false, true, Retracted::Withdrawn, 4, false, 3),
        (true, false, Retracted::Refused, 4, false, 3),
    ] {
        let delta = if reasoning {
            r#"{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#
        } else {
            r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg","delta":"visible"}"#
        };
        let mut script: Vec<_> = (0..failures)
            .map(|_| Dialed::Socket {
                frames: vec![r#"{"type":"response.created","response":{"id":"cut"}}"#.into(), delta.into()],
                close: (1000, String::new()),
            })
            .collect();
        script.push(Dialed::Socket {
            frames: vec![r#"{"type":"response.completed","response":{"id":"continued","status":"completed","output":[{"type":"message","id":"msg","role":"assistant","content":[{"type":"output_text","text":"continued"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}"#.into()],
            close: (1000, String::new()),
        });
        let dial = ScriptedDial::with(script);
        let mut h = Harness::with_adapter(scripted::adapter(dial.clone(), mixdog_rt::testing::tokens().cpu_bulk, TransportMode::WsDelta));
        h.observer = Observer::new(ack);
        Arc::get_mut(&mut h.observer).unwrap().reset_channel = reset_channel;
        let route = PlayRoute::new(RouteDecision::Fail("fallback must not be entered".into()), Vec::new());
        if succeeds {
            h.route = Some(route.clone());
        }
        let result = h.run(config(), vec![], vec![AgentMessage::user("go")]).run().await;
        if succeeds {
            let output = result.unwrap_or_else(|e| {
                panic!(
                    "Node's owner recovery continues this close (reasoning {reasoning}, reset channel {reset_channel}, {ack:?}, {failures} failures): {:?}",
                    e.error
                )
            });
            // Text shown with no way to withdraw it is kept, and the next response continues it.
            let kept = if !reasoning && !reset_channel { "visible" } else { "" };
            assert_eq!(output.response.content, format!("{kept}continued"));
            assert!(route.asked.lock().unwrap().is_empty());
        } else {
            let failure = result.expect_err("a refused text reset or spent outer budget ends replay");
            let AgentError::Provider(error) = failure.error else { panic!("the close must surface") };
            assert_eq!(error.transport, Some(TransportFault::WsClose { code: Some(1000) }));
        }
        let upgrades = dial.wire().iter().filter(|event| matches!(event, Wire::Upgrade { .. })).count();
        assert_eq!(upgrades, failures + usize::from(succeeds), "every owner replay opens a fresh socket");
        assert_eq!(
            *h.waiter.0.lock().unwrap(),
            [5, 15, 30][..waits].iter().map(|s| Duration::from_secs(*s)).collect::<Vec<_>>(),
            "Node's bounded outer transport ladder, not another five-retry send ladder"
        );
    }
}
#[tokio::test]
async fn a_quota_hop_sends_the_destination_tuning_and_keeps_prior_work() {
    let mut earlier = AgentMessage::assistant("earlier answer", Vec::new());
    earlier.message.thinking_blocks = Some(json!([{ "type": "thinking", "thinking": "private", "signature": "sig" }]));
    let next = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let segments = vec![UsageSegment { provider: "a".into(), model: "m1".into(), usage: Default::default() }];
    let route = PlayRoute::new(
        RouteDecision::Switch(RouteSwitch {
            provider: next.clone(),
            model: "gpt-6.2-sol".into(),
            notice: "m1 refused — switched to m2.".into(),
            request: mixdog_agent::env::RouteSwitchRequest {
                options: mixdog_core_api::domain::provider::RequestOptions {
                    effort: Some("high".into()),
                    fast: true,
                    model_parameters: Some(json!({ "serviceTier": "ultrafast" })),
                    ..Default::default()
                },
                ..Default::default()
            },
            effort: None,
            text_only: None,
        }),
        segments.clone(),
    );
    let refused = Attempt::Reject(ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::NotSent));
    let mut h = Harness::new(vec![refused]);
    h.route = Some(route.clone());
    let mut cfg = config();
    cfg.options.effort = Some("medium".into());
    cfg.options.model_parameters = Some(json!({ "verbosity": "low" }));
    cfg.options.model_max_output_tokens = Some(128_000);
    let output = finish(h.run(cfg, vec![], vec![AgentMessage::user("first"), earlier, AgentMessage::user("go")])).await;
    // The next provider got the conversation without the first one's reasoning envelopes.
    let sent = next.requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(h.provider.requests().len(), 1);
    assert_eq!(sent[0].options.model_max_output_tokens, None, "the departing model's output ceiling does not travel");
    assert_eq!(sent[0].model, "gpt-6.2-sol");
    assert_eq!(sent[0].options.effort.as_deref(), Some("high"));
    assert!(sent[0].options.fast);
    assert_eq!(sent[0].options.model_parameters, Some(json!({ "serviceTier": "ultrafast" })));
    assert!(output.transcript.iter().all(|m| m.message.thinking_blocks.is_none()), "replay stripped from the live messages");
    assert!(sent[0].messages.iter().all(|m| m.thinking_blocks.is_none()), "and from the request");
    assert_eq!(output.transcript.iter().find(|m| m.text() == "earlier answer").map(|m| m.text()), Some("earlier answer".to_owned()));
    // The loop told the hop the error and the running usage (none yet), and read the segments at the end.
    assert_eq!(*route.asked.lock().unwrap(), [(ErrorKind::QuotaExhausted, None)]);
    assert_eq!(output.usage_segments, segments);
    assert_eq!(route.current.lock().unwrap().as_ref().map(|c| c.1.as_str()), Some("gpt-6.2-sol"));
    let events = h.observer.events();
    assert!(events.iter().any(|e| matches!(e, RunEvent::Stage(Stage::Notice { message, tone: Tone::Info }) if message == "m1 refused — switched to m2.")));
}
/// A hop that rewrote the session's prompt hands the run the session's system messages: the destination's first request
/// leads with them and not with what the route being left was sent, the conversation after them is kept, and the run's
/// transcript holds them from then on. A hop that hands none keeps the run's own.
#[tokio::test]
async fn a_hop_sends_the_destination_the_system_messages_the_hop_wrote() {
    let system = |text: &str| {
        let mut message = AgentMessage::user(text);
        message.message.role = mixdog_core_api::domain::provider::Role::System;
        message
    };
    for rewritten in [true, false] {
        let next = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
        let route = PlayRoute::new(
            RouteDecision::Switch(RouteSwitch {
                provider: next.clone(),
                model: "m2".into(),
                notice: "m1 refused — switched to m2.".into(),
                request: mixdog_agent::env::RouteSwitchRequest {
                    system: rewritten.then(|| vec![system("rules"), system("roster of the bridge"), system("env")]),
                    ..Default::default()
                },
                effort: None,
                text_only: None,
            }),
            Vec::new(),
        );
        let mut h = Harness::new(vec![Attempt::Reject(ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::NotSent))]);
        h.route = Some(route);
        let output = finish(h.run(config(), vec![], vec![system("rules"), system("native roster"), AgentMessage::user("go")])).await;
        let sent = next.requests();
        assert_eq!(sent.len(), 1);
        let leading = if rewritten { vec!["System:rules", "System:roster of the bridge", "System:env"] } else { vec!["System:rules", "System:native roster"] };
        let expected: Vec<String> = leading.into_iter().chain(["User:go"]).map(str::to_owned).collect();
        assert_eq!(wire_dump(&sent[0]), expected, "rewritten={rewritten}");
        let kept: Vec<String> = output.transcript.iter().filter(|m| m.message.role == mixdog_core_api::domain::provider::Role::System).map(|m| m.text()).collect();
        assert_eq!(kept, expected.iter().filter_map(|line| line.strip_prefix("System:")).collect::<Vec<_>>(), "rewritten={rewritten}");
    }
}
/// A route fallback that reconsiders once, on its second ask: the request after a tool round.
struct ReturnRoute {
    asked: Mutex<u32>,
    switch: Mutex<Option<RouteSwitch>>,
}

#[async_trait]
impl RouteFallback for ReturnRoute {
    async fn advance(&self, error: ProviderError, _: Option<&mixdog_core_api::domain::provider::Usage>) -> RouteDecision {
        RouteDecision::Surface(Box::new(mixdog_agent::env::ChainSurface { error, attempts: Vec::new(), stopped_before: None }))
    }
    async fn reconsider(&self, _: Option<&mixdog_core_api::domain::provider::Usage>) -> Result<Option<RouteSwitch>, String> {
        let mut asked = self.asked.lock().unwrap();
        *asked += 1;
        Ok(if *asked == 2 { self.switch.lock().unwrap().take() } else { None })
    }
    fn usage_segments(&self, _: &mixdog_core_api::domain::provider::Usage, _: (&str, &str)) -> Vec<UsageSegment> {
        Vec::new()
    }
}

/// A route the session's configured order now prefers is taken before the request that follows a tool round: that request
/// goes to the new route with its own tuning and the work already done, the request before it was not interrupted, and no
/// request was sent to the route being left to learn it.
#[tokio::test]
async fn a_reconsidered_route_takes_the_request_after_a_tool_round() {
    let next = Scripted::new(vec![turn(vec![text("done"), done(StopReason::EndTurn)])]);
    let route = Arc::new(ReturnRoute {
        asked: Mutex::new(0),
        switch: Mutex::new(Some(RouteSwitch {
            provider: next.clone(),
            model: "claude-fable-5-2".into(),
            notice: "available again".into(),
            request: mixdog_agent::env::RouteSwitchRequest {
                options: mixdog_core_api::domain::provider::RequestOptions { effort: Some("medium".into()), ..Default::default() },
                ..Default::default()
            },
            effort: None,
            text_only: None,
        })),
    });
    let mut h = Harness::new(vec![turn(vec![text("looking"), call("c1", "echo", json!({"a": 1})), done(StopReason::ToolUse)])]);
    h.route = Some(route.clone());
    let mut cfg = config();
    cfg.options.effort = Some("high".into());
    let output = finish(h.run(cfg, vec![Echo::tool()], vec![AgentMessage::user("go")])).await;
    assert_eq!(output.response.content, "done");
    assert_eq!(h.provider.requests().len(), 1, "the route being left was sent the one request before the reconsideration");
    assert_eq!(h.provider.requests()[0].options.effort.as_deref(), Some("high"));
    let sent = next.requests();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].model, "claude-fable-5-2");
    assert_eq!(sent[0].options.effort.as_deref(), Some("medium"));
    assert_eq!(wire_dump(&sent[0]), ["User:go", "Assistant:looking", "Tool:echo:{\"a\":1}"], "the tool round already done is not replayed or lost");
    assert_eq!(*route.asked.lock().unwrap(), 2);
    let events = h.observer.events();
    assert!(events.iter().any(|e| matches!(e, RunEvent::Stage(Stage::Notice { message, tone: Tone::Info }) if message == "available again")));
}

/// A capture that records the model of each send and the route changes it was told of.
struct RouteTap(Arc<SideLog>);

impl mixdog_agent::env::SendTap for RouteTap {
    fn begin(&self, request: &ModelRequest) -> Box<dyn mixdog_agent::env::SendTicket> {
        self.0.0.lock().unwrap().push(format!("begin:{}", request.model));
        Box::new(SideTicket(self.0.clone()))
    }
    fn route_changed(&self, provider_name: &str, _: &Arc<dyn ProviderAdapter>) {
        self.0.0.lock().unwrap().push(format!("route:{provider_name}"));
    }
}

/// A compactor that remembers the route it was moved to.
struct Seating {
    inner: Arc<Compactor100>,
    seated: Arc<Mutex<Vec<(String, Option<u64>)>>>,
}

#[async_trait]
impl Compactor for Seating {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        self.inner.estimate_tokens(messages)
    }
    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        self.inner.reduces(request).await
    }
    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.inner.compact(request).await
    }
    fn resized(&self, seated: &mixdog_agent::env::SeatedRoute) -> Option<Arc<dyn Compactor>> {
        self.seated.lock().unwrap().push((seated.header["provider"].as_str().unwrap().to_owned(), seated.settings.context_window));
        Some(Arc::new(Seating { inner: self.inner.clone(), seated: self.seated.clone() }))
    }
}

/// After a quota hop the run's request capture and its compactor are on the destination: the send that follows is captured
/// as a send on the destination's provider, and the compactor is told the route (provider and window) it now serves.
#[tokio::test]
async fn a_quota_hop_moves_the_request_capture_and_the_compactor_to_the_destination() {
    let log = Arc::new(SideLog::default());
    let seated = Arc::new(Mutex::new(Vec::new()));
    let next = Scripted::new(vec![turn(vec![text("ok"), done(StopReason::EndTurn)])]);
    let route = PlayRoute::new(
        RouteDecision::Switch(RouteSwitch {
            provider: next.clone(),
            model: "gpt-6.2-sol".into(),
            notice: "m refused — switched to gpt-6.2-sol.".into(),
            request: mixdog_agent::env::RouteSwitchRequest {
                compact: Some(mixdog_agent::boundary::CompactSettings {
                    auto: true,
                    context_window: Some(640_000),
                    token_calibration: 1.0,
                    ..Default::default()
                }),
                header: json!({ "provider": "openai-oauth", "model": "gpt-6.2-sol" }).as_object().unwrap().clone(),
                ..Default::default()
            },
            effort: None,
            text_only: None,
        }),
        Vec::new(),
    );
    let mut h = Harness::new(vec![Attempt::Reject(ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::NotSent))]);
    h.route = Some(route);
    h.side = Some(Arc::new(RouteTap(log.clone())));
    h.real_compactor = Some(Arc::new(Seating { inner: Arc::new(Compactor100::default()), seated: seated.clone() }));
    finish(h.run(config(), vec![], vec![AgentMessage::user("go")])).await;
    assert_eq!(*log.0.lock().unwrap(), ["begin:m", "route:openai-oauth", "discard", "begin:gpt-6.2-sol", "settle:ok"]);
    assert_eq!(*seated.lock().unwrap(), [("openai-oauth".to_owned(), Some(640_000))]);
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

#[tokio::test]
async fn a_later_loader_keeps_its_receipt_and_only_registers_new_or_changed_schemas() {
    for (name, definition, want_update) in [("Skill", "original", false), ("load_tool", "original", false), ("load_tool", "revised", true)] {
        let loader = |name: &str, description| {
            let mut spec = Echo::tool().spec().clone();
            spec.name = name.into();
            Arc::new(Loader(
                spec,
                json!({"nativeToolSearch": {
                    "provider": "openai", "toolReferences": ["linked"],
                    "openaiTools": [{"type":"function","name":"linked","description":description}],
                    "summary": "Loaded linked"
                }})
                .to_string(),
            ))
        };
        let h = Harness::new(vec![
            turn(vec![call("first", "Skill", json!({"name":"alpha"})), done(StopReason::ToolUse)]),
            turn(vec![call("repeat", name, json!({"name":"linked"})), done(StopReason::ToolUse)]),
            turn(vec![text("ok"), done(StopReason::EndTurn)]),
        ]);
        let mut tools: Vec<Arc<dyn Tool>> = vec![loader("Skill", "original")];
        if name != "Skill" {
            tools.push(loader(name, definition));
        }
        finish(h.run(config(), tools, vec![AgentMessage::user("go")])).await;
        let requests = h.provider.requests();
        let messages = &requests.last().unwrap().messages;
        let first = messages.iter().find(|m| m.tool_call_id.as_deref() == Some("first")).unwrap();
        let repeat = messages.iter().find(|m| m.tool_call_id.as_deref() == Some("repeat")).unwrap();
        assert_eq!(first.native_tool_search.as_ref().unwrap()["openaiTools"][0]["description"], "original");
        assert_eq!(repeat.content, Content::Text("Loaded linked".into()));
        if want_update {
            assert_eq!(repeat.native_tool_search.as_ref().unwrap()["openaiTools"][0]["description"], "revised");
        } else {
            assert!(repeat.native_tool_search.is_none(), "{name} repeated an identical schema");
        }
    }
}
