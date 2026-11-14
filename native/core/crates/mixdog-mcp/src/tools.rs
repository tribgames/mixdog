//! MCP tools as [`Tool`]s: one per catalog entry of a server, its own tools (`mcp__<server>__<tool>`) and the
//! resources and prompts requests it advertises ([`Feature`]). Failures are typed [`ToolError`]s; no text is classified.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_js::value_to_string;
use mixdog_protocol::JsonValue;
use serde_json::json;

use crate::admission::AdmissionError;
use crate::outbound;
use crate::outbound::Hints;
use crate::plugin_admin::truthy;
use crate::rpc::RpcError;
use crate::server::CallError;
use crate::server::McpServer;
use crate::server::ToolEntry;
use crate::transport::append_stderr_tail;

pub(crate) fn tool_error(server: &McpServer, error: CallError) -> ToolError {
    let capability = format!("mcp:{}", server.name());
    let message = match &error {
        CallError::Rpc(RpcError::Closed(tail)) => append_stderr_tail(&error.to_string(), tail),
        _ => error.to_string(),
    };
    let message = server.scrub(&message);
    match error {
        CallError::NotReady { .. } => ToolError::new(
            ToolErrorCode::Unavailable { capability, reason: message.clone() },
            message,
        ),
        CallError::UnknownTool { tool, .. } => ToolError::new(ToolErrorCode::NotFound { target: tool }, message),
        CallError::Admission(AdmissionError::Cancelled) => ToolError::new(ToolErrorCode::Cancelled, "cancelled"),
        CallError::Admission(_) | CallError::Overloaded(_) | CallError::Recovery { outcome_unknown: false, .. } => ToolError::new(
            ToolErrorCode::Unavailable { capability, reason: message.clone() },
            message,
        ),
        // The call was handed to a connection that then failed: it may have run.
        CallError::Recovery { .. } => {
            let mut e = ToolError::new(ToolErrorCode::OutcomeUnknown, message);
            e.outcome_unknown = true;
            e
        }
        CallError::Rpc(RpcError::Cancelled) => {
            let mut e = ToolError::new(ToolErrorCode::Cancelled, "cancelled");
            e.outcome_unknown = true;
            e
        }
        CallError::Rpc(RpcError::IdleTimeout | RpcError::TotalTimeout) => {
            let mut e = ToolError::new(ToolErrorCode::DeadlineExceeded { partial: false }, message);
            e.outcome_unknown = true;
            e
        }
        CallError::Rpc(RpcError::Closed(_) | RpcError::Transport(_)) => {
            let mut e = ToolError::new(ToolErrorCode::OutcomeUnknown, message);
            e.outcome_unknown = true;
            e
        }
        CallError::Rpc(RpcError::Server { code, message: reason, data }) => ToolError::new(
            ToolErrorCode::McpError {
                server: server.name().to_owned(),
                rpc_code: Some(code),
                data: data.map(|d| scrub_json(server, d)),
            },
            // The SDK's `McpError` text, thrown, which Node's executor answers `Error: <message>` (`execute-call.mjs:69`).
            server.scrub(&format!("Error: MCP error {code}: {reason}")),
        ),
        CallError::Reported(reported) => ToolError::new(
            ToolErrorCode::McpError {
                server: server.name().to_owned(),
                rpc_code: None,
                data: reported.data.map(|d| scrub_json(server, d)),
            },
            server.scrub(&reported.text),
        ),
    }
}

/// `value` with the server's secrets removed from every string in it.
fn scrub_json(server: &McpServer, value: JsonValue) -> JsonValue {
    let scrubbed = server.scrub(&value.to_string());
    serde_json::from_str(&scrubbed).unwrap_or(JsonValue::Null)
}
pub struct McpTool {
    server: Arc<McpServer>,
    entry: Arc<ToolEntry>,
    spec: ToolSpec,
    /// The scope the tool was listed in, whose admission gate its calls take ([`McpServer::gate_in`]); none: the
    /// server's own gate.
    scope: Option<String>,
}

impl McpTool {
    /// [`McpTool::new`] listed in `scope`: its calls are admitted by that scope's gate, as Node's are by the gate of the
    /// scope's registered server (`callAdmissionFor`).
    pub fn in_scope(server: Arc<McpServer>, entry: Arc<ToolEntry>, scope: &str) -> Self {
        Self { scope: Some(scope.to_owned()), ..Self::new(server, entry) }
    }

    pub fn new(server: Arc<McpServer>, entry: Arc<ToolEntry>) -> Self {
        let spec = ToolSpec {
            name: entry.qualified.clone(),
            // An external server's tool: the catalog entry keeps no definition-level title or trigger.
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: entry.description.clone(),
            input_schema: entry.input_schema.clone(),
            annotations: entry.annotations.clone(),
            // JSON-RPC multiplexes requests; the server's own gate bounds concurrency.
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Self { server, entry, spec, scope: None }
    }
}

#[async_trait]
impl Tool for McpTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn outbound_kind(&self, args: &JsonValue) -> Option<ActionKind> {
        // The server segment as the model sees it in the qualified name.
        let server = self.entry.qualified.split("__").nth(1).unwrap_or_default();
        outbound::outbound_kind(
            self.server.config().outbound_kinds.get(&self.entry.tool).copied(),
            server,
            &self.entry.tool,
            args,
            Hints {
                read_only: self.entry.annotations.read_only_hint == Some(true),
                outbound: self.entry.outbound_hint,
            },
        )
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let owner = ctx.thread_id.to_string();
        let called = match &self.scope {
            Some(scope) => self.server.call_tool_in(scope, &owner, &self.entry.tool, args, &ctx.cancel, ctx.deadline).await,
            None => self.server.call_tool(&owner, &self.entry.tool, args, &ctx.cancel, ctx.deadline).await,
        };
        let output = called.map_err(|error| tool_error(&self.server, error))?;
        // The links of a mail the core's own Gmail connector read, for the session that read it: Browser Use may open them.
        crate::mail_reads::record(self.server.config(), &self.entry.tool, ctx.thread_id.as_str(), &output, mixdog_tools::desktop::mail_links::now_ms());
        Ok(output)
    }
}

/// A resources or prompts request a server advertises, offered as one of its tools (`mcpFeatureTools`,
/// mcp/client.mjs): `mcp__<server>__mixdog_<request>`, dispatched by its operation (`mcpOperation`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Feature {
    ListResources,
    ListResourceTemplates,
    ReadResource,
    ListPrompts,
    GetPrompt,
}

impl Feature {
    pub(crate) const ALL: [Feature; 5] = [
        Self::ListResources,
        Self::ListResourceTemplates,
        Self::ReadResource,
        Self::ListPrompts,
        Self::GetPrompt,
    ];

    /// The capability that offers it (`capabilities.resources`, `capabilities.prompts`).
    pub(crate) fn capability(self) -> &'static str {
        match self {
            Self::ListResources | Self::ListResourceTemplates | Self::ReadResource => "resources",
            Self::ListPrompts | Self::GetPrompt => "prompts",
        }
    }

    /// The tool name's leaf, after `mcp__<server>__`.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::ListResources => "mixdog_list_resources",
            Self::ListResourceTemplates => "mixdog_list_resource_templates",
            Self::ReadResource => "mixdog_read_resource",
            Self::ListPrompts => "mixdog_list_prompts",
            Self::GetPrompt => "mixdog_get_prompt",
        }
    }

    pub(crate) fn method(self) -> &'static str {
        match self {
            Self::ListResources => "resources/list",
            Self::ListResourceTemplates => "resources/templates/list",
            Self::ReadResource => "resources/read",
            Self::ListPrompts => "prompts/list",
            Self::GetPrompt => "prompts/get",
        }
    }

    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::ListResources => "List resources exposed by this MCP server.",
            Self::ListResourceTemplates => "List resource URI templates exposed by this MCP server.",
            Self::ReadResource => "Read one resource exposed by this MCP server.",
            Self::ListPrompts => "List reusable prompts exposed by this MCP server.",
            Self::GetPrompt => "Render one reusable prompt exposed by this MCP server.",
        }
    }

    pub(crate) fn schema(self) -> JsonValue {
        let (properties, required) = match self {
            Self::ListResources | Self::ListResourceTemplates | Self::ListPrompts => {
                (json!({"cursor": {"type": "string", "description": "Pagination cursor from a previous result."}}), None)
            }
            Self::ReadResource => (json!({"uri": {"type": "string", "description": "Resource URI returned by the server."}}), Some("uri")),
            Self::GetPrompt => (
                json!({
                    "name": {"type": "string", "description": "Prompt name returned by the server."},
                    "arguments": {"type": "object", "description": "Prompt argument values.", "additionalProperties": {"type": "string"}},
                }),
                Some("name"),
            ),
        };
        let mut schema = serde_json::Map::new();
        schema.insert("type".to_owned(), json!("object"));
        schema.insert("properties".to_owned(), properties);
        if let Some(required) = required {
            schema.insert("required".to_owned(), json!([required]));
        }
        schema.insert("additionalProperties".to_owned(), json!(false));
        JsonValue::Object(schema)
    }

    /// The request's params from the call's arguments (`MCP_FEATURE_REQUESTS`, `mcpCursorParams`).
    pub(crate) fn params(self, args: &JsonValue) -> JsonValue {
        let text = |key: &str| args.get(key).filter(|value| truthy(value)).map_or_else(String::new, value_to_string);
        match self {
            Self::ReadResource => json!({"uri": text("uri")}),
            Self::GetPrompt => {
                let arguments = args.get("arguments").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({}));
                json!({"name": text("name"), "arguments": arguments})
            }
            Self::ListResources | Self::ListResourceTemplates | Self::ListPrompts => {
                match args.get("cursor").and_then(JsonValue::as_str).filter(|cursor| !cursor.is_empty()) {
                    Some(cursor) => json!({"cursor": cursor}),
                    None => json!({}),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::McpIo;
    use crate::McpServerConfig;
    use crate::result::OutputPolicy;
    use crate::result::Spiller;

    /// A JSON-RPC error a server answers a call with reaches the model as Node's did: the scenario `MCP tool failures` of
    /// `fixtures/tool-failures/golden.json` (`record-tool-failures.mjs`), whose server `fx` answers `boom` with code -32603 and the
    /// message `server exploded`; Node's model was sent the text recorded there for that call.
    #[test]
    fn a_server_error_reads_as_nodes_thrown_call() {
        let golden: JsonValue = serde_json::from_str(include_str!("../../../fixtures/tool-failures/golden.json")).unwrap();
        let scenario = golden["scenarios"].as_array().unwrap().iter().position(|s| s["name"] == "MCP tool failures").unwrap();
        let calls = golden["scenarios"][scenario]["replies"][0]["calls"].as_array().unwrap();
        let boom = calls.iter().position(|call| call["name"] == "mcp__fx__boom").unwrap();
        let node = golden["results"][scenario]["toolMessages"][0][boom].as_str().unwrap();
        let io = || {
            let tokens = mixdog_rt::testing::tokens();
            McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk }
        };
        let config = McpServerConfig::from_entry("fx", &json!({ "command": "node" }), &Default::default()).unwrap();
        let server = McpServer::new(config, io(), Spiller::new(std::env::temp_dir(), io().durability), OutputPolicy::default(), None);
        let error = tool_error(&server, CallError::Rpc(RpcError::Server { code: -32603, message: "server exploded".into(), data: None }));
        assert_eq!(error.message_for_model, node);
    }
}
