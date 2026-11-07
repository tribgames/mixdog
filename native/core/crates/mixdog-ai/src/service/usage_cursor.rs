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
use serde_json::Map;
use serde_json::Value;
use mixdog_js::to_number_of;

use super::oauth_usage::UsageError;
use super::usage_normalize::jn;
use super::usage_normalize::round;
use crate::client_versions::Live;
use crate::providers::cursor::AccessToken;
use crate::providers::cursor::API_URL;
use crate::providers::cursor::http_status_error;
use crate::providers::cursor::rpc_headers;
use crate::providers::cursor::unwrap_unary_body;
use crate::transport::deadlines::CURSOR_USAGE;
use crate::transport::http::HttpSend;

/// The provider whose plan usage this reads.
pub const PROVIDER_ID: &str = "cursor-oauth";
pub const USAGE_PATH: &str = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
pub const PLAN_PATH: &str = "/aiserver.v1.DashboardService/GetPlanInfo";
/// Node's `AUTO_POOL_MODELS`: Auto under both of its ids and the Composer family.
const AUTO_POOL_MODELS: [&str; 3] = ["auto", "default", "composer"];

// -- Node's protobuf codec, as the usage messages use it ---------------------------------

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
const PLAN_INFO: &[(u128, &str, Ty)] = &[
    (1, "planName", Ty::Str),
    (2, "includedAmountCents", Ty::Int),
    (3, "price", Ty::Str),
    (4, "billingCycleEnd", Ty::Int),
    (5, "planOwner", Ty::Int),
];
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
                let bytes: [u8; 8] = all.get(wire.at..wire.at + 8).ok_or("Offset is outside the bounds of the DataView")?.try_into().expect("8 bytes");
                wire.at += 8;
                // A value that is not a finite number stays one for `Number(..)` as its JavaScript text.
                let double = f64::from_le_bytes(bytes);
                if double.is_finite() { jn(double) } else { Value::String(if double.is_nan() { "NaN" } else if double > 0.0 { "Infinity" } else { "-Infinity" }.into()) }
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

// -- normalizeCursorUsage -------------------------------------------------------------------

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

/// `normalizeCursorUsage(usage, planResponse)` (without the provider name `getUsageSnapshot` adds).
pub fn normalize_cursor_usage(usage: &Map<String, Value>, plan_response: &Map<String, Value>) -> Value {
    let empty = Map::new();
    let object = |value: Option<&Value>| value.and_then(Value::as_object).unwrap_or(&empty).clone();
    let plan = object(plan_response.get("planInfo"));
    let included = object(usage.get("planUsage"));
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

    // The included-plan windows: per-lane progress percentages when reported, else one dollar window.
    let lanes = [("Basic", included.get("autoPercentUsed"), true), ("API", included.get("apiPercentUsed"), false)];
    let mut windows: Vec<Value> = Vec::new();
    for (label, value, auto) in lanes {
        let n = if value.is_none() { f64::NAN } else { to_number_of(value) };
        if !n.is_finite() {
            continue;
        }
        let mut row = Map::new();
        row.insert("label".into(), label.into());
        row.insert("source".into(), "cursor-dashboard".into());
        row.insert("usedPct".into(), usage_percent(n).map_or(Value::Null, jn));
        let mut row = with_reset(row, reset_at);
        row.insert(if auto { "models" } else { "except" }.into(), serde_json::json!(AUTO_POOL_MODELS));
        windows.push(Value::Object(row));
    }
    if let Some(b) = balance.as_ref().filter(|_| windows.is_empty()) {
        let name = plan.get("planName").filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string);
        let mut row = Map::new();
        row.insert("label".into(), name.map_or_else(|| "Included usage".to_owned(), |n| format!("{n} included")).into());
        row.insert("source".into(), "cursor-dashboard".into());
        for key in ["limitUsd", "usedUsd", "remainingUsd"] {
            row.insert(key.into(), b[key].clone());
        }
        windows.push(Value::Object(with_reset(row, reset_at)));
    }
    // The usage-based spend window; none when the account has no spend limit data.
    let pick = |keys: [&str; 3]| number(first_truthy(&keys.map(|k| spend.get(k))));
    let limit_cents = pick(["overallLimit", "individualLimit", "pooledLimit"]);
    let used_cents = number(first_truthy(&[spend.get("overallUsed"), spend.get("individualUsed"), spend.get("pooledUsed"), spend.get("totalSpend")]));
    let remaining_cents = pick(["overallRemaining", "individualRemaining", "pooledRemaining"]);
    if !(limit_cents <= 0.0 && used_cents <= 0.0 && remaining_cents <= 0.0) {
        let mut row = Map::new();
        row.insert("label".into(), "Usage-based spend".into());
        row.insert("source".into(), "cursor-dashboard".into());
        row.insert("limitUsd".into(), cents_to_usd(limit_cents));
        row.insert("usedUsd".into(), cents_to_usd(used_cents));
        row.insert("remainingUsd".into(), cents_to_usd(remaining_cents));
        windows.push(Value::Object(with_reset(row, reset_at)));
    }

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

// -- the two calls ---------------------------------------------------------------------------

/// Cursor's plan usage over the dashboard service.
pub struct CursorUsage {
    http: Arc<dyn HttpSend>,
    api_url: String,
    version: Live,
    tokens: Arc<dyn AccessToken>,
    provider: String,
}

fn failure(error: ProviderError) -> UsageError {
    UsageError { status: error.status, message: error.message }
}

impl CursorUsage {
    pub fn new(provider: &str, http: Arc<dyn HttpSend>, api_url: Option<String>, version: Live, tokens: Arc<dyn AccessToken>) -> Self {
        Self { http, api_url: api_url.unwrap_or_else(|| API_URL.to_owned()), version, tokens, provider: provider.to_owned() }
    }

    /// `callCursorUnary`: one empty-bodied unary POST; a status of 400 or more is the failure, a
    /// redirect is an answer.
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

    /// `getUsageSnapshot()`.
    pub async fn read(&self) -> Result<Value, UsageError> {
        let token = self.tokens.access_token(false).await.map_err(failure)?;
        let (usage, plan) = futures::future::join(self.call(&token, USAGE_PATH), self.call(&token, PLAN_PATH)).await;
        let usage_body = usage.map_err(failure)?;
        let unwrapped = unwrap_unary_body(&usage_body);
        let usage = decode_message(unwrapped, 0, unwrapped.len(), CURRENT_PERIOD_USAGE).map_err(UsageError::new)?;
        // The plan call may fail; its answer, once received, must decode.
        let plan = match plan {
            Ok(body) => {
                let unwrapped = unwrap_unary_body(&body);
                decode_message(unwrapped, 0, unwrapped.len(), PLAN_INFO_RESPONSE).map_err(UsageError::new)?
            }
            Err(_) => Map::new(),
        };
        let Value::Object(mut snapshot) = normalize_cursor_usage(&usage, &plan) else { unreachable!("a snapshot is an object") };
        snapshot.insert("provider".into(), self.provider.clone().into());
        Ok(Value::Object(snapshot))
    }
}

#[cfg(test)]
#[path = "usage_cursor_tests.rs"]
mod tests;
