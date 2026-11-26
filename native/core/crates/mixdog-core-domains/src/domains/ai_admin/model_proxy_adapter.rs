//! The server's stand-in for a PC provider in the model-proxy client mode (`MIXDOG_MODEL_PROXY=client`).
//! It holds no credentials and opens no model connection: every attempt is one call of the PC's provider
//! of the same name ([`remote_send`]), whose events stream back as this attempt's.
//!
//! - A failure that comes back is final for the PC's retry ladder, so every one is marked
//!   `should_retry: Some(false)`; recoveries that change the request still run here.
//! - A retry on the PC voids what its failed attempt streamed (`AttemptDiscarded`): events that would
//!   change this attempt's answer are held until the PC's attempt shows output or ends.
//! - A request whose transcript a session here owns goes as a session send, its prompt cache judged here.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use mixdog_ai::broker::{AttemptSink, ModelProxyTransport, SendError};
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::{CancellationToken, DropGuard};

use super::model_proxy::{ProxyListing, ask_pc, budget_in, pc_left, remote_send, transient};

/// The registry's builder in the client mode: every name the PC reports is a [`ProxiedAdapter`] with the traits the PC
/// reported for it (`createModelProxyProvider(name, cfg)`).
pub struct ProxiedBuilder {
    transport: Arc<dyn ModelProxyTransport>,
    attachments: Arc<dyn AttachmentReader>,
}

impl ProxiedBuilder {
    pub fn new(transport: Arc<dyn ModelProxyTransport>, attachments: Arc<dyn AttachmentReader>) -> Self {
        Self { transport, attachments }
    }
}

#[async_trait]
impl ProviderBuilder for ProxiedBuilder {
    async fn build(&self, name: &str, config: &Value) -> Result<Arc<dyn p::ProviderAdapter>, String> {
        let traits =
            config.get("modelProxy").cloned().map(serde_json::from_value::<w::ProxyTraits>).transpose().map_err(|e| e.to_string())?.unwrap_or_default();
        Ok(Arc::new(ProxiedAdapter::new(name, traits, self.transport.clone(), self.attachments.clone())))
    }

    /// A custom provider's keys are the PC's roster.
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    /// The PC decides what is on (`providerAvailable` is true in this mode).
    fn available(&self, _: &str) -> bool {
        true
    }

    /// This server holds no credential: a provider is registered only from what the PC reports.
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// One PC provider, as this server sends to it.
pub struct ProxiedAdapter {
    id: ProviderId,
    traits: w::ProxyTraits,
    transport: Arc<dyn ModelProxyTransport>,
    attachments: Arc<dyn AttachmentReader>,
    listing: ProxyListing,
    routing: ProxyRouting,
    /// Node's ModelProxyProvider has no `retryPolicy`: the loop reads a provider's without a profile.
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: NoCodec,
}

impl ProxiedAdapter {
    pub fn new(name: &str, traits: w::ProxyTraits, transport: Arc<dyn ModelProxyTransport>, attachments: Arc<dyn AttachmentReader>) -> Self {
        Self {
            id: ProviderId::from(name),
            traits,
            listing: ProxyListing::new(transport.clone(), name.to_owned()),
            routing: ProxyRouting { transport: transport.clone(), provider: name.to_owned(), single: Mutex::default() },
            transport,
            attachments,
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: NoCodec,
        }
    }
}

#[async_trait]
impl p::ProviderAdapter for ProxiedAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn p::WireCodec {
        &self.codec
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    /// One call of the PC: the stream opens with the first event it hands out, or with the call's end; a call that failed
    /// before handing out any is the attempt's failure. What the PC may still void (a retried attempt's discard, the events
    /// held until its attempt shows output) opens nothing: none of it belongs to the attempt the call ends on.
    async fn attempt(&self, request: Arc<p::ModelRequest>) -> Result<Box<dyn p::ModelStream>, p::ProviderError> {
        let (tell, heard) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let (transport, attachments, provider, given_up) = (self.transport.clone(), self.attachments.clone(), self.id.as_str().to_owned(), cancel.clone());
        // On a task of its own, so the call's lease and its back-channel run whether or not the stream is being read; the
        // stream's drop gives the call up.
        drop(mixdog_rt::spawn("model-proxy.send", mixdog_rt::TaskClass::Work, async move {
            let mut sink = Forward(tell.clone());
            let sent = remote_send(transport.as_ref(), attachments.as_ref(), &provider, &request, &mut sink, &given_up).await;
            let _ = tell.send(Heard::End(sent));
        }));
        let mut stream = ProxiedStream {
            heard,
            attempt: Held::default(),
            out: VecDeque::new(),
            end: None,
            left: None,
            terminal_out: false,
            finished: false,
            _call: cancel.drop_guard(),
        };
        while stream.out.is_empty() && stream.end.is_none() {
            match stream.heard.recv().await {
                Some(Heard::End(Err(error))) if stream.attempt.events.is_empty() => return Err(failure(error)),
                Some(heard) => stream.hear(heard),
                None => return Err(lost()),
            }
        }
        Ok(Box::new(stream))
    }

    fn models(&self) -> Option<&dyn p::ModelListing> {
        Some(&self.listing)
    }

    fn wire_routing(&self) -> Option<&dyn p::WireRouting> {
        Some(&self.routing)
    }

    /// The PC's broker opens and ends a send group of its own for each call.
    fn release_send(&self, _: &str) {}

    fn native_pdf(&self) -> bool {
        self.traits.native_pdf != Some(false)
    }

    fn input_excludes_cache(&self) -> Option<bool> {
        self.traits.input_excludes_cache
    }

    async fn takes_vision(&self, _: &p::ModelRequest) -> bool {
        self.traits.takes_images != Some(false)
    }

    /// The PC catalog's figure for `model`, else the PC adapter's own (`firstResponseBudget`).
    fn first_response_budget(&self, model: &str, _: Option<&Value>) -> Option<p::FirstResponseBudget> {
        self.listing.budget(model).or_else(|| budget_in(self.traits.first_response_budget?))
    }
}

/// `resolveWireRoute(model, { agent, legacy })`: the PC adapter's wire for a model. A model the PC routes on no wire of its
/// own (a single-wire adapter) is remembered, so later sends skip the round trip.
struct ProxyRouting {
    transport: Arc<dyn ModelProxyTransport>,
    provider: String,
    single: Mutex<HashSet<String>>,
}

#[async_trait]
impl p::WireRouting for ProxyRouting {
    async fn resolve_wire_route(&self, model: &str, context: &p::WireRouteContext) -> Result<Option<p::WireRoute>, p::ProviderError> {
        if self.single.lock().unwrap_or_else(PoisonError::into_inner).contains(model) {
            return Ok(None);
        }
        let call = w::ProxyCall::ResolveWireRoute {
            provider: self.provider.clone(),
            model: model.to_owned(),
            context: w::ProxyRouteContext { agent: context.agent, legacy: context.legacy },
        };
        let call = serde_json::to_value(call).map_err(|e| transient(&e.to_string(), p::DeliveryState::NotSent))?;
        let answer = ask_pc(self.transport.as_ref(), call).await?;
        let route = match serde_json::from_value::<w::ProxyAnswer>(answer) {
            Ok(w::ProxyAnswer::Route { route }) => route,
            _ => return Err(transient("model proxy answered a wire route with another result", p::DeliveryState::Ambiguous)),
        };
        let Some(route) = route else {
            self.single.lock().unwrap_or_else(PoisonError::into_inner).insert(model.to_owned());
            return Ok(None);
        };
        let name = |value: Value| value.as_str().unwrap_or_default().to_owned();
        Ok(Some(p::WireRoute {
            wire: name(serde_json::to_value(route.wire).unwrap_or_default()),
            source: name(serde_json::to_value(route.source).unwrap_or_default()),
            profile_id: route.profile_id,
        }))
    }
}

/// What the call's task tells the stream.
enum Heard {
    Event(p::StreamEvent),
    /// The PC's attempt failed and its broker retries: what that attempt streamed is void.
    Discard,
    End(Result<u32, SendError>),
}

struct Forward(mpsc::UnboundedSender<Heard>);

impl AttemptSink for Forward {
    fn event(&mut self, event: p::StreamEvent) {
        // The stream is gone: nobody reads the call any more, and its drop gave the call up.
        let _ = self.0.send(Heard::Event(event));
    }

    fn discard(&mut self) {
        let _ = self.0.send(Heard::Discard);
    }

    // A retried attempt the provider billed is booked by the PC's own ledger; this server books the answer it was given,
    // as Node's accounting wrapper of the stand-in did.
}

/// The events of the PC's attempt in progress that this attempt's answer folds, held while the PC may still void them.
#[derive(Default)]
struct Held {
    events: Vec<p::StreamEvent>,
    /// The PC's attempt has shown output: its broker no longer retries it.
    shown: bool,
}

struct ProxiedStream {
    heard: mpsc::UnboundedReceiver<Heard>,
    attempt: Held,
    out: VecDeque<p::StreamEvent>,
    end: Option<Result<(), p::ProviderError>>,
    left: Option<Arc<dyn Fn() + Send + Sync>>,
    /// The wire's terminal event was handed out: what follows is the call's answer, not the wire.
    terminal_out: bool,
    /// The call's end was handed out.
    finished: bool,
    _call: DropGuard,
}

/// Whether the answer folds `event` (`ResponseBuilder::push`), so a discarded attempt's copy would stay in it.
fn folds(event: &p::StreamEvent) -> bool {
    use p::StreamEvent as E;
    match event {
        E::ReasoningReplay(_)
        | E::FinalContent(_)
        | E::ReturnedCalls(_)
        | E::ThinkingBlocks(_)
        | E::Usage(_)
        | E::ProviderState(_)
        | E::ServedModel(_)
        | E::ProviderMetadata(_)
        | E::AccountRouting(_)
        | E::ContentSummary { .. }
        | E::ServerToolBlock(_) => true,
        E::TextDelta(_)
        | E::ReasoningDelta(_)
        | E::ProgressDelta(_)
        | E::ToolCallStart { .. }
        | E::ToolCallIdRenamed { .. }
        | E::ToolCallArgsDelta { .. }
        | E::ToolCallDone(_)
        | E::Completed { .. }
        | E::ItemStart { .. }
        | E::Refusal(_)
        | E::Citation(_)
        | E::ProviderKeepalive
        | E::Progress(_)
        | E::ChunkProgress(_)
        | E::Notice { .. }
        | E::ResponseId(_)
        | E::AccountStage(_)
        | E::WireRerouted(_)
        | E::OutputStarted => false,
    }
}

/// Whether the PC's attempt is past what its broker retries: text or reasoning shown, a tool call begun, or the answer.
fn settles(event: &p::StreamEvent) -> bool {
    matches!(
        event,
        p::StreamEvent::TextDelta(_)
            | p::StreamEvent::ReasoningDelta(_)
            | p::StreamEvent::ProgressDelta(_)
            | p::StreamEvent::ToolCallStart { .. }
            | p::StreamEvent::ToolCallArgsDelta { .. }
            | p::StreamEvent::ToolCallDone(_)
            | p::StreamEvent::Completed { .. }
    )
}

/// The call's task ended without a word: the link to the PC is gone.
fn lost() -> p::ProviderError {
    final_failure(transient(pc_left(), p::DeliveryState::Ambiguous))
}

/// The PC's broker already ran the provider's ladder on this failure.
fn final_failure(mut error: p::ProviderError) -> p::ProviderError {
    error.should_retry = Some(false);
    error
}

impl ProxiedStream {
    fn hear(&mut self, heard: Heard) {
        match heard {
            Heard::Event(event) if !self.attempt.shown && folds(&event) => self.attempt.events.push(event),
            Heard::Event(event) => {
                if settles(&event) && !self.attempt.shown {
                    self.attempt.shown = true;
                    self.out.extend(self.attempt.events.drain(..));
                }
                self.out.push_back(event);
            }
            Heard::Discard => self.attempt = Held::default(),
            Heard::End(sent) => {
                self.out.extend(self.attempt.events.drain(..));
                self.end = Some(sent.map(drop).map_err(failure));
            }
        }
    }
}

/// How a call that failed ends this attempt.
fn failure(error: SendError) -> p::ProviderError {
    final_failure(match error {
        SendError::Provider(error) | SendError::Exhausted(error) => error,
        // The PC's ladder ended on repeated overload and names the model to send again with: the loop's decider switches.
        SendError::Fallback { model, mut last } => {
            last.fallback_model = Some(model.into());
            last
        }
        // The stream is alive, so this end did not give the call up: the link to the PC went.
        SendError::Cancelled => return lost(),
        SendError::Admission(error) => transient(&format!("{error:?}"), p::DeliveryState::NotSent),
    })
}

#[async_trait]
impl p::ModelStream for ProxiedStream {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        loop {
            if let Some(event) = self.out.pop_front() {
                self.terminal_out |= matches!(event, p::StreamEvent::Completed { .. });
                return Some(Ok(event));
            }
            if self.finished {
                return None;
            }
            if let Some(end) = self.end.take() {
                self.finished = true;
                return end.err().map(Err);
            }
            if self.terminal_out
                && let Some(left) = self.left.take()
            {
                left();
            }
            match self.heard.recv().await {
                Some(heard) => self.hear(heard),
                None => self.end = Some(Err(lost())),
            }
        }
    }

    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        self.left = Some(left);
    }
}

/// The wire of a proxied provider is the PC's: nothing of it is built here.
struct NoCodec;

const BUILT_ON_THE_PC: &str = "a model proxy provider's request is built on the PC that runs it";

impl p::WireCodec for NoCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }

    fn image_branch(&self, _: &p::ModelRequest) -> mixdog_image_egress::route::WireBranch {
        mixdog_image_egress::route::WireBranch::CompatChat
    }

    fn encode(&self, _: &p::ModelRequest) -> Result<p::WireRequest, p::ProviderError> {
        Err(transient(BUILT_ON_THE_PC, p::DeliveryState::NotSent))
    }

    fn decoder(&self, _: &p::ModelRequest) -> Box<dyn p::WireDecoder> {
        Box::new(NoDecoder)
    }

    fn classify(&self, _: &p::ErrorResponse) -> p::ProviderError {
        transient(BUILT_ON_THE_PC, p::DeliveryState::Ambiguous)
    }
}

struct NoDecoder;

impl p::WireDecoder for NoDecoder {
    fn feed(&mut self, _: &[u8]) -> Result<Vec<p::StreamEvent>, p::ProviderError> {
        Err(transient(BUILT_ON_THE_PC, p::DeliveryState::Ambiguous))
    }

    fn finish(&mut self) -> Result<Vec<p::StreamEvent>, p::ProviderError> {
        Err(transient(BUILT_ON_THE_PC, p::DeliveryState::Ambiguous))
    }

    fn terminal_seen(&self) -> bool {
        false
    }

    fn exposure(&self) -> p::Exposure {
        p::Exposure::default()
    }
}

#[cfg(test)]
#[path = "model_proxy_adapter_tests.rs"]
mod tests;
