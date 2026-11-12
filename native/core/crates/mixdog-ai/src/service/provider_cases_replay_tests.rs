//! Two pure provider-service recordings of `b6f10295a`, replayed whole:
//! - `fixtures/provider-model-recency` (`model-recency.test.mjs`): every `providerModelCacheRow(name, row)` call the
//!   recorder made, its row compared field by field (an `undefined` field is an absent one);
//! - `fixtures/provider-custom-provider-route` (`custom-provider-route.test.mjs`): the default provider the saved config
//!   names and the route over it, and the config the validator received on each call.

use std::cell::RefCell;

use serde_json::Value;
use serde_json::json;

use super::admin_models::provider_model_cache_row;
use super::admin_route::Obj;
use super::admin_route::resolve_default_provider;
use super::admin_route::resolve_route;
use crate::providers::case_replay::cases;
use crate::providers::case_replay::without_undefined;

/// The rows a case's `providerModelCacheRow` calls returned, in call order, from the case's recorded result.
fn recorded_rows(id: &str, result: &Value) -> Vec<Value> {
    match id {
        "window-range-default" | "window-left-as-stated" => result.as_array().unwrap().iter().map(|r| r["row"].clone()).collect(),
        "custom-row-effective-fields" => vec![result["row"].clone(), result["hiddenOnly"].clone()],
        "first-party-row-unchanged-by-custom-fields" => vec![result["row"].clone(), result["bare"].clone()],
        other => panic!("a recorded case this replay does not know: {other}"),
    }
}

#[test]
fn a_cache_row_is_node_s_for_every_recorded_call() {
    let set = cases(mixdog_testkit::fixture!("../../fixtures/provider-model-recency/cases.json"));
    for case in set["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let calls = case["calls"].as_array().unwrap();
        let rows = recorded_rows(id, &case["result"]);
        assert_eq!(calls.len(), rows.len(), "{id}: one row per call");
        for (n, (call, row)) in calls.iter().zip(&rows).enumerate() {
            let args = call["args"].as_array().unwrap();
            // The third argument is the recorder's `webSearchCapableFor` callback; every recorded row says it is not.
            let got = Value::Object(provider_model_cache_row(args[0].as_str().unwrap(), &args[1], false));
            assert_eq!(got, without_undefined(row), "{id}: call {n}");
        }
    }
}

#[test]
fn the_default_provider_validator_is_given_the_saved_config_as_node_gives_it() {
    let set = cases(mixdog_testkit::fixture!("../../fixtures/provider-custom-provider-route/cases.json"));
    for case in set["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let config: Obj = case["input"]["config"].as_object().unwrap().clone();
        let seen: RefCell<Vec<Value>> = RefCell::new(Vec::new());
        // The test's validator: `providers[id].type === "custom"`.
        let known = |provider: &str, current: &Obj| {
            seen.borrow_mut().push(json!({"id": provider, "config": current, "sameConfigObject": std::ptr::eq(current, &config)}));
            current["providers"][provider]["type"] == "custom"
        };
        let node = &case["result"];
        let default_provider = resolve_default_provider(&config, &known);
        let request: Obj = case["input"]["request"].as_object().unwrap().clone();
        let route = Value::Object(resolve_route(&config, &request, &known).unwrap());
        assert_eq!(json!(default_provider), node["defaultProvider"], "{id}: the default provider");
        assert_eq!(route, without_undefined(&node["route"]), "{id}: the route");
        assert_eq!(Value::Array(seen.into_inner()), node["validatorCalls"], "{id}: what the validator received");
    }
}
