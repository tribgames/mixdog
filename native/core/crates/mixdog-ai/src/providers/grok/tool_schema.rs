//! Grok's gRPC tool registry takes flat tool schemas: no `anyOf`/`oneOf`. This is `normalizeGrokToolSchemas` of
//! the Node core (`providers/lib/grok-tool-schema.mjs` with `action-input-contract.mjs`, applied at
//! `grok-oauth.mjs:438`), step for step, on the `parameters` of each tool of the encoded body, with the JavaScript
//! semantics it relies on: the schema is a `JSON.parse` result (every number a double, every object listing its
//! array-index keys first in ascending order, then the others in insertion order), `===` and `includes` compare as
//! JavaScript compares, numbers put into text are written as JavaScript writes them, and the body goes out as
//! `JSON.stringify` writes it. Where Node's code throws a `TypeError` on an input, so does this, and the send fails.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const ARRAY_DROP_NOTE: &str = "This provider accepts a single value here, not an array.";
const ARRAY_ONLY_NOTE: &str = "Pass one or more values as an array.";
const SCHEMA_MAP_KEYWORDS: [&str; 5] = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_VALUED_KEYWORDS: [&str; 12] = [
    "items", "prefixItems", "additionalProperties", "contains", "allOf", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems",
];

/// The `TypeError` Node's flatten throws on an input (V8's message); the send fails before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeError(pub String);

type Js<T> = Result<T, TypeError>;

fn reading_null(key: &str) -> TypeError {
    TypeError(format!("Cannot read properties of null (reading '{key}')"))
}

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript values
// ---------------------------------------------------------------------------------------------------------------------

/// ECMAScript `Number::toString(x)`: the shortest digits that read back as `x`, in plain notation from 1e-6 up to 1e21,
/// otherwise as `d.ddde±n`; `-0` is `0`.
pub(crate) fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if x < 0.0 {
        return format!("-{}", js_number(-x));
    }
    // Rust's `{:e}` writes the same shortest round-trip digits; only the layout differs.
    let scientific = format!("{x:e}");
    let (mantissa, exponent) = scientific.split_once('e').expect("`{:e}` writes an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("`{:e}` writes an integer exponent") + 1;
    if k <= n && n <= 21 {
        digits + &"0".repeat((n - k) as usize)
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(-n as usize))
    } else {
        let sign = if n - 1 >= 0 { '+' } else { '-' };
        let e = (n - 1).abs();
        if k == 1 { format!("{digits}e{sign}{e}") } else { format!("{}.{}e{sign}{e}", &digits[..1], &digits[1..]) }
    }
}

/// `String(value)` / a template literal of a parsed JSON value. An object is `ToPrimitive`d: its `toString`, then its
/// `valueOf`, whichever is a function and gives a primitive. A parsed object inherits both from `Object.prototype`
/// (`"[object Object]"`) unless it has an own `toString` key: that one is never a function, so `toString` is skipped and
/// `valueOf` (its own, never a function either, or `Object.prototype`'s, which gives the object back) gives no
/// primitive, and V8 throws.
fn js_to_string(value: &Value) -> Js<String> {
    Ok(match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => js_join(items, ",")?,
        Value::Object(map) if map.contains_key("toString") => return Err(TypeError("Cannot convert object to primitive value".to_owned())),
        Value::Object(_) => "[object Object]".to_owned(),
    })
}

/// `Array.prototype.join(separator)`: `null` (and `undefined`) elements are empty.
fn js_join(items: &[Value], separator: &str) -> Js<String> {
    items.iter().map(|item| if item.is_null() { Ok(String::new()) } else { js_to_string(item) }).collect::<Js<Vec<_>>>().map(|parts| parts.join(separator))
}

/// `String.prototype.trim`: JavaScript's white space and line terminators (U+FEFF is one, U+0085 is not).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

/// JavaScript truthiness of a JSON value (`None` is `undefined`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The index an object key is to JavaScript (an array index, `0` to `2^32 - 2` written canonically), which an object
/// lists before its other keys, in ascending order.
fn array_index(key: &str) -> Option<u32> {
    if key == "0" {
        return Some(0);
    }
    if key.is_empty() || key.len() > 10 || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>().ok().filter(|&n| n <= 4_294_967_294).map(|n| n as u32)
}

/// A map in the order a JavaScript object lists its keys: array indices ascending, then the rest as inserted.
fn js_ordered(map: Map<String, Value>) -> Map<String, Value> {
    let (mut indices, names): (Vec<_>, Vec<_>) = map.into_iter().partition(|(key, _)| array_index(key).is_some());
    indices.sort_by_key(|(key, _)| array_index(key));
    indices.into_iter().chain(names).collect()
}

/// The value `JSON.parse` would have made of `value`'s text: every number a double, every object in JavaScript's key
/// order.
fn from_json(value: &Value) -> Value {
    match value {
        Value::Number(n) => n.as_f64().map_or(Value::Null, Value::from),
        Value::Array(items) => Value::Array(items.iter().map(from_json).collect()),
        Value::Object(map) => Value::Object(js_ordered(map.iter().map(|(key, value)| (key.clone(), from_json(value))).collect())),
        other => other.clone(),
    }
}

/// Every object of `value` in JavaScript's key order (an object the flatten built lists its keys as JavaScript does).
fn js_ordered_deep(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(js_ordered_deep).collect()),
        Value::Object(map) => Value::Object(js_ordered(map.into_iter().map(|(key, value)| (key, js_ordered_deep(value))).collect())),
        other => other,
    }
}

// A JavaScript string is UTF-16: `Object.entries` (and a spread) of a string takes it apart by code unit, so a character
// outside the Basic Multilingual Plane becomes two strings of one lone surrogate each, which a Rust string cannot hold.
// Such a string is written here as the flatten's marker followed by the unit's four lowercase hex digits, and
// `JSON.stringify` writes it as JavaScript does (`"\ud83d"`). The marker is a run of U+F0000 longer than any run in the
// body the flatten works on, so no string of the body, nor any text the flatten builds from them (always joined with
// ASCII), is a marked one.
thread_local! {
    static LONE_MARKER: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

const MARK: char = '\u{F0000}';

/// The marker for `value`: one U+F0000 more than the longest run of it in any of its strings and keys.
fn lone_marker(value: &Value) -> String {
    fn longest(text: &str) -> usize {
        text.split(|c| c != MARK).map(|run| run.chars().count()).max().unwrap_or(0)
    }
    fn walk(value: &Value) -> usize {
        match value {
            Value::String(text) => longest(text),
            Value::Array(items) => items.iter().map(walk).max().unwrap_or(0),
            Value::Object(map) => map.iter().map(|(key, value)| longest(key).max(walk(value))).max().unwrap_or(0),
            _ => 0,
        }
    }
    MARK.to_string().repeat(walk(value) + 1)
}

/// The JavaScript string of one lone surrogate `unit`.
fn lone_unit(unit: u16) -> Value {
    LONE_MARKER.with(|marker| Value::String(format!("{}{unit:04x}", marker.borrow())))
}

/// The lone surrogate a marked string stands for.
fn lone_of<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let hex = text.strip_prefix(marker).filter(|_| !marker.is_empty())?;
    (hex.len() == 4 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

/// `JSON.stringify`'s quoting: `"`, `\`, the five short escapes, other controls as `\u00xx`, a lone surrogate (a marked
/// string) as `\udxxx`, everything else as it is.
fn write_js_string(out: &mut Vec<u8>, text: &str, marker: &str) {
    if let Some(hex) = lone_of(text, marker) {
        out.extend_from_slice(format!("\"\\u{hex}\"").as_bytes());
        return;
    }
    out.push(b'"');
    for c in text.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes()),
            c => {
                let mut buf = [0; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

fn write_js_json(out: &mut Vec<u8>, value: &Value, marker: &str) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Value::Number(n) if n.is_f64() => out.extend_from_slice(js_number(n.as_f64().unwrap_or(f64::NAN)).as_bytes()),
        Value::Number(n) => out.extend_from_slice(n.to_string().as_bytes()),
        Value::String(text) => write_js_string(out, text, marker),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_js_json(out, item, marker);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            out.push(b'{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_js_string(out, key, "");
                out.push(b':');
                write_js_json(out, item, marker);
            }
            out.push(b'}');
        }
    }
}

/// `JSON.stringify(value)`: the map's key order, JSON's escapes, numbers as JavaScript writes them, and the strings
/// `marker` marks as the lone surrogates they stand for.
pub fn js_json(value: &Value, marker: &str) -> Vec<u8> {
    let mut out = Vec::new();
    write_js_json(&mut out, value, marker);
    out
}

/// `Object.entries(value)` (and the keys `{ ...value }` copies): an object's own keys in JavaScript order, an array's or
/// a string's indices, nothing for a number, a boolean or null. A string is taken apart by UTF-16 code unit: a
/// character outside the Basic Multilingual Plane is two entries, each one lone surrogate.
fn entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js_ordered(map.clone()).into_iter().collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                let entry = match char::from_u32(u32::from(unit)) {
                    Some(c) => Value::String(c.to_string()),
                    None => lone_unit(unit),
                };
                (index.to_string(), entry)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The prototype of an object Node assigns into by name (`properties[name] = …`, `Object.assign`).
#[derive(Clone, Default)]
enum Proto {
    /// `Object.prototype`.
    #[default]
    Object,
    Null,
    /// A schema object an assignment to `__proto__` installed.
    Schema(Map<String, Value>),
}

/// An object Node fills by assignment, where a key `__proto__` sets the prototype rather than adding a key, and a read
/// of a missing key reads the prototype's.
#[derive(Clone, Default)]
struct Props {
    own: Map<String, Value>,
    proto: Proto,
}

impl Props {
    /// `object[name]`: `Object.prototype`'s members other than `__proto__` carry no schema keyword, so they read as
    /// absent.
    fn get(&self, name: &str) -> Option<Value> {
        if let Some(value) = self.own.get(name) {
            return Some(value.clone());
        }
        match &self.proto {
            Proto::Null => None,
            // `Object.prototype` itself: an object with no schema keyword.
            Proto::Object => (name == "__proto__").then(|| json!({})),
            Proto::Schema(proto) => proto.get(name).cloned().or_else(|| (name == "__proto__").then(|| Value::Object(proto.clone()))),
        }
    }

    /// `object[name] = value`.
    fn set(&mut self, name: &str, value: Value) {
        let accessor = name == "__proto__"
            && !self.own.contains_key(name)
            && match &self.proto {
                Proto::Object => true,
                Proto::Null => false,
                // A data property `__proto__` on the prototype makes the assignment an own key.
                Proto::Schema(proto) => !proto.contains_key("__proto__"),
            };
        if accessor {
            match value {
                Value::Object(map) => self.proto = Proto::Schema(map),
                Value::Null => self.proto = Proto::Null,
                _ => {}
            }
            return;
        }
        self.own.insert(name.to_owned(), value);
    }
}

/// `{ ...value }`: the keys an object spread copies from `value`.
fn spread_source(value: &Value) -> Map<String, Value> {
    entries(Some(value)).into_iter().collect()
}

/// `Object.is` of two JSON values that are not objects or arrays.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64(), y.as_f64());
            x == y && x.map(f64::is_sign_negative) == y.map(f64::is_sign_negative)
        }
        _ => a == b,
    }
}

/// `schemasDeepEqual`.
fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(l, r)| deep_equal(l, r)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(key, l)| y.get(key).is_some_and(|r| deep_equal(l, r))),
        (Value::Array(_) | Value::Object(_), _) | (_, Value::Array(_) | Value::Object(_)) => false,
        _ => same_value(a, b),
    }
}

/// `a === b` of two values read from two different schemas: an object or an array is only ever strictly equal to
/// itself, and the flatten never reads one allocation from two different alternatives (each comes from its own place in
/// the parsed input).
fn strictly_equal_across(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Array(_) | Value::Object(_)), _) | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `new Set([...])` membership (SameValueZero) for a value of the parsed input: a number is its value (`-0` is stored as
/// `0`), an object or array is only the same as itself, so two equal-looking ones both stay.
fn push_set_member(out: &mut Vec<Value>, value: Value) {
    if value.is_object() || value.is_array() || !out.contains(&value) {
        out.push(match &value {
            Value::Number(n) if n.as_f64() == Some(0.0) => Value::from(0.0),
            _ => value,
        });
    }
}

/// `values.every(test)` where the test first reads `key` of each value: a `null` it reaches throws.
fn every_reading(values: &[Value], key: &str, test: impl Fn(usize, &Value) -> bool) -> Js<bool> {
    for (index, value) in values.iter().enumerate() {
        if value.is_null() {
            return Err(reading_null(key));
        }
        if !test(index, value) {
            return Ok(false);
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------------------------------------------------------------
// grok-tool-schema.mjs
// ---------------------------------------------------------------------------------------------------------------------

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

fn merge_object_branch_properties(branches: &[Value]) -> Js<Props> {
    let mut properties = Props::default();
    for branch in branches {
        for (name, schema) in entries(get(branch, "properties").filter(|p| truthy(Some(p)))) {
            let Some(existing) = properties.own.get(&name).cloned() else {
                properties.set(&name, schema);
                continue;
            };
            if deep_equal(&existing, &schema) {
                continue;
            }
            let mut deduped: Vec<Value> = Vec::new();
            for alternative in pure_any_of(&existing).into_iter().chain(pure_any_of(&schema)) {
                if !deduped.iter().any(|seen| deep_equal(seen, &alternative)) {
                    deduped.push(alternative);
                }
            }
            let merged = if every_reading(&deduped, "type", |_, v| type_is(v, "object") || truthy(get(v, "properties")))? {
                // Only an object has `type: 'object'` or a truthy `properties`.
                let first = deduped[0].as_object().cloned().unwrap_or_default();
                let required: Vec<Value> = required_keys(&deduped[0]).into_iter().filter(|key| deduped.iter().all(|v| required_keys(v).contains(key))).collect();
                let mut out = spread(without(&first, &["required", "properties"]), &Map::from_iter([("type".to_owned(), json!("object"))]));
                out.insert("properties".into(), Value::Object(merge_object_branch_properties(&deduped)?.own));
                if !required.is_empty() {
                    out.insert("required".into(), Value::Array(required));
                }
                Value::Object(out)
            } else if every_reading(&deduped, "enum", |index, v| {
                // `value.type === deduped[0].type`: the first alternative's own `type` is itself.
                get(v, "enum").is_some_and(Value::is_array) && (index == 0 || strictly_equal_across(get(v, "type"), get(&deduped[0], "type")))
            })? {
                let mut values = Vec::new();
                for value in deduped.iter().flat_map(|v| get(v, "enum").and_then(Value::as_array).cloned().unwrap_or_default()) {
                    push_set_member(&mut values, value);
                }
                let mut out = deduped[0].as_object().cloned().unwrap_or_default();
                out.insert("enum".into(), Value::Array(values));
                Value::Object(out)
            } else if deduped.len() == 1 {
                deduped[0].clone()
            } else {
                json!({ "anyOf": deduped })
            };
            properties.set(&name, merged);
        }
    }
    Ok(properties)
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

fn project_dropped_branches(schema: Value, dropped: &[&Value]) -> Js<Value> {
    let note = if describes_array(&schema) {
        dropped.iter().any(|b| describes_scalar(b)).then_some(ARRAY_ONLY_NOTE)
    } else {
        dropped.iter().any(|b| describes_array(b)).then_some(ARRAY_DROP_NOTE)
    };
    let Some(note) = note else { return Ok(schema) };
    // `String(schema.description || '').trim()`
    let description = get(&schema, "description").filter(|d| truthy(Some(d))).map(js_to_string).transpose()?.unwrap_or_default();
    let description = js_trim(&description);
    if description.contains(note) {
        return Ok(schema);
    }
    let mut out = schema.as_object().cloned().unwrap_or_default();
    out.insert("description".into(), Value::String(if description.is_empty() { note.to_owned() } else { format!("{description} {note}") }));
    Ok(Value::Object(out))
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

fn normalize_property_schema(schema: &Value) -> Js<Value> {
    let Some(map) = schema.as_object() else { return Ok(schema.clone()) };
    let branches: Vec<Value> = ["anyOf", "oneOf"].iter().flat_map(|key| map.get(*key).and_then(Value::as_array).cloned().unwrap_or_default()).collect();
    if !branches.is_empty() {
        if let Some(kept) = preferred_branch(&branches) {
            let siblings = without(map, &["anyOf", "oneOf"]);
            let merged = Value::Object(spread(branches[kept].as_object().cloned().unwrap_or_default(), &siblings));
            let dropped: Vec<&Value> = branches.iter().enumerate().filter(|(i, _)| *i != kept).map(|(_, b)| b).collect();
            return normalize_property_schema(&project_dropped_branches(merged, &dropped)?);
        }
    }
    let mut result = map.clone();
    for key in SCHEMA_MAP_KEYWORDS {
        match map.get(key) {
            Some(Value::Object(children)) => {
                let normalized = children.iter().map(|(name, child)| Ok((name.clone(), normalize_property_schema(child)?))).collect::<Js<Map<String, Value>>>()?;
                result.insert(key.to_owned(), Value::Object(normalized));
            }
            // `Object.fromEntries(Object.entries(array))`, taken only when a child changed: an object keyed by index.
            Some(Value::Array(children)) => {
                let normalized = children.iter().map(normalize_property_schema).collect::<Js<Vec<Value>>>()?;
                if !children.iter().zip(&normalized).all(|(before, after)| deep_equal(before, after)) {
                    result.insert(key.to_owned(), Value::Object(normalized.into_iter().enumerate().map(|(i, child)| (i.to_string(), child)).collect()));
                }
            }
            _ => {}
        }
    }
    for key in SCHEMA_VALUED_KEYWORDS {
        match map.get(key) {
            Some(Value::Array(children)) => {
                result.insert(key.to_owned(), Value::Array(children.iter().map(normalize_property_schema).collect::<Js<Vec<Value>>>()?));
            }
            Some(child @ Value::Object(_)) => {
                result.insert(key.to_owned(), normalize_property_schema(child)?);
            }
            _ => {}
        }
    }
    Ok(Value::Object(result))
}

fn is_object_branch(branch: &Value) -> bool {
    // `branch.properties && typeof branch.properties === 'object'`: an array is one too.
    branch.is_object() && (type_includes(branch, "object") || get(branch, "properties").is_some_and(|p| p.is_object() || p.is_array()))
}

// ---------------------------------------------------------------------------------------------------------------------
// action-input-contract.mjs `actionInputContract`
// ---------------------------------------------------------------------------------------------------------------------

/// V8's message for `new Set(value)` of a value that is not iterable.
fn not_iterable(value: &Value) -> TypeError {
    let what = match value {
        Value::Number(n) => format!("number {}", js_number(n.as_f64().unwrap_or(f64::NAN))),
        Value::Bool(b) => format!("boolean {b}"),
        _ => "object".to_owned(),
    };
    TypeError(format!("{what} is not iterable (cannot read property Symbol(Symbol.iterator))"))
}

/// The per-action input rules of a `oneOf`/`anyOf` of action/input branches, else empty.
fn action_input_contract(schema: &Value) -> Js<String> {
    let one_of = get(schema, "oneOf");
    let chosen = if truthy(one_of) { one_of } else { get(schema, "anyOf") };
    let Some(branches) = chosen.and_then(Value::as_array).filter(|b| !b.is_empty()) else { return Ok(String::new()) };
    let action_enum = |branch: &Value| get(branch, "properties").and_then(|p| get(p, "action")).and_then(|a| get(a, "enum")).and_then(Value::as_array).cloned();
    let input = |branch: &Value| get(branch, "properties").and_then(|p| get(p, "input")).cloned();
    let input_properties = |branch: &Value| input(branch).and_then(|i| get(&i, "properties").cloned()).filter(|p| truthy(Some(p)));
    if !branches.iter().all(|b| action_enum(b).is_some() && input_properties(b).is_some()) {
        return Ok(String::new());
    }
    let mut variants: std::collections::HashMap<String, Vec<Vec<u8>>> = std::collections::HashMap::new();
    for branch in branches {
        for (name, field) in entries(input_properties(branch).as_ref()) {
            if field.is_null() {
                return Err(reading_null("enum"));
            }
            let field_value = |key: &str| get(&field, key).cloned().unwrap_or(Value::Null);
            let key = js_json(&json!([field_value("enum"), field_value("minimum"), field_value("maximum")]), "");
            let set = variants.entry(name).or_default();
            if !set.contains(&key) {
                set.push(key);
            }
        }
    }
    let mut rows = Vec::new();
    for branch in branches {
        let input = input(branch).expect("every branch has an input");
        // `new Set(input.required || [])`: a string is a set of its characters.
        let required: Vec<String> = match get(&input, "required") {
            required if !truthy(required) => Vec::new(),
            Some(Value::Array(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
            Some(Value::String(text)) => text.chars().map(String::from).collect(),
            Some(other) => return Err(not_iterable(other)),
            None => Vec::new(),
        };
        let mut fields = Vec::new();
        for (name, field) in entries(input_properties(branch).as_ref()) {
            let mut label = format!("{name}{}", if required.contains(&name) { "*" } else { "" });
            if variants[&name].len() > 1 {
                match get(&field, "enum") {
                    Some(Value::Array(values)) => label += &format!("={}", js_join(values, "|")?),
                    values if truthy(values) => return Err(TypeError("field.enum.join is not a function".to_owned())),
                    _ => {}
                }
                if let Some(minimum) = get(&field, "minimum") {
                    label += &format!(">={}", js_to_string(minimum)?);
                }
                if let Some(maximum) = get(&field, "maximum") {
                    label += &format!("<={}", js_to_string(maximum)?);
                }
            }
            fields.push(label);
        }
        rows.push(format!("{}({})", js_join(&action_enum(branch).unwrap_or_default(), "/")?, fields.join(",")));
    }
    Ok(format!("Allowed input by action (* required): {}.", rows.join("; ")))
}

// ---------------------------------------------------------------------------------------------------------------------
// grok-tool-schema.mjs (continued)
// ---------------------------------------------------------------------------------------------------------------------

fn merged_schema_properties(root: &Map<String, Value>, object_branches: &[Value]) -> Js<Option<Props>> {
    let root_properties = root.get("properties").filter(|p| truthy(Some(p)));
    if !(object_branches.iter().any(|b| truthy(get(b, "properties"))) || root_properties.is_some()) {
        return Ok(None);
    }
    let mut properties = merge_object_branch_properties(object_branches)?;
    for (name, property) in entries(root_properties) {
        if property.is_null() {
            return Err(reading_null("type"));
        }
        let combined = properties.get(&name);
        let merged = match &combined {
            Some(combined) if type_is(&property, "object") && !truthy(get(&property, "properties")) && type_is(combined, "object") => {
                // `{ ...combined, ...property, properties: combined.properties }`; an `undefined` value is not written.
                let mut out = spread(combined.as_object().cloned().unwrap_or_default(), property.as_object().expect("an object's type is 'object'"));
                match get(combined, "properties") {
                    Some(inner) => {
                        out.insert("properties".into(), inner.clone());
                    }
                    None => {
                        out.shift_remove("properties");
                    }
                }
                Value::Object(out)
            }
            _ => property,
        };
        properties.set(&name, merged);
    }
    Ok(Some(properties))
}

fn union_required(root: &Value, object_branches: &[Value]) -> Vec<Value> {
    let first = get(&object_branches[0], "required").and_then(Value::as_array).cloned().unwrap_or_default();
    // `branch.required.includes(key)`: an object or array key is only found in the very array it came from, the first branch's.
    let in_every: Vec<Value> = first
        .into_iter()
        .filter(|key| {
            object_branches.iter().enumerate().all(|(index, b)| {
                get(b, "required").and_then(Value::as_array).is_some_and(|r| index == 0 || (!(key.is_object() || key.is_array()) && r.contains(key)))
            })
        })
        .collect();
    let mut out = Vec::new();
    for key in required_keys(root).into_iter().chain(in_every.iter().cloned()).chain(if in_every.is_empty() { first_exclusive_required(object_branches) } else { Vec::new() }) {
        push_set_member(&mut out, key);
    }
    out
}

fn normalize_tool_schema(schema: &Value) -> Js<Value> {
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
    let mut properties = merged_schema_properties(&root, &object_branches)?;
    let contract = action_input_contract(schema)?;
    if !contract.is_empty()
        && let Some(properties) = properties.as_mut()
        && let Some(input) = properties.get("input").filter(|input| truthy(Some(input)))
    {
        let mut with_description = spread_source(&input);
        with_description.insert("description".into(), Value::String(contract));
        properties.set("input", Value::Object(with_description));
    }
    let required = union_required(&Value::Object(root.clone()), &object_branches);
    // `Object.assign({}, ...objectBranches)` assigns key by key, so a branch's `__proto__` key sets the prototype.
    let mut assigned = Props::default();
    for branch in &object_branches {
        for (key, value) in entries(Some(branch)) {
            assigned.set(&key, value);
        }
    }
    let mut out = spread(without(&assigned.own, &["properties", "required"]), &without(&root, &["properties", "required"]));
    out.insert("type".into(), json!("object"));
    if let Some(properties) = properties {
        out.insert("properties".into(), Value::Object(properties.own));
    }
    if !required.is_empty() {
        out.insert("required".into(), Value::Array(required));
    }
    normalize_property_schema(&Value::Object(out))
}

/// One tool's schema as Node's `normalizeGrokToolSchemas` returns it for the `JSON.parse` of `schema`'s text, a lone
/// surrogate it makes marked with `marker` ([`lone_marker`] of a value holding `schema`).
pub(crate) fn flatten_schema(schema: &Value, marker: &str) -> Js<Value> {
    LONE_MARKER.with(|current| *current.borrow_mut() = marker.to_owned());
    normalize_tool_schema(&from_json(schema)).map(js_ordered_deep)
}

/// What [`flatten_tools`] did: whether any tool's text changed, and the marker of the lone surrogates the body may
/// now hold, to write it with [`js_json`].
pub struct Flattened {
    pub changed: bool,
    pub marker: String,
}

/// Flattens each tool's `parameters` of a parsed request body for Grok.
pub fn flatten_tools(body: &mut Value) -> Js<Flattened> {
    let marker = lone_marker(body);
    let mut changed = false;
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if let Some(parameters) = tool.get_mut("parameters") {
                let flat = flatten_schema(parameters, &marker)?;
                if js_json(&flat, &marker) != serde_json::to_vec(parameters).unwrap_or_default() {
                    *parameters = flat;
                    changed = true;
                }
            }
        }
    }
    Ok(Flattened { changed, marker })
}

#[cfg(test)]
mod tests;
