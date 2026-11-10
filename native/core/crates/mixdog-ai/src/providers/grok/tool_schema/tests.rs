//! The flatten against Node's own output: `fixtures/grok-tool-schema/node-recorded.json` holds, per input of `inputs.json`
//! (the Rust core's tool schemas, the Node core's, and synthetic inputs covering each branch of the algorithm and each
//! JavaScript semantic it relies on), the `JSON.stringify` text of what Node's `normalizeGrokToolSchemas`
//! (grok-tool-schema.mjs at b6f10295a) returned for it, or the error it threw, recorded in one run under an exact
//! manifest that lists every file of the directory and the recorder's hash.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

use super::TypeError;
use super::flatten_schema;
use crate::providers::grok::fixture_manifest;

const RECORDER: &str = "native/core/crates/mixdog-ai/src/providers/grok/tool_schema/record.mjs";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn fixture_dir() -> PathBuf {
    repo().join("native/core/fixtures/grok-tool-schema")
}

/// The verified inputs and recording, in order.
fn recorded() -> Vec<(Value, Value)> {
    fixture_manifest::verify_dir(&repo(), &fixture_dir(), RECORDER);
    let read = |name: &str| -> Value { serde_json::from_slice(&std::fs::read(fixture_dir().join(name)).unwrap()).unwrap() };
    let (inputs, recorded) = (read("inputs.json"), read("node-recorded.json"));
    let (inputs, recorded) = (inputs["cases"].as_array().unwrap().clone(), recorded["cases"].as_array().unwrap().clone());
    assert_eq!(inputs.len(), recorded.len(), "the recording holds another number of cases than the inputs");
    for (input, node) in inputs.iter().zip(&recorded) {
        assert_eq!((&input["source"], &input["name"]), (&node["source"], &node["name"]), "the recording is not of the inputs in order");
    }
    inputs.into_iter().zip(recorded).collect()
}

/// What Node gave for a case: the text it wrote, or the error it threw.
fn node_outcome(node: &Value) -> Result<String, String> {
    match (node["json"].as_str(), node["threw"].as_str()) {
        (Some(json), None) => Ok(json.to_owned()),
        (None, Some(threw)) => Err(threw.to_owned()),
        _ => panic!("{}: the recording holds neither a result nor an error", node["name"]),
    }
}

#[test]
fn every_input_flattens_to_what_node_returned_byte_for_byte() {
    for (input, node) in recorded() {
        let got = flatten_schema(&input["input"]).map(|flat| String::from_utf8(super::js_json(&flat)).unwrap()).map_err(|TypeError(message)| format!("TypeError: {message}"));
        assert_eq!(got, node_outcome(&node), "{} ({})", node["name"], node["source"]);
    }
}

#[test]
fn a_body_has_each_tools_parameters_flattened_as_node_flattened_them() {
    let rows: Vec<(Value, Value)> = recorded().into_iter().filter(|(_, node)| node["json"].is_string()).collect();
    // Node's flatten reads `inputSchema`; the encoded body carries the same schema as `parameters`.
    let tools: Vec<Value> = rows.iter().map(|(input, _)| serde_json::json!({ "type": "function", "name": input["name"], "parameters": input["input"] })).collect();
    let mut body = serde_json::json!({ "model": "m", "tools": tools });
    assert_eq!(super::flatten_tools(&mut body), Ok(true));
    let text = String::from_utf8(super::js_json(&body)).unwrap();
    let expected = format!(
        "{{\"model\":\"m\",\"tools\":[{}]}}",
        rows.iter()
            .map(|(input, node)| format!("{{\"type\":\"function\",\"name\":{},\"parameters\":{}}}", input["name"], node["json"].as_str().unwrap()))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_eq!(text, expected);
}

#[test]
fn a_tool_node_throws_on_fails_the_whole_body() {
    let (input, node) = recorded().into_iter().find(|(_, node)| node["threw"].is_string()).expect("a recorded throw");
    let mut body = serde_json::json!({ "tools": [{ "name": "fine", "parameters": { "type": "object" } }, { "name": "bad", "parameters": input["input"] }] });
    let error = super::flatten_tools(&mut body).unwrap_err();
    assert_eq!(format!("TypeError: {}", error.0), node["threw"].as_str().unwrap());
}

/// Runs `check` on a copy of the fixture directory changed by `change`, and returns whether it panicked.
fn verification_fails_after(change: impl FnOnce(&Path)) -> bool {
    let copy = tempfile::tempdir().unwrap();
    for entry in std::fs::read_dir(fixture_dir()).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, copy.path().join(path.file_name().unwrap())).unwrap();
    }
    fixture_manifest::verify_dir(&repo(), copy.path(), RECORDER);
    change(copy.path());
    let dir = copy.path().to_owned();
    std::panic::catch_unwind(move || {
        fixture_manifest::verify_dir(&repo(), &dir, RECORDER);
    })
    .is_err()
}

#[test]
fn the_fixture_check_fails_on_an_extra_missing_or_changed_file() {
    assert!(verification_fails_after(|dir| std::fs::write(dir.join("extra.json"), "{}").unwrap()), "an extra file passed");
    assert!(verification_fails_after(|dir| std::fs::remove_file(dir.join("inputs.json")).unwrap()), "a missing file passed");
    assert!(
        verification_fails_after(|dir| {
            let mut bytes = std::fs::read(dir.join("node-recorded.json")).unwrap();
            let last = bytes.len() - 2;
            bytes[last] ^= 1;
            std::fs::write(dir.join("node-recorded.json"), bytes).unwrap();
        }),
        "a changed file passed"
    );
}

#[test]
fn the_fixture_check_fails_on_another_recorder() {
    let manifest = fixture_manifest::verify_dir(&repo(), &fixture_dir(), RECORDER);
    let mut other = manifest.clone();
    other["recorderSha256"] = Value::String(fixture_manifest::sha256(b"another recorder"));
    let copy = tempfile::tempdir().unwrap();
    for entry in std::fs::read_dir(fixture_dir()).unwrap() {
        let path = entry.unwrap().path();
        std::fs::copy(&path, copy.path().join(path.file_name().unwrap())).unwrap();
    }
    std::fs::write(copy.path().join("MANIFEST.json"), serde_json::to_vec(&other).unwrap()).unwrap();
    let dir = copy.path().to_owned();
    assert!(std::panic::catch_unwind(move || fixture_manifest::verify_dir(&repo(), &dir, RECORDER)).is_err(), "a recorder of another hash passed");
}
