//! [`CompactorSource`] over `FreshCompactor::for_session`: a session's compaction pipeline as Node
//! wires it (`runFreshContextCompact`). This builds `FreshParts`, `TriggerSeams`, the fork source
//! (`SessionFork`) and the route resolver (`SummaryRoutes`) from the run's own rows, archive and
//! blobs plus what the session side supplies ([`CompactionWorld`]).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::compact::compactor::{FreshCompactor, FreshParts, SessionCompactor, TriggerSeams};
use mixdog_agent::compact::dropped::Redactor;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::fresh::AttachmentSeam;
use mixdog_agent::compact::summary_run::SummaryMode;
use mixdog_agent::compact::triggers::{CacheTail, ToolMediaMeter};
use mixdog_agent::env::{Clock, Compactor};
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ProviderId;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::assemble::CompactorInput;
use super::host_seams::CompactorSource;
use super::summary_routes::{ForkSender, SavedRequest, SessionFork, SummaryHost, SummaryRoutes};

/// What a compaction reads of the session beyond the run's own rows, archive and blobs. Each field
/// is built for one session at one moment (the media meter sees its attachments, the cache tail its
/// last send).
pub struct CompactionFacts {
    /// The session's priced media (`MediaLowering`).
    pub media: Arc<dyn MediaMeter>,
    /// The same store, sized for tool-result media (`MediaLowering`).
    pub tool_media: Arc<dyn ToolMediaMeter>,
    /// The route's provider takes PDFs natively.
    pub native_pdf: bool,
    /// The attachment store the compaction references media through (`ReferencedMedia`).
    pub attachments: Arc<dyn AttachmentSeam>,
    /// The session's sensitive-value redaction of stored rows (Node `_messagesForDisk`).
    pub redactor: Arc<dyn Redactor>,
    /// The session's last request as the cache sees it (`RequestCacheTail`).
    pub cache: Arc<dyn CacheTail>,
    /// The runtime around the summary route plan.
    pub summary: Arc<dyn SummaryHost>,
    /// The side-question store's saved request of the session, if any.
    pub saved_request: Option<SavedRequest>,
    /// Sends the forked summary request.
    pub fork_sender: Arc<dyn ForkSender>,
}

/// The session side of a compaction.
#[async_trait]
pub trait CompactionWorld: Send + Sync + 'static {
    /// The session's facts. Runs once per turn, ahead of its first request. Async: the account that
    /// would serve the session's next request is read from the roster.
    async fn facts(&self, thread: &ThreadId, header: &Header, prior: &[Value]) -> CompactionFacts;
    /// The saved `config.compaction` object, the one `normalizeCompactionSummaryMode` reads
    /// (`fresh-context.mjs:113`); `None` when the install saved none.
    fn compaction_config(&self) -> Option<Value>;
    /// `retireCompactionFork(sessionId)`: a compaction rewrote the session's transcript, so the
    /// request the side-question store saved no longer holds the history a later compaction must
    /// summarize.
    fn retire_fork(&self, thread: &ThreadId);
}

pub struct SessionCompactors {
    world: Arc<dyn CompactionWorld>,
    clock: Arc<dyn Clock>,
}

impl SessionCompactors {
    pub fn new(world: Arc<dyn CompactionWorld>, clock: Arc<dyn Clock>) -> Self {
        Self { world, clock }
    }
}

/// `normalizeCompactionSummaryMode(config.compaction)`: the saved `summaryMode`, else the previous
/// release's boolean `useMaintainer === false` as `self`.
fn summary_mode(config: Option<&Value>) -> SummaryMode {
    let mode = config.and_then(|c| c.get("summaryMode")).and_then(Value::as_str);
    let maintainer = config.and_then(|c| c.get("useMaintainer")).and_then(Value::as_bool);
    SummaryMode::normalize(mode, maintainer)
}

/// `positiveInt(sessionRef.compaction.conversationThresholdTokens)`.
fn conversation_threshold(header: &Header) -> Option<u64> {
    mixdog_agent::agent_tool::scope::positive_int(header.get("compaction").and_then(|c| c.get("conversationThresholdTokens")))
}

#[async_trait]
impl CompactorSource for SessionCompactors {
    async fn compactor(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> Option<Arc<dyn Compactor>> {
        let fresh: Arc<dyn Compactor> = self.fresh(thread, header, prior, input).await?;
        Some(Arc::new(super::retiring_compactor::RetiringCompactor::new(fresh, self.world.clone(), thread.clone())))
    }
}

impl SessionCompactors {
    /// The session's compactor; `None` when the session knows no boundary (Node has no policy).
    async fn fresh(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> Option<Arc<FreshCompactor>> {
        FreshCompactor::for_session(self.session(thread, header, prior, input).await)
    }

    /// What the session's compactor is wired from: the world's facts of the session, its settings and its summary plan.
    pub(crate) async fn session(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> SessionCompactor {
        let facts = self.world.facts(thread, header, prior).await;
        let provider = header.get("provider").and_then(Value::as_str).map_or("", mixdog_js::js_trim);
        let parts = Arc::new(FreshParts {
            media: facts.media,
            replay_owner: ProviderId::from(provider),
            rows: input.rows,
            archive: input.archive,
            attachments: facts.attachments,
            redactor: facts.redactor,
            blobs: input.blobs,
        });
        SessionCompactor {
            settings: input.settings,
            parts,
            triggers: TriggerSeams { tool_media: facts.tool_media, native_pdf: facts.native_pdf, cache: facts.cache },
            fork: Arc::new(SessionFork::new(facts.saved_request, self.clock.clone(), facts.fork_sender)),
            resolver: Arc::new(SummaryRoutes::new(facts.summary)),
            summary_mode: summary_mode(self.world.compaction_config().as_ref()),
            conversation_threshold_tokens: conversation_threshold(header),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_agent::boundary::CompactSettings;
    use mixdog_agent::compact::estimate::PartMeter;
    use mixdog_agent::compact::execution_tail::MessageRows;
    use mixdog_agent::compact::summary_run::{SummaryCall, SummaryFailure, SummaryResponse, SummaryRoute, SummarySender};
    use mixdog_agent::compact::triggers::CacheWarmLedger;
    use mixdog_agent::message::AgentMessage;
    use mixdog_agent::offload::{Artifact, ArtifactStore};
    use mixdog_core_api::domain::provider::{Content, ContentPart};
    use mixdog_protocol::message_class::user_text::{Blobs, ReadError};
    use serde_json::json;

    use super::*;
    use crate::run_host::summary_routes::{MaintainerRoute, SessionRoute};
    use mixdog_core_session::session::StoredRows;

    struct TextOnly;
    impl MediaMeter for TextOnly {
        fn part(&self, part: &ContentPart) -> PartMeter {
            panic!("media part in a text-only session: {part:?}")
        }
    }
    struct NoMedia;
    impl ToolMediaMeter for NoMedia {
        fn bytes(&self, _: &Content, _: bool) -> u64 {
            0
        }
        fn count(&self, _: &Content, _: bool) -> u64 {
            0
        }
    }
    struct NoAttachments;
    #[async_trait]
    impl AttachmentSeam for NoAttachments {
        async fn reference_media(&self, message: &AgentMessage) -> AgentMessage {
            message.clone()
        }
        fn has_referencable_media(&self, _: &AgentMessage) -> bool {
            false
        }
        fn attachment_tokens(&self, _: &AgentMessage) -> u64 {
            0
        }
    }
    struct NoRedaction;
    impl Redactor for NoRedaction {
        fn redact(&self, rows: Vec<Value>) -> Vec<Value> {
            rows
        }
    }
    struct WarmTail;
    impl CacheWarmLedger for WarmTail {
        fn last_use_at(&self) -> u64 {
            0
        }
        fn route_use_at(&self) -> Option<u64> {
            None
        }
    }
    impl CacheTail for WarmTail {
        fn agent_owner(&self) -> bool {
            false
        }
        fn five_minute_tail(&self) -> bool {
            false
        }
        fn last_provider_send_at(&self) -> u64 {
            0
        }
        fn now_ms(&self) -> u64 {
            0
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
            SessionRoute { provider: "openai".into(), model: "gpt-5".into(), context_window: Some(200_000) }
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
    struct NoSend;
    #[async_trait]
    impl ForkSender for NoSend {
        async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
            unreachable!()
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
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, ReadError> {
            Ok(None)
        }
    }
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
            0
        }
    }

    struct World {
        compaction: Option<Value>,
        asked: Mutex<Vec<String>>,
        retired: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl CompactionWorld for World {
        async fn facts(&self, thread: &ThreadId, _: &Header, _: &[Value]) -> CompactionFacts {
            self.asked.lock().unwrap().push(thread.as_str().to_owned());
            CompactionFacts {
                media: Arc::new(TextOnly),
                tool_media: Arc::new(NoMedia),
                native_pdf: false,
                attachments: Arc::new(NoAttachments),
                redactor: Arc::new(NoRedaction),
                cache: Arc::new(WarmTail),
                summary: Arc::new(Host),
                saved_request: None,
                fork_sender: Arc::new(NoSend),
            }
        }
        fn compaction_config(&self) -> Option<Value> {
            self.compaction.clone()
        }
        fn retire_fork(&self, thread: &ThreadId) {
            self.retired.lock().unwrap().push(thread.as_str().to_owned());
        }
    }

    fn source(compaction: Option<Value>) -> (SessionCompactors, Arc<World>) {
        let world = Arc::new(World { compaction, asked: Mutex::new(Vec::new()), retired: Mutex::new(Vec::new()) });
        (SessionCompactors::new(world.clone(), Arc::new(Fixed)), world)
    }

    fn header(provider: &str, compaction: Value) -> Header {
        let Value::Object(header) = json!({ "provider": provider, "compaction": compaction }) else { unreachable!() };
        header
    }

    fn input(window: Option<u64>, rows: &Arc<StoredRows>) -> CompactorInput {
        CompactorInput {
            settings: CompactSettings { context_window: window, request_reserve_tokens: 1_200, configured_reserve_tokens: 800, token_calibration: 1.25, ..CompactSettings::default() },
            rows: rows.clone(),
            archive: Arc::new(Archive),
            blobs: Arc::new(NoBlobs),
        }
    }

    fn thread() -> ThreadId {
        ThreadId::from("sess_a".to_owned())
    }

    /// A one-line conversation: only a session whose summary threshold is the floor summarizes it.
    fn short() -> Vec<AgentMessage> {
        vec![AgentMessage::user("hello"), AgentMessage::assistant("hi", Vec::new())]
    }

    #[tokio::test]
    async fn a_session_with_a_boundary_gets_a_compactor_sized_by_its_settings_and_without_one_none() {
        let rows = Arc::new(StoredRows::new());
        let (compactors, world) = source(None);
        let header = header("openai", json!({}));
        let compactor = compactors.compactor(&thread(), &header, &[], input(Some(200_000), &rows)).await.expect("a compactor");
        assert!(compactor.estimate_tokens(&short()) > 0);
        assert!(compactors.compactor(&thread(), &header, &[], input(None, &rows)).await.is_none(), "no window, no policy");
        assert_eq!(*world.asked.lock().unwrap(), ["sess_a", "sess_a"]);
    }

    /// The summary threshold is the session's `positiveInt(conversationThresholdTokens)`: 1
    /// summarizes a short chat, a non-positive or absent one is the window's default.
    #[tokio::test]
    async fn the_summary_threshold_is_the_sessions_conversation_threshold() {
        let rows = Arc::new(StoredRows::new());
        let (compactors, _) = source(None);
        let triggered = |compaction: Value| {
            let (compactors, rows) = (&compactors, &rows);
            async move {
                let compactor = compactors.fresh(&thread(), &header("openai", compaction), &[], input(Some(200_000), rows)).await.unwrap();
                compactor.summary.as_ref().unwrap().triggered(&short()).await
            }
        };
        assert!(triggered(json!({ "conversationThresholdTokens": 1 })).await);
        assert!(triggered(json!({ "conversationThresholdTokens": "1.9" })).await, "floor of the number, as positiveInt");
        for default in [json!({}), json!({ "conversationThresholdTokens": 0 }), json!({ "conversationThresholdTokens": "x" }), json!({ "conversationThresholdTokens": null })] {
            assert!(!triggered(default.clone()).await, "{default}");
        }
    }

    #[tokio::test]
    async fn the_replay_owner_is_the_sessions_provider_and_the_rows_are_the_runs_own() {
        let rows = Arc::new(StoredRows::new());
        let (compactors, _) = source(None);
        let compactor = compactors.fresh(&thread(), &header(" anthropic ", json!({})), &[], input(Some(200_000), &rows)).await.unwrap();
        assert_eq!(compactor.parts.replay_owner, ProviderId::from("anthropic"));
        let run_rows: Arc<dyn MessageRows> = rows.clone();
        assert!(std::ptr::addr_eq(Arc::as_ptr(&compactor.parts.rows), Arc::as_ptr(&run_rows)));
    }

    #[test]
    fn the_summary_mode_reads_the_saved_config_as_nodes_normalizer_does() {
        let cases = [
            (None, SummaryMode::Smart),
            (Some(json!({})), SummaryMode::Smart),
            (Some(json!({ "summaryMode": "maintainer" })), SummaryMode::Maintainer),
            (Some(json!({ "summaryMode": "self" })), SummaryMode::Session),
            (Some(json!({ "summaryMode": "bogus", "useMaintainer": false })), SummaryMode::Session),
            (Some(json!({ "useMaintainer": false })), SummaryMode::Session),
            (Some(json!({ "useMaintainer": true })), SummaryMode::Smart),
            (Some(json!({ "useMaintainer": "false" })), SummaryMode::Smart),
            (Some(json!({ "summaryMode": "smart", "useMaintainer": false })), SummaryMode::Smart),
        ];
        for (config, want) in cases {
            assert_eq!(summary_mode(config.as_ref()), want, "{config:?}");
        }
    }
}
