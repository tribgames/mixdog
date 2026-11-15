//! Twin test `content_ops`: the content and mark operations of Node (the recording
//! `native/core/fixtures/office-content-ops/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-content-ops.mjs`: `applyPdfBatch` over pdf-lib documents) against this
//! crate. A result row or an error message must equal Node's exactly; every PDF a batch left behind must equal the
//! recorded summary: the text items of each page as the reader lays them out, the boxes and links it paints, the
//! annotations as the file holds them, the placement of each image and the form fields as the inspector describes them,
//! numbers within 1e-3 pt. `ocr_pages` is not recorded (its engine is a download on first use). Re-recording is
//! `twin_live_content_ops` (ignored: it runs Node).

use std::path::{Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_js::json_number;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_pdf::batch::apply_batch;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_pdf::edit_document::load_pdf;
use mixdog_office_pdf::forms::PdfForm;
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::{Guard, Obj, Ref};
use mixdog_raster::svg::SvgFonts;
use serde_json::{Map, Value, json};

const SET: &str = "office-content-ops";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-content-ops.mjs";
const TOLERANCE: f64 = 1e-3;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex")).collect()
}

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("mixdog-office-content-ops-twin-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&root);
    root
}

/// A text with the case folder shown as the recording shows it: `<case>/sub/file.pdf`. The recorder's `shown` also turns every
/// backslash of every string into `/` (a pattern written `\d` is recorded `/d`), so this does the same to all of them.
fn shown_text(text: &str, directory: &str) -> String {
    text.replace(directory, "<case>").replace('\\', "/")
}

fn shown(value: &Value, directory: &str) -> Value {
    match value {
        Value::String(text) => Value::String(shown_text(text, directory)),
        Value::Array(items) => Value::Array(items.iter().map(|item| shown(item, directory)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), shown(item, directory))).collect()),
        other => other.clone(),
    }
}

/// The paths at which two values differ: numbers within the tolerance, everything else exactly, object key order free.
fn close_differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                match got.get(key) {
                    Some(other) => close_differences(&format!("{path}/{key}"), value, other, out),
                    None => out.push(format!("{path}/{key}: missing from the output")),
                }
            }
            for key in got.keys().filter(|key| !want.contains_key(*key)) {
                out.push(format!("{path}/{key}: not in the recording"));
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                out.push(format!("{path}: {} items recorded, {} produced", want.len(), got.len()));
            }
            for (index, (a, b)) in want.iter().zip(got).enumerate() {
                close_differences(&format!("{path}/{index}"), a, b, out);
            }
        }
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            if !((a - b).abs() <= TOLERANCE) {
                out.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        _ if expected == actual => {}
        _ => out.push(format!("{path}: recorded {expected}, produced {actual}")),
    }
}

fn assert_exact(what: &str, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    assert!(found.is_empty(), "{what} differs from the recording:\n{}", found.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

fn assert_close(what: &str, expected: &Value, actual: &Value) {
    let mut found = Vec::new();
    close_differences("", expected, actual, &mut found);
    assert!(found.is_empty(), "{what} differs from the recording:\n{}", found.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

fn numbers(items: &[Obj]) -> Vec<Value> {
    items.iter().map(|item| json_number(item.as_num().unwrap_or(f64::NAN))).collect()
}

/// The annotations of a page as the file holds them (the recorder's `annotations`).
fn annotations(document: &PdfDocument, page: Ref, pages: &[Ref]) -> Vec<Value> {
    let store = document.store();
    document
        .page_annotations(page)
        .iter()
        .map(|entry| {
            let Some(Obj::Dict(annotation)) = store.resolve(entry) else {
                return Value::Null;
            };
            let subtype = store.lookup(annotation, "Subtype").and_then(Obj::as_name).map(|name| format!("/{name}"));
            let rect = match store.lookup(annotation, "Rect") {
                Some(Obj::Array(items)) => numbers(items),
                _ => Vec::new(),
            };
            let uri = match store.lookup(annotation, "A") {
                Some(Obj::Dict(action)) => store.lookup(action, "URI").and_then(Obj::as_str).map(|bytes| String::from_utf8_lossy(bytes).into_owned()),
                _ => None,
            };
            let destination = match store.lookup(annotation, "Dest") {
                Some(Obj::Array(items)) => Some(
                    items
                        .first()
                        .and_then(Obj::as_ref_value)
                        .and_then(|target| pages.iter().position(|page| *page == target))
                        .map_or(0, |at| at + 1),
                ),
                _ => None,
            };
            json!({ "subtype": subtype, "rect": rect, "uri": uri, "destinationPage": destination })
        })
        .collect()
}

/// The matrix of every image painted on the page: a content-stream walk of q, Q, cm and Do (the recorder's `imagePlacements`).
fn image_placements(document: &PdfDocument, page: Ref) -> Vec<Value> {
    let store = document.store();
    let Some(dict) = store.dict(page) else {
        return Vec::new();
    };
    let refs: Vec<Ref> = match dict.get_raw("Contents").and_then(|raw| store.resolve(raw)) {
        Some(Obj::Array(items)) => items.iter().filter_map(Obj::as_ref_value).collect(),
        Some(Obj::Stream(_)) => dict.get_raw("Contents").and_then(Obj::as_ref_value).into_iter().collect(),
        _ => Vec::new(),
    };
    let text: String = refs
        .iter()
        .filter_map(|reference| document.decode_stream(*reference, &CodecFilters, &Guard::unbounded()).ok())
        .map(|bytes| bytes.iter().map(|byte| char::from(*byte)).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    let xobjects = match dict.get_raw("Resources").and_then(|raw| store.resolve(raw)) {
        Some(Obj::Dict(resources)) => match store.lookup(resources, "XObject") {
            Some(Obj::Dict(xobjects)) => Some(xobjects.clone()),
            _ => None,
        },
        _ => None,
    };
    let multiply = |m: [f64; 6], n: [f64; 6]| -> [f64; 6] {
        [
            m[0] * n[0] + m[1] * n[2],
            m[0] * n[1] + m[1] * n[3],
            m[2] * n[0] + m[3] * n[2],
            m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4],
            m[4] * n[1] + m[5] * n[3] + n[5],
        ]
    };
    let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut placements = Vec::new();
    let mut matrix = identity;
    let mut stack: Vec<[f64; 6]> = Vec::new();
    let tokens: Vec<&str> = text.split_whitespace().collect();
    for (at, token) in tokens.iter().enumerate() {
        match *token {
            "q" => stack.push(matrix),
            "Q" => matrix = stack.pop().unwrap_or(identity),
            "cm" if at >= 6 => {
                let mut numbers = [0.0; 6];
                for (slot, text) in numbers.iter_mut().zip(&tokens[at - 6..at]) {
                    *slot = text.parse().unwrap_or(f64::NAN);
                }
                matrix = multiply(numbers, matrix);
            }
            "Do" if at >= 1 => {
                let name = tokens[at - 1].trim_start_matches('/');
                let image = xobjects.as_ref().and_then(|xobjects| xobjects.get_raw(name)).and_then(|entry| store.resolve(entry)).and_then(Obj::dict_or_stream_dict);
                if image.is_some_and(|dict| dict.get_raw("Subtype").is_some_and(|subtype| subtype.is_name("Image"))) {
                    placements.push(Value::Array(matrix.iter().map(|value| json_number(*value)).collect()));
                }
            }
            _ => {}
        }
    }
    placements
}

/// What a PDF left behind looks like: layout, painted boxes and links, annotations, image placements, form fields (the
/// recorder's `summarize`).
fn summarize(bytes: &[u8]) -> Value {
    let mut document = load_pdf(bytes, false).expect("a PDF");
    let count = document.page_count();
    let mut read = Vec::new();
    let mut from = 1;
    while from <= count {
        let run: Vec<f64> = (from..=count.min(from + 99)).map(|page| page as f64).collect();
        let options = LayoutOptions { pages: Some(run), shapes: true, ..LayoutOptions::default() };
        read.extend(extract_pdf_text_layout(&Unlaned, PdfSource::Bytes(bytes), &options).expect("a layout").pages);
        from += 100;
    }
    let pages = document.pages();
    let rows: Vec<Value> = pages
        .iter()
        .zip(&read)
        .map(|(page, layout)| {
            json!({
                "rotation": json_number(document.rotation(*page).expect("rotation")),
                "width": json_number(layout.width),
                "height": json_number(layout.height),
                "items": layout.items.iter().map(|item| json!({
                    "text": item.text, "x": json_number(item.x), "top": json_number(item.top),
                    "width": json_number(item.width), "height": json_number(item.height),
                })).collect::<Vec<_>>(),
                "boxes": layout.boxes.iter().map(|shape| json!({
                    "x": json_number(shape.x), "top": json_number(shape.top), "width": json_number(shape.width),
                    "height": json_number(shape.height), "filled": shape.filled, "stroked": shape.stroked,
                })).collect::<Vec<_>>(),
                "links": layout.links.iter().map(|link| json!({
                    "x": json_number(link.x), "top": json_number(link.top), "width": json_number(link.width),
                    "height": json_number(link.height), "url": link.url, "page": link.page,
                })).collect::<Vec<_>>(),
                "annotations": annotations(&document, *page, &pages),
                "images": image_placements(&document, *page),
            })
        })
        .collect();
    let fields = PdfForm::new().describe_fields(&mut document).expect("the form's fields");
    json!({ "pages": rows, "fields": fields })
}

fn outputs_of(directory: &Path) -> Value {
    let mut outputs = Map::new();
    for (relative, bytes) in mixdog_testkit::tree(directory) {
        if relative.ends_with(".pdf") {
            outputs.insert(relative.replace('\\', "/"), summarize(&bytes));
        }
    }
    Value::Object(outputs)
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

fn content() -> ContentOperations {
    ContentOperations::new(FontEnv::default(), SvgFonts::none(), None, None)
}

#[test]
fn content_batches_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    let cases = golden["batches"].as_array().expect("batches");
    assert!(cases.len() > 40);
    let mut failures: Vec<String> = Vec::new();
    for (number, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let directory = root.join(format!("case-{number}"));
        mixdog_testkit::create_dir_all(&directory);
        for (file, source) in case["files"].as_object().expect("files") {
            write_fixture(&golden, &directory, file, source.as_str().expect("source"));
        }
        let shown_directory = directory.to_string_lossy().into_owned();
        let operations = case["operations"].as_array().expect("operations");
        let actual = apply_batch(&Unlaned, &NoWriteNote, &directory.join("doc.pdf"), operations, &content());
        match (case.get("result"), case.get("error"), actual) {
            (Some(result), _, Ok(rows)) => {
                let found = twin::differences(result, &shown(&Value::Array(rows), &shown_directory));
                if !found.is_empty() {
                    failures.push(format!("batch {name}: the result differs:\n{}", found.iter().take(8).cloned().collect::<Vec<_>>().join("\n")));
                }
            }
            (_, Some(error), Err(message)) => {
                let message = shown_text(&message.message, &shown_directory);
                if error["message"].as_str() != Some(message.as_str()) {
                    failures.push(format!("batch {name}: the error {message:?} is not {}", error["message"]));
                }
            }
            (Some(_), _, Err(message)) => failures.push(format!("batch {name}: failed where the recording succeeded: {}", message.message)),
            (_, Some(error), Ok(_)) => failures.push(format!("batch {name}: succeeded where the recording failed with {error}")),
            _ => failures.push(format!("batch {name}: the recording has neither a result nor an error")),
        }
        let mut found = Vec::new();
        close_differences("", &case["outputs"], &outputs_of(&directory), &mut found);
        if !found.is_empty() {
            failures.push(format!("batch {name}: the files left behind differ:\n{}", found.iter().take(8).cloned().collect::<Vec<_>>().join("\n")));
        }
    }
    mixdog_testkit::remove_dir_all(&root);
    assert!(failures.is_empty(), "{} of {} batches differ from the recording:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

#[test]
fn a_batch_that_fails_leaves_the_document_as_it_was() {
    let golden = twin::load_golden(SET);
    let root = scratch();
    let directory = root.join("untouched");
    mixdog_testkit::create_dir_all(&directory);
    write_fixture(&golden, &directory, "doc.pdf", "marks");
    let document = directory.join("doc.pdf");
    let before = mixdog_testkit::read(&document);
    let operations = [json!({ "op": "highlight", "find": "Section 1" }), json!({ "op": "add_text", "text": "x", "align": "middle" })];
    assert!(apply_batch(&Unlaned, &NoWriteNote, &document, &operations, &content()).is_err());
    assert!(mixdog_testkit::read(&document) == before);
    mixdog_testkit::remove_dir_all(&root);
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_content_ops() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder wrote nothing: {printed}");
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
}
