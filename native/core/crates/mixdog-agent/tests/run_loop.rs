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

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

enum Step {
    Event(StreamEvent),
    Fail(ProviderError),
    Hang,
}

#[allow(clippy::large_enum_variant)]
enum Attempt {
    Stream(Vec<Step>),
    Reject(ProviderError),
}

struct ScriptedStream(VecDeque<Step>);

#[async_trait]
impl ModelStream for ScriptedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        match self.0.pop_front() {
            None => None,
            Some(Step::Event(event)) => Some(Ok(event)),
            Some(Step::Fail(error)) => Some(Err(error)),
            Some(Step::Hang) => std::future::pending().await,
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
}

struct Scripted {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<Attempt>>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
}

impl Scripted {
    fn new(script: Vec<Attempt>) -> Arc<Self> {
        Arc::new(Self {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into()),
            requests: Mutex::new(Vec::new()),
        })
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
    async fn attempt(
        &self,
        request: Arc<ModelRequest>,
    ) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.requests.lock().unwrap().push(request);
        match self.script.lock().unwrap().pop_front() {
            Some(Attempt::Stream(steps)) => Ok(Box::new(ScriptedStream(steps.into()))),
            Some(Attempt::Reject(error)) => Err(error),
            None => panic!("provider script exhausted"),
        }
    }
}

fn text(s: &str) -> Step {
    Step::Event(StreamEvent::TextDelta(s.into()))
}

fn done(stop: StopReason) -> Step {
    Step::Event(StreamEvent::Completed { stop: Some(stop), pricing_model: None })
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

#[derive(Default)]
struct RecordedWait(Mutex<Vec<Duration>>);
#[async_trait]
impl RetryWait for RecordedWait {
    async fn wait(&self, delay: Duration) {
        self.0.lock().unwrap().push(delay);
    }
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
}
impl Observer {
    fn new(retract: Retracted) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
            retract,
        })
    }
    fn events(&self) -> Vec<RunEvent> {
        self.events.lock().unwrap().clone()
    }
}
impl RunObserver for Observer {
    fn event(&self, event: RunEvent) {
        self.events.lock().unwrap().push(event);
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
    replaced: Mutex<Vec<Vec<AgentMessage>>>,
    ids: AtomicU64,
    /// Storage that never acks.
    stalled: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl TranscriptSink for Sink {
    fn commit(&self, message: &AgentMessage) -> Ticket {
        let mut committed = self.committed.lock().unwrap();
        committed.push(message.clone());
        Ticket(committed.len() as u64)
    }
    fn replace(&self, messages: &[AgentMessage]) {
        self.replaced.lock().unwrap().push(messages.to_vec());
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
}
#[async_trait]
impl Compactor for Compactor100 {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        messages.len() as u64 * 100
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
        let mut kept = vec![AgentMessage::user("[summary]")];
        kept.push(request.messages.last().unwrap().clone());
        Ok(CompactOutput {
            messages: kept,
            usage: None,
            dropped_count: 0,
            dropped: None,
        })
    }
}

struct Echo(ToolSpec);
impl Echo {
    fn tool() -> Arc<dyn Tool> {
        Arc::new(Self(ToolSpec {
            name: "echo".into(),
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
impl ResultReuse for Stored {
    fn lookup(&self, _call: &ToolCall, _touch: bool) -> Option<Reused> {
        None
    }
    fn store(&self, _call: &ToolCall, content: &str, _tool_use_id: &str, _output: &ToolOutput) {
        self.0.lock().unwrap().push(content.to_owned());
    }
    fn after_call(&self, _call: &ToolCall, _failed: bool) {}
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
    tail: Option<Arc<dyn TailReminder>>,
    reuse: Option<Arc<dyn ResultReuse>>,
    cancel: CancellationToken,
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
            tail: None,
            reuse: None,
            cancel: CancellationToken::new(),
        }
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
            clock: Arc::new(FixedClock(AtomicI64::new(1_000))),
            jitter: Arc::new(HalfJitter),
            waiter: self.waiter.clone(),
            decider: Arc::new(MockRetryDecider),
            steer: self.steer.clone(),
            observer: self.observer.clone(),
            sink: self.sink.clone(),
            gate: Arc::clone(&self.gate),
            guards: Arc::new(NoGuards),
            compactor: self.compactor.clone().map(|c| c as Arc<dyn Compactor>),
            route: None,
            skills: None,
            hooks: None,
            reuse: self.reuse.clone(),
            reactions: None,
            tail: self.tail.clone(),
            step_judge: None,
            artifacts: None,
            images: None,
        }
    }

    fn tool_env(&self) -> ToolEnv {
        let tokens = mixdog_rt::testing::tokens();
        ToolEnv {
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            cwd: mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).unwrap(),
            surface: SurfaceKind::Lead,
            io: ToolIo {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
            },
            approvals: self.approvals.clone(),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            deadline_of: None,
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
            self.provider.clone(),
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
    assert_eq!(h.sink.replaced.lock().unwrap().len(), 1);
    assert_eq!(output.iterations, 1);
    let compact_events: Vec<_> = h
        .observer
        .events()
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Compact(c) => Some((c.changed, c.before_messages, c.after_messages)),
            _ => None,
        })
        .collect();
    assert_eq!(compact_events, [(true, 11, 2)]);
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
        reason: Some(mixdog_agent::interrupt::AbortReason::UserCancel),
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

async fn replay(scenario: &JsonValue) -> (JsonValue, JsonValue, JsonValue) {
    let entries = scenario["script"].as_array().unwrap();
    let copies = if scenario["repeatLast"].as_bool() == Some(true) { 8 } else { 1 };
    let mut script = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let n = if i + 1 == entries.len() { copies } else { 1 };
        for _ in 0..n {
            let mut steps = Vec::new();
            let content = entry["content"].as_str().unwrap_or("");
            if !content.is_empty() {
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
    (JsonValue::Array(transcript), result, JsonValue::Array(requests))
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
        let (transcript, result, requests) = replay(&scenario).await;
        assert_eq!(transcript, golden["messages"], "{name}: transcript");
        assert_eq!(result, golden["result"], "{name}: result");
        assert_eq!(requests, golden["requests"], "{name}: requests");
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
        ContentPart::Text("see".into()),
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
            ContentPart::Text("see".into()),
            ContentPart::Text("<file name=\"notes.md\">\nbody\n</file>".into()),
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
        ContentPart::Text("look".into()),
        ContentPart::Image(ImageSource::Url("u".into())),
    ]));
    let output = finish(h.run(config(), vec![], vec![prompt])).await;
    assert_eq!(output.response.content, "ok");
    let requests = h.provider.requests();
    assert!(matches!(&requests[0].messages[0].content, Content::Parts(p) if p.len() == 2 && matches!(p[1], ContentPart::Image(_))));
    assert_eq!(
        requests[1].messages[0].content,
        Content::Parts(vec![
            ContentPart::Text("look".into()),
            ContentPart::Text(mixdog_agent::recovery_placeholder().into()),
        ])
    );
    // the stored transcript keeps the image
    assert!(matches!(&output.transcript[0].message.content, Content::Parts(p) if matches!(p[1], ContentPart::Image(_))));
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
    assert_eq!(h.sink.replaced.lock().unwrap().len(), 1, "the repair is persisted");
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
    let h = Harness::new(vec![
        turn(vec![call("c1", "echo", json!({"i": 1})), done(StopReason::ToolUse)]),
        turn(vec![text("ok"), done(StopReason::EndTurn)]),
    ]);
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
    while !judge.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    // The judge is held: the second request must not have been sent.
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert_eq!(h.provider.requests().len(), 1);
    judge.gate.notify_one();
    let output = task.await.unwrap().expect("run");
    assert_eq!(h.provider.requests().len(), 2);
    let seen = adapter.seen.lock().unwrap().clone();
    assert!(seen[0].as_ref().is_some_and(|p| p.updates.is_empty()), "the first request has nothing to update");
    let second = seen[1].as_ref().expect("the judged effort is on the very next request");
    assert_eq!(second.updates.iter().collect::<Vec<_>>(), [(&2, &"high".to_owned())]);
    assert_eq!(output.transcript[2].effort.as_ref().map(|s| s.effort.as_str()), Some("high"));
}
struct Artifacts(Mutex<Vec<String>>);
#[async_trait]
impl mixdog_agent::offload::ArtifactStore for Artifacts {
    async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        self.0.lock().unwrap().push(content.to_owned());
        Some(mixdog_agent::offload::Artifact { display_path: "/art/r.txt".into(), lines: 1, sha256: "cd".repeat(32) })
    }
    async fn preview(&self, _content: &str) -> Option<mixdog_agent::offload::Artifact> {
        Some(mixdog_agent::offload::Artifact { display_path: "/art/r.txt".into(), lines: 1, sha256: "cd".repeat(32) })
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
    // Two messages: educes would refuse, but media pressure skips that check.
    let messages = vec![AgentMessage::user("a"), AgentMessage::user("b")];
    finish(h.run(cfg, vec![], messages)).await;
    assert_eq!(*h.compactor.as_ref().unwrap().requests.lock().unwrap(), [(2, CompactTrigger::Auto)]);
}

#[tokio::test]
async fn a_one_shot_call_retries_through_the_decider_keeps_its_cap_and_sends_rows_unwrapped() {
    use mixdog_agent::one_shot::OneShot;
    use mixdog_agent::one_shot::OneShotCall;
    let mut transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    transient.message = "blip".into();
    let h = Harness::new(vec![
        Attempt::Reject(transient),
        turn(vec![text("SUMMARY"), done(StopReason::EndTurn)]),
    ]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let call = OneShotCall { model: "m".into(), max_output_tokens: 4096, fast: true };
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
    use mixdog_agent::one_shot::OneShot;
    let h = Harness::new(vec![turn(vec![text("par"), Step::Hang])]);
    let one = OneShot::new(&h.run_env(), h.tool_env(), h.provider.clone(), h.cancel.clone());
    let call = SummaryCall { model: "m".into(), max_output_tokens: 4096, fast: false };
    let task = tokio::spawn(async move { one.send("sys", "prompt", &call).await });
    while h.provider.requests().is_empty() {
        tokio::task::yield_now().await;
    }
    h.cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(SummaryFailure::Aborted)));
}
