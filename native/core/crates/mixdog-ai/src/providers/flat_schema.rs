//! Node `lib/flat-schema-merge.mjs`: merging two property definitions when a compound schema is
//! flattened into one object schema.

use serde_json::Map;
use serde_json::Value;

use super::js_value::js_ordered_map;

/// `mergeFlatSchemaProperty(current, incoming)`: enums union, nested properties merge
/// recursively, and only properties required by both sides stay required. Inputs are never
/// mutated.
pub(crate) fn merge_flat_schema_property(current: Option<&Value>, incoming: &Value) -> Value {
    let Some(current) = current.filter(|c| c.is_object()) else {
        return incoming.clone();
    };
    let Some(incoming_map) = incoming.as_object() else {
        return current.clone();
    };
    let current_map = current.as_object().expect("filtered to objects");
    let mut merged = incoming_map.clone();
    for (key, value) in current_map {
        merged.insert(key.clone(), value.clone());
    }
    let enum_of = |map: &Map<String, Value>| map.get("enum").and_then(Value::as_array).cloned();
    if enum_of(current_map).is_some() || enum_of(incoming_map).is_some() {
        let mut values: Vec<Value> = Vec::new();
        for value in enum_of(current_map)
            .into_iter()
            .flatten()
            .chain(enum_of(incoming_map).into_iter().flatten())
        {
            if !values.contains(&value) {
                values.push(value);
            }
        }
        merged.insert("enum".into(), Value::Array(values));
    }
    if current_map.contains_key("properties") || incoming_map.contains_key("properties") {
        let mut properties = Map::new();
        if let Some(props) = current_map.get("properties").and_then(Value::as_object) {
            for (name, property) in props {
                properties.insert(name.clone(), property.clone());
            }
        }
        if let Some(props) = incoming_map.get("properties").and_then(Value::as_object) {
            for (name, property) in props {
                let next = merge_flat_schema_property(properties.get(name), property);
                properties.insert(name.clone(), next);
            }
        }
        merged.insert("properties".into(), Value::Object(js_ordered_map(properties)));
    }
    match (
        current_map.get("required").and_then(Value::as_array),
        incoming_map.get("required").and_then(Value::as_array),
    ) {
        (Some(a), Some(b)) => {
            let shared: Vec<Value> = a.iter().filter(|name| b.contains(name)).cloned().collect();
            if shared.is_empty() {
                merged.shift_remove("required");
            } else {
                merged.insert("required".into(), Value::Array(shared));
            }
        }
        _ => {
            merged.shift_remove("required");
        }
    }
    Value::Object(merged)
}
