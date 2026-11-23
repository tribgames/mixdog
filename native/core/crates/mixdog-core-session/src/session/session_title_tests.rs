//! The session titles through a session's actor: the first title released by the turn's output on its port or by its end,
//! the third read at a completed turn's end, and a close or an accepted delete dropping the title work.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;

use async_trait::async_trait;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_protocol::ThreadItem;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use super::SessionDirectory;
use super::SessionHandle;
use super::control::Ctl;
use super::run::ItemCommit;
use super::seams::RunOutcome;
use super::session_title::LineTitleLog;
use super::session_title::SessionTitles;
use super::session_title::TitleDeps;
use super::session_title::TitleError;
use super::session_title::TitleHooks;
use super::session_title::TitleModel;
use super::session_title::TitlePromote;
use super::testing::Rig;
use super::testing::awaiting;
use super::tests::caught_up;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;
use crate::eventually_on;

const PROMPT: &str = "Why does the parser crash on empty input";

/// What the run had done when the title model was asked.
#[derive(Default)]
struct Flags {
    /// The run showed output on its port.
    output: AtomicBool,
    /// The run was about to end.
    ended: AtomicBool,
}

/// One request of the title model, held until the test answers it.
struct Asked {
    source: String,
    cancel: CancellationToken,
    answer: oneshot::Sender<Result<String, TitleError>>,
    output: bool,
    ended: bool,
}

struct Model {
    asked: mpsc::UnboundedSender<Asked>,
    flags: Arc<Flags>,
}

#[async_trait]
impl TitleModel for Model {
    async fn generate(&self, source: &str, _: &str, _: &str, cancel: &CancellationToken) -> Result<String, TitleError> {
        let (answer, answered) = oneshot::channel();
        let (output, ended) = (self.flags.output.load(SeqCst), self.flags.ended.load(SeqCst));
        let _ = self.asked.send(Asked { source: source.to_owned(), cancel: cancel.clone(), answer, output, ended });
        answered.await.unwrap_or_else(|_| Err(TitleError::Failed("unanswered".into())))
    }
}

/// Every title written: session, title, stage.
struct Promoted(mpsc::UnboundedSender<(String, String, String)>);

#[async_trait]
impl TitlePromote for Promoted {
    async fn promote(&self, session_id: &str, title: &str, stage: &str) -> Result<bool, String> {
        let _ = self.0.send((session_id.to_owned(), title.to_owned(), stage.to_owned()));
        Ok(true)
    }
}

/// What a turn's run does.
#[derive(Clone, Copy)]
enum Play {
    /// Schedules the first title as the turn's carry does, then shows output (an item started, else a text delta) and,
    /// when `hold`, waits for the test before it ends.
    Output { started: bool, hold: bool },
    /// Schedules the first title, then ends without output.
    Quiet,
    /// Answers the prompt with an assistant row.
    Answer,
}

struct World {
    _rig: Rig,
    _directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    flags: Arc<Flags>,
    hold: Arc<tokio::sync::Notify>,
    asked: mpsc::UnboundedReceiver<Asked>,
    promoted: mpsc::UnboundedReceiver<(String, String, String)>,
    lines: mpsc::UnboundedReceiver<String>,
}

async fn world(play: Play) -> World {
    let rig = Rig::new();
    let (flags, hold) = (Arc::new(Flags::default()), Arc::new(tokio::sync::Notify::new()));
    let (asked_tx, asked) = mpsc::unbounded_channel();
    let (promoted_tx, promoted) = mpsc::unbounded_channel();
    let (lines_tx, lines) = mpsc::unbounded_channel();
    let model = Arc::new(Model { asked: asked_tx, flags: flags.clone() });
    let log = LineTitleLog(Arc::new(move |line: &str| {
        let _ = lines_tx.send(line.to_owned());
    }));
    let deps = TitleDeps::new(model, Arc::new(Promoted(promoted_tx)), Arc::new(log), Arc::new(|| "en-US".to_owned()));
    let (run_flags, run_hold) = (flags.clone(), hold.clone());
    rig.set_script(Arc::new(move |run| {
        let (flags, hold) = (run_flags.clone(), run_hold.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if let Play::Answer = play {
                let body = json!({ "role": "assistant", "content": "The parser reads past the end of an empty buffer." });
                let row =
                    ItemCommit { iid: ItemId::from(format!("a-{}", run.turn)), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
                run.port.commit_item(row).await.expect("the answer");
                flags.ended.store(true, SeqCst);
                return RunOutcome::Completed(Default::default());
            }
            let prompt = json!({ "role": "user", "content": run.input_body.get("content").cloned().unwrap_or(Value::Null) });
            assert!(run.port.schedule_title(&run.header, &[], Some(&prompt)), "the first prompt schedules its title");
            if let Play::Output { started, hold: held } = play {
                flags.output.store(true, SeqCst);
                if started {
                    let item = ThreadItem::AgentMessage {
                        id: "a-shown".into(),
                        text: mixdog_protocol::MaybeBlob::Inline(String::new()),
                        imported_tool_runs: Vec::new(),
                        meta: Default::default(),
                    };
                    let _ = run.port.item_started(item).await;
                } else {
                    let _ = run.port.delta(ItemId::from("a-shown"), "Looking".into()).await;
                }
                if held {
                    hold.notified().await;
                }
            }
            flags.ended.store(true, SeqCst);
            RunOutcome::Completed(Default::default())
        })
    }));
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.titles = Some(Arc::new(TitleHooks::new(SessionTitles::new(deps))));
    let directory = SessionDirectory::new(Arc::new(parts));
    let handle = start_thread(&directory).await;
    World { _rig: rig, _directory: directory, handle, flags, hold, asked, promoted, lines }
}

impl World {
    async fn asked(&mut self) -> Asked {
        awaiting(|| "the title model's request".to_owned(), self.asked.recv()).await.expect("the model is held")
    }

    async fn promoted(&mut self) -> (String, String, String) {
        awaiting(|| "the title's promotion".to_owned(), self.promoted.recv()).await.expect("the promotion")
    }

    /// The first line of the core's log that holds `part`.
    async fn logged(&mut self, part: &str) -> String {
        awaiting(|| format!("the log line {part:?}"), async {
            loop {
                let line = self.lines.recv().await.expect("the log");
                if line.contains(part) {
                    return line;
                }
            }
        })
        .await
    }

    async fn patch(&self, set: Value) {
        let params = json!({ "threadId": self.handle.id, "set": set, "unset": [] });
        self.handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
    }

    /// The session's model context before its next turn.
    async fn seed(&self, messages: Value) {
        let append = CoreRequest {
            method: Method("thread/inheritedRows/append"),
            params: json!({ "messages": messages }),
            op: None,
            ctx: CallContext::internal("test"),
        };
        self.handle.request(append).await.expect("the conversation is appended");
    }

    /// One prompt, to its turn's end.
    async fn settled_turn(&self, op: &str) {
        self.flags.ended.store(false, SeqCst);
        turn(&self.handle, PROMPT, op).await;
        let (handle, flags) = (&self.handle, &self.flags);
        eventually_on!(&[&handle.cell.stepped], || (flags.ended.load(SeqCst) && idle(handle)).then_some(())).await;
        caught_up(handle).await;
    }

    fn title_reads(&self) -> usize {
        let read = format!("title:read:{}", self.handle.id.as_str());
        self.handle.cell.stop_ledger.lock().unwrap().iter().filter(|event| **event == read).count()
    }

    fn delete(&self, idle: bool) -> oneshot::Receiver<Result<(), &'static str>> {
        let (closed, refused) = oneshot::channel();
        let (_mark, mark) = oneshot::channel();
        let (marked, _) = oneshot::channel();
        let abort = mixdog_agent::cancel::Abort::close_session(self.handle.id.as_str(), "test-delete");
        assert!(self.handle.cell.ctl_tx.try_send(Ctl::Delete { abort, idle, guard: None, closed, mark, marked }).is_ok(), "the control lane takes the delete");
        refused
    }
}

/// Two exchanges and the user turn of a third: the turn that answers it completes the third exchange.
fn two_exchanges_and_a_question() -> Value {
    json!([
        { "role": "user", "content": "Why does the parser crash on empty input" },
        { "role": "assistant", "content": "It reads past the end of the buffer." },
        { "role": "user", "content": "Where is the buffer read" },
        { "role": "assistant", "content": "In the tokenizer's peek." },
        { "role": "user", "content": "How do I guard the peek" },
    ])
}

/// Output the turn shows through its port, an item started or a text delta, releases its first title while the turn still runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_shown_through_the_port_releases_the_first_title() {
    for started in [true, false] {
        let mut world = world(Play::Output { started, hold: true }).await;
        turn(&world.handle, PROMPT, "op-1").await;
        let asked = world.asked().await;
        assert!(asked.output && !asked.ended, "asked at the turn's output (started: {started}), before its end");
        assert!(asked.source.contains("parser crash"), "{}", asked.source);
        let _ = asked.answer.send(Ok("Parser crash fix".into()));
        assert_eq!(world.promoted().await, (world.handle.id.as_str().to_owned(), "Parser crash fix".to_owned(), "first".to_owned()));
        world.hold.notify_one();
    }
}

/// A turn that ends without showing anything releases its first title at its end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_ends_without_output_releases_the_first_title() {
    let mut world = world(Play::Quiet).await;
    turn(&world.handle, PROMPT, "op-1").await;
    let asked = world.asked().await;
    assert!(asked.ended && !asked.output, "asked once the turn ended");
    let _ = asked.answer.send(Ok("Parser crash fix".into()));
    assert_eq!(world.promoted().await.2, "first");
}

/// The turn that completes the third exchange titles the session from its first three exchanges, read at the turn's end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_third_completed_exchange_titles_the_session_from_the_turns_end() {
    let mut world = world(Play::Answer).await;
    world.seed(two_exchanges_and_a_question()).await;
    world.settled_turn("op-1").await;
    assert_eq!(world.title_reads(), 1, "the turn's end read the exchanges");
    let asked = world.asked().await;
    assert_eq!(asked.source.matches("User: ").count(), 3, "{}", asked.source);
    assert!(asked.source.contains("Assistant: The parser reads past the end of an empty buffer."), "{}", asked.source);
    let _ = asked.answer.send(Ok("Guarding the tokenizer peek".into()));
    assert_eq!(world.promoted().await, (world.handle.id.as_str().to_owned(), "Guarding the tokenizer peek".to_owned(), "third".to_owned()));
}

/// A session titled from its exchanges, or one the user titled, reads nothing at a completed turn's end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_finished_or_locked_sessions_turn_end_reads_nothing() {
    for done in [json!({ "generatedTitleStage": "third" }), json!({ "title": "My title", "titleLocked": true, "titleSource": "user" })] {
        let mut world = world(Play::Answer).await;
        world.patch(done.clone()).await;
        world.seed(two_exchanges_and_a_question()).await;
        world.settled_turn("op-1").await;
        assert_eq!(world.title_reads(), 0, "{done}: the turn's end read the session");
        assert!(world.asked.try_recv().is_err(), "{done}: the model was asked");
    }
}

/// A close (`Ctl::Closed`) and an accepted delete each cancel the running generation, and nothing is written after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_or_an_accepted_delete_drops_the_running_title() {
    for close in [true, false] {
        let mut world = world(Play::Output { started: false, hold: false }).await;
        turn(&world.handle, PROMPT, "op-1").await;
        let asked = world.asked().await;
        let _refusal = if close {
            let (taken, _took) = oneshot::channel();
            world.handle.cell.deliver(Ctl::Closed(taken));
            None
        } else {
            Some(world.delete(false))
        };
        awaiting(|| format!("the generation's cancel (close: {close})"), asked.cancel.cancelled()).await;
        let _ = asked.answer.send(Ok("Late title".into()));
        let id = world.handle.id.as_str().to_owned();
        world.logged(&format!("[mixdog] llm-title dropped id={id} stage=first")).await;
        assert!(world.promoted.try_recv().is_err(), "a title was written after the session left (close: {close})");
    }
}

/// A delete the session refuses (a favorite) leaves its title work running: the title is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_delete_cancels_no_title_work() {
    let mut world = world(Play::Output { started: false, hold: false }).await;
    turn(&world.handle, PROMPT, "op-1").await;
    let asked = world.asked().await;
    world.patch(json!({ "favoriteAt": 1_793_306_570_000_i64 })).await;
    let refused = world.delete(true);
    assert_eq!(awaiting(|| "the delete's answer".to_owned(), refused).await.expect("the actor answers"), Err("favorite"));
    assert!(!asked.cancel.is_cancelled(), "the refused delete cancelled the generation");
    let _ = asked.answer.send(Ok("Parser crash fix".into()));
    assert_eq!(world.promoted().await.1, "Parser crash fix");
}
