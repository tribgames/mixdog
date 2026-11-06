//! `rearmTaskWatch`, `recoverTaskWatches` and `deliverWithRetries` (`agent-task-sessions.mjs`):
//! at daemon start every reporting turn an earlier process watched - and every turn of a bot's that
//! reported nothing but whose work it owned - is re-attached: its end is reported once from the
//! target's record, or watched until it ends.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use tokio::task::AbortHandle;

use super::chain::{Answer, submission_outcome, Outcome};
use super::follow::{FINAL_POLL, FINAL_SETTLE, Follow, FollowArgs, FollowHost, GONE_TEXT, RESUME_FAILED_TEXT, RuntimeView};
use super::{progress_run_id, turn_report_run_id};
use crate::memory::cycles::requests::spawn_work;

pub const LOST_TEXT: &str = "The message never ran: the app restarted before its turn started.";
/// Delays before the retries of a failed report.
pub const REPORT_RETRY_DELAYS: [Duration; 3] = [Duration::from_millis(200), Duration::from_millis(1000), Duration::from_millis(5000)];

/// What re-attaching a watch does outside itself.
#[async_trait]
pub trait RearmHost: FollowHost {
    /// Queues a report for the agent's home (`deliver(agentId, payload)`).
    async fn deliver(&self, agent_id: &str, payload: Value) -> Result<(), String>;
    /// Drops the durable record of quiet work (`watches.disown`).
    async fn disown(&self, run_id: &str) -> Result<(), String>;
    /// `materializeSession`: the session's runtime; it fails when the session can never load.
    async fn materialize_session(&self, session_id: &str) -> Result<Option<Arc<dyn RuntimeView>>, String>;
    /// The submission ids still queued for the session.
    async fn queued_submission_ids(&self, session_id: &str) -> Vec<String>;
    /// The files the turn produced, as report fields.
    async fn artifact_fields(&self, session_id: &str, turn_id: &str) -> Map<String, Value>;
    fn note_bot_work(&self, run_id: &str, session_id: &str, agent_id: &str);
    fn end_bot_work(&self, run_id: &str);
    /// `roomMemberOfSession(id)`: a group-room member session.
    fn is_room_member_session(&self, session_id: &str) -> bool;
    /// `watches.list()`: the reporting turns watched.
    async fn list_watches(&self) -> Result<Vec<Value>, String>;
    /// `watches.owned()`: the work that reports nothing but is the bot's.
    async fn owned_work(&self) -> Result<Vec<Value>, String>;
    /// Turns the agents the restart killed into queued failure results.
    async fn settle_agent_results(&self) -> Result<(), String>;
}

/// A stored watch (or record of quiet work).
#[derive(Clone, Debug)]
struct Watch {
    run_id: String,
    agent_id: String,
    home_session_id: String,
    task_session_id: String,
    title: String,
    target_session: bool,
    text_only: bool,
    hop: f64,
    follows: String,
    progressed: String,
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).filter(|v| !v.is_null()).map_or_else(String::new, mixdog_js::value_to_string)
}

impl Watch {
    fn of(value: &Value) -> Self {
        Self {
            run_id: text(value, "runId"),
            agent_id: text(value, "agentId"),
            home_session_id: text(value, "homeSessionId"),
            task_session_id: text(value, "taskSessionId"),
            title: text(value, "title"),
            target_session: value.get("target").and_then(Value::as_str) == Some("session"),
            text_only: value.get("textOnly").is_some_and(|t| !matches!(t, Value::Null | Value::Bool(false))),
            hop: value.get("hop").map_or(0.0, mixdog_js::to_number),
            follows: text(value, "follows"),
            progressed: text(value, "progressed"),
        }
    }
}

/// `deliverWithRetries`: delivers a report, retrying after each delay; the last failure is returned.
pub async fn deliver_with_retries(host: &dyn RearmHost, delays: &[Duration], agent_id: &str, session_id: &str, payload: Value) -> Result<(), String> {
    for attempt in 0.. {
        match host.deliver(agent_id, payload.clone()).await {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= delays.len() => return Err(error),
            Err(error) => {
                tracing::info!("report of {session_id} failed (try {}), retrying: {error}", attempt + 1);
                tokio::time::sleep(delays[attempt]).await;
            }
        }
    }
    unreachable!("the loop returns")
}

struct State {
    done: bool,
    checking: bool,
    again: bool,
    follow: Option<Arc<Follow>>,
    subscription: Option<AbortHandle>,
}

struct Rearm {
    host: Arc<dyn RearmHost>,
    watch: Watch,
    quiet: bool,
    /// The turn that answers: the watched submission's own, or the one it follows.
    turn_id: String,
    runtime: Option<Arc<dyn RuntimeView>>,
    state: Mutex<State>,
}

impl Rearm {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("rearm state")
    }

    fn sender_field(&self) -> Map<String, Value> {
        let mut out = Map::new();
        if self.host.is_room_member_session(&self.watch.home_session_id) {
            out.insert("from".into(), json!(self.watch.home_session_id));
        }
        out
    }

    /// Reports the end (or drops the record of quiet work). The work is the agent's until then.
    async fn finish(&self, status: &str, text: &str, answer_id: &str) -> Result<(), String> {
        let (watch, session) = (&self.watch, &self.watch.task_session_id);
        self.host.end_bot_work(&watch.run_id);
        if self.quiet {
            return self.host.disown(&watch.run_id).await;
        }
        let mut payload = Map::new();
        payload.insert("runId".into(), json!(turn_report_run_id(session, &watch.run_id, status, "", answer_id)));
        payload.insert("taskSessionId".into(), json!(session));
        payload.insert("title".into(), json!(watch.title));
        payload.insert("status".into(), json!(status));
        payload.insert("text".into(), json!(text));
        if watch.target_session {
            payload.insert("target".into(), json!("session"));
        }
        if watch.hop > 0.0 {
            payload.insert("hop".into(), mixdog_js::json_number(watch.hop));
        }
        payload.extend(self.sender_field());
        payload.insert("watchId".into(), json!(watch.run_id));
        if !answer_id.is_empty() {
            payload.insert("progressRunId".into(), json!(progress_run_id(session, answer_id)));
        }
        if !(watch.text_only || text == GONE_TEXT || text == LOST_TEXT) {
            payload.extend(self.host.artifact_fields(session, &self.turn_id).await);
        }
        self.host.deliver(&watch.agent_id, Value::Object(payload)).await
    }

    fn unsubscribe(&self) {
        if let Some(subscription) = self.lock().subscription.take() {
            subscription.abort();
        }
    }

    fn start_follow(self: &Arc<Self>) -> Arc<Follow> {
        let watch = &self.watch;
        let interim: Option<super::follow::InterimFn> = (!self.quiet).then(|| {
            let this = Arc::clone(self);
            Arc::new(move |answer: Answer| -> BoxFuture<'static, Result<(), String>> {
                let this = Arc::clone(&this);
                Box::pin(async move {
                    let (watch, session) = (&this.watch, this.watch.task_session_id.clone());
                    let mut payload = Map::new();
                    payload.insert("runId".into(), json!(progress_run_id(&session, &answer.id)));
                    payload.insert("taskSessionId".into(), json!(session));
                    payload.insert("title".into(), json!(watch.title));
                    payload.insert("status".into(), json!("working"));
                    payload.insert("text".into(), json!(answer.text));
                    payload.insert("progressWatchId".into(), json!(watch.run_id));
                    payload.insert("answerId".into(), json!(answer.id));
                    if watch.target_session {
                        payload.insert("target".into(), json!("session"));
                    }
                    if watch.hop > 0.0 {
                        payload.insert("hop".into(), mixdog_js::json_number(watch.hop));
                    }
                    payload.extend(this.sender_field());
                    this.host.deliver(&watch.agent_id, Value::Object(payload)).await
                })
            }) as super::follow::InterimFn
        });
        let this = Arc::clone(self);
        let finish: super::follow::FinishFn = Arc::new(move |status, text, answer_id| {
            let this = Arc::clone(&this);
            Box::pin(async move {
                this.lock().done = true;
                this.unsubscribe();
                this.finish(&status, &text, &answer_id).await
            })
        });
        let args = FollowArgs {
            session_id: watch.task_session_id.clone(),
            run_id: self.turn_id.clone(),
            runtime: self.runtime.clone(),
            immediate: None,
            // Only a report wakes the session for the results the restart left it; work that
            // reports nothing is only observed, never driven.
            wake_owed: !self.quiet,
            finish,
            interim,
            progressed_through: watch.progressed.clone(),
        };
        let follow_host: Arc<dyn FollowHost> = Arc::new(HostView(Arc::clone(&self.host)));
        Follow::new(follow_host, args, FINAL_SETTLE, FINAL_POLL)
    }

    async fn check(self: &Arc<Self>) {
        let follow = {
            let state = self.lock();
            if state.done {
                return;
            }
            state.follow.clone()
        };
        if let Some(follow) = follow {
            follow.check().await;
            return;
        }
        {
            let mut state = self.lock();
            if state.checking {
                state.again = true;
                return;
            }
            state.checking = true;
        }
        loop {
            self.lock().again = false;
            self.poll_outcome().await;
            let state = self.lock();
            if !(state.again && !state.done && state.follow.is_none()) {
                break;
            }
        }
        self.lock().checking = false;
        let follow = self.lock().follow.clone();
        if let Some(follow) = follow {
            follow.check().await;
        }
    }

    /// One look at the target's record: report the end, or switch to following the final answer.
    async fn poll_outcome(self: &Arc<Self>) {
        let session = &self.watch.task_session_id;
        let messages = self.host.load_messages(session).await.unwrap_or_default();
        let outcome = submission_outcome(&messages, &self.turn_id);
        let busy = self.runtime.as_ref().is_some_and(|r| r.busy());
        let mut end = match &outcome {
            Some(Outcome::Ended { status, text }) => Some((status.clone(), text.clone())),
            _ => None,
        };
        if end.is_none() && !busy {
            let queued = self.runtime.as_ref().is_some_and(|r| r.queued_ids().contains(&self.turn_id));
            if outcome == Some(Outcome::Open) && !queued {
                end = Some(("cancelled".into(), String::new()));
            } else if outcome.is_none() && !queued && !self.host.queued_submission_ids(session).await.contains(&self.turn_id) {
                end = Some(("cancelled".into(), LOST_TEXT.into()));
            }
        }
        match end {
            Some((status, _)) if status == "completed" => {
                let follow = self.start_follow();
                self.lock().follow = Some(follow);
            }
            Some((status, text)) => {
                self.lock().done = true;
                self.unsubscribe();
                if let Err(error) = self.finish(&status, &text, "").await {
                    tracing::info!("re-attaching {session} failed: {error}");
                }
            }
            None => {}
        }
    }
}

/// The follow's view of the host: every `RearmHost` is a `FollowHost`, but a trait object of one is
/// not a trait object of the other.
struct HostView(Arc<dyn RearmHost>);

#[async_trait]
impl FollowHost for HostView {
    async fn load_messages(&self, session_id: &str) -> Option<Vec<Value>> {
        self.0.load_messages(session_id).await
    }
    async fn owed_results(&self, session_id: &str) -> Vec<super::chain::Owed> {
        self.0.owed_results(session_id).await
    }
    async fn deliver_completion(&self, session_id: &str, text: &str, meta: &Value) -> Result<bool, String> {
        self.0.deliver_completion(session_id, text, meta).await
    }
    async fn pending_work(&self, session_id: &str, task_ids: Option<&HashSet<String>>) -> bool {
        self.0.pending_work(session_id, task_ids).await
    }
}

/// `rearmTaskWatch`: re-attaches one watch a stopped daemon left. `quiet`: `watch` is the record of
/// work that reports nothing (no home, no title): the same follow, but its end is only dropped from
/// the owned records and no progress update or report goes out.
pub async fn rearm_task_watch(host: Arc<dyn RearmHost>, watch: &Value, quiet: bool) -> Result<(), String> {
    let watch = Watch::of(watch);
    let session = watch.task_session_id.clone();
    let turn_id = if watch.follows.is_empty() { watch.run_id.clone() } else { watch.follows.clone() };
    let make = |runtime| {
        Arc::new(Rearm {
            host: Arc::clone(&host),
            watch: watch.clone(),
            quiet,
            turn_id: turn_id.clone(),
            runtime,
            state: Mutex::new(State { done: false, checking: false, again: false, follow: None, subscription: None }),
        })
    };
    if host.load_messages(&session).await.is_none() {
        return make(None).finish("cancelled", GONE_TEXT, "").await;
    }
    let runtime = match host.materialize_session(&session).await {
        Ok(runtime) => runtime,
        Err(error) => {
            // It can never take its agents' results: say so once instead of waiting.
            tracing::info!("{session} could not be loaded after the restart: {error}");
            return make(None).finish("failed", RESUME_FAILED_TEXT, "").await;
        }
    };
    host.note_bot_work(&watch.run_id, &session, &watch.agent_id);
    let rearm = make(runtime.clone());
    if let Some(runtime) = &runtime {
        let (mut changes, this) = (runtime.subscribe(), Arc::clone(&rearm));
        let forward = spawn_work("task-report-rearm", async move {
            while changes.recv().await.is_some() {
                this.check().await;
            }
        });
        rearm.lock().subscription = Some(forward.abort_handle());
    }
    rearm.check().await;
    Ok(())
}

/// `recoverTaskWatches`: the daemon-start pass. Resolves once each is reported or watched; the
/// number of watches and records re-attached.
pub async fn recover_task_watches(host: Arc<dyn RearmHost>, process_token: &str) -> usize {
    let earlier = |list: Vec<Value>| -> Vec<Value> { list.into_iter().filter(|e| e.get("owner").and_then(Value::as_str) != Some(process_token)).collect() };
    let pending = earlier(host.list_watches().await.unwrap_or_default());
    // A failed read of the quiet records never keeps the reporting turns from re-attaching.
    let quiet = match host.owned_work().await {
        Ok(list) => earlier(list),
        Err(error) => {
            tracing::info!("reading the records of bot work failed: {error}");
            Vec::new()
        }
    };
    // The agents the restart killed become queued failure results first, so each re-attached task
    // session has them to take.
    if !pending.is_empty()
        && let Err(error) = host.settle_agent_results().await
    {
        tracing::info!("settling the agents of the previous process failed: {error}");
    }
    let reattach = |work: Value, quiet: bool| {
        let host = Arc::clone(&host);
        async move {
            if let Err(error) = rearm_task_watch(host, &work, quiet).await {
                tracing::info!("re-attaching {} failed: {error}", text(&work, "taskSessionId"));
            }
        }
    };
    let count = pending.len() + quiet.len();
    futures::future::join_all(pending.into_iter().map(|w| reattach(w, false)).chain(quiet.into_iter().map(|w| reattach(w, true)))).await;
    count
}
