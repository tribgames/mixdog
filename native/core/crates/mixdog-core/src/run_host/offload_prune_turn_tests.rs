//! Node's `cancelled-turn` and `failed-turn` (`fixtures/offload-prune-order`, Node with the prune-after-save fix)
//! through the product's turn: the compaction Node adopted is committed (its prune runs once it is durable), then a
//! real turn (`turn/start`) runs through the host's run factory and loop against a provider whose model request waits
//! until the test has read the directory; it is aborted (`abort_session_turn`, Node's `abortSessionTurn`) or its
//! model request fails. Node's turn ends as the product's does: a cancelled turn that produced nothing is rewound, a
//! failed one records its completion on its prompt. The tool-result directory and the stored transcript are compared
//! whole at each point Node observed (`testing::offload_replay`).

use mixdog_core_session::session::testing::offload_replay::World;
use mixdog_core_session::session::testing::offload_replay::within;
use mixdog_core_session::session::turn_ops::CompactionCommit;
use tokio::sync::Notify;

use super::*;

/// The model request: it tells `requested`, then fails once `release` is told, or (`fails` false) streams nothing
/// until the turn is cancelled.
struct Waiting {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    fails: bool,
    requested: Arc<Notify>,
    release: Arc<Notify>,
}

struct Silent;

#[async_trait]
impl ModelStream for Silent {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        std::future::pending().await
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl ProviderAdapter for Waiting {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, _request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.requested.notify_one();
        if !self.fails {
            return Ok(Box::new(Silent));
        }
        self.release.notified().await;
        // Node's provider throws `new Error('the provider failed')`: an error of no known kind.
        let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Unknown, DeliveryState::NotSent);
        error.message = "the provider failed".into();
        Err(error)
    }
}

async fn real_turn(name: &str, cancelled: bool) {
    let workspace = tempfile::tempdir().expect("workspace");
    let (requested, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let provider = Arc::new(Waiting {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        fails: !cancelled,
        requested: requested.clone(),
        release: release.clone(),
    });
    let parts = Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None });
    let deps = move |rig: &Rig| {
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), parts.clone()));
        Arc::new(deps)
    };
    let world = World::new(name, mixdog_testkit::fixture!("../../fixtures/offload-prune-order/golden.json"), Rig::new(), deps).await;
    assert_eq!(world.commit().await.expect("answered"), CompactionCommit::Applied);
    let turn = json!({ "threadId": world.handle.id().as_str(), "opId": "op-turn", "input": { "prompt": "do the thing" } });
    let Reply::Value(started) = within("the turn is asked", world.handle.request(request("turn/start", turn, "op-turn"))).await.expect("turn/start") else {
        panic!("turn/start answers a value");
    };
    assert_eq!(started["kind"], "started");
    within("the turn's model request is in flight", requested.notified()).await;
    let after_commit = world.point("after-commit", false).await;
    if cancelled {
        assert!(world.directory.abort_session_turn(world.handle.id(), "turn-abort"), "the turn is aborted");
    } else {
        release.notify_one();
    }
    world.ended().await;
    let after_turn_end = world.point("after-turn-end", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_turn_end]), world.case);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_turn_cancelled_after_the_compaction_leaves_what_nodes_leaves() {
    real_turn("cancelled-turn", true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_turn_failing_after_the_compaction_leaves_what_nodes_leaves() {
    real_turn("failed-turn", false).await;
}
