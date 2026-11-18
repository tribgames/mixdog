use std::collections::BTreeMap;

use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::quota::QuotaReading;
use mixdog_ledger::quota::QuotaSample;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::writer::UsageWriter;
use serde_json::Value;
use serde_json::json;

type ExpectedModel = (&'static str, u64, u64, f64);

fn assert_models(rows: &Value, expected: &[ExpectedModel]) {
    let rows = rows.as_array().unwrap();
    let actual: Vec<_> = rows
        .iter()
        .map(|row| {
            (
                row["speedTier"].as_str().unwrap(),
                row["turns"].as_u64().unwrap(),
                row["tokens"].as_u64().unwrap(),
                row["costUsd"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(actual, expected);
    for row in rows {
        if row["speedTier"] == "standard" {
            assert!(row.get("fast").is_none());
        } else {
            assert_eq!(row["fast"], true);
        }
    }
}

/// The tier a live call dispatched is stored beside its prices as `sentSpeedTier`, which groups the call without being a
/// pricing tier; the API's reported `default` still downgrades it, and a row with neither key stays Standard.
#[tokio::test]
async fn the_dispatched_tier_groups_calls_and_a_reported_default_still_downgrades_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let tokens = mixdog_rt::testing::tokens();
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let ts = mixdog_js::time::local_to_utc_ms(2026, 11, 4, 12, 0, 0, 0) as i64;
    let calls = [
        (None, 10),
        (Some(json!({"sentSpeedTier": "priority"})), 20),
        (Some(json!({"sentSpeedTier": "ultrafast"})), 30),
        (Some(json!({"sentSpeedTier": "priority", "serviceTier": "default"})), 40),
    ];
    for (i, (rates, output)) in calls.into_iter().enumerate() {
        let record: UsageRecord = serde_json::from_value(json!({
            "id": format!("sent-{i}"), "sessionId": "s", "ts": ts, "day": "2026-11-04", "provider": "openai",
            "kind": "api", "model": "m", "sourceType": "user", "origin": "live",
            "rates": rates.map(|r| r.to_string()), "input": 1, "output": output, "cacheRead": 0, "cacheWrite": 0,
            "durationMs": 1000, "costUsd": 1.0, "costSource": "catalog",
        }))
        .unwrap();
        writer.record_queued(record).await.unwrap();
    }
    let stats = reader
        .usage_stats(serde_json::from_value(json!({"days": 7})).unwrap(), ts + 60_000)
        .await
        .unwrap();
    let rows: Vec<(&str, u64, u64)> = stats["providers"][0]["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| (row["speedTier"].as_str().unwrap(), row["turns"].as_u64().unwrap(), row["tokens"].as_u64().unwrap()))
        .collect();
    assert_eq!(rows, [("standard", 2, 52), ("fast", 1, 21), ("ultrafast", 1, 31)]);
    assert_eq!(stats["providers"][0]["costUsd"], 4.0);
}

#[tokio::test]
async fn model_speed_tiers_reconcile_to_stats_and_subscription_totals() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let tokens = mixdog_rt::testing::tokens();
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);

    // Keep all calls at the same time so quota must split even a single time/model group.
    let ts = mixdog_js::time::local_to_utc_ms(2026, 11, 4, 12, 0, 0, 0) as i64;
    let now = ts + 30 * 60_000;
    let calls = [
        ("openai", "api", None, None, 10, 0.125),
        ("openai", "api", None, Some("ultrafast"), 20, 0.125),
        ("openai", "api", Some("priority"), Some("default"), 30, 0.25),
        ("openai", "api", Some("ultrafast"), Some("default"), 40, 0.25),
        ("openai", "api", Some("priority"), None, 50, 0.5),
        ("openai", "api", Some("fast"), None, 60, 0.5),
        ("openai", "api", Some("ultrafast"), Some("priority"), 70, 2.0),
        ("openai-oauth", "oauth", None, None, 10, 0.125),
        ("openai-oauth", "oauth", Some("priority"), Some("default"), 20, 0.25),
        ("openai-oauth", "oauth", Some("ultrafast"), Some("default"), 30, 0.5),
    ];
    for (i, (provider, kind, request, reported, output, cost)) in calls.into_iter().enumerate() {
        let rates = match (request, reported) {
            (None, None) => None,
            _ => Some(json!({"requestServiceTier": request, "serviceTier": reported}).to_string()),
        };
        let record: UsageRecord = serde_json::from_value(json!({
            "id": format!("call-{i}"), "sessionId": format!("session-{i}"),
            "ts": ts, "day": "2026-11-04", "provider": provider, "kind": kind, "account": "acct",
            "model": "gpt-6-sol", "sourceType": "user", "origin": "live", "rates": rates,
            "input": 9, "output": output, "cacheRead": 2, "cacheWrite": 1, "durationMs": 1000,
            "costUsd": cost, "costSource": "catalog",
        }))
        .unwrap();
        writer.record_queued(record).await.unwrap();
    }

    let api_models = [("standard", 4, 148, 0.75), ("fast", 2, 134, 1.0), ("ultrafast", 1, 82, 2.0)];
    let oauth_models = [("standard", 1, 22, 0.125), ("fast", 1, 32, 0.25), ("ultrafast", 1, 42, 0.5)];
    let stats = reader
        .usage_stats(serde_json::from_value(json!({"days": 7})).unwrap(), now)
        .await
        .unwrap();
    let providers = stats["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 2);
    let (api, oauth) = (&providers[0], &providers[1]);
    assert_eq!(api["provider"], "openai");
    assert_eq!(oauth["provider"], "openai-oauth");
    assert_models(&api["models"], &api_models);
    assert_models(&oauth["models"], &oauth_models);
    assert_eq!((&api["turns"], &api["tokens"], &api["costUsd"]), (&json!(7), &json!(364), &json!(3.75)));
    assert_eq!((&oauth["turns"], &oauth["tokens"], &oauth["costUsd"]), (&json!(3), &json!(96), &json!(0.875)));
    assert_eq!(api["sessions"], 7);
    for (row, (sessions, speed)) in api["models"].as_array().unwrap().iter().zip([(4, 25), (2, 55), (1, 70)]) {
        assert_eq!(row["sessions"], sessions);
        assert_eq!(row["outputTokensPerSecond"], speed);
    }

    writer
        .record_quota_queued(vec![QuotaReading {
            provider: "openai-oauth".into(),
            account: "acct".into(),
            label: "5H".into(),
            sample: QuotaSample {
                ts: now,
                used_pct: 70.0,
                reset_at: Some(ts + 4 * 3_600_000),
            },
        }])
        .await
        .unwrap();
    let quota = reader
        .quota_history(
            serde_json::from_value(json!({"provider": "openai-oauth", "account": "acct", "window": "5H"})).unwrap(),
            BTreeMap::new(),
            now,
        )
        .await
        .unwrap();
    assert_models(&quota["models"], &oauth_models);
    let totals = &quota["totals"];
    assert_eq!((&totals["turns"], &totals["tokens"], &totals["costUsd"], &totals["consumed"]), (&json!(3), &json!(96), &json!(0.875), &json!(70)));
    let series = quota["modelSeries"].as_array().unwrap();
    assert_eq!(series.len(), 3);
    for ((model, series), consumed) in quota["models"].as_array().unwrap().iter().zip(series).zip([10, 20, 40]) {
        assert_eq!(model["consumed"], consumed);
        assert_eq!(model["model"], series["key"]);
        assert_eq!(model["speedTier"], series["speedTier"]);
    }
    assert_ne!(quota["models"][1]["model"], quota["models"][2]["model"]);
    assert_eq!(quota["models"][1]["modelId"], "gpt-6-sol");
    assert_eq!(quota["models"][2]["modelId"], "gpt-6-sol");
}
