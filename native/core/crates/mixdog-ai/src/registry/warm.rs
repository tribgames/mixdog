//! The cache-warm ledger and the per-request cache tail that the compaction
//! trigger reads (`shared/idle-auto-clear-gate.mjs` `lastCacheWarmUseAt` /
//! `cacheWarmUseFor`, `compact-policy.mjs` `requestAccountId`).
//!
//! The warmer records each successful warm of a session (when, and the
//! route and account whose cached prefix it read); [`WarmLedger`] keeps the
//! latest per session. A request's [`RequestTail`] is built once the account
//! that would serve it is planned, so the answers stay synchronous.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use crate::accounts::ACCOUNT_PROVIDERS;
use crate::accounts::rotation::AccountRotation;
use crate::accounts::rotation::SendContext;

/// One successful warm: when it ran and the prefix it read.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WarmUse {
    /// Epoch ms.
    pub at: u64,
    pub provider: String,
    pub model: String,
    /// Empty for a provider without a roster.
    pub account_id: String,
}

/// The route and account a request would read the cache of.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WarmRoute {
    pub provider: String,
    pub model: String,
    pub account_id: String,
}

/// Latest successful warm per session. Clones share the state.
#[derive(Clone, Default)]
pub struct WarmLedger {
    uses: Arc<Mutex<HashMap<String, WarmUse>>>,
}

impl WarmLedger {
    pub fn new() -> Self {
        Self::default()
    }

    fn uses(&self) -> std::sync::MutexGuard<'_, HashMap<String, WarmUse>> {
        self.uses.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records a successful warm of `session_id`, replacing the previous one.
    pub fn record(&self, session_id: &str, warm: WarmUse) {
        self.uses().insert(session_id.to_owned(), warm);
    }

    /// A session deleted for good drops its warm.
    pub fn forget(&self, session_id: &str) {
        self.uses().remove(session_id);
    }

    /// When a warm last used the session's cache on any route (0 when none).
    pub fn last_use_at(&self, session_id: &str) -> u64 {
        self.uses().get(session_id).map_or(0, |u| u.at)
    }

    /// When a warm last used the prefix `route` reads (0: a warm elsewhere
    /// refreshed an entry this request cannot read).
    pub fn use_for(&self, session_id: &str, route: &WarmRoute) -> u64 {
        self.uses()
            .get(session_id)
            .filter(|u| u.provider == route.provider && u.model == route.model && u.account_id == route.account_id)
            .map_or(0, |u| u.at)
    }
}

/// The facts of one request, read when it is built.
pub struct RequestFacts {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub agent_owner: bool,
    /// The session's cache strategy keeps a 5-minute message tail.
    pub five_minute_tail: bool,
    pub last_provider_send_at: u64,
    pub now_ms: u64,
}

/// [`CacheTail`] of one request.
pub struct RequestTail {
    ledger: WarmLedger,
    facts: RequestFacts,
    /// The account that would serve the request: `Some("")` for a provider
    /// without a roster, `None` when a roster provider has no eligible account.
    account: Option<String>,
}

impl RequestTail {
    /// Plans the serving account (`requestAccountId`) and captures the facts.
    /// `ctx` is the send the request would make.
    pub async fn plan(
        ledger: WarmLedger,
        rotation: &AccountRotation,
        facts: RequestFacts,
        ctx: &SendContext,
    ) -> Self {
        let account = if ACCOUNT_PROVIDERS.contains(&facts.provider.as_str()) {
            rotation.planned_account_id(&facts.provider, ctx).await.ok().flatten()
        } else {
            Some(String::new())
        };
        Self { ledger, facts, account }
    }

    /// For a request whose serving account is already known.
    pub fn with_account(ledger: WarmLedger, facts: RequestFacts, account: Option<String>) -> Self {
        Self { ledger, facts, account }
    }
}

// Plain answers for the compaction cache-expiry check; the host that sees the
// agent crate forwards its trait methods to these.
impl RequestTail {
    /// The latest warm of any route (epoch ms, 0 when none).
    pub fn last_use_at(&self) -> u64 {
        self.ledger.last_use_at(&self.facts.session_id)
    }

    /// The latest warm on the route and account the request would use (0: a
    /// warm elsewhere refreshed an entry this request cannot read); `None`
    /// when the account that would serve the request cannot be planned.
    pub fn route_use_at(&self) -> Option<u64> {
        let account_id = self.account.clone()?;
        let route = WarmRoute { provider: self.facts.provider.clone(), model: self.facts.model.clone(), account_id };
        Some(self.ledger.use_for(&self.facts.session_id, &route))
    }

    pub fn agent_owner(&self) -> bool {
        self.facts.agent_owner
    }
    pub fn five_minute_tail(&self) -> bool {
        self.facts.five_minute_tail
    }
    pub fn last_provider_send_at(&self) -> u64 {
        self.facts.last_provider_send_at
    }
    pub fn now_ms(&self) -> u64 {
        self.facts.now_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENT: u64 = 1_000_000;

    fn tail(ledger: &WarmLedger, account: Option<&str>, now: u64) -> RequestTail {
        RequestTail::with_account(
            ledger.clone(),
            RequestFacts {
                session_id: "s".into(),
                provider: "anthropic".into(),
                model: "m".into(),
                agent_owner: true,
                five_minute_tail: true,
                last_provider_send_at: SENT,
                now_ms: now,
            },
            account.map(str::to_owned),
        )
    }

    fn warm(at: u64, account: &str) -> WarmUse {
        WarmUse { at, provider: "anthropic".into(), model: "m".into(), account_id: account.into() }
    }

    #[test]
    fn a_warm_on_the_request_route_is_seen() {
        let ledger = WarmLedger::new();
        let t = tail(&ledger, Some(""), SENT + 400_000);
        assert_eq!((t.last_use_at(), t.route_use_at()), (0, Some(0)), "no warm yet");
        ledger.record("s", warm(SENT + 200_000, ""));
        assert_eq!((t.last_use_at(), t.route_use_at()), (SENT + 200_000, Some(SENT + 200_000)));
    }

    #[test]
    fn a_warm_elsewhere_or_an_unplannable_account_is_not() {
        let ledger = WarmLedger::new();
        ledger.record("s", warm(SENT + 200_000, "other"));
        let mine = tail(&ledger, Some("mine"), SENT);
        assert_eq!((mine.last_use_at(), mine.route_use_at()), (SENT + 200_000, Some(0)));
        assert_eq!(tail(&ledger, None, SENT).route_use_at(), None);
        ledger.forget("s");
        assert_eq!(ledger.last_use_at("s"), 0);
    }
}