//! "Allow for this session": an action a person allowed from a card for the
//! rest of ONE session (`human-gate/session-grants.mjs`). Held in memory (a
//! restart asks again) in one registry for the whole process, keyed by session
//! and action — never by target or payload. A grant ends when its session is
//! reset or closed (the owner passes a `mark` naming the session's current
//! life; a grant made under another mark is gone), or [`SESSION_GRANT_TTL`]
//! after it was made. The registry holds at most [`MAX_SESSION_GRANTS`] grants
//! across every session: the oldest grant goes first, whichever session made
//! it. A key that can never be remembered is never granted.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use super::action::GrantKey;

/// `SESSION_GRANT_TTL_MS`.
pub const SESSION_GRANT_TTL: Duration = Duration::from_secs(12 * 60 * 60);

/// `MAX_SESSION_GRANTS`: most grants the registry holds at once, over every session.
pub const MAX_SESSION_GRANTS: usize = 256;

struct Entry {
    session: String,
    action: GrantKey,
    agent_id: String,
    mark: String,
    expires_at: Instant,
}

/// `createSessionGrants`: the process's "Allow for this session" grants, oldest first.
pub struct SessionGrantRegistry {
    entries: Mutex<Vec<Entry>>,
    now: Arc<dyn Fn() -> Instant + Send + Sync>,
    ttl: Duration,
    max_entries: usize,
}

impl SessionGrantRegistry {
    /// Node's settings on the wall clock.
    pub fn new() -> Arc<Self> {
        Self::with_settings(Instant::now, SESSION_GRANT_TTL, MAX_SESSION_GRANTS)
    }

    /// `createSessionGrants({ now, ttlMs, maxEntries })`.
    pub fn with_settings(now: impl Fn() -> Instant + Send + Sync + 'static, ttl: Duration, max_entries: usize) -> Arc<Self> {
        Arc::new(Self { entries: Mutex::default(), now: Arc::new(now), ttl, max_entries })
    }

    /// Drops every expired grant.
    fn prune(entries: &mut Vec<Entry>, now: Instant) {
        entries.retain(|e| e.expires_at > now);
    }

    /// Allows `action` for `session` as `agent_id` under the session's current `mark`;
    /// false for a key that is never remembered or a missing agent.
    pub fn grant(&self, session: &str, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        if agent_id.is_empty() || !action.rememberable() {
            return false;
        }
        let now = (self.now)();
        let mut entries = self.entries.lock().expect("session grants");
        Self::prune(&mut entries, now);
        entries.retain(|e| !(e.session == session && &e.action == action));
        entries.push(Entry {
            session: session.to_owned(),
            action: action.clone(),
            agent_id: agent_id.to_owned(),
            mark: mark.to_owned(),
            expires_at: now + self.ttl,
        });
        let excess = entries.len().saturating_sub(self.max_entries);
        entries.drain(..excess);
        true
    }

    /// Whether `action` is allowed for this very session, agent and life of it. A grant of the
    /// session for another agent or life is gone once it is read.
    pub fn has(&self, session: &str, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        if !action.rememberable() {
            return false;
        }
        let now = (self.now)();
        let mut entries = self.entries.lock().expect("session grants");
        Self::prune(&mut entries, now);
        let Some(at) = entries.iter().position(|e| e.session == session && &e.action == action) else {
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

/// One session's view of the process registry.
pub struct SessionGrants {
    registry: Arc<SessionGrantRegistry>,
    session: String,
}

impl Default for SessionGrants {
    /// A session of its own registry (a test, or a caller with no process registry).
    fn default() -> Self {
        Self::of(SessionGrantRegistry::new(), "")
    }
}

impl SessionGrants {
    /// Session `session`'s grants in `registry`.
    pub fn of(registry: Arc<SessionGrantRegistry>, session: impl Into<String>) -> Self {
        Self { registry, session: session.into() }
    }

    /// Allows `action` as `agent_id` under the session's current `mark`;
    /// false for a key that is never remembered or a missing agent.
    pub fn grant(&self, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        self.registry.grant(&self.session, agent_id, action, mark)
    }

    /// Whether `action` is allowed for this session, agent and life of it.
    pub fn has(&self, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        self.registry.has(&self.session, agent_id, action, mark)
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
        let registry = SessionGrantRegistry::with_settings(
            move || base + Duration::from_secs(seen.load(Ordering::SeqCst)),
            SESSION_GRANT_TTL,
            MAX_SESSION_GRANTS,
        );
        (SessionGrants::of(registry, "s"), ticks)
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
    fn the_bound_is_one_for_every_session_and_the_oldest_grant_of_any_session_goes() {
        let registry = SessionGrantRegistry::with_settings(Instant::now, SESSION_GRANT_TTL, 2);
        let of = |session: &str| SessionGrants::of(registry.clone(), session);
        for session in ["s1", "s2", "s3"] {
            assert!(of(session).grant("bot", &comment(), "m"));
        }
        assert!(!of("s1").has("bot", &comment(), "m"));
        assert!(of("s2").has("bot", &comment(), "m"));
        assert!(of("s3").has("bot", &comment(), "m"));
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
