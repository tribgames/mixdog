use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::call::{owner_key, remote_session_id_from_binding};
use super::tools::{ACTIVATE_TOOL, error_result, text_result};
use super::*;
use crate::scheduler::ScheduleError;

#[derive(Default)]
struct Echo {
    calls: AtomicUsize,
    gate: Option<Arc<Notify>>,
    soft_error: Mutex<bool>,
}

#[async_trait]
impl ChannelCallHandler for Echo {
    async fn call(&self, name: &str, args: &Value, _c: &ChannelClient) -> Result<Value, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let (Some(gate), Some("slow")) = (&self.gate, args["mode"].as_str()) {
            gate.notified().await;
        }
        if *self.soft_error.lock().unwrap() {
            return Ok(error_result("nope"));
        }
        Ok(text_result(format!("{name}:{}", args["n"])))
    }
}

fn client(token: &str, pid: Option<u32>) -> ChannelClient {
    ChannelClient { token: token.into(), lead_pid: pid }
}

fn req(name: &str, args: Value, call_id: Option<&str>) -> CallRequest {
    CallRequest { name: name.into(), args, call_id: call_id.map(String::from) }
}

fn dispatch(handler: Echo) -> (Arc<CallDispatch>, Arc<Echo>, RunningWork) {
    let handler = Arc::new(handler);
    let work = RunningWork::new();
    (CallDispatch::with_ttl(handler.clone(), work.clone(), Duration::from_secs(60)), handler, work)
}

#[tokio::test]
async fn retried_call_id_runs_once_and_conflicting_payload_is_refused() {
    let (d, h, _) = dispatch(Echo::default());
    let a = d.dispatch(client("t1", Some(7)), req("reply", json!({"n":1}), Some("c1"))).await.unwrap();
    // The same process reconnected under a new token keeps its retry identity.
    let b = d.dispatch(client("t2", Some(7)), req("reply", json!({"n":1}), Some("c1"))).await.unwrap();
    assert_eq!(a, b);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let conflict = d.dispatch(client("t1", Some(7)), req("reply", json!({"n":2}), Some("c1"))).await;
    assert_eq!(conflict, Err(CallError::CallIdConflict("c1".into())));
    assert_eq!(conflict.unwrap_err().code(), Some("ECALLIDCONFLICT"));
    // Without a callId every call runs.
    d.dispatch(client("t1", None), req("reply", json!({"n":1}), None)).await.unwrap();
    d.dispatch(client("t1", None), req("reply", json!({"n":1}), None)).await.unwrap();
    assert_eq!(h.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn cache_entry_expires_a_ttl_after_the_call_settles() {
    let (d, h, _) = dispatch(Echo::default());
    d.dispatch(client("t", None), req("reply", json!({"n":1}), Some("c"))).await.unwrap();
    assert_eq!(d.cached_calls(), 1);
    tokio::time::sleep(Duration::from_secs(61)).await;
    assert_eq!(d.cached_calls(), 0);
    d.dispatch(client("t", None), req("reply", json!({"n":1}), Some("c"))).await.unwrap();
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_slow_call_never_blocks_another_clients_call_and_counts_as_work() {
    let gate = Arc::new(Notify::new());
    let (d, h, work) = dispatch(Echo { gate: Some(gate.clone()), ..Default::default() });
    let slow = tokio::spawn({
        let d = d.clone();
        async move { d.dispatch(client("a", None), req("reply", json!({"mode":"slow"}), None)).await }
    });
    while h.calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(work.count(), 1);
    d.dispatch(client("b", None), req("reply", json!({"n":1}), None)).await.unwrap();
    gate.notify_one();
    slow.await.unwrap().unwrap();
    assert!(work.is_idle());
}

#[tokio::test]
async fn binding_claims_need_a_named_session_and_release_needs_the_pin() {
    let (d, _, _) = dispatch(Echo::default());
    let c = client("t", None);
    let claim = d.dispatch(c.clone(), req(ACTIVATE_TOOL, json!({"active":true}), None)).await.unwrap();
    assert_eq!(claim["claimSkipped"], true);
    let release = d.dispatch(c.clone(), req(ACTIVATE_TOOL, json!({"active":false,"sessionId":"s1"}), None)).await.unwrap();
    assert_eq!(release["releaseSkipped"], true);
    d.dispatch(c.clone(), req(ACTIVATE_TOOL, json!({"active":true,"sessionId":"s1"}), None)).await.unwrap();
    let off = d.dispatch(c.clone(), req(ACTIVATE_TOOL, json!({"active":false,"sessionId":"s1"}), None)).await.unwrap();
    assert!(off.get("releaseSkipped").is_none());
    let again = d.dispatch(c, req(ACTIVATE_TOOL, json!({"active":false,"sessionId":"s1"}), None)).await.unwrap();
    assert_eq!(again["releaseSkipped"], true);
}

#[tokio::test]
async fn a_soft_error_leaves_the_binding_unchanged() {
    let (d, h, _) = dispatch(Echo::default());
    *h.soft_error.lock().unwrap() = true;
    let c = client("t", None);
    d.dispatch(c.clone(), req(ACTIVATE_TOOL, json!({"active":true,"sessionId":"s1"}), None)).await.unwrap();
    *h.soft_error.lock().unwrap() = false;
    let release = d.dispatch(c, req(ACTIVATE_TOOL, json!({"active":false,"sessionId":"s1"}), None)).await.unwrap();
    assert_eq!(release["releaseSkipped"], true);
}

#[test]
fn owner_keys_and_binding_session_ids() {
    let c = client("tok", Some(9));
    assert_eq!(owner_key(&c, &req("x", json!({"sessionId":"s"}), None)), "session:s");
    assert_eq!(owner_key(&c, &req("x", json!({}), None)), "pid:9");
    assert_eq!(owner_key(&client("tok", None), &req("x", json!({}), None)), "client:tok");
    assert_eq!(
        owner_key(&c, &req(ACTIVATE_TOOL, json!({"transcriptPath":"C:\\a\\b\\sess-1.jsonl"}), None)),
        "session:sess-1"
    );
    assert_eq!(remote_session_id_from_binding("reply", &json!({"sessionId":"s"})), None);
    assert_eq!(remote_session_id_from_binding(ACTIVATE_TOOL, &json!({"sessionId":"bad id"})), None);
}

struct Lifecycle {
    active: Mutex<bool>,
    stops: AtomicUsize,
}

#[async_trait]
impl ChannelLifecycle for Lifecycle {
    fn bridge_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
    async fn set_bridge_active(&self, active: bool) {
        *self.active.lock().unwrap() = active;
    }
    async fn start_bridge(&self) -> Result<(), String> {
        Err("refresh failed".into())
    }
    async fn stop_owned_runtime(&self, _reason: &str) -> Result<(), String> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn reload_config(&self) -> Result<String, String> {
        Ok(", agent providers/presets/maintenance".into())
    }
    async fn rename_schedule(&self, name: &str, _def: &Value, _t: bool) -> Result<Value, ScheduleError> {
        match name {
            "busy" => Err(ScheduleError::RenameRunning { name: "busy".into() }),
            "dup" => Err(ScheduleError::NameTaken { name: "dup".into() }),
            _ => Ok(json!({"name":"renamed"})),
        }
    }
}

#[tokio::test]
async fn tool_dispatch_matches_the_lifecycle_tool_contract() {
    let life = Arc::new(Lifecycle { active: Mutex::new(false), stops: AtomicUsize::new(0) });
    let work = RunningWork::new();
    let degraded = Arc::new(Mutex::new(false));
    let probe = degraded.clone();
    let t = ToolDispatch::new(life.clone(), work.clone(), Box::new(move || *probe.lock().unwrap()));

    let on = t.handle_tool_call(ACTIVATE_TOOL, &json!({"active":true})).await;
    assert_eq!(on, text_result("channel bridge activated"));
    assert_eq!(work.count(), 1); // an active bridge keeps the core alive; start failure is non-fatal
    let off = t.handle_tool_call(ACTIVATE_TOOL, &json!({"active":false})).await;
    assert_eq!(off, text_result("channel bridge deactivated"));
    assert!(work.is_idle());
    assert_eq!(life.stops.load(Ordering::SeqCst), 1);

    assert_eq!(
        t.handle_tool_call("reload_config", &json!({})).await,
        text_result("config reloaded — schedules, webhooks, events, agent providers/presets/maintenance re-registered")
    );
    assert_eq!(t.handle_tool_call("rename_schedule", &json!({"name":"ok","def":{}})).await, text_result(r#"{"name":"renamed"}"#));
    let busy = t.handle_tool_call("rename_schedule", &json!({"name":"busy"})).await;
    assert_eq!(busy["isError"], true);
    assert_eq!(busy["code"], "SCHEDULE_RENAME_RUNNING");
    assert_eq!(busy["details"], json!({"name":"busy"}));
    assert_eq!(t.handle_tool_call("memory", &json!({})).await, error_result("unknown tool: memory"));

    *degraded.lock().unwrap() = true;
    assert_eq!(
        t.handle_tool_call("reload_config", &json!({})).await,
        error_result("[channels degraded] reload_config unavailable — restart MCP to recover")
    );
}
