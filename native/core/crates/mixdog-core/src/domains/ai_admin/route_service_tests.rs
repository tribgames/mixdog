//! The route service against the Node recording (`fixtures/ai-admin/route-service-twin.json`):
//! the adoption effects of `setRoute`, `setFast` and `setEffort` over the real `Config` file, with a
//! scripted catalog and recording route, refresh and session ports. What the session does with an
//! adopted route is `SessionRoutes`' (its own tests); here the exact `follow` / `tune` calls are
//! asserted.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{Obj, ensure_provider_enabled, window_meta_of};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::chain::RouteFacts;
use super::route_service::{FastValue, RouteService, SessionFollow, SetRouteOptions};
use crate::config::{Config, ConfigLanes};
use crate::ports::route::{FollowOptions, Followed, Route};
use crate::ports::route_write::RouteWriter;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/route-service-twin.json")).unwrap()
}

const KNOWN: [&str; 5] = ["openai", "openai-oauth", "anthropic", "anthropic-oauth", "gemini"];

#[derive(Default)]
struct Log {
    ensured: Vec<Value>,
    route_states: Vec<Value>,
    refreshes: Vec<Value>,
    statusline: u32,
    follows: Vec<FollowOptions>,
    tunes: u32,
}

struct Facts {
    case: Value,
    log: Arc<Mutex<Log>>,
}

#[async_trait]
impl RouteFacts for Facts {
    fn is_known(&self, provider: &str, _: &Obj) -> bool {
        KNOWN.contains(&provider.trim())
    }

    async fn ensure_ready(&self, config: &Obj, provider: &str) -> Result<(), String> {
        let keys: Vec<Value> = ensure_provider_enabled(config, provider).keys().map(|k| Value::from(k.as_str())).collect();
        self.log.lock().unwrap().ensured.push(Value::Array(keys));
        Ok(())
    }

    fn model_meta(&self, _: &str, _: &str) -> Value {
        self.case["meta"].clone()
    }

    fn window_meta(&self, _: &str, _: &str, meta: &Value) -> Option<Value> {
        window_meta_of(Some(meta), None).cloned()
    }

    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.case["knows"][format!("{provider}/{model}")].as_bool().unwrap_or(false)
    }

    fn fast_capable(&self, provider: &str, _: &Value, _: Option<&str>, _: &Value) -> bool {
        self.case["fastTable"][provider].as_bool().unwrap_or(false)
    }

    fn ultrafast_capable(&self, provider: &str, _: &Value) -> bool {
        self.case["ultraTable"][provider].as_bool().unwrap_or(false)
    }
}

struct Writer {
    route: Mutex<Route>,
    log: Arc<Mutex<Log>>,
}

#[async_trait]
impl RouteWriter for Writer {
    fn route(&self, _: &ThreadId) -> Route {
        self.route.lock().unwrap().clone()
    }

    fn set_route_state(&self, _: &ThreadId, route: Route) {
        self.log.lock().unwrap().route_states.push(Value::Object(route.clone()));
        *self.route.lock().unwrap() = route;
    }

    fn generation(&self, _: &ThreadId) -> u64 {
        0
    }

    async fn refresh_route_effort(&self, _: &ThreadId, meta: Option<Value>, guard_supersede: bool, lease: Option<u64>) -> Result<Option<Route>, PortError> {
        self.log.lock().unwrap().refreshes.push(json!({ "meta": meta, "expectedIsLive": guard_supersede, "lease": lease }));
        Ok(None)
    }

    fn refresh_statusline_usage(&self, _: &ThreadId, _: &Route) {
        self.log.lock().unwrap().statusline += 1;
    }
}

struct Session {
    log: Arc<Mutex<Log>>,
}

#[async_trait]
impl SessionFollow for Session {
    fn open_lease(&self, _: &ThreadId, origin: Option<u64>) -> u64 {
        origin.unwrap_or(0)
    }

    async fn follow(&self, _: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError> {
        self.log.lock().unwrap().follows.push(options.clone());
        Ok(Followed::default())
    }

    async fn tune(&self, _: &ThreadId) -> Result<(), PortError> {
        self.log.lock().unwrap().tunes += 1;
        Ok(())
    }
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

fn subset(doc: &Obj) -> Value {
    Value::Object(["default", "presets", "modelSettings"].iter().filter_map(|k| doc.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect())
}

async fn rig(case: &Value) -> (RouteService, Arc<Writer>, Arc<Mutex<Log>>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["config"] })).unwrap()).unwrap();
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    if !case["fileOverride"].is_null() {
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": case["fileOverride"] })).unwrap()).unwrap();
    }
    let log = Arc::new(Mutex::new(Log::default()));
    let writer = Arc::new(Writer { route: Mutex::new(obj(&case["live"])), log: log.clone() });
    let service = RouteService {
        config,
        facts: Arc::new(Facts { case: case.clone(), log: log.clone() }),
        writer: writer.clone(),
        session: Arc::new(Session { log: log.clone() }),
    };
    (service, writer, log, dir)
}

fn options(case: &Value) -> SetRouteOptions {
    let o = &case["options"];
    SetRouteOptions {
        keep_main_model: o.get("keepMainModel").and_then(Value::as_bool),
        only_if_empty: o["onlyIfEmpty"] == json!(true),
        session_only: o["sessionOnly"] == json!(true),
        validate_only: o["validateOnly"] == json!(true),
        follow: FollowOptions::default(),
    }
}

#[tokio::test]
async fn the_adoption_effects_match_node() {
    let thread = ThreadId::from("t");
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let (service, writer, log, dir) = rig(case).await;
        let got = match case["kind"].as_str().unwrap() {
            "setRoute" => service.set_route(&thread, &obj(&case["request"]), &options(case)).await,
            "setFast" => {
                let value = match &case["setFastValue"] {
                    Value::String(_) => FastValue::Ultrafast,
                    Value::Bool(true) => FastValue::On,
                    _ => FastValue::Off,
                };
                service.set_fast(&thread, value).await.map(Value::Bool)
            }
            _ => service.set_effort(&thread, &case["effortValue"], false).await,
        };
        let got = match got {
            Ok(v) => json!({ "value": v }),
            Err(e) => json!({ "error": e }),
        };
        let want = match case.get("error") {
            Some(e) => json!({ "error": e }),
            None => json!({ "value": case["value"] }),
        };
        let label = format!("case {i}: {} {} {}", case["kind"], case["request"], case["options"]);
        assert_eq!(got, want, "{label}");
        assert_eq!(Value::Object(writer.route(&thread)), case["after"]["route"], "{label} route");
        let on_disk: Value = serde_json::from_slice(&std::fs::read(dir.path().join("mixdog-config.json")).unwrap()).unwrap();
        assert_eq!(subset(&obj(&on_disk["agent"])), case["after"]["file"], "{label} saved config");
        let log = log.lock().unwrap();
        assert_eq!(Value::Array(log.route_states.clone()), case["log"]["routeStates"], "{label} route states");
        assert_eq!(Value::Array(log.refreshes.clone()), case["log"]["refreshes"], "{label} refreshes");
        assert_eq!(Value::Array(log.ensured.clone()), case["log"]["ensured"], "{label} ensured");
        assert_eq!(log.statusline as u64, case["log"]["statusline"].as_u64().unwrap(), "{label} statusline");
        // The session half: an adopted unaddressed selection follows once; a tuning tunes once.
        let adopted = got["value"].is_object() && !options(case).validate_only && case["kind"] == "setRoute" && !log.refreshes.is_empty();
        assert_eq!(log.follows.len(), usize::from(adopted), "{label} follows");
        assert_eq!(log.tunes, u32::from(case["kind"] != "setRoute" && got.get("value").is_some()), "{label} tunes");
    }
}

#[tokio::test]
async fn an_addressed_selection_follows_under_the_lease_it_was_opened_with() {
    let case = twin()["cases"].as_array().unwrap().iter().find(|c| c["kind"] == "setRoute" && c.get("error").is_none() && c["options"] == json!({}) && c["request"]["model"].is_string()).unwrap().clone();
    let thread = ThreadId::from("t");
    let (service, _writer, log, _dir) = rig(&case).await;
    let opts = SetRouteOptions {
        follow: FollowOptions { switch_established: true, defer_until_next_turn: false, apply_to_current_session: false, lease: Some(0) },
        ..SetRouteOptions::default()
    };
    service.set_route(&thread, &obj(&case["request"]), &opts).await.unwrap();
    let follows = log.lock().unwrap().follows.clone();
    assert_eq!(follows.len(), 1);
    assert!(follows[0].switch_established && follows[0].lease == Some(0));
}
