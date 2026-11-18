//! `AntigravityOAuthProvider.getUsageSnapshot()` (`providers/antigravity-oauth.mjs`,
//! `antigravity-oauth-catalog.mjs`): the Cloud Code Assist quota counters of the signed-in Google
//! account, read from `retrieveUserQuotaSummary` on the daily host.

use mixdog_js::time::date_parse;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::usage_normalize::jn;
use super::usage_normalize::round;

pub const PROVIDER_ID: &str = "antigravity-oauth";
pub const QUOTA_URL: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
/// `FETCH_MODELS_TIMEOUT_MS` of `antigravity-oauth-catalog.mjs`.
pub const REQUEST_TIMEOUT_MS: u64 = 15_000;

// The gateway's bucket ids; group names are display text and may change.
const GEMINI_5H: &str = "gemini-5h";
const GEMINI_WEEKLY: &str = "gemini-weekly";
const ARGON_WEEKLY: &str = "gemini-argon-wtu-weekly";
const THIRD_PARTY_5H: &str = "3p-5h";
const THIRD_PARTY_WEEKLY: &str = "3p-weekly";
/// The model ids each separate bucket meters.
const THIRD_PARTY_MODELS: [&str; 2] = ["claude", "gpt"];
const ARGON_MODELS: [&str; 1] = ["argon"];

/// `antigravityHeaders()`' `User-Agent`: the hub client identity, whatever the host.
pub fn user_agent(version: &str) -> String {
    crate::providers::google::auth::antigravity::user_agent(version)
}

const GEMINI_MODELS: [&str; 1] = ["gemini"];

enum Scope {
    Models(Vec<&'static str>),
    ModelsExcept(Vec<&'static str>, Vec<&'static str>),
}

fn quota_row(label: &str, bucket: Option<&Value>, scope: Scope) -> Option<Value> {
    let bucket = bucket.filter(|b| b.is_object() || b.is_array())?;
    let remaining = bucket.get("remainingFraction").and_then(Value::as_f64).filter(|f| f.is_finite())?;
    let used_pct = round(((1.0 - remaining) * 100.0).clamp(0.0, 100.0), 2);
    let reset_text = match bucket.get("resetTime") {
        Some(Value::Null | Value::Bool(false)) | None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => value_to_string(other),
    };
    let reset_at = date_parse(&reset_text);
    let mut row = Map::new();
    row.insert("label".into(), label.into());
    row.insert("usedPct".into(), jn(used_pct));
    if reset_at.is_finite() && reset_at > 0.0 {
        row.insert("resetAt".into(), jn(reset_at));
    }
    row.insert("source".into(), "antigravity-quota-summary".into());
    match scope {
        Scope::Models(models) => {
            row.insert("models".into(), json!(models));
        }
        Scope::ModelsExcept(models, except) => {
            row.insert("models".into(), json!(models));
            if !except.is_empty() {
                row.insert("except".into(), json!(except));
            }
        }
    }
    Some(Value::Object(row))
}

/// `antigravityQuotaWindows`: the Gemini 5H/7D rows, the separate Argon weekly row and the Claude/GPT
/// pair, each gating only the models it covers.
pub fn quota_windows(summary: &Value) -> Vec<Value> {
    let groups = summary.get("groups").and_then(Value::as_array).into_iter().flatten().filter(|g| g.is_object() || g.is_array());
    let buckets: Vec<&Value> = groups.flat_map(|g| g.get("buckets").and_then(Value::as_array).into_iter().flatten()).collect();
    let bucket = |id: &str, window: &str| {
        buckets.iter().copied().find(|b| (b.is_object() || b.is_array()) && b.get("bucketId").and_then(Value::as_str) == Some(id) && b.get("window").and_then(Value::as_str) == Some(window))
    };
    let reported = |ids: &[&str]| buckets.iter().any(|b| b.get("bucketId").and_then(Value::as_str).is_some_and(|id| ids.contains(&id)));
    // The Gemini pair covers Gemini models only: a model it does not name has unknown coverage, which
    // is not exhaustion. The Argon bucket, when reported, meters Argon on its own.
    let argon_apart = if reported(&[ARGON_WEEKLY]) { ARGON_MODELS.to_vec() } else { Vec::new() };
    let gemini = || Scope::ModelsExcept(GEMINI_MODELS.to_vec(), argon_apart.clone());
    [
        quota_row("5H", bucket(GEMINI_5H, "5h"), gemini()),
        quota_row("7D", bucket(GEMINI_WEEKLY, "weekly"), gemini()),
        quota_row("7D Argon", bucket(ARGON_WEEKLY, "weekly"), Scope::Models(ARGON_MODELS.to_vec())),
        quota_row("5H Claude/GPT", bucket(THIRD_PARTY_5H, "5h"), Scope::Models(THIRD_PARTY_MODELS.to_vec())),
        quota_row("7D Claude/GPT", bucket(THIRD_PARTY_WEEKLY, "weekly"), Scope::Models(THIRD_PARTY_MODELS.to_vec())),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// The snapshot: always an object, even with no row (the usage service reads an empty one as nothing).
pub fn snapshot(summary: &Value) -> Value {
    let mut out = Map::new();
    out.insert("provider".into(), PROVIDER_ID.into());
    out.insert("model".into(), Value::Null);
    out.insert("source".into(), "antigravity-quota-summary".into());
    out.insert("quotaWindows".into(), Value::Array(quota_windows(summary)));
    Value::Object(out)
}

#[cfg(node_twin)]
#[cfg(test)]
#[path = "usage_antigravity_tests.rs"]
mod tests;
