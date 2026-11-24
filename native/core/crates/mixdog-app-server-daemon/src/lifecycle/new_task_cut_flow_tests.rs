//! A stop request ends the new-task attempts first, then drains the rest: a new task held in its draft step has its call let go after
//! the stop request, stops before its next call and ends refused, leaving a receipt whose session address is a fresh one. A drain that
//! is cancelled instead starts the attempt its stop request cut again, and the ones that follow.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::StatePublisher;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::state::SectionChange;
use mixdog_core_session::session::NewThreadRoute;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use mixdog_protocol::SectionName;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;

use super::ActivityInfo;
use super::ActivityKind;
use super::ClientGrace;
use super::CoreWiring;
use super::Lifecycle;
use super::LifecycleConfig;
use super::Ports;
use super::ReleaseBudgets;
use super::RuntimeCore;
use super::StopMode;
use super::StopReason;
use super::testing::ManualTimer;
use super::testing::Recorder;
use super::testing::fixture;

/// The bound of the test's whole body, in real time.
const BOUND: std::time::Duration = std::time::Duration::from_secs(60);

/// The draft's route adoption (`setRoute`) is held on its first call, says when it is entered and goes on when let go.
struct HeldRoute {
    entered: Arc<tokio::sync::Notify>,
    released: Arc<tokio::sync::Notify>,
    held: AtomicBool,
}

#[async_trait::async_trait]
impl NewThreadRoute for HeldRoute {
    async fn adopt(&self, _: &ThreadId, _: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
        if !self.held.swap(true, Ordering::SeqCst) {
            self.entered.notify_one();
            self.released.notified().await;
        }
        Ok(Map::new())
    }

    async fn adopt_control(&self, _: &ThreadId) -> Result<Map<String, Value>, String> {
        Ok(Map::new())
    }

    async fn seat(&self, _: &ThreadId) -> Result<(), String> {
        Ok(())
    }
}

/// The step the test reached, named in its deadline's failure.
type Step = Arc<std::sync::Mutex<&'static str>>;

/// Runs `body` on a thread of its own; `test` fails naming the step it reached when the body has not ended within [`BOUND`].
fn bounded(test: &str, body: fn(&Step)) {
    let step: Step = Arc::new(std::sync::Mutex::new("its start"));
    let (done, waiting) = std::sync::mpsc::channel::<()>();
    let reached = step.clone();
    let body = std::thread::spawn(move || {
        body(&reached);
        drop(done);
    });
    if waiting.recv_timeout(BOUND) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
        panic!("{test}, at {}: not within {BOUND:?}", step.lock().unwrap());
    }
    body.join().expect("the body");
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime")
}

/// A directory over the rig whose draft route adoption is held on its first call: `entered` is told when it is, `released` lets it go.
fn held_directory(rig: &Rig) -> (Arc<SessionDirectory>, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
    rig.store.listed.store(true, Ordering::SeqCst);
    let entered = Arc::new(tokio::sync::Notify::new());
    let released = Arc::new(tokio::sync::Notify::new());
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldRoute { entered: entered.clone(), released: released.clone(), held: AtomicBool::new(false) });
    (Arc::new(SessionDirectory::new(Arc::new(deps))), entered, released)
}

/// A new task's `thread/start` as the server admits it: its guard is the composed core's (`request_started`: a new task), held while it
/// runs. Answers whether the request subscribed to its thread.
fn start_task(
    runtime: &tokio::runtime::Runtime,
    lifecycle: &Arc<Lifecycle>,
    directory: &Arc<SessionDirectory>,
    op: &str,
    submission: &str,
) -> tokio::task::JoinHandle<Result<bool, CoreError>> {
    let guard = lifecycle.begin_new_task();
    let params = json!({
        "opId": op, "kind": "task", "projectPath": "/ws", "draft": { "route": { "provider": "openai", "model": "gpt-5" } },
        "initialInput": { "prompt": "write the quarterly report", "options": { "clientSubmissionId": submission } },
    });
    let request = CoreRequest {
        method: Method("thread/start"),
        params,
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, tokio_util::sync::CancellationToken::new()),
    };
    let directory = directory.clone();
    runtime.spawn(async move {
        let _guard = guard;
        directory.request(request).await.map(|reply| matches!(reply, Reply::Subscribe(_)))
    })
}

struct Quiet;

impl StatePublisher for Quiet {
    fn publish(&self, _: SectionName, _: Option<String>, _: SectionChange) {}
}

/// The production core port: its new-task hooks call the directory, as `serving.rs` wires them through the composed core; the other
/// steps have nothing to act on.
fn runtime_core(runtime: &tokio::runtime::Runtime, directory: &Arc<SessionDirectory>, install: &Path) -> RuntimeCore {
    let js = crate::js_runtime::fixture(install);
    let ext_host = {
        let _enter = runtime.enter();
        Arc::new(
            mixdog_exthost::ExtHostPool::new(mixdog_exthost::ExtHostConfig {
                workers: 1,
                ..crate::compose::ext_host_config(&js, install, &mixdog_rt::testing::tokens())
            })
            .expect("an extension host"),
        )
    };
    RuntimeCore::new(CoreWiring {
        state: Arc::new(Quiet),
        connections: Arc::new(ConnectionHub::new(Limits::default()).expect("a connection hub")),
        ext_host,
        runtime: runtime.handle().clone(),
        cancel: Arc::default(),
        cut_new_tasks: {
            let directory = directory.clone();
            Arc::new(move || directory.cut_new_tasks())
        },
        reopen_new_tasks: {
            let directory = directory.clone();
            Arc::new(move || directory.reopen_new_tasks())
        },
        final_barriers: Arc::new(|| {}),
        release_decision: Arc::new(|_| {}),
        close_data_handles: Arc::new(|_| {}),
        release_started: Arc::new(|_| {}),
        flush_log: Arc::new(|| {}),
        drain_feed: Arc::new(|_| {}),
    })
}

#[test]
fn a_stop_request_cuts_a_new_task_held_in_its_draft_step_and_the_core_releases() {
    bounded("a_stop_request_cuts_a_new_task_held_in_its_draft_step_and_the_core_releases", cut_and_release);
}

#[allow(clippy::disallowed_methods, reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the filesystem case.")]
fn cut_and_release(step: &Step) {
    let at = |name: &'static str| *step.lock().unwrap() = name;
    let runtime = runtime();
    let rig = Rig::new();
    let (directory, entered, released) = held_directory(&rig);
    let f = fixture();
    // The stop request's cut; the held call is let go after it.
    *f.recorder.on_cut.lock().unwrap() = Some(Box::new({
        let directory = directory.clone();
        move || {
            directory.cut_new_tasks();
            released.notify_one();
        }
    }));
    f.lifecycle.set_serving().expect("serving");
    let caller = start_task(&runtime, &f.lifecycle, &directory, "op-1", "s-quit-route");
    at("the attempt reaching its held route");
    runtime.block_on(entered.notified());
    at("the stop request releasing the core while the attempt is held");
    f.lifecycle.stop(StopMode::WhenIdle, StopReason::UserStop, None).expect("stop");
    f.recorder.wait_exit();
    at("the directory's shutdown");
    runtime.block_on(directory.shutdown());
    assert!(!caller.is_finished(), "the caller in flight got an answer at the stop");
    // The receipt the refused attempt left: the new-task reservation's file under the profile, whose session address is a fresh one,
    // not the reservation that was refused.
    let key: String = sha2::Sha256::digest(b"s-quit-route").iter().map(|byte| format!("{byte:02x}")).collect();
    let file = rig._data.path().join("userdata").join("new-task-receipts").join(format!("{key}.json"));
    let receipt: Value = serde_json::from_str(&std::fs::read_to_string(file).expect("the receipt")).expect("a receipt");
    let address = receipt["sessionId"].as_str().expect("an address");
    assert_ne!(address, format!("sess_desktop_{key}"), "the refused reservation is not resumed");
    caller.abort();
}

/// The drain is cancelled instead (the user dismissed the update): through the production core port the cancel reopens what the stop
/// request cut, so the request it cut is made again and its task starts, and a task asked for later starts too.
#[test]
fn a_cancelled_drain_starts_the_new_task_its_stop_cut_and_the_next_one() {
    bounded("a_cancelled_drain_starts_the_new_task_its_stop_cut_and_the_next_one", cut_and_cancel);
}

fn cut_and_cancel(step: &Step) {
    let at = |name: &'static str| *step.lock().unwrap() = name;
    let runtime = runtime();
    let rig = Rig::new();
    let (directory, entered, released) = held_directory(&rig);
    let install = tempfile::tempdir().expect("an install");
    let recorder = Arc::new(Recorder::default());
    let lifecycle = Lifecycle::with_grace(
        LifecycleConfig { instance_id: "instance-1".into(), version: "1.5.0".into(), runtime_root: install.path().to_owned() },
        Ports { core: Arc::new(runtime_core(&runtime, &directory, install.path())), discovery: recorder.clone(), exiter: recorder.clone() },
        ReleaseBudgets::default(),
        ClientGrace::immediate(),
        ManualTimer::new(),
    );
    lifecycle.set_serving().expect("serving");
    // A running turn keeps the drain in its idle wait, where it can still be cancelled.
    let turn = lifecycle.begin_activity(ActivityInfo {
        kind: ActivityKind::Turn,
        thread_id: Some("thread-1".into()),
        turn_id: Some("turn-1".into()),
        title: "a turn".into(),
    });
    let cut = start_task(&runtime, &lifecycle, &directory, "op-1", "s-cut");
    at("the attempt reaching its held route");
    runtime.block_on(entered.notified());
    at("the stop request cutting the attempt");
    lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).expect("stop");
    released.notify_one();
    let drain = lifecycle.status().drain.clone().expect("the drain waits for the turn").drain_id;
    at("the drain's cancel");
    lifecycle.cancel_drain(&drain).expect("cancelled");
    at("the cut task starting");
    assert!(runtime.block_on(cut).expect("joined").expect("the cut task starts"), "its thread is subscribed");
    at("a later task starting");
    let later = start_task(&runtime, &lifecycle, &directory, "op-2", "s-later");
    assert!(runtime.block_on(later).expect("joined").expect("a later task starts"), "its thread is subscribed");
    drop(turn);
    assert!(!recorder.has_exited(), "the cancelled drain left the core serving");
}
