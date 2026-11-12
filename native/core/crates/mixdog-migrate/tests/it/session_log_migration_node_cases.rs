//! Node's legacy session migration cases (`fixtures/session-log-migration-cases`, from
//! `benchmarks/rust-core/recorders/record-session-log-migration-cases.mjs`): each case's legacy jsons (and a log Node's
//! first write already made) in a data dir, the case's steps through the core's [`Migrator::run`] (an interrupted run
//! is a run stopped half way by the fault hook; a disk-full run is one whose first step fails with `StorageFull`), and
//! then what a client observes, against Node: every session as Node's reader read it, whether every legacy json kept
//! its bytes and mtime, and the leftover `.tmp` files. Named cases are left out.

#![allow(clippy::disallowed_methods, reason = "test fixtures build and inspect data dirs with blocking std::fs")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_migrate::error::Blocked;
use mixdog_migrate::framework::FaultHook;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::session::target::read_sessions;
use serde_json::Value;
use serde_json::json;

use crate::long_log_support::*;

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-log-migration-cases").join(name);
    serde_json::from_slice(&std::fs::read(path).expect("the recording")).expect("json")
}

fn sessions_dir(roots: &MigrationRoots) -> std::path::PathBuf {
    roots.data.join("sessions")
}

/// Every legacy json's bytes and mtime.
fn jsons(roots: &MigrationRoots) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
    let mut out: Vec<_> = std::fs::read_dir(sessions_dir(roots))
        .expect("sessions")
        .map(|e| e.expect("entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let name = p.file_name().expect("name").to_string_lossy().into_owned();
            (name, std::fs::read(&p).expect("read"), std::fs::metadata(&p).expect("stat").modified().expect("mtime"))
        })
        .collect();
    out.sort();
    out
}

fn tmp_count(roots: &MigrationRoots) -> usize {
    std::fs::read_dir(sessions_dir(roots))
        .expect("sessions")
        .filter(|e| e.as_ref().expect("entry").path().extension().is_some_and(|x| x == "tmp"))
        .count()
}

/// The fault points of an unstopped run over the case's files, in order.
fn points(case: &Value) -> Vec<String> {
    let dir = tempfile::tempdir().expect("scratch");
    let roots = seeded(dir.path(), case);
    let met = Arc::new(Mutex::new(Vec::new()));
    let record = met.clone();
    let hook: FaultHook = Arc::new(move |p| {
        record.lock().expect("points").push(p.to_owned());
        Ok(())
    });
    migrator(&roots, MigrateOptions { workers: 1, fault: Some(hook) }).1.run().expect("the probe run completes");
    let points = met.lock().expect("points").clone();
    points
}

fn seeded(dir: &std::path::Path, case: &Value) -> MigrationRoots {
    let roots = roots_in(dir);
    for (name, text) in case["files"].as_object().expect("files") {
        std::fs::write(sessions_dir(&roots).join(name), text.as_str().expect("text")).expect("write json");
    }
    for (id, log) in case["logs"].as_object().into_iter().flatten() {
        std::fs::write(sessions_dir(&roots).join(format!("{id}.log.jsonl")), log.as_str().expect("log")).expect("write log");
    }
    roots
}

/// A run whose `stop_at`th fault point fails as `error` does; it must not complete.
fn stopped(roots: &MigrationRoots, stop_at: usize, error: fn() -> std::io::Error) {
    let seen = Arc::new(AtomicUsize::new(0));
    let hook: FaultHook = Arc::new(move |p| {
        if seen.fetch_add(1, Ordering::SeqCst) == stop_at {
            return Err(Blocked::io("write", std::path::Path::new(p), error()));
        }
        Ok(())
    });
    let (_runtime, run) = migrator(roots, MigrateOptions { workers: 1, fault: Some(hook) });
    assert!(run.run().is_err(), "the stopped run does not complete");
}

/// What a client observes: the sessions, compared one by one to Node's, and the json and `.tmp` checks. The legacy
/// jsons are the manifest's declared difference: Node keeps them all; the core keeps them all until a run completes,
/// then none.
fn observe(roots: &MigrationRoots, manifest: Option<&str>, before: &[(String, Vec<u8>, std::time::SystemTime)], node: &Value, name: &str) {
    let folded = manifest.map(|sha| read_sessions(roots, sha).expect("the migrated sessions fold")).unwrap_or_default();
    let want = node["sessions"].as_object().expect("Node's sessions");
    assert_eq!(folded.keys().collect::<Vec<_>>(), want.keys().collect::<Vec<_>>(), "{name}: the sessions");
    for (id, session) in want {
        eprintln!("case: {name}, session {id}");
        assert_is_what_node_reads(&folded[id], session);
    }
    assert_eq!(node["jsonsUnchanged"], json!(true), "{name}: Node keeps every legacy json");
    let after = jsons(roots);
    match manifest {
        Some(_) => assert!(after.is_empty(), "{name}: a complete run leaves no legacy json (declared difference)"),
        None => assert!(after == before, "{name}: a run that did not complete changes no legacy json"),
    }
    assert_eq!(json!(tmp_count(roots)), node["tmp"], "{name}: .tmp files");
}

fn storage_full() -> std::io::Error {
    std::io::ErrorKind::StorageFull.into()
}

fn interrupted() -> std::io::Error {
    std::io::Error::other("interrupted")
}

#[test]
fn every_replayed_migration_case_leaves_what_node_leaves() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().expect("excluded").clone();
    let mut replayed = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["case"].as_str().expect("case");
        assert!(!excluded.contains_key(name), "{name} is recorded and excluded");
        let dir = tempfile::tempdir().expect("scratch");
        let roots = seeded(dir.path(), case);
        let before = jsons(&roots);
        for step in case["steps"].as_array().expect("steps") {
            match step.as_str().expect("step") {
                "interrupted" => stopped(&roots, points(case).len() / 2, interrupted),
                "disk full" => {
                    stopped(&roots, 0, storage_full);
                    observe(&roots, None, &before, &case["afterFailure"], name);
                }
                "run" => {
                    let complete = run(&roots);
                    observe(&roots, Some(&complete.manifest_sha256), &before, &case["observed"], name);
                }
                other => panic!("{name}: step {other}"),
            }
        }
        replayed += 1;
    }
    assert_eq!(replayed + excluded.len(), 5, "every case of the Node test");
}
