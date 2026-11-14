//! The wait action, which may end early once the window layer stays quiet
//! (Do-Wait, input-pointer.ps1:237-256; quiet-wait.ps1:12-61). A sample is
//! window metadata only: the window set in z-order, the foreground window and
//! each window's title, state and bounds.

use super::super::{sleep_ms, Host, Res};
use crate::obj;
use crate::protocol::{round_half_even, Obj, Req};
use serde_json::json;
use std::time::{Duration, Instant};

const SAMPLE_INTERVAL_MS: f64 = 200.0;
/// Consecutive unchanged comparisons that end the wait: 3 equal samples.
const EQUAL_RUN: u32 = 2;

/// The wait's own clock, so a test sees every deadline and can wake late.
trait Clock {
    fn elapsed_ms(&self) -> f64;
    /// Sleeps until the clock reads `until_ms` (Start-QuietSleep).
    fn sleep_until(&self, until_ms: f64);
}

struct Wall(Instant);

impl Clock for Wall {
    fn elapsed_ms(&self) -> f64 {
        self.0.elapsed().as_secs_f64() * 1000.0
    }
    fn sleep_until(&self, until_ms: f64) {
        let ms = until_ms - self.elapsed_ms();
        if ms > 0.0 {
            std::thread::sleep(Duration::from_secs_f64(ms / 1000.0));
        }
    }
}

#[derive(Debug, PartialEq)]
struct Outcome {
    quiet: bool,
    waited_ms: i64,
}

/// Waits `seconds`, already checked to be 0..30. Only a wait that asks for it
/// ends once the window layer stops changing; any other is a fixed pause.
pub(super) fn wait(host: &Host, req: &Req, seconds: f64) -> Res<Obj> {
    if req.bool_true("quiet") && seconds > 0.0 {
        let outcome = until_quiet(seconds, &mut || sample(host), &Wall(Instant::now()))?;
        return Ok(obj! { "text" => report(&outcome, seconds).to_string() });
    }
    sleep_ms((seconds * 1000.0) as u64);
    Ok(obj! { "text" => format!("waited {seconds}s") })
}

/// Get-QuietSample.
fn sample(host: &Host) -> Res<String> {
    let rows: Vec<String> = host
        .desktop
        .windows()?
        .iter()
        .map(|w| {
            format!(
                "{}|{}|{}|{}|{}|{},{},{},{}",
                w.id(),
                w.title,
                w.focused,
                w.minimized,
                w.maximized,
                w.x,
                w.y,
                w.width,
                w.height
            )
        })
        .collect();
    Ok(rows.join("\n"))
}

/// Wait-UntilQuiet. The requested time is a cap. A next sample only starts
/// when a full interval plus a sample's cost still fits before it, so every
/// compared pair is a full interval apart and no sample starts past the cap.
fn until_quiet(
    seconds: f64,
    sample: &mut dyn FnMut() -> Res<String>,
    clock: &dyn Clock,
) -> Res<Outcome> {
    let cap_ms = round_half_even(seconds * 1000.0) as f64;
    let mut previous: Option<String> = None;
    let mut equal_run = 0;
    loop {
        let started_ms = clock.elapsed_ms();
        let current = sample()?;
        let cost_ms = clock.elapsed_ms() - started_ms;
        if previous.as_deref() == Some(current.as_str()) {
            equal_run += 1;
            if equal_run >= EQUAL_RUN {
                return Ok(Outcome {
                    quiet: true,
                    waited_ms: round_half_even(clock.elapsed_ms()),
                });
            }
        } else {
            equal_run = 0;
        }
        previous = Some(current);
        // A shortened interval is no evidence of stability: when a full
        // interval and the next sample no longer fit, sleep out the cap.
        if cap_ms - clock.elapsed_ms() <= SAMPLE_INTERVAL_MS + cost_ms {
            break;
        }
        clock.sleep_until(clock.elapsed_ms() + SAMPLE_INTERVAL_MS);
        // A late wake must not start a sample the cap has no room for.
        if cap_ms - clock.elapsed_ms() <= cost_ms {
            break;
        }
    }
    clock.sleep_until(cap_ms);
    Ok(Outcome {
        quiet: false,
        waited_ms: round_half_even(clock.elapsed_ms()),
    })
}

/// Do-Wait's reply, which travels as the result's JSON text.
fn report(outcome: &Outcome, seconds: f64) -> serde_json::Value {
    let mut quiet_wait = obj! {
        "ended_early" => outcome.quiet,
        "waited_ms" => outcome.waited_ms,
        "requested_ms" => round_half_even(seconds * 1000.0),
    };
    if !outcome.quiet {
        quiet_wait.insert("reason".into(), json!("still_changing"));
    }
    // Seconds to two places, without trailing zeros.
    let waited = format!("{:.2}", outcome.waited_ms as f64 / 1000.0);
    let waited = waited.trim_end_matches('0').trim_end_matches('.');
    json!({
        "ok": true,
        "action": "wait",
        "message": format!("waited {waited}s"),
        "quiet_wait": quiet_wait,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A clock that moves only when the wait sleeps or a sample costs time;
    /// every wake is `late_ms` past its deadline.
    #[derive(Default)]
    struct Fake {
        now: Cell<f64>,
        late_ms: f64,
        deadlines: RefCell<Vec<f64>>,
    }

    impl Clock for Fake {
        fn elapsed_ms(&self) -> f64 {
            self.now.get()
        }
        fn sleep_until(&self, until_ms: f64) {
            self.deadlines.borrow_mut().push(until_ms);
            if until_ms > self.now.get() {
                self.now.set(until_ms + self.late_ms);
            }
        }
    }

    /// Runs the wait over `samples` (the last one repeats), each costing
    /// `cost_ms`; returns the outcome and when each sample started.
    fn run(seconds: f64, samples: &[&str], cost_ms: f64, clock: &Fake) -> (Outcome, Vec<f64>) {
        let mut starts = Vec::new();
        let outcome = until_quiet(
            seconds,
            &mut || {
                let at = starts.len().min(samples.len() - 1);
                starts.push(clock.now.get());
                clock.now.set(clock.now.get() + cost_ms);
                Ok(samples[at].to_string())
            },
            clock,
        )
        .expect("the fake sampler never fails");
        (outcome, starts)
    }

    #[test]
    fn three_equal_samples_end_the_wait_early() {
        let clock = Fake::default();
        let (outcome, starts) = run(5.0, &["a"], 10.0, &clock);
        assert_eq!(outcome, Outcome { quiet: true, waited_ms: 430 });
        // Every compared pair is a full interval apart.
        assert_eq!(starts, [0.0, 210.0, 420.0]);
    }

    #[test]
    fn a_change_restarts_the_run_of_equal_samples() {
        let clock = Fake::default();
        let (outcome, starts) = run(5.0, &["a", "a", "b", "c"], 0.0, &clock);
        // a a b c c c: the third equal sample is the sixth.
        assert_eq!(starts.len(), 6);
        assert_eq!(outcome, Outcome { quiet: true, waited_ms: 1000 });
    }

    #[test]
    fn a_layer_that_keeps_changing_sleeps_out_the_cap() {
        let clock = Fake::default();
        let changing: Vec<String> = (0..40).map(|n| n.to_string()).collect();
        let changing: Vec<&str> = changing.iter().map(String::as_str).collect();
        let (outcome, starts) = run(1.0, &changing, 10.0, &clock);
        assert_eq!(outcome, Outcome { quiet: false, waited_ms: 1000 });
        // After the sample at 630 only 360 ms remain past its end: a full
        // interval and another sample still fit, after the one at 840 not.
        assert_eq!(starts, [0.0, 210.0, 420.0, 630.0, 840.0]);
        assert_eq!(clock.deadlines.borrow().last(), Some(&1000.0));
    }

    #[test]
    fn a_cap_shorter_than_an_interval_takes_one_sample_and_is_not_quiet() {
        let clock = Fake::default();
        let (outcome, starts) = run(0.15, &["a"], 5.0, &clock);
        assert_eq!(outcome, Outcome { quiet: false, waited_ms: 150 });
        assert_eq!(starts, [0.0]);
        assert_eq!(*clock.deadlines.borrow(), [150.0]);
    }

    #[test]
    fn a_late_wake_does_not_start_a_sample_the_cap_has_no_room_for() {
        let clock = Fake { late_ms: 195.0, ..Default::default() };
        // The first sample ends at 10 and the wake comes at 405; of the 420 ms
        // cap 15 remain, more than a sample's cost, so one more sample runs.
        // It ends at 415 with no interval left.
        let (outcome, starts) = run(0.42, &["a"], 10.0, &clock);
        assert_eq!(starts, [0.0, 405.0]);
        assert!(!outcome.quiet);
        // With a 400 ms cap the same wake is already past it: no second sample.
        let clock = Fake { late_ms: 195.0, ..Default::default() };
        let (outcome, starts) = run(0.4, &["a"], 10.0, &clock);
        assert_eq!(starts, [0.0]);
        assert_eq!(outcome, Outcome { quiet: false, waited_ms: 405 });
    }

    #[test]
    fn a_failed_sample_fails_the_wait() {
        let clock = Fake::default();
        let failed = until_quiet(1.0, &mut || Err("no windows".into()), &clock);
        assert_eq!(failed, Err("no windows".to_string()));
    }

    #[test]
    fn the_reply_carries_the_quiet_wait_report() {
        assert_eq!(
            report(&Outcome { quiet: true, waited_ms: 430 }, 5.0),
            json!({
                "ok": true,
                "action": "wait",
                "message": "waited 0.43s",
                "quiet_wait": { "ended_early": true, "waited_ms": 430, "requested_ms": 5000 },
            })
        );
        assert_eq!(
            report(&Outcome { quiet: false, waited_ms: 2000 }, 2.0),
            json!({
                "ok": true,
                "action": "wait",
                "message": "waited 2s",
                "quiet_wait": {
                    "ended_early": false,
                    "waited_ms": 2000,
                    "requested_ms": 2000,
                    "reason": "still_changing",
                },
            })
        );
    }
}
