//! `tools::run_nested`: a call made from inside a running tool (what `call_tool` runs its target
//! through) meets the gate, the approval wait, the surface judgement, the tool and PostToolUse
//! as a direct call of the target does. The approval texts are the real Node loop's
//! (`fixtures/tool-pool/dispatch.json`, recorded by `record-tool-pool.mjs`).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateSession;
use mixdog_agent::env::NoGuards;
use mixdog_agent::env::NullObserver;
use mixdog_agent::env::PolicyGate;
use mixdog_agent::env::PolicyGateParts;
use mixdog_agent::env::ToolHooks;
use mixdog_agent::tools::Pipeline;
use mixdog_agent::tools::run_nested;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
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
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolApprovalDecision;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::MemoryGrantStore;
use mixdog_tools::policy::PolicySettings;
use mixdog_tools::policy::SessionFacts;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/tool-pool/dispatch.json")).expect("fixture")
}

const ASKED: &str = "mcp__mail__send";

struct Connectors;

#[async_trait]
impl ConnectorPermissions for Connectors {
    fn needs_approval(&self, _agent: &str, tool: &str) -> bool {
        tool == ASKED
    }
    fn disabled(&self, _agent: &str, _tool: &str) -> bool {
        false
    }
    fn project_disabled(&self, _thread: &ThreadId, _tool: &str) -> bool {
        false
    }
    async fn allow_always(&self, _bot: &str, _tool: &str) -> bool {
        false
    }
}

struct Session(SessionSurface);

#[async_trait]
impl GateSession for Session {
    fn connector_agent_id(&self) -> String {
        "mailer".into()
    }
    async fn facts(&self) -> SessionFacts {
        SessionFacts {
            agent_id: "mailer".into(),
            // A bot's own session: the only one a `needs_approval` connector tool asks in.
            acting_bot: Some("mailer".into()),
            contact_bot: None,
            connector_agent_id: "mailer".into(),
            run: None,
            life: Some("life".into()),
        }
    }
    fn surface(&self) -> SessionSurface {
        self.0.clone()
    }
    fn settings(&self) -> PolicySettings {
        PolicySettings::default()
    }
    async fn account(&self, _call: &GateCall) -> Result<Option<mixdog_agent::env::BoundAccount>, String> {
        Ok(None)
    }
}

/// Answers "ran", and keeps the arguments it was called with.
struct Runs {
    spec: ToolSpec,
    seen: Mutex<Vec<Value>>,
    fails: bool,
}

impl Runs {
    fn new(name: &str, fails: bool) -> Arc<Self> {
        Arc::new(Self {
            spec: ToolSpec {
                name: name.into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: String::new(),
                input_schema: json!({ "type": "object", "properties": { "count": { "type": "number" } } }),
                annotations: ToolAnnotations::default(),
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
            seen: Mutex::new(Vec::new()),
            fails,
        })
    }
}

#[async_trait]
impl Tool for Runs {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _ctx: &ToolContext, args: Value) -> ToolOutcome {
        self.seen.lock().expect("seen").push(args);
        if self.fails {
            return Err(ToolError::new(ToolErrorCode::Failed { reason: "boom".into() }, "boom"));
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text("ran".into())], ..ToolOutput::default() })
    }
}

struct Registry(Vec<Arc<Runs>>);

impl ToolResolver for Registry {
    fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        self.0.iter().find(|tool| tool.spec().name == name).map(|tool| tool.clone() as Arc<dyn Tool>)
    }
}

#[derive(Default)]
struct Hooks {
    text: Option<String>,
    failures: Mutex<Vec<(String, String)>>,
}

#[async_trait]
impl ToolHooks for Hooks {
    async fn after_tool(&self, _call: &GateCall, _result: &str) -> Option<String> {
        self.text.clone()
    }
    async fn after_failure(&self, call: &GateCall, result: &str) {
        self.failures.lock().expect("failures").push((call.name.clone(), result.to_owned()));
    }
}

struct Rig {
    pipeline: Pipeline,
    approvals: Arc<MockApprovalGate>,
    tools: Registry,
}

fn rig(surface: SessionSurface, hooks: Option<Arc<Hooks>>, tools: Vec<Arc<Runs>>) -> Rig {
    let connectors = Arc::new(Connectors);
    let policy = ToolPolicy::new(Arc::new(MemoryGrantStore::default()), connectors.clone());
    let approvals = Arc::new(MockApprovalGate::default());
    let observer = Arc::new(NullObserver);
    let guards = Arc::new(NoGuards);
    let registry = Registry(tools);
    let gate = PolicyGate::new(PolicyGateParts {
        policy: Arc::new(policy),
        connectors,
        session: Arc::new(Session(surface)),
        tools: Arc::new(Registry(registry.0.clone())),
        grants: Arc::new(SessionGrants::default()),
        approvals: approvals.clone(),
        observer: observer.clone(),
        guards: guards.clone(),
        thread_id: ThreadId::from("t1"),
        cwd: std::env::temp_dir(),
        cancel: CancellationToken::new(),
    });
    let hooks: Option<Arc<dyn ToolHooks>> = hooks.map(|h| h as Arc<dyn ToolHooks>);
    Rig { pipeline: Pipeline { gate: Arc::new(gate), hooks, observer, guards, mcp: None }, approvals, tools: registry }
}

fn ctx(approvals: Arc<MockApprovalGate>) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t1"),
        turn_id: TurnId::from("r"),
        tool: "call_tool".into(),
        cwd: AbsPath::new(std::env::temp_dir()).expect("absolute"),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals,
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

fn decided(approved: bool, reason: Option<&str>) -> ApprovalResolution {
    ApprovalResolution::Decided {
        decision: ToolApprovalDecision {
            approved,
            reason: reason.map(str::to_owned),
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
    }
}

fn text(outcome: &ToolOutcome) -> String {
    match outcome {
        Ok(output) => match &output.parts[..] {
            [ToolPart::Text(text)] => text.clone(),
            other => panic!("{other:?}"),
        },
        Err(error) => error.message_for_model.clone(),
    }
}

/// A tool set to ask before it runs meets the user's answer exactly as Node's loop words it.
#[tokio::test]
async fn an_ask_is_answered_with_the_words_of_the_node_loop() {
    let g = golden();
    assert_eq!(g["askTool"], ASKED);
    for case in g["asks"].as_array().expect("asks") {
        let tool = Runs::new(ASKED, false);
        let rig = rig(SessionSurface::default(), None, vec![tool.clone()]);
        let answer = &case["answer"];
        let resolution = if answer.is_null() {
            ApprovalResolution::Unavailable { at: 0 }
        } else {
            decided(answer["approved"].as_bool().expect("approved"), answer["reason"].as_str())
        };
        rig.approvals.script.lock().expect("script").push_back(resolution);
        let got = run_nested(&rig.pipeline, &rig.tools, None, &ctx(rig.approvals.clone()), ASKED, json!({ "to": "x" })).await;
        match case["denial"].as_str() {
            Some(denial) => {
                assert_eq!(text(&got), denial, "{}", case["name"]);
                assert!(got.is_err() && tool.seen.lock().expect("seen").is_empty(), "{}", case["name"]);
            }
            None => {
                assert_eq!(text(&got), "ran", "{}", case["name"]);
                assert_eq!(*tool.seen.lock().expect("seen"), [json!({ "to": "x" })], "{}", case["name"]);
            }
        }
    }
}

/// The surface the session holds judges the target like a direct call of it
/// (`preDispatchDenyForSession`), before the tool runs.
#[tokio::test]
async fn the_session_surface_refuses_the_target() {
    let tool = Runs::new("read", false);
    let surface = SessionSurface { disallowed: vec!["read".into()], ..SessionSurface::default() };
    let rig = rig(surface, None, vec![tool.clone()]);
    let got = run_nested(&rig.pipeline, &rig.tools, None, &ctx(rig.approvals.clone()), "read", json!({})).await;
    assert_eq!(text(&got), "Error: tool \"read\" is not available in this session.");
    assert!(tool.seen.lock().expect("seen").is_empty());
}

#[tokio::test]
async fn arguments_are_coerced_to_the_schema_and_post_tool_use_rewrites_the_text() {
    let tool = Runs::new("read", false);
    let hooks = Arc::new(Hooks { text: Some("hooked".into()), ..Hooks::default() });
    let rig = rig(SessionSurface::default(), Some(hooks), vec![tool.clone()]);
    let got = run_nested(&rig.pipeline, &rig.tools, None, &ctx(rig.approvals.clone()), "read", json!({ "count": "3" })).await;
    assert_eq!(text(&got), "hooked");
    assert_eq!(*tool.seen.lock().expect("seen"), [json!({ "count": 3 })]);
}

#[tokio::test]
async fn a_failing_target_fires_post_tool_use_failure_and_keeps_its_error() {
    let tool = Runs::new("read", true);
    let hooks = Arc::new(Hooks::default());
    let rig = rig(SessionSurface::default(), Some(hooks.clone()), vec![tool]);
    let got = run_nested(&rig.pipeline, &rig.tools, None, &ctx(rig.approvals.clone()), "read", json!({})).await;
    assert_eq!(text(&got), "boom");
    assert_eq!(*hooks.failures.lock().expect("failures"), [("read".to_owned(), "boom".to_owned())]);
}

#[tokio::test]
async fn a_target_the_registry_does_not_know_is_refused_in_the_loops_words() {
    let rig = rig(SessionSurface::default(), None, vec![Runs::new("read", false)]);
    let got = run_nested(&rig.pipeline, &rig.tools, None, &ctx(rig.approvals.clone()), "nope", json!({})).await;
    assert_eq!(text(&got), mixdog_agent::text::unknown_tool_message("nope", &[]));
}
