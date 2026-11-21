//! Whole tool calls driven with stub services: the text a `session`, `agent` or `tidy` call answers with, or fails with.

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
        if call.action == "status" && call.args["session_id"] == "sess_lead1" {
            return Ok(json!({"sessionId":"sess_lead1","busy":true,"agentsWorking":true,"quotaResume":{"state":"waiting"}}));
        }
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

/// `BOT_TARGET_ACTIONS` of Node's `bot-target.mjs` is read, send and status: a bot id names its home chat for those three
/// only; `list`, `bots`, `cancel` and `delete` take the id as given (`list` and `bots` do not look at it, `cancel` and
/// `delete` look for a session of that id).
#[tokio::test]
async fn a_bot_id_names_its_home_chat_for_read_send_and_status_only() {
    let tool = SessionTool::new(Arc::new(Stub), Arc::new(Facts));
    for (action, resolved) in [("read", true), ("send", true), ("status", true), ("list", false), ("bots", false), ("cancel", false), ("delete", false)] {
        let mut args = json!({"action": action, "session_id": "ann"});
        if action == "send" {
            args["prompt"] = json!("Follow up");
        }
        let out = tool.call(&ctx(), args).await.expect(action);
        let ToolPart::Text(text) = &out.parts[0] else { panic!("text") };
        let answered: Value = serde_json::from_str(text).expect("json");
        assert_eq!(answered["sessionId"], if resolved { "sess_home_ann" } else { "ann" }, "{action}");
    }
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

#[tokio::test]
async fn session_actions_answer_with_their_json_or_their_refusal() {
    let tool = SessionTool::new(Arc::new(Stub), Arc::new(Facts));
    let cwd = root().as_path().to_string_lossy().replace('\\', "\\\\");
    let status = format!(
        "{{\n  \"sessionId\": \"sess_lead1\",\n  \"title\": \"My title\",\n  \"titleSource\": \"user\",\n  \"cwd\": \"{cwd}\",\n  \"project\": \"{cwd}\",\n  \"provider\": \"anthropic\",\n  \"model\": \"claude-x\",\n  \"effort\": \"high\",\n  \"autoEffort\": true,\n  \"fast\": false\n}}"
    );
    let cases = [
        (json!({"action":"status"}), true, status.clone()),
        (json!({"action":"status","session_id":"sess_lead1"}), true, r#"{"sessionId":"sess_lead1","busy":true,"agentsWorking":true,"quotaResume":{"state":"waiting"}}"#.to_owned()),
        (json!({}), true, status),
        (json!({"action":"compact"}), true, "{\n  \"action\": \"compact\",\n  \"sessionId\": \"sess_lead1\",\n  \"scheduled\": true,\n  \"note\": \"Compaction runs right after the current turn finishes.\"\n}".to_owned()),
        (json!({"action":"fork"}), true, "{\n  \"action\": \"fork\",\n  \"sourceSessionId\": \"sess_lead1\",\n  \"sessionId\": \"sess_fork1\",\n  \"compacted\": false\n}".to_owned()),
        (json!({"action":"fork","compact":true}), true, "{\n  \"action\": \"fork\",\n  \"sourceSessionId\": \"sess_lead1\",\n  \"sessionId\": \"sess_fork1\",\n  \"compacted\": true\n}".to_owned()),
        (json!({"action":"rename","title":"New"}), false, "session: the user already titled this session; the title was not changed".to_owned()),
        (json!({"action":"rename"}), false, "session: title is required for action=rename".to_owned()),
        (json!({"action":"list","limit":5}), true, "{\"ok\":true,\"action\":\"list\",\"sessionId\":null,\"items\":[]}".to_owned()),
        (json!({"action":"read","session_id":"sess_other"}), true, "{\"ok\":true,\"action\":\"read\",\"sessionId\":\"sess_other\",\"items\":[]}".to_owned()),
        (json!({"action":"send","session_id":"sess_other","attachments":["x"]}), false, "session: prompt is required for action=send".to_owned()),
        (json!({"action":"create","brief":"x"}), false, "session: create belongs to a bot conversation; delegated workers, agent task sessions and schedule/webhook runs cannot create agent task sessions".to_owned()),
        (json!({"action":"favorite"}), false, "session: value (boolean) is required for action=favorite".to_owned()),
        (json!({"action":"compact","session_id":"sess_other"}), false, "session: action=compact only applies to the current session".to_owned()),
        (json!({"action":"zap"}), false, "session: unknown action \"zap\"".to_owned()),
        (json!({"action":"set-project"}), false, "session: path is required for action=set-project".to_owned()),
    ];
    for (args, want_ok, want_text) in cases {
        let (ok, got) = match tool.call(&ctx(), args.clone()).await {
            Ok(out) => (
                true,
                match &out.parts[0] {
                    ToolPart::Text(t) => t.clone(),
                    other => panic!("{other:?}"),
                },
            ),
            Err(e) => (false, e.message_for_model),
        };
        assert_eq!((ok, got), (want_ok, want_text), "{args}");
    }
}
mod agent_calls {
    use super::super::agent::*;
    use super::*;

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
                    jobs: vec![JobRow {
                        task_id: "job_1".into(),
                        kind: "spawn".into(),
                        status: "completed".into(),
                        tag: Some("worker-a".into()),
                        finished: true,
                        ..JobRow::default()
                    }],
                },
                _ => AgentReply::Closed(ClosedView { closed: true, tag: Some("worker-a".into()), session_id: Some("sess_a".into()), ..ClosedView::default() }),
            })
        }
    }

    async fn text_of_call(args: Value) -> String {
        let tool = AgentTool::new(Arc::new(Scripted), Arc::new(Stub), Arc::new(Facts));
        let out = tool.call(&ctx(), args).await.expect("agent call");
        let ToolPart::Text(got) = &out.parts[0] else { panic!("text") };
        got.clone()
    }

    #[tokio::test]
    async fn an_agent_call_without_a_type_does_not_spawn() {
        let tool = AgentTool::new(Arc::new(Scripted), Arc::new(Stub), Arc::new(Facts));
        let error = tool.call(&ctx(), json!({"agent":"coder","prompt":"do it"})).await.expect_err("no implicit spawn");
        assert!(matches!(error.code, ToolErrorCode::InvalidArgs { field, .. } if field == "type"));
    }

    #[tokio::test]
    async fn a_spawn_reads_as_its_task_text() {
        assert_eq!(
            text_of_call(json!({"type":"spawn","agent":"coder","prompt":"do it"})).await,
            "agent task: job_1\nstatus: running\ntype: spawn\ntarget: worker-a sess_a\nnotification: completion will be delivered; end the turn."
        );
    }

    #[tokio::test]
    async fn a_status_reads_as_its_task_text_with_diagnostics() {
        assert_eq!(
            text_of_call(json!({"type":"status","tag":"worker-a"})).await,
            "agent task: job_1\nstatus: running\ntype: spawn\ntarget: worker-a sess_a\nagent: coder\nmodel: p/m\nworker: running/streaming\nnotification: completion will be delivered; end the turn."
        );
    }

    #[tokio::test]
    async fn a_read_reads_as_the_final_answer() {
        assert_eq!(
            text_of_call(json!({"type":"read","tag":"worker-a"})).await,
            "agent task: job_1\nstatus: completed\ntype: spawn\ntarget: worker-a sess_a\n\nThe answer is 42."
        );
    }

    #[tokio::test]
    async fn a_list_reads_as_the_roster() {
        assert_eq!(
            text_of_call(json!({"type":"list"})).await,
            "agents: 1 · tasks: 1\n- idle/closed agents: 1 (latest 1; pass tag=<text> to find one)\n- worker-a  idle\n- finished tasks: 1 (latest 1; pass tag=<text> to find one)\n- job_1  spawn  completed  worker-a"
        );
    }

    #[tokio::test]
    async fn a_close_reads_as_its_receipt() {
        assert_eq!(text_of_call(json!({"type":"close","tag":"worker-a"})).await, "agent close: ok\ntag: worker-a\nsessionId: sess_a");
    }
}
/// The model sees the tidy tool's name, its actions and what `fix` needs.
#[test]
fn the_tidy_tool_is_defined_with_its_six_actions() {
    struct Never;
    #[async_trait]
    impl super::service::ToolService for Never {
        async fn call(&self, _: super::service::ServiceCall<'_>) -> Result<Vec<ToolPart>, super::util::PortError> {
            unreachable!()
        }
    }
    let tool = super::service::ServiceTool::tidy(Arc::new(Never));
    let spec = tool.spec();
    assert_eq!(spec.name, "tidy");
    assert!(
        spec.description.starts_with("Clean up code across the languages in this project; engine/rule work belongs here, not shell."),
        "{}",
        spec.description
    );
    assert_eq!(spec.input_schema["required"], json!(["action"]));
    assert_eq!(spec.input_schema["properties"]["action"]["enum"], json!(["scan", "check", "fix", "install", "rules", "results"]));
    let fields: Vec<&str> = spec.input_schema["properties"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(fields, ["action", "paths", "languages", "engines", "rules", "apply", "approveDownloads", "structural", "offset", "limit"]);
}
