//! Twin test `tabular`: the recording of Node's CSV/TSV backend (`native/core/fixtures/office-tabular/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-tabular.mjs`) against `mixdog_office::tabular`. Each
//! scenario starts from the recorded file bytes and runs the recorded steps; after every step the file's bytes must be
//! exactly what Node left, and the answer's JSON text (or the error message) exactly what Node produced. Re-recording is
//! `twin_live_tabular` (ignored: it runs Node).

use std::fmt::Write as _;
use std::path::Path;

use mixdog_fsio::Unlaned;
use mixdog_js::json_stringify;
use mixdog_office::tabular::{self, Format};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(out, "{byte:02x}").expect("write to a String");
    }
    out
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex byte")).collect()
}

/// The recorder's `wideRow`: one row of `columns` cells counting up from 0.
fn wide_row(columns: usize) -> String {
    let cells: Vec<String> = (0..columns).map(|cell| cell.to_string()).collect();
    format!("{}\r\n", cells.join(","))
}

/// The text of the recording with the temporary directory named `<dir>`, as the recorder writes it.
fn named(text: &str, dir: &Path) -> String {
    let quoted = |text: &str| {
        let json = json_stringify(&Value::String(text.to_owned()));
        json[1..json.len() - 1].to_owned()
    };
    let dir = dir.display().to_string();
    let separator = std::path::MAIN_SEPARATOR.to_string();
    text.replace(&format!("{}{}", quoted(&dir), quoted(&separator)), "<dir>/")
        .replace(&format!("{dir}{separator}"), "<dir>/")
        .replace(&dir, "<dir>")
}

fn file_hex(path: &Path) -> Option<String> {
    mixdog_fsio::read(&Unlaned, path).ok().map(|bytes| hex(&bytes))
}

fn run_step(step: &Value, path: &Path, format: Format) -> Result<String, String> {
    let kind = step["kind"].as_str().expect("kind");
    // Node's omitted/default argument is {}, not explicit null.
    let omitted = serde_json::json!({});
    let options = step.get("options").unwrap_or(&omitted);
    match kind {
        "create" => tabular::create(&Unlaned, &NoWriteNote, path).map(|()| "null".to_owned()),
        "snapshot" => tabular::snapshot(&Unlaned, path, format, options).map(|value| json_stringify(&value)),
        "apply" => {
            let operations = step["operations"].as_array().expect("operations");
            tabular::apply_batch(&Unlaned, &NoWriteNote, path, format, operations).map(|results| json_stringify(&Value::Array(results)))
        }
        "validate" => tabular::validate(&Unlaned, path, format).map(|value| json_stringify(&value)),
        "issues" => tabular::issues(&Unlaned, path, format, options).map(|value| json_stringify(&value)),
        other => panic!("unknown step kind {other}"),
    }
}

fn replay(scenario: &Value) {
    let name = scenario["name"].as_str().expect("name");
    let format = Format::from_name(scenario["format"].as_str().expect("format")).expect("csv or tsv");
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join(scenario["file"].as_str().expect("file"));
    match &scenario["initial"] {
        Value::Null => {}
        Value::String(bytes) => mixdog_fsio::write(&Unlaned, &path, unhex(bytes)).expect("write the initial file"),
        wide => {
            let columns = usize::try_from(wide["wide"].as_u64().expect("wide")).expect("columns");
            mixdog_fsio::write(&Unlaned, &path, wide_row(columns)).expect("write the initial file");
        }
    }
    for (number, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
        let at = format!("{name}, step {number} ({})", step["kind"]);
        match run_step(step, &path, format) {
            Ok(text) => {
                assert!(step.get("error").is_none(), "{at}: Node failed with {}, this answered {text}", step["error"]);
                assert_eq!(named(&text, dir.path()), step["result"].as_str().expect("result"), "{at}: the answer");
            }
            Err(message) => {
                assert!(step.get("result").is_none(), "{at}: Node answered, this failed with {message}");
                assert_eq!(named(&message, dir.path()), step["error"].as_str().expect("error"), "{at}: the error");
            }
        }
        match step.get("fileLength") {
            Some(length) => {
                let bytes = mixdog_fsio::read(&Unlaned, &path).expect("the file");
                assert_eq!(bytes.len() as u64, length.as_u64().expect("length"), "{at}: the file's length");
                if let Some(expected) = step.get("fileSha256") {
                    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected.as_str().unwrap(), "{at}: all file bytes");
                } else {
                    // The old corpus has four wide-row read-only steps. Compare
                    // their full original content instead of trusting length alone.
                    assert!(matches!(step["kind"].as_str(), Some("snapshot" | "validate" | "issues")), "{at}: regenerate long write cases with SHA-256");
                    let columns = scenario["initial"]["wide"].as_u64().expect("recorded wide initial content") as usize;
                    assert_eq!(bytes, wide_row(columns).into_bytes(), "{at}: original wide-row content");
                }
            }
            None => assert_eq!(file_hex(&path).map(Value::from).unwrap_or(Value::Null), step["fileHex"], "{at}: the file's bytes"),
        }
    }
}

#[test]
fn every_scenario_equals_the_recording() {
    let golden = twin::load_golden("office-tabular");
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() > 50, "the recording lost scenarios");
    for scenario in scenarios {
        replay(scenario);
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_tabular -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/core/tabular.mjs)"]
fn twin_live_tabular() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-tabular.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_scenario_equals_the_recording();
}
