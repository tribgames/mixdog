//! The agent home, memory and pool methods against the recorded Node twins
//! (`desktop/settings/agent-home-api-twin.json` by `record-agent-home-api.mjs`, `agent-pool/pool-twin.json`
//! by `record-agent-pool.mjs`): every scenario Node ran, success and failure, answers what Node
//! answered, and the dependency calls it made are the calls made here.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::*;

fn twin(rel: &str) -> Value {
    let text = match rel {
        "desktop/settings/agent-home-api-twin.json" => include_str!("../../../../fixtures/desktop/settings/agent-home-api-twin.json"),
        "agent-pool/pool-twin.json" => include_str!("../../../../fixtures/agent-pool/pool-twin.json"),
        other => panic!("unknown twin {other}"),
    };
    serde_json::from_str(text).unwrap()
}

fn message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_deref().unwrap_or("").to_owned(),
        other => panic!("not a domain error: {other:?}"),
    }
}

// ---- the home world of `record-agent-home-api.mjs` ----------------------------------------------

#[derive(Default)]
struct World {
    agents: Vec<String>,
    mixy_route: Value,
    mixy_created: bool,
    sessions: Map<String, Value>,
    archived: Vec<String>,
    retired: Vec<String>,
    running: Vec<String>,
    set_route_fails: bool,
    clear_fails: bool,
    archive_count: u32,
    log: Vec<Value>,
}

struct Home {
    world: Mutex<World>,
    routes: Value,
    extras: Vec<Value>,
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

fn toggle(list: &mut Vec<String>, id: &str, on: bool) {
    let at = list.iter().position(|item| item == id);
    match (on, at) {
        (true, None) => list.push(id.to_owned()),
        (false, Some(at)) => {
            list.remove(at);
        }
        _ => {}
    }
}

fn session_missing(id: &str) -> DepError {
    DepError { message: format!("Session {id} is not available"), code: Some("SESSION_NOT_AVAILABLE".into()) }
}

impl Home {
    fn apply(&self, patch: &Value) {
        let mut world = self.world.lock().unwrap();
        for (key, value) in patch.as_object().unwrap() {
            match key.as_str() {
                "mixyCreated" => world.mixy_created = value.as_bool().unwrap(),
                "agents" => world.agents = strings(value),
                "mixyRoute" => world.mixy_route = value.clone(),
                "sessions" => world.sessions = value.as_object().unwrap().clone(),
                "running" => world.running = strings(value),
                "setRouteFails" => world.set_route_fails = value.as_bool().unwrap(),
                "clearFails" => world.clear_fails = value.as_bool().unwrap(),
                other => panic!("unknown world key {other}"),
            }
        }
    }

    fn take_log(&self) -> Value {
        Value::Array(std::mem::take(&mut self.world.lock().unwrap().log))
    }
}

#[async_trait]
impl HomeDeps for Home {
    async fn list_agents(&self) -> Result<Value, DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["listAgents"]));
        let mut rows: Vec<Value> = world
            .agents
            .iter()
            .map(|id| json!({ "id": id, "custom": true, "kind": "bot", "disabled": id == "dee", "route": self.routes[id] }))
            .collect();
        rows.extend(self.extras.iter().cloned());
        Ok(Value::Array(rows))
    }

    async fn mixy_route(&self) -> Result<Value, DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["mixyRoute"]));
        Ok(world.mixy_route.clone())
    }

    async fn mixy_created(&self) -> Result<bool, DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["mixyCreated"]));
        Ok(world.mixy_created)
    }

    async fn read_session(&self, session_id: &str) -> Result<Value, DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["readSession", session_id]));
        world.sessions.get(session_id).map(|session| session["route"].clone()).ok_or_else(|| session_missing(session_id))
    }

    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["createSession", session_id, params]));
        let route: Map<String, Value> = ["provider", "model", "effort"].iter().filter_map(|key| params.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
        world.sessions.insert(session_id.to_owned(), json!({ "route": route, "turns": false }));
        Ok(())
    }

    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["setRoute", session_id, route]));
        if world.set_route_fails {
            return Err(DepError::new("The provider is signed out."));
        }
        world.sessions.get_mut(session_id).unwrap()["route"] = route.clone();
        Ok(())
    }

    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["setArchived", session_id, archived]));
        toggle(&mut world.archived, session_id, archived);
        Ok(())
    }

    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["setRetired", session_id, retired]));
        toggle(&mut world.retired, session_id, retired);
        Ok(())
    }

    async fn task_workspace(&self) -> Result<String, DepError> {
        self.world.lock().unwrap().log.push(json!(["taskWorkspace"]));
        Ok("/work".into())
    }

    async fn clear_session(&self, session_id: &str, archive_as: &str) -> Result<(), DepError> {
        let mut world = self.world.lock().unwrap();
        world.log.push(json!(["clearSession", session_id, archive_as]));
        if world.clear_fails || world.running.iter().any(|id| id == session_id) {
            return Err(DepError::new("The session is running a turn."));
        }
        if let Some(session) = world.sessions.get(session_id).cloned()
            && session["turns"] == Value::Bool(true)
        {
            world.sessions.insert(archive_as.to_owned(), session);
            world.sessions.get_mut(session_id).unwrap()["turns"] = Value::Bool(false);
        }
        Ok(())
    }

    fn mint_archive_id(&self) -> String {
        let mut world = self.world.lock().unwrap();
        world.archive_count += 1;
        format!("sess_archive_{}", world.archive_count)
    }
}

fn home_world(scenario: &Value, twin: &Value) -> Arc<Home> {
    let world = &scenario["world"];
    Arc::new(Home {
        world: Mutex::new(World {
            agents: strings(&world["agents"]),
            mixy_route: world["mixyRoute"].clone(),
            mixy_created: world["mixyCreated"].as_bool().unwrap(),
            sessions: world["sessions"].as_object().unwrap().clone(),
            archived: strings(&world["archived"]),
            retired: strings(&world["retired"]),
            running: strings(&world["running"]),
            set_route_fails: world["setRouteFails"].as_bool().unwrap(),
            clear_fails: world["clearFails"].as_bool().unwrap(),
            ..World::default()
        }),
        routes: twin["routes"].clone(),
        extras: twin["catalogExtras"].as_array().unwrap().clone(),
    })
}

#[tokio::test]
async fn open_and_reset_answer_what_node_answered_and_call_what_node_called() {
    let twin = twin("desktop/settings/agent-home-api-twin.json");
    let (mut opened, mut failed_calls) = (0, 0);
    for (index, scenario) in twin["homes"].as_array().unwrap().iter().enumerate() {
        let home = home_world(scenario, &twin);
        let homes = AgentHomeSessions::new(home.clone());
        for (step, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let label = format!("scenario {index} step {step}");
            if op["op"] == "world" {
                home.apply(&op["patch"]);
                continue;
            }
            let agent = op["agent"].as_str().unwrap();
            home.take_log();
            let got = if op["op"] == "open" { homes.open(agent).await } else { homes.reset(agent).await };
            match (&got, op.get("error")) {
                (Ok(value), None) => {
                    opened += 1;
                    assert_eq!(value, &op["result"], "{label}: result");
                }
                (Err(error), Some(want)) => {
                    failed_calls += 1;
                    assert_eq!(message(error), want.as_str().unwrap(), "{label}: error");
                }
                (got, want) => panic!("{label}: got {got:?}, Node {want:?} / {}", op["result"]),
            }
            assert_eq!(home.take_log(), op["log"], "{label}: dependency calls");
        }
    }
    assert!(opened > 40 && failed_calls > 40, "the twin covers both outcomes ({opened} ok, {failed_calls} failed)");
}

// ---- memory -------------------------------------------------------------------------------------

struct Replies {
    replies: Mutex<Vec<String>>,
    calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl MemoryRuntime for Replies {
    async fn memory_control(&self, args: Value) -> Result<String, String> {
        self.calls.lock().unwrap().push(json!(["memoryControl", args]));
        let mut replies = self.replies.lock().unwrap();
        // `String(undefined)` once the script runs out, as Node's shifted `undefined` reads.
        Ok(if replies.is_empty() { "undefined".to_owned() } else { replies.remove(0) })
    }
}

fn replies(list: &[String]) -> Arc<Replies> {
    Arc::new(Replies { replies: Mutex::new(list.to_vec()), calls: Mutex::new(Vec::new()) })
}

#[tokio::test]
async fn memory_list_and_delete_answer_what_node_answered() {
    let twin = twin("desktop/settings/agent-home-api-twin.json");
    for (index, case) in twin["memoryList"].as_array().unwrap().iter().enumerate() {
        let runtime = replies(&case["replies"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_owned()).collect::<Vec<_>>());
        let got = AgentMemoryHost::new(runtime.clone()).list(case["agent"].as_str().unwrap()).await;
        let label = format!("list case {index}");
        match (&got, case.get("error")) {
            (Ok(value), None) => assert_eq!(value, &case["result"], "{label}"),
            (Err(error), Some(want)) => assert_eq!(message(error), want.as_str().unwrap(), "{label}"),
            (got, want) => panic!("{label}: got {got:?}, Node {want:?}"),
        }
        assert_eq!(Value::Array(runtime.calls.lock().unwrap().clone()), case["calls"], "{label}: control calls");
    }
    for (index, case) in twin["memoryDelete"].as_array().unwrap().iter().enumerate() {
        let runtime = replies(&[case["reply"].as_str().unwrap().to_owned()]);
        let got = AgentMemoryHost::new(runtime.clone()).delete(case["agent"].as_str().unwrap(), &case["id"], &case["revision"]).await;
        let label = format!("delete case {index}");
        match (&got, case.get("error")) {
            (Ok(()), None) => assert_eq!(case["result"], Value::Null, "{label}"),
            (Err(error), Some(want)) => assert_eq!(message(error), want.as_str().unwrap(), "{label}"),
            (got, want) => panic!("{label}: got {got:?}, Node {want:?}"),
        }
        assert_eq!(Value::Array(runtime.calls.lock().unwrap().clone()), case["calls"], "{label}: control calls");
    }
}

// ---- the pool -----------------------------------------------------------------------------------

/// The files of one recorded case, read as Node reads them.
#[derive(Clone, Default)]
struct Files {
    agent_index: Option<Value>,
    lead_index: Option<Value>,
    headers: HashMap<String, Option<Map<String, Value>>>,
}

/// A header as `readTopLevelFields` reads it: the pool's fields of an object or an array root.
fn header_of(text: &str) -> Option<Map<String, Value>> {
    let doc: Value = serde_json::from_str(text).ok()?;
    match doc {
        Value::Object(map) => Some(HEADER_FIELDS.iter().filter_map(|key| map.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect()),
        Value::Array(_) => Some(Map::new()),
        _ => None,
    }
}

fn files_of(case: &Value) -> Files {
    let parse = |text: &Value| text.as_str().and_then(|text| serde_json::from_str::<Value>(text).ok());
    let files = &case["files"];
    Files {
        agent_index: parse(&files["agentIndex"]),
        lead_index: parse(&files["leadIndex"]),
        headers: files["headers"].as_object().unwrap().iter().map(|(id, text)| (id.clone(), header_of(text.as_str().unwrap()))).collect(),
    }
}

/// The recorded world: the files of the case under test and the daemon's state at its step. One
/// pool serves every case, as Node's idle stamps live as long as its process.
#[derive(Default)]
struct Rig {
    files: Mutex<Files>,
    step: Mutex<Value>,
    stall: Value,
    asked: Mutex<Option<Value>>,
}

impl Rig {
    fn step(&self, key: &str) -> Value {
        self.step.lock().unwrap()[key].clone()
    }
}

#[async_trait]
impl PoolStore for Rig {
    async fn agent_index(&self) -> Option<Value> {
        self.files.lock().unwrap().agent_index.clone()
    }

    async fn lead_index(&self) -> Option<Value> {
        self.files.lock().unwrap().lead_index.clone()
    }

    async fn headers(&self, session_ids: &[String]) -> Vec<Option<Map<String, Value>>> {
        let files = self.files.lock().unwrap();
        session_ids.iter().map(|id| files.headers.get(id).cloned().flatten()).collect()
    }
}

impl PoolLive for Rig {
    fn now(&self) -> f64 {
        self.step("now").as_f64().unwrap()
    }

    fn running(&self) -> HashSet<String> {
        strings(&self.step("running")).into_iter().collect()
    }

    fn awaiting_shell(&self) -> HashSet<String> {
        strings(&self.step("awaiting")).into_iter().collect()
    }

    fn live_session(&self, session_id: &str) -> Option<Value> {
        self.step("live").get(session_id).cloned()
    }

    fn runtime_entry(&self, session_id: &str) -> Option<RuntimeEntry> {
        self.step("entries").get(session_id).map(|entry| RuntimeEntry { liveness: entry.as_object().unwrap().clone(), controller_live: false })
    }

    fn ledger_tokens(&self, groups: &[(String, Vec<String>)]) -> HashMap<String, String> {
        let asked: Map<String, Value> = groups.iter().map(|(owner, ids)| (owner.clone(), json!(ids))).collect();
        *self.asked.lock().unwrap() = Some(Value::Object(asked));
        self.step("ledger").as_object().unwrap().iter().map(|(owner, token)| (owner.clone(), token.as_str().unwrap().to_owned())).collect()
    }

    fn stall_warn_ms(&self, agent: Option<&str>) -> f64 {
        self.stall[agent.unwrap_or("null")].as_f64().unwrap()
    }
}

#[tokio::test]
async fn the_pool_lists_what_node_listed() {
    let twin = twin("agent-pool/pool-twin.json");
    let rig = Arc::new(Rig { stall: twin["stallWarnMs"].clone(), ..Rig::default() });
    let pool = AgentPool::new(rig.clone(), rig.clone());
    let (mut rows, mut errors) = (0, 0);
    for (index, case) in twin["cases"].as_array().unwrap().iter().enumerate() {
        *rig.files.lock().unwrap() = files_of(case);
        for (step_index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            *rig.step.lock().unwrap() = step.clone();
            *rig.asked.lock().unwrap() = None;
            let label = format!("case {index} step {step_index}");
            match (pool.list().await, step.get("error")) {
                (Ok(listed), None) => {
                    rows += listed.len();
                    assert_eq!(Value::Array(listed), step["rows"], "{label}: rows");
                    let want = if step["groups"].is_null() { Value::Null } else { step["groups"].clone() };
                    assert_eq!(rig.asked.lock().unwrap().clone().unwrap_or(Value::Null), want, "{label}: ledger groups");
                }
                (Err(error), Some(want)) => {
                    errors += 1;
                    assert_eq!(error.0, want.as_str().unwrap(), "{label}");
                }
                (got, want) => panic!("{label}: got {got:?}, Node {want:?}"),
            }
        }
    }
    assert!(rows > 300 && errors == 6, "{rows} rows, {errors} errors");
}

// ---- the service --------------------------------------------------------------------------------

struct Nothing;

#[async_trait]
impl PoolStore for Nothing {
    async fn agent_index(&self) -> Option<Value> {
        None
    }

    async fn lead_index(&self) -> Option<Value> {
        None
    }

    async fn headers(&self, session_ids: &[String]) -> Vec<Option<Map<String, Value>>> {
        session_ids.iter().map(|_| None).collect()
    }
}

impl PoolLive for Nothing {
    fn now(&self) -> f64 {
        0.0
    }

    fn running(&self) -> HashSet<String> {
        HashSet::new()
    }

    fn awaiting_shell(&self) -> HashSet<String> {
        HashSet::new()
    }

    fn live_session(&self, _: &str) -> Option<Value> {
        None
    }

    fn runtime_entry(&self, _: &str) -> Option<RuntimeEntry> {
        None
    }

    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }

    fn stall_warn_ms(&self, _: Option<&str>) -> f64 {
        0.0
    }
}

async fn call(service: &AgentHomeService, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("agents") };
    match service.call(request).await? {
        Reply::Value(value) => Ok(value),
        other => panic!("not a value reply: {other:?}"),
    }
}

#[tokio::test]
async fn the_service_claims_its_five_methods_and_reads_the_ipc_inputs_as_node_does() {
    let twin = twin("desktop/settings/agent-home-api-twin.json");
    let scenario = json!({ "world": { "agents": ["ada"], "mixyRoute": null, "mixyCreated": false, "sessions": {}, "archived": [], "retired": [], "running": [], "setRouteFails": false, "clearFails": false } });
    let home = home_world(&scenario, &twin);
    let runtime = replies(&["core deleted 3".to_owned(), "{\"entries\":[{\"id\":1,\"index_revision\":\"r1\",\"summary\":\"a\"}],\"nextOffset\":null}".to_owned()]);
    let service = AgentHomeService::new(AgentHomeSessions::new(home.clone()), AgentMemoryHost::new(runtime.clone()), AgentPool::new(Arc::new(Nothing), Arc::new(Nothing)));
    assert_eq!(service.methods(), HOME_METHODS);
    // `requiredString`: trimmed, then the home flow.
    assert_eq!(call(&service, "agent/home/open", json!({ "agentId": "  ada  " })).await.unwrap(), json!({ "sessionId": "sess_home_ada" }));
    assert_eq!(call(&service, "agent/home/reset", json!({ "agentId": "ada" })).await.unwrap(), json!({ "sessionId": "sess_home_ada", "archivedSessionId": null }));
    for (params, want) in [
        (json!({ "agentId": 5 }), "agentId must be a string."),
        (json!({}), "agentId must be a string."),
        (json!({ "agentId": "   " }), "agentId is invalid."),
        (json!({ "agentId": "a".repeat(201) }), "agentId is invalid."),
        (json!({ "agentId": "Bad Id" }), "agent id is invalid."),
    ] {
        assert_eq!(message(&call(&service, "agent/home/open", params).await.unwrap_err()), want);
    }
    // The entry id travels as text; the memory runtime sees the number it names.
    assert_eq!(call(&service, "agent/memory/delete", json!({ "agentId": "ada", "entryId": "3", "indexRevision": "r1" })).await.unwrap(), Value::Null);
    assert_eq!(runtime.calls.lock().unwrap()[0], json!(["memoryControl", { "op": "delete", "agent_id": "ada", "id": 3, "index_revision": "r1" }]));
    for (entry_id, revision, want) in [("1.5", json!("r"), "memory id is invalid."), ("0", json!("r"), "memory id is invalid."), ("x", json!("r"), "memory id is invalid."), ("2", json!(""), "memory indexRevision is invalid."), ("2", json!(7), "memory indexRevision is invalid.")] {
        let params = json!({ "agentId": "ada", "entryId": entry_id, "indexRevision": revision });
        assert_eq!(message(&call(&service, "agent/memory/delete", params).await.unwrap_err()), want);
    }
    assert_eq!(runtime.calls.lock().unwrap().len(), 1, "a refused entry never reaches the memory runtime");
    assert_eq!(call(&service, "agent/memory/list", json!({ "agentId": "ada" })).await.unwrap(), json!([{ "id": 1, "indexRevision": "r1", "summary": "a" }]));
    assert_eq!(call(&service, "agent/pool/list", json!({})).await.unwrap(), json!([]));
    assert!(call(&service, "agent/getLeadStatus", json!({})).await.is_err());
}