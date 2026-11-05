#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixtures read the corpus with blocking std::fs"
)]

use std::collections::BTreeMap;
use std::collections::HashMap;

use mixdog_store::schema::record::Form;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::json::js_stable;
use crate::run::tests::corpus;
use crate::run::tests::migrate_corpus;
use crate::session::target::FoldedRow;

/// An attachment store held in memory.
#[derive(Default)]
struct MemoryBlobs(HashMap<String, Vec<u8>>);

impl MemoryBlobs {
    fn put(&mut self, bytes: &[u8]) -> String {
        let hex = crate::durable::sha256_hex(bytes);
        self.0.insert(hex.clone(), bytes.to_vec());
        hex
    }
}

impl Blobs for MemoryBlobs {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let bytes = self.0.get(hex).ok_or(ReadError::Missing)?;
        Ok((bytes.len() as u64 <= max_bytes).then(|| String::from_utf8_lossy(bytes).into_owned()))
    }
}

fn shown(message: Value) -> Shown {
    user_row(&message, &mut UserText::new(&MemoryBlobs::default()))
}

#[test]
fn rows_node_hides_restore_as_nothing() {
    for message in [
        json!({"role": "user", "content": "loaded skill body", "meta": "skill"}),
        json!({"role": "user", "content": "hook output", "meta": "hook"}),
        json!({"role": "user", "content": "<system-reminder>\nx\n</system-reminder>"}),
        json!({"role": "user", "content": "[mixdog-runtime] The app restarted mid-turn."}),
        json!({"role": "user", "content": "[Request interrupted by user]"}),
        json!({"role": "user", "content": "   "}),
    ] {
        assert_eq!(shown(message.clone()), Shown::Nothing, "{message}");
    }
}

#[test]
fn the_cancel_line_is_an_interrupted_turn_end() {
    for text in ["[Request interrupted]", "[request interrupted by process restart]"] {
        assert_eq!(shown(json!({"role": "user", "content": text})), Shown::TurnEnd, "{text}");
    }
}

#[test]
fn notices_steering_and_imports_keep_their_meaning() {
    let held = json!({"role": "user", "content": "[mixdog-runtime] Held", "meta": {"source": "held-request", "heldRequest": {"id": "h1"}}});
    assert_eq!(shown(held), Shown::Notice);
    let result = json!({"role": "user", "content": "report", "meta": {"source": "schedule-result"}});
    assert_eq!(shown(result), Shown::Notice);
    let steering = json!({"role": "user", "content": " also this ", "meta": {"source": "steering"}});
    assert_eq!(shown(steering), Shown::User("also this".into()));
    // Imported prose is verbatim, whatever it looks like.
    let imported = json!({"role": "user", "content": "[Request interrupted]", "meta": {"source": "import"}});
    assert_eq!(shown(imported), Shown::User("[Request interrupted]".into()));
}

#[test]
fn a_task_notification_is_a_card() {
    let text = "<task-notification>\n<task-id>job-1</task-id>\n<status>completed</status>\n<summary>Shell task completed (exit 0)</summary>\n<result>\nok\n</result>\n</task-notification>";
    let message = json!({"role": "user", "content": text, "meta": {"source": "task-notification"}});
    let Shown::Card(card) = shown(message) else { panic!("not a card") };
    assert_eq!(card["name"], "shell");
    assert_eq!(card["args"]["task_id"], "job-1");
    assert_eq!(card["result"], "ok");
    assert_eq!(card["isError"], false);
}

#[test]
fn stored_text_parts_show_as_their_chips() {
    let mut blobs = MemoryBlobs::default();
    let paste = blobs.put(b"one\ntwo\nthree\n");
    let named = blobs.put(b"x");
    let file = blobs.put(b"file body");
    let content = json!([
        {"type": "text", "attachmentRef": paste, "textKind": "paste"},
        {"type": "text", "attachmentRef": named, "textKind": "paste", "filename": "Pasted · 12 lines"},
        {"type": "text", "attachmentRef": file, "textKind": "file", "filename": "notes.md"},
        {"type": "text", "text": "[Image: shot.png]"},
        {"type": "image", "mimeType": "image/png"},
        {"type": "image", "mimeType": "image/jpeg"},
    ]);
    let text = UserText::new(&blobs).text(Some(&content));
    assert_eq!(
        text,
        "[Pasted text #1 +3 lines]\n[Pasted text #2 +12 lines]\n[File #3: notes.md]\n[Image: shot.png]\n[Image: image/jpeg]"
    );
}

#[test]
fn an_offloaded_prompt_restores_only_without_companion_text() {
    let mut blobs = MemoryBlobs::default();
    let long = blobs.put("long prompt ".repeat(10).as_bytes());
    let alone = json!([{"type": "text", "attachmentRef": long}]);
    assert_eq!(UserText::new(&blobs).text(Some(&alone)), "long prompt ".repeat(10));
    let beside = json!([{"type": "text", "attachmentRef": long}, {"type": "text", "text": "real"}]);
    assert_eq!(UserText::new(&blobs).text(Some(&beside)), "real");
}

#[test]
fn visualize_feedback_shows_as_the_live_lines() {
    let content = "before\n<visualize_feedback>\npin 1 · Header\n  note: make it\n    bigger\nchoices:\n  · group: \"Theme\" → choice: \"dark\" (\"Dark\")\n</visualize_feedback>";
    let text = UserText::new(&MemoryBlobs::default()).text(Some(&json!(content)));
    assert_eq!(text, "before\n📌 1 · Header — make it bigger\n☑ Theme: Dark");
}

#[test]
fn room_user_lines_count_for_prompt_history() {
    let own = json!({"role": "user", "content": "hi all", "meta": {"source": "agent-room", "room": {"kind": "user"}}});
    let speech = json!({"role": "user", "content": "reply", "meta": {"source": "agent-room", "room": {"kind": "speech"}}});
    assert_eq!(room_prompt(&own), Some("hi all".into()));
    assert_eq!(room_prompt(&speech), None);
}

// ── The corpus against Node ──────────────────────────────────────────────────

const SCENARIOS: [(&str, &str); 2] = [("v145", "v145"), ("dev146", "dev146")];

/// The migrated transcript rows of every session of a corpus scenario: `(visible, prompt, body)`.
type SessionRows = BTreeMap<String, Vec<(bool, Option<String>, Value)>>;

fn migrated(data_rel: &str, edit: impl FnOnce(&std::path::Path)) -> SessionRows {
    folded_rows(data_rel, edit)
        .into_iter()
        .map(|(id, rows)| {
            let rows = rows
                .into_iter()
                .filter(|r| r.form == Form::Message && r.archive.is_none())
                .map(|r| (r.visible, r.prompt, r.body))
                .collect();
            (id, rows)
        })
        .collect()
}

/// Every folded row of every session of the migrated corpus data dir `data_rel`.
fn folded_rows(data_rel: &str, edit: impl FnOnce(&std::path::Path)) -> BTreeMap<String, Vec<FoldedRow>> {
    let (_dir, roots, complete) = migrate_corpus(data_rel, edit);
    crate::session::target::read_sessions(&roots, &complete.manifest_sha256)
        .unwrap()
        .into_iter()
        .map(|(id, folded)| (id, folded.rows))
        .collect()
}

fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// What a client draws for one migrated row, in the generator's normalized row shape, and
/// its prompt-history text; `None` for a row that is neither a user nor a room message.
fn projected(visible: bool, prompt: &Option<String>, body: &Value) -> Option<(Vec<Value>, Option<String>)> {
    if is_room_row(body) {
        let user = body["meta"]["room"]["kind"] == "user";
        let row = if user {
            json!({"kind": "user", "text": body.get("content").and_then(Value::as_str).unwrap_or("")})
        } else {
            json!({"kind": "notice"})
        };
        return Some((vec![row], prompt.clone()));
    }
    if body.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if !visible {
        return Some((Vec::new(), prompt.clone()));
    }
    let meta = &body["meta"];
    let message_id = meta["transcript"]["messageId"].as_str().filter(|s| !s.is_empty());
    let row = if let Some(card) = meta.get(TASK_CARD) {
        let mut row = serde_json::Map::new();
        row.insert("kind".into(), json!("tool"));
        for (k, v) in card.as_object().unwrap() {
            row.insert(k.clone(), v.clone());
        }
        row.insert("count".into(), json!(1));
        row.insert("completedCount".into(), json!(1));
        if let Some(id) = message_id {
            row.insert("messageId".into(), json!(id));
        }
        let at = meta["transcript"].get("at").map_or(f64::NAN, mixdog_js::to_number);
        if at.is_finite() {
            row.insert("at".into(), js_number(at));
        }
        Value::Object(row)
    } else if let Some(end) = meta.get(TURN_END) {
        let mut row = json!({"kind": "turndone", "status": end["status"], "elapsedMs": end["elapsedMs"]});
        if let Some(id) = message_id {
            row["messageId"] = json!(id);
        }
        row
    } else if let Some(text) = prompt {
        let mut row = json!({"kind": "user", "text": text});
        if meta["source"] == "steering" {
            row["steered"] = json!(true);
        }
        row
    } else if matches!(meta["source"].as_str(), Some("schedule-result" | "held-request")) {
        json!({"kind": "notice"})
    } else {
        json!({"kind": "unclassified"})
    };
    Some((vec![row], prompt.clone()))
}

#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn restored_rows_match_node() {
    let vectors: Value = serde_json::from_str(include_str!("vectors/corpus_rows.json")).unwrap();
    let mut failures = Vec::new();
    let mut compared = 0usize;
    for (scenario, data_rel) in SCENARIOS {
        let expected = vectors[scenario].as_object().expect("a scenario of the vectors");
        let sessions = migrated(data_rel, |_| {});
        assert_eq!(
            sessions.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>(),
            "{scenario}: sessions"
        );
        for (id, rows) in &sessions {
            let want = expected[id].as_array().unwrap();
            let got: Vec<(usize, Vec<Value>, Option<String>)> = rows
                .iter()
                .enumerate()
                .filter_map(|(i, (visible, prompt, body))| projected(*visible, prompt, body).map(|(r, p)| (i, r, p)))
                .collect();
            assert_eq!(got.len(), want.len(), "{scenario}/{id}: user and room messages");
            for ((index, rows, prompt), want) in got.iter().zip(want) {
                compared += 1;
                let digest = crate::durable::sha256_hex(js_stable(&json!({"rows": rows, "prompt": prompt})).as_bytes());
                let kinds = rows.iter().map(|r| r["kind"].as_str().unwrap_or("")).collect::<Vec<_>>().join(",");
                if want[0].as_u64() != Some(*index as u64) || want[2].as_str() != Some(digest.as_str()) {
                    failures.push(format!(
                        "{scenario}/{id}#{index}: node {} [{}], migrated [{kinds}] {}",
                        want[0], want[1], json!({"rows": rows, "prompt": prompt})
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of {compared} differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn only_segments_the_archive_index_reads_are_shown() {
    use crate::session::source::indexed_segment;
    let line = |bytes: usize, body: &str| format!(r#"{{"v":1,"seq":2,"id":"seg2","prev":"seg1","at":5,"count":1,"bytes":{bytes},"items":{body}}}"#);
    assert!(indexed_segment(line(9, r#"[{"a":1}]"#).as_bytes()));
    assert!(!indexed_segment(line(8, r#"[{"a":1}]"#).as_bytes()), "bytes short of the line");
    assert!(!indexed_segment(line(10, r#"[{"a":1}]"#).as_bytes()), "bytes past the line");
    let reordered = r#"{"seq":2,"v":1,"id":"seg2","prev":null,"at":5,"count":1,"bytes":2,"items":[]}"#;
    assert!(!indexed_segment(reordered.as_bytes()));
}

/// The transcript-display recorder's one credential shape.
const REDACTION_PATTERN: &str = r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.";

/// Every string of `value` with `REDACTION_PATTERN` matches replaced by `marker`.
fn redact(value: &mut Value, marker: &str) {
    match value {
        Value::String(text) => *text = redact_text(text, marker),
        Value::Array(items) => items.iter_mut().for_each(|v| redact(v, marker)),
        Value::Object(map) => map.values_mut().for_each(|v| redact(v, marker)),
        _ => {}
    }
}

fn redact_text(text: &str, marker: &str) -> String {
    let bytes = text.as_bytes();
    let word = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-';
    // At least ten word bytes from `at`, then a dot: the index after the dot.
    let run = |at: usize| {
        let end = at + bytes[at..].iter().take_while(|b| word(b)).count();
        (end - at >= 10 && bytes.get(end) == Some(&b'.')).then_some(end + 1)
    };
    let (mut out, mut copied, mut from) = (String::with_capacity(text.len()), 0, 0);
    while let Some(found) = text[from..].find("eyJ") {
        let start = from + found;
        match run(start + 3).and_then(run) {
            Some(end) => {
                out.push_str(&text[copied..start]);
                out.push_str(marker);
                (copied, from) = (end, end);
            }
            None => from = start + 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

#[test]
fn redaction_replaces_the_recorders_credential_shape() {
    let token = format!("eyJ{}.{}.sig", "a".repeat(10), "b-_".repeat(4));
    assert_eq!(redact_text(&format!("x {token} eyJshort.y"), "«r»"), "x «r»sig eyJshort.y");
}

/// The archive/live split of migrated sessions is the one Node shows (WP-TRANSCRIPT's
/// display golden): the visible archive rows, in order, are exactly the archive page's
/// rows, and they precede every live row.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn archived_rows_match_the_transcript_display() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/migration/transcript-display/display.json");
    let golden: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(golden["redact"]["patterns"], json!([REDACTION_PATTERN]));
    let marker = golden["redact"]["marker"].as_str().unwrap();
    let golden = golden["sessions"].as_array().unwrap();
    let (mut failures, mut seen, mut compared) = (Vec::new(), 0usize, 0usize);
    for data_rel in ["v145", "dev146", "fixture-busy-seed/data"] {
        let sessions = folded_rows(data_rel, |_| {});
        let prefix = format!("{data_rel}/sessions/");
        for want in golden.iter().filter(|s| s["key"].as_str().unwrap().starts_with(&prefix)) {
            seen += 1;
            let id = want["id"].as_str().unwrap();
            // The recorder reads the json alone; a dev log beside it is the dev runtime's
            // source (SM §11.4.2), which the golden does not describe.
            if corpus().join(data_rel).join("sessions").join(format!("{id}.log.jsonl")).exists() {
                continue;
            }
            compared += 1;
            let Some(rows) = sessions.get(id) else {
                failures.push(format!("{data_rel}/{id}: not migrated"));
                continue;
            };
            let first_live = rows.iter().position(|r| r.archive.is_none()).unwrap_or(rows.len());
            if rows[first_live..].iter().any(|r| r.archive.is_some()) {
                failures.push(format!("{data_rel}/{id}: an archive row after a live row"));
            }
            let got: Vec<Value> = rows[..first_live]
                .iter()
                .filter(|r| r.visible)
                .map(|r| {
                    let mut body = r.body.clone();
                    redact(&mut body, marker);
                    body
                })
                .collect();
            let archived = want["archived"].as_u64().unwrap() as usize;
            let want = &want["rows"].as_array().unwrap()[..archived];
            if got != want {
                let at = got.iter().zip(want).position(|(g, w)| g != w);
                failures.push(format!(
                    "{data_rel}/{id}: {} visible archive rows, node {archived}; first difference at {at:?}",
                    got.len()
                ));
            }
        }
    }
    assert_eq!(seen, golden.len(), "every golden session is a corpus session json");
    assert!(compared >= 30, "{compared} sessions compared");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The legacy replay fields on the 1.4.5 corpus: the corpus sessions carry none, so they
/// are set on copies of its assistant messages before the migration runs.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn legacy_replay_fields_convert_on_the_corpus() {
    let lone = json!([
        {"id": "rs_a", "encrypted_content": "E1", "summary": [{"type": "summary_text", "text": "plan"}]},
        {"type": "reasoning", "id": "rs_b", "encrypted_content": "E2", "summary": [], "afterText": true},
    ]);
    let thoughts = json!([{"text": "thinking", "thought": true, "thoughtSignature": "sig"}]);
    let edit_session = |data: &std::path::Path, id: &str, change: &dyn Fn(&mut Vec<Value>)| {
        let path = data.join("sessions").join(format!("{id}.json"));
        let mut session: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        change(session["messages"].as_array_mut().unwrap());
        std::fs::write(&path, serde_json::to_vec(&session).unwrap()).unwrap();
    };
    let assistants = |messages: &[Value], replayed: bool| -> Vec<usize> {
        (0..messages.len())
            .filter(|&i| messages[i]["role"] == "assistant" && messages[i].get("providerReplay").is_some() == replayed)
            .collect()
    };
    let (lead, imported) = ("sess_home_lead", "sess_synth_imported");
    let (mut plain, mut beside) = (Vec::new(), Vec::new());
    let sessions = migrated("v145", |data| {
        edit_session(data, lead, &|messages| {
            let at = assistants(messages, false);
            messages[at[0]]["reasoningItems"] = lone.clone();
            messages[at[1]]["thoughtParts"] = thoughts.clone();
        });
        edit_session(data, imported, &|messages| {
            let at = assistants(messages, true);
            messages[at[0]]["reasoningItems"] = json!([{"id": "rs_x", "encrypted_content": "EX", "summary": []}]);
        });
        let read = |id: &str| -> Vec<Value> {
            let path = data.join("sessions").join(format!("{id}.json"));
            let session: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            session["messages"].as_array().unwrap().clone()
        };
        plain = read(lead);
        beside = read(imported);
    });
    for (id, rows) in &sessions {
        for (_, _, body) in rows {
            assert!(body.get("reasoningItems").is_none() && body.get("thoughtParts").is_none(), "{id}: {body}");
        }
    }
    // The transcript rows are the session's messages in order.
    assert_eq!(sessions[lead].len(), plain.len());
    assert_eq!(sessions[imported].len(), beside.len());
    let body = |id: &str, index: usize| &sessions[id][index].2;
    let at = assistants(&plain, false);
    let (first, second) = (at[0], at[1]);
    // The envelope is the converter's (golden-checked against Node in `reasoning`), and it
    // carries the message's text and calls besides the reasoning.
    let mut want = plain[first].clone();
    super::reasoning::convert(&mut want);
    let replay = &body(lead, first)["providerReplay"];
    assert_eq!(serde_json::to_string(replay).unwrap(), serde_json::to_string(&want["providerReplay"]).unwrap());
    let kinds: Vec<&str> = replay["items"].as_array().unwrap().iter().map(|i| i["type"].as_str().unwrap_or("")).collect();
    assert_eq!(kinds[0], "reasoning", "{kinds:?}");
    assert!(kinds.iter().any(|k| *k != "reasoning"), "{kinds:?}");
    assert_eq!(body(lead, second)["providerMetadata"]["gemini"]["thoughtParts"], thoughts);
    let at = assistants(&beside, true)[0];
    assert_eq!(body(imported, at)["providerReplay"], beside[at]["providerReplay"]);
    // Everything else of the changed messages is as stored.
    for (id, messages, index) in [(lead, &plain, first), (lead, &plain, second), (imported, &beside, at)] {
        let strip = |v: &Value| {
            let mut v = v.clone();
            for key in ["reasoningItems", "thoughtParts", "providerReplay", "providerMetadata"] {
                v.as_object_mut().unwrap().shift_remove(key);
            }
            v
        };
        assert_eq!(strip(body(id, index)), strip(&messages[index]), "{id}#{index}");
    }
}
