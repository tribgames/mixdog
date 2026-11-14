//! `shared/values.mjs`.

use mixdog_js::{js_trim, js_words, json_parse, json_stringify, slice_utf16, to_number_of, value_to_string};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// `plainObject`: a non-null object that is not an array.
pub fn plain_object(value: &Value) -> bool {
    value.is_object()
}

/// JavaScript truthiness of a parsed JSON value (`Boolean(value)`).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `clone`: `JSON.parse(JSON.stringify(value))`, so a number comes back as V8 prints it, and an object lists its
/// integer-like keys first. Null stays null.
pub fn clone(value: &Value) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    json_parse(&json_stringify(value)).expect("JSON.stringify output parses")
}

/// `stableValue`: every object's keys in the order `Array.prototype.sort` gives them (UTF-16 code units).
pub fn stable_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(stable_value).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), stable_value(&map[key]));
            }
            Value::Object(sorted)
        }
        other => other.clone(),
    }
}

/// `sha256(value)` as lower-case hex.
pub fn sha256(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

/// `clamp(value, minimum, maximum)` for a number: `Math.min(maximum, Math.max(minimum, Number(value) || 0))`.
pub fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    let number = if value.is_nan() || value == 0.0 { 0.0 } else { value };
    mixdog_js::math::min(maximum, mixdog_js::math::max(minimum, number))
}

/// [`clamp`] of a value that may be absent or of any type (`Number(value)`).
pub fn clamp_of(value: Option<&Value>, minimum: f64, maximum: f64) -> f64 {
    clamp(to_number_of(value), minimum, maximum)
}

/// `compact(value, maximum)` for a text: trimmed, every white-space run one space, cut to `maximum` UTF-16 units.
pub fn compact(value: &str, maximum: usize) -> String {
    let words: Vec<&str> = js_words(js_trim(value)).collect();
    slice_utf16(&words.join(" "), maximum)
}

/// [`compact`] of a value of any type: `String(value || '')`.
pub fn compact_value(value: &Value, maximum: usize) -> String {
    if truthy(value) { compact(&value_to_string(value), maximum) } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clone_round_trips_through_json() {
        let source = json!({ "b": 1, "2": "two", "a": [1.5, null], "1": true });
        let copy = clone(&source);
        assert_eq!(json_stringify(&copy), r#"{"1":true,"2":"two","b":1,"a":[1.5,null]}"#);
        assert_eq!(clone(&Value::Null), Value::Null);
    }

    #[test]
    fn stable_value_sorts_keys_by_code_unit() {
        let sorted = stable_value(&json!({ "b": { "z": 1, "a": 2 }, "B": [ { "y": 1, "x": 2 } ], "a": 0 }));
        assert_eq!(json_stringify(&sorted), r#"{"B":[{"x":2,"y":1}],"a":0,"b":{"a":2,"z":1}}"#);
        assert_eq!(stable_value(&json!("text")), json!("text"));
    }

    #[test]
    fn sha256_is_hex() {
        assert_eq!(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn clamp_treats_nan_and_zero_as_zero() {
        assert_eq!(clamp(f64::NAN, 0.0, 1.0), 0.0);
        assert_eq!(clamp(5.0, 0.0, 1.0), 1.0);
        assert_eq!(clamp(-5.0, 0.0, 1.0), 0.0);
        assert_eq!(clamp(0.25, 0.0, 1.0), 0.25);
        assert_eq!(clamp_of(Some(&json!("0.5")), 0.0, 1.0), 0.5);
        assert_eq!(clamp_of(None, 0.0, 1.0), 0.0);
    }

    #[test]
    fn compact_collapses_white_space_and_cuts() {
        assert_eq!(compact("  a \n\t b  c ", 120), "a b c");
        assert_eq!(compact("abcdef", 3), "abc");
        assert_eq!(compact_value(&json!(0), 10), "");
        assert_eq!(compact_value(&json!(12), 10), "12");
        assert_eq!(compact_value(&Value::Null, 10), "");
    }
}
