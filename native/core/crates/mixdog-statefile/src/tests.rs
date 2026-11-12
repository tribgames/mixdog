use std::time::Duration;
use std::time::Instant;

use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use serde_json::json;

use crate::*;

/// Runs `job` as a durability-lane job (the inline test backend runs it on this thread).
pub(crate) fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
        lanes.durability_io.submit(&CancellationToken::new(), job).unwrap().await.unwrap()
    })
}

#[test]
fn a_quarantine_name_never_overwrites_a_kept_copy() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    mixdog_testkit::write(dir.path().join("f.json.corrupt-5"), "");
    mixdog_testkit::write(dir.path().join("f.json.corrupt-6"), "");
    assert_eq!(crate::json::quarantine_path_from(&mixdog_fsio::Unlaned, &file, 5), dir.path().join("f.json.corrupt-7"));
    assert_eq!(crate::json::quarantine_path_from(&mixdog_fsio::Unlaned, &file, 9), dir.path().join("f.json.corrupt-9"));
}

fn within(timeout: Duration) -> LockOpts {
    LockOpts { timeout: Some(timeout), ..LockOpts::default() }
}

/// A lock another live process holds, in the record Node writes.
fn hold_like_node(file: &std::path::Path) {
    mixdog_testkit::write(lock_path(file), format!("{} {} other-token\n", std::process::id(), 1));
}

/// `withFileLockSync` has one deadline from the call: a request behind a holder of this process times out at it, not
/// after the holder lets go (the line has no deadline of its own for the async lock).
#[test]
fn a_request_waiting_in_the_line_times_out_at_its_one_deadline() {
    const ANSWER_DEADLINE: Duration = Duration::from_secs(20);
    let dir = tempfile::tempdir().unwrap();
    let lock = lock_path(&dir.path().join("f.json"));
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let holder = hold_lock(&lock, &LockOpts::default(), move |outcome| held_tx.send(outcome).unwrap());
    held_rx.recv_timeout(ANSWER_DEADLINE).expect("the holder to take the lock").unwrap();
    let (late_tx, late_rx) = std::sync::mpsc::channel();
    let _late = hold_lock_one_deadline(&lock, &within(Duration::from_millis(100)), move |outcome| late_tx.send(outcome).unwrap());
    let outcome = late_rx.recv_timeout(ANSWER_DEADLINE).expect("the request behind the holder to be answered while the holder still holds");
    assert!(matches!(outcome, Err(LockError::Timeout { .. })), "{outcome:?}");
    drop(holder);
    let (again_tx, again_rx) = std::sync::mpsc::channel();
    let _again = hold_lock_one_deadline(&lock, &within(Duration::from_secs(5)), move |outcome| again_tx.send(outcome).unwrap());
    again_rx.recv_timeout(ANSWER_DEADLINE).expect("the line to pass on after an abandoned ticket").unwrap();
}

#[test]
fn a_held_lock_times_out_with_nodes_codes_and_is_free_afterwards() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    hold_like_node(&file);

    let started = Instant::now();
    let busy = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &within(Duration::from_millis(150)), || ()).unwrap_err()
    });
    assert_eq!(busy.code(), Some("ELOCKTIMEOUT"));
    assert!(started.elapsed() >= Duration::from_millis(150));
    assert!(busy.to_string().contains("holder pid="), "{busy}");
    let once = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &within(Duration::ZERO), || ()).unwrap_err()
    });
    assert_eq!(once.code(), Some("ELOCKCONTENDED"));

    mixdog_testkit::remove_file(lock_path(&file));
    let taken = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &within(Duration::ZERO), || 7).unwrap()
    });
    assert_eq!(taken, 7);
    assert!(!mixdog_testkit::exists(lock_path(&file)), "released: the lock file is unlinked as Node's is");
}

#[test]
fn a_lock_of_a_dead_owner_is_reclaimed_and_a_live_one_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    mixdog_testkit::write(lock_path(&file), format!("{} 1 tok\n", mixdog_testkit::dead_pid()));
    let got = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &within(Duration::ZERO), || 1).unwrap()
    });
    assert_eq!(got, 1);

    // No owner record: reclaimable only once older than the stale window.
    mixdog_testkit::write(lock_path(&file), "");
    let young = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &within(Duration::ZERO), || ()).unwrap_err()
    });
    assert_eq!(young.code(), Some("ELOCKCONTENDED"));
    let strict = LockOpts { timeout: Some(Duration::ZERO), stale: Some(Duration::ZERO), strict_owner: true };
    assert!(on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &strict, || ()).is_err()
    }));
    let stale = LockOpts { timeout: Some(Duration::ZERO), stale: Some(Duration::ZERO), strict_owner: false };
    on_lane(move |lane| with_lock(lane, &file, &stale, || ()).unwrap());
}

#[test]
fn a_nested_request_for_a_held_lock_does_not_wait_on_itself() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let inner = on_lane(move |lane| {
        with_lock(lane, &file, &within(Duration::from_secs(5)), || {
            with_lock(lane, &file, &within(Duration::ZERO), || 3).unwrap()
        })
        .unwrap()
    });
    assert_eq!(inner, 3);
}

#[test]
fn a_panicking_body_still_releases_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let panicked = std::thread::spawn({
        let file = file.clone();
        move || on_lane(move |lane| with_lock(lane, &file, &within(Duration::ZERO), || -> () { panic!("body") }))
    })
    .join();
    assert!(panicked.is_err());
    assert!(!mixdog_testkit::exists(lock_path(&file)));
}

/// Node (`file-lock.mjs`) and this port take the same lock file, so each excludes the other.
#[test]
fn node_and_this_port_exclude_each_other() {
    use std::io::BufRead;

    let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src/runtime/shared/file-lock.mjs");
    let url = format!("file:///{}", mixdog_testkit::canonical(&module).display().to_string().trim_start_matches(r"\\?\").replace('\\', "/"));
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let lock = lock_path(&file);
    let holder = dir.path().join("hold.mjs");
    mixdog_testkit::write(
        &holder,
        format!(
            "import {{ withFileLockSync }} from '{url}';\n\
             withFileLockSync(process.argv[2], () => {{ console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); }});\n"
        ),
    );
    let taker = dir.path().join("take.mjs");
    mixdog_testkit::write(
        &taker,
        format!(
            "import {{ withFileLockSync }} from '{url}';\n\
             try {{ withFileLockSync(process.argv[2], () => console.log('took'), {{ timeoutMs: 0 }}); }} catch (e) {{ console.log(e.code); }}\n"
        ),
    );

    // Node holds, this port is refused.
    let mut node = mixdog_testkit::spawn_piped("node", &[holder.as_os_str(), lock.as_os_str()]);
    let mut line = String::new();
    std::io::BufReader::new(node.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "held");
    let refused = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, &within(Duration::ZERO), || ()).unwrap_err()
    });
    assert_eq!(refused.code(), Some("ELOCKCONTENDED"));
    node.wait().unwrap();

    // This port holds, Node is refused; after release Node takes it.
    let outside = on_lane({
        let (file, taker) = (file.clone(), taker.clone());
        move |lane| {
            with_lock(lane, &file, &within(Duration::from_secs(5)), || {
                mixdog_testkit::output("node", &[taker.as_os_str(), lock_path(&file).as_os_str()])
            })
            .unwrap()
        }
    });
    assert_eq!(outside.trim(), "ELOCKCONTENDED");
    assert_eq!(mixdog_testkit::output("node", &[taker.as_os_str(), lock.as_os_str()]).trim(), "took");
}

#[test]
fn recovery_restores_with_a_flush_whatever_the_callers_fsync_choice() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    mixdog_testkit::write(&file, "{\"a\":");
    mixdog_testkit::write(dir.path().join("f.json.bak"), "{\"a\":1}\n");
    crate::trace::take();
    let restored = on_lane({
        let file = file.clone();
        move |lane| read_json(lane, &file, None, &Opts { fsync: false, ..Opts::default() }).unwrap()
    });
    assert_eq!(restored, Some(json!({ "a": 1 })));
    let trace = crate::trace::take();
    let create = trace.iter().position(|e| e.starts_with("create f.json.mixdog-tmp-")).expect("restore wrote a temp");
    assert!(trace[create + 1].starts_with("fsync f.json.mixdog-tmp-"), "{trace:?}");
    assert_eq!(mixdog_testkit::read_string(&file), "{\"a\":1}\n");
}

#[test]
fn valid_node_json_is_never_taken_for_damage() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let deep = format!("{{\"n\":1e400,\"d\":{}0{},\"s\":\"x\\ud83d\"}}", "[".repeat(5000), "]".repeat(5000));
    mixdog_testkit::write(&file, &deep);
    let read = on_lane({
        let file = file.clone();
        move |lane| read_json(lane, &file, None, &Opts::default()).unwrap().unwrap()
    });
    assert_eq!(read["n"], serde_json::Value::Null);
    assert_eq!(mixdog_testkit::entry_names(dir.path()).len(), 1, "nothing quarantined or restored");

    // A rewrite is what Node writes: the lone surrogate stays its escape.
    let small = dir.path().join("g.json");
    mixdog_testkit::write(&small, "{\"s\":\"x\\ud83d\",\"big\":12345678901234567890}");
    on_lane({
        let small = small.clone();
        move |lane| {
            update_json::<_, ()>(lane, &small, Ok, &Opts::default()).unwrap();
            update_json::<_, ()>(lane, &small, |cur| Ok(cur.map(|v| json!({ "again": v }))), &Opts::default()).unwrap();
        }
    });
    assert_eq!(
        mixdog_testkit::read_string(&small),
        "{\n  \"again\": {\n    \"s\": \"x\\ud83d\",\n    \"big\": 12345678901234567000\n  }\n}\n"
    );
}

#[test]
fn private_directories_are_created_owner_only_with_their_ancestors() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("a").join("b").join("c");
    let (inner_ok, outer_ok) = on_lane({
        let nested = nested.clone();
        move |lane| {
            create_private_dir_all(lane, &nested).unwrap();
            create_private_dir_all(lane, &nested).unwrap();
            (is_owner_only(lane, &nested).unwrap(), is_owner_only(lane, nested.parent().unwrap().parent().unwrap()).unwrap())
        }
    });
    assert!(inner_ok && outer_ok);
    assert!(mixdog_testkit::is_dir(&nested));
}

#[test]
fn concurrent_updates_through_the_lock_lose_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("count.json");
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let file = file.clone();
            std::thread::spawn(move || {
                for _ in 0..10 {
                    let file = file.clone();
                    on_lane(move |lane| {
                        let opts = Opts::default();
                        update_json::<_, ()>(
                            lane,
                            &file,
                            |cur| {
                                let n = cur.and_then(|v| v["n"].as_u64()).unwrap_or(0);
                                Ok(Some(json!({ "n": n + 1 })))
                            },
                            &opts,
                        )
                        .unwrap();
                    });
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let stored: serde_json::Value = serde_json::from_slice(&mixdog_testkit::read(&file)).unwrap();
    assert_eq!(stored["n"], 80);
}

#[test]
fn threads_that_release_and_ask_again_cannot_starve_the_others() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let file = file.clone();
            std::thread::spawn(move || {
                for _ in 0..40 {
                    let file = file.clone();
                    // The default wait (2 s) is enough for a fair line; a lock polled by every
                    // thread lets the releasing thread win again and again.
                    on_lane(move |lane| {
                        with_lock(lane, &file, &LockOpts::default(), || mixdog_fsio::sleep(lane, Duration::from_millis(5))).unwrap();
                    });
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
}

/// A wait in the line of this process spends none of the request's budget: the budget is for the
/// file (Node's `lockQueue` waits without a deadline and `acquireLock` starts its clock at the
/// front), so a request that queues behind a live holder takes the free lock when its turn comes,
/// however long the holder kept it. A budget of one nanosecond is spent before the request is
/// queued, which is every budget once the holder has held long enough.
#[test]
fn waiting_in_line_behind_a_live_holder_spends_none_of_the_budget() {
    use std::sync::mpsc::channel;

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let (held_tx, held_rx) = channel();
    let (release_tx, release_rx) = channel::<()>();
    let holder = std::thread::spawn({
        let file = file.clone();
        move || {
            on_lane(move |lane| {
                with_lock(lane, &file, &LockOpts::default(), || {
                    held_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .unwrap();
            })
        }
    });
    held_rx.recv().unwrap();

    let (queued_tx, queued_rx) = channel();
    let waiter = std::thread::spawn({
        let file = file.clone();
        move || {
            crate::trace::on_queued(move || queued_tx.send(()).unwrap());
            on_lane(move |lane| with_lock(lane, &file, &within(Duration::from_nanos(1)), || 7))
        }
    });
    queued_rx.recv().unwrap();
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(waiter.join().unwrap().unwrap(), 7);
}

#[test]
fn a_file_that_cannot_be_read_is_an_error_not_an_empty_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.json");
    mixdog_testkit::create_dir(&path);
    let result = on_lane(move |lane| read_json(lane, &path, None, &Opts::default()));
    assert!(result.is_err());
}

#[test]
fn a_secret_write_is_owner_only_and_leaves_no_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.json");
    let opts = Opts { secret: true, ..Opts::default() };
    let written = on_lane({
        let path = path.clone();
        move |lane| write_json(lane, &path, &json!({ "k": 1 }), &opts).unwrap()
    });
    assert_eq!(written, Published::Written);
    assert!(on_lane({
        let path = path.clone();
        move |lane| is_owner_only(lane, &path).unwrap()
    }));
    assert_eq!(mixdog_testkit::entry_names(dir.path()).len(), 1);
}

#[test]
fn a_failed_write_removes_its_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    // The target is a non-empty directory: the rename cannot replace it.
    let path = dir.path().join("f.json");
    mixdog_testkit::create_dir(&path);
    mixdog_testkit::write(path.join("inner"), "x");
    let failed = on_lane({
        let path = path.clone();
        move |lane| write_file(lane, &path, b"x", &Opts::default()).is_err()
    });
    assert!(failed);
    let names = mixdog_testkit::entry_names(dir.path());
    assert_eq!(names, vec![std::ffi::OsString::from("f.json")]);
}

#[test]
fn rename_retries_follow_nodes_schedule_and_skip_read_only_targets() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("t");
    mixdog_testkit::write(&target, "x");
    #[cfg(unix)]
    let denied = std::io::Error::from_raw_os_error(libc::EACCES);
    #[cfg(windows)]
    let denied = std::io::Error::from_raw_os_error(5);

    let first = crate::publish::next_rename_delay(&mixdog_fsio::Unlaned, &denied, 0, &target).unwrap();
    assert!((25..50).contains(&(first.as_millis() as u64)), "{first:?}");
    let late = crate::publish::next_rename_delay(&mixdog_fsio::Unlaned, &denied, 22, &target).unwrap();
    assert!((200..250).contains(&(late.as_millis() as u64)), "{late:?}");
    assert!(crate::publish::next_rename_delay(&mixdog_fsio::Unlaned, &denied, 23, &target).is_none());
    assert!(crate::publish::next_rename_delay(&mixdog_fsio::Unlaned, &std::io::Error::from(std::io::ErrorKind::NotFound), 0, &target).is_none());

    mixdog_testkit::set_readonly(&target, true);
    assert!(crate::publish::next_rename_delay(&mixdog_fsio::Unlaned, &denied, 0, &target).is_none());
    mixdog_testkit::set_readonly(&target, false);
}

#[test]
fn only_nul_and_blanks_hold_no_data() {
    assert!(holds_no_data(b""));
    assert!(holds_no_data(b"\0 \t\r\n\0"));
    assert!(!holds_no_data(b"\0{\0"));
    assert!(!holds_no_data("\u{a0}".as_bytes()));
}

#[test]
fn a_recovery_stamps_the_fixed_clock_and_the_next_name_is_taken_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.json");
    let recover = |file: std::path::PathBuf| {
        on_lane(move |lane| read_json(lane, &file, None, &Opts { fsync: false, keep_without_backup: false, ..Opts::default() }).unwrap())
    };
    {
        let _clock = fix_recovery_clock(1_700_000_000_000);
        mixdog_testkit::write(&file, "{ torn");
        assert_eq!(recover(file.clone()), None, "no good copy: starting empty");
        assert_eq!(mixdog_testkit::read_string(dir.path().join("f.json.corrupt-1700000000000")), "{ torn");
        // The same millisecond again: the kept copy stays, the new one takes the next stamp.
        mixdog_testkit::write(&file, "{ torn twice");
        assert_eq!(recover(file.clone()), None);
        assert_eq!(mixdog_testkit::read_string(dir.path().join("f.json.corrupt-1700000000000")), "{ torn");
        assert_eq!(mixdog_testkit::read_string(dir.path().join("f.json.corrupt-1700000000001")), "{ torn twice");
    }
    // Released: the wall clock stamps again, far from the fixed instant.
    mixdog_testkit::write(&file, "{ torn later");
    recover(file);
    let stamps: Vec<u128> = mixdog_testkit::entry_names(dir.path())
        .into_iter()
        .filter_map(|entry| entry.to_string_lossy().strip_prefix("f.json.corrupt-").and_then(|s| s.parse().ok()))
        .collect();
    assert_eq!(stamps.len(), 3);
    assert!(stamps.iter().any(|stamp| *stamp > 1_700_000_000_001), "{stamps:?}");
}

#[test]
fn set_readonly_sets_and_clears_the_attribute_and_a_missing_file_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("t");
    mixdog_testkit::write(&target, "x");
    let readonly = || mixdog_testkit::is_readonly(&target);
    on_lane({
        let target = target.clone();
        move |lane| set_readonly(lane, &target, true).unwrap()
    });
    assert!(readonly());
    assert!(on_lane({
        let target = target.clone();
        move |lane| mixdog_fsio::write(lane, &target, "y").is_err()
    }));
    on_lane({
        let target = target.clone();
        move |lane| set_readonly(lane, &target, false).unwrap()
    });
    assert!(!readonly());
    mixdog_testkit::write(&target, "y");
    let missing = dir.path().join("absent");
    let error = on_lane(move |lane| set_readonly(lane, &missing, true).unwrap_err());
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn symlink_metadata_reports_the_entry_and_not_what_a_link_leads_to() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.txt");
    mixdog_testkit::write(&file, "x");
    let missing = dir.path().join("none");
    #[cfg(unix)]
    let link = {
        let link = dir.path().join("link");
        mixdog_testkit::symlink_file(&file, &link);
        link
    };
    let (file_kind, missing_kind, followed) = on_lane({
        let (file, missing) = (file.clone(), missing.clone());
        move |lane| {
            let own = symlink_metadata(lane, &file).unwrap();
            let gone = symlink_metadata(lane, &missing).unwrap_err().kind();
            #[cfg(unix)]
            let followed = (symlink_metadata(lane, &link).unwrap().is_symlink(), metadata(lane, &link).unwrap().is_symlink());
            #[cfg(not(unix))]
            let followed = (false, false);
            ((own.is_file(), own.is_symlink()), gone, followed)
        }
    });
    assert_eq!(file_kind, (true, false));
    assert_eq!(missing_kind, std::io::ErrorKind::NotFound);
    #[cfg(unix)]
    assert_eq!(followed, (true, false), "the link itself is reported, while `metadata` follows it");
    #[cfg(not(unix))]
    assert_eq!(followed, (false, false));
}

/// A damaged state file writes the line `reportDamaged` writes to stderr, byte for byte as a real Node run wrote it
/// (`node-stderr/lines.json`, `stateDamaged`).
#[test]
fn a_damaged_file_writes_the_line_node_wrote() {
    let recorded: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/node-stderr/lines.json")).unwrap();
    let _clock = fix_recovery_clock(recorded["stamp"].as_u64().unwrap().into());
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    mixdog_testkit::write(&file, "{\"a\":");
    let lines = on_lane({
        let file = file.clone();
        move |lane| {
            let (lines, _guard) = mixdog_rt::node_log::capture();
            read_json(lane, &file, None, &Opts { fsync: false, ..Opts::default() }).unwrap();
            let got: Vec<String> = lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
            got
        }
    });
    let stamp = recorded["stamp"].to_string();
    let want: Vec<String> = recorded["sites"]["stateDamaged"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line.as_str().unwrap().strip_suffix('\n').unwrap().replace("<DIR>", &dir.path().display().to_string()).replace("<STAMP>", &stamp))
        .collect();
    assert_eq!(lines, want);
}
