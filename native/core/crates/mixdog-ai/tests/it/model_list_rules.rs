//! The pure rules of the model list: which providers are available, the order of the picker, which rows are language
//! models, the cached row of a listed model, the provider scope of a request, and a row's hydration with the user's
//! saved per-model settings.

use mixdog_ai::service::admin_models::HydrationFacts;
use mixdog_ai::service::admin_models::daybreak_option;
use mixdog_ai::service::admin_models::developer_option_enabled;
use mixdog_ai::service::admin_models::developer_option_for_provider;
use mixdog_ai::service::admin_models::hydrate_provider_model_row;
use mixdog_ai::service::admin_models::is_selectable_llm_model;
use mixdog_ai::service::admin_models::model_proxy_client_mode;
use mixdog_ai::service::admin_models::openrouter_sort_option;
use mixdog_ai::service::admin_models::provider_available;
use mixdog_ai::service::admin_models::provider_model_cache_row;
use mixdog_ai::service::admin_models::provider_rows;
use mixdog_ai::service::admin_models::provider_unavailable_message;
use mixdog_ai::service::admin_models::sort_provider_models;
use mixdog_ai::service::admin_models::with_catalog_state;
use mixdog_ai::service::admin_route::Obj;
use serde_json::Value;
use serde_json::json;

// ---- availability --------------------------------------------------------------------------------------------------

#[test]
fn only_the_client_value_of_the_proxy_switch_turns_remote_client_mode_on() {
    let with = |value: Option<&str>| model_proxy_client_mode(&|name: &str| (name == "MIXDOG_MODEL_PROXY").then(|| value.map(str::to_owned)).flatten());
    assert!(with(Some("client")));
    for other in [None, Some(""), Some("Client"), Some("server"), Some("1")] {
        assert!(!with(other), "{other:?}");
    }
}

#[test]
fn a_dev_only_provider_is_available_only_while_its_developer_option_is_on() {
    assert_eq!(developer_option_for_provider("cursor-oauth"), Some("cursorOAuth"));
    assert_eq!(developer_option_for_provider("antigravity-oauth"), Some("antigravityOAuth"));
    assert_eq!(developer_option_for_provider("devin-oauth"), Some("devinOAuth"));
    assert_eq!(developer_option_for_provider("mimo-oauth"), Some("mimoOAuth"));
    assert_eq!(developer_option_for_provider("openai-oauth"), None);

    let on = json!({"cursorOAuth": true});
    assert!(provider_available("cursor-oauth", false, &on));
    // Only a stored `true` counts; a truthy string, a missing key and an unrelated key do not.
    for stored in [json!({}), json!({"cursorOAuth": false}), json!({"cursorOAuth": "true"}), json!({"devinOAuth": true})] {
        assert!(!provider_available("cursor-oauth", false, &stored), "{stored}");
    }
    // An ungated provider needs no option, and remote client mode serves every provider of the PC.
    assert!(provider_available("openai-oauth", false, &json!({})));
    assert!(provider_available("cursor-oauth", true, &json!({})));
}

#[test]
fn a_developer_option_that_does_not_exist_is_never_enabled() {
    assert!(developer_option_enabled("allowAllActions", &json!({"allowAllActions": true})));
    assert!(!developer_option_enabled("notAnOption", &json!({"notAnOption": true})));
}

#[test]
fn the_unavailable_message_names_the_provider_and_the_switched_off_option() {
    assert_eq!(
        provider_unavailable_message("cursor-oauth"),
        "Provider \"cursor-oauth\" is disabled: its Developer option was switched off before the request was sent."
    );
}

// ---- order ---------------------------------------------------------------------------------------------------------

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|r| format!("{}/{}", r["provider"].as_str().unwrap(), r["id"].as_str().unwrap())).collect()
}

fn sorted(mut rows: Vec<Value>, primary: &str) -> Vec<String> {
    sort_provider_models(&mut rows, primary);
    ids(&rows)
}

#[test]
fn the_primary_provider_comes_first_and_the_others_follow_by_name() {
    let rows = vec![json!({"provider": "zeta", "id": "z1"}), json!({"provider": "alpha", "id": "a1"}), json!({"provider": "mid", "id": "m1"})];
    assert_eq!(sorted(rows.clone(), "mid"), ["mid/m1", "alpha/a1", "zeta/z1"]);
    assert_eq!(sorted(rows, "nobody"), ["alpha/a1", "mid/m1", "zeta/z1"]);
}

#[test]
fn within_a_provider_the_newer_release_comes_first_even_when_its_version_number_is_lower() {
    let rows =
        vec![json!({"provider": "p", "id": "model-9", "releaseDate": "2023-01-01"}), json!({"provider": "p", "id": "model-2", "releaseDate": "2025-06-01"})];
    assert_eq!(sorted(rows, "p"), ["p/model-2", "p/model-9"]);
}

#[test]
fn without_release_dates_the_higher_version_comes_first() {
    let rows =
        vec![json!({"provider": "openai", "id": "gpt-4o"}), json!({"provider": "openai", "id": "gpt-5"}), json!({"provider": "openai", "id": "gpt-4.1"})];
    assert_eq!(sorted(rows, "openai"), ["openai/gpt-5", "openai/gpt-4.1", "openai/gpt-4o"]);
}

#[test]
fn a_creation_stamp_or_a_date_in_the_id_dates_a_row_that_states_no_release() {
    let rows = vec![
        json!({"provider": "p", "id": "older-20240101"}),
        json!({"provider": "p", "id": "newer-20250101"}),
        // Seconds are read as seconds: 2024-06-01 lies between the two dated ids' years.
        json!({"provider": "p", "id": "stamped", "created": 1_717_200_000}),
    ];
    assert_eq!(sorted(rows, "p"), ["p/newer-20250101", "p/stamped", "p/older-20240101"]);
}

#[test]
fn among_claude_models_the_latest_flag_wins_and_then_the_higher_version() {
    let claude = |id: &str, latest: bool| json!({"provider": "anthropic-oauth", "id": id, "latest": latest});
    let rows = vec![claude("claude-opus-4-1", false), claude("claude-opus-4-5", false), claude("claude-sonnet-3-7", true)];
    assert_eq!(sorted(rows, "anthropic-oauth"), ["anthropic-oauth/claude-sonnet-3-7", "anthropic-oauth/claude-opus-4-5", "anthropic-oauth/claude-opus-4-1"]);
}

#[test]
fn rows_equal_in_every_rule_fall_back_to_their_labels() {
    let rows = vec![json!({"provider": "p", "id": "b", "display": "Beta"}), json!({"provider": "p", "id": "a", "display": "Alpha"})];
    assert_eq!(sorted(rows, "p"), ["p/a", "p/b"]);
}

// ---- which rows are language models --------------------------------------------------------------------------------

#[test]
fn language_models_are_selectable() {
    for model in [
        json!({"id": "gpt-5"}),
        json!({"id": "claude-sonnet-4-5", "mode": "chat"}),
        json!({"id": "o3", "mode": "responses"}),
        json!({"id": "m", "mode": "Messages"}),
        json!({"id": "legacy", "mode": "completion"}),
        // A word that merely contains a blocked one is not that word.
        json!({"id": "imaginative-8b"}),
        json!({"id": "text-embedded-chat"}),
    ] {
        assert!(is_selectable_llm_model(&model), "{model}");
    }
}

#[test]
fn media_embedding_and_moderation_models_are_not_selectable() {
    for model in [
        json!({}),
        json!({"id": ""}),
        json!({"id": "gpt-image-1"}),
        json!({"id": "text-embedding-3-large"}),
        json!({"id": "bge-reranker"}),
        json!({"id": "gpt-4o-realtime"}),
        json!({"id": "whisper-stt"}),
        json!({"id": "tts_1"}),
        json!({"id": "dall-e-3"}),
        json!({"id": "dalle-3"}),
        json!({"id": "sora-2"}),
        json!({"id": "imagen-4"}),
        json!({"id": "omni-moderation-latest"}),
        json!({"id": "grok-imagine"}),
        // The display name counts too.
        json!({"id": "m1", "display": "My Audio Model"}),
        // A mode that is not a text mode.
        json!({"id": "plain", "mode": "image_generation"}),
        json!({"id": "plain", "mode": "embedding"}),
    ] {
        assert!(!is_selectable_llm_model(&model), "{model}");
    }
}

// ---- the cached row ------------------------------------------------------------------------------------------------

#[test]
fn a_sparse_model_becomes_a_fully_defaulted_row() {
    let row = Value::Object(provider_model_cache_row("openai", &json!({"id": "gpt-x"}), false));
    assert_eq!(row["id"], "gpt-x");
    assert_eq!(row["provider"], "openai");
    assert_eq!(row["display"], "gpt-x", "no display name falls back to the id");
    assert_eq!(row["description"], "");
    for null in ["created", "releaseDate", "outputTokens", "family", "tier", "defaultServiceTier", "defaultEffort", "mode", "reasoningContentField"] {
        assert_eq!(row[null], Value::Null, "{null}");
    }
    for flag in [
        "latest",
        "supportsVision",
        "supportsFunctionCalling",
        "supportsWebSearch",
        "supportsPromptCaching",
        "supportsReasoning",
        "fastCapable",
        "defaultFast",
        "supportsMaxMode",
    ] {
        assert_eq!(row[flag], false, "{flag}");
    }
    for list in ["reasoningOptions", "serviceTiers", "additionalSpeedTiers", "modelParameterOptions", "parameterVariants"] {
        assert_eq!(row[list], json!([]), "{list}");
    }
    assert_eq!(row["defaultModelParameters"], json!({}));
    for absent in ["hidden", "reasoningLevels", "accessPrograms", "fastEfforts", "name", "providerName", "manual", "customReasoning"] {
        assert!(row.get(absent).is_none(), "{absent} is not on a first-party row that does not state it");
    }
}

#[test]
fn the_row_keeps_what_the_model_states_and_the_search_flag_is_the_callers() {
    let model = json!({
        "id": "m", "name": "Model M", "created": 1_700_000_000, "releaseDate": "2024-01-01", "outputTokens": 4096, "family": "f", "tier": "pro",
        "latest": true, "description": "d", "supportsVision": true, "supportsFunctionCalling": true, "supportsWebSearch": true,
        "supportsPromptCaching": true, "supportsReasoning": true, "reasoningLevels": ["low"], "reasoningOptions": [{"value": "low"}],
        "serviceTiers": ["priority"], "fastCapable": true, "fastEfforts": ["low"], "hidden": true, "defaultEffort": "low", "mode": "chat",
        "defaultModelParameters": {"context": "1m"},
    });
    let row = Value::Object(provider_model_cache_row("openai", &model, false));
    assert_eq!(row["display"], "Model M", "the name stands in for a missing display name");
    assert_eq!((row["created"].clone(), row["releaseDate"].clone(), row["outputTokens"].clone()), (json!(1_700_000_000), json!("2024-01-01"), json!(4096)));
    assert_eq!(
        (row["latest"].clone(), row["supportsVision"].clone(), row["supportsReasoning"].clone(), row["fastCapable"].clone()),
        (json!(true), json!(true), json!(true), json!(true))
    );
    assert_eq!(row["supportsWebSearch"], false, "the model's own claim is not trusted: the capability check decides");
    assert_eq!(Value::Object(provider_model_cache_row("openai", &model, true))["supportsWebSearch"], true);
    assert_eq!(
        (row["reasoningLevels"].clone(), row["reasoningOptions"].clone(), row["serviceTiers"].clone()),
        (json!(["low"]), json!([{"value": "low"}]), json!(["priority"]))
    );
    assert_eq!(
        (row["hidden"].clone(), row["defaultEffort"].clone(), row["mode"].clone(), row["defaultModelParameters"].clone()),
        (json!(true), json!("low"), json!("chat"), json!({"context": "1m"}))
    );
}

#[test]
fn a_window_beyond_the_default_ceiling_is_offered_as_an_option_not_the_default() {
    // 1M served: half a million is the default, the whole million the largest choice.
    let row = Value::Object(provider_model_cache_row("openai", &json!({"id": "m", "contextWindow": 1_000_000}), false));
    assert_eq!((row["contextWindow"].clone(), row["maxContextWindow"].clone()), (json!(500_000), json!(1_000_000)));
    // A local model keeps the window it serves.
    let local = Value::Object(provider_model_cache_row("mixdog-local", &json!({"id": "m", "contextWindow": 1_000_000}), false));
    assert_eq!(local["contextWindow"], 1_000_000);
    // Inside the ceiling the window is the default and, with no larger one stated, there is no larger choice.
    let small = Value::Object(provider_model_cache_row("openai", &json!({"id": "m", "contextWindow": 200_000}), false));
    assert_eq!((small["contextWindow"].clone(), small["maxContextWindow"].clone()), (json!(200_000), Value::Null));
    // A stated larger maximum is a choice.
    let larger = Value::Object(provider_model_cache_row("openai", &json!({"id": "m", "contextWindow": 200_000, "maxContextWindow": 400_000}), false));
    assert_eq!((larger["contextWindow"].clone(), larger["maxContextWindow"].clone()), (json!(200_000), json!(400_000)));
}

#[test]
fn a_custom_providers_row_keeps_its_own_names_flags_and_reasoning_but_a_first_party_row_does_not() {
    let model = json!({"id": "m", "name": "Mine", "providerName": "My Box", "manual": true, "hidden": false, "customReasoning": {"levels": ["low"]}});
    let custom = Value::Object(provider_model_cache_row("custom-box", &model, false));
    assert_eq!((custom["name"].clone(), custom["providerName"].clone(), custom["manual"].clone()), (json!("Mine"), json!("My Box"), json!(true)));
    assert_eq!((custom["hidden"].clone(), custom["customReasoning"].clone()), (json!(false), json!({"levels": ["low"]})));
    let first_party = Value::Object(provider_model_cache_row("openai", &model, false));
    for key in ["name", "providerName", "manual", "customReasoning", "hidden"] {
        assert!(first_party.get(key).is_none(), "{key}");
    }
}

// ---- the provider scope of a request ---------------------------------------------------------------------------------

#[test]
fn a_provider_scope_picks_the_rows_of_that_provider() {
    let rows =
        vec![json!({"id": "1", "provider": "openai"}), json!({"id": "2", "provider": "openai-oauth"}), json!({"id": "3", "provider": "Anthropic OAuth"})];
    let pick = |scope: &str| provider_rows(&rows, scope).iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(pick(""), ["1", "2", "3"], "no scope lists everything");
    assert_eq!(pick("OpenAI"), ["1"], "an exact match, ignoring case and punctuation, wins over a partial one");
    assert_eq!(pick("anthropic-oauth"), ["3"]);
    assert_eq!(pick("oauth"), ["2", "3"], "with no exact match, every provider containing the scope");
    assert!(pick("gemini").is_empty());
}

// ---- hydration -------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Facts {
    fast: bool,
    ultrafast: bool,
    auto_by_mode: bool,
    auto_custom: bool,
}

impl HydrationFacts for Facts {
    fn fast_capable(&self, _: &str, _: &Value) -> bool {
        self.fast
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        self.ultrafast
    }
    fn effort_items(&self, _: &str, _: &Value) -> Value {
        json!([{"value": "low"}, {"value": "high"}])
    }
    fn effort_configuration_mode(&self, _: &str, _: &str, _: &Value) -> bool {
        self.auto_by_mode
    }
    fn custom_auto_effort_capable(&self, _: &str, _: Option<&Value>, _: &Value) -> bool {
        self.auto_custom
    }
    fn provider_config(&self, _: &str) -> Obj {
        Obj::new()
    }
}

fn config(value: Value) -> Obj {
    value.as_object().cloned().unwrap()
}

#[test]
fn a_row_carries_the_users_saved_settings_for_its_model() {
    let cfg = config(json!({
        "providers": {"custom-x": {"name": "  My Box  ", "protocol": "openai-chat"}},
        "modelSettings": {"custom-x/m1": {
            "alias": "  Quick  ", "fast": true, "effort": "high", "autoEffort": false, "modelParameters": {"context": "1m"},
            "contextPercent": 50, "contextTokens": 0, "hidden": true, "favorite": true,
        }},
    }));
    let row = json!({"id": "m1", "provider": "custom-x", "display": "m1", "providerName": "stale"});
    let out = hydrate_provider_model_row(&cfg, &row, &Facts { fast: true, auto_custom: true, ..Facts::default() });
    assert_eq!(out["providerName"], "My Box", "a custom provider shows its configured name, trimmed");
    assert_eq!((out["display"].clone(), out["displayAlias"].clone()), (json!("Quick"), json!("Quick")));
    assert_eq!(out["effortOptions"], json!([{"value": "low"}, {"value": "high"}]));
    assert_eq!((out["fastCapable"].clone(), out["fastPreferred"].clone(), out["savedFast"].clone()), (json!(true), json!(true), json!(true)));
    assert_eq!((out["savedEffort"].clone(), out["savedAutoEffort"].clone(), out["autoEffortCapable"].clone()), (json!("high"), json!(false), json!(true)));
    assert_eq!(out["savedModelParameters"], json!({"context": "1m"}));
    assert_eq!(out["savedContextPercent"], 50);
    assert!(out.get("savedContextTokens").is_none(), "a zero is no saved choice");
    assert_eq!((out["savedHidden"].clone(), out["favorite"].clone()), (json!(true), json!(true)));
}

#[test]
fn a_row_with_no_saved_settings_states_no_saved_facts() {
    let row = json!({"id": "gpt-5", "provider": "openai-oauth", "display": "GPT-5"});
    let out = hydrate_provider_model_row(&Obj::new(), &row, &Facts::default());
    assert_eq!(out["display"], "GPT-5");
    assert!(out.get("displayAlias").is_none());
    assert_eq!((out["fastCapable"].clone(), out["fastPreferred"].clone(), out["autoEffortCapable"].clone()), (json!(false), json!(false), json!(false)));
    assert_eq!((out["savedEffort"].clone(), out["savedModelParameters"].clone()), (Value::Null, json!({})));
    for absent in ["savedFast", "savedAutoEffort", "savedContextPercent", "savedContextTokens", "savedHidden", "favorite"] {
        assert!(out.get(absent).is_none(), "{absent}");
    }
}

#[test]
fn fast_defaults_to_the_models_own_default_until_the_user_saves_a_choice() {
    let row = json!({"id": "m", "provider": "openai-oauth", "defaultFast": true});
    assert_eq!(hydrate_provider_model_row(&Obj::new(), &row, &Facts::default())["fastPreferred"], true);
    let saved_off = config(json!({"modelSettings": {"openai-oauth/m": {"fast": false}}}));
    let out = hydrate_provider_model_row(&saved_off, &row, &Facts::default());
    assert_eq!((out["fastPreferred"].clone(), out["savedFast"].clone()), (json!(false), json!(false)));
}

#[test]
fn a_custom_provider_without_a_configured_name_shows_none() {
    let row = json!({"id": "m", "provider": "custom-y", "providerName": "stale"});
    let out = hydrate_provider_model_row(&config(json!({"providers": {"custom-y": {}}})), &row, &Facts::default());
    assert!(out.get("providerName").is_none());
}

#[test]
fn provider_specific_parameter_options_are_added_once_and_replace_a_stale_copy() {
    let daybreak_row = json!({
        "id": "gpt-5", "provider": "openai-oauth", "accessPrograms": ["daybreak_blue"],
        "modelParameterOptions": [{"id": "daybreak", "label": "stale"}, {"id": "other"}],
    });
    let out = hydrate_provider_model_row(&Obj::new(), &daybreak_row, &Facts { fast: true, ultrafast: true, ..Facts::default() });
    let options = out["modelParameterOptions"].as_array().unwrap();
    assert_eq!(options[0], json!({"id": "other"}), "options the row already had stay, in their place");
    assert_eq!(options[1], daybreak_option());
    assert_eq!(options[2]["id"], "serviceTier");
    assert_eq!(options[2]["options"], json!([{"value": "priority", "label": "Fast"}, {"value": "ultrafast", "label": "Ultrafast"}]));
    assert_eq!(options.len(), 3);

    // Ultrafast is offered only where Fast is.
    let no_fast = hydrate_provider_model_row(&Obj::new(), &json!({"id": "m", "provider": "openai-oauth"}), &Facts { ultrafast: true, ..Facts::default() });
    assert!(no_fast.get("modelParameterOptions").is_none());

    let openrouter = hydrate_provider_model_row(&Obj::new(), &json!({"id": "m", "provider": "openrouter"}), &Facts::default());
    assert_eq!(openrouter["modelParameterOptions"], json!([openrouter_sort_option()]));
}

#[test]
fn auto_effort_is_offered_when_the_effort_configuration_allows_it() {
    let row = json!({"id": "m", "provider": "openai-oauth"});
    assert_eq!(hydrate_provider_model_row(&Obj::new(), &row, &Facts { auto_by_mode: true, ..Facts::default() })["autoEffortCapable"], true);
}

// ---- a partial catalog -----------------------------------------------------------------------------------------------

#[test]
fn rows_of_a_partial_answer_say_what_is_missing_and_when_to_retry() {
    let rows = vec![json!({"id": "a"}), json!({"id": "b"})];
    assert_eq!(with_catalog_state(rows.clone(), None), rows);
    let missing = vec!["gemini".to_owned(), "xai".to_owned()];
    let out = with_catalog_state(rows, Some((&missing, 1_700_000_000_000.0)));
    for row in &out {
        assert_eq!(
            (row["catalogPartial"].clone(), row["catalogMissing"].clone(), row["catalogRetryAt"].clone()),
            (json!(true), json!(["gemini", "xai"]), json!(1_700_000_000_000_u64))
        );
    }
    assert_eq!(out[1]["id"], "b");
}
