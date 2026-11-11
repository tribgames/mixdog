//! Node's session-adopt-hooks hook cases (`fixtures/session-adopt-cases`, `record-session-adopt-cases.mjs`):
//! - rules: hook rules saved and deleted through the setup actions while a session is open; each PreToolUse answer
//!   of the hook bus (`HookBus::before_tool`) against Node's `beforeToolHook` answer, in order;
//! - deny: a configured PreToolUse command that denies `shell`; the whole tool result text of the call through the
//!   tool policy (`ToolPolicy::authorize` over `BusPreToolHook`) and the hook's run count, per session.
//! The compaction cases replay in mixdog-core (`run_host/run_seams/adopt_node_cases.rs`).
#![allow(clippy::disallowed_methods, reason = "test fixtures: the recording, the hooks file and the deny script")]

use std::path::Path;
use std::path::PathBuf;
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

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-adopt-cases/golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn case<'a>(golden: &'a Value, kind: &str) -> &'a Value {
    golden["cases"].as_array().unwrap().iter().find(|c| c["kind"] == kind).unwrap()
}

/// Node's answer: the decision's fields that are set, or `null` when no hook has an opinion.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hook_rules_saved_while_a_session_is_open_answer_as_node_does() {
    let golden = golden();
    let case = case(&golden, "rules");
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let log = HookEventLog::new(data.clone());
    let status = HookStatus::new(data.clone(), tokens.maintenance_io, log.clone(), log.clone());
    let setup = HookRuleSetup::new(data.join("hooks.json"), tokens.maintenance_io, status, log.clone());
    let bus = HookBus::new(data.clone(), tokens.maintenance_io, Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())), None, None, None);
    let thread = ThreadId::from("sess_resumed");
    let (common, args) = (HookCommon::default(), json!({}));
    let mut steps = Vec::new();
    for step in case["recorded"]["steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "call" => {
                let tool = step["tool"].as_str().unwrap();
                let call = ToolCall { session_id: thread.as_str(), call_id: "", name: tool, args: &args, cwd: &data, common: &common };
                steps.push(json!({ "op": "call", "tool": tool, "answer": answer(bus.before_tool(&call).await) }));
            }
            "addRule" => {
                let args = json!({ "action": "add_hook_rule", "hookRule": step["rule"] });
                setup.run(&SetupCall { action: "add_hook_rule", args: &args, thread: &thread }).await.unwrap();
                steps.push(json!({ "op": "addRule", "rule": step["rule"] }));
            }
            "deleteRule" => {
                let args = json!({ "action": "delete_hook_rule", "ruleIndex": step["index"] });
                setup.run(&SetupCall { action: "delete_hook_rule", args: &args, thread: &thread }).await.unwrap();
                steps.push(json!({ "op": "deleteRule", "index": step["index"] }));
            }
            other => panic!("unrecorded step {other}"),
        }
    }
    assert_eq!(json!({ "steps": steps }), case["recorded"], "{}", case["case"]);
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

/// The `node` the recording ran its deny script with: the first one on `PATH`.
fn node() -> PathBuf {
    let names: &[&str] = if cfg!(windows) { &["node.exe"] } else { &["node"] };
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
        .expect("node on PATH")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_deny_hook_runs_once_for_a_resumed_and_a_fresh_session_as_in_node() {
    let golden = golden();
    let case = case(&golden, "deny");
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let calls = data.join("hook-calls.log");
    let script = data.join("deny.mjs");
    std::fs::write(
        &script,
        format!(
            "import {{ appendFileSync }} from 'node:fs';\nappendFileSync({}, 'x');\nprocess.stderr.write({});\nprocess.exit({});\n",
            json!(calls.to_string_lossy()),
            case["deny"]["stderr"],
            case["deny"]["exit"]
        ),
    )
    .unwrap();
    let mut hooks = case["hooks"].clone();
    let handler = &mut hooks["PreToolUse"][0]["hooks"][0];
    handler["command"] = json!(node().to_string_lossy());
    handler["args"] = json!([script.to_string_lossy()]);
    std::fs::write(data.join("hooks.json"), json!({ "hooks": hooks }).to_string()).unwrap();
    let bus = HookBus::new(data.clone(), tokens.maintenance_io, Arc::new(LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default())), None, None, None);
    let policy = ToolPolicy::new(Arc::new(MemoryGrantStore::default()), Arc::new(NoConnectors))
        .with_hook(Arc::new(BusPreToolHook::new(bus, Arc::new(|_: &ThreadId| HookCommon::default()))));
    let mut runs = Vec::new();
    for run in case["recorded"]["runs"].as_array().unwrap() {
        let id = run["id"].as_str().unwrap();
        std::fs::write(&calls, "").unwrap();
        let result = policy
            .authorize(AuthorizeRequest {
                call_id: &ToolCallId::from("call-1"),
                thread_id: &ThreadId::from(id),
                name: "shell",
                args: json!({ "command": case["command"] }),
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
        let result = match result {
            Err(error) => error.message_for_model,
            Ok(authorized) => format!("authorized {authorized:?}"),
        };
        runs.push(json!({ "id": id, "result": result, "hookRuns": std::fs::read_to_string(&calls).unwrap().len() }));
    }
    assert_eq!(json!({ "runs": runs }), case["recorded"], "{}", case["case"]);
}
