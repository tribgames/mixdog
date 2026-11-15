//! Twin test `rendered`: the recording of Node's rendered-page review (`native/core/fixtures/office-rendered/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-rendered.mjs`) against this crate. Every recorded set of page
//! PNGs (decks, documents, worksheets, blank-ish and soft-edged pages, a page past the sampling step) is run through
//! the review, the aesthetic review, the air map and the visual diff. Counts, page numbers, the issue lists (code, path,
//! severity, message, in order) and the key order are exact; a measured share must agree within 1e-6 (the metrics are
//! rounded to four digits, so a value on a rounding edge that flips shows as a 1e-4 difference and is reported, never
//! tolerated). The diff images are compared by the sha256 of their decoded pixels, not their bytes. Re-recording is
//! `twin_live_rendered` (ignored: it runs Node).

use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_base::values::sha256;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_quality::aesthetics::review_rendered_office_aesthetics;
use mixdog_office_quality::render_air::{AirOptions, rendered_air, rendered_air_by_page};
use mixdog_office_quality::rendered::{RenderedOptions, review_rendered_office_pages};
use mixdog_office_quality::visual_diff::compare_rendered_pages;
use mixdog_raster::Image;
use mixdog_raster::canvas::{Bitmap, Canvas};
use serde_json::{Value, json};

/// The agreement of a measured share.
const EPSILON: f64 = 1e-6;

fn golden() -> Value {
    twin::load_golden("office-rendered")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}"))
}

/// Where `expected` and `actual` differ, as lines (at most the first few of each case are shown).
fn differences(path: &str, expected: &Value, actual: &Value, found: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Number(want), Value::Number(got)) => {
            let (want, got) = (want.as_f64().unwrap_or(f64::NAN), got.as_f64().unwrap_or(f64::NAN));
            let exact = want.fract() == 0.0 && got.fract() == 0.0;
            if (exact && want != got) || (want - got).abs() > EPSILON {
                found.push(format!("{path}: recorded {want} produced {got}"));
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                found.push(format!("{path}: recorded {} entries produced {}", want.len(), got.len()));
                return;
            }
            for (index, (want, got)) in want.iter().zip(got).enumerate() {
                differences(&format!("{path}[{index}]"), want, got, found);
            }
        }
        (Value::Object(want), Value::Object(got)) => {
            let (want_keys, got_keys): (Vec<_>, Vec<_>) = (want.keys().collect(), got.keys().collect());
            if want_keys != got_keys {
                found.push(format!("{path}: recorded keys {want_keys:?} produced {got_keys:?}"));
                return;
            }
            for (key, want) in want {
                differences(&format!("{path}.{key}"), want, &got[key], found);
            }
        }
        _ => {
            if expected != actual {
                let cut = |value: &Value| value.to_string().chars().take(160).collect::<String>();
                found.push(format!("{path}: recorded {} produced {}", cut(expected), cut(actual)));
            }
        }
    }
}

/// Replays one section: `run` answers the recorded input, `Err` where Node rejected. The failures of all cases are
/// reported together.
fn replay(golden: &Value, name: &str, run: impl Fn(&Value) -> Result<Value, String>) {
    let cases = section(golden, name);
    assert!(!cases.is_empty(), "section {name} is empty");
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let mut found = Vec::new();
        match (case.get("error"), run(&case["input"])) {
            (Some(_), Err(_)) => {}
            (Some(error), Ok(_)) => found.push(format!("Node rejected ({error}), Rust answered")),
            (None, Err(message)) => found.push(format!("Rust failed: {message}")),
            (None, Ok(value)) => differences("", &case["output"], &value, &mut found),
        }
        if !found.is_empty() {
            failures.push(format!("{name} case {index}:\n    {}", found.iter().take(6).cloned().collect::<Vec<_>>().join("\n    ")));
        }
    }
    assert!(failures.is_empty(), "{name}: {} of {} cases differ\n{}", failures.len(), cases.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

fn images(input: &Value) -> Vec<Value> {
    input.as_array().cloned().unwrap_or_default()
}

/// `options` of a recorded `reviewRenderedOfficePages` call.
fn rendered_options(options: &Value) -> RenderedOptions {
    let mut parsed = RenderedOptions::default();
    parsed.format = options.get("format").and_then(Value::as_str).unwrap_or("").to_owned();
    if let Some(roles) = options.get("pageRoles") {
        parsed.page_roles = roles.clone();
    }
    parsed.small_worksheet = options.get("smallWorksheet").and_then(Value::as_bool).unwrap_or(false);
    parsed.page_count = options.get("pageCount").and_then(Value::as_f64).unwrap_or(0.0);
    parsed.designed_pages = options.get("designedPages").and_then(Value::as_bool).unwrap_or(false);
    parsed.forced_break_pages = options.get("forcedBreakPages").and_then(Value::as_array).map(|pages| pages.iter().filter_map(Value::as_f64).collect());
    parsed
}

/// The sha256 of a diff PNG's pixels as a canvas reads them back (`drawImage` then `getImageData`).
fn decoded_hash(bytes: &[u8]) -> String {
    let image = Image::decode(bytes).expect("a png");
    let mut canvas = Canvas::new(image.width(), image.height()).expect("canvas");
    canvas.draw_image(&Bitmap::from_image(&image).expect("bitmap"), 0.0, 0.0);
    sha256(canvas.get_image_data(0, 0, image.width(), image.height()).expect("pixels").data())
}

fn every_output_equals_the_recording() {
    let g = golden();
    replay(&g, "pages", |input| {
        review_rendered_office_pages(&images(&input["images"]), &rendered_options(&input["options"]))
    });
    replay(&g, "aesthetics", |input| {
        let format = input["format"].as_str().unwrap_or("");
        review_rendered_office_aesthetics(&images(&input["images"]), format, &input["pageRoles"])
    });
    replay(&g, "air", |input| {
        Ok(rendered_air(input.as_str().unwrap_or(""), &AirOptions::default()).map_or(Value::Null, |read| read.to_value()))
    });
    replay(&g, "airByPage", |input| {
        let by_page = rendered_air_by_page(&images(input));
        Ok(Value::Array(by_page.iter().map(|(page, read)| json!([mixdog_js::json_number(*page), read.to_value()])).collect()))
    });
    replay(&g, "diff", |input| {
        let directory = tempfile::tempdir().expect("directory");
        let output = directory.path().join("review.pdf");
        let compared = compare_rendered_pages(&Unlaned, &NoWriteNote, &images(&input["before"]), &images(&input["after"]), &output)?;
        let mut kept = Vec::new();
        for entry in compared["images"].as_array().expect("images") {
            let path = std::path::PathBuf::from(entry["path"].as_str().expect("path"));
            let bytes = mixdog_fsio::read(&Unlaned, &path).expect("saved diff");
            kept.push(json!({
                "page": entry["page"],
                "name": path.file_name().expect("name").to_string_lossy(),
                "width": entry["width"],
                "height": entry["height"],
                "mimeType": entry["mimeType"],
                "kind": entry["kind"],
                "pixelsSha256": decoded_hash(&bytes),
            }));
        }
        Ok(json!({
            "available": compared["available"],
            "pages": compared["pages"],
            "changedPercent": compared["changedPercent"],
            "images": kept,
        }))
    });
}

#[test]
fn every_recorded_review_equals_the_recording() {
    every_output_equals_the_recording();
}

#[test]
fn the_recording_covers_every_section_with_a_real_spread() {
    let g = golden();
    for (name, minimum) in [("pages", 50), ("aesthetics", 30), ("air", 20), ("airByPage", 3), ("diff", 8)] {
        assert!(section(&g, name).len() >= minimum, "{name} has too few cases");
    }
    let codes: Vec<&str> = section(&g, "pages")
        .iter()
        .filter_map(|case| case["output"]["issues"].as_array())
        .flatten()
        .filter_map(|issue| issue["code"].as_str())
        .collect();
    for wanted in [
        "blank_page",
        "content_touches_page_edge",
        "page_bottom_empty",
        "sparse_page",
        "worksheet_print_too_small",
        "low_visual_contrast",
        "under_composed_slide",
        "flat_visual_rhythm",
        "repeated_render_composition",
        "frontier_aesthetic_score_low",
        "worksheet_visual_clutter",
    ] {
        assert!(codes.contains(&wanted), "no {wanted} issue among the recorded reviews");
    }
    let rejected = section(&g, "pages").iter().filter(|case| case.get("error").is_some()).count();
    assert_eq!(rejected, 1, "the one undecodable page is the only rejection");
    assert!(section(&g, "air").iter().any(|case| case["output"].is_null()), "no unreadable page among the air cases");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-quality --test twin_rendered -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/quality)"]
fn twin_live_rendered() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-rendered.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
