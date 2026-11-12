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
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_store::schema::migration::ItemKind;
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
        // Each statement of the DDL is a commit of its own, flushed unless the flushes are skipped.
        conn.pragma_update(None, "synchronous", mixdog_store::fsio::sqlite_synchronous()).map_err(|e| e.to_string())?;
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

pub(crate) fn drivers() -> Vec<Arc<dyn ItemDriver>> {
    product_drivers(
        Arc::new(TestProjector),
        crate::session::context_blobs::testing::office(Arc::default()),
    )
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

pub(crate) fn write(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

/// Every record of a published session's log with its ordinal.
fn log_records(dir: &Path) -> Vec<(u64, Record)> {
    let mut out = Vec::new();
    let mut ordinal = 0;
    for file_no in 0.. {
        let path = dir.join(format!("{}{file_no:06}", mixdog_store::schema::frame::LOG_FILE_PREFIX));
        if !path.exists() {
            break;
        }
        let bytes = std::fs::read(&path).unwrap();
        for frame in crate::frame::scan(&bytes, ordinal).0 {
            ordinal = frame.ordinal + 1;
            out.push((frame.ordinal, serde_json::from_slice(&bytes[frame.payload.clone()]).unwrap()));
        }
    }
    out
}

/// A data dir with every data kind: 1.4.5 json with archive, pending job, recoverable
/// checkpoint, a lone surrogate, a model switch and a blob-sized body; a dev pair; spool, worker row,
/// set-aside, tmp, orphan checkpoint, preserved stores, settings with legacy compaction
/// keys and one-account connector servers an agent and the accounts in use name, a pending
/// connector merge, the genuine 1.4.5 ledger and an imported legacy usage file.
fn fixture(root: &Path) -> MigrationRoots {
    let data = root.join("data");
    let home = root.join("home");
    let blob = b"image bytes";
    let blob_hex = durable::sha256_hex(blob);
    write(&data, &format!("prompt-attachments/sha256/{}/{blob_hex}", &blob_hex[..2]), blob);
    let big = "x".repeat(300 * 1024);
    let a = format!(
        r#"{{"id":"sess_a","title":"A","generation":2,"transcriptEpoch":"e1","compaction":{{"archive":{{"nextSeq":3,"clearedThrough":0}}}},"messages":[{{"role":"user","content":"hi \ud800 there","meta":{{"transcript":{{"messageId":"m1"}}}}}},{{"role":"assistant","content":[{{"type":"text","text":"x"}},{{"type":"image","attachmentRef":"{blob_hex}"}},{{"type":"image","attachmentRef":"{}"}}],"meta":{{"modelSwitches":[{{"provider":"openai","modelId":"gpt-5","at":11}}]}}}},{{"role":"user","content":"{big}"}},{{"role":"user","content":"s","meta":"skill"}}]}}"#,
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
        br#"{"version":1,"sessionId":"sess_a","turnToken":"t1","generation":2,"startedAt":9,"base":{"epoch":"e1","length":4},"boundary":4,"turnMessages":[{"role":"user","content":"q"}],"interruption":{"responseStarted":true,"partialAssistantContent":"pa"}}"#,
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
        br#"{"version":2,"workers":{"sess_b":{"sessionId":"sess_b","ownerSessionId":" sess_a ","tag":"t","status":"idle","messages":[]}},"tombstones":{"session:p\u0000t":{"tag":"t","sessionId":"sess_b","parentSessionId":"p","reapedAt":"2026-01-01T00:00:00.000Z"},"session:p\u0000g":{"tag":"g","sessionId":"sess_gone","reapedAt":"2026-01-01T00:00:00.000Z"}}}"#,
    );
    write(
        &data,
        "agent-workers-released.json",
        br#"{"version":1,"released":{"sess_a":"2026-01-02T00:00:00.000Z","sess_gone":"2026-01-02T00:00:00.000Z"}}"#,
    );
    write(&data, "goals/sess_a.json", br#"{"sessionId":"sess_a"}"#);
    write(&data, "goals/sess_gone.json", br#"{"sessionId":"sess_gone"}"#);
    write(
        &data,
        "mixdog-config.json",
        br#"{"agent":{"compaction":{"enabled":false,"semanticModel":"m"},"other":1,"mcpServers":{"notion":{"url":"https://mcp.notion.com/mcp","connector":"notion"},"notion-2":{"url":"https://mcp.notion.com/mcp","oauthKey":"2","connector":"notion"}}},"quotaResume":{"autoResume":false,"other":2}}"#,
    );
    write(&data, "agents/a/agent.json", br#"{"connectors":{"off":["notion-2"]}}"#);
    write(&data, "bots/b/agent.json", br#"{"connectors":{"off":["linear-2"]}}"#);
    write(&data, "connector-merge-pending.json", br#"{"merged":[{"name":"linear","from":["linear","linear-2"]}]}"#);
    write(&data, "connector-accounts-in-use.json", br#"{"notion":"notion-2"}"#);
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
    Migrator::new(roots.clone(), drivers(), MigrateOptions { workers: 1, fault, verified: None })
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
        "agent-workers-released.json",
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
    // The three late config rewrites land: the compaction keys fold, the connector merges (its accounts with their ids, which
    // the agents and the accounts in use then name), and the 1.4.5 quota switch, off, moves to `quotaAutoResume`
    // (its section keeps the other key).
    let config: Value = serde_json::from_slice(&std::fs::read(roots.data.join("mixdog-config.json")).unwrap()).unwrap();
    let accounts = config["agent"]["mcpServers"]["notion"]["accounts"].as_array().unwrap().clone();
    let id = |n: usize| accounts[n]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        config,
        json!({"agent":{"compaction":{"auto":false,"summaryModel":"m"},"other":1,"mcpServers":{"notion":{
            "type":"http","url":"https://connectors.mixdog.invalid/notion/mcp","connector":"notion","accounts":[
                {"name":"notion","url":"https://mcp.notion.com/mcp","id":id(0)},
                {"name":"notion-2","url":"https://mcp.notion.com/mcp","oauthKey":"2","id":id(1)}]}}},
            "quotaResume":{"other":2},"quotaAutoResume":false})
    );
    assert!(
        records.iter().any(|r| matches!(r, JournalRecord::Verified(v) if v.key.as_str() == "config/quotaResume.autoResume")),
        "the quota item is verified"
    );
    let read = |rel: &str| serde_json::from_slice::<Value>(&std::fs::read(roots.data.join(rel)).unwrap()).unwrap();
    assert_eq!(read("agents/a/agent.json"), json!({"connectors":{"off":["notion"]}}));
    assert_eq!(read("bots/b/agent.json"), json!({"connectors":{"off":["linear"]}}));
    assert_eq!(read("connector-accounts-in-use.json"), json!({"notion":{"name":"notion-2","id":id(1)},"#ids":true}));
    assert!(!roots.data.join("connector-merge-pending.json").exists());
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
    // Its tombstone and sess_a's release marker join the `worker` map; sess_gone's do not
    // migrate.
    assert_eq!(
        b.header["worker"],
        json!({"sessionId":"sess_b","ownerSessionId":" sess_a ","tag":"t","status":"idle","messages":[],
            "tombstone":{"tag":"t","parentSessionId":"p","reapedAt":"2026-01-01T00:00:00.000Z"}})
    );
    // Its header had no parent: the row's owner, cleaned, fills both links.
    assert_eq!(b.header["parentSessionId"], "sess_a");
    assert_eq!(b.header["ownerSessionId"], "sess_a");
    assert_eq!(b.rows.len(), 2);
    let a = crate::session::target::read_session(&cx, &roots.data.join("sessions/sess_a")).unwrap();
    assert_eq!(a.header["worker"], json!({"releasedAt":"2026-01-02T00:00:00.000Z"}));
    let queue: Vec<&str> = a.queue.iter().map(|q| q.0.as_str()).collect();
    assert_eq!(queue, ["q1", "q2"]);
    // 2 segment rows + 1 pending row + 4 messages + 2 recovered checkpoint rows, closed by
    // the partial answer and the restart marker.
    assert_eq!(a.rows.len(), 11);
    assert_eq!(a.runs[0].0, "ckpt:t1");
    assert_eq!(a.rows[9].body, json!({"role":"assistant","content":"pa"}));
    // The restart marker is the cancel line a restored transcript shows (`restore/mod.rs`).
    assert_eq!(
        a.rows[10].body,
        json!({"role":"user","content":"[Request interrupted by process restart]",
            "meta":{"turnEnd":{"status":"cancelled","elapsedMs":0}}})
    );
    assert!(a.rows[3].body["content"] == "hi \u{fffd} there");
    // The assistant's model switch is a record anchored on its row, out of the stored body.
    let switches: Vec<_> = log_records(&roots.data.join("sessions/sess_a"))
        .into_iter()
        .filter_map(|(ordinal, r)| match r {
            Record::ModelSwitch(s) => Some((ordinal, s)),
            Record::Item(i) if i.iid.as_str() == a.rows[4].iid => {
                assert!(serde_json::to_string(&i.body).unwrap().contains(r#""meta":{}"#));
                None
            }
            _ => None,
        })
        .collect();
    assert_eq!(switches.len(), 1);
    let (ordinal, switch) = &switches[0];
    assert_eq!((switch.anchor.iid.as_str(), switch.anchor.ordinal), (a.rows[4].iid.as_str(), a.rows[4].ordinal));
    assert_eq!(*ordinal, a.rows[4].ordinal + 1);
    assert_eq!(serde_json::to_value(&switch.entry).unwrap(), json!({"inline":{"provider":"openai","modelId":"gpt-5","at":11}}));
    assert_eq!(a.rows[4].body["meta"], json!({"modelSwitches":[{"provider":"openai","modelId":"gpt-5","at":11}]}));
    // A second run finds the completion marker.
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

/// Marker files naming no session that migrates are retired, journaled and removed: a
/// release marker of a session that is gone, and a tombstone without a `sessionId` whose
/// owner no session is.
#[test]
fn markers_of_sessions_that_do_not_migrate_are_retired() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    write(
        &roots.data,
        "agent-workers-released.json",
        br#"{"version":1,"released":{"sess_gone":"2026-01-02T00:00:00.000Z"}}"#,
    );
    write(
        &roots.data,
        "agent-workers.json",
        br#"{"version":2,"workers":{},"tombstones":[{"tag":"x","clientHostPid":7,"reapedAt":"2026-01-01T00:00:00.000Z"}]}"#,
    );
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let records = journal_records(&roots);
    for file in ["agent-workers-released.json", "agent-workers.json"] {
        let key = format!("retire/data/{file}");
        let item = manifest.items.iter().find(|i| i.key.as_str() == key).expect(&key);
        assert_eq!(item.contract, Contract::Retire);
        assert!(records.iter().any(|r| matches!(r, JournalRecord::Disposed(KeyEntry { key: k }) if k.as_str() == key)));
        assert!(!roots.data.join(file).exists());
    }
}

/// A tombstone without a `sessionId` goes to the one session Node's
/// `recoverTagTombstoneOwner` finds for it, with that session's owner; one with no such
/// session, or two, is dropped. Of two tombstones of one session the newer stays, and the
/// row's `released` goes (readers derive it from `releasedAt`).
#[test]
fn tombstones_reach_their_one_session() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let session = |id: &str, fields: &str| {
        write(&roots.data, &format!("sessions/{id}.json"), format!(r#"{{"id":"{id}",{fields},"messages":[]}}"#).as_bytes());
    };
    session("sess_d", r#""agentTag":"w","clientHostPid":42,"parentSessionId":"sess_a","createdAt":1000"#);
    session("sess_e", r#""agentTag":"v","clientHostPid":42,"ownerSessionId":"sess_a","createdAt":1000"#);
    session("sess_f", r#""agentTag":"v","clientHostPid":42.5,"parentSessionId":"sess_a","createdAt":"2000""#);
    write(
        &roots.data,
        "agent-workers.json",
        br#"{"version":2,"workers":{"sess_b":{"sessionId":"sess_b","tag":"t","released":true}},"tombstones":[
            {"tag":"w","clientHostPid":"42","reapedAt":"1970-01-01T00:00:05.000Z"},
            {"tag":"v","clientHostPid":42,"reapedAt":"1970-01-01T00:00:05.000Z"},
            {"tag":"w","clientHostPid":42,"reapedAt":"1970-01-01T00:00:00.500Z"},
            {"tag":"w","clientHostPid":42,"parentSessionId":"p","reapedAt":"1970-01-01T00:00:05.000Z"},
            {"tag":"t","sessionId":" sess_b ","reapedAt":"2026-01-01T00:00:00.000Z"},
            {"tag":"t2","sessionId":"sess_b","reapedAt":"2026-01-03T00:00:00.000Z"},
            {"tag":"t3","sessionId":"sess_b","reapedAt":"2026-01-02T00:00:00.000Z"}]}"#,
    );
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots: &roots,
        manifest: &manifest,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let worker = |id: &str| {
        let folded = crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id)).unwrap();
        folded.header.get("worker").cloned()
    };
    assert_eq!(
        worker("sess_d"),
        Some(json!({"tombstone":{"tag":"w","clientHostPid":"42","reapedAt":"1970-01-01T00:00:05.000Z",
            "parentSessionId":"sess_a","ownerSessionId":"sess_a"}}))
    );
    assert_eq!(worker("sess_e"), None);
    assert_eq!(worker("sess_f"), None);
    assert_eq!(
        worker("sess_b"),
        Some(json!({"sessionId":"sess_b","tag":"t","tombstone":{"tag":"t2","reapedAt":"2026-01-03T00:00:00.000Z"}}))
    );
    assert!(!roots.data.join("agent-workers.json").exists());
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

/// A copy of a conversation 1.4.5 made without a link to its source (a clear's fork) gets the reference set its
/// transcript names (`tool-results/<segment>/`, its system prompt included, its own left out) in its header, which the
/// prune's index reads; a session naming no other session's sidecars gets an empty one (known: it is not scanned).
#[test]
fn a_copy_without_a_link_gets_the_reference_set_its_transcript_names() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let sidecar = |id: &str| roots.data.join("tool-results").join(id).join("ab.txt").to_string_lossy().replace('\\', "\\\\");
    let fork = format!(
        r#"{{"id":"sess_fork","messages":[{{"role":"system","content":"rules at {}"}},{{"role":"user","content":"see {} and {}"}}]}}"#,
        sidecar("sess_other"),
        sidecar("sess_src"),
        sidecar("sess_fork")
    );
    write(&roots.data, "sessions/sess_fork.json", fork.as_bytes());
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots: &roots,
        manifest: &manifest,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let sources = |id: &str| crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id)).unwrap().header.get("offloadSources").cloned();
    assert_eq!(sources("sess_fork"), Some(json!(["sess_other", "sess_src"])));
    assert_eq!(sources("sess_b"), Some(json!([])), "a session naming no other session's sidecars holds an empty set, not none");
}

/// A session saved again after its turn opened, with a route change in that turn: the
/// migrated history is the one v1.4.5 recovery leaves (`session/vectors/checkpoint_splice.json`).
/// The record's messages past the boundary give way to the checkpoint's turn, closed as a
/// crash closes it, with its provider replay state dropped.
#[test]
fn a_recovered_turn_is_spliced_as_v145_recovery_does() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let cases: Value =
        serde_json::from_str(include_str!("../session/vectors/checkpoint_splice.cases.json")).unwrap();
    let golden: Value = serde_json::from_str(include_str!("../session/vectors/checkpoint_splice.json")).unwrap();
    let case = &cases["same_turn_save_route_changed"];
    write(&roots.data, "sessions/sess_c.json", case["durable"].to_string().as_bytes());
    write(&roots.data, "turn-checkpoints/sess_c.json", case["checkpoint"].to_string().as_bytes());
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots: &roots,
        manifest: &manifest,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let c = crate::session::target::read_session(&cx, &roots.data.join("sessions/sess_c")).unwrap();
    let bodies: Vec<&Value> = c.rows.iter().map(|r| &r.body).collect();
    let mut want = golden["same_turn_save_route_changed"]["messages"].clone();
    // The restart marker is the cancel line a restored transcript shows (`restore/mod.rs`).
    want.as_array_mut().unwrap().last_mut().unwrap()["meta"] =
        json!({"turnEnd":{"status":"cancelled","elapsedMs":0}});
    assert_eq!(serde_json::to_string(&bodies).unwrap(), serde_json::to_string(&want).unwrap());
    assert_eq!(c.runs[0].0, "ckpt:t2");
    assert!(!roots.data.join("turn-checkpoints/sess_c.json").exists());
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

/// A recovered turn whose context state v1.4.5 captured: the migrated header carries the
/// reading v1.4.5 recovery re-anchors (`session/vectors/checkpoint_restore.json`), the turn's
/// prefix baseline, and no active-turn marker.
#[test]
fn a_recovered_turn_restores_its_context_reading() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let golden: Value = serde_json::from_str(include_str!("../session/vectors/checkpoint_restore.json")).unwrap();
    // The stored text the signed prefix reads, in the preserved attachment store.
    let blob = golden["blob"].as_str().unwrap().as_bytes();
    let hex = durable::sha256_hex(blob);
    write(&roots.data, &format!("prompt-attachments/sha256/{}/{hex}", &hex[..2]), blob);
    write(&roots.data, "sessions/sess_r.json", golden["durable"].to_string().as_bytes());
    write(&roots.data, "turn-checkpoints/sess_r.json", golden["checkpoint"].to_string().as_bytes());
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots: &roots,
        manifest: &manifest,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let r = crate::session::target::read_session(&cx, &roots.data.join("sessions/sess_r")).unwrap();
    for (key, value) in golden["header"].as_object().unwrap() {
        assert_eq!(r.header.get(key), Some(value), "{key}");
    }
    for gone in ["activeTurnCheckpoint", "contextPressureUnanchoredAfterRestart", "contextPressureUnanchoredReason"] {
        assert!(!r.header.contains_key(gone), "{gone}");
    }
    assert_eq!(r.rows.len(), golden["messages"].as_array().unwrap().len());
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

/// Every journal transition and publication step of every kind: a kill before or after
/// it, then a resume, ends in the tree an uninterrupted run leaves (journal excluded).
#[test]
fn every_crash_point_resumes_to_the_same_tree() {
    // The trees compared are read back from the running OS; a flush to the device changes none of them.
    mixdog_store::fsio::elide_syncs();
    // One uninterrupted run names every fault point, in the order a run meets them.
    let base = crash_base(0);
    let _ = std::fs::remove_dir_all(&base);
    let roots = fixture(&base);
    let met = Arc::new(Mutex::new(Vec::<String>::new()));
    let record = met.clone();
    let recorder: FaultHook = Arc::new(move |p| {
        record.lock().unwrap().push(p.to_string());
        Ok(())
    });
    migrator(&roots, Some(recorder)).run().unwrap();
    std::fs::remove_dir_all(&base).unwrap();
    let points = met.lock().unwrap().clone();
    assert!(points.len() > 40, "{} fault points", points.len());
    // The connector transition is cut between each of its file publications.
    let connector = format!("publish:{}:", crate::connectors::ITEM);
    let publications = points.iter().filter(|p| p.starts_with(&connector)).count();
    assert!(publications >= 5, "{publications} connector publication points");

    std::thread::scope(|scope| {
        for worker in 0..CRASH_WORKERS {
            let points = &points;
            scope.spawn(move || resume_after_each_crash(points, worker));
        }
    });
}

/// Data dirs the fault points are split over. A crash and its resume share nothing with another
/// point's, and a run is bound by its journal and publication syncs, not by the processor, so
/// the points of different dirs overlap their waits.
const CRASH_WORKERS: usize = 8;

fn crash_base(worker: usize) -> PathBuf {
    std::env::temp_dir().join(format!("mig-same-{}-{worker}", std::process::id()))
}

/// Kills the migration at `points[worker]`, `points[worker + CRASH_WORKERS]`, ... in a dir of its
/// own, resumes it and compares the tree with that dir's uninterrupted run (the manifest names
/// the dir's roots, so the tree differs from dir to dir).
fn resume_after_each_crash(points: &[String], worker: usize) {
    let base = crash_base(worker);
    let _ = std::fs::remove_dir_all(&base);
    let roots = fixture(&base);
    migrator(&roots, None).run().unwrap();
    let want = tree_digest(&roots);
    std::fs::remove_dir_all(&base).unwrap();
    for (stop_at, expected) in points.iter().enumerate().skip(worker).step_by(CRASH_WORKERS) {
        let roots = fixture(&base);
        let calls = Arc::new(AtomicUsize::new(0));
        let hook_calls = calls.clone();
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
            other => panic!("the run was not interrupted at point {stop_at} ({expected}): {other:?}"),
        };
        assert_eq!(&point, expected, "point {stop_at}");
        migrator(&roots, None).run().unwrap_or_else(|e| panic!("resume after {point}: {e}"));
        let got = tree_digest(&roots);
        let diff: Vec<_> = want.keys().chain(got.keys()).filter(|k| want.get(*k) != got.get(*k)).collect();
        assert!(diff.is_empty(), "after a crash at {point}: {diff:?}");
        std::fs::remove_dir_all(&base).unwrap();
    }
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
    check_recording(&manifest);
    let sessions = manifest["scenarios"][scenario]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len() as u64, manifest["scenarios"][scenario]["sessionCount"].as_u64().unwrap());
    for s in sessions {
        let id = s["id"].as_str().unwrap();
        let folded = crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id))
            .unwrap_or_else(|e| panic!("{scenario}/{id}: {e}"));
        folded.observable(&cx).unwrap();
        check_session(&folded, &s["expected"], &format!("{scenario}/{id}"));
    }
}

/// One migrated session against what the corpus recorded for it. The migrated header's prompt blocks are what Node recorded
/// for the session's leading system messages; the transcript is then built from the migrated data alone: those blocks and
/// every model message row, the hidden ones (skill/hook, internal text) included, as the corpus digests cover the whole
/// 1.4.5 transcript.
fn check_session(folded: &crate::session::target::Folded, want: &Value, what: &str) {
    let system = header_system_messages(&folded.header);
    assert_system_messages(&system, &want["systemMessages"], what);
    let messages: Vec<Value> = system
        .into_iter()
        .chain(
            folded
                .rows
                .iter()
                .filter(|r| r.form == mixdog_store::schema::record::Form::Message && r.model)
                .map(|r| r.body.clone()),
        )
        .collect();
    let (count, transcript, header_digest) = corpus_digests(&folded.header, &messages);
    assert_eq!(count as u64, want["messageCount"].as_u64().unwrap(), "{what} count");
    assert_eq!(transcript, want["transcriptDigest"].as_str().unwrap(), "{what} transcript");
    assert_eq!(header_digest, want["headerDigest"].as_str().unwrap(), "{what} header");
}

const RECORDING_NODE_COMMIT: &str = "b6f10295a2f698afc85332467192de28500bd146";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-migration-system-messages.mjs";
const REGENERATE: &str = "node benchmarks/rust-core/recorders/record-migration-system-messages.mjs --tree <b6f10295a export with node_modules> --corpus <migration-corpus dir>";

fn repo_file_sha(path: &str) -> String {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").join(path);
    durable::sha256_hex(&std::fs::read(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display())))
}

/// The corpus's own digests, as the recorder folds them: its generation stamp and every session's transcript and header digest.
fn corpus_identity(manifest: &Value) -> String {
    let mut scenarios: Vec<_> = manifest["scenarios"].as_object().unwrap().iter().collect();
    scenarios.sort_by_key(|(name, _)| name.as_str());
    let mut lines = vec![manifest["generated"].as_str().unwrap().to_string()];
    for (name, scenario) in scenarios {
        for s in scenario["sessions"].as_array().unwrap() {
            let e = &s["expected"];
            lines.push(format!("{name}/{} {} {}", s["id"].as_str().unwrap(), e["transcriptDigest"].as_str().unwrap(), e["headerDigest"].as_str().unwrap()));
        }
    }
    sha(&lines.join("\n"))
}

/// The expectation (`expected.systemMessages`) is trusted only when this repository's recorder made it, from Node's
/// reader at the reference commit, over this corpus: the manifest's `systemMessagesRecording` names each.
fn check_recording(manifest: &Value) {
    let rec = manifest
        .get("systemMessagesRecording")
        .unwrap_or_else(|| panic!("the corpus manifest records no systemMessagesRecording (recorder version unknown): regenerate with `{REGENERATE}`"));
    let text = |k: &str| rec[k].as_str().unwrap_or("");
    assert_eq!(text("nodeCommit"), RECORDING_NODE_COMMIT, "the system messages were recorded from another Node commit: regenerate with `{REGENERATE}`");
    assert_eq!(text("recorder"), RECORDER, "the system messages were recorded by another recorder: regenerate with `{REGENERATE}`");
    let mut files = vec![(RECORDER.to_string(), text("recorderSha256").to_string())];
    files.extend(rec["inputs"].as_array().into_iter().flatten().map(|i| (i["path"].as_str().unwrap_or("").to_string(), i["sha256"].as_str().unwrap_or("").to_string())));
    for (path, recorded) in files {
        assert_eq!(repo_file_sha(&path), recorded, "the system messages were recorded by another recorder version ({path} differs): regenerate with `{REGENERATE}`");
    }
    assert_eq!(corpus_identity(manifest), text("corpusIdentity"), "the system messages were recorded over another corpus: regenerate with `{REGENERATE}`");
}

/// The leading system messages 1.4.5 had, as the migrated header's prompt blocks give them back (Node's message objects).
pub(crate) fn header_system_messages(header: &serde_json::Map<String, Value>) -> Vec<Value> {
    mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(header).node_messages()
}

/// The blocks of a migrated header against what Node recorded for the session (`expected.systemMessages`: each message's
/// cache tier and the sha256 of its text, in order).
fn assert_system_messages(blocks: &[Value], recorded: &Value, what: &str) {
    let got: Vec<Value> = blocks
        .iter()
        .map(|m| json!({"cacheTier": m.get("cacheTier").cloned().unwrap_or(Value::Null), "sha256": sha(m["content"].as_str().unwrap())}))
        .collect();
    let want: Vec<Value> = recorded
        .as_array()
        .unwrap_or_else(|| panic!("{what}: the corpus manifest records no systemMessages"))
        .iter()
        .map(|m| json!({"cacheTier": m["cacheTier"], "sha256": m["sha256"]}))
        .collect();
    assert_eq!(got, want, "{what}: prompt blocks");
}

/// A migrated session of the real corpus: `check_session`, the gate's own comparison, passes on it, and fails once a prompt
/// block of its migrated header is changed.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn a_corrupted_migrated_prompt_block_fails_the_gate_comparison() {
    let manifest: Value = serde_json::from_slice(&std::fs::read(corpus().join("manifest.json")).unwrap()).unwrap();
    let (_dir, roots, _complete) = migrate_corpus("v145", |_| {});
    let disk: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots: &roots,
        manifest: &disk,
        manifest_sha256: "",
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let s = manifest["scenarios"]["v145"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| !s["expected"]["systemMessages"].as_array().unwrap().is_empty())
        .expect("a corpus session with a system message");
    let id = s["id"].as_str().unwrap();
    let mut folded = crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id)).unwrap();
    check_session(&folded, &s["expected"], id);
    let key = mixdog_core_prompt::prompt::blocks::BASE_KEY;
    let base = folded.header[key].as_str().unwrap().to_string();
    folded.header.insert(key.to_string(), Value::String(format!("{base}!")));
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check_session(&folded, &s["expected"], id)))
        .expect_err("the comparison accepted a corrupted prompt block");
    let message = failed.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(message.contains("prompt blocks"), "failed for another reason: {message}");
}

#[test]
#[should_panic(expected = "another recorder version")]
fn an_expectation_of_another_recorder_version_is_refused() {
    let manifest = json!({"systemMessagesRecording": {
        "nodeCommit": RECORDING_NODE_COMMIT,
        "recorder": RECORDER,
        "recorderSha256": "0".repeat(64),
    }});
    check_recording(&manifest);
}

#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn gate_v145() {
    gate("v145", "v145", 1);
}

/// The v145 reaper tombstone and release marker of each migrated session land in its
/// `worker` map verbatim (`tombstone` without its `sessionId`, `releasedAt`), with every
/// field of its worker row but `released`; a second run under the same journal changes
/// nothing.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn v145_worker_markers_move_into_the_worker_map() {
    let source = corpus().join("v145");
    let read = |rel: &str| serde_json::from_slice::<Value>(&std::fs::read(source.join(rel)).unwrap()).unwrap();
    let index = read("agent-workers.json");
    let released = read("agent-workers-released.json");
    let lead = read("lead-workers.json");
    let (_dir, roots, complete) = migrate_corpus("v145", |_| {});
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{complete:?}");
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
    let mut tombstoned = 0;
    let mut marked = 0;
    let mut rows = 0;
    for item in disk.items.iter().filter(|i| i.kind == ItemKind::Session) {
        let id = item.key.as_str().strip_prefix("session/").unwrap();
        // Each corpus tombstone names a distinct session.
        let tombstone = index["tombstones"].as_object().unwrap().values().find(|t| t["sessionId"] == id).map(|t| {
            let mut t = t.as_object().unwrap().clone();
            t.shift_remove("sessionId");
            Value::Object(t)
        });
        let marker = released["released"].get(id);
        let folded = crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id)).unwrap();
        let worker = folded.header.get("worker");
        let field = |k: &str| worker.and_then(|w| w.get(k));
        tombstoned += usize::from(tombstone.is_some());
        assert_eq!(field("tombstone"), tombstone.as_ref(), "{id}");
        marked += usize::from(marker.is_some());
        assert_eq!(field("releasedAt"), marker, "{id}");
        // Every field of its worker row (agent index first) as the row has it, but `released`.
        let row = [&index, &lead]
            .into_iter()
            .find_map(|doc| doc["workers"].as_object()?.values().find(|r| r["sessionId"] == id));
        if let Some(row) = row {
            rows += 1;
            for (k, v) in row.as_object().unwrap() {
                let expected = (k != "released").then_some(v);
                assert_eq!(field(k), expected, "{id}.{k}");
            }
        }
    }
    // Every tombstone and release marker of the corpus's index files names a migrated session (a worker row
    // whose session record is gone is one too), and the loop above saw each of them.
    let migrated: std::collections::BTreeSet<&str> =
        disk.items.iter().filter(|i| i.kind == ItemKind::Session).filter_map(|i| i.key.as_str().strip_prefix("session/")).collect();
    let tombstones = index["tombstones"].as_object().unwrap().values().filter(|t| migrated.contains(t["sessionId"].as_str().unwrap())).count();
    let markers = released["released"].as_object().unwrap().keys().filter(|id| migrated.contains(id.as_str())).count();
    assert_eq!((tombstoned, marked), (tombstones, markers));
    assert!(tombstoned > 0 && marked > 0);
    assert!(rows > 0);
    for gone in ["agent-workers.json", "agent-workers-released.json"] {
        assert!(!roots.data.join(gone).exists(), "{gone}");
    }
    let again = Migrator::new(roots.clone(), drivers(), MigrateOptions::default()).run().unwrap();
    assert_eq!(again, complete);
}

/// A v145 agent session whose header lost its parent gets the link from its worker row
/// (Node's agent listing); the others keep theirs (`gate_v145` checks their headers).
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn v145_legacy_agent_sessions_get_their_parent_link() {
    const ID: &str = "sess_daemon_1793820141688_38d110060e784a52aa9c2668671040df";
    let index: Value =
        serde_json::from_slice(&std::fs::read(corpus().join("v145/agent-workers.json")).unwrap()).unwrap();
    let row = index["workers"].as_object().unwrap().values().find(|r| r["sessionId"] == ID).unwrap().clone();
    let (_dir, roots, complete) = migrate_corpus("v145", |data| {
        let path = data.join(format!("sessions/{ID}.json"));
        let mut text = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
        for key in ["parentSessionId", "ownerSessionId"] {
            let from = format!("\"{key}\":{}", row[key]);
            assert_eq!(text.matches(&from).count(), 1, "{from}");
            text = text.replace(&from, &format!("\"{key}\":null"));
        }
        std::fs::write(&path, text).unwrap();
    });
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{complete:?}");
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
    let folded = crate::session::target::read_session(&cx, &roots.data.join("sessions").join(ID)).unwrap();
    assert_eq!(folded.header["parentSessionId"], row["parentSessionId"]);
    assert_eq!(folded.header["ownerSessionId"], row["ownerSessionId"]);
}

/// The v145 corpus records no model switch; one session given two on the message 1.4.5
/// anchors them on (`set-route.mjs` `modelSwitchAnchorIndex`), one entry 1.4.5 would not
/// have written on an earlier assistant message, and on the assistant before that a switch
/// a later `workflowSwitches` follows in `meta` (`recordTranscriptBoundary` keeps the first
/// position of a list it extends). The two become `model_switch` records on the anchor's
/// item, in order; the other two stay in their messages; every body reads back with 1.4.5's
/// bytes, key order included (the session verifies), and a second run under the same
/// journal changes nothing.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn v145_model_switches_become_records() {
    const ID: &str = "sess_daemon_1793820141688_38d110060e784a52aa9c2668671040df";
    let switches = json!([
        {"provider": "openai", "modelId": "gpt-5", "at": 1793820200000_i64},
        {"provider": "anthropic", "modelId": "claude-opus-4-1", "at": 1793820300000_i64},
    ]);
    let odd = json!([{"provider": "openai", "modelId": "gpt-5", "at": 1793820100000_i64, "note": "x"}]);
    let followed = json!({
        "modelSwitches": [{"provider": "openai", "modelId": "gpt-5", "at": 1793820000000_i64}],
        "workflowSwitches": [{"from": "a", "to": "b", "at": 1793820050000_i64}],
    });
    let mut anchor = None;
    let mut kept = Vec::new();
    let (_dir, roots, complete) = migrate_corpus("v145", |data| {
        let path = data.join(format!("sessions/{ID}.json"));
        let mut doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let messages = doc["messages"].as_array_mut().unwrap();
        let role = |m: &Value| m["role"].as_str().unwrap_or_default().to_owned();
        let at = (0..messages.len()).rev().find(|&i| !["user", "system"].contains(&role(&messages[i]).as_str())).unwrap();
        let before = (0..at).rev().find(|&i| role(&messages[i]) == "assistant").unwrap();
        for (i, list) in [(at, &switches), (before, &odd)] {
            assert!(messages[i].pointer("/meta/modelSwitches").is_none());
            let message = messages[i].as_object_mut().unwrap();
            let meta = message.entry("meta").or_insert_with(|| json!({}));
            meta.as_object_mut().unwrap().insert("modelSwitches".into(), list.clone());
        }
        let ahead = (0..before).rev().find(|&i| role(&messages[i]) == "assistant").unwrap();
        let meta = messages[ahead].as_object_mut().unwrap().entry("meta").or_insert_with(|| json!({}));
        for (k, v) in followed.as_object().unwrap() {
            assert!(meta.as_object_mut().unwrap().insert(k.clone(), v.clone()).is_none());
        }
        anchor = Some(messages[at].clone());
        kept = vec![messages[before].clone(), messages[ahead].clone()];
        std::fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
    });
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{complete:?}");
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
    for (id, is_dir) in durable::list_dir(&roots.data.join("sessions")).unwrap() {
        let dir = roots.data.join("sessions").join(&id);
        if !is_dir || id == ID {
            continue;
        }
        assert!(!log_records(&dir).iter().any(|(_, r)| matches!(r, Record::ModelSwitch(_))), "{id}");
    }
    let dir = roots.data.join("sessions").join(ID);
    let folded = crate::session::target::read_session(&cx, &dir).unwrap();
    let bytes = |v: &Value| serde_json::to_string(v).unwrap();
    let row = |message: &Value| {
        let rows: Vec<_> = folded.rows.iter().filter(|r| bytes(&r.body) == bytes(message)).collect();
        assert_eq!(rows.len(), 1);
        (rows[0].iid.clone(), rows[0].ordinal)
    };
    let (anchor_iid, anchor_ordinal) = row(anchor.as_ref().unwrap());
    kept.iter().for_each(|message| drop(row(message)));
    let records: Vec<Value> = log_records(&dir)
        .into_iter()
        .filter_map(|(ordinal, r)| match r {
            Record::ModelSwitch(s) => {
                assert_eq!((s.anchor.iid.as_str(), s.anchor.ordinal), (anchor_iid.as_str(), anchor_ordinal));
                assert!(ordinal > anchor_ordinal);
                Some(serde_json::to_value(&s.entry).unwrap()["inline"].clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(Value::Array(records), switches);
    let again = Migrator::new(roots.clone(), drivers(), MigrateOptions::default()).run().unwrap();
    assert_eq!(again, complete);
}

/// The open index of a serving core, as far as the migration sees it: the sessions it was given, in the order it got
/// them, and a database holding their rows.
#[derive(Default)]
struct ServingStandIn {
    given: Mutex<Vec<String>>,
}

impl crate::index::ServingIndex for ServingStandIn {
    fn adopt(&self, data: &Path, session: &str) -> std::result::Result<(), String> {
        let mut given = self.given.lock().unwrap();
        given.push(session.to_owned());
        let mut held = given.clone();
        held.sort();
        held.dedup();
        let db = data.join(crate::index::INDEX_PATH);
        std::fs::create_dir_all(db.parent().unwrap()).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&db);
        TestProjector.project(data, &db, &held)
    }
}

impl IndexProjector for ServingStandIn {
    fn project(&self, _: &Path, db: &Path, _: &[String]) -> std::result::Result<(), String> {
        Err(format!("a serving core's migration built an index of its own at {}", db.display()))
    }

    fn serving(&self) -> Option<&dyn crate::index::ServingIndex> {
        Some(self)
    }
}

/// The first start after the update: the core serves once the front is settled (the settings rewritten, no session
/// converted, nothing disposed, no marker), and the sessions convert behind it, each handed to its index once verified.
/// What it completes with is what the one-shot run completes with.
#[test]
fn the_sessions_convert_behind_a_core_that_serves_from_the_front() {
    let whole = tempfile::tempdir().unwrap();
    let expected = migrator(&fixture(whole.path()), None).run().unwrap();

    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let index = Arc::new(ServingStandIn::default());
    let told: Arc<Mutex<Vec<String>>> = Arc::default();
    let serving = || {
        let told = told.clone();
        Migrator::new(
            roots.clone(),
            product_drivers(index.clone(), crate::session::context_blobs::testing::office(Arc::default())),
            MigrateOptions { workers: 1, fault: None, verified: Some(Arc::new(move |id| told.lock().unwrap().push(id.to_owned()))) },
        )
    };
    let Front::Pending(back) = serving().front().unwrap() else { panic!("the front completed a migration with sessions left") };
    let config: Value = serde_json::from_slice(&std::fs::read(roots.data.join("mixdog-config.json")).unwrap()).unwrap();
    assert_eq!(config["quotaAutoResume"], json!(false), "the settings a core composes from are rewritten");
    assert_eq!(back.sessions(), 2);
    for waiting in ["sessions/sess_a.json", "sessions/sess_b.log.jsonl", "agent-workers.json"] {
        assert!(roots.data.join(waiting).exists(), "{waiting} is a source of a session still to convert");
    }
    for absent in ["sessions/sess_a", "sessions/sess_b", "index/store.sqlite", COMPLETE_PATH] {
        assert!(!roots.data.join(absent).exists(), "{absent}");
    }
    assert!(told.lock().unwrap().is_empty());
    assert!(index.given.lock().unwrap().is_empty());

    // Both are listed as still to come; a person opens the second, which is then converted ahead of the first.
    let waiting = back.waiting();
    assert_eq!(waiting.pending(), ["sess_a", "sess_b"]);
    let opened = Arc::new(AtomicUsize::new(0));
    let there = opened.clone();
    assert!(waiting.first("sess_b", Box::new(move || drop(there.fetch_add(1, Ordering::SeqCst)))));
    assert!(!waiting.first("sess_gone", Box::new(|| panic!("no session of the migration"))));

    // The serving core writes a cache under a name 1.4.5 used too: the file is the core's now, and stays.
    write(&roots.data, "client-versions.json", br#"{"core":1}"#);
    let complete = back.run().unwrap();
    assert_eq!(complete.kinds, expected.kinds);
    assert_eq!(std::fs::read(roots.data.join("client-versions.json")).unwrap(), br#"{"core":1}"#);
    assert_eq!(*told.lock().unwrap(), ["sess_b", "sess_a"]);
    assert_eq!(opened.load(Ordering::SeqCst), 1, "the open that asked was told once");
    assert!(waiting.pending().is_empty());
    assert!(!waiting.first("sess_a", Box::new(|| panic!("settled already"))));
    for gone in ["sessions/sess_a.json", "sessions/sess_b.log.jsonl", "agent-workers.json"] {
        assert!(!roots.data.join(gone).exists(), "{gone}");
    }
    for present in ["sessions/sess_a/log.000000", "sessions/sess_b/log.000000"] {
        assert!(roots.data.join(present).exists(), "{present}");
    }
    assert!(matches!(serving().front().unwrap(), Front::Complete(again) if again == complete));
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
