//! The arbitration core of the macOS and Linux ports (`crate::port::macos`, `crate::port::linux`). Everything here is private
//! to `crate::port`: each platform port's typed operations admit one primitive (`Port::admit`, a guard, never a closure),
//! invoke exactly that one external call in the port's own raw code, and record its completion. A compound operation is a
//! sequence of such calls. What a port holds is a [`Hold`]: a key or button pressed on one device or destination, which builds
//! its own release; nothing else is ever sent as a release.
//!
//! A press is a pending receipt from before its call until the call completes ([`Port::begin`], [`Port::finish`]): a revocation
//! or a release meanwhile marks it, and its completion then sends its release (receipt-derived teardown), so a press whose
//! reply was lost, or whose acknowledgement failed, is still owned.

// The Windows build runs this core's tests only; macOS and Linux use it.
#![cfg_attr(windows, allow(dead_code))]

use super::{Admitted, Boundary, Cleanup, Holder, Ledger, Outcome, Owned, Receipt, Scope, Settled, Ticket, NOT_OWNED, REVOKED};
use std::sync::{Arc, OnceLock};

/// A key or button one device or destination holds.
pub(crate) trait Hold: Clone + PartialEq + Send + Sync + 'static {
    /// Sends the release of this hold, built from it alone (raw code of the port); false when it could not be sent.
    fn release(&self) -> bool;

    /// Whether `other` names the same key or button on the same device or destination (what a receipt is matched by; what the
    /// release then carries is the receipt's own, never the caller's).
    fn same(&self, other: &Self) -> bool {
        self == other
    }

    /// The boundary of this hold's release when it is an ordinary submission (no receipt).
    fn boundary(&self) -> Boundary;
}

pub(crate) struct Port<H: Hold> {
    scope: Scope,
    ledger: Ledger<H>,
}

impl<H: Hold> Port<H> {
    pub(super) fn new(scope: &Scope) -> Arc<Port<H>> {
        let port = Arc::new(Port { scope: scope.clone(), ledger: Ledger::new(scope.epoch()) });
        port.ledger.observe(scope);
        scope.hold(Arc::downgrade(&(port.clone() as Arc<dyn Holder>)));
        port
    }

    /// Admits one primitive call: refused once the scope is closed.
    pub(super) fn admit(&self, boundary: Boundary) -> Result<Admitted<'_>, String> {
        self.scope.admit(boundary)
    }

    /// A press about to be submitted: pending until [`Port::finish`].
    pub(super) fn begin(&self, hold: H) -> Option<Ticket> {
        self.ledger.find(|held| held.same(&hold)).is_none().then(|| self.ledger.begin(hold))
    }

    /// The press completed with `outcome` (`NotApplied` too when its admission was refused). Applied after its release was
    /// asked for (by the revocation or a release), its release follows here, built from the receipt.
    pub(super) fn finish(&self, ticket: Option<Ticket>, outcome: Outcome) {
        let Some(ticket) = ticket else { return };
        if let Settled::Compensate(receipt) = self.ledger.settle(ticket, outcome) {
            let done = receipt.hold.release();
            self.ledger.compensated(receipt, done);
        }
    }

    /// The release of `hold`, built from the hold: with a receipt it goes out whatever the scope says and consumes it; one the
    /// revocation cleanup already let go of (or a pending one, whose completion lets go of it) sends nothing; without either it
    /// is an ordinary submission.
    pub(super) fn release(&self, hold: &H) -> Result<(), String> {
        match self.ledger.take(|held| held.same(hold)) {
            Owned::Held(receipt) => {
                if receipt.hold.release() {
                    self.ledger.released(&receipt);
                    Ok(())
                } else {
                    self.ledger.restore(receipt);
                    Err("input_cleanup_unconfirmed: the release was not accepted".into())
                }
            }
            Owned::Drained => Ok(()),
            Owned::None => {
                let _admitted = self.admit(hold.boundary())?;
                if hold.release() { Ok(()) } else { Err("input_delivery_failed: the release was not sent".into()) }
            }
        }
    }

    /// A press whose call is local, recorded while its admission is still held: the revocation waits for that admission, so
    /// its cleanup drains this receipt.
    pub(super) fn record(&self, hold: H) -> Receipt<H> {
        self.ledger.record(hold)
    }

    /// The release one receipt names, consuming it: built from the ledger's own copy whatever the scope says; nothing to send
    /// once the revocation cleanup let go of it (or, still pending, once its completion does); refused for a forged receipt,
    /// one of another port or epoch, or one already consumed.
    pub(super) fn redeem(&self, receipt: &Receipt<H>) -> Result<(), String> {
        match self.ledger.consume(receipt) {
            Owned::Held(receipt) => {
                if receipt.hold.release() {
                    self.ledger.released(&receipt);
                    Ok(())
                } else {
                    self.ledger.restore(receipt);
                    Err("input_cleanup_unconfirmed: the release was not accepted".into())
                }
            }
            Owned::Drained => Ok(()),
            Owned::None => Err(NOT_OWNED.into()),
        }
    }

    /// Moves what held receipts record (a held button's release point after an accepted motion).
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub(super) fn update(&self, wanted: impl Fn(&H) -> bool, change: impl Fn(&mut H)) {
        self.ledger.update(wanted, change);
    }

    pub(crate) fn holds(&self) -> Vec<H> {
        self.ledger.holds()
    }

    /// Whether the scope is closed: a wait reads it to end early; never a fence (each effect is admitted by the port).
    pub(crate) fn revoked(&self) -> bool {
        self.scope.is_revoked()
    }

    /// Ends `pid`: the signal is one local call (it waits for nothing); the wait for its exit after it holds nothing.
    #[cfg(unix)]
    pub(super) fn terminate(&self, pid: i64) -> Result<(), String> {
        if pid <= 0 || pid > i32::MAX as i64 {
            return Err(format!("invalid pid {pid}"));
        }
        {
            let _admitted = self.admit(Boundary::Local)?;
            // SAFETY: kill takes a plain pid and signal; it has no memory effects here.
            if unsafe { libc::kill(pid as i32, libc::SIGKILL) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        crate::platform::await_exit(pid);
        Ok(())
    }
}

impl<H: Hold> Holder for Port<H> {
    fn release_held(&self) -> bool {
        let mut released = true;
        for receipt in self.ledger.drain() {
            if receipt.hold.release() {
                self.ledger.drained(receipt);
            } else {
                self.ledger.fail(receipt);
                released = false;
            }
        }
        released
    }

    fn cleanup(&self) -> Cleanup {
        self.ledger.cleanup()
    }
}

/// The executor's port of one platform, filled once by its `install`.
pub(crate) struct Slot<H: Hold>(OnceLock<Arc<Port<H>>>);

impl<H: Hold> Slot<H> {
    pub(crate) const fn new() -> Slot<H> {
        Slot(OnceLock::new())
    }

    pub(super) fn install(&self, port: Arc<Port<H>>) {
        let _ = self.0.set(port);
    }

    /// The executor's port; refused where this process built no desktop.
    pub(super) fn get(&self) -> Result<&Arc<Port<H>>, String> {
        self.0.get().ok_or_else(|| REVOKED.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::fake::Pause;
    use std::sync::Mutex;

    static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    /// One test at a time owns the log.
    static SERIAL: Mutex<()> = Mutex::new(());

    /// A key on a test device: the release it builds is the bare up of its own key.
    #[derive(Clone, Copy, PartialEq, Debug)]
    struct Key(u8);

    impl Hold for Key {
        fn release(&self) -> bool {
            LOG.lock().unwrap().push(format!("up {}", self.0));
            true
        }
        fn boundary(&self) -> Boundary {
            Boundary::Local
        }
    }

    /// A typed press as a platform port writes one: pending receipt, one admitted primitive, its completion.
    fn press(port: &Port<Key>, key: u8, outcome: Outcome, inside: Option<&Pause>) -> Result<(), String> {
        let ticket = port.begin(Key(key));
        let admitted = match port.admit(Boundary::HandOver) {
            Ok(admitted) => admitted,
            Err(refused) => {
                port.finish(ticket, Outcome::NotApplied);
                return Err(refused);
            }
        };
        if let Some(pause) = inside {
            pause.reached.wait();
            pause.resume.wait();
        }
        if outcome != Outcome::NotApplied {
            LOG.lock().unwrap().push(format!("down {key}"));
        }
        drop(admitted);
        port.finish(ticket, outcome);
        Ok(())
    }

    fn take_log() -> Vec<String> {
        std::mem::take(&mut *LOG.lock().unwrap())
    }

    /// After Off: a new press and an unowned release are refused, the owned release goes out once (built from the receipt),
    /// the cleanup lets go of the rest, and an operation's release after the cleanup sends nothing again.
    #[test]
    fn only_owned_releases_survive_the_revocation() {
        let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take_log();
        let scope = Scope::open(1);
        let port = Port::<Key>::new(&scope);
        press(&port, 1, Outcome::Applied, None).unwrap();
        press(&port, 2, Outcome::Applied, None).unwrap();
        scope.revoke();
        assert_eq!(press(&port, 3, Outcome::Applied, None), Err(REVOKED.to_string()));
        assert_eq!(port.release(&Key(9)), Err(REVOKED.to_string()), "no receipt");
        assert_eq!(port.release(&Key(1)), Ok(()));
        assert_eq!(port.release(&Key(1)), Err(REVOKED.to_string()), "a double release");
        assert!(scope.release_held());
        assert_eq!(port.release(&Key(2)), Ok(()));
        assert_eq!(take_log(), ["down 1", "down 2", "up 1", "up 2"]);
        assert!(port.holds().is_empty());
    }

    /// A press whose acknowledgement failed (an XTest press whose sync failed) is owned: uncertain, its receipt stays, and the
    /// cleanup releases it. One that provably sent nothing owns nothing.
    #[test]
    fn a_press_with_a_failed_acknowledgement_is_owned() {
        let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take_log();
        let scope = Scope::open(1);
        let port = Port::<Key>::new(&scope);
        press(&port, 4, Outcome::Uncertain, None).unwrap();
        press(&port, 5, Outcome::NotApplied, None).unwrap();
        assert_eq!(port.holds(), [Key(4)]);
        scope.revoke();
        assert!(scope.release_held());
        assert_eq!(take_log(), ["down 4", "up 4"]);
    }

    /// A press awaiting its reply: closure returns at once with it unfinished; the cleanup marks it; once it completes its
    /// release follows; the continuation's next press is refused.
    #[test]
    fn a_press_awaiting_its_reply_does_not_hold_the_closure() {
        let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take_log();
        let scope = Scope::open(1);
        let port = Port::<Key>::new(&scope);
        let pause = Pause::new();
        std::thread::scope(|threads| {
            let pressing = threads.spawn(|| (press(&port, 6, Outcome::Applied, Some(&pause)), press(&port, 7, Outcome::Applied, None)));
            pause.reached.wait();
            assert_eq!(scope.revoke().unfinished, 1);
            assert!(scope.release_held());
            assert_eq!(scope.report().cleanup, Cleanup::Pending);
            pause.resume.wait();
            let (pressed, next) = pressing.join().unwrap();
            assert_eq!(pressed, Ok(()));
            assert_eq!(next, Err(REVOKED.to_string()));
        });
        assert_eq!(take_log(), ["down 6", "up 6"]);
        assert_eq!(scope.report().cleanup, Cleanup::Complete);
    }

    /// The shape of a compound operation (Linux raise then focus, macOS pasteboard clear then write): its first primitive is
    /// held inside the API across Off; the acknowledgement returns with it counted; once it is let go the next primitive is
    /// refused.
    #[test]
    fn a_primitive_held_across_off_is_not_followed_by_the_next() {
        let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take_log();
        let scope = Scope::open(1);
        let port = Port::<Key>::new(&scope);
        let pause = Pause::new();
        std::thread::scope(|threads| {
            let compound = threads.spawn(|| {
                {
                    let _first = port.admit(Boundary::HandOver)?;
                    pause.reached.wait();
                    pause.resume.wait();
                    LOG.lock().unwrap().push("raise".into());
                }
                let _second = port.admit(Boundary::HandOver)?;
                LOG.lock().unwrap().push("focus".into());
                Ok::<(), String>(())
            });
            pause.reached.wait();
            assert_eq!(scope.revoke().unfinished, 1, "the held primitive is in the snapshot");
            pause.resume.wait();
            assert_eq!(compound.join().unwrap(), Err(REVOKED.to_string()));
        });
        assert_eq!(take_log(), ["raise"]);
    }

    /// A thread of the executor's (the X clipboard owner) holds a port, never a permission: paused before it acts, its caller
    /// returned, the scope revoked, it resumes and is refused.
    #[test]
    fn a_thread_resumed_after_off_is_refused_when_it_acts() {
        let scope = Scope::open(1);
        let port = Port::<Key>::new(&scope);
        let pause = Pause::new();
        std::thread::scope(|threads| {
            let owner = threads.spawn(|| {
                pause.reached.wait();
                pause.resume.wait();
                port.admit(Boundary::HandOver).map(|_| ())
            });
            pause.reached.wait();
            // The caller has its answer already; nothing of its accounting holds the owner thread.
            scope.revoke();
            pause.resume.wait();
            assert_eq!(owner.join().unwrap(), Err(REVOKED.to_string()));
        });
    }

    /// A release only by consuming one receipt of this port: once, never one forged by another port or epoch, never again
    /// after it was consumed; one the cleanup already let go of sends nothing.
    #[test]
    fn a_receipt_is_consumed_once_by_its_own_port_only() {
        let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        take_log();
        let scope = Scope::open(1);
        let (port, other) = (Port::<Key>::new(&scope), Port::<Key>::new(&Scope::open(2)));
        let (first, second) = (port.record(Key(1)), port.record(Key(2)));
        assert_eq!(other.redeem(&first), Err(NOT_OWNED.to_string()), "another port's receipt");
        assert_eq!(port.redeem(&first), Ok(()));
        assert_eq!(port.redeem(&first.clone()), Err(NOT_OWNED.to_string()), "a reused receipt");
        scope.revoke();
        assert!(scope.release_held());
        assert_eq!(port.redeem(&second), Ok(()), "let go of by the cleanup: nothing is sent again");
        assert_eq!(port.redeem(&second), Err(NOT_OWNED.to_string()));
        assert_eq!(take_log(), ["up 1", "up 2"]);
    }

    /// A slot no desktop filled submits nothing.
    #[test]
    fn an_empty_slot_refuses() {
        static EMPTY: Slot<Key> = Slot::new();
        assert!(EMPTY.get().is_err());
    }
}
