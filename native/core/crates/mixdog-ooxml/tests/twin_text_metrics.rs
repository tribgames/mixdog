//! Twin test `text_metrics`: the recording of `portable/text-metrics.mjs` (`native/core/fixtures/office-text-metrics/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-text-metrics.mjs`) against this crate. The same font files are
//! registered on both sides (the three fixture faces of `office-measure` under their twin names, and the provisioned Noto
//! Sans KR when the recording used it: it must be installed with the recorded sha256, a missing face fails the test). Line
//! breaks, line counts, review findings and the sizes the repair lands on must equal the recording exactly; widths and
//! heights within 1e-3. Re-recording is `twin_live_text_metrics` (ignored: it runs Node).

use std::path::PathBuf;

use mixdog_fonts::discovery::HostEnv;
use mixdog_fonts::provision;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_ooxml::relations::{Relation, RelationBox};
use mixdog_ooxml::text_metrics::{
    BlockOptions, Bound, FitOptions, FontSpec, Paragraph, Run, ShrinkOptions, TextBox, TextMeasurer, contrast_ratio, relative_luminance,
    review_cjk_tracking, review_shape_spacing, review_stat_label_proximity, review_text_contrast, review_vertical_balance,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const TOLERANCE: f64 = 1e-3;

fn golden() -> Value {
    twin::load_golden("office-text-metrics")
}

fn faces_dir() -> PathBuf {
    twin::repo_root().join("native/core/fixtures/office-measure")
}

/// The registry of the recording: the fixture faces under their twin names and, when recorded, the installed Noto Sans KR
/// registered under its twin name.
fn registry(golden: &Value) -> Registry {
    let mut registry = Registry::new();
    let dir = faces_dir();
    for (alias, list) in golden["faces"].as_object().expect("faces") {
        for face in list.as_array().expect("face list") {
            let path = dir.join(face["file"].as_str().expect("file"));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    let Some(entry) = golden["noto"].as_object() else { return registry };
    let id = entry["id"].as_str().expect("id");
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    let env = HostEnv::current(&|name| std::env::var(name).ok(), &home);
    let def = provision::NOTO_FONTS.iter().find(|def| def.id == id).expect("a provisioned face");
    let path = provision::installed_path(&Unlaned, &env, def).unwrap_or_else(|| panic!("the recording used {id}, which is not installed here"));
    let bytes = mixdog_fsio::read(&Unlaned, &path).expect("an installed face is readable");
    let digest: String = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(digest, entry["sha256"].as_str().expect("sha256"), "{id} is not the recorded file");
    registry.register_file(&Unlaned, &path, Some(entry["alias"].as_str().expect("alias"))).expect("a recorded face registers");
    registry
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn font(value: &Value) -> FontSpec {
    FontSpec {
        font_name: text_of(value, "fontName"),
        font_size: number(value, "fontSize"),
        bold: value["bold"] == json!(true),
        italic: value["italic"] == json!(true),
    }
}

fn paragraph(value: &Value) -> Paragraph {
    Paragraph {
        text: text_of(value, "text").unwrap_or_default(),
        font_name: text_of(value, "fontName"),
        font_size: number(value, "fontSize"),
        bold: value["bold"] == json!(true),
        italic: value["italic"] == json!(true),
        line_spacing: number(value, "lineSpacing"),
        space_before: number(value, "spaceBefore").unwrap_or(0.0),
        space_after: number(value, "spaceAfter").unwrap_or(0.0),
        runs: value.get("runs").and_then(Value::as_array).map(|runs| {
            runs.iter().map(|run| Run { text: text_of(run, "text").unwrap_or_default(), font_size: number(run, "fontSize") }).collect()
        }),
        color: text_of(value, "color"),
        char_spacing: number(value, "charSpacing").unwrap_or(0.0),
    }
}

fn frame(value: &Value) -> RelationBox {
    RelationBox {
        slide: number(value, "slide").unwrap_or(f64::NAN),
        shape: number(value, "shape").unwrap_or(f64::NAN),
        left: number(value, "left").unwrap_or(f64::NAN),
        top: number(value, "top").unwrap_or(f64::NAN),
        width: number(value, "width").unwrap_or(f64::NAN),
        height: number(value, "height").unwrap_or(f64::NAN),
        relation: value.get("relation").and_then(Relation::from_value),
        relation_error: text_of(value, "relationError"),
    }
}

fn text_box(value: &Value) -> TextBox {
    let mut text_box = TextBox::new(frame(value));
    text_box.paragraphs = value["paragraphs"].as_array().map(|list| list.iter().map(paragraph).collect()).unwrap_or_default();
    text_box.background = text_of(value, "background");
    text_box.wrap = value["wrap"] != json!(false);
    text_box.autofit = value["autofit"] == json!(true);
    text_box.inset_left = number(value, "insetLeft").unwrap_or(0.0);
    text_box.inset_right = number(value, "insetRight").unwrap_or(0.0);
    text_box.inset_top = number(value, "insetTop").unwrap_or(0.0);
    text_box.inset_bottom = number(value, "insetBottom").unwrap_or(0.0);
    text_box
}

fn boxes(value: &Value) -> Vec<TextBox> {
    value["boxes"].as_array().map(|list| list.iter().map(text_box).collect()).unwrap_or_default()
}

fn paragraphs(value: &Value) -> Vec<Paragraph> {
    value["paragraphs"].as_array().map(|list| list.iter().map(paragraph).collect()).unwrap_or_default()
}

fn bound(value: &Value) -> Bound {
    Bound {
        slide: number(value, "slide").unwrap_or(f64::NAN),
        left: number(value, "left").unwrap_or(0.0),
        top: number(value, "top").unwrap_or(f64::NAN),
        width: number(value, "width").unwrap_or(0.0),
        height: number(value, "height").unwrap_or(0.0),
        kind: text_of(value, "kind").unwrap_or_default(),
        name: text_of(value, "name").unwrap_or_default(),
    }
}

fn close(what: &str, expected: &Value, actual: f64, failures: &mut Vec<String>) {
    let expected = expected.as_f64().unwrap_or(f64::NAN);
    if !((expected - actual).abs() <= TOLERANCE) {
        failures.push(format!("{what}: recorded {expected}, produced {actual}"));
    }
}

fn same(what: &str, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let found = twin::differences(&twin::normalise(expected), &twin::normalise(actual));
    if !found.is_empty() {
        failures.push(format!("{what}: {}", found.iter().take(3).cloned().collect::<Vec<_>>().join("; ")));
    }
}

#[test]
fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let cases = &golden["cases"];
    let mut failures: Vec<String> = Vec::new();
    let mut count = 0;

    for (at, case) in cases["widths"].as_array().expect("widths").iter().enumerate() {
        count += 1;
        let text = case["input"]["text"].as_str().expect("text");
        let width = measurer.measure_text_width(text, &font(&case["input"]["font"])).expect("a width");
        close(&format!("widths[{at}] {text:?}"), &case["output"]["width"], width, &mut failures);
    }
    for (at, case) in cases["wraps"].as_array().expect("wraps").iter().enumerate() {
        count += 1;
        let input = &case["input"];
        let lines = measurer
            .wrap_paragraph(input["text"].as_str().expect("text"), number(input, "width").unwrap_or(0.0), &font(&input["font"]))
            .expect("lines");
        same(&format!("wraps[{at}]"), &case["output"]["lines"], &json!(lines), &mut failures);
    }
    for (at, case) in cases["blocks"].as_array().expect("blocks").iter().enumerate() {
        count += 1;
        let options = &case["input"]["options"];
        let block = BlockOptions {
            width: number(options, "width").unwrap_or(0.0),
            line_spacing: number(options, "lineSpacing").unwrap_or(1.0),
            line_height_ratio: number(options, "lineHeightRatio").unwrap_or(0.0),
        };
        let measured = measurer.measure_text_block(&paragraphs(&case["input"]), &block).expect("a block");
        let output = &case["output"];
        same(&format!("blocks[{at}] lines"), &output["lines"], &json!(measured.lines), &mut failures);
        close(&format!("blocks[{at}] height"), &output["height"], measured.height, &mut failures);
        close(&format!("blocks[{at}] width"), &output["width"], measured.width, &mut failures);
        close(&format!("blocks[{at}] longestRun"), &output["longestRun"], measured.longest_run, &mut failures);
    }
    for (at, case) in cases["spacing"].as_array().expect("spacing").iter().enumerate() {
        count += 1;
        let gap = number(&case["input"]["options"], "minimumGap").unwrap_or(21.6);
        same(&format!("spacing[{at}]"), &case["output"], &Value::Array(review_shape_spacing(&boxes(&case["input"]), gap)), &mut failures);
    }
    for (at, case) in cases["contrast"].as_array().expect("contrast").iter().enumerate() {
        count += 1;
        same(&format!("contrast[{at}]"), &case["output"], &Value::Array(review_text_contrast(&boxes(&case["input"]))), &mut failures);
    }
    for (at, case) in cases["tracking"].as_array().expect("tracking").iter().enumerate() {
        count += 1;
        same(&format!("tracking[{at}]"), &case["output"], &Value::Array(review_cjk_tracking(&boxes(&case["input"]))), &mut failures);
    }
    for (at, case) in cases["fit"].as_array().expect("fit").iter().enumerate() {
        count += 1;
        let options = &case["input"]["options"];
        let fit = FitOptions {
            slide_width: number(options, "slideWidth").unwrap_or(0.0),
            slide_height: number(options, "slideHeight").unwrap_or(0.0),
            tolerance: number(options, "tolerance").unwrap_or(1.04),
            is_font_available: None,
        };
        let found = measurer.review_text_box_fit(&boxes(&case["input"]), &fit).expect("a review");
        same(&format!("fit[{at}]"), &case["output"], &Value::Array(found), &mut failures);
    }
    for (at, case) in cases["balance"].as_array().expect("balance").iter().enumerate() {
        count += 1;
        let input = &case["input"];
        let bounds: Vec<Bound> = input["bounds"].as_array().expect("bounds").iter().map(bound).collect();
        let options = &input["options"];
        let found = review_vertical_balance(
            &bounds,
            number(options, "slideWidth").unwrap_or(0.0),
            number(options, "slideHeight").unwrap_or(0.0),
            &boxes(input),
        );
        same(&format!("balance[{at}]"), &case["output"], &Value::Array(found), &mut failures);
    }
    for (at, case) in cases["stat"].as_array().expect("stat").iter().enumerate() {
        count += 1;
        let gap = number(&case["input"]["options"], "maximumGap").unwrap_or(36.0);
        same(&format!("stat[{at}]"), &case["output"], &Value::Array(review_stat_label_proximity(&boxes(&case["input"]), gap)), &mut failures);
    }
    for (at, case) in cases["shrink"].as_array().expect("shrink").iter().enumerate() {
        count += 1;
        let options = &case["input"]["options"];
        let shrink = ShrinkOptions {
            width: number(options, "width").unwrap_or(0.0),
            height: number(options, "height").unwrap_or(0.0),
            minimum_font_size: number(options, "minimumFontSize").unwrap_or(8.0),
            steps: options.get("steps").and_then(Value::as_array).map(|steps| steps.iter().filter_map(Value::as_f64).collect()),
        };
        let shrunk = measurer.shrink_font_size_to_fit(&paragraphs(&case["input"]), &shrink).expect("a repair");
        close(&format!("shrink[{at}] scale"), &case["output"]["scale"], shrunk.scale, &mut failures);
        same(&format!("shrink[{at}] sizes"), &case["output"]["sizes"], &json!(shrunk.sizes), &mut failures);
    }
    for (at, case) in cases["luminance"].as_array().expect("luminance").iter().enumerate() {
        count += 1;
        let input = &case["input"];
        let foreground = input["foreground"].as_str().unwrap_or("");
        let background = input["background"].as_str().unwrap_or("");
        for (what, expected, actual) in [
            ("luminance", &case["output"]["luminance"], relative_luminance(foreground)),
            ("contrast", &case["output"]["contrast"], contrast_ratio(foreground, background)),
        ] {
            match (expected.as_f64(), actual) {
                (Some(want), Some(got)) if (want - got).abs() <= 1e-9 => {}
                (None, None) => {}
                _ => failures.push(format!("luminance[{at}] {what}: recorded {expected}, produced {actual:?}")),
            }
        }
    }

    assert!(count > 0);
    assert!(failures.is_empty(), "{} of {count} cases differ from the recording; first:\n{}", failures.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
#[ignore = "runs Node to re-record the fixture"]
fn twin_live_text_metrics() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-text-metrics.mjs", &twin::node_source_root());
}
