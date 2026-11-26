//! Which providers answer a hosted web search (`session-runtime/native-web-search/
//! routes.mjs`): the configured route chain, or the Main model when the route
//! is the follow-Main default. The pure rules live in
//! `mixdog_ai::service::routes`; this feeds them the live config, the Main
//! route and the catalog rows the host holds.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::routes::DefaultSearchFallback;
use mixdog_ai::service::routes::DefaultSearchRoute;
use mixdog_ai::service::routes::MainRoute;
use mixdog_ai::service::routes::canonical_route_provider;
use mixdog_ai::service::routes::is_default_web_search_route;
use mixdog_ai::service::routes::native_web_search_routes;
use mixdog_ai::service::routes::no_candidate_message_with_reason;
use mixdog_ai::service::routes::route_chain;
use mixdog_ai::service::routes::web_search_provider_family;
use mixdog_ai::service::routes::web_search_route_or_default;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;

use super::hosted_search::SearchCandidate;
use super::hosted_search::SearchFamily;
use super::hosted_search::SearchRouteResolution;
use super::hosted_search::SearchRoutes;

/// What serves a web-search candidate: a Mixdog provider adapter running its
/// hosted search tool, or an ACP agent route whose readiness was checked.
pub enum SearchProvider {
    Hosted(Arc<dyn ProviderAdapter>),
    Acp,
}

/// What the routes and the sender ask of the runtime around them. A failure is
/// the sentence Node threw. Node builds this per runtime (`rt`), so `getRoute()`
/// and `getSession()` are one conversation's; a daemon hosts many, and the
/// asking call's thread names the one whose runtime answers.
#[async_trait]
pub trait SearchHost: Send + Sync {
    /// `getRoute()`: the thread's live Main route (`provider`, `model`, `effort`,
    /// `effectiveEffort`, `fast`, `modelParameters`); `null` when there is none.
    fn main_route(&self, thread: &ThreadId) -> Value;

    /// `ensureFullConfig().webSearchRoute`: the stored route, `null` when the
    /// config has none.
    fn stored_web_search_route(&self) -> Value;

    /// The Main model's catalog row: `provider.getCachedModelInfo(model)`, else
    /// the provider's listing row once it is loaded
    /// (`ensureProvidersReady(ensureProviderEnabled(cfg, provider))` first).
    async fn main_model_row(&self, provider: &str, model: &str) -> Result<Option<Value>, String>;

    /// `getModelMetadataSync(model, provider)`: the global catalog's row.
    fn catalog_row(&self, provider: &str, model: &str) -> Option<Value>;

    /// `ensureProvidersReady(ensureProviderEnabled(cfg, provider))`, then
    /// `getReg().getProvider(provider)` (or `SearchProvider::Acp` for a ready ACP route).
    async fn provider(&self, provider: &str) -> Result<Option<SearchProvider>, String>;

    /// `getSession()?.id`: the session the asking turn runs in.
    fn session_id(&self, thread: &ThreadId) -> Option<String>;

    /// Same-product stand-in route (or failure reason) using already-known
    /// readiness when the default ("follow Main") route's Main model cannot
    /// run native web search itself. Never probes or runs readiness work.
    fn default_search_fallback(&self, _main_provider: &str, _main_model: &str) -> DefaultSearchFallback {
        DefaultSearchFallback::default()
    }
}

pub struct ConfiguredSearchRoutes {
    host: Arc<dyn SearchHost>,
}

impl ConfiguredSearchRoutes {
    pub fn new(host: Arc<dyn SearchHost>) -> Arc<Self> {
        Arc::new(Self { host })
    }

    /// `webSearchRouteOrDefault(cfg.webSearchRoute, getWebSearchRoute())`: an
    /// unset or invalid stored route is the follow-Main default. The facade's own
    /// copy of the route is the config here, so there is no second candidate.
    fn web_search_route(&self) -> Result<Value, String> {
        web_search_route_or_default(&[&self.host.stored_web_search_route()])
    }

    fn main(&self, thread: &ThreadId, catalog_row: Option<Value>) -> MainRoute {
        let route = self.host.main_route(thread);
        let text = |key: &str| route.get(key).and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default().to_owned();
        let effort = [text("effectiveEffort"), text("effort")].into_iter().find(|effort| !effort.is_empty());
        MainRoute {
            provider: text("provider"),
            model: text("model"),
            effort,
            fast: route.get("fast") == Some(&Value::Bool(true)),
            model_parameters: route.get("modelParameters").cloned().unwrap_or(Value::Null),
            catalog_row,
        }
    }
}

fn family_of(provider: &str) -> Option<SearchFamily> {
    Some(match web_search_provider_family(provider) {
        "openai" => SearchFamily::Openai,
        "anthropic" => SearchFamily::Anthropic,
        "gemini" => SearchFamily::Gemini,
        "xai" => SearchFamily::Xai,
        "acp" => SearchFamily::Acp,
        _ => return None,
    })
}

fn fallback_candidate(entry: DefaultSearchRoute) -> Option<SearchCandidate> {
    let provider = canonical_route_provider(&entry.provider);
    let model = mixdog_js::js_trim(&entry.model).to_owned();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some(SearchCandidate {
        family: family_of(&provider)?,
        provider,
        model,
        effort: None,
        fast: false,
        model_parameters: Value::Object(Map::new()),
        tool_type: None,
    })
}

fn push_unique_candidate(out: &mut Vec<SearchCandidate>, candidate: SearchCandidate) {
    if !out.iter().any(|existing| existing.provider == candidate.provider && existing.model == candidate.model) {
        out.push(candidate);
    }
}

impl ConfiguredSearchRoutes {
    async fn resolve_with_reason(&self, thread: &ThreadId) -> Result<(Vec<SearchCandidate>, Value, MainRoute, Option<String>), String> {
        let route = self.web_search_route()?;
        // A cold catalog is loaded once before the capability check, so a Main
        // model never falls back to the bare id.
        let follows_main = route_chain(&route)?.iter().any(is_default_web_search_route);
        let main = self.main(thread, None);
        let row = if follows_main && !main.provider.is_empty() && !main.model.is_empty() {
            self.host.main_model_row(&main.provider, &main.model).await?
        } else {
            None
        };
        let main = MainRoute { catalog_row: row, ..main };
        let global = |provider: &str, model: &str| self.host.catalog_row(provider, model);
        let resolved = native_web_search_routes(&route, Some(&main), &global)?;
        let main_resolved = resolved.iter().any(|candidate| candidate.source == "default-web-search-route");
        let mut out: Vec<SearchCandidate> = resolved
            .into_iter()
            .filter_map(|candidate| {
                Some(SearchCandidate {
                    family: family_of(&candidate.provider)?,
                    provider: candidate.provider,
                    model: candidate.model,
                    effort: candidate.effort,
                    fast: candidate.fast,
                    model_parameters: candidate.model_parameters,
                    tool_type: candidate.tool_type,
                })
            })
            .collect();
        let reason = if follows_main && !main_resolved {
            // User-written fallbacks stay ahead of any automatic same-product stand-in.
            let fallback = self.host.default_search_fallback(&main.provider, &main.model);
            if let Some(entry) = fallback.route
                && let Some(candidate) = fallback_candidate(entry)
            {
                push_unique_candidate(&mut out, candidate);
            }
            if out.is_empty() { fallback.reason } else { None }
        } else {
            None
        };
        Ok((out, route, main, reason))
    }
}

#[async_trait]
impl SearchRoutes for ConfiguredSearchRoutes {
    async fn candidates(&self, thread: &ThreadId) -> Result<Vec<SearchCandidate>, String> {
        self.resolve_with_reason(thread).await.map(|(out, ..)| out)
    }

    async fn no_candidate_message(&self, thread: &ThreadId) -> String {
        // `getWebSearchRoute()` is never unset; an unreadable stored route reads as the default.
        let route = self.web_search_route().unwrap_or(Value::Null);
        let main = self.main(thread, None);
        let reason = is_default_web_search_route(&route).then(|| self.host.default_search_fallback(&main.provider, &main.model).reason).flatten();
        no_candidate_message_with_reason(&route, Some(&main), reason.as_deref())
    }

    async fn resolve(&self, thread: &ThreadId) -> Result<SearchRouteResolution, String> {
        let (out, route, main, reason) = self.resolve_with_reason(thread).await?;
        if out.is_empty() {
            return Ok(SearchRouteResolution::Unavailable(no_candidate_message_with_reason(&route, Some(&main), reason.as_deref())));
        }
        Ok(SearchRouteResolution::Candidates(out))
    }
}
