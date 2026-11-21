//! Forced-order tests of the scope and the ledger.

use super::*;
use std::sync::Barrier;

/// A local call in progress finishes before the revocation returns, and nothing is admitted after closure.
#[test]
fn the_revocation_closes_admission_first_then_waits_for_the_local_call_in_progress() {
    let scope = Scope::open(1);
    let (entered, release) = (Barrier::new(2), Barrier::new(2));
    let log = Mutex::new(Vec::new());
    std::thread::scope(|threads| {
        let submission = threads.spawn(|| {
            let admitted = scope.admit(Boundary::Local).expect("open");
            entered.wait();
            release.wait();
            log.lock().unwrap().push("submitted");
            drop(admitted);
        });
        entered.wait();
        let revoker = threads.spawn(|| {
            scope.revoke();
            log.lock().unwrap().push("acknowledged");
        });
        while !scope.is_revoked() {
            std::thread::yield_now();
        }
        assert!(scope.admit(Boundary::Local).is_err());
        assert!(scope.admit(Boundary::HandOver).is_err());
        release.wait();
        submission.join().unwrap();
        revoker.join().unwrap();
    });
    assert_eq!(*log.lock().unwrap(), ["submitted", "acknowledged"]);
}

/// A pending scope admits nothing until granted; closed first, it never opens (a late grant stays closed) and a waiting
/// admission is refused.
#[test]
fn a_closed_scope_receiving_a_late_grant_stays_closed() {
    let scope = Scope::pending(4);
    std::thread::scope(|threads| {
        let waiting = threads.spawn(|| scope.admit(Boundary::Local).map(drop));
        scope.revoke();
        assert_eq!(waiting.join().unwrap(), Err(REVOKED.to_string()));
    });
    assert!(!scope.grant());
    assert!(scope.admit(Boundary::HandOver).is_err());
    let granted = Scope::pending(4);
    assert!(granted.grant());
    assert!(granted.admit(Boundary::Local).is_ok());
}

struct Fenced {
    closes: Mutex<usize>,
    cleanup: Mutex<Cleanup>,
}

impl Endpoint for Fenced {
    fn close(&self) -> usize {
        *self.closes.lock().unwrap() += 1;
        2
    }
    fn cleanup(&self) -> Cleanup {
        *self.cleanup.lock().unwrap()
    }
}

/// Parent and fenced child calls outstanding, revoked twice: the first snapshot is kept (no fabricated zero), the fenced
/// executor stays registered, and the cleanup follows it.
#[test]
fn a_second_revocation_keeps_the_first_snapshot() {
    let scope = Scope::open(2);
    let child = Arc::new(Fenced { closes: Mutex::new(0), cleanup: Mutex::new(Cleanup::Pending) });
    assert!(scope.fence(child.clone()));
    let held = scope.admit(Boundary::HandOver).unwrap();
    let first = scope.revoke();
    assert_eq!(first, Closure { epoch: 2, unfinished: 3 });
    drop(held);
    assert_eq!(scope.revoke(), first);
    assert_eq!(*child.closes.lock().unwrap(), 1);
    assert!(scope.release_held());
    assert_eq!(scope.report().cleanup, Cleanup::Pending, "the fenced executor has not settled");
    *child.cleanup.lock().unwrap() = Cleanup::Complete;
    let report = scope.report();
    assert_eq!((report.closure.unfinished, report.unfinished_now, report.cleanup), (3, 0, Cleanup::Complete));
    assert!(!scope.fence(child), "a closed scope fences nothing: the late executor is never granted");
}

/// A provider call held for ever: closure returns at once and counts it, the cleanup stays pending, its continuation is
/// refused; once it returns, the report transitions.
#[test]
fn a_provider_call_held_for_ever_does_not_hold_the_closure() {
    let scope = Scope::open(3);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let seen = reports.clone();
    scope.on_report(move |report| seen.lock().unwrap().push((report.unfinished_now, report.cleanup)));
    let (entered, answer) = (Barrier::new(2), Barrier::new(2));
    std::thread::scope(|threads| {
        let call = threads.spawn(|| {
            let admitted = scope.admit(Boundary::HandOver).unwrap();
            entered.wait();
            answer.wait();
            drop(admitted);
            scope.admit(Boundary::Local).map(drop)
        });
        entered.wait();
        assert_eq!(scope.revoke().unfinished, 1, "closure returned with the call unfinished");
        assert!(scope.release_held());
        assert_eq!(scope.report().cleanup, Cleanup::Pending);
        answer.wait();
        assert_eq!(call.join().unwrap(), Err(REVOKED.to_string()), "its continuation");
    });
    assert_eq!(*reports.lock().unwrap(), [(0, Cleanup::Complete)]);
    assert_eq!(scope.report().json()["unfinished_at_closure"], json!(1));
}

/// A receipt redeems once, only at the port and epoch that took it; a forged one is refused.
#[test]
fn forged_reused_and_cross_scope_receipts_are_refused() {
    let (ledger, other) = (Ledger::new(7), Ledger::new(7));
    let receipt = ledger.record("a");
    assert_eq!(other.redeem(&receipt), Err(NOT_OWNED.into()), "another executor");
    let stale = Receipt { epoch: 6, ..receipt.clone() };
    assert_eq!(ledger.redeem(&stale), Err(NOT_OWNED.into()), "another epoch");
    let forged = Receipt { id: receipt.id + 100, ..receipt.clone() };
    assert_eq!(ledger.redeem(&forged), Err(NOT_OWNED.into()), "forged");
    assert_eq!(ledger.redeem(&receipt), Ok(receipt.clone()));
    assert_eq!(ledger.redeem(&receipt), Err(NOT_OWNED.into()), "a double release");
}

/// A pending hold asked to be released (by the revocation, then by a caller) completes applied: its compensation follows once,
/// and the caller's release consumed nothing. Not applied: retired. Uncertain: an unconfirmed obligation.
#[test]
fn a_pending_hold_is_compensated_once_after_it_completes() {
    let ledger = Ledger::new(1);
    let ticket = ledger.begin("bit");
    assert!(ledger.drain().is_empty());
    assert_eq!(ledger.take(|hold| *hold == "bit"), Owned::Drained, "marked, not consumed");
    assert_eq!(ledger.cleanup(), Cleanup::Pending);
    let Settled::Compensate(receipt) = ledger.settle(ticket, Outcome::Applied) else { panic!("compensation expected") };
    ledger.compensated(receipt, true);
    assert_eq!(ledger.take(|hold| *hold == "bit"), Owned::Drained, "already let go of");
    assert_eq!(ledger.take(|hold| *hold == "bit"), Owned::None, "never twice");
    assert_eq!(ledger.cleanup(), Cleanup::Complete);
    let retired = ledger.begin("x");
    assert_eq!(ledger.settle(retired, Outcome::NotApplied), Settled::Done);
    let open = ledger.begin("y");
    assert_eq!(ledger.settle(open, Outcome::Applied), Settled::Done);
    assert_eq!(ledger.holds(), ["y"]);
    let uncertain = ledger.begin("z");
    ledger.drain();
    assert!(matches!(ledger.settle(uncertain, Outcome::Uncertain), Settled::Compensate(_)));
    assert_eq!(ledger.cleanup(), Cleanup::Unconfirmed);
}

#[test]
fn a_cleanup_never_sees_a_settling_hold_in_neither_state() {
    let held_first = Ledger::new(1);
    let ticket = held_first.begin("bit");
    assert_eq!(held_first.settle(ticket, Outcome::Applied), Settled::Done);
    let drained = held_first.drain();
    assert_eq!(drained.iter().map(|receipt| receipt.hold).collect::<Vec<_>>(), ["bit"]);
    assert_eq!(held_first.cleanup(), Cleanup::Pending, "releasing until its release returned");
    held_first.drained(drained.into_iter().next().unwrap());
    assert_eq!(held_first.cleanup(), Cleanup::Complete);

    let drained_first = Ledger::new(1);
    let ticket = drained_first.begin("bit");
    assert!(drained_first.drain().is_empty());
    assert_eq!(drained_first.cleanup(), Cleanup::Pending);
    let Settled::Compensate(receipt) = drained_first.settle(ticket, Outcome::Applied) else { panic!("compensation expected") };
    assert_eq!(drained_first.cleanup(), Cleanup::Pending, "still accounted while its compensation runs");
    drained_first.compensated(receipt, true);
    assert_eq!(drained_first.cleanup(), Cleanup::Complete);

    // Racing threads, many times: the drain lands at either side of the settle, never inside it.
    for _ in 0..200 {
        let ledger = Ledger::new(1);
        let ticket = ledger.begin("bit");
        let start = Barrier::new(2);
        let (settled, drained) = std::thread::scope(|threads| {
            let settling = threads.spawn(|| {
                start.wait();
                ledger.settle(ticket, Outcome::Applied)
            });
            start.wait();
            let drained = ledger.drain();
            (settling.join().unwrap(), drained)
        });
        let compensated = matches!(settled, Settled::Compensate(_));
        assert!(compensated ^ (drained.len() == 1), "released exactly once: compensated {compensated}, drained {}", drained.len());
    }
}

/// A failed compensation is an unconfirmed cleanup, never a complete one.
#[test]
fn a_failed_compensation_is_unconfirmed() {
    let ledger = Ledger::new(1);
    let ticket = ledger.begin("bit");
    ledger.drain();
    let Settled::Compensate(receipt) = ledger.settle(ticket, Outcome::Applied) else { panic!("compensation expected") };
    ledger.compensated(receipt, false);
    assert_eq!(ledger.cleanup(), Cleanup::Unconfirmed);
}

/// An endpoint whose closure the test holds: the closing revoker is paused inside its closing transition.
struct Slow {
    entered: Barrier,
    resume: Barrier,
}

impl Endpoint for Slow {
    fn close(&self) -> usize {
        self.entered.wait();
        self.resume.wait();
        0
    }
    fn cleanup(&self) -> Cleanup {
        Cleanup::Complete
    }
}

/// Two revokers with a call finishing between them: the snapshot is the closing transition's own (one unfinished call),
/// stored in the same step; the second revoker reads it and never stores a zero of its own.
#[test]
fn two_revokers_with_a_call_finishing_between_keep_the_closers_snapshot() {
    let scope = Scope::open(5);
    let slow = Arc::new(Slow { entered: Barrier::new(2), resume: Barrier::new(2) });
    assert!(scope.fence(slow.clone()));
    let call = scope.admit(Boundary::HandOver).unwrap();
    std::thread::scope(|threads| {
        let first = threads.spawn(|| scope.revoke());
        slow.entered.wait();
        // The closing `fetch_or` has run: the call finishes now, before the closer stored its snapshot (on a thread of its own:
        // its report then waits for the closer's critical section).
        let finishing = threads.spawn(move || drop(call));
        while word::unfinished(scope.0.word.word().load(Ordering::SeqCst)) != 0 {
            std::thread::yield_now();
        }
        let second = threads.spawn(|| scope.revoke());
        slow.resume.wait();
        assert_eq!(first.join().unwrap().unfinished, 1);
        assert_eq!(second.join().unwrap().unfinished, 1, "the closer's snapshot, not a zero taken after the call finished");
        finishing.join().unwrap();
    });
    assert_eq!(scope.report().closure.unfinished, 1);
}

/// A report is one observation: a compensation failing on another thread (its entry removed and its failure counted in one
/// critical section) is read either before (pending) or after (unconfirmed), never as complete.
#[test]
fn a_failing_compensation_is_never_read_as_complete() {
    for _ in 0..200 {
        let ledger = Ledger::new(1);
        let ticket = ledger.begin("bit");
        ledger.drain();
        let Settled::Compensate(receipt) = ledger.settle(ticket, Outcome::Applied) else { panic!("compensation expected") };
        let start = Barrier::new(2);
        let read = std::thread::scope(|threads| {
            let failing = threads.spawn(|| {
                start.wait();
                ledger.compensated(receipt, false);
            });
            start.wait();
            let read = ledger.cleanup();
            failing.join().unwrap();
            read
        });
        assert_ne!(read, Cleanup::Complete);
        assert_eq!(ledger.cleanup(), Cleanup::Unconfirmed);
    }
}
