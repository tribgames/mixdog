//! The shared JSON-schema value check the desktop tools apply to each input field after their
//! action-specific rules (tools keep their own target relationships). Lengths count Unicode
//! code points, as JSON Schema does.

use serde_json::Value;

fn type_error(schema_type: &str, value: &Value, schema: &Value, path: &str) -> Option<String> {
    match schema_type {
        "null" if !value.is_null() => Some(format!("{path} must be null")),
        "string" => {
            let Some(s) = value.as_str() else { return Some(format!("{path} must be a string")) };
            let len = s.chars().count() as u64;
            if schema.get("minLength").and_then(Value::as_u64).is_some_and(|m| len < m) {
                return Some(format!("{path} requires at least {} characters", schema["minLength"]));
            }
            if schema.get("maxLength").and_then(Value::as_u64).is_some_and(|m| len > m) {
                return Some(format!("{path} accepts at most {} characters", schema["maxLength"]));
            }
            let pattern = schema.get("pattern").and_then(Value::as_str);
            if pattern.is_some_and(|p| !mixdog_js::JsRegex::new(p, "").is_ok_and(|r| r.is_match(s))) {
                return Some(format!("{path} must match the required format"));
            }
            None
        }
        "boolean" if !value.is_boolean() => Some(format!("{path} must be a boolean")),
        "number" if !value.as_f64().is_some_and(f64::is_finite) => Some(format!("{path} must be a finite number")),
        "integer" if !value.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0) => {
            Some(format!("{path} must be an integer"))
        }
        "array" => {
            let Some(items) = value.as_array() else { return Some(format!("{path} must be an array")) };
            if schema.get("minItems").and_then(Value::as_u64).is_some_and(|m| (items.len() as u64) < m) {
                return Some(format!("{path} requires at least {} items", schema["minItems"]));
            }
            if schema.get("maxItems").and_then(Value::as_u64).is_some_and(|m| items.len() as u64 > m) {
                return Some(format!("{path} accepts at most {} items", schema["maxItems"]));
            }
            if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
                let mut seen = std::collections::HashSet::new();
                if !items.iter().all(|i| seen.insert(i.to_string())) {
                    return Some(format!("{path} must contain unique items"));
                }
            }
            let empty = Value::Object(Default::default());
            let item_schema = schema.get("items").unwrap_or(&empty);
            items.iter().enumerate().find_map(|(i, item)| value_error(item, item_schema, &format!("{path}[{i}]")))
        }
        "object" => {
            let Some(object) = value.as_object() else { return Some(format!("{path} must be an object")) };
            let empty = serde_json::Map::new();
            let properties = schema.get("properties").and_then(Value::as_object).unwrap_or(&empty);
            let missing: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|n| !object.contains_key(*n))
                .collect();
            if !missing.is_empty() {
                return Some(format!("{path} requires field(s): {}", missing.join(", ")));
            }
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                let extras: Vec<&str> = object.keys().map(String::as_str).filter(|n| !properties.contains_key(*n)).collect();
                if !extras.is_empty() {
                    return Some(format!("{path} does not accept field(s): {}", extras.join(", ")));
                }
            }
            let no_schema = Value::Object(Default::default());
            for (name, item) in object {
                let field = properties.get(name).or_else(|| schema.get("additionalProperties").filter(|a| a.is_object())).unwrap_or(&no_schema);
                if let Some(e) = value_error(item, field, &format!("{path}.{name}")) {
                    return Some(e);
                }
            }
            None
        }
        _ => None,
    }
}

/// The first violation of `schema` by `value`, worded for the model; `path` names the value.
pub fn value_error(value: &Value, schema: &Value, path: &str) -> Option<String> {
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        let list: Vec<String> = allowed.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect();
        return Some(format!("{path} must be one of: {}", list.join(", ")));
    }
    let mut result = match schema.get("type") {
        Some(Value::Array(types)) => {
            let errors: Vec<Option<String>> =
                types.iter().filter_map(Value::as_str).map(|t| type_error(t, value, schema, path)).collect();
            if errors.iter().any(Option::is_none) {
                None
            } else {
                Some(errors.into_iter().flatten().collect::<Vec<_>>().join(" or "))
            }
        }
        Some(Value::String(t)) => type_error(t, value, schema, path),
        _ => None,
    };
    if result.is_none()
        && let Some(n) = value.as_f64().filter(|_| value.is_number())
    {
        if schema.get("minimum").and_then(Value::as_f64).is_some_and(|m| n < m) {
            result = Some(format!("{path} must be at least {}", schema["minimum"]));
        } else if schema.get("maximum").and_then(Value::as_f64).is_some_and(|m| n > m) {
            result = Some(format!("{path} must be at most {}", schema["maximum"]));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn messages_match_the_node_check() {
        let schema = json!({"type":"object","properties":{"n":{"type":"integer","minimum":1,"maximum":5},"s":{"type":"string","maxLength":2,"enum":["ab","cd"]}},"additionalProperties":false});
        assert_eq!(value_error(&json!({"n":0}), &schema, "x"), Some("x.n must be at least 1".into()));
        assert_eq!(value_error(&json!({"n":1.5}), &schema, "x"), Some("x.n must be an integer".into()));
        assert_eq!(value_error(&json!({"s":"zz"}), &schema, "x"), Some("x.s must be one of: ab, cd".into()));
        assert_eq!(value_error(&json!({"q":1}), &schema, "x"), Some("x does not accept field(s): q".into()));
        assert_eq!(value_error(&json!({"n":3,"s":"ab"}), &schema, "x"), None);
        assert_eq!(
            value_error(&json!(["a", 1]), &json!({"type":"array","items":{"type":"string"}}), "v"),
            Some("v[1] must be a string".into())
        );
    }
}
