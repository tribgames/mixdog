//! Where Ajv's call stack runs out, so the core answers as Node does where Node's V8 stack overflows, without ever
//! recursing itself past a bound.
//!
//! Ajv compiles a schema with one nested call per reference it has not compiled yet, and validates with one nested
//! call per subschema it applies. Two ways reach V8's limit, and Node then answers the call with the SDK's
//! `Failed to validate structured content: Maximum call stack size exceeded`:
//! - compiling a chain of references too long, for every structured result, whether or not it reaches the chain
//!   ([`compile_overflows`]). Where depends on V8's frames, which shrink once Ajv's code is optimized: a fresh process
//!   overflows from about 2500–2750 references, a warmed one from about 6900, and in between the answer is not
//!   reproducible (two recordings answered a chain of 3000 differently). Node b6f10295a compiles a chain of 1000 and
//!   overflows on 10000;
//! - validating through a reference cycle that consumes nothing of the value (`a` → `b` → `a`, or `allOf: [{"$ref":
//!   "#"}]`): Ajv's generated code calls itself without end, but only once validation reaches the cycle
//!   ([`validation_overflows`]).
//!
//! The core's bound is [`STACK_LIMIT`]: a compile chain, or a validation path, of more references than that answers as
//! Node's overflow; below it the walk is iterative and visits each (subschema, value) pair once.

use std::collections::HashMap;

use serde_json::Value;

/// The most references a compile chain, or a validation path, may hold: between the 1000 Node always compiles and the
/// 10000 it always overflows on (`fixtures/mcp-output-schema`, "a chain of … references"), inside the band where Node's
/// own answer depends on V8's optimization (about 2500–6900).
pub(crate) const STACK_LIMIT: usize = 5000;
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

/// Whether compiling the schema overflows Ajv's stack: a chain of more than [`STACK_LIMIT`] references not compiled
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
                    if refs_on_stack + top.height > STACK_LIMIT {
                        return true;
                    }
                }
                None => {
                    refs_on_stack += weight;
                    if refs_on_stack > STACK_LIMIT {
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

/// The subschemas Ajv applies to `value` at `place`, each with the value it applies to: those it applies whatever the
/// value holds (`$ref`, `allOf`, `oneOf`, `not`, `if`, the first `anyOf` branch, `dependencies` of a present property)
/// and those it applies to the value's members. The reference's target, when there is one, comes first: the second value
/// is how many of the first entries are followed references (0 or 1), each a call of its own in Ajv's code.
fn applied<'s, 'v>(docs: &Documents<'s>, place: &Place<'s>, value: &'v Value) -> (Vec<(Place<'s>, &'v Value)>, usize) {
    let Value::Object(map) = place.node else { return (Vec::new(), 0) };
    let mut out = Vec::new();
    if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
        out.extend(docs.target(place.doc, place.base.as_ref(), reference).map(|target| (target, value)));
    }
    let refs = out.len();
    let always_valid = |schema: &Value| schema == &Value::Bool(true) || schema.as_object().is_some_and(|m| m.is_empty());
    for (keyword, schema) in map {
        match (keyword.as_str(), schema) {
            ("allOf" | "oneOf", Value::Array(items)) => out.extend(items.iter().map(|item| (place.inner(item), value))),
            // `anyOf` stops at the first branch that passes, and is skipped when a branch always passes.
            ("anyOf", Value::Array(items)) if !items.iter().any(always_valid) => {
                out.extend(items.first().map(|item| (place.inner(item), value)));
            }
            ("not" | "if", Value::Object(_)) => out.push((place.inner(schema), value)),
            ("dependencies", Value::Object(dependencies)) => {
                if let Value::Object(members) = value {
                    out.extend(
                        dependencies
                            .iter()
                            .filter(|(name, dependency)| dependency.is_object() && members.contains_key(*name))
                            .map(|(_, dependency)| (place.inner(dependency), value)),
                    );
                }
            }
            ("properties", Value::Object(properties)) => {
                if let Value::Object(members) = value {
                    out.extend(
                        properties
                            .iter()
                            .filter_map(|(name, schema)| Some((place.inner(schema), members.get(name)?))),
                    );
                }
            }
            // Members no `properties` names, when no `patternProperties` decides which those are.
            ("additionalProperties", Value::Object(_)) if !map.contains_key("patternProperties") => {
                if let Value::Object(members) = value {
                    let named = map.get("properties").and_then(Value::as_object);
                    out.extend(
                        members
                            .iter()
                            .filter(|(name, _)| named.is_none_or(|named| !named.contains_key(*name)))
                            .map(|(_, member)| (place.inner(schema), member)),
                    );
                }
            }
            ("items", Value::Object(_)) => {
                if let Value::Array(items) = value {
                    out.extend(items.iter().map(|item| (place.inner(schema), item)));
                }
            }
            ("items", Value::Array(schemas)) => {
                if let Value::Array(items) = value {
                    out.extend(schemas.iter().zip(items).map(|(schema, item)| (place.inner(schema), item)));
                    if let Some(rest @ Value::Object(_)) = map.get("additionalItems") {
                        out.extend(items.iter().skip(schemas.len()).map(|item| (place.inner(rest), item)));
                    }
                }
            }
            // `contains` stops at the first item that passes: the first is always tried.
            ("contains", Value::Object(_)) => {
                if let Some(first) = value.as_array().and_then(|items| items.first()) {
                    out.push((place.inner(schema), first));
                }
            }
            _ => {}
        }
    }
    (out, refs)
}

/// Whether validating `value` overflows Ajv's stack: validation reaches a subschema it is already applying to the same
/// value (a cycle that consumes nothing, which Ajv's code follows without end), or follows more than [`STACK_LIMIT`]
/// references on one path.
pub(crate) fn validation_overflows(docs: &Documents<'_>, value: &Value) -> bool {
    enum Seen {
        Open,
        Done(usize),
    }
    struct Frame<'s, 'v> {
        at: (usize, usize),
        applied: Vec<(Place<'s>, &'v Value)>,
        refs: usize,
        next: usize,
        height: usize,
    }
    fn frame<'s, 'v>(docs: &Documents<'s>, at: (usize, usize), place: &Place<'s>, member: &'v Value) -> Frame<'s, 'v> {
        let (applied, refs) = applied(docs, place, member);
        Frame { at, applied, refs, next: 0, height: 0 }
    }
    let root = docs.root();
    let start = (key(root.node), key(value));
    let mut seen: HashMap<(usize, usize), Seen> = HashMap::from([(start, Seen::Open)]);
    let mut stack = vec![frame(docs, start, &root, value)];
    let mut refs_on_stack = 0;
    while let Some(top) = stack.last_mut() {
        if top.next < top.applied.len() {
            let (place, member) = top.applied[top.next].clone();
            let weight = usize::from(top.next < top.refs);
            top.next += 1;
            let at = (key(place.node), key(member));
            match seen.get(&at) {
                Some(Seen::Open) => return true,
                Some(Seen::Done(height)) => {
                    top.height = top.height.max(height + weight);
                    if refs_on_stack + top.height > STACK_LIMIT {
                        return true;
                    }
                }
                None => {
                    refs_on_stack += weight;
                    if refs_on_stack > STACK_LIMIT {
                        return true;
                    }
                    seen.insert(at, Seen::Open);
                    let next = frame(docs, at, &place, member);
                    stack.push(next);
                }
            }
            continue;
        }
        let done = stack.pop().expect("a frame");
        seen.insert(done.at, Seen::Done(done.height));
        if let Some(parent) = stack.last_mut() {
            let weight = usize::from(parent.next - 1 < parent.refs);
            refs_on_stack -= weight;
            parent.height = parent.height.max(done.height + weight);
        }
    }
    false
}
