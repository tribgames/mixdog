//! The host's side of the watchdog protocol (MixCursorTheme, CursorTheme.cs:113-285):
//! READY, then ACTIVATE or ACTIVATE_QUIET, then ACTIVE; END, then RESTORED.
//! One activation per guard, never replayed, with 5 s bounds on every answer.

use super::{Line, UNCONFIRMED_CLEANUP};
use std::time::{Duration, Instant};

/// The longest the watchdog may take to answer one line.
const ANSWER_MS: u64 = 5000;

/// The line channel to one watchdog.
pub trait Wire {
    /// Writes one line; whether the watchdog can still be written to.
    fn send(&mut self, line: &str) -> bool;
    /// The next line within `within`; `Empty` when none came.
    fn recv(&mut self, within: Duration) -> Line;
    /// The next line already waiting, without waiting.
    fn poll(&mut self) -> Line;
}

pub struct Guard<W: Wire> {
    wire: W,
    disposed: bool,
    activation_requested: bool,
    restoration_confirmed: bool,
}

impl<W: Wire> Guard<W> {
    pub fn new(wire: W) -> Guard<W> {
        Guard { wire, disposed: false, activation_requested: false, restoration_confirmed: false }
    }

    /// The next answer within `within_ms`; None when the watchdog is gone.
    /// A line that arrives after a timeout is still there for the next read.
    fn read_next(&mut self, within_ms: u64) -> Result<Option<String>, String> {
        match self.wire.recv(Duration::from_millis(within_ms)) {
            Line::Text(text) => {
                if text == "RESTORED" {
                    self.restoration_confirmed = true;
                }
                Ok(Some(text))
            }
            Line::Empty => Err("cursor watchdog response timeout".into()),
            Line::Closed => Ok(None),
        }
    }

    /// Whether the watchdog ended the lease on its own (the person touched the
    /// input, its time ran out, or it is gone); a non-blocking check.
    pub fn expired(&mut self) -> bool {
        if self.disposed || self.restoration_confirmed {
            return true;
        }
        if !self.activation_requested {
            return false;
        }
        match self.wire.poll() {
            Line::Empty => false,
            Line::Closed => true,
            Line::Text(text) => {
                if text == "RESTORED" {
                    self.restoration_confirmed = true;
                }
                text != "ACTIVE"
            }
        }
    }

    /// A keystroke drives no pointer, so `decorate` false keeps the person's
    /// own cursor artwork while the watchdog still guards the input this
    /// session owns.
    pub fn activate(&mut self, decorate: bool, within_ms: u64) -> Result<(), String> {
        if !(1..=ANSWER_MS).contains(&within_ms) {
            return Err("milliseconds out of range".into());
        }
        if self.disposed || self.activation_requested {
            return Err("cursor activation cannot be replayed".into());
        }
        if self.read_next(within_ms)?.as_deref() != Some("READY") {
            return Err("cursor watchdog not ready".into());
        }
        self.activation_requested = true;
        self.wire.send(if decorate { "ACTIVATE" } else { "ACTIVATE_QUIET" });
        if self.read_next(within_ms)?.as_deref() != Some("ACTIVE") {
            return Err("cursor theme could not activate".into());
        }
        Ok(())
    }

    /// Ends the lease and waits for the watchdog to say it restored the
    /// cursors, tolerating one stale ACTIVE; closing the wire afterwards lets
    /// the watchdog exit.
    pub fn dispose(&mut self) -> Result<(), String> {
        if self.disposed {
            return Ok(());
        }
        self.disposed = true;
        if self.restoration_confirmed {
            return Ok(());
        }
        // The watchdog may already have restored after the person's input.
        self.wire.send("END");
        let clock = Instant::now();
        let confirmed = (|| {
            let mut result = self.read_next(ANSWER_MS)?;
            if result.as_deref() == Some("ACTIVE") {
                let left = ANSWER_MS.saturating_sub(clock.elapsed().as_millis() as u64).max(1);
                result = self.read_next(left)?;
            }
            Ok::<bool, String>(result.as_deref() == Some("RESTORED"))
        })();
        match confirmed {
            Ok(true) => Ok(()),
            _ => Err(UNCONFIRMED_CLEANUP.into()),
        }
    }
}

/// Completes a reservation: the lease the watchdog was started for, taken
/// immediately before input is dispatched (MixCursorTheme.Complete).
pub fn complete<W: Wire>(wire: W, decorate: bool) -> Result<Guard<W>, String> {
    let mut guard = Guard::new(wire);
    if guard.activate(decorate, ANSWER_MS).is_err() {
        // Closing the wire makes the independent watchdog restore, even if
        // the acknowledgement was lost.
        if guard.activation_requested {
            guard.dispose()?;
        }
        return Err(super::UNAVAILABLE.into());
    }
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A watchdog that answers from a script: each line it is sent releases
    /// the next scripted answers.
    #[derive(Default)]
    struct Fake {
        inbox: VecDeque<Line>,
        /// What the watchdog says after each line the host writes.
        answers: VecDeque<Vec<Line>>,
        sent: Vec<String>,
    }

    impl Wire for Fake {
        fn send(&mut self, line: &str) -> bool {
            self.sent.push(line.into());
            self.inbox.extend(self.answers.pop_front().unwrap_or_default());
            true
        }
        fn recv(&mut self, _: Duration) -> Line {
            self.inbox.pop_front().unwrap_or(Line::Empty)
        }
        fn poll(&mut self) -> Line {
            self.recv(Duration::ZERO)
        }
    }

    fn text(line: &str) -> Line {
        Line::Text(line.into())
    }

    fn ready() -> Fake {
        Fake { inbox: [text("READY")].into(), ..Fake::default() }
    }

    #[test]
    fn an_activation_asks_once_and_a_decorated_one_says_so() {
        let mut fake = ready();
        fake.answers = [vec![text("ACTIVE")]].into();
        let mut guard = Guard::new(fake);
        guard.activate(true, 5000).expect("active");
        assert_eq!(guard.wire.sent, ["ACTIVATE"]);
        assert_eq!(guard.activate(true, 5000), Err("cursor activation cannot be replayed".into()));
        assert_eq!(guard.wire.sent, ["ACTIVATE"]);
    }

    #[test]
    fn a_quiet_activation_asks_for_no_artwork() {
        let mut fake = ready();
        fake.answers = [vec![text("ACTIVE")]].into();
        let mut guard = Guard::new(fake);
        guard.activate(false, 5000).expect("active");
        assert_eq!(guard.wire.sent, ["ACTIVATE_QUIET"]);
    }

    #[test]
    fn the_wait_is_bounded_to_five_seconds_and_a_silent_watchdog_is_not_ready() {
        let mut guard = Guard::new(Fake::default());
        assert!(guard.activate(true, 0).is_err());
        assert!(guard.activate(true, 5001).is_err());
        assert_eq!(guard.activate(true, 5000), Err("cursor watchdog response timeout".into()));
        let mut closed = Guard::new(Fake { inbox: [Line::Closed].into(), ..Fake::default() });
        assert_eq!(closed.activate(true, 5000), Err("cursor watchdog not ready".into()));
    }

    #[test]
    fn an_end_waits_for_restored_and_tolerates_one_stale_active() {
        let mut fake = ready();
        fake.answers = [vec![text("ACTIVE")], vec![text("ACTIVE"), text("RESTORED")]].into();
        let mut guard = Guard::new(fake);
        guard.activate(true, 5000).expect("active");
        assert!(!guard.expired());
        guard.dispose().expect("restored");
        assert_eq!(guard.wire.sent, ["ACTIVATE", "END"]);
        assert!(guard.expired());
    }

    #[test]
    fn a_failed_restoration_is_never_reported_as_restored() {
        let mut fake = ready();
        fake.answers = [vec![text("ACTIVE")], vec![text("RESTORE_FAILED")]].into();
        let mut guard = Guard::new(fake);
        guard.activate(true, 5000).expect("active");
        assert_eq!(guard.dispose(), Err(UNCONFIRMED_CLEANUP.into()));
    }

    #[test]
    fn a_lease_the_watchdog_ended_is_expired_and_needs_no_end() {
        let mut fake = ready();
        fake.answers = [vec![text("ACTIVE"), text("RESTORED")]].into();
        let mut guard = Guard::new(fake);
        guard.activate(true, 5000).expect("active");
        assert!(guard.expired());
        guard.dispose().expect("nothing left to confirm");
        assert_eq!(guard.wire.sent, ["ACTIVATE"], "no END is sent to a watchdog that restored");
    }

    #[test]
    fn a_watchdog_that_vanished_has_an_expired_lease() {
        let mut fake = ready();
        fake.answers = [vec![text("ACTIVE"), Line::Closed]].into();
        let mut guard = Guard::new(fake);
        guard.activate(true, 5000).expect("active");
        assert!(guard.expired());
    }

    #[test]
    fn an_activation_that_never_acknowledges_ends_the_lease_before_failing() {
        let mut fake = ready();
        // The watchdog restores in answer to END.
        fake.answers = [vec![], vec![text("RESTORED")]].into();
        let failed = complete(fake, true).err();
        assert_eq!(failed.as_deref(), Some(super::super::UNAVAILABLE));
    }

    #[test]
    fn an_activation_refused_before_the_request_just_closes() {
        let failed = complete(Fake::default(), true).err();
        assert_eq!(failed.as_deref(), Some(super::super::UNAVAILABLE));
    }
}
