//! Twin test `digest`: the recording of Node's model-facing result digest (`finalizeOfficeResult`, `officeDocumentDigest`,
//! `bounded` and `stableJson` of `core/office-core.mjs`; `native/core/fixtures/office-digest/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-digest.mjs`) against this crate. Every output is compared as the exact
//! JSON text, so key order, number printing and which fields are absent are all checked. Re-recording is
//! `twin_live_digest` (ignored: it runs Node).

use std::collections::HashMap;

use mixdog_js::json_stringify;
use mixdog_office::bounded::{bounded, stable_json};
use mixdog_office::digest::{FinalizeOptions, ResultSession, finalize_office_result, office_document_digest};
use mixdog_office_base::twin;
use serde_json::Value;

fn golden() -> Value {
    twin::load_golden("office-digest")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}")).as_slice()
}

fn text<'a>(case: &'a Value, field: &str) -> &'a str {
    case[field].as_str().unwrap_or_else(|| panic!("{} has no text {field}", case["name"]))
}

/// The session a case names, as its recorded spec gives it.
fn session_of(spec: &Value) -> ResultSession {
    let flag = |name: &str| spec[name].as_bool().unwrap_or(false);
    let own = |name: &str| spec[name].as_str().unwrap_or_default().to_owned();
    ResultSession {
        target: own("target"),
        format: own("format"),
        file_kind: own("fileKind"),
        authored: flag("authored"),
        facts_mode_sample: flag("factsSample"),
        ..ResultSession::default()
    }
}

/// The first place two texts differ, with a little of each around it.
fn first_difference(expected: &str, actual: &str) -> String {
    let at = expected.bytes().zip(actual.bytes()).position(|(a, b)| a != b).unwrap_or(expected.len().min(actual.len()));
    let window = |text: &str| {
        let bytes = text.as_bytes();
        let start = at.saturating_sub(60).min(bytes.len());
        let end = (at + 100).min(bytes.len());
        String::from_utf8_lossy(&bytes[start..end]).into_owned()
    };
    format!("at byte {at}\n  recorded: {}\n  produced: {}", window(expected), window(actual))
}

fn failures(found: &[String]) {
    assert!(found.is_empty(), "{} of the recorded cases differ:\n{}", found.len(), found.iter().take(6).cloned().collect::<Vec<_>>().join("\n"));
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let mut found = Vec::new();

    let specs = golden["sessions"].as_object().expect("sessions");
    let mut sessions: HashMap<String, ResultSession> = HashMap::new();
    for case in section(&golden, "digest") {
        let name = text(case, "name");
        let action = text(case, "action");
        let elapsed_ms = case["elapsedMs"].as_f64().expect("elapsedMs");
        let session = case["session"].as_str().map(|key| {
            sessions.entry(key.to_owned()).or_insert_with(|| session_of(specs.get(key).unwrap_or_else(|| panic!("session {key}"))))
        });
        let produced = json_stringify(&finalize_office_result(case["input"].clone(), FinalizeOptions { action, session, elapsed_ms }));
        let recorded = text(case, "output");
        if produced != recorded {
            found.push(format!("digest `{name}` {}", first_difference(recorded, &produced)));
        }
    }

    for case in section(&golden, "documents") {
        let produced = json_stringify(&office_document_digest(&case["input"]));
        let recorded = text(case, "output");
        if produced != recorded {
            found.push(format!("document `{}` {}", text(case, "name"), first_difference(recorded, &produced)));
        }
    }

    for case in section(&golden, "bounded") {
        let max_chars = usize::try_from(case["maxChars"].as_u64().expect("maxChars")).expect("fits");
        let length = case["length"].as_u64().map(|length| usize::try_from(length).expect("fits"));
        let produced = json_stringify(&bounded(&case["value"], max_chars, length));
        let recorded = text(case, "output");
        if produced != recorded {
            found.push(format!("bounded `{}` {}", text(case, "name"), first_difference(recorded, &produced)));
        }
    }

    for case in section(&golden, "stableJson") {
        let produced = stable_json(&case["value"]);
        let recorded = text(case, "output");
        if produced != recorded {
            found.push(format!("stableJson `{}` {}", text(case, "name"), first_difference(recorded, &produced)));
        }
    }
    failures(&found);
}

#[test]
fn every_output_equals_the_recorded_text() {
    every_output_equals_the_recording();
}

#[test]
fn the_recording_covers_every_section() {
    let golden = golden();
    for name in ["digest", "documents", "bounded", "stableJson"] {
        assert!(section(&golden, name).len() >= 10, "section {name} is too small to cover the digest");
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_digest -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/office-core.mjs)"]
fn twin_live_digest() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-digest.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
