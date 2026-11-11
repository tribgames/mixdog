//! The typed body of a proxied model call (DS §12.4): a server core asks the core on a PC to run
//! a call with that PC's accounts (`model/proxy/execute` → `modelProxy/run`). Both ends are the
//! Rust core, so a send is the provider request itself, not Node's option bag. The events of the
//! call are [`ProxyEvent`]s (`modelProxy/run/event`); a failed call answers with a
//! [`ProxyFailure`] as the error data.
//!
//! These are wire shapes: the conversions to and from the core-api types are
//! `mixdog-core::domains::ai_admin::model_proxy`.

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyRole {
    System,
    User,
    Assistant,
    Tool,
    Developer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyCacheTier {
    Tier3,
    Env,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyPhase {
    Commentary,
    FinalAnswer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyMessageSource {
    Steering,
    StreamCutRecovery,
    TailReminder,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyImage {
    Base64 { data: String, mime_type: String },
    Url { url: String },
    FileId { id: String },
}

/// A file part's bytes. The sender's attachment-store reference means nothing on the PC, so it
/// is never carried: the sender inlines the bytes (under its byte budget), and a reference that
/// stays travels as `unavailable`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProxyBinary {
    Base64 { data: String },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyDocument {
    Base64 { media_type: String, data: String },
    Text { media_type: Option<String>, data: String },
    Content { content: JsonValue },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyPart {
    Text { text: String },
    Image { source: ProxyImage },
    File { source: ProxyBinary, mime_type: String, filename: Option<String> },
    Document { source: ProxyDocument, title: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum ProxyContent {
    Text(String),
    Parts(Vec<ProxyPart>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyToolCall {
    pub id: String,
    pub name: String,
    pub arguments: JsonValue,
    pub native_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyReplay {
    pub owner: String,
    pub items: JsonValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyMessage {
    pub role: ProxyRole,
    pub content: ProxyContent,
    pub cache_tier: Option<ProxyCacheTier>,
    pub tool_calls: Vec<ProxyToolCall>,
    pub tool_call_id: Option<String>,
    pub is_error: bool,
    pub phase: Option<ProxyPhase>,
    pub thinking_blocks: Option<JsonValue>,
    pub assistant_blocks: Option<JsonValue>,
    pub native_tool_search: Option<JsonValue>,
    pub source: Option<ProxyMessageSource>,
    pub turn_reminder: Option<String>,
    pub provider_replay: Vec<ProxyReplay>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyTool {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
    pub defer_loading: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyLocation {
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyHostedTool {
    WebSearch {
        tool_type: String,
        allowed_domains: Vec<String>,
        user_location: Option<ProxyLocation>,
        max_uses: Option<u32>,
        context_size: Option<String>,
        include_sources: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyThread {
    pub id: String,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub window: u64,
    pub turn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyEffortProjection {
    pub initial_effort: String,
    /// `(message index, effort)` pairs; a JSON object would key them by text.
    pub updates: Vec<(u32, String)>,
}

/// `RequestOptions` field for field. The connection scope and the model's output ceiling are the
/// PC's to derive, so they are not carried.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyOptions {
    pub session_id: Option<String>,
    pub effort: Option<String>,
    pub max_output_tokens_override: Option<u32>,
    pub fast: bool,
    pub tool_choice: Option<String>,
    pub verbosity: Option<String>,
    pub request_kind: Option<String>,
    pub iteration: u32,
    pub prompt_cache_key: Option<String>,
    pub prompt_cache_scope: Option<String>,
    pub xai_responses_cache_scope: Option<String>,
    pub model_parameters: Option<JsonValue>,
    pub thread: Option<ProxyThread>,
    pub parent_session_id: Option<String>,
    pub parallel_tool_calls: Option<bool>,
    pub temperature: Option<f64>,
    pub effort_projection: Option<ProxyEffortProjection>,
    pub hosted_tools: Vec<ProxyHostedTool>,
    pub shared_cache_prefix_count: Option<u32>,
    pub provider_state: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub model: String,
    pub messages: Vec<ProxyMessage>,
    pub tools: Vec<ProxyTool>,
    pub options: ProxyOptions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteContext {
    /// An agent/tool session, or a send carrying tools.
    pub agent: bool,
    /// A session that predates the wire table (`model-proxy-provider.mjs:193`).
    #[serde(default)]
    pub legacy: bool,
}

/// What the remote runtime asks of the PC's providers (`ModelProxyProvider`,
/// `quota-reading.mjs:93`, `loadModelProxyProviderConfig`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "method", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyCall {
    Send { provider: String, request: Box<ProxyRequest> },
    /// `listModels`; `refresh` re-reads the provider first (`_refreshModelCache`).
    ListModels { provider: String, refresh: bool },
    QuotaUsable { provider: String, model: String },
    ResolveWireRoute { provider: String, model: String, context: ProxyRouteContext },
    ProviderConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyBudget {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub transport_ms: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub semantic_ms: u64,
}

/// One value of a picker parameter (``ParameterValue``).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyParameterValue {
    pub value: String,
    pub label: String,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub context_window: Option<u64>,
}

/// A selectable non-effort, non-fast model parameter (``ParameterOption``).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyParameterOption {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub options: Vec<ProxyParameterValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// A declared effort ladder (``ReasoningOption``).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyReasoningOption {
    #[serde(rename = "type")]
    #[cfg_attr(feature = "codegen", ts(rename = "type"))]
    pub kind: String,
    pub values: Vec<String>,
}

/// A custom provider's reasoning wire contract (``CustomReasoning``).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyCustomReasoning {
    pub wire_format: String,
    pub wire_values: BTreeMap<String, String>,
    pub replay: bool,
}

/// What the model picker shows beyond limits and capabilities (``PickerFields``).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyPicker {
    pub release_date: Option<String>,
    pub access_programs: Option<Vec<String>>,
    pub model_parameter_options: Vec<ProxyParameterOption>,
    pub parameter_variants: Vec<BTreeMap<String, String>>,
    pub fast_efforts: Vec<String>,
    pub service_tiers: Vec<ProxyServiceTier>,
    pub additional_speed_tiers: Vec<String>,
    pub reasoning_options: Vec<ProxyReasoningOption>,
    pub custom_reasoning: Option<ProxyCustomReasoning>,
    pub tier: Option<String>,
    pub latest: bool,
    pub description: Option<String>,
    pub default_service_tier: Option<String>,
    pub default_model_parameters: BTreeMap<String, String>,
    pub default_fast: bool,
    pub supports_max_mode: bool,
}
/// The ids a picker model is sent under, in Node's `wire` shape: a bare id
/// string, or an object of effort level to id (the provider's order is the
/// object's key order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyWireIds {
    One(String),
    Tiers(Vec<(String, String)>),
}

impl Serialize for ProxyWireIds {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Self::One(id) => serializer.serialize_str(id),
            Self::Tiers(tiers) => {
                let mut map = serializer.serialize_map(Some(tiers.len()))?;
                for (level, id) in tiers {
                    map.serialize_entry(level, id)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ProxyWireIds {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Shape;
        impl<'de> serde::de::Visitor<'de> for Shape {
            type Value = ProxyWireIds;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a wire id string or an object of effort level to wire id")
            }
            fn visit_str<E: serde::de::Error>(self, id: &str) -> Result<Self::Value, E> {
                Ok(ProxyWireIds::One(id.to_owned()))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut tiers = Vec::new();
                while let Some(entry) = map.next_entry::<String, String>()? {
                    tiers.push(entry);
                }
                Ok(ProxyWireIds::Tiers(tiers))
            }
        }
        deserializer.deserialize_any(Shape)
    }
}

/// The schema of [`ProxyWireIds`]' wire form.
#[cfg(feature = "codegen")]
#[derive(schemars::JsonSchema)]
#[serde(untagged)]
#[allow(dead_code)]
enum ProxyWireShape {
    One(String),
    Tiers(BTreeMap<String, String>),
}
/// A model the PC's provider lists, with the first-response budget of its catalog entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyModel {
    pub id: String,
    pub display_name: Option<String>,
    /// The row's own `name`, the label when no display name is known.
    pub name: Option<String>,
    /// A custom provider's own name for itself.
    pub provider_name: Option<String>,
    /// A custom model added by hand.
    pub manual: bool,
    pub supports_reasoning_effort_updates: Option<bool>,
    pub supports_prompt_caching: Option<bool>,
    pub reasoning_content_field: Option<String>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub context_window: Option<u64>,
    /// The largest window the listing states for the model.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub max_context_window: Option<u64>,
    /// What a managed local runtime has allocated; bounds a selected window.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub runtime_context_window: Option<u64>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub max_output_tokens: Option<u64>,
    /// The row's own prices, USD per million tokens; absent when not finite.
    pub input_cost_per_m: Option<f64>,
    pub output_cost_per_m: Option<f64>,
    pub cache_read_cost_per_m: Option<f64>,
    pub cache_write_cost_per_m: Option<f64>,
    pub supports_reasoning: Option<bool>,
    pub reasoning_levels: Vec<String>,
    pub default_reasoning_level: Option<String>,
    pub supports_images: Option<bool>,
    pub hidden: bool,
    pub raw: Option<JsonValue>,
    /// The kind of model the listing states (`chat`, `embedding`, ...).
    pub mode: Option<String>,
    /// When the provider created the model (epoch seconds, as listed).
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub created: Option<i64>,
    /// The model a routing alias resolves to.
    pub alias_target: Option<String>,
    /// The wire id(s) the picker id is sent under.
    #[cfg_attr(feature = "codegen", schemars(with = "Option<ProxyWireShape>"))]
    #[cfg_attr(feature = "codegen", ts(type = "string | { [level: string]: string } | null"))]
    pub wire: Option<ProxyWireIds>,
    pub picker: ProxyPicker,
    pub first_response_budget: Option<ProxyBudget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyWire {
    Chat,
    Responses,
    Messages,
    Gemini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyRouteSource {
    Pinned,
    Override,
    Catalog,
    Endpoints,
    Family,
    Default,
    Legacy,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyWireRoute {
    pub wire: ProxyWire,
    pub source: ProxyRouteSource,
    /// `<provider>:<wire>`.
    pub profile_id: String,
}

/// The adapter traits of a PC provider its stand-in needs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ProxyTraits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_excludes_cache: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_pdf: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumes_read_windows: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub takes_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_response_budget: Option<ProxyBudget>,
}

/// What a server learns of one PC provider: usable or not, and its traits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ProxyProviderInfo {
    pub enabled: bool,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_models: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_state: Option<String>,
    pub model_proxy: ProxyTraits,
}

/// The answer to a [`ProxyCall`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "result", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyAnswer {
    /// `Send` finished; its events came ahead of it.
    Sent { attempts: u32 },
    Models { models: Vec<ProxyModel> },
    Usable { usable: bool },
    /// `None` for a single-wire adapter or a model no offered wire serves.
    Route { route: Option<ProxyWireRoute> },
    ProviderConfig {
        /// In the order the PC advertised them: a JSON object on the wire, whose key order Node keeps
        /// (the setup lists custom providers in it).
        #[serde(with = "ordered_providers")]
        #[cfg_attr(feature = "codegen", schemars(with = "BTreeMap<String, ProxyProviderInfo>"))]
        #[cfg_attr(feature = "codegen", ts(as = "BTreeMap<String, ProxyProviderInfo>"))]
        providers: Vec<(String, ProxyProviderInfo)>,
        /// Whether the PC's registry is loaded. An older PC omits it, and the server then reads the
        /// answer as loaded only when it names an enabled provider.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional))]
        ready: Option<bool>,
    },
    /// `modelProxy/run` reports a failed call as its result: the error vocabulary of the server has
    /// no place for a [`ProxyFailure`]. The connection relays it to the server as the JSON-RPC error
    /// of `model/proxy/execute` whose data is the failure.
    Failed { failure: ProxyFailure },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyUsage {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub input_tokens: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub output_tokens: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub cache_read_tokens: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub cache_write_tokens: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub cache_write_1h_tokens: u64,
    /// Absent when the provider reported none; an explicit 0 stays 0.
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub reasoning_tokens: Option<u64>,
    /// `reasoningTokensComplete === false` on an aggregate.
    #[serde(default)]
    pub reasoning_incomplete: bool,
    pub raw: Option<JsonValue>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub cost_ticks: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProxyStop {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    ContentFilter,
    Refusal,
    ContinueTurn,
    Other { value: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyItemKind {
    Text,
    Reasoning,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyProgress {
    Semantic,
    Reasoning,
    Text,
    Tool,
}

/// One stream event of an attempt (`StreamEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyEvent {
    ItemStart { item: ProxyItemKind, phase: Option<ProxyPhase> },
    TextDelta { text: String },
    ReasoningDelta { text: String },
    ReasoningReplay { replay: ProxyReplay },
    ToolCallStart { id: String, name: String },
    ToolCallArgsDelta { id: String, delta: String },
    ToolCallDone { call: ProxyToolCall },
    Usage { usage: ProxyUsage },
    Refusal { text: String },
    Citation { value: JsonValue },
    ServerToolBlock { value: JsonValue },
    ProviderKeepalive,
    /// Semantic progress of the stream that has no delta event of its own (`StreamEvent::Progress`).
    Progress { kind: ProxyProgress },
    /// What one wire chunk reports for everything it carries; `null`: transport only (`StreamEvent::ChunkProgress`).
    ChunkProgress { kind: Option<ProxyProgress> },
    /// The assistant text the turn returns when it is not what the deltas folded to (`StreamEvent::FinalContent`).
    FinalContent { text: String },
    /// The tool calls the turn returns when they are not the ones dispatched live (`StreamEvent::ReturnedCalls`).
    ReturnedCalls { calls: Vec<ProxyToolCall> },
    /// Anthropic extended-thinking blocks, verbatim and ordered (`StreamEvent::ThinkingBlocks`).
    ThinkingBlocks { value: JsonValue },
    ProviderState { state: JsonValue },
    /// A display-only transcript notice raised while preparing the request (`StreamEvent::Notice`).
    Notice { message: String, warn: bool },
    /// The model that answered when it is not the one the request named (`StreamEvent::ServedModel`).
    ServedModel { model: String },
    /// Provider facts the committed assistant turn keeps, Anthropic's fallback record (`StreamEvent::ProviderMetadata`).
    ProviderMetadata { value: JsonValue },
    /// The id the provider gave the response, which the usage ledger books the send under (`StreamEvent::ResponseId`).
    ResponseId { id: String },
    /// The roster account that served the answer (`StreamEvent::AccountRouting`, Node `providerMetadata.accountRouting`).
    AccountRouting { provider: String, account_id: String, session_account_id: Option<String> },
    /// The account pool moves on to the next account (`StreamEvent::AccountStage`, Node `onStageChange('reconnecting')`).
    AccountSwitching { message: String },
    /// A fallback account became the selected one (`StreamEvent::AccountStage`, Node `onStageChange('account-changed')`).
    AccountChanged {
        provider: String,
        account_id: String,
        #[cfg_attr(feature = "codegen", ts(type = "number"))]
        at: i64,
    },
    /// The send went out once more on another wire after a refusal; the session's new `wireRoute`, whole
    /// (`StreamEvent::WireRerouted`, Node `wireReroute`).
    WireRerouted { route: JsonValue },
    /// `pricing_model`: the catalog model the send bills as when it differs from the one sent.
    /// `request_ms`: the request's wall time as the usage ledger measured it (Node `usageDurationMs`).
    Completed {
        stop: Option<ProxyStop>,
        pricing_model: Option<String>,
        #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
        request_ms: Option<u64>,
    },
    /// The attempt failed and a retry begins: everything its events showed is dropped.
    AttemptDiscarded,
    /// A retried attempt reported usage before it died; it is billed once, here.
    AttemptAbandoned { usage: ProxyUsage, model: Option<String> },
}

/// How the PC's broker ended a failed send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyOutcome {
    /// The retry verdict surfaced the error.
    Provider,
    /// Retries are spent.
    Exhausted,
    /// Repeated overload: send again with `model`.
    Fallback { model: String },
    /// The PC's admission refused the call; the message says why.
    Admission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyErrorKind {
    Overloaded,
    RateLimited,
    QuotaExhausted,
    Entitlement,
    Billing,
    Auth,
    Permission,
    ContextOverflow,
    RequestTooLarge,
    Policy,
    ServiceTierUnavailable,
    InvalidRequest,
    ImageRejected,
    ReplayRejected,
    ToolSchemaRejected,
    Transient,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyDelivery {
    NotSent,
    Ambiguous,
    Accepted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyQuotaScope {
    Minute,
    Day,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ProxyTransportKind {
    Http1,
    Http2,
    WebSocket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "fault", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProxyFault {
    Connect { os_code: Option<i32> },
    Dns,
    Reset,
    Closed,
    Tls,
    H2GoAway { code: u32 },
    H2RstStream { code: u32 },
    WsClose { code: Option<u16> },
    KeepaliveExpired { transport: ProxyTransportKind },
    TruncatedStream,
    Io { os_code: Option<i32> },
}

/// A failed call as the sender's retry and recovery read it (the classified `ProviderError`);
/// credential-shaped text in the message is redacted and nothing else of the PC leaves it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyFailure {
    pub outcome: ProxyOutcome,
    pub kind: ProxyErrorKind,
    pub code: Option<String>,
    pub status: Option<u16>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub retry_after_ms: Option<u64>,
    #[cfg_attr(feature = "codegen", ts(type = "number | null"))]
    pub reset_at_ms: Option<u64>,
    pub quota_scope: Option<ProxyQuotaScope>,
    pub reauth_required: bool,
    pub should_retry: Option<bool>,
    pub text_emitted: bool,
    pub tool_dispatched: bool,
    pub tool_input_cut: bool,
    pub delivery: ProxyDelivery,
    pub transport: Option<ProxyFault>,
    pub message: String,
    pub partial_usage: Option<ProxyUsage>,
    pub partial_model: Option<String>,
    pub verification_url: Option<String>,
    pub rejected_tool: Option<String>,
    pub account_blocked: bool,
    pub unsafe_to_retry: bool,
    pub quota_limit: Option<String>,
    /// The display-only notices the failed call raised before it failed (`ProviderError::notices`).
    pub notices: Vec<ProxyNotice>,
}

/// One display-only transcript notice (`StreamEvent::Notice`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProxyNotice {
    pub message: String,
    pub warn: bool,
}

/// The provider set as an ordered JSON object.
mod ordered_providers {
    use std::fmt;

    use serde::Deserializer;
    use serde::Serializer;
    use serde::de::MapAccess;
    use serde::de::Visitor;
    use serde::ser::SerializeMap;

    use super::ProxyProviderInfo;

    pub fn serialize<S: Serializer>(providers: &[(String, ProxyProviderInfo)], serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(providers.len()))?;
        for (id, info) in providers {
            map.serialize_entry(id, info)?;
        }
        map.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<(String, ProxyProviderInfo)>, D::Error> {
        struct Entries;

        impl<'de> Visitor<'de> for Entries {
            type Value = Vec<(String, ProxyProviderInfo)>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of providers")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(entries)
            }
        }

        deserializer.deserialize_map(Entries)
    }
}
