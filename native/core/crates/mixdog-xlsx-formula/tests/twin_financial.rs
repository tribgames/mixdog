//! Source-derived exact-bit financial replay. Calendar cases use the actual
//! registered datetime functions; no replacement day-count stubs are installed.
use mixdog_office_base::twin;
use mixdog_xlsx_formula::{ErrorValue, Failure, Registry, Value, coerce, registry};
use serde_json::{Value as Json, json};
mod value {
    pub use mixdog_xlsx_formula::{ErrorValue, Failure, Value};
}
#[path = "../src/functions/financial.rs"]
mod financial;
const CALENDAR_FUNCTIONS: &[&str] = &[
    "ACCRINT",
    "COUPDAYS",
    "DISC",
    "PRICEDISC",
    "TBILLEQ",
    "TBILLPRICE",
    "TBILLYIELD",
    "XIRR",
    "XNPV",
];
const CALENDAR_DEPENDENCIES: &[&str] = &["YEARFRAC", "DATEDIF", "DAYS360", "DAYS"];
fn number(v: &Json) -> f64 {
    f64::from_bits(u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap())
}
fn decode(v: &Json) -> Value {
    match v["t"].as_str().unwrap() {
        "number" => Value::Number(number(v)),
        "date" => Value::Date(number(v)),
        "undefined" => Value::Undefined,
        "null" => Value::Null,
        "bool" => Value::Bool(v["v"].as_bool().unwrap()),
        "text" => Value::text(v["v"].as_str().unwrap()),
        "error" => Value::Error(ErrorValue::from_message(v["v"].as_str().unwrap()).unwrap()),
        "array" => Value::Array(v["v"].as_array().unwrap().iter().map(decode).collect()),
        other => panic!("unknown type {other}"),
    }
}
fn encode(v: &Value) -> Json {
    match v {
        Value::Number(n) => json!({"t":"number","bits":format!("{:016x}",n.to_bits())}),
        Value::Date(n) => json!({"t":"date","bits":format!("{:016x}",n.to_bits())}),
        Value::Undefined => json!({"t":"undefined"}),
        Value::Null => json!({"t":"null"}),
        Value::Bool(v) => json!({"t":"bool","v":v}),
        Value::Text(v) => json!({"t":"text","v":v}),
        Value::Utf16(units) => json!({"t":"text","units":units}),
        Value::Error(e) => json!({"t":"error","v":e.message()}),
        Value::Array(a) => json!({"t":"array","v":a.iter().map(encode).collect::<Vec<_>>()}),
    }
}
fn golden() -> Json {
    serde_json::from_str(include_str!(
        "../../../fixtures/office-financial/golden.json"
    ))
    .unwrap()
}
fn replay(calendar: bool) {
    let registry = Registry::new(&[financial::FUNCTIONS]);
    let golden = golden();
    let mut errors = Vec::new();
    let mut compared = 0;
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        if CALENDAR_FUNCTIONS.contains(&name) != calendar {
            continue;
        }
        let args: Vec<_> = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        let actual = mixdog_js::time::with_local_zone(
            case["zone"].as_str().unwrap().parse().unwrap(),
            || registry.resolve(name).unwrap()(&args),
        );
        let actual = match actual {
            Ok(v) => json!({"value":encode(&v)}),
            Err(Failure::Thrown(s)) => json!({"threw":s}),
            Err(Failure::Unsupported(s)) => {
                panic!("missing integration dependency for {name}: {}", s.reason)
            }
        };
        let expected = if let Some(v) = case.get("value") {
            json!({"value":v})
        } else {
            json!({"threw":case["threw"]})
        };
        compared += 1;
        if actual != expected {
            errors.push(format!(
                "{index} {name} {}: args={} expected={expected}, got={actual}",
                case["label"], case["args"]
            ));
        }
    }
    assert!(compared > 100);
    assert!(
        errors.is_empty(),
        "{} exact-bit mismatches:\n{}",
        errors.len(),
        errors
            .iter()
            .take(60)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
#[test]
fn every_original_financial_export_has_one_body() {
    let golden = golden();
    assert_eq!(golden["library"], "4.6.1");
    assert_eq!(financial::FUNCTIONS.len(), 33);
    let expected: std::collections::BTreeSet<_> = golden["functions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let actual: std::collections::BTreeSet<_> =
        financial::FUNCTIONS.iter().map(|(name, _)| *name).collect();
    assert_eq!(actual, expected);
    assert!(Registry::duplicates(&[financial::FUNCTIONS]).is_empty());
    assert!(golden["cases"].as_array().unwrap().len() > 3000);
    // The original nonterminating IRR(+Infinity) is a diagnostic, never an
    // invented successful error/value and never a hanging normal replay case.
    assert_eq!(golden["nontermination"].as_array().unwrap().len(), 1);
    assert_eq!(golden["nontermination"][0]["name"], "IRR");
}
#[test]
fn financial_noncalendar_results_equal_original_bits() {
    replay(false)
}
#[test]
fn financial_calendar_results_equal_original_bits() {
    for name in CALENDAR_DEPENDENCIES {
        assert!(
            mixdog_xlsx_formula::library().resolve(name).is_some(),
            "register datetime dependency {name} before financial calendar replay"
        );
    }
    replay(true)
}
#[test]
fn financial_exports_are_registered_in_the_production_library() {
    for (name, _) in financial::FUNCTIONS {
        assert!(
            mixdog_xlsx_formula::library().resolve(name).is_some(),
            "{name}"
        );
    }
}
#[test]
#[ignore = "runs the bounded original Node/formulajs recorder, including its explicit 1-second nontermination probe"]
fn twin_live_financial() {
    let output = twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-financial.mjs",
        &twin::node_source_root(),
    );
    let actual: Json = serde_json::from_str(&output).unwrap();
    let expected = golden();
    assert_eq!(actual["sourceSha256"], expected["sourceSha256"]);
    assert_eq!(actual["functions"], expected["functions"]);
    assert_eq!(actual["cases"], expected["cases"]);
    assert_eq!(actual["nontermination"], expected["nontermination"]);
}
