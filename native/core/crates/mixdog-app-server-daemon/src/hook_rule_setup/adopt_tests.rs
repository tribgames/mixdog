//! A hook bus and a tool policy over hook rules and a configured deny hook, as a session sees them: rules saved or deleted while a
//! session is open apply to its next call, and a PreToolUse command that exits 2 denies the call once per session.
#![allow(clippy::disallowed_methods, reason = "test fixtures: the hooks file and the deny script")]

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::tool::Tool;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::hook_bus::ToolCall;
use mixdog_mcp::pre_tool::BusPreToolHook;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;
use mixdog_tools::policy::AuthorizeRequest;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::MemoryGrantStore;
use mixdog_tools::policy::PolicySettings;
use mixdog_tools::policy::SessionFacts;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;

use super::*;
use crate::domain_seams::hook_status::HookEventLog;
use crate::domain_seams::hook_status::HookStatus;

/// The decision's fields that are set, or `null` when no hook has an opinion.
fn answer(outcome: Option<mixdog_mcp::hook_bus::Outcome>) -> Value {
    let Some(outcome) = outcome else { return Value::Null };
    let mut out = Map::new();
    out.insert("action".into(), json!(outcome.action));
    if let Some(reason) = outcome.reason {
        out.insert("reason".into(), json!(reason));
    }
    if let Some(name) = outcome.name {
        out.insert("name".into(), json!(name));
    }
    if let Some(args) = outcome.args {
        out.insert("args".into(), args);
    }
    Value::Object(out)
}

struct NoConnectors;

#[async_trait]
impl ConnectorPermissions for NoConnectors {
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

struct NoTools;

impl ToolResolver for NoTools {
    fn resolve(&self, _: Option<&str>, _: &str) -> Option<Arc<dyn Tool>> {
        None
    }
}

struct NoApprovals;

#[async_trait]
impl ApprovalGate for NoApprovals {
    async fn request(&self, _: ApprovalAsk) -> ApprovalResolution {
        panic!("a denied call never asks")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hook_rules_saved_while_a_session_is_open_apply_to_its_next_call_and_stop_when_deleted() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let log = HookEventLog::new(data.clone());
    let status = HookStatus::new(data.clone(), tokens.maintenance_io, log.clone(), log.clone());
    let setup = HookRuleSetup::new(data.join("hooks.json"), tokens.maintenance_io, status, log.clone());
    let bus =
        HookBus::new(data.clone(), tokens.maintenance_io, Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())), None, None, None);
    let thread = ThreadId::from("sess_resumed");
    let (common, args) = (HookCommon::default(), json!({}));
    let decide = |tool: &'static str| {
        let (bus, thread, common, args, data) = (&bus, &thread, &common, &args, &data);
        async move { answer(bus.before_tool(&ToolCall { session_id: thread.as_str(), call_id: "", name: tool, args, cwd: data, common }).await) }
    };
    let ask = |tool: &str| json!({ "action": "ask", "reason": format!("approval requested by hook rule for {tool}") });
    assert_eq!(decide("setup").await, Value::Null, "no rule, no opinion");

    for rule in [json!({ "tool": "setup", "action": "ask" }), json!({ "tool": "mcp__cal__*", "action": "ask" })] {
        let args = json!({ "action": "add_hook_rule", "hookRule": rule });
        setup.run(&SetupCall { action: "add_hook_rule", args: &args, thread: &thread }).await.unwrap();
    }
    assert_eq!(decide("setup").await, ask("setup"), "a rule saved while the session is open applies to its next call");
    assert_eq!(decide("mcp__cal__create").await, ask("mcp__cal__create"), "a wildcard rule matches the tools under it");

    let args = json!({ "action": "delete_hook_rule", "ruleIndex": 0 });
    setup.run(&SetupCall { action: "delete_hook_rule", args: &args, thread: &thread }).await.unwrap();
    assert_eq!(decide("setup").await, Value::Null, "a deleted rule stops applying");
    assert_eq!(decide("mcp__cal__create").await, ask("mcp__cal__create"), "the other rule stays");
}

/// A deny command that needs no interpreter beyond the platform's own shell: it appends a line to `calls`, writes `blocked by policy`
/// to stderr and exits 2.
fn deny_command(dir: &Path, calls: &Path) -> (String, Vec<String>) {
    if cfg!(windows) {
        let script = dir.join("deny.cmd");
        std::fs::write(&script, format!("@echo x>>\"{}\"\r\n@echo blocked by policy 1>&2\r\n@exit /b 2\r\n", calls.display())).unwrap();
        ("cmd".to_owned(), vec!["/C".to_owned(), script.to_string_lossy().into_owned()])
    } else {
        let script = dir.join("deny.sh");
        std::fs::write(&script, format!("echo x >> '{}'\necho 'blocked by policy' >&2\nexit 2\n", calls.display())).unwrap();
        ("sh".to_owned(), vec![script.to_string_lossy().into_owned()])
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_deny_hook_runs_once_per_call_for_a_resumed_and_a_fresh_session_and_the_model_is_told_why() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let calls = data.join("hook-calls.log");
    let (command, args) = deny_command(&data, &calls);
    let hooks = json!({ "PreToolUse": [{ "matcher": "shell", "hooks": [{ "type": "command", "command": command, "args": args, "timeout": 10 }] }] });
    std::fs::write(data.join("hooks.json"), json!({ "hooks": hooks }).to_string()).unwrap();
    let bus =
        HookBus::new(data.clone(), tokens.maintenance_io, Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())), None, None, None);
    let policy = ToolPolicy::new(Arc::new(MemoryGrantStore::default()), Arc::new(NoConnectors))
        .with_hook(Arc::new(BusPreToolHook::new(bus, Arc::new(|_: &ThreadId| HookCommon::default()))));
    for id in ["sess_resumed", "sess_fresh"] {
        std::fs::write(&calls, "").unwrap();
        let result = policy
            .authorize(AuthorizeRequest {
                call_id: &ToolCallId::from("call-1"),
                thread_id: &ThreadId::from(id),
                name: "shell",
                args: json!({ "command": "echo hi" }),
                cwd: Path::new(&data),
                facts: &SessionFacts::default(),
                surface: &SessionSurface::default(),
                schema_name: None,
                settings: PolicySettings::default(),
                account: None,
                session_grants: &SessionGrants::default(),
                tools: &NoTools,
                approvals: &NoApprovals,
                cancel: &CancellationToken::new(),
            })
            .await;
        let message = match result {
            Err(error) => error.message_for_model,
            Ok(authorized) => panic!("{id}: the call was authorized: {authorized:?}"),
        };
        assert_eq!(message, "Error: tool \"shell\" denied by hook: blocked by policy", "{id}");
        assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1, "{id}: the hook ran once");
    }
}
