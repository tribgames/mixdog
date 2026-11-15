//! Twin test `render_paint`: the paint stage of the page rasteriser against pdf.js 6.4.299 drawing on `@napi-rs/canvas`
//! (`native/core/fixtures/office-render-paint/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-render-paint.mjs`). Each case is a generated one-page PDF: shadings of
//! types 1 to 7 by `sh` and as pattern colours, tiling patterns, constant alpha, blend modes, transparency groups and
//! soft masks (no text: the glyph outlines are the font bridge's, and Type3 glyph procedures are covered by the unit
//! tests of the crate). The Rust rasteriser opens the same bytes and must give a canvas of exactly the recorded size which is
//! the same picture as the recorded one by the shared rule of `mixdog_office_base::twin::pixels` (owner decision 2026-11-16: the
//! two canvases anti-alias an edge, ramp a gradient, scan-convert a mesh triangle and blend in their own arithmetic): equal
//! sizes, a mean difference per channel of at most 1 of 255 over the page, and no channel of any 4x4 block average more than 24
//! away. The `tolerance` the recording carries and the per-kind allowances this test once held are not used.
//!
//! The test measures every render before it decides and, for a render outside the tolerance, writes a per-page diff
//! image (the absolute difference of the channels, in grey, 255 where the sizes differ) to the target directory
//! (`render-paint-diff/<case>-<scale>.png`) and names it in the failure. Re-recording is `twin_live_render_paint`
//! (ignored: it runs Node).

use std::path::PathBuf;

use mixdog_office_base::twin;
use mixdog_office_base::twin::pixels::{self, Picture};
use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::render::{RenderOptions, render_page};
use mixdog_raster::Image;
use serde_json::Value;

const SET: &str = "office-render-paint";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-render-paint.mjs";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
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
            let comparison = pixels::compare(Picture::new(want_width, want_height, &pixels), Picture::new(want_width, want_height, theirs.rgba()));
            eprintln!("{name} at {scale}: {}", comparison.summary());
            if let Err(why) = comparison.verdict() {
                let diff = write_diff(name, scale, want_width, want_height, &pixels, theirs.rgba());
                failures.push(format!("{name} at {scale}: {why}; diff image {}", diff.display()));
            }
        }
    }
    assert!(rendered > 0, "the recording holds no render");
    assert!(
        failures.is_empty(),
        "renders that are not the recorded picture:\n{}",
        failures.join("\n")
    );
}

#[test]
fn twin_render_paint() {
    replay(&twin::load_golden(SET));
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
