//! The session seams the composition hands out before the session directory exists, each a cell
//! bound once right after `TurnPath::new`, as in `late_session.rs`. What holds them is part of what
//! the directory is built from, so none of them can be built after it:
//!
//! - [`LateThreadGates`]: the thread op scope of `OpScopeSource` (stage one of the domains) and of
//!   `CoreOpIndex`. Both take the same cell, bound to the directory's one
//!   `SessionDirectory::thread_ops()`: its gates are what order one thread's ops.
//! - [`LateAgentEvidence`]: `AgentSeams.evidence` (the agent definitions the pool is built from),
//!   bound to `SessionAgentEvidence::new(directory, routines)`.
//! - [`LateSessionFacts`]: `SetupSeams.facts` (the setup tool's callers), bound to
//!   `SessionSetupFacts::new(directory, switches, data_dir)`.
//!
//! Nothing reads them before the bind: an op, an agent read and a setup call all come from a client
//! or a turn, and the composition verifies every cell before the listener accepts. Unbound, they
//! answer as for a thread that does not exist.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::ops::{OpGate, ThreadOpGates};
use mixdog_core_config::config::DEFAULT_MIXY_NAME;

use crate::compose_mcp::SessionFacts;

/// The thread scope's op gates, bound to the directory's `ThreadOps`.
#[derive(Default)]
pub struct LateThreadGates(OnceLock<Arc<dyn ThreadOpGates>>);

impl LateThreadGates {
    /// Binds the gates; a second bind is refused.
    pub fn bind(&self, gates: Arc<dyn ThreadOpGates>) -> Result<(), Arc<dyn ThreadOpGates>> {
        self.0.set(gates)
    }
}

#[async_trait]
impl ThreadOpGates for LateThreadGates {
    async fn gate(&self, thread: &ThreadId, ctx: &CallContext) -> Result<OpGate, CoreError> {
        match self.0.get() {
            Some(gates) => gates.gate(thread, ctx).await,
            None => Err(CoreError::ThreadNotFound { thread_id: thread.clone() }),
        }
    }
}

/// `AgentSeams.evidence`, bound to `SessionAgentEvidence`.
#[derive(Default)]
pub struct LateAgentEvidence(OnceLock<Arc<dyn AgentEvidence>>);

impl LateAgentEvidence {
    /// Binds the evidence; a second bind is refused.
    pub fn bind(&self, evidence: Arc<dyn AgentEvidence>) -> Result<(), Arc<dyn AgentEvidence>> {
        self.0.set(evidence)
    }
}

#[async_trait]
impl AgentEvidence for LateAgentEvidence {
    /// Unbound, no home thread can be read, and Node's evidence of an unreadable thread is none.
    async fn home_greeted(&self, agent_id: &str) -> bool {
        match self.0.get() {
            Some(evidence) => evidence.home_greeted(agent_id).await,
            None => false,
        }
    }

    async fn home_chatted(&self, agent_id: &str) -> bool {
        match self.0.get() {
            Some(evidence) => evidence.home_chatted(agent_id).await,
            None => false,
        }
    }

    /// Unbound, the routines cannot be read, which is this method's error.
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        match self.0.get() {
            Some(evidence) => evidence.mixy_owns_routines().await,
            None => Err("the session layer is not up yet".to_owned()),
        }
    }
}

/// `SetupSeams.facts`, bound to `SessionSetupFacts`.
#[derive(Default)]
pub struct LateSessionFacts(OnceLock<Arc<dyn SessionFacts>>);

impl LateSessionFacts {
    /// Binds the facts; a second bind is refused.
    pub fn bind(&self, facts: Arc<dyn SessionFacts>) -> Result<(), Arc<dyn SessionFacts>> {
        self.0.set(facts)
    }
}

#[async_trait]
impl SessionFacts for LateSessionFacts {
    /// Unbound, there is no session record, which `SessionSetupFacts` answers as coding mode.
    async fn agent_mode(&self, thread: &ThreadId) -> bool {
        match self.0.get() {
            Some(facts) => facts.agent_mode(thread).await,
            None => false,
        }
    }

    /// Unbound, the identity cannot be read: the unrenamed default, as an unreadable manifest is.
    async fn mixy_name(&self) -> String {
        match self.0.get() {
            Some(facts) => facts.mixy_name().await,
            None => DEFAULT_MIXY_NAME.to_owned(),
        }
    }

    async fn settings_reach_session(&self, thread: &ThreadId) -> bool {
        match self.0.get() {
            Some(facts) => facts.settings_reach_session(thread).await,
            None => false,
        }
    }
}

macro_rules! late_bound {
    ($cell:ty, $name:literal) => {
        impl Bound for $cell {
            fn cell(&self) -> &'static str {
                $name
            }

            fn is_bound(&self) -> bool {
                self.0.get().is_some()
            }
        }
    };
}

late_bound!(LateThreadGates, "thread op gates");
late_bound!(LateAgentEvidence, "agent evidence");
late_bound!(LateSessionFacts, "session facts");

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Counts the calls that reach it; every answer is the opposite of the unbound one.
    #[derive(Default)]
    struct Counting(AtomicUsize);

    impl Counting {
        fn hit(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }

        fn hits(&self) -> usize {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ThreadOpGates for Counting {
        async fn gate(&self, _: &ThreadId, _: &CallContext) -> Result<OpGate, CoreError> {
            self.hit();
            Err(CoreError::ThreadNotFound { thread_id: ThreadId::from("counted") })
        }
    }

    #[async_trait]
    impl AgentEvidence for Counting {
        async fn home_greeted(&self, _: &str) -> bool {
            self.hit();
            true
        }

        async fn home_chatted(&self, _: &str) -> bool {
            self.hit();
            true
        }

        async fn mixy_owns_routines(&self) -> Result<bool, String> {
            self.hit();
            Ok(true)
        }
    }

    #[async_trait]
    impl SessionFacts for Counting {
        async fn agent_mode(&self, _: &ThreadId) -> bool {
            self.hit();
            true
        }

        async fn mixy_name(&self) -> String {
            self.hit();
            "Renamed".to_owned()
        }

        async fn settings_reach_session(&self, _: &ThreadId) -> bool {
            self.hit();
            true
        }
    }

    fn thread_of(answer: Result<OpGate, CoreError>) -> ThreadId {
        match answer {
            Err(CoreError::ThreadNotFound { thread_id }) => thread_id,
            Err(other) => panic!("unexpected error {other:?}"),
            Ok(_) => panic!("unexpected gate"),
        }
    }

    #[tokio::test]
    async fn the_thread_gates_answer_an_unknown_thread_until_bound_then_delegate() {
        let late = LateThreadGates::default();
        let thread = ThreadId::from("t");
        let ctx = CallContext::internal("test");
        assert!(!late.is_bound());
        assert_eq!(thread_of(late.gate(&thread, &ctx).await), thread);
        let counting = Arc::new(Counting::default());
        assert!(late.bind(counting.clone()).is_ok());
        assert!(late.is_bound());
        assert_eq!(thread_of(late.gate(&thread, &ctx).await), ThreadId::from("counted"));
        assert_eq!(counting.hits(), 1);
        assert!(late.bind(counting).is_err(), "a second bind is refused");
    }

    #[tokio::test]
    async fn the_agent_evidence_holds_nothing_until_bound_then_delegates() {
        let late = LateAgentEvidence::default();
        assert!(!late.is_bound());
        assert!(!late.home_greeted("a").await);
        assert!(!late.home_chatted("a").await);
        assert!(late.mixy_owns_routines().await.is_err());
        let counting = Arc::new(Counting::default());
        assert!(late.bind(counting.clone()).is_ok());
        assert!(late.home_greeted("a").await);
        assert!(late.home_chatted("a").await);
        assert_eq!(late.mixy_owns_routines().await, Ok(true));
        assert_eq!(counting.hits(), 3);
        assert!(late.bind(counting).is_err(), "a second bind is refused");
    }

    #[tokio::test]
    async fn the_session_facts_answer_no_session_until_bound_then_delegate() {
        let late = LateSessionFacts::default();
        let thread = ThreadId::from("t");
        assert!(!late.is_bound());
        assert!(!late.agent_mode(&thread).await);
        assert_eq!(late.mixy_name().await, DEFAULT_MIXY_NAME);
        assert!(!late.settings_reach_session(&thread).await);
        let counting = Arc::new(Counting::default());
        assert!(late.bind(counting.clone()).is_ok());
        assert!(late.agent_mode(&thread).await);
        assert_eq!(late.mixy_name().await, "Renamed");
        assert!(late.settings_reach_session(&thread).await);
        assert_eq!(counting.hits(), 3);
        assert!(late.bind(counting).is_err(), "a second bind is refused");
    }
}
