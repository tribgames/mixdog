//! Twin test `measure`: the recording of `@napi-rs/canvas` measuring text (`native/core/fixtures/office-measure/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-measure.mjs`) against this crate. The same font files are
//! registered, then for EVERY recorded case (the fixture faces and the provisioned Noto faces, which must be installed
//! with the recorded sha256: a missing face fails the test, it is not skipped) all ten metric fields must equal the
//! recording exactly (f64 equality, no tolerance, no field and no case exempt), and the face that sets each character
//! must equal the recorded one. The face list is the one thing the canvas does not report: the recorder derives it from
//! the cmap coverage of the fonts with fontkit, so that comparison is against that model and not against Skia.
//!
//! The test measures every case before it decides, prints the distribution of the error (maximum, percentiles, per field,
//! per font and per script, Hangul among them) to stderr, and then fails when any field differs. Where the measurement
//! does not match the recording the test stays failing: loosening it is the owner's decision (a native Skia text kernel
//! or not: `D:/mixdog-build/mig/results/fonts-phase2-design.md`). The measured result is in
//! `D:/mixdog-build/mig/results/fonts-measure-error.md`. Re-recording is `twin_live_measure` (ignored: it runs Node).

use std::collections::BTreeMap;
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
use unicode_script::Script;
use unicode_script::UnicodeScript;

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

const FIELDS: [&str; 10] = [
    "width",
    "actualBoundingBoxLeft",
    "actualBoundingBoxRight",
    "actualBoundingBoxAscent",
    "actualBoundingBoxDescent",
    "fontBoundingBoxAscent",
    "fontBoundingBoxDescent",
    "alphabeticBaseline",
    "emHeightAscent",
    "emHeightDescent",
];

fn field_of(metrics: &measure::TextMetrics, field: &str) -> f64 {
    match field {
        "width" => metrics.width,
        "actualBoundingBoxLeft" => metrics.actual_bounding_box_left,
        "actualBoundingBoxRight" => metrics.actual_bounding_box_right,
        "actualBoundingBoxAscent" => metrics.actual_bounding_box_ascent,
        "actualBoundingBoxDescent" => metrics.actual_bounding_box_descent,
        "fontBoundingBoxAscent" => metrics.font_bounding_box_ascent,
        "fontBoundingBoxDescent" => metrics.font_bounding_box_descent,
        "alphabeticBaseline" => metrics.alphabetic_baseline,
        "emHeightAscent" => metrics.em_height_ascent,
        "emHeightDescent" => metrics.em_height_descent,
        other => panic!("unknown field {other}"),
    }
}

/// The absolute error of one group of measurements, summarised as a distribution.
#[derive(Default)]
struct Errors(Vec<f64>);

impl Errors {
    fn push(&mut self, error: f64) {
        self.0.push(error);
    }

    fn percentile(&self, fraction: f64) -> f64 {
        let last = self.0.len().saturating_sub(1);
        self.0.get(((last as f64) * fraction).round() as usize).copied().unwrap_or(0.0)
    }

    fn line(&mut self) -> String {
        self.0.sort_by(f64::total_cmp);
        let differing = self.0.iter().filter(|error| **error != 0.0).count();
        format!(
            "n={} differing={differing} p50={:e} p90={:e} p99={:e} max={:e}",
            self.0.len(),
            self.percentile(0.5),
            self.percentile(0.9),
            self.percentile(0.99),
            self.percentile(1.0)
        )
    }
}

/// The scripts of the characters of a text (Hangul among them), in a stable order.
fn scripts_of(text: &str) -> Vec<String> {
    let mut names: Vec<String> = text
        .chars()
        .map(|c| c.script())
        .filter(|script| !matches!(script, Script::Common | Script::Inherited))
        .map(|script| script.full_name().to_owned())
        .collect();
    if names.is_empty() {
        names.push("Common".to_owned());
    }
    names.sort();
    names.dedup();
    names
}

fn family_of(font: &str) -> String {
    font.split('"').nth(1).unwrap_or(font).to_owned()
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let (registry, available) = registry(&golden);
    let mut differences = Vec::new();
    let mut missing_faces: Vec<String> = Vec::new();
    let mut compared = 0;
    let mut per_field: BTreeMap<&str, Errors> = BTreeMap::new();
    let mut per_font: BTreeMap<String, Errors> = BTreeMap::new();
    let mut per_script: BTreeMap<String, Errors> = BTreeMap::new();
    let mut face_differences = 0;
    for case in golden["cases"].as_array().expect("cases") {
        if let Some(id) = case.get("requires").and_then(Value::as_str) {
            if !available.iter().any(|have| have == id) {
                if !missing_faces.iter().any(|name| name == id) {
                    missing_faces.push(id.to_owned());
                }
                continue;
            }
        }
        compared += 1;
        let font = case["font"].as_str().expect("font");
        let text = case["text"].as_str().expect("text");
        let label = format!("{font} {text:?}");
        let parsed = mixdog_fonts::css_font::parse(font).unwrap_or_else(|error| panic!("{label}: {error}"));
        let options = MeasureOptions { letter_spacing: number(&case["letterSpacing"]) as f32 };
        let got = measure::measure_parsed(&Unlaned, &registry, &parsed, text, &options).unwrap_or_else(|error| panic!("{label}: {error}"));
        let want = &case["metrics"];
        let scripts = scripts_of(text);
        for field in FIELDS {
            let value = field_of(&got, field);
            let recorded = number(&want[field]);
            let error = (value - recorded).abs();
            per_field.entry(field).or_default().push(error);
            per_font.entry(family_of(font)).or_default().push(error);
            for script in &scripts {
                per_script.entry(script.clone()).or_default().push(error);
            }
            if value != recorded {
                differences.push(format!("{label}: {field} {value} recorded {recorded}"));
            }
        }
        let faces: Vec<String> = measure::faces_of(&Unlaned, &registry, font, text)
            .unwrap_or_else(|error| panic!("{label}: {error}"))
            .into_iter()
            .map(|(_, id)| registry.path_of(id).and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_default())
            .collect();
        let recorded: Vec<&str> = case["faces"].as_array().expect("faces").iter().map(|name| name.as_str().expect("name")).collect();
        if faces != recorded {
            face_differences += 1;
            differences.push(format!("{label}: faces {faces:?} recorded {recorded:?}"));
        }
    }
    let mut report = format!("measure error against the recording: {compared} cases compared, {face_differences} face lists differ\nper field\n");
    for (name, errors) in &mut per_field {
        report.push_str(&format!("  {name}: {}\n", errors.line()));
    }
    report.push_str("per font\n");
    for (name, errors) in &mut per_font {
        report.push_str(&format!("  {name}: {}\n", errors.line()));
    }
    report.push_str("per script\n");
    for (name, errors) in &mut per_script {
        report.push_str(&format!("  {name}: {}\n", errors.line()));
    }
    eprintln!("{report}");
    assert!(missing_faces.is_empty(), "the provisioned faces {missing_faces:?} are not installed with the recorded sha256: their cases cannot be compared");
    assert_eq!(compared, golden["cases"].as_array().expect("cases").len(), "every recorded case is compared");
    assert!(
        differences.is_empty(),
        "OPEN ITEM (the owner decides: native Skia kernel or not, fonts-phase2-design.md): {} field or face differences from the recording in {compared} cases\n{}",
        differences.len(),
        differences.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
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
