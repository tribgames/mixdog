use serde_json::json;

use super::*;

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


// Cases of Node's recording of these decisions (provider alias, GPT version, Anthropic ordering and hosted web-search capability), kept
// here as tracked inputs: the shipped suite checks the product's own answer to each.
const CAPABLE: &[(&str, &str, bool)] = &[
    ("openai", "gpt-5.5", true),
    ("openai", "gpt-4", false),
    ("openai", "o1", false),
    ("openai", "o3", true),
    ("openai", "o2-x", false),
    ("openai", "text-embedding-3", false),
    ("openai", "davinci-002", false),
    ("openai-oauth", "gpt-5.5", true),
    ("openai-oauth", "gpt-4", false),
    ("openai-oauth", "o1", false),
    ("openai-oauth", "o3", true),
    ("openai-oauth", "o2-x", false),
    ("openai-oauth", "text-embedding-3", false),
    ("openai-oauth", "davinci-002", false),
    ("xai", "gpt-5.5", true),
    ("xai", "o1", true),
    ("xai", "o3", true),
    ("xai", "o2-x", true),
    ("xai", "text-embedding-3", false),
    ("xai", "davinci-002", true),
    ("xai", "babbage", true),
    ("grok-oauth", "gpt-5.5", true),
    ("grok-oauth", "o1", true),
    ("grok-oauth", "o3", true),
    ("grok-oauth", "o2-x", true),
    ("grok-oauth", "text-embedding-3", false),
    ("grok-oauth", "davinci-002", true),
    ("grok-oauth", "babbage", true),
    ("gemini", "gpt-5.5", false),
    ("gemini", "o1", false),
    ("gemini", "o3", false),
    ("gemini", "o2-x", false),
    ("gemini", "text-embedding-3", false),
    ("gemini", "davinci-002", false),
    ("gemini", "babbage", false),
    ("antigravity-oauth", "gpt-5.5", false),
    ("antigravity-oauth", "o1", false),
    ("antigravity-oauth", "o3", false),
    ("antigravity-oauth", "o2-x", false),
    ("antigravity-oauth", "text-embedding-3", false),
    ("antigravity-oauth", "davinci-002", false),
    ("antigravity-oauth", "babbage", false),
    ("anthropic", "gpt-5.5", true),
    ("anthropic", "o1", true),
    ("anthropic", "o3", true),
    ("anthropic", "o2-x", true),
    ("anthropic", "text-embedding-3", true),
    ("anthropic", "davinci-002", true),
    ("anthropic", "babbage", true),
    ("anthropic-oauth", "gpt-5.5", true),
    ("anthropic-oauth", "o1", true),
    ("anthropic-oauth", "o3", true),
    ("anthropic-oauth", "o2-x", true),
    ("anthropic-oauth", "text-embedding-3", true),
    ("anthropic-oauth", "davinci-002", true),
    ("anthropic-oauth", "babbage", true),
    ("openai-api", "gpt-5.5", true),
    ("openai-api", "gpt-4", false),
    ("openai-api", "o1", false),
    ("openai-api", "o3", true),
    ("openai-api", "o2-x", false),
    ("openai-api", "text-embedding-3", false),
    ("openai-api", "davinci-002", false),
    ("xai-api", "gpt-5.5", true),
    ("xai-api", "o1", true),
    ("xai-api", "o3", true),
    ("xai-api", "o2-x", true),
    ("xai-api", "text-embedding-3", false),
    ("xai-api", "davinci-002", true),
    ("xai-api", "babbage", true),
    ("mixdog-local", "gpt-5.5", false),
    ("mixdog-local", "o1", false),
    ("mixdog-local", "o3", false),
    ("mixdog-local", "o2-x", false),
    ("mixdog-local", "text-embedding-3", false),
    ("mixdog-local", "davinci-002", false),
    ("mixdog-local", "babbage", false),
    ("custom-x", "gpt-5.5", false),
    ("custom-x", "o1", false),
    ("custom-x", "o3", false),
    ("custom-x", "o2-x", false),
    ("custom-x", "text-embedding-3", false),
    ("custom-x", "davinci-002", false),
    ("custom-x", "babbage", false),
];
const CAPABLE_WITH_ROWS: &[(&str, &str, &str, &str, bool)] = &[
    ("openai", "gpt-5", r#"null"#, r#"{"supportsWebSearch": true}"#, true),
    ("openai", "gpt-5", r#"null"#, r#"{"supportsWebSearch": false}"#, false),
    ("openai", "gpt-5", r#"{"supportsWebSearch": true}"#, r#"null"#, true),
    ("openai", "gpt-5", r#"{"supportsWebSearch": false}"#, r#"null"#, false),
    ("openai", "gpt-5", r#"{"supportedTools": [{"type": "web_search_preview"}]}"#, r#"null"#, true),
    ("openai", "gpt-5", r#"{"tools": ["web_search"]}"#, r#"null"#, true),
    ("openai", "gpt-5", r#"{"capabilities": {"tools": [{"name": "other"}]}}"#, r#"null"#, true),
    ("openai", "gpt-4", r#"{"capabilities": {"tools": [{"name": "other"}]}}"#, r#"null"#, false),
];
const CANONICAL: &[(&str, &str)] = &[
    ("openai-api", "openai"),
    ("xai-api", "xai"),
    ("gemini-api", "gemini"),
    ("anthropic-api", "anthropic"),
    (" openai ", "openai"),
    ("openai", "openai"),
];
const GPT: &[(&str, Option<(u64, u64)>)] = &[
    ("gpt-5", Some((5, 0))),
    ("gpt-5.5", Some((5, 5))),
    ("gpt-5.5-luna", Some((5, 5))),
    ("gpt-5.4-luna-mini", Some((5, 4))),
    ("gpt-40", None),
    ("gpt-40-x", Some((40, 0))),
    ("gpt-5.x", None),
    ("gpt-5.", None),
    ("gpt-", None),
    ("gpt-5-codex", Some((5, 0))),
    ("gpt-10.2", Some((10, 2))),
    ("gpt-5.1.2", None),
    ("gpt-oss", None),
    ("claude-x", None),
    ("gpt-5.10-luna", Some((5, 10))),
];
const VERSION_ORDER: &[(&str, &str, i64)] = &[
    ("claude-haiku-4-5", "claude-haiku-4-5", 0),
    ("claude-haiku-4-5", "claude-opus-4-1", 1),
    ("claude-haiku-4-5", "CLAUDE-HAIKU-4-5", -1),
    ("claude-haiku-3-5", "claude-haiku-4", -1),
    ("claude-haiku-3-5", "claude-haiku-10-1", -1),
    ("claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", 0),
    ("claude-haiku-4-5-20251001", "not-claude", 1),
    ("claude-haiku-4", "claude-haiku-3-5", 1),
    ("claude-haiku-4", "claude-sonnet-4-5", -1),
    ("claude-opus-4-1", "claude-haiku-4-5", -1),
    ("claude-opus-4-1", "claude-opus-4-1", 0),
    ("claude-opus-4-1", "CLAUDE-HAIKU-4-5", -1),
    ("claude-sonnet-4-5", "claude-haiku-4", 1),
    ("claude-sonnet-4-5", "claude-haiku-10-1", -1),
    ("not-claude", "claude-haiku-4-5-20251001", -1),
    ("not-claude", "not-claude", 0),
    ("claude-haiku-10-1", "claude-haiku-3-5", 1),
    ("claude-haiku-10-1", "claude-sonnet-4-5", 1),
    ("CLAUDE-HAIKU-4-5", "claude-haiku-4-5", 1),
    ("CLAUDE-HAIKU-4-5", "claude-opus-4-1", 1),
    ("CLAUDE-HAIKU-4-5", "CLAUDE-HAIKU-4-5", 0),
];

#[test]
fn hosted_web_search_capability_follows_the_provider_and_the_model_family() {
    for (provider, id, want) in CAPABLE {
        assert_eq!(web_search_capable_for(provider, id, None, None), *want, "{provider} {id}");
    }
}

#[test]
fn a_route_row_or_a_catalog_row_decides_hosted_web_search_capability_where_it_states_one() {
    for (provider, id, row, catalog, want) in CAPABLE_WITH_ROWS {
        let row: Value = serde_json::from_str(row).unwrap();
        let catalog: Value = serde_json::from_str(catalog).unwrap();
        // The route passes the bare id when it holds no row.
        let model_row = Some(&row).filter(|r| !r.is_null()).map(|r| {
            let mut o = r.as_object().unwrap().clone();
            o.insert("id".into(), (*id).into());
            Value::Object(o)
        });
        let got = web_search_capable_for(provider, id, model_row.as_ref(), Some(&catalog).filter(|c| !c.is_null()));
        assert_eq!(got, *want, "{provider} {id} {row} {catalog}");
    }
}

#[test]
fn provider_aliases_gpt_versions_and_claude_order_are_the_documented_ones() {
    for (name, want) in CANONICAL {
        assert_eq!(canonical_route_provider(name), *want, "{name}");
    }
    for (id, want) in GPT {
        assert_eq!(gpt_version(id), *want, "{id}");
    }
    for (a, b, want) in VERSION_ORDER {
        assert_eq!(compare_anthropic_version(a, b) as i64, *want, "{a} {b}");
    }
}

/// Node's recorded outputs (`tests/golden/routes/routes.json`).
#[cfg(node_twin)]
fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/golden/routes/routes.json")).unwrap()
}
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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

/// A web-search route as the documented rules normalise it (Node 1.4.5): the provider alias and the model are
/// canonical and trimmed, an unknown effort or a non-boolean `fast` is dropped, the first candidate that names a route
/// wins, and each way a fallback chain is wrong is refused in its own words. The text is compared, so the field order is
/// part of the rule. Per row: the candidates, the route or the refusal, whether it is the default route, its whole chain
/// and the fallbacks that execute after it.
#[test]
fn a_web_search_route_is_normalised_and_its_chain_checked_as_documented() {
    #[allow(clippy::type_complexity)]
    let rows: [(&str, Result<&str, &str>, bool, &[&str], &[&str]); 12] = [
        (r#"[null]"#, Ok(r#"{"provider":"default","model":"default"}"#), true, &[r#"{"provider":"default","model":"default"}"#], &[]),
        (r#"[null]"#, Ok(r#"{"provider":"default","model":"default"}"#), true, &[r#"{"provider":"default","model":"default"}"#], &[]),
        (r#"[{}]"#, Ok(r#"{"provider":"default","model":"default"}"#), true, &[r#"{"provider":"default","model":"default"}"#], &[]),
        (r#"[{"provider":"default","model":"default"}]"#, Ok(r#"{"provider":"default","model":"default"}"#), true, &[r#"{"provider":"default","model":"default"}"#], &[]),
        (r#"[{"provider":"openai-api","model":" gpt-5 ","effort":"HIGH","fast":true,"toolType":" web_search ","modelParameters":{"a":"1"}}]"#, Ok(r#"{"provider":"openai","model":"gpt-5","effort":"high","fast":true,"modelParameters":{"a":"1"},"toolType":"web_search"}"#), false, &[r#"{"provider":"openai","model":"gpt-5","effort":"high","fast":true,"modelParameters":{"a":"1"},"toolType":"web_search"}"#], &[]),
        (r#"[{"provider":"xai","model":"grok-4.5","effort":"bogus","fast":"yes"}]"#, Ok(r#"{"provider":"xai","model":"grok-4.5"}"#), false, &[r#"{"provider":"xai","model":"grok-4.5"}"#], &[]),
        (r#"[{"provider":"openai","model":"gpt-5","fallbacks":[{"provider":"gemini","model":"gemini-2.5-pro"}]}]"#, Ok(r#"{"provider":"openai","model":"gpt-5","fallbacks":[{"provider":"gemini","model":"gemini-2.5-pro"}]}"#), false, &[r#"{"provider":"openai","model":"gpt-5"}"#, r#"{"provider":"gemini","model":"gemini-2.5-pro"}"#], &[r#"{"provider":"gemini","model":"gemini-2.5-pro"}"#]),
        (r#"[{"provider":"anthropic","model":"m","fallbacks":[{"provider":"anthropic-api","model":"m2"}]}]"#, Err("duplicate route provider \"anthropic\""), false, &[], &[]),
        (r#"[{"provider":"openai","model":"m","fallbacks":[{"provider":"default","model":"default"}]}]"#, Err("follow Main is only allowed as the primary route"), false, &[], &[]),
        (r#"[{"provider":"openai","model":"m","fallbacks":[{"provider":"x"}]}]"#, Err("fallback route requires provider and model"), false, &[], &[]),
        (r#"[{"provider":"","model":"x"},{"provider":"gemini","model":"g"}]"#, Ok(r#"{"provider":"gemini","model":"g"}"#), false, &[r#"{"provider":"gemini","model":"g"}"#], &[]),
        (r#"[{"provider":"default","model":" DEFAULT "}]"#, Ok(r#"{"provider":"default","model":"DEFAULT"}"#), true, &[r#"{"provider":"default","model":"DEFAULT"}"#], &[]),
    ];
    for (candidates, outcome, is_default, chain, exec) in rows {
        let candidates: Vec<Value> = serde_json::from_str(candidates).unwrap();
        let candidates: Vec<&Value> = candidates.iter().collect();
        let got = web_search_route_or_default(&candidates);
        let route = match outcome {
            Err(message) => {
                assert_eq!(got.unwrap_err(), message, "{candidates:?}");
                continue;
            }
            Ok(route) => route,
        };
        let text = |v: &str| serde_json::from_str::<Value>(v).unwrap().to_string();
        let got = got.unwrap();
        assert_eq!(got.to_string(), text(route), "{candidates:?}");
        assert_eq!(is_default_web_search_route(&got), is_default, "{candidates:?}");
        let texts = |rows: Vec<Value>| rows.iter().map(Value::to_string).collect::<Vec<_>>();
        assert_eq!(texts(route_chain(&got).unwrap()), chain.iter().map(|v| text(v)).collect::<Vec<_>>(), "{candidates:?}");
        assert_eq!(texts(execution_fallbacks(&got).unwrap()), exec.iter().map(|v| text(v)).collect::<Vec<_>>(), "{candidates:?}");
    }
}
