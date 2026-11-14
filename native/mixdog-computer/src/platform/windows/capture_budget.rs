//! The work budget of one window capture attempt (Get-WindowCaptureRemaining,
//! window-capture.ps1:1-5) and the bounded wait on a WinRT operation
//! (Await-WinRt, session.ps1:88-119).

use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use windows::core::{Interface, RuntimeType};
use windows::Win32::Foundation::E_FAIL;
use windows_future::{IAsyncInfo, IAsyncOperation};

/// The refusal a spent budget raises.
const EXHAUSTED: &str = "capture_timeout|window capture exhausted its work budget";

/// What an operation that outlived its wait reports.
const WINRT_TIMEOUT: &str = "winrt_timeout|WinRT operation exceeded its remaining capture budget";

/// The longest a cancelled operation is given to settle.
const GRACE_MS: u32 = 100;

pub struct Budget {
    pub start: Instant,
    pub work_ms: u32,
}

impl Budget {
    pub fn new(work_ms: u32) -> Budget {
        Budget {
            start: Instant::now(),
            work_ms,
        }
    }

    /// The milliseconds of work left; refused once none are.
    pub fn remaining(&self) -> Result<u32, String> {
        self.remaining_at(Instant::now())
    }

    fn remaining_at(&self, now: Instant) -> Result<u32, String> {
        let spent = now.saturating_duration_since(self.start).as_millis();
        match u128::from(self.work_ms).checked_sub(spent) {
            Some(left) if left > 0 => Ok(left as u32),
            _ => Err(EXHAUSTED.into()),
        }
    }

    /// Waits for `operation` within what the budget has left.
    pub fn wait<T: RuntimeType + Send + 'static>(
        &self,
        operation: windows::core::Result<IAsyncOperation<T>>,
    ) -> Result<T, String> {
        let operation = operation.map_err(|error| error.message())?;
        await_bounded(&operation, self.remaining()?).map_err(String::from)
    }
}

/// Why a bounded wait gave no value.
#[derive(Debug)]
pub enum WaitError {
    /// The operation outlived its wait; `cancellation` says whether the
    /// cancel settled it (`settled`), left it running (`unconfirmed`) or
    /// could not be asked (`failed`).
    Timeout { cancellation: &'static str },
    Windows(windows::core::Error),
}

impl From<WaitError> for String {
    fn from(error: WaitError) -> String {
        match error {
            WaitError::Timeout { .. } => WINRT_TIMEOUT.into(),
            WaitError::Windows(error) => error.message(),
        }
    }
}

/// The operation's result within `ms`; past that it is cancelled and given
/// a grace of up to 100 ms to settle (Await-WinRt, session.ps1:98-118).
pub fn await_bounded<T: RuntimeType + Send + 'static>(
    operation: &IAsyncOperation<T>,
    ms: u32,
) -> Result<T, WaitError> {
    let grace = ms.min(GRACE_MS);
    let (sender, receiver) = channel();
    operation
        .when(move |result| {
            let _ = sender.send(result);
        })
        .map_err(WaitError::Windows)?;
    match receiver.recv_timeout(Duration::from_millis(u64::from(ms - grace))) {
        Ok(result) => result.map_err(WaitError::Windows),
        Err(RecvTimeoutError::Disconnected) => Err(WaitError::Windows(E_FAIL.into())),
        Err(RecvTimeoutError::Timeout) => {
            let cancelled = operation.cast::<IAsyncInfo>().and_then(|info| info.Cancel());
            // Completion can be cancelled or faulted; neither turns a timeout
            // into success.
            let settled = receiver
                .recv_timeout(Duration::from_millis(u64::from(grace)))
                .is_ok();
            Err(WaitError::Timeout {
                cancellation: match (cancelled.is_ok(), settled) {
                    (false, _) => "failed",
                    (true, true) => "settled",
                    (true, false) => "unconfirmed",
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spent_budget_refuses() {
        let fresh = Budget::new(60_000);
        assert!(fresh.remaining().is_ok_and(|left| left > 0 && left <= 60_000));
        let empty = Budget::new(0);
        assert!(empty.remaining().is_err());
    }

    #[test]
    fn the_budget_counts_down_from_its_start_by_the_clock_it_is_given() {
        let budget = Budget::new(1500);
        let at = |ms| budget.start + Duration::from_millis(ms);
        assert_eq!(budget.remaining_at(budget.start), Ok(1500));
        assert_eq!(budget.remaining_at(at(1499)), Ok(1));
        assert_eq!(budget.remaining_at(at(1500)), Err(EXHAUSTED.to_string()));
        assert_eq!(budget.remaining_at(at(9000)), Err(EXHAUSTED.to_string()));
        // A clock behind the start spends nothing.
        let early = budget.start.checked_sub(Duration::from_millis(5)).unwrap_or(budget.start);
        assert_eq!(budget.remaining_at(early), Ok(1500));
    }

    #[test]
    fn a_ready_operation_answers_within_its_wait() {
        let value = await_bounded(&IAsyncOperation::ready(Ok(7u32)), 50);
        assert!(matches!(value, Ok(7)));
        let failed = IAsyncOperation::<u32>::ready(Err(E_FAIL.into()));
        assert!(matches!(await_bounded(&failed, 50), Err(WaitError::Windows(_))));
    }

    #[test]
    fn a_late_operation_is_cancelled_and_reported_as_a_timeout() {
        let slow = IAsyncOperation::<u32>::spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            Ok(1)
        });
        let started = Instant::now();
        let outcome = await_bounded(&slow, 150);
        assert!(started.elapsed() < Duration::from_millis(390));
        // The pool closure cannot be cancelled and outlives the grace.
        assert!(matches!(
            outcome,
            Err(WaitError::Timeout {
                cancellation: "unconfirmed"
            })
        ));
        assert_eq!(String::from(outcome.unwrap_err()), WINRT_TIMEOUT);
    }

    #[test]
    fn an_operation_that_finishes_in_time_is_not_cancelled() {
        let quick = IAsyncOperation::<u32>::spawn(|| {
            std::thread::sleep(Duration::from_millis(20));
            Ok(5)
        });
        assert!(matches!(await_bounded(&quick, 2000), Ok(5)));
    }

    #[test]
    fn a_spent_budget_never_starts_a_wait() {
        let spent = Budget::new(0);
        assert_eq!(
            spent.wait(Ok(IAsyncOperation::ready(Ok(1u32)))),
            Err(EXHAUSTED.to_string())
        );
        assert_eq!(Budget::new(500).wait(Ok(IAsyncOperation::ready(Ok(1u32)))), Ok(1));
    }
}
