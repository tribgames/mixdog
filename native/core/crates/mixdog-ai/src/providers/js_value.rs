//! JavaScript's reading of a JSON value, for the ports of Node code that tests a schema field the
//! way JavaScript does (`a || b`, `Object.entries`, `Array.prototype.join`).

use serde_json::Map;
use serde_json::Value;

/// JavaScript truthiness.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Object.entries(value)`: an object's entries in JavaScript key order, an array's indices, a
/// string's characters; nothing for any other value.
pub(crate) fn entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Object(map) => mixdog_js::js_object_keys(map).into_iter().map(|key| (key.clone(), map[key].clone())).collect(),
        Value::Array(list) => list.iter().enumerate().map(|(i, child)| (i.to_string(), child.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `{ ...value }`: the entries of an object (or array) as an object, else empty.
pub(crate) fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(object @ (Value::Object(_) | Value::Array(_))) => entries(object).into_iter().collect(),
        _ => Map::new(),
    }
}

/// An object whose keys are in JavaScript's order.
pub(crate) fn js_ordered_map(map: Map<String, Value>) -> Map<String, Value> {
    let keys: Vec<String> = mixdog_js::js_object_keys(&map).into_iter().cloned().collect();
    keys.into_iter()
        .map(|key| {
            let value = map[&key].clone();
            (key, value)
        })
        .collect()
}

/// `String(value)` as `Array.prototype.join` renders an element: `null` is empty.
pub(crate) fn join_text(value: &Value) -> String {
    if value.is_null() { String::new() } else { mixdog_js::value_to_string(value) }
}
