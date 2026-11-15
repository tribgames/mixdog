//! Twin test `render_core`: the page rasteriser against pdf.js 6.4.299 drawing on `@napi-rs/canvas`
//! (`native/core/fixtures/office-render-core/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-render-core.mjs`). Each case is a generated one-page PDF (fills, strokes
//! with every line state and dash, clipping, images and image masks, forms, optional content, page rotation and crop
//! boxes; no text, shading, pattern or transparency: those belong to the font bridge and the paint stage) drawn by
//! pdf.js at one or more scales. The Rust rasteriser opens the same bytes and must give a canvas of exactly the recorded
//! size whose pixels are within the recorded tolerance: no channel more than `max` away (anti-aliased edges), and a mean
//! difference per channel of at most `mean` over the page.
//!
//! The test measures every render before it decides and, for a render outside the tolerance, writes a per-page diff
//! image (the absolute difference of the channels, in grey, 255 where the sizes differ) to the target directory
//! (`render-core-diff/<case>-<scale>.png`) and names it in the failure. Re-recording is `twin_live_render_core`
//! (ignored: it runs Node).

use std::path::PathBuf;

use mixdog_office_base::twin;
use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::render::{RenderOptions, render_page};
use mixdog_raster::Image;
use serde_json::Value;

const SET: &str = "office-render-core";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-render-core.mjs";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

/// How far the Rust page is from the recorded one: the largest channel difference and the mean over every channel.
struct Difference {
    max: u8,
    mean: f64,
}

fn compare(ours: &[u8], theirs: &[u8]) -> Difference {
    let mut max = 0u8;
    let mut sum = 0u64;
    for (a, b) in ours.iter().zip(theirs) {
        let d = a.abs_diff(*b);
        max = max.max(d);
        sum += u64::from(d);
    }
    Difference {
        max,
        mean: sum as f64 / ours.len().max(1) as f64,
    }
}

fn diff_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("render-core-diff")
}

/// The diff image of a render that is outside the tolerance, written where the failure says; its path.
fn write_diff(name: &str, scale: f64, width: u32, height: u32, ours: &[u8], theirs: &[u8]) -> PathBuf {
    let mut grey = Vec::with_capacity(ours.len());
    for (a, b) in ours.chunks_exact(4).zip(theirs.chunks_exact(4)) {
        let d = (0..3).map(|i| a[i].abs_diff(b[i])).max().unwrap_or(0);
        grey.extend_from_slice(&[d, d, d, 255]);
    }
    grey.resize((width * height * 4) as usize, 255);
    let png = Image::from_raw(width, height, 4, &grey)
        .and_then(|image| image.to_png())
        .expect("the diff image encodes");
    let path = diff_directory().join(format!("{name}-{scale}.png"));
    mixdog_testkit::create_dir_all(diff_directory());
    mixdog_testkit::write(&path, png);
    path
}

fn replay(golden: &Value) {
    let tolerance_max = golden["tolerance"]["max"].as_u64().expect("tolerance.max") as u8;
    let tolerance_mean = golden["tolerance"]["mean"].as_f64().expect("tolerance.mean");
    let mut failures = Vec::new();
    let mut rendered = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let pdf = unhex(case["pdf"].as_str().expect("pdf"));
        let document =
            Document::open(pdf, &OpenOptions::default()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let page = document.page(0).unwrap_or_else(|e| panic!("{name}: {e}"));
        for recorded in case["renders"].as_array().expect("renders") {
            let scale = recorded["scale"].as_f64().expect("scale");
            let options = RenderOptions {
                scale,
                fonts: None,
                drawing: None,
            };
            let ours = render_page(&document, &page, &options)
                .unwrap_or_else(|e| panic!("{name} at {scale}: {e}"));
            let want_width = recorded["width"].as_u64().expect("width") as u32;
            let want_height = recorded["height"].as_u64().expect("height") as u32;
            rendered += 1;
            assert_eq!(
                (ours.width(), ours.height()),
                (want_width, want_height),
                "{name} at {scale}: the size of the image"
            );
            let theirs = Image::decode(&unhex(recorded["png"].as_str().expect("png")))
                .unwrap_or_else(|e| panic!("{name} at {scale}: the recorded PNG: {e}"));
            assert_eq!(
                (theirs.width(), theirs.height()),
                (want_width, want_height),
                "{name} at {scale}: the recorded PNG is the recorded size"
            );
            let pixels = ours.rgba().expect("pixels");
            let difference = compare(&pixels, theirs.rgba());
            eprintln!(
                "{name} at {scale}: largest {} mean {:.4}",
                difference.max, difference.mean
            );
            if difference.max > tolerance_max || difference.mean > tolerance_mean {
                let diff = write_diff(name, scale, want_width, want_height, &pixels, theirs.rgba());
                failures.push(format!(
                    "{name} at {scale}: largest {} (allowed {tolerance_max}), mean {:.4} (allowed {tolerance_mean}); diff image {}",
                    difference.max,
                    difference.mean,
                    diff.display()
                ));
            }
        }
    }
    assert!(rendered > 0, "the recording holds no render");
    assert!(
        failures.is_empty(),
        "renders outside the tolerance:\n{}",
        failures.join("\n")
    );
}

#[test]
fn twin_render_core() {
    replay(&twin::load_golden(SET));
}

/// Records again with Node (`MIXDOG_BENCH_TREE=<product tree with node_modules>`) and replays the new recording.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_render_core() {
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
    replay(&twin::load_golden(SET));
}
