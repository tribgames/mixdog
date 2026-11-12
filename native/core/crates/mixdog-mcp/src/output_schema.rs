//! The `outputSchema` of a server's tools, enforced on their results as the MCP SDK client does
//! (`Client.cacheToolMetadata` / `callTool` with the SDK's Ajv validator, compiled on a tool's
//! first structured result as `lazy-output-validator.mjs` does): a result without
//! `structuredContent` (and not an error) or with one that breaks the schema is a `McpError`, whose
//! text is Ajv's `errorsText`. A schema naming an `$id` or an outside `$ref` is compiled when listed,
//! in listing order: one that cannot be compiled fails the listing, and the resources it declares are
//! registered for the later ones (the first one of an `$id` wins). Validation is `jsonschema`'s
//! draft-07 with Ajv's own `format` and `uniqueItems` ([`crate::ajv_formats`]).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use jsonschema::ValidationError;
use jsonschema::error::TypeKind;
use jsonschema::error::ValidationErrorKind;
use jsonschema::paths::LocationSegment;
use serde_json::Value;

use crate::rpc::RpcError;

/// The bound on the backtracking steps of one `pattern` match (fancy-regex's own default is 1,000,000). V8 has none: a
/// repetition holding a lookaround on 24 characters that fail takes Node about a second, and each more character doubles
/// it. This is far past what Node answers in minutes (about 32 such characters; some 2 minutes of the engine's steps in a
/// release build), and a match that runs out of it has no verdict: the call fails as a validator that threw
/// (`fixtures/mcp-output-schema/MANIFEST.json`).
const BACKTRACK_LIMIT: usize = 10_000_000_000;

/// The `$id` schemas registered so far, which a schema's references resolve against.
struct Registered(Arc<HashMap<String, Value>>);

impl jsonschema::Retrieve for Registered {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let address = uri.as_str();
        let address = address.split_once('#').map_or(address, |(base, _)| base);
        let resource = self
            .0
            .get(address)
            .ok_or_else(|| format!("can't resolve reference {address}"))?;
        Ok(for_engine(resource)?)
    }
}

/// `schema` with every `pattern` and `patternProperties` key rewritten for jsonschema's engine
/// ([`crate::ecma_pattern`]), or V8's text for the first one JavaScript does not compile.
fn for_engine(schema: &Value) -> Result<Value, String> {
    let Value::Object(map) = schema else {
        return Ok(schema.clone());
    };
    let mut out = serde_json::Map::with_capacity(map.len());
    for (key, value) in map {
        let value = match (key.as_str(), value) {
            ("pattern", Value::String(pattern)) => {
                Value::String(crate::ecma_pattern::for_engine(pattern)?)
            }
            ("patternProperties", Value::Object(props)) => {
                let mut rewritten = serde_json::Map::with_capacity(props.len());
                for (pattern, subschema) in props {
                    rewritten.insert(
                        crate::ecma_pattern::for_engine(pattern)?,
                        for_engine(subschema)?,
                    );
                }
                Value::Object(rewritten)
            }
            _ => match (children(key, value), value) {
                (Some(Children::One), _) => for_engine(value)?,
                (Some(Children::Many), Value::Array(items)) => {
                    Value::Array(items.iter().map(for_engine).collect::<Result<_, _>>()?)
                }
                (Some(Children::Map), Value::Object(entries)) => Value::Object(
                    entries
                        .iter()
                        .map(|(k, v)| Ok((k.clone(), for_engine(v)?)))
                        .collect::<Result<_, String>>()?,
                ),
                _ => value.clone(),
            },
        };
        out.insert(key.clone(), value);
    }
    Ok(Value::Object(out))
}

struct Slot {
    schema: Value,
    registered: Arc<HashMap<String, Value>>,
    compiled: OnceLock<Result<jsonschema::Validator, String>>,
}

/// `schema` compiled as the SDK's Ajv compiles it, its references resolved against `registered`.
fn build(
    schema: &Value,
    registered: &Arc<HashMap<String, Value>>,
) -> Result<jsonschema::Validator, ValidationError<'static>> {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .with_pattern_options(jsonschema::PatternOptions::fancy_regex().backtrack_limit(BACKTRACK_LIMIT))
        .with_keyword("format", crate::ajv_formats::format_keyword)
        .with_keyword("uniqueItems", crate::ajv_formats::unique_items_keyword)
        .with_keyword("multipleOf", crate::ajv_formats::multiple_of_keyword)
        .with_retriever(Registered(Arc::clone(registered)))
        .build(schema)
}

impl Slot {
    /// The schema compiled once (`ajv.compile`), against what was registered when it was listed; Ajv's text when it
    /// cannot be.
    fn compile(&self) -> &Result<jsonschema::Validator, String> {
        self.compiled.get_or_init(|| {
            if crate::ajv_stack::compile_overflows(&crate::ajv_stack::Documents::new(&self.schema, &self.registered)) {
                return Err(crate::ajv_stack::STACK_OVERFLOW.to_owned());
            }
            build(&for_engine(&self.schema)?, &self.registered)
                .map_err(|error| compile_error_text(&self.schema, &error))
        })
    }
}

/// The validation walk's answers for single keywords ([`crate::ajv_stack::Keywords`]): each keyword alone, built as the
/// result's validator is (`for_engine`, Ajv's formats, `uniqueItems` and `multipleOf`), once per schema and keyword.
struct KeywordChecks<'r> {
    registered: &'r Arc<HashMap<String, Value>>,
    built: RefCell<HashMap<(usize, String), Option<jsonschema::Validator>>>,
    patterns: RefCell<HashMap<String, Option<jsonschema::Validator>>>,
}

impl KeywordChecks<'_> {
    fn alone(&self, schema: Value) -> Option<jsonschema::Validator> {
        build(&for_engine(&schema).ok()?, self.registered).ok()
    }
}

impl crate::ajv_stack::Keywords for KeywordChecks<'_> {
    fn holds(&self, schema: &Value, keyword: &str, value: &Value) -> bool {
        let mut built = self.built.borrow_mut();
        let validator = built.entry((std::ptr::from_ref(schema) as usize, keyword.to_owned())).or_insert_with(|| {
            let mut rule = schema.get(keyword)?.clone();
            // The walk applies the schemas of `dependencies` itself.
            if let (true, Value::Object(dependencies)) = (keyword == "dependencies", &mut rule) {
                dependencies.retain(|_, dependency| dependency.is_array());
            }
            self.alone(serde_json::json!({ keyword: rule }))
        });
        validator.as_ref().is_none_or(|validator| validator.is_valid(value))
    }

    fn matches(&self, pattern: &str, name: &str) -> bool {
        let mut patterns = self.patterns.borrow_mut();
        let validator = patterns.entry(pattern.to_owned()).or_insert_with(|| self.alone(serde_json::json!({ "pattern": pattern })));
        validator.as_ref().is_some_and(|validator| validator.is_valid(&Value::String(name.to_owned())))
    }
}

/// The validators of one listing, by the server's own tool name.
#[derive(Default)]
pub struct OutputValidators {
    tools: HashMap<String, Slot>,
}

/// An address without its fragment.
fn base_of(id: &str) -> &str {
    id.split_once('#').map_or(id, |(base, _)| base)
}

/// `LISTING_ORDER_SCHEMA` of `lazy-output-validator.mjs`, over the schema as `JSON.stringify` writes it: a schema
/// naming an `$id`, or a `$ref` that does not start with `#`, anywhere in its text compiles when listed.
fn compiles_when_listed(schema: &Value) -> bool {
    let text = serde_json::to_string(schema).unwrap_or_default();
    text.contains("\"$id\"")
        || text
            .match_indices("\"$ref\":\"")
            .any(|(at, m)| !text[at + m.len()..].starts_with('#'))
}

/// How a keyword's value holds subschemas.
enum Children {
    One,
    Many,
    Map,
}

/// The keywords whose value is one subschema, an array of them, or a map of them (`json-schema-traverse`, which Ajv
/// walks for `$id`s): everything else, `const`, `enum`, `default` and `examples` among it, is data.
fn children(key: &str, value: &Value) -> Option<Children> {
    match (key, value) {
        (
            "additionalItems"
            | "items"
            | "contains"
            | "additionalProperties"
            | "propertyNames"
            | "not"
            | "if"
            | "then"
            | "else",
            Value::Object(_),
        ) => Some(Children::One),
        ("items" | "allOf" | "anyOf" | "oneOf", Value::Array(_)) => Some(Children::Many),
        (
            "$defs" | "definitions" | "properties" | "patternProperties" | "dependencies",
            Value::Object(_),
        ) => Some(Children::Map),
        _ => None,
    }
}

fn subschemas(key: &str, value: &Value) -> Vec<Value> {
    match (children(key, value), value) {
        (Some(Children::One), _) => vec![value.clone()],
        (Some(Children::Many), Value::Array(items)) => items.clone(),
        (Some(Children::Map), Value::Object(map)) => map.values().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Every schema resource of `node` (one declaring `$id`), by its address resolved against `base`, as Ajv registers
/// them when it compiles a schema.
fn resources(node: &Value, base: Option<&url::Url>, found: &mut Vec<(String, Value)>) {
    let Value::Object(map) = node else { return };
    let own = match map.get("$id").and_then(Value::as_str) {
        Some(id) => match base.map_or_else(|| url::Url::parse(id), |base| base.join(id)) {
            Ok(address) => {
                found.push((base_of(address.as_str()).to_owned(), node.clone()));
                Some(address)
            }
            Err(_) => base.cloned(),
        },
        None => base.cloned(),
    };
    for (key, value) in map {
        for child in subschemas(key, value) {
            resources(&child, own.as_ref(), found);
        }
    }
}

/// Ajv's text for a schema it cannot compile, from jsonschema's: a reference nothing registered, or a keyword whose
/// value is not one Ajv's code generation accepts.
fn compile_error_text(schema: &Value, error: &ValidationError<'_>) -> String {
    // Ajv names the schema's own `$id`, or `#` when it has none.
    let own = schema
        .get("$id")
        .and_then(Value::as_str)
        .map_or("#", base_of);
    match error.kind() {
        ValidationErrorKind::Referencing(jsonschema::ReferencingError::Unretrievable {
            uri,
            ..
        }) => format!("can't resolve reference {uri} from id {own}"),
        // A local pointer to nothing (`#/definitions/missing`).
        ValidationErrorKind::Referencing(jsonschema::ReferencingError::PointerToNowhere {
            pointer,
        }) => {
            format!("can't resolve reference #{pointer} from id {own}")
        }
        // A schema that breaks the meta-schema: the error's instance is the offending keyword of `schema`.
        _ => {
            let at = error.instance_path().as_str();
            match schema.pointer(at) {
                // `String(type)`: an array reads as its items joined with commas.
                Some(value) if at.ends_with("/type") => {
                    let text = match value {
                        Value::Array(items) => items
                            .iter()
                            .map(|item| {
                                item.as_str()
                                    .map_or_else(|| item.to_string(), str::to_owned)
                            })
                            .collect::<Vec<_>>()
                            .join(","),
                        Value::String(one) => one.clone(),
                        other => other.to_string(),
                    };
                    format!("type must be JSONType or JSONType[]: {text}")
                }
                _ => error.to_string(),
            }
        }
    }
}

/// The SDK's own check of a `tools/list` answer (its zod `ListToolsResultSchema`) on what an output schema must be: an
/// object whose `type` is `"object"`. Every issue, in the answer's order, as zod's `JSON.stringify(issues, null, 2)`
/// the listing fails with.
fn listing_issues(tools: &[Value]) -> Option<String> {
    let mut issues = Vec::new();
    for (index, tool) in tools.iter().enumerate() {
        let Some(schema) = tool.get("outputSchema") else {
            continue;
        };
        let received = match schema {
            Value::Object(map) => {
                if map.get("type") != Some(&Value::String("object".to_owned())) {
                    issues.push(format!(
                        "  {{\n    \"code\": \"invalid_value\",\n    \"values\": [\n      \"object\"\n    ],\n    \"path\": [\n      \"tools\",\n      {index},\n      \"outputSchema\",\n      \"type\"\n    ],\n    \"message\": \"Invalid input: expected \\\"object\\\"\"\n  }}"
                    ));
                }
                continue;
            }
            Value::Array(_) => "array",
            Value::String(_) => "string",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::Null => "null",
        };
        issues.push(format!(
            "  {{\n    \"expected\": \"object\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"tools\",\n      {index},\n      \"outputSchema\"\n    ],\n    \"message\": \"Invalid input: expected object, received {received}\"\n  }}"
        ));
    }
    (!issues.is_empty()).then(|| format!("[\n{}\n]", issues.join(",\n")))
}

impl OutputValidators {
    /// The validators of `tools` (a `tools/list` answer), or the text the listing fails with.
    pub fn of(tools: &[Value]) -> Result<Self, String> {
        if let Some(issues) = listing_issues(tools) {
            return Err(issues);
        }
        let mut registered: HashMap<String, Value> = HashMap::new();
        let mut slots = HashMap::new();
        for tool in tools {
            let (Some(name), Some(schema)) = (
                tool.get("name").and_then(Value::as_str),
                tool.get("outputSchema"),
            ) else {
                continue;
            };
            // `ajv.getSchema($id)`: a repeated `$id` validates with the schema first registered under it.
            let own = schema.get("$id").and_then(Value::as_str).map(base_of);
            let schema = own
                .and_then(|id| registered.get(id))
                .cloned()
                .unwrap_or_else(|| schema.clone());
            let slot = Slot {
                schema,
                registered: Arc::new(registered.clone()),
                compiled: OnceLock::new(),
            };
            if compiles_when_listed(&slot.schema) {
                slot.compile().as_ref().map_err(String::clone)?;
                let mut found = Vec::new();
                resources(&slot.schema, None, &mut found);
                for (address, resource) in found {
                    registered.entry(address).or_insert(resource);
                }
            }
            slots.insert(name.to_owned(), slot);
        }
        Ok(Self { tools: slots })
    }

    /// Whether `tool` has an output schema its results are checked against.
    pub fn checks(&self, tool: &str) -> bool {
        self.tools.contains_key(tool)
    }

    /// `callTool`'s check of a result of `tool` against its output schema. A pattern may backtrack for long (up to
    /// [`BACKTRACK_LIMIT`] steps): its match reads `stop` at bounded intervals of its steps (`fancy_regex::interrupt`),
    /// and once `stop` is set the check ends with [`RpcError::Cancelled`].
    pub fn check(&self, tool: &str, result: &Value, stop: &Arc<AtomicBool>) -> Result<(), RpcError> {
        let checked = fancy_regex::interrupt::checking(Arc::clone(stop), || self.check_unstopped(tool, result, stop));
        if stop.load(Ordering::Relaxed) {
            return Err(RpcError::Cancelled);
        }
        checked
    }

    fn check_unstopped(&self, tool: &str, result: &Value, stop: &Arc<AtomicBool>) -> Result<(), RpcError> {
        let Some(slot) = self.tools.get(tool) else {
            return Ok(());
        };
        let refused = |code: i64, message: String| RpcError::Server {
            code,
            message,
            data: None,
        };
        let structured = result.get("structuredContent").filter(|v| !v.is_null());
        let is_error = result.get("isError").and_then(Value::as_bool) == Some(true);
        let Some(structured) = structured else {
            return if is_error {
                Ok(())
            } else {
                Err(refused(
                    -32600,
                    format!(
                        "Tool {tool} has an output schema but did not return structured content"
                    ),
                ))
            };
        };
        let validator = slot.compile().as_ref().map_err(|error| {
            refused(
                -32602,
                format!("Failed to validate structured content: {error}"),
            )
        })?;
        // Where Ajv's validation recurses without end, or past V8's stack, Node's call fails; the walk is bounded. Without a
        // reference nothing recurses.
        let overflows = crate::ajv_stack::references(&slot.schema)
            && std::thread::scope(|scope| {
                std::thread::Builder::new()
                    .name("mcp-ajv-walk".to_owned())
                    .stack_size(crate::ajv_stack::WALK_STACK)
                    .spawn_scoped(scope, || {
                        let keywords = KeywordChecks { registered: &slot.registered, built: RefCell::default(), patterns: RefCell::default() };
                        let docs = crate::ajv_stack::Documents::new(&slot.schema, &slot.registered);
                        fancy_regex::interrupt::checking(Arc::clone(stop), || {
                            crate::ajv_stack::validation_overflows(&docs, structured, &keywords)
                        })
                    })
                    .expect("a thread for the validation walk")
                    .join()
                    .expect("the validation walk ends")
            });
        if overflows {
            return Err(refused(
                -32602,
                format!("Failed to validate structured content: {}", crate::ajv_stack::STACK_OVERFLOW),
            ));
        }
        let errors: Vec<ValidationError<'_>> = validator.iter_errors(structured).collect();
        // A pattern whose backtracking ran past the engine's bound has no verdict; V8 has no such bound and answers
        // after as long as it takes. The call fails as a validator that threw does.
        if let Some(at) = errors.iter().find_map(|error| match error.kind() {
            ValidationErrorKind::BacktrackLimitExceeded { .. } => Some(error.instance_path().as_str().to_owned()),
            _ => None,
        }) {
            return Err(refused(
                -32602,
                format!(
                    "Failed to validate structured content: data{at}: its pattern needs more than {BACKTRACK_LIMIT} backtracking steps"
                ),
            ));
        }
        if errors.is_empty() {
            return Ok(());
        }
        let mut texts = Vec::new();
        let at = Scope {
            root: &slot.schema,
            registered: &slot.registered,
            instance: "",
        };
        errors_text(&at, errors.iter().collect(), &mut texts);
        Err(refused(
            -32602,
            format!(
                "Structured content does not match the tool's output schema: {}",
                texts.join(", ")
            ),
        ))
    }
}

/// Ajv's keyword order (draft-07 vocabularies): `type` first, then the keywords that apply to
/// any type, then those of numbers, strings, arrays and objects, each in vocabulary order.
fn rank(keyword: &str) -> usize {
    const ORDER: [&str; 34] = [
        "type",
        "$ref",
        "const",
        "enum",
        "not",
        "anyOf",
        "oneOf",
        "allOf",
        "if",
        "then",
        "else",
        "maximum",
        "minimum",
        "exclusiveMaximum",
        "exclusiveMinimum",
        "multipleOf",
        "maxLength",
        "minLength",
        "pattern",
        "format",
        "maxItems",
        "minItems",
        "uniqueItems",
        "additionalItems",
        "items",
        "contains",
        "maxProperties",
        "minProperties",
        "required",
        "propertyNames",
        "additionalProperties",
        "dependencies",
        "properties",
        "patternProperties",
    ];
    ORDER
        .iter()
        .position(|k| *k == keyword)
        .unwrap_or(ORDER.len())
}

/// The schema an error is read against: the root a validator was built from, the resources its references reach, and
/// the instance path the validated value sits at.
struct Scope<'s> {
    root: &'s Value,
    registered: &'s Arc<HashMap<String, Value>>,
    instance: &'s str,
}

fn segment_text(segment: LocationSegment<'_>) -> String {
    match segment {
        LocationSegment::Property(name) => name.into_owned(),
        LocationSegment::Index(index) => index.to_string(),
    }
}

/// The node `segments` lead to from `node`, while no `$ref` is crossed.
fn node_at<'a>(mut node: &'a Value, segments: &[String]) -> Option<&'a Value> {
    for segment in segments {
        node = match node {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(node)
}

/// Where Ajv reports an error among the others: the keyword ranks along its evaluation path, with a
/// property or subschema at its place in the schema.
fn order_key(schema: &Value, error: &ValidationError<'_>) -> Vec<usize> {
    let mut key = Vec::new();
    let mut node = Some(schema);
    let mut segments = error.evaluation_path().into_iter();
    while let Some(segment) = segments.next() {
        let LocationSegment::Property(keyword) = segment else {
            break;
        };
        key.push(rank(&keyword));
        // Past a reference the path names keywords of another schema: only their ranks place the error.
        let child = if keyword == "$ref" {
            None
        } else {
            node.and_then(|n| n.get(keyword.as_ref()))
        };
        node = match (keyword.as_ref(), child) {
            (
                "properties" | "patternProperties" | "dependencies" | "definitions" | "$defs",
                Some(Value::Object(map)),
            ) => {
                let Some(name) = segments.next() else { break };
                let name = match name {
                    LocationSegment::Property(name) => name.into_owned(),
                    LocationSegment::Index(index) => index.to_string(),
                };
                key.push(map.keys().position(|k| *k == name).unwrap_or(usize::MAX));
                map.get(&name)
            }
            (_, Some(Value::Array(items))) => {
                let index = match segments.next() {
                    Some(LocationSegment::Index(index)) => index,
                    Some(LocationSegment::Property(index)) => index.parse().unwrap_or(usize::MAX),
                    None => break,
                };
                key.push(index);
                items.get(index)
            }
            (_, child) => child,
        };
    }
    key
}

/// An `if` whose `then` or `else` failed: Ajv reports the branch's own errors, then this.
#[derive(PartialEq)]
struct Conditional {
    path: String,
    at: String,
    branch: String,
}

impl Conditional {
    fn text(&self) -> String {
        format!("{} must match \"{}\" schema", self.at, self.branch)
    }
}

/// The failed conditional branches along an error's evaluation path, outermost first, each with the instance path of
/// the value its `if` applies to (the error's own, less the steps the path takes into that value after it).
fn conditionals(scope: &Scope<'_>, error: &ValidationError<'_>) -> Vec<Conditional> {
    let segments: Vec<String> = error
        .evaluation_path()
        .into_iter()
        .map(segment_text)
        .collect();
    let instance: Vec<&str> = error.instance_path().as_str().split('/').skip(1).collect();
    let mut found = Vec::new();
    let mut depth = 0;
    let mut at = 0;
    while at < segments.len() {
        match segments[at].as_str() {
            "properties" | "patternProperties" => {
                depth += 1;
                at += 2;
            }
            "additionalProperties" | "additionalItems" | "contains" => {
                depth += 1;
                at += 1;
            }
            "items" => {
                depth += 1;
                at += if segments
                    .get(at + 1)
                    .is_some_and(|s| s.parse::<usize>().is_ok())
                {
                    2
                } else {
                    1
                };
            }
            "dependencies" | "definitions" | "$defs" | "allOf" | "anyOf" | "oneOf" => at += 2,
            branch @ ("then" | "else") => {
                let holder: String = instance
                    .iter()
                    .take(depth)
                    .map(|s| format!("/{s}"))
                    .collect();
                found.push(Conditional {
                    path: segments[..=at].join("/"),
                    at: format!("data{}{holder}", scope.instance),
                    branch: branch.to_owned(),
                });
                at += 1;
            }
            _ => at += 1,
        }
    }
    found
}

/// Ajv's `errorsText` entries of `errors` (`allErrors`), in Ajv's order.
fn errors_text<'e>(
    scope: &Scope<'_>,
    mut errors: Vec<&ValidationError<'e>>,
    texts: &mut Vec<String>,
) {
    errors.sort_by_cached_key(|error| order_key(scope.root, error));
    let mut open: Vec<Conditional> = Vec::new();
    for error in errors {
        let chain = conditionals(scope, error);
        let shared = open.iter().zip(&chain).take_while(|(a, b)| a == b).count();
        while open.len() > shared {
            texts.push(open.pop().expect("a branch left").text());
        }
        open.extend(chain.into_iter().skip(shared));
        let at = format!("data{}{}", scope.instance, error.instance_path().as_str());
        let message = message(scope, error, &at, texts);
        texts.push(format!("{at} {message}"));
    }
    while let Some(branch) = open.pop() {
        texts.push(branch.text());
    }
}

/// The `dependencies` entry an array-form dependency error comes from: the property present and the ones it requires.
fn array_dependency(
    scope: &Scope<'_>,
    error: &ValidationError<'_>,
    missing: &str,
) -> Option<(String, Vec<String>)> {
    if error
        .schema_path()
        .into_iter()
        .last()
        .map(segment_text)
        .as_deref()
        != Some("dependencies")
    {
        return None;
    }
    let dependencies = keyword_value(scope, error)?.as_object()?;
    let present = error.instance().as_object()?;
    dependencies.iter().find_map(|(property, required)| {
        let required: Vec<String> = required
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        (present.contains_key(property) && required.iter().any(|r| r == missing))
            .then(|| (property.clone(), required))
    })
}

/// What each item failed on when none matched `contains` (Ajv keeps them when the keyword fails).
fn contains_items(scope: &Scope<'_>, error: &ValidationError<'_>, texts: &mut Vec<String>) {
    let (Some(subschema), Some(items)) = (keyword_value(scope, error), error.instance().as_array())
    else {
        return;
    };
    let Ok(validator) = for_engine(subschema)
        .map_err(drop)
        .and_then(|engine| build(&engine, scope.registered).map_err(drop))
    else {
        return;
    };
    let base = format!("{}{}", scope.instance, error.instance_path().as_str());
    for (index, item) in items.iter().enumerate() {
        let instance = format!("{base}/{index}");
        let inner = Scope {
            root: subschema,
            registered: scope.registered,
            instance: &instance,
        };
        let errors: Vec<ValidationError<'_>> = validator.iter_errors(item).collect();
        errors_text(&inner, errors.iter().collect(), texts);
    }
}

/// Ajv's message for one error at `at`; the errors Ajv reports before it go to `texts` first.
fn message(
    scope: &Scope<'_>,
    error: &ValidationError<'_>,
    at: &str,
    texts: &mut Vec<String>,
) -> String {
    let limit = |value: &Value| value.to_string();
    match error.kind() {
        ValidationErrorKind::Type { kind } => {
            // As declared (Ajv keeps the schema's order), in whichever schema the keyword is; one that cannot be
            // found is read from the error's own type.
            let types = match keyword_value(scope, error) {
                Some(Value::Array(types)) => types
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
                Some(Value::String(one)) => one.clone(),
                _ => match kind {
                    TypeKind::Single(one) => one.to_string(),
                    TypeKind::Multiple(set) => set
                        .into_iter()
                        .map(|t| t.to_string())
                        .collect::<Vec<_>>()
                        .join(","),
                },
            };
            format!("must be {types}")
        }
        ValidationErrorKind::Required { property } => {
            let missing = property.as_str().unwrap_or_default();
            match array_dependency(scope, error, missing) {
                Some((present, required)) => format!(
                    "must have {} {} when property {present} is present",
                    if required.len() == 1 {
                        "property"
                    } else {
                        "properties"
                    },
                    required.join(", ")
                ),
                None => format!("must have required property '{missing}'"),
            }
        }
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            for _ in 1..unexpected.len() {
                texts.push(format!("{at} must NOT have additional properties"));
            }
            "must NOT have additional properties".to_owned()
        }
        ValidationErrorKind::Enum { .. } => "must be equal to one of the allowed values".to_owned(),
        ValidationErrorKind::Constant { .. } => "must be equal to constant".to_owned(),
        ValidationErrorKind::Format { format } => format!("must match format \"{format}\""),
        // The schema's own pattern, not the one rewritten for the engine.
        ValidationErrorKind::Pattern { pattern } => match keyword_value(scope, error) {
            Some(Value::String(own)) => format!("must match pattern \"{own}\""),
            _ => format!("must match pattern \"{pattern}\""),
        },
        ValidationErrorKind::Maximum { limit: l } => format!("must be <= {}", limit(l)),
        ValidationErrorKind::Minimum { limit: l } => format!("must be >= {}", limit(l)),
        ValidationErrorKind::ExclusiveMaximum { limit: l } => format!("must be < {}", limit(l)),
        ValidationErrorKind::ExclusiveMinimum { limit: l } => format!("must be > {}", limit(l)),
        ValidationErrorKind::MaxLength { limit } => {
            format!("must NOT have more than {limit} characters")
        }
        ValidationErrorKind::MinLength { limit } => {
            format!("must NOT have fewer than {limit} characters")
        }
        ValidationErrorKind::MaxItems { limit } => format!("must NOT have more than {limit} items"),
        ValidationErrorKind::AdditionalItems { limit } => {
            format!("must NOT have more than {limit} items")
        }
        ValidationErrorKind::MinItems { limit } => {
            format!("must NOT have fewer than {limit} items")
        }
        ValidationErrorKind::MaxProperties { limit } => {
            format!("must NOT have more than {limit} properties")
        }
        ValidationErrorKind::MinProperties { limit } => {
            format!("must NOT have fewer than {limit} properties")
        }
        // `format`, `uniqueItems` and `multipleOf` are Ajv's own keywords here, their text already Ajv's.
        ValidationErrorKind::Custom { message, .. } => message.clone(),
        ValidationErrorKind::Not { .. } => "must NOT be valid".to_owned(),
        ValidationErrorKind::FalseSchema => "boolean schema is false".to_owned(),
        ValidationErrorKind::Contains => {
            contains_items(scope, error, texts);
            "must contain at least 1 valid item(s)".to_owned()
        }
        // The name's own failure, reported at the object, comes first.
        ValidationErrorKind::PropertyNames { error: name } => {
            let failed = message(scope, name, at, texts);
            texts.push(format!("{at} {failed}"));
            "property name must be valid".to_owned()
        }
        // Ajv reports what each branch failed on, then the branch keyword itself.
        ValidationErrorKind::AnyOf { context } | ValidationErrorKind::OneOfNotValid { context } => {
            let keyword = if matches!(error.kind(), ValidationErrorKind::AnyOf { .. }) {
                "must match a schema in anyOf"
            } else {
                "must match exactly one schema in oneOf"
            };
            for branch in context {
                errors_text(scope, branch.iter().collect(), texts);
            }
            keyword.to_owned()
        }
        ValidationErrorKind::OneOfMultipleValid { .. } => {
            "must match exactly one schema in oneOf".to_owned()
        }
        _ => error.to_string(),
    }
}

/// The value of the keyword an error names: in the resource its reference reached (by the keyword's absolute
/// location), or in the root.
fn keyword_value<'s>(scope: &Scope<'s>, error: &ValidationError<'_>) -> Option<&'s Value> {
    let segments: Vec<String> = error.schema_path().into_iter().map(segment_text).collect();
    let own = scope.root.get("$id").and_then(Value::as_str).map(base_of);
    let elsewhere = error
        .absolute_keyword_location()
        .map(|uri| base_of(uri.as_str()))
        .filter(|base| Some(*base) != own)
        .and_then(|base| scope.registered.get(base));
    node_at(elsewhere.unwrap_or(scope.root), &segments)
}
