//! Node-recorded twin `fixtures/services/tidy-runners-twin.json`
//! (`benchmarks/rust-core/recorders/record-tidy-runners.mjs`): Node's real runners against a
//! scripted fake binary. Rust runs the same scenarios against a scripted `Spawn` and must ask the
//! same questions (argv, stdin, environment of every spawn, in order) and make the same answer of
//! the same output. `MIXDOG_FIXTURES_ROOT` overrides the fixture location.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::tidy::process::ProcessResult;

/// `fake-engine.mjs` in Rust: the first response whose `when` is one of the flags and whose `call`
/// is this invocation's index answers; every invocation is logged.
struct Engine {
    responses: Vec<Value>,
    log: Mutex<Vec<Value>>,
}

#[async_trait]
impl Spawn for Engine {
    async fn run(&self, _bin: &str, args: &[String], _cwd: &Path, timeout: Duration, _cancel: Option<&CancellationToken>, env: Option<&HashMap<String, String>>, input: Option<Vec<u8>>) -> ProcessResult {
        let index = self.log.lock().unwrap().len();
        let argv: Vec<String> = args.iter().enumerate().map(|(at, a)| if at > 0 && args[at - 1] == "--report" { "REPORT".to_owned() } else { a.clone() }).collect();
        let var = |name: &str| env.and_then(|e| e.get(name)).map_or(Value::Null, |v| json!(v));
        self.log.lock().unwrap().push(json!({
            "argv": argv,
            "stdin": input.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default(),
            "env": {"write": var("MIXDOG_TIDY_PSSA_WRITE"), "module": var("MIXDOG_TIDY_PSSA_MODULE")},
        }));
        let response = self
            .responses
            .iter()
            .find(|r| r.get("when").is_none_or(|w| args.iter().any(|a| Some(a.as_str()) == w.as_str())) && r.get("call").is_none_or(|c| c.as_u64() == Some(index as u64)))
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let (Some(report), Some(at)) = (response.get("report").and_then(Value::as_str), args.iter().position(|a| a == "--report")) {
            std::fs::write(&args[at + 1], report).unwrap();
        }
        let text = |key: &str| response.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
        let sleep = response.get("sleepMs").and_then(Value::as_u64).unwrap_or(0);
        if Duration::from_millis(sleep) > timeout {
            return ProcessResult { code: -1, stdout: text("stdout"), stderr: text("stderr"), timed_out: true, error: format!("timed out after {}ms", timeout.as_millis()), ..Default::default() };
        }
        ProcessResult { code: response.get("code").and_then(Value::as_i64).unwrap_or(0) as i32, stdout: text("stdout"), stderr: text("stderr"), ..Default::default() }
    }
}

fn to_value(r: &RunnerResult) -> Value {
    let mut v = json!({"diagnostics": r.diagnostics.iter().map(Diagnostic::to_json).collect::<Vec<_>>(), "changedFiles": r.changed_files, "stderrTail": r.stderr_tail});
    if let Some(counts) = &r.counts {
        v["counts"] = counts.clone();
    }
    if r.truncated {
        v["truncated"] = json!(true);
    }
    if let Some(note) = &r.note {
        v["note"] = json!(note);
    }
    v
}

#[tokio::test(flavor = "current_thread")]
async fn every_runner_asks_and_answers_what_node_recorded() {
    let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
    let twin: Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/tidy-runners-twin.json")).unwrap()).unwrap();
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() > 200);
    let work = tempfile::tempdir().unwrap();
    let cwd = work.path().join("repo");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_text = cwd.to_string_lossy().into_owned();
    let escaped = cwd_text.replace('\\', "\\\\");
    let mut differences: Vec<String> = Vec::new();
    for case in cases {
        let name = format!("{} {} / {}", case["runner"].as_str().unwrap(), case["mode"].as_str().unwrap(), case["name"].as_str().unwrap());
        let responses: Vec<Value> = serde_json::from_str(&case["responses"].to_string().replace("{CWD}", &escaped)).unwrap();
        let engine = Arc::new(Engine { responses, log: Mutex::default() });
        let files: Vec<String> = case["files"].as_array().unwrap().iter().map(|f| f.as_str().unwrap().to_owned()).collect();
        let mut req = RunRequest::new(&cwd, "engine", files, engine.clone(), mixdog_rt::testing::tokens().durability_io);
        req.args = case["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
        req.timeout = Duration::from_millis(case["timeoutMs"].as_u64().unwrap_or(30_000));
        // Node's runners forward this knob to `runChunked` only in these three; the others always
        // chunk at 80 whatever the caller passes (`biome.mjs:391`, `dotnet-format.mjs:182`,
        // `psscriptanalyzer.mjs:91`).
        // Biome forwards it from `check` only (`biome.mjs:414` takes no such option for `fix`).
        let forwards = match case["runner"].as_str().unwrap() {
            "biome" => case["mode"] == "check",
            other => matches!(other, "dotnet-format" | "psscriptanalyzer"),
        };
        if let Some(n) = case["filesPerSpawn"].as_u64().filter(|_| forwards) {
            req.files_per_spawn = n as usize;
        }
        req.module_path = case["modulePath"].as_str().map(str::to_owned);
        let runner = runner_for(case["runner"].as_str().unwrap()).unwrap_or_else(|| panic!("{name}: no runner"));
        let result = if case["mode"] == "check" { runner.check(&req).await } else { runner.fix(&req).await };
        let back = |v: Value| -> Value { serde_json::from_str(&v.to_string().replace(&escaped, "{CWD}")).unwrap() };
        let mut calls = back(Value::Array(engine.log.lock().unwrap().clone()));
        let mut expected_calls = case["calls"].clone();
        if case["unordered"] == true {
            for list in [&mut calls, &mut expected_calls] {
                list.as_array_mut().unwrap().sort_by_key(Value::to_string);
            }
        }
        let cut = |v: &Value| v.to_string().chars().take(600).collect::<String>();
        if calls != expected_calls {
            differences.push(format!("{name}: the spawns differ\n  actual: {}\n expected: {}", cut(&calls), cut(&expected_calls)));
        }
        let answer = back(to_value(&result));
        if answer != case["result"] {
            differences.push(format!("{name}: the result differs\n  actual: {}\n expected: {}", cut(&answer), cut(&case["result"])));
        }
    }
    assert!(differences.is_empty(), "{} differences:\n{}", differences.len(), differences.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}
