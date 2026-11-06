//! `makeCycleRequestSignature` (`memory-cycle-requests.mjs`), `parseInterval`
//! (`memory-cycle-shared.mjs`) and `periodicCycleDue` (`cycle-scheduler/tick-loop.mjs`).

use mixdog_js::{JsRegex, js_trim, json_stringify, to_number, value_to_string};
use serde_json::{Map, Value};

use crate::memory::error::{MemoryError, Result};

fn normalize(value: &Value, depth: usize) -> Value {
    if depth > 4 {
        return Value::String("[depth]".into());
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| normalize(item, depth + 1)).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().filter(|key| !matches!(key.as_str(), "signal" | "coalescedRetry")).collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), normalize(&map[key], depth + 1));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// FNV-1a over the UTF-16 units, in base 36.
fn short_hash(text: &str) -> String {
    let mut h: u32 = 2_166_136_261;
    for unit in text.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(16_777_619);
    }
    let mut digits = Vec::new();
    let mut n = h;
    loop {
        digits.push(char::from_digit(n % 36, 36).expect("base 36 digit"));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// `makeCycleRequestSignature(...parts)`. A part's keys whose value is undefined are left out of
/// `parts` by the caller (JS drops them).
pub fn make_cycle_request_signature(parts: &[Value]) -> String {
    let normalized = Value::Array(parts.iter().map(|part| normalize(part, 0)).collect());
    short_hash(&json_stringify(&normalized))
}

/// `scheduledCycle1Signature(config)`.
pub fn scheduled_cycle1_signature(config: &Value) -> String {
    make_cycle_request_signature(&["cycle1".into(), config.clone(), Value::Object(Map::new())])
}

/// `parseInterval`: `10m`, `1.5h`, `500 ms`; anything else throws.
pub fn parse_interval(value: &Value) -> Result<f64> {
    let regex = JsRegex::new_static(r"^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$", "");
    let text = value_to_string(value);
    let trimmed = js_trim(&text);
    let caps = regex.captures(trimmed).ok_or_else(|| MemoryError::Runtime(format!("[memory-cycle] invalid interval config: {text}")))?;
    let amount = mixdog_js::string_to_number(caps.get(1).expect("amount group"));
    let unit = match caps.get(2).expect("unit group") {
        "ms" => 1.0,
        "s" => 1000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        _ => 86_400_000.0,
    };
    Ok(amount * unit)
}

/// `periodicCycleDue`: due once `interval_ms` has passed since the last persisted run, or since the
/// cycles started when none is persisted.
pub fn periodic_cycle_due(last_run: f64, cycles_started_at: f64, interval_ms: f64, now: f64) -> bool {
    let persisted = if last_run.is_nan() { 0.0 } else { last_run };
    let anchor = if persisted > 0.0 { persisted } else if cycles_started_at.is_nan() { 0.0 } else { cycles_started_at };
    interval_ms > 0.0 && now - anchor >= interval_ms
}

/// `Number(value) || 0` of a config value.
pub(crate) fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = value.map_or(f64::NAN, to_number);
    if n.is_nan() { 0.0 } else { n }
}
