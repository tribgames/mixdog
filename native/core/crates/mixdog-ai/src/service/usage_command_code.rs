//! `CommandCodeOAuthProvider.getUsageSnapshot()` (`providers/command-code-oauth.mjs`): the plan usage
//! of a Command Code API key, read from `/alpha/billing/credits`.

use mixdog_js::time::date_parse;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::string_to_number;
use mixdog_js::to_number_of;
use serde_json::Map;
use serde_json::Value;

pub const PROVIDER_ID: &str = "command-code-oauth";
pub const CREDITS_URL: &str = "https://api.commandcode.ai/alpha/billing/credits";
/// `REQUEST_TIMEOUT_MS` of `command-code-oauth-tokens.mjs`.
pub const REQUEST_TIMEOUT_MS: u64 = 15_000;

const FIVE_HOURS_MS: f64 = 5.0 * 60.0 * 60.0 * 1000.0;
const WEEK_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `normalizeExpiresAtMs`: epoch seconds or milliseconds, numeric text or a date text; 0 when unreadable.
fn normalize_expires_at_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::String(text)) = value {
        let trimmed = js_trim(text);
        let numeric = if trimmed.is_empty() { f64::NAN } else { string_to_number(trimmed) };
        if !numeric.is_finite() {
            let ms = date_parse(text);
            return if ms.is_finite() { ms } else { 0.0 };
        }
    }
    // `Number(value || 0)`
    let falsy = match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_none_or(|n| n == 0.0 || n.is_nan()),
        _ => false,
    };
    let n = if falsy { 0.0 } else { to_number_of(value) };
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

fn credit_window(id: &str, label: &str, long_label: &str, duration_ms: f64, entry: Option<&Value>) -> Option<Value> {
    let entry = entry.filter(|entry| entry.is_object())?;
    let cap = to_number_of(entry.get("cap"));
    let used = to_number_of(entry.get("used"));
    if !cap.is_finite() || cap <= 0.0 || !used.is_finite() || used < 0.0 {
        return None;
    }
    let used_pct = ((used / cap) * 100.0).min(100.0);
    let used_fraction = used_pct / 100.0;
    let reset_at = normalize_expires_at_ms(entry.get("resetAt"));
    let mut window = Map::new();
    window.insert("id".into(), id.into());
    window.insert("label".into(), label.into());
    window.insert("longLabel".into(), long_label.into());
    window.insert("source".into(), "command-code-credits".into());
    window.insert("usedPct".into(), json_number((used_pct * 100.0).round() / 100.0));
    window.insert("usedFraction".into(), json_number(used_fraction));
    window.insert("remainingFraction".into(), json_number(1.0 - used_fraction));
    window.insert("status".into(), usage_status(used_fraction).into());
    window.insert("durationMs".into(), json_number(duration_ms));
    if reset_at != 0.0 {
        window.insert("resetAt".into(), json_number(reset_at));
    }
    Some(Value::Object(window))
}

/// `quotaWindowsFromCredits`: the `windowLimits` of a credits answer as quota windows.
pub fn quota_windows_from_credits(body: &Value) -> Vec<Value> {
    let root = body.get("data").filter(|data| !data.is_null()).unwrap_or(body);
    let limits = root.get("windowLimits");
    [
        credit_window("5h", "5H", "5 Hours", FIVE_HOURS_MS, limits.and_then(|l| l.get("fiveHour"))),
        credit_window("1w", "7D", "Weekly", WEEK_MS, limits.and_then(|l| l.get("weekly"))),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The usage snapshot, or `None` when the answer holds no window.
pub fn snapshot(body: &Value, user_id: &str, fetched_at: i64) -> Option<Value> {
    let windows = quota_windows_from_credits(body);
    if windows.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("provider".into(), PROVIDER_ID.into());
    out.insert("model".into(), Value::Null);
    out.insert("source".into(), "command-code-credits".into());
    out.insert("fetchedAt".into(), fetched_at.into());
    out.insert("quotaWindows".into(), Value::Array(windows));
    if !user_id.is_empty() {
        out.insert("accountId".into(), user_id.into());
    }
    Some(Value::Object(out))
}

#[cfg(test)]
#[path = "usage_command_code_tests.rs"]
mod tests;
