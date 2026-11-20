//! The run's model fallback hop (Node `session/loop/route-fallback.mjs`, `advanceAgentRoute`, and
//! `shared/model-route-fallback.mjs`, `routeFallbackVerdict`).
//!
//! After a provider error survived every retry, the session's chain (read from its settings at
//! that moment, see [`super::route_chain`]) may hand the request to the next model. The hop writes
//! the session fields `routeFallbacks`, `routeFallbackPrimary`, `routeFallbackIndex` and
//! `routeFallbackFailures` together with the new route, in one session update.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::effort::EffortWiring;
pub use mixdog_agent::env::{ChainSurface, RouteDecision, UsageSegment};
use mixdog_agent::env::{RouteFallback, RouteSwitch, RouteSwitchRequest};
pub use mixdog_agent::recovery::{strip_provider_replay, strip_provider_replay_messages};
use mixdog_agent::text_only::TextOnlyInput;
use mixdog_ai::retry::classify::kind_from_code;
use mixdog_core_api::domain::provider::{ErrorKind, ProviderAdapter, ProviderError, UsdTicks, Usage};
use mixdog_js::JsRegex;
use serde_json::{json, Value};
use std::sync::LazyLock;

use super::route_chain::live_route_fallbacks;
use super::route_chain::next_route_fallback_index;
use super::route_chain::route_fallback_hopped;
use super::route_chain::route_leaf;
use super::route_chain::same_route_model;
use super::route_chain::session_chain_source;
use super::route_chain::session_route_primary;
use super::route_chain::BotRoutes;
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
        // Only when the server answered: a bare network failure would fail on every provider.
        ErrorKind::Transient => hop(
            status >= 408 || error.code.as_deref().and_then(kind_from_code) == Some(ErrorKind::Transient),
        ),
        ErrorKind::InvalidRequest => {
            let code = error.code.as_deref().unwrap_or_default();
            hop(status == 404
                || status == 410
                || matches!(code, "model_not_found" | "model_not_supported")
                || names_unavailable_model(&error.message))
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

/// What the hop needs from the session, the config and the provider registry.
#[async_trait]
pub trait HopHost: Send + Sync {
    /// Whether `route` (a configured route of the session's order) can be sent on now. Owner: the quota/admission layer;
    /// a host with no such source answers [`RouteEligibility::Unknown`], which reconsiders nothing.
    async fn route_eligibility(&self, route: &Value) -> RouteEligibility {
        let _ = route;
        RouteEligibility::Unknown
    }

    /// The live session header; `None` once it is closed.
    fn session(&self) -> Option<Value>;
    /// `getConfigSnapshot({ secrets: false })`.
    fn config(&self) -> Obj;
    fn bots(&self) -> &dyn BotRoutes;
    /// `displayModelName(model, provider)`; empty when it has no display name.
    fn model_label(&self, provider: &str, model: &str) -> String;
    /// `presentErrorText(error)`.
    fn error_text(&self, error: &ProviderError) -> String;
    /// `initProviders(ensureProviderEnabled(config, provider))` then `getProvider`; `None` when
    /// the provider is not available. `Err` is what `initProviders` throws (its message escapes
    /// the hop as it is).
    async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String>;
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
    let any = out.input_tokens + out.output_tokens + out.cache_read_tokens + out.cache_write_tokens + out.cache_write_1h_tokens + out.reasoning_tokens.unwrap_or(0) > 0
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

/// The failure kind a route left at turn preflight because its provider was not available carries. Transient: the next
/// reconsider returns to that route once its provider is available again.
pub const PROVIDER_UNAVAILABLE: &str = "provider_unavailable";

/// The route hop of one run.
pub struct RouteHop {
    host: Arc<dyn HopHost>,
    request_for_route: Option<Box<RequestForRoute>>,
    usage_hops: Mutex<Vec<UsageHop>>,
    /// Non-quota failures during this run: a quota reading cannot prove these resolved.
    failed_here: Mutex<Vec<Value>>,
    /// A switch written before the run existed ([`RouteHop::unavailable`]): the run seats it before its first request,
    /// as it seats any reconsidered route.
    pending: Mutex<Option<RouteSwitch>>,
}

impl RouteHop {
    pub fn new(host: Arc<dyn HopHost>) -> Self {
        Self { host, request_for_route: None, usage_hops: Mutex::new(Vec::new()), failed_here: Mutex::new(Vec::new()), pending: Mutex::new(None) }
    }

    pub fn with_request_for_route(mut self, build: impl Fn(&Obj) -> RouteSwitchRequest + Send + Sync + 'static) -> Self {
        self.request_for_route = Some(Box::new(build));
        self
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
        let lines = attempts
            .iter()
            .map(|a| format!("{}: {}", self.label(a), text(a.get("error"))))
            .collect::<Vec<_>>()
            .join("; ");
        let head = match skipped {
            Some(next) => format!(
                "Fallback chain stopped before {} (its context window is not larger) — tried",
                self.label(next)
            ),
            None => "Every model in the fallback chain failed —".to_owned(),
        };
        error.message = format!("{}\n{head} {lines}", error.message);
        let stopped_before = skipped.map(|n| json!({ "provider": n.get("provider"), "model": n.get("model") }));
        ChainSurface { error, attempts, stopped_before }
    }

    /// The provider of a route, readied: `Ok(None)` when it is not available, a provider the user switched off (asked
    /// before any initialization or registered adapter) and a provider no family serves (a removed custom provider,
    /// [`is_unserved`]) included. `Err` is any other readiness failure.
    async fn lookup(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        if mixdog_ai::service::admin_route::provider_switched_off(&self.host.config(), provider) {
            return Ok(None);
        }
        match self.host.provider(provider).await {
            Err(message) if is_unserved(provider, &message) => Ok(None),
            looked => looked,
        }
    }

    /// The session's recorded failures that still hold: a `provider_unavailable` entry whose provider is available now is
    /// left out.
    async fn standing_failures(&self, session: &Value) -> Vec<Value> {
        let mut standing = Vec::new();
        for failure in session.get("routeFallbackFailures").and_then(Value::as_array).into_iter().flatten() {
            let absent = failure.get("kind").and_then(Value::as_str) == Some(PROVIDER_UNAVAILABLE);
            if !absent || !matches!(self.lookup(&text(failure.get("provider"))).await, Ok(Some(_))) {
                standing.push(failure.clone());
            }
        }
        standing
    }

    /// `nextContextGrows`: a context overflow moves only to a model whose window is larger. `next` is a present candidate
    /// ([`Self::next_present`]).
    fn next_context_grows(&self, session: &Value, next: &Value) -> bool {
        let current = self.host.raw_context_window(&text(session.get("provider")), &text(session.get("model")), session);
        let window = self.host.raw_context_window(&text(next.get("provider")), &text(next.get("model")), next);
        let fallback = session.get("selectedContextWindow").and_then(Value::as_u64);
        window.unwrap_or(0) > current.filter(|w| *w > 0).or(fallback).unwrap_or(0)
    }

    /// The first route of `chain` that `tried` has not run and whose provider is there: a candidate that is absent
    /// (switched off, removed, not available) is passed over, as at preflight, and recorded nowhere. `Err` is a genuine
    /// readiness failure.
    async fn next_present(&self, tried: &Value, chain: &[Value]) -> Result<Candidate, String> {
        let mut passed = tried.clone();
        let mut first_absent = None;
        loop {
            let index = next_route_fallback_index(&passed, chain);
            let Some(next) = chain.get(index) else {
                return Ok(first_absent.map_or(Candidate::None, Candidate::Absent));
            };
            if let Some(provider) = self.lookup(&text(next.get("provider"))).await? {
                return Ok(Candidate::Present(index, provider));
            }
            first_absent.get_or_insert(index);
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

/// The next route a mid-turn hop may take ([`RouteHop::next_present`]).
enum Candidate {
    /// The chain index of the first present route, and its readied provider.
    Present(usize, Arc<dyn ProviderAdapter>),
    /// Only absent routes are left; the chain index of the first.
    Absent(usize),
    /// No route is left to try.
    None,
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
        // The candidate is the first route still to try whose provider is there; nothing is written before it is found. With
        // none left but absent ones the chain ends as Node's did on its next route: a hop fails with that route's absence,
        // and an overflow stops before it.
        let (index, provider) = match self.next_present(&tried, &chain).await {
            Ok(Candidate::Present(index, provider)) => (index, provider),
            Ok(Candidate::None) => return RouteDecision::Surface(Box::new(self.annotate(&tried, error, None))),
            Ok(Candidate::Absent(index)) if verdict == RouteVerdict::Context => {
                return RouteDecision::Surface(Box::new(self.annotate(&tried, error, Some(&chain[index]))));
            }
            Ok(Candidate::Absent(index)) => return RouteDecision::Fail(format!("Provider \"{}\" not available", text(chain[index].get("provider")))),
            Err(message) => return RouteDecision::Fail(message),
        };
        let next = &chain[index];
        if verdict == RouteVerdict::Context && !self.next_context_grows(&session, next) {
            return RouteDecision::Surface(Box::new(self.annotate(&tried, error, Some(next))));
        }
        let failed = self.failure(&session, &error);
        // The left model's share of the turn ends here: the running total at the switch bounds
        // it, so each model's tokens are booked at its own rates.
        self.usage_hops.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(UsageHop {
            provider: text(session.get("provider")),
            model: text(session.get("model")),
            usage: last_usage.cloned(),
        });
        // The route a reset returns to, kept from the first hop.
        let primary = if route_fallback_hopped(&session) {
            session.get("routeFallbackPrimary").filter(|p| !p.is_null()).cloned()
        } else {
            Some(Value::Object(route_leaf(Some(&session))))
        };
        let notice = notice_text(&self.label(&session), &self.label(next), error.kind);
        let mut failures = standing;
        failures.push(failed);
        let write = HopWrite {
            chain: chain.clone(),
            primary,
            index: index + 1,
            failures,
            checkpoint_route_changed: session.get("activeTurnCheckpoint").is_some_and(Value::is_object),
        };
        if error.kind != ErrorKind::QuotaExhausted {
            self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
        }
        match self.seat(next, provider, write, notice).await {
            Ok(switch) => RouteDecision::Switch(switch),
            Err(message) => RouteDecision::Fail(message),
        }
    }

    /// The session's provider is not available at turn preflight (`refusal` says so). Nothing was sent, so every other
    /// route of the configured order is a candidate, the primary first: the first whose provider is available and that is
    /// not known exhausted takes the turn, whatever the session tried before (a primary that recovered while its fallback
    /// went away is taken back). The switch is written now and held for the run, which seats it before its first request as
    /// it seats any reconsidered route, so the landing provider starts exactly as after a mid-turn hop. `Ok(Some)` is the
    /// landing provider; `Ok(None)` when no other route is available (the refusal stands); `Err` is the hop's own failure,
    /// which may come after the session was written.
    pub async fn unavailable(&self, refusal: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        let Some(session) = self.host.session().filter(has_agent) else { return Ok(None) };
        let config = self.host.config();
        let (chain, _) = live_route_fallbacks(&session, &config, self.host.bots()).await.map_err(|error| error.to_string())?;
        if chain.is_empty() {
            return Ok(None);
        }
        let order = self.configured_order(&session, &config, &chain).await;
        let mut landing = None;
        for (index, route) in order.iter().enumerate() {
            if same_route_model(Some(route), Some(&session)) || self.host.route_eligibility(route).await == RouteEligibility::Exhausted {
                continue;
            }
            if let Some(provider) = self.lookup(&text(route.get("provider"))).await? {
                landing = Some((index, provider));
                break;
            }
        }
        let Some((index, provider)) = landing else { return Ok(None) };
        let next = &order[index];
        // The route left is the reason of this diversion: its entry is the newest, and the one it lands on leaves the list
        // unless it is the primary, as on any reconsidered route.
        let mut failures = session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default();
        failures.retain(|f| !same_route_model(Some(f), Some(&session)));
        failures.push(json!({ "provider": session.get("provider"), "model": session.get("model"), "kind": PROVIDER_UNAVAILABLE, "error": refusal }));
        if index != 0 {
            failures.retain(|f| !same_route_model(Some(f), Some(next)));
        }
        let write = HopWrite {
            chain,
            primary: (!route_fallback_hopped(&session)).then(|| Value::Object(route_leaf(Some(&session)))),
            index,
            failures,
            checkpoint_route_changed: session.get("activeTurnCheckpoint").is_some_and(Value::is_object),
        };
        let notice = notice_text(&self.label(&session), &self.label(next), ErrorKind::Transient);
        self.usage_hops.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(UsageHop { provider: text(session.get("provider")), model: text(session.get("model")), usage: None });
        self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(session.clone());
        let switch = self.seat(next, provider, write, notice).await?;
        let provider = switch.provider.clone();
        *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(switch);
        Ok(Some(provider))
    }

    /// A reconsidered switch to `next` failed with `failure` after its session write: the session is written back onto the
    /// route the run stands on, as `session` held it (its route and hop fields), which also re-pins that route's wire and
    /// rebuilds its tool surface. The run goes on there and does not try `next` again; `Err` only when the restore failed
    /// too, since the session would then name a route the run is not on.
    async fn put_back(&self, session: &Value, next: &Value, failure: String) -> Result<(), String> {
        tracing::warn!(session = %text(session.get("id")), from = %self.label(session), to = %self.label(next), "[route] switch back failed, staying on the current route: {failure}");
        self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(next.clone());
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

    /// Before an unsent request: the primary or a session diverted by quota follows the configured order
    /// by eligibility. The order is the authoritative chain owner's ([`session_chain_source`], the primary first), and
    /// the first route that is eligible and ranks above the current one is taken even when the current is healthy; while
    /// the current route is known exhausted, the first eligible route below it is. A route nothing proves eligible is
    /// never chosen, so no send is spent finding out. A deliberate choice (a pick held for the next turn, or a session no
    /// hop moved from its primary) is left alone: the session's hop fields are the only mark of an automatic diversion,
    /// and a deliberate route write clears them. Only the reason of the current diversion (the primary's newest failure)
    /// decides whether the primary is reconsidered. A switch that fails after its session write is put back
    /// ([`Self::put_back`]); `Err` only when that fails too.
    pub async fn reconsider(&self, last_usage: Option<&Usage>) -> Result<Option<RouteSwitch>, String> {
        let pending = self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(mut switch) = pending {
            // Its request is built from the session as it stands now: what the assembly stored after the hop (the landing
            // provider's wire identity) is the destination's.
            if let (Some(build), Some(Value::Object(fields))) = (&self.request_for_route, self.host.session()) {
                switch.request = build(&fields);
            }
            return Ok(Some(switch));
        }
        let Some(session) = self.host.session().filter(has_agent) else { return Ok(None) };
        if session.get("pendingRoute").is_some_and(|pick| !pick.is_null()) {
            return Ok(None);
        }
        let primary = session_route_primary(&session);
        let failures = session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default();
        let reason = failures.iter().rev().find(|f| same_route_model(Some(f), Some(&primary))).and_then(|f| f.get("kind")).and_then(Value::as_str);
        let (left_on_quota, left_unavailable) = (reason == Some("quota_exhausted"), reason == Some(PROVIDER_UNAVAILABLE));
        // Only the configured primary, or a route already automatically diverted on quota or an unavailable provider,
        // participates.
        if !left_on_quota && !left_unavailable && !same_route_model(Some(&primary), Some(&session)) {
            return Ok(None);
        }
        let config = self.host.config();
        let Ok((chain, _)) = live_route_fallbacks(&session, &config, self.host.bots()).await else { return Ok(None) };
        if chain.is_empty() {
            return Ok(None);
        }
        let order = self.configured_order(&session, &config, &chain).await;
        let Some(current) = order.iter().position(|route| same_route_model(Some(route), Some(&session))) else { return Ok(None) };
        let failed_here = self.failed_here.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let usable = |route: &Value| !failed_here.iter().any(|failed| same_route_model(Some(failed), Some(route)));
        let mut target = None;
        for (index, route) in order.iter().enumerate().take(current) {
            if !usable(route) {
                continue;
            }
            let eligible = match self.host.route_eligibility(route).await {
                RouteEligibility::Eligible => true,
                RouteEligibility::Exhausted => false,
                // A primary left only because its provider was not there is taken back as soon as the provider is.
                RouteEligibility::Unknown => index == 0 && left_unavailable && matches!(self.lookup(&text(route.get("provider"))).await, Ok(Some(_))),
            };
            if eligible {
                target = Some(index);
                break;
            }
        }
        let diverted_on = target.is_none() && self.host.route_eligibility(&order[current]).await == RouteEligibility::Exhausted;
        if diverted_on {
            for (index, route) in order.iter().enumerate().skip(current + 1) {
                if usable(route) {
                    match self.host.route_eligibility(route).await {
                        RouteEligibility::Eligible => {
                            target = Some(index);
                            break;
                        }
                        RouteEligibility::Exhausted => {}
                        // The ordinary fallback path may still send here. Do not jump past it.
                        RouteEligibility::Unknown => break,
                    }
                }
            }
        }
        let Some(index) = target else { return Ok(None) };
        let next = &order[index];
        let next_provider = text(next.get("provider"));
        let Ok(Some(provider)) = self.lookup(&next_provider).await else { return Ok(None) };
        let notice = if index < current {
            format!("{} is available again — switched back from {}.", self.label(next), self.label(&session))
        } else {
            notice_text(&self.label(&session), &self.label(next), ErrorKind::QuotaExhausted)
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
            primary: (!route_fallback_hopped(&session)).then(|| Value::Object(route_leaf(Some(&session)))),
            index,
            failures,
            checkpoint_route_changed: session.get("activeTurnCheckpoint").is_some_and(Value::is_object),
        };
        let switch = match self.seat(next, provider, write, notice).await {
            Ok(switch) => switch,
            // The switch is optional: the run stays on the route it is on, and the session is written back onto it.
            Err(failure) => return self.put_back(&session, next, failure).await.map(|()| None),
        };
        // The left route's share of the turn ends here, as at a hop.
        self.usage_hops.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(UsageHop {
            provider: text(session.get("provider")),
            model: text(session.get("model")),
            usage: last_usage.cloned(),
        });
        Ok(Some(switch))
    }
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
    route.insert("autoEffort".into(), Value::Bool(next.get("autoEffort") != Some(&Value::Bool(false))));
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
        session: Value,
        config: Obj,
        evidence: HashMap<&'static str, RouteEligibility>,
        writes: Mutex<Vec<(Obj, HopWrite)>>,
        /// Providers that are not available.
        gone: Vec<&'static str>,
        /// Providers whose readiness fails, with the failure.
        init_errors: Vec<(&'static str, String)>,
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
            Some(self.session.clone())
        }
        fn config(&self) -> Obj {
            self.config.clone()
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
        async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
            if let Some((_, message)) = self.init_errors.iter().find(|(name, _)| *name == provider) {
                return Err(message.clone());
            }
            Ok((!self.gone.contains(&provider)).then(|| Arc::new(MockProvider::new([])) as Arc<dyn ProviderAdapter>))
        }
        fn raw_context_window(&self, _: &str, _: &str, _: &Value) -> Option<u64> {
            None
        }
        async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
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
        Host { session, config: config(), evidence: HashMap::new(), writes: Mutex::default(), gone: gone.to_vec(), init_errors: Vec::new(), failing: Mutex::new(failing.iter().copied().collect()) }
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
        for (primary, first_alternative, expected) in [
            (Unknown, Eligible, None),
            (Exhausted, Unknown, None),
            (Exhausted, Eligible, Some("astra")),
        ] {
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

    /// No other available route keeps the caller's refusal and writes nothing; a hop that fails after its write is that
    /// failure, not the refusal.
    #[tokio::test]
    async fn an_unavailable_route_without_another_available_one_or_with_a_failed_hop_is_told_apart() {
        let refusal = "Provider \"google\" not available";
        let nowhere = stub(session("google", "gem", "quota_exhausted"), &["anthropic-oauth", "openai-oauth", "google"], &[]);
        let (route, host) = hop_over(nowhere);
        assert!(route.unavailable(refusal).await.expect("no hop failed").is_none(), "no other route is available");
        assert!(host.writes.lock().unwrap().is_empty());

        let failing = stub(fresh(),&[], &["the tool surface could not be rebuilt"]);
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

        let still_gone = stub(diverted,&["anthropic-oauth"], &[]);
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
        for (second, gone, lands) in [(PROVIDER_UNAVAILABLE, &[][..], "astra"), (PROVIDER_UNAVAILABLE, &["openai-oauth"][..], "gem"), ("rate_limited", &[][..], "gem")] {
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

    /// Only the reason of the current diversion counts: an older unavailable or quota entry of the primary does not bring the
    /// session back once the primary's newest failure is one the evidence does not speak to.
    #[tokio::test]
    async fn an_older_reason_does_not_override_the_current_diversion() {
        for older in [PROVIDER_UNAVAILABLE, "quota_exhausted"] {
            let mut diverted = session("openai-oauth", "astra", older);
            diverted["routeFallbackFailures"].as_array_mut().unwrap().push(json!({ "provider": "anthropic-oauth", "model": "fable", "kind": "permission", "error": "denied" }));
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
        let (route, host) = hop_over(stub(diverted.clone(), &[], &["the wire could not be pinned"]));
        assert!(route.reconsider(None).await.expect("put back, the run goes on").is_none());
        {
            let writes = host.writes.lock().unwrap();
            assert_eq!(writes.len(), 2, "the switch back, then the restore");
            let (restored, write) = &writes[1];
            assert_eq!((restored["provider"].as_str(), restored["model"].as_str()), (Some("openai-oauth"), Some("astra")));
            assert_eq!((write.index, write.primary.as_ref(), &write.failures), (1, diverted.get("routeFallbackPrimary"), diverted["routeFallbackFailures"].as_array().unwrap()));
        }
        assert!(route.reconsider(None).await.unwrap().is_none(), "not tried again this run");
        assert_eq!(host.writes.lock().unwrap().len(), 2);
    }

    /// When the restore fails too the session names a route the run is not on: the turn ends with both failures.
    #[tokio::test]
    async fn a_switch_back_whose_restore_fails_ends_the_turn() {
        let (route, host) = hop_over(stub(session("openai-oauth", "astra", PROVIDER_UNAVAILABLE), &[], &["the wire could not be pinned", "the store is gone"]));
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
}

#[cfg(test)]
mod tests {





















}

