//! A port over a fake external driver, for the host's tests: the driver log is what reached the "operating system", and a test
//! can hold a submission right before its admission or inside it.

use super::{Boundary, Cleanup, Holder, Ledger, Owned, REVOKED, Receipt, Scope};
use std::sync::{Arc, Barrier, Mutex};

/// A key or button the fake desktop holds, by device and code.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Hold {
    pub(crate) device: String,
    pub(crate) code: String,
}

impl Hold {
    pub(crate) fn new(device: &str, code: &str) -> Hold {
        Hold { device: device.into(), code: code.into() }
    }
}

/// Where a test holds a submission: before its admission, or inside it (the submission already won).
#[derive(Clone)]
pub(crate) struct Pause {
    pub(crate) reached: Arc<Barrier>,
    pub(crate) resume: Arc<Barrier>,
}

impl Pause {
    pub(crate) fn new() -> Pause {
        Pause { reached: Arc::new(Barrier::new(2)), resume: Arc::new(Barrier::new(2)) }
    }

    fn hold(&self) {
        self.reached.wait();
        self.resume.wait();
    }
}

#[derive(Default)]
pub(crate) struct Driver {
    pub(crate) log: Mutex<Vec<String>>,
    /// The next submission waits here before its admission.
    pub(crate) before: Mutex<Option<Pause>>,
    /// The next submission waits here once admitted, before it lands.
    pub(crate) inside: Mutex<Option<Pause>>,
}

impl Driver {
    pub(crate) fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn land(&self, what: String) {
        let pause = self.inside.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.hold();
        }
        self.log.lock().unwrap().push(what);
    }
}

pub(crate) struct FakePort {
    scope: Scope,
    ledger: Ledger<Hold>,
    pub(crate) driver: Arc<Driver>,
}

impl FakePort {
    pub(crate) fn new(scope: &Scope) -> Arc<FakePort> {
        let port = Arc::new(FakePort { scope: scope.clone(), ledger: Ledger::new(scope.epoch()), driver: Arc::default() });
        port.ledger.observe(scope);
        scope.hold(Arc::downgrade(&(port.clone() as Arc<dyn Holder>)));
        port
    }

    fn submit(&self, what: String) -> Result<(), String> {
        let pause = self.driver.before.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.hold();
        }
        let _admitted = self.scope.admit(Boundary::Local)?;
        self.driver.land(what);
        Ok(())
    }

    /// An ordinary effect.
    pub(crate) fn act(&self, what: &str) -> Result<(), String> {
        self.submit(what.into())
    }

    /// An effect handed over: admitted and counted, never waited for by the closure.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) fn act_handed_over(&self, what: &str) -> Result<(), String> {
        let _admitted = self.scope.admit(Boundary::HandOver)?;
        self.driver.land(what.into());
        Ok(())
    }

    /// A press: its receipt is recorded once it landed.
    pub(crate) fn press(&self, hold: Hold) -> Result<Receipt<Hold>, String> {
        let pause = self.driver.before.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.hold();
        }
        let _admitted = self.scope.admit(Boundary::Local)?;
        self.driver.land(format!("down {} {}", hold.device, hold.code));
        Ok(self.ledger.record(hold))
    }

    /// A release of what `hold` names: through a receipt whatever the scope says, else an ordinary submission.
    pub(crate) fn release(&self, hold: &Hold) -> Result<(), String> {
        let _releasing = self.ledger.releasing();
        match self.ledger.take(|held| held == hold) {
            Owned::Held(receipt) => {
                self.driver.land(format!("up {} {}", receipt.hold.device, receipt.hold.code));
                self.ledger.released(&receipt);
                Ok(())
            }
            Owned::Drained => Ok(()),
            Owned::None => self.submit(format!("up {} {}", hold.device, hold.code)),
        }
    }

    /// Exactly the release `receipt` names.
    pub(crate) fn redeem(&self, receipt: &Receipt<Hold>) -> Result<(), String> {
        let _releasing = self.ledger.releasing();
        let receipt = self.ledger.redeem(receipt)?;
        self.driver.land(format!("up {} {}", receipt.hold.device, receipt.hold.code));
        Ok(())
    }
}

impl Holder for FakePort {
    fn release_held(&self) -> bool {
        let _releasing = self.ledger.releasing();
        for receipt in self.ledger.drain() {
            self.driver.land(format!("up {} {}", receipt.hold.device, receipt.hold.code));
            self.ledger.drained(receipt);
        }
        true
    }

    fn cleanup(&self) -> Cleanup {
        self.ledger.cleanup()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: &str) -> Hold {
        Hold::new("keyboard", code)
    }

    /// Held right before its admission, a submission that resumes after Off was acknowledged reaches nothing.
    #[test]
    fn a_submission_paused_before_admission_is_refused_after_the_acknowledgement() {
        let scope = Scope::open(1);
        let port = FakePort::new(&scope);
        let pause = Pause::new();
        *port.driver.before.lock().unwrap() = Some(pause.clone());
        std::thread::scope(|threads| {
            let submission = threads.spawn(|| port.act("click"));
            pause.reached.wait();
            scope.revoke();
            pause.resume.wait();
            assert_eq!(submission.join().unwrap(), Err(REVOKED.to_string()));
        });
        assert!(port.driver.log().is_empty());
    }

    /// Admitted first, the submission wins: the revocation returns only once it landed.
    #[test]
    fn a_submission_already_admitted_lands_before_the_acknowledgement() {
        let scope = Scope::open(1);
        let port = FakePort::new(&scope);
        let pause = Pause::new();
        *port.driver.inside.lock().unwrap() = Some(pause.clone());
        let acknowledged = Mutex::new(false);
        std::thread::scope(|threads| {
            let submission = threads.spawn(|| port.act("click"));
            pause.reached.wait();
            let revoker = threads.spawn(|| {
                scope.revoke();
                *acknowledged.lock().unwrap() = true;
            });
            while !scope.is_revoked() {
                std::thread::yield_now();
            }
            assert!(!*acknowledged.lock().unwrap(), "the acknowledgement waits for the admitted submission");
            pause.resume.wait();
            assert_eq!(submission.join().unwrap(), Ok(()));
            revoker.join().unwrap();
        });
        assert_eq!(port.driver.log(), ["click"]);
    }

    /// After Off only owned releases go out: one per receipt, never twice, never one without a receipt.
    #[test]
    fn after_the_revocation_only_owned_releases_go_out_once() {
        let scope = Scope::open(1);
        let port = FakePort::new(&scope);
        let a = port.press(key("a")).unwrap();
        port.press(Hold::new("mouse", "left")).unwrap();
        scope.revoke();
        assert_eq!(port.press(key("b")), Err(REVOKED.to_string()));
        assert_eq!(port.release(&key("z")), Err(REVOKED.to_string()), "a release without a receipt");
        assert_eq!(port.redeem(&a), Ok(()));
        assert_eq!(port.redeem(&a), Err(super::super::NOT_OWNED.to_string()), "a double release");
        assert!(scope.release_held());
        assert_eq!(port.release(&Hold::new("mouse", "left")), Ok(()), "already let go of by the cleanup");
        assert_eq!(port.release(&Hold::new("mouse", "left")), Err(REVOKED.to_string()));
        assert_eq!(port.driver.log(), ["down keyboard a", "down mouse left", "up keyboard a", "up mouse left"]);
    }

    /// Queued work keeps the port of the epoch it began under: a new epoch after Off does not revive it.
    #[test]
    fn work_queued_before_off_stays_refused_under_a_new_epoch() {
        let old = Scope::open(1);
        let queued = FakePort::new(&old);
        old.revoke();
        let new = Scope::open(2);
        let current = FakePort::new(&new);
        assert_eq!(queued.act("queued click"), Err(REVOKED.to_string()));
        assert_eq!(current.act("new click"), Ok(()));
        let receipt = current.press(key("a")).unwrap();
        assert_eq!(queued.redeem(&receipt), Err(super::super::NOT_OWNED.to_string()), "another executor's receipt");
        assert!(queued.driver.log().is_empty());
    }

    /// A revoked scope nested in a live one: its submissions are refused while the live scope's go on, and its revocation does
    /// not wait for the other scope's submission in progress.
    #[test]
    fn a_revoked_scope_inside_a_live_one_refuses_alone() {
        let live = Scope::open(1);
        let outer = FakePort::new(&live);
        let revoked = Scope::open(2);
        let inner = FakePort::new(&revoked);
        let pause = Pause::new();
        *outer.driver.inside.lock().unwrap() = Some(pause.clone());
        std::thread::scope(|threads| {
            let running = threads.spawn(|| outer.act("outer"));
            pause.reached.wait();
            // Completes while the live scope's submission is still inside its admission.
            revoked.revoke();
            assert_eq!(inner.act("inner"), Err(REVOKED.to_string()));
            pause.resume.wait();
            assert_eq!(running.join().unwrap(), Ok(()));
        });
        assert_eq!(outer.act("outer again"), Ok(()));
        assert!(inner.driver.log().is_empty());
    }
}
