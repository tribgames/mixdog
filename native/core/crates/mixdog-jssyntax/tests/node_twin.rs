//! `check_commonjs_script` against what Node answers for `new vm.Script(source)`, recorded by
//! benchmarks/rust-core/recorders/record-syntax-cases.mjs. The verdict must match on every case; the message is
//! best effort, so a message difference is counted and reported, and fails nothing.

use mixdog_jssyntax::check_commonjs_script;
use serde_json::Value;

const CASES: &str = include_str!("../../../fixtures/syntax-cases/cases.json");

fn clip(source: &str) -> String {
    source.chars().take(70).collect::<String>().escape_debug().to_string()
}

#[test]
fn the_verdict_matches_node_on_every_recorded_source() {
    let recording: Value = serde_json::from_str(CASES).unwrap();
    let cases = recording["cases"].as_array().unwrap();
    assert!(cases.len() >= 500, "the recording holds {} cases", cases.len());

    let mut verdict_mismatches = Vec::new();
    let mut message_mismatches = 0;
    for case in cases {
        let source = case["source"].as_str().unwrap();
        let tag = case["tag"].as_str().unwrap();
        let node_ok = case["ok"].as_bool().unwrap();
        let ours = check_commonjs_script(source);
        if ours.is_ok() != node_ok {
            verdict_mismatches.push(format!("[{tag}] node {} for {}", if node_ok { "ok" } else { "rejects" }, clip(source)));
        } else if let Err(rejection) = ours {
            if case["message"].as_str() != Some(rejection.message.as_str()) {
                message_mismatches += 1;
            }
        }
    }
    eprintln!(
        "syntax twin: {} cases, {} verdict mismatches, {} message mismatches",
        cases.len(),
        verdict_mismatches.len(),
        message_mismatches
    );
    verdict_mismatches.truncate(25);
    assert!(verdict_mismatches.is_empty(), "verdicts differ from Node:\n{}", verdict_mismatches.join("\n"));
}

#[test]
fn a_wrong_ok_is_never_among_the_mismatches_a_rejection_would_hide() {
    // The shell tool hoists only on `Ok`: every source Node rejects must be rejected here too.
    let recording: Value = serde_json::from_str(CASES).unwrap();
    let hoisted_wrongly: Vec<String> = recording["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["ok"] == false)
        .filter(|case| check_commonjs_script(case["source"].as_str().unwrap()).is_ok())
        .map(|case| format!("[{}] {}", case["tag"].as_str().unwrap(), clip(case["source"].as_str().unwrap())))
        .take(25)
        .collect();
    assert!(hoisted_wrongly.is_empty(), "accepted but Node rejects:\n{}", hoisted_wrongly.join("\n"));
}
