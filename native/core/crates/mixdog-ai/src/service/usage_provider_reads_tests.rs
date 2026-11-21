//! The five plan-usage readings (Antigravity, Command Code, Cursor, Muse Code, OpenCode Go): the request each puts on
//! the wire, the windows built from an answer, and what each failure reads as.

#![cfg(test)]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::Net;
use crate::accounts::AccountStore;
use crate::oauth::CredentialIo;
use crate::oauth::pace::FakePace;
use crate::service::oauth_usage::UsageSource;
use crate::service::usage_antigravity;
use crate::service::usage_command_code;
use crate::service::usage_cursor;
use crate::service::usage_muse_code;
use crate::service::usage_opencode_go;
use crate::service::usage_ports::ProviderUsageSource;
use crate::transport::Exchange;
use crate::transport::Redirect;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

fn num(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap_or_else(|| panic!("{key} in {value}"))
}

// Test files go through the durability lane and `mixdog_statefile`, as the tree's other tests do.
fn on_lane<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
    use futures::FutureExt as _;
    use mixdog_rt::LaneToken as _;
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

struct World {
    source: ProviderUsageSource,
    net: Arc<Net>,
    pace: Arc<FakePace>,
    dir: tempfile::TempDir,
}

/// A source over a scripted network and a controlled clock, with `creds` stored for `provider`'s default account.
fn world(provider: &str, creds: Option<Value>, replies: Value) -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = AccountStore::new(dir.path().to_path_buf(), io());
    if let Some(creds) = creds {
        let file = store.credential_file(provider, "default").unwrap();
        let (path, body) = (file.path().to_owned(), creds.to_string().into_bytes());
        on_lane(move |lane| {
            mixdog_statefile::create_private_dir_all(lane, path.parent().unwrap())?;
            mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())
        })
        .unwrap();
    }
    let net = Net::from(&replies);
    let pace = Arc::new(FakePace::default());
    pace.now.store(1_000_000, Ordering::SeqCst);
    let source = ProviderUsageSource::with_pace(store, net.clone(), pace.clone()).with_jitter(Arc::new(|| 0.5));
    World { source, net, pace, dir }
}

fn only_request(world: &World) -> (WireRequest, Exchange) {
    let seen = world.net.seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "one request: {:?}", seen.iter().map(|r| &r.url).collect::<Vec<_>>());
    (seen[0].clone(), world.net.exchanges.lock().unwrap()[0])
}

fn requests(world: &World) -> usize {
    world.net.seen.lock().unwrap().len()
}

// Command Code

const CC_KEY: &str = "cc-key-0123456789abcdef";

fn command_code(replies: Value) -> World {
    world(usage_command_code::PROVIDER_ID, Some(json!({ "apiKey": CC_KEY, "userId": "user-7" })), replies)
}

const CREDITS: &str = "https://api.commandcode.ai/alpha/billing/credits";

#[tokio::test]
async fn command_code_reads_its_credits_with_the_key_and_reports_a_window_per_limit() {
    let world = command_code(json!([{ "url": CREDITS, "body": { "data": { "windowLimits": {
        "fiveHour": { "cap": 200, "used": 50, "resetAt": 1_900_000_000 },
        "weekly": { "cap": 100, "used": 95 } } } } }]));
    let snapshot = world.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap().expect("a reading");

    let (request, exchange) = only_request(&world);
    assert_eq!((request.method.as_str(), request.url.as_str()), ("GET", CREDITS));
    assert_eq!(request.headers, [("Accept".to_owned(), "application/json".to_owned()), ("Authorization".to_owned(), format!("Bearer {CC_KEY}"))]);
    assert_eq!(exchange.redirect, Redirect::Error, "a redirect is a network error");
    assert_eq!(exchange.liveness.total_deadline(), Some(Duration::from_secs(15)));

    assert_eq!(
        (snapshot["provider"].as_str(), snapshot["accountId"].as_str(), snapshot["source"].as_str()),
        (Some("command-code-oauth"), Some("user-7"), Some("command-code-credits"))
    );
    let windows = snapshot["quotaWindows"].as_array().unwrap();
    assert_eq!(windows.len(), 2);
    let five = &windows[0];
    assert_eq!(
        (five["id"].as_str(), five["label"].as_str(), five["longLabel"].as_str(), five["status"].as_str()),
        (Some("5h"), Some("5H"), Some("5 Hours"), Some("ok"))
    );
    assert_eq!((num(five, "usedPct"), num(five, "remainingFraction"), num(five, "durationMs")), (25.0, 0.75, 18_000_000.0));
    assert_eq!(num(five, "resetAt"), 1_900_000_000_000.0, "a reset in epoch seconds is read as milliseconds");
    let week = &windows[1];
    assert_eq!((week["id"].as_str(), week["label"].as_str(), week["status"].as_str()), (Some("1w"), Some("7D"), Some("warning")), "90 % and over warns");
    assert_eq!((num(week, "usedPct"), num(week, "durationMs")), (95.0, 604_800_000.0));
    assert!(week.get("resetAt").is_none(), "no reset when none is stated");
}

#[test]
fn a_command_code_window_needs_a_positive_cap_and_a_non_negative_use_and_is_capped_at_exhausted() {
    let windows = |body: Value| usage_command_code::quota_windows_from_credits(&body);
    let exhausted = windows(json!({ "windowLimits": { "fiveHour": { "cap": 10, "used": 25 } } }));
    assert_eq!((num(&exhausted[0], "usedPct"), exhausted[0]["status"].as_str()), (100.0, Some("exhausted")));
    for bad in
        [json!({ "cap": 0, "used": 1 }), json!({ "cap": -5, "used": 1 }), json!({ "cap": 10, "used": -1 }), json!({ "cap": "x", "used": 1 }), json!("nope")]
    {
        assert!(windows(json!({ "windowLimits": { "fiveHour": bad } })).is_empty(), "{bad}");
    }
    // A numeric text counts; an unreadable reset is no reset.
    let text = windows(json!({ "windowLimits": { "weekly": { "cap": "100", "used": "10", "resetAt": "not a date" } } }));
    assert_eq!(num(&text[0], "usedPct"), 10.0);
    assert!(text[0].get("resetAt").is_none());
    // The answer holds no window: no snapshot at all.
    assert!(usage_command_code::snapshot(&json!({ "windowLimits": {} }), "u", 1).is_none());
}

#[tokio::test]
async fn command_code_failures_read_as_their_status_with_the_key_scrubbed_from_the_detail() {
    let unauthorized = command_code(json!([{ "url": CREDITS, "status": 401, "body": format!("bad key {CC_KEY}") }]));
    let error = unauthorized.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert!(
        error.message.starts_with("[command-code-oauth] API key rejected (401) — open /providers in mixdog to sign in again: bad key "),
        "{}",
        error.message
    );
    assert!(!error.message.contains(CC_KEY), "the credential never reaches the message: {}", error.message);

    let down = command_code(json!([{ "url": CREDITS, "status": 502, "body": "" }]));
    let error = down.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!((error.status, error.message.as_str()), (Some(502), "[command-code-oauth] /alpha/billing/credits 502"));

    let long = command_code(json!([{ "url": CREDITS, "status": 500, "body": "x".repeat(1000) }]));
    let error = long.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.message, format!("[command-code-oauth] /alpha/billing/credits 500: {}", "x".repeat(300)), "the detail is cut at 300 characters");

    let garbled = command_code(json!([{ "url": CREDITS, "body": "{not json" }]));
    let error = garbled.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!((error.status, error.message.as_str()), (None, "[command-code-oauth] /alpha/billing/credits returned invalid JSON"));

    let unreachable = command_code(json!([{ "url": CREDITS, "fail": true }]));
    let error = unreachable.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.message, "fetch failed");
}

#[tokio::test]
async fn command_code_without_a_stored_key_is_signed_out_and_sends_nothing() {
    for creds in [None, Some(json!({ "apiKey": "   " }))] {
        let world = world(usage_command_code::PROVIDER_ID, creds, json!([]));
        let error = world.source.provider_snapshot(usage_command_code::PROVIDER_ID, "default").await.unwrap_err();
        assert_eq!(error.message, "[command-code-oauth] credentials not found — open /providers in mixdog to sign in first");
        assert_eq!(requests(&world), 0);
    }
}

// Antigravity

fn bucket(id: &str, window: &str, remaining: f64, reset: Option<&str>) -> Value {
    let mut bucket = json!({ "bucketId": id, "window": window, "remainingFraction": remaining });
    if let Some(reset) = reset {
        bucket["resetTime"] = reset.into();
    }
    bucket
}

fn rows(summary: Value) -> Vec<Value> {
    usage_antigravity::quota_windows(&summary)
}

#[test]
fn antigravity_rows_come_from_the_gateways_bucket_ids_and_the_used_share_is_the_complement() {
    let all = rows(json!({ "groups": [{ "buckets": [
        bucket("gemini-5h", "5h", 0.75, Some("2030-01-01T00:00:00Z")),
        bucket("gemini-weekly", "weekly", 0.5, None),
        bucket("gemini-argon-wtu-weekly", "weekly", 0.2, None),
        bucket("3p-5h", "5h", 1.0, None),
        bucket("3p-weekly", "weekly", 0.9, None),
    ] }] }));
    let labels: Vec<&str> = all.iter().map(|r| r["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["5H", "7D", "7D Argon", "5H Claude/GPT", "7D Claude/GPT"]);
    assert_eq!(all.iter().map(|r| num(r, "usedPct")).collect::<Vec<_>>(), [25.0, 50.0, 80.0, 0.0, 10.0]);
    assert_eq!(num(&all[0], "resetAt"), 1_893_456_000_000.0);
    assert!(all[1].get("resetAt").is_none());
    // Each bucket gates only the models it covers; the Gemini pair leaves the separately metered Argon alone.
    assert_eq!(all[0]["models"], json!(["gemini"]));
    assert_eq!(all[0]["except"], json!(["argon"]));
    assert_eq!(all[1]["models"], json!(["gemini"]));
    assert_eq!(all[1]["except"], json!(["argon"]));
    assert_eq!(all[2]["models"], json!(["argon"]));
    assert_eq!(all[3]["models"], json!(["claude", "gpt"]));
    assert!(all.iter().all(|r| r["source"] == "antigravity-quota-summary"));
}

#[test]
fn antigravity_gemini_rows_cover_only_gemini_and_odd_buckets_are_skipped() {
    let plain = rows(json!({ "groups": [{ "buckets": [bucket("gemini-5h", "5h", 0.4, None)] }] }));
    assert_eq!(plain.len(), 1);
    assert!(plain[0].get("except").is_none());
    assert_eq!(plain[0]["models"], json!(["gemini"]));
    assert_eq!(num(&plain[0], "usedPct"), 60.0);
    // A bucket under another window name, with no fraction, or out of range is not a reading / is clamped.
    assert!(rows(json!({ "groups": [{ "buckets": [bucket("gemini-5h", "weekly", 0.4, None)] }] })).is_empty());
    // A fraction that is present but not a number is malformed, even beside a reset time: only omission reads as empty.
    assert!(
        rows(
            json!({ "groups": [{ "buckets": [{ "bucketId": "gemini-5h", "window": "5h", "remainingFraction": "n/a", "resetTime": "2030-01-01T00:00:00Z" }] }] })
        )
        .is_empty()
    );
    assert!(rows(json!({ "groups": [{ "buckets": [{ "bucketId": "gemini-5h", "window": "5h" }] }] })).is_empty());
    let clamped = rows(json!({ "groups": [{ "buckets": [bucket("gemini-5h", "5h", 1.5, None), bucket("gemini-weekly", "weekly", -0.5, None)] }] }));
    assert_eq!(clamped.iter().map(|r| num(r, "usedPct")).collect::<Vec<_>>(), [0.0, 100.0]);
    // The snapshot is an object even with nothing in it.
    let empty = usage_antigravity::snapshot(&json!({}));
    assert_eq!((empty["provider"].as_str(), empty["quotaWindows"].as_array().map(Vec::len)), (Some("antigravity-oauth"), Some(0)));
}

#[test]
fn antigravity_argon_under_the_wrong_window_neither_shows_nor_takes_argon_out_of_the_gemini_row() {
    let all = rows(json!({ "groups": [{ "buckets": [
        bucket("gemini-5h", "5h", 0.0, None),
        bucket("gemini-argon-wtu-weekly", "daily", 0.5, None),
    ] }] }));
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(all[0]["label"], "5H");
    assert!(all[0].get("except").is_none(), "{:?}", all[0]);
}

#[test]
fn antigravity_unknown_buckets_keep_the_responses_name_and_a_reset_without_fraction_is_exhausted() {
    let all = rows(json!({ "groups": [{ "buckets": [
        bucket("gemini-5h", "5h", 0.5, None),
        { "bucketId": "neon-daily", "displayName": "Neon Daily", "window": "daily", "remainingFraction": 0.25 },
        { "bucketId": "other-weekly", "window": "weekly", "resetTime": "2030-01-01T00:00:00Z" },
    ] }] }));
    let labels: Vec<&str> = all.iter().map(|r| r["label"].as_str().unwrap()).collect();
    assert_eq!(labels, ["5H", "Neon Daily", "other-weekly"]);
    assert_eq!(num(&all[1], "usedPct"), 75.0);
    assert_eq!(all[1]["models"], json!([]));
    assert_eq!(num(&all[2], "usedPct"), 100.0);
    assert_eq!(num(&all[2], "resetAt"), 1_893_456_000_000.0);
}

const QUOTA: &str = usage_antigravity::QUOTA_URL;

fn antigravity(creds: Option<Value>, replies: Value) -> World {
    world(usage_antigravity::PROVIDER_ID, creds, replies)
}

fn signed_in(expires_at: u64) -> Value {
    json!({ "access_token": "ag-access", "refresh_token": "ag-refresh", "expires_at": expires_at, "project_id": "proj-1" })
}

#[tokio::test]
async fn antigravity_posts_the_project_with_the_stored_token_and_reads_the_rows() {
    let world = antigravity(
        Some(signed_in(4_000_000_000_000)),
        json!([{ "url": QUOTA, "body": { "groups": [{ "buckets": [bucket("gemini-5h", "5h", 0.9, None)] }] } }]),
    );
    let snapshot = world.source.provider_snapshot(usage_antigravity::PROVIDER_ID, "default").await.unwrap().unwrap();
    assert_eq!(num(&snapshot["quotaWindows"][0], "usedPct"), 10.0);
    let (request, exchange) = only_request(&world);
    assert_eq!((request.method.as_str(), request.url.as_str()), ("POST", QUOTA));
    assert_eq!(request.body, br#"{"project":"proj-1"}"#);
    let header = |name: &str| request.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    assert_eq!((header("Authorization"), header("Content-Type")), (Some("Bearer ag-access"), Some("application/json")));
    assert!(header("User-Agent").is_some_and(|ua| !ua.is_empty()));
    assert_eq!((exchange.redirect, exchange.liveness.total_deadline()), (Redirect::Error, Some(Duration::from_secs(15))));
}

#[tokio::test]
async fn antigravity_exchanges_an_expiring_token_before_asking_for_the_quota_and_keeps_the_new_pair() {
    let token_url = "https://oauth2.googleapis.com/token";
    let world = antigravity(
        // Within five minutes of expiry (an expiry under 1e12 would read as seconds).
        Some(signed_in(2_000_000_060_000)),
        json!([
            { "url": token_url, "body": { "access_token": "ag-fresh", "expires_in": 3600 } },
            { "url": QUOTA, "body": { "groups": [] } }
        ]),
    );
    world.pace.now.store(2_000_000_000_000, Ordering::SeqCst);
    world.source.provider_snapshot(usage_antigravity::PROVIDER_ID, "default").await.unwrap();
    let seen = world.net.seen.lock().unwrap();
    assert_eq!(seen.iter().map(|r| r.url.as_str()).collect::<Vec<_>>(), [token_url, QUOTA], "the refresh comes first");
    assert!(seen[1].headers.iter().any(|(n, v)| n == "Authorization" && v == "Bearer ag-fresh"));
    drop(seen);
    let stored = mixdog_statefile::read_content(
        AccountStore::new(world.dir.path().to_path_buf(), io()).credential_file(usage_antigravity::PROVIDER_ID, "default").unwrap().path(),
    )
    .unwrap()
    .unwrap();
    let stored: Value = serde_json::from_slice(&stored).unwrap();
    assert_eq!((stored["access_token"].as_str(), stored["refresh_token"].as_str()), (Some("ag-fresh"), Some("ag-refresh")));
}

#[tokio::test]
async fn antigravity_failures_name_the_status_cut_the_detail_and_never_reflect_a_secret() {
    let refused = antigravity(
        Some(signed_in(4_000_000_000_000)),
        json!([{ "url": QUOTA, "status": 403, "body": "denied eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl" }]),
    );
    let error = refused.source.provider_snapshot(usage_antigravity::PROVIDER_ID, "default").await.unwrap_err();
    assert!(error.message.starts_with("[antigravity-oauth] retrieveUserQuotaSummary failed: 403 denied "), "{}", error.message);
    assert!(!error.message.contains("eyJhbGci"), "a token in the body is redacted: {}", error.message);

    let long = antigravity(Some(signed_in(4_000_000_000_000)), json!([{ "url": QUOTA, "status": 500, "body": "y".repeat(900) }]));
    let error = long.source.provider_snapshot(usage_antigravity::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.message, format!("[antigravity-oauth] retrieveUserQuotaSummary failed: 500 {}", "y".repeat(300)));

    let garbled = antigravity(Some(signed_in(4_000_000_000_000)), json!([{ "url": QUOTA, "body": "<html>" }]));
    assert!(garbled.source.provider_snapshot(usage_antigravity::PROVIDER_ID, "default").await.is_err());

    let signed_out = antigravity(None, json!([]));
    let error = signed_out.source.provider_snapshot(usage_antigravity::PROVIDER_ID, "default").await.unwrap_err();
    assert!(error.message.starts_with("[antigravity-oauth]") && error.status.is_none(), "{error:?}");
    assert_eq!(requests(&signed_out), 0);
}

// OpenCode Go

fn meters(five: Value, week: Value, month: Value) -> Value {
    json!({ "access": { "meters": { "fiveHour": five, "week": week, "month": month } } })
}

fn meter(limit: &str, used: &str, resets: Value) -> Value {
    json!({ "limitMicroCents": limit, "usedMicroCents": used, "resetsAt": resets })
}

#[test]
fn opencode_go_meters_are_micro_cents_turned_into_dollars_with_the_share_used() {
    let snapshot = usage_opencode_go::snapshot_from_status(&meters(
        meter("1200000000", "300000000", json!("2030-01-01T00:00:00Z")),
        meter("2400000000", "2500000000", Value::Null),
        meter("0", "0", Value::Null),
    ))
    .unwrap();
    assert_eq!((snapshot["provider"].as_str(), snapshot["source"].as_str()), (Some("opencode-go"), Some("opencode-go-console")));
    let windows = snapshot["quotaWindows"].as_array().unwrap();
    assert_eq!(windows.iter().map(|w| w["label"].as_str().unwrap()).collect::<Vec<_>>(), ["5H", "7D"], "a zero cap proves nothing and is not a window");
    let five = &windows[0];
    assert_eq!((num(five, "limitUsd"), num(five, "usedUsd"), num(five, "remainingUsd"), num(five, "usedPct")), (12.0, 3.0, 9.0, 25.0));
    assert_eq!(num(five, "resetAt"), 1_893_456_000_000.0);
    // Over the cap: nothing remains, and the share is not capped; a window that has not started has no reset.
    assert_eq!((num(&windows[1], "remainingUsd"), num(&windows[1], "usedPct")), (0.0, 104.17));
    assert!(windows[1].get("resetAt").is_none());
}

#[test]
fn opencode_go_reads_full_only_for_a_spend_that_reached_the_cap_and_never_for_unstated_data() {
    let windows = |five: Value| {
        usage_opencode_go::snapshot_from_status(&meters(five, Value::Null, meter("1200000000", "0", Value::Null))).unwrap()["quotaWindows"]
            .as_array()
            .unwrap()
            .clone()
    };
    // One micro-cent short of the cap rounds to 100.00 but is not exhausted; at the cap it is.
    assert_eq!(num(&windows(meter("1200000000", "1199999999", Value::Null))[0], "usedPct"), 99.99);
    assert_eq!(num(&windows(meter("1200000000", "1200000000", Value::Null))[0], "usedPct"), 100.0);
    // Absent, null or empty amounts are unstated, not zero: the meter is dropped and only the other remains.
    for unstated in [
        json!({ "limitMicroCents": "1200000000" }),
        json!({ "limitMicroCents": "1200000000", "usedMicroCents": null }),
        meter("1200000000", "", Value::Null),
        meter("", "5", Value::Null),
        meter("-1", "0", Value::Null),
    ] {
        let left = windows(unstated.clone());
        assert_eq!(left.iter().map(|w| w["label"].as_str().unwrap()).collect::<Vec<_>>(), ["M"], "{unstated}");
    }
}

#[test]
fn opencode_go_skips_a_meter_it_cannot_read_and_has_no_snapshot_without_any() {
    let one =
        usage_opencode_go::snapshot_from_status(&meters(Value::Null, meter("100000000", "50000000", Value::Null), json!({ "limitMicroCents": "x" }))).unwrap();
    assert_eq!(one["quotaWindows"].as_array().unwrap().len(), 1);
    assert_eq!(one["quotaWindows"][0]["label"], "7D");
    assert!(usage_opencode_go::snapshot_from_status(&json!({ "access": {} })).is_none());
    assert!(usage_opencode_go::snapshot_from_status(&json!({})).is_none());
    // Unreadable meters prove nothing: no snapshot. Meters the Console withdrew (absent, null, no cap) are a reading
    // of no limit: a snapshot without windows, which retires the earlier ones.
    assert!(usage_opencode_go::snapshot_from_status(&meters(json!(5), Value::Null, json!({}))).is_none());
    for none in
        [meters(Value::Null, Value::Null, Value::Null), meters(meter("0", "5", Value::Null), Value::Null, Value::Null), json!({ "access": { "meters": {} } })]
    {
        let snapshot = usage_opencode_go::snapshot_from_status(&none).unwrap_or_else(|| panic!("{none}"));
        assert_eq!(snapshot["quotaWindows"], json!([]), "{none}");
    }
}

const STATUS: &str = usage_opencode_go::STATUS_URL;

fn opencode_go(replies: Value) -> World {
    world(
        usage_opencode_go::PROVIDER_ID,
        Some(json!({ "access_token": "oc-access", "refresh_token": "oc-refresh", "org_id": "org-1", "account_id": "acc-1", "email": "me@example.com" })),
        replies,
    )
}

#[tokio::test]
async fn opencode_go_reads_the_status_for_the_organization_and_labels_the_account() {
    let world = opencode_go(json!([{ "url": STATUS, "body": meters(meter("1200000000", "300000000", Value::Null), Value::Null, Value::Null) }]));
    let snapshot = world.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap().unwrap();
    let (request, exchange) = only_request(&world);
    assert_eq!((request.method.as_str(), request.url.as_str()), ("GET", STATUS));
    let header = |name: &str| request.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    assert_eq!((header("Accept"), header("Authorization"), header("x-org-id")), (Some("application/json"), Some("Bearer oc-access"), Some("org-1")));
    assert!(header("User-Agent").is_some_and(|ua| ua.starts_with("Mozilla/5.0")), "the Console answers a browser's identity");
    assert_eq!((exchange.redirect, exchange.liveness.total_deadline()), (Redirect::Error, Some(Duration::from_millis(6_500))));
    assert_eq!(
        (snapshot["provider"].as_str(), snapshot["email"].as_str(), snapshot["accountId"].as_str()),
        (Some("opencode-go-oauth"), Some("me@example.com"), Some("acc-1"))
    );
    assert!(snapshot["model"].is_null());
}

#[tokio::test]
async fn opencode_go_failures_are_worded_by_status_and_by_missing_meters() {
    let down = opencode_go(json!([{ "url": STATUS, "status": 500, "body": "oops" }]));
    let error = down.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!((error.status, error.message.as_str()), (Some(500), "OpenCode Go usage fetch failed (500)"));

    let empty = opencode_go(json!([{ "url": STATUS, "body": { "access": {} } }]));
    let error = empty.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.message, "OpenCode Go subscription meters were not found");

    let unreachable = opencode_go(json!([{ "url": STATUS, "fail": true }]));
    assert_eq!(unreachable.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err().message, "fetch failed");

    let signed_out = world(usage_opencode_go::PROVIDER_ID, None, json!([]));
    let error = signed_out.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!((error.status, error.message.as_str()), (Some(401), "[opencode-go-oauth] credentials not found — open /providers in mixdog to sign in first"));
    assert_eq!(requests(&signed_out), 0);
}

const REFRESH: &str = "https://opencode.ai/console/auth/device/token";

fn urls(world: &World) -> Vec<String> {
    world.net.seen.lock().unwrap().iter().map(|r| r.url.clone()).collect()
}

fn bearer(request: &WireRequest) -> Option<&str> {
    request.headers.iter().find(|(n, _)| n == "Authorization").map(|(_, v)| v.as_str())
}

fn one_meter() -> Value {
    meters(meter("1200000000", "300000000", Value::Null), Value::Null, Value::Null)
}

#[tokio::test]
async fn a_rejected_opencode_go_token_is_refreshed_once_and_the_read_is_retried_with_the_new_token() {
    let world = opencode_go(json!([
        { "url": STATUS, "status": 401, "body": "" },
        { "url": REFRESH, "body": { "access_token": "oc-new", "refresh_token": "oc-refresh-2", "expires_in": 3600 } },
        { "url": STATUS, "body": one_meter() }
    ]));
    let snapshot = world.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap().unwrap();
    assert_eq!(num(&snapshot["quotaWindows"][0], "usedPct"), 25.0);
    assert_eq!(urls(&world), [STATUS, REFRESH, STATUS]);
    let seen = world.net.seen.lock().unwrap();
    assert_eq!((bearer(&seen[0]), bearer(&seen[2])), (Some("Bearer oc-access"), Some("Bearer oc-new")));
    let grant: Value = serde_json::from_slice(&seen[1].body).unwrap();
    assert_eq!((grant["grant_type"].as_str(), grant["refresh_token"].as_str()), (Some("refresh_token"), Some("oc-refresh")));
}

/// The scripted network, with a hook run when the first request for `url` arrives.
struct Hooked {
    net: Arc<Net>,
    url: &'static str,
    hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[async_trait]
impl HttpSend for Hooked {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        if request.url == self.url
            && let Some(hook) = self.hook.lock().unwrap().take()
        {
            hook();
        }
        self.net.send(request, exchange).await
    }
}

/// The status read goes out on one sign-in and is refused; another pair of the same account was stored meanwhile. The
/// refusal is of the pair that read was sent on: the pair stored since is used as it is and its refresh token is not
/// spent, whether both tokens changed or the same bearer came back under another refresh token.
#[tokio::test]
async fn a_rejected_opencode_go_read_does_not_refresh_a_sign_in_stored_since_it_was_sent() {
    for (access, refresh) in [("oc-second", "oc-refresh-2"), ("oc-access", "oc-refresh-2")] {
        a_sign_in_stored_since_the_read_is_not_refreshed(access, refresh).await;
    }
}

async fn a_sign_in_stored_since_the_read_is_not_refreshed(access: &str, refresh: &str) {
    let dir = tempfile::tempdir().unwrap();
    let store = AccountStore::new(dir.path().to_path_buf(), io());
    let file = store.credential_file(usage_opencode_go::PROVIDER_ID, "default").unwrap();
    let sign_in = |access: &str, refresh: &str| json!({ "access_token": access, "refresh_token": refresh, "org_id": "org-1", "account_id": "acc-1", "email": "me@example.com" });
    file.save(&sign_in("oc-access", "oc-refresh")).await.unwrap();
    let net = Net::from(&json!([
        { "url": STATUS, "status": 401, "body": "" },
        { "url": REFRESH, "body": { "access_token": "oc-new", "refresh_token": "oc-refresh-3", "expires_in": 3600 } },
        { "url": STATUS, "body": one_meter() }
    ]));
    let (path, other) = (file.path().to_owned(), sign_in(access, refresh).to_string().into_bytes());
    let stored_meanwhile = move || {
        on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &other, &mixdog_statefile::Opts::default())).unwrap();
    };
    let http = Arc::new(Hooked { net: net.clone(), url: STATUS, hook: Mutex::new(Some(Box::new(stored_meanwhile))) });
    let pace = Arc::new(FakePace::default());
    pace.now.store(1_000_000, Ordering::SeqCst);
    let source = ProviderUsageSource::with_pace(store, http, pace).with_jitter(Arc::new(|| 0.5));

    let snapshot = source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap().unwrap();
    assert_eq!(num(&snapshot["quotaWindows"][0], "usedPct"), 25.0);
    let seen = net.seen.lock().unwrap();
    let urls: Vec<&str> = seen.iter().map(|request| request.url.as_str()).collect();
    assert_eq!(urls, [STATUS, STATUS], "the sign-in stored since ({access}, {refresh}) was refreshed for the old read's refusal");
    assert_eq!((bearer(&seen[0]), bearer(&seen[1])), (Some("Bearer oc-access"), Some(format!("Bearer {access}").as_str())));
    drop(seen);
    let stored: Value = serde_json::from_slice(&std::fs::read(file.path()).unwrap()).unwrap();
    assert_eq!(stored["refresh_token"], refresh);
}

#[tokio::test]
async fn opencode_go_asks_the_sign_in_again_when_the_refresh_is_rejected_and_does_not_loop() {
    let rejected = opencode_go(json!([{ "url": STATUS, "status": 401, "body": "" }, { "url": REFRESH, "status": 401, "body": "" }]));
    let error = rejected.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert_eq!(error.message, "[opencode-go-oauth] invalid_grant: OpenCode sign-in expired (refresh rejected) — open /providers in mixdog to sign in again");
    assert_eq!(urls(&rejected), [STATUS, REFRESH]);

    let again = opencode_go(json!([
        { "url": STATUS, "status": 401, "body": "" },
        { "url": REFRESH, "body": { "access_token": "oc-new", "refresh_token": "oc-refresh-2" } },
        { "url": STATUS, "status": 401, "body": "" }
    ]));
    let error = again.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert_eq!(error.message, "[opencode-go-oauth] invalid_grant: OpenCode sign-in expired (console 401) — open /providers in mixdog to sign in again");
    assert_eq!(urls(&again), [STATUS, REFRESH, STATUS], "one refresh, one retry, then the error");

    let busy = opencode_go(json!([{ "url": STATUS, "status": 401, "body": "" }, { "url": REFRESH, "status": 503, "body": "busy" }]));
    let error = busy.source.provider_snapshot(usage_opencode_go::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!((error.status, error.message.as_str()), (Some(503), "[opencode-go-oauth] token refresh 503: busy"));
    assert_eq!(urls(&busy).len(), 2);
}

// Muse Code

fn subs_payload() -> Value {
    json!({
        "api_key": "inference-key", "user_id": "u1", "user_email": " A@B.com ", "is_subs_active": true, "subs_tier_name": "Pro",
        "subs_usage": {
            "window": { "used_percent": 40, "window_duration_mins": 300, "resets_at": 1_900_000_000 },
            "weekly": { "used_percent": 95.5, "window_duration_mins": 10_080, "resets_at": "2030-01-01T00:00:00Z" }
        }
    })
}

#[test]
fn muse_code_windows_name_their_span_from_the_minutes_and_carry_the_tier() {
    let windows = usage_muse_code::quota_windows_from_subs_usage(subs_payload().get("subs_usage"), Some("Pro"));
    assert_eq!(windows.len(), 2);
    let rolling = &windows[0];
    assert_eq!(
        (rolling["id"].as_str(), rolling["label"].as_str(), rolling["longLabel"].as_str(), rolling["status"].as_str(), rolling["tier"].as_str()),
        (Some("300m"), Some("5H"), Some("5 Hours"), Some("ok"), Some("Pro"))
    );
    assert_eq!((num(rolling, "usedPct"), num(rolling, "durationMs"), num(rolling, "resetAt")), (40.0, 18_000_000.0, 1_900_000_000_000.0));
    let weekly = &windows[1];
    assert_eq!((weekly["id"].as_str(), weekly["label"].as_str(), weekly["status"].as_str()), (Some("1w"), Some("7D"), Some("warning")));
    assert_eq!((num(weekly, "durationMs"), num(weekly, "resetAt")), (604_800_000.0, 1_893_456_000_000.0), "a text reset is a date, a number is seconds");

    let named = |minutes: Value| {
        let usage = json!({ "window": { "used_percent": 1, "window_duration_mins": minutes } });
        let w = usage_muse_code::quota_windows_from_subs_usage(Some(&usage), None);
        (w[0]["id"].as_str().unwrap().to_owned(), w[0]["label"].as_str().unwrap().to_owned(), w[0]["longLabel"].as_str().unwrap().to_owned())
    };
    assert_eq!(named(json!(90)), ("90m".into(), "90M".into(), "90 Minutes".into()));
    assert_eq!(named(json!(60)), ("60m".into(), "1H".into(), "1 Hour".into()));
    assert_eq!(named(json!(1)), ("1m".into(), "1M".into(), "1 Minute".into()));
    assert_eq!(named(Value::Null), ("rolling".into(), "W".into(), "Rolling Window".into()));
    let usage = json!({ "window": { "used_percent": 150, "window_duration_mins": 60 } });
    let over = usage_muse_code::quota_windows_from_subs_usage(Some(&usage), None);
    assert_eq!((num(&over[0], "usedPct"), over[0]["status"].as_str()), (100.0, Some("exhausted")), "the share is capped at 100");
}

#[test]
fn a_muse_code_key_answer_with_wrongly_typed_fields_is_rejected_not_stringified() {
    assert!(usage_muse_code::payload_is_valid(&subs_payload()));
    assert!(usage_muse_code::payload_is_valid(&json!({})));
    for bad in [
        json!([]),
        json!({ "api_key": 5 }),
        json!({ "is_subs_active": "yes" }),
        json!({ "action_url": 5 }),
        json!({ "subs_usage": "x" }),
        json!({ "subs_usage": { "window": { "used_percent": "40" } } }),
        json!({ "subs_usage": { "weekly": { "window_duration_mins": null } } }),
        json!({ "subs_usage": { "window": { "resets_at": true } } }),
    ] {
        assert!(!usage_muse_code::payload_is_valid(&bad), "{bad}");
    }
    assert!(usage_muse_code::payload_is_valid(&json!({ "action_url": null, "subs_tier_id": null, "subs_usage": null })));
}

#[test]
fn the_muse_code_snapshot_never_carries_the_inference_key_and_prefers_the_answers_identity() {
    let snapshot = usage_muse_code::snapshot(&subs_payload(), "stored@x.com", "stored-acct", 42).unwrap();
    assert_eq!(
        (snapshot["email"].as_str(), snapshot["accountId"].as_str(), snapshot["tier"].as_str(), num(&snapshot, "fetchedAt")),
        (Some("a@b.com"), Some("u1"), Some("Pro"), 42.0)
    );
    assert!(snapshot["raw"].get("api_key").is_none());
    let keys: Vec<&str> = snapshot["rawKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    assert!(!keys.contains(&"api_key") && keys.windows(2).all(|w| w[0] <= w[1]), "{keys:?}");
    // The stored identity fills what the answer leaves out.
    let bare = json!({ "subs_usage": { "weekly": { "used_percent": 1 } } });
    let snapshot = usage_muse_code::snapshot(&bare, "stored@x.com", "stored-acct", 42).unwrap();
    assert_eq!((snapshot["email"].as_str(), snapshot["accountId"].as_str()), (Some("stored@x.com"), Some("stored-acct")));
    assert!(usage_muse_code::snapshot(&json!({ "subs_usage": {} }), "", "", 1).is_none(), "no window, no snapshot");
}

fn muse(replies: Value) -> World {
    world(
        usage_muse_code::PROVIDER_ID,
        Some(json!({ "accessToken": "meta-token", "apiKey": "inference-key", "accountId": "acct", "email": "me@x.com" })),
        replies,
    )
}

const KEY: &str = usage_muse_code::KEY_URL;

#[tokio::test]
async fn muse_code_posts_to_the_key_endpoint_with_the_account_token_never_the_inference_key() {
    let world = muse(json!([{ "url": KEY, "body": subs_payload() }]));
    let snapshot = world.source.provider_snapshot(usage_muse_code::PROVIDER_ID, "default").await.unwrap().unwrap();
    let (request, exchange) = only_request(&world);
    assert_eq!((request.method.as_str(), request.url.as_str(), request.body.as_slice()), ("POST", KEY, b"{}".as_slice()));
    let header = |name: &str| request.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    assert_eq!(
        (header("Authorization"), header("x-api-version"), header("Accept"), header("Content-Type")),
        (Some("Bearer meta-token"), Some("1.0.0"), Some("application/json"), Some("application/json"))
    );
    assert!(request.headers.iter().all(|(_, v)| !v.contains("inference-key")));
    assert_eq!((exchange.redirect, exchange.liveness.total_deadline()), (Redirect::Error, Some(Duration::from_secs(20))));
    assert_eq!((num(&snapshot, "fetchedAt"), snapshot["quotaWindows"].as_array().unwrap().len()), (1_000_000.0, 2));
}

#[tokio::test]
async fn a_failed_muse_code_read_pauses_the_next_ones_for_five_minutes_and_keeps_the_last_good_reading() {
    let world = muse(json!([{ "url": KEY, "body": subs_payload() }, { "url": KEY, "status": 500, "body": "" }, { "url": KEY, "body": subs_payload() }]));
    let read = || world.source.provider_snapshot(usage_muse_code::PROVIDER_ID, "default");
    let good = read().await.unwrap().unwrap();
    // The server fails: the last good reading stands in, and the cooldown starts.
    world.pace.now.store(1_000_000 + 10_000, Ordering::SeqCst);
    assert_eq!(read().await.unwrap(), Some(good.clone()));
    assert_eq!(requests(&world), 2);
    world.pace.now.store(1_000_000 + 10_000 + 299_000, Ordering::SeqCst);
    assert_eq!(read().await.unwrap(), Some(good), "inside the cooldown: answered from memory");
    assert_eq!(requests(&world), 2, "no request while cooling down");
    world.pace.now.store(1_000_000 + 10_000 + 300_000, Ordering::SeqCst);
    assert!(read().await.unwrap().is_some());
    assert_eq!(requests(&world), 3, "after the cooldown it asks again");
}

#[tokio::test]
async fn a_rejected_muse_code_session_is_an_error_that_is_not_retried_during_the_cooldown() {
    let world = muse(json!([{ "url": KEY, "body": subs_payload() }, { "url": KEY, "status": 401, "body": "" }]));
    let read = || world.source.provider_snapshot(usage_muse_code::PROVIDER_ID, "default");
    read().await.unwrap();
    world.pace.now.fetch_add(1, Ordering::SeqCst);
    let error = read().await.unwrap_err();
    assert_eq!(
        (error.status, error.message.as_str()),
        (Some(401), "[muse-code-oauth] account session rejected (401) — open /providers in mixdog to sign in again")
    );
    let again = read().await.unwrap_err();
    assert_eq!((again.status, again.message), (error.status, error.message), "the same error, with no new request, during the cooldown");
    assert_eq!(requests(&world), 2);
}

#[tokio::test]
async fn an_inactive_muse_code_subscription_and_a_signed_out_account_are_reauth_errors() {
    let mut inactive = subs_payload();
    inactive["is_subs_active"] = false.into();
    let world = muse(json!([{ "url": KEY, "body": inactive }]));
    let error = world.source.provider_snapshot(usage_muse_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(
        (error.status, error.message.as_str()),
        (Some(403), "[muse-code-oauth] Muse Code subscription is inactive — open /providers in mixdog to sign in again")
    );

    let signed_out = world_without_muse_creds();
    let error = signed_out.source.provider_snapshot(usage_muse_code::PROVIDER_ID, "default").await.unwrap_err();
    assert_eq!(error.message, "[muse-code-oauth] credentials not found — open /providers in mixdog to sign in first");
    assert_eq!(requests(&signed_out), 0);
}

fn world_without_muse_creds() -> World {
    world(usage_muse_code::PROVIDER_ID, Some(json!({ "accessToken": "  ", "apiKey": "k" })), json!([]))
}

#[tokio::test]
async fn a_muse_code_answer_that_is_not_a_valid_payload_reads_as_the_last_good_one_or_nothing() {
    let world = muse(json!([{ "url": KEY, "body": { "is_subs_active": "yes" } }]));
    assert_eq!(world.source.provider_snapshot(usage_muse_code::PROVIDER_ID, "default").await.unwrap(), None);
}

// Cursor

fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

fn int_field(no: u64, value: u64) -> Vec<u8> {
    [varint(no << 3), varint(value)].concat()
}

fn double_field(no: u64, value: f64) -> Vec<u8> {
    [varint(no << 3 | 1), value.to_le_bytes().to_vec()].concat()
}

fn bytes_field(no: u64, bytes: &[u8]) -> Vec<u8> {
    [varint(no << 3 | 2), varint(bytes.len() as u64), bytes.to_vec()].concat()
}

struct Dashboard {
    usage: (u16, Vec<u8>),
    plan: (u16, Vec<u8>),
    seen: Mutex<Vec<(WireRequest, Exchange)>>,
}

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[async_trait]
impl HttpSend for Dashboard {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let (status, body) = if request.url.ends_with(usage_cursor::USAGE_PATH) { self.usage.clone() } else { self.plan.clone() };
        self.seen.lock().unwrap().push((request, exchange));
        Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from(body)))) })
    }
}

struct Token;

#[async_trait]
impl crate::providers::cursor::AccessToken for Token {
    async fn access_token(&self) -> Result<crate::providers::cursor::Access, ProviderError> {
        Ok(crate::providers::cursor::Access::plain("cursor-token".to_owned()))
    }
    async fn after_rejection(&self, _rejected: &crate::providers::cursor::Access) -> Result<crate::providers::cursor::Access, ProviderError> {
        self.access_token().await
    }
    async fn renewed(&self) -> Result<crate::providers::cursor::Access, ProviderError> {
        self.access_token().await
    }
}

fn dashboard(usage: (u16, Vec<u8>), plan: (u16, Vec<u8>)) -> (usage_cursor::CursorUsage, Arc<Dashboard>) {
    let net = Arc::new(Dashboard { usage, plan, seen: Mutex::default() });
    (usage_cursor::CursorUsage::new(usage_cursor::PROVIDER_ID, net.clone(), None, "9.9.9".into(), Arc::new(Token)), net)
}

fn period() -> Vec<u8> {
    let plan_usage = [int_field(1, 500), int_field(4, 1500), int_field(5, 2000), double_field(12, 12.5), double_field(13, 40.0)].concat();
    [int_field(2, 1_900_000_000_000), bytes_field(3, &plan_usage), int_field(6, 1), bytes_field(7, b"")].concat()
}

fn plan_info() -> Vec<u8> {
    bytes_field(1, &[bytes_field(1, b"Pro"), bytes_field(3, b"$20/mo")].concat())
}

#[tokio::test]
async fn cursor_reads_the_usage_and_plan_calls_and_reports_a_window_per_lane() {
    let (reading, net) = dashboard((200, period()), (200, plan_info()));
    let snapshot = reading.read().await.unwrap();
    {
        let seen = net.seen.lock().unwrap();
        let mut urls: Vec<&str> = seen.iter().map(|(r, _)| r.url.as_str()).collect();
        urls.sort_unstable();
        assert_eq!(
            urls,
            [
                format!("{}{}", crate::providers::cursor::API_URL, usage_cursor::USAGE_PATH),
                format!("{}{}", crate::providers::cursor::API_URL, usage_cursor::PLAN_PATH)
            ]
        );
        for (request, exchange) in seen.iter() {
            assert_eq!(request.method, "POST");
            let header = |name: &str| request.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
            assert_eq!(
                (header("content-type"), header("authorization"), header("x-cursor-client-version")),
                (Some("application/proto"), Some("Bearer cursor-token"), Some("9.9.9"))
            );
            assert_eq!((exchange.redirect, exchange.liveness.total_deadline()), (Redirect::Manual, Some(Duration::from_secs(5))));
        }
    }
    assert_eq!(
        (snapshot["provider"].as_str(), snapshot["enabled"].as_bool(), snapshot["plan"]["name"].as_str(), snapshot["plan"]["price"].as_str()),
        (Some("cursor-oauth"), Some(true), Some("Pro"), Some("$20/mo"))
    );
    let windows = snapshot["quotaWindows"].as_array().unwrap();
    assert_eq!(windows.iter().map(|w| w["label"].as_str().unwrap()).collect::<Vec<_>>(), ["Basic", "API"]);
    assert_eq!((num(&windows[0], "usedPct"), num(&windows[1], "usedPct")), (12.5, 40.0));
    // Basic meters Auto and Composer; API meters every other model.
    assert_eq!(windows[0]["models"], json!(["auto", "default", "composer"]));
    assert_eq!(windows[1]["except"], json!(["auto", "default", "composer"]));
    assert_eq!(num(&windows[0], "resetAt"), 1_900_000_000_000.0);
    assert_eq!((num(&snapshot["balance"], "limitUsd"), num(&snapshot["balance"], "usedUsd"), num(&snapshot["balance"], "remainingUsd")), (20.0, 5.0, 15.0));
}

#[tokio::test]
async fn a_cursor_plan_call_that_fails_costs_only_the_plan_block_but_a_failed_usage_call_fails_the_read() {
    let (reading, _) = dashboard((200, period()), (500, Vec::new()));
    let snapshot = reading.read().await.unwrap();
    assert_eq!(snapshot["plan"]["name"], "");
    assert_eq!(snapshot["quotaWindows"].as_array().unwrap().len(), 2);

    let (reading, _) = dashboard((503, Vec::new()), (200, plan_info()));
    let error = reading.read().await.unwrap_err();
    assert_eq!(error.status, Some(503));
}

#[tokio::test]
async fn a_malformed_cursor_answer_fails_with_the_decoders_own_text() {
    // A length that runs past the end of the answer, and a varint that never ends.
    for (body, text) in [(vec![0x1a, 0x05, 0x08], "Truncated Cursor protobuf field"), (vec![0x10, 0x80, 0x80], "Truncated Cursor protobuf varint")] {
        let (reading, _) = dashboard((200, body), (200, plan_info()));
        assert_eq!(reading.read().await.unwrap_err().message, text);
    }
    let (reading, _) = dashboard((200, period()), (200, vec![0x0a, 0x09, 0x08]));
    assert_eq!(reading.read().await.unwrap_err().message, "Truncated Cursor protobuf field", "a plan answer, once received, must decode");
}

fn normalized(usage: Value, plan: Value) -> Value {
    usage_cursor::normalize_cursor_usage(usage.as_object().unwrap(), plan.as_object().unwrap())
}

#[test]
fn without_lane_percentages_cursor_shows_one_included_dollar_window_named_for_the_plan() {
    let usage = json!({ "planUsage": { "limit": 2000, "totalSpend": 500 }, "billingCycleEnd": 1_900_000_000_000_u64 });
    let named = normalized(usage.clone(), json!({ "planInfo": { "planName": "Pro" } }));
    let window = &named["quotaWindows"][0];
    assert_eq!(window["label"], "Pro included");
    assert_eq!((num(window, "limitUsd"), num(window, "usedUsd"), num(window, "remainingUsd"), num(window, "resetAt")), (20.0, 5.0, 15.0, 1_900_000_000_000.0));
    assert_eq!(normalized(usage, json!({}))["quotaWindows"][0]["label"], "Included usage");
    // With nothing reported there is no window and no balance.
    let nothing = normalized(json!({}), json!({}));
    assert!(nothing["quotaWindows"].as_array().unwrap().is_empty() && nothing.get("balance").is_none());
    assert_eq!((nothing["enabled"].as_bool(), nothing["detail"].as_str()), (Some(false), Some("")));
}

#[test]
fn cursor_usage_based_spend_prefers_the_overall_figures_and_rounds_cents_to_the_nearest_cent() {
    let snapshot =
        normalized(json!({ "spendLimitUsage": { "overallLimit": 5000, "individualLimit": 100, "overallUsed": 1234, "overallRemaining": 3766 } }), json!({}));
    let spend = &snapshot["quotaWindows"][0];
    assert_eq!(spend["label"], "Usage-based spend");
    assert_eq!((num(spend, "limitUsd"), num(spend, "usedUsd"), num(spend, "remainingUsd")), (50.0, 12.34, 37.66));
    // Without an overall figure the individual then the pooled one stands in.
    let pooled = normalized(json!({ "spendLimitUsage": { "pooledLimit": 700, "pooledUsed": 100, "pooledRemaining": 600 } }), json!({}));
    assert_eq!(num(&pooled["quotaWindows"][0], "limitUsd"), 7.0);
    // The share of a lane is clamped to 0..=100 and rounded to four places; a non-number lane is no lane.
    let lanes = normalized(json!({ "planUsage": { "autoPercentUsed": 123.0, "apiPercentUsed": "n/a" } }), json!({}));
    let windows = lanes["quotaWindows"].as_array().unwrap();
    assert_eq!((windows.len(), num(&windows[0], "usedPct")), (1, 100.0));
}
