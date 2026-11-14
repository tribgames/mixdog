//! The model proxy of a server core (desktop-services.md §12.4), on the link to that server: the server sends
//! `model/proxy/execute` to this connection, which runs the call on this PC's own core ([`LocalModelProxy`], in the
//! same process: no socket hop), streams its events back as `model/proxy/event` and answers with the result. The
//! server's `model/proxy/cancel { requestId }` stops the run that request started, as Node's host aborts the call it
//! keeps under the request id (`model-proxy-host.ts` `abortCancelled`).
//!
//! The PC claims a request with the first `model/proxy/heartbeat` naming it (the server gives a request nobody claimed
//! up after 10 s) and vouches for every running request every [`HEARTBEAT_MS`] until they are over. A lost link
//! abandons the calls in flight: they are stopped and left unanswered, as the server gives them up itself once its
//! lease (10 s without a heartbeat) runs out.

use std::sync::{
    Arc, Mutex, MutexGuard, PoisonError,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::{
    ModelProxyCancelParams, ModelProxyEventParams, ModelProxyExecuteParams, ModelProxyHeartbeatParams, ModelProxyResult,
};
use mixdog_app_protocol::v2::model_proxy::{ProxyAnswer, ProxyCall, ProxyEvent};
use mixdog_app_protocol::{RequestId, ServerRequest};
use mixdog_app_server_client::{ClientEvent, ConnectionStatus, ProtocolClient, ServerRequestAnswer};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const CANCEL: &str = "model/proxy/cancel";
const EVENT: &str = "model/proxy/event";
const HEARTBEAT: &str = "model/proxy/heartbeat";
/// Node's `MODEL_PROXY_HEARTBEAT_MS`: well inside the server's 20 s lease.
pub const HEARTBEAT_MS: u64 = 5_000;
/// The code of the error a failed call answers with: the error vocabulary of the server has no place for a failure, so
/// it is the data of the error (Node answers with the error record and no numeric code, `model-proxy-host.ts:896-910`).
const FAILED_CODE: i64 = -32000;

/// Where a run's events go: back to the server, by the request that started it.
pub trait ProxyEventSink: Send + Sync {
    fn event(&self, event: ProxyEvent);
}

/// This PC's own core, which runs a proxied call (`modelProxy/run`).
#[async_trait]
pub trait LocalModelProxy: Send + Sync {
    /// Runs `call` with the accounts of this PC that `allowed_providers` names (`None`: every provider enabled here),
    /// streaming its events to `events` ahead of the answer. A call that failed answers [`ProxyAnswer::Failed`]; `Err`
    /// is a core that could not answer at all. `cancel` is the server's give-up: stop spending on the call.
    async fn run(
        &self,
        call: ProxyCall,
        allowed_providers: Option<Vec<String>>,
        events: Arc<dyn ProxyEventSink>,
        cancel: CancellationToken,
    ) -> Result<ProxyAnswer, String>;
}

/// The providers a server may use through this PC, read at every call (Node's `isProviderAllowed` over
/// `allowedProvidersForHost`): the host's saved list, `None` for every provider enabled here.
pub type AllowedProviders = Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>;

struct Run {
    id: RequestId,
    generation: u64,
    cancel: CancellationToken,
}

#[derive(Default)]
struct State {
    runs: Vec<Run>,
    beat: Option<JoinHandle<()>>,
}

pub struct ModelProxyRelay {
    client: Arc<dyn ProtocolClient>,
    local: Arc<dyn LocalModelProxy>,
    allowed: AllowedProviders,
    /// False while the server runs models with its own logins: its requests are not taken up (not even claimed).
    serving: AtomicBool,
    generations: AtomicU64,
    state: Mutex<State>,
}

struct ChannelSink(mpsc::UnboundedSender<ProxyEvent>);

impl ProxyEventSink for ChannelSink {
    fn event(&self, event: ProxyEvent) {
        // Nobody reads any more once the run's answer is going out.
        let _ = self.0.send(event);
    }
}

impl ModelProxyRelay {
    pub fn new(client: Arc<dyn ProtocolClient>, local: Arc<dyn LocalModelProxy>, allowed: AllowedProviders) -> Arc<Self> {
        Arc::new(Self {
            client,
            local,
            allowed,
            serving: AtomicBool::new(true),
            generations: AtomicU64::new(0),
            state: Mutex::new(State::default()),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Calls in flight.
    pub fn running(&self) -> usize {
        self.state().runs.len()
    }

    /// Whether the server's requests are taken up from now on (calls already running go on).
    pub fn serving(&self, serving: bool) {
        self.serving.store(serving, Ordering::SeqCst);
    }

    /// Takes up the server's requests on the link until it is closed for good or the task is aborted. Subscribes before
    /// it returns, so no event after the call is missed. The owner aborts the task and calls [`Self::abandon_all`] to stop.
    pub fn serve(self: &Arc<Self>) -> JoinHandle<()> {
        let mut events = self.client.events();
        let relay = self.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => relay.handle(event).await,
                    // Events missed in a burst: the link itself is still there.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        relay.abandon_all();
                        return;
                    }
                }
            }
        })
    }

    async fn handle(self: &Arc<Self>, event: ClientEvent) {
        match event {
            ClientEvent::Status(ConnectionStatus::Ready { .. }) => {}
            ClientEvent::Status(_) => self.abandon_all(),
            ClientEvent::ServerRequest(ServerRequest::ModelProxyExecute { request_id, params }) => {
                self.execute(request_id, params).await;
            }
            ClientEvent::Notification(note) if note.method == CANCEL => {
                let Some(params) = note.params else { return };
                let Ok(ModelProxyCancelParams { request_id }) = serde_json::from_value(params) else { return };
                // A call that is over, or never was, has nothing to stop.
                if let Some(run) = self.state().runs.iter().rev().find(|run| run.id == request_id) {
                    run.cancel.cancel();
                }
            }
            _ => {}
        }
    }

    /// The server gave these calls up (its link is gone, or its model login changed): stopped, forgotten and left
    /// unanswered. None of them reads or sends anything of this PC's from now on.
    pub fn abandon_all(&self) {
        let mut state = self.state();
        if let Some(beat) = state.beat.take() {
            beat.abort();
        }
        for run in state.runs.drain(..) {
            run.cancel.cancel();
        }
    }

    /// The server's model login changed: every call in flight is given up, and the relay takes up new ones again.
    pub fn revoke(&self) {
        self.abandon_all();
    }

    async fn execute(self: &Arc<Self>, id: RequestId, params: ModelProxyExecuteParams) {
        // A server on its own logins takes nothing of this PC's: left unclaimed, the server gives the request up.
        if !self.serving.load(Ordering::SeqCst) {
            return;
        }
        let generation = self.generations.fetch_add(1, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        {
            let mut state = self.state();
            state.runs.push(Run { id: id.clone(), generation, cancel: cancel.clone() });
            if state.beat.is_none() {
                state.beat = Some(self.start_beat());
            }
        }
        // The claim: the server gives a request nobody claimed up after 10 s.
        self.heartbeat(vec![id.clone()]).await;
        let allowed = (self.allowed)();
        let relay = self.clone();
        drop(tokio::spawn(async move { relay.run_call(id, generation, params.call, allowed, cancel).await }));
    }

    /// One beat on a timer that lives while any call runs: every running request.
    fn start_beat(self: &Arc<Self>) -> JoinHandle<()> {
        let relay = self.clone();
        tokio::spawn(async move {
            loop {
                mixdog_rt::time::sleep(Duration::from_millis(HEARTBEAT_MS)).await;
                let ids: Vec<RequestId> = relay.state().runs.iter().map(|run| run.id.clone()).collect();
                if !ids.is_empty() {
                    relay.heartbeat(ids).await;
                }
            }
        })
    }

    async fn heartbeat(&self, request_ids: Vec<RequestId>) {
        self.notify(HEARTBEAT, &ModelProxyHeartbeatParams { request_ids }).await;
    }

    async fn notify<P: serde::Serialize>(&self, method: &str, params: &P) {
        // A link that is not ready fails the notification: the server then gives the call up on its own lease.
        if let Ok(params) = serde_json::to_value(params) {
            let _ = self.client.notify(method, params).await;
        }
    }

    /// An abandoned run is no longer listed: its events and its answer are not sent.
    fn live(&self, generation: u64) -> bool {
        self.state().runs.iter().any(|run| run.generation == generation)
    }

    async fn forward(&self, id: &RequestId, generation: u64, event: ProxyEvent) {
        if self.live(generation) {
            self.notify(EVENT, &ModelProxyEventParams { request_id: id.clone(), event }).await;
        }
    }

    async fn run_call(
        self: Arc<Self>,
        id: RequestId,
        generation: u64,
        call: ProxyCall,
        allowed: Option<Vec<String>>,
        cancel: CancellationToken,
    ) {
        let (tx, mut events) = mpsc::unbounded_channel();
        let local = self.local.clone();
        let run = local.run(call, allowed, Arc::new(ChannelSink(tx)), cancel);
        tokio::pin!(run);
        let outcome = loop {
            tokio::select! {
                biased;
                Some(event) = events.recv() => self.forward(&id, generation, event).await,
                outcome = &mut run => break outcome,
            }
        };
        // The events a run wrote just before it answered come ahead of the answer.
        while let Ok(event) = events.try_recv() {
            self.forward(&id, generation, event).await;
        }
        if !self.live(generation) {
            return;
        }
        let answer = match outcome {
            Ok(ProxyAnswer::Failed { failure }) => ServerRequestAnswer::Error {
                code: FAILED_CODE,
                message: failure.message.clone(),
                data: serde_json::to_value(&failure).ok(),
            },
            Ok(result) => match serde_json::to_value(ModelProxyResult { result }) {
                Ok(value) => ServerRequestAnswer::Result(value),
                Err(error) => ServerRequestAnswer::Error { code: FAILED_CODE, message: error.to_string(), data: None },
            },
            Err(message) => ServerRequestAnswer::Error { code: FAILED_CODE, message, data: None },
        };
        let _ = self.client.respond(id, answer).await;
        let mut state = self.state();
        state.runs.retain(|run| run.generation != generation);
        if state.runs.is_empty() {
            if let Some(beat) = state.beat.take() {
                beat.abort();
            }
        }
    }
}

#[cfg(test)]
mod model_proxy_relay_tests;
