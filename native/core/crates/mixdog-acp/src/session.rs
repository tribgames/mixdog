//! One Mixdog session's agent: its process, the agent's own session in it, and the place every
//! message the agent sends unasked goes to (the turn that runs, or the session while none does).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::ProcessManager;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use crate::connection::Connection;
use crate::connection::Fault;
use crate::connection::Incoming;
use crate::connection::Launch;
use crate::connection::RpcError;
use crate::files::TextFiles;
use crate::files::read_text_file;
use mixdog_tools::policy::GrantKey;

use crate::mcp::Handover;
use crate::mcp::ToolAsk;
use crate::mcp::ToolServer;
use crate::preset::AgentPreset;
use crate::preset::Reopen;
use crate::rows::AgentTool;

/// The protocol version this client speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// A model the agent offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentModel {
    pub id: String,
    pub name: String,
}

/// How the agent's model is chosen, as the session's setup answer tells it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Models {
    pub available: Vec<AgentModel>,
    pub current: Option<String>,
    /// The id of the config option that selects the model; without one the model is set with `session/set_model`.
    pub config_option: Option<String>,
}

impl Models {
    /// From a `session/new` or `session/resume` answer: its `configOptions` entry of category `model`, else its `models`.
    pub fn of(answer: &Value) -> Self {
        let option = answer.get("configOptions").and_then(Value::as_array).and_then(|options| {
            options.iter().find(|option| option.get("category").and_then(Value::as_str) == Some("model") && option.get("options").is_some_and(Value::is_array))
        });
        if let Some(option) = option {
            let available = option["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|choice| {
                    let id = choice.get("value").and_then(Value::as_str)?;
                    Some(AgentModel { id: id.to_owned(), name: choice.get("name").and_then(Value::as_str).unwrap_or(id).to_owned() })
                })
                .collect();
            return Self {
                available,
                current: option.get("currentValue").and_then(Value::as_str).map(str::to_owned),
                config_option: option.get("id").and_then(Value::as_str).map(str::to_owned),
            };
        }
        let models = answer.get("models");
        let available = models
            .and_then(|models| models.get("availableModels"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get("modelId").and_then(Value::as_str)?;
                Some(AgentModel { id: id.to_owned(), name: model.get("name").and_then(Value::as_str).unwrap_or(id).to_owned() })
            })
            .collect();
        Self { available, current: models.and_then(|models| models.get("currentModelId")).and_then(Value::as_str).map(str::to_owned), config_option: None }
    }
}

/// What a session is opened with.
pub struct Open<'a> {
    pub preset: &'a AgentPreset,
    /// The preset's CLI as it was found on this machine.
    pub program: &'a str,
    pub cwd: AbsPath,
    /// The agent's session id a stored Mixdog session holds.
    pub stored: Option<String>,
    /// Mixdog's prompt for the session: the agent's system prompt takes it where the agent advertises a place for it,
    /// else the first prompt's text does.
    pub rules: Option<String>,
    /// [`digest`] of the prompt the stored session already holds; `None` for one that holds none.
    pub held: Option<String>,
    /// The Mixdog session's remembered approvals.
    pub grants: Arc<Mutex<HashSet<GrantKey>>>,
    /// The session's tools, for an agent that is handed them.
    pub handed: Option<Handover>,
}

/// Asked for a turn when the agent starts a reply while none runs.
pub type Wake = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Routing {
    /// The running turn's end of the stream.
    turn: Option<mpsc::UnboundedSender<Incoming>>,
    /// What arrived while no turn ran, in order, for the turn a wake starts.
    waiting: Vec<Incoming>,
    woken: bool,
    /// A cancelled prompt the agent has not answered yet: what it still sends belongs to that turn.
    unanswered: Option<u64>,
    /// A reply the agent began on its own was cancelled: what it still sends is that reply's, until the next prompt.
    quiet: bool,
    /// Tool calls the agent left running when their turn ended, by the agent's id of each.
    background: HashMap<String, Background>,
    /// Every call id this session has put into a row.
    issued: HashSet<String>,
    /// The process ended and all it wrote was routed: the agent sends nothing more.
    ended: bool,
}

/// The agent's own report of its context (`usage_update`): the tokens the context holds now, and the window it
/// holds them in. Neither is a sum over turns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextUse {
    pub used: u64,
    pub size: u64,
}

impl ContextUse {
    /// From a `usage_update`; `None` for one that states no window.
    pub fn of(update: &Value) -> Option<Self> {
        let count = |key: &str| update.get(key).and_then(Value::as_u64);
        Some(Self { used: count("used")?, size: count("size").filter(|size| *size > 0)? })
    }
}

/// A tool call the agent kept running past the turn that showed it.
#[derive(Clone, Debug, PartialEq)]
pub struct Background {
    /// The id the call has in the rows of the turn that made it.
    pub id: String,
    pub tool: AgentTool,
}

pub struct AgentSession {
    pub preset: AgentPreset,
    pub connection: Arc<Connection>,
    pub session_id: String,
    pub cwd: AbsPath,
    /// The stored session could not be reopened and a new one was started.
    pub restarted: bool,
    /// What the user approved for the rest of the Mixdog session, each under the policy's key of the action
    /// ([`crate::rows::AgentTool::grant_key`]); they outlive this process.
    pub grants: Arc<Mutex<HashSet<GrantKey>>>,
    /// The session's tools, where this process was handed them: its MCP server runs for as long as the process does.
    pub handed: Option<Handover>,
    /// [`digest`] of Mixdog's prompt as the agent's session holds it now; `None` when it holds none.
    pub prompt: Option<String>,
    /// The agent takes images in a prompt.
    pub images: bool,
    /// The agent takes a file's text in a prompt as an embedded resource.
    pub embedded: bool,
    /// The agent closes a session it is asked to (`session/close`): one it closed is gone from its own list.
    closes: bool,
    /// The agent's last report of its own context.
    context: Mutex<Option<ContextUse>>,
    /// Mixdog's prompt, where the agent's system prompt took none of it: the next prompt's text carries it.
    unsent: Mutex<Option<String>>,
    /// Set once the agent connected to the session's tool server; `None` for a session that was handed none. The agent
    /// connects while it opens the session, and again after it when its first attempt took too long.
    connected: Option<Arc<AtomicBool>>,
    told_unconnected: AtomicBool,
    models: Mutex<Models>,
    routing: Mutex<Routing>,
    /// Told when the agent closed a cancelled prompt.
    closed_prompt: tokio::sync::Notify,
    wake: Wake,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn at<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(key))
}

fn nested(path: &[String], leaf: Value) -> Value {
    path.iter().rev().fold(leaf, |inner, key| Value::Object(std::iter::once((key.clone(), inner)).collect()))
}

/// What tells one text of Mixdog's prompt from another, kept with the agent's session: the session is sent the
/// prompt again only when it changed. FNV-1a over the text, which is the same in every process.
pub fn digest(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3));
    format!("{hash:016x}")
}

/// `initialize`: the client offers file reads only.
pub async fn initialize(connection: &Connection) -> Result<Value, Fault> {
    connection
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "mixdog", "title": "Mixdog", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await
}

/// The agent's ACP mode, started from `program` (the preset's CLI as it was found on this machine).
pub fn launch(preset: &AgentPreset, program: &str, cwd: AbsPath) -> Launch {
    Launch { program: program.to_owned(), args: preset.args.clone(), env: preset.env.clone(), env_remove: Vec::new(), cwd }
}

fn is_update(incoming: &Incoming) -> Option<&str> {
    match incoming {
        Incoming::Notification { method, params } if method == "session/update" => {
            params.get("update").and_then(|update| update.get("sessionUpdate")).and_then(Value::as_str)
        }
        _ => None,
    }
}

enum Routed {
    Done,
    Wake,
    /// A permission request of a turn that was cancelled.
    Refuse(Value),
    /// A call of a Mixdog tool no turn will run.
    RefuseTool(ToolAsk),
}

/// What a call of a Mixdog tool is answered with when its turn was stopped or none will take it.
const NO_TURN: &str = "The turn this call was made in was stopped; the call was not run.";

impl AgentSession {
    /// Starts the agent in `open.cwd` and opens its session: the stored one where there is one, else a new one.
    pub async fn open(
        processes: Arc<dyn ProcessManager>,
        files: Arc<dyn TextFiles>,
        open: Open<'_>,
        wake: Wake,
        on_exit: Box<dyn FnOnce() + Send>,
    ) -> Result<Arc<Self>, Fault> {
        let (connection, mut incoming) = Connection::start(processes, launch(open.preset, open.program, open.cwd.clone())).await?;
        let capabilities = initialize(&connection).await?;
        let cwd = open.cwd.as_path().to_string_lossy().into_owned();
        let quirks = &open.preset.quirks;
        // The session's tools go to this process alone: a server of its own, named in the session it opens or reopens.
        // An agent that takes no HTTP server is given the bridge program; one that can be given neither gets no tools.
        let mut server = None;
        let mut servers = Vec::new();
        if let Some(handed) = &open.handed {
            match ToolServer::start(handed.thread.clone(), handed.tools.clone()).await {
                Ok((started, calls)) => {
                    let http = capabilities.pointer("/agentCapabilities/mcpCapabilities/http") == Some(&Value::Bool(true));
                    if let Some(entry) = started.entry(http, handed.bridge.as_ref()) {
                        servers.push(entry);
                        server = Some((started, calls));
                    }
                }
                Err(error) => tracing::warn!("[acp] the session's tool server did not start: {error}"),
            }
        }
        let handed = open.handed.filter(|_| server.is_some());
        // Mixdog's prompt for the session, and, with the tools handed over, the word to prefer them: guidance only, the
        // agent's own tools stay its to use. It goes with every open of the agent's session, a reopen included.
        let appendix: Vec<&str> =
            open.rules.as_deref().into_iter().chain(handed.is_some().then_some(crate::mcp::PREFERENCE)).filter(|text| !text.trim().is_empty()).collect();
        let appendix = (!appendix.is_empty()).then(|| appendix.join("\n\n"));
        let prompt = appendix.as_deref().map(digest);
        let appended = quirks.system_prompt_append.as_ref().filter(|path| {
            capabilities.pointer("/agentCapabilities/_meta").and_then(|meta| at(meta, path)).is_some_and(|flag| flag != &Value::Bool(false) && !flag.is_null())
        });
        let with_prompt = |mut params: Value| {
            if let (Some(path), Some(appendix)) = (appended, &appendix) {
                params["_meta"] = nested(path, json!(appendix));
            }
            params
        };
        let mut restarted = false;
        let mut opened = None;
        if let Some(stored) = &open.stored {
            let method = match quirks.reopen {
                Reopen::Resume => "session/resume",
                Reopen::Load => "session/load",
            };
            let params = with_prompt(json!({ "sessionId": stored, "cwd": cwd, "mcpServers": servers }));
            match connection.request(method, params).await {
                Ok(answer) => {
                    // A load replays the conversation, which the Mixdog session already holds.
                    if quirks.reopen == Reopen::Load {
                        while incoming.try_recv().is_ok() {}
                    }
                    opened = Some((stored.clone(), answer));
                }
                Err(Fault::Rpc(error)) => {
                    tracing::warn!("[acp] {} could not reopen its session: {}", open.preset.id, error.message);
                    restarted = true;
                }
                Err(fault) => return Err(fault),
            }
        }
        let (session_id, answer) = match opened {
            Some(opened) => opened,
            None => {
                let answer = connection.request("session/new", with_prompt(json!({ "cwd": cwd, "mcpServers": servers }))).await?;
                let id =
                    answer.get("sessionId").and_then(Value::as_str).ok_or_else(|| Fault::Start("the agent opened a session without an id".into()))?.to_owned();
                (id, answer)
            }
        };
        // A session that does not hold the prompt yet, in an agent whose system prompt takes none: its next prompt carries it.
        let holds = open.stored.as_deref() == Some(session_id.as_str()) && prompt == open.held;
        let unsent = appendix.filter(|_| appended.is_none() && !holds);
        let connected = server.as_ref().map(|(server, _)| server.initialized());
        let session = Arc::new(Self {
            preset: open.preset.clone(),
            connection,
            session_id,
            cwd: open.cwd,
            restarted,
            grants: open.grants,
            handed,
            prompt,
            images: capabilities.pointer("/agentCapabilities/promptCapabilities/image") == Some(&Value::Bool(true)),
            embedded: capabilities.pointer("/agentCapabilities/promptCapabilities/embeddedContext") == Some(&Value::Bool(true)),
            closes: capabilities.pointer("/agentCapabilities/sessionCapabilities/close").is_some(),
            context: Mutex::default(),
            unsent: Mutex::new(unsent),
            connected,
            told_unconnected: AtomicBool::new(false),
            models: Mutex::new(Models::of(&answer)),
            routing: Mutex::default(),
            closed_prompt: tokio::sync::Notify::new(),
            wake,
        });
        drop(mixdog_rt::spawn("acp.route", mixdog_rt::TaskClass::Work, route(session.clone(), incoming, server, files, on_exit)));
        Ok(session)
    }

    pub fn models(&self) -> Models {
        lock(&self.models).clone()
    }

    /// Mixdog's prompt, for the prompt that carries it in its text: taken once.
    pub fn take_unsent_prompt(&self) -> Option<String> {
        lock(&self.unsent).take()
    }

    /// The agent has not connected to the session's tool server it was handed, and says nothing of one it could not
    /// reach; told once, asked when a turn of the session has ended.
    pub fn take_unconnected(&self) -> bool {
        self.connected.as_ref().is_some_and(|connected| !connected.load(Ordering::SeqCst)) && !self.told_unconnected.swap(true, Ordering::SeqCst)
    }

    /// Answers what the agent queued for a turn that will not run with `why`: a permission request is cancelled, a call
    /// of a Mixdog tool refused, and what the agent said for that turn is dropped with them. The agent, answered, may go
    /// on with the reply it began: what it still sends of it is that reply's, until the next prompt, and starts no turn.
    pub async fn abandon_waiting(&self, why: &str) {
        let dropped = {
            let mut routing = lock(&self.routing);
            routing.woken = false;
            routing.quiet = true;
            std::mem::take(&mut routing.waiting)
        };
        for incoming in dropped {
            match incoming {
                Incoming::Request { id, .. } => self.act(Routed::Refuse(id)).await,
                Incoming::Tool(ask) => ask.refuse(why),
                _ => {}
            }
        }
    }

    /// Puts the agent on `model`; a model it is already on asks nothing.
    pub async fn select_model(&self, model: &str) -> Result<(), Fault> {
        let models = self.models();
        if models.current.as_deref() == Some(model) {
            return Ok(());
        }
        match &models.config_option {
            Some(option) => {
                self.connection.request("session/set_config_option", json!({ "sessionId": self.session_id, "configId": option, "value": model })).await?
            }
            None => self.connection.request("session/set_model", json!({ "sessionId": self.session_id, "modelId": model })).await?,
        };
        lock(&self.models).current = Some(model.to_owned());
        Ok(())
    }

    /// The agent started a reply that no turn has taken yet.
    pub fn woken(&self) -> bool {
        lock(&self.routing).woken
    }

    /// A cancelled prompt the agent never closed: its process cannot take a new prompt as a new turn.
    pub fn holds_cancelled_prompt(&self) -> bool {
        lock(&self.routing).unanswered.is_some()
    }

    /// The stream of a turn that starts now: what waited for it, then what the agent sends while it runs, which ends
    /// with the process: at once for a process that has already ended. A turn that sends a `prompt` ends the quiet a
    /// cancelled reply left.
    pub fn attach(&self, prompt: bool) -> (Vec<Incoming>, mpsc::UnboundedReceiver<Incoming>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut routing = lock(&self.routing);
        routing.turn = (!routing.ended).then_some(tx);
        routing.woken = false;
        if prompt {
            routing.quiet = false;
        }
        (std::mem::take(&mut routing.waiting), rx)
    }

    /// The turn ended; `background` are the tool calls it left running in the agent, by the agent's id of each. What
    /// the agent sent the turn after its last read is sorted here as if no turn had run, in the order it was sent
    /// and before anything newer.
    pub async fn detach(&self, mut stream: mpsc::UnboundedReceiver<Incoming>, background: impl IntoIterator<Item = (String, Background)>) {
        let unread: Vec<Routed> = {
            let mut routing = lock(&self.routing);
            routing.turn = None;
            routing.background.extend(background);
            std::iter::from_fn(|| stream.try_recv().ok()).map(|incoming| self.sort(&mut routing, incoming)).collect()
        };
        for routed in unread {
            self.act(routed).await;
        }
    }

    /// `session/cancel`. A `prompt` that is open is the agent's to close, and what it sends until then is that
    /// prompt's; with none open (a reply the agent began on its own) what it sends until the next prompt is the
    /// cancelled reply's. Neither starts a turn. The agent is told in a task of its own: a turn's end never waits
    /// on an agent that stopped reading.
    pub fn cancel(self: &Arc<Self>, prompt: Option<u64>) {
        let dropped = {
            let mut routing = lock(&self.routing);
            routing.unanswered = prompt;
            routing.quiet = prompt.is_none();
            routing.woken = false;
            std::mem::take(&mut routing.waiting)
        };
        let session = self.clone();
        drop(mixdog_rt::spawn("acp.cancel", mixdog_rt::TaskClass::Work, async move {
            // A permission request among what waited for a turn is answered: the agent waits on it.
            for incoming in dropped {
                match incoming {
                    Incoming::Request { id, .. } => session.act(Routed::Refuse(id)).await,
                    Incoming::Tool(ask) => session.act(Routed::RefuseTool(ask)).await,
                    _ => {}
                }
            }
            let _ = session.connection.notify("session/cancel", json!({ "sessionId": session.session_id })).await;
        }));
    }

    /// Resolves once the agent has closed the prompt a turn cancelled, or its process has ended: the event after
    /// which the agent takes a new prompt as a new turn.
    pub async fn cancelled_prompt_closed(&self) {
        loop {
            let closed = self.closed_prompt.notified();
            tokio::pin!(closed);
            closed.as_mut().enable();
            if !self.holds_cancelled_prompt() {
                return;
            }
            tokio::select! {
                () = closed => {}
                () = self.connection.exited().cancelled() => return,
            }
        }
    }

    /// A row id for the agent's call `agent_id` made in `turn`: distinct from every id this session issued, and,
    /// carrying the turn, from every id of an earlier process of the agent, which counts its calls from the start again.
    pub fn call_id(&self, agent_id: &str, turn: &str, epoch: u64) -> String {
        let mut routing = lock(&self.routing);
        let base = format!("{turn}.{agent_id}");
        let id =
            (1..).map(|n| mixdog_protocol::tool_call_ids::distinct_id(&base, epoch, n)).find(|id| !routing.issued.contains(id)).expect("an id not yet issued");
        routing.issued.insert(id.clone());
        id
    }

    /// Folds `update` into the background call `agent_id` and tells whether that ended it; `None` for a call
    /// that is not one the agent kept running past its turn.
    pub fn background_update(&self, agent_id: &str, update: &Value) -> Option<bool> {
        let mut routing = lock(&self.routing);
        let call = routing.background.get_mut(agent_id)?;
        call.tool.merge(update);
        Some(call.tool.ended())
    }

    /// Takes the background call `agent_id` out: its result is being shown.
    pub fn background_shown(&self, agent_id: &str) -> Option<Background> {
        lock(&self.routing).background.remove(agent_id)
    }

    async fn act(&self, routed: Routed) {
        match routed {
            Routed::Done => {}
            Routed::Wake => (self.wake)(),
            Routed::Refuse(id) => self.connection.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } }))).await,
            Routed::RefuseTool(ask) => ask.refuse(NO_TURN),
        }
    }

    /// Asks the agent to close its session, where it advertises that it closes one; its answer is waited for, and a
    /// refusal changes nothing.
    pub async fn close(&self) {
        if self.closes {
            let _ = self.connection.request("session/close", json!({ "sessionId": self.session_id })).await;
        }
    }

    /// The agent's last report of its own context; `None` until it made one.
    pub fn context_use(&self) -> Option<ContextUse> {
        *lock(&self.context)
    }

    fn take(&self, incoming: Incoming) -> Routed {
        // The agent's report of its context is the session's, whichever turn it arrives in or between.
        if let (Some("usage_update"), Incoming::Notification { params, .. }) = (is_update(&incoming), &incoming)
            && let Some(reported) = ContextUse::of(&params["update"])
        {
            *lock(&self.context) = Some(reported);
        }
        let mut routing = lock(&self.routing);
        if routing.unanswered.is_some() {
            return self.sort(&mut routing, incoming);
        }
        let sent = match routing.turn.as_ref() {
            Some(turn) => turn.send(incoming).map_err(|unsent| unsent.0),
            None => Err(incoming),
        };
        match sent {
            Ok(()) => Routed::Done,
            // No turn, or one whose stream is already closed.
            Err(unsent) => {
                routing.turn = None;
                self.sort(&mut routing, unsent)
            }
        }
    }

    /// What becomes of a message no turn reads.
    fn sort(&self, routing: &mut Routing, incoming: Incoming) -> Routed {
        if let Some(cancelled) = routing.unanswered {
            return match incoming {
                Incoming::Response { id, .. } if id == cancelled => {
                    routing.unanswered = None;
                    self.closed_prompt.notify_waiters();
                    Routed::Done
                }
                Incoming::Request { id, .. } => Routed::Refuse(id),
                Incoming::Tool(ask) => Routed::RefuseTool(ask),
                _ => Routed::Done,
            };
        }
        if routing.quiet || !self.preset.quirks.replies_without_prompt {
            return match incoming {
                Incoming::Request { id, .. } => Routed::Refuse(id),
                Incoming::Tool(ask) => Routed::RefuseTool(ask),
                _ => Routed::Done,
            };
        }
        // What the agent sends with no prompt open is kept, in order, for the turn that shows it. It asks for that
        // turn at the two events after which it has something whole to show: the end of a model step (its usage
        // report) and a permission request, which the agent waits on. A turn that starts first shows it instead.
        let (keep, wake) = match (is_update(&incoming), &incoming) {
            (Some("tool_call" | "tool_call_update"), Incoming::Notification { params, .. }) => {
                let update = &params["update"];
                let known = update.get("toolCallId").and_then(Value::as_str).and_then(|id| routing.background.get_mut(id));
                // The progress of a call no turn shows any more is kept in the call; its end is shown.
                let progress = known.is_some_and(|call| {
                    call.tool.merge(update);
                    !call.tool.ended()
                });
                (!progress, false)
            }
            (Some("agent_message_chunk" | "agent_thought_chunk" | "plan"), _) => (true, false),
            (Some("usage_update"), _) => (false, !routing.waiting.is_empty()),
            // The agent waits on a permission request and on a call of a Mixdog tool alike.
            (_, Incoming::Request { .. } | Incoming::Tool(_)) => (true, true),
            _ => (false, false),
        };
        if keep {
            routing.waiting.push(incoming);
        }
        if !wake || routing.woken {
            return Routed::Done;
        }
        routing.woken = true;
        Routed::Wake
    }
}

async fn route(
    session: Arc<AgentSession>,
    mut incoming: mpsc::UnboundedReceiver<Incoming>,
    server: Option<(ToolServer, mpsc::UnboundedReceiver<ToolAsk>)>,
    files: Arc<dyn TextFiles>,
    on_exit: Box<dyn FnOnce() + Send>,
) {
    // The server is held here and nowhere else: it closes when the process's stream ends.
    let (_server, mut calls) = server.unzip();
    loop {
        let message = tokio::select! {
            message = incoming.recv() => match message {
                Some(message) => message,
                None => break,
            },
            Some(ask) = async { calls.as_mut()?.recv().await } => Incoming::Tool(ask),
        };
        let message = match message {
            Incoming::Request { id, method, params } if method == "fs/read_text_file" => {
                session.connection.respond(id, read_text_file(files.as_ref(), &session.cwd, &params).await).await;
                continue;
            }
            Incoming::Request { id, method, .. } if method != "session/request_permission" => {
                session
                    .connection
                    .respond(id, Err(RpcError { code: -32601, message: format!("{method} is not offered by this client"), data: Value::Null }))
                    .await;
                continue;
            }
            other => other,
        };
        let routed = session.take(message);
        session.act(routed).await;
    }
    // The process ended: a running turn sees its stream close, and so does every turn that attaches later.
    {
        let mut routing = lock(&session.routing);
        routing.turn = None;
        routing.ended = true;
    }
    on_exit();
}
