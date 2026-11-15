//! The Rust raster operations against what sharp 0.35.5 (libvips 8.18.7) answered to the same calls
//! (`fixtures/office-sharp/golden.json`, recorded by `benchmarks/rust-core/recorders/record-office-sharp.mjs` from the
//! product's own sharp; re-record with that script, the replay itself never starts Node).
//!
//! A case is a source (an input picture, a created canvas or raw pixels), a list of steps (each one a sharp call whose
//! result the recorder materialised as raw pixels before the next) and one output: `raw`, `stats`, `metadata` or `png`.
//!
//! Tolerance, and why: dimensions, band counts, metadata and every min / max are equal exactly. Pixels may differ from
//! libvips by at most 2 in any sample and by 0.5 on average per case, because libvips resamples in a fixed-point
//! integer pipeline (and shrinks by an integer box factor first) while this crate resamples in floats, and rounds its
//! blends and its HSL conversion once at the end. Sum, sum of squares, mean and standard deviation are within 1e-6
//! relative: they are sums of the same integers. The position of a minimum or maximum is compared only where the
//! value occurs once in the band (libvips's scan order among ties is its own).

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_raster::Blend;
use mixdog_raster::Fit;
use mixdog_raster::Image;
use mixdog_raster::Kernel;
use mixdog_raster::Overlay;
use mixdog_raster::Placement;
use mixdog_raster::Position;
use mixdog_raster::ResizeOptions;
use mixdog_raster::composite;
use mixdog_raster::ops;
use mixdog_raster::stats;
use serde_json::Value;

const MAX_ABSOLUTE_DIFFERENCE: i32 = 2;
const MAX_MEAN_DIFFERENCE: f64 = 0.5;
const STATS_RELATIVE: f64 = 1e-6;

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-sharp/golden.json");
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("the golden parses")
}

fn bytes(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().expect("base64 text")).expect("valid base64")
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn unsigned(value: &Value, key: &str) -> u32 {
    value.get(key).and_then(Value::as_u64).map(|n| n as u32).unwrap_or_else(|| panic!("`{key}` is missing"))
}

/// `{ r, g, b, alpha }` (alpha 0 to 1) or `#rrggbb`, as RGBA bytes.
fn colour(value: &Value) -> [u8; 4] {
    if let Some(hex) = value.as_str() {
        let n = u32::from_str_radix(hex.trim_start_matches('#'), 16).expect("hex colour");
        return [(n >> 16) as u8, (n >> 8) as u8, n as u8, 255];
    }
    let channel = |key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let alpha = value.get("alpha").and_then(Value::as_f64).unwrap_or(1.0);
    [channel("r") as u8, channel("g") as u8, channel("b") as u8, (alpha * 255.0).round() as u8]
}

fn decode_input(golden: &Value, id: &str) -> Image {
    Image::decode(&bytes(&golden["inputs"][id]["data"])).unwrap_or_else(|e| panic!("input {id}: {e}"))
}

fn source(golden: &Value, source: &Value) -> Image {
    if let Some(id) = source.get("input").and_then(Value::as_str) {
        return decode_input(golden, id);
    }
    if let Some(create) = source.get("create") {
        return Image::create(unsigned(create, "width"), unsigned(create, "height"), unsigned(create, "channels") as u8, colour(&create["background"])).unwrap();
    }
    let raw = &source["raw"];
    Image::from_raw(unsigned(raw, "width"), unsigned(raw, "height"), unsigned(raw, "channels") as u8, &bytes(&raw["data"])).unwrap()
}

/// What the recorder does after each step: the result becomes plain raw pixels.
fn materialised(image: &Image) -> Image {
    Image::from_raw(image.width(), image.height(), image.channels(), &image.to_raw()).unwrap()
}

fn step(golden: &Value, image: &Image, s: &Value, offsets: &mut Option<(u32, u32)>) -> Image {
    let op = s["op"].as_str().unwrap();
    let f = |key: &str, default: f64| s.get(key).and_then(Value::as_f64).unwrap_or(default);
    let out = match op {
        "rotate" => image.auto_orient(),
        "resize" => {
            let options = ResizeOptions {
                width: s.get("width").and_then(Value::as_u64).map(|n| n as u32),
                height: s.get("height").and_then(Value::as_u64).map(|n| n as u32),
                fit: s.get("fit").and_then(Value::as_str).map_or(Fit::Cover, |n| Fit::parse(n).unwrap()),
                position: s.get("position").and_then(Value::as_str).map_or(Position::Centre, |n| Position::parse(n).unwrap()),
                kernel: s.get("kernel").and_then(Value::as_str).map_or(Kernel::Lanczos3, |n| Kernel::parse(n).unwrap()),
                background: s.get("background").map_or([0, 0, 0, 255], colour),
            };
            ops::resize(image, &options).unwrap()
        }
        "extract" => ops::extract(image, unsigned(s, "left"), unsigned(s, "top"), unsigned(s, "width"), unsigned(s, "height")).unwrap(),
        "extend" => ops::extend(image, unsigned(s, "top"), unsigned(s, "bottom"), unsigned(s, "left"), unsigned(s, "right"), colour(&s["background"])),
        "flatten" => {
            let c = colour(&s["background"]);
            image.flatten([c[0], c[1], c[2]])
        }
        "removeAlpha" => image.remove_alpha(),
        "ensureAlpha" => image.ensure_alpha(),
        "greyscale" => ops::greyscale(image),
        "linear" => ops::linear(image, f("a", 1.0), f("b", 0.0)),
        "modulate" => ops::modulate(image, f("brightness", 1.0), f("saturation", 1.0), f("hue", 0.0)),
        "trim" => {
            let trimmed = ops::trim(image, f("threshold", 10.0)).unwrap();
            *offsets = Some((trimmed.left, trimmed.top));
            trimmed.image
        }
        "composite" => {
            let mut over = decode_input(golden, s["input"].as_str().unwrap());
            if let Some(size) = s.get("resizeTo").and_then(Value::as_array) {
                over = ops::resize_exact(&over, size[0].as_u64().unwrap() as u32, size[1].as_u64().unwrap() as u32, Kernel::Lanczos3);
            }
            let placement = match (number(s, "left"), number(s, "top")) {
                (None, None) => Placement::Centre,
                (left, top) => Placement::At { left: left.unwrap_or(0), top: top.unwrap_or(0) },
            };
            let blend = Blend::parse(s["blend"].as_str().unwrap()).unwrap();
            composite(image, &[Overlay { image: over, blend, placement }])
        }
        other => panic!("unknown step {other}"),
    };
    materialised(&out)
}

fn compare_pixels(name: &str, expected: &[u8], actual: &[u8]) {
    assert_eq!(expected.len(), actual.len(), "{name}: pixel byte count");
    let mut total = 0u64;
    let mut worst = 0i32;
    for (e, a) in expected.iter().zip(actual) {
        let d = (i32::from(*e) - i32::from(*a)).abs();
        worst = worst.max(d);
        total += d as u64;
    }
    let mean = if expected.is_empty() { 0.0 } else { total as f64 / expected.len() as f64 };
    assert!(worst <= MAX_ABSOLUTE_DIFFERENCE, "{name}: largest difference {worst} (limit {MAX_ABSOLUTE_DIFFERENCE})");
    assert!(mean <= MAX_MEAN_DIFFERENCE, "{name}: mean difference {mean} (limit {MAX_MEAN_DIFFERENCE})");
}

fn close(name: &str, what: &str, expected: f64, actual: f64) {
    let scale = expected.abs().max(1.0);
    assert!((expected - actual).abs() <= STATS_RELATIVE * scale, "{name}: {what} {actual} vs {expected}");
}

fn check_stats(name: &str, image: &Image, expected: &Value) {
    let got = stats(image);
    let want = expected["channels"].as_array().unwrap();
    assert_eq!(got.len(), want.len(), "{name}: band count");
    let bands: Vec<usize> = match image.channels() {
        1 => vec![0],
        2 => vec![0, 3],
        3 => vec![0, 1, 2],
        _ => vec![0, 1, 2, 3],
    };
    for ((g, w), band) in got.iter().zip(want).zip(bands) {
        assert_eq!(i64::from(g.min), w["min"].as_i64().unwrap(), "{name}: min");
        assert_eq!(i64::from(g.max), w["max"].as_i64().unwrap(), "{name}: max");
        close(name, "sum", w["sum"].as_f64().unwrap(), g.sum);
        close(name, "squaresSum", w["squaresSum"].as_f64().unwrap(), g.squares_sum);
        close(name, "mean", w["mean"].as_f64().unwrap(), g.mean);
        close(name, "stdev", w["stdev"].as_f64().unwrap(), g.stdev);
        let values: Vec<u8> = image.rgba().chunks_exact(4).map(|p| p[band]).collect();
        let width = image.width() as usize;
        for (value, x, y, key) in [(g.min, g.min_x, g.min_y, "min"), (g.max, g.max_x, g.max_y, "max")] {
            if values.iter().filter(|v| **v == value).count() == 1 {
                assert_eq!(i64::from(x), w[format!("{key}X")].as_i64().unwrap(), "{name}: {key}X");
                assert_eq!(i64::from(y), w[format!("{key}Y")].as_i64().unwrap(), "{name}: {key}Y");
                assert_eq!(values[y as usize * width + x as usize], value, "{name}: {key} position holds the value");
            }
        }
    }
}

fn check_metadata(name: &str, image: &Image, expected: &Value) {
    let m = image.metadata();
    assert_eq!(m.format, expected["format"].as_str(), "{name}: format");
    assert_eq!(u64::from(m.width), expected["width"].as_u64().unwrap(), "{name}: width");
    assert_eq!(u64::from(m.height), expected["height"].as_u64().unwrap(), "{name}: height");
    assert_eq!(u64::from(m.channels), expected["channels"].as_u64().unwrap(), "{name}: channels");
    assert_eq!(m.has_alpha, expected["hasAlpha"].as_bool().unwrap(), "{name}: hasAlpha");
    assert_eq!(m.density.map(i64::from), expected["density"].as_i64(), "{name}: density");
    assert_eq!(m.orientation.map(i64::from), expected["orientation"].as_i64(), "{name}: orientation");
}

fn check_raw(name: &str, width: u32, height: u32, channels: u8, pixels: &[u8], expected: &Value) {
    assert_eq!(width, unsigned(expected, "width"), "{name}: width");
    assert_eq!(height, unsigned(expected, "height"), "{name}: height");
    assert_eq!(u32::from(channels), unsigned(expected, "channels"), "{name}: channels");
    compare_pixels(name, &bytes(&expected["data"]), pixels);
}

fn replay(golden: &Value, case: &Value) {
    let name = case["name"].as_str().unwrap();
    let expected = &case["expect"];
    let mut image = source(golden, &case["source"]);
    let mut offsets = None;
    for s in case["steps"].as_array().unwrap() {
        image = step(golden, &image, s, &mut offsets);
    }
    if let Some((left, top)) = offsets {
        // sharp reports the offset of the cut as a negative number.
        assert_eq!(-i64::from(left), number(expected, "trimOffsetLeft").unwrap(), "{name}: trimOffsetLeft");
        assert_eq!(-i64::from(top), number(expected, "trimOffsetTop").unwrap(), "{name}: trimOffsetTop");
    }
    match case["output"].as_str().unwrap() {
        "metadata" => check_metadata(name, &image, expected),
        "stats" => check_stats(name, &image, expected),
        "png" => {
            let again = Image::decode(&image.to_png().unwrap()).unwrap();
            check_raw(name, again.width(), again.height(), again.channels(), &again.to_raw(), expected);
        }
        _ => check_raw(name, image.width(), image.height(), image.channels(), &image.to_raw(), expected),
    }
}

#[test]
fn every_recorded_sharp_call_is_replayed_within_the_stated_tolerance() {
    let golden = golden();
    assert_eq!(golden["sharp"].as_str(), Some("0.35.5"));
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() > 200, "the corpus is not truncated");
    for case in cases {
        replay(&golden, case);
    }
}
