//! The JavaScript object semantics the digests rely on, over a parsed JSON value: enumeration with integer-like keys
//! first, strict equality, `Array.length` and `String.length`, truthiness, `Math.round(x * 100) / 100`, and the removal
//! that keeps the other keys in place (`delete`).

use mixdog_js::{js_object_keys, json_number, json_stringify, math, to_number_of, utf16_len};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

pub type Object = Map<String, Value>;

/// The value of the MSO "mixed/undefined" sentinel PowerPoint (COM) reports.
pub const MSO_UNDEFINED: f64 = -2_147_483_648.0;

/// `Object.entries(map)`: integer-like keys first in ascending order, then the others in insertion order.
pub fn entries(map: &Object) -> Vec<(&String, &Value)> {
    js_object_keys(map).into_iter().map(|key| (key, &map[key.as_str()])).collect()
}

/// `delete map[key]`: the other keys keep their places.
pub fn remove(map: &mut Object, key: &str) {
    map.shift_remove(key);
}

/// `Boolean(value)` of a value that may be absent.
pub fn is_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `value === text`.
pub fn is_str(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(own)) if own == text)
}

/// `value === flag`.
pub fn is_bool(value: Option<&Value>, flag: bool) -> bool {
    matches!(value, Some(Value::Bool(own)) if *own == flag)
}

/// `value === number`.
pub fn is_number(value: Option<&Value>, number: f64) -> bool {
    matches!(value, Some(Value::Number(own)) if own.as_f64() == Some(number))
}

/// `value === 0 || value === false`.
pub fn is_zero_or_false(value: &Value) -> bool {
    is_number(Some(value), 0.0) || is_bool(Some(value), false)
}

/// `Number(value) > 0`.
pub fn is_positive(value: Option<&Value>) -> bool {
    to_number_of(value) > 0.0
}

/// `Boolean(Number(value))`.
pub fn number_truthy(value: Option<&Value>) -> bool {
    let number = to_number_of(value);
    number != 0.0 && !number.is_nan()
}

/// `a === b` for the values of parsed JSON: primitives by value, an object or array never (two parsed containers are
/// never the same object); an absent value equals only an absent one.
pub fn strict_equals(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// `value?.length` of an array or a string (UTF-16 units); absent for anything else.
pub fn js_length(value: Option<&Value>) -> Option<usize> {
    match value {
        Some(Value::Array(items)) => Some(items.len()),
        Some(Value::String(text)) => Some(utf16_len(text)),
        _ => None,
    }
}

/// `Math.round(value * 100) / 100` for a number; any other value as it is.
pub fn round2(value: &Value) -> Value {
    match value {
        Value::Number(number) => {
            let x = number.as_f64().unwrap_or(f64::NAN);
            json_number(math::round(x * 100.0) / 100.0)
        }
        other => other.clone(),
    }
}

/// `roundAll`: every entry but the MSO sentinel, rounded to the hundredth.
pub fn round_all(object: &Object) -> Object {
    entries(object)
        .into_iter()
        .filter(|(_, value)| value.as_f64() != Some(MSO_UNDEFINED))
        .map(|(key, value)| (key.clone(), round2(value)))
        .collect()
}

/// `{ ...object }` without the entries `keep` refuses.
pub fn filtered(object: &Object, keep: impl Fn(&str, &Value) -> bool) -> Object {
    entries(object).into_iter().filter(|(key, value)| keep(key, value)).map(|(key, value)| (key.clone(), value.clone())).collect()
}

/// `withoutEmpty` of an object: without its null entries and empty lists, nested objects likewise.
pub fn without_empty_object(map: &Object) -> Object {
    let mut kept = Object::new();
    for (key, entry) in entries(map) {
        if entry.is_null() || matches!(entry, Value::Array(items) if items.is_empty()) {
            continue;
        }
        kept.insert(key.clone(), without_empty(entry));
    }
    kept
}

/// `withoutEmpty`: an object without its null entries and empty lists, nested objects likewise; any other value as it is.
pub fn without_empty(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(without_empty_object(map)),
        other => other.clone(),
    }
}

/// `sameValue`: both present and serialising alike.
pub fn same_value(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(a), Some(b)) => json_stringify(a) == json_stringify(b),
        _ => false,
    }
}

/// `digestObjectWith`: a digest step applied to an object; anything else passes through.
pub fn digest_object_with(entry: &Value, digest: impl Fn(&Object) -> Object) -> Value {
    match entry {
        Value::Object(map) => Value::Object(digest(map)),
        other => other.clone(),
    }
}
