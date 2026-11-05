//! The polling half of every poll-based login: OAuth device grants (RFC 8628
//! §3.5: Muse Code, OpenCode Go) and Cursor's poll login. The server sets the
//! pace: `slow_down` and a rate limit widen the interval for the rest of the
//! flow, `authorization_pending` keeps it, and the device code's own expiry
//! ends the flow.

use std::time::Duration;

use mixdog_core_api::domain::login::LoginFailure;

use super::pace::Pace;

const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// What one poll of the token endpoint said.
pub enum Poll<T> {
    Granted(T),
    Pending,
    SlowDown,
    Expired,
    Denied,
    /// A gateway or rate-limit answer worth polling again; `fault` is the
    /// failure once the retries run out.
    Transient {
        rate_limited: bool,
        retry_after: Option<Duration>,
        fault: LoginFailure,
    },
    /// The request itself failed (timeout, connection); `fault` as above.
    Network { fault: LoginFailure },
    /// An answer that ends the login.
    Fatal(LoginFailure),
}

pub struct Schedule {
    pub interval: Duration,
    /// Unix milliseconds at which the device code dies; `None` = no expiry.
    pub deadline_ms: Option<u64>,
    /// Whether a network fault doubles the interval (Muse does, RFC 8628
    /// §3.5; OpenCode Go keeps it).
    pub back_off_on_network: bool,
    /// How a still-pending answer changes the interval:
    /// `next = min(ceil(interval × factor), cap)`. Factor 1.0 keeps it.
    pub growth: Growth,
    /// Wait one interval before the first poll.
    pub wait_first: bool,
    /// This many consecutive transient or network answers end the flow with
    /// the last one's fault. Any other answer resets the count.
    pub max_consecutive_errors: u32,
    /// Polls after which a flow still pending ends as expired; `None` = no cap.
    pub max_attempts: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Growth {
    pub factor: f64,
    pub cap: Option<Duration>,
}

impl Default for Growth {
    fn default() -> Self {
        Self { factor: 1.0, cap: None }
    }
}

impl Growth {
    fn next(self, interval: Duration) -> Duration {
        // Whole milliseconds, rounded up, as the Node loops compute it.
        let grown = Duration::from_millis((interval.as_millis() as f64 * self.factor).ceil() as u64);
        self.cap.map_or(grown, |cap| grown.min(cap))
    }
}

impl Default for Schedule {
    /// RFC 8628 §3.5: a 5 s interval, no growth, poll first, and the fourth
    /// consecutive error ends the flow.
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(5),
            deadline_ms: None,
            back_off_on_network: false,
            growth: Growth::default(),
            wait_first: false,
            max_consecutive_errors: 4,
            max_attempts: None,
        }
    }
}

impl Schedule {
    /// Cursor's poll login (`cursor-auth.mjs` `pollCursorOAuth`): 1 s growing
    /// ×1.2 to a 10 s cap, a wait before every poll, 3 consecutive errors,
    /// 150 polls.
    pub fn cursor() -> Self {
        Self {
            interval: Duration::from_secs(1),
            growth: Growth { factor: 1.2, cap: Some(Duration::from_secs(10)) },
            wait_first: true,
            max_consecutive_errors: 3,
            max_attempts: Some(150),
            ..Self::default()
        }
    }
}

/// Polls until a grant, a refusal, or the device code's expiry.
pub async fn run<T, F, Fut>(
    pace: &dyn Pace,
    schedule: Schedule,
    mut poll: F,
) -> Result<T, LoginFailure>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Poll<T>>,
{
    let mut interval = schedule.interval;
    let mut failures = 0;
    let left = |now: u64| {
        schedule
            .deadline_ms
            .map(|d| Duration::from_millis(d.saturating_sub(now)))
    };
    let mut attempts = 0u32;
    if schedule.wait_first {
        match left(pace.now_ms()) {
            Some(l) => pace.wait(interval.min(l)).await,
            None => pace.wait(interval).await,
        }
    }
    while left(pace.now_ms()).is_none_or(|l| !l.is_zero()) {
        let answer = poll().await;
        attempts += 1;
        let capped = schedule.max_attempts.is_some_and(|cap| attempts >= cap);
        let wait = match answer {
            Poll::Granted(value) => return Ok(value),
            Poll::Pending => {
                failures = 0;
                interval = schedule.growth.next(interval);
                interval
            }
            Poll::SlowDown => {
                failures = 0;
                interval += SLOW_DOWN_STEP;
                interval
            }
            Poll::Expired => return Err(LoginFailure::Expired),
            Poll::Denied => return Err(LoginFailure::Denied),
            Poll::Fatal(failure) => return Err(failure),
            Poll::Transient {
                rate_limited,
                retry_after,
                fault,
            } => {
                failures += 1;
                if failures >= schedule.max_consecutive_errors {
                    return Err(fault);
                }
                if rate_limited {
                    interval += SLOW_DOWN_STEP;
                }
                interval.max(retry_after.unwrap_or_default())
            }
            Poll::Network { fault } => {
                failures += 1;
                if failures >= schedule.max_consecutive_errors {
                    return Err(fault);
                }
                if schedule.back_off_on_network {
                    // Already at the cap: polling again at the same rate would
                    // defeat the back-off.
                    if interval >= MAX_BACKOFF {
                        return Err(fault);
                    }
                    interval = (interval * 2).min(MAX_BACKOFF);
                }
                interval
            }
        };
        if capped {
            break;
        }
        match left(pace.now_ms()) {
            Some(l) if l.is_zero() => break,
            Some(l) => pace.wait(wait.min(l)).await,
            None => pace.wait(wait).await,
        }
    }
    Err(LoginFailure::Expired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::pace::FakePace;

    fn schedule(deadline_ms: Option<u64>) -> Schedule {
        Schedule {
            interval: Duration::from_secs(5),
            deadline_ms,
            back_off_on_network: true,
            ..Schedule::default()
        }
    }

    fn waits_ms(pace: &FakePace) -> Vec<u128> {
        pace.waits.lock().unwrap().iter().map(Duration::as_millis).collect()
    }

    fn network() -> Poll<u32> {
        Poll::Network { fault: LoginFailure::Denied }
    }

    #[test]
    fn the_default_schedule_is_the_device_grant_one() {
        let s = Schedule::default();
        assert_eq!(s.growth.next(Duration::from_secs(5)), Duration::from_secs(5), "factor 1.0 keeps the interval");
        assert_eq!((s.wait_first, s.max_consecutive_errors, s.max_attempts), (false, 4, None));
    }

    /// `pollCursorOAuth`: the wait comes before every poll and a pending
    /// answer grows it ×1.2, rounded up to whole ms, to a 10 s cap.
    #[tokio::test]
    async fn cursor_schedule_waits_first_and_grows_to_its_cap() {
        let pace = FakePace::default();
        let mut replies: Vec<Poll<u32>> = (0..14).map(|_| Poll::Pending).collect();
        replies.push(Poll::Granted(1));
        let got = run(&pace, Schedule::cursor(), script(replies)).await;
        assert_eq!(got, Ok(1));
        assert_eq!(
            waits_ms(&pace),
            [1000, 1200, 1440, 1728, 2074, 2489, 2987, 3585, 4302, 5163, 6196, 7436, 8924, 10000, 10000]
        );
    }

    #[tokio::test]
    async fn cursor_schedule_counts_consecutive_errors_and_a_pending_answer_resets_them() {
        let pace = FakePace::default();
        let ok = run(
            &pace,
            Schedule::cursor(),
            script(vec![network(), network(), Poll::Pending, network(), network(), Poll::Granted(2)]),
        )
        .await;
        assert_eq!(ok, Ok(2));
        assert_eq!(
            waits_ms(&pace),
            [1000, 1000, 1000, 1200, 1200, 1200],
            "errors leave the interval alone; the pending answer grew it"
        );
        let pace = FakePace::default();
        let failed = run(&pace, Schedule::cursor(), script(vec![network(), network(), network()])).await;
        assert_eq!(failed, Err(LoginFailure::Denied), "the third consecutive error ends the flow");
        assert_eq!(waits_ms(&pace).len(), 3, "the wait before the first poll, then one per error but the last");
    }

    #[tokio::test]
    async fn cursor_schedule_ends_as_expired_after_150_polls() {
        let pace = FakePace::default();
        let polls = std::cell::Cell::new(0u32);
        let got: Result<u32, _> = run(&pace, Schedule::cursor(), || {
            polls.set(polls.get() + 1);
            std::future::ready(Poll::Pending)
        })
        .await;
        assert_eq!(got, Err(LoginFailure::Expired));
        assert_eq!(polls.get(), 150);
        assert_eq!(pace.waits.lock().unwrap().len(), 150, "no wait after the last poll");
    }

    fn script(mut replies: Vec<Poll<u32>>) -> impl FnMut() -> std::future::Ready<Poll<u32>> {
        replies.reverse();
        move || std::future::ready(replies.pop().expect("a scripted reply"))
    }

    fn waits(pace: &FakePace) -> Vec<u64> {
        pace.waits.lock().unwrap().iter().map(Duration::as_secs).collect()
    }

    #[tokio::test]
    async fn slow_down_widens_the_interval_for_the_rest_of_the_flow() {
        let pace = FakePace::default();
        let got = run(
            &pace,
            schedule(None),
            script(vec![Poll::Pending, Poll::SlowDown, Poll::Pending, Poll::Granted(7)]),
        )
        .await;
        assert_eq!(got, Ok(7));
        assert_eq!(waits(&pace), [5, 10, 10]);
    }

    #[tokio::test]
    async fn rate_limits_honour_retry_after_and_run_out() {
        let transient = |after| Poll::Transient {
            rate_limited: true,
            retry_after: after,
            fault: LoginFailure::Denied,
        };
        let pace = FakePace::default();
        let got: Result<u32, _> = run(
            &pace,
            schedule(None),
            script(vec![
                transient(Some(Duration::from_secs(40))),
                transient(None),
                transient(None),
                transient(None),
            ]),
        )
        .await;
        assert_eq!(got, Err(LoginFailure::Denied), "the fourth transient answer gives up");
        assert_eq!(waits(&pace), [40, 15, 20]);
    }

    #[tokio::test]
    async fn the_device_codes_own_expiry_ends_the_flow() {
        let pace = FakePace::default();
        let got: Result<u32, _> = run(
            &pace,
            schedule(Some(12_000)),
            script(vec![Poll::Pending, Poll::Pending, Poll::Pending]),
        )
        .await;
        assert_eq!(got, Err(LoginFailure::Expired));
        assert_eq!(waits(&pace), [5, 5, 2], "the last wait stops at the deadline");
    }

    #[tokio::test]
    async fn network_faults_back_off_until_the_cap() {
        let net = || Poll::Network {
            fault: LoginFailure::Unavailable {
                capability: "net".into(),
            },
        };
        let pace = FakePace::default();
        let mut s = schedule(None);
        s.interval = Duration::from_secs(40);
        let got: Result<u32, _> = run(&pace, s, script(vec![net(), net()])).await;
        assert!(matches!(got, Err(LoginFailure::Unavailable { .. })));
        assert_eq!(waits(&pace), [60]);
    }
}
