//! The producer over fakes: the session catalog's rows and the approval states are what the test sends, the host records the toasts it
//! is asked to show, the relay records the pushes it is handed.
//!
//! Each test names the test of the TypeScript decider it replaces (`desktop-turn-notifier.test.mjs` = DTN,
//! `final-answer-watcher.test.mjs` = FAW, `push-turn-events.test.mjs` = PTE, `push-notifier.ts`'s rules = PN).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::host::HostError;
use mixdog_core_domains::notify::decision::{
    ConversationOverride, DevicePreferences, OverrideSetting, PreferencesView, QuietDays, QuietHours, Scope, TargetKind,
};
use mixdog_core_domains::notify::engine::{HostConnection, PairedDevice, ToastStyle};
use serde_json::json;

use super::*;

#[derive(Default)]
struct Host {
    shown: Mutex<Vec<Value>>,
}

#[async_trait]
impl HostChannel for Host {
    async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
        Err(HostError::Core(CoreError::ConnectionClosed))
    }
    fn notify(&self, _: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
        assert_eq!(method.as_str(), "host/notification/show");
        self.shown.lock().unwrap().push(params);
        Ok(())
    }
}

/// Who listens: this PC's preferences, what its window shows, the paired phones.
struct Listeners {
    pc: Mutex<PreferencesView>,
    on_screen: Mutex<HashSet<String>>,
    /// The host can show toasts.
    supported: AtomicBool,
    desktop_active: AtomicBool,
    devices: Mutex<Vec<PairedDevice>>,
}

#[async_trait]
impl AudienceSource for Listeners {
    async fn audience(&self, thread_id: &str) -> Audience {
        let hosts = if self.supported.load(Ordering::SeqCst) {
            let shown = self.on_screen.lock().unwrap().contains(thread_id);
            vec![HostConnection { connection_id: "host".into(), foreground_thread: shown.then(|| thread_id.to_owned()) }]
        } else {
            Vec::new()
        };
        Audience {
            pc: self.pc.lock().unwrap().clone(),
            hosts,
            devices: self.devices.lock().unwrap().clone(),
            desktop_active: self.desktop_active.load(Ordering::SeqCst),
        }
    }
    async fn settings(&self) -> Value {
        Value::Null
    }
}

#[derive(Default)]
struct Relay {
    pushed: Mutex<Vec<PushRequest>>,
}

#[async_trait]
impl PushSink for Relay {
    async fn push(&self, request: &PushRequest) -> Result<(), String> {
        self.pushed.lock().unwrap().push(request.clone());
        Ok(())
    }
    fn connected(&self) -> bool {
        true
    }
}

/// One answer per session, `None` while pending; counts the reads.
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

struct Names;

#[async_trait]
impl AgentNames for Names {
    async fn name(&self, agent_id: &str) -> String {
        match agent_id {
            "secretary" => "비서".to_owned(),
            "lead" => "Mixy".to_owned(),
            _ => String::new(),
        }
    }
}

struct NoOwners;

#[async_trait]
impl RunOwners for NoOwners {
    async fn owner_of(&self, _: &str) -> Option<String> {
        None
    }
}

struct Texts;

impl ProducerTexts for Texts {
    fn turn_failed(&self) -> String {
        "오류로 멈췄습니다.".into()
    }
    fn waiting(&self, wait: Wait) -> String {
        match wait {
            Wait::Approval => "승인을 기다리고 있습니다.".into(),
            Wait::Question => "답변을 기다리고 있습니다.".into(),
        }
    }
    fn attachment_label(&self, kind: AttachmentKind) -> String {
        match kind {
            AttachmentKind::Image => "이미지".into(),
            AttachmentKind::Video => "영상".into(),
            AttachmentKind::File => "파일".into(),
        }
    }
}

fn done(text: &str) -> FinalAnswer {
    FinalAnswer { id: json!("turn"), at: i64::MAX, status: FinalAnswerStatus::Done, text: text.into(), reacted: false }
}

struct Rig {
    host: Arc<Host>,
    relay: Arc<Relay>,
    listeners: Arc<Listeners>,
    answers: Arc<Answers>,
    engine: Arc<NotificationEngine>,
    enabled: Arc<AtomicBool>,
    log: Arc<Mutex<Vec<String>>>,
    input: NotifierInput,
    _notifier: SessionNotifier,
}

fn rig() -> Rig {
    let host = Arc::new(Host::default());
    let relay = Arc::new(Relay::default());
    let listeners = Arc::new(Listeners {
        pc: Mutex::new(PreferencesView { preferences: DevicePreferences::default(), overrides: Vec::new() }),
        on_screen: Mutex::new(HashSet::new()),
        supported: AtomicBool::new(true),
        desktop_active: AtomicBool::new(false),
        devices: Mutex::new(Vec::new()),
    });
    let answers = Arc::new(Answers::default());
    let engine = Arc::new(NotificationEngine::new(Arc::new(|| ToastStyle::for_volume(100))));
    let enabled = Arc::new(AtomicBool::new(true));
    let log = Arc::new(Mutex::new(Vec::new()));
    let clock = Arc::new(AtomicI64::new(1_000));
    let notifier = SessionNotifier::start(ProducerEnv {
        engine: engine.clone(),
        audience: listeners.clone(),
        host: host.clone(),
        push: relay.clone(),
        answers: answers.clone(),
        names: Arc::new(Names),
        owners: Arc::new(NoOwners),
        texts: Arc::new(Texts),
        enabled: Arc::new({
            let enabled = enabled.clone();
            move || enabled.load(Ordering::SeqCst)
        }),
        now_ms: Arc::new(move || clock.load(Ordering::SeqCst)),
        log: Arc::new({
            let log = log.clone();
            move |line| log.lock().unwrap().push(line.to_owned())
        }),
    });
    Rig { host, relay, listeners, answers, engine, enabled, log, input: notifier.input(), _notifier: notifier }
}

impl Rig {
    fn toasts(&self) -> Vec<Value> {
        self.host.shown.lock().unwrap().clone()
    }
    fn titles(&self) -> Vec<String> {
        let mut titles: Vec<String> = self.toasts().iter().map(|toast| toast["title"].as_str().unwrap().to_owned()).collect();
        titles.sort();
        titles
    }
    fn pushes(&self) -> Vec<PushRequest> {
        self.relay.pushed.lock().unwrap().clone()
    }
    fn answer(&self, session: &str, answer: Result<Option<FinalAnswer>, AnswerReadError>) {
        self.answers.by_session.lock().unwrap().insert(session.to_owned(), answer);
    }
    fn preferences(&self, edit: impl FnOnce(&mut PreferencesView)) {
        edit(&mut self.listeners.pc.lock().unwrap());
    }
    fn phone(&self, id: &str, preferences: DevicePreferences) {
        self.listeners.devices.lock().unwrap().push(PairedDevice {
            device_id: id.into(),
            view: PreferencesView { preferences, overrides: Vec::new() },
            foreground_thread: None,
        });
    }
}

fn row_with(id: &str, title: &str, working: bool, extra: Value) -> ThreadSummary {
    let mut fields = json!({
        "id": id, "preview": "", "title": title, "updatedAt": 0, "messageCount": 0, "cwd": "", "classification": null,
        "projectPath": null, "working": working
    });
    fields.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(fields).unwrap()
}

fn row(id: &str, title: &str, working: bool) -> ThreadSummary {
    row_with(id, title, working, json!({}))
}

async fn settle() {
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    settle().await;
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

/// The turn of `id` runs and ends.
async fn finish(rig: &Rig, id: &str, title: &str) {
    rig.input.row(row(id, title, true));
    settle().await;
    rig.input.row(row(id, title, false));
    settle().await;
}

/// A baseline of rows, then each one's turn ends in one roster push each.
async fn finish_all(rig: &Rig, rows: Vec<ThreadSummary>) {
    for summary in &rows {
        let mut busy = serde_json::to_value(summary).unwrap();
        busy["working"] = json!(true);
        rig.input.row(serde_json::from_value(busy).unwrap());
    }
    settle().await;
    for summary in rows {
        rig.input.row(summary);
    }
    settle().await;
}

fn waiting(session: &str, approval: Value) -> SessionWait {
    SessionWait { session_id: session.into(), approval: Some(approval), blocked_goal: None, replay: false }
}

fn cleared(session: &str) -> SessionWait {
    SessionWait { session_id: session.into(), ..Default::default() }
}

fn shell() -> Value {
    json!({ "id": "a1", "kind": "approval", "name": "shell", "args": { "command": "npm test" } })
}

fn question() -> Value {
    json!({ "id": "q1", "kind": "question" })
}

/// The roster the waiting tests start from.
fn rig_with_chats() -> Rig {
    let rig = rig();
    rig.input.row(row("code", "Fix the bug", false));
    rig.input.row(row_with("home", "", false, json!({ "agentHome": "secretary" })));
    rig.input.row(row("task", "Release notes", false));
    rig
}

// ---- the turn's final answer

/// DTN "a restored background completion produces one native notification with plain text and opens its session" (the click is
/// the host's: `thread_id` is what it opens) and "disposal cancels pending completions".
#[tokio::test(start_paused = true)]
async fn a_finished_turn_is_one_toast_with_plain_text_for_its_session() {
    let rig = rig();
    rig.answer("a", Ok(Some(done("**검사 완료**: `file.ts`"))));
    finish(&rig, "a", "Task").await;
    advance(LEAD_FINISHED_MS - 1).await;
    assert!(rig.toasts().is_empty(), "the short delay lets the transcript land");
    advance(2).await;
    let shown = rig.toasts();
    assert_eq!(shown.len(), 1);
    assert_eq!((shown[0]["title"].as_str(), shown[0]["body"].as_str()), (Some("Task"), Some("검사 완료: file.ts")));
    assert_eq!(shown[0]["threadId"], "a");
    assert_eq!(shown[0]["sound"], "soft-rise", "every toast carries this PC's sound and volume");
    assert_eq!(shown[0]["volume"], 100.0);
    rig.input.row(row("a", "Task", false));
    advance(STABILIZE_MS * 2).await;
    assert_eq!(rig.toasts().len(), 1, "a repeated idle roster does not announce the same finish twice");
}

/// PTE "the first roster only establishes a baseline", "a session that never started working is not announced".
#[tokio::test(start_paused = true)]
async fn a_session_never_seen_working_is_not_announced() {
    let rig = rig();
    rig.input.row(row("a", "Idle", false));
    rig.input.row(row("a", "Idle", false));
    advance(STABILIZE_MS * 2).await;
    assert!(rig.toasts().is_empty());
    assert!(rig.answers.reads.lock().unwrap().is_empty());
}

/// DTN "a session titled by attachments alone is notified with its kind in this PC's language" and "without labels an
/// attachment-only title is notified in English" (a phone has no UI language: English).
#[tokio::test(start_paused = true)]
async fn an_attachment_only_title_is_its_kind_in_this_pcs_language_and_english_for_a_phone() {
    let rig = rig();
    rig.phone("phone", DevicePreferences::default());
    rig.answer("a", Ok(Some(done("Done."))));
    finish(&rig, "a", "[Image]").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(rig.titles(), vec!["이미지".to_owned()]);
    assert_eq!(rig.pushes()[0].title, "Image");
}

/// DTN "a bot's home chat is notified under the bot's name, a rename included; a room under its room name" and
/// "Mixy's home chat is notified as ...".
#[tokio::test(start_paused = true)]
async fn a_bots_home_chat_is_told_under_the_bots_name_and_a_room_under_its_name() {
    let rig = rig();
    let roster = vec![
        row_with("bot-a", "", false, json!({ "agentHome": "secretary" })),
        row_with("room-a", "", false, json!({ "agentRoom": { "id": "r1", "name": "기획 회의" } })),
        row("code-a", "Fix the bug"),
        row_with("lead-home", "", false, json!({ "agentHome": "lead" })),
    ];
    for id in ["bot-a", "room-a", "code-a", "lead-home"] {
        rig.answer(id, Ok(Some(done("Done."))));
    }
    finish_all(&rig, roster).await;
    advance(LEAD_FINISHED_MS + 50).await;
    let mut want = vec!["Fix the bug", "Mixy", "기획 회의", "비서"].into_iter().map(str::to_owned).collect::<Vec<_>>();
    want.sort();
    assert_eq!(rig.titles(), want);
}

/// DTN "foreground-visible produces an explicit suppression, not a claimed native delivery", "on-screen state is rechecked at
/// native delivery, including return during the quiet period", "a focused window showing session A does not suppress session
/// B's completion", "every split pane session stays suppressed while a background session notifies", "a window that is focused
/// but minimized or hidden shows nothing, so the completion notifies" (the host reports an empty set for it).
#[tokio::test(start_paused = true)]
async fn what_the_window_shows_is_checked_when_the_toast_is_made() {
    let rig = rig();
    rig.listeners.on_screen.lock().unwrap().extend(["left".to_owned(), "right".to_owned()]);
    for id in ["left", "right", "tab"] {
        rig.answer(id, Ok(Some(done("Done."))));
    }
    finish_all(&rig, vec![row("left", "L", false), row("right", "R", false), row("tab", "T", false)]).await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(rig.titles(), vec!["T".to_owned()]);
    assert_eq!(rig.toasts()[0]["threadId"], "tab");

    let late = rig();
    late.answer("a", Ok(Some(done("Done."))));
    finish(&late, "a", "Late").await;
    late.listeners.on_screen.lock().unwrap().insert("a".into());
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(late.toasts().is_empty(), "the user came back during the quiet period");
}

/// DTN "a schedule run still notifies on screen" / "a webhook run still notifies on screen".
#[tokio::test(start_paused = true)]
async fn an_automatic_run_still_notifies_on_screen() {
    for source in ["schedule", "webhook"] {
        let rig = rig();
        rig.listeners.on_screen.lock().unwrap().insert("a".into());
        rig.answer("a", Ok(Some(done("Done."))));
        rig.input.row(row_with("a", "Run", true, json!({ "sourceType": source })));
        settle().await;
        rig.input.row(row_with("a", "Run", false, json!({ "sourceType": source })));
        advance(LEAD_FINISHED_MS + 50).await;
        assert_eq!(rig.toasts().len(), 1, "{source}");
    }
}

/// DTN "scope produces an explicit suppression", "this PC's preferences decide at delivery: bot chats only, a muted bot, quiet
/// hours", "an 'always' conversation notifies even with this PC's notifications off".
#[tokio::test(start_paused = true)]
async fn this_pcs_preferences_decide_when_the_toast_is_made() {
    let rig = rig();
    rig.preferences(|view| {
        view.preferences.scope = Scope::Bots;
        view.overrides = vec![ConversationOverride { kind: TargetKind::Agent, id: "rel".into(), setting: OverrideSetting::Muted { until: None } }];
    });
    let roster = vec![
        row("code", "Task"),
        row_with("home", "Home", false, json!({ "agentHome": "gh" })),
        row_with("muted-home", "Rel", false, json!({ "agentHome": "rel" })),
    ];
    for id in ["code", "home", "muted-home"] {
        rig.answer(id, Ok(Some(done("Done."))));
    }
    finish_all(&rig, roster).await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(rig.titles(), vec!["Home".to_owned()]);

    let off = self::rig();
    off.preferences(|view| {
        view.preferences.scope = Scope::Off;
        view.overrides = vec![ConversationOverride { kind: TargetKind::Session, id: "a".into(), setting: OverrideSetting::Always }];
    });
    off.answer("a", Ok(Some(done("Done."))));
    finish(&off, "a", "Always").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(off.toasts().len(), 1);

    let scoped = self::rig();
    scoped.preferences(|view| view.preferences.scope = Scope::Off);
    scoped.answer("a", Ok(Some(done("Done."))));
    finish(&scoped, "a", "Off").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(scoped.toasts().is_empty());
}

/// DTN "a failed turn notifies only with errors on, in this PC's words" (the phone's words are English: PN `deliver` with
/// `TURN_FAILED_TEXT`).
#[tokio::test(start_paused = true)]
async fn a_failed_turn_notifies_only_with_errors_on_in_this_pcs_words() {
    let rig = rig();
    rig.phone("phone", DevicePreferences { events: mixdog_core_domains::notify::decision::EventToggles { error: true, ..DevicePreferences::default().events }, ..Default::default() });
    let mut failed = done("");
    failed.status = FinalAnswerStatus::Failed;
    rig.answer("a", Ok(Some(failed.clone())));
    finish(&rig, "a", "Broken").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.toasts().is_empty(), "errors are off by default");
    let pushed = rig.pushes();
    assert_eq!(pushed.len(), 1, "the phone that turned errors on is told");
    assert_eq!((pushed[0].event, pushed[0].body.as_str()), (Event::Error, "The turn stopped with an error."));

    rig.preferences(|view| view.preferences.events.error = true);
    finish(&rig, "a", "Broken").await;
    advance(LEAD_FINISHED_MS + 50).await;
    let shown = rig.toasts();
    assert_eq!((shown[0]["title"].as_str(), shown[0]["body"].as_str()), (Some("Broken"), Some("오류로 멈췄습니다.")));
}

/// FAW "a late read from a previous turn cannot notify after another turn starts and finishes", "a turn that resumes within
/// the quiet period is not delivered"; DTN "a held completion is dropped when its session starts another turn".
#[tokio::test(start_paused = true)]
async fn a_session_that_resumes_before_the_answer_is_read_tells_nothing() {
    let rig = rig();
    rig.answer("a", Ok(Some(done("Done."))));
    finish(&rig, "a", "Back again").await;
    rig.input.row(row("a", "Back again", true));
    advance(STABILIZE_MS).await;
    assert!(rig.toasts().is_empty());
}

/// FAW "a turn answered by a reaction alone raises no notification", "a routine 'nothing new' answer raises no notification",
/// "a failed turn is an error notification with no answer text; a cancelled one is silent".
#[tokio::test(start_paused = true)]
async fn a_cancelled_turn_a_reaction_and_a_quiet_reply_tell_nothing() {
    for (name, answer) in [
        ("cancelled", FinalAnswer { status: FinalAnswerStatus::Cancelled, ..done("") }),
        ("reaction", FinalAnswer { reacted: true, ..done("") }),
        ("quiet", done("NO_CHANGE")),
    ] {
        let rig = rig();
        rig.answer("a", Ok(Some(answer)));
        finish(&rig, "a", name).await;
        advance(LEAD_FINISHED_MS + 50).await;
        advance(STABILIZE_MS).await;
        assert!(rig.toasts().is_empty(), "{name}");
        assert_eq!(rig.answers.reads.lock().unwrap().len(), 1, "{name}: no more polling once decided");
    }
}

/// FAW "an answer arriving after idle is awaited instead of replaced by a preview or generic notice", "a mid-turn flicker
/// with no new answer keeps polling"; DTN "a late answer is retried, but its pending diagnostic is not spammed".
#[tokio::test(start_paused = true)]
async fn a_pending_answer_is_polled_until_it_lands() {
    let rig = rig();
    finish(&rig, "a", "Slow").await;
    advance(LEAD_FINISHED_MS + 50).await;
    advance(ANSWER_POLL_MS).await;
    assert!(rig.toasts().is_empty());
    assert!(rig.answers.reads.lock().unwrap().len() >= 2);
    // An answer from an earlier turn is not this turn's.
    rig.answer("a", Ok(Some(FinalAnswer { at: 0, ..done("Old.") })));
    advance(ANSWER_POLL_MS).await;
    assert!(rig.toasts().is_empty());
    rig.answer("a", Ok(Some(done("Now."))));
    advance(ANSWER_POLL_MS).await;
    assert_eq!(rig.toasts().len(), 1);
}

/// FAW "a Lead that stops to wait on background work is not announced until the work settles"; PTE "child-agent work counts
/// as the session still working", "pending work comes from running child agents only, not shell jobs or the Lead row status",
/// "background work settling without a new Lead turn announces the answer already given", "a running background shell job
/// never holds the Lead final answer".
#[tokio::test(start_paused = true)]
async fn a_lead_waiting_on_its_agents_has_not_answered() {
    let rig = rig();
    rig.answer("lead", Ok(Some(done("Done."))));
    let agent = |status: &str| json!({ "tag": "t", "sessionId": "worker", "ownerSessionId": "lead", "status": status });
    rig.input.agent_pool(vec![agent("running")]);
    settle().await;
    finish(&rig, "lead", "Lead").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.toasts().is_empty());
    rig.input.agent_pool(vec![agent("done")]);
    advance(STABILIZE_MS + 50).await;
    assert_eq!(rig.toasts().len(), 1, "the Lead's last answer was the final one");

    let shell_job = self::rig();
    shell_job.answer("lead", Ok(Some(done("Done."))));
    shell_job.input.agent_pool(vec![json!({ "tag": "sh", "sessionId": "lead", "ownerSessionId": "lead", "status": "running" })]);
    settle().await;
    finish(&shell_job, "lead", "Lead").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(shell_job.toasts().len(), 1, "the Lead's own row never holds its finished turn");
}

/// PTE "an archived session stays silent", "a sub-agent session stays silent while its Lead is still announced", "a deleted
/// session leaves no state behind and re-baselines if it returns".
#[tokio::test(start_paused = true)]
async fn archived_and_sub_agent_sessions_are_silent_and_a_deleted_one_is_forgotten() {
    let rig = rig();
    rig.answer("arch", Ok(Some(done("Done."))));
    rig.answer("sub", Ok(Some(done("Done."))));
    rig.answer("gone", Ok(Some(done("Done."))));
    rig.input.row(row("arch", "Archived", true));
    rig.input.row(row("sub", "Sub", true));
    rig.input.row(row("gone", "Gone", true));
    settle().await;
    rig.input.row(row_with("arch", "Archived", false, json!({ "archived": true })));
    rig.input.row(row_with("sub", "Sub", false, json!({ "agentSession": true })));
    rig.input.row_gone("gone");
    rig.input.row(row("gone", "Gone", false));
    advance(LEAD_FINISHED_MS + 50).await;
    advance(STABILIZE_MS).await;
    assert!(rig.toasts().is_empty());
    assert!(rig.answers.reads.lock().unwrap().is_empty());
}

/// FAW "a read failure is reported and the exact answer can arrive later", "transient read failures back off and are abandoned
/// after a bounded number of tries".
#[tokio::test(start_paused = true)]
async fn read_failures_back_off_and_end() {
    let rig = rig();
    rig.answer("a", Err(AnswerReadError::Failed("boom".into())));
    finish(&rig, "a", "Flaky").await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 1);
    assert!(rig.log.lock().unwrap().iter().any(|line| line.contains("read-failed boom")));
    advance(STABILIZE_MS).await;
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 2);
    advance(STABILIZE_MS * 2).await;
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 3, "the retry delay doubles");
    for _ in 0..8 {
        advance(READ_RETRY_MAX_MS).await;
    }
    assert_eq!(rig.answers.reads.lock().unwrap().len(), READ_FAILURE_LIMIT as usize, "abandoned after the limit");
    assert!(rig.toasts().is_empty());

    let late = self::rig();
    late.answer("a", Err(AnswerReadError::Failed("boom".into())));
    finish(&late, "a", "Recovers").await;
    advance(LEAD_FINISHED_MS + 50).await;
    late.answer("a", Ok(Some(done("Done."))));
    advance(STABILIZE_MS + 50).await;
    assert_eq!(late.toasts().len(), 1, "the exact answer can arrive later");
}

/// FAW "a session whose record is gone is cancelled after one read instead of re-read forever", "a session reported missing
/// by error code is terminal whatever the message says".
#[tokio::test(start_paused = true)]
async fn a_missing_session_is_not_read_again() {
    let rig = rig();
    rig.answer("a", Err(AnswerReadError::SessionMissing));
    finish(&rig, "a", "Deleted").await;
    advance(LEAD_FINISHED_MS + 50).await;
    advance(STABILIZE_MS * 4).await;
    assert_eq!(rig.answers.reads.lock().unwrap().len(), 1);
    assert!(rig.toasts().is_empty());
}

/// FAW "only one answer read is in flight at a time across sessions".
#[tokio::test(start_paused = true)]
async fn answers_are_read_one_at_a_time() {
    struct Slow {
        active: AtomicI64,
        most: AtomicI64,
    }
    #[async_trait]
    impl FinalAnswers for Slow {
        async fn read(&self, _: &str, _: i64) -> Result<Option<FinalAnswer>, AnswerReadError> {
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(now, Ordering::SeqCst);
            mixdog_rt::time::sleep(Duration::from_millis(100)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(Some(done("Done.")))
        }
    }
    let slow = Arc::new(Slow { active: AtomicI64::new(0), most: AtomicI64::new(0) });
    let host = Arc::new(Host::default());
    let listeners = Arc::new(Listeners {
        pc: Mutex::new(PreferencesView { preferences: DevicePreferences::default(), overrides: Vec::new() }),
        on_screen: Mutex::new(HashSet::new()),
        supported: AtomicBool::new(true),
        desktop_active: AtomicBool::new(false),
        devices: Mutex::new(Vec::new()),
    });
    let notifier = SessionNotifier::start(ProducerEnv {
        engine: Arc::new(NotificationEngine::new(Arc::new(|| ToastStyle::for_volume(100)))),
        audience: listeners,
        host: host.clone(),
        push: Arc::new(Relay::default()),
        answers: slow.clone(),
        names: Arc::new(Names),
        owners: Arc::new(NoOwners),
        texts: Arc::new(Texts),
        enabled: Arc::new(|| true),
        now_ms: Arc::new(|| 1_000),
        log: Arc::new(|_| {}),
    });
    let input = notifier.input();
    for id in ["a", "b", "c"] {
        input.row(row(id, id, true));
    }
    settle().await;
    for id in ["a", "b", "c"] {
        input.row(row(id, id, false));
    }
    for _ in 0..8 {
        advance(LEAD_FINISHED_MS + 100).await;
    }
    assert_eq!(slow.most.load(Ordering::SeqCst), 1);
    assert_eq!(host.shown.lock().unwrap().len(), 3);
}

// ---- waits

/// DTN "an unfocused session's approval and question notify in this PC's words, and a click opens that session", "without
/// words of its own a wait notification speaks English" (the words are the host catalog's: `CatalogProducerTexts`).
#[tokio::test(start_paused = true)]
async fn an_approval_and_a_question_are_told_in_this_pcs_words_for_their_session() {
    let rig = rig_with_chats();
    rig.input.session_state(waiting("code", shell()));
    rig.input.session_state(waiting("home", question()));
    advance(0).await;
    assert_eq!(rig.titles(), vec!["Fix the bug · 승인을 기다리고 있습니다.".to_owned(), "비서 · 답변을 기다리고 있습니다.".to_owned()]);
    for toast in rig.toasts() {
        assert_eq!(toast["body"], "");
    }
    let mut opened: Vec<String> = rig.toasts().iter().map(|toast| toast["threadId"].as_str().unwrap().to_owned()).collect();
    opened.sort();
    assert_eq!(opened, ["code", "home"]);
}

/// DTN "a waiting approval is not notified when muted / quiet-hours / foreground-visible / event".
#[tokio::test(start_paused = true)]
async fn a_wait_is_not_told_when_muted_in_quiet_hours_on_screen_or_switched_off() {
    for mode in ["muted", "quiet-hours", "foreground-visible", "event"] {
        let rig = rig_with_chats();
        match mode {
            "muted" => rig.preferences(|view| {
                view.overrides = vec![ConversationOverride { kind: TargetKind::Session, id: "code".into(), setting: OverrideSetting::Muted { until: None } }];
            }),
            "quiet-hours" => rig.preferences(|view| {
                view.preferences.quiet_hours =
                    QuietHours { enabled: true, start: "00:00".into(), end: "23:59".into(), days: QuietDays::Every, allow_waiting: false };
            }),
            "foreground-visible" => {
                rig.listeners.on_screen.lock().unwrap().insert("code".into());
            }
            _ => rig.preferences(|view| view.preferences.events.approval = false),
        }
        rig.input.session_state(waiting("code", shell()));
        advance(0).await;
        assert!(rig.toasts().is_empty(), "{mode}");
    }
}

/// DTN "an approval docked in every chat a hand-off reaches is one notification, not one per copy".
#[tokio::test(start_paused = true)]
async fn an_approval_docked_in_every_chat_a_hand_off_reaches_is_one_notification() {
    let rig = rig_with_chats();
    let ask = json!({ "id": "a1", "kind": "approval", "name": "shell", "sessionId": "task" });
    let copy = |chat: &str| json!({ "id": "a1", "kind": "approval", "name": "shell", "sessionId": "task", "surfaceSessionId": chat });
    rig.input.session_state(waiting("task", ask.clone()));
    rig.input.session_state(waiting("home", copy("home")));
    rig.input.session_state(waiting("code", copy("code")));
    rig.input.session_state(waiting("task", ask.clone()));
    rig.input.session_state(SessionWait { replay: true, ..waiting("home", copy("home")) });
    advance(0).await;
    assert_eq!(rig.toasts().len(), 1);
    // Settled everywhere: the next approval of that session is a new wait.
    for id in ["task", "home", "code"] {
        rig.input.session_state(cleared(id));
    }
    rig.input.session_state(waiting("task", json!({ "id": "a2", "kind": "approval", "name": "shell" })));
    advance(0).await;
    assert_eq!(rig.toasts().len(), 2);
}

/// DTN "a sub-agent's approval is told as, and opens, the chat it shows in".
#[tokio::test(start_paused = true)]
async fn a_sub_agents_approval_is_told_as_the_chat_it_shows_in() {
    let rig = rig_with_chats();
    rig.input.session_state(waiting("sub", json!({ "id": "a1", "kind": "approval", "surfaceSessionId": "code", "chain": ["Lead", "Worker"] })));
    advance(0).await;
    let shown = rig.toasts();
    assert_eq!(shown[0]["title"], "Fix the bug · 승인을 기다리고 있습니다.");
    assert_eq!(shown[0]["threadId"], "code");
}

/// DTN "a replayed wait is not a new one".
#[tokio::test(start_paused = true)]
async fn a_replayed_wait_is_not_a_new_one() {
    let rig = rig_with_chats();
    rig.input.session_state(SessionWait { replay: true, ..waiting("code", shell()) });
    rig.input.session_state(waiting("code", shell()));
    advance(0).await;
    assert!(rig.toasts().is_empty());
}

/// DTN "an unreadable approval settled before preferences recover is forgotten, not told later" (this PC's preferences cannot
/// fail to read in the core, so the held-and-offered-again path of the TypeScript decider does not exist): an approval answered
/// while its bot's name is read is not told.
#[tokio::test(start_paused = true)]
async fn an_approval_answered_before_it_is_shown_is_forgotten_not_told_later() {
    let rig = rig_with_chats();
    rig.input.session_state(waiting("code", shell()));
    rig.input.session_state(cleared("code"));
    advance(0).await;
    assert!(rig.toasts().is_empty());
    rig.input.session_state(waiting("code", shell()));
    advance(0).await;
    assert_eq!(rig.toasts().len(), 1, "the same id asked again is a new wait");
}

// ---- the phones (push-notifier.ts)

/// PN `deliver`: each paired device decides for itself; a device that holds while this PC is in use hears it after the hold if
/// the turn is still unread, and not when it was read meanwhile.
#[tokio::test(start_paused = true)]
async fn a_phone_that_holds_while_this_pc_is_in_use_hears_an_unread_turn_after_the_hold() {
    let rig = rig();
    rig.phone("phone", DevicePreferences::default());
    rig.phone("off", DevicePreferences { scope: Scope::Off, ..Default::default() });
    rig.listeners.desktop_active.store(true, Ordering::SeqCst);
    rig.answer("a", Ok(Some(done("Done."))));
    rig.input.row(row_with("a", "Task", true, json!({ "messageCount": 4, "readMessageCount": 4 })));
    settle().await;
    rig.input.row(row_with("a", "Task", false, json!({ "messageCount": 6, "readMessageCount": 4 })));
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.pushes().is_empty(), "held");
    rig.listeners.desktop_active.store(false, Ordering::SeqCst);
    advance(DESKTOP_HOLD_MS).await;
    let pushed = rig.pushes();
    assert_eq!(pushed.len(), 1);
    assert_eq!((pushed[0].device_id.as_str(), pushed[0].thread_id.as_str(), pushed[0].event), ("phone", "a", Event::Finished));
    assert_eq!(pushed[0].schedule, PushSchedule::Now);

    let read = self::rig();
    read.phone("phone", DevicePreferences::default());
    read.listeners.desktop_active.store(true, Ordering::SeqCst);
    read.answer("a", Ok(Some(done("Done."))));
    read.input.row(row_with("a", "Task", true, json!({ "messageCount": 4, "readMessageCount": 4 })));
    settle().await;
    read.input.row(row_with("a", "Task", false, json!({ "messageCount": 6, "readMessageCount": 4 })));
    advance(LEAD_FINISHED_MS + 50).await;
    read.input.row(row_with("a", "Task", false, json!({ "messageCount": 6, "readMessageCount": 6 })));
    advance(DESKTOP_HOLD_MS).await;
    assert!(read.pushes().is_empty(), "seen on the desktop");
}

/// PN `onSessionState`: an approval's push carries its id and whether Allow is offered; a question has none and says so in its
/// own words; a wait answered during the hold is not pushed; one push per approval.
#[tokio::test(start_paused = true)]
async fn a_waits_push_carries_the_approval_and_a_wait_answered_during_the_hold_is_not_pushed() {
    let rig = rig_with_chats();
    rig.phone("phone", DevicePreferences::default());
    rig.input.session_state(waiting("code", shell()));
    rig.input.session_state(waiting("code", shell()));
    rig.input.session_state(waiting("task", question()));
    advance(0).await;
    let pushed = rig.pushes();
    assert_eq!(pushed.len(), 2);
    let approval = pushed.iter().find(|push| push.event == Event::Approval).unwrap();
    assert_eq!(approval.approval, Some(PushApproval { id: "a1".into(), allow_once: true }));
    assert_eq!((approval.title.as_str(), approval.body.as_str()), ("Fix the bug", ""));
    let asked = pushed.iter().find(|push| push.event == Event::Question).unwrap();
    assert_eq!((asked.approval.clone(), asked.body.as_str()), (None, "에이전트가 질문했습니다"));

    let held = self::rig_with_chats();
    held.phone("phone", DevicePreferences::default());
    held.listeners.desktop_active.store(true, Ordering::SeqCst);
    held.input.session_state(waiting("code", shell()));
    advance(0).await;
    held.input.session_state(cleared("code"));
    advance(DESKTOP_HOLD_MS).await;
    assert!(held.pushes().is_empty(), "answered on this PC meanwhile");

    let pointer = self::rig_with_chats();
    pointer.phone("phone", DevicePreferences::default());
    pointer.input.session_state(waiting("code", json!({ "id": "p1", "kind": "outbound", "outbound": { "category": "payment" } })));
    advance(0).await;
    assert_eq!(pointer.pushes()[0].approval, Some(PushApproval { id: "p1".into(), allow_once: false }), "a payment is allowed by a click only");
}

/// PN `pendingInputKey`: a blocked goal is told once, to a phone only, until it clears.
#[tokio::test(start_paused = true)]
async fn a_blocked_goal_is_pushed_once_until_it_clears() {
    let rig = rig_with_chats();
    rig.phone("phone", DevicePreferences::default());
    let blocked = |key: Option<&str>| SessionWait { session_id: "code".into(), blocked_goal: key.map(str::to_owned), ..Default::default() };
    rig.input.session_state(blocked(Some("g1:blocked:need a key")));
    rig.input.session_state(blocked(Some("g1:blocked:need a key")));
    advance(0).await;
    assert_eq!(rig.pushes().len(), 1);
    assert_eq!(rig.pushes()[0].event, Event::Question);
    assert!(rig.toasts().is_empty(), "this PC's window shows the goal itself");
    rig.input.session_state(blocked(None));
    rig.input.session_state(blocked(Some("g1:blocked:need a key")));
    advance(0).await;
    assert_eq!(rig.pushes().len(), 2);
}

// ---- hosts and shutdown

/// The engine keeps a toast the PC wanted while no host could show it, once, until a host attaches or the thread is read
/// (DTN "unsupported produces an explicit suppression": the toast is not shown now).
#[tokio::test(start_paused = true)]
async fn a_toast_without_a_host_is_shown_once_when_one_attaches_and_not_when_the_thread_was_read() {
    let rig = rig();
    rig.listeners.supported.store(false, Ordering::SeqCst);
    rig.answer("a", Ok(Some(done("Done."))));
    rig.answer("b", Ok(Some(done("Done."))));
    finish_all(&rig, vec![row("a", "A", false), row("b", "B", false)]).await;
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.toasts().is_empty());
    rig.input.row(row_with("b", "B", false, json!({ "messageCount": 2, "readMessageCount": 2 })));
    settle().await;
    rig.listeners.supported.store(true, Ordering::SeqCst);
    rig.input.host_attached();
    advance(0).await;
    assert_eq!(rig.titles(), vec!["A".to_owned()]);
    rig.input.host_attached();
    advance(0).await;
    assert_eq!(rig.toasts().len(), 1, "exactly once");
    assert_eq!(rig.engine.host_attached().len(), 0);
}

/// DTN "disposal cancels pending completions": a host that is closing is told nothing, and a dropped producer stops.
#[tokio::test(start_paused = true)]
async fn nothing_is_told_once_the_host_is_closing() {
    let rig = rig();
    rig.phone("phone", DevicePreferences::default());
    rig.answer("a", Ok(Some(done("Done."))));
    finish(&rig, "a", "Task").await;
    rig.enabled.store(false, Ordering::SeqCst);
    advance(LEAD_FINISHED_MS + 50).await;
    assert!(rig.toasts().is_empty());
    assert!(rig.pushes().is_empty());

    let rig = self::rig();
    rig.answer("a", Ok(Some(done("Done."))));
    let input = rig.input.clone();
    drop(rig);
    input.row(row("a", "Task", true));
    settle().await;
}

/// PN `pendingInputKey`: a blocked goal's identity is its id, `blocked` and its blocker; any other goal waits for nothing.
#[test]
fn a_blocked_goal_is_identified_by_its_id_and_blocker() {
    assert_eq!(blocked_goal_key(Some(&json!({ "id": "g1", "status": "blocked", "blocker": "needs a key" }))).as_deref(), Some("g1:blocked:needs a key"));
    assert_eq!(blocked_goal_key(Some(&json!({ "status": "blocked" }))).as_deref(), Some("goal:blocked:"));
    assert_eq!(blocked_goal_key(Some(&json!({ "id": 7, "status": "blocked", "blocker": null }))).as_deref(), Some("7:blocked:"));
    assert_eq!(blocked_goal_key(Some(&json!({ "id": "g1", "status": "active" }))), None);
    assert_eq!(blocked_goal_key(Some(&Value::Null)), None);
    assert_eq!(blocked_goal_key(None), None);
}