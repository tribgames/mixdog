//! Every returned engineering value and exception from the original installed library.
use mixdog_js::time::{Tz, with_local_zone};
use mixdog_office_base::twin;
use mixdog_xlsx_formula::{ErrorValue, Failure, Value, library};
use serde_json::{Value as Json, json};
fn f64_bits(s: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(s, 16).expect("binary64 hex"))
}
fn decode(v: &Json) -> Value {
    match v["t"].as_str().unwrap() {
        "undefined" => Value::Undefined,
        "null" => Value::Null,
        "number" => Value::Number(f64_bits(v["bits"].as_str().unwrap())),
        "date" => Value::Date(f64_bits(v["bits"].as_str().unwrap())),
        "bool" => Value::Bool(v["v"].as_bool().unwrap()),
        "text" => Value::Text(v["v"].as_str().unwrap().into()),
        "error" => Value::Error(ErrorValue::from_message(v["v"].as_str().unwrap()).unwrap()),
        "array" => Value::Array(v["v"].as_array().unwrap().iter().map(decode).collect()),
        _ => panic!("invalid fixture input {v}"),
    }
}
fn encode(v: Value) -> Json {
    match v {
        Value::Undefined => json!({"t":"undefined"}),
        Value::Null => json!({"t":"null"}),
        Value::Number(n) => json!({"t":"number","bits":format!("{:016x}",n.to_bits())}),
        Value::Date(n) => json!({"t":"date","bits":format!("{:016x}",n.to_bits())}),
        Value::Bool(v) => json!({"t":"bool","v":v}),
        Value::Text(v) => json!({"t":"text","v":v}),
        Value::Utf16(units) => json!({"t":"text","units":units}),
        Value::Error(e) => json!({"t":"error","v":e.message()}),
        Value::Array(v) => json!({"t":"array","v":v.into_iter().map(encode).collect::<Vec<_>>()}),
    }
}
fn replay(g: &Json) {
    assert_eq!(g["oracle"]["formulajs"], "4.6.1");
    assert_eq!(g["oracle"]["bessel"], "1.0.2");
    assert_eq!(g["unitCount"], 146);
    let rows = g["cases"].as_array().unwrap();
    assert!(rows.len() >= 10_000);
    let mut mismatches = Vec::new();
    with_local_zone(Tz::UTC, || {
        for (i, row) in rows.iter().enumerate() {
            let name = row["name"].as_str().unwrap();
            let args: Vec<_> = row["args"].as_array().unwrap().iter().map(decode).collect();
            let function = library()
                .resolve(name)
                .unwrap_or_else(|| panic!("registration missing for {name}"));
            let got = match function(&args) {
                Ok(v) => json!({"value":encode(v)}),
                Err(Failure::Thrown(e)) => json!({"thrown":e}),
                Err(e) => panic!("unexpected refusal for {name}: {e}"),
            };
            let expected = if let Some(value) = row.get("value") {
                json!({"value":value})
            } else {
                json!({"thrown":row["thrown"]})
            };
            if got != expected {
                mismatches.push(format!(
                    "case {i} {name} {} {:?}: expected {expected}, got {got}",
                    row["label"], args
                ));
            }
        }
    });
    assert!(
        mismatches.is_empty(),
        "{} differences:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
#[test]
fn every_engineering_result_matches_the_original_bit_for_bit() {
    replay(&twin::load_golden("office-engineering"));
}
#[test]
fn coverage_and_original_undefined_aliases_are_explicit() {
    let g = twin::load_golden("office-engineering");
    let names = g["names"].as_array().unwrap();
    assert_eq!(names.len(), 52);
    for name in names {
        let name = name.as_str().unwrap();
        assert!(library().resolve(name).is_some(), "{name}");
        assert!(
            g["cases"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["name"] == name),
            "{name}"
        );
    }
    for unavailable in g["unavailable"].as_array().unwrap() {
        assert_eq!(unavailable["type"], "undefined");
        let name = unavailable["name"].as_str().unwrap();
        assert!(
            library().resolve(name).is_none(),
            "original exports no callable {name}"
        );
    }
    // These observations are not successful calls or invented library errors.
    // The original loops indefinitely for n=+Infinity and x=1; do not run such
    // an unbounded calculation in a unit-test process.
    assert_eq!(g["nonterminating"].as_array().unwrap().len(), 2);
}
#[test]
#[ignore = "runs original Node libraries; set MIXDOG_NODE_TREE"]
fn twin_live_engineering() {
    let tree = twin::node_source_root();
    let raw = twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-engineering.mjs",
        &tree,
    );
    let g: Json = serde_json::from_str(&raw).unwrap();
    assert_eq!(g, twin::load_golden("office-engineering"));
    replay(&g);
}
