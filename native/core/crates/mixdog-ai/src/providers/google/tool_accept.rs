//! Which tools a Gemini wire accepts (`gemini-schema.mjs`: `geminiAcceptedTools`,
//! `geminiToolExclusion`, and the declaration step of `toGeminiTools`).
//!
//! A Gemini endpoint rejects the whole request for one bad declaration. Each tool's declaration
//! (`parameters` or `parametersJsonSchema`, [`declaration_schema`]) is checked; one it would
//! reject is rebuilt once from the lowered schema (draft-07/04 constructs), and one still
//! rejected is reported and left out.
//!
//! The Gemini-family rule of a route: `run_host/route_schema.rs` calls [`gemini_accepted_tools`]
//! for the tools a route sends and [`gemini_tool_exclusion`] for the one it answers.

use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;
use serde_json::json;

use super::schema::declaration_schema;
use crate::providers::action_input::action_input_union_for;
use crate::providers::compat::schema::Problem;
use crate::providers::compat::schema::claude_bridge_input_schema;
use crate::providers::compat::schema::Rule;
use crate::providers::compat::schema::ToolExclusion;
use crate::providers::compat::schema::escape_pointer;
use crate::providers::compat::schema::exclusion;
use crate::providers::compat::schema::repaired_tool_input_schema;
use crate::providers::compat::schema::wire_problem;

/// The Gemini Schema `type` values (`SchemaType`).
const LEGACY_SCHEMA_TYPES: [&str; 6] = ["string", "number", "integer", "boolean", "array", "object"];
/// What the report names the tool by (`acceptedGeminiTool`).
const SOURCE: &str = "[gemini] tool";

/// A declaration's schema field: its key and value; `None` for a tool without a schema, which is
/// sent as written.
type Fields = Option<(&'static str, Value)>;

/// The schema field of a tool's schema as Node reads it: `None` is an absent `inputSchema` (the
/// declaration carries no schema), `Some(Null)` an explicit null (`parameters: null`, which Gemini
/// refuses as a non-object).
fn schema_fields(schema: Option<&Value>) -> Fields {
    schema.map(declaration_schema)
}

/// A `ToolDefinition` has one value for "absent" and "null", and reads null as absent. That is
/// what Node's tools are by the time a provider sees them: the MCP client gives a tool without a
/// schema `{ type: 'object', properties: {} }` (`mcp/client.mjs`), as Rust's `sanitize_schema`
/// does, and a built-in tool always has one. The rules below take the real value
/// ([`gemini_schema_exclusion`]) for a caller that has it.
fn declared(tool: &ToolDefinition) -> Option<&Value> {
    (!tool.input_schema.is_null()).then_some(&tool.input_schema)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Object.entries(value)`: integer-like keys ascending, then the others in order; an array's
/// indices; a string's characters; nothing for any other value.
fn entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Object(map) => {
            let index = |key: &str| key.parse::<u32>().ok().filter(|n| *n < u32::MAX && n.to_string() == key);
            let mut indexed: Vec<(u32, &String, &Value)> =
                map.iter().filter_map(|(key, child)| index(key).map(|n| (n, key, child))).collect();
            indexed.sort_by_key(|(n, ..)| *n);
            let named = map.iter().filter(|(key, _)| index(key).is_none());
            indexed
                .into_iter()
                .map(|(_, key, child)| (key.clone(), child.clone()))
                .chain(named.map(|(key, child)| (key.clone(), child.clone())))
                .collect()
        }
        Value::Array(list) => list.iter().enumerate().map(|(i, child)| (i.to_string(), child.clone())).collect(),
        Value::String(text) => text
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

/// Why a legacy `parameters` Schema (the OpenAPI subset `convert` targets) is rejected by
/// Gemini, or `None` when it is valid: an object root (or none), known types, an `items` schema
/// on every array, string enums, and `required` names that exist in `properties`
/// (`legacyParametersProblem`).
fn legacy_problem(node: &Value, pointer: &str, root: bool) -> Option<Problem> {
    let bad = |reason: String, at: String| Some(Problem { pointer: at, reason });
    let Some(map) = node.as_object() else {
        return bad("a Gemini Schema must be an object".into(), pointer.into());
    };
    let kind = map.get("type");
    if let Some(kind) = kind
        && !kind.as_str().is_some_and(|k| LEGACY_SCHEMA_TYPES.contains(&k))
    {
        return bad(format!("unsupported type {kind}"), format!("{pointer}/type"));
    }
    let kind = kind.and_then(Value::as_str);
    if root && kind.is_some_and(|k| k != "object") {
        return bad("the input schema root must have type \"object\"".into(), format!("{pointer}/type"));
    }
    if let Some(values) = map.get("enum")
        && !values.as_array().is_some_and(|list| list.iter().all(Value::is_string))
    {
        return bad("enum must be an array of strings".into(), format!("{pointer}/enum"));
    }
    let items = map.get("items");
    if kind == Some("array") && !items.is_some_and(Value::is_object) {
        return bad("an array schema needs an \"items\" schema".into(), format!("{pointer}/items"));
    }
    // A node without its own `properties` (an anyOf branch narrowing the parent's required keys)
    // has nothing to check `required` against.
    if let Some(required) = map.get("required") {
        let names: Option<Vec<String>> = match map.get("properties") {
            Some(Value::Object(properties)) => Some(properties.keys().cloned().collect()),
            Some(Value::Array(list)) => Some((0..list.len()).map(|i| i.to_string()).collect()),
            _ => None,
        };
        let undeclared = |list: &Vec<Value>| {
            names
                .as_ref()
                .is_some_and(|names| list.iter().any(|n| !n.as_str().is_some_and(|n| names.iter().any(|x| x == n))))
        };
        if required.as_array().is_none_or(undeclared) {
            return bad(
                "required must list properties declared in \"properties\"".into(),
                format!("{pointer}/required"),
            );
        }
    }
    let mut children: Vec<(Value, String)> = Vec::new();
    if let Some(properties) = map.get("properties").filter(|p| truthy(p)) {
        for (name, child) in entries(properties) {
            children.push((child, format!("{pointer}/properties/{}", escape_pointer(&name))));
        }
    }
    if let Some(items) = items.filter(|i| truthy(i)) {
        children.push((items.clone(), format!("{pointer}/items")));
    }
    if let Some(list) = map.get("anyOf").and_then(Value::as_array) {
        for (i, child) in list.iter().enumerate() {
            children.push((child.clone(), format!("{pointer}/anyOf/{i}")));
        }
    }
    children.iter().find_map(|(child, at)| legacy_problem(child, at, false))
}

/// Why the declaration's schema is rejected by Gemini, or `None` (`geminiDeclarationProblem`).
fn declaration_problem(fields: &Fields) -> Option<Problem> {
    match fields {
        None => None,
        Some(("parametersJsonSchema", schema)) => wire_problem(schema, Rule::Gemini),
        Some((_, schema)) => legacy_problem(schema, "", true),
    }
}

/// A tool Gemini accepts: the tool to send (carrying the lowered schema when only that is
/// accepted) and its schema field.
struct Accepted {
    tool: ToolDefinition,
    fields: Fields,
}

/// What `acceptedGeminiTool` decides for a schema: its schema field and, when only the lowered
/// schema is accepted, that schema; or the problem that leaves the tool out.
fn accepted_schema(schema: Option<&Value>) -> Result<(Fields, Option<Value>), Problem> {
    let fields = schema_fields(schema);
    let Some(mut problem) = declaration_problem(&fields) else {
        return Ok((fields, None));
    };
    if let Some(repaired) = schema.and_then(|s| repaired_tool_input_schema(s, Rule::Gemini)) {
        let repaired_fields = schema_fields(Some(&repaired));
        match declaration_problem(&repaired_fields) {
            None => return Ok((repaired_fields, Some(repaired))),
            Some(remaining) => problem = remaining,
        }
    }
    Err(problem)
}

/// `acceptedGeminiTool`: the tool as it is sent, or `None` after reporting why it is left out.
fn accepted_tool(tool: &ToolDefinition, index: usize, excluded: &mut dyn FnMut(ToolExclusion)) -> Option<Accepted> {
    match accepted_schema(declared(tool)) {
        Ok((fields, lowered)) => {
            let tool = match lowered {
                Some(input_schema) => ToolDefinition { input_schema, ..tool.clone() },
                None => tool.clone(),
            };
            Some(Accepted { tool, fields })
        }
        Err(problem) => {
            excluded(exclusion(&tool.name, index, problem, SOURCE));
            None
        }
    }
}

/// The tools whose schema a Gemini-family model behind an OpenAI-compatible route accepts, in
/// order: unchanged, or carrying the lowered schema when only that is accepted. The others are
/// reported through `excluded` (`geminiAcceptedTools`).
pub fn gemini_accepted_tools(tools: &[ToolDefinition], excluded: &mut dyn FnMut(ToolExclusion)) -> Vec<ToolDefinition> {
    tools
        .iter()
        .enumerate()
        .filter_map(|(index, tool)| accepted_tool(tool, index, excluded).map(|accepted| accepted.tool))
        .collect()
}

/// Why a Gemini route leaves `tool` out of its requests, or `None` when it is sent. Reports
/// nothing else (`geminiToolExclusion`).
pub fn gemini_tool_exclusion(tool: &ToolDefinition) -> Option<ToolExclusion> {
    gemini_schema_exclusion(&tool.name, declared(tool))
}

/// [`gemini_tool_exclusion`] for a tool named `name` whose `inputSchema` is `schema` as Node holds
/// it: `None` is absent (the tool is sent without a schema), `Some(Null)` an explicit null (refused
/// as "a Gemini Schema must be an object").
pub fn gemini_schema_exclusion(name: &str, schema: Option<&Value>) -> Option<ToolExclusion> {
    accepted_schema(schema).err().map(|problem| exclusion(name, 0, problem, SOURCE))
}

/// How a request's tools become `functionDeclarations` (`toGeminiTools`' options).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Declarations {
    /// A Gemini-family model: each declaration is checked and one Gemini would reject is left out.
    Validated,
    /// Another family behind the same endpoint (GPT-OSS): converted as written.
    Plain,
    /// A Claude model behind Antigravity (`claudeBridge`): always `parametersJsonSchema`, a 2020-12
    /// schema the gateway hands to Anthropic; a tool whose schema is invalid for that is left out.
    ClaudeBridge,
}

/// What the report names a Claude tool by (`reportInvalidTool`'s default source).
const CLAUDE_SOURCE: &str = "[antigravity] Claude tool";

/// The Claude bridge's schema of a tool: the nested per-action union a first-party path accepts
/// (`actionInputUnionFor`), checked for the gateway (`claudeBridgeInputSchema`).
fn bridge_schema(tool: &ToolDefinition) -> Result<Value, Problem> {
    claude_bridge_input_schema(&action_input_union_for(&tool.input_schema))
}

/// Why a Claude model behind Antigravity gets no `tool`, or `None` when it is sent
/// (`wireExclusion(tool, claudeBridgeInputSchema(actionInputUnionFor(..)))`). Reports nothing else.
pub fn claude_bridge_tool_exclusion(tool: &ToolDefinition) -> Option<ToolExclusion> {
    bridge_schema(tool).err().map(|problem| exclusion(&tool.name, 0, problem, CLAUDE_SOURCE))
}

/// The `functionDeclarations` of a request (`toGeminiTools`): see [`Declarations`]. A tool left
/// out is reported through `excluded`.
pub fn function_declarations(
    tools: &[ToolDefinition],
    mode: Declarations,
    excluded: &mut dyn FnMut(ToolExclusion),
) -> Vec<Value> {
    tools
        .iter()
        .enumerate()
        .filter_map(|(index, tool)| {
            let fields = match mode {
                Declarations::Validated => accepted_tool(tool, index, excluded)?.fields,
                Declarations::Plain => schema_fields(declared(tool)),
                Declarations::ClaudeBridge => match bridge_schema(tool) {
                    Ok(schema) => Some(("parametersJsonSchema", schema)),
                    Err(problem) => {
                        excluded(exclusion(&tool.name, index, problem, CLAUDE_SOURCE));
                        return None;
                    }
                },
            };
            let mut declaration = json!({ "name": tool.name, "description": tool.description });
            if let Some((key, schema)) = fields {
                declaration[key] = schema;
            }
            Some(declaration)
        })
        .collect()
}
