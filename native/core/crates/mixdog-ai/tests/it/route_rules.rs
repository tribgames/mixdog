//! Route resolution and the saved per-model settings: how a request becomes a route over the user's presets and saved
//! choices, what a selection is allowed to say, how a route's context window is sized, and what the Lead preset keeps.

use mixdog_ai::service::admin_route::ContextState;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::finish_chain_entry;
use mixdog_ai::service::admin_route::is_likely_raw_model_id;
use mixdog_ai::service::admin_route::normalize_workflow_route;
use mixdog_ai::service::admin_route::persist_adopted_model_settings;
use mixdog_ai::service::admin_route::refresh_route_fields;
use mixdog_ai::service::admin_route::required_model_selection;
use mixdog_ai::service::admin_route::resolve_default_provider;
use mixdog_ai::service::admin_route::resolve_route;
use mixdog_ai::service::admin_route::resolve_route_context_state;
use mixdog_ai::service::admin_route::route_model_display;
use mixdog_ai::service::admin_route::save_model_settings;
use mixdog_ai::service::admin_route::start_chain_entry;
use mixdog_ai::service::admin_route::tunes_non_main_model;
use mixdog_ai::service::admin_route::upsert_workflow_preset;
use mixdog_ai::service::admin_route::validate_requested_model_selector;
use serde_json::Value;
use serde_json::json;

fn obj(value: Value) -> Obj {
    value.as_object().cloned().unwrap()
}

fn known(names: &'static [&'static str]) -> impl Fn(&str, &Obj) -> bool {
    move |provider, _| names.contains(&provider)
}

fn lead_config() -> Obj {
    obj(json!({
        "default": "lead",
        "presets": [{"id": "lead", "name": "Lead", "provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true}],
        "modelSettings": {"openai-oauth/gpt-5": {"effort": "low", "fast": false, "modelParameters": {"context": "1m"}, "contextPercent": 60}},
    }))
}

// the default provider

#[test]
fn the_default_provider_is_the_default_presets_when_it_is_known_else_the_built_in_one() {
    let config = lead_config();
    assert_eq!(resolve_default_provider(&config, &known(&["openai-oauth"])), "openai-oauth");
    assert_eq!(resolve_default_provider(&config, &known(&[])), "anthropic-oauth");
    assert_eq!(resolve_default_provider(&Obj::new(), &known(&["openai-oauth"])), "anthropic-oauth");
}

#[test]
fn the_validator_is_asked_about_the_trimmed_preset_provider_with_the_saved_config() {
    let config = obj(json!({"default": "p", "presets": [{"id": "p", "provider": "  box  ", "model": "m"}], "marker": 1}));
    let seen = std::cell::RefCell::new(Vec::new());
    let provider = resolve_default_provider(&config, &|name: &str, cfg: &Obj| {
        seen.borrow_mut().push((name.to_owned(), cfg.get("marker").cloned()));
        true
    });
    assert_eq!(provider, "box");
    assert_eq!(seen.into_inner(), [("box".to_owned(), Some(json!(1)))]);
}

// resolve_route

#[test]
fn a_request_naming_nothing_follows_the_default_preset_with_its_values() {
    let route = resolve_route(&lead_config(), &Obj::new(), &known(&[])).unwrap();
    assert_eq!((route["provider"].clone(), route["model"].clone()), (json!("openai-oauth"), json!("gpt-5")));
    assert_eq!(route["preset"]["id"], "lead");
    // The user's saved choices for the model come before the preset's own values.
    assert_eq!((route["effort"].clone(), route["fast"].clone()), (json!("low"), json!(false)));
    assert_eq!((route["modelParameters"].clone(), route["contextPercent"].clone()), (json!({"context": "1m"}), json!(60)));
    assert_eq!(route["autoEffort"], true);
}

#[test]
fn a_model_that_names_a_preset_by_id_or_name_selects_that_preset_in_any_letter_case() {
    let config = obj(json!({"presets": [{"id": "work", "name": "Work Horse", "provider": "anthropic-oauth", "model": "claude-opus-4-5", "fast": true}]}));
    for name in ["work", "WORK", " Work Horse "] {
        let route = resolve_route(&config, &obj(json!({"model": name})), &known(&[])).unwrap();
        assert_eq!(
            (route["provider"].clone(), route["model"].clone(), route["fast"].clone()),
            (json!("anthropic-oauth"), json!("claude-opus-4-5"), json!(true)),
            "{name}"
        );
    }
}

#[test]
fn a_named_provider_and_model_bypass_the_presets_and_start_from_the_saved_settings() {
    let config = lead_config();
    let route = resolve_route(&config, &obj(json!({"provider": "openai-oauth", "model": "gpt-5"})), &known(&[])).unwrap();
    assert_eq!(route["preset"], Value::Null);
    assert_eq!((route["effort"].clone(), route["fast"].clone()), (json!("low"), json!(false)));
    let other = resolve_route(&config, &obj(json!({"provider": "openai-oauth", "model": "gpt-4.1"})), &known(&[])).unwrap();
    assert_eq!((other["effort"].clone(), other["fast"].clone(), other["modelParameters"].clone()), (Value::Null, json!(false), json!({})));
}

#[test]
fn a_model_without_a_provider_runs_on_the_default_provider() {
    let route = resolve_route(&Obj::new(), &obj(json!({"model": "gpt-5"})), &known(&[])).unwrap();
    assert_eq!((route["provider"].clone(), route["model"].clone()), (json!("anthropic-oauth"), json!("gpt-5")));
}

#[test]
fn what_the_request_states_overrides_what_is_saved() {
    let config = lead_config();
    let ask = |extra: Value| {
        let mut request = obj(json!({"provider": "openai-oauth", "model": "gpt-5"}));
        request.extend(obj(extra));
        resolve_route(&config, &request, &known(&[])).unwrap()
    };
    let route = ask(json!({"effort": "HIGH", "fast": true, "autoEffort": false, "modelParameters": {" k ": " v ", "empty": " "}}));
    assert_eq!((route["effort"].clone(), route["fast"].clone(), route["autoEffort"].clone()), (json!("high"), json!(true), json!(false)));
    assert_eq!(route["modelParameters"], json!({"k": "v"}), "keys and values are trimmed and an empty one is dropped");
    assert_eq!(ask(json!({"effort": "auto"}))["effort"], Value::Null, "auto means no fixed effort");
    assert_eq!(ask(json!({"effort": ""}))["effort"], Value::Null);
}

#[test]
fn an_effort_the_product_does_not_know_refuses_the_request() {
    let error = resolve_route(&Obj::new(), &obj(json!({"provider": "p", "model": "m", "effort": "bogus"})), &known(&[])).unwrap_err();
    assert!(error.starts_with("effort must be one of auto, "), "{error}");
}

#[test]
fn a_context_choice_is_a_percent_in_ten_point_steps_or_a_token_count_never_both() {
    let config = lead_config();
    let ask = |extra: Value| {
        let mut request = obj(json!({"provider": "openai-oauth", "model": "gpt-5"}));
        request.extend(obj(extra));
        resolve_route(&config, &request, &known(&[])).unwrap()
    };
    let by_percent = ask(json!({"contextPercent": 55}));
    assert_eq!(by_percent["contextPercent"], 60, "55 rounds to the nearest ten, halves upward");
    assert!(by_percent.get("contextTokens").is_none());
    let by_tokens = ask(json!({"contextTokens": 120000.4}));
    assert_eq!(by_tokens["contextTokens"], 120000);
    assert!(by_tokens.get("contextPercent").is_none(), "an explicit token count drops the saved percent");
    for bad in [json!(0), json!(-5), json!("x")] {
        assert!(ask(json!({"contextPercent": bad})).get("contextPercent").is_none(), "an unusable percent is no choice");
    }
    assert_eq!(ask(json!({"contextPercent": 5}))["contextPercent"], 10, "below the range is clamped up");
    assert_eq!(ask(json!({"contextPercent": 500}))["contextPercent"], 100);
}

// saving

fn route_of(value: Value) -> Obj {
    obj(value)
}

#[test]
fn saving_a_route_keeps_its_choices_under_provider_slash_model() {
    let mut config = Obj::new();
    let route = route_of(
        json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true, "autoEffort": false, "modelParameters": {"context": "1m", " ": "x"}}),
    );
    save_model_settings(&mut config, &route, true);
    assert_eq!(
        config["modelSettings"]["openai-oauth/gpt-5"],
        json!({"effort": "high", "fast": true, "autoEffort": false, "modelParameters": {"context": "1m"}})
    );
}

#[test]
fn fast_is_saved_only_for_a_model_that_can_run_it_and_default_choices_are_not_saved() {
    let mut config =
        obj(json!({"modelSettings": {"p/m": {"effort": "low", "autoEffort": false, "modelParameters": {"a": "b"}, "contextPercent": 40, "contextTokens": 9}}}));
    let route = route_of(json!({"provider": "p", "model": "m", "fast": true, "autoEffort": true, "contextPercent": 50, "contextDefaultPercent": 50}));
    save_model_settings(&mut config, &route, false);
    let saved = &config["modelSettings"]["p/m"];
    assert_eq!(saved["fast"], false, "a model without Fast saves it off");
    for gone in ["effort", "autoEffort", "modelParameters", "contextPercent", "contextTokens"] {
        assert!(saved.get(gone).is_none(), "{gone}");
    }
}

#[test]
fn a_context_percent_other_than_the_models_default_is_saved_and_a_token_count_replaces_it() {
    let mut config = Obj::new();
    save_model_settings(&mut config, &route_of(json!({"provider": "p", "model": "m", "contextPercent": 44, "contextDefaultPercent": 100})), true);
    assert_eq!(config["modelSettings"]["p/m"]["contextPercent"], 40);
    save_model_settings(&mut config, &route_of(json!({"provider": "p", "model": "m", "contextTokens": 123456, "contextPercent": 40})), true);
    let saved = &config["modelSettings"]["p/m"];
    assert_eq!(saved["contextTokens"], 123456);
    assert!(saved.get("contextPercent").is_none());
}

#[test]
fn a_route_without_a_model_saves_nothing() {
    let mut config = Obj::new();
    save_model_settings(&mut config, &route_of(json!({"provider": "p", "model": " "})), true);
    assert!(config.is_empty());
}

// context windows

fn state(route: Value, meta: Value) -> ContextState {
    resolve_route_context_state(&obj(route), Some(&meta))
}

#[test]
fn a_route_without_a_known_window_has_no_context_state() {
    assert_eq!(resolve_route_context_state(&obj(json!({"provider": "openai"})), None), ContextState::default());
    assert_eq!(state(json!({"provider": "openai"}), json!({"contextWindow": 0})), ContextState::default());
}

#[test]
fn the_default_window_is_chosen_unless_a_percent_or_a_token_count_says_otherwise() {
    let meta = json!({"contextWindow": 200_000, "maxContextWindow": 1_000_000});
    let default = state(json!({"provider": "openai"}), meta.clone());
    assert_eq!(
        (default.context_percent, default.context_default_percent, default.selected_context_window, default.context_tokens),
        (Some(20.0), Some(20.0), Some(200_000.0), None)
    );
    let half = state(json!({"provider": "openai", "contextPercent": 50}), meta.clone());
    assert_eq!((half.context_percent, half.selected_context_window, half.context_tokens), (Some(50.0), Some(500_000.0), None));
    let tokens = state(json!({"provider": "openai", "contextTokens": 300_000}), meta.clone());
    assert_eq!((tokens.context_percent, tokens.selected_context_window, tokens.context_tokens), (Some(30.0), Some(300_000.0), Some(300_000.0)));
    // A count equal to the default window is the default, not a custom size.
    let same = state(json!({"provider": "openai", "contextTokens": 200_000}), meta);
    assert_eq!((same.context_percent, same.selected_context_window, same.context_tokens), (Some(20.0), Some(200_000.0), None));
}

#[test]
fn a_token_count_never_selects_less_than_a_tenth_of_the_largest_window() {
    let meta = json!({"contextWindow": 200_000, "maxContextWindow": 1_000_000});
    let tiny = state(json!({"provider": "openai", "contextTokens": 1000}), meta);
    assert_eq!(tiny.selected_context_window, Some(100_000.0));
}

// what a selection may say

#[test]
fn a_valid_selection_comes_back_trimmed_with_only_what_it_stated() {
    let selection = json!({"model": " gpt-5 ", "provider": " openai-oauth ", "effort": " high ", "fast": true, "contextPercent": 50, "onlyIfEmpty": true});
    let checked = required_model_selection(&selection).unwrap();
    assert_eq!(
        Value::Object(checked),
        json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true, "contextPercent": 50, "onlyIfEmpty": true})
    );
    let plain = required_model_selection(&json!({"provider": "p", "model": "m", "onlyIfEmpty": false})).unwrap();
    assert!(!plain.contains_key("onlyIfEmpty"), "only a true flag is kept");
}

#[test]
fn a_selection_that_is_malformed_is_refused_with_the_field_named() {
    let refuse = |selection: Value| required_model_selection(&selection).unwrap_err();
    assert_eq!(refuse(json!("x")), "model selection is invalid.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m", "extra": 1})), "model selection contains an unsupported field.");
    assert_eq!(refuse(json!({})), "selection.provider must be a string.");
    assert_eq!(refuse(json!({"provider": "  ", "model": "m"})), "selection.provider is invalid.");
    assert_eq!(refuse(json!({"provider": "p"})), "selection.model must be a string.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m".repeat(513)})), "selection.model is invalid.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m", "fast": "yes"})), "selection.fast must be a boolean.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m", "autoEffort": 1})), "selection.autoEffort must be a boolean.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m", "effort": 3})), "selection.effort must be a string.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m", "onlyIfEmpty": "x"})), "selection.onlyIfEmpty must be a boolean.");
    assert_eq!(refuse(json!({"provider": "p", "model": "m", "modelParameters": {"a": 1}})), "selection.modelParameters must be a string map.");
    for tokens in [json!(0), json!(1.5), json!("9")] {
        assert_eq!(refuse(json!({"provider": "p", "model": "m", "contextTokens": tokens})), "selection.contextTokens must be a positive integer.");
    }
    for percent in [json!(5), json!(55), json!(110)] {
        assert_eq!(
            refuse(json!({"provider": "p", "model": "m", "contextPercent": percent})),
            "selection.contextPercent must be a 10-point percentage from 10 to 100."
        );
    }
}

#[test]
fn fallbacks_are_checked_as_leaf_selections_and_capped() {
    let ok = required_model_selection(&json!({"provider": "p", "model": "m", "fallbacks": [{"provider": " q ", "model": "n"}]})).unwrap();
    assert_eq!(ok["fallbacks"], json!([{"provider": "q", "model": "n"}]));
    let nested = json!({"provider": "p", "model": "m", "fallbacks": [{"provider": "q", "model": "n", "fallbacks": []}]});
    assert_eq!(required_model_selection(&nested).unwrap_err(), "fallback selections must be leaf selections.");
    let many = json!({"provider": "p", "model": "m", "fallbacks": (0..17).map(|i| json!({"provider": format!("p{i}"), "model": "m"})).collect::<Vec<_>>()});
    assert_eq!(required_model_selection(&many).unwrap_err(), "selection.fallbacks must be an array of model selections.");
    assert_eq!(
        required_model_selection(&json!({"provider": "p", "model": "m", "fallbacks": [{"provider": "q"}]})).unwrap_err(),
        "selection.model must be a string."
    );
}

#[test]
fn a_free_form_sentence_is_not_a_model_selector_but_an_id_or_a_preset_is() {
    for id in ["gpt-5", "claude-opus-4.5", "~router/auto", "vendor/model:free", "a@b+c_d"] {
        assert!(is_likely_raw_model_id(Some(&json!(id))), "{id}");
    }
    for text in ["", "make it faster", "-leading", "über", "x\u{3000}y"] {
        assert!(!is_likely_raw_model_id(Some(&json!(text))), "{text}");
    }
    assert!(!is_likely_raw_model_id(Some(&json!("a".repeat(161)))));
    assert!(is_likely_raw_model_id(Some(&json!("a".repeat(160)))));
    assert!(!is_likely_raw_model_id(None));

    let config = obj(json!({"presets": [{"id": "work", "name": "Work notes", "provider": "p", "model": "m"}]}));
    assert!(validate_requested_model_selector(&config, &obj(json!({"model": "Work Notes"}))).is_ok(), "a preset may be a sentence");
    assert!(validate_requested_model_selector(&config, &obj(json!({"model": "gpt-5"}))).is_ok());
    assert!(validate_requested_model_selector(&config, &obj(json!({}))).is_ok(), "no model is no selector to judge");
    assert_eq!(
        validate_requested_model_selector(&config, &obj(json!({"model": "make it faster please"}))).unwrap_err(),
        "Invalid model selector \"make it faster please\". Use a preset or a model id; free-form text cannot be used as a model."
    );
}

// workflow routes

#[test]
fn a_workflow_route_is_normalized_to_the_choices_it_states() {
    let route = json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "HIGH", "fast": true, "autoEffort": false, "contextPercent": 55, "modelParameters": {"a": "b"}});
    let got = normalize_workflow_route(&route, &json!({}), false).unwrap().unwrap();
    assert_eq!(
        got,
        json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true, "autoEffort": false, "modelParameters": {"a": "b"}, "contextPercent": 60})
    );
}

#[test]
fn a_workflow_route_takes_what_it_lacks_from_the_fallback_and_is_dropped_when_it_names_no_model() {
    let got = normalize_workflow_route(&json!({"model": "gpt-5"}), &json!({"provider": "openai-oauth", "fast": false}), false).unwrap().unwrap();
    assert_eq!(got, json!({"provider": "openai-oauth", "model": "gpt-5", "fast": false}));
    assert_eq!(normalize_workflow_route(&json!({"provider": "openai-oauth"}), &json!({}), false).unwrap(), None);
    assert_eq!(normalize_workflow_route(&json!({"provider": "p", "model": "two words"}), &json!({}), false).unwrap(), None);
    assert!(normalize_workflow_route(&json!({"provider": "p", "model": "m", "effort": "bogus"}), &json!({}), false).is_err());
}

#[test]
fn a_workflow_chain_keeps_its_fallbacks_and_strict_mode_refuses_a_repeated_provider() {
    let chain = json!({"provider": "openai-oauth", "model": "gpt-5", "fallbacks": [{"provider": "anthropic-oauth", "model": "claude-opus-4-5"}]});
    let got = normalize_workflow_route(&chain, &json!({}), true).unwrap().unwrap();
    assert_eq!(got["fallbacks"], json!([{"provider": "anthropic-oauth", "model": "claude-opus-4-5"}]));
    let repeated = json!({"provider": "openai-oauth", "model": "gpt-5", "fallbacks": [{"provider": "openai-oauth", "model": "gpt-5"}]});
    assert_eq!(normalize_workflow_route(&repeated, &json!({}), true).unwrap_err(), "duplicate route \"openai-oauth/gpt-5\"");
    assert!(normalize_workflow_route(&repeated, &json!({}), false).unwrap().is_some());
}

#[test]
fn a_workflow_slot_has_one_preset_that_a_new_route_replaces() {
    let route = json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true});
    let existing = json!([{"id": "keep"}, {"id": "workflow-lead", "name": "x"}, {"id": "other", "name": "WORKFLOW LEAD"}]);
    let got = upsert_workflow_preset(&existing, "lead", &route).unwrap();
    assert_eq!(
        got,
        json!([
            {"id": "keep"},
            {"id": "workflow-lead", "name": "WORKFLOW LEAD", "type": "agent", "provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true, "tools": "full"},
        ])
    );
    assert_eq!(upsert_workflow_preset(&existing, "lead", &json!({"provider": "p"})).unwrap(), existing, "a route that names no model changes nothing");
    let plain = upsert_workflow_preset(&json!(null), "scout", &json!({"provider": "p", "model": "m"})).unwrap();
    assert_eq!(plain, json!([{"id": "workflow-scout", "name": "WORKFLOW SCOUT", "type": "agent", "provider": "p", "model": "m", "tools": "full"}]));
    let standard = upsert_workflow_preset(&json!(null), "lead", &json!({"provider": "p", "model": "m", "fast": false})).unwrap();
    assert_eq!(standard[0]["fast"], false, "an explicit Standard of the Lead is written");
    let scout = upsert_workflow_preset(&json!(null), "scout", &json!({"provider": "p", "model": "m", "fast": false})).unwrap();
    assert!(scout[0].get("fast").is_none(), "another slot keeps its shape");
}

// the Lead route

#[test]
fn re_tuning_the_live_model_is_not_a_main_model_choice() {
    let live = obj(json!({"provider": "p", "model": "side"}));
    let main = obj(json!({"provider": "p", "model": "main"}));
    assert!(tunes_non_main_model(&live, &obj(json!({"provider": "p", "model": "side"})), &main));
    assert!(!tunes_non_main_model(&live, &obj(json!({"provider": "p", "model": "main"})), &main));
    assert!(!tunes_non_main_model(&live, &obj(json!({"provider": "p", "model": "other"})), &main));
}

#[test]
fn an_adopted_model_becomes_the_lead_unless_the_selection_keeps_the_main_model() {
    let live = obj(json!({"provider": "openai-oauth", "model": "gpt-5"}));
    let route = obj(json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "high"}));
    let is_known = known(&["openai-oauth"]);

    let mut kept = Obj::new();
    assert_eq!(persist_adopted_model_settings(&mut kept, &live, &route, Some(true), &is_known).unwrap(), None);
    assert!(kept.is_empty());

    let mut written = Obj::new();
    let lead = persist_adopted_model_settings(&mut written, &live, &route, Some(false), &is_known).unwrap().unwrap();
    assert_eq!(lead["model"], "gpt-5");
    assert_eq!(written["default"], "workflow-lead");
    assert_eq!(written["presets"][0]["id"], "workflow-lead");

    // With no instruction, re-tuning a live model that is not the Main model leaves the Lead alone.
    let mut main_is_other = obj(json!({"default": "lead", "presets": [{"id": "lead", "provider": "openai-oauth", "model": "main-model"}]}));
    assert_eq!(persist_adopted_model_settings(&mut main_is_other, &live, &route, None, &is_known).unwrap(), None);
    assert_eq!(main_is_other["default"], "lead");
    // ... while adopting the Main model itself writes the Lead.
    let main_route = obj(json!({"provider": "openai-oauth", "model": "main-model"}));
    let live_main = main_route.clone();
    assert!(persist_adopted_model_settings(&mut main_is_other, &live_main, &main_route, None, &is_known).unwrap().is_some());
    assert_eq!(main_is_other["default"], "workflow-lead");
}

// chain entries

#[test]
fn a_chain_entry_inherits_the_stored_choices_of_the_same_model_only() {
    let is_known = known(&[]);
    let stored = obj(
        json!({"provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true, "autoEffort": false, "modelParameters": {"a": "b"}, "contextPercent": 40}),
    );
    let same = start_chain_entry(&Obj::new(), &obj(json!({"provider": "openai-oauth", "model": "gpt-5"})), &stored, &is_known).unwrap();
    assert_eq!((same["effort"].clone(), same["fast"].clone(), same["autoEffort"].clone()), (json!("high"), json!(true), json!(false)));
    assert_eq!((same["modelParameters"].clone(), same["contextPercent"].clone()), (json!({"a": "b"}), json!(40)));
    let other = start_chain_entry(&Obj::new(), &obj(json!({"provider": "openai-oauth", "model": "gpt-4.1"})), &stored, &is_known).unwrap();
    assert_eq!(
        (other["effort"].clone(), other["fast"].clone(), other["autoEffort"].clone(), other["modelParameters"].clone()),
        (Value::Null, json!(false), json!(true), json!({}))
    );
    assert!(other.get("contextPercent").is_none());
    // A stated choice beats the stored one.
    let stated =
        start_chain_entry(&Obj::new(), &obj(json!({"provider": "openai-oauth", "model": "gpt-5", "fast": false, "contextTokens": 90000})), &stored, &is_known)
            .unwrap();
    assert_eq!((stated["fast"].clone(), stated["contextTokens"].clone()), (json!(false), json!(90000)));
    assert!(stated.get("contextPercent").is_none());
}

#[test]
fn a_chain_entry_may_run_fast_only_where_the_model_row_says_so_and_unknown_rows_are_not_a_no() {
    let selected = || obj(json!({"provider": "openai-oauth", "model": "gpt-5", "fast": true}));
    let resolved = json!({"id": "gpt-5", "provider": "openai-oauth", "display": "GPT-5"});
    let no_fast = finish_chain_entry(selected(), Some(&resolved), Some(&resolved), |_| false);
    assert_eq!(no_fast["fast"], false);
    let fast = finish_chain_entry(selected(), Some(&resolved), Some(&resolved), |_| true);
    assert_eq!(fast["fast"], true);
    // A row that says nothing beyond its id and provider is a placeholder: Fast is not asked of the catalog.
    let placeholder = json!({"id": "gpt-5", "provider": "openai-oauth"});
    let unknown = finish_chain_entry(selected(), Some(&placeholder), Some(&placeholder), |_| panic!("not asked"));
    assert_eq!(unknown["fast"], true);
}

#[test]
fn a_chain_entrys_token_count_is_clamped_to_the_models_window() {
    let meta = json!({"id": "m", "provider": "openai", "contextWindow": 200_000, "maxContextWindow": 400_000});
    let selected = obj(json!({"provider": "openai", "model": "m", "contextTokens": 900_000}));
    let out = finish_chain_entry(selected, Some(&meta), Some(&meta), |_| false);
    assert_eq!(out["contextTokens"], 400_000);
}

// display and refresh

#[test]
fn a_routes_display_name_prefers_the_users_alias_then_the_catalogs_names() {
    let route = obj(json!({"provider": "p", "model": "m1", "modelDisplay": "stale"}));
    let config = obj(json!({"modelSettings": {"p/m1": {"alias": " Mine "}}}));
    assert_eq!(route_model_display(&config, &route, Some(&json!({"display": "D"}))), "Mine");
    assert_eq!(route_model_display(&Obj::new(), &route, Some(&json!({"display": "D", "displayName": "DN", "name": "N"}))), "D");
    assert_eq!(route_model_display(&Obj::new(), &route, Some(&json!({"displayName": "DN"}))), "DN");
    assert_eq!(route_model_display(&Obj::new(), &route, Some(&json!({"name": "N"}))), "N");
    assert_eq!(route_model_display(&Obj::new(), &route, Some(&json!({"name": "m1"}))), "stale", "a name equal to the model id says nothing new");
    assert_eq!(route_model_display(&Obj::new(), &route, None), "stale");
}

#[test]
fn refreshing_a_route_against_its_model_row_clamps_fast_and_sizes_the_context() {
    let meta = json!({"id": "gpt-5", "provider": "openai-oauth", "display": "GPT-5", "contextWindow": 400_000});
    let target = obj(json!({"provider": "openai-oauth", "model": "gpt-5", "fast": true, "contextPercent": 50}));
    let fast_no = |_: &str, _: &Value, _: Option<&str>, _: &Value| false;
    let route = refresh_route_fields(&Obj::new(), &target, Some(&meta), "openai-oauth", &fast_no, &|_, _| None);
    assert_eq!((route["fast"].clone(), route["fastCapable"].clone()), (json!(false), json!(false)));
    assert_eq!(route["modelDisplay"], "GPT-5");
    assert_eq!(
        (route["contextDefaultPercent"].clone(), route["contextPercent"].clone(), route["selectedContextWindow"].clone()),
        (json!(100), json!(50), json!(200_000))
    );

    // A row that is not resolved yet keeps the request as stated.
    let unresolved =
        refresh_route_fields(&Obj::new(), &obj(json!({"provider": "p", "model": "m", "fast": true, "effort": "high"})), None, "p", &fast_no, &|_, _| None);
    assert_eq!((unresolved["fast"].clone(), unresolved["effectiveEffort"].clone()), (json!(true), json!("high")));
}
