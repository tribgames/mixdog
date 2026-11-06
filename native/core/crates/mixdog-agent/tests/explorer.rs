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
}

impl Provider {
    fn new(events: Vec<StreamEvent>, hang: bool) -> Arc<Self> {
        Self::scripted(vec![(events, hang)])
    }

    fn scripted(script: Vec<(Vec<StreamEvent>, bool)>) -> Arc<Self> {
        Arc::new(Self {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into()),
            scopes: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl ProviderAdapter for Provider {
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
        let (events, hang) = self.script.lock().unwrap().pop_front().expect("provider script exhausted");
        Ok(Box::new(Stream { events: events.into(), hang }))
    }
}

struct Host(Arc<Provider>);

#[async_trait]
impl ExplorerHost for Host {
    async fn route(&self) -> Result<ExplorerRoute, String> {
        Ok(ExplorerRoute {
            model: "m".into(),
            provider: self.0.clone(),
            effort: None,
            fast: false,
            model_parameters: None,
            owner_session_id: None,
        })
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
    fn commit(&self, _message: &mixdog_agent::message::AgentMessage) -> Ticket {
        Ticket(0)
    }
    fn replace(&self, _messages: &[mixdog_agent::message::AgentMessage]) {}
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
        step_judge: None,
        artifacts: None,
        images: None,
    }
}

fn tool_env() -> ToolEnv {
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
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        progress: Arc::new(MockProgress::default()),
        deadline_of: None,
    }
}

/// The test backend spawns the process-wide ticker on the ambient runtime, which
/// would die with whichever test started it first; start it on one that lives
/// for the whole process.
fn long_lived_ticker() {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap());
    let _entered = runtime.enter();
    mixdog_rt::testing::tokens();
    mixdog_rt::ticker();
}

async fn explore(provider: Arc<Provider>, deadline: Duration) -> Result<mixdog_tools::orch::explore::ExploreAnswer, ExploreFailure> {
    long_lived_ticker();
    let explorer = AgentExplorer::new(Arc::new(Host(provider)), &env(), tool_env());
    let thread = ThreadId::from("t");
    let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).unwrap();
    let cancel = CancellationToken::new();
    explorer
        .explore(ExploreRun { query: "where?", thread: &thread, cwd: &cwd, cancel: &cancel, deadline: Instant::now() + deadline })
        .await
}

/// The recorded Node `runExplorer` results (`fixtures/agent/record-explorer.mjs`):
/// the text it resolves with, or that it rejects. A deadline answer is the late
/// one, so a case whose Node text exists after a hang is `late`.
#[tokio::test]
async fn explorer_results_equal_nodes() {
    #[allow(clippy::disallowed_methods)] // test fixture loading
    let cases = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/agent/explorer/cases.json")).unwrap();
    let cases: serde_json::Value = serde_json::from_str(&cases).unwrap();
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 7);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let script = case["script"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let mut events = Vec::new();
                if let Some(text) = entry["text"].as_str() {
                    events.push(StreamEvent::TextDelta(text.into()));
                }
                for c in entry["toolCalls"].as_array().into_iter().flatten() {
                    events.push(StreamEvent::ToolCallDone(mixdog_core_api::domain::provider::ToolCall {
                        id: c["id"].as_str().unwrap().into(),
                        name: c["name"].as_str().unwrap().into(),
                        arguments: c["arguments"].clone(),
                        native_type: None,
                    }));
                }
                let hang = entry["hang"].as_bool().unwrap_or(false);
                if let Some(stop) = entry["stop"].as_str() {
                    let stop = if stop == "tool_use" { StopReason::ToolUse } else { StopReason::EndTurn };
                    events.push(StreamEvent::Completed { stop: Some(stop), pricing_model: None });
                }
                (events, hang)
            })
            .collect();
        let deadline = if case["script"].as_array().unwrap().iter().any(|e| e["hang"] == true) {
            Duration::from_millis(150)
        } else {
            Duration::from_secs(60)
        };
        let got = tokio::time::timeout(Duration::from_secs(10), explore(Provider::scripted(script), deadline))
            .await
            .unwrap_or_else(|_| panic!("{name}: the explorer did not return"));
        match case.get("text").and_then(|t| t.as_str()) {
            Some(text) => {
                let answer = got.unwrap_or_else(|e| panic!("{name}: {e:?}"));
                assert_eq!(answer.text, text, "{name}");
            }
            None => assert_eq!(got, Err(ExploreFailure::TimedOut), "{name}"),
        }
    }
}

#[tokio::test]
async fn deadline_returns_the_text_written_so_far_marked_late() {
    let provider = Provider::new(vec![StreamEvent::TextDelta("src/a.rs:1 foo".into())], true);
    let answer = explore(provider, Duration::from_millis(100)).await.unwrap();
    assert_eq!((answer.text.as_str(), answer.late), ("src/a.rs:1 foo", true));
}

#[tokio::test]
async fn deadline_with_nothing_written_is_a_timeout() {
    let provider = Provider::new(Vec::new(), true);
    assert_eq!(explore(provider, Duration::from_millis(100)).await, Err(ExploreFailure::TimedOut));
}

#[tokio::test]
async fn a_finished_answer_is_trimmed_and_not_late() {
    let provider = Provider::new(
        vec![StreamEvent::TextDelta("  done \n".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None }],
        false,
    );
    let answer = explore(provider.clone(), Duration::from_secs(60)).await.unwrap();
    assert_eq!((answer.text.as_str(), answer.late), ("done", false));
    // The explorer's prefix is the same bytes on every call: keyed on it, never per call
    // (`sharedPrefixProviderCacheOpts`, cache-strategy.mjs:548).
    assert_eq!(*provider.scopes.lock().unwrap(), [Some("shared".to_owned())]);
}
