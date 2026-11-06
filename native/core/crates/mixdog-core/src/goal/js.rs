//! JavaScript value semantics the Goal record code depends on. A Goal is a JS object: its key
//! order is the order of the bytes written, so it is kept as an ordered map and edited the way
//! the Node code edits it.

use mixdog_js::{js_trim, json_number, to_number_of, value_to_string};
use serde_json::{Map, Value};

pub type Goal = Map<String, Value>;

/// `clean(value)`: `String(value ?? '').trim()`.
pub fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

/// JS truthiness of a parsed value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number(goal[key])`.
pub fn number(goal: &Goal, key: &str) -> f64 {
    to_number_of(goal.get(key))
}

/// `Number(x) || fallback`.
pub fn or(n: f64, fallback: f64) -> f64 {
    if n.is_nan() || n == 0.0 { fallback } else { n }
}

/// `Math.max(0, Math.floor(Number(goal[key]) || 0))`.
pub fn count(goal: &Goal, key: &str) -> f64 {
    or(number(goal, key), 0.0).floor().max(0.0)
}

pub fn put_num(goal: &mut Goal, key: &str, n: f64) {
    goal.insert(key.to_owned(), json_number(n));
}

pub fn put(goal: &mut Goal, key: &str, value: impl Into<Value>) {
    goal.insert(key.to_owned(), value.into());
}

/// A string field, or empty when it is not a string.
pub fn string(goal: &Goal, key: &str) -> String {
    goal.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// `String(value)` for a template literal: `undefined` reads as "undefined".
pub fn display(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `Math.round`.
pub fn round(x: f64) -> f64 {
    mixdog_js::math::round(x)
}

pub fn now_wall_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}
