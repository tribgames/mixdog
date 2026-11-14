//! The Rust still renditions against what the Node product wrote for the same images (`fixtures/image-still`,
//! recorded by `benchmarks/rust-core/recorders/record-image-still.mjs` from `ensureRendition` of `renditions.mjs` and
//! `resizeImageBuffer`, both over sharp).
//!
//! For every still case (both variants of every input): the class (a rendition, or none for a source that does not
//! decode), the output dimensions, the extension (`.webp`), whether the output has an alpha channel, and the decoded
//! pixels (a 32x32 area-averaged thumbnail at PSNR 36 dB or better) are equal or close. For every WebP input
//! `image.resize` re-encodes: the mime type, the sizes, whether the bytes come back untouched, and the same pixels.
//!
//! Not compared: the pixels of a CMYK JPEG with no ICC profile (libvips converts it through a built-in profile no Rust
//! crate carries), and the SVG bytes, which sharp renders and the decoder answers as unsupported by owner decision.

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_imaging::DECODE_PIXEL_LIMIT;
use mixdog_imaging::Format;
use mixdog_imaging::ResizeOptions;
use mixdog_imaging::decode;
use mixdog_imaging::resize_image_buffer;
use mixdog_imaging::still::encode_still;
use mixdog_imaging::still::rendition_spec;
use serde_json::Value;

const THUMB: usize = 32;
const MIN_PSNR: f64 = 36.0;

/// Inputs whose pixels are not compared, each with the reason (see the module documentation).
const PIXEL_APPROXIMATE: &[&str] = &["fmt-jpegCmykNoProfile"];

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/image-still")
}

fn corpus() -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(fixtures().join("corpus.json"))).expect("the corpus parses")
}

fn input(name: &str) -> Vec<u8> {
    mixdog_testkit::read(fixtures().join("inputs").join(format!("{name}.bin")))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn number(value: &Value, key: &str) -> u32 {
    u32::try_from(value[key].as_u64().unwrap_or_else(|| panic!("{key} is not a number in {value}"))).expect("fits")
}

/// The mean of every cell of a 32x32 grid over RGBA pixels, rounded: the rule the recorder uses.
fn thumbnail(rgba: &[u8], width: u32, height: u32) -> Vec<f64> {
    let (w, h) = (width as usize, height as usize);
    let mut out = vec![0f64; THUMB * THUMB * 4];
    for cy in 0..THUMB {
        let y0 = cy * h / THUMB;
        let y1 = h.min(((cy + 1) * h / THUMB).max(y0 + 1));
        for cx in 0..THUMB {
            let x0 = cx * w / THUMB;
            let x1 = w.min(((cx + 1) * w / THUMB).max(x0 + 1));
            let mut sums = [0f64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    let at = (y * w + x) * 4;
                    for (channel, sum) in sums.iter_mut().enumerate() {
                        *sum += f64::from(rgba[at + channel]);
                    }
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as f64;
            for (channel, sum) in sums.iter().enumerate() {
                out[(cy * THUMB + cx) * 4 + channel] = (sum / count).round();
            }
        }
    }
    out
}

fn psnr(ours: &[f64], recorded: &str) -> f64 {
    let theirs = STANDARD.decode(recorded).expect("the thumbnail is base64");
    assert_eq!(theirs.len(), ours.len(), "the thumbnail size");
    let squares: f64 = ours.iter().zip(&theirs).map(|(a, b)| (a - f64::from(*b)).powi(2)).sum();
    let mse = squares / ours.len() as f64;
    if mse == 0.0 { f64::INFINITY } else { 10.0 * (255.0f64 * 255.0 / mse).log10() }
}

/// Our decode of an output image against sharp's recorded decode of sharp's output for the same call.
fn check_pixels(name: &str, ours: &[u8], recorded: &Value, compare_pixels: bool) -> Result<(), String> {
    let decoded = decode(ours, DECODE_PIXEL_LIMIT).map_err(|error| format!("{name}: the output does not decode: {error}"))?;
    if decoded.format != Format::Webp {
        return Err(format!("{name}: the output is {:?}, not WebP", decoded.format));
    }
    let (width, height) = (number(recorded, "width"), number(recorded, "height"));
    if (decoded.width, decoded.height) != (width, height) {
        return Err(format!("{name}: the output is {}x{}, sharp's {width}x{height}", decoded.width, decoded.height));
    }
    if decoded.raster.has_alpha != recorded["hasAlpha"].as_bool().unwrap_or_default() {
        return Err(format!("{name}: alpha is {}, sharp's {}", decoded.raster.has_alpha, recorded["hasAlpha"]));
    }
    if !compare_pixels {
        return Ok(());
    }
    let psnr = psnr(&thumbnail(&decoded.raster.to_rgba(), width, height), text(recorded, "thumbnail"));
    if psnr < MIN_PSNR { Err(format!("{name}: pixels differ (PSNR {psnr:.1} dB)")) } else { Ok(()) }
}

fn still_case(case: &Value) -> Result<(), String> {
    let name = text(case, "name");
    let input_name = text(case, "input");
    let spec = rendition_spec(text(case, "variant")).ok_or_else(|| format!("{name}: no such variant"))?;
    if (spec.max_edge, u32::from(spec.quality)) != (number(case, "maxEdge"), number(case, "quality")) {
        return Err(format!("{name}: the spec is {spec:?}, Node's {} at {}", case["maxEdge"], case["quality"]));
    }
    let got = encode_still(&input(input_name), spec);
    let expect = &case["expect"];
    if case["divergence"] == "avif-svg" {
        return if got.is_none() { Ok(()) } else { Err(format!("{name}: an AVIF or SVG input was taken")) };
    }
    match (text(expect, "class"), got) {
        ("none", None) => Ok(()),
        ("ok", Some(still)) => {
            if still.extension != text(expect, "extension") {
                return Err(format!("{name}: extension {}, Node's {}", still.extension, text(expect, "extension")));
            }
            check_pixels(name, &still.data, &expect["pixels"], !PIXEL_APPROXIMATE.contains(&input_name))
        }
        (class, got) => Err(format!("{name}: Node's class {class}, got {:?}", got.map(|still| still.data.len()))),
    }
}

fn resize_case(case: &Value) -> Result<(), String> {
    let name = text(case, "name");
    let bytes = input(text(case, "input"));
    let expect = &case["expect"];
    let resized = resize_image_buffer(&bytes, text(case, "ext"), ResizeOptions::default())
        .map_err(|error| format!("{name}: {error}"))?
        .ok_or_else(|| format!("{name}: nothing came back"))?;
    let dims = resized.dimensions;
    let want = [number(expect, "originalWidth"), number(expect, "originalHeight"), number(expect, "displayWidth"), number(expect, "displayHeight")];
    let have = [dims.original_width, dims.original_height, dims.display_width, dims.display_height];
    if have != want {
        return Err(format!("{name}: dimensions {have:?}, sharp's {want:?}"));
    }
    if resized.mime != text(expect, "mime") {
        return Err(format!("{name}: mime {}, sharp's {}", resized.mime, text(expect, "mime")));
    }
    let untouched = resized.data == bytes;
    if untouched != expect["original"].as_bool().unwrap_or_default() {
        return Err(format!("{name}: untouched is {untouched}, sharp's {}", expect["original"]));
    }
    check_pixels(name, &resized.data, &expect["pixels"], true)
}

#[test]
fn every_still_case_matches_what_node_wrote() {
    let corpus = corpus();
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in corpus["cases"].as_array().expect("cases") {
        let result = match text(case, "op") {
            "still" => still_case(case),
            "resize" => resize_case(case),
            other => Err(format!("{}: unknown op {other}", text(case, "name"))),
        };
        checked += 1;
        if let Err(message) = result {
            failures.push(message);
        }
    }
    assert!(checked >= 80, "only {checked} cases");
    assert!(failures.is_empty(), "{} of {checked} cases differ:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn the_corpus_covers_what_the_task_names() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    let inputs: std::collections::BTreeSet<&str> = cases.iter().map(|case| text(case, "input")).collect();
    assert!(inputs.len() >= 40, "only {} inputs", inputs.len());
    for orientation in 1..=8 {
        assert!(inputs.contains(format!("exif{orientation}").as_str()), "EXIF orientation {orientation}");
    }
    for needed in ["fmt-pngAlpha", "fmt-webpAlpha", "fmt-gifAnimated", "fmt-webpAnimated", "huge-5000x4000", "size-1x1", "fmt-jpegCmyk", "bad-junk"] {
        assert!(inputs.contains(needed), "{needed}");
    }
    let classes: std::collections::BTreeSet<&str> = cases.iter().map(|case| text(&case["expect"], "class")).collect();
    assert_eq!(classes.into_iter().collect::<Vec<_>>(), ["none", "ok"]);
    assert!(cases.iter().any(|case| text(case, "op") == "resize"), "the image.resize WebP cases");
}
