//! Minimal valid params for any method, generated from the checked-in JSON Schema of the
//! method table: required members only, the first alternative of every choice.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const SCHEMA: &str = include_str!("../../../mixdog-app-protocol/schema/client_methods.json");

pub(crate) struct Samples {
    schema: Value,
}

impl Samples {
    pub(crate) fn new() -> Self {
        Self {
            schema: serde_json::from_str(SCHEMA).expect("golden schema parses"),
        }
    }

    pub(crate) fn params(&self, method: &str) -> Value {
        let row = &self.schema["methods"][method]["params"];
        self.sample(row, "")
    }

    fn sample(&self, schema: &Value, name: &str) -> Value {
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            let target = reference.rsplit('/').next().expect("ref has a name");
            return self.sample(&self.schema["definitions"][target], name);
        }
        if let Some(value) = schema.get("const") {
            return value.clone();
        }
        if let Some(first) = schema.get("enum").and_then(|e| e.get(0)) {
            return first.clone();
        }
        for choice in ["allOf", "oneOf", "anyOf"] {
            if let Some(first) = schema
                .get(choice)
                .and_then(Value::as_array)
                .and_then(|choices| {
                    choices
                        .iter()
                        .find(|choice| choice.get("type") != Some(&json!("null")))
                })
            {
                return self.sample(first, name);
            }
        }
        let kind = match schema.get("type") {
            Some(Value::String(kind)) => kind.as_str(),
            Some(Value::Array(kinds)) => kinds
                .iter()
                .filter_map(Value::as_str)
                .find(|kind| *kind != "null")
                .unwrap_or("null"),
            _ => "object",
        };
        match kind {
            "string" if name == "digest" => json!(format!("sha256:{}", "0".repeat(64))),
            "string" => json!("x"),
            "integer" | "number" => schema
                .get("minimum")
                .and_then(Value::as_f64)
                .map_or(json!(1), |minimum| json!(minimum as i64)),
            "boolean" => json!(false),
            "array" => {
                let wanted = schema.get("minItems").and_then(Value::as_u64).unwrap_or(0);
                let item = schema.get("items").map(|items| self.sample(items, name));
                Value::Array(item.into_iter().cycle().take(wanted as usize).collect())
            }
            "null" => Value::Null,
            _ => {
                let mut object = Map::new();
                let required = schema.get("required").and_then(Value::as_array);
                for key in required.into_iter().flatten().filter_map(Value::as_str) {
                    let property = &schema["properties"][key];
                    object.insert(key.to_owned(), self.sample(property, key));
                }
                Value::Object(object)
            }
        }
    }

    /// `method`'s minimal params with `text` at `pattern` (a free-text pattern: `*` is index 0 of an array or key `k` of a
    /// map, a last `**` the value there), with every member the schema requires on the way; where the schema leaves a value
    /// untyped, objects (arrays for `*`).
    pub(crate) fn with_text(&self, method: &str, pattern: &str, text: &str) -> Value {
        let row = &self.schema["methods"][method]["params"];
        let mut params = self.sample(row, "");
        self.put(&mut params, Some(row), &segments(pattern), text);
        params
    }

    /// A payload no schema types (a notification's or an answer's, which the server passes on unread) with `text` at
    /// `pattern`.
    pub(crate) fn untyped_with_text(&self, pattern: &str, text: &str) -> Value {
        let mut payload = Value::Null;
        self.put(&mut payload, None, &segments(pattern), text);
        payload
    }

    fn resolve<'a>(&'a self, schema: &'a Value) -> &'a Value {
        match schema.get("$ref").and_then(Value::as_str) {
            Some(reference) => self.resolve(&self.schema["definitions"][reference.rsplit('/').next().expect("ref has a name")]),
            None => schema,
        }
    }

    /// The part of `schema` that holds `segment`, and whether it is one alternative of a choice (the value is then that
    /// alternative's sample).
    fn holding<'a>(&'a self, schema: &'a Value, segment: &str) -> Option<(&'a Value, bool)> {
        let schema = self.resolve(schema);
        for choice in ["allOf", "oneOf", "anyOf"] {
            if let Some(parts) = schema.get(choice).and_then(Value::as_array) {
                return parts.iter().find_map(|part| self.holding(part, segment)).map(|(part, _)| (part, choice != "allOf"));
            }
        }
        let map = schema.get("additionalProperties").is_some_and(Value::is_object);
        let fits = if segment == "*" || segment.parse::<usize>().is_ok() {
            is_array(schema) || map
        } else {
            schema["properties"].get(segment).is_some() || map
        };
        fits.then_some((schema, false))
    }

    fn put(&self, at: &mut Value, schema: Option<&Value>, segments: &[&str], text: &str) {
        let Some((&segment, rest)) = segments.split_first() else {
            *at = json!(text);
            return;
        };
        if segment == "**" {
            *at = json!(text);
            return;
        }
        let held = schema.and_then(|schema| self.holding(schema, segment));
        if let Some((alternative, true)) = held {
            *at = self.sample(alternative, "");
        }
        let part = held.map(|(part, _)| part);
        if part.map_or(segment == "*" || segment.parse::<usize>().is_ok(), is_array) {
            if !at.is_array() {
                *at = json!([]);
            }
            let items = part.and_then(|part| part.get("items"));
            let list = at.as_array_mut().expect("an array");
            if list.is_empty() {
                list.push(items.map_or(Value::Null, |items| self.sample(items, "")));
            }
            self.put(&mut list[0], items, rest, text);
        } else {
            if !at.is_object() {
                *at = json!({});
            }
            let key = if segment == "*" { "k" } else { segment };
            let property = part.and_then(|part| part["properties"].get(segment).or_else(|| part.get("additionalProperties").filter(|p| p.is_object())));
            let entry = at
                .as_object_mut()
                .expect("an object")
                .entry(key)
                .or_insert_with(|| property.map_or(Value::Null, |property| self.sample(property, key)));
            self.put(entry, property, rest, text);
        }
    }
}

fn segments(pattern: &str) -> Vec<&str> {
    pattern.split('/').skip(1).collect()
}

fn is_array(schema: &Value) -> bool {
    schema.get("type") == Some(&json!("array")) || schema.get("items").is_some()
}
