//! Numeric and classification helpers shared by the ledger's reads and writes
//! (`usage-rollup.mjs`, `usage-measurement.mjs`).

use serde_json::Number;
use serde_json::Value;

/// The cost source of a failure that reported no usage: the request log lists it, but
/// statistics and quota totals add no turn for it.
pub const NO_USAGE_COST_SOURCE: &str = "none";

/// Marks a model key as that model's Fast-mode calls.
pub const FAST_KEY: &str = "\u{0}fast";

pub fn route_key(provider: &str, model: &str, fast: bool) -> String {
    if fast {
        format!("{provider}/{model}{FAST_KEY}")
    } else {
        format!("{provider}/{model}")
    }
}

/// A finite positive number, else 0.
pub fn num(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

/// `value || 0` for a JSON number.
pub fn json_or_zero(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| !n.is_nan())
        .unwrap_or(0.0)
}

/// The JSON a JavaScript number serializes to: an integral value is an integer.
pub fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

const BACKGROUND_SOURCES: [&str; 5] = [
    "memory-cycle",
    "schedule",
    "webhook",
    "native-web-search",
    "cache-warm",
];

/// A turn belongs to the user's conversation unless it came from a background runner. An
/// unknown source counts as conversation on purpose.
pub fn is_conversation_source(source_type: Option<&str>) -> bool {
    let id = source_type.map_or_else(String::new, |s| mixdog_js::js_trim(s).to_lowercase());
    !BACKGROUND_SOURCES.contains(&id.as_str())
}

/// Cursor's native agent protocol reports output deltas and context occupancy, not
/// per-request input/cache usage: both its routes are never aggregated as measured spend.
pub fn is_unmeasuring_provider(provider: &str) -> bool {
    provider == "cursor-oauth" || provider == "cursor-api"
}

/// SQL form of "this route's requests ran in Fast mode", over a stored route signature.
pub fn fast_route_sql(signature: &str) -> String {
    format!(
        "(COALESCE(json_extract(json_extract({signature},'$[5]'),'$.requestServiceTier') IN ('fast','priority','ultrafast'),0)
    AND NOT (COALESCE(json_extract({signature},'$[2]'),'')='api'
        AND COALESCE(json_extract(json_extract({signature},'$[5]'),'$.serviceTier'),'')='default'))"
    )
}

/// A stored day number as `YYYY-MM-DD`, in SQL.
pub fn day_text_sql(alias: &str) -> String {
    format!("printf('%04d-%02d-%02d',{alias}.day/10000,({alias}.day/100)%100,{alias}.day%100)")
}

/// Sort key whose byte order is `String.prototype.localeCompare` (ICU root collation) for
/// ASCII text: the primary weights of the whole string (whitespace < punctuation <
/// digits < letters, case-blind), `0x00`, then the tertiary weights (lowercase before
/// uppercase). Other characters sort after ASCII by code point.
pub fn locale_key(text: &str) -> Vec<u8> {
    const SYMBOLS: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    let mut primary = Vec::with_capacity(text.len() + 1);
    let mut tertiary = Vec::with_capacity(text.len());
    for c in text.chars() {
        let weight: Option<Vec<u8>> = match c {
            '\t' => Some(vec![0x01]),
            '\n' => Some(vec![0x02]),
            '\u{b}' => Some(vec![0x03]),
            '\u{c}' => Some(vec![0x04]),
            '\r' => Some(vec![0x05]),
            ' ' => Some(vec![0x06]),
            '0'..='9' => Some(vec![0x60 + (c as u8 - b'0')]),
            'a'..='z' | 'A'..='Z' => Some(vec![0x70 + (c.to_ascii_lowercase() as u8 - b'a')]),
            c if c.is_ascii_control() => None,
            c if c.is_ascii() => SYMBOLS.find(c).map(|i| vec![0x10 + i as u8]),
            c => {
                let lower = c.to_lowercase().next().unwrap_or(c) as u32;
                Some(vec![
                    0xf0,
                    (lower >> 16) as u8,
                    (lower >> 8) as u8,
                    lower as u8,
                ])
            }
        };
        if let Some(weight) = weight {
            primary.extend(weight);
            tertiary.push(if c.is_uppercase() { 0x02 } else { 0x01 });
        }
    }
    primary.push(0x00);
    primary.extend(tertiary);
    primary
}
