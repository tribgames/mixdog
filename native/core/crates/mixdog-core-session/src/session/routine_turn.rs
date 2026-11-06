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
use serde_json::{Value, json};
use tokio::sync::oneshot;

use std::sync::Arc;

use super::SessionDirectory;
use super::SessionHandle;
use super::control::RoutineStart;
use super::seams::RunOutcome;

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
            skill_selection: None,
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

    /// `liveSessionBusy`: the thread is loaded here and runs a turn or holds queued input.
    pub fn thread_busy(&self, id: &ThreadId) -> bool {
        self.handle(id).is_some_and(|handle| handle.cell.run.load().is_some() || !handle.cell.queued.load().is_empty())
    }

    /// `loadSession(id)` is a session and `closed !== true`.
    pub async fn home_thread_open(&self, id: &ThreadId) -> bool {
        self.stored_header(id).await.is_some_and(|header| header.get("closed") != Some(&Value::Bool(true)))
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
            skill_selection: Some(turn.skill_selection.clone()),
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
                        let params = json!({ "threadId": thread, "opId": unqueue, "queuedId": queued });
                        let _ = handle.request(CoreRequest { method: Method("thread/queue/delete"), params, op: Some(unqueue), ctx }).await;
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
    use crate::session::tests::{eventually, idle, start_thread, turn};
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
        assert!(directory.home_thread_open(&handle.id).await);
        assert!(!directory.home_thread_open(&ThreadId::from("sess_none")).await);
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

    /// A fire behind a running turn waits in the queue (never steered into it); cancelled there it
    /// leaves the queue and never runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fire_behind_a_running_turn_waits_and_a_cancel_drops_it_unrun() {
        let rig = Rig::new();
        let hold = Arc::new(tokio::sync::Notify::new());
        let runs: Arc<Mutex<Vec<String>>> = Arc::default();
        let (gate, record) = (hold.clone(), runs.clone());
        rig.set_script(Arc::new(move |run| {
            let (gate, record) = (gate.clone(), record.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                record.lock().unwrap().push(run.input_body["content"].to_string());
                gate.notified().await;
                crate::session::RunOutcome::Completed(Box::default())
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        turn(&handle, "user work", "op-1").await;
        eventually(|| (runs.lock().unwrap().len() == 1).then_some(())).await;
        let cancel = CancellationToken::new();
        let waiting = {
            let (directory, cancel, thread) = (directory.clone(), cancel.clone(), handle.id.clone());
            tokio::spawn(async move { directory.run_routine_turn(routine("routine_2", &thread), Box::new(|| {}), cancel).await })
        };
        eventually(|| handle.cell.routine_starts.lock().unwrap().contains_key("routine_2").then_some(())).await;
        assert!(handle.cell.queued.load().len() == 1, "the fire rides the thread's queue");
        cancel.cancel();
        assert_eq!(waiting.await.unwrap(), TurnSettle::Cancelled);
        assert!(handle.cell.routine_starts.lock().unwrap().is_empty());
        eventually(|| (handle.cell.queued.load().is_empty()).then_some(())).await;
        hold.notify_one();
        eventually(|| idle(&handle).then_some(())).await;
        assert_eq!(runs.lock().unwrap().len(), 1, "the dropped fire never ran");
    }
}
