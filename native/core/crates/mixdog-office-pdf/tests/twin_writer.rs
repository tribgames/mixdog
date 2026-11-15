//! Twin test `writer`: the PDF writer of Node (the recording `native/core/fixtures/office-writer/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-writer.mjs`: `pdf-writer.mjs` over pdf-lib) against this crate. Node runs
//! the block lists of the office PDF runtime test (a report with every block type, long tables, long prose with headings
//! and lists that keep together at a page edge, charts, forms, pictures, a page set up by the properties, an embedded
//! face) and the chart inputs of the docx add_chart path (`createChartPdf`); Rust replays the recorded specs and must give
//! the same result JSON, the same refusals, per page of the written file the same text items with positions within 1e-3 pt,
//! and the same form fields. Re-recording is `twin_live_writer` (ignored: it runs Node).

use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_pdf::forms::PdfForm;
use mixdog_office_pdf::writer::{create_chart_pdf, create_pdf};
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::{LoadOptions, PdfDocument};
use mixdog_raster::svg::SvgFonts;
use serde_json::{Value, json};

const SET: &str = "office-writer";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-writer.mjs";
/// Numbers of the result and the form fields, relative.
const TOLERANCE: f64 = 1e-9;
/// Positions of the text the reader finds, in points.
const POSITION: f64 = 1e-3;

fn within(path: &str, a: f64, b: f64) -> bool {
    if path.starts_with("/pages") {
        (a - b).abs() <= POSITION
    } else {
        (a - b).abs() <= TOLERANCE * a.abs().max(b.abs()).max(1.0)
    }
}

/// The paths at which two values differ: numbers within the tolerance of their place, everything else exactly, object key
/// order free.
fn differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                match got.get(key) {
                    Some(other) => differences(&format!("{path}/{key}"), value, other, out),
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
                differences(&format!("{path}/{index}"), a, b, out);
            }
        }
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            if !within(path, a, b) {
                out.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        _ if expected == actual => {}
        _ => out.push(format!("{path}: recorded {expected}, produced {actual}")),
    }
}

fn assert_same(what: &str, expected: &Value, actual: &Value) {
    let mut found = Vec::new();
    differences("", expected, actual, &mut found);
    assert!(
        found.is_empty(),
        "{what} differs from the recording:\n{}",
        found.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

// ---- running a case -------------------------------------------------------------------------------------------------------

fn scratch(name: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!("mixdog-office-writer-twin-{}-{name}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    directory
}

/// A text with the folder it was made in written as `<out>` and its separators as `/`.
fn neutral(text: &str, folder: &Path) -> String {
    let shown = folder.to_string_lossy().into_owned();
    text.replace(&shown, "<out>").replace(&shown.replace('\\', "/"), "<out>").replace('\\', "/")
}

/// The recorded spec with the fixtures folder named (`<fixtures>`).
fn with_fixtures(spec: &Value) -> Value {
    let fixtures = twin::repo_root().join("native/core/fixtures");
    let root = fixtures.to_string_lossy().replace('\\', "/");
    serde_json::from_str(&spec.to_string().replace("<fixtures>", &root)).expect("the spec reads back")
}

fn write_files(case: &Value, folder: &Path) {
    for key in ["images", "files"] {
        for (name, data) in case.get(key).and_then(Value::as_object).into_iter().flatten() {
            let bytes = STANDARD.decode(data.as_str().expect("base64")).expect("base64 decodes");
            mixdog_testkit::write(folder.join(name), bytes);
        }
    }
}

fn layout_of(file: &Path) -> Value {
    let options = LayoutOptions { shapes: false, ..LayoutOptions::default() };
    let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Path(file), &options).expect("the written file reads");
    Value::Array(
        layout
            .pages
            .iter()
            .map(|page| {
                json!({
                    "width": page.width,
                    "height": page.height,
                    "items": page.items.iter().map(|item| json!({
                        "text": item.text, "x": item.x, "top": item.top, "width": item.width, "height": item.height
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn fields_of(file: &Path) -> Value {
    let options = LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() };
    let mut document = PdfDocument::load(mixdog_testkit::read(file), &options).expect("the written form loads");
    Value::Array(PdfForm::new().describe_fields(&mut document).expect("the fields"))
}

/// A result as the recorder writes it: the output file by its name, the font file as `<font>`.
fn neutral_result(mut result: Value) -> Value {
    result["path"] = json!("out.pdf");
    if let Some(font) = result.get_mut("font").and_then(Value::as_object_mut) {
        if font.contains_key("path") {
            font.insert("path".into(), json!("<font>"));
        }
    }
    result
}

fn run_case(case: &Value) {
    let name = case["name"].as_str().expect("name");
    let folder = scratch(name);
    write_files(case, &folder);
    let file = folder.join("out.pdf");
    let spec = with_fixtures(&case["spec"]);
    let ran = create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &file.to_string_lossy(), &spec);
    match (case.get("error"), ran) {
        (None, Ok(result)) => {
            assert_same(&format!("{name}: result"), &case["result"], &neutral_result(result.clone()));
            assert_same(&format!("{name}: pages"), &json!({ "pages": case["pages"] }), &json!({ "pages": layout_of(&file) }));
            let described = if result["form"]["fields"].as_array().is_some_and(|fields| !fields.is_empty()) { Some(fields_of(&file)) } else { None };
            // Whether fields were recorded and read back; their values are compared next, with the tolerance of their place.
            assert_eq!(case.get("fields").is_some(), described.is_some(), "{name}: whether the file holds fields");
            if let Some(described) = described {
                assert_same(&format!("{name}: fields"), &case["fields"], &described);
            }
        }
        (Some(expected), Err(error)) => {
            assert_eq!(expected.as_str(), Some(neutral(error.message(), &folder).as_str()), "{name}: the refusal");
        }
        (Some(expected), Ok(_)) => panic!("{name}: Node failed with {expected}, this wrote a file"),
        (None, Err(error)) => panic!("{name}: Node wrote a file, this failed: {error}"),
    }
    mixdog_testkit::remove_dir_all(&folder);
}

// ---- the tests ------------------------------------------------------------------------------------------------------------

fn cases_named(prefix: &str, wanted: bool) -> Vec<Value> {
    let golden = twin::load_golden(SET);
    golden["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|case| case["name"].as_str().is_some_and(|name| name.starts_with(prefix) == wanted))
        .cloned()
        .collect()
}

#[test]
fn block_lists_flow_onto_the_pages_node_flowed_them_onto() {
    let cases = cases_named("fault-", false);
    assert!(cases.len() >= 8, "{} cases", cases.len());
    for case in &cases {
        run_case(case);
    }
}

#[test]
fn faulty_block_lists_are_refused_with_node_s_words() {
    let cases = cases_named("fault-", true);
    assert!(cases.len() >= 10, "{} cases", cases.len());
    for case in &cases {
        run_case(case);
    }
}

#[test]
fn chart_documents_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let charts = golden["charts"].as_array().expect("charts");
    assert!(!charts.is_empty());
    for case in charts {
        let name = case["name"].as_str().expect("name");
        let folder = scratch(&format!("chart-{name}"));
        let file = folder.join("chart.pdf");
        let options = case.get("options").filter(|options| !options.is_null());
        let width = options.and_then(|options| options.get("width")).and_then(Value::as_f64).unwrap_or(420.0);
        let palette = options.and_then(|options| options.get("palette"));
        let ran = create_chart_pdf(&Unlaned, &FontEnv::default(), &file.to_string_lossy(), &case["block"], width, palette);
        match (case.get("error"), ran) {
            (None, Ok(result)) => {
                assert_same(&format!("{name}: result"), &case["result"], &neutral_result(result));
                assert_same(&format!("{name}: pages"), &json!({ "pages": case["pages"] }), &json!({ "pages": layout_of(&file) }));
            }
            (Some(expected), Err(error)) => assert_eq!(expected.as_str(), Some(error.message()), "{name}: the refusal"),
            (Some(expected), Ok(_)) => panic!("{name}: Node failed with {expected}, this wrote a file"),
            (None, Err(error)) => panic!("{name}: Node wrote a file, this failed: {error}"),
        }
        mixdog_testkit::remove_dir_all(&folder);
    }
}

/// Re-records the fixture with Node (the Node source of this checkout, or the tree `MIXDOG_NODE_TREE` names).
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_writer() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder wrote nothing: {printed}");
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
}
