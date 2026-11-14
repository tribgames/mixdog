use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_services::bots::WakeHost;
use mixdog_services::bots::delivery::env::DeliveryConfig;
use mixdog_services::bots::delivery::env::HomeAgent;
use mixdog_services::bots::delivery::env::HomeDirectory;
use mixdog_services::bots::delivery::env::HomeThreads;
use mixdog_services::bots::delivery::env::LiveSlot;
use mixdog_services::bots::delivery::env::Presence;
use mixdog_services::bots::delivery::env::RetryTimer;
use mixdog_services::bots::delivery::env::RoomRelay;
use mixdog_services::bots::delivery::env::ThreadSnapshot;
use mixdog_services::bots::delivery::env::WakeFollow;
use mixdog_services::bots::delivery::queue::Handoffs;
use mixdog_services::bots::delivery::queue::QUEUE_CAPS;
use mixdog_services::bots::delivery::queue::RoutineResultQueue;
use mixdog_services::bots::live::WakeOptions;
use mixdog_services::bots::live::WakeTurn;
use mixdog_services::bots::state_json::StateJson;
use mixdog_services::scheduler::SystemClock;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::session::Clock;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::session::testing::lock;
use crate::eventually_on;
use crate::session::tests::idle;
use crate::session::tests::turn;

struct Main(Obj);

#[async_trait]
impl RouteContext for Main {
    fn resolve_main(&self) -> Result<Obj, String> {
        Ok(self.0.clone())
    }
    async fn resolve_chain_entry(&self, _: &Obj, _: &Obj) -> Result<Obj, String> {
        Err("unused".into())
    }
}

/// Whose shells a close cancelled.
#[derive(Default)]
struct Hooks {
    shells_cancelled: Mutex<Vec<String>>,
}

impl crate::session::shell_jobs::OwnedShells for Hooks {
    fn cancel_owned(&self, owner: &ThreadId) {
        lock(&self.shells_cancelled).push(owner.as_str().to_owned());
    }
}

/// A home world in which Mixy's home thread does not exist yet: a queued row waits in the queue.
struct NoHomeYet;

#[async_trait]
impl HomeThreads for NoHomeYet {
    async fn load(&self, _: &str) -> Result<Option<ThreadSnapshot>, String> {
        Ok(None)
    }
    async fn append(&self, _: &str, _: Vec<Value>, _: Option<i64>) -> Result<(), String> {
        Err("no home thread".into())
    }
    fn turn_in_flight(&self, _: &str) -> bool {
        false
    }
    async fn session_deleted(&self, _: &str) -> bool {
        false
    }
}

#[async_trait]
impl HomeDirectory for NoHomeYet {
    async fn agent_presence(&self, _: &str) -> Presence {
        Presence::Present
    }
    async fn room_presence(&self, _: &str) -> Presence {
        Presence::Unknown
    }
    async fn home_agent(&self, _: &str) -> HomeAgent {
        HomeAgent::Bot
    }
    async fn mixy_exists(&self) -> bool {
        true
    }
}

#[async_trait]
impl RoomRelay for NoHomeYet {
    async fn relay(&self, _: &str, _: &str, _: WakeOptions, _: WakeFollow) -> Result<Option<WakeTurn>, String> {
        Ok(None)
    }
}

impl RetryTimer for NoHomeYet {
    fn arm(&self, _: std::time::Duration, _: Box<dyn FnOnce() + Send>) {}
}

impl Handoffs for NoHomeYet {
    fn note(&self, _: &Value) {}
    fn end(&self, _: &str) {}
}

/// The home chats' delivery over `routine-results.json` in `dir`.
fn delivery(dir: &std::path::Path) -> (Arc<RoutineResultQueue>, Arc<AgentHomeDelivery>) {
    let state = StateJson::new(dir.join("routine-results.json"), mixdog_rt::testing::tokens().durability_io);
    let queue = Arc::new(RoutineResultQueue::new(state, 50, QUEUE_CAPS, Arc::new(SystemClock), Arc::new(NoHomeYet)));
    let world = Arc::new(NoHomeYet);
    let home = AgentHomeDelivery::new(
        world.clone(),
        world.clone(),
        LiveSlot::new(),
        world.clone(),
        queue.clone(),
        Arc::new(SystemClock),
        world,
        DeliveryConfig::node(),
    );
    (queue, home)
}

/// A provider registry with nothing registered (its release is `mixdog-ai`'s test).
struct NoProviders;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

fn obj(value: Value) -> Obj {
    value.as_object().cloned().expect("an object")
}

fn host_with(rig: &Rig, main: Value, messages: Arc<AgentHomeDelivery>) -> (Arc<SessionDirectory>, Arc<Hooks>, SessionWakeHost) {
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let hooks = Arc::new(Hooks::default());
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let read_state = Arc::new(mixdog_tools::fs::ReadState::new(None));
    let close = SessionClose::new(directory.clone(), providers, hooks.clone(), read_state);
    let host = SessionWakeHost::new(directory.clone(), Arc::new(close), Arc::new(Main(obj(main))), messages);
    (directory, hooks, host)
}

fn host(rig: &Rig, main: Value) -> (Arc<SessionDirectory>, Arc<Hooks>, SessionWakeHost) {
    let dir = tempfile::tempdir().expect("temp dir");
    let (_, messages) = delivery(dir.path());
    host_with(rig, main, messages)
}

fn profile() -> Value {
    json!({ "ownerAgentId": "lead", "sourceType": "exec", "sourceName": "heartbeat" })
}

/// `configLeadRoute`: the Main route's `modelRouteFields`, none while it names no model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_lead_route_is_mains_route_fields_and_none_without_a_model() {
    let rig = Rig::new();
    let main = json!({
        "provider": "anthropic", "model": "opus", "effort": "", "fast": true, "autoEffort": false,
        "modelParameters": { "verbosity": "low" }, "preset": "p1", "contextPercent": 50,
    });
    let (_, _, wake) = host(&rig, main);
    assert_eq!(
        wake.lead_route().await.unwrap(),
        Some(json!({ "provider": "anthropic", "model": "opus", "fast": true, "autoEffort": false, "modelParameters": { "verbosity": "low" } }))
    );
    let (_, _, unchosen) = host(&rig, json!({ "provider": "anthropic", "model": "  " }));
    assert_eq!(unchosen.lead_route().await.unwrap(), None);
}

/// The hidden session is Mixy's agent-mode exec run on the Lead route, fenced to the heartbeat
/// tools; its close writes the tombstone, unloads it, and a second close or an unknown id still
/// answers closed.
#[tokio::test(start_paused = true)]
async fn a_hidden_session_is_created_as_mixys_exec_run_and_closed_with_a_tombstone() {
    let rig = Rig::new();
    let (directory, hooks, wake) = host(&rig, json!({}));
    let lead = json!({ "provider": "anthropic", "model": "opus", "effort": "high" });
    let id = wake.create_hidden_session(&lead, &profile()).await.unwrap();
    let thread = ThreadId::from(id.as_str());
    let header = directory.stored_header(&thread).await.expect("created");
    for (key, want) in [
        ("provider", json!("anthropic")),
        ("model", json!("opus")),
        ("effort", json!("high")),
        ("owner", json!("cli")),
        ("agent", json!("lead")),
        ("lane", json!("cli")),
        ("sourceType", json!("exec")),
        ("sourceName", json!("heartbeat")),
        ("ownerAgentId", json!("lead")),
        ("sessionMode", json!("agent")),
        ("fast", json!(false)),
        ("autoEffort", json!(true)),
        ("modelParameters", json!({})),
        ("toolProfile", json!("heartbeat")),
        ("schemaAllowedTools", json!(["session", "setup", "load_tool"])),
    ] {
        assert_eq!(header.get(key), Some(&want), "{key}");
    }

    let loaded = directory.handle(&thread).expect("loaded");
    assert!(wake.close_hidden_session(&id).await.unwrap());
    assert_eq!(*lock(&hooks.shells_cancelled), std::slice::from_ref(&id), "the shells it owns are cancelled");
    eventually_on!(&[&loaded.cell.stepped, directory.left()], || directory.handle(&thread).is_none().then_some(())).await;
    // Loaded again: the header as its records fold it.
    let reopened = directory.open_handle(&thread, &CallContext::internal("test")).await.expect("the tombstone stays");
    let closed = reopened.cell.header.load_full();
    assert_eq!(
        (closed["closed"].clone(), closed["status"].clone(), closed["closedReason"].clone(), closed["generation"].clone()),
        (json!(true), json!("closed"), json!("heartbeat-finished"), json!(1))
    );
    assert_eq!(closed["updatedAt"], json!(rig.clock.now_ms()));
    assert!(wake.close_hidden_session(&id).await.unwrap(), "a re-close lands");
    let again = reopened.cell.header.load_full();
    assert_eq!((again["generation"].clone(), again["updatedAt"].clone()), (json!(1), closed["updatedAt"].clone()), "a re-close keeps the tombstone");
    assert!(wake.close_hidden_session("sess_never_made").await.unwrap(), "nothing is left to close");
}

/// The close aborts the running turn with `closeSession`'s text and drops the queued input;
/// the session unloads once that turn has ended.
#[tokio::test(start_paused = true)]
async fn a_close_ends_the_running_turn_drops_the_queue_and_unloads_after_it() {
    let rig = Rig::new();
    let aborted: Arc<Mutex<Option<String>>> = Arc::default();
    let seen = aborted.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            *lock(&seen) = Some(run.signal.reason());
            RunOutcome::Interrupted
        })
    }));
    let (directory, _, wake) = host(&rig, json!({}));
    let id = wake.create_hidden_session(&json!({ "provider": "anthropic", "model": "opus" }), &profile()).await.unwrap();
    let thread = ThreadId::from(id.as_str());
    let handle = directory.handle(&thread).expect("loaded");
    turn(&handle, "beat", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    assert_eq!(turn(&handle, "later", "op-2").await["kind"], json!("queued"));
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1).then_some(())).await;

    assert!(wake.close_hidden_session(&id).await.unwrap());
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(lock(&aborted).as_deref(), Some(format!("Session \"{id}\" closed: closeSession (reason=heartbeat-finished)").as_str()));
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&thread).is_none().then_some(())).await;
    assert!(handle.cell.queued.load().is_empty(), "the queued input went with the close");
}

/// A tombstone that does not land reports the close failed and leaves the session as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tombstone_that_does_not_land_leaves_the_session_open() {
    let rig = Rig::new();
    let (directory, _, wake) = host(&rig, json!({}));
    let id = wake.create_hidden_session(&json!({ "provider": "anthropic", "model": "opus" }), &profile()).await.unwrap();
    let thread = ThreadId::from(id.as_str());
    rig.store.fail_next.store(true, Ordering::SeqCst);
    assert!(!wake.close_hidden_session(&id).await.unwrap());
    let handle = directory.handle(&thread).expect("still loaded");
    assert_ne!(handle.cell.header.load().get("closed"), Some(&json!(true)));
}

/// Her reply is queued for her home chat as `deliverAgentMessage` queues it; an empty reply is
/// refused with its text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reply_reaches_the_delivery_queue() {
    let rig = Rig::new();
    let dir = tempfile::tempdir().expect("temp dir");
    let (queue, messages) = delivery(dir.path());
    let (_, _, wake) = host_with(&rig, json!({}), messages);
    wake.deliver("lead", "heartbeat_sess_open", "  Two builds are red.\n").await.unwrap();
    let home = mixdog_services::bots::ids::agent_home_session_id("lead").expect("Mixy's home");
    let items = queue.items(&home).await.unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(
        (items[0]["runId"].clone(), items[0]["kind"].clone(), items[0]["text"].clone()),
        (json!("heartbeat_sess_open"), json!("agent-message"), json!("Two builds are red."))
    );
    assert_eq!(
        wake.deliver("lead", "heartbeat_sess_open", "  ").await,
        Err("agent message: runId and text required".to_owned())
    );
}
