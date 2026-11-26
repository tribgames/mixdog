//! The saved per-model settings of a route and the fast setting's rules (`save_model_settings`, `fast_preference_for`,
//! `selection_fast_capable`, `window_meta_of`, `tunes_non_main_model`), over configs and routes written inline.

use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::fast_preference_for;
use mixdog_ai::service::admin_route::model_settings_for;
use mixdog_ai::service::admin_route::route_fast_key;
use mixdog_ai::service::admin_route::save_model_settings;
use mixdog_ai::service::admin_route::selection_fast_capable;
use mixdog_ai::service::admin_route::tunes_non_main_model;
use mixdog_ai::service::admin_route::window_meta_of;
use serde_json::Value;
use serde_json::json;

fn obj(value: Value) -> Obj {
    value.as_object().expect("an object").clone()
}

fn saved(config: &Obj) -> Value {
    config.get("modelSettings").and_then(|s| s.get("openai/gpt-5")).cloned().expect("settings for openai/gpt-5")
}

fn save(config: Value, route: Value, fast_capable: bool) -> Obj {
    let mut config = obj(config);
    save_model_settings(&mut config, &obj(route), fast_capable);
    config
}

fn number(value: &Value) -> f64 {
    value.as_f64().expect("a number")
}

#[test]
fn a_routes_key_is_provider_slash_model_and_nothing_when_either_is_empty() {
    assert_eq!(route_fast_key(Some(&json!(" openai ")), Some(&json!(" gpt-5 "))), "openai/gpt-5");
    assert_eq!(route_fast_key(Some(&json!("openai")), Some(&json!(""))), "");
    assert_eq!(route_fast_key(None, Some(&json!("gpt-5"))), "");
}

#[test]
fn saving_a_route_keeps_its_effort_and_its_fast_choice_only_where_fast_is_possible() {
    let route = json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "fast": true });
    assert_eq!(saved(&save(json!({}), route.clone(), true)), json!({ "effort": "high", "fast": true }));
    assert_eq!(saved(&save(json!({}), route, false)), json!({ "effort": "high", "fast": false }), "a model that cannot go fast saves it off");
}

#[test]
fn a_route_without_effort_clears_the_saved_one_and_leaves_other_models_alone() {
    let config = json!({ "modelSettings": { "openai/gpt-5": { "effort": "low", "fast": true }, "other/m": { "effort": "low" } } });
    let after = save(config, json!({ "provider": "openai", "model": "gpt-5" }), true);
    assert_eq!(saved(&after), json!({ "fast": false }));
    assert_eq!(after["modelSettings"]["other/m"], json!({ "effort": "low" }));
}

#[test]
fn effort_auto_saves_explicit_true_and_false_while_absent_leaves_saved_state_alone() {
    let base = json!({ "modelSettings": { "openai/gpt-5": { "effortAuto": false } } });
    let route = |extra: Value| {
        let mut route = json!({ "provider": "openai", "model": "gpt-5" });
        route.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        route
    };
    assert_eq!(saved(&save(json!({}), route(json!({ "effortAuto": false })), true))["effortAuto"], false);
    assert_eq!(saved(&save(base.clone(), route(json!({ "effortAuto": true })), true))["effortAuto"], true);
    assert_eq!(saved(&save(base, route(json!({})), true))["effortAuto"], false);
    assert!(saved(&save(json!({}), route(json!({})), true)).get("effortAuto").is_none());
}

#[test]
fn model_parameters_are_saved_trimmed_without_empty_entries_and_an_array_saves_none() {
    let route = |parameters: Value| json!({ "provider": "openai", "model": "gpt-5", "modelParameters": parameters });
    assert_eq!(saved(&save(json!({}), route(json!({ " a ": 1, "b": "", "c": null, " ": "x" })), true))["modelParameters"], json!({ "a": "1" }));
    assert_eq!(saved(&save(json!({}), route(json!([1])), true))["modelParameters"], json!({}));
    let kept = json!({ "modelSettings": { "openai/gpt-5": { "modelParameters": { "a": "1" } } } });
    assert!(
        saved(&save(kept, json!({ "provider": "openai", "model": "gpt-5" }), true)).get("modelParameters").is_none(),
        "a route without parameters clears them"
    );
}

#[test]
fn a_context_share_is_saved_only_when_it_differs_from_the_models_default() {
    let route = |percent: Value| json!({ "provider": "openai", "model": "gpt-5", "contextPercent": percent, "contextDefaultPercent": 100 });
    assert_eq!(number(&saved(&save(json!({}), route(json!(50)), true))["contextPercent"]), 50.0);
    assert_eq!(number(&saved(&save(json!({}), route(json!(55)), true))["contextPercent"]), 60.0, "snapped to ten points");
    assert!(saved(&save(json!({}), route(json!(100)), true)).get("contextPercent").is_none(), "the default is not saved");
    assert!(saved(&save(json!({}), route(json!(5)), true)).get("contextPercent").is_none(), "below ten is no share");
}

#[test]
fn a_token_count_replaces_a_saved_share_and_a_share_replaces_a_saved_token_count() {
    let tokens = save(
        json!({ "modelSettings": { "openai/gpt-5": { "contextPercent": 50 } } }),
        json!({ "provider": "openai", "model": "gpt-5", "contextTokens": 300000.4 }),
        true,
    );
    let after = saved(&tokens);
    assert_eq!(number(&after["contextTokens"]), 300000.0);
    assert!(after.get("contextPercent").is_none());
    let share = save(
        json!({ "modelSettings": { "openai/gpt-5": { "contextTokens": 300000 } } }),
        json!({ "provider": "openai", "model": "gpt-5", "contextPercent": 30, "contextDefaultPercent": 100 }),
        true,
    );
    let after = saved(&share);
    assert_eq!(number(&after["contextPercent"]), 30.0);
    assert!(after.get("contextTokens").is_none());
}

#[test]
fn a_route_without_a_provider_or_model_saves_nothing() {
    assert_eq!(save(json!({ "a": 1 }), json!({ "model": "gpt-5", "effort": "high" }), true), obj(json!({ "a": 1 })));
}

#[test]
fn fast_is_preferred_only_when_it_was_saved_as_true() {
    let config =
        obj(json!({ "modelSettings": { "openai/gpt-5": { "fast": true }, "openai/mini": { "fast": "true" }, "openai/off": { "fast": false }, "bad/m": 3 } }));
    assert!(fast_preference_for(&config, "openai", "gpt-5"));
    for model in ["mini", "off", "missing"] {
        assert!(!fast_preference_for(&config, "openai", model), "{model}");
    }
    assert!(!fast_preference_for(&config, "bad", "m"));
    assert!(!fast_preference_for(&config, "", "gpt-5"));
    assert_eq!(model_settings_for(&config, "openai", "gpt-5"), obj(json!({ "fast": true })));
    assert!(model_settings_for(&config, "bad", "m").is_empty());
}

#[test]
fn placeholder_model_metadata_is_unknown_not_no_fast_and_the_catalog_is_asked_only_for_a_resolved_row() {
    let mut asked = 0;
    for placeholder in [None, Some(json!({})), Some(json!({ "id": "gpt-5", "provider": "openai" }))] {
        assert!(
            selection_fast_capable(placeholder.as_ref(), || {
                asked += 1;
                false
            }),
            "{placeholder:?}"
        );
    }
    assert_eq!(asked, 0);
    let resolved = json!({ "id": "gpt-5", "provider": "openai", "contextWindow": 400000 });
    assert!(!selection_fast_capable(Some(&resolved), || {
        asked += 1;
        false
    }));
    assert!(selection_fast_capable(Some(&resolved), || {
        asked += 1;
        true
    }));
    assert_eq!(asked, 2);
}

#[test]
fn a_rows_own_windows_win_over_the_cached_ones_only_when_it_states_one() {
    let (stated, bare, cached) = (json!({ "contextWindow": 1000 }), json!({ "id": "m" }), json!({ "contextWindow": 2000 }));
    assert_eq!(window_meta_of(Some(&stated), Some(&cached)), Some(&stated));
    assert_eq!(window_meta_of(Some(&bare), Some(&cached)), Some(&cached));
    assert_eq!(window_meta_of(Some(&bare), None), Some(&bare));
    assert_eq!(window_meta_of(None, None), None);
}

#[test]
fn retuning_the_live_model_is_not_a_main_model_choice() {
    let (live, main, other) =
        (obj(json!({ "provider": "a", "model": "m" })), obj(json!({ "provider": "b", "model": "n" })), obj(json!({ "provider": "a", "model": "m" })));
    assert!(tunes_non_main_model(&live, &other, &main));
    assert!(!tunes_non_main_model(&live, &other, &live), "the live model is the main one");
    assert!(!tunes_non_main_model(&live, &main, &main));
}
