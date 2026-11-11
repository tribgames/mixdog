//! The `outputSchema` of a server's tools, enforced on their results as the MCP SDK client does
//! (`Client.cacheToolMetadata` / `callTool` with the SDK's Ajv validator, compiled on a tool's
//! first structured result as `lazy-output-validator.mjs` does): a result without
//! `structuredContent` (and not an error) or with one that breaks the schema is a `McpError`, whose
//! text is Ajv's `errorsText`. A schema naming an `$id` or an outside `$ref` is compiled when listed,
//! in listing order: one that cannot be compiled fails the listing, and the resources it declares are
//! registered for the later ones (the first one of an `$id` wins). Validation is `jsonschema`'s
//! draft-07 with Ajv's own `format` and `uniqueItems` ([`crate::ajv_formats`]).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;

use jsonschema::ValidationError;
use jsonschema::error::TypeKind;
use jsonschema::error::ValidationErrorKind;
use jsonschema::paths::LocationSegment;
use serde_json::Value;

use crate::rpc::RpcError;

/// The `$id` schemas registered so far, which a schema's references resolve against.
struct Registered(Arc<HashMap<String, Value>>);

impl jsonschema::Retrieve for Registered {
    fn retrieve(&self, uri: &jsonschema::Uri<String>) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let address = uri.as_str();
        let address = address.split_once('#').map_or(address, |(base, _)| base);
        self.0.get(address).cloned().ok_or_else(|| format!("can't resolve reference {address}").into())
    }
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
        .with_keyword("format", crate::ajv_formats::format_keyword)
        .with_keyword("uniqueItems", crate::ajv_formats::unique_items_keyword)
        .with_retriever(Registered(Arc::clone(registered)))
        .build(schema)
}

impl Slot {
    /// The schema compiled once (`ajv.compile`), against what was registered when it was listed; Ajv's text when it
    /// cannot be.
    fn compile(&self) -> &Result<jsonschema::Validator, String> {
        self.compiled.get_or_init(|| {
            build(&self.schema, &self.registered)
                .map_err(|error| compile_error_text(&self.schema, &error))
        })
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

/// The keywords whose value is one subschema, an array of them, or a map of them (`json-schema-traverse`, which Ajv
/// walks for `$id`s): everything else, `const`, `enum`, `default` and `examples` among it, is data.
fn subschemas(key: &str, value: &Value) -> Vec<Value> {
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
        ) => {
            vec![value.clone()]
        }
        ("items" | "allOf" | "anyOf" | "oneOf", Value::Array(items)) => items.clone(),
        (
            "$defs" | "definitions" | "properties" | "patternProperties" | "dependencies",
            Value::Object(map),
        ) => map.values().cloned().collect(),
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
    match error.kind() {
        ValidationErrorKind::Referencing(jsonschema::ReferencingError::Unretrievable {
            uri,
            ..
        }) => {
            let own = schema
                .get("$id")
                .and_then(Value::as_str)
                .map_or("", base_of);
            format!("can't resolve reference {uri} from id {own}#")
        }
        // A schema that breaks the meta-schema: the error's instance is the offending keyword of `schema`.
        _ => {
            let at = error.instance_path().as_str();
            match schema.pointer(at) {
                Some(value) if at.ends_with("/type") => {
                    format!(
                        "type must be JSONType or JSONType[]: {}",
                        value
                            .as_str()
                            .map_or_else(|| value.to_string(), str::to_owned)
                    )
                }
                _ => error.to_string(),
            }
        }
    }
}

impl OutputValidators {
    /// The validators of `tools` (a `tools/list` answer), or the text the listing fails with.
    pub fn of(tools: &[Value]) -> Result<Self, String> {
        let mut registered: HashMap<String, Value> = HashMap::new();
        let mut slots = HashMap::new();
        for tool in tools {
            let (Some(name), Some(schema)) = (tool.get("name").and_then(Value::as_str), tool.get("outputSchema")) else {
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

    /// `callTool`'s check of a result of `tool` against its output schema.
    pub fn check(&self, tool: &str, result: &Value) -> Result<(), RpcError> {
        let Some(slot) = self.tools.get(tool) else { return Ok(()) };
        let refused = |code: i64, message: String| RpcError::Server { code, message, data: None };
        let structured = result.get("structuredContent").filter(|v| !v.is_null());
        let is_error = result.get("isError").and_then(Value::as_bool) == Some(true);
        let Some(structured) = structured else {
            return if is_error {
                Ok(())
            } else {
                Err(refused(-32600, format!("Tool {tool} has an output schema but did not return structured content")))
            };
        };
        let validator = slot.compile().as_ref().map_err(|error| {
            refused(
                -32602,
                format!("Failed to validate structured content: {error}"),
            )
        })?;
        let errors: Vec<ValidationError<'_>> = validator.iter_errors(structured).collect();
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
        "type", "$ref", "const", "enum", "not", "anyOf", "oneOf", "allOf", "if", "then", "else", "maximum", "minimum",
        "exclusiveMaximum", "exclusiveMinimum", "multipleOf", "maxLength", "minLength", "pattern", "format", "maxItems",
        "minItems", "uniqueItems", "additionalItems", "items", "contains", "maxProperties", "minProperties", "required",
        "propertyNames", "additionalProperties", "dependencies", "properties", "patternProperties",
    ];
    ORDER.iter().position(|k| *k == keyword).unwrap_or(ORDER.len())
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
        let LocationSegment::Property(keyword) = segment else { break };
        key.push(rank(&keyword));
        // Past a reference the path names keywords of another schema: only their ranks place the error.
        let child = if keyword == "$ref" {
            None
        } else {
            node.and_then(|n| n.get(keyword.as_ref()))
        };
        node = match (keyword.as_ref(), child) {
            ("properties" | "patternProperties" | "dependencies" | "definitions" | "$defs", Some(Value::Object(map))) => {
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
    let Ok(validator) = build(subschema, scope.registered) else {
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
        ValidationErrorKind::Pattern { pattern } => format!("must match pattern \"{pattern}\""),
        ValidationErrorKind::Maximum { limit: l } => format!("must be <= {}", limit(l)),
        ValidationErrorKind::Minimum { limit: l } => format!("must be >= {}", limit(l)),
        ValidationErrorKind::ExclusiveMaximum { limit: l } => format!("must be < {}", limit(l)),
        ValidationErrorKind::ExclusiveMinimum { limit: l } => format!("must be > {}", limit(l)),
        ValidationErrorKind::MultipleOf { multiple_of } => {
            format!("must be multiple of {multiple_of}")
        }
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
        // `format` and `uniqueItems` are Ajv's own keywords here, their text already Ajv's.
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
