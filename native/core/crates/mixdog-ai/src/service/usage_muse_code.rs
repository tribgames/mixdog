//! `MuseCodeOAuthProvider.getUsageSnapshot()` (`providers/muse-code-oauth.mjs`,
//! `muse-code-oauth-tokens.mjs`): the Muse Code subscription's window and weekly usage, read from the
//! key endpoint with the Meta account token (never the inference key) without onboarding.

use mixdog_js::time::date_parse;
use mixdog_js::to_number_of;
use serde_json::Map;
use serde_json::Value;

use super::usage_normalize::jn;
use super::usage_normalize::round;

pub const PROVIDER_ID: &str = "muse-code-oauth";
pub const KEY_URL: &str = "https://api.meta.ai/muse-code/key";
pub const API_VERSION: &str = "1.0.0";
/// `REQUEST_TIMEOUT_MS` of `muse-code-oauth-tokens.mjs`.
pub const REQUEST_TIMEOUT_MS: u64 = 20_000;
/// A failed read suppresses the next ones for this long (± 25 %).
pub const FAILURE_BACKOFF_MS: i64 = 5 * 60_000;

const WEEK_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

fn is_number(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.as_f64().is_some_and(f64::is_finite))
}

/// `isUsageWindow`.
fn is_usage_window(window: Option<&Value>) -> bool {
    let Some(window) = window.filter(|w| !w.is_null()) else { return true };
    window.is_object()
        && is_number(window.get("used_percent"))
        && is_number(window.get("window_duration_mins"))
        && window.get("resets_at").is_none_or(|r| r.is_string() || r.is_number())
}

/// `validateKeyPayload`: a key response whose fields have the wrong types is rejected, not stringified.
pub fn payload_is_valid(payload: &Value) -> bool {
    if !payload.is_object() {
        return false;
    }
    let optional = |field: &str, string: bool, boolean: bool, null: bool| {
        payload.get(field).is_none_or(|v| (string && v.is_string()) || (boolean && v.is_boolean()) || (null && v.is_null()))
    };
    if !(optional("api_key", true, false, false)
        && optional("user_id", true, false, false)
        && optional("user_email", true, false, false)
        && optional("is_subs_active", false, true, false)
        && optional("require_payment", false, true, false)
        && optional("action_url", true, false, true)
        && optional("require_payment_action_url", true, false, false)
        && optional("subs_tier_id", true, false, true)
        && optional("subs_tier_name", true, false, true))
    {
        return false;
    }
    match payload.get("subs_usage") {
        None | Some(Value::Null) => true,
        Some(usage) => usage.is_object() && is_usage_window(usage.get("window")) && is_usage_window(usage.get("weekly")),
    }
}

fn reset_at_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::String(text)) = value {
        let ms = date_parse(text);
        return if ms.is_finite() { ms } else { 0.0 };
    }
    let n = to_number_of(value);
    if !n.is_finite() || n <= 0.0 {
        0.0
    } else if n < 1e12 {
        n * 1000.0
    } else {
        n
    }
}

fn usage_status(used_fraction: f64) -> &'static str {
    if used_fraction >= 1.0 {
        "exhausted"
    } else if used_fraction >= 0.9 {
        "warning"
    } else {
        "ok"
    }
}

struct Spec {
    id: String,
    label: String,
    long_label: String,
    duration_ms: Option<f64>,
}

fn usage_window(spec: Spec, entry: Option<&Value>, tier: Option<&str>) -> Option<Value> {
    let entry = entry.filter(|e| e.is_object())?;
    let used = entry.get("used_percent").and_then(Value::as_f64).filter(|u| u.is_finite() && *u >= 0.0)?;
    let reset_at = reset_at_ms(entry.get("resets_at"));
    let used_pct = used.min(100.0);
    let used_fraction = used_pct / 100.0;
    let mut window = Map::new();
    window.insert("id".into(), spec.id.into());
    window.insert("label".into(), spec.label.into());
    window.insert("longLabel".into(), spec.long_label.into());
    window.insert("source".into(), "muse-code-key".into());
    window.insert("usedPct".into(), jn(round(used_pct, 2)));
    window.insert("usedFraction".into(), jn(used_fraction));
    window.insert("remainingFraction".into(), jn(1.0 - used_fraction));
    window.insert("status".into(), usage_status(used_fraction).into());
    if let Some(duration) = spec.duration_ms.filter(|d| *d != 0.0) {
        window.insert("durationMs".into(), jn(duration));
    }
    if let Some(tier) = tier.filter(|t| !t.is_empty()) {
        window.insert("tier".into(), tier.into());
    }
    if reset_at != 0.0 {
        window.insert("resetAt".into(), jn(reset_at));
    }
    Some(Value::Object(window))
}

fn rolling_window_spec(minutes: Option<&Value>) -> Spec {
    let m = to_number_of(minutes);
    if !m.is_finite() || m <= 0.0 {
        return Spec { id: "rolling".into(), label: "W".into(), long_label: "Rolling Window".into(), duration_ms: None };
    }
    let rounded = (m + 0.5).floor();
    let whole = rounded % 60.0 == 0.0;
    let hours = rounded / 60.0;
    let count = if whole { hours } else { rounded };
    let unit = if whole { "Hour" } else { "Minute" };
    let shown = |n: f64| mixdog_js::number_to_string(n);
    Spec {
        id: format!("{}m", shown(rounded)),
        label: if whole { format!("{}H", shown(hours)) } else { format!("{}M", shown(rounded)) },
        long_label: format!("{} {}", shown(count), if count == 1.0 { unit.to_owned() } else { format!("{unit}s") }),
        duration_ms: Some(m * 60_000.0),
    }
}

/// `quotaWindowsFromSubsUsage`.
pub fn quota_windows_from_subs_usage(subs_usage: Option<&Value>, tier: Option<&str>) -> Vec<Value> {
    let window = subs_usage.and_then(|u| u.get("window"));
    let weekly = subs_usage.and_then(|u| u.get("weekly"));
    let mut windows = Vec::new();
    windows.extend(usage_window(rolling_window_spec(window.and_then(|w| w.get("window_duration_mins"))), window, tier));
    windows.extend(usage_window(Spec { id: "1w".into(), label: "7D".into(), long_label: "Weekly".into(), duration_ms: Some(WEEK_MS) }, weekly, tier));
    windows
}

fn trimmed(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

/// The usage snapshot of a valid, active key payload; `None` when it holds no window.
pub fn snapshot(payload: &Value, stored_email: &str, stored_account: &str, fetched_at: i64) -> Option<Value> {
    let tier = [trimmed(payload.get("subs_tier_name")), trimmed(payload.get("subs_tier_id"))].into_iter().find(|t| !t.is_empty());
    let windows = quota_windows_from_subs_usage(payload.get("subs_usage"), tier);
    if windows.is_empty() {
        return None;
    }
    let payload_email = mixdog_js::js_to_lowercase(trimmed(payload.get("user_email")));
    let email = [payload_email.as_str(), stored_email].into_iter().find(|e| !e.is_empty()).map(str::to_owned);
    let account = [trimmed(payload.get("user_id")), stored_account, email.as_deref().unwrap_or("")].into_iter().find(|a| !a.is_empty()).map(str::to_owned);
    let mut raw = payload.as_object().cloned().unwrap_or_default();
    raw.shift_remove("api_key");
    let mut keys: Vec<String> = raw.keys().cloned().collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut out = Map::new();
    out.insert("provider".into(), PROVIDER_ID.into());
    out.insert("model".into(), Value::Null);
    out.insert("source".into(), "muse-code-key".into());
    out.insert("fetchedAt".into(), fetched_at.into());
    out.insert("quotaWindows".into(), Value::Array(windows));
    if let Some(tier) = tier {
        out.insert("tier".into(), tier.into());
    }
    if let Some(email) = email {
        out.insert("email".into(), email.into());
    }
    if let Some(account) = account {
        out.insert("accountId".into(), account.into());
    }
    out.insert("raw".into(), Value::Object(raw));
    out.insert("rawKeys".into(), keys.into_iter().map(Value::String).collect());
    Some(Value::Object(out))
}

#[cfg(test)]
#[path = "usage_muse_code_tests.rs"]
mod tests;
