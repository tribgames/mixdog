//! The redial schedule of the desktop leg (remote-relay-connection.ts): backoff doubling from
//! one second to thirty, immediate redials after the relay closed a stalled handshake, and a
//! reset once a leg has held.

use std::time::Duration;

pub const RETRY_MIN: Duration = Duration::from_secs(1);
pub const RETRY_MAX: Duration = Duration::from_secs(30);
/// The relay judged the leg dead while a joining phone waited on it.
pub const DESKTOP_HANDSHAKE_STALLED_CLOSE: u16 = 4010;
const STALLED_IMMEDIATE_REDIALS: u32 = 2;
/// A leg that stays up this long is a recovery.
pub const STABLE_LEG: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct Redial {
    retry: Duration,
    stalled_streak: u32,
}

impl Default for Redial {
    fn default() -> Self {
        Self { retry: RETRY_MIN, stalled_streak: 0 }
    }
}

impl Redial {
    /// An open after ordinary drops restarts the backoff; after stalled-handshake closes it does
    /// not: the leg must hold first.
    pub fn on_open(&mut self) {
        if self.stalled_streak == 0 {
            self.retry = RETRY_MIN;
        }
    }

    /// The leg held for [`STABLE_LEG`].
    pub fn on_stable(&mut self) {
        self.stalled_streak = 0;
        self.retry = RETRY_MIN;
    }

    /// System resume: redial at once, from the smallest delay.
    pub fn on_resume(&mut self) {
        self.retry = RETRY_MIN;
    }

    /// The delay before the next dial after a leg closed with `code`.
    pub fn after_close(&mut self, code: Option<u16>) -> Duration {
        let stalled = code == Some(DESKTOP_HANDSHAKE_STALLED_CLOSE);
        if stalled {
            self.stalled_streak += 1;
        }
        if stalled && self.stalled_streak <= STALLED_IMMEDIATE_REDIALS {
            return Duration::ZERO;
        }
        let delay = self.retry;
        self.retry = (self.retry * 2).min(RETRY_MAX);
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DS-REM-6: after a long backoff, a system resume redials from the first delay.
    #[test]
    fn resume_restarts_the_backoff() {
        let mut redial = Redial::default();
        let delays: Vec<_> = (0..7).map(|_| redial.after_close(None)).collect();
        assert_eq!(delays.last(), Some(&RETRY_MAX));
        redial.on_resume();
        assert_eq!(redial.after_close(None), RETRY_MIN);
        assert_eq!(redial.after_close(None), RETRY_MIN * 2);
    }
}
