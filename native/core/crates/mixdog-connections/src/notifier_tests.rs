//! The notifier over fakes: the feed's streams are channels the test sends on, the toast sink records what it is given.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use mixdog_core_domains::notify::decision::{DevicePreferences, Scope};
use mixdog_protocol::ThreadSummary;
use serde_json::{json, Value};

use super::*;
use crate::link_machine::ModelLogin;

#[derive(Default)]
struct Sink {
    shown: Mutex<Vec<HostNotificationShowParams>>,
}

impl NotifySink for Sink {
    fn supported(&self) -> bool {
        true
    }
    fn show(&self, params: HostNotificationShowParams) -> Result<(), String> {
        self.shown.lock().unwrap().push(params);
        Ok(())
    }
}

struct Prefs(Mutex<PreferencesView>);

impl NotifyPrefs for Prefs {
    fn view(&self) -> PreferencesView {
        self.0.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct Focus {
    window: AtomicBool,
    session: Mutex<Option<String>>,
}

impl WindowFocusSource for Focus {
    fn is_foreground(&self, _connection_id: &str) -> bool {
        self.window.load(Ordering::SeqCst)
    }
    fn session_on_screen(&self, _connection_id: &str, session_id: &str) -> bool {
        self.window.load(Ordering::SeqCst) && self.session.lock().unwrap().as_deref() == Some(session_id)
    }
}

struct Texts;

impl NotifyTexts for Texts {
    fn approval_waiting(&self) -> String {
        "Waiting for your approval.".into()
    }
    fn turn_failed(&self) -> String {
        "The turn stopped with an error.".into()
    }
    fn lost_title(&self) -> String {
        "{{name}} disconnected".into()
    }
    fn lost_reconnecting(&self) -> String {
        "Reconnecting.".into()
    }
    fn lost_stopped(&self) -> String {
        "Stopped.".into()
    }
    fn restored_title(&self) -> String {
        "{{name}} is back".into()
    }
    fn restored_body(&self) -> String {
        "Connected again.".into()
    }
    fn attachment_label(&self, kind: AttachmentKind) -> String {
        match kind {
            AttachmentKind::Image => "Bild".into(),
            AttachmentKind::Video => "Video".into(),
            AttachmentKind::File => "Datei".into(),
        }
    }
}

/// The server's answers: one per session, `None` while pending; counts the reads.
#[derive(Default)]
struct Answers {
    by_session: Mutex<HashMap<String, Result<Option<FinalAnswer>, AnswerReadError>>>,
    reads: Mutex<Vec<String>>,
}

#[async_trait]
impl FinalAnswers for Answers {
    async fn read(&self, session_id: &str, _started_at: i64) -> Result<Option<FinalAnswer>, AnswerReadError> {
        self.reads.lock().unwrap().push(session_id.to_owned());
        self.by_session.lock().unwrap().get(session_id).cloned().unwrap_or(Ok(None))
    }
}

fn done(text: &str) -> FinalAnswer {
    FinalAnswer { id: json!("turn"), at: i64::MAX, status: FinalAnswerStatus::Done, text: text.into(), reacted: false }
}

struct Rig {
    sink: Arc<Sink>,
    prefs: Arc<Prefs>,
    focus: Arc<Focus>,
    answers: Arc<Answers>,
    sessions: watch::Sender<Vec<SessionSummaryLite>>,
    agent_pool: watch::Sender<Vec<AgentRowLite>>,
    states: broadcast::Sender<SessionStateChange>,
    view: watch::Sender<LinkViewState>,
    _notifier: ServerNotifier,
}

fn rig_named(name: &str) -> Rig {
    let sink = Arc::new(Sink::default());
    let prefs = Arc::new(Prefs(Mutex::new(PreferencesView { preferences: DevicePreferences::default(), overrides: Vec::new() })));
    let focus = Arc::new(Focus::default());
    let answers = Arc::new(Answers::default());
    let (sessions, sessions_rx) = watch::channel(Vec::new());
    let (agent_pool, pool_rx) = watch::channel(Vec::new());
    let (states, states_rx) = broadcast::channel(16);
    let (view, view_rx) = watch::channel(link(LinkState::Connected));
    let env = NotifierEnv {
        connection_id: "srv".into(),
        server_name: name.into(),
        sink: sink.clone(),
        prefs: prefs.clone(),
        focus: focus.clone(),
        texts: Arc::new(Texts),
    };
    let notifier = ServerNotifier::start(
        env,
        NotifierSources { sessions: sessions_rx, agent_pool: pool_rx, states: states_rx, view: view_rx, answers: answers.clone() },
    );
    Rig { sink, prefs, focus, answers, sessions, agent_pool, states, view, _notifier: notifier }
}

fn rig() -> Rig {
    rig_named("Build box")
}

impl Rig {
    fn shown(&self) -> Vec<HostNotificationShowParams> {
        self.sink.shown.lock().unwrap().clone()
    }
}

fn link(state: LinkState) -> LinkViewState {
    LinkViewState { connection_id: "srv".into(), state, rtt_ms: None, terminals_available: true, model_login: ModelLogin::Pc }
}

fn lost(terminal: bool) -> LinkState {
    LinkState::Lost { terminal, code: "c".into(), message: "m".into(), settings_required: false }
}

fn reconnecting() -> LinkState {
    LinkState::Reconnecting { attempt: 1, next_retry_at_ms: None, countdown_ms: None }
}

fn row_with(id: &str, title: &str, working: bool, extra: Value) -> SessionSummaryLite {
    let mut fields = json!({
        "id": id, "preview": "", "title": title, "updatedAt": 0, "messageCount": 0, "cwd": "", "classification": null,
        "projectPath": null, "working": working
    });
    fields.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let summary: ThreadSummary = serde_json::from_value(fields).unwrap();
    SessionSummaryLite {
        id: id.into(),
        title: title.into(),
        preview: summary.preview.clone(),
        running: working,
        updated_at: 0,
        activity_at: 0,
        message_count: 0,
        archived: false,
        agent_session: false,
        awaiting_approval: false,
        awaiting_question: false,
        agent_home: None,
        summary,
    }
}

fn row(id: &str, title: &str, working: bool) -> SessionSummaryLite {
    row_with(id, title, working, json!({}))
}

fn approval(id: &str, key: &str, kind: &str) -> SessionStateChange {
    SessionStateChange {
        session_id: id.into(),
        state: SessionRunState::Running,
        started_at: None,
        snapshot: json!({ "busy": true, "toolApproval": { "id": key, "kind": kind } }),
    }
}

fn no_approval(id: &str) -> SessionStateChange {
    SessionStateChange { session_id: id.into(), state: SessionRunState::Running, started_at: None, snapshot: json!({ "busy": true }) }
}

async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    settle().await;
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

/// A baseline roster, then the turn of `id` ends.
async fn finish_turn(rig: &Rig, id: &str, title: &str) {
    rig.sessions.send(vec![row(id, title, true)]).unwrap();
    settle().await;
    rig.sessions.send(vec![row(id, title, false)]).unwrap();
    settle().await;
}

#[tokio::test(start_paused = true)]
async fn final_answer_once() {
    let rig = rig();
    rig.answers.by_session.lock().unwrap().insert("a".into(), Ok(Some(done("**Done** with the fix."))));
    finish_turn(&rig, "a", "Fix the build").await;
    advance(LEAD_FINISHED_MS + 50).await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "Build box · Fix the build");
    assert_eq!(shown[0].body, "Done with the fix.");
    assert_eq!(shown[0].thread_id.as_ref().map(|id| id.as_str()), Some("a"));
    assert_eq!(shown[0].connection_id.as_deref(), Some("srv"));
    assert_eq!(shown[0].label.as_deref(), Some("Build box"));
    // The same roster again, and a later idle one, tell nothing more.
    rig.sessions.send(vec![row("a", "Fix the build", false)]).unwrap();
    advance(STABILIZE_MS * 2).await;
    assert_eq!(rig.shown().len(), 1);
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn the_first_roster_is_a_baseline() {
    let rig = rig();
    rig.sessions.send(vec![row("a", "Idle one", false)]).unwrap();
    advance(STABILIZE_MS * 2).await;
    assert!(rig.shown().is_empty());
    assert!(rig.answers.reads.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_pending_answer_is_polled_until_it_lands() {
    let rig = rig();
    finish_turn(&rig, "a", "Slow").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.shown().is_empty());
    rig.answers.by_session.lock().unwrap().insert("a".into(), Ok(Some(done("Finished."))));
    advance(ANSWER_POLL_MS + 50).await;
    assert_eq!(rig.shown().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_turn_a_reaction_and_a_quiet_reply_tell_nothing() {
    let rig = rig();
    let mut cancelled = done("");
    cancelled.status = FinalAnswerStatus::Cancelled;
    let mut reacted = done("");
    reacted.reacted = true;
    rig.answers.by_session.lock().unwrap().insert("c".into(), Ok(Some(cancelled)));
    rig.answers.by_session.lock().unwrap().insert("r".into(), Ok(Some(reacted)));
    rig.answers.by_session.lock().unwrap().insert("q".into(), Ok(Some(done("  ROUTINE_QUIET "))));
    let all = |working| vec![row("c", "C", working), row("r", "R", working), row("q", "Q", working)];
    rig.sessions.send(all(true)).unwrap();
    settle().await;
    rig.sessions.send(all(false)).unwrap();
    advance(LEAD_FINISHED_MS + 50).await;
    advance(ANSWER_POLL_MS * 4).await;
    assert!(rig.shown().is_empty());
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn a_failed_turn_is_an_error_notification_when_errors_are_on() {
    let rig = rig();
    {
        let mut view = rig.prefs.0.lock().unwrap();
        view.preferences.events.error = true;
    }
    let mut failed = done("");
    failed.status = FinalAnswerStatus::Failed;
    rig.answers.by_session.lock().unwrap().insert("a".into(), Ok(Some(failed)));
    finish_turn(&rig, "a", "Broken").await;
    advance(LEAD_FINISHED_MS + 50).await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].body, "The turn stopped with an error.");
}

#[tokio::test(start_paused = true)]
async fn a_session_that_resumes_before_the_answer_is_read_tells_nothing() {
    let rig = rig();
    rig.answers.by_session.lock().unwrap().insert("a".into(), Ok(Some(done("Done."))));
    finish_turn(&rig, "a", "Back again").await;
    rig.sessions.send(vec![row("a", "Back again", true)]).unwrap();
    advance(STABILIZE_MS).await;
    assert!(rig.shown().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_lead_waiting_on_its_agents_has_not_answered() {
    let rig = rig();
    rig.answers.by_session.lock().unwrap().insert("lead".into(), Ok(Some(done("Done."))));
    let agent = |status: &str| AgentRowLite {
        tag: "t".into(),
        session_id: "worker".into(),
        owner_session_id: Some("lead".into()),
        parent_session_id: None,
        title: None,
        status: status.into(),
        stage: String::new(),
        released: false,
        row: json!({}),
    };
    rig.agent_pool.send(vec![agent("running")]).unwrap();
    settle().await;
    rig.sessions.send(vec![row("lead", "Lead", true)]).unwrap();
    settle().await;
    rig.sessions.send(vec![row("lead", "Lead", false)]).unwrap();
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.shown().is_empty());
    // The agent settles: the Lead's last answer was the final one.
    rig.agent_pool.send(vec![agent("done")]).unwrap();
    advance(STABILIZE_MS + 50).await;
    assert_eq!(rig.shown().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn read_failures_back_off_and_end() {
    let rig = rig();
    rig.answers.by_session.lock().unwrap().insert("a".into(), Err(AnswerReadError::Failed("boom".into())));
    finish_turn(&rig, "a", "Flaky").await;
    advance(LEAD_FINISHED_MS + 50).await;
    for step in 0..READ_FAILURE_LIMIT - 1 {
        advance((STABILIZE_MS << step).min(READ_RETRY_MAX_MS) + 50).await;
    }
    assert_eq!(rig.answers.reads.lock().unwrap().len(), READ_FAILURE_LIMIT as usize);
    advance(READ_RETRY_MAX_MS * 2).await;
    assert_eq!(rig.answers.reads.lock().unwrap().len(), READ_FAILURE_LIMIT as usize);
    assert!(rig.shown().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_missing_session_is_not_read_again() {
    let rig = rig();
    rig.answers.by_session.lock().unwrap().insert("a".into(), Err(AnswerReadError::SessionMissing));
    finish_turn(&rig, "a", "Gone").await;
    advance(LEAD_FINISHED_MS + 50).await;
    advance(STABILIZE_MS * 4).await;
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn approval_start_only() {
    let rig = rig();
    rig.sessions.send(vec![row("a", "Deploy", true)]).unwrap();
    settle().await;
    rig.states.send(approval("a", "ap1", "tool")).unwrap();
    settle().await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "Build box · Deploy");
    assert_eq!(shown[0].body, "Waiting for your approval.");
    // The same approval again is not told; a new one is; one after it was answered is.
    rig.states.send(approval("a", "ap1", "tool")).unwrap();
    settle().await;
    assert_eq!(rig.shown().len(), 1);
    rig.states.send(approval("a", "ap2", "question")).unwrap();
    settle().await;
    assert_eq!(rig.shown().len(), 2);
    rig.states.send(no_approval("a")).unwrap();
    rig.states.send(approval("a", "ap2", "question")).unwrap();
    settle().await;
    assert_eq!(rig.shown().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn an_approval_without_an_id_uses_one_key() {
    let rig = rig();
    let waiting = SessionStateChange {
        session_id: "a".into(),
        state: SessionRunState::Running,
        started_at: None,
        snapshot: json!({ "toolApproval": { "kind": "tool" } }),
    };
    rig.states.send(waiting.clone()).unwrap();
    rig.states.send(waiting).unwrap();
    settle().await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    // A session the roster does not know is titled by the server.
    assert_eq!(shown[0].title, "Build box · Build box");
}

#[tokio::test(start_paused = true)]
async fn foreground_suppresses() {
    let rig = rig();
    rig.sessions.send(vec![row("a", "Deploy", true)]).unwrap();
    settle().await;
    // The window shows this very session: no approval toast, no final answer.
    rig.focus.window.store(true, Ordering::SeqCst);
    *rig.focus.session.lock().unwrap() = Some("a".into());
    rig.states.send(approval("a", "ap1", "tool")).unwrap();
    rig.answers.by_session.lock().unwrap().insert("a".into(), Ok(Some(done("Done."))));
    rig.sessions.send(vec![row("a", "Deploy", false)]).unwrap();
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.shown().is_empty());
    // A focused window on another session does not hold it back.
    *rig.focus.session.lock().unwrap() = Some("b".into());
    rig.states.send(approval("a", "ap2", "tool")).unwrap();
    settle().await;
    assert_eq!(rig.shown().len(), 1);
    // The link notices are held back by a focused window of any session.
    rig.view.send(link(lost(true))).unwrap();
    settle().await;
    assert_eq!(rig.shown().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn this_pcs_preferences_decide() {
    let rig = rig();
    rig.prefs.0.lock().unwrap().preferences.scope = Scope::Off;
    rig.sessions.send(vec![row("a", "Deploy", true)]).unwrap();
    settle().await;
    rig.states.send(approval("a", "ap1", "tool")).unwrap();
    settle().await;
    assert!(rig.shown().is_empty());
}

#[tokio::test(start_paused = true)]
async fn link_lost_after_5s() {
    let rig = rig();
    rig.view.send(link(reconnecting())).unwrap();
    advance(LINK_LOST_NOTICE_DELAY_MS - 100).await;
    assert!(rig.shown().is_empty());
    advance(200).await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title, "Build box disconnected");
    assert_eq!(shown[0].body, "Reconnecting.");
    assert_eq!(shown[0].connection_id.as_deref(), Some("srv"));
    assert!(shown[0].thread_id.is_none());
    // A loss already told is not told again, and its recovery is.
    rig.view.send(link(lost(false))).unwrap();
    advance(LINK_LOST_NOTICE_DELAY_MS * 2).await;
    assert_eq!(rig.shown().len(), 1);
    rig.view.send(link(LinkState::Connected)).unwrap();
    settle().await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 2);
    assert_eq!(shown[1].title, "Build box is back");
    assert_eq!(shown[1].body, "Connected again.");
}

#[tokio::test(start_paused = true)]
async fn a_short_drop_and_a_sleep_tell_nothing() {
    let rig = rig();
    rig.view.send(link(reconnecting())).unwrap();
    advance(1_000).await;
    rig.view.send(link(LinkState::Connected)).unwrap();
    advance(LINK_LOST_NOTICE_DELAY_MS * 2).await;
    assert!(rig.shown().is_empty());
    rig.view.send(link(LinkState::Paused)).unwrap();
    advance(100).await;
    rig.view.send(link(reconnecting())).unwrap();
    advance(LINK_LOST_NOTICE_DELAY_MS * 2).await;
    rig.view.send(link(LinkState::Connected)).unwrap();
    settle().await;
    assert!(rig.shown().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_terminal_loss_is_told_at_once() {
    let rig = rig();
    rig.view.send(link(lost(true))).unwrap();
    settle().await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].body, "Stopped.");
}

#[tokio::test(start_paused = true)]
async fn labels_bounded() {
    let long_name = "n".repeat(100);
    let rig = rig_named(&long_name);
    let title = format!("first line\n   second\tline {}", "t".repeat(300));
    rig.answers.by_session.lock().unwrap().insert("a".into(), Ok(Some(done(&"w ".repeat(400)))));
    finish_turn(&rig, "a", &title).await;
    advance(LEAD_FINISHED_MS + 50).await;
    let shown = rig.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].title.chars().count(), NOTIFICATION_TITLE_CHARS);
    assert!(shown[0].title.ends_with('…'));
    assert!(!shown[0].title.contains('\n'));
    assert!(shown[0].title.starts_with(&format!("{}… · first line second line", "n".repeat(SERVER_LABEL_CHARS - 1))));
    assert!(shown[0].body.chars().count() <= NOTIFICATION_BODY_CHARS);
    assert_eq!(shown[0].label.as_deref().map(|label| label.chars().count()), Some(SERVER_LABEL_CHARS));
}

#[test]
fn bounded_notification_clips_by_characters() {
    let (title, body) = bounded_notification(&"é".repeat(130), &format!("  {}  ", "ü".repeat(250)));
    assert_eq!(title.chars().count(), NOTIFICATION_TITLE_CHARS);
    assert_eq!(body.chars().count(), NOTIFICATION_BODY_CHARS);
    assert_eq!(bounded_notification("short", " body "), ("short".to_owned(), "body".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn an_attachment_only_title_is_shown_in_this_pcs_language() {
    let rig = rig();
    rig.sessions.send(vec![row("a", "[Image]", true)]).unwrap();
    settle().await;
    rig.states.send(approval("a", "ap1", "tool")).unwrap();
    settle().await;
    assert_eq!(rig.shown()[0].title, "Build box · Bild");
}

#[test]
fn a_room_and_a_bot_home_shape_the_conversation() {
    let room = row_with("r", "Room chat", false, json!({ "agentRoom": { "id": "room1", "name": "Planning" } }));
    assert_eq!(notification_title_of(&room), "Planning");
    let scheduled = row_with("s", "Nightly", false, json!({ "sourceType": "schedule" }));
    assert_eq!(conversation_of(&scheduled).origin, Origin::Schedule);
    let plain = row("p", "", false);
    assert_eq!(notification_title_of(&plain), "Mixdog");
}

#[test]
fn agent_work_is_classified_by_its_status() {
    let agent = |status: &str, stage: &str| AgentRowLite {
        tag: String::new(),
        session_id: "w".into(),
        owner_session_id: Some("o".into()),
        parent_session_id: None,
        title: None,
        status: status.into(),
        stage: stage.into(),
        released: false,
        row: json!({}),
    };
    for (status, stage, pending) in [
        ("running", "", true),
        ("Tool-Running", "", true),
        ("queued", "idle", true),
        ("", "streaming", true),
        ("idle", "", false),
        ("done", "running", false),
        ("running", "cancelled", false),
        ("cancelling", "", true),
        ("cancel-unconfirmed", "", true),
        ("cancelled", "", false),
        ("", "", false),
    ] {
        let found = sessions_with_pending_work(&[agent(status, stage)]).contains("o");
        assert_eq!(found, pending, "status {status:?} stage {stage:?}");
    }
    let own = AgentRowLite { session_id: "o".into(), ..agent("running", "") };
    assert!(sessions_with_pending_work(&[own]).is_empty());
}
