//! Twin test `adapter`: the session surface of the office PDF backend in Node (the recording
//! `native/core/fixtures/office-adapter/golden.json`, written by `benchmarks/rust-core/recorders/record-office-adapter.mjs`)
//! against this crate. Generated PDFs go through the snapshot, the validation and the audit, and through batches of the
//! structure operations; a result must equal Node's JSON exactly, and every PDF a batch left behind must equal the
//! recorded structural summary (page boxes and turns, form field names, attachments, bookmarks, metadata). A compression
//! is compared by its outcome class: the sizes depend on the writer. Re-recording is `twin_live_adapter` (ignored: it
//! runs Node). qpdf is not part of the recording; `tests/security.rs` covers what needs no qpdf.

use std::path::{Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_js::json_number;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_pdf::adapter::{FormView, SnapshotOptions, apply_pdf_batch, issues_pdf, snapshot_pdf, validate_pdf};
use mixdog_office_pdf::edit_document::load_pdf;
use mixdog_office_pdf::structure::StructureOperations;
use mixdog_office_pdf::{PdfSource, extract_pdf_outline};
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::Guard;
use serde_json::{Map, Value, json};

const SET: &str = "office-adapter";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-adapter.mjs";
const SIZE_KEYS: [&str; 5] = ["bytesBefore", "bytesAfter", "changed", "grew", "note"];

/// The recorded documents have no form fields in the snapshots and audits, so the form vocabulary is empty here: the
/// forms module's own twin covers the descriptions.
struct NoForms;

impl FormView for NoForms {
    fn describe_fields(&self, _document: &PdfDocument) -> Vec<Value> {
        Vec::new()
    }

    fn minimum_size(&self, _field_type: &str) -> (f64, f64) {
        (24.0 - 0.01, 12.0 - 0.01)
    }

    fn rectangles_overlap(&self, _left: &Value, _right: &Value) -> bool {
        false
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex")).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("mixdog-office-adapter-twin-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&root);
    root
}

/// A path inside the case folder shown as the recording shows it: `<case>/sub/file.pdf`.
fn shown(value: &Value, directory: &str) -> Value {
    match value {
        Value::String(text) if text.contains(directory) => {
            Value::String(text.replace(directory, "<case>").replace('\\', "/"))
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| shown(item, directory)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), shown(item, directory))).collect()),
        other => other.clone(),
    }
}

fn assert_same(what: &str, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    assert!(
        found.is_empty(),
        "{what} differs from the recording:\n{}",
        found.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

/// The recorded outcome of a call: its `result`, or the `message` of its `error`.
fn outcome_matches(what: &str, golden: &Value, actual: Result<Value, String>, directory: &str) {
    match (golden.get("result"), golden.get("error"), actual) {
        (Some(result), _, Ok(actual)) => assert_same(what, result, &shown(&actual, directory)),
        (_, Some(error), Err(message)) => assert_eq!(error["message"].as_str().expect("message"), message, "{what}"),
        (Some(_), _, Err(message)) => panic!("{what} failed where the recording succeeded: {message}"),
        (_, Some(error), Ok(actual)) => panic!("{what} succeeded where the recording failed with {error}: {actual}"),
        _ => panic!("{what}: the recording has neither a result nor an error"),
    }
}

fn write_fixture(golden: &Value, directory: &Path, name: &str, fixture: &str) {
    let file = directory.join(name);
    if let Some(parent) = file.parent() {
        mixdog_testkit::create_dir_all(parent);
    }
    let bytes = match golden["fixtures"].get(fixture).and_then(Value::as_str) {
        Some(encoded) => unhex(encoded),
        None => fixture.as_bytes().to_vec(),
    };
    mixdog_testkit::write(file, bytes);
}

fn case_directory(root: &Path, number: usize) -> PathBuf {
    let directory = root.join(format!("case-{number}"));
    mixdog_testkit::create_dir_all(&directory);
    directory
}

#[test]
fn snapshots_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    let cases = golden["snapshots"].as_array().expect("snapshots");
    assert!(!cases.is_empty());
    for (number, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let directory = case_directory(&root, number);
        write_fixture(&golden, &directory, "doc.pdf", case["fixture"].as_str().expect("fixture"));
        let options = SnapshotOptions::from_json(&case["options"]);
        let actual = snapshot_pdf(&Unlaned, &directory.join("doc.pdf"), &options, &NoForms).map_err(|error| error.message);
        outcome_matches(&format!("snapshot {name}"), case, actual, &directory.to_string_lossy());
    }
    mixdog_testkit::remove_dir_all(&root);
}

#[test]
fn validations_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    for (number, case) in golden["validations"].as_array().expect("validations").iter().enumerate() {
        let directory = case_directory(&root, number);
        write_fixture(&golden, &directory, "doc.pdf", case["fixture"].as_str().expect("fixture"));
        let actual = validate_pdf(&Unlaned, &directory.join("doc.pdf")).map_err(|error| error.message);
        outcome_matches(&format!("validation {}", case["name"]), case, actual, &directory.to_string_lossy());
    }
    mixdog_testkit::remove_dir_all(&root);
}

#[test]
fn audits_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    for (number, case) in golden["issues"].as_array().expect("issues").iter().enumerate() {
        let directory = case_directory(&root, number);
        write_fixture(&golden, &directory, "doc.pdf", case["fixture"].as_str().expect("fixture"));
        let options = SnapshotOptions::from_json(&case["options"]);
        let actual = issues_pdf(&Unlaned, &directory.join("doc.pdf"), &options, &NoForms).map_err(|error| error.message);
        outcome_matches(&format!("audit {}", case["name"]), case, actual, &directory.to_string_lossy());
    }
    mixdog_testkit::remove_dir_all(&root);
}

fn rectangle(rect: mixdog_pdf::write::Rect) -> Value {
    json!([json_number(rect.x), json_number(rect.y), json_number(rect.width), json_number(rect.height)])
}

/// What a PDF left behind looks like to the structure (the recorder's `summarize`).
fn summarize(bytes: &[u8]) -> Value {
    let document = load_pdf(bytes, false).expect("a PDF");
    let pages: Vec<Value> = document
        .pages()
        .into_iter()
        .map(|page| {
            json!({
                "media": rectangle(document.media_box(page).expect("media box")),
                "crop": rectangle(document.crop_box(page).expect("crop box")),
                "rotation": json_number(document.rotation(page).expect("rotation")),
            })
        })
        .collect();
    let fields: Vec<String> = document.form_fields().into_iter().map(|field| field.name).collect();
    let filters = CodecFilters;
    let guard = Guard::unbounded();
    let attachments: Vec<Value> = document
        .attachments()
        .iter()
        .map(|entry| {
            let content = document.attachment_bytes(&entry.spec, &filters, &guard).expect("bytes").unwrap_or_default();
            json!({ "name": entry.name, "description": entry.description, "hex": hex(&content) })
        })
        .collect();
    let outline = extract_pdf_outline(&Unlaned, PdfSource::Bytes(bytes), 500).expect("an outline");
    json!({
        "pages": pages,
        "fields": fields,
        "attachments": attachments,
        "outline": outline.entries.iter().map(|entry| entry.to_json()).collect::<Vec<_>>(),
        "metadata": {
            "title": document.title().unwrap_or_default(),
            "author": document.author().unwrap_or_default(),
            "subject": document.subject().unwrap_or_default(),
            "keywords": document.keywords().unwrap_or_default(),
        },
    })
}

/// The files of a case folder a batch can have written, as the recorder lists them.
fn outputs_of(directory: &Path) -> Value {
    let mut outputs = Map::new();
    for (relative, bytes) in mixdog_testkit::tree(directory) {
        if relative.ends_with(".txt") {
            outputs.insert(relative, json!({ "hex": hex(&bytes) }));
        } else if relative.ends_with(".pdf") {
            outputs.insert(relative, summarize(&bytes));
        }
    }
    Value::Object(outputs)
}

/// A compression's sizes depend on the writer: only the outcome class is compared.
fn without_sizes(results: Value) -> Value {
    let Value::Array(rows) = results else {
        return results;
    };
    Value::Array(
        rows.into_iter()
            .map(|row| match row {
                Value::Object(map) if map.get("op") == Some(&json!("compress")) => {
                    for key in ["bytesBefore", "bytesAfter", "changed", "note"] {
                        assert!(map.contains_key(key), "a compression reports {key}");
                    }
                    Value::Object(map.into_iter().filter(|(key, _)| !SIZE_KEYS.contains(&key.as_str())).collect())
                }
                other => other,
            })
            .collect(),
    )
}

#[test]
fn structure_batches_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    let cases = golden["batches"].as_array().expect("batches");
    assert!(cases.len() > 30);
    for (number, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let directory = case_directory(&root, number);
        for (file, source) in case["files"].as_object().expect("files") {
            write_fixture(&golden, &directory, file, source.as_str().expect("source"));
        }
        let document = directory.join("doc.pdf");
        let before = mixdog_testkit::read(&document);
        let operations = case["operations"].as_array().expect("operations");
        let actual = apply_pdf_batch(&Unlaned, &NoWriteNote, &document, operations, &[&StructureOperations])
            .map(|rows| without_sizes(Value::Array(rows)))
            .map_err(|error| error.message);
        outcome_matches(&format!("batch {name}"), case, actual, &directory.to_string_lossy());
        // What a lone compression does to the file depends on the sizes the writer makes.
        let compression_only = !operations.is_empty() && operations.iter().all(|operation| operation["op"] == "compress");
        if !compression_only {
            let unchanged = mixdog_testkit::read(&document) == before;
            assert_eq!(case["unchanged"].as_bool().expect("unchanged"), unchanged, "batch {name}: whether the document was left as it was");
        }
        assert_same(&format!("batch {name}: the files left behind"), &case["outputs"], &outputs_of(&directory));
    }
    mixdog_testkit::remove_dir_all(&root);
}

#[test]
fn a_compression_reports_its_sizes_and_a_rewrite_that_grew_leaves_the_file_as_it_was() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    let directory = case_directory(&root, 0);
    write_fixture(&golden, &directory, "doc.pdf", "text3");
    let document = directory.join("doc.pdf");
    let original = mixdog_testkit::read(&document);
    let operations = [json!({ "op": "compress" })];
    let rows = apply_pdf_batch(&Unlaned, &NoWriteNote, &document, &operations, &[&StructureOperations]).expect("a batch");
    let after = mixdog_testkit::read(&document);
    let row = &rows[0];
    assert_eq!(row["bytesBefore"], json!(original.len()));
    assert_eq!(row["bytesAfter"], json!(after.len()));
    assert_eq!(row["changed"], json!(after != original));
    if row["note"].as_str().expect("note").starts_with("Object streams cost more than they saved here") {
        assert_eq!(after, original);
    }
    mixdog_testkit::remove_dir_all(&root);
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_adapter() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder wrote nothing: {printed}");
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
}
