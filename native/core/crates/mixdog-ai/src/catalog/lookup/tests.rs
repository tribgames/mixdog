//! The Rust lookup against the Node golden: `getModelMetadataSync` for every
//! (provider, model) of the matrix and `enrichModels` for the listed rows,
//! recorded by `fixtures/catalog-lookup/record.mjs`.

use serde_json::Value;

use super::Lookup;
use super::enrich_model;
use super::fixtures::GOLDEN;
use super::fixtures::LITELLM;
use super::fixtures::MODELS_DEV;
use super::fixtures::json;
use super::fixtures::rosters;
use super::fixtures::same;
use super::project_litellm;
use super::project_models_dev;

fn report(failures: &[String]) {
    assert!(failures.is_empty(), "{} differ from Node; first:\n{}", failures.len(), failures.iter().take(6).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn every_lookup_equals_node() {
    let litellm = project_litellm(&json(LITELLM));
    let models_dev = project_models_dev(&json(MODELS_DEV));
    let rosters = rosters();
    let lookup = Lookup { litellm: &litellm, models_dev: &models_dev, rosters: &rosters };
    let golden = json(GOLDEN);
    let mut failures = Vec::new();
    let mut known = 0;
    for row in golden["rows"].as_array().unwrap() {
        let provider = row["provider"].as_str().unwrap();
        let id = row["id"].as_str().unwrap();
        let got = lookup.lookup(id, provider, None).map_or(Value::Null, Value::Object);
        known += usize::from(!got.is_null());
        if !same(&got, &row["meta"]) {
            failures.push(format!("{provider:?} {id:?}\n  rust: {got}\n  node: {}", row["meta"]));
        }
    }
    report(&failures);
    assert!(known > 300, "the matrix must exercise the layers ({known} known)");
}

#[test]
fn every_enrichment_equals_node() {
    let litellm = project_litellm(&json(LITELLM));
    let models_dev = project_models_dev(&json(MODELS_DEV));
    let rosters = rosters();
    let lookup = Lookup { litellm: &litellm, models_dev: &models_dev, rosters: &rosters };
    let golden = json(GOLDEN);
    let mut failures = Vec::new();
    for case in golden["enriched"].as_array().unwrap() {
        let got = enrich_model(&lookup, &case["input"]);
        if !same(&got, &case["out"]) {
            failures.push(format!("{}\n  rust: {got}\n  node: {}", case["input"], case["out"]));
        }
    }
    report(&failures);
}
