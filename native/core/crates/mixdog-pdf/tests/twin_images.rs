//! Twin test `images`: pdf.js 6.4's image decoding (the recording `native/core/fixtures/office-images/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-images.mjs`) against `mixdog_pdf::image`. Each case is a
//! generated PDF whose page paints one or a few images; pdf.js gave, for every image the page paints, the object the
//! renderer receives (width, height, `ImageKind` and bytes) or none when it could not decode the image. This test
//! opens the same bytes, walks the operator list and decodes every image the way the recorder reduced pdf.js's.
//! Dimensions, kinds and the image-or-failure outcome are compared exactly, bytes exactly except where the case
//! names a `tolerance` (a DCT image: 2 levels; a lossy JPEG 2000 image: 1). Re-recording is `twin_live_images`
//! (ignored: it runs Node).

use mixdog_office_base::twin;
use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::image::{self, ImageData, StencilMask};
use mixdog_pdf::oplist::{self, Op};
use serde_json::Value;

const SET: &str = "office-images";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-images.mjs";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

/// What one painted image came to here, reduced to the recorder's shapes.
#[derive(Debug)]
enum Outcome {
    Solid,
    Failed,
    Image {
        width: usize,
        height: usize,
        kind: Option<u8>,
        interpolate: Option<bool>,
        data: Vec<u8>,
    },
}

fn from_image(result: Result<ImageData, mixdog_pdf::PdfError>) -> Outcome {
    match result {
        Ok(image) => Outcome::Image {
            width: image.width,
            height: image.height,
            kind: Some(image.kind as u8),
            interpolate: image.interpolate,
            data: image.data,
        },
        Err(_) => Outcome::Failed,
    }
}

/// What the recorder's `run` returns for one document, as ours: `(op, outcome)` per painted image in order.
fn replay(pdf: &[u8], inline: bool) -> Vec<(&'static str, Outcome)> {
    let document =
        Document::open(pdf.to_vec(), &OpenOptions::default()).expect("the generated PDF opens");
    let page = document.page(0).expect("page");
    let resources = page.resources(&document).expect("resources");
    let list = oplist::get_operator_list(&document, &page, None).expect("operator list");
    let xref = document.xref();
    let mut out = Vec::new();
    for op in list.ops() {
        match op {
            Op::PaintSolidColorImageMask => out.push(("solid", Outcome::Solid)),
            Op::PaintInlineImage(small) => {
                out.push((
                    "inline",
                    from_image(image::decode_small_inline_image(
                        xref,
                        Some(&*resources),
                        &small.source,
                    )),
                ));
            }
            Op::PaintImage(reference) => {
                let resources = if inline { Some(&*resources) } else { None };
                out.push((
                    "image",
                    from_image(image::decode_image(
                        xref,
                        resources,
                        &reference.source,
                        inline,
                    )),
                ));
            }
            Op::PaintImageMask(reference) => {
                let outcome = match image::decode_image_mask(xref, &reference.source) {
                    Ok(StencilMask::Mask(mask)) => Outcome::Image {
                        width: mask.width,
                        height: mask.height,
                        kind: None,
                        interpolate: mask.interpolate,
                        data: mask.data,
                    },
                    Ok(StencilMask::SingleOpaquePixel) => Outcome::Solid,
                    Err(_) => Outcome::Failed,
                };
                out.push(("mask", outcome));
            }
            _ => {}
        }
    }
    out
}

/// The first byte where the two differ by more than `tolerance`, as `(index, ours, theirs)`.
fn first_difference(ours: &[u8], theirs: &[u8], tolerance: u8) -> Option<(usize, u8, u8)> {
    ours.iter()
        .zip(theirs)
        .enumerate()
        .find(|(_, (a, b))| a.abs_diff(**b) > tolerance)
        .map(|(i, (a, b))| (i, *a, *b))
}

fn check(case: &str, expected: &Value, op: &str, outcome: &Outcome, tolerance: u8) {
    assert_eq!(
        expected["op"].as_str(),
        Some(op),
        "{case}: the kind of painting"
    );
    if expected["failed"].as_bool() == Some(true) {
        assert!(
            matches!(outcome, Outcome::Failed),
            "{case}: pdf.js could not decode the image but this reader did: {outcome:?}"
        );
        return;
    }
    if expected["op"].as_str() == Some("solid") {
        assert!(
            matches!(outcome, Outcome::Solid),
            "{case}: expected a solid fill"
        );
        return;
    }
    let Outcome::Image {
        width,
        height,
        kind,
        interpolate,
        data,
    } = outcome
    else {
        panic!("{case}: pdf.js decoded the image but this reader did not ({outcome:?})");
    };
    assert_eq!(
        Some(*width as u64),
        expected["width"].as_u64(),
        "{case}: width"
    );
    assert_eq!(
        Some(*height as u64),
        expected["height"].as_u64(),
        "{case}: height"
    );
    assert_eq!(
        kind.map(u64::from),
        expected["kind"].as_u64(),
        "{case}: kind"
    );
    assert_eq!(
        *interpolate,
        expected["interpolate"].as_bool(),
        "{case}: interpolate"
    );
    let recorded = unhex(expected["data"].as_str().expect("data"));
    assert_eq!(data.len(), recorded.len(), "{case}: byte count");
    if let Some((at, ours, theirs)) = first_difference(data, &recorded, tolerance) {
        panic!("{case}: byte {at} is {ours}, pdf.js has {theirs} (tolerance {tolerance})");
    }
}

#[test]
fn every_recorded_image_decodes_as_pdfjs_decodes_it() {
    let golden = twin::load_golden(SET);
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 100, "the recording has {} cases", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let tolerance =
            u8::try_from(case["tolerance"].as_u64().expect("tolerance")).expect("small tolerance");
        let expected = case["images"].as_array().expect("images");
        let pdf = unhex(case["pdf"].as_str().expect("pdf"));
        let ours = replay(&pdf, case["inline"].as_bool().unwrap_or(false));
        assert_eq!(
            ours.len(),
            expected.len(),
            "{name}: how many images the page paints"
        );
        for (index, ((op, outcome), recorded)) in ours.iter().zip(expected).enumerate() {
            check(
                &format!("{name}[{index}]"),
                recorded,
                op,
                outcome,
                tolerance,
            );
        }
    }
}

#[test]
fn the_products_own_configuration_decodes_no_wasm_codec() {
    // Without a `wasmUrl` pdf.js cannot load the JBIG2, CCITT and JPEG 2000 modules: the recording says every
    // such image fails there. The reader here decodes them (the reference above is pdf.js with the modules), which
    // is why the first case of each codec is recorded both ways.
    let golden = twin::load_golden(SET);
    let without = golden["withoutWasm"].as_array().expect("withoutWasm");
    assert!(!without.is_empty());
    for entry in without {
        for image in entry["images"].as_array().expect("images") {
            assert_eq!(
                image["failed"].as_bool(),
                Some(true),
                "{}: pdf.js without wasm",
                entry["name"]
            );
        }
    }
}

/// Re-records with Node and compares: runs `node` on this machine (the tree named by `MIXDOG_NODE_TREE`, else this
/// checkout), so it is ignored by default.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_images() {
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
