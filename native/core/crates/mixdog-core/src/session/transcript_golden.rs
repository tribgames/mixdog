//! The Rust projection against Node's recorded display of every migration-corpus session
//! (`fixtures/migration/transcript-display/display.json`, recorded by
//! `benchmarks/rust-core/recorders/record-transcript-display.mjs`).
//!
//! Compared per session, after `restoreTranscriptItems` and without the leading compaction-
//! archive rows (those are imported verbatim, see `display_item`):
//! - every row but a tool card equals Node's row field for field, but for its `id`
//!   (Node counts `hist_<session>_<message index>_<part>`; Rust ids are the record's `iid`)
//!   and `finalAssistantId`, which names such an id;
//! - a run of consecutive tool cards equals Node's run: the same call ids in order. Node folds
//!   a run into one aggregate card; folding stays with the client's `rowOf`.
//!
//! Needs the corpus (`MIXDOG_MIGRATION_CORPUS`), so it runs only on request:
//! `cargo test -p mixdog-core --lib transcript_golden -- --ignored`.

use std::path::PathBuf;

use mixdog_protocol::tool_visibility::is_hidden_tool_item;
use mixdog_migrate::session::model::Row;
use mixdog_migrate::session::restore::convert;
use mixdog_migrate::session::restore::user_text::Blobs;
use mixdog_migrate::session::restore::user_text::ReadError;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::ItemRecord;
use regex::Regex;
use serde_json::Value;
use serde_json::json;

use super::transcript_rows::Restored;
use super::transcript_rows::restore;

const DEFAULT_DATA: &str = "C:/Users/tempe/.mixdog/data";
const DEFAULT_CORPUS: &str = "C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus";

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/transcript-display/display.json");
    serde_json::from_slice(&std::fs::read(path).expect("display.json")).expect("display.json parses")
}

/// JSON equality that does not tell `5` from `5.0` (a JS number has one type).
fn normal(value: &Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => json!(f as i64),
            _ => value.clone(),
        },
        Value::Array(list) => Value::Array(list.iter().map(normal).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), normal(v))).collect()),
        other => other.clone(),
    }
}

fn redact(value: &Value, patterns: &[Regex], marker: &str) -> Value {
    match value {
        Value::String(s) => Value::String(patterns.iter().fold(s.clone(), |s, re| re.replace_all(&s, marker).into_owned())),
        Value::Array(list) => Value::Array(list.iter().map(|v| redact(v, patterns, marker)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), redact(v, patterns, marker))).collect()),
        other => other.clone(),
    }
}

/// A row as compared: no ids.
fn comparable(row: &Value) -> Value {
    let mut row = normal(row);
    if let Some(map) = row.as_object_mut() {
        map.remove("id");
        map.remove("finalAssistantId");
    }
    row
}

/// The tokens of a row list: one per non-tool row, one per run of tool cards.
fn tokens(rows: &[Value]) -> Vec<Value> {
    // Node's aggregate lists only the calls that have an id (`callIds` is filtered), so a
    // card without one (task notification) shows in a run only beside no call at all.
    let ended = |mut calls: Vec<Value>| {
        if calls.iter().any(|c| !c.is_null()) {
            calls.retain(|c| !c.is_null());
        }
        json!({ "tools": calls })
    };
    let mut out: Vec<Value> = Vec::new();
    let mut run: Option<Vec<Value>> = None;
    for row in rows {
        if row["kind"] == "tool" {
            let calls = run.get_or_insert_with(Vec::new);
            if row["aggregate"] == true {
                match row.get("callIds").and_then(Value::as_array) {
                    Some(ids) => calls.extend(ids.iter().cloned()),
                    None => calls.extend((0..row["completedCount"].as_u64().unwrap_or(0)).map(|_| Value::Null)),
                }
            } else {
                calls.push(row.get("callId").cloned().unwrap_or(Value::Null));
            }
            continue;
        }
        if let Some(calls) = run.take() {
            out.push(ended(calls));
        }
        out.push(comparable(row));
    }
    if let Some(calls) = run {
        out.push(ended(calls));
    }
    out
}

/// The prompt-attachment store Node read the user text from (`<data>/prompt-attachments`).
struct DataBlobs(PathBuf);

impl Blobs for DataBlobs {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let path = self.0.join("prompt-attachments/sha256").join(&hex[..2]).join(hex);
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() as u64 > max_bytes => Ok(None),
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ReadError::Missing),
            Err(_) => Err(ReadError::Other),
        }
    }
}

/// The records migration writes for the messages (`restore::convert`: hidden rows, task
/// cards, the cancel line and the prompt text are typed facts there), shown by the projection.
fn rust_rows(messages: &[Value], data: &std::path::Path) -> Vec<Value> {
    let mut staged: Vec<Row> = messages
        .iter()
        .enumerate()
        .map(|(index, message)| Row {
            iid: format!("m{index}"),
            turn: None,
            role: message["role"].as_str().map(str::to_owned),
            form: Form::Message,
            model: true,
            visible: true,
            archive: None,
            prompt: None,
            body: message.clone(),
        })
        .collect();
    convert(staged.iter_mut(), &DataBlobs(data.to_owned()));
    let mut rows = Vec::new();
    for staged in staged {
        if !staged.visible {
            continue;
        }
        let message = &staged.body;
        let mut record: ItemRecord = serde_json::from_value(json!({
            "iid": staged.iid, "form": "message", "model": true, "visible": true,
            "refs": [], "body": { "inline": {} },
        }))
        .expect("record shape");
        record.body = Slot::Inline(message.clone());
        record.prompt = staged.prompt.clone().map(Slot::Inline);
        for restored in restore(&record, message) {
            match restored {
                Restored::Row { row, .. } => rows.push(Value::Object(row)),
                Restored::Result(fact) => {
                    let call = rows.iter_mut().find(|r| r["callId"] == json!(fact.call_id));
                    if let Some(call) = call {
                        call["result"] = json!(fact.text);
                    }
                }
                Restored::Room { id } => rows.push(json!({ "kind": "room", "id": id })),
            }
        }
    }
    rows.retain(|row| !hidden_tool(row));
    rows
}

/// Node's restore drops the settled calls the transcript must not show before the display
/// the fixture records; the projection leaves them to the one shared rule.
fn hidden_tool(row: &Value) -> bool {
    row["kind"] == "tool"
        && is_hidden_tool_item(row["name"].as_str().unwrap_or(""), row["result"].as_str().unwrap_or(""))
}

/// Per message, whether the shared classifier says Node's restore shows a row for it
/// (`fixtures/migration/message-presence/presence.json`, `record-message-presence.mjs`).
#[test]
#[ignore = "needs the migration corpus"]
fn presence_equals_nodes_for_every_message() {
    use mixdog_protocol::message_class::messages_shown;
    use mixdog_protocol::message_class::user_text::UserText;

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/message-presence/presence.json");
    let presence: Value = serde_json::from_slice(&std::fs::read(path).expect("presence.json")).expect("json");
    let corpus = PathBuf::from(std::env::var("MIXDOG_MIGRATION_CORPUS").unwrap_or_else(|_| DEFAULT_CORPUS.into()));
    let data = PathBuf::from(std::env::var("MIXDOG_DATA_DIR").unwrap_or_else(|_| DEFAULT_DATA.into()));
    let blobs = DataBlobs(data);
    let mut failures = Vec::new();
    for session in presence["sessions"].as_array().expect("sessions") {
        let key = session["key"].as_str().expect("key");
        let stored: Value = serde_json::from_slice(&std::fs::read(corpus.join(key)).expect("session")).expect("json");
        let messages = stored["messages"].as_array().expect("messages");
        let got = messages_shown(messages, &mut UserText::new(&blobs));
        let want: Vec<bool> = session["shown"].as_array().expect("shown").iter().map(|v| v == true).collect();
        for (index, (g, w)) in got.iter().zip(&want).enumerate() {
            if g != w {
                let brief: String = messages[index].to_string().chars().take(300).collect();
                failures.push(format!("{key}[{index}]: rust {g} node {w}: {brief}"));
            }
        }
        assert_eq!(got.len(), want.len(), "{key}: message count");
    }
    assert!(failures.is_empty(), "{} messages differ:\n{}", failures.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
#[ignore = "needs the migration corpus"]
fn rows_equal_nodes_for_every_corpus_session() {
    let display = fixture();
    let corpus = PathBuf::from(std::env::var("MIXDOG_MIGRATION_CORPUS").unwrap_or_else(|_| DEFAULT_CORPUS.into()));
    let data = PathBuf::from(std::env::var("MIXDOG_DATA_DIR").unwrap_or_else(|_| DEFAULT_DATA.into()));
    let marker = display["redact"]["marker"].as_str().expect("marker").to_owned();
    let patterns: Vec<Regex> = display["redact"]["patterns"]
        .as_array()
        .expect("patterns")
        .iter()
        .map(|p| Regex::new(p.as_str().expect("pattern")).expect("portable pattern"))
        .collect();
    let mut failures = Vec::new();
    let sessions = display["sessions"].as_array().expect("sessions");
    for session in sessions {
        let key = session["key"].as_str().expect("key");
        let stored: Value = serde_json::from_slice(&std::fs::read(corpus.join(key)).expect("corpus session")).expect("json");
        let archived = session["archived"].as_u64().expect("archived") as usize;
        let node: Vec<Value> = session["rows"].as_array().expect("rows")[archived..].to_vec();
        let messages = stored["messages"].as_array().expect("messages");
        let rust: Vec<Value> = rust_rows(messages, &data).iter().map(|r| redact(r, &patterns, &marker)).collect();
        let (want, got) = (tokens(&node), tokens(&rust));
        if want != got {
            let at = want.iter().zip(&got).position(|(w, g)| w != g).unwrap_or(want.len().min(got.len()));
            let shown = |list: &[Value]| {
                list.get(at).map_or("-".into(), |v| v.to_string().chars().take(700).collect::<String>())
            };
            failures.push(format!(
                "{key}: {} node vs {} rust tokens; first difference at {at}\n  node: {}\n  rust: {}",
                want.len(),
                got.len(),
                shown(&want),
                shown(&got),
            ));
        }
    }
    assert!(failures.is_empty(), "{} of {} sessions differ:\n{}", failures.len(), sessions.len(), failures.join("\n"));
}
