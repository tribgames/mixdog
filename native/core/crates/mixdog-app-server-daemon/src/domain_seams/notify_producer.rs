use mixdog_rt::CancellationToken;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_connections::notifier::{AnswerWatch, AttachmentKind, FinalAnswers, Settled, TurnEnd, TurnFacts, WatchWake};
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::host::{HostCapability, HostChannel};
use mixdog_core_api::ids::Method;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_core_domains::notify::decision::{Conversation, DESKTOP_HOLD_MS, Event, Origin, SessionFields};
use mixdog_core_domains::notify::engine::{Audience, HostToast, NotificationEngine, PushApproval, PushRequest, PushSchedule, ThreadEvent};
use mixdog_core_domains::notify::service::{AudienceSource, PushSink};
use mixdog_core_session::session::approval_notification::allow_once_decision;
use mixdog_core_session::session::delegation::AgentNames;
use mixdog_protocol::ThreadSummary;
use mixdog_services::task_reports::chain::sessions_with_pending_work;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// The longest session title a notification carries (UTF-16 units, the last of them an ellipsis when cut).
const TITLE_UNITS: usize = 80;
const SHOW: Method = Method("host/notification/show");
/// The body of an error notification the phones read: this process has no UI language, so it is English.
const TURN_FAILED_PUSH_TEXT: &str = "The turn stopped with an error.";
/// The body of a question's push.
const QUESTION_PUSH_TEXT: &str = "에이전트가 질문했습니다";
const DEFAULT_TITLE: &str = "Mixdog";

/// Browser cards have a separate session-mark feed and must never enter actionable push production.
pub(crate) fn notification_card(req: &PendingServerRequest) -> Option<Value> {
    if req.method == ApprovalKind::Browser.method() {
        return None;
    }
    let frame: Value = serde_json::from_slice(&req.frame).ok()?;
    frame.pointer("/params/card").filter(|card| card.is_object()).cloned()
}

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
    Approval {
        session_id: String,
        approval: Option<Value>,
        replay: bool,
    },
    Goal {
        session_id: String,
        key: Option<String>,
    },
    HostAttached,
    /// The final-answer watcher's own timers and reads.
    Watch(WatchWake),
    /// The name of the bot a wait is told under was read (`None`: this PC's toast is not owed, the approval was told already).
    WaitNamed {
        tell: Box<WaitTell>,
        name: Option<String>,
    },
    /// The hold of the devices that wait for this PC to be idle ended.
    HoldDue {
        event: Box<ThreadEvent>,
        held: HashSet<String>,
        due: Delivery,
    },
}

/// What feeds the producer. Cloned freely; sending after the producer ended is a no-op.
#[derive(Clone)]
pub struct NotifierInput(mpsc::UnboundedSender<Msg>, Arc<Mutex<Option<Arc<GoalFollower>>>>);

#[async_trait]
trait GoalSnapshots: Send + Sync {
    async fn snapshot(&self, session: &str) -> Result<Option<Value>, String>;
}

#[async_trait]
impl GoalSnapshots for mixdog_core_goal::goal::GoalRuntime {
    async fn snapshot(&self, session: &str) -> Result<Option<Value>, String> {
        self.snapshot(session).await.map(|goal| goal.map(Value::Object)).map_err(|error| error.to_string())
    }
}

/// Subscribe first, then seed each catalog session. A changed or deleted session increments its
/// revision under the same lock as publication, so a slow snapshot can never overwrite it.
struct GoalFollower {
    source: Arc<dyn GoalSnapshots>,
    sender: mpsc::UnboundedSender<Msg>,
    revisions: Mutex<HashMap<String, (u64, bool)>>,
    stopped: CancellationToken,
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl GoalFollower {
    fn changed(&self, session: &str, goal: Option<&Value>) {
        let mut revisions = self.revisions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = revisions.entry(session.to_owned()).or_default();
        state.0 += 1;
        state.1 = true;
        let _ = self.sender.send(Msg::Goal { session_id: session.to_owned(), key: blocked_goal_key(goal) });
    }

    fn removed(&self, session: &str) {
        let mut revisions = self.revisions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = revisions.entry(session.to_owned()).or_default();
        state.0 += 1;
        state.1 = false;
    }

    fn observe(self: &Arc<Self>, session: &str) {
        let revision = {
            let mut revisions = self.revisions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let state = revisions.entry(session.to_owned()).or_default();
            if state.1 {
                return;
            }
            state.1 = true;
            state.0
        };
        let (this, session) = (self.clone(), session.to_owned());
        drop(tokio::spawn(async move {
            let snapshot = tokio::select! {
                biased;
                _ = this.stopped.cancelled() => return,
                snapshot = this.source.snapshot(&session) => snapshot,
            };
            let mut revisions = this.revisions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if revisions.get(&session) != Some(&(revision, true)) {
                return;
            }
            match snapshot {
                Ok(goal) => {
                    let _ = this.sender.send(Msg::Goal { session_id: session, key: blocked_goal_key(goal.as_ref()) });
                }
                Err(error) => {
                    // A later roster publication retries a transient read failure.
                    revisions.insert(session, (revision, false));
                    (this.log)(&format!("[mixdog-turn-notification] goal snapshot failed: {error}"));
                }
            }
        }));
    }
}

impl NotifierInput {
    /// A roster row as the catalog publishes it (every send of a thread row).
    pub fn row(&self, row: ThreadSummary) {
        let session = row.id.as_str().to_owned();
        let follower = self.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = self.0.send(Msg::Row(Box::new(row)));
        if let Some(follower) = follower.as_ref() {
            follower.observe(&session);
        }
    }

    /// A thread left the catalog.
    pub fn row_gone(&self, session_id: &str) {
        let follower = self.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(follower) = follower.as_ref() {
            follower.removed(session_id);
        }
        let _ = self.0.send(Msg::RowGone(session_id.to_owned()));
    }

    /// The whole agent pool.
    pub fn agent_pool(&self, rows: Vec<Value>) {
        let _ = self.0.send(Msg::Pool(rows));
    }

    pub fn session_state(&self, update: SessionWait) {
        let _ = self.0.send(Msg::State(Box::new(update)));
    }

    /// An approval source updates only its part of the session state; the blocked goal is preserved.
    pub fn approval_state(&self, session_id: &str, approval: Option<Value>, replay: bool) {
        let _ = self.0.send(Msg::Approval { session_id: session_id.to_owned(), approval, replay });
    }

    /// A goal source updates only its part of the session state; the shown approval is preserved.
    pub fn goal_state(&self, session_id: &str, key: Option<String>) {
        let _ = self.0.send(Msg::Goal { session_id: session_id.to_owned(), key });
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
    goal_subscription: Option<mixdog_core_goal::goal::Subscription>,
    goal_log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl SessionNotifier {
    /// Starts producing. Must be called inside a tokio runtime.
    pub fn start(env: ProducerEnv) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let goal_log = env.log.clone();
        let ctx = Arc::new(Ctx::new(env, tx.clone()));
        let notifier = Notifier::new(ctx);
        Self { task: tokio::spawn(notifier.run(rx)), input: NotifierInput(tx, Arc::default()), goal_subscription: None, goal_log }
    }

    /// Keep the goal listener for this producer's lifetime. Rebinding drops the former listener.
    pub fn follow_goals(&mut self, goals: Arc<mixdog_core_goal::goal::GoalRuntime>) {
        let follower = Arc::new(GoalFollower {
            source: goals.clone(),
            sender: self.input.0.clone(),
            revisions: Mutex::default(),
            stopped: CancellationToken::new(),
            log: self.goal_log.clone(),
        });
        let listener = follower.clone();
        self.goal_subscription = Some(goals.subscribe(move |event| {
            let goal = event.goal.clone().map(Value::Object);
            listener.changed(&event.session_id, goal.as_ref());
        }));
        let mut slot = self.input.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(previous) = slot.replace(follower) {
            previous.stopped.cancel();
        }
    }

    pub fn input(&self) -> NotifierInput {
        self.input.clone()
    }
}

impl Drop for SessionNotifier {
    fn drop(&mut self) {
        if let Some(follower) = self.input.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            follower.stopped.cancel();
        }
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

    fn facts(&self) -> TurnFacts {
        TurnFacts { working: self.working, lead_busy: self.lead_busy, silent: self.archived || self.agent_session }
    }

    /// The host's shared read cursor: a turn is unread while its messages run past it.
    fn unread(&self) -> bool {
        self.read_message_count < self.message_count
    }
}

// ---- which turns just finished

/// What a toast of a finished turn needs of its session.
struct Completion {
    session_id: String,
    title: String,
    agent_home: Option<String>,
    fields: SessionFields,
}

impl Completion {
    fn of(row: &Row) -> Self {
        Self { session_id: row.id.clone(), title: row.title.clone(), agent_home: row.agent_home.clone(), fields: row.fields.clone() }
    }
}

// ---- delivery

/// One occurrence of an event. Reusing a goal key or approval ID never revives an old delivery.
#[derive(Clone)]
struct Delivery {
    target: String,
    live: Arc<Mutex<bool>>,
    cancel: CancellationToken,
}

impl Delivery {
    fn new(target: String) -> Self {
        Self { target, live: Arc::new(Mutex::new(true)), cancel: CancellationToken::new() }
    }
    fn invalidate(&self) {
        *self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        self.cancel.cancel();
    }
    fn current(&self) -> bool {
        *self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    async fn run(&self, future: impl std::future::Future<Output = ()>) {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => {},
            _ = future => {},
        }
    }
    /// Serialize synchronous host sends / pending-toast insertion with invalidation.
    fn while_current<T>(&self, send: impl FnOnce() -> T) -> Option<T> {
        let live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *live { Some(send()) } else { None }
    }
}

/// One wait to tell: the approval of `origin`'s state. This PC's toast names the chat `target` it is answered in, and is
/// told once per approval (`announce`); a paired phone is told once per session that shows the approval, under that session.
struct WaitTell {
    origin: String,
    delivery: Delivery,
    target: String,
    key: String,
    wait: Wait,
    announce: bool,
    allow_once: bool,
    /// The origin session's own title and conversation: the phone's push is about it.
    origin_title: String,
    origin_fields: SessionFields,
    agent_home: Option<String>,
    fields: SessionFields,
}

/// Everything a delivery needs; shared by the task that decides and the tasks that tell.
struct Ctx {
    env: ProducerEnv,
    wake: mpsc::UnboundedSender<Msg>,
    pending_toasts: Mutex<HashMap<String, Delivery>>,
}

/// `turn-notification-<step> {details}`: the line of one step of a notification.
fn step_line(step: &str, details: &Value) -> String {
    format!("turn-notification-{step} {details}")
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
        Self { env, wake, pending_toasts: Mutex::default() }
    }

    fn enabled(&self) -> bool {
        (self.env.enabled)()
    }

    fn log(&self, detail: &str) {
        (self.env.log)(&format!("[mixdog-turn-notification] {detail}"));
    }

    /// One step of a notification, as the desktop's diagnostics log wrote it (`turn-notification-<step>`).
    fn step(&self, step: &str, details: Value) {
        self.log(&step_line(step, &details));
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
    async fn pushes(&self, event: &ThreadEvent, audience: &mut Audience, only: Option<&HashSet<String>>, due: &Delivery) -> HashSet<String> {
        if only.is_some() {
            audience.desktop_active = false;
        }
        let mut held = HashSet::new();
        if !due.current() {
            return held;
        }
        for request in self.env.engine.pushes_of(event, audience) {
            if only.is_some_and(|only| !only.contains(&request.device_id)) {
                continue;
            }
            match request.schedule {
                PushSchedule::Now => {
                    tokio::select! {
                        biased;
                        _ = due.cancel.cancelled() => return held,
                        _ = self.send_push(&request) => {}
                    }
                }
                PushSchedule::HoldUntil(_) => {
                    held.insert(request.device_id);
                }
            }
        }
        held
    }

    /// Tells `toast` (when there is one) to this PC's host and `push` to the paired phones, then holds the phones that wait for
    /// this PC to be idle.
    async fn tell(&self, toast: Option<&ThreadEvent>, push: ThreadEvent, due: Delivery) {
        if !self.enabled() {
            return;
        }
        let mut audience = self.env.audience.audience(&push.thread_id).await;
        if !due.current() || !self.enabled() {
            return;
        }
        if let Some(toast) = toast {
            // LiveAudience exposes zero or one synthetic host, backed by HostChannel's current
            // Notifications claimant (audience.rs); these are not independently addressable hosts.
            due.while_current(|| {
                let mut pending = self.pending_toasts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                let (shown, queued) = self.env.engine.toasts_with_queue(toast, &audience);
                if queued {
                    pending.insert(toast.thread_id.clone(), due.clone());
                } else if !shown.is_empty() {
                    pending.remove(&toast.thread_id);
                } else if let Some(reason) = self.env.engine.toast_refusal(toast, &audience) {
                    self.step("suppressed", json!({ "sessionId": toast.thread_id, "reason": reason.diagnostic() }));
                }
                drop(pending);
                for (_, shown) in shown {
                    self.show(&shown);
                }
            });
        }
        let held = self.pushes(&push, &mut audience, None, &due).await;
        if held.is_empty() {
            return;
        }
        tokio::select! {
            biased;
            _ = due.cancel.cancelled() => return,
            _ = mixdog_rt::time::sleep(Duration::from_millis(DESKTOP_HOLD_MS)) => {}
        }
        if due.current() {
            let _ = self.wake.send(Msg::HoldDue { event: Box::new(push), held, due });
        }
    }

    /// The second look at the devices that were held: they hear it now unless the turn was read or the wait was answered
    /// meanwhile (the notifier checked), and unless they show the thread themselves.
    async fn tell_held(&self, event: ThreadEvent, held: HashSet<String>, due: Delivery) {
        if !self.enabled() {
            return;
        }
        let mut audience = self.env.audience.audience(&event.thread_id).await;
        self.pushes(&event, &mut audience, Some(&held), &due).await;
    }

    /// A turn's answer: the toast in this PC's words and the push in English.
    async fn result(&self, completion: Completion, event: Event, text: String, due: Delivery) {
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
        let push =
            ThreadEvent { title: Self::push_title(&title), body_markdown: if failed { TURN_FAILED_PUSH_TEXT.to_owned() } else { text }, ..toast.clone() };
        self.tell(Some(&toast), push, due).await;
    }

    async fn wait(&self, tell: WaitTell, name: Option<String>) {
        if !self.enabled() {
            return;
        }
        let (event, approval) = match tell.wait {
            Wait::Approval => (Event::Approval, Some(PushApproval { id: tell.key.clone(), allow_once: tell.allow_once })),
            Wait::Question => (Event::Question, None),
        };
        let toast = match name {
            Some(name) => Some(ThreadEvent {
                thread_id: tell.target.clone(),
                event,
                approval: None,
                conversation: self.conversation(&tell.target, &tell.fields).await,
                title: format!("{name} · {}", self.env.texts.waiting(tell.wait)),
                body_markdown: String::new(),
                now_ms: (self.env.now_ms)(),
            }),
            None => None,
        };
        let push = ThreadEvent {
            thread_id: tell.origin.clone(),
            event,
            approval,
            conversation: self.conversation(&tell.origin, &tell.origin_fields).await,
            title: Self::push_title(if tell.origin_title.is_empty() { DEFAULT_TITLE } else { &tell.origin_title }),
            body_markdown: if tell.wait == Wait::Question { QUESTION_PUSH_TEXT.to_owned() } else { String::new() },
            now_ms: (self.env.now_ms)(),
        };
        self.tell(toast.as_ref(), push, tell.delivery).await;
    }

    /// A blocked goal waits for the user: a phone is told, this PC's window shows it itself.
    async fn goal(&self, session_id: String, row: Option<(String, SessionFields)>, due: Delivery) {
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
        self.tell(None, push, due).await;
    }
}

// ---- the producer

struct Notifier {
    ctx: Arc<Ctx>,
    /// The turns that ended and whose answers are read.
    watch: AnswerWatch<Completion>,
    rows: HashMap<String, Row>,
    pending_work: HashSet<String>,
    /// The approval each session's state shows now.
    waits: HashMap<String, String>,
    /// The approvals already told (or refused), for as long as some session shows them.
    told: HashSet<String>,
    /// The blocked goal each session's state shows now.
    goals: HashMap<String, String>,
    results_live: HashMap<String, Delivery>,
    waits_live: HashMap<String, Delivery>,
    goals_live: HashMap<String, Delivery>,
}

impl Drop for Notifier {
    fn drop(&mut self) {
        for delivery in self.results_live.values().chain(self.waits_live.values()).chain(self.goals_live.values()) {
            delivery.invalidate();
        }
    }
}

impl Notifier {
    fn new(ctx: Arc<Ctx>) -> Self {
        let watch = {
            let to_loop = ctx.wake.clone();
            let log = ctx.env.log.clone();
            AnswerWatch::new(
                ctx.env.answers.clone(),
                Arc::new(move |watched| {
                    let _ = to_loop.send(Msg::Watch(watched));
                }),
                ctx.env.enabled.clone(),
                Arc::new(move |step, _, details| log(&format!("[mixdog-turn-notification] {}", step_line(step, &details)))),
            )
        };
        Self {
            ctx,
            watch,
            rows: HashMap::new(),
            pending_work: HashSet::new(),
            waits: HashMap::new(),
            told: HashSet::new(),
            goals: HashMap::new(),
            results_live: HashMap::new(),
            waits_live: HashMap::new(),
            goals_live: HashMap::new(),
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
            Msg::Approval { session_id, approval, replay } => self.on_approval(&SessionWait { session_id, approval, replay, blocked_goal: None }),
            Msg::Goal { session_id, key } => {
                if !session_id.is_empty() {
                    self.on_goal(&session_id, key.as_deref());
                }
            }
            Msg::HostAttached => {
                let ready: Vec<_> = {
                    let mut pending = self.ctx.pending_toasts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    self.ctx
                        .env
                        .engine
                        .host_attached()
                        .into_iter()
                        .filter_map(|toast| pending.remove(&toast.thread_id).map(|delivery| (toast, delivery)))
                        .collect()
                };
                // Do not hold the queue lock while taking a delivery lock: tell takes them in the reverse order.
                for (toast, delivery) in ready {
                    delivery.while_current(|| self.ctx.show(&toast));
                }
            }
            Msg::Watch(wake) => {
                if let Some(settled) = self.watch.on_wake(wake) {
                    self.settled(settled);
                }
            }
            Msg::WaitNamed { tell, name } => {
                // Answered while the bot's name was read: nothing to tell.
                if self.ctx.enabled() && tell.delivery.current() && self.waits.get(&tell.origin) == Some(&tell.key) {
                    let ctx = self.ctx.clone();
                    drop(tokio::spawn(async move {
                        let delivery = tell.delivery.clone();
                        delivery.run(ctx.wait(*tell, name)).await;
                    }));
                }
            }
            Msg::HoldDue { event, held, due } => {
                if self.ctx.enabled()
                    && due.current()
                    && (!matches!(event.event, Event::Finished | Event::Error) || self.rows.get(&event.thread_id).is_some_and(Row::unread))
                {
                    let ctx = self.ctx.clone();
                    drop(tokio::spawn(async move {
                        let delivery = due.clone();
                        delivery.run(ctx.tell_held(*event, held, due)).await;
                    }));
                }
            }
        }
    }

    // -- the roster and final answers

    fn on_row(&mut self, summary: &ThreadSummary) {
        let row = Row::of(summary);
        if row.id.is_empty() {
            return;
        }
        // A read thread owes no toast that waited for a host.
        if !row.unread() || row.working || row.archived {
            if let Some(delivery) = self.results_live.remove(&row.id) {
                delivery.invalidate();
            }
            self.ctx.env.engine.thread_read(&row.id);
        }
        let now = self.now();
        let ended = self.watch.observe(&row.id, &row.facts(), now, &self.pending_work).map(|end| (end, Completion::of(&row)));
        self.rows.insert(row.id.clone(), row);
        self.after_observe(ended.into_iter().collect());
    }

    fn on_row_gone(&mut self, id: &str) {
        for deliveries in [&mut self.results_live, &mut self.waits_live, &mut self.goals_live] {
            deliveries.retain(|origin, delivery| {
                if origin == id || delivery.target == id {
                    delivery.invalidate();
                    false
                } else {
                    true
                }
            });
        }
        self.rows.remove(id);
        self.watch.forget(id);
        self.on_approval(&SessionWait { session_id: id.to_owned(), ..Default::default() });
        self.goals.remove(id);
        self.ctx.env.engine.thread_read(id);
        self.ctx.pending_toasts.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(id);
    }

    fn on_pool(&mut self, pool: &[Value]) {
        // Background work settling with no new Lead turn means the answer the Lead already gave was the final one.
        self.pending_work = sessions_with_pending_work(pool);
        let now = self.now();
        let Self { watch, rows, pending_work, .. } = self;
        let ended = rows.values().filter_map(|row| watch.observe(&row.id, &row.facts(), now, pending_work).map(|end| (end, Completion::of(row)))).collect();
        self.after_observe(ended);
    }

    fn after_observe(&mut self, ended: Vec<(TurnEnd, Completion)>) {
        let rows = &self.rows;
        self.watch.drop_stale(|id| rows.get(id).is_some_and(|row| !row.archived));
        for (end, completion) in ended {
            let id = completion.session_id.clone();
            self.watch.begin(&id, end, completion);
        }
    }

    /// A turn whose answer is ready: a failed one is an error notification, an answer is told by its text.
    fn settled(&mut self, settled: Settled<Completion>) {
        let Settled { session_id, detail: completion, failed, text } = settled;
        let event = if failed { Event::Error } else { Event::Finished };
        let due = Delivery::new(session_id.clone());
        if let Some(previous) = self.results_live.insert(session_id, due.clone()) {
            previous.invalidate();
        }
        let ctx = self.ctx.clone();
        drop(tokio::spawn(async move {
            let delivery = due.clone();
            delivery.run(ctx.result(completion, event, text, due)).await;
        }));
    }

    // -- waits: a session that STARTS waiting on a tool approval or a question needs the user

    fn on_state(&mut self, update: &SessionWait) {
        self.on_approval(update);
        if !update.replay && !update.session_id.is_empty() {
            self.on_goal(&update.session_id, update.blocked_goal.as_deref());
        }
    }

    // Approval and goal changes share this actor but never clear each other's state.
    fn on_approval(&mut self, update: &SessionWait) {
        let session_id = update.session_id.as_str();
        if session_id.is_empty() {
            return;
        }
        let key = update.approval.as_ref().map(approval_key).unwrap_or_default();
        let previous = (if key.is_empty() { self.waits.remove(session_id) } else { self.waits.insert(session_id.to_owned(), key.clone()) }).unwrap_or_default();
        if previous != key
            && let Some(delivery) = self.waits_live.remove(session_id)
        {
            delivery.invalidate();
        }
        // An approval no session shows any more is done with; its id is forgotten.
        if !previous.is_empty() && previous != key && !self.waits.values().any(|shown| *shown == previous) {
            self.told.remove(&previous);
        }
        if update.replay {
            return;
        }
        let Some(approval) = update.approval.as_ref().filter(|_| !key.is_empty()) else { return };
        // A session tells its own wait once; this PC's toast is once per approval, whichever session shows it first.
        if key == previous {
            return;
        }
        self.tell_wait(session_id, approval, key);
    }

    fn tell_wait(&mut self, session_id: &str, approval: &Value, key: String) {
        let announce = self.told.insert(key.clone());
        let wait = if approval.get("kind").and_then(Value::as_str) == Some("question") { Wait::Question } else { Wait::Approval };
        // A sub-agent's request is answered in the top-level chat it shows in.
        let target = approval.get("surfaceSessionId").and_then(Value::as_str).filter(|id| !id.is_empty()).unwrap_or(session_id).to_owned();
        let row = self.rows.get(&target);
        let origin_row = self.rows.get(session_id);
        let delivery = Delivery::new(target.clone());
        self.waits_live.insert(session_id.to_owned(), delivery.clone());
        let tell = WaitTell {
            origin: session_id.to_owned(),
            delivery,
            target: target.clone(),
            key,
            wait,
            announce,
            allow_once: wait == Wait::Approval && allow_once_decision(approval).is_some(),
            origin_title: origin_row.map(|row| row.push_title.clone()).unwrap_or_default(),
            origin_fields: origin_row.map(|row| row.fields.clone()).unwrap_or_default(),
            agent_home: row.and_then(|row| row.agent_home.clone()),
            fields: row.map(|row| row.fields.clone()).unwrap_or_default(),
        };
        let fallback = row.map_or_else(|| DEFAULT_TITLE.to_owned(), |row| row.title.clone());
        let ctx = self.ctx.clone();
        drop(tokio::spawn(async move {
            let delivery = tell.delivery.clone();
            delivery
                .run(async {
                    let name = if tell.announce {
                        Some(match ctx.bot_name(tell.agent_home.as_deref()).await {
                            Some(name) => name,
                            None => ctx.toast_title(&fallback),
                        })
                    } else {
                        None
                    };
                    let _ = ctx.wake.send(Msg::WaitNamed { tell: Box::new(tell), name });
                })
                .await;
        }));
    }

    /// One push per distinct blocked goal: the key is remembered until the goal clears.
    fn on_goal(&mut self, session_id: &str, key: Option<&str>) {
        let Some(key) = key.filter(|key| !key.is_empty()) else {
            self.goals.remove(session_id);
            if let Some(delivery) = self.goals_live.remove(session_id) {
                delivery.invalidate();
            }
            return;
        };
        if self.goals.get(session_id).map(String::as_str) == Some(key) {
            return;
        }
        self.goals.insert(session_id.to_owned(), key.to_owned());
        let due = Delivery::new(session_id.to_owned());
        if let Some(previous) = self.goals_live.insert(session_id.to_owned(), due.clone()) {
            previous.invalidate();
        }
        let row = self.rows.get(session_id).map(|row| (row.push_title.clone(), row.fields.clone()));
        let (ctx, session_id) = (self.ctx.clone(), session_id.to_owned());
        drop(tokio::spawn(async move {
            let delivery = due.clone();
            delivery.run(ctx.goal(session_id, row, due)).await;
        }));
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
