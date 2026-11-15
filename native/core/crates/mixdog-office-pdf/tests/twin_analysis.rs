//! Twin test `analysis`: the office PDF analysis of Node (the recording `native/core/fixtures/office-analysis/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-analysis.mjs`) against this crate. Generated PDFs go through
//! the layout, the table inference, the image extraction, the outline and the text search; hand-built layouts go through
//! the search and the table inference alone. Coordinates are equal within 1e-6, every text exactly; an image is its
//! metadata and the raw pixels of its PNG. Re-recording is `twin_live_analysis` (ignored: it runs Node).

use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_pdf::{
    AnalysisError, BoxShape, ImageOptions, LayoutItem, LayoutOptions, PageLayout, PdfLayout,
    PdfSource, SearchOptions, extract_pdf_images, extract_pdf_outline, extract_pdf_text_layout,
    find_pdf_text, infer_pdf_tables,
};
use mixdog_raster::Image;
use serde_json::Value;

const SET: &str = "office-analysis";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-analysis.mjs";
const TOLERANCE: f64 = 1e-6;

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The paths at which two values differ: numbers within [`TOLERANCE`], everything else exactly, object key order free.
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
                out.push(format!(
                    "{path}: {} items recorded, {} produced",
                    want.len(),
                    got.len()
                ));
            }
            for (index, (a, b)) in want.iter().zip(got).enumerate() {
                differences(&format!("{path}/{index}"), a, b, out);
            }
        }
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (
                a.as_f64().unwrap_or(f64::NAN),
                b.as_f64().unwrap_or(f64::NAN),
            );
            if (a - b).abs() > TOLERANCE {
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
        found
            .iter()
            .take(12)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn error_json(error: &AnalysisError) -> Value {
    serde_json::json!({ "name": error.name, "message": error.message })
}

fn layout_options(options: &Value) -> LayoutOptions {
    let mut out = LayoutOptions::default();
    if let Some(pages) = options["pages"].as_array() {
        out.pages = Some(
            pages
                .iter()
                .map(|page| page.as_f64().expect("page number"))
                .collect(),
        );
    }
    if let Some(max) = options["maxItems"].as_u64() {
        out.max_items = max as usize;
    }
    if let Some(shapes) = options["shapes"].as_bool() {
        out.shapes = shapes;
    }
    out
}

fn search_options(options: &Value) -> SearchOptions {
    let mut out = SearchOptions::default();
    if let Some(limit) = options["limit"].as_u64() {
        out.limit = limit as usize;
    }
    out.whole_word = options["wholeWord"].as_bool().unwrap_or(false);
    out.regex = options["regex"].as_bool().unwrap_or(false);
    out
}

fn number(value: &Value, key: &str) -> f64 {
    value[key]
        .as_f64()
        .unwrap_or_else(|| panic!("{key} is not a number in {value}"))
}

/// A recorded (or hand-built) layout as this crate's type.
fn layout_of(value: &Value) -> PdfLayout {
    let pages = value["pages"]
        .as_array()
        .expect("pages")
        .iter()
        .map(|page| PageLayout {
            page: page["page"].as_u64().expect("page") as usize,
            width: number(page, "width"),
            height: number(page, "height"),
            origin: None,
            transform: [1.0, 0.0, 0.0, -1.0, 0.0, number(page, "height")],
            items: page["items"]
                .as_array()
                .expect("items")
                .iter()
                .map(|item| LayoutItem {
                    text: item["text"].as_str().expect("text").to_owned(),
                    x: number(item, "x"),
                    top: number(item, "top"),
                    width: number(item, "width"),
                    height: number(item, "height"),
                    vertical: item["vertical"].as_bool().unwrap_or(false),
                    reversed: item["reversed"].as_bool().unwrap_or(false),
                    direction: item["direction"].as_str().unwrap_or("").to_owned(),
                    font: item["font"].as_str().unwrap_or("").to_owned(),
                })
                .collect(),
            lines: Vec::new(),
            boxes: page["boxes"]
                .as_array()
                .expect("boxes")
                .iter()
                .map(|shape| BoxShape {
                    x: number(shape, "x"),
                    top: number(shape, "top"),
                    width: number(shape, "width"),
                    height: number(shape, "height"),
                    filled: shape["filled"].as_bool().unwrap_or(false),
                    stroked: shape["stroked"].as_bool().unwrap_or(false),
                    checkbox: shape["checkbox"].as_bool().unwrap_or(false),
                })
                .collect(),
            shapes_unavailable: None,
            links: Vec::new(),
        })
        .collect();
    PdfLayout {
        page_count: value["pageCount"].as_i64().expect("pageCount"),
        pages,
        truncated: value["truncated"].as_bool().unwrap_or(false),
    }
}

fn searches_match(name: &str, layout: &PdfLayout, searches: &Value) {
    for search in searches.as_array().expect("searches") {
        let query = search["query"].as_str().expect("query");
        let what = format!("{name}: search {query:?} {}", search["options"]);
        let ran = find_pdf_text(layout, query, &search_options(&search["options"]));
        match (&search["error"], ran) {
            (Value::Null, Ok(result)) => assert_same(&what, &search["result"], &result.to_json()),
            (Value::Null, Err(error)) => {
                panic!("{what}: Node found a result, this failed: {error}")
            }
            (expected, Err(error)) => assert_same(&what, expected, &error_json(&error)),
            (expected, Ok(result)) => panic!(
                "{what}: Node failed with {expected}, this found {}",
                result.to_json()
            ),
        }
    }
}

#[test]
fn layouts_tables_and_searches_equal_the_recording() {
    let golden = twin::load_golden(SET);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let pdf = unhex(case["pdf"].as_str().expect("pdf"));
        let mut base: Option<PdfLayout> = None;
        for (position, recorded) in case["layouts"]
            .as_array()
            .expect("layouts")
            .iter()
            .enumerate()
        {
            let what = format!("{name}: layout {}", recorded["options"]);
            let ran = extract_pdf_text_layout(
                &Unlaned,
                PdfSource::Bytes(&pdf),
                &layout_options(&recorded["options"]),
            );
            match (&recorded["error"], ran) {
                (Value::Null, Ok(layout)) => {
                    assert_same(&what, &recorded["result"], &layout.to_json());
                    if let Some(tables) = recorded.get("tables") {
                        assert_same(
                            &format!("{what}: tables"),
                            tables,
                            &infer_pdf_tables(&layout).to_json(),
                        );
                    }
                    if position == 0 {
                        base = Some(layout);
                    }
                }
                (Value::Null, Err(error)) => {
                    panic!("{what}: Node gave a layout, this failed: {error}")
                }
                (expected, Err(error)) => assert_same(&what, expected, &error_json(&error)),
                (expected, Ok(_)) => {
                    panic!("{what}: Node failed with {expected}, this gave a layout")
                }
            }
        }
        if let Some(layout) = &base {
            searches_match(name, layout, &case["searches"]);
        }
    }
}

#[test]
fn outlines_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let mut seen = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let Some(runs) = case.get("outline").and_then(Value::as_array) else {
            continue;
        };
        let pdf = unhex(case["pdf"].as_str().expect("pdf"));
        for run in runs {
            let max = run["maxEntries"].as_u64().expect("maxEntries") as usize;
            let outline =
                extract_pdf_outline(&Unlaned, PdfSource::Bytes(&pdf), max).expect("an outline");
            assert_same(
                &format!("{}: outline up to {max}", case["name"]),
                &run["result"],
                &outline.to_json(),
            );
            seen += 1;
        }
        let none = extract_pdf_outline(&Unlaned, PdfSource::Bytes(&pdf), 0).expect("an outline");
        assert!(
            none.entries.is_empty() && none.truncated,
            "no entries are asked for"
        );
    }
    assert!(seen > 0);
}

/// The channel count, size and raw pixels of a PNG.
fn pixels_of(png: &[u8]) -> Value {
    let image = Image::decode(png).expect("the PNG decodes");
    serde_json::json!({
        "channels": image.channels(),
        "width": image.width(),
        "height": image.height(),
        "raw": hex(&image.to_raw()),
    })
}

fn images_match(what: &str, expected: &Value, pdf: &[u8], pages: Option<Vec<f64>>) {
    let options = ImageOptions {
        pages,
        cancel: None,
    };
    let extraction =
        extract_pdf_images(&Unlaned, PdfSource::Bytes(pdf), &options).expect("an extraction");
    let json = extraction.to_json();
    for key in ["pageCount", "imageCount", "images"] {
        assert_same(&format!("{what}: {key}"), &expected[key], &json[key]);
    }
    let pixels: Vec<Value> = extraction
        .images
        .iter()
        .map(|image| pixels_of(&image.png))
        .collect();
    assert_same(
        &format!("{what}: pixels"),
        &expected["pixels"],
        &Value::Array(pixels),
    );
}

#[test]
fn images_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let mut seen = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let Some(expected) = case.get("images") else {
            continue;
        };
        let pdf = unhex(case["pdf"].as_str().expect("pdf"));
        images_match(&format!("{}: images", case["name"]), expected, &pdf, None);
        images_match(
            &format!("{}: images of page 2", case["name"]),
            &case["imagesOnPage2"],
            &pdf,
            Some(vec![2.0]),
        );
        seen += 1;
    }
    assert!(seen > 0);
}

#[test]
fn the_selection_of_pages_and_damaged_input_fail_as_node_does() {
    let golden = twin::load_golden(SET);
    let basic = golden["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "text-basic")
        .expect("text-basic");
    let pdf = unhex(basic["pdf"].as_str().expect("pdf"));
    for recorded in golden["errors"].as_array().expect("errors") {
        let pages: Vec<f64> = recorded["pages"]
            .as_array()
            .expect("pages")
            .iter()
            .map(|page| page.as_f64().expect("number"))
            .collect();
        let what = format!("pages {pages:?}");
        let ran = extract_pdf_text_layout(
            &Unlaned,
            PdfSource::Bytes(&pdf),
            &LayoutOptions {
                pages: Some(pages.clone()),
                ..LayoutOptions::default()
            },
        );
        match (&recorded["layout"]["error"], ran) {
            (Value::Null, Ok(layout)) => {
                let numbers: Vec<Value> = layout
                    .pages
                    .iter()
                    .map(|page| Value::from(page.page))
                    .collect();
                assert_same(
                    &what,
                    &recorded["layout"]["result"]["pageNumbers"],
                    &Value::Array(numbers),
                );
            }
            (expected, Err(error)) => assert_same(&what, expected, &error_json(&error)),
            (expected, Ok(_)) => panic!("{what}: Node failed with {expected}, this gave a layout"),
        }
        let images = extract_pdf_images(
            &Unlaned,
            PdfSource::Bytes(&pdf),
            &ImageOptions {
                pages: Some(pages),
                cancel: None,
            },
        );
        match (&recorded["images"]["error"], images) {
            (Value::Null, Ok(_)) => {}
            (expected, Err(error)) => {
                assert_same(&format!("{what}: images"), expected, &error_json(&error))
            }
            (expected, Ok(_)) => {
                panic!("{what}: Node failed with {expected}, the images were extracted")
            }
        }
    }
    let damaged = unhex(golden["notPdf"]["bytes"].as_str().expect("bytes"));
    let error = extract_pdf_text_layout(
        &Unlaned,
        PdfSource::Bytes(&damaged),
        &LayoutOptions::default(),
    )
    .expect_err("not a PDF");
    assert_same("not a PDF", &golden["notPdf"]["error"], &error_json(&error));
    let none = &golden["outlineMax"]["result"];
    let outline = extract_pdf_outline(&Unlaned, PdfSource::Bytes(&pdf), 0).expect("an outline");
    assert_same("an outline of no entries", none, &outline.to_json());
}

#[test]
fn hand_built_layouts_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let synthetic = golden["synthetic"].as_array().expect("synthetic");
    assert!(!synthetic.is_empty());
    for case in synthetic {
        let name = case["name"].as_str().expect("name");
        let layout = layout_of(&case["layout"]);
        searches_match(name, &layout, &case["searches"]);
        if let Some(tables) = case.get("tables") {
            assert_same(
                &format!("{name}: tables"),
                tables,
                &infer_pdf_tables(&layout).to_json(),
            );
        }
    }
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_analysis() {
    let path = twin::repo_root()
        .join("native/core/fixtures")
        .join(SET)
        .join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(
        printed.contains("golden.json"),
        "the recorder wrote nothing: {printed}"
    );
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
}
