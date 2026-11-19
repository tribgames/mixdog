//! `OpenCodeGoOAuthProvider.getUsageSnapshot()` (`providers/opencode-go-oauth.mjs`,
//! `opencode-go-usage.mjs`): the Go 5-hour / weekly / monthly meters of the account's organization,
//! read from the OpenCode Console's `/api/go/status`.

use mixdog_js::js_trim;
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

/// A micro-cent amount the Console actually stated: a number or numeric text. `null`, empty text and other
/// shapes are absent data, which `Number()` would read as 0 and so as proof of headroom.
fn stated_micro_cents(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::String(text) if js_trim(text).is_empty() => None,
        Value::String(_) | Value::Number(_) => num(value),
        _ => None,
    }
}

fn usd_from_micro_cents(micro: f64) -> f64 {
    round(micro / MICRO_CENTS_PER_USD, 4)
}

/// The share used, rounded for display but never rounded across the cap: only a spend that reached the cap reads
/// 100 %, so a near-full meter cannot prove a limit it has not hit (Go's caps are the subscription's alone; a
/// Zen balance has no meter here).
fn used_share(used: f64, limit: f64) -> f64 {
    let share = round(used / limit * 100.0, 2);
    if used >= limit { share.max(100.0) } else { share.min(99.99) }
}

/// What one Go meter of the organization's subscription says.
enum Meter {
    Window(Value),
    /// The Console states there is no cap to measure against (the meter is absent, null or has a cap of 0 or less).
    Withdrawn,
    /// The meter is present but its amounts are not stated or not sane: it proves nothing either way.
    Unreadable,
}

/// A meter without a stated positive cap or a stated non-negative spend is never read as an unused window.
fn meter(label: &str, raw: Option<&Value>) -> Meter {
    let raw = match raw {
        None | Some(Value::Null) => return Meter::Withdrawn,
        Some(raw) if raw.is_object() || raw.is_array() => raw,
        Some(_) => return Meter::Unreadable,
    };
    let Some(limit) = stated_micro_cents(raw.get("limitMicroCents")) else { return Meter::Unreadable };
    if limit <= 0.0 {
        return Meter::Withdrawn;
    }
    let Some(used) = stated_micro_cents(raw.get("usedMicroCents")).filter(|used| *used >= 0.0) else { return Meter::Unreadable };
    let (limit_usd, used_usd) = (usd_from_micro_cents(limit), usd_from_micro_cents(used));
    // `resetsAt` is an absolute ISO timestamp, null on a window that has not started: an unparsable
    // value drops the field.
    let reset_at = date_parse(&clean(raw.get("resetsAt")).unwrap_or_default());
    let mut window = Map::new();
    window.insert("label".into(), label.into());
    window.insert("source".into(), "opencode-go-console".into());
    window.insert("usedPct".into(), jn(used_share(used, limit)));
    window.insert("limitUsd".into(), jn(limit_usd));
    window.insert("usedUsd".into(), jn(used_usd));
    window.insert("remainingUsd".into(), jn(round((limit_usd - used_usd).max(0.0), 4)));
    if reset_at.is_finite() {
        window.insert("resetAt".into(), jn(reset_at));
    }
    Meter::Window(Value::Object(window))
}

/// `snapshotFromStatus`: `None` when the answer states no meters or holds an unreadable one and no usable
/// meter. A status whose every meter is withdrawn is a successful reading of no limit: its snapshot has no
/// windows, which retires the windows an earlier reading measured.
pub fn snapshot_from_status(status: &Value) -> Option<Value> {
    let meters = status.get("access")?.get("meters").filter(|m| m.is_object() || m.is_array())?;
    let read: Vec<Meter> = METERS.iter().map(|(kind, label)| meter(label, meters.get(*kind))).collect();
    let unreadable = read.iter().any(|m| matches!(m, Meter::Unreadable));
    let windows: Vec<Value> = read.into_iter().filter_map(|m| if let Meter::Window(w) = m { Some(w) } else { None }).collect();
    if windows.is_empty() && unreadable {
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

/// Where the Rust reading intentionally departs from the recording (`fixtures/opencode-go-usage`), for every twin that
/// replays it: a meter proves a limit only from stated amounts, and reads full only from a spend that reached its cap.
/// Per flow, the window labels whose `usedPct` differs (a number) or which the product does not report (`null`).
#[cfg(test)]
pub(crate) fn go_twin_departure(flow: &str) -> Option<Value> {
    match flow {
        // A micro-cent short of the cap is 99.99 %, where the recording rounded it to 100.
        "three meters" => Some(serde_json::json!({ "M": 99.99 })),
        // The cap is withdrawn: no window, where the recording kept a 0 % one.
        "a zero limit" => Some(serde_json::json!({ "7D": null })),
        // Empty and null amounts are unstated, not 0: only the stated meter remains.
        "numbers, empty text, null and text values" => Some(serde_json::json!({ "7D": null, "M": null })),
        // A negative spend is not a reading.
        "fractional dollars round" => Some(serde_json::json!({ "M": null })),
        _ => None,
    }
}

/// The recorded windows of `flow` in the product's form ([`go_twin_departure`]).
#[cfg(test)]
pub(crate) fn go_twin_windows(flow: &str, recorded: &[Value]) -> Vec<Value> {
    let mut want = recorded.to_vec();
    for (label, used) in go_twin_departure(flow).as_ref().and_then(Value::as_object).into_iter().flatten() {
        match used {
            Value::Null => want.retain(|w| w["label"] != *label),
            used => want.iter_mut().filter(|w| w["label"] == *label).for_each(|w| w["usedPct"] = used.clone()),
        }
    }
    want
}

#[cfg(node_twin)]
#[cfg(test)]
#[path = "usage_opencode_go_tests.rs"]
mod tests;
