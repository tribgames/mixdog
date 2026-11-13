//! Idle release (Node `agent-tool/close-flow/idle-release.mjs`): an agent idle with its result delivered is parked (its
//! runtime released, the agent kept open and listed) after [`IDLE_RELEASE_MS`] without a send. One deadline per idle
//! agent, armed when its row is seen idle and cleared when it stops being idle: nothing is due while no agent is idle. A
//! release that did not happen (a busy session, a result not delivered yet) is tried again one period later.
//!
//! This is the bookkeeping only: Node keeps a timer per session, the host here keeps one wait for the earliest deadline
//! ([`IdleRelease::next_due`]) and asks again whenever the worker rows may have changed.

use std::collections::HashMap;
use std::collections::HashSet;

use super::dispatch::IdleOutcome;

/// `IDLE_RELEASE_MS`.
pub const IDLE_RELEASE_MS: f64 = 420_000.0;

#[derive(Default)]
pub struct IdleRelease {
    /// `timers`: session id -> when its release is due (epoch ms).
    due: HashMap<String, f64>,
    /// The idle agents whose runtime is already released.
    parked: HashSet<String>,
}

impl IdleRelease {
    /// `check()`, called when the worker rows may have changed. `idle`: every open idle row's session with its
    /// `workerRowTime`. The deadline of a session no longer idle is cleared, and an idle one without a deadline gets one a
    /// period after its row's time (at once when that has passed: a restart finds every old idle agent due). Answers the
    /// parked agents that stopped being idle (a send resumed them): they can be parked again later.
    pub fn check(&mut self, idle: &HashMap<String, f64>, now: f64) -> Vec<String> {
        self.due.retain(|session, _| idle.contains_key(session));
        let mut resumed: Vec<String> = self.parked.iter().filter(|session| !idle.contains_key(*session)).cloned().collect();
        resumed.sort_unstable();
        for session in &resumed {
            self.parked.remove(session);
        }
        for (session, row_time) in idle {
            if self.due.contains_key(session) || self.parked.contains(session) {
                continue;
            }
            self.due.insert(session.clone(), now + (IDLE_RELEASE_MS - (now - row_time)).max(0.0));
        }
        resumed
    }

    /// The deadline that came first, taken (the fired timer leaves `timers`); `None` while none has come. One at a time:
    /// the host releases it and yields before it takes the next.
    pub fn take_due(&mut self, now: f64) -> Option<String> {
        let (session, _) = self
            .due
            .iter()
            .filter(|(_, at)| **at <= now)
            .min_by(|a, b| a.1.total_cmp(b.1).then_with(|| a.0.cmp(b.0)))?;
        let session = session.clone();
        self.due.remove(&session);
        Some(session)
    }

    /// When the earliest deadline comes.
    pub fn next_due(&self) -> Option<f64> {
        self.due.values().copied().min_by(f64::total_cmp)
    }

    /// The end of `releaseDue`: a parked agent is remembered; one whose session was deleted is done with; any other
    /// (busy, undelivered, failed) is tried again one period later while its row is still idle and nothing armed it
    /// meanwhile.
    pub fn settled(&mut self, session: &str, outcome: &IdleOutcome, still_idle: bool, now: f64) {
        match outcome {
            IdleOutcome::Parked => {
                self.parked.insert(session.to_owned());
            }
            IdleOutcome::Gone => {}
            _ if still_idle && !self.due.contains_key(session) => {
                self.due.insert(session.to_owned(), now + IDLE_RELEASE_MS);
            }
            _ => {}
        }
    }

    /// Whether the agent was parked and has not been seen busy since.
    pub fn is_parked(&self, session: &str) -> bool {
        self.parked.contains(session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle(rows: &[(&str, f64)]) -> HashMap<String, f64> {
        rows.iter().map(|(session, at)| ((*session).to_owned(), *at)).collect()
    }

    /// `check()` arms `IDLE_RELEASE_MS - (now - workerRowTime(row))`, never less than nothing, once per idle row.
    #[test]
    fn an_idle_row_is_due_a_period_after_its_time() {
        let mut release = IdleRelease::default();
        let now = 1_000_000.0;
        assert!(release.check(&idle(&[("fresh", now - 20_000.0), ("old", now - 900_000.0), ("untimed", 0.0)]), now).is_empty());
        assert_eq!(release.next_due(), Some(now));
        // The earliest first, then by id: one at a time.
        assert_eq!(release.take_due(now).as_deref(), Some("old"));
        assert_eq!(release.take_due(now).as_deref(), Some("untimed"));
        assert_eq!(release.take_due(now), None);
        assert_eq!(release.next_due(), Some(now + 400_000.0));
        // A later check leaves an armed deadline where it is.
        release.check(&idle(&[("fresh", now - 20_000.0)]), now + 100_000.0);
        assert_eq!(release.next_due(), Some(now + 400_000.0));
        assert_eq!(release.take_due(now + 399_999.0), None);
        assert_eq!(release.take_due(now + 400_000.0).as_deref(), Some("fresh"));
    }

    /// A row that stops being idle loses its deadline; idle again, it gets a new one from its new time.
    #[test]
    fn a_row_that_stops_being_idle_is_not_due() {
        let mut release = IdleRelease::default();
        release.check(&idle(&[("a", 0.0)]), 1_000.0);
        release.check(&idle(&[]), 2_000.0);
        assert_eq!((release.next_due(), release.take_due(f64::MAX)), (None, None));
        release.check(&idle(&[("a", 500_000.0)]), 500_000.0);
        assert_eq!(release.next_due(), Some(920_000.0));
    }

    /// `releaseDue`: parked is remembered and not armed again until the agent was busy; gone is done; anything else is
    /// tried again one period later, but only while the row is still idle.
    #[test]
    fn a_release_that_did_not_happen_is_tried_again_a_period_later() {
        let mut release = IdleRelease::default();
        let rows = idle(&[("busy", 0.0), ("parked", 0.0), ("gone", 0.0), ("left", 0.0)]);
        release.check(&rows, 420_000.0);
        while release.take_due(420_000.0).is_some() {}
        release.settled("busy", &IdleOutcome::Busy, true, 420_000.0);
        release.settled("parked", &IdleOutcome::Parked, true, 420_000.0);
        release.settled("gone", &IdleOutcome::Gone, true, 420_000.0);
        release.settled("left", &IdleOutcome::Failed { reason: None }, false, 420_000.0);
        assert_eq!(release.next_due(), Some(840_000.0));
        assert_eq!(release.take_due(840_000.0).as_deref(), Some("busy"));
        release.settled("busy", &IdleOutcome::Undelivered, true, 840_000.0);
        assert_eq!(release.next_due(), Some(1_260_000.0));
        // The parked agent is not armed again while it stays idle.
        assert!(release.is_parked("parked"));
        release.check(&idle(&[("busy", 0.0), ("parked", 0.0)]), 900_000.0);
        assert_eq!(release.next_due(), Some(1_260_000.0));
        // A send resumed it: it can be parked again later.
        assert_eq!(release.check(&idle(&[("busy", 0.0)]), 1_000_000.0), vec!["parked".to_owned()]);
        assert!(!release.is_parked("parked"));
        release.check(&idle(&[("busy", 0.0), ("parked", 1_050_000.0)]), 1_100_000.0);
        assert_eq!(release.take_due(1_470_000.0).as_deref(), Some("busy"));
        assert_eq!(release.take_due(1_470_000.0).as_deref(), Some("parked"));
    }
}
