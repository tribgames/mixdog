//! Twin test `forced_breaks`: the recording of Node's forced page break detection
//! (`native/core/fixtures/office-forced-breaks/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-forced-breaks.mjs`) against this crate. Every recorded HTML source, docx
//! body and set of layout pages is run through the Rust function of the same name, and every recorded session (a real
//! docx, a kept HTML and a preview PDF written to a temporary folder) through `forced_break_pages`; the answer must equal
//! the recorded one exactly. Re-recording is `twin_live_forced_breaks` (ignored: it runs Node).

use base64::Engine;
use mixdog_fsio::Unlaned;
use mixdog_js::json_stringify;
use mixdog_office_base::twin;
use mixdog_office_quality::forced_breaks::{
    BreakPreview, BreakSession, TextItem, TextPage, docx_break_openings, forced_break_pages, forced_break_pages_from_texts,
    html_break_openings,
};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-forced-breaks")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}"))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn decode(value: &Value, key: &str) -> Option<Vec<u8>> {
    text(value, key).map(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).expect("base64"))
}

fn layout_pages(value: &Value) -> Vec<TextPage> {
    value
        .as_array()
        .expect("pages")
        .iter()
        .map(|page| TextPage {
            page: page["page"].as_u64().expect("page number") as usize,
            height: page.get("height").and_then(Value::as_f64).unwrap_or(0.0),
            items: page["items"]
                .as_array()
                .expect("items")
                .iter()
                .map(|item| TextItem {
                    text: item["text"].as_str().expect("text").to_owned(),
                    x: item["x"].as_f64().expect("x"),
                    top: item["top"].as_f64().expect("top"),
                })
                .collect(),
        })
        .collect()
}

fn session_answer(input: &Value) -> Value {
    let dir = tempfile::tempdir().expect("temp dir");
    let target = dir.path().join("doc.docx");
    let html = dir.path().join("doc.html");
    let output = dir.path().join(text(input, "output").unwrap_or("preview.pdf"));
    if let Some(bytes) = decode(input, "docx") {
        mixdog_fsio::write(&Unlaned, &target, bytes).expect("write docx");
    }
    if let Some(source) = text(input, "html") {
        mixdog_fsio::write(&Unlaned, &html, source).expect("write html");
    }
    if let Some(bytes) = decode(input, "pdf").filter(|_| text(input, "output") != Some("")) {
        mixdog_fsio::write(&Unlaned, &output, bytes).expect("write pdf");
    }
    let output_text = if text(input, "output") == Some("") { String::new() } else { output.display().to_string() };
    let session = BreakSession {
        format: text(input, "format").expect("format"),
        target: &target,
        html_source: text(input, "html").map(|_| html.as_path()),
        html_source_edits: input.get("htmlSourceEdits").and_then(Value::as_bool).unwrap_or(false),
    };
    let preview = BreakPreview {
        has_images: input["images"].as_u64().expect("images") > 0,
        output: &output_text,
        export_available: input.get("exportAvailable").and_then(Value::as_bool),
    };
    match forced_break_pages(&Unlaned, &session, &preview).expect("forced break pages") {
        Some(pages) => json!(pages),
        None => Value::Null,
    }
}

/// Replays one section: the answer of `run` to each recorded input must serialise to the recorded text.
fn replay(golden: &Value, name: &str, run: impl Fn(&Value) -> Value) {
    let cases = section(golden, name);
    assert!(!cases.is_empty(), "section {name} is empty");
    let mut failures = Vec::new();
    for case in cases {
        let expected = json_stringify(&case["output"]);
        let actual = json_stringify(&run(&case["input"]));
        if expected != actual {
            let input: String = json_stringify(&case["input"]).chars().take(300).collect();
            failures.push(format!("input {input}\n  recorded {expected}\n  produced {actual}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} of {} cases differ\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n")
    );
}

fn every_output_equals_the_recording() {
    let g = golden();
    replay(&g, "html", |input| json!(html_break_openings(text(input, "html").expect("html"))));
    replay(&g, "docx", |input| json!(docx_break_openings(text(input, "xml").expect("xml"))));
    replay(&g, "texts", |input| {
        let openings: Vec<String> = input["openings"].as_array().expect("openings").iter().map(|o| o.as_str().expect("opening").to_owned()).collect();
        json!(forced_break_pages_from_texts(&openings, &layout_pages(&input["pages"])))
    });
    replay(&g, "files", session_answer);
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

#[test]
fn the_recording_covers_every_section_with_a_real_spread() {
    let g = golden();
    for (name, minimum) in [("html", 80), ("docx", 12), ("texts", 12), ("files", 12)] {
        assert!(section(&g, name).len() >= minimum, "{name} has too few cases");
    }
    let with_openings = section(&g, "html").iter().filter(|case| case["output"].as_array().is_some_and(|list| !list.is_empty())).count();
    assert!(with_openings > 20 && with_openings < section(&g, "html").len(), "the html corpus never or always forces a break");
    let unknown = section(&g, "files").iter().filter(|case| case["output"].is_null()).count();
    let found = section(&g, "files").iter().filter(|case| case["output"].as_array().is_some_and(|list| !list.is_empty())).count();
    assert!(unknown > 3 && found > 3, "the sessions neither read nor skip their sources");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-quality --test twin_forced_breaks -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/quality)"]
fn twin_live_forced_breaks() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-forced-breaks.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
