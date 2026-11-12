//! A routine fire's turn in its owner bot's home thread (`routine-home-turn.mjs`, the
//! session half): the turn rides the thread's own queue as one `routine` entry (priority
//! `later`, never merged or steered into another turn), shows as a routine marker row, selects
//! skills from the routine's instructions only, and resolves when the turn settles. The
//! decisions around it (queue limit, executor, heartbeat cap, error texts) are
//! `mixdog_services::bots`.

use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::PromptContent;
use mixdog_protocol::PromptPriority;
use mixdog_protocol::SubmitOptions;
use mixdog_rt::CancellationToken;
use mixdog_services::bots::{RoutineTurn, TurnSettle};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use std::sync::Arc;

use super::SessionDirectory;
use super::SessionHandle;
use super::control::RoutineStart;
use super::seams::RunOutcome;

/// The end of a sent turn as its `onSettled` detail reads (`turnStatus(detail)`, `detail.result.content || detail.error`):
/// `completed`, `failed` or `cancelled` (also a turn that never ran), and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendSettle {
    pub status: &'static str,
    pub text: String,
}

impl SendSettle {
    fn of(outcome: Option<RunOutcome>) -> Self {
        match outcome {
            Some(RunOutcome::Completed(result)) => Self { status: "completed", text: result.content.clone() },
            Some(RunOutcome::Failed(error)) => Self { status: "failed", text: error.message },
            Some(RunOutcome::Interrupted) | None => Self { status: "cancelled", text: String::new() },
        }
    }
}

/// A prompt the queue entry shows: the content as parts when it is parts, else its text.
fn prompt_of(content: &Value) -> PromptContent {
    serde_json::from_value(content.clone()).unwrap_or_else(|_| {
        let text = match content {
            Value::Array(parts) => parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
            other => other.as_str().unwrap_or_default().to_owned(),
        };
        PromptContent::Text(text)
    })
}

/// Registers `start` under the submission `id` and submits it as a `turn/start`: it runs at once
/// on an idle thread, else rides the queue. The queued entry's id (`None` when the turn started);
/// `Err` when the thread did not accept it.
async fn enqueue(
    handle: &Arc<SessionHandle>,
    id: &str,
    op: &OpId,
    start: RoutineStart,
    options: SubmitOptions,
    ctx: &CallContext,
) -> Result<Option<String>, ()> {
    let content = start.content.clone();
    handle.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).insert(id.to_owned(), start);
    let input = TurnInput { prompt: prompt_of(&content), options: Some(options) };
    let params = json!({ "threadId": handle.id, "opId": op, "input": input });
    let started = handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op.clone()), ctx: ctx.clone() }).await;
    match started {
        Ok(Reply::Value(value)) => Ok(value["queuedId"].as_str().map(str::to_owned)),
        _ => {
            handle.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
            Err(())
        }
    }
}

impl SessionDirectory {
    /// Starts one hidden turn of the thread with `prompt` (a task session's result, which the
    /// agent relays in one turn; `daemon.mjs` live surface `wake`). The receiver answers with
    /// the turn's end status (`done` when it finished); `None` when the turn was refused.
    pub async fn wake_turn(&self, thread: &ThreadId, prompt: &str, id: &str, hop: u32) -> Option<oneshot::Receiver<String>> {
        let ctx = CallContext::internal("wake-turn");
        let handle = self.open_handle(thread, &ctx).await.ok()?;
        let (done, outcome) = oneshot::channel();
        let start = RoutineStart {
            content: Value::String(prompt.to_owned()),
            trigger: None,
            hop: (hop > 0).then_some(hop),
            bot_chain: Vec::new(),
            room_row: None,
            sender: None,
            from_agent: None,
            skill_selection: None,
            meta: Map::new(),
            on_start: Box::new(|| {}),
            done,
        };
        let options = SubmitOptions { client_submission_id: Some(id.to_owned()).filter(|id| !id.is_empty()), kickoff: Some(true), ..SubmitOptions::default() };
        let op = OpId::from(format!("wake-turn:{id}"));
        enqueue(&handle, id, &op, start, options, &ctx).await.ok()?;
        let (settled, status) = oneshot::channel();
        drop(mixdog_rt::spawn("wake-settle", mixdog_rt::TaskClass::Work, async move {
            let word = match outcome.await {
                Ok(RunOutcome::Completed(_)) => "done",
                Ok(RunOutcome::Failed(_)) => "failed",
                Ok(RunOutcome::Interrupted) => "cancelled",
                Err(_) => "rejected",
            };
            let _ = settled.send(word.to_owned());
        }));
        Some(status)
    }

    /// A room member's turn (`submitToSession` of `agent-rooms.ts`): `content` is the prompt (text
    /// or parts) submitted under `id` (empty for none) at bot-to-bot depth `hop`, with `room_row`
    /// (the newest user row it shows; empty for none) stamped on its input row. It runs at once on
    /// an idle thread, else rides the queue; false when the thread did not accept it. The turn's
    /// end is read from the session, not awaited.
    pub async fn submit_member_turn(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, room_row: &str) -> bool {
        self.submit_chained_turn(thread, content, id, hop, &[], &Map::new(), room_row).await.is_some()
    }

    /// [`Self::submit_member_turn`] for a send that also carries its bot chain and the sender's
    /// own transcript meta (`transcriptMeta: { sender: 'lead', fromAgent, hop, botChain }`,
    /// `daemon-session-control.mjs:186-195`, `sendTranscriptMeta`): the turn it starts, or the
    /// steering it joins, is in that chain (`bot-hops.mjs:52,70`). The receiver answers the turn's
    /// end as `onSettled` hands it; `None` when the thread did not accept it.
    #[allow(clippy::too_many_arguments)]
    pub async fn submit_chained_turn(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], meta: &Map<String, Value>, room_row: &str) -> Option<oneshot::Receiver<SendSettle>> {
        self.submit_message(thread, content, id, hop, bot_chain, meta, room_row, None).await
    }

    /// A `session` tool's send (`sendToSession`, `daemon-session-control.mjs`): `content` submitted under `id` with
    /// `transcriptMeta: { sender: 'lead', fromAgent?, hop?, botChain? }` (`from_agent`: the bot writing into another's chat).
    /// It runs at once on an idle thread, else rides the queue; false when the thread did not accept it.
    pub async fn submit_session_message(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], from_agent: Option<&str>) -> bool {
        self.submit_message(thread, content, id, hop, bot_chain, &Map::new(), "", Some(from_agent)).await.is_some()
    }

    /// `sender`: `Some(from_agent)` stamps `sender: 'lead'` (and `fromAgent`); `None` stamps neither.
    #[allow(clippy::too_many_arguments)]
    async fn submit_message(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], meta: &Map<String, Value>, room_row: &str, sender: Option<Option<&str>>) -> Option<oneshot::Receiver<SendSettle>> {
        let ctx = CallContext::internal("room-turn");
        let handle = self.open_handle(thread, &ctx).await.ok()?;
        let (done, outcome) = oneshot::channel();
        let start = RoutineStart {
            content: content.clone(),
            trigger: None,
            hop: (hop > 0).then_some(hop),
            bot_chain: bot_chain.to_vec(),
            room_row: Some(room_row.to_owned()).filter(|row| !row.is_empty()),
            sender: sender.map(|_| "lead"),
            from_agent: sender.flatten().map(str::to_owned),
            skill_selection: None,
            meta: meta.clone(),
            on_start: Box::new(|| {}),
            done,
        };
        let options = SubmitOptions { client_submission_id: Some(id.to_owned()).filter(|id| !id.is_empty()), ..SubmitOptions::default() };
        let op = OpId::from(format!("room-turn:{}", uuid::Uuid::new_v4()));
        enqueue(&handle, id, &op, start, options, &ctx).await.ok()?;
        let (settled, settle) = oneshot::channel();
        drop(mixdog_rt::spawn("room-turn-settle", mixdog_rt::TaskClass::Work, async move {
            let _ = settled.send(SendSettle::of(outcome.await.ok()));
        }));
        Some(settle)
    }
    /// `liveSessionBusy`: the thread is loaded here and runs a turn or holds queued input.
    pub fn thread_busy(&self, id: &ThreadId) -> bool {
        self.handle(id).is_some_and(|handle| handle.cell.run.load().is_some() || !handle.cell.queued.load().is_empty())
    }

    /// `loadSession(id)` is a session and `closed !== true`.
    /// `Err` when the record read never ran: a thread whose record was not read is not a closed one.
    pub async fn home_thread_open(&self, id: &ThreadId) -> Result<bool, mixdog_core_api::CoreError> {
        Ok(self.try_stored_header(id).await?.is_some_and(|header| header.get("closed") != Some(&Value::Bool(true))))
    }

    /// Queues `turn` behind the thread's own work and resolves when it settles. `on_start`
    /// runs the moment the turn starts (`onCommitted`). When `cancel` fires the queued entry
    /// is dropped or the running turn aborted, and the turn settles cancelled.
    pub async fn run_routine_turn(&self, turn: RoutineTurn, on_start: Box<dyn FnOnce() + Send>, cancel: CancellationToken) -> TurnSettle {
        let thread = ThreadId::from(turn.session_id.as_str());
        let ctx = CallContext::internal("routine-turn");
        let Ok(handle) = self.open_handle(&thread, &ctx).await else {
            return TurnSettle::Rejected;
        };
        let (done, outcome) = oneshot::channel();
        let trigger = serde_json::to_value(&turn.trigger).expect("a trigger serializes");
        let start = RoutineStart {
            content: turn.content.clone(),
            trigger: Some(trigger),
            hop: None,
            bot_chain: Vec::new(),
            room_row: None,
            sender: None,
            from_agent: None,
            skill_selection: Some(turn.skill_selection.clone()),
            meta: Map::new(),
            on_start,
            done,
        };
        // Runs after the thread's current turn, never steered into it.
        let options = SubmitOptions { client_submission_id: Some(turn.id.clone()), priority: Some(PromptPriority::Later), ..SubmitOptions::default() };
        let op = OpId::from(format!("routine-turn:{}", turn.id));
        let Ok(queued) = enqueue(&handle, &turn.id, &op, start, options, &ctx).await else {
            return TurnSettle::NotAccepted;
        };
        tokio::select! {
            ended = outcome => match ended {
                Ok(RunOutcome::Completed(result)) => TurnSettle::Done { result: result.content.clone() },
                Ok(RunOutcome::Failed(error)) => TurnSettle::Failed(error.message),
                Ok(RunOutcome::Interrupted) => TurnSettle::Cancelled,
                // The thread closed before the entry ran.
                Err(_) => TurnSettle::Rejected,
            },
            () = cancel.cancelled() => {
                let waiting = handle.cell.routine_starts.lock().unwrap_or_else(|p| p.into_inner()).remove(&turn.id).is_some();
                if waiting {
                    if let Some(queued) = queued {
                        let unqueue = OpId::from(format!("{op}:unqueue"));
                        let params = json!({ "threadId": thread, "opId": unqueue, "queuedId": queued, "restore": false });
                        // Node takes the entry off its in-memory queue (`abortDiscardOnAbort`), which cannot be
                        // refused; here the actor can refuse it, and a fire left queued would run later with
                        // nobody waiting. Node logs a failed abort of the started turn the same way
                        // (`routine-home-turn.mjs:165`).
                        if let Err(error) = handle.request(CoreRequest { method: Method("thread/queue/delete"), params, op: Some(unqueue), ctx }).await {
                            tracing::warn!("routine {}: its queued turn was not taken off the queue: {error:?}", turn.id);
                        }
                    }
                } else {
                    self.abort_session_turn(&thread, "routine-abort");
                }
                TurnSettle::Cancelled
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering::SeqCst;

    use mixdog_agent::agent_tool::flow::seams::TurnResult;
    use mixdog_services::bots::{RoutineKind, RoutineTrigger};

    use super::*;
    use crate::eventually_on;
        use crate::session::tests::{idle, start_thread, turn};
    use crate::session::testing::Rig;

    fn routine(id: &str, thread: &ThreadId) -> RoutineTurn {
        RoutineTurn {
            id: id.into(),
            session_id: thread.as_str().into(),
            agent_id: "lead".into(),
            kind: RoutineKind::Schedule,
            name: "daily".into(),
            content: json!("Header\n\nCheck the build"),
            skill_selection: "Check the build".into(),
            trigger: RoutineTrigger { kind: RoutineKind::Schedule, name: "daily".into(), event: None },
        }
    }

    /// An idle thread runs the fire at once: the input row carries the content, the submission and
    /// the marker row's trigger, the run is handed the skill text, `on_start` ran before the run,
    /// and the turn's final reply is the settle.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_idle_thread_runs_the_fire_with_its_marker_and_skill_text() {
        let rig = Rig::new();
        let started = Arc::new(AtomicBool::new(false));
        let seen: Arc<Mutex<Vec<(Option<String>, bool, Value)>>> = Arc::default();
        let (record, flag) = (seen.clone(), started.clone());
        rig.set_script(Arc::new(move |run| {
            let (record, flag) = (record.clone(), flag.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                record.lock().unwrap().push((run.skill_selection.clone(), flag.load(SeqCst), run.input_body.clone()));
                crate::session::RunOutcome::Completed(Box::new(TurnResult { content: "all green".into(), iterations: 1, ..Default::default() }))
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let flag = started.clone();
        let settle = directory.run_routine_turn(routine("routine_1", &handle.id), Box::new(move || flag.store(true, SeqCst)), CancellationToken::new()).await;
        assert_eq!(settle, TurnSettle::Done { result: "all green".into() });
        let (skill, was_started, body) = seen.lock().unwrap()[0].clone();
        assert_eq!((skill.as_deref(), was_started), (Some("Check the build"), true));
        assert_eq!(body["content"], json!("Header\n\nCheck the build"));
        assert_eq!(body["meta"]["transcript"]["submissionIds"], json!(["routine_1"]));
        assert_eq!(body["meta"]["transcript"]["routineTrigger"], json!({ "kind": "schedule", "name": "daily" }));
        assert!(directory.home_thread_open(&handle.id).await.unwrap());
        assert!(!directory.home_thread_open(&ThreadId::from("sess_none")).await.unwrap());
    }

    /// A record read that the lane refuses is an error: not a closed or missing thread.
    #[tokio::test]
    async fn a_home_thread_record_that_was_not_read_is_an_error_not_a_closed_thread() {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let id = ThreadId::from("sess_none");
        assert!(!directory.home_thread_open(&id).await.unwrap());
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        assert!(directory.home_thread_open(&id).await.is_err());
        assert!(directory.try_stored_header(&id).await.is_err());
        // The lossy view for read-only callers still reads as unknown.
        assert!(directory.stored_header(&id).await.is_none());
    }

    /// A wake is one turn with the prompt as its input row, the submission id and the hop in its
    /// transcript meta (no marker row); its receiver answers with the end status.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_wake_runs_one_turn_and_answers_its_end_status() {
        let rig = Rig::new();
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let record = seen.clone();
        rig.set_script(Arc::new(move |run| {
            let record = record.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                record.lock().unwrap().push(run.input_body.clone());
                crate::session::RunOutcome::Completed(Box::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let status = directory.wake_turn(&handle.id, "A task reported back", "wake_1", 2).await.expect("accepted");
        assert_eq!(status.await.unwrap(), "done");
        let body = seen.lock().unwrap()[0].clone();
        assert_eq!(body["content"], json!("A task reported back"));
        assert_eq!(body["meta"]["transcript"]["submissionIds"], json!(["wake_1"]));
        assert_eq!(body["meta"]["transcript"]["hop"], json!(2));
        assert!(body["meta"]["transcript"].get("routineTrigger").is_none());
        assert!(directory.wake_turn(&ThreadId::from("sess_none"), "x", "wake_2", 0).await.is_none());
    }

    /// The `session` tool's send: the message is the input row, stamped as the tool's send is (`sender: 'lead'`, the bot that
    /// wrote into another bot's chat as `fromAgent`, its hop and chain); a thread there is none of does not take it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_session_tool_send_is_stamped_with_its_sender_and_chain() {
        let rig = Rig::new();
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let record = seen.clone();
        rig.set_script(Arc::new(move |run| {
            let record = record.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                record.lock().unwrap().push(run.input_body.clone());
                crate::session::RunOutcome::Completed(Box::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let chain = ["bob".to_owned(), "ann".to_owned()];
        assert!(directory.submit_session_message(&handle.id, &json!("From a bot"), "atask_1", 2, &chain, Some("ann")).await);
        eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 1).then_some(())).await;
        let body = seen.lock().unwrap()[0].clone();
        assert_eq!(body["content"], json!("From a bot"));
        assert_eq!(body["meta"]["transcript"]["submissionIds"], json!(["atask_1"]));
        assert_eq!(
            (&body["meta"]["transcript"]["sender"], &body["meta"]["transcript"]["fromAgent"], &body["meta"]["transcript"]["hop"], &body["meta"]["transcript"]["botChain"]),
            (&json!("lead"), &json!("ann"), &json!(2), &json!(["bob", "ann"]))
        );
        assert!(!directory.submit_session_message(&ThreadId::from("sess_none"), &json!("x"), "send_2", 0, &[], None).await);
    }

    /// A fire behind a running turn waits in the queue (never steered into it); cancelled there it
    /// leaves the queue and never runs. Every wait below is on a signal (the script's own, or a step
    /// of the thread's actor), never on the clock, so a loaded machine cannot change the outcome.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fire_behind_a_running_turn_waits_and_a_cancel_drops_it_unrun() {
        let rig = Rig::new();
        let hold = Arc::new(tokio::sync::Notify::new());
        let runs: Arc<Mutex<Vec<String>>> = Arc::default();
        let ran = Arc::new(tokio::sync::Notify::new());
        let (gate, record, said) = (hold.clone(), runs.clone(), ran.clone());
        rig.set_script(Arc::new(move |run| {
            let (gate, record, said) = (gate.clone(), record.clone(), said.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                record.lock().unwrap().push(run.input_body["content"].to_string());
                said.notify_waiters();
                gate.notified().await;
                crate::session::RunOutcome::Completed(Box::default())
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        turn(&handle, "user work", "op-1").await;
        eventually_on!(&[&ran, &handle.cell.stepped], || (runs.lock().unwrap().len() == 1).then_some(())).await;
        let cancel = CancellationToken::new();
        let waiting = {
            let (directory, cancel, thread) = (directory.clone(), cancel.clone(), handle.id.clone());
            tokio::spawn(async move { directory.run_routine_turn(routine("routine_2", &thread), Box::new(|| {}), cancel).await })
        };
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1).then_some(())).await;
        assert!(handle.cell.queued.load().len() == 1, "the fire rides the thread's queue");
        cancel.cancel();
        assert_eq!(waiting.await.unwrap(), TurnSettle::Cancelled);
        assert!(handle.cell.routine_starts.lock().unwrap().is_empty());
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().is_empty()).then_some(())).await;
        hold.notify_one();
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        assert_eq!(runs.lock().unwrap().len(), 1, "the dropped fire never ran");
    }
}
