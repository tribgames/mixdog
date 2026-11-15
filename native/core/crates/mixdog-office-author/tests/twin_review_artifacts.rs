//! Twin test `review_artifacts`: the recording of Node's contact sheet, review artifacts and HTML source drift
//! (`native/core/fixtures/office-review-artifacts/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-review-artifacts.mjs`) against this crate.
//!
//! * Sheets: the size, the pages listed, the file written and its base64 must equal the recording exactly. The pixels
//!   differ in what the two rasterisers (Skia in `@napi-rs/canvas`, tiny-skia here) and the two `sans-serif` faces
//!   draw: outside the page-number strips the mean absolute channel difference must be at most [`MEAN_TOLERANCE`] and
//!   at most [`OUTLIER_SHARE`] of the pixels may differ by more than [`OUTLIER_STEP`] in any channel (the resampled
//!   edges of the page blocks and the frame). Inside a strip only the placement is held: where both sheets have ink,
//!   its left edge and its vertical extent lie within [`LABEL_SLACK`] pixels (the faces differ, the baseline and the
//!   start of the text are the canvas's). The tolerances are the stated reason of the comparison, not measured limits.
//! * Review results: keys and their order, the images that ride along, the sheet's listing and its pixels.
//! * Drift: every answer and the state left must equal the recording exactly.
//!
//! Re-recording is `twin_live_review_artifacts` (ignored: it runs Node).

use std::path::Path;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::{json_number, json_stringify};
use mixdog_office_author::contact_sheet::{ContactSheet, decode_base64, write_contact_sheet};
use mixdog_office_author::review_artifacts::{Receipts, ReviewSession, pptx_review_artifacts};
use mixdog_office_author::source_drift::{HtmlSource, edits_replaced_by_author};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_raster::Image;
use serde_json::{Value, json};

const MEAN_TOLERANCE: f64 = 1.0;
const OUTLIER_SHARE: f64 = 0.01;
const OUTLIER_STEP: i16 = 8;
const LABEL_SLACK: i64 = 4;
const GAP: u32 = 14;
const LABEL: u32 = 22;
const BACKGROUND: [u8; 3] = [236, 238, 242];

fn golden() -> Value {
    twin::load_golden("office-review-artifacts")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    let cases = golden[name].as_array().unwrap_or_else(|| panic!("section {name}"));
    assert!(!cases.is_empty(), "section {name} is empty");
    cases
}

fn registry() -> Registry {
    let face = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-measure/faces/NotoSansLisu-Regular.ttf");
    let mut registry = Registry::new();
    registry.register_file(&Unlaned, &face, Some("Twin Lisu")).expect("the fixture face registers");
    registry
}

/// `(x, y, width, height)` of each page-number strip of a sheet of `count` pages.
fn strips(width: u32, height: u32, count: usize) -> Vec<(u32, u32, u32, u32)> {
    let columns: u32 = match count {
        0..=4 => 2,
        5..=9 => 3,
        _ => 4,
    };
    let cell_width = (width - GAP * (columns + 1)) / columns;
    let rows = (count as u32).div_ceil(columns);
    let cell_height = (height - GAP) / rows - LABEL - GAP;
    (0..count as u32).map(|index| (GAP + (index % columns) * (cell_width + GAP), GAP + (index / columns) * (LABEL + cell_height + GAP), cell_width, LABEL)).collect()
}

/// `(left, top, right, bottom)` of the pixels in the strip that differ from the sheet's background.
fn ink(image: &Image, strip: (u32, u32, u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let (x, y, width, height) = strip;
    let mut bounds: Option<(u32, u32, u32, u32)> = None;
    for row in y..y + height {
        for column in x..x + width {
            let at = ((row * image.width() + column) * 4) as usize;
            if image.rgba()[at..at + 3] != BACKGROUND {
                bounds = Some(match bounds {
                    None => (column, row, column + 1, row + 1),
                    Some((l, t, r, b)) => (l.min(column), t.min(row), r.max(column + 1), b.max(row + 1)),
                });
            }
        }
    }
    bounds
}

fn inside_a_strip(strips: &[(u32, u32, u32, u32)], x: u32, y: u32) -> bool {
    strips.iter().any(|&(sx, sy, w, h)| x >= sx && x < sx + w && y >= sy && y < sy + h)
}

/// The produced sheet's PNG held against the recorded one as the header of this file says.
fn same_pixels(what: &str, recorded: &str, produced: &str, pages: usize, failures: &mut Vec<String>) {
    let (want, got) = (Image::decode(&decode_base64(recorded)).expect("recorded png"), Image::decode(&decode_base64(produced)).expect("produced png"));
    if (want.width(), want.height()) != (got.width(), got.height()) {
        failures.push(format!("{what}: size {}x{} recorded, {}x{} produced", want.width(), want.height(), got.width(), got.height()));
        return;
    }
    let strips = strips(want.width(), want.height(), pages);
    let (mut sum, mut outliers, mut counted) = (0_u64, 0_u64, 0_u64);
    for y in 0..want.height() {
        for x in 0..want.width() {
            if inside_a_strip(&strips, x, y) {
                continue;
            }
            let at = ((y * want.width() + x) * 4) as usize;
            let largest = (0..3).map(|channel| (i16::from(want.rgba()[at + channel]) - i16::from(got.rgba()[at + channel])).abs()).max().unwrap_or(0);
            sum += (0..3).map(|channel| u64::from(want.rgba()[at + channel].abs_diff(got.rgba()[at + channel]))).sum::<u64>();
            outliers += u64::from(largest > OUTLIER_STEP);
            counted += 1;
        }
    }
    let mean = sum as f64 / (counted * 3).max(1) as f64;
    let share = outliers as f64 / counted.max(1) as f64;
    if mean > MEAN_TOLERANCE || share > OUTLIER_SHARE {
        failures.push(format!("{what}: mean difference {mean:.3} (at most {MEAN_TOLERANCE}), {:.3}% of pixels off by more than {OUTLIER_STEP} (at most {}%)", share * 100.0, OUTLIER_SHARE * 100.0));
    }
    for (index, &strip) in strips.iter().enumerate() {
        if let (Some(a), Some(b)) = (ink(&want, strip), ink(&got, strip)) {
            let near = |p: u32, q: u32| (i64::from(p) - i64::from(q)).abs() <= LABEL_SLACK;
            if !(near(a.0, b.0) && near(a.1, b.1) && near(a.3, b.3)) {
                failures.push(format!("{what}: label {index} ink {a:?} recorded, {b:?} produced"));
            }
        }
    }
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
}

fn sheets_equal_the_recording() {
    let g = golden();
    let registry = registry();
    let dir = tempfile::tempdir().expect("dir");
    let mut failures = Vec::new();
    for case in section(&g, "sheets") {
        let name = case["name"].as_str().expect("name");
        let images = case["input"]["images"].as_array().expect("images");
        let output = dir.path().join(case["input"]["output"].as_str().expect("output")).display().to_string();
        let width = case["input"]["options"]["width"].as_u64().map_or(1600, |width| width as u32);
        let produced = write_contact_sheet(&Unlaned, &registry, &NoWriteNote, images, &output, width).unwrap_or_else(|error| panic!("{name}: {error}"));
        let recorded = &case["output"];
        let Some(sheet) = produced else {
            if !recorded.is_null() {
                failures.push(format!("{name}: no sheet produced, one recorded"));
            }
            continue;
        };
        if recorded.is_null() {
            failures.push(format!("{name}: a sheet produced, none recorded"));
            continue;
        }
        let listed: Vec<Value> = sheet.pages.iter().map(|page| json_number(*page)).collect();
        let facts = json!({ "path": basename(&sheet.path), "width": sheet.width, "height": sheet.height, "pages": listed, "mimeType": ContactSheet::MIME_TYPE });
        let want = json!({ "path": recorded["path"], "width": recorded["width"], "height": recorded["height"], "pages": recorded["pages"], "mimeType": recorded["mimeType"] });
        if json_stringify(&facts) != json_stringify(&want) {
            failures.push(format!("{name}\n  recorded {}\n  produced {}", json_stringify(&want), json_stringify(&facts)));
            continue;
        }
        let written = mixdog_fsio::read(&Unlaned, &sheet.path).expect("the sheet file");
        assert_eq!(decode_base64(&sheet.data), written, "{name}: the file holds what the result carries");
        same_pixels(name, recorded["data"].as_str().expect("data"), &sheet.data, sheet.pages.len(), &mut failures);
    }
    no_failures("sheets", section(&g, "sheets").len(), &failures);
}

/// A deck opened for editing is never read against a brief: nothing here may ask for a receipt.
struct NoReceipts;

impl Receipts for NoReceipts {
    fn composition_receipt(&self) -> Option<Value> {
        panic!("a deck opened for editing has no receipt")
    }

    fn attach_rendered_air(&self, _receipt: &mut Value, _images: &[Value]) {
        panic!("a deck opened for editing has no receipt")
    }

    fn for_delivery(&self, _receipt: Value) -> Value {
        panic!("a deck opened for editing has no receipt")
    }
}

fn previews_equal_the_recording() {
    let g = golden();
    let registry = registry();
    let dir = tempfile::tempdir().expect("dir");
    let mut failures = Vec::new();
    for case in section(&g, "previews") {
        let name = case["name"].as_str().expect("name");
        let mut preview = case["input"].clone();
        let output = dir.path().join(preview["output"].as_str().expect("output")).display().to_string();
        preview["output"] = json!(output);
        let result = pptx_review_artifacts(&Unlaned, &registry, &NoWriteNote, &ReviewSession::default(), &NoReceipts, &preview);
        let recorded = &case["output"];

        let keys: Vec<&str> = result.as_object().expect("object").keys().map(String::as_str).collect();
        let want_keys: Vec<&str> = recorded["keys"].as_array().expect("keys").iter().filter_map(Value::as_str).collect();
        if keys != want_keys {
            failures.push(format!("{name}: keys {want_keys:?} recorded, {keys:?} produced"));
            continue;
        }
        let mut rest = result.as_object().expect("object").clone();
        rest.remove("_images");
        rest.remove("contactSheet");
        rest.remove("receipt");
        rest.insert("output".to_owned(), json!(basename(rest["output"].as_str().expect("output"))));
        if json_stringify(&Value::Object(rest)) != json_stringify(&recorded["rest"]) {
            failures.push(format!("{name}: the preview's own keys differ"));
        }
        let images = result["_images"].as_array().expect("images");
        let listed: Vec<Value> = images
            .iter()
            .map(|image| {
                json!({
                    "page": image["page"],
                    "path": image.get("path").and_then(Value::as_str).map(basename),
                    "hasData": image.get("data").and_then(Value::as_str).is_some_and(|data| !data.is_empty()),
                    "width": image.get("width").cloned().unwrap_or(Value::Null),
                    "height": image.get("height").cloned().unwrap_or(Value::Null),
                    "pages": image.get("pages").cloned().unwrap_or(Value::Null),
                    "mimeType": image.get("mimeType").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        if json_stringify(&Value::Array(listed.clone())) != json_stringify(&recorded["images"]) {
            failures.push(format!("{name}: images\n  recorded {}\n  produced {}", json_stringify(&recorded["images"]), json_stringify(&Value::Array(listed))));
            continue;
        }
        let sheet = result.get("contactSheet").map(|sheet| {
            let mut sheet = sheet.clone();
            sheet["path"] = json!(basename(sheet["path"].as_str().expect("path")));
            sheet
        });
        if json_stringify(&sheet.clone().unwrap_or(Value::Null)) != json_stringify(&recorded["contactSheet"]) {
            failures.push(format!("{name}: the listed contact sheet differs"));
            continue;
        }
        match (images.last().filter(|image| image["page"] == json!(0)), recorded["sheetData"].as_str()) {
            (Some(image), Some(want)) => {
                let pages = recorded["contactSheet"]["pages"].as_array().map_or(0, Vec::len);
                same_pixels(name, want, image["data"].as_str().expect("data"), pages, &mut failures);
            }
            (None, None) => {}
            _ => failures.push(format!("{name}: the sheet image rides along on one side only")),
        }
    }
    no_failures("previews", section(&g, "previews").len(), &failures);
}

fn drift_equals_the_recording() {
    let g = golden();
    let mut failures = Vec::new();
    for case in section(&g, "sequences") {
        let name = case["name"].as_str().expect("name");
        let mut session = HtmlSource::default();
        let mut marked = false;
        let mut answers = Vec::new();
        for operation in case["input"]["ops"].as_array().expect("ops") {
            match operation[0].as_str().expect("operation") {
                "mark" => {
                    // A null path is `sourcePath || null` too: no source.
                    session.mark_authored_from_html(operation[1].as_str().unwrap_or_default());
                    marked = true;
                    answers.push(Value::Null);
                }
                "batch" => answers.push(session.note_batch_against_html(&operation[1]).unwrap_or(Value::Null)),
                _ => answers.push(edits_replaced_by_author(Some(&session)).unwrap_or(Value::Null)),
            }
        }
        let state = json!({
            "answers": answers,
            "htmlSource": session.source,
            // A session never marked has neither field in Node.
            "htmlSourceEdits": if marked { json_number(session.edits) } else { Value::Null },
        });
        if json_stringify(&state) != json_stringify(&case["output"]) {
            failures.push(format!("{name}\n  recorded {}\n  produced {}", json_stringify(&case["output"]), json_stringify(&state)));
        }
    }
    no_failures("sequences", section(&g, "sequences").len(), &failures);
    assert_eq!(edits_replaced_by_author(None), None);
    assert!(g["nothing"].as_object().expect("nothing").values().all(Value::is_null));
}

#[test]
fn every_sheet_equals_the_recording() {
    sheets_equal_the_recording();
}

#[test]
fn every_review_result_equals_the_recording() {
    previews_equal_the_recording();
}

#[test]
fn every_drift_answer_equals_the_recording() {
    drift_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_review_artifacts -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/authoring)"]
fn twin_live_review_artifacts() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-review-artifacts.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    sheets_equal_the_recording();
    previews_equal_the_recording();
    drift_equals_the_recording();
}
