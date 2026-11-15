//! The Rust codec against what sharp (libvips) answered to the same calls (`fixtures/image-codec`, recorded by
//! `benchmarks/rust-core/recorders/record-image-codec.mjs` from the Node product's own code and sharp).
//!
//! For every probe / jpeg / validate / resize case: the class (ok, invalid, environment, none), the mime type, the
//! original and display dimensions and the branch of `resizeImageBuffer` (the original bytes, a plain rendition, the
//! JPEG q50 token gate, the 400x400 q20 fallback) are equal; the decoded pixels of the output are close (a 32x32
//! area-averaged thumbnail at PSNR 38 dB or better and a mean absolute difference of 2.0 or less); a JPEG's size is
//! within 15 percent. It also replays the composer's resize and the tool-result compaction goldens of
//! `mixdog-exthost`, and the two 64x48 gradients its pool test uses.
//!
//! What is not compared, and why, is listed in [`PIXEL_APPROXIMATE`].

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_imaging::Branch;
use mixdog_imaging::DECODE_PIXEL_LIMIT;
use mixdog_imaging::ErrorClass;
use mixdog_imaging::ImagingError;
use mixdog_imaging::Profile;
use mixdog_imaging::ResizeOptions;
use mixdog_imaging::compact_tool_result_image;
use mixdog_imaging::decode;
use mixdog_imaging::encode_tool_image_jpeg;
use mixdog_imaging::image_profile_for_provider;
use mixdog_imaging::probe;
use mixdog_imaging::resize_image_buffer;
use mixdog_imaging::validate;
use serde_json::Value;

const THUMB: usize = 32;
const MIN_PSNR: f64 = 38.0;
const MAX_MEAN_ABSOLUTE_DIFFERENCE: f64 = 2.0;
/// A JPEG's size may differ from libjpeg's by this share (or 200 bytes, whichever is more).
const JPEG_SIZE_TOLERANCE: f64 = 0.15;

/// Cases whose pixels are not compared, each with the reason. Class, mime, dimensions and branch still are.
const PIXEL_APPROXIMATE: &[(&str, &str)] = &[(
    "format jpegCmykNoProfile",
    "a CMYK JPEG with no ICC profile: libvips converts it through its built-in CMYK profile, which no Rust crate carries; the decoder converts it with the plain inverse-ink rule",
)];

fn manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn fixtures() -> PathBuf {
    manifest_dir().join("../../fixtures")
}

fn corpus() -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(fixtures().join("image-codec/corpus.json"))).expect("the corpus parses")
}

fn input(name: &str) -> Vec<u8> {
    mixdog_testkit::read(fixtures().join("image-codec/inputs").join(format!("{name}.bin")))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn number(value: &Value, key: &str) -> u32 {
    u32::try_from(value[key].as_u64().unwrap_or_else(|| panic!("{key} is not a number in {value}"))).expect("fits")
}

fn branch_name(branch: Branch) -> &'static str {
    match branch {
        Branch::Original => "original",
        Branch::Rendition => "rendition",
        Branch::TokenJpeg => "token-jpeg",
        Branch::TokenFallback => "token-fallback",
    }
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

/// `(psnr, mean absolute difference)` between our thumbnail and the recorded one (base64 of 32x32 RGBA bytes).
fn closeness(ours: &[f64], recorded: &str) -> (f64, f64) {
    closeness_to(ours, &STANDARD.decode(recorded).expect("the thumbnail is base64"))
}

/// The same against a thumbnail of bytes.
fn closeness_to(ours: &[f64], theirs: &[u8]) -> (f64, f64) {
    assert_eq!(theirs.len(), ours.len(), "the thumbnail size");
    let (mut squares, mut absolute) = (0f64, 0f64);
    for (a, b) in ours.iter().zip(theirs) {
        let difference = a - f64::from(*b);
        squares += difference * difference;
        absolute += difference.abs();
    }
    let count = ours.len() as f64;
    let mse = squares / count;
    let psnr = if mse == 0.0 { f64::INFINITY } else { 10.0 * (255.0f64 * 255.0 / mse).log10() };
    (psnr, absolute / count)
}

/// Our decode of an output image against sharp's recorded pixels of the same output.
fn check_pixels(name: &str, ours: &[u8], recorded: &Value) -> Result<(), String> {
    let decoded = decode(ours, DECODE_PIXEL_LIMIT).map_err(|error| format!("{name}: the output does not decode: {error}"))?;
    let (width, height) = (number(recorded, "width"), number(recorded, "height"));
    if (decoded.width, decoded.height) != (width, height) {
        return Err(format!("{name}: the output is {}x{}, sharp's {width}x{height}", decoded.width, decoded.height));
    }
    let (psnr, mad) = closeness(&thumbnail(&decoded.raster.to_rgba(), width, height), text(recorded, "thumbnail"));
    if psnr < MIN_PSNR || mad > MAX_MEAN_ABSOLUTE_DIFFERENCE {
        return Err(format!("{name}: pixels differ (PSNR {psnr:.1} dB, mean difference {mad:.2})"));
    }
    Ok(())
}

fn check_jpeg_size(name: &str, ours: usize, theirs: u64) -> Result<(), String> {
    let theirs = theirs as f64;
    let allowed = (theirs * JPEG_SIZE_TOLERANCE).max(200.0);
    if (ours as f64 - theirs).abs() > allowed { Err(format!("{name}: the JPEG is {ours} bytes, sharp's {theirs}")) } else { Ok(()) }
}

/// The libvips wording is kept per class of failure: the sentence is equal, or at least of the same class.
fn sentence_class(sentence: &str) -> &str {
    [
        "unsupported image format",
        "exceeds pixel limit",
        "Input Buffer is empty",
        "libpng read error",
        "Input buffer has corrupt header",
        "VipsJpeg",
        "tiff2vips",
        "gifload",
        "webp",
    ]
    .into_iter()
    .find(|class| sentence.contains(class))
    .unwrap_or(sentence)
}

fn check_error(name: &str, expected: &Value, got: &ImagingError, wrapped: bool) -> Result<(), String> {
    let class = match text(expected, "class") {
        "environment" => ErrorClass::Environment,
        _ => ErrorClass::Invalid,
    };
    if got.class() != class {
        return Err(format!("{name}: class {:?}, sharp's {class:?} ({got})", got.class()));
    }
    let recorded = &expected["error"];
    let want = text(recorded, if wrapped { "message" } else { "sentence" });
    let ours = if wrapped { got.message() } else { got.sentence().to_owned() };
    let (want_line, our_line) = (want.lines().next().unwrap_or_default(), ours.lines().next().unwrap_or_default());
    if want_line != our_line && sentence_class(want_line) != sentence_class(our_line) {
        return Err(format!("{name}: the sentence is {our_line:?}, sharp's {want_line:?}"));
    }
    Ok(())
}

fn approximate(name: &str) -> bool {
    PIXEL_APPROXIMATE.iter().any(|(case, _)| *case == name)
}

fn resize_case(case: &Value) -> Result<(), String> {
    let name = text(case, "name");
    let bytes = input(text(case, "input"));
    let expect = &case["expect"];
    let options = ResizeOptions {
        profile: Profile::from_name(text(case, "profile")),
        max_tokens: case["maxTokens"].as_u64().unwrap_or(ResizeOptions::default().max_tokens),
    };
    let got = resize_image_buffer(&bytes, text(case, "ext"), options);
    match (text(expect, "class"), got) {
        ("none", Ok(None)) => Ok(()),
        ("ok", Ok(Some(resized))) => {
            let dims = resized.dimensions;
            let want = [number(expect, "originalWidth"), number(expect, "originalHeight"), number(expect, "displayWidth"), number(expect, "displayHeight")];
            let have = [dims.original_width, dims.original_height, dims.display_width, dims.display_height];
            if have != want {
                return Err(format!("{name}: dimensions {have:?}, sharp's {want:?}"));
            }
            if resized.mime != text(expect, "mime") {
                return Err(format!("{name}: mime {}, sharp's {}", resized.mime, text(expect, "mime")));
            }
            if branch_name(resized.branch) != text(expect, "branch") {
                return Err(format!("{name}: branch {}, sharp's {}", branch_name(resized.branch), text(expect, "branch")));
            }
            if resized.branch == Branch::Original {
                if resized.data != bytes {
                    return Err(format!("{name}: an image that fits must come back as its own bytes"));
                }
            } else if resized.mime == "image/jpeg" {
                check_jpeg_size(name, resized.data.len(), expect["byteLength"].as_u64().unwrap_or_default())?;
            }
            if approximate(name) {
                return Ok(());
            }
            check_pixels(name, &resized.data, &expect["pixels"])
        }
        ("invalid", Err(error)) => check_error(name, expect, &error, true),
        (class, got) => Err(format!("{name}: sharp's class {class}, got {got:?}")),
    }
}

fn probe_case(case: &Value) -> Result<(), String> {
    let name = text(case, "name");
    let bytes = input(text(case, "input"));
    let expect = &case["expect"];
    let got = probe(&bytes);
    match (text(expect, "class"), got) {
        ("ok", Ok((width, height))) => {
            let want = (number(expect, "width"), number(expect, "height"));
            if (width, height) == want { Ok(()) } else { Err(format!("{name}: {width}x{height}, sharp's {want:?}")) }
        }
        ("invalid" | "environment", Err(error)) => check_error(name, expect, &error, false),
        (class, got) => Err(format!("{name}: sharp's class {class}, got {got:?}")),
    }
}

fn validate_case(case: &Value) -> Result<(), String> {
    let name = text(case, "name");
    let bytes = input(text(case, "input"));
    let expect = &case["expect"];
    let got = validate(&bytes, text(case, "format"));
    match (text(expect, "class"), got) {
        ("ok", Ok(())) => Ok(()),
        ("environment", Err(error)) if error.is_environment() => Ok(()),
        ("invalid", Err(error)) => check_error(name, expect, &error, true),
        (class, got) => Err(format!("{name}: sharp's class {class}, got {got:?}")),
    }
}

fn jpeg_case(case: &Value) -> Result<(), String> {
    let name = text(case, "name");
    let bytes = input(text(case, "input"));
    let expect = &case["expect"];
    let params = &case["jpeg"];
    let got = encode_tool_image_jpeg(
        &bytes,
        number(params, "width"),
        number(params, "height"),
        params["allowEnlargement"].as_bool().unwrap_or_default(),
        u8::try_from(number(params, "quality")).expect("a quality"),
    );
    match (text(expect, "class"), got) {
        ("ok", Ok(encoded)) => {
            if (encoded.width, encoded.height) != (number(expect, "width"), number(expect, "height")) {
                return Err(format!("{name}: {}x{}, sharp's {}x{}", encoded.width, encoded.height, number(expect, "width"), number(expect, "height")));
            }
            check_jpeg_size(name, encoded.data.len(), expect["byteLength"].as_u64().unwrap_or_default())?;
            if approximate(name) {
                return Ok(());
            }
            check_pixels(name, &encoded.data, &expect["pixels"])
        }
        ("invalid", Err(error)) => check_error(name, expect, &error, false),
        (class, got) => Err(format!("{name}: sharp's class {class}, got {got:?}")),
    }
}

#[test]
fn the_corpus_is_recorded_and_complete() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(cases.len() >= 80, "{} cases", cases.len());
    for op in ["resize", "probe", "validate", "jpeg"] {
        assert!(cases.iter().any(|case| text(case, "op") == op), "no {op} case");
    }
    for branch in ["original", "rendition", "token-jpeg", "token-fallback"] {
        assert!(cases.iter().any(|case| case["expect"]["branch"] == branch), "no {branch} case");
    }
    for class in ["ok", "invalid", "environment", "none"] {
        assert!(cases.iter().any(|case| case["expect"]["class"] == class), "no {class} case");
    }
}

#[test]
fn every_probe_jpeg_validate_and_resize_call_equals_sharps() {
    let corpus = corpus();
    let (mut failures, mut compared) = (Vec::new(), 0);
    for case in corpus["cases"].as_array().expect("cases") {
        let outcome = match text(case, "op") {
            "resize" => resize_case(case),
            "probe" => probe_case(case),
            "validate" => validate_case(case),
            "jpeg" => jpeg_case(case),
            other => Err(format!("unknown op {other}")),
        };
        compared += 1;
        if let Err(message) = outcome {
            failures.push(message);
        }
    }
    assert!(failures.is_empty(), "{} of {compared} cases differ from sharp:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn the_exif_orientation_is_exposed_and_the_stored_size_is_not_rotated() {
    for orientation in 1..=8u8 {
        let decoded = decode(&input(&format!("fmt-jpegExif{orientation}")), DECODE_PIXEL_LIMIT).expect("decodes");
        assert_eq!((decoded.width, decoded.height), (96, 64), "orientation {orientation}");
        assert_eq!(decoded.orientation, orientation);
    }
    assert_eq!(decode(&input("fmt-jpeg"), DECODE_PIXEL_LIMIT).expect("decodes").orientation, 1);
}

#[test]
fn the_pixel_limit_is_sixty_four_mi_pixels_and_an_image_over_it_is_refused_before_it_is_read() {
    // The limit counts pixels: 8192 x 8192 is exactly 64 Mi, and 8200 x 8200 is over it.
    assert_eq!(DECODE_PIXEL_LIMIT, 8192 * 8192);
    let error = decode(&input("limit-png-8200x8200"), DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.sentence(), "Input image exceeds pixel limit");
    let error = decode(&input("limit-jpeg-8200x8200"), DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.sentence(), "Input image exceeds pixel limit");
}

// ---- the goldens of mixdog-exthost ---------------------------------------------------------------------------

fn golden(path: &str) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(fixtures().join(path))).expect("the golden parses")
}

#[test]
fn the_composer_resize_goldens_are_met_under_the_providers_profile() {
    let doc = golden("turn-ops/composer-image.json");
    // Every recorded provider maps to the profile Node's `imageProfileForProvider` gave it.
    for recorded in doc["profiles"].as_array().expect("profiles") {
        let provider = recorded["provider"].as_str();
        assert_eq!(image_profile_for_provider(provider), Profile::from_name(text(recorded, "profile")), "{provider:?}");
    }
    let profile_of = |provider: &str| {
        let recorded = doc["profiles"].as_array().expect("profiles").iter().find(|p| text(p, "provider") == provider).expect("a recorded provider");
        Profile::from_name(text(recorded, "profile"))
    };
    let mut compared = 0;
    for case in doc["resize"].as_array().expect("resize") {
        let name = text(case, "name");
        let recorded = &case["resizer"];
        if recorded.is_null() {
            continue;
        }
        let bytes = STANDARD.decode(text(&case["input"], "data")).expect("base64");
        let options = ResizeOptions { profile: profile_of(text(case, "provider")), ..ResizeOptions::default() };
        let got = resize_image_buffer(&bytes, text(case, "ext"), options);
        match (recorded.get("ok"), recorded.get("error"), got) {
            (Some(ok), _, Ok(Some(image))) => {
                assert_eq!(image.mime, text(ok, "mimeType"), "{name}: format");
                let dims = &ok["dimensions"];
                assert_eq!(
                    [image.dimensions.original_width, image.dimensions.original_height, image.dimensions.display_width, image.dimensions.display_height],
                    [number(dims, "originalWidth"), number(dims, "originalHeight"), number(dims, "displayWidth"), number(dims, "displayHeight")],
                    "{name}: dimensions"
                );
                let theirs = STANDARD.decode(text(ok, "data")).expect("base64");
                if image.data == bytes {
                    assert_eq!(theirs, bytes, "{name}: an image that fits is answered as its own bytes");
                } else {
                    let (a, b) = (decode(&image.data, DECODE_PIXEL_LIMIT).expect("ours decodes"), decode(&theirs, DECODE_PIXEL_LIMIT).expect("theirs decodes"));
                    assert_eq!((a.width, a.height), (b.width, b.height), "{name}");
                    let recorded: Vec<u8> = thumbnail(&b.raster.to_rgba(), b.width, b.height).iter().map(|v| *v as u8).collect();
                    let (psnr, mad) = closeness_to(&thumbnail(&a.raster.to_rgba(), a.width, a.height), &recorded);
                    assert!(psnr >= MIN_PSNR && mad <= MAX_MEAN_ABSOLUTE_DIFFERENCE, "{name}: PSNR {psnr:.1}, mean difference {mad:.2}");
                }
            }
            (_, Some(error), Err(got)) => assert_eq!(got.message(), text(error, "message"), "{name}: decoder sentence"),
            (_, _, other) => panic!("{name}: {other:?}"),
        }
        compared += 1;
    }
    assert!(compared >= 6, "the recorded composer cases were compared ({compared})");
}

#[test]
fn the_tool_result_compaction_golden_is_a_smaller_jpeg_of_the_same_size_and_picture() {
    let doc = golden("agent/compact/golden/image.json");
    let case = &doc["reencode"];
    let compacted = compact_tool_result_image(text(case, "data"), text(case, "mime")).expect("a large png is re-encoded");
    assert_eq!(compacted.mime, text(case, "outMime"));
    let side = |pair: &str, index: usize| u32::try_from(case[pair][index].as_u64().expect("a side")).expect("fits");
    assert_eq!(
        (compacted.dimensions.original_width, compacted.dimensions.original_height, compacted.dimensions.display_width, compacted.dimensions.display_height),
        (side("original", 0), side("original", 1), side("display", 0), side("display", 1))
    );
    let ours = STANDARD.decode(&compacted.data).expect("base64");
    let theirs = STANDARD.decode(text(case, "jpeg")).expect("base64");
    check_jpeg_size("compact", ours.len(), theirs.len() as u64).expect("the size");
    let (a, b) = (decode(&ours, DECODE_PIXEL_LIMIT).expect("ours decodes"), decode(&theirs, DECODE_PIXEL_LIMIT).expect("theirs decodes"));
    assert_eq!((a.width, a.height), (b.width, b.height));
    let recorded: Vec<u8> = thumbnail(&b.raster.to_rgba(), b.width, b.height).iter().map(|v| *v as u8).collect();
    let (psnr, mad) = closeness_to(&thumbnail(&a.raster.to_rgba(), a.width, a.height), &recorded);
    assert!(psnr >= MIN_PSNR && mad <= MAX_MEAN_ABSOLUTE_DIFFERENCE, "PSNR {psnr:.1}, mean difference {mad:.2}");
}

#[test]
fn the_pool_gradients_are_lifted_to_two_hundred_pixels_and_compacted() {
    let jpeg = mixdog_testkit::read(fixtures().join("../crates/mixdog-exthost/tests/fixtures/image/gradient.jpg"));
    let webp = mixdog_testkit::read(fixtures().join("../crates/mixdog-exthost/tests/fixtures/image/gradient.webp"));
    // The sub-patch jpeg is lifted to the 200 px floor in its own format (Node: 64x48 -> 267x200).
    let resized = resize_image_buffer(&jpeg, "jpeg", ResizeOptions::default()).expect("takes the jpeg").expect("an answer");
    assert_eq!(resized.mime, "image/jpeg");
    let dims = resized.dimensions;
    assert_eq!((dims.original_width, dims.original_height, dims.display_width, dims.display_height), (64, 48, 267, 200));
    // The compaction ops over both formats.
    for bytes in [&jpeg, &webp] {
        assert_eq!(probe(bytes), Ok((64, 48)));
    }
    assert_eq!(validate(&jpeg, "png"), Ok(()));
    let compacted = encode_tool_image_jpeg(&jpeg, 32, 24, false, 85).expect("encodes");
    assert_eq!((compacted.width, compacted.height), (32, 24));
    let compacted = encode_tool_image_jpeg(&webp, 32, 24, false, 85).expect("encodes");
    assert_eq!((compacted.width, compacted.height), (32, 24));
    let lifted = encode_tool_image_jpeg(&jpeg, 128, 96, true, 70).expect("encodes");
    assert_eq!((lifted.width, lifted.height), (128, 96));
    let held = encode_tool_image_jpeg(&jpeg, 128, 96, false, 70).expect("encodes");
    assert_eq!((held.width, held.height), (64, 48));
    assert_eq!(&lifted.data[..2], &[0xFF, 0xD8]);
    // Bytes no decoder takes are invalid for every op.
    let junk = b"not an image at all";
    assert_eq!(probe(junk).unwrap_err().class(), ErrorClass::Invalid);
    assert_eq!(validate(junk, "png").unwrap_err().class(), ErrorClass::Invalid);
    assert_eq!(encode_tool_image_jpeg(junk, 32, 24, false, 85).unwrap_err().class(), ErrorClass::Invalid);
    assert_eq!(resize_image_buffer(junk, "png", ResizeOptions::default()).unwrap_err().class(), ErrorClass::Invalid);
}
