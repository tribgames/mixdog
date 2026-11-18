//! Which model writes a compaction summary: the conversation's own route (or the model an operator configured for the
//! summary), the Maintainer's route, and the newest lighter model of a subscription provider. Each step is resolved only
//! when reached, and a route whose provider cannot send is refused by name.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::RouteResolver;
use mixdog_agent::compact::summary_run::RouteStep;
use mixdog_agent::compact::summary_run::SummaryCall;
use mixdog_agent::compact::summary_run::SummaryFailure;
use mixdog_agent::compact::summary_run::SummaryResponse;
use mixdog_agent::compact::summary_run::SummaryRoute;
use mixdog_agent::compact::summary_run::SummarySender;
use serde_json::Value;
use serde_json::json;

use super::summary_routes::MaintainerRoute;
use super::summary_routes::SessionRoute;
use super::summary_routes::SummaryHost;
use super::summary_routes::SummaryRoutes;
use super::summary_routes::maintainer_effort;

struct NoSend;

#[async_trait]
impl SummarySender for NoSend {
    async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        unreachable!("resolving a route sends nothing")
    }
}

struct Host {
    session: SessionRoute,
    maintainer: Option<MaintainerRoute>,
    ready: HashSet<String>,
    windows: HashMap<(String, String), u64>,
    catalog: Option<Vec<Value>>,
    /// Every readiness question: the provider, and whether it was asked to initialize.
    asked: Mutex<Vec<(String, bool)>>,
}

impl Host {
    fn new(session: SessionRoute) -> Self {
        Self { session, maintainer: None, ready: HashSet::new(), windows: HashMap::new(), catalog: None, asked: Mutex::default() }
    }

    fn ready(mut self, providers: &[&str]) -> Self {
        self.ready = providers.iter().map(|provider| (*provider).to_owned()).collect();
        self
    }

    fn routes(self) -> (SummaryRoutes, Arc<Host>) {
        let host = Arc::new(self);
        (SummaryRoutes::new(host.clone()), host)
    }
}

#[async_trait]
impl SummaryHost for Host {
    fn session(&self) -> SessionRoute {
        self.session.clone()
    }
    fn maintainer_route(&self) -> Option<MaintainerRoute> {
        self.maintainer.clone()
    }
    async fn provider_ready(&self, provider: &str, init: bool) -> Result<bool, SummaryFailure> {
        self.asked.lock().unwrap().push((provider.to_owned(), init));
        Ok(self.ready.contains(provider))
    }
    fn whole_window(&self, provider: &str, model: &str) -> u64 {
        self.windows.get(&(provider.to_owned(), model.to_owned())).copied().expect("a window is known for the model asked")
    }
    fn calibration(&self, _: &str, _: &str) -> f64 {
        1.25
    }
    fn sender(&self, _: &str) -> Arc<dyn SummarySender> {
        Arc::new(NoSend)
    }
    async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
        self.catalog.clone()
    }
}

fn session(provider: &str, model: &str, window: Option<u64>, summary_model: Option<&str>) -> SessionRoute {
    SessionRoute { provider: provider.into(), model: model.into(), context_window: window, summary_model: summary_model.map(str::to_owned) }
}

async fn resolved(routes: &SummaryRoutes, step: RouteStep) -> Option<SummaryRoute> {
    routes.resolve(step).await.unwrap_or_else(|failure| panic!("{step:?} failed: {failure:?}"))
}

fn failure_text(result: Result<Option<SummaryRoute>, SummaryFailure>) -> String {
    match result {
        Err(SummaryFailure::Failed(text)) => text,
        Err(other) => panic!("a refusal by name, not {other:?}"),
        Ok(_) => panic!("the route should be refused"),
    }
}

#[tokio::test]
async fn the_session_step_summarizes_on_the_conversations_own_model_and_window() {
    let (routes, host) = Host::new(session("openai", "gpt-a", Some(200_000), None)).ready(&["openai"]).routes();
    let route = resolved(&routes, RouteStep::Session).await.expect("a session route");
    assert_eq!((route.provider_name.as_str(), route.model.as_str(), route.context_window, route.fast, route.effort), ("openai", "gpt-a", 200_000, false, None));
    assert_eq!(route.calibration, 1.25);
    assert_eq!(*host.asked.lock().unwrap(), [("openai".to_owned(), false)], "the conversation's own provider is already there: nothing is initialized");
}

#[tokio::test]
async fn a_configured_summary_model_runs_on_the_conversations_provider_with_that_models_whole_window() {
    let mut host = Host::new(session("openai", "gpt-a", Some(200_000), Some("gpt-mini"))).ready(&["openai"]);
    host.windows.insert(("openai".into(), "gpt-mini".into()), 400_000);
    let (routes, _) = host.routes();
    let route = resolved(&routes, RouteStep::Session).await.expect("a session route");
    assert_eq!((route.provider_name.as_str(), route.model.as_str(), route.context_window), ("openai", "gpt-mini", 400_000), "the conversation's own window is for its own model only");
}

#[tokio::test]
async fn a_session_without_a_window_uses_the_models_whole_window() {
    let mut host = Host::new(session("openai", "gpt-a", None, None)).ready(&["openai"]);
    host.windows.insert(("openai".into(), "gpt-a".into()), 128_000);
    let (routes, _) = host.routes();
    assert_eq!(resolved(&routes, RouteStep::Session).await.expect("a route").context_window, 128_000);
}

#[tokio::test]
async fn a_route_whose_provider_cannot_send_is_refused_by_name() {
    let (routes, _) = Host::new(session("openai", "gpt-a", Some(1), None)).routes();
    assert_eq!(failure_text(routes.resolve(RouteStep::Session).await), "compact summary route unavailable: openai/gpt-a");
    let (routes, _) = Host::new(session("", "gpt-a", Some(1), None)).ready(&[""]).routes();
    assert_eq!(failure_text(routes.resolve(RouteStep::Session).await), "compact summary route unavailable: unknown/gpt-a", "no provider reads as unknown");
    let (routes, _) = Host::new(session("openai", "", Some(1), None)).ready(&["openai"]).routes();
    assert_eq!(failure_text(routes.resolve(RouteStep::Session).await), "compact summary route unavailable: openai/unknown");
}

#[tokio::test]
async fn the_maintainer_step_exists_only_when_a_maintainer_model_is_set_and_it_initializes_its_provider() {
    let (routes, _) = Host::new(session("openai", "gpt-a", Some(1), None)).ready(&["openai"]).routes();
    assert!(resolved(&routes, RouteStep::Maintainer).await.is_none(), "an unrelated default is never borrowed");

    let mut host = Host::new(session("openai", "gpt-a", Some(1), None)).ready(&["anthropic"]);
    host.maintainer = Some(MaintainerRoute { provider: "anthropic".into(), model: "haiku".into(), fast: true, effort: "low".into() });
    host.windows.insert(("anthropic".into(), "haiku".into()), 90_000);
    let (routes, host) = host.routes();
    let route = resolved(&routes, RouteStep::Maintainer).await.expect("a maintainer route");
    assert_eq!((route.provider_name.as_str(), route.model.as_str(), route.context_window, route.fast, route.effort.as_deref()), ("anthropic", "haiku", 90_000, true, Some("low")));
    assert_eq!(*host.asked.lock().unwrap(), [("anthropic".to_owned(), true)], "only the maintainer's step initializes its provider");
}

#[tokio::test]
async fn the_lighter_step_is_the_newest_lighter_model_of_a_subscription_provider_and_never_the_model_in_use() {
    let catalog = vec![
        json!({ "id": "claude-haiku-3-5", "family": "haiku" }),
        json!({ "id": "claude-haiku-4-5", "family": "haiku" }),
        json!({ "id": "claude-sonnet-5", "family": "sonnet" }),
    ];
    let lighter = |provider: &str, model: &str, catalog: Option<Vec<Value>>| {
        let mut host = Host::new(session(provider, model, Some(1), None)).ready(&[provider]);
        host.catalog = catalog;
        host.windows.insert((provider.into(), "claude-haiku-4-5".into()), 64_000);
        host.routes().0
    };
    let routes = lighter("anthropic-oauth", "claude-sonnet-5", Some(catalog.clone()));
    let route = resolved(&routes, RouteStep::Lighter).await.expect("a lighter route");
    assert_eq!((route.provider_name.as_str(), route.model.as_str(), route.context_window), ("anthropic-oauth", "claude-haiku-4-5", 64_000));

    assert!(resolved(&lighter("anthropic-oauth", "claude-haiku-4-5", Some(catalog.clone())), RouteStep::Lighter).await.is_none(), "already running on it");
    assert!(resolved(&lighter("anthropic-oauth", "claude-sonnet-5", None), RouteStep::Lighter).await.is_none(), "no saved catalog");
    assert!(resolved(&lighter("anthropic", "claude-sonnet-5", Some(catalog)), RouteStep::Lighter).await.is_none(), "an API-key provider bills per token and has no lighter step");
}

#[test]
fn the_maintainers_effort_is_its_own_trimmed_or_low() {
    let cases = [
        (None, "low"),
        (Some(json!(null)), "low"),
        (Some(json!("")), "low"),
        (Some(json!("   ")), "low"),
        (Some(json!(0)), "low"),
        (Some(json!(false)), "low"),
        (Some(json!(" high ")), "high"),
        (Some(json!("medium")), "medium"),
    ];
    for (effort, expected) in cases {
        assert_eq!(maintainer_effort(effort.as_ref()), expected, "{effort:?}");
    }
}
