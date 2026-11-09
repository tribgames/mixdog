//! Grok's gRPC tool registry takes flat tool schemas: no `anyOf`/`oneOf`. This is `normalizeGrokToolSchemas` of
//! the Node core (`providers/lib/grok-tool-schema.mjs`, applied at `grok-oauth.mjs:438`), step for step, on the
//! `parameters` of each tool of the encoded body. Key order follows the JS object spreads (the map keeps insertion
//! order), because prompt-cache prefixes are byte prefixes.

use serde_json::{Map, Value, json};

const ARRAY_DROP_NOTE: &str = "This provider accepts a single value here, not an array.";
const ARRAY_ONLY_NOTE: &str = "Pass one or more values as an array.";
const SCHEMA_MAP_KEYWORDS: [&str; 5] = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_VALUED_KEYWORDS: [&str; 12] = [
    "items", "prefixItems", "additionalProperties", "contains", "allOf", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems",
];

/// JS truthiness of a JSON value (`undefined` is a missing key).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

fn type_is(schema: &Value, name: &str) -> bool {
    get(schema, "type").and_then(Value::as_str) == Some(name)
}

fn type_includes(schema: &Value, name: &str) -> bool {
    type_is(schema, name) || get(schema, "type").and_then(Value::as_array).is_some_and(|types| types.iter().any(|t| t.as_str() == Some(name)))
}

/// `Object.assign`/spread: `over`'s keys replace `base`'s in place, new keys append.
fn spread(mut base: Map<String, Value>, over: &Map<String, Value>) -> Map<String, Value> {
    for (key, value) in over {
        base.insert(key.clone(), value.clone());
    }
    base
}

fn without(map: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    map.iter().filter(|(key, _)| !keys.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn required_keys(schema: &Value) -> Vec<Value> {
    get(schema, "required")
        .and_then(Value::as_array)
        .map(|keys| keys.iter().filter(|key| key.as_str().is_some_and(|s| !s.is_empty())).cloned().collect())
        .unwrap_or_default()
}

fn first_exclusive_required(branches: &[Value]) -> Vec<Value> {
    branches.iter().map(required_keys).find(|keys| !keys.is_empty()).unwrap_or_default()
}

fn push_unique(out: &mut Vec<Value>, value: Value) {
    if !out.contains(&value) {
        out.push(value);
    }
}

fn pure_any_of(schema: &Value) -> Vec<Value> {
    match schema.as_object() {
        Some(map) if map.len() == 1 && map.get("anyOf").is_some_and(Value::is_array) => map["anyOf"].as_array().cloned().unwrap_or_default(),
        _ => vec![schema.clone()],
    }
}

fn merge_object_branch_properties(branches: &[Value]) -> Map<String, Value> {
    let mut properties = Map::new();
    for branch in branches {
        let Some(own) = get(branch, "properties").and_then(Value::as_object) else { continue };
        for (name, schema) in own {
            let Some(existing) = properties.get(name) else {
                properties.insert(name.clone(), schema.clone());
                continue;
            };
            if existing == schema {
                continue;
            }
            let mut deduped: Vec<Value> = Vec::new();
            for alternative in pure_any_of(existing).into_iter().chain(pure_any_of(schema)) {
                push_unique(&mut deduped, alternative);
            }
            let merged = if deduped.iter().all(|v| type_is(v, "object") || truthy(get(v, "properties"))) {
                let base = deduped[0].as_object().map(|first| without(first, &["required", "properties"])).unwrap_or_default();
                let required: Vec<Value> = required_keys(&deduped[0]).into_iter().filter(|key| deduped.iter().all(|v| required_keys(v).contains(key))).collect();
                let mut out = spread(base, &Map::from_iter([("type".to_owned(), json!("object"))]));
                out.insert("properties".into(), Value::Object(merge_object_branch_properties(&deduped)));
                if !required.is_empty() {
                    out.insert("required".into(), Value::Array(required));
                }
                Value::Object(out)
            } else if deduped.iter().all(|v| get(v, "enum").is_some_and(Value::is_array) && get(v, "type") == get(&deduped[0], "type")) {
                let mut values = Vec::new();
                for value in deduped.iter().flat_map(|v| get(v, "enum").and_then(Value::as_array).cloned().unwrap_or_default()) {
                    push_unique(&mut values, value);
                }
                let mut out = deduped[0].as_object().cloned().unwrap_or_default();
                out.insert("enum".into(), Value::Array(values));
                Value::Object(out)
            } else if deduped.len() == 1 {
                deduped[0].clone()
            } else {
                json!({ "anyOf": deduped })
            };
            properties.insert(name.clone(), merged);
        }
    }
    properties
}

fn describes_array(schema: &Value) -> bool {
    schema.is_object() && type_includes(schema, "array")
}

fn describes_scalar(schema: &Value) -> bool {
    if !schema.is_object() || describes_array(schema) || type_is(schema, "object") || truthy(get(schema, "properties")) {
        return false;
    }
    get(schema, "type").is_some_and(|t| t.is_string() || t.is_array()) || get(schema, "enum").is_some_and(Value::is_array)
}

fn project_dropped_branches(schema: Value, dropped: &[&Value]) -> Value {
    let note = if describes_array(&schema) {
        dropped.iter().any(|b| describes_scalar(b)).then_some(ARRAY_ONLY_NOTE)
    } else {
        dropped.iter().any(|b| describes_array(b)).then_some(ARRAY_DROP_NOTE)
    };
    let Some(note) = note else { return schema };
    let description = get(&schema, "description").and_then(Value::as_str).unwrap_or("").trim().to_owned();
    if description.contains(note) {
        return schema;
    }
    let mut out = schema.as_object().cloned().unwrap_or_default();
    out.insert("description".into(), Value::String(if description.is_empty() { note.to_owned() } else { format!("{description} {note}") }));
    Value::Object(out)
}

/// The index in `branches` of the branch a flatten keeps: the array branch of a "one or many" field, else the first object.
fn preferred_branch(branches: &[Value]) -> Option<usize> {
    let objects: Vec<usize> = (0..branches.len()).filter(|&i| branches[i].is_object()).collect();
    let arrays: Vec<usize> = objects.iter().copied().filter(|&i| describes_array(&branches[i])).collect();
    if arrays.len() == 1 && objects.len() > 1 && objects.iter().all(|&i| i == arrays[0] || describes_scalar(&branches[i])) {
        return Some(arrays[0]);
    }
    objects.first().copied()
}

fn normalize_property_schema(schema: &Value) -> Value {
    let Some(map) = schema.as_object() else { return schema.clone() };
    let branches: Vec<Value> = ["anyOf", "oneOf"].iter().flat_map(|key| map.get(*key).and_then(Value::as_array).cloned().unwrap_or_default()).collect();
    if !branches.is_empty() {
        if let Some(kept) = preferred_branch(&branches) {
            let siblings = without(map, &["anyOf", "oneOf"]);
            let merged = Value::Object(spread(branches[kept].as_object().cloned().unwrap_or_default(), &siblings));
            let dropped: Vec<&Value> = branches.iter().enumerate().filter(|(i, _)| *i != kept).map(|(_, b)| b).collect();
            return normalize_property_schema(&project_dropped_branches(merged, &dropped));
        }
    }
    let mut result = map.clone();
    for key in SCHEMA_MAP_KEYWORDS {
        if let Some(children) = map.get(key).and_then(Value::as_object) {
            let normalized: Map<String, Value> = children.iter().map(|(name, child)| (name.clone(), normalize_property_schema(child))).collect();
            result.insert(key.to_owned(), Value::Object(normalized));
        }
    }
    for key in SCHEMA_VALUED_KEYWORDS {
        match map.get(key) {
            Some(Value::Array(children)) => {
                result.insert(key.to_owned(), Value::Array(children.iter().map(normalize_property_schema).collect()));
            }
            Some(child @ Value::Object(_)) => {
                result.insert(key.to_owned(), normalize_property_schema(child));
            }
            _ => {}
        }
    }
    Value::Object(result)
}

fn is_object_branch(branch: &Value) -> bool {
    branch.is_object() && (type_includes(branch, "object") || get(branch, "properties").is_some_and(Value::is_object))
}

fn js_text(value: &Value) -> String {
    value.as_str().map_or_else(|| value.to_string(), str::to_owned)
}

/// `actionInputContract`: the per-action input rules of a `oneOf`/`anyOf` of action/input branches, else empty.
fn action_input_contract(schema: &Value) -> String {
    let Some(branches) = [get(schema, "oneOf"), get(schema, "anyOf")].into_iter().find(|b| truthy(*b)).flatten().and_then(Value::as_array) else { return String::new() };
    let action_enum = |branch: &Value| get(branch, "properties").and_then(|p| get(p, "action")).and_then(|a| get(a, "enum")).and_then(Value::as_array).cloned();
    let input_properties = |branch: &Value| get(branch, "properties").and_then(|p| get(p, "input")).and_then(|i| get(i, "properties")).and_then(Value::as_object).cloned();
    if branches.is_empty() || !branches.iter().all(|b| action_enum(b).is_some() && input_properties(b).is_some()) {
        return String::new();
    }
    let mut variants: Map<String, Value> = Map::new();
    for branch in branches {
        for (name, field) in input_properties(branch).unwrap_or_default() {
            let key = json!([get(&field, "enum").cloned().unwrap_or(Value::Null), get(&field, "minimum").cloned().unwrap_or(Value::Null), get(&field, "maximum").cloned().unwrap_or(Value::Null)]).to_string();
            let entry = variants.entry(name).or_insert_with(|| Value::Array(Vec::new()));
            push_unique(entry.as_array_mut().unwrap(), Value::String(key));
        }
    }
    let rows: Vec<String> = branches
        .iter()
        .map(|branch| {
            let input = get(get(branch, "properties").unwrap(), "input").unwrap();
            let required: Vec<Value> = get(input, "required").and_then(Value::as_array).cloned().unwrap_or_default();
            let fields: Vec<String> = input_properties(branch)
                .unwrap_or_default()
                .iter()
                .map(|(name, field)| {
                    let mut label = format!("{name}{}", if required.contains(&Value::String(name.clone())) { "*" } else { "" });
                    if variants[name].as_array().is_some_and(|set| set.len() > 1) {
                        if let Some(values) = get(field, "enum").and_then(Value::as_array) {
                            label += &format!("={}", values.iter().map(js_text).collect::<Vec<_>>().join("|"));
                        }
                        if let Some(min) = get(field, "minimum") {
                            label += &format!(">={}", js_text(min));
                        }
                        if let Some(max) = get(field, "maximum") {
                            label += &format!("<={}", js_text(max));
                        }
                    }
                    label
                })
                .collect();
            format!("{}({})", action_enum(branch).unwrap_or_default().iter().map(js_text).collect::<Vec<_>>().join("/"), fields.join(","))
        })
        .collect();
    format!("Allowed input by action (* required): {}.", rows.join("; "))
}

fn merged_schema_properties(root: &Map<String, Value>, object_branches: &[Value]) -> Option<Map<String, Value>> {
    let root_properties = root.get("properties");
    let mut properties = (object_branches.iter().any(|b| truthy(get(b, "properties"))) || truthy(root_properties)).then(|| merge_object_branch_properties(object_branches));
    if let (Some(properties), Some(own)) = (properties.as_mut(), root_properties.and_then(Value::as_object)) {
        for (name, property) in own {
            let combined = properties.get(name).cloned();
            let merged = match &combined {
                Some(combined) if type_is(property, "object") && !truthy(get(property, "properties")) && type_is(combined, "object") => {
                    let mut out = spread(combined.as_object().cloned().unwrap_or_default(), property.as_object().unwrap_or(&Map::new()));
                    if let Some(inner) = get(combined, "properties") {
                        out.insert("properties".into(), inner.clone());
                    }
                    Value::Object(out)
                }
                _ => property.clone(),
            };
            properties.insert(name.clone(), merged);
        }
    }
    properties
}

fn union_required(root: &Value, object_branches: &[Value]) -> Vec<Value> {
    let first = get(&object_branches[0], "required").and_then(Value::as_array).cloned().unwrap_or_default();
    let in_every: Vec<Value> = first.into_iter().filter(|key| object_branches.iter().all(|b| get(b, "required").and_then(Value::as_array).is_some_and(|r| r.contains(key)))).collect();
    let mut out = Vec::new();
    for key in required_keys(root).into_iter().chain(in_every.iter().cloned()).chain(if in_every.is_empty() { first_exclusive_required(object_branches) } else { Vec::new() }) {
        push_unique(&mut out, key);
    }
    out
}

fn normalize_tool_schema(schema: &Value) -> Value {
    let Some(map) = schema.as_object().filter(|m| m.get("anyOf").is_some_and(Value::is_array) || m.get("oneOf").is_some_and(Value::is_array)) else {
        return normalize_property_schema(schema);
    };
    let root = without(map, &["anyOf", "oneOf"]);
    let branches: Vec<Value> = ["anyOf", "oneOf"].iter().flat_map(|key| map.get(*key).and_then(Value::as_array).cloned().unwrap_or_default()).collect();
    let object_branches: Vec<Value> = branches.iter().filter(|b| is_object_branch(b)).cloned().collect();
    if object_branches.is_empty() {
        let mut required = Vec::new();
        for key in required_keys(&Value::Object(root.clone())).into_iter().chain(first_exclusive_required(&branches)) {
            push_unique(&mut required, key);
        }
        let mut out = root.clone();
        out.insert("type".into(), json!("object"));
        if !required.is_empty() {
            out.insert("required".into(), Value::Array(required));
        }
        if !root.contains_key("additionalProperties") {
            out.insert("additionalProperties".into(), Value::Bool(true));
        }
        return normalize_property_schema(&Value::Object(out));
    }
    let mut properties = merged_schema_properties(&root, &object_branches);
    let contract = action_input_contract(schema);
    if !contract.is_empty() {
        if let Some(input) = properties.as_mut().and_then(|p| p.get_mut("input")) {
            let mut with_description = input.as_object().cloned().unwrap_or_default();
            with_description.insert("description".into(), Value::String(contract));
            *input = Value::Object(with_description);
        }
    }
    let required = union_required(&Value::Object(root.clone()), &object_branches);
    let assigned = object_branches.iter().fold(Map::new(), |acc, branch| spread(acc, branch.as_object().unwrap()));
    let mut out = spread(without(&assigned, &["properties", "required"]), &without(&root, &["properties", "required"]));
    out.insert("type".into(), json!("object"));
    if let Some(properties) = properties {
        out.insert("properties".into(), Value::Object(properties));
    }
    if !required.is_empty() {
        out.insert("required".into(), Value::Array(required));
    }
    normalize_property_schema(&Value::Object(out))
}

/// The encoded request body with each tool's `parameters` flattened for Grok; `None` when no tool changes.
pub fn flatten_body(body: &[u8]) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let mut changed = false;
    for tool in parsed.get_mut("tools")?.as_array_mut()? {
        if let Some(parameters) = tool.get_mut("parameters") {
            let flat = normalize_tool_schema(parameters);
            if flat != *parameters {
                *parameters = flat;
                changed = true;
            }
        }
    }
    changed.then(|| serde_json::to_vec(&parsed).ok()).flatten()
}

#[cfg(test)]
mod tests;
