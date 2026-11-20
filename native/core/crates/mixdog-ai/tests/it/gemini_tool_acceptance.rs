//! Which tools a Gemini endpoint is offered. One declaration it would reject fails the whole request, so each tool's
//! schema is checked first: a tool is sent as written, or rebuilt once from the lowered schema, or left out and
//! reported with where in its schema the problem is.

use mixdog_ai::providers::compat::schema::ToolExclusion;
use mixdog_ai::providers::google::tool_accept::Declarations;
use mixdog_ai::providers::google::tool_accept::function_declarations;
use mixdog_ai::providers::google::tool_accept::gemini_accepted_tools;
use mixdog_ai::providers::google::tool_accept::gemini_tool_exclusion;
use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;
use serde_json::json;

fn tool(name: &str, schema: Value) -> ToolDefinition {
    ToolDefinition { name: name.into(), description: format!("{name} tool"), input_schema: schema, defer_loading: false, freeform: None }
}

fn plain() -> Value {
    json!({"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]})
}

fn accepted(tools: &[ToolDefinition]) -> (Vec<ToolDefinition>, Vec<ToolExclusion>) {
    let mut left_out = Vec::new();
    let kept = gemini_accepted_tools(tools, &mut |e| left_out.push(e));
    (kept, left_out)
}

#[test]
fn a_plain_object_schema_is_sent_as_written_and_declared_as_legacy_parameters() {
    let tools = [tool("lookup", plain())];
    let (kept, left_out) = accepted(&tools);
    assert!(left_out.is_empty());
    assert_eq!(kept[0].input_schema, plain());
    let mut reported = Vec::new();
    let declarations = function_declarations(&tools, Declarations::Validated, &mut |e| reported.push(e));
    assert!(reported.is_empty());
    assert_eq!(declarations, [json!({"name": "lookup", "description": "lookup tool", "parameters": plain()})]);
}

#[test]
fn a_tool_without_a_schema_is_declared_without_one() {
    let tools = [tool("ping", Value::Null)];
    let (kept, left_out) = accepted(&tools);
    assert!((kept.len(), left_out.len()) == (1, 0));
    let declarations = function_declarations(&tools, Declarations::Validated, &mut |_| panic!("nothing to report"));
    assert_eq!(declarations, [json!({"name": "ping", "description": "ping tool"})]);
    assert!(gemini_tool_exclusion(&tools[0]).is_none());
}

#[test]
fn a_schema_the_legacy_subset_cannot_say_exactly_travels_as_a_json_schema() {
    // `additionalProperties: false` is a constraint the subset has no word for.
    let strict = json!({"type": "object", "properties": {"key": {"type": "string"}}, "additionalProperties": false, "x-vendor": 1});
    let declarations = function_declarations(&[tool("strict", strict)], Declarations::Validated, &mut |_| panic!("accepted"));
    assert!(declarations[0].get("parameters").is_none());
    assert_eq!(
        declarations[0]["parametersJsonSchema"],
        json!({"type": "object", "properties": {"key": {"type": "string"}}, "additionalProperties": false}),
        "vendor keys are removed, constraints kept"
    );
}

#[test]
fn a_schema_with_a_reference_that_resolves_is_accepted_as_written() {
    let schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {"a": {"$ref": "#/definitions/A"}},
        "definitions": {"A": {"type": "string"}},
    });
    let (kept, left_out) = accepted(&[tool("refs", schema.clone())]);
    assert!(left_out.is_empty(), "{left_out:?}");
    assert_eq!(kept[0].input_schema, schema, "a JSON-schema declaration takes references itself");
}

#[test]
fn a_draft_04_or_07_construct_gemini_rejects_is_rebuilt_from_the_lowered_schema_instead_of_the_tool_being_left_out() {
    let tuple = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {"p": {"type": "array", "items": [{"type": "string"}, {"type": "number"}]}},
    });
    let (kept, left_out) = accepted(&[tool("tuple", tuple.clone())]);
    assert!(left_out.is_empty(), "{left_out:?}");
    assert_ne!(kept[0].input_schema, tuple, "the schema that is sent is the lowered one");
    assert!(!kept[0].input_schema["properties"]["p"]["items"].is_array(), "{}", kept[0].input_schema);

    let boolean_bound = json!({
        "$schema": "http://json-schema.org/draft-04/schema#",
        "type": "object",
        "properties": {"n": {"type": "number", "minimum": 1, "exclusiveMinimum": true}},
    });
    let (kept, left_out) = accepted(&[tool("bound", boolean_bound)]);
    assert!(left_out.is_empty(), "{left_out:?}");
    assert!(!kept[0].input_schema["properties"]["n"]["exclusiveMinimum"].is_boolean(), "{}", kept[0].input_schema);
}

#[test]
fn a_tool_whose_schema_cannot_be_made_acceptable_is_left_out_and_reported_where_it_fails() {
    let cases: [(&str, Value, &str); 4] = [
        ("a root that is not an object", json!({"type": "string"}), "/type"),
        ("an unresolvable reference", json!({"type": "object", "properties": {"a": {"$ref": "#/definitions/Missing"}}}), "/properties/a"),
        ("a schema that is no object at all", json!("not a schema"), ""),
        ("a numeric schema", json!(7), ""),
    ];
    for (what, schema, pointer) in cases {
        let (kept, left_out) = accepted(&[tool("bad", schema.clone())]);
        assert!(kept.is_empty(), "{what}: the tool must not be sent");
        assert_eq!(left_out.len(), 1, "{what}");
        assert_eq!((left_out[0].name.as_str(), left_out[0].index), ("bad", 0), "{what}");
        assert!(left_out[0].pointer.starts_with(pointer), "{what}: {}", left_out[0].pointer);
        assert!(!left_out[0].reason.is_empty() && left_out[0].message.contains("bad"), "{what}: {:?}", left_out[0]);
        assert_eq!(gemini_tool_exclusion(&tool("bad", schema)).as_ref(), Some(&left_out[0]), "{what}: one rule for the list and the single tool");
    }
}

#[test]
fn the_good_tools_of_a_batch_are_kept_in_order_and_the_bad_one_is_reported_by_its_position() {
    let tools = [tool("first", plain()), tool("bad", json!({"type": "string"})), tool("last", plain())];
    let (kept, left_out) = accepted(&tools);
    assert_eq!(kept.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["first", "last"]);
    assert_eq!(left_out.iter().map(|e| (e.name.as_str(), e.index)).collect::<Vec<_>>(), [("bad", 1)]);
    let mut reported = Vec::new();
    let declarations = function_declarations(&tools, Declarations::Validated, &mut |e| reported.push(e));
    assert_eq!(declarations.iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["first", "last"]);
    assert_eq!(reported, left_out);
}

#[test]
fn another_model_family_behind_the_same_endpoint_gets_every_tool_converted_as_written() {
    let tools = [tool("first", plain()), tool("odd", json!({"type": "string"}))];
    let declarations = function_declarations(&tools, Declarations::Plain, &mut |e| panic!("plain mode reports nothing: {e:?}"));
    assert_eq!(declarations.iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["first", "odd"]);
}

#[test]
fn a_required_name_that_is_not_a_declared_property_does_not_reach_gemini() {
    let undeclared = json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a", "b"]});
    let mut left_out = Vec::new();
    let declarations = function_declarations(&[tool("t", undeclared)], Declarations::Validated, &mut |e| left_out.push(e));
    assert!(left_out.is_empty(), "{left_out:?}");
    // Nothing a tool requires is silently dropped (that would widen what it accepts): the name stays required, and in the
    // legacy `parameters` form it is declared as an explicit conflict property so the declaration is valid.
    let declaration = &declarations[0];
    let (key, schema) = if declaration.get("parameters").is_some() {
        ("parameters", &declaration["parameters"])
    } else {
        ("parametersJsonSchema", &declaration["parametersJsonSchema"])
    };
    let required = schema["required"].as_array().cloned().unwrap_or_default();
    assert_eq!(required, [json!("a"), json!("b")], "{declaration}");
    if key == "parameters" {
        assert!(schema["properties"].get("b").is_some(), "a required name is declared: {declaration}");
    }
}
