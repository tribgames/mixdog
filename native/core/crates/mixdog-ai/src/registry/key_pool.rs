//! A custom provider's API keys as one roster (Node `createCustomKeyPoolProvider`, `account-pool.mjs`): the primary
//! engine is the `default` account and answers everything but the send; each additional key sends through an engine
//! of its own (`customKeyEngine`) built on the same configuration. A send walks the roster by the pool's rule
//! ([`AccountRotation::pool_send`]): an explicit quota refusal blocks the key for the model and moves on to the next
//! key, a refusal of any other kind ends the send, and a refusal after output started is never re-sent.
//!
//! As in Node, a key's attempt is the whole answer, not its first bytes: the pool judges a refusal that ends the
//! stream after output, stamps the serving key and publishes the committed change only once the answer is complete.
//! The caller reads the attempt's events as they arrive; the walk pauses after each one until the caller has taken
//! it, so the pool's notices land between the requests exactly where Node's callbacks run.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::task::Poll;
use std::task::Waker;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::AccountRouting;
use mixdog_core_api::domain::provider::AccountStage;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRouting;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value as JsonValue;
use tokio_util::sync::CancellationToken;

use crate::accounts::rotation::AccountRotation;
use crate::accounts::rotation::AccountSender;
use crate::accounts::rotation::Cause;
use crate::accounts::rotation::CooldownPolicy;
use crate::accounts::rotation::Failed;
use crate::accounts::rotation::PoolError;
use crate::accounts::rotation::SendContext;
use crate::accounts::rotation::Stage;

/// An additional key's engine, or why it cannot send (`customKeyEngine` throws when the key is not readable).
pub type KeyEngine = Result<Arc<dyn ProviderAdapter>, String>;

/// A custom provider's key has no plan usage to re-measure.
pub struct NoMeter;

#[async_trait]
impl crate::accounts::rotation::UsageProbe for NoMeter {
    async fn measure(&self, _: &str, _: &str, _: bool) {}
}

struct Pool {
    provider: String,
    primary: Arc<dyn ProviderAdapter>,
    /// `(key id, engine)` of every additional key, in roster order.
    keys: Vec<(String, KeyEngine)>,
    rotation: AccountRotation,
}

pub struct KeyPoolAdapter {
    pool: Arc<Pool>,
}

impl KeyPoolAdapter {
    pub fn new(provider: &str, primary: Arc<dyn ProviderAdapter>, keys: Vec<(String, KeyEngine)>, rotation: AccountRotation) -> Self {
        Self { pool: Arc::new(Pool { provider: provider.to_owned(), primary, keys, rotation }) }
    }
}

impl Pool {
    fn engine(&self, account: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        if account == "default" {
            return Ok(self.primary.clone());
        }
        match self.keys.iter().find(|(id, _)| id == account).map(|(_, engine)| engine) {
            Some(Ok(engine)) => Ok(engine.clone()),
            Some(Err(message)) => Err(plain(ErrorKind::Unknown, None, message.clone())),
            None => Err(plain(
                ErrorKind::Unknown,
                None,
                format!("An additional API key of {} is not readable; enter it again in its settings.", self.provider),
            )),
        }
    }

    /// `customKeyServedBy`: the key a message's stored routing names for this provider, else the primary's.
    fn served_by<'a>(&self, message: &'a Message) -> &'a str {
        match &message.account_routing {
            Some(routing) if routing.provider == self.provider => &routing.account_id,
            _ => "default",
        }
    }

    /// `boundAccountSend`'s history: a message another key served goes without its replay state (Node drops
    /// `providerReplay`, `reasoning` and `thinkingBlocks`). The Chat wire's `reasoningContent` is a field of its own
    /// in Node and stays; here it rides the Chat replay envelope, which is kept.
    fn history_for(&self, request: &Arc<ModelRequest>, account: &str) -> Arc<ModelRequest> {
        if request.messages.iter().all(|m| self.served_by(m) == account) {
            return request.clone();
        }
        let mut owned = (**request).clone();
        for message in &mut owned.messages {
            if self.served_by(message) != account {
                message.thinking_blocks = None;
                message.retain_replay(|r| crate::providers::compat::chat::reasoning::replayed(r).is_some());
            }
        }
        Arc::new(owned)
    }
}

fn plain(kind: ErrorKind, code: Option<&str>, message: String) -> ProviderError {
    let mut error = ProviderError::new(kind, DeliveryState::NotSent);
    error.code = code.map(str::to_owned);
    error.message = message;
    error
}

/// What a pool that ended without an answer throws (`accountsExhaustedError`, `accountsCoolingDownError`, or the
/// error that ended the send).
fn pool_error(error: PoolError) -> ProviderError {
    let message = error.message();
    match error.cause {
        // `quotaExhausted`: the pool's proof that no key can serve the model decides the kind
        // (`describeProviderErrorKind`), and its reset stands in when the refusal stamped none.
        Cause::Provider(mut provider) => {
            if let Some(proof) = &error.quota_exhausted {
                provider.kind = ErrorKind::QuotaExhausted;
                if provider.reset_at.is_none() {
                    provider.reset_at = proof
                        .reset_at
                        .and_then(|ms| u64::try_from(ms).ok())
                        .map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
                }
            }
            provider
        }
        Cause::AccountsExhausted { .. } => plain(ErrorKind::QuotaExhausted, Some("provider_accounts_exhausted"), message),
        Cause::CoolingDown { retry_after_ms } => {
            let mut cooling = plain(ErrorKind::RateLimited, Some("rate_limited"), message);
            cooling.retry_after = retry_after_ms.and_then(|ms| u64::try_from(ms).ok()).map(std::time::Duration::from_millis);
            cooling
        }
        Cause::Cancelled | Cause::Message(_) | Cause::Store(_) => plain(ErrorKind::Unknown, None, message),
    }
}

/// The events of the send not yet taken by the caller.
struct Shared {
    queue: VecDeque<StreamEvent>,
    /// The walk waiting for the caller to take an event.
    waiting: Option<Waker>,
    /// The serving attempt's `Completed`, released after the pool's own stamp and notices.
    completed: Option<StreamEvent>,
    delivery: DeliveryState,
    /// The consumer's [`ModelStream::on_wire_left`], handed to each attempt's stream and called once the serving
    /// attempt's `Completed` is in: the pool then binds the serving key before it releases that `Completed`.
    wire_left: Option<Arc<dyn Fn() + Send + Sync>>,
    /// The serving attempt's `Completed` came in before the consumer gave `wire_left`.
    wire_done: bool,
}

/// The serving attempt's wire is done: tells the consumer now, or as it hands its callback over.
fn leave_wire(queue: &Queue) {
    let left = {
        let mut shared = lock(queue);
        shared.wire_done = true;
        shared.wire_left.clone()
    };
    if let Some(left) = left {
        left();
    }
}

type Queue = Arc<Mutex<Shared>>;

fn lock(queue: &Queue) -> std::sync::MutexGuard<'_, Shared> {
    queue.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Queues `event` and returns once the caller has taken every queued event.
async fn hand_over(queue: &Queue, event: StreamEvent) {
    lock(queue).queue.push_back(event);
    taken(queue).await;
}

/// Returns once the caller has taken every queued event.
async fn taken(queue: &Queue) {
    std::future::poll_fn(|cx| {
        let mut shared = lock(queue);
        if shared.queue.is_empty() {
            Poll::Ready(())
        } else {
            shared.waiting = Some(cx.waker().clone());
            Poll::Pending
        }
    })
    .await;
}

/// Output the caller was shown (`boundAccountSend`'s `emitted`: stream, text, tool-call and thinking callbacks).
fn shows_output(event: &StreamEvent) -> bool {
    matches!(
        event,
        StreamEvent::TextDelta(_)
            | StreamEvent::ReasoningDelta(_)
            | StreamEvent::ToolCallStart { .. }
            | StreamEvent::ToolCallArgsDelta { .. }
            | StreamEvent::ToolCallDone(_)
            | StreamEvent::Progress(_)
    )
}

/// One key-bound attempt of the send.
struct KeySend {
    pool: Arc<Pool>,
    request: Arc<ModelRequest>,
    queue: Queue,
}

#[async_trait]
impl AccountSender<()> for KeySend {
    /// A custom provider's engines declare no cooldown policy.
    fn cooldown_policy(&self, _: &str) -> Option<CooldownPolicy> {
        None
    }

    async fn send(&self, account: &str, _scoped: bool) -> Result<(), Failed> {
        // The pool's notice of the previous refusal reaches the caller before this key's request goes out.
        taken(&self.queue).await;
        let engine = self.pool.engine(account).map_err(Failed::new)?;
        let request = self.pool.history_for(&self.request, account);
        let mut stream = engine.attempt(request).await.map_err(|error| {
            let unsafe_to_retry = error.unsafe_to_retry;
            Failed { unsafe_to_retry, ..Failed::new(error) }
        })?;
        if let Some(left) = lock(&self.queue).wire_left.clone() {
            stream.on_wire_left(left);
        }
        let mut emitted = false;
        loop {
            let item = stream.next().await;
            lock(&self.queue).delivery = stream.delivery();
            match item {
                None => return Ok(()),
                Some(Ok(event @ StreamEvent::Completed { .. })) => {
                    lock(&self.queue).completed = Some(event);
                    // The pool goes on to bind the serving key (`pool_send`'s store work) before `Completed` is released.
                    leave_wire(&self.queue);
                    return Ok(());
                }
                Some(Ok(event)) => {
                    emitted |= shows_output(&event);
                    hand_over(&self.queue, event).await;
                }
                Some(Err(error)) => {
                    let unsafe_to_retry = error.unsafe_to_retry;
                    return Err(Failed { emitted, unsafe_to_retry, ..Failed::new(error) });
                }
            }
        }
    }

    /// `recordServingAccount`: the answer names the key that served it and the one the session stays bound to.
    fn stamp(&self, _: &mut (), account: &str, binding: &str) {
        let routing = AccountRouting {
            provider: self.pool.provider.clone(),
            account_id: account.to_owned(),
            session_account_id: Some(binding.to_owned()),
        };
        lock(&self.queue).queue.push_back(StreamEvent::AccountRouting(routing));
    }

    fn notify(&self, stage: Stage) {
        let stage = match stage {
            Stage::Reconnecting { message, .. } => AccountStage::Switching { message },
            Stage::AccountChanged { provider, account_id, at } => AccountStage::Changed { provider, account_id, at },
        };
        lock(&self.queue).queue.push_back(StreamEvent::AccountStage(stage));
    }
}

type Walk = Pin<Box<dyn Future<Output = Result<(), ProviderError>> + Send>>;

/// The send's events: each attempt's as it arrives, the pool's notices in between, the serving attempt's
/// `Completed` last.
struct KeyStream {
    walk: Option<Walk>,
    queue: Queue,
    failure: Option<ProviderError>,
}

impl KeyStream {
    /// Runs the walk until an event is queued or the walk ends.
    async fn advance(&mut self) {
        let Some(walk) = self.walk.as_mut() else { return };
        let queue = self.queue.clone();
        let ended = std::future::poll_fn(|cx| match walk.as_mut().poll(cx) {
            Poll::Ready(result) => Poll::Ready(Some(result)),
            Poll::Pending if !lock(&queue).queue.is_empty() => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        })
        .await;
        if let Some(result) = ended {
            self.walk = None;
            match result {
                Ok(()) => {
                    let mut shared = lock(&self.queue);
                    if let Some(completed) = shared.completed.take() {
                        shared.queue.push_back(completed);
                    }
                }
                Err(error) => self.failure = Some(error),
            }
        }
    }
}

#[async_trait]
impl ModelStream for KeyStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            {
                let mut shared = lock(&self.queue);
                if let Some(event) = shared.queue.pop_front() {
                    if shared.queue.is_empty()
                        && let Some(waker) = shared.waiting.take()
                    {
                        waker.wake();
                    }
                    return Some(Ok(event));
                }
            }
            if self.walk.is_none() {
                return self.failure.take().map(Err);
            }
            self.advance().await;
        }
    }

    fn delivery(&self) -> DeliveryState {
        lock(&self.queue).delivery.clone()
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        let done = {
            let mut shared = lock(&self.queue);
            shared.wire_left = Some(Arc::clone(&left));
            shared.wire_done
        };
        if done {
            left();
        }
    }
}

#[async_trait]
impl ProviderAdapter for KeyPoolAdapter {
    fn id(&self) -> &ProviderId {
        self.pool.primary.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.pool.primary.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.pool.primary.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.pool.primary.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.pool.primary.models()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.pool.primary.wire_routing()
    }
    async fn settle_send(&self, group: &str, end: SendEnd) {
        self.pool.primary.settle_send(group, end).await;
    }
    fn release_session(&self, session_id: &str) {
        self.pool.primary.release_session(session_id);
        for engine in self.pool.keys.iter().filter_map(|(_, engine)| engine.as_ref().ok()) {
            engine.release_session(session_id);
        }
    }
    fn release_transport_scope(&self, scope: &str) {
        self.pool.primary.release_transport_scope(scope);
        for engine in self.pool.keys.iter().filter_map(|(_, engine)| engine.as_ref().ok()) {
            engine.release_transport_scope(scope);
        }
    }
    fn native_pdf(&self) -> bool {
        self.pool.primary.native_pdf()
    }
    fn native_documents(&self) -> Option<bool> {
        self.pool.primary.native_documents()
    }
    async fn media_support(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::MediaSupport {
        self.pool.primary.media_support(request).await
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&JsonValue>) -> Option<FirstResponseBudget> {
        self.pool.primary.first_response_budget(model, parameters)
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.pool.primary.cache_warm()
    }
    /// A walk that ends before any event is the attempt's own refusal; otherwise the events follow.
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let queue: Queue = Arc::new(Mutex::new(Shared {
            queue: VecDeque::new(),
            waiting: None,
            completed: None,
            delivery: DeliveryState::NotSent,
            wire_left: None,
            wire_done: false,
        }));
        let context = SendContext {
            model: request.model.clone(),
            session_id: request.options.session_id.clone(),
            // `sessionAccountId`'s history read: the newest message this provider's pool routed.
            bound_hint: request.messages.iter().rev().find_map(|m| {
                let routing = m.account_routing.as_ref().filter(|r| r.provider == self.pool.provider)?;
                Some(routing.session_account_id.clone().unwrap_or_else(|| routing.account_id.clone()))
            }),
            cancel: CancellationToken::new(),
            implicit_plan_usage: None,
        };
        let pool = self.pool.clone();
        let sender = KeySend { pool: pool.clone(), request, queue: queue.clone() };
        let walk: Walk = Box::pin(async move {
            pool.rotation.pool_send(&pool.provider, &context, &sender).await.map_err(pool_error)
        });
        let mut stream = KeyStream { walk: Some(walk), queue, failure: None };
        stream.advance().await;
        if lock(&stream.queue).queue.is_empty()
            && let Some(error) = stream.failure.take()
        {
            return Err(error);
        }
        Ok(Box::new(stream))
    }
}
