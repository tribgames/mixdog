//! Sensitive-value redaction against the outputs recorded from the Node
//! product (`fixtures/tools/memory/sensitive/golden.json`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::memory::sensitive::SensitiveStore;


/// The attached-files note keeps a record of each file beside its text (`attachedFilesNote`,
/// `attachment-reference.mjs:184-197`): the row stores it and its clients receive it. A marked value in the file's
/// name (and so in its path, which ends in the name) is stored redacted there as in the note's text, as the patched
/// Node's `sensitive-projection.test.mjs` expects of the same message.
#[test]
fn a_marked_value_in_an_attached_files_name_and_path_is_stored_redacted() {
    let session = "sess_sensitive_names";
    let store = SensitiveStore::default();
    assert!(store.remember(session, &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "hunter2" } } })]));
    let path = "C:\\attachments\\ab\\hunter2-notes.pdf";
    let note = json!({ "role": "user", "content": [{
        "type": "text",
        "text": format!("[Attached files on this PC:\n- {path}\n]"),
        "attachmentReference": { "kind": "files", "files": [{ "attachmentRef": "a".repeat(64), "name": "hunter2-notes.pdf", "mimeType": "application/pdf", "sizeBytes": 4, "path": path }] },
    }] });
    let stored = store.redact_messages(session, &[note]);
    let redacted = "C:\\attachments\\ab\\[redacted]-notes.pdf";
    assert_eq!(stored[0]["content"], json!([{
        "type": "text",
        "text": format!("[Attached files on this PC:\n- {redacted}\n]"),
        "attachmentReference": { "kind": "files", "files": [{ "attachmentRef": "a".repeat(64), "name": "[redacted]-notes.pdf", "mimeType": "application/pdf", "sizeBytes": 4, "path": redacted }] },
    }]));
}

/// The patched Node's `transcript-writer-sensitive.test.mjs` ("a value split across three streamed deltas"): the same deltas,
/// each settled text and the whole text as that test asserts them (it runs in Node on the tree the recordings come from).
#[test]
fn a_value_split_across_three_streamed_deltas_is_held_back_until_whole() {
    let store = SensitiveStore::default();
    assert!(store.remember("sess_sensitive_deltas", &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "hunter2" } } })]));
    let mut text = String::new();
    let settled: Vec<String> = ["say hu", "nte", "r2 ok"]
        .iter()
        .map(|delta| {
            text.push_str(delta);
            store.redact_settled_text("sess_sensitive_deltas", &text)
        })
        .collect();
    assert_eq!(settled, ["say ", "say ", "say [redacted] ok"]);
    assert_eq!(store.redact_text("sess_sensitive_deltas", &text), "say [redacted] ok");
}

/// A streamed checkpoint holds back text a later delta can join into a value that holds marker text, however many bytes
/// that value takes: the longest spelling by UTF-16 length (the order the values are tried in) is not the longest in bytes.
#[test]
fn a_streamed_checkpoint_holds_back_text_a_later_marker_would_join_into_a_wider_value() {
    let session = "sess_sensitive_wide";
    let store = SensitiveStore::default();
    let wide = format!("{}[redacted]Z", "\u{5bc6}".repeat(6));
    for value in ["abcdefg[redacted]Z", wide.as_str(), "Q[redacted]", "Yy"] {
        assert!(store.remember(session, &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": value } } })]));
    }
    let mut text = "\u{5bc6}".repeat(6);
    let first = store.redact_settled_text(session, &text);
    text.push_str("QY");
    let second = store.redact_settled_text(session, &text);
    text.push_str("yZ");
    let last = store.redact_settled_text(session, &text);
    assert!(!first.contains('\u{5bc6}') && !second.contains('\u{5bc6}'), "{first:?} {second:?}");
    assert_eq!(last, "[redacted]");
}

/// The same Node test file ("a value in a file path is redacted as spelled"): either separator, and 1.4.5's exact substring
/// rule, so a value in another case is not the value.
#[test]
fn a_value_in_a_file_path_is_redacted_as_spelled() {
    let session = "sess_sensitive_paths";
    let store = SensitiveStore::default();
    assert!(store.remember(session, &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "hunter2" } } })]));
    let stored = |path: &str| {
        let note = json!({ "role": "user", "content": [{ "type": "text", "text": "x", "attachmentReference": { "kind": "files", "files": [{ "attachmentRef": "a".repeat(64), "name": "n", "path": path }] } }] });
        store.redact_messages(session, &[note])[0]["content"][0]["attachmentReference"]["files"][0]["path"].as_str().unwrap().to_owned()
    };
    assert_eq!(stored("C:\\attachments\\ab\\hunter2-notes.pdf"), "C:\\attachments\\ab\\[redacted]-notes.pdf");
    assert_eq!(stored("C:/attachments/ab/hunter2-notes.pdf"), "C:/attachments/ab/[redacted]-notes.pdf");
    assert_eq!(stored("C:\\attachments\\ab\\HUNTER2-notes.pdf"), "C:\\attachments\\ab\\HUNTER2-notes.pdf");
}

/// A carry makes a session's values, those it holds and those it gains later, its target's, and on along the target's
/// own carries; the target's listeners hear it, the carried listener is told each session that gained one, and a cycle
/// of carries ends.
#[test]
fn a_carried_session_takes_the_values_its_source_holds_and_gains_up_the_chain() {
    let fill = |text: &str| serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": text } } });
    let store = Arc::new(SensitiveStore::default());
    let told: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let sink = told.clone();
    assert!(store.on_carried(move |session| sink.lock().unwrap().push(session.to_owned())));
    assert!(!store.on_carried(|_| {}), "one carried listener");
    let heard = Arc::new(AtomicU64::new(0));
    let _parent = {
        let heard = heard.clone();
        store.on_marked("parent", move |version| heard.store(version, Ordering::SeqCst))
    };
    assert!(store.remember("child", &[fill("before")]));
    store.carry("child", "parent");
    assert_eq!(store.redact_text("parent", "before"), "[redacted]", "what the source held is carried");
    store.carry("grandchild", "child");
    store.carry("parent", "child");
    assert!(store.remember("grandchild", &[fill("after")]));
    for session in ["grandchild", "child", "parent"] {
        assert_eq!(store.redact_text(session, "before after"), if session == "grandchild" { "before [redacted]" } else { "[redacted] [redacted]" }, "{session}");
    }
    assert_eq!(heard.load(Ordering::SeqCst), store.version("parent"));
    // A marking session with no listener of its own (no turn to rewrite its log) is told too.
    assert_eq!(*told.lock().unwrap(), ["child", "parent", "grandchild", "child", "parent"]);
    assert_eq!(store.redact_text("unrelated", "after"), "after");
}

/// A completion's message keeps its card (`meta.taskCard`, a core-only field: the report as the card shows it and the raw
/// notification); stored after a mark, the card holds the marker like the content does.
#[test]
fn a_completion_card_on_a_stored_message_takes_the_marker() {
    let fill = serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "730215" } } });
    let store = SensitiveStore::default();
    store.remember("owner", &[fill]);
    let message = serde_json::json!({
        "role": "user",
        "content": "<result>\nThe code is 730215.\n</result>",
        "meta": { "source": "task-notification", "taskCard": { "name": "agent", "args": { "tag": "s2h" }, "result": "The code is 730215.", "rawResult": "<result>\nThe code is 730215.\n</result>" } },
    });
    let stored = store.redact_message("owner", &message);
    assert!(!stored.to_string().contains("730215"), "{stored}");
    assert_eq!(stored["meta"]["taskCard"]["result"], "The code is [redacted].");
    assert_eq!(stored["meta"]["source"], "task-notification");
}

fn fill(text: &str) -> Value {
    json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": text } } })
}

#[test]
fn only_a_sensitive_browser_fill_marks_a_value_and_a_value_seen_before_marks_nothing_new() {
    let store = SensitiveStore::default();
    let not_marked = [
        json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": false, "text": "a1" } } }),
        json!({ "name": "browser", "arguments": { "action": "click", "input": { "sensitive": true, "text": "a2" } } }),
        json!({ "name": "shell", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "a3" } } }),
        json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "" } } }),
        json!({ "name": "browser", "arguments": "not json" }),
    ];
    for call in &not_marked {
        assert!(!store.remember("s", std::slice::from_ref(call)), "{call}");
    }
    assert!(!store.remember("", &[fill("nobody")]), "a call without a session marks nothing");
    assert_eq!(store.redact_text("s", "a1 a2 a3 nobody"), "a1 a2 a3 nobody");
    let before = store.version("s");
    assert!(store.remember("s", &[fill("hunter2")]));
    let after = store.version("s");
    assert_ne!(before, after, "a new value changes the version");
    assert!(!store.remember("s", &[fill("hunter2")]), "the same value again gains nothing");
    assert_eq!(store.version("s"), after);
}

#[test]
fn a_fill_whose_arguments_are_a_json_string_or_that_lists_fields_marks_every_value() {
    let store = SensitiveStore::default();
    let as_string = json!({ "name": "browser", "arguments": "{\"action\":\"fill\",\"input\":{\"sensitive\":true,\"text\":\"alpha\"}}" });
    let fields = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "fields": [{ "text": "beta" }, { "value": "gamma" }] } } });
    assert!(store.remember("s", &[as_string, fields]));
    assert_eq!(store.redact_text("s", "alpha beta gamma delta"), "[redacted] [redacted] [redacted] delta");
}

#[test]
fn a_marked_value_is_found_replaced_everywhere_and_known_only_to_its_own_session() {
    let store = SensitiveStore::default();
    store.remember("s", &[fill("730215")]);
    assert!(store.contains("s", "code 730215 ok"));
    assert!(!store.contains("s", "code 730216 ok"));
    assert!(!store.contains("other", "code 730215 ok"));
    assert_eq!(store.redact_text("s", "730215 and 730215"), "[redacted] and [redacted]");
    assert_eq!(store.redact_text("other", "730215"), "730215");
}

#[test]
fn stored_messages_hold_the_marker_in_text_and_in_the_text_parts_of_a_list() {
    let store = SensitiveStore::default();
    store.remember("s", &[fill("730215")]);
    let stored = store.redact_messages(
        "s",
        &[
            json!({ "role": "tool", "toolCallId": "c1", "content": "result 730215" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "The code is 730215." }] }),
            json!({ "role": "user", "content": "no value here" }),
        ],
    );
    assert_eq!(stored[0]["content"], "result [redacted]");
    assert_eq!(stored[0]["toolCallId"], "c1");
    assert_eq!(stored[1]["content"], json!([{ "type": "text", "text": "The code is [redacted]." }]));
    assert_eq!(stored[2]["content"], "no value here");
    assert!(!Value::Array(stored).to_string().contains("730215"));
}

#[test]
fn a_session_with_no_marked_value_stores_its_messages_as_they_are() {
    let store = SensitiveStore::default();
    let messages = vec![json!({ "role": "user", "content": "730215" })];
    assert_eq!(store.redact_messages("clean", &messages), messages);
    assert_eq!(store.version("clean"), store.version("also clean"));
}

