//! The run's model fallback hop (Node `session/loop/route-fallback.mjs`, `advanceAgentRoute`, and
//! `shared/model-route-fallback.mjs`, `routeFallbackVerdict`).
//!
//! After a provider error survived every retry, the session's chain (read from its settings at
//! that moment, see [`super::route_chain`]) may hand the request to the next model. The hop writes
//! the session fields `routeFallbacks`, `routeFallbackPrimary`, `routeFallbackIndex` and
//! `routeFallbackFailures` together with the new route, in one session update.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::effort::EffortWiring;
pub use mixdog_agent::env::{ChainSurface, RouteDecision, UsageSegment};
use mixdog_agent::env::{RouteFallback, RouteOutside, RouteSwitch, RouteSwitchRequest};
pub use mixdog_agent::recovery::{strip_provider_replay, strip_provider_replay_messages};
use mixdog_agent::text_only::TextOnlyInput;
use mixdog_ai::registry::providers::OAUTH_PROVIDER_NAMES;
use mixdog_ai::retry::classify::kind_from_code;
use mixdog_core_api::domain::provider::{ErrorKind, ProviderAdapter, ProviderError, Usage, UsdTicks};
use mixdog_js::JsRegex;
use serde_json::{Value, json};
use std::sync::LazyLock;

use super::route_chain::BotRoutes;
use super::route_chain::live_route_fallbacks;
use super::route_chain::next_route_fallback_index;
use super::route_chain::route_fallback_hopped;
use super::route_chain::route_leaf;
use super::route_chain::same_route_model;
use super::route_chain::session_chain_source;
use super::route_chain::session_route_primary;
use mixdog_core_ports::ports::domain_sessions::Obj;

/// What the chain does with a failed request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteVerdict {
    Hop,
    /// A context overflow: hop only to a model with a larger window.
    Context,
    Stay,
}

// "The model must be the subject of the refusal" (`MODEL_UNAVAILABLE_RE` of
// `shared/error-presentation.mjs`), flags `im`.
const PREDICATE: &str = r"(?:(?:is|was|has been)\s+)?(?:not found|does not exist|doesn'?t exist|not (?:supported|available)|(?:currently\s+)?unavailable|no longer (?:available|supported)|deprecated|retired|removed)\b";
const SENTENCE_START: &str = r"(?:^|[.:;!]\s+)";

static MODEL_UNAVAILABLE: LazyLock<JsRegex> = LazyLock::new(|| {
    let pattern = [
        format!(r#"{SENTENCE_START}(?:(?:the|this|that|requested|selected|publisher)\s+)*models?(?:\/\S+|\s+[`'"]?[\w./:@-]+[`'"]?)?\s+{PREDICATE}"#),
        format!(r#"{SENTENCE_START}(?:the\s+)?[`'"][^`'"\n]+[`'"]\s+model\s+{PREDICATE}"#),
        format!(r"{SENTENCE_START}(?:unknown|invalid|unsupported) model\b"),
        format!(r"{SENTENCE_START}no endpoints found for [\w.-]+\/[\w.:-]+"),
        r"\bis not a valid model\b".to_owned(),
        r"^model: \S+$".to_owned(),
    ]
    .join("|");
    JsRegex::new_static(&pattern, "im")
});

/// `namesUnavailableModel` over the text of a failure.
pub fn names_unavailable_model(text: &str) -> bool {
    MODEL_UNAVAILABLE.is_match(text)
}

/// The kind name Node's `providerErrorKind` gives.
pub fn kind_name(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Overloaded => "overloaded",
        ErrorKind::RateLimited => "rate_limited",
        ErrorKind::QuotaExhausted => "quota_exhausted",
        ErrorKind::Entitlement => "entitlement",
        ErrorKind::Billing => "billing",
        ErrorKind::Auth => "auth",
        ErrorKind::Permission => "permission",
        ErrorKind::ContextOverflow => "context_overflow",
        ErrorKind::RequestTooLarge => "request_too_large",
        ErrorKind::Policy => "policy",
        ErrorKind::ServiceTierUnavailable => "service_tier_unavailable",
        ErrorKind::InvalidRequest => "invalid_request",
        ErrorKind::ImageRejected => "image_rejected",
        ErrorKind::ReplayRejected => "replay_rejected",
        ErrorKind::ToolSchemaRejected => "tool_schema_rejected",
        ErrorKind::Transient => "transient",
        ErrorKind::Unknown => "unknown",
    }
}

/// `routeFallbackVerdict`. Nothing may have been produced: no visible output, no tool call
/// started or dispatched, nothing marked unsafe to replay.
pub fn route_fallback_verdict(error: &ProviderError) -> RouteVerdict {
    // A connection's retirement cannot be cured by changing the model, even
    // when its bounded reconnect recovery ended without a usable replacement.
    if error.ws_phase.is_some() && mixdog_ai::providers::openai::error::connection_limit(error) {
        return RouteVerdict::Stay;
    }
    let exposure = error.exposure;
    if exposure.text_emitted || exposure.tool_dispatched || exposure.tool_input_cut || error.unsafe_to_retry {
        return RouteVerdict::Stay;
    }
    let status = error.status.unwrap_or(0);
    let hop = |yes: bool| if yes { RouteVerdict::Hop } else { RouteVerdict::Stay };
    match error.kind {
        ErrorKind::QuotaExhausted
        | ErrorKind::Entitlement
        | ErrorKind::Billing
        | ErrorKind::RateLimited
        | ErrorKind::Overloaded
        | ErrorKind::ServiceTierUnavailable
        | ErrorKind::Auth
        | ErrorKind::Permission => RouteVerdict::Hop,
        // Server answers (408/5xx/typed transient code) and typed statusless endpoint-connect / transport
        // failures (after retry exhaustion, with clean exposure checked above) can fall back to another route.
        ErrorKind::Transient => hop(status >= 408 || error.code.as_deref().and_then(kind_from_code) == Some(ErrorKind::Transient) || error.transport.is_some()),
        ErrorKind::InvalidRequest => {
            let code = error.code.as_deref().unwrap_or_default();
            hop(status == 404 || status == 410 || matches!(code, "model_not_found" | "model_not_supported") || names_unavailable_model(&error.message))
        }
        ErrorKind::ContextOverflow => RouteVerdict::Context,
        _ => RouteVerdict::Stay,
    }
}

/// The short reason a notice gives for leaving a model, by provider kind.
fn hop_reason(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::QuotaExhausted => "usage limit reached",
        ErrorKind::Entitlement => "not included in the plan",
        ErrorKind::Billing => "out of credits",
        ErrorKind::RateLimited => "rate-limited",
        ErrorKind::Auth => "sign-in failed",
        ErrorKind::Permission => "access denied",
        ErrorKind::InvalidRequest => "model not available",
        ErrorKind::ContextOverflow => "context too long",
        // overloaded, transient, service_tier_unavailable and anything else
        _ => "unavailable",
    }
}

/// What the account and quota owner knows of whether a route can be sent on right now. The hop never derives it: it is that
/// owner's evidence (accounts, credentials, quota readings, the destination's availability), asked per route.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteEligibility {
    /// A send on it would be admitted now.
    Eligible,
    /// Known exhausted: every account of it is out, so a send on it would fail.
    Exhausted,
    /// No evidence either way (the owner holds none, or cannot read it): the route is neither chosen nor left on this.
    Unknown,
}

/// Pre-flight readiness of a configured route across providers and ACP agents (auth + availability + quota).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RouteReadiness {
    /// Authenticated/available and not quota-exhausted.
    Ready,
    /// Not signed in, missing API key, or agent signed out.
    Unauthenticated { reason: Option<String> },
    /// Authenticated/available, but quota is currently exhausted.
    Exhausted,
    /// Switched off, unconfigured, or refused for a non-auth reason.
    Unavailable { reason: Option<String> },
}

impl RouteReadiness {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }
}

/// Structured event emitted whenever a turn switches routes (pre-flight, mid-turn fallback, or recovery).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RouteSwitchEvent {
    pub from_provider: String,
    pub from_model: String,
    pub to_provider: String,
    pub to_model: String,
    /// `"preflight"`, `"fallback"`, or `"recovery"`.
    pub phase: &'static str,
    /// Switch or failure kind (e.g. `"quota_exhausted"`, `"auth"`, `"provider_unavailable"`, `"recovered"`).
    pub kind: String,
    /// `"loop"` or `"acp"`.
    pub runner: &'static str,
    /// Concise user-facing notice.
    pub notice: String,
}

impl RouteSwitchEvent {
    pub fn to_value(&self) -> Value {
        json!({
            "fromProvider": self.from_provider,
            "fromModel": self.from_model,
            "toProvider": self.to_provider,
            "toModel": self.to_model,
            "phase": self.phase,
            "kind": self.kind,
            "runner": self.runner,
            "notice": self.notice,
        })
    }
}

/// Whether an agent refusal message indicates a sign-in/authentication refusal.
pub fn refusal_is_auth(refusal: &str) -> bool {
    let lower = refusal.to_ascii_lowercase();
    lower.contains("signed out") || lower.contains("sign in")
}

/// Whether `provider` uses authentication in `config` (built-in OAuth/API-key provider, or an existing `custom-*`
/// provider whose `auth` is not `"none"`), regardless of whether it is currently switched off.
fn provider_uses_auth(config: &Obj, provider: &str) -> bool {
    let lower = provider.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.starts_with("acp-") || lower == "mixdog-local" {
        return false;
    }
    if OAUTH_PROVIDER_NAMES.contains(&lower.as_str()) || lower == "opencode-go" {
        return true;
    }
    if matches!(lower.as_str(), "openai" | "anthropic" | "gemini" | "google" | "deepseek" | "xai" | "openrouter" | "cursor-api" | "vertex-ai") {
        return true;
    }
    if lower.starts_with("custom-") {
        return config
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|providers| providers.get(provider).or_else(|| providers.get(&lower)))
            .and_then(Value::as_object)
            .is_some_and(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom")
                    && !entry.get("auth").and_then(Value::as_str).is_some_and(|auth| auth.eq_ignore_ascii_case("none"))
            });
    }
    false
}

/// Whether `provider` is a known authentication-gated provider in `config` (built-in OAuth/API-key provider, or an
/// existing enabled `custom-*` provider whose `auth` is not `"none"`). Removed custom providers, unknown `acp-*`
/// routes, and unrecognized names return `false` so they are classified as unavailable rather than unauthenticated.
pub fn is_known_auth_provider(config: &Obj, provider: &str) -> bool {
    if !provider_uses_auth(config, provider) {
        return false;
    }
    let lower = provider.trim().to_ascii_lowercase();
    if lower.starts_with("custom-") {
        return config
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|providers| providers.get(provider).or_else(|| providers.get(&lower)))
            .and_then(Value::as_object)
            .is_some_and(|entry| entry.get("enabled").and_then(Value::as_bool) != Some(false));
    }
    true
}

/// Why pre-flight route selection is leaving the current route before sending.
#[derive(Clone, Debug)]
pub enum PreflightReason {
    Unavailable { refusal: String },
    Unauthenticated { refusal: String },
    QuotaExhausted { refusal: String },
}

/// Where pre-flight route selection landed.
pub enum PreflightLanding {
    /// An HTTP/loop provider adapter.
    Loop(Arc<dyn ProviderAdapter>),
    /// An ACP outside agent route, with updated session header and notice.
    Outside(RouteOutside),
}

/// Terminal pre-flight failure when the current route cannot run and no configured fallback is ready.
#[derive(Clone, Debug)]
pub struct PreflightFailure {
    pub reason: PreflightReason,
    pub provider: String,
    pub model: String,
    pub skipped: Vec<String>,
}

/// Cancellation handle passed from the turn host so cold ACP probes abort immediately when the turn is stopped.
#[async_trait]
pub trait CancelSignal: Send + Sync {
    fn is_cancelled(&self) -> bool;
    async fn cancelled(&self);
}

/// User-facing unavailability wording for `provider`, avoiding misleading sign-in wording for removed/unconfigured
/// custom providers, ACP routes, or non-auth-gated providers (`mixdog-local`, `auth: "none"` custom providers).
pub fn unavailable_provider_message(config: &Obj, provider: &str, cause: Option<&str>, switched_off: bool) -> String {
    let lower = provider.trim().to_ascii_lowercase();
    if lower.starts_with("acp-") {
        return if switched_off {
            format!("ACP agent route \"{provider}\" is turned off in Settings.")
        } else {
            cause.map(str::to_owned).unwrap_or_else(|| format!("ACP agent route \"{provider}\" is not configured or unavailable in Settings."))
        };
    }
    let filtered_cause = cause.filter(|c| !c.trim().is_empty() && !is_unserved(provider, c));
    if !provider_uses_auth(config, provider) {
        let display = mixdog_ai::service::error_text::provider_display_name(provider);
        if let Some(cause) = filtered_cause {
            return format!("{display} is not available: {cause}.");
        }
        if switched_off {
            return if lower.starts_with("custom-") {
                format!("Custom provider \"{provider}\" is turned off in Settings.")
            } else {
                format!("{display} is turned off in Settings.")
            };
        }
        if lower.starts_with("custom-") {
            return format!("Custom provider \"{provider}\" is not configured or unavailable in Settings.");
        }
        return format!("{display} is not configured or unavailable in Settings.");
    }
    if let Some(cause) = filtered_cause {
        return mixdog_ai::service::error_text::provider_unavailable_text(provider, Some(cause), switched_off);
    }
    if switched_off {
        return mixdog_ai::service::error_text::provider_unavailable_text(provider, None, true);
    }
    mixdog_ai::service::error_text::provider_unavailable_text(provider, None, false)
}

/// Unified single-pass pre-flight decision for a turn.
pub enum PreflightDecision {
    /// Current HTTP/loop provider is ready and stays selected.
    StayLoop(Arc<dyn ProviderAdapter>),
    /// Current outside ACP agent is ready and stays selected.
    StayOutside,
    /// Switched (failover or recovery) onto a ready HTTP/loop provider.
    SwitchLoop(Arc<dyn ProviderAdapter>),
    /// Switched (failover or recovery) onto a ready outside ACP agent.
    SwitchOutside(RouteOutside),
    /// Turn was cancelled while awaiting a cold route readiness probe.
    Cancelled,
    /// Current route is unavailable/unauthenticated/exhausted and no ready fallback exists.
    Failed(PreflightFailure),
}

/// Who runs a turn on a route.
pub enum Runner {
    /// The provider a run of the loop sends on.
    Loop(Arc<dyn ProviderAdapter>),
    /// An agent outside the loop: a turn on the route is the agent's to run.
    Agent,
}

/// What the hop needs from the session, the config and the provider registry.
#[async_trait]
pub trait HopHost: Send + Sync {
    /// Whether `route` (a configured route of the session's order) can be sent on now. Owner: the quota/admission layer;
    /// a host with no such source answers [`RouteEligibility::Unknown`], which reconsiders nothing.
    async fn route_eligibility(&self, route: &Value) -> RouteEligibility {
        let _ = route;
        RouteEligibility::Unknown
    }

    /// Pre-flight readiness of `route` across auth, availability, and quota.
    async fn route_readiness(&self, route: &Value) -> RouteReadiness {
        let provider = text(route.get("provider"));
        let model = text(route.get("model"));
        if provider.is_empty() {
            return RouteReadiness::Unavailable { reason: None };
        }
        let config = self.config();
        if mixdog_ai::service::admin_route::provider_switched_off(&config, &provider) {
            return RouteReadiness::Unavailable { reason: Some(format!("{provider} is turned off")) };
        }
        match self.runner(&provider).await {
            Ok(Some(Runner::Agent)) => match self.agent_ready(&provider, &model).await {
                Ok(()) => RouteReadiness::Ready,
                Err(reason) => {
                    if refusal_is_auth(&reason) {
                        RouteReadiness::Unauthenticated { reason: Some(reason) }
                    } else {
                        RouteReadiness::Unavailable { reason: Some(reason) }
                    }
                }
            },
            Ok(Some(Runner::Loop(_))) => match self.route_eligibility(route).await {
                RouteEligibility::Exhausted => RouteReadiness::Exhausted,
                RouteEligibility::Eligible | RouteEligibility::Unknown => RouteReadiness::Ready,
            },
            Ok(None) => {
                let (cause, switched_off) = self.unavailable_cause(&provider).await;
                if !switched_off && cause.is_none() && is_known_auth_provider(&config, &provider) {
                    RouteReadiness::Unauthenticated { reason: cause }
                } else {
                    RouteReadiness::Unavailable { reason: cause }
                }
            }
            Err(reason) => RouteReadiness::Unavailable { reason: Some(reason) },
        }
    }

    /// The live session header; `None` once it is closed.
    fn session(&self) -> Option<Value>;
    /// `getConfigSnapshot({ secrets: false })`.
    fn config(&self) -> Obj;
    fn bots(&self) -> &dyn BotRoutes;
    /// `displayModelName(model, provider)`; empty when it has no display name.
    fn model_label(&self, provider: &str, model: &str) -> String;
    /// Display name of `provider` when disambiguating colliding model labels across providers.
    fn provider_label(&self, provider: &str) -> String {
        mixdog_ai::service::error_text::provider_display_name(provider)
    }
    /// `presentErrorText(error)`.
    fn error_text(&self, error: &ProviderError) -> String;
    /// Who runs a turn on a route of `provider`: for a provider, `initProviders(ensureProviderEnabled(config, provider))`
    /// then `getProvider`; a route an agent outside the loop serves is the agent's, and nothing is readied for it. `None`
    /// when the provider is not available. `Err` is what `initProviders` throws (its message escapes the hop as it is).
    async fn runner(&self, provider: &str) -> Result<Option<Runner>, String>;
    /// Whether the agent that serves the routes of `provider` can take a turn on `model` now; `Err` is what the agent
    /// says of why not.
    async fn agent_ready(&self, provider: &str, model: &str) -> Result<(), String>;
    /// Why `provider` is not available: the cause its readiness recorded, and whether the user switched it off.
    async fn unavailable_cause(&self, _provider: &str) -> (Option<String>, bool) {
        (None, false)
    }
    /// Non-secret fingerprint of the currently configured credential for `provider`, used to detect credential changes
    /// after an `auth` diversion without auto-recovering on `Unknown` eligibility with unchanged broken credentials.
    async fn credential_fingerprint(&self, _provider: &str) -> Option<String> {
        None
    }
    /// Current wall-clock time in Unix milliseconds, used for transient failure recovery cooldowns.
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }
    /// `resolveSessionContextMeta(provider, model, route).rawContextWindow`, with the route's own
    /// `selectedContextWindow` as the fallback Node reads for the current model.
    fn raw_context_window(&self, provider: &str, model: &str, route: &Value) -> Option<u64>;
    /// `updateSessionRoute(id, route, { crossProvider: true, session })` together with the hop's
    /// fields, then the wire pin, the tool surface rebuild of a Lead-class session and the
    /// provider replay strip. Returns the updated session header, `None` when it is closed. `Err`
    /// is what a step throws (the update, the pin, the surface rebuild): its message escapes the
    /// hop as it is.
    async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String>;
    /// The new route's effort projection and text-only input handling.
    fn wiring(&self, updated: &Value, provider: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>);
}

/// The session fields a hop writes alongside the route (all four in one update).
#[derive(Clone, PartialEq, Debug)]
pub struct HopWrite {
    /// `routeFallbacks`: the chain followed now.
    pub chain: Vec<Value>,
    /// `routeFallbackPrimary`: the route a reset returns to, kept from the first hop; unset when
    /// the session had hopped without one.
    pub primary: Option<Value>,
    /// `routeFallbackIndex`.
    pub index: usize,
    /// `routeFallbackFailures`: every model left so far, why each failed.
    pub failures: Vec<Value>,
    /// `activeTurnCheckpoint.routeChanged = true` when the session has a checkpoint object.
    pub checkpoint_route_changed: bool,
}

/// One model left during the turn and the running usage total when it was left.
#[derive(Clone, PartialEq, Debug)]
pub struct UsageHop {
    pub provider: String,
    pub model: String,
    pub usage: Option<Usage>,
}

/// `usageSince`: what `total` added after the running total `earlier`; `None` when nothing.
fn usage_since(total: &Usage, earlier: Option<&Usage>) -> Option<Usage> {
    let Some(earlier) = earlier else {
        return Some(total.clone());
    };
    let delta = |a: u64, b: u64| a.saturating_sub(b);
    let out = Usage {
        input_tokens: delta(total.input_tokens, earlier.input_tokens),
        output_tokens: delta(total.output_tokens, earlier.output_tokens),
        cache_read_tokens: delta(total.cache_read_tokens, earlier.cache_read_tokens),
        cache_write_tokens: delta(total.cache_write_tokens, earlier.cache_write_tokens),
        cache_write_1h_tokens: delta(total.cache_write_1h_tokens, earlier.cache_write_1h_tokens),
        // Only a total that reported reasoning has a reasoning share (`usageSince`).
        reasoning_tokens: total.reasoning_tokens.map(|t| delta(t, earlier.reasoning_tokens.unwrap_or(0))),
        // `reasoningTokensComplete === true` of the total, carried onto the delta.
        reasoning_incomplete: !total.reasoning_complete(),
        raw: None,
        cost: total.cost.map(|c| UsdTicks(c.0.saturating_sub(earlier.cost.map_or(0, |e| e.0)))),
    };
    let any =
        out.input_tokens + out.output_tokens + out.cache_read_tokens + out.cache_write_tokens + out.cache_write_1h_tokens + out.reasoning_tokens.unwrap_or(0)
            > 0
            || out.cost.is_some_and(|c| c.0 > 0);
    any.then_some(out)
}

/// `routeUsageSegments`: the turn's usage split per model when the route switched mid-turn. Each
/// segment carries only its own tokens.
pub fn route_usage_segments(hops: &[UsageHop], total: &Usage, current: (&str, &str)) -> Vec<UsageSegment> {
    if hops.is_empty() {
        return Vec::new();
    }
    let mut boundaries: Vec<(&str, &str, Option<&Usage>)> = hops.iter().map(|h| (h.provider.as_str(), h.model.as_str(), h.usage.as_ref())).collect();
    boundaries.push((current.0, current.1, Some(total)));
    (0..boundaries.len())
        .filter_map(|i| {
            let (provider, model, usage) = boundaries[i];
            let earlier = if i == 0 { None } else { boundaries[i - 1].2 };
            usage.and_then(|u| usage_since(u, earlier)).map(|usage| UsageSegment { provider: provider.to_owned(), model: model.to_owned(), usage })
        })
        .collect()
}

type RequestForRoute = dyn Fn(&Obj) -> RouteSwitchRequest + Send + Sync;
type RouteSwitchSink = dyn Fn(RouteSwitchEvent) + Send + Sync;

/// The failure kind a route left at turn preflight because its provider was not available carries. Transient: the next
/// reconsider returns to that route once its provider is available again.
pub const PROVIDER_UNAVAILABLE: &str = "provider_unavailable";

/// Default cooldown before recovering to a primary diverted by a transient 429, overload, or 5xx error when the
/// error carried no explicit `Retry-After` or `reset_at` timestamp.
pub const TRANSIENT_RECOVERY_COOLDOWN_MS: u64 = 60_000;

fn is_transient_failure_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("rate_limited" | "overloaded" | "transient" | "service_tier_unavailable"))
}

fn is_unreadable_fingerprint(fp: &str) -> bool {
    matches!(fp, "oauth:unreadable" | "unreadable" | "invalid")
}

fn is_remote_fingerprint(fp: &str) -> bool {
    matches!(fp, "oauth:remote" | "remote")
}

fn transient_recover_after_ms(error: &ProviderError, now_ms: u64) -> Option<u64> {
    if !matches!(error.kind, ErrorKind::RateLimited | ErrorKind::Overloaded | ErrorKind::Transient | ErrorKind::ServiceTierUnavailable) {
        return None;
    }
    if let Some(reset_at) = error.reset_at
        && let Ok(dur) = reset_at.duration_since(std::time::UNIX_EPOCH)
    {
        let ts = u64::try_from(dur.as_millis()).unwrap_or(u64::MAX);
        if ts > now_ms {
            return Some(ts);
        }
    }
    if let Some(retry_after) = error.retry_after {
        let ms = u64::try_from(retry_after.as_millis()).unwrap_or(u64::MAX);
        if ms > 0 {
            return Some(now_ms.saturating_add(ms));
        }
    }
    Some(now_ms.saturating_add(TRANSIENT_RECOVERY_COOLDOWN_MS))
}

fn transient_cooldown_expired(failure: &Value, session: &Value, now_ms: u64) -> bool {
    if let Some(until) = failure.get("recoverAfterMs").and_then(Value::as_u64) {
        return now_ms >= until;
    }
    if let Some(failed_at) = failure.get("failedAt").and_then(Value::as_u64) {
        return now_ms >= failed_at.saturating_add(TRANSIENT_RECOVERY_COOLDOWN_MS);
    }
    if let Some(updated_at) = session.get("updatedAt").and_then(Value::as_u64) {
        return now_ms >= updated_at.saturating_add(TRANSIENT_RECOVERY_COOLDOWN_MS);
    }
    false
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PrimaryRecovery {
    QuotaOnly,
    WhenPresent,
    Auth { credentials_changed: bool },
    Blocked,
}

enum PreflightSelectOutcome {
    Landed(PreflightLanding),
    None(Vec<String>),
    Cancelled,
}

enum ReconsiderOutcome {
    Landed(PreflightLanding),
    None,
    Cancelled,
}

/// The route hop of one run.
pub struct RouteHop {
    host: Arc<dyn HopHost>,
    request_for_route: Option<Box<RequestForRoute>>,
    on_route_switch: Option<Arc<RouteSwitchSink>>,
    cancel: Option<Arc<dyn CancelSignal>>,
    usage_hops: Mutex<Vec<UsageHop>>,
    /// Every route that failed during this run (including `QuotaExhausted`): a turn never cycles back to a route that
    /// already failed within the same turn.
    failed_here: Mutex<Vec<Value>>,
    /// A switch written before the run existed ([`RouteHop::preflight_select`]/[`RouteHop::unavailable`]): the run seats
    /// it before its first request, as it seats any reconsidered route.
    pending: Mutex<Option<RouteSwitch>>,
    /// Cached signal for whether remaining untried fallback routes exist in the session's live chain.
    has_fallbacks: AtomicBool,
}

impl RouteHop {
    pub fn new(host: Arc<dyn HopHost>) -> Self {
        Self {
            host,
            request_for_route: None,
            on_route_switch: None,
            cancel: None,
            usage_hops: Mutex::new(Vec::new()),
            failed_here: Mutex::new(Vec::new()),
            pending: Mutex::new(None),
            has_fallbacks: AtomicBool::new(false),
        }
    }

    pub fn with_request_for_route(mut self, build: impl Fn(&Obj) -> RouteSwitchRequest + Send + Sync + 'static) -> Self {
        self.request_for_route = Some(Box::new(build));
        self
    }

    pub fn with_on_route_switch(mut self, sink: impl Fn(RouteSwitchEvent) + Send + Sync + 'static) -> Self {
        self.on_route_switch = Some(Arc::new(sink));
        self
    }

    pub fn with_cancel(mut self, cancel: Arc<dyn CancelSignal>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    async fn probe_agent_ready(&self, provider: &str, model: &str) -> Result<Result<(), String>, ()> {
        let Some(cancel) = &self.cancel else {
            return Ok(self.host.agent_ready(provider, model).await);
        };
        if cancel.is_cancelled() {
            return Err(());
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(()),
            res = self.host.agent_ready(provider, model) => Ok(res),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
    }

    async fn run_cancellable<T>(&self, fut: impl std::future::Future<Output = T>) -> Result<T, ()> {
        let Some(cancel) = &self.cancel else {
            return Ok(fut.await);
        };
        if cancel.is_cancelled() {
            return Err(());
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(()),
            res = fut => Ok(res),
        }
    }

    async fn auth_credentials_changed(&self, failure: &Value, provider: &str) -> bool {
        if self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().any(|failed| same_route_model(Some(failed), Some(failure))) {
            return false;
        }
        let Some(recorded) = failure.get("credentialFingerprint").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return false;
        };
        let Some(current) = self.host.credential_fingerprint(provider).await else {
            return false;
        };
        if is_unreadable_fingerprint(&current) {
            return false;
        }
        if is_remote_fingerprint(recorded) && is_remote_fingerprint(&current) {
            return true;
        }
        current != recorded
    }

    /// Synchronous read of whether remaining fallback routes exist for the current turn, used by fallback-aware retry
    /// budgeting.
    pub fn has_remaining_fallbacks(&self) -> bool {
        self.has_fallbacks.load(Ordering::Relaxed)
    }

    /// Refreshes [`Self::has_remaining_fallbacks`] from the live session, configured fallback chain, and routes already
    /// tried this turn.
    pub async fn refresh_has_fallbacks(&self) -> bool {
        self.refresh_has_fallbacks_cancellable().await.unwrap_or(false)
    }

    async fn refresh_has_fallbacks_cancellable(&self) -> Result<bool, ()> {
        let has = self.compute_has_remaining_fallbacks().await?;
        if self.is_cancelled() {
            return Err(());
        }
        self.has_fallbacks.store(has, Ordering::Relaxed);
        Ok(has)
    }

    async fn compute_has_remaining_fallbacks(&self) -> Result<bool, ()> {
        if self.is_cancelled() {
            return Err(());
        }
        let Some(session) = self.host.session().filter(has_agent) else { return Ok(false) };
        let config = self.host.config();
        let Ok((chain, _)) = self.run_cancellable(live_route_fallbacks(&session, &config, self.host.bots())).await? else {
            return if self.is_cancelled() { Err(()) } else { Ok(false) };
        };
        if chain.is_empty() {
            return if self.is_cancelled() { Err(()) } else { Ok(false) };
        }
        let mut passed = session.clone();
        let mut failures = self.standing_failures_cancellable(&session).await?;
        failures.extend(self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().cloned());
        passed["routeFallbackFailures"] = Value::Array(failures);
        loop {
            if self.is_cancelled() {
                return Err(());
            }
            let index = next_route_fallback_index(&passed, &chain);
            let Some(next) = chain.get(index) else {
                return if self.is_cancelled() { Err(()) } else { Ok(false) };
            };
            let provider = text(next.get("provider"));
            let model = text(next.get("model"));
            let usable = match self.run_cancellable(self.runner(&provider)).await? {
                Ok(Some(Runner::Loop(_))) => self.run_cancellable(self.host.route_eligibility(next)).await? != RouteEligibility::Exhausted,
                Ok(Some(Runner::Agent)) => match self.probe_agent_ready(&provider, &model).await {
                    Ok(Ok(())) => true,
                    Ok(Err(_)) => false,
                    Err(()) => return Err(()),
                },
                Ok(None) | Err(_) => false,
            };
            if usable {
                return Ok(true);
            }
            match passed.get_mut("routeFallbackFailures").and_then(Value::as_array_mut) {
                Some(entries) => entries.push(next.clone()),
                None => passed["routeFallbackFailures"] = Value::Array(vec![next.clone()]),
            }
        }
    }

    fn emit_route_switch(&self, from: &Value, to: &Value, phase: &'static str, kind: impl Into<String>, runner: &'static str, notice: &str) {
        if let Some(sink) = &self.on_route_switch {
            sink(RouteSwitchEvent {
                from_provider: text(from.get("provider")),
                from_model: text(from.get("model")),
                to_provider: text(to.get("provider")),
                to_model: text(to.get("model")),
                phase,
                kind: kind.into(),
                runner,
                notice: notice.to_owned(),
            });
        }
    }

    /// Pre-flight readiness of the live session's current route.
    pub async fn current_readiness(&self) -> Option<RouteReadiness> {
        let session = self.host.session()?;
        Some(self.host.route_readiness(&session).await)
    }

    /// `routeUsageSegments(state.routeUsageHops, state.lastUsage, current)` at the end of the turn.
    pub fn usage_segments(&self, total: &Usage, current: (&str, &str)) -> Vec<UsageSegment> {
        route_usage_segments(&self.usage_hops.lock().unwrap_or_else(std::sync::PoisonError::into_inner), total, current)
    }

    fn label(&self, route: &Value) -> String {
        let (provider, model) = (text(route.get("provider")), text(route.get("model")));
        let shown = self.host.model_label(&provider, &model);
        if shown.is_empty() { format!("{provider}/{model}") } else { shown }
    }

    fn disambiguated_label(&self, route: &Value, plain: String) -> String {
        let provider = text(route.get("provider"));
        if provider.is_empty() {
            return plain;
        }
        let prefix = self.host.provider_label(&provider);
        if prefix.is_empty() || plain == prefix || plain.starts_with(&format!("{prefix} · ")) || plain.starts_with(&format!("{provider}/")) {
            return plain;
        }
        format!("{prefix} · {plain}")
    }

    fn pair_labels(&self, from: &Value, to: &Value) -> (String, String) {
        let from_label = self.label(from);
        let to_label = self.label(to);
        if from_label == to_label && text(from.get("provider")) != text(to.get("provider")) {
            (self.disambiguated_label(from, from_label), self.disambiguated_label(to, to_label))
        } else {
            (from_label, to_label)
        }
    }

    /// `routeFailure` with optional recovery metadata (transient cooldown timestamps or auth credential fingerprint).
    async fn recorded_failure(&self, route: &Value, error: &ProviderError) -> Value {
        let mut entry = self.failure(route, error);
        if let Some(obj) = entry.as_object_mut() {
            let now = self.host.now_ms();
            if let Some(recover_after) = transient_recover_after_ms(error, now) {
                obj.insert("failedAt".into(), json!(now));
                obj.insert("recoverAfterMs".into(), json!(recover_after));
            }
            if error.kind == ErrorKind::Auth
                && let Some(fp) = self.host.credential_fingerprint(&text(route.get("provider"))).await
            {
                obj.insert("credentialFingerprint".into(), json!(fp));
            }
        }
        entry
    }

    /// `routeFailure`.
    fn failure(&self, route: &Value, error: &ProviderError) -> Value {
        json!({
            "provider": route.get("provider").cloned().unwrap_or(Value::Null),
            "model": route.get("model").cloned().unwrap_or(Value::Null),
            "kind": kind_name(error.kind),
            "error": self.host.error_text(error),
        })
    }

    /// `annotateEndedChain`: after at least one hop the error keeps its own kind and names every
    /// model tried and why each failed. `skipped` is the next route when the chain stopped before
    /// it (a context overflow whose next window is no larger).
    fn annotate(&self, session: &Value, mut error: ProviderError, skipped: Option<&Value>) -> ChainSurface {
        let Some(tried) = session.get("routeFallbackFailures").and_then(Value::as_array).filter(|t| !t.is_empty()) else {
            return ChainSurface { error, attempts: Vec::new(), stopped_before: None };
        };
        let mut attempts = tried.clone();
        attempts.push(self.failure(session, &error));
        let all_routes: Vec<&Value> = attempts.iter().chain(skipped).collect();
        let labels: Vec<String> = all_routes.iter().map(|r| self.label(r)).collect();
        let providers: Vec<String> = all_routes.iter().map(|r| text(r.get("provider"))).collect();
        let shown = |i: usize| {
            let collides = labels.iter().zip(&providers).enumerate().any(|(j, (lbl, prov))| j != i && *lbl == labels[i] && *prov != providers[i]);
            if collides { self.disambiguated_label(all_routes[i], labels[i].clone()) } else { labels[i].clone() }
        };
        let lines = attempts.iter().enumerate().map(|(i, a)| format!("{}: {}", shown(i), text(a.get("error")))).collect::<Vec<_>>().join("; ");
        let head = match skipped {
            Some(_) => format!("Fallback chain stopped before {} (its context window is not larger) — tried", shown(attempts.len())),
            None => "Every model in the fallback chain failed —".to_owned(),
        };
        error.message = format!("{}\n{head} {lines}", error.message);
        let stopped_before = skipped.map(|n| json!({ "provider": n.get("provider"), "model": n.get("model") }));
        ChainSurface { error, attempts, stopped_before }
    }

    /// Who runs a turn on a route of `provider`, readied: `Ok(None)` when it is not available, a provider the user switched
    /// off (asked before any initialization or registered adapter) and a provider no family serves (a removed custom
    /// provider, [`is_unserved`]) included. `Err` is any other readiness failure.
    async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
        if mixdog_ai::service::admin_route::provider_switched_off(&self.host.config(), provider) {
            return Ok(None);
        }
        match self.host.runner(provider).await {
            Err(message) if is_unserved(provider, &message) || provider.starts_with("acp-") => Ok(None),
            looked => looked,
        }
    }

    /// Whether a turn on a route of `provider` and `model` has who runs it now: its provider is available, or its agent
    /// can run that model. Returns `Err(())` if cancelled while awaiting a runner lookup or agent readiness probe.
    async fn present_cancellable(&self, provider: &str, model: &str) -> Result<bool, ()> {
        match self.run_cancellable(self.runner(provider)).await? {
            Ok(Some(Runner::Loop(_))) => Ok(true),
            Ok(Some(Runner::Agent)) => match self.probe_agent_ready(provider, model).await {
                Ok(Ok(())) => Ok(true),
                Ok(Err(_)) => Ok(false),
                Err(()) => Err(()),
            },
            Ok(None) | Err(_) => Ok(false),
        }
    }

    /// The session's recorded failures that still hold:
    /// - `provider_unavailable` clears once its provider/agent is present again.
    /// - `auth` clears for ACP once `agent_ready` succeeds, and for HTTP/OAuth ONLY when the credential fingerprint
    ///   genuinely changes (or becomes absent on logout, or is an unobservable remote proxy route on a new turn) —
    ///   never from quota `Eligible` and never from an unreadable local credential file.
    /// - `quota_exhausted` clears only on explicit `Eligible`.
    /// - transient 429/overload/5xx clears once its cooldown has expired and its runner is present.
    async fn standing_failures_cancellable(&self, session: &Value) -> Result<Vec<Value>, ()> {
        if self.is_cancelled() {
            return Err(());
        }
        let now = self.host.now_ms();
        let mut standing = Vec::new();
        for failure in session.get("routeFallbackFailures").and_then(Value::as_array).into_iter().flatten() {
            if self.is_cancelled() {
                return Err(());
            }
            let kind = failure.get("kind").and_then(Value::as_str);
            let provider = text(failure.get("provider"));
            let model = text(failure.get("model"));
            let cleared = match kind {
                Some(PROVIDER_UNAVAILABLE) => self.present_cancellable(&provider, &model).await?,
                Some("auth") => match self.run_cancellable(self.runner(&provider)).await? {
                    Ok(Some(Runner::Agent)) => match self.probe_agent_ready(&provider, &model).await {
                        Ok(Ok(())) => true,
                        Ok(Err(_)) => false,
                        Err(()) => return Err(()),
                    },
                    Ok(Some(Runner::Loop(_))) | Ok(None) => self.run_cancellable(self.auth_credentials_changed(failure, &provider)).await?,
                    Err(_) => false,
                },
                Some("quota_exhausted") => self.run_cancellable(self.host.route_eligibility(failure)).await? == RouteEligibility::Eligible,
                k if is_transient_failure_kind(k) => transient_cooldown_expired(failure, session, now) && self.present_cancellable(&provider, &model).await?,
                _ => false,
            };
            if !cleared {
                standing.push(failure.clone());
            }
        }
        Ok(standing)
    }

    async fn standing_failures(&self, session: &Value) -> Vec<Value> {
        self.standing_failures_cancellable(session).await.unwrap_or_default()
    }

    /// `nextContextGrows`: a context overflow moves only to a model whose window is larger. `next` is a present candidate
    /// ([`Self::next_present`]).
    fn next_context_grows(&self, session: &Value, next: &Value) -> bool {
        let current = self.host.raw_context_window(&text(session.get("provider")), &text(session.get("model")), session);
        let window = self.host.raw_context_window(&text(next.get("provider")), &text(next.get("model")), next);
        let fallback = session.get("selectedContextWindow").and_then(Value::as_u64);
        window.unwrap_or(0) > current.filter(|w| *w > 0).or(fallback).unwrap_or(0)
    }

    /// The first route of `chain` that `tried` has not run and that can take the request now:
    /// - Skips absent providers/agents (switched off, removed, unauthenticated, unready agent).
    /// - Skips HTTP candidates whose quota is already known [`RouteEligibility::Exhausted`].
    /// - On [`RouteVerdict::Context`], skips candidates whose context window is not larger than `session`'s so a
    ///   later larger candidate can take the turn instead of stopping early.
    async fn next_present(&self, tried: &Value, session: &Value, chain: &[Value], verdict: RouteVerdict) -> Result<Candidate, String> {
        let mut passed = tried.clone();
        let mut absent = Vec::new();
        loop {
            let index = next_route_fallback_index(&passed, chain);
            let Some(next) = chain.get(index) else {
                return Ok(if absent.is_empty() { Candidate::None } else { Candidate::Absent(absent) });
            };
            let provider = text(next.get("provider"));
            let model = text(next.get("model"));
            match self.runner(&provider).await {
                Ok(Some(Runner::Loop(adapter))) => {
                    if self.host.route_eligibility(next).await == RouteEligibility::Exhausted {
                        absent.push(Skipped { index, refusal: Some("usage limit reached".to_owned()) });
                    } else if verdict == RouteVerdict::Context && !self.next_context_grows(session, next) {
                        absent.push(Skipped { index, refusal: Some("its context window is not larger".to_owned()) });
                    } else {
                        return Ok(Candidate::Present(index, Runner::Loop(adapter)));
                    }
                }
                Ok(Some(Runner::Agent)) => {
                    if verdict == RouteVerdict::Context && !self.next_context_grows(session, next) {
                        absent.push(Skipped { index, refusal: Some("its context window is not larger".to_owned()) });
                    } else {
                        match self.probe_agent_ready(&provider, &model).await {
                            Ok(Ok(())) => return Ok(Candidate::Present(index, Runner::Agent)),
                            Ok(Err(refusal)) => absent.push(Skipped { index, refusal: Some(refusal) }),
                            Err(()) => return Err("cancelled".to_owned()),
                        }
                    }
                }
                Ok(None) => absent.push(Skipped { index, refusal: None }),
                Err(refusal) if provider.starts_with("acp-") => absent.push(Skipped { index, refusal: Some(refusal) }),
                Err(error) => return Err(error),
            }
            match passed.get_mut("routeFallbackFailures").and_then(Value::as_array_mut) {
                Some(failures) => failures.push(next.clone()),
                None => passed["routeFallbackFailures"] = Value::Array(vec![next.clone()]),
            }
        }
    }
}

/// `String(value ?? '')` for the fields of a route.
fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => mixdog_js::value_to_string(v),
    }
}

/// The muted transcript line for a hop: `<from> <reason> — switched to <to>.`
fn notice_text(from: &str, to: &str, kind: ErrorKind) -> String {
    format!("{from} {} — switched to {to}.", hop_reason(kind))
}

/// Whether `message`, the readiness failure of `provider`, says no provider family serves it: a custom provider just
/// removed has no entry to build, which Node finds as `getProvider` empty (`Provider "<id>" not available`), not as an error.
pub fn is_unserved(provider: &str, message: &str) -> bool {
    message == format!("[provider] Failed to init \"{provider}\": unknown enabled provider: {provider}")
}

/// Only a session acting as an agent follows a route chain.
fn has_agent(session: &Value) -> bool {
    session.get("agent").is_some_and(|a| !matches!(a, Value::Null | Value::Bool(false)) && a.as_str() != Some(""))
}

fn has_checkpoint(session: &Value) -> bool {
    session.get("activeTurnCheckpoint").is_some_and(Value::is_object)
}

/// The next route a mid-turn hop may take ([`RouteHop::next_present`]).
enum Candidate {
    /// The chain index of the first present route, and who runs it there.
    Present(usize, Runner),
    /// Only absent routes are left: all of them, in order.
    Absent(Vec<Skipped>),
    /// No route is left to try.
    None,
}

/// An absent route a hop passed over.
struct Skipped {
    /// Its chain index.
    index: usize,
    /// What the agent that serves it says of why it cannot run; `None` for a route whose provider is not available.
    refusal: Option<String>,
}

fn plain(error: ProviderError) -> RouteDecision {
    RouteDecision::Surface(Box::new(ChainSurface { error, attempts: Vec::new(), stopped_before: None }))
}

/// The loop's contract: the decision of [`RouteHop::decide`], and the turn's usage per model.
#[async_trait]
impl RouteFallback for RouteHop {
    async fn advance(&self, error: ProviderError, last_usage: Option<&Usage>) -> RouteDecision {
        self.decide(error, last_usage).await
    }

    async fn reconsider(&self, last_usage: Option<&Usage>) -> Result<Option<RouteSwitch>, String> {
        RouteHop::reconsider(self, last_usage).await
    }

    fn usage_segments(&self, total: &Usage, current: (&str, &str)) -> Vec<UsageSegment> {
        RouteHop::usage_segments(self, total, current)
    }
}

impl RouteHop {
    /// `advanceAgentRoute`: after a provider error survived every retry, the next model of the
    /// session's chain, the error to surface, or the failure of the hop itself. `last_usage` is
    /// the turn's running usage total, booked against the model being left.
    pub async fn decide(&self, error: ProviderError, last_usage: Option<&Usage>) -> RouteDecision {
        let Some(session) = self.host.session() else { return plain(error) };
        // Only a session with an agent hops.
        if !has_agent(&session) {
            return plain(error);
        }
        // Read from the session's settings at this hop: a chain edited while it runs applies now,
        // and one cleared to [] leaves the provider's own error.
        let config = self.host.config();
        // A bot route read that never ran is not "no chain" and not the config's route: the hop
        // fails with that, rather than switching to a model the user did not choose.
        let (chain, _) = match live_route_fallbacks(&session, &config, self.host.bots()).await {
            Ok(live) => live,
            Err(error) => return RouteDecision::Fail(error.to_string()),
        };
        if chain.is_empty() {
            return plain(error);
        }
        // A route is excluded only for a reason that still holds: one left because its provider was not available is a
        // candidate again once it is. Every other recorded failure counts as tried until a deliberate route write clears it.
        let standing = self.standing_failures(&session).await;
        let mut tried = session.clone();
        tried["routeFallbackFailures"] = Value::Array(standing.clone());
        let verdict = route_fallback_verdict(&error);
        if verdict == RouteVerdict::Stay {
            return plain(error);
        }
        // The candidate is the first route still to try whose provider is there, or whose agent can run: the run leaves the
        // loop for an agent's route as it moves to a provider's. Nothing is written before it is found. With
        // none left but absent ones the chain ends as Node's did on its next route: a hop fails with that route's absence,
        // and an overflow stops before it.
        let (index, runner) = match self.next_present(&tried, &session, &chain, verdict).await {
            Ok(Candidate::Present(index, runner)) => (index, runner),
            Ok(Candidate::None) => return RouteDecision::Surface(Box::new(self.annotate(&tried, error, None))),
            Ok(Candidate::Absent(skipped)) if verdict == RouteVerdict::Context => {
                return RouteDecision::Surface(Box::new(self.annotate(&tried, error, Some(&chain[skipped[0].index]))));
            }
            // The failure stays the turn's error; every fallback that could not take over is named beside it with its reason:
            // an agent's in its own words.
            Ok(Candidate::Absent(skipped)) => {
                let mut surfaced = error;
                for Skipped { index, refusal } in skipped {
                    let reason = match refusal {
                        Some(refusal) => refusal,
                        None => {
                            let provider = text(chain[index].get("provider"));
                            let (cause, switched_off) = self.host.unavailable_cause(&provider).await;
                            unavailable_provider_message(&config, &provider, cause.as_deref(), switched_off)
                        }
                    };
                    surfaced.message = format!("{}\nSkipped fallback {}: {reason}", surfaced.message, self.label(&chain[index]));
                }
                return plain(surfaced);
            }
            Err(message) => return RouteDecision::Fail(message),
        };
        let next = &chain[index];
        let failed = self.recorded_failure(&session, &error).await;
        // The route a reset returns to, kept from the first hop.
        let primary = if route_fallback_hopped(&session) {
            session.get("routeFallbackPrimary").filter(|p| !p.is_null()).cloned()
        } else {
            Some(primary_snapshot(&session))
        };
        let (from, to) = self.pair_labels(&session, next);
        let notice = notice_text(&from, &to, error.kind);
        let mut failures = standing;
        failures.push(failed);
        let write = HopWrite { chain: chain.clone(), primary, index: index + 1, failures, checkpoint_route_changed: has_checkpoint(&session) };
        let kind = kind_name(error.kind);
        let decided = match runner {
            Runner::Loop(provider) => match self.seat(next, provider, write, notice.clone()).await {
                Ok(switch) => {
                    self.book_usage(&session, last_usage.cloned());
                    self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
                    self.emit_route_switch(&session, next, "fallback", kind, "loop", &notice);
                    Ok(RouteDecision::Switch(switch))
                }
                Err(err) => Err(self.rollback_if_diverged(&session, err).await),
            },
            Runner::Agent => match self.outside(next, write, notice.clone()).await {
                Ok(outside) => {
                    self.book_usage(&session, last_usage.cloned());
                    self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
                    self.emit_route_switch(&session, next, "fallback", kind, "acp", &notice);
                    Ok(RouteDecision::Outside(Box::new(outside)))
                }
                Err(err) => Err(self.rollback_if_diverged(&session, err).await),
            },
        };
        let _ = self.refresh_has_fallbacks().await;
        decided.unwrap_or_else(RouteDecision::Fail)
    }

    /// Writes the session onto `next`, a route an agent outside the loop serves, with `write` in one update: the turn goes
    /// on on that agent, on the header written. Only an explicit user window cap on `next` is written as
    /// `selectedContextWindow`; never a catalog guess, which would clamp the window the agent reports.
    async fn outside(&self, next: &Value, write: HopWrite, notice: String) -> Result<RouteOutside, String> {
        let selected = next
            .get("selectedContextWindow")
            .or_else(|| next.get("contextTokens"))
            .and_then(Value::as_f64)
            .filter(|w| w.is_finite() && *w >= 1.0)
            .map(|w| w.floor() as u64);
        let Some(updated) = self.host.apply_hop(route_fields(next, selected), write).await? else {
            return Err("agent session closed during model fallback".to_owned());
        };
        Ok(RouteOutside { header: updated.as_object().cloned().unwrap_or_default(), notice })
    }

    async fn skipped_reason(&self, route: &Value, refusal: Option<String>) -> String {
        let reason = match refusal {
            Some(refusal) => refusal,
            None => {
                let provider = text(route.get("provider"));
                let (cause, switched_off) = self.host.unavailable_cause(&provider).await;
                unavailable_provider_message(&self.host.config(), &provider, cause.as_deref(), switched_off)
            }
        };
        format!("Skipped fallback {}: {reason}", self.label(route))
    }

    /// Unified single-pass pre-flight decision for a turn:
    /// 1. Checks current route readiness (honoring an already-resolved `agent_refusal` / `outside_serves` status).
    /// 2. When the current route is ready and the session is diverted, checks primary recovery across both HTTP and ACP
    ///    runners.
    /// 3. When the current route is unavailable, unauthenticated, or quota-exhausted, scans configured order ONCE and
    ///    returns the selected runner (`SwitchLoop` / `SwitchOutside`) or a terminal `Failed` decision without sending to
    ///    a known-unusable or known-exhausted route.
    pub async fn preflight(&self, agent_refusal: Option<&str>, outside_serves: bool, outside_signed_out: bool) -> Result<PreflightDecision, String> {
        let Some(session) = self.host.session() else {
            return Err("agent session closed".to_owned());
        };
        let provider = text(session.get("provider"));
        let model = text(session.get("model"));
        let failure_reason = if let Some(refusal) = agent_refusal {
            if outside_signed_out || refusal_is_auth(refusal) {
                PreflightReason::Unauthenticated { refusal: refusal.to_owned() }
            } else {
                PreflightReason::Unavailable { refusal: refusal.to_owned() }
            }
        } else if outside_serves {
            return Ok(match self.reconsider_inner(None, true).await? {
                ReconsiderOutcome::Landed(PreflightLanding::Loop(adapter)) => PreflightDecision::SwitchLoop(adapter),
                ReconsiderOutcome::Landed(PreflightLanding::Outside(outside)) => PreflightDecision::SwitchOutside(outside),
                ReconsiderOutcome::Cancelled => PreflightDecision::Cancelled,
                ReconsiderOutcome::None => PreflightDecision::StayOutside,
            });
        } else {
            let Ok(runner) = self.run_cancellable(self.runner(&provider)).await else {
                return Ok(PreflightDecision::Cancelled);
            };
            match runner? {
                Some(Runner::Agent) => match self.probe_agent_ready(&provider, &model).await {
                    Err(()) => return Ok(PreflightDecision::Cancelled),
                    Ok(Ok(())) => {
                        return Ok(match self.reconsider_inner(None, true).await? {
                            ReconsiderOutcome::Landed(PreflightLanding::Loop(adapter)) => PreflightDecision::SwitchLoop(adapter),
                            ReconsiderOutcome::Landed(PreflightLanding::Outside(outside)) => PreflightDecision::SwitchOutside(outside),
                            ReconsiderOutcome::Cancelled => PreflightDecision::Cancelled,
                            ReconsiderOutcome::None => PreflightDecision::StayOutside,
                        });
                    }
                    Ok(Err(refusal)) => {
                        if refusal_is_auth(&refusal) {
                            PreflightReason::Unauthenticated { refusal }
                        } else {
                            PreflightReason::Unavailable { refusal }
                        }
                    }
                },
                Some(Runner::Loop(adapter)) => {
                    let Ok(eligibility) = self.run_cancellable(self.host.route_eligibility(&session)).await else {
                        return Ok(PreflightDecision::Cancelled);
                    };
                    match eligibility {
                        RouteEligibility::Exhausted => {
                            PreflightReason::QuotaExhausted { refusal: "No applicable account has quota for this model.".to_owned() }
                        }
                        RouteEligibility::Eligible | RouteEligibility::Unknown => {
                            return Ok(match self.reconsider_inner(None, true).await? {
                                ReconsiderOutcome::Landed(PreflightLanding::Loop(next_adapter)) => PreflightDecision::SwitchLoop(next_adapter),
                                ReconsiderOutcome::Landed(PreflightLanding::Outside(outside)) => PreflightDecision::SwitchOutside(outside),
                                ReconsiderOutcome::Cancelled => PreflightDecision::Cancelled,
                                ReconsiderOutcome::None => PreflightDecision::StayLoop(adapter),
                            });
                        }
                    }
                }
                None => {
                    let config = self.host.config();
                    let (cause, switched_off) = self.host.unavailable_cause(&provider).await;
                    let refusal = unavailable_provider_message(&config, &provider, cause.as_deref(), switched_off);
                    if !provider.starts_with("acp-") && !switched_off && cause.is_none() && is_known_auth_provider(&config, &provider) {
                        PreflightReason::Unauthenticated { refusal }
                    } else {
                        PreflightReason::Unavailable { refusal }
                    }
                }
            }
        };

        Ok(match self.preflight_select_detailed(failure_reason.clone(), true).await? {
            PreflightSelectOutcome::Landed(PreflightLanding::Loop(adapter)) => PreflightDecision::SwitchLoop(adapter),
            PreflightSelectOutcome::Landed(PreflightLanding::Outside(outside)) => PreflightDecision::SwitchOutside(outside),
            PreflightSelectOutcome::Cancelled => PreflightDecision::Cancelled,
            PreflightSelectOutcome::None(skipped) => PreflightDecision::Failed(PreflightFailure { reason: failure_reason, provider, model, skipped }),
        })
    }

    /// Pre-flight route selection before sending: when the current route is unauthenticated, unavailable, or quota-exhausted,
    /// selects the first ready route in configured order across both HTTP providers and ACP agents.
    pub async fn preflight_select(&self, reason: PreflightReason) -> Result<Option<PreflightLanding>, String> {
        Ok(match self.preflight_select_detailed(reason, true).await? {
            PreflightSelectOutcome::Landed(landing) => Some(landing),
            PreflightSelectOutcome::None(_) | PreflightSelectOutcome::Cancelled => None,
        })
    }

    async fn preflight_select_detailed(&self, reason: PreflightReason, allow_outside: bool) -> Result<PreflightSelectOutcome, String> {
        let Some(session) = self.host.session().filter(has_agent) else { return Ok(PreflightSelectOutcome::None(Vec::new())) };
        let config = self.host.config();
        let Ok(live) = self.run_cancellable(live_route_fallbacks(&session, &config, self.host.bots())).await else {
            return Ok(PreflightSelectOutcome::Cancelled);
        };
        let (chain, _) = live.map_err(|error| error.to_string())?;
        if chain.is_empty() {
            return Ok(PreflightSelectOutcome::None(Vec::new()));
        }
        let Ok(order) = self.run_cancellable(self.configured_order(&session, &config, &chain)).await else {
            return Ok(PreflightSelectOutcome::Cancelled);
        };
        let Ok(standing) = self.standing_failures_cancellable(&session).await else {
            return Ok(PreflightSelectOutcome::Cancelled);
        };
        let mut landing = None;
        let mut skipped = Vec::new();
        for (index, route) in order.iter().enumerate() {
            if same_route_model(Some(route), Some(&session)) {
                continue;
            }
            if let Some(failure) = standing.iter().rev().find(|f| same_route_model(Some(f), Some(route))) {
                let detail = failure.get("error").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
                skipped.push(self.skipped_reason(route, detail).await);
                continue;
            }
            let provider = text(route.get("provider"));
            let model = text(route.get("model"));
            let Ok(runner) = self.run_cancellable(self.runner(&provider)).await else {
                return Ok(PreflightSelectOutcome::Cancelled);
            };
            match runner {
                Ok(Some(Runner::Loop(adapter))) => {
                    let Ok(eligibility) = self.run_cancellable(self.host.route_eligibility(route)).await else {
                        return Ok(PreflightSelectOutcome::Cancelled);
                    };
                    if eligibility == RouteEligibility::Exhausted {
                        skipped.push(self.skipped_reason(route, Some("usage limit reached".to_owned())).await);
                        continue;
                    }
                    landing = Some((index, Runner::Loop(adapter)));
                    break;
                }
                Ok(Some(Runner::Agent)) if allow_outside => match self.probe_agent_ready(&provider, &model).await {
                    Ok(Ok(())) => {
                        landing = Some((index, Runner::Agent));
                        break;
                    }
                    Ok(Err(refusal)) => skipped.push(self.skipped_reason(route, Some(refusal)).await),
                    Err(()) => return Ok(PreflightSelectOutcome::Cancelled),
                },
                Ok(Some(Runner::Agent)) => {}
                Ok(None) => skipped.push(self.skipped_reason(route, None).await),
                Err(refusal) if provider.starts_with("acp-") => skipped.push(self.skipped_reason(route, Some(refusal)).await),
                Err(err) => return Err(err),
            }
        }
        let Some((index, runner)) = landing else { return Ok(PreflightSelectOutcome::None(skipped)) };
        let next = &order[index];
        let (failure_kind, refusal, notice_kind) = match reason {
            PreflightReason::Unavailable { refusal } => (PROVIDER_UNAVAILABLE, refusal, ErrorKind::Transient),
            PreflightReason::Unauthenticated { refusal } => (kind_name(ErrorKind::Auth), refusal, ErrorKind::Auth),
            PreflightReason::QuotaExhausted { refusal } => ("quota_exhausted", refusal, ErrorKind::QuotaExhausted),
        };
        // The route left is the reason of this diversion: its entry is the newest, and the one it lands on leaves the list
        // unless it is the primary, as on any reconsidered route.
        let mut failures = session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default();
        failures.retain(|f| !same_route_model(Some(f), Some(&session)));
        let mut failure_entry = json!({ "provider": session.get("provider"), "model": session.get("model"), "kind": failure_kind, "error": refusal });
        if failure_kind == "auth"
            && let Some(fp) = self.host.credential_fingerprint(&text(session.get("provider"))).await
            && let Some(obj) = failure_entry.as_object_mut()
        {
            obj.insert("credentialFingerprint".into(), json!(fp));
        }
        failures.push(failure_entry);
        if index != 0 {
            failures.retain(|f| !same_route_model(Some(f), Some(next)));
        }
        let write = HopWrite {
            chain,
            primary: (!route_fallback_hopped(&session)).then(|| primary_snapshot(&session)),
            index,
            failures,
            checkpoint_route_changed: has_checkpoint(&session),
        };
        let (from, to) = self.pair_labels(&session, next);
        let notice =
            if notice_kind == ErrorKind::Auth { format!("{from} sign-in required — switched to {to}.") } else { notice_text(&from, &to, notice_kind) };
        let outcome = match runner {
            Runner::Loop(provider) => {
                let switch = match self.seat(next, provider, write, notice.clone()).await {
                    Ok(switch) => switch,
                    Err(err) => return Err(self.rollback_if_diverged(&session, err).await),
                };
                self.book_usage(&session, None);
                self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
                let provider = switch.provider.clone();
                *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(switch);
                self.emit_route_switch(&session, next, "preflight", failure_kind, "loop", &notice);
                PreflightLanding::Loop(provider)
            }
            Runner::Agent => {
                let outside = match self.outside(next, write, notice.clone()).await {
                    Ok(outside) => outside,
                    Err(err) => return Err(self.rollback_if_diverged(&session, err).await),
                };
                self.book_usage(&session, None);
                self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
                self.emit_route_switch(&session, next, "preflight", failure_kind, "acp", &notice);
                PreflightLanding::Outside(outside)
            }
        };
        if self.refresh_has_fallbacks_cancellable().await.is_err() {
            *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            return Ok(PreflightSelectOutcome::Cancelled);
        }
        Ok(PreflightSelectOutcome::Landed(outcome))
    }

    /// The session's provider is not available at turn preflight (`refusal` says so). Nothing was sent, so every other
    /// route of the configured order is a candidate, the primary first: the first whose provider is available and that is
    /// not known exhausted takes the turn, whatever the session tried before (a primary that recovered while its fallback
    /// went away is taken back). The switch is written now and held for the run, which seats it before its first request as
    /// it seats any reconsidered route, so the landing provider starts exactly as after a mid-turn hop. `Ok(Some)` is the
    /// landing provider; `Ok(None)` when no other route is available (the refusal stands); `Err` is the hop's own failure,
    /// which may come after the session was written.
    pub async fn unavailable(&self, refusal: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        match self.preflight_select_detailed(PreflightReason::Unavailable { refusal: refusal.to_owned() }, false).await? {
            PreflightSelectOutcome::Landed(PreflightLanding::Loop(provider)) => Ok(Some(provider)),
            PreflightSelectOutcome::Landed(PreflightLanding::Outside(_)) | PreflightSelectOutcome::None(_) | PreflightSelectOutcome::Cancelled => Ok(None),
        }
    }

    /// The run was assembled on the route the preflight switch ([`Self::unavailable`]) landed on: the switch it seats carries
    /// what the assembly built there (the request with the first request's judged effort and the cache-tail gate judged from
    /// the session's sends, the effort wiring over the stored rows, the text-only handling), so seating it leaves them so.
    pub fn assembled(&self, request: RouteSwitchRequest, effort: Option<EffortWiring>, text_only: Option<TextOnlyInput>) {
        if let Some(switch) = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
            switch.request = request;
            switch.effort = effort;
            switch.text_only = text_only;
        }
    }

    /// Ends the left model's share of the turn: `usage`, the running total at the switch, bounds it so each model's tokens are booked at its own rates.
    fn book_usage(&self, left: &Value, usage: Option<Usage>) {
        self.usage_hops.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(UsageHop {
            provider: text(left.get("provider")),
            model: text(left.get("model")),
            usage,
        });
    }

    /// A reconsidered switch to `next` failed with `failure`: record `next` in `failed_here` so this turn will not
    /// retry it, and only write the session back onto `session` if the failed hop left the live header diverged.
    /// `Err` only when the session closed or the restore itself failed.
    async fn put_back(&self, session: &Value, next: &Value, failure: String) -> Result<(), String> {
        tracing::warn!(session = %text(session.get("id")), from = %self.label(session), to = %self.label(next), "[route] switch back failed, staying on the current route: {failure}");
        self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(next.clone());
        let Some(live) = self.host.session() else {
            return Err(format!("{failure}; the session closed before it was put back on {}", self.label(session)));
        };
        if !session_diverged(&live, session) {
            return Ok(());
        }
        let current = Value::Object(route_leaf(Some(session)));
        let window = self.host.raw_context_window(&text(session.get("provider")), &text(session.get("model")), session);
        let write = HopWrite {
            chain: session.get("routeFallbacks").and_then(Value::as_array).cloned().unwrap_or_default(),
            primary: session.get("routeFallbackPrimary").filter(|p| !p.is_null()).cloned(),
            index: session.get("routeFallbackIndex").and_then(Value::as_u64).map_or(0, |i| usize::try_from(i).unwrap_or(usize::MAX)),
            failures: session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default(),
            checkpoint_route_changed: false,
        };
        match self.host.apply_hop(route_fields(&current, window), write).await {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(format!("{failure}; the session closed before it was put back on {}", self.label(session))),
            Err(restore) => Err(format!("{failure}; putting the session back on {} failed: {restore}", self.label(session))),
        }
    }

    /// The session's configured order: its primary as the chain owner states it now (else the leaf the session kept from
    /// its first hop), then `chain`.
    async fn configured_order(&self, session: &Value, config: &Obj, chain: &[Value]) -> Vec<Value> {
        let primary = session_route_primary(session);
        let source = session_chain_source(session, config, self.host.bots()).await.ok().flatten().filter(|s| same_route_model(Some(s), Some(&primary)));
        let mut order = vec![Value::Object(route_leaf(Some(source.as_ref().unwrap_or(&primary))))];
        order.extend(chain.iter().cloned());
        order
    }

    /// Writes the session onto `next` with `write` in one update, and the switch the run seats from what was written.
    async fn seat(&self, next: &Value, provider: Arc<dyn ProviderAdapter>, write: HopWrite, notice: String) -> Result<RouteSwitch, String> {
        let window = self.host.raw_context_window(&text(next.get("provider")), &text(next.get("model")), next);
        let Some(updated) = self.host.apply_hop(route_fields(next, window), write).await? else {
            return Err("agent session closed during model fallback".to_owned());
        };
        let (effort, text_only) = self.host.wiring(&updated, &provider);
        let request = match (&self.request_for_route, updated.as_object()) {
            (Some(build), Some(fields)) => build(fields),
            _ => RouteSwitchRequest::default(),
        };
        Ok(RouteSwitch { provider, model: text(updated.get("model")), notice, request, effort, text_only })
    }

    /// If a failed hop left the host's live session advertising an uncommitted route or fallback history (for hosts
    /// whose `apply_hop` does not roll back internally), writes the pre-hop route and history back onto the session.
    async fn rollback_if_diverged(&self, session: &Value, failure: String) -> String {
        let Some(live) = self.host.session() else {
            return failure;
        };
        if !session_diverged(&live, session) {
            return failure;
        }
        let current = Value::Object(route_leaf(Some(session)));
        let window = self.host.raw_context_window(&text(session.get("provider")), &text(session.get("model")), session);
        let write = HopWrite {
            chain: session.get("routeFallbacks").and_then(Value::as_array).cloned().unwrap_or_default(),
            primary: session.get("routeFallbackPrimary").filter(|p| !p.is_null()).cloned(),
            index: session.get("routeFallbackIndex").and_then(Value::as_u64).map_or(0, |i| usize::try_from(i).unwrap_or(usize::MAX)),
            failures: session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default(),
            checkpoint_route_changed: false,
        };
        match self.host.apply_hop(route_fields(&current, window), write).await {
            Ok(Some(_)) => failure,
            Ok(None) => format!("{failure}; the session closed before it was put back on {}", self.label(session)),
            Err(restore) => format!("{failure}; putting the session back on {} failed: {restore}", self.label(session)),
        }
    }

    /// The index and runner of the route `reconsider` moves to, and whether the current route is known exhausted (the
    /// move is a diversion): the first usable eligible route above `current`, else, while `current` is exhausted, the
    /// first one below it. Respects persisted `standing` failures (auth, quota, and unexpired transient cooldowns) in
    /// addition to turn-local `failed_here`. Supports cross-runner recovery (HTTP↔ACP) when `allow_outside` is true.
    #[allow(clippy::too_many_arguments)]
    async fn reconsider_target(
        &self,
        order: &[Value],
        current: usize,
        failed_here: &[Value],
        recorded_failures: &[Value],
        standing: &[Value],
        primary_recovery: PrimaryRecovery,
        only_intermediate_auth: bool,
        allow_outside: bool,
    ) -> Result<(Option<(usize, Runner)>, bool), ()> {
        let usable = |route: &Value| !failed_here.iter().any(|failed| same_route_model(Some(failed), Some(route)));
        // Any failure that survived `standing_failures_cancellable` (auth, quota_exhausted, unexpired transient
        // cooldown, provider_unavailable, context_overflow, etc.) still holds and blocks recovery.
        let blocked_by_standing = |route: &Value| standing.iter().any(|f| same_route_model(Some(f), Some(route)));
        let auth_recovered = |route: &Value| {
            recorded_failures
                .iter()
                .rev()
                .find(|f| same_route_model(Some(f), Some(route)))
                .is_some_and(|f| f.get("kind").and_then(Value::as_str) == Some("auth"))
                && !standing.iter().any(|f| same_route_model(Some(f), Some(route)) && f.get("kind").and_then(Value::as_str) == Some("auth"))
        };
        for (index, route) in order.iter().enumerate().take(current) {
            if !usable(route) || blocked_by_standing(route) {
                continue;
            }
            if only_intermediate_auth && (index == 0 || !auth_recovered(route)) {
                continue;
            }
            let provider = text(route.get("provider"));
            let model = text(route.get("model"));
            let Ok(Some(runner)) = self.run_cancellable(self.runner(&provider)).await? else { continue };
            match runner {
                Runner::Loop(adapter) => {
                    let eligibility = self.run_cancellable(self.host.route_eligibility(route)).await?;
                    let eligible = if index == 0 {
                        match primary_recovery {
                            PrimaryRecovery::Blocked | PrimaryRecovery::Auth { credentials_changed: false } => false,
                            PrimaryRecovery::Auth { credentials_changed: true } | PrimaryRecovery::WhenPresent => eligibility != RouteEligibility::Exhausted,
                            PrimaryRecovery::QuotaOnly => eligibility == RouteEligibility::Eligible,
                        }
                    } else if auth_recovered(route) {
                        eligibility != RouteEligibility::Exhausted
                    } else {
                        eligibility == RouteEligibility::Eligible
                    };
                    if eligible {
                        return Ok((Some((index, Runner::Loop(adapter))), false));
                    }
                }
                Runner::Agent if allow_outside => {
                    let recovered = match (index == 0, primary_recovery) {
                        (true, PrimaryRecovery::Blocked) => false,
                        (true, PrimaryRecovery::WhenPresent | PrimaryRecovery::Auth { .. }) => true,
                        _ if auth_recovered(route) => true,
                        _ => self.run_cancellable(self.host.route_eligibility(route)).await? == RouteEligibility::Eligible,
                    };
                    if recovered {
                        match self.probe_agent_ready(&provider, &model).await {
                            Ok(Ok(())) => return Ok((Some((index, Runner::Agent)), false)),
                            Ok(Err(_)) => {}
                            Err(()) => return Err(()),
                        }
                    }
                }
                Runner::Agent => {}
            }
        }
        if only_intermediate_auth {
            return Ok((None, false));
        }
        if self.run_cancellable(self.host.route_eligibility(&order[current])).await? != RouteEligibility::Exhausted {
            return Ok((None, false));
        }
        for (index, route) in order.iter().enumerate().skip(current + 1) {
            if usable(route) && !blocked_by_standing(route) {
                match self.run_cancellable(self.host.route_eligibility(route)).await? {
                    RouteEligibility::Eligible => {
                        let provider = text(route.get("provider"));
                        if let Ok(Some(Runner::Loop(adapter))) = self.run_cancellable(self.runner(&provider)).await? {
                            return Ok((Some((index, Runner::Loop(adapter))), true));
                        }
                    }
                    RouteEligibility::Exhausted => {}
                    // The ordinary fallback path may still send here. Do not jump past it.
                    RouteEligibility::Unknown => break,
                }
            }
        }
        Ok((None, true))
    }

    async fn reconsider_inner(&self, last_usage: Option<&Usage>, allow_outside: bool) -> Result<ReconsiderOutcome, String> {
        let Some(session) = self.host.session().filter(has_agent) else { return Ok(ReconsiderOutcome::None) };
        if session.get("pendingRoute").is_some_and(|pick| !pick.is_null()) {
            return Ok(ReconsiderOutcome::None);
        }
        let primary = session_route_primary(&session);
        let failures = session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default();
        let latest_primary_failure = failures.iter().rev().find(|f| same_route_model(Some(f), Some(&primary)));
        let reason = latest_primary_failure.and_then(|f| f.get("kind")).and_then(Value::as_str);
        let left_on_quota = reason == Some("quota_exhausted");
        let left_on_unavailable = reason == Some(PROVIDER_UNAVAILABLE);
        let left_on_auth = reason == Some("auth");
        let left_on_expired_transient = latest_primary_failure
            .is_some_and(|f| is_transient_failure_kind(f.get("kind").and_then(Value::as_str)) && transient_cooldown_expired(f, &session, self.host.now_ms()));
        let on_primary = same_route_model(Some(&primary), Some(&session));
        let only_intermediate_auth = !left_on_quota && !left_on_unavailable && !left_on_auth && !left_on_expired_transient && !on_primary;
        let has_intermediate_auth =
            failures.iter().any(|f| !same_route_model(Some(f), Some(&primary)) && f.get("kind").and_then(Value::as_str) == Some("auth"));
        // Only the configured primary, or a route automatically diverted on quota, auth, unavailable provider, an
        // expired transient 429/overload/5xx cooldown, or an intermediate route auth diversion, participates.
        if only_intermediate_auth && !has_intermediate_auth {
            return Ok(ReconsiderOutcome::None);
        }
        let config = self.host.config();
        let Ok(live) = self.run_cancellable(live_route_fallbacks(&session, &config, self.host.bots())).await else {
            return Ok(ReconsiderOutcome::Cancelled);
        };
        let Ok((chain, _)) = live else { return Ok(ReconsiderOutcome::None) };
        if chain.is_empty() {
            return Ok(ReconsiderOutcome::None);
        }
        let Ok(order) = self.run_cancellable(self.configured_order(&session, &config, &chain)).await else {
            return Ok(ReconsiderOutcome::Cancelled);
        };
        let Some(current) = order.iter().position(|route| same_route_model(Some(route), Some(&session))) else {
            return Ok(ReconsiderOutcome::None);
        };
        let primary_recovery = if left_on_unavailable || left_on_expired_transient {
            PrimaryRecovery::WhenPresent
        } else if left_on_auth {
            let credentials_changed = match latest_primary_failure {
                Some(entry) => {
                    let Ok(changed) = self.run_cancellable(self.auth_credentials_changed(entry, &text(primary.get("provider")))).await else {
                        return Ok(ReconsiderOutcome::Cancelled);
                    };
                    changed
                }
                None => false,
            };
            PrimaryRecovery::Auth { credentials_changed }
        } else if left_on_quota || on_primary {
            PrimaryRecovery::QuotaOnly
        } else {
            PrimaryRecovery::Blocked
        };
        let failed_here = self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let Ok(standing) = self.standing_failures_cancellable(&session).await else {
            return Ok(ReconsiderOutcome::Cancelled);
        };
        if only_intermediate_auth {
            let any_intermediate_auth_cleared = failures.iter().any(|f| {
                !same_route_model(Some(f), Some(&primary))
                    && f.get("kind").and_then(Value::as_str) == Some("auth")
                    && !standing.iter().any(|s| same_route_model(Some(s), Some(f)) && s.get("kind").and_then(Value::as_str) == Some("auth"))
            });
            if !any_intermediate_auth_cleared {
                return Ok(ReconsiderOutcome::None);
            }
        }
        let Ok((target, diverted_on)) =
            self.reconsider_target(&order, current, &failed_here, &failures, &standing, primary_recovery, only_intermediate_auth, allow_outside).await
        else {
            return Ok(ReconsiderOutcome::Cancelled);
        };
        let Some((index, runner)) = target else { return Ok(ReconsiderOutcome::None) };
        let next = &order[index];
        let (from, to) = self.pair_labels(&session, next);
        let notice = if index < current {
            format!("{to} is available again — switched back from {from}.")
        } else {
            notice_text(&from, &to, ErrorKind::QuotaExhausted)
        };
        // The routes the session still has behind it are the history of what failed: the one it now stands on proved
        // itself, so it leaves the list unless it is the primary, whose entry is what marks the diversion.
        let mut failures = failures;
        if diverted_on {
            failures.retain(|f| !same_route_model(Some(f), Some(&session)));
            failures.push(json!({
                "provider": session.get("provider"),
                "model": session.get("model"),
                "kind": "quota_exhausted",
                "error": "No applicable account has quota for this model.",
            }));
        }
        if index != 0 {
            failures.retain(|f| !same_route_model(Some(f), Some(next)));
        }
        let write = HopWrite {
            chain,
            primary: (!route_fallback_hopped(&session)).then(|| primary_snapshot(&session)),
            index,
            failures,
            checkpoint_route_changed: has_checkpoint(&session),
        };
        let (phase, kind) = if index < current { ("recovery", "recovered") } else { ("fallback", "quota_exhausted") };
        match runner {
            Runner::Loop(provider) => {
                let switch = match self.seat(next, provider, write, notice.clone()).await {
                    Ok(switch) => switch,
                    // The switch is optional: the run stays on the route it is on, and the session is written back onto it.
                    Err(failure) => return self.put_back(&session, next, failure).await.map(|()| ReconsiderOutcome::None),
                };
                if diverted_on {
                    self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
                }
                let adapter = switch.provider.clone();
                *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(switch);
                self.emit_route_switch(&session, next, phase, kind, "loop", &notice);
                self.book_usage(&session, last_usage.cloned());
                if self.refresh_has_fallbacks_cancellable().await.is_err() {
                    *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                    return Ok(ReconsiderOutcome::Cancelled);
                }
                Ok(ReconsiderOutcome::Landed(PreflightLanding::Loop(adapter)))
            }
            Runner::Agent => {
                let outside = match self.outside(next, write, notice.clone()).await {
                    Ok(outside) => outside,
                    Err(failure) => return self.put_back(&session, next, failure).await.map(|()| ReconsiderOutcome::None),
                };
                if diverted_on {
                    self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
                }
                self.emit_route_switch(&session, next, phase, kind, "acp", &notice);
                self.book_usage(&session, last_usage.cloned());
                if self.refresh_has_fallbacks_cancellable().await.is_err() {
                    return Ok(ReconsiderOutcome::Cancelled);
                }
                Ok(ReconsiderOutcome::Landed(PreflightLanding::Outside(outside)))
            }
        }
    }

    /// Before an unsent request: the primary or a session diverted by quota, auth, an unavailable provider, or an
    /// expired transient cooldown follows the configured order by eligibility.
    pub async fn reconsider(&self, last_usage: Option<&Usage>) -> Result<Option<RouteSwitch>, String> {
        let pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(switch) = pending {
            return Ok(Some(switch));
        }
        if matches!(self.reconsider_inner(last_usage, false).await?, ReconsiderOutcome::Landed(_)) {
            return Ok(self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take());
        }
        Ok(None)
    }
}

fn session_diverged(live: &Value, session: &Value) -> bool {
    !same_route_model(Some(live), Some(session))
        || live.get("routeFallbackIndex") != session.get("routeFallbackIndex")
        || live.get("routeFallbackFailures") != session.get("routeFallbackFailures")
        || live.get("routeFallbackPrimary") != session.get("routeFallbackPrimary")
}

/// Captures `routeFallbackPrimary` from a live pre-hop session header, preserving `selectedContextWindow` when present
/// so later context-window comparisons keep the primary route's authoritative window.
fn primary_snapshot(session: &Value) -> Value {
    let mut leaf = route_leaf(Some(session));
    if let Some(window) = session.get("selectedContextWindow").filter(|v| !v.is_null()) {
        leaf.insert("selectedContextWindow".into(), window.clone());
    }
    Value::Object(leaf)
}

/// The route `updateSessionRoute` receives for a hop to `next`.
fn route_fields(next: &Value, window: Option<u64>) -> Obj {
    let mut route = next.as_object().cloned().unwrap_or_default();
    let truthy_or = |key: &str, default: Value| match next.get(key) {
        Some(v) if !matches!(v, Value::Null | Value::Bool(false)) && v.as_str() != Some("") => v.clone(),
        _ => default,
    };
    route.insert("effort".into(), truthy_or("effort", Value::Null));
    route.insert("fast".into(), Value::Bool(next.get("fast") == Some(&Value::Bool(true))));
    if let Some(mode) = mixdog_ai::effort::EffortAuto::read_explicit_value(next) {
        route.insert(mixdog_ai::effort::EffortAuto::KEY.into(), Value::Bool(mode.as_bool()));
        route.insert(mixdog_ai::effort::EffortAuto::LEGACY_KEY.into(), Value::Null);
    } else {
        route.insert(mixdog_ai::effort::EffortAuto::KEY.into(), Value::Null);
        if let Some(Value::Bool(legacy)) = next.get(mixdog_ai::effort::EffortAuto::LEGACY_KEY) {
            route.insert(mixdog_ai::effort::EffortAuto::LEGACY_KEY.into(), Value::Bool(*legacy));
        } else {
            route.insert(mixdog_ai::effort::EffortAuto::LEGACY_KEY.into(), Value::Null);
        }
    }
    route.insert("modelParameters".into(), truthy_or("modelParameters", json!({})));
    // Present with no value clears the session's own, as Node's `undefined` does.
    for key in ["contextPercent", "contextTokens"] {
        route.insert(key.into(), next.get(key).cloned().unwrap_or(Value::Null));
    }
    route.insert("selectedContextWindow".into(), window.map_or(Value::Null, |w| json!(w)));
    route
}

#[cfg(test)]
mod reconsider_tests {
    use std::collections::HashMap;

    use mixdog_core_api::domain::mock::MockProvider;

    use super::*;
    use crate::run_host::route_chain::RouteReadUnavailable;

    struct NoBots;
    #[async_trait]
    impl BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, RouteReadUnavailable> {
            Ok(None)
        }
    }

    /// A host over one session header whose routes the quota owner's evidence is given for by model.
    struct Host {
        session: Mutex<Value>,
        config: Obj,
        evidence: HashMap<&'static str, RouteEligibility>,
        windows: HashMap<&'static str, u64>,
        fingerprints: Mutex<HashMap<&'static str, String>>,
        clock_ms: std::sync::atomic::AtomicU64,
        agent_wait: Option<Arc<tokio::sync::Notify>>,
        mutate_session_on_hop: bool,
        writes: Mutex<Vec<(Obj, HopWrite)>>,
        /// Providers that are not available.
        gone: Vec<&'static str>,
        /// Providers whose readiness fails, with the failure.
        init_errors: Vec<(&'static str, String)>,
        /// Providers whose routes an agent outside the loop serves, with what the agent says of whether it can run.
        agents: Vec<(&'static str, Result<(), String>)>,
        /// Optional model display-label overrides (mapping raw model IDs to display names).
        model_labels: HashMap<&'static str, &'static str>,
        /// Optional provider display-label overrides (e.g. ACP preset labels).
        provider_labels: HashMap<&'static str, &'static str>,
        /// What the next writes fail with in a step after the session write (the wire pin, the tool surface), in order;
        /// the writes after them succeed.
        failing: Mutex<std::collections::VecDeque<&'static str>>,
    }

    #[async_trait]
    impl HopHost for Host {
        async fn route_eligibility(&self, route: &Value) -> RouteEligibility {
            self.evidence.get(text(route.get("model")).as_str()).copied().unwrap_or(RouteEligibility::Unknown)
        }
        fn session(&self) -> Option<Value> {
            Some(self.session.lock().unwrap().clone())
        }
        fn config(&self) -> Obj {
            self.config.clone()
        }
        fn bots(&self) -> &dyn BotRoutes {
            &NoBots
        }
        fn model_label(&self, _: &str, model: &str) -> String {
            self.model_labels.get(model).map(|label| (*label).to_owned()).unwrap_or_else(|| model.to_owned())
        }
        fn provider_label(&self, provider: &str) -> String {
            self.provider_labels
                .get(provider)
                .map(|label| (*label).to_owned())
                .unwrap_or_else(|| mixdog_ai::service::error_text::provider_display_name(provider))
        }
        fn error_text(&self, error: &ProviderError) -> String {
            error.message.clone()
        }
        async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
            if let Some((_, message)) = self.init_errors.iter().find(|(name, _)| *name == provider) {
                return Err(message.clone());
            }
            if self.gone.contains(&provider) {
                return Ok(None);
            }
            if self.agents.iter().any(|(name, _)| *name == provider) {
                return Ok(Some(Runner::Agent));
            }
            Ok(Some(Runner::Loop(Arc::new(MockProvider::new([])))))
        }
        async fn agent_ready(&self, provider: &str, _model: &str) -> Result<(), String> {
            if let Some(wait) = &self.agent_wait {
                wait.notified().await;
            }
            self.agents.iter().find(|(name, _)| *name == provider).map(|(_, ready)| ready.clone()).expect("an agent's route")
        }
        async fn credential_fingerprint(&self, provider: &str) -> Option<String> {
            self.fingerprints.lock().unwrap().get(provider).cloned()
        }
        fn now_ms(&self) -> u64 {
            self.clock_ms.load(Ordering::Relaxed)
        }
        fn raw_context_window(&self, _: &str, model: &str, _: &Value) -> Option<u64> {
            self.windows.get(model).copied()
        }
        async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
            if self.mutate_session_on_hop {
                let mut sess = self.session.lock().unwrap();
                for (k, v) in &route {
                    sess[k] = v.clone();
                }
                sess["routeFallbacks"] = Value::Array(write.chain.clone());
                if let Some(primary) = &write.primary {
                    sess["routeFallbackPrimary"] = primary.clone();
                }
                sess["routeFallbackIndex"] = json!(write.index);
                sess["routeFallbackFailures"] = Value::Array(write.failures.clone());
            }
            self.writes.lock().unwrap().push((route.clone(), write));
            match self.failing.lock().unwrap().pop_front() {
                Some(message) => Err(message.to_owned()),
                None => Ok(Some(Value::Object(route))),
            }
        }
        fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
            (None, None)
        }
    }

    /// The Lead's configured order: Fable first, then Astra, then Gemini, each on its own provider.
    fn config() -> Obj {
        json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead", "provider": "anthropic-oauth", "model": "fable", "effort": "medium",
                "fallbacks": [{ "provider": "openai-oauth", "model": "astra", "effort": "high" }, { "provider": "google", "model": "gem" }],
            }],
        })
        .as_object()
        .unwrap()
        .clone()
    }

    /// A Lead session a quota moved off Fable (`kind`), standing on `(provider, model)`.
    fn session(provider: &str, model: &str, kind: &str) -> Value {
        json!({
            "id": "sess_x", "agent": "mixy", "provider": provider, "model": model,
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{ "provider": "anthropic-oauth", "model": "fable", "kind": kind, "error": "limit" }],
        })
    }

    fn hop(session: Value, evidence: &[(&'static str, RouteEligibility)]) -> (RouteHop, Arc<Host>) {
        let mut host = stub(session, &[], &[]);
        host.evidence = evidence.iter().copied().collect();
        hop_over(host)
    }

    /// A host over `session` whose `gone` providers are not available and whose next writes fail with `failing`.
    fn stub(session: Value, gone: &[&'static str], failing: &[&'static str]) -> Host {
        Host {
            session: Mutex::new(session),
            config: config(),
            evidence: HashMap::new(),
            windows: HashMap::new(),
            fingerprints: Mutex::default(),
            clock_ms: std::sync::atomic::AtomicU64::new(1_000_000),
            agent_wait: None,
            mutate_session_on_hop: false,
            writes: Mutex::default(),
            gone: gone.to_vec(),
            init_errors: Vec::new(),
            agents: Vec::new(),
            model_labels: HashMap::new(),
            provider_labels: HashMap::new(),
            failing: Mutex::new(failing.iter().copied().collect()),
        }
    }

    fn hop_over(host: Host) -> (RouteHop, Arc<Host>) {
        let host = Arc::new(host);
        (RouteHop::new(host.clone()), host)
    }

    fn fresh() -> Value {
        json!({ "id": "sess_x", "agent": "mixy", "provider": "anthropic-oauth", "model": "fable" })
    }

    use RouteEligibility::{Eligible, Exhausted, Unknown};

    #[tokio::test]
    async fn the_first_unsent_request_leaves_only_a_proven_exhausted_primary_in_order() {
        for (primary, first_alternative, expected) in [(Unknown, Eligible, None), (Exhausted, Unknown, None), (Exhausted, Eligible, Some("astra"))] {
            let fresh = json!({ "id": "sess_x", "agent": "mixy", "provider": "anthropic-oauth", "model": "fable" });
            let (hop, _) = hop(fresh, &[("fable", primary), ("astra", first_alternative), ("gem", Eligible)]);
            let switched = hop.reconsider(None).await.unwrap();
            assert_eq!(switched.as_ref().map(|s| s.model.as_str()), expected);
            if let Some(switch) = switched {
                let usage = Usage { input_tokens: 42, ..Usage::default() };
                let segments = hop.usage_segments(&usage, ("openai-oauth", &switch.model));
                assert_eq!(segments.len(), 1);
                assert_eq!((segments[0].provider.as_str(), segments[0].model.as_str(), segments[0].usage.input_tokens), ("openai-oauth", "astra", 42));
            }
        }
    }

    /// A primary not available at preflight: the secondary is written once, the run seats it at its first reconsider (and
    /// only then), the turn does not bounce back to the primary it just left, and the usage is the landing model's.
    #[tokio::test]
    async fn an_unavailable_primary_hands_the_run_its_secondary_before_the_first_request() {
        let refusal = "Provider \"anthropic-oauth\" not available";
        let (route, host) = hop(fresh(), &[]);
        assert!(route.unavailable(refusal).await.expect("the hop runs").is_some(), "the secondary is taken");
        {
            let writes = host.writes.lock().unwrap();
            assert_eq!((writes.len(), writes[0].0["model"].as_str(), writes[0].1.index), (1, Some("astra"), 1));
            assert_eq!(writes[0].1.failures, vec![json!({ "provider": "anthropic-oauth", "model": "fable", "kind": PROVIDER_UNAVAILABLE, "error": refusal })]);
        }
        let switch = route.reconsider(None).await.unwrap().expect("the run seats the written switch");
        assert_eq!(switch.model, "astra");
        assert_eq!(switch.notice, "fable unavailable — switched to astra.", "the switch is told to the user");
        assert!(route.reconsider(None).await.unwrap().is_none(), "the held switch is seated once");
        let segments = route.usage_segments(&Usage { input_tokens: 7, ..Usage::default() }, ("openai-oauth", "astra"));
        assert_eq!(segments.iter().map(|s| (s.model.as_str(), s.usage.input_tokens)).collect::<Vec<_>>(), [("astra", 7)]);
    }

    /// The run was assembled on the route a preflight switch landed on: seating that switch leaves the request the assembly
    /// built there (its judged first effort), not one rebuilt from the session.
    #[tokio::test]
    async fn a_preflight_switch_seats_the_request_the_run_was_assembled_with() {
        use mixdog_core_api::domain::provider::RequestOptions;
        let effort = |effort: &str| RouteSwitchRequest { options: RequestOptions { effort: Some(effort.into()), ..Default::default() }, ..Default::default() };
        let (route, _) = hop(fresh(), &[]);
        let route = route.with_request_for_route(move |_| effort("rebuilt"));
        assert!(route.unavailable("Provider \"anthropic-oauth\" not available").await.expect("the hop runs").is_some());
        route.assembled(effort("judged"), None, None);
        let switch = route.reconsider(None).await.unwrap().expect("the run seats the written switch");
        assert_eq!(switch.request.options.effort.as_deref(), Some("judged"));
    }

    /// No other available route keeps the caller's refusal and writes nothing; a hop that fails after its write is that
    /// failure, not the refusal.
    #[tokio::test]
    async fn an_unavailable_route_without_another_available_one_or_with_a_failed_hop_is_told_apart() {
        let refusal = "Provider \"google\" not available";
        let nowhere = stub(session("google", "gem", "quota_exhausted"), &["anthropic-oauth", "openai-oauth", "google"], &[]);
        let (route, host) = hop_over(nowhere);
        assert!(route.unavailable(refusal).await.expect("no hop failed").is_none(), "no other route is available");
        assert!(host.writes.lock().unwrap().is_empty());

        let failing = stub(fresh(), &[], &["the tool surface could not be rebuilt"]);
        let (route, host) = hop_over(failing);
        assert_eq!(route.unavailable(refusal).await.err().as_deref(), Some("the tool surface could not be rebuilt"));
        assert_eq!(host.writes.lock().unwrap().len(), 1, "the session was written before the step failed");
        assert!(route.reconsider(None).await.unwrap().is_none(), "nothing is held for the run");
    }

    /// The next turn on the secondary goes back to a primary left at preflight once its provider is available, with no quota
    /// evidence either way; while it is still not available the secondary stays.
    #[tokio::test]
    async fn the_next_turn_returns_to_a_primary_whose_provider_is_back() {
        let diverted = session("openai-oauth", "astra", PROVIDER_UNAVAILABLE);
        let (route, host) = hop(diverted.clone(), &[]);
        let switch = route.reconsider(None).await.unwrap().expect("back to the primary");
        assert_eq!(switch.model, "fable");
        assert!(switch.notice.contains("available again"), "{}", switch.notice);
        assert_eq!(host.writes.lock().unwrap()[0].1.index, 0);

        let still_gone = stub(diverted, &["anthropic-oauth"], &[]);
        let (route, host) = hop_over(still_gone);
        assert!(route.reconsider(None).await.unwrap().is_none());
        assert!(host.writes.lock().unwrap().is_empty());
    }

    /// The fallback is the one not available now while the primary is back: the preflight takes every other route, the
    /// primary first, even one the session already tried; the fallback's absence becomes the newest failure.
    #[tokio::test]
    async fn an_unavailable_fallback_goes_back_to_a_recovered_primary_first() {
        let refusal = "Provider \"openai-oauth\" not available";
        let (route, host) = hop(session("openai-oauth", "astra", PROVIDER_UNAVAILABLE), &[]);
        assert!(route.unavailable(refusal).await.expect("the hop runs").is_some());
        let writes = host.writes.lock().unwrap();
        let (landed, write) = &writes[0];
        assert_eq!((landed["model"].as_str(), write.index, write.primary.is_none()), (Some("fable"), 0, true));
        let kinds: Vec<(&str, &str)> = write.failures.iter().map(|f| (f["model"].as_str().unwrap(), f["kind"].as_str().unwrap())).collect();
        assert_eq!(kinds, [("fable", PROVIDER_UNAVAILABLE), ("astra", PROVIDER_UNAVAILABLE)]);
        drop(writes);
        assert_eq!(route.reconsider(None).await.unwrap().expect("held for the run").notice, "astra unavailable — switched to fable.");
    }

    /// A mid-turn hop excludes a route only for a reason that still holds: an earlier `provider_unavailable` entry of a route
    /// whose provider is back does not stop the hop from taking it, while one whose provider is still gone, and any other
    /// recorded failure, does.
    #[tokio::test]
    async fn a_mid_turn_hop_takes_a_route_whose_absence_no_longer_holds() {
        let on_primary = |second: &str| {
            json!({
                "id": "sess_x", "agent": "mixy", "provider": "anthropic-oauth", "model": "fable",
                "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" }, "routeFallbackIndex": 0,
                "routeFallbackFailures": [
                    { "provider": "anthropic-oauth", "model": "fable", "kind": PROVIDER_UNAVAILABLE, "error": "gone" },
                    { "provider": "openai-oauth", "model": "astra", "kind": second, "error": "before" },
                ],
            })
        };
        let overloaded = || {
            let mut error = ProviderError::new(ErrorKind::Transient, mixdog_core_api::domain::provider::DeliveryState::NotSent);
            error.status = Some(503);
            error.message = "overloaded".into();
            error
        };
        for (second, gone, lands) in
            [(PROVIDER_UNAVAILABLE, &[][..], "astra"), (PROVIDER_UNAVAILABLE, &["openai-oauth"][..], "gem"), ("rate_limited", &[][..], "gem")]
        {
            let (route, host) = hop_over(stub(on_primary(second), gone, &[]));
            let RouteDecision::Switch(switch) = route.decide(overloaded(), None).await else { panic!("{second} {gone:?}: the hop runs") };
            assert_eq!(switch.model, lands, "{second} {gone:?}");
            let writes = host.writes.lock().unwrap();
            let kept: Vec<&str> = writes[0].1.failures.iter().map(|f| f["model"].as_str().unwrap()).collect();
            let expected: &[&str] = if lands == "astra" { &["fable"] } else { &["astra", "fable"] };
            assert_eq!(kept, expected, "only the reasons that hold, then the failure just met");
        }
    }

    /// A removed custom provider in the middle of the order is absent, not an error: the preflight goes on to the next route.
    /// A real readiness failure still ends the search with that failure.
    #[tokio::test]
    async fn a_removed_intermediate_provider_does_not_stop_the_preflight() {
        let refusal = "Provider \"anthropic-oauth\" not available";
        let mut removed = stub(fresh(), &["anthropic-oauth"], &[]);
        removed.init_errors = vec![("openai-oauth", "[provider] Failed to init \"openai-oauth\": unknown enabled provider: openai-oauth".to_owned())];
        let (route, host) = hop_over(removed);
        assert!(route.unavailable(refusal).await.expect("absent, not an error").is_some());
        let writes = host.writes.lock().unwrap();
        assert_eq!((writes[0].0["model"].as_str(), writes[0].1.index), (Some("gem"), 2));
        drop(writes);

        let mut broken = stub(fresh(), &["anthropic-oauth"], &[]);
        broken.init_errors = vec![("openai-oauth", "the token store is locked".to_owned())];
        let (route, host) = hop_over(broken);
        assert_eq!(route.unavailable(refusal).await.err().as_deref(), Some("the token store is locked"));
        assert!(host.writes.lock().unwrap().is_empty());
    }

    /// A mid-turn hop passes over an absent candidate as the preflight does: A → B → C on A, B switched off while still
    /// registered (or removed, or not available), C there: A's 503 lands on C with one write, recording nothing of B. A
    /// genuine readiness failure of B still fails the hop, before any write.
    #[tokio::test]
    async fn a_mid_turn_hop_passes_over_an_absent_candidate() {
        let overloaded = || {
            let mut error = ProviderError::new(ErrorKind::Transient, mixdog_core_api::domain::provider::DeliveryState::NotSent);
            error.status = Some(503);
            error.message = "overloaded".into();
            error
        };
        let switched_off = || {
            let mut host = stub(fresh(), &[], &[]);
            host.config.insert("providers".into(), json!({ "openai-oauth": { "enabled": false } }));
            host
        };
        let removed = || {
            let mut host = stub(fresh(), &[], &[]);
            host.init_errors = vec![("openai-oauth", "[provider] Failed to init \"openai-oauth\": unknown enabled provider: openai-oauth".to_owned())];
            host
        };
        for (absent, host) in [("switched off", switched_off()), ("removed", removed()), ("unavailable", stub(fresh(), &["openai-oauth"], &[]))] {
            let (route, host) = hop_over(host);
            let RouteDecision::Switch(switch) = route.decide(overloaded(), None).await else { panic!("{absent}: the hop runs") };
            assert_eq!(switch.model, "gem", "{absent}");
            let writes = host.writes.lock().unwrap();
            assert_eq!((writes.len(), writes[0].1.index), (1, 2), "{absent}");
            assert_eq!(writes[0].1.failures.iter().map(|f| f["model"].as_str().unwrap()).collect::<Vec<_>>(), ["fable"], "{absent}");
        }

        let mut broken = stub(fresh(), &[], &[]);
        broken.init_errors = vec![("openai-oauth", "the token store is locked".to_owned())];
        let (route, host) = hop_over(broken);
        let RouteDecision::Fail(message) = route.decide(overloaded(), None).await else { panic!("the hop fails") };
        assert_eq!(message, "the token store is locked");
        assert!(host.writes.lock().unwrap().is_empty());
    }

    /// A mid-turn failure whose every remaining fallback is absent keeps the turn's own error, with the fallback that was skipped
    /// and why on a line beside it.
    #[tokio::test]
    async fn a_mid_turn_failure_with_no_present_fallback_keeps_its_error_and_names_the_skipped_one() {
        let mut error = ProviderError::new(ErrorKind::Transient, mixdog_core_api::domain::provider::DeliveryState::NotSent);
        error.status = Some(503);
        error.message = "overloaded".into();
        let (route, host) = hop_over(stub(fresh(), &["openai-oauth", "google"], &[]));
        let RouteDecision::Surface(surface) = route.decide(error, None).await else { panic!("the original failure surfaces") };
        assert_eq!(surface.error.status, Some(503));
        assert!(surface.error.message.starts_with("overloaded\nSkipped fallback "), "{}", surface.error.message);
        assert!(surface.error.message.contains("OpenAI OAuth is not available"), "{}", surface.error.message);
        assert_eq!(surface.error.message.matches("Skipped fallback ").count(), 2, "every skipped fallback is named: {}", surface.error.message);
        assert!(host.writes.lock().unwrap().is_empty());
    }

    /// An absent first fallback does not end the chain: the later one that is connected takes the turn.
    #[tokio::test]
    async fn an_absent_fallback_is_passed_over_for_a_later_present_one() {
        let mut error = ProviderError::new(ErrorKind::Transient, mixdog_core_api::domain::provider::DeliveryState::NotSent);
        error.status = Some(503);
        error.message = "overloaded".into();
        let (route, host) = hop_over(stub(fresh(), &["openai-oauth"], &[]));
        let RouteDecision::Switch(switch) = route.decide(error, None).await else { panic!("the present fallback takes the turn") };
        assert_eq!(switch.model, "gem");
        assert_eq!(host.writes.lock().unwrap().len(), 1);
    }

    fn quota_out() -> ProviderError {
        let mut error = ProviderError::new(ErrorKind::QuotaExhausted, mixdog_core_api::domain::provider::DeliveryState::NotSent);
        error.message = "All connected accounts have exhausted their quota.".into();
        error
    }

    /// A failure that moves on (every account of the primary out before anything was sent) lands on a fallback an agent
    /// outside the loop serves as on a provider's: the session is written onto it in one update with the failure recorded,
    /// and the run is told to leave the loop for that route, with the switch to tell.
    #[tokio::test]
    async fn a_failure_that_moves_on_hands_the_turn_to_a_fallback_an_agent_serves() {
        let mut host = stub(fresh(), &[], &[]);
        host.agents = vec![("openai-oauth", Ok(()))];
        let (route, host) = hop_over(host);
        let RouteDecision::Outside(outside) = route.decide(quota_out(), None).await else { panic!("the agent takes the turn") };
        assert_eq!((outside.header["provider"].as_str(), outside.header["model"].as_str()), (Some("openai-oauth"), Some("astra")));
        assert_eq!(outside.notice, "fable usage limit reached — switched to astra.");
        let writes = host.writes.lock().unwrap();
        assert_eq!((writes.len(), writes[0].1.index), (1, 1));
        let failures: Vec<(&str, &str)> = writes[0].1.failures.iter().map(|f| (f["model"].as_str().unwrap(), f["kind"].as_str().unwrap())).collect();
        assert_eq!(failures, [("fable", "quota_exhausted")]);
    }

    /// A fallback whose agent cannot run now is skipped as an absent provider is, named with what the agent says of its
    /// state; a later route that is there still takes the turn.
    #[tokio::test]
    async fn a_fallback_whose_agent_cannot_run_is_skipped_with_the_agents_own_state() {
        let refusal = "Antigravity is signed out. Sign in to it in Settings.";
        let mut host = stub(fresh(), &["google"], &[]);
        host.agents = vec![("openai-oauth", Err(refusal.to_owned()))];
        let (route, host) = hop_over(host);
        let RouteDecision::Surface(surface) = route.decide(quota_out(), None).await else { panic!("the failure surfaces") };
        let lines: Vec<&str> = surface.error.message.lines().collect();
        let skipped = format!("Skipped fallback astra: {refusal}");
        assert_eq!(lines[..2], ["All connected accounts have exhausted their quota.", skipped.as_str()], "{lines:?}");
        assert!(host.writes.lock().unwrap().is_empty());

        let mut host = stub(fresh(), &[], &[]);
        host.agents = vec![("openai-oauth", Err(refusal.to_owned()))];
        let (route, _) = hop_over(host);
        let RouteDecision::Switch(switch) = route.decide(quota_out(), None).await else { panic!("the later provider takes the turn") };
        assert_eq!(switch.model, "gem");
    }

    /// Only the reason of the current diversion counts: an older unavailable or quota entry of the primary does not bring the
    /// session back once the primary's newest failure is one the evidence does not speak to.
    #[tokio::test]
    async fn an_older_reason_does_not_override_the_current_diversion() {
        for older in [PROVIDER_UNAVAILABLE, "quota_exhausted"] {
            let mut diverted = session("openai-oauth", "astra", older);
            diverted["routeFallbackFailures"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "provider": "anthropic-oauth", "model": "fable", "kind": "permission", "error": "denied" }));
            let (route, host) = hop(diverted, &[("fable", Eligible), ("astra", Eligible)]);
            assert!(route.reconsider(None).await.unwrap().is_none(), "{older}");
            assert!(host.writes.lock().unwrap().is_empty());
        }
    }

    /// A switch back whose session write went through but whose later step failed is optional: the session is written back
    /// onto the route the run stands on, with the hop fields it had, the run stays there, and this run does not try again.
    #[tokio::test]
    async fn a_failed_switch_back_puts_the_session_back_on_the_route_in_use() {
        let diverted = session("openai-oauth", "astra", PROVIDER_UNAVAILABLE);
        let mut h = stub(diverted.clone(), &[], &["the wire could not be pinned"]);
        h.mutate_session_on_hop = true;
        let (route, host) = hop_over(h);
        assert!(route.reconsider(None).await.expect("put back, the run goes on").is_none());
        {
            let writes = host.writes.lock().unwrap();
            assert_eq!(writes.len(), 2, "the switch back, then the restore");
            let (restored, write) = &writes[1];
            assert_eq!((restored["provider"].as_str(), restored["model"].as_str()), (Some("openai-oauth"), Some("astra")));
            assert_eq!(
                (write.index, write.primary.as_ref(), &write.failures),
                (1, diverted.get("routeFallbackPrimary"), diverted["routeFallbackFailures"].as_array().unwrap())
            );
        }
        assert!(route.reconsider(None).await.unwrap().is_none(), "not tried again this run");
        assert_eq!(host.writes.lock().unwrap().len(), 2);
    }

    /// When the restore fails too the session names a route the run is not on: the turn ends with both failures.
    #[tokio::test]
    async fn a_switch_back_whose_restore_fails_ends_the_turn() {
        let mut h = stub(session("openai-oauth", "astra", PROVIDER_UNAVAILABLE), &[], &["the wire could not be pinned", "the store is gone"]);
        h.mutate_session_on_hop = true;
        let (route, host) = hop_over(h);
        let failure = route.reconsider(None).await.err().expect("the turn ends");
        assert!(failure.starts_with("the wire could not be pinned") && failure.ends_with("the store is gone"), "{failure}");
        assert_eq!(host.writes.lock().unwrap().len(), 2);
    }

    /// After the primary recovers the session goes back to it even though the fallback it stands on is healthy: one write,
    /// the primary's quota entry kept as the mark of the diversion, and nothing deliberate (no primary rewrite).
    #[tokio::test]
    async fn a_recovered_primary_is_preferred_over_a_healthy_fallback() {
        let (hop, host) = hop(session("openai-oauth", "astra", "quota_exhausted"), &[("fable", Eligible), ("astra", Eligible)]);
        let switch = hop.reconsider(None).await.unwrap().expect("back to the primary");
        assert_eq!(switch.model, "fable");
        assert!(switch.notice.contains("available again"), "{}", switch.notice);
        let writes = host.writes.lock().unwrap();
        assert_eq!(writes.len(), 1);
        let (route, write) = &writes[0];
        assert_eq!((route["model"].as_str(), write.index, write.primary.is_none(), write.failures.len()), (Some("fable"), 0, true, 1));
    }

    /// While the primary is proven exhausted the healthy fallback stays; no evidence (`Unknown`) moves nothing either way.
    #[tokio::test]
    async fn a_primary_not_proven_eligible_leaves_the_session_where_it_is() {
        for primary in [Exhausted, Unknown] {
            let (hop, host) = hop(session("openai-oauth", "astra", "quota_exhausted"), &[("fable", primary), ("astra", Eligible)]);
            assert!(hop.reconsider(None).await.unwrap().is_none(), "{primary:?}");
            assert!(host.writes.lock().unwrap().is_empty());
        }
    }

    /// A fallback that is itself known out hands on to the first eligible route below it, in configured order, with no send.
    #[tokio::test]
    async fn an_exhausted_current_route_goes_on_to_the_next_eligible_one() {
        let (hop, host) = hop(session("openai-oauth", "astra", "quota_exhausted"), &[("fable", Exhausted), ("astra", Exhausted), ("gem", Eligible)]);
        let switch = hop.reconsider(None).await.unwrap().expect("on to the next");
        assert_eq!(switch.model, "gem");
        assert_eq!(host.writes.lock().unwrap()[0].1.index, 2);
    }

    /// A session a quota did not divert, and one with a pick held for the next turn, are never reconsidered.
    #[tokio::test]
    async fn deliberate_and_non_quota_routes_are_left_alone() {
        let (overloaded, _) = hop(session("openai-oauth", "astra", "overloaded"), &[("fable", Eligible), ("astra", Eligible)]);
        assert!(overloaded.reconsider(None).await.unwrap().is_none(), "left for a reason eligibility does not speak to");
        let mut held = session("openai-oauth", "astra", "quota_exhausted");
        held["pendingRoute"] = json!({ "provider": "openai-oauth", "model": "astra" });
        let (held_hop, host) = hop(held, &[("fable", Eligible), ("astra", Eligible)]);
        assert!(held_hop.reconsider(None).await.unwrap().is_none());
        assert!(host.writes.lock().unwrap().is_empty());
    }

    /// Hopping between two providers that share the same plain model display label disambiguates both sides as
    /// `<Provider> · <Model>` in `decide`, `outside`, `unavailable`, `reconsider`, and `annotate`, while leaving
    /// non-colliding cross-model notices unchanged.
    #[tokio::test]
    async fn colliding_model_labels_across_providers_are_disambiguated_in_notices_and_annotate() {
        let same_model_config = json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead",
                "provider": "anthropic-oauth",
                "model": "claude-opus-5.5",
                "fallbacks": [
                    { "provider": "cursor-oauth", "model": "claude-opus-5.5" },
                    { "provider": "acp-antigravity-cli", "model": "claude-opus-5.5" },
                    { "provider": "openai-oauth", "model": "GPT-6.2-Astra" },
                ],
            }],
        })
        .as_object()
        .unwrap()
        .clone();
        let make_host = |session: Value, gone: &[&'static str]| {
            let mut host = stub(session, gone, &[]);
            host.config = same_model_config.clone();
            host.agents = vec![("acp-antigravity-cli", Ok(()))];
            host.model_labels = HashMap::from([("claude-opus-5.5", "Claude Opus 5.5")]);
            host.provider_labels = HashMap::from([("acp-antigravity-cli", "Antigravity")]);
            host
        };

        // 1. decide (loop -> loop) with colliding model label across providers.
        let primary = json!({ "id": "sess_x", "agent": "mixy", "provider": "anthropic-oauth", "model": "claude-opus-5.5" });
        let (route, _) = hop_over(make_host(primary.clone(), &[]));
        let RouteDecision::Switch(switch) = route.decide(quota_out(), None).await else { panic!("hop to cursor-oauth") };
        assert_eq!(switch.notice, "Anthropic OAuth · Claude Opus 5.5 usage limit reached — switched to Cursor OAuth · Claude Opus 5.5.");

        // 2. decide -> outside (loop -> ACP agent) with colliding model label across providers.
        let (route, _) = hop_over(make_host(primary.clone(), &["cursor-oauth"]));
        let RouteDecision::Outside(outside) = route.decide(quota_out(), None).await else { panic!("hop to ACP agent") };
        assert_eq!(outside.notice, "Anthropic OAuth · Claude Opus 5.5 usage limit reached — switched to Antigravity · Claude Opus 5.5.");

        // 3. unavailable (preflight hop) with colliding model label across providers.
        let (route, _) = hop_over(make_host(primary.clone(), &["anthropic-oauth"]));
        assert!(route.unavailable("signed out").await.unwrap().is_some());
        let switch = route.reconsider(None).await.unwrap().expect("pending preflight switch");
        assert_eq!(switch.notice, "Anthropic OAuth · Claude Opus 5.5 unavailable — switched to Cursor OAuth · Claude Opus 5.5.");

        // 4. reconsider switching back with colliding model label across providers.
        let diverted = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "cursor-oauth",
            "model": "claude-opus-5.5",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "claude-opus-5.5" },
            "routeFallbackFailures": [{ "provider": "anthropic-oauth", "model": "claude-opus-5.5", "kind": "quota_exhausted", "error": "out" }],
        });
        let mut host = make_host(diverted, &[]);
        host.evidence = HashMap::from([("claude-opus-5.5", Eligible)]);
        let (route, _) = hop_over(host);
        let switch = route.reconsider(None).await.unwrap().expect("switch back to primary");
        assert_eq!(switch.notice, "Anthropic OAuth · Claude Opus 5.5 is available again — switched back from Cursor OAuth · Claude Opus 5.5.");

        // 5. annotate disambiguates colliding providers while leaving distinct model labels plain.
        let exhausted = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "GPT-6.2-Astra",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "claude-opus-5.5" },
            "routeFallbackFailures": [
                { "provider": "anthropic-oauth", "model": "claude-opus-5.5", "kind": "quota_exhausted", "error": "quota A" },
                { "provider": "cursor-oauth", "model": "claude-opus-5.5", "kind": "quota_exhausted", "error": "quota B" },
                { "provider": "acp-antigravity-cli", "model": "claude-opus-5.5", "kind": "quota_exhausted", "error": "quota C" },
            ],
        });
        let (route, _) = hop_over(make_host(exhausted, &[]));
        let RouteDecision::Surface(surface) = route.decide(quota_out(), None).await else { panic!("exhausted chain surfaces") };
        assert!(
            surface.error.message.contains(
                "Anthropic OAuth · Claude Opus 5.5: quota A; Cursor OAuth · Claude Opus 5.5: quota B; Antigravity · Claude Opus 5.5: quota C; GPT-6.2-Astra:"
            ),
            "{}",
            surface.error.message
        );

        // 6. Cross-model hop keeps plain labels unchanged.
        let (route, _) = hop_over(make_host(primary, &["cursor-oauth", "acp-antigravity-cli"]));
        let RouteDecision::Switch(switch) = route.decide(quota_out(), None).await else { panic!("hop to GPT-6.2-Astra") };
        assert_eq!(switch.notice, "Claude Opus 5.5 usage limit reached — switched to GPT-6.2-Astra.");
    }

    #[tokio::test]
    async fn quota_exhausted_is_tracked_in_failed_here_preventing_same_turn_cycle() {
        let mut host = stub(fresh(), &[], &[]);
        // Optimistic/stale eligibility reports the primary as Eligible even though it just returned QuotaExhausted.
        host.evidence = HashMap::from([("fable", Eligible), ("astra", Eligible)]);
        let (route, host) = hop_over(host);
        let RouteDecision::Switch(switch) = route.decide(quota_out(), None).await else {
            panic!("primary quota exhaustion must hop to secondary");
        };
        assert_eq!(switch.model, "astra");
        assert!(route.reconsider(None).await.unwrap().is_none(), "same turn must never cycle back to a route that already failed with QuotaExhausted");
        assert_eq!(host.writes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn preflight_select_skips_exhausted_and_unauthenticated_primary_to_http_or_acp_fallback() {
        // 1. Exhausted HTTP primary skips directly to ready HTTP fallback with structured route_switch event.
        let mut host = stub(fresh(), &[], &[]);
        host.evidence = HashMap::from([("fable", Exhausted), ("astra", Eligible)]);
        let events: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink = events.clone();
        let route = RouteHop::new(Arc::new(host)).with_on_route_switch(move |ev| sink.lock().unwrap().push(ev));
        assert_eq!(route.current_readiness().await, Some(RouteReadiness::Exhausted));
        let landing =
            route.preflight_select(PreflightReason::QuotaExhausted { refusal: "quota exhausted".into() }).await.unwrap().expect("should land on secondary");
        assert!(matches!(landing, PreflightLanding::Loop(_)));
        let recorded = events.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!((recorded[0].phase, recorded[0].kind.as_str(), recorded[0].runner), ("preflight", "quota_exhausted", "loop"));
        assert_eq!((recorded[0].from_model.as_str(), recorded[0].to_model.as_str()), ("fable", "astra"));
        assert_eq!(recorded[0].notice, "fable usage limit reached — switched to astra.");

        // 2. Unauthenticated HTTP primary skips directly to a ready ACP agent route before sending.
        let mut host = stub(fresh(), &["anthropic-oauth", "google"], &[]);
        host.agents = vec![("openai-oauth", Ok(()))];
        let events2: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink2 = events2.clone();
        let route = RouteHop::new(Arc::new(host)).with_on_route_switch(move |ev| sink2.lock().unwrap().push(ev));
        assert!(matches!(route.current_readiness().await, Some(RouteReadiness::Unauthenticated { .. })));
        let landing = route
            .preflight_select(PreflightReason::Unauthenticated { refusal: "not signed in".into() })
            .await
            .unwrap()
            .expect("should land on ready ACP agent");
        let PreflightLanding::Outside(outside) = landing else { panic!("expected ACP outside landing") };
        assert_eq!(outside.header["model"], "astra");
        assert_eq!(outside.notice, "fable sign-in required — switched to astra.");
        let recorded2 = events2.lock().unwrap();
        assert_eq!(recorded2.len(), 1);
        assert_eq!((recorded2[0].phase, recorded2[0].kind.as_str(), recorded2[0].runner), ("preflight", "auth", "acp"));
    }

    #[tokio::test]
    async fn preflight_fails_cleanly_when_primary_exhausted_and_no_fallback_is_ready() {
        let mut host = stub(fresh(), &["openai-oauth", "google"], &[]);
        host.evidence = HashMap::from([("fable", Exhausted)]);
        let (route, host) = hop_over(host);
        let decision = route.preflight(None, false, false).await.unwrap();
        let PreflightDecision::Failed(failure) = decision else {
            panic!("exhausted primary with no ready fallback must fail cleanly instead of sending");
        };
        assert!(matches!(failure.reason, PreflightReason::QuotaExhausted { .. }));
        assert_eq!(failure.provider, "anthropic-oauth");
        assert_eq!(failure.skipped.len(), 2);
        assert!(host.writes.lock().unwrap().is_empty(), "must not mutate session when no fallback is ready");
    }

    #[tokio::test]
    async fn unknown_acp_primary_falls_back_to_ready_http_route_and_reports_acp_error_when_none_ready() {
        let cfg = json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead",
                "provider": "acp-removed",
                "model": "default",
                "fallbacks": [{ "provider": "openai-oauth", "model": "astra" }],
            }],
        })
        .as_object()
        .unwrap()
        .clone();
        let primary = json!({ "id": "sess_x", "agent": "mixy", "provider": "acp-removed", "model": "default" });

        // 1. Unknown `acp-*` primary falls back cleanly to ready HTTP fallback.
        let mut host = stub(primary.clone(), &[], &[]);
        host.config = cfg.clone();
        host.init_errors = vec![("acp-removed", "ACP agent route \"acp-removed\" is not configured or unavailable in Settings.".into())];
        let (route, _) = hop_over(host);
        let decision = route.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::SwitchLoop(_)), "unknown acp-* primary must hop to ready HTTP fallback");
        let switch = route.reconsider(None).await.unwrap().expect("pending switch");
        assert_eq!(switch.model, "astra");

        // 2. When no fallback is ready, terminal failure preserves accurate ACP routing wording.
        let mut host_none = stub(primary, &["openai-oauth"], &[]);
        host_none.config = cfg;
        host_none.init_errors = vec![("acp-removed", "ACP agent route \"acp-removed\" is not configured or unavailable in Settings.".into())];
        let (route_none, _) = hop_over(host_none);
        let PreflightDecision::Failed(failure) = route_none.preflight(None, false, false).await.unwrap() else {
            panic!("expected terminal preflight failure when no fallback is ready");
        };
        let PreflightReason::Unavailable { refusal } = failure.reason else { panic!("expected Unavailable, got {:?}", failure.reason) };
        assert!(refusal.contains("ACP agent route"), "{refusal}");
    }

    #[tokio::test]
    async fn cross_runner_recovery_works_in_both_http_and_acp_directions() {
        // 1. HTTP primary -> ACP fallback -> HTTP primary recovers.
        let cfg_http_primary = json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead",
                "provider": "anthropic-oauth",
                "model": "fable",
                "fallbacks": [{ "provider": "acp-codex", "model": "default" }],
            }],
        })
        .as_object()
        .unwrap()
        .clone();
        let on_acp = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "acp-codex",
            "model": "default",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{ "provider": "anthropic-oauth", "model": "fable", "kind": "quota_exhausted", "error": "out" }],
        });
        let mut host1 = stub(on_acp, &[], &[]);
        host1.config = cfg_http_primary;
        host1.agents = vec![("acp-codex", Ok(()))];
        host1.evidence = HashMap::from([("fable", Eligible)]);
        let ev1: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink1 = ev1.clone();
        let route1 = RouteHop::new(Arc::new(host1)).with_on_route_switch(move |ev| sink1.lock().unwrap().push(ev));
        let decision1 = route1.preflight(None, true, false).await.unwrap();
        assert!(matches!(decision1, PreflightDecision::SwitchLoop(_)), "healthy ACP fallback must recover to HTTP primary");
        let switch1 = route1.reconsider(None).await.unwrap().expect("pending recovery switch");
        assert_eq!(switch1.model, "fable");
        assert!(switch1.notice.contains("is available again — switched back from"), "{}", switch1.notice);
        let recorded1 = ev1.lock().unwrap();
        assert_eq!(recorded1.len(), 1);
        assert_eq!((recorded1[0].phase, recorded1[0].kind.as_str(), recorded1[0].runner), ("recovery", "recovered", "loop"));

        // 2. ACP primary -> HTTP fallback -> ACP primary recovers (from auth failure).
        let cfg_acp_primary = json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead",
                "provider": "acp-codex",
                "model": "default",
                "fallbacks": [{ "provider": "openai-oauth", "model": "astra" }],
            }],
        })
        .as_object()
        .unwrap()
        .clone();
        let on_http = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "astra",
            "routeFallbackPrimary": { "provider": "acp-codex", "model": "default" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{ "provider": "acp-codex", "model": "default", "kind": "auth", "error": "signed out" }],
        });
        let mut host2 = stub(on_http, &[], &[]);
        host2.config = cfg_acp_primary;
        host2.agents = vec![("acp-codex", Ok(()))];
        let ev2: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink2 = ev2.clone();
        let route2 = RouteHop::new(Arc::new(host2)).with_on_route_switch(move |ev| sink2.lock().unwrap().push(ev));
        let decision2 = route2.preflight(None, false, false).await.unwrap();
        let PreflightDecision::SwitchOutside(outside) = decision2 else {
            panic!("healthy HTTP fallback must recover to ACP primary");
        };
        assert_eq!(outside.header["provider"], "acp-codex");
        assert!(outside.notice.contains("is available again — switched back from"), "{}", outside.notice);
        let recorded2 = ev2.lock().unwrap();
        assert_eq!(recorded2.len(), 1);
        assert_eq!((recorded2[0].phase, recorded2[0].kind.as_str(), recorded2[0].runner), ("recovery", "recovered", "acp"));
    }

    #[tokio::test]
    async fn final_usable_route_reports_no_remaining_fallbacks_when_later_entries_are_unusable() {
        let mut host = stub(fresh(), &["openai-oauth"], &[]);
        host.evidence = HashMap::from([("gem", Exhausted)]);
        let (route, _) = hop_over(host);
        assert!(!route.refresh_has_fallbacks().await, "unusable/exhausted configured fallbacks must not shorten the final usable route's retry budget");
        assert!(!route.has_remaining_fallbacks());
    }

    #[tokio::test]
    async fn removed_custom_provider_is_classified_as_unavailable_not_unauthenticated() {
        let cfg = json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead",
                "provider": "custom-removed",
                "model": "m-old",
                "fallbacks": [{ "provider": "openai-oauth", "model": "astra" }],
            }],
        })
        .as_object()
        .unwrap()
        .clone();
        let primary = json!({ "id": "sess_x", "agent": "mixy", "provider": "custom-removed", "model": "m-old" });
        let mut host = stub(primary, &["custom-removed"], &[]);
        host.config = cfg;
        let events: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink = events.clone();
        let route = RouteHop::new(Arc::new(host)).with_on_route_switch(move |ev| sink.lock().unwrap().push(ev));
        assert!(matches!(route.current_readiness().await, Some(RouteReadiness::Unavailable { .. })));
        let decision = route.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::SwitchLoop(_)));
        let recorded = events.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].kind, PROVIDER_UNAVAILABLE);
        assert_eq!(recorded[0].notice, "m-old unavailable — switched to astra.");
    }

    #[tokio::test]
    async fn route_switch_events_emit_for_fallback_and_recovery_and_track_remaining_fallbacks() {
        // 1. Primary (fable) has usable fallbacks (astra, gem) and emits a fallback event on hop 1.
        let events: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink = events.clone();
        let host = stub(fresh(), &[], &[]);
        let route = RouteHop::new(Arc::new(host)).with_on_route_switch(move |ev| sink.lock().unwrap().push(ev));
        assert!(route.refresh_has_fallbacks().await, "primary has fallbacks astra and gem");
        assert!(route.has_remaining_fallbacks());
        assert!(matches!(route.decide(quota_out(), None).await, RouteDecision::Switch(_)));
        let ev1 = events.lock().unwrap();
        assert_eq!(ev1.len(), 1);
        assert_eq!((ev1[0].phase, ev1[0].to_model.as_str()), ("fallback", "astra"));

        // 2. On astra (fable failed), gem still remains; hopping astra -> gem emits a second fallback event.
        let events2: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let sink2 = events2.clone();
        let host2 = stub(session("openai-oauth", "astra", "quota_exhausted"), &[], &[]);
        let route2 = RouteHop::new(Arc::new(host2)).with_on_route_switch(move |ev| sink2.lock().unwrap().push(ev));
        assert!(route2.refresh_has_fallbacks().await, "gem still remains after hopping to astra");
        assert!(matches!(route2.decide(quota_out(), None).await, RouteDecision::Switch(_)));
        let ev2 = events2.lock().unwrap();
        assert_eq!(ev2.len(), 1);
        assert_eq!((ev2[0].phase, ev2[0].to_model.as_str()), ("fallback", "gem"));

        // 3. On final route (gem) with fable and astra failed, no remaining fallbacks exist.
        let on_gem = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "google",
            "model": "gem",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 2,
            "routeFallbackFailures": [
                { "provider": "anthropic-oauth", "model": "fable", "kind": "quota_exhausted", "error": "limit" },
                { "provider": "openai-oauth", "model": "astra", "kind": "quota_exhausted", "error": "limit" },
            ],
        });
        let route3 = RouteHop::new(Arc::new(stub(on_gem, &[], &[])));
        assert!(!route3.refresh_has_fallbacks().await, "last route has no remaining fallbacks");
        assert!(!route3.has_remaining_fallbacks());

        // 4. Recovery event on a fresh turn when primary recovers.
        let rec_events: Arc<Mutex<Vec<RouteSwitchEvent>>> = Arc::default();
        let rec_sink = rec_events.clone();
        let mut rec_host = stub(session("openai-oauth", "astra", "quota_exhausted"), &[], &[]);
        rec_host.evidence = HashMap::from([("fable", Eligible), ("astra", Eligible)]);
        let rec_route = RouteHop::new(Arc::new(rec_host)).with_on_route_switch(move |ev| rec_sink.lock().unwrap().push(ev));
        assert!(rec_route.reconsider(None).await.unwrap().is_some());
        let rec = rec_events.lock().unwrap();
        assert_eq!(rec.len(), 1);
        assert_eq!((rec[0].phase, rec[0].kind.as_str(), rec[0].to_model.as_str()), ("recovery", "recovered", "fable"));
        assert!(rec[0].notice.contains("available again"));
    }

    struct TestCancel {
        cancelled: AtomicBool,
        notify: tokio::sync::Notify,
    }

    impl TestCancel {
        fn new() -> Arc<Self> {
            Arc::new(Self { cancelled: AtomicBool::new(false), notify: tokio::sync::Notify::new() })
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
            self.notify.notify_waiters();
        }
    }

    #[async_trait]
    impl CancelSignal for TestCancel {
        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
        async fn cancelled(&self) {
            if self.is_cancelled() {
                return;
            }
            self.notify.notified().await;
        }
    }

    #[tokio::test]
    async fn preflight_cancellation_aborts_cold_acp_fallback_probe_immediately() {
        let wait = Arc::new(tokio::sync::Notify::new());
        let mut host = stub(fresh(), &["anthropic-oauth", "google"], &[]);
        host.agents = vec![("openai-oauth", Ok(()))];
        host.agent_wait = Some(wait);
        let cancel = TestCancel::new();
        let route = RouteHop::new(Arc::new(host)).with_cancel(cancel.clone());
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            trigger.cancel();
        });
        let decision = tokio::time::timeout(std::time::Duration::from_secs(1), route.preflight(None, false, false))
            .await
            .expect("cancellation must abort cold ACP fallback probe promptly")
            .unwrap();
        assert!(matches!(decision, PreflightDecision::Cancelled));
    }

    #[tokio::test]
    async fn removed_custom_primary_with_no_ready_fallback_avoids_signin_wording() {
        let cfg = json!({
            "default": "workflow-lead",
            "presets": [{
                "id": "workflow-lead",
                "provider": "custom-removed",
                "model": "m-old",
                "fallbacks": [{ "provider": "openai-oauth", "model": "astra" }],
            }],
        })
        .as_object()
        .unwrap()
        .clone();
        let primary = json!({ "id": "sess_x", "agent": "mixy", "provider": "custom-removed", "model": "m-old" });
        let mut host = stub(primary, &["custom-removed", "openai-oauth"], &[]);
        host.config = cfg;
        let (route, _) = hop_over(host);
        let PreflightDecision::Failed(failure) = route.preflight(None, false, false).await.unwrap() else {
            panic!("expected terminal preflight failure when no fallback is ready");
        };
        let PreflightReason::Unavailable { refusal } = failure.reason else {
            panic!("removed custom primary must be Unavailable, got {:?}", failure.reason);
        };
        assert!(!refusal.contains("not signed in") && !refusal.contains("no API key"), "{refusal}");
        assert!(refusal.contains("custom-removed"), "{refusal}");
    }

    #[tokio::test]
    async fn mid_turn_decide_skips_exhausted_and_too_small_candidates_and_hops_on_transport_faults() {
        use mixdog_core_api::domain::provider::{DeliveryState, TransportFault};

        // 1. A -> B(exhausted) -> C(healthy) skips B directly and lands on C without announcing B.
        let mut host = stub(fresh(), &[], &[]);
        host.evidence = HashMap::from([("astra", Exhausted), ("gem", Eligible)]);
        let (route, writes_host) = hop_over(host);
        let RouteDecision::Switch(switch) = route.decide(quota_out(), None).await else {
            panic!("must skip exhausted B and land on healthy C");
        };
        assert_eq!(switch.model, "gem");
        assert!(!switch.notice.contains("astra"), "must not announce skipped exhausted B: {}", switch.notice);
        assert_eq!(writes_host.writes.lock().unwrap()[0].1.index, 2);

        // 2. ContextOverflow A(200k) -> B(128k) -> C(1M) skips too-small B and lands on larger C.
        let mut ctx_host = stub(fresh(), &[], &[]);
        ctx_host.windows = HashMap::from([("fable", 200_000), ("astra", 128_000), ("gem", 1_000_000)]);
        let (ctx_route, _) = hop_over(ctx_host);
        let overflow = ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::NotSent);
        let RouteDecision::Switch(ctx_switch) = ctx_route.decide(overflow, None).await else {
            panic!("context overflow must skip smaller B and hop to larger C");
        };
        assert_eq!(ctx_switch.model, "gem");

        // 3. Typed statusless endpoint-connect / transport failures enter fallback when exposure is clean,
        //    while exposed or untyped statusless transient errors stay.
        let connect_err = ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::NotSent);
        assert_eq!(route_fallback_verdict(&connect_err), RouteVerdict::Hop);
        let dns_err = ProviderError::transport(TransportFault::Dns, DeliveryState::NotSent);
        assert_eq!(route_fallback_verdict(&dns_err), RouteVerdict::Hop);
        let mut exposed_connect = ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::Accepted);
        exposed_connect.exposure.text_emitted = true;
        assert_eq!(route_fallback_verdict(&exposed_connect), RouteVerdict::Stay);
        let untyped_transient = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        assert_eq!(route_fallback_verdict(&untyped_transient), RouteVerdict::Stay);

        let (net_route, _) = hop_over(stub(fresh(), &[], &[]));
        let RouteDecision::Switch(net_switch) = net_route.decide(connect_err, None).await else {
            panic!("typed statusless connect fault must hop after retry exhaustion");
        };
        assert_eq!(net_switch.model, "astra");
    }

    #[tokio::test]
    async fn auth_diverted_http_primary_does_not_recover_on_unknown_without_credential_change() {
        // 1. Auth-diverted HTTP primary with Unknown eligibility and unchanged credential fingerprint stays off primary.
        let diverted = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "astra",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{
                "provider": "anthropic-oauth",
                "model": "fable",
                "kind": "auth",
                "error": "Invalid API key",
                "credentialFingerprint": "sha256:badkey",
            }],
        });
        let host = stub(diverted, &[], &[]);
        host.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:badkey".to_owned());
        let (route, host) = hop_over(host);
        assert!(route.reconsider(None).await.unwrap().is_none(), "unchanged credentials with Unknown eligibility must not bounce back to broken primary");
        assert!(host.writes.lock().unwrap().is_empty());

        // 2. Once credentials change (different fingerprint), the primary recovers cleanly.
        host.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:goodkey".to_owned());
        let switch = route.reconsider(None).await.unwrap().expect("changed credential evidence must allow recovery");
        assert_eq!(switch.model, "fable");

        // 3. Even with no fingerprint recorded at all, Unknown eligibility alone must not auto-recover an auth diversion.
        let (no_fp_route, no_fp_host) = hop(session("openai-oauth", "astra", "auth"), &[("fable", Unknown)]);
        assert!(no_fp_route.reconsider(None).await.unwrap().is_none());
        assert!(no_fp_host.writes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn transient_diversion_recovers_after_cooldown_expiry() {
        use mixdog_core_api::domain::provider::DeliveryState;

        let mut host = stub(fresh(), &[], &[]);
        host.mutate_session_on_hop = true;
        host.clock_ms.store(100_000, Ordering::Relaxed);
        let (route, host) = hop_over(host);

        let mut err = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
        err.status = Some(429);
        err.retry_after = Some(std::time::Duration::from_secs(30));
        err.message = "rate limited".into();

        let RouteDecision::Switch(switch) = route.decide(err, None).await else {
            panic!("429 must hop to secondary");
        };
        assert_eq!(switch.model, "astra");

        // On a fresh turn before cooldown expiry (t = 120_000 < 130_000), stay on secondary.
        host.clock_ms.store(120_000, Ordering::Relaxed);
        let turn2 = RouteHop::new(host.clone());
        assert!(turn2.reconsider(None).await.unwrap().is_none(), "must stay off primary before Retry-After cooldown expires");

        // Once cooldown expires (t = 130_000), recover back to primary.
        host.clock_ms.store(130_000, Ordering::Relaxed);
        let turn3 = RouteHop::new(host.clone());
        let recovered = turn3.reconsider(None).await.unwrap().expect("primary must recover after transient cooldown expires");
        assert_eq!(recovered.model, "fable");
    }

    #[tokio::test]
    async fn ordinary_mid_turn_hop_rolls_back_diverged_session_and_skips_usage_booking_on_failure() {
        let mut host = stub(fresh(), &[], &["surface rebuild failed"]);
        host.mutate_session_on_hop = true;
        let (route, host) = hop_over(host);
        let RouteDecision::Fail(err) = route.decide(quota_out(), Some(&Usage { input_tokens: 10, ..Usage::default() })).await else {
            panic!("failed hop must return RouteDecision::Fail");
        };
        assert_eq!(err, "surface rebuild failed");
        let live = host.session.lock().unwrap().clone();
        assert_eq!((live["provider"].as_str(), live["model"].as_str()), (Some("anthropic-oauth"), Some("fable")), "failed hop must roll back header");
        assert_eq!(live["routeFallbackIndex"], json!(0));
        assert_eq!(live["routeFallbackFailures"], json!([]));
        assert!(route.usage_segments(&Usage { input_tokens: 10, ..Usage::default() }, ("anthropic-oauth", "fable")).is_empty());
    }

    #[tokio::test]
    async fn runtime_hop_preserves_selected_context_window_on_route_fallback_primary() {
        let mut session = fresh();
        session["selectedContextWindow"] = json!(400_000);
        let (route, host) = hop_over(stub(session, &[], &[]));
        let RouteDecision::Switch(switch) = route.decide(quota_out(), None).await else {
            panic!("quota exhaustion must hop to secondary");
        };
        assert_eq!(switch.model, "astra");
        let writes = host.writes.lock().unwrap();
        let primary = writes[0].1.primary.as_ref().expect("primary snapshot recorded on first hop");
        assert_eq!(primary.get("selectedContextWindow"), Some(&json!(400_000)));
    }

    #[tokio::test]
    async fn preflight_rescan_respects_standing_auth_and_transient_cooldown_failures() {
        // 1. Primary failed with 401 (`auth`) and unchanged credential fingerprint; fallback B is now unavailable.
        //    Preflight rescan must skip primary A on Unknown eligibility and land on healthy fallback C (`gem`).
        let diverted_auth = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "astra",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{
                "provider": "anthropic-oauth",
                "model": "fable",
                "kind": "auth",
                "error": "401 Unauthorized",
                "credentialFingerprint": "sha256:badkey",
            }],
        });
        let host = stub(diverted_auth.clone(), &["openai-oauth"], &[]);
        host.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:badkey".to_owned());
        let (route, writes_host) = hop_over(host);
        let PreflightDecision::SwitchLoop(_) = route.preflight(None, false, false).await.unwrap() else {
            panic!("preflight must skip broken auth primary and land on fallback C");
        };
        assert_eq!(writes_host.writes.lock().unwrap()[0].0["model"], "gem");

        // Once credentials change, primary A is eligible again on preflight rescan.
        let host_changed = stub(diverted_auth, &["openai-oauth"], &[]);
        host_changed.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:newkey".to_owned());
        let (route_changed, writes_changed) = hop_over(host_changed);
        let PreflightDecision::SwitchLoop(_) = route_changed.preflight(None, false, false).await.unwrap() else {
            panic!("changed credentials must allow preflight rescan to recover primary");
        };
        assert_eq!(writes_changed.writes.lock().unwrap()[0].0["model"], "fable");

        // 2. Primary failed with 429/503 within cooldown; fallback B is now unavailable.
        //    Preflight rescan must skip primary A until cooldown expires, then allow it after expiry.
        let diverted_transient = json!({
            "id": "sess_x",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "astra",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{
                "provider": "anthropic-oauth",
                "model": "fable",
                "kind": "rate_limited",
                "error": "429 Too Many Requests",
                "failedAt": 100_000,
                "retryAfterMs": 60_000,
            }],
        });
        let host_cooling = stub(diverted_transient.clone(), &["openai-oauth"], &[]);
        host_cooling.clock_ms.store(120_000, Ordering::Relaxed);
        let (route_cooling, writes_cooling) = hop_over(host_cooling);
        let PreflightDecision::SwitchLoop(_) = route_cooling.preflight(None, false, false).await.unwrap() else {
            panic!("preflight must skip primary still in transient cooldown and land on C");
        };
        assert_eq!(writes_cooling.writes.lock().unwrap()[0].0["model"], "gem");

        let host_ready = stub(diverted_transient, &["openai-oauth"], &[]);
        host_ready.clock_ms.store(160_000, Ordering::Relaxed);
        let (route_ready, writes_ready) = hop_over(host_ready);
        let PreflightDecision::SwitchLoop(_) = route_ready.preflight(None, false, false).await.unwrap() else {
            panic!("primary must recover once transient cooldown expires");
        };
        assert_eq!(writes_ready.writes.lock().unwrap()[0].0["model"], "fable");
    }

    #[tokio::test]
    async fn failed_recovery_and_quota_diversion_preserve_effective_effort_and_failed_here() {
        // 1. Failed recovery where apply_hop already preserved/rolled back the header must NOT issue a redundant
        //    put_back apply_hop that clears `effectiveEffort`.
        let mut diverted = session("openai-oauth", "astra", "quota_exhausted");
        diverted["effectiveEffort"] = json!("high");
        let mut host = stub(diverted, &[], &["surface rebuild failed"]);
        host.evidence.insert("fable", Eligible);
        host.mutate_session_on_hop = false;
        let (route, host) = hop_over(host);
        assert!(route.reconsider(None).await.unwrap().is_none(), "failed recovery stays on current route");
        assert_eq!(host.writes.lock().unwrap().len(), 1, "put_back must not run a redundant apply_hop when header did not diverge");
        assert_eq!(host.session.lock().unwrap()["effectiveEffort"], json!("high"), "effectiveEffort must remain intact");

        // 2. Failed quota-diversion hop must not record the current route in `failed_here` before the hop succeeds.
        let mut q_host = stub(fresh(), &[], &["pin failed"]);
        q_host.evidence.insert("fable", Exhausted);
        q_host.evidence.insert("astra", Eligible);
        q_host.mutate_session_on_hop = false;
        let (q_route, q_host) = hop_over(q_host);
        assert!(q_route.reconsider(None).await.unwrap().is_none());
        let failed_models: Vec<String> = q_route.failed_here.lock().unwrap().iter().map(|v| text(v.get("model"))).collect();
        assert_eq!(failed_models, vec!["astra".to_owned()], "only failed target `astra` is recorded, not current `fable`");
        assert_eq!(q_host.writes.lock().unwrap().len(), 1, "no redundant put_back apply_hop");
    }

    #[tokio::test]
    async fn preflight_propagates_cancellation_from_post_switch_budget_refresh() {
        struct TokenSignal(mixdog_rt::CancellationToken);
        #[async_trait]
        impl CancelSignal for TokenSignal {
            fn is_cancelled(&self) -> bool {
                self.0.is_cancelled()
            }
            async fn cancelled(&self) {
                self.0.cancelled().await;
            }
        }

        struct BudgetCancelHost {
            session: Mutex<Value>,
            entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        }
        #[async_trait]
        impl HopHost for BudgetCancelHost {
            fn session(&self) -> Option<Value> {
                Some(self.session.lock().unwrap().clone())
            }
            fn config(&self) -> Obj {
                json!({
                    "default": "mixy",
                    "presets": [{
                        "id": "mixy",
                        "provider": "anthropic-oauth",
                        "model": "fable",
                        "fallbacks": [
                            { "provider": "openai-oauth", "model": "astra" },
                            { "provider": "acp-cold", "model": "default" },
                        ],
                    }],
                })
                .as_object()
                .cloned()
                .unwrap()
            }
            fn bots(&self) -> &dyn BotRoutes {
                &NoBots
            }
            fn model_label(&self, _: &str, model: &str) -> String {
                model.to_owned()
            }
            fn error_text(&self, error: &ProviderError) -> String {
                error.message.clone()
            }
            async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
                match provider {
                    "anthropic-oauth" => Ok(None),
                    "openai-oauth" => Ok(Some(Runner::Loop(Arc::new(MockProvider::new(Vec::new()))))),
                    "acp-cold" => Ok(Some(Runner::Agent)),
                    _ => Ok(None),
                }
            }
            async fn agent_ready(&self, provider: &str, _model: &str) -> Result<(), String> {
                if provider == "acp-cold" {
                    if let Some(tx) = self.entered.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    std::future::pending::<()>().await;
                }
                Ok(())
            }
            fn raw_context_window(&self, _: &str, _: &str, _: &Value) -> Option<u64> {
                Some(200_000)
            }
            async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
                let mut s = self.session.lock().unwrap();
                for (k, v) in route {
                    s[k] = v;
                }
                s["routeFallbacks"] = Value::Array(write.chain);
                if let Some(p) = write.primary {
                    s["routeFallbackPrimary"] = p;
                }
                s["routeFallbackIndex"] = json!(write.index);
                s["routeFallbackFailures"] = Value::Array(write.failures);
                Ok(Some(s.clone()))
            }
            fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
                (None, None)
            }
        }

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let token = mixdog_rt::CancellationToken::new();
        let host = Arc::new(BudgetCancelHost { session: Mutex::new(fresh()), entered: Mutex::new(Some(entered_tx)) });
        let route = RouteHop::new(host).with_cancel(Arc::new(TokenSignal(token.clone())));

        let cancel_task = tokio::spawn(async move {
            let _ = entered_rx.await;
            token.cancel();
        });
        let decision = route.preflight(None, false, false).await.unwrap();
        cancel_task.await.unwrap();
        assert!(
            matches!(decision, PreflightDecision::Cancelled),
            "cancellation during post-switch retry-budget refresh must return PreflightDecision::Cancelled"
        );
    }

    #[test]
    fn switched_off_non_auth_providers_do_not_show_sign_in_wording() {
        let config = json!({
            "providers": {
                "mixdog-local": { "enabled": false },
                "custom-free": { "type": "custom", "enabled": false, "auth": "none" },
            },
        })
        .as_object()
        .cloned()
        .unwrap();

        let local_msg = unavailable_provider_message(&config, "mixdog-local", None, true);
        assert!(local_msg.contains("turned off"), "{local_msg}");
        assert!(!local_msg.contains("Sign in") && !local_msg.contains("API key") && !local_msg.contains("/providers"), "{local_msg}");

        let custom_msg = unavailable_provider_message(&config, "custom-free", None, true);
        assert!(custom_msg.contains("turned off"), "{custom_msg}");
        assert!(!custom_msg.contains("Sign in") && !custom_msg.contains("API key") && !custom_msg.contains("/providers"), "{custom_msg}");
    }

    #[tokio::test]
    async fn oauth_auth_recovery_requires_credential_change_not_quota_eligible() {
        let base_session = json!({
            "id": "s1",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "astra",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{
                "provider": "anthropic-oauth",
                "model": "fable",
                "kind": "auth",
                "error": "401 Unauthorized",
                "credentialFingerprint": "sha256:tok-old",
            }],
        });

        // 1. Even when cached quota reports Eligible for the primary, an unchanged OAuth fingerprint must NOT clear
        //    the standing auth failure or bounce back to the broken primary.
        let mut host_unchanged = stub(base_session.clone(), &[], &[]);
        host_unchanged.evidence = [("fable", RouteEligibility::Eligible), ("astra", RouteEligibility::Eligible)].into_iter().collect();
        host_unchanged.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:tok-old".into());
        let (route_unchanged, writes_unchanged) = hop_over(host_unchanged);
        let decision = route_unchanged.preflight(None, false, false).await.unwrap();
        assert!(
            matches!(decision, PreflightDecision::StayLoop(_)),
            "quota Eligible alone must never clear a standing OAuth auth failure while credentials are unchanged"
        );
        assert!(writes_unchanged.writes.lock().unwrap().is_empty());

        // 2. After logout + fresh sign-in produces a distinct fingerprint, recovery succeeds even when quota is Unknown.
        let mut host_relogged = stub(base_session, &[], &[]);
        host_relogged.evidence = [("fable", RouteEligibility::Unknown), ("astra", RouteEligibility::Eligible)].into_iter().collect();
        host_relogged.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:tok-new".into());
        let (route_relogged, writes_relogged) = hop_over(host_relogged);
        let decision = route_relogged.preflight(None, false, false).await.unwrap();
        assert!(
            matches!(decision, PreflightDecision::SwitchLoop(_)),
            "distinct credential fingerprint after logout+relogin must recover primary even when quota is Unknown"
        );
        assert_eq!(writes_relogged.writes.lock().unwrap()[0].0["provider"], "anthropic-oauth");
    }

    #[tokio::test]
    async fn preflight_recovery_from_c_skips_intermediate_b_in_transient_cooldown() {
        let base_session = json!({
            "id": "s1",
            "agent": "mixy",
            "provider": "google",
            "model": "gem",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 2,
            "routeFallbackFailures": [
                {
                    "provider": "anthropic-oauth",
                    "model": "fable",
                    "kind": "quota_exhausted",
                    "error": "usage limit reached",
                },
                {
                    "provider": "openai-oauth",
                    "model": "astra",
                    "kind": "transient",
                    "error": "503 Service Unavailable",
                    "failedAt": 100_000,
                    "recoverAfterMs": 160_000,
                },
            ],
        });

        // While B's transient cooldown has not expired (now = 120_000 < 160_000) and primary A is still exhausted,
        // preflight recovery from C must stay on C and NOT jump back to cooling-down intermediate B.
        let mut host_cooling = stub(base_session.clone(), &[], &[]);
        host_cooling.evidence =
            [("fable", RouteEligibility::Exhausted), ("astra", RouteEligibility::Eligible), ("gem", RouteEligibility::Eligible)].into_iter().collect();
        host_cooling.clock_ms.store(120_000, Ordering::Relaxed);
        let (route_cooling, writes_cooling) = hop_over(host_cooling);
        let decision = route_cooling.preflight(None, false, false).await.unwrap();
        assert!(
            matches!(decision, PreflightDecision::StayLoop(_)),
            "recovery from C must not jump back to intermediate B while B's transient cooldown is active"
        );
        assert!(writes_cooling.writes.lock().unwrap().is_empty());

        // Once B's cooldown expires (now = 170_000 >= 160_000), recovery cleanly returns to eligible intermediate B.
        let mut host_expired = stub(base_session, &[], &[]);
        host_expired.evidence =
            [("fable", RouteEligibility::Exhausted), ("astra", RouteEligibility::Eligible), ("gem", RouteEligibility::Eligible)].into_iter().collect();
        host_expired.clock_ms.store(170_000, Ordering::Relaxed);
        let (route_expired, writes_expired) = hop_over(host_expired);
        let decision = route_expired.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::SwitchLoop(_)), "once intermediate B's transient cooldown expires, recovery from C should return to B");
        assert_eq!(writes_expired.writes.lock().unwrap()[0].0["provider"], "openai-oauth");
    }

    #[tokio::test]
    async fn preflight_propagates_cancellation_from_http_budget_refresh() {
        struct TokenSignal(mixdog_rt::CancellationToken);
        #[async_trait]
        impl CancelSignal for TokenSignal {
            fn is_cancelled(&self) -> bool {
                self.0.is_cancelled()
            }
            async fn cancelled(&self) {
                self.0.cancelled().await;
            }
        }

        struct HttpBudgetCancelHost {
            session: Mutex<Value>,
            hang_on: &'static str,
            entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        }

        #[async_trait]
        impl HopHost for HttpBudgetCancelHost {
            fn session(&self) -> Option<Value> {
                Some(self.session.lock().unwrap().clone())
            }
            fn config(&self) -> Obj {
                json!({
                    "default": "mixy",
                    "presets": [{
                        "id": "mixy",
                        "provider": "anthropic-oauth",
                        "model": "fable",
                        "fallbacks": [
                            { "provider": "openai-oauth", "model": "astra" },
                            { "provider": "gemini", "model": "gem" }
                        ]
                    }]
                })
                .as_object()
                .cloned()
                .unwrap()
            }
            fn bots(&self) -> &dyn BotRoutes {
                &NoBots
            }
            fn model_label(&self, _: &str, m: &str) -> String {
                m.to_owned()
            }
            fn error_text(&self, e: &ProviderError) -> String {
                e.message.clone()
            }
            async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
                if provider == "anthropic-oauth" {
                    return Ok(None);
                }
                if provider == "gemini" && self.hang_on == "runner" {
                    if let Some(tx) = self.entered.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    std::future::pending::<()>().await;
                }
                Ok(Some(Runner::Loop(Arc::new(MockProvider::new(Vec::new())))))
            }
            async fn route_eligibility(&self, route: &Value) -> RouteEligibility {
                if route.get("provider").and_then(Value::as_str) == Some("gemini") && self.hang_on == "eligibility" {
                    if let Some(tx) = self.entered.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    std::future::pending::<()>().await;
                }
                RouteEligibility::Unknown
            }
            async fn agent_ready(&self, _: &str, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn raw_context_window(&self, _: &str, _: &str, _: &Value) -> Option<u64> {
                Some(200_000)
            }
            async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
                let mut s = self.session.lock().unwrap();
                for (k, v) in route {
                    s[k] = v;
                }
                s["routeFallbacks"] = Value::Array(write.chain);
                if let Some(p) = write.primary {
                    s["routeFallbackPrimary"] = p;
                }
                s["routeFallbackIndex"] = json!(write.index);
                s["routeFallbackFailures"] = Value::Array(write.failures);
                Ok(Some(s.clone()))
            }
            fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
                (None, None)
            }
        }

        for hang_on in ["runner", "eligibility"] {
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let token = mixdog_rt::CancellationToken::new();
            let switches = Arc::new(Mutex::new(Vec::new()));
            let sink = switches.clone();
            let host = Arc::new(HttpBudgetCancelHost { session: Mutex::new(fresh()), hang_on, entered: Mutex::new(Some(entered_tx)) });
            let route = RouteHop::new(host).with_cancel(Arc::new(TokenSignal(token.clone()))).with_on_route_switch(move |ev| sink.lock().unwrap().push(ev));

            let cancel_task = tokio::spawn(async move {
                let _ = entered_rx.await;
                token.cancel();
            });
            let decision = tokio::time::timeout(std::time::Duration::from_secs(2), route.preflight(None, false, false))
                .await
                .expect("HTTP budget-refresh cancellation must return promptly")
                .unwrap();
            cancel_task.await.unwrap();
            assert!(
                matches!(decision, PreflightDecision::Cancelled),
                "cancellation during HTTP budget refresh ({hang_on}) must return PreflightDecision::Cancelled"
            );
            assert_eq!(switches.lock().unwrap().len(), 1, "persisted switch event must already be buffered before cancel");
        }
    }

    #[tokio::test]
    async fn proxy_mode_oauth_401_on_turn_1_recovers_on_turn_2_and_blocks_within_same_turn() {
        let mut host = stub(
            json!({
                "id": "s1",
                "agent": "mixy",
                "provider": "anthropic-oauth",
                "model": "fable",
                "routeFallbacks": [{ "provider": "openai-oauth", "model": "astra" }]
            }),
            &[],
            &[],
        );
        host.mutate_session_on_hop = true;
        host.fingerprints.lock().unwrap().insert("anthropic-oauth", "oauth:remote".to_owned());
        let (turn1, writes1) = hop_over(host);

        let mut auth_err = ProviderError::new(ErrorKind::Auth, mixdog_core_api::domain::provider::DeliveryState::Accepted);
        auth_err.status = Some(401);
        auth_err.message = "Unauthorized".into();
        let decision = turn1.decide(auth_err, None).await;
        assert!(matches!(decision, RouteDecision::Switch(_)), "turn 1 401 hops to fallback");
        assert!(turn1.reconsider(None).await.unwrap().is_none(), "same turn must not immediately retry the 401'd proxy route");

        let persisted = writes1.session.lock().unwrap().clone();
        assert_eq!(persisted["provider"], "openai-oauth");
        assert_eq!(persisted["routeFallbackFailures"][0]["credentialFingerprint"], "oauth:remote");

        // Turn 2: fresh RouteHop on fallback, proxy fingerprint is still `"oauth:remote"`; preflight recovers to primary.
        let host2 = stub(persisted, &[], &[]);
        host2.fingerprints.lock().unwrap().insert("anthropic-oauth", "oauth:remote".to_owned());
        let (turn2, writes2) = hop_over(host2);
        let decision2 = turn2.preflight(None, false, false).await.unwrap();
        assert!(
            matches!(decision2, PreflightDecision::SwitchLoop(_)),
            "new turn on proxy-mode OAuth must allow recovery even though remote fingerprint stays oauth:remote"
        );
        assert_eq!(writes2.writes.lock().unwrap()[0].0["provider"], "anthropic-oauth");
    }

    #[tokio::test]
    async fn unreadable_local_oauth_credential_never_clears_standing_401() {
        let diverted = json!({
            "id": "s1",
            "agent": "mixy",
            "provider": "openai-oauth",
            "model": "astra",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 1,
            "routeFallbackFailures": [{
                "provider": "anthropic-oauth",
                "model": "fable",
                "kind": "auth",
                "error": "401 Unauthorized",
                "credentialFingerprint": "sha256:token-v1"
            }]
        });

        let mut unreadable_host = stub(diverted.clone(), &[], &[]);
        unreadable_host.evidence = [("fable", RouteEligibility::Eligible), ("astra", RouteEligibility::Eligible)].into_iter().collect();
        unreadable_host.fingerprints.lock().unwrap().insert("anthropic-oauth", "oauth:unreadable".to_owned());
        let (route_unreadable, writes_unreadable) = hop_over(unreadable_host);
        let decision = route_unreadable.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::StayLoop(_)), "oauth:unreadable must never clear a standing 401 even when quota is Eligible");
        assert!(writes_unreadable.writes.lock().unwrap().is_empty());

        let mut relogin_host = stub(diverted, &[], &[]);
        relogin_host.evidence = [("fable", RouteEligibility::Unknown), ("astra", RouteEligibility::Unknown)].into_iter().collect();
        relogin_host.fingerprints.lock().unwrap().insert("anthropic-oauth", "sha256:token-v2".to_owned());
        let (route_relogin, writes_relogin) = hop_over(relogin_host);
        let decision = route_relogin.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::SwitchLoop(_)), "a valid new digest must clear the 401 and recover");
        assert_eq!(writes_relogin.writes.lock().unwrap()[0].0["provider"], "anthropic-oauth");
    }

    #[tokio::test]
    async fn relogin_unblocks_intermediate_oauth_route_with_unknown_quota() {
        let on_c = json!({
            "id": "s1",
            "agent": "mixy",
            "provider": "google",
            "model": "gem",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 2,
            "routeFallbackFailures": [
                { "provider": "anthropic-oauth", "model": "fable", "kind": "quota_exhausted", "error": "quota exhausted" },
                { "provider": "openai-oauth", "model": "astra", "kind": "auth", "error": "401 Unauthorized", "credentialFingerprint": "sha256:old" }
            ]
        });

        // Same fingerprint: B stays blocked, session stays on C.
        let mut same_host = stub(on_c.clone(), &[], &[]);
        same_host.evidence =
            [("fable", RouteEligibility::Exhausted), ("astra", RouteEligibility::Unknown), ("gem", RouteEligibility::Unknown)].into_iter().collect();
        same_host.fingerprints.lock().unwrap().insert("openai-oauth", "sha256:old".to_owned());
        let (route_same, writes_same) = hop_over(same_host);
        assert!(matches!(route_same.preflight(None, false, false).await.unwrap(), PreflightDecision::StayLoop(_)));
        assert!(writes_same.writes.lock().unwrap().is_empty());

        // After relogin with unknown quota: B unblocks and session recovers from C to B.
        let mut relogin_host = stub(on_c, &[], &[]);
        relogin_host.evidence =
            [("fable", RouteEligibility::Exhausted), ("astra", RouteEligibility::Unknown), ("gem", RouteEligibility::Unknown)].into_iter().collect();
        relogin_host.fingerprints.lock().unwrap().insert("openai-oauth", "sha256:new".to_owned());
        let (route_relogin, writes_relogin) = hop_over(relogin_host);
        let decision = route_relogin.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::SwitchLoop(_)), "relogin must recover intermediate route B even when B's quota is Unknown");
        let writes = writes_relogin.writes.lock().unwrap();
        assert_eq!(writes[0].0["provider"], "openai-oauth");
        assert_eq!(writes[0].0["model"], "astra");
        assert_eq!(writes[0].1.failures.len(), 1, "B's cleared auth failure is removed while A's quota failure remains");
        assert_eq!(writes[0].1.failures[0]["provider"], "anthropic-oauth");
    }

    #[tokio::test]
    async fn preflight_propagates_cancellation_during_live_chain_and_unavailable_check_on_last_candidate() {
        use std::sync::atomic::AtomicBool;
        struct TokenSignal(mixdog_rt::CancellationToken);
        #[async_trait]
        impl CancelSignal for TokenSignal {
            fn is_cancelled(&self) -> bool {
                self.0.is_cancelled()
            }
            async fn cancelled(&self) {
                self.0.cancelled().await;
            }
        }

        struct HangingBots {
            hang_after_hop: bool,
            hop_committed: Arc<AtomicBool>,
            entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        }
        #[async_trait]
        impl BotRoutes for HangingBots {
            async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, super::super::route_chain::RouteReadUnavailable> {
                if self.hang_after_hop && self.hop_committed.load(Ordering::SeqCst) {
                    if let Some(tx) = self.entered.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    std::future::pending::<()>().await;
                }
                Ok(Some(Some(json!({
                    "provider": "anthropic-oauth",
                    "model": "fable",
                    "fallbacks": [{ "provider": "openai-oauth", "model": "astra" }]
                }))))
            }
            async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, super::super::route_chain::RouteReadUnavailable> {
                Ok(None)
            }
        }

        struct LastCandidateCancelHost {
            session: Mutex<Value>,
            bots: HangingBots,
            hop_committed: Arc<AtomicBool>,
            hang_primary_runner_after_hop: bool,
            entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        }
        #[async_trait]
        impl HopHost for LastCandidateCancelHost {
            fn session(&self) -> Option<Value> {
                Some(self.session.lock().unwrap().clone())
            }
            fn config(&self) -> Obj {
                json!({
                    "default": "mixy",
                    "presets": [{
                        "id": "mixy",
                        "provider": "anthropic-oauth",
                        "model": "fable",
                        "fallbacks": [{ "provider": "openai-oauth", "model": "astra" }]
                    }]
                })
                .as_object()
                .cloned()
                .unwrap()
            }
            fn bots(&self) -> &dyn BotRoutes {
                &self.bots
            }
            fn model_label(&self, _: &str, m: &str) -> String {
                m.to_owned()
            }
            fn error_text(&self, e: &ProviderError) -> String {
                e.message.clone()
            }
            async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
                if provider == "anthropic-oauth" {
                    if self.hang_primary_runner_after_hop && self.hop_committed.load(Ordering::SeqCst) {
                        if let Some(tx) = self.entered.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                        std::future::pending::<()>().await;
                    }
                    return Ok(None);
                }
                Ok(Some(Runner::Loop(Arc::new(MockProvider::new(Vec::new())))))
            }
            async fn route_eligibility(&self, _: &Value) -> RouteEligibility {
                RouteEligibility::Unknown
            }
            async fn agent_ready(&self, _: &str, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn raw_context_window(&self, _: &str, _: &str, _: &Value) -> Option<u64> {
                Some(200_000)
            }
            async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
                let mut s = self.session.lock().unwrap();
                for (k, v) in route {
                    s[k] = v;
                }
                s["routeFallbacks"] = Value::Array(write.chain);
                if let Some(p) = write.primary {
                    s["routeFallbackPrimary"] = p;
                }
                s["routeFallbackIndex"] = json!(write.index);
                s["routeFallbackFailures"] = Value::Array(write.failures);
                self.hop_committed.store(true, Ordering::SeqCst);
                Ok(Some(s.clone()))
            }
            fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
                (None, None)
            }
        }

        // Case 1: cancel fires during live_route_fallbacks (bot_route) in budget refresh on the last candidate.
        let (bot_entered_tx, bot_entered_rx) = tokio::sync::oneshot::channel();
        let token1 = mixdog_rt::CancellationToken::new();
        let hop_committed1 = Arc::new(AtomicBool::new(false));
        let mut bot_session = fresh();
        bot_session["ownerAgentId"] = json!("botty");
        let host1 = Arc::new(LastCandidateCancelHost {
            session: Mutex::new(bot_session),
            bots: HangingBots { hang_after_hop: true, hop_committed: hop_committed1.clone(), entered: Mutex::new(Some(bot_entered_tx)) },
            hop_committed: hop_committed1,
            hang_primary_runner_after_hop: false,
            entered: Mutex::new(None),
        });
        let route1 = RouteHop::new(host1).with_cancel(Arc::new(TokenSignal(token1.clone())));
        let cancel1 = tokio::spawn(async move {
            bot_entered_rx.await.expect("must enter post-hop live_route_fallbacks");
            token1.cancel();
        });
        let decision1 = tokio::time::timeout(std::time::Duration::from_secs(2), route1.preflight(None, false, false))
            .await
            .expect("cancel during live_route_fallbacks must return promptly")
            .unwrap();
        drop(route1);
        tokio::time::timeout(std::time::Duration::from_secs(2), cancel1).await.expect("cancel task finished").unwrap();
        assert!(
            matches!(decision1, PreflightDecision::Cancelled),
            "cancellation during live_route_fallbacks on last candidate must return PreflightDecision::Cancelled"
        );

        // Case 2: cancel fires during standing provider_unavailable runner check on the last candidate.
        let (runner_entered_tx, runner_entered_rx) = tokio::sync::oneshot::channel();
        let token2 = mixdog_rt::CancellationToken::new();
        let hop_committed2 = Arc::new(AtomicBool::new(false));
        let host2 = Arc::new(LastCandidateCancelHost {
            session: Mutex::new(fresh()),
            bots: HangingBots { hang_after_hop: false, hop_committed: hop_committed2.clone(), entered: Mutex::new(None) },
            hop_committed: hop_committed2,
            hang_primary_runner_after_hop: true,
            entered: Mutex::new(Some(runner_entered_tx)),
        });
        let route2 = RouteHop::new(host2).with_cancel(Arc::new(TokenSignal(token2.clone())));
        let cancel2 = tokio::spawn(async move {
            runner_entered_rx.await.expect("must enter post-hop standing provider_unavailable runner check");
            token2.cancel();
        });
        let decision2 = tokio::time::timeout(std::time::Duration::from_secs(2), route2.preflight(None, false, false))
            .await
            .expect("cancel during standing provider_unavailable runner check must return promptly")
            .unwrap();
        drop(route2);
        tokio::time::timeout(std::time::Duration::from_secs(2), cancel2).await.expect("cancel task finished").unwrap();
        assert!(
            matches!(decision2, PreflightDecision::Cancelled),
            "cancellation during provider_unavailable runner check on last candidate must return PreflightDecision::Cancelled"
        );
    }

    #[tokio::test]
    async fn intermediate_401_never_reopens_context_overflowed_primary_and_relogin_recovers_intermediate() {
        let on_c = json!({
            "id": "s1",
            "agent": "mixy",
            "provider": "google",
            "model": "gem",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 2,
            "routeFallbackFailures": [
                { "provider": "anthropic-oauth", "model": "fable", "kind": "context_overflow", "error": "context length exceeded" },
                { "provider": "openai-oauth", "model": "astra", "kind": "auth", "error": "401 Unauthorized", "credentialFingerprint": "sha256:old" }
            ]
        });

        // 1. Before B relogs in, even though A has Eligible quota, turn 2 must stay on C and NEVER jump back to A.
        let mut unchanged_host = stub(on_c.clone(), &[], &[]);
        unchanged_host.evidence =
            [("fable", RouteEligibility::Eligible), ("astra", RouteEligibility::Eligible), ("gem", RouteEligibility::Eligible)].into_iter().collect();
        unchanged_host.fingerprints.lock().unwrap().insert("openai-oauth", "sha256:old".to_owned());
        let (route_unchanged, writes_unchanged) = hop_over(unchanged_host);
        let decision = route_unchanged.preflight(None, false, false).await.unwrap();
        assert!(
            matches!(decision, PreflightDecision::StayLoop(_)),
            "intermediate 401 with unchanged credentials must stay on C and never jump back to context-overflowed primary A"
        );
        assert!(writes_unchanged.writes.lock().unwrap().is_empty());

        // 2. When B relogs in (even with Unknown quota and A still Eligible), turn 2 recovers to B — NOT A.
        let mut relogin_host = stub(on_c, &[], &[]);
        relogin_host.evidence =
            [("fable", RouteEligibility::Eligible), ("astra", RouteEligibility::Unknown), ("gem", RouteEligibility::Eligible)].into_iter().collect();
        relogin_host.fingerprints.lock().unwrap().insert("openai-oauth", "sha256:new".to_owned());
        let (route_relogin, writes_relogin) = hop_over(relogin_host);
        let decision = route_relogin.preflight(None, false, false).await.unwrap();
        assert!(matches!(decision, PreflightDecision::SwitchLoop(_)), "relogin on intermediate B must recover from C to B, not context-overflowed primary A");
        let writes = writes_relogin.writes.lock().unwrap();
        assert_eq!(writes[0].0["provider"], "openai-oauth");
        assert_eq!(writes[0].0["model"], "astra");
        assert_eq!(writes[0].1.failures.len(), 1, "primary A's context_overflow failure must remain recorded");
        assert_eq!(writes[0].1.failures[0]["provider"], "anthropic-oauth");
        assert_eq!(writes[0].1.failures[0]["kind"], "context_overflow");
    }

    #[tokio::test]
    async fn preflight_select_skips_overflowed_primary_in_favor_of_recovered_intermediate_when_current_exhausted() {
        let on_c = json!({
            "id": "s1",
            "agent": "mixy",
            "provider": "google",
            "model": "gem",
            "routeFallbackPrimary": { "provider": "anthropic-oauth", "model": "fable" },
            "routeFallbackIndex": 2,
            "routeFallbackFailures": [
                { "provider": "anthropic-oauth", "model": "fable", "kind": "context_overflow", "error": "context length exceeded" },
                { "provider": "openai-oauth", "model": "astra", "kind": "auth", "error": "401 Unauthorized", "credentialFingerprint": "sha256:old" }
            ]
        });

        let mut host = stub(on_c, &[], &[]);
        host.evidence =
            [("fable", RouteEligibility::Eligible), ("astra", RouteEligibility::Unknown), ("gem", RouteEligibility::Exhausted)].into_iter().collect();
        host.fingerprints.lock().unwrap().insert("openai-oauth", "sha256:new".to_owned());
        let (route, writes_host) = hop_over(host);
        let decision = route.preflight(None, false, false).await.unwrap();
        assert!(
            matches!(decision, PreflightDecision::SwitchLoop(_)),
            "preflight on exhausted C must skip context-overflowed A and select recovered intermediate B"
        );
        let writes = writes_host.writes.lock().unwrap();
        assert_eq!(writes[0].0["provider"], "openai-oauth");
        assert_eq!(writes[0].0["model"], "astra");
        assert!(
            writes[0].1.failures.iter().any(|f| f["provider"] == "anthropic-oauth" && f["kind"] == "context_overflow"),
            "overflowed primary A must remain recorded in failures"
        );
        assert!(writes[0].1.failures.iter().any(|f| f["provider"] == "google" && f["kind"] == "quota_exhausted"), "exhausted C must be recorded in failures");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_ai::effort::EffortAuto;

    #[test]
    fn effort_auto_states_survive_fallback_hop() {
        for (label, state) in [("auto", EffortAuto::Auto), ("manual", EffortAuto::Manual)] {
            let mut next = json!({ "provider": "anthropic", "model": "opus", "effort": "high", "fast": false });
            state.write_to(next.as_object_mut().unwrap());

            let fields = route_fields(&next, None);
            assert_eq!(EffortAuto::read_explicit(&fields), Some(state), "route_fields preserves {label}");
            assert_eq!(fields.get("autoEffort"), Some(&Value::Null), "hop clears stale legacy autoEffort");

            let leaf = crate::run_host::route_chain::route_leaf(Some(&next));
            assert_eq!(EffortAuto::read_explicit(&leaf), Some(state), "route_leaf preserves {label}");
        }
    }
}
