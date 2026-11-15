//! Twin test `receipt`: the recording of Node's composition receipt (`native/core/fixtures/office-receipt/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-receipt.mjs`) against this crate. Every recorded slide is
//! read again, every recorded deck is read against its brief, has the recorded rendered air attached and is sent through
//! a session four times (the receipt, the receipt with its render, the same again, and after an edit), and every
//! recorded hand-written receipt is delivered through a session. The exact JSON text of each answer must equal the
//! recorded one. Re-recording is `twin_live_receipt` (ignored: it runs Node).

use mixdog_js::{json_number, json_stringify, to_number};
use mixdog_office_author::receipt::{DeliveredReceipt, PageRead, Page, attach_rendered_air, composition_receipt, receipt_for_delivery, slide_receipt};
use mixdog_office_base::twin;
use mixdog_office_quality::render_air::Balance;
use serde_json::Value;

fn golden() -> Value {
    twin::load_golden("office-receipt")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    let cases = golden[name].as_array().unwrap_or_else(|| panic!("section {name}"));
    assert!(!cases.is_empty(), "section {name} is empty");
    cases
}

fn cut(text: &str) -> String {
    text.chars().take(600).collect()
}

/// The produced answer serialises to the recorded text.
fn same(what: &str, input: &Value, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let (want, got) = (json_stringify(expected), json_stringify(actual));
    if want != got {
        failures.push(format!("{what} {}\n  recorded {}\n  produced {}", cut(&json_stringify(input)), cut(&want), cut(&got)));
    }
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
}

/// The recorded `Map` of page to reading: a bare number is the air alone, an object the full reading.
fn reads(recorded: &Value) -> Vec<(f64, PageRead)> {
    recorded
        .as_array()
        .expect("reads")
        .iter()
        .map(|entry| {
            let page = to_number(&entry[0]);
            let read = &entry[1];
            let page_read = match read {
                Value::Number(number) => PageRead::air_only(number.as_f64().expect("air")),
                _ => PageRead {
                    air: read["air"].as_f64(),
                    colour: read["colour"].as_f64(),
                    largest: read["largest"].as_f64(),
                    balance: read.get("balance").map(|balance| Balance {
                        centered: balance["centered"].as_f64().expect("centered"),
                        left_right: balance["leftRight"].as_f64().expect("leftRight"),
                        top_bottom: balance["topBottom"].as_f64().expect("topBottom"),
                        score: balance["score"].as_f64().expect("score"),
                    }),
                },
            };
            (page, page_read)
        })
        .collect()
}

/// The recorder's edit: the first slide has one more character and the deck one more chart.
fn edited(receipt: &Value) -> Value {
    let mut out = receipt.clone();
    if let Some(first) = out.get_mut("slides").and_then(|slides| slides.get_mut(0)) {
        let chars = first.get("chars").map_or(0.0, to_number);
        first["chars"] = json_number(chars + 1.0);
        if let Some(deck) = out.get_mut("deck").filter(|deck| deck.get("slides").is_some()) {
            let charts = deck.get("charts").map_or(0.0, to_number);
            deck["charts"] = json_number(charts + 1.0);
        }
    }
    out
}

fn every_output_equals_the_recording() {
    let g = golden();

    let mut failures = Vec::new();
    for case in section(&g, "slides") {
        let page = Page { width: to_number(&case["input"]["page"]["width"]), height: to_number(&case["input"]["page"]["height"]) };
        same("slide", &case["input"], &case["output"], &slide_receipt(&case["input"]["slide"], page), &mut failures);
    }
    no_failures("slides", section(&g, "slides").len(), &failures);

    let mut failures = Vec::new();
    for case in section(&g, "decks") {
        let input = &case["input"];
        let brief = Some(&input["brief"]).filter(|brief| !brief.is_null());
        let composed = composition_receipt(&input["document"], brief);
        let mut attached = composition_receipt(&input["document"], brief);
        attach_rendered_air(&mut attached, &reads(&input["reads"]));
        let mut session = DeliveredReceipt::default();
        let mut sent: Vec<Value> = [&composed, &attached, &attached].iter().map(|one| receipt_for_delivery(one, Some(&mut session))).collect();
        sent.push(receipt_for_delivery(&edited(&attached), Some(&mut session)));
        let produced = serde_json::json!({ "receipt": composed, "attached": attached, "sent": sent });
        same("deck", input, &case["output"], &produced, &mut failures);
    }
    no_failures("decks", section(&g, "decks").len(), &failures);

    let mut failures = Vec::new();
    for case in section(&g, "deliveries") {
        let input = &case["input"];
        let mut renamed = input.as_object().cloned().unwrap_or_default();
        renamed.insert("note".into(), Value::String("edited".into()));
        let mut session = DeliveredReceipt::default();
        let mut sent: Vec<Value> =
            [input.clone(), input.clone(), Value::Object(renamed)].iter().map(|one| receipt_for_delivery(one, Some(&mut session))).collect();
        sent.push(receipt_for_delivery(input, None));
        same("delivery", input, &case["output"], &Value::Array(sent), &mut failures);
    }
    no_failures("deliveries", section(&g, "deliveries").len(), &failures);
}

#[test]
fn every_output_equals_the_recorded_answer() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_receipt -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/authoring)"]
fn twin_live_receipt() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-receipt.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}

#[test]
fn the_recording_holds_what_a_deck_receipt_is_made_of() {
    let g = golden();
    let decks = section(&g, "decks");
    let has = |check: &dyn Fn(&Value) -> bool| decks.iter().any(|case| check(&case["output"]["attached"]));
    assert!(has(&|receipt| receipt["deck"].get("pacing").is_some()), "a deck with colour pacing");
    assert!(has(&|receipt| receipt["deck"].get("specs").is_some()), "a deck with spec carriers");
    assert!(
        decks.iter().any(|case| case["output"]["sent"][1]["slides"].as_array().is_some_and(|slides| slides.iter().any(|slide| slide.get("unchanged").is_some()))),
        "a delivery with an unchanged slide"
    );
}
