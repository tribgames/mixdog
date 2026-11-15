//! Twin test `snapshot_docx`: the recording of Node's Word snapshot module
//! (`native/core/fixtures/office-snapshot-docx/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-snapshot-docx.mjs`) against this crate. `snapshots` reads each recorded
//! package at each recorded page request and compares the JSON text with the one Node's `snapshotDocx` produced, key order
//! included; `pure` replays the body model, the block append and the small helpers on their recorded arguments.
//! Re-recording is `twin_live_snapshot_docx` (ignored: it runs Node).

use mixdog_js::utf16_len;
use mixdog_office_base::twin;
use mixdog_ooxml::snapshot_docx::{
    append_docx_block, close_trailing_table, docx_body_model, has_adjacent_tables, numbering_level_format, separate_adjacent_tables,
    snapshot_docx,
};
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-snapshot-docx")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn recorded(case: &Value) -> Value {
    match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    }
}

fn package_of(files: &Value) -> Package {
    let mut package = Package::new();
    for (name, content) in files.as_object().expect("the files of a package") {
        package.set(name, text(content));
    }
    package
}

/// The first place two texts differ, with what lies around it.
fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(60)).take(140).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

/// The model Node's recorder writes: offsets in UTF-16 units.
fn project_model(document_xml: &str) -> Value {
    let model = docx_body_model(document_xml);
    let inner = model.body.as_ref().map(|body| body.inner.as_str()).unwrap_or("");
    let blocks: Vec<Value> = model
        .blocks
        .iter()
        .map(|block| {
            json!({
                "name": block.name,
                "start": utf16_len(&inner[..block.start]),
                "end": utf16_len(&inner[..block.end]),
                "xml": block.xml,
                "logicalIndex": block.logical_index,
            })
        })
        .collect();
    let body = model.body.as_ref().map_or(Value::Null, |body| {
        json!({ "start": utf16_len(&document_xml[..body.start]), "end": utf16_len(&document_xml[..body.end]) })
    });
    json!({ "paragraphs": model.paragraphs, "tables": model.tables, "blocks": blocks, "body": body })
}

fn pure(name: &str, args: &[Value]) -> Value {
    let arg = |at: usize| text(&args[at]);
    match name {
        "docxBodyModel" => json!({ "result": project_model(arg(0)) }),
        "appendDocxBlock" => match append_docx_block(arg(0), arg(1)) {
            Ok(xml) => json!({ "result": xml }),
            Err(error) => json!({ "error": error }),
        },
        "hasAdjacentTables" => json!({ "result": has_adjacent_tables(arg(0)) }),
        "separateAdjacentTables" => json!({ "result": separate_adjacent_tables(arg(0)) }),
        "closeTrailingTable" => json!({ "result": close_trailing_table(arg(0)) }),
        "numberingLevelFormat" => json!({ "result": numbering_level_format(arg(0)) }),
        other => panic!("the recording has a function this test does not replay: {other}"),
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let snapshots = golden["snapshots"].as_array().expect("snapshots");
    assert!(snapshots.len() >= 20, "the recording lost snapshots: {}", snapshots.len());
    for case in snapshots {
        let package = package_of(&case["files"]);
        let what = format!("snapshot \"{}\" at {}", text(&case["name"]), case["options"]);
        let produced = serde_json::to_string(&snapshot_docx(&package, &case["options"])).expect("the snapshot as JSON");
        let expected = text(&case["result"]);
        assert!(expected == produced, "{what} differs from the recording {}", first_difference(expected, &produced));
    }
    let cases = golden["pure"].as_array().expect("pure cases");
    assert!(cases.len() >= 60, "the recording lost cases: {}", cases.len());
    for case in cases {
        let name = text(&case["fn"]);
        let args = case["args"].as_array().expect("arguments");
        let what = format!("{name}({})", Value::Array(args.clone()));
        twin::assert_matches(&what, &recorded(case), &pure(name, args));
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_snapshot_docx -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_snapshot_docx() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-snapshot-docx.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
