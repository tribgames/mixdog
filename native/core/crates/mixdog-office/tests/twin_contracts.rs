//! Twin test `contracts`: the recording of Node's operation contract engine
//! (`native/core/fixtures/office-contracts/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-contracts.mjs`) against `mixdog_office::contracts` and
//! `mixdog_office::describe`. Each batch is run on the recorded operations: the operations after the call (the contract
//! rewrites them in place, also when it then refuses) must be the exact JSON text Node left, and the error the exact
//! message. Each describe query must answer the exact JSON text. Re-recording is `twin_live_contracts` (ignored: it
//! runs Node).

use mixdog_js::json_stringify;
use mixdog_office::contracts::assert_office_operation_contracts;
use mixdog_office::describe::{DescribeRequest, describe_office_capabilities};
use mixdog_office_base::twin;
use serde_json::Value;

/// The first `limit` characters of a long text, for a failure message.
fn head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is a string in {}", head(&value.to_string(), 200)))
}

fn replay_batches(golden: &Value, mismatches: &mut Vec<String>) -> usize {
    let batches = golden["batches"].as_array().expect("batches");
    for scenario in batches {
        let name = text(scenario, "name");
        let mut operations = scenario["operations"].as_array().expect("operations").clone();
        let outcome = assert_office_operation_contracts(text(scenario, "format"), text(scenario, "backend"), &mut operations);
        let mutated = json_stringify(&Value::Array(operations));
        match (&outcome, scenario.get("error")) {
            (Ok(()), None) => {}
            (Err(message), Some(recorded)) => {
                if recorded.as_str() != Some(message.as_str()) {
                    mismatches.push(format!("{name}: the error\n  node: {}\n  here: {}", head(&recorded.to_string(), 400), head(message, 400)));
                }
            }
            (Ok(()), Some(recorded)) => mismatches.push(format!("{name}: Node refused with {}, this accepted", head(&recorded.to_string(), 400))),
            (Err(message), None) => mismatches.push(format!("{name}: Node accepted, this refused with {}", head(message, 400))),
        }
        if mutated != text(scenario, "mutated") {
            mismatches.push(format!("{name}: the operations afterwards\n  node: {}\n  here: {}", head(text(scenario, "mutated"), 400), head(&mutated, 400)));
        }
    }
    batches.len()
}

fn replay_describes(golden: &Value, mismatches: &mut Vec<String>) -> usize {
    let describes = golden["describes"].as_array().expect("describes");
    for scenario in describes {
        let name = text(scenario, "name");
        let request = &scenario["request"];
        let answer = describe_office_capabilities(&DescribeRequest {
            format: text(request, "format"),
            backend: text(request, "backend"),
            target: text(request, "target"),
            operation: text(request, "operation"),
        });
        match (&answer, scenario.get("result"), scenario.get("error")) {
            (Ok(value), Some(recorded), None) => {
                let produced = json_stringify(value);
                if recorded.as_str() != Some(produced.as_str()) {
                    let recorded = recorded.as_str().unwrap_or_default();
                    let at = recorded.chars().zip(produced.chars()).take_while(|(a, b)| a == b).count();
                    let window = |text: &str| text.chars().skip(at.saturating_sub(60)).take(200).collect::<String>();
                    mismatches.push(format!("{name}: the answer differs at character {at}\n  node: {}\n  here: {}", window(recorded), window(&produced)));
                }
            }
            (Err(message), None, Some(recorded)) => {
                if recorded.as_str() != Some(message.as_str()) {
                    mismatches.push(format!("{name}: the error\n  node: {}\n  here: {}", head(&recorded.to_string(), 400), head(message, 400)));
                }
            }
            (Ok(_), None, Some(recorded)) => mismatches.push(format!("{name}: Node refused with {}, this answered", head(&recorded.to_string(), 400))),
            (Err(message), Some(_), None) => mismatches.push(format!("{name}: Node answered, this refused with {}", head(message, 400))),
            _ => mismatches.push(format!("{name}: the recording holds neither or both of result and error")),
        }
    }
    describes.len()
}

fn replay() {
    let golden = twin::load_golden("office-contracts");
    let mut mismatches = Vec::new();
    let batches = replay_batches(&golden, &mut mismatches);
    let describes = replay_describes(&golden, &mut mismatches);
    assert!(batches > 800 && describes > 500, "the recording lost scenarios: {batches} batches, {describes} describes");
    assert!(
        mismatches.is_empty(),
        "{} of {} scenarios differ from the recording; the first:\n{}",
        mismatches.len(),
        batches + describes,
        mismatches.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn every_batch_and_describe_equals_the_recording() {
    replay();
}

/// Records again with Node and compares: `cargo test -p mixdog-office --test twin_contracts -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/capabilities.mjs)"]
fn twin_live_contracts() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-contracts.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    replay();
}
