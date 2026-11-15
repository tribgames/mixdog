#![allow(clippy::disallowed_methods, reason = "fixtures are written and read directly")]
//! Twin test `xlsx_charts_soffice`: the recording of Node's add_chart operation and LibreOffice driver
//! (`native/core/fixtures/office-xlsx-charts-soffice/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-xlsx-charts-soffice.mjs`) against this crate. `charts` replays add_chart step by step
//! (the answer, then the chart part, the drawing, its relationships, the content types and the worksheet as text); `refresh` the
//! copy of its cells a chart part carries; `soffice` the command line and the texts the driver hands to LibreOffice for each kind of
//! job, the install paths the registry names, the error cells of a recalculated workbook and the recalculations that never reach
//! LibreOffice. Text widths are measured in the fixture faces of `office-measure` registered on both sides. Re-recording is
//! `twin_live_xlsx_charts_soffice` (ignored: it runs Node).
//!
//! The tests ported from `portable-soffice.slow.test.mjs` and `portable-soffice-legacy.slow.test.mjs` run the real LibreOffice
//! front-end and are ignored: `cargo test -p mixdog-ooxml --test twin_xlsx_charts_soffice -- --ignored` on a machine that has it.

use std::path::{Path, PathBuf};

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::JsRegex;
use mixdog_office_base::twin;
use mixdog_ooxml::cells::{Sheet, workbook_sheets};
use mixdog_ooxml::soffice::args::{MACRO_LOCKDOWN_REGISTRY, convert_arguments, mac_font_config, registry_soffice_programs};
use mixdog_ooxml::soffice::run::MAX_STDERR_CHARS;
use mixdog_ooxml::soffice::{ConvertError, Host, RenderFormat, ScratchHooks, Soffice, workbook_formula_errors};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx_charts::{add_worksheet_chart, refresh_chart_caches};
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-xlsx-charts-soffice")
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
    registry
}

fn package_of(golden: &Value, workbook: &str) -> Package {
    let mut package = Package::new();
    for (name, content) in golden["workbooks"][workbook].as_object().unwrap_or_else(|| panic!("workbook {workbook}")) {
        package.set(name, text(content));
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

fn names_of(package: &Package) -> Vec<String> {
    let mut names: Vec<String> = package.names().into_iter().filter(|name| !name.ends_with('/')).collect();
    names.sort();
    names
}

fn charts(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>) {
    let scenarios = list(&golden["charts"]);
    assert!(scenarios.len() >= 2, "the recording lost scenarios: {}", scenarios.len());
    for scenario in scenarios {
        let name = text(&scenario["name"]);
        let mut package = package_of(golden, text(&scenario["workbook"]));
        for (index, step) in list(&scenario["steps"]).iter().enumerate() {
            let what = format!("{name}, step {index} ({})", step["op"]);
            let sheets: Vec<Sheet> = workbook_sheets(&package);
            let sheet = sheets.iter().find(|sheet| sheet.name == text(&step["sheet"])).expect("the sheet").clone();
            let xml = package.text(&sheet.path);
            let outcome = add_worksheet_chart(measurer, &mut package, &sheet, &xml, &step["op"], &sheets);
            assert_text(&format!("{what}: the answer"), &step["output"], &recorded_text(outcome.clone()));
            let recorded_names: Vec<String> = list(&step["names"]).iter().map(|name| text(name).to_owned()).collect();
            assert_eq!(recorded_names, names_of(&package), "{what}: the parts");
            let mut parts = vec![
                ("worksheet", sheet.path.clone()),
                ("drawing", "xl/drawings/drawing1.xml".to_owned()),
                ("drawingRels", "xl/drawings/_rels/drawing1.xml.rels".to_owned()),
                ("types", "[Content_Types].xml".to_owned()),
            ];
            if let Ok(answer) = &outcome {
                parts.push(("chart", answer["chart"].as_str().expect("the chart part").to_owned()));
            }
            for (key, part) in parts {
                assert_same(&format!("{what}: {key}"), text(&step[key]), &package.text(&part));
            }
        }
    }
}

fn refresh(golden: &Value) {
    let scenarios = list(&golden["refresh"]);
    assert!(scenarios.len() >= 4, "the recording lost scenarios: {}", scenarios.len());
    for scenario in scenarios {
        let name = text(&scenario["name"]);
        let mut package = Package::new();
        for key in ["parts", "before"] {
            for (part, content) in scenario[key].as_object().expect("parts") {
                package.set(part, text(content));
            }
        }
        refresh_chart_caches(&mut package).unwrap_or_else(|error| panic!("{name}: {error}"));
        for (part, content) in scenario["after"].as_object().expect("the charts after") {
            assert_same(&format!("{name}: {part}"), text(content), &package.text(part));
        }
    }
}

fn soffice_texts(golden: &Value) {
    let soffice = &golden["soffice"];
    assert_same("the macro lockdown registry", text(&soffice["registry"]), MACRO_LOCKDOWN_REGISTRY);
    assert_eq!(soffice["maxStderrChars"], json!(MAX_STDERR_CHARS));
    // The recorded paths are the ones of the system Node ran on.
    if (text(&golden["platform"]) == "win32") == cfg!(windows) {
        let cases = list(&soffice["argumentCases"]);
        assert!(cases.len() >= 14, "the recording lost cases: {}", cases.len());
        for case in cases {
            let produced = convert_arguments(Path::new(text(&case["profile"])), text(&case["to"]), Path::new(text(&case["outDir"])), Path::new(text(&case["input"])));
            assert_eq!(json!(produced), case["args"], "{} in {}", text(&case["kind"]), text(&case["profile"]));
        }
    }
    for case in list(&soffice["fontConfigs"]) {
        let office = case["office"].as_str().map(Path::new);
        let produced = mac_font_config(Path::new("$HOME"), Path::new(text(&case["cache"])), office);
        assert_same(&format!("the font config for {}", text(&case["cache"])), text(&case["config"]), &produced);
    }
    for case in list(&soffice["registryPrograms"]) {
        assert_eq!(json!(registry_soffice_programs(text(&case["output"]))), case["programs"], "reg query output {}", case["output"]);
    }
    for case in list(&soffice["formulaErrors"]) {
        let found = workbook_formula_errors(&package_of(golden, text(&case["workbook"])));
        let by_type: serde_json::Map<String, Value> =
            found.by_type.iter().map(|(kind, entry)| (kind.clone(), json!({ "count": entry.count, "cells": entry.cells, "truncated": entry.truncated }))).collect();
        let produced = json!({ "total": found.total, "byType": by_type, "unparsed": found.unparsed });
        let recorded: Value = serde_json::from_str(text(&case["output"]["result"])).expect("the recorded errors");
        assert_eq!(produced, recorded, "the error cells of {}", text(&case["workbook"]));
    }
}

fn recalculations(golden: &Value) {
    let dir = tempfile::tempdir().expect("work directory");
    let driver = Soffice::new(Host::process());
    let cases = list(&golden["soffice"]["recalculations"]);
    assert!(cases.len() >= 6, "the recording lost cases: {}", cases.len());
    for case in cases {
        let path = dir.path().join(text(&case["file"]));
        std::fs::write(&path, package_of(golden, text(&case["workbook"])).generate().expect("the workbook")).expect("workbook file");
        let produced = driver.recalculate_workbook(&Unlaned, &path, case["force"].as_bool() == Some(true), None);
        let what = format!("recalculating {} as {}", text(&case["workbook"]), text(&case["file"]));
        let recorded: Value = serde_json::from_str(text(&case["output"]["result"])).expect("the recorded answer");
        assert_eq!(produced.expect(&what), recorded, "{what}");
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    charts(&golden, &measurer);
    refresh(&golden);
    soffice_texts(&golden);
    recalculations(&golden);
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_xlsx_charts_soffice -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_xlsx_charts_soffice() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx-charts-soffice.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}

// ---- the tests that run the real LibreOffice ----------------------------------------------------------------------------

fn driver() -> Soffice {
    Soffice::new(Host::process())
}

/// A workbook with the formulas of the recorded `sales` book, written to `name` in a new folder.
fn workbook_file(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, package_of(&golden(), "sales").generate().expect("the workbook")).expect("workbook file");
    path
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|details| details.len()).unwrap_or(0)
}

/// A killed or failed run can leave a lock behind in the profile it used, and a reused profile would hand that to everything after it.
/// The failed conversion drops the profile instead, so the next render builds a clean one.
#[test]
#[ignore = "runs the real LibreOffice"]
fn a_failed_conversion_leaves_the_next_render_working() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let source = workbook_file(dir.path(), "recovers.xlsx");
    assert!(driver.render(&Unlaned, &dir.path().join("absent.xlsx"), &dir.path().join("absent.pdf"), RenderFormat::Pdf, None).is_err());
    let rendered = driver.render(&Unlaned, &source, &dir.path().join("after.pdf"), RenderFormat::Pdf, None).expect("the render after a failure");
    assert!(size_of(&rendered) > 0);
    driver.shutdown(&Unlaned);
}

/// LibreOffice writes its output under the source's own name, so overlapping runs would fight over the same intermediate file, and a
/// shared profile would refuse the second process. Both renders must still finish.
#[test]
#[ignore = "runs the real LibreOffice"]
fn concurrent_renders_both_produce_a_pdf_through_the_shared_profile() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let source = workbook_file(dir.path(), "queued.xlsx");
    let outputs = [dir.path().join("first.pdf"), dir.path().join("second.pdf")];
    std::thread::scope(|scope| {
        let runs: Vec<_> = outputs.iter().map(|output| scope.spawn(|| driver.render(&Unlaned, &source, output, RenderFormat::Pdf, None))).collect();
        for (run, output) in runs.into_iter().zip(&outputs) {
            assert_eq!(&run.join().expect("the render").expect("a PDF"), output);
            assert!(size_of(output) > 0, "{}", output.display());
        }
    });
    driver.shutdown(&Unlaned);
}

#[test]
#[ignore = "runs the real LibreOffice"]
fn a_render_to_a_picture_writes_the_first_page() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let source = workbook_file(dir.path(), "picture.xlsx");
    let rendered = driver.render(&Unlaned, &source, &dir.path().join("page.png"), RenderFormat::Png, None).expect("a PNG");
    assert!(std::fs::read(rendered).expect("the picture").starts_with(&[0x89, b'P', b'N', b'G']));
    driver.shutdown(&Unlaned);
}

/// LibreOffice names what it converts after the source it read, minus the source's own extension: a document named `reopen.check.xlsx`
/// comes back as `reopen.check.pdf`. Every caller finds its output by rebuilding that name.
#[test]
#[ignore = "runs the real LibreOffice"]
fn a_reopen_validation_finds_the_pdf_named_after_the_source() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let source = workbook_file(dir.path(), "reopen.check.xlsx");
    let reopened = driver.validate_reopen(&Unlaned, &source, None).expect("the validation");
    assert_eq!(reopened["available"], json!(true));
    assert_eq!(reopened["opened"], json!(true));
    assert_eq!(reopened["backend"], json!("libreoffice"));
    assert!(reopened["outputBytes"].as_u64().is_some_and(|bytes| bytes > 0));
    driver.shutdown(&Unlaned);
}

#[test]
#[ignore = "runs the real LibreOffice"]
fn a_recalculation_reads_back_the_workbook_named_after_the_source() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let source = workbook_file(dir.path(), "recalculate.check.xlsx");
    let recalculated = driver.recalculate_workbook(&Unlaned, &source, true, None).expect("the recalculation");
    assert_eq!(recalculated["available"], json!(true));
    assert_eq!(recalculated["recalculated"], json!(true));
    assert!(recalculated["outputBytes"].as_u64().is_some_and(|bytes| bytes > 0));
    driver.shutdown(&Unlaned);
}

/// The roundtrip is asked for values alone. Kept whole, LibreOffice's copy put its own style table under the cells and its own chart.
/// The chart's copy of its cells is the one part that follows the values: written before them, its formula column held 0.
#[test]
#[ignore = "runs the real LibreOffice"]
fn a_recalculation_carries_the_computed_values_into_the_workbook_as_authored_and_changes_nothing_else() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let mut package = package_of(&golden, "sales");
    let sheets = workbook_sheets(&package);
    let sheet = sheets[0].clone();
    // Written without the values of its formulas.
    let written = [180, 215, 250, 285].iter().fold(package.text(&sheet.path), |xml, value| xml.replace(&format!("<v>{value}</v>"), ""));
    package.set(&sheet.path, written.as_str());
    let chart = json!({ "op": "add_chart", "chartType": "column", "range": "A1:A5,F1:F5", "cell": "H2" });
    add_worksheet_chart(&measurer, &mut package, &sheet, &written, &chart, &sheets).expect("the chart");
    let source = dir.path().join("recalculate.faces.xlsx");
    std::fs::write(&source, package.generate().expect("the workbook")).expect("workbook file");
    let before = Package::load(&std::fs::read(&source).expect("before")).expect("loads");
    let report = driver.recalculate_workbook(&Unlaned, &source, true, None).expect("the recalculation");
    assert_eq!(report["recalculated"], json!(true));
    let after = Package::load(&std::fs::read(&source).expect("after")).expect("loads");
    assert_eq!(names_of(&after), names_of(&before), "no part added or dropped");
    let caches = JsRegex::new(r"<c:(num|str)Cache>[\s\S]*?<\/c:\1Cache>", "g").expect("the cache pattern");
    let without_caches = |xml: &str| caches.replace_all_with(xml, |_| String::new());
    assert_eq!(without_caches(&after.text("xl/charts/chart1.xml")), without_caches(&before.text("xl/charts/chart1.xml")), "the chart is the one authored");
    assert!(after.text("xl/charts/chart1.xml").contains("<c:v>180</c:v>"), "its copy of the formula column holds the values");
    for name in names_of(&before) {
        if name.starts_with("xl/worksheets/sheet") || name == "xl/workbook.xml" || name.starts_with("xl/charts/chart") {
            continue;
        }
        assert_eq!(after.text(&name), before.text(&name), "{name}");
    }
    driver.shutdown(&Unlaned);
}

/// A CSV converts to a workbook the same way a legacy file does.
fn csv_input() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("work directory");
    let path = dir.path().join("t.csv");
    std::fs::write(&path, "a,b\n1,2\n").expect("the csv");
    (dir, path)
}

#[test]
#[ignore = "runs the real LibreOffice"]
fn a_failed_copy_of_the_converted_file_does_not_name_the_private_scratch_folder() {
    let (dir, path) = csv_input();
    let driver = driver();
    assert!(driver.available(), "LibreOffice is not installed");
    let output = dir.path().join("taken.xlsx");
    std::fs::write(&output, "already here").expect("the file in the way");
    let error = driver.convert_legacy_office(&Unlaned, &path, &output, None, &ScratchHooks::default()).expect_err("an existing output is not replaced");
    assert!(error.to_string().contains("EEXIST"), "{error}");
    assert!(!error.to_string().contains("mixdog-office-legacy-"), "{error}");
    assert_eq!(std::fs::read_to_string(&output).expect("untouched"), "already here");
    driver.shutdown(&Unlaned);
}

#[test]
#[ignore = "runs the real LibreOffice"]
fn a_cancellation_stays_an_abort_and_every_conversion_folder_is_removed() {
    let (dir, path) = csv_input();
    let driver = driver();
    assert!(driver.available(), "LibreOffice is not installed");
    let cancel = std::sync::atomic::AtomicBool::new(true);
    let error = driver.convert_legacy_office(&Unlaned, &path, &dir.path().join("out.xlsx"), Some(&cancel), &ScratchHooks::default()).expect_err("cancelled");
    assert!(matches!(error, ConvertError::Aborted(_)), "{error:?}");
    driver.shutdown(&Unlaned);
}

#[test]
#[ignore = "runs the real LibreOffice"]
fn a_conversion_folder_that_cannot_be_removed_is_retried_and_then_logged_not_swallowed() {
    let (dir, path) = csv_input();
    let driver = driver();
    assert!(driver.available(), "LibreOffice is not installed");
    let logged = std::sync::Mutex::new(Vec::new());
    let attempts = std::sync::atomic::AtomicUsize::new(0);
    let busy = |_: &Path| {
        attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(std::io::Error::from_raw_os_error(if cfg!(windows) { 32 } else { 16 }))
    };
    let log = |line: &str| logged.lock().expect("log").push(line.to_owned());
    let output = dir.path().join("out.xlsx");
    driver.convert_legacy_office(&Unlaned, &path, &output, None, &ScratchHooks { remove: Some(&busy), log: Some(&log) }).expect("the conversion");
    assert!(attempts.load(std::sync::atomic::Ordering::SeqCst) > 1);
    let logged = logged.lock().expect("log");
    assert_eq!(logged.len(), 1);
    assert!(logged[0].contains("scratch folder") && logged[0].contains("mixdog-office-legacy-"), "{}", logged[0]);
    assert!(output.exists());
    driver.shutdown(&Unlaned);
}

/// A legacy binary file is saved once as its package beside the original; the same conversion a second time is refused instead of
/// overwriting it.
#[test]
#[ignore = "runs the real LibreOffice"]
fn a_workbook_saved_as_a_legacy_file_converts_back_beside_it_and_is_never_overwritten() {
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let seed = workbook_file(dir.path(), "seed.xlsx");
    let legacy = driver.convert_legacy_office(&Unlaned, &seed, &dir.path().join("ledger.xls"), None, &ScratchHooks::default()).expect("saved as .xls");
    assert!(size_of(&legacy) > 0);
    let converted = driver.convert_legacy_office(&Unlaned, &legacy, &dir.path().join("ledger.xlsx"), None, &ScratchHooks::default()).expect("converted back");
    assert!(size_of(&converted) > 0);
    let again = driver.convert_legacy_office(&Unlaned, &legacy, &converted, None, &ScratchHooks::default()).expect_err("the result is not overwritten");
    assert!(matches!(again, ConvertError::Failed(_)), "{again:?}");
    driver.shutdown(&Unlaned);
}

/// The computed values and the page count the Node driver recorded when it was run with `--live`.
#[test]
#[ignore = "runs the real LibreOffice"]
fn the_live_recalculation_and_rendering_equal_the_recording_of_node() {
    let golden = golden();
    let Some(live) = golden.get("live").filter(|live| !live.is_null()) else { return };
    let (dir, driver) = (tempfile::tempdir().expect("work directory"), driver());
    assert!(driver.available(), "LibreOffice is not installed");
    let path = dir.path().join("live-recalc.xlsx");
    let mut package = Package::new();
    for (name, content) in live["recalcBook"].as_object().expect("the workbook") {
        package.set(name, text(content));
    }
    std::fs::write(&path, package.generate().expect("the workbook")).expect("workbook file");
    let mut report = driver.recalculate_workbook(&Unlaned, &path, true, None).expect("the recalculation");
    report.as_object_mut().expect("a report").remove("outputBytes");
    assert_eq!(report, live["recalculation"]["report"]);
    let after = Package::load(&std::fs::read(&path).expect("after")).expect("loads");
    let sheet = after.text("xl/worksheets/sheet1.xml");
    for (reference, value) in live["recalculation"]["values"].as_object().expect("values") {
        let wanted = format!("<c r=\"{reference}\"");
        let at = sheet.find(&wanted).unwrap_or_else(|| panic!("{reference} is missing"));
        assert!(sheet[at..].contains(&format!("<v>{}</v>", text(value))), "{reference} should hold {value}");
    }
    let pdf = driver.render(&Unlaned, &workbook_file(dir.path(), "live-render.xlsx"), &dir.path().join("live-render.pdf"), RenderFormat::Pdf, None).expect("a PDF");
    let bytes = std::fs::read(pdf).expect("the PDF");
    let page = JsRegex::new(r"\/Type\s*\/Page\b", "g").expect("the page pattern");
    let pages = page.find_iter(&String::from_utf8_lossy(&bytes)).count();
    assert_eq!(pages as u64, live["render"]["pages"].as_u64().unwrap_or(0), "the page count");
    driver.shutdown(&Unlaned);
}
