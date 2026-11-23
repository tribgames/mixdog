//! A model's `call_tool` on a bridge session, through the run loop with a scripted provider, the real policy gate and the real
//! `load_tool` / `call_tool` tools: a deferred tool runs with or without `load_tool` first, a denying session refuses it and a
//! read-only session runs only a read-only one, an approval or a hook denial lets the target run or stops it, and an emptied
//! parent goes while an empty object stays. A run event no scenario accounts for fails the test, and an approval card carries the
//! run's thread id as its `sessionId`.

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
use mixdog_agent::cancel::Abort;
use mixdog_agent::cancel::Cancel;
use mixdog_agent::env::BoundAccount;
use mixdog_agent::env::Clock;
use mixdog_agent::env::CommitError;
use mixdog_agent::env::DrainRequest;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateSession;
use mixdog_agent::env::JitterSource;
use mixdog_agent::env::NoGuards;
use mixdog_agent::env::PolicyGate;
use mixdog_agent::env::PolicyGateParts;
use mixdog_agent::env::Retracted;
use mixdog_agent::env::RetryWait;
use mixdog_agent::env::Rewrite;
use mixdog_agent::env::RunEnv;
use mixdog_agent::env::RunEvent;
use mixdog_agent::env::RunObserver;
use mixdog_agent::env::Stage;
use mixdog_agent::env::SteerEntry;
use mixdog_agent::env::SteerSource;
use mixdog_agent::env::TextRetraction;
use mixdog_agent::env::Ticket;
use mixdog_agent::env::ToolBatch;
use mixdog_agent::env::ToolHooks;
use mixdog_agent::env::ToolPhase;
use mixdog_agent::env::TranscriptSink;
use mixdog_agent::interrupt::AbortReason;
use mixdog_agent::interrupt::Interrupted;
use mixdog_agent::interrupt::Phase;
use mixdog_agent::interrupt::finalize_interrupted_turn;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::message::ToolKind;
use mixdog_agent::tools::ToolEnv;
use mixdog_agent::tools::ToolSet;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockCodec;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::mock::MockRetryDecider;
use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
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
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolApprovalDecision;
use mixdog_protocol::TurnId;
use mixdog_tools::orch::bridge::CallResolution;
use mixdog_tools::orch::bridge::CallTool;
use mixdog_tools::orch::bridge::CatalogView;
use mixdog_tools::orch::bridge::LoadTool;
use mixdog_tools::orch::bridge::ToolDispatcher;
use mixdog_tools::orch::bridge::ToolDoc;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::HookDecision;
use mixdog_tools::policy::HookFailure;
use mixdog_tools::policy::MemoryGrantStore;
use mixdog_tools::policy::PolicySettings;
use mixdog_tools::policy::PreToolHook;
use mixdog_tools::policy::SessionFacts;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// Everything observable, in the order it happened (the recording's `timeline`).
#[derive(Clone, Default)]
struct Timeline(Arc<TimelineInner>);

#[derive(Default)]
struct TimelineInner {
    state: Mutex<TimelineState>,
}

/// The entries, and the waits not met yet in the order they were asked: an entry releases the waits it meets in that order, as the
/// recorder's `note` does (its `waiters`).
#[derive(Default)]
struct TimelineState {
    entries: Vec<Value>,
    waiters: Vec<(Value, tokio::sync::oneshot::Sender<()>)>,
}

fn meets(entry: &Value, matching: &Value) -> bool {
    matching.as_object().expect("match").iter().all(|(key, value)| entry[key] == *value)
}

impl Timeline {
    fn note(&self, entry: Value) {
        let mut state = self.0.state.lock().expect("timeline");
        let waiting = std::mem::take(&mut state.waiters);
        for (matching, met) in waiting {
            if meets(&entry, &matching) {
                let _ = met.send(());
            } else {
                state.waiters.push((matching, met));
            }
        }
        state.entries.push(entry);
    }

    fn all(&self) -> Vec<Value> {
        self.0.state.lock().expect("timeline").entries.clone()
    }

    /// Resolves once an entry has every field of `matching`, or fails naming what never happened (by the machine's clock: see
    /// [`awaiting_for`]).
    async fn until(&self, matching: &Value, label: &str) {
        let met = {
            let mut state = self.0.state.lock().expect("timeline");
            if state.entries.iter().any(|entry| meets(entry, matching)) {
                return;
            }
            let (met, wait) = tokio::sync::oneshot::channel();
            state.waiters.push((matching.clone(), met));
            wait
        };
        awaiting_for(DEADLINE, || format!("{label} (waiting for {matching})"), met).await.expect("the timeline outlives its waits");
    }
}

/// How long a wait may last before it is the test's failure: measured on the machine's clock, so no runtime clock decides it. A wait
/// ends on its signal; this is only the failure path of a signal that never comes. (The same helper as
/// `mixdog-core-session`'s `session/testing.rs` `awaiting_for`, which this crate cannot reach.)
const DEADLINE: Duration = Duration::from_secs(30);

/// Awaits `wait`, failing with `what` if it has not ended by `limit`. The deadline is a blocking task, which a paused runtime clock
/// cannot skip past, and ends as soon as the wait is over.
async fn awaiting_for<T>(limit: Duration, what: impl FnOnce() -> String, wait: impl std::future::Future<Output = T>) -> T {
    let (over, ended) = std::sync::mpsc::channel::<()>();
    let (fire, mut fired) = tokio::sync::oneshot::channel();
    #[allow(clippy::disallowed_methods, reason = "test deadline on the machine's clock")]
    tokio::task::spawn_blocking(move || {
        if ended.recv_timeout(limit) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            let _ = fire.send(());
        }
    });
    let _over = over;
    tokio::select! {
        biased;
        value = wait => value,
        Ok(()) = &mut fired => panic!("timed out after {limit:?} waiting for {}", what()),
    }
}

/// One step a script controls (a hook, an executor, an approval card, the file work of an approval): it takes one turn of the
/// scheduler, as it takes one macrotask in the recording, so that the calls of a batch advance step by step; a scenario can hold
/// the n-th occurrence of a step (`gates`) until an entry of the timeline appears.
/// The scheduler's turn is the recording's macrotask. Node runs one macrotask callback at a time and drains every microtask it
/// started before the next callback; a task asks for its turn here and a driver, which runs only once every other task has run to its
/// next wait (tokio wakes a yielded task last, after the ready ones), hands the turns out one at a time in the order asked.
#[derive(Default)]
struct Turns {
    queue: Mutex<VecDeque<tokio::sync::oneshot::Sender<()>>>,
    asked: tokio::sync::Notify,
}

impl Turns {
    async fn turn(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.queue.lock().expect("turns").push_back(tx);
        self.asked.notify_one();
        let _ = rx.await;
    }

    async fn drive(self: Arc<Self>) {
        loop {
            self.asked.notified().await;
            loop {
                tokio::task::yield_now().await;
                let Some(turn) = self.queue.lock().expect("turns").pop_front() else { break };
                let _ = turn.send(());
            }
        }
    }
}

struct Stages {
    gates: Vec<Value>,
    seen: Mutex<Vec<u64>>,
    timeline: Timeline,
    turns: Arc<Turns>,
    driver: tokio::task::JoinHandle<()>,
    /// What a product tool the recorder ran for real (the `live` scenarios' `goal`) answered, in the order it ran: the tool's
    /// result as its PostToolUse hook was handed it (`hooks.after`), taken from the recording as the tool's answer.
    product_answers: Mutex<VecDeque<(String, String)>>,
}

impl Drop for Stages {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Stages {
    fn new(gates: &Value, timeline: &Timeline, product_answers: VecDeque<(String, String)>) -> Arc<Self> {
        let gates = gates.as_array().cloned().unwrap_or_default();
        let turns = Arc::new(Turns::default());
        Arc::new(Self {
            seen: Mutex::new(vec![0; gates.len()]),
            gates,
            timeline: timeline.clone(),
            driver: tokio::spawn(turns.clone().drive()),
            turns,
            product_answers: Mutex::new(product_answers),
        })
    }

    async fn step(&self, stage: &str, name: &str, args: &Value) {
        for (index, gate) in self.gates.iter().enumerate() {
            if gate["stage"] != stage || gate.get("name").is_some_and(|wanted| wanted != name) || gate.get("args").is_some_and(|wanted| wanted != args) {
                continue;
            }
            let seen = {
                let mut seen = self.seen.lock().expect("seen");
                seen[index] += 1;
                seen[index]
            };
            if seen != gate["nth"].as_u64().unwrap_or(1) {
                continue;
            }
            self.timeline.until(&gate["until"], &format!("{stage} of {name} (held)")).await;
            break;
        }
        self.turns.turn().await;
    }
}

/// Whether a step of the scenario is held until the client has learnt that the cancelled turn ended (the recording notes `turnEnded`
/// only then: elsewhere where it falls among the calls' own steps is only how many steps Node's unwinding takes).
fn holds_until_turn_end(scenario: &Value) -> bool {
    scenario["gates"].as_array().is_some_and(|gates| gates.iter().any(|gate| gate["until"]["ev"] == "turnEnded"))
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

// ---- the session's tools ---------------------------------------------------------------------------------------------------------

/// The product's own tools the recorder ran for real (`live` scenarios); the others are the recorder's probes.
const PRODUCT_TOOLS: &[&str] = &["goal"];

/// Answers with what it was called with, and keeps the call.
struct Probe {
    spec: ToolSpec,
    leaf: String,
    executed: Arc<Mutex<Vec<Value>>>,
    timeline: Timeline,
    stages: Arc<Stages>,
    /// The connector tool's own classification of what it does outside the machine (Tool::outbound_kind; the product's MCP tool takes it from
    /// mixdog-mcp outbound_kind, which reads the server and tool names as Node's outbound-policy.mjs:166 does: mail + send is an email).
    outbound: Option<ActionKind>,
}

impl Probe {
    fn new(name: &str, executed: &Arc<Mutex<Vec<Value>>>, timeline: &Timeline, stages: &Arc<Stages>) -> Arc<dyn Tool> {
        let read_only = matches!(name, "probe_read" | "read" | "find" | "glob" | "list" | "grep" | "code_graph");
        let annotations =
            ToolAnnotations { read_only_hint: Some(read_only), idempotent_hint: (name == "probe_read").then_some(true), ..ToolAnnotations::default() };
        // `mcp__<server>__<tool>` answers with the server's own name of the tool.
        let leaf = name.strip_prefix("mcp__").map_or(name, |rest| rest.split_once("__").map_or(rest, |(_, tool)| tool));
        let annotations = if name.starts_with("mcp__") { ToolAnnotations { read_only_hint: Some(false), ..ToolAnnotations::default() } } else { annotations };
        Arc::new(Self {
            spec: ToolSpec {
                name: name.into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: format!("{name} probe"),
                input_schema: json!({ "type": "object" }),
                annotations,
                // Node's mutation tools (_isMutationTool): a read streamed ahead of one is run again.
                parallel_safe: !matches!(name, "edit" | "apply_patch"),
                exclusive_with: Vec::new(),
            },
            leaf: leaf.to_owned(),
            executed: executed.clone(),
            timeline: timeline.clone(),
            stages: stages.clone(),
            outbound: (name == "mcp__mail__send").then_some(ActionKind::Email),
        })
    }
}

#[async_trait]
impl Tool for Probe {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    fn outbound_kind(&self, _: &JsonValue) -> Option<ActionKind> {
        self.outbound
    }
    async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
        self.executed.lock().expect("executed").push(json!({ "name": self.spec.name, "args": args }));
        self.timeline.note(json!({ "ev": "ran", "name": self.spec.name, "args": args }));
        self.stages.step("tool", &self.spec.name, &args).await;
        if PRODUCT_TOOLS.contains(&self.spec.name.as_str()) {
            let (name, answer) = self
                .stages
                .product_answers
                .lock()
                .expect("answers")
                .pop_front()
                .unwrap_or_else(|| panic!("{} ran more often than Node ran it", self.spec.name));
            assert_eq!(name, self.spec.name, "the product tools ran in Node's order");
            return Ok(ToolOutput { parts: vec![ToolPart::Text(answer)], ..ToolOutput::default() });
        }
        if args["fail"] == true {
            let text = format!("Error: {} failed", self.spec.name);
            return Err(ToolError::new(ToolErrorCode::Failed { reason: text.clone() }, text));
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("ran {} {}", self.leaf, args))], ..ToolOutput::default() })
    }
}

struct Registry(Vec<Arc<dyn Tool>>);

impl ToolResolver for Registry {
    fn resolve(&self, _: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        self.0.iter().find(|tool| tool.spec().name == name).cloned()
    }
}

/// The session catalog the recording's session held (`availableBridgeTools`, `resolveBridgeTarget`).
struct Catalog {
    eager: Vec<String>,
    deferred: Vec<String>,
    /// The MCP tools the live registry lists.
    live_mcp: Vec<String>,
    /// The definitions the recording's tools were registered with (`golden.tools`).
    defined: Vec<Value>,
    readonly: bool,
}

fn find<'a>(names: &'a [String], wanted: &str) -> Option<&'a String> {
    names.iter().find(|name| name.as_str() == wanted).or_else(|| names.iter().find(|name| name.to_lowercase() == wanted.to_lowercase()))
}

#[async_trait]
impl CatalogView for Catalog {
    async fn announce(&self, _: &ThreadId, _: &[String]) {}
    fn available(&self, _: &ThreadId) -> Vec<ToolDoc> {
        self.eager
            .iter()
            .chain(&self.deferred)
            .map(|name| match self.defined.iter().find(|def| def["name"] == name.as_str()) {
                Some(def) => ToolDoc {
                    name: name.clone(),
                    description: def["description"].as_str().unwrap_or_default().to_owned(),
                    input_schema: def["inputSchema"].clone(),
                    annotations: def["annotations"].clone(),
                },
                None => ToolDoc {
                    name: name.clone(),
                    description: format!("{name} probe"),
                    input_schema: json!({ "type": "object", "properties": {} }),
                    annotations: json!({}),
                },
            })
            .collect()
    }
    fn is_eager(&self, _: &ThreadId, name: &str) -> bool {
        self.eager.iter().any(|eager| eager == name)
    }
    fn block_reason(&self, _: &ThreadId, name: &str) -> Option<String> {
        let selectable = self.defined.iter().find(|def| def["name"] == name).is_some_and(|def| def["annotations"]["readOnlyHint"] == true);
        (self.readonly && self.deferred.iter().any(|tool| tool == name) && !selectable).then(|| "readonly mode".to_owned())
    }
    fn alias_members(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn mcp_server_members(&self, _: &ThreadId, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn instructions_for(&self, _: &ThreadId, _: &[String]) -> String {
        String::new()
    }
    fn resolve_call(&self, _: &ThreadId, name: &str) -> CallResolution {
        if let Some(eager) = find(&self.eager, name) {
            return CallResolution::Direct(eager.clone());
        }
        match find(&self.deferred, name) {
            None => CallResolution::NotFound,
            Some(tool) if tool.starts_with("mcp__") && !self.live_mcp.contains(tool) => CallResolution::Unavailable(tool.clone()),
            Some(tool) => CallResolution::Deferred(tool.clone()),
        }
    }
}

/// `call_tool` is projected by the loop; nothing may reach the tool's own dispatcher.
struct Never;

#[async_trait]
impl ToolDispatcher for Never {
    async fn dispatch(&self, _: &ToolContext, name: &str, _: Value) -> ToolOutcome {
        panic!("the loop dispatched {name} through call_tool's dispatcher")
    }
}

// ---- the policy: the scenario's hook, its approval answers, the session's surface ------------------------------------------------

struct Connectors;

#[async_trait]
impl ConnectorPermissions for Connectors {
    fn needs_approval(&self, _: &str, _: &str) -> bool {
        false
    }
    fn disabled(&self, _: &str, _: &str) -> bool {
        false
    }
    fn project_disabled(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
    async fn allow_always(&self, _: &str, _: &str) -> bool {
        false
    }
}

/// The recording's PreToolUse hook: asks for the scenario's tools, denies, rewrites, and notes every call.
struct ScriptHook {
    scenario: Value,
    seen: Mutex<Vec<Value>>,
    timeline: Timeline,
    stages: Arc<Stages>,
}

#[async_trait]
impl PreToolHook for ScriptHook {
    async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        self.seen.lock().expect("seen").push(json!({ "name": call.name, "args": call.args }));
        self.timeline.note(json!({ "ev": "pre", "name": call.name, "args": call.args }));
        self.stages.step("pre", call.name, call.args).await;
        let listed = |key: &str| strings(&self.scenario[key]).iter().any(|name| name == call.name);
        if let Some(rewrite) = self.scenario["hookRewrite"].get(call.name) {
            return Ok(Some(HookDecision {
                action: HookAction::Rewrite,
                reason: None,
                name: rewrite["name"].as_str().map(str::to_owned),
                args: Some(rewrite["args"].clone()),
            }));
        }
        if listed("hookDeny") {
            return Ok(Some(HookDecision { action: HookAction::Deny, reason: Some("hook says no".into()), name: None, args: None }));
        }
        if listed("ask") {
            return Ok(Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None }));
        }
        Ok(None)
    }
}

struct Session {
    surface: SessionSurface,
}

#[async_trait]
impl GateSession for Session {
    fn connector_agent_id(&self) -> String {
        "lead".into()
    }
    async fn facts(&self) -> SessionFacts {
        SessionFacts { agent_id: "lead".into(), connector_agent_id: "lead".into(), life: Some("life".into()), ..SessionFacts::default() }
    }
    fn surface(&self) -> SessionSurface {
        self.surface.clone()
    }
    fn settings(&self) -> PolicySettings {
        PolicySettings::default()
    }
    async fn account(&self, _: &GateCall) -> Result<Option<BoundAccount>, String> {
        Ok(None)
    }
}

/// PostToolUse: notes what each call ran as and answered.
struct PostHooks(Mutex<Vec<Value>>, Timeline, Arc<Stages>);

#[async_trait]
impl ToolHooks for PostHooks {
    async fn after_tool(&self, _: &str, call: &GateCall, result: &str) -> Option<String> {
        self.0.lock().expect("after").push(json!({ "name": call.name, "args": call.args, "result": result }));
        self.1.note(json!({ "ev": "post", "name": call.name, "args": call.args }));
        self.2.step("post", &call.name, &call.args).await;
        None
    }
}

/// The approval gate: answers the scenario's cards and notes each one as it is shown.
struct Cards {
    answers: MockApprovalGate,
    timeline: Timeline,
    stages: Arc<Stages>,
}

#[async_trait]
impl ApprovalGate for Cards {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        // Node reads the grants file before it shows a card (the recorder's `grants` step) and appends to the audit file once the
        // answer is in (its `audit` step).
        self.stages.step("grants", "", &json!({})).await;
        let (name, args) = (ask.tool.clone().unwrap_or_default(), ask.payload["args"].clone());
        self.timeline.note(json!({ "ev": "card", "name": ask.tool, "args": args }));
        self.answers.asks.lock().expect("asks").push(ask);
        // A person answers later: the loop runs meanwhile, as it does while Node awaits the card.
        self.stages.step("card", &name, &args).await;
        let answer = self.answers.script.lock().expect("script").pop_front().unwrap_or(ApprovalResolution::Interrupted { at: 0 });
        self.stages.step("audit", "", &json!({})).await;
        answer
    }
}

// ---- the run's host doubles ----------------------------------------------------------------------------------------------------------

struct Steps {
    stages: Arc<Stages>,
    events: VecDeque<StreamEvent>,
    /// A streaming provider lets the loop run between its events; the response ends once every call the loop dispatches has
    /// settled and told the host (the recording's `settles`).
    streamed: bool,
    settles: Vec<String>,
    /// The stream is cut after its calls (the recording's `cut`): a truncated stream while the next call's arguments were still
    /// arriving.
    cut: bool,
    timeline: Timeline,
    request: usize,
}

#[async_trait]
impl ModelStream for Steps {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if self.streamed {
            self.stages.turns.turn().await;
            let ending = matches!(self.events.front(), Some(StreamEvent::Completed { .. })) || (self.cut && self.events.is_empty());
            if ending {
                for id in &self.settles {
                    self.timeline.until(&json!({ "ev": "toolResult", "id": id, "early": true }), &format!("the settlement of {id}")).await;
                }
            }
        }
        if self.cut && self.events.is_empty() {
            self.cut = false;
            self.timeline.note(json!({ "ev": "cut", "n": self.request }));
            // What an adapter reports for a connection that ended without its terminal frame while a call's input was streaming.
            let mut error = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
            error.exposure.tool_input_cut = true;
            error.exposure.tool_dispatched = true;
            return Some(Err(error));
        }
        let event = self.events.pop_front()?;
        if matches!(event, StreamEvent::Completed { .. }) {
            self.timeline.note(json!({ "ev": "answered", "n": self.request }));
        }
        Some(Ok(event))
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

/// The scenario's replies, one per request.
struct Replies {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
    streamed: bool,
    timeline: Timeline,
    stages: Arc<Stages>,
}

#[async_trait]
impl ProviderAdapter for Replies {
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
        let number = {
            let mut requests = self.requests.lock().expect("requests");
            requests.push(request);
            requests.len()
        };
        self.timeline.note(json!({ "ev": "sent", "n": number }));
        let Reply { events, settles, cut } = self.script.lock().expect("script").pop_front().expect("the script ran out of replies");
        Ok(Box::new(Steps {
            stages: self.stages.clone(),
            events: events.into(),
            streamed: self.streamed,
            settles,
            cut,
            timeline: self.timeline.clone(),
            request: number,
        }))
    }
}

/// One scripted reply: its stream events, the calls whose settlement ends a streamed response, and whether the stream is cut.
struct Reply {
    events: Vec<StreamEvent>,
    settles: Vec<String>,
    cut: bool,
}

/// The scripted replies. A whole-response provider returns its calls with the response (`ReturnedCalls`: no call is
/// dispatched before the response ends); a streaming one hands each call over as it completes (`ToolCallDone`), and a cut
/// one ends after its calls without the terminal event.
fn replies(script: &Value, streamed: bool) -> Vec<Reply> {
    // The recorder's `send` answers every reply it completes with `usage: { inputTokens: 1, outputTokens: 1, promptTokens: 1 }` (an
    // input of the recording; the core's prompt figure is the input plus the cache); a cut stream answers nothing.
    let answered = || StreamEvent::Usage(mixdog_core_api::domain::provider::Usage { input_tokens: 1, output_tokens: 1, ..Default::default() });
    script
        .as_array()
        .expect("script")
        .iter()
        .map(|step| match step["calls"].as_array() {
            Some(calls) => {
                let calls: Vec<ToolCall> = calls
                    .iter()
                    .map(|call| ToolCall {
                        id: call["id"].as_str().expect("id").into(),
                        name: call["name"].as_str().expect("name").into(),
                        arguments: call["arguments"].clone(),
                        native_type: None,
                    })
                    .collect();
                let done = StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None };
                let cut = step["cut"] == true;
                assert!(!cut || streamed, "a cut reply streams");
                if streamed {
                    let ending = if cut { Vec::new() } else { vec![answered(), done] };
                    Reply { events: calls.into_iter().map(StreamEvent::ToolCallDone).chain(ending).collect(), settles: strings(&step["settles"]), cut }
                } else {
                    Reply { events: vec![StreamEvent::ReturnedCalls(calls), answered(), done], settles: Vec::new(), cut }
                }
            }
            None => Reply {
                events: vec![
                    StreamEvent::TextDelta(step["text"].as_str().expect("text").into()),
                    answered(),
                    StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
                ],
                settles: Vec::new(),
                cut: false,
            },
        })
        .collect()
}

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

struct NoWait;
#[async_trait]
impl RetryWait for NoWait {
    async fn wait(&self, _: Duration) {}
}

struct NoSteer;
#[async_trait]
impl SteerSource for NoSteer {
    async fn drain(&self, _: DrainRequest) -> Vec<SteerEntry> {
        Vec::new()
    }
}

/// The run's events, and the early results the host's interruption record holds: those told before the run's token was cancelled
/// (`run_host/factory.rs` `PortObserver`, as Node's tracker is finalized in the abort's own step). The fifth field is the host
/// callbacks' log in raise order (the recording's `callbacks`), shared with the transcript sink.
struct Events(Mutex<Vec<RunEvent>>, Timeline, CancellationToken, Mutex<Vec<AgentMessage>>, Callbacks, ThreadId);

/// The recording's `callbacks`, in the order raised: what the loop hands its host beyond the tool events.
type Callbacks = Arc<Mutex<Vec<Value>>>;

/// The transcript sink; an assistant message it commits is the recording's `onAssistantMessageCommitted`.
struct Sink(AtomicU64, Callbacks);

#[async_trait]
impl TranscriptSink for Sink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError> {
        if message.role() == Role::Assistant {
            self.1.lock().expect("callbacks").push(json!({ "ev": "onAssistantMessageCommitted", "args": [committed_view(message)] }));
        }
        Ok(Ticket(self.0.fetch_add(1, Ordering::Relaxed) + 1))
    }
    fn replace(&self, _: &[AgentMessage], _: &Rewrite) {}
    fn message_id(&self) -> String {
        format!("m{}", self.0.fetch_add(1, Ordering::Relaxed) + 1)
    }
    async fn durable(&self, _: Ticket) {}
}

// ---- one scenario ----------------------------------------------------------------------------------------------------------------------

fn text_of(content: &Content) -> Value {
    match content {
        Content::Text(text) => json!(text),
        Content::Parts(_) => json!("<parts>"),
    }
}

fn kind_of(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Normal => "normal",
        ToolKind::Error => "error",
        ToolKind::Skipped => "skipped",
        ToolKind::CacheHit => "cache-hit",
    }
}

fn calls_of(calls: &[ToolCall]) -> Vec<Value> {
    calls.iter().map(|call| json!({ "id": call.id, "name": call.name, "arguments": call.arguments })).collect()
}

/// A message as the model and the transcript show it: role, text, the wire calls and the call it answers.
fn view(role: &str, content: Value, calls: &[ToolCall], answers: Option<&str>) -> Value {
    let mut message = serde_json::Map::new();
    message.insert("role".into(), json!(role));
    message.insert("content".into(), content);
    if !calls.is_empty() {
        message.insert("toolCalls".into(), json!(calls_of(calls)));
    }
    if let Some(id) = answers {
        message.insert("toolCallId".into(), json!(id));
    }
    Value::Object(message)
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System | Role::Developer => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

/// A message the run is given, as the recording shows it.
fn input_message(message: &Value) -> AgentMessage {
    let text = message["content"].as_str().expect("input text").to_owned();
    match message["role"].as_str().expect("role") {
        "user" => AgentMessage::user(text),
        "system" => {
            let mut system = Message::new(Role::System, Content::Text(text.into()));
            system.cache_tier = match message["cacheTier"].as_str() {
                None => None,
                Some("tier3") => Some(CacheTier::Tier3),
                Some("env") => Some(CacheTier::Env),
                Some(other) => panic!("a cache tier the replay does not know: {other}"),
            };
            AgentMessage::new(system)
        }
        other => panic!("an input message of role {other}"),
    }
}

fn tier_name(tier: Option<CacheTier>) -> Option<&'static str> {
    tier.map(|tier| match tier {
        CacheTier::Tier3 => "tier3",
        CacheTier::Env => "env",
    })
}

/// A message of a model request: the wire message.
fn wire_view(message: &Message) -> Value {
    let mut shown = view(role_name(message.role), text_of(&message.content), &message.tool_calls, message.tool_call_id.as_deref());
    if let Some(tier) = tier_name(message.cache_tier) {
        shown["cacheTier"] = json!(tier);
    }
    if let Some(source) = message.source {
        let name = match source {
            mixdog_core_api::domain::provider::MessageSource::Steering => "steering",
            mixdog_core_api::domain::provider::MessageSource::StreamCutRecovery => "stream-cut-recovery",
            other => panic!("a wire message source the recording never shows: {other:?}"),
        };
        shown["meta"] = json!({ "source": name });
    }
    shown
}

/// A message of the transcript: the wire message and the loop's own fields (`toolKind`, `toolTiming`). The timing's clock values are
/// the recording's declared 0.
fn stored_view(message: &AgentMessage) -> Value {
    let mut shown = wire_view(&message.message);
    if let Some(source) = message.source {
        shown["meta"] = json!({ "source": source_name(source) });
    }
    if let Some(kind) = message.tool_kind {
        shown["toolKind"] = json!(kind_of(kind));
    }
    if message.tool_timing.is_some() {
        shown["toolTiming"] =
            json!({ "dispatchStartedAt": 0, "executionStartedAt": 0, "executionCompletedAt": 0, "postprocessStartedAt": 0, "resultCompletedAt": 0 });
    }
    shown
}

/// Node's names of a user message's `meta.source` (`message_row.rs` `SOURCES`).
fn source_name(source: Source) -> &'static str {
    match source {
        Source::Steering => "steering",
        Source::TaskNotification => "task-notification",
        Source::TurnLimit => "turn-limit",
        Source::MaxOutputRecovery => "max-output-recovery",
        Source::StreamCutRecovery => "stream-cut-recovery",
        Source::RefusalRecovery => "refusal-recovery",
        Source::ContentFilterRecovery => "content-filter-recovery",
        other => panic!("a message source the recording never shows: {other:?}"),
    }
}

/// An assistant message the loop commits, as `onAssistantMessageCommitted` is handed it (its `createdAt` is the host's: see
/// [`NOT_COMPARED`]).
fn committed_view(message: &AgentMessage) -> Value {
    view("assistant", text_of(&message.message.content), &message.message.tool_calls, None)
}

/// The loop's report to its host that has a recorded callback (`onUsageDelta`), in the recording's terms: every figure the event
/// carries that the callback has a name for (`outgoing` and `sent_at_ms` are the host's inputs for the context baseline and the send
/// clock, which the callback does not carry). `sessionId` is the run's thread, which the host's callback names.
fn callback_of(event: &RunEvent, thread: &str) -> Option<Value> {
    match event {
        RunEvent::Usage { iteration, usage, delta } => Some(json!({ "ev": "onUsageDelta", "args": [{
            "sessionId": thread,
            "iterationIndex": iteration,
            "requestedModel": delta.requested_model,
            "model": delta.model,
            "deltaInput": usage.input_tokens,
            "deltaOutput": usage.output_tokens,
            "deltaToolCalls": delta.delta_tool_calls,
            "reasoningTokens": delta.reasoning_tokens,
            "reasoningTokensComplete": delta.reasoning_tokens_complete,
            "deltaPrompt": delta.delta_prompt,
            "requestMs": delta.request_ms,
            "deltaCachedRead": usage.cache_read_tokens,
            "deltaCacheWrite": usage.cache_write_tokens,
            "sendTools": delta.send_tools.iter().map(|tool| json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema })).collect::<Vec<_>>(),
        }] })),
        RunEvent::ProviderSendStarted => Some(json!({ "ev": "onProviderSendStarted", "args": [] })),
        RunEvent::ToolPhase(ToolPhase::Started) => Some(json!({ "ev": "onToolPhaseStarted", "args": [] })),
        RunEvent::ToolPhase(ToolPhase::Completed { iteration, calls, elapsed_ms }) => {
            Some(json!({ "ev": "onToolPhaseCompleted", "args": [{ "iteration": iteration, "calls": calls, "elapsedMs": elapsed_ms }] }))
        }
        _ => None,
    }
}

/// Every event the loop raises is compared with the recording, or is one of these, which the recording has no counterpart of; any
/// other event fails the replay.
/// - `Stage(Streaming)`, `TextDelta`: the replay's adapter streams its final text (a core adapter always does) and the loop marks the
///   stream; Node's scripted `send` returned the text whole and raised no stage (Node's adapters raise `onStageChange`, `onTextDelta`
///   themselves). The text itself is compared as the answer and the stored transcript.
/// - `Stage(ApprovalWait)`: the approval card's wait; Node's card is `onToolApproval`, compared whole as `cards` and on the timeline.
/// - `Stage(Requesting)`: Node's admission scheduler and provider adapter raise it, and the recording's scripted `send` is neither.
/// - `ToolCallObserved`: see `callbacks[ev=onAssistantToolCallObserved]` in [`NOT_COMPARED`].
/// - `TurnEffort(None)`: the turn's effort the run publishes when it starts; Node's `runtime.turnEffort` is a getter a client reads,
///   not a callback, and these routes carry no effort snapshot (any other value fails the replay).
/// - `ExecutionCalls`: Node's `rememberSensitiveValues` is a store call, not a callback the recording saw; the calls are the batch's.
/// - `Boundary`: the attempt clock's boundaries (an attempt's start, its head, payload and first output), which feed the run's
///   watchdog; Node has no callback for them.
/// - `ItemStart`: a content block's start in the stream (`onStreamItemStart`), which the replay's adapter may raise; Node's scripted
///   `send` streamed no blocks.
fn uncompared(event: &RunEvent) -> bool {
    matches!(
        event,
        RunEvent::Stage(Stage::Streaming | Stage::ApprovalWait { .. } | Stage::Requesting)
            | RunEvent::TextDelta(_)
            | RunEvent::ItemStart(_)
            | RunEvent::Boundary { .. }
            | RunEvent::SubmissionStarted { .. }
            | RunEvent::ToolCallObserved(_)
            | RunEvent::ExecutionCalls(_)
            | RunEvent::TurnEffort(None)
    )
}

/// The early notification a settled call tells the host: its role, call id, text, error flag and the marks it carries (the first three
/// of the timing's five). Node's notice states a thrown call by `isError` alone; the core's message states it twice, by `is_error` and
/// by the kind `Error` (`batch.rs` `early_result`), and has no kind otherwise: the two must agree, and then the notice is Node's.
fn early_view(message: &AgentMessage) -> Value {
    let mut shown = view("tool", text_of(&message.message.content), &[], message.tool_call_id());
    shown["__earlyNotify"] = json!(true);
    shown["isError"] = json!(message.message.is_error);
    let kind = if message.message.is_error { Some(ToolKind::Error) } else { None };
    assert_eq!(message.tool_kind, kind, "an early notice's kind is its error flag's");
    if message.tool_timing.is_some() {
        shown["toolTiming"] = json!({ "dispatchStartedAt": 0, "executionStartedAt": 0, "executionCompletedAt": 0 });
    }
    shown
}

/// The approval card as the human is shown it (`onToolApproval`'s argument): the ask's payload whole, with the ask's own fields and
/// the thread (the card's `sessionId`).
fn card_view(ask: &ApprovalAsk, thread: &str) -> Value {
    let mut card = ask.payload.clone();
    let fields = card.as_object_mut().expect("an approval payload is an object");
    fields.insert("name".into(), json!(ask.tool));
    fields.insert("sessionId".into(), json!(thread));
    fields.insert("toolCallId".into(), json!(ask.call_id.as_ref().map(|id| id.as_str())));
    fields.insert("reason".into(), json!(ask.reason));
    card
}

/// `recordToolBatch`'s payload of a batch: what the loop reports.
fn batch_view(batch: &ToolBatch) -> Value {
    json!({
        "iteration": batch.iteration,
        "tool_call_count": batch.calls.len(),
        "calls": batch.calls.iter().map(|call| json!({
            "tool_call_id": call.tool_call_id,
            "tool_name": call.tool_name,
            "array_lengths": call.array_lengths.as_ref().map(|lengths| Value::Object(lengths.iter().map(|(field, length)| (field.clone(), json!(length))).collect())),
        })).collect::<Vec<_>>(),
    })
}

// ---- the comparison: by subtraction ----------------------------------------------------------------------------------------------------

enum Step<'a> {
    Key(&'a str),
    Every,
    Where(&'a str, &'a str),
}

fn steps(path: &str) -> Vec<Step<'_>> {
    let mut steps = Vec::new();
    for part in path.split('.') {
        let (key, mut rest) = part.split_once('[').map_or((part, ""), |(key, rest)| (key, rest));
        steps.push(Step::Key(key));
        while !rest.is_empty() {
            let (inner, after) = rest.split_once(']').expect("a closed selector");
            steps.push(match inner.split_once('=') {
                None => Step::Every,
                Some((field, value)) => Step::Where(field, value),
            });
            rest = after.strip_prefix('[').unwrap_or(after);
        }
    }
    steps
}

/// Removes what `steps` names from `value`; an object the removal leaves empty goes with it. Returns how much it removed.
fn subtract(value: &mut Value, steps: &[Step<'_>]) -> usize {
    let Some((step, rest)) = steps.split_first() else { return 0 };
    match step {
        Step::Key(key) => {
            let Some(fields) = value.as_object_mut() else { return 0 };
            if rest.is_empty() {
                return usize::from(fields.remove(*key).is_some());
            }
            let Some(child) = fields.get_mut(*key) else { return 0 };
            let removed = subtract(child, rest);
            if removed > 0 && child.as_object().is_some_and(serde_json::Map::is_empty) {
                fields.remove(*key);
            }
            removed
        }
        Step::Every => value.as_array_mut().map_or(0, |items| items.iter_mut().map(|item| subtract(item, rest)).sum()),
        Step::Where(field, wanted) => {
            let Some(items) = value.as_array_mut() else { return 0 };
            let matches = |item: &Value| item[*field].as_str() == Some(*wanted);
            if rest.is_empty() {
                let before = items.len();
                items.retain(|item| !matches(item));
                return before - items.len();
            }
            items.iter_mut().filter(|item| matches(item)).map(|item| subtract(item, rest)).sum()
        }
    }
}

#[test]
fn an_emptied_parent_goes() {
    let path = steps("rows[].meta.stamp.id");
    let mut stamped = json!({ "rows": [{ "meta": { "stamp": { "id": 1 } } }, { "meta": { "stamp": { "id": 2 }, "kept": true } }] });
    assert_eq!(subtract(&mut stamped, &path), 2);
    assert_eq!(stamped, json!({ "rows": [{}, { "meta": { "kept": true } }] }));
}

#[test]
fn an_empty_object_stays() {
    let path = steps("rows[].meta.stamp.id");
    let mut empty = json!({ "rows": [{ "meta": { "stamp": {} } }, { "meta": {} }] });
    assert_eq!(subtract(&mut empty, &path), 0);
    assert_eq!(empty, json!({ "rows": [{ "meta": { "stamp": {} } }, { "meta": {} }] }));
}

impl RunObserver for Events {
    fn event(&self, event: RunEvent) {
        if let Some(callback) = callback_of(&event, self.5.as_str()) {
            self.4.lock().expect("callbacks").push(callback);
        }
        match &event {
            RunEvent::ToolCalls { calls, .. } => self.1.note(json!({ "ev": "toolCall", "ids": calls.iter().map(|call| call.id.as_str()).collect::<Vec<_>>() })),
            RunEvent::EarlyResult(message) => {
                if !self.2.is_cancelled() {
                    self.3.lock().expect("observed").push(message.clone());
                }
                self.1.note(json!({ "ev": "toolResult", "id": message.tool_call_id(), "early": true }));
            }
            RunEvent::ToolResult { call_id, .. } => self.1.note(json!({ "ev": "toolResult", "id": call_id, "early": false })),
            _ => {}
        }
        self.0.lock().expect("events").push(event);
    }
    fn can_retract(&self) -> bool {
        false
    }
    fn retract_text(&self, _: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}
/// The replay of one scenario, as a boxed future. In a debug build the replay's future is about a quarter of a megabyte, and a test
/// that awaited it inline kept that much in its own poll frame for every call site; with the loop's own debug frames under it, that
/// passed the test thread's 2 MiB stack.
fn observed<'a>(scenario: &'a Value, defined: &'a [Value]) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + 'a>> {
    Box::pin(replay_scenario(scenario, defined))
}
async fn replay_scenario(scenario: &Value, defined: &[Value]) -> Value {
    let (run, harness) = build_harness(scenario, defined);
    let driven = drive(scenario, run, &harness).await;
    project(scenario, &harness, driven)
}

struct Harness {
    timeline: Timeline,
    observer: Arc<Events>,
    approvals: Arc<Cards>,
    grant_store: Arc<MemoryGrantStore>,
    hook: Arc<ScriptHook>,
    post: Arc<PostHooks>,
    executed: Arc<Mutex<Vec<Value>>>,
    provider: Arc<Replies>,
    signal: Cancel,
    thread: ThreadId,
}

struct Driven {
    answer: Value,
    turn_error: Value,
    transcript: Vec<Value>,
    requests: Vec<Value>,
}

fn build_harness(scenario: &Value, defined: &[Value]) -> (Run, Harness) {
    let non_bridge = scenario["nonBridge"].as_bool() == Some(true);
    let surface = &scenario["surface"];
    let eager = strings(&surface["tools"]);
    let session = &scenario["session"];
    let disallowed = strings(&session["disallowedTools"]);
    let allowed = session.get("schemaAllowedTools").map(strings);
    let permitted = |name: &String| {
        !disallowed.iter().any(|denied| denied.eq_ignore_ascii_case(name))
            && allowed.as_ref().is_none_or(|allowed| allowed.iter().any(|ok| ok.eq_ignore_ascii_case(name)))
    };
    let deferred: Vec<String> = strings(&surface["catalog"]).into_iter().filter(|name| !eager.contains(name) && permitted(name)).collect();
    let live_mcp = if scenario["mcp"].as_bool() == Some(true) { vec!["mcp__mail__send".to_owned()] } else { Vec::new() };
    let executed = Arc::new(Mutex::new(Vec::new()));
    let timeline = Timeline::default();
    let product_answers = scenario["hooks"]["after"]
        .as_array()
        .expect("hooks.after")
        .iter()
        .filter(|after| PRODUCT_TOOLS.contains(&after["name"].as_str().expect("name")))
        .map(|after| (after["name"].as_str().expect("name").to_owned(), after["result"].as_str().expect("result").to_owned()))
        .collect();
    let stages = Stages::new(&scenario["gates"], &timeline, product_answers);

    // The registry holds every tool; the surface offers the eager ones (and the bridge's two).
    let everything: Vec<String> =
        eager.iter().chain(&deferred).chain(&strings(&surface["catalog"])).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let mut registry: Vec<Arc<dyn Tool>> = everything
        .iter()
        .filter(|name| !matches!(name.as_str(), "load_tool" | "call_tool"))
        .map(|name| Probe::new(name, &executed, &timeline, &stages))
        .collect();
    // The recorder registers these as internal tools, which answer before a built-in one of the name.
    registry
        .extend(strings(&scenario["internal"]).iter().filter(|name| !everything.contains(name)).map(|name| Probe::new(name, &executed, &timeline, &stages)));
    if scenario["mcp"].as_bool() == Some(true) {
        registry.push(Probe::new("mcp__mail__send", &executed, &timeline, &stages));
    }
    let readonly = session["toolSpec"] == "readonly";
    // The session's persisted deferred surface (`deferredSurfaceMode`), set apart from its tool mode.
    let deferred_readonly = surface["deferredSurfaceMode"] == "readonly";
    let mcp_names = (scenario["mcp"].as_bool() == Some(true)).then(|| live_mcp.clone());
    let catalog =
        Arc::new(Catalog { eager: eager.clone(), deferred: deferred.clone(), live_mcp, defined: defined.to_vec(), readonly: readonly || deferred_readonly });
    let mut offered: Vec<Arc<dyn Tool>> = Vec::new();
    for name in &eager {
        match name.as_str() {
            "load_tool" => offered.push(Arc::new(LoadTool::new(catalog.clone()))),
            "call_tool" => offered.push(Arc::new(CallTool::new(catalog.clone(), Arc::new(Never)))),
            other => offered.push(Probe::new(other, &executed, &timeline, &stages)),
        }
    }
    let resolver: Arc<dyn ToolResolver> = Arc::new(Registry(registry));
    let set = ToolSet::with_builtins(offered, eager.clone());
    let set = if non_bridge { set } else { set.with_registry(resolver.clone(), None) };

    let sessions = SessionSurface {
        schema_allowed: allowed.clone(),
        disallowed: disallowed.clone(),
        feature_denied: strings(&session["featureDeniedTools"]),
        readonly,
        deferred_readonly,
        mode_resolved: !surface["toolSpec"].is_null(),
        mcp_names,
        active_tools: eager.clone(),
        catalog_tools: deferred.clone(),
        bridge: !non_bridge,
        ..SessionSurface::default()
    };
    // The run's token and the abort signal over it, as the host builds them (`run_host/factory.rs`: `config.signal`, the gate's
    // `cancel`).
    let token = CancellationToken::new();
    let signal = Cancel::from_token(&token);
    let callbacks_log: Callbacks = Arc::default();
    let observer = Arc::new(Events(
        Mutex::default(),
        timeline.clone(),
        token.clone(),
        Mutex::default(),
        callbacks_log.clone(),
        ThreadId::from(scenario["sessionId"].as_str().expect("sessionId")),
    ));
    let approvals = Arc::new(Cards { answers: MockApprovalGate::default(), timeline: timeline.clone(), stages: stages.clone() });
    for answer in scenario["answers"].as_array().expect("answers") {
        approvals.answers.script.lock().expect("script").push_back(ApprovalResolution::Decided {
            decision: ToolApprovalDecision {
                approved: answer["approved"].as_bool().expect("approved"),
                reason: answer["reason"].as_str().map(str::to_owned),
                answers: None,
                reply: None,
                response: None,
                edited_args: None,
                remember: None,
                scope: None,
            },
            device: "Pixel".into(),
            connection_kind: ConnectionKind::Phone,
            at: 0,
        });
    }
    let hook = Arc::new(ScriptHook { scenario: scenario.clone(), seen: Mutex::default(), timeline: timeline.clone(), stages: stages.clone() });
    struct SharedHook(Arc<ScriptHook>);
    #[async_trait]
    impl PreToolHook for SharedHook {
        async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
            self.0.pre_tool(call).await
        }
    }
    let grant_store = Arc::new(MemoryGrantStore::default());
    let policy = ToolPolicy::new(grant_store.clone(), Arc::new(Connectors)).with_hook(Arc::new(SharedHook(hook.clone())));
    // The thread is the recorded session: the texts that name it (a card, an abort) name the same one.
    let thread = ThreadId::from(scenario["sessionId"].as_str().expect("sessionId"));
    let gate = PolicyGate::new(PolicyGateParts {
        policy: Arc::new(policy),
        connectors: Arc::new(Connectors),
        session: Arc::new(Session { surface: sessions }),
        tools: resolver,
        grants: Arc::new(SessionGrants::default()),
        approvals: approvals.clone(),
        observer: observer.clone(),
        guards: Arc::new(NoGuards),
        thread_id: thread.clone(),
        cwd: std::env::temp_dir(),
        cancel: token.clone(),
    });
    let post = Arc::new(PostHooks(Mutex::default(), timeline.clone(), stages.clone()));
    let provider = Arc::new(Replies {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(replies(&scenario["script"], scenario["stream"].as_bool() == Some(true)).into()),
        requests: Mutex::new(Vec::new()),
        streamed: scenario["stream"].as_bool() == Some(true),
        timeline: timeline.clone(),
        stages: stages.clone(),
    });
    let tokens = mixdog_rt::testing::tokens();
    let env = RunEnv {
        clock: Arc::new(FixedClock(AtomicI64::new(1_000))),
        jitter: Arc::new(HalfJitter),
        waiter: Arc::new(NoWait),
        decider: Arc::new(MockRetryDecider),
        steer: Arc::new(NoSteer),
        observer: observer.clone(),
        sink: Arc::new(Sink(AtomicU64::new(0), callbacks_log.clone())),
        gate: Arc::new(gate),
        guards: Arc::new(NoGuards),
        compactor: None,
        route: None,
        skills: None,
        hooks: Some(post.clone()),
        reuse: None,
        reactions: None,
        tail: None,
        mcp: None,
        side: None,
        step_judge: None,
        artifacts: None,
        images: None,
        failures: None,
    };
    let tool_env = ToolEnv {
        thread_id: thread.clone(),
        turn_id: TurnId::from("r"),
        cwd: mixdog_core_api::domain::common::AbsPath::new(std::env::temp_dir()).expect("absolute"),
        surface: SurfaceKind::Lead,
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: approvals.clone(),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        progress: Arc::new(MockProgress::default()),
        deadline_of: None,
        notify: None,
        review: None,
    };
    let run = Run::new(
        env,
        token.clone(),
        provider.clone(),
        set,
        tool_env,
        {
            // The model the recorder's session was created with (`createSession({ model: 'fake-model' })`): an input.
            let mut config = RunConfig::new(thread.clone(), TurnId::from("r"), "fake-model");
            config.signal = Some(signal.clone());
            config
        },
        // The transcript the run is given is the recording's first request, whole: the host's system messages (the prompt is
        // assembled outside the loop, which must pass it on untouched) and the user's turn.
        scenario["requests"][0].as_array().expect("first request").iter().map(input_message).collect(),
        RunCarry::default(),
    );
    (run, Harness { timeline, observer, approvals, grant_store, hook, post, executed, provider, signal, thread })
}

async fn drive(scenario: &Value, run: Run, harness: &Harness) -> Driven {
    let Harness { timeline, observer, provider, signal, thread, .. } = harness;
    let abort_reason = scenario["abortReason"].as_str().map(str::to_owned);
    let canceller = scenario["abortWhen"].as_array().map(|wanted| {
        let (wanted, timeline, signal, thread, reason) =
            (wanted.clone(), timeline.clone(), signal.clone(), thread.clone(), abort_reason.clone().expect("abortReason"));
        tokio::spawn(async move {
            for entry in &wanted {
                timeline.until(entry, "the moment to cancel").await;
            }
            signal.abort_with(&Abort::abort_session_turn(thread.as_str(), &reason));
            timeline.note(json!({ "ev": "aborted" }));
        })
    });
    // Boxed: inline, the run's debug-build future would sit in this replay's state and poll frame twice over.
    let ran = awaiting_for(DEADLINE, || format!("the run of {}", scenario["name"]), Box::pin(run.run())).await;
    // What the host has seen of the run when it ends: the interruption of a cancelled turn is built from it.
    let seen_at_end = observer.0.lock().expect("events").clone();
    if holds_until_turn_end(scenario) {
        // The client learns the cancelled turn is over (the recording's `turnEnded`, noted where a step is held until it).
        timeline.note(json!({ "ev": "turnEnded" }));
    }

    let requests: Vec<Value> =
        provider.requests.lock().expect("requests").iter().map(|request| json!(request.messages.iter().map(wire_view).collect::<Vec<_>>())).collect();
    let (answer, turn_error, transcript) = match (ran, &canceller) {
        (Ok(output), None) => {
            // The answer is the transcript's last message, which the run returns apart from it, with the run's own counters.
            let mut transcript: Vec<Value> = output.transcript.iter().map(stored_view).collect();
            let mut answer = view("assistant", json!(output.response.content), &[], None);
            answer["iterations"] = json!(output.iterations);
            answer["toolCallsTotal"] = json!(output.tool_calls_total);
            transcript.push(answer);
            (json!(output.response.content), Value::Null, transcript)
        }
        (Err(failure), Some(_)) => {
            assert!(matches!(failure.error, AgentError::Aborted), "{}: the cancelled run failed otherwise: {}", scenario["name"], failure.error);
            // The calls the cancel did not stop settle after the run ended: each tells the host as it does.
            for id in scenario["settled"].as_array().expect("settled") {
                timeline.until(&json!({ "ev": "toolResult", "id": id, "early": true }), &format!("the settlement of {id} after the cancellation")).await;
            }
            let calls: Vec<ToolCall> = seen_at_end
                .iter()
                .filter_map(|event| match event {
                    RunEvent::ToolCalls { calls, .. } => Some(calls.clone()),
                    _ => None,
                })
                .flatten()
                .collect();
            let results: Vec<AgentMessage> = observer.3.lock().expect("observed").clone();
            let finalized = finalize_interrupted_turn(Interrupted {
                transcript: failure.transcript,
                current_user_text: "go".to_owned(),
                response_started: !calls.is_empty() || !results.is_empty(),
                partial_assistant: String::new(),
                partial_reasoning: String::new(),
                phase: if calls.is_empty() { Phase::Streaming } else { Phase::Tools },
                observed_tool_calls: calls,
                observed_tool_results: results,
                reason: AbortReason::from_name(abort_reason.as_deref().expect("abortReason")),
            });
            // A cancelled turn is Node's `SessionClosedError`, with the text of the abort that ended it.
            let turn_error = json!({ "name": "SessionClosedError", "message": signal.reason() });
            (Value::Null, turn_error, finalized.transcript.iter().map(stored_view).collect())
        }
        (Ok(_), Some(_)) => panic!("{}: the cancelled run ended without an error", scenario["name"]),
        (Err(failure), None) => panic!("{}: the run failed: {}", scenario["name"], failure.error),
    };
    if let Some(canceller) = canceller {
        canceller.await.expect("the canceller");
    }
    Driven { answer, turn_error, transcript, requests }
}

fn project(scenario: &Value, harness: &Harness, driven: Driven) -> Value {
    let Harness { timeline, observer, approvals, grant_store, hook, post, executed, thread, .. } = harness;
    let Driven { answer, turn_error, transcript, requests } = driven;
    let events = observer.0.lock().expect("events").clone();
    // Every event is compared or is one `uncompared` names: the tool events (`events`, in raise order), the batch and recovery
    // reports (`trace`), the reports with a recorded callback (`callbacks`).
    let mut tool_events: Vec<Value> = Vec::new();
    let mut trace: Vec<Value> = Vec::new();
    for event in &events {
        match event {
            RunEvent::ToolCalls { iteration, calls } => tool_events.push(json!({ "ev": "toolCall", "iteration": iteration, "calls": calls_of(calls) })),
            RunEvent::EarlyResult(message) => tool_events.push(json!({ "ev": "toolResult", "message": early_view(message) })),
            // The committed result is the call's stored row.
            RunEvent::ToolResult { call_id, kind } => {
                let row = transcript
                    .iter()
                    .find(|row| row["role"] == "tool" && row["toolCallId"] == call_id.as_str())
                    .cloned()
                    .unwrap_or_else(|| json!({ "missing row of": call_id }));
                assert_eq!(row["toolKind"], kind_of(*kind), "{}: the result event's kind is its row's", scenario["name"]);
                tool_events.push(json!({ "ev": "toolResult", "message": row }));
            }
            RunEvent::ToolBatch(batch) => trace.push(json!({ "kind": "batch", "payload": batch_view(batch) })),
            RunEvent::PartialToolRecovery(recovery) => trace.push(json!({
                "kind": "partial_tool_recovery",
                "iteration": recovery.iteration,
                "toolCalls": recovery.tool_calls,
                "droppedIncompleteInput": recovery.dropped_incomplete_input,
                "partialContentLen": recovery.partial_content_len,
            })),
            // Compared as `callbacks` (`callback_of`).
            RunEvent::Usage { .. } | RunEvent::ProviderSendStarted | RunEvent::ToolPhase(_) => {}
            other if uncompared(other) => {}
            other => panic!("{}: the loop raised an event the recording has no counterpart of: {other:?}", scenario["name"]),
        }
    }
    let cards: Vec<Value> = approvals.answers.asks.lock().expect("asks").iter().map(|ask| card_view(ask, thread.as_str())).collect();
    let audit: Vec<Value> = grant_store
        .audit()
        .iter()
        .map(|entry| json!({ "at": entry.at_ms, "agentId": entry.agent_id, "kind": entry.kind, "action": entry.action, "tool": entry.tool, "target": entry.target, "decision": entry.decision, "device": entry.device }))
        .collect();
    let callbacks = observer.4.lock().expect("callbacks").clone();
    let executed = executed.lock().expect("executed").clone();
    let before = hook.seen.lock().expect("seen").clone();
    let after = post.0.lock().expect("after").clone();
    // The recording's outputs, under its own keys and in its own shapes.
    let mut seen = json!({
        "answer": answer,
        "turnError": turn_error,
        "stored": transcript,
        "requests": requests,
        "events": tool_events,
        "callbacks": callbacks,
        "cards": cards,
        "hooks": { "before": before, "after": after },
        "executed": executed,
        "timeline": timeline.all(),
        "audit": audit,
        "trace": trace,
    });
    sandboxed(&mut seen);
    seen
}
/// The recording's sandbox, in the core's terms: the run's working directory is the machine's temp directory, which stands where the
/// recorder's work folder stood.
fn sandboxed(value: &mut Value) {
    let work = std::env::temp_dir().display().to_string();
    match value {
        Value::String(text) => *text = text.replace(&work, r"<SANDBOX>\work"),
        Value::Array(items) => items.iter_mut().for_each(sandboxed),
        Value::Object(fields) => fields.values_mut().for_each(sandboxed),
        _ => {}
    }
}

// ---- what a bridge session's `call_tool` does, with the scenario written out ------------------------------------------------------

/// A bridge session whose eager tools are `read`, `load_tool` and `call_tool` and whose deferred ones are `probe_read` and
/// `probe_write`; the model's replies are `script`.
fn bridge(session: Value, script: Value, ask: &[&str], deny: &[&str], answers: Value) -> Value {
    json!({
        "name": "a bridge session", "sessionId": "sess_bridge_1", "session": session, "mcp": false, "nonBridge": false, "live": false,
        "stream": false, "internal": [], "workdir": "", "ask": ask, "answers": answers, "hookRewrite": {}, "hookDeny": deny, "gates": [],
        "abortWhen": null, "abortReason": null, "settled": [], "script": script,
        "surface": {
            "exposure": "bridge-v1", "toolSpec": "full", "deferredSurfaceMode": "lead",
            "tools": ["read", "load_tool", "call_tool"],
            "catalog": ["read", "load_tool", "probe_read", "probe_write"],
            "mcpNames": null,
        },
        "hooks": { "after": [] },
        "requests": [[{ "role": "user", "content": "go" }]],
    })
}

fn through_call_tool(calls: &[(&str, &str)]) -> Value {
    let mut steps: Vec<Value> = calls
        .iter()
        .map(|(id, target)| json!({ "calls": [{ "id": id, "name": "call_tool", "arguments": { "name": target, "arguments": { "q": "x" } } }] }))
        .collect();
    steps.push(json!({ "text": "all done" }));
    json!(steps)
}

fn read_only_probe() -> Value {
    json!({ "name": "probe_read", "description": "reads", "inputSchema": { "type": "object" }, "annotations": { "readOnlyHint": true } })
}

fn ran(seen: &Value) -> Vec<String> {
    seen["executed"].as_array().expect("executed").iter().map(|call| call["name"].as_str().expect("name").to_owned()).collect()
}

fn answer_to(seen: &Value, id: &str) -> String {
    seen["stored"]
        .as_array()
        .expect("stored")
        .iter()
        .find(|row| row["role"] == "tool" && row["toolCallId"] == id)
        .and_then(|row| row["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

async fn assert_runs_probe_write_unasked(script: Value) {
    let seen = observed(&bridge(json!({}), script, &[], &[], json!([])), &[]).await;
    assert_eq!(seen["answer"], "all done");
    assert_eq!(seen["executed"], json!([{ "name": "probe_write", "args": { "n": 1, "q": "x" } }]));
    assert!(seen["cards"].as_array().expect("cards").is_empty());
}

#[tokio::test]
async fn a_deferred_tool_is_run_through_call_tool_after_load_tool() {
    assert_runs_probe_write_unasked(json!([
        { "calls": [{ "id": "c1", "name": "load_tool", "arguments": { "names": ["probe_write"] } }] },
        { "calls": [{ "id": "c2", "name": "call_tool", "arguments": { "name": "probe_write", "arguments": { "q": "x", "n": 1 } } }] },
        { "text": "all done" },
    ]))
    .await;
}

#[tokio::test]
async fn a_deferred_tool_is_run_through_call_tool_without_load_tool() {
    assert_runs_probe_write_unasked(json!([
        { "calls": [{ "id": "c1", "name": "call_tool", "arguments": { "name": "probe_write", "arguments": { "q": "x", "n": 1 } } }] },
        { "text": "all done" },
    ]))
    .await;
}

#[tokio::test]
async fn a_tool_the_session_denies_is_refused_through_call_tool_and_never_runs() {
    let session = json!({ "disallowedTools": ["probe_write"] });
    let seen = observed(&bridge(session, through_call_tool(&[("c1", "probe_write")]), &[], &[], json!([])), &[]).await;
    assert!(ran(&seen).is_empty());
    assert_eq!(seen["answer"], "all done");
    assert!(answer_to(&seen, "c1").contains("probe_write"), "{}", answer_to(&seen, "c1"));
}

async fn read_only_session_calls() -> Value {
    let script = through_call_tool(&[("c1", "probe_read"), ("c2", "probe_write")]);
    observed(&bridge(json!({ "toolSpec": "readonly" }), script, &[], &[], json!([])), &[read_only_probe()]).await
}

#[tokio::test]
async fn a_read_only_session_runs_a_read_only_deferred_tool() {
    assert_eq!(ran(&read_only_session_calls().await), ["probe_read"]);
}

#[tokio::test]
async fn a_read_only_session_refuses_a_deferred_tool_that_writes() {
    let seen = read_only_session_calls().await;
    assert!(answer_to(&seen, "c2").contains("readonly"), "{}", answer_to(&seen, "c2"));
}

async fn approval_asked_for_probe_write(answers: Value) -> Value {
    observed(&bridge(json!({}), through_call_tool(&[("c1", "probe_write")]), &["probe_write"], &[], answers), &[]).await
}

#[tokio::test]
async fn a_target_that_needs_approval_runs_when_approved() {
    let approved = approval_asked_for_probe_write(json!([{ "approved": true }])).await;
    assert_eq!(ran(&approved), ["probe_write"]);
    assert_eq!(approved["cards"].as_array().expect("cards").len(), 1, "one card, for the target");
}

#[tokio::test]
async fn a_target_that_needs_approval_is_answered_without_running_when_denied() {
    let denied = approval_asked_for_probe_write(json!([{ "approved": false, "reason": "Not now." }])).await;
    assert!(ran(&denied).is_empty());
    assert_eq!(denied["cards"].as_array().expect("cards").len(), 1);
    let said = answer_to(&denied, "c1");
    assert!(said.contains("was not approved") && said.contains("Not now."), "{said}");
}

#[tokio::test]
async fn call_tool_itself_is_never_asked_about() {
    let seen = observed(&bridge(json!({}), through_call_tool(&[("c1", "probe_write")]), &["call_tool"], &[], json!([])), &[]).await;
    assert_eq!(ran(&seen), ["probe_write"]);
    assert!(seen["cards"].as_array().expect("cards").is_empty(), "the bridge is not the thing that needs approval");
}

#[tokio::test]
async fn a_hook_denial_of_the_target_stops_it() {
    let seen = observed(&bridge(json!({}), through_call_tool(&[("c1", "probe_write")]), &[], &["probe_write"], json!([])), &[]).await;
    assert!(ran(&seen).is_empty());
    assert!(answer_to(&seen, "c1").contains("hook says no"), "{}", answer_to(&seen, "c1"));
}
