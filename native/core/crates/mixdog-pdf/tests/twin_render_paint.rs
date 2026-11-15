//! Twin test `render_paint`: the paint stage of the page rasteriser against pdf.js 6.4.299 drawing on `@napi-rs/canvas`
//! (`native/core/fixtures/office-render-paint/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-render-paint.mjs`). Each case is a generated one-page PDF: shadings of
//! types 1 to 7 by `sh` and as pattern colours, tiling patterns, constant alpha, blend modes, transparency groups and
//! soft masks (no text: the glyph outlines are the font bridge's, and Type3 glyph procedures are covered by the unit
//! tests of the crate). The Rust rasteriser opens the same bytes and must give a canvas of exactly the recorded size whose
//! pixels are within the recorded tolerance plus the allowance written below for the kind of case: no channel more than
//! `max` away, and a mean difference per channel of at most `mean` over the page.
//!
//! The allowances are the part of the difference the two canvases are expected to disagree about and nothing else: a
//! gradient is a list of at most 840 colour stops that each canvas interpolates and quantises its own way (banding), the
//! edges of a mesh triangle are scan-converted into an image that is sampled again, and the blend modes are computed in
//! different arithmetic. They were chosen from the nature of each kind and have not been tightened by measuring.
//!
//! The test measures every render before it decides and, for a render outside the tolerance, writes a per-page diff
//! image (the absolute difference of the channels, in grey, 255 where the sizes differ) to the target directory
//! (`render-paint-diff/<case>-<scale>.png`) and names it in the failure. Re-recording is `twin_live_render_paint`
//! (ignored: it runs Node).

use std::path::PathBuf;

use mixdog_office_base::twin;
use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::render::{RenderOptions, render_page};
use mixdog_raster::Image;
use serde_json::Value;

const SET: &str = "office-render-paint";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-render-paint.mjs";

/// What a kind of case may differ by on top of the recording's tolerance: `(name prefix, largest channel, mean)`. The
/// first entry whose prefix starts the case's name applies.
const ALLOWANCES: &[(&str, u8, f64)] = &[
    // Gradient banding.
    ("sh-axial", 8, 0.6),
    ("sh-radial", 8, 0.6),
    ("pattern-axial", 8, 0.6),
    ("pattern-radial", 8, 0.6),
    // The edges of triangles, and the mesh image sampled again.
    ("sh-mesh", 24, 1.5),
    ("sh-function-based", 24, 1.5),
    ("pattern-mesh", 24, 1.5),
    ("pattern-function-based", 24, 1.5),
    // The tile image sampled again at the scale of the page.
    ("tiling", 8, 0.8),
    // Blend arithmetic, and layers rounded where they are merged.
    ("blend", 6, 0.5),
    ("group", 8, 0.5),
    ("smask", 8, 0.5),
    ("constant-alpha", 4, 0.3),
];

fn allowance(name: &str) -> (u8, f64) {
    ALLOWANCES
        .iter()
        .find(|(prefix, _, _)| name.starts_with(prefix))
        .map_or((0, 0.0), |(_, max, mean)| (*max, *mean))
}

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
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("render-paint-diff")
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
        let (extra_max, extra_mean) = allowance(name);
        let allowed_max = tolerance_max.saturating_add(extra_max);
        let allowed_mean = tolerance_mean + extra_mean;
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
            if difference.max > allowed_max || difference.mean > allowed_mean {
                let diff = write_diff(name, scale, want_width, want_height, &pixels, theirs.rgba());
                failures.push(format!(
                    "{name} at {scale}: largest {} (allowed {allowed_max}), mean {:.4} (allowed {allowed_mean:.4}); diff image {}",
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
fn twin_render_paint() {
    replay(&twin::load_golden(SET));
}

/// Every kind of case the allowances name is in the recording, and every case has a kind.
#[test]
fn the_allowances_match_the_recorded_cases() {
    let golden = twin::load_golden(SET);
    let names: Vec<&str> = golden["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| case["name"].as_str().expect("name"))
        .collect();
    for (prefix, _, _) in ALLOWANCES {
        assert!(names.iter().any(|name| name.starts_with(prefix)), "no case starts with {prefix}");
    }
    for name in &names {
        assert!(ALLOWANCES.iter().any(|(prefix, _, _)| name.starts_with(prefix)), "{name} has no allowance");
    }
}

/// Records again with Node (`MIXDOG_BENCH_TREE=<product tree with node_modules>`) and replays the new recording.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_render_paint() {
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
