//! Why a tool schema is not a valid JSON Schema 2020-12 schema, worded as Node's Ajv words it
//! (`claude-bridge-schema.mjs` `assertValidDraft202012`). The text reaches the user (the
//! exclusion notice) and the model (the answer to a call of a left-out tool), so it is Ajv's:
//! the first error `validateSchema` reports, with its `instancePath` and `message`; and, for a
//! schema that is valid but does not compile, the `unresolvable $ref` report with the pointer to
//! the reference.
//!
//! [`first_error`] interprets the meta-schema (`meta_2020_12.json`: Ajv's own vocabulary files,
//! reduced to the keywords that decide validity) in the order Ajv evaluates keywords, so the first
//! error is the same one; `record-schema-wording.mjs` fuzzes the same interpreter against Ajv.
//!
//! A `pattern` that is not a regular expression is V8's `SyntaxError` text (`mixdog_js`). Not
//! reproduced: any other Ajv compile failure keeps the validator's own wording, and when a schema
//! has both an unresolvable `$ref` and a bad `pattern` the reference is reported (Ajv reports the
//! one its code generation meets first).

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Map;
use serde_json::Value;

use super::schema::Problem;
use super::schema::escape_pointer;

/// An error of the meta-schema: where (a JSON pointer into the schema) and Ajv's message.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct MetaError {
    pub pointer: String,
    pub message: String,
}

fn bundle() -> &'static Value {
    static BUNDLE: OnceLock<Value> = OnceLock::new();
    BUNDLE.get_or_init(|| serde_json::from_str(include_str!("meta_2020_12.json")).expect("the bundled meta-schema is JSON"))
}

/// A map's entries in JavaScript's key order: integer-like keys ascending, then the others as
/// written.
pub(crate) fn js_ordered(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    mixdog_js::js_object_keys(map).into_iter().map(|key| (key, &map[key])).collect()
}

fn is_type(data: &Value, kind: &str) -> bool {
    match kind {
        "object" => data.is_object(),
        "array" => data.is_array(),
        "string" => data.is_string(),
        "number" => data.is_number(),
        "integer" => data.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0),
        "boolean" => data.is_boolean(),
        "null" => data.is_null(),
        _ => false,
    }
}

/// Deep equality as JavaScript sees JSON: numbers by value, objects regardless of key order.
pub(crate) fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_equal(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| json_equal(value, other)))
        }
        _ => a == b,
    }
}

/// `uniqueItems`: Ajv compares pairwise from the end, except for an array whose `items` schema
/// has the single type `string`, where it hashes the strings from the end and names the pair
/// the other way round.
fn duplicate(items: &[Value], sibling: Option<&Value>) -> Option<String> {
    let strings = sibling.and_then(Value::as_object).and_then(|o| o.get("type")).and_then(Value::as_str) == Some("string");
    let message = |j: usize, i: usize| format!("must NOT have duplicate items (items ## {j} and {i} are identical)");
    if strings {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for (i, item) in items.iter().enumerate().rev() {
            let Some(text) = item.as_str() else { continue };
            if let Some(&first) = seen.get(text) {
                return Some(message(first, i));
            }
            seen.insert(text, i);
        }
        return None;
    }
    for (i, item) in items.iter().enumerate().rev() {
        for (j, earlier) in items[..i].iter().enumerate().rev() {
            if json_equal(item, earlier) {
                return Some(message(j, i));
            }
        }
    }
    None
}

/// Where a `$ref` of the meta-schema points: the vocabulary it lies in and the node.
fn resolve<'a>(reference: &str, vocab: Option<&'a Value>) -> (&'a Value, &'a Value) {
    let (file, fragment) = reference.split_once('#').unwrap_or((reference, ""));
    let target = match (file.strip_prefix("meta/"), vocab) {
        (Some(name), _) => &bundle()["vocabs"][name],
        (None, Some(local)) => local,
        (None, None) => &bundle()["root"],
    };
    let node = fragment.split('/').skip(1).fold(target, |node, key| &node[key]);
    (target, node)
}

/// The first error of `data` against `schema`, in the order Ajv evaluates keywords: `type`, then
/// `$ref`, `enum`, `anyOf`, `allOf`, then the keywords of the data's type (numbers, strings, arrays,
/// objects), `properties` in the meta-schema's order and `additionalProperties` in the data's.
fn check(schema: &Value, data: &Value, path: &str, vocab: Option<&Value>) -> Option<MetaError> {
    // `true` accepts everything.
    let rules = schema.as_object()?;
    let error = |message: String| Some(MetaError { pointer: path.to_owned(), message });
    if let Some(declared) = rules.get("type") {
        let types: Vec<&str> = match declared {
            Value::String(kind) => vec![kind.as_str()],
            Value::Array(list) => list.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.iter().any(|kind| is_type(data, kind)) {
            return error(format!("must be {}", types.join(",")));
        }
    }
    if let Some(reference) = rules.get("$ref").and_then(Value::as_str) {
        let (target, node) = resolve(reference, vocab);
        if let Some(found) = check(node, data, path, Some(target)) {
            return Some(found);
        }
    }
    // `$dynamicRef: "#meta"` always lands on the outermost meta-schema.
    if rules.contains_key("$dynamicRef")
        && let Some(found) = check(&bundle()["root"], data, path, None)
    {
        return Some(found);
    }
    if let Some(Value::Array(allowed)) = rules.get("enum")
        && !allowed.iter().any(|value| json_equal(value, data))
    {
        return error("must be equal to one of the allowed values".into());
    }
    if let Some(Value::Array(branches)) = rules.get("anyOf") {
        let mut first = None;
        let mut passed = false;
        for branch in branches {
            match check(branch, data, path, vocab) {
                None => {
                    passed = true;
                    break;
                }
                Some(found) => {
                    first.get_or_insert(found);
                }
            }
        }
        if !passed {
            return first;
        }
    }
    if let Some(Value::Array(branches)) = rules.get("allOf") {
        for branch in branches {
            if let Some(found) = check(branch, data, path, vocab) {
                return Some(found);
            }
        }
    }
    if let Some(number) = data.as_f64() {
        if let Some(minimum) = rules.get("minimum").and_then(Value::as_f64)
            && number < minimum
        {
            return error(format!("must be >= {minimum}"));
        }
        if let Some(minimum) = rules.get("exclusiveMinimum").and_then(Value::as_f64)
            && number <= minimum
        {
            return error(format!("must be > {minimum}"));
        }
    }
    if let Some(text) = data.as_str()
        && let Some(pattern) = rules.get("pattern").and_then(Value::as_str)
        && !Regex::new(pattern).is_ok_and(|re| re.is_match(text))
    {
        return error(format!("must match pattern \"{pattern}\""));
    }
    if let Value::Array(items) = data {
        if let Some(minimum) = rules.get("minItems").and_then(Value::as_f64)
            && (items.len() as f64) < minimum
        {
            return error(format!("must NOT have fewer than {minimum} items"));
        }
        if rules.get("uniqueItems") == Some(&Value::Bool(true))
            && let Some(message) = duplicate(items, rules.get("items"))
        {
            return error(message);
        }
        if let Some(sub) = rules.get("items")
            && !matches!(sub, Value::Bool(true))
        {
            for (i, item) in items.iter().enumerate() {
                if let Some(found) = check(sub, item, &format!("{path}/{i}"), vocab) {
                    return Some(found);
                }
            }
        }
    }
    if let Value::Object(map) = data {
        if let Some(sub) = rules.get("additionalProperties")
            && !matches!(sub, Value::Bool(true))
        {
            let known = rules.get("properties").and_then(Value::as_object);
            for (key, value) in js_ordered(map) {
                if known.is_some_and(|known| known.contains_key(key)) {
                    continue;
                }
                if let Some(found) = check(sub, value, &format!("{path}/{}", escape_pointer(key)), vocab) {
                    return Some(found);
                }
            }
        }
        if let Some(Value::Object(properties)) = rules.get("properties") {
            for (key, sub) in properties {
                let Some(value) = map.get(key) else { continue };
                if let Some(found) = check(sub, value, &format!("{path}/{}", escape_pointer(key)), vocab) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// What `ajv.validateSchema(schema)` reports first, or `None` when the schema is valid.
pub(crate) fn first_error(schema: &Value) -> Option<MetaError> {
    check(&bundle()["root"], schema, "", None)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = text.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn has_anchor(node: &Value, name: &str) -> bool {
    match node {
        Value::Array(list) => list.iter().any(|child| has_anchor(child, name)),
        Value::Object(map) => {
            ["$anchor", "$dynamicAnchor"].iter().any(|key| map.get(*key).and_then(Value::as_str) == Some(name))
                || map.values().any(|child| has_anchor(child, name))
        }
        _ => false,
    }
}

fn has_id(node: &Value, id: &str) -> bool {
    match node {
        Value::Array(list) => list.iter().any(|child| has_id(child, id)),
        Value::Object(map) => {
            map.get("$id").and_then(Value::as_str).is_some_and(|own| own.split('#').next() == Some(id))
                || map.values().any(|child| has_id(child, id))
        }
        _ => false,
    }
}

/// Whether the fragment of a reference names something in `root`: a JSON pointer, or an anchor.
fn fragment_resolves(fragment: &str, root: &Value) -> bool {
    if fragment.is_empty() {
        return true;
    }
    let Some(pointer) = fragment.strip_prefix('/') else {
        return has_anchor(root, &percent_decode(fragment));
    };
    let mut node = root;
    for token in pointer.split('/') {
        let key = percent_decode(token).replace("~1", "/").replace("~0", "~");
        let next = match node {
            Value::Object(map) => map.get(&key),
            Value::Array(list) => key.parse::<usize>().ok().and_then(|i| list.get(i)),
            _ => None,
        };
        let Some(next) = next else { return false };
        node = next;
    }
    true
}

fn resolves(reference: &str, root: &Value) -> bool {
    let (base, fragment) = reference.split_once('#').unwrap_or((reference, ""));
    let own = root.get("$id").and_then(Value::as_str).map(|id| id.split('#').next().unwrap_or(""));
    if !base.is_empty() && own != Some(base) {
        return has_id(root, base);
    }
    fragment_resolves(fragment, root)
}

/// The first reference, in `refPointer`'s walk (arrays by index, objects in JavaScript key order),
/// that nothing resolves: its pointer and text.
fn unresolved(node: &Value, root: &Value, pointer: &str) -> Option<(String, String)> {
    match node {
        Value::Array(list) => list.iter().enumerate().find_map(|(i, child)| unresolved(child, root, &format!("{pointer}/{i}"))),
        Value::Object(map) => {
            if let Some(reference) = map.get("$ref").and_then(Value::as_str)
                && !resolves(reference, root)
            {
                return Some((format!("{pointer}/$ref"), reference.to_owned()));
            }
            js_ordered(map)
                .into_iter()
                .find_map(|(key, child)| unresolved(child, root, &format!("{pointer}/{}", escape_pointer(key))))
        }
        _ => None,
    }
}

const SCHEMA_MAPS: [&str; 5] = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_NODES: [&str; 11] = [
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
const SCHEMA_LISTS: [&str; 4] = ["prefixItems", "allOf", "anyOf", "oneOf"];

/// V8's `SyntaxError` text for the first `pattern` (or `patternProperties` key) of a schema node
/// that `new RegExp(pattern, "u")` refuses: Ajv compiles each, and the error reaches it unchanged.
fn bad_pattern(node: &Value) -> Option<String> {
    let map = node.as_object()?;
    if let Some(pattern) = map.get("pattern").and_then(Value::as_str)
        && let Some(message) = mixdog_js::js_regex_error(pattern, "u")
    {
        return Some(message);
    }
    for (key, value) in js_ordered(map) {
        let found = match value {
            Value::Object(children) if SCHEMA_MAPS.contains(&key.as_str()) => {
                let own = if key == "patternProperties" {
                    js_ordered(children).into_iter().find_map(|(pattern, _)| mixdog_js::js_regex_error(pattern, "u"))
                } else {
                    None
                };
                own.or_else(|| js_ordered(children).into_iter().find_map(|(_, child)| bad_pattern(child)))
            }
            Value::Array(list) if SCHEMA_LISTS.contains(&key.as_str()) => list.iter().find_map(bad_pattern),
            other if SCHEMA_NODES.contains(&key.as_str()) => bad_pattern(other),
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Why a schema that passed the meta-schema does not compile. Ajv names a reference by its
/// resolved address, so a root `$id` prefixes a local one; a `pattern` that is not a regular
/// expression is V8's `SyntaxError` text.
pub(crate) fn compile_problem(root: &Value, fallback: &str) -> Problem {
    if let Some((pointer, reference)) = unresolved(root, root, "") {
        let base = root.get("$id").and_then(Value::as_str).map(|id| id.split('#').next().unwrap_or(""));
        let address = match base {
            Some(base) if reference.starts_with('#') => format!("{base}{reference}"),
            _ => reference,
        };
        return Problem { pointer, reason: format!("unresolvable $ref \"{address}\"") };
    }
    Problem { pointer: String::new(), reason: bad_pattern(root).unwrap_or_else(|| fallback.to_owned()) }
}
