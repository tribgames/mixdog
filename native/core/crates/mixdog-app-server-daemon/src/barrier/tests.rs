#![allow(clippy::disallowed_methods, reason = "test setup on temp data dirs")]

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use mixdog_core_api::domain::ownership::Ownership;

use super::*;
use crate::verdict::BlockedKind;
use crate::verdict::GateError;
use crate::verdict::GateStep;
use crate::verdict::OsProcessTable;
use crate::verdict::tests::FakeTable;
use crate::verdict::tests::TempData;
use crate::verdict::tests::idle_child_process;
use crate::verdict::tests::record;

// ---------------------------------------------------------------------------
// The test-only step hook (`super::hook` in test builds)
// ---------------------------------------------------------------------------

type StepHook = Box<dyn FnMut(Step)>;

thread_local! {
    static HOOK: RefCell<Option<StepHook>> = const { RefCell::new(None) };
}

/// Runs this thread's hook at `step`, if one is set.
pub(crate) fn hook(step: Step) {
    let taken = HOOK.with(|hook| hook.borrow_mut().take());
    if let Some(mut f) = taken {
        f(step);
        HOOK.with(|hook| *hook.borrow_mut() = Some(f));
    }
}

/// Clears this thread's hook when dropped (libtest may run tests on one thread).
pub(crate) struct HookGuard;

impl Drop for HookGuard {
    fn drop(&mut self) {
        HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

/// Sets this thread's hook until the guard drops.
pub(crate) fn set_hook(f: impl FnMut(Step) + 'static) -> HookGuard {
    HOOK.with(|hook| *hook.borrow_mut() = Some(Box::new(f)));
    HookGuard
}

/// The steps one [`Gate::step`] passes, with `at` run at each.
fn steps_with(
    gate: &mut crate::verdict::Gate,
    mut at: impl FnMut(Step) + 'static,
) -> (GateStep, Vec<Step>) {
    let steps = Rc::new(RefCell::new(Vec::new()));
    let sink = steps.clone();
    let guard = set_hook(move |step| {
        sink.borrow_mut().push(step);
        at(step);
    });
    let result = gate.step().expect("step");
    drop(guard);
    let steps = steps.borrow().clone();
    (result, steps)
}

fn steps_of(gate: &mut crate::verdict::Gate) -> (GateStep, Vec<Step>) {
    steps_with(gate, |_| {})
}

const ALL_STEPS: [Step; 6] = [
    Step::Judged,
    Step::Linking,
    Step::Held,
    Step::ClaimLockTaken,
    Step::RecordWritten,
    Step::BarrierInstalled,
];

const CONFLICT: [Step; 4] = [Step::Judged, Step::Linking, Step::Held, Step::Conflict];

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/lifecycle/barrier")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn barrier_and_record_bytes_match_the_tag_tested_fixture() {
    assert_eq!(barrier_bytes("fixture-instance"), fixture(CLAIM_LOCK_FILE));
    assert_eq!(record().to_bytes(), fixture(RECORD_FILE));
    assert_eq!(
        ClaimLock::parse(fixture(CLAIM_LOCK_FILE)),
        ClaimLock::Barrier
    );
}

#[test]
fn claim_lock_reads_like_read_lock_owner() {
    let owner = |text: &str| match ClaimLock::parse(text.as_bytes().to_vec()) {
        ClaimLock::Held(owner) => (owner.pid, owner.acquired_ms),
        other => panic!("{other:?}"),
    };
    assert_eq!(owner("123 456 abc\n"), (Some(123), Some(456)));
    assert_eq!(owner("  77abc 9"), (Some(77), Some(9)));
    assert_eq!(owner("-5 1 t"), (None, Some(1)));
    assert_eq!(owner(""), (None, None));
    assert_eq!(owner(r#"{"pid":31,"startedAt":5}"#), (Some(31), None));
    assert_eq!(owner("{not json"), (None, None));
    // The barrier pid without the barrier token is an ordinary (dead) holder.
    assert_eq!(
        owner("4294967296 0 someone-else"),
        (Some(4_294_967_296), Some(0))
    );
}

#[test]
fn fresh_data_dir_gets_barrier_and_record() {
    let temp = TempData::new();
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let (result, steps) = steps_of(&mut gate);
    assert!(matches!(result, GateStep::Clear));
    assert_eq!(steps, ALL_STEPS);
    assert_eq!(
        temp.file(CLAIM_LOCK_FILE).unwrap(),
        barrier_bytes(own.instance_id())
    );
    assert_eq!(temp.file(RECORD_FILE).unwrap(), record().to_bytes());
    assert!(temp.file(BARRIER_STAGING_FILE).is_none() && temp.file(RECORD_STAGING_FILE).is_none());
    assert_eq!(own.revalidate(), Ok(()));
}

#[test]
fn installed_barrier_is_kept_and_the_record_never_rewritten() {
    let temp = TempData::new();
    temp.write(CLAIM_LOCK_FILE, &barrier_bytes("earlier-core"));
    temp.write(
        RECORD_FILE,
        b"{\"kind\":\"mixdog-daemon\",\"pid\":\"older text\"}\n",
    );
    let (_own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let (result, steps) = steps_of(&mut gate);
    assert!(matches!(result, GateStep::Clear));
    assert!(steps.is_empty());
    assert_eq!(
        temp.file(CLAIM_LOCK_FILE).unwrap(),
        barrier_bytes("earlier-core")
    );
    assert_eq!(
        temp.file(RECORD_FILE).unwrap(),
        b"{\"kind\":\"mixdog-daemon\",\"pid\":\"older text\"}\n"
    );
}

#[test]
fn dead_holder_is_reclaimed_under_the_guard() {
    let temp = TempData::new();
    temp.write(CLAIM_LOCK_FILE, b"99991 1700000000000 0123456789abcdef\n");
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let (result, steps) = steps_of(&mut gate);
    assert!(matches!(result, GateStep::Clear));
    assert_eq!(steps, ALL_STEPS);
    assert_eq!(
        temp.file(CLAIM_LOCK_FILE).unwrap(),
        barrier_bytes(own.instance_id())
    );
    assert!(
        temp.file(RECLAIM_GUARD_FILE).is_none(),
        "the guard is released"
    );
}

#[test]
fn dead_reclaim_guard_is_revoked_and_live_one_waited_for() {
    let temp = TempData::new();
    temp.write(CLAIM_LOCK_FILE, b"99991 1700000000000 0123456789abcdef\n");
    // The gate watches a live holder's real OS exit, so it must be a real process.
    let (child, _) = idle_child_process(false);
    temp.write(
        RECLAIM_GUARD_FILE,
        format!("{} 1700000000000 fedcba9876543210\n", child.pid()).as_bytes(),
    );
    let (_own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let (result, steps) = steps_of(&mut gate);
    let GateStep::Blocked(blocked) = result else {
        panic!("expected blocked")
    };
    assert_eq!(
        (blocked.kind, blocked.process.identity.pid),
        (BlockedKind::WaitClaim, child.pid())
    );
    assert_eq!(steps, [Step::Judged, Step::Linking]);
    assert!(
        temp.file(RECLAIM_GUARD_FILE).is_some(),
        "a live guard is never revoked"
    );
    drop(gate);

    let temp = TempData::new();
    temp.write(CLAIM_LOCK_FILE, b"99991 1700000000000 0123456789abcdef\n");
    temp.write(
        RECLAIM_GUARD_FILE,
        b"99992 1700000000000 fedcba9876543210\n",
    );
    let (_own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let (result, _) = steps_of(&mut gate);
    assert!(matches!(result, GateStep::Clear));
    assert!(temp.file(RECLAIM_GUARD_FILE).is_none());
}

#[test]
fn the_record_is_reread_while_the_core_holds_the_claim_lock() {
    let temp = TempData::new();
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let data = temp.data();
    let held = Rc::new(RefCell::new(None));
    let sink = held.clone();
    let (result, steps) = steps_with(&mut gate, move |step| {
        if step == Step::Held {
            *sink.borrow_mut() = std::fs::read(data.join(CLAIM_LOCK_FILE)).ok();
        }
    });
    assert!(matches!(result, GateStep::Clear));
    assert_eq!(steps, ALL_STEPS);
    let held = String::from_utf8(held.take().expect("B read while held")).unwrap();
    let parts: Vec<&str> = held.split_whitespace().collect();
    assert_eq!(parts[0], std::process::id().to_string());
    assert_eq!(
        parts[2],
        format!("{CORE_TOKEN_PREFIX}{}", own.instance_id())
    );
}

/// `R` naming the live `child` and the port it listens on.
fn live_record(child: &crate::verdict::tests::SelfChild, port: Option<u16>) -> String {
    format!(
        r#"{{"kind":"mixdog-daemon","pid":{},"livenessPort":{}}}"#,
        child.pid(),
        port.unwrap()
    )
}

#[test]
fn a_live_owner_is_judged_without_touching_the_claim_lock() {
    let (child, port) = idle_child_process(true);
    let temp = TempData::new();
    let record = live_record(&child, port);
    temp.write(RECORD_FILE, record.as_bytes());
    let (_own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let (result, steps) = steps_of(&mut gate);
    let GateStep::Blocked(blocked) = result else {
        panic!("expected blocked")
    };
    assert_eq!(blocked.kind, BlockedKind::WaitExit);
    assert!(steps.is_empty(), "the owner's heartbeat needs B: {steps:?}");
    assert!(temp.file(CLAIM_LOCK_FILE).is_none());
    assert_eq!(temp.file(RECORD_FILE).unwrap(), record.as_bytes());
}

/// A gate whose hook writes `R` (or deletes it, for `None`) once, at `at`.
fn change_record_at(
    temp: &TempData,
    gate: &mut crate::verdict::Gate,
    at: Step,
    record: Option<String>,
) -> (GateStep, Vec<Step>) {
    let path = temp.data().join(RECORD_FILE);
    let mut once = Some(record);
    steps_with(gate, move |step| {
        if step == at
            && let Some(record) = once.take()
        {
            match record {
                Some(record) => std::fs::write(&path, record).unwrap(),
                None => std::fs::remove_file(&path).unwrap(),
            }
        }
    })
}

#[test]
fn a_claim_in_the_gap_gives_the_claim_lock_back_at_once() {
    let (child, port) = idle_child_process(true);
    let temp = TempData::new();
    let (_own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let record = live_record(&child, port);
    let (result, steps) = change_record_at(&temp, &mut gate, Step::Linking, Some(record.clone()));
    let GateStep::Blocked(blocked) = result else {
        panic!("expected blocked")
    };
    assert_eq!(
        (blocked.kind, blocked.process.identity.pid),
        (BlockedKind::WaitExit, child.pid())
    );
    assert_eq!(steps, CONFLICT);
    assert!(temp.file(CLAIM_LOCK_FILE).is_none());
    assert_eq!(temp.file(RECORD_FILE).unwrap(), record.as_bytes());
}

#[test]
fn a_claim_in_the_gap_before_a_reclaim_keeps_the_dead_holder_and_frees_the_guard() {
    let (child, port) = idle_child_process(true);
    let temp = TempData::new();
    let dead = b"99991 1700000000000 0123456789abcdef\n";
    temp.write(CLAIM_LOCK_FILE, dead);
    let (_own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let (result, steps) = change_record_at(
        &temp,
        &mut gate,
        Step::Linking,
        Some(live_record(&child, port)),
    );
    assert!(matches!(result, GateStep::Blocked(ref b) if b.kind == BlockedKind::WaitExit));
    assert_eq!(steps, CONFLICT);
    assert_eq!(temp.file(CLAIM_LOCK_FILE).unwrap(), dead);
    assert!(temp.file(RECLAIM_GUARD_FILE).is_none());
}

#[test]
fn a_claim_before_the_pre_link_read_never_takes_the_claim_lock() {
    let (child, port) = idle_child_process(true);
    let temp = TempData::new();
    let (_own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let (result, steps) = change_record_at(
        &temp,
        &mut gate,
        Step::Judged,
        Some(live_record(&child, port)),
    );
    assert!(matches!(result, GateStep::Blocked(ref b) if b.kind == BlockedKind::WaitExit));
    assert_eq!(steps, [Step::Judged]);
    assert!(temp.file(CLAIM_LOCK_FILE).is_none());
}

#[test]
fn a_record_deleted_in_the_gap_is_judged_again() {
    let temp = TempData::new();
    // A dead owner's record, which its (dead) writer cannot delete: the change
    // still sends the verdict around again.
    temp.write(
        RECORD_FILE,
        br#"{"kind":"mixdog-daemon","pid":99993,"livenessPort":9}"#,
    );
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let (result, steps) = change_record_at(&temp, &mut gate, Step::Linking, None);
    assert!(matches!(result, GateStep::Clear));
    assert_eq!(steps, [&CONFLICT[..], &ALL_STEPS[..]].concat());
    assert_eq!(
        temp.file(CLAIM_LOCK_FILE).unwrap(),
        barrier_bytes(own.instance_id())
    );
}

#[test]
fn legacy_lock_directories() {
    let temp = TempData::new();
    std::fs::create_dir_all(temp.data().join(CLAIM_LOCK_FILE)).unwrap();
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    assert!(matches!(gate.step().unwrap(), GateStep::Clear));
    assert_eq!(
        temp.file(CLAIM_LOCK_FILE).unwrap(),
        barrier_bytes(own.instance_id())
    );

    let temp = TempData::new();
    std::fs::create_dir_all(temp.data().join(CLAIM_LOCK_FILE).join("inner")).unwrap();
    let (_own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    assert!(matches!(gate.step(), Err(GateError::ClaimLockUnusable)));
}
