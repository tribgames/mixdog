//! One process of an agent that serves every session of its preset ([`ProcessScope::Shared`]): started when the first
//! session needs it and kept for every later one. The agent tells its sessions apart by their ids, and so does this
//! client: what the agent sends of a session reaches that session alone, and each session keeps its own tool server,
//! folder and settings.
//!
//! [`ProcessScope::Shared`]: crate::preset::ProcessScope::Shared

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio::task::JoinHandle;

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

/// An idle server is closed once this many sessions left it with no `session/close`: the agent keeps a process for each
/// such session until it exits.
const RETIRE_AFTER_UNCLOSED: usize = 4;

/// How long a server is given to end after its input ended: it ends the process it keeps for each session first.
pub(crate) fn grace(harnesses: usize) -> Duration {
    Duration::from_secs((2 + harnesses as u64).clamp(5, 12))
}

/// Numbers the temporary folders of this daemon's server starts.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// What the agents hold of a preset's shared server.
pub(crate) enum SharedSlot {
    /// Being started: every open that needs the server meanwhile waits for this one start.
    Starting { id: u64, started: watch::Receiver<Option<Result<Arc<SharedServer>, Fault>>> },
    Running(Arc<SharedServer>),
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
    /// The sessions that left it with no `session/close`.
    unclosed: usize,
    /// It takes no more sessions: it is being closed, or it has exited.
    retired: bool,
}

pub(crate) struct SharedServer {
    pub(crate) connection: Arc<Connection>,
    /// Its answer to `initialize`.
    pub(crate) capabilities: Value,
    preset: String,
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
    async fn start(agents: &Arc<Agents>, preset: &AgentPreset, program: &Program) -> Result<Arc<Self>, Fault> {
        let cwd = AbsPath::new(agents.parts.probe_cwd.clone())
            .ok_or_else(|| Fault::Start(format!("{} is not an absolute folder to start the agent in", agents.parts.probe_cwd.display())))?;
        let files = agents.parts.files.clone();
        let temp = Temp { folder: agents.server_temp().await?, files: files.clone() };
        let (connection, incoming) = Connection::start_in(agents.parts.processes.clone(), launch(preset, program, cwd), Some(temp)).await?;
        // A server that does not answer is ended, and its temporary folder goes with its exit.
        let capabilities = initialize(&connection).await.inspect_err(|_| connection.kill())?;
        let server = Arc::new(Self { connection, capabilities, preset: preset.id.clone(), agents: Arc::downgrade(agents), files, state: Mutex::default() });
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
    pub(crate) fn register(&self, session: &Arc<AgentSession>) {
        let mut state = lock(&self.state);
        state.opened += 1;
        let earlier = match state.retired {
            true => Some(session.clone()),
            false => state.sessions.insert(session.session_id.clone(), Arc::downgrade(session)).and_then(|earlier| earlier.upgrade()),
        };
        drop(state);
        if let Some(gone) = earlier {
            gone.gone.cancel();
        }
    }

    /// The prompt sent under `id` is `session`'s: its answer reaches that session.
    pub(crate) fn owns_prompt(&self, id: u64, session: &str) {
        lock(&self.state).prompts.insert(id, session.to_owned());
    }

    pub(crate) fn disown_prompt(&self, id: u64) {
        lock(&self.state).prompts.remove(&id);
    }

    /// Takes `session` off the server alone: nothing more of it reaches it, and the agent is asked to close it where it
    /// closes sessions. The server goes on serving the others.
    pub(crate) fn detach(self: &Arc<Self>, session: &AgentSession) {
        let held = {
            let mut state = lock(&self.state);
            let held = state.sessions.get(&session.session_id).is_some_and(|held| std::ptr::eq(held.as_ptr(), session));
            if held {
                state.sessions.remove(&session.session_id);
                state.prompts.retain(|_, owner| *owner != session.session_id);
                if !session.closes {
                    state.unclosed += 1;
                }
            }
            held
        };
        session.gone.cancel();
        if held && session.closes {
            let (connection, id) = (self.connection.clone(), session.session_id.clone());
            drop(mixdog_rt::spawn("acp.shared.close", TaskClass::Work, async move {
                let _ = connection.request("session/close", json!({ "sessionId": id })).await;
            }));
        }
        self.settle();
    }

    /// A server that serves no session and is opening none, once enough sessions left it unclosed, is retired: it is
    /// closed, and the next session starts a new one. Each session it never closed holds a process of the agent's.
    fn settle(self: &Arc<Self>) {
        let retire = {
            let mut state = lock(&self.state);
            let retire = !state.retired && state.opening == 0 && state.sessions.is_empty() && state.unclosed >= RETIRE_AFTER_UNCLOSED;
            state.retired |= retire;
            retire
        };
        if retire {
            if let Some(agents) = self.agents.upgrade() {
                agents.forget_shared(self);
            }
            let server = self.clone();
            drop(mixdog_rt::spawn("acp.shared.retire", TaskClass::Work, async move { server.stop().await }));
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

    /// Hands `message` to the session it is of. A read is answered from that session's folder alone, and a question about
    /// a session that is not open is cancelled; nothing else of such a session is kept.
    async fn deliver(&self, message: Incoming) {
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
                        self.connection.respond(id.clone(), Err(unnamed)).await;
                    }
                }
                return;
            }
            Incoming::Request { id, method, .. } if method != "session/request_permission" => {
                let refused = RpcError { code: -32601, message: format!("{method} is not offered by this client"), data: Value::Null };
                self.connection.respond(id.clone(), Err(refused)).await;
                return;
            }
            Incoming::Request { id, params, .. } => match self.named(params) {
                Some(session) => session,
                None => {
                    self.connection.respond(id.clone(), Ok(json!({ "outcome": { "outcome": "cancelled" } }))).await;
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
    pub(crate) async fn shared_server(self: &Arc<Self>, preset: &AgentPreset, program: &Program) -> Result<Lease, Fault> {
        loop {
            let mut started = {
                let mut shared = lock(&self.shared);
                let found = match shared.get(&preset.id) {
                    Some(SharedSlot::Running(server)) => Ok(server.clone()),
                    Some(SharedSlot::Starting { started, .. }) => Err(Some(started.clone())),
                    None => Err(None),
                };
                match found {
                    Ok(server) => match server.lease() {
                        Some(lease) => return Ok(lease),
                        // One being closed takes no session: the next is started.
                        None => self.start_shared(&mut shared, preset, program),
                    },
                    Err(Some(started)) => started,
                    Err(None) => self.start_shared(&mut shared, preset, program),
                }
            };
            let outcome = started.wait_for(Option::is_some).await.ok().and_then(|outcome| outcome.clone());
            match outcome {
                Some(Ok(server)) => {
                    if let Some(lease) = server.lease() {
                        return Ok(lease);
                    }
                }
                Some(Err(fault)) => return Err(fault),
                None => return Err(Fault::Start("its start was ended".to_owned())),
            }
        }
    }

    /// Starts `preset`'s server in a task of its own, which no open's end stops: its outcome is told on the returned
    /// channel. A start whose slot was taken meanwhile (the feature turned off, the app stopping) is closed by whoever took it.
    fn start_shared(
        self: &Arc<Self>,
        shared: &mut HashMap<String, SharedSlot>,
        preset: &AgentPreset,
        program: &Program,
    ) -> watch::Receiver<Option<Result<Arc<SharedServer>, Fault>>> {
        let id = self.next_check.fetch_add(1, Ordering::Relaxed);
        let (tell, started) = watch::channel(None);
        shared.insert(preset.id.clone(), SharedSlot::Starting { id, started: started.clone() });
        let (agents, preset, program) = (self.clone(), preset.clone(), program.clone());
        drop(mixdog_rt::spawn("acp.shared.start", TaskClass::Work, async move {
            let outcome = SharedServer::start(&agents, &preset, &program).await;
            {
                let mut shared = lock(&agents.shared);
                if matches!(shared.get(&preset.id), Some(SharedSlot::Starting { id: slot, .. }) if *slot == id) {
                    match &outcome {
                        Ok(server) => shared.insert(preset.id.clone(), SharedSlot::Running(server.clone())),
                        Err(_) => shared.remove(&preset.id),
                    };
                }
            }
            let _ = tell.send(Some(outcome));
        }));
        started
    }

    /// `server` serves no more sessions: the next one starts a new server.
    pub(crate) fn forget_shared(&self, server: &Arc<SharedServer>) {
        let mut shared = lock(&self.shared);
        if matches!(shared.get(&server.preset), Some(SharedSlot::Running(held)) if Arc::ptr_eq(held, server)) {
            shared.remove(&server.preset);
        }
    }

    /// Closes every shared server, one still starting once it started, each in a task that resolves once it has exited.
    pub(crate) fn close_shared(&self) -> Vec<JoinHandle<()>> {
        let slots: Vec<SharedSlot> = lock(&self.shared).drain().map(|(_, slot)| slot).collect();
        slots
            .into_iter()
            .map(|slot| {
                mixdog_rt::spawn("acp.shared.stop", TaskClass::Work, async move {
                    let server = match slot {
                        SharedSlot::Running(server) => Some(server),
                        SharedSlot::Starting { mut started, .. } => {
                            started.wait_for(Option::is_some).await.ok().and_then(|outcome| outcome.clone()).and_then(Result::ok)
                        }
                    };
                    if let Some(server) = server {
                        server.stop().await;
                    }
                })
            })
            .collect()
    }

    /// The app stops: every shared server is closed as the end of its input closes it, all at once, so none leaves what it
    /// unpacked behind. Resolves once each has exited.
    pub async fn shutdown(&self) {
        for closing in self.close_shared() {
            let _ = closing.await;
        }
    }

    /// A temporary folder of its own for one start of an agent's server, `<acp data>/tmp/pid-<daemon pid>-<n>`. The first
    /// one this daemon makes clears away those of daemons that are gone, which hold what their servers left when they
    /// were ended by force.
    pub(crate) async fn server_temp(&self) -> Result<AbsPath, Fault> {
        let root = self.parts.data_dir.join("tmp");
        if !self.swept_temps.swap(true, Ordering::SeqCst) {
            self.sweep_temps(&root).await;
        }
        let folder = root.join(format!("pid-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        let folder = AbsPath::new(folder).ok_or_else(|| Fault::Start(format!("{} is not an absolute folder", root.display())))?;
        self.parts.files.make_folder(folder.clone()).await.map_err(|error| Fault::Start(format!("its temporary folder was not made: {error}")))?;
        Ok(folder)
    }

    /// Removes the temporary folders under `root` of daemons that no longer run.
    async fn sweep_temps(&self, root: &Path) {
        let Some(root) = AbsPath::new(root) else { return };
        let Ok(folders) = self.parts.files.folders(root.clone()).await else { return };
        for name in folders {
            let pid = name.strip_prefix("pid-").and_then(|rest| rest.split('-').next()).and_then(|pid| pid.parse::<u32>().ok());
            if pid.is_some_and(|pid| pid != std::process::id() && !mixdog_statefile::process_exists(pid))
                && let Some(folder) = AbsPath::new(root.as_path().join(&name))
            {
                remove_folder(self.parts.files.as_ref(), folder).await;
            }
        }
    }
}
