//! How a route's context share is resolved: the model's default window, ten-point steps, an explicit token count, and a window
//! the model does not state.

use mixdog_ai::service::admin_route::ContextState;
use mixdog_ai::service::admin_route::resolve_route_context_state;
use mixdog_ai::service::admin_route::window_meta_of;
use serde_json::Value;
use serde_json::json;

fn state(route: Value, meta: Value) -> ContextState {
    let route = route.as_object().cloned().expect("route");
    resolve_route_context_state(&route, window_meta_of(Some(&meta), None))
}

fn of(percent: f64, default_percent: f64, selected: f64, tokens: Option<f64>) -> ContextState {
    ContextState {
        context_percent: Some(percent),
        context_default_percent: Some(default_percent),
        selected_context_window: Some(selected),
        context_tokens: tokens,
    }
}

#[test]
fn a_route_without_a_stated_share_takes_the_models_whole_window() {
    let got = state(json!({ "provider": "anthropic" }), json!({ "contextWindow": 200_000 }));
    assert_eq!(got, of(100.0, 100.0, 200_000.0, None));
}

#[test]
fn a_requested_share_snaps_to_ten_points_within_ten_and_a_hundred() {
    let share = |percent: Value| state(json!({ "provider": "anthropic", "contextPercent": percent }), json!({ "contextWindow": 200_000 }));
    assert_eq!(share(json!(55)), of(60.0, 100.0, 120_000.0, None), "55 rounds up to 60");
    assert_eq!(share(json!(54)), of(50.0, 100.0, 100_000.0, None));
    assert_eq!(share(json!(4)), of(10.0, 100.0, 20_000.0, None), "below ten is ten");
    assert_eq!(share(json!(150)), of(100.0, 100.0, 200_000.0, None), "above a hundred is the whole window");
    assert_eq!(share(json!(0)), of(100.0, 100.0, 200_000.0, None), "a cleared share is the model default");
}

#[test]
fn a_window_over_the_default_ceiling_defaults_to_the_ceiling_but_may_be_chosen_whole() {
    let meta = json!({ "contextWindow": 1_000_000 });
    assert_eq!(state(json!({ "provider": "anthropic" }), meta.clone()), of(50.0, 50.0, 500_000.0, None));
    assert_eq!(state(json!({ "provider": "anthropic", "contextPercent": 100 }), meta.clone()), of(100.0, 50.0, 1_000_000.0, None));
    assert_eq!(state(json!({ "provider": "local" }), meta), of(100.0, 100.0, 1_000_000.0, None), "a local model has no ceiling");
}

#[test]
fn an_explicit_token_count_is_kept_unless_it_is_the_default_and_never_below_a_tenth_of_the_window() {
    let meta = json!({ "contextWindow": 200_000 });
    let tokens = |n: u64| state(json!({ "provider": "anthropic", "contextTokens": n }), meta.clone());
    assert_eq!(tokens(50_000), of(30.0, 100.0, 50_000.0, Some(50_000.0)));
    assert_eq!(tokens(200_000), of(100.0, 100.0, 200_000.0, None), "the default window is not recorded as a choice");
    assert_eq!(tokens(1_000), of(10.0, 100.0, 20_000.0, Some(20_000.0)));
    assert_eq!(tokens(900_000), of(100.0, 100.0, 200_000.0, None), "capped at the window");
}

#[test]
fn a_model_that_states_no_window_has_no_share_at_all() {
    assert_eq!(state(json!({ "provider": "anthropic", "contextPercent": 50 }), json!({})), ContextState::default());
}

#[test]
fn the_cached_provider_row_sizes_a_route_whose_own_row_states_no_window() {
    let route = json!({ "provider": "anthropic" }).as_object().cloned().unwrap();
    let (own, cached) = (json!({}), json!({ "contextWindow": 100_000 }));
    assert_eq!(resolve_route_context_state(&route, window_meta_of(Some(&own), Some(&cached))), of(100.0, 100.0, 100_000.0, None));
    let stated = json!({ "contextWindow": 200_000 });
    assert_eq!(resolve_route_context_state(&route, window_meta_of(Some(&stated), Some(&cached))), of(100.0, 100.0, 200_000.0, None));
}
