//! Parity gate: the Rust ledger's answers equal the golden twin of today's Node usage queries
//! (`fixtures/ledger-queries/*.json`, recorded by `benchmarks/rust-core/recorders/
//! record-ledger-queries.mjs`) over the same ledger file, exactly.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::path::Path;
use std::path::PathBuf;

use mixdog_ledger::db::Connection;
use mixdog_ledger::requests::RequestQuery;
use mixdog_ledger::requests::read_usage_requests;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::rollup::rollup_usage;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::sums::build_sums_step;
use mixdog_ledger::sums::read_session_usage;
use serde_json::Value;

fn manifest(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

fn str_of(options: &Value, key: &str, default: &str) -> String {
    options
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn rollup_query(options: &Value) -> RollupQuery {
    RollupQuery {
        from_day: str_of(options, "fromDay", "0000-01-01"),
        to_day: str_of(options, "toDay", "9999-12-31"),
        from_ms: options.get("fromMs").and_then(Value::as_i64),
        to_ms: options.get("toMs").and_then(Value::as_i64),
        hourly_day: options
            .get("hourlyDay")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

/// Path of the first difference, so a failure names a field instead of dumping megabytes.
fn first_diff(path: &str, got: &Value, want: &Value) -> Option<String> {
    match (got, want) {
        (Value::Object(a), Value::Object(b)) => {
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
        _ if got == want => None,
        _ => Some(format!("{path}: got {got} want {want}")),
    }
}

fn same(label: &str, got: &Value, want: &Value) {
    if let Some(diff) = first_diff(label, got, want) {
        panic!("{}", diff.chars().take(600).collect::<String>());
    }
}

fn check(name: &str, source: &Path) {
    let golden: Value = serde_json::from_slice(
        &std::fs::read(manifest(&format!(
            "../../fixtures/ledger-queries/{name}.json"
        )))
        .unwrap(),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    std::fs::copy(source, &path).unwrap();
    let mut conn = Connection::open(&path).unwrap();
    prepare(&mut conn).unwrap();
    while !build_sums_step(&mut conn, 200).unwrap() {}

    for case in golden["rollups"].as_array().unwrap() {
        let got = rollup_usage(&conn, &rollup_query(&case["options"]))
            .unwrap()
            .to_value();
        same(
            &format!("{name} rollup {}", case["options"]),
            &got,
            &case["result"],
        );
    }
    for case in golden["requests"].as_array().unwrap() {
        let query: RequestQuery = serde_json::from_value(case["options"].clone()).unwrap();
        let got = read_usage_requests(&conn, &query).unwrap();
        same(
            &format!("{name} requests {}", case["options"]),
            &got,
            &case["result"],
        );
    }
    for case in golden["sessionUsage"].as_array().unwrap() {
        let got = read_session_usage(
            &conn,
            &strings(&case["sessionIds"]),
            &strings(&case["ownerIds"]),
        )
        .unwrap();
        same(
            &format!("{name} sessionUsage {}", case["sessionIds"]),
            &got,
            &case["result"],
        );
    }
}

#[test]
fn genuine_145_fixture_equals_node() {
    check(
        "v145",
        &manifest("../../fixtures/migration/ledger-v145/ledger.sqlite"),
    );
}

#[test]
fn corpus_ledger_equals_node() {
    check(
        "corpus",
        Path::new(
            r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus\v145\usage\ledger.sqlite",
        ),
    );
}
