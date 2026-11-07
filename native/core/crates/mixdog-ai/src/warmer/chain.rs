//! The warm chain of every session (`session/cache-warm.mjs`): one timer at a time while the
//! session idles, as far as its own history of returns says it pays. A warm re-sends the session's
//! last real request through the provider's cache-warm mode, so the provider reads and refreshes
//! the cached prefix and writes nothing; it never reaches the transcript, the UI, the admission
//! queue or the session record. Its usage-ledger row carries the `cache-warm` source, written on
//! success, failure and cancellation.
//!
//! The chain stops on a miss, a failure, a late timer, a turn in flight, a new real request, a
//! compaction, a clear, a close or a delete; the idle auto-clear then runs from the last real or
//! successful warm use (the [`WarmLedger`] mirrors the touch store's warm uses for it).
//!
//! The process supplies [`WarmDeps`]; time and timers are seams so a chain can be driven on a
//! fake clock.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use super::plan::{
    CacheStrategy, Gap, LEAD_MS, Plan, PlanInput, Prices, TurnKind, entry_lapsed, plan_cache_warm, warm_delay_ms, warm_rewrote,
    written_cache_ttl_ms,
};
use super::stores::{GapStore, Touch, TouchStore};
use super::stream::{WarmFailure, WarmUsage};
use crate::accounts::ACCOUNT_PROVIDERS;
use crate::registry::warm::{WarmLedger, WarmUse};
use crate::service::routes::provider_tail_cache_lifetime_ms;

/// The request a warm replays (`side-question-store.mjs` snapshot) and the facts the warmer reads
/// of it.
pub trait WarmRequest: Send + Sync {
    fn provider_name(&self) -> &str;
    fn model(&self) -> &str;
    /// `opts.session.id`; empty when the request has no session.
    fn session_id(&self) -> &str;
    /// Epoch ms the real request was sent at.
    fn sent_at(&self) -> f64;
    /// `opts.requestKind`.
    fn request_kind(&self) -> Option<&str>;
    fn cache_strategy(&self) -> Option<CacheStrategy>;
    /// `Number(opts.thinkingBudgetTokens)`, 0 when none.
    fn thinking_budget_tokens(&self) -> f64;
    /// `opts.effort` is set.
    fn has_effort(&self) -> bool;
    /// `anthropicEffortLevelsFor(model).length === 0`.
    fn effort_levels_empty(&self) -> bool;
    /// The provider exposes a cache-warm mode (`sendCacheWarm`).
    fn has_warm_mode(&self) -> bool;
    /// `opts.session.ownerSessionId || opts.session.parentSessionId`, for the warm's ledger row.
    fn owner_session_id(&self) -> Option<&str> {
        None
    }
}

/// `cacheCapabilityForProvider(name) === 'explicit-breakpoint'`.
fn explicit_breakpoint(provider: &str) -> bool {
    matches!(provider, "anthropic" | "anthropic-oauth")
}

/// `cacheWarmIneligibility(request)`: why `request` may not be warmed, or `None`.
pub fn ineligibility(request: &dyn WarmRequest) -> Option<&'static str> {
    if !explicit_breakpoint(request.provider_name()) {
        return Some("provider caches without breakpoints");
    }
    if !request.has_warm_mode() {
        return Some("provider has no cache-warm mode");
    }
    if request.session_id().is_empty() {
        return Some("no session");
    }
    if request.thinking_budget_tokens() > 0.0 {
        return Some("thinking budget derives from max_tokens");
    }
    if request.has_effort() && request.effort_levels_empty() {
        return Some("thinking budget derives from max_tokens");
    }
    let strategy = request.cache_strategy();
    let tier = strategy.as_ref().and_then(|s| s.messages.as_deref());
    if provider_tail_cache_lifetime_ms(request.provider_name(), tier).is_none() {
        return Some("no expiring message-tail cache");
    }
    None
}

/// The provider and account a warm of a chain goes to.
#[derive(Clone, PartialEq, Debug)]
pub struct WarmTarget {
    /// The roster account that holds the entry; empty for a provider without a roster.
    pub account_id: String,
}

/// The response a real request settled with, as far as the warmer reads it.
#[derive(Clone, Default, Debug)]
pub struct ArmResponse {
    pub input: f64,
    pub cached: f64,
    pub cache_write: f64,
    pub cache_write_1h: f64,
    /// The usage's own prompt size, when it reports one.
    pub prompt_tokens: Option<f64>,
    /// `providerMetadata.accountRouting.accountId`.
    pub account_id: Option<String>,
}

/// A handle on a pending timer.
pub trait TimerHandle: Send + Sync {
    fn cancel(&self);
}

pub trait WarmTimers: Send + Sync {
    /// Runs `task` after `delay_ms`. Dropping the handle leaves the timer armed.
    fn schedule(&self, delay_ms: f64, task: BoxFuture<'static, ()>) -> Box<dyn TimerHandle>;
}

/// What the process supplies.
#[async_trait]
pub trait WarmDeps: Send + Sync {
    fn now(&self) -> f64;
    fn timers(&self) -> &dyn WarmTimers;
    /// The setting, read at a refresh point (config).
    async fn enabled(&self) -> bool;
    /// The setting, read once and synchronously when nothing has set it yet.
    fn read_config_enabled(&self) -> bool;
    fn turn_in_flight(&self, session_id: &str) -> bool;
    /// `lastSentMainRequest(sessionId)`: the request the session's next turn rebuilds.
    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String>;
    /// The registered providers a re-armed request needs; never initializes them.
    async fn providers_ready(&self);
    /// `registeredProvider(name) === request.provider`: the instance the request was captured on
    /// is still the registered one.
    async fn provider_current(&self, request: &dyn WarmRequest) -> bool;
    /// Per-token dollars of a read, a write of `ttl_ms`'s tier and an output token.
    async fn prices(&self, request: &dyn WarmRequest, ttl_ms: f64, prompt_tokens: f64) -> Result<Prices, String>;
    /// One warm on `target`; `on_usage` hears the usage as it arrives.
    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure>;
    /// The warm's usage-ledger row, `cache-warm` source.
    async fn record_usage(&self, request: &dyn WarmRequest, usage: &WarmUsage, started_at: f64, account_id: &str) -> Result<(), String>;
    fn log(&self, line: &str);
}

/// What a chain holds at a point, for diagnostics and tests.
#[derive(Clone, PartialEq, Debug)]
pub struct ChainState {
    pub ttl_ms: f64,
    pub touch_at: f64,
    pub prompt_tokens: f64,
    pub account_id: String,
    pub latency_ms: Option<f64>,
    pub refresh_at: f64,
}

struct ChainInner {
    ttl_ms: f64,
    touch_at: f64,
    prompt_tokens: f64,
    account_id: String,
    latency_ms: Option<f64>,
    refresh_at: f64,
    timer: Option<Box<dyn TimerHandle>>,
    controller: Option<CancellationToken>,
}

struct Chain {
    request: Arc<dyn WarmRequest>,
    inner: Mutex<ChainInner>,
}

impl Chain {
    fn inner(&self) -> MutexGuard<'_, ChainInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What a turn that entered a session keeps of the chain it stopped.
struct Suspended {
    request: Arc<dyn WarmRequest>,
    ttl_ms: f64,
    touch_at: f64,
    prompt_tokens: f64,
    account_id: String,
    latency_ms: Option<f64>,
}

/// A running turn of a session, as the warmer holds it.
pub struct Turn {
    kind: TurnKind,
    started_at: f64,
    returning: Mutex<bool>,
    suspended: Mutex<Option<Suspended>>,
}

impl Turn {
    pub fn kind(&self) -> TurnKind {
        self.kind
    }

    pub fn returning(&self) -> bool {
        *self.returning.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Default)]
struct State {
    chains: HashMap<String, Arc<Chain>>,
    turns: HashMap<String, Arc<Turn>>,
    /// Sessions whose warm read little of what it rewrote while the entry was inside its
    /// lifetime: no later chain is armed until the prefix is dropped.
    missed: HashSet<String>,
    /// The synchronous on/off state, always definite once read.
    on: Option<bool>,
}

/// The facts of one finished warm.
struct Finished<'a> {
    target: &'a WarmTarget,
    sent_at: f64,
    reported_at: Option<f64>,
    usage: Option<&'a WarmUsage>,
    failure: Option<String>,
}

pub struct Warmer {
    deps: Arc<dyn WarmDeps>,
    touches: Arc<TouchStore>,
    gaps: Arc<GapStore>,
    ledger: WarmLedger,
    state: Mutex<State>,
}

impl Warmer {
    /// The warmer over `deps` and the two stores; `ledger` mirrors the touch store's warm uses for
    /// the idle auto-clear and is seeded from them.
    pub fn new(deps: Arc<dyn WarmDeps>, touches: Arc<TouchStore>, gaps: Arc<GapStore>, ledger: WarmLedger) -> Arc<Self> {
        for (id, warm) in touches.warm_uses() {
            ledger.record(&id, warm);
        }
        Arc::new(Self { deps, touches, gaps, ledger, state: Mutex::new(State::default()) })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn enabled_now(&self) -> bool {
        let mut state = self.state();
        *state.on.get_or_insert_with(|| self.deps.read_config_enabled())
    }

    /// The setting changed: authoritative; off cancels every armed chain.
    pub fn note_enabled(&self, enabled: bool) {
        self.state().on = Some(enabled);
        if enabled {
            return;
        }
        let ids: Vec<String> = self.state().chains.keys().cloned().collect();
        for id in ids {
            self.cancel(&id);
        }
    }

    /// Replaces the setting state and every chain (tests): the next read asks the config again.
    pub fn reset(&self) {
        let ids: Vec<String> = self.state().chains.keys().cloned().collect();
        for id in ids {
            self.cancel(&id);
        }
        let mut state = self.state();
        state.missed.clear();
        state.on = None;
    }

    fn record_use(&self, session_id: &str, warm: WarmUse) {
        self.touches.record_warm_use(session_id, warm.clone());
        self.ledger.record(session_id, warm);
    }

    fn forget_use(&self, session_id: &str) {
        self.touches.forget_warm_use(session_id);
        self.ledger.forget(session_id);
    }

    /// A session deleted for good drops everything it learned and touched.
    pub fn purge_session(&self, session_id: &str) {
        self.cancel(session_id);
        {
            let mut state = self.state();
            state.turns.remove(session_id);
            state.missed.remove(session_id);
        }
        self.touches.forget(session_id);
        self.forget_use(session_id);
        self.gaps.forget(session_id);
    }

    pub fn chain_state(&self, session_id: &str) -> Option<ChainState> {
        let chain = self.state().chains.get(session_id).cloned()?;
        let c = chain.inner();
        Some(ChainState {
            ttl_ms: c.ttl_ms,
            touch_at: c.touch_at,
            prompt_tokens: c.prompt_tokens,
            account_id: c.account_id.clone(),
            latency_ms: c.latency_ms,
            refresh_at: c.refresh_at,
        })
    }

    /// The running turn the warmer holds for `session_id`.
    pub fn turn(&self, session_id: &str) -> Option<Arc<Turn>> {
        self.state().turns.get(session_id).cloned()
    }

    fn is_current(&self, session_id: &str, chain: &Arc<Chain>) -> bool {
        self.state().chains.get(session_id).is_some_and(|held| Arc::ptr_eq(held, chain))
    }

    /// Whether a captured request is the session's real activity: one of a turn that is not
    /// system-caused, sent by the main loop itself.
    fn real_activity(&self, session_id: &str, request: Option<&dyn WarmRequest>) -> bool {
        if self.state().turns.get(session_id).is_some_and(|t| t.kind == TurnKind::System) {
            return false;
        }
        request.and_then(|r| r.request_kind()).is_none_or(|kind| kind.is_empty() || kind == "turn")
    }

    /// A turn of the session opened, of `kind`. A `Return` closes the session's idle gap at its
    /// start, once its first request goes out. The chain is stopped (the abort is not a miss); its
    /// request and confirmed touch are kept on the turn, which restores them when it ends without
    /// a request of its own.
    pub fn note_turn(self: &Arc<Self>, session_id: &str, kind: TurnKind) -> Option<Arc<Turn>> {
        if session_id.is_empty() {
            return None;
        }
        let turn = Arc::new(Turn {
            kind,
            started_at: self.deps.now(),
            returning: Mutex::new(kind == TurnKind::Return),
            suspended: Mutex::new(None),
        });
        self.state().turns.insert(session_id.to_owned(), turn.clone());
        let chain = self.state().chains.get(session_id).cloned();
        if let Some(chain) = chain {
            let c = chain.inner();
            *turn.suspended.lock().unwrap_or_else(PoisonError::into_inner) = Some(Suspended {
                request: chain.request.clone(),
                ttl_ms: c.ttl_ms,
                touch_at: c.touch_at,
                prompt_tokens: c.prompt_tokens,
                account_id: c.account_id.clone(),
                latency_ms: c.latency_ms,
            });
            drop(c);
            self.stop_chain(session_id, &chain, "turn entered", true);
        }
        Some(turn)
    }

    /// The turn `note_turn` returned ended: its entry goes unless a later turn already replaced
    /// it. When it sent no request and the cache entry has not expired, the chain it stopped comes
    /// back with its original touch and schedule.
    pub fn end_turn(self: &Arc<Self>, session_id: &str, turn: &Arc<Turn>) {
        {
            let mut state = self.state();
            if !state.turns.get(session_id).is_some_and(|held| Arc::ptr_eq(held, turn)) {
                return;
            }
            state.turns.remove(session_id);
        }
        let Some(chain) = turn.suspended.lock().unwrap_or_else(PoisonError::into_inner).take() else { return };
        if self.state().chains.contains_key(session_id) {
            return;
        }
        if self.deps.now() < chain.touch_at + chain.ttl_ms - LEAD_MS {
            let latency = chain.latency_ms;
            let restored = self.start_chain(session_id, chain);
            restored.inner().latency_ms = latency;
        }
    }

    /// A request of the main loop is going out: the chain stops; when it is the first request of a
    /// returning turn, the open idle gap closes at the turn's start. Warms never come through here.
    pub fn note_activity(&self, session_id: &str, request: Option<&dyn WarmRequest>) {
        if session_id.is_empty() {
            return;
        }
        let turn = self.state().turns.get(session_id).cloned();
        if let Some(turn) = turn {
            let mut returning = turn.returning.lock().unwrap_or_else(PoisonError::into_inner);
            if *returning && self.real_activity(session_id, request) {
                *returning = false;
                drop(returning);
                self.gaps.close(session_id, turn.started_at);
            }
        }
        self.cancel(session_id);
    }

    /// Drops the session's chain: clears its timer and aborts a warm in flight (its usage is still
    /// accounted).
    pub fn cancel(&self, session_id: &str) {
        let turn = self.state().turns.get(session_id).cloned();
        if let Some(turn) = turn {
            *turn.suspended.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
        let chain = self.state().chains.get(session_id).cloned();
        if let Some(chain) = chain {
            self.stop_chain(session_id, &chain, "canceled", true);
        }
    }

    /// The session's cached prefix is gone (compaction, clear, rewind): the chain, its durable
    /// touch and its warm use go.
    pub fn forget(&self, session_id: &str) {
        self.cancel(session_id);
        if session_id.is_empty() {
            return;
        }
        self.state().missed.remove(session_id);
        self.touches.forget(session_id);
        self.forget_use(session_id);
    }

    fn record_touch(&self, session_id: &str, chain: &Chain) {
        let c = chain.inner();
        self.touches.record(
            session_id,
            Touch {
                touch_at: c.touch_at,
                ttl_ms: c.ttl_ms,
                prompt_tokens: c.prompt_tokens,
                account_id: Some(c.account_id.clone()).filter(|a| !a.is_empty()),
            },
        );
    }

    fn stop_chain(&self, session_id: &str, chain: &Arc<Chain>, reason: &str, quiet: bool) {
        {
            let mut state = self.state();
            if !state.chains.get(session_id).is_some_and(|held| Arc::ptr_eq(held, chain)) {
                return;
            }
            state.chains.remove(session_id);
        }
        let (timer, controller) = {
            let mut c = chain.inner();
            (c.timer.take(), c.controller.clone())
        };
        if let Some(timer) = timer {
            timer.cancel();
        }
        if let Some(controller) = controller {
            controller.cancel();
        }
        if !quiet {
            self.deps.log(&format!("{session_id}: stopped ({reason})"));
        }
    }

    fn start_chain(self: &Arc<Self>, session_id: &str, from: Suspended) -> Arc<Chain> {
        let chain = Arc::new(Chain {
            request: from.request,
            inner: Mutex::new(ChainInner {
                ttl_ms: from.ttl_ms,
                touch_at: from.touch_at,
                prompt_tokens: from.prompt_tokens,
                account_id: from.account_id,
                latency_ms: None,
                refresh_at: 0.0,
                timer: None,
                controller: None,
            }),
        });
        self.state().chains.insert(session_id.to_owned(), chain.clone());
        self.schedule(session_id, &chain);
        chain
    }

    fn schedule(self: &Arc<Self>, session_id: &str, chain: &Arc<Chain>) {
        let (refresh_at, delay) = {
            let c = chain.inner();
            let refresh_at = c.touch_at + warm_delay_ms(c.ttl_ms);
            (refresh_at, f64::max(0.0, refresh_at - self.deps.now()))
        };
        let (warmer, id, held) = (self.clone(), session_id.to_owned(), chain.clone());
        let task: BoxFuture<'static, ()> = Box::pin(async move {
            warmer.fire(&id, &held).await;
        });
        let timer = self.deps.timers().schedule(delay, task);
        let mut c = chain.inner();
        c.refresh_at = refresh_at;
        c.timer = Some(timer);
    }

    /// Arms the session's warm chain from a real request that settled with `response`, and records
    /// the confirmed touch durably; replaces any chain. Nothing is armed while warming is off, for
    /// an ineligible request, one without a send time, or a response that does not prove the tier
    /// it wrote or the prompt size — and the durable touch is dropped.
    pub fn arm(self: &Arc<Self>, session_id: &str, request: Option<Arc<dyn WarmRequest>>, response: &ArmResponse) {
        self.cancel(session_id);
        // A real request settled: the session's own activity is the latest use.
        if !session_id.is_empty() {
            self.forget_use(session_id);
        }
        // After real activity the session's idle clock runs from this request's send; a
        // system-caused request leaves it alone.
        if let Some(request) = request.as_deref().filter(|_| !session_id.is_empty())
            && self.real_activity(session_id, Some(request))
        {
            self.gaps.open_gap(session_id, request.sent_at());
        }
        if !self.enabled_now() {
            if !session_id.is_empty() {
                self.touches.forget(session_id);
            }
            return;
        }
        let Some(request) = request.filter(|r| !session_id.is_empty() && ineligibility(r.as_ref()).is_none()) else { return };
        if self.state().missed.contains(session_id) {
            self.touches.forget(session_id);
            return;
        }
        let touch_at = request.sent_at();
        let ttl_ms = written_cache_ttl_ms(response.cache_write, response.cache_write_1h, request.cache_strategy().as_ref());
        let prompt_tokens = response.prompt_tokens.unwrap_or(response.input + response.cached + response.cache_write);
        if touch_at.is_nan() || touch_at <= 0.0 || ttl_ms == 0.0 || prompt_tokens.is_nan() || prompt_tokens <= 0.0 {
            self.touches.forget(session_id);
            return;
        }
        let chain = self.start_chain(
            session_id,
            Suspended {
                request,
                ttl_ms,
                touch_at,
                prompt_tokens,
                account_id: response.account_id.clone().unwrap_or_default(),
                latency_ms: None,
            },
        );
        self.record_touch(session_id, &chain);
    }

    /// Daemon start: the in-memory chains died with the previous process. Re-arms every touched
    /// session while warming is on from its durable touch, while the entry still has more than the
    /// lead left, replaying the request its next turn rebuilds. An expired touch is dropped.
    /// Answers how many chains were armed.
    pub async fn rearm_after_restart(self: &Arc<Self>) -> usize {
        if !self.enabled_now() {
            return 0;
        }
        let mut candidates = Vec::new();
        for id in self.touches.ids() {
            if self.state().chains.contains_key(&id) {
                continue;
            }
            let Some(touch) = self.touches.get(&id) else { continue };
            if self.deps.now() >= touch.touch_at + touch.ttl_ms - LEAD_MS {
                self.touches.forget(&id);
                continue;
            }
            candidates.push((id, touch));
        }
        if candidates.is_empty() {
            return 0;
        }
        self.deps.providers_ready().await;
        let mut armed = 0;
        for (id, touch) in candidates {
            if !self.enabled_now() {
                return armed;
            }
            let request = match self.deps.last_sent_request(&id).await {
                Ok(request) => request,
                Err(message) => {
                    self.deps.log(&format!("{id}: restart re-arm skipped ({message})"));
                    None
                }
            };
            if !self.enabled_now() {
                return armed;
            }
            let Some(request) = request else { continue };
            if ineligibility(request.as_ref()).is_some() || self.state().chains.contains_key(&id) {
                continue;
            }
            self.start_chain(
                &id,
                Suspended {
                    request,
                    ttl_ms: touch.ttl_ms,
                    touch_at: touch.touch_at,
                    prompt_tokens: touch.prompt_tokens,
                    account_id: touch.account_id.unwrap_or_default(),
                    latency_ms: None,
                },
            );
            armed += 1;
        }
        armed
    }

    /// The plan of `chain` at its refresh point `at`, from the session's own idle history.
    /// Unknown facts fail closed.
    async fn plan_for(&self, session_id: &str, chain: &Chain, at: f64) -> Result<Plan, String> {
        if !self.deps.enabled().await {
            return Ok(Plan::Stop("cache warming off"));
        }
        let (touch_at, ttl_ms, prompt_tokens, latency_ms) = {
            let c = chain.inner();
            (c.touch_at, c.ttl_ms, c.prompt_tokens, c.latency_ms)
        };
        // Idle time counts from the last real activity, the clock the gaps were learned on.
        let last_call_at = self.gaps.open_at(session_id);
        let gaps: Vec<Gap> = self.gaps.gaps(session_id);
        let prices = self.deps.prices(chain.request.as_ref(), ttl_ms, prompt_tokens).await?;
        Ok(plan_cache_warm(&PlanInput { now: at, touch_at, ttl_ms, last_call_at, gaps: &gaps, prompt_tokens, prices, latency_ms }))
    }

    /// The account a warm of `chain` goes to: the roster account that holds the entry, or none for
    /// a provider without a roster. `None` when that account is not known.
    fn target_of(chain: &Chain) -> Option<WarmTarget> {
        if !ACCOUNT_PROVIDERS.contains(&chain.request.provider_name()) {
            return Some(WarmTarget { account_id: String::new() });
        }
        let account_id = chain.inner().account_id.clone();
        (!account_id.is_empty()).then_some(WarmTarget { account_id })
    }

    async fn fire(self: &Arc<Self>, session_id: &str, chain: &Arc<Chain>) {
        if !self.is_current(session_id, chain) {
            return;
        }
        chain.inner().timer = None;
        if self.deps.turn_in_flight(session_id) {
            return self.stop_chain(session_id, chain, "turn in flight", false);
        }
        let plan = match self.plan_for(session_id, chain, self.deps.now()).await {
            Ok(plan) => plan,
            Err(message) => return self.stop_chain(session_id, chain, &message, false),
        };
        if !self.is_current(session_id, chain) {
            return;
        }
        if let Plan::Stop(reason) = plan {
            return self.stop_chain(session_id, chain, reason, false);
        }
        // A registry re-initialization replaced the instance the request was captured on: its
        // replay would run on a retired instance.
        if !self.deps.provider_current(chain.request.as_ref()).await {
            return self.stop_chain(session_id, chain, "provider instance replaced", false);
        }
        if !self.is_current(session_id, chain) {
            return;
        }
        let Some(target) = Self::target_of(chain) else {
            return self.stop_chain(session_id, chain, "account holding the cache unknown", false);
        };
        // Last check before dispatch, after the final await: a turn that began during the lookups
        // has the cache to itself.
        if self.deps.turn_in_flight(session_id) {
            return self.stop_chain(session_id, chain, "turn in flight", false);
        }
        let sent_at = self.deps.now();
        let (touch_at, ttl_ms, latency) = {
            let c = chain.inner();
            (c.touch_at, c.ttl_ms, c.latency_ms)
        };
        if entry_lapsed(touch_at, ttl_ms, sent_at, latency) {
            return self.stop_chain(session_id, chain, "entry expired before dispatch", false);
        }
        let cancel = CancellationToken::new();
        chain.inner().controller = Some(cancel.clone());
        let seen: Mutex<(Option<WarmUsage>, Option<f64>)> = Mutex::new((None, None));
        let outcome = self
            .deps
            .send(chain.request.as_ref(), &target, &cancel, &mut |reported| {
                let mut seen = seen.lock().unwrap_or_else(PoisonError::into_inner);
                seen.0 = Some(reported.clone());
                seen.1.get_or_insert(self.deps.now());
            })
            .await;
        {
            let mut c = chain.inner();
            c.controller = None;
        }
        let (reported_usage, reported_at) = seen.into_inner().unwrap_or_else(PoisonError::into_inner);
        let (usage, failure) = match outcome {
            Ok(usage) => (Some(usage), None),
            Err(failure) => (failure.usage.clone().or(reported_usage), Some(failure.message)),
        };
        self.settle(session_id, chain, Finished { target: &target, sent_at, reported_at, usage: usage.as_ref(), failure });
        // Billed whatever happened next: success, failure or cancellation.
        if let Some(usage) = usage
            && let Err(message) = self.deps.record_usage(chain.request.as_ref(), &usage, sent_at, &target.account_id).await
        {
            self.deps.log(&format!("{session_id}: warm usage not recorded ({message})"));
        }
    }

    /// What a finished warm means for its chain.
    fn settle(self: &Arc<Self>, session_id: &str, chain: &Arc<Chain>, finished: Finished<'_>) {
        let Finished { target, sent_at, reported_at, usage, failure } = finished;
        if !self.is_current(session_id, chain) {
            return;
        }
        if let Some(message) = failure {
            return self.stop_chain(session_id, chain, &format!("warm failed: {message}"), false);
        }
        let (read, write) = usage.map_or((0.0, 0.0), |u| (u.cached, u.cache_write));
        let rewrite = warm_rewrote(read, write);
        if read.is_nan() || read <= 0.0 || rewrite {
            self.touches.forget(session_id);
            if rewrite {
                self.state().missed.insert(session_id.to_owned());
            }
            return self.stop_chain(session_id, chain, "warm missed the cache", false);
        }
        {
            let mut c = chain.inner();
            c.touch_at = sent_at;
            c.latency_ms = Some(reported_at.unwrap_or_else(|| self.deps.now()) - sent_at);
        }
        self.record_touch(session_id, chain);
        // A read without a write is cache use: the idle auto-clear counts from it.
        self.record_use(
            session_id,
            WarmUse {
                at: sent_at as u64,
                provider: chain.request.provider_name().to_owned(),
                model: chain.request.model().to_owned(),
                account_id: target.account_id.clone(),
            },
        );
        self.schedule(session_id, chain);
    }
}
