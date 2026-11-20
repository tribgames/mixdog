//! `ProcessWarmDeps` against `session/cache-warm.mjs`: every `defaultPrices` answer and every
//! `defaultRecordUsage` ledger row of `fixtures/cache-warm-deps/golden.json`
//! (`record-cache-warm-deps.mjs`), priced over the models.dev table the recording used; and the
//! setting read from `fixtures/cache-warm/golden.json`.

use super::chain::WarmTimers;
use super::process::TokioTimers;

// The timers are tokio's, so the test moves the paused clock itself, to 1 ms before the 150 ms delay and then onto it.
#[tokio::test(start_paused = true)]
async fn a_timer_runs_after_its_delay_and_a_cancelled_one_never_does() {
    // TokioTimers spawns through mixdog-rt, which needs its (test) backend installed.
    mixdog_rt::testing::tokens();
    // Each timer that runs says so. The test keeps no sender, so a wait for one that will never run ends with `None`.
    let (fired, mut ran) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    for (name, delay, cancel) in [("late", 150.0, false), ("cancelled", 150.0, true), ("negative", -5.0, false)] {
        let fired = fired.clone();
        let handle = TokioTimers.schedule(
            delay,
            Box::pin(async move {
                let _ = fired.send(name);
            }),
        );
        if cancel {
            handle.cancel();
        }
    }
    drop(fired);
    // A wait on the paused clock lets it run ahead to the next timer when nothing else can run, so each wait is followed by
    // the time on the clock: it is only where the test put it.
    let (began, ms) = (tokio::time::Instant::now(), std::time::Duration::from_millis);
    assert_eq!((ran.recv().await, began.elapsed()), (Some("negative"), ms(0)), "a negative delay runs with no time passed");
    tokio::time::advance(ms(149)).await;
    assert!(ran.try_recv().is_err(), "nothing has run 149 ms in");
    tokio::time::advance(ms(1)).await;
    assert_eq!((ran.recv().await, began.elapsed()), (Some("late"), ms(150)), "the 150 ms timer runs at 150 ms");
    assert_eq!(ran.recv().await, None, "the cancelled timer never runs");
}
