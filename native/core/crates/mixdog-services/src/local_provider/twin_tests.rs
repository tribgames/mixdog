//! Node-recorded twin `fixtures/services/gguf-hf-twin.json`
//! (`benchmarks/rust-core/recorders/record-gguf-hf.mjs`): Node's `parseGgufHeader`,
//! `ggufMemoryPlan` and Hugging Face catalog over the same binary headers and the same scripted
//! HTTP answers. Rust must give the same answers and ask the same URLs and byte ranges, in order.
//! `MIXDOG_FIXTURES_ROOT` overrides the fixture location.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::gguf::{GgufError, gguf_memory_plan, parse_gguf_header};
use super::hugging_face::{HfError, HfHttp, HuggingFaceCatalog, RangeResponse};
use super::registered_models::RegisteredModels;

fn twin() -> Value {
    let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/gguf-hf-twin.json")).unwrap()).unwrap()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap()).collect()
}

/// Numbers compare by value (the fixture writes `5` where Rust may hold `5.0`); everything else exactly.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

/// Every difference is collected, so one run shows all of them.
#[derive(Default)]
struct Differences(Vec<String>);

impl Differences {
    fn check(&mut self, name: &str, actual: &Value, expected: &Value) {
        if !same(actual, expected) {
            let cut = |v: &Value| serde_json::to_string(v).unwrap().chars().take(700).collect::<String>();
            self.0.push(format!("{name}\n  actual: {}\n expected: {}", cut(actual), cut(expected)));
        }
    }

    fn none(self) {
        assert!(self.0.is_empty(), "{} differences:\n{}", self.0.len(), self.0.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
    }
}

fn parsed(case: &Value) -> Result<super::gguf::GgufHeader, GgufError> {
    parse_gguf_header(&unhex(case["hex"].as_str().unwrap()))
}

#[test]
fn the_header_parser_answers_what_node_does() {
    let twin = twin();
    let cases = twin["parse"].as_array().unwrap();
    assert!(cases.len() > 90);
    let mut differences = Differences::default();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let actual = match parsed(case) {
            Ok(h) => {
                let metadata: serde_json::Map<String, Value> = h.metadata.iter().filter(|(_, v)| v.is_finite()).map(|(k, v)| (k.clone(), json!(v))).collect();
                json!({"ok": {"version": h.version, "architecture": h.architecture, "metadata": metadata}})
            }
            Err(e) => json!({"error": {"message": e.to_string(), "code": if e == GgufError::NeedMore { json!("GGUF_NEED_MORE") } else { Value::Null }}}),
        };
        let mut expected = json!({});
        if let Some(ok) = case.get("ok") {
            // Only the numbers Node kept are comparable: Node also keeps strings, booleans and nulls.
            let numbers: serde_json::Map<String, Value> = ok["metadata"].as_object().unwrap().iter().filter(|(_, v)| v.is_number()).map(|(k, v)| (k.clone(), v.clone())).collect();
            expected["ok"] = json!({"version": ok["version"], "architecture": ok["architecture"], "metadata": numbers});
        } else {
            expected["error"] = case["error"].clone();
        }
        differences.check(name, &actual, &expected);
    }
    differences.none();
}

#[test]
fn the_memory_plan_answers_what_node_does() {
    let twin = twin();
    let headers = twin["planHeaders"].as_object().unwrap();
    let plans = twin["plans"].as_array().unwrap();
    assert!(plans.len() > 400);
    let mut differences = Differences::default();
    for case in plans {
        let header = parse_gguf_header(&unhex(headers[case["header"].as_str().unwrap()].as_str().unwrap())).unwrap();
        let requested = case["requested"].as_i64().unwrap_or(super::context::LOCAL_CONTEXT_DEFAULT_TOKENS);
        let name = format!("{} / size {} / context {}", case["header"], case["fileSize"], case["requested"]);
        let actual = match gguf_memory_plan(&header, case["fileSize"].as_i64().unwrap(), requested) {
            Ok(plan) => json!({"plan": plan}),
            Err(e) => json!({"error": e.to_string()}),
        };
        let expected = if case.get("plan").is_some() { json!({"plan": case["plan"]}) } else { json!({"error": case["error"]}) };
        differences.check(&name, &actual, &expected);
    }
    differences.none();
}

struct Script {
    case: Value,
    data: Vec<u8>,
    log: Mutex<Vec<Value>>,
}

struct Fake(Arc<Script>);

#[async_trait::async_trait]
impl HfHttp for Fake {
    async fn get_json(&self, url: &str, _: usize) -> Result<Value, String> {
        self.0.log.lock().unwrap().push(json!({"url": url, "end": null}));
        let spec = &self.0.case[if url.starts_with("https://huggingface.co/api/models?") { "search" } else { "info" }];
        let status = spec["status"].as_u64().unwrap_or(200);
        if !(200..300).contains(&status) {
            return Err(format!("Hugging Face request failed: HTTP {status}"));
        }
        Ok(spec["body"].clone())
    }

    async fn get_range(&self, url: &str, end: u64) -> Result<RangeResponse, String> {
        self.0.log.lock().unwrap().push(json!({"url": url, "end": end}));
        let (case, data) = (&self.0.case, &self.0.data);
        let real_end = end.min(data.len() as u64 - 1);
        let delta = |key: &str| case[key].as_i64().unwrap();
        let content_range = if case["noContentRange"] == true {
            String::new()
        } else if let Some(text) = case["contentRange"].as_str() {
            text.to_owned()
        } else {
            format!("bytes 0-{}/{}", real_end as i64 + delta("rangeEndDelta"), data.len() as i64 + delta("rangeTotalDelta"))
        };
        let status = case["rangeStatus"].as_u64().unwrap() as u16;
        let body = if status == 200 || status == 206 { data[..=real_end as usize].to_vec() } else { Vec::new() };
        Ok(RangeResponse { status, content_range, https: case["httpUrl"] != true, body })
    }
}

fn outcome<T>(result: Result<T, HfError>, value: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(v) => json!({"result": value(v)}),
        Err(HfError::Invalid(m)) => json!({"error": {"kind": "invalid", "message": m}}),
        Err(e) => json!({"error": {"kind": "failed", "message": e.to_string()}}),
    }
}

fn normalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), if k == "previewId" { json!("PREVIEW") } else if k == "expiresAt" { json!("EXPIRES") } else { normalize(v) }))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_hugging_face_flow_asks_and_answers_what_node_does() {
    let twin = twin();
    let cases = twin["huggingFace"].as_array().unwrap();
    assert!(cases.len() > 150);
    let mut differences = Differences::default();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut data = Vec::new();
        for part in case["gguf"].as_array().unwrap() {
            match part["zeros"].as_u64() {
                Some(n) => data.resize(data.len() + n as usize, 0),
                None => data.extend(unhex(part["hex"].as_str().unwrap())),
            }
        }
        let script = Arc::new(Script { case: case.clone(), data, log: Mutex::default() });
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(RegisteredModels::new(dir.path(), mixdog_rt::testing::tokens().durability_io));
        let catalog = HuggingFaceCatalog::new(Box::new(Fake(script.clone())), registry);
        let args = &case["args"];
        let mut preview_id = String::new();
        let mut actual = if case["op"] == "search" {
            outcome(catalog.search(args.get("query")).await, |v| v)
        } else {
            let gpu = case["gpuMemory"].as_f64().unwrap() as i64;
            let out = outcome(catalog.inspect(args, gpu).await, |v| v);
            if let Some(id) = out.pointer("/result/previewId").and_then(Value::as_str) {
                preview_id = id.to_owned();
            }
            out
        };
        let mut registers = Vec::new();
        for step in case["then"].as_array().unwrap() {
            let id = if step["register"] == "preview" { preview_id.as_str() } else { step["register"].as_str().unwrap() };
            registers.push(outcome(catalog.register(id, step["accepted"] == true).await, |v| v));
        }
        actual["calls"] = Value::Array(script.log.lock().unwrap().clone());
        actual["registers"] = Value::Array(registers);
        differences.check(name, &normalize(&actual), &case["expected"]);
    }
    differences.none();
}
