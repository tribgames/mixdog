//! The two triggers that arm a compaction regardless of the token threshold:
//! tool-result media the provider would refuse, and an expired agent cache tail.
//! Both are judged at the moment a request is built, from values the host
//! supplies; nothing here waits or fires on a timer.

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Role;

use crate::message::AgentMessage;

/// Anthropic refuses a request body over 32 MB however few tokens it holds,
/// and inline media is what gets there. Tool-result media is the part
/// compaction drops, so it alone arms the trigger; attachments the user sent
/// survive compaction and would only make it repeat.
const REQUEST_MEDIA_COMPACT_BYTES: u64 = 24_000_000;
/// Providers also cap the number of images plus native documents one request
/// may carry (100 on Anthropic).
const REQUEST_MEDIA_COMPACT_COUNT: u64 = 100;

/// Anthropic's 5m message-tail TTL, given to agent sessions.
pub const AGENT_MESSAGE_CACHE_TTL_MS: u64 = 5 * 60_000;

/// The wire media one tool result carries, as the attachment store sizes it
/// (a stored attachment by its recorded size, never by reading the blob).
pub trait ToolMediaMeter: Send + Sync {
    /// Base64 bytes of the images and native documents in `content`.
    fn bytes(&self, content: &Content, native_pdf: bool) -> u64;
    /// Images plus native documents in `content`.
    fn count(&self, content: &Content, native_pdf: bool) -> u64;
}

/// Whether tool-result media alone would make the next request too large.
pub fn should_compact_for_request_media(
    messages: &[AgentMessage],
    native_pdf: bool,
    media: &dyn ToolMediaMeter,
) -> bool {
    let mut bytes = 0;
    let mut count = 0;
    for message in messages.iter().filter(|m| m.role() == Role::Tool) {
        bytes += media.bytes(&message.message.content, native_pdf);
        count += media.count(&message.message.content, native_pdf);
        if bytes >= REQUEST_MEDIA_COMPACT_BYTES || count > REQUEST_MEDIA_COMPACT_COUNT {
            return true;
        }
    }
    false
}

/// When a successful cache warm last used the session's prefix. A warm
/// refreshes the tail without moving the session's own send time.
pub trait CacheWarmLedger: Send + Sync {
    /// The latest warm of any route (epoch ms, 0 when none).
    fn last_use_at(&self) -> u64;
    /// The latest warm on the route and account the request would use (0: a
    /// warm elsewhere refreshed an entry this request cannot read); `None`
    /// when the account that would serve the request cannot be planned.
    fn route_use_at(&self) -> Option<u64>;
}

/// The session facts the cache-expiry check reads, at the moment a request is built.
pub trait CacheTail: CacheWarmLedger {
    fn agent_owner(&self) -> bool;
    /// The session's cache strategy keeps a 5-minute message tail.
    fn five_minute_tail(&self) -> bool;
    /// When the session last sent a request (epoch ms, 0 when never).
    fn last_provider_send_at(&self) -> u64;
    fn now_ms(&self) -> u64;
}

pub struct CacheExpiryInput<'a> {
    pub agent_owner: bool,
    /// The session's cache strategy keeps a 5-minute message tail.
    pub five_minute_tail: bool,
    /// When the session last sent a request (epoch ms, 0 when never).
    pub last_provider_send_at: u64,
    pub now_ms: u64,
    pub warm: &'a dyn CacheWarmLedger,
}

/// Whether the agent session's 5m message tail expired before this request.
/// A send this long after the previous one would rewrite the whole
/// accumulated transcript; compacting first makes that cold write the
/// compacted transcript instead.
pub fn should_compact_for_expired_agent_cache(input: &CacheExpiryInput<'_>) -> bool {
    if !input.agent_owner || !input.five_minute_tail || input.last_provider_send_at == 0 {
        return false;
    }
    let last_send = input.last_provider_send_at;
    if input.now_ms.saturating_sub(last_send) <= AGENT_MESSAGE_CACHE_TTL_MS && input.now_ms >= last_send {
        return false;
    }
    // No warm since the last send: the tail expired.
    if input.warm.last_use_at() <= last_send {
        return true;
    }
    match input.warm.route_use_at() {
        None => true,
        Some(warm_at) => {
            input.now_ms as i128 - last_send.max(warm_at) as i128 > AGENT_MESSAGE_CACHE_TTL_MS as i128
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Ledger(u64, Option<u64>);
    impl CacheWarmLedger for Ledger {
        fn last_use_at(&self) -> u64 {
            self.0
        }
        fn route_use_at(&self) -> Option<u64> {
            self.1
        }
    }

    fn input(ledger: &Ledger, now_ms: u64) -> CacheExpiryInput<'_> {
        CacheExpiryInput { agent_owner: true, five_minute_tail: true, last_provider_send_at: 1_000_000, now_ms, warm: ledger }
    }

    #[test]
    fn tail_within_ttl_is_warm() {
        assert!(!should_compact_for_expired_agent_cache(&input(&Ledger(0, Some(0)), 1_000_000 + AGENT_MESSAGE_CACHE_TTL_MS)));
    }

    #[test]
    fn expired_without_a_warm_arms() {
        assert!(should_compact_for_expired_agent_cache(&input(&Ledger(0, Some(0)), 1_000_001 + AGENT_MESSAGE_CACHE_TTL_MS)));
    }

    #[test]
    fn a_warm_on_the_request_route_keeps_the_tail() {
        let now = 1_000_000 + AGENT_MESSAGE_CACHE_TTL_MS + 60_000;
        assert!(!should_compact_for_expired_agent_cache(&input(&Ledger(now - 1000, Some(now - 1000)), now)));
        // A warm elsewhere refreshed an entry this request cannot read.
        assert!(should_compact_for_expired_agent_cache(&input(&Ledger(now - 1000, Some(0)), now)));
        assert!(should_compact_for_expired_agent_cache(&input(&Ledger(now - 1000, None), now)));
    }

    #[test]
    fn non_agent_or_other_strategy_never_arms() {
        let ledger = Ledger(0, Some(0));
        let mut i = input(&ledger, u64::MAX / 2);
        i.agent_owner = false;
        assert!(!should_compact_for_expired_agent_cache(&i));
        i.agent_owner = true;
        i.five_minute_tail = false;
        assert!(!should_compact_for_expired_agent_cache(&i));
    }

    struct Fixed(u64, u64);
    impl ToolMediaMeter for Fixed {
        fn bytes(&self, _: &Content, _: bool) -> u64 {
            self.0
        }
        fn count(&self, _: &Content, _: bool) -> u64 {
            self.1
        }
    }

    fn tools(n: usize) -> Vec<AgentMessage> {
        (0..n).map(|i| AgentMessage::tool_text(format!("c{i}"), "x", crate::message::ToolKind::Normal)).collect()
    }

    #[test]
    fn media_arms_on_bytes_or_count() {
        assert!(should_compact_for_request_media(&tools(1), true, &Fixed(24_000_000, 1)));
        assert!(!should_compact_for_request_media(&tools(1), true, &Fixed(23_999_999, 100)));
        assert!(should_compact_for_request_media(&tools(1), true, &Fixed(0, 101)));
        // Bytes accumulate across tool results; user messages never count.
        assert!(should_compact_for_request_media(&tools(3), true, &Fixed(8_000_000, 0)));
        let user = vec![AgentMessage::user("x")];
        assert!(!should_compact_for_request_media(&user, true, &Fixed(u64::MAX / 2, 1000)));
    }
}
