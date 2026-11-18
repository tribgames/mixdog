//! How a provider's usage answer becomes quota windows: one window from a percent-shaped entry, the Codex plan and its
//! model-specific limits, Anthropic's five-hour and weekly windows and its extra-usage budget.

use mixdog_ai::service::usage_normalize::normalize_anthropic_usage;
use mixdog_ai::service::usage_normalize::normalize_openai_wham_usage;
use mixdog_ai::service::usage_normalize::window_from_percent;
use serde_json::Value;
use serde_json::json;

const NOW: i64 = 1_800_000_000_000;

fn f(value: &Value) -> f64 {
    value.as_f64().unwrap_or_else(|| panic!("{value} is not a number"))
}

#[test]
fn a_window_is_labelled_by_its_length_and_carries_the_percent_and_the_reset() {
    let window = window_from_percent("X", Some(&json!({"used_percent": 42.567, "limit_window_seconds": 18_000, "reset_after_seconds": 600})), "src", NOW).unwrap();
    assert_eq!(window["label"], "5H");
    assert_eq!(window["source"], "src");
    assert_eq!(f(&window["usedPct"]), 42.57, "two places");
    assert_eq!(f(&window["resetAt"]), 1_800_000_600_000.0, "a relative reset counts from now");
    for (seconds, label) in [(604_800, "7D"), (86_400, "24H"), (2_592_000, "M"), (18_100, "5H"), (7_200, "X"), (0, "X")] {
        let w = window_from_percent("X", Some(&json!({"percent": 1, "limit_window_seconds": seconds})), "s", NOW).unwrap();
        assert_eq!(w["label"], label, "{seconds} s");
    }
    let by_minutes = window_from_percent("X", Some(&json!({"percent": 1, "window_minutes": 300})), "s", NOW).unwrap();
    assert_eq!(by_minutes["label"], "5H", "minutes are the same length in another unit");
}

#[test]
fn a_reset_is_read_from_text_seconds_or_milliseconds_and_an_entry_that_says_nothing_is_no_window() {
    let at = |reset: Value| f(&window_from_percent("L", Some(&json!({"percent": 5, "resets_at": reset})), "s", NOW).unwrap()["resetAt"]);
    assert_eq!(at(json!("2030-01-02T03:04:05Z")), 1_893_553_445_000.0);
    assert_eq!(at(json!(1_900_000_000)), 1_900_000_000_000.0, "epoch seconds");
    assert_eq!(at(json!(1_900_000_000_000u64)), 1_900_000_000_000.0, "epoch milliseconds");
    assert_eq!(window_from_percent("L", Some(&json!({"limit_window_seconds": 18_000})), "s", NOW), None, "a length alone states nothing");
    assert_eq!(window_from_percent("L", None, "s", NOW), None);
    let dollars = window_from_percent("L", Some(&json!({"limit_usd": 10, "used_usd": 2.5, "remaining_usd": 7.5})), "s", NOW).unwrap();
    assert_eq!((f(&dollars["limitUsd"]), f(&dollars["usedUsd"]), f(&dollars["remainingUsd"])), (10.0, 2.5, 7.5));
    assert!(dollars.get("resetAt").is_none() && dollars.get("usedPct").is_none());
}

#[test]
fn the_codex_plan_has_a_five_hour_and_a_weekly_window_and_its_credit_balance() {
    let data = json!({
        "plan_type": "pro",
        "rate_limit": {
            "primary_window": {"used_percent": 10, "limit_window_seconds": 18_000, "reset_after_seconds": 60},
            "secondary_window": {"used_percent": 55.5, "limit_window_seconds": 604_800, "reset_at": 1_900_000_000},
        },
        "credits": {"balance": "12.34567", "unlimited": false, "has_credits": true},
    });
    let usage = normalize_openai_wham_usage(&data, NOW).unwrap();
    assert_eq!((usage["provider"].clone(), usage["source"].clone(), usage["planType"].clone()), (json!("openai-oauth"), json!("openai-codex-wham"), json!("pro")));
    let windows = usage["quotaWindows"].as_array().unwrap();
    assert_eq!(windows.len(), 2);
    assert_eq!((windows[0]["label"].clone(), windows[0]["limit"].clone(), windows[0]["source"].clone()), (json!("5H"), json!("codex"), json!("openai-codex-oauth")));
    assert_eq!((windows[1]["label"].clone(), f(&windows[1]["usedPct"]), f(&windows[1]["resetAt"])), (json!("7D"), 55.5, 1_900_000_000_000.0));
    assert!(windows[0].get("except").is_none(), "no model has a limit of its own");
    assert_eq!(usage["balance"]["unit"], "credits");
    assert_eq!(f(&usage["balance"]["remainingCredits"]), 12.3457);
    assert_eq!((usage["balance"]["unlimited"].clone(), usage["balance"]["hasCredits"].clone()), (json!(false), json!(true)));
    assert_eq!(usage["rawKeys"], json!(["credits", "plan_type", "rate_limit"]), "the answer's own keys, sorted");
}

#[test]
fn a_codex_answer_without_a_readable_plan_window_is_no_reading_and_the_short_field_names_are_read_too() {
    assert_eq!(normalize_openai_wham_usage(&json!({}), NOW), None);
    assert_eq!(normalize_openai_wham_usage(&json!({"rate_limit": {}}), NOW), None);
    assert_eq!(normalize_openai_wham_usage(&json!({"rate_limit": {"primary_window": {"limit_window_seconds": 18_000}}}), NOW), None);
    let short = normalize_openai_wham_usage(&json!({"rate_limit": {"primary": {"used_percent": 3}}}), NOW).unwrap();
    assert_eq!(short["quotaWindows"].as_array().unwrap().len(), 1);
    assert!(short["balance"].is_null());
}

#[test]
fn a_model_with_a_limit_of_its_own_gets_its_windows_and_the_plan_windows_say_which_models_they_exclude() {
    let data = json!({
        "rate_limit": {"primary_window": {"used_percent": 10, "limit_window_seconds": 18_000}},
        "additional_rate_limits": [
            {"limit_name": "GPT-5.5-Luna", "metered_feature": "gpt-5.5-luna", "rate_limit": {"primary_window": {"used_percent": 70, "limit_window_seconds": 18_000}}},
            {"limit_name": "nothing", "rate_limit": {}},
        ],
    });
    let windows = normalize_openai_wham_usage(&data, NOW).unwrap()["quotaWindows"].as_array().unwrap().clone();
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0]["except"], json!(["gpt-5.5-luna"]));
    assert_eq!(windows[1]["label"], "5H GPT-5.5-Luna");
    assert_eq!((windows[1]["limit"].clone(), windows[1]["models"].clone()), (json!("gpt_5.5_luna"), json!(["gpt-5.5-luna"])));
    assert_eq!(f(&windows[1]["usedPct"]), 70.0);
}

#[test]
fn anthropics_five_hour_and_weekly_windows_are_read_and_an_empty_answer_is_no_reading() {
    let data = json!({"five_hour": {"utilization": 30, "resets_at": "2030-01-02T03:04:05Z"}, "seven_day": {"utilization": 60}});
    let usage = normalize_anthropic_usage(&data, "anthropic-oauth", NOW).unwrap();
    assert_eq!((usage["provider"].clone(), usage["source"].clone()), (json!("anthropic-oauth"), json!("anthropic-oauth")));
    let windows = usage["quotaWindows"].as_array().unwrap();
    assert_eq!((windows[0]["label"].clone(), f(&windows[0]["usedPct"]), f(&windows[0]["resetAt"])), (json!("5H"), 30.0, 1_893_553_445_000.0));
    assert_eq!((windows[1]["label"].clone(), f(&windows[1]["usedPct"])), (json!("7D"), 60.0));
    assert_eq!(usage["rawKeys"], json!(["five_hour", "seven_day"]));
    assert_eq!(normalize_anthropic_usage(&json!({}), "anthropic-oauth", NOW), None);
    assert_eq!(normalize_anthropic_usage(&json!("x"), "anthropic-oauth", NOW), None);
}

#[test]
fn when_there_are_no_named_windows_the_session_and_weekly_limits_stand_in_and_scoped_limits_do_not() {
    let data = json!({"limits": [
        {"kind": "session", "percent": 20},
        {"kind": "weekly_all", "percent": 40},
        {"kind": "weekly_model", "percent": 90, "scope": {"model": "opus"}},
        {"kind": "weekly_surface", "percent": 95, "scope": {"surface": "chat"}},
    ]});
    let usage = normalize_anthropic_usage(&data, "anthropic-oauth", NOW).unwrap();
    let windows = usage["quotaWindows"].as_array().unwrap();
    let labels: Vec<(&str, f64)> = windows.iter().take(2).map(|w| (w["label"].as_str().unwrap(), f(&w["usedPct"]))).collect();
    assert_eq!(labels, [("5H", 20.0), ("7D", 40.0)]);
    assert!(windows.iter().all(|w| w["usedPct"] != json!(90) || w["label"] != "7D"), "a model's own limit is not the weekly window");
}

#[test]
fn the_extra_usage_budget_is_a_monthly_balance_in_dollars_from_cents() {
    let data = json!({"five_hour": {"utilization": 1}, "extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 1250, "currency": "USD"}});
    let usage = normalize_anthropic_usage(&data, "anthropic-oauth", NOW).unwrap();
    assert_eq!(usage["balance"]["source"], "anthropic-oauth-extra");
    assert_eq!(usage["balance"]["period"], "monthly");
    assert_eq!((f(&usage["balance"]["budgetUsd"]), f(&usage["balance"]["spentUsd"]), f(&usage["balance"]["remainingUsd"])), (50.0, 12.5, 37.5));
    let over = normalize_anthropic_usage(&json!({"five_hour": {"utilization": 1}, "extra_usage": {"monthly_limit": 1000, "used_credits": 2000}}), "anthropic-oauth", NOW).unwrap();
    assert_eq!(f(&over["balance"]["remainingUsd"]), 0.0, "never below zero");
}

#[test]
fn scoped_limits_and_seven_day_family_keys_are_their_own_windows_with_their_values_and_resets() {
    let data = json!({
        "five_hour": {"utilization": 10},
        "seven_day": {"utilization": 20},
        "seven_day_opus": {"utilization": 80, "resets_at": "2030-01-02T03:04:05Z"},
        "limits": [
            {"kind": "weekly_model", "percent": 90, "resets_at": 1_900_000_000, "scope": {"model": {"display_name": "Sonnet 4"}}},
            {"kind": "weekly_surface", "percent": 95, "scope": {"surface": {"id": "claude_code"}}},
            {"kind": "weekly_all", "percent": 5},
        ],
    });
    let usage = normalize_anthropic_usage(&data, "anthropic-oauth", NOW).unwrap();
    let windows: Vec<(String, f64)> = usage["quotaWindows"].as_array().unwrap().iter().map(|w| (w["label"].as_str().unwrap().to_owned(), f(&w["usedPct"]))).collect();
    assert_eq!(windows[..2], [("5H".to_owned(), 10.0), ("7D".to_owned(), 20.0)], "the named windows lead");
    assert!(windows.contains(&("7D Opus".to_owned(), 80.0)), "{windows:?}");
    assert!(windows.contains(&("7D Claude code".to_owned(), 95.0)), "a surface-scoped limit is labelled by its surface: {windows:?}");
    let opus = usage["quotaWindows"].as_array().unwrap().iter().find(|w| w["label"] == "7D Opus").unwrap();
    assert_eq!(f(&opus["resetAt"]), 1_893_553_445_000.0);
    assert!(windows.iter().all(|(label, _)| label != "7D" || windows.iter().filter(|(l, _)| l == "7D").count() == 1), "the unscoped weekly limit does not duplicate the named window");
}

#[test]
fn the_spend_object_wins_over_extra_usage_and_reads_its_balance_cap_or_limit_in_minor_units() {
    let base = |spend: Value| json!({"five_hour": {"utilization": 1}, "extra_usage": {"monthly_limit": 5000, "used_credits": 100}, "spend": spend});
    let balance = |spend: Value| normalize_anthropic_usage(&base(spend), "anthropic-oauth", NOW).unwrap()["balance"].clone();

    let direct = balance(json!({"balance": {"amount_minor": 4200, "exponent": 2}, "used": {"amount_minor": 800, "currency": "EUR"}}));
    assert_eq!((direct["source"].clone(), f(&direct["remainingUsd"]), f(&direct["spentUsd"]), direct["currency"].clone()), (json!("anthropic-oauth-spend"), 42.0, 8.0, json!("EUR")));

    let capped = balance(json!({"cap": {"credits": {"amount_minor": 10_000}}, "used": {"amount_minor": 2_500}}));
    assert_eq!((f(&capped["remainingUsd"]), f(&capped["spentUsd"]), capped["currency"].clone()), (75.0, 25.0, json!("USD")), "cap less used, in whole units, USD when none is named");

    let limited = balance(json!({"limit": {"amount_minor": 3_000, "currency": "GBP"}, "used": {"amount_minor": 4_000}}));
    assert_eq!((f(&limited["remainingUsd"]), f(&limited["spentUsd"]), limited["currency"].clone()), (0.0, 40.0, json!("GBP")), "never below zero");

    let unlimited = balance(json!({"limit": {"amount_minor": 0}, "used": {"amount_minor": 400}}));
    assert_eq!(unlimited["source"], "anthropic-oauth-extra", "a limit of zero states no budget; the extra-usage balance stands");

    let exponent = balance(json!({"balance": {"amount_minor": 1234, "exponent": 3}}));
    assert_eq!(f(&exponent["remainingUsd"]), 1.234, "the exponent names the minor unit");
}