//! Accessibility reads with a deadline, abandoned on their own thread when a
//! provider never answers (BoundedUia.cs:35-199 MixBoundedUia.Run). A UIA or
//! MSAA call cannot be cancelled, and the thread that would wait it out also
//! hosts the input observer's hooks, which a restart would drop.

use std::sync::mpsc;
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// The one budget every provider read of a snapshot shares, counted from the
/// moment the snapshot began (MixUiaDeadline).
#[derive(Clone, Copy)]
pub struct Deadline {
    pub start: Instant,
    pub budget_ms: u64,
}

impl Deadline {
    fn remaining(&self) -> Duration {
        Duration::from_millis(self.budget_ms).saturating_sub(self.start.elapsed())
    }

    fn exceeded(&self, stage: &str) -> String {
        format!(
            "computer_command_timeout: accessibility read exceeded {}ms during {stage}; the read was abandoned and the input host kept running",
            self.budget_ms
        )
    }
}

/// A COM proxy that crosses to the read's thread and back. UIA and MSAA
/// objects are free-threaded and come from the MTA, which the windows crate
/// cannot know. Take the value with `get`: a closure that named the field
/// would capture it alone, without this wrapper's `Send`.
pub struct Mta<T>(T);

mod sealed {
    pub trait Sealed {}
}

/// A value made only of free-threaded COM proxies; sealed, so a type joins by
/// an impl in this file.
pub trait MtaSafe: sealed::Sealed {}

macro_rules! mta_safe {
    ($($t:ty),* $(,)?) => {$(
        impl sealed::Sealed for $t {}
        impl MtaSafe for $t {}
    )*};
}

mta_safe!(
    windows::Win32::UI::Accessibility::IUIAutomation,
    windows::Win32::UI::Accessibility::IUIAutomationCondition,
    windows::Win32::UI::Accessibility::IUIAutomationCacheRequest,
    windows::Win32::UI::Accessibility::IUIAutomationElement,
    windows::Win32::UI::Accessibility::IUIAutomationElementArray,
    super::msaa::MsaaNode,
);

impl<T: MtaSafe> sealed::Sealed for Option<T> {}
impl<T: MtaSafe> MtaSafe for Option<T> {}
impl<T: MtaSafe> sealed::Sealed for Vec<T> {}
impl<T: MtaSafe> MtaSafe for Vec<T> {}
impl<A: MtaSafe, B: MtaSafe> sealed::Sealed for (A, B) {}
impl<A: MtaSafe, B: MtaSafe> MtaSafe for (A, B) {}
impl<A: MtaSafe, B: MtaSafe, C: MtaSafe> sealed::Sealed for (A, B, C) {}
impl<A: MtaSafe, B: MtaSafe, C: MtaSafe> MtaSafe for (A, B, C) {}

// SAFETY: the wrapped proxies are used by one thread at a time, and the
// providers behind them serve any MTA thread.
unsafe impl<T: MtaSafe> Send for Mta<T> {}

impl<T> Mta<T> {
    pub fn new(value: T) -> Mta<T> {
        Mta(value)
    }

    pub fn get(self) -> T {
        self.0
    }
}

/// The reads' bookkeeping: at most one abandoned call at a time, which ends
/// when its provider answers.
struct Bounded {
    abandoned: Mutex<Option<JoinHandle<()>>>,
}

static BOUNDED: Bounded = Bounded { abandoned: Mutex::new(None) };

/// Runs `work` within the deadline; `stage` names it in a timeout. No deadline
/// runs it inline, as reads without one always did.
pub fn run<T: Send + 'static>(
    deadline: Option<&Deadline>,
    stage: &str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    BOUNDED.run(deadline, stage, work)
}

impl Bounded {
    fn run<T: Send + 'static>(
        &self,
        deadline: Option<&Deadline>,
        stage: &str,
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let Some(deadline) = deadline else {
            return work();
        };
        {
            let mut abandoned = self.abandoned.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if abandoned.as_ref().is_some_and(|thread| !thread.is_finished()) {
                return Err("computer_command_timeout: an earlier abandoned accessibility read is still running; this read was not started and the input host kept running".into());
            }
            *abandoned = None;
        }
        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return Err(deadline.exceeded(stage));
        }
        let (sender, receiver) = mpsc::channel();
        let spawned = std::thread::Builder::new().name("mixdog bounded accessibility read".into()).spawn(move || {
            // SAFETY: this thread's own COM apartment; no uninitialise, as
            // the read's objects outlive the thread.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let _ = sender.send(work());
        });
        let thread = spawned.map_err(|error| format!("accessibility read thread did not start: {error}"))?;
        match receiver.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                *self.abandoned.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(thread);
                Err(deadline.exceeded(stage))
            }
            // The work panicked before it answered.
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("accessibility read failed during {stage}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounded() -> Bounded {
        Bounded { abandoned: Mutex::new(None) }
    }

    fn deadline(budget_ms: u64) -> Deadline {
        Deadline { start: Instant::now(), budget_ms }
    }

    #[test]
    fn work_in_time_answers() {
        assert_eq!(bounded().run(Some(&deadline(5000)), "the stage", || Ok(7)), Ok(7));
        let failed: Result<u8, String> = bounded().run(Some(&deadline(5000)), "the stage", || Err("no".into()));
        assert_eq!(failed, Err("no".into()));
    }

    #[test]
    fn no_deadline_runs_inline() {
        let here = std::thread::current().id();
        let ran = bounded().run(None, "the stage", move || Ok(std::thread::current().id() == here));
        assert_eq!(ran, Ok(true));
    }

    #[test]
    fn work_past_the_budget_is_abandoned_and_blocks_the_next_read() {
        let state = bounded();
        let (release, held) = mpsc::channel::<()>();
        let timed_out = state.run(Some(&deadline(50)), "the element search", move || {
            let _ = held.recv();
            Ok(1)
        });
        assert_eq!(
            timed_out,
            Err("computer_command_timeout: accessibility read exceeded 50ms during the element search; the read was abandoned and the input host kept running".into())
        );
        let refused = state.run(Some(&deadline(5000)), "the visible text read", || Ok(2));
        assert_eq!(
            refused,
            Err("computer_command_timeout: an earlier abandoned accessibility read is still running; this read was not started and the input host kept running".into())
        );
        // The provider answers; the abandoned thread ends and reads go on.
        drop(release);
        let handle = state.abandoned.lock().unwrap().take().unwrap();
        handle.join().unwrap();
        assert_eq!(state.run(Some(&deadline(5000)), "the visible text read", || Ok(3)), Ok(3));
    }

    #[test]
    fn a_spent_budget_is_refused_before_starting() {
        let spent = Deadline { start: Instant::now().checked_sub(Duration::from_secs(1)).unwrap(), budget_ms: 10 };
        let started = std::sync::atomic::AtomicBool::new(false);
        let started = std::sync::Arc::new(started);
        let seen = started.clone();
        let refused: Result<u8, String> = bounded().run(Some(&spent), "the native control probe", move || {
            seen.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(1)
        });
        assert_eq!(
            refused,
            Err("computer_command_timeout: accessibility read exceeded 10ms during the native control probe; the read was abandoned and the input host kept running".into())
        );
        assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn a_panic_becomes_an_error() {
        let failed: Result<u8, String> = bounded().run(Some(&deadline(5000)), "the stage", || panic!("provider"));
        assert_eq!(failed, Err("accessibility read failed during the stage".into()));
    }
}
