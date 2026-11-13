//! The pool's send (`account-pool.mjs` `poolSend`): walks the eligible
//! accounts until one answers, blocking the ones whose quota window is spent
//! on the way. It is provider-neutral: the caller supplies an
//! [`AccountSender`] that performs one account-bound attempt (scoped session
//! id, replay filtering, the adapter itself) and a [`UsageProbe`] that
//! re-measures an account's plan usage into the store.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use tokio_util::sync::CancellationToken;

use super::Account;
use super::AccountError;
use super::AccountStore;
use super::BlockOptions;
use super::MAX_ACCOUNTS;
use super::Policy;
use super::Pool;
use super::is_custom_key_provider;
use super::policy;
use crate::oauth::Pace;

/// The cooldown an account's provider asks for when the server named none.
const INFERRED_COOLDOWN_MS: i64 = 5 * 60_000;
/// Burst throttles reopen within seconds; a 429 whose Retry-After points
/// further ahead is a closed subscription window.
const QUOTA_WINDOW_RETRY_AFTER_MS: i64 = 60_000;
/// Pacing of the re-measure of refused accounts.
const PROBE_INTERVAL_MS: i64 = 5 * 60_000;
/// How old a reading may be when the pool picks an account other than the one the send prefers. An older one is
/// measured again before the choice (see `measure_fallback_candidates`).
const FALLBACK_READING_MAX_AGE_MS: i64 = 5 * 60_000;
const SESSION_ACCOUNT_LIMIT: usize = 1000;

/// A provider's roster cooldowns (`accountCooldownPolicy`).
#[derive(Clone, Debug, Default)]
pub struct CooldownPolicy {
    pub floor_ms: Option<i64>,
    pub rate_limited_ms: Option<i64>,
    /// Escalates per consecutive quota refusal of one account.
    pub quota_steps_ms: Vec<i64>,
    pub unknown_ms: Option<i64>,
    /// Rotate on a plain 429 rate limit too.
    pub rotate_on_rate_limit: bool,
    /// When every eligible account is only cooling down, wait for the
    /// earliest cooldown while the send's total wait stays within this bound.
    pub wait_for_cooldown_ms: Option<i64>,
    /// Cooldown of an `accountBlocked` refusal, which then rotates.
    pub blocked_ms: Option<i64>,
}

/// One failed account-bound attempt, with the facts only the attempt knows.
#[derive(Clone, Debug)]
pub struct Failed {
    pub error: ProviderError,
    /// Output already reached the caller.
    pub emitted: bool,
    /// Re-issuing the request is unsafe.
    pub unsafe_to_retry: bool,
    /// An account-level block (the account needs verification).
    pub account_blocked: bool,
    /// The server's id of the limit the refusal named.
    pub quota_limit: String,
}

impl Failed {
    pub fn new(error: ProviderError) -> Self {
        Self {
            error,
            emitted: false,
            unsafe_to_retry: false,
            account_blocked: false,
            quota_limit: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Waiting out a cooldown or switching account.
    Reconnecting {
        message: String,
        wait_ms: Option<i64>,
        retry_at: Option<i64>,
    },
    /// A fallback became the selected account.
    AccountChanged { provider: String, account_id: String, at: i64 },
}

/// One account-bound attempt of the caller's request.
#[async_trait]
pub trait AccountSender<T: Send>: Send + Sync {
    fn cooldown_policy(&self, account_id: &str) -> Option<CooldownPolicy>;
    /// Sends under `account_id`. `scoped` is false for a provider with no
    /// roster, whose send is the plain one.
    async fn send(&self, account_id: &str, scoped: bool) -> Result<T, Failed>;
    /// Stamps the serving account on the answer; `binding_id` is the account
    /// the session stays bound to.
    fn stamp(&self, result: &mut T, account_id: &str, binding_id: &str);
    fn notify(&self, stage: Stage);
}

/// Re-measures an account's plan usage and records it in the store (the
/// usage endpoint costs no model tokens). Failures are the probe's to absorb.
#[async_trait]
pub trait UsageProbe: Send + Sync {
    async fn measure(&self, provider: &str, account_id: &str, force: bool);
}

pub struct SendContext {
    pub model: String,
    pub session_id: Option<String>,
    /// The account the history or provider state says the session ran on.
    pub bound_hint: Option<String>,
    pub cancel: CancellationToken,
    /// Plan quota cached for a provider with no roster (credit use off).
    pub implicit_plan_usage: Option<Account>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuotaExhausted {
    pub provider: String,
    pub model: String,
    pub reset_at: Option<i64>,
}

#[derive(Debug)]
pub enum Cause {
    /// The provider's own error.
    Provider(ProviderError),
    /// `provider_accounts_exhausted`.
    AccountsExhausted { use_credits: bool },
    /// `rate_limited`: every account is cooling down.
    CoolingDown { retry_after_ms: Option<i64> },
    /// A plain error with no provider response behind it.
    Message(String),
    Cancelled,
    Store(AccountError),
}

const ATTEMPTS_EXHAUSTED: &str = "Provider account attempts exhausted.";

/// A send that ended without an answer. `quota_exhausted` is the proof that
/// no account can serve the model, not a generic 429 or a stopped loop.
#[derive(Debug)]
pub struct PoolError {
    pub cause: Cause,
    pub quota_exhausted: Option<QuotaExhausted>,
}

impl PoolError {
    fn of(cause: Cause) -> Self {
        Self { cause, quota_exhausted: None }
    }

    /// The text of the error Node's pool throws for this end (`account-pool.mjs`
    /// `accountsExhaustedError`, `accountsCoolingDownError`, or the error that ended the send).
    pub fn message(&self) -> String {
        match &self.cause {
            Cause::Provider(error) => error.message.clone(),
            Cause::AccountsExhausted { use_credits: true } => {
                "All connected accounts have exhausted their quota. Check account usage and reset times.".into()
            }
            Cause::AccountsExhausted { use_credits: false } => {
                "The plan limit is reached and credit use is off. Turn on credit use or wait for the limit to reset.".into()
            }
            Cause::CoolingDown { .. } => "Every connected account is cooling down after a rate limit. Try again shortly.".into(),
            Cause::Message(message) => message.clone(),
            Cause::Cancelled => "This operation was aborted".into(),
            Cause::Store(error) => error.to_string(),
        }
    }
}

impl From<AccountError> for PoolError {
    fn from(err: AccountError) -> Self {
        Self::of(Cause::Store(err))
    }
}

#[derive(Default)]
struct State {
    quota_strikes: HashMap<String, usize>,
    last_probe: HashMap<String, i64>,
    measured: HashSet<String>,
    sessions: HashMap<String, String>,
    session_order: Vec<String>,
}

/// What one send has done to the roster.
#[derive(Default)]
struct Ledger {
    attempted: HashSet<String>,
    evidenced: HashSet<String>,
    cooled: HashSet<String>,
    waited_ms: i64,
}

#[derive(Clone, Debug)]
struct Verdict {
    exhausted: bool,
    evidence: bool,
    account_blocked: bool,
    until: i64,
    server_scheduled: bool,
    reset: bool,
}

impl Verdict {
    fn not_exhausted() -> Self {
        Self {
            exhausted: false,
            evidence: false,
            account_blocked: false,
            until: 0,
            server_scheduled: false,
            reset: false,
        }
    }
}

fn clamp_ms(value: Option<i64>, fallback: i64) -> i64 {
    value.filter(|v| *v >= 0).unwrap_or(fallback)
}

fn is_server_side(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::Overloaded | ErrorKind::Transient | ErrorKind::ServiceTierUnavailable)
}

fn cooling_until(row: &Account, model: &str) -> i64 {
    policy::account_blocked_until(row, model).unwrap_or(0)
}

fn earliest_cooldown_ms(rows: &[Account], now: i64, model: &str) -> Option<i64> {
    rows.iter()
        .map(|r| cooling_until(r, model))
        .filter(|until| *until > now)
        .min()
        .map(|until| until - now)
}

/// Shared roster-rotation state of one process: quota strikes, probe pacing,
/// session bindings. Clone it freely; clones share the state.
#[derive(Clone)]
pub struct AccountRotation {
    store: AccountStore,
    probe: Arc<dyn UsageProbe>,
    pace: Arc<dyn Pace>,
    state: Arc<Mutex<State>>,
}

impl AccountRotation {
    pub fn new(store: AccountStore, probe: Arc<dyn UsageProbe>, pace: Arc<dyn Pace>) -> Self {
        // One clock for the stored blocks and the waits.
        Self { store: store.with_clock(pace.clone()), probe, pace, state: Arc::default() }
    }

    /// The service clock (`Pace::now_ms`), the one the store's blocks use.
    fn now(&self) -> i64 {
        self.store.now_ms()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sending is the user asking for a current answer: called once per agent
    /// loop entry, never per in-turn provider round.
    pub fn reset_probe_pacing(&self) {
        self.state().last_probe.clear();
    }

    /// Forgets every in-memory session binding, as a restart does.
    pub fn reset_session_bindings(&self) {
        let mut state = self.state();
        state.sessions.clear();
        state.session_order.clear();
    }

    fn session_binding(&self, key: &str) -> Option<String> {
        self.state().sessions.get(key).cloned()
    }

    fn remember_session(&self, key: &str, id: &str) {
        let mut state = self.state();
        state.session_order.retain(|k| k != key);
        state.session_order.push(key.to_owned());
        state.sessions.insert(key.to_owned(), id.to_owned());
        if state.session_order.len() > SESSION_ACCOUNT_LIMIT {
            let oldest = state.session_order.remove(0);
            state.sessions.remove(&oldest);
        }
    }

    fn session_key(provider: &str, ctx: &SendContext) -> Option<String> {
        ctx.session_id.as_ref().map(|s| format!("{provider}:{s}"))
    }

    fn bound_id(&self, key: Option<&str>, ctx: &SendContext) -> Option<String> {
        key.and_then(|k| self.session_binding(k)).or_else(|| ctx.bound_hint.clone())
    }

    /// The account a send of `ctx.model` would try first right now, or `None`
    /// when the provider has no roster account or none is eligible.
    pub async fn planned_account_id(&self, provider: &str, ctx: &SendContext) -> Result<Option<String>, AccountError> {
        let pool = self.store.pool(provider).await?;
        if pool.accounts.is_empty() {
            return Ok(None);
        }
        let key = Self::session_key(provider, ctx);
        let bound = self.bound_id(key.as_deref(), ctx);
        Ok(policy::choose_account(&pool, &HashSet::new(), self.now(),&ctx.model, bound.as_deref())
            .map(|r| r.id.clone()))
    }

    // -- refusal judgement ---------------------------------------------------

    fn policy_cooldown_ms(&self, policy: &CooldownPolicy, strike_key: &str, reason: &str) -> i64 {
        if reason == "rate_limited" {
            return clamp_ms(policy.rate_limited_ms, INFERRED_COOLDOWN_MS);
        }
        if reason == "quota" && !policy.quota_steps_ms.is_empty() {
            let mut state = self.state();
            let strikes = state.quota_strikes.entry(strike_key.to_owned()).or_insert(0);
            let step = policy.quota_steps_ms[(*strikes).min(policy.quota_steps_ms.len() - 1)];
            *strikes += 1;
            return clamp_ms(Some(step), INFERRED_COOLDOWN_MS);
        }
        clamp_ms(policy.unknown_ms, INFERRED_COOLDOWN_MS)
    }

    /// A block covers the quota bucket of the model that failed, which only a
    /// usage reading names: an account with no reading is measured once per
    /// process before it is blocked.
    async fn measure_once(&self, provider: &str, row: &Account) {
        let key = format!("{provider}:{}", row.id);
        {
            let mut state = self.state();
            if row.usage.as_ref().is_some_and(|u| !u.windows.is_empty()) {
                state.measured.remove(&key);
                return;
            }
            if !state.measured.insert(key) {
                return;
            }
        }
        self.probe.measure(provider, &row.id, false).await;
    }

    /// Whether the failed account's quota is exhausted, plus when the block
    /// lifts: the real reset when the provider named one, else the advised
    /// delay, else the policy's or an inferred five minutes.
    async fn judge(
        &self,
        provider: &str,
        row: &Account,
        model: &str,
        failed: &Failed,
        policy: Option<&CooldownPolicy>,
    ) -> Result<Verdict, AccountError> {
        let error = &failed.error;
        let now = self.now();
        let delay = error.retry_after.map_or(0, |d| d.as_millis() as i64);
        let reset_at = error
            .reset_at
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);
        let floor = policy.map_or(0, |p| clamp_ms(p.floor_ms, 0));
        let until_for = |with_reset: bool, reason: &str| -> (i64, bool, bool) {
            if with_reset && reset_at > now {
                return (reset_at, true, true);
            }
            if delay > 0 {
                return (now + delay.max(floor), true, false);
            }
            match policy {
                Some(p) => {
                    let ms = self.policy_cooldown_ms(p, &format!("{provider}:{}", row.id), reason);
                    (now + ms.max(floor), false, false)
                }
                None => (now + INFERRED_COOLDOWN_MS, false, false),
            }
        };
        let blocked = |evidence: bool, reason: &str, with_reset: bool| {
            let (until, server_scheduled, reset) = until_for(with_reset, reason);
            Verdict { exhausted: true, evidence, account_blocked: false, until, server_scheduled, reset }
        };
        if is_server_side(error.kind) {
            return Ok(Verdict::not_exhausted());
        }
        let blocked_ms = policy.map_or(0, |p| clamp_ms(p.blocked_ms, 0));
        if failed.account_blocked && blocked_ms > 0 {
            return Ok(Verdict {
                exhausted: true,
                evidence: false,
                account_blocked: true,
                until: now + blocked_ms.max(floor),
                server_scheduled: false,
                reset: false,
            });
        }
        // Only an explicit quota / plan / billing refusal advances the roster
        // as quota; auth refusals say nothing about the quota.
        let typed = error.kind.is_quota() && !matches!(error.status, Some(401 | 403));
        if typed {
            self.measure_once(provider, row).await;
            return Ok(blocked(true, "quota", true));
        }
        if policy.is_some_and(|p| p.rotate_on_rate_limit)
            && error.kind == ErrorKind::RateLimited
            && error.status == Some(429)
        {
            self.measure_once(provider, row).await;
            return Ok(blocked(false, "rate_limited", false));
        }
        let mut exhausted = error.status == Some(429) && delay > QUOTA_WINDOW_RETRY_AFTER_MS;
        let mut evidence = false;
        if error.status == Some(429) {
            self.probe.measure(provider, &row.id, true).await;
            let pool = self.store.pool(provider).await?;
            if let Some(entry) = pool.account(&row.id) {
                let credits = pool.uses_credits();
                let now = self.now();
                evidence = policy::account_exhausted(&entry.with_blocks(|_| false), now, model, credits);
                exhausted = exhausted || evidence || policy::account_exhausted(entry, now, model, credits);
            }
        }
        if !exhausted {
            return Ok(Verdict { evidence, ..Verdict::not_exhausted() });
        }
        Ok(blocked(evidence, if evidence { "quota" } else { "unknown" }, evidence))
    }

    async fn record_block(&self, provider: &str, id: &str, model: &str, failed: &Failed, v: &Verdict) -> Result<(), AccountError> {
        self.store
            .block(
                provider,
                id,
                v.until,
                if v.account_blocked { "" } else { model },
                BlockOptions {
                    server_scheduled: v.server_scheduled,
                    quota: v.evidence,
                    limit: if v.account_blocked { String::new() } else { failed.quota_limit.clone() },
                    reset: v.reset,
                },
            )
            .await?;
        Ok(())
    }

    /// A refusal an account gave outside the pool's send (a cache warm, which
    /// never rotates), judged and recorded exactly as the send would. Returns
    /// whether the account was blocked.
    pub async fn record_refusal(
        &self,
        provider: &str,
        account_id: &str,
        model: &str,
        failed: &Failed,
        cooldown: Option<&CooldownPolicy>,
    ) -> Result<bool, AccountError> {
        let pool = self.store.pool(provider).await?;
        let Some(row) = pool.account(account_id) else {
            return Ok(false);
        };
        let verdict = self.judge(provider, row, model, failed, cooldown).await?;
        if !verdict.exhausted {
            return Ok(false);
        }
        self.record_block(provider, account_id, model, failed, &verdict).await?;
        Ok(true)
    }

    // -- roster-level verdicts -------------------------------------------------

    /// Whether every account in `ids` (default: the roster; under manual
    /// policy the selected account alone) is exhausted with quota evidence:
    /// observed in this send, or a full window.
    fn roster_exhaustion(
        &self,
        pool: &Pool,
        model: &str,
        evidenced: &HashSet<String>,
        ids: Option<&[String]>,
    ) -> (Vec<Account>, bool, i64, bool) {
        let manual_scope: Vec<String>;
        let scope = match ids {
            Some(ids) => Some(ids),
            None if pool.policy() == Policy::Manual => {
                manual_scope = pool.selected_id.clone().into_iter().collect();
                Some(manual_scope.as_slice())
            }
            None => None,
        };
        let rows: Vec<Account> = pool
            .accounts
            .iter()
            .filter(|r| scope.is_none_or(|s| s.contains(&r.id)))
            .cloned()
            .collect();
        let credits = pool.uses_credits();
        let now = self.now();
        let all = !rows.is_empty()
            && rows.iter().all(|row| {
                if evidenced.contains(&row.id) {
                    policy::account_exhausted(row, now, model, credits)
                } else {
                    let quota_only = row.with_blocks(|b| b.blocked_quota == Some(true));
                    policy::account_exhausted(&quota_only, now, model, credits)
                }
            });
        (rows, credits, now, all)
    }

    fn exhausted_send_error(
        &self,
        provider: &str,
        pool: &Pool,
        model: &str,
        evidenced: &HashSet<String>,
        error: Option<Cause>,
        ids: Option<&[String]>,
    ) -> PoolError {
        let (rows, credits, now, all) = self.roster_exhaustion(pool, model, evidenced, ids);
        if all {
            return PoolError {
                cause: error.unwrap_or(Cause::AccountsExhausted { use_credits: credits }),
                quota_exhausted: Some(QuotaExhausted {
                    provider: provider.to_owned(),
                    model: model.to_owned(),
                    reset_at: policy::accounts_reset_at(&rows, now, model, credits),
                }),
            };
        }
        PoolError::of(
            error.unwrap_or(Cause::CoolingDown { retry_after_ms: earliest_cooldown_ms(&rows, now, model) }),
        )
    }

    /// Before the pool gives up, re-measures EVERY account it is about to
    /// refuse for, paced per account. Returns whether it measured any.
    async fn probe_refused(&self, provider: &str, pool: &Pool, model: &str) -> bool {
        let now = self.now();
        let mut due: Vec<&Account> = {
            let state = self.state();
            pool.accounts
                .iter()
                .filter(|r| policy::account_exhausted(r, now, model, pool.uses_credits()))
                .filter(|r| now - state.last_probe.get(&format!("{provider}:{}", r.id)).copied().unwrap_or(0) >= PROBE_INTERVAL_MS)
                .collect()
        };
        if due.is_empty() {
            return false;
        }
        due.sort_by_key(|r| r.usage.as_ref().map_or(0, |u| u.checked_at));
        {
            let mut state = self.state();
            for row in &due {
                state.last_probe.insert(format!("{provider}:{}", row.id), now);
            }
        }
        futures::future::join_all(due.iter().map(|row| self.probe.measure(provider, &row.id, true))).await;
        true
    }

    /// Before the pool moves a send to an account it does not prefer (the selected one, or the session's under the
    /// headroom policy), re-measures the usable accounts whose reading is older than [`FALLBACK_READING_MAX_AGE_MS`],
    /// paced per account like every probe. Returns whether it measured any.
    ///
    /// Not Node's: there the fallback is chosen on whatever the roster last recorded, and an account nobody used for a
    /// day is offered with the reading of a day ago. A spent one then costs a refused request and another switch; a
    /// fresh reading that shows a full window keeps the request from being sent to it at all, and lets the headroom
    /// ranking see every candidate. The same reason other clients read each candidate's usage as they rank them.
    async fn measure_fallback_candidates(&self, provider: &str, pool: &Pool, excluded: &HashSet<String>, model: &str) -> bool {
        let now = self.now();
        let due: Vec<&Account> = {
            let state = self.state();
            pool.accounts
                .iter()
                .filter(|r| !excluded.contains(&r.id) && !policy::account_exhausted(r, now, model, pool.uses_credits()))
                .filter(|r| now - r.usage.as_ref().map_or(0, |u| u.checked_at) > FALLBACK_READING_MAX_AGE_MS)
                .filter(|r| now - state.last_probe.get(&format!("{provider}:{}", r.id)).copied().unwrap_or(0) >= PROBE_INTERVAL_MS)
                .collect()
        };
        if due.is_empty() {
            return false;
        }
        {
            let mut state = self.state();
            for row in &due {
                state.last_probe.insert(format!("{provider}:{}", row.id), now);
            }
        }
        futures::future::join_all(due.iter().map(|row| self.probe.measure(provider, &row.id, true))).await;
        true
    }

    /// A cooldown-only eligible set whose earliest cooldown ends inside the
    /// remaining wait budget is waited out; otherwise the send fails.
    async fn wait_out_cooldown_or_fail<T: Send>(
        &self,
        provider: &str,
        ctx: &SendContext,
        sender: &dyn AccountSender<T>,
        ledger: &mut Ledger,
        error: Option<ProviderError>,
        ids: Option<&[String]>,
    ) -> Result<(), PoolError> {
        let pool = self.store.pool(provider).await?;
        let model = ctx.model.as_str();
        let (rows, _, now, all) = self.roster_exhaustion(&pool, model, &ledger.evidenced, ids);
        let first = ids
            .and_then(|i| i.first().cloned())
            .or_else(|| pool.selected_id.clone())
            .unwrap_or_else(|| "default".into());
        let bound = sender.cooldown_policy(&first).map_or(0, |p| clamp_ms(p.wait_for_cooldown_ms, 0));
        // Persisting a short cooldown can outlast its deadline: release only
        // attempts cooled by this send, and only under an enabled wait policy.
        let expired = bound > 0
            && rows.iter().any(|r| ledger.cooled.contains(&r.id) && cooling_until(r, model) <= now);
        let wait = if all {
            None
        } else if expired {
            Some(0)
        } else {
            earliest_cooldown_ms(&rows, now, model)
        };
        let Some(wait) = wait.filter(|w| ledger.waited_ms + w <= bound) else {
            return Err(self.exhausted_send_error(
                provider,
                &pool,
                model,
                &ledger.evidenced,
                error.map(Cause::Provider),
                ids,
            ));
        };
        sender.notify(Stage::Reconnecting {
            message: format!(
                "Rate limited — every account is cooling down; retrying in {}s",
                (wait + 999) / 1000
            ),
            wait_ms: Some(wait),
            retry_at: Some(now + wait),
        });
        if ctx.cancel.is_cancelled() {
            return Err(PoolError::of(Cause::Cancelled));
        }
        tokio::select! {
            () = ctx.cancel.cancelled() => return Err(PoolError::of(Cause::Cancelled)),
            () = self.pace.wait(Duration::from_millis(wait as u64)) => {}
        }
        ledger.waited_ms += wait;
        let lifted = self.now();
        for row in self.store.pool(provider).await?.accounts {
            if ledger.cooled.contains(&row.id) && cooling_until(&row, model) <= lifted {
                ledger.cooled.remove(&row.id);
                ledger.attempted.remove(&row.id);
            }
        }
        Ok(())
    }

    /// No roster: with credit use off, a stored reading showing the plan's
    /// window spent refuses before the implicit account sends.
    fn plan_quota_spent(&self, provider: &str, pool: &Pool, ctx: &SendContext) -> Option<PoolError> {
        let now = self.now();
        if pool.uses_credits() {
            return None;
        }
        let row = ctx.implicit_plan_usage.as_ref()?;
        if row
            .usage
            .as_ref()
            .is_some_and(|u| !u.windows.is_empty() && !policy::stale_quota_windows(provider, &u.windows))
            && policy::account_exhausted(row, now, &ctx.model, false)
        {
            return Some(PoolError {
                cause: Cause::AccountsExhausted { use_credits: false },
                quota_exhausted: Some(QuotaExhausted {
                    provider: provider.to_owned(),
                    model: ctx.model.clone(),
                    reset_at: policy::accounts_reset_at(std::slice::from_ref(row), now, &ctx.model, false),
                }),
            });
        }
        None
    }

    /// Commit only a successful fallback, without overwriting a newer
    /// selection (compared under the write's lock). A fallback forced by a
    /// model-scoped limit serves this request only.
    async fn commit_fallback(
        &self,
        provider: &str,
        pool: &Pool,
        row: &Account,
        model: &str,
        refusal_scoped: bool,
        policy_now: Policy,
    ) -> Result<bool, AccountError> {
        if pool.selected_id.as_deref() == Some(row.id.as_str()) || refusal_scoped {
            return Ok(false);
        }
        if self.exhausted_for_model_only(provider, pool.selected_id.as_deref(), model).await? {
            return Ok(false);
        }
        Ok(self
            .store
            .select_if(provider, pool.selected_id.as_deref(), &row.id, Some(policy_now))
            .await?
            .is_some())
    }

    async fn exhausted_for_model_only(&self, provider: &str, id: Option<&str>, model: &str) -> Result<bool, AccountError> {
        let pool = self.store.pool(provider).await?;
        Ok(id.and_then(|id| pool.account(id)).is_some_and(|row| {
            policy::account_exhausted_for_model_only(row, self.now(), model, pool.uses_credits())
        }))
    }

    /// Headroom policy: a session's first pick, or its move off its account
    /// on a limit, becomes the selection; continuing on its account does not.
    /// Returns `(scoped, commit)`.
    async fn bind_served(
        &self,
        provider: &str,
        sender_stamp: impl FnOnce(&str),
        row_id: &str,
        model: &str,
        b: &Binding<'_>,
    ) -> Result<(bool, bool), AccountError> {
        let left_bound = b.bound_id.is_some_and(|bound| row_id != bound);
        let scoped = if b.switched {
            b.refusal_scoped
        } else {
            b.policy == Policy::Headroom && left_bound && self.exhausted_for_model_only(provider, b.bound_id, model).await?
        };
        let binding = if scoped { b.bound_id.unwrap_or(row_id) } else { row_id };
        sender_stamp(binding);
        if let Some(key) = b.session_key
            && b.policy == Policy::Headroom
            && !scoped
        {
            self.remember_session(key, row_id);
        }
        Ok((scoped, b.policy != Policy::Headroom || b.bound_id.is_none() || left_bound))
    }

    /// Walks the eligible accounts until one answers.
    pub async fn pool_send<T: Send>(
        &self,
        provider: &str,
        ctx: &SendContext,
        sender: &dyn AccountSender<T>,
    ) -> Result<T, PoolError> {
        let model = ctx.model.as_str();
        let mut ledger = Ledger::default();
        let mut last_error: Option<ProviderError> = None;
        let mut probed = false;
        let mut ranked = false;
        let mut sends = 0;
        let session_key = Self::session_key(provider, ctx);
        let bound_id = self.bound_id(session_key.as_deref(), ctx);
        let (mut switched, mut refusal_scoped) = (false, false);
        while ledger.attempted.len() < MAX_ACCOUNTS && sends < MAX_ACCOUNTS {
            if ctx.cancel.is_cancelled() {
                return Err(PoolError::of(Cause::Cancelled));
            }
            let pool = self.store.pool(provider).await?;
            if pool.accounts.is_empty() {
                // A custom provider's key has no plan meter to consult.
                if !is_custom_key_provider(provider)
                    && let Some(refused) = self.plan_quota_spent(provider, &pool, ctx)
                {
                    return Err(refused);
                }
                return sender.send("default", false).await.map_err(|f| PoolError::of(Cause::Provider(f.error)));
            }
            let policy_now = pool.policy();
            let Some(row) = policy::choose_account(&pool, &ledger.attempted, self.now(), model, bound_id.as_deref()).cloned()
            else {
                // Once per send: a refusal built on a stale meter must not
                // outlive the meter. Tried before the failure is reported.
                if !probed {
                    probed = true;
                    if self.probe_refused(provider, &pool, model).await {
                        continue;
                    }
                }
                self.wait_out_cooldown_or_fail(provider, ctx, sender, &mut ledger, last_error.clone(), None).await?;
                continue;
            };
            // Once per send: an account the send does not prefer is chosen on current readings.
            let preferred = if policy_now == Policy::Headroom { bound_id.as_deref() } else { pool.selected_id.as_deref() };
            if !ranked && policy_now != Policy::Manual && preferred != Some(row.id.as_str()) {
                ranked = true;
                if self.measure_fallback_candidates(provider, &pool, &ledger.attempted, model).await {
                    continue;
                }
            }
            ledger.attempted.insert(row.id.clone());
            sends += 1;
            let failed = match sender.send(&row.id, true).await {
                Ok(mut result) => {
                    self.state().quota_strikes.remove(&format!("{provider}:{}", row.id));
                    let binding = Binding {
                        policy: policy_now,
                        bound_id: bound_id.as_deref(),
                        session_key: session_key.as_deref(),
                        switched,
                        refusal_scoped,
                    };
                    let (scoped, commit) = self
                        .bind_served(provider, |binding_id| sender.stamp(&mut result, &row.id, binding_id), &row.id, model, &binding)
                        .await?;
                    if commit && self.commit_fallback(provider, &pool, &row, model, scoped, policy_now).await? {
                        sender.notify(Stage::AccountChanged {
                            provider: provider.to_owned(),
                            account_id: row.id.clone(),
                            at: self.now(),
                        });
                    }
                    return Ok(result);
                }
                Err(failed) => failed,
            };
            if ctx.cancel.is_cancelled() {
                return Err(PoolError::of(Cause::Provider(failed.error)));
            }
            let unretryable = |unsafe_to_retry: bool| {
                failed.emitted || unsafe_to_retry || failed.error.exposure.text_emitted || failed.error.exposure.tool_dispatched
            };
            if failed.error.reauth_required {
                if policy_now == Policy::Manual || unretryable(failed.unsafe_to_retry) {
                    return Err(PoolError::of(Cause::Provider(failed.error)));
                }
                last_error = Some(failed.error);
                switched = true;
                refusal_scoped = false;
                sender.notify(Stage::Reconnecting {
                    message: "Sign-in expired — switching to the next account".into(),
                    wait_ms: None,
                    retry_at: None,
                });
                continue;
            }
            let cooldown = sender.cooldown_policy(&row.id);
            let verdict = self.judge(provider, &row, model, &failed, cooldown.as_ref()).await?;
            if !verdict.exhausted {
                return Err(PoolError::of(Cause::Provider(failed.error)));
            }
            if verdict.evidence {
                ledger.evidenced.insert(row.id.clone());
            } else {
                ledger.cooled.insert(row.id.clone());
            }
            self.record_block(provider, &row.id, model, &failed, &verdict).await?;
            // An account block is unsafe to re-issue on THAT account only.
            if unretryable(failed.unsafe_to_retry && !verdict.account_blocked) {
                return Err(PoolError::of(Cause::Provider(failed.error)));
            }
            if policy_now == Policy::Manual {
                self.wait_out_cooldown_or_fail(provider, ctx, sender, &mut ledger, Some(failed.error.clone()), Some(std::slice::from_ref(&row.id)))
                    .await?;
                last_error = Some(failed.error);
                continue;
            }
            last_error = Some(failed.error);
            switched = true;
            refusal_scoped = self.exhausted_for_model_only(provider, Some(&row.id), model).await?;
            let reason = if verdict.evidence {
                "Quota exhausted"
            } else if verdict.account_blocked {
                "Account blocked"
            } else {
                "Rate limited (cooldown)"
            };
            sender.notify(Stage::Reconnecting {
                message: format!("{reason} — switching to the next account"),
                wait_ms: None,
                retry_at: None,
            });
        }
        let pool = self.store.pool(provider).await?;
        // Node: `lastError || new Error('Provider account attempts exhausted.')`.
        let last = last_error.map_or_else(|| Cause::Message(ATTEMPTS_EXHAUSTED.into()), Cause::Provider);
        Err(self.exhausted_send_error(provider, &pool, model, &ledger.evidenced, Some(last), None))
    }
}

struct Binding<'a> {
    policy: Policy,
    bound_id: Option<&'a str>,
    session_key: Option<&'a str>,
    switched: bool,
    refusal_scoped: bool,
}
