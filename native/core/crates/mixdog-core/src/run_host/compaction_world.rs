//! The one real [`CompactionWorld`]: a compaction's session side, built from the process's
//! services. Each fact is the existing implementation over a service this world is given; the
//! three services nothing else provides are here: the provider traits of a route
//! ([`RegisteredRouteTraits`]), a session's request state ([`ProcessSessionRequests`]) and the
//! saved request the loop's sends leave behind (`SideQuestionStore`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::Clock;
use mixdog_ai::accounts::rotation::{AccountRotation, SendContext};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::registry::warm::{RequestFacts, RequestTail, WarmLedger};
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ProviderId;
use mixdog_services::memory::sensitive::SensitiveStore;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::attachment_reference::{AttachmentFiles, ReferencedMedia};
use super::cache::RequestCacheTail;
use super::compaction_redactor::SensitiveRedactor;
use super::compactors::{CompactionFacts, CompactionWorld};
use super::media::{AttachmentFacts, MediaLowering};
use super::side_question_store::SideQuestionStore;
use mixdog_core_config::config::Config;
use super::summary_host::SummaryServices;

/// What a registered provider declares of its wire (Node reads `provider.nativePdf` and
/// `provider.nativeDocuments` off the provider object the registry holds; here they are the
/// registered adapter's own declarations).
pub struct RegisteredRouteTraits {
    registry: Arc<ProviderRegistry>,
}

impl RegisteredRouteTraits {
    pub fn new(registry: Arc<ProviderRegistry>) -> Self {
        Self { registry }
    }

    /// `providerNativePdf(name)`: a pure lookup of the instance registered under the lower-cased
    /// name; a name nothing registered is treated as native.
    pub fn native_pdf(&self, provider: &str) -> bool {
        self.registry.registered(&provider.to_lowercase()).is_none_or(|adapter| adapter.native_pdf())
    }

    /// `provider.nativeDocuments === false`: the registered provider takes no document block of any
    /// kind. A name nothing registered declares nothing.
    pub fn no_documents(&self, provider: &str) -> bool {
        self.registry.registered(&provider.to_lowercase()).is_some_and(|adapter| adapter.native_documents() == Some(false))
    }
}

/// `sessionAccountId`'s recovery of a binding the process does not hold in memory (the in-memory
/// one is read first, by the rotation): the session's provider state, then the newest message
/// whose `providerMetadata.accountRouting` names this provider. Only a binding recorded for this
/// provider counts, a session that switched providers carries another roster's ids.
fn bound_account(provider: &str, state: Option<&Value>, messages: &[Value]) -> Option<String> {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
    let from_state = state.and_then(|state| {
        let account = text(state, "providerAccountId")?;
        (text(state, "providerAccountProvider").as_deref() == Some(provider)).then(|| text(state, "providerSessionAccountId").unwrap_or(account))
    });
    from_state.or_else(|| {
        messages.iter().rev().find_map(|message| {
            let routing = message.get("providerMetadata")?.get("accountRouting")?;
            let account = text(routing, "accountId")?;
            (routing.get("provider").and_then(Value::as_str) == Some(provider)).then(|| text(routing, "sessionAccountId").unwrap_or(account))
        })
    })
}

/// The route's provider as the compaction reads it from the session header.
/// `isAgentOwner(session)`: the owner, trimmed and lower-cased, is `agent`. The one predicate of the
/// run host's agent-owner gates (compaction facts, side-question capture and rebuild).
pub(crate) fn is_agent_owner(header: &Header) -> bool {
    header.get("owner").is_some_and(|owner| mixdog_js::js_trim(&mixdog_js::value_to_string(owner)).to_lowercase() == "agent")
}

fn route_provider(header: &Header) -> &str {
    header.get("provider").and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

/// A session's request state over the process's cache-warm ledger, account rotation, clock and the
/// saved requests the loop's sends record.
pub struct ProcessSessionRequests {
    ledger: WarmLedger,
    rotation: Arc<AccountRotation>,
    clock: Arc<dyn Clock>,
    /// The store the loop's sends record into; the one SideWiring shares.
    pub saved: Arc<SideQuestionStore>,
}

impl ProcessSessionRequests {
    pub fn new(ledger: WarmLedger, rotation: Arc<AccountRotation>, clock: Arc<dyn Clock>, saved: Arc<SideQuestionStore>) -> Self {
        Self { ledger, rotation, clock, saved }
    }

    /// The tail of the next request on the session's own route (`shouldCompactForExpiredAgentCache`):
    /// `isAgentOwner(session)`, the cache strategy's `messages` tier, `Number(lastProviderSendAt)`
    /// and the account `requestAccountId` plans, bound by the process's in-memory binding, else the
    /// stored provider state, else the newest of the request's messages that records a routing.
    async fn request_tail(&self, thread: &ThreadId, header: &Header, messages: &[Value]) -> RequestTail {
        let provider = route_provider(header).to_owned();
        let model = header.get("model").and_then(Value::as_str).unwrap_or_default().to_owned();
        let last_send = mixdog_js::to_number_of(header.get("lastProviderSendAt"));
        let facts = RequestFacts {
            session_id: thread.as_str().to_owned(),
            provider: provider.clone(),
            model: model.clone(),
            agent_owner: is_agent_owner(header),

            five_minute_tail: header.get("providerCacheOpts").and_then(|opts| opts.get("cacheStrategy")).and_then(|strategy| strategy.get("messages")).and_then(Value::as_str)
                == Some("5m"),
            last_provider_send_at: if last_send > 0.0 { last_send as u64 } else { 0 },
            now_ms: self.clock.now_ms().max(0) as u64,
        };
        let ctx = SendContext {
            model,
            session_id: Some(thread.as_str().to_owned()),
            bound_hint: bound_account(&provider, header.get("providerState"), messages),
            cancel: CancellationToken::new(),
            implicit_plan_usage: None,
        };
        RequestTail::plan(self.ledger.clone(), &self.rotation, facts, &ctx).await
    }
}

/// The process services a compaction reads through.
pub struct CompactionServices {
    /// The saved configuration (`loadConfig()`).
    pub config: Config,
    /// The sensitive values the session's tool calls marked.
    pub sensitive: Arc<SensitiveStore>,
    /// The extension host's document extraction.
    pub docs: Arc<dyn DocumentText>,
    /// The attachment store's bytes.
    pub reader: Arc<dyn AttachmentReader>,
    /// What the attachment store recorded about each stored file.
    pub attachment_facts: Arc<dyn AttachmentFacts>,
    /// The attachment store's files, for referencing media by path.
    pub files: Arc<dyn AttachmentFiles>,
    pub routes: RegisteredRouteTraits,
    pub requests: ProcessSessionRequests,
    /// The runtime around a session's summary route plan.
    pub summaries: Arc<SummaryServices>,
}

pub struct ProcessCompactionWorld {
    services: CompactionServices,
}

impl ProcessCompactionWorld {
    pub fn new(services: CompactionServices) -> Self {
        Self { services }
    }
}

#[async_trait]
impl CompactionWorld for ProcessCompactionWorld {
    async fn facts(&self, thread: &ThreadId, header: &Header, prior: &[Value]) -> CompactionFacts {
        let s = &self.services;
        let provider = route_provider(header);
        // One store view serves the priced media, the tool-result media and the references.
        let media = Arc::new(MediaLowering::new(
            thread.clone(),
            s.docs.clone(),
            s.reader.clone(),
            s.attachment_facts.clone(),
            s.routes.no_documents(provider),
            ProviderId::from(provider),
        ));
        CompactionFacts {
            media: media.clone(),
            tool_media: media.clone(),
            native_pdf: s.routes.native_pdf(provider),
            attachments: Arc::new(ReferencedMedia::new(s.files.clone(), s.attachment_facts.clone(), media)),
            redactor: Arc::new(SensitiveRedactor::new(s.sensitive.clone(), thread.as_str())),
            cache: Arc::new(RequestCacheTail::new(s.requests.request_tail(thread, header, prior).await)),
            summary: s.summaries.host(thread, header),
            saved_request: s.requests.saved.saved_request(thread),
            fork_sender: s.requests.saved.fork_sender(thread),
        }
    }

    /// `config.compaction` of the agent config `loadConfig()` returns.
    fn compaction_config(&self) -> Option<Value> {
        self.services.config.agent().get("compaction").cloned()
    }

    fn retire_fork(&self, thread: &ThreadId) {
        self.services.requests.saved.retire_compaction_fork(thread);
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use async_trait::async_trait;
    use mixdog_agent::boundary::CompactSettings;
    use mixdog_agent::compact::summary_run::{SummaryCall, SummaryFailure, SummaryResponse, SummaryRoute, SummarySender};
    use mixdog_agent::message::AgentMessage;
    use mixdog_agent::offload::{Artifact, ArtifactStore};
    use mixdog_ai::accounts::rotation::UsageProbe;
    use mixdog_ai::accounts::AccountStore;
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
    use mixdog_ai::oauth::{CredentialIo, SystemPace};
    use mixdog_ai::registry::providers::ProviderBuilder;
    use mixdog_ai::registry::warm::WarmUse;
    use mixdog_ai::service::model_proxy_inline::ReadError;
    use mixdog_ai::transport::http::{HttpResponse, HttpSend};
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::ext::{ExtError, PdfIntake};
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ModelRequest, ModelStream, ProviderAdapter, ProviderError, WireCodec, WireRequest};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_api::domain::tool::ToolIo;
    use mixdog_core_api::domain::mock::{MockFileService, MockProcessManager, MockProgress, MockProvider};
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_protocol::message_class::user_text::Blobs;
    use serde_json::{json, Map};

    use super::*;
    use mixdog_core_config::config::ConfigLanes;
    use crate::run_host::summary_host::SummaryDeps;
    use crate::run_host::assemble::CompactorInput;
    use crate::run_host::attachment_reference::{OriginalFile, StoredFile};
    use crate::run_host::compactors::SessionCompactors;
    use crate::run_host::host_seams::CompactorSource;
    use crate::run_host::media::StoredFacts;
    use crate::run_host::summary_routes::{ForkSender, SavedRequest, SessionRoute};
    use mixdog_core_session::session::StoredRows;

    const NOW: i64 = 1_800_000_000_000;

    struct Docs;
    #[async_trait]
    impl DocumentText for Docs {
        async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
            Ok(None)
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
            Ok(String::new())
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
            unreachable!("no PDF in this conversation")
        }
    }
    struct Store;
    #[async_trait]
    impl AttachmentReader for Store {
        async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
            Err(ReadError::Permanent)
        }
    }
    struct Recorded;
    impl AttachmentFacts for Recorded {
        fn facts(&self, _: &str) -> Option<StoredFacts> {
            None
        }
    }
    struct Files;
    impl AttachmentFiles for Files {
        fn store_inline(&self, _: &str, _: &str, _: &str) -> Option<StoredFile> {
            None
        }
        fn named_file(&self, _: &str, _: &str, _: &str, _: Option<&OriginalFile>) -> Result<String, ()> {
            Err(())
        }
        fn blob_path(&self, reference: &str) -> String {
            reference.to_owned()
        }
    }
    struct Archive;
    #[async_trait]
    impl ArtifactStore for Archive {
        async fn persist(&self, _: &str) -> Option<Artifact> {
            None
        }
        async fn preview(&self, _: &str) -> Option<Artifact> {
            None
        }
    }
    struct NoBlobs;
    impl Blobs for NoBlobs {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
            Ok(None)
        }
    }
    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    struct NoProbe;
    #[async_trait]
    impl UsageProbe for NoProbe {
        async fn measure(&self, _: &str, _: &str, _: bool) {}
    }
    struct Offline;
    #[async_trait]
    impl HttpSend for Offline {
        async fn send(
            &self,
            _: WireRequest,
            _exchange: mixdog_ai::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(
                ErrorKind::Transient,
                DeliveryState::NotSent,
            ))
        }
    }
    /// A scripted adapter that declares what its config entry says of its documents.
    struct Declared {
        inner: MockProvider,
        native_pdf: bool,
        native_documents: Option<bool>,
    }
    #[async_trait]
    impl ProviderAdapter for Declared {
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.inner.attempt(request).await
        }
        fn native_pdf(&self) -> bool {
            self.native_pdf
        }
        fn native_documents(&self) -> Option<bool> {
            self.native_documents
        }
    }

    /// Builds a scripted adapter for any enabled name, declaring the `nativePdf` and
    /// `nativeDocuments` its config entry carries (a PDF-native adapter without one).
    struct Builder;
    #[async_trait]
    impl ProviderBuilder for Builder {
        async fn build(&self, _: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(Declared {
                inner: MockProvider::new([]),
                native_pdf: config.get("nativePdf").and_then(Value::as_bool).unwrap_or(true),
                native_documents: config.get("nativeDocuments").and_then(Value::as_bool),
            }))
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
    struct Tagged;
    #[async_trait]
    impl ForkSender for Tagged {
        async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
            Err(SummaryFailure::Failed("saved".to_owned()))
        }
    }
    struct Quiet;
    #[async_trait]
    impl SummarySender for Quiet {
        async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!()
        }
    }

    /// A registry that holds what a config enabling these providers leaves it.
    async fn registry_of(config: Value) -> Arc<ProviderRegistry> {
        let registry = Arc::new(ProviderRegistry::new(Arc::new(Builder)));
        registry.init_providers(config.as_object().unwrap()).await.unwrap();
        registry
    }

    /// `anthropic` and `openai` take a PDF; `groq` declares it does not.
    async fn registry() -> Arc<ProviderRegistry> {
        registry_of(json!({ "anthropic": { "enabled": true }, "openai": { "enabled": true }, "groq": { "enabled": true, "nativePdf": false } })).await
    }

    fn saved(sent_at: u64) -> SavedRequest {
        SavedRequest {
            provider_name: "anthropic".into(),
            model: "m".into(),
            messages_tier: Some("5m".into()),
            catalog_supports_prompt_caching: true,
            sent_at,
            settled: false,
            compacted: false,
            prompt_tokens: 10,
            shared_prefix_messages: 2,
        }
    }

    /// The services over the real ones and a config file under dir; the cache-warm ledger and the
    /// saved-request store are the caller's to record into.
    pub(crate) async fn services_with(
        dir: &std::path::Path,
        agent: Value,
        sensitive: Arc<SensitiveStore>,
        ledger: WarmLedger,
        saved: Arc<SideQuestionStore>,
    ) -> CompactionServices {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.join("mixdog-config.json");
        crate::run_host::fixture_fs::write(&path, serde_json::to_vec(&json!({ "agent": agent })).unwrap());
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let registry = registry().await;
        let clock: Arc<dyn Clock> = Arc::new(Fixed);
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let rotation = Arc::new(AccountRotation::new(AccountStore::new(dir.join("accounts"), io), Arc::new(NoProbe), Arc::new(SystemPace)));
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        let summaries = SummaryServices::new(SummaryDeps {
            registry: registry.clone(),
            catalog,
            config: Arc::new(Map::new),
            env: Arc::new(|_| None),
            clock: clock.clone(),
            data_dir: AbsPath::new(dir).unwrap(),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        });
        CompactionServices {
            config,
            sensitive,
            docs: Arc::new(Docs),
            reader: Arc::new(Store),
            attachment_facts: Arc::new(Recorded),
            files: Arc::new(Files),
            routes: RegisteredRouteTraits::new(registry),
            requests: ProcessSessionRequests::new(ledger, rotation, clock, saved),
            summaries: Arc::new(summaries),
        }
    }

    /// The services over the real ones, for a test that records nothing into them.
    pub(crate) async fn services(dir: &std::path::Path, agent: Value, sensitive: Arc<SensitiveStore>) -> CompactionServices {
        services_with(dir, agent, sensitive, WarmLedger::new(), Arc::new(SideQuestionStore::new())).await
    }

    async fn world(dir: &std::path::Path, agent: Value, sensitive: Arc<SensitiveStore>) -> ProcessCompactionWorld {
        ProcessCompactionWorld::new(services(dir, agent, sensitive).await)
    }

    fn header(provider: &str) -> Header {
        let Value::Object(header) = json!({ "provider": provider, "model": "m", "compaction": { "conversationThresholdTokens": 1 } }) else { unreachable!() };
        header
    }

    fn thread() -> ThreadId {
        ThreadId::from("sess_a".to_owned())
    }

    #[tokio::test]
    async fn the_compaction_config_is_the_saved_agent_configs() {
        let dir = tempfile::tempdir().unwrap();
        let saved = json!({ "summaryMode": "self", "useMaintainer": false });
        let with = world(dir.path(), json!({ "compaction": saved }), Arc::default()).await;
        assert_eq!(with.compaction_config(), Some(saved));
        let other = tempfile::tempdir().unwrap();
        assert_eq!(world(other.path(), json!({}), Arc::default()).await.compaction_config(), None);
    }

    /// `providerNativePdf(name)`: what the registered adapter declares, whatever its name; an
    /// unregistered name is native, and the name is lower-cased before the lookup.
    #[tokio::test]
    async fn a_route_takes_a_pdf_natively_as_its_registered_adapter_declares() {
        let routes = RegisteredRouteTraits::new(registry().await);
        for (provider, native) in [("anthropic", true), ("Anthropic", true), ("openai", true), ("groq", false), ("never-registered", true), ("", true)] {
            assert_eq!(routes.native_pdf(provider), native, "{provider:?}");
        }
        // A model-proxy reports the traits of the machine's real instance: neither list of names holds.
        let proxied = RegisteredRouteTraits::new(
            registry_of(json!({ "anthropic": { "enabled": true, "nativePdf": false }, "groq": { "enabled": true, "nativePdf": true } })).await,
        );
        assert!(!proxied.native_pdf("anthropic"));
        assert!(proxied.native_pdf("groq"));
    }

    /// `provider.nativeDocuments === false` lowers every document; unset or true does not.
    #[tokio::test]
    async fn a_route_takes_no_documents_only_when_its_adapter_declares_so() {
        let routes = RegisteredRouteTraits::new(
            registry_of(json!({
                "deepseek": { "enabled": true, "nativePdf": false, "nativeDocuments": false },
                "gateway": { "enabled": true, "nativeDocuments": true },
                "anthropic": { "enabled": true }
            }))
            .await,
        );
        for (provider, none) in [("deepseek", true), ("DeepSeek", true), ("gateway", false), ("anthropic", false), ("never-registered", false)] {
            assert_eq!(routes.no_documents(provider), none, "{provider:?}");
        }
    }

    /// `isAgentOwner`: the owner trimmed and lower-cased is `agent`; every gate of the run host reads this one.
    #[test]
    fn the_agent_owner_is_the_trimmed_lower_cased_owner() {
        let owner = |value: Value| is_agent_owner(json!({ "owner": value }).as_object().unwrap());
        for (value, agent) in [(json!("agent"), true), (json!(" Agent "), true), (json!("AGENT\n"), true), (json!("lead"), false), (json!(""), false), (json!(5), false), (json!(null), false), (json!(["agent"]), true)] {
            assert_eq!(owner(value.clone()), agent, "{value}");
        }
        assert!(!is_agent_owner(json!({}).as_object().unwrap()));
    }

    #[test]
    fn a_binding_is_recovered_from_the_state_then_the_newest_matching_message() {
        let state = json!({ "providerAccountId": "a1", "providerAccountProvider": "openai-oauth", "providerSessionAccountId": "a0" });
        assert_eq!(bound_account("openai-oauth", Some(&state), &[]), Some("a0".to_owned()));
        assert_eq!(bound_account("anthropic-oauth", Some(&state), &[]), None, "another roster's ids");
        let unbound = json!({ "providerAccountId": "a1", "providerAccountProvider": "openai-oauth", "providerSessionAccountId": "" });
        assert_eq!(bound_account("openai-oauth", Some(&unbound), &[]), Some("a1".to_owned()));
        assert_eq!(bound_account("openai-oauth", Some(&json!({ "providerAccountProvider": "openai-oauth" })), &[]), None);
        assert_eq!(bound_account("openai-oauth", None, &[]), None);

        let routed = |provider: &str, account: &str, session: Option<&str>| {
            let mut routing = json!({ "provider": provider, "accountId": account });
            if let Some(session) = session {
                routing["sessionAccountId"] = json!(session);
            }
            json!({ "role": "assistant", "content": "x", "providerMetadata": { "accountRouting": routing } })
        };
        let messages = [
            routed("openai-oauth", "old", None),
            routed("openai-oauth", "m1", Some("bound")),
            routed("anthropic-oauth", "other", None),
            json!({ "role": "user", "content": "no routing" }),
        ];
        assert_eq!(bound_account("openai-oauth", None, &messages), Some("bound".to_owned()), "the newest message of this provider, its session binding first");
        assert_eq!(bound_account("anthropic-oauth", None, &messages), Some("other".to_owned()));
        assert_eq!(bound_account("gemini", None, &messages), None);
        assert_eq!(bound_account("openai-oauth", Some(&state), &messages), Some("a0".to_owned()), "the state outranks the messages");
        assert_eq!(bound_account("openai-oauth", Some(&json!({ "providerAccountId": "a1", "providerAccountProvider": "gemini" })), &messages), Some("bound".to_owned()), "a state of another provider falls through");
    }

    #[tokio::test]
    async fn the_facts_are_the_sessions_own_services() {
        let dir = tempfile::tempdir().unwrap();
        let sensitive = Arc::new(SensitiveStore::default());
        sensitive.remember("sess_a", &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": "s3cret", "sensitive": true } } })]);
        let ledger = WarmLedger::new();
        let store = Arc::new(SideQuestionStore::new());
        let world = ProcessCompactionWorld::new(services_with(dir.path(), json!({}), sensitive, ledger.clone(), store.clone()).await);

        let facts = world.facts(&thread(), &header(" anthropic "), &[]).await;
        assert!(facts.native_pdf, "the trimmed provider is the route's");
        assert!(!world.facts(&thread(), &header("groq"), &[]).await.native_pdf);
        assert_eq!(facts.redactor.redact(vec![json!({ "role": "user", "content": "s3cret" })]), [json!({ "role": "user", "content": "[redacted]" })]);
        assert!(facts.saved_request.is_none());
        assert_eq!(facts.summary.session(), SessionRoute { provider: " anthropic ".into(), model: "m".into(), context_window: None }, "the summary route is the session's stored provider text");

        let sent = store.capture(&thread(), saved(5), Arc::new(Tagged), crate::run_host::side_question_store::tests_material(), false);
        store.settle(&sent, Some(mixdog_agent::response::ModelResponse::default()));
        let facts = world.facts(&thread(), &header("anthropic"), &[]).await;
        assert_eq!(facts.saved_request.map(|r| (r.sent_at, r.settled)), Some((5, true)));
        let route = SummaryRoute {
            step: mixdog_agent::compact::summary_run::RouteStep::Session,
            provider_name: "anthropic".into(),
            model: "m".into(),
            context_window: 0,
            calibration: 1.0,
            fast: false,
            effort: None,
            sender: Arc::new(Quiet),
        };
        assert!(matches!(facts.fork_sender.send(&route).await, Err(SummaryFailure::Failed(tag)) if tag == "saved"));
    }

    /// The cache tail of the session's next request: its owner, its `messages` tier, its last send and
    /// the account the roster plans (`''` without a roster, none when a roster provider has no account).
    #[tokio::test]
    async fn the_cache_tail_is_the_sessions_next_request() {
        let dir = tempfile::tempdir().unwrap();
        let ledger = WarmLedger::new();
        ledger.record("sess_a", WarmUse { at: 1_700_000_000_000, provider: "anthropic".into(), model: "m".into(), account_id: String::new() });
        let world = ProcessCompactionWorld::new(services_with(dir.path(), json!({}), Arc::default(), ledger, Arc::new(SideQuestionStore::new())).await);
        let mut session = header("anthropic");
        session.insert("owner".into(), json!(" Agent "));
        session.insert("providerCacheOpts".into(), json!({ "cacheStrategy": { "messages": "5m" } }));
        session.insert("lastProviderSendAt".into(), json!("1600000000000"));
        let cache = world.facts(&thread(), &session, &[]).await.cache;
        assert!(cache.agent_owner() && cache.five_minute_tail());
        assert_eq!((cache.last_provider_send_at(), cache.now_ms()), (1_600_000_000_000, NOW as u64));
        assert_eq!((cache.last_use_at(), cache.route_use_at()), (1_700_000_000_000, Some(1_700_000_000_000)));

        let lead = world.facts(&thread(), &header("anthropic"), &[]).await.cache;
        assert!(!lead.agent_owner() && !lead.five_minute_tail());
        assert_eq!(lead.last_provider_send_at(), 0, "never sent");
        // anthropic-oauth keeps a roster, and this install has no account on it.
        assert_eq!(world.facts(&thread(), &header("anthropic-oauth"), &[]).await.cache.route_use_at(), None);
    }

    /// `SessionCompactors` builds a real compactor over the real world: the session's threshold of
    /// 1 token summarizes even a one-line chat, and a window-less route has no policy.
    #[tokio::test]
    async fn session_compactors_build_a_compactor_over_the_real_world() {
        let dir = tempfile::tempdir().unwrap();
        let world = Arc::new(world(dir.path(), json!({ "compaction": { "summaryMode": "self" } }), Arc::default()).await);
        let compactors = SessionCompactors::new(world, Arc::new(Fixed));
        let rows = Arc::new(StoredRows::new());
        let input = |window: Option<u64>| CompactorInput {
            settings: CompactSettings { context_window: window, request_reserve_tokens: 1_200, configured_reserve_tokens: 800, token_calibration: 1.25, ..CompactSettings::default() },
            rows: rows.clone(),
            archive: Arc::new(Archive),
            blobs: Arc::new(NoBlobs),
        };
        let compactor = compactors.compactor(&thread(), &header("anthropic"), &[], input(Some(200_000))).await.expect("a compactor");
        assert!(compactor.estimate_tokens(&[AgentMessage::user("hello"), AgentMessage::assistant("hi", Vec::new())]) > 0);
        assert!(compactors.compactor(&thread(), &header("anthropic"), &[], input(None)).await.is_none(), "no window, no policy");
    }
}