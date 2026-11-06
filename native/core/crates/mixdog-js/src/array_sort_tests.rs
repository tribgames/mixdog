//! Node-recorded twin: `fixtures/ai-admin/js-array-sort-twin.json`
//! (`benchmarks/rust-core/recorders/record-js-array-sort.mjs`).
use serde_json::Value;

use super::js_sort_by;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/ai-admin/js-array-sort-twin.json")).unwrap()
}

type Compare = Box<dyn Fn(&i64, &i64) -> f64>;

fn comparator(kind: &str, k: i64) -> Compare {
    match kind {
        "numeric" => Box::new(|a, b| (a - b) as f64),
        "descending" => Box::new(|a, b| (b - a) as f64),
        "ties" => Box::new(|a, b| ((a % 5) - (b % 5)) as f64),
        "cyclic" => Box::new(move |a, b| (((a * 7919 + b * 104_729 + k) % 7) - 3) as f64),
        "mostlyOrdered" => Box::new(move |a, b| if (a + b + k) % 11 == 0 { (b - a) as f64 } else { (a - b) as f64 }),
        "nan" => Box::new(|a, b| if a % 3 == 0 || b % 3 == 0 { f64::NAN } else { (a - b) as f64 }),
        other => panic!("{other}"),
    }
}

#[test]
fn the_sort_matches_v8() {
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        let numbers = |key: &str| -> Vec<i64> { case[key].as_array().unwrap().iter().map(|n| n.as_i64().unwrap()).collect() };
        let mut items = numbers("input");
        let size = items.len();
        let compare = comparator(case["kind"].as_str().unwrap(), case["k"].as_i64().unwrap());
        js_sort_by(&mut items, |a, b| compare(a, b));
        assert_eq!(items, numbers("output"), "case {i}: {} k={} size {size}", case["kind"], case["k"]);
    }
}
