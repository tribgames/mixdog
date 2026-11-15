//! Direct formulajs 4.6.1 twin: no engine normalization, tolerance or missing-name skips.
//! The local modules allow the leaf task to be reviewed before TABLES wiring.
use mixdog_xlsx_formula::{ErrorValue, Failure, Registry, Table, Value, coerce, registry};
use serde_json::{Value as Json, json};
#[path = "../src/functions/information.rs"]
mod information;
#[path = "../src/functions/logical.rs"]
mod logical;
#[path = "../src/functions/math.rs"]
mod math;
fn number(v: &Json) -> f64 {
    f64::from_bits(u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap())
}
fn decode(v: &Json) -> Value {
    match v["t"].as_str().unwrap() {
        "undefined" => Value::Undefined,
        "null" => Value::Null,
        "number" => Value::Number(number(v)),
        "date" => Value::Date(number(v)),
        "text" => Value::Text(v["v"].as_str().unwrap().into()),
        "bool" => Value::Bool(v["v"].as_bool().unwrap()),
        "error" => Value::Error(ErrorValue::from_message(v["v"].as_str().unwrap()).unwrap()),
        "array" => Value::Array(v["v"].as_array().unwrap().iter().map(decode).collect()),
        other => panic!("unknown type {other}"),
    }
}
fn encode(v: &Value) -> Json {
    match v {
        Value::Undefined => json!({"t":"undefined"}),
        Value::Null => json!({"t":"null"}),
        Value::Number(n) => json!({"t":"number","bits":format!("{:016x}",n.to_bits())}),
        Value::Date(n) => json!({"t":"date","bits":format!("{:016x}",n.to_bits())}),
        Value::Text(s) => json!({"t":"text","v":s}),
        Value::Utf16(units) => json!({"t":"utf16","units":units}),
        Value::Bool(b) => json!({"t":"bool","v":b}),
        Value::Error(e) => json!({"t":"error","v":e.message()}),
        Value::Array(a) => json!({"t":"array","v":a.iter().map(encode).collect::<Vec<_>>()}),
    }
}
fn golden() -> Json {
    serde_json::from_str(include_str!("../../../fixtures/office-math/golden.json")).unwrap()
}
#[test]
fn every_exported_math_logical_information_path_has_a_registered_function() {
    let g = golden();
    let expected: std::collections::BTreeSet<_> = g["functions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect();
    let tables = &[math::FUNCTIONS, logical::FUNCTIONS, information::FUNCTIONS];
    let actual: std::collections::BTreeSet<_> = tables
        .iter()
        .flat_map(|table| table.iter().map(|(name, _)| *name))
        .collect();
    assert_eq!(expected, actual);
    assert_eq!(actual.len(), 108);
    assert!(Registry::duplicates(tables).is_empty());
}
#[test]
fn every_math_result_equals_original_formulajs_bits_and_errors() {
    let registry = Registry::new(&[math::FUNCTIONS, logical::FUNCTIONS, information::FUNCTIONS]);
    let g = golden();
    let mut failures = Vec::new();
    let cases = g["cases"].as_array().unwrap();
    assert!(cases.len() > 4000);
    mixdog_js::time::with_local_zone("UTC".parse().unwrap(), || {
        for (index, case) in cases.iter().enumerate() {
            let name = case["name"].as_str().unwrap();
            let args: Vec<_> = case["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(decode)
                .collect();
            let function = registry
                .resolve(name)
                .unwrap_or_else(|| panic!("missing {name}"));
            let got =
                math::with_random_sample(case["sample"].as_f64().unwrap(), || function(&args));
            let got = match got {
                Ok(v) => json!({"value":encode(&v)}),
                Err(Failure::Thrown(s)) => json!({"threw":s}),
                Err(Failure::Unsupported(s)) => json!({"unsupported":s.reason}),
            };
            let want = if case.get("threw").is_some() {
                json!({"threw":case["threw"]})
            } else {
                json!({"value":case["value"]})
            };
            if got != want {
                failures.push(format!(
                    "{index} {name} args={} expected={want} actual={got}",
                    case["args"]
                ));
            }
        }
    });
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.into_iter().take(30).collect::<Vec<_>>().join("\n")
    );
}
#[test]
#[ignore = "re-records bounded original Node/formulajs corpus"]
fn twin_live_math() {
    let output = mixdog_office_base::twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-math.mjs",
        &mixdog_office_base::twin::node_source_root(),
    );
    assert!(output.contains("bounded cases recorded"));
    every_exported_math_logical_information_path_has_a_registered_function();
    every_math_result_equals_original_formulajs_bits_and_errors();
}
