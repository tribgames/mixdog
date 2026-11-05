//! The provider-neutral Responses request builder. A [`ResponsesProfile`] is
//! plain data describing one wire dialect (field order, system placement,
//! tool lowering, which optional fields exist); [`build_body`] reads only the
//! profile and the request, never a provider name. First-party OpenAI and the
//! gateway families that speak the same wire each supply their own profile.

use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::config::PromptCacheLifetime;
use super::config::WireContext;
use super::continuation::Continuation;
use super::continuation::ContinuationSpec;
use super::decoder::Framing;
use super::decoder::ResponsesDecoder;
use super::effort::EffortProjection;
use super::input::LowerExtras;
use super::input::LowerOptions;
use super::input::content_text;
use super::input::is_tool_search_name;
use super::input::lower_from;
use crate::providers::compat::schema::Rule;
use crate::providers::compat::schema::SchemaMemo;
use crate::providers::compat::schema::ToolExclusion;
use std::sync::Arc;

const ENCRYPTED_REASONING: &str = "reasoning.encrypted_content";

/// One top-level body key. [`ResponsesProfile::order`] lists the keys in
/// wire order; a listed key is still omitted when its value does not apply.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BodyField {
    Model,
    Instructions,
    Input,
    PreviousResponseId,
    Tools,
    ToolChoice,
    ParallelToolCalls,
    Reasoning,
    Store,
    Stream,
    StreamOptions,
    Include,
    ServiceTier,
    PromptCacheKey,
    Text,
    AccessPrograms,
    MaxOutputTokens,
    PromptCacheLifetime,
}

/// First-party order; load-bearing for the server's prompt-prefix cache.
pub const ORDER_FIRST_PARTY: &[BodyField] = &[
    BodyField::Model,
    BodyField::Instructions,
    BodyField::Input,
    BodyField::Tools,
    BodyField::ToolChoice,
    BodyField::ParallelToolCalls,
    BodyField::Reasoning,
    BodyField::Store,
    BodyField::Stream,
    BodyField::StreamOptions,
    BodyField::Include,
    BodyField::ServiceTier,
    BodyField::PromptCacheKey,
    BodyField::Text,
    BodyField::AccessPrograms,
    BodyField::MaxOutputTokens,
    BodyField::PromptCacheLifetime,
];

/// Gateway order: transcript first, per-turn knobs after.
pub const ORDER_GATEWAY: &[BodyField] = &[
    BodyField::Model,
    BodyField::Input,
    BodyField::Store,
    BodyField::Include,
    BodyField::Stream,
    BodyField::PreviousResponseId,
    BodyField::MaxOutputTokens,
    BodyField::Tools,
    BodyField::ParallelToolCalls,
    BodyField::ToolChoice,
    BodyField::Reasoning,
    BodyField::Instructions,
    BodyField::PromptCacheKey,
];

/// Streaming-native order for a socket that has `instructions` but no `stream`
/// key; `Stream` is simply absent from a profile with `stream: false`.
pub const ORDER_ROUTED: &[BodyField] = &[
    BodyField::Model,
    BodyField::Input,
    BodyField::Store,
    BodyField::Include,
    BodyField::PromptCacheKey,
    BodyField::PreviousResponseId,
    BodyField::Instructions,
    BodyField::Tools,
    BodyField::ParallelToolCalls,
    BodyField::MaxOutputTokens,
    BodyField::ToolChoice,
    BodyField::Reasoning,
    BodyField::Stream,
];

/// Where system messages travel.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SystemPlacement {
    /// Joined into `instructions`; empty falls back to `fallback`, and no
    /// fallback omits the key. With `environment_message`, system messages of
    /// the `Env` cache tier move to a leading developer message so the shared
    /// instruction prefix stays stable.
    Instructions {
        fallback: Option<String>,
        environment_message: bool,
    },
    /// Items of `input` (`LowerOptions::system_in_input` must be set).
    InputItems,
}

/// How tool definitions are declared.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolLowering {
    /// Every tool is a function tool; the loader is the `load_tool` function.
    Function,
    /// The loader is the client-executed `tool_search` tool; deferred tools
    /// are function tools marked `defer_loading`.
    NativeClient,
    /// The server hosts search: one `{"type":"tool_search"}` replaces the
    /// loader, and one is added when only deferred tools exist.
    ServerSearch,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolChoicePolicy {
    /// The caller's choice, `auto` otherwise, always present.
    AutoDefault,
    /// Present only as `none`, and only with tools.
    NoneOnly,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ParallelToolCalls {
    Always,
    WithTools,
    Omit,
}

/// The `reasoning` field. Absent when neither the request nor
/// `default_effort` names an effort.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReasoningSpec {
    /// Adds `summary: "auto"`.
    pub summary: bool,
    pub default_effort: Option<String>,
    /// Request effort rewrites, `(from, to)`, applied after lowercasing.
    pub effort_aliases: Vec<(String, String)>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ResponsesProfile {
    pub order: Vec<BodyField>,
    pub system: SystemPlacement,
    pub input: LowerOptions,
    pub tools: ToolLowering,
    pub tool_choice: ToolChoicePolicy,
    pub parallel_tool_calls: ParallelToolCalls,
    pub reasoning: Option<ReasoningSpec>,
    pub store: bool,
    /// Sends `"stream": true`.
    pub stream: bool,
    pub stream_options: Option<Value>,
    /// Asks for `reasoning.encrypted_content`.
    pub include_encrypted_reasoning: bool,
    pub service_tier: Option<String>,
    /// Sends the request's `prompt_cache_key` when it has one.
    pub prompt_cache_key: bool,
    /// `text.verbosity` default; the request's verbosity overrides. `None`
    /// omits `text`.
    pub text_verbosity: Option<String>,
    pub access_programs: Option<Value>,
    /// Sends the request's `max_output_tokens_override`.
    pub max_output_tokens: bool,
    pub cache_lifetime: PromptCacheLifetime,
    /// Prefixes the report of a tool left out for an invalid schema, e.g.
    /// `[xai] tool`.
    pub tool_label: String,
    /// The request's `parallel_tool_calls` overrides the profile's value.
    pub honor_parallel_override: bool,
    /// Keeps `instructions` on a request that continues a stored response;
    /// off, the continuation's first response already anchors them.
    pub instructions_with_previous_response: bool,
    pub continuation: ContinuationSpec,
}

impl ResponsesProfile {
    /// The decoder for this dialect's responses: replay envelopes carry the
    /// profile's owner.
    pub fn decoder(&self, framing: Framing, context: Arc<dyn WireContext>) -> ResponsesDecoder {
        ResponsesDecoder::new(framing, context, self.input.replay_owner.clone())
    }

    /// A minimal dialect: gateway order, system in `input`, function tools,
    /// stateless, streaming, encrypted reasoning requested. Set the fields a
    /// family differs in.
    pub fn gateway(replay_owner: mixdog_protocol::ProviderId) -> Self {
        Self {
            order: ORDER_GATEWAY.to_vec(),
            system: SystemPlacement::InputItems,
            input: LowerOptions {
                replay_owner,
                codex_parity: false,
                native_tool_search: false,
                custom_tools: false,
                replay_reasoning: true,
                tool_search_replay: super::input::ToolSearchReplay::Verbatim,
                phase: false,
                system_in_input: true,
            },
            tools: ToolLowering::Function,
            tool_choice: ToolChoicePolicy::NoneOnly,
            parallel_tool_calls: ParallelToolCalls::WithTools,
            reasoning: None,
            store: false,
            stream: true,
            stream_options: None,
            include_encrypted_reasoning: true,
            service_tier: None,
            prompt_cache_key: false,
            text_verbosity: None,
            access_programs: None,
            max_output_tokens: true,
            cache_lifetime: PromptCacheLifetime::None,
            tool_label: "[responses] tool".to_owned(),
            honor_parallel_override: false,
            instructions_with_previous_response: true,
            continuation: ContinuationSpec {
                state_key: "compatResponses".to_owned(),
                tag_history_owner: true,
                stateless_only: None,
                marker: None,
            },
        }
    }
}

/// What a request adds beyond the transcript.
pub struct BuildInputs<'a> {
    pub request: &'a ModelRequest,
    /// Provider-hosted tool objects, declared before the session's tools.
    pub extra_tools: &'a [Value],
    /// A resumed conversation, from [`super::continuation::resume`].
    pub continuation: Option<&'a Continuation>,
    /// Mid-conversation effort updates; its initial effort replaces the
    /// request's.
    pub effort: Option<&'a EffortProjection>,
    /// Verdict cache for tool schemas; without one every build re-validates.
    pub schemas: Option<&'a SchemaMemo>,
}

impl<'a> BuildInputs<'a> {
    pub fn new(request: &'a ModelRequest) -> Self {
        Self {
            request,
            extra_tools: &[],
            continuation: None,
            effort: None,
            schemas: None,
        }
    }
}

/// The body, and the tools left out of it for an invalid schema.
pub struct BuiltRequest {
    pub body: Map<String, Value>,
    pub excluded: Vec<ToolExclusion>,
}

fn is_env_tier(message: &Message) -> bool {
    message.role == Role::System && message.cache_tier == Some(CacheTier::Env)
}

fn joined(messages: &[&Message], separator: &str) -> String {
    messages
        .iter()
        .map(|m| content_text(&m.content))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

/// `(instructions, environment)` text for [`SystemPlacement::Instructions`].
fn instructions_and_environment(
    messages: &[Message],
    fallback: Option<&str>,
    environment_message: bool,
) -> (Option<String>, String) {
    let system: Vec<&Message> = messages.iter().filter(|m| m.role == Role::System).collect();
    let environment: Vec<&Message> = if environment_message {
        system.iter().copied().filter(|m| is_env_tier(m)).collect()
    } else {
        Vec::new()
    };
    let prefix: Vec<&Message> = if environment.is_empty() {
        system
    } else {
        system.into_iter().filter(|m| !is_env_tier(m)).collect()
    };
    let instructions = joined(&prefix, "\n\n");
    let instructions = if instructions.is_empty() {
        fallback.map(str::to_owned)
    } else {
        Some(instructions)
    };
    (instructions, joined(&environment, "\n\n---\n\n"))
}

fn environment_item(text: &str, codex_parity: bool) -> Value {
    let mut item = Map::new();
    item.insert("type".into(), json!("message"));
    item.insert("role".into(), json!("developer"));
    item.insert(
        "content".into(),
        json!([{
            "type": "input_text",
            "text": format!("<environment_context>\n{text}\n</environment_context>"),
        }]),
    );
    if codex_parity {
        item.insert(
            "internal_chat_message_metadata_passthrough".into(),
            json!({}),
        );
    }
    Value::Object(item)
}

fn function_tool(tool: &ToolDefinition, name: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("type".into(), json!("function"));
    map.insert("name".into(), json!(name));
    map.insert("description".into(), json!(tool.description));
    map.insert("parameters".into(), tool.input_schema.clone());
    map.insert("strict".into(), json!(false));
    map
}

fn deferred_function_tool(tool: &ToolDefinition) -> Value {
    let mut map = function_tool(tool, &tool.name);
    map.insert("defer_loading".into(), json!(true));
    Value::Object(map)
}

fn client_search_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "tool_search",
        "execution": "client",
        "description": tool.description,
        "parameters": tool.input_schema,
    })
}

fn declare_tools(lowering: ToolLowering, tools: &[ToolDefinition]) -> Vec<Value> {
    let is_deferred = |tool: &ToolDefinition| tool.defer_loading;
    match lowering {
        ToolLowering::Function => tools
            .iter()
            .map(|tool| {
                let name = if is_tool_search_name(&tool.name) { "load_tool" } else { &tool.name };
                Value::Object(function_tool(tool, name))
            })
            .collect(),
        ToolLowering::NativeClient => tools
            .iter()
            .map(|tool| {
                if is_tool_search_name(&tool.name) {
                    client_search_tool(tool)
                } else if is_deferred(tool) {
                    deferred_function_tool(tool)
                } else {
                    Value::Object(function_tool(tool, &tool.name))
                }
            })
            .collect(),
        ToolLowering::ServerSearch => {
            let mut out = Vec::new();
            let mut has_search = false;
            let mut has_deferred = false;
            for tool in tools {
                if is_tool_search_name(&tool.name) {
                    if !has_search {
                        has_search = true;
                        out.push(json!({"type": "tool_search"}));
                    }
                } else if is_deferred(tool) {
                    has_deferred = true;
                    out.push(deferred_function_tool(tool));
                } else {
                    out.push(Value::Object(function_tool(tool, &tool.name)));
                }
            }
            if has_deferred && !has_search {
                out.push(json!({"type": "tool_search"}));
            }
            out
        }
    }
}

fn wire_effort(spec: &ReasoningSpec, requested: Option<&str>) -> Option<String> {
    let requested = requested.unwrap_or("").trim().to_ascii_lowercase();
    let effort = if requested.is_empty() {
        spec.default_effort.clone()?
    } else {
        requested
    };
    Some(
        spec.effort_aliases
            .iter()
            .find(|(from, _)| from == &effort)
            .map_or(effort, |(_, to)| to.clone()),
    )
}

/// The request body for `profile`, keys in `profile.order`.
pub fn build_body(profile: &ResponsesProfile, inputs: &BuildInputs<'_>) -> BuiltRequest {
    let request = inputs.request;
    let options = &request.options;

    let extras = LowerExtras {
        start_index: inputs.continuation.map_or(0, |c| c.start_index),
        reasoning_by_index: inputs.continuation.map(|c| c.reasoning_by_index.clone()).unwrap_or_default(),
        effort: inputs.effort.cloned(),
    };
    let previous_response_id = inputs.continuation.and_then(|c| c.previous_response_id.clone());
    let mut input = lower_from(&request.messages, &profile.input, &extras);
    let mut instructions = None;
    if let SystemPlacement::Instructions {
        fallback,
        environment_message,
    } = &profile.system
    {
        let (text, environment) =
            instructions_and_environment(&request.messages, fallback.as_deref(), *environment_message);
        instructions = text;
        if !environment.is_empty() {
            input.insert(0, environment_item(&environment, profile.input.codex_parity));
        }
    }
    let fallback_memo = SchemaMemo::default();
    let mut excluded = Vec::new();
    let accepted = inputs.schemas.unwrap_or(&fallback_memo).accepted_wire_tools(
        &request.tools,
        Rule::OpenAi,
        &profile.tool_label,
        &mut |exclusion| excluded.push(exclusion),
    );
    let mut tools: Vec<Value> = inputs.extra_tools.to_vec();
    tools.extend(declare_tools(profile.tools, &accepted));
    let summary = profile.reasoning.as_ref().is_some_and(|spec| spec.summary);
    let reasoning = match (inputs.effort, profile.reasoning.as_ref()) {
        // A projected conversation keeps its initial effort here; changes ride
        // as input items.
        (Some(projection), _) => Some(effort_field(&projection.initial_effort, summary)),
        (None, Some(spec)) => wire_effort(spec, options.effort.as_deref()).map(|e| effort_field(&e, summary)),
        (None, None) => None,
    };
    let parallel = if profile.honor_parallel_override {
        options.parallel_tool_calls.unwrap_or(true)
    } else {
        true
    };
    let cache_key = options.prompt_cache_key.as_deref().filter(|k| !k.is_empty());

    let mut body = Map::new();
    let mut input = Some(input);
    for field in &profile.order {
        let (key, value): (&str, Option<Value>) = match field {
            BodyField::Model => ("model", Some(json!(request.model))),
            BodyField::Instructions => (
                "instructions",
                instructions
                    .take()
                    .filter(|_| previous_response_id.is_none() || profile.instructions_with_previous_response)
                    .map(Value::String),
            ),
            BodyField::PreviousResponseId => (
                "previous_response_id",
                previous_response_id.as_ref().map(|id| json!(id)),
            ),
            BodyField::Input => ("input", input.take().map(Value::Array)),
            BodyField::Tools => ("tools", (!tools.is_empty()).then(|| Value::Array(tools.clone()))),
            BodyField::ToolChoice => (
                "tool_choice",
                match profile.tool_choice {
                    ToolChoicePolicy::AutoDefault => Some(wire_tool_choice(options.tool_choice.as_deref())),
                    ToolChoicePolicy::NoneOnly => (!tools.is_empty()
                        && options.tool_choice.as_deref() == Some("none"))
                    .then(|| json!("none")),
                },
            ),
            BodyField::ParallelToolCalls => (
                "parallel_tool_calls",
                match profile.parallel_tool_calls {
                    ParallelToolCalls::Always => Some(json!(parallel)),
                    ParallelToolCalls::WithTools => (!tools.is_empty()).then(|| json!(parallel)),
                    ParallelToolCalls::Omit => None,
                },
            ),
            BodyField::Reasoning => ("reasoning", reasoning.clone()),
            BodyField::Store => ("store", Some(json!(profile.store))),
            BodyField::Stream => ("stream", profile.stream.then(|| json!(true))),
            BodyField::StreamOptions => ("stream_options", profile.stream_options.clone()),
            BodyField::Include => (
                "include",
                profile.include_encrypted_reasoning.then(|| json!([ENCRYPTED_REASONING])),
            ),
            BodyField::ServiceTier => ("service_tier", profile.service_tier.as_ref().map(|t| json!(t))),
            BodyField::PromptCacheKey => (
                "prompt_cache_key",
                cache_key.filter(|_| profile.prompt_cache_key).map(|k| json!(k)),
            ),
            BodyField::Text => (
                "text",
                profile.text_verbosity.as_ref().map(|default| {
                    let verbosity = options
                        .verbosity
                        .as_deref()
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .unwrap_or_else(|| default.clone());
                    json!({"verbosity": verbosity})
                }),
            ),
            BodyField::AccessPrograms => ("access_programs", profile.access_programs.clone()),
            BodyField::MaxOutputTokens => (
                "max_output_tokens",
                options
                    .max_output_tokens_override
                    .filter(|n| *n > 0)
                    .filter(|_| profile.max_output_tokens)
                    .map(|n| json!(n)),
            ),
            BodyField::PromptCacheLifetime => {
                match profile.cache_lifetime {
                    PromptCacheLifetime::Options30m => {
                        body.insert("prompt_cache_options".into(), json!({"ttl": "30m"}));
                    }
                    PromptCacheLifetime::Retention24h => {
                        body.insert("prompt_cache_retention".into(), json!("24h"));
                    }
                    PromptCacheLifetime::None => {}
                }
                continue;
            }
        };
        if let Some(value) = value {
            body.insert(key.to_owned(), value);
        }
    }
    BuiltRequest { body, excluded }
}

/// `auto`, `none` and `required` go as they are; any other value names the
/// tool to force.
fn wire_tool_choice(choice: Option<&str>) -> Value {
    match choice {
        None | Some("auto") => json!("auto"),
        Some(keyword @ ("none" | "required")) => json!(keyword),
        Some(name) => json!({"type": "function", "name": name}),
    }
}

fn effort_field(effort: &str, summary: bool) -> Value {
    let mut map = Map::new();
    map.insert("effort".into(), json!(effort));
    if summary {
        map.insert("summary".into(), json!("auto"));
    }
    Value::Object(map)
}
