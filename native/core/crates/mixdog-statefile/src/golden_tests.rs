//! Replays `tests/golden/state.json`, recorded from `atomic-file.mjs` by `tests/golden/state.mjs`:
//! each scenario's answer, the files it leaves behind and the order of its file-system calls.
//! Lock files are left out of the listing and the trace on both sides (a held lock scenario
//! leaves the holder's file), and so is the directory flush, which Node's Windows build never
//! reaches.

use std::fs;
use std::time::Duration;

use base64::Engine as _;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::*;

const GOLDEN: &str = include_str!("../tests/golden/state.json");

/// `text` with the run of characters after each `marker` that satisfy `run` replaced by `to`.
fn mask_run(text: &str, marker: &str, run: fn(char) -> bool, to: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(marker) {
        let head = at + marker.len();
        out.push_str(&rest[..head]);
        let tail = &rest[head..];
        let len = tail.find(|c: char| !run(c)).unwrap_or(tail.len());
        out.push_str(to);
        rest = &tail[len..];
    }
    out.push_str(rest);
    out
}

fn mask(text: &str) -> String {
    let text = mask_run(text, ".corrupt-", |c| c.is_ascii_digit(), "<N>");
    mask_run(&text, "mixdog-tmp-", |c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase(), "<H>")
}

fn opts_of(raw: &Value) -> Opts {
    let flag = |key: &str| raw.get(key).and_then(Value::as_bool);
    Opts {
        backup: flag("backup").unwrap_or(false),
        compact: flag("compact").unwrap_or(false),
        fsync_dir: flag("fsyncDir").unwrap_or(false),
        fsync: flag("fsync").unwrap_or(true),
        lock: flag("lock").unwrap_or(false),
        create_only: flag("createOnly").unwrap_or(false),
        restore_backup: flag("restoreBackup").unwrap_or(true),
        keep_without_backup: flag("keepWithoutBackup").unwrap_or(false),
        lock_timeout: raw.get("timeoutMs").and_then(Value::as_u64).map(Duration::from_millis),
        ..Opts::default()
    }
}

type Check = fn(&Value) -> Result<(), Invalid>;

fn validator(name: &str) -> Option<Check> {
    match name {
        "none" => None,
        "object" => Some(|v| if v.is_object() { Ok(()) } else { Err(Invalid::Damaged("not an object".into())) }),
        "versioned" => Some(|v| {
            let version = v.get("version").and_then(Value::as_f64);
            match version {
                Some(version) if version > 1.0 => Err(Invalid::Unsupported("newer build".into())),
                Some(1.0) => Ok(()),
                _ => Err(Invalid::Damaged("unreadable".into())),
            }
        }),
        other => panic!("validator {other}"),
    }
}

fn render(bytes: Vec<u8>) -> Value {
    match String::from_utf8(bytes) {
        Ok(text) => Value::String(text),
        Err(error) => json!({ "b64": base64::engine::general_purpose::STANDARD.encode(error.into_bytes()) }),
    }
}

/// What one scenario answers, leaves behind and traces.
fn run(scenario: &Value) -> Value {
    let dir = tempfile::tempdir().unwrap();
    for (name, content) in scenario["files"].as_object().unwrap() {
        let bytes = match content {
            Value::String(text) => text.clone().into_bytes(),
            other => base64::engine::general_purpose::STANDARD.decode(other["b64"].as_str().unwrap()).unwrap(),
        };
        fs::write(dir.path().join(name), bytes).unwrap();
    }
    if scenario.get("lockHeld").and_then(Value::as_bool).unwrap_or(false) {
        // The record the recorder wrote: a live process other than the taker holds the lock.
        fs::write(dir.path().join("f.json.lock"), format!("{} 1 other-token\n", std::process::id())).unwrap();
    }
    let file = dir.path().join("f.json");
    let call = &scenario["call"];
    let opts = opts_of(&call["opts"]);
    crate::trace::take();

    let (returned, threw): (Value, Option<String>) = crate::tests::on_lane({
        let call = call.clone();
        move |lane| match call["fn"].as_str().unwrap() {
            "read" => {
                let validate = validator(call["validate"].as_str().unwrap());
                let validate = validate.as_ref().map(|f| f as Validate);
                match read_json(lane, &file, validate, &opts) {
                    Ok(Some(value)) => (value, None),
                    Ok(None) => (json!("FALLBACK"), None),
                    Err(error) => (Value::Null, Some(error.kind().to_string())),
                }
            }
            "update" => {
                let mutate = call["mutate"].as_str().unwrap().to_owned();
                let mutator = move |cur: Option<Value>| match mutate.as_str() {
                    "wrap" => Ok(Some(json!({ "seen": cur.unwrap_or(Value::Null) }))),
                    "noop" => Ok(None),
                    _ => Err("EMUTATOR"),
                };
                match update_json(lane, &file, mutator, &opts) {
                    Ok(value) => (value.unwrap_or(Value::Null), None),
                    Err(StateError::Mutator(code)) => (Value::Null, Some(code.to_owned())),
                    Err(StateError::Lock(error)) => (Value::Null, error.code().map(str::to_owned)),
                    Err(StateError::Io(error)) => (Value::Null, Some(error.kind().to_string())),
                }
            }
            "writeJson" => {
                let published = write_json(lane, &file, &call["value"], &opts).unwrap();
                (json!(published == Published::Written), None)
            }
            "writeFile" => {
                let published = write_file(lane, &file, call["text"].as_str().unwrap().as_bytes(), &opts).unwrap();
                (json!(published == Published::Written), None)
            }
            other => panic!("call {other}"),
        }
    });
    let trace: Vec<String> = crate::trace::take()
        .into_iter()
        .filter(|entry| entry != "fsync-dir" && !entry.contains(".lock"))
        .map(|entry| mask(&entry))
        .collect();
    let mut files = Map::new();
    for entry in fs::read_dir(dir.path()).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".lock") {
            files.insert(mask(&name), render(fs::read(entry.path()).unwrap()));
        }
    }
    json!({ "returned": returned, "threw": threw, "files": files, "trace": trace })
}

#[test]
fn every_scenario_matches_what_node_did() {
    let scenarios: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    assert!(scenarios.len() >= 40);
    for scenario in &scenarios {
        let mut expected = scenario["expect"].clone();
        let trace: Vec<Value> = expected["trace"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry.as_str() != Some("fsync-dir"))
            .cloned()
            .collect();
        expected["trace"] = Value::Array(trace);
        assert_eq!(run(scenario), expected, "scenario: {}", scenario["name"]);
    }
}
