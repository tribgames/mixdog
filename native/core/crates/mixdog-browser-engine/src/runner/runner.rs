//! Owner: s4-engine-runner
//! The per-command flow of the Browser Use engine (`command-runner.ts`, `command-toolkit.ts`, the queue wiring of `host-agent.ts`):
//! one [`BrowserEngine::run`] takes a command of a session and answers the reply the agent reads. In order: the command is
//! revalidated (`guard::prepare`), takes its place in the queue (`queue::CommandQueue`, one lane per page, reads overlapping), begins
//! the session's takeover guard, resolves its page through `host/browser/pages/resolve` under a lease, asks the person when the step is
//! one that asks (`approval`), runs the action by the module that owns it, settles the page, builds the reply (`reply`) and lets it
//! out through the secret guard. The page's task ownership (`task_pages`) and the command's timing row (`timing_rows`) ride along.
//!
//! What the actions read of a page lives here, per page: its latest facts (every host answer and push carries them, see
//! [`FactsHost`] and [`FactsSink`]), its latest ref set and visual grounding, and what its replies already said.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::*;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_browser_policy::timing::CommandTiming;
use mixdog_browser_policy::timing::Phase;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancelSource;
use mixdog_rt::CancelView;
use mixdog_rt::CancellationToken;
use mixdog_rt::Scope;
use mixdog_rt::Scoped;
use mixdog_rt::time::Instant;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::guard::Prepared;
use super::guard::SecretGuard;
use super::guard::guard_message;
use super::guard::guard_reply;
use super::guard::prepare;
use super::task_pages::TaskPages;
use super::timing_rows::CommandTimer;
use crate::actions::diagnostics;
use crate::actions::emulation;
use crate::actions::flow;
use crate::actions::flow::WaitReport;
use crate::actions::forms;
use crate::actions::forms::FormContext;
use crate::actions::forms::Mutation;
use crate::actions::forms::StoredLoginFill;
use crate::actions::navigation;
use crate::actions::navigation::NavigateCall;
use crate::actions::navigation::NavigateOutcome;
use crate::actions::observe;
use crate::actions::observe::LocateInput;
use crate::actions::observe::ShotPorts;
use crate::actions::observe::SnapshotPlan;
use crate::actions::page;
use crate::actions::pointer;
use crate::actions::ref_mutation::mutate_ref;
use crate::actions::registry::Action;
use crate::actions::sequence::StepRunner;
use crate::actions::sequence::sequence;
use crate::actions::target::ActionContext;
use crate::actions::target::ActionError;
use crate::actions::target::ActionOutput;
use crate::actions::target::ActionPage;
use crate::actions::target::adopt_resolved_targets;
use crate::actions::target::snapshot_of_ref;
use crate::actions::target::truthy;
use crate::actions::upload;
use crate::actions::upload::UploadError;
use crate::actions::upload::UploadTarget;
use crate::approval::binding::ObservedTarget;
use crate::approval::binding::Rebind;
use crate::approval::binding::resolve_upload_files;
use crate::approval::binding::verify;
use crate::approval::classify::ActionPolicy;
use crate::approval::classify::ApprovalCommand;
use crate::approval::classify::ApprovalError;
use crate::approval::classify::StepFacts;
use crate::approval::classify::TargetFacts;
use crate::approval::classify::browser_not_approved;
use crate::approval::classify::origin_of_url;
use crate::approval::classify::classify;
use crate::approval::classify::plan;
use crate::approval::payment::page_has_payment_evidence;
use crate::error::HostCallError;
use crate::ledger::ingest::PageLedgers;
use crate::lane::mirror::Mirror;
use crate::limits::COMMAND_TIMEOUT;
use crate::limits::CUSTOM_DROPDOWN_POLL;
use crate::limits::CUSTOM_DROPDOWN_TIMEOUT;
use crate::limits::DIALOG_TOLERANT_ACTIONS;
use crate::limits::READ_MAX_CHARS;
use crate::limits::SNAPSHOT_MAX_ELEMENTS;
use crate::limits::SNAPSHOT_TEXT_CHARS;
use crate::limits::SNAPSHOT_TOOL_MAX_ELEMENTS;
use crate::port::ApprovalPort;
use crate::port::BlobPort;
use crate::port::BrowserHost;
use crate::port::EngineSink;
use crate::port::FilePort;
use crate::port::TakeoverPort;
use crate::port::TurnEvents;
use crate::queue::key::KeyInput;
use crate::queue::key::QueueKey;
use crate::queue::key::QueueKeyHost;
use crate::queue::queue::CommandQueue;
use crate::queue::queue::Deadline;
use crate::queue::queue::Kind;
use crate::queue::queue::QueueError;
use crate::queue::queue::RunContext;
use crate::queue::user_hold::LOCAL_INPUT_TAKEOVER;
use crate::queue::user_hold::UserHold;
use crate::queue::user_wait::UserWait;
use crate::refs::access::ActionabilityReason;
use crate::refs::access::RefError;
use crate::refs::grounding::VisualGrounding;
use crate::refs::reply_recovery::FreshSnapshot;
use crate::refs::reply_recovery::RecoveryFailure;
use crate::refs::reply_recovery::RecoveryHost;
use crate::refs::reply_recovery::RefRecoveryContext;
use crate::refs::reply_recovery::decorate_recovery;
use crate::refs::reply_recovery::with_ref_recovery;
use crate::refs::ref_actions::RefActions;
use crate::refs::ref_set::RefSet;
use crate::refs::target_resolve::ResolvedTarget;
use crate::refs::target_resolve::TargetContext;
use crate::refs::target_resolve::css_element;
use crate::refs::target_resolve::TargetError;
use crate::refs::target_resolve::TargetSpec;
use crate::refs::target_resolve::resolve_targets;
use crate::reply::dialog_text::blocking_dialog_reply;
use crate::reply::downloads_text::DownloadFiles;
use crate::reply::downloads_text::DownloadReports;
use crate::reply::downloads_text::attach_download;
use crate::reply::downloads_text::did_not_complete;
use crate::reply::downloads_text::ended_as;
use crate::reply::downloads_text::list_text;
use crate::reply::downloads_text::none_to_attach;
use crate::reply::downloads_text::not_complete_to_attach;
use crate::reply::reply::EffectBaseline;
use crate::reply::reply::PageReplyState;
use crate::reply::reply::ReplyContext;
use crate::reply::reply::ReplyEffect;
use crate::reply::reply::ReplyOutcome;
use crate::reply::reply::ReplyPage;
use crate::reply::reply::ReplyRequest;
use crate::reply::reply::SnapshotCapture;
use crate::reply::reply::ToolReply;
use crate::reply::reply::build_reply;
use crate::reply::reply::page_report_text;
use crate::reply::screenshot::ImageOutput;
use crate::reply::screenshot::ScreenshotInput;
use crate::reply::screenshot::attach_screenshot;
use crate::reply::screenshot::read_capture;
use crate::reply::snapshot_format::SnapshotDiagnostics;
use crate::reply::snapshot_format::SnapshotExtras;
use crate::reply::snapshot_format::format_snapshot;
use crate::reply::tabs_text::closed_background_tab;
use crate::reply::tabs_text::list_tabs_text;
use crate::reply::tabs_text::unknown_background_tab;
use crate::reply::tabs_text::visible_tab_close_refusal;
use crate::settle::actionability::ACTIONABILITY_TIMEOUT;
use crate::settle::actionability::ActionabilityError;
use crate::settle::actionability::ProbeFailure;
use crate::settle::actionability::wait_for_actionable;
use crate::settle::postcondition::Postcondition;
use crate::settle::postcondition::describe;
use crate::settle::reply_wait::ReplyWaitError;
use crate::settle::reply_wait::ReplyWaitOptions;
use crate::settle::reply_wait::await_reply_ready;
use crate::settle::reply_wait::postcondition_matches_page;
use crate::settle::settle::AfterAction;
use crate::settle::settle::Cancelled;
use crate::settle::settle::Page;
use crate::settle::settle::PageProbe;
use crate::settle::settle::PageState;
use crate::settle::settle::SettleError;
use crate::settle::settle::SettlePolicy;
use crate::settle::settle::StepKind;
use crate::settle::settle::pause;
use crate::settle::settle::settle_after_action;
use crate::settle::settle::step_settle_result;
use crate::settle::settle::throw_if_cancelled;
use crate::types::ApprovalAnswer;
use crate::types::Binding;
use crate::types::BrowserApprovalAsk;
use crate::types::TakeoverGuard;

/// What the engine takes from the core around it.
pub struct EnginePorts {
    /// The ledgers of the claimed host's pages (the lane's mirror), and the person's holds (the lane's sink feeds both).
    pub mirror: Arc<Mirror>,
    pub hold: Arc<UserHold>,
    pub approvals: Arc<dyn ApprovalPort>,
    pub takeover: Arc<dyn TakeoverPort>,
    pub blobs: Arc<dyn BlobPort>,
    pub files: Arc<dyn FilePort>,
    /// The session's filled secrets (the core's secret input).
    pub secrets: Arc<dyn SecretGuard>,
    /// The operator's policy of which steps ask or are refused (`confirmActions`, `denyActions`, `confirmSubmit`).
    pub approval_policy: ActionPolicy,
    /// The allow-list and private-network stance a navigation is admitted under.
    pub urls: UrlPolicy,
    /// Where a screenshot kept as a file is written (`image_output: file`).
    pub frame_dir: PathBuf,
}

fn wall_clock_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A page the engine has no word of: gone, with nothing in it.
fn gone_facts(page_id: &str) -> PageFacts {
    PageFacts {
        page_id: page_id.to_owned(),
        seq: 0,
        document_id: String::new(),
        load_id: None,
        url: String::new(),
        title: String::new(),
        loading: false,
        main_frame_loading: false,
        alive: false,
        crashed: false,
        fault: None,
        background: false,
        visible: false,
        zoom: 1.0,
        pending_dialog: None,
        dismissed_dialog: None,
        pending_file_chooser: None,
        actor: None,
        user_input_at: None,
        child_sessions: Vec::new(),
        opened_popups: Vec::new(),
        refused_requests: None,
    }
}

// ---- the page facts and snapshots the engine keeps ----

/// The observation a snapshot answer made: its ref set (stamped with the document and revision) and where the page was scrolled.
struct Observation {
    refs: RefSet,
    /// The snapshot the refs were made of: a ref minted afterwards for a selector match joins it.
    payload: BrowserSnapshotPayload,
    scroll_y: f64,
}

/// What the host last said of every page: its facts (the highest `seq` wins) and its latest snapshot.
#[derive(Default)]
struct FactsStore {
    facts: Mutex<HashMap<String, PageFacts>>,
    snapshots: Mutex<HashMap<String, Arc<Observation>>>,
}

impl FactsStore {
    fn record(&self, facts: &PageFacts) {
        let mut held = locked(&self.facts);
        if held.get(&facts.page_id).is_some_and(|known| known.seq > facts.seq) {
            return;
        }
        held.insert(facts.page_id.clone(), facts.clone());
    }

    fn record_snapshot(&self, result: &HostBrowserSnapshotResult) {
        let refs = RefSet::from_payload(&result.snapshot_id, &result.payload).with_document(&result.document_id, result.revision);
        locked(&self.snapshots).insert(result.facts.page_id.clone(), Arc::new(Observation { refs, payload: result.payload.clone(), scroll_y: result.payload.scroll_y }));
    }

    /// Selector matches the snapshot did not list, given refs minted by the host (`registerCssRef`): they join the page's ref set of
    /// that snapshot, so the stale-ref recovery and the change reports know them as any listed ref. Nothing changes when the page's latest
    /// snapshot is another one or every element is already in it.
    fn register_minted(&self, page_id: &str, snapshot_id: &str, minted: &[BrowserSnapshotElement]) {
        let mut snapshots = locked(&self.snapshots);
        let Some(held) = snapshots.get(page_id).filter(|observation| observation.refs.snapshot_id == snapshot_id) else { return };
        let mut payload = held.payload.clone();
        let before = payload.elements.len();
        for element in minted {
            if held.refs.get(&element.ref_id).is_none() && !payload.elements.iter().any(|known| known.ref_id == element.ref_id) {
                payload.elements.push(element.clone());
            }
        }
        if payload.elements.len() == before {
            return;
        }
        let mut refs = RefSet::from_payload(snapshot_id, &payload).with_document(&held.refs.document_id, held.refs.revision.unwrap_or_default()).with_observation(held.refs.observation.as_deref());
        // The snapshot still covered what it covered: a minted match is not part of what the page's scan reported.
        refs.covered_elements = held.refs.covered_elements;
        let scroll_y = held.scroll_y;
        snapshots.insert(page_id.to_owned(), Arc::new(Observation { refs, payload, scroll_y }));
    }

    fn get(&self, page_id: &str) -> Option<PageFacts> {
        locked(&self.facts).get(page_id).cloned()
    }

    fn snapshot(&self, page_id: &str, snapshot_id: &str) -> Option<Arc<Observation>> {
        locked(&self.snapshots).get(page_id).filter(|observation| observation.refs.snapshot_id == snapshot_id).cloned()
    }

    fn latest_snapshot_id(&self, page_id: &str) -> Option<String> {
        locked(&self.snapshots).get(page_id).map(|observation| observation.refs.snapshot_id.clone())
    }

    fn forget(&self, page_id: &str) {
        locked(&self.facts).remove(page_id);
        locked(&self.snapshots).remove(page_id);
    }

    fn clear(&self) {
        locked(&self.facts).clear();
        locked(&self.snapshots).clear();
    }
}

/// What a host answer says of the pages it names.
trait Observed {
    fn observe(&self, store: &FactsStore);
}

macro_rules! observed_facts {
    ($($result:ty),* $(,)?) => {$(
        impl Observed for $result {
            fn observe(&self, store: &FactsStore) {
                store.record(&self.facts);
            }
        }
    )*};
}

macro_rules! observed_nothing {
    ($($result:ty),* $(,)?) => {$(
        impl Observed for $result {
            fn observe(&self, _store: &FactsStore) {}
        }
    )*};
}

observed_facts!(
    HostBrowserPageNavigateResult,
    HostBrowserPageFactsResult,
    HostBrowserPageEvalResult,
    HostBrowserPageReadResult,
    HostBrowserPageRenderCheckpointResult,
    HostBrowserPageDomQuietResult,
    HostBrowserPageDialogAnswerResult,
    HostBrowserPageSyncResult,
    HostBrowserRefCallResult,
    HostBrowserInputBatchResult,
    HostBrowserScreenshotResult,
    HostBrowserCdpSendResult,
    HostBrowserCookiesResult,
    HostBrowserStorageResult,
    HostBrowserEmulationResult,
    HostBrowserUploadResult,
    HostBrowserUploadReceiverResult,
    HostBrowserCredentialsFillResult,
    HostBrowserRevisionResult,
);

impl Observed for HostBrowserRefMintResult {
    fn observe(&self, store: &FactsStore) {
        store.record(&self.facts);
        // A minted ref is `<snapshot>-t<n>`: the snapshot it belongs to is the page's latest when that prefix is its id.
        let Some(snapshot_id) = store.latest_snapshot_id(&self.facts.page_id) else { return };
        let prefix = format!("{snapshot_id}-t");
        let minted: Vec<BrowserSnapshotElement> =
            self.matches.iter().filter(|found| found.ref_id.starts_with(&prefix)).map(|found| css_element(found.ref_id.clone(), found.role.clone(), found.name.clone())).collect();
        store.register_minted(&self.facts.page_id, &snapshot_id, &minted);
    }
}
observed_nothing!(HostBrowserPagesCloseResult, HostBrowserInitScriptsResult, HostBrowserInterceptResult, HostBrowserPerformanceResult, HostBrowserDownloadsResult, HostBrowserTurnResult);

impl Observed for HostBrowserSignInResult {
    fn observe(&self, store: &FactsStore) {
        if let Some(facts) = &self.facts {
            store.record(facts);
        }
    }
}

impl Observed for HostBrowserSnapshotResult {
    fn observe(&self, store: &FactsStore) {
        store.record(&self.facts);
        store.record_snapshot(self);
    }
}

impl Observed for HostBrowserPagesResolveResult {
    fn observe(&self, store: &FactsStore) {
        store.record(&self.page.facts);
    }
}

impl Observed for HostBrowserPagesListResult {
    fn observe(&self, store: &FactsStore) {
        for page in &self.pages {
            store.record(&page.facts);
        }
    }
}

impl Observed for HostBrowserPagesSurfaceResult {
    fn observe(&self, store: &FactsStore) {
        if let Some(facts) = &self.facts {
            store.record(facts);
        }
    }
}

/// The host lane with a memory: every answer that carries a page's facts (and a refused precondition, which carries them too) is
/// kept, so the engine reads a page's present state without asking.
struct FactsHost {
    inner: Arc<dyn BrowserHost>,
    store: Arc<FactsStore>,
}

macro_rules! recording_host {
    ($($name:ident, $params:ty, $result:ty;)*) => {
        #[async_trait]
        impl BrowserHost for FactsHost {
            $(async fn $name(&self, params: $params, cancel: &CancellationToken) -> Result<$result, HostCallError> {
                let answer = self.inner.$name(params, cancel).await;
                match &answer {
                    Ok(result) => result.observe(&self.store),
                    Err(HostCallError::PreconditionFailed { facts, .. }) => self.store.record(facts),
                    Err(_) => {}
                }
                answer
            })*

            fn lease_release(&self, params: HostBrowserLeaseReleaseParams) -> Result<(), HostCallError> {
                self.inner.lease_release(params)
            }
        }
    };
}

recording_host! {
    pages_resolve, HostBrowserPagesResolveParams, HostBrowserPagesResolveResult;
    pages_list, HostBrowserPagesListParams, HostBrowserPagesListResult;
    pages_close, HostBrowserPagesCloseParams, HostBrowserPagesCloseResult;
    pages_surface, HostBrowserPagesSurfaceParams, HostBrowserPagesSurfaceResult;
    page_navigate, HostBrowserPageNavigateParams, HostBrowserPageNavigateResult;
    page_stop, HostBrowserPageStopParams, HostBrowserPageFactsResult;
    page_eval, HostBrowserPageEvalParams, HostBrowserPageEvalResult;
    page_read, HostBrowserPageReadParams, HostBrowserPageReadResult;
    page_render_checkpoint, HostBrowserPageRenderCheckpointParams, HostBrowserPageRenderCheckpointResult;
    page_dom_quiet, HostBrowserPageDomQuietParams, HostBrowserPageDomQuietResult;
    page_dialog_answer, HostBrowserPageDialogAnswerParams, HostBrowserPageDialogAnswerResult;
    page_sync, HostBrowserPageSyncParams, HostBrowserPageSyncResult;
    snapshot, HostBrowserSnapshotParams, HostBrowserSnapshotResult;
    revision, HostBrowserRevisionParams, HostBrowserRevisionResult;
    ref_call, HostBrowserRefCallParams, HostBrowserRefCallResult;
    input_batch, HostBrowserInputBatchParams, HostBrowserInputBatchResult;
    screenshot, HostBrowserScreenshotParams, HostBrowserScreenshotResult;
    cdp_send, HostBrowserCdpSendParams, HostBrowserCdpSendResult;
    cookies, HostBrowserCookiesParams, HostBrowserCookiesResult;
    storage, HostBrowserStorageParams, HostBrowserStorageResult;
    init_scripts, HostBrowserInitScriptsParams, HostBrowserInitScriptsResult;
    intercept, HostBrowserInterceptParams, HostBrowserInterceptResult;
    performance, HostBrowserPerformanceParams, HostBrowserPerformanceResult;
    emulation, HostBrowserEmulationParams, HostBrowserEmulationResult;
    downloads, HostBrowserDownloadsParams, HostBrowserDownloadsResult;
    upload, HostBrowserUploadParams, HostBrowserUploadResult;
    upload_receiver, HostBrowserUploadReceiverParams, HostBrowserUploadReceiverResult;
    ref_mint, HostBrowserRefMintParams, HostBrowserRefMintResult;
    sign_in, HostBrowserSignInParams, HostBrowserSignInResult;
    credentials_fill, HostBrowserCredentialsFillParams, HostBrowserCredentialsFillResult;
    turn, HostBrowserTurnParams, HostBrowserTurnResult;
}

/// What the host pushes, on its way to the lane's sink: the pushed facts are kept here too, and the end of the host's claim forgets
/// every page.
struct FactsSink {
    inner: Arc<dyn EngineSink>,
    store: Arc<FactsStore>,
}

impl EngineSink for FactsSink {
    fn events(&self, params: HostBrowserEventsParams) {
        self.inner.events(params);
    }

    fn facts(&self, params: HostBrowserPageFactsParams) {
        self.store.record(&params.facts);
        self.inner.facts(params);
    }

    fn user_input(&self, params: HostBrowserUserInputParams) {
        self.inner.user_input(params);
    }

    fn host_gone(&self) {
        self.store.clear();
        self.inner.host_gone();
    }
}

// ---- the engine ----

/// One session's pages as the engine learned them from the host: the selected page and the named background pages (what the queue
/// key of a command with no page id is derived from).
#[derive(Default)]
struct SessionPages {
    current: Option<String>,
    backgrounds: HashMap<String, String>,
    names: HashMap<String, String>,
}

#[derive(Default)]
struct Directory {
    sessions: HashMap<String, SessionPages>,
}

impl Directory {
    /// A page the host described: a hidden one is known by its tab name, a visible one is the session's selected page.
    fn observe_page(&mut self, session: &str, page: &PageDescriptor) {
        let held = self.sessions.entry(session.to_owned()).or_default();
        if page.background {
            held.backgrounds.insert(page.tab_id.clone(), page.page_id.clone());
            held.names.insert(page.page_id.clone(), page.tab_id.clone());
        } else {
            held.current = Some(page.page_id.clone());
        }
    }

    /// The session's whole list: what the host says is selected now replaces what was.
    fn observe_list(&mut self, session: &str, pages: &[PageDescriptor], active: Option<&str>) {
        let held = self.sessions.entry(session.to_owned()).or_default();
        held.backgrounds.clear();
        held.names.clear();
        for page in pages.iter().filter(|page| page.background) {
            held.backgrounds.insert(page.tab_id.clone(), page.page_id.clone());
            held.names.insert(page.page_id.clone(), page.tab_id.clone());
        }
        held.current = active.map(str::to_owned);
    }

    fn forget_page(&mut self, page_id: &str) {
        for held in self.sessions.values_mut() {
            if held.current.as_deref() == Some(page_id) {
                held.current = None;
            }
            if let Some(name) = held.names.remove(page_id) {
                held.backgrounds.remove(&name);
            }
        }
    }
}

impl QueueKeyHost for Directory {
    fn current_page_id(&self, session: &str) -> Option<String> {
        self.sessions.get(session)?.current.clone()
    }

    fn background_page_id(&self, session: &str, name: &str) -> Option<String> {
        self.sessions.get(session)?.backgrounds.get(name).cloned()
    }

    fn background_name_by_page_id(&self, session: &str, page_id: &str) -> Option<String> {
        self.sessions.get(session)?.names.get(page_id).cloned()
    }
}

/// What a page's replies remember: its latest observation (the ref set the agent addresses), the screenshot coordinates are
/// expressed in, and what was already said.
#[derive(Default)]
struct SlotState {
    refs: Option<RefSet>,
    grounding: Option<VisualGrounding>,
    reply: PageReplyState,
    reports: DownloadReports,
    /// Where the page was scrolled when `refs` was observed.
    scroll_y: Option<f64>,
}

#[derive(Default)]
struct PageSlot {
    state: Mutex<SlotState>,
}

struct Inner {
    host: Arc<FactsHost>,
    ports: EnginePorts,
    store: Arc<FactsStore>,
    queue: CommandQueue,
    slots: Mutex<HashMap<String, Arc<PageSlot>>>,
    directory: Mutex<Directory>,
    tasks: Mutex<TaskPages>,
    commands: AtomicU64,
    /// The commands of each session that were asked and have not ended (queued or running): a turn's end waits for them.
    in_flight: Mutex<HashMap<String, Vec<(u64, CancellationToken)>>>,
    /// The reader of saved downloads an inline attach needs; the composing core sets it once.
    download_files: OnceLock<Arc<dyn DownloadFiles>>,
}

/// The Browser Use engine: one per claimed host. It is cheap to clone; clones are the same engine.
#[derive(Clone)]
pub struct BrowserEngine {
    inner: Arc<Inner>,
}

/// Why a command ended without the reply it was after.
#[derive(Debug)]
enum RunError {
    /// A failure the agent reads, as the text says it.
    Failed(String),
    Cancelled(Option<Arc<str>>),
    /// The command ran past its ceiling.
    TimedOut(String),
    /// A failure the core already typed (a person who did not approve).
    Tool(ToolError),
    /// The command ends with this reply instead of failing (a dialog blocks the page).
    Reply(ToolReply),
}

impl From<Cancelled> for RunError {
    fn from(cancelled: Cancelled) -> Self {
        Self::Cancelled(cancelled.reason)
    }
}

impl From<QueueError> for RunError {
    fn from(error: QueueError) -> Self {
        match error {
            QueueError::Cancelled { reason } => Self::Cancelled(reason),
            QueueError::TimedOut { .. } => Self::TimedOut(error.to_string()),
            QueueError::LocalInput => Self::Failed(LOCAL_INPUT_TAKEOVER.to_owned()),
        }
    }
}

impl From<HostCallError> for RunError {
    fn from(error: HostCallError) -> Self {
        match error {
            HostCallError::Cancelled => Self::Cancelled(None),
            HostCallError::DialogBlocking { dialog } => Self::Reply(blocking_dialog_reply(&dialog, false, &|text: &str| redact_browser_text(text))),
            HostCallError::PageGone => Self::Failed("the page is gone; call list_tabs to see what is open, then navigate or use background:true".to_owned()),
            HostCallError::UserInput { .. } => Self::Failed(LOCAL_INPUT_TAKEOVER.to_owned()),
            HostCallError::StaleSnapshot => Self::Failed("the snapshot is stale; take a fresh snapshot before continuing".to_owned()),
            HostCallError::PreconditionFailed { reason, .. } => {
                Self::Failed(format!("the page changed before the action was sent ({reason:?}); nothing was dispatched. Take a fresh snapshot before continuing."))
            }
            HostCallError::Refused { reason } => Self::Failed(reason),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl From<ActionError> for RunError {
    fn from(error: ActionError) -> Self {
        match error {
            ActionError::Cancelled(cancelled) => cancelled.into(),
            ActionError::Host(error) => error.into(),
            ActionError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<observe::ActionError> for RunError {
    fn from(error: observe::ActionError) -> Self {
        match error {
            observe::ActionError::Cancelled(cancelled) => cancelled.into(),
            observe::ActionError::Host(error) => error.into(),
            observe::ActionError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<RefError> for RunError {
    fn from(error: RefError) -> Self {
        match error {
            RefError::Host(error) => error.into(),
            RefError::Refused { message, .. } | RefError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<page::PageActionError> for RunError {
    fn from(error: page::PageActionError) -> Self {
        match error {
            page::PageActionError::Invalid(message) => Self::Failed(message),
            page::PageActionError::Host(error) => error.into(),
        }
    }
}

impl From<UploadError> for RunError {
    fn from(error: UploadError) -> Self {
        match error {
            UploadError::Invalid(message) | UploadError::Failed(message) => Self::Failed(message),
            UploadError::Host(error) => error.into(),
        }
    }
}

impl From<ReplyWaitError> for RunError {
    fn from(error: ReplyWaitError) -> Self {
        match error {
            ReplyWaitError::Settle(SettleError::Cancelled(cancelled)) => cancelled.into(),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl From<crate::reply::reply::ReplyError> for RunError {
    fn from(error: crate::reply::reply::ReplyError) -> Self {
        Self::Failed(error.message)
    }
}

impl From<ApprovalError> for RunError {
    fn from(error: ApprovalError) -> Self {
        match error {
            ApprovalError::NotApproved { reason } => Self::Tool(ToolError::new(ToolErrorCode::PermissionDenied, browser_not_approved(&reason))),
            ApprovalError::Cancelled => Self::Cancelled(None),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl RunError {
    /// The failure as the tool answers it, its text through the secret guard.
    fn into_tool_error(self, secrets: &dyn SecretGuard, session: &str) -> ToolError {
        let guarded = |message: &str| guard_message(secrets, session, &redact_browser_text(message));
        match self {
            Self::Failed(message) => {
                let message = guarded(&message);
                ToolError::new(ToolErrorCode::Failed { reason: message.clone() }, message)
            }
            Self::Reply(reply) => {
                let message = guarded(&reply.text);
                ToolError::new(ToolErrorCode::Failed { reason: message.clone() }, message)
            }
            Self::Cancelled(reason) => ToolError::new(ToolErrorCode::Cancelled, reason.map_or_else(|| "browser command cancelled".to_owned(), |reason| reason.to_string())),
            Self::TimedOut(message) => ToolError::new(ToolErrorCode::DeadlineExceeded { partial: false }, message),
            Self::Tool(error) => error,
        }
    }
}

/// A command that did not answer: what the tool fails with, and the timing row of the part of the command that ran (`None` where it
/// failed before it took its place, an invalid request).
#[derive(Debug)]
pub struct CommandFailure {
    pub error: ToolError,
    pub timing: Option<CommandTiming>,
}

/// [`CommandFailure`] before the secret guard has worded the error.
struct Failed {
    error: RunError,
    timing: Option<CommandTiming>,
}

impl From<RunError> for Failed {
    fn from(error: RunError) -> Self {
        Self { error, timing: None }
    }
}

/// A page a command holds by its lease; the host is told when the command is done with it.
struct LeaseGuard {
    host: Arc<FactsHost>,
    page_id: String,
    lease_id: String,
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        let _ = self.host.lease_release(HostBrowserLeaseReleaseParams { page_id: self.page_id.clone(), lease_id: self.lease_id.clone() });
    }
}

impl BrowserEngine {
    /// An engine over the host lane `host`, with the services of the core around it.
    pub fn new(host: Arc<dyn BrowserHost>, ports: EnginePorts) -> Self {
        let store = Arc::new(FactsStore::default());
        let queue = CommandQueue::new(ports.hold.clone());
        let host = Arc::new(FactsHost { inner: host, store: store.clone() });
        Self {
            inner: Arc::new(Inner {
                host,
                ports,
                store,
                queue,
                slots: Mutex::new(HashMap::new()),
                directory: Mutex::new(Directory::default()),
                tasks: Mutex::new(TaskPages::default()),
                commands: AtomicU64::new(0),
                in_flight: Mutex::new(HashMap::new()),
                download_files: OnceLock::new(),
            }),
        }
    }

    /// The reader of saved downloads a `downloads` attach returns inline; set once by the core that composes the engine. A second
    /// call changes nothing.
    pub fn set_download_files(&self, files: Arc<dyn DownloadFiles>) {
        let _ = self.inner.download_files.set(files);
    }

    /// What the host pushes goes through this: it is `inner` (the lane's sink), and the engine keeps the facts that pass.
    pub fn sink(&self, inner: Arc<dyn EngineSink>) -> Arc<dyn EngineSink> {
        Arc::new(FactsSink { inner, store: self.inner.store.clone() })
    }

    /// One Browser Use command of `thread`. `input` is the tool's arguments without `action`, with the runtime-set fields the
    /// runtime adds (`unattended_run`, `unattended_agent`, `session_life`, `mail_link`). The command belongs to the session's
    /// running turn (`TurnEvents` ends it).
    pub async fn run(&self, thread: &ThreadId, action: &str, input: &Map<String, Value>, cancel: &CancellationToken) -> Result<ToolReply, CommandFailure> {
        let inner = &self.inner;
        let turn = locked(&inner.tasks).current(thread.as_str());
        match inner.run_command(thread, turn, action, input, cancel).await {
            Ok(reply) => Ok(guard_reply(&*inner.ports.secrets, thread.as_str(), reply)),
            Err(Failed { error, timing }) => Err(CommandFailure { error: error.into_tool_error(&*inner.ports.secrets, thread.as_str()), timing }),
        }
    }

    /// The running turn of `thread` ended (`finishBrowserTurn`): the pages it opened for itself are released when it was aborted (a
    /// dialog that needs a person keeps its page), no later command of that turn runs, and the host drops what it remembered of the
    /// turn and the untouched blank page the agent has since left behind. A turn nobody ran a command in is nothing to finish.
    /// Answers how many pages were closed.
    pub async fn finish_turn(&self, thread: &ThreadId, aborted: bool) -> usize {
        match self.inner.end_turn(thread, aborted) {
            Some(ended) => self.inner.close_ended(thread, ended, aborted).await,
            None => 0,
        }
    }

    /// The session is released: the pages it owned are no longer tracked, and the host forgets what it remembered of it.
    pub async fn forget_session(&self, thread: &ThreadId) {
        locked(&self.inner.tasks).forget(thread.as_str());
        // The session's pages are gone with it, and so is the person's hold on them (`releaseLocal`): a hold left behind would
        // refuse the next agent command on a page id the host never reuses, and keep a record for ever.
        if let Some(held) = locked(&self.inner.directory).sessions.remove(thread.as_str()) {
            for page_id in held.current.iter().chain(held.backgrounds.values()) {
                self.inner.ports.hold.release_page(page_id);
            }
        }
        self.inner.turn_note(thread, BrowserTurnOp::Forget, None, false).await;
    }
}

impl TurnEvents for BrowserEngine {
    fn turn_ended(&self, thread: &ThreadId, aborted: bool) {
        // The turn's end is marked here, before this returns: the first command of the next turn is the next turn's however soon it
        // comes. Only the closing of the pages and the note to the host are left to the task.
        let Some(ended) = self.inner.end_turn(thread, aborted) else { return };
        let inner = self.inner.clone();
        let thread = thread.clone();
        mixdog_rt::spawn("browser-turn-pages", mixdog_rt::TaskClass::Work, async move {
            inner.close_ended(&thread, ended, aborted).await;
        });
    }

    fn session_ended(&self, thread: &ThreadId) {
        let engine = self.clone();
        let thread = thread.clone();
        mixdog_rt::spawn("browser-session-pages", mixdog_rt::TaskClass::Work, async move {
            engine.forget_session(&thread).await;
        });
    }
}

/// A turn that was marked ended: its number and the pages it owned that are to be closed.
struct EndedTurn {
    turn: u64,
    closing: Vec<String>,
    /// The session's commands in flight when the turn ended: its pages are closed after they are done, not under them.
    in_flight: Vec<CancellationToken>,
}

/// A command of a session that is in flight; dropping it records it as done.
struct InFlight {
    inner: Arc<Inner>,
    session: String,
    id: u64,
    done: CancellationToken,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        let mut flights = locked(&self.inner.in_flight);
        if let Some(held) = flights.get_mut(&self.session) {
            held.retain(|(id, _)| *id != self.id);
            if held.is_empty() {
                flights.remove(&self.session);
            }
        }
        drop(flights);
        self.done.cancel();
    }
}

impl Inner {
    /// Marks the running turn of `thread` as ended, and takes the pages it releases. `None`: no command ran in it.
    fn end_turn(&self, thread: &ThreadId, aborted: bool) -> Option<EndedTurn> {
        let mut tasks = locked(&self.tasks);
        if !tasks.take_touched(thread.as_str()) {
            return None;
        }
        let turn = tasks.current(thread.as_str());
        let store = self.store.clone();
        let closing = tasks.finish(thread.as_str(), turn, aborted, |page| !store.get(page).is_some_and(|facts| facts.pending_dialog.is_some()));
        drop(tasks);
        let in_flight: Vec<CancellationToken> = locked(&self.in_flight).get(thread.as_str()).map(|held| held.iter().map(|(_, done)| done.clone()).collect()).unwrap_or_default();
        Some(EndedTurn { turn, closing, in_flight })
    }

    /// Records a command of `session` as in flight until the returned guard is dropped.
    fn track(self: &Arc<Self>, session: &str) -> InFlight {
        let id = self.commands.fetch_add(1, Ordering::Relaxed);
        let done = CancellationToken::new();
        locked(&self.in_flight).entry(session.to_owned()).or_default().push((id, done.clone()));
        InFlight { inner: self.clone(), session: session.to_owned(), id, done }
    }

    /// Closes the pages an ended turn released and tells the host the turn ended; answers how many pages were closed.
    async fn close_ended(&self, thread: &ThreadId, ended: EndedTurn, aborted: bool) -> usize {
        // A command of the turn still running has the page in hand: it ends (or is ended by its caller) before the page is closed.
        for done in &ended.in_flight {
            done.cancelled().await;
        }
        let mut closed = 0;
        for page_id in ended.closing {
            let params = HostBrowserPagesCloseParams { page_id: page_id.clone(), reason: BrowserPageCloseReason::TurnEnd };
            match self.host.pages_close(params, &CancellationToken::new()).await {
                Ok(answer) => {
                    closed += usize::from(answer.closed);
                    self.drop_page(&page_id);
                }
                // A page destroyed while the close ran is closed: nothing is left to try again.
                Err(HostCallError::PageGone) => self.drop_page(&page_id),
                // A close the host failed leaves the page owned, as the lifecycle kept it, so a later cleanup of it can try again.
                Err(_) => locked(&self.tasks).reown(thread.as_str(), ended.turn, &page_id),
            }
        }
        self.turn_note(thread, BrowserTurnOp::End, Some(ended.turn), aborted).await;
        closed
    }

    /// A turn-level note to the host (the turn ended, the session was released). The host keeps only memory for them, so a host
    /// that cannot answer changes nothing the agent reads.
    async fn turn_note(&self, thread: &ThreadId, op: BrowserTurnOp, turn: Option<u64>, aborted: bool) {
        let params = HostBrowserTurnParams { session_id: thread.as_str().to_owned(), op, turn: turn.and_then(|turn| i64::try_from(turn).ok()), aborted: Some(aborted) };
        let _ = self.host.turn(params, &CancellationToken::new()).await;
    }

    fn slot(&self, page_id: &str) -> Arc<PageSlot> {
        locked(&self.slots).entry(page_id.to_owned()).or_default().clone()
    }

    fn drop_page(&self, page_id: &str) {
        locked(&self.slots).remove(page_id);
        locked(&self.directory).forget_page(page_id);
        self.store.forget(page_id);
        self.ports.mirror.forget(page_id);
    }

    async fn run_command(self: &Arc<Self>, thread: &ThreadId, turn: u64, action: &str, input: &Map<String, Value>, cancel: &CancellationToken) -> Result<ToolReply, Failed> {
        let session = thread.as_str();
        let prepared = prepare(action, input, session, turn).map_err(RunError::Failed)?;
        let _flight = self.track(session);
        let key = {
            let directory = locked(&self.directory);
            QueueKey::for_command(&*directory, &KeyInput { session: Some(session), action: prepared.action.name(), tab: &prepared.tab, background: prepared.background })
        }
        .map_err(|error| RunError::Failed(error.to_string()))?;
        let kind = Kind::of_action(prepared.action.name());
        let deadline = Deadline::command(prepared.action.name());
        let parent = CancelSource::new();
        let enqueued = Instant::now();
        let queued = self.queue.run(&key, kind, &deadline, &parent, |ctx| self.in_lane(thread, turn, prepared, ctx, enqueued));
        match Scope::new().cancel(cancel).run(queued).await {
            Scoped::Done(Ok(result)) => result,
            Scoped::Done(Err(error)) => Err(RunError::from(error).into()),
            Scoped::Cancelled | Scoped::DeadlineExceeded => Err(RunError::Cancelled(None).into()),
        }
    }

    /// The command holds its lane: the session's takeover guard begins (a person who took the session over refuses it, and one who
    /// takes it over meanwhile stops it), and its timing row is kept.
    async fn in_lane(self: &Arc<Self>, thread: &ThreadId, turn: u64, prepared: Prepared, ctx: RunContext, enqueued: Instant) -> Result<ToolReply, Failed> {
        let timer = Arc::new(CommandTimer::start(enqueued.elapsed().as_secs_f64() * 1000.0));
        let guard = self.ports.takeover.begin(thread.as_str()).map_err(RunError::Failed)?;
        let stopped = guard.cancelled();
        let outcome = Scope::new().cancel(&stopped).run(self.execute(thread, turn, prepared, &ctx, &timer)).await;
        drop(guard);
        let timing = timer.finish();
        match outcome {
            Scoped::Done(Ok(mut reply)) => {
                reply.timing = Some(timing);
                Ok(reply)
            }
            Scoped::Done(Err(error)) => Err(Failed { error, timing: Some(timing) }),
            Scoped::Cancelled | Scoped::DeadlineExceeded => Err(Failed { error: RunError::Failed(TakeoverGuard::STOPPED.to_owned()), timing: Some(timing) }),
        }
    }

    async fn execute(self: &Arc<Self>, thread: &ThreadId, turn: u64, prepared: Prepared, ctx: &RunContext, timer: &Arc<CommandTimer>) -> Result<ToolReply, RunError> {
        match self.execute_resolved(thread, turn, prepared, ctx, timer).await {
            Err(RunError::Reply(reply)) => Ok(reply),
            other => other,
        }
    }

    async fn execute_resolved(self: &Arc<Self>, thread: &ThreadId, turn: u64, prepared: Prepared, ctx: &RunContext, timer: &Arc<CommandTimer>) -> Result<ToolReply, RunError> {
        let Prepared { action, mut command, background, tab, expected, has_screenshot_options } = prepared;
        let session = thread.as_str();
        if action.is_tabless() {
            // A tab-less step is asked about like any other, against the session itself.
            self.approve(thread, &mut command, None, &ctx.cancel, &ctx.user_wait).await?;
            return self.tabless(action, &command, session, &tab, ctx).await;
        }
        locked(&self.tasks).begin(session, turn).map_err(RunError::Failed)?;
        let (descriptor, placement, _lease) = self.resolve_page(session, action, background, &tab, &ctx.cancel).await?;
        let page_id = descriptor.page_id.clone();
        {
            // A page this command made (none was open) or a hidden helper of the agent is the turn's to reclaim, as the host says
            // (`disposable`); `open` keeps its page for the user.
            let mut tasks = locked(&self.tasks);
            tasks.use_page(session, turn, &page_id, descriptor.disposable).map_err(RunError::Failed)?;
            if action == Action::Open && !background {
                tasks.retain(&page_id);
            }
        }
        let page = PageCtx {
            inner: self.clone(),
            slot: self.slot(&page_id),
            page_id: page_id.clone(),
            thread: thread.clone(),
            turn,
            cancel: ctx.cancel.clone(),
            user_wait: ctx.user_wait.clone(),
            timer: timer.clone(),
            background: background || descriptor.background,
        };
        let hints = SignInHints::of(&command);
        let worked = async {
            // A page a dialog holds answers with the dialog and runs no sign-in hook: the host's reader would read a blocked page.
            if let Some(blocked) = page.dialog_block(action) {
                return Ok(blocked);
            }
            let reply = page.act(action, command, expected, has_screenshot_options).await?;
            page.after_command(action, background, placement, &hints, reply).await
        }
        .await;
        let reply = match worked {
            Ok(reply) => reply,
            Err(error) => return Err(self.discard_created(&descriptor, error).await),
        };
        let popups = page.page_facts().opened_popups;
        let mut tasks = locked(&self.tasks);
        for popup in &popups {
            tasks.inherit(&page_id, popup);
        }
        Ok(reply)
    }

    /// A command failed on a page it made: when the page holds no document the host closes it, so a refused address leaves no blank
    /// tab behind, and the failure says so (`discardCreatedPage`).
    async fn discard_created(&self, descriptor: &PageDescriptor, error: RunError) -> RunError {
        if !descriptor.created || matches!(error, RunError::Reply(_)) {
            return error;
        }
        let params = HostBrowserPagesCloseParams { page_id: descriptor.page_id.clone(), reason: BrowserPageCloseReason::Discard };
        if !self.host.pages_close(params, &CancellationToken::new()).await.is_ok_and(|answer| answer.closed) {
            return error;
        }
        self.drop_page(&descriptor.page_id);
        match error {
            RunError::Failed(message) => RunError::Failed(format!("{} The blank tab this command opened was closed.", with_final_stop(&message))),
            other => other,
        }
    }

    /// The page a command works on, opened or adopted when the action needs one, held by a lease until the command is done.
    async fn resolve_page(
        &self,
        session: &str,
        action: Action,
        background: bool,
        tab: &str,
        cancel: &CancelView,
    ) -> Result<(PageDescriptor, Option<BrowserPlacement>, Option<LeaseGuard>), RunError> {
        let command_id = format!("{session}:{}", self.commands.fetch_add(1, Ordering::Relaxed));
        let open = match action {
            Action::Open => Some(BrowserOpenSpec { url: None, reveal: !background }),
            Action::Navigate => Some(BrowserOpenSpec { url: None, reveal: false }),
            _ => None,
        };
        let params = HostBrowserPagesResolveParams {
            session_id: session.to_owned(),
            background: Some(background),
            tab: (!tab.is_empty()).then(|| BrowserTabSelector { index: None, page_id: Some(tab.to_owned()) }),
            open,
            adopt: None,
            lease: Some(BrowserLeaseSpec { command_id, ttl_ms: u32::try_from(COMMAND_TIMEOUT.as_millis()).unwrap_or(u32::MAX) }),
        };
        let answer = self.host.pages_resolve(params, cancel.token()).await?;
        locked(&self.directory).observe_page(session, &answer.page);
        let lease = answer.lease_id.map(|lease_id| LeaseGuard { host: self.host.clone(), page_id: answer.page.page_id.clone(), lease_id });
        Ok((answer.page, answer.placement, lease))
    }

    /// The session's own actions: the tab list, closing a background tab, hiding the panel, and the downloads.
    async fn tabless(&self, action: Action, command: &Value, session: &str, tab: &str, ctx: &RunContext) -> Result<ToolReply, RunError> {
        let cancel = ctx.cancel.token();
        match action {
            Action::ListTabs => {
                let listed = self.host.pages_list(HostBrowserPagesListParams { session_id: session.to_owned() }, cancel).await?;
                locked(&self.directory).observe_list(session, &listed.pages, listed.active_page_id.as_deref());
                Ok(ToolReply::text(list_tabs_text(&listed.pages, listed.active_page_id.as_deref())))
            }
            Action::CloseTab => {
                let listed = self.host.pages_list(HostBrowserPagesListParams { session_id: session.to_owned() }, cancel).await?;
                locked(&self.directory).observe_list(session, &listed.pages, listed.active_page_id.as_deref());
                let Some(found) = listed.pages.iter().find(|page| page.page_id == tab || page.tab_id == tab) else {
                    return Err(RunError::Failed(unknown_background_tab(tab)));
                };
                if !found.background {
                    return Err(RunError::Failed(visible_tab_close_refusal(tab)));
                }
                let params = HostBrowserPagesCloseParams { page_id: found.page_id.clone(), reason: BrowserPageCloseReason::Agent };
                self.host.pages_close(params, cancel).await?;
                self.drop_page(&found.page_id);
                Ok(ToolReply::text(closed_background_tab(&found.tab_id)))
            }
            Action::Hide => {
                let params = HostBrowserPagesSurfaceParams { session_id: session.to_owned(), op: BrowserSurfaceOp::Hide, page_id: None };
                self.host.pages_surface(params, cancel).await?;
                Ok(ToolReply::text("Browser panel hide requested; tabs and page state are preserved."))
            }
            _ => self.downloads_reply(command, session, ctx).await,
        }
    }

    /// `downloads`: the session's recorded downloads, optionally after waiting for the newest (or the named) one to finish.
    async fn downloads_reply(&self, command: &Value, session: &str, ctx: &RunContext) -> Result<ToolReply, RunError> {
        const DEFAULT_WAIT_MS: i64 = 10_000;
        const MIN_WAIT_MS: i64 = 500;
        const MAX_WAIT_MS: i64 = 30_000;
        const POLL: Duration = Duration::from_millis(100);
        let cancel = &ctx.cancel;
        let list = || async {
            let params = HostBrowserDownloadsParams { session_id: session.to_owned(), op: BrowserDownloadsOp::List, since: None, id: None };
            self.host.downloads(params, cancel.token()).await.map(|answer| answer.items)
        };
        let mut selected = command.get("downloadId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned);
        let timeout_ms = command.get("timeoutMs").and_then(Value::as_f64).filter(|ms| ms.is_finite()).map_or(DEFAULT_WAIT_MS, |ms| (ms.trunc() as i64).clamp(MIN_WAIT_MS, MAX_WAIT_MS));
        throw_if_cancelled(cancel)?;
        if truthy(command.get("wait")) {
            let started = Instant::now();
            loop {
                throw_if_cancelled(cancel)?;
                let items = list().await?;
                if selected.is_none() {
                    selected = items.first().map(|item| item.id.clone());
                }
                if let Some(item) = items.iter().find(|item| Some(&item.id) == selected.as_ref()).filter(|item| item.state != "in_progress") {
                    if item.state != "completed" {
                        return Err(RunError::Failed(ended_as(&item.id, &item.state)));
                    }
                    break;
                }
                if started.elapsed() >= Duration::from_millis(timeout_ms as u64) {
                    return Err(RunError::Failed(did_not_complete(selected.as_deref(), timeout_ms as u64)));
                }
                pause(POLL, cancel).await?;
            }
        }
        let recorded = list().await?;
        let mut reply = ToolReply::text(list_text(&recorded));
        if recorded.is_empty() || !truthy(command.get("attach")) {
            return Ok(reply);
        }
        let chosen = match &selected {
            Some(id) => recorded.iter().find(|download| &download.id == id),
            None => recorded.iter().find(|download| download.state == "completed"),
        };
        let Some(chosen) = chosen else { return Err(RunError::Failed(none_to_attach().to_owned())) };
        if chosen.state != "completed" {
            return Err(RunError::Failed(not_complete_to_attach(&chosen.id, &chosen.state)));
        }
        let Some(reader) = self.download_files.get() else {
            return Err(RunError::Failed("downloads cannot attach a file: this core was not given a reader for the downloaded files".to_owned()));
        };
        let (file, note) = attach_download(&*self.ports.files, &**reader, chosen).await.map_err(RunError::Failed)?;
        throw_if_cancelled(cancel)?;
        reply.text.push_str(&note);
        reply.file = Some(file);
        Ok(reply)
    }

}

/// What the agent may tell the user about an `open`: shown, or pending because the conversation is not on screen.
fn placement_line(facts: &PageFacts, placement: Option<BrowserPlacement>) -> Result<String, RunError> {
    let title = if facts.title.is_empty() { "(untitled)" } else { facts.title.as_str() };
    let address = if facts.url.is_empty() { "about:blank" } else { facts.url.as_str() };
    let page = format!("page {} \u{2014} {title} ({address})", facts.page_id);
    match placement {
        Some(BrowserPlacement::Shown) => Ok(format!("Shown in the browser panel: {page}.")),
        Some(BrowserPlacement::Pending) => Ok(format!(
            "Not on screen yet: {page} is kept in this conversation's browser panel, which is not visible now; it appears when the user opens that panel. \
             Do not tell the user it is on screen."
        )),
        None => Err(RunError::Failed("Could not show the page in the browser panel: the host did not place it".to_owned())),
    }
}

/// `message` ending in exactly one full stop (`message.replace(/\.?$/, '.')`).
fn with_final_stop(message: &str) -> String {
    format!("{}.", message.strip_suffix('.').unwrap_or(message))
}

/// What a command says that the host's sign-in hooks read once it ran.
struct SignInHints {
    /// The command filled a saved account: no automatic sign-in follows it (an explicit fill is a path of its own).
    explicit_fill: bool,
    /// The `maxChars` of the fresh observation a sign-in note is put ahead of.
    max_chars: Option<Value>,
}

impl SignInHints {
    fn of(command: &Value) -> Self {
        Self { explicit_fill: command.get("savedAccount").is_some_and(Value::is_string), max_chars: command.get("maxChars").cloned() }
    }
}

// ---- one command on one page ----

/// Runs a future that cannot be pending (a reply built without a screenshot waits for nothing).
fn finish_now<T>(operation: impl Future<Output = T>) -> T {
    let mut operation = pin!(operation);
    match operation.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => unreachable!("a reply without a screenshot never waits"),
    }
}

/// What a command asks of the reply that follows its action.
#[derive(Clone, Default)]
struct ReplyOptions {
    expected: Option<Postcondition>,
    /// The postcondition already held before the action: it proves nothing about it.
    preexisting: bool,
    /// The action is a gesture: the page is settled after it and the change it made is judged.
    settle_action: bool,
    /// The observation the gesture started from.
    baseline: Option<RefSet>,
    /// The observation a brief reply compares against.
    report_baseline: Option<RefSet>,
}

impl RunError {
    fn message(&self) -> String {
        match self {
            Self::Failed(message) | Self::TimedOut(message) => message.clone(),
            Self::Reply(reply) => reply.text.clone(),
            Self::Tool(error) => error.message_for_model.clone(),
            Self::Cancelled(reason) => reason.as_ref().map_or_else(|| "browser command cancelled".to_owned(), |reason| reason.to_string()),
        }
    }

    fn into_observe(self) -> observe::ActionError {
        match self {
            Self::Cancelled(reason) => observe::ActionError::Cancelled(Cancelled { reason }),
            other => observe::ActionError::Failed(other.message()),
        }
    }

    fn into_action(self) -> ActionError {
        match self {
            Self::Cancelled(reason) => ActionError::Cancelled(Cancelled { reason }),
            other => ActionError::Failed(other.message()),
        }
    }

    fn into_ref(self) -> RefError {
        match self {
            Self::Cancelled(_) => RefError::Host(HostCallError::Cancelled),
            other => RefError::Failed(other.message()),
        }
    }
}

fn action_to_ref(error: ActionError) -> RefError {
    match error {
        ActionError::Cancelled(_) => RefError::Host(HostCallError::Cancelled),
        ActionError::Host(error) => RefError::Host(error),
        ActionError::Failed(message) => RefError::Failed(message),
    }
}

fn ref_to_host(error: RefError) -> HostCallError {
    match error {
        RefError::Host(error) => error,
        RefError::Refused { message, .. } | RefError::Failed(message) => HostCallError::Failed { message },
    }
}

/// `boundedInteger` of the command contract: `fallback` for a value that is not a finite number.
fn bounded(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    value.and_then(Value::as_f64).filter(|number| number.is_finite()).map_or(fallback, |number| number.trunc() as i64).clamp(min, max)
}

fn text_of(value: Option<&Value>) -> String {
    crate::actions::target::text_of(value)
}

/// The page a command works on, with everything the actions read of it. Cheap to clone.
#[derive(Clone)]
struct PageCtx {
    inner: Arc<Inner>,
    slot: Arc<PageSlot>,
    page_id: String,
    thread: ThreadId,
    /// The session's turn this command runs in.
    turn: u64,
    cancel: CancelView,
    user_wait: UserWait,
    timer: Arc<CommandTimer>,
    /// A hidden offscreen page: its screenshots are captured as the host captures a page nobody sees.
    background: bool,
}

impl PageProbe for PageCtx {
    fn state(&self) -> PageState {
        let facts = self.page_facts();
        let now = wall_clock_ms();
        self.inner.ports.mirror.with_ledgers(&self.page_id, |ledgers| PageState::from_facts(&facts, &ledgers.network, now)).unwrap_or_else(|| PageState {
            loading: facts.loading,
            url: facts.url.clone(),
            destroyed: !facts.alive,
            dialog: facts.pending_dialog.as_ref().map(|dialog| dialog.kind.clone()),
            ..PageState::default()
        })
    }

    fn stop_loading(&self) {
        let host = self.inner.host.clone();
        let params = HostBrowserPageStopParams { page_id: self.page_id.clone() };
        // A stop that fails or hangs changes nothing the cancelled command is told: its answer is not waited for. The command's own
        // token is already cancelled, so the request rides a token of its own.
        mixdog_rt::spawn("browser-page-stop", mixdog_rt::TaskClass::Work, async move {
            let _ = host.page_stop(params, &CancellationToken::new()).await;
        });
    }
}

impl PageCtx {
    fn host(&self) -> &dyn BrowserHost {
        &*self.inner.host
    }

    fn session(&self) -> &str {
        self.thread.as_str()
    }

    fn token(&self) -> &CancellationToken {
        self.cancel.token()
    }

    fn settle_page(&self) -> Page<'_> {
        Page { host: self.host(), id: &self.page_id, probe: self }
    }

    /// The page's present facts, as the host last said them.
    fn page_facts(&self) -> PageFacts {
        self.inner.store.get(&self.page_id).unwrap_or_else(|| gone_facts(&self.page_id))
    }

    fn state_lock(&self) -> MutexGuard<'_, SlotState> {
        locked(&self.slot.state)
    }

    /// The text as the agent may read it: the patterns of `redact_browser_text`, then what the session filled into pages.
    fn redact(&self, text: &str) -> String {
        self.inner.ports.secrets.redact(self.session(), &redact_browser_text(text))
    }

    /// The latest observation; one of a document that has since been replaced holds no refs.
    fn latest_refs(&self) -> Option<RefSet> {
        let document_id = self.page_facts().document_id;
        let mut state = self.state_lock();
        if let Some(refs) = state.refs.as_mut() {
            refs.invalidate_on(&document_id);
        }
        state.refs.clone()
    }

    /// The state a mutating call is decided against.
    fn page_precondition(&self) -> Precondition {
        let facts = self.page_facts();
        let origin = origin_of_url(&facts.url);
        Precondition {
            document_id: facts.document_id.clone(),
            origin: (!origin.is_empty()).then_some(origin),
            url: Some(facts.url.clone()),
            child_sessions: Some(facts.child_sessions.iter().map(|child| child.session_id.clone()).collect()),
            receiver_key: None,
            snapshot_id: self.latest_refs().map(|refs| refs.snapshot_id),
        }
    }

    fn invalidate(&self) {
        let mut state = self.state_lock();
        state.refs = None;
        state.grounding = None;
    }

    /// Runs `read` on the page's ledgers (a page the mirror never heard of reads empty ones).
    fn with_ledgers<R>(&self, read: impl FnOnce(&mut PageLedgers) -> R) -> R {
        let mut pending = Some(read);
        let mut done: Option<R> = None;
        self.inner.ports.mirror.with_ledgers(&self.page_id, |ledgers| {
            if let Some(read) = pending.take() {
                done = Some(read(ledgers));
            }
        });
        match (done, pending) {
            (Some(value), _) => value,
            (None, Some(read)) => read(&mut PageLedgers::new(Arc::new(|text: &str| redact_browser_text(text)))),
            (None, None) => unreachable!("a read runs on the ledgers or on empty ones"),
        }
    }

    fn call(&self) -> page::PageCall<'_> {
        page::PageCall { host: self.host(), page_id: &self.page_id, cancel: self.token() }
    }

    fn observe_call<'a>(&'a self, expect: Option<&'a Precondition>) -> observe::PageCall<'a> {
        observe::PageCall { host: self.host(), page_id: &self.page_id, expect, cancel: &self.cancel }
    }

    /// One sign-in question to the host about this page. The hooks add to a command that already ran, so a host that cannot answer
    /// them (a failure of its own) says nothing; a command the caller cancelled, or a person who took the page, still ends it.
    async fn sign_in(&self, op: BrowserSignInOp, action: Option<&str>, command: Option<Value>, explicit_fill: Option<bool>) -> Result<Option<HostBrowserSignInResult>, RunError> {
        let params = HostBrowserSignInParams {
            session_id: self.session().to_owned(),
            page_id: self.page_id.clone(),
            op,
            turn: i64::try_from(self.turn).ok(),
            action: action.map(str::to_owned),
            command,
            explicit_fill,
        };
        match self.host().sign_in(params, self.token()).await {
            Ok(said) => Ok(Some(said)),
            Err(error @ (HostCallError::Cancelled | HostCallError::UserInput { .. })) => Err(error.into()),
            Err(_) => Ok(None),
        }
    }

    /// Before a click, fill or type is sent (`linkedSignIn.beforeAction`): the host notes which field of a provider's sign-in the agent is
    /// about to name, from the command's own `ref`, `target`, `text` and `fields`.
    async fn before_action(&self, action: Action, command: &Value) -> Result<(), RunError> {
        if !matches!(action, Action::Click | Action::Fill | Action::Type) {
            return Ok(());
        }
        let named: Map<String, Value> = ["ref", "target", "text", "fields"].into_iter().filter_map(|key| command.get(key).map(|value| (key.to_owned(), value.clone()))).collect();
        self.sign_in(BrowserSignInOp::BeforeAction, Some(action.name()), Some(Value::Object(named)), None).await?;
        Ok(())
    }

    /// After the action: a page that asks for a sign-in a saved login fits is signed in by the host once per site and turn, and its
    /// note leads a fresh observation that replaces the reply (`autoSignIn.afterCommand`); the identity a provider flow last used
    /// is a line ahead of the reply (`linkedSignIn.replyLine`). An `open` answers with its placement, the note and the line.
    async fn after_command(&self, action: Action, background: bool, placement: Option<BrowserPlacement>, hints: &SignInHints, mut reply: ToolReply) -> Result<ToolReply, RunError> {
        let said = self.sign_in(BrowserSignInOp::AfterCommand, None, None, Some(hints.explicit_fill)).await?;
        let note = said.as_ref().and_then(|said| said.note.clone()).filter(|note| !note.is_empty());
        let line = said.as_ref().and_then(|said| said.line.clone()).filter(|line| !line.is_empty());
        if action == Action::Open && !background {
            // An open always answers with its placement: exactly one of shown or pending (a failure to place is thrown).
            let placed = placement_line(&self.page_facts(), placement)?;
            reply.text = self.redact(&[Some(placed), note, line].into_iter().flatten().collect::<Vec<_>>().join("\n\n"));
            return Ok(reply);
        }
        if let Some(note) = &note {
            let mut observe = json!({"action": "snapshot"});
            if let Some(max_chars) = &hints.max_chars {
                observe["maxChars"] = max_chars.clone();
            }
            self.invalidate();
            let after = match self.snapshot_reply(&observe, &ReplyOptions::default()).await {
                Ok(after) | Err(RunError::Reply(after)) => after,
                Err(error) => return Err(error),
            };
            reply = ToolReply { text: format!("{note}\n\n{}", after.text), ..after };
        }
        if let Some(line) = &line {
            reply.text = format!("{line}\n\n{}", reply.text);
        }
        if note.is_some() || line.is_some() {
            reply.text = self.redact(&reply.text);
        }
        Ok(reply)
    }

    /// The session's download ledger as the host keeps it; a reply is still given when it cannot be read.
    async fn session_downloads(&self) -> Vec<DownloadItem> {
        let params = HostBrowserDownloadsParams { session_id: self.session().to_owned(), op: BrowserDownloadsOp::List, since: None, id: None };
        self.host().downloads(params, self.token()).await.map(|answer| answer.items).unwrap_or_default()
    }

    fn snapshot_params(&self, command: &Value) -> HostBrowserSnapshotParams {
        let query = command.get("query").and_then(Value::as_str).map(|query| mixdog_js::js_trim(query).to_owned()).filter(|query| !query.is_empty());
        let mode = if command.get("viewportOnly") == Some(&Value::Bool(true)) {
            BrowserSnapshotMode::Viewport
        } else if query.is_some() {
            BrowserSnapshotMode::Query
        } else {
            BrowserSnapshotMode::Full
        };
        let max_elements = command.get("maxElements").filter(|value| truthy(Some(value))).and_then(Value::as_f64).filter(|number| number.is_finite());
        let max_elements = max_elements.map_or(SNAPSHOT_MAX_ELEMENTS as i64, |number| number.trunc() as i64).clamp(1, SNAPSHOT_TOOL_MAX_ELEMENTS as i64);
        // An evaluate's reply keeps page text short: the script result already occupies it.
        let text_chars = if command.get("action").and_then(Value::as_str) == Some("evaluate") {
            SNAPSHOT_TEXT_CHARS as i64
        } else {
            bounded(command.get("maxChars"), SNAPSHOT_TEXT_CHARS as i64, 1, READ_MAX_CHARS as i64)
        };
        HostBrowserSnapshotParams {
            page_id: self.page_id.clone(),
            mode,
            query,
            max_elements: u32::try_from(max_elements).ok(),
            text_chars: u32::try_from(text_chars).ok(),
            frame: None,
        }
    }

    /// The snapshot as a reply shows it, for a covered element's refusal and a recovery's report.
    fn format_snapshot_text(&self, snapshot: &HostBrowserSnapshotResult) -> String {
        let facts = self.page_facts();
        self.with_ledgers(|ledgers| {
            let mut diagnostics = SnapshotDiagnostics {
                pending_dialog: facts.pending_dialog.as_ref(),
                dismissed_dialog: None,
                pending_file_chooser: facts.pending_file_chooser.as_ref(),
                ledgers,
            };
            self.redact(&format_snapshot(&snapshot.payload, &mut diagnostics, &SnapshotExtras { downloads: &[], brief_against: None }))
        })
    }

    /// What this page's reply has not said yet, without a snapshot (`reportPage`); empty when nothing is new.
    fn page_report(&self, downloads: &[DownloadItem]) -> String {
        let facts = self.page_facts();
        let redact = |text: &str| self.redact(text);
        let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
        let mut state = self.state_lock();
        let SlotState { reply, reports, .. } = &mut *state;
        let mut page = ReplyPage { facts: &facts, state: reply, downloads, download_reports: reports, now_ms: wall_clock_ms() };
        self.with_ledgers(|ledgers| page_report_text(&ctx, &mut page, ledgers))
    }

    /// The handles one command acts on its page's elements with.
    fn ref_actions(&self) -> RefActions {
        let host: Arc<dyn BrowserHost> = self.inner.host.clone();
        let redacting = self.clone();
        let formatting = self.clone();
        let secrets = self.inner.ports.secrets.clone();
        let session = self.session().to_owned();
        RefActions {
            host,
            page_id: self.page_id.clone(),
            expect: self.page_precondition(),
            cancel: self.cancel.clone(),
            redact: Arc::new(move |text: &str| redacting.redact(text)),
            remember_secret: Arc::new(move |secret: &str| secrets.remember(&session, secret)),
            format_snapshot: Arc::new(move |snapshot: &HostBrowserSnapshotResult| formatting.format_snapshot_text(snapshot)),
            dropdown_timeout: CUSTOM_DROPDOWN_TIMEOUT,
            dropdown_poll: CUSTOM_DROPDOWN_POLL,
            timer: Some(self.timer.clone()),
        }
    }

    /// Every target resolved against ONE fresh observation, waiting out a target that matched nothing yet (`resolveTargetRefs`).
    async fn resolve_targets(&self, raw: &[Value]) -> Result<Vec<ResolvedTarget>, ActionError> {
        let expect = self.page_precondition();
        let (host, cancel, page_id) = (self.host(), &self.cancel, self.page_id.as_str());
        let expect_ref = &expect;
        let resolved = self
            .timer
            .phase(
                Phase::Target,
                wait_for_actionable(
                    move || async move {
                        let target = TargetContext { host, page_id, expect: Some(expect_ref), cancel: cancel.token() };
                        resolve_targets(&target, raw).await.map_err(|error| match error {
                            TargetError::Missing(message) => ProbeFailure::NotActionable(ActionabilityError::new(message, ActionabilityReason::Missing)),
                            other => ProbeFailure::Other(other),
                        })
                    },
                    cancel,
                    ACTIONABILITY_TIMEOUT,
                ),
            )
            .await?;
        self.register_minted(&resolved);
        Ok(resolved)
    }

    /// The selector matches this resolution minted refs for join the page's ref set (the one the page reports against, and the
    /// snapshot's own in the store).
    fn register_minted(&self, resolved: &[ResolvedTarget]) {
        for (snapshot_id, minted) in resolved.iter().fold(Vec::<(&str, Vec<BrowserSnapshotElement>)>::new(), |mut grouped, target| {
            if let Some(element) = &target.minted {
                match grouped.iter_mut().find(|(id, _)| *id == target.snapshot_id) {
                    Some((_, elements)) => elements.push(element.clone()),
                    None => grouped.push((target.snapshot_id.as_str(), vec![element.clone()])),
                }
            }
            grouped
        }) {
            self.inner.store.register_minted(&self.page_id, snapshot_id, &minted);
            let Some(joined) = self.inner.store.snapshot(&self.page_id, snapshot_id) else { continue };
            let mut state = self.state_lock();
            if let Some(held) = state.refs.as_mut().filter(|held| held.snapshot_id == snapshot_id && held.len() != joined.refs.len()) {
                *held = joined.refs.clone().with_observation(held.observation.as_deref());
            }
        }
    }

    // ---- the reply ----

    /// The reply of a command that observed the page (`snapshotResult`): the page settled, its postcondition verified, a snapshot
    /// taken and put into words, and the screenshot the command asked for bound to it.
    async fn snapshot_reply(&self, command: &Value, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        let action = text_of(command.get("action"));
        let blocked = |facts: &PageFacts| facts.pending_dialog.as_ref().map(|dialog| blocking_dialog_reply(dialog, true, &|text: &str| self.redact(text)));
        if let Some(reply) = blocked(&self.page_facts()) {
            return Ok(reply);
        }
        let wait_options = ReplyWaitOptions {
            settle_action: options.settle_action,
            preexisting_postcondition: options.preexisting,
            baseline_url: options.baseline.as_ref().map(|refs| refs.url.clone()),
            expected: Some(options.expected.clone()),
        };
        let wait = self
            .timer
            .phase(Phase::Wait, await_reply_ready(&self.settle_page(), &SettlePolicy::default(), command.get("settleMs"), command.get("expect"), &wait_options, &self.cancel))
            .await?;
        let facts = self.page_facts();
        if let Some(reply) = blocked(&facts) {
            return Ok(reply);
        }
        if let Some(fault) = facts.fault.as_deref().filter(|fault| !fault.is_empty()) {
            return Err(RunError::Failed(format!("{fault}; navigate to reload this page or choose another tab")));
        }
        let params = self.snapshot_params(command);
        let result = self.timer.phase(Phase::Snapshot, self.host().snapshot(params, self.token())).await?;
        let refs = RefSet::from_payload(&result.snapshot_id, &result.payload).with_document(&result.document_id, result.revision).with_observation(result.observation.as_deref());
        {
            let mut state = self.state_lock();
            state.refs = Some(refs.clone());
            state.grounding = None;
            state.scroll_y = Some(result.payload.scroll_y);
        }
        let facts = self.page_facts();
        let downloads = self.session_downloads().await;
        let brief = command.get("brief") == Some(&Value::Bool(true));
        let brief_against = options.report_baseline.clone().or_else(|| options.baseline.clone());
        let request = ReplyRequest {
            action: &action,
            brief,
            brief_against: brief_against.as_ref(),
            effect: ReplyEffect {
                settle_ms: u64::try_from(wait.settle.as_millis()).ok(),
                expected: wait.expected.as_ref().map(|expected| describe(expected.expected())),
                postcondition_matched: wait.postcondition_matched,
                postcondition_elapsed_ms: u64::try_from(wait.postcondition_elapsed.as_millis()).unwrap_or(u64::MAX),
                preexisting_postcondition: options.preexisting,
                settle_action: options.settle_action,
                baseline: options.baseline.as_ref().map(|set| EffectBaseline::of(set)),
            },
        };
        let redact = |text: &str| self.redact(text);
        let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
        let capture = SnapshotCapture { payload: &result.payload, observation: result.observation.as_deref() };
        let mut reply = {
            let mut state = self.state_lock();
            let SlotState { reply, reports, .. } = &mut *state;
            let mut page = ReplyPage { facts: &facts, state: reply, downloads: &downloads, download_reports: reports, now_ms: wall_clock_ms() };
            self.with_ledgers(|ledgers| finish_now(build_reply(&ctx, &request, &mut page, ledgers, Some(capture), None)))?
        };
        if command.get("includeScreenshot") == Some(&Value::Bool(true)) {
            self.attach_shot(command, &mut reply).await?;
        }
        Ok(reply)
    }

    /// The screenshot of the command, bound to the snapshot just taken; coordinate actions are then expressed in it.
    async fn attach_shot(&self, command: &Value, reply: &mut ToolReply) -> Result<(), RunError> {
        let params = observe::screenshot_params(&self.page_id, command, self.background)?;
        let full_page = params.full_page == Some(true);
        let bound = self.latest_refs();
        let answer = self.timer.phase(Phase::Screenshot, self.host().screenshot(params, self.token())).await?;
        let capture = read_capture(&answer, full_page, &*self.inner.ports.blobs).await?;
        let latest = self.latest_refs();
        let input = ScreenshotInput {
            capture: &capture,
            bound: bound.as_ref(),
            latest: latest.as_ref(),
            output: ImageOutput::from_command(command.get("image_output").and_then(Value::as_str)),
            frame_dir: &self.inner.ports.frame_dir,
            now: std::time::Instant::now(),
        };
        attach_screenshot(&*self.inner.ports.files, reply, input).await?;
        self.state_lock().grounding = reply.grounding.clone();
        Ok(())
    }

    /// What follows a gesture: the settled snapshot reply, or, for a step of a sequence, only whether the page settled.
    async fn settled(&self, command: &Value, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        if command.get("internalStep") != Some(&Value::Bool(true)) {
            return self.snapshot_reply(command, options).await;
        }
        let step = step_settle_result(&self.settle_page(), &SettlePolicy::default(), &self.cancel).await?;
        let outcome = match step.outcome {
            StepKind::Completed => ReplyOutcome::Completed,
            StepKind::Inconclusive => ReplyOutcome::Inconclusive,
            StepKind::Blocked => ReplyOutcome::Blocked,
        };
        Ok(ToolReply { text: step.text, outcome: Some(outcome), ..ToolReply::default() })
    }

    /// The reply of an action that is not an observation: its own lead, the recovery notes when it asked for them, the settled page.
    async fn gesture_reply(&self, output: ActionOutput, command: &Value, recovery: &RefRecoveryContext, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        self.timer.merge_input(&output.input);
        let mut reply = self.settled(command, options).await?;
        let text = if output.decorate_recovery { decorate_recovery(&reply.text, recovery) } else { reply.text.clone() };
        reply.text = format!("{}{text}", output.lead);
        Ok(reply)
    }

    // ---- the actions ----

    /// One action on the page, after the command was admitted: the dialog check, the approval, the action itself and its reply. A
    /// step of a sequence comes back through here (`internalStep`), without the approval.
    /// What a page held by a dialog answers to an action that needs the page: a blocked page accepts no gesture (the input would
    /// queue behind the dialog and replay after handle_dialog, which nobody asked for).
    fn dialog_block(&self, action: Action) -> Option<ToolReply> {
        if DIALOG_TOLERANT_ACTIONS.contains(&action.name()) {
            return None;
        }
        self.page_facts().pending_dialog.map(|dialog| blocking_dialog_reply(&dialog, false, &|text: &str| self.redact(text)))
    }

    /// One step of a sequence: the dialog's answer when the page is blocked, else the action.
    async fn dispatch(&self, action: Action, command: Value, expected: Option<Postcondition>, has_screenshot_options: bool) -> Result<ToolReply, RunError> {
        match self.dialog_block(action) {
            Some(blocked) => Ok(blocked),
            None => self.act(action, command, expected, has_screenshot_options).await,
        }
    }

    /// The action itself, on a page no dialog blocks for it.
    async fn act(&self, action: Action, mut command: Value, expected: Option<Postcondition>, has_screenshot_options: bool) -> Result<ToolReply, RunError> {
        let internal = command.get("internalStep") == Some(&Value::Bool(true));
        let facts = self.page_facts();
        let mut recovery = RefRecoveryContext::new(self.latest_refs());
        let report_baseline = self.latest_refs();
        // The latest observation of this page is what the gesture starts from; a target resolution moves it to a fresher one.
        let mut baseline = self.latest_refs();
        let preexisting = match &expected {
            Some(condition) if action != Action::Navigate && facts.pending_dialog.is_none() => postcondition_matches_page(&self.settle_page(), condition, &self.cancel).await?,
            _ => false,
        };
        if action == Action::Upload && !internal && !truthy(command.get("ref")) {
            // An upload resolves its real target before the person is asked: a `target` becomes the ref the handler then uses.
            if let Some(target) = command.get("target").filter(|target| !target.is_null()).cloned() {
                let resolved = self.resolve_targets(std::slice::from_ref(&target)).await?;
                let mut cx = ActionContext { host: self.host(), page: self, command: &command, cancel: &self.cancel, recovery: &mut recovery, effect_baseline: &mut baseline };
                adopt_resolved_targets(&mut cx, &resolved);
                if let Some(first) = resolved.first() {
                    command["ref"] = Value::String(first.ref_id.clone());
                }
            }
        }
        let approved = if internal { None } else { self.inner.approve(&self.thread, &mut command, Some(self), &self.cancel, &self.user_wait).await? };
        self.before_action(action, &command).await?;
        let options = |settle_action: bool, baseline: &Option<RefSet>| ReplyOptions {
            expected: expected.clone(),
            preexisting,
            settle_action,
            baseline: baseline.clone(),
            report_baseline: report_baseline.clone(),
        };
        match action {
            Action::Open => Ok(navigation::open(self.background)),
            Action::Snapshot => self.snapshot_action(&command).await,
            Action::Locate => self.locate_action(&command).await,
            Action::Read => {
                let precondition = self.page_precondition();
                let redact = |text: &str| self.redact(text);
                Ok(observe::read(&self.observe_call(Some(&precondition)), &command, &redact).await?)
            }
            Action::Extract => {
                let precondition = self.page_precondition();
                Ok(observe::extract(&self.observe_call(Some(&precondition)), &command).await?)
            }
            Action::Status => Ok(self.with_ledgers(|ledgers| diagnostics::status(&facts, ledgers))),
            Action::Console => Ok(self.with_ledgers(|ledgers| diagnostics::console(ledgers, &command))?),
            Action::Network => self.network_action(&command).await,
            Action::Wait => {
                let report = WaitSnapshot { page: self, command: &command };
                Ok(self.timer.phase(Phase::Wait, flow::wait(&self.settle_page(), &self.cancel, &command, &report)).await?)
            }
            Action::Navigate | Action::Back => self.navigate_action(action, &command, &options(true, &baseline)).await,
            Action::Evaluate => self.evaluate_action(&command, expected.is_some(), has_screenshot_options, &options(true, &baseline)).await,
            Action::Emulate => {
                let input = command.as_object().cloned().unwrap_or_default();
                let applied = crate::actions::emulation::emulate(&self.call(), &input).await?;
                self.invalidate();
                let snapshot = self.settled(&command, &options(true, &baseline)).await?;
                Ok(emulation::configured_reply(&applied, snapshot))
            }
            Action::Cookies => {
                let input = command.as_object().cloned().unwrap_or_default();
                Ok(page::cookies(&self.call(), &facts.url, &input).await?)
            }
            Action::Storage => {
                let input = command.as_object().cloned().unwrap_or_default();
                let redact = |text: &str| self.redact(text);
                let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
                let outcome = page::storage(&self.call(), &ctx, &input).await?;
                if outcome.invalidates_refs {
                    self.invalidate();
                }
                Ok(outcome.reply)
            }
            Action::Intercept => Ok(page::intercept(&self.call(), &command.as_object().cloned().unwrap_or_default()).await?),
            Action::InitScript => Ok(page::init_script(&self.call(), &command.as_object().cloned().unwrap_or_default()).await?),
            Action::Performance => {
                let input = command.as_object().cloned().unwrap_or_default();
                Ok(page::performance(&self.call(), &*self.inner.ports.files, &input, || self.reload_and_settle()).await?)
            }
            Action::Click | Action::Hover | Action::Drag | Action::Press | Action::Scroll | Action::Sequence => {
                let output = {
                    let mut cx = ActionContext { host: self.host(), page: self, command: &command, cancel: &self.cancel, recovery: &mut recovery, effect_baseline: &mut baseline };
                    match action {
                        Action::Click => pointer::click(&mut cx).await,
                        Action::Hover => pointer::hover(&mut cx).await,
                        Action::Drag => pointer::drag(&mut cx).await,
                        Action::Press => pointer::press(&mut cx).await,
                        Action::Scroll => pointer::scroll(&mut cx).await,
                        _ => sequence(&mut cx, &SequenceSteps { page: self }).await,
                    }
                }?;
                self.gesture_reply(output, &command, &recovery, &options(true, &baseline)).await
            }
            Action::Fill | Action::Type | Action::Select | Action::HandleDialog => {
                let mut form = FormCtx { page: self, command: &command, recovery: &mut recovery, baseline: &mut baseline, expected: &expected, preexisting, report_baseline: &report_baseline };
                let reply = match action {
                    Action::Fill => forms::fill(&mut form).await,
                    Action::Type => forms::type_text(&mut form).await,
                    Action::Select => forms::select(&mut form).await,
                    _ => forms::handle_dialog(&mut form).await,
                };
                Ok(reply?)
            }
            Action::Upload => {
                let paths: Vec<String> = command.get("paths").and_then(Value::as_array).map(|paths| paths.iter().map(|path| text_of(Some(path))).collect()).unwrap_or_default();
                let ref_id = truthy(command.get("ref")).then(|| text_of(command.get("ref")));
                let snapshot_id = ref_id.as_deref().map(|id| snapshot_of_ref(id).to_owned()).or_else(|| self.latest_refs().map(|refs| refs.snapshot_id)).unwrap_or_default();
                let target = UploadTarget { page_id: &self.page_id, snapshot_id: &snapshot_id, ref_id: ref_id.as_deref() };
                let outcome = upload::upload_files(self.host(), &*self.inner.ports.files, &target, &paths, &facts, approved.as_ref(), self.token()).await?;
                self.invalidate();
                let output = ActionOutput { lead: format!("{}\n\n", outcome.summary()), decorate_recovery: true, input: Vec::new() };
                self.gesture_reply(output, &command, &recovery, &options(true, &baseline)).await
            }
            Action::ListTabs | Action::CloseTab | Action::Downloads | Action::Hide => Err(RunError::Failed(format!("{} addresses the session, not a page", action.name()))),
        }
    }

    async fn snapshot_action(&self, command: &Value) -> Result<ToolReply, RunError> {
        let plan = observe::plan_snapshot(command)?;
        let precondition = self.page_precondition();
        let call = self.observe_call(Some(&precondition));
        let ports = ShotPorts { blobs: &*self.inner.ports.blobs, files: &*self.inner.ports.files, frame_dir: &self.inner.ports.frame_dir };
        match plan {
            SnapshotPlan::Semantic => self.snapshot_reply(command, &ReplyOptions::default()).await,
            SnapshotPlan::Both => {
                let mut with_screenshot = command.clone();
                with_screenshot["includeScreenshot"] = Value::Bool(true);
                self.snapshot_reply(&with_screenshot, &ReplyOptions::default()).await
            }
            SnapshotPlan::Visual => Ok(observe::visual_screenshot(&call, &ports, command, self.background).await?),
            SnapshotPlan::Pdf => Ok(observe::print_pdf(&call, &ports).await?),
            SnapshotPlan::Element => {
                let (snapshot_id, ref_id) = if truthy(command.get("ref")) {
                    let ref_id = text_of(command.get("ref"));
                    (snapshot_of_ref(&ref_id).to_owned(), ref_id)
                } else if let Some(target) = command.get("target").filter(|target| !target.is_null()) {
                    let resolved = self.resolve_targets(std::slice::from_ref(target)).await?;
                    let Some(first) = resolved.into_iter().next() else { return Err(RunError::Failed("the target resolved to nothing".to_owned())) };
                    (first.snapshot_id, first.ref_id)
                } else {
                    return Err(RunError::Failed("snapshot mode=element requires ref or target".to_owned()));
                };
                Ok(observe::element_screenshot(&call, &ports, command, &snapshot_id, &ref_id, self.background).await?)
            }
        }
    }

    /// `locate`: a semantic snapshot (the command's query cleared) and, on top of it, the visual candidates for the query.
    async fn locate_action(&self, command: &Value) -> Result<ToolReply, RunError> {
        let mut observing = command.clone();
        if let Some(fields) = observing.as_object_mut() {
            fields.remove("query");
        }
        let snapshot = self.snapshot_reply(&observing, &ReplyOptions::default()).await?;
        if self.page_facts().pending_dialog.is_some() {
            return Ok(snapshot);
        }
        let Some(refs) = self.latest_refs() else { return Err(RunError::Failed("locate could not observe the page; take a fresh snapshot".to_owned())) };
        let precondition = self.page_precondition();
        let input = LocateInput {
            page: self.observe_call(Some(&precondition)),
            blobs: &*self.inner.ports.blobs,
            command,
            snapshot,
            ref_set: &refs,
            background: self.background,
            now: std::time::Instant::now(),
        };
        let reply = observe::locate(input).await?;
        self.state_lock().grounding = reply.grounding.clone();
        Ok(reply)
    }

    /// `network`: the recorded requests, or one request's detail. The detail reads bodies from the page, so the request is copied
    /// out of the ledger first (the mirror lends its ledgers only synchronously).
    async fn network_action(&self, command: &Value) -> Result<ToolReply, RunError> {
        let precondition = self.page_precondition();
        let call = self.observe_call(Some(&precondition));
        let now = wall_clock_ms();
        let request_id = diagnostics::network_request_id(command);
        if request_id.is_empty() {
            return Ok(self.with_ledgers(|ledgers| diagnostics::network_list(ledgers, command, now)));
        }
        let request = self.with_ledgers(|ledgers| diagnostics::network_request(ledgers, &request_id))?;
        Ok(diagnostics::network_detail(&call, &request, command, now).await?)
    }

    async fn navigate_action(&self, action: Action, command: &Value, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        let precondition = self.page_precondition();
        self.invalidate();
        let call = NavigateCall { host: self.host(), page_id: &self.page_id, expect: &precondition, cancel: &self.cancel };
        let outcome = if action == Action::Back { navigation::back(&call).await? } else { navigation::navigate(&call, command, &self.inner.ports.urls, wall_clock_ms()).await? };
        match outcome {
            NavigateOutcome::Refused(text) if action == Action::Back => Ok(ToolReply::text(text)),
            NavigateOutcome::Refused(text) => Err(RunError::Failed(text)),
            NavigateOutcome::Moved(facts) => match &facts.pending_dialog {
                Some(dialog) => Ok(blocking_dialog_reply(dialog, true, &|text: &str| self.redact(text))),
                None => self.settled(command, options).await,
            },
        }
    }

    /// A reload and the settle after it (what a performance trace over a reload waits for).
    async fn reload_and_settle(&self) -> Result<(), page::PageActionError> {
        let precondition = self.page_precondition();
        let call = NavigateCall { host: self.host(), page_id: &self.page_id, expect: &precondition, cancel: &self.cancel };
        let reload = json!({"action": "navigate", "reload": true});
        navigation::navigate(&call, &reload, &self.inner.ports.urls, wall_clock_ms()).await.map_err(|error| match error {
            observe::ActionError::Host(error) => page::PageActionError::Host(error),
            observe::ActionError::Cancelled(_) => page::PageActionError::Host(HostCallError::Cancelled),
            observe::ActionError::Failed(message) => page::PageActionError::invalid(message),
        })?;
        let after = AfterAction { require_quiet: false, previous_url: None };
        settle_after_action(&self.settle_page(), &SettlePolicy::default(), &self.cancel, None, &after).await.map_err(|error| match error {
            SettleError::Cancelled(_) => page::PageActionError::Host(HostCallError::Cancelled),
            SettleError::Failed(message) => page::PageActionError::invalid(message),
        })
    }

    async fn evaluate_action(&self, command: &Value, has_postcondition: bool, has_screenshot_options: bool, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        let input = command.as_object().cloned().unwrap_or_default();
        let refs = self.latest_refs();
        let request = page::EvaluateRequest { input: &input, refs: refs.as_ref(), precondition: Some(self.page_precondition()), has_postcondition, has_screenshot_options };
        let redact = |text: &str| self.redact(text);
        let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
        match page::evaluate(&self.call(), &ctx, &request).await {
            Ok(done) if done.kept_snapshot().is_some() => {
                let downloads = self.session_downloads().await;
                Ok(done.unchanged_reply(&self.page_report(&downloads)))
            }
            Ok(done) => {
                self.invalidate();
                let snapshot = self.settled(command, options).await?;
                Ok(done.changed_reply(snapshot))
            }
            Err(error) => {
                if error.refs_stale {
                    self.invalidate();
                }
                Err(error.error.into())
            }
        }
    }

    /// The frame document that would receive an upload's files now, for the approval to bind.
    async fn upload_receiver(&self, command: &Value) -> Result<upload::Receiver, UploadError> {
        let ref_id = truthy(command.get("ref")).then(|| text_of(command.get("ref")));
        let snapshot_id = ref_id.as_deref().map(|id| snapshot_of_ref(id).to_owned()).or_else(|| self.latest_refs().map(|refs| refs.snapshot_id)).unwrap_or_default();
        let target = UploadTarget { page_id: &self.page_id, snapshot_id: &snapshot_id, ref_id: ref_id.as_deref() };
        upload::receiver(self.host(), &target, &self.page_facts(), self.token()).await
    }
}

// ---- what the actions ask of the page ----

#[async_trait]
impl RecoveryHost for PageCtx {
    async fn page_url(&self) -> Result<String, HostCallError> {
        Ok(self.page_facts().url)
    }

    fn dialog_text(&self) -> Option<String> {
        self.page_facts().pending_dialog.map(|dialog| blocking_dialog_reply(&dialog, false, &|text: &str| self.redact(text)).text)
    }

    async fn fresh_snapshot(&self) -> Result<FreshSnapshot, HostCallError> {
        let params = self.snapshot_params(&json!({"action": "snapshot"}));
        let result = self.timer.phase(Phase::Snapshot, self.host().snapshot(params, self.token())).await?;
        let refs = RefSet::from_payload(&result.snapshot_id, &result.payload).with_document(&result.document_id, result.revision);
        {
            let mut state = self.state_lock();
            state.refs = Some(refs.clone());
            state.grounding = None;
            state.scroll_y = Some(result.payload.scroll_y);
        }
        Ok(FreshSnapshot { refs, report: self.format_snapshot_text(&result) })
    }
}

#[async_trait]
impl ActionPage for PageCtx {
    fn recovery_host(&self) -> &dyn RecoveryHost {
        self
    }

    fn facts(&self) -> PageFacts {
        self.page_facts()
    }

    fn precondition(&self) -> Precondition {
        self.page_precondition()
    }

    fn ref_set(&self) -> Option<RefSet> {
        self.latest_refs()
    }

    fn restore_ref_set(&self, set: RefSet) {
        self.state_lock().refs = Some(set);
    }

    fn adopt_snapshot(&self, snapshot_id: &str) -> Option<RefSet> {
        let observation = self.inner.store.snapshot(&self.page_id, snapshot_id)?;
        let mut state = self.state_lock();
        state.refs = Some(observation.refs.clone());
        state.grounding = None;
        state.scroll_y = Some(observation.scroll_y);
        Some(observation.refs.clone())
    }

    fn invalidate_interaction(&self) {
        self.invalidate();
    }

    /// The change judgement compares the observation's own scroll position, so a scroll needs nothing recorded.
    fn record_scroll(&self) {}

    fn visual_grounding(&self) -> Option<VisualGrounding> {
        self.state_lock().grounding.clone()
    }

    fn drop_visual_grounding(&self) {
        self.state_lock().grounding = None;
    }

    /// The page's observation revision now, read through the host without a snapshot (one would retire the refs the agent holds). A host
    /// that cannot answer leaves the grounding judged by its age and its page alone.
    async fn document_revision(&self, cancel: &CancellationToken) -> Option<u32> {
        let params = HostBrowserRevisionParams { page_id: self.page_id.clone() };
        self.host().revision(params, cancel).await.ok().map(|answer| answer.revision)
    }

    fn format_snapshot(&self, snapshot: &HostBrowserSnapshotResult) -> String {
        self.format_snapshot_text(snapshot)
    }

    fn timer(&self) -> Option<&CommandTimer> {
        Some(&*self.timer)
    }
}

/// `wait` ends with the page as the runner's snapshot reply puts it.
struct WaitSnapshot<'a> {
    page: &'a PageCtx,
    command: &'a Value,
}

#[async_trait]
impl WaitReport for WaitSnapshot<'_> {
    async fn snapshot(&self) -> Result<ToolReply, observe::ActionError> {
        self.page.snapshot_reply(self.command, &ReplyOptions::default()).await.map_err(RunError::into_observe)
    }
}

/// The steps of a `sequence`: each one is a command of its own on the same page, timed as step `index`.
struct SequenceSteps<'a> {
    page: &'a PageCtx,
}

#[async_trait]
impl StepRunner for SequenceSteps<'_> {
    async fn run_step(&self, index: u32, step: Value, _cancel: &CancelView) -> Result<crate::settle::settle::StepResult, ActionError> {
        let Some(action) = Action::parse(&text_of(step.get("action"))) else {
            return Err(ActionError::Failed("a step names no action of the contract".to_owned()));
        };
        let expected = crate::settle::postcondition::normalize(step.get("expect")).map_err(|error| ActionError::Failed(error.to_string()))?;
        let reply = match self.page.timer.step(index, self.page.dispatch(action, step, expected, false)).await {
            Ok(reply) | Err(RunError::Reply(reply)) => reply,
            Err(error) => return Err(error.into_action()),
        };
        let outcome = match reply.outcome {
            Some(ReplyOutcome::Blocked) => StepKind::Blocked,
            Some(ReplyOutcome::Inconclusive) => StepKind::Inconclusive,
            _ => StepKind::Completed,
        };
        Ok(crate::settle::settle::StepResult { outcome, text: reply.text })
    }

    async fn observe(&self, _cancel: &CancelView) -> Result<String, ActionError> {
        match self.page.snapshot_reply(&json!({"action": "snapshot"}), &ReplyOptions::default()).await {
            Ok(reply) | Err(RunError::Reply(reply)) => Ok(reply.text),
            Err(error) => Err(error.into_action()),
        }
    }
}

/// What the form handlers drive the page through.
struct FormCtx<'a> {
    page: &'a PageCtx,
    command: &'a Value,
    recovery: &'a mut RefRecoveryContext,
    baseline: &'a mut Option<RefSet>,
    expected: &'a Option<Postcondition>,
    preexisting: bool,
    report_baseline: &'a Option<RefSet>,
}

impl FormCtx<'_> {
    fn action_context(&mut self) -> ActionContext<'_> {
        ActionContext {
            host: self.page.host(),
            page: self.page,
            command: self.command,
            cancel: &self.page.cancel,
            recovery: &mut *self.recovery,
            effect_baseline: &mut *self.baseline,
        }
    }

    fn options(&self) -> ReplyOptions {
        ReplyOptions {
            expected: self.expected.clone(),
            preexisting: self.preexisting,
            settle_action: true,
            baseline: self.baseline.clone(),
            report_baseline: self.report_baseline.clone(),
        }
    }
}

#[async_trait]
impl FormContext for FormCtx<'_> {
    fn command(&self) -> &Value {
        self.command
    }

    fn cancel(&self) -> &CancelView {
        &self.page.cancel
    }

    fn ref_actions(&self) -> RefActions {
        self.page.ref_actions()
    }

    async fn action_ref(&mut self) -> Result<Option<String>, RefError> {
        let mut cx = self.action_context();
        crate::actions::target::action_ref(&mut cx).await.map_err(action_to_ref)
    }

    async fn resolve_target_refs(&mut self, targets: &[Value]) -> Result<Vec<String>, RefError> {
        let resolved = self.page.resolve_targets(targets).await.map_err(action_to_ref)?;
        let mut cx = self.action_context();
        adopt_resolved_targets(&mut cx, &resolved);
        Ok(resolved.into_iter().map(|target| target.ref_id).collect())
    }

    async fn mutate_ref(&mut self, source_ref: &str, operation: Mutation, editable: bool) -> Result<(), RefError> {
        let mut cx = self.action_context();
        mutate_ref(&mut cx, source_ref, editable, operation).await.map_err(action_to_ref)
    }

    async fn list_select_options(&mut self, source_ref: &str) -> Result<crate::refs::control_state::SelectOptions, RefError> {
        let actions = self.page.ref_actions();
        let page = self.page;
        with_ref_recovery(page.recovery_host(), &mut *self.recovery, source_ref, |candidate| {
            let actions = actions.clone();
            async move { actions.list_select_options(&candidate).await.map_err(ref_to_host) }
        })
        .await
        .map_err(|error| match error {
            RecoveryFailure::Host(error) => RefError::Host(error),
            RecoveryFailure::Message(message) => RefError::Failed(message),
        })
    }

    async fn fill_stored(&mut self, account: &str) -> Result<StoredLoginFill, RefError> {
        // The desktop holds the vault: it matches the account to the page's origin and writes the password into the page itself.
        let params = HostBrowserCredentialsFillParams { page_id: self.page.page_id.clone(), account: account.to_owned(), expect: Some(self.page.page_precondition()) };
        let filled = self.page.host().credentials_fill(params, self.page.token()).await.map_err(RefError::Host)?;
        Ok(StoredLoginFill { password_filled: filled.password_filled, reason: filled.reason })
    }

    fn invalidate_interaction(&mut self) {
        self.page.invalidate();
    }

    async fn action_snapshot(&mut self) -> Result<ToolReply, RefError> {
        let options = self.options();
        match self.page.settled(self.command, &options).await {
            Ok(reply) | Err(RunError::Reply(reply)) => Ok(reply),
            Err(error) => Err(error.into_ref()),
        }
    }

    fn decorate_recovery(&self, reply: ToolReply) -> ToolReply {
        ToolReply { text: decorate_recovery(&reply.text, &*self.recovery), ..reply }
    }

    async fn observation_after_failure(&mut self) -> Result<String, RefError> {
        match self.page.snapshot_reply(&json!({"action": "snapshot"}), &ReplyOptions::default()).await {
            Ok(reply) | Err(RunError::Reply(reply)) => Ok(reply.text),
            Err(RunError::Cancelled(_)) => Err(RefError::Host(HostCallError::Cancelled)),
            Err(error) => Ok(format!("Fresh observation failed: {}", error.message())),
        }
    }
}

// ---- the approval ----

/// What an upload's approval is bound to read again: the page's document and URL, and the frame that would receive the files.
struct PageRebind<'a> {
    page: &'a PageCtx,
    command: &'a Value,
}

#[async_trait]
impl Rebind for PageRebind<'_> {
    fn target(&self) -> ObservedTarget {
        let facts = self.page.page_facts();
        ObservedTarget { url: facts.url, document_id: facts.document_id }
    }

    async fn receiver_key(&self) -> String {
        self.page.upload_receiver(self.command).await.map(|receiver| receiver.key).unwrap_or_default()
    }
}

/// A step of the session itself: the identity is the session, there is no page to read again.
struct SessionRebind {
    identity: String,
}

#[async_trait]
impl Rebind for SessionRebind {
    fn target(&self) -> ObservedTarget {
        ObservedTarget { url: String::new(), document_id: self.identity.clone() }
    }

    async fn receiver_key(&self) -> String {
        String::new()
    }
}

/// One step as the approval policy reads it: describes actions and addresses only, never a typed value.
fn step_facts(step: &Value, fallback: &str) -> StepFacts {
    let text = |key: &str| step.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let target = step.get("target").filter(|target| !target.is_null());
    let describe = match target {
        Some(target) => TargetSpec::normalize(target).map(|spec| spec.describe()).unwrap_or_default(),
        None => {
            let named = ["ref", "snapshotId", "name"].iter().find(|key| truthy(step.get(**key))).map(|key| text_of(step.get(*key)));
            redact_browser_text(&named.unwrap_or_else(|| fallback.to_owned()))
        }
    };
    StepFacts {
        action: mixdog_js::js_to_lowercase(mixdog_js::js_trim(&text("action"))),
        submit: step.get("submit") == Some(&Value::Bool(true)),
        key: text("key"),
        target_name: target.and_then(|target| target.get("name")).and_then(Value::as_str).unwrap_or_default().to_owned(),
        describe,
    }
}

fn approval_command(thread: &ThreadId, command: &Value, identity: &str) -> ApprovalCommand {
    let listed = |key: &str| command.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let unattended = command.get("unattended_run") == Some(&Value::Bool(true));
    ApprovalCommand {
        step: step_facts(command, identity),
        steps: listed("steps").iter().map(|step| step_facts(step, identity)).collect(),
        fields: listed("fields").iter().map(|field| step_facts(field, identity).describe).collect(),
        thread_id: Some(thread.clone()),
        session_id: thread.as_str().to_owned(),
        session_life: command.get("session_life").and_then(Value::as_str).unwrap_or_default().to_owned(),
        unattended,
        unattended_agent: if unattended { command.get("unattended_agent").and_then(Value::as_str).unwrap_or_default().trim().to_owned() } else { String::new() },
        paths: listed("paths").iter().map(|path| text_of(Some(path))).collect(),
    }
}

impl Inner {
    /// Asks the person about a step that asks (a submit, a post, an upload, or one the operator listed), and binds what they
    /// approved to what is dispatched: the document, the URL, the command and an upload's files and receiving frame must be the
    /// same after the answer. Answers the binding of an upload; every other approved step needs none.
    async fn approve(
        &self,
        thread: &ThreadId,
        command: &mut Value,
        page: Option<&PageCtx>,
        cancel: &CancelView,
        user_wait: &UserWait,
    ) -> Result<Option<Binding>, RunError> {
        let session = thread.as_str();
        let identity = page.map_or_else(|| session.to_owned(), |page| page.page_facts().document_id);
        let approval = approval_command(thread, command, &identity);
        let Some(asked) = plan(&self.ports.approval_policy, &approval)? else { return Ok(None) };
        let mut files = Vec::new();
        let mut receiver = upload::Receiver::default();
        if asked.is_upload() {
            files = resolve_upload_files(&*self.ports.files, &approval.paths).await?;
            // What is dispatched is exactly what was approved: the canonical files.
            command["paths"] = Value::Array(files.iter().map(|file| Value::String(file.realpath.to_string_lossy().into_owned())).collect());
            if let Some(page) = page {
                receiver = page.upload_receiver(command).await?;
            }
        }
        let payment = match page {
            Some(page) if asked.probes_payment() => page_has_payment_evidence(page.host(), &page.page_id, page.token()).await,
            _ => false,
        };
        let (url, document_id) = match page {
            Some(page) => {
                let facts = page.page_facts();
                (facts.url, facts.document_id)
            }
            None => (String::new(), session.to_owned()),
        };
        let command_json = command.to_string();
        let ask: BrowserApprovalAsk = classify(
            &asked,
            &approval,
            TargetFacts { url, document_id, command_json: command_json.clone(), files, receiver_url: receiver.url, receiver_key: receiver.key, payment },
        );
        let binding = ask.binding.clone();
        // The command's clock stands still while the person is asked: the time they take is not the page's slowness.
        let waiting = user_wait.begin();
        let answered = Scope::new().cancel(cancel.token()).run(self.ports.approvals.ask(ask.prompt)).await;
        drop(waiting);
        let answer: ApprovalAnswer = match answered {
            Scoped::Done(answer) => answer.map_err(RunError::Tool)?,
            Scoped::Cancelled | Scoped::DeadlineExceeded => return Err(RunError::Cancelled(cancel.reason())),
        };
        let current: &Value = command;
        match page {
            Some(page) => verify(&binding, &answer, &command_json, &PageRebind { page, command: current }, &*self.ports.files, cancel.token()).await?,
            None => verify(&binding, &answer, &command_json, &SessionRebind { identity }, &*self.ports.files, cancel.token()).await?,
        };
        Ok((!binding.files.is_empty()).then_some(binding))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use bytes::Bytes;

    use super::*;
    use crate::actions::registry::is_action;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;
    use crate::types::BrowserApprovalPrompt;
    use crate::types::FileFacts;
    use mixdog_app_protocol::v2::browser_engine::BrowserUserInputReason;

    struct Masks;

    impl SecretGuard for Masks {
        fn redact(&self, _session_id: &str, text: &str) -> String {
            text.replace("hunter2", "[secret]")
        }

        fn remember(&self, _session_id: &str, _secret: &str) {}
    }

    struct Allows;

    #[async_trait]
    impl ApprovalPort for Allows {
        async fn ask(&self, _prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
            Ok(ApprovalAnswer::Allow { remember: crate::types::Remember::Once })
        }
    }

    struct Takeovers(Option<&'static str>);

    impl TakeoverPort for Takeovers {
        fn begin(&self, _session_id: &str) -> Result<TakeoverGuard, String> {
            match self.0 {
                Some(refusal) => Err(refusal.to_owned()),
                None => Ok(TakeoverGuard::new(CancellationToken::new(), None)),
            }
        }
    }

    struct NoBlobs;

    #[async_trait]
    impl BlobPort for NoBlobs {
        async fn read(&self, _digest: &str) -> Result<Bytes, String> {
            Err("no blobs".to_owned())
        }
    }

    struct NoFiles;

    #[async_trait]
    impl FilePort for NoFiles {
        async fn stat(&self, _path: &Path) -> FileFacts {
            FileFacts::default()
        }

        async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    fn engine(host: &Arc<FakeHost>, takeover: Option<&'static str>) -> BrowserEngine {
        engine_with(host, takeover, ActionPolicy::from_env(None, None, None, is_action))
    }

    fn engine_with(host: &Arc<FakeHost>, takeover: Option<&'static str>, approval_policy: ActionPolicy) -> BrowserEngine {
        engine_over(host, takeover, approval_policy, Arc::new(NoFiles))
    }

    fn engine_over(host: &Arc<FakeHost>, takeover: Option<&'static str>, approval_policy: ActionPolicy, files: Arc<dyn FilePort>) -> BrowserEngine {
        BrowserEngine::new(
            host.clone(),
            EnginePorts {
                mirror: Arc::new(Mirror::new()),
                hold: Arc::new(UserHold::new()),
                approvals: Arc::new(Allows),
                takeover: Arc::new(Takeovers(takeover)),
                blobs: Arc::new(NoBlobs),
                files,
                secrets: Arc::new(Masks),
                approval_policy,
                urls: UrlPolicy::default(),
                frame_dir: PathBuf::from("frames"),
            },
        )
    }

    fn thread() -> ThreadId {
        ThreadId::from("s1")
    }

    async fn run(engine: &BrowserEngine, action: &str, input: Value) -> Result<ToolReply, ToolError> {
        let input = input.as_object().cloned().unwrap_or_default();
        engine.run(&thread(), action, &input, &CancellationToken::new()).await.map_err(|failure| failure.error)
    }

    fn page_row(page: &str, tab: &str) -> Value {
        json!({"pageId": page, "tabId": tab, "sessionId": "s1", "background": false, "facts": page_facts(page, 1)})
    }

    fn resolved(page: &str) -> Expect {
        Expect::ok("host/browser/pages/resolve", json!({"page": page_row(page, "v1"), "leaseId": "lease-1"}))
    }

    /// The page the host just made for the command (`created`), which the turn may reclaim (`disposable`).
    fn resolved_new(page: &str) -> Expect {
        let mut row = page_row(page, "v1");
        row["created"] = json!(true);
        row["disposable"] = json!(true);
        Expect::ok("host/browser/pages/resolve", json!({"page": row, "leaseId": "lease-1"}))
    }

    fn snapshot_answer() -> Expect {
        let body = payload("p1-s1", vec![element("p1-s1-e1", "button", "Go")], "https://a.test/");
        Expect::ok(
            "host/browser/snapshot",
            json!({"snapshotId": "p1-s1", "documentId": "p1:1", "revision": 1, "payload": serde_json::to_value(body).expect("payload"), "warnings": [], "facts": page_facts("p1", 2)}),
        )
    }

    fn no_downloads() -> Expect {
        Expect::ok("host/browser/downloads", json!({"items": []}))
    }

    /// A disk that holds the files it is told of.
    struct FilesOn(&'static str);

    #[async_trait]
    impl FilePort for FilesOn {
        async fn stat(&self, path: &Path) -> FileFacts {
            FileFacts { exists: path == Path::new(self.0), is_file: path == Path::new(self.0), size: 4, ..FileFacts::default() }
        }

        async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    #[async_trait]
    impl DownloadFiles for FilesOn {
        async fn read_file(&self, _path: &Path, _limit: u64) -> std::io::Result<Bytes> {
            Ok(Bytes::from_static(b"%PDF"))
        }
    }

    fn download(id: &str, state: &str, path: &str) -> Value {
        json!({"id": id, "file": "report.pdf", "path": path, "url": "https://a.test/report.pdf", "mimeType": "application/pdf", "state": state, "received": 4, "total": 4, "startedAt": 1})
    }

    fn downloads_of(items: &[Value]) -> Expect {
        Expect::ok("host/browser/downloads", json!({"items": items}))
    }

    #[tokio::test]
    async fn an_attached_download_is_returned_inline_and_is_refused_when_it_is_no_readable_file_or_not_complete() {
        let saved = "/dl/report.pdf";
        let finished = download("d1", "completed", saved);
        let on_disk = Arc::new(FakeHost::scripted(vec![downloads_of(&[finished.clone()])]));
        let engine_on = engine_over(&on_disk, None, ActionPolicy::from_env(None, None, None, is_action), Arc::new(FilesOn(saved)));
        engine_on.set_download_files(Arc::new(FilesOn(saved)));
        let reply = run(&engine_on, "downloads", json!({"attach": true})).await.expect("the download is a file");
        assert!(reply.text.ends_with("Attached download d1 as report.pdf."), "{}", reply.text);
        let file = reply.file.expect("the file rides in the reply");
        assert_eq!((file.name.as_str(), file.mime_type.as_str(), &file.bytes[..]), ("report.pdf", "application/pdf", &b"%PDF"[..]));

        let gone = Arc::new(FakeHost::scripted(vec![downloads_of(&[finished])]));
        let engine_gone = engine(&gone, None);
        engine_gone.set_download_files(Arc::new(FilesOn(saved)));
        let error = run(&engine_gone, "downloads", json!({"attach": true})).await.expect_err("no file at the path");
        assert_eq!(error.message_for_model, "download d1 is not a readable file");

        let running = Arc::new(FakeHost::scripted(vec![downloads_of(&[download("d2", "in_progress", saved)])]));
        let error = run(&engine(&running, None), "downloads", json!({"attach": true, "downloadId": "d2"})).await.expect_err("not complete");
        assert_eq!(error.message_for_model, "download d2 is in_progress; wait for completion before attaching");

        let none = Arc::new(FakeHost::scripted(vec![downloads_of(&[download("d3", "interrupted", saved)])]));
        let error = run(&engine(&none, None), "downloads", json!({"attach": true})).await.expect_err("nothing completed");
        assert_eq!(error.message_for_model, "no completed download is available to attach");
    }

    #[tokio::test]
    async fn list_tabs_asks_the_host_for_the_sessions_pages_and_carries_its_timing() {
        let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": [page_row("p1", "v1")], "activePageId": "p1"}))]));
        let reply = run(&engine(&host, None), "list_tabs", json!({})).await.expect("lists");
        assert!(reply.text.contains("p1"), "{}", reply.text);
        assert!(reply.timing.is_some());
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn a_command_the_contract_does_not_know_fails_before_it_reaches_the_host() {
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let error = run(&engine(&host, None), "teleport", json!({})).await.expect_err("unknown");
        assert_eq!(error.message_for_model, "unknown browser action \"teleport\"");
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn a_session_a_person_took_over_is_refused_with_the_takeover_text() {
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let error = run(&engine(&host, Some("a person has this session")), "snapshot", json!({})).await.expect_err("taken over");
        assert_eq!(error.message_for_model, "a person has this session");
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn a_snapshot_resolves_the_page_under_a_lease_reports_it_and_releases_the_lease() {
        let host = Arc::new(FakeHost::scripted(vec![
            resolved("p1").with_params(json!({"sessionId": "s1", "lease": {"ttlMs": 42_000}})),
            snapshot_answer(),
            no_downloads(),
        ]));
        let reply = run(&engine(&host, None), "snapshot", json!({})).await.expect("snapshot");
        assert!(reply.text.contains("Go"), "{}", reply.text);
        assert!(reply.timing.is_some_and(|timing| timing.snapshots == 1));
        host.finish().expect("resolve, snapshot, downloads");
        let released = host.notifications();
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].method, "host/browser/lease/release");
        assert_eq!(released[0].params["leaseId"], "lease-1");
    }

    #[tokio::test]
    async fn a_page_a_turn_made_is_closed_when_the_turn_is_aborted_and_kept_when_it_finished() {
        let script = |turn_end: Option<Expect>| {
            let mut calls = vec![resolved_new("p1"), snapshot_answer(), no_downloads()];
            calls.extend(turn_end);
            Arc::new(FakeHost::scripted(calls))
        };
        let kept = script(None);
        let engine_kept = engine(&kept, None);
        run(&engine_kept, "snapshot", json!({})).await.expect("snapshot");
        assert_eq!(engine_kept.finish_turn(&thread(), false).await, 0);
        kept.finish().expect("nothing closed");
        let ended = kept.calls().into_iter().rfind(|call| call.method == "host/browser/turn").expect("the host is told the turn ended");
        assert_eq!((ended.params["op"].as_str(), ended.params["turn"].as_i64(), ended.params["aborted"].as_bool()), (Some("end"), Some(1), Some(false)));

        let aborted = script(Some(Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "turnEnd"}))));
        let engine_aborted = engine(&aborted, None);
        run(&engine_aborted, "snapshot", json!({})).await.expect("snapshot");
        assert_eq!(engine_aborted.finish_turn(&thread(), true).await, 1);
        aborted.finish().expect("the page closed");
        // The next command is the next turn's: it owns pages of its own and is not refused.
        assert_eq!(locked(&engine_aborted.inner.tasks).current("s1"), 2);
    }

    #[tokio::test]
    async fn the_first_command_after_a_turn_ended_is_the_next_turns_even_before_the_ended_turns_pages_are_closed() {
        let close = Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "turnEnd"}));
        let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), resolved("p1"), snapshot_answer(), no_downloads(), close]));
        let engine = engine(&host, None);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        // What `turn_ended` does before it hands the closing to a task.
        let ended = engine.inner.end_turn(&thread(), true).expect("a command ran in the turn");
        assert_eq!((ended.turn, ended.closing.as_slice()), (1, ["p1".to_owned()].as_slice()));
        run(&engine, "snapshot", json!({})).await.expect("the next turn's first command");
        {
            let mut tasks = locked(&engine.inner.tasks);
            assert_eq!(tasks.current("s1"), 2);
            assert!(tasks.take_touched("s1"), "the command is counted in the turn that is running");
        }
        assert_eq!(engine.inner.close_ended(&thread(), ended, true).await, 1);
        host.finish().expect("the ended turn's page closed after the next turn's command");
    }

    #[tokio::test]
    async fn the_document_revision_of_a_page_is_read_from_the_host_now_and_unknown_when_the_host_cannot_say() {
        let revision = |value: i64| Expect::ok("host/browser/revision", json!({"revision": value, "facts": page_facts("p1", 3)})).with_params(json!({"pageId": "p1"}));
        let host = Arc::new(FakeHost::scripted(vec![revision(7), Expect::err("host/browser/revision", HostCallError::Failed { message: "page is gone".into() })]));
        let engine = engine(&host, None);
        let page = PageCtx {
            inner: engine.inner.clone(),
            slot: engine.inner.slot("p1"),
            page_id: "p1".to_owned(),
            thread: thread(),
            turn: 1,
            cancel: CancelSource::new().view(),
            user_wait: UserWait::new(),
            timer: Arc::new(CommandTimer::start(0.0)),
            background: false,
        };
        assert_eq!(page.document_revision(&CancellationToken::new()).await, Some(7));
        assert_eq!(page.document_revision(&CancellationToken::new()).await, None);
        host.finish().expect("both reads were made");
    }

    #[tokio::test]
    async fn a_page_the_host_did_not_call_disposable_is_never_closed_by_a_turn_and_an_idle_turn_tells_the_host_nothing() {
        let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
        let engine = engine(&host, None);
        assert_eq!(engine.finish_turn(&thread(), true).await, 0);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        assert_eq!(engine.finish_turn(&thread(), true).await, 0);
        host.finish().expect("no close");
        let told = host.calls().into_iter().filter(|call| call.method == "host/browser/turn").count();
        assert_eq!(told, 1, "only the turn that ran a command ends at the host");
    }

    #[tokio::test]
    async fn a_command_that_failed_after_it_ran_carries_its_timing_and_an_invalid_request_none() {
        let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() })]));
        let engine = engine(&host, None);
        let failure = engine.run(&thread(), "snapshot", &Map::new(), &CancellationToken::new()).await.expect_err("the snapshot fails");
        assert_eq!(failure.error.message_for_model, "page is unavailable");
        let timing = failure.timing.expect("the command held its lane");
        assert!(timing.command_ms >= 0.0 && timing.command_ms >= timing.snapshot_ms);

        let invalid = json!({"includeScreenshot": true}).as_object().cloned().unwrap_or_default();
        let failure = engine.run(&thread(), "snapshot", &invalid, &CancellationToken::new()).await.expect_err("an unknown field");
        assert!(failure.timing.is_none(), "an invalid request never took its place");
    }

    #[tokio::test]
    async fn a_failure_on_a_page_the_command_made_closes_the_blank_page_and_says_so() {
        let host = Arc::new(FakeHost::scripted(vec![
            resolved_new("p1"),
            Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() }),
            Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "discard"})),
        ]));
        let error = run(&engine(&host, None), "snapshot", json!({})).await.expect_err("fails");
        assert_eq!(error.message_for_model, "page is unavailable. The blank tab this command opened was closed.");
        host.finish().expect("resolve, snapshot, discard");
        // A page that was not the command's own is left alone, and so is one the host kept (it answers not closed).
        let kept = Arc::new(FakeHost::scripted(vec![resolved("p1"), Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() })]));
        let error = run(&engine(&kept, None), "snapshot", json!({})).await.expect_err("fails");
        assert_eq!(error.message_for_model, "page is unavailable");
        kept.finish().expect("no discard");
    }

    #[tokio::test]
    async fn a_sign_in_the_host_made_leads_a_fresh_observation_and_a_linked_identity_leads_the_reply() {
        let note = "Signed in to a.test with its saved login (the password never left the host).";
        let host = Arc::new(FakeHost::scripted(vec![
            resolved("p1"),
            snapshot_answer(),
            no_downloads(),
            Expect::ok("host/browser/signIn", json!({"note": note, "line": "Linked sign-in: a.test used Google."}))
                .with_params(json!({"op": "afterCommand", "sessionId": "s1", "pageId": "p1", "turn": 1, "explicitFill": false})),
            snapshot_answer(),
            no_downloads(),
        ]));
        let reply = run(&engine(&host, None), "snapshot", json!({})).await.expect("snapshot");
        assert!(reply.text.starts_with(&format!("Linked sign-in: a.test used Google.\n\n{note}\n\n")), "{}", reply.text);
        assert!(reply.text.contains("Go"), "{}", reply.text);
        host.finish().expect("the observation was taken again");
    }

    #[tokio::test]
    async fn a_page_a_dialog_holds_answers_with_the_dialog_and_the_sign_in_hooks_are_not_asked() {
        let mut page = page_row("p1", "v1");
        page["facts"]["pendingDialog"] = json!({"type": "alert", "message": "Sure?", "openedAt": 1, "bridge": false});
        let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/resolve", json!({"page": page, "leaseId": "lease-1"}))]));
        let reply = run(&engine(&host, None), "click", json!({"ref": "e1"})).await.expect("the dialog is the reply");
        assert!(reply.text.contains("Sure?"), "{}", reply.text);
        assert!(!host.calls().iter().any(|call| call.method == "host/browser/signIn"), "a page a dialog blocks is not read by the sign-in hooks");
    }

    #[tokio::test]
    async fn a_host_that_cannot_answer_the_sign_in_hooks_leaves_the_reply_as_it_was() {
        let host = Arc::new(FakeHost::scripted(vec![
            resolved("p1"),
            snapshot_answer(),
            no_downloads(),
            Expect::err("host/browser/signIn", HostCallError::Failed { message: "vault unreadable".into() }),
        ]));
        let reply = run(&engine(&host, None), "snapshot", json!({})).await.expect("snapshot");
        assert!(reply.text.contains("Go") && !reply.text.contains("vault"), "{}", reply.text);
        host.finish().expect("asked once");
    }

    #[tokio::test]
    async fn the_page_state_the_host_pushes_is_kept_with_the_facts_of_its_answers() {
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let engine = engine(&host, None);
        let lane: Arc<dyn EngineSink> = Arc::new(crate::lane::sink::EngineSinkImpl::new(Arc::new(Mirror::new()), Arc::new(UserHold::new())));
        let sink = engine.sink(lane);
        let facts: PageFacts = serde_json::from_value(page_facts("p9", 4)).expect("facts");
        sink.facts(HostBrowserPageFactsParams { page_id: "p9".into(), seq: 4, facts: facts.clone() });
        assert_eq!(engine.inner.store.get("p9"), Some(facts));
        sink.host_gone();
        assert_eq!(engine.inner.store.get("p9"), None);
    }

    #[test]
    fn an_open_says_where_the_page_is_or_fails_to_place_it() {
        let facts: PageFacts = serde_json::from_value(page_facts("p1", 1)).expect("facts");
        let shown = placement_line(&facts, Some(BrowserPlacement::Shown)).expect("shown");
        assert_eq!(shown, "Shown in the browser panel: page p1 \u{2014} (untitled) (https://a.test/).");
        let pending = placement_line(&facts, Some(BrowserPlacement::Pending)).expect("pending");
        assert!(pending.starts_with("Not on screen yet: page p1") && pending.ends_with("Do not tell the user it is on screen."), "{pending}");
        assert!(matches!(placement_line(&facts, None), Err(RunError::Failed(_))));
    }

    #[test]
    fn the_host_failures_a_command_meets_are_told_in_the_agents_words() {
        assert!(matches!(RunError::from(HostCallError::Cancelled), RunError::Cancelled(None)));
        assert!(matches!(RunError::from(HostCallError::UserInput { until: None }), RunError::Failed(text) if text == LOCAL_INPUT_TAKEOVER));
        assert!(matches!(RunError::from(HostCallError::Refused { reason: "blocked scheme".into() }), RunError::Failed(text) if text == "blocked scheme"));
        let dialog: BrowserPendingDialog = serde_json::from_value(json!({"type": "alert", "message": "Sure?", "openedAt": 1, "bridge": false})).expect("dialog");
        match RunError::from(HostCallError::DialogBlocking { dialog: Box::new(dialog) }) {
            RunError::Reply(reply) => assert_eq!(reply.outcome, Some(ReplyOutcome::Blocked)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failure_leaves_through_the_secret_guard_and_a_refusal_keeps_its_type() {
        let failed = RunError::Failed("could not type hunter2".into()).into_tool_error(&Masks, "s1");
        assert_eq!(failed.message_for_model, "could not type [secret]");
        let denied = RunError::from(ApprovalError::NotApproved { reason: "no".into() }).into_tool_error(&Masks, "s1");
        assert_eq!(denied.code, ToolErrorCode::PermissionDenied);
        assert_eq!(RunError::Cancelled(None).into_tool_error(&Masks, "s1").code, ToolErrorCode::Cancelled);
    }

    #[test]
    fn the_approval_reads_what_a_step_targets_and_what_it_submits_without_its_values() {
        let command = json!({
            "action": "sequence", "session_life": "life-1", "unattended_run": true, "unattended_agent": " bot ",
            "steps": [{"action": "click", "target": {"role": "button", "name": "Send"}}, {"action": "fill", "ref": "p1-s1-e2", "submit": true, "text": "hunter2"}],
        });
        let read = approval_command(&thread(), &command, "p1:1");
        assert_eq!(read.steps.len(), 2);
        assert_eq!((read.steps[0].action.as_str(), read.steps[0].target_name.as_str()), ("click", "Send"));
        assert_eq!(read.steps[0].describe, "button \"Send\"");
        assert!(read.steps[1].submit);
        assert_eq!(read.steps[1].describe, "p1-s1-e2");
        assert_eq!((read.session_life.as_str(), read.unattended, read.unattended_agent.as_str()), ("life-1", true, "bot"));
        let bare = approval_command(&thread(), &json!({"action": "press", "key": "Enter"}), "p1:1");
        assert_eq!((bare.step.key.as_str(), bare.step.describe.as_str()), ("Enter", "p1:1"));
    }

    #[test]
    fn the_directory_knows_the_selected_page_and_the_named_background_pages_of_a_session() {
        let page = |id: &str, tab: &str, background: bool| -> PageDescriptor {
            serde_json::from_value(json!({"pageId": id, "tabId": tab, "sessionId": "s1", "background": background, "facts": page_facts(id, 1)})).expect("page")
        };
        let mut directory = Directory::default();
        directory.observe_list("s1", &[page("p1", "v1", false), page("p2", "research", true)], Some("p1"));
        assert_eq!(directory.current_page_id("s1").as_deref(), Some("p1"));
        assert_eq!(directory.background_page_id("s1", "research").as_deref(), Some("p2"));
        assert_eq!(directory.background_name_by_page_id("s1", "p2").as_deref(), Some("research"));
        assert_eq!(directory.current_page_id("s2"), None);
        let key = QueueKey::for_command(&directory, &KeyInput { session: Some("s1"), action: "click", tab: "research", background: false }).expect("key");
        assert_eq!((key.lane(), key.page()), ("session:s1:background:research", Some("p2")));
        directory.forget_page("p2");
        assert_eq!(directory.background_page_id("s1", "research"), None);
    }

    #[tokio::test]
    async fn close_tab_closes_a_background_page_by_its_name_and_refuses_the_visible_tab() {
        let background = json!({"pageId": "p2", "tabId": "research", "sessionId": "s1", "background": true, "facts": page_facts("p2", 1)});
        let listing = || Expect::ok("host/browser/pages/list", json!({"pages": [page_row("p1", "v1"), background.clone()], "activePageId": "p1"}));
        let host = Arc::new(FakeHost::scripted(vec![
            listing(),
            Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p2", "reason": "agent"})),
            listing(),
            listing(),
        ]));
        let engine = engine(&host, None);
        let closed = run(&engine, "close_tab", json!({"tab": "research"})).await.expect("closes");
        assert_eq!(closed.text, "Closed background tab \"research\".");
        let visible = run(&engine, "close_tab", json!({"tab": "v1"})).await.expect_err("visible");
        assert!(visible.message_for_model.starts_with("\"v1\" is the visible tab"), "{}", visible.message_for_model);
        let unknown = run(&engine, "close_tab", json!({"tab": "nowhere"})).await.expect_err("unknown");
        assert_eq!(unknown.message_for_model, "unknown background tab \"nowhere\"; call list_tabs");
        host.finish().expect("list, close, list, list");
    }

    #[tokio::test]
    async fn hide_asks_the_host_to_put_the_panel_away() {
        let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/surface", json!({})).with_params(json!({"sessionId": "s1", "op": "hide"}))]));
        let reply = run(&engine(&host, None), "hide", json!({})).await.expect("hides");
        assert_eq!(reply.text, "Browser panel hide requested; tabs and page state are preserved.");
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn an_open_shows_the_page_and_says_where_it_is() {
        let answer = Expect::ok("host/browser/pages/resolve", json!({"page": page_row("p1", "v1"), "leaseId": "lease-1", "placement": "shown"}))
            .with_params(json!({"sessionId": "s1", "open": {"reveal": true}}));
        let host = Arc::new(FakeHost::scripted(vec![answer]));
        let reply = run(&engine(&host, None), "open", json!({})).await.expect("opens");
        assert_eq!(reply.text, "Shown in the browser panel: page p1 \u{2014} (untitled) (https://a.test/).");
        host.finish().expect("one call");
        assert_eq!(host.notifications().len(), 1);
    }

    #[tokio::test]
    async fn a_step_the_operator_denied_is_refused_before_anything_reaches_the_page() {
        let host = Arc::new(FakeHost::scripted(vec![resolved("p1")]));
        let policy = ActionPolicy::from_env(None, Some("click"), None, is_action);
        let error = run(&engine_with(&host, None, policy), "click", json!({"ref": "p1-s1-e1"})).await.expect_err("denied");
        assert_eq!(error.message_for_model, "Browser Use action is denied by policy; nothing was dispatched");
        host.finish().expect("only the page was resolved");
    }

    #[tokio::test]
    async fn a_turns_pages_are_closed_after_the_commands_in_flight_when_it_ended_are_done() {
        let close = Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "turnEnd"}));
        let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), close]));
        let engine = engine(&host, None);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        // A command of the session is still queued or running when the turn ends.
        let flight = engine.inner.track("s1");
        let other_session = engine.inner.track("s2");
        let ended = engine.inner.end_turn(&thread(), true).expect("a command ran in the turn");
        assert_eq!(ended.in_flight.len(), 1, "only the session's own commands are waited for");
        let session = thread();
        let mut closing = pin!(engine.inner.close_ended(&session, ended, true));
        assert!(std::future::poll_fn(|cx| Poll::Ready(closing.as_mut().poll(cx).is_pending())).await, "the page is not closed under the running command");
        assert!(host.calls().iter().all(|call| call.method != "host/browser/pages/close"));
        drop(flight);
        assert_eq!(closing.await, 1);
        drop(other_session);
        host.finish().expect("the page closed once the command was done");
    }

    #[tokio::test]
    async fn a_close_that_failed_is_retried_unless_the_page_was_destroyed_meanwhile() {
        let gone = Expect::err("host/browser/pages/close", HostCallError::PageGone);
        let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), gone]));
        let engine = engine(&host, None);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        assert_eq!(engine.finish_turn(&thread(), true).await, 0);
        assert!(!locked(&engine.inner.tasks).owns("p1"), "a destroyed page is not owned again");

        let failed = Expect::err("host/browser/pages/close", HostCallError::Failed { message: "window close failed".into() });
        let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), failed]));
        let engine = self::engine(&host, None);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        assert_eq!(engine.finish_turn(&thread(), true).await, 0);
        assert!(locked(&engine.inner.tasks).owns("p1"), "a failed close leaves the page owned for a later cleanup");
    }

    #[tokio::test]
    async fn releasing_a_session_ends_the_persons_hold_on_its_pages() {
        use crate::queue::key::QueueKey;
        use crate::queue::user_hold::UserInputParams;
        let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
        let engine = engine(&host, None);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        let hold = engine.inner.ports.hold.clone();
        hold.on_user_input(UserInputParams { page_id: "p1".into(), seq: 1, held: true, until: None, reason: BrowserUserInputReason::Pointer });
        let key = QueueKey::new("session:s1:foreground", Some("p1".into()));
        assert!(hold.takeover_error(&key).is_err());
        engine.forget_session(&thread()).await;
        assert_eq!(hold.takeover_error(&key), Ok(()));
        assert!(locked(&engine.inner.directory).sessions.is_empty());
    }

    #[test]
    fn a_selector_match_the_snapshot_did_not_list_joins_the_snapshots_ref_set() {
        let store = FactsStore::default();
        let result: HostBrowserSnapshotResult = serde_json::from_value(serde_json::json!({
            "snapshotId": "p1-s1", "documentId": "p1:1", "revision": 1, "warnings": [], "facts": page_facts("p1", 2),
            "payload": serde_json::to_value(payload("p1-s1", vec![element("p1-s1-e1", "button", "Go")], "https://a.test/")).expect("payload"),
        }))
        .expect("snapshot");
        result.observe(&store);
        let covered = store.snapshot("p1", "p1-s1").expect("observed").refs.covered_elements;
        // The host minted `p1-s1-t1` for a match the snapshot did not list; the one it listed keeps its own place.
        let minted: HostBrowserRefMintResult = serde_json::from_value(serde_json::json!({
            "count": 2, "facts": page_facts("p1", 3),
            "matches": [{"ref": "p1-s1-e1", "role": "button", "name": "Go"}, {"ref": "p1-s1-t1", "role": "div", "name": "card"}],
        }))
        .expect("mint");
        minted.observe(&store);
        let joined = store.snapshot("p1", "p1-s1").expect("still observed").refs;
        let found = joined.get("p1-s1-t1").expect("the minted ref joined");
        assert_eq!((found.role.as_str(), found.name.as_str(), found.url.as_str()), ("div", "card", "https://a.test/"));
        assert_eq!((joined.len(), joined.covered_elements, joined.document_id.as_str()), (2, covered, "p1:1"));
        // A ref of another snapshot is not this one's.
        store.register_minted("p1", "p1-s9", &[crate::refs::target_resolve::css_element("p1-s9-t1".into(), "div".into(), "x".into())]);
        assert!(store.snapshot("p1", "p1-s1").expect("kept").refs.get("p1-s9-t1").is_none());
    }
}
