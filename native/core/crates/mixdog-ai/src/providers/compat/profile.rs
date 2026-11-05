//! Provider profiles of the OpenAI-compatible family as data (PW §5.7,
//! §5.14, §5.15). A profile names a provider's endpoint, headers, Chat
//! Completions dialect and retry rows; the codecs read these fields and never
//! the provider name, so a new gateway is a new row, not a new branch.

use std::sync::Arc;

use mixdog_core_api::domain::retry::RetryPolicy;

use super::models::{ModelTable, SeedModel};
use super::retry;

/// The wire a model is served on (PW §5.7 `WIRES`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Wire {
    Chat,
    Responses,
    Messages,
    Gemini,
}

/// Endpoint families with their own reasoning field on Chat Completions
/// (`openai-compat-reasoning-field.mjs SHAPES`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReasoningShape {
    /// Reasoning arrives on `reasoning` or `reasoning_content` and goes back
    /// under the key it arrived on (Together, vLLM).
    SameKey,
    /// Read from `reasoning`, never echoed (Groq).
    ReadOnly,
    /// Typed `thinking` chunks inside `content` (Mistral).
    ContentChunks,
    /// Plain text on `reasoning`; `reasoning_details` replace it (OpenRouter).
    Reasoning,
}

impl ReasoningShape {
    /// Whether the `reasoning` key is a reasoning field on receive.
    pub const fn reads_reasoning_alias(self) -> bool {
        !matches!(self, Self::ContentChunks)
    }
}

/// How the effort of a request reaches the Chat body.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EffortDialect {
    /// No reasoning control.
    None,
    /// `reasoning_effort` ∈ low|medium|high|xhigh, only where the catalog does
    /// not say the model rejects it.
    Xai,
    /// `thinking:{type}` plus `reasoning_effort` ∈ low|high|max.
    DeepSeek,
    /// The unified `reasoning` object; `provider:{sort}` routing.
    OpenRouter,
    /// `reasoning_effort` from the model's declared levels, else low|medium|high.
    DeclaredOrBasic,
    /// `reasoning_effort` from the model's declared levels only.
    Declared,
    /// `thinking:{type}` plus `reasoning_effort` ∈ minimal|low|medium|high.
    Mimo,
}

/// Which `tool_choice` / `parallel_tool_calls` values the endpoint documents.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolChoiceSupport {
    /// Only `none` (honoured by omitting nothing: `tool_choice: none`).
    NoneOnly,
    /// `required` and a named tool too.
    Forced,
    /// A forced choice is refused while thinking is enabled; sent only with
    /// thinking explicitly disabled (DeepSeek).
    ForcedWithoutThinking,
    /// The endpoint documents `auto` only: `none` drops the tools, nothing
    /// else is sent (MiMo).
    AutoOnly,
}

/// The request field that bounds output.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OutputLimit {
    /// `max_tokens`, sent only when the request carries a limit.
    MaxTokens,
    /// `max_completion_tokens`, always sent: the request's limit or
    /// `default`, at most `cap` and at most the model's own ceiling.
    MaxCompletionTokens { default: u32, cap: u32 },
}

/// The wires a gateway serves (`wire-route.mjs PROFILES`), as data for
/// [`super::wire_route::resolve_wire`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct WireOffer {
    pub offered: &'static [Wire],
    /// Chosen among the advertised wires when the default is not one of them.
    pub preference: &'static [Wire],
    /// The wire an agent/tool session uses where the gateway carries thinking
    /// and tool blocks natively (DeepSeek's Anthropic endpoint).
    pub agent_wire: Option<Wire>,
}

impl WireOffer {
    pub const CHAT_ONLY: Self = Self {
        offered: &[Wire::Chat],
        preference: &[],
        agent_wire: None,
    };
}

/// The Responses request shape of a gateway family.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResponsesShape {
    /// Transcript first, per-turn knobs after (`ORDER_GATEWAY`).
    Gateway,
    /// xAI: routed key order, `prompt_cache_key`, system in `input` over
    /// HTTP and in `instructions` over the socket.
    Xai,
    /// Muse Code: system text in `instructions`, no `parallel_tool_calls` or
    /// `tool_choice`, reasoning/sampling/cache key appended after the rest.
    Muse,
}

/// The usage field that states what a request cost.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CostField {
    None,
    /// `cost_in_usd_ticks`: 10⁻¹⁰ USD (xAI).
    UsdTicks,
    /// `cost`: decimal USD (OpenRouter).
    UsdDecimal,
}

/// A provider-specific message for a gateway error code.
pub type FriendlyCode = (&'static str, &'static str);

/// The Chat Completions dialect of one provider.
#[derive(Clone, Copy, Debug)]
pub struct ChatDialect {
    /// The `developer` role is documented; else it is sent as `system`.
    pub developer_role: bool,
    /// Prior assistant `reasoning_content` goes back on the next request.
    pub replay_reasoning: bool,
    /// A reply's reasoning is kept for replay even when the dialect does not
    /// replay it today (the receive side of the replay envelope).
    pub capture_reasoning: bool,
    pub reasoning_shape: Option<ReasoningShape>,
    pub effort: EffortDialect,
    pub tool_choice: ToolChoiceSupport,
    pub output_limit: OutputLimit,
    pub temperature: Option<f64>,
    /// `x-grok-conv-id` carries the request's prompt-cache key.
    pub conversation_header: bool,
    /// `parallel_tool_calls` is documented and sent when the request states it.
    pub parallel_tool_calls: bool,
    /// Where the usage object states what the request cost.
    pub cost: CostField,
    /// An in-band `invalid_request` error event is retryable.
    pub in_band_invalid_request_retryable: bool,
    /// Per-request `x-session-affinity` / `x-parent-session-id` headers and
    /// the client `User-Agent`.
    pub session_affinity_headers: bool,
    /// Gateway error codes with a message of their own.
    pub friendly_codes: &'static [FriendlyCode],
    /// A refusal's text leads with its status (`400 <message>`), as the
    /// OpenAI SDK words it; MiMo's own client words it bare.
    pub status_in_message: bool,
    /// The text of a 401 that needs a new sign-in.
    pub reauth: ReauthText,
}

/// How a provider words a rejected login-issued key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReauthText {
    /// The refusal's own text.
    Plain,
    /// `[id] API key rejected (401) — <sign-in hint>[: <refusal>]`.
    KeyRejected,
    /// `[id] Model API key rejected (<refusal>) — <sign-in hint>`.
    ModelKeyRejected,
    /// `[id] invalid_grant: OpenCode sign-in expired (inference 401) — <sign-in hint>`.
    SignInExpired,
}

impl ChatDialect {
    /// A plain Chat Completions endpoint: nothing provider-specific.
    pub const PLAIN: Self = Self {
        developer_role: false,
        replay_reasoning: false,
        capture_reasoning: false,
        reasoning_shape: None,
        effort: EffortDialect::None,
        tool_choice: ToolChoiceSupport::NoneOnly,
        output_limit: OutputLimit::MaxTokens,
        temperature: None,
        conversation_header: false,
        parallel_tool_calls: false,
        cost: CostField::None,
        in_band_invalid_request_retryable: false,
        session_affinity_headers: false,
        friendly_codes: &[],
        status_in_message: true,
        reauth: ReauthText::Plain,
    };
}

/// What a profile's credential is, as far as the wire cares.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CredentialKind {
    /// A key the user supplied or the login produced; never refreshed.
    /// A 401 means the user must sign in again.
    StaticKey { reauth_on_401: bool },
    /// No credential header at all.
    Keyless,
}

#[derive(Clone, Debug)]
pub struct CompatProfile {
    pub id: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
    /// The wire used when nothing about a model says otherwise.
    pub default_wire: Wire,
    /// The Responses request shape, for models served on that wire.
    pub responses: ResponsesShape,
    /// Which wires the gateway serves and how a model's wire is chosen.
    pub wires: WireOffer,
    pub headers: &'static [(&'static str, &'static str)],
    pub chat: ChatDialect,
    pub credential: CredentialKind,
    /// Model facts the provider's listing does not carry (exact ids).
    pub seed_models: &'static [SeedModel],
    retry: fn() -> RetryPolicy,
}

/// The first Grok generations reject `reasoning_effort` outright (HTTP 400);
/// the listing does not say so.
const XAI_NO_EFFORT: &[SeedModel] = &[
    no_effort("grok-3"),
    no_effort("grok-3-mini"),
    no_effort("grok-4"),
    no_effort("grok-4-0709"),
    no_effort("grok-4-fast"),
    no_effort("grok-4-fast-reasoning"),
    no_effort("grok-4-fast-non-reasoning"),
    no_effort("grok-code-fast-1"),
];

const fn no_effort(id: &'static str) -> SeedModel {
    SeedModel {
        id,
        mode: None,
        supports_reasoning: Some(false),
        reasoning_levels: &[],
        output_tokens: None,
    }
}

const MUSE_FIVE_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];
const MUSE_SIX_LEVELS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

const fn muse_seed(id: &'static str, reasoning_levels: &'static [&'static str]) -> SeedModel {
    SeedModel {
        id,
        mode: None,
        supports_reasoning: Some(true),
        reasoning_levels,
        output_tokens: Some(131_072),
    }
}

/// The seeded Muse Spark revisions; only the 1.3 revisions accept `max`.
const MUSE_SEEDS: &[SeedModel] = &[
    muse_seed("muse-spark-1.1", MUSE_FIVE_LEVELS),
    muse_seed("muse-spark-1.2", MUSE_FIVE_LEVELS),
    muse_seed("muse-spark-1.2-contributor", MUSE_FIVE_LEVELS),
    muse_seed("muse-spark-1.3", MUSE_SIX_LEVELS),
    muse_seed("muse-spark-1.3-contributor", MUSE_SIX_LEVELS),
];

/// Speech models share MiMo's listing but cannot serve a text turn.
const MIMO_AUDIO: &[SeedModel] = &[
    SeedModel {
        id: "mimo-v2.5-tts",
        mode: Some("audio"),
        supports_reasoning: None,
        reasoning_levels: &[],
        output_tokens: None,
    },
    SeedModel {
        id: "mimo-v2-asr",
        mode: Some("audio"),
        supports_reasoning: None,
        reasoning_levels: &[],
        output_tokens: None,
    },
];

impl CompatProfile {
    /// The model table of an instance, carrying this profile's seed facts.
    pub fn model_table(&self) -> Arc<ModelTable> {
        Arc::new(ModelTable::with_seed(self.seed_models))
    }

    pub fn retry_policy(&self) -> RetryPolicy {
        (self.retry)()
    }

    /// A copy of this profile for another endpoint (a configured base URL).
    pub fn with_base_url(&self, base_url: &'static str) -> Self {
        Self {
            base_url,
            ..self.clone()
        }
    }

    pub fn xai() -> Self {
        Self {
            id: "xai",
            base_url: "https://api.x.ai/v1",
            default_model: "grok-4.5",
            default_wire: Wire::Responses,
            responses: ResponsesShape::Xai,
            wires: WireOffer {
                offered: &[Wire::Responses, Wire::Chat],
                ..WireOffer::CHAT_ONLY
            },
            headers: &[],
            chat: ChatDialect {
                replay_reasoning: true,
                capture_reasoning: true,
                effort: EffortDialect::Xai,
                tool_choice: ToolChoiceSupport::Forced,
                conversation_header: true,
                parallel_tool_calls: true,
                cost: CostField::UsdTicks,
                in_band_invalid_request_retryable: true,
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: false,
            },
            seed_models: XAI_NO_EFFORT,
            retry: retry::xai,
        }
    }

    pub fn deepseek() -> Self {
        Self {
            id: "deepseek",
            base_url: "https://api.deepseek.com",
            default_model: "deepseek-v4-pro",
            default_wire: Wire::Chat,
            responses: ResponsesShape::Gateway,
            wires: WireOffer {
                offered: &[Wire::Chat, Wire::Messages],
                preference: &[],
                agent_wire: Some(Wire::Messages),
            },
            headers: &[],
            chat: ChatDialect {
                replay_reasoning: true,
                capture_reasoning: true,
                effort: EffortDialect::DeepSeek,
                tool_choice: ToolChoiceSupport::ForcedWithoutThinking,
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: false,
            },
            seed_models: &[],
            retry: retry::deepseek,
        }
    }

    pub fn openrouter() -> Self {
        Self {
            id: "openrouter",
            base_url: "https://openrouter.ai/api/v1",
            default_model: "openrouter/auto",
            default_wire: Wire::Chat,
            responses: ResponsesShape::Gateway,
            wires: WireOffer {
                offered: &[Wire::Chat, Wire::Messages, Wire::Responses],
                preference: &[],
                agent_wire: None,
            },
            headers: &[
                ("HTTP-Referer", "https://github.com/tribgames/mixdog"),
                ("X-OpenRouter-Title", "mixdog"),
            ],
            chat: ChatDialect {
                reasoning_shape: Some(ReasoningShape::Reasoning),
                effort: EffortDialect::OpenRouter,
                tool_choice: ToolChoiceSupport::Forced,
                parallel_tool_calls: true,
                cost: CostField::UsdDecimal,
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: false,
            },
            seed_models: &[],
            retry: retry::unprofiled,
        }
    }

    pub fn mimo_oauth() -> Self {
        Self {
            id: "mimo-oauth",
            base_url: "https://api.xiaomimimo.com/v1",
            default_model: "mimo-v2.6-pro",
            default_wire: Wire::Chat,
            responses: ResponsesShape::Gateway,
            wires: WireOffer::CHAT_ONLY,
            headers: &[("X-Mimo-Source", "mimocode-cli"), ("Accept", "application/json")],
            chat: ChatDialect {
                status_in_message: false,
                reauth: ReauthText::KeyRejected,
                developer_role: true,
                replay_reasoning: true,
                capture_reasoning: true,
                effort: EffortDialect::Mimo,
                tool_choice: ToolChoiceSupport::AutoOnly,
                output_limit: OutputLimit::MaxCompletionTokens {
                    default: 128_000,
                    cap: 131_072,
                },
                temperature: Some(1.0),
                session_affinity_headers: true,
                friendly_codes: &[
                    ("421", "Request blocked by content moderation"),
                    ("441", "Request blocked by risk control"),
                ],
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: true,
            },
            seed_models: MIMO_AUDIO,
            retry: retry::mimo,
        }
    }

    pub fn command_code_oauth() -> Self {
        Self {
            id: "command-code-oauth",
            base_url: "https://api.commandcode.ai/provider/v1",
            default_model: "deepseek/deepseek-v4-flash",
            default_wire: Wire::Chat,
            responses: ResponsesShape::Gateway,
            wires: WireOffer {
                offered: &[Wire::Chat, Wire::Messages, Wire::Responses],
                preference: &[Wire::Chat, Wire::Messages, Wire::Responses],
                agent_wire: None,
            },
            headers: &[("Accept", "application/json")],
            chat: ChatDialect {
                reauth: ReauthText::KeyRejected,
                effort: EffortDialect::DeclaredOrBasic,
                tool_choice: ToolChoiceSupport::Forced,
                parallel_tool_calls: true,
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: true,
            },
            seed_models: &[],
            retry: retry::command_code,
        }
    }

    pub fn muse_code_oauth() -> Self {
        Self {
            id: "muse-code-oauth",
            base_url: "https://api.meta.ai/v1",
            default_model: "muse-spark-1.3",
            default_wire: Wire::Responses,
            responses: ResponsesShape::Muse,
            // The endpoint is reached over Responses only.
            wires: WireOffer {
                offered: &[Wire::Responses],
                ..WireOffer::CHAT_ONLY
            },
            headers: &[("x-api-version", "1.0.0")],
            chat: ChatDialect {
                reauth: ReauthText::ModelKeyRejected,
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: true,
            },
            seed_models: MUSE_SEEDS,
            retry: retry::muse_code,
        }
    }

    pub fn opencode_go() -> Self {
        Self {
            id: "opencode-go-oauth",
            base_url: "https://opencode.ai/inference/go/openai/v1",
            default_model: "",
            default_wire: Wire::Chat,
            responses: ResponsesShape::Gateway,
            wires: WireOffer {
                offered: &[Wire::Chat, Wire::Responses, Wire::Messages, Wire::Gemini],
                preference: &[],
                agent_wire: None,
            },
            headers: &[("User-Agent", "mixdog")],
            chat: ChatDialect {
                effort: EffortDialect::Declared,
                reauth: ReauthText::SignInExpired,
                ..ChatDialect::PLAIN
            },
            credential: CredentialKind::StaticKey {
                reauth_on_401: false,
            },
            seed_models: &[],
            retry: retry::unprofiled,
        }
    }

    /// A user-defined or local OpenAI-compatible endpoint (`custom-<uuid>`,
    /// `mixdog-local`): nothing provider-specific, shared default retry.
    pub fn plain(id: &'static str, base_url: &'static str, credential: CredentialKind) -> Self {
        Self {
            id,
            base_url,
            default_model: "default",
            default_wire: Wire::Chat,
            responses: ResponsesShape::Gateway,
            wires: WireOffer::CHAT_ONLY,
            headers: &[],
            chat: ChatDialect::PLAIN,
            credential,
            seed_models: &[],
            retry: retry::unprofiled,
        }
    }
}
