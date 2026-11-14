//! The connection attempts of the SSH connect flow and the questions ssh asks while one runs.
//!
//! An attempt is minted by the core when a host-key inspection is answered: it is bound to the protocol connection that asked
//! (`connect`, `cancel` and the answers to ssh's questions name it, and a connection that did not mint it cannot reach it) and
//! holds the inspection as the core saw it, never changed afterwards, so the key the user was shown is the key that is pinned.
//! Attempts and questions die with their connection, and a connection holds a handful at most.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{SshAskpass, SshAskpassKind, SshProgress};
use mixdog_core_api::ids::ConnectionId;
use mixdog_ssh::askpass::{AskpassKind, AskpassPrompter, AskpassQuestion, ASKPASS_TIMEOUT_MS};
use mixdog_ssh::command::SshTarget;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::AttemptContext;
use mixdog_ssh::host_key::HostKeyInspection;
use mixdog_ssh::session::Progress;
use tokio::sync::oneshot;

use crate::link::{LinkPool, LinkSpec};

/// How many attempts one connection holds at once.
pub const MAX_ATTEMPTS_PER_CALLER: usize = 8;
/// The longest answer to a question of ssh (in UTF-16 units, as the desktop counted them); a longer one cancels the question.
pub const MAX_SECRET_LENGTH: usize = 4096;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why a connect call is refused instead of answered with a result the dialog shows: the words a person reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptError(String);

impl AttemptError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for AttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for AttemptError {}

/// What the connect flow tells the connection that started it, while the call is still running.
pub trait ConnectionsPush: Send + Sync {
    /// A question of ssh for the user (`connections/ssh/askpass`); kind `close` withdraws it.
    fn askpass(&self, to: ConnectionId, question: SshAskpass);
    /// Where the attempt is (`connections/ssh/progress`).
    fn progress(&self, to: ConnectionId, progress: SshProgress);
}

/// The server links the connect flow opens and closes.
#[async_trait]
pub trait ServerLinks: Send + Sync {
    /// The link of this saved server is attached.
    fn is_open(&self, id: &str) -> bool;
    /// Connects when needed (see [`LinkPool::open`]).
    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError>;
    /// Detaches the link and cancels an attempt in flight.
    async fn close(&self, id: &str);
}

#[async_trait]
impl ServerLinks for LinkPool {
    fn is_open(&self, id: &str) -> bool {
        self.get(id).is_some_and(|link| !link.stopped())
    }

    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        LinkPool::open(self, spec, context, progress).await.map(|_link| ())
    }

    async fn close(&self, id: &str) {
        LinkPool::close(self, id).await;
    }
}

/// inspected: may connect once; connecting; restartable: found a daemon the user may replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptState {
    Inspected,
    Connecting,
    Restartable,
}

/// What changes while an attempt runs; held for short, synchronous steps only.
pub(crate) struct Run {
    pub state: AttemptState,
    /// The host key was dealt with (pinned or replaced); a restart does not pin again.
    pub key_handled: bool,
    pub record_id: String,
    pub was_open: bool,
}

pub struct Attempt {
    id: String,
    caller: ConnectionId,
    target: SshTarget,
    inspection: Arc<HostKeyInspection>,
    cancelled: AtomicBool,
    run: Mutex<Run>,
}

impl Attempt {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn caller(&self) -> ConnectionId {
        self.caller
    }

    pub fn target(&self) -> &SshTarget {
        &self.target
    }

    /// The pre-check as the core saw it; nothing changes it.
    pub fn inspection(&self) -> &HostKeyInspection {
        &self.inspection
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn run(&self) -> MutexGuard<'_, Run> {
        locked(&self.run)
    }
}

/// A question of ssh waiting for the answer of the connection it was put to.
struct Question {
    caller: ConnectionId,
    attempt_id: String,
    answer: oneshot::Sender<Option<String>>,
}

#[derive(Default)]
struct State {
    /// Oldest first.
    attempts: Vec<Arc<Attempt>>,
    questions: HashMap<String, Question>,
    /// Connections that closed: an attempt or a question put to one of them later would never be answered or cancelled.
    closed: HashSet<ConnectionId>,
}

pub struct Attempts {
    state: Mutex<State>,
    links: Arc<dyn ServerLinks>,
    push: Arc<dyn ConnectionsPush>,
}

impl Attempts {
    pub fn new(links: Arc<dyn ServerLinks>, push: Arc<dyn ConnectionsPush>) -> Arc<Self> {
        Arc::new(Self { state: Mutex::new(State::default()), links, push })
    }

    /// Opens an attempt for the connection, making room by dropping an idle one of its own.
    pub fn register(&self, caller: ConnectionId, target: SshTarget, inspection: HostKeyInspection) -> Result<Arc<Attempt>, AttemptError> {
        let mut state = locked(&self.state);
        if state.closed.contains(&caller) {
            return Err(AttemptError::new("This connection is closed."));
        }
        while state.attempts.iter().filter(|attempt| attempt.caller == caller).count() >= MAX_ATTEMPTS_PER_CALLER {
            let idle = state.attempts.iter().position(|attempt| attempt.caller == caller && attempt.run().state != AttemptState::Connecting);
            match idle {
                Some(at) => {
                    state.attempts.remove(at);
                }
                None => return Err(AttemptError::new("Too many SSH connections are being made at once.")),
            }
        }
        let attempt = Arc::new(Attempt {
            id: uuid::Uuid::new_v4().to_string(),
            caller,
            target,
            inspection: Arc::new(inspection),
            cancelled: AtomicBool::new(false),
            run: Mutex::new(Run { state: AttemptState::Inspected, key_handled: false, record_id: String::new(), was_open: false }),
        });
        state.attempts.push(attempt.clone());
        Ok(attempt)
    }

    /// The attempt the connection named; refused the same way when it is gone and when another connection minted it.
    pub fn owned(&self, caller: ConnectionId, attempt_id: &str) -> Result<Arc<Attempt>, AttemptError> {
        locked(&self.state)
            .attempts
            .iter()
            .find(|attempt| attempt.id == attempt_id && attempt.caller == caller)
            .cloned()
            .ok_or_else(|| AttemptError::new("This connection attempt is no longer active. Check the address again."))
    }

    pub fn drop_attempt(&self, attempt: &Attempt) {
        locked(&self.state).attempts.retain(|held| held.id != attempt.id);
    }

    /// Cancels the connection's own attempt by id; anything else is ignored.
    pub async fn cancel(&self, caller: ConnectionId, attempt_id: &str) {
        let attempt = locked(&self.state).attempts.iter().find(|attempt| attempt.id == attempt_id && attempt.caller == caller).cloned();
        if let Some(attempt) = attempt {
            self.cancel_attempt(&attempt).await;
        }
    }

    /// Ends an attempt that is not connecting; one that is stops where it is and gives its connection back.
    async fn cancel_attempt(&self, attempt: &Attempt) {
        attempt.cancelled.store(true, Ordering::SeqCst);
        let close = {
            let run = attempt.run();
            if run.state == AttemptState::Connecting {
                Some((!run.was_open && !run.record_id.is_empty()).then(|| run.record_id.clone()))
            } else {
                None
            }
        };
        match close {
            None => self.drop_attempt(attempt),
            Some(Some(id)) => self.links.close(&id).await,
            Some(None) => {}
        }
    }

    /// The protocol connection closed: its attempts are cancelled and its pending questions answer nothing.
    pub async fn caller_closed(&self, caller: ConnectionId) {
        let (attempts, questions) = {
            let mut state = locked(&self.state);
            state.closed.insert(caller);
            let attempts: Vec<Arc<Attempt>> = state.attempts.iter().filter(|attempt| attempt.caller == caller).cloned().collect();
            let ids: Vec<String> = state.questions.iter().filter(|(_, question)| question.caller == caller).map(|(id, _)| id.clone()).collect();
            let questions: Vec<Question> = ids.iter().filter_map(|id| state.questions.remove(id)).collect();
            (attempts, questions)
        };
        for question in questions {
            drop(question.answer.send(None));
        }
        for attempt in attempts {
            self.cancel_attempt(&attempt).await;
        }
    }

    /// The question's answer from the connection it was put to. Anything that does not match a pending question is ignored; an
    /// answer too long to be a password cancels the question.
    pub fn answer(&self, caller: ConnectionId, attempt_id: &str, request_id: &str, secret: Option<String>) {
        let question = {
            let mut state = locked(&self.state);
            match state.questions.get(request_id) {
                Some(question) if question.caller == caller && question.attempt_id == attempt_id => state.questions.remove(request_id),
                _ => None,
            }
        };
        if let Some(question) = question {
            drop(question.answer.send(secret.filter(|secret| secret.encode_utf16().count() <= MAX_SECRET_LENGTH)));
        }
    }

    /// What puts ssh's questions of this attempt in front of the user, on the connection that minted it.
    pub fn prompter(self: &Arc<Self>, attempt: Arc<Attempt>, host: String) -> Arc<dyn AskpassPrompter> {
        Arc::new(AttemptPrompter { attempts: self.clone(), caller: attempt.caller, id: attempt.id.clone(), attempt: Some(attempt), host })
    }

    /// What puts ssh's questions of another operation of `caller` (a server cleanup, named by the caller's own id) in front of
    /// the user; they are answered with `askpass_reply` naming that id, and answer nothing when the connection closes.
    pub fn operation_prompter(self: &Arc<Self>, caller: ConnectionId, operation_id: String, host: String) -> Arc<dyn AskpassPrompter> {
        Arc::new(AttemptPrompter { attempts: self.clone(), caller, id: operation_id, attempt: None, host })
    }

    pub(crate) fn push(&self) -> &dyn ConnectionsPush {
        self.push.as_ref()
    }

    pub(crate) fn links(&self) -> &dyn ServerLinks {
        self.links.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn attempt_count(&self, caller: ConnectionId) -> usize {
        locked(&self.state).attempts.iter().filter(|attempt| attempt.caller == caller).count()
    }

    #[cfg(test)]
    pub(crate) fn question_count(&self) -> usize {
        locked(&self.state).questions.len()
    }
}

struct AttemptPrompter {
    attempts: Arc<Attempts>,
    /// The connection the questions are put to.
    caller: ConnectionId,
    /// The connect attempt or operation the questions belong to.
    id: String,
    /// A connect attempt: once it is cancelled, no question is put.
    attempt: Option<Arc<Attempt>>,
    host: String,
}

fn kind_of(kind: AskpassKind) -> SshAskpassKind {
    match kind {
        AskpassKind::Passphrase => SshAskpassKind::Passphrase,
        AskpassKind::Password => SshAskpassKind::Password,
        AskpassKind::Otp => SshAskpassKind::Otp,
        AskpassKind::Other => SshAskpassKind::Other,
    }
}

/// Withdraws a question that was dropped before it was answered (it timed out or its session closed).
struct Withdraw<'a> {
    prompter: &'a AttemptPrompter,
    request_id: String,
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        let pending = locked(&self.prompter.attempts.state).questions.remove(&self.request_id).is_some();
        if pending {
            self.prompter.tell(&self.request_id, SshAskpassKind::Close, String::new(), false);
        }
    }
}

impl AttemptPrompter {
    fn tell(&self, request_id: &str, kind: SshAskpassKind, prompt: String, retry: bool) {
        self.attempts.push.askpass(
            self.caller,
            SshAskpass {
                attempt_id: self.id.clone(),
                request_id: request_id.to_owned(),
                kind,
                host: Some(self.host.clone()),
                prompt,
                retry,
                timeout_ms: u32::try_from(ASKPASS_TIMEOUT_MS).unwrap_or(u32::MAX),
            },
        );
    }
}

#[async_trait]
impl AskpassPrompter for AttemptPrompter {
    async fn ask(&self, question: AskpassQuestion) -> Option<String> {
        if self.attempt.as_ref().is_some_and(|attempt| attempt.cancelled()) {
            return None;
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (answer, answered) = oneshot::channel();
        {
            let mut state = locked(&self.attempts.state);
            if state.closed.contains(&self.caller) {
                return None;
            }
            state.questions.insert(request_id.clone(), Question { caller: self.caller, attempt_id: self.id.clone(), answer });
        }
        let _withdraw = Withdraw { prompter: self, request_id: request_id.clone() };
        self.tell(&request_id, kind_of(question.kind), question.prompt, question.retry);
        answered.await.ok().flatten()
    }
}
