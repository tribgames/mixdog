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
//! - The webhook server and event pipeline calls of one `syncWebhookAndEventRuntime` (`pipeline.*`, `wire.*`,
//!   `webhook.new|reload|start`) ↔ one `AutomationServices::sync(reload)` (`reload` when the run holds a
//!   `webhook.reload`/`pipeline.reload`); those of one `stopWebhookAndEventRuntime` (`webhook.stop`, `pipeline.stop`,
//!   written only for what exists) ↔ one `AutomationServices::stop` while something runs. The recording services hold
//!   what Node's state shows (`webhookServer`/`eventPipeline` non-null while synced).
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
use super::ports::{AgentRuntime, AutomationServices};
use super::running::RunningWork;
use super::runtime::ChannelRuntime;
use super::tools::{ACTIVATE_TOOL, ChannelLifecycle, ToolDispatch};
use crate::memory::replays::{assert_case_count, case, golden, same};
use crate::scheduler::{MemoryScheduleStore, RunOutcome, Schedule, ScheduleRunner, Scheduler, SystemClock};

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

struct Services {
    log: Log,
    running: AtomicBool,
}

#[async_trait]
impl AutomationServices for Services {
    async fn sync(&self, reload: bool) -> Result<(), String> {
        self.log.lock().unwrap().push(json!(["services.sync", reload]));
        self.running.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn stop(&self) {
        if self.running.swap(false, Ordering::SeqCst) {
            self.log.lock().unwrap().push(json!(["services.stop"]));
        }
    }
}

struct Rig {
    runtime: Arc<ChannelRuntime>,
    calls: Arc<CallDispatch>,
    agent: Arc<Agent>,
    services: Arc<Services>,
    log: Log,
}

fn rig() -> Rig {
    let log: Log = Arc::default();
    let store = Arc::new(MemoryScheduleStore::default());
    let work = RunningWork::new();
    let scheduler = Scheduler::new(store.clone(), Arc::new(NoRuns), Arc::new(SystemClock), work.clone(), chrono_tz::Tz::UTC, Vec::new());
    scheduler.record_calls(log.clone());
    let agent = Arc::new(Agent { log: log.clone(), hold: Mutex::new(None), entered: tokio::sync::Notify::new() });
    let services = Arc::new(Services { log: log.clone(), running: AtomicBool::new(false) });
    let runtime = ChannelRuntime::new(scheduler, store, services.clone(), agent.clone());
    let calls = CallDispatch::new(Arc::new(BridgeCalls::new(ToolDispatch::new(runtime.clone(), work.clone(), Box::new(|| false)))), work);
    calls.hear_bridge(&runtime);
    let observed = log.clone();
    calls.observe_binding(Arc::new(move |remote| {
        observed.lock().unwrap().push(json!(["remote", if remote.acquired { "acquired" } else { "released" }, remote.pinned_session_id]));
    }));
    // The registration reports the binding as it stands (none): not a change.
    log.lock().unwrap().clear();
    Rig { runtime, calls, agent, services, log }
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
        let running = self.services.running.load(Ordering::SeqCst);
        let named = |name: &str| if running { Exact::String(name.into()) } else { Exact::Null };
        Exact::Object(vec![
            ("connected".into(), Exact::Bool(self.runtime.bridge_connected())),
            ("webhookServer".into(), named("FakeWebhookServer")),
            ("eventPipeline".into(), named("FakeEventPipeline")),
        ])
    }
}

fn client() -> ChannelClient {
    ChannelClient { token: "client-1".into(), lead_pid: Some(42) }
}

fn activate_request() -> CallRequest {
    CallRequest { name: ACTIVATE_TOOL.into(), args: json!({"active": true, "sessionId": SESSION}), call_id: None }
}

/// `notifyRemoteAcquired` is called from `activateBridge` once the bridge connected (owned-start.mjs:53-56): an
/// activation that fails before the bridge connects is never announced as acquired, not even for a moment.
#[tokio::test]
async fn an_activation_that_fails_before_the_bridge_connects_is_never_announced() {
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
const SYNC_CALLS: [&str; 8] =
    ["pipeline.new", "pipeline.reload", "wire.events", "pipeline.start", "webhook.new", "wire.webhook", "webhook.reload", "webhook.start"];
const STOP_CALLS: [&str; 2] = ["webhook.stop", "pipeline.stop"];

/// One step's recorded calls in the vocabulary of the Rust ports (see the header).
fn expected(calls: &Exact) -> Vec<Value> {
    let calls: Vec<Value> = calls.as_array().iter().map(|c| c.to_plain().expect("a plain call")).collect();
    let name = |i: usize| calls.get(i).and_then(|c| c[0].as_str()).unwrap_or_default().to_owned();
    let mut out = Vec::new();
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
            n if SYNC_CALLS.contains(&n) => {
                let mut reload = false;
                while i < calls.len() && SYNC_CALLS.contains(&name(i).as_str()) {
                    reload |= matches!(name(i).as_str(), "webhook.reload" | "pipeline.reload");
                    i += 1;
                }
                out.push(json!(["services.sync", reload]));
            }
            n if STOP_CALLS.contains(&n) => {
                while i < calls.len() && STOP_CALLS.contains(&name(i).as_str()) {
                    i += 1;
                }
                out.push(json!(["services.stop"]));
            }
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

fn finish(case: &Exact, rig: &Rig, stderr: &Arc<Mutex<Vec<(mixdog_rt::node_log::Origin, mixdog_rt::node_log::Channel, String)>>>) {
    let name = case.get("name").as_str();
    same(&format!("{name}: state"), case.get("state"), &rig.state());
    let lines: Vec<Exact> =
        stderr.lock().unwrap().iter().map(|(_, _, line)| Exact::String(mixdog_rt::node_log::bare(line))).collect();
    same(&format!("{name}: stderr"), case.get("stderr"), &Exact::Array(lines));
}

fn recorded(index: usize, name: &str) -> Exact {
    let golden = golden(SET);
    assert_case_count(&golden, 7);
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
    finish(&case, &rig, &stderr);
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
    finish(&case, &rig, &stderr);
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
    finish(&case, &rig, &stderr);
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
    finish(&case, &rig, &stderr);
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
    finish(&case, &rig, &stderr);
}

#[tokio::test]
async fn reload_on_a_stopped_runtime_tears_the_webhook_and_event_runtime_down() {
    let case = recorded(5, "reload on a stopped runtime tears the webhook and event runtime down");
    let (stderr, _guard) = mixdog_rt::node_log::capture();
    let rig = rig();
    within("the reload", rig.runtime.reload_runtime()).await.expect("the reload answers");
    step(&case, 0, rig.take());
    finish(&case, &rig, &stderr);
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
    finish(&case, &rig, &stderr);
}
