//! One Mixdog session's agent: its process, the agent's own session in it, and the place every
//! message the agent sends unasked goes to (the turn that runs, or the session while none does).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::ProcessManager;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::agents::lock;
use crate::connection::Connection;
use crate::connection::Fault;
use crate::connection::Incoming;
use crate::connection::Launch;
use crate::connection::RpcError;
use crate::connection::Temp;
use crate::files::TextFiles;
use crate::files::read_text_file;
use mixdog_tools::policy::GrantKey;

use crate::mcp::Handover;
use crate::mcp::SERVER_NAME;
use crate::mcp::ToolAsk;
use crate::mcp::ToolServer;
use crate::preset::AgentFile;
use crate::preset::AgentPreset;
use crate::preset::OwnToolsOff;
use crate::preset::Reopen;
use crate::rows::AgentTool;
use crate::shared::Lease;
use crate::shared::SharedServer;

/// The protocol version this client speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// How long an agent is given to answer `initialize`: one that does not is given up on, and its process ended.
const INITIALIZE_LIMIT: Duration = Duration::from_secs(60);

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
    /// From a `session/new` or `session/resume` answer. The `models` list is the one that names what the agent runs: it
    /// lists a model once per effort, under the agent's own id of that tier, and `session/set_model` sets model and
    /// effort in one step. Only an answer without such a list is read from its `configOptions` entry of category
    /// `model`, which is then set as an option.
    pub fn of(answer: &Value) -> Self {
        let models = answer.get("models");
        let available: Vec<AgentModel> = models
            .and_then(|models| models.get("availableModels"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model.get("modelId").and_then(Value::as_str)?;
                Some(AgentModel { id: id.to_owned(), name: model.get("name").and_then(Value::as_str).unwrap_or(id).to_owned() })
            })
            .collect();
        let options = answer.get("configOptions").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let Some(option) = option_of(options, "model").filter(|_| available.is_empty()) else {
            return Self {
                available,
                current: models.and_then(|models| models.get("currentModelId")).and_then(Value::as_str).map(str::to_owned),
                config_option: None,
            };
        };
        Self {
            available: choices(option),
            current: option.get("currentValue").and_then(Value::as_str).map(str::to_owned),
            config_option: option.get("id").and_then(Value::as_str).map(str::to_owned),
        }
    }

    /// What a `config_option_update` (its `configOptions`, all of them) tells of the model the agent is on. A session set
    /// through the model option takes the option's choices and value. One set with `session/set_model` is on the agent's
    /// id of the option's model at the `thought_level` option's value, where it lists that tier (both of Antigravity's
    /// servers list `gemini-4-neon` at `high` as `gemini-4-neon-high`), else on the model as it is named, where it lists
    /// it; on neither, which one it is on is unknown until one is set.
    pub fn refresh(&mut self, options: &[Value]) {
        let Some(option) = option_of(options, "model") else { return };
        let chosen = option.get("currentValue").and_then(Value::as_str);
        if self.config_option.is_some() {
            self.available = choices(option);
            self.current = chosen.map(str::to_owned);
            return;
        }
        let level = option_of(options, "thought_level").and_then(|level| level.get("currentValue")).and_then(Value::as_str);
        let listed = |id: &str| self.available.iter().any(|model| model.id == id);
        let current = chosen.and_then(|chosen| {
            level.map(|level| format!("{chosen}-{level}")).filter(|tiered| listed(tiered)).or_else(|| listed(chosen).then(|| chosen.to_owned()))
        });
        self.current = current;
    }
}

/// The select option of `category` among a session's `configOptions`.
fn option_of<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    options.iter().find(|option| option.get("category").and_then(Value::as_str) == Some(category) && option.get("options").is_some_and(Value::is_array))
}

/// The values a select option offers, a group's (`{ group, name, options }`) in its place among them.
fn choices(option: &Value) -> Vec<AgentModel> {
    let entries = option["options"].as_array().into_iter().flatten();
    entries
        .flat_map(|entry| entry.get("options").and_then(Value::as_array).map_or_else(|| vec![entry], |grouped| grouped.iter().collect()))
        .filter_map(|choice| {
            let id = choice.get("value").and_then(Value::as_str)?;
            Some(AgentModel { id: id.to_owned(), name: choice.get("name").and_then(Value::as_str).unwrap_or(id).to_owned() })
        })
        .collect()
}

/// The agent's program as it was found on this machine, with what it starts with besides the preset's own.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Program {
    pub path: String,
    /// Ahead of the preset's `args`.
    pub args: Vec<String>,
    /// Beside the preset's `env`.
    pub env: Vec<(String, String)>,
}

impl Program {
    /// The program at `path`, started with the preset's arguments and environment alone.
    pub fn at(path: impl Into<String>) -> Self {
        Self { path: path.into(), ..Self::default() }
    }
}

/// What a session is opened with.
pub struct Open<'a> {
    pub preset: &'a AgentPreset,
    /// The preset's program as it was found on this machine.
    pub program: &'a Program,
    pub cwd: AbsPath,
    /// The user's own folder the agent definitions are kept in ([`crate::agents::AgentsParts::definitions`]).
    pub definitions: &'a std::path::Path,
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
    /// A temporary folder of the process's own, cleared away once it exited; `None` leaves it the system's.
    pub temp: Option<AbsPath>,
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
    /// The reports of its context (`usage_update`) the agent made while no turn ran, kept in `waiting`: they are the
    /// reports of the turn that takes them.
    uncounted: u64,
    /// The session ends once the running turn is over: its route left the preset while the turn ran.
    end_after_turn: bool,
}

impl Routing {
    fn issue(&mut self, agent_id: &str, turn: &str, epoch: u64) -> String {
        let base = format!("{turn}.{agent_id}");
        let id =
            (1..).map(|n| mixdog_protocol::tool_call_ids::distinct_id(&base, epoch, n)).find(|id| !self.issued.contains(id)).expect("an id not yet issued");
        self.issued.insert(id.clone());
        id
    }

    fn turn_ended(&mut self) {
        let Self { issued, background, .. } = self;
        issued.retain(|id| background.values().any(|call| &call.id == id));
    }
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

/// Where a session runs.
enum Host {
    /// A process of its own.
    Own,
    /// The preset's one server, beside the preset's other sessions.
    Shared(Arc<SharedServer>),
}

pub struct AgentSession {
    pub preset: AgentPreset,
    /// The session's process: its own, or the server it shares with the preset's other sessions.
    pub connection: Arc<Connection>,
    host: Host,
    /// Fired once nothing more of the session arrives: its process ended, or it left the shared server.
    pub(crate) gone: CancellationToken,
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
    pub(crate) closes: bool,
    /// The agent's last report of its own context.
    context: Mutex<Option<ContextUse>>,
    /// How many reports of its context the agent has made.
    reports: std::sync::atomic::AtomicU64,
    /// Mixdog's prompt, where the agent's system prompt took none of it: the next prompt's text carries it.
    unsent: Mutex<Option<String>>,
    /// Set once the agent connected to the session's tool server; `None` for a session that was handed none. The agent
    /// connects while it opens the session, and again after it when its first attempt took too long.
    connected: Option<Arc<AtomicBool>>,
    told_unconnected: AtomicBool,
    models: Mutex<Models>,
    routing: Mutex<Routing>,
    /// Calls of Mixdog tools that went on past the agent's deadline for them, each as its tool, its arguments and its
    /// background task.
    kept: Mutex<Vec<(String, Value, String)>>,
    /// Told when the agent closed a cancelled prompt.
    closed_prompt: tokio::sync::Notify,
    /// The cancels told the agent in a task of their own that are not written yet: a prompt is written after them.
    cancels: watch::Sender<usize>,
    wake: Wake,
}

fn at<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(key))
}

fn nested(path: &[String], leaf: Value) -> Value {
    path.iter().rev().fold(leaf, |inner, key| Value::Object(std::iter::once((key.clone(), inner)).collect()))
}

/// `from` merged into `into`: a key both hold as an object is merged in turn, and every other key of `from` is set.
fn merge(into: &mut Value, from: Value) {
    match (into, from) {
        (Value::Object(into), Value::Object(from)) => {
            for (key, value) in from {
                merge(into.entry(key).or_insert(Value::Null), value);
            }
        }
        (into, from) => *into = from,
    }
}

/// What tells one text of Mixdog's prompt from another, kept with the agent's session: the session is sent the
/// prompt again only when it changed. FNV-1a over the text, which is the same in every process.
pub fn digest(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3));
    format!("{hash:016x}")
}

/// `initialize`: the client offers file reads only. An agent that does not answer within [`INITIALIZE_LIMIT`] fails it.
pub async fn initialize(connection: &Connection) -> Result<Value, Fault> {
    let asked = connection.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "mixdog", "title": "Mixdog", "version": env!("CARGO_PKG_VERSION") },
        }),
    );
    mixdog_rt::time::timeout(INITIALIZE_LIMIT, asked)
        .await
        .unwrap_or_else(|_| Err(Fault::Start(format!("it did not answer initialize within {} s", INITIALIZE_LIMIT.as_secs()))))
}

/// Asks the agent to close its session `session_id`: resolves when the agent answers or the connection exits, and a
/// refusal changes nothing.
pub(crate) async fn close_session(connection: &Connection, session_id: &str) {
    let _ = connection.request("session/close", json!({ "sessionId": session_id })).await;
}

/// An optional capability the agent advertises: one omitted, `null` or `false` is not.
pub(crate) fn offered(capability: Option<&Value>) -> bool {
    capability.is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
}

pub(crate) fn not_offered(method: &str) -> RpcError {
    RpcError { code: -32601, message: format!("{method} is not offered by this client"), data: Value::Null }
}

/// The answer to a request of the agent's about no session this client holds open: a question is cancelled, a read refused.
pub(crate) fn unheld(method: &str) -> Result<Value, RpcError> {
    match method {
        "session/request_permission" => Ok(json!({ "outcome": { "outcome": "cancelled" } })),
        "fs/read_text_file" => Err(RpcError { code: -32602, message: "the read names no session this client holds open".to_owned(), data: Value::Null }),
        _ => Err(not_offered(method)),
    }
}

/// Drops what the agent sent while it reopened a session: a load's replay, which the Mixdog session already holds, or what
/// it sent of a session it could not reopen. A request among it is answered as one of no open session.
async fn drop_replayed(connection: &Connection, replayed: &mut mpsc::UnboundedReceiver<Incoming>) {
    while let Ok(incoming) = replayed.try_recv() {
        if let Incoming::Request { id, method, .. } = incoming {
            connection.respond(id, unheld(&method)).await;
        }
    }
}

/// The agent's ACP mode, started from `program` (the preset's program as it was found on this machine).
pub fn launch(preset: &AgentPreset, program: &Program, cwd: AbsPath) -> Launch {
    Launch {
        program: program.path.clone(),
        args: program.args.iter().chain(&preset.args).cloned().collect(),
        env: preset.env.iter().chain(&program.env).cloned().collect(),
        env_remove: Vec::new(),
        cwd,
    }
}

/// As [`launch`], started in `home` with the agent that has none of the CLI's own tools: `home` holds the definition
/// [`own_tools_off_home`] wrote.
fn launch_without_own_tools(preset: &AgentPreset, program: &Program, cwd: AbsPath, home: Option<(AbsPath, &AgentFile)>) -> Launch {
    let mut launch = launch(preset, program, cwd);
    if let Some((home, off)) = home {
        launch.args.extend(off.args.iter().cloned());
        launch.cwd = home;
    }
    launch
}

/// The folder the CLI is started in for a session handed Mixdog's tools: it holds the agent definition without the
/// CLI's own tools and with `tools`, the session's, declared to the model. Sessions handed other tools run side by
/// side, so each definition has a folder of its own. A definition that cannot be written fails the open: the agent is
/// not started with its own tools instead.
async fn own_tools_off_home(
    files: &dyn TextFiles,
    definitions: &std::path::Path,
    preset_id: &str,
    off: &AgentFile,
    tools: &[String],
) -> Result<AbsPath, Fault> {
    let place = |path: std::path::PathBuf| AbsPath::new(path).ok_or_else(|| Fault::Start("the definitions folder has no absolute place".into()));
    let text = off.definition(SERVER_NAME, tools);
    let home = place(definitions.join(preset_id).join(digest(&text)))?;
    let file = place(home.as_path().join(&off.file))?;
    files.create(file, text).await.map_err(|error| Fault::Start(format!("the agent definition without its own tools was not written: {error}")))?;
    Ok(home)
}

fn is_update(incoming: &Incoming) -> Option<&str> {
    match incoming {
        Incoming::Notification { method, params } if method == "session/update" => {
            params.get("update").and_then(|update| update.get("sessionUpdate")).and_then(Value::as_str)
        }
        _ => None,
    }
}

/// Whether `incoming` tells of a call the agent kept running past the turn that showed it.
fn of_background(routing: &Routing, incoming: &Incoming) -> bool {
    match (is_update(incoming), incoming) {
        (Some("tool_call" | "tool_call_update"), Incoming::Notification { params, .. }) => {
            params["update"].get("toolCallId").and_then(Value::as_str).is_some_and(|id| routing.background.contains_key(id))
        }
        _ => false,
    }
}

pub(crate) enum Routed {
    Done,
    Wake,
    /// A permission request of a turn that was cancelled.
    Refuse(Value),
    /// A call of a Mixdog tool no turn will run.
    RefuseTool(ToolAsk),
}

/// What a call of a Mixdog tool is answered with when its turn was stopped or none will take it.
const NO_TURN: &str = "The turn this call was made in was stopped; the call was not run.";

/// What a call of a Mixdog tool is answered with when its session left the shared server, or the server exited.
const LEFT: &str = "The agent's session was closed; the call was not run.";

/// A session's own tool server and the calls the agent makes through it.
type Tools = (ToolServer, mpsc::UnboundedReceiver<ToolAsk>);

/// The session's own tool server, where it is handed its tools: named in the session it opens or reopens, and nowhere
/// else. One that does not start leaves the session with none.
async fn start_tools(handed: Option<&Handover>) -> Option<Tools> {
    let handed = handed?;
    match ToolServer::start(handed.thread.clone(), handed.tools.clone()).await {
        Ok(started) => Some(started),
        Err(error) => {
            tracing::warn!("[acp] the session's tool server did not start: {error}");
            None
        }
    }
}

/// The `mcpServers` of a session of an agent that answered `initialize` with `capabilities`, and the tool server they
/// name: an agent that takes no HTTP server is given the bridge program, and one that can be given neither no tools.
fn handed_entry(capabilities: &Value, handed: Option<&Handover>, started: Option<Tools>) -> (Vec<Value>, Option<Tools>) {
    if let (Some(handed), Some((started, calls))) = (handed, started) {
        let http = capabilities.pointer("/agentCapabilities/mcpCapabilities/http") == Some(&Value::Bool(true));
        if let Some(entry) = started.entry(http, handed.bridge.as_ref()) {
            return (vec![entry], Some((started, calls)));
        }
    }
    (Vec::new(), None)
}

/// The process a session is opened in, and what of it the session holds.
struct On<'a> {
    connection: Arc<Connection>,
    /// The process's answer to `initialize`.
    capabilities: &'a Value,
    host: Host,
    gone: CancellationToken,
    /// The session's tool server, named in `servers`.
    server: Option<&'a ToolServer>,
    servers: Vec<Value>,
    /// What the process sends the session's own way: a load's replay is dropped from it.
    replayed: Option<&'a mut mpsc::UnboundedReceiver<Incoming>>,
}

impl AgentSession {
    /// Starts the agent in `open.cwd`, a process of the session's own, and opens its session: the stored one where there
    /// is one, else a new one.
    pub async fn open(
        processes: Arc<dyn ProcessManager>,
        files: Arc<dyn TextFiles>,
        open: Open<'_>,
        wake: Wake,
        on_exit: Box<dyn FnOnce() + Send>,
    ) -> Result<Arc<Self>, Fault> {
        let started = start_tools(open.handed.as_ref()).await;
        // The CLI's own tools are off only where the agent is handed the session's: it starts so when the server is
        // there, and starts again with its own tools when it turns out it cannot be given the server's entry.
        let bare = match (&started, &open.preset.own_tools_off, &open.handed) {
            (Some(_), Some(OwnToolsOff::AgentFile(off)), Some(handed)) => {
                let tools = handed.listed().await.map_err(|error| Fault::Start(format!("the session's tools were not listed: {error}")))?;
                Some((own_tools_off_home(files.as_ref(), open.definitions, open.preset.id.as_str(), off, &tools).await?, off))
            }
            _ => None,
        };
        let was_bare = bare.is_some();
        let launched = launch_without_own_tools(open.preset, open.program, open.cwd.clone(), bare);
        let temp = open.temp.clone().map(|folder| Temp { folder, files: files.clone() });
        let (mut connection, mut incoming) = Connection::start_in(processes.clone(), launched, temp).await?;
        let mut capabilities = initialize(&connection).await?;
        let (servers, server) = handed_entry(&capabilities, open.handed.as_ref(), started);
        if was_bare && server.is_none() {
            (connection, incoming) = Connection::start(processes, launch(open.preset, open.program, open.cwd.clone())).await?;
            capabilities = initialize(&connection).await?;
        }
        let on = On {
            connection: connection.clone(),
            capabilities: &capabilities,
            host: Host::Own,
            gone: connection.exited().child_token(),
            server: server.as_ref().map(|(server, _)| server),
            servers,
            replayed: Some(&mut incoming),
        };
        let (session, _) = Self::open_session(open, on, wake).await?;
        drop(mixdog_rt::spawn("acp.route", mixdog_rt::TaskClass::Work, route(session.clone(), incoming, server, files, on_exit)));
        Ok(session)
    }

    /// Opens the session on the preset's shared server the lease holds, beside the sessions it already serves: the stored
    /// one where there is one, else a new one. The session's tool server is its own, and so are its folder and settings.
    pub(crate) async fn open_on_shared(lease: Lease, open: Open<'_>, wake: Wake, on_exit: Box<dyn FnOnce() + Send>) -> Result<Arc<Self>, Fault> {
        let shared = lease.server().clone();
        let started = start_tools(open.handed.as_ref()).await;
        let (servers, tools) = handed_entry(&shared.capabilities, open.handed.as_ref(), started);
        let on = On {
            connection: shared.connection.clone(),
            capabilities: &shared.capabilities,
            host: Host::Shared(shared.clone()),
            gone: CancellationToken::new(),
            server: tools.as_ref().map(|(server, _)| server),
            servers,
            replayed: None,
        };
        let (session, answer) = Self::open_session(open, on, wake).await?;
        let first = shared.register(&session);
        drop(lease);
        drop(mixdog_rt::spawn("acp.route.shared", mixdog_rt::TaskClass::Work, route_on_shared(session.clone(), tools, on_exit)));
        if first {
            shared.first_answered(&session.preset, &answer).await;
        }
        Ok(session)
    }

    /// Opens the agent's session in the process `on` names, with Mixdog's prompt and the preset's settings.
    /// The session, and the agent's answer that opened or reopened it.
    async fn open_session(open: Open<'_>, on: On<'_>, wake: Wake) -> Result<(Arc<Self>, Value), Fault> {
        let On { connection, capabilities, host, gone, server, servers, replayed } = on;
        let cwd = open.cwd.as_path().to_string_lossy().into_owned();
        let quirks = &open.preset.quirks;
        let handed = open.handed.filter(|_| server.is_some());
        // Mixdog's prompt for the session, and, with the tools handed over, the word to prefer them where the preset
        // appends it. It goes with every open of the agent's session, a reopen included, as do the agent's settings.
        let preference = (handed.is_some() && quirks.append_tool_guidance).then(crate::mcp::preference);
        let appendix: Vec<&str> = open.rules.as_deref().into_iter().chain(preference.as_deref()).filter(|text| !text.trim().is_empty()).collect();
        let appendix = (!appendix.is_empty()).then(|| appendix.join("\n\n"));
        let prompt = appendix.as_deref().map(digest);
        let appended =
            quirks.system_prompt_append.as_ref().filter(|path| offered(capabilities.pointer("/agentCapabilities/_meta").and_then(|meta| at(meta, path))));
        let settings = match &open.preset.own_tools_off {
            Some(OwnToolsOff::SessionMeta(off)) => Some(nested(&off.path, off.settings(handed.is_some(), quirks.mcp_max_output_bytes))),
            _ => None,
        };
        let with_prompt = |mut params: Value| {
            let mut meta = Value::Null;
            if let (Some(path), Some(appendix)) = (appended, &appendix) {
                merge(&mut meta, nested(path, json!(appendix)));
            }
            if let Some(settings) = &settings {
                merge(&mut meta, settings.clone());
            }
            if !meta.is_null() {
                params["_meta"] = meta;
            }
            params
        };
        let mut restarted = false;
        let mut opened = None;
        if let Some(stored) = &open.stored {
            if matches!(&host, Host::Shared(shared) if shared.is_unclosed(stored)) {
                tracing::warn!(
                    "[acp] {} could not reopen its session {stored}: its earlier prompt or cancel is still open on the shared server",
                    open.preset.id
                );
                restarted = true;
            } else {
                let method = match quirks.reopen {
                    Reopen::Resume => "session/resume",
                    Reopen::Load => "session/load",
                };
                let params = with_prompt(json!({ "sessionId": stored, "cwd": cwd, "mcpServers": servers }));
                match connection.request(method, params).await {
                    Ok(answer) => {
                        // A load replays the conversation, which the Mixdog session already holds.
                        if quirks.reopen == Reopen::Load
                            && let Some(replayed) = replayed
                        {
                            drop_replayed(&connection, replayed).await;
                        }
                        opened = Some((stored.clone(), answer));
                    }
                    // A sign-in that no longer holds is the agent's state: no session is opened in place of the stored one.
                    Err(Fault::Rpc(error)) if error.code != crate::agents::AUTH_REQUIRED => {
                        tracing::warn!("[acp] {} could not reopen its session: {}", open.preset.id, error.message);
                        restarted = true;
                        if let Some(replayed) = replayed {
                            drop_replayed(&connection, replayed).await;
                        }
                    }
                    Err(fault) => return Err(fault),
                }
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
        let connected = server.map(ToolServer::initialized);
        let session = Arc::new(Self {
            preset: open.preset.clone(),
            connection,
            host,
            gone,
            session_id,
            cwd: open.cwd,
            restarted,
            grants: open.grants,
            handed,
            prompt,
            images: capabilities.pointer("/agentCapabilities/promptCapabilities/image") == Some(&Value::Bool(true)),
            embedded: capabilities.pointer("/agentCapabilities/promptCapabilities/embeddedContext") == Some(&Value::Bool(true)),
            closes: offered(capabilities.pointer("/agentCapabilities/sessionCapabilities/close")),
            context: Mutex::default(),
            reports: std::sync::atomic::AtomicU64::new(0),
            unsent: Mutex::new(unsent),
            connected,
            told_unconnected: AtomicBool::new(false),
            models: Mutex::new(Models::of(&answer)),
            routing: Mutex::default(),
            kept: Mutex::default(),
            closed_prompt: tokio::sync::Notify::new(),
            cancels: watch::Sender::new(0),
            wake,
        });
        Ok((session, answer))
    }

    /// Fires once nothing more of the session arrives: its process ended, or it left the shared server.
    pub fn gone(&self) -> &CancellationToken {
        &self.gone
    }

    /// Ends the session's own process, or takes the session alone off the shared server it runs on, which goes on serving
    /// the others: nothing more of it arrives, and its tool server closes.
    pub fn end(&self) {
        match &self.host {
            Host::Own => self.connection.kill(),
            Host::Shared(shared) => shared.detach(self),
        }
    }

    /// Holds the shared server the session runs on open, as an open of a session on it does, while the lease is kept: a
    /// session ended to be opened again on it does not leave it serving none in between. `None` on a process of its own,
    /// or a server that takes no more sessions.
    pub(crate) fn hold_server(&self) -> Option<crate::shared::Lease> {
        match &self.host {
            Host::Own => None,
            Host::Shared(shared) => shared.lease(),
        }
    }

    /// What a turn of the session fails with once it is gone: the end of its process, or its leaving the shared server.
    pub fn closed(&self) -> Fault {
        if self.connection.exited().is_cancelled() {
            return self.connection.closed();
        }
        Fault::Rpc(RpcError { code: 0, message: "The agent's session was closed.".to_owned(), data: Value::Null })
    }

    /// Sends the turn's prompt `blocks`: the agent's answer to it arrives as [`Incoming::Response`] under the returned id,
    /// on a shared server to this session alone.
    pub async fn prompt(&self, blocks: Vec<Value>) -> Result<u64, Fault> {
        // A cancel told before this prompt reaches the agent ahead of it: the agent never reads it as this prompt's.
        let _ = self.cancels.subscribe().wait_for(|pending| *pending == 0).await;
        let id = self.connection.reserve();
        if let Host::Shared(shared) = &self.host {
            shared.owns_prompt(id, &self.session_id);
        }
        let sent = self.connection.send_as(id, "session/prompt", json!({ "sessionId": self.session_id, "prompt": blocks })).await;
        if let (Err(_), Host::Shared(shared)) = (&sent, &self.host) {
            shared.disown_prompt(id);
        }
        sent.map(|()| id)
    }

    /// Nothing more of the session arrives: a running turn sees its stream close, and so does every turn that attaches later.
    fn routing_ended(&self) {
        let mut routing = lock(&self.routing);
        routing.turn = None;
        routing.ended = true;
    }

    pub fn models(&self) -> Models {
        lock(&self.models).clone()
    }

    /// A session whose answer listed no models (a reopen's) runs those the agent listed last, `listed`: which one it is on
    /// is unknown until one is set.
    pub(crate) fn adopt_models(&self, listed: &Models) {
        let mut models = lock(&self.models);
        if models.available.is_empty() {
            *models = Models { current: None, ..listed.clone() };
        }
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
            routing.uncounted = 0;
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

    /// A `session/cancel` task for this session has not finished writing yet.
    pub(crate) fn has_pending_cancel(&self) -> bool {
        *self.cancels.borrow() > 0
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
        self.reports.fetch_add(std::mem::take(&mut routing.uncounted), Ordering::SeqCst);
        (std::mem::take(&mut routing.waiting), rx)
    }

    /// The turn ended; `background` are the tool calls it left running in the agent, by the agent's id of each. What
    /// the agent sent the turn after its last read is sorted here as if no turn had run, in the order it was sent
    /// and before anything newer.
    pub async fn detach(&self, mut stream: mpsc::UnboundedReceiver<Incoming>, background: impl IntoIterator<Item = (String, Background)>) {
        let (unread, end): (Vec<Routed>, bool) = {
            let mut routing = lock(&self.routing);
            routing.turn = None;
            routing.background.extend(background);
            let unread = std::iter::from_fn(|| stream.try_recv().ok()).map(|incoming| self.sort(&mut routing, incoming)).collect();
            (unread, std::mem::take(&mut routing.end_after_turn))
        };
        for routed in unread {
            self.act(routed).await;
        }
        // Ids carry their turn, so none of this turn's is issued again by a later one; a call left running keeps its
        // id, which the later turn that shows its result must not issue again.
        lock(&self.routing).turn_ended();
        if end {
            self.end();
        }
    }

    /// Leaves the session's end ([`Self::end`]) to the end of the turn that runs in it; `false` where none runs, which
    /// leaves it to the caller.
    pub(crate) fn end_after_turn(&self) -> bool {
        let mut routing = lock(&self.routing);
        routing.end_after_turn = routing.turn.is_some();
        routing.end_after_turn
    }

    /// An end left to the running turn's end is called off.
    pub(crate) fn keep_after_turn(&self) {
        lock(&self.routing).end_after_turn = false;
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
            routing.uncounted = 0;
            std::mem::take(&mut routing.waiting)
        };
        self.cancels.send_modify(|pending| *pending += 1);
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
            session.cancels.send_modify(|pending| *pending -= 1);
        }));
    }

    /// Waits until the agent closes the prompt a turn cancelled, or the session is gone: the events after which the
    /// agent takes a new prompt as a new turn (or the session is reopened).
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
                () = self.gone.cancelled() => return,
            }
        }
    }

    /// A row id for the agent's call `agent_id` made in `turn`: distinct from every id this session issued, and,
    /// carrying the turn, from every id of an earlier process of the agent, which counts its calls from the start again.
    pub fn call_id(&self, agent_id: &str, turn: &str, epoch: u64) -> String {
        lock(&self.routing).issue(agent_id, turn, epoch)
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

    /// The background task of the call of the Mixdog tool `name` with `arguments` that went on past the agent's deadline
    /// and that `running` finds still running: a call the agent makes again is that one. Those no longer running are
    /// forgotten.
    pub fn kept_call(&self, name: &str, arguments: &Value, running: impl Fn(&str) -> bool) -> Option<String> {
        let mut kept = lock(&self.kept);
        kept.retain(|(_, _, task)| running(task));
        kept.iter().find(|(tool, made_with, _)| tool == name && made_with == arguments).map(|(_, _, task)| task.clone())
    }

    /// The call of the Mixdog tool `name` with `arguments` goes on past the agent's deadline as the background task `task`.
    pub fn keep_call(&self, name: String, arguments: Value, task: String) {
        lock(&self.kept).push((name, arguments, task));
    }

    pub(crate) async fn act(&self, routed: Routed) {
        match routed {
            Routed::Done => {}
            Routed::Wake => (self.wake)(),
            Routed::Refuse(id) => self.connection.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } }))).await,
            Routed::RefuseTool(ask) => ask.refuse(NO_TURN),
        }
    }

    /// Asks the agent to close its session, where it advertises that it closes one ([`close_session`]).
    pub async fn close(&self) {
        if self.closes {
            close_session(&self.connection, &self.session_id).await;
        }
    }

    /// How many reports of its own context the agent has made in this session.
    pub fn context_reports(&self) -> u64 {
        self.reports.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The agent's last report of its own context; `None` until it made one.
    pub fn context_use(&self) -> Option<ContextUse> {
        *lock(&self.context)
    }

    pub(crate) fn take(&self, incoming: Incoming) -> Routed {
        // What the agent reports of its context, and of the model it is on, is the session's, whichever turn it arrives
        // in or between.
        let mut report = false;
        if let Incoming::Notification { params, .. } = &incoming {
            let update = &params["update"];
            match is_update(&incoming) {
                Some("usage_update") => {
                    if let Some(reported) = ContextUse::of(update) {
                        *lock(&self.context) = Some(reported);
                        report = true;
                    }
                }
                Some("config_option_update") => {
                    if let Some(options) = update.get("configOptions").and_then(Value::as_array) {
                        lock(&self.models).refresh(options);
                    }
                }
                _ => {}
            }
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
            Ok(()) => {
                if report {
                    self.reports.fetch_add(1, Ordering::SeqCst);
                }
                Routed::Done
            }
            // No turn, or one whose stream is already closed.
            Err(unsent) => {
                routing.turn = None;
                routing.uncounted += u64::from(report);
                self.sort(&mut routing, unsent)
            }
        }
    }

    /// What becomes of a message no turn reads.
    fn sort(&self, routing: &mut Routing, incoming: Incoming) -> Routed {
        if let Some(cancelled) = routing.unanswered {
            // A call an earlier turn left running goes on through the cancel: what the agent tells of it is sorted as it
            // is with no prompt open. The rest is the cancelled prompt's.
            let background = of_background(routing, &incoming);
            match incoming {
                Incoming::Response { id, .. } if id == cancelled => {
                    routing.unanswered = None;
                    self.closed_prompt.notify_waiters();
                    return Routed::Done;
                }
                Incoming::Request { id, .. } => return Routed::Refuse(id),
                Incoming::Tool(ask) => return Routed::RefuseTool(ask),
                _ if background => {}
                _ => return Routed::Done,
            }
        }
        // The agent's report of its context waits for the next turn, which tells it.
        let report = is_update(&incoming) == Some("usage_update");
        if routing.quiet || !self.preset.quirks.replies_without_prompt {
            return match incoming {
                Incoming::Request { id, .. } => Routed::Refuse(id),
                Incoming::Tool(ask) => Routed::RefuseTool(ask),
                _ if report => {
                    routing.waiting.push(incoming);
                    Routed::Done
                }
                _ => Routed::Done,
            };
        }
        // What the agent sends with no prompt open is kept, in order, for the turn that shows it. It asks for that
        // turn at the two events after which it has something whole to show: the end of a model step (its usage
        // report) and a permission request, which the agent waits on. A turn that starts first shows it instead.
        let shown = routing.waiting.iter().any(|kept| is_update(kept) != Some("usage_update"));
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
            (Some("usage_update"), _) => (true, shown),
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

/// Hands what a session's own process sends to the session, with the calls of its tool server, until the process ends.
async fn route(
    session: Arc<AgentSession>,
    mut incoming: mpsc::UnboundedReceiver<Incoming>,
    server: Option<Tools>,
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
            // A read of the session's own is answered from its folder in a task of its own: what the agent sends next does
            // not wait for the file.
            Incoming::Request { id, method, params } if method == "fs/read_text_file" => {
                if params.get("sessionId").and_then(Value::as_str) == Some(session.session_id.as_str()) {
                    let (connection, files, cwd) = (session.connection.clone(), files.clone(), session.cwd.clone());
                    drop(mixdog_rt::spawn("acp.read_file", mixdog_rt::TaskClass::Work, async move {
                        connection.respond(id, read_text_file(files.as_ref(), &cwd, &params).await).await;
                    }));
                } else {
                    session.connection.respond(id, unheld(&method)).await;
                }
                continue;
            }
            Incoming::Request { id, method, .. } if method != "session/request_permission" => {
                session.connection.respond(id, Err(not_offered(&method))).await;
                continue;
            }
            other => other,
        };
        let routed = session.take(message);
        session.act(routed).await;
    }
    // The process ended: a running turn sees its stream close, and so does every turn that attaches later.
    session.routing_ended();
    on_exit();
}

/// Hands a session on the shared server the calls of its own tool server, until it leaves the server or the server exits
/// (what the server sends of it, the server's own routing hands it). Its tool server then closes, and what waited for a
/// turn is answered.
async fn route_on_shared(session: Arc<AgentSession>, tools: Option<Tools>, on_exit: Box<dyn FnOnce() + Send>) {
    let (server, mut calls) = tools.unzip();
    loop {
        let ask = tokio::select! {
            () = session.gone.cancelled() => break,
            Some(ask) = async { calls.as_mut()?.recv().await } => ask,
        };
        let routed = session.take(Incoming::Tool(ask));
        session.act(routed).await;
    }
    drop(server);
    if let Some(mut calls) = calls {
        calls.close();
        while let Ok(ask) = calls.try_recv() {
            ask.refuse(LEFT);
        }
    }
    session.routing_ended();
    session.abandon_waiting(LEFT).await;
    on_exit();
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;

    #[test]
    fn a_turns_issued_ids_are_released_when_it_ends() {
        let mut routing = Routing::default();
        let first = routing.issue("call", "turn-1", 0);
        assert_ne!(routing.issue("call", "turn-1", 0), first, "within a turn no id repeats");
        routing.turn_ended();
        assert!(routing.issued.is_empty());
        assert_ne!(routing.issue("call", "turn-2", 0), first, "ids carry their turn");
    }

    struct Writes(Mutex<Vec<(AbsPath, String)>>, bool);

    #[async_trait]
    impl TextFiles for Writes {
        async fn read(&self, _path: AbsPath) -> Result<String, String> {
            Err("no reads".to_owned())
        }

        async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
            Ok(path)
        }

        async fn create(&self, path: AbsPath, text: String) -> Result<(), String> {
            self.0.lock().unwrap().push((path, text));
            if self.1 { Ok(()) } else { Err("read-only".to_owned()) }
        }
    }

    fn antigravity() -> AgentPreset {
        crate::preset::builtin().into_iter().find(|preset| preset.id == "antigravity-cli").expect("the preset")
    }

    fn agent_file(preset: &AgentPreset) -> &AgentFile {
        match &preset.own_tools_off {
            Some(OwnToolsOff::AgentFile(off)) => off,
            other => panic!("the CLI is started with a definition: {other:?}"),
        }
    }

    fn here() -> AbsPath {
        AbsPath::new(std::env::temp_dir().join("work")).expect("absolute")
    }

    fn definitions() -> std::path::PathBuf {
        std::env::temp_dir().join("data").join("acp-agents")
    }

    #[tokio::test]
    async fn a_handed_session_starts_the_cli_with_the_agent_that_has_none_of_its_own_tools() {
        let preset = antigravity();
        let files = Writes(Mutex::default(), true);
        let off = agent_file(&preset);
        let tools = ["read".to_owned(), "grep".to_owned()];
        let home = own_tools_off_home(&files, &definitions(), &preset.id, off, &tools).await.expect("the home");
        let started = launch_without_own_tools(&preset, &Program::at("agy"), here(), Some((home.clone(), off)));
        assert_eq!(started.args, ["acp", "--disable-telemetry", "--agent", "mixdog", "--dangerously-skip-permissions"]);
        assert_eq!(started.cwd, home);
        let written = files.0.lock().unwrap().clone();
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].0.as_path(), home.as_path().join(".agents/agents/mixdog/agent.md"));
        let declared = "\ntools: []\nmcpServers:\n  - name: mixdog\n    tools:\n      \"read\":\n        eager: true\n      \"grep\":\n        eager: true\n";
        assert!(written[0].1.contains("name: mixdog\n") && written[0].1.contains(declared), "{}", written[0].1);
        // A session handed other tools starts from a folder of its own; one handed the same shares it.
        assert!(home.as_path().starts_with(definitions()), "{home:?}");
        assert_ne!(own_tools_off_home(&files, &definitions(), &preset.id, off, &tools[..1]).await.expect("the home"), home);
        assert_eq!(own_tools_off_home(&files, &definitions(), &preset.id, off, &tools).await.expect("the home"), home);
    }

    #[tokio::test]
    async fn a_definition_that_cannot_be_written_fails_the_open_and_a_session_without_one_keeps_the_clis_own_tools() {
        let preset = antigravity();
        let off = agent_file(&preset);
        let failed = own_tools_off_home(&Writes(Mutex::default(), false), &definitions(), &preset.id, off, &["read".to_owned()]).await;
        assert!(matches!(failed, Err(Fault::Start(ref why)) if why.contains("read-only")), "{failed:?}");
        let started = launch_without_own_tools(&preset, &Program::at("agy"), here(), None);
        assert_eq!(started.args, ["acp", "--disable-telemetry"]);
        assert_eq!(started.cwd, here());
    }

    /// A program found with arguments and variables of its own (an installed build's, its home) starts with them and
    /// the preset's.
    #[test]
    fn a_program_starts_with_its_own_arguments_and_environment_beside_the_presets() {
        let official = crate::preset::builtin().into_iter().find(|preset| preset.id == "antigravity").expect("the preset");
        let program = Program { path: "server".into(), args: vec!["--uid=".into()], env: vec![("GEMINI_HOME".into(), "home".into())] };
        let started = launch(&official, &program, here());
        assert_eq!((started.program.as_str(), started.args.as_slice()), ("server", ["--uid=".to_owned()].as_slice()));
        assert_eq!(started.env, [("AGY_ACP_FORCE_FILE_STORAGE".to_owned(), "1".to_owned()), ("GEMINI_HOME".to_owned(), "home".to_owned())]);
    }

    #[test]
    fn settings_under_one_object_are_merged_into_it() {
        let mut meta = Value::Null;
        merge(&mut meta, json!({ "a": { "prompt": { "append": "R" } } }));
        merge(&mut meta, json!({ "a": { "tools": [1] } }));
        assert_eq!(meta, json!({ "a": { "prompt": { "append": "R" }, "tools": [1] } }));
    }
}
