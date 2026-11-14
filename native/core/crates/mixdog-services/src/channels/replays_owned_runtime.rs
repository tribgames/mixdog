//! Replay of `native/core/fixtures/channels-owned-runtime` (Node `owned-runtime.test.mjs`): the owned-runtime
//! lifecycle through `ChannelRuntime` (`start_bridge` reached through the `activate_channel_bridge` call a client
//! makes, `stop_owned_runtime`, `start_automation`, `reload_runtime`), one test per recorded case.
//!
//! How each recorded call is compared:
//! - `initProviders` ↔ `AgentRuntime::init_providers` (recording agent). `agent.loadConfig` is the first half of Node's
//!   `initAgentProviders` (`automation-start.mjs:9-11`) and must come right before it; the Rust port loads the agent
//!   config inside `init_providers`.
//! - `scheduler.start` / `scheduler.stop` / `scheduler.reload(schedules, {restart})` ↔ the same `Scheduler` calls, written
//!   by its test-only call log (`Scheduler::record_calls`). `loadConfig` is the channel config load of Node's reload
//!   (`config-reload.mjs:30`) and must come right before `scheduler.reload`, which gets the loaded schedules; Rust reads
//!   the stores in `reload_runtime` before the same call.
//! - The webhook receiver is the product's own `WebhookAutomation` (`AutomationServices`, what `compose_flip.rs` builds) over
//!   a real `WebhookService`, with recording settings and listener behind it. The calls compared are the ones that
//!   `WebhookAutomation` itself makes on the listener, with the arguments it passes: `listener.start(settings)` ↔ the
//!   recorded `webhook.start` of a receiver Node just made (`webhook.new {enabled}`, whose argument must equal the
//!   `enabled` the product started the listener with), `listener.stop()` ↔ `webhook.stop` (the listener records a stop only
//!   while it listens, as the real listener ends nothing otherwise). Declared in the manifest, with no counterpart: the
//!   event pipeline (`pipeline.*`, `wire.*`, `state.eventPipeline`: `WebhookAutomation` has none), `webhook.reload` and a
//!   `webhook.start` of a receiver that already listens (Node's `start` returns at once then, `listener-lifecycle.mjs:15`;
//!   the product keeps a listener whose port is unchanged, `ports.rs` `sync_turn`). The state's `webhookServer` is whether
//!   the listener listens.
//! - `notify('notifications/mixdog/remote', {state:'acquired'})` is Node's hop from its channels worker to the daemon
//!   (`owned-start.mjs:56`, `owned-runtime.mjs:20`). The daemon turns it into the remote state a client sees
//!   (`remote-pointer.mjs` `acquireRemoteState`: `remoteAcquired`, `publishRemoteState`, the sticky badge frame). In the
//!   core both are one process; the client event is `hostState` key `remoteSession`, published by the binding observer
//!   of `CallDispatch` (`channels/call.rs` `binding_changed`, wired at `compose_flip.rs` `publish_remote_session`). The
//!   replay records that observer: `(enabled, session)` ↔ `["remote", "acquired"]` for an enabled binding.
//!   Where: Node's daemon shows Remote acquired as the worker notifies, before `initProviders` and the arming: it sets
//!   `remoteAcquired`, publishes the state and writes the `acquired` badge frame to the control client the ON call
//!   pointed at (`call-dispatch.mjs:88-90` `movePointer`). The core publishes its client event at the same point, in
//!   order with the bridge's other calls; an unchanged binding is not re-published (`remote-state.mjs` signature).
//!   Content: the call's session. Node's derived state at that instant reads `String(null)` = `"null"` as the session
//!   on a fresh daemon (`remote-state.mjs:17`, `pinnedSessionId` is written only as the call settles) — a Node bug.
//! - Node-only, declared in the manifest: `advert`, `advert.clear`, `locks.release`, `snapshot.start`, `snapshot.stop`,
//!   `ownership` (the advert/lock files, the status snapshot writer and the ownership log have no Rust counterpart).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::bridge::BridgeCalls;
use super::call::{CallDispatch, CallRequest, ChannelClient};
use super::ports::{
    AgentRuntime, ChannelSettings, WebhookAutomation, WebhookListener, WebhookPatch, WebhookSettings,
};
use super::running::RunningWork;
use super::runtime::ChannelRuntime;
use super::tools::{ACTIVATE_TOOL, ChannelLifecycle, ToolDispatch};
use crate::memory::replays::{assert_case_count, case, golden, same};
use crate::scheduler::{MemoryScheduleStore, RunOutcome, Schedule, ScheduleRunner, Scheduler, SystemClock};
use crate::webhooks::{Claim, Endpoint, Headers, HttpReply, WebhookConfig, WebhookDispatch, WebhookService, WebhookStore};

const SET: &str = "channels-owned-runtime";
const DEADLINE: Duration = Duration::from_secs(15);
/// The session the activating client names.
const SESSION: &str = "s-1";

type Log = Arc<Mutex<Vec<Value>>>;

struct NoRuns;

#[async_trait]
impl ScheduleRunner for NoRuns {
    async fn run(&self, schedule: &Schedule, _prompt: &str) -> Result<RunOutcome, String> {
        panic!("no schedule is loaded, yet {} fired", schedule.name)
    }
}

/// `initProviders`, optionally held until released.
struct Agent {
    log: Log,
    hold: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    entered: tokio::sync::Notify,
}

#[async_trait]
impl AgentRuntime for Agent {
    async fn init_providers(&self) -> Result<(), String> {
        self.log.lock().unwrap().push(json!(["initProviders"]));
        self.entered.notify_one();
        let hold = self.hold.lock().unwrap().clone();
        if let Some(hold) = hold {
            hold.acquire().await.expect("the hold stays open").forget();
        }
        Ok(())
    }
}

/// The receiver's settings as the recording's receiver had them: the defaults, enabled.
struct Settings;

#[async_trait]
impl ChannelSettings for Settings {
    async fn webhook(&self) -> Result<WebhookSettings, String> {
        Ok(WebhookSettings { enabled: Some(true), ..WebhookSettings::default() })
    }
    async fn update_webhook(&self, _patch: &WebhookPatch) -> Result<WebhookSettings, String> {
        unreachable!("no recorded step changes the webhook settings")
    }
    async fn webhook_config(&self) -> Result<WebhookConfig, String> {
        Ok(WebhookConfig::default())
    }
}

/// The receiver's store and dispatch: nothing reaches them, no request arrives.
struct NoDeliveries;

#[async_trait]
impl WebhookStore for NoDeliveries {
    async fn load_endpoint(&self, _name: &str) -> Result<Option<Endpoint>, String> {
        unreachable!("no request reaches the receiver")
    }
    async fn read_secret(&self, _name: &str) -> Result<Option<String>, String> {
        unreachable!("no request reaches the receiver")
    }
    async fn claim_delivery(&self, _endpoint: &str, _id: &str, _claim: Claim<'_>) -> Result<bool, String> {
        unreachable!("no request reaches the receiver")
    }
    async fn update_delivery_status(&self, _endpoint: &str, _id: &str, _status: &str, _error: Option<&str>) -> Result<(), String> {
        unreachable!("no request reaches the receiver")
    }
}

#[async_trait]
impl WebhookDispatch for NoDeliveries {
    async fn handle(&self, _name: &str, _payload: Value, _headers: &Headers, _id: &str, _in_table: bool) -> Result<HttpReply, String> {
        unreachable!("no request reaches the receiver")
    }
}

/// The listener `WebhookAutomation` starts and stops: it writes each call the automation makes on it, with the settings it was
/// given. A start fails with the text a case sets (the recorder's webhook start throws); a listener whose start failed does not listen.
struct Listener {
    log: Log,
    listening: AtomicBool,
    fails: Mutex<Option<String>>,
}

#[async_trait]
impl WebhookListener for Listener {
    async fn start(&self, settings: &WebhookSettings) -> Result<(), String> {
        self.log.lock().unwrap().push(json!(["webhook.start", {"enabled": settings.enabled}]));
        match self.fails.lock().unwrap().take() {
            Some(error) => Err(error),
            None => {
                self.listening.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
    }
    async fn stop(&self) -> Result<(), String> {
        if self.listening.swap(false, Ordering::SeqCst) {
            self.log.lock().unwrap().push(json!(["webhook.stop"]));
        }
        Ok(())
    }
}

struct Rig {
    runtime: Arc<ChannelRuntime>,
    calls: Arc<CallDispatch>,
    agent: Arc<Agent>,
    listener: Arc<Listener>,
    log: Log,
}

fn rig() -> Rig {
    let log: Log = Arc::default();
    let store = Arc::new(MemoryScheduleStore::default());
    let work = RunningWork::new();
    let scheduler = Scheduler::new(store.clone(), Arc::new(NoRuns), Arc::new(SystemClock), work.clone(), chrono_tz::Tz::UTC, Vec::new());
    scheduler.record_calls(log.clone());
    let agent = Arc::new(Agent { log: log.clone(), hold: Mutex::new(None), entered: tokio::sync::Notify::new() });
    let listener = Arc::new(Listener { log: log.clone(), listening: AtomicBool::new(false), fails: Mutex::new(None) });
    let service = Arc::new(WebhookService::new(Arc::new(NoDeliveries), Arc::new(NoDeliveries), WebhookConfig::default(), work.clone(), Arc::new(|| 0)));
    let automation = Arc::new(WebhookAutomation::new(Arc::new(Settings), service, listener.clone()));
    let runtime = ChannelRuntime::new(scheduler, store, automation, agent.clone());
    let calls = CallDispatch::new(Arc::new(BridgeCalls::new(ToolDispatch::new(runtime.clone(), work.clone(), Box::new(|| false)))), work);
    calls.hear_bridge(&runtime);
    let observed = log.clone();
    calls.observe_binding(Arc::new(move |remote| {
        observed.lock().unwrap().push(json!(["remote", if remote.acquired { "acquired" } else { "released" }, remote.pinned_session_id]));
    }));
    // The registration reports the binding as it stands (none): not a change.
    log.lock().unwrap().clear();
    Rig { runtime, calls, agent, listener, log }
}

impl Rig {
    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }

    /// `startOwnedRuntime` as a client reaches it: the manual ON call (`activate_channel_bridge`).
    async fn activate(&self) {
        let reply = self.calls.dispatch(client(), activate_request()).await.expect("the activation call answers");
        assert_eq!(reply, json!({"content": [{"type": "text", "text": "channel bridge activated"}]}), "activation reply");
    }

    fn hold_init(&self) -> Arc<tokio::sync::Semaphore> {
        let hold = Arc::new(tokio::sync::Semaphore::new(0));
        *self.agent.hold.lock().unwrap() = Some(hold.clone());
        hold
    }

    async fn init_entered(&self) {
        tokio::time::timeout(DEADLINE, self.agent.entered.notified()).await.expect("initProviders was not entered within 15 s");
    }

    fn state(&self) -> Exact {
        let webhook_server = if self.listener.listening.load(Ordering::SeqCst) { Exact::String("FakeWebhookServer".into()) } else { Exact::Null };
        Exact::Object(vec![("connected".into(), Exact::Bool(self.runtime.bridge_connected())), ("webhookServer".into(), webhook_server)])
    }
}

fn client() -> ChannelClient {
    ChannelClient { token: "client-1".into(), lead_pid: Some(42) }
}

fn activate_request() -> CallRequest {
    CallRequest { name: ACTIVATE_TOOL.into(), args: json!({"active": true, "sessionId": SESSION}), call_id: None }
}

/// `notifyRemoteAcquired` is called from `activateBridge` as the bridge connects (owned-start.mjs:52-56), before the
/// providers' init and the arming: an activation call refused before the bridge connects announces nothing. What is
/// announced stays announced when the arming fails afterwards (the recorded case 7).
#[tokio::test]
async fn an_activation_call_refused_before_the_bridge_connects_announces_nothing() {
    struct Failing;
    #[async_trait]
    impl super::call::ChannelCallHandler for Failing {
        async fn call(&self, _name: &str, _args: &Value, _client: &ChannelClient) -> Result<Value, String> {
            Err("bridge start failed".into())
        }
    }
    let calls = CallDispatch::new(Arc::new(Failing), RunningWork::new());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    calls.observe_binding(Arc::new(move |remote| sink.lock().unwrap().push((remote.acquired, remote.pinned_session_id.map(str::to_owned)))));
    let answered = within("the failed activation", calls.dispatch(client(), activate_request())).await;
    assert!(answered.is_err(), "the activation failed: {answered:?}");
    assert_eq!(seen.lock().unwrap().clone(), [(false, None)], "only the binding at registration was announced");
}

async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{what} did not settle within 15 s"))
}

const NODE_ONLY: [&str; 6] = ["advert", "advert.clear", "locks.release", "snapshot.start", "snapshot.stop", "ownership"];
/// Recorded calls with no counterpart in `WebhookAutomation` (see the header); `webhook.new` and `webhook.start` are handled apart.
const NO_COUNTERPART: [&str; 7] = ["pipeline.new", "pipeline.reload", "pipeline.start", "pipeline.stop", "wire.events", "wire.webhook", "webhook.reload"];

/// One step's recorded calls in the vocabulary of the Rust ports (see the header).
fn expected(calls: &Exact) -> Vec<Value> {
    let calls: Vec<Value> = calls.as_array().iter().map(|c| c.to_plain().expect("a plain call")).collect();
    let name = |i: usize| calls.get(i).and_then(|c| c[0].as_str()).unwrap_or_default().to_owned();
    let mut out = Vec::new();
    // The `enabled` of the receiver Node made in this step and has not started yet.
    let mut made: Option<Value> = None;
    let mut i = 0;
    while i < calls.len() {
        let call = &calls[i];
        let n = name(i);
        match n.as_str() {
            n if NODE_ONLY.contains(&n) => i += 1,
            "agent.loadConfig" => {
                assert_eq!(name(i + 1), "initProviders", "agent.loadConfig is followed by initProviders");
                i += 1;
            }
            "loadConfig" => {
                assert_eq!(name(i + 1), "scheduler.reload", "loadConfig is followed by scheduler.reload");
                i += 1;
            }
            "initProviders" => {
                assert_eq!(call, &json!(["initProviders", {}]), "initProviders gets the agent's providers");
                out.push(json!(["initProviders"]));
                i += 1;
            }
            "scheduler.start" | "scheduler.stop" | "scheduler.reload" => {
                out.push(call.clone());
                i += 1;
            }
            "notify" => {
                assert_eq!(call, &json!(["notify", "notifications/mixdog/remote", {"state": "acquired"}]), "the remote notification");
                out.push(json!(["remote", "acquired", SESSION]));
                i += 1;
            }
            "webhook.new" => {
                made = Some(call[1]["enabled"].clone());
                i += 1;
            }
            // A receiver Node just made starts its listener; one that already listens is not started again.
            "webhook.start" => {
                if let Some(enabled) = made.take() {
                    out.push(json!(["webhook.start", {"enabled": enabled}]));
                }
                i += 1;
            }
            "webhook.stop" => {
                out.push(call.clone());
                i += 1;
            }
            n if NO_COUNTERPART.contains(&n) => i += 1,
            other => panic!("a recorded call with no Rust counterpart: {other} {call}"),
        }
    }
    out
}

#[track_caller]
fn step(case: &Exact, index: usize, actual: Vec<Value>) {
    let expected = expected(&case.get("calls").as_array()[index]);
    assert_eq!(actual, expected, "{}: calls of recorded step {index}", case.get("name").as_str());
}

/// `skip` are the recorded state keys with no counterpart (declared in the manifest): `eventPipeline` always, and in the case whose
/// webhook start threw, `webhookServer` too (Node keeps the receiver object it made, which never listened; the core has no such object).
fn finish(case: &Exact, rig: &Rig, stderr: &Arc<Mutex<Vec<(mixdog_rt::node_log::Origin, mixdog_rt::node_log::Channel, String)>>>, skip: &[&str]) {
    let name = case.get("name").as_str();
    let Exact::Object(recorded) = case.get("state") else { panic!("{name}: the recorded state is an object") };
    let recorded = Exact::Object(recorded.iter().filter(|(key, _)| !skip.contains(&key.as_str())).cloned().collect());
    let Exact::Object(actual) = rig.state() else { unreachable!("the state is an object") };
    let actual = Exact::Object(actual.into_iter().filter(|(key, _)| !skip.contains(&key.as_str())).collect());
    same(&format!("{name}: state"), &recorded, &actual);
    let lines: Vec<Exact> =
        stderr.lock().unwrap().iter().map(|(_, _, line)| Exact::String(mixdog_rt::node_log::bare(line))).collect();
    same(&format!("{name}: stderr"), case.get("stderr"), &Exact::Array(lines));
}

fn recorded(index: usize, name: &str) -> Exact {
    let golden = golden(SET);
    assert_case_count(&golden, 8);
    case(&golden, index, name).clone()
}

#[tokio::test]
async fn start_advertises_arms_automation_once_and_notifies_acquired() {
    let case = recorded(0, "start advertises, arms automation once and notifies acquired");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    within("the first start", rig.activate()).await;
    step(&case, 0, rig.take());
    within("the second start", rig.activate()).await;
    step(&case, 1, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

#[tokio::test]
async fn start_does_nothing_while_the_bridge_is_inactive() {
    let case = recorded(1, "start does nothing while the bridge is inactive");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    // `channelBridgeActive=false`, then the start itself (an ON call would make the bridge active first).
    rig.runtime.set_bridge_active(false).await;
    within("the start", rig.runtime.start_bridge()).await.expect("the start answers");
    step(&case, 0, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

#[tokio::test]
async fn stop_tears_automation_down_and_is_idempotent() {
    let case = recorded(2, "stop tears automation down and is idempotent");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    within("the start", rig.activate()).await;
    step(&case, 0, rig.take());
    within("the first stop", rig.runtime.stop_owned_runtime("bridge inactive")).await.expect("the stop answers");
    step(&case, 1, rig.take());
    within("the second stop", rig.runtime.stop_owned_runtime("again")).await.expect("the stop answers");
    step(&case, 2, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

#[tokio::test]
async fn a_stop_landing_mid_start_makes_the_in_flight_start_bail_without_arming_automation() {
    let case = recorded(3, "a stop landing mid-start makes the in-flight start bail without arming automation");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    let hold = rig.hold_init();
    let calls = rig.calls.clone();
    let start = tokio::spawn(async move { calls.dispatch(client(), activate_request()).await });
    rig.init_entered().await;
    within("the stop", rig.runtime.stop_owned_runtime("shutdown")).await.expect("the stop answers");
    let connected_after_stop = rig.runtime.bridge_connected();
    step(&case, 0, rig.take());
    hold.add_permits(1);
    let reply = within("the held start", start).await.expect("the start task ends").expect("the activation call answers");
    assert_eq!(reply, json!({"content": [{"type": "text", "text": "channel bridge activated"}]}), "activation reply");
    step(&case, 1, rig.take());
    same("connectedAfterStop", case.get("connectedAfterStop"), &Exact::Bool(connected_after_stop));
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

#[tokio::test]
async fn reload_re_arms_the_scheduler_and_hot_reloads_automation_services() {
    let case = recorded(4, "reload re-arms the scheduler and hot-reloads automation services");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    within("the start", rig.activate()).await;
    step(&case, 0, rig.take());
    within("the reload", rig.runtime.reload_runtime()).await.expect("the reload answers");
    step(&case, 1, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

#[tokio::test]
async fn reload_on_a_stopped_runtime_tears_the_webhook_and_event_runtime_down() {
    let case = recorded(5, "reload on a stopped runtime tears the webhook and event runtime down");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    within("the reload", rig.runtime.reload_runtime()).await.expect("the reload answers");
    step(&case, 0, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

#[tokio::test]
async fn start_automation_runtime_is_idempotent_and_a_stop_during_its_init_aborts_arming() {
    let case = recorded(6, "startAutomationRuntime is idempotent and a stop during its init aborts arming");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    within("the first automation start", rig.runtime.start_automation()).await.expect("the start answers");
    step(&case, 0, rig.take());
    within("the second automation start", rig.runtime.start_automation()).await.expect("the start answers");
    step(&case, 1, rig.take());
    within("the stop", rig.runtime.stop_owned_runtime("done")).await.expect("the stop answers");
    step(&case, 2, rig.take());
    let hold = rig.hold_init();
    let runtime = rig.runtime.clone();
    let start = tokio::spawn(async move { runtime.start_automation().await });
    rig.init_entered().await;
    let runtime = rig.runtime.clone();
    let stop = tokio::spawn(async move { runtime.stop_owned_runtime("shutdown").await });
    tokio::task::yield_now().await;
    hold.add_permits(1);
    within("the held automation start", start).await.expect("the start task ends").expect("the start answers");
    within("the stop", stop).await.expect("the stop task ends").expect("the stop answers");
    step(&case, 3, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline"]);
}

/// The acquisition is announced as the bridge connects; the arming then fails (the recorder's webhook start throws, here the
/// listener's start fails). The start rolls the connection back, writes its stderr line and announces
/// nothing more: clients keep the acquired binding, and the activation call answers as a success.
#[tokio::test]
async fn an_activation_announced_as_acquired_whose_arming_fails_afterwards_rolls_back_and_announces_nothing_more() {
    let case = recorded(
        7,
        "an activation announced as acquired whose arming fails afterwards rolls the connection back and announces nothing more",
    );
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    *rig.listener.fails.lock().unwrap() = Some("webhook start failed".into());
    within("the start whose arming fails", rig.activate()).await;
    step(&case, 0, rig.take());
    finish(&case, &rig, &stderr, &["eventPipeline", "webhookServer"]);
}
