//! The recorded Node fixtures (`fixtures/catalog-lookup`), shared by the
//! lookup and the fast-tier tests.

use serde_json::Value;

use crate::catalog::rosters::Rosters;

pub const LITELLM: &str = include_str!("../../../fixtures/catalog-lookup/litellm.json");
pub const MODELS_DEV: &str = include_str!("../../../fixtures/catalog-lookup/modelsdev.json");
pub const ROSTERS: &str = include_str!("../../../fixtures/catalog-lookup/rosters.json");
pub const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("fixtures/catalog-lookup/golden.json");
pub const PRICING_EXTRA: &str = include_str!("../../../fixtures/catalog-lookup/pricing-extra-litellm.json");
pub const PRICING_GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("fixtures/catalog-lookup/pricing-golden.json");

pub fn json(text: &str) -> Value {
    serde_json::from_str(text).expect("a fixture")
}

/// The roster files as the data directory holds them: a `models` document or a bare array.
pub fn rosters() -> Rosters {
    let files = json(ROSTERS);
    Rosters::from_rows(files.as_object().expect("files").iter().map(|(name, body)| {
        let rows = body.as_array().or_else(|| body.get("models").and_then(Value::as_array)).cloned().unwrap_or_default();
        (name.clone(), rows)
    }))
}

/// JSON equality where `1` and `1.0` are one number.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}
