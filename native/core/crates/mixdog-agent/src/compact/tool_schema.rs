//! The request-side half of the context estimate: the tool schemas travel beside the messages,
//! so they have their own fingerprint and token cost (`context-tool-schema.mjs`).
//!
//! A request's tools are a prefix of provider-native tools (raw wire objects, passed through as
//! they are) followed by schemas the wire builds from `ToolDefinition`s. The run host owns the
//! exposure mode, so it hands over the native objects and the prefix count is their number.

use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_js::token_estimate::estimate_tokens;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The tools a request carries.
#[derive(Clone, Copy, Debug, Default)]
pub struct RequestTools<'a> {
    /// The provider-native prefix (`providerNativeToolPrefixCount` of them), sent as they are.
    pub native: &'a [Value],
    pub defined: &'a [ToolDefinition],
}

impl RequestTools<'_> {
    fn is_empty(&self) -> bool {
        self.native.is_empty() && self.defined.is_empty()
    }

    fn any_deferred(&self) -> bool {
        self.native.iter().any(native_deferred) || self.defined.iter().any(|t| t.defer_loading)
    }
}

/// `isDeferredToolSchema` of a native object.
pub(crate) fn native_deferred(tool: &Value) -> bool {
    tool.get("deferLoading") == Some(&Value::Bool(true)) || tool.get("defer_loading") == Some(&Value::Bool(true))
}

/// `serializeToolSchemas`: the wire list, deferred schemas flagged (or left out).
fn serialize(tools: &RequestTools<'_>, exclude_deferred: bool) -> String {
    let native = tools.native.iter().filter(|tool| !(exclude_deferred && native_deferred(tool))).cloned();
    let defined = tools.defined.iter().filter(|tool| !(exclude_deferred && tool.defer_loading)).map(|tool| {
        let mut wire = json!({ "name": tool.name, "description": tool.description });
        // `JSON.stringify` leaves out a schema the tool does not have (`undefined`).
        if !tool.input_schema.is_null() {
            wire["input_schema"] = tool.input_schema.clone();
        }
        if tool.defer_loading {
            wire["defer_loading"] = Value::Bool(true);
        }
        wire
    });
    mixdog_js::json_stringify(&Value::Array(native.chain(defined).collect()))
}

/// `toolSchemaSignature`: sha256 of the full serialization, deferred tools included, so a
/// deferred tool joining or leaving re-fingerprints the surface.
pub fn tool_schema_signature(tools: &RequestTools<'_>) -> String {
    sha256_hex(serialize(tools, false).as_bytes())
}

/// `estimateRequestReserveTokens`: the schemas' token cost. The API leaves deferred schemas
/// out of its context count, so they are not metered.
pub fn estimate_request_reserve_tokens(tools: &RequestTools<'_>) -> u64 {
    if tools.is_empty() {
        return 0;
    }
    estimate_tokens(&serialize(tools, tools.any_deferred()))
}

/// A tool's `annotations` as far as the breakdown reads them (`toolKind`). Native wire objects
/// carry theirs inline; a `ToolDefinition` has none, so the run host supplies them by name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolAnnotations {
    pub mixdog_kind: Option<String>,
    pub agent_hidden: bool,
}

impl ToolAnnotations {
    pub(crate) fn of_native(tool: &Value) -> Self {
        let annotations = tool.get("annotations");
        Self {
            mixdog_kind: annotations.and_then(|a| a.get("mixdogKind")).and_then(Value::as_str).map(str::to_owned),
            agent_hidden: annotations.and_then(|a| a.get("agentHidden")).is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false))),
        }
    }
}

/// `toolKind`.
fn tool_kind(name: &str, annotations: &ToolAnnotations) -> &'static str {
    if name.starts_with("mcp__") {
        "mcp"
    } else if name.starts_with("skill:")
        || annotations.mixdog_kind.as_deref() == Some("skill")
        || matches!(name, "Skill" | "skills_list" | "skill_view")
        || name.starts_with("skill_")
    {
        "skill"
    } else if annotations.agent_hidden {
        "control"
    } else if matches!(name, "edit" | "apply_patch" | "shell") {
        "mutation"
    } else {
        "tool"
    }
}

/// `toolSchemaBucket`.
pub(crate) fn tool_schema_bucket(name: &str, annotations: &ToolAnnotations) -> &'static str {
    let kind = tool_kind(name, annotations);
    if kind == "mcp" {
        "mcp"
    } else if kind == "skill" {
        "skills"
    } else if name == "memory" || name == "recall" || name.contains("memory") {
        "memory"
    } else if matches!(name, "web_search" | "web_fetch") {
        "web"
    } else if matches!(name, "read" | "grep" | "find" | "glob" | "list" | "code_graph") {
        "code"
    } else if matches!(name, "shell" | "edit" | "apply_patch") {
        "mutation"
    } else if matches!(name, "agent" | "delegate") {
        "agents"
    } else if name.contains("channel") || name.contains("webhook") {
        "channels"
    } else if name.contains("provider") || matches!(name, "load_tool" | "tool_search" | "session") {
        "setup"
    } else if kind == "control" {
        "control"
    } else {
        "other"
    }
}

/// `estimateToolSchemaBreakdown`: per bucket, how many tools and what each costs to meter on its
/// own (a native object is metered as the wire carries it, a definition as the wire builds it).
/// `annotations_of` names the annotations of a defined tool.
pub fn tool_schema_breakdown(tools: &RequestTools<'_>, annotations_of: &dyn Fn(&str) -> ToolAnnotations) -> Value {
    let mut out = serde_json::Map::new();
    let mut add = |bucket: &str, tokens: u64| {
        let row = out.entry(bucket.to_owned()).or_insert_with(|| json!({ "count": 0, "tokens": 0 }));
        row["count"] = json!(row["count"].as_u64().unwrap_or(0) + 1);
        row["tokens"] = json!(row["tokens"].as_u64().unwrap_or(0) + tokens);
    };
    for tool in tools.native {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("").trim();
        let alone = RequestTools { native: std::slice::from_ref(tool), defined: &[] };
        add(tool_schema_bucket(name, &ToolAnnotations::of_native(tool)), estimate_request_reserve_tokens(&alone));
    }
    for tool in tools.defined {
        let alone = RequestTools { native: &[], defined: std::slice::from_ref(tool) };
        add(tool_schema_bucket(tool.name.trim(), &annotations_of(&tool.name)), estimate_request_reserve_tokens(&alone));
    }
    Value::Object(out)
}
