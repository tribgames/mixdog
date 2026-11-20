//! Publication tests use temporary files only: no database, model or user profile.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "isolated temporary-file tests")]
use super::*;
use mixdog_fsio::Unlaned;
use serde_json::json;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

#[test]
fn an_older_snapshot_waits_for_the_atomic_update_and_cannot_replace_a_newer_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = file_path(dir.path());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let mut writer = None;
    // testing::tokens uses InlineBackend: a lane job may block the thread that polls it.
    // Keep the competing writer on its OWN OS thread/runtime, never on a Tokio timer's
    // thread. The observer can then wait and publish while the writer waits on this lock.
    let premature = mixdog_statefile::with_lock(&Unlaned, &path, &mixdog_statefile::LockOpts::default(), || {
        let directory = dir.path().to_owned();
        writer = Some(std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let lane = mixdog_rt::testing::tokens().durability_io;
            let rows = [json!({"id": 1, "summary": "older"})];
            let reserved = AtomicU64::new(0);
            started_tx.send(()).unwrap();
            let answer = runtime.block_on(write_snapshot(lane, &directory, &rows, Some(1), &reserved));
            let _ = done_tx.send(answer.map_err(|error| error.to_string()));
        }));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let premature = done_rx.recv_timeout(Duration::from_millis(200));
        // Reentrant on this holder thread, but mutually exclusive with the older writer.
        mixdog_statefile::update_json(
            &Unlaned,
            &path,
            |_| {
                Ok::<_, std::convert::Infallible>(Some(json!({
                    "version": 1, "revision": 2, "updatedAt": 2,
                    "curated": [{"id": 1, "summary": "newer", "updatedAt": 2}]
                })))
            },
            &mixdog_statefile::Opts { secret: true, compact: true, ..Default::default() },
        )
        .unwrap();
        premature
    })
    .unwrap();
    let answer = match &premature {
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Some(done_rx.recv_timeout(Duration::from_secs(5)).unwrap()),
        _ => None,
    };
    writer.unwrap().join().unwrap();
    assert!(matches!(premature, Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "the snapshot writer bypassed the atomic file lock: {premature:?}");
    assert_eq!(answer.unwrap().unwrap(), (2, false));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let current = runtime.block_on(read(mixdog_rt::testing::tokens().durability_io, dir.path())).unwrap();
    assert_eq!(current.revision, 2);
    assert_eq!(session_payload(&current, None, "").user_lines, vec!["newer"]);
}

#[tokio::test]
async fn a_newer_snapshot_with_a_float_spelled_version_rejects_an_older_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let lane = mixdog_rt::testing::tokens().durability_io;
    let reserved = AtomicU64::new(0);
    for version in ["1.0", "1e0"] {
        // Both are JavaScript Number 1 and are accepted by the existing snapshot reader.
        let original = format!(r#"{{"version":{version},"revision":9,"updatedAt":2,"curated":[{{"id":1,"summary":"newer","updatedAt":2}}]}}"#);
        std::fs::write(file_path(dir.path()), &original).unwrap();
        assert_eq!(read(lane, dir.path()).await.unwrap().revision, 9);
        let result = write_snapshot(lane, dir.path(), &[json!({"id": 1, "summary": "older"})], Some(3), &reserved).await.unwrap();
        assert_eq!(result, (9, false), "version {version}");
        assert_eq!(std::fs::read_to_string(file_path(dir.path())).unwrap(), original);
    }
}

#[tokio::test]
async fn publishing_and_replacing_a_snapshot_preserves_owner_only_access_and_compact_json() {
    let dir = tempfile::tempdir().unwrap();
    let lane = mixdog_rt::testing::tokens().durability_io;
    let reserved = AtomicU64::new(0);
    for revision in [1, 2] {
        assert_eq!(
            write_snapshot(lane, dir.path(), &[json!({"id": 1, "summary": format!("entry {revision}")})], Some(revision), &reserved).await.unwrap(),
            (revision, true)
        );
        let path = file_path(dir.path());
        assert!(mixdog_statefile::is_owner_only(&Unlaned, &path).unwrap(), "fresh and replacement snapshots must retain the secret-file contract");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary or lock file remains");
    }
}
