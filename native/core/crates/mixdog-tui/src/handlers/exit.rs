//! The clean two-phase exit (`app/use-prompt-queue-history.mjs` `requestExit`). The first request freezes the input (`exiting`
//! removes the caret and disables the prompt) so the teardown frame is clean; a moment later, once the final frame has been
//! flushed, the store is disposed raced against a timeout; then the app exits. A hard-exit timer armed by the first request
//! ends the process regardless, so it never hangs on a slow dispose.
//!
//! Time is an input: the owner calls [`ExitFlow::step`] with the millisecond and does what it answers, running a timer for
//! [`ExitFlow::next_wake`]. The dispose wait of the whole run (`MIXDOG_TUI_EXIT_WAIT_MS`, 2500 ms) is the run loop's; the race
//! here is the shorter one of the exit flow.

/// The wait before the store is disposed: just past the render throttle window, so the final frame flushes first.
pub const EXIT_FLUSH_DELAY_MS: u64 = 60;
/// How long the dispose may take before the exit goes on without it.
pub const EXIT_DISPOSE_RACE_MS: u64 = 350;
/// The hard-exit timer: the process ends this long after the first request whatever else happened.
pub const EXIT_HARD_DELAY_MS: u64 = 2000;
/// Written before the hard exit: shows the cursor and resets the attributes.
pub const EXIT_RESTORE_SEQUENCE: &str = "\x1b[?25h\x1b[0m";

/// What the owner does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitStep {
    /// Nothing yet.
    Wait,
    /// Dispose the store (`store.dispose('cli-react-exit', { detach: true })`) and report with [`ExitFlow::dispose_settled`].
    Dispose,
    /// Unmount the app and exit.
    Exit,
    /// Write [`EXIT_RESTORE_SEQUENCE`] and end the process now.
    HardExit,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExitFlow {
    requested_at: Option<u64>,
    dispose_started_at: Option<u64>,
    disposed: bool,
    exited: bool,
}

impl ExitFlow {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether an exit was requested (`exitRequestedRef`, and with it `exiting`).
    pub fn requested(&self) -> bool {
        self.requested_at.is_some()
    }

    /// `requestExit()`: false when an exit is already under way.
    pub fn request(&mut self, now: u64) -> bool {
        if self.requested() {
            return false;
        }
        self.requested_at = Some(now);
        true
    }

    /// The dispose settled, resolved or rejected.
    pub fn dispose_settled(&mut self) {
        self.disposed = true;
    }

    /// The next step at `now`. The hard exit outranks everything; each step is answered once.
    pub fn step(&mut self, now: u64) -> ExitStep {
        let Some(requested_at) = self.requested_at else { return ExitStep::Wait };
        if self.exited {
            return ExitStep::Wait;
        }
        if now >= requested_at + EXIT_HARD_DELAY_MS {
            self.exited = true;
            return ExitStep::HardExit;
        }
        match self.dispose_started_at {
            None if now >= requested_at + EXIT_FLUSH_DELAY_MS => {
                self.dispose_started_at = Some(now);
                ExitStep::Dispose
            }
            Some(started) if self.disposed || now >= started + EXIT_DISPOSE_RACE_MS => {
                self.exited = true;
                ExitStep::Exit
            }
            _ => ExitStep::Wait,
        }
    }

    /// When the owner's timer should wake it next, if anything is pending; a time already past (0 once the dispose settled) is
    /// due now.
    pub fn next_wake(&self) -> Option<u64> {
        let requested_at = self.requested_at?;
        if self.exited {
            return None;
        }
        let hard = requested_at + EXIT_HARD_DELAY_MS;
        let next = match self.dispose_started_at {
            None => requested_at + EXIT_FLUSH_DELAY_MS,
            Some(_) if self.disposed => return Some(0),
            Some(started) => started + EXIT_DISPOSE_RACE_MS,
        };
        Some(next.min(hard))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_flushes_the_frame_then_disposes_then_exits_once() {
        let mut flow = ExitFlow::new();
        assert_eq!(flow.step(0), ExitStep::Wait, "no request, no step");
        assert!(flow.request(1000));
        assert!(!flow.request(1010), "a second request changes nothing");
        assert_eq!(flow.next_wake(), Some(1060));
        assert_eq!(flow.step(1059), ExitStep::Wait);
        assert_eq!(flow.step(1060), ExitStep::Dispose);
        assert_eq!(flow.next_wake(), Some(1410));
        assert_eq!(flow.step(1200), ExitStep::Wait);
        flow.dispose_settled();
        assert_eq!(flow.step(1200), ExitStep::Exit);
        assert_eq!(flow.step(1300), ExitStep::Wait, "the exit is answered once");
        assert_eq!(flow.next_wake(), None);
    }

    #[test]
    fn a_dispose_that_never_settles_is_raced_by_its_timeout() {
        let mut flow = ExitFlow::new();
        flow.request(0);
        assert_eq!(flow.step(60), ExitStep::Dispose);
        assert_eq!(flow.step(409), ExitStep::Wait);
        assert_eq!(flow.step(410), ExitStep::Exit);
    }

    #[test]
    fn the_hard_exit_ends_the_process_when_the_dispose_hangs_past_it() {
        let mut flow = ExitFlow::new();
        flow.request(0);
        assert_eq!(flow.step(60), ExitStep::Dispose);
        // The owner was stalled: the race timeout and the hard exit are both past due, the hard exit wins.
        assert_eq!(flow.step(2000), ExitStep::HardExit);
        assert_eq!(flow.step(2001), ExitStep::Wait);
        assert_eq!(EXIT_RESTORE_SEQUENCE, "\x1b[?25h\x1b[0m");
    }
}
