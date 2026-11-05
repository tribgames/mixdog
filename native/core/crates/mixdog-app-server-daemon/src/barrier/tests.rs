#![allow(clippy::disallowed_methods, reason = "test setup on temp data dirs")]

use std::path::PathBuf;

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

fn steps_of(gate: &mut crate::verdict::Gate) -> (GateStep, Vec<InstallStep>) {
    let mut steps = Vec::new();
    let result = gate
        .step_observed(&mut |step| steps.push(step))
        .expect("step");
    (result, steps)
}

const ALL_STEPS: [InstallStep; 4] = [
    InstallStep::ClaimLockTaken,
    InstallStep::RecordRechecked,
    InstallStep::RecordWritten,
    InstallStep::BarrierInstalled,
];

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
    assert!(steps.is_empty());
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
fn record_changed_after_the_verdict_sends_it_around_again() {
    let temp = TempData::new();
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    let data = temp.data();
    let mut steps = Vec::new();
    let mut raced = false;
    let result = gate
        .step_observed(&mut |step| {
            steps.push(step);
            if step == InstallStep::ClaimLockTaken && !raced {
                raced = true;
                std::fs::write(
                    data.join(RECORD_FILE),
                    b"{\"kind\":\"mixdog-daemon\",\"pid\":77}\n",
                )
                .unwrap();
            }
        })
        .unwrap();
    assert!(matches!(result, GateStep::Clear));
    assert_eq!(steps[0], InstallStep::ClaimLockTaken);
    assert_eq!(&steps[1..], ALL_STEPS);
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
