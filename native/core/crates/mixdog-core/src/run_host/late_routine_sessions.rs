//! The session half of the routine host (`RoutineSessions`) before the session directory exists.
//!
//! `CoreRoutineSessions::new(directory, ..)` needs the built directory, while the routine host
//! feeds `RoutineRuntime`, which the schedule runner (`HomeScheduleRunner`), the webhook dispatch
//! and the `ChannelAdmin` hold, all of which the agent definitions' effects and the tool pool need:
//! a true cycle through the directory. The cell is bound once, right after `TurnPath::new`, and
//! the composition verifies it before the listener accepts. A routine fires from a timer or a
//! delivery that only starts with the automation runtime, after the bind; unbound, every call
//! refuses with `the session layer is not up yet`, as `LateAgentEvidence` does.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_services::bots::{AnnouncedRun, DeliveryItem, ExecutorRun, RoutineTurn, TurnSettle};
use tokio_util::sync::CancellationToken;

use super::late::Bound;
use super::routine_host::RoutineSessions;

const NOT_UP: &str = "the session layer is not up yet";

#[derive(Default)]
pub struct LateRoutineSessions(OnceLock<Arc<dyn RoutineSessions>>);

impl LateRoutineSessions {
    /// Binds the sessions; a second bind is refused.
    pub fn bind(&self, sessions: Arc<dyn RoutineSessions>) -> Result<(), Arc<dyn RoutineSessions>> {
        self.0.set(sessions)
    }
}

#[async_trait]
impl RoutineSessions for LateRoutineSessions {
    async fn home_thread_open(&self, session_id: &str) -> Result<bool, String> {
        match self.0.get() {
            Some(sessions) => sessions.home_thread_open(session_id).await,
            None => Err(NOT_UP.to_owned()),
        }
    }

    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle {
        match self.0.get() {
            Some(sessions) => sessions.run_turn(turn, cancel).await,
            None => TurnSettle::Failed(NOT_UP.to_owned()),
        }
    }

    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String> {
        match self.0.get() {
            Some(sessions) => sessions.run_executor(run, cancel).await,
            None => Err(NOT_UP.to_owned()),
        }
    }

    async fn deliver_result(&self, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<(), String> {
        match self.0.get() {
            Some(sessions) => sessions.deliver_result(owner_agent_id, name, item).await,
            None => Err(NOT_UP.to_owned()),
        }
    }

    async fn announce_run(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> Result<(), String> {
        match self.0.get() {
            Some(sessions) => sessions.announce_run(owner_agent_id, name, run).await,
            None => Err(NOT_UP.to_owned()),
        }
    }
}

impl Bound for LateRoutineSessions {
    fn cell(&self) -> &'static str {
        "routine sessions"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Open;

    #[async_trait]
    impl RoutineSessions for Open {
        async fn home_thread_open(&self, _: &str) -> Result<bool, String> {
            Ok(true)
        }
        async fn run_turn(&self, _: RoutineTurn, _: CancellationToken) -> TurnSettle {
            TurnSettle::Cancelled
        }
        async fn run_executor(&self, _: ExecutorRun, _: CancellationToken) -> Result<String, String> {
            Ok("done".to_owned())
        }
        async fn deliver_result(&self, _: &str, _: &str, _: &DeliveryItem) -> Result<(), String> {
            Ok(())
        }
        async fn announce_run(&self, _: &str, _: &str, _: &AnnouncedRun) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn the_sessions_refuse_until_bound_then_answer() {
        let late = LateRoutineSessions::default();
        assert!(!late.is_bound());
        assert_eq!(late.home_thread_open("sess_home_a").await, Err(NOT_UP.to_owned()));
        assert!(late.bind(Arc::new(Open)).is_ok());
        assert!(late.is_bound());
        assert_eq!(late.home_thread_open("sess_home_a").await, Ok(true));
        assert!(late.bind(Arc::new(Open)).is_err(), "a second bind is refused");
    }
}
