//! Tool input schemas on the Gemini wire.
//!
//! A tool's JSON Schema takes one of two exclusive forms. When the legacy
//! OpenAPI-subset `parameters` can express it exactly, it is projected onto
//! that subset ([`convert`]). Otherwise the original schema travels as
//! `parametersJsonSchema` with only vendor/annotation keys removed. A
//! conjunction (`allOf`) that cannot be merged becomes an explicit conflict
//! schema instead of silently widening what the tool accepts.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// Keys of the legacy Schema object; everything else is projected away.
const FIELDS: &[&str] = &[
    "type",
    "format",
    "title",
    "description",
    "nullable",
    "enum",
    "items",
    "properties",
    "required",
    "example",
    "default",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "pattern",
    "propertyOrdering",
    "const",
];
const ANNOTATIONS: &[&str] = &["$schema", "$id", "$comment", "examples"];
const NON_CONSTRAINTS: &[&str] = &[
    "$schema",
    "$id",
    "$comment",
    "examples",
    "description",
    "title",
    "default",
    "example",
];
const TYPE_KEYWORDS: &[(&str, &[&str])] = &[
    ("string", &["minLength", "maxLength", "pattern", "format"]),
    ("array", &["minItems", "maxItems", "items"]),
    (
        "object",
        &[
            "minProperties",
            "maxProperties",
            "properties",
            "required",
            "propertyOrdering",
        ],
    ),
    ("number", &["minimum", "maximum"]),
    ("integer", &["minimum", "maximum"]),
];
const LEGACY_TYPES: &[&str] = &["string", "number", "integer", "boolean", "array", "object"];
const CONFLICT_ENUM: &str = "__mixdog_unrepresentable_schema_conjunction__";

fn conflict(reason: &str) -> Value {
    let reason: String = reason.chars().take(300).collect();
    json!({
        "type": "string",
        "enum": [CONFLICT_ENUM],
        "description": format!("Schema conjunction could not be represented safely: {reason}"),
    })
}

fn is_type_keyword(key: &str) -> bool {
    TYPE_KEYWORDS.iter().any(|(_, keys)| keys.contains(&key))
}

/// Declared non-null types and whether `null` is allowed.
fn type_info(schema: &Value) -> Result<(Option<String>, bool), String> {
    let declared: Vec<&str> = match schema.get("type") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(s)) => vec![s.as_str()],
        _ => Vec::new(),
    };
    let mut non_null: Vec<&str> = Vec::new();
    for t in declared.iter().filter(|t| **t != "null") {
        if !non_null.contains(t) {
            non_null.push(t);
        }
    }
    let ty = match non_null.as_slice() {
        [] => None,
        [one] => Some((*one).to_owned()),
        [a, b] if matches!((*a, *b), ("integer", "number") | ("number", "integer")) => {
            Some("integer".to_owned())
        }
        many => return Err(format!("unsupported type union {}", many.join("|"))),
    };
    let allows_null = declared.is_empty()
        || declared.contains(&"null")
        || schema.get("nullable") == Some(&Value::Bool(true));
    Ok((ty, allows_null))
}

/// `(value, exclusive)` of a numeric bound.
type Bound = Option<(f64, bool)>;

fn raw_bound(schema: &Value, lower: bool) -> Bound {
    let (inc, exc) = if lower {
        ("minimum", "exclusiveMinimum")
    } else {
        ("maximum", "exclusiveMaximum")
    };
    // `Number(x)` of whatever is written: a draft-04 `exclusiveMinimum: true` reads as 1.
    let number = |key: &str| Some(mixdog_js::to_number_of(schema.get(key))).filter(|n| n.is_finite());
    let mut out = number(inc).map(|v| (v, false));
    if let Some(v) = number(exc) {
        out = stronger(out, Some((v, true)), lower);
    }
    out
}

fn stronger(a: Bound, b: Bound, lower: bool) -> Bound {
    match (a, b) {
        (None, other) | (other, None) => other,
        (Some(x), Some(y)) => {
            if x.0 == y.0 {
                Some((x.0, x.1 || y.1))
            } else if (y.0 > x.0) == lower {
                Some(y)
            } else {
                Some(x)
            }
        }
    }
}

fn enum_values(schema: &Value) -> Result<Option<Vec<Value>>, String> {
    let values = schema.get("enum").and_then(Value::as_array).cloned();
    match (schema.get("const"), values) {
        (None, values) => Ok(values),
        (Some(c), Some(values)) if !values.contains(c) => Err("empty enum intersection".into()),
        (Some(c), _) => Ok(Some(vec![c.clone()])),
    }
}

fn obj(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// Folds every `allOf` branch into the schema, or says why they cannot meet.
fn flatten_all_of(input: &Value) -> Result<Value, String> {
    let Some(map) = obj(input) else {
        return Ok(input.clone());
    };
    let mut schema = Value::Object(map.clone());
    let branches = schema
        .as_object_mut()
        .and_then(|m| m.shift_remove("allOf"))
        .and_then(|b| b.as_array().cloned())
        .unwrap_or_default();
    for branch in &branches {
        schema = merge(&schema, branch)?;
    }
    Ok(schema)
}

fn merge(left: &Value, right: &Value) -> Result<Value, String> {
    let a = flatten_all_of(left)?;
    let b = flatten_all_of(right)?;
    for key in ["anyOf", "oneOf", "not"] {
        if b.get(key).is_some() {
            return Err(format!("{key} inside allOf"));
        }
    }
    for source in [&a, &b] {
        if let Some(key) = obj(source).and_then(|m| m.keys().find(|k| !FIELDS.contains(&k.as_str())))
        {
            return Err(format!("unsupported allOf keyword {key}"));
        }
    }
    let mut merged = obj(&a).cloned().unwrap_or_default();
    let (ta, na) = type_info(&a)?;
    let (tb, nb) = type_info(&b)?;
    let ty = match (ta, tb) {
        (Some(x), Some(y)) if x != y => {
            if matches!((x.as_str(), y.as_str()), ("integer", "number") | ("number", "integer")) {
                Some("integer".to_owned())
            } else {
                return Err(format!("incompatible types {x} and {y}"));
            }
        }
        (x, y) => x.or(y),
    };
    merged.shift_remove("type");
    merged.shift_remove("nullable");
    if let Some(t) = &ty {
        merged.insert("type".into(), json!(t));
        if na && nb {
            merged.insert("nullable".into(), json!(true));
        }
    }
    match (enum_values(&a)?, enum_values(&b)?) {
        (None, None) => {}
        (x, y) => {
            let values: Vec<Value> = match (x, y) {
                (Some(x), Some(y)) => x.into_iter().filter(|v| y.contains(v)).collect(),
                (Some(v), None) | (None, Some(v)) => v,
                (None, None) => Vec::new(),
            };
            if values.is_empty() {
                return Err("empty enum intersection".into());
            }
            merged.insert("enum".into(), Value::Array(values));
            merged.shift_remove("const");
        }
    }
    let lower = stronger(raw_bound(&a, true), raw_bound(&b, true), true);
    let upper = stronger(raw_bound(&a, false), raw_bound(&b, false), false);
    for key in ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum"] {
        merged.shift_remove(key);
    }
    if let Some((v, ex)) = lower {
        merged.insert((if ex { "exclusiveMinimum" } else { "minimum" }).into(), json!(v));
    }
    if let Some((v, ex)) = upper {
        merged.insert((if ex { "exclusiveMaximum" } else { "maximum" }).into(), json!(v));
    }
    if let (Some(l), Some(u)) = (lower, upper)
        && (l.0 > u.0 || (l.0 == u.0 && (l.1 || u.1)))
    {
        return Err("empty numeric range".into());
    }
    for (min_key, max_key) in [
        ("minLength", "maxLength"),
        ("minItems", "maxItems"),
        ("minProperties", "maxProperties"),
    ] {
        let num = |s: &Value, k: &str| s.get(k).and_then(Value::as_f64);
        let min = [num(&a, min_key), num(&b, min_key)]
            .into_iter()
            .flatten()
            .fold(0.0, f64::max);
        let max = [num(&a, max_key), num(&b, max_key)]
            .into_iter()
            .flatten()
            .reduce(f64::min);
        if max.is_some_and(|m| min > m) {
            return Err(format!("{min_key}/{max_key}"));
        }
        if min > 0.0 || num(&a, min_key) == Some(0.0) || num(&b, min_key) == Some(0.0) {
            merged.insert(min_key.into(), json!(min as u64));
        }
        if let Some(m) = max {
            merged.insert(max_key.into(), json!(m as u64));
        }
    }
    for key in ["pattern", "format"] {
        match (a.get(key), b.get(key)) {
            (Some(x), Some(y)) if x != y => return Err(format!("incompatible {key}")),
            (_, Some(y)) => {
                merged.insert(key.into(), y.clone());
            }
            _ => {}
        }
    }
    match (a.get("description").and_then(Value::as_str), b.get("description")) {
        (Some(x), Some(Value::String(y))) if x != y => {
            merged.insert("description".into(), json!(format!("{x}\n{y}")));
        }
        (_, Some(y)) => {
            merged.insert("description".into(), y.clone());
        }
        _ => {}
    }
    match (a.get("default"), b.get("default")) {
        (Some(x), Some(y)) if x != y => {
            merged.shift_remove("default");
        }
        (_, Some(y)) => {
            merged.insert("default".into(), y.clone());
        }
        _ => {}
    }
    for key in ["title", "example", "propertyOrdering"] {
        if !merged.contains_key(key)
            && let Some(v) = b.get(key)
        {
            merged.insert(key.into(), v.clone());
        }
    }
    let mut properties = a.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
    for (name, schema) in b.get("properties").and_then(Value::as_object).into_iter().flatten() {
        let next = match properties.get(name) {
            Some(existing) => merge(existing, schema).map_err(|why| format!("property {name}: {why}"))?,
            None => schema.clone(),
        };
        properties.insert(name.clone(), next);
    }
    if !properties.is_empty() {
        merged.insert("properties".into(), Value::Object(properties));
    }
    let mut required: Vec<Value> = Vec::new();
    for list in [a.get("required"), b.get("required")] {
        for name in list.and_then(Value::as_array).into_iter().flatten() {
            if name.is_string() && !required.contains(name) {
                required.push(name.clone());
            }
        }
    }
    if !required.is_empty() {
        merged.insert("required".into(), Value::Array(required));
    }
    match (a.get("items"), b.get("items")) {
        (Some(x), Some(y)) => {
            merged.insert("items".into(), merge(x, y).map_err(|why| format!("items: {why}"))?);
        }
        (_, Some(y)) => {
            merged.insert("items".into(), y.clone());
        }
        _ => {}
    }
    Ok(Value::Object(merged))
}

fn int_bound(v: f64, up: bool) -> Value {
    json!(if up { v.floor() + 1.0 } else { v.ceil() - 1.0 } as i64)
}

/// Projects `schema` onto the legacy Schema subset, at every level.
pub fn convert(schema: &Value) -> Value {
    if !schema.is_object() {
        return schema.clone();
    }
    let flat = match flatten_all_of(schema) {
        Ok(flat) => flat,
        Err(why) => return conflict(&why),
    };
    let mut result: Map<String, Value> = obj(&flat)
        .map(|m| {
            m.iter()
                .filter(|(k, _)| FIELDS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    if !result.contains_key("type") && (result.contains_key("properties") || result.contains_key("required")) {
        result.insert("type".into(), json!("object"));
    }
    if !result.contains_key("type") && result.contains_key("items") {
        result.insert("type".into(), json!("array"));
    }
    let probe = Value::Object(result.clone());
    let (raw_type, allows_null) = match type_info(&probe) {
        Ok(info) => info,
        Err(why) => return conflict(&why),
    };
    match &raw_type {
        Some(t) => {
            result.insert("type".into(), json!(t));
            if allows_null {
                result.insert("nullable".into(), json!(true));
            }
        }
        None => {
            result.shift_remove("type");
            if result.get("nullable") != Some(&Value::Bool(true)) {
                result.shift_remove("nullable");
            }
        }
    }
    if let Err(why) = enum_values(&probe) {
        return conflict(&why);
    }
    let scalar = matches!(raw_type.as_deref(), Some("integer" | "number" | "boolean"));
    if let Some(c) = result.shift_remove("const") {
        if scalar {
            return conflict(&format!(
                "Gemini does not support {} const",
                raw_type.as_deref().unwrap_or("")
            ));
        }
        let text = match &c {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        result.insert("enum".into(), json!([text]));
    }
    if scalar
        && result
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|e| e.iter().any(|v| !v.is_string()))
    {
        return conflict(&format!(
            "Gemini does not support {} enum conjunction",
            raw_type.as_deref().unwrap_or("")
        ));
    }
    if raw_type.as_deref() == Some("array") && !result.get("items").is_some_and(Value::is_object) {
        result.insert("items".into(), json!({"type": "string"}));
    }
    if let Some(Value::String(t)) = result.get("type") {
        let mapped = if LEGACY_TYPES.contains(&t.as_str()) { t.clone() } else { "string".into() };
        result.insert("type".into(), json!(mapped));
    }
    let lower = raw_bound(&probe, true);
    let upper = raw_bound(&probe, false);
    result.shift_remove("exclusiveMinimum");
    result.shift_remove("exclusiveMaximum");
    let integer = raw_type.as_deref() == Some("integer");
    if (lower.is_some_and(|b| b.1) || upper.is_some_and(|b| b.1)) && !integer {
        return conflict("exclusive numeric bound is not supported by Gemini Schema");
    }
    if integer {
        if let Some((v, true)) = lower {
            result.insert("minimum".into(), int_bound(v, true));
        }
        if let Some((v, true)) = upper {
            result.insert("maximum".into(), int_bound(v, false));
        }
    }
    if let (Some(min), Some(max)) = (
        result.get("minimum").and_then(Value::as_f64),
        result.get("maximum").and_then(Value::as_f64),
    ) && min > max
    {
        return conflict("empty numeric range");
    }
    convert_children(&mut result);
    project_unions(&mut result);
    result.shift_remove("allOf");
    result.shift_remove("not");
    if let Some(bad) = prune(&mut result, raw_type.as_deref()) {
        return bad;
    }
    Value::Object(result)
}

fn convert_children(result: &mut Map<String, Value>) {
    if result.get("properties").is_some_and(Value::is_object) || result.get("required").is_some_and(Value::is_array)
    {
        let mut props = Map::new();
        for (key, val) in result.get("properties").and_then(Value::as_object).into_iter().flatten() {
            props.insert(key.clone(), convert(val));
        }
        if let Some(Value::Array(required)) = result.get("required") {
            let mut names: Vec<Value> = Vec::new();
            for name in required.iter().filter(|n| n.is_string()) {
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
            for name in names.iter().filter_map(Value::as_str) {
                if !props.contains_key(name) {
                    props.insert(
                        name.to_owned(),
                        conflict(&format!("required property {name} has no representable schema")),
                    );
                }
            }
            if names.is_empty() {
                result.shift_remove("required");
            } else {
                result.insert("required".into(), Value::Array(names));
            }
        }
        result.insert("properties".into(), Value::Object(props));
    }
    if let Some(items) = result.get("items").filter(|v| v.is_object()) {
        let converted = convert(items);
        result.insert("items".into(), converted);
    }
}

/// `oneOf` relaxes to `anyOf`; a branch that uses object-only keys gets an
/// explicit object type, because Gemini rejects `required` outside one.
fn project_unions(result: &mut Map<String, Value>) {
    let mut branches: Vec<Value> = Vec::new();
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(list)) = result.get(key) {
            branches.extend(list.iter().cloned());
        }
    }
    result.shift_remove("oneOf");
    if branches.is_empty() {
        return;
    }
    let converted: Vec<Value> = branches
        .iter()
        .map(|branch| {
            let mut sub = convert(branch);
            if let Some(map) = sub.as_object_mut() {
                let object_keys = map.contains_key("required") || map.contains_key("properties");
                if object_keys && !map.contains_key("type") {
                    map.insert("type".into(), json!("object"));
                }
            }
            sub
        })
        .collect();
    if converted.is_empty() {
        result.shift_remove("anyOf");
    } else {
        result.insert("anyOf".into(), Value::Array(converted));
    }
}

/// Drops keywords foreign to the resolved type, then checks min/max pairs.
fn prune(result: &mut Map<String, Value>, raw_type: Option<&str>) -> Option<Value> {
    let allowed: &[&str] = TYPE_KEYWORDS
        .iter()
        .find(|(t, _)| Some(*t) == raw_type)
        .map(|(_, keys)| *keys)
        .unwrap_or(&[]);
    let foreign: Vec<String> = result
        .keys()
        .filter(|k| is_type_keyword(k) && !allowed.contains(&k.as_str()))
        .cloned()
        .collect();
    for key in foreign {
        result.shift_remove(&key);
    }
    for (min_key, max_key) in [
        ("minLength", "maxLength"),
        ("minItems", "maxItems"),
        ("minProperties", "maxProperties"),
    ] {
        for key in [min_key, max_key] {
            if result.get(key).is_some_and(|v| v.as_u64().is_none()) {
                result.shift_remove(key);
            }
        }
        if let (Some(min), Some(max)) = (
            result.get(min_key).and_then(Value::as_u64),
            result.get(max_key).and_then(Value::as_u64),
        ) && min > max
        {
            return Some(conflict(&format!("{min_key}/{max_key}")));
        }
    }
    for key in ["minimum", "maximum"] {
        if result.get(key).is_some_and(|v| v.as_f64().is_none()) {
            result.shift_remove(key);
        }
    }
    None
}

/// True when the legacy subset expresses `input` exactly: [`convert`] would
/// neither drop a constraint nor invent a replacement.
fn legacy_representable(input: &Value, root: bool) -> bool {
    if !input.is_object() {
        return false;
    }
    let Ok(schema) = flatten_all_of(input) else {
        return false;
    };
    let Some(map) = obj(&schema) else {
        return false;
    };
    if !map.keys().any(|k| !NON_CONSTRAINTS.contains(&k.as_str())) {
        return false;
    }
    for (key, value) in map {
        if FIELDS.contains(&key.as_str()) || ANNOTATIONS.contains(&key.as_str()) {
            continue;
        }
        if key == "additionalProperties" && value == &Value::Bool(true) {
            continue;
        }
        return false;
    }
    if map.contains_key("oneOf") || map.contains_key("not") {
        return false;
    }
    let declared: Vec<&str> = match map.get("type") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(s)) => vec![s.as_str()],
        _ => Vec::new(),
    };
    let non_null: Vec<&str> = declared.iter().copied().filter(|t| *t != "null").collect();
    if !declared.is_empty() && non_null.is_empty() {
        return false;
    }
    if non_null.len() > 1 || non_null.iter().any(|t| !LEGACY_TYPES.contains(t)) {
        return false;
    }
    let mut ty = non_null.first().copied();
    if ty.is_none() && (map.contains_key("properties") || map.contains_key("required")) {
        ty = Some("object");
    }
    if ty.is_none() && map.contains_key("items") {
        ty = Some("array");
    }
    if let Some(e) = map.get("enum")
        && !e.as_array().is_some_and(|a| a.iter().all(Value::is_string))
    {
        return false;
    }
    if map.get("const").is_some_and(|c| !c.is_string()) {
        return false;
    }
    if matches!(ty, Some("integer" | "number" | "boolean"))
        && (map.contains_key("enum") || map.contains_key("const"))
    {
        return false;
    }
    if ty.is_none() && map.keys().any(|k| is_type_keyword(k)) {
        return false;
    }
    let (lower, upper) = (raw_bound(&schema, true), raw_bound(&schema, false));
    if (lower.is_some_and(|b| b.1) || upper.is_some_and(|b| b.1)) && ty != Some("integer") {
        return false;
    }
    if let (Some(l), Some(u)) = (lower, upper)
        && l.0 > u.0
    {
        return false;
    }
    for (min_key, max_key) in [
        ("minLength", "maxLength"),
        ("minItems", "maxItems"),
        ("minProperties", "maxProperties"),
    ] {
        if let (Some(min), Some(max)) = (
            map.get(min_key).and_then(Value::as_f64),
            map.get(max_key).and_then(Value::as_f64),
        ) && min > max
        {
            return false;
        }
    }
    if ty == Some("array") {
        match map.get("items") {
            Some(items) if items.is_object() && legacy_representable(items, false) => {}
            _ => return false,
        }
    }
    if ty == Some("object") {
        let props = match map.get("properties") {
            None => None,
            Some(Value::Object(p)) => Some(p),
            Some(_) => return false,
        };
        let names: Vec<&String> = props.map(|p| p.keys().collect()).unwrap_or_default();
        if names.is_empty() && !root && !map.get("anyOf").is_some_and(Value::is_array) {
            return false;
        }
        if let Some(required) = map.get("required") {
            let Some(list) = required.as_array() else {
                return false;
            };
            if list
                .iter()
                .any(|n| n.as_str().is_none_or(|n| !names.iter().any(|x| x.as_str() == n)))
            {
                return false;
            }
        }
        if !props.is_none_or(|p| p.values().all(|v| legacy_representable(v, false))) {
            return false;
        }
    }
    if let Some(any_of) = map.get("anyOf")
        && !any_of
            .as_array()
            .is_some_and(|a| a.iter().all(|b| legacy_representable(b, false)))
    {
        return false;
    }
    true
}

fn non_standard_key(key: &str) -> bool {
    matches!(key, "$schema" | "$comment" | "deprecated" | "examples") || key.starts_with("x-")
}

/// Removes vendor extensions and annotation-only keys; property names are
/// data and stay.
fn strip_non_standard(schema: &Value) -> Value {
    const MAPS: &[&str] = &["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
    const NODES: &[&str] = &[
        "items",
        "additionalItems",
        "additionalProperties",
        "unevaluatedItems",
        "unevaluatedProperties",
        "contains",
        "propertyNames",
        "not",
        "if",
        "then",
        "else",
        "prefixItems",
        "allOf",
        "anyOf",
        "oneOf",
    ];
    match schema {
        Value::Array(items) => Value::Array(items.iter().map(strip_non_standard).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                if non_standard_key(key) {
                    continue;
                }
                let next = if MAPS.contains(&key.as_str()) && value.is_object() {
                    Value::Object(
                        value
                            .as_object()
                            .into_iter()
                            .flatten()
                            .map(|(name, child)| (name.clone(), strip_non_standard(child)))
                            .collect(),
                    )
                } else if NODES.contains(&key.as_str()) {
                    strip_non_standard(value)
                } else {
                    value.clone()
                };
                out.insert(key.clone(), next);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `("parameters", legacy)` when the legacy subset is exact, else
/// `("parametersJsonSchema", original)`. A null or a scalar is no schema at all: `convertSchema` hands it
/// back as written (`geminiSchemaFields`), and the declaration check then refuses it.
pub fn declaration_schema(input: &Value) -> (&'static str, Value) {
    if matches!(input, Value::Null | Value::String(_) | Value::Number(_)) {
        return ("parameters", input.clone());
    }
    if input.is_boolean() || !legacy_representable(input, true) {
        ("parametersJsonSchema", strip_non_standard(input))
    } else {
        ("parameters", convert(input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_object_projects_to_legacy_parameters() {
        let input = json!({
            "type": "object",
            "properties": {"key": {"type": "string"}},
            "required": ["key"],
            "additionalProperties": false
        });
        // `additionalProperties:false` is a constraint the subset lacks.
        assert_eq!(declaration_schema(&input).0, "parametersJsonSchema");
        let input = json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]});
        assert_eq!(
            declaration_schema(&input),
            ("parameters", json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}))
        );
    }

    #[test]
    fn const_nullable_and_union_projection() {
        let out = convert(&json!({
            "type": "object",
            "properties": {
                "mode": {"const": "fast", "type": "string"},
                "n": {"type": ["integer", "null"], "exclusiveMinimum": 0},
                "list": {"type": "array"}
            },
            "oneOf": [{"properties": {"mode": {"type": "string"}}, "required": ["mode"]}]
        }));
        assert_eq!(out["properties"]["mode"]["enum"], json!(["fast"]));
        assert_eq!(out["properties"]["n"]["nullable"], json!(true));
        assert_eq!(out["properties"]["n"]["minimum"], json!(1));
        assert_eq!(out["properties"]["list"]["items"], json!({"type": "string"}));
        assert_eq!(out["anyOf"][0]["type"], json!("object"));
        assert_eq!(out["anyOf"][0]["required"], json!(["mode"]));
        assert!(out.get("oneOf").is_none());
    }

    #[test]
    fn unmergeable_conjunction_is_an_explicit_conflict() {
        let out = convert(&json!({"allOf": [{"type": "string"}, {"type": "boolean"}]}));
        assert_eq!(out["enum"], json!([CONFLICT_ENUM]));
    }

    #[test]
    fn unconstrained_value_travels_as_json_schema() {
        let input = json!({"type":"object","properties":{"value":{}}, "x-vendor": 1});
        let (key, schema) = declaration_schema(&input);
        assert_eq!(key, "parametersJsonSchema");
        assert!(schema.get("x-vendor").is_none());
    }
}
