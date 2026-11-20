//! Which models can run the hosted web search, how the web-search route is saved and read back, and the provider
//! aliases and version orders the routes depend on.

use mixdog_ai::service::routes::canonical_route_provider;
use mixdog_ai::service::routes::execution_fallbacks;
use mixdog_ai::service::routes::gpt_version;
use mixdog_ai::service::routes::is_default_web_search_route;
use mixdog_ai::service::routes::is_web_search_capable_provider;
use mixdog_ai::service::routes::lighter_subscription_model;
use mixdog_ai::service::routes::normalize_web_search_route_config;
use mixdog_ai::service::routes::route_chain;
use mixdog_ai::service::routes::web_search_capable_for;
use mixdog_ai::service::routes::web_search_provider_family;
use mixdog_ai::service::routes::web_search_route_or_default;
use serde_json::Value;
use serde_json::json;

fn capable(provider: &str, id: &str) -> bool {
    web_search_capable_for(provider, id, None, None)
}

#[test]
fn only_four_provider_families_have_hosted_web_search_and_the_api_aliases_share_them() {
    for (provider, family) in [
        ("openai-oauth", "openai"),
        ("openai", "openai"),
        ("openai-api", "openai"),
        ("grok-oauth", "xai"),
        ("xai-api", "xai"),
        ("gemini", "gemini"),
        ("gemini-api", "gemini"),
        ("antigravity-oauth", "gemini"),
        ("anthropic", "anthropic"),
        ("anthropic-api", "anthropic"),
        ("anthropic-oauth", "anthropic"),
    ] {
        assert_eq!(web_search_provider_family(provider), family, "{provider}");
        assert!(is_web_search_capable_provider(provider));
    }
    for provider in ["deepseek", "openrouter", "custom-x", "", "default"] {
        assert_eq!(web_search_provider_family(provider), "", "{provider}");
        assert!(!capable(provider, "any-model"));
    }
}

#[test]
fn retired_and_non_chat_openai_models_cannot_search_and_current_ones_can() {
    for id in ["gpt-5.5", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini", "gpt-5-nano"] {
        assert!(capable("openai-oauth", id), "{id}");
    }
    for id in [
        "gpt-3.5-turbo", "gpt-4", "gpt-4-turbo", "o1", "o1-mini", "o2-pro", "text-davinci-003", "davinci-002", "babbage-002",
        "gpt-5-codex", "text-embedding-3-large", "gpt-image-1", "gpt-4o-search-preview", "omni-moderation-latest", "whisper-tts",
    ] {
        assert!(!capable("openai", id), "{id}");
    }
    assert!(!capable("openai", "  "), "no model, no search");
    assert!(capable("openai", " GPT-5.5 "), "ids are compared trimmed and lowercase");
}

#[test]
fn retired_and_non_chat_grok_models_cannot_search() {
    for id in ["grok-4", "grok-4-fast", "grok-code-fast-1"] {
        assert!(capable("grok-oauth", id), "{id}");
    }
    for id in ["grok-1.5", "grok-2", "grok-2-vision", "grok-3", "grok-3-mini", "grok-build", "grok-composer-1", "grok-imagine-video"] {
        assert!(!capable("xai", id), "{id}");
    }
}

#[test]
fn only_gemini_chat_models_of_the_search_generations_can_search() {
    for id in ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-3-pro"] {
        assert!(capable("gemini", id), "{id}");
    }
    for id in [
        "gemini-1.5-pro", "gemini-1-ultra", "gemini-pro", "gemini-ultra", "gemini-2.0-pro-exp", "gemini-2.5-computer-use",
        "gemini-3-pro-customtools", "gemini-2.5-flash-image", "gemini-embedding-001", "imagen-4", "veo-3", "learnlm-2",
    ] {
        assert!(!capable("antigravity-oauth", id), "{id}");
    }
}

#[test]
fn retired_claude_generations_cannot_search_and_current_ones_can() {
    for id in ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4"] {
        assert!(capable("anthropic-oauth", id), "{id}");
    }
    for id in ["claude-3-5-sonnet-20241022", "claude-instant-1.2", "claude-sonnet-3-7", "claude-haiku-3-5", "claude-opus-3", "claude-2.1"] {
        assert!(!capable("anthropic", id), "{id}");
    }
}

#[test]
fn what_a_row_states_about_web_search_overrides_the_id_rules_the_route_row_before_the_catalog_row() {
    let ask = |row: Option<Value>, catalog: Option<Value>, id: &str| web_search_capable_for("openai", id, row.as_ref(), catalog.as_ref());
    assert!(ask(Some(json!({"supportsWebSearch": true})), None, "gpt-4"), "a stated yes beats a retired id");
    assert!(!ask(Some(json!({"supportsWebSearch": false})), None, "gpt-5.5"), "a stated no beats a current id");
    assert!(!ask(Some(json!({"supportsWebSearch": false})), Some(json!({"supportsWebSearch": true})), "gpt-5.5"), "the route row is asked first");
    assert!(ask(Some(json!({"name": "silent"})), Some(json!({"supportsWebSearch": true})), "gpt-4"), "a silent route row leaves the catalog the word");
    assert!(ask(None, Some(json!({"supportedTools": [{"type": "web_search"}]})), "gpt-4"));
    assert!(ask(None, Some(json!({"tools": [{"name": "Web_Search_Preview"}]})), "gpt-4"));
    assert!(ask(None, Some(json!({"capabilities": {"tools": ["web_search"]}})), "gpt-4"), "a tool listed by name only");
    assert!(!ask(None, Some(json!({"supportedTools": [{"type": "code_interpreter"}]})), "gpt-4"), "other tools say nothing: the id rule decides");
    assert!(ask(Some(json!("not an object")), None, "gpt-5.5"));
}

#[test]
fn a_saved_web_search_route_keeps_its_provider_model_and_known_settings_in_wire_order() {
    let route = json!({
        "toolType": " web_search ", "modelParameters": {"a": 1}, "fast": true, "effort": "HIGH", "model": " gpt-5.5 ",
        "provider": "openai-api", "junk": 1,
    });
    let saved = normalize_web_search_route_config(&route, &json!({})).unwrap().unwrap();
    assert_eq!(
        saved.to_string(),
        r#"{"provider":"openai","model":"gpt-5.5","effort":"high","fast":true,"modelParameters":{"a":1},"toolType":"web_search"}"#
    );
    let sparse = json!({"provider": "gemini", "model": "gemini-2.5-pro", "effort": "auto", "fast": "yes", "modelParameters": [1]});
    assert_eq!(
        normalize_web_search_route_config(&sparse, &json!({})).unwrap().unwrap().to_string(),
        r#"{"provider":"gemini","model":"gemini-2.5-pro"}"#,
        "auto effort, a non-boolean fast and non-object parameters are not saved"
    );
}

#[test]
fn a_route_missing_its_provider_or_model_takes_them_from_the_fallback_or_is_nothing() {
    assert_eq!(normalize_web_search_route_config(&json!({"provider": "gemini"}), &json!({})), Ok(None));
    assert_eq!(normalize_web_search_route_config(&json!({"model": "m"}), &json!({})), Ok(None));
    let filled = normalize_web_search_route_config(&json!({"model": "gemini-2.5-pro"}), &json!({"provider": "gemini", "effort": "high"})).unwrap().unwrap();
    assert_eq!(filled, json!({"provider": "gemini", "model": "gemini-2.5-pro", "effort": "high"}));
}

#[test]
fn the_fallbacks_of_a_web_search_route_are_normalized_and_may_not_repeat_a_provider() {
    let route = json!({
        "provider": "openai-oauth", "model": "gpt-5.5",
        "fallbacks": [{"provider": "gemini-api", "model": "gemini-2.5-pro", "effort": "low"}, {"provider": "anthropic", "model": "claude-sonnet-4-5"}],
    });
    let saved = normalize_web_search_route_config(&route, &json!({})).unwrap().unwrap();
    assert_eq!(
        saved,
        json!({
            "provider": "openai-oauth", "model": "gpt-5.5",
            "fallbacks": [{"provider": "gemini", "model": "gemini-2.5-pro", "effort": "low"}, {"provider": "anthropic", "model": "claude-sonnet-4-5"}],
        })
    );
    let repeated = json!({"provider": "openai", "model": "a", "fallbacks": [{"provider": "openai-api", "model": "a"}]});
    assert_eq!(normalize_web_search_route_config(&repeated, &json!({})), Err("duplicate route \"openai/a\"".to_owned()));
    let unfinished = json!({"provider": "openai", "model": "a", "fallbacks": [{"provider": "gemini"}]});
    assert_eq!(normalize_web_search_route_config(&unfinished, &json!({})), Err("fallback route requires provider and model".to_owned()));
    let follow = json!({"provider": "openai", "model": "a", "fallbacks": [{"provider": "default", "model": "default"}]});
    assert_eq!(normalize_web_search_route_config(&follow, &json!({})), Err("follow Main is only allowed as the primary route".to_owned()));
    let nested = json!({"provider": "openai", "model": "a", "fallbacks": [{"provider": "gemini", "model": "m", "fallbacks": []}]});
    assert_eq!(normalize_web_search_route_config(&nested, &json!({})), Err("fallback routes must be leaf route objects".to_owned()));
    let wrong = json!({"provider": "openai", "model": "a", "fallbacks": "gemini"});
    assert_eq!(normalize_web_search_route_config(&wrong, &json!({})), Err("route.fallbacks must be an array".to_owned()));
}

#[test]
fn the_first_candidate_that_normalizes_is_the_route_and_none_means_follow_the_main_model() {
    let blank = json!({});
    let half = json!({"provider": "gemini"});
    let good = json!({"provider": "gemini", "model": "gemini-2.5-pro"});
    let other = json!({"provider": "openai", "model": "gpt-5.5"});
    assert_eq!(web_search_route_or_default(&[&blank, &half, &good, &other]), Ok(good.clone()));
    let followed = web_search_route_or_default(&[&blank, &Value::Null]).unwrap();
    assert_eq!(followed, json!({"provider": "default", "model": "default"}));
    assert!(is_default_web_search_route(&followed));
    assert!(is_default_web_search_route(&json!({"provider": " default ", "model": "DEFAULT"})));
    assert!(!is_default_web_search_route(&good));
    assert!(web_search_route_or_default(&[]).is_ok());
    assert!(web_search_route_or_default(&[&json!({"provider": "a", "model": "b", "fallbacks": 1})]).is_err(), "a malformed candidate is an error, not skipped");
}

#[test]
fn a_chain_runs_the_primary_then_the_fallbacks_on_providers_not_already_used() {
    let route = json!({
        "provider": "openai-api", "model": "a",
        "fallbacks": [{"provider": "openai", "model": "a"}, {"provider": "gemini", "model": "c"}, {"provider": "gemini-api", "model": "c"}, {"provider": "xai", "model": "e"}],
    });
    let chain: Vec<String> = route_chain(&route).unwrap().iter().map(|r| r["model"].as_str().unwrap().to_owned()).collect();
    assert_eq!(chain, ["a", "a", "c", "c", "e"], "the chain lists every route, primary first, without its own fallbacks key");
    assert!(route_chain(&route).unwrap()[0].get("fallbacks").is_none());
    let run: Vec<String> = execution_fallbacks(&route).unwrap().iter().map(|r| r["model"].as_str().unwrap().to_owned()).collect();
    assert_eq!(run, ["c", "e"], "the primary's route under its alias and a repeated route are skipped");
    assert!(route_chain(&json!("not a route")).unwrap().is_empty());
    assert!(execution_fallbacks(&json!(null)).unwrap().is_empty());
}

#[test]
fn the_api_names_of_a_provider_are_its_canonical_provider() {
    for (name, canonical) in [("openai-api", "openai"), ("xai-api", "xai"), ("gemini-api", "gemini"), ("anthropic-api", "anthropic"), (" openai-api ", "openai"), ("openai-oauth", "openai-oauth"), ("custom-x", "custom-x")] {
        assert_eq!(canonical_route_provider(name), canonical);
    }
}

#[test]
fn a_gpt_model_version_is_major_and_minor_and_only_the_gpt_n_family_has_one() {
    for (id, version) in [("gpt-5", Some((5, 0))), ("gpt-5.5", Some((5, 5))), ("gpt-5.5-luna", Some((5, 5))), ("gpt-5.4-luna-mini", Some((5, 4))), ("gpt-5-luna", Some((5, 0))), ("gpt-10.2", Some((10, 2)))] {
        assert_eq!(gpt_version(id), version, "{id}");
    }
    for id in ["gpt-", "gpt-x", "gpt-5x", "gpt-5.x", "o3", "claude-sonnet-4", "gpt-55"] {
        assert_eq!(gpt_version(id), None, "{id}");
    }
}

#[test]
fn the_lighter_model_orders_claude_versions_numerically_not_as_text() {
    let rows = |ids: &[&str]| -> Vec<Value> { ids.iter().map(|id| json!({"id": id, "family": "haiku"})).collect() };
    assert_eq!(lighter_subscription_model("anthropic-oauth", &rows(&["claude-haiku-4-5", "claude-haiku-10-1", "claude-haiku-4-10"])).as_deref(), Some("claude-haiku-10-1"));
    assert_eq!(lighter_subscription_model("anthropic-oauth", &rows(&["claude-haiku-4-5", "claude-haiku-4-10"])).as_deref(), Some("claude-haiku-4-10"));
    assert_eq!(lighter_subscription_model("anthropic-oauth", &rows(&["claude-haiku-4"])).as_deref(), Some("claude-haiku-4"));
}
