//! One process of an agent that serves every session of its preset ([`ProcessScope::Shared`]): started when the first
//! session needs it, kept while a session runs on it or is being opened on it, and closed once none does. The agent
//! tells its sessions apart by their ids, and so does this client: what the agent sends of a session reaches that
//! session alone, and each session keeps its own tool server, folder and settings.
//!
//! [`ProcessScope::Shared`]: crate::preset::ProcessScope::Shared

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_protocol::ThreadId;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agents::Agents;
use crate::agents::lock;
use crate::connection::Connection;
use crate::connection::Fault;
use crate::connection::Incoming;
use crate::connection::RpcError;
use crate::connection::Temp;
use crate::connection::remove_folder;
use crate::files::TextFiles;
use crate::files::read_text_file_with;
use crate::preset::AgentPreset;
use crate::session::AgentSession;
use crate::session::Program;
use crate::session::Routed;
use crate::session::close_session;
use crate::session::initialize_with;
use crate::session::launch;
use crate::session::not_offered;
use crate::session::unheld;

/// How long a server is given to end after its input ended: it ends the process it keeps for each session first.
pub(crate) fn grace(harnesses: usize) -> Duration {
    Duration::from_secs((2 + harnesses as u64).clamp(5, 12))
}

/// Numbers the temporary folders of this daemon's server starts.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// What the agents hold of a preset's shared server.
pub(crate) enum SharedSlot {
    /// Being started: every open that needs the server meanwhile waits for this one start, which `stop` ends
    /// gracefully and `cancel` aborts on startup timeout.
    Starting {
        id: u64,
        started: watch::Receiver<Option<Started>>,
        stop: CancellationToken,
        cancel: CancellationToken,
    },
    Running(Arc<SharedServer>),
}

/// Maximum abandoned session ids retained per shared server while sibling sessions keep it alive.
const MAX_ABANDONED: usize = 256;

struct AbandonedSessions {
    ids: HashSet<String>,
    order: VecDeque<String>,
    limit: usize,
}

impl Default for AbandonedSessions {
    fn default() -> Self {
        Self::with_limit(MAX_ABANDONED)
    }
}

impl AbandonedSessions {
    fn with_limit(limit: usize) -> Self {
        Self { ids: HashSet::new(), order: VecDeque::new(), limit }
    }

    fn insert(&mut self, session_id: &str) {
        if self.limit == 0 || self.ids.contains(session_id) {
            return;
        }
        while self.order.len() >= self.limit {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
        let owned = session_id.to_owned();
        self.order.push_back(owned.clone());
        self.ids.insert(owned);
    }

    fn contains(&self, session_id: &str) -> bool {
        self.ids.contains(session_id)
    }

    fn clear(&mut self) {
        self.ids.clear();
        self.order.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.ids.len()
    }
}

/// How a server's start ended.
#[derive(Clone)]
pub(crate) enum Started {
    Up(Arc<SharedServer>),
    Failed(Fault),
    /// Its stop came first, and it exited: an open that waited for it goes round.
    Stopped,
}

#[derive(Default)]
struct State {
    /// The sessions it serves, by the agent's id of each.
    sessions: HashMap<String, Weak<AgentSession>>,
    /// The prompts it has not answered yet, each with the id of its session.
    prompts: HashMap<u64, String>,
    /// Session ids detached while a prompt or cancel of theirs was still open: this server never resumes them.
    unclosed: HashSet<String>,
    /// Opens of a session under way on it.
    opening: usize,
    /// Active turn/RPC uses of sessions on this server (e.g. handover, `select_model`, prompt turn).
    active_uses: usize,
    /// The sessions it opened or reopened.
    opened: usize,
    /// At least one session left this server without `session/close`: retire the server as soon as it is quiescent so
    /// the server's per-session helper process exits instead of accumulating indefinitely.
    leaked: bool,
    /// Session ids left behind after a stuck cancel or interrupted setup, never to be reopened on this server.
    abandoned: AbandonedSessions,
    /// It takes no more sessions: it is being closed, or it has exited.
    retired: bool,
    /// What it sent of a session it does not serve while an open is under way, in order: the session being opened
    /// may be that one, which the server tells of before its open is answered.
    parked: Vec<Incoming>,
    /// The messages it has sent: one that goes on sending is at work, not wedged.
    heard: u64,
}

pub(crate) struct SharedServer {
    pub(crate) connection: Arc<Connection>,
    /// Its answer to `initialize`.
    pub(crate) capabilities: Value,
    preset: String,
    /// The hand-overs of the preset's account when it started: it holds the account that stood then.
    epoch: u64,
    agents: Weak<Agents>,
    files: Arc<dyn TextFiles>,
    /// Fires when the server begins retiring or exits, cancelling any in-flight `session/close` farewell.
    retiring: CancellationToken,
    state: Mutex<State>,
}

/// An open of a session under way on a server, which holds the server open until the session is registered with it.
pub(crate) struct Lease(Arc<SharedServer>);

impl Lease {
    pub(crate) fn server(&self) -> &Arc<SharedServer> {
        &self.0
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        // With no open under way, nothing kept is any session's.
        let unclaimed = {
            let mut state = lock(&self.0.state);
            state.opening -= 1;
            if state.opening == 0 { std::mem::take(&mut state.parked) } else { Vec::new() }
        };
        for message in unclaimed {
            self.0.unclaimed(message);
        }
        self.0.settle();
    }
}

/// Holds a shared server from retiring while a turn or session RPC is actively using a session on it.
pub(crate) struct SessionUse(Arc<SharedServer>);

impl Drop for SessionUse {
    fn drop(&mut self) {
        {
            let mut state = lock(&self.0.state);
            state.active_uses -= 1;
        }
        self.0.settle();
    }
}

fn is_quiescent(state: &State) -> bool {
    if state.opening > 0 || state.active_uses > 0 || !state.prompts.is_empty() {
        return false;
    }
    state.sessions.values().all(|weak| weak.upgrade().is_none_or(|session| session.gone.is_cancelled() || session.is_idle()))
}

/// The open session `id` names among `state`'s.
fn open_in(state: &State, id: &str) -> Option<Arc<AgentSession>> {
    state.sessions.get(id).and_then(Weak::upgrade).filter(|session| !session.gone.is_cancelled())
}

/// The session a request or a notification of the agent's names by its `sessionId`.
fn named_id(message: &Incoming) -> Option<&str> {
    match message {
        Incoming::Request { params, .. } | Incoming::Notification { params, .. } => params.get("sessionId").and_then(Value::as_str),
        _ => None,
    }
}

impl SharedServer {
    /// Starts `preset`'s server from `program` in a temporary folder of its own, and has it answer `initialize`; `None` for
    /// a start `stop` ended first, whose server is closed as the end of its input closes it.
    async fn start(
        agents: &Arc<Agents>,
        preset: &AgentPreset,
        program: &Program,
        stop: &CancellationToken,
        cancel: &CancellationToken,
    ) -> Result<Option<Arc<Self>>, Fault> {
        let cwd = AbsPath::new(agents.parts.probe_cwd.clone())
            .ok_or_else(|| Fault::Start(format!("{} is not an absolute folder to start the agent in", agents.parts.probe_cwd.display())))?;
        let files = agents.parts.files.clone();
        let epoch = agents.account_epoch(&preset.id);
        let temp = Temp { folder: agents.server_temp().await?, files: files.clone() };
        let (connection, incoming) = Connection::start_in(agents.parts.processes.clone(), launch(preset, program, cwd), Some(temp)).await?;
        let abort_init = |connection: Arc<Connection>| {
            agents.kill_and_track("acp.shared.init_abort", connection);
            Fault::Start(format!("{} did not initialize in time", preset.label))
        };
        if stop.is_cancelled() {
            connection.close_gracefully(grace(0)).await;
            return Ok(None);
        }
        if cancel.is_cancelled() {
            return Err(abort_init(connection));
        }
        // A server that does not answer (or whose startup is cancelled on timeout) is ended, and its temporary folder
        // goes with its exit; a graceful stop closes its input so it clears what it unpacked.
        let capabilities = tokio::select! {
            biased;
            () = stop.cancelled() => {
                connection.close_gracefully(grace(0)).await;
                return Ok(None);
            }
            () = cancel.cancelled() => return Err(abort_init(connection)),
            capabilities = initialize_with(&connection, preset.quirks.fs_read_text_file) => match capabilities {
                Ok(capabilities) => capabilities,
                Err(fault) => {
                    agents.kill_and_track("acp.shared.init_fail", connection);
                    return Err(fault);
                }
            },
        };
        let server = Arc::new(Self {
            connection,
            capabilities,
            preset: preset.id.clone(),
            epoch,
            agents: Arc::downgrade(agents),
            files,
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        });
        drop(mixdog_rt::spawn("acp.shared", TaskClass::Work, route(server.clone(), incoming)));
        Ok(Some(server))
    }

    /// The server for one more open of a session; `None` once it takes no more.
    pub(crate) fn lease(self: &Arc<Self>) -> Option<Lease> {
        let mut state = lock(&self.state);
        if state.retired || self.connection.exited().is_cancelled() {
            return None;
        }
        state.opening += 1;
        Some(Lease(self.clone()))
    }

    /// Marks a session on this server as actively in use by a turn or RPC; `None` once the server is retiring or exited.
    pub(crate) fn enter_use(self: &Arc<Self>) -> Option<SessionUse> {
        let mut state = lock(&self.state);
        if state.retired || self.connection.exited().is_cancelled() {
            return None;
        }
        state.active_uses += 1;
        Some(SessionUse(self.clone()))
    }

    /// `session` was opened on the server: what the agent sends of it reaches it from here. A server that has exited
    /// meanwhile has nothing more of it to send, and an earlier session under the same id is told apart from it no more.
    /// `true` for the first session the server opened. What the server sent of the session before its open was answered
    /// reaches it first, in order: what it sends later is delivered only once it finds the session here.
    pub(crate) fn register(self: &Arc<Self>, session: &Arc<AgentSession>) -> bool {
        let mut state = lock(&self.state);
        state.opened += 1;
        let first = state.opened == 1;
        let mut routed = Vec::new();
        let earlier = match state.retired {
            true => Some(session.clone()),
            false => {
                let earlier = state.sessions.insert(session.session_id.clone(), Arc::downgrade(session)).and_then(|earlier| earlier.upgrade());
                let (theirs, others): (Vec<Incoming>, Vec<Incoming>) =
                    std::mem::take(&mut state.parked).into_iter().partition(|message| named_id(message) == Some(session.session_id.as_str()));
                state.parked = others;
                routed = theirs.into_iter().filter_map(|message| self.hand(session, message)).collect();
                earlier
            }
        };
        drop(state);
        if let Some(gone) = earlier {
            gone.gone.cancel();
        }
        if !routed.is_empty() {
            let (server, session) = (self.clone(), session.clone());
            drop(mixdog_rt::spawn("acp.shared.parked", TaskClass::Work, async move {
                for routed in routed {
                    server.act(&session, routed).await;
                }
            }));
        }
        first
    }

    /// The first session the server opened was opened with `answer`: what the agent says of itself now is kept.
    pub(crate) async fn first_answered(&self, preset: &AgentPreset, answer: &Value) {
        if let Some(agents) = self.agents.upgrade() {
            agents.server_told(preset, &self.capabilities, answer, self.epoch).await;
        }
    }

    /// The prompt sent under `id` is `session`'s: its answer reaches that session.
    pub(crate) fn owns_prompt(&self, id: u64, session: &str) {
        lock(&self.state).prompts.insert(id, session.to_owned());
    }

    pub(crate) fn disown_prompt(self: &Arc<Self>, id: u64) {
        lock(&self.state).prompts.remove(&id);
        self.settle();
    }

    pub(crate) fn abandon(&self, session_id: &str) {
        lock(&self.state).abandoned.insert(session_id);
    }

    pub(crate) fn is_abandoned(&self, session_id: &str) -> bool {
        lock(&self.state).abandoned.contains(session_id)
    }

    pub(crate) fn retire_wedged(self: &Arc<Self>) {
        if let Some(agents) = self.agents.upgrade() {
            agents.retire_wedged_shared(self);
        } else {
            lock(&self.state).retired = true;
            self.retiring.cancel();
            self.connection.kill();
        }
    }

    /// How many messages the server has sent so far.
    pub(crate) fn heard(&self) -> u64 {
        lock(&self.state).heard
    }

    /// Whether `session_id` was detached from this server while a prompt or cancel of it was still open.
    pub(crate) fn is_unclosed(&self, session_id: &str) -> bool {
        lock(&self.state).unclosed.contains(session_id)
    }

    fn take_retirement(state: &mut State) -> Option<Vec<Arc<AgentSession>>> {
        state.sessions.retain(|_, weak| weak.strong_count() > 0);
        let retire = !state.retired && state.opening == 0 && (state.sessions.is_empty() || (state.leaked && is_quiescent(state)));
        if !retire {
            return None;
        }
        state.retired = true;
        state.parked.clear();
        Some(state.sessions.drain().filter_map(|(_, session)| session.upgrade()).collect())
    }

    fn begin_retirement(self: &Arc<Self>, remaining: Vec<Arc<AgentSession>>) {
        self.retiring.cancel();
        let server = self.clone();
        let closed = async move {
            server.stop().await;
        };
        // What a held session carries is taken before its end clears it.
        match self.agents.upgrade() {
            Some(agents) => agents.retire_server(self, closed),
            None => drop(mixdog_rt::spawn("acp.shared.retire", TaskClass::Work, closed)),
        }
        for session in remaining {
            session.gone.cancel();
        }
    }

    /// Takes `session` off the server alone: nothing more of it reaches it, and on a server that stays running the agent
    /// is asked to cancel an open prompt and close the session where it closes sessions. A retiring or stopping server
    /// skips `session/close` since its stdin is closing.
    pub(crate) fn detach(self: &Arc<Self>, session: &AgentSession) {
        let (held, removed_prompts, retire, already_retired) = {
            let mut state = lock(&self.state);
            let already_retired = state.retired;
            let held = state.sessions.get(&session.session_id).is_some_and(|held| std::ptr::eq(held.as_ptr(), session));
            let mut removed = Vec::new();
            if held {
                state.sessions.remove(&session.session_id);
                if !session.closes {
                    state.leaked = true;
                }
                state.prompts.retain(|id, owner| {
                    if *owner == session.session_id {
                        removed.push(*id);
                        false
                    } else {
                        true
                    }
                });
            }
            if !removed.is_empty() || session.holds_cancelled_prompt() || session.has_pending_cancel() {
                state.unclosed.insert(session.session_id.clone());
            }
            let retire = Self::take_retirement(&mut state);
            (held, removed, retire, already_retired)
        };
        let prompted = !removed_prompts.is_empty();
        for id in removed_prompts {
            self.connection.forget_sent(id);
        }
        session.gone.cancel();
        if let Some(remaining) = retire {
            self.begin_retirement(remaining);
            return;
        }
        let stopping = already_retired || self.agents.upgrade().is_some_and(|agents| agents.stopping.load(Ordering::SeqCst));
        let cancels = !stopping && prompted;
        let closes = !stopping && held && session.closes;
        if cancels || closes {
            let (connection, id, retiring) = (self.connection.clone(), session.session_id.clone(), self.retiring.clone());
            drop(mixdog_rt::spawn("acp.shared.close", TaskClass::Work, async move {
                if cancels {
                    let _ = connection.notify("session/cancel", json!({ "sessionId": id })).await;
                }
                if closes {
                    tokio::select! {
                        biased;
                        () = retiring.cancelled() => {}
                        () = close_session(&connection, &id) => {}
                    }
                }
            }));
        }
    }

    /// Closes a freshly created remote session that finished `session/new` on this shared server after the
    /// caller timed out or cancelled before consuming it.
    pub(crate) fn close_unregistered(self: &Arc<Self>, session_id: String, closes: bool) {
        if !closes {
            {
                let mut state = lock(&self.state);
                if !state.retired && open_in(&state, &session_id).is_none() {
                    state.leaked = true;
                }
            }
            self.settle();
            return;
        }
        let skip = {
            let state = lock(&self.state);
            state.retired || open_in(&state, &session_id).is_some()
        };
        let stopping = skip
            || self.retiring.is_cancelled()
            || self.connection.exited().is_cancelled()
            || self.agents.upgrade().is_some_and(|agents| agents.stopping.load(Ordering::SeqCst));
        if stopping || tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let server = self.clone();
        drop(mixdog_rt::spawn("acp.shared.close_unregistered", TaskClass::Work, async move {
            let skip = {
                let state = lock(&server.state);
                state.retired || open_in(&state, &session_id).is_some()
            };
            if skip || server.retiring.is_cancelled() || server.connection.exited().is_cancelled() {
                return;
            }
            tokio::select! {
                biased;
                () = server.retiring.cancelled() => {}
                () = close_session(&server.connection, &session_id) => {}
            }
        }));
    }

    /// Retires a shared server once nothing is opening on it and either no session remains or an unclosed (`!closes`)
    /// session left it and every remaining session is idle with no prompt in flight. The remaining sessions of loaded
    /// threads are reopened on a new server at once ([`Agents::reopen_held`]).
    pub(crate) fn settle(self: &Arc<Self>) {
        let retire = {
            let mut state = lock(&self.state);
            Self::take_retirement(&mut state)
        };
        if let Some(remaining) = retire {
            self.begin_retirement(remaining);
        }
    }

    /// Closes the server as the end of its input closes it, within the grace its sessions' processes need, and resolves
    /// once it has exited and its temporary folder is cleared away.
    pub(crate) async fn stop(&self) {
        let harnesses = {
            let mut state = lock(&self.state);
            state.retired = true;
            state.opened
        };
        self.retiring.cancel();
        self.connection.close_gracefully(grace(harnesses)).await;
    }

    /// Answers a request of the server's in a task of its own, bounded by `RefuseBudget::LIMIT` so a stalled stdin
    /// pipe breaks and retires the shared server instead of hanging forever.
    fn answer(self: &Arc<Self>, id: Value, result: Result<Value, RpcError>, why: &'static str) {
        let server = self.clone();
        drop(mixdog_rt::spawn("acp.shared.answer", TaskClass::Work, async move {
            server.respond_bounded(id, result, why).await;
        }));
    }

    /// What the server sent of a session it does not serve: a request is answered as one of no open session (a question
    /// cancelled, a read refused), and nothing else of it is kept.
    fn unclaimed(self: &Arc<Self>, message: Incoming) {
        if let Incoming::Request { id, method, .. } = message {
            self.answer(id, unheld(&method), "shared unclaimed request refusal timed out on stalled stdin");
        }
    }

    /// Sends `response` for `id` within `RefuseBudget::LIMIT`, breaking and retiring the shared server if stdin stalls.
    async fn respond_bounded(self: &Arc<Self>, id: Value, response: Result<Value, RpcError>, why: &str) {
        if self.connection.exited().is_cancelled() {
            return;
        }
        if mixdog_rt::time::timeout(crate::session::RefuseBudget::LIMIT, self.connection.respond(id, response)).await.is_err() {
            self.connection.break_off(why);
            self.retire_wedged();
        }
    }

    /// Hands `message` to `session`, the open session it is of: a read is answered from that session's folder alone, in a
    /// task of its own so the other sessions' messages do not wait for the file; the rest the session takes.
    fn hand(self: &Arc<Self>, session: &AgentSession, message: Incoming) -> Option<Routed> {
        match message {
            Incoming::Request { id, method, params } if method == "fs/read_text_file" => {
                if !session.preset.quirks.fs_read_text_file {
                    self.answer(id, Err(not_offered(&method)), "shared unsupported fs/read_text_file refusal timed out on stalled stdin");
                    return None;
                }
                let (connection, files, cwd) = (self.connection.clone(), self.files.clone(), session.cwd.clone());
                let allowed = session.attached_files();
                drop(mixdog_rt::spawn("acp.shared.read", TaskClass::Work, async move {
                    connection.respond(id, read_text_file_with(files.as_ref(), &cwd, &allowed, &params).await).await;
                }));
                None
            }
            message => Some(session.take(message)),
        }
    }

    async fn act(self: &Arc<Self>, session: &AgentSession, routed: Routed) {
        match routed {
            Routed::Refuse(id) => {
                self.answer(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })), "shared permission refusal timed out on stalled stdin");
            }
            routed => session.act(routed).await,
        }
    }

    /// Hands `message` to the session it is of. What names a session that is not open is kept while an open is under
    /// way, for the session being opened may be that one; else it is [`Self::unclaimed`].
    async fn deliver(self: &Arc<Self>, message: Incoming) {
        lock(&self.state).heard += 1;
        let is_response = matches!(message, Incoming::Response { .. });
        let named = match &message {
            Incoming::Request { id, method, .. } if method != "fs/read_text_file" && method != "session/request_permission" => {
                self.answer(id.clone(), Err(not_offered(method)), "shared unsupported method refusal timed out on stalled stdin");
                return;
            }
            Incoming::Response { id, .. } => lock(&self.state).prompts.remove(id),
            // A session's tool calls reach it through its own tool server.
            Incoming::Tool(_) => return,
            message => named_id(message).map(str::to_owned),
        };
        let session = {
            let mut state = lock(&self.state);
            match named.as_deref().and_then(|id| open_in(&state, id)) {
                Some(session) => session,
                None if named.as_deref().is_some_and(|id| !state.unclosed.contains(id)) && state.opening > 0 && !is_response => {
                    state.parked.push(message);
                    return;
                }
                None => {
                    drop(state);
                    self.unclaimed(message);
                    if is_response {
                        self.settle();
                    }
                    return;
                }
            }
        };
        if let Some(routed) = self.hand(&session, message) {
            self.act(&session, routed).await;
        }
        if is_response {
            self.settle();
        }
    }

    /// The process ended and all it wrote was delivered: the next session starts a new server, and every session it
    /// served is told it is gone, which fails a turn that runs and closes the session's tool server.
    fn ended(self: &Arc<Self>) {
        let sessions: Vec<Arc<AgentSession>> = {
            let mut state = lock(&self.state);
            state.retired = true;
            state.prompts.clear();
            state.abandoned.clear();
            state.parked.clear();
            state.sessions.drain().filter_map(|(_, session)| session.upgrade()).collect()
        };
        self.retiring.cancel();
        if let Some(agents) = self.agents.upgrade() {
            agents.forget_shared(self);
        }
        for session in sessions {
            session.gone.cancel();
        }
    }

    #[cfg(test)]
    pub(crate) fn test_server_for(connection: Arc<Connection>, files: Arc<dyn TextFiles>, preset: &str) -> Arc<Self> {
        Arc::new(Self {
            connection,
            capabilities: json!({}),
            preset: preset.to_owned(),
            epoch: 0,
            agents: std::sync::Weak::new(),
            files,
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        })
    }
}

/// Delivers what the server sends, in the order it sent it, until it has exited.
async fn route(server: Arc<SharedServer>, mut incoming: mpsc::UnboundedReceiver<Incoming>) {
    while let Some(message) = incoming.recv().await {
        server.deliver(message).await;
    }
    server.ended();
}

impl Agents {
    /// `preset`'s running server, started from `program` where none runs: one start at a time, which every open that
    /// needs the server meanwhile waits for. The lease holds the server open until the session is registered with it.
    /// The returned boolean is `true` when the lease came from an already-running shared server.
    pub(crate) async fn shared_server_bounded(
        self: &Arc<Self>,
        preset: &AgentPreset,
        program: &Program,
        deadline: Option<tokio::time::Instant>,
    ) -> Result<(Lease, bool), Fault> {
        loop {
            let (slot_id, mut started) = {
                let mut shared = lock(&self.shared);
                // The app's stop drains the servers under this lock after it set `stopping`: none starts behind it.
                self.may_open(preset)?;
                let found = match shared.get(&preset.id) {
                    Some(SharedSlot::Running(server)) => Ok(server.clone()),
                    Some(SharedSlot::Starting { id, started, .. }) => Err(Some((*id, started.clone()))),
                    None => Err(None),
                };
                match found {
                    Ok(server) => match server.lease() {
                        Some(lease) => return Ok((lease, true)),
                        // One being closed takes no session: the next is started.
                        None => self.start_shared(&mut shared, preset, program),
                    },
                    Err(Some(starting)) => starting,
                    Err(None) => self.start_shared(&mut shared, preset, program),
                }
            };
            let outcome = match deadline {
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                    if remaining.is_zero() {
                        self.fail_starting_shared(&preset.id, slot_id);
                        return Err(Fault::Start(format!("{} did not initialize in time", preset.label)));
                    }
                    match mixdog_rt::time::timeout(remaining, started.wait_for(Option::is_some)).await {
                        Ok(res) => res.ok().and_then(|outcome| outcome.clone()),
                        Err(_) => {
                            self.fail_starting_shared(&preset.id, slot_id);
                            return Err(Fault::Start(format!("{} did not initialize in time", preset.label)));
                        }
                    }
                }
                None => started.wait_for(Option::is_some).await.ok().and_then(|outcome| outcome.clone()),
            };
            match outcome {
                Some(Started::Up(server)) => {
                    // The switch or the app's stop may have come while it started: it is leased under the lock they are
                    // taken under, as a running one is. One taken out of use meanwhile (it holds an account left) is not
                    // leased: the open goes round and starts the next.
                    let lease = {
                        let shared = lock(&self.shared);
                        self.may_open(preset)?;
                        let held = matches!(shared.get(&preset.id), Some(SharedSlot::Running(held)) if Arc::ptr_eq(held, &server));
                        held.then(|| server.lease()).flatten()
                    };
                    if let Some(lease) = lease {
                        return Ok((lease, false));
                    }
                }
                Some(Started::Failed(fault)) => return Err(fault),
                // Stopped while it started (the app's stop, a sign-out, an account left): the open goes round, and is
                // refused where no server may start now.
                Some(Started::Stopped) => {}
                None => return Err(Fault::Start("its start was ended".to_owned())),
            }
        }
    }

    fn fail_starting_shared(&self, preset_id: &str, id: u64) {
        let mut shared = lock(&self.shared);
        let matches = matches!(shared.get(preset_id), Some(SharedSlot::Starting { id: slot, .. }) if *slot == id);
        if matches && let Some(SharedSlot::Starting { cancel, .. }) = shared.remove(preset_id) {
            cancel.cancel();
        }
    }

    /// Whether a session may open on `preset`'s shared server now: the feature is on, the app is not stopping, and the
    /// preset is not being signed out. Asked under the servers' lock.
    fn may_open(&self, preset: &AgentPreset) -> Result<(), Fault> {
        if !self.enabled() || self.stopping.load(Ordering::SeqCst) {
            return Err(Fault::Start("ACP agents are turned off, or the app is stopping".to_owned()));
        }
        if lock(&self.signing_out).contains(&preset.id) {
            return Err(Fault::Start(format!("{} is being signed out", preset.label)));
        }
        Ok(())
    }

    /// Starts `preset`'s server in a task of its own, which no open's end stops: its outcome is told on the returned
    /// channel. A start whose slot was taken meanwhile (the feature turned off, the app stopping, or timed out) is
    /// cancelled and closed cleanly.
    fn start_shared(
        self: &Arc<Self>,
        shared: &mut HashMap<String, SharedSlot>,
        preset: &AgentPreset,
        program: &Program,
    ) -> (u64, watch::Receiver<Option<Started>>) {
        let id = self.next_check.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let stop = CancellationToken::new();
        let (tell, started) = watch::channel(None);
        shared.insert(preset.id.clone(), SharedSlot::Starting { id, started: started.clone(), stop: stop.clone(), cancel: cancel.clone() });
        let (agents, preset, program) = (self.clone(), preset.clone(), program.clone());
        drop(mixdog_rt::spawn("acp.shared.start", TaskClass::Work, async move {
            let outcome = match SharedServer::start(&agents, &preset, &program, &stop, &cancel).await {
                Ok(Some(server)) => Started::Up(server),
                Ok(None) => Started::Stopped,
                Err(fault) => Started::Failed(fault),
            };
            // Held until every open that waited for the start has leased the server or given up: a server none of
            // them leases serves no session, and the hold's end closes it as such.
            let (held, timed_out_orphan) = {
                let mut shared = lock(&agents.shared);
                let current = matches!(shared.get(&preset.id), Some(SharedSlot::Starting { id: slot, .. }) if *slot == id);
                match &outcome {
                    Started::Up(server) if current => {
                        shared.insert(preset.id.clone(), SharedSlot::Running(server.clone()));
                        (server.lease(), None)
                    }
                    Started::Up(server) if cancel.is_cancelled() => (None, Some(server.clone())),
                    Started::Up(_) => (None, None),
                    Started::Failed(_) | Started::Stopped => {
                        if current {
                            shared.remove(&preset.id);
                        }
                        (None, None)
                    }
                }
            };
            let outcome = if let Some(server) = timed_out_orphan {
                server.connection.kill();
                agents.track_stop(mixdog_rt::spawn("acp.shared.orphan", TaskClass::Work, async move {
                    server.stop().await;
                }));
                Started::Failed(Fault::Start(format!("{} did not initialize in time", preset.label)))
            } else {
                outcome
            };
            let _ = tell.send(Some(outcome));
            if held.is_some() {
                tell.closed().await;
            }
            drop(held);
        }));
        (id, started)
    }

    /// `server` serves no more sessions: the next one starts a new server.
    pub(crate) fn forget_shared(&self, server: &Arc<SharedServer>) {
        Self::forget_in(&mut lock(&self.shared), server);
    }

    fn forget_in(shared: &mut HashMap<String, SharedSlot>, server: &Arc<SharedServer>) {
        if matches!(shared.get(&server.preset), Some(SharedSlot::Running(held)) if Arc::ptr_eq(held, server)) {
            shared.remove(&server.preset);
        }
    }

    /// `server` is retired: it leaves the servers in use and is `closed` in a task the app's stop waits for, in one step
    /// under the servers' lock, so a stop of the app never finds it in neither. The sessions still on `server` leave
    /// `self.sessions` at once, and those of loaded threads reopen on a new server ([`Self::reopen_held`]).
    fn retire_server(self: &Arc<Self>, server: &Arc<SharedServer>, closed: impl Future<Output = ()> + Send + 'static) {
        {
            let mut shared = lock(&self.shared);
            Self::forget_in(&mut shared, server);
            self.track_stop(mixdog_rt::spawn("acp.shared.retire", TaskClass::Work, closed));
        }
        self.reopen_held(server);
    }

    /// `preset_id`'s shared server while it runs and takes sessions, held open as an open of a session on it holds it.
    pub(crate) fn lease_shared(&self, preset_id: &str) -> Option<Lease> {
        match lock(&self.shared).get(preset_id) {
            Some(SharedSlot::Running(server)) => server.lease(),
            _ => None,
        }
    }

    /// A stop of a shared server under way: the app's stop waits for it. A server's stop is tracked under the servers' lock
    /// it leaves them under (taken before this one).
    pub(crate) fn track_stop(&self, stopping: JoinHandle<()>) {
        let mut stops = lock(&self.stops);
        stops.retain(|stop| !stop.is_finished());
        stops.push(stopping);
    }

    /// Closes `slot`'s server, which just left `_shared` (the servers, whose lock the caller holds), in a task the app's stop
    /// waits for: one still starting is stopped where it waits for the agent's answer; the receiver is told once it has exited.
    fn stop_slot(&self, _shared: &mut HashMap<String, SharedSlot>, slot: SharedSlot) -> tokio::sync::oneshot::Receiver<()> {
        // It takes no session from here, and the last of its sessions to leave it does not close it a second time.
        if let SharedSlot::Running(server) = &slot {
            lock(&server.state).retired = true;
            server.retiring.cancel();
        }
        let (done, stopped) = tokio::sync::oneshot::channel();
        self.track_stop(mixdog_rt::spawn("acp.shared.stop", TaskClass::Work, async move {
            let server = match slot {
                SharedSlot::Running(server) => Some(server),
                SharedSlot::Starting { mut started, stop, .. } => {
                    stop.cancel();
                    match started.wait_for(Option::is_some).await.ok().and_then(|outcome| outcome.clone()) {
                        Some(Started::Up(server)) => Some(server),
                        _ => None,
                    }
                }
            };
            if let Some(server) = server {
                server.stop().await;
            }
            let _ = done.send(());
        }));
        stopped
    }

    /// Closes every shared server, each as the end of its input closes it, in tasks the app's stop waits for.
    pub(crate) fn close_shared(&self) {
        let mut shared = lock(&self.shared);
        let slots: Vec<SharedSlot> = shared.drain().map(|(_, slot)| slot).collect();
        for slot in slots {
            drop(self.stop_slot(&mut shared, slot));
        }
    }

    fn kill_and_track(&self, task: &'static str, connection: Arc<Connection>) {
        connection.kill();
        self.track_stop(mixdog_rt::spawn(task, TaskClass::Work, async move {
            connection.exited().cancelled().await;
        }));
    }

    fn end_sessions(&self, mut matches: impl FnMut(&AgentSession) -> bool) {
        let victims: Vec<Arc<AgentSession>> = {
            let mut sessions = lock(&self.sessions);
            let threads: Vec<ThreadId> = sessions.iter().filter(|(_, session)| matches(session)).map(|(thread, _)| thread.clone()).collect();
            threads.into_iter().filter_map(|thread| sessions.remove(&thread)).collect()
        };
        for session in victims {
            session.end();
        }
    }

    /// Retires and kills a wedged shared server immediately so the next open starts a fresh process instead of
    /// hanging behind a stalled stdin pipe. Only removes `server` if it is still the preset's active shared server,
    /// and removes only sessions belonging to `server` atomically under the sessions lock so a thread that already
    /// reopened on a healthy replacement server is never terminated.
    pub(crate) fn retire_wedged_shared(&self, server: &Arc<SharedServer>) {
        {
            let mut shared = lock(&self.shared);
            Self::forget_in(&mut shared, server);
            lock(&server.state).retired = true;
            self.kill_and_track("acp.shared.kill", server.connection.clone());
        }
        self.end_sessions(|session| session.on_server(server));
    }

    /// Takes `preset_id`'s shared server out of use and its sessions off it, and begins closing it in a task the app's stop
    /// waits for: it holds an account the user left. The next session starts a new server. The receiver is told once it
    /// has exited; `None` where none ran.
    pub(crate) fn retire_shared(&self, preset_id: &str) -> Option<tokio::sync::oneshot::Receiver<()>> {
        // Out of use before its sessions leave it: the last to leave does not close it apart from this stop.
        let stopped = {
            let mut shared = lock(&self.shared);
            shared.remove(preset_id).map(|slot| self.stop_slot(&mut shared, slot))
        };
        self.end_sessions(|session| session.preset.id == preset_id);
        stopped
    }

    /// [`Self::retire_shared`], resolving once the server has exited.
    pub(crate) async fn stop_shared(&self, preset_id: &str) {
        if let Some(stopped) = self.retire_shared(preset_id) {
            let _ = stopped.await;
        }
    }

    /// The app stops: every running agent session (per-session or shared, including idle-unloaded threads) and shared
    /// server is closed and none starts from here on. Resolves once every agent process whose stop began has exited.
    pub async fn shutdown(&self) {
        // Set under the servers' lock, which every start and lease checks it under, and every stop that began is tracked
        // under: from here none starts, and each one stopping is in `stops`.
        {
            let _shared = lock(&self.shared);
            self.stopping.store(true, Ordering::SeqCst);
            self.stop_token.cancel();
        }
        let sessions: Vec<_> = {
            let mut sessions = lock(&self.sessions);
            lock(&self.opening).clear();
            lock(&self.grants).clear();
            sessions.drain().collect()
        };
        for (_, session) in sessions {
            let own = session.own_connection();
            session.end();
            if let Some(connection) = own {
                self.track_stop(mixdog_rt::spawn("acp.session.kill", TaskClass::Work, async move {
                    connection.exited().cancelled().await;
                }));
            }
        }
        self.close_shared();
        self.forget_checks();
        let logins: Vec<_> = lock(&self.logins).drain().collect();
        for (_, login) in logins {
            login.cancel();
        }
        loop {
            let stops: Vec<JoinHandle<()>> = lock(&self.stops).drain(..).collect();
            if stops.is_empty() {
                return;
            }
            for stop in stops {
                let _ = stop.await;
            }
        }
    }

    /// A temporary folder of its own for one start of an agent's server, `<acp data>/tmp/pid-<daemon pid>-<n>`.
    pub(crate) async fn server_temp(&self) -> Result<AbsPath, Fault> {
        let root = self.parts.data_dir.join("tmp");
        let folder = root.join(format!("pid-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        let folder = AbsPath::new(folder).ok_or_else(|| Fault::Start(format!("{} is not an absolute folder", root.display())))?;
        self.parts.files.make_folder(folder.clone()).await.map_err(|error| Fault::Start(format!("its temporary folder was not made: {error}")))?;
        Ok(folder)
    }

    /// The daemon's start: clears away what earlier runs left behind and nothing uses now (the temporary folders of servers
    /// of daemons gone since, stale per-search sandbox folders, builds that are not the installed one, the staging homes of
    /// sign-ins that did not end).
    pub async fn sweep_leftovers(&self) {
        self.sweep_temps().await;
        self.sweep_search_sandboxes().await;
        self.sweep_image_sandboxes().await;
        self.sweep_builds().await;
    }

    /// Clears away the temporary folders of the agents' servers that daemons gone since left behind: what their servers
    /// unpacked when they were ended by force.
    async fn sweep_temps(&self) {
        let Some(root) = AbsPath::new(self.parts.data_dir.join("tmp")) else { return };
        let Ok(folders) = self.parts.files.folders(root.clone()).await else { return };
        for name in folders {
            let pid = name.strip_prefix("pid-").and_then(|rest| rest.split('-').next()).and_then(|pid| pid.parse::<u32>().ok());
            if pid.is_some_and(|pid| pid != std::process::id() && !mixdog_statefile::process_exists(pid))
                && let Some(folder) = AbsPath::new(root.as_path().join(&name))
            {
                remove_folder(self.parts.files.as_ref(), folder, crate::connection::TEMP_FOLDER).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abandoned_sessions_are_bounded_while_sibling_keeps_server_open() {
        let mut state = State::default();
        // Simulate a sibling session keeping this shared server alive.
        state.opening = 1;

        let total = MAX_ABANDONED + 100;
        for i in 0..total {
            state.abandoned.insert(&format!("sess-{i}"));
            assert!(state.abandoned.len() <= MAX_ABANDONED, "abandoned set exceeded bound at step {i}");
        }

        assert_eq!(state.abandoned.len(), MAX_ABANDONED);
        for i in 0..100 {
            assert!(!state.abandoned.contains(&format!("sess-{i}")), "oldest abandoned id sess-{i} should be evicted");
        }
        for i in 100..total {
            assert!(state.abandoned.contains(&format!("sess-{i}")), "recent abandoned id sess-{i} should be retained");
        }

        // Re-abandoning an already tracked session id does not grow or evict other entries.
        state.abandoned.insert("sess-100");
        assert_eq!(state.abandoned.len(), MAX_ABANDONED);
        assert!(state.abandoned.contains("sess-100"));
        assert!(state.abandoned.contains(&format!("sess-{}", total - 1)));

        // Clearing on server end reclaims all retained ids.
        state.abandoned.clear();
        assert_eq!(state.abandoned.len(), 0);
    }

    struct SharedTestEvents(tokio::sync::Notify);

    #[async_trait::async_trait]
    impl mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent> for SharedTestEvents {
        async fn next(&mut self) -> Option<mixdog_core_api::domain::process::ProcessEvent> {
            self.0.notified().await;
            None
        }
    }

    struct SharedTestProcesses {
        killed: Arc<std::sync::atomic::AtomicBool>,
        gate_prompts: bool,
        prompt_started: Arc<tokio::sync::Notify>,
        drain_gate: Arc<tokio::sync::Notify>,
        delivered: Arc<Mutex<Vec<String>>>,
        delivered_notify: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl mixdog_core_api::domain::process::ProcessManager for SharedTestProcesses {
        async fn spawn(
            &self,
            request: mixdog_core_api::domain::process::SpawnRequest,
        ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
            Ok(mixdog_core_api::domain::process::SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(
            &self,
            _handle: &mixdog_protocol::ProcessHandle,
            _from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            Ok(Box::new(SharedTestEvents(tokio::sync::Notify::new())))
        }

        fn subscribe_holding(
            &self,
            handle: &mixdog_protocol::ProcessHandle,
            from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, _handle: &mixdog_protocol::ProcessHandle, bytes: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            let line = String::from_utf8_lossy(&bytes).into_owned();
            if self.gate_prompts && line.contains("\"session/prompt\"") {
                self.prompt_started.notify_waiters();
                let delivered = self.delivered.clone();
                let delivered_notify = self.delivered_notify.clone();
                let drain_gate = self.drain_gate.clone();
                // Model LocalProcessManager post-admission: dropping the caller does not un-admit bytes.
                let task = tokio::spawn(async move {
                    drain_gate.notified().await;
                    delivered.lock().unwrap().push(line);
                    delivered_notify.notify_waiters();
                });
                let _ = task.await;
                return Ok(());
            }
            self.delivered.lock().unwrap().push(line);
            self.delivered_notify.notify_waiters();
            Ok(())
        }

        fn close_stdin(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }

        fn resize_pty(
            &self,
            _handle: &mixdog_protocol::ProcessHandle,
            _size: mixdog_core_api::domain::process::PtySize,
        ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }

        fn kill(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    struct DummyFiles;

    #[async_trait::async_trait]
    impl TextFiles for DummyFiles {
        async fn read(&self, _: AbsPath) -> Result<String, String> {
            Err("unused".into())
        }
        async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
            Ok(path)
        }
        async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
            Ok(())
        }
        async fn make_folder(&self, _: AbsPath) -> Result<(), String> {
            Ok(())
        }
        async fn remove_folder(&self, _: AbsPath) -> Result<(), String> {
            Ok(())
        }
        async fn folders(&self, _: AbsPath) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        async fn replace(&self, _: AbsPath, _: String) -> Result<(), String> {
            Ok(())
        }
        async fn rename(&self, _: AbsPath, _: AbsPath) -> Result<(), String> {
            Ok(())
        }
    }

    struct DummyRefusals;

    #[async_trait::async_trait]
    impl crate::agents::Refusals for DummyRefusals {
        async fn read(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        async fn keep(&self, _: HashMap<String, String>) {}
        async fn read_windows(&self) -> crate::agents::Windows {
            HashMap::new()
        }
        async fn keep_windows(&self, _: crate::agents::Windows) {}
    }

    fn test_agents(processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager>) -> Arc<Agents> {
        let cwd = std::env::current_dir().expect("cwd");
        Agents::new(crate::agents::AgentsParts {
            presets: crate::preset::builtin(),
            processes,
            files: Arc::new(DummyFiles),
            fit: crate::mcp::in_process_fit(),
            probe_cwd: cwd.clone(),
            data_dir: cwd.clone(),
            definitions: cwd,
            refusals: Arc::new(DummyRefusals),
            registry: None,
            mcp_bridge: None,
            enabled: Arc::new(|| true),
            changed: Arc::new(|| {}),
            env: Arc::new(|_| None),
        })
    }

    /// Dropping `AgentSession::prompt` in flight after stdin may have admitted the prompt bytes
    /// keeps the prompt owned on the shared server so `detach` still sends `session/cancel` while a sibling
    /// keeps the server alive.
    #[tokio::test]
    async fn dropped_prompt_write_keeps_ownership_so_detach_sends_session_cancel() {
        let _ = mixdog_rt::testing::tokens();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let prompt_started = Arc::new(tokio::sync::Notify::new());
        let drain_gate = Arc::new(tokio::sync::Notify::new());
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let delivered_notify = Arc::new(tokio::sync::Notify::new());
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(SharedTestProcesses {
            killed: killed.clone(),
            gate_prompts: true,
            prompt_started: prompt_started.clone(),
            drain_gate: drain_gate.clone(),
            delivered: delivered.clone(),
            delivered_notify: delivered_notify.clone(),
        });
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _rx) = Connection::start(
            processes.clone(),
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let agents = test_agents(processes);
        let server = Arc::new(SharedServer {
            connection,
            capabilities: json!({}),
            preset: "antigravity".into(),
            epoch: 0,
            agents: Arc::downgrade(&agents),
            files: Arc::new(DummyFiles),
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        });

        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        let target = AgentSession::test_shared_session_for(server.clone(), "sess-target");
        server.register(&sibling);
        server.register(&target);
        let _sibling_use = server.enter_use().expect("active sibling keeps shared server alive");

        let started_wait = prompt_started.notified();
        tokio::pin!(started_wait);
        started_wait.as_mut().enable();
        let mut prompt_fut = Box::pin(target.prompt(vec![json!({ "type": "text", "text": "hello" })]));
        tokio::select! {
            _ = prompt_fut.as_mut() => panic!("prompt_fut should stall on gated stdin"),
            () = started_wait => {}
        }
        // Drop the in-flight prompt future itself (modeling Stop winning select! during prompt write), then detach.
        drop(prompt_fut);
        target.end();

        // Drain stdin and verify `session/cancel` for `sess-target` is sent while the sibling keeps server alive.
        drain_gate.notify_waiters();
        mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let wait = delivered_notify.notified();
                tokio::pin!(wait);
                wait.as_mut().enable();
                if delivered.lock().unwrap().iter().any(|line| line.contains("\"session/cancel\"") && line.contains("\"sess-target\"")) {
                    return;
                }
                wait.await;
            }
        })
        .await
        .expect("detach must send session/cancel for dropped in-flight prompt");
        assert!(!killed.load(Ordering::SeqCst), "sibling keeps shared server alive");
    }

    /// `retire_wedged_shared` targets only sessions belonging to the specific wedged server instance
    /// atomically under the sessions lock and never terminates a healthy replacement session on the same thread.
    #[tokio::test]
    async fn retire_wedged_shared_does_not_terminate_replacement_session_on_same_thread() {
        let _ = mixdog_rt::testing::tokens();
        let killed_wedged = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let killed_healthy = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let make_procs = |killed: Arc<std::sync::atomic::AtomicBool>| -> Arc<dyn mixdog_core_api::domain::process::ProcessManager> {
            Arc::new(SharedTestProcesses {
                killed,
                gate_prompts: false,
                prompt_started: Arc::new(tokio::sync::Notify::new()),
                drain_gate: Arc::new(tokio::sync::Notify::new()),
                delivered: Arc::new(Mutex::new(Vec::new())),
                delivered_notify: Arc::new(tokio::sync::Notify::new()),
            })
        };
        let procs_wedged = make_procs(killed_wedged.clone());
        let procs_healthy = make_procs(killed_healthy.clone());
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let launch = || crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd: cwd.clone() };
        let (conn_wedged, _rx1) = Connection::start(procs_wedged.clone(), launch()).await.expect("wedged conn");
        let (conn_healthy, _rx2) = Connection::start(procs_healthy.clone(), launch()).await.expect("healthy conn");
        let agents = test_agents(procs_healthy);
        let wedged_server = Arc::new(SharedServer {
            connection: conn_wedged,
            capabilities: json!({}),
            preset: "antigravity".into(),
            epoch: 0,
            agents: Arc::downgrade(&agents),
            files: Arc::new(DummyFiles),
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        });
        let healthy_server = Arc::new(SharedServer {
            connection: conn_healthy,
            capabilities: json!({}),
            preset: "antigravity".into(),
            epoch: 0,
            agents: Arc::downgrade(&agents),
            files: Arc::new(DummyFiles),
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        });

        let thread_replaced = ThreadId::from("thr_replaced");
        let thread_wedged = ThreadId::from("thr_wedged");
        let healthy_session = AgentSession::test_shared_session_for(healthy_server.clone(), "sess-healthy");
        let wedged_session = AgentSession::test_shared_session_for(wedged_server.clone(), "sess-wedged");
        healthy_server.register(&healthy_session);
        wedged_server.register(&wedged_session);
        {
            let mut sessions = lock(&agents.sessions);
            sessions.insert(thread_replaced.clone(), healthy_session.clone());
            sessions.insert(thread_wedged.clone(), wedged_session.clone());
        }

        agents.retire_wedged_shared(&wedged_server);

        assert!(killed_wedged.load(Ordering::SeqCst), "wedged server must be killed");
        assert!(agents.running(&thread_wedged).is_none(), "session on wedged server must be removed");
        assert!(wedged_session.gone().is_cancelled(), "session on wedged server must be ended");
        let still_running = agents.running(&thread_replaced).expect("healthy replacement session must remain registered");
        assert!(Arc::ptr_eq(&still_running, &healthy_session));
        assert!(!healthy_session.gone().is_cancelled(), "healthy replacement session must not be ended");
        assert!(!killed_healthy.load(Ordering::SeqCst), "healthy replacement server must not be killed");
    }

    /// A late permission request routed to `Routed::Refuse` (or an unknown session) on a shared server
    /// with stalled stdin must time out within `RefuseBudget::LIMIT`, break/retire the wedged server, and never
    /// block the shared router loop indefinitely.
    #[tokio::test]
    async fn late_permission_refusal_on_stalled_stdin_times_out_and_retires_wedged_server_without_blocking_router() {
        struct StalledWriteProcesses {
            killed: Arc<std::sync::atomic::AtomicBool>,
            kill_notify: Arc<tokio::sync::Notify>,
        }

        #[async_trait::async_trait]
        impl mixdog_core_api::domain::process::ProcessManager for StalledWriteProcesses {
            async fn spawn(
                &self,
                request: mixdog_core_api::domain::process::SpawnRequest,
            ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
                Ok(mixdog_core_api::domain::process::SpawnedProcess { handle: request.handle, pid: 1 })
            }
            fn subscribe(
                &self,
                _handle: &mixdog_protocol::ProcessHandle,
                _from_seq: Option<u64>,
            ) -> Result<
                Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
                mixdog_core_api::domain::process::ProcessError,
            > {
                Ok(Box::new(SharedTestEvents(tokio::sync::Notify::new())))
            }
            fn subscribe_holding(
                &self,
                handle: &mixdog_protocol::ProcessHandle,
                from_seq: Option<u64>,
            ) -> Result<
                Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
                mixdog_core_api::domain::process::ProcessError,
            > {
                self.subscribe(handle, from_seq)
            }
            async fn write_stdin(
                &self,
                _handle: &mixdog_protocol::ProcessHandle,
                _bytes: Vec<u8>,
            ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
                if self.killed.load(Ordering::SeqCst) {
                    return Err(mixdog_core_api::domain::process::ProcessError::StdinClosed);
                }
                self.kill_notify.notified().await;
                Err(mixdog_core_api::domain::process::ProcessError::StdinClosed)
            }
            fn close_stdin(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
                Ok(())
            }
            fn resize_pty(
                &self,
                _handle: &mixdog_protocol::ProcessHandle,
                _size: mixdog_core_api::domain::process::PtySize,
            ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
                Ok(())
            }
            fn kill(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
                self.killed.store(true, Ordering::SeqCst);
                self.kill_notify.notify_waiters();
                Ok(())
            }
            fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
                Vec::new()
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let kill_notify = Arc::new(tokio::sync::Notify::new());
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> =
            Arc::new(StalledWriteProcesses { killed: killed.clone(), kill_notify: kill_notify.clone() });
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _rx) = Connection::start(
            processes.clone(),
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let agents = test_agents(processes);
        let server = Arc::new(SharedServer {
            connection,
            capabilities: json!({}),
            preset: "antigravity".into(),
            epoch: 0,
            agents: Arc::downgrade(&agents),
            files: Arc::new(DummyFiles),
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        });
        let target = AgentSession::test_shared_session_for(server.clone(), "sess-target");
        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        server.register(&target);
        server.register(&sibling);
        {
            lock(&agents.shared).insert("antigravity".into(), SharedSlot::Running(server.clone()));
            let mut sessions = lock(&agents.sessions);
            sessions.insert(ThreadId::from("thr_target"), target.clone());
            sessions.insert(ThreadId::from("thr_sibling"), sibling.clone());
        }
        // Put `target` into the post-Stop unanswered-prompt state so any late permission routes to `Routed::Refuse`.
        target.cancel(Some(1));

        let started = tokio::time::Instant::now();
        mixdog_rt::time::timeout(
            Duration::from_secs(2),
            server.deliver(Incoming::Request { id: json!(99), method: "session/request_permission".into(), params: json!({ "sessionId": "sess-target" }) }),
        )
        .await
        .expect("Routed::Refuse must be bounded by RefuseBudget::LIMIT and never hang shared router");
        mixdog_rt::time::timeout(Duration::from_secs(2), kill_notify.notified())
            .await
            .expect("stalled Routed::Refuse must break/kill the wedged shared server");
        assert!(started.elapsed() < Duration::from_secs(1), "refusal timeout took {:?}", started.elapsed());
        assert!(killed.load(Ordering::SeqCst), "stalled Routed::Refuse must break/kill the wedged shared server");
        assert!(sibling.gone().is_cancelled(), "retiring wedged shared server ends sessions on it so siblings fail fast");
        assert!(lock(&agents.shared).get("antigravity").is_none(), "wedged shared server must be evicted from active slot");
    }

    #[tokio::test]
    async fn shared_router_rejects_fs_read_text_file_when_quirk_disabled() {
        struct SecretFiles(Arc<std::sync::atomic::AtomicBool>);

        #[async_trait::async_trait]
        impl TextFiles for SecretFiles {
            async fn read(&self, _: AbsPath) -> Result<String, String> {
                self.0.store(true, Ordering::SeqCst);
                Ok("TOP_SECRET".into())
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                Ok(path)
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Ok(())
            }
        }

        let _ = mixdog_rt::testing::tokens();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let delivered_notify = Arc::new(tokio::sync::Notify::new());
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(SharedTestProcesses {
            killed: killed.clone(),
            gate_prompts: false,
            prompt_started: Arc::new(tokio::sync::Notify::new()),
            drain_gate: Arc::new(tokio::sync::Notify::new()),
            delivered: delivered.clone(),
            delivered_notify: delivered_notify.clone(),
        });
        let cwd = AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _rx) = Connection::start(
            processes.clone(),
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd: cwd.clone() },
        )
        .await
        .expect("connection");
        let agents = test_agents(processes);
        let read_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let server = Arc::new(SharedServer {
            connection,
            capabilities: json!({}),
            preset: "antigravity".into(),
            epoch: 0,
            agents: Arc::downgrade(&agents),
            files: Arc::new(SecretFiles(read_called.clone())),
            retiring: CancellationToken::new(),
            state: Mutex::default(),
        });
        let session = AgentSession::test_shared_session_for(server.clone(), "sess-search");
        assert!(!session.preset.quirks.fs_read_text_file);
        server.register(&session);

        let target_path = cwd.as_path().join("secret.txt").to_string_lossy().into_owned();
        server
            .deliver(Incoming::Request {
                id: json!(55),
                method: "fs/read_text_file".into(),
                params: json!({ "sessionId": "sess-search", "path": target_path }),
            })
            .await;

        let reply: Value = mixdog_rt::time::timeout(Duration::from_secs(2), async {
            loop {
                let wait = delivered_notify.notified();
                tokio::pin!(wait);
                wait.as_mut().enable();
                if let Some(line) = delivered.lock().unwrap().iter().find(|line| line.contains("\"id\":55")).cloned() {
                    return serde_json::from_str(line.trim()).expect("json-rpc reply");
                }
                wait.await;
            }
        })
        .await
        .expect("shared router must respond to disallowed fs/read_text_file");
        assert_eq!(reply["id"], 55);
        assert_eq!(reply["error"]["code"], -32601, "shared router must reject fs/read_text_file as not offered: {reply}");
        assert!(!read_called.load(Ordering::SeqCst), "shared server must not read files when session disables fs_read_text_file");
        assert!(!killed.load(Ordering::SeqCst), "refusing fs/read_text_file must keep shared server alive");
    }
}
