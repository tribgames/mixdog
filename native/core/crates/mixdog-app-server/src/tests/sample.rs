//! Minimal valid params for any method, generated from the checked-in JSON Schema of the
//! method table: required members only, the first alternative of every choice.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const SCHEMA: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../mixdog-app-protocol/schema/client_methods.json");

pub(crate) struct Samples {
    schema: Value,
}

impl Samples {
    pub(crate) fn new() -> Self {
        Self {
            schema: serde_json::from_str(&SCHEMA).expect("golden schema parses"),
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
}
