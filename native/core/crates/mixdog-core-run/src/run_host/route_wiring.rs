//! The one factory that projects a route's effort configuration and text-only input at turn
//! start: `prepareTurnEffortConfiguration` / `turnEffortConfigurationMode`
//! (`providers/effort-configuration.mjs`) and the managed local model's `assertLocalModelInput`
//! gate (`local-provider/input-capabilities.mjs`).
//!
//! [`wire_route`] answers `RunSettings.effort`, `RunSettings.text_only` and the snapshot the
//! user turn is stamped with; [`RouteWirer`] is the same factory behind `HopDeps.wiring`, so a
//! route hop and a turn start can never disagree.
//!
//! What Node reads off a provider object arrives as [`ProviderFacts`]: its `config`, its custom
//! protocol, its cached model row (custom routes) and the Anthropic effort gates of the model's
//! catalog caps, with Node's release-generation floor for a model no catalog describes
//! ([`AnthropicEffortGates::for_model`]).

use std::sync::Arc;

use mixdog_agent::effort::{model_key, EffortMode, EffortRoute, EffortSnapshot, EffortWiring, ProjectingAdapter, WireEffort};
use mixdog_agent::message::AgentMessage;
use mixdog_agent::text_only::{MediaText, TextOnlyInput, TextOnlyModel};
use mixdog_ai::providers::anthropic::ModelCaps;
use mixdog_ai::providers::custom::reasoning::{is_custom_provider_name, EFFORT_LEVELS as CUSTOM_EFFORT_LEVELS};
use mixdog_ai::providers::local::PROVIDER_ID as LOCAL_PROVIDER;
use mixdog_ai::service::effort_configuration::{custom_auto_effort_capable, effort_configuration_mode, UnsupportedEfforts, UpdateMode};
use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::{json, Map, Value};

use super::hop_host::HopWiring;

/// The levels of every route that is not a custom one.
const EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/// The session fields the configuration reads.
pub struct TurnRoute<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    /// `session.effort`.
    pub effort: Option<&'a str>,
    /// `session.modelParameters || {}`.
    pub model_parameters: &'a Value,
    /// `session.messages`, with each row's `meta.effortConfiguration` as `effort`.
    pub messages: &'a [AgentMessage],
}

/// `modelSupportsXhighEffort` / `modelSupportsMaxEffort` of the model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AnthropicEffortGates {
    pub xhigh: bool,
    pub max: bool,
}

/// `claudeGeneration` (`anthropic-thinking-contract.mjs`): major*100 + minor of the version
/// token, `INFINITY` for a claude id without one, `None` for a non-claude id.
pub fn claude_generation(model: &str) -> Option<f64> {
    let normalized = model.to_lowercase().replace('.', "-");
    let id = &normalized[normalized.find("claude-")?..];
    // The two version patterns, `^claude-<family>-<ver>` and `^claude-<ver>`; both read
    // `<major>(-<minor 1-2 digits, not followed by a digit>)?` ending at `-`, `@` or the end.
    let version = |rest: &str| -> Option<f64> {
        let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
        let major_len = digits(rest);
        if major_len == 0 {
            return None;
        }
        let ends = |s: &str| s.is_empty() || s.starts_with('-') || s.starts_with('@');
        let major: f64 = rest[..major_len].parse().ok()?;
        let after = &rest[major_len..];
        if let Some(tail) = after.strip_prefix('-') {
            let minor_len = digits(tail);
            if (1..=2).contains(&minor_len) && ends(&tail[minor_len..]) {
                return Some(major * 100.0 + tail[..minor_len].parse::<f64>().ok()?);
            }
        }
        ends(after).then_some(major * 100.0)
    };
    let after_claude = &id["claude-".len()..];
    let family_first = after_claude.split_once('-').and_then(|(family, rest)| {
        let mut chars = family.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        valid.then(|| version(rest)).flatten()
    });
    Some(family_first.or_else(|| version(after_claude)).unwrap_or(f64::INFINITY))
}

/// `CLAUDE_GENERATION_FLOOR.xhighEffort` / `.maxEffort`.
pub const XHIGH_FLOOR: f64 = 407.0;
pub const MAX_FLOOR: f64 = 405.0;
/// `.adaptiveEffort`: adaptive thinking and `output_config.effort` from here on.
pub const ADAPTIVE_FLOOR: f64 = 406.0;
/// `.manualThinkingRejected`: `thinking: {type: "enabled", budget_tokens}` is refused from here on.
pub const MANUAL_REJECTED_FLOOR: f64 = 407.0;

impl AnthropicEffortGates {
    /// The gates a catalog row's caps give: the advertised ladder decides, and `xhigh` implies `max`.
    pub fn from_caps(caps: &ModelCaps) -> Self {
        let has = |level: &str| caps.effort_levels.iter().any(|l| l == level);
        Self { xhigh: has("xhigh"), max: has("max") || has("xhigh") }
    }

    /// `modelSupportsXhighEffort` / `modelSupportsMaxEffort`: the catalog's caps when the
    /// catalog describes the model (a stated empty ladder is a model that takes no effort; the
    /// caps carry the generation floor where it is silent), else the floor of the model id (a new release
    /// inherits it; a non-claude id has no generation and gets neither).
    pub fn for_model(model: &str, caps: Option<&ModelCaps>) -> Self {
        if let Some(caps) = caps.filter(|c| c.ladder_stated || c.supports_effort()) {
            return Self::from_caps(caps);
        }
        let generation = claude_generation(model);
        Self { xhigh: generation.is_some_and(|g| g >= XHIGH_FLOOR), max: generation.is_some_and(|g| g >= MAX_FLOOR) }
    }
}

/// What Node reads off the provider object.
#[derive(Clone)]
pub struct ProviderFacts {
    /// `provider.config`.
    pub config: Value,
    /// `provider.customConfig.protocol`.
    pub protocol: Option<String>,
    /// `provider.getCachedModelInfo(model)`: the row a custom route declares its levels on.
    pub cached_model: Option<Value>,
    pub gates: AnthropicEffortGates,
    /// The route's wire value for a session effort name: the identity for the official
    /// Responses routes, the row's own mapping for a custom one.
    pub wire: WireEffort,
}

impl ProviderFacts {
    pub fn plain(config: Value) -> Self {
        Self { config, protocol: None, cached_model: None, gates: AnthropicEffortGates::default(), wire: Arc::new(|e| Some(e.to_owned())) }
    }
}

/// `codexModelSupportsEffortUpdates(id)`: the OAuth catalog's own answer, `None` without one.
pub type CodexDeclared = dyn Fn(&str) -> Option<bool> + Send + Sync;

fn update_mode(mode: UpdateMode) -> EffortMode {
    match mode {
        UpdateMode::Responses => EffortMode::Responses,
        UpdateMode::Anthropic => EffortMode::Anthropic,
    }
}

/// `turnEffortConfigurationMode(session, provider)`: `Responses` / `Anthropic` (a
/// mid-conversation update), `Custom` (per-request effort), or none. A custom route takes an
/// update mode only when its model declares levels.
pub fn turn_effort_configuration_mode(
    route: &TurnRoute<'_>,
    facts: &ProviderFacts,
    unsupported: &UnsupportedEfforts,
    codex_declared: &CodexDeclared,
) -> Option<EffortMode> {
    let protocol = facts.protocol.as_deref().map(Value::from);
    let mut opts: Map<String, Value> = facts.config.as_object().cloned().unwrap_or_default();
    opts.insert("modelParameters".into(), route.model_parameters.clone());
    match &protocol {
        Some(p) => opts.insert("protocol".into(), p.clone()),
        None => opts.shift_remove("protocol"),
    };
    let custom = is_custom_provider_name(route.provider) && {
        let mut row: Map<String, Value> = facts.cached_model.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
        row.insert("id".into(), json!(route.model));
        custom_auto_effort_capable(route.provider, protocol.as_ref(), &Value::Object(row))
    };
    let mode = effort_configuration_mode(route.provider, &json!(route.model), &Value::Object(opts), unsupported, codex_declared);
    match mode {
        Some(mode) if custom || !is_custom_provider_name(route.provider) => Some(update_mode(mode)),
        _ if custom => Some(EffortMode::Custom),
        _ => None,
    }
}

fn efforts_for(mode: EffortMode, provider: &str) -> &'static [&'static str] {
    if mode == EffortMode::Custom || is_custom_provider_name(provider) {
        &CUSTOM_EFFORT_LEVELS
    } else {
        &EFFORTS
    }
}

/// `normalizedEffort(provider, model, effort)`; `None` is Node's `null`.
fn normalized_effort(provider: &str, effort: Option<&str>, gates: AnthropicEffortGates) -> Option<String> {
    if provider == "anthropic" || provider == "anthropic-oauth" {
        // `normalizeAnthropicEffortInput`
        let raw = effort.filter(|e| !e.is_empty())?;
        let mut level = mixdog_js::js_trim(raw).to_lowercase();
        if level == "extra-high" || level == "very-high" {
            level = "xhigh".into();
        }
        if (level == "xhigh" && !gates.xhigh) || (level == "max" && !gates.max) {
            return Some("high".into());
        }
        return ["low", "medium", "high", "xhigh", "max"].contains(&level.as_str()).then_some(level);
    }
    let value = mixdog_js::js_trim(effort.filter(|e| !e.is_empty()).unwrap_or("medium")).to_lowercase();
    Some(if value == "ultra" { "max".into() } else { value })
}

fn valid_snapshot(value: &EffortSnapshot, provider: &str, model: &str, mode: EffortMode) -> bool {
    let allowed = efforts_for(mode, provider);
    value.provider == provider
        && value.model == model_key(model)
        && value.mode == mode
        && allowed.contains(&value.initial_effort.as_str())
        && allowed.contains(&value.effort.as_str())
}

/// `prepareTurnEffortConfiguration(session, provider, turnEffort)`: the turn's snapshot, or
/// none when the route takes no effort configuration or the effort is not valid for it. A
/// custom route's snapshot only records the turn's effort. `turn_effort` overrides the
/// session's saved effort for this turn only.
pub fn prepare_turn_effort_configuration(
    route: &TurnRoute<'_>,
    facts: &ProviderFacts,
    turn_effort: Option<&str>,
    unsupported: &UnsupportedEfforts,
    codex_declared: &CodexDeclared,
) -> Option<EffortSnapshot> {
    let mode = turn_effort_configuration_mode(route, facts, unsupported, codex_declared)?;
    let effort = normalized_effort(route.provider, turn_effort.or(route.effort), facts.gates)?;
    if !efforts_for(mode, route.provider).contains(&effort.as_str()) {
        return None;
    }
    let first = route.messages.iter().filter_map(|m| m.effort.as_ref()).find(|s| valid_snapshot(s, route.provider, route.model, mode));
    let initial_effort = first.map(|s| s.initial_effort.clone()).filter(|e| !e.is_empty()).unwrap_or_else(|| effort.clone());
    Some(EffortSnapshot { provider: route.provider.to_owned(), model: model_key(route.model), mode, initial_effort, effort })
}

/// The managed local model's catalog entry (`localProviderModelEntry(model)`).
#[derive(Clone, Debug)]
pub struct LocalEntry {
    pub name: String,
    pub supports_function_calling: Option<bool>,
}

/// The text-only gate of `assertLocalModelInput`: only the managed local runtime is text-only.
/// The model's name is its entry's (else the id), and tools are supported as the model server's
/// capabilities say (`runtimeCapabilities.tools`), else as the entry does.
pub fn text_only_input(
    provider: &str,
    model: &str,
    entry: Option<&LocalEntry>,
    runtime_tools: Option<bool>,
    media: Arc<dyn MediaText>,
) -> Option<TextOnlyInput> {
    (provider == LOCAL_PROVIDER).then(|| TextOnlyInput {
        model: TextOnlyModel {
            name: entry.map_or_else(|| model.to_owned(), |e| e.name.clone()),
            supports_tools: runtime_tools.or(entry.and_then(|e| e.supports_function_calling)),
        },
        media,
    })
}

/// What a route's wiring is.
pub struct Wired {
    /// The snapshot the user turn is stamped with (`session.effortConfiguration`).
    pub configuration: Option<EffortSnapshot>,
    /// `RunSettings.effort`: only a route that projects its history (`Responses`, `Anthropic`).
    pub effort: Option<EffortWiring>,
    /// `RunSettings.text_only`.
    pub text_only: Option<TextOnlyInput>,
}

/// The effort wiring of `route` over `adapter`: the projection inputs and the one
/// [`ProjectingAdapter`] that hands each request's projection to the provider.
pub fn wire_effort(
    route: &TurnRoute<'_>,
    facts: &ProviderFacts,
    snapshot: &EffortSnapshot,
    adapter: &Arc<dyn ProviderAdapter>,
) -> Option<EffortWiring> {
    (snapshot.mode != EffortMode::Custom).then(|| EffortWiring {
        route: EffortRoute {
            provider: route.provider.to_owned(),
            model: route.model.to_owned(),
            mode: Some(snapshot.mode),
            allowed: efforts_for(snapshot.mode, route.provider).iter().map(|e| (*e).to_owned()).collect(),
            seed: Some(snapshot.clone()),
            wire: facts.wire.clone(),
        },
        adapter: Arc::new(ProjectingAdapter::new(adapter.clone())),
    })
}

/// The factory: `RunSettings.effort`, `.text_only` and the stamped snapshot for one route.
pub fn wire_route(
    route: &TurnRoute<'_>,
    facts: &ProviderFacts,
    turn_effort: Option<&str>,
    adapter: &Arc<dyn ProviderAdapter>,
    unsupported: &UnsupportedEfforts,
    codex_declared: &CodexDeclared,
    text_only: Option<TextOnlyInput>,
) -> Wired {
    let configuration = prepare_turn_effort_configuration(route, facts, turn_effort, unsupported, codex_declared);
    let effort = configuration.as_ref().and_then(|snapshot| wire_effort(route, facts, snapshot, adapter));
    Wired { configuration, effort, text_only }
}

/// What the wiring reads of a route that is not in the session row.
pub trait WiringSource: Send + Sync {
    /// The provider object's facts for `provider`/`model`.
    fn facts(&self, provider: &str, model: &str, adapter: &Arc<dyn ProviderAdapter>) -> ProviderFacts;
    /// `localProviderModelEntry(model)`.
    fn local_entry(&self, model: &str) -> Option<LocalEntry>;
    /// `localModelState(model).capabilities.tools`.
    fn runtime_tools(&self, model: &str) -> Option<bool>;
    /// The media layer behind the text-only check, for the session `updated`.
    fn media(&self, updated: &Value) -> Arc<dyn MediaText>;
}

/// `HopDeps.wiring`: the turn-start factory over the hopped session's row.
pub struct RouteWirer {
    source: Arc<dyn WiringSource>,
    unsupported: Arc<UnsupportedEfforts>,
    codex_declared: Arc<CodexDeclared>,
}

impl RouteWirer {
    pub fn new(source: Arc<dyn WiringSource>, unsupported: Arc<UnsupportedEfforts>, codex_declared: Arc<CodexDeclared>) -> Self {
        Self { source, unsupported, codex_declared }
    }
}

/// A session row's messages as the configuration reads them.
fn messages_of(session: &Value) -> Vec<AgentMessage> {
    session
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|row| {
            let mut message = AgentMessage::user("");
            message.effort = EffortSnapshot::from_body(row);
            message
        })
        .collect()
}

impl HopWiring for RouteWirer {
    fn wiring(&self, updated: &Value, provider: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
        let text = |key: &str| updated.get(key).and_then(Value::as_str).unwrap_or("");
        let (name, model) = (text("provider"), text("model"));
        let messages = messages_of(updated);
        let parameters = updated.get("modelParameters").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| json!({}));
        let route = TurnRoute { provider: name, model, effort: updated.get("effort").and_then(Value::as_str), model_parameters: &parameters, messages: &messages };
        let facts = self.source.facts(name, model, provider);
        let text_only = text_only_input(name, model, self.source.local_entry(model).as_ref(), self.source.runtime_tools(model), self.source.media(updated));
        let wired = wire_route(&route, &facts, None, provider, &self.unsupported, &*self.codex_declared, text_only);
        (wired.effort, wired.text_only)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("golden/route_wiring.json");

    #[test]
    fn an_uncatalogued_id_gets_nodes_generation_floor() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let gates = golden["gates"].as_array().unwrap();
        assert_eq!(gates.len(), 27);
        for row in gates {
            let got = AnthropicEffortGates::for_model(row["model"].as_str().unwrap(), None);
            assert_eq!((got.xhigh, got.max), (row["xhigh"].as_bool().unwrap(), row["max"].as_bool().unwrap()), "{row}");
        }
    }

    #[test]
    fn a_catalogs_ladder_wins_over_the_floor() {
        let caps = ModelCaps { effort_levels: vec!["low".into(), "high".into()], ..ModelCaps::default() };
        let got = AnthropicEffortGates::for_model("claude-opus-5", Some(&caps));
        assert_eq!((got.xhigh, got.max), (false, false));
        let caps = ModelCaps { effort_levels: vec!["xhigh".into()], ..ModelCaps::default() };
        assert_eq!(AnthropicEffortGates::for_model("claude-3-5-sonnet", Some(&caps)), AnthropicEffortGates { xhigh: true, max: true });
    }

    #[test]
    fn every_configuration_equals_nodes() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 936);
        let unsupported = UnsupportedEfforts::default();
        for case in cases {
            let session = &case["session"];
            let messages: Vec<AgentMessage> = session["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| {
                    let mut message = AgentMessage::user("");
                    message.effort = EffortSnapshot::from_body(row);
                    message
                })
                .collect();
            let gates = AnthropicEffortGates::for_model(session["model"].as_str().unwrap(), None);
            assert_eq!((gates.xhigh, gates.max), (case["caps"]["xhigh"].as_bool().unwrap(), case["caps"]["max"].as_bool().unwrap()), "{case}");
            let provider = &case["provider"];
            let facts = ProviderFacts {
                config: provider["config"].clone(),
                protocol: provider["protocol"].as_str().map(str::to_owned),
                cached_model: Some(provider["row"].clone()).filter(|r| !r.is_null()),
                gates,
                wire: Arc::new(|e| Some(e.to_owned())),
            };
            let parameters = if session["modelParameters"].is_null() { json!({}) } else { session["modelParameters"].clone() };
            let route = TurnRoute {
                provider: session["provider"].as_str().unwrap(),
                model: session["model"].as_str().unwrap(),
                effort: session["effort"].as_str(),
                model_parameters: &parameters,
                messages: &messages,
            };
            let got = prepare_turn_effort_configuration(&route, &facts, case["turnEffort"].as_str(), &unsupported, &|_| None);
            let got = got.as_ref().map(EffortSnapshot::to_value).unwrap_or(Value::Null);
            assert_eq!(got, case["snapshot"], "{case}");
        }
    }

    #[test]
    fn only_the_managed_local_runtime_is_text_only() {
        struct NoMedia;
        #[async_trait::async_trait]
        impl MediaText for NoMedia {
            async fn prepare_pdf_text(
                &self,
                messages: Vec<mixdog_core_api::domain::provider::Message>,
            ) -> Result<Vec<mixdog_core_api::domain::provider::Message>, Box<mixdog_core_api::domain::provider::ProviderError>> {
                Ok(messages)
            }
            fn text_form(
                &self,
                _: &mixdog_core_api::domain::provider::ContentPart,
            ) -> Result<Option<String>, Box<mixdog_core_api::domain::provider::ProviderError>> {
                Ok(None)
            }
        }
        let media: Arc<dyn MediaText> = Arc::new(NoMedia);
        assert!(text_only_input("openai", "gpt-6", None, None, media.clone()).is_none());
        let entry = LocalEntry { name: "Qwen".into(), supports_function_calling: Some(true) };
        let input = text_only_input(LOCAL_PROVIDER, "qwen", Some(&entry), Some(false), media.clone()).unwrap();
        assert_eq!((input.model.name.as_str(), input.model.supports_tools), ("Qwen", Some(false)));
        let bare = text_only_input(LOCAL_PROVIDER, "qwen", None, None, media).unwrap();
        assert_eq!((bare.model.name.as_str(), bare.model.supports_tools), ("qwen", None));
    }

    #[test]
    fn a_custom_routes_snapshot_records_the_effort_and_projects_nothing() {
        let facts = ProviderFacts {
            protocol: Some("openai-chat".into()),
            cached_model: Some(json!({ "reasoningLevels": ["low", "high"] })),
            ..ProviderFacts::plain(json!({}))
        };
        let parameters = json!({});
        let route = TurnRoute { provider: "custom-x", model: "llama", effort: Some("high"), model_parameters: &parameters, messages: &[] };
        let snapshot = prepare_turn_effort_configuration(&route, &facts, None, &UnsupportedEfforts::default(), &|_| None).unwrap();
        assert_eq!((snapshot.mode, snapshot.effort.as_str()), (EffortMode::Custom, "high"));
    }
}
