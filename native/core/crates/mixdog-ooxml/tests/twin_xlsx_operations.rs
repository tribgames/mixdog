#![allow(clippy::disallowed_methods, reason = "fixtures are written and read directly")]
//! Twin test `xlsx_operations`: the recording of Node's xlsx batch applier
//! (`native/core/fixtures/office-xlsx-operations/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-xlsx-operations.mjs`) against this crate. `scenarios` replays the batches one operation at
//! a time (the answer, then the parts of the package that changed); `batches` replays whole batches (the answers, then every part);
//! `pure` the helpers that stand alone (`typedNumber`, `assertWorksheetName`, `tableStyleInfoXml`); `engine` the engine-only
//! recalculation of a workbook (LibreOffice is never asked for). Text widths are measured in the fixture faces of `office-measure`
//! registered on both sides. Re-recording is `twin_live_xlsx_operations` (ignored: it runs Node).

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine as _;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::soffice::{Host, Soffice};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx::apply_xlsx;
use mixdog_ooxml::xlsx_operations::{assert_worksheet_name, table_style_info_xml};
use mixdog_ooxml::xlsx_recalculate::{recalculate_portable_workbook, recalculate_with_formula_engine};
use mixdog_ooxml::xlsx_sheet_edits::typed_number;
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn golden() -> Value {
    twin::load_golden("office-xlsx-operations")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

fn registry(golden: &Value) -> Registry {
    let mut registry = Registry::new();
    let dir = twin::repo_root().join("native/core/fixtures/office-measure");
    for (alias, faces) in golden["faces"].as_object().expect("faces") {
        for face in list(faces) {
            let path = dir.join(text(&face["file"]));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    // The recording was made on Windows: a font the workbook names that is not a fixture face (Calibri, which a workbook
    // without styles is measured in, and Malgun Gothic for Hangul) was set in the system's own face. The same files are
    // registered here.
    let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR")).map(std::path::PathBuf::from).expect("the Windows directory");
    for (alias, files) in [("Calibri", ["calibri.ttf"].as_slice())] {
        for file in files {
            let path = root.join("Fonts").join(file);
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("the recording used the system {alias}, which is not readable here ({}): {error}", path.display()));
        }
    }
    registry
}

const MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";

/// The long sheets the recording describes instead of holding: `worksheet(rows)` of the recorder.
fn generated_sheet(spec: &Value) -> String {
    let count = spec["count"].as_u64().expect("count");
    let rows: String = match text(&spec["kind"]) {
        "formulas" => (1..=count).map(|at| format!("<row r=\"{at}\"><c r=\"A{at}\"><f>1+1</f></c></row>")).collect(),
        "chain" => {
            let upward = spec["upward"].as_bool() == Some(true);
            (1..=count)
                .map(|index| {
                    let expression = if upward {
                        (index != count).then(|| format!("B{}+1", index + 1))
                    } else {
                        (index != 1).then(|| format!("B{}+1", index - 1))
                    };
                    match expression {
                        None => format!("<row r=\"{index}\"><c r=\"B{index}\"><v>1</v></c></row>"),
                        Some(expression) => format!("<row r=\"{index}\"><c r=\"B{index}\"><f>{expression}</f></c></row>"),
                    }
                })
                .collect()
        }
        other => panic!("the recording describes a sheet this test does not build: {other}"),
    };
    format!("{HEAD}<worksheet xmlns=\"{MAIN}\" xmlns:r=\"{REL}\"><sheetData>{rows}</sheetData></worksheet>")
}

fn package_of(golden: &Value, workbook: &str) -> Package {
    let mut package = Package::new();
    for (name, content) in golden["workbooks"][workbook].as_object().unwrap_or_else(|| panic!("workbook {workbook}")) {
        match content {
            Value::String(body) => package.set(name, body.as_str()),
            spec => package.set(name, generated_sheet(&spec["generate"])),
        }
    }
    package
}

/// The first place two texts differ, with what lies around it.
fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(180).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

fn assert_same(what: &str, expected: &str, produced: &str) {
    assert!(expected == produced, "{what} differs from the recording {}", first_difference(expected, produced));
}

/// What Node's `text()` of the recorder keeps of a call: `{ result: <JSON text> }` or `{ error }`.
fn recorded_text(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": serde_json::to_string(&value).expect("the answer as JSON") }),
        Err(error) => json!({ "error": error.replace('\\', "/") }),
    }
}

fn assert_text(what: &str, expected: &Value, produced: &Value) {
    if let Some(error) = expected.get("error") {
        assert_eq!(Some(error), produced.get("error"), "{what}: the error");
        return;
    }
    assert!(produced.get("error").is_none(), "{what} failed: {}", produced["error"]);
    assert_same(what, text(&expected["result"]), text(&produced["result"]));
}

/// Every part of a package by name, a picture as `base64:` text.
fn parts_of(package: &Package) -> BTreeMap<String, String> {
    let mut parts = BTreeMap::new();
    for name in package.names().into_iter().filter(|name| !name.ends_with('/')) {
        let content = if name.starts_with("xl/media/") {
            format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(package.file(&name).unwrap_or_default()))
        } else {
            package.text(&name)
        };
        parts.insert(name, content);
    }
    parts
}

/// What the recording says changed between two states, set against what changed here.
fn assert_changes(what: &str, case: &Value, before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) {
    let mut removed: Vec<&str> = before.keys().filter(|name| !after.contains_key(*name)).map(String::as_str).collect();
    removed.sort_unstable();
    let mut recorded_removed: Vec<&str> = list(&case["removed"]).iter().map(text).collect();
    recorded_removed.sort_unstable();
    assert_eq!(recorded_removed, removed, "{what}: the parts removed");
    let changed: BTreeMap<&str, &str> =
        after.iter().filter(|(name, content)| before.get(*name) != Some(*content)).map(|(name, content)| (name.as_str(), content.as_str())).collect();
    if let Some(digests) = case.get("changedSha256").and_then(Value::as_object) {
        assert_eq!(digests.keys().map(String::as_str).collect::<Vec<_>>(), changed.keys().copied().collect::<Vec<_>>(), "{what}: the parts changed");
        for (name, digest) in digests {
            let produced = format!("{:x}", Sha256::digest(changed[name.as_str()].as_bytes()));
            assert_eq!(text(digest), produced, "{what}: the digest of {name}");
        }
        return;
    }
    let recorded = case["changed"].as_object().expect("the parts changed");
    assert_eq!(recorded.keys().map(String::as_str).collect::<Vec<_>>(), changed.keys().copied().collect::<Vec<_>>(), "{what}: the parts changed");
    for (name, content) in recorded {
        assert_same(&format!("{what}: {name}"), text(content), changed[name.as_str()]);
    }
}

fn with_image(operation: &Value, image: &Path) -> Value {
    let mut operation = operation.clone();
    if operation.get("path").and_then(Value::as_str) == Some("$IMG") {
        operation["path"] = json!(image.display().to_string());
    }
    operation
}

fn run(measurer: &TextMeasurer<'_, Unlaned>, package: &mut Package, operations: &[Value]) -> Result<Value, String> {
    apply_xlsx(&Unlaned, measurer, package, operations).map(Value::Array)
}

fn scenarios(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>, image: &Path) {
    let cases = list(&golden["scenarios"]);
    assert!(cases.len() >= 5, "the recording lost scenarios: {}", cases.len());
    for scenario in cases {
        let name = text(&scenario["name"]);
        let mut package = package_of(golden, text(&scenario["workbook"]));
        let mut before = parts_of(&package);
        for (index, step) in list(&scenario["steps"]).iter().enumerate() {
            let what = format!("{name}, step {index} ({})", step["op"]);
            let operation = with_image(&step["op"], image);
            let outcome = run(measurer, &mut package, &[operation]);
            assert_text(&format!("{what}: the answer"), &step["output"], &recorded_text(outcome));
            let after = parts_of(&package);
            assert_changes(&what, step, &before, &after);
            before = after;
        }
    }
}

fn batches(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>) {
    let cases = list(&golden["batches"]);
    assert!(cases.len() >= 6, "the recording lost batches: {}", cases.len());
    for batch in cases {
        let name = text(&batch["name"]);
        let mut package = package_of(golden, text(&batch["workbook"]));
        let outcome = run(measurer, &mut package, list(&batch["ops"]));
        assert_text(&format!("{name}: the answers"), &batch["output"], &recorded_text(outcome));
        let produced = parts_of(&package);
        let recorded = batch["parts"].as_object().expect("the parts");
        assert_eq!(recorded.keys().map(String::as_str).collect::<Vec<_>>(), produced.keys().map(String::as_str).collect::<Vec<_>>(), "{name}: the parts");
        for (part, content) in recorded {
            assert_same(&format!("{name}: {part}"), text(content), &produced[part]);
        }
    }
}

fn pure(golden: &Value) {
    let typed = list(&golden["pure"]["typedNumber"]);
    assert!(typed.len() >= 20, "the recording lost typed numbers: {}", typed.len());
    for case in typed {
        let produced = match typed_number(&case["value"]) {
            Some(figure) => json!({ "value": mixdog_js::json_number(figure.value), "numberFormat": figure.number_format }),
            None => Value::Null,
        };
        assert_eq!(case["output"], produced, "typedNumber({})", case["value"]);
    }
    let names = list(&golden["pure"]["assertWorksheetName"]);
    assert!(names.len() >= 10, "the recording lost names: {}", names.len());
    for case in names {
        let produced = recorded_text(assert_worksheet_name("add_sheet", Some(&case["value"])).map(Value::String));
        assert_text(&format!("assertWorksheetName({})", case["value"]), &case["output"], &produced);
    }
    let styles = list(&golden["pure"]["tableStyleInfoXml"]);
    assert!(styles.len() >= 6, "the recording lost table styles: {}", styles.len());
    for case in styles {
        let style = case["style"].get("value");
        assert_same(&format!("tableStyleInfoXml({})", case["style"]), text(&case["output"]), &table_style_info_xml(style));
    }
}

fn engine(golden: &Value) {
    let dir = tempfile::tempdir().expect("work directory");
    let cases = list(&golden["engine"]);
    assert!(cases.len() >= 9, "the recording lost engine cases: {}", cases.len());
    for case in cases {
        let name = text(&case["name"]);
        let package = package_of(golden, name);
        let path = dir.path().join("engine.xlsx");
        std::fs::write(&path, package.generate().expect("the workbook")).expect("workbook file");
        let before = parts_of(&Package::load(&std::fs::read(&path).expect("read back")).expect("the workbook"));
        let outcome = recalculate_with_formula_engine(&Unlaned, &NoWriteNote, &path);
        assert_text(&format!("{name}: the answer"), &case["output"], &recorded_text(outcome));
        let after = parts_of(&Package::load(&std::fs::read(&path).expect("read back")).expect("the workbook"));
        assert_changes(&format!("{name}: the workbook"), case, &before, &after);
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let dir = tempfile::tempdir().expect("work directory");
    let image = dir.path().join("pixel.png");
    std::fs::write(&image, base64::engine::general_purpose::STANDARD.decode(text(&golden["image"])).expect("the picture")).expect("picture file");
    scenarios(&golden, &measurer, &image);
    batches(&golden, &measurer);
    pure(&golden);
    engine(&golden);
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_xlsx_operations -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_xlsx_operations() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx-operations.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}

// ---- recalculation that never reaches LibreOffice ---------------------------------------------------------------------------

/// A workbook the driver has nothing to recalculate in answers before it looks for LibreOffice, so these hold on a machine that has
/// it and on one that does not.
#[test]
fn a_workbook_without_formulas_or_of_another_kind_is_answered_without_the_engine() {
    let golden = golden();
    let dir = tempfile::tempdir().expect("work directory");
    let driver = Soffice::new(Host::process());
    let path = dir.path().join("plain.xlsx");
    std::fs::write(&path, package_of(&golden, "a workbook without formulas").generate().expect("the workbook")).expect("workbook file");
    let answer = recalculate_portable_workbook(&Unlaned, &NoWriteNote, &driver, &path, true, None).expect("the answer");
    assert_eq!(answer["needed"], json!(false));
    assert_eq!(answer["recalculated"], json!(false));
    // A macro-enabled workbook is refused by the driver for its kind, and the engine is not tried on it.
    let macro_path = dir.path().join("model.xlsm");
    std::fs::write(&macro_path, package_of(&golden, "a model of every kind of result").generate().expect("the workbook")).expect("workbook file");
    let answer = recalculate_portable_workbook(&Unlaned, &NoWriteNote, &driver, &macro_path, true, None).expect("the answer");
    assert_eq!(answer["needed"], json!(true));
    assert_eq!(answer["recalculated"], json!(false));
    assert!(text(&answer["reason"]).contains(".xlsx only"), "the reason: {}", answer["reason"]);
}
