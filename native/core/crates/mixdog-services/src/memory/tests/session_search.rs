//! Session transcript search: rows, sensitive replacement, deletion, ingest.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::memory::pg::db::Schema;
use crate::memory::session_search::db::{ScrubStep, SessionSearchDb, search_rows};
use crate::memory::session_search::ingest::{IngestSession, SensitiveValues, SessionSearchIngest, StoredSessions};
use crate::memory::tests::support::TestPg;

#[test]
fn rows_keep_conversation_prose_and_drop_synthetic_tool_and_reminder_text() {
    let rows = search_rows(
        "s1",
        &[
            json!({ "role": "user", "content": "Fix the login bug<system-reminder>internal</system-reminder>", "ts": 10 }),
            json!({ "role": "tool", "content": "tool output" }),
            json!({ "role": "user", "content": "[mixdog-runtime] internal nudge" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "Patched login." }, { "type": "tool_use" }] }),
            json!({ "role": "assistant", "content": "." }),
        ],
    );
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].ordinal, rows[0].role, rows[0].content.as_str()), (0, "user", "Fix the login bug"));
    assert_eq!(rows[0].ts, Some(10));
    assert_eq!((rows[1].ordinal, rows[1].role, rows[1].content.as_str()), (3, "assistant", "Patched login."));
    assert!(rows[0].source_ref.starts_with("session:s1:") && rows[0].source_ref.len() == "session:s1:".len() + 24);
}

struct Mask;

impl SensitiveValues for Mask {
    fn version(&self, session_id: &str) -> Option<String> {
        (session_id == "masked").then(|| "v1".to_owned())
    }
    fn redact_messages(&self, session_id: &str, messages: &[Value]) -> Vec<Value> {
        messages
            .iter()
            .map(|m| {
                let mut m = m.clone();
                if let Some(text) = m["content"].as_str() {
                    m["content"] = Value::String(self.redact_text(session_id, text));
                }
                m
            })
            .collect()
    }
    fn redact_text(&self, session_id: &str, text: &str) -> String {
        if session_id == "masked" { text.replace("682419", "[redacted]") } else { text.to_owned() }
    }
}

struct NoSecrets;

impl SensitiveValues for NoSecrets {
    fn version(&self, _: &str) -> Option<String> {
        None
    }
    fn redact_messages(&self, _: &str, messages: &[Value]) -> Vec<Value> {
        messages.to_vec()
    }
    fn redact_text(&self, _: &str, text: &str) -> String {
        text.to_owned()
    }
}

/// Holds a write inside `redact_messages` until the test releases it, so a
/// session's write is provably in flight when the queue is closed.
struct Gate {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl SensitiveValues for Gate {
    fn version(&self, _: &str) -> Option<String> {
        None
    }
    fn redact_messages(&self, _: &str, messages: &[Value]) -> Vec<Value> {
        let _ = self.entered.send(());
        let _ = self.release.lock().expect("gate").recv_timeout(Duration::from_secs(10));
        messages.to_vec()
    }
    fn redact_text(&self, _: &str, text: &str) -> String {
        text.to_owned()
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn closing_a_session_cancels_running_and_queued_writes() {
    let pg = TestPg::start().await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let ingest = SessionSearchIngest::new(
        db.clone(),
        Arc::new(Gate { entered: entered_tx, release: std::sync::Mutex::new(release_rx) }),
    );
    let first = vec![json!({ "role": "user", "content": "running turn zebra" })];
    let queued = vec![json!({ "role": "user", "content": "queued turn giraffe" })];
    ingest.ingest_turn(IngestSession { id: "closing".into(), messages: first, agent_only: false });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(10)).expect("write started"))
        .await
        .expect("join");
    ingest.ingest_turn(IngestSession { id: "closing".into(), messages: queued, agent_only: false });
    tokio::time::sleep(Duration::from_millis(200)).await;

    let closing = {
        let ingest = ingest.clone();
        tokio::spawn(async move { ingest.close_session("closing").await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!closing.is_finished(), "close waits for the running write to settle");
    release_tx.send(()).expect("release");
    tokio::time::timeout(Duration::from_secs(10), closing).await.expect("close settles").expect("join");

    assert!(db.search("giraffe", 10).await.expect("search").is_empty(), "a queued write never starts after close");

    // The queue is usable again: a later turn is stored.
    let (reopened_tx, _reopened_rx) = std::sync::mpsc::channel();
    let (reopen_release_tx, reopen_release_rx) = std::sync::mpsc::channel();
    reopen_release_tx.send(()).expect("pre-release");
    let reopened = SessionSearchIngest::new(
        db.clone(),
        Arc::new(Gate { entered: reopened_tx, release: std::sync::Mutex::new(reopen_release_rx) }),
    );
    reopened.ingest_turn(IngestSession {
        id: "closing".into(),
        messages: vec![json!({ "role": "user", "content": "later turn flamingo" })],
        agent_only: false,
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(db.search("flamingo", 10).await.expect("search").len(), 1);
}

struct Stored {
    sessions: Vec<(String, String, Vec<Value>, bool)>,
}

#[async_trait::async_trait]
impl StoredSessions for Stored {
    async fn session_ids(&self) -> crate::memory::error::Result<Vec<String>> {
        Ok(self.sessions.iter().map(|s| s.0.clone()).collect())
    }
    async fn record_stamp(&self, id: &str) -> Option<String> {
        self.sessions.iter().find(|s| s.0 == id).map(|s| s.1.clone())
    }
    async fn read(&self, id: &str) -> Option<IngestSession> {
        self.sessions
            .iter()
            .find(|s| s.0 == id)
            .map(|s| IngestSession { id: s.0.clone(), messages: s.2.clone(), agent_only: s.3 })
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn backfill_indexes_changed_sessions_once_and_drops_vanished_ones() {
    let pg = TestPg::start().await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
    let ingest = SessionSearchIngest::new(db.clone(), Arc::new(NoSecrets));

    // A session whose record is gone: rows and a stamp remain from an earlier run.
    db.append("vanished", &[json!({ "role": "user", "content": "orphaned pelican conversation" })]).await.expect("append");
    db.record_backfill_stamp("vanished", "s0").await.expect("stamp");

    let mut stored = Stored {
        sessions: vec![
            ("kept".into(), "s1".into(), vec![json!({ "role": "user", "content": "indexed heron conversation" })], false),
            ("agents".into(), "s1".into(), vec![json!({ "role": "user", "content": "agent only badger chatter" })], true),
        ],
    };
    assert_eq!(ingest.backfill(&stored).await.expect("backfill"), 1, "agent-only sessions are not indexed");
    assert_eq!(db.search("heron", 10).await.expect("search").len(), 1);
    assert!(db.search("badger", 10).await.expect("search").is_empty());
    assert!(db.search("pelican", 10).await.expect("search").is_empty(), "rows of a deleted session are dropped");
    let stamps = db.backfill_stamps().await.expect("stamps");
    assert_eq!(stamps.get("kept").map(String::as_str), Some("s1"));
    assert_eq!(stamps.get("agents").map(String::as_str), Some("s1"), "agent-only sessions are stamped");
    assert!(!stamps.contains_key("vanished"));

    assert_eq!(ingest.backfill(&stored).await.expect("again"), 0, "an unchanged stamp is not read again");

    stored.sessions[0].1 = "s2".into();
    stored.sessions[0].2.push(json!({ "role": "assistant", "content": "the heron answer was recorded later" }));
    assert_eq!(ingest.backfill(&stored).await.expect("changed"), 1);
    assert_eq!(db.search("recorded later", 10).await.expect("search").len(), 1);
}

/// A store whose folder cannot be listed (Node's `readdirSync` throws).
struct Unlistable;

#[async_trait::async_trait]
impl StoredSessions for Unlistable {
    async fn session_ids(&self) -> crate::memory::error::Result<Vec<String>> {
        Err(crate::memory::error::MemoryError::Io(std::io::Error::other("sessions folder unreadable")))
    }
    async fn record_stamp(&self, _: &str) -> Option<String> {
        unreachable!("nothing is stamped after a failed listing")
    }
    async fn read(&self, _: &str) -> Option<IngestSession> {
        unreachable!("nothing is read after a failed listing")
    }
}

/// A failed listing must not read as "no sessions stored": the cleanup that drops the rows of
/// vanished sessions would otherwise drop every session's rows.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_failed_session_listing_fails_the_backfill_and_removes_no_rows() {
    let pg = TestPg::start().await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
    let ingest = SessionSearchIngest::new(db.clone(), Arc::new(NoSecrets));

    db.append("kept", &[json!({ "role": "user", "content": "indexed heron conversation" })]).await.expect("append");
    db.record_backfill_stamp("kept", "s1").await.expect("stamp");

    assert!(ingest.backfill(&Unlistable).await.is_err(), "the backfill fails");
    assert_eq!(db.search("heron", 10).await.expect("search").len(), 1, "no rows were removed");
    assert!(db.session_ids().await.expect("ids").contains("kept"));
    assert_eq!(db.backfill_stamps().await.expect("stamps").get("kept").map(String::as_str), Some("s1"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn ingest_search_redact_and_delete() {
    let pg = TestPg::start().await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
    let ingest = SessionSearchIngest::new(db.clone(), Arc::new(Mask));

    let transcript = vec![
        json!({ "role": "user", "content": "Deploy the staging cluster tonight" }),
        json!({ "role": "assistant", "content": "The staging cluster is deploying now" }),
    ];
    assert_eq!(db.append("s1", &transcript).await.expect("append"), 2);
    assert_eq!(db.append("s1", &transcript).await.expect("append again"), 0, "idempotent");

    let hits = db.search("staging cluster", 10).await.expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].session_id, "s1");
    assert!(hits[0].snippet.contains("staging"));
    assert!(db.search("the of", 10).await.expect("stopwords").is_empty());

    // A value marked sensitive after the rows were written replaces them.
    let secret = vec![
        json!({ "role": "user", "content": "Finish the sign-up." }),
        json!({ "role": "assistant", "content": "The code is 682419." }),
    ];
    db.append("masked", &secret).await.expect("plain rows");
    ingest.ingest_turn(IngestSession { id: "masked".into(), messages: secret.clone(), agent_only: false });
    ingest.settle("masked").await;
    assert!(db.search("682419", 10).await.expect("search secret").is_empty(), "plaintext is gone");
    assert_eq!(db.search("redacted", 10).await.expect("search marker").len(), 1);

    ingest.forget_session("s1").await;
    assert!(db.search("staging", 10).await.expect("after delete").is_empty());
    assert!(!db.session_ids().await.expect("ids").contains("s1"));
}

/// A search and an append arriving while a scrub's `VACUUM FULL` holds the table's exclusive lock wait for it past the
/// cluster's 5 s `lock_timeout` and then succeed, as Node's session search (no lock timeout) waits. The lock is held
/// here by an explicit `LOCK TABLE`, released only after a bound longer than that timeout.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_search_and_an_append_wait_out_the_scrubs_exclusive_lock() {
    let pg = TestPg::start().await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
    db.append("s1", &[json!({ "role": "user", "content": "Deploy the staging cluster" })]).await.expect("append");
    let holder = pg.db(Schema::SessionSearch).await;
    let mut client = holder.client().await.expect("holder");
    let tx = client.transaction().await.expect("tx");
    tx.batch_execute("LOCK TABLE session_search.messages IN ACCESS EXCLUSIVE MODE").await.expect("lock");
    let search = tokio::spawn({
        let db = db.clone();
        async move { db.search("staging", 10).await }
    });
    let append = tokio::spawn({
        let db = db.clone();
        async move { db.append("s2", &[json!({ "role": "user", "content": "Deploy the staging cluster too" })]).await }
    });
    tx.batch_execute("SELECT pg_sleep(6)").await.expect("hold past the lock timeout");
    tx.commit().await.expect("release");
    // Either order after the release: the append may commit before the search reads.
    assert!(!search.await.expect("join").expect("the search waited").is_empty());
    assert_eq!(append.await.expect("join").expect("the append waited"), 1);
}

/// Every `file@offset` under `root` that holds the bytes of `value`.
fn holders(root: &std::path::Path, value: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).expect("list") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            // A file the server removes between the listing and the read holds nothing.
            let Ok(bytes) = std::fs::read(&path) else { continue };
            for (offset, window) in bytes.windows(value.len()).enumerate() {
                if window == value.as_bytes() {
                    found.push(format!("{}@{offset}", path.display()));
                }
            }
        }
    }
    found
}

/// A value marked sensitive after its search rows were stored: once the replacement has run, no
/// file of the cluster holds it (table, TOAST, indexes, WAL), whichever step a kill ends the
/// scrub before; the next open finishes it (log_rewrite.rs, M1-M4).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_replaced_sensitive_row_leaves_no_file_of_the_cluster_whatever_step_a_kill_stops() {
    let secret = vec![
        json!({ "role": "user", "content": "Finish the sign-up." }),
        json!({ "role": "assistant", "content": "The code is 682419." }),
    ];
    let redacted = Mask.redact_messages("masked", &secret);
    for kill_after in [ScrubStep::Owed, ScrubStep::Rewritten, ScrubStep::WalRemoved] {
        let mut pg = TestPg::start().await;
        let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
        db.append("masked", &secret).await.expect("plain rows");
        db.replace_rows("masked", &secret, &redacted, &|text| Mask.redact_text("masked", text)).await.expect("M1");
        db.scrub_through(kill_after).await.expect("the steps before the kill");
        pg.kill_and_restart().await;
        let before = holders(pg.dir.path(), "682419");
        if kill_after == ScrubStep::Owed {
            assert!(!before.is_empty(), "the old row versions are on disk after the kill (the scan sees them)");
        }
        let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("the next open");
        assert_eq!(holders(pg.dir.path(), "682419"), Vec::<String>::new(), "killed after {kill_after:?}");
        assert!(db.search("682419", 10).await.expect("search").is_empty());
        assert_eq!(db.search("redacted", 10).await.expect("marker").len(), 1, "the replacement survived the kill");
    }
}
