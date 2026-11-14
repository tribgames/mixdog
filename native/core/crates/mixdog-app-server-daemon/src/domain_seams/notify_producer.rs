//! The producer of this PC's own session notifications: a turn that finished or failed, an approval or a question that waits,
//! a goal that is blocked. It is the one that decides WHEN (the desktop's `desktop-turn-notifier.ts`, `final-answer-watcher.ts`
//! and `push-turn-events.ts`, and the phone side of `push-notifier.ts`); who hears it, and how, is the notification engine's
//! (`mixdog_core_domains::notify::engine`): the host toast (`host/notification/show`) and the relay push of each paired device.
//!
//! It reads what the session catalog publishes (one roster row at a time), the agent pool and the per-session approval state,
//! and never answers or sends anything to a session. The rules, in the order a notification meets them:
//! - A session's turn is finished when its roster row stops being busy (its own turn, a child agent it started, or the pool's
//!   pending work). An archived session and a sub-agent's session stay silent: only the Lead's own answer is news.
//! - The turn's recorded answer decides what is told, and is awaited, not guessed: a Lead that finished its own turn is read
//!   after `LEAD_FINISHED_MS` and again every `ANSWER_POLL_MS`; a session that went idle because its background work settled
//!   waits `STABILIZE_MS`, since the Lead may take their results into a new turn at once. A turn that resumes meanwhile, an
//!   answer by a reaction alone, a cancelled turn and a routine "nothing new" reply tell nothing; a failed turn is an error.
//! - One answer read is in flight at a time, each with `READ_DEADLINE`; a failed read is retried after `STABILIZE_MS`, doubling
//!   up to `READ_RETRY_MAX_MS`, and abandoned after `READ_FAILURE_LIMIT` failures; a session whose record is gone is not read again.
//! - A session that STARTS waiting on a tool approval or a question is told once per approval (the copies a hand-off or a
//!   sub-agent docks in other chats carry its id), as the chat it shows in. A replayed state is not a new wait.
//! - A paired phone is told the same events by its own preferences; one that holds while this PC is in use is told after
//!   `DESKTOP_HOLD_MS` if the turn is still unread or the wait still open.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_connections::notifier::{AnswerReadError, AttachmentKind, FinalAnswers};
use mixdog_connections::server_feed::{FinalAnswer, FinalAnswerStatus};
use mixdog_core_api::host::{HostCapability, HostChannel};
use mixdog_core_api::ids::Method;
use mixdog_core_domains::notify::decision::{Conversation, DESKTOP_HOLD_MS, Event, Origin, SessionFields};
use mixdog_core_domains::notify::engine::{
    Audience, HostToast, NotificationEngine, PushApproval, PushRequest, PushSchedule, ThreadEvent,
};
use mixdog_core_domains::notify::service::{AudienceSource, PushSink};
use mixdog_core_session::session::approval_notification::allow_once_decision;
use mixdog_core_session::session::delegation::AgentNames;
use mixdog_protocol::ThreadSummary;
use mixdog_services::bots::routine::is_routine_quiet_reply;
use mixdog_services::task_reports::chain::sessions_with_pending_work;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

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
/// The longest session title a notification carries (UTF-16 units, the last of them an ellipsis when cut).
const TITLE_UNITS: usize = 80;
const SHOW: Method = Method("host/notification/show");
/// The body of an error notification the phones read: this process has no UI language, so it is English.
const TURN_FAILED_PUSH_TEXT: &str = "The turn stopped with an error.";
/// The body of a question's push.
const QUESTION_PUSH_TEXT: &str = "에이전트가 질문했습니다";
const DEFAULT_TITLE: &str = "Mixdog";

/// What a session waits on: a tool approval, or an ask_user question.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    Approval,
    Question,
}

/// The fixed texts of a toast, in this PC's UI language at the moment it shows.
pub trait ProducerTexts: Send + Sync {
    /// The body of an error notification.
    fn turn_failed(&self) -> String;
    /// "{name} · …" of a wait notification.
    fn waiting(&self, wait: Wait) -> String;
    /// This PC's word for an attachment-only session title (`[Image]`, ...).
    fn attachment_label(&self, kind: AttachmentKind) -> String;
}

/// The agent that owns an unattended run of a session (`runOwnerOf`): the override of that bot reaches the session's notifications.
#[async_trait]
pub trait RunOwners: Send + Sync {
    async fn owner_of(&self, session_id: &str) -> Option<String>;
}

/// What the producer decides with and delivers through.
pub struct ProducerEnv {
    pub engine: Arc<NotificationEngine>,
    pub audience: Arc<dyn AudienceSource>,
    pub host: Arc<dyn HostChannel>,
    pub push: Arc<dyn PushSink>,
    pub answers: Arc<dyn FinalAnswers>,
    pub names: Arc<dyn AgentNames>,
    pub owners: Arc<dyn RunOwners>,
    pub texts: Arc<dyn ProducerTexts>,
    /// Off once the host is closing: nothing more is told.
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// `[mixdog-turn-notification] <detail>` in the daemon log.
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

/// One session's state update (the desktop's `DesktopSessionStateUpdate`): the approval it shows now and the goal it is blocked on.
#[derive(Clone, Debug, Default)]
pub struct SessionWait {
    pub session_id: String,
    /// The tool approval or question the session shows (`toolApproval`: `id`, `kind`, `surfaceSessionId`, ...).
    pub approval: Option<Value>,
    /// A blocked goal's identity (`<goal id>:blocked:<blocker>`).
    pub blocked_goal: Option<String>,
    /// The state was re-emitted retained state (`frameSource: 'replay'`), not a change.
    pub replay: bool,
}

enum Msg {
    Row(Box<ThreadSummary>),
    RowGone(String),
    Pool(Vec<Value>),
    State(Box<SessionWait>),
    HostAttached,
    /// The quiet period of a completion ended: read its answer.
    Deliver { session_id: String, generation: u64 },
    Read { session_id: String, generation: u64, result: Result<Option<FinalAnswer>, AnswerReadError> },
    /// The name of the bot a wait is told under was read.
    WaitNamed { tell: Box<WaitTell>, name: String },
    /// The hold of the devices that wait for this PC to be idle ended.
    HoldDue { event: Box<ThreadEvent>, held: HashSet<String>, due: Due },
}

/// What feeds the producer. Cloned freely; sending after the producer ended is a no-op.
#[derive(Clone)]
pub struct NotifierInput(mpsc::UnboundedSender<Msg>);

impl NotifierInput {
    /// A roster row as the catalog publishes it (every send of a thread row).
    pub fn row(&self, row: ThreadSummary) {
        let _ = self.0.send(Msg::Row(Box::new(row)));
    }

    /// A thread left the catalog.
    pub fn row_gone(&self, session_id: &str) {
        let _ = self.0.send(Msg::RowGone(session_id.to_owned()));
    }

    /// The whole agent pool.
    pub fn agent_pool(&self, rows: Vec<Value>) {
        let _ = self.0.send(Msg::Pool(rows));
    }

    pub fn session_state(&self, update: SessionWait) {
        let _ = self.0.send(Msg::State(Box::new(update)));
    }

    /// A desktop host attached: the toasts that waited for one are shown.
    pub fn host_attached(&self) {
        let _ = self.0.send(Msg::HostAttached);
    }
}

/// The running producer; dropping it stops it.
pub struct SessionNotifier {
    task: JoinHandle<()>,
    input: NotifierInput,
}

impl SessionNotifier {
    /// Starts producing. Must be called inside a tokio runtime.
    pub fn start(env: ProducerEnv) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(Ctx::new(env, tx.clone()));
        let notifier = Notifier::new(ctx);
        Self { task: tokio::spawn(notifier.run(rx)), input: NotifierInput(tx) }
    }

    pub fn input(&self) -> NotifierInput {
        self.input.clone()
    }
}

impl Drop for SessionNotifier {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// ---- rows

/// What the producer keeps of a roster row.
struct Row {
    id: String,
    /// A room's own name, else the session's title (a bot's home chat is renamed to its bot when told).
    title: String,
    /// `title || preview`: the title a phone's wait push carries.
    push_title: String,
    archived: bool,
    agent_session: bool,
    working: bool,
    lead_busy: bool,
    agent_home: Option<String>,
    fields: SessionFields,
    message_count: i64,
    read_message_count: i64,
}

fn clip_title(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if mixdog_js::utf16_len(&one_line) <= TITLE_UNITS {
        return one_line;
    }
    format!("{}…", mixdog_js::slice_utf16(&one_line, TITLE_UNITS - 1))
}

impl Row {
    fn of(summary: &ThreadSummary) -> Self {
        let room = |key: &str| summary.agent_room.as_ref().and_then(|room| room.get(key)).and_then(Value::as_str).map(str::to_owned);
        let origin = match summary.source_type.as_deref() {
            Some("schedule") => Some(Origin::Schedule),
            Some("webhook") => Some(Origin::Webhook),
            _ => None,
        };
        let title = [room("name").unwrap_or_default(), summary.title.clone(), summary.preview.clone()]
            .into_iter()
            .find(|text| !text.is_empty())
            .map(|text| clip_title(&text))
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| DEFAULT_TITLE.to_owned());
        Self {
            id: summary.id.as_str().to_owned(),
            title,
            push_title: [summary.title.clone(), summary.preview.clone()].into_iter().find(|text| !text.is_empty()).unwrap_or_default(),
            archived: summary.archived == Some(true),
            agent_session: summary.agent_session == Some(true),
            working: [summary.working, summary.lead_working, summary.agent_working].contains(&Some(true)),
            lead_busy: summary.lead_working.or(summary.working).unwrap_or(false),
            agent_home: summary.agent_home.clone().filter(|home| !home.is_empty()),
            fields: SessionFields {
                agent_home: summary.agent_home.clone(),
                agent_room_id: room("id"),
                task_agent: summary.task_agent.as_deref().is_some_and(|agent| !agent.is_empty()),
                agent_mode: summary.session_mode.as_deref() == Some("agent"),
                origin,
                run_owner: None,
            },
            message_count: summary.message_count,
            read_message_count: summary.read_message_count.unwrap_or(0),
        }
    }

    /// The host's shared read cursor: a turn is unread while its messages run past it.
    fn unread(&self) -> bool {
        self.read_message_count < self.message_count
    }
}

// ---- which turns just finished

struct Completion {
    session_id: String,
    title: String,
    agent_home: Option<String>,
    fields: SessionFields,
    /// The Lead's own turn ended in this roster push. False when the session went idle because its background agents settled:
    /// the Lead may take their results into a new turn at once.
    lead_finished: bool,
    started_at: i64,
}

#[derive(Default)]
struct Tracker {
    working: HashMap<String, bool>,
    lead_working: HashMap<String, bool>,
    started: HashMap<String, i64>,
}

impl Tracker {
    /// Feeds one roster row; the turn that just finished, if it did. `pending_work` names sessions whose Lead stopped only to
    /// wait for its own child agents: that is not the final answer.
    fn observe(&mut self, row: &Row, now: i64, pending_work: &HashSet<String>) -> Option<Completion> {
        let id = row.id.as_str();
        let busy = row.working || pending_work.contains(id);
        let was_busy = self.working.get(id) == Some(&true);
        let lead_was_busy = self.lead_working.get(id) == Some(&true);
        if (row.lead_busy && !lead_was_busy) || (busy && !self.started.contains_key(id)) {
            self.started.insert(id.to_owned(), now);
        }
        self.lead_working.insert(id.to_owned(), row.lead_busy);
        self.working.insert(id.to_owned(), busy);
        // Archived sessions are hidden from the app, and a sub-agent session reports back to its Lead: only the Lead's own
        // final answer is worth a notification.
        if !was_busy || busy || row.archived || row.agent_session {
            return None;
        }
        Some(Completion {
            session_id: id.to_owned(),
            title: row.title.clone(),
            agent_home: row.agent_home.clone(),
            fields: row.fields.clone(),
            lead_finished: lead_was_busy,
            started_at: self.started.get(id).copied().unwrap_or(now),
        })
    }

    fn forget(&mut self, id: &str) {
        self.working.remove(id);
        self.lead_working.remove(id);
        self.started.remove(id);
    }

    /// Still idle? Delivery waits out a quiet period and re-asks, so a turn that resumed immediately never notifies.
    fn is_idle(&self, id: &str) -> bool {
        self.working.get(id) == Some(&false)
    }
}

// ---- delivery

/// Whether a phone that was held still has to be told once the hold ended.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Due {
    /// The turn is unread.
    Unread(String),
    /// The approval or question is still open in `origin`'s state.
    Wait { origin: String, key: String },
    /// The goal is still blocked on the same thing.
    Goal { session: String, key: String },
}

/// One wait to tell: the approval of `origin`'s state, shown in the chat `target`.
struct WaitTell {
    origin: String,
    target: String,
    key: String,
    wait: Wait,
    allow_once: bool,
    row_title: String,
    agent_home: Option<String>,
    fields: SessionFields,
}

/// Everything a delivery needs; shared by the task that decides and the tasks that tell.
struct Ctx {
    env: ProducerEnv,
    wake: mpsc::UnboundedSender<Msg>,
}

fn placeholder_kind(title: &str) -> Option<AttachmentKind> {
    match title.trim().to_lowercase().as_str() {
        "[image]" => Some(AttachmentKind::Image),
        "[video]" => Some(AttachmentKind::Video),
        "[file]" => Some(AttachmentKind::File),
        _ => None,
    }
}

fn english_label(kind: AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "Image",
        AttachmentKind::Video => "Video",
        AttachmentKind::File => "File",
    }
}

impl Ctx {
    fn new(env: ProducerEnv, wake: mpsc::UnboundedSender<Msg>) -> Self {
        Self { env, wake }
    }

    fn enabled(&self) -> bool {
        (self.env.enabled)()
    }

    fn log(&self, detail: &str) {
        (self.env.log)(&format!("[mixdog-turn-notification] {detail}"));
    }

    /// A session title as people read it on this PC: the attachment placeholder in this PC's language.
    fn toast_title(&self, title: &str) -> String {
        placeholder_kind(title).map_or_else(|| title.to_owned(), |kind| self.env.texts.attachment_label(kind))
    }

    /// The same for a phone: this process has no UI language, so it is English.
    fn push_title(title: &str) -> String {
        placeholder_kind(title).map_or_else(|| title.to_owned(), |kind| english_label(kind).to_owned())
    }

    /// A bot's display name for its home chat; `None` when the chat is not a bot's or the bot has no name.
    async fn bot_name(&self, agent_home: Option<&str>) -> Option<String> {
        let name = self.env.names.name(agent_home?).await;
        (!name.is_empty()).then_some(name)
    }

    async fn conversation(&self, session_id: &str, fields: &SessionFields) -> Conversation {
        let run_owner = self.env.owners.owner_of(session_id).await.filter(|owner| !owner.is_empty());
        Conversation::of(session_id, &SessionFields { run_owner, ..fields.clone() })
    }

    fn show(&self, toast: &HostToast) {
        let sent = serde_json::to_value(toast)
            .map_err(|error| error.to_string())
            .and_then(|params| self.env.host.notify(HostCapability::Notifications, SHOW, params).map_err(|error| format!("{error:?}")));
        if let Err(error) = sent {
            self.log(&format!("failed {error}"));
        }
    }

    async fn send_push(&self, request: &PushRequest) {
        if let Err(detail) = self.env.push.push(request).await {
            (self.env.log)(&format!("[mixdog-remote-push] {detail}"));
        }
    }

    /// The pushes of `event` that are due now; the devices that hold while this PC is in use are returned. With `only`, just
    /// those devices are looked at, and this PC's activity is not asked again: they hear it now.
    async fn pushes(&self, event: &ThreadEvent, audience: &mut Audience, only: Option<&HashSet<String>>) -> HashSet<String> {
        if only.is_some() {
            audience.desktop_active = false;
        }
        let mut held = HashSet::new();
        for request in self.env.engine.pushes_of(event, audience) {
            if only.is_some_and(|only| !only.contains(&request.device_id)) {
                continue;
            }
            match request.schedule {
                PushSchedule::Now => self.send_push(&request).await,
                PushSchedule::HoldUntil(_) => {
                    held.insert(request.device_id);
                }
            }
        }
        held
    }

    /// Tells `toast` (when there is one) to this PC's host and `push` to the paired phones, then holds the phones that wait for
    /// this PC to be idle.
    async fn tell(&self, toast: Option<&ThreadEvent>, push: ThreadEvent, due: Due) {
        if !self.enabled() {
            return;
        }
        let mut audience = self.env.audience.audience(&push.thread_id).await;
        if let Some(toast) = toast {
            for (_, shown) in self.env.engine.toasts_of(toast, &audience) {
                self.show(&shown);
            }
        }
        let held = self.pushes(&push, &mut audience, None).await;
        if held.is_empty() {
            return;
        }
        mixdog_rt::time::sleep(Duration::from_millis(DESKTOP_HOLD_MS)).await;
        let _ = self.wake.send(Msg::HoldDue { event: Box::new(push), held, due });
    }

    /// The second look at the devices that were held: they hear it now unless the turn was read or the wait was answered
    /// meanwhile (the notifier checked), and unless they show the thread themselves.
    async fn tell_held(&self, event: ThreadEvent, held: HashSet<String>) {
        if !self.enabled() {
            return;
        }
        let mut audience = self.env.audience.audience(&event.thread_id).await;
        self.pushes(&event, &mut audience, Some(&held)).await;
    }

    /// A turn's answer: the toast in this PC's words and the push in English.
    async fn result(&self, completion: Completion, event: Event, text: String) {
        if !self.enabled() {
            return;
        }
        let title = self.bot_name(completion.agent_home.as_deref()).await.unwrap_or_else(|| completion.title.clone());
        let conversation = self.conversation(&completion.session_id, &completion.fields).await;
        let failed = event == Event::Error;
        let toast = ThreadEvent {
            thread_id: completion.session_id.clone(),
            event,
            approval: None,
            conversation,
            title: self.toast_title(&title),
            body_markdown: if failed { self.env.texts.turn_failed() } else { text.clone() },
            now_ms: (self.env.now_ms)(),
        };
        let push = ThreadEvent {
            title: Self::push_title(&title),
            body_markdown: if failed { TURN_FAILED_PUSH_TEXT.to_owned() } else { text },
            ..toast.clone()
        };
        self.tell(Some(&toast), push, Due::Unread(completion.session_id)).await;
    }

    async fn wait(&self, tell: WaitTell, name: String) {
        if !self.enabled() {
            return;
        }
        let conversation = self.conversation(&tell.target, &tell.fields).await;
        let (event, approval) = match tell.wait {
            Wait::Approval => (Event::Approval, Some(PushApproval { id: tell.key.clone(), allow_once: tell.allow_once })),
            Wait::Question => (Event::Question, None),
        };
        let toast = ThreadEvent {
            thread_id: tell.target.clone(),
            event,
            approval: None,
            conversation,
            title: format!("{name} · {}", self.env.texts.waiting(tell.wait)),
            body_markdown: String::new(),
            now_ms: (self.env.now_ms)(),
        };
        let push = ThreadEvent {
            title: Self::push_title(if tell.row_title.is_empty() { DEFAULT_TITLE } else { &tell.row_title }),
            body_markdown: if tell.wait == Wait::Question { QUESTION_PUSH_TEXT.to_owned() } else { String::new() },
            approval,
            ..toast.clone()
        };
        self.tell(Some(&toast), push, Due::Wait { origin: tell.origin, key: tell.key }).await;
    }

    /// A blocked goal waits for the user: a phone is told, this PC's window shows it itself.
    async fn goal(&self, session_id: String, key: String, row: Option<(String, SessionFields)>) {
        let (title, fields) = row.unwrap_or_default();
        let conversation = self.conversation(&session_id, &fields).await;
        let push = ThreadEvent {
            thread_id: session_id.clone(),
            event: Event::Question,
            approval: None,
            conversation,
            title: Self::push_title(if title.is_empty() { DEFAULT_TITLE } else { &title }),
            body_markdown: QUESTION_PUSH_TEXT.to_owned(),
            now_ms: (self.env.now_ms)(),
        };
        self.tell(None, push, Due::Goal { session: session_id, key }).await;
    }
}

// ---- the producer

struct Pending {
    generation: u64,
    completion: Completion,
    waiting_reported: bool,
    failures: u32,
}

struct Notifier {
    ctx: Arc<Ctx>,
    generation: u64,
    tracker: Tracker,
    rows: HashMap<String, Row>,
    pending_work: HashSet<String>,
    pending: HashMap<String, Pending>,
    queue: VecDeque<(String, u64)>,
    reading: bool,
    /// The approval each session's state shows now.
    waits: HashMap<String, String>,
    /// The approvals already told (or refused), for as long as some session shows them.
    told: HashSet<String>,
    /// The blocked goal each session's state shows now.
    goals: HashMap<String, String>,
}

impl Notifier {
    fn new(ctx: Arc<Ctx>) -> Self {
        Self {
            ctx,
            generation: 0,
            tracker: Tracker::default(),
            rows: HashMap::new(),
            pending_work: HashSet::new(),
            pending: HashMap::new(),
            queue: VecDeque::new(),
            reading: false,
            waits: HashMap::new(),
            told: HashSet::new(),
            goals: HashMap::new(),
        }
    }

    async fn run(mut self, mut inbox: mpsc::UnboundedReceiver<Msg>) {
        while let Some(msg) = inbox.recv().await {
            self.on_msg(msg);
        }
    }

    fn now(&self) -> i64 {
        (self.ctx.env.now_ms)()
    }

    fn on_msg(&mut self, msg: Msg) {
        match msg {
            Msg::Row(summary) => self.on_row(&summary),
            Msg::RowGone(id) => self.on_row_gone(&id),
            Msg::Pool(rows) => self.on_pool(&rows),
            Msg::State(update) => self.on_state(&update),
            Msg::HostAttached => {
                for toast in self.ctx.env.engine.host_attached() {
                    self.ctx.show(&toast);
                }
            }
            Msg::Deliver { session_id, generation } => self.on_deliver(session_id, generation),
            Msg::Read { session_id, generation, result } => {
                self.reading = false;
                self.settle_read(&session_id, generation, result);
                self.pump();
            }
            Msg::WaitNamed { tell, name } => {
                // Answered while the bot's name was read: nothing to tell.
                if self.ctx.enabled() && self.waits.get(&tell.origin) == Some(&tell.key) {
                    let ctx = self.ctx.clone();
                    drop(tokio::spawn(async move { ctx.wait(*tell, name).await }));
                }
            }
            Msg::HoldDue { event, held, due } => {
                if self.ctx.enabled() && self.is_due(&due) {
                    let ctx = self.ctx.clone();
                    drop(tokio::spawn(async move { ctx.tell_held(*event, held).await }));
                }
            }
        }
    }

    /// Whether the user still has to be told after the hold: the turn is unread, or the wait is still open.
    fn is_due(&self, due: &Due) -> bool {
        match due {
            Due::Unread(session) => self.rows.get(session).is_none_or(Row::unread),
            Due::Wait { origin, key } => self.waits.get(origin) == Some(key),
            Due::Goal { session, key } => self.goals.get(session) == Some(key),
        }
    }

    // -- the roster and final answers

    fn on_row(&mut self, summary: &ThreadSummary) {
        let row = Row::of(summary);
        if row.id.is_empty() {
            return;
        }
        // A read thread owes no toast that waited for a host.
        if !row.unread() {
            self.ctx.env.engine.thread_read(&row.id);
        }
        let now = self.now();
        let completion = self.tracker.observe(&row, now, &self.pending_work);
        self.rows.insert(row.id.clone(), row);
        self.after_observe(completion.into_iter().collect());
    }

    fn on_row_gone(&mut self, id: &str) {
        self.rows.remove(id);
        self.tracker.forget(id);
        self.pending.remove(id);
    }

    fn on_pool(&mut self, pool: &[Value]) {
        // Background work settling with no new Lead turn means the answer the Lead already gave was the final one.
        self.pending_work = sessions_with_pending_work(pool);
        let now = self.now();
        let Self { tracker, rows, pending_work, .. } = self;
        let completions = rows.values().filter_map(|row| tracker.observe(row, now, pending_work)).collect();
        self.after_observe(completions);
    }

    fn after_observe(&mut self, completions: Vec<Completion>) {
        let stale: Vec<String> = self
            .pending
            .keys()
            .filter(|id| !self.tracker.is_idle(id) || !self.rows.get(*id).is_some_and(|row| !row.archived))
            .cloned()
            .collect();
        for id in stale {
            tracing::debug!(session = %id, "final answer cancelled: state changed");
            self.pending.remove(&id);
        }
        for completion in completions {
            let id = completion.session_id.clone();
            let delay = if completion.lead_finished { LEAD_FINISHED_MS } else { STABILIZE_MS };
            self.generation += 1;
            let generation = self.generation;
            tracing::debug!(session = %id, "turn finished: detected");
            self.pending.insert(id.clone(), Pending { generation, completion, waiting_reported: false, failures: 0 });
            self.schedule(&id, generation, delay);
        }
    }

    fn current(&self, session_id: &str, generation: u64) -> bool {
        self.ctx.enabled()
            && self.pending.get(session_id).is_some_and(|entry| entry.generation == generation)
            && self.tracker.is_idle(session_id)
    }

    fn schedule(&self, session_id: &str, generation: u64, delay_ms: u64) {
        let wake = self.ctx.wake.clone();
        let session_id = session_id.to_owned();
        drop(tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = wake.send(Msg::Deliver { session_id, generation });
        }));
    }

    fn on_deliver(&mut self, session_id: String, generation: u64) {
        if !self.current(&session_id, generation) {
            if self.pending.get(&session_id).is_some_and(|entry| entry.generation == generation) {
                self.pending.remove(&session_id);
            }
            return;
        }
        self.queue.push_back((session_id, generation));
        self.pump();
    }

    /// At most one answer read in flight: a burst of completions queues behind it instead of piling reads onto the session store.
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
            let started_at = entry.completion.started_at;
            self.reading = true;
            let answers = self.ctx.env.answers.clone();
            let wake = self.ctx.wake.clone();
            drop(tokio::spawn(async move {
                let result = match mixdog_rt::time::timeout(READ_DEADLINE, answers.read(&session_id, started_at)).await {
                    Ok(result) => result,
                    Err(_) => Err(AnswerReadError::Failed(format!(
                        "final answer read timed out after {} ms",
                        READ_DEADLINE.as_millis()
                    ))),
                };
                let _ = wake.send(Msg::Read { session_id, generation, result });
            }));
        }
    }

    fn settle_read(&mut self, session_id: &str, generation: u64, result: Result<Option<FinalAnswer>, AnswerReadError>) {
        let answer = match result {
            Err(AnswerReadError::SessionMissing) => {
                // Terminal: the record is gone, so no retry can ever succeed.
                if self.pending.get(session_id).is_some_and(|entry| entry.generation == generation) {
                    tracing::debug!(session = session_id, "final answer cancelled: session missing");
                    self.pending.remove(session_id);
                }
                return;
            }
            Err(AnswerReadError::Failed(error)) => {
                self.ctx.log(&format!("read-failed {error}"));
                if !self.current(session_id, generation) {
                    return;
                }
                let Some(entry) = self.pending.get_mut(session_id) else { return };
                entry.failures += 1;
                if entry.failures >= READ_FAILURE_LIMIT {
                    tracing::debug!(session = session_id, "final answer cancelled: read kept failing");
                    self.pending.remove(session_id);
                    return;
                }
                let delay = (STABILIZE_MS << (entry.failures - 1)).min(READ_RETRY_MAX_MS);
                self.schedule(session_id, generation, delay);
                return;
            }
            Ok(answer) => answer,
        };
        // The read may cross a new turn, an archive or a restart: idleness alone cannot identify the turn that was asked.
        if !self.current(session_id, generation) {
            return;
        }
        let Some(entry) = self.pending.get_mut(session_id) else { return };
        entry.failures = 0;
        let started_at = entry.completion.started_at;
        // A turn answered by a reaction alone raises no notification.
        if answer.as_ref().is_some_and(|answer| answer.reacted && answer.at >= started_at) {
            self.pending.remove(session_id);
            tracing::debug!(session = session_id, "notification suppressed: reaction");
            return;
        }
        let ready = answer
            .filter(|answer| answer.at >= started_at && !(answer.status == FinalAnswerStatus::Done && answer.text.trim().is_empty()));
        let Some(answer) = ready else {
            if !entry.waiting_reported {
                tracing::debug!(session = session_id, "waiting for the turn's answer");
                entry.waiting_reported = true;
            }
            let delay = if entry.completion.lead_finished { ANSWER_POLL_MS } else { STABILIZE_MS };
            self.schedule(session_id, generation, delay);
            return;
        };
        let Some(Pending { completion, .. }) = self.pending.remove(session_id) else { return };
        // A turn the user cancelled is no news; one that failed is an error notification.
        let (event, text) = match answer.status {
            FinalAnswerStatus::Cancelled => {
                tracing::debug!(session = session_id, "notification suppressed: cancelled");
                return;
            }
            FinalAnswerStatus::Done if is_routine_quiet_reply(&answer.text) => {
                tracing::debug!(session = session_id, "notification suppressed: routine quiet");
                return;
            }
            FinalAnswerStatus::Failed => (Event::Error, String::new()),
            FinalAnswerStatus::Done => (Event::Finished, answer.text),
        };
        let ctx = self.ctx.clone();
        drop(tokio::spawn(async move { ctx.result(completion, event, text).await }));
    }

    // -- waits: a session that STARTS waiting on a tool approval or a question needs the user

    fn on_state(&mut self, update: &SessionWait) {
        let session_id = update.session_id.as_str();
        if session_id.is_empty() {
            return;
        }
        let key = update.approval.as_ref().map(approval_key).unwrap_or_default();
        let previous = (if key.is_empty() { self.waits.remove(session_id) } else { self.waits.insert(session_id.to_owned(), key.clone()) })
            .unwrap_or_default();
        // An approval no session shows any more is done with; its id is forgotten.
        if !previous.is_empty() && previous != key && !self.waits.values().any(|shown| *shown == previous) {
            self.told.remove(&previous);
        }
        if update.replay {
            return;
        }
        self.on_goal(session_id, update.blocked_goal.as_deref());
        let Some(approval) = update.approval.as_ref().filter(|_| !key.is_empty()) else { return };
        if self.told.contains(&key) || key == previous {
            return;
        }
        self.told.insert(key.clone());
        let wait = if approval.get("kind").and_then(Value::as_str) == Some("question") { Wait::Question } else { Wait::Approval };
        // A sub-agent's request is answered in the top-level chat it shows in.
        let target = approval.get("surfaceSessionId").and_then(Value::as_str).filter(|id| !id.is_empty()).unwrap_or(session_id).to_owned();
        let row = self.rows.get(&target);
        let tell = WaitTell {
            origin: session_id.to_owned(),
            target: target.clone(),
            key,
            wait,
            allow_once: wait == Wait::Approval && allow_once_decision(approval).is_some(),
            row_title: row.map(|row| row.push_title.clone()).unwrap_or_default(),
            agent_home: row.and_then(|row| row.agent_home.clone()),
            fields: row.map(|row| row.fields.clone()).unwrap_or_default(),
        };
        let fallback = row.map_or_else(|| DEFAULT_TITLE.to_owned(), |row| row.title.clone());
        let ctx = self.ctx.clone();
        drop(tokio::spawn(async move {
            let name = match ctx.bot_name(tell.agent_home.as_deref()).await {
                Some(name) => name,
                None => ctx.toast_title(&fallback),
            };
            let _ = ctx.wake.send(Msg::WaitNamed { tell: Box::new(tell), name });
        }));
    }

    /// One push per distinct blocked goal: the key is remembered until the goal clears.
    fn on_goal(&mut self, session_id: &str, key: Option<&str>) {
        let Some(key) = key.filter(|key| !key.is_empty()) else {
            self.goals.remove(session_id);
            return;
        };
        if self.goals.get(session_id).map(String::as_str) == Some(key) {
            return;
        }
        self.goals.insert(session_id.to_owned(), key.to_owned());
        let row = self.rows.get(session_id).map(|row| (row.push_title.clone(), row.fields.clone()));
        let (ctx, session_id, key) = (self.ctx.clone(), session_id.to_owned(), key.to_owned());
        drop(tokio::spawn(async move { ctx.goal(session_id, key, row).await }));
    }
}

/// The identity of the wait a session's goal puts on the user (push-notifier.ts `pendingInputKey`): `<goal id>:blocked:<blocker>`
/// for a blocked goal (`goal.id` absent: `goal`), `None` for no goal or one that is not blocked. The wiring sets
/// [`SessionWait::blocked_goal`] from the state snapshot's `goal` with it.
pub fn blocked_goal_key(goal: Option<&Value>) -> Option<String> {
    let goal = goal.filter(|goal| !goal.is_null())?;
    if goal.get("status").and_then(Value::as_str) != Some("blocked") {
        return None;
    }
    let text = |value: Option<&Value>, absent: &str| match value {
        None | Some(Value::Null) => absent.to_owned(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    Some(format!("{}:blocked:{}", text(goal.get("id"), "goal"), text(goal.get("blocker"), "")))
}

/// `String(approval.id ?? 'pending')`.
fn approval_key(approval: &Value) -> String {
    match approval.get("id") {
        None | Some(Value::Null) => "pending".to_owned(),
        Some(Value::String(id)) => id.clone(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

#[cfg(test)]
#[path = "notify_producer_tests.rs"]
mod tests;
