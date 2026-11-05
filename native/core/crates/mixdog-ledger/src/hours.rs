//! The 24-hour view's hourly series (`usage-stats-hours.mjs`). Only retained timestamps
//! establish an hour; legacy day totals stay in one unallocated bucket.

use chrono::Timelike;
use serde_json::Map;
use serde_json::Value;

use crate::measure::Ordered;
use crate::measure::amount;
use crate::measure::is_conversation_source;
use crate::measure::js_number;
use crate::measure::known_cost_turns;
use crate::time::local_fields;
use mixdog_js::math::to_fixed;

const HOUR_MS: i64 = 3_600_000;

#[derive(Clone, Debug, Default)]
struct Slice {
    turns: f64,
    tokens: f64,
    cost_usd: f64,
    cost_known_turns: f64,
    unmeasured_turns: f64,
}

impl Slice {
    fn add(&mut self, turns: f64, tokens: f64, cost: f64, unmeasured: f64, known: f64) {
        self.turns += turns;
        self.tokens += tokens;
        self.cost_usd += cost;
        self.cost_known_turns += known;
        self.unmeasured_turns += unmeasured;
    }
}

struct Bucket {
    key: String,
    label: String,
    future: bool,
    total: Slice,
    providers: Ordered<Slice>,
    span: Option<(i64, i64)>,
    unknown: bool,
}

impl Bucket {
    fn new(key: String, label: String, future: bool) -> Self {
        Self {
            key,
            label,
            future,
            total: Slice::default(),
            providers: Ordered::default(),
            span: None,
            unknown: false,
        }
    }

    fn add(
        &mut self,
        provider: &str,
        turns: f64,
        tokens: f64,
        cost: f64,
        unmeasured: f64,
        known: f64,
    ) {
        self.total.add(turns, tokens, cost, unmeasured, known);
        self.providers
            .entry(provider, Slice::default)
            .add(turns, tokens, cost, unmeasured, known);
    }

    fn to_value(&self) -> Value {
        let fixed = |cost: f64| js_number(mixdog_js::string_to_number(&to_fixed(cost, 6)));
        let mut out = Map::new();
        out.insert("key".into(), self.key.clone().into());
        out.insert("label".into(), self.label.clone().into());
        out.insert("future".into(), self.future.into());
        out.insert("turns".into(), js_number(self.total.turns));
        out.insert("tokens".into(), js_number(self.total.tokens));
        out.insert("costUsd".into(), fixed(self.total.cost_usd));
        out.insert(
            "costKnownTurns".into(),
            js_number(self.total.cost_known_turns),
        );
        out.insert(
            "unmeasuredTurns".into(),
            js_number(self.total.unmeasured_turns),
        );
        let providers = self
            .providers
            .iter()
            .map(|(provider, slice)| {
                let mut entry = Map::new();
                entry.insert("provider".into(), provider.clone().into());
                entry.insert("turns".into(), js_number(slice.turns));
                entry.insert("tokens".into(), js_number(slice.tokens));
                entry.insert("costUsd".into(), fixed(slice.cost_usd));
                entry.insert("costKnownTurns".into(), js_number(slice.cost_known_turns));
                entry.insert("unmeasuredTurns".into(), js_number(slice.unmeasured_turns));
                Value::Object(entry)
            })
            .collect();
        out.insert("providers".into(), Value::Array(providers));
        if let Some((from, to)) = self.span {
            out.insert("fromMs".into(), from.into());
            out.insert("toMs".into(), to.into());
        }
        if self.unknown {
            out.insert("unknown".into(), true.into());
        }
        Value::Object(out)
    }
}

fn tokens_of(row: &Value, fields: [&str; 4]) -> f64 {
    fields.iter().map(|f| amount(row.get(*f))).sum()
}

/// `records` is the rollup's `hourly` (`{rows, unallocated}`); the period bounds come from the
/// resolved period.
pub fn hourly_series(
    records: Option<&Value>,
    from_ms: i64,
    to_ms: i64,
    end_ms: i64,
    conversation_only: bool,
) -> Value {
    let mut buckets: Vec<Bucket> = Vec::new();
    let mut ts = from_ms;
    // Rolling windows always contain 24 elapsed hours, even across DST changes.
    while ts < end_ms {
        let local = local_fields(ts);
        let mut bucket = Bucket::new(
            ts.to_string(),
            format!("{:02}:{:02}", local.hour(), local.minute()),
            ts > to_ms,
        );
        bucket.span = Some((ts, (ts + HOUR_MS).min(to_ms)));
        buckets.push(bucket);
        ts += HOUR_MS;
    }
    let rows = records
        .and_then(|r| r.get("rows"))
        .and_then(Value::as_array);
    for row in rows.into_iter().flatten() {
        let Some(row_ts) = row.get("ts").and_then(Value::as_f64) else {
            continue;
        };
        if row_ts < from_ms as f64 || row_ts > to_ms as f64 {
            continue;
        }
        if conversation_only
            && !is_conversation_source(row.get("source_type").and_then(Value::as_str))
        {
            continue;
        }
        let at = (((row_ts - from_ms as f64) / HOUR_MS as f64).floor() as usize)
            .min(buckets.len().saturating_sub(1));
        let Some(bucket) = buckets.get_mut(at) else {
            continue;
        };
        let unmeasured = amount(row.get("unmeasuredTurns"));
        let priced = row.get("cost_usd").is_some_and(|c| !c.is_null()) && unmeasured == 0.0;
        bucket.add(
            row.get("provider").and_then(Value::as_str).unwrap_or(""),
            1.0,
            tokens_of(row, ["input", "output", "cache_read", "cache_write"]),
            amount(row.get("cost_usd")),
            unmeasured,
            if priced { 1.0 } else { 0.0 },
        );
    }
    let mut unknown = Bucket::new("unknown-time".into(), String::new(), false);
    unknown.unknown = true;
    let unallocated = records
        .and_then(|r| r.get("unallocated"))
        .and_then(Value::as_array);
    for route in unallocated.into_iter().flatten() {
        let usage = if conversation_only {
            route.get("conversation")
        } else {
            Some(route)
        };
        let Some(usage) = usage.filter(|u| !u.is_null()) else {
            continue;
        };
        unknown.add(
            route.get("provider").and_then(Value::as_str).unwrap_or(""),
            amount(usage.get("turns")),
            tokens_of(usage, ["input", "output", "cacheRead", "cacheWrite"]),
            amount(usage.get("costUsd")),
            amount(usage.get("unmeasuredTurns")),
            known_cost_turns(usage),
        );
    }
    if unknown.total.turns != 0.0 || unknown.total.tokens != 0.0 || unknown.total.cost_usd != 0.0 {
        buckets.push(unknown);
    }
    Value::Array(buckets.iter().map(Bucket::to_value).collect())
}
