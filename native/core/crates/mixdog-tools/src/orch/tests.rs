//! Golden twins that run a whole tool call: `golden/session_actions.json` is the `session` tool of
//! today's Node product (`createWorkspaceToolHandlers`) driven with stub services; the Rust tool
//! must read the same text (success) or fail with the same text (error) byte for byte.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::ports::CallerFacts;
use super::session::*;
use super::util::PortError;

struct Facts;

#[async_trait]
impl CallerFacts for Facts {
    async fn is_heartbeat(&self, _: &ThreadId) -> bool {
        false
    }
    async fn is_unattended(&self, _: &ThreadId) -> bool {
        false
    }
    async fn user_available(&self, _: &ThreadId) -> bool {
        true
    }
}

struct Stub;

#[async_trait]
impl SessionPort for Stub {
    async fn caller(&self, _: &ThreadId) -> SessionCaller {
        SessionCaller { ai_titles_enabled: true, ..SessionCaller::default() }
    }
    fn is_task_origin(&self, _: &str, _: &TaskOrigin) -> bool {
        false
    }
    async fn resolve_target(&self, target: &str) -> Result<String, PortError> {
        Ok(if target == "ann" { "sess_home_ann".to_owned() } else { target.to_owned() })
    }
    async fn unknown_bot(&self, _: &str) -> Result<Option<String>, PortError> {
        Ok(None)
    }
    async fn resolve_attachments(&self, _: &ThreadId, _: &Value, _: &AbsPath, _: &str) -> Result<Vec<Value>, PortError> {
        Ok(Vec::new())
    }
    async fn control(&self, call: ControlCall) -> Result<Value, PortError> {
        Ok(json!({"ok": true, "action": call.action, "sessionId": call.args.get("session_id").cloned().unwrap_or(Value::Null), "items": []}))
    }
    async fn status(&self, _: &ThreadId, cwd: &AbsPath) -> SessionStatus {
        let cwd = cwd.as_path().to_string_lossy().into_owned();
        SessionStatus {
            session_id: Some("sess_lead1".into()),
            title: Some("My title".into()),
            title_source: Some("user".into()),
            project: cwd.clone(),
            cwd,
            provider: Some("anthropic".into()),
            model: Some("claude-x".into()),
            effort: Some("high".into()),
            auto_effort: true,
            fast: false,
        }
    }
    async fn list_projects(&self) -> Vec<ProjectRow> {
        Vec::new()
    }
    async fn set_project(&self, _: &ThreadId, _: &AbsPath, _: &str) -> Result<String, PortError> {
        Err(PortError::Failed { capability: "session".into(), message: "unused".into() })
    }
    async fn rename(&self, _: &ThreadId, _: &str) -> Result<String, RenameError> {
        Err(RenameError::UserTitle)
    }
    async fn schedule_compact(&self, _: &ThreadId) -> Result<(), PortError> {
        Ok(())
    }
    async fn fork(&self, _: &ThreadId, compact: bool) -> Result<(String, bool), PortError> {
        Ok(("sess_fork1".into(), compact))
    }
    async fn sidebar(&self, _: &ThreadId, _: SidebarFlag, _: bool) -> Result<(), PortError> {
        Ok(())
    }
    async fn suggest(&self, _: &str, _: &str, _: bool) -> Result<Value, PortError> {
        Ok(json!({}))
    }
}

fn root() -> AbsPath {
    AbsPath::new(std::env::temp_dir()).expect("absolute temp dir")
}

pub(crate) fn ctx() -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("sess_lead1"),
        turn_id: TurnId::from("r"),
        tool: "session".into(),
        cwd: root(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

#[tokio::test]
async fn session_actions_read_as_the_node_tool_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/session_actions.json")).expect("golden");
    let tool = SessionTool::new(Arc::new(Stub), Arc::new(Facts));
    let cwd = root().as_path().to_string_lossy().into_owned();
    let cases = [
        ("status", json!({"action":"status"})),
        ("status_default", json!({})),
        ("compact", json!({"action":"compact"})),
        ("fork", json!({"action":"fork"})),
        ("fork_compact", json!({"action":"fork","compact":true})),
        ("rename_user_title", json!({"action":"rename","title":"New"})),
        ("rename_missing", json!({"action":"rename"})),
        ("list", json!({"action":"list","limit":5})),
        ("read", json!({"action":"read","session_id":"sess_other"})),
        ("create_not_bot", json!({"action":"create","brief":"x"})),
        ("favorite_missing_value", json!({"action":"favorite"})),
        ("other_target", json!({"action":"compact","session_id":"sess_other"})),
        ("unknown", json!({"action":"zap"})),
        ("set_project_missing_path", json!({"action":"set-project"})),
    ];
    for (name, args) in cases {
        let want = &golden["outputs"][name];
        let want_text = want["text"].as_str().expect(name).replace("C:/proj", &cwd.replace('\\', "\\\\"));
        let (ok, got) = match tool.call(&ctx(), args).await {
            Ok(out) => (true, match &out.parts[0] { ToolPart::Text(t) => t.clone(), other => panic!("{other:?}") }),
            Err(e) => (false, e.message_for_model),
        };
        assert_eq!(ok, want["ok"].as_bool().unwrap(), "{name}");
        assert_eq!(got, want_text, "{name}");
    }
}

/// `BOT_TARGET_ACTIONS` of Node's `bot-target.mjs` is read, send and status: a bot id names its home chat for those three
/// only; `list`, `bots`, `cancel` and `delete` take the id as given (`list` and `bots` do not look at it, `cancel` and
/// `delete` look for a session of that id).
#[tokio::test]
async fn a_bot_id_names_its_home_chat_for_read_send_and_status_only() {
    let tool = SessionTool::new(Arc::new(Stub), Arc::new(Facts));
    for (action, resolved) in [("read", true), ("send", true), ("status", true), ("list", false), ("bots", false), ("cancel", false), ("delete", false)] {
        let out = tool.call(&ctx(), json!({"action": action, "session_id": "ann"})).await.expect(action);
        let ToolPart::Text(text) = &out.parts[0] else { panic!("text") };
        let answered: Value = serde_json::from_str(text).expect("json");
        assert_eq!(answered["sessionId"], if resolved { "sess_home_ann" } else { "ann" }, "{action}");
    }
}

/// Live-turn twin: `golden/agent_turn.json` holds the tool results the Node loop put in the
/// transcript when a scripted provider drove five `agent` calls (spawn, status, read, list,
/// close); the Rust tool must hand the loop the same text for the same facts.
#[tokio::test]
async fn agent_tool_results_equal_the_recorded_node_turn() {
    use super::agent::*;

    struct Scripted;

    #[async_trait]
    impl AgentPort for Scripted {
        async fn execute(&self, request: AgentRequest<'_>) -> Result<AgentReply, PortError> {
            let task = |status: &str| TaskView {
                task_id: "job_1".into(),
                status: Some(status.into()),
                kind: Some("spawn".into()),
                tag: Some("worker-a".into()),
                session_id: Some("sess_a".into()),
                ..TaskView::default()
            };
            Ok(match request.args["type"].as_str().unwrap_or("spawn") {
                "spawn" => AgentReply::Task { view: TaskView { agent: Some("coder".into()), ..task("running") }, diagnostics: false },
                "status" => AgentReply::Task {
                    view: TaskView {
                        agent: Some("coder".into()),
                        provider: Some("p".into()),
                        model: Some("m".into()),
                        stage: Some("streaming".into()),
                        worker_status: Some("running".into()),
                        ..task("running")
                    },
                    diagnostics: true,
                },
                "read" => AgentReply::Task {
                    view: TaskView { result: Some(TaskResult::Content("<final-answer>\nThe answer is 42.\n</final-answer>".into())), ..task("completed") },
                    diagnostics: false,
                },
                "list" => AgentReply::Roster {
                    workers: vec![WorkerRow { tag: "worker-a".into(), status: Some("idle".into()), stamp: "2".into(), ..WorkerRow::default() }],
                    jobs: vec![JobRow { task_id: "job_1".into(), kind: "spawn".into(), status: "completed".into(), tag: Some("worker-a".into()), finished: true, ..JobRow::default() }],
                },
                _ => AgentReply::Closed(ClosedView { closed: true, tag: Some("worker-a".into()), session_id: Some("sess_a".into()), ..ClosedView::default() }),
            })
        }
    }

    let golden: Value = serde_json::from_str(include_str!("golden/agent_turn.json")).expect("golden");
    let tool = AgentTool::new(Arc::new(Scripted), Arc::new(Stub), Arc::new(Facts));
    let calls = [
        json!({"type":"spawn","agent":"coder","prompt":"do it"}),
        json!({"type":"status","tag":"worker-a"}),
        json!({"type":"read","tag":"worker-a"}),
        json!({"type":"list"}),
        json!({"type":"close","tag":"worker-a"}),
    ];
    for (i, args) in calls.into_iter().enumerate() {
        let out = tool.call(&ctx(), args).await.expect("agent call");
        let ToolPart::Text(got) = &out.parts[0] else { panic!("text") };
        assert_eq!(got, golden["toolMessages"][i]["content"].as_str().unwrap(), "call {}", i + 1);
    }
}

/// `golden/tidy_def.json` is Node's `tidy` entry in `tool-defs.mjs`; the model must see the same
/// name, description and input schema.
#[test]
fn tidy_definition_equals_the_recorded_node_one() {
    struct Never;
    #[async_trait]
    impl super::service::ToolService for Never {
        async fn call(&self, _: super::service::ServiceCall<'_>) -> Result<Vec<ToolPart>, super::util::PortError> {
            unreachable!()
        }
    }
    let golden: Value = serde_json::from_str(include_str!("golden/tidy_def.json")).expect("golden");
    let tool = super::service::ServiceTool::tidy(Arc::new(Never));
    let spec = tool.spec();
    assert_eq!(spec.name, golden["name"].as_str().unwrap());
    assert_eq!(spec.description, golden["description"].as_str().unwrap());
    assert_eq!(spec.input_schema, golden["inputSchema"]);
}

/// A service call a turn's tool makes carries that turn's approval gate and the asking tool call
/// (Node `callerCtx.toolApprovalHook` and `toolCallId`, `internal-tool-executor/feature-tools.mjs`):
/// the service asks a person through it. Outside a tool call there is none.
#[tokio::test]
async fn a_service_call_carries_the_turns_approval_gate() {
    use mixdog_core_api::domain::approval::{ApprovalAsk, ApprovalKind};

    struct Asks;
    #[async_trait]
    impl super::service::ToolService for Asks {
        async fn call(&self, _: super::service::ServiceCall<'_>) -> Result<Vec<ToolPart>, super::util::PortError> {
            let approvals = super::service::call_approvals().expect("the tool call's gate");
            let ask = ApprovalAsk {
                kind: ApprovalKind::Tool,
                call_id: Some(approvals.call_id.clone()),
                tool: Some("tidy".into()),
                action_kind: None,
                reason: None,
                payload: json!({}),
                remember: Vec::new(),
                expires_after: None,
            };
            let _ = approvals.gate.request(ask).await;
            Ok(vec![ToolPart::Text(approvals.call_id.to_string())])
        }
    }
    assert!(super::service::call_approvals().is_none(), "no tool call, no gate");
    let gate = Arc::new(MockApprovalGate::default());
    let context = ToolContext { approvals: gate.clone(), ..ctx() };
    let out = super::service::ServiceTool::tidy(Arc::new(Asks)).call(&context, json!({})).await.expect("call");
    assert_eq!(out.parts, [ToolPart::Text("c".into())]);
    let asks = gate.asks.lock().unwrap();
    assert_eq!(asks.len(), 1, "the ask reached the turn's own gate");
    assert_eq!(asks[0].call_id, Some(ToolCallId::from("c")));
}
