//! Plan-usage payload normalizers (`providers/oauth-usage.mjs`): a provider's
//! usage JSON in, the snapshot `{provider, source, quotaWindows, balance, ...}`
//! out. Pure: the clock is a parameter. Key order is Node's insertion order,
//! so serialized snapshots equal Node's.

use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

pub type Obj = Map<String, Value>;

// -- JS primitives (`lib/usage-primitives.mjs`) -------------------------------

/// The first present, non-null value (`a ?? b ?? c`).
pub fn first<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k).filter(|x| !x.is_null()))
}

/// JS truthiness of an optional value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a || b`: the first truthy value.
pub fn or_truthy<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k).filter(|x| truthy(Some(x))))
}

/// `num(value, fallback)`: null/undefined/'' take the fallback, else `Number()`
/// when finite.
pub fn num(v: Option<&Value>, fallback: Option<f64>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => return fallback,
        Some(Value::String(s)) if s.is_empty() => return fallback,
        _ => {}
    }
    Some(mixdog_js::to_number_of(v)).filter(|f| f.is_finite()).or(fallback)
}

pub fn num_or(v: Option<&Value>, fallback: f64) -> f64 {
    num(v, Some(fallback)).unwrap_or(fallback)
}

/// `round(value, digits)`: JS `Math.round` (half toward +inf) at `digits`.
pub fn round(value: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    (value * scale + 0.5).floor() / scale
}

pub use mixdog_js::json_number as jn;

/// `cleanString`: a trimmed non-empty string, else None.
pub fn clean(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn opt_str(s: Option<String>) -> Value {
    s.map_or(Value::Null, Value::String)
}

/// A reset moment as epoch ms: a `Date.parse`-able string, epoch seconds or ms, else
/// `now + fallback_seconds`.
pub fn reset_at_ms(value: Option<&Value>, fallback_seconds: Option<&Value>, now_ms: i64) -> Option<f64> {
    if let Some(Value::String(s)) = value {
        let ms = mixdog_js::time::date_parse(s);
        if ms.is_finite() {
            return Some(ms);
        }
    }
    let n = num_or(value, 0.0);
    if n > 0.0 {
        return Some(if n < 10_000_000_000.0 { n * 1000.0 } else { n });
    }
    let secs = num_or(fallback_seconds, 0.0);
    (secs > 0.0).then(|| now_ms as f64 + secs * 1000.0)
}

fn label_for_duration(seconds: f64, fallback: &str) -> String {
    let s = seconds;
    if s > 0.0 {
        if (s - 5.0 * 3600.0).abs() <= 120.0 {
            return "5H".into();
        }
        if (s - 7.0 * 86400.0).abs() <= 3600.0 {
            return "7D".into();
        }
        if (s - 86400.0).abs() <= 600.0 {
            return "24H".into();
        }
        if (28.0 * 86400.0..=31.0 * 86400.0).contains(&s) {
            return "M".into();
        }
    }
    fallback.to_owned()
}

/// One quota window from a provider's percent-shaped entry; None when it
/// states nothing beyond label and source.
pub fn window_from_percent(label: &str, value: Option<&Value>, source: &str, now_ms: i64) -> Option<Value> {
    let empty = Value::Object(Obj::new());
    let entry = match value {
        Some(v @ (Value::Object(_) | Value::Array(_))) => v,
        _ => &empty,
    };
    let window_seconds = num_or(first(entry, &["limit_window_seconds", "window_seconds", "windowSeconds"]), 0.0);
    let window_minutes = num_or(first(entry, &["window_minutes", "windowMinutes"]), 0.0);
    let used_pct = num(first(entry, &["usedPct", "used_percent", "used_percentage", "utilization", "percent"]), None);
    let limit_usd = num(first(entry, &["limitUsd", "limit_usd", "limit_dollars", "monthly_limit"]), None);
    let used_usd = num(first(entry, &["usedUsd", "used_usd", "used_dollars", "used_credits"]), None);
    let remaining_usd = num(first(entry, &["remainingUsd", "remaining_usd", "remaining_dollars"]), None);
    let reset_at = reset_at_ms(
        first(entry, &["resetAt", "resetsAt", "reset_at", "resets_at"]),
        entry.get("reset_after_seconds"),
        now_ms,
    );
    let seconds = if window_seconds != 0.0 { window_seconds } else { window_minutes * 60.0 };
    let mut out = Obj::new();
    out.insert("label".into(), Value::String(label_for_duration(seconds, label)));
    out.insert("source".into(), Value::String(source.into()));
    if let Some(p) = used_pct {
        out.insert("usedPct".into(), jn(round(p, 2)));
    }
    if let Some(p) = limit_usd {
        out.insert("limitUsd".into(), jn(round(p, 4)));
    }
    if let Some(p) = used_usd {
        out.insert("usedUsd".into(), jn(round(p, 4)));
    }
    if let Some(p) = remaining_usd {
        out.insert("remainingUsd".into(), jn(round(p, 4)));
    }
    if let Some(r) = reset_at.filter(|r| *r != 0.0) {
        out.insert("resetAt".into(), jn(r));
    }
    (out.len() > 2).then_some(Value::Object(out))
}

fn sorted_keys(data: &Value) -> Value {
    let mut keys: Vec<String> = data.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    keys.sort();
    Value::Array(keys.into_iter().map(Value::String).collect())
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

// -- Codex ----------------------------------------------------------------------

fn balance_from_credits(credits: Option<&Value>, source: &str) -> Value {
    let Some(c @ Value::Object(_)) = credits else { return Value::Null };
    let Some(balance) = num(first(c, &["balance", "remaining", "remaining_dollars"]), None) else {
        return Value::Null;
    };
    obj(vec![
        ("source", source.into()),
        ("unit", "credits".into()),
        ("remainingCredits", jn(round(balance, 4))),
        ("unlimited", Value::Bool(c.get("unlimited") == Some(&Value::Bool(true)))),
        ("hasCredits", Value::Bool(c.get("has_credits") == Some(&Value::Bool(true)))),
    ])
}

fn codex_limit_id(v: Option<&Value>) -> String {
    clean(v).unwrap_or_default().to_lowercase().replace('-', "_")
}

/// Model-specific limits beside the plan's own: `(model, windows)` each.
fn codex_additional_limits(list: Option<&Value>, now_ms: i64) -> Vec<(String, Vec<Value>)> {
    let Some(Value::Array(list)) = list else { return Vec::new() };
    let mut out = Vec::new();
    for entry in list {
        let limit = codex_limit_id(or_truthy(entry, &["metered_feature", "limit_name"]));
        if limit.is_empty() {
            continue;
        }
        let name = clean(entry.get("limit_name")).unwrap_or_else(|| limit.clone());
        let empty = Value::Object(Obj::new());
        let rate = entry.get("rate_limit").filter(|r| r.is_object()).unwrap_or(&empty);
        let windows: Vec<Value> = [
            window_from_percent("5H", or_truthy(rate, &["primary_window", "primary"]), "openai-codex-oauth", now_ms),
            window_from_percent("7D", or_truthy(rate, &["secondary_window", "secondary"]), "openai-codex-oauth", now_ms),
        ]
        .into_iter()
        .flatten()
        .map(|w| {
            let mut o = w.as_object().cloned().unwrap_or_default();
            let label = format!("{} {}", o.get("label").and_then(Value::as_str).unwrap_or(""), name);
            o.insert("label".into(), Value::String(label));
            o.insert("limit".into(), Value::String(limit.clone()));
            o.insert("models".into(), Value::Array(vec![Value::String(name.to_lowercase())]));
            Value::Object(o)
        })
        .collect();
        if !windows.is_empty() {
            out.push((name.to_lowercase(), windows));
        }
    }
    out
}

/// `/wham/usage` of the Codex backend.
pub fn normalize_openai_wham_usage(data: &Value, now_ms: i64) -> Option<Value> {
    let rate = data.get("rate_limit").filter(|r| r.is_object())?;
    let additional = codex_additional_limits(data.get("additional_rate_limits"), now_ms);
    let mut windows: Vec<Value> = [
        window_from_percent("5H", or_truthy(rate, &["primary_window", "primary"]), "openai-codex-oauth", now_ms),
        window_from_percent("7D", or_truthy(rate, &["secondary_window", "secondary"]), "openai-codex-oauth", now_ms),
    ]
    .into_iter()
    .flatten()
    .map(|w| {
        let mut o = w.as_object().cloned().unwrap_or_default();
        o.insert("limit".into(), Value::String("codex".into()));
        if !additional.is_empty() {
            o.insert("except".into(), Value::Array(additional.iter().map(|(m, _)| Value::String(m.clone())).collect()));
        }
        Value::Object(o)
    })
    .collect();
    if windows.is_empty() {
        return None;
    }
    windows.extend(additional.into_iter().flat_map(|(_, w)| w));
    Some(obj(vec![
        ("provider", "openai-oauth".into()),
        ("source", "openai-codex-wham".into()),
        ("planType", opt_str(clean(data.get("plan_type")))),
        ("quotaWindows", Value::Array(windows)),
        ("balance", balance_from_credits(data.get("credits"), "openai-codex-credits")),
        ("rawKeys", sorted_keys(data)),
    ]))
}

/// A `rate_limits` object (Codex local files, Grok generic probes).
pub fn normalize_codex_rate_limits(rate_limits: Option<&Value>, source: &str, now_ms: i64) -> Option<Value> {
    let r = rate_limits.filter(|r| r.is_object())?;
    let windows: Vec<Value> = [
        window_from_percent("5H", or_truthy(r, &["primary", "five_hour"]), source, now_ms),
        window_from_percent("7D", or_truthy(r, &["secondary", "seven_day"]), source, now_ms),
    ]
    .into_iter()
    .flatten()
    .collect();
    if windows.is_empty() {
        return None;
    }
    Some(obj(vec![
        ("provider", "openai-oauth".into()),
        ("source", source.into()),
        ("planType", opt_str(clean(r.get("plan_type")))),
        ("quotaWindows", Value::Array(windows)),
        ("balance", balance_from_credits(r.get("credits"), &format!("{source}-credits"))),
    ]))
}

fn reset_credit_rows(value: Option<&Value>, now_ms: i64) -> Vec<(String, Option<f64>, Option<f64>)> {
    let Some(Value::Array(rows)) = value else { return Vec::new() };
    rows.iter()
        .map(|c| {
            (
                clean(c.get("status")).unwrap_or_default().to_lowercase(),
                reset_at_ms(first(c, &["expires_at", "expiresAt"]), None, now_ms),
                reset_at_ms(first(c, &["granted_at", "grantedAt"]), None, now_ms),
            )
        })
        .collect()
}

/// The Codex reset-credit offer (detail endpoint or the counts embedded in
/// `/wham/usage`).
pub fn normalize_codex_reset_credits(data: Option<&Value>, account_id: &str, now_ms: i64) -> Option<Value> {
    let data = data.filter(|d| d.is_object())?;
    let credits = reset_credit_rows(data.get("credits"), now_ms);
    let explicit = num(first(data, &["available_count", "availableCount"]), None);
    let available: Vec<_> = credits.iter().filter(|c| c.0 == "available").collect();
    if explicit.is_none() && credits.is_empty() {
        return None;
    }
    let available_count = explicit.unwrap_or(available.len() as f64).floor().max(0.0);
    let mut list: Vec<(Option<f64>, Option<f64>)> = available
        .iter()
        .map(|c| (c.1.filter(|v| *v > 0.0), c.2.filter(|v| *v > 0.0)))
        .collect();
    list.sort_by(|a, b| {
        a.0.unwrap_or(f64::INFINITY).partial_cmp(&b.0.unwrap_or(f64::INFINITY)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let expiries: Vec<f64> = available.iter().filter_map(|c| c.1).filter(|v| *v > 0.0).collect();
    let next_expires_at = reset_at_ms(first(data, &["next_expires_at", "nextExpiresAt"]), None, now_ms)
        .filter(|v| *v != 0.0)
        .or_else(|| expiries.iter().copied().reduce(f64::min));
    // The offer's identity is count + soonest expiry, so the detail endpoint
    // and the embedded counts give one revision.
    let identity = obj(vec![
        ("accountId", account_id.into()),
        ("availableCount", jn(available_count)),
        ("nextExpiresAt", next_expires_at.map_or(Value::Null, jn)),
    ]);
    let digest = Sha256::digest(identity.to_string().as_bytes());
    let revision = format!("v1:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let mut out = Obj::new();
    out.insert("availableCount".into(), jn(available_count));
    out.insert(
        "availableCredits".into(),
        Value::Array(
            list.into_iter()
                .map(|(e, g)| {
                    let mut o = Obj::new();
                    if let Some(e) = e {
                        o.insert("expiresAt".into(), jn(e));
                    }
                    if let Some(g) = g {
                        o.insert("grantedAt".into(), jn(g));
                    }
                    Value::Object(o)
                })
                .collect(),
        ),
    );
    if let Some(n) = next_expires_at {
        out.insert("nextExpiresAt".into(), jn(n));
    }
    out.insert("offerRevision".into(), Value::String(revision));
    Some(Value::Object(out))
}

// -- Anthropic ------------------------------------------------------------------

fn money_value(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(v @ Value::Object(_)) => num(v.get("amount_minor"), None)
            .map(|minor| minor / 10f64.powf(num_or(v.get("exponent"), 2.0))),
        other => num(other, None),
    }
}

fn minor_to_units(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    num(v.get("amount_minor"), None).map(|m| m / 10f64.powf(num_or(v.get("exponent"), 2.0)))
}

fn balance_from_anthropic_spend(spend: Option<&Value>) -> Value {
    let Some(spend @ Value::Object(_)) = spend else { return Value::Null };
    let used_currency = spend.get("used").and_then(|u| u.get("currency")).filter(|c| !c.is_null());
    let currency = clean(used_currency.or_else(|| spend.get("limit").and_then(|l| l.get("currency"))))
        .unwrap_or_else(|| "USD".into());
    let result = |remaining: f64, spent: f64| {
        obj(vec![
            ("source", "anthropic-oauth-spend".into()),
            ("remainingUsd", jn(round(remaining, 4))),
            ("spentUsd", jn(round(spent, 4))),
            ("currency", currency.clone().into()),
        ])
    };
    if let Some(direct) = money_value(spend.get("balance")) {
        return result(direct, minor_to_units(spend.get("used")).unwrap_or(0.0));
    }
    let used = minor_to_units(spend.get("used"));
    let cap = spend.get("cap").and_then(|c| c.get("credits"));
    if let (Some(cap_units), Some(used)) = (minor_to_units(cap), used) {
        return result((cap_units - used).max(0.0), used);
    }
    let limit = spend.get("limit");
    if let (Some(lim), Some(used)) = (minor_to_units(limit), used) {
        if num(limit.and_then(|l| l.get("amount_minor")), None).is_some_and(|m| m > 0.0) {
            return result((lim - used).max(0.0), used);
        }
    }
    Value::Null
}

fn balance_from_extra_usage(extra: Option<&Value>) -> Value {
    let Some(extra @ Value::Object(_)) = extra else { return Value::Null };
    let Some(limit_cents) = num(extra.get("monthly_limit"), None) else { return Value::Null };
    let limit = limit_cents / 100.0;
    let used = num_or(extra.get("used_credits"), 0.0) / 100.0;
    obj(vec![
        ("source", "anthropic-oauth-extra".into()),
        ("period", "monthly".into()),
        ("budgetUsd", jn(round(limit, 4))),
        ("spentUsd", jn(round(used, 4))),
        ("remainingUsd", jn(round((limit - used).max(0.0), 4))),
        ("currency", clean(extra.get("currency")).unwrap_or_else(|| "USD".into()).into()),
    ])
}

fn limit_window_label(limit: &Value) -> String {
    let kind = limit.get("kind").and_then(Value::as_str);
    let group = limit.get("group").and_then(Value::as_str);
    if kind == Some("session") || group == Some("session") {
        return "5H".into();
    }
    if kind == Some("weekly_all") || group == Some("weekly") {
        return "7D".into();
    }
    or_truthy(limit, &["kind", "group"]).and_then(Value::as_str).unwrap_or("USE").to_uppercase()
}

fn scoped_window_label(name: &str) -> String {
    let text = name.replace('_', " ");
    let text = text.trim();
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => format!("7D {}{}", c.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

/// Model- and surface-scoped weekly windows: a refusal of one family must not
/// mark the whole account exhausted.
fn scoped_anthropic_windows(data: &Value, source: &str, now_ms: i64) -> Vec<Value> {
    let mut by_label: Vec<(String, Value)> = Vec::new();
    let mut put = |label: String, window: Value| {
        if let Some(slot) = by_label.iter_mut().find(|(l, _)| *l == label) {
            slot.1 = window;
        } else {
            by_label.push((label, window));
        }
    };
    if let Some(o) = data.as_object() {
        for (key, value) in o {
            let Some(rest) = key.strip_prefix("seven_day_").filter(|r| !r.is_empty()) else { continue };
            let label = scoped_window_label(rest);
            if label.is_empty() {
                continue;
            }
            if let Some(w) = window_from_percent(&label, Some(value), source, now_ms) {
                put(label, w);
            }
        }
    }
    if let Some(Value::Array(limits)) = data.get("limits") {
        for entry in limits.iter().filter(|e| truthy(Some(e))) {
            let scope = entry.get("scope");
            let scoped = scope.and_then(|s| or_truthy(s, &["model", "surface"]));
            let name = scoped.and_then(|s| or_truthy(s, &["display_name", "id"])).and_then(Value::as_str);
            let label = scoped_window_label(name.unwrap_or(""));
            if label.is_empty() {
                continue;
            }
            let pct = obj(vec![
                ("percent", entry.get("percent").cloned().unwrap_or(Value::Null)),
                ("resets_at", entry.get("resets_at").cloned().unwrap_or(Value::Null)),
            ]);
            if let Some(w) = window_from_percent(&label, Some(&pct), source, now_ms) {
                put(label, w);
            }
        }
    }
    by_label.into_iter().map(|(_, w)| w).collect()
}

fn anthropic_extra_usage_window(extra: Option<&Value>, now_ms: i64) -> Option<Value> {
    let extra = extra.filter(|e| e.get("is_enabled") == Some(&Value::Bool(true)))?;
    let limit_usd = num_or(extra.get("monthly_limit"), 0.0) / 100.0;
    let used_usd = num_or(extra.get("used_credits"), 0.0) / 100.0;
    let entry = obj(vec![
        ("utilization", extra.get("utilization").cloned().unwrap_or(Value::Null)),
        ("limit_dollars", jn(limit_usd)),
        ("used_dollars", jn(used_usd)),
        ("remaining_dollars", jn((limit_usd - used_usd).max(0.0))),
    ]);
    let mut w = window_from_percent("EXTRA", Some(&entry), "anthropic-oauth-extra", now_ms)?
        .as_object()
        .cloned()
        .unwrap_or_default();
    w.insert("models".into(), Value::Array(Vec::new()));
    Some(Value::Object(w))
}

/// `api.anthropic.com/api/oauth/usage` (also the generic Grok probe shape).
pub fn normalize_anthropic_usage(data: &Value, source: &str, now_ms: i64) -> Option<Value> {
    if !data.is_object() {
        return None;
    }
    let mut windows: Vec<Value> = [
        window_from_percent("5H", data.get("five_hour"), source, now_ms),
        window_from_percent("7D", data.get("seven_day"), source, now_ms),
    ]
    .into_iter()
    .flatten()
    .collect();
    if windows.is_empty() {
        if let Some(Value::Array(limits)) = data.get("limits") {
            windows = limits
                .iter()
                .filter(|x| truthy(Some(x)))
                .filter(|x| !truthy(x.get("scope").and_then(|s| s.get("model"))) && !truthy(x.get("scope").and_then(|s| s.get("surface"))))
                .filter_map(|x| {
                    let pct = obj(vec![
                        ("percent", x.get("percent").cloned().unwrap_or(Value::Null)),
                        ("resets_at", x.get("resets_at").cloned().unwrap_or(Value::Null)),
                    ]);
                    window_from_percent(&limit_window_label(x), Some(&pct), source, now_ms)
                })
                .collect();
        }
    }
    windows.extend(scoped_anthropic_windows(data, source, now_ms));
    windows.extend(anthropic_extra_usage_window(data.get("extra_usage"), now_ms));
    if windows.is_empty() && !truthy(data.get("extra_usage")) {
        return None;
    }
    let spend = balance_from_anthropic_spend(data.get("spend"));
    let balance = if spend.is_null() { balance_from_extra_usage(data.get("extra_usage")) } else { spend };
    Some(obj(vec![
        ("provider", "anthropic-oauth".into()),
        ("source", source.into()),
        ("quotaWindows", Value::Array(windows)),
        ("balance", balance),
        ("rawKeys", sorted_keys(data)),
    ]))
}

// -- Grok Build billing ---------------------------------------------------------

/// `(label, period)` of the billing cadence; `None` where Node's `grokBillingCadence` throws.
///
/// Node reads the period type as `cleanString(currentPeriod?.type ?? current_period?.type ?? '')` and
/// calls `.toUpperCase()` on the result, which is `null` for an absent, blank or non-string type: the
/// call throws, and `probeGrokBilling` skips that answer for the next candidate. So an answer that
/// names no period type never yields a window, whatever else it holds.
pub fn grok_billing_cadence(config: &Value, now_ms: i64) -> Option<(&'static str, &'static str)> {
    let kind = ["currentPeriod", "current_period"].iter().find_map(|key| config.get(*key).and_then(|p| p.get("type")).filter(|t| !t.is_null()));
    let kind = clean(kind)?.to_uppercase();
    if kind.contains("WEEKLY") {
        return Some(("W", "weekly"));
    }
    if kind.contains("MONTHLY") {
        return Some(("M", "monthly"));
    }
    if first(config, &["weeklyLimit", "weekly_limit"]).is_some() {
        return Some(("W", "weekly"));
    }
    let start = reset_at_ms(first(config, &["billingPeriodStart", "billing_period_start"]), None, now_ms);
    let end = reset_at_ms(first(config, &["billingPeriodEnd", "billing_period_end"]), None, now_ms);
    if let (Some(s), Some(e)) = (start, end) {
        if e > s && e - s <= 10.0 * 86_400_000.0 {
            return Some(("W", "weekly"));
        }
    }
    Some(("M", "monthly"))
}

/// `{val}` or a plain number.
fn val(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(o @ Value::Object(_)) => o.get("val").filter(|x| !x.is_null()),
        other => other.filter(|x| !x.is_null()),
    }
}

fn val_chain<'a>(v: Option<&'a Value>) -> Option<&'a Value> {
    v.filter(|x| !x.is_null())
}

/// The credit window of a Grok billing config.
pub fn credit_window_from_billing(config: &Value, now_ms: i64) -> Option<Value> {
    if !config.is_object() {
        return None;
    }
    let (label, _) = grok_billing_cadence(config, now_ms)?;
    let current = or_truthy(config, &["currentPeriod", "current_period"]);
    let end = current
        .and_then(|c| c.get("end"))
        .filter(|x| !x.is_null())
        .or_else(|| first(config, &["billingPeriodEnd", "billing_period_end"]));
    let reset_at = reset_at_ms(end, None, now_ms);
    // `weeklyLimit?.val ?? weeklyLimit ?? monthlyLimit?.val ?? monthlyLimit ?? includedLimit?.val`
    let limit = num(
        val_chain(config.get("weeklyLimit").and_then(|w| w.get("val")))
            .or_else(|| val_chain(config.get("weeklyLimit")))
            .or_else(|| val_chain(config.get("monthlyLimit").and_then(|w| w.get("val"))))
            .or_else(|| val_chain(config.get("monthlyLimit")))
            .or_else(|| val_chain(config.get("includedLimit").and_then(|w| w.get("val")))),
        None,
    );
    let used = num(
        val_chain(config.get("used").and_then(|w| w.get("val")))
            .or_else(|| val_chain(config.get("includedUsed").and_then(|w| w.get("val"))))
            .or_else(|| val_chain(config.get("used"))),
        None,
    );
    let (limit, used) = match (limit, used) {
        (Some(l), Some(u)) if l > 0.0 => (l, u),
        _ => {
            let unified = config.get("isUnifiedBillingUser") == Some(&Value::Bool(true))
                || config.get("is_unified_billing_user") == Some(&Value::Bool(true))
                || truthy(config.get("currentPeriod"))
                || truthy(config.get("current_period"));
            if !unified {
                return None;
            }
            let pct = num_or(
                val_chain(config.get("creditUsagePercent").and_then(|w| w.get("val")))
                    .or_else(|| val_chain(config.get("creditUsagePercent")))
                    .or_else(|| val_chain(config.get("credit_usage_percent"))),
                0.0,
            );
            let mut o = Obj::new();
            o.insert("label".into(), label.into());
            o.insert("source".into(), "grok-build-billing".into());
            o.insert("usedPct".into(), jn(round(pct.clamp(0.0, 100.0), 2)));
            if let Some(r) = reset_at.filter(|r| *r != 0.0) {
                o.insert("resetAt".into(), jn(r));
            }
            return Some(Value::Object(o));
        }
    };
    let mut o = Obj::new();
    o.insert("label".into(), label.into());
    o.insert("source".into(), "grok-build-billing".into());
    o.insert("usedPct".into(), jn(round((used * 100.0 / limit).min(100.0), 2)));
    o.insert("usedCredits".into(), jn(round(used, 2)));
    o.insert("limitCredits".into(), jn(round(limit, 2)));
    o.insert("remainingCredits".into(), jn(round((limit - used).max(0.0), 2)));
    if let Some(r) = reset_at.filter(|r| *r != 0.0) {
        o.insert("resetAt".into(), jn(r));
    }
    Some(Value::Object(o))
}

/// The on-demand spending cap of a Grok billing config.
pub fn balance_from_grok_billing(config: &Value, now_ms: i64) -> Value {
    if !config.is_object() {
        return Value::Null;
    }
    let cap = num(val(config.get("onDemandCap")), None);
    let used = num_or(val(config.get("onDemandUsed")), 0.0);
    // Only reached once the credit window exists, which needs a period type.
    match (cap, grok_billing_cadence(config, now_ms)) {
        (Some(cap), Some((_, period))) if cap > 0.0 => obj(vec![
            ("source", "grok-build-on-demand".into()),
            ("period", period.into()),
            ("budgetCredits", jn(round(cap, 2))),
            ("spentCredits", jn(round(used, 2))),
            ("remainingCredits", jn(round((cap - used).max(0.0), 2))),
        ]),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests;