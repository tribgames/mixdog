//! `quotaUsable` (quota-reading.mjs): can this provider serve this model now? The forced usage
//! readings are taken by the usage service; this decides from them, as a send would find an account.

use std::collections::HashSet;

use crate::accounts::policy::{choose_account, quota_window_applies_to_model, window_without_credits};
use crate::accounts::{Pool, Window};
use serde_json::Value;

fn positive(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n > 0.0)
}

fn balance_limit_reached(balance: &Value) -> bool {
    balance.get("overageLimitReached") == Some(&Value::Bool(true))
        || balance.get("spendControlReached") == Some(&Value::Bool(true))
        || balance.get("workspaceLimitReached") == Some(&Value::Bool(true))
}

/// Tri-state credit verdict from a reading's `balance`:
/// - `Some(true)`: measured evidence that credit overage can serve requests now.
/// - `Some(false)`: measured evidence that credit overage is disabled, capped, or depleted.
/// - `None`: no credit verdict in this balance.
pub fn balance_credit_state(balance: Option<&Value>) -> Option<bool> {
    let balance = balance.filter(|b| !b.is_null())?;
    if balance_limit_reached(balance) {
        return Some(false);
    }
    if balance.get("unlimited") == Some(&Value::Bool(true)) {
        return Some(true);
    }
    match balance.get("hasCredits") {
        Some(Value::Bool(false)) => return Some(false),
        Some(Value::Bool(true)) => {
            return Some(balance.get("remainingCredits").is_none_or(Value::is_null) || positive(balance.get("remainingCredits")));
        }
        _ => {}
    }
    // Cursor's `cursor-dashboard` balance reports the included plan pool (`remainingUsd`),
    // not overage credit; require an explicit `hasCredits` or `unlimited` verdict for it.
    if balance.get("source").and_then(Value::as_str) == Some("cursor-dashboard") {
        return None;
    }
    let rem_credits = balance.get("remainingCredits").and_then(Value::as_f64).filter(|n| n.is_finite());
    let rem_usd = balance.get("remainingUsd").and_then(Value::as_f64).filter(|n| n.is_finite());
    if rem_credits.is_some() || rem_usd.is_some() {
        return Some(rem_credits.is_some_and(|n| n > 0.0) || rem_usd.is_some_and(|n| n > 0.0));
    }
    None
}

/// Measured evidence in a reading's `balance` that credit overage can serve requests now.
pub fn balance_has_credits(balance: Option<&Value>) -> bool {
    balance_credit_state(balance) == Some(true)
}

/// Tri-state overage credit verdict from a usage snapshot for `provider`.
pub fn snapshot_credit_state(provider: &str, snapshot: &Value) -> Option<bool> {
    let balance = snapshot.get("balance").filter(|b| !b.is_null())?;
    if matches!(provider, "cursor-oauth" | "cursor-api")
        || snapshot.get("source").and_then(Value::as_str) == Some("cursor-dashboard")
        || balance.get("source").and_then(Value::as_str) == Some("cursor-dashboard")
    {
        if balance_limit_reached(balance) {
            return Some(false);
        }
        if balance.get("unlimited") == Some(&Value::Bool(true)) {
            return Some(true);
        }
        return match balance.get("hasCredits") {
            Some(Value::Bool(v)) => Some(*v),
            _ => None,
        };
    }
    balance_credit_state(Some(balance))
}

/// Measured evidence in a usage snapshot that usable overage credits exist for `provider`.
pub fn snapshot_has_credits(provider: &str, snapshot: &Value) -> bool {
    snapshot_credit_state(provider, snapshot) == Some(true)
}

/// `readingServesModel`: measured evidence in this one reading that `model` can be served: an
/// applicable window with a numeric meter and none of them spent, or, when the account pays with
/// credits, a positive measured balance. A failed, unknown or balance-only reading is no evidence.
pub fn reading_serves_model(reading: Option<&Value>, model: &str, use_credits: bool) -> bool {
    let Some(reading) = reading.filter(|r| !r.is_null()) else { return false };
    let applicable: Vec<(Window, f64)> = reading
        .get("quotaWindows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .filter_map(|raw| {
                    let used = raw.get("usedPct").and_then(Value::as_f64).filter(|n| n.is_finite())?;
                    let window: Window = serde_json::from_value(raw.clone()).unwrap_or_default();
                    // A full counter that refuses nothing is neither proof of service nor of refusal.
                    let counter_only = window.binding == Some(false) && used >= 100.0;
                    (quota_window_applies_to_model(&window, model) && !counter_only).then_some((window, used))
                })
                .collect()
        })
        .unwrap_or_default();
    if applicable.iter().any(|(window, used)| *used >= 100.0 && window_without_credits(window)) {
        return false;
    }
    let provider = reading.get("provider").and_then(Value::as_str).unwrap_or("");
    if use_credits && snapshot_has_credits(provider, reading) {
        return true;
    }
    !applicable.is_empty() && applicable.iter().all(|(_, u)| *u < 100.0)
}

/// One roster account and its forced reading.
pub struct AccountReading<'a> {
    pub id: &'a str,
    pub reading: Option<&'a Value>,
}

/// `measureProviderQuota`'s answer.
pub enum Measurement<'a> {
    /// A provider that reports no exhausted quota.
    None,
    /// No roster: the single credential's fresh meter decides.
    Single { use_credits: bool, reading: Option<&'a Value> },
    /// One reading per roster account; the pool's own choice decides among the proven.
    Roster { use_credits: bool, accounts: Vec<AccountReading<'a>>, pool: &'a Pool },
}

/// `quotaMeasurementServesModel`: only the measurement counts as evidence; an account whose forced
/// reading failed or measured nothing for this model stays exhausted however its older record reads.
pub fn quota_measurement_serves_model(measurement: &Measurement<'_>, model: &str, now: i64) -> bool {
    match measurement {
        Measurement::None => true,
        Measurement::Single { use_credits, reading } => reading_serves_model(*reading, model, *use_credits),
        Measurement::Roster { use_credits, accounts, pool } => {
            let unproven: HashSet<String> =
                accounts.iter().filter(|row| !reading_serves_model(row.reading, model, *use_credits)).map(|row| row.id.to_owned()).collect();
            if unproven.len() == accounts.len() {
                return false;
            }
            choose_account(pool, &unproven, now, model, None).is_some()
        }
    }
}
