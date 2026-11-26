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

/// Which models a known bucket gates.
#[derive(Clone, Copy)]
enum Covers {
    /// Gemini models, minus Argon when its own bucket is reported.
    Gemini,
    Argon,
    ThirdParty,
}

/// The gateway's bucket ids, in display order (group names are display text and may change): the id, its window, the
/// row label and the models it gates. A bucket not in this table is unknown.
const KNOWN: [(&str, &str, &str, Covers); 5] = [
    ("gemini-5h", "5h", "5H", Covers::Gemini),
    ("gemini-weekly", "weekly", "7D", Covers::Gemini),
    ("gemini-argon-wtu-weekly", "weekly", "7D Argon", Covers::Argon),
    ("3p-5h", "5h", "5H Claude/GPT", Covers::ThirdParty),
    ("3p-weekly", "weekly", "7D Claude/GPT", Covers::ThirdParty),
];
/// The model ids each separate bucket meters.
const THIRD_PARTY_MODELS: [&str; 2] = ["claude", "gpt"];
const ARGON_MODELS: [&str; 1] = ["argon"];

/// `antigravityHeaders()`' `User-Agent`: the hub client identity, whatever the host.
pub fn user_agent(version: &str) -> String {
    crate::providers::google::auth::antigravity::user_agent(version)
}

enum Scope {
    Models(Vec<&'static str>),
    ModelsExcept(Vec<&'static str>, Vec<&'static str>),
}

fn quota_row(label: &str, bucket: Option<&Value>, scope: Scope) -> Option<Value> {
    let bucket = bucket.filter(|b| b.is_object() || b.is_array())?;
    let reset_text = match bucket.get("resetTime") {
        Some(Value::Null | Value::Bool(false)) | None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => value_to_string(other),
    };
    let reset_at = date_parse(&reset_text);
    let has_reset = reset_at.is_finite() && reset_at > 0.0;
    // A reset time with no remaining fraction at all is a bucket the service has emptied; a fraction that is
    // present but not a number is a malformed reading.
    let remaining = match bucket.get("remainingFraction") {
        None if has_reset => 0.0,
        other => other.and_then(Value::as_f64).filter(|f| f.is_finite())?,
    };
    let used_pct = round(((1.0 - remaining) * 100.0).clamp(0.0, 100.0), 2);
    let mut row = Map::new();
    row.insert("label".into(), label.into());
    row.insert("usedPct".into(), jn(used_pct));
    if has_reset {
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

fn id_of(bucket: &Value) -> Option<&str> {
    bucket.get("bucketId").and_then(Value::as_str)
}

fn window_of(bucket: &Value) -> Option<&str> {
    bucket.get("window").and_then(Value::as_str)
}

/// `antigravityQuotaWindows`: the Gemini 5H/7D rows, the separate Argon weekly row and the Claude/GPT
/// pair, each gating only the models it covers, then any other bucket under the name the response gives it. A bucket
/// the response marks `disabled` meters nothing and is no row.
pub fn quota_windows(summary: &Value) -> Vec<Value> {
    let groups = summary.get("groups").and_then(Value::as_array).into_iter().flatten().filter(|g| g.is_object() || g.is_array());
    let buckets: Vec<&Value> = groups
        .flat_map(|g| g.get("buckets").and_then(Value::as_array).into_iter().flatten())
        .filter(|b| (b.is_object() || b.is_array()) && b.get("disabled") != Some(&Value::Bool(true)))
        .collect();
    // The Gemini pair covers Gemini models only: a model it does not name has unknown coverage, which
    // is not exhaustion. The Argon bucket, when reported, meters Argon on its own.
    let reported = |id: &str, window: &str| buckets.iter().copied().find(|b| id_of(b) == Some(id) && window_of(b) == Some(window));
    let argon_reported = KNOWN.iter().any(|&(id, window, _, covers)| matches!(covers, Covers::Argon) && reported(id, window).is_some());
    let argon_apart = if argon_reported { ARGON_MODELS.to_vec() } else { Vec::new() };
    let mut rows: Vec<Value> = KNOWN
        .iter()
        .filter_map(|&(id, window, label, covers)| {
            let bucket = reported(id, window);
            let scope = match covers {
                Covers::Gemini => Scope::ModelsExcept(vec!["gemini"], argon_apart.clone()),
                Covers::Argon => Scope::Models(ARGON_MODELS.to_vec()),
                Covers::ThirdParty => Scope::Models(THIRD_PARTY_MODELS.to_vec()),
            };
            quota_row(label, bucket, scope)
        })
        .collect();
    // A bucket under a known id but another window is a malformed occurrence of that id, not a new meter. Any other
    // bucket has unknown coverage: it is listed with an empty model scope and never gates rotation.
    rows.extend(buckets.iter().copied().filter(|b| b.is_object() && !KNOWN.iter().any(|(id, ..)| id_of(b) == Some(*id))).filter_map(|b| {
        let name = ["displayName", "bucketId"].iter().find_map(|k| b.get(*k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))?;
        quota_row(name, Some(b), Scope::Models(Vec::new()))
    }));
    rows
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
