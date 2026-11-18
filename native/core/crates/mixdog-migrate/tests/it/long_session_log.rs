//! A session log migrates to the session its records describe, and a log that is not the manifest's is refused
//! before anything of it is published.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_migrate::durable;
use mixdog_migrate::error::Blocked;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::session::source::fold_log;
use mixdog_migrate::session::target::read_sessions;
use mixdog_store::schema::migration::COMPLETE_PATH;
use serde_json::Value;
use serde_json::json;

use crate::log_harness::*;

const ID: &str = "sess_longlog";

fn log_file(roots: &MigrationRoots) -> std::path::PathBuf {
    roots.data.join(format!("sessions/{ID}.log.jsonl"))
}

fn message(role: &str, content: &str) -> String {
    json!({"role": role, "content": content}).to_string()
}

fn header() -> Value {
    json!({"id": ID, "title": "first", "updatedAt": 1})
}

/// A log holding every kind of record, ending in a line the writer was still writing.
fn full_log() -> String {
    let system = message("system", "S");
    let (u1, a1) = (message("user", " q1 "), message("assistant", "a1"));
    let (u2, a2, a2_edited) = (message("user", "q2"), message("assistant", "a2"), message("assistant", "a2 edited"));
    session("log1", ID, &header())
        + &compacted(1, &[system.clone(), u1, a1])
        + &append(2, 5, &[u2, a2])
        + &edit(3, 5, 4, 1, &[a2_edited])
        + &patch(4, &json!({"title": "last"}), &json!(["updatedAt"]))
        + &rollback(5, 4)
        + "{\"t\":\"append\",\"s\":6,\"len\":5,\"mess"
}

#[test]
fn a_log_migrates_to_the_history_its_records_leave() {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    std::fs::write(log_file(&roots), full_log()).expect("write");
    let complete = migrate(&roots);
    let folded = read_sessions(&roots, &complete.manifest_sha256).expect("the migrated sessions fold");
    assert_eq!(folded.len(), 1);
    let session = &folded[ID];
    // The leading system message is the header's prompt base, every other message one row; the patch set the title and
    // removed `updatedAt`; the edit replaced the last message and the rollback then dropped it.
    let header = serde_json::to_value(&session.header).expect("header");
    assert_eq!(header["title"], "last");
    assert_eq!(header["promptBase"], "S");
    assert!(header.get("updatedAt").is_none());
    let bodies: Vec<Value> = session.rows.iter().map(|row| serde_json::to_value(&row.body).expect("body")).collect();
    assert_eq!(
        bodies,
        [json!({"role": "user", "content": " q1 "}), json!({"role": "assistant", "content": "a1"}), json!({"role": "user", "content": "q2"})]
    );
    let prompts: Vec<Option<&str>> = session.rows.iter().map(|row| row.prompt.as_deref()).collect();
    assert_eq!(prompts, [Some("q1"), None, Some("q2")], "a user row's prompt is its trimmed text");
    let ordinals: Vec<u64> = session.rows.iter().map(|row| row.ordinal).collect();
    assert_eq!(ordinals, [1, 2, 3]);
}

/// A log from which no session can be read: nothing is published, and the migration quarantines it.
fn refused(name: &str, bytes: &str) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    std::fs::write(log_file(&roots), bytes).expect("write");
    let complete = run(&roots);
    assert_eq!(complete.kinds.data.quarantined_unexpected, 1, "{name}: quarantined");
    assert!(read_sessions(&roots, &complete.manifest_sha256).expect("fold").is_empty(), "{name}: no session");
}

/// A log whose records break the sequence or the length is a history up to the break (the reader 1.4.5's dev builds used
/// ends the replay there, keeping what came before): the session is migrated with the rows before the break, and nothing
/// after it, rather than the whole log being set aside with its readable part.
fn migrated_up_to_the_break(name: &str, bytes: &str) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    std::fs::write(log_file(&roots), bytes).expect("write");
    let complete = run(&roots);
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{name}: not quarantined");
    let sessions = read_sessions(&roots, &complete.manifest_sha256).expect("fold");
    let bodies: Vec<Value> = sessions[ID].rows.iter().map(|row| serde_json::to_value(&row.body).expect("body")).collect();
    assert_eq!(bodies, [json!({"role": "user", "content": "q"})], "{name}: the rows before the break");
}

#[test]
fn a_log_without_a_history_is_refused() {
    refused("no history", &(session("log1", ID, &header()) + &patch(1, &json!({"title": "x"}), &json!([]))));
}

#[test]
fn a_log_that_breaks_its_sequence_or_length_migrates_up_to_the_break() {
    let base = [message("system", "S"), message("user", "q")];
    migrated_up_to_the_break("a sequence gap", &(session("log1", ID, &header()) + &compacted(1, &base) + &append(3, 3, &[message("assistant", "a")])));
    migrated_up_to_the_break("a wrong length", &(session("log1", ID, &header()) + &compacted(1, &base) + &append(2, 9, &[message("assistant", "a")])));
}

#[test]
fn a_log_changed_while_it_is_read_is_refused_after_the_read() {
    let log = full_log();
    let dir = tempfile::tempdir().expect("scratch dir");
    let path = dir.path().join(format!("{ID}.log.jsonl"));
    std::fs::write(&path, &log).expect("write");
    let (size, sha256) = durable::hash_file(&path).expect("hash");
    let mut open = durable::open_verified(&path, size, &sha256).expect("open");
    // The same length but one byte: a log that still folds, to a session the manifest never saw.
    let changed = log.replacen("q2", "q3", 1);
    assert_eq!(changed.len(), log.len());
    std::fs::write(&path, &changed).expect("rewrite");
    let fold = fold_log(ID, &mut open, &mut 0).expect("the changed log folds");
    assert!(fold.messages.iter().any(|m| m["content"] == "q3"), "the fold read the changed bytes");
    let Err(Blocked::SourceChanged { path: refused }) = open.verify() else {
        panic!("a log read through a handle whose bytes are not the manifest's is accepted");
    };
    assert_eq!(refused, path);
}

#[test]
fn a_log_that_is_not_the_manifests_publishes_nothing() {
    let log = full_log();
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    let path = log_file(&roots);
    std::fs::write(&path, &log).expect("write");
    let changed = log.replacen("q2", "q3", 1);
    // Planned from the original bytes; replaced by an equally long, valid log before the session is read.
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
    let (_runtime, migrator) = migrator(&roots, MigrateOptions { workers: 1, fault: Some(hook), verified: None });
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

fn legacy(text: &str) -> (usize, usize, Option<Value>) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let roots = roots_in(dir.path());
    std::fs::write(roots.data.join("sessions/sess_legacy.json"), text).expect("write");
    let complete = run(&roots);
    let sessions = read_sessions(&roots, &complete.manifest_sha256).expect("fold");
    let read = sessions.get("sess_legacy").map(|s| {
        let mut read = serde_json::to_value(&s.header).expect("header");
        read["messages"] = s.rows.iter().map(|row| serde_json::to_value(&row.body).expect("body")).collect();
        read
    });
    (complete.kinds.data.quarantined_unexpected as usize, sessions.len(), read)
}

#[test]
fn a_legacy_session_json_migrates_to_one_session_with_its_header_and_messages() {
    let (quarantined, sessions, read) = legacy(r#"{"id":"sess_legacy","title":"t","messages":[{"role":"user","content":"hi"}]}"#);
    assert_eq!((quarantined, sessions), (0, 1));
    let read = read.unwrap();
    assert_eq!(read["title"], "t");
    assert_eq!(read["messages"], json!([{"role": "user", "content": "hi"}]));
}

#[test]
fn a_legacy_session_json_naming_a_top_level_key_twice_is_quarantined() {
    for text in [
        r#"{"id":"sess_legacy","title":"a","title":"b","messages":[]}"#,
        r#"{"id":"sess_legacy","ti\u0074le":"a","title":"b","messages":[]}"#,
    ] {
        let (quarantined, sessions, _) = legacy(text);
        assert_eq!((quarantined, sessions), (1, 0), "{text}");
    }
}
