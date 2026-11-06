//! The agent tool's request dispatch against the goldens recorded from Node
//! (`fixtures/agent/record-agent-tool.mjs`): the same scripted world, the same effect calls in
//! the same order, the same rendered answer.
//! Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::AgentDeps;
use mixdog_agent::agent_tool::AgentRuntime;
use mixdog_agent::agent_tool::error_text::PlainErrorText;
use mixdog_agent::agent_tool::host::*;
use mixdog_agent::agent_tool::model_select::ListOptions as ModelListOptions;
use mixdog_agent::agent_tool::model_select::ModelCatalog;
use mixdog_agent::agent_tool::model_select::ModelRow;
use mixdog_agent::agent_tool::scope::Caller;
use mixdog_agent::agent_tool::scope::Owner;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::JobRow;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::agent::TaskView;
use mixdog_tools::orch::agent::WorkerRow;
use mixdog_tools::orch::agent::render;
use serde_json::Value;
use serde_json::json;

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn owner_of(v: &Value) -> Owner {
    Owner { parent_session_id: s(v, "parentSessionId"), owner_session_id: s(v, "ownerSessionId"), client_host_pid: None }
}

fn record(v: &Value) -> TagRecord {
    TagRecord { tag: s(v, "tag"), session_id: s(v, "sessionId"), agent: s(v, "agent"), cwd: s(v, "cwd"), owner: owner_of(v) }
}

fn scope_json(scope: &Scope) -> Value {
    json!({ "s": scope.caller_session_id, "p": scope.host_pid })
}

/// One scenario's world: what the fakes answer from and the log they write.
struct World {
    json: Value,
    trace: Mutex<Vec<Value>>,
    /// Insertion-ordered `tag -> session id`.
    tags: Mutex<Vec<(String, String)>>,
    tag_agents: Mutex<HashSet<String>>,
    prepare: Mutex<VecDeque<Value>>,
    jobs: Mutex<u32>,
    cancelled: Mutex<HashSet<String>>,
}

impl World {
    fn log(&self, entry: Value) {
        self.trace.lock().unwrap().push(entry);
    }

    fn list(&self, key: &str) -> Vec<Value> {
        self.json.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn live(&self, id: &str) -> Option<SessionFacts> {
        let v = self.json.get("live")?.get(id)?;
        Some(SessionFacts { id: s(v, "id"), agent: s(v, "agent"), cwd: s(v, "cwd"), owner: owner_of(v) })
    }
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
        let named = |key: &str| self.0.list(key).iter().any(|t| t.as_str() == Some(tag));
        if named("ambiguous") {
            return Err(format!("agent: tag \"{tag}\" is ambiguous across terminals"));
        }
        if named("unresolvable") {
            return Ok(None);
        }
        if let Some((_, id)) = self.0.tags.lock().unwrap().iter().find(|(t, _)| t == tag) {
            return Ok(Some(id.clone()));
        }
        Ok(self.0.live(tag).map(|_| tag.to_owned()))
    }
    fn live_session(&self, id: &str) -> Option<SessionFacts> {
        self.0.live(id)
    }
    fn tag_session(&self, tag: &str) -> Option<String> {
        self.0.tags.lock().unwrap().iter().find(|(t, _)| t == tag).map(|(_, id)| id.clone())
    }
    fn has_tag_agent(&self, tag: &str) -> bool {
        self.0.tag_agents.lock().unwrap().contains(tag)
    }
    fn tag_count(&self) -> usize {
        self.0.tags.lock().unwrap().len()
    }
    fn tag_for_session(&self, session_id: &str) -> Option<String> {
        self.0.tags.lock().unwrap().iter().find(|(_, id)| id == session_id).map(|(t, _)| t.clone())
    }
    fn unbind_tag(&self, tag: &str) {
        self.0.log(json!(["unbindTag", tag]));
        self.0.tags.lock().unwrap().retain(|(t, _)| t != tag);
        self.0.tag_agents.lock().unwrap().remove(tag);
    }
    fn bind_tag(&self, tag: &str, session: &SessionFacts, _turn_started_at: &str) {
        self.0.log(json!(["bindTag", tag, session.id]));
    }
    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str) {
        self.0.log(json!(["forgetTerminalSession", tag, session_id]));
    }
    fn remove_worker_row(&self, session_id: &str) {
        self.0.log(json!(["removeWorkerRow", session_id]));
    }
    fn mark_released(&self, session_ids: &[String]) {
        self.0.log(json!(["markReleased", session_ids]));
    }
    fn read_worker_rows(&self, scope: &Scope) -> Result<Vec<TagRecord>, String> {
        Ok(self.0.list("rows").iter().map(record).filter(|r| scope.owns(&r.owner)).collect())
    }
    fn read_all_tag_tombstones(&self) -> Vec<TagRecord> {
        self.0.list("tombstones").iter().chain(self.0.list("foreignTombstones").iter()).map(record).collect()
    }
    fn tag_tombstone_for_tag(&self, tag: &str, scope: &Scope) -> Option<TagRecord> {
        self.0.list("tombstones").iter().map(record).find(|r| r.tag == tag && scope.owns(&r.owner))
    }
    fn consume_tag_tombstone(&self, tombstone: &TagRecord) {
        self.0.log(json!(["consumeTagTombstone", tombstone.tag, tombstone.session_id]));
    }
    fn last_tag_session(&self, tag: &str, scope: &Scope) -> Option<TagRecord> {
        let row = record(self.0.json.get("lastSessions")?.get(tag)?);
        scope.owns(&row.owner).then_some(row)
    }
    async fn resumable_tag_session(&self, tag: &str, session_id: &str, scope: &Scope) -> Option<Resumable> {
        self.0.log(json!(["resumableTagSession", tag, session_id, scope_json(scope)]));
        let found = self.0.json.get("resumable")?.get(format!("{tag}|{session_id}"))?;
        if found.is_null() {
            return None;
        }
        let session = found.get("session").filter(|v| !v.is_null()).map(|v| SessionFacts {
            id: s(v, "id"),
            agent: s(v, "agent"),
            cwd: s(v, "cwd"),
            owner: Owner { parent_session_id: "lead1".into(), ..Owner::default() },
        });
        Some(Resumable { session, missing_cwd: found.get("missingCwd").and_then(Value::as_str).map(str::to_owned) })
    }
}

#[async_trait]
impl SendFlow for Fakes {
    async fn prepare_send(&self, args: &Value, scope: &Scope) -> Result<Prepared, String> {
        let step = self
            .0
            .prepare
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| json!({ "ok": { "sessionId": "sess_default", "agent": "worker", "cwd": "/work" } }));
        self.0.log(json!(["prepareSend", args, scope_json(scope)]));
        if let Some(message) = step.get("err").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        let ok = &step["ok"];
        let id = s(ok, "sessionId");
        Ok(Prepared {
            args: args.clone(),
            session: SessionFacts { id: id.clone(), agent: s(ok, "agent"), cwd: s(ok, "cwd"), owner: Owner::default() },
            session_id: id,
            prompt: None,
            route: None,
        })
    }
    async fn adopt_caller(&self, prepared: &Prepared, _notify: &Caller) -> Result<(), String> {
        self.0.log(json!(["adoptCaller", prepared.session_id]));
        Ok(())
    }
    async fn dispatch_to_existing_session(&self, prepared: &Prepared, _notify: &Caller, options: DispatchOptions) -> Result<AgentReply, String> {
        self.0.log(json!([
            "dispatch",
            { "args": prepared.args, "sessionId": prepared.session_id, "prompt": prepared.prompt, "route": prepared.route },
            { "reused": options.reused, "resumed": options.resumed },
        ]));
        Ok(AgentReply::Text(format!("dispatched {}", prepared.session_id)))
    }
}

#[async_trait]
impl SpawnFlow for Fakes {
    async fn start_deferred_spawn_job(&self, args: &Value, caller_cwd: &str, _caller: &Caller, _notify: &Caller, options: SpawnOptions) -> Result<Job, String> {
        let n = {
            let mut jobs = self.0.jobs.lock().unwrap();
            *jobs += 1;
            *jobs
        };
        self.0.log(json!(["startSpawn", args, caller_cwd, { "respawned": options.respawned }]));
        let id = format!("job-{n}");
        Ok(Job {
            task_id: Some(id.clone()),
            session_id: None,
            view: TaskView { task_id: id, status: Some("running".into()), kind: Some("spawn".into()), respawned: options.respawned, ..TaskView::default() },
        })
    }
}

impl TerminalTrace for Fakes {
    fn has_terminal_trace(&self, tag: &str, _scope: &Scope) -> Result<bool, String> {
        Ok(self.0.list("traces").iter().any(|t| t.as_str() == Some(tag)))
    }
    fn reap_terminal_trace_for_tag(&self, tag: &str, _scope: &Scope) {
        self.0.log(json!(["reapTrace", tag]));
    }
}

#[async_trait]
impl Sessions for Fakes {
    async fn rehydrate_agent_sessions(&self) -> bool {
        self.0.log(json!(["rehydrate"]));
        true
    }
    async fn read_session_handoff(&self, _session_id: &str) -> Option<String> {
        self.0.json.get("handoff").and_then(Value::as_str).map(str::to_owned)
    }
    async fn close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> bool {
        let mut opts = json!({ "tombstone": options.tombstone });
        if options.owner_close {
            opts["ownerClose"] = json!(true);
        }
        self.0.log(json!(["closeSession", session_id, reason, opts]));
        self.0.json.get("closeOk") == Some(&Value::Bool(true))
    }
    fn descendant_session_ids(&self, session_id: &str) -> Vec<String> {
        self.0
            .json
            .get("descendants")
            .and_then(|d| d.get(session_id))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    }
    fn clear_statusline_route(&self, _session_id: &str) {}
}

fn task_facts(v: &Value) -> TaskFacts {
    TaskFacts {
        task_id: s(v, "task_id"),
        session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        tag: v.get("tag").and_then(Value::as_str).map(str::to_owned),
    }
}

impl Tasks for Fakes {
    fn list(&self, _scope: &Scope) -> Vec<TaskFacts> {
        self.0.list("tasks").iter().map(task_facts).collect()
    }
    fn get(&self, task_id: &str, _scope: &Scope) -> Option<TaskFacts> {
        self.0.list("tasks").iter().map(task_facts).find(|t| t.task_id == task_id)
    }
    fn cancel(&self, task_id: &str, _reason: &str) {
        if self.get(task_id, &Scope::default()).is_some() && self.0.cancelled.lock().unwrap().insert(task_id.to_owned()) {
            self.0.log(json!(["cancelTask", task_id]));
        }
    }
    fn cleanup(&self, _scope: &Scope, _force: bool) -> Cleaned {
        Cleaned { removed: 0 }
    }
}

fn view_of(v: &Value) -> TaskView {
    TaskView {
        task_id: s(v, "task_id"),
        status: v.get("status").and_then(Value::as_str).map(str::to_owned),
        kind: v.get("type").and_then(Value::as_str).map(str::to_owned),
        tag: v.get("tag").and_then(Value::as_str).map(str::to_owned),
        session_id: v.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        result: v.get("result").and_then(Value::as_str).map(|r| TaskResult::Content(r.to_owned())),
        ..TaskView::default()
    }
}

#[async_trait]
impl Views for Fakes {
    async fn get_job_or_worker(&self, _args: &Value, _scope: &Scope, _include_result: bool) -> Result<Job, String> {
        let job = self.0.json.get("job").ok_or("no job in the world")?;
        Ok(Job {
            task_id: job.get("taskId").and_then(Value::as_str).map(str::to_owned),
            session_id: job.get("sessionId").and_then(Value::as_str).map(str::to_owned),
            view: view_of(&job["view"]),
        })
    }
    async fn list(&self, _scope: &Scope, _options: ListOptions) -> Vec<WorkerRow> {
        self.0
            .list("workers")
            .iter()
            .map(|w| WorkerRow {
                tag: s(w, "tag"),
                status: w.get("status").and_then(Value::as_str).map(str::to_owned),
                stage: w.get("stage").and_then(Value::as_str).map(str::to_owned),
                active: w.get("active") == Some(&Value::Bool(true)),
                ..WorkerRow::default()
            })
            .collect()
    }
    async fn list_jobs(&self, _scope: &Scope) -> Vec<JobRow> {
        self.0
            .list("jobs")
            .iter()
            .map(|j| JobRow {
                task_id: s(j, "task_id"),
                kind: s(j, "type"),
                status: s(j, "status"),
                tag: j.get("tag").and_then(Value::as_str).map(str::to_owned),
                finished: j.get("finished") == Some(&Value::Bool(true)),
                ..JobRow::default()
            })
            .collect()
    }
}

#[async_trait]
impl ModelCatalog for Fakes {
    async fn list(&self, options: ModelListOptions) -> Vec<ModelRow> {
        self.0.log(json!(["listModels", { "quick": options.quick, "force": options.force, "provider": options.provider }]));
        self.0
            .list("catalog")
            .iter()
            .map(|r| ModelRow {
                provider: s(r, "provider"),
                id: s(r, "id"),
                display: s(r, "display"),
                catalog_complete: r.get("catalogComplete") == Some(&Value::Bool(true)),
            })
            .collect()
    }
}

#[async_trait]
impl Environment for Fakes {
    async fn is_directory(&self, _path: &str) -> bool {
        false
    }
    async fn read_text(&self, path: &str) -> Result<String, String> {
        Err(format!("no file {path}"))
    }
    fn current_dir(&self) -> String {
        "/work".into()
    }
    fn now_iso(&self) -> String {
        String::new()
    }
}

struct Caller1;
impl CallerScopes for Caller1 {
    fn scope_of(&self, _thread: &mixdog_protocol::ThreadId) -> Scope {
        Scope { caller_session_id: Some("lead1".into()), host_pid: Some(4242) }
    }
}

fn runtime(world: &Arc<World>) -> AgentRuntime {
    let fakes = Arc::new(Fakes(Arc::clone(world)));
    AgentRuntime::new(AgentDeps {
        registry: fakes.clone(),
        send_flow: fakes.clone(),
        spawn_flow: fakes.clone(),
        terminal_trace: fakes.clone(),
        sessions: fakes.clone(),
        tasks: fakes.clone(),
        views: fakes.clone(),
        env: fakes.clone(),
        catalog: world.json.get("catalog").map(|_| fakes.clone() as Arc<dyn ModelCatalog>),
        default_cwd: "/work".into(),
        scopes: Arc::new(Caller1),
        errors: Arc::new(PlainErrorText),
    })
}

#[tokio::test]
async fn every_recorded_scenario_equals_nodes_trace_and_answer() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/agent/agent_tool/cases.json");
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let name = s(case, "name");
        let world_json = case.get("world").cloned().unwrap_or(Value::Null);
        let tags = world_json
            .get("tags")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(t, id)| (t.clone(), id.as_str().unwrap().to_owned())).collect())
            .unwrap_or_default();
        let tag_agents: HashSet<String> = world_json
            .get("tagAgents")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|t| t.as_str().unwrap().to_owned()).collect())
            .unwrap_or_default();
        let world = Arc::new(World {
            prepare: Mutex::new(world_json.get("prepare").and_then(Value::as_array).cloned().unwrap_or_default().into()),
            json: world_json,
            trace: Mutex::new(Vec::new()),
            tags: Mutex::new(tags),
            tag_agents: Mutex::new(tag_agents),
            jobs: Mutex::new(0),
            cancelled: Mutex::new(HashSet::new()),
        });
        let rt = runtime(&world);
        let caller = Caller { scope: Scope { caller_session_id: Some("lead1".into()), host_pid: Some(4242) }, cwd: "/work".into() };
        let args = case["args"].clone();
        let reply = rt.handle(&args, &caller).await;
        let filter = args.get("tag").and_then(Value::as_str).unwrap_or_default();
        assert_eq!(render(&reply, filter), s(case, "result"), "{name}: answer");
        let trace = world.trace.lock().unwrap().clone();
        assert_eq!(Value::Array(trace), case["trace"], "{name}: trace");
    }
}
