//! Twin test `measure`: the recording of `@napi-rs/canvas` measuring text (`native/core/fixtures/office-measure/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-measure.mjs`) against this crate. The same font files are
//! registered, then for every recorded case the width and the font metrics must equal the canvas's within 1e-3, the face
//! that sets each character must be the recorded one, and the horizontal ink (left and right bounds) must equal it (the right bound within 5e-3) for the
//! cases the recorder marks (TrueType outlines in a face that really has the style). The vertical ink bounds (ascent and
//! descent) are compared within one pixel: the canvas reports hinted glyph bounds, which Skia's FreeType hinting moves by
//! up to a pixel and which are not reproduced. The cases that use the provisioned Noto faces run when those files are
//! installed and are the files the recording was made from. Re-recording is `twin_live_measure` (ignored: it runs Node).

use std::path::PathBuf;

use mixdog_fonts::discovery::HostEnv;
use mixdog_fonts::measure;
use mixdog_fonts::measure::MeasureOptions;
use mixdog_fonts::provision;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

const TOLERANCE: f64 = 1e-3;
/// The right bound of a long run: the canvas's accumulated glyph positions differ from the linear sum of advances by
/// up to 2e-3 px (measured over 42 sentences of 12 to 43 characters).
const RIGHT_TOLERANCE: f64 = 5e-3;

fn golden() -> Value {
    twin::load_golden("office-measure")
}

fn set_dir() -> PathBuf {
    twin::repo_root().join("native/core/fixtures/office-measure")
}

fn host_env() -> HostEnv {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    HostEnv::current(&|name| std::env::var(name).ok(), &home)
}

/// The registry of the recording: the fixture faces under their twin names, and the provisioned Noto faces that are
/// installed and are the recorded files. Returns it with the ids of the provisioned faces that are registered.
fn registry(golden: &Value) -> (Registry, Vec<String>) {
    let mut registry = Registry::new();
    let dir = set_dir();
    for (alias, list) in golden["faces"].as_object().expect("faces") {
        for face in list.as_array().expect("face list") {
            let path = dir.join(face["file"].as_str().expect("file"));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    let env = host_env();
    let mut available = Vec::new();
    for entry in golden["noto"].as_array().expect("noto") {
        let id = entry["id"].as_str().expect("id");
        let Some(def) = provision::NOTO_FONTS.iter().find(|def| def.id == id) else { continue };
        let Some(path) = provision::installed_path(&Unlaned, &env, def) else { continue };
        let bytes = mixdog_fsio::read(&Unlaned, &path).expect("an installed face is readable");
        let digest: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
        if digest == entry["sha256"].as_str().expect("sha256") {
            registry.register_file(&Unlaned, &path, Some(entry["alias"].as_str().expect("alias"))).expect("a recorded face registers");
            available.push(id.to_owned());
        }
    }
    (registry, available)
}

fn number(value: &Value) -> f64 {
    value.as_f64().expect("a number")
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let (registry, available) = registry(&golden);
    let mut differences = Vec::new();
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        if case.get("requires").and_then(Value::as_str).is_some_and(|id| !available.iter().any(|have| have == id)) {
            continue;
        }
        compared += 1;
        let font = case["font"].as_str().expect("font");
        let text = case["text"].as_str().expect("text");
        let label = format!("{font} {text:?}");
        let parsed = mixdog_fonts::css_font::parse(font).unwrap_or_else(|error| panic!("{label}: {error}"));
        let options = MeasureOptions { letter_spacing: number(&case["letterSpacing"]) as f32 };
        let got = measure::measure_parsed(&Unlaned, &registry, &parsed, text, &options).unwrap_or_else(|error| panic!("{label}: {error}"));
        let want = &case["metrics"];
        let exact = [
            ("width", got.width),
            ("fontBoundingBoxAscent", got.font_bounding_box_ascent),
            ("fontBoundingBoxDescent", got.font_bounding_box_descent),
            ("alphabeticBaseline", got.alphabetic_baseline),
            ("emHeightAscent", got.em_height_ascent),
            ("emHeightDescent", got.em_height_descent),
        ];
        for (field, value) in exact {
            if (value - number(&want[field])).abs() > TOLERANCE {
                differences.push(format!("{label}: {field} {value} recorded {}", want[field]));
            }
        }
        if case["inkHorizontal"].as_bool() == Some(true) {
            for (field, value, tolerance) in [
                ("actualBoundingBoxLeft", got.actual_bounding_box_left, TOLERANCE),
                ("actualBoundingBoxRight", got.actual_bounding_box_right, RIGHT_TOLERANCE),
            ] {
                if (value - number(&want[field])).abs() > tolerance {
                    differences.push(format!("{label}: {field} {value} recorded {}", want[field]));
                }
            }
        }
        for (field, value) in [("actualBoundingBoxAscent", got.actual_bounding_box_ascent), ("actualBoundingBoxDescent", got.actual_bounding_box_descent)] {
            if (value - number(&want[field])).abs() > 1.0 + TOLERANCE {
                differences.push(format!("{label}: {field} {value} recorded {}", want[field]));
            }
        }
        let faces: Vec<String> = measure::faces_of(&Unlaned, &registry, font, text)
            .unwrap_or_else(|error| panic!("{label}: {error}"))
            .into_iter()
            .map(|(_, id)| registry.path_of(id).and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_default())
            .collect();
        let recorded: Vec<&str> = case["faces"].as_array().expect("faces").iter().map(|name| name.as_str().expect("name")).collect();
        if faces != recorded {
            differences.push(format!("{label}: faces {faces:?} recorded {recorded:?}"));
        }
    }
    assert!(compared > 400, "only {compared} cases were compared");
    assert!(differences.is_empty(), "{} of {compared} cases differ from the recording:\n{}", differences.len(), differences.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn twin_measure() {
    every_output_equals_the_recording();
}

#[test]
fn the_fixture_faces_describe_themselves() {
    let dir = set_dir().join("faces");
    let lisu = mixdog_fonts::Face::from_file(&Unlaned, &dir.join("NotoSansLisu-Regular.ttf")).expect("a face");
    assert_eq!(lisu.family, "Noto Sans Lisu");
    assert_eq!((lisu.style.weight, lisu.style.width, lisu.units_per_em), (400, 5, 1000));
    assert_eq!((lisu.metrics.ascender, lisu.metrics.descender), (1069, -293));
    assert!(lisu.has_glyph('A') && !lisu.has_glyph('안') && !lisu.is_variable());
    let bold = mixdog_fonts::Face::from_file(&Unlaned, &dir.join("NotoSansLisu-Bold.ttf")).expect("a face");
    assert_eq!(bold.style.weight, 700);
    let miriam = mixdog_fonts::Face::from_file(&Unlaned, &dir.join("MiriamLibre-Regular.otf")).expect("a face");
    assert_eq!(miriam.family, "Miriam Libre");
}

/// Records again with Node and compares: `cargo test -p mixdog-fonts --test twin_measure -- --ignored`.
#[test]
#[ignore = "re-records through Node (@napi-rs/canvas)"]
fn twin_live_measure() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-measure.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
