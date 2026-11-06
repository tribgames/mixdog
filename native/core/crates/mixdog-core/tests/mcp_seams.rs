//! The turn assembly's WP-MCP seams over their services: explicit skill selection
//! (`ExplicitSkillSelector`) replayed against the messages today's Node product added to the
//! transcript (`mixdog-mcp/tests/golden/skillprep.mjs`), and the post-tool dispatch's delegation
//! to the hook bus (the hook payloads and decisions themselves are replayed by
//! `mixdog-mcp/tests/posttool_suite.rs`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::SkillSelector;
use mixdog_agent::env::ToolGate;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::tools::ToolEnv;
use mixdog_core::run_host::hooks::PostToolDispatch;
use mixdog_core::run_host::hooks::PostToolEvent;
use mixdog_core::run_host::mcp_seams::BusPostToolDispatch;
use mixdog_core::run_host::mcp_seams::ExplicitSkillSelector;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
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
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::skill_select::SkillNames;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct Names {
    available: HashSet<String>,
    fail: bool,
}

#[async_trait]
impl SkillNames for Names {
    async fn names(&self, _: &Path) -> Result<HashSet<String>, String> {
        if self.fail { Err("the catalog is unreadable".to_owned()) } else { Ok(self.available.clone()) }
    }
}

/// A `Skill` tool that answers each skill with the golden's fixed result.
struct SkillTool {
    spec: ToolSpec,
    answers: Value,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl Tool for SkillTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
        let name = args["name"].as_str().unwrap().to_owned();
        self.calls.lock().unwrap().push(name.clone());
        let fallback = json!(format!("Loaded skill: {name}"));
        match self.answers.get(&name).unwrap_or(&fallback) {
            Value::String(text) if text.starts_with("Error: ") => Err(ToolError::new(ToolErrorCode::Internal { incident_id: String::new() }, text.clone())),
            Value::String(text) => Ok(ToolOutput { parts: vec![ToolPart::Text(text.clone())], ..ToolOutput::default() }),
            envelope => Ok(ToolOutput {
                parts: vec![ToolPart::Text(envelope["result"].as_str().unwrap().to_owned())],
                follow_up_messages: envelope["bodies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| FollowUpMessage { text: b.as_str().unwrap().to_owned(), meta: Some("skill".to_owned()) })
                    .collect(),
                ..ToolOutput::default()
            }),
        }
    }
}

struct Gate {
    deny: Option<String>,
}

#[async_trait]
impl ToolGate for Gate {
    async fn check_call(&self, _: &str, _: &GateCall) -> GateDecision {
        GateDecision::Allow
    }

    fn pre_dispatch_deny(&self, _: &GateCall) -> Option<String> {
        self.deny.clone()
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
    }
}

fn golden() -> Value {
    serde_json::from_str(include_str!("../../mixdog-mcp/tests/golden/skillprep.json")).unwrap()
}

fn selector(golden: &Value, deny: Option<&str>, fail: bool) -> (ExplicitSkillSelector, Arc<SkillTool>) {
    let available = golden["available"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_owned()).collect();
    let tool = Arc::new(SkillTool {
        spec: ToolSpec {
            name: "Skill".to_owned(),
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        answers: golden["answers"].clone(),
        calls: Mutex::new(Vec::new()),
    });
    let selector = ExplicitSkillSelector::new(
        Arc::new(Names { available, fail }),
        tool.clone(),
        Arc::new(Gate { deny: deny.map(str::to_owned) }),
        tool_env(),
        CancellationToken::new(),
    );
    (selector, tool)
}

fn content_of(prompt: &Value) -> Content {
    match prompt {
        Value::String(text) => Content::Text(text.clone()),
        Value::Array(parts) => Content::Parts(parts.iter().map(|p| ContentPart::Text(p["text"].as_str().unwrap().to_owned(), None)).collect()),
        other => panic!("{other}"),
    }
}

/// A transcript message as the golden writes it: its text and its `meta`.
fn shown(message: &AgentMessage) -> (String, Value) {
    let Content::Text(text) = &message.message.content else { panic!("text expected") };
    let meta = match message.source {
        Some(Source::SkillContext) => json!({"source": "skill-context"}),
        Some(Source::Skill) => json!("skill"),
        other => panic!("source {other:?}"),
    };
    (text.clone(), meta)
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_selection_adds_what_node_adds_to_the_transcript() {
    let golden = golden();
    for case in golden["cases"].as_array().unwrap() {
        let label = format!("{}", case["prompt"]);
        let (selector, tool) = selector(&golden, None, false);
        let mut transcript = Vec::new();
        selector.select(&content_of(&case["prompt"]), &mut transcript).await;
        let calls: Vec<&str> = case["calls"].as_array().unwrap().iter().map(|c| c["args"]["name"].as_str().unwrap()).collect();
        assert_eq!(*tool.calls.lock().unwrap(), calls, "{label}: skills loaded");
        let got: Vec<(String, Value)> = transcript.iter().map(shown).collect();
        let expected: Vec<(String, Value)> =
            case["messages"].as_array().unwrap().iter().map(|m| (m["content"].as_str().unwrap().to_owned(), m["meta"].clone())).collect();
        assert_eq!(got, expected, "{label}: transcript");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_that_cannot_call_skill_selects_nothing() {
    let golden = golden();
    let (selector, tool) = selector(&golden, Some("Skill is not available here"), false);
    let mut transcript = Vec::new();
    selector.select(&Content::Text("$alpha".to_owned()), &mut transcript).await;
    assert!(transcript.is_empty() && tool.calls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_catalog_selects_nothing() {
    let golden = golden();
    let (selector, tool) = selector(&golden, None, true);
    let mut transcript = Vec::new();
    selector.select(&Content::Text("$alpha".to_owned()), &mut transcript).await;
    assert!(transcript.is_empty() && tool.calls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_post_tool_dispatch_asks_the_bus_with_the_sessions_common_fields() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let bus = HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(MockProcessManager::default()), None, None, None);
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&asked);
    let dispatch = BusPostToolDispatch::new(
        bus,
        Arc::new(move |session: &str| {
            assert_eq!(session, "s1");
            counter.fetch_add(1, Ordering::SeqCst);
            HookCommon::default()
        }),
    );
    let event = PostToolEvent { name: "edit".to_owned(), args: json!({"file_path": "a"}), cwd: dir.path().to_string_lossy().into_owned(), session_id: "s1".to_owned(), result: "ok".to_owned() };
    // No hooks are configured: nothing replaces the result and nothing blocks.
    assert_eq!(dispatch.post_tool(&event).await, None);
    dispatch.post_failure(&event).await;
    let decision = dispatch.post_batch("s1", &event.cwd, 2).await.expect("a batch with calls is dispatched");
    assert!(!decision.blocked);
    assert!(dispatch.post_batch("s1", &event.cwd, 0).await.is_none());
    // Every dispatch reads the session's common fields first (an empty batch included).
    assert_eq!(asked.load(Ordering::SeqCst), 4);
}
