//! "Allow for this session": a tool a person allowed from a card for the rest of
//! ONE conversation. Held in memory in one registry for the whole process, keyed
//! by session and tool identity — never by target or payload. A grant lasts as long as
//! its conversation: no time limit and no count limit. It ends when the session
//! is closed or deleted ([`SessionGrantRegistry::forget`]), and when the session's
//! agent changes or it is reset (the owner passes the agent and a `mark` naming
//! the session's current life; a grant made for another agent or mark is dropped
//! the next time that session is read or granted). A grant is memory only, so a
//! restart of the service ends it and the person is asked again. A key that can never
//! be remembered is never granted.

use std::sync::Arc;
use std::sync::Mutex;

use super::action::GrantKey;

struct Entry {
    session: String,
    action: GrantKey,
    agent_id: String,
    mark: String,
}

/// The process's "Allow for this session" grants.
#[derive(Default)]
pub struct SessionGrantRegistry {
    entries: Mutex<Vec<Entry>>,
}

impl SessionGrantRegistry {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Drops the grants of `session` made for another agent or life than these.
    fn drop_stale(entries: &mut Vec<Entry>, session: &str, agent_id: &str, mark: &str) {
        entries.retain(|e| e.session != session || (e.agent_id == agent_id && e.mark == mark));
    }

    /// Allows `action` for `session` as `agent_id` under the session's current `mark`;
    /// false for a key that is never remembered or a missing agent.
    pub fn grant(&self, session: &str, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        if agent_id.is_empty() || !action.rememberable() {
            return false;
        }
        let mut entries = self.entries.lock().expect("session grants");
        Self::drop_stale(&mut entries, session, agent_id, mark);
        if !entries.iter().any(|e| e.session == session && &e.action == action) {
            entries.push(Entry {
                session: session.to_owned(),
                action: action.clone(),
                agent_id: agent_id.to_owned(),
                mark: mark.to_owned(),
            });
        }
        true
    }

    /// Whether `action` is allowed for this very session, agent and life of it. A grant of the
    /// session for another agent or life is gone once it is read.
    pub fn has(&self, session: &str, agent_id: &str, action: &GrantKey, mark: &str) -> bool {
        if !action.rememberable() {
            return false;
        }
        let mut entries = self.entries.lock().expect("session grants");
        Self::drop_stale(&mut entries, session, agent_id, mark);
        entries.iter().any(|e| e.session == session && &e.action == action)
    }

    /// Ends every grant of `session`: it was closed or deleted.
    pub fn forget(&self, session: &str) {
        self.entries.lock().expect("session grants").retain(|e| e.session != session);
    }

    /// How many grants the registry holds for `session`.
    pub fn held(&self, session: &str) -> usize {
        self.entries.lock().expect("session grants").iter().filter(|e| e.session == session).count()
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
    use mixdog_core_api::domain::approval::ActionKind;

    use super::*;

    fn tool(name: &str) -> GrantKey {
        GrantKey::Tool(name.into())
    }

    #[test]
    fn a_grant_covers_its_agent_and_mark_only_and_a_change_drops_it() {
        let grants = SessionGrants::of(SessionGrantRegistry::new(), "s");
        assert!(grants.grant("bot", &tool("a"), "life-1"));
        assert!(grants.has("bot", &tool("a"), "life-1"));
        assert!(!grants.has("other", &tool("a"), "life-1"));
        // The agent changed: the grant is gone and does not come back.
        assert!(!grants.has("bot", &tool("a"), "life-1"));
        assert!(grants.grant("bot", &tool("a"), "life-1"));
        assert!(!grants.has("bot", &tool("a"), "life-2"));
    }

    #[test]
    fn a_reset_drops_every_grant_of_the_session_not_only_the_one_read() {
        let registry = SessionGrantRegistry::new();
        let grants = SessionGrants::of(registry.clone(), "s");
        assert!(grants.grant("bot", &tool("a"), "life-1"));
        assert!(grants.grant("bot", &tool("b"), "life-1"));
        assert!(!grants.has("bot", &tool("a"), "life-2"));
        assert_eq!(registry.held("s"), 0);
    }

    #[test]
    fn payments_and_deletes_are_never_granted() {
        let grants = SessionGrants::of(SessionGrantRegistry::new(), "s");
        for k in [ActionKind::Payment, ActionKind::Delete] {
            assert!(!grants.grant("bot", &GrantKey::Kind(k), "m"));
            assert!(!grants.has("bot", &GrantKey::Kind(k), "m"));
        }
        assert!(!grants.grant("", &tool("a"), "m"));
    }

    #[test]
    fn grants_have_no_count_limit_and_no_time_limit_and_forgetting_a_session_ends_only_its_own() {
        let registry = SessionGrantRegistry::new();
        let of = |session: &str| SessionGrants::of(registry.clone(), session);
        for i in 0..1000 {
            assert!(of("s1").grant("bot", &tool(&format!("t{i}")), "m"));
        }
        assert!(of("s2").grant("bot", &tool("t0"), "m"));
        for i in 0..1000 {
            assert!(of("s1").has("bot", &tool(&format!("t{i}")), "m"), "t{i}");
        }
        registry.forget("s1");
        assert_eq!(registry.held("s1"), 0);
        assert!(!of("s1").has("bot", &tool("t0"), "m"));
        assert!(of("s2").has("bot", &tool("t0"), "m"));
    }
}