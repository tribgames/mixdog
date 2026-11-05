//! `quotaUsable` (quota-reading.mjs): can this provider serve this model now? The forced usage
//! readings are taken by the usage service; this decides from them, as a send would find an account.

use std::collections::HashSet;

use crate::accounts::policy::{choose_account, quota_window_applies_to_model};
use crate::accounts::{Pool, Window};
use serde_json::Value;

fn positive(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n > 0.0)
}

/// `readingServesModel`: measured evidence in this one reading that `model` can be served: an
/// applicable window with a numeric meter and none of them spent, or, when the account pays with
/// credits, a positive measured balance. A failed, unknown or balance-only reading is no evidence.
pub fn reading_serves_model(reading: Option<&Value>, model: &str, use_credits: bool) -> bool {
    let Some(reading) = reading.filter(|r| !r.is_null()) else { return false };
    if use_credits
        && let Some(balance) = reading.get("balance").filter(|b| !b.is_null())
        && (balance.get("unlimited") == Some(&Value::Bool(true))
            || positive(balance.get("remainingCredits"))
            || positive(balance.get("remainingUsd")))
    {
        return true;
    }
    let used: Vec<f64> = reading
        .get("quotaWindows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .filter_map(|raw| {
                    let used = raw.get("usedPct").and_then(Value::as_f64).filter(|n| n.is_finite())?;
                    let window: Window = serde_json::from_value(raw.clone()).unwrap_or_default();
                    quota_window_applies_to_model(&window, model).then_some(used)
                })
                .collect()
        })
        .unwrap_or_default();
    !used.is_empty() && used.iter().all(|u| *u < 100.0)
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
