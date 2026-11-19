//! What the session-search writer stores: how a value marked sensitive replaces rows already written (also the rows of messages the
//! transcript has since dropped), and what a completed turn writes, from the first one to a rewound transcript.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::memory::pg::db::{Db, Schema};
use crate::memory::session_search::db::{SessionSearchDb, search_rows};
use crate::memory::session_search::ingest::{IngestSession, SensitiveValues, SessionSearchIngest};
use crate::memory::tests::support::TestPg;

const SECRET: &str = "682419";

/// A session's marked value, which can be set after rows were written.
#[derive(Default)]
struct Marked(Mutex<Option<String>>);

impl Marked {
    fn mark(&self) {
        *self.0.lock().unwrap() = Some("v1".to_owned());
    }
}

impl SensitiveValues for Marked {
    fn version(&self, _: &str) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn redact_message(&self, session_id: &str, message: &Value) -> Value {
        let mut message = message.clone();
        if let Some(text) = message["content"].as_str() {
            message["content"] = Value::String(self.redact_text(session_id, text));
        }
        message
    }
    fn redact_text(&self, _: &str, text: &str) -> String {
        if self.0.lock().unwrap().is_some() { text.replace(SECRET, "[redacted]") } else { text.to_owned() }
    }
}

struct Stored {
    reference: String,
    ordinal: i32,
    role: String,
    ts: Option<i64>,
    content: String,
}

async fn stored(raw: &Db, session_id: &str) -> Vec<Stored> {
    raw.query("SELECT source_ref, ordinal, role, ts, content FROM session_search.messages WHERE session_id = $1 ORDER BY ordinal, content", &[&session_id])
        .await
        .expect("rows")
        .iter()
        .map(|r| Stored { reference: r.get(0), ordinal: r.get(1), role: r.get(2), ts: r.get(3), content: r.get(4) })
        .collect()
}

fn contents(rows: &[Stored]) -> Vec<&str> {
    rows.iter().map(|r| r.content.as_str()).collect()
}

fn say(role: &str, text: &str, ts: i64) -> Value {
    json!({ "role": role, "content": text, "ts": ts })
}

fn redacted(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(|m| json!({ "role": m["role"], "content": m["content"].as_str().unwrap().replace(SECRET, "[redacted]"), "ts": m["ts"] })).collect()
}

fn is_fresh_id(reference: &str, session_id: &str) -> bool {
    reference.strip_prefix(&format!("session:{session_id}:")).is_some_and(|hex| hex.len() == 24 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

async fn open(pg: &TestPg) -> (SessionSearchDb, Db) {
    (SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open"), pg.db(Schema::SessionSearch).await)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn replacing_a_marked_value_rewrites_only_the_rows_that_hold_it_keeping_ordinal_role_and_time() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let plain = vec![say("user", "Finish the sign-up.", 10), say("assistant", &format!("The code is {SECRET}."), 20), say("user", "Thanks, done", 30)];
    let other = vec![say("user", &format!("Someone else's {SECRET}"), 5)];
    db.append("s", &plain).await.unwrap();
    db.append("other", &other).await.unwrap();
    let before = stored(&raw, "s").await;
    let redact = |t: &str| t.replace(SECRET, "[redacted]");
    assert_eq!(db.replace("s", &plain, &redacted(&plain), &redact).await.unwrap(), 1);
    let after = stored(&raw, "s").await;
    assert_eq!(contents(&after), ["Finish the sign-up.", "The code is [redacted].", "Thanks, done"]);
    assert_eq!(after.iter().map(|r| (r.ordinal, r.role.as_str(), r.ts)).collect::<Vec<_>>(), [(0, "user", Some(10)), (1, "assistant", Some(20)), (2, "user", Some(30))]);
    assert_eq!((&before[0].reference, &before[2].reference), (&after[0].reference, &after[2].reference), "an untouched row keeps its identity");
    assert_eq!(after[1].reference, search_rows("s", &redacted(&plain))[1].source_ref, "a replaced row of the transcript has the identity of its redacted message");
    assert_eq!(contents(&stored(&raw, "other").await), [format!("Someone else's {SECRET}").as_str()], "another session is not touched");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_replace_that_changes_nothing_deletes_nothing_and_a_second_one_finds_nothing_left() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let plain = vec![say("user", "Nothing secret here", 1), say("assistant", &format!("Code {SECRET}"), 2)];
    db.append("s", &plain).await.unwrap();
    let redact = |t: &str| t.replace(SECRET, "[redacted]");
    assert_eq!(db.replace("s", &plain, &redacted(&plain), &|t: &str| t.to_owned()).await.unwrap(), 0);
    assert_eq!(contents(&stored(&raw, "s").await), ["Nothing secret here", format!("Code {SECRET}").as_str()]);
    assert_eq!(db.replace("s", &plain, &redacted(&plain), &redact).await.unwrap(), 1);
    assert_eq!(db.replace("s", &plain, &redacted(&plain), &redact).await.unwrap(), 0);
    assert_eq!(contents(&stored(&raw, "s").await), ["Nothing secret here", "Code [redacted]"]);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn the_row_of_a_message_the_transcript_dropped_is_rewritten_under_a_fresh_random_identity() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let old = vec![say("assistant", &format!("The code is {SECRET}."), 20), say("user", "Next step please", 30)];
    db.append("s", &old).await.unwrap();
    let old_ref = stored(&raw, "s").await.into_iter().find(|r| r.content.contains(SECRET)).unwrap().reference;
    // The transcript was compacted: only the second message is left.
    let now = vec![old[1].clone()];
    let redact = |t: &str| t.replace(SECRET, "[redacted]");
    assert_eq!(db.replace("s", &now, &redacted(&now), &redact).await.unwrap(), 1);
    let after = stored(&raw, "s").await;
    assert_eq!(contents(&after), ["The code is [redacted].", "Next step please"]);
    let kept = &after[0];
    assert_eq!((kept.ordinal, kept.role.as_str(), kept.ts), (0, "assistant", Some(20)));
    assert!(is_fresh_id(&kept.reference, "s") && kept.reference != old_ref, "{}", kept.reference);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_turn_writes_the_new_rows_only_and_an_unchanged_transcript_writes_nothing() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let ingest = SessionSearchIngest::new(db, Arc::new(Marked::default()));
    let mut transcript = vec![say("user", "Plan the release", 1), say("assistant", "Drafting the plan", 2)];
    let turn = |messages: &[Value]| IngestSession { id: "s".into(), messages: messages.to_vec(), agent_only: false };
    ingest.ingest_turn(turn(&transcript));
    ingest.settle("s").await;
    let first = stored(&raw, "s").await;
    assert_eq!(first.iter().map(|r| r.ordinal).collect::<Vec<_>>(), [0, 1]);
    ingest.ingest_turn(turn(&transcript));
    ingest.settle("s").await;
    assert_eq!(stored(&raw, "s").await.len(), 2);
    transcript.push(json!({ "role": "tool", "content": "tool output" }));
    transcript.push(say("user", "Ship it", 4));
    ingest.ingest_turn(turn(&transcript));
    ingest.settle("s").await;
    let grown = stored(&raw, "s").await;
    assert_eq!(contents(&grown), ["Plan the release", "Drafting the plan", "Ship it"]);
    assert_eq!(grown.iter().map(|r| r.ordinal).collect::<Vec<_>>(), [0, 1, 3], "a row keeps its place in the whole transcript, a tool message leaves a gap");
    assert_eq!(grown[0].reference, first[0].reference, "earlier rows are not written again");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn an_earlier_edit_is_indexed_even_if_the_rest_of_the_prefix_did_not_move() {
    let pg = TestPg::start().await;
    let (db, _) = open(&pg).await;
    let ingest = SessionSearchIngest::new(db.clone(), Arc::new(Marked::default()));
    let turn = |messages| IngestSession { id: "s".into(), messages, agent_only: false };
    let mut transcript = vec![say("user", "original request", 1), say("assistant", "same last answer", 2)];
    ingest.ingest_turn(turn(transcript.clone()));
    ingest.settle("s").await;
    transcript[0] = say("user", "revised heron request", 1);
    ingest.ingest_turn(turn(transcript.clone()));
    ingest.settle("s").await;
    assert_eq!(db.search("heron", 10).await.unwrap().len(), 1);
    transcript[0] = say("user", "revised badger request", 1);
    transcript.push(say("user", "additional sparrow request", 3));
    ingest.ingest_turn(turn(transcript));
    ingest.settle("s").await;
    assert_eq!(db.search("badger", 10).await.unwrap().len(), 1);
    assert_eq!(db.search("sparrow", 10).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn an_empty_nameless_or_agent_only_turn_stores_nothing() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let ingest = SessionSearchIngest::new(db, Arc::new(Marked::default()));
    let messages = vec![say("user", "Hello there", 1)];
    ingest.ingest_turn(IngestSession { id: String::new(), messages: messages.clone(), agent_only: false });
    ingest.ingest_turn(IngestSession { id: "s".into(), messages: Vec::new(), agent_only: false });
    ingest.ingest_turn(IngestSession { id: "s".into(), messages, agent_only: true });
    ingest.settle("s").await;
    let n: i64 = raw.query_opt("SELECT count(*) FROM session_search.messages", &[]).await.unwrap().unwrap().get(0);
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_value_marked_after_rows_were_stored_replaces_them_on_the_next_turn_and_new_rows_are_stored_redacted() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let marked = Arc::new(Marked::default());
    let ingest = SessionSearchIngest::new(db, marked.clone());
    let mut transcript = vec![say("user", "Finish the sign-up", 1), say("assistant", &format!("The code is {SECRET}"), 2)];
    let turn = |messages: &[Value]| IngestSession { id: "s".into(), messages: messages.to_vec(), agent_only: false };
    ingest.ingest_turn(turn(&transcript));
    ingest.settle("s").await;
    assert!(contents(&stored(&raw, "s").await).iter().any(|c| c.contains(SECRET)), "stored as it was said before the mark");
    marked.mark();
    transcript.push(say("user", &format!("Use {SECRET} again"), 3));
    ingest.ingest_turn(turn(&transcript));
    ingest.settle("s").await;
    let after = stored(&raw, "s").await;
    assert_eq!(contents(&after), ["Finish the sign-up", "The code is [redacted]", "Use [redacted] again"]);
    assert!(after.iter().all(|r| !r.content.contains(SECRET)));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn a_rewound_transcript_adds_its_new_rows_and_keeps_the_stored_ones() {
    let pg = TestPg::start().await;
    let (db, raw) = open(&pg).await;
    let ingest = SessionSearchIngest::new(db, Arc::new(Marked::default()));
    let turn = |messages: Vec<Value>| IngestSession { id: "s".into(), messages, agent_only: false };
    ingest.ingest_turn(turn(vec![say("user", "First question", 1), say("assistant", "First answer", 2)]));
    ingest.settle("s").await;
    // The history was compacted and the conversation went on: the last stored message is no longer where it was.
    ingest.ingest_turn(turn(vec![say("user", "Summary of earlier work", 3), say("assistant", "Understood", 4), say("user", "Second question", 5)]));
    ingest.settle("s").await;
    assert_eq!(stored(&raw, "s").await.len(), 5, "the rows already stored stay; the compacted transcript's rows are added");
}
