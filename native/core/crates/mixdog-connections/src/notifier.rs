//! OS notifications for a server window, raised on this PC: a session's final answer and a tool approval waiting, both labeled
//! with the server's name, and the link dropping or coming back while the window is in the background. Whether to notify is
//! this PC's notification preferences (`mixdog_core_domains::notify::decision`); the toast itself is `host/notification/show`
//! with the connection id, so a click brings that server's window (and session) to the front.
//!
//! The notifier reads the server's session list, agent pool and held approvals from the link's feed and the link's own view; it
//! never answers or sends anything to the server.

use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::HostNotificationShowParams;
use mixdog_app_server_client::api::RequestId;
use mixdog_core_domains::notify::decision::{
    Conversation, Decision, DecisionInput, Event, LocalClock, Origin, PreferencesView, SessionFields, allows_device_notice, decide,
};
use mixdog_core_domains::notify::engine::ToastStyle;
use mixdog_core_domains::notify::preview::notification_preview;
use mixdog_rt::CancellationToken;
use mixdog_services::bots::routine::is_routine_quiet_reply;
use mixdog_services::task_reports::chain::sessions_with_pending_work;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::link::ServerLink;
use crate::link_machine::{LinkState, LinkViewState};
use crate::server_feed::{AgentRowLite, ApprovalKind, FinalAnswer, FinalAnswerStatus, PendingApproval, SessionSummaryLite, is_session_missing};

/// A drop shorter than this is not worth a notification.
pub const LINK_LOST_NOTICE_DELAY_MS: u64 = 5_000;
/// A server names its sessions and supplies their previews: the OS gets bounded text, one line for the title.
pub const NOTIFICATION_TITLE_CHARS: usize = 120;
pub const NOTIFICATION_BODY_CHARS: usize = 240;
/// The server's name leads the title and stays whole up to this; the session title gives way.
const SERVER_LABEL_CHARS: usize = 40;
const SESSION_TITLE_CHARS: usize = 80;

/// Background agents settling can be followed at once by a new Lead turn that takes their results; waiting this long and
/// re-checking keeps that hand-off quiet.
pub const STABILIZE_MS: u64 = 2_500;
/// A Lead that finished its own turn is confirmed by the turn's recorded answer, not by waiting; the short delay lets the
/// transcript projection land.
pub const LEAD_FINISHED_MS: u64 = 300;
pub const ANSWER_POLL_MS: u64 = 500;
/// A failed answer read is retried after `STABILIZE_MS`, doubling up to this cap, and abandoned after `READ_FAILURE_LIMIT`
/// consecutive failures.
pub const READ_RETRY_MAX_MS: u64 = 60_000;
pub const READ_FAILURE_LIMIT: u32 = 6;
/// One answer read gets this long before it is counted as a transient failure, so a read that never settles cannot hold the
/// single read slot (and with it every notification) forever.
pub const READ_DEADLINE: Duration = Duration::from_secs(30);
/// Where a toast goes: this PC's desktop host (`host/notification/show`).
pub trait NotifySink: Send + Sync {
    /// Whether the OS can show toasts at all.
    fn supported(&self) -> bool;
    /// Shows a toast. `params.sound` is `Some` only for a toast that carries the PC's sound (a session's final answer): the sink
    /// gives that one this PC's sound and volume, and every other toast none.
    fn show(&self, params: HostNotificationShowParams) -> Result<(), String>;
    /// Closes the toasts still showing for the server (`host/notification/close`): its notifier ended.
    fn close(&self, connection_id: &str);
}

/// This PC's notification preferences and the conversation overrides, read at each delivery; a server's sessions follow them
/// like this PC's own.
pub trait NotifyPrefs: Send + Sync {
    /// The preferences now, or why they could not be read: nothing is decided then, and the item is offered again at its next event.
    fn view(&self) -> Result<PreferencesView, String>;
}

/// What the desktop host last reported in `host/state/set` key `windowFocus`.
pub trait WindowFocusSource: Send + Sync {
    /// The server's window is visible and focused.
    fn is_foreground(&self, connection_id: &str) -> bool;
    /// The server's focused window is showing this very session.
    fn session_on_screen(&self, connection_id: &str, session_id: &str) -> bool;
}

/// The placeholder a session titled by a message with attachments and no words carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachmentKind {
    Image,
    Video,
    File,
}

/// The fixed texts, in this PC's UI language at the moment they show.
pub trait NotifyTexts: Send + Sync {
    fn approval_waiting(&self) -> String;
    /// The body of an error notification.
    fn turn_failed(&self) -> String;
    /// `{{name}}` is replaced by the server's name.
    fn lost_title(&self) -> String;
    fn lost_reconnecting(&self) -> String;
    fn lost_stopped(&self) -> String;
    /// `{{name}}` is replaced by the server's name.
    fn restored_title(&self) -> String;
    fn restored_body(&self) -> String;
    /// This PC's word for an attachment-only session title (`[Image]`, ...).
    fn attachment_label(&self, kind: AttachmentKind) -> String;
}

/// Why the answer of a turn could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerReadError {
    /// The server has no such session any more: no later read can produce its answer.
    SessionMissing,
    Failed(String),
}

/// The server's record of a turn's answer.
#[async_trait]
pub trait FinalAnswers: Send + Sync {
    /// The answer of the turn that started at `started_at`; `Ok(None)` while it is pending.
    async fn read(&self, session_id: &str, started_at: i64) -> Result<Option<FinalAnswer>, AnswerReadError>;
}

struct LinkAnswers(Arc<ServerLink>);

#[async_trait]
impl FinalAnswers for LinkAnswers {
    async fn read(&self, session_id: &str, started_at: i64) -> Result<Option<FinalAnswer>, AnswerReadError> {
        let cancel = CancellationToken::new();
        match self.0.feed().read_final_answer_result(session_id, started_at, &cancel).await {
            Ok(answer) => Ok(answer),
            Err(error) if is_session_missing(&error) => Err(AnswerReadError::SessionMissing),
            Err(error) => Err(AnswerReadError::Failed(error.to_string())),
        }
    }
}

// the final-answer watcher: one implementation for this PC's session notifier and for a server's

/// What a roster row says about a session's turn.
pub struct TurnFacts {
    /// The session, one of its child agents or the pool's pending work is busy.
    pub working: bool,
    /// The Lead's own turn is running.
    pub lead_busy: bool,
    /// An archived session is hidden from the app, and a sub-agent's session reports back to its Lead: only the Lead's own
    /// final answer is worth a notification.
    pub silent: bool,
}

/// A turn that just ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TurnEnd {
    pub started_at: i64,
    /// The Lead's own turn ended in this roster push. False when the session went idle because its background agents settled:
    /// the Lead may take their results into a new turn at once.
    pub lead_finished: bool,
}

/// Which sessions are busy, and since when: the turn that just finished is the one whose busy state turned idle.
#[derive(Default)]
pub struct TurnTracker {
    working: HashMap<String, bool>,
    lead_working: HashMap<String, bool>,
    started: HashMap<String, i64>,
}

impl TurnTracker {
    /// Feeds one roster row; the turn that just finished, if it did. `pending_work` names sessions whose Lead stopped only to
    /// wait for its own child agents: that is not the final answer.
    pub fn observe(&mut self, id: &str, facts: &TurnFacts, now: i64, pending_work: &HashSet<String>) -> Option<TurnEnd> {
        let busy = facts.working || pending_work.contains(id);
        let was_busy = self.working.get(id) == Some(&true);
        let lead_was_busy = self.lead_working.get(id) == Some(&true);
        if (facts.lead_busy && !lead_was_busy) || (busy && !self.started.contains_key(id)) {
            self.started.insert(id.to_owned(), now);
        }
        self.lead_working.insert(id.to_owned(), facts.lead_busy);
        self.working.insert(id.to_owned(), busy);
        if !was_busy || busy || facts.silent {
            return None;
        }
        Some(TurnEnd { started_at: self.started.get(id).copied().unwrap_or(now), lead_finished: lead_was_busy })
    }

    pub fn forget(&mut self, id: &str) {
        self.working.remove(id);
        self.lead_working.remove(id);
        self.started.remove(id);
    }

    /// Forgets every session not in `present`: a roster is the complete list.
    pub fn retain(&mut self, present: &HashSet<String>) {
        self.working.retain(|id, _| present.contains(id));
        self.lead_working.retain(|id, _| present.contains(id));
        self.started.retain(|id, _| present.contains(id));
    }

    /// Still idle? Delivery waits out a quiet period and re-asks, so a turn that resumed immediately never notifies.
    pub fn is_idle(&self, id: &str) -> bool {
        self.working.get(id) == Some(&false)
    }
}

/// What the watcher asks of its owner's loop: delivered back to [`AnswerWatch::on_wake`].
pub enum WatchWake {
    /// The quiet period of a completion ended: read its answer.
    Deliver {
        session_id: String,
        generation: u64,
    },
    Read {
        session_id: String,
        generation: u64,
        result: Result<Option<FinalAnswer>, AnswerReadError>,
    },
}

/// A turn whose answer is ready to be told.
pub struct Settled<T> {
    pub session_id: String,
    pub detail: T,
    /// The turn failed: an error notification with no answer text.
    pub failed: bool,
    pub text: String,
}

struct Watch<T> {
    generation: u64,
    end: TurnEnd,
    detail: T,
    waiting_reported: bool,
    failures: u32,
}

/// The step-by-step account of a notification (`event`, `sessionId`, details): detected, cancelled, suppressed, waiting-answer,
/// read-failed.
pub type StepReport = Arc<dyn Fn(&str, &str, Value) + Send + Sync>;

/// Watches turns end and reads each one's recorded answer, which decides what is told: awaited, not guessed. At most one read
/// is in flight (a burst of completions queues behind it) and each has `READ_DEADLINE`; a failed read is retried with backoff
/// and abandoned after `READ_FAILURE_LIMIT` failures; a session whose record is gone is not read again. A turn that resumes
/// meanwhile, an answer by a reaction alone, a cancelled turn and a routine "nothing new" reply tell nothing.
pub struct AnswerWatch<T> {
    tracker: TurnTracker,
    pending: HashMap<String, Watch<T>>,
    queue: VecDeque<(String, u64)>,
    reading: bool,
    generation: u64,
    answers: Arc<dyn FinalAnswers>,
    wake: Arc<dyn Fn(WatchWake) + Send + Sync>,
    /// Off once the owner is closing: nothing more is read.
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    report: StepReport,
}

impl<T> AnswerWatch<T> {
    pub fn new(
        answers: Arc<dyn FinalAnswers>,
        wake: Arc<dyn Fn(WatchWake) + Send + Sync>,
        enabled: Arc<dyn Fn() -> bool + Send + Sync>,
        report: StepReport,
    ) -> Self {
        Self { tracker: TurnTracker::default(), pending: HashMap::new(), queue: VecDeque::new(), reading: false, generation: 0, answers, wake, enabled, report }
    }

    /// A fresh number for the owner's own timers: it never repeats one the watcher used.
    pub fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    pub fn observe(&mut self, id: &str, facts: &TurnFacts, now: i64, pending_work: &HashSet<String>) -> Option<TurnEnd> {
        self.tracker.observe(id, facts, now, pending_work)
    }

    pub fn retain_tracked(&mut self, present: &HashSet<String>) {
        self.tracker.retain(present);
    }

    pub fn is_idle(&self, id: &str) -> bool {
        self.tracker.is_idle(id)
    }

    /// The session left: nothing about it is read or told any more.
    pub fn forget(&mut self, id: &str) {
        self.tracker.forget(id);
        self.pending.remove(id);
    }

    /// Drops the pending turns whose session resumed or that `keep` no longer names.
    pub fn drop_stale(&mut self, keep: impl Fn(&str) -> bool) {
        let stale: Vec<String> = self.pending.keys().filter(|id| !self.tracker.is_idle(id) || !keep(id.as_str())).cloned().collect();
        for id in stale {
            (self.report)("cancelled", &id, json!({ "sessionId": id, "reason": "state-changed" }));
            self.pending.remove(&id);
        }
    }

    /// A turn ended: its answer is read after the quiet period.
    pub fn begin(&mut self, session_id: &str, end: TurnEnd, detail: T) {
        let generation = self.next_generation();
        (self.report)("detected", session_id, json!({ "sessionId": session_id }));
        let delay = if end.lead_finished { LEAD_FINISHED_MS } else { STABILIZE_MS };
        self.pending.insert(session_id.to_owned(), Watch { generation, end, detail, waiting_reported: false, failures: 0 });
        self.schedule(session_id, generation, delay);
    }

    pub fn on_wake(&mut self, wake: WatchWake) -> Option<Settled<T>> {
        match wake {
            WatchWake::Deliver { session_id, generation } => {
                if !self.current(&session_id, generation) {
                    if self.pending.get(&session_id).is_some_and(|entry| entry.generation == generation) {
                        self.pending.remove(&session_id);
                    }
                    return None;
                }
                self.queue.push_back((session_id, generation));
                self.pump();
                None
            }
            WatchWake::Read { session_id, generation, result } => {
                self.reading = false;
                let settled = self.settle(&session_id, generation, result);
                self.pump();
                settled
            }
        }
    }

    /// The turn `generation` of `session_id` is still the one watched, and the session is still idle.
    fn current(&self, session_id: &str, generation: u64) -> bool {
        (self.enabled)() && self.pending.get(session_id).is_some_and(|entry| entry.generation == generation) && self.tracker.is_idle(session_id)
    }

    fn schedule(&self, session_id: &str, generation: u64, delay_ms: u64) {
        let wake = self.wake.clone();
        let session_id = session_id.to_owned();
        drop(tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(delay_ms)).await;
            wake(WatchWake::Deliver { session_id, generation });
        }));
    }

    /// At most one answer read in flight: a burst of completions queues behind it instead of piling reads onto the store.
    fn pump(&mut self) {
        while !self.reading {
            let Some((session_id, generation)) = self.queue.pop_front() else { return };
            if !self.current(&session_id, generation) {
                if self.pending.get(&session_id).is_some_and(|entry| entry.generation == generation) {
                    self.pending.remove(&session_id);
                }
                continue;
            }
            let Some(entry) = self.pending.get(&session_id) else { continue };
            let started_at = entry.end.started_at;
            self.reading = true;
            let answers = self.answers.clone();
            let wake = self.wake.clone();
            drop(tokio::spawn(async move {
                let result = match mixdog_rt::time::timeout(READ_DEADLINE, answers.read(&session_id, started_at)).await {
                    Ok(result) => result,
                    Err(_) => Err(AnswerReadError::Failed(format!("final answer read timed out after {} ms", READ_DEADLINE.as_millis()))),
                };
                wake(WatchWake::Read { session_id, generation, result });
            }));
        }
    }

    fn settle(&mut self, session_id: &str, generation: u64, result: Result<Option<FinalAnswer>, AnswerReadError>) -> Option<Settled<T>> {
        let answer = match result {
            Err(AnswerReadError::SessionMissing) => {
                // Terminal: the record is gone, so no retry can ever succeed.
                if self.pending.get(session_id).is_some_and(|entry| entry.generation == generation) {
                    (self.report)("cancelled", session_id, json!({ "sessionId": session_id, "reason": "session-missing" }));
                    self.pending.remove(session_id);
                }
                return None;
            }
            Err(AnswerReadError::Failed(error)) => {
                (self.report)("read-failed", session_id, json!({ "sessionId": session_id, "error": error }));
                if !self.current(session_id, generation) {
                    return None;
                }
                let entry = self.pending.get_mut(session_id)?;
                entry.failures += 1;
                if entry.failures >= READ_FAILURE_LIMIT {
                    (self.report)("cancelled", session_id, json!({ "sessionId": session_id, "reason": "read-failed" }));
                    self.pending.remove(session_id);
                    return None;
                }
                let delay = (STABILIZE_MS << (entry.failures - 1)).min(READ_RETRY_MAX_MS);
                self.schedule(session_id, generation, delay);
                return None;
            }
            Ok(answer) => answer,
        };
        // The read may cross a new turn, an archive or a restart: idleness alone cannot identify the turn that was asked.
        if !self.current(session_id, generation) {
            return None;
        }
        let entry = self.pending.get_mut(session_id)?;
        entry.failures = 0;
        let started_at = entry.end.started_at;
        // A turn answered by a reaction alone raises no notification.
        if answer.as_ref().is_some_and(|answer| answer.reacted && answer.at >= started_at) {
            self.pending.remove(session_id);
            (self.report)("suppressed", session_id, json!({ "sessionId": session_id, "reason": "reaction" }));
            return None;
        }
        let ready = answer.filter(|answer| answer.at >= started_at && !(answer.status == FinalAnswerStatus::Done && answer.text.trim().is_empty()));
        let Some(answer) = ready else {
            if !entry.waiting_reported {
                entry.waiting_reported = true;
                (self.report)("waiting-answer", session_id, json!({ "sessionId": session_id }));
            }
            let delay = if entry.end.lead_finished { ANSWER_POLL_MS } else { STABILIZE_MS };
            self.schedule(session_id, generation, delay);
            return None;
        };
        let Watch { detail, .. } = self.pending.remove(session_id)?;
        // A turn the user cancelled is no news; one that failed is an error notification.
        let (failed, text) = match answer.status {
            FinalAnswerStatus::Cancelled => {
                (self.report)("suppressed", session_id, json!({ "sessionId": session_id, "reason": "cancelled" }));
                return None;
            }
            FinalAnswerStatus::Done if is_routine_quiet_reply(&answer.text) => {
                (self.report)("suppressed", session_id, json!({ "sessionId": session_id, "reason": "routine-quiet" }));
                return None;
            }
            FinalAnswerStatus::Failed => (true, String::new()),
            FinalAnswerStatus::Done => (false, answer.text),
        };
        Some(Settled { session_id: session_id.to_owned(), detail, failed, text })
    }
}

// a server's notifier

/// What the notifier shows and decides with.
pub struct NotifierEnv {
    pub connection_id: String,
    pub server_name: String,
    pub sink: Arc<dyn NotifySink>,
    pub prefs: Arc<dyn NotifyPrefs>,
    pub focus: Arc<dyn WindowFocusSource>,
    pub texts: Arc<dyn NotifyTexts>,
}

/// What the notifier reads.
pub struct NotifierSources {
    pub sessions: watch::Receiver<Vec<SessionSummaryLite>>,
    pub agent_pool: watch::Receiver<Vec<AgentRowLite>>,
    /// The approvals and questions the server holds (a thread's state does not carry them).
    pub approvals: watch::Receiver<Vec<PendingApproval>>,
    pub view: watch::Receiver<LinkViewState>,
    pub answers: Arc<dyn FinalAnswers>,
}

/// The running notifier of one link; dropping it stops it and closes the toasts of the server that are still showing.
pub struct ServerNotifier {
    task: JoinHandle<()>,
    sink: Arc<dyn NotifySink>,
    connection_id: String,
}

impl ServerNotifier {
    /// Starts notifying for `link`. Must be called inside a tokio runtime.
    pub fn attach(
        link: &Arc<ServerLink>,
        sink: Arc<dyn NotifySink>,
        prefs: Arc<dyn NotifyPrefs>,
        focus: Arc<dyn WindowFocusSource>,
        texts: Arc<dyn NotifyTexts>,
    ) -> ServerNotifier {
        let env = NotifierEnv { connection_id: link.id().to_owned(), server_name: link.name().to_owned(), sink, prefs, focus, texts };
        let sources = NotifierSources {
            sessions: link.feed().sessions(),
            agent_pool: link.feed().agent_pool(),
            approvals: link.feed().pending_approvals(),
            view: link.view(),
            answers: Arc::new(LinkAnswers(link.clone())),
        };
        Self::start(env, sources)
    }

    pub(crate) fn start(env: NotifierEnv, sources: NotifierSources) -> ServerNotifier {
        let (sink, connection_id) = (env.sink.clone(), env.connection_id.clone());
        ServerNotifier { task: tokio::spawn(run(env, sources)), sink, connection_id }
    }
}

impl Drop for ServerNotifier {
    fn drop(&mut self) {
        self.task.abort();
        self.sink.close(&self.connection_id);
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

/// `max` characters, the last of them an ellipsis when the text was cut.
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

/// The OS gets bounded text, one line for the title.
pub fn bounded_notification(title: &str, body: &str) -> (String, String) {
    let one_line = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (clip(&one_line, NOTIFICATION_TITLE_CHARS), clip(body.trim(), NOTIFICATION_BODY_CHARS))
}

fn named(template: &str, name: &str) -> String {
    template.replacen("{{name}}", name, 1)
}

/// What a server session's finished turn is told under.
struct Turn {
    conversation: Conversation,
    title: String,
}

/// A turn ready to be told: its answer was read.
struct Completion {
    session_id: String,
    conversation: Conversation,
    title: String,
    event: Event,
    preview: String,
}

fn row_working(row: &SessionSummaryLite) -> bool {
    [row.summary.working, row.summary.lead_working, row.summary.agent_working].contains(&Some(true))
}

fn conversation_of(row: &SessionSummaryLite) -> Conversation {
    let summary = &row.summary;
    let origin = match summary.source_type.as_deref() {
        Some("schedule") => Some(Origin::Schedule),
        Some("webhook") => Some(Origin::Webhook),
        _ => None,
    };
    let fields = SessionFields {
        agent_home: summary.agent_home.clone(),
        agent_room_id: summary.agent_room.as_ref().and_then(|room| room.get("id")).and_then(Value::as_str).map(str::to_owned),
        task_agent: summary.task_agent.as_deref().is_some_and(|agent| !agent.is_empty()),
        agent_mode: summary.session_mode.as_deref() == Some("agent"),
        origin,
        run_owner: None,
    };
    Conversation::of(&row.id, &fields)
}

/// A session's notification title: a room's own name, else its title.
fn notification_title_of(row: &SessionSummaryLite) -> String {
    let room = row.summary.agent_room.as_ref().and_then(|room| room.get("name")).and_then(Value::as_str).unwrap_or_default();
    let text = [room, &row.title, &row.preview].into_iter().find(|text| !text.is_empty()).unwrap_or("Mixdog");
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() { "Mixdog".to_owned() } else { clip(&one_line, SESSION_TITLE_CHARS) }
}

enum Wake {
    /// The final-answer watcher's own timers and reads.
    Watch(WatchWake),
    /// The link has been down long enough to tell.
    LinkLost(u64),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Connected,
    Reconnecting,
    Lost,
    Paused,
}

struct Notifier {
    env: NotifierEnv,
    wake: mpsc::UnboundedSender<Wake>,
    server_label: String,
    watch: AnswerWatch<Turn>,
    sessions: Vec<SessionSummaryLite>,
    pending_work: HashSet<String>,
    /// Completions whose answer was read but whose delivery could not be decided (the preferences were unreadable): offered again
    /// at the next roster or agent event.
    held: HashMap<String, Completion>,
    titles: HashMap<String, String>,
    conversations: HashMap<String, Conversation>,
    /// The approvals already told (or already showing when the notifier started), for as long as the server holds them: one the
    /// server no longer holds is forgotten, and told again if it comes back as a new request.
    told: VecDeque<RequestId>,
    /// The preferences could not be read at the last try: reported when reads start failing, not again until one succeeds.
    prefs_failing: Cell<bool>,
    lost_timer: Option<u64>,
    lost_shown: bool,
    previous: Status,
}

impl Notifier {
    fn label(&self, title: &str) -> String {
        format!("{} · {}", self.server_label, title)
    }

    /// A session title as people read it: the attachment placeholder in this PC's language.
    fn session_title_label(&self, title: &str) -> String {
        let kind = match title.trim().to_lowercase().as_str() {
            "[image]" => AttachmentKind::Image,
            "[video]" => AttachmentKind::Video,
            "[file]" => AttachmentKind::File,
            _ => return title.to_owned(),
        };
        self.env.texts.attachment_label(kind)
    }

    /// This PC's preferences, or `None` when they cannot be read.
    fn read_prefs(&self, what: &str) -> Option<PreferencesView> {
        match self.env.prefs.view() {
            Ok(view) => {
                self.prefs_failing.set(false);
                Some(view)
            }
            Err(error) => {
                if !self.prefs_failing.replace(true) {
                    tracing::warn!(connection = %self.env.connection_id, what, %error, "notification preferences could not be read");
                }
                None
            }
        }
    }

    /// `sound`: the toast carries this PC's sound (a session's final answer; nothing else sounds).
    fn show(&self, title: &str, body: &str, session_id: Option<&str>, sound: bool) {
        if !self.env.sink.supported() {
            return;
        }
        let (title, body) = bounded_notification(title, body);
        let params = HostNotificationShowParams {
            title,
            body,
            thread_id: session_id.map(Into::into),
            sound: sound.then(|| ToastStyle::SOUND.to_owned()),
            volume: None,
            connection_id: Some(self.env.connection_id.clone()),
            label: Some(self.server_label.clone()),
        };
        if let Err(error) = self.env.sink.show(params) {
            tracing::warn!(connection = %self.env.connection_id, %error, "server notification failed");
        }
    }

    /// Whether this PC's preferences, mutes, quiet hours and what is on screen let `event` of `conversation` through; `None` when
    /// the preferences could not be read, so nothing was decided.
    fn allowed(&self, session_id: &str, event: Event, conversation: &Conversation) -> Option<bool> {
        if !self.env.sink.supported() {
            return Some(false);
        }
        let view = self.read_prefs("session")?;
        let now = now_ms();
        let decision = decide(&DecisionInput {
            event,
            conversation,
            view: &view,
            now_ms: now,
            clock: LocalClock::at(now),
            foreground: self.env.focus.session_on_screen(&self.env.connection_id, session_id),
            desktop_active: false,
        });
        if let Decision::Skip(reason) = decision {
            tracing::debug!(connection = %self.env.connection_id, session = session_id, ?reason, "server notification suppressed");
        }
        Some(decision == Decision::Notify)
    }

    // -- sessions and final answers

    fn on_sessions(&mut self, sessions: Vec<SessionSummaryLite>) {
        // Each emission is the complete session list, so a session absent from it is gone: rebuild.
        self.titles.clear();
        self.conversations.clear();
        for session in &sessions {
            let title = [&session.title, &session.preview].into_iter().find(|text| !text.is_empty());
            self.titles.insert(session.id.clone(), title.cloned().unwrap_or_else(|| self.env.server_name.clone()));
            self.conversations.insert(session.id.clone(), conversation_of(session));
        }
        self.sessions = sessions;
        self.observe();
    }

    fn on_agent_pool(&mut self, agents: &[AgentRowLite]) {
        // Background work settling with no new Lead turn means the answer the Lead already gave was the final one.
        let rows: Vec<Value> = agents.iter().map(|agent| agent.row.clone()).collect();
        self.pending_work = sessions_with_pending_work(&rows);
        self.observe();
    }

    fn observe(&mut self) {
        let now = now_ms();
        let mut present = HashSet::new();
        let mut ended = Vec::new();
        for session in &self.sessions {
            if session.id.is_empty() {
                continue;
            }
            present.insert(session.id.clone());
            let facts = TurnFacts {
                working: row_working(session),
                lead_busy: session.summary.lead_working.or(session.summary.working).unwrap_or(false),
                silent: session.archived || session.agent_session,
            };
            if let Some(end) = self.watch.observe(&session.id, &facts, now, &self.pending_work) {
                ended.push((session.id.clone(), end, Turn { conversation: conversation_of(session), title: notification_title_of(session) }));
            }
        }
        self.watch.retain_tracked(&present);
        let sessions = &self.sessions;
        let listed = |id: &str| sessions.iter().any(|session| session.id == id && !session.archived);
        self.watch.drop_stale(listed);
        let stale: Vec<String> = self.held.keys().filter(|id| !self.watch.is_idle(id) || !listed(id.as_str())).cloned().collect();
        for id in stale {
            tracing::debug!(connection = %self.env.connection_id, session = %id, "final answer cancelled: state changed");
            self.held.remove(&id);
        }
        for (id, end, turn) in ended {
            self.held.remove(&id);
            self.watch.begin(&id, end, turn);
        }
        // This event is the next chance to decide what could not be decided.
        for (id, completion) in std::mem::take(&mut self.held) {
            self.offer(id, completion);
        }
    }

    /// A turn whose answer is ready: a failed one is an error notification, an answer is told by its preview.
    fn settled(&mut self, settled: Settled<Turn>) {
        let Settled { session_id, detail, failed, text } = settled;
        let completion = Completion {
            session_id: session_id.clone(),
            conversation: detail.conversation,
            title: detail.title,
            event: if failed { Event::Error } else { Event::Finished },
            preview: if failed { String::new() } else { notification_preview(&text) },
        };
        self.offer(session_id, completion);
    }

    /// Delivers a completion, or keeps it for the next event when the preferences could not be read.
    fn offer(&mut self, session_id: String, completion: Completion) {
        match self.allowed(&completion.session_id, completion.event, &completion.conversation) {
            None => {
                self.held.insert(session_id, completion);
            }
            Some(false) => {}
            Some(true) => {
                let failed = completion.event == Event::Error;
                let title = self.label(&self.session_title_label(&completion.title));
                let body = if failed { self.env.texts.turn_failed() } else { completion.preview.clone() };
                // A final answer, a failed one included, is the toast that sounds.
                self.show(&title, &body, Some(&completion.session_id), true);
            }
        }
    }

    // -- approvals: a session that STARTS waiting on a tool approval or a question needs the user

    /// `rows` is every request the server holds; a session shows the lowest `order` of its own. A request told is not told
    /// again while the server holds it; one it let go of is forgotten, and is told if it comes back as a new request. What
    /// the notifier found held (`baseline`, or a row marked a replay: the server held it again after a reconnect) is what the
    /// window already shows, and is not news. A request whose delivery could not be decided (the preferences were unreadable)
    /// is offered again at the next update. Browser and computer requests have their own dialogs, which tell them.
    fn on_approvals(&mut self, rows: &[PendingApproval], baseline: bool) {
        self.told.retain(|id| rows.iter().any(|row| &row.request_id == id));
        let mut heads: HashMap<&str, &PendingApproval> = HashMap::new();
        for row in rows.iter().filter(|row| matches!(row.kind, ApprovalKind::Tool | ApprovalKind::Question | ApprovalKind::Permissions)) {
            let head = heads.entry(row.session_id.as_str()).or_insert(row);
            if row.order < head.order {
                *head = row;
            }
        }
        let mut heads: Vec<&PendingApproval> = heads.into_values().filter(|head| !self.told.contains(&head.request_id)).collect();
        heads.sort_by_key(|head| head.order);
        for head in heads {
            if !baseline && !head.replay && self.tell_approval(head).is_none() {
                // Undecided: not told yet, so the next update decides again.
                continue;
            }
            self.told.push_back(head.request_id.clone());
        }
    }

    /// `None`: the preferences could not be read, nothing was decided.
    fn tell_approval(&self, approval: &PendingApproval) -> Option<()> {
        let session_id = approval.session_id.as_str();
        let event = if approval.kind == ApprovalKind::Question { Event::Question } else { Event::Approval };
        let conversation = self.conversations.get(session_id).cloned().unwrap_or_else(|| Conversation::of(session_id, &SessionFields::default()));
        if !self.allowed(session_id, event, &conversation)? {
            return Some(());
        }
        let name = self.titles.get(session_id).filter(|title| !title.is_empty()).unwrap_or(&self.env.server_name);
        let title = self.label(&self.session_title_label(name));
        self.show(&title, &self.env.texts.approval_waiting(), Some(session_id), false);
        Some(())
    }

    // -- the link: a drop that lasts, and the recovery after a drop that was told

    /// `None`: the preferences could not be read, nothing was decided.
    fn notice_allowed(&self) -> Option<bool> {
        if self.env.focus.is_foreground(&self.env.connection_id) {
            return Some(false);
        }
        let view = self.read_prefs("link")?;
        Some(allows_device_notice(&view.preferences, LocalClock::at(now_ms())))
    }

    fn on_link(&mut self, view: &LinkViewState) {
        let (status, terminal) = match &view.state {
            LinkState::Connected => (Status::Connected, false),
            LinkState::Reconnecting { .. } => (Status::Reconnecting, false),
            LinkState::Lost { terminal, .. } => (Status::Lost, *terminal),
            LinkState::Paused => (Status::Paused, false),
        };
        let was = std::mem::replace(&mut self.previous, status);
        if status == Status::Connected {
            self.lost_timer = None;
            if !self.lost_shown {
                return;
            }
            // Unreadable: the lost notice stays told, and the next link event decides again.
            let Some(allowed) = self.notice_allowed() else { return };
            self.lost_shown = false;
            if allowed {
                let title = named(&self.env.texts.restored_title(), &self.server_label);
                self.show(&title, &self.env.texts.restored_body(), None, false);
            }
            return;
        }
        // Sleep is not a loss, and a loss already told is not told again.
        if status == Status::Paused || was == Status::Paused || self.lost_shown || self.lost_timer.is_some() {
            return;
        }
        if terminal {
            self.raise_lost(true);
            return;
        }
        let generation = self.watch.next_generation();
        self.lost_timer = Some(generation);
        let wake = self.wake.clone();
        drop(tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(LINK_LOST_NOTICE_DELAY_MS)).await;
            let _ = wake.send(Wake::LinkLost(generation));
        }));
    }

    fn raise_lost(&mut self, terminal: bool) {
        self.lost_timer = None;
        if self.notice_allowed() != Some(true) {
            return;
        }
        self.lost_shown = true;
        let title = named(&self.env.texts.lost_title(), &self.server_label);
        let body = if terminal { self.env.texts.lost_stopped() } else { self.env.texts.lost_reconnecting() };
        self.show(&title, &body, None, false);
    }

    fn on_wake(&mut self, wake: Wake) {
        match wake {
            Wake::Watch(wake) => {
                if let Some(settled) = self.watch.on_wake(wake) {
                    self.settled(settled);
                }
            }
            Wake::LinkLost(generation) => {
                // Only a drop that may still recover waits; a terminal loss is told at once.
                if self.lost_timer == Some(generation) {
                    self.raise_lost(false);
                }
            }
        }
    }
}

async fn run(env: NotifierEnv, mut sources: NotifierSources) {
    let (wake, mut woken) = mpsc::unbounded_channel();
    let server_label = clip(&env.server_name, SERVER_LABEL_CHARS);
    let watch = {
        let to_loop = wake.clone();
        let connection = env.connection_id.clone();
        AnswerWatch::new(
            sources.answers.clone(),
            Arc::new(move |watched| {
                let _ = to_loop.send(Wake::Watch(watched));
            }),
            Arc::new(|| true),
            Arc::new(move |step, session, details| {
                tracing::info!(target: "turn-notification", connection = %connection, session, step, %details, "server notification step");
            }),
        )
    };
    let mut notifier = Notifier {
        env,
        wake,
        server_label,
        watch,
        sessions: Vec::new(),
        pending_work: HashSet::new(),
        held: HashMap::new(),
        titles: HashMap::new(),
        conversations: HashMap::new(),
        told: VecDeque::new(),
        prefs_failing: Cell::new(false),
        lost_timer: None,
        lost_shown: false,
        previous: Status::Connected,
    };
    let initial = sources.sessions.borrow_and_update().clone();
    notifier.on_sessions(initial);
    let pool = sources.agent_pool.borrow_and_update().clone();
    notifier.on_agent_pool(&pool);
    let held = sources.approvals.borrow_and_update().clone();
    notifier.on_approvals(&held, true);
    let view = sources.view.borrow_and_update().clone();
    notifier.on_link(&view);
    loop {
        tokio::select! {
            changed = sources.sessions.changed() => {
                if changed.is_err() {
                    return;
                }
                let sessions = sources.sessions.borrow_and_update().clone();
                notifier.on_sessions(sessions);
            }
            changed = sources.agent_pool.changed() => {
                if changed.is_err() {
                    return;
                }
                let pool = sources.agent_pool.borrow_and_update().clone();
                notifier.on_agent_pool(&pool);
            }
            changed = sources.view.changed() => {
                if changed.is_err() {
                    return;
                }
                let view = sources.view.borrow_and_update().clone();
                notifier.on_link(&view);
            }
            changed = sources.approvals.changed() => {
                if changed.is_err() {
                    return;
                }
                let held = sources.approvals.borrow_and_update().clone();
                notifier.on_approvals(&held, false);
            }
            Some(wake) = woken.recv() => notifier.on_wake(wake),
        }
    }
}

#[cfg(test)]
#[path = "notifier_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "notifier_watch_tests.rs"]
mod watch_tests;
