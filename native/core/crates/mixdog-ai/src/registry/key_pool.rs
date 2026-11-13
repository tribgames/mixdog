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
//!
//! The same walk serves an OAuth provider's accounts (Node `createAccountPoolProvider`, installed on every account
//! provider at `registry.mjs:234`): [`AccountEngines`] is where an account's engine comes from. A custom provider's
//! keys are engines built with the provider ([`KeyEngines`]); an OAuth provider's accounts are engines built on first
//! use, each on its own account's credential file (`registry/builder.rs`, `OAuthEngines`).

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
use mixdog_core_api::domain::provider::ProviderReplay;
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

/// Where the engine of each roster account comes from, and what of a send belongs to one account.
#[async_trait]
pub trait AccountEngines: Send + Sync {
    /// The roster walk the sends go through; `None` while the host has bound none (the send then goes out on the
    /// provider's own engine, as a provider without a pool sends).
    fn rotation(&self) -> Option<AccountRotation>;
    /// The engine that sends as `account`; `home` is [`Self::home`] as the send began.
    async fn engine(&self, account: &str, home: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError>;
    /// Every account engine that exists now (session and transport releases reach each).
    fn built(&self) -> Vec<Arc<dyn ProviderAdapter>>;
    /// The provider's `accountCooldownPolicy`.
    fn cooldown_policy(&self, _account: &str) -> Option<CooldownPolicy> {
        None
    }
    /// The account that served what carries no account stamp: a message stored before the pool stamped answers, and
    /// the session's provider state.
    async fn home(&self) -> String {
        "default".to_owned()
    }
    /// Whether a replay envelope stays on a message another account served.
    fn keeps_replay(&self, _replay: &ProviderReplay) -> bool {
        false
    }
    /// Whether the session's provider state is one account's (`boundAccountSend` passes it only to the account that
    /// produced it).
    fn state_bound(&self) -> bool {
        false
    }
}

/// A custom provider's keys: the primary engine is `default`, each additional key has an engine built with the provider.
pub struct KeyEngines {
    provider: String,
    primary: Arc<dyn ProviderAdapter>,
    /// `(key id, engine)` of every additional key, in roster order.
    keys: Vec<(String, KeyEngine)>,
    rotation: AccountRotation,
}

#[async_trait]
impl AccountEngines for KeyEngines {
    fn rotation(&self) -> Option<AccountRotation> {
        Some(self.rotation.clone())
    }

    async fn engine(&self, account: &str, _home: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
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

    fn built(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        self.keys.iter().filter_map(|(_, engine)| engine.as_ref().ok().cloned()).collect()
    }

    /// The Chat wire's `reasoningContent` is a field of its own in Node and stays; here it rides the Chat replay
    /// envelope, which is kept.
    fn keeps_replay(&self, replay: &ProviderReplay) -> bool {
        crate::providers::compat::chat::reasoning::replayed(replay).is_some()
    }
}

struct Pool {
    provider: String,
    primary: Arc<dyn ProviderAdapter>,
    engines: Arc<dyn AccountEngines>,
}

pub struct KeyPoolAdapter {
    pool: Arc<Pool>,
}

impl KeyPoolAdapter {
    pub fn new(provider: &str, primary: Arc<dyn ProviderAdapter>, keys: Vec<(String, KeyEngine)>, rotation: AccountRotation) -> Self {
        let engines = Arc::new(KeyEngines { provider: provider.to_owned(), primary: primary.clone(), keys, rotation });
        Self::with_engines(provider, primary, engines)
    }

    /// A pool over `engines`: `primary` answers everything but the send.
    pub fn with_engines(provider: &str, primary: Arc<dyn ProviderAdapter>, engines: Arc<dyn AccountEngines>) -> Self {
        Self { pool: Arc::new(Pool { provider: provider.to_owned(), primary, engines }) }
    }
}

impl Pool {
    /// `customKeyServedBy` / `replayAccount`: the account a message's stored routing names for this provider, else `home`.
    fn served_by<'a>(&self, message: &'a Message, home: &'a str) -> &'a str {
        match &message.account_routing {
            Some(routing) if routing.provider == self.provider => &routing.account_id,
            _ => home,
        }
    }

    /// `boundAccountSend`'s history and state: a message another account served goes without its replay state (Node
    /// drops `providerReplay`, `reasoning` and `thinkingBlocks`), and an account that is not the session's own sends
    /// without the session's provider state.
    fn history_for(&self, request: &Arc<ModelRequest>, account: &str, home: &str) -> Arc<ModelRequest> {
        let foreign_state = self.engines.state_bound() && account != home && request.options.provider_state.is_some();
        if !foreign_state && request.messages.iter().all(|m| self.served_by(m, home) == account) {
            return request.clone();
        }
        let mut owned = (**request).clone();
        if foreign_state {
            owned.options.provider_state = None;
        }
        for message in &mut owned.messages {
            if self.served_by(message, home) != account {
                message.thinking_blocks = None;
                message.retain_replay(|r| self.engines.keeps_replay(r));
            }
        }
        Arc::new(owned)
    }
}

pub(super) fn plain(kind: ErrorKind, code: Option<&str>, message: String) -> ProviderError {
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
    /// [`AccountEngines::home`] as the send began.
    home: String,
}

#[async_trait]
impl AccountSender<()> for KeySend {
    fn cooldown_policy(&self, account: &str) -> Option<CooldownPolicy> {
        self.pool.engines.cooldown_policy(account)
    }

    async fn send(&self, account: &str, _scoped: bool) -> Result<(), Failed> {
        // The pool's notice of the previous refusal reaches the caller before this key's request goes out.
        taken(&self.queue).await;
        let engine = self.pool.engines.engine(account, &self.home).await.map_err(Failed::new)?;
        let request = self.pool.history_for(&self.request, account, &self.home);
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
    // A send's retry ladder and its recovery are the provider's, whichever account serves it. The re-issue after a
    // spent ladder or a cut stream goes out on the provider's current account.
    fn retry_policy_for(&self, model: &str) -> &RetryPolicy {
        self.pool.primary.retry_policy_for(model)
    }
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        self.pool.primary.retry_policy_of(request)
    }
    fn recovers_spent(&self, model: &str, failure: &ProviderError) -> bool {
        self.pool.primary.recovers_spent(model, failure)
    }
    fn recovers_cut(&self, model: &str, failure: &ProviderError) -> bool {
        self.pool.primary.recovers_cut(model, failure)
    }
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.pool.primary.recover_spent(request).await
    }
    fn recovery_line(&self, model: &str, failure: &ProviderError) -> Option<String> {
        self.pool.primary.recovery_line(model, failure)
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
    // The engine that served a send is one of the accounts': what is held for a send, a session or a transport scope
    // is released on each.
    fn release_send(&self, group: &str) {
        self.pool.primary.release_send(group);
        for engine in self.pool.engines.built() {
            engine.release_send(group);
        }
    }
    async fn settle_send(&self, group: &str, end: SendEnd) {
        for engine in self.pool.engines.built() {
            engine.settle_send(group, end).await;
        }
        self.pool.primary.settle_send(group, end).await;
    }
    fn release_session(&self, session_id: &str) {
        self.pool.primary.release_session(session_id);
        for engine in self.pool.engines.built() {
            engine.release_session(session_id);
        }
    }
    fn release_transport_scope(&self, scope: &str) {
        self.pool.primary.release_transport_scope(scope);
        for engine in self.pool.engines.built() {
            engine.release_transport_scope(scope);
        }
    }
    fn native_pdf(&self) -> bool {
        self.pool.primary.native_pdf()
    }
    fn send_stages(&self, model: &str) -> mixdog_core_api::domain::provider::SendStages {
        self.pool.primary.send_stages(model)
    }
    fn retry_line(&self, model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.pool.primary.retry_line(model)
    }
    async fn prepare_send(&self, request: &ModelRequest) {
        self.pool.primary.prepare_send(request).await;
    }
    fn send_stages_of(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::SendStages {
        self.pool.primary.send_stages_of(request)
    }
    fn retry_line_of(&self, request: &ModelRequest) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        self.pool.primary.retry_line_of(request)
    }
    fn native_documents(&self) -> Option<bool> {
        self.pool.primary.native_documents()
    }
    fn input_excludes_cache(&self) -> Option<bool> {
        self.pool.primary.input_excludes_cache()
    }
    async fn media_support(&self, request: &ModelRequest) -> mixdog_core_api::domain::provider::MediaSupport {
        self.pool.primary.media_support(request).await
    }
    async fn takes_vision(&self, request: &ModelRequest) -> bool {
        self.pool.primary.takes_vision(request).await
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&JsonValue>) -> Option<FirstResponseBudget> {
        self.pool.primary.first_response_budget(model, parameters)
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.pool.primary.cache_warm()
    }
    /// A walk that ends before any event is the attempt's own refusal; otherwise the events follow.
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let Some(rotation) = self.pool.engines.rotation() else {
            return self.pool.primary.attempt(request).await;
        };
        let home = self.pool.engines.home().await;
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
        let sender = KeySend { pool: pool.clone(), request, queue: queue.clone(), home };
        let walk: Walk = Box::pin(async move {
            rotation.pool_send(&pool.provider, &context, &sender).await.map_err(pool_error)
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

#[cfg(test)]
#[path = "key_pool_account_tests.rs"]
mod account_tests;
