//! `setWebSearchRoute`: validate a native web-search route against the live catalog and answer
//! the route to store (`model-route/web-search-route.mjs`).

use mixdog_ai::service::admin_route::ensure_provider_enabled;
use mixdog_ai::service::admin_route::selection_fast_capable;
use mixdog_ai::service::routes::WEB_SEARCH_DEFAULT_MODEL;
use mixdog_ai::service::routes::WEB_SEARCH_DEFAULT_PROVIDER;
use mixdog_ai::service::routes::is_default_web_search_route;
use mixdog_ai::service::routes::is_web_search_capable_provider;
use mixdog_ai::service::routes::normalize_web_search_route_config;
use mixdog_ai::service::routes::route_chain;
use mixdog_ai::service::routes::web_search_route_or_default;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::WorkflowHost;
use super::ids::Doc;
use super::ids::clean;
use super::ids::has_own;
use super::ids::truthy;

/// `getWebSearchRoute()`: the stored route, the follow-Main marker when there is none.
pub(crate) fn current(agent: &Doc) -> Result<Value, String> {
    let stored = agent.get("webSearchRoute").unwrap_or(&Value::Null);
    web_search_route_or_default(&[stored])
}

/// `normalizeWebSearchRouteConfig(route)` of a stored route.
pub(crate) fn normalized(route: Option<&Value>) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    Ok(normalize_web_search_route_config(route.unwrap_or(&Value::Null), &empty)?.unwrap_or(Value::Null))
}

/// `resolveExplicitRoute`: a concrete provider and model, validated against the live catalog.
async fn resolve_explicit(agent: &Doc, entry: &Value, host: &dyn WorkflowHost) -> Result<Value, String> {
    let provider = clean(entry.get("provider"));
    let model = clean(entry.get("model"));
    if !is_web_search_capable_provider(&provider) {
        return Err(format!("provider \"{provider}\" does not support Mixdog native web search"));
    }
    host.ensure_providers_ready(ensure_provider_enabled(agent, &provider)).await?;
    let meta = host.lookup_model_meta(&provider, &model).await;
    if !host.web_search_capable(&provider, meta.as_ref()) {
        return Err(format!("model \"{model}\" is not marked as web-search capable"));
    }
    // The route keeps its own effort and fast: the shared `modelSettings` bucket belongs to the
    // Main route alone.
    let requested = entry.get("effort").filter(|effort| truthy(Some(*effort)));
    let effort = requested.and_then(|effort| host.coerce_effort(&provider, meta.as_ref(), &clean(Some(effort))));
    let fast_capable = selection_fast_capable(meta.as_ref(), || {
        host.fast_capable(&provider, meta.as_ref(), effort.as_deref(), entry.get("modelParameters"))
    });
    let mut route = entry.as_object().cloned().unwrap_or_default();
    if let Some(effort) = effort {
        route.insert("effort".into(), Value::String(effort));
    }
    route.insert("fast".into(), Value::Bool(fast_capable && entry.get("fast") == Some(&Value::Bool(true))));
    normalized(Some(&Value::Object(route)))
}

/// The route `setWebSearchRoute(next)` stores.
pub(crate) async fn plan(agent: &Doc, next: &Value, host: &dyn WorkflowHost) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let sent = if truthy(Some(next)) { next } else { &empty };
    let reset = has_own(sent, "provider") && clean(sent.get("provider")).is_empty();
    let selected = if reset {
        let mut marker = json!({ "provider": WEB_SEARCH_DEFAULT_PROVIDER, "model": WEB_SEARCH_DEFAULT_MODEL });
        if let Some(tool_type) = sent.get("toolType").filter(|tool_type| truthy(Some(*tool_type))) {
            marker["toolType"] = tool_type.clone();
        }
        normalize_web_search_route_config(&marker, &empty)?
    } else {
        normalize_web_search_route_config(next, &current(agent)?)?
    };
    let selected = selected.ok_or("web search route requires provider and model")?;
    let mut resolved = Vec::new();
    for entry in route_chain(&selected)? {
        resolved.push(if is_default_web_search_route(&entry) { entry } else { resolve_explicit(agent, &entry, host).await? });
    }
    let mut chain = resolved.into_iter();
    let mut primary = chain.next().and_then(|route| route.as_object().cloned()).unwrap_or_default();
    primary.insert("fallbacks".into(), Value::Array(chain.collect()));
    normalized(Some(&Value::Object(primary)))
}
