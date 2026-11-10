//! Tool input schemas on a wire (`lib/claude-bridge-schema.mjs
//! acceptedWireTools`). A schema the wire accepts as written is sent as
//! written (byte-identical, so the prompt cache holds). Only a schema that
//! fails validation is repaired — draft-07/04 constructs lowered to 2020-12
//! (tuple `items`, `definitions`, `dependencies`, boolean exclusive bounds,
//! keywords beside `$ref`) and a missing root `type` filled in — and
//! re-validated; what still fails is left out and reported.
//!
//! "Accepted" means: valid under the JSON Schema 2020-12 meta-schema, every
//! `$ref` resolvable, and the wire's root rule. `$schema` is not validated
//! against: the provider reads the keywords, not the dialect.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::RwLock;

use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::ToolExclusionReport;
use mixdog_protocol::{JsonObject, JsonValue};
use serde_json::json;

use super::ajv_meta;

/// The root rule of a wire.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Rule {
    /// Object root, no root combinators.
    Anthropic,
    /// Object root.
    OpenAi,
    /// Object root, or no type at all.
    Gemini,
}

/// Why a schema is unacceptable: a JSON pointer into it and the reason.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Problem {
    pub pointer: String,
    pub reason: String,
}

fn problem(pointer: impl Into<String>, reason: impl Into<String>) -> Problem {
    Problem {
        pointer: pointer.into(),
        reason: reason.into(),
    }
}

/// A tool left out of a request, with the report the agent loop records.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolExclusion {
    pub name: String,
    pub index: usize,
    pub pointer: String,
    pub reason: String,
    pub message: String,
}

const MAP_KEYS: [&str; 5] = [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
];
const NODE_KEYS: [&str; 11] = [
    "items",
    "additionalProperties",
    "unevaluatedItems",
    "unevaluatedProperties",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
];
const LIST_KEYS: [&str; 4] = ["prefixItems", "allOf", "anyOf", "oneOf"];
const ROOT_FORBIDDEN_KEYS: [&str; 4] = ["anyOf", "oneOf", "allOf", "not"];

pub(crate) fn escape_pointer(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

#[derive(Clone, Copy)]
struct Lowering {
    drop_ref_siblings: bool,
    rename_defs: bool,
}

fn is_resource_id(node: &JsonObject) -> bool {
    node.get("$id")
        .and_then(JsonValue::as_str)
        .is_some_and(|id| !id.starts_with('#'))
}

/// `#/definitions` → `#/$defs` for the first occurrence that names the table
/// itself (followed by `/` or the end).
fn rewrite_ref(reference: &str) -> String {
    const OLD: &str = "#/definitions";
    let Some(at) = reference.find(OLD) else {
        return reference.to_owned();
    };
    let end = at + OLD.len();
    if reference[end..].is_empty() || reference[end..].starts_with('/') {
        format!("{}#/$defs{}", &reference[..at], &reference[end..])
    } else {
        reference.to_owned()
    }
}

fn translate_map(map: &JsonObject, ptr: &str, ctx: Lowering) -> Result<JsonValue, Problem> {
    let mut out = JsonObject::new();
    for (name, child) in map {
        out.insert(
            name.clone(),
            translate(child, &format!("{ptr}/{}", escape_pointer(name)), false, ctx)?,
        );
    }
    Ok(JsonValue::Object(out))
}

fn translate_list(list: &[JsonValue], ptr: &str, ctx: Lowering) -> Result<JsonValue, Problem> {
    list.iter()
        .enumerate()
        .map(|(i, child)| translate(child, &format!("{ptr}/{i}"), false, ctx))
        .collect::<Result<Vec<_>, _>>()
        .map(JsonValue::Array)
}

/// The standard draft-07 → 2020-12 keyword mapping, applied recursively.
fn translate(node: &JsonValue, ptr: &str, is_root: bool, ctx: Lowering) -> Result<JsonValue, Problem> {
    let JsonValue::Object(node) = node else {
        return Ok(node.clone());
    };
    let resource = is_root || is_resource_id(node);
    let tuple = node.get("items").is_some_and(JsonValue::is_array);
    let mut out = JsonObject::new();
    let mut legacy_defs: Option<(JsonValue, String)> = None;
    // Draft-07 ignores every keyword beside `$ref`; 2020-12 evaluates them. Only
    // the reference (and `definitions`, which a pointer ref may still resolve
    // into) is kept, so the translated schema accepts what the original did.
    let is_ref = ctx.drop_ref_siblings && node.get("$ref").is_some_and(JsonValue::is_string);
    for (key, value) in node {
        if is_ref && key != "$ref" && key != "definitions" {
            continue;
        }
        let at = format!("{ptr}/{}", escape_pointer(key));
        // Draft-04 boolean bounds: `minimum: n, exclusiveMinimum: true` is
        // 2020-12's `exclusiveMinimum: n`; `false` is the default.
        if matches!(key.as_str(), "exclusiveMinimum" | "exclusiveMaximum")
            && let JsonValue::Bool(flag) = value
        {
            let bound = if key == "exclusiveMinimum" { "minimum" } else { "maximum" };
            if *flag && let Some(n) = node.get(bound).filter(|n| n.is_number()) {
                out.insert(key.clone(), n.clone());
            }
            continue;
        }
        if value.is_number()
            && ((key == "minimum" && node.get("exclusiveMinimum") == Some(&JsonValue::Bool(true)))
                || (key == "maximum" && node.get("exclusiveMaximum") == Some(&JsonValue::Bool(true))))
        {
            continue;
        }
        match (key.as_str(), value) {
            ("items", JsonValue::Array(list)) if tuple => {
                if node.contains_key("prefixItems") {
                    return Err(problem(at, "tuple \"items\" array conflicts with \"prefixItems\""));
                }
                out.insert("prefixItems".into(), translate_list(list, &at, ctx)?);
            }
            ("additionalItems", _) if tuple => {
                out.insert("items".into(), translate(value, &at, false, ctx)?);
            }
            ("dependencies", JsonValue::Object(deps)) => {
                if node.contains_key("dependentRequired") || node.contains_key("dependentSchemas") {
                    return Err(problem(
                        at,
                        "\"dependencies\" conflicts with dependentRequired/dependentSchemas",
                    ));
                }
                for (name, dep) in deps {
                    let target = if dep.is_array() { "dependentRequired" } else { "dependentSchemas" };
                    let lowered = if dep.is_array() {
                        dep.clone()
                    } else {
                        translate(dep, &format!("{at}/{}", escape_pointer(name)), false, ctx)?
                    };
                    out.entry(target.to_owned())
                        .or_insert_with(|| JsonValue::Object(JsonObject::new()))
                        .as_object_mut()
                        .expect("an object was just inserted")
                        .insert(name.clone(), lowered);
                }
            }
            ("definitions", JsonValue::Object(defs)) if resource && ctx.rename_defs => {
                legacy_defs = Some((translate_map(defs, &at, ctx)?, at));
            }
            ("$ref", JsonValue::String(reference)) => {
                let reference = if ctx.rename_defs { rewrite_ref(reference) } else { reference.clone() };
                out.insert(key.clone(), reference.into());
            }
            (k, JsonValue::Object(map)) if MAP_KEYS.contains(&k) => {
                out.insert(key.clone(), translate_map(map, &at, ctx)?);
            }
            (k, _) if NODE_KEYS.contains(&k) => {
                out.insert(key.clone(), translate(value, &at, false, ctx)?);
            }
            (k, JsonValue::Array(list)) if LIST_KEYS.contains(&k) => {
                out.insert(key.clone(), translate_list(list, &at, ctx)?);
            }
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some((defs, at)) = legacy_defs {
        if out.contains_key("$defs") {
            return Err(problem(at, "\"definitions\" and \"$defs\" are both present"));
        }
        out.insert("$defs".into(), defs);
    }
    Ok(JsonValue::Object(out))
}

fn repair_root(schema: JsonValue) -> JsonValue {
    let JsonValue::Object(mut map) = schema else {
        return schema;
    };
    match map.get("type") {
        Some(JsonValue::Array(types)) if types.iter().any(|t| t == "object") => {
            map.insert("type".into(), "object".into());
            JsonValue::Object(map)
        }
        Some(_) => JsonValue::Object(map),
        None if map.contains_key("$ref") => JsonValue::Object(map),
        None => {
            let mut out = JsonObject::new();
            out.insert("type".into(), "object".into());
            out.extend(map);
            if !out.contains_key("properties") && !ROOT_FORBIDDEN_KEYS.iter().any(|k| out.contains_key(*k)) {
                out.insert("properties".into(), json!({}));
            }
            JsonValue::Object(out)
        }
    }
}

/// Whether any `$ref` points into a draft-07 `#/definitions` table.
fn refs_into_definitions(node: &JsonValue) -> bool {
    match node {
        JsonValue::Array(list) => list.iter().any(refs_into_definitions),
        JsonValue::Object(map) => map.iter().any(|(key, value)| {
            (key == "$ref"
                && value.as_str().is_some_and(|r| {
                    r.strip_prefix("#/definitions")
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
                }))
                || refs_into_definitions(value)
        }),
        _ => false,
    }
}

/// Only a schema that declares draft-07/04 gets draft-07 `$ref` semantics
/// (keywords beside `$ref` ignored); otherwise siblings are real constraints.
fn declares_legacy_draft(schema: Option<&JsonValue>) -> bool {
    schema
        .and_then(JsonValue::as_str)
        .is_some_and(|s| ["draft-04", "draft-05", "draft-06", "draft-07"].iter().any(|d| s.contains(d)))
}

/// The lowered copy of a tool input schema for `rule`, or `None` when it
/// cannot be lowered. Never mutates its input.
pub fn repaired_tool_input_schema(input: &JsonValue, rule: Rule) -> Option<JsonValue> {
    let JsonValue::Object(map) = input else {
        return None;
    };
    let mut rest = map.clone();
    let declared = rest.shift_remove("$schema");
    let rest = JsonValue::Object(rest);
    let lowered = translate(
        &rest,
        "",
        true,
        Lowering {
            drop_ref_siblings: declares_legacy_draft(declared.as_ref()),
            rename_defs: refs_into_definitions(&rest),
        },
    )
    .ok()?;
    Some(if rule == Rule::Gemini { lowered } else { repair_root(lowered) })
}

fn assert_valid_2020_12(schema: &JsonValue) -> Result<(), Problem> {
    // Worded as Ajv words it: the text reaches the user and the model (`ajv_meta`).
    if let Some(error) = ajv_meta::first_error(schema) {
        return Err(problem(error.pointer, format!("not a valid JSON Schema 2020-12 schema: {}", error.message)));
    }
    jsonschema::draft202012::new(schema)
        .map(|_| ())
        .map_err(|error| ajv_meta::compile_problem(schema, &error.to_string()))
}

fn assert_object_root(schema: &JsonValue, rule: Rule) -> Result<(), Problem> {
    let label = if rule == Rule::Anthropic { "Anthropic input_schema root" } else { "the input schema root" };
    let ty = schema.get("type");
    if rule == Rule::Gemini && ty.is_none() {
        return Ok(());
    }
    if ty != Some(&JsonValue::String("object".into())) {
        return Err(problem("/type", format!("{label} must have type \"object\"")));
    }
    if rule != Rule::Anthropic {
        return Ok(());
    }
    for key in ROOT_FORBIDDEN_KEYS {
        if schema.get(key).is_some() {
            return Err(problem(
                format!("/{key}"),
                format!("Anthropic input_schema does not allow a root \"{key}\""),
            ));
        }
    }
    Ok(())
}

/// Why `schema` is not accepted as written on a `rule` wire.
pub(crate) fn wire_problem(schema: &JsonValue, rule: Rule) -> Option<Problem> {
    let JsonValue::Object(map) = schema else {
        return Some(problem("", "the input schema must be a JSON object schema"));
    };
    let mut rest = map.clone();
    rest.shift_remove("$schema");
    let rest = JsonValue::Object(rest);
    assert_valid_2020_12(&rest)
        .and_then(|()| assert_object_root(&rest, rule))
        .err()
}

/// The schema to send for a tool on a `rule` wire: the input itself when it is
/// accepted as written, else its lowered copy; `Err` when broken even after
/// lowering.
pub fn wire_input_schema(input: &JsonValue, rule: Rule) -> Result<JsonValue, Problem> {
    let Some(problem) = wire_problem(input, rule) else {
        return Ok(input.clone());
    };
    match repaired_tool_input_schema(input, rule) {
        Some(repaired) => match wire_problem(&repaired, rule) {
            None => Ok(repaired),
            Some(remaining) => Err(remaining),
        },
        None => Err(problem),
    }
}

/// Whether a schema's `$schema` names draft-07 (`dialectOf`); 2020-12 when it is absent. Any other
/// dialect is unsupported (the Claude bridge forwards a 2020-12 `input_schema`).
fn is_draft_07(schema: &JsonObject) -> Result<bool, Problem> {
    let Some(declared) = schema.get("$schema") else {
        return Ok(false);
    };
    let name = declared.as_str().map_or_else(String::new, |text| {
        let text = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://")).unwrap_or(text);
        text.strip_suffix('#').unwrap_or(text).to_owned()
    });
    match name.as_str() {
        "json-schema.org/draft/2020-12/schema" => Ok(false),
        "json-schema.org/draft-07/schema" => Ok(true),
        _ => Err(problem(
            "/$schema",
            format!(
                "unsupported JSON Schema dialect {} (supported: 2020-12, draft-07)",
                mixdog_js::json_stringify(declared)
            ),
        )),
    }
}

/// `buildSchema`: the tool schema as the Claude bridge forwards it, a 2020-12 schema with an
/// Anthropic object root; a declared draft-07 is translated by the standard keyword mapping only.
fn bridge_schema(input: &JsonValue) -> Result<JsonValue, Problem> {
    let JsonValue::Object(map) = input else {
        return Err(problem("", "the input schema must be a JSON object schema"));
    };
    let draft_07 = is_draft_07(map)?;
    let mut rest = map.clone();
    rest.shift_remove("$schema");
    let rest = JsonValue::Object(rest);
    let schema = if draft_07 {
        translate(&rest, "", true, Lowering { drop_ref_siblings: true, rename_defs: true })?
    } else {
        rest
    };
    assert_valid_2020_12(&schema)?;
    assert_object_root(&schema, Rule::Anthropic)?;
    Ok(schema)
}

/// `claudeBridgeInputSchema`: the 2020-12 `parametersJsonSchema` of a Claude tool declaration
/// behind Antigravity, or the pointer and reason it is invalid under its dialect or for the
/// provider. A schema not valid as written is lowered once (undeclared draft-07/04 constructs, a
/// missing root type) and only one still broken is excluded.
pub fn claude_bridge_input_schema(input: &JsonValue) -> Result<JsonValue, Problem> {
    // Validating a schema compiles it, which a request would repeat for every tool on every turn.
    static MEMO: LazyLock<RwLock<HashMap<String, Result<JsonValue, Problem>>>> = LazyLock::new(Default::default);
    let key = input.to_string();
    if let Some(found) = MEMO.read().ok().and_then(|memo| memo.get(&key).cloned()) {
        return found;
    }
    let verdict = bridge_schema(input).or_else(|error| match repaired_tool_input_schema(input, Rule::Anthropic) {
        Some(repaired) if wire_problem(&repaired, Rule::Anthropic).is_none() => Ok(repaired),
        _ => Err(error),
    });
    if let Ok(mut memo) = MEMO.write() {
        if memo.len() >= MEMO_LIMIT {
            memo.clear();
        }
        memo.insert(key, verdict.clone());
    }
    verdict
}

/// The report for a tool left out of request `tools[index]` for `problem`
/// (`reportInvalidTool`); `source` prefixes the message (which route and kind of tool).
pub(crate) fn exclusion(name: &str, index: usize, problem: Problem, source: &str) -> ToolExclusion {
    let Problem { pointer, reason } = problem;
    let at = if pointer.is_empty() { "/".to_owned() } else { pointer };
    let message = format!("{source} \"{name}\" (tools[{index}]) excluded: invalid input schema at \"{at}\": {reason}");
    ToolExclusion {
        name: name.to_owned(),
        index,
        pointer: at,
        reason,
        message,
    }
}

/// `warned` (`claude-bridge-schema.mjs:382`): the exclusion messages already logged in this process.
static WARNED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// No exclusion logged yet, as in a new process.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_warned() {
    WARNED.lock().unwrap_or_else(PoisonError::into_inner).clear();
}

/// Where an adapter reports a tool it leaves out (`opts.onToolExcluded`): the request's sink, else
/// the log, as Node's default `console.warn`.
pub(crate) fn report_exclusion(options: &RequestOptions, found: ToolExclusion) {
    match &options.on_tool_excluded {
        Some(sink) => sink.report(ToolExclusionReport {
            name: found.name,
            index: found.index,
            pointer: found.pointer,
            reason: found.reason,
            message: found.message,
        }),
        None => {
            // Node's `console.warn` fires once per distinct message (`warned`).
            if WARNED.lock().unwrap_or_else(PoisonError::into_inner).insert(found.message.clone()) {
                mixdog_rt::node_console_warn!("{}", found.message);
            }
        }
    }
}

/// Verdicts by schema text and rule: validating a schema compiles it, which a
/// request would repeat for every tool on every turn.
#[derive(Default, Debug)]
pub struct SchemaMemo {
    verdicts: RwLock<HashMap<(Rule, String), Result<JsonValue, Problem>>>,
}

const MEMO_LIMIT: usize = 256;

impl SchemaMemo {
    fn verdict(&self, schema: &JsonValue, rule: Rule) -> Result<JsonValue, Problem> {
        let key = (rule, schema.to_string());
        if let Some(found) = self.verdicts.read().ok().and_then(|m| m.get(&key).cloned()) {
            return found;
        }
        let verdict = wire_input_schema(schema, rule);
        if let Ok(mut memo) = self.verdicts.write() {
            if memo.len() >= MEMO_LIMIT {
                memo.clear();
            }
            memo.insert(key, verdict.clone());
        }
        verdict
    }

    /// `tools` with each unacceptable one left out (reported through
    /// `excluded`) and each repairable one carrying its lowered schema. A tool
    /// without a schema (`Null`) is sent as written. `source` prefixes the
    /// report (which route and kind of tool).
    pub fn accepted_wire_tools(
        &self,
        tools: &[ToolDefinition],
        rule: Rule,
        source: &str,
        excluded: &mut dyn FnMut(ToolExclusion),
    ) -> Vec<ToolDefinition> {
        self.accepted_wire_tools_except(tools, rule, source, excluded, &|_| false)
    }

    /// [`accepted_wire_tools`](Self::accepted_wire_tools) where a tool `exempt` names is sent as
    /// written, with no schema check (it goes out without a JSON schema, `isExempt`). A report's
    /// `index` is the tool's place in `tools` whole.
    pub fn accepted_wire_tools_except(
        &self,
        tools: &[ToolDefinition],
        rule: Rule,
        source: &str,
        excluded: &mut dyn FnMut(ToolExclusion),
        exempt: &dyn Fn(&ToolDefinition) -> bool,
    ) -> Vec<ToolDefinition> {
        let mut out = Vec::with_capacity(tools.len());
        for (index, tool) in tools.iter().enumerate() {
            if tool.input_schema.is_null() || exempt(tool) {
                out.push(tool.clone());
                continue;
            }
            match self.verdict(&tool.input_schema, rule) {
                Ok(schema) => out.push(ToolDefinition {
                    input_schema: schema,
                    ..tool.clone()
                }),
                Err(problem) => excluded(exclusion(&tool.name, index, problem, source)),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, schema: JsonValue) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: String::new(),
            input_schema: schema,
            defer_loading: false,
            freeform: None,
        }
    }

    fn accept(tools: &[ToolDefinition], rule: Rule) -> (Vec<ToolDefinition>, Vec<ToolExclusion>) {
        let mut report = Vec::new();
        let out = SchemaMemo::default().accepted_wire_tools(tools, rule, "[t] tool", &mut |e| report.push(e));
        (out, report)
    }

    #[test]
    fn an_accepted_schema_is_sent_as_written() {
        let schema = json!({"type":"object","properties":{"b":{"type":"string"},"a":{"type":"integer"}},"required":["a"]});
        let (out, report) = accept(&[tool("t", schema.clone())], Rule::OpenAi);
        assert!(report.is_empty());
        assert_eq!(out[0].input_schema, schema);
        let keys: Vec<_> = out[0].input_schema["properties"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["b", "a"], "key order is the cache prefix");
    }

    #[test]
    fn draft_07_constructs_are_lowered() {
        let schema = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "definitions": {"n": {"type": "number", "minimum": 0, "exclusiveMinimum": true}},
            "properties": {
                "pair": {"type": "array", "items": [{"type":"string"},{"type":"number"}], "additionalItems": false},
                "n": {"$ref": "#/definitions/n", "description": "ignored beside $ref"},
            },
            "dependencies": {"pair": ["n"]},
        });
        let (out, report) = accept(&[tool("t", schema)], Rule::OpenAi);
        assert!(report.is_empty(), "{report:?}");
        let lowered = &out[0].input_schema;
        assert!(lowered.get("definitions").is_none());
        assert_eq!(lowered["$defs"]["n"], json!({"type": "number", "exclusiveMinimum": 0}));
        assert_eq!(lowered["properties"]["n"], json!({"$ref": "#/$defs/n"}));
        assert_eq!(
            lowered["properties"]["pair"],
            json!({"type": "array", "prefixItems": [{"type":"string"},{"type":"number"}], "items": false})
        );
        assert_eq!(lowered["dependentRequired"], json!({"pair": ["n"]}));
    }

    #[test]
    fn a_missing_root_type_is_filled_and_a_broken_schema_is_left_out() {
        let (out, report) = accept(
            &[
                tool("loose", json!({"description": "no type"})),
                tool("broken", json!({"type": "object", "properties": {"x": {"$ref": "#/$defs/missing"}}})),
                tool("array", json!({"type": "array"})),
                tool("bare", JsonValue::Null),
            ],
            Rule::OpenAi,
        );
        let names: Vec<_> = out.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["loose", "bare"]);
        assert_eq!(out[0].input_schema, json!({"type": "object", "description": "no type", "properties": {}}));
        let reported: Vec<_> = report.iter().map(|e| (e.name.as_str(), e.index)).collect();
        assert_eq!(reported, [("broken", 1), ("array", 2)]);
        assert!(report[1].message.starts_with("[t] tool \"array\" (tools[2]) excluded: invalid input schema at"));
    }

    /// `opts.onToolExcluded`: a tool a request leaves out is reported to the request's sink, with
    /// every field of the report.
    #[test]
    fn an_exclusion_goes_to_the_requests_sink() {
        use std::sync::Arc;
        use std::sync::Mutex;

        use mixdog_core_api::domain::provider::ToolExclusionSink;

        let seen = Arc::new(Mutex::new(Vec::<ToolExclusionReport>::new()));
        let into = Arc::clone(&seen);
        let options = RequestOptions {
            on_tool_excluded: Some(ToolExclusionSink(Arc::new(move |report: ToolExclusionReport| {
                into.lock().unwrap().push(report);
            }))),
            ..RequestOptions::default()
        };
        let problem = Problem { pointer: String::new(), reason: "why".into() };
        report_exclusion(&options, exclusion("t", 2, problem, "[x] tool"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!((seen[0].name.as_str(), seen[0].index, seen[0].pointer.as_str(), seen[0].reason.as_str()), ("t", 2, "/", "why"));
        assert_eq!(seen[0].message, "[x] tool \"t\" (tools[2]) excluded: invalid input schema at \"/\": why");
    }

    #[test]
    fn the_anthropic_rule_forbids_root_combinators() {
        let schema = json!({"type": "object", "anyOf": [{"required": ["a"]}, {"required": ["b"]}]});
        assert!(accept(&[tool("t", schema.clone())], Rule::OpenAi).1.is_empty());
        let (out, report) = accept(&[tool("t", schema)], Rule::Anthropic);
        assert!(out.is_empty());
        assert_eq!(report[0].pointer, "/anyOf");
    }
}
