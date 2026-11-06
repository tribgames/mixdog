//! The provider quota dashboard: row model (`usage-dashboard-model.mjs`) and the row builder
//! (`usage-dashboard.mjs`).

use std::cmp::Ordering;
use std::collections::HashSet;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_js::JsRegex;
use mixdog_js::locale_compare;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::super::js::clean;
use super::super::js::math_round;
use super::super::js::num_or;
use super::super::js::number as n;
use super::super::js::round_to;
use super::super::js::to_fixed;
use super::super::js::truthy;

type Row = Map<String, Value>;

pub fn money(value: f64) -> String {
    if !value.is_finite() {
        return "N/A".into();
    }
    if value == 0.0 {
        "$0".into()
    } else if value >= 10.0 {
        format!("${}", to_fixed(value, 0))
    } else if value >= 1.0 {
        format!("${}", to_fixed(value, 2))
    } else if value >= 0.01 {
        format!("${}", to_fixed(value, 3))
    } else {
        format!("${}", to_fixed(value, 4))
    }
}

pub fn compact_number(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    let abs = value.abs();
    if abs >= 1_000_000.0 {
        format!("{}M", to_fixed(value / 1_000_000.0, if value >= 10_000_000.0 { 0 } else { 1 }))
    } else if abs >= 1_000.0 {
        format!("{}K", to_fixed(value / 1_000.0, if value >= 10_000.0 { 0 } else { 1 }))
    } else if abs >= 10.0 {
        to_fixed(value, 0)
    } else if abs >= 1.0 {
        to_fixed(value, 1)
    } else {
        to_fixed(value, 2)
    }
}

fn r(value: f64, digits: i32) -> f64 {
    round_to(value, digits).unwrap_or(0.0)
}

fn nn(value: Option<&Value>) -> Option<f64> {
    num_or(value, None)
}

/// The first of `keys` present on `entry` (`a ?? b ?? ...`).
fn first<'a>(entry: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| entry.get(*k).filter(|v| !v.is_null()))
}

/// `first(...) ?? cents / 100`.
fn amount(entry: &Value, keys: &[&str], cents: &str) -> Option<f64> {
    match first(entry, keys) {
        Some(v) => nn(Some(v)),
        None => entry.get(cents).and_then(|c| nn(Some(c))).map(|c| c / 100.0),
    }
}

fn js_string(value: &Value) -> String {
    mixdog_js::value_to_string(value)
}

pub fn normalise_windows(value: Option<&Value>, source: &str) -> Vec<Value> {
    let entries: Vec<(String, &Value)> = match value {
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let label = ["label", "name"]
                    .iter()
                    .find_map(|k| entry.get(*k).filter(|v| truthy(Some(v))))
                    .map_or_else(|| format!("W{}", i + 1), js_string);
                (label, entry)
            })
            .collect(),
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|(key, entry)| {
            if !entry.is_object() {
                return None;
            }
            let limit_usd = amount(entry, &["limitUsd", "limit_usd", "budgetUsd", "budget_usd"], "limit_usd_cents");
            let used_usd = amount(
                entry,
                &["usedUsd", "used_usd", "spendUsd", "spend_usd", "costUsd", "cost_usd"],
                "used_usd_cents",
            );
            let remaining_usd = amount(
                entry,
                &["remainingUsd", "remaining_usd", "leftUsd", "left_usd", "balanceUsd", "balance_usd"],
                "remaining_usd_cents",
            );
            let used_pct = nn(first(entry, &["usedPct", "used_pct", "percent", "pct"]));
            let remaining_credits = nn(first(
                entry,
                &["remainingCredits", "remaining_credits", "creditsRemaining", "credits_remaining"],
            ));
            let limit_credits = nn(first(entry, &["limitCredits", "limit_credits"]));
            let used_credits = nn(first(entry, &["usedCredits", "used_credits"]));
            let reset_at = nn(first(entry, &["resetAt", "reset_at", "resetsAt", "resets_at"]));
            let label = match clean(entry.get("label")) {
                l if !l.is_empty() => l,
                _ => if truthy(Some(&json!(key))) { key.to_uppercase() } else { "USE".to_owned() },
            };
            let source_text = match clean(entry.get("source")) {
                s if !s.is_empty() => s,
                _ => source.to_owned(),
            };
            let mut out = Map::new();
            out.insert("label".into(), json!(label));
            out.insert("source".into(), json!(source_text));
            let mut put = |name: &str, value: Option<f64>, digits: i32| {
                if let Some(v) = value {
                    out.insert(name.into(), n(r(v, digits)));
                }
            };
            put("remainingUsd", remaining_usd, 4);
            put("limitUsd", limit_usd, 4);
            put("usedUsd", used_usd, 4);
            put("usedPct", used_pct, 2);
            put("remainingCredits", remaining_credits, 4);
            put("limitCredits", limit_credits, 4);
            put("usedCredits", used_credits, 4);
            if let Some(reset) = reset_at.filter(|v| *v != 0.0) {
                out.insert("resetAt".into(), n(reset));
            }
            if !out.contains_key("usedPct")
                && out.get("limitUsd").and_then(Value::as_f64).is_some_and(|l| l > 0.0)
                && out.contains_key("usedUsd")
            {
                let used = out["usedUsd"].as_f64().unwrap_or(0.0);
                let limit = out["limitUsd"].as_f64().unwrap_or(0.0);
                out.insert("usedPct".into(), n(r((used * 100.0 / limit).min(100.0), 2)));
            }
            Some(Value::Object(out))
        })
        .collect()
}

pub fn normalise_reset_credits(value: Option<&Value>) -> Option<Value> {
    let value = value.filter(|v| v.is_object())?;
    let available_count = nn(first(value, &["availableCount", "available_count"]))?;
    let offer_revision = clean(first(value, &["offerRevision", "offer_revision"]));
    if offer_revision.is_empty() {
        return None;
    }
    let next_expires_at = nn(first(value, &["nextExpiresAt", "next_expires_at"]));
    let raw = first(value, &["availableCredits", "available_credits"]);
    let mut credits: Vec<Row> = raw
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|credit| credit.is_object())
        .map(|credit| {
            let expires = nn(first(credit, &["expiresAt", "expires_at"]));
            let granted = nn(first(credit, &["grantedAt", "granted_at"]));
            let mut out = Map::new();
            if let Some(e) = expires.filter(|e| *e > 0.0) {
                out.insert("expiresAt".into(), n(e));
            }
            if let Some(g) = granted.filter(|g| *g > 0.0) {
                out.insert("grantedAt".into(), n(g));
            }
            out
        })
        .collect();
    let key = |c: &Row| c.get("expiresAt").and_then(Value::as_f64).unwrap_or(f64::INFINITY);
    credits.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(Ordering::Equal));
    let mut out = Map::new();
    out.insert("availableCount".into(), n(available_count.floor().max(0.0)));
    out.insert("offerRevision".into(), json!(offer_revision));
    out.insert("availableCredits".into(), Value::Array(credits.into_iter().map(Value::Object).collect()));
    if let Some(next) = next_expires_at.filter(|v| *v > 0.0) {
        out.insert("nextExpiresAt".into(), n(next));
    }
    Some(Value::Object(out))
}

/// A budget or balance figure: `remainingUsd` always, the others when stated.
#[derive(Clone, Debug, Default)]
pub struct Known {
    pub remaining_usd: Option<f64>,
    pub used_usd: Option<f64>,
    pub limit_usd: Option<f64>,
    pub source: String,
}

pub fn local_budget(provider: &Value) -> Option<Known> {
    let limit = nn(first(
        provider,
        &["limitUsd", "limit_usd", "budgetUsd", "budget_usd", "monthlyBudgetUsd", "monthly_budget_usd"],
    ));
    let used = nn(first(provider, &["usedUsd", "used_usd", "spendUsd", "spend_usd", "costUsd", "cost_usd"]));
    let remaining = nn(first(provider, &["remainingUsd", "remaining_usd", "leftUsd", "left_usd"]));
    if let Some(remaining) = remaining {
        return Some(Known {
            remaining_usd: Some(r(remaining, 4)),
            used_usd: used.map(|v| r(v, 4)),
            limit_usd: limit.map(|v| r(v, 4)),
            source: "local-budget".into(),
        });
    }
    if let (Some(limit), Some(used)) = (limit, used) {
        return Some(Known {
            remaining_usd: Some(r((limit - used).max(0.0), 4)),
            used_usd: Some(r(used, 4)),
            limit_usd: Some(r(limit, 4)),
            source: "local-budget".into(),
        });
    }
    let balance = provider.get("balance").filter(|b| truthy(Some(b)) && b.is_object())?;
    let remaining = nn(first(balance, &["remainingUsd", "remaining_usd", "balanceUsd", "balance_usd"]))?;
    let source = match clean(balance.get("source")) {
        s if !s.is_empty() => s,
        _ => "configured-balance".into(),
    };
    Some(Known { remaining_usd: Some(r(remaining, 4)), used_usd: None, limit_usd: None, source })
}

fn snapshot_source(snapshot: Option<&Value>, own: Option<&Value>) -> String {
    let first = clean(own);
    if !first.is_empty() {
        return first;
    }
    let second = clean(snapshot.and_then(|s| s.get("source")));
    if second.is_empty() { "provider-api".into() } else { second }
}

pub fn snapshot_remaining(snapshot: Option<&Value>) -> Option<Known> {
    let balance = snapshot.and_then(|s| s.get("balance"));
    let remaining = balance.and_then(|b| nn(first(b, &["remainingUsd", "remaining_usd"])));
    if let (Some(remaining), Some(balance)) = (remaining, balance) {
        let used = nn(first(balance, &["usedUsd", "used_usd"]));
        let limit = nn(first(balance, &["limitUsd", "limit_usd"]));
        return Some(Known {
            remaining_usd: Some(r(remaining, 4)),
            used_usd: used.map(|v| r(v, 4)),
            limit_usd: limit.map(|v| r(v, 4)),
            source: snapshot_source(snapshot, balance.get("source")),
        });
    }
    let source = snapshot_source(snapshot, None);
    let windows = normalise_windows(snapshot.and_then(|s| s.get("quotaWindows")), &source);
    let usd: Vec<&Value> = windows.iter().filter(|w| nn(w.get("remainingUsd")).is_some()).collect();
    if usd.len() == 1 {
        let own = clean(usd[0].get("source"));
        return Some(Known {
            remaining_usd: usd[0].get("remainingUsd").and_then(Value::as_f64),
            used_usd: None,
            limit_usd: None,
            source: if own.is_empty() { source } else { own },
        });
    }
    None
}

pub fn snapshot_usage(snapshot: Option<&Value>) -> Option<Known> {
    let balance = snapshot.and_then(|s| s.get("balance"))?;
    let used = nn(first(balance, &["usedUsd", "used_usd"]))?;
    let limit = nn(first(balance, &["limitUsd", "limit_usd"]));
    Some(Known {
        remaining_usd: None,
        used_usd: Some(r(used, 4)),
        limit_usd: limit.map(|v| r(v, 4)),
        source: snapshot_source(snapshot, balance.get("source")),
    })
}

pub struct TokenUsage {
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_input_tokens: f64,
    pub requests: f64,
    pub source: String,
}

pub fn snapshot_token_usage(snapshot: Option<&Value>) -> Option<TokenUsage> {
    let value = snapshot.and_then(|s| s.get("tokenUsage")).filter(|v| truthy(Some(v)) && v.is_object())?;
    let get = |keys: &[&str]| num_or(first(value, keys), Some(0.0)).unwrap_or(0.0);
    let input_tokens = get(&["inputTokens", "input_tokens"]);
    let output_tokens = get(&["outputTokens", "output_tokens"]);
    let cached_input_tokens = get(&["cachedInputTokens", "cached_input_tokens"]);
    let requests = get(&["requests", "numModelRequests", "num_model_requests"]);
    if input_tokens == 0.0 && output_tokens == 0.0 && cached_input_tokens == 0.0 && requests == 0.0 {
        return None;
    }
    let own = clean(value.get("source"));
    Some(TokenUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        requests,
        source: if own.is_empty() { snapshot_source(snapshot, None) } else { own },
    })
}

pub fn display_window(w: &Value) -> String {
    let label = match w.get("label") {
        Some(v) if truthy(Some(v)) => js_string(v),
        _ => "USE".into(),
    }
    .to_uppercase();
    let g = |k: &str| nn(w.get(k));
    if let Some(v) = g("remainingUsd") {
        return format!("{label} {}", money(v));
    }
    if let (Some(used), Some(limit)) = (g("usedUsd"), g("limitUsd")) {
        return format!("{label} {}/{}", money(used), money(limit));
    }
    if let (Some(rem), Some(limit)) = (g("remainingCredits"), g("limitCredits")) {
        return format!("{label} {}/{}", compact_number(rem), compact_number(limit));
    }
    if let Some(rem) = g("remainingCredits") {
        return format!("{label} {}", compact_number(rem));
    }
    if let (Some(used), Some(limit)) = (g("usedCredits"), g("limitCredits")) {
        return format!("{label} {}/{}", compact_number(used), compact_number(limit));
    }
    if let Some(pct) = g("usedPct") {
        return format!("{label} {}%", to_fixed(math_round(pct), 0));
    }
    label
}

fn provider_description(id: &str, group: &str) -> &'static str {
    match id.to_lowercase().as_str() {
        "openai-oauth" => "OpenAI OAuth subscription quota",
        "anthropic-oauth" => "Anthropic OAuth subscription quota",
        "grok-oauth" => "Grok Build subscription quota",
        "muse-code-oauth" => "Muse Code subscription quota",
        "command-code-oauth" => "Command Code subscription quota",
        "mimo-oauth" => "MiMo Token Plan subscription quota",
        "antigravity-oauth" => "Antigravity subscription quota",
        "opencode-go-oauth" => "OpenCode Go subscription quota",
        "openai" => "OpenAI API billing",
        "anthropic" => "Anthropic API billing",
        "deepseek" => "DeepSeek API billing",
        "gemini" => "Gemini API billing",
        "xai" => "xAI API billing",
        "mixdog-local" => "Mixdog Local Provider",
        _ if group == "local" => "Local provider",
        _ if group == "oauth" => "Subscription quota",
        _ => "API billing",
    }
}

fn snapshot_unavailable(snapshot: Option<&Value>) -> Option<&Value> {
    snapshot.and_then(|s| s.get("unavailable")).filter(|v| truthy(Some(v)) && v.is_object())
}

fn api_unavailable_detail(id: &str, snapshot: Option<&Value>) -> String {
    let provider = id.to_lowercase();
    let message = clean(snapshot_unavailable(snapshot).and_then(|u| u.get("message")));
    match provider.as_str() {
        "openai" => {
            if JsRegex::new_static("invalid|incorrect api key|unauthorized", "i").is_match(&message) {
                format!("OpenAI usage probe failed: {message}")
            } else if JsRegex::new_static(r"api\.usage\.read|insufficient permissions", "i").is_match(&message) {
                "OpenAI spend needs api.usage.read; remaining credit is web UI only".into()
            } else if !message.is_empty() {
                format!("OpenAI usage probe failed: {message}; remaining credit is web UI only")
            } else {
                "OpenAI API does not expose remaining credit; org spend needs api.usage.read".into()
            }
        }
        "anthropic" if !message.is_empty() => format!("Anthropic cost probe: {message}"),
        "anthropic" => "Anthropic balance is Console-only; usage needs ANTHROPIC_ADMIN_API_KEY".into(),
        "gemini" => "Gemini balance is AI Studio/Cloud Billing only; no key-scope probe".into(),
        "xai" if !message.is_empty() => message,
        "xai" => "xAI balance needs XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID".into(),
        "deepseek" if !message.is_empty() => format!("DeepSeek balance unavailable: {message}"),
        "deepseek" => "DeepSeek balance unavailable".into(),
        _ if !message.is_empty() => message,
        _ => "Usage not exposed".into(),
    }
}

fn set(row: &mut Row, key: &str, value: impl Into<Value>) {
    row.insert(key.into(), value.into());
}

fn text_of(row: &Row, key: &str) -> String {
    row.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

pub fn apply_api_unavailable(row: &mut Row, id: &str, snapshot: Option<&Value>) {
    set(row, "status", "hidden");
    set(
        row,
        "source",
        if snapshot_unavailable(snapshot).is_some() { "provider-api-unavailable" } else { "provider-hidden" },
    );
    set(row, "sourceLabel", "unavailable");
    set(row, "primary", "-");
    set(row, "detail", api_unavailable_detail(id, snapshot));
}

pub fn row_tone(row: &Row) -> &'static str {
    match row.get("status").and_then(Value::as_str) {
        Some("error") => return "error",
        Some("missing") => return "missing",
        Some("local") => return "local",
        _ => {}
    }
    if let Some(remaining) = nn(row.get("remainingUsd")) {
        return if remaining <= 1.0 {
            "danger"
        } else if remaining <= 5.0 {
            "warn"
        } else {
            "ok"
        };
    }
    let pct = row
        .get("windows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|w| num_or(w.get("usedPct"), Some(-1.0)).unwrap_or(-1.0))
        .fold(f64::NEG_INFINITY, f64::max);
    if pct >= 95.0 {
        return "danger";
    }
    if pct >= 80.0 {
        return "warn";
    }
    match row.get("status").and_then(Value::as_str) {
        Some("hidden" | "partial" | "estimated") => "warn",
        _ => "ok",
    }
}

pub fn base_row(item: &Value, group: &str, provider_cfg: &Value) -> Row {
    let id = item.get("id").cloned().unwrap_or(Value::Null);
    let id_text = id.as_str().unwrap_or("").to_owned();
    let label = match item.get("name") {
        Some(v) if truthy(Some(v)) => v.clone(),
        _ => id.clone(),
    };
    let kind = match item.get("type") {
        Some(v) if truthy(Some(v)) => v.clone(),
        _ => json!(group),
    };
    let mut row = Map::new();
    set(&mut row, "id", id);
    set(&mut row, "label", label);
    set(&mut row, "group", group);
    set(&mut row, "type", kind);
    set(&mut row, "enabled", item.get("enabled") == Some(&Value::Bool(true)));
    set(&mut row, "authenticated", item.get("authenticated") == Some(&Value::Bool(true)));
    set(&mut row, "remainingUsd", Value::Null);
    set(&mut row, "usedUsd", Value::Null);
    set(&mut row, "limitUsd", Value::Null);
    set(&mut row, "windows", json!([]));
    set(&mut row, "status", "hidden");
    set(&mut row, "source", "unavailable");
    set(&mut row, "sourceLabel", "unavailable");
    set(&mut row, "primary", "hidden");
    set(&mut row, "detail", "provider does not expose account balance");
    set(&mut row, "description", provider_description(&id_text, group));
    set(&mut row, "updatedAt", Value::Null);
    set(&mut row, "includeInTotal", false);
    set(&mut row, "totalBucket", Value::Null);
    set(&mut row, "config", provider_cfg.clone());
    row
}

fn provider_rank(row: &Row) -> f64 {
    match text_of(row, "id").to_lowercase().as_str() {
        "openai-oauth" => 10.0,
        "anthropic-oauth" => 20.0,
        "grok-oauth" => 30.0,
        "muse-code-oauth" => 33.0,
        "command-code-oauth" => 33.5,
        "mimo-oauth" => 34.0,
        "cursor-oauth" => 35.0,
        "devin-oauth" => 35.5,
        "antigravity-oauth" => 36.0,
        "opencode-go-oauth" => 38.0,
        "openai" => 50.0,
        "anthropic" => 60.0,
        "deepseek" => 70.0,
        "gemini" => 80.0,
        "xai" => 90.0,
        "mixdog-local" => 100.0,
        _ => 900.0,
    }
}

pub fn apply_known_remaining(row: &mut Row, known: &Known, estimated: bool) {
    let Some(remaining) = known.remaining_usd else { return };
    set(row, "remainingUsd", n(remaining));
    if let Some(used) = known.used_usd {
        set(row, "usedUsd", n(used));
    }
    if let Some(limit) = known.limit_usd {
        set(row, "limitUsd", n(limit));
    }
    set(row, "status", if estimated { "estimated" } else { "ok" });
    let source = if known.source.is_empty() {
        if estimated { "local-budget" } else { "provider-api" }.to_owned()
    } else {
        known.source.clone()
    };
    set(row, "source", source.clone());
    set(row, "sourceLabel", if estimated { "local budget" } else { "API" });
    set(row, "primary", money(remaining));
    let detail = match (nn(row.get("limitUsd")), nn(row.get("usedUsd"))) {
        (Some(limit), Some(used)) if !row["limitUsd"].is_null() && !row["usedUsd"].is_null() => {
            format!("{} / {} used", money(used), money(limit))
        }
        _ => source,
    };
    set(row, "detail", detail);
    set(row, "includeInTotal", true);
    set(row, "totalBucket", if estimated { "local" } else { "api" });
}

pub fn apply_known_usage(row: &mut Row, known: &Known) {
    let Some(used) = known.used_usd else { return };
    set(row, "usedUsd", n(used));
    if let Some(limit) = known.limit_usd {
        set(row, "limitUsd", n(limit));
    }
    set(row, "status", "partial");
    set(row, "source", if known.source.is_empty() { "provider-api".to_owned() } else { known.source.clone() });
    set(row, "sourceLabel", "usage");
    let primary = match row.get("limitUsd").filter(|v| !v.is_null()).and_then(Value::as_f64) {
        Some(limit) => format!("Used {}/{}", money(used), money(limit)),
        None => format!("Used {}", money(used)),
    };
    set(row, "primary", primary);
    set(row, "detail", "Spend reported; remaining credit unavailable");
    set(row, "includeInTotal", false);
    set(row, "totalBucket", Value::Null);
}

pub fn apply_token_usage(row: &mut Row, usage: &TokenUsage) {
    let total = usage.input_tokens + usage.output_tokens;
    set(row, "status", "partial");
    set(row, "source", if usage.source.is_empty() { "provider-api".to_owned() } else { usage.source.clone() });
    set(row, "sourceLabel", "usage");
    set(row, "primary", format!("{} tokens", compact_number(total)));
    let requests = if usage.requests != 0.0 { format!(" · {} req", compact_number(usage.requests)) } else { String::new() };
    set(
        row,
        "detail",
        format!("{} in · {} out{requests}", compact_number(usage.input_tokens), compact_number(usage.output_tokens)),
    );
    set(row, "includeInTotal", false);
    set(row, "totalBucket", Value::Null);
}

pub fn apply_window_quota(row: &mut Row, windows: &Value, source: &str, detail: &str) -> bool {
    let normalized = normalise_windows(Some(windows), source);
    if normalized.is_empty() {
        return false;
    }
    let local_estimate = normalized.iter().all(|w| {
        let s = w.get("source").and_then(Value::as_str).unwrap_or("").to_lowercase();
        s.is_empty() || s.contains("local") || s.contains("config")
    });
    let primary = normalized.iter().map(display_window).take(2).collect::<Vec<_>>().join(" · ");
    set(row, "windows", Value::Array(normalized));
    set(row, "status", if local_estimate { "estimated" } else { "partial" });
    set(row, "source", source);
    set(row, "sourceLabel", if local_estimate { "local estimate" } else { source });
    set(row, "primary", primary);
    set(row, "detail", if local_estimate { "Local estimate, not provider-reported" } else { detail });
    true
}

fn usage_total(rows: &[Row]) -> Value {
    let mut total = Map::new();
    for key in ["providerCount", "knownRemainingUsd", "apiVerifiedRemainingUsd", "localEstimatedRemainingUsd", "hiddenCount", "notConfiguredCount", "errorCount"] {
        total.insert(key.into(), n(0.0));
    }
    let (mut known, mut api, mut local) = (0.0, 0.0, 0.0);
    let bump = |total: &mut Map<String, Value>, key: &str| {
        let current = total.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        total.insert(key.into(), n(current + 1.0));
    };
    for row in rows {
        bump(&mut total, "providerCount");
        bump(&mut total, &format!("{}Count", text_of(row, "status")));
        if row.get("includeInTotal") == Some(&Value::Bool(true))
            && let Some(remaining) = nn(row.get("remainingUsd"))
        {
            known += remaining;
            if text_of(row, "totalBucket") == "api" {
                api += remaining;
            } else {
                local += remaining;
            }
        }
        if text_of(row, "status") == "missing" {
            bump(&mut total, "notConfiguredCount");
        }
    }
    total.insert("knownRemainingUsd".into(), n(r(known, 4)));
    total.insert("apiVerifiedRemainingUsd".into(), n(r(api, 4)));
    total.insert("localEstimatedRemainingUsd".into(), n(r(local, 4)));
    Value::Object(total)
}

/// Credit feature of a subscription provider; none unless the account has it enabled.
pub fn credits_from_snapshot(provider_id: &str, snapshot: Option<&Value>) -> Option<Value> {
    let balance = snapshot.and_then(|s| s.get("balance")).filter(|b| truthy(Some(b)));
    if provider_id == "openai-oauth" {
        let balance = balance?;
        if balance.get("unit").and_then(Value::as_str) != Some("credits") {
            return None;
        }
        let amount = nn(balance.get("remainingCredits"));
        let unlimited = balance.get("unlimited") == Some(&Value::Bool(true));
        if !(balance.get("hasCredits") == Some(&Value::Bool(true)) || unlimited || amount.is_some_and(|a| a > 0.0)) {
            return None;
        }
        let mut out = Map::new();
        out.insert("unit".into(), json!("credits"));
        out.insert("balance".into(), amount.map_or(Value::Null, n));
        if unlimited {
            out.insert("unlimited".into(), json!(true));
        }
        return Some(Value::Object(out));
    }
    if provider_id == "anthropic-oauth" {
        let extra = snapshot
            .and_then(|s| s.get("quotaWindows"))
            .and_then(Value::as_array)
            .and_then(|w| w.iter().find(|w| w.get("label").and_then(Value::as_str) == Some("EXTRA")));
        let spend = balance.filter(|b| nn(b.get("remainingUsd")).is_some());
        if extra.is_none() && spend.is_none() {
            return None;
        }
        let pick = |a: Option<&Value>, b: Option<&Value>| -> Option<f64> {
            match a.filter(|v| !v.is_null()) {
                Some(v) => nn(Some(v)),
                None => nn(b),
            }
        };
        let remaining = pick(spend.and_then(|s| s.get("remainingUsd")), extra.and_then(|e| e.get("remainingUsd")));
        let monthly = pick(spend.and_then(|s| s.get("budgetUsd")), extra.and_then(|e| e.get("limitUsd")));
        let spent = pick(spend.and_then(|s| s.get("spentUsd")), extra.and_then(|e| e.get("usedUsd")));
        let mut out = Map::new();
        out.insert("unit".into(), json!("usd"));
        let bal = remaining.or_else(|| match (monthly, spent) {
            (Some(m), Some(s)) => Some((m - s).max(0.0)),
            _ => None,
        });
        out.insert("balance".into(), bal.map_or(Value::Null, n));
        if let Some(m) = monthly {
            out.insert("monthlyLimit".into(), n(m));
        }
        if let Some(s) = spent {
            out.insert("spent".into(), n(s));
        }
        return Some(Value::Object(out));
    }
    None
}

/// `usageDashboardSnapshot(rows, { checkedAt, refresh, checking })`.
pub fn usage_dashboard_snapshot(rows: &[Row], checked_at: i64, refresh: bool, checking: bool) -> Value {
    let mut sorted: Vec<&Row> = rows.iter().collect();
    sorted.sort_by(|a, b| {
        provider_rank(a)
            .partial_cmp(&provider_rank(b))
            .unwrap_or(Ordering::Equal)
            .then_with(|| locale_compare(&label_text(a), &label_text(b)))
    });
    json!({
        "title": "Provider Quotas",
        "subtitle": "Statusline-style provider quota windows.",
        "checkedAt": checked_at,
        "refresh": refresh,
        "checking": checking,
        "total": usage_total(rows),
        "rows": sorted.into_iter().map(|r| Value::Object(r.clone())).collect::<Vec<_>>(),
        "format": {},
    })
}

fn label_text(row: &Row) -> String {
    row.get("label").map_or(String::new(), js_string)
}

/// The provider quota snapshots a dashboard reads (`oauth-usage.mjs`, `api-usage.mjs`).
#[async_trait]
pub trait UsageSources: Send + Sync {
    async fn cached_oauth(&self, provider: &str, allow_stale: bool) -> Option<Value>;
    /// Whether the registry holds a provider object for `provider`.
    fn oauth_provider_ready(&self, provider: &str) -> bool;
    async fn fetch_oauth(&self, provider: &str, force: bool) -> Result<Option<Value>, String>;
    fn cached_api(&self, provider: &str) -> Option<Value>;
    async fn fetch_api(&self, provider: &str, force: bool) -> Result<Option<Value>, String>;
}

async fn oauth_snapshot(sources: &dyn UsageSources, provider: &str, refresh: bool) -> Option<Value> {
    let cached = sources.cached_oauth(provider, false).await;
    if !refresh && cached.is_some() {
        return cached;
    }
    if sources.oauth_provider_ready(provider) {
        if let Ok(Some(fresh)) = sources.fetch_oauth(provider, refresh).await {
            return Some(fresh);
        }
    }
    match cached {
        Some(cached) => Some(cached),
        None => sources.cached_oauth(provider, true).await,
    }
}

async fn api_snapshot(sources: &dyn UsageSources, provider: &str, refresh: bool) -> Option<Value> {
    let cached = sources.cached_api(provider);
    if !refresh && cached.is_some() {
        return cached;
    }
    sources.fetch_api(provider, refresh).await.unwrap_or(cached)
}

/// A dashboard request: what `createUsageDashboard` reads of its options.
#[derive(Clone, Debug, Default)]
pub struct DashboardOptions {
    pub refresh: bool,
    pub refresh_providers: Option<Vec<String>>,
    pub preview: bool,
}

fn refresh_scope(options: &DashboardOptions) -> Option<HashSet<String>> {
    let requested = options.refresh_providers.as_ref().filter(|r| !r.is_empty())?;
    let ids: HashSet<String> = requested
        .iter()
        .take(16)
        .map(|v| mixdog_js::js_trim(v).to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();
    (!ids.is_empty()).then_some(ids)
}

async fn api_provider_row(
    item: &Value,
    providers: &Value,
    preview: bool,
    refresh: bool,
    sources: &dyn UsageSources,
) -> Row {
    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
    let provider_cfg = providers.get(id).cloned().unwrap_or_else(|| json!({}));
    let mut row = base_row(item, "api", &provider_cfg);
    let authenticated = row["authenticated"] == Value::Bool(true);
    set(&mut row, "status", if authenticated { "checking" } else { "missing" });
    set(&mut row, "source", if authenticated { "checking" } else { "not-configured" });
    set(&mut row, "sourceLabel", if authenticated { "checking" } else { "no key" });
    set(&mut row, "primary", if authenticated { "" } else { "not configured" });
    set(&mut row, "detail", if authenticated { "Checking provider usage" } else { "Configure auth" });
    let tone = row_tone(&row);
    set(&mut row, "tone", tone);
    if preview {
        return row;
    }
    if authenticated {
        let mut has_quota = false;
        let snapshot = api_snapshot(sources, id, refresh).await;
        let snapshot = snapshot.as_ref();
        let known = snapshot_remaining(snapshot);
        let usage = snapshot_usage(snapshot);
        let token_usage = snapshot_token_usage(snapshot);
        let source = snapshot_source(snapshot, None);
        let windows = snapshot.and_then(|s| s.get("quotaWindows")).filter(|w| !w.is_null());
        let normalised = normalise_windows(windows, &source);
        let estimated = local_budget(&provider_cfg);
        set(&mut row, "updatedAt", num_or(snapshot.and_then(|s| s.get("cachedAt")), None).map_or(Value::Null, n));
        if let Some(known) = &known {
            apply_known_remaining(&mut row, known, false);
            set(&mut row, "sourceLabel", "API");
            has_quota = true;
        } else if !normalised.is_empty() {
            has_quota = apply_window_quota(&mut row, windows.unwrap_or(&Value::Null), &source, "provider quota");
        } else if let Some(estimated) = &estimated {
            apply_known_remaining(&mut row, estimated, true);
            has_quota = true;
        } else if let Some(usage) = &usage {
            apply_known_usage(&mut row, usage);
            has_quota = true;
        } else if let Some(tokens) = &token_usage {
            apply_token_usage(&mut row, tokens);
            has_quota = true;
        }
        if row["includeInTotal"] != Value::Bool(true) && !has_quota {
            if let Some(estimated) = local_budget(&provider_cfg) {
                apply_known_remaining(&mut row, &estimated, true);
                has_quota = true;
            }
        }
        if row["includeInTotal"] != Value::Bool(true) && !has_quota {
            apply_api_unavailable(&mut row, id, snapshot);
        }
    }
    let tone = row_tone(&row);
    set(&mut row, "tone", tone);
    row
}

async fn oauth_provider_row(
    item: &Value,
    providers: &Value,
    preview: bool,
    refresh: bool,
    sources: &dyn UsageSources,
    accounts: &AccountStore,
) -> Row {
    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
    let provider_cfg = providers.get(id).cloned().unwrap_or_else(|| json!({}));
    let mut row = base_row(item, "oauth", &provider_cfg);
    let authenticated = row["authenticated"] == Value::Bool(true);
    set(&mut row, "status", if authenticated { "checking" } else { "missing" });
    set(&mut row, "source", if authenticated { "checking" } else { "not-configured" });
    set(&mut row, "sourceLabel", if authenticated { "checking" } else { "not signed in" });
    set(&mut row, "primary", if authenticated { "" } else { "not signed in" });
    let detail = if authenticated {
        "Checking provider usage".to_owned()
    } else {
        match item.get("detail") {
            Some(v) if truthy(Some(v)) => js_string(v),
            _ => "OAuth credentials missing".to_owned(),
        }
    };
    set(&mut row, "detail", detail);
    let tone = row_tone(&row);
    set(&mut row, "tone", tone);
    if id == "openai-oauth" || id == "anthropic-oauth" {
        let uses = accounts.pool(id).await.map(|p| p.uses_credits()).unwrap_or(false);
        set(&mut row, "useCredits", uses);
    }
    if preview {
        return row;
    }
    if authenticated {
        let snapshot = oauth_snapshot(sources, id, refresh).await;
        let snapshot = snapshot.as_ref();
        let known = snapshot_remaining(snapshot);
        let source = snapshot_source(snapshot, None);
        let windows = normalise_windows(snapshot.and_then(|s| s.get("quotaWindows")), &source);
        let reset_credits = normalise_reset_credits(snapshot.and_then(|s| s.get("resetCredits")));
        set(&mut row, "windows", Value::Array(windows.clone()));
        if let Some(reset) = reset_credits {
            set(&mut row, "resetCredits", reset);
        }
        if let Some(credits) = credits_from_snapshot(id, snapshot) {
            set(&mut row, "credits", credits);
        }
        set(&mut row, "updatedAt", num_or(snapshot.and_then(|s| s.get("cachedAt")), None).map_or(Value::Null, n));
        if let Some(known) = &known {
            apply_known_remaining(&mut row, known, false);
            set(&mut row, "sourceLabel", "API");
            if !windows.is_empty() {
                set(&mut row, "detail", "subscription quota");
            }
        } else if !windows.is_empty() {
            set(&mut row, "status", "partial");
            set(&mut row, "source", source);
            set(&mut row, "sourceLabel", "API window");
            set(&mut row, "primary", windows.iter().map(display_window).take(2).collect::<Vec<_>>().join(" · "));
            set(&mut row, "detail", "subscription quota");
        } else {
            set(&mut row, "status", "hidden");
            set(&mut row, "source", "usage-disabled");
            set(&mut row, "sourceLabel", "disabled");
            set(&mut row, "primary", "");
            set(&mut row, "detail", "No current usage query result");
        }
    }
    let tone = row_tone(&row);
    set(&mut row, "tone", tone);
    row
}

/// `createUsageDashboard(config, { setup, refresh, refreshProviders, preview })`.
pub async fn create_usage_dashboard(
    config: &Value,
    setup: &Value,
    options: &DashboardOptions,
    checked_at: i64,
    sources: &dyn UsageSources,
    accounts: &AccountStore,
) -> Value {
    let providers = config.get("providers").cloned().filter(|p| truthy(Some(p))).unwrap_or_else(|| json!({}));
    let scope = if options.refresh { refresh_scope(options) } else { None };
    let refresh_for = |id: &str| options.refresh && scope.as_ref().is_none_or(|s| s.contains(&id.to_lowercase()));
    let list = |key: &str| setup.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let (api, oauth) = (list("api"), list("oauth"));
    let api_rows = futures::future::join_all(api.iter().map(|item| {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        api_provider_row(item, &providers, options.preview, refresh_for(id), sources)
    }));
    let oauth_rows = futures::future::join_all(oauth.iter().map(|item| {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        oauth_provider_row(item, &providers, options.preview, refresh_for(id), sources, accounts)
    }));
    let (api_rows, oauth_rows) = futures::join!(api_rows, oauth_rows);
    let rows: Vec<Row> = api_rows.into_iter().chain(oauth_rows).collect();
    usage_dashboard_snapshot(&rows, checked_at, options.refresh, options.preview)
}
