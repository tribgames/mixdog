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
    ModelProxyCancelParams, ModelProxyEventParams, ModelProxyExecuteParams, ModelProxyHeartbeatParams, ModelProxyResult, ModelProxyTailParams,
};
use mixdog_app_protocol::v2::model_proxy::{ProxyAnswer, ProxyCall, ProxyEvent, ProxyFailure};
use mixdog_app_protocol::{RequestId, ServerRequest};
use mixdog_app_server_client::{AttachmentId, ClientError, ClientEvent, ConnectionStatus, ProtocolClient, ReplyAddress, ServerRequestAnswer};
pub use mixdog_core_domains::domains::ai_admin::model_proxy::OwnerLink;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const CANCEL: &str = "model/proxy/cancel";
const EVENT: &str = "model/proxy/event";
const HEARTBEAT: &str = "model/proxy/heartbeat";
/// The session owner's verdict on one POST of a session send this PC runs.
const TAIL: &str = "model/proxy/tail";
/// Node's `MODEL_PROXY_HEARTBEAT_MS`: well inside the server's 20 s lease.
pub const HEARTBEAT_MS: u64 = 5_000;
/// The code of the error a failed call answers with: the error vocabulary of the server has no place for a failure, so
/// it is the data of the error (Node answers with the error record and no numeric code, `model-proxy-host.ts:896-910`).
const FAILED_CODE: i64 = -32000;

/// Where a run's events go: back to the server, by the request that started it.
pub trait ProxyEventSink: Send + Sync {
    fn event(&self, event: ProxyEvent);

    /// The link back to the server's session that owns the call's transcript, which a session send asks before each POST.
    fn owner(&self) -> Option<Arc<OwnerLink>> {
        None
    }
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

/// How a call the relay took up ended (Node's `onCallSettled` outcome).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallOutcome {
    Answered,
    /// The error reached the server.
    Failed,
    /// The server link went, or the relay was given up, before it ended.
    Abandoned,
}

/// A call that ended, for the connection that owns the relay (the reattach report counts the abandoned ones; a failed
/// one on this PC's sign-in names the provider to sign in again).
#[derive(Debug, Clone)]
pub struct ProxyCallSettled {
    /// The provider the call named, empty for one that names none (`providerConfig`).
    pub provider: String,
    pub outcome: CallOutcome,
    /// The failure record of a call that failed with one; `None` when the local core could not answer at all.
    pub failure: Option<ProxyFailure>,
}

struct Run {
    /// Where this run's events and answer go: the socket its request arrived on and the id there. The id alone is not an
    /// address (a new socket to the same server may reuse it), and every send is made to this socket or refused.
    address: ReplyAddress,
    generation: u64,
    provider: String,
    cancel: CancellationToken,
    /// Where the server's verdicts on this run's POSTs arrive (`model/proxy/tail`).
    owner: Arc<OwnerLink>,
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
    settled: broadcast::Sender<ProxyCallSettled>,
}

struct ChannelSink(mpsc::UnboundedSender<ProxyEvent>, Arc<OwnerLink>);

impl ProxyEventSink for ChannelSink {
    fn event(&self, event: ProxyEvent) {
        // Nobody reads any more once the run's answer is going out.
        let _ = self.0.send(event);
    }

    fn owner(&self) -> Option<Arc<OwnerLink>> {
        Some(self.1.clone())
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
            settled: broadcast::channel(64).0,
        })
    }

    /// Every call that ends from now on: answered, failed or abandoned.
    pub fn settled(&self) -> broadcast::Receiver<ProxyCallSettled> {
        self.settled.subscribe()
    }

    fn settle(&self, provider: String, outcome: CallOutcome, failure: Option<ProxyFailure>) {
        // Nobody watching is no failure.
        let _ = self.settled.send(ProxyCallSettled { provider, outcome, failure });
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
            ClientEvent::ServerRequest(ServerRequest::ModelProxyExecute { params, .. }, address) => {
                self.execute(address, params).await;
            }
            ClientEvent::Notification(note) if note.method == CANCEL => {
                let Some(params) = note.params else { return };
                let Ok(ModelProxyCancelParams { request_id }) = serde_json::from_value(params) else { return };
                // A call that is over, or never was, has nothing to stop.
                if let Some(run) = self.state().runs.iter().rev().find(|run| run.address.request_id == request_id) {
                    run.cancel.cancel();
                }
            }
            ClientEvent::Notification(note) if note.method == TAIL => {
                let Some(params) = note.params else { return };
                let Ok(ModelProxyTailParams { request_id, ask, verdict }) = serde_json::from_value(params) else { return };
                // A verdict for a call that is over, or an ask no POST waits on, has nothing to admit.
                let owner = self.state().runs.iter().rev().find(|run| run.address.request_id == request_id).map(|run| run.owner.clone());
                if let Some(owner) = owner {
                    owner.deliver(ask, verdict);
                }
            }
            _ => {}
        }
    }

    /// The server gave these calls up (its link is gone, or its model login changed): stopped, forgotten and left
    /// unanswered. None of them reads or sends anything of this PC's from now on.
    pub fn abandon_all(&self) {
        let abandoned: Vec<Run> = {
            let mut state = self.state();
            if let Some(beat) = state.beat.take() {
                beat.abort();
            }
            std::mem::take(&mut state.runs)
        };
        self.abandoned(abandoned);
    }

    /// The socket ttachment is gone: its calls (and only its) are stopped and left unanswered, each settled once. A send to
    /// it was refused by the client, which is how this learns of it before the link's status does.
    fn abandon_attachment(&self, attachment: AttachmentId) {
        let abandoned: Vec<Run> = {
            let mut state = self.state();
            let (gone, kept): (Vec<Run>, Vec<Run>) = std::mem::take(&mut state.runs).into_iter().partition(|run| run.address.attachment == attachment);
            state.runs = kept;
            if state.runs.is_empty()
                && let Some(beat) = state.beat.take()
            {
                beat.abort();
            }
            gone
        };
        self.abandoned(abandoned);
    }

    fn abandoned(&self, runs: Vec<Run>) {
        for run in runs {
            // The server can no longer judge a POST of this run: one waiting for its verdict is not sent.
            run.owner.close();
            run.cancel.cancel();
            self.settle(run.provider, CallOutcome::Abandoned, None);
        }
    }

    /// The server's model login changed: every call in flight is given up, and the relay takes up new ones again.
    pub fn revoke(&self) {
        self.abandon_all();
    }

    async fn execute(self: &Arc<Self>, address: ReplyAddress, params: ModelProxyExecuteParams) {
        // A server on its own logins takes nothing of this PC's: left unclaimed, the server gives the request up.
        if !self.serving.load(Ordering::SeqCst) {
            return;
        }
        let generation = self.generations.fetch_add(1, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        let provider = match &params.call {
            ProxyCall::Send { provider, .. }
            | ProxyCall::SessionSend { provider, .. }
            | ProxyCall::ListModels { provider, .. }
            | ProxyCall::QuotaUsable { provider, .. }
            | ProxyCall::ResolveWireRoute { provider, .. } => provider.clone(),
            ProxyCall::ProviderConfig => String::new(),
        };
        // The run's events and its asks to the server go out on one channel, in the order they were made.
        let (tx, events) = mpsc::unbounded_channel();
        let owner = OwnerLink::new({
            let tx = tx.clone();
            move |event| {
                let _ = tx.send(event);
            }
        });
        {
            let mut state = self.state();
            state.runs.push(Run { address: address.clone(), generation, provider, cancel: cancel.clone(), owner: owner.clone() });
            if state.beat.is_none() {
                state.beat = Some(self.start_beat());
            }
        }
        // The claim: the server gives a request nobody claimed up after 10 s.
        self.heartbeat(address.attachment, vec![address.request_id.clone()]).await;
        // The claim was refused (its socket is gone): the call was abandoned with it, and the local core never starts it.
        if !self.live(generation) {
            return;
        }
        let allowed = (self.allowed)();
        let relay = self.clone();
        let sink = Arc::new(ChannelSink(tx, owner));
        drop(tokio::spawn(async move { relay.run_call(address, generation, params.call, allowed, cancel, (sink, events)).await }));
    }

    /// One beat on a timer that lives while any call runs: every running request.
    fn start_beat(self: &Arc<Self>) -> JoinHandle<()> {
        let relay = self.clone();
        tokio::spawn(async move {
            loop {
                mixdog_rt::time::sleep(Duration::from_millis(HEARTBEAT_MS)).await;
                let addresses: Vec<ReplyAddress> = relay.state().runs.iter().map(|run| run.address.clone()).collect();
                // One beat per socket, each to its own: a run is vouched for on the socket it was claimed on or not at all.
                let mut sockets: Vec<AttachmentId> = Vec::new();
                for address in &addresses {
                    if !sockets.contains(&address.attachment) {
                        sockets.push(address.attachment);
                    }
                }
                for socket in sockets {
                    let ids: Vec<RequestId> = addresses.iter().filter(|a| a.attachment == socket).map(|a| a.request_id.clone()).collect();
                    relay.heartbeat(socket, ids).await;
                }
            }
        })
    }

    async fn heartbeat(&self, attachment: AttachmentId, request_ids: Vec<RequestId>) {
        self.notify(attachment, HEARTBEAT, &ModelProxyHeartbeatParams { request_ids }).await;
    }

    /// To the socket ttachment names, never to whichever the client has now. A link that is not ready fails the
    /// notification (the server then gives the call up on its own lease); a socket that is gone fails it as stale, and its calls
    /// are abandoned.
    async fn notify<P: serde::Serialize>(&self, attachment: AttachmentId, method: &str, params: &P) {
        if let Ok(params) = serde_json::to_value(params)
            && let Err(ClientError::StaleAttachment) = self.client.notify_on(attachment, method, params).await
        {
            self.abandon_attachment(attachment);
        }
    }

    /// An abandoned run is no longer listed: its events and its answer are not sent.
    fn live(&self, generation: u64) -> bool {
        self.state().runs.iter().any(|run| run.generation == generation)
    }

    async fn forward(&self, address: &ReplyAddress, generation: u64, event: ProxyEvent) {
        if self.live(generation) {
            self.notify(address.attachment, EVENT, &ModelProxyEventParams { request_id: address.request_id.clone(), event }).await;
        }
    }

    async fn run_call(
        self: Arc<Self>,
        address: ReplyAddress,
        generation: u64,
        call: ProxyCall,
        allowed: Option<Vec<String>>,
        cancel: CancellationToken,
        (sink, mut events): (Arc<ChannelSink>, mpsc::UnboundedReceiver<ProxyEvent>),
    ) {
        let local = self.local.clone();
        let owner = sink.1.clone();
        let run = local.run(call, allowed, sink, cancel);
        tokio::pin!(run);
        let outcome = loop {
            tokio::select! {
                biased;
                Some(event) = events.recv() => self.forward(&address, generation, event).await,
                outcome = &mut run => break outcome,
            }
        };
        // The events a run wrote just before it answered come ahead of the answer.
        while let Ok(event) = events.try_recv() {
            self.forward(&address, generation, event).await;
        }
        // The call is over: a request of it that outlived it (a warm of the kept request) can ask its owner nothing.
        owner.close();
        if !self.live(generation) {
            return;
        }
        let (answer, settled, failure) = match outcome {
            Ok(ProxyAnswer::Failed { failure }) => (
                ServerRequestAnswer::Error { code: FAILED_CODE, message: failure.message.clone(), data: serde_json::to_value(&failure).ok() },
                CallOutcome::Failed,
                Some(failure),
            ),
            Ok(result) => match serde_json::to_value(ModelProxyResult { result }) {
                Ok(value) => (ServerRequestAnswer::Result(value), CallOutcome::Answered, None),
                Err(error) => (ServerRequestAnswer::Error { code: FAILED_CODE, message: error.to_string(), data: None }, CallOutcome::Failed, None),
            },
            Err(message) => (ServerRequestAnswer::Error { code: FAILED_CODE, message, data: None }, CallOutcome::Failed, None),
        };
        // Answered at the address the request arrived with. The socket gone: nothing was sent, and this run ends as abandoned (once),
        // not as answered, whatever socket the link has now.
        if let Err(ClientError::StaleAttachment) = self.client.respond(address.clone(), answer).await {
            self.abandon_attachment(address.attachment);
            return;
        }
        let ended = {
            let mut state = self.state();
            let ended = state.runs.iter().position(|run| run.generation == generation).map(|at| state.runs.remove(at));
            if state.runs.is_empty()
                && let Some(beat) = state.beat.take()
            {
                beat.abort();
            }
            ended
        };
        // Abandoned while the answer was going out: settled as abandoned already.
        if let Some(run) = ended {
            self.settle(run.provider, settled, failure);
        }
    }
}

#[cfg(test)]
#[path = "model_proxy_relay_tests.rs"]
mod model_proxy_relay_tests;

#[cfg(test)]
#[path = "model_proxy_relay_race_tests.rs"]
mod model_proxy_relay_race_tests;

#[cfg(test)]
#[path = "model_proxy_tail_tests.rs"]
mod model_proxy_tail_tests;
