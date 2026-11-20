//! The transcript tail ingest: which lines of a session's transcript file become rows, that a half-written last line waits for its
//! end, that a position is kept and survives a restart, and that a file read again stores nothing twice.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use crate::memory::pg::db::{Db, Schema};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;
use crate::memory::transcript::{TranscriptIngest, TranscriptIo};

const NOW: i64 = 1_772_600_767_890;

fn io() -> TranscriptIo {
    let tokens = mixdog_rt::testing::tokens();
    TranscriptIo { maintenance: tokens.maintenance_io, durability: tokens.durability_io }
}

async fn open(pg: &TestPg) -> Db {
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test" })).await.expect("schema");
    db
}

fn ingest_over(db: &Db) -> Arc<TranscriptIngest> {
    TranscriptIngest::new(db.clone(), io(), Arc::new(|| NOW))
}

fn user(text: &str) -> String {
    json!({ "type": "user", "message": { "content": text } }).to_string()
}

struct Stored {
    ts: i64,
    role: String,
    content: String,
    reference: String,
    session: Option<String>,
    project: Option<String>,
    source: Option<String>,
}

async fn stored(db: &Db) -> Vec<Stored> {
    db.query("SELECT ts, role, content, source_ref, session_id, project_id, time_source FROM entries ORDER BY id", &[])
        .await
        .expect("rows")
        .iter()
        .map(|r| Stored { ts: r.get(0), role: r.get(1), content: r.get(2), reference: r.get(3), session: r.get(4), project: r.get(5), source: r.get(6) })
        .collect()
}

fn says(rows: &[Stored]) -> Vec<(&str, &str)> {
    rows.iter().map(|r| (r.role.as_str(), r.content.as_str())).collect()
}

async fn read(ingest: &TranscriptIngest, file: &Path, cwd: &Path) -> usize {
    ingest.ingest_transcript_file(file, Some(cwd)).await.expect("the ingest")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn conversation_lines_become_rows_and_blank_broken_and_summary_lines_are_skipped() {
    let pg = TestPg::start().await;
    let db = open(&pg).await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".mixdog")).unwrap();
    std::fs::write(dir.path().join(".mixdog").join("project.id"), "proj-a").unwrap();
    let file = dir.path().join("sess-1.jsonl");
    let lines = [
        json!({ "type": "user", "message": { "content": "first question" }, "timestamp": "2026-01-02T03:04:05.000Z" }).to_string(),
        String::new(),
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "first answer" }] } }).to_string(),
        "{broken json".to_owned(),
        json!({ "type": "summary" }).to_string(),
    ];
    std::fs::write(&file, lines.join("\n") + "\n").unwrap();
    assert_eq!(read(&ingest_over(&db), &file, dir.path()).await, 2);
    let rows = stored(&db).await;
    assert_eq!(says(&rows), [("user", "first question"), ("assistant", "first answer")]);
    assert_eq!((rows[0].ts, rows[0].source.as_deref()), (1_767_323_045_000, Some("recorded")));
    assert_eq!((rows[1].ts, rows[1].source.as_deref()), (NOW, Some("collected")), "a line with no time is stamped by the clock");
    assert!(rows.iter().all(|r| r.session.as_deref() == Some("sess-1") && r.project.as_deref() == Some("proj-a")));
    assert!(
        rows[0].reference != rows[1].reference && rows.iter().all(|r| r.reference.starts_with("transcript:sess-1#")),
        "{:?}",
        rows.iter().map(|r| &r.reference).collect::<Vec<_>>()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_half_written_last_line_waits_for_its_end_and_nothing_new_stores_nothing() {
    let pg = TestPg::start().await;
    let db = open(&pg).await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sess-2.jsonl");
    let ingest = ingest_over(&db);
    let whole = format!("{}\n", user("complete line"));
    std::fs::write(&file, format!("{whole}{{\"type\":\"user\",\"message\":{{\"content\":\"par")).unwrap();
    assert_eq!(read(&ingest, &file, dir.path()).await, 1);
    assert_eq!(ingest.get_offset(&file).unwrap().bytes, whole.len() as f64, "the position stops before the unfinished line");
    let mut more = std::fs::read(&file).unwrap();
    more.extend_from_slice(b"tial\"}}\n");
    std::fs::write(&file, more).unwrap();
    assert_eq!(read(&ingest, &file, dir.path()).await, 1);
    assert_eq!(says(&stored(&db).await), [("user", "complete line"), ("user", "partial")]);
    assert_eq!(read(&ingest, &file, dir.path()).await, 0, "nothing new");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_run_of_nul_bytes_before_a_line_and_a_crlf_line_end_do_not_hide_the_line() {
    let pg = TestPg::start().await;
    let db = open(&pg).await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sess-3.jsonl");
    std::fs::write(&file, format!("{}\r\n\0\0{}\n", user("after crlf"), user("after a NUL run"))).unwrap();
    assert_eq!(read(&ingest_over(&db), &file, dir.path()).await, 2);
    assert_eq!(says(&stored(&db).await), [("user", "after crlf"), ("user", "after a NUL run")]);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_position_survives_a_restart_and_a_restart_that_lost_it_stores_every_line_once() {
    let pg = TestPg::start().await;
    let db = open(&pg).await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sess-4.jsonl");
    let text = format!("{}\n{}\n", user("one"), user("two"));
    std::fs::write(&file, &text).unwrap();
    let first = ingest_over(&db);
    assert_eq!(read(&first, &file, dir.path()).await, 2);

    let reloaded = ingest_over(&db);
    reloaded.load_transcript_offsets().await;
    let position = reloaded.get_offset(&file).expect("the position was stored");
    assert_eq!(position.bytes, text.len() as f64);
    assert_eq!(read(&reloaded, &file, dir.path()).await, 0, "read from where it stopped");

    // A start that never saved its position reads the file from the top and sends the same rows again: still one each.
    let forgetful = ingest_over(&db);
    assert_eq!(read(&forgetful, &file, dir.path()).await, 0, "the unique source reference keeps each row single");
    assert_eq!(stored(&db).await.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_file_rewritten_shorter_is_read_again_from_its_start_and_a_forgotten_file_loses_its_position() {
    let pg = TestPg::start().await;
    let db = open(&pg).await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sess-5.jsonl");
    std::fs::write(&file, format!("{}\n{}\n{}\n", user("a long first line of the file"), user("second"), user("third"))).unwrap();
    let ingest = ingest_over(&db);
    assert_eq!(read(&ingest, &file, dir.path()).await, 3);
    std::fs::write(&file, format!("{}\n", user("rewritten"))).unwrap();
    assert_eq!(read(&ingest, &file, dir.path()).await, 1);
    assert!(says(&stored(&db).await).contains(&("user", "rewritten")));
    assert_eq!(ingest.forget_transcripts(std::slice::from_ref(&file)).await, 1);
    assert!(ingest.get_offset(&file).is_none());
}
