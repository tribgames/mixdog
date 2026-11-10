//! A model's `call_tool` on a bridge session, through the run loop, against the Node recording
//! `fixtures/call-tool` (`record-call-tool.mjs`, `b6f10295a`, exact manifest): a real `askSession`
//! turn over a bridge session with a scripted provider.
//!
//! Each scenario replays the same script (the model's replies, the hook and the approval answers)
//! over the real loop, the real policy gate and the real `load_tool` / `call_tool` tools; the
//! session's tools and catalog are the recording's own. What is compared with Node, whole, is what a
//! client or the model can observe: the messages the model is sent at each request, the stored
//! transcript, the tool events the loop raises, the approval cards, the PreToolUse / PostToolUse
//! hook calls and what the executors were called with.
//!
//! Not compared: the audit rows (`batches`, Node's `recordToolBatch`), which the Rust loop does not
//! write at all yet, and timings.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::Run;
use mixdog_agent::RunCarry;
use mixdog_agent::RunConfig;
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
use mixdog_agent::env::SteerEntry;
use mixdog_agent::env::SteerSource;
use mixdog_agent::env::TextRetraction;
use mixdog_agent::env::Ticket;
use mixdog_agent::env::ToolHooks;
use mixdog_agent::env::TranscriptSink;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::ToolKind;
use mixdog_agent::tools::ToolEnv;
use mixdog_agent::tools::ToolSet;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockCodec;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::mock::MockRetryDecider;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
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

const GOLDEN: &str = include_str!("../../../../fixtures/call-tool/golden.json");

/// Everything observable, in the order it happened (the recording's 	imeline).
#[derive(Clone, Default)]
struct Timeline(Arc<Mutex<Vec<Value>>>);

impl Timeline {
    fn note(&self, entry: Value) {
        self.0.lock().expect("timeline").push(entry);
    }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

// ---- the session's tools ---------------------------------------------------------------------------------------------------------

/// Answers with what it was called with, and keeps the call.
struct Probe {
    spec: ToolSpec,
    leaf: String,
    executed: Arc<Mutex<Vec<Value>>>,
    timeline: Timeline,
}

impl Probe {
    fn new(name: &str, executed: &Arc<Mutex<Vec<Value>>>, timeline: &Timeline) -> Arc<dyn Tool> {
        let read_only = matches!(name, "probe_read" | "read" | "find" | "glob" | "list" | "grep" | "code_graph");
        let annotations = ToolAnnotations {
            read_only_hint: Some(read_only),
            idempotent_hint: (name == "probe_read").then_some(true),
            ..ToolAnnotations::default()
        };
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
        })
    }
}

#[async_trait]
impl Tool for Probe {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
        self.executed.lock().expect("executed").push(json!({ "name": self.spec.name, "args": args }));
        self.timeline.note(json!({ "ev": "ran", "name": self.spec.name, "args": args }));
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
                Some(def) => ToolDoc { name: name.clone(), description: def["description"].as_str().unwrap_or_default().to_owned(), input_schema: def["inputSchema"].clone(), annotations: def["annotations"].clone() },
                None => ToolDoc { name: name.clone(), description: format!("{name} probe"), input_schema: json!({ "type": "object", "properties": {} }), annotations: json!({}) },
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
}

#[async_trait]
impl PreToolHook for ScriptHook {
    async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        self.seen.lock().expect("seen").push(json!({ "name": call.name, "args": call.args }));
        self.timeline.note(json!({ "ev": "pre", "name": call.name, "args": call.args }));
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
#[derive(Default)]
struct PostHooks(Mutex<Vec<Value>>, Timeline);

#[async_trait]
impl ToolHooks for PostHooks {
    async fn after_tool(&self, call: &GateCall, result: &str) -> Option<String> {
        self.0.lock().expect("after").push(json!({ "name": call.name, "args": call.args, "result": result }));
        self.1.note(json!({ "ev": "post", "name": call.name, "args": call.args }));
        None
    }
}

/// The approval gate: answers the scenario's cards and notes each one as it is shown.
struct Cards {
    answers: MockApprovalGate,
    timeline: Timeline,
}

#[async_trait]
impl ApprovalGate for Cards {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.timeline.note(json!({ "ev": "card", "name": ask.tool, "args": ask.payload["args"] }));
        // A person answers later: the loop runs meanwhile, as it does while Node awaits the card.
        let answer = self.answers.request(ask).await;
        // The recorder answers after a macrotask: every call that needs no answer runs first.
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        answer
    }
}

// ---- the run's host doubles ----------------------------------------------------------------------------------------------------------

struct Steps {
    events: VecDeque<StreamEvent>,
    /// A streaming provider lets the loop run between its events; the response ends a moment after the last call.
    streamed: bool,
    timeline: Timeline,
    request: usize,
}

#[async_trait]
impl ModelStream for Steps {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if self.streamed {
            if matches!(self.events.front(), Some(StreamEvent::Completed { .. })) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            } else {
                tokio::task::yield_now().await;
            }
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
}

/// The scenario's replies, one per request.
struct Replies {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<Vec<StreamEvent>>>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
    streamed: bool,
    timeline: Timeline,
}

#[async_trait]
impl ProviderAdapter for Replies {
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
        let reply = self.script.lock().expect("script").pop_front().expect("the script ran out of replies");
        Ok(Box::new(Steps { events: reply.into(), streamed: self.streamed, timeline: self.timeline.clone(), request: number }))
    }
}

/// The scripted replies. A whole-response provider returns its calls with the response (`ReturnedCalls`: no call is
/// dispatched before the response ends); a streaming one hands each call over as it completes (`ToolCallDone`).
fn replies(script: &Value, streamed: bool) -> Vec<Vec<StreamEvent>> {
    script
        .as_array()
        .expect("script")
        .iter()
        .map(|step| match step["calls"].as_array() {
            Some(calls) => {
                let calls: Vec<ToolCall> = calls
                    .iter()
                    .map(|call| ToolCall { id: call["id"].as_str().expect("id").into(), name: call["name"].as_str().expect("name").into(), arguments: call["arguments"].clone(), native_type: None })
                    .collect();
                let done = StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None };
                if streamed {
                    calls.into_iter().map(StreamEvent::ToolCallDone).chain([done]).collect()
                } else {
                    vec![StreamEvent::ReturnedCalls(calls), done]
                }
            }
            None => vec![StreamEvent::TextDelta(step["text"].as_str().expect("text").into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
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

#[derive(Default)]
struct Events(Mutex<Vec<RunEvent>>, Timeline);

impl RunObserver for Events {
    fn event(&self, event: RunEvent) {
        match &event {
            RunEvent::ToolCalls { calls, .. } => self.1.note(json!({ "ev": "toolCall", "ids": calls.iter().map(|call| call.id.as_str()).collect::<Vec<_>>() })),
            RunEvent::EarlyResult(message) => self.1.note(json!({ "ev": "toolResult", "id": message.tool_call_id(), "early": true })),
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

#[derive(Default)]
struct Sink(AtomicU64);

#[async_trait]
impl TranscriptSink for Sink {
    async fn commit(&self, _: &AgentMessage) -> Result<Ticket, CommitError> {
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

/// What the recording shows of the same things, in the same terms.
fn recorded_view(message: &Value, with_kind: bool) -> Value {
    let calls: Vec<ToolCall> = message["toolCalls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .map(|call| ToolCall { id: call["id"].as_str().expect("id").into(), name: call["name"].as_str().expect("name").into(), arguments: call["arguments"].clone(), native_type: None })
                .collect()
        })
        .unwrap_or_default();
    let mut shown = view(message["role"].as_str().expect("role"), message["content"].clone(), &calls, message["toolCallId"].as_str());
    if with_kind && let Some(kind) = message["toolKind"].as_str() {
        shown["toolKind"] = json!(kind);
    }
    shown
}

async fn observed(scenario: &Value, defined: &[Value]) -> Value {
    let non_bridge = scenario["nonBridge"].as_bool() == Some(true);
    let surface = &scenario["surface"];
    let eager = strings(&surface["tools"]);
    let session = &scenario["session"];
    let disallowed = strings(&session["disallowedTools"]);
    let allowed = session.get("schemaAllowedTools").map(strings);
    let permitted = |name: &String| {
        !disallowed.iter().any(|denied| denied.eq_ignore_ascii_case(name)) && allowed.as_ref().is_none_or(|allowed| allowed.iter().any(|ok| ok.eq_ignore_ascii_case(name)))
    };
    let deferred: Vec<String> = strings(&surface["catalog"]).into_iter().filter(|name| !eager.contains(name) && permitted(name)).collect();
    let live_mcp = if scenario["mcp"].as_bool() == Some(true) { vec!["mcp__mail__send".to_owned()] } else { Vec::new() };
    let executed = Arc::new(Mutex::new(Vec::new()));
    let timeline = Timeline::default();

    // The registry holds every tool; the surface offers the eager ones (and the bridge's two).
    let everything: Vec<String> = eager.iter().chain(&deferred).chain(&strings(&surface["catalog"])).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    let mut registry: Vec<Arc<dyn Tool>> = everything.iter().filter(|name| !matches!(name.as_str(), "load_tool" | "call_tool")).map(|name| Probe::new(name, &executed, &timeline)).collect();
    if scenario["mcp"].as_bool() == Some(true) {
        registry.push(Probe::new("mcp__mail__send", &executed, &timeline));
    }
    let readonly = session["toolSpec"] == "readonly";
    let mcp_names = (scenario["mcp"].as_bool() == Some(true)).then(|| live_mcp.clone());
    let catalog = Arc::new(Catalog { eager: eager.clone(), deferred: deferred.clone(), live_mcp, defined: defined.to_vec(), readonly });
    let mut offered: Vec<Arc<dyn Tool>> = Vec::new();
    for name in &eager {
        match name.as_str() {
            "load_tool" => offered.push(Arc::new(LoadTool::new(catalog.clone()))),
            "call_tool" => offered.push(Arc::new(CallTool::new(catalog.clone(), Arc::new(Never)))),
            other => offered.push(Probe::new(other, &executed, &timeline)),
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
        mode_resolved: !surface["toolSpec"].is_null(),
        mcp_names,
        active_tools: eager.clone(),
        catalog_tools: deferred.clone(),
        bridge: !non_bridge,
        ..SessionSurface::default()
    };
    let observer = Arc::new(Events(Mutex::default(), timeline.clone()));
    let approvals = Arc::new(Cards { answers: MockApprovalGate::default(), timeline: timeline.clone() });
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
    let hook = Arc::new(ScriptHook { scenario: scenario.clone(), seen: Mutex::default(), timeline: timeline.clone() });
    struct SharedHook(Arc<ScriptHook>);
    #[async_trait]
    impl PreToolHook for SharedHook {
        async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
            self.0.pre_tool(call).await
        }
    }
    let policy = ToolPolicy::new(Arc::new(MemoryGrantStore::default()), Arc::new(Connectors)).with_hook(Arc::new(SharedHook(hook.clone())));
    let thread = ThreadId::from("t");
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
        cancel: CancellationToken::new(),
    });
    let post = Arc::new(PostHooks(Mutex::default(), timeline.clone()));
    let provider = Arc::new(Replies {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(replies(&scenario["script"], scenario["stream"].as_bool() == Some(true)).into()),
        requests: Mutex::new(Vec::new()),
        streamed: scenario["stream"].as_bool() == Some(true),
        timeline: timeline.clone(),
    });
    let tokens = mixdog_rt::testing::tokens();
    let env = RunEnv {
        clock: Arc::new(FixedClock(AtomicI64::new(1_000))),
        jitter: Arc::new(HalfJitter),
        waiter: Arc::new(NoWait),
        decider: Arc::new(MockRetryDecider),
        steer: Arc::new(NoSteer),
        observer: observer.clone(),
        sink: Arc::new(Sink::default()),
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
        CancellationToken::new(),
        provider.clone(),
        set,
        tool_env,
        RunConfig::new(thread, TurnId::from("r"), "m"),
        vec![AgentMessage::user("go")],
        RunCarry::default(),
    );
    let output = match run.run().await {
        Ok(output) => output,
        Err(failure) => panic!("{}: the run failed: {}", scenario["name"], failure.error),
    };

    let requests: Vec<Value> = provider
        .requests
        .lock()
        .expect("requests")
        .iter()
        .map(|request| {
            let messages: Vec<Value> = request
                .messages
                .iter()
                .filter(|m| !matches!(m.role, Role::System | Role::Developer))
                .map(|m| view(role_name(m.role), text_of(&m.content), &m.tool_calls, m.tool_call_id.as_deref()))
                .collect();
            json!(messages)
        })
        .collect();
    // The answer is the transcript's last message, which the run returns apart from it.
    let mut transcript: Vec<Value> = output
        .transcript
        .iter()
        .filter(|m| m.role() != Role::System)
        .map(|m| {
            let mut shown = view(role_name(m.role()), text_of(&m.message.content), &m.tool_calls().to_vec(), m.tool_call_id());
            if let Some(kind) = m.tool_kind {
                shown["toolKind"] = json!(kind_of(kind));
            }
            shown
        })
        .collect();
    transcript.push(view("assistant", json!(output.response.content), &[], None));
    let events = observer.0.lock().expect("events").clone();
    let tool_calls: Vec<Value> = events
        .iter()
        .filter_map(|event| match event {
            RunEvent::ToolCalls { iteration, calls } => Some(json!({ "iteration": iteration, "calls": calls_of(calls) })),
            _ => None,
        })
        .collect();
    let mut early: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            RunEvent::EarlyResult(message) => message.tool_call_id().map(str::to_owned),
            _ => None,
        })
        .collect();
    early.sort();
    let results: Vec<Value> = events
        .iter()
        .filter_map(|event| match event {
            RunEvent::ToolResult { call_id, kind } => Some(json!([call_id, kind_of(*kind)])),
            _ => None,
        })
        .collect();
    let cards: Vec<Value> = approvals
        .answers
        .asks
        .lock()
        .expect("asks")
        .iter()
        .map(|ask| json!({ "name": ask.tool, "args": ask.payload["args"], "reason": ask.reason, "toolCallId": ask.call_id.as_ref().map(|id| id.as_str()) }))
        .collect();
    let executed = executed.lock().expect("executed").clone();
    let before = hook.seen.lock().expect("seen").clone();
    let after = post.0.lock().expect("after").clone();
    json!({
        "answer": output.response.content,
        "requests": requests,
        "transcript": transcript,
        "toolCalls": tool_calls,
        "early": early,
        "results": results,
        "cards": cards,
        "hooks": { "before": before, "after": after },
        "executed": executed,
        "timeline": timeline.0.lock().expect("timeline").clone(),
    })
}

/// The recording's side of the same view.
fn recorded(scenario: &Value) -> Value {
    let workdir = scenario["workdir"].as_str().expect("workdir");
    let _ = workdir;
    let requests: Vec<Value> = scenario["requests"]
        .as_array()
        .expect("requests")
        .iter()
        .map(|messages| json!(messages.as_array().expect("messages").iter().map(|m| recorded_view(m, false)).collect::<Vec<_>>()))
        .collect();
    let transcript: Vec<Value> = scenario["stored"].as_array().expect("stored").iter().map(|m| recorded_view(m, true)).collect();
    let events = scenario["events"].as_array().expect("events");
    let tool_calls: Vec<Value> = events.iter().filter(|e| e["ev"] == "toolCall").map(|e| json!({ "iteration": e["iteration"], "calls": e["calls"] })).collect();
    let mut early: Vec<String> = events.iter().filter(|e| e["ev"] == "toolResult" && e["message"]["__earlyNotify"] == true).map(|e| e["message"]["toolCallId"].as_str().expect("id").to_owned()).collect();
    early.sort();
    let results: Vec<Value> = events
        .iter()
        .filter(|e| e["ev"] == "toolResult" && e["message"]["__earlyNotify"] != true)
        .map(|e| json!([e["message"]["toolCallId"], e["message"]["toolKind"]]))
        .collect();
    let cards: Vec<Value> = scenario["cards"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|card| json!({ "name": card["name"], "args": card["args"], "reason": card["reason"], "toolCallId": card["toolCallId"] }))
        .collect();
    json!({
        "answer": scenario["answer"],
        "requests": requests,
        "transcript": transcript,
        "toolCalls": tool_calls,
        "early": early,
        "results": results,
        "cards": cards,
        "hooks": scenario["hooks"],
        "executed": scenario["executed"],
        "timeline": scenario["timeline"],
    })
}

/// What the order of a timeline fixes. The requests, the responses and the tool-call events are boundaries, and every
/// entry stays between the same two of them (an early start, before the response ends, is a different segment from a
/// start after it). Between two boundaries the calls of a batch run concurrently, and how their steps interleave
/// depends on each runtime's scheduler, not on the product: there each call's own entries (its hooks, card, run and
/// results) are compared in order, and the calls apart.
fn settled(timeline: &Value) -> Value {
    fn flush(segment: &mut std::collections::BTreeMap<String, Vec<Value>>, out: &mut Vec<Value>) {
        // Two calls of one tool with the same arguments are told apart by nothing but their steps: in the order of a call's life.
        for steps in segment.values_mut() {
            steps.sort_by_key(|step| ["pre", "card", "ran", "post"].iter().position(|ev| step["ev"] == *ev));
        }
        if !segment.is_empty() {
            out.push(json!(std::mem::take(segment)));
        }
    }
    let mut out = Vec::new();
    let mut segment = std::collections::BTreeMap::<String, Vec<Value>>::new();
    for entry in timeline.as_array().expect("timeline") {
        match entry["ev"].as_str().expect("ev") {
            "sent" | "answered" | "toolCall" => {
                flush(&mut segment, &mut out);
                out.push(entry.clone());
            }
            "toolResult" => segment.entry(format!("result {}", entry["id"])).or_default().push(entry.clone()),
            _ => segment.entry(format!("call {} {}", entry["name"], entry["args"])).or_default().push(entry.clone()),
        }
    }
    flush(&mut segment, &mut out);
    json!(out)
}

/// Replays the recorded scenarios `take` selects and returns the differences from Node's recording.
async fn differences(take: impl Fn(&Value) -> bool, skip: &[&str]) -> (usize, Vec<String>) {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert_eq!(scenarios.len(), 39, "the recorded scenario list");
    let mut failures = Vec::new();
    let mut compared = 0;
    for scenario in scenarios.iter().filter(|scenario| take(scenario)) {
        compared += 1;
        let (mut got, mut want) = (observed(scenario, golden["tools"].as_array().expect("tools")).await, recorded(scenario));
        for view in [&mut got, &mut want] {
            view["timeline"] = settled(&view["timeline"]);
        }
        for key in want.as_object().expect("view").keys().filter(|key| !skip.contains(&key.as_str())) {
            if got[key] != want[key] {
                failures.push(format!("{} / {key}\n  node: {}\n  core: {}", scenario["name"], want[key], got[key]));
            }
        }
    }
    (compared, failures)
}

/// A streamed scenario in which Node starts a call that is not read-only while the response streams (its hook runs, its
/// card is shown, it runs): `createEagerDispatcher` dispatches every executable call as the provider hands it over.
fn starts_a_write_early(scenario: &Value) -> bool {
    scenario["stream"] == true && scenario["timeline"].as_array().expect("timeline").iter().any(|entry| matches!(entry["ev"].as_str(), Some("card" | "pre" | "ran")) && (entry["ev"] == "card" || entry["name"] != "probe_read"))
}

#[tokio::test(start_paused = true)]
async fn every_recorded_call_tool_scenario_is_the_same_in_the_core() {
    let (compared, failures) = differences(|scenario| !starts_a_write_early(scenario), &[]).await;
    assert!(compared > 0);
    assert!(failures.is_empty(), "{} difference(s):\n{}", failures.len(), failures.join("\n"));
}

/// The scenarios in which Node starts a write while the response streams come out the same in everything the model and
/// the transcript hold (the requests, the transcript, the results, the cards, the executors, the hook calls); only the
/// moment of the start differs, see the next test.
#[tokio::test(start_paused = true)]
async fn the_scenarios_whose_writes_start_early_in_node_end_the_same_in_the_core() {
    let (compared, failures) = differences(starts_a_write_early, &["timeline"]).await;
    assert!(compared > 0);
    assert!(failures.is_empty(), "{} difference(s):\n{}", failures.len(), failures.join("\n"));
}

/// Node dispatches every executable call while the provider streams it, a write, an MCP call or a call that
/// needs approval included (`createEagerDispatcher`, `eager-dispatch.mjs`): its card is shown before the response ends.
#[tokio::test(start_paused = true)]
async fn calls_that_are_not_read_only_start_while_the_response_streams_as_in_node() {
    let (compared, failures) = differences(starts_a_write_early, &[]).await;
    assert!(compared > 0);
    assert!(failures.is_empty(), "{} difference(s):\n{}", failures.len(), failures.join("\n"));
}