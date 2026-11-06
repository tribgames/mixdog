//! `thread/agentControl` against the goldens of `fixtures/turn-ops/agent-control.json`, recorded
//! from the REAL agent executor of Node (`execute.mjs` + `close-flow.mjs`) behind `agentControl`
//! (`benchmarks/rust-core/recorders/record-turn-ops.mjs`): the same requests (`type`), the same
//! world that keeps its state between requests, the same effects in the same order, the same
//! answers. The Rust side is the real `AgentRuntime` over a world of the same shape.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::AgentDeps;
use mixdog_agent::agent_tool::AgentRuntime;
use mixdog_agent::agent_tool::error_text::PlainErrorText;
use mixdog_agent::agent_tool::host::*;
use mixdog_agent::agent_tool::scope::Owner;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::JobRow;
use mixdog_tools::orch::agent::WorkerRow;
use serde_json::Value;
use serde_json::json;

use super::turn_actions::control_caller;
use super::turn_actions::run_agent_control;

struct World {
    session: String,
    cwd: String,
    /// `(tag, session id)`, in the order the workers were opened.
    workers: Mutex<Vec<(String, String)>>,
    trace: Mutex<Vec<Value>>,
}

impl World {
    fn log(&self, entry: Value) {
        self.trace.lock().unwrap().push(entry);
    }

    fn facts(&self, id: &str) -> Option<SessionFacts> {
        self.workers.lock().unwrap().iter().any(|(_, sid)| sid == id).then(|| SessionFacts {
            id: id.to_owned(),
            agent: "worker".into(),
            cwd: self.cwd.clone(),
            owner: Owner { parent_session_id: self.session.clone(), ..Owner::default() },
        })
    }

    fn drop_session(&self, id: &str) {
        self.workers.lock().unwrap().retain(|(_, sid)| sid != id);
    }
}

/// A host pid as the recorder writes it: the daemon's own is `process.pid`.
fn scope_json(scope: &Scope) -> Value {
    let pid = scope.host_pid.map(|p| if p == u64::from(std::process::id()) { json!("process.pid") } else { json!(p) });
    json!({ "p": pid, "s": scope.caller_session_id })
}

struct Fakes(Arc<World>);

#[async_trait]
impl Registry for Fakes {
    fn resolve_tombstone_owners(&self) {
        self.0.log(json!(["resolveTombstoneOwners"]));
    }
    async fn refresh_tags_from_sessions(&self, scan: bool, scope: &Scope) {
        self.0.log(json!(["refreshTags", scan, scope_json(scope)]));
    }
    fn resolve_tag(&self, tag: &str, scope: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        self.0.log(json!(["resolveTag", tag, scope_json(scope), { "scan": options.scan_sessions, "traces": options.exclude_terminal_traces }]));
        Ok(self.tag_session(tag).or_else(|| self.0.facts(tag).map(|_| tag.to_owned())))
    }
    fn live_session(&self, id: &str) -> Option<SessionFacts> {
        self.0.facts(id)
    }
    fn tag_session(&self, tag: &str) -> Option<String> {
        self.0.workers.lock().unwrap().iter().find(|(t, _)| t == tag).map(|(_, id)| id.clone())
    }
    fn has_tag_agent(&self, tag: &str) -> bool {
        self.tag_session(tag).is_some()
    }
    fn tag_count(&self) -> usize {
        self.0.workers.lock().unwrap().len()
    }
    fn tag_for_session(&self, id: &str) -> Option<String> {
        self.0.workers.lock().unwrap().iter().find(|(_, sid)| sid == id).map(|(t, _)| t.clone())
    }
    fn unbind_tag(&self, tag: &str) {
        self.0.log(json!(["unbindTag", tag]));
    }
    fn bind_tag(&self, _: &str, _: &SessionFacts, _: &str) {}
    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str) {
        self.0.log(json!(["forgetTerminalSession", tag, session_id]));
        self.0.drop_session(session_id);
    }
    fn remove_worker_row(&self, session_id: &str) {
        self.0.log(json!(["removeWorkerRow", session_id]));
        self.0.drop_session(session_id);
    }
    fn mark_released(&self, session_ids: &[String]) {
        self.0.log(json!(["markReleased", session_ids]));
    }
    fn read_worker_rows(&self, _: &Scope) -> Result<Vec<TagRecord>, String> {
        Ok(Vec::new())
    }
    fn read_all_tag_tombstones(&self) -> Vec<TagRecord> {
        Vec::new()
    }
    fn tag_tombstone_for_tag(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    fn consume_tag_tombstone(&self, _: &TagRecord) {}
    fn last_tag_session(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    async fn resumable_tag_session(&self, _: &str, _: &str, _: &Scope) -> Option<Resumable> {
        None
    }
}

#[async_trait]
impl SendFlow for Fakes {
    async fn prepare_send(&self, _: &Value, _: &Scope) -> Result<Prepared, String> {
        Err("no send in this world".into())
    }
    async fn adopt_caller(&self, _: &Prepared, _: &mixdog_agent::agent_tool::scope::Caller) -> Result<(), String> {
        Err("no send in this world".into())
    }
    async fn dispatch_to_existing_session(&self, _: &Prepared, _: &mixdog_agent::agent_tool::scope::Caller, _: DispatchOptions) -> Result<AgentReply, String> {
        Err("no send in this world".into())
    }
}

#[async_trait]
impl SpawnFlow for Fakes {
    async fn start_deferred_spawn_job(&self, _: &Value, _: &str, _: &mixdog_agent::agent_tool::scope::Caller, _: &mixdog_agent::agent_tool::scope::Caller, _: SpawnOptions) -> Result<Job, String> {
        Err("no spawn in this world".into())
    }
}

impl TerminalTrace for Fakes {
    fn has_terminal_trace(&self, _: &str, _: &Scope) -> Result<bool, String> {
        Ok(false)
    }
    fn reap_terminal_trace_for_tag(&self, _: &str, _: &Scope) {}
}

#[async_trait]
impl Sessions for Fakes {
    async fn rehydrate_agent_sessions(&self) -> bool {
        self.0.log(json!(["rehydrate"]));
        true
    }
    async fn read_session_handoff(&self, _: &str) -> Option<String> {
        None
    }
    async fn close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> bool {
        let mut opts = json!({ "tombstone": options.tombstone });
        if options.owner_close {
            opts["ownerClose"] = json!(true);
        }
        self.0.log(json!(["closeSession", session_id, reason, opts]));
        true
    }
    fn descendant_session_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn clear_statusline_route(&self, _: &str) {}
}

impl Tasks for Fakes {
    fn list(&self, _: &Scope) -> Vec<TaskFacts> {
        Vec::new()
    }
    fn get(&self, _: &str, _: &Scope) -> Option<TaskFacts> {
        None
    }
    fn cancel(&self, _: &str, _: &str) {}
    fn cleanup(&self, _: &Scope, _: bool) -> Cleaned {
        Cleaned { removed: 0 }
    }
}

#[async_trait]
impl Views for Fakes {
    async fn get_job_or_worker(&self, _: &Value, _: &Scope, _: bool) -> Result<Job, String> {
        Err("no job in the world".into())
    }
    async fn list(&self, _: &Scope, _: ListOptions) -> Vec<WorkerRow> {
        self.0
            .workers
            .lock()
            .unwrap()
            .iter()
            .map(|(tag, _)| WorkerRow { tag: tag.clone(), status: Some("idle".into()), ..WorkerRow::default() })
            .collect()
    }
    async fn list_jobs(&self, _: &Scope) -> Vec<JobRow> {
        Vec::new()
    }
}

#[async_trait]
impl Environment for Fakes {
    async fn is_directory(&self, _: &str) -> bool {
        false
    }
    async fn read_text(&self, path: &str) -> Result<String, String> {
        Err(format!("no file {path}"))
    }
    fn current_dir(&self) -> String {
        self.0.cwd.clone()
    }
    fn now_iso(&self) -> String {
        String::new()
    }
}

struct NoScopes;
impl CallerScopes for NoScopes {
    fn scope_of(&self, _: &mixdog_protocol::ThreadId) -> Scope {
        Scope::default()
    }
}

#[tokio::test]
async fn agent_control_equals_the_real_executor_over_a_world_that_keeps_state() {
    let text = include_str!("../../../../fixtures/turn-ops/agent-control.json");
    let cases: Value = serde_json::from_str(text).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let id = case["session"]["id"].as_str().unwrap();
        let world = Arc::new(World {
            session: id.to_owned(),
            cwd: case["cwd"].as_str().unwrap().to_owned(),
            workers: Mutex::new(case["workers"].as_array().unwrap().iter().map(|t| (t.as_str().unwrap().to_owned(), format!("sess_{}", t.as_str().unwrap()))).collect()),
            trace: Mutex::new(Vec::new()),
        });
        let fakes = Arc::new(Fakes(world.clone()));
        let agents = AgentRuntime::new(AgentDeps {
            registry: fakes.clone(),
            send_flow: fakes.clone(),
            spawn_flow: fakes.clone(),
            terminal_trace: fakes.clone(),
            sessions: fakes.clone(),
            tasks: fakes.clone(),
            views: fakes.clone(),
            env: fakes.clone(),
            catalog: None,
            default_cwd: world.cwd.clone(),
            scopes: Arc::new(NoScopes),
            errors: Arc::new(PlainErrorText),
        });
        let mut header = serde_json::Map::new();
        header.insert("cwd".into(), case["cwd"].clone());
        if let Some(pid) = case["session"].get("clientHostPid") {
            header.insert("clientHostPid".into(), pid.clone());
        }
        let caller = control_caller(&ThreadId::from(id), &header);
        let context = &case["context"];
        assert_eq!(caller.scope.caller_session_id.as_deref(), context["callerSessionId"].as_str(), "{name}");
        assert_eq!(caller.cwd, context["callerCwd"].as_str().unwrap(), "{name}");
        let pid = context["clientHostPid"].as_u64().unwrap_or_else(|| u64::from(std::process::id()));
        assert_eq!(caller.scope.host_pid, Some(pid), "{name}");
        assert_eq!(context["invocationSource"], "user-command");
        for step in case["steps"].as_array().unwrap() {
            world.trace.lock().unwrap().clear();
            world.log(json!(["execute", step["args"]]));
            let answer = run_agent_control(&agents, &caller, Some(step["args"].clone())).await;
            assert_eq!(answer, step["result"], "{name}: {}", step["args"]);
            assert_eq!(Value::Array(world.trace.lock().unwrap().clone()), step["trace"], "{name}: {}", step["args"]);
        }
    }
}
