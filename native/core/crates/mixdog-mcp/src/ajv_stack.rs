//! Where Ajv's call stack runs out, so the core answers as Node does where Node's V8 stack overflows, without ever
//! recursing itself past a bound.
//!
//! Ajv compiles a schema with one nested call per reference it has not compiled yet, and validates with one nested
//! call per subschema it applies. Two ways reach V8's limit, and Node then answers the call with the SDK's
//! `Failed to validate structured content: Maximum call stack size exceeded`:
//! - compiling a chain of references too long, for every structured result, whether or not it reaches the chain
//!   ([`compile_overflows`]);
//! - validating through a path of references too long, or through a reference cycle that consumes nothing of the value
//!   (`a` → `b` → `a`, or `allOf: [{"$ref": "#"}]`): Ajv's generated code calls itself without end, but only once its
//!   evaluation, which skips what its short-circuits skip, reaches the cycle ([`validation_overflows`]).
//!
//! Where V8 runs out depends on its frames, which shrink once Ajv's code is optimized. In a Node process that has run
//! nothing before (`fixtures/mcp-output-schema`, `freshProcesses`, each length run in sixteen fresh processes): a chain of
//! 2110 references validates and one of 2111 overflows, every time; a chain of 2200 compiles every time, one of 2440
//! compiles in some processes and overflows in others, and one of 2560 overflows every time. The recording's other
//! cases, run one after another in one process, compile and validate a chain of 1000 and overflow on one of 10000.
//!
//! The core's bounds are [`COMPILE_LIMIT`] and [`VALIDATION_LIMIT`]: a compile chain, or a validation path, of more
//! references than its bound answers as a fresh Node process's overflow. The compile walk is iterative; the validation
//! walk follows Ajv's order recursively, on a thread of its own, and visits each (subschema, value, mode) once.

use std::collections::HashMap;

use serde_json::Value;

/// The most references a compile chain may hold: a chain of 2200 (2201 references with the one that enters it) compiles in
/// a fresh Node process and one of 2560 overflows; between them a fresh process answers either, and the bound is inside.
pub(crate) const COMPILE_LIMIT: usize = 2460;
/// The most references a validation path may hold: a fresh Node process validates a chain of 2110 (2111 references with
/// the one that enters it) and overflows on 2111.
pub(crate) const VALIDATION_LIMIT: usize = 2111;
/// V8's `RangeError` text.
pub(crate) const STACK_OVERFLOW: &str = "Maximum call stack size exceeded";

/// The documents a `$ref` can name: the schema itself, the resources it declares (`$id`), and those registered by the
/// schemas listed before it.
pub(crate) struct Documents<'s> {
    root: &'s Value,
    root_base: Option<url::Url>,
    ids: HashMap<String, &'s Value>,
}

/// An address without its fragment.
fn base_of(id: &str) -> &str {
    id.split_once('#').map_or(id, |(base, _)| base)
}

/// The resource base `node` sets for what is inside it, from the one around it.
fn own_base(node: &Value, around: Option<&url::Url>) -> Option<url::Url> {
    match node.get("$id").and_then(Value::as_str) {
        Some(id) => match around {
            Some(base) => base.join(id).ok(),
            None => url::Url::parse(id).ok(),
        }
        .or_else(|| around.cloned()),
        None => around.cloned(),
    }
}

/// The subschemas of `node`: Ajv's walk of a schema (`json-schema-traverse`), everything else being data.
fn subschemas(node: &Value) -> Vec<&Value> {
    let Value::Object(map) = node else { return Vec::new() };
    let mut out = Vec::new();
    for (key, value) in map {
        match (key.as_str(), value) {
            (
                "additionalItems" | "items" | "contains" | "additionalProperties" | "propertyNames" | "not" | "if"
                | "then" | "else",
                Value::Object(_) | Value::Bool(_),
            ) => out.push(value),
            ("items" | "allOf" | "anyOf" | "oneOf", Value::Array(items)) => out.extend(items),
            ("$defs" | "definitions" | "properties" | "patternProperties" | "dependencies", Value::Object(entries)) => {
                out.extend(entries.values().filter(|v| v.is_object() || v.is_boolean()));
            }
            _ => {}
        }
    }
    out
}

impl<'s> Documents<'s> {
    pub(crate) fn new(root: &'s Value, registered: &'s HashMap<String, Value>) -> Self {
        let mut ids: HashMap<String, &'s Value> = registered.iter().map(|(k, v)| (k.clone(), v)).collect();
        let root_base = own_base(root, None);
        // The schema's own resources, by their resolved address, over what was registered before.
        let mut pending = vec![(root, None::<url::Url>)];
        while let Some((node, around)) = pending.pop() {
            let base = own_base(node, around.as_ref());
            if node.get("$id").and_then(Value::as_str).is_some() {
                if let Some(address) = &base {
                    ids.insert(base_of(address.as_str()).to_owned(), node);
                }
            }
            pending.extend(subschemas(node).into_iter().map(|child| (child, base.clone())));
        }
        Self { root, root_base, ids }
    }

    /// The subschema `reference` names from inside `doc` (whose base is `base`), with its document and base.
    fn target(&self, doc: &'s Value, base: Option<&url::Url>, reference: &str) -> Option<Place<'s>> {
        let (address, fragment) = reference.split_once('#').unwrap_or((reference, ""));
        let (doc, base) = if address.is_empty() {
            (doc, base.cloned())
        } else {
            let url = match base {
                Some(base) => base.join(address).ok()?,
                None => url::Url::parse(address).ok()?,
            };
            (*self.ids.get(base_of(url.as_str()))?, Some(url))
        };
        let node = match fragment {
            "" => doc,
            pointer if pointer.starts_with('/') => doc.pointer(pointer)?,
            // A plain-name fragment (an anchor): Ajv's draft-07 resolves those by `$id`; not followed here.
            _ => return None,
        };
        Some(Place { node, doc, base })
    }

    fn root(&self) -> Place<'s> {
        Place { node: self.root, doc: self.root, base: self.root_base.clone() }
    }
}

/// A subschema, the document its `#` fragments point into, and the base its relative references resolve against.
#[derive(Clone)]
struct Place<'s> {
    node: &'s Value,
    doc: &'s Value,
    base: Option<url::Url>,
}

impl<'s> Place<'s> {
    /// The place of a subschema of this one.
    fn inner(&self, node: &'s Value) -> Self {
        // A subschema declaring `$id` is a document of its own.
        match node.get("$id").and_then(Value::as_str) {
            Some(_) => Place { node, doc: node, base: own_base(node, self.base.as_ref()) },
            None => Place { node, doc: self.doc, base: self.base.clone() },
        }
    }
}

fn key(value: &Value) -> usize {
    std::ptr::from_ref(value) as usize
}

/// Whether compiling the schema overflows Ajv's stack: a chain of more than [`COMPILE_LIMIT`] references not compiled
/// before (a reference back into the chain is a recursive function Ajv calls, not a compile).
pub(crate) fn compile_overflows(docs: &Documents<'_>) -> bool {
    // Iterative depth-first walk; `heights` holds, per finished subschema, the most references below it.
    enum Seen {
        Open,
        Done(usize),
    }
    struct Frame<'s> {
        at: usize,
        edges: Vec<(Place<'s>, usize)>,
        next: usize,
        height: usize,
    }
    /// The subschemas compiled with `place` (weight 0) and the reference it compiles (weight 1).
    fn edges<'s>(docs: &Documents<'s>, place: &Place<'s>) -> Vec<(Place<'s>, usize)> {
        let mut out: Vec<(Place<'s>, usize)> = subschemas(place.node).into_iter().map(|n| (place.inner(n), 0)).collect();
        if let Some(reference) = place.node.get("$ref").and_then(Value::as_str) {
            out.extend(docs.target(place.doc, place.base.as_ref(), reference).map(|target| (target, 1)));
        }
        out
    }
    let root = docs.root();
    let mut seen: HashMap<usize, Seen> = HashMap::from([(key(root.node), Seen::Open)]);
    let mut stack = vec![Frame { at: key(root.node), edges: edges(docs, &root), next: 0, height: 0 }];
    let mut refs_on_stack = 0;
    while let Some(top) = stack.last_mut() {
        if top.next < top.edges.len() {
            let (place, weight) = top.edges[top.next].clone();
            top.next += 1;
            match seen.get(&key(place.node)) {
                Some(Seen::Open) => {}
                Some(Seen::Done(height)) => {
                    top.height = top.height.max(height + weight);
                    if refs_on_stack + top.height > COMPILE_LIMIT {
                        return true;
                    }
                }
                None => {
                    refs_on_stack += weight;
                    if refs_on_stack > COMPILE_LIMIT {
                        return true;
                    }
                    seen.insert(key(place.node), Seen::Open);
                    let next = Frame { at: key(place.node), edges: edges(docs, &place), next: 0, height: 0 };
                    stack.push(next);
                }
            }
            continue;
        }
        let done = stack.pop().expect("a frame");
        seen.insert(done.at, Seen::Done(done.height));
        if let Some(parent) = stack.last_mut() {
            let weight = parent.edges[parent.next - 1].1;
            refs_on_stack -= weight;
            parent.height = parent.height.max(done.height + weight);
        }
    }
    false
}

/// What the walk asks of the keywords it does not apply subschemas through: whether `value` passes `keyword` of `schema`
/// (`type`, `const`, `enum`, the number, string, array and object limits, `pattern`, `format`, `required`, `uniqueItems`,
/// the property lists of `dependencies`), and whether a property name matches a `patternProperties` pattern. The caller
/// answers with validators built as the result's own is, so the walk decides each short-circuit as the result's verdict
/// has it.
pub(crate) trait Keywords {
    fn holds(&self, schema: &Value, keyword: &str, value: &Value) -> bool;
    fn matches(&self, pattern: &str, name: &str) -> bool;
}

/// The keywords Ajv draft-07 has a rule for (`RULES.all`): a schema with none of them always passes, without a call.
const RULES: [&str; 37] = [
    "$comment", "id", "$ref", "maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf", "maxLength",
    "minLength", "pattern", "maxProperties", "minProperties", "required", "maxItems", "minItems", "uniqueItems", "type",
    "nullable", "const", "enum", "not", "anyOf", "oneOf", "allOf", "if", "then", "else", "propertyNames",
    "additionalProperties", "dependencies", "properties", "patternProperties", "additionalItems", "items", "contains",
    "format",
];

/// Ajv's rule groups in the order its generated code applies them (`RULES.rules`): the keywords of any type, then those
/// of numbers, strings, arrays and objects, each in vocabulary order (`additionalItems`, `items` and `contains` go
/// `before: "uniqueItems"`).
const UNTYPED: [&str; 8] = ["$ref", "const", "enum", "not", "anyOf", "oneOf", "allOf", "if"];
const TYPED: [(Kind, &[&str]); 4] = [
    (Kind::Number, &["maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf", "format"]),
    (Kind::String, &["maxLength", "minLength", "pattern", "format"]),
    (Kind::Array, &["maxItems", "minItems", "additionalItems", "items", "contains", "uniqueItems"]),
    (
        Kind::Object,
        &[
            "maxProperties", "minProperties", "required", "propertyNames", "additionalProperties", "dependencies",
            "properties", "patternProperties",
        ],
    ),
];
/// The core's own bound on nested subschemas on one path, references or not (Ajv inlines a subschema into its caller's
/// code, so only references are V8 frames): a path that long holds more than 780 references between subschemas nested
/// 128 deep, the most a listing parses to. Past it the core answers the overflow.
const LEVEL_LIMIT: usize = 100_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object,
}

/// A value validation applies a subschema to: a part of the result, or a property name (`propertyNames`).
#[derive(Clone, Copy)]
enum Data<'v> {
    Node(&'v Value),
    Name(&'v String),
}

impl<'v> Data<'v> {
    fn key(self) -> usize {
        match self {
            Data::Node(value) => key(value),
            Data::Name(name) => std::ptr::from_ref(name) as usize,
        }
    }

    fn kind(self) -> Kind {
        match self {
            Data::Name(_) | Data::Node(Value::String(_)) => Kind::String,
            Data::Node(Value::Null) => Kind::Null,
            Data::Node(Value::Bool(_)) => Kind::Boolean,
            Data::Node(Value::Number(_)) => Kind::Number,
            Data::Node(Value::Array(_)) => Kind::Array,
            Data::Node(Value::Object(_)) => Kind::Object,
        }
    }

    fn value(self) -> std::borrow::Cow<'v, Value> {
        match self {
            Data::Node(value) => std::borrow::Cow::Borrowed(value),
            Data::Name(name) => std::borrow::Cow::Owned(Value::String(name.clone())),
        }
    }

    fn object(self) -> Option<&'v serde_json::Map<String, Value>> {
        match self {
            Data::Node(Value::Object(members)) => Some(members),
            _ => None,
        }
    }

    fn array(self) -> Option<&'v Vec<Value>> {
        match self {
            Data::Node(Value::Array(items)) => Some(items),
            _ => None,
        }
    }
}

/// `alwaysValidSchema`: `true`, or an object with no keyword Ajv has a rule for.
fn always_valid(schema: &Value) -> bool {
    match schema {
        Value::Bool(passes) => *passes,
        Value::Object(map) => !map.keys().any(|k| RULES.contains(&k.as_str())),
        _ => false,
    }
}

/// `checkDataType` of one `type` name.
fn has_type(name: &str, data: Data<'_>) -> bool {
    match (name, data.kind()) {
        ("integer", Kind::Number) => data.value().as_f64().is_some_and(|n| n.fract() == 0.0),
        (name, kind) => {
            kind == match name {
                "null" => Kind::Null,
                "boolean" => Kind::Boolean,
                "number" => Kind::Number,
                "string" => Kind::String,
                "array" => Kind::Array,
                "object" => Kind::Object,
                _ => return false,
            }
        }
    }
}

/// A map's entries in JavaScript's own-key order (`for … in`, `Object.keys`): array indices ascending, then the rest as
/// written.
fn js_order(map: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |k: &str| (k == "0" || (!k.starts_with('0') && k.bytes().all(|b| b.is_ascii_digit()))).then(|| k.parse::<u64>().ok()).flatten().filter(|n| *n < u64::from(u32::MAX));
    let mut indices: Vec<(u64, (&String, &Value))> = map.iter().filter_map(|entry| Some((index(entry.0)?, entry))).collect();
    indices.sort_by_key(|(n, _)| *n);
    indices.into_iter().map(|(_, entry)| entry).chain(map.iter().filter(|(k, _)| index(k).is_none())).collect()
}

/// The walk stopped where Node's validation overflows V8's stack.
struct Overflow;

enum Seen {
    Open,
    /// The verdict, and the most references any path below held.
    Done(bool, usize),
}

/// Ajv's validation of one result, in the order its generated code runs (`allErrors` on, as the SDK's Ajv has it, and off
/// inside `not` and `if`, which Ajv compiles without it), with each short-circuit taken where that code takes it: the
/// branches of `anyOf` after the first that passes, of `oneOf` after the second, the one of `then` and `else` the `if`
/// does not choose, `if` with neither, and, without `allErrors`, everything after the first failing keyword, property or
/// item. A followed reference is a call of the function Ajv compiled for its target, which runs with `allErrors` again.
struct Walk<'d, 's, K> {
    docs: &'d Documents<'s>,
    keywords: &'d K,
    seen: HashMap<(usize, usize, bool), Seen>,
    refs: usize,
    levels: usize,
    /// The most references any path below the subschema being applied held so far.
    height: usize,
}

impl<'s, K: Keywords> Walk<'_, 's, K> {
    /// `place` applied to `data`, `weight` 1 when it is a followed reference.
    fn apply(&mut self, place: &Place<'s>, data: Data<'_>, all: bool, weight: usize) -> Result<bool, Overflow> {
        let at = (key(place.node), data.key(), all);
        match self.seen.get(&at) {
            // The same subschema, the same value, the same mode: Ajv's code calls itself without end.
            Some(Seen::Open) => return Err(Overflow),
            Some(&Seen::Done(valid, height)) => {
                if self.refs + weight + height > VALIDATION_LIMIT {
                    return Err(Overflow);
                }
                self.height = self.height.max(height + weight);
                return Ok(valid);
            }
            None => {}
        }
        self.refs += weight;
        self.levels += 1;
        if self.refs > VALIDATION_LIMIT || self.levels > LEVEL_LIMIT {
            return Err(Overflow);
        }
        self.seen.insert(at, Seen::Open);
        let outer = std::mem::take(&mut self.height);
        let valid = self.schema(place, data, all)?;
        let height = std::mem::replace(&mut self.height, outer);
        self.height = self.height.max(height + weight);
        self.refs -= weight;
        self.levels -= 1;
        self.seen.insert(at, Seen::Done(valid, height));
        Ok(valid)
    }

    fn sub(&mut self, place: &Place<'s>, schema: &'s Value, data: Data<'_>, all: bool) -> Result<bool, Overflow> {
        if always_valid(schema) {
            return Ok(true);
        }
        self.apply(&place.inner(schema), data, all, 0)
    }

    /// `subschemaCode`, then `schemaKeywords`.
    fn schema(&mut self, place: &Place<'s>, data: Data<'_>, all: bool) -> Result<bool, Overflow> {
        let map = match place.node {
            Value::Bool(passes) => return Ok(*passes),
            Value::Object(map) if !always_valid(place.node) => map,
            _ => return Ok(true),
        };
        // A `$ref` with no other rule is the reference alone.
        if map.contains_key("$ref") && !map.keys().any(|k| k != "$ref" && RULES.contains(&k.as_str())) {
            return self.keyword(place, map, "$ref", data, all);
        }
        let types: Vec<&str> = match map.get("type") {
            Some(Value::String(name)) => vec![name.as_str()],
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        let uses = |keywords: &[&str]| keywords.iter().any(|k| map.contains_key(*k));
        // `coerceAndCheckDataType`: the type is checked first unless it is one type whose group the schema uses.
        let first = !types.is_empty()
            && !(types.len() == 1 && TYPED.iter().any(|(kind, keywords)| has_type_name(types[0], *kind) && uses(keywords)));
        let mut valid = !(first && !types.iter().any(|name| has_type(name, data)));
        valid &= self.group(place, map, &UNTYPED, data, all)?;
        if !all && !valid {
            return Ok(false);
        }
        for (kind, keywords) in TYPED {
            if !uses(keywords) {
                continue;
            }
            if data.kind() == kind {
                valid &= self.group(place, map, keywords, data, all)?;
            } else if !first && types.len() == 1 && has_type_name(types[0], kind) {
                valid = false;
            }
            if !all && !valid {
                return Ok(false);
            }
        }
        Ok(valid)
    }

    /// The keywords of one group present in the schema, in order; without `allErrors`, up to the first that fails.
    fn group(&mut self, place: &Place<'s>, map: &'s serde_json::Map<String, Value>, keywords: &[&str], data: Data<'_>, all: bool) -> Result<bool, Overflow> {
        let mut valid = true;
        for keyword in keywords.iter().filter(|k| map.contains_key(**k)) {
            if !self.keyword(place, map, keyword, data, all)? {
                valid = false;
                if !all {
                    break;
                }
            }
        }
        Ok(valid)
    }

    fn keyword(&mut self, place: &Place<'s>, map: &'s serde_json::Map<String, Value>, keyword: &str, data: Data<'_>, all: bool) -> Result<bool, Overflow> {
        let schema = &map[keyword];
        match (keyword, schema) {
            ("$ref", Value::String(reference)) => match self.docs.target(place.doc, place.base.as_ref(), reference) {
                Some(target) => self.apply(&target, data, true, 1),
                None => Ok(true),
            },
            ("not", _) => Ok(!always_valid(schema) && !self.apply(&place.inner(schema), data, false, 0)?),
            ("anyOf", Value::Array(branches)) => {
                if branches.iter().any(always_valid) {
                    return Ok(true);
                }
                for branch in branches {
                    if self.apply(&place.inner(branch), data, all, 0)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            ("oneOf", Value::Array(branches)) => {
                let mut valid = false;
                for branch in branches {
                    let passes = self.sub(place, branch, data, all)?;
                    if passes && valid {
                        return Ok(false);
                    }
                    valid |= passes;
                }
                Ok(valid)
            }
            ("allOf", Value::Array(branches)) => {
                let mut valid = true;
                for branch in branches.iter().filter(|b| !always_valid(b)) {
                    if !self.apply(&place.inner(branch), data, all, 0)? {
                        valid = false;
                        if !all {
                            break;
                        }
                    }
                }
                Ok(valid)
            }
            ("if", _) => {
                let clause = |name: &str| map.get(name).filter(|s| !always_valid(s));
                let (then, otherwise) = (clause("then"), clause("else"));
                if then.is_none() && otherwise.is_none() {
                    return Ok(true);
                }
                let chosen = if self.sub(place, schema, data, false)? { then } else { otherwise };
                match chosen {
                    Some(clause) => self.apply(&place.inner(clause), data, all, 0),
                    None => Ok(true),
                }
            }
            ("propertyNames", _) => {
                let mut valid = true;
                if let (false, Some(members)) = (always_valid(schema), data.object()) {
                    for (name, _) in js_order(members) {
                        if !self.apply(&place.inner(schema), Data::Name(name), all, 0)? {
                            valid = false;
                            if !all {
                                break;
                            }
                        }
                    }
                }
                Ok(valid)
            }
            ("additionalProperties", _) => {
                if always_valid(schema) {
                    return Ok(true);
                }
                let named = map.get("properties").and_then(Value::as_object);
                let patterns: Vec<&String> = map.get("patternProperties").and_then(Value::as_object).map(|p| p.keys().collect()).unwrap_or_default();
                let mut valid = true;
                for (name, member) in data.object().map(js_order).unwrap_or_default() {
                    if named.is_some_and(|named| named.contains_key(name)) || patterns.iter().any(|p| self.keywords.matches(p, name)) {
                        continue;
                    }
                    if !(schema.is_object() && self.apply(&place.inner(schema), Data::Node(member), all, 0)?) {
                        valid = false;
                        if !all {
                            break;
                        }
                    }
                }
                Ok(valid)
            }
            ("dependencies", Value::Object(dependencies)) => {
                // The property lists first; without `allErrors`, a missing property stops the schemas.
                let mut valid = !dependencies.values().any(Value::is_array) || self.keywords.holds(place.node, keyword, &data.value());
                if !all && !valid {
                    return Ok(false);
                }
                let members = data.object();
                for (name, dependency) in js_order(dependencies) {
                    if dependency.is_array() || always_valid(dependency) || !members.is_some_and(|m| m.contains_key(name)) {
                        continue;
                    }
                    if !self.apply(&place.inner(dependency), data, all, 0)? {
                        valid = false;
                        if !all {
                            break;
                        }
                    }
                }
                Ok(valid)
            }
            ("properties", Value::Object(properties)) => {
                let mut valid = true;
                let members = data.object();
                for (name, property) in js_order(properties) {
                    let Some(member) = members.and_then(|m| m.get(name)) else { continue };
                    if !self.sub(place, property, Data::Node(member), all)? {
                        valid = false;
                        if !all {
                            break;
                        }
                    }
                }
                Ok(valid)
            }
            ("patternProperties", Value::Object(patterns)) => {
                let mut valid = true;
                let members = data.object().map(js_order).unwrap_or_default();
                for (pattern, property) in js_order(patterns) {
                    let mut matched = true;
                    for (name, member) in &members {
                        if self.keywords.matches(pattern, name) && !self.sub(place, property, Data::Node(member), all)? {
                            matched = false;
                            if !all {
                                break;
                            }
                        }
                    }
                    valid &= matched;
                    if !all && !valid {
                        break;
                    }
                }
                Ok(valid)
            }
            ("additionalItems", _) => {
                let (Some(Value::Array(tuple)), Some(items)) = (map.get("items"), data.array()) else { return Ok(true) };
                match schema {
                    Value::Bool(false) => Ok(items.len() <= tuple.len()),
                    Value::Object(_) if !always_valid(schema) => {
                        let mut valid = true;
                        for item in items.iter().skip(tuple.len()) {
                            if !self.apply(&place.inner(schema), Data::Node(item), all, 0)? {
                                valid = false;
                                if !all {
                                    break;
                                }
                            }
                        }
                        Ok(valid)
                    }
                    _ => Ok(true),
                }
            }
            ("items", _) => {
                let Some(items) = data.array() else { return Ok(true) };
                let pairs: Vec<(&'s Value, &Value)> = match schema {
                    Value::Array(tuple) => tuple.iter().zip(items).collect(),
                    _ => items.iter().map(|item| (schema, item)).collect(),
                };
                let mut valid = true;
                for (schema, item) in pairs {
                    if !self.sub(place, schema, Data::Node(item), all)? {
                        valid = false;
                        if !all {
                            break;
                        }
                    }
                }
                Ok(valid)
            }
            ("contains", _) => {
                let items = data.array().map(Vec::as_slice).unwrap_or_default();
                if always_valid(schema) {
                    return Ok(!items.is_empty());
                }
                for item in items {
                    if self.apply(&place.inner(schema), Data::Node(item), all, 0)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            _ => Ok(self.keywords.holds(place.node, keyword, &data.value())),
        }
    }
}

/// Whether `kind` is the group of the `type` name (`integer` has none: its type is always checked first).
fn has_type_name(name: &str, kind: Kind) -> bool {
    matches!((name, kind), ("number", Kind::Number) | ("string", Kind::String) | ("array", Kind::Array) | ("object", Kind::Object))
}

/// Whether validating `value` overflows Ajv's stack: the validation Ajv's code runs (see [`Walk`]) reaches a subschema
/// it is already applying to the same value in the same mode (a cycle that consumes nothing, which Ajv's code follows
/// without end), or follows more than [`VALIDATION_LIMIT`] references on one path. Recursive: run it on a thread whose stack
/// holds [`LEVEL_LIMIT`] levels ([`WALK_STACK`]).
pub(crate) fn validation_overflows(docs: &Documents<'_>, value: &Value, keywords: &impl Keywords) -> bool {
    let mut walk = Walk { docs, keywords, seen: HashMap::new(), refs: 0, levels: 0, height: 0 };
    walk.apply(&docs.root(), Data::Node(value), true, 0).is_err()
}

/// The stack of the thread [`validation_overflows`] runs on.
pub(crate) const WALK_STACK: usize = 512 << 20;

/// Whether `schema` holds a reference anywhere: without one, validation nests no deeper than the schema, and no stack
/// overflows.
pub(crate) fn references(schema: &Value) -> bool {
    match schema {
        Value::Object(map) => map.iter().any(|(k, v)| k == "$ref" || references(v)),
        Value::Array(items) => items.iter().any(references),
        _ => false,
    }
}
