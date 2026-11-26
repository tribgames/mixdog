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
use crate::files::read_text_file;
use crate::preset::AgentPreset;
use crate::session::AgentSession;
use crate::session::Program;
use crate::session::initialize;
use crate::session::launch;

/// What a session leaving a server tells it last.
type Farewell = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

/// How long a server is given to end after its input ended: it ends the process it keeps for each session first.
pub(crate) fn grace(harnesses: usize) -> Duration {
    Duration::from_secs((2 + harnesses as u64).clamp(5, 12))
}

/// Numbers the temporary folders of this daemon's server starts.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// What the agents hold of a preset's shared server.
pub(crate) enum SharedSlot {
    /// Being started: every open that needs the server meanwhile waits for this one start.
    Starting {
        id: u64,
        started: watch::Receiver<Option<Result<Arc<SharedServer>, Fault>>>,
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

#[derive(Default)]
struct State {
    /// The sessions it serves, by the agent's id of each.
    sessions: HashMap<String, Weak<AgentSession>>,
    /// The prompts it has not answered yet, each with the id of its session.
    prompts: HashMap<u64, String>,
    /// Opens of a session under way on it.
    opening: usize,
    /// The sessions it opened or reopened.
    opened: usize,
    /// Session ids left behind after a stuck cancel or interrupted setup, never to be reopened on this server.
    abandoned: AbandonedSessions,
    /// It takes no more sessions: it is being closed, or it has exited.
    retired: bool,
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
        lock(&self.0.state).opening -= 1;
        self.0.settle();
    }
}

impl SharedServer {
    /// Starts `preset`'s server from `program` in a temporary folder of its own, and has it answer `initialize`.
    async fn start(agents: &Arc<Agents>, preset: &AgentPreset, program: &Program, cancel: CancellationToken) -> Result<Arc<Self>, Fault> {
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
        if cancel.is_cancelled() {
            return Err(abort_init(connection));
        }
        // A server that does not answer (or whose startup is cancelled on timeout/shutdown) is ended, and its
        // temporary folder goes with its exit.
        let capabilities = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(abort_init(connection)),
            capabilities = initialize(&connection) => match capabilities {
                Ok(capabilities) => capabilities,
                Err(fault) => {
                    agents.kill_and_track("acp.shared.init_fail", connection);
                    return Err(fault);
                }
            },
        };
        let server =
            Arc::new(Self { connection, capabilities, preset: preset.id.clone(), epoch, agents: Arc::downgrade(agents), files, state: Mutex::default() });
        drop(mixdog_rt::spawn("acp.shared", TaskClass::Work, route(server.clone(), incoming)));
        Ok(server)
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

    /// `session` was opened on the server: what the agent sends of it reaches it from here. A server that has exited
    /// meanwhile has nothing more of it to send, and an earlier session under the same id is told apart from it no more.
    /// `true` for the first session the server opened.
    pub(crate) fn register(&self, session: &Arc<AgentSession>) -> bool {
        let mut state = lock(&self.state);
        state.opened += 1;
        let first = state.opened == 1;
        let earlier = match state.retired {
            true => Some(session.clone()),
            false => state.sessions.insert(session.session_id.clone(), Arc::downgrade(session)).and_then(|earlier| earlier.upgrade()),
        };
        drop(state);
        if let Some(gone) = earlier {
            gone.gone.cancel();
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

    pub(crate) fn disown_prompt(&self, id: u64) {
        lock(&self.state).prompts.remove(&id);
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
            self.connection.kill();
        }
    }

    /// Takes `session` off the server alone: nothing more of it reaches it, and the agent is asked to close it where it
    /// closes sessions. The server goes on serving the others.
    pub(crate) fn detach(self: &Arc<Self>, session: &AgentSession) {
        let (held, removed_prompts) = {
            let mut state = lock(&self.state);
            let held = state.sessions.get(&session.session_id).is_some_and(|held| std::ptr::eq(held.as_ptr(), session));
            let mut removed = Vec::new();
            if held {
                state.sessions.remove(&session.session_id);
                state.prompts.retain(|id, owner| {
                    if *owner == session.session_id {
                        removed.push(*id);
                        false
                    } else {
                        true
                    }
                });
            }
            (held, removed)
        };
        let prompted = !removed_prompts.is_empty();
        for id in removed_prompts {
            self.connection.forget_sent(id);
        }
        session.gone.cancel();
        // A prompt it still works on is cancelled: the server would go on answering it for nobody. Told before a close of
        // the server this leaving begins.
        let farewell: Option<Farewell> = (prompted || (held && session.closes)).then(|| {
            let (connection, id, closes) = (self.connection.clone(), session.session_id.clone(), held && session.closes);
            Box::pin(async move {
                if prompted {
                    let _ = connection.notify("session/cancel", json!({ "sessionId": id })).await;
                }
                if closes {
                    let _ = connection.request("session/close", json!({ "sessionId": id })).await;
                }
            }) as Farewell
        });
        self.settle_after(farewell);
    }

    fn settle(self: &Arc<Self>) {
        self.settle_after(None);
    }

    /// A server that serves no session and is opening none is retired: it is closed, after what `farewell` tells it, and
    /// the next session starts a new one. It holds a process of the agent's for each session it opened, until it exits.
    fn settle_after(self: &Arc<Self>, farewell: Option<Farewell>) {
        let retire = {
            let mut state = lock(&self.state);
            let retire = !state.retired && state.opening == 0 && state.sessions.is_empty();
            state.retired |= retire;
            retire
        };
        if !retire {
            if let Some(farewell) = farewell {
                drop(mixdog_rt::spawn("acp.shared.close", TaskClass::Work, farewell));
            }
            return;
        }
        let server = self.clone();
        let closed = async move {
            if let Some(farewell) = farewell {
                farewell.await;
            }
            server.stop().await;
        };
        match self.agents.upgrade() {
            Some(agents) => agents.retire_server(self, closed),
            None => drop(mixdog_rt::spawn("acp.shared.retire", TaskClass::Work, closed)),
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
        self.connection.close_gracefully(grace(harnesses)).await;
    }

    /// The open session `params` names by its `sessionId`.
    fn named(&self, params: &Value) -> Option<Arc<AgentSession>> {
        let id = params.get("sessionId").and_then(Value::as_str)?;
        self.session(id)
    }

    fn session(&self, id: &str) -> Option<Arc<AgentSession>> {
        lock(&self.state).sessions.get(id).and_then(Weak::upgrade).filter(|session| !session.gone.is_cancelled())
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

    /// Delivers `message` to the session it names. A read or permission request from the agent that names
    /// a session that is not open is cancelled; nothing else of such a session is kept.
    async fn deliver(self: &Arc<Self>, message: Incoming) {
        let session = match &message {
            Incoming::Request { id, method, params } if method == "fs/read_text_file" => {
                match self.named(params) {
                    // Read in a task of its own: the other sessions' messages do not wait for the file.
                    Some(session) => {
                        let (connection, files, id, params) = (self.connection.clone(), self.files.clone(), id.clone(), params.clone());
                        drop(mixdog_rt::spawn("acp.shared.read", TaskClass::Work, async move {
                            connection.respond(id, read_text_file(files.as_ref(), &session.cwd, &params).await).await;
                        }));
                    }
                    None => {
                        let unnamed = RpcError { code: -32602, message: "the read names no session this client holds open".to_owned(), data: Value::Null };
                        self.respond_bounded(id.clone(), Err(unnamed), "shared unnamed read refusal timed out on stalled stdin").await;
                    }
                }
                return;
            }
            Incoming::Request { id, method, .. } if method != "session/request_permission" => {
                let refused = RpcError { code: -32601, message: format!("{method} is not offered by this client"), data: Value::Null };
                self.respond_bounded(id.clone(), Err(refused), "shared unsupported method refusal timed out on stalled stdin").await;
                return;
            }
            Incoming::Request { id, params, .. } => match self.named(params) {
                Some(session) => session,
                None => {
                    self.respond_bounded(
                        id.clone(),
                        Ok(json!({ "outcome": { "outcome": "cancelled" } })),
                        "shared unknown-session permission refusal timed out on stalled stdin",
                    )
                    .await;
                    return;
                }
            },
            Incoming::Notification { params, .. } => match self.named(params) {
                Some(session) => session,
                None => return,
            },
            Incoming::Response { id, .. } => {
                let owner = lock(&self.state).prompts.remove(id);
                match owner.and_then(|owner| self.session(&owner)) {
                    Some(session) => session,
                    None => return,
                }
            }
            // A session's tool calls reach it through its own tool server.
            Incoming::Tool(_) => return,
        };
        let routed = session.take(message);
        session.act(routed).await;
    }

    /// The process ended and all it wrote was delivered: the next session starts a new server, and every session it
    /// served is told it is gone, which fails a turn that runs and closes the session's tool server.
    fn ended(self: &Arc<Self>) {
        let sessions: Vec<Arc<AgentSession>> = {
            let mut state = lock(&self.state);
            state.retired = true;
            state.prompts.clear();
            state.abandoned.clear();
            state.sessions.drain().filter_map(|(_, session)| session.upgrade()).collect()
        };
        if let Some(agents) = self.agents.upgrade() {
            agents.forget_shared(self);
        }
        for session in sessions {
            session.gone.cancel();
        }
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
                Some(Ok(server)) => {
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
                Some(Err(fault)) => return Err(fault),
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
    ) -> (u64, watch::Receiver<Option<Result<Arc<SharedServer>, Fault>>>) {
        let id = self.next_check.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let (tell, started) = watch::channel(None);
        shared.insert(preset.id.clone(), SharedSlot::Starting { id, started: started.clone(), cancel: cancel.clone() });
        let (agents, preset, program) = (self.clone(), preset.clone(), program.clone());
        drop(mixdog_rt::spawn("acp.shared.start", TaskClass::Work, async move {
            let outcome = SharedServer::start(&agents, &preset, &program, cancel.clone()).await;
            // Held until every open that waited for the start has leased the server or given up: a server none of
            // them leases serves no session, and the hold's end closes it as such.
            let (held, timed_out_orphan) = {
                let mut shared = lock(&agents.shared);
                let current = matches!(shared.get(&preset.id), Some(SharedSlot::Starting { id: slot, .. }) if *slot == id);
                match &outcome {
                    Ok(server) if current => {
                        shared.insert(preset.id.clone(), SharedSlot::Running(server.clone()));
                        (server.lease(), None)
                    }
                    Ok(server) if cancel.is_cancelled() => (None, Some(server.clone())),
                    Ok(_) => (None, None),
                    Err(_) => {
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
                Err(Fault::Start(format!("{} did not initialize in time", preset.label)))
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
    /// under the servers' lock, so a stop of the app never finds it in neither.
    fn retire_server(&self, server: &Arc<SharedServer>, closed: impl Future<Output = ()> + Send + 'static) {
        let mut shared = lock(&self.shared);
        Self::forget_in(&mut shared, server);
        self.track_stop(mixdog_rt::spawn("acp.shared.retire", TaskClass::Work, closed));
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

    /// Closes `slot`'s server, which just left `_shared` (the servers, whose lock the caller holds), one still starting once
    /// it started, in a task the app's stop waits for; the receiver is told once it has exited.
    fn stop_slot(&self, _shared: &mut HashMap<String, SharedSlot>, slot: SharedSlot) -> tokio::sync::oneshot::Receiver<()> {
        // It takes no session from here, and the last of its sessions to leave it does not close it a second time.
        if let SharedSlot::Running(server) = &slot {
            lock(&server.state).retired = true;
        }
        let (done, stopped) = tokio::sync::oneshot::channel();
        self.track_stop(mixdog_rt::spawn("acp.shared.stop", TaskClass::Work, async move {
            let server = match slot {
                SharedSlot::Running(server) => Some(server),
                SharedSlot::Starting { mut started, .. } => {
                    started.wait_for(Option::is_some).await.ok().and_then(|outcome| outcome.clone()).and_then(Result::ok)
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

    /// The app stops: every shared server is closed as the end of its input closes it, all at once, so none leaves what it
    /// unpacked behind, and none starts from here on. Resolves once every server whose stop began, whoever began it, has
    /// exited.
    pub async fn shutdown(&self) {
        // Set under the servers' lock, which every start and lease checks it under, and every stop that began is tracked
        // under: from here none starts, and each one stopping is in `stops`.
        {
            let _shared = lock(&self.shared);
            self.stopping.store(true, Ordering::SeqCst);
        }
        self.close_shared();
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
    /// of daemons gone since, builds that are not the installed one, the staging homes of sign-ins that did not end).
    pub async fn sweep_leftovers(&self) {
        self.sweep_temps().await;
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
            state: Mutex::default(),
        });

        let sibling = AgentSession::test_shared_session_for(server.clone(), "sess-sibling");
        let target = AgentSession::test_shared_session_for(server.clone(), "sess-target");
        server.register(&sibling);
        server.register(&target);

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
            state: Mutex::default(),
        });
        let healthy_server = Arc::new(SharedServer {
            connection: conn_healthy,
            capabilities: json!({}),
            preset: "antigravity".into(),
            epoch: 0,
            agents: Arc::downgrade(&agents),
            files: Arc::new(DummyFiles),
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
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> =
            Arc::new(StalledWriteProcesses { killed: killed.clone(), kill_notify: Arc::new(tokio::sync::Notify::new()) });
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
        assert!(started.elapsed() < Duration::from_secs(1), "refusal timeout took {:?}", started.elapsed());
        assert!(killed.load(Ordering::SeqCst), "stalled Routed::Refuse must break/kill the wedged shared server");
        assert!(sibling.gone().is_cancelled(), "retiring wedged shared server ends sessions on it so siblings fail fast");
        assert!(lock(&agents.shared).get("antigravity").is_none(), "wedged shared server must be evicted from active slot");
    }
}
