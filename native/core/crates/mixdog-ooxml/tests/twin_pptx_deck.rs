//! Twin test `pptx_deck`: the recording of Node's deck modules (`native/core/fixtures/office-pptx-deck/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-pptx-deck.mjs`) against this crate. `fit` replays the table row and table
//! heights of `pptx-table-fit.mjs`; `sequences` replays the deck operations of `portable-pptx-deck.mjs` and the reads of
//! `portable-snapshot-pptx.mjs` step by step on a deck, comparing what each step answered, then the deck's names and the text
//! of every part. Numbers are compared to a relative 1e-9 (the rows are one line of text each, so no height depends on the
//! face measured with), everything else exactly. The date of a comment and the id of a page-number field are replaced by a
//! fixed name on both sides, and the folder a step's files are written in by `@work`. Re-recording is `twin_live_pptx_deck`
//! (ignored: it runs Node).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::{JsRegex, json_number};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package};
use mixdog_ooxml::pptx_deck::{
    handle_add_comment_or_delete_comment, handle_add_provenance, handle_add_slide, handle_apply_theme, handle_delete_slide,
    handle_duplicate_slide, handle_fill_template, handle_import_slides, handle_keep_slides, handle_move_slide, handle_replace_text,
    handle_set_footer_or_set_slide_number, handle_set_layout, handle_set_notes, handle_set_slide_background,
    handle_set_slide_visibility, handle_set_transition,
};
use mixdog_ooxml::pptx_package::{SlideRef, presentation_slides};
use mixdog_ooxml::pptx_table_fit::{TableRow, table_drawn_height, table_row_cells};
use mixdog_ooxml::snapshot_pptx::snapshot_pptx;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-pptx-deck")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

fn list(value: &Value) -> &Vec<Value> {
    value.as_array().expect("a list argument")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

/// The registry the table rows are measured in: the fixture face under the two names a table cell without a face resolves to
/// (Calibri, and Malgun Gothic for the Hangul in a cell).
fn registry() -> Registry {
    let face = twin::repo_root().join("native/core/fixtures/office-measure/faces/MiriamLibre-Regular.otf");
    let mut registry = Registry::new();
    for alias in ["Calibri", "Malgun Gothic"] {
        registry.register_file(&Unlaned, &face, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", face.display()));
    }
    registry
}

/// Compares two values; numbers to a relative 1e-9, object key order not at all.
fn compare(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Number(want), Value::Number(got)) => {
            let (want, got) = (want.as_f64().unwrap_or(f64::NAN), got.as_f64().unwrap_or(f64::NAN));
            if !((want - got).abs() <= 1e-9 * want.abs().max(1.0)) {
                out.push(format!("{path}: recorded {want}, produced {got}"));
            }
        }
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                match got.get(key) {
                    Some(other) => compare(&format!("{path}/{key}"), value, other, out),
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
                compare(&format!("{path}/{index}"), a, b, out);
            }
        }
        _ if expected == actual => {}
        _ => out.push(format!("{path}: recorded {expected}, produced {actual}")),
    }
}

fn assert_same(what: &str, expected: &Value, actual: &Value) {
    let mut found = Vec::new();
    compare("", &twin::normalise(expected), &twin::normalise(actual), &mut found);
    let shown: Vec<String> = found.iter().take(12).map(|line| line.chars().take(400).collect()).collect();
    assert!(found.is_empty(), "{what} differs from the recording:\n{}", shown.join("\n"));
}

// ---- table fit --------------------------------------------------------------------------------------------------------

/// The summary the recorder keeps of a row: its height and, per text cell, the fit it measured.
fn row_value(row: &TableRow) -> Value {
    let cells: Vec<Value> = row
        .cells
        .iter()
        .map(|cell| {
            let fit = cell.fit.as_ref().map_or(Value::Null, |fit| {
                json!({
                    "rowSpan": json_number(fit.row_span),
                    "available": json_number(fit.available),
                    "insets": {
                        "left": json_number(fit.insets.left),
                        "right": json_number(fit.insets.right),
                        "top": json_number(fit.insets.top),
                        "bottom": json_number(fit.insets.bottom),
                    },
                    "lines": fit.measured.lines,
                    "height": json_number(fit.measured.height),
                })
            });
            json!({ "columnOrdinal": cell.column_ordinal, "size": json_number(cell.size), "bold": cell.bold, "fit": fit })
        })
        .collect();
    json!({ "height": json_number(row.height), "cells": cells })
}

fn widths_of(value: &Value) -> Vec<f64> {
    list(value).iter().map(|width| width.as_f64().expect("a width")).collect()
}

#[test]
fn every_row_and_table_draws_to_the_recorded_height() {
    let golden = golden();
    let registry = registry();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let cases = list(&golden["fit"]);
    assert!(cases.len() >= 19, "the recording lost cases: {}", cases.len());
    for (at, case) in cases.iter().enumerate() {
        let produced = match text(&case["kind"]) {
            "row" => table_row_cells(&measurer, text(&case["xml"]), &widths_of(&case["widths"])).map(|row| row_value(&row)),
            "table" => table_drawn_height(&measurer, text(&case["xml"])).map(json_number),
            other => panic!("the recording has a case this test does not replay: {other}"),
        };
        let expected = match case.get("error") {
            Some(error) => json!({ "error": error }),
            None => json!({ "result": case["result"] }),
        };
        assert_same(&format!("fit[{at}]"), &expected, &attempt(produced.map_err(|error| error.to_string())));
    }
}

/// `pptx-table-fit.test.mjs`: one 24 pt line (28.8 pt) in a 30 pt row: inside PowerPoint's default cell insets (3.6 pt top and
/// bottom) only 22.8 pt is left; with the margins the cell states (zero) it fits the row's 30.
#[test]
fn a_table_cell_is_measured_inside_the_margins_it_states_powerpoint_defaults_where_it_states_none() {
    let registry = registry();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let row = |margins: &str| {
        format!(
            "<a:tr h=\"381000\"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz=\"2400\"/><a:t>한 줄</a:t></a:r></a:p></a:txBody><a:tcPr{margins}/></a:tc></a:tr>"
        )
    };
    let widths = [1_828_800.0];
    let defaults = table_row_cells(&measurer, &row(""), &widths).expect("a measured row");
    let fit = defaults.cells[0].fit.as_ref().expect("a fit");
    assert!(fit.measured.height > fit.available, "{fit:?}");
    let tight = table_row_cells(&measurer, &row(" marL=\"0\" marR=\"0\" marT=\"0\" marB=\"0\""), &widths).expect("a measured row");
    let fit = tight.cells[0].fit.as_ref().expect("a fit");
    assert!(fit.measured.height <= fit.available, "{fit:?}");
}

// ---- deck operations and snapshots -------------------------------------------------------------------------------------

/// The deck a sequence works on and the roster of its slides.
struct Deck {
    zip: Option<Package>,
    slides: Vec<SlideRef>,
}

impl Deck {
    fn package(&mut self) -> &mut Package {
        self.zip.as_mut().expect("a step before the deck was made")
    }

    fn refresh(&mut self) {
        let slides = presentation_slides(self.zip.as_ref().expect("a deck"));
        self.slides = slides;
    }
}

/// The path of a file in the work folder as the recording wrote it into an operation: `@work/<name>`.
fn with_work(value: &Value, work: &str) -> Value {
    match value {
        Value::String(item) => match item.strip_prefix("@work/") {
            Some(rest) => Value::String(format!("{work}/{rest}")),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(|item| with_work(item, work)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), with_work(item, work))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}

/// The work folder named `@work` again in what a step answered (an error names the file as Node printed it).
fn without_work(value: &Value, work: &str) -> Value {
    match value {
        Value::String(item) => Value::String(item.replace(work, "@work").replace("@work\\", "@work/")),
        Value::Array(items) => Value::Array(items.iter().map(|item| without_work(item, work)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), without_work(item, work))).collect::<Map<_, _>>()),
        other => other.clone(),
    }
}

fn handle(deck: &mut Deck, work: &str, operation: &Value) -> Result<Value, String> {
    let operation = with_work(operation, work);
    let op = &operation;
    let slides = &mut deck.slides;
    let zip = deck.zip.as_mut().expect("a step before the deck was made");
    match text(&op["op"]) {
        "add_slide" => handle_add_slide(zip, slides, op),
        "delete_slide" => handle_delete_slide(zip, slides, op),
        "move_slide" => handle_move_slide(zip, slides, op),
        "keep_slides" => handle_keep_slides(zip, slides, op),
        "add_comment" | "delete_comment" => handle_add_comment_or_delete_comment(zip, slides, op),
        "add_provenance" => handle_add_provenance(zip, slides, op),
        "duplicate_slide" => handle_duplicate_slide(zip, slides, op),
        "set_notes" => handle_set_notes(zip, slides, op),
        "fill_template" => handle_fill_template(zip, op),
        "replace_text" => handle_replace_text(zip, slides, op),
        "import_slides" => handle_import_slides(&Unlaned, zip, slides, op),
        "set_slide_background" => handle_set_slide_background(zip, slides, op),
        "set_footer" | "set_slide_number" => handle_set_footer_or_set_slide_number(zip, slides, op),
        "apply_theme" => handle_apply_theme(&Unlaned, zip, op),
        "set_layout" => handle_set_layout(zip, slides, op),
        "set_slide_visibility" => handle_set_slide_visibility(zip, slides, op),
        "set_transition" => handle_set_transition(zip, slides, op),
        other => panic!("the recording has an operation this test does not replay: {other}"),
    }
}

/// What one step of a sequence answers, with the deck it works on.
fn step(deck: &mut Deck, work: &std::path::Path, measurer: &TextMeasurer<'_, Unlaned>, step: &Value) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    match field("op") {
        "create" => {
            let path = work.join("created.pptx");
            let options = CreateOptions { file_kind: "pptx", title: field("title"), sheet_name: "" };
            create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options)?;
            deck.zip = Some(load_package(&Unlaned, &path)?);
            deck.refresh();
            Ok(Value::Null)
        }
        "set" => {
            deck.package().set(field("name"), field("text"));
            deck.refresh();
            Ok(Value::Null)
        }
        "remove" => {
            deck.package().remove(field("name"));
            deck.refresh();
            Ok(Value::Null)
        }
        "file" => {
            let bytes = STANDARD.decode(field("base64")).expect("base64");
            mixdog_fsio::write(&Unlaned, &work.join(field("name")), bytes).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "slides" => Ok(Value::Array(presentation_slides(deck.package()).iter().map(SlideRef::to_value).collect())),
        "snapshot" => {
            let options = step.get("options").unwrap_or(&Value::Null);
            snapshot_pptx(deck.package(), options, measurer).map_err(|error| error.to_string())
        }
        "handle" => handle(deck, &work.display().to_string(), &step["operation"]),
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

/// `{ names, parts }` with the page-number field id and the date of a comment fixed.
fn snapshot(package: &Package) -> Value {
    let uuid = JsRegex::new_static(r"\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}", "g");
    let date = JsRegex::new_static(r#"dt="[^"]*""#, "g");
    let fixed = |xml: String| {
        let xml = uuid.replace_all_with(&xml, |_| "{<uuid>}".to_owned());
        date.replace_all_with(&xml, |_| "dt=\"<date>\"".to_owned())
    };
    let mut parts = Map::new();
    for entry in package.entries() {
        if !entry.dir {
            parts.insert(entry.name.clone(), Value::from(fixed(package.text(&entry.name))));
        }
    }
    json!({ "names": package.names(), "parts": parts })
}

#[test]
fn every_deck_operation_and_snapshot_equals_the_recording() {
    every_sequence_equals_the_recording();
}

fn every_sequence_equals_the_recording() {
    let golden = golden();
    let registry = registry();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let sequences = list(&golden["sequences"]);
    assert!(sequences.len() >= 7, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let folder = tempfile::tempdir().expect("work directory");
        let work = folder.path().display().to_string();
        let mut deck = Deck { zip: None, slides: Vec::new() };
        let steps = list(&sequence["steps"]);
        let recorded = list(&sequence["outputs"]);
        assert_eq!(steps.len(), recorded.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(recorded).enumerate() {
            let produced = without_work(&attempt(step(&mut deck, folder.path(), &measurer, one)), &work);
            assert_same(&format!("{name}, step {index} ({})", text(&one["op"])), expected, &produced);
        }
        let produced = deck.zip.as_ref().map_or(Value::Null, snapshot);
        assert_same(&format!("{name}, the deck"), &sequence["snapshot"], &produced);
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_pptx_deck -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_pptx_deck() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-deck.mjs", &twin::node_source_root());
    every_sequence_equals_the_recording();
}
