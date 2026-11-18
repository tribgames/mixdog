//! `ingest_session`: how a transcript becomes stored rows (without an embedding model): what is counted and stored, that the same
//! messages are stored once however often they arrive, and that a repeated message of a session keeps its own row.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::memory::ingest::SessionIngest;
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::pg::db::{Db, Schema};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::tests::support::TestPg;

const NOW: i64 = 1_773_543_600_000;

async fn open(pg: &TestPg) -> (Db, SessionIngest) {
    let db = pg.db(Schema::Memory).await;
    ensure_memory_schema(&db, 384, &json!({ "model": "test" })).await.expect("schema");
    let ingest = SessionIngest::new(db.clone(), Arc::new(RawEmbedFlush::new(db.clone(), None)), None, Arc::new(|| NOW), mixdog_rt::testing::tokens().durability_io);
    (db, ingest)
}

async fn send(ingest: &SessionIngest, session: &str, messages: Option<Value>) -> String {
    let mut args = json!({ "action": "ingest_session", "sessionId": session });
    if let Some(messages) = messages {
        args["messages"] = messages;
    }
    let text = ingest.ingest_session(&args).await.expect("ingest");
    ingest.settle().await;
    text
}

async fn rows(db: &Db, session: &str) -> Vec<(String, String, bool)> {
    db.query("SELECT role, content, (embedding IS NOT NULL) FROM entries WHERE session_id = $1 ORDER BY id", &[&session])
        .await
        .expect("rows")
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect()
}

fn transcript() -> Value {
    json!([
        { "role": "user", "content": "please deploy the staging cluster" },
        { "role": "assistant", "content": [{ "type": "text", "text": "Deploying the staging cluster now." }] },
        { "role": "user", "content": "thanks" },
        { "role": "user", "content": "thanks" },
    ])
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_transcript_is_stored_row_by_row_and_a_repeated_message_keeps_its_own_row() {
    let pg = TestPg::start().await;
    let (db, ingest) = open(&pg).await;
    assert_eq!(send(&ingest, "s1", Some(transcript())).await, "ingest_session: considered=4 inserted=4 session=s1");
    let stored = rows(&db, "s1").await;
    assert_eq!(stored.iter().map(|(role, content, _)| (role.as_str(), content.as_str())).collect::<Vec<_>>(), [("user", "please deploy the staging cluster"), ("assistant", "Deploying the staging cluster now."), ("user", "thanks"), ("user", "thanks")]);
    assert!(stored.iter().all(|(_, _, embedded)| !embedded), "no model, no vectors");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_same_messages_again_store_nothing_and_a_longer_transcript_stores_only_what_is_new() {
    let pg = TestPg::start().await;
    let (db, ingest) = open(&pg).await;
    send(&ingest, "s1", Some(transcript())).await;
    assert_eq!(send(&ingest, "s1", Some(transcript())).await, "ingest_session: considered=4 inserted=0 session=s1");
    let mut longer = transcript();
    longer.as_array_mut().unwrap().push(json!({ "role": "assistant", "content": "The cluster is healthy." }));
    longer.as_array_mut().unwrap().push(json!({ "role": "user", "content": "thanks" }));
    assert_eq!(send(&ingest, "s1", Some(longer)).await, "ingest_session: considered=6 inserted=2 session=s1");
    assert_eq!(rows(&db, "s1").await.len(), 6);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn another_session_with_the_same_text_stores_its_own_rows_and_no_messages_store_nothing() {
    let pg = TestPg::start().await;
    let (db, ingest) = open(&pg).await;
    send(&ingest, "s1", Some(transcript())).await;
    let twice = json!([{ "role": "user", "content": "thanks" }, { "role": "user", "content": "thanks" }]);
    assert_eq!(send(&ingest, "s2", Some(twice)).await, "ingest_session: considered=2 inserted=2 session=s2");
    assert_eq!(rows(&db, "s2").await.len(), 2);
    assert_eq!(rows(&db, "s1").await.len(), 4);
    assert_eq!(send(&ingest, "s2", None).await, "ingest_session: considered=0 inserted=0 session=s2");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn system_text_tool_results_and_empty_text_are_not_stored() {
    let pg = TestPg::start().await;
    let (db, ingest) = open(&pg).await;
    let messages = json!([
        { "role": "system", "content": "hidden system prompt" },
        { "role": "tool", "toolCallId": "call-1", "content": "ok exit 0" },
        { "role": "assistant", "content": "." },
        { "role": "user", "content": "keep this question" },
    ]);
    send(&ingest, "s1", Some(messages)).await;
    let stored = rows(&db, "s1").await;
    assert!(stored.iter().any(|(_, content, _)| content == "keep this question"));
    assert!(stored.iter().all(|(_, content, _)| content != "hidden system prompt" && content != "."), "{stored:?}");
}
