//! Exact output replay of installed formulajs 4.6.1, including signed zero,
//! NaN bits, errors, thrown messages and array/undefined/date outputs.
use mixdog_office_base::twin;
use mixdog_xlsx_formula::{ErrorValue, Failure, Registry, Value, coerce, registry};
use serde_json::{Value as Json, json};
// Compile the owned production module directly while the lead's hot registration
// edit is pending. No test substitute implementations are used.
mod value {
    pub use mixdog_xlsx_formula::{ErrorValue, Failure, Value};
}
#[path = "../src/functions/statistical.rs"]
mod statistical;

fn decode(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(v) => Value::Bool(*v),
        Json::Number(v) => Value::Number(v.as_f64().unwrap()),
        Json::String(v) => Value::Text(v.clone()),
        Json::Array(v) => Value::Array(v.iter().map(decode).collect()),
        Json::Object(_) => match value["$"].as_str().unwrap() {
            "undefined" => Value::Undefined,
            "error" => {
                Value::Error(ErrorValue::from_message(value["v"].as_str().unwrap()).unwrap())
            }
            "date" => Value::Date(value["v"].as_f64().unwrap()),
            "number" => Value::Number(match value["v"].as_str().unwrap() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                other => panic!("{other}"),
            }),
            other => panic!("{other}"),
        },
    }
}
fn encode(value: &Value) -> Json {
    match value {
        Value::Undefined => json!({"t":"undefined"}),
        Value::Null => json!({"t":"null"}),
        Value::Number(n) => json!({"t":"number","bits":format!("{:016x}",n.to_bits())}),
        Value::Bool(v) => json!({"t":"bool","v":v}),
        Value::Text(v) => json!({"t":"text","v":v}),
        Value::Error(e) => json!({"t":"error","v":e.message()}),
        Value::Date(v) => if v.is_finite() {
            // JS Date.getTime() is an integral, TimeClipped millisecond count.
            json!({"t":"date","v":*v as i64})
        } else {
            json!({"t":"date","v":null})
        },
        Value::Array(v) => json!({"t":"array","v":v.iter().map(encode).collect::<Vec<_>>()}),
    }
}
fn outcome(value: Result<Value, Failure>) -> Json {
    match value {
        Ok(value) => json!({"value":encode(&value)}),
        Err(Failure::Thrown(message)) => json!({"threw":message}),
        Err(Failure::Unsupported(reason)) => {
            panic!("descriptive function refused: {}", reason.reason)
        }
    }
}
fn golden() -> Json {
    serde_json::from_str(include_str!("../../../fixtures/office-stats/golden.json")).unwrap()
}

#[test]
fn every_descriptive_result_equals_the_recording_bit_for_bit() {
    let golden = golden();
    assert_eq!(golden["version"], "4.6.1");
    let registry = Registry::new(&[statistical::FUNCTIONS]);
    assert_eq!(statistical::FUNCTIONS.len(), 63);
    assert!(Registry::duplicates(&[statistical::FUNCTIONS]).is_empty());
    let mut failures = Vec::new();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 3000);
    for name in golden["names"].as_array().unwrap() {
        assert!(registry.resolve(name.as_str().unwrap()).is_some(), "{name}");
    }
    for (index, row) in cases.iter().enumerate() {
        let name = row["name"].as_str().unwrap();
        let args: Vec<_> = row["args"].as_array().unwrap().iter().map(decode).collect();
        let actual = outcome(registry.resolve(name).unwrap()(&args));
        if actual != row["expected"] {
            failures.push(format!(
                "{index} {name} {} {:?}: expected {}, got {actual}",
                row["label"], args, row["expected"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures
            .iter()
            .take(50)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
#[ignore = "runs the read-only original Node/formulajs reference recorder"]
fn twin_live_stats() {
    let output = twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-stats.mjs",
        &twin::node_source_root(),
    );
    let live: Json = serde_json::from_str(&output).unwrap();
    assert_eq!(live["sourceSha256"], golden()["sourceSha256"]);
    assert_eq!(live["jstatSha256"], golden()["jstatSha256"]);
    assert_eq!(live["cases"], golden()["cases"]);
}

#[test]
fn descriptive_functions_are_registered_in_the_production_library() {
    for (name, _) in statistical::FUNCTIONS {
        assert!(
            mixdog_xlsx_formula::library().resolve(name).is_some(),
            "{name}"
        );
    }
}
