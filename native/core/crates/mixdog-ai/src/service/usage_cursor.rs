//! `CursorProviderBase.getUsageSnapshot()` (`providers/cursor.mjs`, `cursor-wire-models.mjs`
//! `getCursorUsage`, `cursor-wire-normalization.mjs` `normalizeCursorUsage`): the plan usage of a
//! Cursor account, read from the dashboard service with two unary Connect calls.
//!
//! The answers are decoded as Node's schema codec decodes them (not the lenient field iteration of
//! the model catalog): any wire type is read by the field's own type, and what Node throws on a
//! malformed answer is thrown here with the same text. One difference that cannot be observed on a
//! well-formed answer: Node's `double` read is bounded by the backing buffer, so a truncated double
//! inside a nested message reads the bytes that follow it, as here, but one at the very end of the
//! answer reads whatever follows the buffer in Node's pool, and is an error here.

use std::sync::Arc;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_js::to_number_of;
use serde_json::Map;
use serde_json::Value;

use super::oauth_usage::UsageError;
use super::usage_normalize::jn;
use super::usage_normalize::round;
use crate::client_versions::Live;
use crate::providers::cursor::API_URL;
use crate::providers::cursor::Access;
use crate::providers::cursor::AccessToken;
use crate::providers::cursor::http_status_error;
use crate::providers::cursor::is_sign_in_refusal;
use crate::providers::cursor::rpc_headers;
use crate::providers::cursor::unwrap_unary_body;
use crate::transport::deadlines::CURSOR_USAGE;
use crate::transport::http::HttpSend;

/// The provider whose plan usage this reads.
pub const PROVIDER_ID: &str = "cursor-oauth";
pub const API_PROVIDER_ID: &str = "cursor-api";
pub const USAGE_PATH: &str = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
pub const PLAN_PATH: &str = "/aiserver.v1.DashboardService/GetPlanInfo";
pub const USAGE_SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
/// Fallback Basic pool tokens when `autoBucketModels` is omitted.
const AUTO_POOL_MODELS: [&str; 4] = ["auto", "default", "composer", "grok"];
const AUTO_POOL_BASE_MODELS: [&str; 3] = ["auto", "default", "composer"];
const MAX_AUTO_MODEL_TOKENS: usize = 12;

// Node's protobuf codec, as the usage messages use it

#[derive(Clone, Copy)]
enum Ty {
    Int,
    Bool,
    Double,
    Str,
    RepStr,
    Msg(&'static [(u128, &'static str, Ty)]),
}

const PLAN_USAGE: &[(u128, &str, Ty)] = &[
    (1, "totalSpend", Ty::Int),
    (2, "includedSpend", Ty::Int),
    (3, "bonusSpend", Ty::Int),
    (4, "remaining", Ty::Int),
    (5, "limit", Ty::Int),
    (7, "bonusTooltip", Ty::Str),
    (8, "autoSpend", Ty::Int),
    (9, "apiSpend", Ty::Int),
    (10, "autoLimit", Ty::Int),
    (11, "apiLimit", Ty::Int),
    (12, "autoPercentUsed", Ty::Double),
    (13, "apiPercentUsed", Ty::Double),
    (14, "totalPercentUsed", Ty::Double),
];
const SPEND_LIMIT_USAGE: &[(u128, &str, Ty)] = &[
    (1, "totalSpend", Ty::Int),
    (2, "pooledLimit", Ty::Int),
    (3, "pooledUsed", Ty::Int),
    (4, "pooledRemaining", Ty::Int),
    (5, "individualLimit", Ty::Int),
    (6, "individualUsed", Ty::Int),
    (7, "individualRemaining", Ty::Int),
    (8, "limitType", Ty::Str),
    (9, "overallLimit", Ty::Int),
    (10, "overallUsed", Ty::Int),
    (11, "overallRemaining", Ty::Int),
];
const CURRENT_PERIOD_USAGE: &[(u128, &str, Ty)] = &[
    (1, "billingCycleStart", Ty::Int),
    (2, "billingCycleEnd", Ty::Int),
    (3, "planUsage", Ty::Msg(PLAN_USAGE)),
    (4, "spendLimitUsage", Ty::Msg(SPEND_LIMIT_USAGE)),
    (5, "displayThreshold", Ty::Int),
    (6, "enabled", Ty::Bool),
    (7, "displayMessage", Ty::Str),
    (11, "autoModelSelectedDisplayMessage", Ty::Str),
    (12, "namedModelSelectedDisplayMessage", Ty::Str),
    (13, "autoBucketModels", Ty::RepStr),
];
const PLAN_INFO: &[(u128, &str, Ty)] =
    &[(1, "planName", Ty::Str), (2, "includedAmountCents", Ty::Int), (3, "price", Ty::Str), (4, "billingCycleEnd", Ty::Int), (5, "planOwner", Ty::Int)];
const PLAN_INFO_RESPONSE: &[(u128, &str, Ty)] = &[(1, "planInfo", Ty::Msg(PLAN_INFO))];

/// `ProtoReader` over a window of the answer; the whole answer stays addressable, as Node's views share a buffer.
struct Wire<'a> {
    all: &'a [u8],
    at: usize,
    end: usize,
}

impl<'a> Wire<'a> {
    fn done(&self) -> bool {
        self.at >= self.end
    }

    fn varint(&mut self) -> Result<u128, String> {
        let (mut value, mut shift) = (0u128, 0u32);
        while !self.done() {
            let byte = self.all[self.at];
            self.at += 1;
            value |= u128::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
            shift += 7;
            if shift > 70 {
                return Err("Invalid Cursor protobuf varint".into());
            }
        }
        Err("Truncated Cursor protobuf varint".into())
    }

    fn take(&mut self, length: u128) -> Result<(usize, usize), String> {
        let remaining = (self.end - self.at.min(self.end)) as u128;
        if length > remaining {
            return Err("Truncated Cursor protobuf field".into());
        }
        let start = self.at;
        self.at += length as usize;
        Ok((start, self.at))
    }

    fn bytes_value(&mut self) -> Result<(usize, usize), String> {
        let length = self.varint()?;
        self.take(length)
    }

    fn skip(&mut self, wire_type: u128) -> Result<(), String> {
        match wire_type {
            0 => self.varint().map(|_| ()),
            1 => self.take(8).map(|_| ()),
            2 => self.bytes_value().map(|_| ()),
            5 => self.take(4).map(|_| ()),
            other => Err(format!("Unsupported Cursor protobuf wire type: {other}")),
        }
    }
}

fn decode_message(all: &[u8], start: usize, end: usize, schema: &'static [(u128, &'static str, Ty)]) -> Result<Map<String, Value>, String> {
    let mut wire = Wire { all, at: start, end };
    let mut out = Map::new();
    while !wire.done() {
        let tag = wire.varint()?;
        let (number, wire_type) = (tag >> 3, tag & 7);
        let Some((_, name, ty)) = schema.iter().find(|(no, _, _)| *no == number) else {
            wire.skip(wire_type)?;
            continue;
        };
        let value = match ty {
            Ty::Str | Ty::RepStr => {
                let (from, to) = wire.bytes_value()?;
                Value::String(String::from_utf8_lossy(&all[from..to]).into_owned())
            }
            Ty::Double => {
                if wire_type != 1 {
                    return Err("Invalid Cursor protobuf double".into());
                }
                // Bounded by the backing buffer only: a nested message reads on into its parent's bytes.
                let bytes: [u8; 8] =
                    all.get(wire.at..wire.at + 8).and_then(|slice| slice.try_into().ok()).ok_or("Offset is outside the bounds of the DataView")?;
                wire.at += 8;
                // A value that is not a finite number stays one for `Number(..)` as its JavaScript text.
                let double = f64::from_le_bytes(bytes);
                if double.is_finite() {
                    jn(double)
                } else {
                    Value::String(
                        if double.is_nan() {
                            "NaN"
                        } else if double > 0.0 {
                            "Infinity"
                        } else {
                            "-Infinity"
                        }
                        .into(),
                    )
                }
            }
            Ty::Bool => Value::Bool(wire.varint()? != 0),
            Ty::Int => jn((wire.varint()? as u64) as i64 as f64),
            Ty::Msg(inner) => {
                let (from, to) = wire.bytes_value()?;
                Value::Object(decode_message(all, from, to, inner)?)
            }
        };
        if matches!(ty, Ty::RepStr) {
            match out.entry((*name).to_owned()).or_insert_with(|| Value::Array(Vec::new())) {
                Value::Array(items) => items.push(value),
                _ => unreachable!("a repeated field holds an array"),
            }
        } else {
            out.insert((*name).to_owned(), value);
        }
    }
    Ok(out)
}

// normalizeCursorUsage

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `a || b || c`: the first truthy value.
fn first_truthy<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates.iter().copied().find(|v| truthy(*v)).flatten()
}

fn number(value: Option<&Value>) -> f64 {
    if value.is_none() { 0.0 } else { to_number_of(value) }
}

/// `centsToUsd`.
fn cents_to_usd(cents: f64) -> Value {
    jn(if cents.is_finite() { (cents + 0.5).floor() / 100.0 } else { 0.0 })
}

fn usage_percent(value: f64) -> Option<f64> {
    value.is_finite().then(|| round(value.clamp(0.0, 100.0), 4))
}

fn with_reset(mut row: Map<String, Value>, reset_at: Option<f64>) -> Map<String, Value> {
    if let Some(reset) = reset_at {
        row.insert("resetAt".into(), jn(reset));
    }
    row
}

/// One spend pool's figures, in cents; a value is `None` unless the wire reported it or its own pool implies it.
struct SpendPool {
    limit: Option<f64>,
    used: Option<f64>,
    remaining: Option<f64>,
}

impl SpendPool {
    fn exhausted(&self) -> bool {
        self.limit.is_some_and(|limit| limit > 0.0 && (self.used.is_some_and(|u| u >= limit) || self.remaining.is_some_and(|r| r <= 0.0)))
    }
}

/// The figures of the first pool (overall, individual, pooled) that reports a limit, never mixing pools; with no
/// limit anywhere, whatever the first reporting pool or the bare total shows, for display only.
fn spend_pool(spend: &Map<String, Value>) -> Option<SpendPool> {
    let reported = |key: &str| spend.get(key).filter(|v| !v.is_null()).map(|v| to_number_of(Some(v))).filter(|n| n.is_finite());
    let pools = [
        ("overallLimit", "overallUsed", "overallRemaining"),
        ("individualLimit", "individualUsed", "individualRemaining"),
        ("pooledLimit", "pooledUsed", "pooledRemaining"),
    ];
    let row = |(limit, used, remaining): (&str, &str, &str)| (reported(limit), reported(used), reported(remaining));
    let (limit, used, remaining) = pools
        .into_iter()
        .map(row)
        .find(|(limit, _, _)| limit.is_some_and(|l| l > 0.0))
        // A pool whose figures are all zero states nothing (proto3 omits zeros): the next pool or the bare total shows.
        .or_else(|| pools.into_iter().map(row).find(|(l, u, r)| [l, u, r].into_iter().any(|v| v.is_some_and(|v| v > 0.0))))
        .or_else(|| reported("totalSpend").map(|total| (None, Some(total), None)))?;
    let used = used.or_else(|| limit.zip(remaining).map(|(l, r)| l - r));
    let remaining = remaining.or_else(|| limit.zip(used).map(|(l, u)| (l - u).max(0.0)));
    Some(SpendPool { limit, used, remaining })
}

/// Normalises `autoBucketModels` from `GetCurrentPeriodUsage` into compact family tokens bounded by the
/// roster's 12-token limit, falling back to `AUTO_POOL_MODELS` when omitted.
fn auto_pool_models(usage: &Map<String, Value>) -> Vec<String> {
    let Some(items) = usage.get("autoBucketModels").and_then(Value::as_array).filter(|items| !items.is_empty()) else {
        return AUTO_POOL_MODELS.iter().map(|s| (*s).to_owned()).collect();
    };
    let mut out: Vec<String> = AUTO_POOL_BASE_MODELS.iter().map(|s| (*s).to_owned()).collect();
    for raw in items.iter().filter_map(Value::as_str) {
        let mut token = raw.trim().to_ascii_lowercase();
        if let Some(rest) = token.strip_prefix("cursor-") {
            token = rest.to_owned();
        }
        loop {
            let stripped = ["fast", "low", "medium", "high", "xhigh"].iter().find_map(|suffix| token.strip_suffix(&format!("-{suffix}")));
            match stripped {
                Some(stem) if !stem.is_empty() => token = stem.to_owned(),
                _ => break,
            }
        }
        if token.is_empty() || token.starts_with("composer-") {
            continue;
        }
        if token.starts_with("vega-") {
            token = "vega".to_owned();
        }
        if !out.contains(&token) {
            out.push(token);
            if out.len() >= MAX_AUTO_MODEL_TOKENS {
                break;
            }
        }
    }
    out
}

/// The included-plan windows: per-lane progress percentages when reported.
/// In proto3, a `0.0` scalar `double` is omitted on the wire: when either split lane reports a finite
/// percentage, an omitted (`None`) sibling lane is `0%`, whereas a malformed non-number stays absent.
fn lane_windows(included: &Map<String, Value>, reset_at: Option<f64>, spend_exhausted: bool, auto_models: &[String]) -> Vec<Value> {
    let raw_auto = included.get("autoPercentUsed");
    let raw_api = included.get("apiPercentUsed");
    let any_split_lane = [raw_auto, raw_api].into_iter().any(|v| v.is_some_and(|v| to_number_of(Some(v)).is_finite()));
    let lanes = [("Basic", raw_auto, true), ("API", raw_api, false)];
    let mut windows: Vec<Value> = Vec::new();
    for (label, value, auto) in lanes {
        let n = match value {
            None if any_split_lane => 0.0,
            None => f64::NAN,
            Some(_) => to_number_of(value),
        };
        if !n.is_finite() {
            continue;
        }
        let mut row = Map::new();
        row.insert("label".into(), label.into());
        row.insert("source".into(), "cursor-dashboard".into());
        row.insert("usedPct".into(), usage_percent(n).map_or(Value::Null, jn));
        let mut row = with_reset(row, reset_at);
        // The scope is which models the lane covers; `binding` is whether a full lane refuses them.
        row.insert(if auto { "models" } else { "except" }.into(), serde_json::json!(auto_models));
        if !spend_exhausted {
            row.insert("binding".into(), Value::Bool(false));
        }
        windows.push(Value::Object(row));
    }
    windows
}

/// The one dollar window of an account whose lanes report no percentage.
fn included_dollar_window(plan: &Map<String, Value>, balance: &Map<String, Value>, reset_at: Option<f64>) -> Value {
    let name = plan.get("planName").filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string);
    let mut row = Map::new();
    row.insert("label".into(), name.map_or_else(|| "Included usage".to_owned(), |n| format!("{n} included")).into());
    row.insert("source".into(), "cursor-dashboard".into());
    for key in ["limitUsd", "usedUsd", "remainingUsd"] {
        row.insert(key.into(), balance[key].clone());
    }
    Value::Object(with_reset(row, reset_at))
}

/// The usage-based spend window; none when the account has no spend limit data.
/// Figures that are all zero (or below) state nothing: proto3 omits zeros, so they are no limit data.
fn spend_window(spend: &SpendPool, reset_at: Option<f64>) -> Option<Value> {
    if ![spend.limit, spend.used, spend.remaining].iter().any(|v| v.is_some_and(|v| v > 0.0)) {
        return None;
    }
    let mut row = Map::new();
    row.insert("label".into(), "Usage-based spend".into());
    row.insert("source".into(), "cursor-dashboard".into());
    for (key, cents) in [("limitUsd", spend.limit), ("usedUsd", spend.used), ("remainingUsd", spend.remaining)] {
        if let Some(cents) = cents {
            row.insert(key.into(), cents_to_usd(cents));
        }
    }
    Some(Value::Object(with_reset(row, reset_at)))
}
fn is_unified_membership(summary: Option<&Map<String, Value>>) -> bool {
    summary.and_then(|s| s.get("membershipType")).and_then(Value::as_str).is_some_and(|m| m.starts_with("unified_"))
}

fn on_demand_object(summary: Option<&Map<String, Value>>) -> Option<&Map<String, Value>> {
    summary?.get("individualUsage").and_then(Value::as_object)?.get("onDemand").and_then(Value::as_object)
}

fn on_demand_disabled_obj(od: &Map<String, Value>) -> bool {
    od.get("enabled") == Some(&Value::Bool(false)) || od.get("limit").is_some_and(|v| !v.is_null() && to_number_of(Some(v)) <= 0.0)
}

fn on_demand_disabled(summary: Option<&Map<String, Value>>) -> bool {
    on_demand_object(summary).is_some_and(on_demand_disabled_obj)
}

fn on_demand_uncapped(od: &Map<String, Value>) -> bool {
    od.get("enabled") == Some(&Value::Bool(true)) && od.get("limit").is_none_or(Value::is_null)
}

fn finite_num(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).filter(|v| !v.is_null()).map(|v| to_number_of(Some(v))).filter(|n| n.is_finite())
}

/// Returns `(limit, used, remaining)` in cents for an enabled `onDemand` bucket with a positive limit.
/// Derives `used = limit - remaining` when `used` is `0`/omitted and `remaining < limit`,
/// derives `remaining = limit - used` when `used > 0` accompanies a stale `remaining: 0`,
/// and returns `None` when both `used` and `remaining` are absent.
fn on_demand_figures(od: &Map<String, Value>) -> Option<(f64, f64, f64)> {
    if on_demand_disabled_obj(od) {
        return None;
    }
    let limit = finite_num(od, "limit").filter(|n| *n > 0.0)?;
    let raw_used = finite_num(od, "used").filter(|n| *n >= 0.0);
    let raw_remaining = finite_num(od, "remaining").filter(|n| *n >= 0.0);
    let (used, remaining) = match (raw_used, raw_remaining) {
        (None, None) => return None,
        (None | Some(0.0), Some(rem)) if rem < limit => ((limit - rem).max(0.0), rem.max(0.0)),
        (Some(used), Some(0.0)) if used > 0.0 => (used, (limit - used).max(0.0)),
        (used_opt, rem_opt) => {
            let used = used_opt.unwrap_or_else(|| rem_opt.map_or(0.0, |rem| (limit - rem).max(0.0)));
            let remaining = rem_opt.unwrap_or_else(|| (limit - used).max(0.0)).max(0.0);
            (used, remaining)
        }
    };
    Some((limit, used, remaining))
}

/// Tri-state overage/prepaid credit verdict beyond the included plan window:
/// `Some(true)` when usable capacity exists, `Some(false)` when explicitly disabled/exhausted/absent on a unified plan,
/// and `None` when the payload carries no credit evidence.
fn cursor_overage_credit_state(summary: Option<&Map<String, Value>>, spend: Option<&SpendPool>) -> Option<bool> {
    if on_demand_disabled(summary) {
        return Some(false);
    }
    if let Some(od) = on_demand_object(summary) {
        if let Some((_, _, remaining)) = on_demand_figures(od) {
            return Some(remaining > 0.0);
        }
        let raw_remaining = finite_num(od, "remaining");
        if on_demand_uncapped(od) {
            if spend.is_some_and(SpendPool::exhausted) {
                return Some(false);
            }
            return Some(raw_remaining.is_none_or(|rem| rem > 0.0));
        }
        if let Some(rem) = raw_remaining {
            return Some(rem > 0.0);
        }
    }
    if is_unified_membership(summary) {
        return Some(false);
    }
    if let Some(s) = spend {
        if s.exhausted() {
            return Some(false);
        }
        if s.remaining.is_some_and(|r| r > 0.0) {
            return Some(true);
        }
    }
    None
}

fn unified_windows(summary: &Map<String, Value>, weekly_reset_at: Option<f64>, spend_exhausted: bool, auto_models: &[String]) -> Vec<Value> {
    let empty = Map::new();
    let individual = summary.get("individualUsage").and_then(Value::as_object).unwrap_or(&empty);
    let mut windows = Vec::new();
    if let Some(plan) = individual.get("plan").and_then(Value::as_object).filter(|p| p.get("enabled") != Some(&Value::Bool(false))) {
        let limit = finite_num(plan, "limit").filter(|n| *n > 0.0);
        let used = finite_num(plan, "used");
        let pct = finite_num(plan, "totalPercentUsed");
        let computed_pct = match (limit, used, pct) {
            (Some(l), u, p) => Some(p.unwrap_or(0.0).max(u.map_or(0.0, |u| (u / l) * 100.0)).max(0.0)),
            (None, _, Some(p)) => Some(p.max(0.0)),
            _ => None,
        };
        if let Some(pct) = computed_pct {
            let mut row = Map::new();
            row.insert("label".into(), "Basic".into());
            row.insert("source".into(), "cursor-dashboard".into());
            row.insert("usedPct".into(), usage_percent(pct).map_or(Value::Null, jn));
            if let Some(l) = limit {
                let used_cents = (l * (pct / 100.0)).min(l);
                row.insert("limitUsd".into(), cents_to_usd(l));
                row.insert("usedUsd".into(), cents_to_usd(used_cents));
                row.insert("remainingUsd".into(), cents_to_usd((l - used_cents).max(0.0)));
            }
            let mut row = with_reset(row, weekly_reset_at);
            row.insert("models".into(), serde_json::json!(auto_models));
            windows.push(Value::Object(row));
        }
    }
    if let Some(od) = individual.get("onDemand").and_then(Value::as_object) {
        let disabled = on_demand_disabled_obj(od);
        let mut row = Map::new();
        row.insert("label".into(), "API".into());
        row.insert("source".into(), "cursor-dashboard".into());
        row.insert("except".into(), serde_json::json!(auto_models));
        if disabled {
            row.insert("usedPct".into(), jn(100.0));
            row.insert("limitUsd".into(), jn(0.0));
            row.insert("usedUsd".into(), jn(0.0));
            row.insert("remainingUsd".into(), jn(0.0));
            windows.push(Value::Object(row));
        } else if let Some((limit, used, remaining)) = on_demand_figures(od) {
            let pct = (used / limit) * 100.0;
            row.insert("usedPct".into(), usage_percent(pct).map_or(Value::Null, jn));
            row.insert("limitUsd".into(), cents_to_usd(limit));
            row.insert("usedUsd".into(), cents_to_usd(used));
            row.insert("remainingUsd".into(), cents_to_usd(remaining));
            windows.push(Value::Object(row));
        } else if on_demand_uncapped(od) {
            let raw_used = finite_num(od, "used").filter(|n| *n >= 0.0);
            let raw_remaining = finite_num(od, "remaining");
            let exhausted = spend_exhausted || raw_remaining.is_some_and(|r| r <= 0.0);
            row.insert("usedPct".into(), jn(if exhausted { 100.0 } else { 0.0 }));
            if let Some(used) = raw_used {
                row.insert("usedUsd".into(), cents_to_usd(used));
            }
            if let Some(rem) = raw_remaining {
                row.insert("remainingUsd".into(), cents_to_usd(rem.max(0.0)));
            }
            windows.push(Value::Object(row));
        }
    }
    windows
}

/// `normalizeCursorUsage(usage, planResponse)` (without the provider name `getUsageSnapshot` adds).
pub fn normalize_cursor_usage(usage: &Map<String, Value>, plan_response: &Map<String, Value>) -> Value {
    normalize_cursor_usage_with_summary(usage, plan_response, None, None)
}

pub fn normalize_cursor_usage_with_summary(
    usage: &Map<String, Value>,
    plan_response: &Map<String, Value>,
    summary: Option<&Map<String, Value>>,
    weekly_reset_at: Option<f64>,
) -> Value {
    let empty = Map::new();
    let object = |value: Option<&Value>| value.and_then(Value::as_object).unwrap_or(&empty).clone();
    let plan = object(plan_response.get("planInfo"));
    let mut included = object(usage.get("planUsage"));
    if included.get("autoPercentUsed").is_none()
        && included.get("apiPercentUsed").is_none()
        && let Some(summary_plan) = summary
            .and_then(|s| s.get("individualUsage"))
            .and_then(Value::as_object)
            .and_then(|i| i.get("plan"))
            .and_then(Value::as_object)
            .filter(|p| p.get("enabled") != Some(&Value::Bool(false)))
    {
        for key in ["autoPercentUsed", "apiPercentUsed", "totalPercentUsed", "limit"] {
            if let Some(val) = summary_plan.get(key).filter(|v| !v.is_null()) {
                included.entry(key.to_owned()).or_insert_with(|| val.clone());
            }
        }
    }
    let spend = object(usage.get("spendLimitUsage"));
    let reset_value = number(first_truthy(&[usage.get("billingCycleEnd"), plan.get("billingCycleEnd")]));
    let reset_at = (reset_value != 0.0 && !reset_value.is_nan()).then_some(reset_value);

    let limit = number(first_truthy(&[included.get("limit"), plan.get("includedAmountCents")]));
    let used = number(included.get("totalSpend").filter(|v| truthy(Some(v))));
    let remaining = match included.get("remaining") {
        Some(value) if !value.is_null() => to_number_of(Some(value)),
        _ => (limit - used).max(0.0),
    };
    let balance = (limit > 0.0 || used > 0.0 || remaining > 0.0).then(|| {
        let mut b = Map::new();
        b.insert("source".into(), "cursor-dashboard".into());
        b.insert("remainingUsd".into(), cents_to_usd(remaining));
        b.insert("usedUsd".into(), cents_to_usd(used));
        b.insert("limitUsd".into(), cents_to_usd(limit));
        b
    });

    // The usage-based spend allowance (optional, account-configured). While it has room, a full
    // included lane is a usage counter, not a refusal: Cursor bills the overage and keeps serving.
    let spend = spend_pool(&spend);
    // A reported cap used up in its own pool, or web summary evidence that on-demand billing is disabled,
    // makes a full included lane binding.
    let spend_exhausted = spend.as_ref().is_some_and(SpendPool::exhausted) || on_demand_disabled(summary);
    let credit_state = cursor_overage_credit_state(summary, spend.as_ref());
    let auto_models = auto_pool_models(usage);

    let weekly_reset_at = weekly_reset_at.or_else(|| epoch_ms(plan.get("includedUsageResetsAt")));
    let mut windows = if let Some(summary) = summary.filter(|_| is_unified_membership(summary)) {
        // Unified weekly Basic pools reset on `includedUsageResetsAt`, never the monthly billing cycle.
        let unified = unified_windows(summary, weekly_reset_at, spend_exhausted, &auto_models);
        if unified.is_empty() { lane_windows(&included, reset_at, spend_exhausted, &auto_models) } else { unified }
    } else {
        lane_windows(&included, reset_at, spend_exhausted, &auto_models)
    };
    if let Some(b) = balance.as_ref().filter(|_| windows.is_empty()) {
        windows.push(included_dollar_window(&plan, b, reset_at));
    }
    if !is_unified_membership(summary) {
        windows.extend(spend.as_ref().and_then(|s| spend_window(s, reset_at)));
    }
    let balance = match balance {
        Some(mut b) => {
            b.insert("hasCredits".into(), Value::Bool(credit_state == Some(true)));
            Some(b)
        }
        None => credit_state.map(|has_credits| {
            let mut b = Map::new();
            b.insert("source".into(), "cursor-dashboard".into());
            b.insert("hasCredits".into(), Value::Bool(has_credits));
            b
        }),
    };
    let text = |v: Option<&Value>| v.filter(|v| truthy(Some(v))).map_or_else(String::new, mixdog_js::value_to_string);
    let mut plan_block = Map::new();
    plan_block.insert("name".into(), text(plan.get("planName")).into());
    plan_block.insert("price".into(), text(plan.get("price")).into());
    let included_cents = if truthy(plan.get("includedAmountCents")) { number(plan.get("includedAmountCents")) } else { limit };
    plan_block.insert("includedUsd".into(), cents_to_usd(included_cents));
    plan_block.insert("resetAt".into(), reset_at.map_or(Value::Null, jn));
    let mut out = Map::new();
    out.insert("source".into(), "cursor-dashboard".into());
    out.insert("quotaWindows".into(), Value::Array(windows));
    if let Some(balance) = balance {
        out.insert("balance".into(), Value::Object(balance));
    }
    out.insert("plan".into(), Value::Object(plan_block));
    out.insert("enabled".into(), Value::Bool(usage.get("enabled") == Some(&Value::Bool(true))));
    out.insert("detail".into(), text(usage.get("displayMessage")).into());
    Value::Object(out)
}

// the two calls

/// Cursor's plan usage over the dashboard service.
pub struct CursorUsage {
    http: Arc<dyn HttpSend>,
    api_url: String,
    version: Live,
    tokens: Arc<dyn AccessToken>,
    provider: String,
}

fn failure(error: ProviderError) -> UsageError {
    UsageError { status: error.status, message: error.into_message() }
}

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn cursor_user_id(token: &str) -> Option<String> {
    let claims = crate::accounts::validity::decode_jwt_payload(token)?;
    let sub = claims.get("sub")?.as_str()?.trim();
    if sub.is_empty() {
        return None;
    }
    let id = sub.split_once('|').map_or(sub, |(_, id)| id.trim());
    (!id.is_empty()).then(|| id.to_owned())
}

fn epoch_ms(value: Option<&Value>) -> Option<f64> {
    if let Some(Value::String(text)) = value {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let n = to_number_of(Some(&Value::String(trimmed.to_owned())));
        if n.is_finite() && n > 0.0 {
            return Some(if n < 1_000_000_000_000.0 { n * 1000.0 } else { n });
        }
        let ms = mixdog_js::time::date_parse(trimmed);
        return (ms.is_finite() && ms > 0.0).then_some(ms);
    }
    let n = to_number_of(value);
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    Some(if n < 1_000_000_000_000.0 { n * 1000.0 } else { n })
}

fn decode_plan_response(body: &[u8]) -> Result<Map<String, Value>, String> {
    let trimmed = body.iter().position(|b| !b.is_ascii_whitespace()).map_or(&[][..], |i| &body[i..]);
    if trimmed.starts_with(b"{") {
        return match serde_json::from_slice::<Value>(trimmed).map_err(|e| format!("Invalid Cursor plan JSON: {e}"))? {
            Value::Object(map) => Ok(map),
            _ => Err("Invalid Cursor plan JSON: expected object".to_owned()),
        };
    }
    let unwrapped = unwrap_unary_body(body);
    decode_message(unwrapped, 0, unwrapped.len(), PLAN_INFO_RESPONSE)
}

impl CursorUsage {
    pub fn new(provider: &str, http: Arc<dyn HttpSend>, api_url: Option<String>, version: Live, tokens: Arc<dyn AccessToken>) -> Self {
        Self { http, api_url: api_url.unwrap_or_else(|| API_URL.to_owned()), version, tokens, provider: provider.to_owned() }
    }

    /// `callCursorUnary`: one empty-bodied unary POST; a status of 400 or more is the failure, a
    /// redirect is an answer.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn call(&self, token: &str, path: &str) -> Result<Vec<u8>, ProviderError> {
        let request = WireRequest {
            transport: TransportKind::Http2,
            method: "POST".to_owned(),
            url: format!("{}{path}", self.api_url.trim_end_matches('/')),
            headers: rpc_headers(token, &self.version.get(), true),
            body: Vec::new(),
        };
        let head = self.http.send(request, CURSOR_USAGE).await?;
        let (status, headers) = (head.status, head.headers.clone());
        let body = head.read_all().await?;
        if status >= 400 {
            return Err(http_status_error(status, &headers));
        }
        Ok(body.body)
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn call_plan_info(&self, token: &str) -> Result<Vec<u8>, ProviderError> {
        let mut headers = rpc_headers(token, &self.version.get(), true);
        if let Some((_, value)) = headers.iter_mut().find(|(k, _)| k == "content-type") {
            *value = "application/json".to_owned();
        }
        headers.push(("accept".to_owned(), "application/json".to_owned()));
        headers.push(("connect-protocol-version".to_owned(), "1".to_owned()));
        let request = WireRequest {
            transport: TransportKind::Http2,
            method: "POST".to_owned(),
            url: format!("{}{PLAN_PATH}", self.api_url.trim_end_matches('/')),
            headers,
            body: b"{}".to_vec(),
        };
        let head = self.http.send(request, CURSOR_USAGE).await?;
        let (status, headers) = (head.status, head.headers.clone());
        let body = head.read_all().await?;
        if status >= 400 {
            return Err(http_status_error(status, &headers));
        }
        Ok(body.body)
    }

    async fn call_summary(&self, user_id: &str, token: &str) -> Option<Map<String, Value>> {
        let cookie = format!("WorkosCursorSessionToken={}", encode_uri_component(&format!("{user_id}::{token}")));
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: "GET".to_owned(),
            url: USAGE_SUMMARY_URL.to_owned(),
            headers: vec![("accept".to_owned(), "application/json".to_owned()), ("cookie".to_owned(), cookie)],
            body: Vec::new(),
        };
        let head = self.http.send(request, CURSOR_USAGE).await.ok()?;
        if !(200..300).contains(&head.status) {
            return None;
        }
        let body = head.read_all().await.ok()?;
        match serde_json::from_slice::<Value>(&body.body).ok()? {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }

    /// `getUsageSnapshot()`. `sent` is the access the reading's requests go out on, once the tokens handed it out.
    pub async fn read(&self, sent: &mut Option<Access>) -> Result<Value, UsageError> {
        let access = self.tokens.access_token().await.map_err(failure)?;
        *sent = Some(access.clone());
        let token = access.token.clone();
        let summary_user = (self.provider == PROVIDER_ID && self.api_url == API_URL).then(|| cursor_user_id(&token)).flatten();
        let (usage, plan, summary) = match summary_user.as_deref() {
            Some(user_id) => {
                let (u, p, s) = futures::future::join3(self.call(&token, USAGE_PATH), self.call_plan_info(&token), self.call_summary(user_id, &token)).await;
                (u, p, s)
            }
            None => {
                let (u, p) = futures::future::join(self.call(&token, USAGE_PATH), self.call_plan_info(&token)).await;
                (u, p, None)
            }
        };
        let usage_body = match usage {
            Ok(body) => body,
            // The refusal is of the sign-in this reading was sent on, as a send's is: that one is renewed, or marked for a
            // new sign-in when its renewal is refused too.
            Err(error) if is_sign_in_refusal(&error) => {
                return Err(failure(match self.tokens.after_rejection(&access).await {
                    Err(renewal) if renewal.reauth_required => renewal,
                    _ => error,
                }));
            }
            Err(error) => return Err(failure(error)),
        };
        let unwrapped = unwrap_unary_body(&usage_body);
        let usage = decode_message(unwrapped, 0, unwrapped.len(), CURRENT_PERIOD_USAGE).map_err(UsageError::new)?;
        // The plan call may fail; its answer, once received, must decode.
        let plan = match plan {
            Ok(body) => decode_plan_response(&body).map_err(UsageError::new)?,
            Err(_) => Map::new(),
        };
        let Value::Object(mut snapshot) = normalize_cursor_usage_with_summary(&usage, &plan, summary.as_ref(), None) else {
            unreachable!("a snapshot is an object")
        };
        snapshot.insert("provider".into(), self.provider.clone().into());
        Ok(Value::Object(snapshot))
    }
}

#[cfg(test)]
mod rejection_tests {
    use std::sync::atomic::AtomicU16;
    use std::sync::atomic::Ordering;

    use base64::Engine;

    use super::*;
    use crate::oauth::CredentialFile;
    use crate::oauth::CredentialIo;
    use crate::providers::cursor::auth::EXCHANGE_URL;
    use crate::providers::cursor::auth::FileAccess;
    use crate::providers::listing_row::testing::Replay;

    /// What Settings shows for the account: the stored sign-in, read as the account roster reads it.
    #[allow(clippy::disallowed_methods, reason = "test: reads the fixture credential file synchronously")]
    fn signed_in(path: &std::path::Path) -> bool {
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        crate::accounts::validity::credential_valid(PROVIDER_ID, doc.as_object().unwrap(), 0.0)
    }

    /// A usage reading the service refuses marks the sign-in it was sent on for a new sign-in once that sign-in's renewal
    /// is refused too; a reading that fails for any other reason marks nothing.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes a fixture credential file synchronously")]
    async fn a_refused_usage_reading_marks_the_account_for_a_new_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor-oauth.json");
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"exp":4000000000}"#);
        let token = format!("h.{payload}.s");
        std::fs::write(
            &path,
            serde_json::json!({ "access_token": token, "refresh_token": "fixture-refresh", "expires_at": 4_000_000_000_000_u64 }).to_string(),
        )
        .unwrap();
        let status = Arc::new(AtomicU16::new(503));
        let answered = status.clone();
        let is_token_refresh = |url: &str| url == EXCHANGE_URL || url.ends_with("/oauth/token");
        let http = Arc::new(Replay::new(move |request: &WireRequest| {
            (if is_token_refresh(&request.url) { 401 } else { answered.load(Ordering::SeqCst) }, Vec::new())
        }));
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let usage = CursorUsage::new(
            PROVIDER_ID,
            http.clone(),
            None,
            crate::providers::cursor::CLIENT_VERSION_FLOOR.into(),
            Arc::new(FileAccess::new(http.clone(), file)),
        );

        for answer in [503, 403] {
            status.store(answer, Ordering::SeqCst);
            assert!(usage.read(&mut None).await.is_err());
            assert!(signed_in(&path), "a {answer} is not a refusal of the sign-in");
            assert!(!http.requests.lock().unwrap().iter().any(|request| is_token_refresh(&request.url)), "a {answer} renewed the sign-in");
        }

        status.store(401, Ordering::SeqCst);
        let error = usage.read(&mut None).await.expect_err("the reading is refused");
        assert!(error.message.contains(crate::providers::cursor::auth::REAUTH_GUIDANCE), "{}", error.message);
        assert!(!signed_in(&path), "the refused sign-in still reads as signed in");
    }

    /// A sign-in marked as refused sends nothing until the user signs in again: the usage reading answers with the
    /// sign-in-again message and the listing with the static list, neither with a request.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes a fixture credential file synchronously")]
    async fn a_marked_sign_in_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor-oauth.json");
        std::fs::write(&path, serde_json::json!({ "access_token": "marked-access", "refresh_token": "marked-refresh", "reauth_required": true }).to_string())
            .unwrap();
        let http = Arc::new(Replay::new(|_request: &WireRequest| (200, Vec::new())));
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path, CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let access: Arc<FileAccess> = Arc::new(FileAccess::new(http.clone(), file));
        let version = || -> Live { crate::providers::cursor::CLIENT_VERSION_FLOOR.into() };

        let error = CursorUsage::new(PROVIDER_ID, http.clone(), None, version(), access.clone()).read(&mut None).await.expect_err("nothing is read");
        assert!(error.message.contains(crate::providers::cursor::auth::REAUTH_GUIDANCE), "{}", error.message);

        struct NoRun;
        #[async_trait::async_trait]
        impl crate::transport::http::BidiOpen for NoRun {
            async fn open(
                &self,
                _request: WireRequest,
                _first: Vec<u8>,
                _exchange: crate::transport::Exchange,
            ) -> Result<(crate::transport::http::HttpResponse, Arc<dyn crate::transport::http::FrameSink>), ProviderError> {
                unreachable!("a listing opens no run")
            }
        }
        let adapter = crate::providers::cursor::CursorAdapter::new(PROVIDER_ID, None, Some(version()), http.clone(), Arc::new(NoRun), access);
        let records = mixdog_core_api::domain::provider::ModelListing::list_models(&adapter).await.expect("the static list answers");
        assert!(records.iter().any(|record| record.id == "composer-2.5"));
        assert!(http.requests.lock().unwrap().is_empty(), "a request went out on the refused sign-in");
    }
}

#[cfg(test)]
mod quota_scope_tests {
    use super::*;
    use serde_json::json;

    fn lanes(auto: f64, api: f64, spend: Value) -> Vec<Value> {
        let usage = json!({"billingCycleEnd": 1_900_000_000_000_u64, "planUsage": {"autoPercentUsed": auto, "apiPercentUsed": api}, "spendLimitUsage": spend});
        let snapshot = normalize_cursor_usage(usage.as_object().unwrap(), &Map::new());
        snapshot["quotaWindows"].as_array().unwrap().clone()
    }

    #[test]
    fn lanes_keep_their_coverage_and_refuse_only_on_a_proven_spend_cap() {
        // Unknown or open spend: a full lane is shown as measured, covers its models, and refuses nothing.
        for spend in [json!({}), json!({"overallLimit": 1000, "overallUsed": 400, "overallRemaining": 600})] {
            let windows = lanes(100.0, 40.0, spend);
            // The snapshot writes numbers as JavaScript does (an integral value has no fraction): compared by value.
            assert_eq!((windows[0]["usedPct"].as_f64(), windows[0]["binding"].clone()), (Some(100.0), json!(false)));
            assert_eq!(windows[0]["models"], json!(AUTO_POOL_MODELS), "a Basic refusal still names only Basic models");
            assert_eq!(windows[1]["except"], json!(AUTO_POOL_MODELS));
            assert_eq!(windows[1]["usedPct"].as_f64(), Some(40.0), "a partly used lane stays positive evidence");
        }
        // A cap used up in its own pool makes the full lane binding.
        let windows = lanes(100.0, 40.0, json!({"overallLimit": 1000, "overallUsed": 1000}));
        assert!(windows[0].get("binding").is_none());
    }

    #[test]
    fn spend_figures_never_mix_pools_or_invent_values() {
        let windows = lanes(100.0, 100.0, json!({"overallLimit": 1000, "individualUsed": 1000}));
        let spend = windows.last().unwrap();
        assert_eq!(spend["limitUsd"].as_f64(), Some(10.0));
        assert!(spend.get("usedUsd").is_none(), "another pool's usage is not this cap's usage");
        assert!(windows[0].get("binding").is_some(), "an unmatched figure proves no exhaustion");
    }

    #[test]
    fn exhausted_api_lane_with_disabled_on_demand_and_no_monetary_balance_is_not_selected_for_api_models() {
        use std::collections::HashSet;

        use crate::accounts::{Account, Pool, Usage, Window, policy};
        use crate::service::quota_usable::snapshot_credit_state;

        let now = 1_800_000_000_000_i64;
        let reset = now + 3_600_000;
        let usage = json!({
            "billingCycleEnd": reset,
            "planUsage": { "apiPercentUsed": 100.0 },
        });
        let summary = json!({
            "membershipType": "ultra",
            "individualUsage": {
                "plan": { "enabled": true, "autoPercentUsed": 0.0, "apiPercentUsed": 100.0 },
                "onDemand": { "enabled": false, "used": 0, "limit": null, "remaining": null },
            }
        });
        let snapshot = normalize_cursor_usage_with_summary(usage.as_object().unwrap(), &Map::new(), summary.as_object(), None);
        assert_eq!(snapshot["balance"]["hasCredits"].as_bool(), Some(false));
        assert_eq!(snapshot_credit_state(PROVIDER_ID, &snapshot), Some(false));

        let windows: Vec<Window> = serde_json::from_value(snapshot["quotaWindows"].clone()).unwrap();
        let mut exhausted = Account::new("exhausted-api");
        exhausted.usage = Some(Usage { windows, checked_at: now });
        exhausted.has_credits = snapshot_credit_state(PROVIDER_ID, &snapshot);

        assert!(policy::account_exhausted(&exhausted, now, "claude-sonnet-4-6", true));
        assert!(!policy::account_exhausted(&exhausted, now, "composer-2.5", true));

        let mut backup = Account::new("backup");
        backup.usage = Some(Usage {
            windows: vec![Window {
                label: "API".into(),
                used_pct: Some(20.0),
                reset_at: Some(reset),
                except: Some(AUTO_POOL_MODELS.iter().map(|s| (*s).to_owned()).collect()),
                ..Window::default()
            }],
            checked_at: now,
        });
        backup.has_credits = Some(true);

        let single_pool = Pool { accounts: vec![exhausted.clone()], selected_id: Some("exhausted-api".into()), use_credits: Some(true), ..Pool::default() };
        let none = HashSet::new();
        assert!(policy::choose_account(&single_pool, &none, now, "claude-sonnet-4-6", None).is_none());
        assert_eq!(policy::choose_account(&single_pool, &none, now, "composer-2.5", None).map(|a| a.id.as_str()), Some("exhausted-api"));

        let multi_pool = Pool { accounts: vec![exhausted, backup], selected_id: Some("exhausted-api".into()), use_credits: Some(true), ..Pool::default() };
        assert_eq!(policy::choose_account(&multi_pool, &none, now, "claude-sonnet-4-6", None).map(|a| a.id.as_str()), Some("backup"));
        assert_eq!(policy::choose_account(&multi_pool, &none, now, "composer-2.5", None).map(|a| a.id.as_str()), Some("exhausted-api"));
    }
}
