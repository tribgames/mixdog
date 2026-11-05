//! "Allow for this session": an action a person allowed from a card for the
//! rest of ONE session. Held in memory by the owning session (a restart asks
//! again), keyed by action — never by target or payload. It ends with its
//! session (the owner drops this value) or when the session is reset (the
//! owner passes a `mark` naming the session's current life; a grant made under
//! another mark is gone), or [`SESSION_GRANT_TTL`] after it was made. A key
//! that can never be remembered is never granted.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use super::action::GrantKey;

pub const SESSION_GRANT_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// Most grants one session holds; the oldest go first.
pub const MAX_SESSION_GRANTS: usize = 256;

struct Entry {
    action: GrantKey,
    agent_id: String,
    mark: String,
    expires_at: Instant,
}

pub struct SessionGrants {
    entries: Mutex<Vec<Entry>>,
    now: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for SessionGrants {
    fn default() -> Self {
        Self::with_clock(Instant::now)
    }
}

impl SessionGrants {
    pub fn with_clock(now: impl Fn() -> Instant + Send + Sync + 'static) -> Self {
        Self {
            entries: Mutex::default(),
            now: Arc::new(now),
        }
    }

    /// Allows `action` as `agent_id` under the session's current `mark`;
    /// false for a key that is never remembered or a missing agent.
    pub fn grant(&self, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        if agent_id.is_empty() || !action.rememberable() {
            return false;
        }
        let now = (self.now)();
        let mut entries = self.entries.lock().expect("session grants");
        entries.retain(|e| e.expires_at > now && &e.action != action);
        entries.push(Entry {
            action: action.clone(),
            agent_id: agent_id.to_owned(),
            mark: mark.to_owned(),
            expires_at: now + SESSION_GRANT_TTL,
        });
        let excess = entries.len().saturating_sub(MAX_SESSION_GRANTS);
        entries.drain(..excess);
        true
    }

    /// Whether `action` is allowed for this session, agent and life of it.
    pub fn has(&self, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        if !action.rememberable() {
            return false;
        }
        let now = (self.now)();
        let mut entries = self.entries.lock().expect("session grants");
        entries.retain(|e| e.expires_at > now);
        let Some(at) = entries.iter().position(|e| &e.action == action) else {
            return false;
        };
        let entry = &entries[at];
        if entry.agent_id == agent_id && entry.mark == mark {
            return true;
        }
        entries.remove(at);
        false
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::approval::ActionKind;

    use super::*;

    fn clocked() -> (SessionGrants, Arc<AtomicU64>) {
        let base = Instant::now();
        let ticks = Arc::new(AtomicU64::new(0));
        let seen = ticks.clone();
        let grants = SessionGrants::with_clock(move || {
            base + Duration::from_secs(seen.load(Ordering::SeqCst))
        });
        (grants, ticks)
    }

    fn comment() -> GrantKey {
        GrantKey::Kind(ActionKind::Comment)
    }

    #[test]
    fn a_grant_covers_its_agent_and_mark_only() {
        let (grants, _) = clocked();
        assert!(grants.grant("bot", &comment(), "life-1"));
        assert!(grants.has("bot", &comment(), "life-1"));
        assert!(!grants.has("other", &comment(), "life-1"));
        // A wrong agent or mark drops the grant.
        assert!(!grants.has("bot", &comment(), "life-1"));
        assert!(grants.grant("bot", &comment(), "life-1"));
        assert!(!grants.has("bot", &comment(), "life-2"));
    }

    #[test]
    fn a_grant_ends_after_the_ttl() {
        let (grants, ticks) = clocked();
        grants.grant("bot", &comment(), "m");
        ticks.store(SESSION_GRANT_TTL.as_secs() - 1, Ordering::SeqCst);
        assert!(grants.has("bot", &comment(), "m"));
        ticks.store(SESSION_GRANT_TTL.as_secs(), Ordering::SeqCst);
        assert!(!grants.has("bot", &comment(), "m"));
    }

    #[test]
    fn payments_and_deletes_are_never_granted() {
        let (grants, _) = clocked();
        for k in [ActionKind::Payment, ActionKind::Delete] {
            assert!(!grants.grant("bot", &GrantKey::Kind(k), "m"));
            assert!(!grants.has("bot", &GrantKey::Kind(k), "m"));
        }
        assert!(!grants.grant("", &comment(), "m"));
    }

    #[test]
    fn the_oldest_grants_go_first_when_full() {
        let (grants, _) = clocked();
        for i in 0..MAX_SESSION_GRANTS + 1 {
            assert!(grants.grant("bot", &GrantKey::Tool(format!("t{i}")), "m"));
        }
        assert!(!grants.has("bot", &GrantKey::Tool("t0".into()), "m"));
        assert!(grants.has("bot", &GrantKey::Tool("t1".into()), "m"));
        assert!(grants.has("bot", &GrantKey::Tool(format!("t{MAX_SESSION_GRANTS}")), "m"));
    }
}
