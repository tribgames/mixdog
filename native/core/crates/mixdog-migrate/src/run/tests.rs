//! SM §11.8: the corpus gate (`v145`, `dev146`, `fixture-busy-seed`), the crash matrix
//! and rename-failure retry over a fixture holding every data kind.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixtures build and inspect data dirs with blocking std::fs and rusqlite"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_store::schema::record::Record;
use mixdog_store::schema::sql::INDEX_DDL;
use mixdog_store::schema::sql::session_id_key;
use serde_json::Value;
use serde_json::json;
use sha1::Digest as _;

use super::*;
use crate::index::IndexProjector;
use crate::json::js_stable;

/// The test stand-in of the store's catalog writer: the projection-state columns only.
struct TestProjector;

impl IndexProjector for TestProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> std::result::Result<(), String> {
        let conn = rusqlite::Connection::open(db).map_err(|e| e.to_string())?;
        conn.execute_batch(INDEX_DDL).map_err(|e| e.to_string())?;
        for id in sessions {
            let dir = data.join("sessions").join(id);
            let mut files: Vec<_> = std::fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .map(|e| e.unwrap().path())
                .collect();
            files.sort();
            let (mut rows, mut ordinal, mut size) = (0i64, 0u64, 0i64);
            for file in &files {
                let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
                let (frames, _) = crate::frame::scan(&bytes, ordinal);
                for f in &frames {
                    if let Ok(Record::Item(_)) = serde_json::from_slice(&bytes[f.payload.clone()]) {
                        rows += 1;
                    }
                    ordinal = f.ordinal + 1;
                }
                size = bytes.len() as i64;
            }
            conn.execute(
                "INSERT INTO sessions (id, dirty, status, deleted, log_id, newest_file_no, projected_file_no,
                    projected_offset, projected_ordinal, history_rev, row_count, visible_count, activity, closed,
                    archived, id_key, title_fold, id_fold, summary)
                 VALUES (?1, 0, 'ok', 0, '', ?2, ?2, ?3, ?4, 0, ?5, 0, 0, 0, 0, ?6, '', ?1, '{}')",
                rusqlite::params![id, files.len() as i64 - 1, size, ordinal as i64, rows, session_id_key(id)],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn drivers() -> Vec<Arc<dyn ItemDriver>> {
    product_drivers(Arc::new(TestProjector))
}

fn copy_tree(from: &Path, to: &Path) {
    for rel in durable::walk_files(from).unwrap() {
        let dst = to.join(&rel);
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::copy(from.join(&rel), dst).unwrap();
    }
    std::fs::create_dir_all(to).unwrap();
}

/// Paths and bytes of every file under the roots, the journal excluded.
fn tree_digest(roots: &MigrationRoots) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (name, root) in [("data", &roots.data), ("home", &roots.home)] {
        for rel in durable::walk_files(root).unwrap() {
            if rel == JOURNAL_PATH {
                continue;
            }
            out.insert(format!("{name}/{rel}"), durable::hash_file(&root.join(&rel)).unwrap().1);
        }
    }
    out
}

fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// A data dir with every data kind: 1.4.5 json with archive, pending job, recoverable
/// checkpoint, a lone surrogate and a blob-sized body; a dev pair; spool, worker row,
/// set-aside, tmp, orphan checkpoint, preserved stores, settings with legacy compaction
/// keys, the genuine 1.4.5 ledger and an imported legacy usage file.
fn fixture(root: &Path) -> MigrationRoots {
    let data = root.join("data");
    let home = root.join("home");
    let blob = b"image bytes";
    let blob_hex = durable::sha256_hex(blob);
    write(&data, &format!("prompt-attachments/sha256/{}/{blob_hex}", &blob_hex[..2]), blob);
    let big = "x".repeat(300 * 1024);
    let a = format!(
        r#"{{"id":"sess_a","title":"A","generation":2,"compaction":{{"archive":{{"nextSeq":3,"clearedThrough":0}}}},"messages":[{{"role":"user","content":"hi \ud800 there","meta":{{"transcript":{{"messageId":"m1"}}}}}},{{"role":"assistant","content":[{{"type":"text","text":"x"}},{{"type":"image","attachmentRef":"{blob_hex}"}},{{"type":"image","attachmentRef":"{}"}}]}},{{"role":"user","content":"{big}"}},{{"role":"user","content":"s","meta":"skill"}}]}}"#,
        "0".repeat(64)
    );
    write(&data, "sessions/sess_a.json", a.as_bytes());
    let items = r#"[{"kind":"text","id":"arch1_0","text":"old"},{"kind":"divider"}]"#;
    write(
        &data,
        "sessions/sess_a.compaction-archive.jsonl",
        format!(r#"{{"v":1,"seq":1,"id":"seg1","prev":null,"at":5,"count":2,"bytes":{},"items":{items}}}"#, items.len())
            .as_bytes()
            .iter()
            .chain(b"\n")
            .copied()
            .collect::<Vec<_>>()
            .as_slice(),
    );
    write(
        &data,
        "sessions/sess_a.compaction-archive.pending",
        br#"{"v":1,"jobs":[{"seq":1,"messages":[]},{"seq":2,"at":7,"divider":true,"clearedThrough":0,"maxBytes":100,"messages":[{"role":"user","content":"pending"}]}]}"#,
    );
    write(
        &data,
        "turn-checkpoints/sess_a.json",
        br#"{"version":1,"sessionId":"sess_a","turnToken":"t1","generation":2,"startedAt":9,"turnMessages":[{"role":"user","content":"q"}],"interruption":{"responseStarted":true,"partialAssistantContent":"pa"}}"#,
    );
    write(
        &data,
        "turn-checkpoints/sess_a.jsonl",
        b"{\"t\":\"h\",\"turnToken\":\"t1\",\"s\":0}\n{\"t\":\"m\",\"s\":1,\"i\":1,\"m\":{\"role\":\"assistant\",\"content\":\"partial\"}}\n",
    );
    write(&data, "turn-checkpoints/sess_zzz.jsonl", b"{\"t\":\"h\",\"turnToken\":\"x\",\"s\":0}\n");
    // Dev pair: the log was built from this json (anchor): the log wins.
    let b_json = br#"{"id":"sess_b","title":"old","messages":[{"role":"user","content":"one"}]}"#;
    write(&data, "sessions/sess_b.json", b_json);
    let sha1 = crate::json::hex(&sha1::Sha1::digest(b_json));
    let log = format!(
        "{}\n{}\n{}\n{}\n{{\"t\":\"append\",\"s\":4,\"len\":3,\"mess",
        json!({"t":"session","s":0,"v":1,"logId":"abc","id":"sess_b","prev":null,
               "legacy":{"sha1":sha1,"size":b_json.len(),"mtimeMs":1.5},"header":{"id":"sess_b","title":"old"}}),
        json!({"t":"compacted","s":1,"len":1,"messages":[{"role":"user","content":"one"}]}),
        json!({"t":"append","s":2,"len":2,"messages":[{"role":"assistant","content":"two"}]}),
        json!({"t":"patch","s":3,"set":{"title":"new"},"unset":[]}),
    );
    write(&data, "sessions/sess_b.log.jsonl", log.as_bytes());
    write(&data, "sessions/sess_c.json.corrupt-123", b"{broken");
    write(&data, "sessions/sess_c.json.0123456789ab.tmp", b"");
    write(
        &data,
        "session-pending/sess_a.json",
        br#"{"version":1,"sessions":{"sess_a":[{"id":"q2","message":"later","enqueuedAt":6},{"id":"q1","message":"m","enqueuedAt":5}],"tui_x":[{"id":"q3"}]}}"#,
    );
    write(
        &data,
        "agent-workers.json",
        br#"{"version":2,"workers":{"sess_b":{"sessionId":"sess_b","tag":"t","status":"idle","messages":[]}}}"#,
    );
    write(&data, "goals/sess_a.json", br#"{"sessionId":"sess_a"}"#);
    write(&data, "goals/sess_gone.json", br#"{"sessionId":"sess_gone"}"#);
    write(
        &data,
        "mixdog-config.json",
        br#"{"agent":{"compaction":{"enabled":false,"semanticModel":"m"},"other":1}}"#,
    );
    write(&data, "client-versions.json", b"{}");
    write(&data, "live-sessions/1.pid", b"1");
    let ledger = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/ledger-v145/ledger.sqlite");
    write(&data, "usage/ledger.sqlite", &std::fs::read(ledger).unwrap());
    write(&data, "usage-rollup.local.json", b"{}");
    write(&home, "projects.json", b"{}");
    MigrationRoots {
        data,
        home,
        profile: None,
    }
}

fn migrator(roots: &MigrationRoots, fault: Option<FaultHook>) -> Migrator {
    Migrator::new(roots.clone(), drivers(), MigrateOptions { workers: 1, fault })
}

/// The `reason.json` bodies of unexpected quarantines.
fn unexpected_reasons(roots: &MigrationRoots) -> Vec<Value> {
    let dir = roots.data.join("quarantine");
    durable::walk_files(&dir)
        .unwrap()
        .into_iter()
        .filter(|rel| rel.ends_with("reason.json"))
        .map(|rel| serde_json::from_slice::<Value>(&std::fs::read(dir.join(rel)).unwrap()).unwrap())
        .filter(|reason| reason["expected"] == false)
        .collect()
}

fn journal_records(roots: &MigrationRoots) -> Vec<JournalRecord> {
    let bytes = std::fs::read(roots.data.join(JOURNAL_PATH)).unwrap();
    let (frames, _) = crate::frame::scan(&bytes, 0);
    frames
        .iter()
        .map(|f| serde_json::from_slice(&bytes[f.payload.clone()]).unwrap())
        .collect()
}

#[test]
fn fixture_migrates_every_kind() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let complete = migrator(&roots, None).run().unwrap();
    let c = complete.kinds.data;
    assert_eq!(c.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    // The set-aside json, and the legacy usage file the genuine 1.4.5 ledger (no
    // `importedThrough`) has not imported yet.
    assert_eq!(c.retained, 2, "{complete:?}");
    // One dangling attachment, one goal of a session that does not exist.
    assert_eq!(c.dangling, 2, "{complete:?}");
    let records = journal_records(&roots);
    let replaced: u64 = records
        .iter()
        .filter_map(|r| match r {
            JournalRecord::Staged(s) if s.key.as_str() == "session/sess_a" => Some(s.replaced_surrogates),
            _ => None,
        })
        .sum();
    assert_eq!(replaced, 1);
    // Sources disposed, targets present, preserved stores in place.
    for gone in [
        "sessions/sess_a.json",
        "sessions/sess_b.log.jsonl",
        "session-pending/sess_a.json",
        "agent-workers.json",
        "turn-checkpoints/sess_zzz.jsonl",
        "client-versions.json",
        "usage-rollup.local.json",
    ] {
        assert!(!roots.data.join(gone).exists(), "{gone}");
    }
    for present in ["sessions/sess_a/log.000000", "sessions/sess_b/log.000000", "goals/sess_gone.json", "index/store.sqlite"] {
        assert!(roots.data.join(present).exists(), "{present}");
    }
    assert!(roots
        .data
        .join("quarantine/carried_set_aside/retain%2Fdata%2Fsessions%2Fsess_c.json.corrupt-123/sess_c.json.corrupt-123")
        .exists());
    let config: Value = serde_json::from_slice(&std::fs::read(roots.data.join("mixdog-config.json")).unwrap()).unwrap();
    assert_eq!(config, json!({"agent":{"compaction":{"auto":false,"summaryModel":"m"},"other":1}}));
    // The dev pair folds the log, with the worker row as a meta.
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let cx = ItemContext {
        roots: &roots,
        manifest: &manifest,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let b = crate::session::target::read_session(&cx, &roots.data.join("sessions/sess_b")).unwrap();
    assert_eq!(b.header["title"], "new");
    assert_eq!(b.header["worker"], json!({"tag":"t","status":"idle"}));
    assert_eq!(b.rows.len(), 2);
    let a = crate::session::target::read_session(&cx, &roots.data.join("sessions/sess_a")).unwrap();
    let queue: Vec<&str> = a.queue.iter().map(|q| q.0.as_str()).collect();
    assert_eq!(queue, ["q1", "q2"]);
    // 2 segment rows + 1 pending row + 4 messages + 2 recovered checkpoint rows.
    assert_eq!(a.rows.len(), 9);
    assert_eq!(a.runs[0].0, "ckpt:t1");
    assert!(a.rows[3].body["content"] == "hi \u{fffd} there");
    // A second run finds the completion marker.
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

/// Every journal transition and publication step of every kind: a kill before or after
/// it, then a resume, ends in the tree an uninterrupted run leaves (journal excluded).
#[test]
fn every_crash_point_resumes_to_the_same_tree() {
    let base = std::env::temp_dir().join(format!("mig-same-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let roots = fixture(&base);
    migrator(&roots, None).run().unwrap();
    let want = tree_digest(&roots);
    std::fs::remove_dir_all(&base).unwrap();
    let mut seen = 0;
    loop {
        let roots = fixture(&base);
        let calls = Arc::new(AtomicUsize::new(0));
        let hook_calls = calls.clone();
        let stop_at = seen;
        let result = migrator(
            &roots,
            Some(Arc::new(move |p: &str| {
                if hook_calls.fetch_add(1, Ordering::SeqCst) == stop_at {
                    return Err(Blocked::Interrupted { point: p.to_string() });
                }
                Ok(())
            })),
        )
        .run();
        let point = match result {
            Err(Blocked::Interrupted { point }) => point,
            Ok(_) => {
                std::fs::remove_dir_all(&base).unwrap();
                break;
            }
            Err(e) => panic!("{e}"),
        };
        migrator(&roots, None).run().unwrap_or_else(|e| panic!("resume after {point}: {e}"));
        let got = tree_digest(&roots);
        let diff: Vec<_> = want.keys().chain(got.keys()).filter(|k| want.get(*k) != got.get(*k)).collect();
        assert!(diff.is_empty(), "after a crash at {point}: {diff:?}");
        std::fs::remove_dir_all(&base).unwrap();
        seen += 1;
    }
    assert!(seen > 40, "{seen} fault points");
}

#[test]
fn a_rename_failure_blocks_and_retry_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let failed = Arc::new(AtomicUsize::new(0));
    let hook = failed.clone();
    let blocked = migrator(
        &roots,
        Some(Arc::new(move |p: &str| {
            if p == "publish:session/sess_a:before" && hook.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(Blocked::Io {
                    op: "rename",
                    path: PathBuf::from("sessions/sess_a"),
                    os_error: "Access is denied. (os error 5)".into(),
                });
            }
            Ok(())
        })),
    )
    .run();
    assert!(matches!(blocked, Err(Blocked::Io { op: "rename", .. })), "{blocked:?}");
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
}

// ── Corpus gate ──────────────────────────────────────────────────────────────

pub(crate) fn corpus() -> PathBuf {
    std::env::var_os("MIXDOG_MIGRATION_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus"))
}

fn sha(text: &str) -> String {
    durable::sha256_hex(text.as_bytes())
}

const HEADER_KEYS: &[&str] = &[
    "id", "title", "provider", "model", "cwd", "createdAt", "updatedAt", "closed", "closedReason", "status",
    "generation", "agent", "owner", "parentSessionId", "ownerSessionId", "sourceType", "visibility",
    "inheritedFromSessionId",
];

/// `corpus-lib.cjs` `digests(header, messages)`.
fn corpus_digests(header: &serde_json::Map<String, Value>, messages: &[Value]) -> (usize, String, String) {
    let entry = |m: &Value| {
        let calls: Vec<Value> = match m.get("toolCalls") {
            Some(Value::Array(c)) => c
                .iter()
                .map(|c| match (c.get("id"), c.get("toolCallId")) {
                    (Some(v), _) if !v.is_null() => v.clone(),
                    (_, Some(v)) if !v.is_null() => v.clone(),
                    _ => Value::Null,
                })
                .collect(),
            _ => Vec::new(),
        };
        let tool = m.get("toolCallId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null);
        js_stable(&json!([m.get("role").cloned().unwrap_or(Value::Null), m.get("content").cloned().unwrap_or(Value::Null), tool, calls]))
    };
    let transcript = sha(&messages.iter().map(entry).collect::<Vec<_>>().join("\n"));
    let picked: serde_json::Map<String, Value> = HEADER_KEYS
        .iter()
        .filter_map(|k| header.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect();
    (messages.len(), transcript, sha(&js_stable(&Value::Object(picked))))
}

/// The corpus data dir `data_rel` (with the corpus home) migrated in a fresh temp dir, after
/// `edit` has changed the copied data dir.
pub(crate) fn migrate_corpus(
    data_rel: &str,
    edit: impl FnOnce(&Path),
) -> (tempfile::TempDir, MigrationRoots, Complete) {
    let corpus = corpus();
    let dir = tempfile::tempdir().unwrap();
    let roots = MigrationRoots {
        data: dir.path().join("data"),
        home: dir.path().join("home"),
        profile: None,
    };
    copy_tree(&corpus.join(data_rel), &roots.data);
    copy_tree(&corpus.join("home"), &roots.home);
    edit(&roots.data);
    let complete = Migrator::new(roots.clone(), drivers(), MigrateOptions::default()).run().unwrap();
    (dir, roots, complete)
}

fn gate(scenario: &str, data_rel: &str, expected_retained: u64) {
    let manifest: Value = serde_json::from_slice(&std::fs::read(corpus().join("manifest.json")).unwrap()).unwrap();
    let (_dir, roots, complete) = migrate_corpus(data_rel, |_| {});
    let c = complete.kinds.data;
    assert_eq!(c.quarantined_unexpected, 0, "{scenario}: {complete:?}");
    assert_eq!(c.quarantined_expected, 0, "{scenario}: {complete:?}");
    assert_eq!(c.retained, expected_retained, "{scenario}: {complete:?}");
    let disk: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots: &roots,
        manifest: &disk,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let sessions = manifest["scenarios"][scenario]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len() as u64, manifest["scenarios"][scenario]["sessionCount"].as_u64().unwrap());
    for s in sessions {
        let id = s["id"].as_str().unwrap();
        let folded = crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id))
            .unwrap_or_else(|e| panic!("{scenario}/{id}: {e}"));
        folded.observable(&cx).unwrap();
        // Every model message row, the hidden ones (skill/hook, internal text) included: the
        // corpus digests cover the whole 1.4.5 transcript.
        let messages: Vec<Value> = folded
            .rows
            .iter()
            .filter(|r| r.form == mixdog_store::schema::record::Form::Message && r.model)
            .map(|r| r.body.clone())
            .collect();
        let (count, transcript, header_digest) = corpus_digests(&folded.header, &messages);
        let want = &s["expected"];
        assert_eq!(count as u64, want["messageCount"].as_u64().unwrap(), "{scenario}/{id} count");
        assert_eq!(transcript, want["transcriptDigest"].as_str().unwrap(), "{scenario}/{id} transcript");
        assert_eq!(header_digest, want["headerDigest"].as_str().unwrap(), "{scenario}/{id} header");
    }
}

#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn gate_v145() {
    gate("v145", "v145", 1);
}

#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn gate_dev146() {
    gate("dev146", "dev146", 0);
}

#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn gate_fixture_busy_seed() {
    gate("fixture-busy-seed", "fixture-busy-seed/data", 0);
}
