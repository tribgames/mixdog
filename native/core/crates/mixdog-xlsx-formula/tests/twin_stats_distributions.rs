//! Strict original formulajs/jStat outputs. No engine normalization or ULP allowance.
use mixdog_office_base::twin;
use mixdog_xlsx_formula::{ErrorValue, Failure, Value, library};
use serde_json::{Value as Json, json};
fn number(v: &Json) -> f64 {
    f64::from_bits(u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap())
}
fn decode(v: &Json) -> Value {
    match v["t"].as_str().unwrap() {
        "undefined" => Value::Undefined,
        "null" => Value::Null,
        "number" => Value::Number(number(v)),
        "date" => Value::Date(number(v)),
        "text" => match v.get("units") {
            Some(units) => Value::from_utf16(
                units
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|unit| u16::try_from(unit.as_u64().unwrap()).unwrap())
                    .collect(),
            ),
            None => Value::Text(v["v"].as_str().unwrap().to_owned()),
        },
        "bool" => Value::Bool(v["v"].as_bool().unwrap()),
        "error" => Value::Error(ErrorValue::from_message(v["v"].as_str().unwrap()).unwrap()),
        "array" => Value::Array(v["v"].as_array().unwrap().iter().map(decode).collect()),
        _ => panic!("unknown input {v}"),
    }
}
fn encode(v: Value) -> Json {
    match v {
        Value::Undefined => json!({"t":"undefined"}),
        Value::Null => json!({"t":"null"}),
        Value::Number(n) => json!({"t":"number","bits":format!("{:016x}",n.to_bits())}),
        Value::Date(n) => json!({"t":"date","bits":format!("{:016x}",n.to_bits())}),
        Value::Text(v) => json!({"t":"text","v":v}),
        Value::Utf16(units) => json!({"t":"text","units":units}),
        Value::Bool(v) => json!({"t":"bool","v":v}),
        Value::Error(e) => json!({"t":"error","v":e.message()}),
        Value::Array(v) => json!({"t":"array","v":v.into_iter().map(encode).collect::<Vec<_>>()}),
    }
}
fn golden() -> Json {
    serde_json::from_str(include_str!(
        "../../../fixtures/office-stats-distributions/golden.json"
    ))
    .unwrap()
}
fn replay(g: &Json) {
    let mut wrong = Vec::new();
    let rows = g["cases"].as_array().unwrap();
    assert!(rows.len() > 5000);
    for (index, row) in rows.iter().enumerate() {
        let name = row["name"].as_str().unwrap();
        let args: Vec<_> = row["args"].as_array().unwrap().iter().map(decode).collect();
        let function = library()
            .resolve(name)
            .unwrap_or_else(|| panic!("missing distribution registration {name}"));
        let actual = match function(&args) {
            Ok(v) => json!({"value":encode(v)}),
            Err(Failure::Thrown(e)) => json!({"threw":e}),
            Err(Failure::Unsupported(e)) => panic!("{name}: missing prerequisite {}", e.reason),
        };
        let expected = if let Some(v) = row.get("value") {
            json!({"value":v})
        } else {
            json!({"threw":row["threw"]})
        };
        if actual != expected {
            wrong.push(format!(
                "{index} {name} {} args={} expected={expected}, got={actual}",
                row["label"], row["args"]
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} exact mismatches:\n{}",
        wrong.len(),
        wrong
            .iter()
            .take(80)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
#[test]
fn every_distribution_and_legacy_property_alias_is_registered() {
    let g = golden();
    assert_eq!(g["oracle"]["formulajs"], "4.6.1");
    assert_eq!(g["oracle"]["jstat"], "1.9.6");
    let names = g["functions"].as_array().unwrap();
    assert_eq!(names.len(), 85);
    for row in names {
        let name = row["name"].as_str().unwrap();
        let canonical = row["canonical"].as_str().unwrap();
        let alias = library().resolve(name).unwrap_or_else(|| panic!("{name}"));
        let target = library()
            .resolve(canonical)
            .unwrap_or_else(|| panic!("{canonical}"));
        assert!(
            std::ptr::fn_addr_eq(alias, target),
            "{name} aliases {canonical}"
        );
    }
    for name in ["COMBIN", "SUM", "AVERAGE", "STDEV.S"] {
        assert!(library().resolve(name).is_some(), "shared {name}");
    }
    assert_eq!(g["nonterminating"].as_array().unwrap().len(), 1);
    assert_eq!(g["nonterminating"][0]["name"], "BINOM.INV");
    assert!(!g["boundedDomainOmissions"].as_array().unwrap().is_empty());
}
#[test]
fn every_distribution_result_equals_original_bits_types_and_errors() {
    replay(&golden())
}
#[test]
#[ignore = "bounded original Node reference recording, no fixture writes"]
fn twin_live_stats_distributions() {
    let output = twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-stats-distributions.mjs",
        &twin::node_source_root(),
    );
    let live: Json = serde_json::from_str(&output).unwrap();
    assert_eq!(live, golden());
    replay(&live)
}
