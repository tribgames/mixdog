//! The Responses wire of the OpenAI-compatible family (xAI, Muse Code,
//! OpenCode Go and every gateway that speaks `/responses`). The request body
//! is the neutral builder's ([`crate::providers::openai::profile::build_body`])
//! with a [`ResponsesProfile`] derived from the compat profile; the stream is
//! the neutral Responses decoder. This module only chooses profile data,
//! folds the effort onto what the model takes, and handles the three request
//! knobs the neutral builder does not carry (forced `tool_choice`, an
//! explicit `parallel_tool_calls: false`, the accepted tool list).

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::{
    ErrorResponse, ModelRequest, ProviderError, WireCodec, WireDecoder, WireRequest,
};
use mixdog_protocol::{JsonObject, JsonValue, ProviderId};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::providers::openai::config::WireContext;
use crate::providers::openai::continuation::ContinuationSpec;
use crate::providers::openai::decoder::Framing;
use crate::providers::openai::profile::{
    BodyField, BuildInputs, ORDER_ROUTED, ParallelToolCalls, ReasoningSpec, ResponsesProfile, SystemPlacement, ToolLowering,
    build_body,
};

use super::chat::{CompatConfig, system_texts};
use super::xai_cache::{LaneBook, Routing};
use super::error;
use super::models::{CompatModelInfo, fold_declared_effort};
use super::profile::{CompatProfile, EffortDialect, ResponsesShape, ToolChoiceSupport};
use super::schema::SchemaMemo;

const MUSE_SPARK_MAX_OUTPUT: u32 = 131_072;
const MUSE_FIVE_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];

/// A number as JS prints it: an integral value has no fraction.
fn js_number(value: f64) -> JsonValue {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// A cache identity as a `prompt_cache_key`: kept up to the 64-unit wire
/// limit, a bounded hash beyond it (`normalizeCacheKey`).
fn normalize_cache_key(value: &str) -> String {
    let text = mixdog_js::js_trim(value);
    if text.encode_utf16().count() <= 64 {
        return text.to_owned();
    }
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("pc_{}", &hex[..32])
}

/// Values the neutral decoder reads from its context; a compat provider has
/// no per-request identity beyond the credential the adapter adds.
struct ClockOnly;

impl WireContext for ClockOnly {
    fn request_id(&self) -> String {
        String::new()
    }
    fn now_unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
}

#[derive(Clone, Debug)]
pub struct CompatResponsesCodec {
    profile: CompatProfile,
    owner: ProviderId,
    config: CompatConfig,
    transport: TransportKind,
    schemas: Arc<SchemaMemo>,
    /// The unbounded cache lane's slots; shared by clones of this codec.
    lanes: Arc<Mutex<LaneBook>>,
}

impl CompatResponsesCodec {
    /// `transport` is `Http1` (SSE) or `WebSocket`.
    pub fn new(profile: CompatProfile, config: CompatConfig, transport: TransportKind) -> Self {
        let owner = match profile.responses {
            ResponsesShape::Xai => "xai-responses".to_owned(),
            ResponsesShape::Gateway | ResponsesShape::Muse => format!("compat-responses:{}", profile.id),
        };
        Self {
            owner: ProviderId::from(owner),
            schemas: Arc::new(SchemaMemo::default()),
            lanes: Arc::default(),
            profile,
            config,
            transport,
        }
    }

    /// The replay owner of this wire's envelopes.
    pub fn owner(&self) -> &ProviderId {
        &self.owner
    }

    fn base_url(&self) -> &str {
        self.config
            .base_url
            .as_deref()
            .unwrap_or(self.profile.base_url)
            .trim_end_matches('/')
    }

    fn is_socket(&self) -> bool {
        self.transport == TransportKind::WebSocket
    }

    /// The effort that reaches the wire, or none: xAI takes low..xhigh unless
    /// the model is known to reject it; every other gateway takes what the
    /// model's declared levels fold onto.
    fn wire_effort(&self, request: &ModelRequest, info: Option<&CompatModelInfo>) -> Option<String> {
        let requested = mixdog_js::js_trim(request.options.effort.as_deref()?).to_lowercase();
        if self.profile.responses == ResponsesShape::Xai {
            let supported = info.is_none_or(|i| i.supports_reasoning != Some(false));
            return (supported && matches!(requested.as_str(), "low" | "medium" | "high" | "xhigh"))
                .then_some(requested);
        }
        let levels: &[&str] = info.map_or(&[], |i| i.reasoning_levels.as_slice());
        fold_declared_effort(&requested, levels)
    }

    fn responses_profile(&self, request: &ModelRequest, info: Option<&CompatModelInfo>) -> ResponsesProfile {
        let mut profile = ResponsesProfile::gateway(self.owner.clone());
        if self.profile.responses == ResponsesShape::Xai {
            profile.order = ORDER_ROUTED.to_vec();
            profile.prompt_cache_key = true;
            // xAI's own slot: its history entries carry no owner tag, and the
            // socket turn records its transport. The slot is stateless
            // (`store: false`, `previousResponseId: null`), as Node writes it.
            profile.continuation = ContinuationSpec {
                state_key: "xaiResponses".to_owned(),
                tag_history_owner: false,
                stateless_only: None,
                marker: self.is_socket().then(|| ("transport".to_owned(), "websocket".to_owned())),
            };
            if self.is_socket() {
                // The socket takes the system text as `instructions` and has
                // no `stream` key.
                profile.stream = false;
                profile.system = SystemPlacement::Instructions {
                    fallback: None,
                    environment_message: false,
                };
                profile.input.system_in_input = false;
                // xAI rejects `instructions` together with `previous_response_id`.
                profile.instructions_with_previous_response = false;
            }
        }
        if self.profile.responses == ResponsesShape::Muse {
            // `reasoning` and the rest of the per-turn knobs are appended by
            // `shape_muse`, after everything the builder places.
            profile.order = vec![
                BodyField::Model,
                BodyField::Input,
                BodyField::Store,
                BodyField::Include,
                BodyField::Stream,
                BodyField::MaxOutputTokens,
                BodyField::Tools,
                BodyField::Instructions,
            ];
            profile.system = SystemPlacement::Instructions {
                fallback: None,
                environment_message: false,
            };
            profile.input.system_in_input = false;
            profile.parallel_tool_calls = ParallelToolCalls::Omit;
            profile.include_encrypted_reasoning = self.muse_includes_reasoning(request, info);
        }
        profile.tool_label = format!("[{}] tool", self.profile.id);
        // An explicit `parallel_tool_calls: false` is honoured.
        profile.honor_parallel_override = true;
        if self.config.server_tool_search {
            profile.tools = ToolLowering::ServerSearch;
        }
        if self.profile.responses != ResponsesShape::Muse
            && let Some(effort) = self.wire_effort(request, info)
        {
            let requested = mixdog_js::js_trim(request.options.effort.as_deref().unwrap_or_default()).to_lowercase();
            profile.reasoning = Some(ReasoningSpec {
                summary: false,
                default_effort: None,
                effort_aliases: vec![(requested, effort)],
            });
        }
        profile
    }

    /// The requested effort, trimmed and lowercased; empty when none.
    fn muse_requested(request: &ModelRequest) -> String {
        mixdog_js::js_trim(request.options.effort.as_deref().unwrap_or_default()).to_lowercase()
    }

    fn muse_forced_off(request: &ModelRequest) -> bool {
        matches!(Self::muse_requested(request).as_str(), "none" | "off")
    }

    /// Encrypted reasoning rides along unless reasoning is forced off or the
    /// model is declared non-reasoning.
    fn muse_includes_reasoning(&self, request: &ModelRequest, info: Option<&CompatModelInfo>) -> bool {
        !Self::muse_forced_off(request) && info.is_none_or(|i| i.supports_reasoning != Some(false))
    }

    /// Muse Code's final request shaping (`shapeResponsesParams`): output
    /// bound, then `reasoning`, sampling knobs and `prompt_cache_key`
    /// appended in that order.
    fn shape_muse(&self, request: &ModelRequest, info: Option<&CompatModelInfo>, mut body: JsonObject) -> JsonObject {
        let options = &request.options;
        let model_max = info.and_then(|i| i.output_tokens).filter(|n| *n > 0).unwrap_or(MUSE_SPARK_MAX_OUTPUT);
        if let Some(limit) = body.get("max_output_tokens").and_then(JsonValue::as_u64) {
            body.insert("max_output_tokens".into(), json!(limit.min(u64::from(model_max))));
        }

        let requested = Self::muse_requested(request);
        if Self::muse_forced_off(request) {
            body.insert("reasoning".into(), json!({"effort": "none"}));
        } else if !requested.is_empty() {
            let allowed: Vec<&str> = info
                .map(|i| i.reasoning_levels.as_slice())
                .filter(|levels| !levels.is_empty())
                .unwrap_or(MUSE_FIVE_LEVELS)
                .to_vec();
            let downgraded = if requested == "max" { "xhigh" } else { "" };
            let effort = if allowed.contains(&requested.as_str()) { requested.as_str() } else { downgraded };
            if allowed.contains(&effort) {
                body.insert("reasoning".into(), json!({"effort": effort, "summary": "auto"}));
            }
        }

        let parameter = |camel: &str, snake: &str| -> Option<JsonValue> {
            let params = options.model_parameters.as_ref()?;
            let number = params.get(camel).or_else(|| params.get(snake))?.as_f64().filter(|n| n.is_finite())?;
            Some(js_number(number))
        };
        let sampling = [
            ("temperature", options.temperature.map(|t| js_number(t.get()))),
            ("top_p", parameter("topP", "top_p")),
            ("top_k", parameter("topK", "top_k")),
            ("min_p", parameter("minP", "min_p")),
            ("presence_penalty", parameter("presencePenalty", "presence_penalty")),
            ("repetition_penalty", parameter("repetitionPenalty", "repetition_penalty")),
        ];
        for (field, value) in sampling {
            if let Some(value) = value {
                body.insert(field.into(), value);
            }
        }

        // Nullish selection: an explicit blank key suppresses caching.
        let cache = options.prompt_cache_key.as_deref().or(options.session_id.as_deref());
        if let Some(key) = cache.map(normalize_cache_key).filter(|k| !k.is_empty()) {
            body.insert("prompt_cache_key".into(), json!(key));
        }
        body
    }

    /// A forced `tool_choice`, placed where the key order says it goes.
    fn adjust(&self, request: &ModelRequest, body: JsonObject) -> JsonObject {
        if !body.contains_key("tools") || self.profile.responses == ResponsesShape::Muse {
            return body;
        }
        let forced = match request.options.tool_choice.as_deref().map(str::trim) {
            Some("required") => Some(JsonValue::from("required")),
            Some("" | "none" | "auto") | None => None,
            Some(name) => Some(json!({"type": "function", "name": name})),
        };
        let allowed = self.profile.chat.tool_choice != ToolChoiceSupport::NoneOnly;
        let Some(forced) = forced.filter(|_| allowed) else {
            return body;
        };
        // Before the first key that follows it in every order.
        let before = ["reasoning", "instructions", "stream", "prompt_cache_key"];
        let mut out = JsonObject::new();
        let mut placed = false;
        for (key, value) in body {
            if !placed && before.contains(&key.as_str()) {
                out.insert("tool_choice".into(), forced.clone());
                placed = true;
            }
            out.insert(key, value);
        }
        if !placed {
            out.insert("tool_choice".into(), forced);
        }
        out
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut headers: Vec<(String, String)> = Vec::new();
        if !self.is_socket() {
            headers.push(("content-type".into(), "application/json".into()));
            headers.push(("accept".into(), "text/event-stream".into()));
        }
        headers.extend(
            self.profile
                .headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        headers.extend(self.config.extra_headers.iter().cloned());
        headers
    }

    /// Whether this profile's effort dialect declares levels per model (a
    /// gateway whose reasoning control comes from its listing).
    pub fn declares_levels(&self) -> bool {
        matches!(
            self.profile.chat.effort,
            EffortDialect::Declared | EffortDialect::DeclaredOrBasic
        )
    }
}

impl WireCodec for CompatResponsesCodec {
    fn transport(&self) -> TransportKind {
        self.transport
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let routed;
        let request = if self.profile.responses == ResponsesShape::Xai {
            // The key xAI routes by is derived (scope, session, prefix, lane),
            // not the caller's cache key, which only names the namespace.
            let system = system_texts(&self.profile.chat, &request.messages)?;
            let routing = Routing {
                environment: self.config.environment.as_ref().map(|env| &*env.0),
                lanes: &self.lanes,
                system: &system,
            };
            let mut with_key = request.clone();
            with_key.options.prompt_cache_key = routing.key(request);
            routed = with_key;
            &routed
        } else {
            request
        };
        let info = self.config.models.get(&request.model);
        let profile = self.responses_profile(request, info.as_deref());
        let continuation = profile.resume(request)?;
        let built = build_body(
            &profile,
            &BuildInputs {
                schemas: Some(&self.schemas),
                continuation: Some(&continuation),
                ..BuildInputs::new(request)
            },
        );
        for exclusion in built.excluded {
            match &self.config.on_tool_excluded {
                Some(sink) => (sink.0)(exclusion),
                None => tracing::warn!("{}", exclusion.message),
            }
        }
        let mut body = if self.profile.responses == ResponsesShape::Muse {
            self.shape_muse(request, info.as_deref(), built.body)
        } else {
            self.adjust(request, built.body)
        };
        let url = format!("{}/responses", self.base_url());
        let (method, url) = if self.is_socket() {
            let mut frame = JsonObject::new();
            frame.insert("type".into(), "response.create".into());
            frame.extend(std::mem::take(&mut body));
            body = frame;
            ("GET", url.replacen("http", "ws", 1))
        } else {
            ("POST", url)
        };
        Ok(WireRequest {
            transport: self.transport,
            method: method.into(),
            url,
            headers: self.headers(),
            // A JSON object always serializes.
            body: serde_json::to_vec(&body).unwrap_or_default(),
        })
    }

    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        let framing = if self.is_socket() { Framing::WebSocket } else { Framing::Sse };
        let info = self.config.models.get(&request.model);
        let profile = self.responses_profile(request, info.as_deref());
        Box::new(profile.decoder_for(request, framing, Arc::new(ClockOnly)))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        error::classify(&self.profile, response)
    }
}
