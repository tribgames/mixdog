use serde_json::json;

use super::*;

/// Node's recorded outputs (`tests/golden/routes/routes.json`).
fn golden() -> Value {
    serde_json::from_str(include_str!("../../../tests/golden/routes/routes.json")).unwrap()
}

#[test]
fn hosted_web_search_capability_matches_node() {
    let g = golden();
    let cases = g["capability"].as_array().unwrap();
    assert_eq!(cases.len(), 588);
    for case in cases {
        let (provider, id) = (case["provider"].as_str().unwrap(), case["id"].as_str().unwrap());
        let row = Some(&case["row"]).filter(|r| !r.is_null());
        let catalog = Some(&case["catalog"]).filter(|r| !r.is_null());
        // Node passes the bare id when the route holds no row.
        let model_row = row.map(|r| {
            let mut o = r.as_object().unwrap().clone();
            o.insert("id".into(), id.into());
            Value::Object(o)
        });
        let got = web_search_capable_for(provider, id, model_row.as_ref(), catalog);
        assert_eq!(got, case["out"].as_bool().unwrap(), "{provider} {id} {row:?} {catalog:?}");
    }
}

#[test]
fn web_search_route_normalization_matches_node() {
    let g = golden();
    for case in g["routes"].as_array().unwrap() {
        let args: Vec<&Value> = case["args"].as_array().unwrap().iter().collect();
        let got = web_search_route_or_default(&args);
        match case["err"].as_str() {
            Some(message) => assert_eq!(got.unwrap_err(), message, "{args:?}"),
            None => {
                let route = got.unwrap();
                assert_eq!(route.to_string(), case["out"].to_string(), "{args:?}");
                assert_eq!(is_default_web_search_route(&route), case["isDefault"].as_bool().unwrap());
                let chain: Vec<String> = route_chain(&route).unwrap().iter().map(Value::to_string).collect();
                let want: Vec<String> = case["chain"].as_array().unwrap().iter().map(Value::to_string).collect();
                assert_eq!(chain, want);
                let exec: Vec<String> = execution_fallbacks(&route).unwrap().iter().map(Value::to_string).collect();
                let want: Vec<String> = case["exec"].as_array().unwrap().iter().map(Value::to_string).collect();
                assert_eq!(exec, want);
            }
        }
    }
}

#[test]
fn provider_aliases_gpt_versions_and_claude_order_match_node() {
    let g = golden();
    for c in g["canonical"].as_array().unwrap() {
        assert_eq!(canonical_route_provider(c["v"].as_str().unwrap()), c["out"].as_str().unwrap());
    }
    for c in g["gpt"].as_array().unwrap() {
        let want = c["out"].as_array().map(|a| (a[0].as_u64().unwrap(), a[1].as_u64().unwrap()));
        assert_eq!(gpt_version(c["id"].as_str().unwrap()), want, "{}", c["id"]);
    }
    for c in g["cmp"].as_array().unwrap() {
        let got = compare_anthropic_version(c["a"].as_str().unwrap(), c["b"].as_str().unwrap()) as i64;
        assert_eq!(got, c["out"].as_i64().unwrap(), "{} {}", c["a"], c["b"]);
    }
}

#[test]
fn the_lighter_model_is_the_newest_of_the_subscription_family() {
    let rows = |ids: &[&str]| -> Vec<Value> { ids.iter().map(|id| json!({"id": id, "family": if id.contains("haiku") {"haiku"} else {"opus"}})).collect() };
    let claude = rows(&["claude-haiku-4-5", "claude-opus-4-1", "claude-haiku-3-5", "claude-haiku-4-5-20251001"]);
    assert_eq!(lighter_subscription_model("anthropic-oauth", &claude).as_deref(), Some("claude-haiku-4-5-20251001"));
    let gpt = rows(&["gpt-5.5", "gpt-5.4-luna", "gpt-5.5-luna", "gpt-5.5-luna-mini"]);
    // Same version: the undated alias (shorter id) over a longer one.
    assert_eq!(lighter_subscription_model("openai-oauth", &gpt).as_deref(), Some("gpt-5.5-luna"));
    assert_eq!(lighter_subscription_model("openai", &gpt), None);
    assert_eq!(lighter_subscription_model("anthropic-oauth", &rows(&["claude-opus-4-1"])), None);
}

#[test]
fn candidates_follow_the_main_model_or_the_configured_chain() {
    let none = |_: &str, _: &str| None;
    let main = MainRoute {
        provider: "openai-oauth".into(),
        model: "gpt-5.5".into(),
        effort: Some("high".into()),
        fast: true,
        model_parameters: json!({"a": "1"}),
        catalog_row: None,
    };
    let default = web_search_route_or_default(&[]).unwrap();
    let got = native_web_search_routes(&default, Some(&main), &none).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].source, got[0].key.as_str(), got[0].fast), ("default-web-search-route", "default\nopenai-oauth\ngpt-5.5", true));

    let codex = MainRoute { model: "gpt-5-codex".into(), ..main.clone() };
    assert!(native_web_search_routes(&default, Some(&codex), &none).unwrap().is_empty());
    assert_eq!(
        no_candidate_message(&default, Some(&codex)),
        "default web search route requires the current main model to support native web search (openai-oauth/gpt-5-codex)"
    );

    let chain = web_search_route_or_default(&[&json!({"provider": "gemini", "model": "gemini-2.5-pro",
        "fallbacks": [{"provider": "mixdog-local", "model": "x"}, {"provider": "anthropic", "model": "claude-opus-4-1"}]})])
    .unwrap();
    let got = native_web_search_routes(&chain, None, &none).unwrap();
    assert_eq!(got.iter().map(|c| c.provider.as_str()).collect::<Vec<_>>(), ["gemini", "anthropic"]);
    assert_eq!(
        no_candidate_message(&chain, None),
        "web search route \"gemini/gemini-2.5-pro\" cannot run native web search; open /websearch to choose another provider/model"
    );
}

#[test]
fn only_a_stated_capacity_refusal_before_output_moves_to_the_next_provider() {
    use mixdog_core_api::domain::provider::DeliveryState;
    let mut e = ProviderError::new(ErrorKind::RateLimited, DeliveryState::Accepted);
    e.status = Some(429);
    assert!(capacity_fallback(&e, false, false));
    assert!(!capacity_fallback(&e, true, false));
    e.exposure.text_emitted = true;
    assert!(!capacity_fallback(&e, false, false));
    let mut auth = ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted);
    auth.status = Some(401);
    assert!(!capacity_fallback(&auth, false, false));
    let transient = ProviderError::new(ErrorKind::Transient, DeliveryState::Ambiguous);
    assert!(!capacity_fallback(&transient, false, false));
    let quota = ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::Accepted);
    assert!(!capacity_fallback(&quota, false, false) && capacity_fallback(&quota, false, true));
}

#[test]
fn a_null_fallbacks_list_is_refused_like_node() {
    let err = route_chain(&serde_json::json!({"provider": "a", "model": "m", "fallbacks": null})).unwrap_err();
    assert_eq!(err, "route.fallbacks must be an array");
    assert_eq!(route_chain(&serde_json::json!({"provider": "a", "model": "m"})).unwrap().len(), 1);
}

#[test]
fn chain_providers_are_validated_like_node() {
    let r = |p: &str, m: &str| serde_json::json!({"provider": p, "model": m});
    assert!(validate_route_chain_providers(&[r("openai-api", "m"), r("anthropic", "m")], false).is_ok());
    assert_eq!(
        validate_route_chain_providers(&[r("openai", "m"), r("openai-api", "m")], false).unwrap_err(),
        "duplicate route provider \"openai\""
    );
    assert!(validate_route_chain_providers(&[r("openai", "m"), r("openai-api", "m")], true).is_ok());
    assert_eq!(validate_route_chain_providers(&[r("a", " ")], false).unwrap_err(), "route requires provider and model");
    assert_eq!(
        validate_route_chain_providers(&[r("a", "m"), r("default", "m")], false).unwrap_err(),
        "follow Main is only allowed as the primary route"
    );
}

#[test]
fn text_is_trimmed_with_js_whitespace() {
    // U+FEFF and U+00A0 are JS whitespace; U+0085 is not (Rust trims it).
    assert_eq!(canonical_route_provider("\u{feff}openai-api\u{a0}"), "openai");
    assert_eq!(canonical_route_provider("\u{85}openai-api"), "\u{85}openai-api");
    assert_eq!(clean(Some(&serde_json::json!("\u{feff} x \u{85}"))), "x \u{85}");
}

#[test]
fn request_cache_lifetimes_follow_the_provider_rules() {
    use CacheLifetime::{Forever, Ms};
    assert_eq!(request_cache_lifetime("openai-oauth", None, false), Forever);
    assert_eq!(request_cache_lifetime("openai", None, false), Ms(1_800_000));
    assert_eq!(request_cache_lifetime("anthropic", Some("5m"), false), Ms(300_000));
    assert_eq!(request_cache_lifetime("anthropic-oauth", Some("1h"), false), Ms(3_600_000));
    assert_eq!(request_cache_lifetime("anthropic", Some("none"), true), Ms(0));
    assert_eq!(request_cache_lifetime("gemini", None, true), Ms(300_000));
    assert_eq!(request_cache_lifetime("deepseek", None, false), Ms(0));
    assert_eq!(provider_tail_cache_lifetime_ms(" OpenAI ", None), Some(1_800_000));
    assert_eq!(provider_tail_cache_lifetime_ms("openai-oauth", None), None);
}

#[test]
fn the_cache_is_warm_inside_its_lifetime_less_a_margin() {
    let sent = 1_000_000;
    assert!(!compaction_cache_warm(None, sent));
    assert!(compaction_cache_warm(Some((CacheLifetime::Forever, sent)), u64::MAX / 2));
    let five = CacheLifetime::Ms(300_000);
    assert!(compaction_cache_warm(Some((five, sent)), sent + 269_999));
    assert!(!compaction_cache_warm(Some((five, sent)), sent + 270_000));
    // A short lifetime keeps the 30 s floor margin.
    assert!(!compaction_cache_warm(Some((CacheLifetime::Ms(40_000), sent)), sent + 10_000));
}