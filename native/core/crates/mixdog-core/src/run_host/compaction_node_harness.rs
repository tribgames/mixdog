//! Test support for replays of Node's compaction tests: a session's compactor exactly as the run host
//! builds it (`SessionCompactors` over `FreshCompactor::for_session`), the run's own stored rows and the
//! data dir's tool-result archive, with the world around it (the summary route plan's runtime, the
//! cache tail, the attachment store) answered by the scenario.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::compactor::PlannedHandoff;
use mixdog_agent::compact::dropped::Redactor;
use mixdog_agent::compact::fresh::AttachmentSeam;
use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute, SummarySender};
use mixdog_agent::compact::triggers::{CacheTail, CacheWarmLedger};
use mixdog_agent::env::{Clock, Compactor};
use mixdog_agent::message::AgentMessage;
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_core_api::domain::ext::{DocumentText, ExtError, PdfIntake};
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_run::run_host::artifact::ToolResultArtifacts;
use mixdog_core_session::session::StoredRows;
use mixdog_protocol::ProviderId;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::assemble::CompactorInput;
use super::compactors::{CompactionFacts, CompactionWorld, SessionCompactors};
use super::host_seams::CompactorSource;
use super::media::{AttachmentFacts, MediaLowering, StoredFacts};
use super::summary_routes::{ForkSender, SavedRequest, SummaryHost};

pub(crate) fn io() -> ToolIo {
    let tokens = mixdog_rt::testing::tokens();
    ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io }
}

/// The data dir's archive of `session`, as the run host opens it.
pub(crate) fn archive(data_dir: &Path, session: &str) -> ToolResultArtifacts {
    ToolResultArtifacts::new(io(), data_dir, session)
}

/// No stored attachment exists: a scenario that reached one would be a different scenario.
pub(crate) struct NoStore;
#[async_trait]
impl DocumentText for NoStore {
    async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
        unreachable!("no document in a replayed transcript")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("no document in a replayed transcript")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("no document in a replayed transcript")
    }
}
#[async_trait]
impl AttachmentReader for NoStore {
    async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
        Err(ReadError::Permanent)
    }
}
#[async_trait]
impl AttachmentFacts for NoStore {
    async fn facts(&self, _: &str) -> Option<StoredFacts> {
        None
    }
}

/// The session's media meter (`MediaLowering`) over a store that holds nothing.
pub(crate) fn media(thread: &str, provider: &str) -> Arc<MediaLowering> {
    let store = Arc::new(NoStore);
    Arc::new(MediaLowering::new(ThreadId::from(thread.to_owned()), store.clone(), store.clone(), store, false, ProviderId::from(provider)))
}

pub(crate) struct NoAttachments;
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

pub(crate) struct NoRedaction;
impl Redactor for NoRedaction {
    fn redact(&self, rows: Vec<Value>) -> Vec<Value> {
        rows
    }
}

/// A session that never sent, so its cache is not expired.
pub(crate) struct ColdTail;
impl CacheWarmLedger for ColdTail {
    fn last_use_at(&self) -> u64 {
        0
    }
    fn route_use_at(&self) -> Option<u64> {
        None
    }
}
impl CacheTail for ColdTail {
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

/// A summary request the scenario does not expect.
pub(crate) struct NoSummary;
#[async_trait]
impl SummarySender for NoSummary {
    async fn send(&self, _: &str, _: &str, _: &mixdog_agent::compact::summary_run::SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        panic!("the replayed scenario sent a summary request")
    }
}
#[async_trait]
impl ForkSender for NoSummary {
    async fn send(&self, _: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        panic!("the replayed scenario sent a forked summary request")
    }
}

pub(crate) struct NoBlobs;
impl Blobs for NoBlobs {
    fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
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

pub(crate) struct Epoch;
impl Clock for Epoch {
    fn now_ms(&self) -> i64 {
        0
    }
}

/// The session side of the scenario: its media, the summary route plan's runtime, the saved
/// `config.compaction` and the side-question store's saved request with its fork sender.
pub(crate) struct World {
    pub provider: String,
    pub summary: Arc<dyn SummaryHost>,
    pub compaction: Option<Value>,
    pub saved_request: Option<SavedRequest>,
    pub fork_sender: Arc<dyn ForkSender>,
}

impl World {
    /// A session with no saved request: nothing to fork.
    pub(crate) fn unsaved(provider: &str, summary: Arc<dyn SummaryHost>, compaction: Option<Value>) -> Self {
        Self { provider: provider.to_owned(), summary, compaction, saved_request: None, fork_sender: Arc::new(NoSummary) }
    }
}
#[async_trait]
impl CompactionWorld for World {
    async fn facts(&self, thread: &ThreadId, _: &Header, _: &[Value]) -> CompactionFacts {
        let media = media(thread.as_str(), &self.provider);
        CompactionFacts {
            media: media.clone(),
            tool_media: media,
            native_pdf: false,
            attachments: Arc::new(NoAttachments),
            redactor: Arc::new(NoRedaction),
            cache: Arc::new(ColdTail),
            summary: self.summary.clone(),
            saved_request: self.saved_request.clone(),
            fork_sender: self.fork_sender.clone(),
        }
    }
    fn compaction_config(&self) -> Option<Value> {
        self.compaction.clone()
    }
    fn retire_fork(&self, _: &ThreadId) {}
}

/// The run host's compactor of `thread` (`SessionCompactors::compactor`) over `rows` and the
/// data dir's archive.
pub(crate) async fn session_compactor(world: World, thread: &str, header: &Header, settings: CompactSettings, rows: Arc<StoredRows>, data_dir: &Path) -> Arc<dyn Compactor> {
    let compactors = SessionCompactors::new(Arc::new(world), Arc::new(Epoch));
    let input = CompactorInput { settings, rows, archive: Arc::new(archive(data_dir, thread)), blobs: Arc::new(NoBlobs) };
    compactors.compactor(&ThreadId::from(thread.to_owned()), header, &[], input).await.expect("a compactor")
}

/// The summary plan of `thread`'s compactor as the run host wires it (`SessionCompactors` over
/// `PlannedHandoff::for_session`), its saved request read at `clock`.
pub(crate) async fn session_summary(world: World, clock: Arc<dyn Clock>, thread: &str, header: &Header, settings: CompactSettings, rows: Arc<StoredRows>, data_dir: &Path) -> PlannedHandoff {
    let compactors = SessionCompactors::new(Arc::new(world), clock);
    let input = CompactorInput { settings, rows, archive: Arc::new(archive(data_dir, thread)), blobs: Arc::new(NoBlobs) };
    let session = compactors.session(&ThreadId::from(thread.to_owned()), header, &[], input).await;
    PlannedHandoff::for_session(&session).expect("a session that knows its window").0
}
