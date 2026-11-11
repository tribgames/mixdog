//! `route/set` and `fast/set`. The wire half (which keys are options, the completion of a
//! session-only request) against `fixtures/thread-settings/route-set-wire.json`, recorded from the
//! desktop's `createRouteWrite`; the adoption behind it over the route service's own recording
//! (`fixtures/ai-admin/route-service-twin.json`) and the agent route recording
//! (`fixtures/ai-admin/route-admin-twin.json`).

use std::sync::Arc;

use mixdog_ai::service::admin_route::Obj;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::testing::{request, scopes, value, with_op};
use mixdog_core_config::config::hidden_agents::hidden_agents;
use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes};
use serde_json::{Value, json};

use super::agent_route_service::AgentRouteSetter;
use super::agent_route_tests::{Facts, Published};
use super::route_service::SetRouteOptions;
use super::route_service_tests::rig;
use super::route_set_service::{FAST_SET, PRE_SESSION, Plan, ROUTE_SET, RouteSetService, plan};

fn wire() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/thread-settings/route-set-wire.json")).unwrap()
}

fn route_twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/route-service-twin.json")).unwrap()
}

fn admin_twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/route-admin-twin.json")).unwrap()
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

/// The options as `runtime.setRoute` receives them (`originGeneration` is the lease, opened by the route service).
fn options_json(options: &SetRouteOptions) -> Value {
    let mut out = Obj::new();
    out.insert("applyToCurrentSession".into(), json!(options.follow.apply_to_current_session));
    out.insert("keepMainModel".into(), json!(options.keep_main_model != Some(false)));
    if options.session_only {
        out.insert("sessionOnly".into(), json!(true));
    }
    if options.only_if_empty {
        out.insert("onlyIfEmpty".into(), json!(true));
    }
    out.insert("switchEstablished".into(), json!(options.follow.switch_established));
    out.insert("deferUntilNextTurn".into(), json!(options.follow.defer_until_next_turn));
    Value::Object(out)
}

#[test]
fn the_wire_half_hands_the_runtime_what_node_hands_it() {
    for (i, case) in wire()["cases"].as_array().unwrap().iter().enumerate() {
        let got = match plan(&obj(&case["request"]), &obj(&case["selected"])) {
            Plan::Unchanged => json!([]),
            Plan::Write(next, options) => json!([[next, options_json(&options)]]),
        };
        let want: Vec<Value> = case["runtimeCalls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|call| {
                let mut options = obj(&call[1]);
                options.shift_remove("originGeneration");
                json!([call[0], options])
            })
            .collect();
        assert_eq!(got, Value::Array(want), "case {i}: {} over {}", case["request"], case["selected"]);
    }
}

struct Rig {
    service: RouteSetService,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

/// One op store for every case of a test. Each case sends its own op id, so no case answers from
/// another's record; opening a `core.sqlite` per case was half of each case's time.
struct Ops {
    scopes: OpScopes,
    _state: tempfile::TempDir,
}

async fn ops() -> Ops {
    let state = tempfile::tempdir().unwrap();
    Ops { scopes: scopes(state.path(), "route").await, _state: state }
}

/// The op id of case `i` of a test.
fn op_of(i: usize) -> u64 {
    i as u64 + 1
}

/// The service over the route-service rig of `case`, and an agent route setter over its config
/// with the agent recording `agent_case`.
async fn build(case: &Value, agent_case: &Value, ops: &Ops) -> Rig {
    let (routes, _writer, _log, dir) = rig(case).await;
    let agents_dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = agents_dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&mixdog_core_config::config::agent_routes::stored_file_of(&agent_case["config"])).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentRouteSetter {
        routes: AgentRoutes::new(config.clone(), agents_dir.path()),
        config: config.clone(),
        context: Arc::new(Facts { case: agent_case.clone(), config }),
        publisher: Arc::new(Published::default()),
        hidden: hidden_agents(),
    };
    Rig { service: RouteSetService { routes: Arc::new(routes), agents: Arc::new(agents), ops: ops.scopes.clone() }, _dirs: (dir, agents_dir) }
}

fn message(error: mixdog_core_api::error::CoreError) -> String {
    match error {
        mixdog_core_api::error::CoreError::DomainError { code: None, message: Some(message), .. } => message.to_string(),
        other => panic!("{other:?}"),
    }
}

/// A recorded `setRoute` the wire can send: no validate-only, and a selection the wire leaves as it is.
fn route_cases() -> Vec<Value> {
    route_twin()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "setRoute" && c["options"]["validateOnly"] != json!(true) && c["options"]["sessionOnly"] != json!(true))
        .cloned()
        .collect()
}

#[tokio::test]
async fn route_set_for_a_thread_answers_what_set_route_answers() {
    let agent_case = admin_twin()["agentCases"][0].clone();
    let ops = ops().await;
    for (i, case) in route_cases().iter().enumerate() {
        let rig = build(case, &agent_case, &ops).await;
        let mut route = obj(&case["request"]);
        for key in ["keepMainModel", "onlyIfEmpty"] {
            if let Some(flag) = case["options"].get(key) {
                route.insert(key.into(), flag.clone());
            }
        }
        let params = json!({ "threadId": "t", "route": route });
        let got = value(&rig.service, request(ROUTE_SET, with_op(params, op_of(i)), Some(op_of(i)))).await;
        let label = format!("case {i}: {} {}", case["request"], case["options"]);
        match case.get("error") {
            Some(error) => assert_eq!(message(got.unwrap_err()), error.as_str().unwrap(), "{label}"),
            None => assert_eq!(got.unwrap(), case["value"], "{label}"),
        }
    }
}

#[tokio::test]
async fn a_request_naming_no_thread_writes_the_route_before_any_session() {
    let case = route_cases().into_iter().find(|c| c.get("error").is_none()).unwrap();
    let rig = build(&case, &admin_twin()["agentCases"][0], &ops().await).await;
    let params = with_op(json!({ "route": case["request"] }), 1);
    let got = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.unwrap();
    assert_eq!(got, case["value"]);
    let live = rig.service.routes.writer.route(&ThreadId::from(PRE_SESSION));
    assert_eq!(Value::Object(live), case["after"]["route"]);
}

/// The desktop's `setAgentRoute` called with no session reaches the core addressed to its control thread. Node's real
/// `createAgentRouteApi` (`fixtures/control-session-actions`, recorded at the Node commit the manifest names) answers the
/// agent's route, never the thread's.
#[tokio::test]
async fn route_set_for_an_agent_from_a_thread_answers_the_agents_route() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/control-session-actions/golden.json")).unwrap();
    let route_case = route_cases().remove(0);
    let cases = golden["agentRoutes"].as_array().unwrap();
    assert!(!cases.is_empty());
    let ops = ops().await;
    for (i, case) in cases.iter().enumerate() {
        let rig = build(&route_case, case, &ops).await;
        let thread = ThreadId::from("control");
        let route_before = rig.service.routes.writer.route(&thread);
        let params = json!({ "threadId": "control", "agentId": case["agentId"], "route": case["request"] });
        let got = value(&rig.service, request(ROUTE_SET, with_op(params, op_of(i)), Some(op_of(i)))).await;
        let label = format!("agent case {i}: {} {}", case["agentId"], case["request"]);
        match case.get("error") {
            Some(error) => assert_eq!(message(got.unwrap_err()), error.as_str().unwrap(), "{label}"),
            None => assert_eq!(got.unwrap(), case["value"], "{label}"),
        }
        assert_eq!(rig.service.routes.writer.route(&thread), route_before, "{label}: the thread's own route is left as it was");
    }
}

#[tokio::test]
async fn route_set_for_an_agent_answers_what_set_agent_route_answers() {
    let route_case = route_cases().remove(0);
    let ops = ops().await;
    for (i, case) in admin_twin()["agentCases"].as_array().unwrap().iter().enumerate() {
        let rig = build(&route_case, case, &ops).await;
        let params = json!({ "agentId": case["agentId"], "route": case["request"] });
        let got = value(&rig.service, request(ROUTE_SET, with_op(params, op_of(i)), Some(op_of(i)))).await;
        let label = format!("agent case {i}: {} {}", case["agentId"], case["request"]);
        match case.get("error") {
            Some(error) => assert_eq!(message(got.unwrap_err()), error.as_str().unwrap(), "{label}"),
            None => assert_eq!(got.unwrap(), case["value"], "{label}"),
        }
    }
}

#[tokio::test]
async fn fast_set_answers_whether_fast_is_on() {
    let agent_case = admin_twin()["agentCases"][0].clone();
    let cases: Vec<Value> = route_twin()["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "setFast" && !c["setFastValue"].is_string()).cloned().collect();
    assert!(!cases.is_empty());
    let ops = ops().await;
    for (i, case) in cases.iter().enumerate() {
        let rig = build(case, &agent_case, &ops).await;
        let params = json!({ "threadId": "t", "on": case["setFastValue"] == json!(true) });
        let got = value(&rig.service, request(FAST_SET, with_op(params, op_of(i)), Some(op_of(i)))).await;
        let label = format!("fast case {i}: {}", case["setFastValue"]);
        match case.get("error") {
            Some(error) => assert_eq!(message(got.unwrap_err()), error.as_str().unwrap(), "{label}"),
            None => assert_eq!(got.unwrap(), case["value"], "{label}"),
        }
    }
}

#[tokio::test]
async fn a_duplicate_op_answers_the_recorded_outcome() {
    let case = route_cases().into_iter().find(|c| c.get("error").is_none()).unwrap();
    let rig = build(&case, &admin_twin()["agentCases"][0], &ops().await).await;
    let params = with_op(json!({ "threadId": "t", "route": case["request"] }), 1);
    let first = value(&rig.service, request(ROUTE_SET, params.clone(), Some(1))).await.unwrap();
    let second = value(&rig.service, request(ROUTE_SET, params, Some(1))).await.unwrap();
    assert_eq!(first, second);
}
