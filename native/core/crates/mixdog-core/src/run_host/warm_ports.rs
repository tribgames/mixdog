use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::response::ModelResponse;
use mixdog_agent::{with_tail_reminder, without_tail_reminder};
use mixdog_ai::accounts::rotation::SendContext;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::providers::anthropic::fast_mode;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::warmer::chain::{ArmResponse, Detached, Turn, WarmRequest, WarmTarget, Warmer};
use mixdog_ai::warmer::gate::AccountGate;
use mixdog_ai::warmer::plan::{CacheStrategy, turn_kind, written_cache_ttl_ms};
use mixdog_ai::warmer::process::{WarmConfig, WarmProviders, WarmSessions};
use mixdog_ai::warmer::send::{Deadlines, gate_target};
use mixdog_ai::warmer::stores::Log;
use mixdog_ai::warmer::stream::{WarmFailure, WarmUsage};
use mixdog_core_api::domain::cache_warm::WarmContext;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_session::session::home_threads::DirectoryHomeThreads;
use mixdog_core_session::session::turn_warm::TurnWarmth;
use mixdog_services::bots::delivery::env::HomeThreads;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::builder_env::CatalogCaps;
use super::next_request_source::NextRequestSource;
use super::side_question_store::{SendWarmth, SideMaterial};

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

/// What a warm reads of its session besides the request it holds: the session as it is now, loaded or not, never loading it.
#[async_trait]
pub trait WarmStore: Send + Sync {
    /// `withTailReminder`'s session context: the reminder text for `model` from the session's response language and role as
    /// they are now (the live header, else the stored record). `Err` when the session cannot be read.
    async fn reminder(&self, session_id: &str, model: &str) -> Result<Option<String>, String>;
    /// `lastSentMainRequest`: the request the session last sent, rebuilt from what is stored, with the header's reminder of now.
    async fn last_sent(&self, session_id: &str) -> Result<Option<StoredSend>, String>;
    /// The ledger owner of a loaded session; `None` for one that is not loaded.
    fn owner(&self, session_id: &str) -> Option<Option<String>>;
    /// The effort a rebuild of a loaded session's next request takes (its header's `effort`, as the route options set it);
    /// `None` for one that is not loaded.
    fn rebuilt_effort(&self, session_id: &str) -> Option<Option<String>>;
    /// The cache book a rebuild of a session that is not loaded opened is kept, with what the warm taught it, where the
    /// session's next load reads it, and leaves memory.
    fn keep_book(&self, session_id: &str);
}

/// A stored read of the request a session last sent, without its tail reminder, and the reminder of now.
pub struct StoredSend {
    pub request: ModelRequest,
    pub provider: Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>,
    pub provider_name: String,
    pub sent_at: u64,
    pub owner_session_id: Option<String>,
    pub reminder: Option<String>,
}

#[async_trait]
impl WarmStore for NextRequestSource {
    async fn reminder(&self, session_id: &str, model: &str) -> Result<Option<String>, String> {
        let header = self.header_now(&ThreadId::from(session_id)).await?;
        self.tail_text_of(&header, model)
    }

    async fn last_sent(&self, session_id: &str) -> Result<Option<StoredSend>, String> {
        let Some((sent, header)) = NextRequestSource::last_sent(self, &ThreadId::from(session_id)).await else { return Ok(None) };
        let reminder = self.tail_text_of(&header, &sent.material.request.model)?;
        Ok(Some(StoredSend {
            request: Arc::unwrap_or_clone(sent.material.request),
            provider: sent.material.provider,
            provider_name: sent.provider_name,
            sent_at: sent.sent_at,
            owner_session_id: sent.owner_session_id,
            reminder,
        }))
    }

    fn owner(&self, session_id: &str) -> Option<Option<String>> {
        self.live_owner(&ThreadId::from(session_id))
    }

    fn rebuilt_effort(&self, session_id: &str) -> Option<Option<String>> {
        self.live_effort(&ThreadId::from(session_id))
    }

    fn keep_book(&self, session_id: &str) {
        self.keep_unloaded_book(&ThreadId::from(session_id));
    }
}

pub struct SessionsWarm {
    next: Arc<NextRequestSource>,
    registry: Arc<ProviderRegistry>,
    caps: CatalogCaps,
    store: Arc<dyn WarmStore>,
}

impl SessionsWarm {
    pub fn new(next: Arc<NextRequestSource>, registry: Arc<ProviderRegistry>, caps: CatalogCaps, store: Arc<dyn WarmStore>) -> Self {
        Self { next, registry, caps, store }
    }
}

#[async_trait]
impl WarmSessions for SessionsWarm {
    fn turn_in_flight(&self, session_id: &str) -> bool {
        let Some((directory, _)) = self.next.bound() else { return false };
        let Some(directory) = directory.upgrade() else { return false };
        DirectoryHomeThreads::new(directory).turn_in_flight(session_id)
    }

    /// The restart re-arm: the request is read from what is stored and dropped again, with the book its read opened; the chain
    /// keeps only its facts and reads the request anew at each warm.
    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        let sent = self.store.last_sent(session_id).await;
        self.store.keep_book(session_id);
        let Some(sent) = sent? else { return Ok(None) };
        let facts = Facts::of(&sent.request, sent.provider_name, sent.sent_at, sent.owner_session_id);
        let generation = self.registry.generation_of(&sent.provider);
        Ok(Some(self.warm(session_id, facts, generation, Source::Stored)))
    }
}

impl SessionsWarm {
    fn warm(&self, session_id: &str, facts: Facts, provider_generation: Option<u64>, source: Source) -> Arc<dyn WarmRequest> {
        Arc::new(SavedWarm {
            has_warm_mode: self.registry.has_warm_mode(&facts.provider_name),
            effort_levels_empty: self.caps.effort_levels_empty(&facts.model),
            session_id: session_id.to_owned(),
            facts,
            provider_generation,
            store: self.store.clone(),
            source,
        })
    }
}

/// The warm of a request the session's main loop sent at `sent_at` on `provider_name`.
trait WarmOf: Send + Sync {
    fn saved(&self, session_id: &str, provider_name: String, side: &SideMaterial, sent_at: u64) -> Arc<dyn WarmRequest>;
}

impl WarmOf for SessionsWarm {
    fn saved(&self, session_id: &str, provider_name: String, side: &SideMaterial, sent_at: u64) -> Arc<dyn WarmRequest> {
        let facts = Facts::of(&side.request, provider_name, sent_at, self.store.owner(session_id).flatten());
        self.warm(session_id, facts, self.registry.generation_of(&side.provider), sent_source(&*self.store, session_id, side))
    }
}

/// The source of a warm of what the main loop just sent. An effort carried at the body's top level (no effort projection
/// lowers it into the history) that is not the one a rebuild takes (a step's auto-judged effort) is a value the store keeps
/// nowhere: no rebuild reproduces that request, so its chain cannot outlive the session's memory.
fn sent_source(store: &dyn WarmStore, session_id: &str, side: &SideMaterial) -> Source {
    let options = &side.request.options;
    let reproduced = options.effort_projection.is_some() || store.rebuilt_effort(session_id).is_none_or(|effort| effort == options.effort);
    if reproduced { Source::Sent(side.request.clone()) } else { Source::SentOnly(side.request.clone()) }
}

/// [`SendWarmth`] over the process's warmer: every main-loop send of every session, the agent-owned ones included (their request
/// is taken from the send itself, as the side-question store keeps none for them). With warming off nothing reaches the
/// warmer, so nothing is armed, learned or written.
pub struct SessionWarmth {
    warmer: Arc<Warmer>,
    sessions: Arc<dyn WarmOf>,
}

impl SessionWarmth {
    pub fn new(warmer: Arc<Warmer>, sessions: Arc<SessionsWarm>) -> Self {
        Self { warmer, sessions }
    }

    fn request(&self, thread: &ThreadId, provider_name: &str, side: &SideMaterial, sent_at: u64) -> Arc<dyn WarmRequest> {
        self.sessions.saved(thread.as_str(), provider_name.to_owned(), side, sent_at)
    }
}

/// What a settled reply proves for the warm it arms: the tail lifetime from the response's own 5m/1h write split and the
/// request's strategy, the prompt size and the account that served it.
fn arm_response(side: &SideMaterial, reply: &ModelResponse) -> ArmResponse {
    let usage = &reply.usage;
    let strategy = side.request.options.model_parameters.as_ref().and_then(|p| p.get("cacheStrategy")).and_then(CacheStrategy::from_value);
    let ttl = written_cache_ttl_ms(usage.cache_write_tokens as f64, usage.cache_write_1h_tokens as f64, strategy.as_ref());
    let input = usage.input_tokens as f64;
    let excludes_cache = mixdog_ai::registry::accounted::adapter_input_excludes_cache(&*side.provider);
    ArmResponse {
        input,
        cached: usage.cache_read_tokens as f64,
        cache_write: usage.cache_write_tokens as f64,
        tail_ttl_ms: (ttl > 0.0).then_some(ttl),
        prompt_tokens: (!excludes_cache).then_some(input),
        account_id: reply.account_routing.as_ref().map(|routing| routing.account_id.clone()),
    }
}

impl SendWarmth for SessionWarmth {
    fn sending(&self, thread: &ThreadId, provider_name: &str, side: &SideMaterial, sent_at: u64) {
        if self.warmer.enabled() {
            self.warmer.note_activity(thread.as_str(), Some(self.request(thread, provider_name, side, sent_at).as_ref()));
        }
    }

    fn settled(&self, thread: &ThreadId, provider_name: &str, side: &SideMaterial, sent_at: u64, reply: &ModelResponse) {
        if self.warmer.enabled() {
            self.warmer.arm(thread.as_str(), Some(self.request(thread, provider_name, side, sent_at)), &arm_response(side, reply));
        }
    }

    fn forget(&self, thread: &ThreadId) {
        self.warmer.forget(thread.as_str());
    }

    fn cancel(&self, thread: &ThreadId) {
        self.warmer.close(thread.as_str());
    }
}

/// What the warmer reads of the request a warm repeats, taken out of it once.
#[derive(Clone)]
struct Facts {
    provider_name: String,
    model: String,
    sent_at: f64,
    request_kind: Option<String>,
    strategy: Option<CacheStrategy>,
    thinking_budget: f64,
    has_effort: bool,
    fast: bool,
    /// `session.ownerSessionId || session.parentSessionId`, for the warm's ledger row.
    owner_session_id: Option<String>,
}

impl Facts {
    fn of(request: &ModelRequest, provider_name: String, sent_at: u64, owner_session_id: Option<String>) -> Self {
        let parameter = |key: &str| request.options.model_parameters.as_ref().and_then(|p| p.get(key));
        let budget = mixdog_js::to_number_of(parameter("thinkingBudgetTokens"));
        Self {
            provider_name,
            model: request.model.clone(),
            sent_at: sent_at as f64,
            request_kind: request.options.request_kind.clone(),
            strategy: parameter("cacheStrategy").and_then(CacheStrategy::from_value),
            thinking_budget: if budget > 0.0 { budget } else { 0.0 },
            has_effort: request.options.effort.as_deref().is_some_and(|effort| !effort.is_empty()),
            fast: request.options.fast,
            owner_session_id,
        }
    }
}

/// Where a warm's request comes from.
enum Source {
    /// The request as the main loop sent it (it may end with the tail reminder of its moment), held while the session is loaded.
    Sent(Arc<ModelRequest>),
    /// [`Source::Sent`] that no rebuild from what is stored reproduces: its chain ends when the session leaves memory.
    SentOnly(Arc<ModelRequest>),
    /// Read from what is stored at each warm: nothing of the request is held between warms.
    Stored,
}

/// The request a warm replays (`side-question-store.mjs` snapshot) and the facts the warmer reads of it.
/// [`WarmRequest::warm_request`] sends it with the tail reminder of the warm's moment (`cacheWarmSend`).
struct SavedWarm {
    session_id: String,
    facts: Facts,
    /// The registration of the provider instance the request was rebuilt on.
    provider_generation: Option<u64>,
    store: Arc<dyn WarmStore>,
    has_warm_mode: bool,
    effort_levels_empty: bool,
    source: Source,
}

#[async_trait]
impl WarmRequest for SavedWarm {
    fn provider_name(&self) -> &str {
        &self.facts.provider_name
    }

    fn model(&self) -> &str {
        &self.facts.model
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn sent_at(&self) -> f64 {
        self.facts.sent_at
    }

    fn request_kind(&self) -> Option<&str> {
        self.facts.request_kind.as_deref()
    }

    fn cache_strategy(&self) -> Option<CacheStrategy> {
        self.facts.strategy.clone()
    }

    fn thinking_budget_tokens(&self) -> f64 {
        self.facts.thinking_budget
    }

    fn has_effort(&self) -> bool {
        self.facts.has_effort
    }

    fn effort_levels_empty(&self) -> bool {
        self.effort_levels_empty
    }

    fn has_warm_mode(&self) -> bool {
        self.has_warm_mode
    }

    fn owner_session_id(&self) -> Option<&str> {
        self.facts.owner_session_id.as_deref()
    }

    fn fast(&self) -> bool {
        self.facts.fast
    }

    async fn warm_request(&self) -> Result<ModelRequest, String> {
        match &self.source {
            Source::Sent(request) | Source::SentOnly(request) => {
                let reminder = self.store.reminder(&self.session_id, &self.facts.model).await?;
                Ok(with_tail_reminder(&without_tail_reminder(request), reminder.as_deref()))
            }
            Source::Stored => {
                let sent = self.store.last_sent(&self.session_id).await?.ok_or("the session's last request is no longer stored")?;
                if sent.provider_name != self.facts.provider_name || sent.request.model != self.facts.model {
                    return Err("the session's last request is no longer the one this warm repeats".to_owned());
                }
                Ok(with_tail_reminder(&sent.request, sent.reminder.as_deref()))
            }
        }
    }

    fn detached(&self) -> Detached {
        match self.source {
            Source::Stored => Detached::Keep,
            Source::SentOnly(_) => Detached::Unreproducible,
            Source::Sent(_) => Detached::Stored(Arc::new(SavedWarm {
                session_id: self.session_id.clone(),
                facts: self.facts.clone(),
                provider_generation: self.provider_generation,
                store: self.store.clone(),
                has_warm_mode: self.has_warm_mode,
                effort_levels_empty: self.effort_levels_empty,
                source: Source::Stored,
            })),
        }
    }

    fn provider_generation(&self) -> Option<u64> {
        self.provider_generation
    }

    /// A stored warm's rebuild opened the book of a session that is not loaded: the warm's evidence is kept for the session's
    /// next load and the book leaves memory, so between warms the chain holds nothing open.
    fn warmed(&self) {
        if matches!(self.source, Source::Stored) {
            self.store.keep_book(&self.session_id);
        }
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
        // The entry lives on the account that served the request it repeats: a session whose sends would now go to another one
        // reads nothing there.
        if !target.account_id.is_empty() {
            let ctx = SendContext {
                model: request.model().to_owned(),
                session_id: Some(request.session_id().to_owned()),
                bound_hint: Some(target.account_id.clone()),
                cancel: cancel.clone(),
                implicit_plan_usage: None,
                plan_meters_apply: self.gate.scope.plan_meters_apply(request.provider_name()).await,
            };
            match self.gate.rotation.planned_account_id(request.provider_name(), &ctx).await {
                Ok(Some(planned)) if planned != target.account_id => {
                    return Err(WarmFailure::new("the session's account moved since the request the warm would repeat"));
                }
                Ok(_) => {}
                Err(error) => return Err(WarmFailure::new(error.to_string())),
            }
        }
        let sent = request.warm_request().await;
        let outcome = match sent {
            Ok(sent) => {
                let at = gate_target(request, target);
                let log = self.log.clone();
                let report = move |line: &str| log(line);
                let ctx = WarmContext { gate: self.gate.as_ref(), target: &at, deadlines: self.deadlines, report: &report };
                warm.send_cache_warm(&sent, &ctx, cancel, on_usage).await
            }
            Err(reason) => Err(WarmFailure::new(reason)),
        };
        request.warmed();
        outcome
    }
}

/// `noteCacheWarmTurn(sessionId, cacheWarmTurnKind(input))` and `endCacheWarmTurn` (`cache-warm.mjs:563-571,
/// 576-611`) over the process's one `Warmer`: the session actor calls [`TurnWarmth::begin`] at each turn
/// start (`noteTurnForCacheWarm`, `ask-session.mjs:198-201`) and drops the guard when the turn ends.
pub struct WarmedTurns(Arc<Warmer>);

impl WarmedTurns {
    pub fn new(warmer: Arc<Warmer>) -> Self {
        Self(warmer)
    }
}

/// A running turn's warmer entry; dropping it ends the turn (a later turn's own entry stays).
struct WarmedTurn {
    warmer: Arc<Warmer>,
    session: String,
    turn: Arc<Turn>,
}

impl Drop for WarmedTurn {
    fn drop(&mut self) {
        self.warmer.end_turn(&self.session, &self.turn);
    }
}

impl TurnWarmth for WarmedTurns {
    fn begin(&self, thread: &ThreadId, input: &Value, messages: Option<&Value>) -> Box<dyn Send> {
        let kind = turn_kind(input, messages);
        match self.0.note_turn(thread.as_str(), kind) {
            Some(turn) => Box::new(WarmedTurn { warmer: self.0.clone(), session: thread.as_str().to_owned(), turn }),
            None => Box::new(()),
        }
    }

    /// The session left memory; its chain does not. From here each warm reads its request from what is stored, an agent's
    /// session's too, so the chain holds only that request's facts.
    fn unloaded(&self, thread: &ThreadId) {
        self.0.detach(thread.as_str());
    }
}
#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_ai::registry::providers::ProviderBuilder;
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::{Content, Message, MessageSource, ProviderAdapter, RequestOptions, Role};
    use serde_json::json;

    use super::*;

    /// The reminder the session's context gives right now; a test changes it between two warms.
    struct Reminder(Mutex<Result<Option<String>, String>>);

    impl Reminder {
        fn saying(text: &str) -> Arc<Self> {
            Arc::new(Self(Mutex::new(Ok(Some(text.to_owned())))))
        }
    }

    #[async_trait]
    impl WarmStore for Reminder {
        async fn reminder(&self, _: &str, _: &str) -> Result<Option<String>, String> {
            self.0.lock().unwrap().clone()
        }
        async fn last_sent(&self, _: &str) -> Result<Option<StoredSend>, String> {
            Ok(None)
        }
        fn owner(&self, _: &str) -> Option<Option<String>> {
            None
        }
        fn rebuilt_effort(&self, _: &str) -> Option<Option<String>> {
            None
        }
        fn keep_book(&self, _: &str) {}
    }

    fn saved(parameters: Value, effort: Option<&str>, fast: bool, tail: Arc<dyn WarmStore>) -> SavedWarm {
        let options = RequestOptions { model_parameters: Some(parameters), effort: effort.map(str::to_owned), fast, ..RequestOptions::default() };
        let request = Arc::new(ModelRequest {
            model: "claude-opus-4-7".to_owned(),
            messages: vec![Message::new(Role::User, Content::Text("hi".to_owned().into()))],
            tools: Vec::new(),
            options,
        });
        SavedWarm {
            session_id: "s1".to_owned(),
            facts: Facts::of(&request, "anthropic-oauth".to_owned(), 5, Some("lead".to_owned())),
            provider_generation: Some(1),
            store: tail,
            has_warm_mode: true,
            effort_levels_empty: false,
            source: Source::Sent(request),
        }
    }

    fn sent_request(warm: &SavedWarm) -> &ModelRequest {
        match &warm.source {
            Source::Sent(request) | Source::SentOnly(request) => request,
            Source::Stored => unreachable!("a sent warm"),
        }
    }

    fn tail_text(request: &ModelRequest) -> Option<String> {
        let last = request.messages.last()?;
        match (&last.source, &last.content) {
            (Some(MessageSource::TailReminder), Content::Text(text)) => Some(text.to_string()),
            _ => None,
        }
    }

    /// The facts `cacheWarmIneligibility` reads come from the request's options.
    #[test]
    fn the_saved_request_answers_the_facts_the_warmer_reads_of_it() {
        let request =
            saved(json!({ "cacheStrategy": { "messages": "1h", "system": "5m" }, "thinkingBudgetTokens": "4096" }), Some("high"), true, Reminder::saying("r"));
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
    #[tokio::test]
    async fn each_warm_reads_the_tail_reminder_afresh() {
        let tail = Reminder::saying("<system-reminder>Write in Korean.</system-reminder>");
        let request = saved(json!({}), None, false, tail.clone());
        let first = request.warm_request().await.expect("warm");
        assert_eq!(first.messages.len(), 2);
        assert_eq!(tail_text(&first).as_deref(), Some("<system-reminder>Write in Korean.</system-reminder>"));

        *tail.0.lock().unwrap() = Ok(Some("<system-reminder>Write in Japanese.</system-reminder>".to_owned()));
        assert_eq!(tail_text(&request.warm_request().await.expect("warm")).as_deref(), Some("<system-reminder>Write in Japanese.</system-reminder>"));

        *tail.0.lock().unwrap() = Ok(None);
        assert_eq!(request.warm_request().await.expect("warm").messages.len(), 1, "no matching rule: no reminder");

        *tail.0.lock().unwrap() = Err("thread s1 is unknown or deleted".to_owned());
        assert_eq!(request.warm_request().await.err().as_deref(), Some("thread s1 is unknown or deleted"));
        assert_eq!(sent_request(&request).messages.len(), 1, "the kept request stays without the reminder");
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
        request.facts.provider_name = "anthropic".to_owned();
        request.provider_generation = registry.generation_of(&rebuilt_on);
        assert!(provider_current(&registry, &request));

        registry.sync_providers(&config(1), None).await.expect("sync");
        assert!(provider_current(&registry, &request), "a sync that changes nothing keeps the instance");

        registry.sync_providers(&config(2), None).await.expect("sync");
        assert!(registry.registered("anthropic").is_some(), "a provider of that name is still registered");
        assert!(!provider_current(&registry, &request), "but not the instance the request was rebuilt on");

        let mut gone = saved(json!({}), None, false, Reminder::saying("r"));
        gone.facts.provider_name = "anthropic".to_owned();
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

/// The main loop's sends reach the warmer through the side-question store: a real [`Warmer`] on a mocked clock and timers.
#[cfg(test)]
mod send_warmth_tests {
    use std::sync::{Mutex, PoisonError};

    use futures::future::BoxFuture;
    use mixdog_ai::warmer::chain::{TimerHandle, WarmDeps, WarmTimers};
    use mixdog_ai::warmer::plan::{IDLE_RETURN_LOOKBACK_MS, IDLE_RETURN_WINDOW_MS, Prices, warm_delay_ms};
    use mixdog_ai::warmer::stores::{GapRules, GapStore, TouchStore};
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::{AccountRouting, Content, Message, MessageSource, ProviderAdapter, RequestOptions, Role, Usage};
    use mixdog_core_session::session::turn_ops::SideEnd;
    use serde_json::json;

    use super::super::side_question_store::{Capture, NoSavedRequest, SideQuestionStore};
    use super::super::summary_routes::SavedRequest;
    use super::*;

    const T0: f64 = 4_000_000_000_000.0;
    const MINUTE: f64 = 60_000.0;
    const HOUR: f64 = 60.0 * MINUTE;
    const NOW_REMINDER: &str = "<system-reminder>now</system-reminder>";

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    type Pending = (u64, f64, Option<BoxFuture<'static, ()>>);

    #[derive(Default)]
    struct World {
        now: Mutex<f64>,
        on: Mutex<bool>,
        timers: Mutex<Vec<Pending>>,
        next: Mutex<u64>,
        sends: Mutex<Vec<(f64, ModelRequest)>>,
        last_sent: Mutex<Option<Arc<dyn WarmRequest>>>,
    }

    struct Handle(u64, Arc<World>);

    impl TimerHandle for Handle {
        fn cancel(&self) {
            lock(&self.1.timers).retain(|pending| pending.0 != self.0);
        }
    }

    struct Timers(Arc<World>);

    impl WarmTimers for Timers {
        fn schedule(&self, delay_ms: f64, task: BoxFuture<'static, ()>) -> Box<dyn TimerHandle> {
            let id = {
                let mut next = lock(&self.0.next);
                *next += 1;
                *next
            };
            let at = *lock(&self.0.now) + delay_ms.max(0.0);
            lock(&self.0.timers).push((id, at, Some(task)));
            Box::new(Handle(id, self.0.clone()))
        }
    }

    struct Deps {
        world: Arc<World>,
        timers: Timers,
    }

    #[async_trait]
    impl WarmDeps for Deps {
        fn now(&self) -> f64 {
            *lock(&self.world.now)
        }
        fn timers(&self) -> &dyn WarmTimers {
            &self.timers
        }
        async fn enabled(&self) -> bool {
            *lock(&self.world.on)
        }
        fn read_config_enabled(&self) -> bool {
            *lock(&self.world.on)
        }
        fn turn_in_flight(&self, _: &str) -> bool {
            false
        }
        async fn last_sent_request(&self, _: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
            Ok(lock(&self.world.last_sent).clone())
        }
        async fn providers_ready(&self) {}
        async fn provider_current(&self, _: &dyn WarmRequest) -> bool {
            true
        }
        async fn prices(&self, _: &dyn WarmRequest, _: f64, _: f64) -> Result<Prices, String> {
            Ok(Prices { read: Some(0.5e-6), write: Some(6.25e-6), output: Some(25e-6) })
        }
        async fn send(
            &self,
            request: &dyn WarmRequest,
            _: &WarmTarget,
            _: &CancellationToken,
            _: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
        ) -> Result<WarmUsage, WarmFailure> {
            let sent = request.warm_request().await;
            request.warmed();
            let sent = sent.map_err(WarmFailure::new)?;
            lock(&self.world.sends).push((self.now(), sent));
            Ok(WarmUsage { input: 5.0, output: 1.0, output_known: true, cached: 70_000.0, ..WarmUsage::default() })
        }
        async fn record_usage(&self, _: &dyn WarmRequest, _: &WarmUsage, _: f64, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn log(&self, _: &str) {}
    }

    /// The session as the store holds it: whether it is loaded, what it last sent, and what a warm read of it.
    #[derive(Default)]
    struct Disk {
        loaded: Mutex<bool>,
        /// The stored request the session last sent (without its reminder) and its send time.
        stored: Mutex<Option<(ModelRequest, u64)>>,
        stored_reads: Mutex<usize>,
        /// The books a stored read opened that were kept and let go.
        kept: Mutex<usize>,
        /// The loaded header's `effort`, the one a rebuild takes.
        header_effort: Mutex<Option<String>>,
    }

    #[async_trait]
    impl WarmStore for Disk {
        async fn reminder(&self, _: &str, _: &str) -> Result<Option<String>, String> {
            Ok(Some(NOW_REMINDER.to_owned()))
        }
        async fn last_sent(&self, _: &str) -> Result<Option<StoredSend>, String> {
            *lock(&self.stored_reads) += 1;
            let provider: Arc<dyn ProviderAdapter> = Arc::new(MockProvider::new([]));
            Ok(lock(&self.stored).clone().map(|(request, sent_at)| StoredSend {
                request,
                provider,
                provider_name: "anthropic-oauth".into(),
                sent_at,
                owner_session_id: Some("lead".into()),
                reminder: Some(NOW_REMINDER.to_owned()),
            }))
        }
        fn owner(&self, _: &str) -> Option<Option<String>> {
            lock(&self.loaded).then(|| Some("lead".into()))
        }
        fn rebuilt_effort(&self, _: &str) -> Option<Option<String>> {
            lock(&self.loaded).then(|| lock(&self.header_effort).clone())
        }
        fn keep_book(&self, _: &str) {
            if !*lock(&self.loaded) {
                *lock(&self.kept) += 1;
            }
        }
    }

    /// The registry's answers for a registered Anthropic route with a warm mode.
    struct Saves(Arc<Disk>);

    impl Saves {
        fn warm(&self, facts: Facts, source: Source) -> Arc<dyn WarmRequest> {
            Arc::new(SavedWarm {
                session_id: "t".to_owned(),
                facts,
                provider_generation: Some(1),
                store: self.0.clone(),
                has_warm_mode: true,
                effort_levels_empty: false,
                source,
            })
        }

        /// What [`SessionsWarm::last_sent_request`] answers after a restart: the stored request's facts, read from the store.
        async fn stored(&self) -> Arc<dyn WarmRequest> {
            let sent = self.0.last_sent("t").await.unwrap().expect("stored");
            self.warm(Facts::of(&sent.request, sent.provider_name, sent.sent_at, sent.owner_session_id), Source::Stored)
        }
    }

    impl WarmOf for Saves {
        fn saved(&self, _: &str, provider_name: String, side: &SideMaterial, sent_at: u64) -> Arc<dyn WarmRequest> {
            self.warm(Facts::of(&side.request, provider_name, sent_at, self.0.owner("t").flatten()), sent_source(&*self.0, "t", side))
        }
    }

    struct Rig {
        world: Arc<World>,
        warmer: Arc<Warmer>,
        touches: Arc<TouchStore>,
        gaps: Arc<GapStore>,
        store: SideQuestionStore,
        disk: Arc<Disk>,
        dir: tempfile::TempDir,
    }

    async fn stores(dir: &std::path::Path, world: &Arc<World>) -> (Arc<TouchStore>, Arc<GapStore>) {
        let io = mixdog_rt::testing::tokens().durability_io;
        let log: Log = Arc::new(|_| {});
        let touches = Arc::new(TouchStore::open(dir.join("touches.json"), io, log.clone(), Arc::new(|| 1_800_000_000_000.0)).await.unwrap());
        let rules = GapRules { lookback_ms: IDLE_RETURN_LOOKBACK_MS, window_ms: IDLE_RETURN_WINDOW_MS, min_ms: warm_delay_ms(5.0 * MINUTE) };
        let clock = world.clone();
        let gaps = Arc::new(GapStore::open(dir.join("gaps.json"), io, rules, log, Arc::new(move || *lock(&clock.now))).await.unwrap());
        (touches, gaps)
    }

    fn warmer_over(world: &Arc<World>, touches: Arc<TouchStore>, gaps: Arc<GapStore>) -> Arc<Warmer> {
        Warmer::new(Arc::new(Deps { world: world.clone(), timers: Timers(world.clone()) }), touches, gaps)
    }

    /// A session that came back after 2.5 hours idle twenty times: warms bridge its next wait.
    async fn rig(on: bool) -> Rig {
        let world = Arc::new(World::default());
        *lock(&world.now) = T0 + 1000.0;
        *lock(&world.on) = on;
        let dir = tempfile::tempdir().unwrap();
        let (touches, gaps) = stores(dir.path(), &world).await;
        for i in 0..20 {
            let at = T0 - 6.0 * HOUR * f64::from(i + 1);
            gaps.open_gap("t", at);
            gaps.close("t", at + 2.5 * HOUR);
        }
        let warmer = warmer_over(&world, touches.clone(), gaps.clone());
        let disk = Arc::new(Disk::default());
        *lock(&disk.loaded) = true;
        let store = SideQuestionStore::new();
        store.bind_warm(Arc::new(SessionWarmth { warmer: warmer.clone(), sessions: Arc::new(Saves(disk.clone())) }));
        Rig { world, warmer, touches, gaps, store, disk, dir }
    }

    /// What the session stored when its send settled: the request without its reminder, as a stored rebuild gives it.
    fn store_sent(disk: &Disk, request: &ModelRequest) {
        *lock(&disk.stored) = Some((without_tail_reminder(request), T0 as u64));
    }

    fn sent(text: &str) -> Arc<ModelRequest> {
        let options = RequestOptions {
            session_id: Some("t".into()),
            model_parameters: Some(json!({ "cacheStrategy": { "tools": "none", "system": "1h", "tier3": "1h", "messages": "1h" } })),
            ..RequestOptions::default()
        };
        let messages = vec![Message::new(Role::User, Content::Text(text.to_owned().into()))];
        Arc::new(mixdog_agent::wire_request("claude-opus-4-7", options, messages, Some("<system-reminder>then</system-reminder>"), Vec::new()))
    }

    fn material(request: Arc<ModelRequest>) -> SideMaterial {
        let provider: Arc<dyn ProviderAdapter> = Arc::new(MockProvider::new([]));
        SideMaterial { request, provider }
    }

    impl Rig {
        fn send(&self, request: Arc<ModelRequest>, agent_owner: bool) -> Capture {
            let saved = SavedRequest {
                provider_name: "anthropic-oauth".into(),
                model: request.model.clone(),
                cache_strategy: None,
                catalog_supports_prompt_caching: true,
                sent_at: T0 as u64,
                settled: false,
                compacted: false,
                prompt_tokens: 0,
                shared_prefix_messages: 1,
            };
            self.store.capture(&ThreadId::from("t"), saved, Arc::new(NoSavedRequest), material(request), agent_owner)
        }

        /// The reply settled, having written `write` tokens of which `write_1h` at the hour's lifetime.
        fn settle(&self, capture: &Capture, write: u64, write_1h: u64) {
            let usage = Usage { input_tokens: 70_000, cache_write_tokens: write, cache_write_1h_tokens: write_1h, ..Usage::default() };
            let routing = AccountRouting { provider: "anthropic-oauth".into(), account_id: "acct-1".into(), session_account_id: None };
            let reply = ModelResponse { content: "ok".into(), usage, account_routing: Some(routing), ..ModelResponse::default() };
            self.store.settle(capture, Some(reply));
        }

        fn armed(&self) {
            let capture = self.send(sent("hi"), false);
            self.settle(&capture, 5000, 5000);
            assert!(self.warmer.chain_state("t").is_some());
        }

        /// Runs every timer due by `to`, in due order, with the clock at each.
        async fn advance(&self, to: f64) {
            loop {
                let due = {
                    let mut timers = lock(&self.world.timers);
                    let first = timers.iter().enumerate().filter(|(_, t)| t.1 <= to).min_by(|a, b| a.1.1.total_cmp(&b.1.1)).map(|(i, _)| i);
                    first.map(|i| timers.remove(i))
                };
                let Some((_, at, task)) = due else { break };
                {
                    let mut now = lock(&self.world.now);
                    *now = now.max(at);
                }
                if let Some(task) = task {
                    task.await;
                }
            }
            let mut now = lock(&self.world.now);
            *now = now.max(to);
        }
    }

    #[tokio::test]
    async fn a_settled_send_arms_a_chain_with_the_lifetime_it_wrote_and_warming_off_arms_nothing() {
        let r = rig(true).await;
        let capture = r.send(sent("hi"), false);
        assert!(r.warmer.chain_state("t").is_none(), "nothing is armed before the reply settles");
        r.settle(&capture, 5000, 5000);
        let chain = r.warmer.chain_state("t").expect("armed");
        assert_eq!((chain.ttl_ms, chain.touch_at, chain.account_id.as_str()), (HOUR, T0, "acct-1"));
        assert_eq!(r.touches.get("t").map(|touch| touch.ttl_ms), Some(HOUR));
        let capture = r.send(sent("again"), false);
        r.settle(&capture, 5000, 0);
        assert_eq!(r.warmer.chain_state("t").map(|chain| chain.ttl_ms), Some(5.0 * MINUTE), "a 1h strategy whose write was 5m arms what was written");

        let off = rig(false).await;
        let capture = off.send(sent("hi"), false);
        off.settle(&capture, 5000, 5000);
        assert!(off.warmer.chain_state("t").is_none());
        assert!(off.touches.ids().is_empty() && lock(&off.world.timers).is_empty());
        assert_eq!(off.gaps.open_at("t"), 0.0, "nothing is learned or written while warming is off");
    }

    #[tokio::test]
    async fn each_end_of_a_sessions_request_ends_the_chain_and_the_touch_as_the_rule_says() {
        let thread = ThreadId::from("t");
        let r = rig(true).await;
        let learned = r.gaps.gaps("t");
        r.armed();
        let _next = r.send(sent("next"), false);
        assert!(r.warmer.chain_state("t").is_none(), "a new send stops the chain");
        r.armed();
        r.store.retire_compaction_fork(&thread);
        assert!(r.warmer.chain_state("t").is_none() && r.touches.get("t").is_none(), "a compaction forgets the chain and its touch");
        for (end, what) in [(SideEnd::Transcript, "a clear or a rewind"), (SideEnd::Route, "a route change"), (SideEnd::Tombstone, "a tombstone")] {
            r.armed();
            r.store.end(&thread, end);
            assert!(r.warmer.chain_state("t").is_none() && r.touches.get("t").is_none(), "{what} ends the chain and its touch");
        }
        r.armed();
        r.store.end(&thread, SideEnd::Detach);
        assert!(r.warmer.chain_state("t").is_none() && lock(&r.world.timers).is_empty());
        assert!(r.touches.get("t").is_some(), "a detach keeps the touch the restart re-arms from");
        r.armed();
        r.store.end(&thread, SideEnd::Unload);
        assert!(r.warmer.chain_state("t").is_some() && r.touches.get("t").is_some(), "an unload keeps the chain and its touch");
        assert_eq!(r.gaps.gaps("t"), learned, "what the session learned of its returns stays");
        assert_eq!(r.gaps.open_at("t"), T0);
    }

    /// A send whose top-level effort (no effort projection: a model that takes no effort updates) is a step's auto-judged one,
    /// not the header's a rebuild takes: the store cannot reproduce it, so its chain and its touch end when the session leaves
    /// memory, by an unload or a detach. The header's own effort is reproduced, and the chain outlives the unload.
    #[tokio::test]
    async fn an_auto_judged_effort_no_rebuild_reproduces_ends_the_chain_and_its_touch_when_the_session_leaves_memory() {
        let thread = ThreadId::from("t");
        let r = rig(true).await;
        *lock(&r.disk.header_effort) = Some("high".into());
        let judged = |effort: &str| {
            let mut request = Arc::unwrap_or_clone(sent("hi"));
            request.options.effort = Some(effort.into());
            Arc::new(request)
        };
        let arm = |request: Arc<ModelRequest>| {
            let capture = r.send(request, false);
            r.settle(&capture, 5000, 5000);
            assert!(r.warmer.chain_state("t").is_some());
        };
        let unload = || {
            WarmedTurns::new(r.warmer.clone()).unloaded(&thread);
            r.store.end(&thread, SideEnd::Unload);
        };

        arm(judged("low"));
        unload();
        assert!(r.warmer.chain_state("t").is_none() && r.touches.get("t").is_none(), "an unload ends what no rebuild reproduces");
        arm(judged("low"));
        r.store.end(&thread, SideEnd::Detach);
        assert!(r.warmer.chain_state("t").is_none() && r.touches.get("t").is_none(), "a detach leaves no touch for the restart either");

        arm(judged("high"));
        unload();
        assert!(r.warmer.chain_state("t").is_some() && r.touches.get("t").is_some(), "the header's effort is what a rebuild sends");
    }

    #[tokio::test]
    async fn an_agent_owned_session_is_armed_from_its_own_send() {
        let r = rig(true).await;
        let capture = r.send(sent("hi"), true);
        r.settle(&capture, 5000, 5000);
        assert!(r.store.saved_request(&ThreadId::from("t")).is_none(), "it keeps no side request");
        assert_eq!(r.warmer.chain_state("t").map(|chain| chain.ttl_ms), Some(HOUR));
    }

    #[tokio::test]
    async fn a_warm_goes_out_once_a_minute_before_expiry_and_repeats_the_last_request() {
        let r = rig(true).await;
        let request = sent("hi");
        let capture = r.send(request.clone(), false);
        r.settle(&capture, 5000, 5000);
        r.advance(T0 + HOUR - MINUTE - 1.0).await;
        assert!(lock(&r.world.sends).is_empty());
        r.advance(T0 + HOUR - MINUTE).await;
        let sends = lock(&r.world.sends);
        assert_eq!(sends.len(), 1);
        let (at, warm) = &sends[0];
        assert_eq!(*at, T0 + HOUR - MINUTE);
        let kept = mixdog_agent::kept_messages(&request);
        assert_eq!(&warm.messages[..kept.len()], kept, "the previous request's messages, unchanged");
        assert_eq!(warm.messages.len(), kept.len() + 1);
        let last = warm.messages.last().unwrap();
        assert_eq!(last.source, Some(MessageSource::TailReminder));
        assert!(matches!(&last.content, Content::Text(text) if text.to_string() == NOW_REMINDER), "the reminder of the warm's moment");
        assert_eq!((&warm.model, &warm.tools, &warm.options), (&request.model, &request.tools, &request.options));
    }

    #[tokio::test]
    async fn a_restart_rearms_from_the_touch_file() {
        let r = rig(true).await;
        let request = sent("hi");
        let capture = r.send(request.clone(), false);
        r.settle(&capture, 5000, 5000);
        r.touches.flush().await;
        r.gaps.flush().await;

        // A new process with nothing loaded: the store holds the session's record, the chain reads it.
        let disk = Arc::new(Disk::default());
        store_sent(&disk, &request);
        let world = Arc::new(World::default());
        *lock(&world.now) = T0 + 10.0 * MINUTE;
        *lock(&world.on) = true;
        *lock(&world.last_sent) = Some(Saves(disk.clone()).stored().await);
        let (touches, gaps) = stores(r.dir.path(), &world).await;
        let warmer = warmer_over(&world, touches, gaps);
        assert_eq!(warmer.rearm_after_restart().await, 1);
        *lock(&world.last_sent) = None;
        let chain = warmer.chain_state("t").expect("re-armed");
        assert_eq!((chain.ttl_ms, chain.touch_at, chain.account_id.as_str(), chain.refresh_at), (HOUR, T0, "acct-1", T0 + HOUR - MINUTE));

        let restarted = Rig { world, warmer, touches: r.touches.clone(), gaps: r.gaps.clone(), store: SideQuestionStore::new(), disk: disk.clone(), dir: r.dir };
        restarted.advance(T0 + HOUR - MINUTE).await;
        let sends = lock(&restarted.world.sends);
        assert_eq!(sends.len(), 1, "the re-armed chain warms");
        assert_eq!(sends[0].1, with_tail_reminder(&without_tail_reminder(&request), Some(NOW_REMINDER)), "the stored request's bytes");
        assert!(!*lock(&disk.loaded), "the session was not loaded for it");
        assert_eq!(*lock(&disk.stored_reads), 2, "the re-arm's read and the warm's own");
    }

    /// The session unloads with its chain armed: the chain holds only the request's facts, and its warm reads the stored
    /// request and the stored header's reminder, without loading the session.
    #[tokio::test]
    async fn an_unloaded_sessions_warm_goes_out_once_with_the_stored_request() {
        let r = rig(true).await;
        let request = sent("hi");
        let capture = r.send(request.clone(), false);
        r.settle(&capture, 5000, 5000);
        store_sent(&r.disk, &request);
        let before = r.warmer.chain_state("t").expect("armed");

        *lock(&r.disk.loaded) = false;
        // The actor's unload: the warm detaches, then the side request goes.
        WarmedTurns::new(r.warmer.clone()).unloaded(&ThreadId::from("t"));
        r.store.end(&ThreadId::from("t"), mixdog_core_session::session::turn_ops::SideEnd::Unload);
        let after = r.warmer.chain_state("t").expect("the chain outlives the unload");
        assert_eq!((after.ttl_ms, after.touch_at, after.refresh_at), (before.ttl_ms, before.touch_at, before.refresh_at));
        assert_eq!(*lock(&r.disk.stored_reads), 0, "nothing is read before the warm");

        r.advance(T0 + HOUR - MINUTE - 1.0).await;
        assert!(lock(&r.world.sends).is_empty());
        r.advance(T0 + HOUR - MINUTE).await;
        let sends = lock(&r.world.sends);
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].0, T0 + HOUR - MINUTE);
        assert_eq!(sends[0].1, with_tail_reminder(&without_tail_reminder(&request), Some(NOW_REMINDER)), "the stored request's bytes");
        assert_eq!(*lock(&r.disk.stored_reads), 1);
        assert!(!*lock(&r.disk.loaded), "the warm did not load the session");
        assert_eq!(*lock(&r.disk.kept), 1, "the book the warm's read opened is kept for the next load and let go");
    }

    /// An agent's session, whose sends the side-question store keeps nothing of, is warmed after its unload from what is
    /// stored, as any other: the chain no longer holds the request it was armed with.
    #[tokio::test]
    async fn an_unloaded_agent_sessions_warm_reads_the_stored_request() {
        let r = rig(true).await;
        let request = sent("hi");
        let capture = r.send(request.clone(), true);
        r.settle(&capture, 5000, 5000);
        store_sent(&r.disk, &request);
        *lock(&r.disk.loaded) = false;
        WarmedTurns::new(r.warmer.clone()).unloaded(&ThreadId::from("t"));
        r.store.end(&ThreadId::from("t"), mixdog_core_session::session::turn_ops::SideEnd::Unload);
        r.advance(T0 + HOUR - MINUTE).await;
        let sends = lock(&r.world.sends);
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0].1, with_tail_reminder(&without_tail_reminder(&request), Some(NOW_REMINDER)), "the stored request's bytes");
        assert_eq!(*lock(&r.disk.stored_reads), 1, "read from the store, not held");
    }

    /// A deleted session's purge ends its chain and removes its touch; between warms its unloaded chain held no book open.
    #[tokio::test]
    async fn a_deleted_session_has_no_chain_and_no_touch() {
        let r = rig(true).await;
        r.armed();
        *lock(&r.disk.loaded) = false;
        WarmedTurns::new(r.warmer.clone()).unloaded(&ThreadId::from("t"));
        assert!(r.warmer.chain_state("t").is_some());
        r.warmer.purge_session("t");
        assert!(r.warmer.chain_state("t").is_none() && r.touches.get("t").is_none());
        assert!(lock(&r.world.timers).is_empty());
        assert_eq!(*lock(&r.disk.stored_reads), 0, "nothing was read, so no book was opened");
    }
}
