//! Node `lib/action-input-contract.mjs`: the text that keeps a per-action input's rules when a
//! provider needs a flat schema.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::PoisonError;
use std::sync::RwLock;

use serde_json::Value;
use serde_json::json;

use super::compat::ajv_meta::json_equal;
use super::flat_schema::merge_flat_schema_property;
use super::js_value::entries;
use super::js_value::join_text;
use super::js_value::truthy;

/// `value?.a?.b?.c`.
fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |node, key| node.get(*key))
}

/// `actionInputContract(schema)`: the allowed input per action, or empty when the schema's
/// `oneOf`/`anyOf` is not a list of action/input branches.
pub fn action_input_contract(schema: &Value) -> String {
    let candidate = schema.get("oneOf").filter(|v| truthy(v)).or_else(|| schema.get("anyOf"));
    let Some(branches) = candidate.and_then(Value::as_array).filter(|list| !list.is_empty()) else {
        return String::new();
    };
    let shaped = branches.iter().all(|branch| {
        at(branch, &["properties", "action", "enum"]).is_some_and(Value::is_array)
            && at(branch, &["properties", "input", "properties"]).is_some_and(truthy)
    });
    if !shaped {
        return String::new();
    }
    let input_of = |branch: &Value| at(branch, &["properties", "input"]).cloned().unwrap_or(Value::Null);
    // Per field name, the distinct [enum, minimum, maximum] it has across the branches.
    let mut variants: Vec<(String, Vec<Value>)> = Vec::new();
    for branch in branches {
        for (name, field) in entries(&input_of(branch)["properties"]) {
            let shape = Value::Array(["enum", "minimum", "maximum"].iter().map(|k| field.get(*k).cloned().unwrap_or(Value::Null)).collect());
            match variants.iter_mut().find(|(known, _)| *known == name) {
                Some((_, seen)) => {
                    if !seen.iter().any(|other| json_equal(other, &shape)) {
                        seen.push(shape);
                    }
                }
                None => variants.push((name, vec![shape])),
            }
        }
    }
    let rows: Vec<String> = branches
        .iter()
        .map(|branch| {
            let input = input_of(branch);
            let required: Vec<&str> = input.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let fields: Vec<String> = entries(&input["properties"])
                .into_iter()
                .map(|(name, field)| {
                    let mut label = format!("{name}{}", if required.contains(&name.as_str()) { "*" } else { "" });
                    let differs = variants.iter().find(|(known, _)| *known == name).is_some_and(|(_, seen)| seen.len() > 1);
                    if differs {
                        if let Some(Value::Array(values)) = field.get("enum").filter(|v| truthy(v)) {
                            label += &format!("={}", values.iter().map(join_text).collect::<Vec<_>>().join("|"));
                        }
                        if let Some(minimum) = field.get("minimum") {
                            label += &format!(">={}", mixdog_js::value_to_string(minimum));
                        }
                        if let Some(maximum) = field.get("maximum") {
                            label += &format!("<={}", mixdog_js::value_to_string(maximum));
                        }
                    }
                    label
                })
                .collect();
            let actions = at(branch, &["properties", "action", "enum"]).and_then(Value::as_array).into_iter().flatten().map(join_text).collect::<Vec<_>>();
            format!("{}({})", actions.join("/"), fields.join(","))
        })
        .collect();
    format!("Allowed input by action (* required): {}.", rows.join("; "))
}

/// A per-action input union: the root's `action` enum and an `input` whose `anyOf` alternatives
/// are object schemas, each titled with the one action it belongs to. Those alternatives as
/// action/input branches, or `None` (`actionInputBranches`).
fn action_input_branches(schema: &Value) -> Option<Vec<Value>> {
    let actions = at(schema, &["properties", "action", "enum"])?.as_array()?;
    let alternatives = at(schema, &["properties", "input", "anyOf"])?.as_array().filter(|list| !list.is_empty())?;
    alternatives
        .iter()
        .map(|alternative| {
            let title = alternative.get("title")?;
            (alternative.get("properties").is_some_and(truthy) && actions.contains(title))
                .then(|| json!({ "properties": { "action": { "enum": [title] }, "input": alternative } }))
        })
        .collect()
}

/// `flattenActionInputUnion`: the flat projection of a per-action input union: `input` becomes the
/// merged field set of every alternative, its description listing the fields per action. Any
/// other schema is returned as is.
pub fn flatten_action_input_union(schema: &Value) -> Value {
    let Some(branches) = action_input_branches(schema) else {
        return schema.clone();
    };
    let mut base = schema["properties"]["input"].as_object().cloned().unwrap_or_default();
    base.shift_remove("anyOf");
    let description = base.shift_remove("description");
    let mut shapes = branches.iter().map(|branch| {
        let mut shape = branch["properties"]["input"].as_object().cloned().unwrap_or_default();
        shape.shift_remove("title");
        shape.shift_remove("description");
        Value::Object(shape)
    });
    let first = shapes.next().expect("a union has at least one alternative");
    let merged = shapes.fold(first, |current, shape| merge_flat_schema_property(Some(&current), &shape));
    if let Value::Object(fields) = merged {
        for (name, field) in fields {
            base.insert(name, field);
        }
    }
    let contract = action_input_contract(&json!({ "oneOf": branches }));
    let described: Vec<String> = description
        .filter(truthy)
        .map(|d| mixdog_js::value_to_string(&d))
        .into_iter()
        .chain((!contract.is_empty()).then_some(contract))
        .collect();
    base.insert("description".into(), Value::String(described.join(" ")));
    let mut flat = schema.clone();
    flat["properties"]["input"] = Value::Object(base);
    flat
}

/// Nested per-action input unions keyed by their flat projection's JSON. A tool advertises the
/// flat projection on every path; only provider paths verified to accept nested alternatives
/// (first-party Anthropic, Claude behind Antigravity) opt in through [`action_input_union_for`].
/// Keyed by content, so a request snapshot's clone still resolves.
static NESTED_BY_FLAT: LazyLock<RwLock<HashMap<String, Value>>> = LazyLock::new(Default::default);

/// `advertiseActionInputUnion`: registers `nested` and returns the flat projection the tool
/// advertises.
pub fn advertise_action_input_union(nested: &Value) -> Value {
    let flat = flatten_action_input_union(nested);
    NESTED_BY_FLAT.write().unwrap_or_else(PoisonError::into_inner).insert(mixdog_js::json_stringify(&flat), nested.clone());
    flat
}

/// `actionInputUnionFor`: the registered nested union for an advertised flat schema, else `schema`.
pub fn action_input_union_for(schema: &Value) -> Value {
    let present = |name: &str| at(schema, &["properties", name]).is_some_and(truthy);
    if !present("action") || !present("input") {
        return schema.clone();
    }
    NESTED_BY_FLAT
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&mixdog_js::json_stringify(schema))
        .cloned()
        .unwrap_or_else(|| schema.clone())
}
