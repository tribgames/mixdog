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
use mixdog_agent::env::{RouteFallback, RouteSwitch};
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

/// What the hop needs from the session, the config and the provider registry.
#[async_trait]
pub trait HopHost: Send + Sync {
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

/// The route hop of one run.
pub struct RouteHop {
    host: Arc<dyn HopHost>,
    usage_hops: Mutex<Vec<UsageHop>>,
}

impl RouteHop {
    pub fn new(host: Arc<dyn HopHost>) -> Self {
        Self { host, usage_hops: Mutex::new(Vec::new()) }
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

    /// `nextContextGrows`: a context overflow moves only to a model whose window is larger.
    async fn next_context_grows(&self, session: &Value, next: &Value) -> Result<bool, String> {
        let provider = text(next.get("provider"));
        if self.host.provider(&provider).await?.is_none() {
            return Ok(false);
        }
        let current = self.host.raw_context_window(&text(session.get("provider")), &text(session.get("model")), session);
        let window = self.host.raw_context_window(&provider, &text(next.get("model")), next);
        let fallback = session.get("selectedContextWindow").and_then(Value::as_u64);
        Ok(window.unwrap_or(0) > current.filter(|w| *w > 0).or(fallback).unwrap_or(0))
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

fn plain(error: ProviderError) -> RouteDecision {
    RouteDecision::Surface(Box::new(ChainSurface { error, attempts: Vec::new(), stopped_before: None }))
}

/// The loop's contract: the decision of [`RouteHop::decide`], and the turn's usage per model.
#[async_trait]
impl RouteFallback for RouteHop {
    async fn advance(&self, error: ProviderError, last_usage: Option<&Usage>) -> RouteDecision {
        self.decide(error, last_usage).await
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
        if session.get("agent").is_none_or(|a| matches!(a, Value::Null | Value::Bool(false)) || a.as_str() == Some("")) {
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
        let index = next_route_fallback_index(&session, &chain);
        let next = chain.get(index);
        let verdict = route_fallback_verdict(&error);
        let hops = match (verdict, next) {
            (RouteVerdict::Hop, _) => true,
            (RouteVerdict::Context, Some(next)) => match self.next_context_grows(&session, next).await {
                Ok(grows) => grows,
                Err(message) => return RouteDecision::Fail(message),
            },
            _ => false,
        };
        let Some(next) = next.filter(|_| hops) else {
            return if verdict == RouteVerdict::Stay {
                plain(error)
            } else {
                RouteDecision::Surface(Box::new(self.annotate(&session, error, next)))
            };
        };
        let next_provider = text(next.get("provider"));
        let provider = match self.host.provider(&next_provider).await {
            Ok(Some(provider)) => provider,
            Ok(None) => return RouteDecision::Fail(format!("Provider \"{next_provider}\" not available")),
            Err(message) => return RouteDecision::Fail(message),
        };
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
        let mut failures = session.get("routeFallbackFailures").and_then(Value::as_array).cloned().unwrap_or_default();
        failures.push(failed);
        let write = HopWrite {
            chain: chain.clone(),
            primary,
            index: index + 1,
            failures,
            checkpoint_route_changed: session.get("activeTurnCheckpoint").is_some_and(Value::is_object),
        };
        let window = self.host.raw_context_window(&text(next.get("provider")), &text(next.get("model")), next);
        let updated = match self.host.apply_hop(route_fields(next, window), write).await {
            Ok(Some(updated)) => updated,
            Ok(None) => return RouteDecision::Fail("agent session closed during model fallback".to_owned()),
            Err(message) => return RouteDecision::Fail(message),
        };
        let (effort, text_only) = self.host.wiring(&updated, &provider);
        RouteDecision::Switch(RouteSwitch { provider, model: text(updated.get("model")), notice, effort, text_only })
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
mod tests {
    use super::*;
    use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
    use mixdog_core_api::domain::provider::{
        DeliveryState, ErrorResponse, ModelRequest, ModelStream, WireCodec, WireDecoder, WireRequest,
    };
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_protocol::ProviderId;

    struct NoCodec;
    impl WireCodec for NoCodec {
        fn transport(&self) -> TransportKind {
            TransportKind::Http1
        }
        fn encode(&self, _: &ModelRequest) -> Result<WireRequest, ProviderError> {
            unreachable!()
        }
        fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
            unreachable!()
        }
        fn classify(&self, _: &ErrorResponse) -> ProviderError {
            unreachable!()
        }
    }

    struct Dummy {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
    }

    #[async_trait]
    impl ProviderAdapter for Dummy {
        fn id(&self) -> &ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn WireCodec {
            &NoCodec
        }
        fn retry_policy(&self) -> &RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            unreachable!()
        }
    }

    struct Bots;
    #[async_trait]
    impl BotRoutes for Bots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, crate::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, crate::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }

    /// A host over one session header; `apply_hop` writes what Node's `updateSessionRoute` and the
    /// hop write.
    struct Host {
        session: Mutex<Value>,
        config: Obj,
        writes: Mutex<Vec<(Obj, HopWrite)>>,
        windows: Vec<(&'static str, u64)>,
    }

    #[async_trait]
    impl HopHost for Host {
        fn session(&self) -> Option<Value> {
            Some(self.session.lock().unwrap().clone())
        }
        fn config(&self) -> Obj {
            self.config.clone()
        }
        fn bots(&self) -> &dyn BotRoutes {
            &Bots
        }
        fn model_label(&self, _: &str, _: &str) -> String {
            String::new()
        }
        fn error_text(&self, error: &ProviderError) -> String {
            error.message.clone()
        }
        async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
            Ok((provider != "gone").then(|| {
                Arc::new(Dummy {
                    id: ProviderId::from(provider),
                    policy: RetryPolicy::codex_default(),
                    keepalive: KeepaliveSchedule::SPEC,
                }) as Arc<dyn ProviderAdapter>
            }))
        }
        fn raw_context_window(&self, _: &str, model: &str, _: &Value) -> Option<u64> {
            self.windows.iter().find(|(m, _)| *m == model).map(|(_, w)| *w)
        }
        async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
            let mut session = self.session.lock().unwrap();
            let header = session.as_object_mut().unwrap();
            for (key, value) in &route {
                header.insert(key.clone(), value.clone());
            }
            header.insert("routeFallbacks".into(), json!(write.chain));
            if let Some(primary) = &write.primary {
                header.insert("routeFallbackPrimary".into(), primary.clone());
            }
            header.insert("routeFallbackIndex".into(), json!(write.index));
            header.insert("routeFallbackFailures".into(), json!(write.failures));
            self.writes.lock().unwrap().push((route, write));
            Ok(Some(session.clone()))
        }
        fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
            (None, None)
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/route_chain.json")).expect("fixture")
    }

    fn switched(decision: RouteDecision) -> RouteSwitch {
        match decision {
            RouteDecision::Switch(switch) => switch,
            RouteDecision::Surface(s) => panic!("surfaced: {}", s.error.message),
            RouteDecision::Fail(m) => panic!("failed: {m}"),
        }
    }

    /// The error surfaces as it came, with nothing tried to name.
    fn unchanged(decision: RouteDecision, message: &str) -> bool {
        matches!(decision, RouteDecision::Surface(s) if s.error.message == message && s.attempts.is_empty())
    }

    fn host(windows: Vec<(&'static str, u64)>) -> Host {
        let golden = golden();
        Host {
            session: Mutex::new(golden["sessions"]["worker_agent"]["session"].clone()),
            config: golden["config"].as_object().unwrap().clone(),
            writes: Mutex::new(Vec::new()),
            windows,
        }
    }

    fn failure(kind: ErrorKind, status: u16, message: &str) -> ProviderError {
        let mut error = ProviderError::new(kind, DeliveryState::Accepted);
        error.status = Some(status);
        error.message = message.to_owned();
        error
    }

    /// Node's `routeFallbackVerdict` on 24 failures, and `namesUnavailableModel` on 16 texts.
    #[test]
    fn the_verdicts_follow_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/verdict.json")).expect("fixture");
        let cases = golden["cases"].as_object().unwrap();
        let error = |kind: ErrorKind, status: u16, code: Option<&str>, message: &str| {
            let mut e = failure(kind, status, message);
            e.status = (status != 0).then_some(status);
            e.code = code.map(str::to_owned);
            e
        };
        let exposed = |mut e: ProviderError, f: &dyn Fn(&mut ProviderError)| {
            f(&mut e);
            e
        };
        let rate = error(ErrorKind::RateLimited, 429, None, "boom");
        let rows: Vec<(&str, ProviderError)> = vec![
            ("rate_429", rate.clone()),
            ("overloaded_529", error(ErrorKind::Overloaded, 529, None, "boom")),
            ("unavailable_503", error(ErrorKind::Transient, 503, None, "boom")),
            ("auth_401", error(ErrorKind::Auth, 401, None, "boom")),
            ("permission_403", error(ErrorKind::Permission, 403, None, "boom")),
            ("billing_402", error(ErrorKind::Billing, 402, None, "boom")),
            ("transient_500", error(ErrorKind::Transient, 500, None, "boom")),
            ("transient_408", error(ErrorKind::Transient, 408, None, "boom")),
            ("transient_code_only", error(ErrorKind::Transient, 0, Some("econnreset"), "boom")),
            ("transient_no_signal", error(ErrorKind::Unknown, 0, None, "boom")),
            ("invalid_404", error(ErrorKind::InvalidRequest, 404, None, "boom")),
            ("invalid_410", error(ErrorKind::InvalidRequest, 410, None, "boom")),
            ("invalid_plain", error(ErrorKind::InvalidRequest, 400, None, "bad request")),
            ("invalid_model_code", error(ErrorKind::InvalidRequest, 400, Some("model_not_found"), "boom")),
            ("invalid_model_text", error(ErrorKind::InvalidRequest, 400, None, "The model `gpt-9` does not exist")),
            ("invalid_tool_text", error(ErrorKind::InvalidRequest, 400, None, "For model x, tool lookup: route not found")),
            ("context_overflow", error(ErrorKind::ContextOverflow, 400, Some("context_length_exceeded"), "boom")),
            ("rate_text_emitted", exposed(rate.clone(), &|e| e.exposure.text_emitted = true)),
            ("rate_tool_emitted", exposed(rate.clone(), &|e| e.exposure.tool_dispatched = true)),
            ("rate_unsafe", exposed(rate.clone(), &|e| e.unsafe_to_retry = true)),
            ("rate_tool_started", exposed(rate.clone(), &|e| e.exposure.tool_input_cut = true)),
            ("rate_pending_tool", exposed(rate.clone(), &|e| e.exposure.tool_input_cut = true)),
            ("quota_flagged", error(ErrorKind::QuotaExhausted, 429, None, "boom")),
            ("unknown_plain", error(ErrorKind::Unknown, 0, None, "weird")),
        ];
        assert_eq!(rows.len(), cases.len());
        for (id, e) in &rows {
            let want = &cases[*id];
            assert_eq!(kind_name(e.kind), want["kind"], "{id} kind");
            let verdict = match route_fallback_verdict(e) {
                RouteVerdict::Hop => "hop",
                RouteVerdict::Context => "context",
                RouteVerdict::Stay => "stay",
            };
            assert_eq!(json!(verdict), want["verdict"], "{id}");
        }
        for row in golden["names"].as_array().unwrap() {
            assert_eq!(json!(names_unavailable_model(row[0].as_str().unwrap())), row[1], "{}", row[0]);
        }
    }

    #[tokio::test]
    async fn a_hop_writes_the_route_and_the_four_session_fields() {
        let host = Arc::new(host(vec![]));
        let hop = RouteHop::new(host.clone());
        let switch = switched(hop.advance(failure(ErrorKind::RateLimited, 429, "slow down"), None).await);
        assert_eq!(switch.model, "gemini-2.5-pro");
        assert_eq!(switch.notice, "xai/grok-4 rate-limited — switched to gemini/gemini-2.5-pro.");
        let writes = host.writes.lock().unwrap();
        let (route, write) = &writes[0];
        let golden = golden();
        assert_eq!(json!(write.chain), golden["sessions"]["worker_agent"]["live"]["chain"]);
        assert_eq!(write.primary, Some(json!({ "provider": "xai", "model": "grok-4" })));
        assert_eq!(write.index, 1);
        assert_eq!(write.failures, vec![json!({ "provider": "xai", "model": "grok-4", "kind": "rate_limited", "error": "slow down" })]);
        assert!(!write.checkpoint_route_changed);
        assert_eq!(
            Value::Object(route.clone()),
            json!({
                "provider": "gemini", "model": "gemini-2.5-pro", "effort": null, "fast": false, "autoEffort": true,
                "modelParameters": {}, "contextPercent": null, "contextTokens": null, "selectedContextWindow": null,
            })
        );
    }

    #[tokio::test]
    async fn a_chain_that_ran_out_names_every_model_tried() {
        let host = Arc::new(host(vec![]));
        let hop = RouteHop::new(host.clone());
        switched(hop.advance(failure(ErrorKind::RateLimited, 429, "first"), None).await);
        // The session now stands on the last model; the second failure has nowhere to go.
        let RouteDecision::Surface(end) = hop.decide(failure(ErrorKind::QuotaExhausted, 429, "second"), None).await else {
            panic!("the chain ran out")
        };
        assert_eq!(end.error.message, "second\nEvery model in the fallback chain failed — xai/grok-4: first; gemini/gemini-2.5-pro: second");
        assert_eq!(end.error.kind, ErrorKind::QuotaExhausted);
        assert_eq!(end.attempts.len(), 2);
        assert_eq!(end.stopped_before, None);
        // The hop index and failures read back through the readers.
        let session = host.session().unwrap();
        assert!(route_fallback_hopped(&session));
        assert_eq!(session["routeFallbackIndex"], 1);
    }

    #[tokio::test]
    async fn a_context_overflow_hops_only_to_a_larger_window() {
        let smaller = Arc::new(host(vec![("grok-4", 256_000), ("gemini-2.5-pro", 128_000)]));
        let hop = RouteHop::new(smaller.clone());
        let overflow = failure(ErrorKind::ContextOverflow, 400, "too long");
        let RouteDecision::Surface(end) = hop.decide(overflow.clone(), None).await else { panic!("no hop") };
        assert!(smaller.writes.lock().unwrap().is_empty(), "a smaller window is not a hop");
        // Without a prior hop there is nothing to name: the error is unchanged.
        assert_eq!((end.error.message.as_str(), end.attempts.len()), ("too long", 0));
        let larger = Arc::new(host(vec![("grok-4", 128_000), ("gemini-2.5-pro", 1_000_000)]));
        let hop = RouteHop::new(larger.clone());
        let switch = switched(hop.advance(overflow.clone(), None).await);
        assert_eq!(switch.notice, "xai/grok-4 context too long — switched to gemini/gemini-2.5-pro.");
        assert_eq!(larger.writes.lock().unwrap()[0].0["selectedContextWindow"], 1_000_000);
    }

    #[tokio::test]
    async fn a_failure_that_would_fail_anywhere_stays_and_a_session_without_an_agent_never_hops() {
        let host = Arc::new(host(vec![]));
        let hop = RouteHop::new(host.clone());
        assert!(unchanged(hop.advance(failure(ErrorKind::InvalidRequest, 400, "bad request"), None).await, "bad request"));
        host.session.lock().unwrap().as_object_mut().unwrap().shift_remove("agent");
        assert!(unchanged(hop.advance(failure(ErrorKind::RateLimited, 429, "x"), None).await, "x"));
        assert!(host.writes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_provider_that_is_not_there_fails_the_hop_with_nodes_error() {
        let host = Arc::new(host(vec![]));
        host.session.lock().unwrap().as_object_mut().unwrap().insert(
            "routeFallbacks".into(),
            json!([{ "provider": "gone", "model": "m" }]),
        );
        host.session.lock().unwrap().as_object_mut().unwrap().shift_remove("routeFallbackSource");
        let hop = RouteHop::new(host.clone());
        let RouteDecision::Fail(message) = hop.decide(failure(ErrorKind::RateLimited, 429, "x"), None).await else {
            panic!("the hop fails")
        };
        assert_eq!(message, "Provider \"gone\" not available");
        assert!(host.writes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_switch_books_the_left_models_usage_and_the_turn_splits_per_model() {
        let host = Arc::new(host(vec![]));
        let hop = RouteHop::new(host);
        let used = Usage { input_tokens: 100, output_tokens: 20, ..Usage::default() };
        assert!(matches!(hop.decide(failure(ErrorKind::RateLimited, 429, "x"), Some(&used)).await, RouteDecision::Switch(_)));
        let total = Usage { input_tokens: 180, output_tokens: 45, ..Usage::default() };
        let segments = hop.usage_segments(&total, ("gemini", "gemini-2.5-pro"));
        assert_eq!(segments.len(), 2);
        assert_eq!((segments[0].provider.as_str(), segments[0].usage.input_tokens), ("xai", 100));
        assert_eq!((segments[1].model.as_str(), segments[1].usage.input_tokens, segments[1].usage.output_tokens), ("gemini-2.5-pro", 80, 25));
    }

    /// Node's `routeUsageSegments` on five recorded turns.
    #[test]
    fn usage_segments_follow_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/usage_strip.json")).expect("fixture");
        let usage = |v: &Value| Usage {
            input_tokens: v["inputTokens"].as_u64().unwrap_or(0),
            output_tokens: v["outputTokens"].as_u64().unwrap_or(0),
            cache_read_tokens: v["cachedTokens"].as_u64().unwrap_or(0),
            cache_write_tokens: v["cacheWriteTokens"].as_u64().unwrap_or(0),
            cache_write_1h_tokens: v["cacheWrite1hTokens"].as_u64().unwrap_or(0),
            reasoning_tokens: v["reasoningTokens"].as_u64(),
            ..Usage::default()
        };
        for (name, case) in golden["segments"].as_object().unwrap() {
            let hops: Vec<UsageHop> = case["hops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| UsageHop {
                    provider: h["provider"].as_str().unwrap().into(),
                    model: h["model"].as_str().unwrap().into(),
                    usage: (!h["usage"].is_null()).then(|| usage(&h["usage"])),
                })
                .collect();
            let current = (case["current"]["provider"].as_str().unwrap(), case["current"]["model"].as_str().unwrap());
            let got: Vec<Value> = route_usage_segments(&hops, &usage(&case["total"]), current)
                .into_iter()
                .map(|s| {
                    json!({ "provider": s.provider, "model": s.model, "usage": {
                        "input": s.usage.input_tokens, "output": s.usage.output_tokens, "cacheRead": s.usage.cache_read_tokens,
                        "cacheWrite": s.usage.cache_write_tokens, "cacheWrite1h": s.usage.cache_write_1h_tokens, "reasoning": s.usage.reasoning_tokens.unwrap_or(0) } })
                })
                .collect();
            assert_eq!(json!(got), case["want"], "{name}");
        }
    }

    /// Node's `stripProviderReplayMessage`: what stays of a message that carried replay state.
    #[test]
    fn the_replay_strip_keeps_what_the_next_provider_needs() {
        use mixdog_core_api::domain::provider::{Content, Message, ProviderReplay, Role, ToolCall};
        let golden: Value = serde_json::from_str(include_str!("golden/usage_strip.json")).expect("fixture");
        assert_eq!(golden["strip"]["after"], json!(["role", "content", "phase", "toolCalls"]));
        let mut message = Message::new(Role::Assistant, Content::Text("hi".into()));
        message.phase = Some(mixdog_core_api::domain::provider::Phase::Commentary);
        message.tool_calls = vec![ToolCall { id: "t".into(), name: "read".into(), arguments: json!({}), native_type: None }];
        message.thinking_blocks = Some(json!([1]));
        message.assistant_blocks = Some(json!([2]));
        message.push_replay(ProviderReplay { owner: mixdog_protocol::ProviderId::from("p"), items: json!([3]) });
        let plain = strip_provider_replay(&message);
        assert!(plain.provider_replay().is_empty() && plain.thinking_blocks.is_none() && plain.assistant_blocks.is_none());
        assert_eq!((plain.content.clone(), plain.phase, plain.tool_calls.clone()), (message.content.clone(), message.phase, message.tool_calls.clone()));
        // A message with none is the same message.
        assert_eq!(strip_provider_replay(&plain), plain);
        assert_eq!(golden["strip"]["sameObjectWhenPlain"], true);
    }
}