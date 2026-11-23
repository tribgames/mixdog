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
//!
//! Every request the pool hands an engine (an attempt, the re-issue after a spent ladder, a cache warm) goes out on the
//! engine pinned to one roster row ([`AccountEngines::pinned`]): the row is chosen once per request, its credential is
//! fixed for the whole request, refreshes and re-reads included, and the state and message replay it is sent, the state
//! it leaves and the routing its answer is stamped with are that row's, as Node keys them (`boundAccountSend`:
//! `servedBy(...) === row.id`, `recordServingAccount` stamps `accountId: id`). The provider's own engine, which resolves
//! the current account at each read of its credential, never sends: the roster's selection moving while a request is
//! out cannot mix two rows' credential and state.

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
use mixdog_core_api::domain::provider::ListedRoster;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::domain::provider::RosterIdentity;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::SentOn;
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

/// `recordServingAccount`'s stamp on a provider state: the row that produced it, for the provider it served.
const STATE_ACCOUNT: &str = "providerAccountId";
const STATE_PROVIDER: &str = "providerAccountProvider";

/// `state`, which `account` reported, stamped as that row's.
fn stamped(mut state: ProviderState, provider: &str, account: &str) -> ProviderState {
    state.rest.insert(STATE_PROVIDER.to_owned(), provider.into());
    state.rest.insert(STATE_ACCOUNT.to_owned(), account.into());
    state
}

/// An additional key's engine, fixed to that key, or why it cannot send (`customKeyEngine` throws when the key is not
/// readable).
pub type KeyEngine = Result<Arc<dyn ProviderAdapter>, String>;

/// The key a custom provider's own configuration names, read anew for each request (settings, environment, keychain).
#[async_trait]
pub trait OwnKey: Send + Sync {
    /// An engine fixed to the key the configuration resolves to now.
    async fn pinned(&self) -> Result<Arc<dyn ProviderAdapter>, ProviderError>;
    /// The engine [`Self::pinned`] last handed out (session and transport releases reach it).
    fn built(&self) -> Option<Arc<dyn ProviderAdapter>>;
}

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
    /// The engine that sends as `account`, fixed to `account`'s credential whatever the roster selects meanwhile.
    async fn pinned(&self, account: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError>;
    /// Every account engine that exists now (session and transport releases reach each).
    fn built(&self) -> Vec<Arc<dyn ProviderAdapter>>;
    /// The provider's `accountCooldownPolicy`.
    fn cooldown_policy(&self, _account: &str) -> Option<CooldownPolicy> {
        None
    }
    /// Whether the plan meters stored for the provider's accounts describe where its sends go ([`SendContext`]).
    fn plan_meters_apply(&self) -> bool {
        true
    }
    /// The stored plan reading of a provider with no roster, as the admission check before the wire reads it
    /// ([`SendContext::implicit_plan_usage`]); `None` when nothing was measured.
    async fn implicit_plan_usage(&self) -> Option<crate::accounts::Account> {
        None
    }
    /// The account a request outside the roster walk goes out on: the provider's current account.
    async fn home(&self) -> String {
        "default".to_owned()
    }
    /// What of a replay envelope stays on a message another account served; `None`: nothing.
    fn kept_replay(&self, _replay: &ProviderReplay) -> Option<ProviderReplay> {
        None
    }
    /// Whether a provider state no row stamped is [`Self::home`]'s: an OAuth pool's `replayAccount` names no row for it,
    /// so it is sent to none.
    fn owns_unstamped_state(&self) -> bool {
        false
    }
}

/// A custom provider's keys: `default` is the key the provider's own configuration names, each additional key has an
/// engine built with the provider.
pub struct KeyEngines {
    provider: String,
    own: Arc<dyn OwnKey>,
    /// `(key id, engine)` of every additional key, in roster order.
    keys: Vec<(String, KeyEngine)>,
    rotation: AccountRotation,
}

#[async_trait]
impl AccountEngines for KeyEngines {
    /// Without additional keys the roster is empty and every send is the primary key's own (Node
    /// `createCustomKeyPoolProvider`), still bound to that key.
    fn rotation(&self) -> Option<AccountRotation> {
        (!self.keys.is_empty()).then(|| self.rotation.clone())
    }

    async fn pinned(&self, account: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        if account == "default" {
            return self.own.pinned().await;
        }
        match self.keys.iter().find(|(id, _)| id == account).map(|(_, engine)| engine) {
            Some(Ok(engine)) => Ok(engine.clone()),
            Some(Err(message)) => Err(plain(ErrorKind::Unknown, None, message.clone())),
            None => {
                Err(plain(ErrorKind::Unknown, None, format!("An additional API key of {} is not readable; enter it again in its settings.", self.provider)))
            }
        }
    }

    fn built(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        let keys = self.keys.iter().filter_map(|(_, engine)| engine.as_ref().ok().cloned());
        keys.chain(self.own.built()).collect()
    }

    /// The Chat wire's `reasoningContent` is a field of its own in Node and stays; here it rides the Chat replay envelope,
    /// of which only it and the wire field it goes out as stay. The opaque `reasoningDetails` are the serving key's.
    fn kept_replay(&self, replay: &ProviderReplay) -> Option<ProviderReplay> {
        let replayed = crate::providers::compat::chat::reasoning::replayed(replay)?;
        let mut items = serde_json::json!({ "reasoningContent": replayed.text });
        if let Some(field) = replayed.field {
            items["reasoningField"] = field.into();
        }
        Some(ProviderReplay { owner: replay.owner.clone(), items })
    }

    /// `customKeyServedBy`'s `|| 'default'`: the primary key's.
    fn owns_unstamped_state(&self) -> bool {
        true
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
    /// A custom provider's pool: `primary` answers everything but the send, `own` pins the configured key per request.
    pub fn new(provider: &str, primary: Arc<dyn ProviderAdapter>, own: Arc<dyn OwnKey>, keys: Vec<(String, KeyEngine)>, rotation: AccountRotation) -> Self {
        let engines = Arc::new(KeyEngines { provider: provider.to_owned(), own, keys, rotation });
        Self::with_engines(provider, primary, engines)
    }

    /// A pool over `engines`: `primary` answers everything but the requests it hands a pinned engine.
    pub fn with_engines(provider: &str, primary: Arc<dyn ProviderAdapter>, engines: Arc<dyn AccountEngines>) -> Self {
        Self { pool: Arc::new(Pool { provider: provider.to_owned(), primary, engines }) }
    }
}

impl Pool {
    /// `customKeyServedBy`: the row a message's stored routing names for this provider (Node 1.4.5 and this build stamp
    /// `accountRouting.accountId` with it), else the row its replay names (`replayAccount`), else `home`.
    fn served_by<'a>(&self, message: &'a Message, home: &'a str) -> &'a str {
        match &message.account_routing {
            Some(routing) if routing.provider == self.provider => &routing.account_id,
            _ => message.replay_account.as_deref().unwrap_or(home),
        }
    }

    /// `message` without what only the row that produced it may be sent, `None` when it carries nothing of the kind. These
    /// are all the representations a provider's lowering sends back verbatim: the replay envelopes, but for what the
    /// engines keep of them across rows ([`AccountEngines::kept_replay`]), the thinking blocks, the ordered assistant blocks (Anthropic sends them in place of the turn it would
    /// rebuild, signed thinking included) and Gemini's stored thought parts. What stays, the text, the tool calls and the
    /// tool-search references, is what every lowering rebuilds the turn from, so each tool call keeps its result.
    fn without_bound_state(&self, message: &Message) -> Option<Message> {
        let kept: Vec<ProviderReplay> = message.provider_replay().iter().filter_map(|replay| self.engines.kept_replay(replay)).collect();
        if message.thinking_blocks.is_none()
            && message.assistant_blocks.is_none()
            && message.gemini_metadata.is_none()
            && kept.as_slice() == message.provider_replay()
        {
            return None;
        }
        let mut plain = message.clone();
        plain.thinking_blocks = None;
        plain.assistant_blocks = None;
        plain.gemini_metadata = None;
        plain.retain_replay(|_| false);
        for replay in kept {
            plain.push_replay(replay);
        }
        Some(plain)
    }

    /// `boundAccountSend`'s history and state for the pinned row `account`: a message another row served goes without its
    /// bound state ([`Self::without_bound_state`]), and the provider state is sent only to the row that produced it
    /// (`servedBy(providerState) === row.id`, else none). `home` is the row a message without a stamp is attributed to:
    /// the provider's current row as the request began; a state without one is `home`'s only where the pool says so
    /// ([`AccountEngines::owns_unstamped_state`]).
    fn history_for(&self, request: &Arc<ModelRequest>, account: &str, home: &str) -> Arc<ModelRequest> {
        let state_kept = request.options.provider_state.as_ref().is_none_or(|state| {
            let stamp = state.rest.get(STATE_ACCOUNT).and_then(JsonValue::as_str).filter(|id| !id.is_empty());
            stamp.or_else(|| self.engines.owns_unstamped_state().then_some(home)) == Some(account)
        });
        let scrubbed: Vec<(usize, Message)> = request
            .messages
            .iter()
            .enumerate()
            .filter(|(_, message)| self.served_by(message, home) != account)
            .filter_map(|(index, message)| Some((index, self.without_bound_state(message)?)))
            .collect();
        if state_kept && scrubbed.is_empty() {
            return request.clone();
        }
        let mut owned = (**request).clone();
        if !state_kept {
            owned.options.provider_state = None;
        }
        for (index, message) in scrubbed {
            owned.messages[index] = message;
        }
        Arc::new(owned)
    }

    /// `recordServingAccount`'s routing: `account` served; `binding` is the account the session stays bound to, when a
    /// roster walk bound it.
    fn routing(&self, account: &str, binding: Option<&str>) -> StreamEvent {
        StreamEvent::AccountRouting(AccountRouting {
            provider: self.provider.clone(),
            account_id: account.to_owned(),
            session_account_id: binding.map(str::to_owned),
        })
    }
}

/// A request outside the roster walk (no bound rotation, the re-issue after a spent ladder) on one row, pinned for the
/// whole request.
struct CurrentSend {
    engine: Arc<dyn ProviderAdapter>,
    /// The request with the history and state of the pinned row.
    request: Arc<ModelRequest>,
    account: String,
}

impl Pool {
    /// The send of `request` on the row `sent.account`; `sent.home` is the row a message or state without a stamp is
    /// attributed to.
    async fn current_send(&self, request: Arc<ModelRequest>, sent: SentOn) -> Result<CurrentSend, ProviderError> {
        let engine = self.engines.pinned(&sent.account).await?;
        request.options.send_identity.set_account(sent.clone());
        let SentOn { account, home } = sent;
        let request = self.history_for(&request, &account, &home);
        Ok(CurrentSend { engine, request, account })
    }

    /// `stream`, its reported state stamped as the pinned row's and its answer as served by that row.
    fn current_stream(self: &Arc<Self>, stream: Box<dyn ModelStream>, send: CurrentSend) -> Box<dyn ModelStream> {
        Box::new(StampedStream { inner: stream, pool: self.clone(), account: send.account, completed: None })
    }
}

/// The re-issue of a roster walk's attempt: its reported state is stamped as the pinned row's, and the answer names the
/// row that served it before its `Completed`, as the walk's own answer does.
struct StampedStream {
    inner: Box<dyn ModelStream>,
    pool: Arc<Pool>,
    account: String,
    /// The answer's `Completed`, held back while the routing goes first.
    completed: Option<StreamEvent>,
}

#[async_trait]
impl ModelStream for StampedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if let Some(completed) = self.completed.take() {
            return Some(Ok(completed));
        }
        match self.inner.next().await? {
            Ok(StreamEvent::ProviderState(state)) => Some(Ok(StreamEvent::ProviderState(stamped(state, &self.pool.provider, &self.account)))),
            Ok(completed @ StreamEvent::Completed { .. }) => {
                self.completed = Some(completed);
                Some(Ok(self.pool.routing(&self.account, None)))
            }
            other => Some(other),
        }
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        self.inner.on_wire_left(left);
    }
}

pub(super) fn plain(kind: ErrorKind, code: Option<&str>, message: String) -> ProviderError {
    let mut error = ProviderError::new(kind, DeliveryState::NotSent);
    error.code = code.map(str::to_owned);
    error.message = message;
    error
}

pub(super) fn is_local_quota_refusal(error: &ProviderError) -> bool {
    error.delivery == DeliveryState::NotSent && error.status.is_none() && error.code.as_deref() == Some("provider_accounts_exhausted")
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
                    provider.reset_at =
                        proof.reset_at.and_then(|ms| u64::try_from(ms).ok()).map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
                }
            }
            provider
        }
        Cause::AccountsExhausted { .. } => {
            let mut exhausted = plain(ErrorKind::QuotaExhausted, Some("provider_accounts_exhausted"), message);
            // The refusal made here, before the wire, keeps the reset the proof found: the route chain and the user
            // are told when the window lifts.
            exhausted.reset_at = error
                .quota_exhausted
                .as_ref()
                .and_then(|proof| proof.reset_at)
                .and_then(|ms| u64::try_from(ms).ok())
                .map(|ms| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms));
            exhausted
        }
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
    /// Even a later store/binding error must not make a completed or exposed request replayable.
    no_replay: bool,
    /// The serving attempt's stream, kept for as long as the send's own stream: a provider whose run stays open for
    /// the batch it handed over ends that run when its stream is dropped.
    served: Option<Box<dyn ModelStream>>,
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
    matches!(event, StreamEvent::ReturnedCalls(calls) if !calls.is_empty())
        || matches!(
            event,
            StreamEvent::TextDelta(_)
                | StreamEvent::ReasoningDelta(_)
                | StreamEvent::ProgressDelta(_)
                | StreamEvent::ToolCallStart { .. }
                | StreamEvent::ToolCallArgsDelta { .. }
                | StreamEvent::ToolCallDone(_)
                | StreamEvent::ServerToolBlock(_)
                | StreamEvent::FinalContent(_)
                | StreamEvent::Progress(_)
        )
}

/// One key-bound attempt of the send.
struct KeySend {
    pool: Arc<Pool>,
    request: Arc<ModelRequest>,
    queue: Queue,
    /// [`AccountEngines::home`] as the send began: the row a message without routing is attributed to.
    home: String,
}

impl KeySend {
    fn failed(&self, mut error: ProviderError, emitted: bool) -> Failed {
        super::accounted::observe_pool_failure(&mut error);
        error.unsafe_to_retry |= emitted;
        // The walk can replace this error with a roster write error. That is not a new opportunity
        // to send a tool call or other already exposed output.
        lock(&self.queue).no_replay |= error.unsafe_to_retry || error.exposure != Default::default() || !error.partial_tool_calls.is_empty();
        Failed { emitted, ..Failed::new(error) }
    }
}

#[async_trait]
impl AccountSender<()> for KeySend {
    fn abandon(&self, error: &mut ProviderError) -> bool {
        let sent = &self.request.options.send_identity;
        let owned = super::accounted::handoff_abandoned_usage(error, sent);
        if !owned && error.partial_usage.is_some() {
            return false;
        }
        sent.note_dispatched_speed_tier("");
        true
    }

    fn cooldown_policy(&self, account: &str) -> Option<CooldownPolicy> {
        self.pool.engines.cooldown_policy(account)
    }

    /// `scoped` (false: a roster with no accounts, sent as `default`) changes nothing here: either way the request goes
    /// out on the engine pinned to `account`, sent and stamped with that row's state.
    async fn send(&self, account: &str, _scoped: bool) -> Result<(), Failed> {
        // The pool's notice of the previous refusal reaches the caller before this key's request goes out.
        taken(&self.queue).await;
        self.request.options.send_identity.set_account(SentOn { account: account.to_owned(), home: self.home.clone() });
        let engine = self.pool.engines.pinned(account).await.map_err(|error| self.failed(error, false))?;
        let request = self.pool.history_for(&self.request, account, &self.home);
        let mut stream = engine.attempt(request).await.map_err(|error| self.failed(error, false))?;
        if let Some(left) = lock(&self.queue).wire_left.clone() {
            stream.on_wire_left(left);
        }
        let mut emitted = false;
        loop {
            let item = stream
                .next()
                .await
                .unwrap_or_else(|| Err(ProviderError::transport(mixdog_core_api::domain::provider::TransportFault::TruncatedStream, stream.delivery())));
            lock(&self.queue).delivery = stream.delivery();
            match item {
                Ok(event @ StreamEvent::Completed { .. }) => {
                    {
                        let mut shared = lock(&self.queue);
                        shared.completed = Some(event);
                        shared.no_replay = true;
                        shared.served = Some(stream);
                    }
                    // The pool goes on to bind the serving key (`pool_send`'s store work) before `Completed` is released.
                    leave_wire(&self.queue);
                    return Ok(());
                }
                // `recordServingAccount`: the state the answer leaves is this row's.
                Ok(StreamEvent::ProviderState(state)) => {
                    hand_over(&self.queue, StreamEvent::ProviderState(stamped(state, &self.pool.provider, account))).await;
                }
                Ok(event) => {
                    super::accounted::observe_pool_event(&event);
                    emitted |= shows_output(&event);
                    if emitted {
                        lock(&self.queue).no_replay = true;
                    }
                    hand_over(&self.queue, event).await;
                }
                Err(error) => return Err(self.failed(error, emitted)),
            }
        }
    }

    /// `recordServingAccount`: the answer names the key that served it and the one the session stays bound to.
    fn stamp(&self, _: &mut (), account: &str, binding: &str) {
        let routing = self.pool.routing(account, Some(binding));
        lock(&self.queue).queue.push_back(routing);
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
                Err(mut error) => {
                    error.unsafe_to_retry |= lock(&self.queue).no_replay;
                    self.failure = Some(error);
                }
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
        lock(&self.queue).delivery
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
    async fn quota_eligibility(&self, model: &str) -> Option<bool> {
        let provider = &self.pool.provider;
        if !crate::accounts::rotation::uses_bound_plan_evidence(provider) {
            return None;
        }
        let rotation = self.pool.engines.rotation()?;
        let context = SendContext {
            model: model.to_owned(),
            session_id: None,
            bound_hint: None,
            cancel: CancellationToken::new(),
            implicit_plan_usage: self.pool.engines.implicit_plan_usage().await,
            plan_meters_apply: self.pool.engines.plan_meters_apply(),
        };
        rotation.quota_eligibility(provider, &context).await
    }
    fn codec(&self) -> &dyn WireCodec {
        self.pool.primary.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.pool.primary.retry_policy()
    }
    // A send's retry ladder and its recovery are the provider's, whichever account serves it. The re-issue after a
    // spent ladder or a cut stream goes out on the row the send's latest attempt went out on: Node's runs inside that
    // row's `account(row.id).send`, and its answer is stamped as that row's.
    fn retry_policy_for(&self, model: &str) -> &RetryPolicy {
        self.pool.primary.retry_policy_for(model)
    }
    fn retry_policy_of(&self, request: &ModelRequest) -> &RetryPolicy {
        self.pool.primary.retry_policy_of(request)
    }
    fn recovers_spent(&self, request: &ModelRequest, failure: &ProviderError) -> bool {
        self.pool.primary.recovers_spent(request, failure)
    }
    fn recovers_cut(&self, request: &ModelRequest, failure: &ProviderError) -> bool {
        self.pool.primary.recovers_cut(request, failure)
    }
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let sent = match request.options.send_identity.account() {
            Some(sent) => sent,
            None => SentOn::current(self.pool.engines.home().await),
        };
        let send = self.pool.current_send(request, sent).await?;
        let stream = send.engine.recover_spent(send.request.clone()).await?;
        // Node stamps an answer only inside a roster walk (`bindServedAccount`); a send outside one carries no stamp.
        Ok(match self.pool.engines.rotation() {
            Some(_) => self.pool.current_stream(stream, send),
            None => stream,
        })
    }
    fn recovery_line(&self, model: &str, failure: &ProviderError) -> Option<String> {
        self.pool.primary.recovery_line(model, failure)
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.pool.primary.keepalive()
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        self.pool.primary.models()?;
        Some(self)
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
    fn begin_loop(&self) {
        if let Some(rotation) = self.pool.engines.rotation() {
            rotation.reset_probe_pacing();
        }
        self.pool.primary.begin_loop();
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
    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        self.pool.primary.image_route(request).await
    }
    fn first_response_budget(&self, model: &str, parameters: Option<&JsonValue>) -> Option<FirstResponseBudget> {
        self.pool.primary.first_response_budget(model, parameters)
    }
    fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
        self.pool.primary.cache_warm().map(|_| self as &dyn mixdog_core_api::domain::cache_warm::CacheWarmSend)
    }
    /// A walk that ends before any event is the attempt's own refusal; otherwise the events follow.
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let Some(rotation) = self.pool.engines.rotation() else {
            let send = self.pool.current_send(request, SentOn::current(self.pool.engines.home().await)).await?;
            return send.engine.attempt(send.request.clone()).await;
        };
        let queue: Queue = Arc::new(Mutex::new(Shared {
            queue: VecDeque::new(),
            waiting: None,
            completed: None,
            delivery: DeliveryState::NotSent,
            wire_left: None,
            wire_done: false,
            no_replay: false,
            served: None,
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
            implicit_plan_usage: self.pool.engines.implicit_plan_usage().await,
            plan_meters_apply: self.pool.engines.plan_meters_apply(),
        };
        let pool = self.pool.clone();
        let home = self.pool.engines.home().await;
        let sender = KeySend { pool: pool.clone(), request, queue: queue.clone(), home };
        let walk: Walk = Box::pin(async move { rotation.pool_send(&pool.provider, &context, &sender).await.map_err(pool_error) });
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

/// The provider's own listing, whose roster is the signed-in account's: the provider account its credential names, else
/// the roster row the provider's current account is (a credential that names no account, such as an imported Claude CLI
/// login, lists live with its own bearer and keeps its list under its row).
#[async_trait]
impl ModelListing for KeyPoolAdapter {
    async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
        self.listing().list_models().await
    }

    async fn roster_identity(&self) -> RosterIdentity {
        let identity = self.listing().roster_identity().await;
        of_row(identity, &self.pool.engines.home().await)
    }

    /// The listing of the engine pinned to the provider's current row: its credential is that row's for the whole fetch,
    /// so a list whose credential names no account is that row's.
    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        let row = self.pool.engines.home().await;
        let engine = self.pool.engines.pinned(&row).await?;
        let mut listed = engine.models().expect("a row's engine lists as the provider's own does").list_roster().await?;
        listed.identity = of_row(listed.identity, &row);
        Ok(listed)
    }

    fn show_roster(&self, rows: &[mixdog_core_api::domain::provider::ModelRecord]) {
        self.listing().show_roster(rows);
    }
}

impl KeyPoolAdapter {
    fn listing(&self) -> &dyn ModelListing {
        self.pool.primary.models().expect("the pool lists only through a provider that lists")
    }
}

/// `identity`, keyed by the roster row `row` when its credential names no account.
fn of_row(mut identity: RosterIdentity, row: &str) -> RosterIdentity {
    if identity.account.is_none() {
        identity.account = Some(crate::catalog::account_fingerprint(&["roster-row", row]));
    }
    identity
}

/// A cache warm goes out on the engine pinned to the account that holds the entry (the warm's target, the provider's
/// current account when it names none), with the history and state the send of that row would carry, so it warms the
/// prefix that send reads: the account its gate judged, its usage is recorded under and its refusal is held against is
/// the one whose credential warms.
#[async_trait]
impl mixdog_core_api::domain::cache_warm::CacheWarmSend for KeyPoolAdapter {
    async fn send_cache_warm(
        &self,
        request: &ModelRequest,
        ctx: &mixdog_core_api::domain::cache_warm::WarmContext<'_>,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u mixdog_core_api::domain::cache_warm::WarmUsage) + Send),
    ) -> Result<mixdog_core_api::domain::cache_warm::WarmUsage, mixdog_core_api::domain::cache_warm::WarmFailure> {
        use mixdog_core_api::domain::cache_warm::WarmFailure;
        let home = self.pool.engines.home().await;
        let account = match ctx.target.account_id.as_str() {
            "" => home.clone(),
            named => named.to_owned(),
        };
        let engine = self.pool.engines.pinned(&account).await.map_err(|error| WarmFailure::new(error.into_message()))?;
        let Some(warm) = engine.cache_warm() else { return Err(WarmFailure::new("provider has no cache-warm mode")) };
        let request = self.pool.history_for(&Arc::new(request.clone()), &account, &home);
        warm.send_cache_warm(&request, ctx, cancel, on_usage).await
    }
}

#[cfg(test)]
#[path = "key_pool_account_tests.rs"]
mod account_tests;
