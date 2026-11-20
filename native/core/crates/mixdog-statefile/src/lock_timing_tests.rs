//! How long a lock request waits for a lock it cannot take, on a virtual clock: the waits between attempts, the instant
//! it gives up and the error it gives up with. The clock starts at the file time of the lock, which names no owner, so
//! the holder is not stale until the stale window has passed.

use std::cell::Cell;
use std::cell::RefCell;
use std::path::Path;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use mixdog_fsio::ReadProof;
use mixdog_fsio::Unlaned;

use super::LockClock;
use super::LockOpts;
use super::locked_on;

/// Time in nanoseconds that moves only when a wait is asked for; every draw of the jitter is one half.
struct Virtual {
    now_ns: Cell<i128>,
    sleeps_ms: RefCell<Vec<f64>>,
}

impl LockClock for Virtual {
    fn now_ns(&self) -> i128 {
        self.now_ns.get()
    }
    fn sleep(&self, _proof: &impl ReadProof, duration: Duration) {
        let ms = duration.as_nanos() as f64 / 1e6;
        self.sleeps_ms.borrow_mut().push(ms);
        self.now_ns.set(self.now_ns.get() + ms.ceil() as i128 * 1_000_000);
    }
    fn draw(&self) -> f64 {
        0.5
    }
}

/// An ownerless lock file last modified at millisecond `at_ms` of the epoch, and a clock reading `now_ms`.
fn contended(lock: &Path, at_ms: u64, now_ms: u64) -> Virtual {
    mixdog_testkit::write(lock, "");
    mixdog_fsio::File::options().write(true).open(&Unlaned, lock).unwrap().set_modified(&Unlaned, UNIX_EPOCH + Duration::from_millis(at_ms)).unwrap();
    Virtual { now_ns: Cell::new(i128::from(now_ms) * 1_000_000), sleeps_ms: RefCell::default() }
}

const T0: u64 = 1_700_000_000_000;

#[test]
fn a_request_for_a_held_lock_backs_off_and_gives_up_at_its_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("f.json.lock");
    let clock = contended(&lock, T0, T0);
    let opts = LockOpts { timeout: Some(Duration::from_millis(100)), ..LockOpts::default() };
    let error = locked_on(&clock, &Unlaned, &lock, &opts, || ()).unwrap_err();
    assert_eq!(error.code(), Some("ELOCKTIMEOUT"));
    assert!(error.to_string().starts_with("atomic lock timeout after 100ms: "), "{error}");
    // The first wait is the 25 ms backoff plus half of it, the second the 50 ms backoff cut to the 63 ms left.
    assert_eq!(*clock.sleeps_ms.borrow(), [37.0, 63.0]);
    assert_eq!(clock.now_ns.get(), i128::from(T0 + 100) * 1_000_000, "it gives up the moment the deadline is reached");
}

#[test]
fn a_request_that_tries_once_never_waits() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("f.json.lock");
    let clock = contended(&lock, T0, T0);
    let opts = LockOpts { timeout: Some(Duration::ZERO), ..LockOpts::default() };
    let error = locked_on(&clock, &Unlaned, &lock, &opts, || ()).unwrap_err();
    assert_eq!(error.code(), Some("ELOCKCONTENDED"));
    assert!(clock.sleeps_ms.borrow().is_empty());
}

#[test]
fn a_lock_naming_no_owner_is_taken_over_once_it_outlives_the_stale_window() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("f.json.lock");
    let clock = contended(&lock, T0, T0 + 5_000);
    let opts = LockOpts { timeout: Some(Duration::from_millis(100)), stale: Some(Duration::from_millis(1_000)), ..LockOpts::default() };
    assert_eq!(locked_on(&clock, &Unlaned, &lock, &opts, || 7).unwrap(), 7);
    assert!(clock.sleeps_ms.borrow().is_empty(), "a stale lock is reclaimed without waiting");
    assert!(!lock.exists(), "released after the body");
}

#[test]
fn the_waits_grow_by_the_backoff_schedule_and_never_pass_the_deadline() {
    // 25, 50, 100, then 200 ms of backoff, each plus the jitter of at most 75 ms; the last wait is the time that is left.
    assert_eq!(super::lock_retry_delay(0, 10_000.0, 0.0), 25.0);
    assert_eq!(super::lock_retry_delay(1, 10_000.0, 0.0), 50.0);
    assert_eq!(super::lock_retry_delay(2, 10_000.0, 0.0), 100.0);
    assert_eq!(super::lock_retry_delay(3, 10_000.0, 0.0), 200.0);
    assert_eq!(super::lock_retry_delay(9, 10_000.0, 0.999), 274.0, "the jitter is a fraction of at most 75 ms, never the whole backoff");
    assert_eq!(super::lock_retry_delay(0, 10.0, 0.5), 10.0);
    assert_eq!(super::lock_retry_delay(0, 0.2, 0.5), 1.0, "never less than 1 ms");
}
