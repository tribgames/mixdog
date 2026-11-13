//! Which model writes a compaction summary, and the fork of the session's cached request
//! (Node `session/loop/fresh-context.mjs` route plan and `session/compact/summary-route.mjs`).
//!
//! The order the steps are tried in is `mixdog_agent::compact::summary_run::plan_steps`; this
//! resolves one step to a route, each only when reached.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::{
    ForkRequest, ForkSource, RouteResolver, RouteStep, SummaryFailure, SummaryResponse, SummaryRoute, SummarySender,
};
use mixdog_agent::env::Clock;
use mixdog_ai::service::routes::{compaction_cache_warm, lighter_subscription_model, request_cache_lifetime};
use serde_json::Value;

/// The conversation's own route.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRoute {
    pub provider: String,
    pub model: String,
    /// `sessionRef.contextWindow`, when the session holds one.
    pub context_window: Option<u64>,
    /// `resolveHandoffSummaryModel(sessionRef)`: the model an operator configured for the summary
    /// (`compaction.summaryModel`, else `MIXDOG_AGENT_COMPACT_SUMMARY_MODEL`). The session step
    /// runs on it, on the conversation's own provider; `None` is the conversation's own model.
    pub summary_model: Option<String>,
}

/// The Maintainer's own model: set, and its provider enabled.
#[derive(Clone, Debug, PartialEq)]
pub struct MaintainerRoute {
    pub provider: String,
    pub model: String,
    pub fast: bool,
    /// The route's own effort, trimmed; `low` when it names none (the room Maintainer's step).
    pub effort: String,
}

/// `String(route.effort || '').trim() || 'low'`: the effort a Maintainer route carries.
pub fn maintainer_effort(effort: Option<&serde_json::Value>) -> String {
    use serde_json::Value;
    let text = match effort {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    match mixdog_js::js_trim(&text) {
        "" => "low".to_owned(),
        trimmed => trimmed.to_owned(),
    }
}

/// What the route plan reads from the runtime around it.
#[async_trait]
pub trait SummaryHost: Send + Sync {
    fn session(&self) -> SessionRoute;
    /// `resolveMaintenanceRoute({ agent: 'cycle1-agent', includeDefault: false })` when the route
    /// names a model and `config.providers[provider].enabled !== false`; an unrelated global
    /// default is never borrowed.
    fn maintainer_route(&self) -> Option<MaintainerRoute>;
    /// `getProvider(provider)` can send, after `initProviders(...)` when `init`. An abort
    /// propagates as [`SummaryFailure::Aborted`]; a provider that is not there is `Ok(false)`.
    async fn provider_ready(&self, provider: &str, init: bool) -> Result<bool, SummaryFailure>;
    /// `resolveSessionContextMeta(provider, model, {}, { wholeWindow: true }).contextWindow`.
    fn whole_window(&self, provider: &str, model: &str) -> u64;
    /// `providerTokenCalibration`.
    fn calibration(&self, provider: &str, model: &str) -> f64;
    fn sender(&self, provider: &str) -> Arc<dyn SummarySender>;
    /// The provider's saved account catalog (disk cache, no auth or network on the compaction
    /// path); `None` without one.
    async fn saved_catalog(&self, provider: &str) -> Option<Vec<Value>>;
}

pub struct SummaryRoutes {
    host: Arc<dyn SummaryHost>,
}

impl SummaryRoutes {
    pub fn new(host: Arc<dyn SummaryHost>) -> Self {
        Self { host }
    }

    /// `summaryRoute`: the provider, its model and the window the summary request must fit. Only
    /// the Maintainer's step initializes providers (`resolveMaintainerRoute`); the session and
    /// lighter steps run on the conversation's own provider, which is already there.
    async fn route(
        &self,
        step: RouteStep,
        provider: &str,
        model: &str,
        fast: bool,
        effort: Option<String>,
    ) -> Result<SummaryRoute, SummaryFailure> {
        let ready = !provider.is_empty() && !model.is_empty() && self.host.provider_ready(provider, step == RouteStep::Maintainer).await?;
        if !ready {
            let shown = |text: &str| if text.is_empty() { "unknown".to_owned() } else { text.to_owned() };
            return Err(SummaryFailure::Failed(format!(
                "compact summary route unavailable: {}/{}",
                shown(provider),
                shown(model)
            )));
        }
        let session = self.host.session();
        let same_model = provider == session.provider && model == session.model;
        let context_window = match session.context_window.filter(|w| *w > 0) {
            Some(window) if same_model => window,
            _ => self.host.whole_window(provider, model),
        };
        Ok(SummaryRoute {
            step,
            provider_name: provider.to_owned(),
            model: model.to_owned(),
            context_window,
            calibration: self.host.calibration(provider, model),
            fast,
            effort,
            sender: self.host.sender(provider),
        })
    }

    async fn session_route(&self) -> Result<SummaryRoute, SummaryFailure> {
        // `model: resolveHandoffSummaryModel(sessionRef) || model` (`pre-send-compact.mjs`, `compaction-runner.mjs`), then
        // `resolveSessionRoute`: the session's provider with that model. The window is the conversation's own only for its own model.
        let session = self.host.session();
        let model = session.summary_model.as_deref().filter(|model| !model.is_empty()).unwrap_or(&session.model);
        self.route(RouteStep::Session, &session.provider, model, false, None).await
    }
}

#[async_trait]
impl RouteResolver for SummaryRoutes {
    async fn resolve(&self, step: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure> {
        match step {
            RouteStep::Session => self.session_route().await.map(Some),
            RouteStep::Maintainer => match self.host.maintainer_route() {
                None => Ok(None),
                Some(route) => {
                    self.route(RouteStep::Maintainer, &route.provider, &route.model, route.fast, Some(route.effort)).await.map(Some)
                }
            },
            // The newest lighter model of a subscription provider's saved catalog; none on any
            // other provider, without a saved catalog, when none is listed, or when the
            // conversation already runs on it.
            RouteStep::Lighter => {
                let session = self.session_route().await?;
                let catalog = self.host.saved_catalog(&session.provider_name).await.unwrap_or_default();
                match lighter_subscription_model(&session.provider_name, &catalog) {
                    Some(lighter) if lighter != session.model => {
                        self.route(RouteStep::Lighter, &session.provider_name, &lighter, false, None).await.map(Some)
                    }
                    _ => Ok(None),
                }
            }
        }
    }
}

/// The session's latest request as the side-question store keeps it
/// (`sideQuestionRequestSnapshot`), for the facts a fork reads.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedRequest {
    pub provider_name: String,
    pub model: String,
    /// The request's cache strategy `messages` tier (`5m`/`1h`/`none`).
    pub messages_tier: Option<String>,
    /// `getCachedModelInfo(model) ?? getModelMetadataSync(model, provider)` marks prompt caching.
    pub catalog_supports_prompt_caching: bool,
    /// When the provider read (and refreshed) its prompt cache; epoch ms.
    pub sent_at: u64,
    /// The reply settled.
    pub settled: bool,
    /// A compaction rewrote the transcript since it was sent.
    pub compacted: bool,
    /// Tokens of the forked messages plus the tool-schema reserve.
    pub prompt_tokens: u64,
    pub shared_prefix_messages: usize,
}

/// Sends the forked request on a route. Cancel-safe.
#[async_trait]
pub trait ForkSender: Send + Sync {
    async fn send(&self, route: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure>;
}

/// `compactionForkRequest` and `compactionCacheWarm` of one session at one moment.
pub struct SessionFork {
    saved: Option<SavedRequest>,
    clock: Arc<dyn Clock>,
    sender: Arc<dyn ForkSender>,
}

impl SessionFork {
    pub fn new(saved: Option<SavedRequest>, clock: Arc<dyn Clock>, sender: Arc<dyn ForkSender>) -> Self {
        Self { saved, clock, sender }
    }

    /// The saved request a compaction summary may fork: one whose reply settled and whose
    /// transcript no compaction has rewritten since it was sent.
    fn forkable(&self) -> Option<&SavedRequest> {
        self.saved.as_ref().filter(|r| r.settled && !r.compacted)
    }
}

#[async_trait]
impl ForkSource for SessionFork {
    fn warm(&self) -> bool {
        let request = self.forkable().map(|r| {
            (request_cache_lifetime(&r.provider_name, r.messages_tier.as_deref(), r.catalog_supports_prompt_caching), r.sent_at)
        });
        compaction_cache_warm(request, self.clock.now_ms().max(0) as u64)
    }

    fn request(&self) -> Option<ForkRequest> {
        self.forkable().map(|r| ForkRequest {
            provider_name: r.provider_name.clone(),
            model: r.model.clone(),
            prompt_tokens: r.prompt_tokens,
            shared_prefix_messages: r.shared_prefix_messages,
        })
    }

    async fn send(&self, route: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        self.sender.send(route).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Quiet;
    #[async_trait]
    impl SummarySender for Quiet {
        async fn send(&self, _: &str, _: &str, _: &mixdog_agent::compact::summary_run::SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!()
        }
    }

    struct Host {
        session: SessionRoute,
        maintainer: Option<MaintainerRoute>,
        missing: &'static [&'static str],
        catalog: Option<Vec<Value>>,
    }

    #[async_trait]
    impl SummaryHost for Host {
        fn session(&self) -> SessionRoute {
            self.session.clone()
        }
        fn maintainer_route(&self) -> Option<MaintainerRoute> {
            self.maintainer.clone()
        }
        async fn provider_ready(&self, provider: &str, _: bool) -> Result<bool, SummaryFailure> {
            Ok(!self.missing.contains(&provider))
        }
        fn whole_window(&self, _: &str, model: &str) -> u64 {
            if model == "claude-haiku-4-5" { 200_000 } else { 400_000 }
        }
        fn calibration(&self, _: &str, _: &str) -> f64 {
            1.25
        }
        fn sender(&self, _: &str) -> Arc<dyn SummarySender> {
            Arc::new(Quiet)
        }
        async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
            self.catalog.clone()
        }
    }

    fn host(provider: &str, model: &str) -> Host {
        Host {
            session: SessionRoute { provider: provider.into(), model: model.into(), context_window: Some(272_000), summary_model: None },
            maintainer: None,
            missing: &[],
            catalog: None,
        }
    }

    #[tokio::test]
    async fn the_conversations_own_window_is_reused_only_for_its_own_model() {
        let mut h = host("openai-oauth", "gpt-5");
        h.maintainer = Some(MaintainerRoute { provider: "openai-oauth".into(), model: "gpt-5".into(), fast: true, effort: "low".into() });
        let routes = SummaryRoutes::new(Arc::new(h));
        let own = routes.resolve(RouteStep::Session).await.unwrap().unwrap();
        assert_eq!((own.context_window, own.calibration, own.fast), (272_000, 1.25, false));
        let same = routes.resolve(RouteStep::Maintainer).await.unwrap().unwrap();
        assert_eq!((same.step, same.context_window, same.fast), (RouteStep::Maintainer, 272_000, true));
        let mut other = host("openai-oauth", "gpt-5");
        other.maintainer = Some(MaintainerRoute { provider: "anthropic".into(), model: "claude-haiku-4-5".into(), fast: false, effort: "low".into() });
        let routes = SummaryRoutes::new(Arc::new(other));
        assert_eq!(routes.resolve(RouteStep::Maintainer).await.unwrap().unwrap().context_window, 200_000);
    }

    /// `model: resolveHandoffSummaryModel(sessionRef) || model` into `resolveSessionRoute` (`fresh-context.mjs`): the session step
    /// runs on the configured summary model under the conversation's provider, with that model's whole window (`sameModel` is
    /// false), and the lighter step compares against it (`lighter === session.model`).
    #[tokio::test]
    async fn a_configured_summary_model_is_the_session_steps_model() {
        let mut h = host("anthropic-oauth", "claude-sonnet-4");
        h.session.summary_model = Some("claude-haiku-4-5".into());
        h.catalog = Some(vec![serde_json::json!({ "id": "claude-haiku-4-5", "family": "haiku" })]);
        let routes = SummaryRoutes::new(Arc::new(h));
        let own = routes.resolve(RouteStep::Session).await.unwrap().unwrap();
        assert_eq!((own.step, own.provider_name.as_str(), own.model.as_str(), own.context_window), (RouteStep::Session, "anthropic-oauth", "claude-haiku-4-5", 200_000));
        assert!(routes.resolve(RouteStep::Lighter).await.unwrap().is_none(), "the summary already runs on the lighter model");
        // The conversation's own model named as the summary model keeps the conversation's window.
        let mut same = host("openai-oauth", "gpt-5");
        same.session.summary_model = Some("gpt-5".into());
        assert_eq!(SummaryRoutes::new(Arc::new(same)).resolve(RouteStep::Session).await.unwrap().unwrap().context_window, 272_000);
    }

    /// `String(route.effort || '').trim() || 'low'`, values checked against Node.
    #[test]
    fn the_maintainer_effort_reads_as_node_does() {
        use serde_json::json;
        let cases = [
            (None, "low"),
            (Some(json!(null)), "low"),
            (Some(json!("")), "low"),
            (Some(json!("  high ")), "high"),
            (Some(json!(0)), "low"),
            (Some(json!(5)), "5"),
            (Some(json!(true)), "true"),
            (Some(json!(false)), "low"),
            (Some(json!(" \u{a0} ")), "low"),
            (Some(json!([])), "low"),
            (Some(json!([" a "])), "a"),
            (Some(json!({})), "[object Object]"),
        ];
        for (value, want) in cases {
            assert_eq!(maintainer_effort(value.as_ref()), want, "{value:?}");
        }
    }

    #[tokio::test]
    async fn no_maintainer_is_no_route_and_an_unavailable_provider_is_named() {
        let routes = SummaryRoutes::new(Arc::new(host("openai-oauth", "gpt-5")));
        assert!(routes.resolve(RouteStep::Maintainer).await.unwrap().is_none());
        let mut gone = host("openai-oauth", "gpt-5");
        gone.missing = &["openai-oauth"];
        let routes = SummaryRoutes::new(Arc::new(gone));
        let Err(SummaryFailure::Failed(text)) = routes.resolve(RouteStep::Session).await else { panic!("fails") };
        assert_eq!(text, "compact summary route unavailable: openai-oauth/gpt-5");
        let mut empty = host("", "");
        empty.session.context_window = None;
        let Err(SummaryFailure::Failed(text)) = SummaryRoutes::new(Arc::new(empty)).resolve(RouteStep::Session).await else {
            panic!("fails")
        };
        assert_eq!(text, "compact summary route unavailable: unknown/unknown");
    }

    #[tokio::test]
    async fn the_lighter_step_needs_a_newer_catalog_model_than_the_conversations_own() {
        let catalog = vec![
            serde_json::json!({ "id": "claude-haiku-4-5", "family": "haiku" }),
            serde_json::json!({ "id": "claude-opus-4-1", "family": "opus" }),
        ];
        let mut h = host("anthropic-oauth", "claude-sonnet-4");
        h.catalog = Some(catalog.clone());
        let lighter = SummaryRoutes::new(Arc::new(h)).resolve(RouteStep::Lighter).await.unwrap().unwrap();
        assert_eq!((lighter.step, lighter.model.as_str(), lighter.context_window), (RouteStep::Lighter, "claude-haiku-4-5", 200_000));
        let mut already = host("anthropic-oauth", "claude-haiku-4-5");
        already.catalog = Some(catalog);
        assert!(SummaryRoutes::new(Arc::new(already)).resolve(RouteStep::Lighter).await.unwrap().is_none());
        assert!(SummaryRoutes::new(Arc::new(host("anthropic-oauth", "claude-sonnet-4"))).resolve(RouteStep::Lighter).await.unwrap().is_none());
        assert!(SummaryRoutes::new(Arc::new(host("openai", "gpt-5"))).resolve(RouteStep::Lighter).await.unwrap().is_none());
    }

    struct Fixed(i64);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }
    struct NoSend;
    #[async_trait]
    impl ForkSender for NoSend {
        async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!()
        }
    }

    fn saved(provider: &str, tier: Option<&str>, sent_at: u64) -> SavedRequest {
        SavedRequest {
            provider_name: provider.into(),
            model: "m".into(),
            messages_tier: tier.map(str::to_owned),
            catalog_supports_prompt_caching: false,
            sent_at,
            settled: true,
            compacted: false,
            prompt_tokens: 10,
            shared_prefix_messages: 3,
        }
    }

    #[test]
    fn a_fork_is_warm_inside_the_cache_lifetime_less_its_margin() {
        let fork = |saved: Option<SavedRequest>, now| SessionFork::new(saved, Arc::new(Fixed(now)), Arc::new(NoSend));
        // Anthropic 5m tier: lifetime 300 000, margin 30 000.
        assert!(fork(Some(saved("anthropic", Some("5m"), 0)), 269_999).warm());
        assert!(!fork(Some(saved("anthropic", Some("5m"), 0)), 270_000).warm());
        assert!(fork(Some(saved("openai-oauth", None, 0)), 99_999_999).warm(), "never expires");
        assert!(!fork(None, 0).warm());
        let mut unsettled = saved("openai-oauth", None, 0);
        unsettled.settled = false;
        assert!(!fork(Some(unsettled), 0).warm() && fork(None, 0).request().is_none());
        let mut compacted = saved("openai-oauth", None, 0);
        compacted.compacted = true;
        assert!(fork(Some(compacted), 0).request().is_none(), "a rewritten transcript is not forkable");
        let request = fork(Some(saved("openai", None, 0)), 0).request().unwrap();
        assert_eq!((request.prompt_tokens, request.shared_prefix_messages), (10, 3));
    }
}
