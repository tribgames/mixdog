//! A stop request ends the new-task attempts first, as Node's quit does (the app's `/stop {force:true}` runs the daemon's `shutdown`
//! without `drainDeferral`, `daemon.mjs:272`, `:533-536`), then drains the rest: a new task held in its draft step has its call
//! let go after the stop request (as the recording lets Node's go once the daemon answered it), stops before its next call and
//! ends refused, as Node's recording of a quit inside `setRoute` ends (new-task-quit `quit-in-set-route`).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::NewThreadRoute;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;

use super::StopMode;
use super::StopReason;
use super::testing::fixture;

/// The bound of the test's whole body, in real time.
const BOUND: std::time::Duration = std::time::Duration::from_secs(60);

/// The draft's route adoption (Node's `setRoute`) is held on its first call, says when it is entered and goes on when let go.
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

#[test]
fn a_stop_request_cuts_a_new_task_held_in_its_draft_step_and_the_core_releases() {
    let step: Step = Arc::new(std::sync::Mutex::new("its start"));
    let (done, waiting) = std::sync::mpsc::channel::<()>();
    let reached = step.clone();
    let body = std::thread::spawn(move || {
        body(&reached);
        drop(done);
    });
    if waiting.recv_timeout(BOUND) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
        panic!("a_stop_request_cuts_a_new_task_held_in_its_draft_step_and_the_core_releases, at {}: not within {BOUND:?}", step.lock().unwrap());
    }
    body.join().expect("the body");
}

fn body(step: &Step) {
    let at = |name: &'static str| *step.lock().unwrap() = name;
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
    let rig = Rig::new();
    rig.store.listed.store(true, Ordering::SeqCst);
    let entered = Arc::new(tokio::sync::Notify::new());
    let released = Arc::new(tokio::sync::Notify::new());
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldRoute { entered: entered.clone(), released: released.clone(), held: AtomicBool::new(false) });
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
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
    let params = json!({
        "opId": "op-1", "kind": "task", "projectPath": "/ws", "draft": { "route": { "provider": "openai", "model": "gpt-5" } },
        "initialInput": { "prompt": "write the quarterly report", "options": { "clientSubmissionId": "s-quit-route" } },
    });
    // The request as the server admits it: its guard is the composed core's (`request_started`: a new task), held while it runs.
    let guard = f.lifecycle.begin_new_task();
    let caller = runtime.spawn({
        let directory = directory.clone();
        async move {
            let _guard = guard;
            directory
                .request(CoreRequest {
                    method: Method("thread/start"),
                    params,
                    op: Some(OpId::from("op-1")),
                    ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, tokio_util::sync::CancellationToken::new()),
                })
                .await
                .map(|reply| matches!(reply, Reply::Subscribe(_)))
        }
    });
    at("the attempt reaching its held route");
    runtime.block_on(entered.notified());
    at("the stop request releasing the core while the attempt is held");
    f.lifecycle.stop(StopMode::WhenIdle, StopReason::UserStop, None).expect("stop");
    f.recorder.wait_exit();
    at("the directory's shutdown");
    runtime.block_on(directory.shutdown());
    assert!(!caller.is_finished(), "the caller in flight got an answer at the stop");
    // The receipt as Node's quit inside `setRoute` left it (new-task-quit golden.json `quit-in-set-route`), less its signature (the
    // content's hash; the content here is the test's own).
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/new-task-quit/golden.json")).expect("golden");
    let recorded = golden["cases"]["quit-in-set-route"]["recorded"][0]["receipts"].as_object().expect("receipts").clone();
    let unsigned = |text: &str| {
        let mut receipt: Value = serde_json::from_str(text).expect("a receipt");
        receipt.as_object_mut().expect("object").remove("signature");
        receipt
    };
    let key: String = sha2::Sha256::digest(b"s-quit-route").iter().map(|byte| format!("{byte:02x}")).collect();
    let file = rig._data.path().join("userdata").join("new-task-receipts").join(format!("{key}.json"));
    let mut core = unsigned(&std::fs::read_to_string(file).expect("the receipt"));
    let address = core["sessionId"].as_str().expect("an address").to_owned();
    assert_ne!(address, format!("sess_desktop_{key}"), "the refused reservation is not resumed");
    core["sessionId"] = json!("<fresh:1>");
    assert_eq!(core, unsigned(recorded[&format!("{key}.json")].as_str().expect("text")));
    caller.abort();
}
