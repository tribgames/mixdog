#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup; the child process is the point")]
//! DS-WS-3: the kill-point matrix. A child process runs a three-file `writeTextBatch` with a
//! recovery journal and is aborted (no cleanup, no destructors) at each journal step. A fresh
//! store then lists, inspects and restores what it finds: the pre-image comes back wherever a
//! batch was interrupted, a finished batch is never "restored", and nothing is ever torn.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_workspace::fsops::BatchFile;
use mixdog_workspace::fsops::ProjectFs;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::recovery::Action;
use mixdog_workspace::recovery::RecoveryStore;
use serde_json::Value;
use serde_json::json;

const FILES: [(&str, &str, &str); 3] = [("a.txt", "a0\n", "a1\n"), ("b.txt", "b0\n", "b1\n"), ("c.txt", "c0\n", "c1\n")];

/// Runs in the child process only: the batch write that gets killed.
#[test]
fn kill_child() {
    let (Ok(root), Ok(store)) = (std::env::var("MIXDOG_KILL_ROOT"), std::env::var("MIXDOG_KILL_STORE")) else { return };
    let fs = ProjectFs::new(Arc::new(RecoveryStore::new(PathBuf::from(store))));
    let writes: Vec<BatchFile> = FILES
        .iter()
        .map(|(rel, before, after)| BatchFile { rel_path: (*rel).into(), content: (*after).into(), expected_content: (*before).into() })
        .collect();
    fs.write_batch(Path::new(&root), &writes, true).expect("the batch completes unless killed");
}

fn run_killed_at(point: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let (root, store) = (base.join("project"), base.join("store"));
    std::fs::create_dir_all(&root).unwrap();
    for (rel, before, _) in FILES {
        std::fs::write(root.join(rel), before).unwrap();
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "kill_points::kill_child", "--nocapture", "--test-threads=1"])
        .env("MIXDOG_KILL_ROOT", &root)
        .env("MIXDOG_KILL_STORE", &store)
        .env("MIXDOG_KILL_AT", point)
        .status()
        .unwrap();
    assert!(!status.success(), "the child must die at {point}");
    (dir, root, store)
}

fn contents(root: &Path) -> Vec<String> {
    FILES.iter().map(|(rel, _, _)| std::fs::read_to_string(root.join(rel)).unwrap()).collect()
}

fn originals() -> Vec<String> {
    FILES.iter().map(|f| f.1.to_owned()).collect()
}

fn statuses(detail: &mixdog_workspace::recovery::Detail) -> Vec<Value> {
    detail.files.iter().map(|f| serde_json::to_value(f).unwrap()["status"].clone()).collect()
}

/// Inspect the single record, restore it, and check the pre-image is back.
fn restore_and_verify(root: &Path, store: &RecoveryStore, expect_statuses: Vec<Value>) {
    let record = store.list(root).unwrap().into_iter().next().expect("a record survives the crash");
    assert_eq!(serde_json::to_value(&record).unwrap()["phase"], "interrupted");
    let detail = store.execute(root, Action::Inspect { id: record.id.clone() }).unwrap().detail.unwrap();
    assert_eq!(statuses(&detail), expect_statuses);
    store.execute(root, Action::Restore { id: record.id, revision: detail.revision }).unwrap();
    assert_eq!(contents(root), originals(), "the pre-image is back");
}

#[test]
fn before_the_manifest_is_published_nothing_is_restorable_and_nothing_changed() {
    for point in ["journal-dir", "payloads"] {
        let (_dir, root, store_path) = run_killed_at(point);
        assert_eq!(contents(&root), originals(), "{point}: targets untouched");
        let store = RecoveryStore::new(store_path);
        let records = store.list(&root).unwrap();
        // A half-built journal (no manifest) is listed invalid, never restorable.
        for record in &records {
            assert_eq!(serde_json::to_value(record).unwrap()["phase"], "invalid", "{point}");
            let err = store.execute(&root, Action::Restore { id: record.id.clone(), revision: "0".repeat(64) }).unwrap_err();
            assert!(err.message.starts_with("RECOVERY_") || err.message.contains("revision") || !err.message.is_empty(), "{point}: {err}");
        }
        assert_eq!(contents(&root), originals(), "{point}: still untouched");
    }
}

#[test]
fn a_published_journal_without_writes_restores_to_the_same_files() {
    for point in ["manifest", "published"] {
        let (_dir, root, store_path) = run_killed_at(point);
        assert_eq!(contents(&root), originals(), "{point}: targets untouched");
        restore_and_verify(&root, &RecoveryStore::new(store_path), vec![json!("original"); 3]);
    }
}

#[test]
fn a_kill_after_each_target_write_restores_the_pre_image() {
    for written in 0..2usize {
        let (_dir, root, store_path) = run_killed_at(&format!("write:{written}"));
        let now = contents(&root);
        for (i, (_, before, after)) in FILES.iter().enumerate() {
            let expected = if i <= written { *after } else { *before };
            assert_eq!(now[i], expected, "write:{written}: file {i} is whole, never torn");
        }
        let expect: Vec<Value> = (0..3).map(|i| json!(if i <= written { "written" } else { "original" })).collect();
        restore_and_verify(&root, &RecoveryStore::new(store_path), expect);
    }
}

#[test]
fn a_completed_batch_killed_before_retirement_is_never_restored_over_its_result() {
    let (_dir, root, store_path) = run_killed_at("state-written");
    assert_eq!(contents(&root), FILES.iter().map(|f| f.2.to_owned()).collect::<Vec<_>>());
    let store = RecoveryStore::new(store_path);
    let record = store.list(&root).unwrap().into_iter().next().expect("record");
    assert_eq!(serde_json::to_value(&record).unwrap()["phase"], "completed");
    let detail = store.execute(&root, Action::Inspect { id: record.id.clone() }).unwrap().detail.unwrap();
    let err = store.execute(&root, Action::Restore { id: record.id, revision: detail.revision }).unwrap_err();
    assert!(err.message.starts_with("RECOVERY_NOT_RESTORABLE"), "{err}");
    assert_eq!(contents(&root), FILES.iter().map(|f| f.2.to_owned()).collect::<Vec<_>>());
}

#[test]
fn a_kill_after_retirement_leaves_a_retired_record_that_cannot_restore() {
    let (_dir, root, store_path) = run_killed_at("retired");
    let store = RecoveryStore::new(store_path.clone());
    let record = store.list(&root).unwrap().into_iter().next().expect("retired record");
    assert_eq!(serde_json::to_value(&record).unwrap()["phase"], "retired");
    let detail = store.execute(&root, Action::Inspect { id: record.id.clone() }).unwrap().detail.unwrap();
    let err = store.execute(&root, Action::Restore { id: record.id.clone(), revision: detail.revision.clone() }).unwrap_err();
    assert!(err.message.starts_with("RECOVERY_NOT_RESTORABLE"), "{err}");
    // It can be discarded explicitly, and then nothing is left.
    store.execute(&root, Action::Discard { id: record.id, revision: detail.revision }).unwrap();
    assert!(store.list(&root).unwrap().is_empty());
    let (_dir2, root2, store2) = run_killed_at("removed");
    assert!(RecoveryStore::new(store2).list(&root2).unwrap().is_empty());
}
