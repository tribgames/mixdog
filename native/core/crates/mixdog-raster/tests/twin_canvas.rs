//! The Rust canvas against what `@napi-rs/canvas` 1.0.11 (Skia) drew for the same scripts
//! (`fixtures/office-canvas/golden.json`, recorded by `benchmarks/rust-core/recorders/record-office-canvas.mjs` from the product's
//! own canvas; re-record with `twin_live_canvas`, the replay itself never starts Node).
//!
//! A case is a script (a list of canvas calls: state, paths, strokes with caps, joins, miter limits and dashes, clips, rectangles,
//! linear and radial gradients, drawImage in its three forms with smoothing on and off, patterns, the 26 composite operations,
//! transforms, get and put of image data, and text in Latin and Korean) run on a canvas of a given size. The Rust canvas must have
//! exactly the recorded size and its pixels (compared premultiplied, all four channels) within the tolerance recorded with the
//! case: opaque fills of whole pixels are exact, anti-aliased edges differ by at most 3 in any channel and 0.5 on average
//! (tiny-skia is a port of Skia's raster pipeline, not Skia's analytic coverage), text differs by hinting and glyph placement (the
//! outlines are filled unhinted) and is held to a mean difference and to the summed ink. Text cases that need a provisioned Noto
//! face fail when it is not installed with the recorded sha256: they are not skipped.
//!
//! The test measures every case before it decides and prints the difference of each (largest, mean) to stderr.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fonts::discovery::HostEnv;
use mixdog_fonts::provision;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_raster::Image;
use mixdog_raster::canvas::Bitmap;
use mixdog_raster::canvas::Canvas;
use mixdog_raster::canvas::FillRule;
use mixdog_raster::canvas::Gradient;
use mixdog_raster::canvas::ImageData;
use mixdog_raster::canvas::PatternStyle;
use mixdog_raster::canvas::Repetition;
use mixdog_raster::canvas::Style;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

fn fixtures() -> PathBuf {
    twin::repo_root().join("native/core/fixtures")
}

fn bytes(value: &Value) -> Vec<u8> {
    STANDARD.decode(value.as_str().expect("base64 text")).expect("valid base64")
}

fn host_env() -> HostEnv {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    HostEnv::current(&|name| std::env::var(name).ok(), &home)
}

/// The faces of the recording: the fixture faces under their twin names, and the provisioned Noto faces that are installed and are
/// the recorded files. Returns the registry with the ids of the provisioned faces that are registered.
fn registry(golden: &Value) -> (Registry, BTreeSet<String>) {
    let mut registry = Registry::new();
    for (alias, list) in golden["faces"].as_object().expect("faces") {
        for face in list.as_array().expect("face list") {
            let path = fixtures().join(face["file"].as_str().expect("file"));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    let env = host_env();
    let mut available = BTreeSet::new();
    for entry in golden["noto"].as_array().expect("noto") {
        let id = entry["id"].as_str().expect("id");
        let Some(def) = provision::NOTO_FONTS.iter().find(|def| def.id == id) else { continue };
        let Some(path) = provision::installed_path(&Unlaned, &env, def) else { continue };
        let file = mixdog_fsio::read(&Unlaned, &path).expect("an installed face is readable");
        let digest: String = Sha256::digest(&file).iter().map(|byte| format!("{byte:02x}")).collect();
        if digest == entry["sha256"].as_str().expect("sha256") {
            registry.register_file(&Unlaned, &path, Some(entry["alias"].as_str().expect("alias"))).expect("a recorded face registers");
            available.insert(id.to_owned());
        }
    }
    (registry, available)
}

fn number(value: &Value) -> f32 {
    value.as_f64().expect("a number") as f32
}

/// Replays one script.
struct Replay<'a> {
    canvas: Canvas,
    gradients: HashMap<String, Gradient>,
    patterns: HashMap<String, PatternStyle>,
    images: &'a HashMap<String, Bitmap>,
    registry: &'a Registry,
    reads: Vec<ImageData>,
}

impl Replay<'_> {
    fn style(&self, value: &Value) -> Style {
        if let Some(css) = value.as_str() {
            return Style::from_css(css).unwrap_or_else(|| panic!("`{css}` is not a colour"));
        }
        if let Some(id) = value.get("gradient").and_then(Value::as_str) {
            return Style::Gradient(self.gradients[id].clone());
        }
        let id = value.get("pattern").and_then(Value::as_str).expect("a gradient or a pattern");
        Style::Pattern(self.patterns[id].clone())
    }

    fn set(&mut self, name: &str, value: &Value) {
        let text = || value.as_str().unwrap_or_else(|| panic!("{name} takes text"));
        match name {
            "fillStyle" => {
                let style = self.style(value);
                self.canvas.set_fill_style(style);
            }
            "strokeStyle" => {
                let style = self.style(value);
                self.canvas.set_stroke_style(style);
            }
            "lineWidth" => self.canvas.set_line_width(number(value)),
            "lineCap" => assert!(self.canvas.set_line_cap(text()), "lineCap {value}"),
            "lineJoin" => assert!(self.canvas.set_line_join(text()), "lineJoin {value}"),
            "miterLimit" => self.canvas.set_miter_limit(number(value)),
            "lineDashOffset" => self.canvas.set_line_dash_offset(number(value)),
            "globalAlpha" => self.canvas.set_global_alpha(number(value)),
            "globalCompositeOperation" => assert!(self.canvas.set_global_composite_operation(text()), "operation {value}"),
            "imageSmoothingEnabled" => self.canvas.set_image_smoothing_enabled(value.as_bool().expect("a boolean")),
            "imageSmoothingQuality" => assert!(self.canvas.set_image_smoothing_quality(text()), "quality {value}"),
            "font" => assert!(self.canvas.set_font(text()), "font {value}"),
            "textAlign" => assert!(self.canvas.set_text_align(text()), "align {value}"),
            "textBaseline" => assert!(self.canvas.set_text_baseline(text()), "baseline {value}"),
            "letterSpacing" => self.canvas.set_letter_spacing(number(value)),
            other => panic!("unknown property {other}"),
        }
    }

    fn rule(args: &[Value]) -> FillRule {
        match args.first().and_then(Value::as_str) {
            Some("evenodd") => FillRule::EvenOdd,
            _ => FillRule::Winding,
        }
    }

    fn call(&mut self, name: &str, args: &[Value]) {
        let n = |at: usize| number(&args[at]);
        let canvas = &mut self.canvas;
        match name {
            "save" => canvas.save(),
            "restore" => canvas.restore(),
            "translate" => canvas.translate(n(0), n(1)),
            "scale" => canvas.scale(n(0), n(1)),
            "rotate" => canvas.rotate(n(0)),
            "transform" => canvas.transform(n(0), n(1), n(2), n(3), n(4), n(5)),
            "setTransform" => canvas.set_transform(n(0), n(1), n(2), n(3), n(4), n(5)),
            "resetTransform" => canvas.reset_transform(),
            "beginPath" => canvas.begin_path(),
            "closePath" => canvas.close_path(),
            "moveTo" => canvas.move_to(n(0), n(1)),
            "lineTo" => canvas.line_to(n(0), n(1)),
            "bezierCurveTo" => canvas.bezier_curve_to(n(0), n(1), n(2), n(3), n(4), n(5)),
            "quadraticCurveTo" => canvas.quadratic_curve_to(n(0), n(1), n(2), n(3)),
            "arc" => canvas.arc(n(0), n(1), n(2), n(3), n(4), args.get(5).and_then(Value::as_bool).unwrap_or(false)).expect("arc"),
            "arcTo" => canvas.arc_to(n(0), n(1), n(2), n(3), n(4)).expect("arcTo"),
            "ellipse" => canvas.ellipse(n(0), n(1), n(2), n(3), n(4), n(5), n(6), args.get(7).and_then(Value::as_bool).unwrap_or(false)).expect("ellipse"),
            "rect" => canvas.rect(n(0), n(1), n(2), n(3)),
            "roundRect" => {
                let radii: Vec<f32> = match &args[4] {
                    Value::Array(list) => list.iter().map(number).collect(),
                    one => vec![number(one)],
                };
                canvas.round_rect(n(0), n(1), n(2), n(3), &radii).expect("roundRect");
            }
            "fill" => canvas.fill(Self::rule(args)),
            "stroke" => canvas.stroke(),
            "clip" => canvas.clip(Self::rule(args)),
            "fillRect" => canvas.fill_rect(n(0), n(1), n(2), n(3)),
            "strokeRect" => canvas.stroke_rect(n(0), n(1), n(2), n(3)),
            "clearRect" => canvas.clear_rect(n(0), n(1), n(2), n(3)),
            "setLineDash" => {
                let segments: Vec<f32> = args[0].as_array().expect("a list").iter().map(number).collect();
                canvas.set_line_dash(&segments);
            }
            "drawImage" => {
                let image = &self.images[args[0]["image"].as_str().expect("an image")];
                match args.len() {
                    3 => canvas.draw_image(image, n(1), n(2)),
                    5 => canvas.draw_image_scaled(image, n(1), n(2), n(3), n(4)),
                    9 => canvas.draw_image_region(image, n(1), n(2), n(3), n(4), n(5), n(6), n(7), n(8)),
                    other => panic!("drawImage with {other} arguments"),
                }
            }
            "fillText" | "strokeText" => {
                let text = args[0].as_str().expect("text");
                let max_width = args.get(3).map(number);
                let result = if name == "fillText" {
                    canvas.fill_text(&Unlaned, self.registry, text, n(1), n(2), max_width)
                } else {
                    canvas.stroke_text(&Unlaned, self.registry, text, n(1), n(2), max_width)
                };
                result.unwrap_or_else(|error| panic!("{name}: {error}"));
            }
            other => panic!("unknown call {other}"),
        }
    }

    fn operation(&mut self, op: &[Value]) {
        let name = op[0].as_str().expect("an operation name");
        match name {
            "set" => self.set(op[1].as_str().expect("a property"), &op[2]),
            "call" => self.call(op[1].as_str().expect("a method"), &op[2..]),
            "gradient" => {
                let coordinates: Vec<f32> = op[3].as_array().expect("coordinates").iter().map(number).collect();
                let mut gradient = match (op[2].as_str(), coordinates.as_slice()) {
                    (Some("linear"), [x0, y0, x1, y1]) => Gradient::linear(*x0, *y0, *x1, *y1),
                    (Some("radial"), [x0, y0, r0, x1, y1, r1]) => Gradient::radial(*x0, *y0, *r0, *x1, *y1, *r1),
                    other => panic!("gradient {other:?}"),
                };
                for stop in op[4].as_array().expect("stops") {
                    gradient.add_color_stop(number(&stop[0]), stop[1].as_str().expect("a colour")).expect("a colour stop");
                }
                self.gradients.insert(op[1].as_str().expect("an id").to_owned(), gradient);
            }
            "pattern" => {
                let image = &self.images[op[2].as_str().expect("an image")];
                let repetition = Repetition::parse(op[3].as_str().expect("a repetition")).expect("a known repetition");
                self.patterns.insert(op[1].as_str().expect("an id").to_owned(), PatternStyle::new(image, repetition));
            }
            "putImageData" => {
                let (width, height) = (op[1].as_u64().expect("width") as u32, op[2].as_u64().expect("height") as u32);
                let data = ImageData::from_rgba(width, height, bytes(&op[3])).expect("image data");
                let at = |index: usize| op[index].as_i64().expect("an integer") as i32;
                let dirty = (op.len() == 10).then(|| (at(6), at(7), at(8), at(9)));
                self.canvas.put_image_data(&data, at(4), at(5), dirty);
            }
            "get" => {
                let at = |index: usize| op[index].as_i64().expect("an integer") as i32;
                self.reads.push(self.canvas.get_image_data(at(1), at(2), at(3) as u32, at(4) as u32).expect("getImageData"));
            }
            other => panic!("unknown operation {other}"),
        }
    }
}

/// The premultiplied channels of a straight pixel.
fn premultiplied(pixel: &[u8]) -> [i32; 4] {
    let alpha = i32::from(pixel[3]);
    [(i32::from(pixel[0]) * alpha + 127) / 255, (i32::from(pixel[1]) * alpha + 127) / 255, (i32::from(pixel[2]) * alpha + 127) / 255, alpha]
}

/// `(largest difference, mean difference)` of two straight RGBA buffers, premultiplied.
fn difference(expected: &[u8], actual: &[u8]) -> (i32, f64) {
    assert_eq!(expected.len(), actual.len(), "the two images have different sizes");
    let (mut largest, mut sum) = (0, 0_i64);
    for (a, b) in expected.chunks_exact(4).zip(actual.chunks_exact(4)) {
        for (x, y) in premultiplied(a).into_iter().zip(premultiplied(b)) {
            let step = (x - y).abs();
            largest = largest.max(step);
            sum += i64::from(step);
        }
    }
    (largest, sum as f64 / expected.len() as f64)
}

/// The summed distance of the red channel from white (the ink of dark text on a white page).
fn ink(rgba: &[u8]) -> f64 {
    rgba.chunks_exact(4).map(|pixel| f64::from(255 - pixel[0])).sum()
}

struct Outcome {
    id: String,
    largest: i32,
    mean: f64,
    problems: Vec<String>,
}

fn replay(golden: &Value, registry: &Registry, available: &BTreeSet<String>, images: &HashMap<String, Bitmap>, case: &Value) -> Outcome {
    let id = case["id"].as_str().expect("an id").to_owned();
    let mut problems = Vec::new();
    for need in case.get("requires").and_then(Value::as_array).into_iter().flatten() {
        let need = need.as_str().expect("a face id");
        if !available.contains(need) {
            problems.push(format!("needs the provisioned face {need} installed as recorded (sha256 {})", golden["noto"].as_array().expect("noto").iter().find(|entry| entry["id"] == need).map_or("?", |entry| entry["sha256"].as_str().unwrap_or("?"))));
        }
    }
    if !problems.is_empty() {
        return Outcome { id, largest: -1, mean: -1.0, problems };
    }
    let (width, height) = (case["width"].as_u64().expect("width") as u32, case["height"].as_u64().expect("height") as u32);
    let mut run = Replay { canvas: Canvas::new(width, height).expect("a canvas"), gradients: HashMap::new(), patterns: HashMap::new(), images, registry, reads: Vec::new() };
    for op in case["ops"].as_array().expect("ops") {
        run.operation(op.as_array().expect("an operation"));
    }
    let tolerance = &case["tolerance"];
    let (max_allowed, mean_allowed) = (tolerance["max"].as_i64().expect("max") as i32, tolerance["mean"].as_f64().expect("mean"));
    let expected = bytes(&case["rgba"]);
    let actual = run.canvas.get_image_data(0, 0, width, height).expect("the whole canvas").into_data();
    let (largest, mean) = difference(&expected, &actual);
    if largest > max_allowed {
        problems.push(format!("a channel differs by {largest} (at most {max_allowed})"));
    }
    if mean > mean_allowed {
        problems.push(format!("the mean difference is {mean:.3} (at most {mean_allowed})"));
    }
    if let Some(ratio) = tolerance.get("ink").and_then(Value::as_f64) {
        let (want, got) = (ink(&expected), ink(&actual));
        if (got - want).abs() > ratio * want.max(1.0) {
            problems.push(format!("the ink is {got:.0}, recorded {want:.0} (relative difference above {ratio})"));
        }
    }
    let recorded = case["reads"].as_array().expect("reads");
    if recorded.len() != run.reads.len() {
        problems.push(format!("{} reads recorded, {} made", recorded.len(), run.reads.len()));
    }
    for (index, (want, got)) in recorded.iter().zip(&run.reads).enumerate() {
        let (w, h) = (want["width"].as_u64().expect("width") as u32, want["height"].as_u64().expect("height") as u32);
        if (got.width(), got.height()) != (w, h) {
            problems.push(format!("read {index} is {}x{}, recorded {w}x{h}", got.width(), got.height()));
            continue;
        }
        let (read_largest, _) = difference(&bytes(&want["rgba"]), got.data());
        if read_largest > max_allowed {
            problems.push(format!("read {index} differs by {read_largest} (at most {max_allowed})"));
        }
    }
    Outcome { id, largest, mean, problems }
}

fn run_all() -> Vec<Outcome> {
    let golden = twin::load_golden("office-canvas");
    let (registry, available) = registry(&golden);
    let mut images = HashMap::new();
    for (id, picture) in golden["images"].as_object().expect("images") {
        let decoded = Image::decode(&bytes(&picture["png"])).unwrap_or_else(|error| panic!("image {id}: {error}"));
        images.insert(id.clone(), Bitmap::from_image(&decoded).expect("a bitmap"));
    }
    let outcomes: Vec<Outcome> = golden["cases"].as_array().expect("cases").iter().map(|case| replay(&golden, &registry, &available, &images, case)).collect();
    eprintln!("{:<14}{:>9}{:>10}", "case", "largest", "mean");
    for outcome in &outcomes {
        eprintln!("{:<14}{:>9}{:>10.3}", outcome.id, outcome.largest, outcome.mean);
    }
    outcomes
}

#[test]
fn every_script_leaves_the_recorded_image_within_its_tolerance() {
    let failing: Vec<String> = run_all().into_iter().filter(|outcome| !outcome.problems.is_empty()).map(|outcome| format!("{}: {}", outcome.id, outcome.problems.join("; "))).collect();
    assert!(failing.is_empty(), "{} case(s) differ from Skia:\n{}", failing.len(), failing.join("\n"));
}

#[test]
fn the_recording_covers_every_call_the_office_code_makes() {
    let golden = twin::load_golden("office-canvas");
    let mut calls = BTreeSet::new();
    let mut sets = BTreeSet::new();
    let mut operations = BTreeSet::new();
    let mut scripts = BTreeSet::new();
    for case in golden["cases"].as_array().expect("cases") {
        scripts.insert(case["id"].as_str().expect("id").to_owned());
        for op in case["ops"].as_array().expect("ops") {
            let op = op.as_array().expect("an operation");
            match op[0].as_str().expect("a name") {
                "call" => {
                    calls.insert(op[1].as_str().expect("a method").to_owned());
                }
                "set" => {
                    sets.insert(op[1].as_str().expect("a property").to_owned());
                    if op[1] == "globalCompositeOperation" {
                        operations.insert(op[2].as_str().expect("an operation").to_owned());
                    }
                }
                other => {
                    calls.insert(other.to_owned());
                }
            }
        }
    }
    for call in [
        "save", "restore", "translate", "scale", "rotate", "transform", "setTransform", "resetTransform", "beginPath", "closePath", "moveTo", "lineTo", "bezierCurveTo",
        "quadraticCurveTo", "arc", "arcTo", "ellipse", "rect", "roundRect", "fill", "stroke", "clip", "fillRect", "strokeRect", "clearRect", "setLineDash", "drawImage",
        "fillText", "strokeText", "gradient", "pattern", "putImageData", "get",
    ] {
        assert!(calls.contains(call), "no recorded script calls {call}");
    }
    for property in [
        "fillStyle", "strokeStyle", "lineWidth", "lineCap", "lineJoin", "miterLimit", "lineDashOffset", "globalAlpha", "globalCompositeOperation", "imageSmoothingEnabled",
        "imageSmoothingQuality", "font", "textAlign", "textBaseline", "letterSpacing",
    ] {
        assert!(sets.contains(property), "no recorded script sets {property}");
    }
    assert_eq!(operations.len(), 26, "every composite operation is recorded: {operations:?}");
    assert!(scripts.contains("text_latin") && scripts.contains("text_korean"), "text is recorded in Latin and in Korean: {scripts:?}");
}

/// Records again with Node and compares: `cargo test -p mixdog-raster --test twin_canvas -- --ignored`.
#[test]
#[ignore = "re-records through Node (@napi-rs/canvas)"]
fn twin_live_canvas() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-canvas.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_script_leaves_the_recorded_image_within_its_tolerance();
}
