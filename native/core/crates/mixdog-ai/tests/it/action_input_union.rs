//! A tool whose input depends on its action: providers that need a flat schema get the merged field set with the
//! per-action rules written into the description, and providers that accept alternatives get the nested form back.

use mixdog_ai::providers::action_input::action_input_union_for;
use mixdog_ai::providers::action_input::advertise_action_input_union;
use mixdog_ai::providers::action_input::flatten_action_input_union;
use serde_json::Value;
use serde_json::json;

fn nested() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["click", "type"] },
            "input": { "anyOf": [
                { "title": "click", "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] },
                { "title": "type", "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
            ] }
        },
        "required": ["action"]
    })
}

#[test]
fn the_flat_projection_merges_every_alternatives_fields_and_lists_them_per_action() {
    let flat = flatten_action_input_union(&nested());
    let input = &flat["properties"]["input"];
    assert!(input.get("anyOf").is_none(), "no alternatives remain");
    let fields: Vec<&str> = input["properties"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(fields, ["x", "y", "text"]);
    assert_eq!(input["description"], "Allowed input by action (* required): click(x*,y*); type(text*).");
}

#[test]
fn a_field_whose_limits_differ_between_actions_shows_them_in_the_description() {
    let schema = json!({
        "properties": {
            "action": { "enum": ["a", "b"] },
            "input": { "anyOf": [
                { "title": "a", "properties": { "n": { "type": "number", "minimum": 1 } } },
                { "title": "b", "properties": { "n": { "type": "number", "minimum": 5 } } }
            ] }
        }
    });
    let flat = flatten_action_input_union(&schema);
    assert_eq!(flat["properties"]["input"]["description"], "Allowed input by action (* required): a(n>=1); b(n>=5).");
}

#[test]
fn a_schema_that_is_not_an_action_union_is_left_alone() {
    let plain = json!({ "type": "object", "properties": { "path": { "type": "string" } } });
    assert_eq!(flatten_action_input_union(&plain), plain);
    let mismatched = json!({
        "properties": { "action": { "enum": ["a"] }, "input": { "anyOf": [{ "title": "other", "properties": { "n": {} } }] } }
    });
    assert_eq!(flatten_action_input_union(&mismatched), mismatched, "an alternative titled with no listed action is no union");
}

#[test]
fn an_advertised_union_is_answered_back_in_its_nested_form_for_its_own_flat_schema_only() {
    let nested = nested();
    let flat = advertise_action_input_union(&nested);
    assert_eq!(flat, flatten_action_input_union(&nested));
    assert_eq!(action_input_union_for(&flat), nested);
    let mut changed = flat.clone();
    changed["properties"]["input"]["description"] = json!("changed");
    assert_eq!(action_input_union_for(&changed), changed, "a schema that was not advertised is returned as given");
}
