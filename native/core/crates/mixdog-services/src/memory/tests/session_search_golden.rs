//! The session-search writer against the Node product: which transcript messages
//! become rows (and with which identity, order, time and text), how a value marked
//! sensitive replaces stored rows, and the per-turn ingest on top of both. The
//! golden is `scratch .../session-search-golden.mjs`'s record of
//! `sessionSearchRows`, `replaceSessionSearchMessages` and `ingestSessionTurn`.

use std::collections::HashSet;
use std::sync::Arc;

use chrono_tz::Tz;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::memory::pg::db::{Db, Schema};
use crate::memory::sensitive::SensitiveStore;
use crate::memory::session_search::db::{SessionSearchDb, search_rows};
use crate::memory::session_search::ingest::{IngestSession, SessionSearchIngest};
use crate::memory::tests::support::TestPg;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/tools/memory/session-search/golden.json");

fn golden() -> Value {
    serde_json::from_str(&GOLDEN).expect("golden")
}

/// `{"$gen": {prefix, unit, times, suffix}}` stands for a long generated text.
fn expand(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
        Value::Object(map) => match map.get("$gen") {
            Some(spec) => {
                let text = |key: &str| spec[key].as_str().unwrap_or_default().to_owned();
                let times = usize::try_from(spec["times"].as_u64().expect("times")).expect("fits");
                Value::String(format!("{}{}{}", text("prefix"), text("unit").repeat(times), text("suffix")))
            }
            None => Value::Object(map.iter().map(|(k, v)| (k.clone(), expand(v))).collect()),
        },
        other => other.clone(),
    }
}

fn expand_all(values: &Value) -> Vec<Value> {
    values.as_array().expect("array").iter().map(expand).collect()
}

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A row in the golden's shape: long texts as length and digest.
fn shape(reference: Option<&str>, ordinal: i64, role: &str, ts: Option<i64>, content: &str) -> Value {
    let mut row = json!({ "ref": reference, "ordinal": ordinal, "role": role, "ts": ts });
    if content.len() > 1000 || mixdog_js::utf16_len(content) > 1000 {
        row["contentLen"] = json!(mixdog_js::utf16_len(content));
        row["contentSha"] = json!(sha(content));
    } else {
        row["content"] = json!(content);
    }
    row
}

#[test]
fn rows_match_the_node_session_search_rows() {
    let golden = golden();
    let mut failures = Vec::new();
    let mut compared = 0;
    mixdog_js::time::with_local_zone(Tz::UTC, || {
        for case in golden["rows"].as_array().expect("rows") {
            let id = case["sessionId"].as_str().expect("id");
            let messages = expand_all(&case["messages"]);
            let actual: Vec<Value> = search_rows(id, &messages)
                .iter()
                .map(|r| shape(Some(&r.source_ref), i64::from(r.ordinal), r.role, r.ts, &r.content))
                .collect();
            let expected = case["rows"].as_array().expect("expected").clone();
            compared += expected.len();
            if expected != actual {
                let at = expected.iter().zip(&actual).position(|(e, a)| e != a).unwrap_or(expected.len().min(actual.len()));
                failures.push(format!(
                    "{}: {} rows expected, {} found; first difference at {at}\n expected {:?}\n actual   {:?}",
                    case["name"],
                    expected.len(),
                    actual.len(),
                    expected.get(at),
                    actual.get(at)
                ));
            }
        }
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(compared > 150, "{compared}");
}

async fn table(db: &Db, session_id: &str, derived: &HashSet<String>) -> Vec<Value> {
    let rows = db
        .query(
            "SELECT source_ref, ordinal, role, ts, content FROM session_search.messages
              WHERE session_id = $1 ORDER BY ordinal, content, role",
            &[&session_id],
        )
        .await
        .expect("table");
    rows.iter()
        .map(|row| {
            let reference: String = row.get(0);
            let content: String = row.get(4);
            let known = derived.contains(&reference);
            if !known {
                assert!(
                    reference.strip_prefix(&format!("session:{session_id}:")).is_some_and(|hex| {
                        hex.len() == 24 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    }),
                    "a fresh id is 12 random bytes as hex: {reference}"
                );
            }
            json!({
                "ref": known.then_some(reference),
                "ordinal": row.get::<_, i32>(1),
                "role": row.get::<_, String>(2),
                "ts": row.get::<_, Option<i64>>(3),
                "content": content,
            })
        })
        .collect()
}

fn derive(derived: &mut HashSet<String>, session_id: &str, messages: &[Value]) {
    derived.extend(search_rows(session_id, messages).into_iter().map(|r| r.source_ref));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn replacing_sensitive_rows_matches_the_node_replace() {
    let golden = golden();
    let secret = golden["secret"].as_str().expect("secret").to_owned();
    let pg = TestPg::start().await;
    let raw = pg.db(Schema::SessionSearch).await;
    let db = SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open");
    let redact = |text: &str| text.replace(&secret, "[redacted]");
    for scenario in golden["replace"].as_array().expect("scenarios") {
        let id = scenario["sessionId"].as_str().expect("id");
        let name = scenario["name"].as_str().expect("name");
        for other in scenario["others"].as_array().expect("others") {
            db.append(other["sessionId"].as_str().expect("id"), &expand_all(&other["messages"])).await.expect("other");
        }
        let mut derived = HashSet::new();
        for step in scenario["steps"].as_array().expect("steps") {
            if step["op"] == "append" {
                let messages = expand_all(&step["messages"]);
                derive(&mut derived, id, &messages);
                let inserted = db.append(id, &messages).await.expect("append");
                assert_eq!(json!(inserted), step["inserted"], "{name}: inserted");
            } else {
                let (plain, redacted) = (expand_all(&step["plain"]), expand_all(&step["redacted"]));
                derive(&mut derived, id, &plain);
                derive(&mut derived, id, &redacted);
                let deleted = db.replace(id, &plain, &redacted, &redact).await.expect("replace");
                assert_eq!(json!(deleted), step["deleted"], "{name}: deleted");
            }
            let actual = table(&raw, id, &derived).await;
            assert_eq!(Value::Array(actual), step["table"], "{name}: {}", step["op"]);
        }
        for other in scenario["others"].as_array().expect("others") {
            let other_id = other["sessionId"].as_str().expect("id");
            let mut known = HashSet::new();
            derive(&mut known, other_id, &expand_all(&other["messages"]));
            assert_eq!(Value::Array(table(&raw, other_id, &known).await), other["table"], "{name}: other session");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME)"]
async fn per_turn_ingest_matches_the_node_ingest_session_turn() {
    let golden = golden();
    let pg = TestPg::start().await;
    let raw = pg.db(Schema::SessionSearch).await;
    let store = Arc::new(SensitiveStore::default());
    let ingest = SessionSearchIngest::new(SessionSearchDb::open(pg.db(Schema::SessionSearch).await).await.expect("open"), store.clone());
    for scenario in golden["turns"].as_array().expect("scenarios") {
        let id = scenario["sessionId"].as_str().expect("id");
        let name = scenario["name"].as_str().expect("name");
        let mut derived = HashSet::new();
        for step in scenario["steps"].as_array().expect("steps") {
            if step["op"] == "remember" {
                let calls = step["calls"].as_array().expect("calls");
                assert_eq!(json!(store.remember(id, calls)), step["marked"], "{name}: marked");
                assert_eq!(json!(SensitiveStore::version(&store, id)), step["version"], "{name}: version");
                continue;
            }
            let messages = expand_all(&step["messages"]);
            derive(&mut derived, id, &messages);
            derive(&mut derived, id, &store.redact_messages(id, &messages));
            ingest.ingest_turn(IngestSession { id: id.to_owned(), messages, agent_only: false });
            ingest.settle(id).await;
            assert_eq!(Value::Array(table(&raw, id, &derived).await), step["table"], "{name}");
        }
    }
}
