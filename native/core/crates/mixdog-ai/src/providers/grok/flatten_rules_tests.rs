//! Grok's tool registry takes flat tool schemas: a tool whose parameters offer alternatives is sent with one object
//! schema that holds every alternative's fields.

use serde_json::Value;
use serde_json::json;

use super::tool_schema::flatten_tools;

fn flattened(parameters: Value) -> (Value, bool) {
    let mut body = json!({ "tools": [{ "name": "t", "parameters": parameters }] });
    let done = flatten_tools(&mut body).expect("flattens");
    (body["tools"][0]["parameters"].clone(), done.changed)
}

fn keys(value: &Value) -> Vec<&str> {
    value.as_object().unwrap().keys().map(String::as_str).collect()
}

#[test]
fn a_schema_without_alternatives_is_sent_as_it_is() {
    let plain = json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] });
    let (sent, changed) = flattened(plain.clone());
    assert_eq!(sent, plain);
    assert!(!changed);
}

#[test]
fn alternatives_at_the_root_become_one_object_with_every_branchs_fields() {
    let (sent, changed) = flattened(json!({
        "anyOf": [
            { "type": "object", "properties": { "a": { "type": "string" }, "b": { "type": "number" } }, "required": ["a"] },
            { "type": "object", "properties": { "a": { "type": "string" }, "c": { "type": "boolean" } }, "required": ["a", "c"] }
        ]
    }));
    assert!(changed);
    assert_eq!(sent["type"], "object");
    assert!(sent.get("anyOf").is_none() && sent.get("oneOf").is_none());
    assert_eq!(keys(&sent["properties"]), ["a", "b", "c"]);
    assert_eq!(sent["required"], json!(["a"]), "only what every alternative requires stays required");
}

#[test]
fn alternatives_inside_a_property_are_replaced_by_one_of_them() {
    let (sent, changed) = flattened(json!({
        "type": "object",
        "properties": { "value": { "description": "d", "anyOf": [{ "type": "string" }, { "type": "number" }] } }
    }));
    assert!(changed);
    let value = &sent["properties"]["value"];
    assert!(value.get("anyOf").is_none(), "no alternatives remain: {value}");
    assert_eq!(value["description"], "d", "the property's own words stay");
}

#[test]
fn per_action_alternatives_list_what_each_action_takes_in_the_input_description() {
    let (sent, _) = flattened(json!({
        "oneOf": [
            { "type": "object", "properties": { "action": { "enum": ["click"] }, "input": { "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] } } },
            { "type": "object", "properties": { "action": { "enum": ["type"] }, "input": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } } }
        ]
    }));
    assert_eq!(sent["properties"]["input"]["description"], "Allowed input by action (* required): click(x*); type(text*).");
}
