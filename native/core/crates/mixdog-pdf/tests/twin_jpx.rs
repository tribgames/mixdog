//! Twin test `jpx`: the recording of pdf.js 6.4.299's `JpxImage` (OpenJPEG as compiled into `wasm/openjpeg.wasm`)
//! decoding the corpus of `record-office-jpx.mjs` (`native/core/fixtures/office-jpx`), written by
//! `record-office-jpx-pixels.mjs` (`native/core/fixtures/office-jpx-pixels/pixels.json`), against
//! `mixdog_pdf::codec::jpx::output`. Per case the dimensions, the component count and the delivered byte count must
//! equal the recording; the samples of a stream coded only with the reversible transform must equal it exactly, those
//! of a stream with an irreversible tile-component may differ by one level.
//!
//! The Node configuration the application runs pdf.js in cannot load `openjpeg.wasm` (no `wasmUrl`), so the recorder
//! loads it explicitly. Re-recording is `twin_live_jpx` (ignored: it runs Node).

use std::path::PathBuf;

use mixdog_office_base::twin;
use mixdog_pdf::codec::jpx::output::{self, Options};
use mixdog_pdf::codec::jpx::{self, Image};
use serde_json::Value;

const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-jpx-pixels.mjs";

fn fixtures() -> PathBuf {
    twin::repo_root().join("native/core/fixtures")
}

fn json(path: PathBuf) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("fixture parses")
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

/// True when every tile-component of every tile is coded with the reversible 5/3 transform.
fn lossless(image: &Image) -> bool {
    let cs = &image.codestream;
    (0..cs.tile_count()).all(|t| {
        let params = cs.tile_params(t).unwrap_or(&cs.main);
        params.comps.iter().all(|c| c.coding.reversible)
    })
}

fn every_output_equals_the_recording() {
    let expected = json(fixtures().join("office-jpx/expected.json"));
    let recorded = json(fixtures().join("office-jpx-pixels/pixels.json"));
    let cases = expected["cases"].as_object().expect("cases");
    assert_eq!(cases.len(), recorded["cases"].as_object().expect("recorded cases").len(), "case count");
    for (name, case) in cases {
        let rec = &recorded["cases"][name];
        let numcomps = rec["numComponents"].as_u64().expect("numComponents") as usize;
        let bytes = mixdog_testkit::read(fixtures().join("office-jpx").join(case["file"].as_str().unwrap()));
        let image = jpx::parse(&bytes).unwrap_or_else(|e| panic!("{name}: parse: {e}"));
        let decoded = output::decode(&image, Options::default());
        if let Some(message) = rec["error"].as_str() {
            assert!(decoded.is_err(), "{name}: the recording failed with {message}");
            continue;
        }
        let decoded = decoded.unwrap_or_else(|e| panic!("{name}: decode: {e}"));
        let props = &case["openjpeg"]["properties"];
        assert_eq!(decoded.width() as u64, props["width"].as_u64().unwrap(), "{name}: width");
        assert_eq!(decoded.height() as u64, props["height"].as_u64().unwrap(), "{name}: height");
        // `parseImageProperties` reads the codestream: its component count is the codestream's, before any palette.
        assert_eq!(image.codestream.siz.comps.len() as u64, props["componentsCount"].as_u64().unwrap(), "{name}: components");
        let pixels = decoded.to_pixels(numcomps);
        let want = unhex(rec["pixels"].as_str().expect("pixels"));
        assert_eq!(pixels.data.len(), want.len(), "{name}: delivered bytes");
        assert_eq!(pixels.data.len() as u64, case["openjpeg"]["pixelBytes"].as_u64().unwrap(), "{name}: pixelBytes");
        let tolerance = if lossless(&image) { 0 } else { 1 };
        // The wrapper hands each component's plane at its own size, one sample per pixel in reading order, and reads
        // past the end of a plane smaller than the first (heap bytes, not a behaviour). Such a component is checked
        // on the samples the recording defines: the plane read back from its prefix, expanded onto the first grid.
        let first = &decoded.planes[0];
        let grids_differ = decoded.planes.iter().take(numcomps).any(|p| (p.dx, p.dy) != (first.dx, first.dy));
        if grids_differ {
            let (w, h) = (first.width as usize, first.height as usize);
            for (c, plane) in decoded.planes.iter().take(numcomps).enumerate() {
                assert_eq!(plane.precision, 8, "{name}: precision");
                let (pw, ph) = (plane.width as usize, plane.height as usize);
                for j in 0..h {
                    for i in 0..w {
                        // The first component's grid position, on this component's grid, relative to its origin.
                        let gx = (first.x0 as usize + i) * first.dx as usize / plane.dx as usize;
                        let gy = (first.y0 as usize + j) * first.dy as usize / plane.dy as usize;
                        let x = gx.saturating_sub(plane.x0 as usize).min(pw - 1);
                        let y = gy.saturating_sub(plane.y0 as usize).min(ph - 1);
                        let got = pixels.data[(j * w + i) * numcomps + c];
                        let wanted = want[(y * pw + x) * numcomps + c];
                        assert!(got.abs_diff(wanted) <= tolerance, "{name}: component {c} pixel ({i}, {j}): got {got}, recorded {wanted}");
                    }
                }
            }
            continue;
        }
        let worst = pixels.data.iter().zip(&want).enumerate().max_by_key(|(_, (g, w))| g.abs_diff(**w));
        if let Some((at, (got, wanted))) = worst {
            assert!(got.abs_diff(*wanted) <= tolerance, "{name}: sample {at}: got {got}, recorded {wanted}");
        }
    }
}

#[test]
fn every_output_matches_the_recording() {
    every_output_equals_the_recording();
}

#[test]
fn a_palette_image_decoded_without_the_palette_keeps_its_indices() {
    let expected = json(fixtures().join("office-jpx/expected.json"));
    let file = expected["cases"]["jp2-palette-xl"]["file"].as_str().unwrap();
    let bytes = mixdog_testkit::read(fixtures().join("office-jpx").join(file));
    let image = jpx::parse(&bytes).expect("parses");
    let indexed = output::decode(&image, Options { ignore_palette: true }).expect("decodes");
    assert_eq!(indexed.component_count(), 1);
    let mapped = output::decode(&image, Options::default()).expect("decodes");
    assert_eq!(mapped.component_count(), 3);
}

/// Records again with Node and compares: `cargo test -p mixdog-pdf --test twin_jpx -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdfjs-dist's openjpeg.wasm)"]
fn twin_live_jpx() {
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("wrote 1 files"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
