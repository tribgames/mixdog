//! The `outputSchema` of a server's tools, enforced on their results as the MCP SDK client does
//! (`Client.cacheToolMetadata` / `callTool` with the SDK's Ajv validator, compiled on a tool's
//! first structured result as `lazy-output-validator.mjs` does): a result without
//! `structuredContent` (and not an error) or with one that breaks the schema is a `McpError`, whose
//! text is Ajv's `errorsText`. A schema declaring `$id` is registered in listing order (the first
//! one of an `$id` wins), and a reference to an `$id` not registered by then fails the listing.

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

/// The validators of one listing, by the server's own tool name.
#[derive(Default)]
pub struct OutputValidators {
    tools: HashMap<String, Slot>,
}

fn top_id(schema: &Value) -> Option<&str> {
    schema.get("$id").and_then(Value::as_str).map(|id| id.split_once('#').map_or(id, |(base, _)| base))
}

/// Every `$ref` of `node` that leaves the document, in document order.
fn outside_refs<'a>(node: &'a Value, found: &mut Vec<&'a str>) {
    match node {
        Value::Object(map) => {
            for (key, value) in map {
                match (key.as_str(), value) {
                    ("$ref", Value::String(target)) if !target.starts_with('#') => found.push(target),
                    _ => outside_refs(value, found),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| outside_refs(item, found)),
        _ => {}
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
            let own = top_id(schema);
            // `ajv.getSchema($id)`: a repeated `$id` validates with the schema first registered under it.
            let schema = match own.and_then(|id| registered.get(id)) {
                Some(first) => first.clone(),
                None => {
                    let mut refs = Vec::new();
                    outside_refs(schema, &mut refs);
                    for target in refs {
                        let address = target.split_once('#').map_or(target, |(base, _)| base);
                        if Some(address) != own && !registered.contains_key(address) {
                            return Err(format!("can't resolve reference {target} from id {}#", own.unwrap_or_default()));
                        }
                    }
                    if let Some(id) = own {
                        registered.insert(id.to_owned(), schema.clone());
                    }
                    schema.clone()
                }
            };
            let slot = Slot { schema, registered: Arc::new(registered.clone()), compiled: OnceLock::new() };
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
        let compiled = slot.compiled.get_or_init(|| {
            jsonschema::options()
                .with_draft(jsonschema::Draft::Draft7)
                .should_validate_formats(true)
                .with_retriever(Registered(Arc::clone(&slot.registered)))
                .build(&slot.schema)
                .map_err(|error| error.to_string())
        });
        let validator = compiled
            .as_ref()
            .map_err(|error| refused(-32602, format!("Failed to validate structured content: {error}")))?;
        let errors: Vec<ValidationError<'_>> = validator.iter_errors(structured).collect();
        if errors.is_empty() {
            return Ok(());
        }
        let mut texts = Vec::new();
        errors_text(&slot.schema, errors.iter().collect(), &mut texts);
        Err(refused(-32602, format!("Structured content does not match the tool's output schema: {}", texts.join(", "))))
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

/// Where Ajv reports an error among the others: the keyword ranks along its schema path, with a
/// property or subschema at its place in the schema.
fn order_key(schema: &Value, error: &ValidationError<'_>) -> Vec<usize> {
    let mut key = Vec::new();
    let mut node = Some(schema);
    let mut segments = error.schema_path().into_iter();
    while let Some(segment) = segments.next() {
        let LocationSegment::Property(keyword) = segment else { break };
        key.push(rank(&keyword));
        let child = node.and_then(|n| n.get(keyword.as_ref()));
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

/// Ajv's `errorsText` entries of `errors` (`allErrors`), in Ajv's order.
fn errors_text<'e>(schema: &Value, mut errors: Vec<&ValidationError<'e>>, texts: &mut Vec<String>) {
    errors.sort_by_cached_key(|error| order_key(schema, error));
    for error in errors {
        let at = format!("data{}", error.instance_path().as_str());
        let limit = |value: &Value| value.to_string();
        let message = match error.kind() {
            ValidationErrorKind::Type { kind } => {
                // As declared (Ajv keeps the schema's order); a keyword behind a `$ref` to
                // another document is not in `schema`, and there the error's own type is read.
                let types = match error_keyword_value(schema, error) {
                    Some(Value::Array(types)) => types.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","),
                    Some(Value::String(one)) => one.clone(),
                    _ => match kind {
                        TypeKind::Single(one) => one.to_string(),
                        TypeKind::Multiple(set) => set.into_iter().map(|t| t.to_string()).collect::<Vec<_>>().join(","),
                    },
                };
                format!("must be {types}")
            }
            ValidationErrorKind::Required { property } => {
                format!("must have required property '{}'", property.as_str().unwrap_or_default())
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
            ValidationErrorKind::MultipleOf { multiple_of } => format!("must be multiple of {multiple_of}"),
            ValidationErrorKind::MaxLength { limit } => format!("must NOT have more than {limit} characters"),
            ValidationErrorKind::MinLength { limit } => format!("must NOT have fewer than {limit} characters"),
            ValidationErrorKind::MaxItems { limit } => format!("must NOT have more than {limit} items"),
            ValidationErrorKind::AdditionalItems { limit } => format!("must NOT have more than {limit} items"),
            ValidationErrorKind::MinItems { limit } => format!("must NOT have fewer than {limit} items"),
            ValidationErrorKind::MaxProperties { limit } => format!("must NOT have more than {limit} properties"),
            ValidationErrorKind::MinProperties { limit } => format!("must NOT have fewer than {limit} properties"),
            ValidationErrorKind::UniqueItems => "must NOT have duplicate items".to_owned(),
            ValidationErrorKind::Not { .. } => "must NOT be valid".to_owned(),
            ValidationErrorKind::FalseSchema => "boolean schema is false".to_owned(),
            ValidationErrorKind::Contains => "must contain at least 1 valid item(s)".to_owned(),
            ValidationErrorKind::PropertyNames { .. } => "property name must be valid".to_owned(),
            // Ajv reports what each branch failed on, then the branch keyword itself.
            ValidationErrorKind::AnyOf { context } | ValidationErrorKind::OneOfNotValid { context } => {
                let keyword = if matches!(error.kind(), ValidationErrorKind::AnyOf { .. }) {
                    "must match a schema in anyOf"
                } else {
                    "must match exactly one schema in oneOf"
                };
                for branch in context {
                    errors_text(schema, branch.iter().collect(), texts);
                }
                keyword.to_owned()
            }
            ValidationErrorKind::OneOfMultipleValid { .. } => "must match exactly one schema in oneOf".to_owned(),
            _ => error.to_string(),
        };
        texts.push(format!("{at} {message}"));
    }
}

/// The value of the keyword an error names, in `schema`.
fn error_keyword_value<'a>(schema: &'a Value, error: &ValidationError<'_>) -> Option<&'a Value> {
    let mut node = schema;
    for segment in error.schema_path() {
        node = match (segment, node) {
            (LocationSegment::Property(key), Value::Object(map)) => map.get(key.as_ref())?,
            (LocationSegment::Index(index), Value::Array(items)) => items.get(index)?,
            (LocationSegment::Property(index), Value::Array(items)) => items.get(index.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(node)
}
