//! In-memory mocks of every domain trait, for consumers' unit tests and as
//! the reference subjects of [`super::conformance`]. Deterministic; no I/O,
//! no threads, no timers.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use super::approval::ApprovalAsk;
use super::approval::ApprovalGate;
use super::common::AbsPath;
use super::common::EventSource;
use super::computer::ComputerBackend;
use super::computer::ComputerError;
use super::computer::ComputerRequest;
use super::computer::ComputerStatus;
use super::computer::DesktopIdentity;
use super::computer::DisplayId;
use super::computer::DisplayInfo;
use super::computer::InputOutcome;
use super::computer::ScreenInput;
use super::ext::ExtCall;
use super::ext::ExtError;
use super::ext::ExtFrame;
use super::ext::ExtPool;
use super::ext::ExtWorkerId;
use super::ext::ExtWorkerState;
use super::ext::ExtWorkerStatus;
use super::fs::DirEntry;
use super::fs::EntryKind;
use super::fs::FileBytes;
use super::fs::FileService;
use super::fs::FileStat;
use super::fs::FsError;
use super::fs::FsErrorKind;
use super::fs::ReadRange;
use super::fs::SearchMatch;
use super::fs::SearchRequest;
use super::fs::WalkRequest;
use super::fs::WritePrecondition;
use super::fs::WriteRequest;
use super::keepalive::KeepaliveSchedule;
use super::keepalive::LinkLiveness;
use super::keepalive::TransportKeepalive;
use super::keepalive::TransportKind;
use super::login::LoginError;
use super::login::LoginFlow;
use super::login::LoginInput;
use super::login::LoginSession;
use super::login::LoginState;
use super::login::LoginTarget;
use super::media::EncodingParams;
use super::media::FrameSourceKind;
use super::media::MediaError;
use super::media::MediaFrameSource;
use super::media::PixelFormat;
use super::media::VideoCodec;
use super::media::VideoFrame;
use super::media::VideoTrack;
use super::ownership::FenceReason;
use super::ownership::Ownership;
use super::process::CommandSpec;
use super::process::ExitStatus;
use super::process::KillReason;
use super::process::OutputStream;
use super::process::ProcessError;
use super::process::ProcessEvent;
use super::process::ProcessExit;
use super::process::ProcessInfo;
use super::process::ProcessManager;
use super::process::ProcessQueue;
use super::process::PtySize;
use super::process::SpawnRequest;
use super::process::SpawnedProcess;
use super::provider::Content;
use super::provider::DeliveryState;
use super::provider::ErrorKind;
use super::provider::ErrorResponse;
use super::provider::Exposure;
use super::provider::HostedTool;
use super::provider::ModelListing;
use super::provider::ModelRecord;
use super::provider::ModelRequest;
use super::provider::ModelStream;
use super::provider::ProviderAdapter;
use super::provider::ProviderError;
use super::provider::Role;
use super::provider::StopReason;
use super::provider::StreamEvent;
use super::provider::TransportFault;
use super::provider::Usage;
use super::provider::UsdTicks;
use super::provider::WireCodec;
use super::provider::WireDecoder;
use super::provider::WireRequest;
use super::repo::Cached;
use super::repo::InspectorKey;
use super::repo::ObjectId;
use super::repo::RepoEvidence;
use super::repo::RepoInspector;
use super::repo::RepoRef;
use super::repo::RepoStatus;
use super::repo::ReviewPage;
use super::repo::ReviewRequest;
use super::repo::ReviewSummary;
use super::repo::ScmError;
use super::retry::AdviceCombine;
use super::retry::Backoff;
use super::retry::Decision;
use super::retry::JitterSamples;
use super::retry::JitterStage;
use super::retry::RetryDecider;
use super::retry::RetryPolicy;
use super::retry::RetryReason;
use super::retry::RetrySchedule;
use super::retry::RetryState;
use super::retry::ScheduleCount;
use super::retry::Verdict;
use super::tool::ProgressSink;
use super::tool::Tool;
use super::tool::ToolAnnotations;
use super::tool::ToolContext;
use super::tool::ToolError;
use super::tool::ToolErrorCode;
use super::tool::ToolOutcome;
use super::tool::ToolOutput;
use super::tool::ToolPart;
use super::tool::ToolProgress;
use super::tool::ToolSpec;
use mixdog_protocol::ProviderId;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// An [`EventSource`] over a fixed sequence.
pub struct VecSource<T>(VecDeque<T>);

impl<T> VecSource<T> {
    pub fn new(items: impl IntoIterator<Item = T>) -> Self {
        Self(items.into_iter().collect())
    }
}

#[async_trait]
impl<T: Send> EventSource<T> for VecSource<T> {
    async fn next(&mut self) -> Option<T> {
        self.0.pop_front()
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/// Line wire: `t:<text>` text delta, `ka` provider keepalive, `done` terminal.
#[derive(Default)]
pub struct MockCodec;

#[derive(Default)]
struct MockDecoder {
    buf: Vec<u8>,
    terminal: bool,
    exposure: Exposure,
    usage: Option<Usage>,
}

impl MockDecoder {
    // Same error type as `WireDecoder`; see the allow there.
    #[allow(clippy::result_large_err)]
    fn line(&mut self, line: &[u8]) -> Result<Option<StreamEvent>, ProviderError> {
        let line = String::from_utf8_lossy(line);
        let event = if let Some(text) = line.strip_prefix("t:") {
            self.exposure.text_emitted = true;
            StreamEvent::TextDelta(text.to_owned())
        } else if let Some(usage) = line.strip_prefix("u:").and_then(parse_usage) {
            self.usage = Some(usage.clone());
            StreamEvent::Usage(usage)
        } else if line == "ka" {
            StreamEvent::ProviderKeepalive
        } else if line == "done" || line == "cont" {
            self.terminal = true;
            StreamEvent::Completed {
                pricing_model: None,
                request_ms: None,
                stop: Some(if line == "done" {
                    StopReason::EndTurn
                } else {
                    StopReason::ContinueTurn
                }),
            }
        } else if line.is_empty() {
            return Ok(None);
        } else {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            err.message = format!("mock wire: unknown line {line:?}");
            return Err(self.fail(err));
        };
        Ok(Some(event))
    }

    /// Every decoder error carries what the stream had exposed and reported.
    fn fail(&self, mut err: ProviderError) -> ProviderError {
        err.exposure = self.exposure;
        err.partial_usage = self.usage.clone().map(Box::new);
        err
    }
}

/// `<input>,<output>[,<cost ticks>]`.
fn parse_usage(text: &str) -> Option<Usage> {
    let mut parts = text.split(',');
    let input = parts.next()?.parse().ok()?;
    let output = parts.next()?.parse().ok()?;
    let cost = match parts.next() {
        Some(ticks) => Some(UsdTicks(ticks.parse().ok()?)),
        None => None,
    };
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
        cost,
        ..Usage::default()
    })
}

impl WireDecoder for MockDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        self.buf.extend_from_slice(unit);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            if let Some(event) = self.line(&line[..line.len() - 1])? {
                out.push(event);
            }
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        let rest = std::mem::take(&mut self.buf);
        let out = self.line(&rest)?.into_iter().collect();
        if !self.terminal {
            return Err(self.fail(ProviderError::transport(
                TransportFault::TruncatedStream,
                DeliveryState::Accepted,
            )));
        }
        Ok(out)
    }

    fn terminal_seen(&self) -> bool {
        self.terminal
    }

    fn exposure(&self) -> Exposure {
        self.exposure
    }
}

impl WireCodec for MockCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let mut body = Vec::new();
        for message in request.messages.iter().filter(|m| m.role == Role::User) {
            if let Content::Text(text) = &message.content {
                body.extend_from_slice(text.as_bytes());
                body.push(b'\n');
            }
        }
        for HostedTool::WebSearch(search) in &request.options.hosted_tools {
            body.extend_from_slice(format!("hosted:{}\n", search.tool_type).as_bytes());
        }
        Ok(WireRequest {
            transport: TransportKind::Http1,
            method: "POST".into(),
            url: format!("mock://{}/v1", request.model),
            headers: Vec::new(),
            body,
        })
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::<MockDecoder>::default()
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        let kind = match response.status {
            Some(401) => ErrorKind::Auth,
            Some(403) => ErrorKind::Permission,
            Some(409) => ErrorKind::ReplayRejected,
            Some(415) => ErrorKind::ImageRejected,
            Some(422) => ErrorKind::ToolSchemaRejected,
            Some(429) => ErrorKind::RateLimited,
            Some(529) => ErrorKind::Overloaded,
            Some(s) if s >= 500 => ErrorKind::Transient,
            Some(_) => ErrorKind::InvalidRequest,
            None => ErrorKind::Transient,
        };
        let mut err = ProviderError::new(kind, DeliveryState::Accepted);
        err.status = response.status;
        // The mock's structured verification detail: a 403 body is the URL.
        if response.status == Some(403) && !response.body.is_empty() {
            err.verification_url = Some(String::from_utf8_lossy(&response.body).into());
        }
        err
    }
}

struct MockModelStream {
    events: VecDeque<Result<StreamEvent, ProviderError>>,
}

#[async_trait]
impl ModelStream for MockModelStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.events.pop_front()
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    /// A leaf: `next` awaits nothing after its last event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

/// One scripted attempt, as its transport plays out.
#[derive(Clone, Debug)]
pub enum MockAttempt {
    /// A success status; the body is decoded with [`MockCodec`].
    Body(Vec<u8>),
    /// A non-success response, classified by [`MockCodec`].
    Rejected(ErrorResponse),
    /// The transport failed after the request got as far as `reached`.
    Fault {
        fault: TransportFault,
        reached: DeliveryState,
    },
}

/// Each attempt takes the next scripted [`MockAttempt`]; an empty script
/// fails to connect.
pub struct MockProvider {
    pub id: ProviderId,
    pub policy: RetryPolicy,
    pub keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<MockAttempt>>,
    pub attempts: AtomicU32,
    /// What [`ModelListing::list_models`] answers.
    pub models: Vec<ModelRecord>,
}

impl MockProvider {
    pub fn new(script: impl IntoIterator<Item = MockAttempt>) -> Self {
        let mut model = ModelRecord::new("mock-model");
        model.context_window = Some(200_000);
        model.max_output_tokens = Some(32_000);
        model.supports_reasoning = Some(true);
        model.reasoning_levels = vec!["low".into(), "medium".into(), "high".into()];
        model.default_reasoning_level = Some("medium".into());
        Self {
            id: ProviderId::from("mock"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script.into_iter().collect()),
            attempts: AtomicU32::new(0),
            models: vec![model],
        }
    }
}

#[async_trait]
impl ModelListing for MockProvider {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.models.clone())
    }
}

#[async_trait]
impl ProviderAdapter for MockProvider {
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
        self.attempts.fetch_add(1, Ordering::Relaxed);
        self.codec.encode(&request)?;
        let next = lock(&self.script)
            .pop_front()
            .unwrap_or(MockAttempt::Fault {
                fault: TransportFault::Connect { os_code: None },
                reached: DeliveryState::NotSent,
            });
        let wire = match next {
            MockAttempt::Body(wire) => wire,
            MockAttempt::Rejected(response) => return Err(self.codec.classify(&response)),
            MockAttempt::Fault { fault, reached } => {
                return Err(ProviderError::transport(fault, reached));
            }
        };
        let mut decoder = self.codec.decoder(&request);
        let mut events = VecDeque::new();
        let decoded = match decoder.feed(&wire) {
            Ok(mut head) => decoder.finish().map(|tail| {
                head.extend(tail);
                head
            }),
            Err(err) => Err(err),
        };
        match decoded {
            Ok(all) => events.extend(all.into_iter().map(Ok)),
            Err(err) => events.push_back(Err(err)),
        }
        Ok(Box::new(MockModelStream { events }))
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(self)
    }
}

/// Reference verdict for consumers' tests: exposure and deterministic kinds
/// surface; advice follows the row's [`AdviceRule`](super::retry::AdviceRule);
/// rows bound retries. The production decider
/// implements the full PW §4.1 order.
#[derive(Default)]
pub struct MockRetryDecider;

impl RetryDecider for MockRetryDecider {
    fn verdict(
        &self,
        error: &ProviderError,
        state: &RetryState,
        policy: &RetryPolicy,
        samples: JitterSamples,
    ) -> Decision {
        let stop = |verdict| Decision {
            verdict,
            next: state.after_failure(error.kind),
        };
        let retry = |delay, under| Decision {
            verdict: Verdict::Retry {
                delay,
                reason: reason_of(error),
                delivery: error.delivery,
            },
            next: state.after_retry(error.kind, under, delay),
        };
        let e = error.exposure;
        if e.text_emitted || e.tool_dispatched || e.tool_input_cut || error.kind.is_deterministic()
        {
            return stop(Verdict::Surface);
        }
        let Some(row) = policy.row(state.class()) else {
            return stop(Verdict::Surface);
        };
        // The row's schedule first; a kind schedule takes what it does not retry.
        let row_retries = match error.kind {
            ErrorKind::RateLimited => policy.status.retry_429,
            ErrorKind::Overloaded if error.status == Some(429) => policy.status.retry_429,
            ErrorKind::Overloaded => error.status != Some(529) || policy.status.retry_529,
            ErrorKind::Transient => true,
            _ => false,
        };
        if let Some(delay) = row_retries
            .then(|| scheduled_wait(error, &row.schedule, state.count(None), samples))
            .flatten()
        {
            return retry(delay, None);
        }
        if let Some(entry) = row.kind_schedule(error.kind) {
            return match scheduled_wait(
                error,
                &entry.schedule,
                state.count(Some(entry.kind)),
                samples,
            ) {
                Some(delay) => retry(delay, Some(entry)),
                None => stop(Verdict::Exhausted),
            };
        }
        stop(if row_retries {
            Verdict::Exhausted
        } else {
            Verdict::Surface
        })
    }
}

fn reason_of(error: &ProviderError) -> RetryReason {
    match error.kind {
        ErrorKind::RateLimited => RetryReason::RateLimited,
        ErrorKind::Overloaded => RetryReason::Overloaded,
        ErrorKind::Transient if error.transport.is_some() => RetryReason::Transport,
        ErrorKind::Transient => RetryReason::ServerError,
        _ => RetryReason::Other,
    }
}

/// The wait of the next retry under `schedule`, or `None` when its count is
/// spent or the advice is beyond its ceiling or budget.
fn scheduled_wait(
    error: &ProviderError,
    schedule: &RetrySchedule,
    count: ScheduleCount,
    samples: JitterSamples,
) -> Option<Duration> {
    if count.retries >= schedule.max_retries {
        return None;
    }
    let n = count.retries + 1;
    let step = match &schedule.backoff {
        Backoff::Ladder(steps) => steps
            .get((n as usize).min(steps.len()).saturating_sub(1))
            .copied()
            .unwrap_or_default(),
        Backoff::Exponential { base } => *base * 2u32.saturating_pow(n - 1),
    };
    let step = schedule.jitter.apply(step, samples.step);
    let rule = &schedule.advice;
    let delay = match error.retry_after {
        None => step,
        Some(advice) if rule.ceiling.is_some_and(|ceiling| advice > ceiling) => return None,
        Some(advice)
            if rule
                .budget
                .is_some_and(|budget| count.waited + advice > budget) =>
        {
            return None;
        }
        Some(advice) => {
            let raw = error
                .status
                .is_some_and(|status| rule.raw_statuses.contains(&status));
            let jitter_at = |stage, wait| {
                if raw || rule.jitter_stage != stage {
                    wait
                } else {
                    rule.jitter.apply(wait, samples.advice)
                }
            };
            let advice = match (raw, rule.clamp) {
                (false, Some(clamp)) => advice.min(clamp),
                _ => advice,
            };
            let advice = jitter_at(JitterStage::Advice, advice);
            let wait = match rule.combine {
                AdviceCombine::Floor => advice.max(step),
                AdviceCombine::Replace => advice,
            };
            jitter_at(JitterStage::Wait, wait)
        }
    };
    Some(delay)
}

/// A connection whose half-open state is injected. Detection requires the
/// schedule to be armed, as with a real socket.
pub struct MockKeepalive {
    kind: TransportKind,
    armed: Mutex<Option<KeepaliveSchedule>>,
    dead: Mutex<Option<TransportFault>>,
    age: Mutex<Duration>,
}

impl MockKeepalive {
    pub fn new(kind: TransportKind) -> Self {
        Self {
            kind,
            armed: Mutex::new(None),
            dead: Mutex::new(None),
            age: Mutex::new(Duration::ZERO),
        }
    }

    /// The peer stops answering; the next probe round fails.
    pub fn go_half_open(&self) {
        if lock(&self.armed).is_some() {
            *lock(&self.dead) = Some(TransportFault::KeepaliveExpired {
                transport: self.kind,
            });
        }
    }

    pub fn set_age(&self, age: Duration) {
        *lock(&self.age) = age;
    }

    pub fn armed(&self) -> Option<KeepaliveSchedule> {
        *lock(&self.armed)
    }
}

impl TransportKeepalive for MockKeepalive {
    fn kind(&self) -> TransportKind {
        self.kind
    }

    fn arm(&self, schedule: &KeepaliveSchedule) -> Result<(), TransportFault> {
        *lock(&self.armed) = Some(*schedule);
        Ok(())
    }

    fn liveness(&self) -> LinkLiveness {
        match lock(&self.dead).clone() {
            Some(fault) => LinkLiveness::Dead(fault),
            None => LinkLiveness::Alive,
        }
    }

    fn may_start_response(&self) -> bool {
        let max = lock(&self.armed).and_then(|s| s.ws_max_age);
        self.kind != TransportKind::WebSocket || max.is_none_or(|max| *lock(&self.age) < max)
    }
}

// ---------------------------------------------------------------------------
// Tool and approval
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct MockProgress(pub Mutex<Vec<ToolProgress>>);

impl ProgressSink for MockProgress {
    fn progress(&self, progress: ToolProgress) {
        lock(&self.0).push(progress);
    }
}

/// Answers asks with scripted resolutions; `Interrupted{at: 0}` when the
/// script is empty.
#[derive(Default)]
pub struct MockApprovalGate {
    pub script: Mutex<VecDeque<ApprovalResolution>>,
    pub asks: Mutex<Vec<ApprovalAsk>>,
}

#[async_trait]
impl ApprovalGate for MockApprovalGate {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        lock(&self.asks).push(ask);
        lock(&self.script)
            .pop_front()
            .unwrap_or(ApprovalResolution::Interrupted { at: 0 })
    }
}

/// `echo`: returns its arguments as JSON; honours cancellation.
pub struct EchoTool {
    spec: ToolSpec,
}

impl Default for EchoTool {
    fn default() -> Self {
        Self {
            spec: ToolSpec {
                name: "echo".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "Returns its arguments.".into(),
                input_schema: serde_json::json!({"type": "object"}),
                annotations: ToolAnnotations {
                    read_only_hint: Some(true),
                    ..ToolAnnotations::default()
                },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
        }
    }
}

#[async_trait]
impl Tool for EchoTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        if ctx.cancel.is_cancelled() {
            return Err(ToolError::new(ToolErrorCode::Cancelled, "cancelled"));
        }
        ctx.progress.progress(ToolProgress::Stage("echo".into()));
        Ok(ToolOutput {
            parts: vec![ToolPart::Json(args)],
            ..ToolOutput::default()
        })
    }
}

/// `mcp__mock__fail`: an MCP tool whose server answers every call with `isError: true`
/// carrying the call's arguments as structured content.
pub struct FailingMcpTool {
    spec: ToolSpec,
}

impl Default for FailingMcpTool {
    fn default() -> Self {
        Self {
            spec: ToolSpec {
                name: "mcp__mock__fail".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "Always fails on the server.".into(),
                input_schema: serde_json::json!({"type": "object"}),
                annotations: ToolAnnotations::default(),
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
        }
    }
}

#[async_trait]
impl Tool for FailingMcpTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        Err(ToolError::new(
            ToolErrorCode::McpError {
                server: "mock".into(),
                rpc_code: None,
                data: Some(args),
            },
            "Error: the server reported a failure",
        ))
    }
}

/// `mock_run`: an operation that always runs and fails; the call's `why` argument is the
/// failure text.
pub struct FailingTool {
    spec: ToolSpec,
}

impl Default for FailingTool {
    fn default() -> Self {
        Self {
            spec: ToolSpec {
                name: "mock_run".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "Runs and always fails.".into(),
                input_schema: serde_json::json!({"type": "object"}),
                annotations: ToolAnnotations::default(),
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
        }
    }
}

#[async_trait]
impl Tool for FailingTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let reason = format!("Error: {}", args["why"].as_str().unwrap_or("failed"));
        Err(ToolError::new(
            ToolErrorCode::Failed {
                reason: reason.clone(),
            },
            reason,
        ))
    }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// Files and directories in memory. Directories are explicit entries.
#[derive(Default)]
pub struct MockFileService {
    files: Mutex<BTreeMap<AbsPath, Vec<u8>>>,
    dirs: Mutex<std::collections::BTreeSet<AbsPath>>,
}

fn not_found(path: &AbsPath) -> FsError {
    FsError::new(FsErrorKind::NotFound, Some(path.clone()))
}

fn file_stat(len: usize) -> FileStat {
    FileStat {
        kind: EntryKind::File,
        len: len as u64,
        modified: None,
        ctime: None,
        inode: 0,
        device: 0,
        readonly: false,
    }
}

impl MockFileService {
    fn check(files: &BTreeMap<AbsPath, Vec<u8>>, request: &WriteRequest) -> Result<(), FsError> {
        let current = files.get(&request.path);
        let ok = match &request.precondition {
            WritePrecondition::Unconditional => true,
            WritePrecondition::Absent => current.is_none(),
            WritePrecondition::ContentEquals(expected) => current == Some(expected),
        };
        if ok {
            Ok(())
        } else {
            Err(FsError::new(
                FsErrorKind::PreconditionFailed {
                    actual: current.cloned(),
                },
                Some(request.path.clone()),
            ))
        }
    }

    fn under(&self, root: &AbsPath, recursive: bool) -> Vec<DirEntry> {
        let files = lock(&self.files);
        let dirs = lock(&self.dirs);
        let keep = |p: &AbsPath| {
            p != root
                && p.as_path().starts_with(root.as_path())
                && (recursive || p.as_path().parent() == Some(root.as_path()))
        };
        let mut out: Vec<DirEntry> = dirs
            .iter()
            .filter(|p| keep(p))
            .map(|p| DirEntry {
                path: p.clone(),
                kind: EntryKind::Dir,
            })
            .collect();
        out.extend(files.keys().filter(|p| keep(p)).map(|p| DirEntry {
            path: p.clone(),
            kind: EntryKind::File,
        }));
        out
    }
}

#[async_trait]
impl FileService for MockFileService {
    async fn stat(&self, _lane: InteractiveIo, path: AbsPath) -> Result<FileStat, FsError> {
        if let Some(bytes) = lock(&self.files).get(&path) {
            return Ok(file_stat(bytes.len()));
        }
        if lock(&self.dirs).contains(&path) {
            return Ok(FileStat {
                kind: EntryKind::Dir,
                len: 0,
                modified: None,
                ctime: None,
                inode: 0,
                device: 0,
                readonly: false,
            });
        }
        Err(not_found(&path))
    }

    async fn read(
        &self,
        _lane: InteractiveIo,
        path: AbsPath,
        range: ReadRange,
    ) -> Result<FileBytes, FsError> {
        let files = lock(&self.files);
        let bytes = files.get(&path).ok_or_else(|| not_found(&path))?;
        let start = (range.offset as usize).min(bytes.len());
        let end = range.max_len.map_or(bytes.len(), |n| {
            start.saturating_add(n as usize).min(bytes.len())
        });
        Ok(FileBytes {
            offset: start as u64,
            bytes: bytes[start..end].to_vec(),
            total_len: bytes.len() as u64,
        })
    }

    async fn list_dir(
        &self,
        _lane: InteractiveIo,
        path: AbsPath,
    ) -> Result<Vec<DirEntry>, FsError> {
        if lock(&self.files).contains_key(&path) {
            return Err(FsError::new(FsErrorKind::NotADirectory, Some(path)));
        }
        if !lock(&self.dirs).contains(&path) {
            return Err(not_found(&path));
        }
        Ok(self.under(&path, false))
    }

    async fn write(&self, _lane: DurabilityIo, request: WriteRequest) -> Result<FileStat, FsError> {
        let mut files = lock(&self.files);
        Self::check(&files, &request)?;
        let len = request.content.len();
        files.insert(request.path, request.content);
        Ok(file_stat(len))
    }

    async fn write_batch(
        &self,
        _lane: DurabilityIo,
        requests: Vec<WriteRequest>,
    ) -> Result<Vec<FileStat>, FsError> {
        let mut files = lock(&self.files);
        for request in &requests {
            Self::check(&files, request)?;
        }
        Ok(requests
            .into_iter()
            .map(|r| {
                let len = r.content.len();
                files.insert(r.path, r.content);
                file_stat(len)
            })
            .collect())
    }

    async fn create_dir(
        &self,
        _lane: DurabilityIo,
        path: AbsPath,
        recursive: bool,
    ) -> Result<(), FsError> {
        let mut dirs = lock(&self.dirs);
        if recursive {
            let mut cur = Some(path.as_path());
            while let Some(p) = cur {
                if let Some(abs) = AbsPath::new(p) {
                    dirs.insert(abs);
                }
                cur = p.parent();
            }
        } else if !dirs.insert(path.clone()) {
            return Err(FsError::new(FsErrorKind::AlreadyExists, Some(path)));
        }
        Ok(())
    }

    async fn rename(
        &self,
        _lane: DurabilityIo,
        from: AbsPath,
        to: AbsPath,
        overwrite: bool,
    ) -> Result<(), FsError> {
        let mut files = lock(&self.files);
        if !overwrite && files.contains_key(&to) {
            return Err(FsError::new(FsErrorKind::AlreadyExists, Some(to)));
        }
        let bytes = files.remove(&from).ok_or_else(|| not_found(&from))?;
        files.insert(to, bytes);
        Ok(())
    }

    async fn copy(
        &self,
        _lane: DurabilityIo,
        from: AbsPath,
        to: AbsPath,
        overwrite: bool,
    ) -> Result<(), FsError> {
        let mut files = lock(&self.files);
        if !overwrite && files.contains_key(&to) {
            return Err(FsError::new(FsErrorKind::AlreadyExists, Some(to)));
        }
        let bytes = files.get(&from).cloned().ok_or_else(|| not_found(&from))?;
        files.insert(to, bytes);
        Ok(())
    }

    async fn remove(
        &self,
        _lane: DurabilityIo,
        path: AbsPath,
        recursive: bool,
    ) -> Result<(), FsError> {
        if lock(&self.files).remove(&path).is_some() {
            return Ok(());
        }
        if !lock(&self.dirs).contains(&path) {
            return Err(not_found(&path));
        }
        let children = self.under(&path, true);
        if !children.is_empty() && !recursive {
            return Err(FsError::new(FsErrorKind::Io { os_code: None }, Some(path)));
        }
        let mut files = lock(&self.files);
        let mut dirs = lock(&self.dirs);
        for child in children {
            files.remove(&child.path);
            dirs.remove(&child.path);
        }
        dirs.remove(&path);
        Ok(())
    }

    fn walk(
        &self,
        _lane: MaintenanceIo,
        request: WalkRequest,
    ) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        let entries = self
            .under(&request.root, request.recursive)
            .into_iter()
            .filter(|e| request.include_dirs || e.kind != EntryKind::Dir)
            .map(Ok);
        Box::new(VecSource::new(entries))
    }

    fn search_text(
        &self,
        _lane: MaintenanceIo,
        request: SearchRequest,
    ) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        // The mock has no regex engine; it rejects only an unclosed group,
        // with the parser's wording, so callers can exercise the error path.
        if request.regex && request.pattern.matches('(').count() > request.pattern.matches(')').count() {
            return Box::new(VecSource::new(vec![Err(FsError::new(
                FsErrorKind::InvalidPattern {
                    message: "regex parse error: unclosed group".into(),
                },
                None,
            ))]));
        }
        let files = lock(&self.files);
        let mut matches = Vec::new();
        for (path, bytes) in files
            .iter()
            .filter(|(p, _)| p.as_path().starts_with(request.root.as_path()))
        {
            let text = String::from_utf8_lossy(bytes);
            for (i, line) in text.lines().enumerate() {
                let found = if request.case_sensitive {
                    line.find(&request.pattern)
                } else {
                    line.to_lowercase().find(&request.pattern.to_lowercase())
                };
                if let Some(col) = found {
                    matches.push(Ok(SearchMatch {
                        path: path.clone(),
                        line: i as u64 + 1,
                        column: col as u64 + 1,
                        text: line.to_owned(),
                    }));
                }
            }
        }
        Box::new(VecSource::new(matches))
    }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

struct MockProc {
    info: ProcessInfo,
    events: Vec<ProcessEvent>,
    stdin_open: bool,
}

impl MockProc {
    fn push_output(&mut self, stream: OutputStream, bytes: Vec<u8>) {
        let seq = self.events.len() as u64;
        self.events
            .push(ProcessEvent::Output { seq, stream, bytes });
    }

    fn exit(&mut self, status: ExitStatus, killed: Option<KillReason>) {
        let exit = ProcessExit { status, killed };
        let seq = self.events.len() as u64;
        self.events.push(ProcessEvent::Exited { seq, exit });
        self.info.exit = Some(exit);
        self.stdin_open = false;
    }
}

/// Programs: `echo <args>` prints and exits 0; `cat` echoes stdin and exits 0
/// when stdin closes; `missing` does not exist; anything else runs until
/// killed.
#[derive(Default)]
pub struct MockProcessManager {
    procs: Mutex<HashMap<ProcessHandle, MockProc>>,
    next_pid: AtomicU32,
    spawn_full: AtomicBool,
    input_full: AtomicBool,
}

impl MockProcessManager {
    /// Fills `queue` for good: later admissions to it answer `Overloaded`.
    pub fn saturate(&self, queue: ProcessQueue) {
        match queue {
            ProcessQueue::Spawn => &self.spawn_full,
            ProcessQueue::Input => &self.input_full,
        }
        .store(true, Ordering::Relaxed);
    }
}

#[async_trait]
impl ProcessManager for MockProcessManager {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        if self.spawn_full.load(Ordering::Relaxed) {
            return Err(ProcessError::Overloaded {
                queue: ProcessQueue::Spawn,
            });
        }
        let mut procs = lock(&self.procs);
        if procs
            .get(&request.handle)
            .is_some_and(|p| p.info.exit.is_none())
        {
            return Err(ProcessError::HandleInUse);
        }
        let (program, args) = match &request.command {
            CommandSpec::Argv { program, args } => (program.clone(), args.clone()),
            CommandSpec::Shell { script, .. } => ("sh".to_owned(), vec![script.clone()]),
        };
        if program == "missing" {
            return Err(ProcessError::ProgramNotFound { program });
        }
        let pid = 1000 + self.next_pid.fetch_add(1, Ordering::Relaxed);
        let mut proc = MockProc {
            info: ProcessInfo {
                handle: request.handle.clone(),
                pid,
                owner: request.owner,
                pty: request.pty,
                exit: None,
            },
            events: Vec::new(),
            stdin_open: request.stdin_piped,
        };
        let stream = if request.pty.is_some() {
            OutputStream::Pty
        } else {
            OutputStream::Stdout
        };
        if program == "echo" {
            proc.push_output(stream, format!("{}\n", args.join(" ")).into_bytes());
            proc.exit(ExitStatus::Code(0), None);
        }
        procs.insert(request.handle.clone(), proc);
        Ok(SpawnedProcess {
            handle: request.handle,
            pid,
        })
    }

    fn subscribe(
        &self,
        handle: &ProcessHandle,
        from_seq: Option<u64>,
    ) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let procs = lock(&self.procs);
        let proc = procs.get(handle).ok_or(ProcessError::UnknownHandle)?;
        let from = from_seq.unwrap_or(0) as usize;
        Ok(Box::new(VecSource::new(
            proc.events.iter().skip(from).cloned(),
        )))
    }

    async fn write_stdin(
        &self,
        handle: &ProcessHandle,
        bytes: Vec<u8>,
    ) -> Result<(), ProcessError> {
        let mut procs = lock(&self.procs);
        let proc = procs.get_mut(handle).ok_or(ProcessError::UnknownHandle)?;
        if !proc.stdin_open {
            return Err(ProcessError::StdinClosed);
        }
        if self.input_full.load(Ordering::Relaxed) {
            return Err(ProcessError::Overloaded {
                queue: ProcessQueue::Input,
            });
        }
        let stream = if proc.info.pty.is_some() {
            OutputStream::Pty
        } else {
            OutputStream::Stdout
        };
        proc.push_output(stream, bytes);
        Ok(())
    }

    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        let mut procs = lock(&self.procs);
        let proc = procs.get_mut(handle).ok_or(ProcessError::UnknownHandle)?;
        if !proc.stdin_open {
            return Err(ProcessError::StdinClosed);
        }
        proc.exit(ExitStatus::Code(0), None);
        Ok(())
    }

    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> {
        let mut procs = lock(&self.procs);
        let proc = procs.get_mut(handle).ok_or(ProcessError::UnknownHandle)?;
        match proc.info.pty.as_mut() {
            Some(pty) => {
                *pty = size;
                Ok(())
            }
            None => Err(ProcessError::NotPty),
        }
    }

    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        let mut procs = lock(&self.procs);
        let proc = procs.get_mut(handle).ok_or(ProcessError::UnknownHandle)?;
        if proc.info.exit.is_some() {
            return Err(ProcessError::AlreadyExited);
        }
        proc.exit(ExitStatus::Signal(9), Some(KillReason::Requested));
        Ok(())
    }

    fn list(&self) -> Vec<ProcessInfo> {
        lock(&self.procs).values().map(|p| p.info.clone()).collect()
    }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/// A repository whose key changes with each piece of evidence.
pub struct MockRepoInspector {
    generation: AtomicU64,
    pub refs: Mutex<HashMap<String, ObjectId>>,
    summaries: Mutex<HashMap<String, ReviewSummary>>,
}

impl Default for MockRepoInspector {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(1),
            refs: Mutex::new(HashMap::new()),
            summaries: Mutex::new(HashMap::new()),
        }
    }
}

impl MockRepoInspector {
    fn current_key(&self) -> InspectorKey {
        InspectorKey {
            head: Some(ObjectId("0".repeat(40))),
            index_checksum: None,
            worktree_token: self.generation.load(Ordering::Relaxed).to_string(),
        }
    }
}

#[async_trait]
impl RepoInspector for MockRepoInspector {
    async fn key(&self, _lane: MaintenanceIo, _repo: RepoRef) -> Result<InspectorKey, ScmError> {
        Ok(self.current_key())
    }

    async fn status(
        &self,
        _lane: MaintenanceIo,
        _repo: RepoRef,
    ) -> Result<Arc<RepoStatus>, ScmError> {
        let key = self.current_key();
        Ok(Arc::new(RepoStatus {
            head: key.head.clone(),
            key,
            branch: Some("main".into()),
            upstream: None,
            operation: None,
            entries: Vec::new(),
        }))
    }

    async fn review_summary(
        &self,
        _lane: MaintenanceIo,
        _request: ReviewRequest,
    ) -> Result<Arc<ReviewSummary>, ScmError> {
        let summary = ReviewSummary {
            key: self.current_key(),
            files: Vec::new(),
            omitted: 0,
        };
        lock(&self.summaries).insert(summary.key.worktree_token.clone(), summary.clone());
        Ok(Arc::new(summary))
    }

    fn review_page(
        &self,
        key: &InspectorKey,
        _path: Option<&str>,
        _cursor: Option<&str>,
    ) -> Result<Cached<ReviewPage>, ScmError> {
        Ok(match lock(&self.summaries).get(&key.worktree_token) {
            Some(_) => Cached::Ready(ReviewPage {
                key: key.clone(),
                patch: String::new(),
                next_cursor: None,
            }),
            None => Cached::Pending { key: key.clone() },
        })
    }

    async fn resolve_refs(
        &self,
        _lane: MaintenanceIo,
        _repo: RepoRef,
        refs: Vec<String>,
    ) -> Result<Vec<Option<ObjectId>>, ScmError> {
        let known = lock(&self.refs);
        Ok(refs.iter().map(|r| known.get(r).cloned()).collect())
    }

    fn evidence(&self, _repo: &RepoRef, _evidence: RepoEvidence) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Extension pool
// ---------------------------------------------------------------------------

struct ExtCallSource {
    frames: VecDeque<ExtFrame>,
    pending: Arc<AtomicUsize>,
}

impl Drop for ExtCallSource {
    fn drop(&mut self) {
        self.pending.fetch_sub(1, Ordering::Relaxed);
    }
}

#[async_trait]
impl EventSource<ExtFrame> for ExtCallSource {
    async fn next(&mut self) -> Option<ExtFrame> {
        self.frames.pop_front()
    }
}

/// One worker; every call yields one chunk and echoes its params. A call is
/// pending until its stream is dropped.
pub struct MockExtPool {
    pub max_pending: usize,
    pending: Arc<AtomicUsize>,
}

impl MockExtPool {
    pub fn new(max_pending: usize) -> Self {
        Self {
            max_pending,
            pending: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl ExtPool for MockExtPool {
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        if self.pending.fetch_add(1, Ordering::Relaxed) >= self.max_pending {
            self.pending.fetch_sub(1, Ordering::Relaxed);
            return Err(ExtError::Overloaded);
        }
        Ok(Box::new(ExtCallSource {
            frames: VecDeque::from([
                ExtFrame::Chunk(b"chunk".to_vec()),
                ExtFrame::Done(Ok(call.params)),
            ]),
            pending: self.pending.clone(),
        }))
    }

    fn status(&self) -> Vec<ExtWorkerStatus> {
        vec![ExtWorkerStatus {
            id: ExtWorkerId(0),
            state: ExtWorkerState::Idle,
        }]
    }

    fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError> {
        if worker == ExtWorkerId(0) {
            Ok(())
        } else {
            Err(ExtError::UnknownWorker)
        }
    }
}

// ---------------------------------------------------------------------------
// Computer and media
// ---------------------------------------------------------------------------

/// A 2×2 BGRA source producing `frames` frames.
pub struct MockFrameSource {
    kind: FrameSourceKind,
    remaining: u64,
    seq: u64,
}

impl MockFrameSource {
    pub fn new(kind: FrameSourceKind, frames: u64) -> Self {
        Self {
            kind,
            remaining: frames,
            seq: 0,
        }
    }
}

#[async_trait]
impl MediaFrameSource for MockFrameSource {
    fn kind(&self) -> FrameSourceKind {
        self.kind.clone()
    }

    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError> {
        // Waits like a real source does, and takes the frame only once ready:
        // a future dropped while waiting consumes nothing.
        let mut waited = false;
        std::future::poll_fn(|cx| {
            if waited {
                std::task::Poll::Ready(())
            } else {
                waited = true;
                cx.waker().wake_by_ref();
                std::task::Poll::Pending
            }
        })
        .await;
        if self.remaining == 0 {
            return Ok(None);
        }
        self.remaining -= 1;
        let seq = self.seq;
        self.seq += 1;
        Ok(Some(VideoFrame {
            width: 2,
            height: 2,
            stride: 8,
            format: PixelFormat::Bgra,
            data: Bytes::from(vec![0u8; 16]),
            seq,
            captured_at: Duration::from_millis(33 * seq),
        }))
    }
}

/// Counts held keys/buttons so `release_input` is observable.
#[derive(Default)]
pub struct MockComputerBackend {
    held: Mutex<u32>,
}

#[async_trait]
impl ComputerBackend for MockComputerBackend {
    async fn run(
        &self,
        request: ComputerRequest,
        cancel: CancellationToken,
    ) -> Result<Vec<ToolPart>, ComputerError> {
        if cancel.is_cancelled() {
            return Err(ComputerError::Cancelled);
        }
        Ok(vec![ToolPart::Text(request.action.wire_name().to_owned())])
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        let mut held = lock(&self.held);
        match input {
            ScreenInput::Button { down: true, .. } | ScreenInput::Key { down: true, .. } => {
                *held += 1
            }
            ScreenInput::Button { down: false, .. } | ScreenInput::Key { down: false, .. } => {
                *held = held.saturating_sub(1)
            }
            _ => {}
        }
        Ok(InputOutcome::Applied)
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        Ok(std::mem::take(&mut *lock(&self.held)))
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        Some(DesktopIdentity {
            session: 1,
            desktop: "default".into(),
        })
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        Ok(vec![DisplayInfo {
            id: DisplayId(0),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale_percent: 100,
        }])
    }

    fn screen_source(
        &self,
        display: DisplayId,
    ) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        if display != DisplayId(0) {
            return Err(ComputerError::InvalidInput {
                reason: "unknown display".into(),
            });
        }
        Ok(Box::new(MockFrameSource::new(
            FrameSourceKind::Screen { display: 0 },
            3,
        )))
    }

    fn status(&self) -> ComputerStatus {
        ComputerStatus::default()
    }
}

pub struct MockVideoTrack {
    params: Mutex<EncodingParams>,
    pub keyframes: AtomicU32,
    pub stopped: Mutex<bool>,
    source: Mutex<Option<Box<dyn MediaFrameSource>>>,
}

impl Default for MockVideoTrack {
    fn default() -> Self {
        Self {
            params: Mutex::new(EncodingParams::SCREEN_DEFAULT),
            keyframes: AtomicU32::new(0),
            stopped: Mutex::new(false),
            source: Mutex::new(None),
        }
    }
}

impl MockVideoTrack {
    pub fn source_kind(&self) -> Option<FrameSourceKind> {
        lock(&self.source).as_ref().map(|s| s.kind())
    }
}

impl VideoTrack for MockVideoTrack {
    fn codec(&self) -> VideoCodec {
        VideoCodec::Vp8
    }

    fn set_source(&self, source: Box<dyn MediaFrameSource>) {
        *lock(&self.source) = Some(source);
    }

    fn set_encoding(&self, params: EncodingParams) -> Result<(), MediaError> {
        if params.max_bitrate_bps == Some(0) || params.max_framerate == Some(0) {
            return Err(MediaError::Encoder {
                detail: "zero bitrate or framerate".into(),
            });
        }
        *lock(&self.params) = params;
        Ok(())
    }

    fn encoding(&self) -> EncodingParams {
        *lock(&self.params)
    }

    fn request_keyframe(&self) {
        self.keyframes.fetch_add(1, Ordering::Relaxed);
    }

    fn stop(&self) {
        *lock(&self.stopped) = true;
    }
}

// ---------------------------------------------------------------------------
// Login and ownership
// ---------------------------------------------------------------------------

struct LoginInner {
    queue: VecDeque<LoginState>,
    current: LoginState,
    finished: bool,
}

pub struct MockLoginSession {
    inner: Mutex<LoginInner>,
}

#[async_trait]
impl LoginSession for MockLoginSession {
    fn state(&self) -> LoginState {
        lock(&self.inner).current.clone()
    }

    async fn next(&self) -> Option<LoginState> {
        let mut inner = lock(&self.inner);
        if inner.finished {
            return None;
        }
        let state = inner.queue.pop_front()?;
        inner.finished = state.is_terminal();
        inner.current = state.clone();
        Some(state)
    }

    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        let mut inner = lock(&self.inner);
        if inner.finished {
            return Err(LoginError::Finished);
        }
        match (&inner.current, input) {
            (LoginState::Authorize { .. }, LoginInput::AuthorizationCode(_)) => {
                inner.queue = VecDeque::from([LoginState::Done {
                    account: Some("mock".into()),
                }]);
                Ok(())
            }
            _ => Err(LoginError::InputNotExpected),
        }
    }

    fn cancel(&self) {
        let mut inner = lock(&self.inner);
        if !inner.finished {
            inner.queue = VecDeque::from([LoginState::Cancelled]);
        }
    }
}

struct LiveLoginInner {
    state: Mutex<LoginInner>,
    wake: tokio::sync::Notify,
}

/// A login session the test drives: [`Self::emit`] queues the next state, and `next` waits for it, so a
/// flow follows the test step by step. Clones are the same session.
#[derive(Clone)]
pub struct LiveLoginSession {
    inner: Arc<LiveLoginInner>,
}

impl LiveLoginSession {
    /// A session whose current state is `initial`.
    pub fn new(initial: LoginState) -> Self {
        Self {
            inner: Arc::new(LiveLoginInner {
                state: Mutex::new(LoginInner { queue: VecDeque::new(), current: initial, finished: false }),
                wake: tokio::sync::Notify::new(),
            }),
        }
    }

    /// Queues the state the next `next` answers.
    pub fn emit(&self, state: LoginState) {
        lock(&self.inner.state).queue.push_back(state);
        self.inner.wake.notify_one();
    }
}

#[async_trait]
impl LoginSession for LiveLoginSession {
    fn state(&self) -> LoginState {
        lock(&self.inner.state).current.clone()
    }

    async fn next(&self) -> Option<LoginState> {
        loop {
            {
                let mut inner = lock(&self.inner.state);
                if inner.finished {
                    return None;
                }
                if let Some(state) = inner.queue.pop_front() {
                    inner.finished = state.is_terminal();
                    inner.current = state.clone();
                    return Some(state);
                }
            }
            self.inner.wake.notified().await;
        }
    }

    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        let accepted = {
            let inner = lock(&self.inner.state);
            if inner.finished {
                return Err(LoginError::Finished);
            }
            matches!((&inner.current, &input), (LoginState::Authorize { .. }, LoginInput::AuthorizationCode(_)))
        };
        if !accepted {
            return Err(LoginError::InputNotExpected);
        }
        self.emit(LoginState::Done { account: None });
        Ok(())
    }

    fn cancel(&self) {
        {
            let mut inner = lock(&self.inner.state);
            if inner.finished {
                return;
            }
            inner.queue = VecDeque::from([LoginState::Cancelled]);
        }
        self.inner.wake.notify_one();
    }
}

/// Plays a scripted state sequence after `Starting`.
pub struct MockLoginFlow {
    target: LoginTarget,
    script: Vec<LoginState>,
}

impl MockLoginFlow {
    pub fn new(target: LoginTarget, script: Vec<LoginState>) -> Self {
        Self { target, script }
    }
}

#[async_trait]
impl LoginFlow for MockLoginFlow {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        Ok(Box::new(MockLoginSession {
            inner: Mutex::new(LoginInner {
                queue: self.script.iter().cloned().collect(),
                current: LoginState::Starting,
                finished: false,
            }),
        }))
    }
}

/// Holds ownership until [`MockOwnership::lose`] injects a failed check.
pub struct MockOwnership {
    fenced: Mutex<Option<FenceReason>>,
    next_failure: Mutex<Option<FenceReason>>,
}

impl Default for MockOwnership {
    fn default() -> Self {
        Self {
            fenced: Mutex::new(None),
            next_failure: Mutex::new(None),
        }
    }
}

impl MockOwnership {
    /// The next revalidation observes `reason`.
    pub fn lose(&self, reason: FenceReason) {
        *lock(&self.next_failure) = Some(reason);
    }
}

impl Ownership for MockOwnership {
    fn instance_id(&self) -> &str {
        "mock-instance"
    }

    fn revalidate(&self) -> Result<(), FenceReason> {
        let mut fenced = lock(&self.fenced);
        if let Some(reason) = *fenced {
            return Err(reason);
        }
        if let Some(reason) = lock(&self.next_failure).take() {
            *fenced = Some(reason);
            return Err(reason);
        }
        Ok(())
    }
}
