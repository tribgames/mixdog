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

/// The lock between processes, replayed from `fixtures/owner-lock/golden.json` (Node's real `acquireDaemonOwnerLock` in real
/// child processes, recorded by benchmarks/rust-core/recorders/record-owner-lock.mjs). The contenders are this test binary run
/// again on `contender_child_process`; each ends when the test kills it, when its stdin closes (the parent is gone) or by itself.
#[allow(clippy::disallowed_types, reason = "the contenders are real child processes")]
mod across_processes {
    use std::io::BufRead as _;
    use std::io::BufReader;
    use std::io::Read as _;
    use std::path::Path;
    use std::process::Child;
    use std::process::ChildStdout;
    use std::process::Command;
    use std::process::Stdio;

    use serde_json::Value;
    use serde_json::json;

    use super::*;

    const CHILD_DIR: &str = "MIXDOG_OWNER_LOCK_CONTENDER_DATA_DIR";

    fn golden() -> Value {
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/owner-lock/golden.json")).unwrap()
    }

    /// The other process: tries the lock, says whether it got it and keeps whatever it got until stdin closes. Without
    /// `CHILD_DIR` (every normal run) it does nothing.
    #[test]
    fn contender_child_process() {
        let Some(dir) = std::env::var_os(CHILD_DIR) else { return };
        let owned = acquire(Path::new(&dir));
        println!("VERDICT {}", json!({ "held": owned.is_ok() }));
        std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
    }

    struct Contender {
        child: Child,
        out: BufReader<ChildStdout>,
    }

    impl Contender {
        fn start(data: &Path) -> Self {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "ownership::tests::across_processes::contender_child_process", "--nocapture"])
                .env(CHILD_DIR, data)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
            let mut child = command.spawn().unwrap();
            let out = BufReader::new(child.stdout.take().unwrap());
            Self { child, out }
        }

        /// What the contender answered: `{"held": bool}`.
        fn verdict(&mut self) -> Value {
            loop {
                let mut line = String::new();
                assert_ne!(self.out.read_line(&mut line).unwrap(), 0, "a contender ended before it answered");
                if let Some(answer) = line.strip_prefix("VERDICT ") {
                    return serde_json::from_str(answer).unwrap();
                }
            }
        }

        /// SIGKILL (`TerminateProcess` on Windows), the way the recording ended its holders.
        fn kill(mut self) {
            self.child.kill().unwrap();
            self.child.wait().unwrap();
        }
    }

    impl Drop for Contender {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn held(owned: &Result<CoreOwnership, AcquireError>) -> Value {
        json!({ "held": owned.is_ok() })
    }

    fn held_count(contenders: &mut [Contender]) -> usize {
        contenders.iter_mut().map(|c| c.verdict()["held"] == true).filter(|held| *held).count()
    }

    #[test]
    fn a_held_lock_refuses_every_other_process_and_a_killed_holder_frees_it_at_once() {
        let golden = &golden()["refuseAndKill"];
        let temp = TempData::new();
        let mut holder = Contender::start(&temp.data());
        assert_eq!(holder.verdict(), golden["holder"]);
        assert_eq!(held(&acquire(&temp.data())), golden["thisProcess"]);
        let mut second = Contender::start(&temp.data());
        assert_eq!(second.verdict(), golden["secondContender"]);
        holder.kill();
        // No stale period and no probe: the kernel released the lock with the process.
        assert_eq!(held(&acquire(&temp.data())), golden["afterKill"]);
    }

    #[test]
    fn the_holder_reading_its_own_lock_file_keeps_the_lock() {
        let golden = &golden()["holderReads"];
        let temp = TempData::new();
        let owned = acquire(&temp.data());
        assert_eq!(held(&owned), golden["holder"]);
        let owned = owned.unwrap();
        // A hosted Read tool opens, reads and closes any file of the data dir. (Windows refuses the read of a locked range.)
        let _ = std::fs::read(temp.data().join(LOCK_FILE));
        drop(std::fs::OpenOptions::new().read(true).write(true).open(temp.data().join(LOCK_FILE)).unwrap());
        assert_eq!(Contender::start(&temp.data()).verdict(), golden["contender"]);
        assert_eq!(owned.revalidate().is_ok(), golden["intact"]);
    }

    #[test]
    fn simultaneous_acquisitions_leave_exactly_one_holder() {
        let golden = &golden()["simultaneous"];
        let temp = TempData::new();
        let mut racers: Vec<Contender> = (0..golden["racers"].as_u64().unwrap()).map(|_| Contender::start(&temp.data())).collect();
        assert_eq!(held_count(&mut racers), golden["held"]);
    }

    #[test]
    fn racing_acquisitions_on_an_existing_lock_file_leave_exactly_one_holder() {
        let golden = &golden()["racingExisting"];
        let temp = TempData::new();
        std::fs::create_dir_all(temp.data()).unwrap();
        std::fs::write(temp.data().join(LOCK_FILE), "").unwrap();
        let mut racers: Vec<Contender> = (0..golden["racers"].as_u64().unwrap()).map(|_| Contender::start(&temp.data())).collect();
        assert_eq!(held_count(&mut racers), golden["held"]);
    }

    #[test]
    fn data_dirs_whose_lock_files_hold_equal_bytes_are_locked_independently() {
        let golden = &golden()["equalBytes"];
        for seed in ["empty", "copied"] {
            let (first, second) = (TempData::new(), TempData::new());
            if seed == "empty" {
                for temp in [&first, &second] {
                    std::fs::create_dir_all(temp.data()).unwrap();
                    std::fs::write(temp.data().join(LOCK_FILE), "").unwrap();
                }
            }
            let mut holder = Contender::start(&first.data());
            assert_eq!(holder.verdict(), golden[seed]["holder"], "{seed}");
            if seed == "copied" {
                std::fs::create_dir_all(second.data()).unwrap();
                std::fs::copy(first.data().join(LOCK_FILE), second.data().join(LOCK_FILE)).unwrap();
            }
            assert_eq!(held(&acquire(&second.data())), golden[seed]["otherDir"], "{seed}: the other data dir's holder does not block this one");
        }
    }
}

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
