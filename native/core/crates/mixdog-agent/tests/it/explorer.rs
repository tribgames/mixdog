//! The explorer's deadline: text written before it is returned and marked late;
//! nothing written is a timeout; a finished answer is not late.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_agent::env::*;
use mixdog_agent::explorer::AgentExplorer;
use mixdog_agent::explorer::ExplorerHost;
use mixdog_agent::explorer::ExplorerRoute;
use mixdog_agent::tools::ToolEnv;
use mixdog_agent::tools::ToolSet;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockCodec;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::mock::MockRetryDecider;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_protocol::ProviderId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use mixdog_tools::orch::explore::ExploreFailure;
use mixdog_tools::orch::explore::ExploreRun;
use mixdog_tools::orch::explore::ExploreRunner;
use tokio_util::sync::CancellationToken;

/// One stream: its events, then (when `hang`) nothing more ever.
struct Stream {
    events: VecDeque<StreamEvent>,
    hang: bool,
}

#[async_trait]
impl ModelStream for Stream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        match self.events.pop_front() {
            Some(event) => Some(Ok(event)),
            None if self.hang => std::future::pending().await,
            None => None,
        }
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

struct Provider {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    /// One entry per attempt: its events and whether the stream then hangs.
    script: Mutex<VecDeque<(Vec<StreamEvent>, bool)>>,
    /// The cache scope of every request sent.
    scopes: Mutex<Vec<Option<String>>>,
    /// The model parameters (where the breakpoint strategy rides) of every request sent.
    parameters: Mutex<Vec<Option<serde_json::Value>>>,
}

impl Provider {
    fn new(events: Vec<StreamEvent>, hang: bool) -> Arc<Self> {
        Self::scripted(vec![(events, hang)])
    }

    fn scripted(script: Vec<(Vec<StreamEvent>, bool)>) -> Arc<Self> {
        Self::named("scripted", script)
    }

    fn named(id: &str, script: Vec<(Vec<StreamEvent>, bool)>) -> Arc<Self> {
        Arc::new(Self {
            id: ProviderId::from(id),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into()),
            scopes: Mutex::new(Vec::new()),
            parameters: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl ProviderAdapter for Provider {
    fn release_send(&self, _group: &str) {}
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
        self.scopes.lock().unwrap().push(request.options.prompt_cache_scope.clone());
        self.parameters.lock().unwrap().push(request.options.model_parameters.clone());
        let (events, hang) = self.script.lock().unwrap().pop_front().expect("provider script exhausted");
        Ok(Box::new(Stream { events: events.into(), hang }))
    }
}

struct Host(Arc<Provider>);

#[async_trait]
impl ExplorerHost for Host {
    async fn route(&self) -> Result<ExplorerRoute, String> {
        Ok(ExplorerRoute { model: "m".into(), provider: self.0.clone(), effort: None, fast: false, model_parameters: None, owner_session_id: None })
    }
    fn tools(&self) -> ToolSet {
        ToolSet::new(Vec::new())
    }
}

struct Clock;
impl mixdog_agent::env::Clock for Clock {
    fn now_ms(&self) -> i64 {
        1_000
    }
}
struct Jitter;
impl JitterSource for Jitter {
    fn draw(&self) -> f64 {
        0.5
    }
}
struct NoWait;
#[async_trait]
impl RetryWait for NoWait {
    async fn wait(&self, _delay: Duration) {}
}

struct NoSteer;
#[async_trait]
impl SteerSource for NoSteer {
    async fn drain(&self, _request: DrainRequest) -> Vec<SteerEntry> {
        Vec::new()
    }
}
struct DiscardSink;
#[async_trait]
impl TranscriptSink for DiscardSink {
    async fn commit(&self, _message: &mixdog_agent::message::AgentMessage) -> Result<Ticket, mixdog_agent::env::CommitError> {
        Ok(Ticket(0))
    }
    fn replace(&self, _messages: &[mixdog_agent::message::AgentMessage], _rewrite: &Rewrite) {}
    fn message_id(&self) -> String {
        String::new()
    }
    async fn durable(&self, _ticket: Ticket) {}
}

fn env() -> RunEnv {
    RunEnv {
        clock: Arc::new(Clock),
        jitter: Arc::new(Jitter),
        waiter: Arc::new(NoWait),
        decider: Arc::new(MockRetryDecider),
        steer: Arc::new(NoSteer),
        observer: Arc::new(NullObserver),
        sink: Arc::new(DiscardSink),
        gate: Arc::new(AllowAll),
        guards: Arc::new(NoGuards),
        compactor: None,
        route: None,
        skills: None,
        hooks: None,
        reuse: None,
        reactions: None,
        tail: None,
        mcp: None,
        side: None,
        step_judge: None,
        artifacts: None,
        images: None,
        failures: None,
    }
}

fn tool_env() -> ToolEnv {
    let tokens = mixdog_rt::testing::tokens();
    ToolEnv {
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        cwd: mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).unwrap(),
        surface: SurfaceKind::Lead,
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        progress: Arc::new(MockProgress::default()),
        deadline_of: None,
        notify: None,
        review: None,
    }
}

/// Installs the test backend. Its ticker is per runtime (hang-lanes-138), so each test's deadlines
/// run on its own runtime's clock, paused or not, and nothing outlives the test.
fn backend() {
    mixdog_rt::testing::tokens();
}

async fn explore(provider: Arc<Provider>, deadline: Duration) -> Result<mixdog_tools::orch::explore::ExploreAnswer, ExploreFailure> {
    backend();
    let explorer = AgentExplorer::new(Arc::new(Host(provider)), &env(), tool_env());
    let thread = ThreadId::from("t");
    let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).unwrap();
    let cancel = CancellationToken::new();
    explorer.explore(ExploreRun { query: "where?", thread: &thread, cwd: &cwd, cancel: &cancel, deadline: Instant::now() + deadline }).await
}

#[tokio::test(start_paused = true)]
async fn deadline_returns_the_text_written_so_far_marked_late() {
    let provider = Provider::new(vec![StreamEvent::TextDelta("src/a.rs:1 foo".into())], true);
    let answer = explore(provider, Duration::from_millis(100)).await.unwrap();
    assert_eq!((answer.text.as_str(), answer.late), ("src/a.rs:1 foo", true));
}

#[tokio::test(start_paused = true)]
async fn deadline_with_nothing_written_is_a_timeout() {
    let provider = Provider::new(Vec::new(), true);
    assert_eq!(explore(provider, Duration::from_millis(100)).await, Err(ExploreFailure::TimedOut));
}

#[tokio::test(start_paused = true)]
async fn a_finished_answer_is_trimmed_and_not_late() {
    let provider = Provider::new(
        vec![StreamEvent::TextDelta("  done \n".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        false,
    );
    let answer = explore(provider.clone(), Duration::from_secs(60)).await.unwrap();
    assert_eq!((answer.text.as_str(), answer.late), ("done", false));
    // The explorer's prefix is the same bytes on every call: keyed on it, never per call
    // (`sharedPrefixProviderCacheOpts`, cache-strategy.mjs:548).
    assert_eq!(*provider.scopes.lock().unwrap(), [Some("shared".to_owned())]);
}

/// The session-less explore loop keeps Node's `sharedPrefixProviderCacheOpts`: the shared scope on every provider, and on an
/// explicit-breakpoint provider the 5m system prefix with no tier3 and no tools breakpoint, so the parallel explorers read
/// what one wrote without a 1h write; a key-prefix provider is sent no breakpoint strategy.
#[tokio::test(start_paused = true)]
async fn the_explorer_sends_nodes_shared_prefix_cache_policy() {
    let done =
        || vec![StreamEvent::TextDelta("done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
    let anthropic = Provider::named("anthropic-oauth", vec![(done(), false)]);
    explore(anthropic.clone(), Duration::from_secs(60)).await.unwrap();
    assert_eq!(*anthropic.scopes.lock().unwrap(), [Some("shared".to_owned())]);
    assert_eq!(
        *anthropic.parameters.lock().unwrap(),
        [Some(serde_json::json!({ "cacheStrategy": { "tools": "none", "system": "5m", "tier3": "none", "messages": "5m" } }))]
    );
    let keyed = Provider::named("openai-oauth", vec![(done(), false)]);
    explore(keyed.clone(), Duration::from_secs(60)).await.unwrap();
    assert_eq!(*keyed.scopes.lock().unwrap(), [Some("shared".to_owned())]);
    assert_eq!(*keyed.parameters.lock().unwrap(), [None]);
}

/// At the deadline the explorer hands over everything it wrote: the text of its earlier turns and the streamed tail, joined by
/// a blank line; a turn that wrote only a dot, or only blanks, wrote nothing.
#[tokio::test(start_paused = true)]
async fn at_the_deadline_the_earlier_turns_text_and_the_streamed_tail_are_joined() {
    let tool_turn = |text: &str| {
        vec![
            StreamEvent::TextDelta(text.into()),
            StreamEvent::ToolCallDone(mixdog_core_api::domain::provider::ToolCall {
                id: "c1".into(),
                name: "nope".into(),
                arguments: serde_json::json!({}),
                native_type: None,
            }),
            StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
        ]
    };
    let answer = |first: &str, tail: Vec<StreamEvent>| Provider::scripted(vec![(tool_turn(first), false), (tail, true)]);
    let tail = || vec![StreamEvent::TextDelta("tail".into())];
    let joined = explore(answer("looking", tail()), Duration::from_millis(150)).await.unwrap();
    assert_eq!((joined.text.as_str(), joined.late), ("looking\n\ntail", true));
    let dropped = explore(answer(".", tail()), Duration::from_millis(150)).await.unwrap();
    assert_eq!(dropped.text, "tail");
    let earlier_only = explore(answer("first", Vec::new()), Duration::from_millis(150)).await.unwrap();
    assert_eq!(earlier_only.text, "first");
    let blank = Provider::scripted(vec![(vec![StreamEvent::TextDelta(" \n ".into())], true)]);
    assert_eq!(explore(blank, Duration::from_millis(150)).await, Err(ExploreFailure::TimedOut));
}
