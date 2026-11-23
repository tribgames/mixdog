//! The one real [`CompactionWorld`]: a compaction's session side, built from the process's
//! services. Each fact is the existing implementation over a service this world is given; the
//! three services nothing else provides are here: the provider traits of a route
//! ([`RegisteredRouteTraits`]), a session's request state ([`ProcessSessionRequests`]) and the
//! saved request the loop's sends leave behind (`SideQuestionStore`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::compactor::{Handoff, HandoffSource, PlannedHandoff};
use mixdog_agent::env::{Clock, CompactError, SeatedRoute};
use mixdog_agent::message::AgentMessage;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ProviderId;
use mixdog_services::memory::sensitive::SensitiveStore;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::attachment_reference::{AttachmentFiles, ReferencedMedia};
use super::compaction_redactor::SensitiveRedactor;
use super::compactors::{CompactionFacts, CompactionWorld};
use super::media::{AttachmentFacts, MediaLowering};
use super::side_question_store::{NoSavedRequest, SideQuestionStore};
use super::summary_host::SummaryServices;
use super::summary_routes::{ForkSender, SavedRequest, SessionFork, SummaryRoutes};
use mixdog_core_config::config::Config;

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

    /// Like route admission, follows retired provider IDs without building a new adapter.
    pub fn native_pdf(&self, provider: &str) -> bool {
        self.registry.registered_for_route(&provider.to_lowercase()).is_none_or(|adapter| adapter.native_pdf())
    }

    /// `provider.nativeDocuments === false`: the registered provider takes no document block of any
    /// kind. A name nothing registered declares nothing.
    pub fn no_documents(&self, provider: &str) -> bool {
        self.registry.registered_for_route(&provider.to_lowercase()).is_some_and(|adapter| adapter.native_documents() == Some(false))
    }
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

/// A session's request state: the saved requests the loop's sends record.
pub struct ProcessSessionRequests {
    /// The store the loop's sends record into; the one SideWiring shares.
    pub saved: Arc<SideQuestionStore>,
}

impl ProcessSessionRequests {
    pub fn new(saved: Arc<SideQuestionStore>) -> Self {
        Self { saved }
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
#[cfg(test)]
pub(crate) mod tests {
    use async_trait::async_trait;
    use mixdog_agent::boundary::CompactSettings;
    use mixdog_agent::offload::{Artifact, ArtifactStore};
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_ai::registry::providers::ProviderBuilder;
    use mixdog_ai::service::model_proxy_inline::ReadError;
    use mixdog_ai::transport::http::{HttpResponse, HttpSend};
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::ext::{ExtError, PdfIntake};
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::mock::{MockFileService, MockProcessManager, MockProgress, MockProvider};
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ModelRequest, ModelStream, ProviderAdapter, ProviderError, WireCodec, WireRequest};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_api::domain::tool::ToolIo;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_protocol::message_class::user_text::Blobs;
    use serde_json::{Map, json};

    use super::*;
    use crate::run_host::assemble::CompactorInput;
    use crate::run_host::attachment_reference::{InvalidReference, OriginalFile, StoredFile};
    use crate::run_host::compactors::SessionCompactors;
    use crate::run_host::host_seams::CompactorSource;
    use crate::run_host::media::StoredFacts;
    use crate::run_host::summary_host::SummaryDeps;
    use crate::run_host::summary_routes::SessionRoute;
    use mixdog_core_config::config::ConfigLanes;
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
    #[async_trait]
    impl AttachmentFacts for Recorded {
        async fn facts(&self, _: &str) -> Option<StoredFacts> {
            None
        }
    }
    struct Files;
    #[async_trait]
    impl AttachmentFiles for Files {
        async fn store_inline(&self, _: &str, _: &str, _: &str) -> Option<StoredFile> {
            None
        }
        async fn named_file(&self, _: &str, _: &str, _: &str, _: Option<&OriginalFile>) -> Result<String, ()> {
            Err(())
        }
        fn blob_path(&self, reference: &str) -> Result<String, InvalidReference> {
            Ok(reference.to_owned())
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
    #[async_trait]
    impl mixdog_agent::compact::blob_reads::BlobReads for NoBlobs {
        async fn read_with(&self, work: mixdog_agent::compact::blob_reads::StoreWork) -> Result<(), mixdog_agent::compact::blob_reads::StoreUnavailable> {
            work(self);
            Ok(())
        }
    }
    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            NOW
        }
    }
    struct Offline;
    #[async_trait]
    impl HttpSend for Offline {
        async fn send(&self, _: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
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
        fn release_send(&self, _group: &str) {}
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
    /// A registry that holds what a config enabling these providers leaves it.
    async fn registry_of(config: Value) -> Arc<ProviderRegistry> {
        let registry = Arc::new(ProviderRegistry::new(Arc::new(Builder)));
        registry.init_providers(config.as_object().unwrap()).await.unwrap();
        registry
    }

    /// `anthropic` and `openai` take a PDF; `groq` declares it does not.
    async fn registry() -> Arc<ProviderRegistry> {
        registry_of(json!({ "anthropic": { "enabled": true }, "openai": { "enabled": true }, "groq": { "enabled": true, "nativePdf": false }, "opencode-go-oauth": { "enabled": true, "nativePdf": false } })).await
    }

    fn header(provider: &str) -> Header {
        let Value::Object(header) = json!({ "provider": provider, "model": "m", "compaction": { "conversationThresholdTokens": 1 } }) else { unreachable!() };
        header
    }

    fn thread() -> ThreadId {
        ThreadId::from("sess_a".to_owned())
    }

    /// `providerNativePdf(name)`: what the registered adapter declares, whatever its name; an
    /// unregistered name is native, and the name is lower-cased before the lookup.
    #[tokio::test]
    async fn a_route_takes_a_pdf_natively_as_its_registered_adapter_declares() {
        let routes = RegisteredRouteTraits::new(registry().await);
        for (provider, native) in
            [("anthropic", true), ("Anthropic", true), ("openai", true), ("groq", false), ("opencode-go", false), ("never-registered", true), ("", true)]
        {
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
        for (value, agent) in [
            (json!("agent"), true),
            (json!(" Agent "), true),
            (json!("AGENT\n"), true),
            (json!("lead"), false),
            (json!(""), false),
            (json!(5), false),
            (json!(null), false),
            (json!(["agent"]), true),
        ] {
            assert_eq!(owner(value.clone()), agent, "{value}");
        }
        assert!(!is_agent_owner(json!({}).as_object().unwrap()));
    }

    /// The services over the real ones and a config file under dir; the saved-request store is the
    /// caller's to record into.
    pub(crate) async fn services_with(
        dir: &std::path::Path,
        agent: Value,
        sensitive: Arc<SensitiveStore>,
        saved: Arc<SideQuestionStore>,
    ) -> CompactionServices {
        services_over(dir, agent, sensitive, saved, registry().await, Map::new()).await
    }
    /// [`services_with`] over the providers `registry` holds, with `snapshot` as the configuration
    /// the summary reads.
    pub(crate) async fn services_over(
        dir: &std::path::Path,
        agent: Value,
        sensitive: Arc<SensitiveStore>,
        saved: Arc<SideQuestionStore>,
        registry: Arc<ProviderRegistry>,
        snapshot: Map<String, Value>,
    ) -> CompactionServices {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.join("mixdog-config.json");
        crate::run_host::fixture_fs::write(&path, serde_json::to_vec(&json!({ "agent": agent })).unwrap());
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let clock: Arc<dyn Clock> = Arc::new(Fixed);
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        let summaries = SummaryServices::new(SummaryDeps {
            registry: registry.clone(),
            catalog,
            config: Arc::new(move || snapshot.clone()),
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
            requests: ProcessSessionRequests::new(saved),
            summaries: Arc::new(summaries),
        }
    }
    /// The services over the real ones, for a test that records nothing into them.
    pub(crate) async fn services(dir: &std::path::Path, agent: Value, sensitive: Arc<SensitiveStore>) -> CompactionServices {
        services_with(dir, agent, sensitive, Arc::new(SideQuestionStore::new())).await
    }
    async fn world(dir: &std::path::Path, agent: Value, sensitive: Arc<SensitiveStore>) -> ProcessCompactionWorld {
        ProcessCompactionWorld::new(services(dir, agent, sensitive).await)
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
    #[tokio::test]
    async fn the_facts_are_the_sessions_own_services() {
        let dir = tempfile::tempdir().unwrap();
        let sensitive = Arc::new(SensitiveStore::default());
        sensitive.remember("sess_a", &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": "s3cret", "sensitive": true } } })]);
        let world = world(dir.path(), json!({}), sensitive).await;

        let facts = world.facts(&thread(), &header(" anthropic "), &[]).await;
        assert!(facts.native_pdf, "the trimmed provider is the route's");
        assert!(!world.facts(&thread(), &header("groq"), &[]).await.native_pdf);
        assert_eq!(facts.redactor.redact(vec![json!({ "role": "user", "content": "s3cret" })]), [json!({ "role": "user", "content": "[redacted]" })]);
        assert_eq!(
            facts.summary.session(),
            SessionRoute { provider: " anthropic ".into(), model: "m".into(), context_window: None, summary_model: None },
            "the summary route is the session's stored provider text"
        );
    }

    #[tokio::test]
    async fn the_fold_summarizes_the_round_that_settled_after_compactor_assembly() {
        use mixdog_agent::env::{CompactRequest, CompactTrigger};
        use mixdog_agent::message::{ToolKind, content_text};
        use mixdog_agent::response::ModelResponse;
        use mixdog_core_api::domain::mock::MockAttempt;
        use mixdog_core_api::domain::provider::{RequestOptions, ToolCall};

        use crate::run_host::side_requests::{RunSide, SideRequests};

        let dir = tempfile::tempdir().unwrap();
        let services = services(dir.path(), json!({ "compaction": { "summaryMode": "self" } }), Arc::default()).await;
        let side = SideRequests {
            store: services.requests.saved.clone(),
            caching: Arc::new(|_, _| true),
            docs: services.docs.clone(),
            reader: services.reader.clone(),
            facts: services.attachment_facts.clone(),
            clock: Arc::new(Fixed),
        };
        let thread = thread();
        let tap = |thread, provider: Arc<MockProvider>| side.tap(RunSide { thread, provider_name: "openai".into(), provider, agent_owner: false });
        let request = |messages: &[AgentMessage]| ModelRequest {
            model: "m".into(),
            messages: messages.iter().map(AgentMessage::wire).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let reply = |content: &str| ModelResponse { content: content.into(), ..ModelResponse::default() };
        let provider = |text: &str| Arc::new(MockProvider::new([MockAttempt::Body(format!("t:{text}\ndone\n").into_bytes())]));
        let old = provider("summary of the prior turn");
        tap(thread.clone(), old.clone()).begin(&request(&[AgentMessage::user("old request")])).settle(&reply("old reply"));

        let compactors = SessionCompactors::new(Arc::new(ProcessCompactionWorld::new(services)), Arc::new(Fixed));
        let mut header = header("openai");
        header.insert("contextWindow".into(), json!(200_000));
        let compactor = compactors
            .compactor(
                &thread,
                &header,
                &[],
                CompactorInput {
                    settings: CompactSettings { context_window: Some(200_000), ..CompactSettings::default() },
                    rows: Arc::new(StoredRows::new()),
                    archive: Arc::new(Archive),
                    blobs: Arc::new(NoBlobs),
                },
            )
            .await
            .unwrap();

        let latest = provider("summary of the settled work");
        let mut messages = vec![
            AgentMessage::user("current request"),
            AgentMessage::assistant(
                "checking the build",
                vec![ToolCall { id: "check".into(), name: "check_build".into(), arguments: json!({}), native_type: None }],
            ),
            AgentMessage::tool_text("check", "Build succeeded", ToolKind::Normal),
        ];
        tap(thread, latest.clone()).begin(&request(&messages)).settle(&reply("second round"));
        messages.push(AgentMessage::assistant("second round", Vec::new()));
        let other = provider("summary of a different session");
        tap(ThreadId::from("other"), other.clone()).begin(&request(&messages)).settle(&reply("unrelated reply"));

        let output = compactor
            .compact(CompactRequest {
                messages: &messages,
                budget_tokens: 10_000,
                trigger: CompactTrigger::Auto,
                require_reduction: false,
                reference_latest_attachments: false,
                active_turn: true,
                latest_user_prefix: "",
            })
            .await
            .unwrap();

        assert!(output.summary_route.is_some_and(|route| route.forked));
        assert!(output.messages.iter().any(|m| content_text(&m.message.content).contains("summary of the settled work")));
        let calls = |provider: &MockProvider| provider.attempts.load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!((calls(&latest), calls(&old), calls(&other)), (1, 0, 0));
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
            settings: CompactSettings {
                context_window: window,
                request_reserve_tokens: 1_200,
                configured_reserve_tokens: 800,
                token_calibration: 1.25,
                ..CompactSettings::default()
            },
            rows: rows.clone(),
            archive: Arc::new(Archive),
            blobs: Arc::new(NoBlobs),
        };
        let compactor = compactors.compactor(&thread(), &header("anthropic"), &[], input(Some(200_000))).await.expect("a compactor");
        assert!(compactor.estimate_tokens(&[AgentMessage::user("hello"), AgentMessage::assistant("hi", Vec::new())]) > 0);
        assert!(compactors.compactor(&thread(), &header("anthropic"), &[], input(None)).await.is_none(), "no window, no policy");
    }

    impl Blobs for NoBlobs {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
            Ok(None)
        }
    }
}

pub struct ProcessCompactionWorld {
    services: CompactionServices,
}
impl ProcessCompactionWorld {
    pub fn new(services: CompactionServices) -> Self {
        Self { services }
    }
}

struct FoldHandoff {
    planned: PlannedHandoff,
    thread: ThreadId,
    clock: Arc<dyn Clock>,
    store: Arc<SideQuestionStore>,
    summaries: Arc<SummaryServices>,
    /// The provider and model the session is seated on: the only route whose saved request this fold may fork.
    seated: (String, String),
}

/// The provider and model a session header seats it on.
fn seated_identity(header: &Header) -> (String, String) {
    let model = header.get("model").and_then(Value::as_str).map_or("", mixdog_js::js_trim);
    (route_provider(header).to_owned(), model.to_owned())
}

/// The saved request a fold may fork, given the one the store offers (its own selection and forgetting rules are
/// unchanged): only a request sent on the route the session is seated on. The entry a model fallback left behind was sent on
/// the departing route, so it forks nothing here until a request of the destination replaces it and settles.
fn fork_on_seated(seated: &(String, String), offered: Option<(SavedRequest, Arc<dyn ForkSender>)>) -> (Option<SavedRequest>, Arc<dyn ForkSender>) {
    match offered {
        Some((saved, sender)) if saved.provider_name == seated.0 && saved.model == seated.1 => (Some(saved), sender),
        _ => (None, Arc::new(NoSavedRequest) as _),
    }
}

#[cfg(test)]
mod seated_fork_tests {
    use super::*;

    fn entry(provider: &str, model: &str) -> Option<(SavedRequest, Arc<dyn ForkSender>)> {
        let saved = SavedRequest {
            provider_name: provider.into(),
            model: model.into(),
            cache_strategy: None,
            catalog_supports_prompt_caching: true,
            sent_at: 1,
            settled: true,
            compacted: false,
            prompt_tokens: 9,
            shared_prefix_messages: 1,
        };
        Some((saved, Arc::new(NoSavedRequest)))
    }

    /// The Fable entry a quota fallback left behind forks nothing for the GPT destination; the entry of a GPT request that
    /// settled afterwards (it replaces the Fable one in the store) is forked, whether or not the turn is the original one.
    #[test]
    fn only_a_request_sent_on_the_seated_route_is_forked() {
        let seated = ("openai-oauth".to_owned(), "gpt-6.2-astra".to_owned());
        assert!(fork_on_seated(&seated, entry("anthropic-oauth", "claude-fable-5-2")).0.is_none());
        assert!(fork_on_seated(&seated, entry("openai-oauth", "gpt-6.2-sol")).0.is_none(), "the same provider's other model is another route");
        assert_eq!(fork_on_seated(&seated, entry("openai-oauth", "gpt-6.2-astra")).0.map(|saved| saved.prompt_tokens), Some(9));
        assert!(fork_on_seated(&seated, None).0.is_none());
    }
}

#[async_trait]
impl HandoffSource for FoldHandoff {
    async fn triggered(&self, messages: &[AgentMessage]) -> bool {
        self.planned.triggered(messages).await
    }

    /// A model fallback moved the run: the summary routes resolve from the seated route, and the budgets are its own.
    fn resized(&self, seated: &SeatedRoute) -> Option<Arc<dyn HandoffSource>> {
        let planned = self.planned.sized(&seated.settings)?;
        let resolver = Arc::new(SummaryRoutes::new(self.summaries.host(&self.thread, &seated.header)));
        Some(Arc::new(FoldHandoff {
            planned: PlannedHandoff { resolver, ..planned },
            thread: self.thread.clone(),
            clock: self.clock.clone(),
            store: self.store.clone(),
            summaries: self.summaries.clone(),
            seated: seated_identity(&seated.header),
        }))
    }

    async fn handoff(&self, messages: &[AgentMessage], budget_tokens: u64) -> Result<Handoff, CompactError> {
        let (saved, sender) = fork_on_seated(&self.seated, self.store.compaction_fork(&self.thread));
        // The loop can settle more tool rounds after assembly. Warmth, sizing and the send
        // must all use this fold's entry, not independently look up whatever is latest.
        let planned = PlannedHandoff {
            fork: Arc::new(SessionFork::new(saved, self.clock.clone(), sender)),
            parts: self.planned.parts.clone(),
            resolver: self.planned.resolver.clone(),
            config: self.planned.config.clone(),
        };
        planned.handoff(messages, budget_tokens).await
    }
}

#[async_trait]
impl CompactionWorld for ProcessCompactionWorld {
    async fn facts(&self, thread: &ThreadId, header: &Header, _prior: &[Value]) -> CompactionFacts {
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
            attachments: Arc::new(ReferencedMedia::new(s.files.clone(), s.attachment_facts.clone(), media).with_reader(s.reader.clone())),
            redactor: Arc::new(SensitiveRedactor::new(s.sensitive.clone(), thread.as_str())),
            summary: s.summaries.host(thread, header),
            saved_request: None,
            fork_sender: Arc::new(NoSavedRequest),
        }
    }

    fn handoff(&self, thread: &ThreadId, header: &Header, clock: &Arc<dyn Clock>, planned: PlannedHandoff) -> Arc<dyn HandoffSource> {
        Arc::new(FoldHandoff {
            planned,
            thread: thread.clone(),
            clock: clock.clone(),
            store: self.services.requests.saved.clone(),
            summaries: self.services.summaries.clone(),
            seated: seated_identity(header),
        })
    }

    /// `config.compaction` of the agent config `loadConfig()` returns.
    fn compaction_config(&self) -> Option<Value> {
        self.services.config.agent().get("compaction").cloned()
    }

    fn retire_fork(&self, thread: &ThreadId) {
        self.services.requests.saved.retire_compaction_fork(thread);
    }
}
