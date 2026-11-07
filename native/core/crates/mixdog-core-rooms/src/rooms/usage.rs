//! `roomUsageLimit` (`session/agent-room.mjs`): the usage-limit stop a member's failed `turndone`
//! item records. A usage limit fails every member alike, so the exchange ends on it at once.

use serde_json::Value;

use super::exchange::UsageLimit;

#[cfg(test)]
mod tests;

/// `QUOTA_KINDS` (`provider-error-kind.mjs`): refusals no wait or replay can change.
const QUOTA_KINDS: [&str; 3] = ["quota_exhausted", "entitlement", "billing"];

/// A JS object (an array is one too) as `typeof x === 'object'` and truthy.
fn object(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_object() || value.is_array())
}

/// `String(value || …)`'s first truthy operand: a non-empty string, a non-zero number, `true`.
fn truthy(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) if number.as_f64().is_some_and(|number| number != 0.0) => Some(number.to_string()),
        Value::Bool(true) => Some("true".to_owned()),
        _ => None,
    }
}

/// `finiteTime`: a finite number above zero.
fn finite_time(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64().filter(|number| number.is_finite() && *number > 0.0)?;
    Some(number as i64)
}

/// `roomUsageLimit(done, route)`: `done` is the `turndone` item (`Null` for none), `route` the
/// member's route (`Null` for none).
pub fn room_usage_limit(done: &Value, route: &Value) -> Option<UsageLimit> {
    if done.get("status").and_then(Value::as_str) != Some("failed") {
        return None;
    }
    let quota = object(done.get("quota"));
    let described = object(done.get("errorKind"));
    let kind = match described.and_then(|described| described.get("kind")).filter(|kind| truthy(Some(*kind)).is_some()) {
        Some(kind) => kind.as_str().filter(|kind| QUOTA_KINDS.contains(kind)).unwrap_or(""),
        None if quota.is_some() => "quota_exhausted",
        None => "",
    };
    if kind.is_empty() {
        return None;
    }
    let pick = |field: &str| truthy(quota.and_then(|quota| quota.get(field))).or_else(|| truthy(done.get(field))).or_else(|| truthy(route.get(field))).unwrap_or_default();
    Some(UsageLimit {
        kind: kind.to_owned(),
        provider: pick("provider"),
        model: pick("model"),
        reset_at: finite_time(quota.and_then(|quota| quota.get("resetAt"))).or_else(|| finite_time(described.and_then(|described| described.get("resetAt")))),
    })
}
