//! Twin test `pptx_shapes`: the recording of Node's `portable-pptx-shapes.mjs` (`native/core/fixtures/office-pptx-shapes/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-pptx-shapes.mjs`) against this crate. Each sequence builds a deck, then
//! runs the shape operations one after the other on it; what every operation answered (or the error it raised) and the text of
//! every part of the deck afterwards must equal the recording. `fit_text` measures in the three fixture faces of `office-measure`
//! under their twin names, the same files the recording registered. Re-recording is `twin_live_pptx_shapes` (ignored: it runs Node).

use std::path::{Path, PathBuf};

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package};
use mixdog_ooxml::pptx_package::{add_presentation_slide, presentation_slides};
use mixdog_ooxml::pptx_shapes::{
    add_animation, add_image, add_media, add_table, add_textbox_or_shape, align_shapes_or_distribute_shapes, crop_image, delete_shape,
    fit_text, group_shapes_or_ungroup_shape, set_hyperlink, set_shape, set_table_cell_style, set_table_data_or_replace_image, set_text,
    z_order,
};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-pptx-shapes")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn list(value: &Value) -> &Vec<Value> {
    value.as_array().expect("a list")
}

fn faces_dir() -> PathBuf {
    twin::repo_root().join("native/core/fixtures/office-measure")
}

/// The registry of the recording: the fixture faces under their twin names.
fn registry(golden: &Value) -> Registry {
    let mut registry = Registry::new();
    let dir = faces_dir();
    for (alias, faces) in golden["faces"].as_object().expect("faces") {
        for face in list(faces) {
            let path = dir.join(text(&face["file"]));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    registry
}

/// An operation with the files it names (`@name`) placed in the work directory.
fn placed(operation: &Value, work: &Path) -> Value {
    let mut placed = operation.clone();
    for key in ["path", "poster"] {
        if let Some(name) = operation.get(key).and_then(Value::as_str).and_then(|name| name.strip_prefix('@')) {
            placed[key] = Value::from(work.join(name).display().to_string());
        }
    }
    placed
}

fn deck(zip: &mut Option<Package>) -> &mut Package {
    zip.as_mut().expect("a step before the deck was made")
}

/// What one step answers, with the deck it works on.
fn step(zip: &mut Option<Package>, work: &Path, measurer: &TextMeasurer<'_, Unlaned>, step: &Value) -> Result<Value, String> {
    match text(&step["op"]) {
        "create" => {
            let path = work.join("created.pptx");
            let options = CreateOptions { file_kind: "pptx", title: text(&step["title"]), sheet_name: "" };
            create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options)?;
            *zip = Some(load_package(&Unlaned, &path)?);
            Ok(Value::Null)
        }
        "addSlide" => add_presentation_slide(deck(zip), step.get("operation").unwrap_or(&json!({}))),
        "set" => {
            deck(zip).set(text(&step["name"]), text(&step["text"]));
            Ok(Value::Null)
        }
        "file" => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(text(&step["base64"])).expect("base64");
            mixdog_fsio::write(&Unlaned, &work.join(text(&step["name"])), bytes).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "run" => {
            let operation = placed(&step["operation"], work);
            let package = deck(zip);
            let slides = presentation_slides(package);
            match text(&operation["op"]) {
                "set_hyperlink" => set_hyperlink(package, &slides, &operation),
                "z_order" => z_order(package, &slides, &operation),
                "align_shapes" | "distribute_shapes" => align_shapes_or_distribute_shapes(package, &slides, &operation),
                "set_text" => set_text(package, &slides, &operation),
                "add_textbox" | "add_shape" => add_textbox_or_shape(package, &slides, &operation),
                "delete_shape" => delete_shape(package, &slides, &operation),
                "add_table" => add_table(package, &slides, &operation),
                "add_image" => add_image(&Unlaned, package, &slides, &operation),
                "fit_text" => fit_text(measurer, package, &slides, &operation),
                "set_table_cell_style" => set_table_cell_style(package, &slides, &operation),
                "set_table_data" | "replace_image" => set_table_data_or_replace_image(&Unlaned, package, &slides, &operation),
                "group_shapes" | "ungroup_shape" => group_shapes_or_ungroup_shape(package, &slides, &operation),
                "add_media" => add_media(&Unlaned, package, &slides, &operation),
                "crop_image" => crop_image(package, &slides, &operation),
                "add_animation" => add_animation(package, &slides, &operation),
                "set_shape" => set_shape(package, &slides, &operation),
                other => panic!("the recording has an operation this test does not replay: {other}"),
            }
        }
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

/// `{ names, parts }`: every entry name in order and the text of every file.
fn snapshot(package: &Package) -> Value {
    let mut parts = Map::new();
    for entry in package.entries() {
        if !entry.dir {
            parts.insert(entry.name.clone(), Value::from(package.text(&entry.name)));
        }
    }
    json!({ "names": package.names(), "parts": parts })
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let sequences = list(&golden["sequences"]);
    assert!(sequences.len() >= 9, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let work = tempfile::tempdir().expect("work directory");
        let shown = work.path().display().to_string();
        let mut zip: Option<Package> = None;
        let steps = list(&sequence["steps"]);
        let recorded = list(&sequence["outputs"]);
        assert_eq!(steps.len(), recorded.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(recorded).enumerate() {
            let produced = match step(&mut zip, work.path(), &measurer, one) {
                Ok(value) => json!({ "result": value }),
                Err(error) => json!({ "error": error.replace(&shown, "<work>") }),
            };
            let what = match one.get("operation").and_then(|operation| operation.get("op")) {
                Some(operation) => format!("{name}, step {index} ({})", text(operation)),
                None => format!("{name}, step {index} ({})", text(&one["op"])),
            };
            twin::assert_matches(&what, expected, &produced);
        }
        let produced = zip.as_ref().map_or(Value::Null, snapshot);
        twin::assert_matches(&format!("{name}, the deck"), &sequence["snapshot"], &produced);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_pptx_shapes -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_pptx_shapes() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-shapes.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
