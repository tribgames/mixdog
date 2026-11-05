//! Models sometimes hand a tool its object, array, number or boolean
//! argument as the JSON text of that value. When the declared schema has no
//! room for a string, the text is parsed and kept only if the parsed value fits
//! a declared type; anything else stays untouched so real string arguments and
//! malformed text still reach the tool's own validation.

use std::collections::HashSet;

use mixdog_protocol::JsonValue;

const STRUCTURAL: [&str; 6] = ["object", "array", "number", "integer", "boolean", "null"];

fn declared_types(property: &JsonValue, depth: usize, out: &mut HashSet<String>) {
    let Some(map) = property.as_object() else {
        return;
    };
    if depth > 3 {
        return;
    }
    match map.get("type") {
        Some(JsonValue::Array(listed)) => {
            out.extend(listed.iter().filter_map(|t| t.as_str().map(str::to_owned)));
        }
        Some(JsonValue::String(t)) => {
            out.insert(t.clone());
        }
        _ => {}
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = map.get(key).and_then(JsonValue::as_array) {
            for branch in branches {
                declared_types(branch, depth + 1, out);
            }
        }
    }
    if out.is_empty() && map.get("properties").is_some_and(JsonValue::is_object) {
        out.insert("object".into());
    }
    if out.is_empty() && map.get("items").is_some_and(|i| !i.is_null()) {
        out.insert("array".into());
    }
    if map
        .get("enum")
        .and_then(JsonValue::as_array)
        .is_some_and(|e| e.iter().any(JsonValue::is_string))
    {
        out.insert("string".into());
    }
}

fn fits(value: &JsonValue, types: &HashSet<String>) -> bool {
    match value {
        JsonValue::Null => types.contains("null"),
        JsonValue::Array(_) => types.contains("array"),
        JsonValue::Object(_) => types.contains("object"),
        JsonValue::Bool(_) => types.contains("boolean"),
        JsonValue::Number(n) => {
            types.contains("number")
                || (types.contains("integer") && (n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0)))
        }
        JsonValue::String(_) => false,
    }
}

fn parse_json_text(text: &str) -> Option<JsonValue> {
    let trimmed = mixdog_js::js_trim(text);
    let first = trimmed.chars().next()?;
    if !"{[\"0123456789-tfn".contains(first) {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

pub fn coerce_args_to_schema(args: &mut JsonValue, schema: &JsonValue) {
    let (Some(args), Some(properties)) = (
        args.as_object_mut(),
        schema.get("properties").and_then(JsonValue::as_object),
    ) else {
        return;
    };
    let keys: Vec<String> = args.keys().cloned().collect();
    for key in keys {
        let Some(text) = args.get(&key).and_then(JsonValue::as_str) else {
            continue;
        };
        let Some(property) = properties.get(&key) else {
            continue;
        };
        let mut types = HashSet::new();
        declared_types(property, 0, &mut types);
        if types.is_empty() || types.contains("string") {
            continue;
        }
        if !types.iter().any(|t| STRUCTURAL.contains(&t.as_str())) {
            continue;
        }
        if let Some(parsed) = parse_json_text(text)
            && fits(&parsed, &types)
        {
            args.insert(key, parsed);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn json_text_for_structural_properties_is_parsed() {
        let schema = json!({"properties": {"design": {"type": "object"}, "n": {"type": "integer"}, "s": {"type": "string"}, "e": {"enum": ["a"]}}});
        let mut args = json!({"design": "{\"a\":1}", "n": "300", "s": "{\"x\":1}", "e": "1"});
        coerce_args_to_schema(&mut args, &schema);
        assert_eq!(args, json!({"design": {"a": 1}, "n": 300, "s": "{\"x\":1}", "e": "1"}));
        let mut bad = json!({"n": "3.5"});
        coerce_args_to_schema(&mut bad, &schema);
        assert_eq!(bad, json!({"n": "3.5"}));
    }
}
