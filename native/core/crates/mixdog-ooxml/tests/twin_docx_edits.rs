//! Twin test `docx_edits`: the recording of Node's Word batch (`native/core/fixtures/office-docx-edits/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-docx-edits.mjs`) against this crate. Each sequence is a package and its steps
//! (a batch of operations, or a part set or removed); the replay compares what each batch answered (the result rows, or the
//! message of the operation that failed), then the names and the text of every part. A time of day is scrubbed on both sides. A
//! step that names a picture by placeholder gets the picture file the recording holds, written into a temporary directory.
//! Re-recording is `twin_live_docx_edits` (ignored: it runs Node).

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_ooxml::docx::apply_docx;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-docx-edits")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn recorded(case: &Value) -> Value {
    match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    }
}

/// The package a recording describes, from its files in order.
fn package_of(files: &Value) -> Package {
    let mut package = Package::new();
    for (name, content) in files.as_object().expect("the files of a package") {
        package.set(name, text(content));
    }
    package
}

/// The operations with every picture placeholder (`@wide.png`) replaced by the file written for it.
fn with_files(value: &Value, directory: &Path, assets: &Map<String, Value>) -> Value {
    match value {
        Value::String(name) if assets.contains_key(name) => json!(directory.join(&name[1..]).display().to_string()),
        Value::Array(items) => Value::Array(items.iter().map(|item| with_files(item, directory, assets)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), with_files(item, directory, assets))).collect()),
        other => other.clone(),
    }
}

/// What one step of a sequence answers, with the package it works on.
fn step(zip: &mut Package, step: &Value, directory: &Path, assets: &Map<String, Value>) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    match field("fn") {
        "applyDocx" => {
            let operations = with_files(step.get("operations").unwrap_or(&Value::Null), directory, assets);
            let registry = Registry::new();
            let measurer = TextMeasurer::new(&Unlaned, &registry);
            let list = operations.as_array().cloned().unwrap_or_default();
            apply_docx(&Unlaned, &measurer, zip, &list).map(Value::Array)
        }
        "set" => {
            zip.set(field("name"), field("text"));
            Ok(Value::Null)
        }
        "remove" => {
            zip.remove(field("name"));
            Ok(Value::Null)
        }
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

/// `{ names, parts }`: every entry name in order and the text of every file.
fn snapshot(package: &Package) -> Value {
    let mut parts = Map::new();
    for entry in package.entries() {
        if !entry.dir {
            parts.insert(entry.name.clone(), Value::from(package.text(&entry.name)));
        }
    }
    json!({ "names": package.names(), "parts": parts })
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let assets = golden["assets"].as_object().expect("the picture files");
    let directory = tempfile::tempdir().expect("a work directory");
    for (name, data) in assets {
        let bytes = STANDARD.decode(text(data)).expect("a picture file");
        std::fs::write(directory.path().join(&name[1..]), bytes).expect("a picture is written");
    }
    let sequences = golden["sequences"].as_array().expect("sequences");
    assert!(sequences.len() >= 45, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let mut zip = package_of(&sequence["files"]);
        let steps = sequence["steps"].as_array().expect("steps");
        let outputs = sequence["outputs"].as_array().expect("outputs");
        assert_eq!(steps.len(), outputs.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(outputs).enumerate() {
            let produced = match step(&mut zip, one, directory.path(), assets) {
                Ok(value) => json!({ "result": value }),
                Err(error) => json!({ "error": error }),
            };
            twin::assert_matches(&format!("{name}, step {index}"), &recorded(expected), &produced);
        }
        twin::assert_matches(&format!("{name}, the package"), &sequence["snapshot"], &snapshot(&zip));
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_docx_edits -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_docx_edits() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx-edits.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
