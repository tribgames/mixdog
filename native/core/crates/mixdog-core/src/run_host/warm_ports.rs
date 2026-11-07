//! The three ports of the cache warmer's `ProcessWarmDeps` (`session/cache-warm.mjs`
//! `DEFAULT_DEPS`): the setting, what the session runtime knows, and what the provider registry
//! knows. Each reads one object the process already has.
//!
//! * [`ConfigWarm`]: `loadConfig({ secrets: false })`.
//! * [`SessionsWarm`]: `isTurnInFlight(runtimeState.get(id))` over the session directory the
//!   [`NextRequestSource`] is bound to, and `lastSentMainRequest(id)` through that source.
//! * [`ProvidersWarm`]: `providersInitialized()`, `registeredProvider(name)`, the fast-mode price
//!   fact and the registered provider's `sendCacheWarm` behind the account gate.
//!
//! The request a restart re-arm replays is rebuilt by the directory ([`NextRequestSource::last_sent`])
//! from the registry's own provider. It keeps that registration's generation, so
//! `registeredProvider(name) === request.provider` is the generation still being the live one:
//! a provider a later sync replaced ends the chain. The tail reminder is read at each warm
//! ([`WarmTail`]), not kept from the rebuild.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::with_tail_reminder;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::providers::anthropic::fast_mode;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::warmer::chain::{WarmRequest, WarmTarget};
use mixdog_ai::warmer::gate::AccountGate;
use mixdog_ai::warmer::plan::CacheStrategy;
use mixdog_ai::warmer::process::{WarmConfig, WarmProviders, WarmSessions};
use mixdog_ai::warmer::send::{Deadlines, gate_target};
use mixdog_ai::warmer::stores::Log;
use mixdog_ai::warmer::stream::{WarmFailure, WarmUsage};
use mixdog_core_api::domain::cache_warm::WarmContext;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_session::session::home_threads::DirectoryHomeThreads;
use mixdog_services::bots::delivery::env::HomeThreads;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::builder_env::CatalogCaps;
use super::next_request_source::NextRequestSource;

/// `loadConfig({ secrets: false })`: the agent config as the settings code reads it.
pub struct ConfigWarm {
    config: Config,
}

impl ConfigWarm {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
}

impl WarmConfig for ConfigWarm {
    fn load(&self) -> Value {
        Value::Object(self.config.agent())
    }
}

/// `withTailReminder`'s session context, read when a warm is built: the reminder text for a session
/// and model from the session's response language and role as they are now.
pub trait WarmTail: Send + Sync {
    /// `Err` when the session cannot be read now.
    fn text(&self, session_id: &str, model: &str) -> Result<Option<String>, String>;
}

impl WarmTail for NextRequestSource {
    fn text(&self, session_id: &str, model: &str) -> Result<Option<String>, String> {
        self.tail_text(&ThreadId::from(session_id), model)
    }
}

/// What the session runtime knows. `next` is the source `build_directory` binds to the directory
/// (the one passed as `TurnPathParts.next`); before that it answers as for a thread that does not
/// exist. `tail` reads the session's reminder context at each warm: the root passes the same
/// `next`.
pub struct SessionsWarm {
    next: Arc<NextRequestSource>,
    registry: Arc<ProviderRegistry>,
    caps: CatalogCaps,
    tail: Arc<dyn WarmTail>,
}

impl SessionsWarm {
    pub fn new(next: Arc<NextRequestSource>, registry: Arc<ProviderRegistry>, caps: CatalogCaps, tail: Arc<dyn WarmTail>) -> Self {
        Self { next, registry, caps, tail }
    }
}

#[async_trait]
impl WarmSessions for SessionsWarm {
    fn turn_in_flight(&self, session_id: &str) -> bool {
        let Some((directory, _)) = self.next.bound() else { return false };
        let Some(directory) = directory.upgrade() else { return false };
        DirectoryHomeThreads::new(directory).turn_in_flight(session_id)
    }

    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        let Some(sent) = self.next.last_sent(&ThreadId::from(session_id)).await else { return Ok(None) };
        let model = sent.material.request.model.clone();
        Ok(Some(Arc::new(SavedWarm {
            has_warm_mode: self.registry.has_warm_mode(&sent.provider_name),
            effort_levels_empty: self.caps.effort_levels_empty(&model),
            session_id: session_id.to_owned(),
            provider_name: sent.provider_name,
            request: sent.material.request,
            sent_at: sent.sent_at as f64,
            owner_session_id: sent.owner_session_id,
            provider_generation: self.registry.generation_of(&sent.material.provider),
            tail: self.tail.clone(),
        })))
    }
}

/// The request a warm replays (`side-question-store.mjs` snapshot) and the facts the warmer reads
/// of it. `request` is kept without the tail reminder; [`WarmRequest::warm_request`] adds the one
/// of the moment (`cacheWarmSend`).
struct SavedWarm {
    session_id: String,
    provider_name: String,
    request: ModelRequest,
    sent_at: f64,
    owner_session_id: Option<String>,
    /// The registration of the provider instance the request was rebuilt on.
    provider_generation: Option<u64>,
    tail: Arc<dyn WarmTail>,
    has_warm_mode: bool,
    effort_levels_empty: bool,
}

impl SavedWarm {
    fn parameter(&self, key: &str) -> Option<&Value> {
        self.request.options.model_parameters.as_ref()?.get(key)
    }
}

impl WarmRequest for SavedWarm {
    fn provider_name(&self) -> &str {
        &self.provider_name
    }

    fn model(&self) -> &str {
        &self.request.model
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn sent_at(&self) -> f64 {
        self.sent_at
    }

    fn request_kind(&self) -> Option<&str> {
        self.request.options.request_kind.as_deref()
    }

    fn cache_strategy(&self) -> Option<CacheStrategy> {
        self.parameter("cacheStrategy").and_then(CacheStrategy::from_value)
    }

    fn thinking_budget_tokens(&self) -> f64 {
        let budget = mixdog_js::to_number_of(self.parameter("thinkingBudgetTokens"));
        if budget > 0.0 { budget } else { 0.0 }
    }

    fn has_effort(&self) -> bool {
        self.request.options.effort.as_deref().is_some_and(|effort| !effort.is_empty())
    }

    fn effort_levels_empty(&self) -> bool {
        self.effort_levels_empty
    }

    fn has_warm_mode(&self) -> bool {
        self.has_warm_mode
    }

    fn owner_session_id(&self) -> Option<&str> {
        self.owner_session_id.as_deref()
    }

    fn fast(&self) -> bool {
        self.request.options.fast
    }

    fn warm_request(&self) -> Result<ModelRequest, String> {
        let reminder = self.tail.text(&self.session_id, &self.request.model)?;
        Ok(with_tail_reminder(&self.request, reminder.as_deref()))
    }

    fn provider_generation(&self) -> Option<u64> {
        self.provider_generation
    }
}

/// `registeredProvider(name) === request.provider`: the instance the request was rebuilt on is
/// still the registered one.
fn provider_current(registry: &ProviderRegistry, request: &dyn WarmRequest) -> bool {
    request.provider_generation().is_some() && registry.generation(request.provider_name()) == request.provider_generation()
}

/// What the provider registry knows, and the gate and deadlines a warm goes out under.
pub struct ProvidersWarm {
    registry: Arc<ProviderRegistry>,
    catalog: Arc<CatalogService>,
    gate: Arc<AccountGate>,
    deadlines: Deadlines,
    log: Log,
}

impl ProvidersWarm {
    pub fn new(registry: Arc<ProviderRegistry>, catalog: Arc<CatalogService>, gate: Arc<AccountGate>, deadlines: Deadlines, log: Log) -> Self {
        Self { registry, catalog, gate, deadlines, log }
    }
}

#[async_trait]
impl WarmProviders for ProvidersWarm {
    async fn ready(&self) {
        self.registry.wait_initialized().await;
    }

    async fn current(&self, request: &dyn WarmRequest) -> bool {
        provider_current(&self.registry, request)
    }

    fn fast_priced(&self, request: &dyn WarmRequest) -> bool {
        request.fast() && self.catalog.supports_anthropic_fast_mode(request.model()) && fast_mode::process().available(fast_mode::now_ms())
    }

    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        let Some(adapter) = self.registry.registered(request.provider_name()) else {
            return Err(WarmFailure::new("provider is not registered"));
        };
        let Some(warm) = adapter.cache_warm() else {
            return Err(WarmFailure::new("provider has no cache-warm mode"));
        };
        let sent = request.warm_request().map_err(WarmFailure::new)?;
        let at = gate_target(request, target);
        let log = self.log.clone();
        let report = move |line: &str| log(line);
        let ctx = WarmContext { gate: self.gate.as_ref(), target: &at, deadlines: self.deadlines, report: &report };
        warm.send_cache_warm(&sent, &ctx, cancel, on_usage).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::{Content, Message, MessageSource, ProviderAdapter, RequestOptions, Role};
    use mixdog_ai::registry::providers::ProviderBuilder;
    use serde_json::json;

    use super::*;

    /// The reminder the session's context gives right now; a test changes it between two warms.
    struct Reminder(Mutex<Result<Option<String>, String>>);

    impl Reminder {
        fn saying(text: &str) -> Arc<Self> {
            Arc::new(Self(Mutex::new(Ok(Some(text.to_owned())))))
        }
    }

    impl WarmTail for Reminder {
        fn text(&self, _: &str, _: &str) -> Result<Option<String>, String> {
            self.0.lock().unwrap().clone()
        }
    }

    fn saved(parameters: Value, effort: Option<&str>, fast: bool, tail: Arc<dyn WarmTail>) -> SavedWarm {
        let options = RequestOptions { model_parameters: Some(parameters), effort: effort.map(str::to_owned), fast, ..RequestOptions::default() };
        SavedWarm {
            session_id: "s1".to_owned(),
            provider_name: "anthropic-oauth".to_owned(),
            request: ModelRequest {
                model: "claude-opus-4-7".to_owned(),
                messages: vec![Message::new(Role::User, Content::Text("hi".to_owned()))],
                tools: Vec::new(),
                options,
            },
            sent_at: 5.0,
            owner_session_id: Some("lead".to_owned()),
            provider_generation: Some(1),
            tail,
            has_warm_mode: true,
            effort_levels_empty: false,
        }
    }

    fn tail_text(request: &ModelRequest) -> Option<String> {
        let last = request.messages.last()?;
        match (&last.source, &last.content) {
            (Some(MessageSource::TailReminder), Content::Text(text)) => Some(text.clone()),
            _ => None,
        }
    }

    /// The facts `cacheWarmIneligibility` reads come from the request's options.
    #[test]
    fn the_saved_request_answers_the_facts_the_warmer_reads_of_it() {
        let request = saved(
            json!({ "cacheStrategy": { "messages": "1h", "system": "5m" }, "thinkingBudgetTokens": "4096" }),
            Some("high"),
            true,
            Reminder::saying("r"),
        );
        let strategy = request.cache_strategy().expect("strategy");
        assert_eq!((strategy.messages.as_deref(), strategy.system.as_deref(), strategy.tier3), (Some("1h"), Some("5m"), None));
        assert_eq!(request.thinking_budget_tokens(), 4096.0);
        assert!(request.has_effort() && request.fast());
        assert_eq!(request.owner_session_id(), Some("lead"));

        let none = saved(json!({}), Some(""), false, Reminder::saying("r"));
        assert!(none.cache_strategy().is_none());
        assert_eq!(none.thinking_budget_tokens(), 0.0);
        assert!(!none.has_effort() && !none.fast());
    }

    /// Each warm carries the reminder of its own moment (the session's language or role may have
    /// changed since the rebuild); the kept request never holds one, and a session that cannot be
    /// read fails the warm instead of sending it without.
    #[test]
    fn each_warm_reads_the_tail_reminder_afresh() {
        let tail = Reminder::saying("<system-reminder>Write in Korean.</system-reminder>");
        let request = saved(json!({}), None, false, tail.clone());
        let first = request.warm_request().expect("warm");
        assert_eq!(first.messages.len(), 2);
        assert_eq!(tail_text(&first).as_deref(), Some("<system-reminder>Write in Korean.</system-reminder>"));

        *tail.0.lock().unwrap() = Ok(Some("<system-reminder>Write in Japanese.</system-reminder>".to_owned()));
        assert_eq!(tail_text(&request.warm_request().expect("warm")).as_deref(), Some("<system-reminder>Write in Japanese.</system-reminder>"));

        *tail.0.lock().unwrap() = Ok(None);
        assert_eq!(request.warm_request().expect("warm").messages.len(), 1, "no matching rule: no reminder");

        *tail.0.lock().unwrap() = Err("thread s1 is not loaded".to_owned());
        assert_eq!(request.warm_request().err().as_deref(), Some("thread s1 is not loaded"));
        assert_eq!(request.request.messages.len(), 1, "the kept request stays without the reminder");
    }

    /// Builds a scripted provider for any enabled name.
    struct Mocks;

    #[async_trait]
    impl ProviderBuilder for Mocks {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(MockProvider::new([])))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    fn config(version: u32) -> serde_json::Map<String, Value> {
        json!({ "anthropic": { "enabled": true, "version": version } }).as_object().expect("object").clone()
    }

    /// A request rebuilt on a provider keeps being current while that instance is registered, and
    /// stops being current when a later sync replaces the provider (or removes it) while the chain
    /// waits: Node's `registeredProvider(name) === request.provider`.
    #[tokio::test]
    async fn a_provider_replaced_while_the_chain_waits_is_no_longer_current() {
        let registry = ProviderRegistry::new(Arc::new(Mocks));
        registry.init_providers(&config(1)).await.expect("init");
        let rebuilt_on = registry.registered("anthropic").expect("registered");
        let mut request = saved(json!({}), None, false, Reminder::saying("r"));
        request.provider_name = "anthropic".to_owned();
        request.provider_generation = registry.generation_of(&rebuilt_on);
        assert!(provider_current(&registry, &request));

        registry.sync_providers(&config(1), None).await.expect("sync");
        assert!(provider_current(&registry, &request), "a sync that changes nothing keeps the instance");

        registry.sync_providers(&config(2), None).await.expect("sync");
        assert!(registry.registered("anthropic").is_some(), "a provider of that name is still registered");
        assert!(!provider_current(&registry, &request), "but not the instance the request was rebuilt on");

        let mut gone = saved(json!({}), None, false, Reminder::saying("r"));
        gone.provider_name = "anthropic".to_owned();
        gone.provider_generation = registry.generation("anthropic");
        assert!(provider_current(&registry, &gone));
        registry.disable("anthropic");
        assert!(!provider_current(&registry, &gone), "a removed provider is not current");

        let unregistered = saved(json!({}), None, false, Reminder::saying("r"));
        let mut orphan = unregistered;
        orphan.provider_generation = None;
        assert!(!provider_current(&registry, &orphan), "an instance that was no longer registered at capture is not current");
    }
}