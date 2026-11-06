//! Devin (Cascade API) protobuf messages: only the fields this client reads
//! or writes. Encoders write fields in ascending field-number order with
//! implicit-presence fields omitted at their default, as the product's codec
//! does; decoders ignore every field they do not name.

use crate::providers::connect::pb::PbError;
use crate::providers::connect::pb::Reader;
use crate::providers::connect::pb::Value;
use crate::providers::connect::pb::Writer;

/// `ChatMessageSource`.
pub mod source {
    pub const USER: u64 = 1;
    pub const SYSTEM: u64 = 2;
    pub const TOOL: u64 = 4;
}

/// `StopReason` values the provider reads.
pub mod stop {
    pub const UNSPECIFIED: i32 = 0;
    pub const MAX_TOKENS: i32 = 3;
}

/// `DisplayOption` values: 3 router, 4 quick review, 6 internal default,
/// 7 unclassified, 8 normal (6–8 are newer than the published names).
pub mod display {
    pub const MODEL_ROUTER: u64 = 3;
    pub const QUICK_REVIEW: u64 = 4;
    pub const INTERNAL_DEFAULT: u64 = 6;
    pub const UNCLASSIFIED: u64 = 7;
    pub const NORMAL: u64 = 8;
    pub const ARENA: u64 = 1;
    pub const BATTLE_GROUP_ONLY: u64 = 2;
}

pub const REQUEST_TYPE_CASCADE: u64 = 5;
pub const PLANNER_MODE_DEFAULT: u64 = 1;
pub const CACHE_EPHEMERAL: u64 = 1;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metadata {
    pub ide_name: String,
    pub extension_version: String,
    pub api_key: String,
    pub locale: String,
    pub os: String,
    pub ide_version: String,
    pub extension_name: String,
    pub user_jwt: String,
    pub ide_type: String,
    pub supported_model_displays: Vec<u64>,
}

impl Metadata {
    fn write(&self, w: &mut Writer) {
        w.string_if(1, &self.ide_name);
        w.string_if(2, &self.extension_version);
        w.string_if(3, &self.api_key);
        w.string_if(4, &self.locale);
        w.string_if(5, &self.os);
        w.string_if(7, &self.ide_version);
        w.string_if(12, &self.extension_name);
        w.string_if(21, &self.user_jwt);
        w.string_if(28, &self.ide_type);
        w.packed(30, &self.supported_model_displays);
    }

    fn body(&self) -> Writer {
        let mut w = Writer::new();
        self.write(&mut w);
        w
    }
}

/// `GetUserJwtRequest` / `GetCliModelConfigsRequest`: one metadata field.
pub fn encode_metadata_request(metadata: &Metadata) -> Vec<u8> {
    let mut w = Writer::new();
    w.message(1, metadata.body());
    w.finish()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserJwt {
    pub user_jwt: String,
    pub custom_api_server_url: String,
}

pub fn decode_user_jwt(bytes: &[u8]) -> Result<UserJwt, PbError> {
    let mut out = UserJwt::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => out.user_jwt = v.text(),
            2 => out.custom_api_server_url = v.text(),
            _ => {}
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatToolCall {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
    pub invalid_json_str: String,
}

impl ChatToolCall {
    fn encode(&self) -> Writer {
        let mut w = Writer::new();
        w.string_if(1, &self.id);
        w.string_if(2, &self.name);
        w.string_if(3, &self.arguments_json);
        w
    }

    fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.id = v.text(),
                2 => out.name = v.text(),
                3 => out.arguments_json = v.text(),
                4 => out.invalid_json_str = v.text(),
                _ => {}
            }
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImageData {
    pub base64_data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatMessagePrompt {
    pub message_id: String,
    pub source: u64,
    pub prompt: String,
    pub tool_calls: Vec<ChatToolCall>,
    pub tool_call_id: String,
    pub tool_result_is_error: bool,
    pub images: Vec<ImageData>,
    pub thinking: String,
    pub signature: String,
    pub signature_type: String,
}

impl ChatMessagePrompt {
    pub fn encode(&self) -> Vec<u8> {
        self.body().finish()
    }

    fn body(&self) -> Writer {
        let mut w = Writer::new();
        w.string_if(1, &self.message_id);
        w.varint_if(2, self.source);
        w.string_if(3, &self.prompt);
        for call in &self.tool_calls {
            w.message(6, call.encode());
        }
        w.string_if(7, &self.tool_call_id);
        w.bool_if(9, self.tool_result_is_error);
        for image in &self.images {
            let mut i = Writer::new();
            i.string_if(1, &image.base64_data);
            i.string_if(2, &image.mime_type);
            w.message(10, i);
        }
        w.string_if(11, &self.thinking);
        w.string_if(12, &self.signature);
        w.string_if(18, &self.signature_type);
        w
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub json_schema_string: String,
    pub strict: bool,
}

/// `ChatToolChoice` (a oneof): the option name or a tool name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolChoice {
    Option(String),
    Tool(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Configuration {
    pub num_completions: u64,
    pub max_tokens: u64,
    pub max_newlines: u64,
    pub temperature: f64,
    pub top_k: u64,
    pub top_p: f64,
    pub stop_patterns: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatRequest {
    pub metadata: Metadata,
    pub prompt: String,
    pub chat_message_prompts: Vec<ChatMessagePrompt>,
    pub request_type: u64,
    pub configuration: Configuration,
    pub tools: Vec<ToolDefinition>,
    pub disable_parallel_tool_calls: bool,
    pub tool_choice: Option<ToolChoice>,
    pub system_prompt_cache_ephemeral: bool,
    pub cascade_id: String,
    pub planner_mode: u64,
    pub chat_model_uid: String,
    pub execution_id: String,
    pub model_assignment_jwt: Option<String>,
}

impl ChatRequest {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.message(1, self.metadata.body());
        w.string_if(2, &self.prompt);
        for p in &self.chat_message_prompts {
            w.message(3, p.body());
        }
        w.varint_if(7, self.request_type);
        w.message(8, self.configuration_body());
        for t in &self.tools {
            let mut b = Writer::new();
            b.string_if(1, &t.name);
            b.string_if(2, &t.description);
            b.string_if(3, &t.json_schema_string);
            b.bool_if(12, t.strict);
            w.message(10, b);
        }
        w.bool_if(11, self.disable_parallel_tool_calls);
        if let Some(choice) = &self.tool_choice {
            let mut b = Writer::new();
            match choice {
                ToolChoice::Option(name) => b.string(1, name),
                ToolChoice::Tool(name) => b.string(2, name),
            }
            w.message(12, b);
        }
        if self.system_prompt_cache_ephemeral {
            let mut b = Writer::new();
            b.varint_if(1, CACHE_EPHEMERAL);
            w.message(13, b);
        }
        w.string_if(16, &self.cascade_id);
        w.varint_if(20, self.planner_mode);
        w.string_if(21, &self.chat_model_uid);
        w.string_if(22, &self.execution_id);
        if let Some(jwt) = &self.model_assignment_jwt {
            w.string(26, jwt);
        }
        w.finish()
    }

    fn configuration_body(&self) -> Writer {
        let c = &self.configuration;
        let mut w = Writer::new();
        w.varint_if(1, c.num_completions);
        w.varint_if(2, c.max_tokens);
        w.varint_if(3, c.max_newlines);
        w.double_if(5, c.temperature);
        w.varint_if(7, c.top_k);
        w.double_if(8, c.top_p);
        for s in &c.stop_patterns {
            w.string(9, s);
        }
        w
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelUsageStats {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub model_uid: String,
    pub billing_model_uid: String,
    pub requested_model_uid: String,
}

impl ModelUsageStats {
    fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                2 => out.input_tokens = v.as_u64(),
                3 => out.output_tokens = v.as_u64(),
                4 => out.cache_write_tokens = v.as_u64(),
                5 => out.cache_read_tokens = v.as_u64(),
                9 => out.model_uid = v.text(),
                10 => out.billing_model_uid = v.text(),
                11 => out.requested_model_uid = v.text(),
                _ => {}
            }
        }
        Ok(out)
    }
}

/// One `GetChatMessageResponse` frame.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatResponse {
    pub message_id: String,
    pub delta_text: String,
    pub stop_reason: i32,
    pub delta_tool_calls: Vec<ChatToolCall>,
    pub usage: Option<ModelUsageStats>,
    pub delta_thinking: String,
    pub delta_signature: String,
    pub credit_cost: i32,
    pub committed_credit_cost: i32,
    pub delta_signature_type: String,
    pub committed_acu_cost: f64,
    pub actual_model_uid: String,
}

impl ChatResponse {
    pub fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.message_id = v.text(),
                3 => out.delta_text = v.text(),
                5 => out.stop_reason = v.as_i32(),
                6 => out.delta_tool_calls.push(ChatToolCall::decode(v.bytes())?),
                7 => out.usage = Some(ModelUsageStats::decode(v.bytes())?),
                9 => out.delta_thinking = v.text(),
                10 => out.delta_signature = v.text(),
                14 => out.credit_cost = v.as_i32(),
                18 => out.committed_credit_cost = v.as_i32(),
                21 => out.delta_signature_type = v.text(),
                22 => out.committed_acu_cost = v.as_f64(),
                23 => out.actual_model_uid = v.text(),
                _ => {}
            }
        }
        Ok(out)
    }
}

/// `AssignModelRequest` / `AssignModelResponse`.
pub fn encode_assign_model(
    metadata: &Metadata,
    router_uid: &str,
    cascade_id: &str,
    prompt: Option<&ChatMessagePrompt>,
) -> Vec<u8> {
    let mut w = Writer::new();
    w.message(1, metadata.body());
    w.string_if(2, router_uid);
    w.string_if(3, cascade_id);
    if let Some(p) = prompt {
        w.message(5, p.body());
    }
    w.finish()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelAssignment {
    pub assignment_jwt: String,
    pub model_uid: String,
}

pub fn decode_assign_model(bytes: &[u8]) -> Result<ModelAssignment, PbError> {
    let mut out = ModelAssignment::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        if n == 1 {
            let mut inner = Reader::new(v.bytes());
            while let Some((m, w)) = inner.next_field()? {
                match m {
                    1 => out.assignment_jwt = w.text(),
                    2 => out.model_uid = w.text(),
                    _ => {}
                }
            }
        }
    }
    Ok(out)
}

/// The subset of `ClientModelConfig` the catalog reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClientModelConfig {
    pub label: String,
    pub disabled: bool,
    pub supports_images: bool,
    pub is_recommended: bool,
    pub max_tokens: i32,
    pub model_uid: String,
    pub description: String,
    pub display_option: u64,
    pub info_max_tokens: i32,
    pub info_max_output_tokens: i32,
    pub info_model_uid: String,
    pub harness_uids: Vec<String>,
    pub is_model_router: bool,
    /// The server sent a feature set, even an all-false one: the flags below
    /// are then the model's, and the config's own `supports_images` is not.
    pub has_features: bool,
    pub supports_tool_calls: bool,
    pub supports_thinking: bool,
    pub supports_parallel_tool_calls: bool,
    pub info_supports_images: bool,
    pub is_default_model_in_family: bool,
    /// The server's own grouping of this uid with its effort siblings.
    pub family: Option<ModelFamily>,
    pub dimensions: Vec<ModelDimension>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelFamily {
    pub label: String,
    pub entries: Vec<FamilyEntry>,
    pub is_default_model_in_family: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FamilyEntry {
    pub key: String,
    /// Absent when the entry states no value.
    pub value: Option<FamilyValue>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FamilyValue {
    pub order: i32,
    pub name: String,
}

/// One labelled figure of the model's card (its price per `denominator`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelDimension {
    pub label: String,
    pub value: f64,
    pub denominator: String,
    pub kind: u64,
}

impl ModelFamily {
    fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.label = v.text(),
                2 => out.entries.push(FamilyEntry::decode(v.bytes())?),
                3 => out.is_default_model_in_family = v.as_bool(),
                _ => {}
            }
        }
        Ok(out)
    }
}

impl FamilyEntry {
    fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.key = v.text(),
                2 => {
                    let mut value = FamilyValue::default();
                    let mut f = Reader::new(v.bytes());
                    while let Some((m, w)) = f.next_field()? {
                        match m {
                            1 => value.order = w.as_i32(),
                            2 => value.name = w.text(),
                            _ => {}
                        }
                    }
                    out.value = Some(value);
                }
                _ => {}
            }
        }
        Ok(out)
    }
}

impl ModelDimension {
    fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.label = v.text(),
                2 => out.value = f64::from(v.as_f32()),
                3 => out.denominator = v.text(),
                6 => out.kind = v.as_u64(),
                _ => {}
            }
        }
        Ok(out)
    }
}

impl ClientModelConfig {
    fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.label = v.text(),
                4 => out.disabled = v.as_bool(),
                5 => out.supports_images = v.as_bool(),
                11 => out.is_recommended = v.as_bool(),
                18 => out.max_tokens = v.as_i32(),
                22 => out.model_uid = v.text(),
                23 => out.decode_info(v.bytes())?,
                27 => out.description = v.text(),
                30 => out.family = Some(ModelFamily::decode(v.bytes())?),
                31 => out.is_default_model_in_family = v.as_bool(),
                32 => out.dimensions.push(ModelDimension::decode(v.bytes())?),
                _ => {}
            }
        }
        Ok(out)
    }

    fn decode_info(&mut self, bytes: &[u8]) -> Result<(), PbError> {
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                4 => self.info_max_tokens = v.as_i32(),
                6 => {
                    self.has_features = true;
                    let mut f = Reader::new(v.bytes());
                    while let Some((m, w)) = f.next_field()? {
                        match m {
                            11 => self.info_supports_images = w.as_bool(),
                            12 => self.supports_tool_calls = w.as_bool(),
                            15 => self.supports_thinking = w.as_bool(),
                            21 => self.supports_parallel_tool_calls = w.as_bool(),
                            _ => {}
                        }
                    }
                }
                13 => self.info_max_output_tokens = v.as_i32(),
                17 => self.info_model_uid = v.text(),
                20 => self.harness_uids.push(v.text()),
                22 => self.display_option = v.as_u64(),
                25 => self.is_model_router = v.as_bool(),
                _ => {}
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CliModelConfigs {
    pub configs: Vec<ClientModelConfig>,
    pub default_model_uid: String,
}

pub fn decode_cli_model_configs(bytes: &[u8]) -> Result<CliModelConfigs, PbError> {
    let mut out = CliModelConfigs::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => out.configs.push(ClientModelConfig::decode(v.bytes())?),
            3 => {
                let mut inner = Reader::new(v.bytes());
                while let Some((m, w)) = inner.next_field()? {
                    if m == 3 {
                        out.default_model_uid = w.text();
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Decodes any value of a message for tests and tooling: field number to
/// its raw value.
pub fn fields(bytes: &[u8]) -> Result<Vec<(u32, Vec<u8>, u64)>, PbError> {
    let mut r = Reader::new(bytes);
    let mut out = Vec::new();
    while let Some((n, v)) = r.next_field()? {
        out.push(match v {
            Value::Len(b) => (n, b.to_vec(), 0),
            other => (n, Vec::new(), other.as_u64()),
        });
    }
    Ok(out)
}
