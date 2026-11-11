//! A session log migrates to the session Node's own reader reads from the same bytes, and a log that is not the
//! manifest's is refused before anything of it is published. The expected sessions are Node's recorded results
//! (`fixtures/long-session-log`, from `benchmarks/rust-core/recorders/record-long-session-log.mjs`).

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use base64::Engine as _;
use mixdog_migrate::durable;
use mixdog_migrate::error::Blocked;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::session::source::fold_log;
use mixdog_migrate::session::target::read_sessions;
use mixdog_store::schema::migration::COMPLETE_PATH;
use serde_json::Value;

use crate::long_log_support::*;

const ID: &str = "sess_longlog";

fn log_file(roots: &mixdog_migrate::framework::MigrationRoots) -> std::path::PathBuf {
    roots.data.join(format!("sessions/{ID}.log.jsonl"))
}

fn migrated_equals_node(name: &str, bytes: &[u8], node: &Value) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    std::fs::write(log_file(&roots), bytes).expect("write");
    let complete = migrate(&roots);
    let folded = read_sessions(&roots, &complete.manifest_sha256).expect("the migrated sessions fold");
    assert_eq!(folded.len(), 1, "{name}: one session");
    eprintln!("case: {name}");
    assert_is_what_node_reads(&folded[ID], node);
}

#[test]
fn the_encodings_are_the_ones_node_wrote() {
    let recorded = recorded("log.json");
    let log = recorded["log"].as_str().expect("log");
    let messages = |v: &Value| -> Vec<String> { v["messages"].as_array().expect("messages").iter().map(|m| m.to_string()).collect() };
    let mut again = String::new();
    for line in log.lines() {
        let v: Value = serde_json::from_str(line).expect("record");
        let seq = v["s"].as_u64().expect("s");
        again += &match v["t"].as_str().expect("t") {
            "session" => session(v["logId"].as_str().expect("logId"), v["id"].as_str().expect("id"), &v["header"]),
            "compacted" => compacted(seq, &messages(&v)),
            "append" => append(seq, v["len"].as_u64().expect("len") as usize, &messages(&v)),
            "edit" => edit(
                seq,
                v["len"].as_u64().expect("len") as usize,
                v["at"].as_u64().expect("at") as usize,
                v["del"].as_u64().expect("del") as usize,
                &messages(&v),
            ),
            "rollback" => rollback(seq, v["len"].as_u64().expect("len") as usize),
            "patch" => patch(seq, &v["set"], &v["unset"]),
            other => panic!("record kind {other}"),
        };
    }
    assert_eq!(again, log);
    let kinds = recorded["kinds"].as_array().expect("kinds");
    for kind in ["session", "compacted", "append", "edit", "rollback", "patch"] {
        assert!(kinds.iter().any(|k| k == kind), "the recording holds a {kind} record");
    }
}

#[test]
fn the_log_node_wrote_migrates_to_the_session_node_reads() {
    let recorded = recorded("log.json");
    migrated_equals_node("log", recorded["log"].as_str().expect("log").as_bytes(), &recorded["replay"]);
}

/// A log Node reads no session from (no `session` + `compacted` base): nothing is published, and the migration
/// quarantines it.
fn migrated_is_refused(name: &str, bytes: &[u8]) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    std::fs::write(log_file(&roots), bytes).expect("write");
    let complete = run(&roots);
    eprintln!("case: {name}");
    assert_eq!(complete.kinds.data.quarantined_unexpected, 1, "{name}: quarantined");
    assert!(read_sessions(&roots, &complete.manifest_sha256).expect("fold").is_empty(), "{name}: no session");
}

#[test]
fn every_recorded_log_migrates_as_node_reads_it() {
    let recorded = recorded("log.json");
    let cases = recorded["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 17);
    // Node's reader distinguishes these ways to stop; every one is recorded.
    let reasons: std::collections::BTreeSet<&str> =
        cases.iter().filter_map(|c| c["replay"]["damage"]["reason"].as_str()).collect();
    assert_eq!(reasons, ["length", "no-history", "sequence"].into());
    for case in cases {
        let bytes = base64::engine::general_purpose::STANDARD.decode(case["bytes"].as_str().expect("bytes")).expect("base64");
        let name = case["name"].as_str().expect("name");
        if case["replay"]["valid"] == true {
            migrated_equals_node(name, &bytes, &case["replay"]);
        } else {
            migrated_is_refused(name, &bytes);
        }
    }
}

#[test]
fn a_log_changed_while_it_is_read_is_refused_after_the_read() {
    let recorded = recorded("log.json");
    let log = recorded["log"].as_str().expect("log");
    let dir = tempfile::tempdir().expect("scratch dir");
    let path = dir.path().join(format!("{ID}.log.jsonl"));
    std::fs::write(&path, log).expect("write");
    let (size, sha256) = durable::hash_file(&path).expect("hash");
    let mut open = durable::open_verified(&path, size, &sha256).expect("open");
    // The same bytes but one: a log that still folds, to a session the manifest never saw.
    let changed = log.replacen("answer 7", "answer 8", 1);
    assert_eq!(changed.len(), log.len());
    std::fs::write(&path, &changed).expect("rewrite");
    let fold = fold_log(ID, &mut open, &mut 0).expect("the changed log folds");
    assert!(fold.messages.iter().any(|m| m["content"] == "answer 8"), "the fold read the changed bytes");
    let Err(Blocked::SourceChanged { path: refused }) = open.verify() else {
        panic!("a log read through a handle whose bytes are not the manifest's is accepted");
    };
    assert_eq!(refused, path);
}

#[test]
fn a_log_that_is_not_the_manifests_publishes_nothing() {
    let recorded = recorded("log.json");
    let log = recorded["log"].as_str().expect("log");
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    let path = log_file(&roots);
    std::fs::write(&path, log).expect("write");
    let changed = log.replacen("answer 7", "answer 8", 1);
    // Planned from the recorded bytes; replaced by an equally long, valid log before the session is read.
    let replaced = Arc::new(AtomicBool::new(false));
    let hook: mixdog_migrate::framework::FaultHook = {
        let (path, changed, replaced) = (path.clone(), changed.clone(), replaced.clone());
        Arc::new(move |point| {
            if point == "journal:plan:after" {
                std::fs::write(&path, &changed).expect("replace the log");
                replaced.store(true, Ordering::SeqCst);
            }
            Ok(())
        })
    };
    let (_runtime, migrator) = migrator(&roots, MigrateOptions { workers: 1, fault: Some(hook) });
    let Err(Blocked::SourceChanged { path: refused }) = migrator.run() else {
        panic!("a log that is not the manifest's was migrated");
    };
    assert!(replaced.load(Ordering::SeqCst));
    assert_eq!(refused, path);
    let sessions: Vec<_> = durable::list_dir(&roots.data.join("sessions")).expect("sessions").into_iter().map(|(n, _)| n).collect();
    assert_eq!(sessions, [format!("{ID}.log.jsonl")], "no session was published");
    assert!(!roots.data.join(COMPLETE_PATH).exists(), "the migration did not complete");
    assert!(!roots.data.join("quarantine").exists(), "the log was not set aside");
    assert_eq!(std::fs::read_to_string(&path).expect("log"), changed, "the source stays as it is");
}

/// Each legacy session json of `fixtures/session-gaps/legacy-json-keys.json` migrates as 1.4.5's own loader
/// (`loadLegacySession` over `readTopLevelLifecycleRecord`) read the same bytes: a record 1.4.5 found unreadable
/// (a top-level key named twice, escaped equivalents included) is quarantined and nothing is published; a record it
/// read migrates to one session with the title and the message count of the document it read.
#[test]
fn every_legacy_session_json_migrates_as_1_4_5_read_it() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-gaps/legacy-json-keys.json");
    let recorded: Value = serde_json::from_slice(&std::fs::read(path).expect("the recording")).expect("json");
    let id = recorded["sessionId"].as_str().expect("sessionId");
    let cases = recorded["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 11);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("scratch dir");
        let roots = roots_in(dir.path());
        std::fs::write(roots.data.join(format!("sessions/{id}.json")), case["text"].as_str().expect("text")).expect("write");
        let complete = run(&roots);
        let sessions = read_sessions(&roots, &complete.manifest_sha256).expect("fold");
        let document = &case["document"];
        if document.is_null() {
            assert_eq!((complete.kinds.data.quarantined_unexpected, sessions.len()), (1, 0), "{name}: 1.4.5 could not read it");
            continue;
        }
        assert_eq!((complete.kinds.data.quarantined_unexpected, sessions.len()), (0, 1), "{name}: 1.4.5 read it");
        let session = &sessions[id];
        let header = serde_json::to_value(&session.header).expect("header");
        assert_eq!(header["title"], document["title"], "{name}: title");
        let messages = document["messages"].as_array().expect("messages");
        assert_eq!(session.rows.len(), messages.len(), "{name}: rows");
        for (row, message) in session.rows.iter().zip(messages) {
            assert_eq!(serde_json::to_value(&row.body).expect("body"), *message, "{name}: the message 1.4.5 read");
        }
    }
}
