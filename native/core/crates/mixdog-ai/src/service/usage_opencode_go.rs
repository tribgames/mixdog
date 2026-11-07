//! `OpenCodeGoOAuthProvider.getUsageSnapshot()` (`providers/opencode-go-oauth.mjs`,
//! `opencode-go-usage.mjs`): the Go 5-hour / weekly / monthly meters of the account's organization,
//! read from the OpenCode Console's `/api/go/status`.

use mixdog_js::time::date_parse;
use mixdog_js::to_number_of;
use serde_json::Map;
use serde_json::Value;

use super::usage_normalize::clean;
use super::usage_normalize::jn;
use super::usage_normalize::round;

pub const PROVIDER_ID: &str = "opencode-go-oauth";
pub const STATUS_URL: &str = "https://opencode.ai/console/api/go/status";
/// `FETCH_TIMEOUT_MS` of `opencode-go-usage.mjs`.
pub const FETCH_TIMEOUT_MS: u64 = 6_500;
/// The status request's own `User-Agent` (a browser's: the Console answers it).
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143 Safari/537.36";

/// Meters report micro-cents as strings: "1200000000" is the $12 five-hour cap.
const MICRO_CENTS_PER_USD: f64 = 1e8;
const METERS: [(&str, &str); 3] = [("fiveHour", "5H"), ("week", "7D"), ("month", "M")];

/// This module's own unguarded `num`: `Number(value)` where text '' and null read as 0.
fn num(value: Option<&Value>) -> Option<f64> {
    let n = to_number_of(value);
    n.is_finite().then_some(n)
}

fn usd_from_micro_cents(value: Option<&Value>) -> Option<f64> {
    num(value).map(|micro| round(micro / MICRO_CENTS_PER_USD, 4))
}

fn window_from_meter(label: &str, raw: Option<&Value>) -> Option<Value> {
    let raw = raw.filter(|raw| raw.is_object() || raw.is_array())?;
    let limit_usd = usd_from_micro_cents(raw.get("limitMicroCents"))?;
    let used_usd = usd_from_micro_cents(raw.get("usedMicroCents"))?;
    // `resetsAt` is an absolute ISO timestamp, null on a window that has not started: an unparsable
    // value drops the field.
    let reset_at = date_parse(&clean(raw.get("resetsAt")).unwrap_or_default());
    let mut window = Map::new();
    window.insert("label".into(), label.into());
    window.insert("source".into(), "opencode-go-console".into());
    window.insert("usedPct".into(), jn(if limit_usd > 0.0 { round(used_usd / limit_usd * 100.0, 2) } else { 0.0 }));
    window.insert("limitUsd".into(), jn(limit_usd));
    window.insert("usedUsd".into(), jn(used_usd));
    window.insert("remainingUsd".into(), jn(round((limit_usd - used_usd).max(0.0), 4)));
    if reset_at.is_finite() {
        window.insert("resetAt".into(), jn(reset_at));
    }
    Some(Value::Object(window))
}

/// `snapshotFromStatus`: `None` when the answer holds no usable meter.
pub fn snapshot_from_status(status: &Value) -> Option<Value> {
    let meters = status.get("access")?.get("meters").filter(|m| m.is_object() || m.is_array())?;
    let windows: Vec<Value> = METERS.iter().filter_map(|(kind, label)| window_from_meter(label, meters.get(*kind))).collect();
    if windows.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("provider".into(), "opencode-go".into());
    out.insert("source".into(), "opencode-go-console".into());
    out.insert("quotaWindows".into(), Value::Array(windows));
    Some(Value::Object(out))
}

/// The snapshot as `fetchOpenCodeGoOAuthUsageSnapshot` returns it: the provider id, the sign-in's email
/// and account.
pub fn snapshot(parsed: Value, email: &str, account_id: &str, fetched_at: i64) -> Value {
    let Value::Object(mut out) = parsed else { return parsed };
    out.insert("provider".into(), PROVIDER_ID.into());
    out.insert("model".into(), Value::Null);
    out.insert("fetchedAt".into(), fetched_at.into());
    if !email.is_empty() {
        out.insert("email".into(), email.into());
    }
    if !account_id.is_empty() {
        out.insert("accountId".into(), account_id.into());
    }
    Value::Object(out)
}

#[cfg(test)]
#[path = "usage_opencode_go_tests.rs"]
mod tests;
