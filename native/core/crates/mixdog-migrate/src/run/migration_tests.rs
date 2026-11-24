//! The migration of a 1.4.5 data dir holding every data kind, built by [`fixture`]: what each kind becomes, the crash
//! matrix, and the rename-failure retry; and the helpers the other migration tests share.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures build and inspect data dirs with blocking std::fs and rusqlite")]

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::bounded::Id;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::record::DraftRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::sql::INDEX_DDL;
use mixdog_store::schema::sql::session_id_key;
use serde_json::Value;
use serde_json::json;
use sha1::Digest as _;

use super::*;
use crate::index::IndexProjector;

/// The test stand-in of the store's catalog writer: the projection-state columns only.
pub(crate) struct TestProjector;

impl IndexProjector for TestProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> std::result::Result<(), String> {
        let conn = rusqlite::Connection::open(db).map_err(|e| e.to_string())?;
        // Each statement of the DDL is a commit of its own, flushed unless the flushes are skipped.
        conn.pragma_update(None, "synchronous", mixdog_store::fsio::sqlite_synchronous()).map_err(|e| e.to_string())?;
        conn.execute_batch(INDEX_DDL).map_err(|e| e.to_string())?;
        for id in sessions {
            let dir = data.join("sessions").join(id);
            let mut files: Vec<_> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.map(|e| e.unwrap().path()).collect();
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

/// A catalog writer behind a serving core: `adopt` records the session and gives it a row of the core's own index.
struct ServingProjector {
    adopted: Mutex<Vec<String>>,
}

impl IndexProjector for ServingProjector {
    fn project(&self, _data: &Path, _db: &Path, _sessions: &[String]) -> std::result::Result<(), String> {
        unreachable!("a serving index builds no database of its own")
    }

    fn serving(&self) -> Option<&dyn crate::index::ServingIndex> {
        Some(self)
    }
}

impl crate::index::ServingIndex for ServingProjector {
    fn adopt(&self, data: &Path, session: &str) -> std::result::Result<(), String> {
        self.adopted.lock().unwrap().push(session.to_owned());
        let db = data.join(crate::index::INDEX_PATH);
        std::fs::create_dir_all(db.parent().unwrap()).map_err(|e| e.to_string())?;
        let conn = rusqlite::Connection::open(db).map_err(|e| e.to_string())?;
        let made: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name = 'sessions'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if made == 0 {
            conn.execute_batch(INDEX_DDL).map_err(|e| e.to_string())?;
        }
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, dirty, status, deleted, log_id, newest_file_no, projected_file_no,
                projected_offset, projected_ordinal, history_rev, row_count, visible_count, activity, closed,
                archived, id_key, title_fold, id_fold, summary)
             VALUES (?1, 0, 'ok', 0, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?2, '', ?1, '{}')",
            rusqlite::params![session, session_id_key(session)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub(crate) fn drivers() -> Vec<Arc<dyn ItemDriver>> {
    product_drivers(Arc::new(TestProjector), crate::session::context_blobs::testing::office(Arc::default()))
}

/// Paths and bytes of every file under the roots, the journal excluded (its frames lie in the order the converters wrote
/// them), and what the journal holds of each session's sources.
pub(crate) fn tree_digest(roots: &MigrationRoots) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> =
        journaled_sources(roots).into_iter().map(|(key, sources)| (format!("sources of {key}"), serde_json::to_string(&sources).unwrap())).collect();
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
pub(crate) fn log_records(dir: &Path) -> Vec<(u64, Record)> {
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

pub(crate) fn fixture(root: &Path) -> MigrationRoots {
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
    write(&data, "agent-workers-released.json", br#"{"version":1,"released":{"sess_a":"2026-01-02T00:00:00.000Z","sess_gone":"2026-01-02T00:00:00.000Z"}}"#);
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
    // A 1.4.5 ledger: exactly the objects 1.4.5 created, no row, no import cursor.
    std::fs::create_dir_all(data.join("usage")).unwrap();
    let ledger = rusqlite::Connection::open(data.join("usage/ledger.sqlite")).unwrap();
    ledger.execute_batch(mixdog_store::schema::sql::LEDGER_V2_BASE).unwrap();
    ledger.pragma_update(None, "user_version", 2).unwrap();
    write(&data, "usage-rollup.local.json", b"{}");
    write(&home, "projects.json", b"{}");
    MigrationRoots { data, home, profile: None }
}

/// The entries `want` and `got` do not hold alike.
fn tree_diff<'a>(want: &'a BTreeMap<String, String>, got: &'a BTreeMap<String, String>) -> Vec<&'a String> {
    want.keys().chain(got.keys()).filter(|k| want.get(*k) != got.get(*k)).collect()
}

pub(crate) fn migrator(roots: &MigrationRoots, fault: Option<FaultHook>) -> Migrator {
    Migrator::new(roots.clone(), drivers(), MigrateOptions { workers: 1, fault, verified: None, retention: None })
}

/// The `reason.json` bodies of unexpected quarantines.
pub(crate) fn unexpected_reasons(roots: &MigrationRoots) -> Vec<Value> {
    let dir = roots.data.join("quarantine");
    durable::walk_files(&dir)
        .unwrap()
        .into_iter()
        .filter(|rel| rel.ends_with("reason.json"))
        .map(|rel| serde_json::from_slice::<Value>(&std::fs::read(dir.join(rel)).unwrap()).unwrap())
        .filter(|reason| reason["expected"] == false)
        .collect()
}

pub(crate) fn journal_records(roots: &MigrationRoots) -> Vec<JournalRecord> {
    let bytes = std::fs::read(roots.data.join(JOURNAL_PATH)).unwrap();
    let (frames, _) = crate::frame::scan(&bytes, 0);
    frames.iter().map(|f| serde_json::from_slice(&bytes[f.payload.clone()]).unwrap()).collect()
}

/// The sources the journal holds of each item it was given them for (none before the migration began).
pub(crate) fn journaled_sources(roots: &MigrationRoots) -> BTreeMap<String, Vec<SourceFile>> {
    if !roots.data.join(JOURNAL_PATH).exists() {
        return BTreeMap::new();
    }
    let mut sources = BTreeMap::new();
    for record in journal_records(roots) {
        if let JournalRecord::Sources(entry) = record {
            assert!(sources.insert(entry.key.as_str().to_owned(), entry.sources).is_none(), "{} has its sources journaled twice", entry.key.as_str());
        }
    }
    sources
}

const REJECTED_SOURCE: &str = "legacy/reason.json";

struct RejectTarget(&'static str);
impl ItemDriver for RejectTarget {
    fn plan(&self, _roots: &MigrationRoots, sink: &mut PlanSink) -> Result<()> {
        let source = sink.source(Root::Data, self.0, false)?;
        sink.add_item(crate::plan::item("probe", KindGroup::Data, ItemKind::Index, Contract::Convert, vec![source], None)?)
    }
    fn owns(&self, item: &ManifestItem) -> bool {
        item.key.as_str() == "probe"
    }
    fn wave(&self, _item: &ManifestItem) -> Wave {
        Wave::Stores
    }
    fn stage(&self, _cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<Staged> {
        Ok(Staged::Output { output_sha256: durable::sha256_hex(b"candidate"), replaced_surrogates: 0 })
    }
    fn publish(&self, cx: &ItemContext<'_>, _item: &ManifestItem, _staged: &StagedEntry) -> Result<()> {
        durable::publish_file(&cx.roots.data.join("candidate"), b"candidate")
    }
    fn verify(&self, cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<Verdict> {
        durable::read(&cx.roots.data.join("candidate"))?;
        Ok(Verdict::Quarantine { code: QuarantineCode::DigestMismatch, detail: "test rejected the candidate".into() })
    }
    fn withdraw(&self, cx: &ItemContext<'_>, _item: &ManifestItem) -> Result<()> {
        durable::remove_file(&cx.roots.data.join("candidate")).map(drop)
    }
}

#[test]
fn quarantine_resumes_after_withdrawal_without_verifying_the_deleted_target() {
    let source = REJECTED_SOURCE;
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().to_path_buf();
    let roots = MigrationRoots { data: data.clone(), home: data.clone(), profile: None };
    write(&data, source, b"legacy");
    let run =
        |fault: Option<FaultHook>| Migrator::new(roots.clone(), vec![Arc::new(RejectTarget(source))], MigrateOptions { fault, ..Default::default() }).run();
    let cut = "journal:quarantined:probe:before";
    assert_eq!(
        run(Some(Arc::new(move |point| { if point == cut { Err(Blocked::Interrupted { point: point.into() }) } else { Ok(()) } }))).unwrap_err(),
        Blocked::Interrupted { point: cut.into() }
    );
    assert!(!data.join("candidate").exists());
    assert_eq!(std::fs::read(data.join(source)).unwrap(), b"legacy");

    let complete = run(None).unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 1);
    let dir = data.join("quarantine/digest_mismatch/probe");
    let reason: QuarantineReason = serde_json::from_slice(&std::fs::read(dir.join("reason.json")).unwrap()).unwrap();
    assert_eq!(reason.sources[0].path, source);
    assert_eq!(std::fs::read(dir.join("source-0")).unwrap(), b"legacy");
    assert!(!data.join(source).exists());
}

#[test]
fn a_writer_publishing_during_a_serving_quarantine_keeps_its_file() {
    let source = REJECTED_SOURCE;
    let serving = tempfile::tempdir().unwrap();
    let data = serving.path().to_path_buf();
    let roots = MigrationRoots { data: data.clone(), home: data.clone(), profile: None };
    write(&data, source, b"legacy");
    let replacement = data.join(source);
    let fault: FaultHook = Arc::new(move |point| {
        if point == "move:probe:before" {
            durable::publish_file(&replacement, b"new writer")?;
        }
        Ok(())
    });
    let options = MigrateOptions { fault: Some(fault), verified: Some(Arc::new(|_| {})), ..Default::default() };
    Migrator::new(roots, vec![Arc::new(RejectTarget(source))], options).run().unwrap();
    assert_eq!(std::fs::read(data.join(source)).unwrap(), b"new writer");
    assert!(!data.join("quarantine/digest_mismatch/probe/source-0").exists());
}

#[test]
fn a_cut_quarantine_copy_resumes_with_the_live_name_gone_or_replaced() {
    let source = REJECTED_SOURCE;
    for replacement in [None, Some(b"new writer".as_slice())] {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().to_path_buf();
        let roots = MigrationRoots { data: data.clone(), home: data.clone(), profile: None };
        let live = data.join(source);
        write(&data, source, b"legacy");
        let run = |fault| {
            let options = MigrateOptions { fault, verified: Some(Arc::new(|_| {})), ..Default::default() };
            Migrator::new(roots.clone(), vec![Arc::new(RejectTarget(source))], options).run()
        };
        let cut = "quarantine-copy:probe:source-0:verified";
        let fault: FaultHook = Arc::new(move |point| if point == cut { Err(Blocked::Interrupted { point: cut.into() }) } else { Ok(()) });
        assert_eq!(run(Some(fault)).unwrap_err(), Blocked::Interrupted { point: cut.into() });
        assert!(!journal_records(&roots).iter().any(|record| matches!(record, JournalRecord::Disposed(_))));
        match replacement {
            Some(bytes) => std::fs::write(&live, bytes).unwrap(),
            None => std::fs::remove_file(&live).unwrap(),
        }
        run(None).unwrap();
        assert_eq!(std::fs::read(data.join("quarantine/digest_mismatch/probe/source-0")).unwrap(), b"legacy");
        assert_eq!(durable::read_optional(&live).unwrap().as_deref(), replacement);
    }
}

#[test]
fn classification_reads_a_log_only_home_and_rejects_changed_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().to_path_buf();
    let roots = MigrationRoots { data: data.clone(), home: data.clone(), profile: None };
    let path = "sessions/sess_home_buddy.log.jsonl";
    let base = json!({"t":"session","s":0,"v":1,"logId":"legacy","id":"sess_home_buddy","prev":null,
        "legacy":null,"header":{"model":"from-log"}});
    let rows = json!({"t":"compacted","s":1,"len":1,"messages":[{"role":"user","content":"creation greeting"}]});
    write(&data, path, format!("{base}\n{rows}\n").as_bytes());
    let Front::Pending(back) = migrator(&roots, None).front().unwrap() else { panic!("pending home") };
    let homes = back.home_evidence(|header, messages| (header["model"].clone(), messages[0]["content"].clone())).unwrap();
    assert_eq!(homes.get("buddy"), Some(&(json!("from-log"), json!("creation greeting"))));
    write(&data, path, b"changed after planning");
    assert!(matches!(back.home_evidence(|_, _| ()), Err(Blocked::SourceChanged { .. })));
}

/// A home whose history does not read is no evidence for the classification and does not stop the start: its conversion
/// quarantines it as it does any damaged session, and the migration completes.
#[test]
fn a_damaged_home_is_no_evidence_and_is_quarantined_by_its_conversion() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().to_path_buf();
    let roots = MigrationRoots { data: data.clone(), home: data.clone(), profile: None };
    write(&data, "sessions/sess_home_buddy.json", b"{broken");
    write(&data, "sessions/sess_home_pal.json", br#"{"id":"sess_home_pal","model":"m","messages":[{"role":"user","content":"hello"}]}"#);
    let Front::Pending(back) = migrator(&roots, None).front().unwrap() else { panic!("pending homes") };

    let homes = back.home_evidence(|header, _| header.get("model").cloned()).unwrap();

    assert_eq!(homes, BTreeMap::from([("pal".to_owned(), Some(json!("m")))]));
    back.run().unwrap();
    assert!(quarantine_dir(&data, QuarantineCode::ParseError, "session/sess_home_buddy").join(REASON_FILE).exists());
    assert!(data.join("sessions/sess_home_pal").is_dir());
}

/// The front a core waits for names a session's own files and hashes none of them; the files several sessions read are
/// hashed there, once. A session's sizes and hashes are journaled when it is converted, ahead of its `staged` frame,
/// and are those of the files as they lay.
#[test]
fn the_front_hashes_no_session_and_each_session_is_journaled_before_it_is_staged() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let Front::Pending(back) = migrator(&roots, None).front().unwrap() else { panic!("the sessions are left") };
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let a = manifest.items.iter().find(|i| i.key.as_str() == "session/sess_a").unwrap();
    assert!(a.sources.is_empty(), "{:?}", a.sources);
    let named: Vec<&str> = a.late_sources.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(
        named,
        [
            "sessions/sess_a.compaction-archive.jsonl",
            "sessions/sess_a.compaction-archive.pending",
            "sessions/sess_a.json",
            "turn-checkpoints/sess_a.json",
            "turn-checkpoints/sess_a.jsonl"
        ]
    );
    assert_eq!(journaled_sources(&roots), BTreeMap::new(), "the front journaled a session's sources");
    for shared in ["agent-workers.json", "agent-workers-released.json", "session-pending/sess_a.json"] {
        let file = &manifest.shared.iter().find(|s| s.file.path == shared).unwrap_or_else(|| panic!("{shared} is not shared")).file;
        assert_eq!((file.size, file.sha256.clone()), durable::hash_file(&roots.data.join(shared)).unwrap(), "{shared}");
    }
    let as_they_lay: Vec<(String, (u64, String))> = named.iter().map(|rel| (rel.to_string(), durable::hash_file(&roots.data.join(rel)).unwrap())).collect();

    back.run().unwrap();
    let records = journal_records(&roots);
    for key in ["session/sess_a", "session/sess_b"] {
        let sources = records.iter().position(|r| matches!(r, JournalRecord::Sources(e) if e.key.as_str() == key)).unwrap_or_else(|| panic!("{key}"));
        let staged = records.iter().position(|r| matches!(r, JournalRecord::Staged(e) if e.key.as_str() == key)).unwrap_or_else(|| panic!("{key}"));
        assert!(sources < staged, "{key}: sources at frame {sources}, staged at frame {staged}");
    }
    let journaled: Vec<(String, (u64, String))> =
        journaled_sources(&roots)["session/sess_a"].iter().map(|s| (s.path.clone(), (s.size, s.sha256.clone()))).collect();
    assert_eq!(journaled, as_they_lay);
}

/// A session's source that changes after its size and hash were journaled is refused by the run that goes on and by a
/// run that resumes it: nothing of the session is published, and the changed file stays.
#[test]
fn a_source_changed_after_it_was_journaled_is_refused_by_the_run_that_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let cut = "journal:sources:session/sess_a:after";
    let stopped = migrator(&roots, Some(Arc::new(move |p: &str| if p == cut { Err(Blocked::Interrupted { point: p.into() }) } else { Ok(()) }))).run();
    assert_eq!(stopped.unwrap_err(), Blocked::Interrupted { point: cut.into() });
    let path = roots.data.join("sessions/sess_a.json");
    let changed = String::from_utf8(std::fs::read(&path).unwrap()).unwrap().replacen(r#""title":"A""#, r#""title":"B""#, 1);
    std::fs::write(&path, &changed).unwrap();

    for _ in 0..2 {
        let refused = migrator(&roots, None).run();
        assert!(matches!(&refused, Err(Blocked::SourceChanged { path: found }) if *found == path), "{refused:?}");
        assert!(!roots.data.join("sessions/sess_a").exists(), "the changed session was published");
        assert!(!roots.data.join(COMPLETE_PATH).exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), changed, "the source stays as it is");
    }
}

/// Disposal removes a session's source only while it is the file whose size and hash were journaled. One written anew
/// after the session was verified blocks a one-shot run before anything of that session is removed, and behind a serving
/// core it is the core's and stays.
#[test]
fn disposal_keeps_a_session_source_that_is_not_the_journaled_one() {
    for serving in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let roots = fixture(dir.path());
        let (path, log) = (roots.data.join("sessions/sess_b.json"), roots.data.join("sessions/sess_b.log.jsonl"));
        let rewritten = path.clone();
        let hook: FaultHook = Arc::new(move |point| {
            if point == "counts:after" {
                std::fs::write(&rewritten, b"written after the session was verified").unwrap();
            }
            Ok(())
        });
        let options = MigrateOptions { workers: 1, fault: Some(hook), verified: serving.then(|| Arc::new(|_: &str| {}) as VerifiedHook), retention: None };
        let result = Migrator::new(roots.clone(), drivers(), options).run();
        if serving {
            result.unwrap();
            assert!(!log.exists(), "the source that still matched was removed");
        } else {
            assert!(matches!(&result, Err(Blocked::SourceChanged { path: found }) if *found == path), "{result:?}");
            assert!(log.exists(), "nothing of the session was removed");
        }
        assert_eq!(std::fs::read(&path).unwrap(), b"written after the session was verified", "serving {serving}");
    }
}

/// A session the user deletes after it was converted, while the rest convert behind the serving core, is not brought
/// into the index and does not keep the migration from completing.
#[test]
fn a_session_deleted_during_the_background_migration_is_not_adopted_and_does_not_block_completion() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let projector = Arc::new(ServingProjector { adopted: Mutex::default() });
    let drivers = product_drivers(projector.clone(), crate::session::context_blobs::testing::office(Arc::default()));
    let data = roots.data.clone();
    let verified: VerifiedHook = Arc::new(move |id: &str| {
        if id == "sess_b" {
            std::fs::remove_dir_all(data.join("sessions").join(id)).unwrap();
        }
    });
    let options = MigrateOptions { workers: 1, fault: None, verified: Some(verified), retention: None };

    Migrator::new(roots.clone(), drivers, options).run().unwrap();

    assert!(roots.data.join(COMPLETE_PATH).exists(), "the migration completes");
    let adopted = projector.adopted.lock().unwrap().clone();
    assert!(!adopted.is_empty() && !adopted.iter().any(|id| id == "sess_b"), "{adopted:?}");
}

/// A session the serving core writes to once it is converted (here a draft, a record a migration never writes) does not
/// keep the migration from completing: its dangling references are the ones counted when it was verified.
#[test]
fn a_session_the_serving_core_writes_to_is_counted_as_it_was_verified() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let projector = Arc::new(ServingProjector { adopted: Mutex::default() });
    let drivers = product_drivers(projector, crate::session::context_blobs::testing::office(Arc::default()));
    let data = roots.data.clone();
    let verified: VerifiedHook = Arc::new(move |id: &str| {
        let session = data.join("sessions").join(id);
        let next = log_records(&session).last().map_or(0, |(ordinal, _)| ordinal + 1);
        let newest =
            (0..).map(|no| session.join(format!("{}{no:06}", mixdog_store::schema::frame::LOG_FILE_PREFIX))).take_while(|path| path.exists()).last().unwrap();
        let draft = Record::Draft(DraftRecord { rid: Id::try_from("r1").unwrap(), body: Slot::Inline(json!({"text": "half typed"})) });
        let mut log = std::fs::OpenOptions::new().append(true).open(newest).unwrap();
        log.write_all(&crate::frame::encode(next, &serde_json::to_vec(&draft).unwrap())).unwrap();
    });
    let options = MigrateOptions { workers: 1, fault: None, verified: Some(verified), retention: None };

    let complete = Migrator::new(roots.clone(), drivers, options).run().unwrap();

    // One dangling attachment, one goal of a session that does not exist, as a run nobody writes behind counts them.
    assert_eq!(complete.kinds.data.dangling, 2, "{complete:?}");
    assert!(matches!(log_records(&roots.data.join("sessions/sess_a")).last(), Some((_, Record::Draft(_)))), "the core's draft is there");
}

/// A session opened while the others wait is converted ahead of them, to the bytes it gets in its turn: the whole tree,
/// the journaled sources included, is the one a run that converts it last leaves.
#[test]
fn a_session_asked_for_first_is_converted_to_the_bytes_of_its_turn() {
    let dir = tempfile::tempdir().unwrap();
    // The manifest names the dir a run was in: both runs are in `base`.
    let base = dir.path().join("run");
    let serving = |ask: Option<&str>| {
        let _ = std::fs::remove_dir_all(&base);
        let roots = fixture(&base);
        let order = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = order.clone();
        let verified: VerifiedHook = Arc::new(move |id: &str| seen.lock().unwrap().push(id.to_owned()));
        let options = MigrateOptions { workers: 1, fault: None, verified: Some(verified), retention: None };
        let Front::Pending(back) = Migrator::new(roots.clone(), drivers(), options).front().unwrap() else { panic!("the sessions are left") };
        if let Some(id) = ask {
            assert!(back.waiting().first(id, Box::new(|| {})), "{id} is still to convert");
        }
        back.run().unwrap();
        let order = order.lock().unwrap().clone();
        (order, tree_digest(&roots))
    };
    let (in_turn, want) = serving(None);
    assert!(in_turn.len() > 1, "{in_turn:?}");
    let last = in_turn.last().unwrap().clone();
    let (asked, got) = serving(Some(&last));
    assert_eq!(asked[0], last, "the session asked for is converted first");
    let diff = tree_diff(&want, &got);
    assert!(diff.is_empty(), "{last} converted first and last differ in {diff:?}");
}

fn migrated_fixture() -> (tempfile::TempDir, MigrationRoots, mixdog_store::schema::migration::Complete) {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let complete = migrator(&roots, None).run().unwrap();
    (dir, roots, complete)
}

fn read_migrated_session(roots: &MigrationRoots, complete: &mixdog_store::schema::migration::Complete, id: &str) -> crate::session::target::Folded {
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let cx = ItemContext {
        roots,
        manifest: &manifest,
        manifest_sha256: &complete.manifest_sha256,
        fault: None,
        workers: 1,
        blobs: &blobs,
        states: &states,
        recorded: None,
    };
    crate::session::target::read_session(&cx, &roots.data.join("sessions").join(id)).unwrap()
}

#[test]
fn the_fixture_migrates_every_kind_and_disposes_its_sources() {
    let (_dir, roots, complete) = migrated_fixture();
    let c = &complete.kinds.data;
    assert_eq!(c.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
    // The set-aside json, and the legacy usage file the genuine 1.4.5 ledger (no
    // `importedThrough`) has not imported yet.
    assert_eq!(c.retained, 2, "{complete:?}");
    // One dangling attachment, one goal of a session that does not exist.
    assert_eq!(c.dangling, 2, "{complete:?}");
    let replaced: u64 = journal_records(&roots)
        .iter()
        .filter_map(|r| match r {
            JournalRecord::Staged(s) if s.key.as_str() == "session/sess_a" => Some(s.replaced_surrogates),
            _ => None,
        })
        .sum();
    assert_eq!(replaced, 1);
    for gone in [
        "sessions/sess_a.json",
        "sessions/sess_b.log.jsonl",
        "session-pending/sess_a.json",
        "agent-workers.json",
        "agent-workers-released.json",
        "turn-checkpoints/sess_zzz.jsonl",
        "client-versions.json",
    ] {
        assert!(!roots.data.join(gone).exists(), "{gone}");
    }
    for present in ["sessions/sess_a/log.000000", "sessions/sess_b/log.000000", "goals/sess_gone.json", "index/store.sqlite"] {
        assert!(roots.data.join(present).exists(), "{present}");
    }
    assert!(roots.data.join("quarantine/carried_set_aside/retain%2Fdata%2Fsessions%2Fsess_c.json.corrupt-123/sess_c.json.corrupt-123").exists());
}

#[test]
fn a_second_run_of_a_migrated_fixture_finds_the_completion_marker() {
    let (_dir, roots, complete) = migrated_fixture();
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

/// A legacy usage file the ledger has not imported (no `importedThrough`) is retained where the usage history import reads
/// it: disposal leaves it in place, its reason in the quarantine folder.
#[test]
fn usage_files_the_ledger_has_not_imported_stay_where_the_import_reads_them() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let backup = "usage-rollup.local.json.migrated.bak";
    write(&roots.data, backup, br#"{"days":{}}"#);

    let complete = migrator(&roots, None).run().unwrap();

    assert_eq!(complete.kinds.data.retained, 3, "{complete:?}");
    for (rel, bytes) in [("usage-rollup.local.json", b"{}".as_slice()), (backup, br#"{"days":{}}"#.as_slice())] {
        assert_eq!(std::fs::read(roots.data.join(rel)).unwrap(), bytes, "{rel}");
        let reasons = quarantine_dir(&roots.data, QuarantineCode::LedgerImportIncomplete, &crate::plan::retain_key(Root::Data, rel));
        assert!(reasons.join(REASON_FILE).exists(), "{rel}");
        assert!(!reasons.join(rel).exists(), "{rel} was moved aside");
    }
}

/// The kind stamp's record stays where the core reads it: without it the core stamps the agents again, after the worker
/// index that stamp reads is gone.
#[test]
fn the_agent_kind_record_stays_where_the_core_reads_it() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let record = br#"{"version":1,"completedAt":"2026-01-01T00:00:00.000Z","stamped":[],"restored":[]}"#;
    write(&roots.data, "agent-kind-migration.json", record);

    migrator(&roots, None).run().unwrap();

    assert_eq!(std::fs::read(roots.data.join("agent-kind-migration.json")).unwrap(), record);
    assert!(!roots.data.join("agent-workers.json").exists(), "the worker index the stamp reads is gone");
}

/// The 1.4.5 quota switch stays where 1.4.5 keeps it.
#[test]
fn the_late_config_rewrites_fold_compaction_keys_and_merge_connectors() {
    let (_dir, roots, _complete) = migrated_fixture();
    let config: Value = serde_json::from_slice(&std::fs::read(roots.data.join("mixdog-config.json")).unwrap()).unwrap();
    let accounts = config["agent"]["mcpServers"]["notion"]["accounts"].as_array().unwrap().clone();
    let id = |n: usize| accounts[n]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        config,
        json!({"agent":{"compaction":{"auto":false,"summaryModel":"m"},"other":1,"mcpServers":{"notion":{
            "type":"http","url":"https://connectors.mixdog.invalid/notion/mcp","connector":"notion","accounts":[
                {"name":"notion","url":"https://mcp.notion.com/mcp","id":id(0)},
                {"name":"notion-2","url":"https://mcp.notion.com/mcp","oauthKey":"2","id":id(1)}]}}},
            "quotaResume":{"autoResume":false,"other":2}})
    );
    let read = |rel: &str| serde_json::from_slice::<Value>(&std::fs::read(roots.data.join(rel)).unwrap()).unwrap();
    assert_eq!(read("agents/a/agent.json"), json!({"connectors":{"off":["notion"]}}));
    assert_eq!(read("bots/b/agent.json"), json!({"connectors":{"off":["linear"]}}));
    assert_eq!(read("connector-accounts-in-use.json"), json!({"notion":{"name":"notion-2","id":id(1)},"#ids":true}));
    assert!(!roots.data.join("connector-merge-pending.json").exists());
}

#[test]
fn a_dev_pair_folds_its_log_with_the_worker_row_as_a_meta() {
    let (_dir, roots, complete) = migrated_fixture();
    let b = read_migrated_session(&roots, &complete, "sess_b");
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
}

#[test]
fn a_json_session_keeps_its_queue_and_recovers_its_checkpoint_rows() {
    let (_dir, roots, complete) = migrated_fixture();
    let a = read_migrated_session(&roots, &complete, "sess_a");
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
            "meta":{"turnEnd":{"status":"cancelled","elapsedMs":0,"cause":"restart"}}})
    );
    assert!(a.rows[3].body["content"] == "hi \u{fffd} there");
}

#[test]
fn an_assistant_model_switch_is_a_record_anchored_on_its_row_out_of_the_stored_body() {
    let (_dir, roots, complete) = migrated_fixture();
    let a = read_migrated_session(&roots, &complete, "sess_a");
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
}

/// A row-only child is a reaped one only when a parent that migrates carries its completion notification; a parent
/// that merely mentions the child's id does not.
#[test]
fn a_row_only_child_named_in_a_parents_text_is_not_reaped_without_its_notification() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let notice = "Async agent task t (completed) finished.\n\nResult:\nsurface: agent\nsessionId: sess_done\nstatus: completed\n\nthe body";
    let session = json!({"id":"sess_p","messages":[
        {"role":"user","content":"look at sess_kid please"},
        {"role":"user","content":notice}]});
    write(&roots.data, "sessions/sess_p.json", session.to_string().as_bytes());
    let row = |id: &str| json!({"sessionId":id,"parentSessionId":"sess_p","tag":id,"status":"running"});
    write(
        &roots.data,
        "agent-workers.json",
        json!({"version":2,"workers":{"sess_kid":row("sess_kid"),"sess_done":row("sess_done")},"tombstones":[]}).to_string().as_bytes(),
    );
    migrator(&roots, None).run().unwrap();
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let has = |key: &str| manifest.items.iter().any(|i| i.key.as_str() == key);
    assert!(has("session/sess_kid"));
    assert!(!has("session/sess_done"));
}

/// A parent's record is read once for the plan however many row-only children it has and whether an ownerless tombstone
/// then needs every session's header. (A row naming only parents that are nowhere is dropped without a read.)
#[test]
fn a_parent_is_read_once_for_its_children_and_for_an_ownerless_tombstone() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    write(&roots.data, "sessions/sess_p.json", json!({"id":"sess_p","messages":[{"role":"user","content":"hi"}]}).to_string().as_bytes());
    let row = |id: &str| json!({"sessionId":id,"parentSessionId":"sess_p","tag":id,"status":"running"});
    write(
        &roots.data,
        "agent-workers.json",
        json!({"version":2,"workers":{"sess_k1":row("sess_k1"),"sess_k2":row("sess_k2")},
               "tombstones":[{"tag":"x","clientHostPid":7,"reapedAt":"2026-01-01T00:00:00.000Z"}]})
        .to_string()
        .as_bytes(),
    );
    crate::session::PLAN_READS.with(|r| r.borrow_mut().clear());
    migrator(&roots, None).run().unwrap();
    let reads = crate::session::PLAN_READS.with(|r| r.borrow().iter().filter(|id| *id == "sess_p").count());
    assert_eq!(reads, 1);
}

/// A `session-catalog.sqlite` that is not Mixdog's (another application id) is left in place, as 1.4.5 refused it.
#[test]
fn a_foreign_session_catalog_database_is_not_retired() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let foreign = roots.data.join("session-catalog.sqlite");
    let conn = rusqlite::Connection::open(&foreign).unwrap();
    conn.execute_batch("PRAGMA application_id=7; CREATE TABLE t(x);").unwrap();
    drop(conn);
    migrator(&roots, None).run().unwrap();
    assert!(foreign.exists());
}

/// A catalog that does not answer (locked by its owner) proves neither ownership nor corruption: it stays, and a Mixdog
/// one that answers is retired.
#[test]
fn a_session_catalog_that_does_not_answer_is_kept_and_one_that_does_is_retired() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let path = roots.data.join("session-catalog.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(&format!("PRAGMA application_id={}; CREATE TABLE t(x);", 0x4d58_5343)).unwrap();
    conn.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(crate::stores::keeps_catalog(&roots.data));
    conn.execute_batch("COMMIT").unwrap();
    assert!(!crate::stores::keeps_catalog(&roots.data));
}

/// Marker files naming no session that migrates are retired, journaled and removed: a
/// release marker of a session that is gone, and a tombstone without a `sessionId` whose
/// owner no session is.
#[test]
fn markers_of_sessions_that_do_not_migrate_are_retired() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    write(&roots.data, "agent-workers-released.json", br#"{"version":1,"released":{"sess_gone":"2026-01-02T00:00:00.000Z"}}"#);
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
    let worker = |id: &str| read_migrated_session(&roots, &complete, id).header.get("worker").cloned();
    assert_eq!(
        worker("sess_d"),
        Some(json!({"tombstone":{"tag":"w","clientHostPid":"42","reapedAt":"1970-01-01T00:00:05.000Z",
            "parentSessionId":"sess_a","ownerSessionId":"sess_a"}}))
    );
    assert_eq!(worker("sess_e"), None);
    assert_eq!(worker("sess_f"), None);
    assert_eq!(worker("sess_b"), Some(json!({"sessionId":"sess_b","tag":"t","tombstone":{"tag":"t2","reapedAt":"2026-01-03T00:00:00.000Z"}})));
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
    let sources = |id: &str| read_migrated_session(&roots, &complete, id).header.get("offloadSources").cloned();
    assert_eq!(sources("sess_fork"), Some(json!(["sess_other", "sess_src"])));
    assert_eq!(sources("sess_b"), Some(json!([])), "a session naming no other session's sidecars holds an empty set, not none");
}

/// Every journal transition and publication step of every kind: a kill before or after
/// it, then a resume, ends in the tree an uninterrupted run leaves (journal excluded).
/// The points are spread over `CRASH_PARTS` tests (point `n` in part `n % CRASH_PARTS`), so
/// each test runs a fixed share of the matrix: two runs, and a crash and resume per point of its
/// share, one after the other.
fn every_crash_point_resumes_to_the_same_tree(part: usize) {
    // The trees compared are read back from the running OS; a flush to the device changes none of them.
    mixdog_store::fsio::elide_syncs();
    let dir = tempfile::tempdir().unwrap();
    // The manifest names the dir a run was in: every run of the part is in `base`.
    let base = dir.path().join("run");
    // One uninterrupted run names every fault point, in the order a run meets them.
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
    assert!(points.len() >= CRASH_PARTS, "{} fault points for {CRASH_PARTS} parts", points.len());
    // The connector transition is cut between each of its file publications.
    let connector = format!("publish:{}:", crate::connectors::ITEM);
    let publications = points.iter().filter(|p| p.starts_with(&connector)).count();
    assert!(publications >= 5, "{publications} connector publication points");

    resume_after_each_crash(&base, &points, part);
}

const CRASH_PARTS: usize = 12;

#[test]
fn every_crash_point_resumes_to_the_same_tree_part_0() {
    every_crash_point_resumes_to_the_same_tree(0);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_1() {
    every_crash_point_resumes_to_the_same_tree(1);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_2() {
    every_crash_point_resumes_to_the_same_tree(2);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_3() {
    every_crash_point_resumes_to_the_same_tree(3);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_4() {
    every_crash_point_resumes_to_the_same_tree(4);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_5() {
    every_crash_point_resumes_to_the_same_tree(5);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_6() {
    every_crash_point_resumes_to_the_same_tree(6);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_7() {
    every_crash_point_resumes_to_the_same_tree(7);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_8() {
    every_crash_point_resumes_to_the_same_tree(8);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_9() {
    every_crash_point_resumes_to_the_same_tree(9);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_10() {
    every_crash_point_resumes_to_the_same_tree(10);
}
#[test]
fn every_crash_point_resumes_to_the_same_tree_part_11() {
    every_crash_point_resumes_to_the_same_tree(11);
}

/// Kills the migration at `points[part]`, `points[part + CRASH_PARTS]`, ... in `base`, resumes it
/// and compares the tree with an uninterrupted run's in the same dir (the manifest names the dir's
/// roots, so the tree differs from dir to dir).
fn resume_after_each_crash(base: &Path, points: &[String], part: usize) {
    let roots = fixture(base);
    migrator(&roots, None).run().unwrap();
    let want = tree_digest(&roots);
    std::fs::remove_dir_all(base).unwrap();
    for (stop_at, expected) in points.iter().enumerate().skip(part).step_by(CRASH_PARTS) {
        let roots = fixture(base);
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
        let diff = tree_diff(&want, &got);
        assert!(diff.is_empty(), "after a crash at {point}: {diff:?}");
        std::fs::remove_dir_all(base).unwrap();
    }
}

/// The data dir of the disposal kill tests: the fixture and a session whose record does not parse, so a quarantine
/// move is disposed of beside the removals.
fn disposal_fixture(base: &Path) -> MigrationRoots {
    let _ = std::fs::remove_dir_all(base);
    let roots = fixture(base);
    write(&roots.data, "sessions/sess_q.json", br#"{"id":"sess_q","messages":["#);
    roots
}

const DISPOSAL_KILLED: i32 = 86;

/// A disposal point of a session item: its key, and the point with the number of times the run met it before (a session
/// removes one source after another under the same point name).
fn disposal_point(point: &str, seen: &mut BTreeMap<String, usize>) -> Option<(String, String)> {
    let disposal = ["delete:", "journal:disposed:", "move:", "quarantine-copy:"].iter().any(|p| point.starts_with(p));
    let at = point.find("session/").filter(|_| disposal)?;
    let key = point[at..].split(':').next()?.to_owned();
    let n = seen.entry(point.to_owned()).or_default();
    *n += 1;
    Some((key, format!("{point}#{n}")))
}

fn disposal_options(serving: bool, fault: Option<FaultHook>) -> MigrateOptions {
    MigrateOptions { workers: 2, fault, verified: serving.then(|| Arc::new(|_: &str| {}) as VerifiedHook), retention: None }
}

/// The child of the disposal kill test (a no-op unless the parent set `DISPOSAL_KILL_BASE`): two converters run the
/// migration; the one that meets `DISPOSAL_KILL_FIRST` waits there for the other to meet `DISPOSAL_KILL_SECOND` (or the
/// other way round), and the process exits with both of them standing at their points.
#[test]
fn disposal_kill_child() {
    let Some(base) = std::env::var_os("DISPOSAL_KILL_BASE") else { return };
    mixdog_store::fsio::elide_syncs();
    let wanted = [std::env::var("DISPOSAL_KILL_FIRST").unwrap(), std::env::var("DISPOSAL_KILL_SECOND").unwrap()];
    let serving = std::env::var_os("DISPOSAL_KILL_SERVING").is_some();
    let met = Arc::new((Mutex::new((BTreeMap::<String, usize>::new(), [false; 2])), std::sync::Condvar::new()));
    let hook: FaultHook = Arc::new(move |point: &str| {
        let (state, arrived) = &*met;
        let mut guard = state.lock().unwrap();
        let Some((_, labelled)) = disposal_point(point, &mut guard.0) else { return Ok(()) };
        let Some(which) = wanted.iter().position(|w| *w == labelled) else { return Ok(()) };
        guard.1[which] = true;
        if guard.1 == [true; 2] {
            std::process::exit(DISPOSAL_KILLED);
        }
        arrived.notify_all();
        let (_guard, waited) = arrived.wait_timeout_while(guard, std::time::Duration::from_secs(60), |g| g.1 != [true; 2]).unwrap();
        assert!(!waited.timed_out(), "the other converter never reached its point");
        Ok(())
    });
    let roots = MigrationRoots { data: Path::new(&base).join("data"), home: Path::new(&base).join("home"), profile: None };
    Migrator::new(roots, drivers(), disposal_options(serving, Some(hook))).run().expect("the run the child was not stopped in");
}

/// With several converters the sessions are disposed of side by side, by a one-shot run and behind a serving core alike.
/// The process is killed with two converters standing at disposal points of two sessions, every point of one session
/// against the first and the last point of the next one (each removal, quarantine move and journal frame told apart),
/// and the resume ends in the tree of the uninterrupted run; for the one-shot run that is the tree of one converter.
/// The pairs are spread over `DISPOSAL_PARTS` tests per run kind (pair `n` in part `n % DISPOSAL_PARTS`), each in a work
/// directory of its own with its own uninterrupted run to compare with, so each test stays a fraction of nextest's limit.
fn disposal_kills(serving: bool, part: usize) {
    mixdog_store::fsio::elide_syncs();
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("run");
    let one = (!serving && part == 0).then(|| {
        let roots = disposal_fixture(&base);
        migrator(&roots, None).run().unwrap();
        tree_digest(&roots)
    });

    let roots = disposal_fixture(&base);
    let met = Arc::new(Mutex::new((BTreeMap::<String, usize>::new(), Vec::<(String, String)>::new())));
    let record = met.clone();
    let hook: FaultHook = Arc::new(move |point: &str| {
        let mut guard = record.lock().unwrap();
        if let Some(found) = disposal_point(point, &mut guard.0) {
            guard.1.push(found);
        }
        Ok(())
    });
    Migrator::new(roots.clone(), drivers(), disposal_options(serving, Some(hook))).run().unwrap();
    let want = tree_digest(&roots);
    if let Some(one) = &one {
        assert_eq!(&want, one, "an uninterrupted run with two converters");
    }
    let mut by_session: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (key, labelled) in met.lock().unwrap().1.clone() {
        by_session.entry(key).or_default().push(labelled);
    }
    assert!(by_session.len() > 2, "the fixture disposes of {:?}", by_session.keys());
    assert!(by_session.values().flatten().any(|p| p.starts_with("move:")), "a quarantine move is among the points: {by_session:?}");
    assert!(by_session.values().flatten().any(|p| p.ends_with("#2")), "a session removes more than one source: {by_session:?}");

    // Every point of each session against the first and the last of the next one; the last session (the quarantined one,
    // whose move or copy points lie inside it) against the first and the last of the one before, so its every point is
    // a kill point too.
    let sessions: Vec<&Vec<String>> = by_session.values().collect();
    let ends = |points: &Vec<String>| [points[0].clone(), points[points.len() - 1].clone()];
    let mut pairs: Vec<(String, String)> = Vec::new();
    for pair in sessions.windows(2) {
        pairs.extend(pair[0].iter().flat_map(|a| ends(pair[1]).map(|b| (a.clone(), b))));
    }
    let (before, last) = (sessions[sessions.len() - 2], sessions[sessions.len() - 1]);
    // The ends of the last session against the ends of the one before are among the pairs above already.
    let last_ends = ends(last);
    pairs.extend(last.iter().filter(|a| !last_ends.contains(a)).flat_map(|a| ends(before).map(|b| (a.clone(), b))));
    let killed_at = |prefix: &str| pairs.iter().any(|(a, b)| a.starts_with(prefix) || b.starts_with(prefix));
    assert!(killed_at("move:"), "no kill at a quarantine move (serving {serving}): {pairs:?}");
    if serving {
        assert!(killed_at("quarantine-copy:"), "no kill at a quarantine copy behind a serving core: {pairs:?}");
    }
    assert!(pairs.len() > DISPOSAL_PARTS, "{} pairs for {DISPOSAL_PARTS} parts", pairs.len());
    for (a, b) in pairs.iter().skip(part).step_by(DISPOSAL_PARTS) {
        disposal_fixture(&base);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", "run::tests::disposal_kill_child", "--test-threads=1"])
            .env("DISPOSAL_KILL_BASE", &base)
            .env("DISPOSAL_KILL_FIRST", a)
            .env("DISPOSAL_KILL_SECOND", b)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if serving {
            child.env("DISPOSAL_KILL_SERVING", "1");
        }
        assert_eq!(child.status().unwrap().code(), Some(DISPOSAL_KILLED), "{a} with {b} (serving {serving}) was not reached");
        Migrator::new(roots.clone(), drivers(), disposal_options(serving, None))
            .run()
            .unwrap_or_else(|e| panic!("resume after a kill at {a} with {b} (serving {serving}): {e}"));
        let got = tree_digest(&roots);
        let diff = tree_diff(&want, &got);
        assert!(diff.is_empty(), "after a kill at {a} with {b} (serving {serving}): {diff:?}");
    }
}

const DISPOSAL_PARTS: usize = 6;

#[test]
fn a_disposal_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_0() {
    disposal_kills(false, 0);
}
#[test]
fn a_disposal_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_1() {
    disposal_kills(false, 1);
}
#[test]
fn a_disposal_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_2() {
    disposal_kills(false, 2);
}
#[test]
fn a_disposal_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_3() {
    disposal_kills(false, 3);
}
#[test]
fn a_disposal_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_4() {
    disposal_kills(false, 4);
}
#[test]
fn a_disposal_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_5() {
    disposal_kills(false, 5);
}
#[test]
fn a_disposal_behind_a_serving_core_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_0() {
    disposal_kills(true, 0);
}
#[test]
fn a_disposal_behind_a_serving_core_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_1() {
    disposal_kills(true, 1);
}
#[test]
fn a_disposal_behind_a_serving_core_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_2() {
    disposal_kills(true, 2);
}
#[test]
fn a_disposal_behind_a_serving_core_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_3() {
    disposal_kills(true, 3);
}
#[test]
fn a_disposal_behind_a_serving_core_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_4() {
    disposal_kills(true, 4);
}
#[test]
fn a_disposal_behind_a_serving_core_on_two_threads_resumes_from_each_pair_of_kill_points_to_the_same_tree_part_5() {
    disposal_kills(true, 5);
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
                return Err(Blocked::Io { op: "rename", path: PathBuf::from("sessions/sess_a"), os_error: "Access is denied. (os error 5)".into() });
            }
            Ok(())
        })),
    )
    .run();
    assert!(matches!(blocked, Err(Blocked::Io { op: "rename", .. })), "{blocked:?}");
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{:?}", unexpected_reasons(&roots));
}

/// The fixture's image blob as 1.4.5 keeps it and as the core does.
fn image_paths(roots: &MigrationRoots) -> (PathBuf, PathBuf) {
    let hex = durable::sha256_hex(b"image bytes");
    let legacy = roots.data.join(mixdog_store::schema::blob::LEGACY_BLOB_DIR).join(&hex[..2]).join(&hex);
    let core = mixdog_store::blobs::BlobStore::new(&roots.data).path(&mixdog_store::blobs::digest_of(b"image bytes"));
    (legacy, core)
}

/// 1.4.5 runs on its own tree after the upgrade (another installation, a rollback): its census unlinks a blob no file
/// of its own names any more (the session it was converted from is gone), and its repair renames a new file over a
/// blob's name. Neither reaches the core: the bytes the migrated session names still read whole from the core's store.
#[test]
fn a_legacy_unlink_or_replacement_after_the_migration_leaves_the_core_bytes_readable() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    migrator(&roots, None).run().unwrap();
    let (legacy, core) = image_paths(&roots);
    let hex = durable::sha256_hex(b"image bytes");
    let names = log_records(&roots.data.join("sessions").join("sess_a")).iter().any(|(_, r)| serde_json::to_string(r).unwrap().contains(&hex));
    assert!(names, "the migrated session names the blob");
    assert_eq!(std::fs::read(&legacy).unwrap(), b"image bytes", "the migration leaves 1.4.5's tree as it was");

    std::fs::remove_file(&legacy).unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes", "after the legacy unlink");
    let tmp = legacy.with_file_name(format!("{hex}.mixdog-tmp-0123456789abcdef"));
    std::fs::write(&tmp, b"other bytes").unwrap();
    std::fs::rename(&tmp, &legacy).unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes", "after a new file renamed over the legacy name");
}

/// The legacy blobs of many shards taken in on four threads leave the store one thread leaves, and so does a run cut at
/// any of its installs (the other threads stopped wherever they were) and resumed.
#[test]
fn legacy_blobs_taken_in_on_several_threads_leave_the_store_one_thread_leaves() {
    let store = |roots: &MigrationRoots| {
        let mut files: Vec<(String, String)> = durable::walk_files(&roots.data.join(mixdog_store::schema::blob::BLOB_DIR))
            .unwrap()
            .into_iter()
            .map(|rel| {
                let sha = durable::hash_file(&roots.data.join(mixdog_store::schema::blob::BLOB_DIR).join(&rel)).unwrap().1;
                (rel, sha)
            })
            .collect();
        files.sort();
        (files, roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).exists())
    };
    let legacy = |root: &Path| {
        let roots = fixture(root);
        for n in 0..64u32 {
            let bytes = format!("blob {n}");
            let hex = durable::sha256_hex(bytes.as_bytes());
            write(&roots.data, &format!("{}/{}/{hex}", mixdog_store::schema::blob::LEGACY_BLOB_DIR, &hex[..2]), bytes.as_bytes());
        }
        roots
    };
    let dir = tempfile::tempdir().unwrap();
    let one = legacy(&dir.path().join("one"));
    crate::legacy_blobs::import(&one.data, &|_| Ok(())).unwrap();
    let want = store(&one);
    assert!(want.1 && want.0.len() > 60, "{} blobs", want.0.len());

    let side = legacy(&dir.path().join("four"));
    crate::legacy_blobs::import_on(&side.data, &|_| Ok(()), 4).unwrap();
    assert_eq!(store(&side), want);

    let stages = |roots: &MigrationRoots| {
        store(roots).0.iter().filter(|(rel, _)| rel.rsplit('/').next().is_some_and(|name| name.starts_with(".mixdog-legacy-blob-stage-"))).count()
    };
    // Files of a temp's look that the importer did not make: another writer's temp, and one a stage name is a prefix of.
    let shard = &durable::sha256_hex(b"blob 0")[..2];
    let foreign = [format!("{shard}/.mixdog-tmp-0123456789abcdef"), format!("{shard}/.mixdog-legacy-blob-stage-not-ours")];
    let mut want_with_foreign = want.clone();
    want_with_foreign.0.extend(foreign.iter().map(|rel| (rel.clone(), durable::sha256_hex(rel.as_bytes()))));
    want_with_foreign.0.sort();
    for cut_at in [0, 7, 31] {
        let roots = legacy(&dir.path().join(format!("cut-{cut_at}")));
        for rel in &foreign {
            write(&roots.data.join(mixdog_store::schema::blob::BLOB_DIR), rel, rel.as_bytes());
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "run::tests::blob_import_kill_child", "--test-threads=1"])
            .env("BLOB_KILL_DATA", &roots.data)
            .env("BLOB_KILL_AT", cut_at.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(BLOB_IMPORT_KILLED), "the child was not killed at install {cut_at}");
        assert!(!store(&roots).1, "no marker after a killed run");
        assert!(stages(&roots) >= 3, "the killed run left its threads' staged links: {:?}", store(&roots).0);
        crate::legacy_blobs::import_on(&roots.data, &|_| Ok(()), 4).unwrap();
        assert_eq!(store(&roots), want_with_foreign, "resumed after a kill at install {cut_at}");
    }
}

const BLOB_IMPORT_KILLED: i32 = 87;

/// The child of the blob import kill test (a no-op unless the parent set `BLOB_KILL_DATA`): four threads take the legacy
/// blobs in; from install `BLOB_KILL_AT` on, each thread that reaches an install (its link or copy staged) waits there,
/// and the process exits once all four stand at one.
#[test]
fn blob_import_kill_child() {
    let Some(data) = std::env::var_os("BLOB_KILL_DATA") else { return };
    mixdog_store::fsio::elide_syncs();
    let from: usize = std::env::var("BLOB_KILL_AT").unwrap().parse().unwrap();
    let installs = AtomicUsize::new(0);
    let standing = (Mutex::new(0usize), std::sync::Condvar::new());
    crate::legacy_blobs::import_on(
        Path::new(&data),
        &|point| {
            if point != "legacy-blobs:install" || installs.fetch_add(1, Ordering::SeqCst) < from {
                return Ok(());
            }
            let (count, arrived) = &standing;
            let mut count = count.lock().unwrap();
            *count += 1;
            if *count == 4 {
                std::process::exit(BLOB_IMPORT_KILLED);
            }
            arrived.notify_all();
            let (_count, waited) = arrived.wait_timeout_while(count, std::time::Duration::from_secs(60), |count| *count < 4).unwrap();
            assert!(!waited.timed_out(), "the other threads never reached an install");
            Ok(())
        },
        4,
    )
    .expect("the import the child was not stopped in");
}

#[test]
fn an_attachment_collision_keeps_the_bytes_that_match_the_reference() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let (_, core) = image_paths(&roots);
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    std::fs::write(&core, b"corrupt native copy").unwrap();

    let bytes = b"valid native copy";
    let hex = durable::sha256_hex(bytes);
    write(&roots.data, &format!("{}/{}/{hex}", mixdog_store::schema::blob::LEGACY_BLOB_DIR, &hex[..2]), b"corrupt legacy copy");
    let good_core = mixdog_store::blobs::BlobStore::new(&roots.data).path(&mixdog_store::blobs::digest_of(bytes));
    std::fs::create_dir_all(good_core.parent().unwrap()).unwrap();
    std::fs::write(&good_core, bytes).unwrap();

    migrator(&roots, None).run().unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
    assert_eq!(std::fs::read(&good_core).unwrap(), bytes);
}

#[test]
fn invalid_legacy_bytes_are_not_installed_by_either_transfer_path() {
    for copy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let roots = fixture(dir.path());
        let (legacy, core) = image_paths(&roots);
        std::fs::write(&legacy, b"wrong digest").unwrap();
        crate::legacy_blobs::import_with(&roots.data, &|_| Ok(()), &|source, stage| {
            if copy { Err(std::io::Error::other("no links here")) } else { std::fs::copy(source, stage).map(|_| ()) }
        })
        .unwrap();
        assert!(!core.exists(), "copy path: {copy}");
    }
}

#[test]
fn a_verified_blob_published_during_import_keeps_its_file() {
    use std::fs::{File, FileTimes};
    use std::time::{Duration, UNIX_EPOCH};

    for copy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let roots = fixture(dir.path());
        let (_, core) = image_paths(&roots);
        let modified = UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        crate::legacy_blobs::import_with(
            &roots.data,
            &|point| {
                if point == "legacy-blobs:install" {
                    std::fs::write(&core, b"image bytes").unwrap();
                    File::options().write(true).open(&core).unwrap().set_times(FileTimes::new().set_modified(modified)).unwrap();
                }
                Ok(())
            },
            &|source, stage| {
                if copy { Err(std::io::Error::other("no links here")) } else { std::fs::copy(source, stage).map(|_| ()) }
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
        assert_eq!(std::fs::metadata(&core).unwrap().modified().unwrap(), modified, "copy path: {copy}");
    }
}

#[test]
fn copy_only_import_restores_a_repair_that_raced_with_displacement() {
    use std::fs::{File, FileTimes};
    use std::time::{Duration, UNIX_EPOCH};

    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let (_, core) = image_paths(&roots);
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    std::fs::write(&core, b"corrupt native copy").unwrap();
    let modified = UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    crate::legacy_blobs::import_with(
        &roots.data,
        &|point| {
            if point == "legacy-blobs:displace" {
                mixdog_store::fsio::publish_file_with(&core, b"image bytes", mixdog_store::fsio::Access::Inherit).unwrap();
                File::options().write(true).open(&core).unwrap().set_times(FileTimes::new().set_modified(modified)).unwrap();
            }
            Ok(())
        },
        &|_, _| Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no hard links")),
    )
    .unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
    assert_eq!(std::fs::metadata(&core).unwrap().modified().unwrap(), modified);
}

#[test]
fn a_third_digest_is_preserved_even_after_its_legacy_source_disappears() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let (legacy, core) = image_paths(&roots);
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    std::fs::write(&core, b"original corruption").unwrap();
    let result = crate::legacy_blobs::import(&roots.data, &|point| {
        if point == "legacy-blobs:displace" {
            mixdog_store::fsio::publish_file_with(&core, b"different concurrent bytes", mixdog_store::fsio::Access::Inherit).unwrap();
        }
        Ok(())
    });
    let Err(Blocked::SourceChanged { path: aside }) = result else { panic!("unexpected import result: {result:?}") };
    assert_eq!(std::fs::read(&aside).unwrap(), b"different concurrent bytes");
    assert!(!core.exists(), "the importer must not install over an unresolved displacement");

    std::fs::remove_dir_all(legacy.parent().unwrap()).unwrap();
    assert_eq!(crate::legacy_blobs::import(&roots.data, &|_| Ok(())), Err(Blocked::SourceChanged { path: aside.clone() }));
    assert_eq!(std::fs::read(&aside).unwrap(), b"different concurrent bytes");
    assert!(!roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).exists());
}

#[test]
fn a_displaced_verified_blob_is_restored_without_its_legacy_source() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let (legacy, core) = image_paths(&roots);
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    std::fs::write(&core, b"original corruption").unwrap();
    let cut = crate::legacy_blobs::import(&roots.data, &|point| match point {
        "legacy-blobs:displace" => mixdog_store::fsio::publish_file_with(&core, b"image bytes", mixdog_store::fsio::Access::Inherit).map_err(Blocked::fsio),
        "legacy-blobs:displaced" => Err(Blocked::Interrupted { point: point.into() }),
        _ => Ok(()),
    });
    assert!(matches!(cut, Err(Blocked::Interrupted { .. })), "{cut:?}");
    assert!(!core.exists());
    std::fs::remove_dir_all(legacy.parent().unwrap()).unwrap();
    crate::legacy_blobs::import(&roots.data, &|point| {
        if point == "legacy-blobs:marker" {
            assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
        }
        Ok(())
    })
    .unwrap();
    assert!(roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).exists());
}

#[test]
fn an_interrupted_corrupt_displacement_waits_for_a_verified_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let (legacy, core) = image_paths(&roots);
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    std::fs::write(&core, b"original corruption").unwrap();
    let cut = crate::legacy_blobs::import(&roots.data, &|point| {
        if point == "legacy-blobs:displaced" {
            return Err(Blocked::Interrupted { point: point.into() });
        }
        Ok(())
    });
    assert!(matches!(cut, Err(Blocked::Interrupted { .. })), "{cut:?}");
    std::fs::remove_dir_all(legacy.parent().unwrap()).unwrap();

    let marker = roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED);
    let retry = crate::legacy_blobs::import(&roots.data, &|_| Ok(()));
    let Err(Blocked::Io { op: "repair blob", path: aside, .. }) = retry else {
        panic!("unexpected import result: {retry:?}");
    };
    assert_eq!(std::fs::read(&aside).unwrap(), b"original corruption");
    assert!(!core.exists(), "corrupt bytes must not return to the canonical path");
    assert!(!marker.exists());

    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, b"image bytes").unwrap();
    crate::legacy_blobs::import(&roots.data, &|_| Ok(())).unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
    assert!(!aside.exists());
    assert!(marker.exists());
}

#[test]
fn an_ambiguous_blob_restore_does_not_overwrite_either_file() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    let (_, core) = image_paths(&roots);
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    let aside = core.with_extension("mixdog-migrated");
    std::fs::write(&aside, b"image bytes").unwrap();
    std::fs::write(&core, b"unverified concurrent copy").unwrap();
    let result = crate::legacy_blobs::import_with(&roots.data, &|_| Ok(()), &|_, _| Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no hard links")));
    assert!(matches!(result, Err(Blocked::Io { op: "restore blob", .. })), "{result:?}");
    assert_eq!(std::fs::read(&core).unwrap(), b"unverified concurrent copy");
    assert_eq!(std::fs::read(&aside).unwrap(), b"image bytes");
    assert!(!roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).exists());
}

/// A data dir an earlier 1.5.0 build migrated kept its blobs, the ones that build wrote included, in 1.4.5's tree: the
/// next start gives each its core name before anything else, though the migration is complete; one cut before the
/// marker does the rest at the next start.
#[test]
fn a_dir_an_earlier_build_migrated_takes_its_blobs_in_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    migrator(&roots, None).run().unwrap();
    let (legacy, core) = image_paths(&roots);
    let written = {
        let bytes = b"a blob an earlier build wrote";
        let hex = durable::sha256_hex(bytes);
        write(&roots.data, &format!("{}/{}/{hex}", mixdog_store::schema::blob::LEGACY_BLOB_DIR, &hex[..2]), bytes);
        mixdog_store::blobs::BlobStore::new(&roots.data).path(&mixdog_store::blobs::digest_of(bytes))
    };
    std::fs::remove_dir_all(roots.data.join("blobs")).unwrap();
    let cut = migrator(&roots, Some(Arc::new(|p: &str| if p == "legacy-blobs:marker" { Err(Blocked::Interrupted { point: p.into() }) } else { Ok(()) }))).run();
    assert!(matches!(cut, Err(Blocked::Interrupted { .. })), "{cut:?}");
    assert!(!roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).exists(), "not marked before the cut");
    std::fs::remove_file(&core).unwrap();
    migrator(&roots, None).run().unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
    assert_eq!(std::fs::read(&written).unwrap(), b"a blob an earlier build wrote");
    assert!(legacy.is_file() && roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).is_file());
}

/// A run killed after linking and before the shard's sync leaves every name in place: the run that resumes it skips
/// them all, yet must still make the shard durable before it publishes the marker.
#[test]
fn the_marker_is_never_published_before_a_shard_whose_names_all_existed_is_synced() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    migrator(&roots, None).run().unwrap();
    let (_, core) = image_paths(&roots);
    std::fs::remove_file(roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED)).unwrap();
    assert!(core.is_file(), "every name already exists");
    let points = std::sync::Mutex::new(Vec::new());
    crate::legacy_blobs::import(&roots.data, &|p| {
        points.lock().unwrap().push(p.to_string());
        Ok(())
    })
    .unwrap();
    let points = points.into_inner().unwrap();
    assert_eq!(points.last().map(String::as_str), Some("legacy-blobs:marker"), "{points:?}");
    assert!(points[..points.len() - 1].iter().any(|p| p == "legacy-blobs:shard"), "the shard is synced first: {points:?}");
}

/// A run killed right after the shard's `mkdir` leaves the directory visible with nothing in it; the run that resumes it
/// finds the name there already, so it must itself make the names in `blobs/sha256` durable before the marker.
#[test]
fn a_shard_directory_a_cut_run_made_has_its_name_synced_before_the_marker() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    migrator(&roots, None).run().unwrap();
    let (_, core) = image_paths(&roots);
    std::fs::remove_dir_all(roots.data.join("blobs")).unwrap();
    std::fs::create_dir_all(core.parent().unwrap()).unwrap();
    let points = std::sync::Mutex::new(Vec::new());
    crate::legacy_blobs::import(&roots.data, &|p| {
        points.lock().unwrap().push(p.to_string());
        Ok(())
    })
    .unwrap();
    let points = points.into_inner().unwrap();
    assert_eq!(points, ["legacy-blobs:install", "legacy-blobs:shard", "legacy-blobs:names", "legacy-blobs:marker"]);
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
}

/// A run cut after linking and before syncing a shard, and 1.4.5 removes its legacy shard before the retry: the surviving
/// core shard is still synced before the marker (the sync follows the core's own shards, not the legacy tree's).
#[test]
fn a_core_shard_whose_legacy_shard_is_gone_is_still_synced_before_the_marker() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    migrator(&roots, None).run().unwrap();
    let (legacy, core) = image_paths(&roots);
    let marker = roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED);
    std::fs::remove_file(&marker).unwrap();
    std::fs::remove_dir_all(legacy.parent().unwrap()).unwrap();
    assert!(core.is_file(), "the linked name survives");
    let points = std::sync::Mutex::new(Vec::new());
    crate::legacy_blobs::import(&roots.data, &|p| {
        points.lock().unwrap().push(p.to_string());
        Ok(())
    })
    .unwrap();
    let points = points.into_inner().unwrap();
    let shards = std::fs::read_dir(core.parent().unwrap().parent().unwrap()).unwrap().count();
    let mut want = vec!["legacy-blobs:shard"; shards];
    want.extend(["legacy-blobs:names", "legacy-blobs:marker"]);
    assert_eq!(points, want, "every core shard, the one of the removed legacy shard included, is synced first");
}

/// On a volume that cannot link, the blob is copied: the core's name holds its own bytes, so what happens to the
/// legacy file afterwards does not reach it.
#[test]
fn a_blob_is_copied_where_no_link_can_be_made() {
    let dir = tempfile::tempdir().unwrap();
    let roots = fixture(dir.path());
    migrator(&roots, None).run().unwrap();
    let (legacy, core) = image_paths(&roots);
    std::fs::remove_dir_all(roots.data.join("blobs")).unwrap();
    crate::legacy_blobs::import_with(&roots.data, &|_| Ok(()), &|_, _| Err(std::io::Error::other("no links here"))).unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes");
    std::fs::write(&legacy, b"rewritten in place").unwrap();
    assert_eq!(std::fs::read(&core).unwrap(), b"image bytes", "a copy, not a second name of the legacy file");
    assert!(roots.data.join(mixdog_store::schema::blob::LEGACY_BLOBS_IMPORTED).is_file());
}

pub(crate) fn corpus() -> PathBuf {
    std::env::var_os("MIXDOG_MIGRATION_CORPUS").map(PathBuf::from).expect("MIXDOG_MIGRATION_CORPUS names the migration corpus")
}
