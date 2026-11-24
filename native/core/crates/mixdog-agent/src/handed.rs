//! A session's tool calls made by an agent that runs the turn outside the loop. Each call is a tool batch of one in
//! a run of the loop ([`Run::process_tool_batch`]), and calls the agent made together that change nothing are one
//! batch: what the loop does with a batch (its projection of `call_tool`
//! onto the target, the repeat guard, the gate and approval wait, the deadline, the hooks, the error kind, the
//! offload of a large result, the result cache and the after-batch hook) is done here by the loop itself. The run
//! sends no request: its transcript is the turn's handed calls, and what it would commit is given back to the caller.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::Decision;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ProviderId;
use tokio_util::sync::CancellationToken;

use crate::env::Clock;
use crate::env::CommitError;
use crate::env::JitterSource;
use crate::env::McpCatalog;
use crate::env::ResultReuse;
use crate::env::RetryWait;
use crate::env::Rewrite;
use crate::env::RunObserver;
use crate::env::Ticket;
use crate::env::ToolFailureLog;
use crate::env::ToolGate;
use crate::env::ToolHooks;
use crate::env::TranscriptSink;
use crate::env::TurnGuards;
use crate::env::Yielder;
use crate::message::AgentMessage;
use crate::message::ToolKind;
use crate::offload::ArtifactStore;
use crate::offload::ImageCompactor;
use crate::run::Run;
use crate::run::RunCarry;
use crate::run::RunConfig;
use crate::tools::LiveCwd;
use crate::tools::RepeatGuards;
use crate::tools::ToolEnv;
use crate::tools::ToolSet;

/// What the calls of one turn run under: the turn's assembled parts.
pub struct HandedParts {
    pub tools: ToolSet,
    pub tool_env: ToolEnv,
    pub gate: Arc<dyn ToolGate>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub guards: Arc<dyn TurnGuards>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub clock: Arc<dyn Clock>,
    /// Hears the calls' stages (an approval wait among them) as the loop's observer hears them.
    pub observer: Arc<dyn RunObserver>,
    pub mcp: Option<Arc<dyn McpCatalog>>,
    pub live_cwd: Option<LiveCwd>,
    /// Where a large result is stored; without one it stays inline.
    pub artifacts: Option<Arc<dyn ArtifactStore>>,
    pub images: Option<Arc<dyn ImageCompactor>>,
    pub failures: Option<Arc<dyn ToolFailureLog>>,
    /// The session's repeat guards, as its record holds them.
    pub repeat: RepeatGuards,
    /// The turn's token.
    pub cancel: CancellationToken,
    /// The agent lane's admission lease of an agent-owned turn, which a call's wait on the user gives up as the loop's does.
    pub slot: Option<Arc<dyn Yielder>>,
    /// The approvals the turn's gate asks on where the gate holds its own (`PolicyGate` waits inside its judgement),
    /// made with [`JudgedAsks::over`]. `None` for a gate that asks on the calls' own approvals.
    pub asks: Option<Arc<JudgedAsks>>,
}

/// The approvals a turn's calls are asked on. What a call that is only being judged would be asked is put to nobody:
/// it is noted, and asking about the call is its caller's.
pub struct JudgedAsks {
    inner: Arc<dyn ApprovalGate>,
    /// The calls being judged, by id, each with whether it would be asked about.
    judging: Arc<Mutex<HashMap<String, bool>>>,
}

impl JudgedAsks {
    pub fn over(inner: Arc<dyn ApprovalGate>) -> Arc<Self> {
        Arc::new(Self { inner, judging: Arc::default() })
    }

    /// `inner`, for the calls being judged with these.
    fn alongside(&self, inner: Arc<dyn ApprovalGate>) -> Arc<Self> {
        Arc::new(Self { inner, judging: self.judging.clone() })
    }

    fn judging(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.judging.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl ApprovalGate for JudgedAsks {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        let judged = ask.call_id.as_ref().and_then(|id| self.judging().get_mut(id.as_str()).map(|asked| *asked = true)).is_some();
        if judged {
            // Nobody was asked, so no decision is recorded: the gate ends its judgement as a stopped wait ends it.
            return ApprovalResolution::Cancelled { at: 0 };
        }
        self.inner.request(ask).await
    }
}

/// A call under judgement, for as long as it is judged.
struct Judging<'a>(&'a JudgedAsks, &'a str);

impl Judging<'_> {
    fn asked(&self) -> bool {
        self.0.judging().get(self.1).copied().unwrap_or(false)
    }
}

impl Drop for Judging<'_> {
    fn drop(&mut self) {
        self.0.judging().remove(self.1);
    }
}

/// What the session's permissions make of a call they judge and do not run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Judged {
    /// Every part of the call would run as it is, with nobody asked.
    Allowed,
    /// The text a call of the session's tool would be refused with.
    Refused(String),
    /// The session would ask the user about the call.
    Asks,
    /// The session would run the call only changed (a hook's rewrite): a call that is not run here cannot be changed,
    /// so it is not the session's to allow.
    Changed,
}

/// One finished call.
pub struct Handed {
    /// The call's tool message, as the loop commits one: its content, its kind, its card diff and its timing.
    pub message: AgentMessage,
    /// What the batch adds to the conversation beside the result: a loaded skill's instructions, the reminder of the
    /// user's after-batch hook.
    pub follow_ups: Vec<String>,
    pub failed: bool,
}

/// The messages the run commits: kept for the caller, who stores the turn's rows.
#[derive(Default)]
struct Kept(Mutex<Vec<AgentMessage>>);

#[async_trait]
impl TranscriptSink for Kept {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(message.clone());
        Ok(Ticket(0))
    }
    fn replace(&self, _: &[AgentMessage], _: &Rewrite) {}
    fn message_id(&self) -> String {
        String::new()
    }
    async fn durable(&self, _: Ticket) {}
}

/// The run's provider: no model answers a turn an agent outside the loop runs, so nothing is ever sent.
struct NoModel {
    id: ProviderId,
    policy: RetryPolicy,
}

struct NoWire;

impl WireDecoder for NoWire {
    fn feed(&mut self, _: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        Err(unsent())
    }
    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        Err(unsent())
    }
    fn terminal_seen(&self) -> bool {
        false
    }
    fn exposure(&self) -> Exposure {
        Exposure::default()
    }
}

impl WireCodec for NoWire {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }
    fn encode(&self, _: &ModelRequest) -> Result<WireRequest, ProviderError> {
        Err(unsent())
    }
    fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::new(NoWire)
    }
    fn classify(&self, _: &ErrorResponse) -> ProviderError {
        unsent()
    }
}

fn unsent() -> ProviderError {
    ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent)
}

#[async_trait]
impl ProviderAdapter for NoModel {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &NoWire
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &KeepaliveSchedule::SPEC
    }
    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Err(unsent())
    }
    fn release_send(&self, _: &str) {}
    // The protocol's tool result carries no document block.
    fn native_pdf(&self) -> bool {
        false
    }
}

/// The retry path's parts of a run that sends nothing.
struct Unsent;

impl JitterSource for Unsent {
    fn draw(&self) -> f64 {
        0.0
    }
}

#[async_trait]
impl RetryWait for Unsent {
    async fn wait(&self, _: Duration) {}
}

impl RetryDecider for Unsent {
    fn verdict(&self, error: &ProviderError, state: &RetryState, _: &RetryPolicy, _: JitterSamples) -> Decision {
        Decision { verdict: Verdict::Surface, next: state.after_failure(error.kind) }
    }
}

/// The calls of one turn.
#[allow(clippy::disallowed_types, reason = "see HandedCalls::run")]
pub struct HandedCalls {
    /// One turn's calls run one at a time over the same run (calls made together as one), each holding it for as long as
    /// it runs. Only a call and the turn's end wait here; a judgement reads `env` and never does.
    run: tokio::sync::Mutex<Run>,
    env: Arc<crate::tools::CallEnv>,
    kept: Arc<Kept>,
    asks: Arc<JudgedAsks>,
}

impl HandedCalls {
    #[allow(clippy::disallowed_types, reason = "see HandedCalls::run")]
    pub fn new(mut parts: HandedParts) -> Self {
        let asks = parts.asks.take().unwrap_or_else(|| JudgedAsks::over(parts.tool_env.approvals.clone()));
        parts.tool_env.approvals = asks.alongside(parts.tool_env.approvals.clone());
        let kept = Arc::new(Kept::default());
        let mut env = crate::one_shot::isolated(parts.clock, Arc::new(Unsent), Arc::new(Unsent), Arc::new(Unsent));
        env.observer = parts.observer;
        env.sink = kept.clone();
        env.gate = parts.gate;
        env.guards = parts.guards;
        env.hooks = parts.hooks;
        env.reuse = parts.reuse;
        env.mcp = parts.mcp;
        env.artifacts = parts.artifacts;
        env.images = parts.images;
        env.failures = parts.failures;
        let mut config = RunConfig::new(parts.tool_env.thread_id.clone(), parts.tool_env.turn_id.clone(), String::new());
        config.live_cwd = parts.live_cwd;
        config.slot = parts.slot;
        let provider = Arc::new(NoModel { id: ProviderId::from("outside"), policy: RetryPolicy::codex_default() });
        let carry = RunCarry { repeat: parts.repeat, ..RunCarry::default() };
        let mut run = Run::new(env, parts.cancel, provider, parts.tools, parts.tool_env, config, Vec::new(), carry);
        run.outside = true;
        let env = run.call_env();
        Self { run: tokio::sync::Mutex::new(run), env, kept, asks }
    }

    /// Runs `call` as a batch of one: a `call_tool` as its target, any other call as itself.
    pub async fn call(&self, call: ToolCall) -> Handed {
        self.calls(std::slice::from_ref(&call)).await.pop().expect("an outcome for every call")
    }

    /// Runs `calls`, made together, in their order, each as [`Self::call`] runs one: each stretch of consecutive calls
    /// that change nothing as one batch, whose calls the loop runs at the same time, and each other call as a batch of
    /// its own once every call before it has ended. A refused or failed call does not stop the calls after it. The
    /// outcomes are in the calls' order; what a batch adds beside its results is given with its last call's.
    pub async fn calls(&self, calls: &[ToolCall]) -> Vec<Handed> {
        let mut run = self.run.lock().await;
        let (targets, _, _) = run.execution_view(calls);
        let cancelled =
            |id: &str| Handed { message: AgentMessage::tool_text(id, "Error: tool call cancelled", ToolKind::Error), follow_ups: Vec::new(), failed: true };
        let mut outcomes = Vec::with_capacity(calls.len());
        let mut stopped = false;
        let mut start = 0;
        while start < calls.len() {
            let unchanging = targets[start..].iter().take_while(|target| run.tools.read_only(&target.name)).count();
            let batch = &calls[start..start + unchanging.max(1)];
            start += batch.len();
            // The turn was stopped under an earlier batch, between two or before the first: nothing from here on runs.
            stopped |= self.env.cancel.is_cancelled();
            if stopped {
                outcomes.extend(batch.iter().map(|call| cancelled(&call.id)));
                continue;
            }
            // The batch reads its calls in the transcript they belong to, as the loop's batch reads its response's.
            run.messages.push(AgentMessage::assistant("", batch.to_vec()));
            let ended = run.process_tool_batch(batch, batch.len() as u64).await;
            stopped = ended.is_err();
            let mut told = std::mem::take(&mut *self.kept.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
            let results: Vec<Option<AgentMessage>> =
                batch.iter().map(|call| told.iter().position(|message| message.tool_call_id() == Some(call.id.as_str())).map(|at| told.remove(at))).collect();
            let mut follow_ups: Vec<String> = told.iter().map(AgentMessage::text).collect();
            for (index, (call, result)) in batch.iter().zip(results).enumerate() {
                let follow_ups = if index + 1 == batch.len() { std::mem::take(&mut follow_ups) } else { Vec::new() };
                outcomes.push(match result.filter(|_| !stopped) {
                    Some(message) => Handed { failed: message.tool_kind == Some(ToolKind::Error), follow_ups, message },
                    // The turn was stopped under the call.
                    None => cancelled(&call.id),
                });
            }
        }
        outcomes
    }

    /// The session's answer to a call of its tool `name` that is not run here (an outside agent runs the same kind of
    /// work with a tool of its own): the surface, the PreToolUse hooks and the human gate a call of that tool meets
    /// before it runs, once for each of `arguments` (a call that touches several files is judged on every one). The
    /// first that is refused, would be asked about or would run changed decides the call. Nobody is asked here.
    pub async fn judge(&self, id: &str, name: &str, arguments: &[serde_json::Value]) -> Judged {
        let env = &self.env;
        let cwd = env.cwd_now();
        self.asks.judging().insert(id.to_owned(), false);
        let judging = Judging(&self.asks, id);
        for arguments in arguments {
            let judged = crate::tools::authorize(
                (id, name),
                arguments,
                cwd.as_path(),
                env.gate.as_ref(),
                env.tool_env.approvals.as_ref(),
                env.observer.as_ref(),
                env.guards.as_ref(),
            );
            let judged = crate::env::or_cancelled(&env.cancel, judged).await;
            if judging.asked() {
                return Judged::Asks;
            }
            match judged {
                None => return Judged::Refused("Error: tool call cancelled".to_owned()),
                Some(Err(refusal)) => return Judged::Refused(refusal),
                Some(Ok(target)) if target.name != name || target.args != *arguments => return Judged::Changed,
                Some(Ok(_)) => {}
            }
        }
        Judged::Allowed
    }

    /// The session's repeat guards after the turn's calls, as its record keeps them.
    pub async fn repeat_saved(&self) -> serde_json::Map<String, serde_json::Value> {
        self.run.lock().await.carry.repeat.to_saved()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::mock::MockFileService;
    use mixdog_core_api::domain::mock::MockProcessManager;
    use mixdog_core_api::domain::mock::MockProgress;
    use mixdog_core_api::domain::tool::CallProjection;
    use mixdog_core_api::domain::tool::SurfaceKind;
    use mixdog_core_api::domain::tool::Tool;
    use mixdog_core_api::domain::tool::ToolContext;
    use mixdog_core_api::domain::tool::ToolIo;
    use mixdog_core_api::domain::tool::ToolOutcome;
    use mixdog_core_api::domain::tool::ToolOutput;
    use mixdog_core_api::domain::tool::ToolPart;
    use mixdog_core_api::domain::tool::ToolSpec;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_api::ids::TurnId;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::env::GateCall;
    use crate::env::GateDecision;

    /// What the pipeline did, in order: the gate's judgements, the tool's runs with what each was told, the hooks' reports.
    type Seen = Arc<Mutex<Vec<String>>>;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            0
        }
    }

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({ "type": "object" }),
            annotations: Default::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }
    }

    /// The deferred tool a `call_tool` stands for: its result carries a card diff.
    struct Target(ToolSpec, Seen);

    #[async_trait::async_trait]
    impl Tool for Target {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, ctx: &ToolContext, _: Value) -> ToolOutcome {
            let told = (ctx.deadline.is_some(), ctx.review.is_some(), ctx.options.outside_context);
            self.1.lock().unwrap().push(format!("run {} {told:?}", self.0.name));
            Ok(ToolOutput { parts: vec![ToolPart::Text("done".into())], meta: Some(json!({ "uiDiff": "@@ -1 +1 @@" })), ..ToolOutput::default() })
        }
    }

    struct CallTool(ToolSpec);

    impl CallProjection for CallTool {
        fn project(&self, _: &ThreadId, arguments: &Value) -> Result<(String, Value), String> {
            Ok((arguments["name"].as_str().unwrap_or_default().to_owned(), arguments["arguments"].clone()))
        }
    }

    #[async_trait::async_trait]
    impl Tool for CallTool {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        fn projection(&self) -> Option<&dyn CallProjection> {
            Some(self)
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            panic!("a projected call runs its target, never the projecting tool")
        }
    }

    struct Witness(Seen);

    #[async_trait::async_trait]
    impl ToolGate for Witness {
        async fn check_call(&self, _: &str, call: &GateCall) -> GateDecision {
            self.0.lock().unwrap().push(format!("judge {}", call.name));
            GateDecision::Allow
        }
    }

    #[async_trait::async_trait]
    impl ToolHooks for Witness {
        async fn after_tool(&self, _: &str, call: &GateCall, _: &str) -> Option<String> {
            self.0.lock().unwrap().push(format!("report {}", call.name));
            None
        }
        async fn after_batch(&self, tool_count: usize) -> Option<String> {
            self.0.lock().unwrap().push(format!("batch of {tool_count}"));
            Some("the user's after-batch word".to_owned())
        }
    }

    /// A tool that answers its failure as text, as the skill and MCP tools do.
    struct Refuses(ToolSpec);

    #[async_trait::async_trait]
    impl Tool for Refuses {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
            Ok(ToolOutput { parts: vec![ToolPart::Text("Error: no such skill".into())], ..ToolOutput::default() })
        }
    }

    fn calls_of(seen: &Seen) -> HandedCalls {
        calls_with(seen, Arc::new(Witness(seen.clone())), Arc::new(MockApprovalGate::default()))
    }

    fn calls_with(seen: &Seen, gate: Arc<dyn ToolGate>, approvals: Arc<MockApprovalGate>) -> HandedCalls {
        calls_under(seen, gate, approvals, CancellationToken::new())
    }

    /// [`calls_with`], for a turn whose token is `cancel`.
    fn calls_under(seen: &Seen, gate: Arc<dyn ToolGate>, approvals: Arc<MockApprovalGate>, cancel: CancellationToken) -> HandedCalls {
        let tokens = mixdog_rt::testing::tokens();
        HandedCalls::new(HandedParts {
            tools: ToolSet::new(vec![Arc::new(CallTool(spec("call_tool"))), Arc::new(Target(spec("edit"), seen.clone())), Arc::new(Refuses(spec("Skill")))]),
            tool_env: ToolEnv {
                thread_id: ThreadId::from("t"),
                turn_id: TurnId::from("r"),
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals,
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: Arc::new(MockProgress::default()),
                deadline_of: Some(Arc::new(|_: &ToolSpec| Some(Duration::from_secs(60)))),
                notify: None,
                review: None,
            },
            gate,
            hooks: Some(Arc::new(Witness(seen.clone()))),
            guards: Arc::new(crate::env::NoGuards),
            reuse: None,
            clock: Arc::new(Fixed),
            observer: Arc::new(crate::env::NullObserver),
            mcp: None,
            live_cwd: None,
            artifacts: None,
            images: None,
            failures: None,
            repeat: RepeatGuards::default(),
            cancel,
            slot: None,
            asks: None,
        })
    }

    /// A handed `call_tool` is the loop's: its target is judged once, run once with the loop's deadline and no claim that
    /// the caller reads the session's rows, and reported once; the projecting tool is none of the three. The result is the
    /// loop's tool message, card diff included.
    #[tokio::test]
    async fn a_handed_call_tool_runs_its_target_once_as_the_loop_runs_it() {
        let seen: Seen = Arc::default();
        let calls = calls_of(&seen);
        let call =
            ToolCall { id: "c1".into(), name: "call_tool".into(), arguments: json!({ "name": "edit", "arguments": { "path": "a.txt" } }), native_type: None };

        let handed = calls.call(call).await;

        assert_eq!(*seen.lock().unwrap(), ["judge edit", "run edit (true, false, true)", "report edit", "batch of 1"]);
        assert!(!handed.failed);
        assert_eq!(handed.message.text(), "done");
        assert_eq!(handed.message.ui_diff.as_deref(), Some("@@ -1 +1 @@"));
        assert_eq!(handed.message.tool_call_id(), Some("c1"));
    }

    /// Judges a call by the file it names: `secret…` is refused, `ask…` asked about, `moved…` run on another file, and
    /// any other allowed.
    struct ByFile(Seen);

    #[async_trait::async_trait]
    impl ToolGate for ByFile {
        async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
            let file = call.args["file_path"].as_str().unwrap_or_default().to_owned();
            self.0.lock().unwrap().push(format!("judge {file}"));
            if file.starts_with("secret") {
                return GateDecision::Deny(format!("Error: {file} is off limits"));
            }
            if file.starts_with("moved") {
                return GateDecision::Rewrite(GateCall::new(call.name.clone(), json!({ "file_path": "elsewhere.txt" })));
            }
            if !file.starts_with("ask") {
                return GateDecision::Allow;
            }
            let ask = ApprovalAsk {
                kind: mixdog_core_api::domain::approval::ApprovalKind::Tool,
                call_id: Some(mixdog_protocol::ToolCallId::from(call_id.to_owned())),
                tool: Some(call.name.clone()),
                action_kind: None,
                reason: None,
                payload: json!({}),
                remember: Vec::new(),
                expires_after: None,
            };
            GateDecision::Ask(Box::new(crate::env::GateAsk { reason: "needs a person".into(), ask, call: None }))
        }
    }

    /// A call that is only judged meets the session's gate as a call of that tool does, and nothing of it runs: no tool,
    /// no hook's report, no batch. The gate's refusal is the judgement's.
    #[tokio::test]
    async fn a_judged_call_meets_the_gate_and_runs_nothing() {
        let seen: Seen = Arc::default();
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), Arc::default());
        assert_eq!(calls.judge("c1", "edit", &[json!({ "file_path": "a.txt" })]).await, Judged::Allowed);
        assert_eq!(*seen.lock().unwrap(), ["judge a.txt"]);
        assert_eq!(calls.judge("c2", "edit", &[json!({ "file_path": "secret.txt" })]).await, Judged::Refused("Error: secret.txt is off limits".to_owned()));
        assert_eq!(*seen.lock().unwrap(), ["judge a.txt", "judge secret.txt"], "a refused call ran nothing");
    }

    /// A call that touches several files is judged on every one of them: the first that is refused or would be asked
    /// about decides the call, whatever the files before it were judged.
    #[tokio::test]
    async fn a_judged_call_is_decided_by_every_file_it_touches() {
        let seen: Seen = Arc::default();
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), Arc::default());
        let files = |names: &[&str]| names.iter().map(|name| json!({ "file_path": name })).collect::<Vec<_>>();
        assert_eq!(calls.judge("c1", "edit", &files(&["a.txt", "b.txt"])).await, Judged::Allowed);
        assert_eq!(calls.judge("c2", "edit", &files(&["a.txt", "secret.txt", "ask.txt"])).await, Judged::Refused("Error: secret.txt is off limits".to_owned()));
        assert_eq!(calls.judge("c3", "edit", &files(&["a.txt", "ask.txt", "secret.txt"])).await, Judged::Asks);
        assert_eq!(*seen.lock().unwrap(), ["judge a.txt", "judge b.txt", "judge a.txt", "judge secret.txt", "judge a.txt", "judge ask.txt"]);
    }

    /// What the gate would ask about a judged call is put to nobody, and is the judgement's; the same ask about a call
    /// the session runs still reaches its approvals.
    #[tokio::test]
    async fn a_judged_call_the_gate_would_ask_about_asks_nobody() {
        let seen: Seen = Arc::default();
        let approvals = Arc::new(MockApprovalGate::default());
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), approvals.clone());
        assert_eq!(calls.judge("c1", "edit", &[json!({ "file_path": "ask.txt" })]).await, Judged::Asks);
        assert!(approvals.asks.lock().unwrap().is_empty(), "nobody was asked");

        let call = ToolCall { id: "c1".into(), name: "edit".into(), arguments: json!({ "file_path": "ask.txt" }), native_type: None };
        calls.call(call).await;
        assert_eq!(approvals.asks.lock().unwrap().len(), 1, "a call the session runs is asked about");
    }

    /// The agent's own call cannot be changed: one the session would run only rewritten is not the session's to allow.
    #[tokio::test]
    async fn a_judged_call_the_gate_would_rewrite_is_not_allowed() {
        let seen: Seen = Arc::default();
        let calls = calls_with(&seen, Arc::new(ByFile(seen.clone())), Arc::default());
        assert_eq!(calls.judge("c1", "edit", &[json!({ "file_path": "a.txt" }), json!({ "file_path": "moved.txt" })]).await, Judged::Changed);
    }

    /// A handed call ends as a batch of the loop ends: a result that reads as an error is an error call, and the user's
    /// after-batch hook runs, its word given back beside the result.
    #[tokio::test]
    async fn a_handed_call_is_finished_by_the_loops_after_batch_step() {
        let seen: Seen = Arc::default();
        let calls = calls_of(&seen);

        let handed = calls.call(ToolCall { id: "c1".into(), name: "Skill".into(), arguments: json!({ "name": "none" }), native_type: None }).await;

        assert!(handed.failed, "a tool that answers `Error: …` is a failed call");
        assert_eq!((handed.message.tool_kind, handed.message.message.is_error), (Some(ToolKind::Error), true));
        assert_eq!(handed.follow_ups, ["<system-reminder>\nthe user's after-batch word\n</system-reminder>"]);
        assert!(seen.lock().unwrap().contains(&"batch of 1".to_owned()));
    }

    /// Refuses every call on the session's surface, noting the file it names, and stops the turn as it refuses.
    struct StopsTheTurn(Seen, CancellationToken);

    #[async_trait::async_trait]
    impl ToolGate for StopsTheTurn {
        async fn check_call(&self, _: &str, _: &GateCall) -> GateDecision {
            GateDecision::Allow
        }
        fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
            self.0.lock().unwrap().push(format!("judge {}", call.args["file_path"].as_str().unwrap_or_default()));
            self.1.cancel();
            Some("Error: off this surface".to_owned())
        }
    }

    /// Two edits handed together are two batches. The turn is stopped while the first is refused, which its batch answers
    /// without a run: the second is never judged, started or reported, and its outcome is the cancellation.
    #[tokio::test]
    async fn a_call_handed_behind_a_stop_of_the_turn_is_cancelled_unjudged() {
        let seen: Seen = Arc::default();
        let cancel = CancellationToken::new();
        let calls = calls_under(&seen, Arc::new(StopsTheTurn(seen.clone(), cancel.clone())), Arc::default(), cancel);
        let edit = |id: &str, file: &str| ToolCall { id: id.into(), name: "edit".into(), arguments: json!({ "file_path": file }), native_type: None };

        let handed = calls.calls(&[edit("c1", "a.txt"), edit("c2", "b.txt")]).await;

        assert_eq!(*seen.lock().unwrap(), ["judge a.txt", "batch of 1"]);
        assert_eq!(handed[0].message.text(), "Error: off this surface");
        assert_eq!(handed[1].message.text(), "Error: tool call cancelled");
        assert!(handed[1].failed);
    }
}
