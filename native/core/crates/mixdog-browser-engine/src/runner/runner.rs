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
use super::guard::guard_reply;
use super::guard::prepare;
use super::task_pages::TaskPages;
use super::timing_rows::CommandTimer;
use crate::actions::emulation;
use crate::actions::flow;
use crate::actions::navigation;
use crate::actions::observe;
use crate::actions::page;
use crate::actions::pointer;
use crate::actions::registry::Action;
use crate::actions::sequence::sequence;
use crate::actions::target::ActionError;
use crate::actions::target::truthy;
use crate::actions::upload;
use crate::actions::upload::UploadError;
use crate::approval::classify::ActionPolicy;
use crate::approval::classify::ApprovalError;
use crate::approval::classify::browser_not_approved;
use crate::approval::classify::plan;
use crate::error::HostCallError;
use crate::lane::mirror::Mirror;
use crate::limits::COMMAND_TIMEOUT;
use crate::port::ApprovalPort;
use crate::port::BlobPort;
use crate::port::BrowserHost;
use crate::port::EngineSink;
use crate::port::FilePort;
use crate::port::TakeoverPort;
use crate::port::TurnEvents;
use crate::queue::key::KeyInput;
use crate::queue::key::QueueKey;
use crate::queue::queue::CommandQueue;
use crate::queue::queue::Deadline;
use crate::queue::queue::Kind;
use crate::queue::queue::RunContext;
use crate::queue::user_hold::LOCAL_INPUT_TAKEOVER;
use crate::queue::user_hold::UserHold;
use crate::queue::user_wait::UserWait;
use crate::refs::access::RefError;
use crate::refs::grounding::VisualGrounding;
use crate::refs::ref_set::RefSet;
use crate::refs::target_resolve::css_element;
use crate::reply::dialog_text::blocking_dialog_reply;
use crate::reply::downloads_text::DownloadFiles;
use crate::reply::downloads_text::DownloadReports;
use crate::reply::downloads_text::attach_download;
use crate::reply::downloads_text::did_not_complete;
use crate::reply::downloads_text::ended_as;
use crate::reply::downloads_text::list_text;
use crate::reply::downloads_text::none_to_attach;
use crate::reply::downloads_text::not_complete_to_attach;
use crate::reply::reply::PageReplyState;
use crate::reply::reply::ReplyFile;
use crate::reply::reply::ReplyOutcome;
use crate::reply::reply::ToolReply;
use crate::reply::tabs_text::closed_background_tab;
use crate::reply::tabs_text::is_visible_tab_id;
use crate::reply::tabs_text::list_tabs_text;
use crate::reply::tabs_text::status_without_visible_page;
use crate::reply::tabs_text::unknown_background_tab;
use crate::reply::tabs_text::visible_tab_close_refusal;
use crate::settle::postcondition::Postcondition;
use crate::settle::postcondition::describe;
use crate::settle::reply_wait::ReplyWaitError;
use crate::settle::settle::Cancelled;
use crate::settle::settle::Page;
use crate::settle::settle::SettleError;
use crate::settle::settle::pause;
use crate::settle::settle::throw_if_cancelled;
use crate::types::ApprovalAnswer;
use crate::types::Binding;
use crate::types::TakeoverGuard;

mod approval;
mod directory;
mod errors;
mod facts;
mod page_commands;
mod page_ctx;

use directory::Directory;
use errors::RunError;
use facts::{FactsHost, FactsSink, FactsStore};
use page_ctx::{FormCtx, PageCtx, SequenceSteps, WaitSnapshot};

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
    #[cfg(any(test, feature = "test-support"))]
    {
        let replayed = crate::fake::REPLAY_NOW_MS.load(std::sync::atomic::Ordering::Relaxed);
        if replayed != 0 {
            return replayed;
        }
    }
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

// the engine

/// What a page's replies remember: its latest observation (the ref set the agent addresses), the screenshot coordinates are
/// expressed in, and what was already said.
#[derive(Default)]
struct SlotState {
    refs: Option<RefSet>,
    grounding: Option<VisualGrounding>,
    reply: PageReplyState,
    /// Where the page was scrolled when `refs` was observed.
    scroll_y: Option<f64>,
}

struct PageSlot {
    state: Mutex<SlotState>,
}

impl PageSlot {
    /// A page the engine first meets: it has heard of no download yet, and downloads of before it was met are not news to it
    /// (`downloadsReportedAt: Date.now()` of the guest's state, made when the page is first used).
    fn new() -> Self {
        let mut reply = PageReplyState::default();
        reply.downloads_reported_at = wall_clock_ms();
        Self { state: Mutex::new(SlotState { reply, ..SlotState::default() }) }
    }
}

struct Inner {
    host: Arc<FactsHost>,
    ports: EnginePorts,
    store: Arc<FactsStore>,
    queue: CommandQueue,
    slots: Mutex<HashMap<String, Arc<PageSlot>>>,
    /// The state each download was last reported in, scoped per session: downloads belong to the session (their ids are the host's,
    /// never repeated), each page keeps its own cursor, and `forget_session` clears the session's entry.
    download_reports: Mutex<HashMap<String, DownloadReports>>,
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

/// A future behind a box, for the calls whose future is too large to be kept in the frame of the poll that awaits it.
type BoxedFuture<'a, T> = std::pin::Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A command that did not answer: what the tool fails with, and the timing row of the part of the command that ran (`None` where it
/// failed before it took its place, an invalid request).
#[derive(Debug)]
pub struct CommandFailure {
    pub error: ToolError,
    pub timing: Option<CommandTiming>,
    /// The host connection was lost after a request of the command was handed to it: the command may have run. Set from the typed
    /// [`HostCallError::ConnectionLost`], never from the error's text.
    pub connection_lost: bool,
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

/// The URL policy a test run names for the commands it runs (the corpus's refused address was recorded by a remote session, which a
/// session of this core is not); only a test build has it, and one run at a time sets it.
#[cfg(feature = "test-support")]
static URL_POLICY_OF_RUN: Mutex<Option<mixdog_browser_policy::url_policy::UrlPolicy>> = Mutex::new(None);

/// Navigations are decided under the policy it was made with, instead of the engine's own, until it is dropped (test builds only).
#[cfg(feature = "test-support")]
pub struct UrlPolicyOfRun(());

#[cfg(feature = "test-support")]
impl UrlPolicyOfRun {
    pub fn set(policy: mixdog_browser_policy::url_policy::UrlPolicy) -> Self {
        *locked(&URL_POLICY_OF_RUN) = Some(policy);
        Self(())
    }
}

#[cfg(feature = "test-support")]
impl Drop for UrlPolicyOfRun {
    fn drop(&mut self) {
        *locked(&URL_POLICY_OF_RUN) = None;
    }
}

impl TurnEvents for BrowserEngine {
    fn turn_begun(&self, thread: &ThreadId) {
        let Some(turn) = self.inner.begin_turn(thread) else { return };
        let inner = self.inner.clone();
        let thread = thread.clone();
        mixdog_rt::spawn("browser-turn-begin", mixdog_rt::TaskClass::Work, async move {
            inner.turn_note(&thread, BrowserTurnOp::Begin, Some(turn), false).await;
        });
    }

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
    /// A turn of `thread` began: the turn to tell the host of, which then has an end to tell too. `None`: a session that never used
    /// the browser has nothing to tell the host (its first command marks it live there).
    fn begin_turn(&self, thread: &ThreadId) -> Option<u64> {
        if !locked(&self.directory).sessions.contains_key(thread.as_str()) {
            return None;
        }
        let mut tasks = locked(&self.tasks);
        tasks.touch(thread.as_str());
        Some(tasks.current(thread.as_str()))
    }

    /// Marks the running turn of `thread` as ended, and takes the pages it releases. `None`: no command ran in it and the host was
    /// not told it began.
    fn end_turn(&self, thread: &ThreadId, aborted: bool) -> Option<EndedTurn> {
        let mut tasks = locked(&self.tasks);
        if !tasks.take_touched(thread.as_str()) {
            return None;
        }
        let turn = tasks.current(thread.as_str());
        let store = self.store.clone();
        let closing = tasks.finish(thread.as_str(), turn, aborted, |page| !store.get(page).is_some_and(|facts| facts.pending_dialog.is_some()));
        drop(tasks);
        let in_flight: Vec<CancellationToken> =
            locked(&self.in_flight).get(thread.as_str()).map(|held| held.iter().map(|(_, done)| done.clone()).collect()).unwrap_or_default();
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
        let params =
            HostBrowserTurnParams { session_id: thread.as_str().to_owned(), op, turn: turn.and_then(|turn| i64::try_from(turn).ok()), aborted: Some(aborted) };
        let _ = self.host.turn(params, &CancellationToken::new()).await;
    }

    fn slot(&self, page_id: &str) -> Arc<PageSlot> {
        locked(&self.slots).entry(page_id.to_owned()).or_insert_with(|| Arc::new(PageSlot::new())).clone()
    }

    fn drop_page(&self, page_id: &str) {
        locked(&self.slots).remove(page_id);
        locked(&self.directory).forget_page(page_id);
        self.store.forget(page_id);
        self.ports.mirror.forget(page_id);
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    async fn run_command(
        self: &Arc<Self>,
        thread: &ThreadId,
        turn: u64,
        action: &str,
        input: &Map<String, Value>,
        cancel: &CancellationToken,
    ) -> Result<ToolReply, Failed> {
        let session = thread.as_str();
        let prepared = prepare(action, input, session, turn).map_err(RunError::Failed)?;
        let _flight = self.track(session);
        let key = {
            let directory = locked(&self.directory);
            QueueKey::for_command(
                &*directory,
                &KeyInput { session: Some(session), action: prepared.action.name(), tab: &prepared.tab, background: prepared.background },
            )
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
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

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    async fn execute(
        self: &Arc<Self>,
        thread: &ThreadId,
        turn: u64,
        prepared: Prepared,
        ctx: &RunContext,
        timer: &Arc<CommandTimer>,
    ) -> Result<ToolReply, RunError> {
        // Keep the large action-dispatch future out of every enclosing queue/scope future.
        // The production executor uses a 2 MB stack, as does the browser ceiling regression.
        match self.execute_resolved_boxed(thread, turn, prepared, ctx, timer).await {
            Err(RunError::Reply(reply)) => Ok(*reply),
            other => other,
        }
    }

    /// `execute_resolved` behind a box that is made here, in a frame that is gone when this returns: the call that builds a large
    /// future leaves it in the frame of whoever called, so boxing at the call site still keeps its whole size on the stack of every
    /// poll above it. The caller holds the pointer only.
    #[inline(never)]
    fn execute_resolved_boxed<'a>(
        self: &'a Arc<Self>,
        thread: &'a ThreadId,
        turn: u64,
        prepared: Prepared,
        ctx: &'a RunContext,
        timer: &'a Arc<CommandTimer>,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.execute_resolved(thread, turn, prepared, ctx, timer))
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    async fn execute_resolved(
        self: &Arc<Self>,
        thread: &ThreadId,
        turn: u64,
        prepared: Prepared,
        ctx: &RunContext,
        timer: &Arc<CommandTimer>,
    ) -> Result<ToolReply, RunError> {
        let Prepared { action, mut command, background, background_asked, tab, expected, has_screenshot_options } = prepared;
        let session = thread.as_str();
        if action.is_tabless() {
            // A tab-less step is asked about like any other, against the session itself.
            self.approve(thread, &mut command, None, &ctx.cancel, &ctx.user_wait).await?;
            return self.tabless(action, &command, session, &tab, ctx).await;
        }
        locked(&self.tasks).begin(session, turn).map_err(RunError::Failed)?;
        if action == Action::Status && tab.is_empty() && background_asked != Some(true) {
            let listed = self.host.pages_list(HostBrowserPagesListParams { session_id: session.to_owned() }, ctx.cancel.token()).await?;
            locked(&self.directory).observe_list(session, &listed.pages, listed.active_page_id.as_deref());
            if let Some(text) = status_without_visible_page(&listed.pages, listed.active_page_id.as_deref()) {
                return Ok(ToolReply::text(text));
            }
        }
        let (descriptor, placement, _lease) = self.resolve_page(session, action, background, background_asked, &tab, &ctx.cancel).await?;
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
            let reply = page.act_boxed(action, command, expected, has_screenshot_options).await?;
            page.after_command_boxed(action, background, placement, &hints, reply).await
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    async fn resolve_page(
        &self,
        session: &str,
        action: Action,
        background: bool,
        background_asked: Option<bool>,
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
            background: background_asked,
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    async fn tabless(&self, action: Action, command: &Value, session: &str, tab: &str, ctx: &RunContext) -> Result<ToolReply, RunError> {
        let cancel = ctx.cancel.token();
        match action {
            Action::ListTabs => {
                let listed = self.host.pages_list(HostBrowserPagesListParams { session_id: session.to_owned() }, cancel).await?;
                locked(&self.directory).observe_list(session, &listed.pages, listed.active_page_id.as_deref());
                Ok(ToolReply::text(list_tabs_text(&listed.pages, listed.active_page_id.as_deref())))
            }
            Action::CloseTab => {
                // `normalizeBackgroundTabName(tab, { required: true })` of `backgroundTabEntry`.
                if tab.trim().is_empty() {
                    return Err(RunError::Failed("a background tab name is required".to_owned()));
                }
                let listed = self.host.pages_list(HostBrowserPagesListParams { session_id: session.to_owned() }, cancel).await?;
                locked(&self.directory).observe_list(session, &listed.pages, listed.active_page_id.as_deref());
                // A page id and a visible `vN` match in any case (`PAGE_ID` and `VISIBLE_POSITION` are `/i`); a name is exact.
                let Some(found) = listed.pages.iter().find(|page| {
                    page.page_id.eq_ignore_ascii_case(tab)
                        || page.tab_id == tab.trim()
                        || (is_visible_tab_id(&page.tab_id) && page.tab_id.eq_ignore_ascii_case(tab))
                }) else {
                    return Err(RunError::Failed(unknown_background_tab(tab)));
                };
                // Only the pane's own visible tab stays with the panel; a tab the person opened with "+" closes like any other.
                if is_visible_tab_id(&found.tab_id) {
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    async fn downloads_reply(&self, command: &Value, session: &str, ctx: &RunContext) -> Result<ToolReply, RunError> {
        let mut selected = command.get("downloadId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned);
        throw_if_cancelled(&ctx.cancel)?;
        if truthy(command.get("wait")) {
            self.wait_for_download(command, session, &ctx.cancel, &mut selected).await?;
        }
        let recorded = self.recorded_downloads(session, &ctx.cancel).await?;
        let mut reply = ToolReply::text(list_text(&recorded));
        if recorded.is_empty() || !truthy(command.get("attach")) {
            return Ok(reply);
        }
        let (file, note) = self.attach_chosen(&recorded, selected.as_deref(), &ctx.cancel).await?;
        reply.text.push_str(&note);
        reply.file = Some(file);
        Ok(reply)
    }

    async fn recorded_downloads(&self, session: &str, cancel: &CancelView) -> Result<Vec<DownloadItem>, RunError> {
        let params = HostBrowserDownloadsParams { session_id: session.to_owned(), op: BrowserDownloadsOp::List, since: None, id: None };
        Ok(self.host.downloads(params, cancel.token()).await?.items)
    }

    /// Polls until the selected download (the newest when none is named, which is then recorded in `selected`) completes.
    async fn wait_for_download(&self, command: &Value, session: &str, cancel: &CancelView, selected: &mut Option<String>) -> Result<(), RunError> {
        const DEFAULT_WAIT_MS: i64 = 10_000;
        const MIN_WAIT_MS: i64 = 500;
        const MAX_WAIT_MS: i64 = 30_000;
        const POLL: Duration = Duration::from_millis(100);
        let timeout_ms = command
            .get("timeoutMs")
            .and_then(Value::as_f64)
            .filter(|ms| ms.is_finite())
            .map_or(DEFAULT_WAIT_MS, |ms| (ms.trunc() as i64).clamp(MIN_WAIT_MS, MAX_WAIT_MS));
        let started = Instant::now();
        loop {
            throw_if_cancelled(cancel)?;
            let items = self.recorded_downloads(session, cancel).await?;
            if selected.is_none() {
                *selected = items.first().map(|item| item.id.clone());
            }
            if let Some(item) = items.iter().find(|item| Some(&item.id) == selected.as_ref()).filter(|item| item.state != "in_progress") {
                if item.state != "completed" {
                    return Err(RunError::Failed(ended_as(&item.id, &item.state)));
                }
                return Ok(());
            }
            if started.elapsed() >= Duration::from_millis(timeout_ms as u64) {
                return Err(RunError::Failed(did_not_complete(selected.as_deref(), timeout_ms as u64)));
            }
            pause(POLL, cancel).await?;
        }
    }

    async fn attach_chosen(&self, recorded: &[DownloadItem], selected: Option<&str>, cancel: &CancelView) -> Result<(ReplyFile, String), RunError> {
        let chosen = match selected {
            Some(id) => recorded.iter().find(|download| download.id == id),
            None => recorded.iter().find(|download| download.state == "completed"),
        };
        let Some(chosen) = chosen else { return Err(RunError::Failed(none_to_attach().to_owned())) };
        if chosen.state != "completed" {
            return Err(RunError::Failed(not_complete_to_attach(&chosen.id, &chosen.state)));
        }
        let Some(reader) = self.download_files.get() else {
            return Err(RunError::Failed("downloads cannot attach a file: this core was not given a reader for the downloaded files".to_owned()));
        };
        let attached = attach_download(&*self.ports.files, &**reader, chosen).await.map_err(RunError::Failed)?;
        throw_if_cancelled(cancel)?;
        Ok(attached)
    }
}

/// What the agent may tell the user about an `open`: shown, or pending because the conversation is not on screen.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
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

// one command on one page

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
            Self::ConnectionLost => HostCallError::ConnectionLost.to_string(),
        }
    }

    fn into_observe(self) -> observe::ActionError {
        match self {
            Self::Cancelled(reason) => observe::ActionError::Cancelled(Cancelled { reason }),
            Self::ConnectionLost => observe::ActionError::Host(HostCallError::ConnectionLost),
            other => observe::ActionError::Failed(other.message()),
        }
    }

    fn into_action(self) -> ActionError {
        match self {
            Self::Cancelled(reason) => ActionError::Cancelled(Cancelled { reason }),
            Self::ConnectionLost => ActionError::Host(HostCallError::ConnectionLost),
            other => ActionError::Failed(other.message()),
        }
    }

    fn into_ref(self) -> RefError {
        match self {
            Self::Cancelled(_) => RefError::Host(HostCallError::Cancelled),
            Self::ConnectionLost => RefError::Host(HostCallError::ConnectionLost),
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

#[cfg(test)]
mod tests;

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
                download_reports: Mutex::default(),
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub async fn run(&self, thread: &ThreadId, action: &str, input: &Map<String, Value>, cancel: &CancellationToken) -> Result<ToolReply, CommandFailure> {
        let inner = &self.inner;
        let turn = locked(&inner.tasks).current(thread.as_str());
        // The loss is latched where the host lane produces it, for this command: whatever a layer between the lane and here did with the
        // error (worded it, swallowed it as a best-effort read), the answer still knows a request of this command was lost.
        let (outcome, latched) = crate::error::track_connection_loss(inner.run_command(thread, turn, action, input, cancel)).await;
        match outcome {
            Ok(_) if latched => Err(CommandFailure {
                error: RunError::ConnectionLost.into_tool_error(&*inner.ports.secrets, thread.as_str()),
                timing: None,
                connection_lost: true,
            }),
            Ok(reply) => Ok(guard_reply(&*inner.ports.secrets, thread.as_str(), reply)),
            Err(Failed { error, timing }) => {
                let connection_lost = latched || matches!(error, RunError::ConnectionLost);
                Err(CommandFailure { error: error.into_tool_error(&*inner.ports.secrets, thread.as_str()), timing, connection_lost })
            }
        }
    }

    /// The running turn of `thread` ended (`finishBrowserTurn`): the pages it opened for itself are released when it was aborted (a
    /// dialog that needs a person keeps its page), no later command of that turn runs, and the host drops what it remembered of the
    /// turn and the untouched blank page the agent has since left behind. A turn nobody ran a command in and the host was not told
    /// began is nothing to finish. Answers how many pages were closed.
    pub async fn finish_turn(&self, thread: &ThreadId, aborted: bool) -> usize {
        match self.inner.end_turn(thread, aborted) {
            Some(ended) => self.inner.close_ended(thread, ended, aborted).await,
            None => 0,
        }
    }

    /// The session is released: the pages it owned are no longer tracked, and the host forgets what it remembered of it.
    pub async fn forget_session(&self, thread: &ThreadId) {
        locked(&self.inner.tasks).forget(thread.as_str());
        locked(&self.inner.download_reports).remove(thread.as_str());
        // The session's pages are gone with it, and so is the person's hold on them (`releaseLocal`): a hold left behind would
        // refuse the next agent command on a page id the host never reuses, and keep a record for ever.
        // Release the directory lock before `drop_page`, which also locks `directory`.
        let held = locked(&self.inner.directory).sessions.remove(thread.as_str());
        if let Some(held) = held {
            for page_id in held.current.iter().chain(held.backgrounds.values()) {
                self.inner.ports.hold.release_page(page_id);
                self.inner.drop_page(page_id);
            }
        }
        self.inner.turn_note(thread, BrowserTurnOp::Forget, None, false).await;
    }
}
