//! `CacheWarmLedger` / `CacheTail` over `mixdog_ai::registry::warm`: a request's tail is planned
//! once the account that would serve it is known, so every answer here is synchronous.

use mixdog_agent::compact::triggers::CacheTail;
use mixdog_agent::compact::triggers::CacheWarmLedger;
use mixdog_ai::registry::warm::RequestTail;

/// The cache facts of one request.
pub struct RequestCacheTail(pub RequestTail);

impl RequestCacheTail {
    /// `tail` is `RequestTail::plan(..)` or `RequestTail::with_account(..)` for the request.
    pub fn new(tail: RequestTail) -> Self {
        Self(tail)
    }
}

impl CacheWarmLedger for RequestCacheTail {
    fn last_use_at(&self) -> u64 {
        self.0.last_use_at()
    }

    fn route_use_at(&self) -> Option<u64> {
        self.0.route_use_at()
    }
}

impl CacheTail for RequestCacheTail {
    fn agent_owner(&self) -> bool {
        self.0.agent_owner()
    }

    fn five_minute_tail(&self) -> bool {
        self.0.five_minute_tail()
    }

    fn last_provider_send_at(&self) -> u64 {
        self.0.last_provider_send_at()
    }

    fn now_ms(&self) -> u64 {
        self.0.now_ms()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::triggers::CacheExpiryInput;
    use mixdog_agent::compact::triggers::should_compact_for_expired_agent_cache;
    use mixdog_ai::registry::warm::RequestFacts;
    use mixdog_ai::registry::warm::WarmLedger;
    use mixdog_ai::registry::warm::WarmUse;

    use super::*;

    fn facts(last_send: u64, now: u64) -> RequestFacts {
        RequestFacts {
            session_id: "s".into(),
            provider: "anthropic-oauth".into(),
            model: "m".into(),
            agent_owner: true,
            five_minute_tail: true,
            last_provider_send_at: last_send,
            now_ms: now,
        }
    }

    #[test]
    fn a_warm_on_the_requests_route_keeps_the_tail_alive() {
        let ledger = WarmLedger::new();
        ledger.record(
            "s",
            WarmUse { at: 1_000_000, provider: "anthropic-oauth".into(), model: "m".into(), account_id: "a".into() },
        );
        let tail = RequestCacheTail::new(RequestTail::with_account(ledger, facts(100, 1_100_000), Some("a".into())));
        assert_eq!(tail.last_use_at(), 1_000_000);
        assert_eq!(tail.route_use_at(), Some(1_000_000));
        fn input(t: &RequestCacheTail) -> CacheExpiryInput<'_> {
            CacheExpiryInput {
                agent_owner: t.agent_owner(),
                five_minute_tail: t.five_minute_tail(),
                last_provider_send_at: t.last_provider_send_at(),
                now_ms: t.now_ms(),
                warm: t,
            }
        }
        assert!(!should_compact_for_expired_agent_cache(&input(&tail)));
        // a warm on another account refreshed an entry this request cannot read
        let other = RequestCacheTail::new(RequestTail::with_account(
            {
                let l = WarmLedger::new();
                l.record("s", WarmUse { at: 1_000_000, provider: "anthropic-oauth".into(), model: "m".into(), account_id: "b".into() });
                l
            },
            facts(100, 1_100_000),
            Some("a".into()),
        ));
        assert_eq!(other.route_use_at(), Some(0));
        assert!(should_compact_for_expired_agent_cache(&input(&other)));
    }
}
