//! The one real [`CompactionWorld`]: a compaction's session side, built from the process's
//! services. Each fact is the existing implementation over a service this world is given; the
//! services nothing else in the tree provides are the three traits below, one per owner.

use std::sync::Arc;

use mixdog_ai::registry::warm::RequestTail;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ProviderId;
use mixdog_services::memory::sensitive::SensitiveStore;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::attachment_reference::{AttachmentFiles, ReferencedMedia};
use super::cache::RequestCacheTail;
use super::compaction_redactor::SensitiveRedactor;
use super::compactors::{CompactionFacts, CompactionWorld};
use super::media::{AttachmentFacts, MediaLowering};
use super::summary_routes::{ForkSender, SavedRequest, SummaryHost};
use crate::config::Config;

/// What a provider declares of its wire (Node reads `provider.nativePdf` / `.nativeDocuments`
/// off the registered provider object).
pub trait RouteTraits: Send + Sync + 'static {
    /// `providerNativePdf(provider)`: the provider takes a PDF as a native document block.
    fn native_pdf(&self, provider: &str) -> bool;
    /// `provider.nativeDocuments === false`: the provider takes no document block of any kind.
    fn no_documents(&self, provider: &str) -> bool;
}

/// A session's live request state: what the loop's last send left behind.
pub trait SessionRequests: Send + Sync + 'static {
    /// The request's cache tail, its serving account already planned
    /// (`RequestTail::plan` / `with_account`).
    fn request_tail(&self, thread: &ThreadId, header: &Header) -> RequestTail;
    /// `sideQuestionRequest(sessionId)`: the session's latest sent request, if it keeps one.
    fn saved_request(&self, thread: &ThreadId) -> Option<SavedRequest>;
    /// Sends the forked summary request of the session's saved request.
    fn fork_sender(&self, thread: &ThreadId) -> Arc<dyn ForkSender>;
}

/// The runtime around a session's summary route plan (WP-SESSION-WIRE).
pub trait SummaryHosts: Send + Sync + 'static {
    fn summary(&self, thread: &ThreadId, header: &Header) -> Arc<dyn SummaryHost>;
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
    pub routes: Arc<dyn RouteTraits>,
    pub requests: Arc<dyn SessionRequests>,
    pub summaries: Arc<dyn SummaryHosts>,
}

pub struct ProcessCompactionWorld {
    services: CompactionServices,
}

impl ProcessCompactionWorld {
    pub fn new(services: CompactionServices) -> Self {
        Self { services }
    }
}

impl CompactionWorld for ProcessCompactionWorld {
    fn facts(&self, thread: &ThreadId, header: &Header) -> CompactionFacts {
        let s = &self.services;
        let provider = header.get("provider").and_then(Value::as_str).map_or("", mixdog_js::js_trim);
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
            cache: Arc::new(RequestCacheTail::new(s.requests.request_tail(thread, header))),
            summary: s.summaries.summary(thread, header),
            saved_request: s.requests.saved_request(thread),
            fork_sender: s.requests.fork_sender(thread),
        }
    }

    /// `config.compaction` of the agent config `loadConfig()` returns.
    fn compaction_config(&self) -> Option<Value> {
        self.services.config.agent().get("compaction").cloned()
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mixdog_agent::boundary::CompactSettings;
    use mixdog_agent::compact::summary_run::{SummaryCall, SummaryFailure, SummaryResponse, SummaryRoute, SummarySender};
    use mixdog_agent::env::Clock;
    use mixdog_agent::message::AgentMessage;
    use mixdog_agent::offload::{Artifact, ArtifactStore};
    use mixdog_ai::registry::warm::{RequestFacts, WarmLedger};
    use mixdog_ai::service::model_proxy_inline::ReadError;
    use mixdog_core_api::domain::ext::{ExtError, PdfIntake};
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_protocol::message_class::user_text::Blobs;
    use serde_json::json;

    use super::*;
    use crate::config::ConfigLanes;
    use crate::run_host::assemble::CompactorInput;
    use crate::run_host::attachment_reference::{OriginalFile, StoredFile};
    use crate::run_host::compactors::SessionCompactors;
    use crate::run_host::host_seams::CompactorSource;
    use crate::run_host::media::StoredFacts;
    use crate::run_host::summary_routes::{MaintainerRoute, SessionRoute};
    use crate::session::StoredRows;

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
    struct Traits;
    impl RouteTraits for Traits {
        fn native_pdf(&self, provider: &str) -> bool {
            provider == "anthropic"
        }
        fn no_documents(&self, _: &str) -> bool {
            false
        }
    }
    struct NoSend;
    #[async_trait]
    impl ForkSender for NoSend {
        async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!()
        }
    }
    struct Requests(WarmLedger);
    impl SessionRequests for Requests {
        fn request_tail(&self, thread: &ThreadId, header: &Header) -> RequestTail {
            RequestTail::with_account(
                self.0.clone(),
                RequestFacts {
                    session_id: thread.as_str().to_owned(),
                    provider: header["provider"].as_str().unwrap().to_owned(),
                    model: "m".into(),
                    agent_owner: false,
                    five_minute_tail: false,
                    last_provider_send_at: 0,
                    now_ms: 0,
                },
                Some(String::new()),
            )
        }
        fn saved_request(&self, _: &ThreadId) -> Option<SavedRequest> {
            None
        }
        fn fork_sender(&self, _: &ThreadId) -> Arc<dyn ForkSender> {
            Arc::new(NoSend)
        }
    }
    struct Quiet;
    #[async_trait]
    impl SummarySender for Quiet {
        async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!()
        }
    }
    struct Host;
    #[async_trait]
    impl SummaryHost for Host {
        fn session(&self) -> SessionRoute {
            SessionRoute { provider: "anthropic".into(), model: "m".into(), context_window: Some(200_000) }
        }
        fn maintainer_route(&self) -> Option<MaintainerRoute> {
            None
        }
        async fn provider_ready(&self, _: &str) -> Result<bool, SummaryFailure> {
            Ok(true)
        }
        fn whole_window(&self, _: &str, _: &str) -> u64 {
            200_000
        }
        fn calibration(&self, _: &str, _: &str) -> f64 {
            1.0
        }
        fn sender(&self, _: &str) -> Arc<dyn SummarySender> {
            Arc::new(Quiet)
        }
        async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
            None
        }
    }
    struct Summaries;
    impl SummaryHosts for Summaries {
        fn summary(&self, _: &ThreadId, _: &Header) -> Arc<dyn SummaryHost> {
            Arc::new(Host)
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
            0
        }
    }

    async fn world(dir: &std::path::Path, agent: Value, sensitive: Arc<SensitiveStore>) -> ProcessCompactionWorld {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.join("mixdog-config.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "agent": agent })).unwrap()).unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        ProcessCompactionWorld::new(CompactionServices {
            config,
            sensitive,
            docs: Arc::new(Docs),
            reader: Arc::new(Store),
            attachment_facts: Arc::new(Recorded),
            files: Arc::new(Files),
            routes: Arc::new(Traits),
            requests: Arc::new(Requests(WarmLedger::new())),
            summaries: Arc::new(Summaries),
        })
    }

    fn header(provider: &str) -> Header {
        let Value::Object(header) = json!({ "provider": provider, "compaction": { "conversationThresholdTokens": 1 } }) else { unreachable!() };
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

    #[tokio::test]
    async fn the_facts_are_the_sessions_own_services() {
        let dir = tempfile::tempdir().unwrap();
        let sensitive = Arc::new(SensitiveStore::default());
        sensitive.remember("sess_a", &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": "s3cret", "sensitive": true } } })]);
        let world = world(dir.path(), json!({}), sensitive).await;
        let facts = world.facts(&thread(), &header(" anthropic "));
        assert!(facts.native_pdf, "the trimmed provider is the route's");
        assert!(!world.facts(&thread(), &header("openai")).native_pdf);
        assert_eq!(facts.redactor.redact(vec![json!({ "role": "user", "content": "s3cret" })]), [json!({ "role": "user", "content": "[redacted]" })]);
        assert!(facts.saved_request.is_none());
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
        let compactor = compactors.compactor(&thread(), &header("anthropic"), input(Some(200_000))).expect("a compactor");
        assert!(compactor.estimate_tokens(&[AgentMessage::user("hello"), AgentMessage::assistant("hi", Vec::new())]) > 0);
        assert!(compactors.compactor(&thread(), &header("anthropic"), input(None)).is_none(), "no window, no policy");
    }
}
