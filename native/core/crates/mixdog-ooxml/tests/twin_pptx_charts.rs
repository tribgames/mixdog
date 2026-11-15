//! Twin test `pptx_charts`: the recording of Node's `portable-pptx.mjs` (the presentation batch) and `portable-pptx-charts.mjs`
//! (`native/core/fixtures/office-pptx-charts/golden.json`, written by `benchmarks/rust-core/recorders/record-office-pptx-charts.mjs`)
//! against this crate. Each sequence builds a deck, then applies batches of operations to it one after the other; what every batch
//! answered (or the error it raised) and the text of every part of the deck afterwards must equal the recording. Re-recording is
//! `twin_live_pptx_charts` (ignored: it runs Node).

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package};
use mixdog_ooxml::pptx::apply_pptx;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-pptx-charts")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn list(value: &Value) -> &Vec<Value> {
    value.as_array().expect("a list")
}

fn deck(zip: &mut Option<Package>) -> &mut Package {
    zip.as_mut().expect("a step before the deck was made")
}

/// What one step answers, with the deck it works on.
fn step(zip: &mut Option<Package>, work: &std::path::Path, measurer: &TextMeasurer<'_, Unlaned>, step: &Value) -> Result<Value, String> {
    match text(&step["op"]) {
        "create" => {
            let path = work.join("created.pptx");
            let options = CreateOptions { file_kind: "pptx", title: text(&step["title"]), sheet_name: "" };
            create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options)?;
            *zip = Some(load_package(&Unlaned, &path)?);
            Ok(Value::Null)
        }
        // The recording keeps the text an edit produced: replaying it is setting that text.
        "set" | "edit" => {
            deck(zip).set(text(&step["name"]), text(&step["text"]));
            Ok(Value::Null)
        }
        "read" => {
            let part = deck(zip).text(text(&step["name"]));
            Ok(if part.is_empty() { Value::Null } else { Value::from(part) })
        }
        "batch" => {
            let operations = list(&step["operations"]);
            apply_pptx(&Unlaned, measurer, deck(zip), operations).map(Value::Array)
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
    let registry = Registry::new();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let sequences = list(&golden["sequences"]);
    assert!(sequences.len() >= 9, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        let name = text(&sequence["name"]);
        let work = tempfile::tempdir().expect("work directory");
        let mut zip: Option<Package> = None;
        let steps = list(&sequence["steps"]);
        let recorded = list(&sequence["outputs"]);
        assert_eq!(steps.len(), recorded.len(), "{name}");
        for (index, (one, expected)) in steps.iter().zip(recorded).enumerate() {
            let produced = match step(&mut zip, work.path(), &measurer, one) {
                Ok(value) => json!({ "result": value }),
                Err(error) => json!({ "error": error }),
            };
            let what = match one.get("operations").and_then(|operations| operations.get(0)).and_then(|operation| operation.get("op")) {
                Some(operation) => format!("{name}, step {index} ({})", text(operation)),
                None => format!("{name}, step {index} ({})", text(&one["op"])),
            };
            twin::assert_matches(&what, expected, &produced);
        }
        let produced = zip.as_ref().map_or(Value::Null, snapshot);
        let (expected, produced) = match &zip {
            Some(package) => twin::settle_embedded(&sequence["snapshot"], &produced, |name| package.file(name).map(<[u8]>::to_vec)),
            None => (sequence["snapshot"].clone(), produced),
        };
        twin::assert_matches(&format!("{name}, the deck"), &expected, &produced);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_pptx_charts -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_pptx_charts() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-pptx-charts.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
