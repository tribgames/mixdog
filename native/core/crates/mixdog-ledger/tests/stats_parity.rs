//! Parity gate for the service-level queries: the statistics period, `getUsageStats`,
//! `getUsageRequests` and `getQuotaHistory` equal the golden twin of today's Node service
//! (`fixtures/ledger-queries/stats-*.json`, recorded by `benchmarks/rust-core/recorders/
//! record-ledger-stats.mjs`) over the same ledger file: byte for byte, key order included.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_ledger::LedgerError;
use mixdog_ledger::db::Connection;
use mixdog_ledger::period::PeriodRequest;
use mixdog_ledger::period::resolve_usage_stats_period;
use mixdog_ledger::quota::QuotaHistoryOptions;
use mixdog_ledger::quota::QuotaReading;
use mixdog_ledger::quota::QuotaSample;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::stats::UsageRequestsOptions;
use mixdog_ledger::stats::UsageStatsOptions;
use mixdog_ledger::stats::session_usage_snapshot;
use mixdog_ledger::writer::UsageWriter;
use serde_json::Value;

fn manifest(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// The bytes `JSON.stringify` writes for `value`.
fn bytes(value: &Value) -> String {
    mixdog_js::json_stringify(value)
}

/// Path of the first difference, so a failure names a field instead of dumping megabytes.
fn first_diff(path: &str, got: &Value, want: &Value) -> Option<String> {
    match (got, want) {
        (Value::Object(a), Value::Object(b)) => {
            if a.keys().ne(b.keys()) {
                let (x, y): (Vec<_>, Vec<_>) = (a.keys().collect(), b.keys().collect());
                if a.len() != b.len() || x.iter().all(|k| b.contains_key(*k)) {
                    return Some(format!("{path}: key order {x:?} vs {y:?}"));
                }
            }
            for key in a.keys().chain(b.keys()) {
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => {
                        if let Some(found) = first_diff(&format!("{path}.{key}"), x, y) {
                            return Some(found);
                        }
                    }
                    (x, y) => return Some(format!("{path}.{key}: got {x:?} want {y:?}")),
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => a
            .iter()
            .zip(b)
            .enumerate()
            .find_map(|(i, (x, y))| first_diff(&format!("{path}[{i}]"), x, y)),
        (Value::Array(a), Value::Array(b)) => {
            Some(format!("{path}: length {} vs {}", a.len(), b.len()))
        }
        _ if bytes(got) == bytes(want) => None,
        _ => Some(format!("{path}: got {} want {}", bytes(got), bytes(want))),
    }
}

fn same(label: &str, got: &Value, want: &Value) {
    if let Some(diff) = first_diff(label, got, want) {
        panic!("{}", diff.chars().take(700).collect::<String>());
    }
    assert_eq!(bytes(got), bytes(want), "{label}: bytes");
}

/// An outcome as the recorder wrote it: `{result}` or `{error:{name,message}}`.
fn outcome(case: &Value, got: Result<Value, LedgerError>) -> (Value, Value) {
    match (got, case.get("error")) {
        (Ok(value), None) => (value, case["result"].clone()),
        (Err(LedgerError::Period { range, message }), Some(error)) => {
            let name = if range { "RangeError" } else { "TypeError" };
            let mut got = serde_json::Map::new();
            got.insert("name".into(), name.into());
            got.insert("message".into(), message.into());
            (Value::Object(got), error.clone())
        }
        (Ok(value), Some(error)) => panic!("expected error {error}, got {}", bytes(&value)),
        (Err(error), _) => panic!("unexpected error {error}"),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn period_request(case: &Value) -> PeriodRequest {
    PeriodRequest {
        view: text(case, "view"),
        anchor: text(case, "anchor"),
        start_day: text(case, "startDay"),
        end_day: text(case, "endDay"),
        start_time: text(case, "startTime"),
        end_time: text(case, "endTime"),
    }
}

async fn check(name: &str, source: &Path) {
    let golden: Value = serde_json::from_slice(
        &std::fs::read(manifest(&format!(
            "../../fixtures/ledger-queries/stats-{name}.json"
        )))
        .unwrap(),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    std::fs::copy(source, &path).unwrap();
    {
        let raw = Connection::open(&path).unwrap();
        for sql in golden["prepareSql"].as_array().unwrap() {
            raw.execute_batch(sql.as_str().unwrap()).unwrap();
        }
    }
    let tokens = mixdog_rt::testing::tokens();
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();
    let seeds: Vec<QuotaReading> = golden["quotaSeeds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| QuotaReading {
            provider: text(s, "provider").unwrap(),
            account: text(s, "account").unwrap(),
            label: text(s, "label").unwrap(),
            sample: QuotaSample {
                ts: s["ts"].as_i64().unwrap(),
                used_pct: s["usedPct"].as_f64().unwrap(),
                reset_at: s["resetAt"].as_i64(),
            },
        })
        .collect();
    if !seeds.is_empty() {
        writer.record_quota_queued(seeds).await.unwrap();
    }
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let now = golden["now"].as_i64().unwrap();
    let in_use: BTreeMap<String, String> = golden["inUse"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();

    for case in golden["periods"].as_array().unwrap() {
        let got = resolve_usage_stats_period(&period_request(&case["request"]), now);
        let (got, want) = outcome(case, got);
        same(&format!("{name} period {}", case["request"]), &got, &want);
    }
    for case in golden["stats"].as_array().unwrap() {
        let options: UsageStatsOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let (got, want) = outcome(case, reader.usage_stats(options, now).await);
        same(&format!("{name} stats {}", case["options"]), &got, &want);
    }
    for case in golden["requests"].as_array().unwrap() {
        let options: UsageRequestsOptions =
            serde_json::from_value(case["options"].clone()).unwrap();
        let got = reader.usage_requests(options, now).await.map(|mut page| {
            // The envelope without the session-labelled list, which the account service owns.
            let count = page["requests"].as_array().map_or(0, Vec::len);
            let mut rest: serde_json::Map<String, Value> = page
                .as_object_mut()
                .unwrap()
                .iter()
                .filter(|(k, _)| *k != "requests")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            rest.insert("requestCount".into(), count.into());
            Value::Object(rest)
        });
        let (got, want) = outcome(case, got);
        same(&format!("{name} requests {}", case["options"]), &got, &want);
    }
    for case in golden["quotaHistory"].as_array().unwrap() {
        let options: QuotaHistoryOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let got = reader.quota_history(options, in_use.clone(), now).await;
        let (got, want) = outcome(case, got);
        same(&format!("{name} quota {}", case["options"]), &got, &want);
    }
    for case in golden["sessionSnapshots"].as_array().unwrap() {
        same(
            &format!("{name} session snapshot {}", case["usage"]),
            &session_usage_snapshot(&case["usage"]),
            &case["result"],
        );
    }
}

#[tokio::test]
async fn genuine_145_fixture_stats_equal_node() {
    check(
        "v145",
        &manifest("../../fixtures/migration/ledger-v145/ledger.sqlite"),
    )
    .await;
}

#[tokio::test]
async fn priced_145_fixture_with_quota_readings_equals_node() {
    check(
        "v145priced",
        &manifest("../../fixtures/migration/ledger-v145/ledger.sqlite"),
    )
    .await;
}

#[tokio::test]
async fn corpus_ledger_stats_equal_node() {
    check(
        "corpus",
        Path::new(
            r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus\v145\usage\ledger.sqlite",
        ),
    )
    .await;
}
