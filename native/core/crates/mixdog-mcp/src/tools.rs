//! MCP tools as [`Tool`]s: one per server tool (`mcp__<server>__<tool>`) plus the five feature
//! tools for resources and prompts. Failures are typed [`ToolError`]s; no text is classified.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use serde_json::json;

use crate::admission::AdmissionError;
use crate::hub::McpHub;
use crate::hub::normalize_scope;
use crate::outbound;
use crate::outbound::Hints;
use crate::rpc::RpcError;
use crate::server::CallError;
use crate::server::McpServer;
use crate::server::ToolEntry;

pub(crate) fn tool_error(server: &McpServer, error: CallError) -> ToolError {
    let capability = format!("mcp:{}", server.name());
    let message = server.scrub(&error.to_string());
    match error {
        CallError::NotReady { .. } => ToolError::new(
            ToolErrorCode::Unavailable { capability, reason: message.clone() },
            message,
        ),
        CallError::UnknownTool { tool, .. } => ToolError::new(ToolErrorCode::NotFound { target: tool }, message),
        CallError::Admission(AdmissionError::Cancelled) => ToolError::new(ToolErrorCode::Cancelled, "cancelled"),
        CallError::Admission(_) => ToolError::new(
            ToolErrorCode::Unavailable { capability, reason: message.clone() },
            message,
        ),
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
            server.scrub(&format!("MCP error {code}: {reason}")),
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
}

impl McpTool {
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
        Self { server, entry, spec }
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
        self.server
            .call_tool(&ctx.thread_id.to_string(), &self.entry.tool, args, &ctx.cancel, ctx.deadline)
            .await
            .map_err(|error| tool_error(&self.server, error))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Feature {
    ListResources,
    ListResourceTemplates,
    ReadResource,
    ListPrompts,
    GetPrompt,
}

impl Feature {
    const ALL: [Feature; 5] = [
        Self::ListResources,
        Self::ListResourceTemplates,
        Self::ReadResource,
        Self::ListPrompts,
        Self::GetPrompt,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::ListResources => "mixdog_list_resources",
            Self::ListResourceTemplates => "mixdog_list_resource_templates",
            Self::ReadResource => "mixdog_read_resource",
            Self::ListPrompts => "mixdog_list_prompts",
            Self::GetPrompt => "mixdog_get_prompt",
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::ListResources => "resources/list",
            Self::ListResourceTemplates => "resources/templates/list",
            Self::ReadResource => "resources/read",
            Self::ListPrompts => "prompts/list",
            Self::GetPrompt => "prompts/get",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::ListResources => "List the resources an MCP server exposes.",
            Self::ListResourceTemplates => "List the resource templates an MCP server exposes.",
            Self::ReadResource => "Read one resource of an MCP server by URI.",
            Self::ListPrompts => "List the prompts an MCP server exposes.",
            Self::GetPrompt => "Get one prompt of an MCP server, with arguments.",
        }
    }

    fn schema(self) -> JsonValue {
        let mut properties = json!({"server": {"type": "string", "description": "MCP server name"}});
        let mut required = vec!["server"];
        let map = properties.as_object_mut().expect("object literal");
        match self {
            Self::ReadResource => {
                map.insert("uri".to_owned(), json!({"type": "string"}));
                required.push("uri");
            }
            Self::GetPrompt => {
                map.insert("name".to_owned(), json!({"type": "string"}));
                map.insert("arguments".to_owned(), json!({"type": "object"}));
                required.push("name");
            }
            _ => {
                map.insert("cursor".to_owned(), json!({"type": "string"}));
            }
        }
        json!({"type": "object", "properties": properties, "required": required})
    }

    fn params(self, args: &JsonValue) -> JsonValue {
        let pick = |keys: &[&str]| {
            let mut out = serde_json::Map::new();
            for key in keys {
                if let Some(value) = args.get(*key) {
                    out.insert((*key).to_owned(), value.clone());
                }
            }
            JsonValue::Object(out)
        };
        match self {
            Self::ReadResource => pick(&["uri"]),
            Self::GetPrompt => pick(&["name", "arguments"]),
            _ => pick(&["cursor"]),
        }
    }
}

/// `mixdog_list_resources`, `mixdog_read_resource`, … over the servers of one scope of the hub (Node
/// registers them with the tools of `getMcpTools(scopeId)`, `mcp/client.mjs:261`).
pub struct McpFeatureTool {
    hub: Arc<McpHub>,
    scope: String,
    feature: Feature,
    spec: ToolSpec,
}

/// The five feature tools of `hub` for the servers of `scope` (the session's `mcpScopeId`).
pub fn feature_tools(hub: &Arc<McpHub>, scope: Option<&str>) -> Vec<Arc<dyn Tool>> {
    let scope = normalize_scope(scope);
    Feature::ALL
        .into_iter()
        .map(|feature| {
            let spec = ToolSpec {
                name: feature.name().to_owned(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: feature.description().to_owned(),
                input_schema: feature.schema(),
                annotations: ToolAnnotations { read_only_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            };
            Arc::new(McpFeatureTool { hub: Arc::clone(hub), scope: scope.clone(), feature, spec }) as Arc<dyn Tool>
        })
        .collect()
}

#[async_trait]
impl Tool for McpFeatureTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let name = args.get("server").and_then(JsonValue::as_str).unwrap_or_default();
        let Some(server) = self.hub.server_in(&self.scope, name) else {
            return Err(ToolError::new(
                ToolErrorCode::NotFound { target: name.to_owned() },
                format!("no MCP server named {name:?}"),
            ));
        };
        let value = server
            .request(self.feature.method(), self.feature.params(&args), &ctx.cancel)
            .await
            .map_err(|error| tool_error(&server, error))?;
        Ok(ToolOutput { parts: vec![ToolPart::Json(value)], ..ToolOutput::default() })
    }
}
