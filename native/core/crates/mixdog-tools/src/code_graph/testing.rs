//! A code graph host for tests: the helper's own engine and request handler in this process, so a `code_graph` tool answers
//! without a helper process.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_graph_host::HostError;
use mixdog_graph_host::Start;
use mixdog_graph_host::wire;
use mixdog_graph_host::worker::Handler;
use mixdog_graph_host::worker::Rejection;
use mixdog_rt::CancellationToken;

use super::engine::GraphEngine;
use super::engine::Worker;

/// Answers each request on a thread of its own, as the helper's build thread would, over the engine of one cache directory.
/// It always runs, so a warm that may only warm a running helper ([`Start::IfRunning`]) warms it too.
pub struct InProcessHost {
    worker: Arc<Worker>,
}

impl InProcessHost {
    /// The host over the cache under `cache_dir`.
    pub fn new(cache_dir: PathBuf) -> Self {
        Self::of(GraphEngine::new(cache_dir).expect("the engine's flush thread starts"))
    }

    pub(super) fn of(engine: GraphEngine) -> Self {
        Self { worker: Arc::new(Worker(engine)) }
    }

    /// The engine, for a test that looks inside it.
    #[cfg(test)]
    pub(super) fn engine(&self) -> &GraphEngine {
        &self.worker.0
    }
}

#[async_trait]
impl super::CodeGraphHost for InProcessHost {
    async fn query(&self, query: wire::Query, cancel: &CancellationToken) -> Result<wire::Answer, HostError> {
        let worker = self.worker.clone();
        on_thread(cancel, move || {
            worker.query(query).map_err(|rejection| match rejection {
                Rejection::Refused(refusal) => HostError::Refused(refusal),
                Rejection::Failed(failure) => HostError::Failed(failure),
            })
        })
        .await
    }

    async fn prewarm(&self, prewarm: wire::Prewarm, _start: Start, cancel: &CancellationToken) -> Result<wire::Warmed, HostError> {
        let worker = self.worker.clone();
        on_thread(cancel, move || worker.prewarm(prewarm).map_err(HostError::Failed)).await
    }
}

/// `work` on a thread of its own; `cancel` ends the wait for it.
async fn on_thread<T: Send + 'static>(cancel: &CancellationToken, work: impl FnOnce() -> Result<T, HostError> + Send + 'static) -> Result<T, HostError> {
    let (done, answer) = tokio::sync::oneshot::channel();
    drop(std::thread::spawn(move || drop(done.send(work()))));
    tokio::select! {
        biased;
        answered = answer => answered.unwrap_or_else(|_| {
            Err(HostError::Failed(wire::WorkerFailure { kind: wire::FailureKind::Internal, message: "the request's thread panicked".to_owned() }))
        }),
        () = cancel.cancelled() => Err(HostError::Cancelled),
    }
}
