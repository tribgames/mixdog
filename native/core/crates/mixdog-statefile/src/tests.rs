use std::fs;
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
    fs::write(dir.path().join("f.json.corrupt-5"), "").unwrap();
    fs::write(dir.path().join("f.json.corrupt-6"), "").unwrap();
    assert_eq!(crate::json::quarantine_path_from(&file, 5), dir.path().join("f.json.corrupt-7"));
    assert_eq!(crate::json::quarantine_path_from(&file, 9), dir.path().join("f.json.corrupt-9"));
}

#[test]
fn a_held_lock_times_out_with_nodes_codes_and_is_free_afterwards() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("f.json.lock");
    let holder = fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock).unwrap();
    holder.lock().unwrap();
    let file = dir.path().join("f.json");

    let started = Instant::now();
    let busy = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, Some(Duration::from_millis(150)), || ()).unwrap_err()
    });
    assert_eq!(busy.code(), Some("ELOCKTIMEOUT"));
    assert!(started.elapsed() >= Duration::from_millis(150));
    let once = on_lane({
        let file = file.clone();
        move |lane| with_lock(lane, &file, Some(Duration::ZERO), || ()).unwrap_err()
    });
    assert_eq!(once.code(), Some("ELOCKCONTENDED"));

    holder.unlock().unwrap();
    assert_eq!(on_lane(move |lane| with_lock(lane, &file, Some(Duration::ZERO), || 7).unwrap()), 7);
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
                        let opts = Opts { lock_timeout: Some(Duration::from_secs(30)), ..Opts::default() };
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
    let stored: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(stored["n"], 80);
}

#[test]
fn a_file_that_cannot_be_read_is_an_error_not_an_empty_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("f.json");
    fs::create_dir(&path).unwrap();
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
    assert!(is_owner_only(&path).unwrap());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn a_failed_write_removes_its_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    // The target is a non-empty directory: the rename cannot replace it.
    let path = dir.path().join("f.json");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("inner"), "x").unwrap();
    let failed = on_lane({
        let path = path.clone();
        move |lane| write_file(lane, &path, b"x", &Opts::default()).is_err()
    });
    assert!(failed);
    let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("f.json")]);
}

#[test]
fn rename_retries_follow_nodes_schedule_and_skip_read_only_targets() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("t");
    fs::write(&target, "x").unwrap();
    #[cfg(unix)]
    let denied = std::io::Error::from_raw_os_error(libc::EACCES);
    #[cfg(windows)]
    let denied = std::io::Error::from_raw_os_error(5);

    let first = crate::publish::next_rename_delay(&denied, 0, &target).unwrap();
    assert!((25..50).contains(&(first.as_millis() as u64)), "{first:?}");
    let late = crate::publish::next_rename_delay(&denied, 22, &target).unwrap();
    assert!((200..250).contains(&(late.as_millis() as u64)), "{late:?}");
    assert!(crate::publish::next_rename_delay(&denied, 23, &target).is_none());
    assert!(crate::publish::next_rename_delay(&std::io::Error::from(std::io::ErrorKind::NotFound), 0, &target).is_none());

    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();
    assert!(crate::publish::next_rename_delay(&denied, 0, &target).is_none());
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false, reason = "test cleanup")]
    permissions.set_readonly(false);
    fs::set_permissions(&target, permissions).unwrap();
}

#[test]
fn only_nul_and_blanks_hold_no_data() {
    assert!(holds_no_data(b""));
    assert!(holds_no_data(b"\0 \t\r\n\0"));
    assert!(!holds_no_data(b"\0{\0"));
    assert!(!holds_no_data("\u{a0}".as_bytes()));
}
