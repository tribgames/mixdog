//! `followTaskToFinal` (`agent-task-sessions.mjs`): waits for the final answer of a task turn - the
//! end of the latest turn of its chain, once that chain has no turn running and no pending agent
//! work for the settle period - and reports every other answer of the chain as a progress update.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use super::chain::{Answer, Owed, owed_of, turn_chain};
use crate::bots::delivery::env::RetryTimer;
use crate::memory::cycles::requests::{spawn_work, wait};

/// A final answer waits this long, idle with nothing pending, before it is final: a finished
/// agent's result can start the Lead's next turn right after.
pub const FINAL_SETTLE: Duration = Duration::from_millis(2500);
/// While a report waits on pending work it re-checks this often.
pub const FINAL_POLL: Duration = Duration::from_millis(15_000);
const OWED_WAKE_TRIES: u32 = 3;
pub const GONE_TEXT: &str = "The session no longer exists.";
pub const RESUME_FAILED_TEXT: &str = "The agent task session could not continue after the app restarted: its agents\u{2019} results never reached it. Check that session.";

/// What the follow reads and does outside itself.
#[async_trait]
pub trait FollowHost: Send + Sync + 'static {
    /// `loadSession(id)`'s `messages`; `None` when the session is gone.
    async fn load_messages(&self, session_id: &str) -> Option<Vec<Value>>;
    /// The agent results queued for the session that no turn has taken yet.
    async fn owed_results(&self, session_id: &str) -> Vec<Owed>;
    /// Delivers a queued result through the notification bus; whether a session runtime took it.
    async fn deliver_completion(&self, session_id: &str, text: &str, meta: &Value) -> Result<bool, String>;
    /// `pendingWork(sessionId, { taskIds })`.
    async fn pending_work(&self, session_id: &str, task_ids: Option<&HashSet<String>>) -> bool;
    /// How the follow waits: the daemon's retry timer, a test's own.
    fn timer(&self) -> Arc<dyn RetryTimer>;
}

/// A live session runtime's state (`runtime.getState()`).
pub trait RuntimeView: Send + Sync + 'static {
    fn busy(&self) -> bool;
    /// The ids of the submissions queued behind the running turn.
    fn queued_ids(&self) -> Vec<String>;
    /// `state.toolApproval.id`: the approval the session waits on now, `None` while it waits on none.
    fn tool_approval_id(&self) -> Option<String> {
        None
    }
    /// `runtime.subscribe`: a message on every state change; dropping the receiver unsubscribes.
    fn subscribe(&self) -> tokio::sync::mpsc::UnboundedReceiver<()>;
}

pub type FinishFn = Arc<dyn Fn(String, String, String) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;
pub type InterimFn = Arc<dyn Fn(Answer) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// Arguments of one follow.
pub struct FollowArgs {
    pub session_id: String,
    pub run_id: String,
    pub runtime: Option<Arc<dyn RuntimeView>>,
    /// `runId`'s own end, when this process saw it: `(status, text)`.
    pub immediate: Option<(String, String)>,
    pub wake_owed: bool,
    /// Runs once: `(status, text, answerId)`.
    pub finish: FinishFn,
    pub interim: Option<InterimFn>,
    /// The last turn an earlier process reported (the watch's durable mark).
    pub progressed_through: String,
}

struct End {
    key: String,
    status: String,
    text: String,
    now: bool,
    id: String,
}

#[derive(Default)]
struct State {
    done: bool,
    checking: bool,
    again: bool,
    candidate: String,
    candidate_at: Option<Instant>,
    /// The armed wait: its generation and handle.
    timer: Option<(u64, AbortHandle)>,
    timer_generation: u64,
    wakes: u32,
    other_wakes: u32,
    woke_at: Option<Instant>,
    interim_ids: HashSet<String>,
}

enum Woke {
    Continue,
    Hold,
    End(End),
}

pub struct Follow {
    host: Arc<dyn FollowHost>,
    args: FollowArgs,
    settle: Duration,
    poll: Duration,
    state: Mutex<State>,
}

impl Follow {
    pub fn new(host: Arc<dyn FollowHost>, args: FollowArgs, settle: Duration, poll: Duration) -> Arc<Self> {
        Arc::new(Self { host, args, settle, poll, state: Mutex::default() })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("follow state")
    }

    /// The chain's ended answers, oldest first; `runId`'s own is `immediate` when this process saw it.
    fn answers_of(&self, stored: &[Answer], first: Option<&str>) -> Vec<Answer> {
        let Some((status, text)) = &self.args.immediate else { return stored.to_vec() };
        let first_id = first.filter(|f| !f.is_empty()).unwrap_or(&self.args.run_id).to_owned();
        let mut answers = vec![Answer { id: first_id.clone(), status: status.clone(), text: text.clone() }];
        answers.extend(stored.iter().filter(|a| a.id != first_id).cloned());
        answers
    }

    /// Hands `answer` to `interim` once; false when that failed, so it is tried again at the next
    /// check and no later answer goes out before it.
    async fn report_interim(&self, answer: Option<&Answer>) -> bool {
        let Some(answer) = answer.filter(|a| !a.id.is_empty() && !mixdog_js::js_trim(&a.text).is_empty()) else { return true };
        let Some(interim) = &self.args.interim else { return true };
        if self.lock().interim_ids.contains(&answer.id) {
            return true;
        }
        if let Err(error) = interim(answer.clone()).await {
            mixdog_rt::node_stderr!("mixdog task sessions: progress update of {} failed, retried at the next check: {error}", self.args.session_id);
            return false;
        }
        self.lock().interim_ids.insert(answer.id.clone());
        true
    }

    /// Reports, in order, every answer past the durable mark but `held` (the final candidate,
    /// reported only when it proves not final); false, stopping there, at the first that could not
    /// be queued.
    async fn report_earlier(&self, answers: &[Answer], held: Option<&Answer>) -> bool {
        // A mark stored before answers were named by their turn names runId for the first answer.
        let mark = if self.args.progressed_through == self.args.run_id { answers.first().map(|a| a.id.clone()) } else { Some(self.args.progressed_through.clone()) };
        let through = mark.filter(|m| !m.is_empty()).and_then(|m| answers.iter().position(|a| a.id == m));
        for (index, answer) in answers.iter().enumerate() {
            if through.is_some_and(|t| index <= t) {
                self.lock().interim_ids.insert(answer.id.clone());
            } else if held != Some(answer) && !self.report_interim(Some(answer)).await {
                return false;
            }
        }
        true
    }

    fn unwoken(&self, why: &str) -> Woke {
        mixdog_rt::node_stderr!("mixdog task sessions: {} could not take its agents' results after the restart: {why}", self.args.session_id);
        Woke::End(End { key: "unwoken".into(), status: "failed".into(), text: RESUME_FAILED_TEXT.into(), now: true, id: String::new() })
    }

    /// `wakeForOwed` (a restarted watch): delivers the agent results queued for the idle session
    /// through the notification bus so a turn takes them, at most [`OWED_WAKE_TRIES`] times, a poll
    /// apart. Only the results of the chain's tasks hold the report or fail it.
    async fn wake_for_owed(&self, task_ids: Option<&HashSet<String>>) -> Woke {
        let session = &self.args.session_id;
        let owed = self.host.owed_results(session).await;
        if owed.is_empty() {
            return Woke::Continue;
        }
        let in_chain: Vec<bool> = {
            let chain = owed_of(&owed, task_ids);
            owed.iter().map(|r| chain.iter().any(|c| std::ptr::eq(*c, r))).collect()
        };
        let chain_size = in_chain.iter().filter(|c| **c).count();
        let hold = if chain_size > 0 { Woke::Hold } else { Woke::Continue };
        {
            let state = self.lock();
            if state.woke_at.is_some_and(|at| at.elapsed() < self.poll) {
                return hold;
            }
            let tries = if chain_size > 0 { state.wakes } else { state.other_wakes };
            if tries >= OWED_WAKE_TRIES {
                let wakes = state.wakes;
                drop(state);
                return if chain_size > 0 { self.unwoken(&format!("still not taken after {wakes} deliveries")) } else { Woke::Continue };
            }
        }
        {
            let mut state = self.lock();
            if chain_size > 0 { state.wakes += 1 } else { state.other_wakes += 1 }
            state.woke_at = Some(Instant::now());
        }
        let outcomes = futures::future::join_all(owed.iter().map(|r| self.host.deliver_completion(session, &r.text, &r.meta))).await;
        if chain_size == 0 {
            return Woke::Continue;
        }
        let of_chain: Vec<&Result<bool, String>> = outcomes.iter().zip(&in_chain).filter(|(_, c)| **c).map(|(o, _)| o).collect();
        if let Some(why) = of_chain.iter().find_map(|o| o.as_ref().err()) {
            return self.unwoken(why);
        }
        if of_chain.iter().any(|o| matches!(o, Ok(true))) { Woke::Hold } else { self.unwoken("no session runtime took the delivery") }
    }

    fn arm(self: &Arc<Self>, after: Duration) {
        let this = Arc::clone(self);
        // Held across the spawn and the store: the task cannot reach its own clear before its
        // handle is recorded.
        let mut state = self.lock();
        state.timer_generation += 1;
        let generation = state.timer_generation;
        let timer = spawn_work("task-report-follow", async move {
            wait(this.host.timer().as_ref(), after).await;
            // The timer has fired: its handle no longer stands for a pending wait, so a `stop` from
            // the check below (the final report) cannot abort the task that is running it. Only
            // this timer's own record goes; a replacement armed meanwhile stays.
            {
                let mut state = this.lock();
                if state.timer.as_ref().is_some_and(|(g, _)| *g == generation) {
                    state.timer = None;
                }
            }
            this.check().await;
        });
        if let Some((_, old)) = state.timer.replace((generation, timer.abort_handle())) {
            old.abort();
        }
    }

    /// `stop`: ends the wait.
    pub fn stop(&self) {
        let mut state = self.lock();
        state.done = true;
        if let Some((_, timer)) = state.timer.take() {
            timer.abort();
        }
    }

    /// The end to report now, or none while the task still works.
    async fn ready(&self) -> Option<End> {
        let session = &self.args.session_id;
        let stored = self.host.load_messages(session).await;
        let latest = stored.as_deref().and_then(|messages| turn_chain(messages, &self.args.run_id));
        // The chain's agent tasks; the whole session without its provenance.
        let task_ids = latest.as_ref().filter(|l| !l.ambiguous).map(|l| l.task_ids.clone());
        let answers = self.answers_of(latest.as_ref().map_or(&[][..], |l| &l.answers), latest.as_ref().map(|l| l.first.as_str()));
        let latest_id = latest.as_ref().map_or(self.args.run_id.as_str(), |l| l.id.as_str());
        let answer = answers.last().filter(|a| a.id == latest_id).cloned();
        // An answer that could not be queued holds the chain until a later check queues it.
        if !self.report_earlier(&answers, answer.as_ref()).await {
            return None;
        }
        // A busy session may run the chain's turn unless that turn is provably another's.
        let busy = self.args.runtime.as_ref().is_some_and(|r| r.busy());
        if busy && !(task_ids.is_some() && latest.as_ref().is_some_and(|l| l.busy_is_others)) {
            return None;
        }
        if self.args.wake_owed && !busy {
            match self.wake_for_owed(task_ids.as_ref()).await {
                Woke::Continue => {}
                Woke::Hold => return None,
                Woke::End(end) => return Some(end),
            }
        }
        if self.host.pending_work(session, task_ids.as_ref()).await {
            self.report_interim(answer.as_ref()).await;
            return None;
        }
        if stored.is_none() && self.args.immediate.is_none() {
            return Some(End { key: "gone".into(), status: "cancelled".into(), text: GONE_TEXT.into(), now: false, id: String::new() });
        }
        // Provenance the chain needs is missing: its answer may not be final.
        if latest.as_ref().is_some_and(|l| l.ambiguous) {
            self.report_interim(answer.as_ref()).await;
            return None;
        }
        answer.map(|a| End { key: format!("{}:{}", a.id, a.status), status: a.status, text: a.text, now: false, id: a.id })
    }

    /// Re-evaluates; call it on every state change of the runtime.
    pub fn check(self: &Arc<Self>) -> BoxFuture<'static, ()> {
        let this = Arc::clone(self);
        Box::pin(async move {
            {
                let mut state = this.lock();
                if state.done {
                    return;
                }
                if state.checking {
                    state.again = true;
                    return;
                }
                state.checking = true;
            }
            loop {
                this.lock().again = false;
                let end = this.ready().await;
                if this.lock().done {
                    break;
                }
                match end {
                    None => {
                        this.lock().candidate.clear();
                        this.arm(this.poll);
                    }
                    Some(end) => {
                        let wait = {
                            let mut state = this.lock();
                            let waited = state.candidate_at.map(|at| at.elapsed());
                            if !end.now && !this.settle.is_zero() && (end.key != state.candidate || waited.is_none_or(|w| w < this.settle)) {
                                if end.key != state.candidate {
                                    state.candidate = end.key.clone();
                                    state.candidate_at = Some(Instant::now());
                                }
                                Some(this.settle.saturating_sub(state.candidate_at.map_or(Duration::ZERO, |at| at.elapsed())))
                            } else {
                                None
                            }
                        };
                        match wait {
                            // Final only if it is still the answer after the quiet period.
                            Some(wait) => this.arm(wait),
                            None => {
                                this.stop();
                                if let Err(error) = (this.args.finish)(end.status, end.text, end.id).await {
                                    mixdog_rt::node_stderr!("mixdog task sessions: following {} to its final answer failed: {error}", this.args.session_id);
                                }
                            }
                        }
                    }
                }
                let more = {
                    let state = this.lock();
                    state.again && !state.done
                };
                if !more {
                    break;
                }
            }
            this.lock().checking = false;
        })
    }
}
