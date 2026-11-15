//! `setWebSearchRoute` refuses a route no native search can serve, with the sentences Node threw
//! (`model-route/web-search-route.mjs`), and refuses before anything is switched on for it.

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;

use super::WorkflowHost;
use super::ids::Doc;
use super::search::plan;

/// A host whose models are all web-search capable or none is, counting what the refusal must not reach.
struct Host {
    capable: bool,
    enabled: AtomicUsize,
}

#[async_trait]
impl WorkflowHost for Host {
    fn main_route(&self) -> Value {
        json!({ "provider": "openai", "model": "main-model" })
    }
    async fn adopt_lead_route(&self, _selection: Value) {}
    async fn custom_agent_ids(&self) -> Vec<String> {
        Vec::new()
    }
    fn provider_available(&self, _provider: &str) -> bool {
        true
    }
    fn require_local_provider_management(&self) -> Result<(), String> {
        Ok(())
    }
    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn after_credential_change(&self) {}
    async fn ensure_providers_ready(&self, _providers: Doc) -> Result<(), String> {
        self.enabled.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn lookup_model_meta(&self, _provider: &str, _model: &str) -> Option<Value> {
        None
    }
    fn web_search_capable(&self, _provider: &str, _meta: Option<&Value>) -> bool {
        self.capable
    }
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        false
    }
    fn web_search_route_saved(&self, _route: &Value) {}
}

fn host(capable: bool) -> Host {
    Host { capable, enabled: AtomicUsize::new(0) }
}

#[tokio::test]
async fn a_provider_without_native_search_is_refused_with_the_old_sentence_before_it_is_switched_on() {
    let host = host(true);
    for provider in ["ollama", "deepseek", "nope"] {
        let refused = plan(&Doc::new(), &json!({ "provider": provider, "model": "any-model" }), &host).await.unwrap_err();
        assert_eq!(refused, format!("provider \"{provider}\" does not support Mixdog native web search"));
    }
    assert_eq!(host.enabled.load(Ordering::SeqCst), 0, "the refusal comes before the provider is enabled");
}

#[tokio::test]
async fn a_fallback_without_native_search_refuses_the_whole_route() {
    let host = host(true);
    let next = json!({ "provider": "openai", "model": "gpt-5", "fallbacks": [{ "provider": "ollama", "model": "llama" }] });
    let refused = plan(&Doc::new(), &next, &host).await.unwrap_err();
    assert_eq!(refused, "provider \"ollama\" does not support Mixdog native web search");
}

#[tokio::test]
async fn a_model_not_marked_for_web_search_is_refused_and_a_capable_one_is_kept() {
    let refused = plan(&Doc::new(), &json!({ "provider": "openai", "model": "plain-model" }), &host(false)).await.unwrap_err();
    assert_eq!(refused, "model \"plain-model\" is not marked as web-search capable");
    let kept = plan(&Doc::new(), &json!({ "provider": "openai", "model": "gpt-5" }), &host(true)).await.unwrap();
    assert_eq!((kept["provider"].as_str(), kept["model"].as_str()), (Some("openai"), Some("gpt-5")));
}

#[tokio::test]
async fn the_follow_main_marker_needs_no_native_search() {
    let kept = plan(&Doc::new(), &json!({ "provider": "", "model": "" }), &host(false)).await.unwrap();
    assert_eq!((kept["provider"].as_str(), kept["model"].as_str()), (Some("default"), Some("default")));
}
