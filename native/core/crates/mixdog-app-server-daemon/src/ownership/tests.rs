#![allow(
    clippy::disallowed_methods,
    reason = "test setup: replaces data-dir entries under the owner"
)]

use std::sync::Arc;

#[cfg(unix)]
use mixdog_core_api::domain::ownership::FenceReason;
use mixdog_core_api::domain::ownership::Ownership;

use super::*;
use crate::barrier::CLAIM_LOCK_FILE;
use crate::verdict::GateStep;
use crate::verdict::tests::FakeTable;
use crate::verdict::tests::TempData;

#[test]
fn one_core_per_data_dir() {
    let temp = TempData::new();
    let first = acquire(&temp.data()).expect("first core");
    assert!(matches!(
        acquire(&temp.data()),
        Err(AcquireError::AlreadyOwned)
    ));
    assert_eq!(first.revalidate(), Ok(()));
    drop(first);
    let second = acquire(&temp.data()).expect("released with the handle");
    assert_ne!(second.instance_id(), "");
    assert!(
        temp.data().join(LOCK_FILE).is_file(),
        "the lock file is never deleted"
    );
}

/// Holds the data dir with the barrier installed and pinned.
#[cfg(unix)]
fn installed(temp: &TempData) -> Arc<CoreOwnership> {
    let (own, mut gate) = temp.gate(Box::new(FakeTable::default()));
    assert!(matches!(gate.step().unwrap(), GateStep::Clear));
    own
}

#[cfg(windows)]
#[test]
fn gate_8_windows_pins_the_lock_barrier_dir_and_ancestors() {
    let temp = TempData::new();
    let nested = temp.root.path().join("a").join("b");
    std::fs::create_dir_all(&nested).unwrap();
    let data = nested.join("data");
    let own = Arc::new(acquire(&data).unwrap());
    let mut gate = crate::verdict::tests::LaneGate::from(
        crate::verdict::Gate::with_table(
            own.clone(),
            temp.runtime().join("daemon.json"),
            crate::verdict::tests::record(),
            Box::new(FakeTable::default()),
        )
        .unwrap(),
    );
    assert!(matches!(gate.step().unwrap(), GateStep::Clear));

    let elsewhere = temp.root.path().join("moved");
    for path in [data.clone(), nested.clone(), temp.root.path().join("a")] {
        assert!(
            std::fs::rename(&path, &elsewhere).is_err(),
            "rename of {} must fail",
            path.display()
        );
    }
    for name in [LOCK_FILE, CLAIM_LOCK_FILE] {
        assert!(
            std::fs::remove_file(data.join(name)).is_err(),
            "delete of {name} must fail"
        );
        assert!(
            std::fs::rename(data.join(name), data.join("x")).is_err(),
            "rename of {name} must fail"
        );
    }
    assert_eq!(own.revalidate(), Ok(()));
}

#[cfg(unix)]
#[test]
fn conformance_lock_file_replaced() {
    let temp = TempData::new();
    let own = installed(&temp);
    mixdog_core_api::domain::conformance::check_ownership(&*own, || {
        std::fs::remove_file(temp.data().join(LOCK_FILE)).unwrap();
    });
    assert_eq!(own.revalidate(), Err(FenceReason::LockFileReplaced));
}

#[cfg(unix)]
#[test]
fn gate_8_unix_barrier_removed_fences() {
    let temp = TempData::new();
    let own = installed(&temp);
    std::fs::remove_file(temp.data().join(CLAIM_LOCK_FILE)).unwrap();
    assert_eq!(own.revalidate(), Err(FenceReason::BarrierRemoved));
    std::fs::write(temp.data().join(CLAIM_LOCK_FILE), b"restored\n").unwrap();
    assert_eq!(
        own.revalidate(),
        Err(FenceReason::BarrierRemoved),
        "fencing is sticky"
    );
}

#[cfg(unix)]
#[test]
fn gate_8_unix_renamed_data_dir_fences_and_new_core_works_in_a_new_inode() {
    use std::os::unix::fs::MetadataExt;
    let temp = TempData::new();
    let old = installed(&temp);
    let moved = temp.root.path().join("moved");
    std::fs::rename(temp.data(), &moved).unwrap();

    // A new core at the old path works in a different directory.
    let new = installed(&temp);
    assert_ne!(
        std::fs::metadata(temp.data()).unwrap().ino(),
        std::fs::metadata(&moved).unwrap().ino()
    );
    assert_eq!(new.revalidate(), Ok(()));
    // The old core's writes land only in the orphaned directory, and it fences.
    old.data_dir().create_new("old-core-write", b"x").unwrap();
    assert!(moved.join("old-core-write").is_file());
    assert!(!temp.data().join("old-core-write").exists());
    assert_eq!(old.revalidate(), Err(FenceReason::DataDirReplaced));
}
